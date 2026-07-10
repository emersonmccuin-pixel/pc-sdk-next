// Boot: migrate → boot-recovery (inside startServer) → seed+probe MCP registry →
// HTTP + WS on PC_PORT (default 5123), serving apps/web/dist when built
// (tolerated absent in dev).
//
// This is the COMPOSITION ROOT — the only place (with the runtime registry)
// that selects a concrete agent-runtime adapter. The account switcher resolves
// each project's login, the MCP manager bridges healthy remote tools, and the
// usage cache turns rate-limit events into durable quota snapshots. All of it
// hangs off the canonical `RuntimeSession` seam — `claude-adapter.ts` is the
// only SDK importer.

import { spawn, type StdioOptions } from 'node:child_process';
import { mkdirSync, openSync } from 'node:fs';
import { join } from 'node:path';
import { getAgentByName, getProjectById, runMigrations } from '@pc/db';
import type { ULID } from '@pc/domain';
import {
  RuntimeRegistry,
  type MintRuntimeSession,
  type RuntimeSession,
  type RuntimeSelection,
} from './runner/runtime.ts';
import { AccountRegistry } from './runner/account-env.ts';
import { CLAUDE_RUNTIME_ID, ClaudeRuntimeAdapter } from './runner/claude-adapter.ts';
import { seedStockAgents } from './agents/seed.ts';
import { DispatchService } from './dispatch/service.ts';
import { buildPcToolDefs, mergePcTools, ORCHESTRATOR_PC_TOOLS } from './dispatch/pc-bridge.ts';
import { McpManager } from './mcp/manager.ts';
import { UsageCache } from './usage/cache.ts';
import { UsagePoller } from './usage/poller.ts';
import { startServer } from './server.ts';

async function main(): Promise<void> {
  runMigrations();

  const seeded = seedStockAgents();
  console.log(
    `[pc-sdk][agents] seed: ${seeded.inserted} inserted, ${seeded.reseeded} reseeded, ${seeded.unchanged} unchanged`,
  );

  const accounts = new AccountRegistry();
  const usage = new UsageCache();
  const hydrated = usage.hydrateFromDb();
  if (hydrated > 0) console.log(`[pc-sdk][usage] hydrated ${hydrated} account snapshot(s) from db`);
  const mcp = new McpManager();

  // The chat runs under the orchestrator agent row (seeded above, editable in
  // the Agents tab). Read fresh per mint — SessionService re-mints on rev change
  // so edits apply on the next message. Adapters never touch the DB.
  const orchestratorRow = () => getAgentByName({ name: 'orchestrator', scope: 'global' });

  const runtimes = new RuntimeRegistry();
  runtimes.register(new ClaudeRuntimeAdapter({ accounts }));

  const dispatch = new DispatchService({ runtimes, accounts, mcp });
  // The server's live port — set after listen; sessions mint on first message,
  // which is always after listen.
  const portRef = { port: 0 };

  // Mint one runtime session per app session: resolve the project's account,
  // stamp the runtime selection, bridge the currently-healthy MCP tools + the
  // pc_* dispatch tools, run in the project folder. Adapter selection happens
  // HERE and nowhere else.
  const mintSession = async (ctx: MintRuntimeSession): Promise<RuntimeSession> => {
    const account = accounts.resolveForProject(ctx.projectId as ULID);
    const project = getProjectById(ctx.projectId as ULID);
    const orchestrator = orchestratorRow();
    const selection: RuntimeSelection = {
      runtimeId: CLAUDE_RUNTIME_ID,
      accountId: account.id,
      model: orchestrator?.model ?? 'opus',
    };
    const adapter = runtimes.get(selection.runtimeId);
    const tools =
      portRef.port > 0
        ? mergePcTools(
            mcp.buildBridge(),
            buildPcToolDefs(ORCHESTRATOR_PC_TOOLS, {
              projectId: ctx.projectId,
              dispatcherSessionId: ctx.appSessionId,
              serverPort: portRef.port,
            }),
          )
        : mcp.buildBridge();
    const input = {
      appSessionId: ctx.appSessionId,
      projectId: ctx.projectId,
      selection,
      instructions: orchestrator?.prompt || undefined,
      cwd: ctx.cwd ?? (project?.folderPath || undefined),
      tools,
      maxTurns: orchestrator?.maxTurns ?? undefined,
      ask: ctx.ask,
    };
    return ctx.resumeNativeSessionId
      ? adapter.resumeSession({ ...input, nativeSessionId: ctx.resumeNativeSessionId })
      : adapter.createSession(input);
  };

  const server = await startServer({
    mintSession,
    accounts,
    usage,
    dispatch,
    onRateLimit: (snapshot) => usage.record(snapshot),
    orchestratorRev: () => orchestratorRow()?.rev ?? null,
    webDist: join(process.cwd(), '..', 'web', 'dist'),
    version: '0.0.0',
    // Settings → Restart engine: close the listener (releases the port), then
    // respawn this exact process detached, and exit. execArgv MUST be carried —
    // tsx injects its TS loader there, not in argv; without it the child is
    // plain `node src/index.ts` and dies instantly (2026-07-10 live finding).
    // Child stdio appends to the launcher's log files so a failed respawn is
    // never invisible.
    onRestartRequest: () => {
      console.warn('[pc-sdk] restart requested — closing, respawning, exiting.');
      void (async () => {
        usagePoller.stop();
        await dispatch.disposeAll().catch(() => {});
        await server.close().catch(() => {});
        spawn(process.execPath, [...process.execArgv, ...process.argv.slice(1)], {
          cwd: process.cwd(),
          env: process.env,
          detached: true,
          stdio: respawnStdio(),
          windowsHide: true,
        }).unref();
        process.exit(0);
      })();
    },
  });
  portRef.port = server.port;
  dispatch.attach({ registry: server.registry, hub: server.hub, serverPort: server.port });
  // Re-drive landings interrupted mid-flight (idempotent; degrade-never-block).
  void dispatch.recoverPendingLandings().catch((err) =>
    console.warn('[pc-sdk][dispatch] pending-landing re-drive failed:', err),
  );

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

/** Respawn stdio: append to the launcher's log files (%LOCALAPPDATA%\PC-SDK\logs)
 *  so a failed respawn leaves evidence; fall back to ignore if that fails. */
function respawnStdio(): StdioOptions {
  try {
    const base = process.env.LOCALAPPDATA;
    if (!base) return 'ignore';
    const dir = join(base, 'PC-SDK', 'logs');
    mkdirSync(dir, { recursive: true });
    return ['ignore', openSync(join(dir, 'server.log'), 'a'), openSync(join(dir, 'server.err.log'), 'a')];
  } catch {
    return 'ignore';
  }
}

void main();
