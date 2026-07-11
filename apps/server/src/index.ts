// Boot: migrate → boot-recovery (inside startServer) → seed+probe MCP registry →
// HTTP + WS on PC_PORT (PC-SDK Next default 5124), serving apps/web/dist when built
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
import { reconcileStrandedWorktreesAtBoot } from './boot-recovery.ts';
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
      // Ask UI isn't built yet — never block a session on a permission prompt.
      // Revisit when the ask flow lands; the plumbing (ctx.ask) stays wired.
      bypassPermissions: true,
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
  // Recovery order (docs/worktree-lifecycle.md 'Recovery' — locked):
  // 1. sealed-run recovery — non-terminal runs with a sealed deliverable
  //    (skipped by the boot sweep inside startServer) settle completed and
  //    re-verify/land from durable evidence; shares the per-repo landing lock
  //    with step 2;
  // 2. pending-landing re-drive (idempotent — ancestry probe first, full
  //    guard stack incl. base advancement when not yet merged);
  // 3. teardown resume — landed contracts whose worktree survived the crash;
  // 4. stranded scan — must see 1-3's FINAL state (a landed worktree awaiting
  //    teardown must never classify stranded; re-driven landings finish
  //    tearing down first);
  // 5. attach — only now can a dispatch start. A dispatch mid-flight during
  //    the scan has an async window between its worktree row (active) and its
  //    run row (live) that the scan would misclassify 'no-live-run' — until
  //    attach, dispatch verbs refuse 503 'server still booting'; chat itself
  //    is unaffected.
  await dispatch
    .recoverSealedRuns()
    .catch((err) => console.warn('[pc-sdk][dispatch] sealed-run recovery failed:', err));
  await dispatch
    .recoverPendingLandings()
    .catch((err) => console.warn('[pc-sdk][dispatch] pending-landing re-drive failed:', err));
  await dispatch
    .recoverIncompleteTeardowns()
    .catch((err) => console.warn('[pc-sdk][dispatch] teardown resume failed:', err));
  await reconcileStrandedWorktreesAtBoot();
  dispatch.attach({ registry: server.registry, hub: server.hub, serverPort: server.port });
  // 6. review re-entry — AFTER attach (a review dispatch needs the live
  //    context): full-review contracts whose reviewer died (or was never
  //    dispatched pre-attach) re-enter the review gate re-dispatchable.
  await dispatch
    .recoverPendingReviews()
    .catch((err) => console.warn('[pc-sdk][dispatch] review re-entry failed:', err));
  // 7. auto-continue re-entry — AFTER attach, same reason as review re-entry:
  //    a run that settled 'failed'/'turn-budget-exhausted' but never got its
  //    auto-continuation fired (crash in that window) resumes here.
  await dispatch
    .recoverPendingAutoContinues()
    .catch((err) => console.warn('[pc-sdk][dispatch] auto-continue re-entry failed:', err));
  // 8. paused-ask revival (F1, comms-hardening) — AFTER attach, same reason:
  //    re-mints a live session for every run the boot sweep left 'paused'
  //    (its ask survives with it) so answering it doesn't 410 on a dead
  //    in-process handle.
  await dispatch
    .recoverPausedAsks()
    .catch((err) => console.warn('[pc-sdk][dispatch] paused-ask revival failed:', err));

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

/** Respawn stdio: append to the launcher's log directory so a failed respawn
 *  leaves evidence. PC_LOG_DIR lets side-by-side instances stay isolated; the
 *  working PC-SDK location remains the compatibility default. */
function respawnStdio(): StdioOptions {
  try {
    const base = process.env.LOCALAPPDATA;
    const configured = process.env.PC_LOG_DIR?.trim();
    if (!configured && !base) return 'ignore';
    const dir = configured || join(base!, 'PC-SDK', 'logs');
    mkdirSync(dir, { recursive: true });
    return ['ignore', openSync(join(dir, 'server.log'), 'a'), openSync(join(dir, 'server.err.log'), 'a')];
  } catch {
    return 'ignore';
  }
}

void main();
