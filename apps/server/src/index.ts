// Boot: migrate → boot-recovery (inside startServer) → seed+probe MCP registry →
// HTTP + WS on PC_PORT (default 5123), serving apps/web/dist when built
// (tolerated absent in dev).
//
// The real SDK backend is wired here: the account switcher resolves each
// project's login, the MCP manager bridges healthy remote tools, and the usage
// cache turns rate-limit events into durable quota snapshots. All of it hangs
// off the `RunnerBackend` seam — `SdkBackend` is the only SDK importer.

import { join } from 'node:path';
import { getProjectById, runMigrations } from '@pc/db';
import type { ULID } from '@pc/domain';
import type { BackendContext, RunnerBackend } from './runner/backend.ts';
import { AccountRegistry } from './runner/account-env.ts';
import { SdkBackend } from './runner/sdk-backend.ts';
import { McpManager } from './mcp/manager.ts';
import { UsageCache } from './usage/cache.ts';
import { UsagePoller } from './usage/poller.ts';
import { startServer } from './server.ts';

async function main(): Promise<void> {
  runMigrations();

  const accounts = new AccountRegistry();
  const usage = new UsageCache();
  const hydrated = usage.hydrateFromDb();
  if (hydrated > 0) console.log(`[pc-sdk][usage] hydrated ${hydrated} account snapshot(s) from db`);
  const mcp = new McpManager();

  // Mint one SdkBackend per session: resolve the project's account (env +
  // CLAUDE_CONFIG_DIR), bridge the currently-healthy MCP tools, run in the
  // project folder.
  const backendFactory = (ctx: BackendContext): RunnerBackend => {
    const account = accounts.resolveForProject(ctx.projectId as ULID);
    const project = getProjectById(ctx.projectId as ULID);
    return new SdkBackend({
      env: accounts.buildEnv(account.id),
      accountId: account.id,
      cwd: project?.folderPath || undefined,
      bridge: mcp.buildBridge(),
    });
  };

  const server = await startServer({
    backendFactory,
    accounts,
    usage,
    onRateLimit: (snapshot) => usage.record(snapshot),
    webDist: join(process.cwd(), '..', 'web', 'dist'),
    version: '0.0.0',
  });

  console.log(`[pc-sdk] server listening on ${server.url} (ws: ${server.url}/ws?projectId=…)`);

  // Active quota supply — boot poll + interval per account (degrade-never-block).
  const usagePoller = new UsagePoller({ accounts: accounts.list(), cache: usage });
  usagePoller.start();

  // Seed + probe MCP registry in the background — degrade-never-block: a slow or
  // down server must not delay the server coming up. Bridges appear as probes
  // land; sessions started before then simply have no MCP tools yet.
  void mcp
    .initFromBoot()
    .then(() => console.log(`[pc-sdk][mcp] ${mcp.statuses().length} server(s) probed`))
    .catch((err) => console.warn('[pc-sdk][mcp] init failed:', err instanceof Error ? err.message : err));

  const shutdown = (): void => {
    usagePoller.stop();
    void server.close().then(() => process.exit(0));
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

void main();
