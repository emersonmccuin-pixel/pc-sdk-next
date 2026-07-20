// Boot: data-dir admission → migrate → boot-recovery (inside startServer) → HTTP + WS listen →
// required dispatch/MCP bootstrap → recovered chat-queue drain. apps/web/dist
// is served when built (tolerated absent in dev).
//
// This is the COMPOSITION ROOT — the only place (with the runtime registry)
// that selects a concrete agent-runtime adapter. The account switcher resolves
// each project's login, the MCP manager bridges healthy remote tools, and the
// subscription-quota service turns runtime observations into durable snapshots. All of it
// hangs off the canonical `RuntimeSession` seam — `claude-adapter.ts` is the
// only SDK importer.

import { spawn, type StdioOptions } from 'node:child_process';
import { mkdirSync, openSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  bindProjectRepositoryIdentity,
  closeDb,
  getAgentByName,
  getProjectById,
  runMigrations,
} from '@pc/db';
import {
  OlderSubscriptionQuotaObservationError,
  SubscriptionQuotaService,
} from '@pc/app-services';
import type { SubscriptionQuotaObservationBatch } from '@pc/contracts';
import type { ULID } from '@pc/domain';
import { getDataDir } from '@pc/utils';
import {
  RuntimeRegistry,
  type MintRuntimeSession,
  type RuntimeSession,
} from './runner/runtime.ts';
import { AccountRegistry, type Account } from './runner/account-env.ts';
import { CLAUDE_RUNTIME_ID, ClaudeRuntimeAdapter } from './runner/claude-adapter.ts';
import { seedStockAgents } from './agents/seed.ts';
import { DispatchService, type DispatchServiceDeps } from './dispatch/service.ts';
import { buildPcToolDefs, mergePcTools, ORCHESTRATOR_PC_TOOLS } from './dispatch/pc-bridge.ts';
import {
  RepositoryLeaseError,
  repositoryLeaseManager,
} from './dispatch/repository-lease.ts';
import { McpManager } from './mcp/manager.ts';
import { SubscriptionQuotaPoller } from './subscription-quota/poller.ts';
import { runPreAttachRepositoryRecovery } from './boot-recovery.ts';
import { startServer, type RunningServer } from './server.ts';
import {
  acquireDataDirectoryAdmission,
  DATA_DIRECTORY_OCCUPIED_EXIT_CODE,
  DATA_DIRECTORY_UNAVAILABLE_EXIT_CODE,
  DataDirectoryAdmissionError,
  type DataDirectoryAdmission,
} from './operations/data-dir-admission.ts';

/** Current composition policy for a specialist that has no explicit model.
 *  Concrete provider vocabulary is intentionally confined to this root. */
const DEFAULT_CLAUDE_SPECIALIST_MODEL = 'sonnet';
const RESTART_ADMISSION_WAIT_ENV = 'PC_DATA_ADMISSION_RESTART_WAIT';
const RESTART_ADMISSION_WAIT_MS = 15_000;
/** apps/server/src → apps/web/dist, resolved from this module's own location
 *  so boot never depends on the process's current working directory. */
const WEB_DIST_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'web', 'dist');

let dataDirectoryAdmission: DataDirectoryAdmission | null = null;
let activeDispatch: DispatchService | null = null;
let activeServer: RunningServer | null = null;
let subscriptionQuotaPoller: SubscriptionQuotaPoller | null = null;
let engineStopPromise: Promise<void> | null = null;
let terminationMode: 'shutdown' | 'restart' | null = null;

async function main(): Promise<void> {
  dataDirectoryAdmission = await acquireDataDirectoryAdmission(getDataDir(), {
    waitForOccupiedMs: process.env[RESTART_ADMISSION_WAIT_ENV] === '1'
      ? RESTART_ADMISSION_WAIT_MS
      : 0,
  });
  delete process.env[RESTART_ADMISSION_WAIT_ENV];
  // Make every later lazy data-path lookup use the exact identity that won
  // admission, including when PC_DATA_DIR was relative or passed through an
  // alias/junction.
  process.env.PC_DATA_DIR = dataDirectoryAdmission.dataDir;
  runMigrations();

  const seeded = seedStockAgents();
  console.log(
    `[pc-sdk][agents] seed: ${seeded.inserted} inserted, ${seeded.reseeded} reseeded, ${seeded.unchanged} unchanged`,
  );

  const accounts = new AccountRegistry();
  const subscriptionQuota = new SubscriptionQuotaService();
  const mcp = new McpManager();

  // The chat runs under the orchestrator agent row (seeded above, editable in
  // the Agents tab). Read fresh per mint — SessionService re-mints on rev change
  // so edits apply on the next message. Adapters never touch the DB.
  const orchestratorRow = () => getAgentByName({ name: 'orchestrator', scope: 'global' });

  const runtimes = new RuntimeRegistry();
  runtimes.register(new ClaudeRuntimeAdapter({ accounts }));
  const recordSubscriptionQuota = (batch: SubscriptionQuotaObservationBatch): void => {
    try {
      subscriptionQuota.record(batch);
    } catch (error) {
      if (error instanceof OlderSubscriptionQuotaObservationError) return;
      const code = error instanceof Error ? error.name : 'record-failed';
      console.warn(`[pc-sdk][subscription-quota] observation was not recorded: ${code}`);
    }
  };

  const resolveNewSessionSelection = async (
    input: { projectId: ULID; accountId?: string },
  ) => {
    const orchestrator = orchestratorRow();
    const model = orchestrator?.model?.trim();
    if (!model) return { status: 'invalid' as const, code: 'selection-unavailable' as const };
    let account: Account | null;
    try {
      account = input.accountId
        ? accounts.get(CLAUDE_RUNTIME_ID, input.accountId)
        : accounts.resolveForProject(input.projectId, CLAUDE_RUNTIME_ID);
    } catch {
      return { status: 'invalid' as const, code: 'account-unavailable' as const };
    }
    if (!account) return { status: 'invalid' as const, code: 'account-unavailable' as const };
    return runtimes.resolveSelection({
      runtimeId: CLAUDE_RUNTIME_ID,
      accountId: account.id,
      model,
      effort: orchestrator?.effort ?? null,
    });
  };

  const resolveNewSpecialistSelection: DispatchServiceDeps['resolveNewSpecialistSelection'] =
    async (input) => {
      let account: Account;
      try {
        account = accounts.resolveForProject(input.projectId, CLAUDE_RUNTIME_ID);
      } catch {
        return { status: 'invalid', code: 'account-unavailable' };
      }
      return runtimes.resolveSelection({
        runtimeId: CLAUDE_RUNTIME_ID,
        accountId: account.id,
        model: input.model?.trim() || DEFAULT_CLAUDE_SPECIALIST_MODEL,
        effort: input.effort,
      });
    };
  const dispatch = new DispatchService({
    resolveNewSpecialistSelection,
    preflightRuntimeSession: (selection, continuation) =>
      runtimes.preflight(selection, continuation),
    mintSpecialistRuntimeSession: async (input) => {
      const { continuation, ...sessionInput } = input;
      const adapter = runtimes.get(sessionInput.selection.runtimeId);
      return continuation.mode === 'resume'
        ? adapter.resumeSession({ ...sessionInput, nativeSessionId: continuation.nativeSessionId })
        : adapter.createSession(sessionInput);
    },
    onSubscriptionQuota: recordSubscriptionQuota,
  });
  activeDispatch = dispatch;
  // The server's live port — set after listen and before any recovered chat
  // work is explicitly released by the composition root.
  const portRef = { port: 0 };

  // Mint one runtime session per app session: resolve the project's account,
  // stamp the runtime selection, bridge the currently-healthy MCP tools + the
  // pc_* dispatch tools, run in the project folder. Adapter selection happens
  // HERE and nowhere else.
  const mintSession = async (ctx: MintRuntimeSession): Promise<RuntimeSession> => {
    const project = getProjectById(ctx.projectId as ULID);
    const orchestrator = orchestratorRow();
    const adapter = runtimes.get(ctx.selection.runtimeId);
    let cwd = ctx.cwd ?? project?.folderPath ?? undefined;
    // The current native runtime is not a read-only sandbox: bypass mode can
    // invoke repository-writing built-ins even though the orchestrator charter
    // is read-only. Treat any Git-backed cwd as write-capable and acquire the
    // same engine-lifetime authority before native create/resume.
    if (ctx.continuation.mode === 'resume' && !project?.repositoryIdentity) {
      throw new RepositoryLeaseError(
        'repository-unavailable',
        cwd ?? '<missing-project-cwd>',
        null,
        null,
        'MISSING_PROJECT_REPOSITORY_IDENTITY',
      );
    }
    if (cwd) {
      const repositoryLease = await repositoryLeaseManager.acquireForRuntimeCwd(
        cwd,
        project?.repositoryIdentity ?? null,
      );
      if (project && !bindProjectRepositoryIdentity(project.id, repositoryLease.identity)) {
        throw new RepositoryLeaseError(
          'repository-unavailable',
          cwd,
          repositoryLease.identity,
          repositoryLease.lockPath,
          'PROJECT_UNAVAILABLE_DURING_REPOSITORY_BIND',
        );
      }
      cwd = await repositoryLeaseManager.resolveHeldRuntimeCwd(
        repositoryLease,
        cwd,
        repositoryLease.identity,
      );
    }
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
      continuationAttemptId: ctx.continuationAttemptId,
      selection: ctx.selection,
      instructions: orchestrator?.prompt || undefined,
      cwd,
      tools,
      maxTurns: orchestrator?.maxTurns ?? undefined,
      ask: ctx.ask,
      // Tool prompting policy remains disabled for the current product slice.
      // The adapter still maps approval lifecycles when prompting is enabled.
      // Enabling prompts is a separate product/security-policy decision; the
      // plumbing stays wired without silently changing daily-driver behavior.
      bypassPermissions: true,
    };
    return ctx.continuation.mode === 'resume'
      ? adapter.resumeSession({ ...input, nativeSessionId: ctx.continuation.nativeSessionId })
      : adapter.createSession(input);
  };

  const server = await startServer({
    mintSession,
    resolveNewSessionSelection,
    preflightRuntimeSession: (selection, continuation) =>
      runtimes.preflight(selection, continuation),
    accounts,
    orchestratorRuntimeId: CLAUDE_RUNTIME_ID,
    subscriptionQuota,
    dispatch,
    onSubscriptionQuota: recordSubscriptionQuota,
    orchestratorRev: () => orchestratorRow()?.rev ?? null,
    webDist: WEB_DIST_DIR,
    version: '0.0.0',
    deferConversationQueueDrain: true,
    // Settings → Restart engine: one lifecycle door closes new HTTP/WS work,
    // attempts every tracked runtime disposal, closes the product DB, then
    // spawns this exact process behind a positive-admission retry. The kernel
    // witness remains held until this process actually exits. execArgv MUST be
    // carried —
    // tsx injects its TS loader there, not in argv; without it the child is
    // plain `node src/index.ts` and dies instantly (2026-07-10 live finding).
    // Child stdio appends to the launcher's log files so a failed respawn is
    // never invisible.
    onRestartRequest: () => requestTermination('restart'),
  });
  activeServer = server;
  portRef.port = server.port;
  // Probe MCP after listen so startup remains observable, but gate recovered
  // chat work on the completed attempt. Failure degrades to an empty/failed
  // bridge explicitly; it must not let recovery mint a half-initialized
  // runtime session.
  const mcpReady = mcp
    .initFromBoot()
    .then(() => console.log(`[pc-sdk][mcp] ${mcp.statuses().length} server(s) probed`))
    .catch((err) => console.warn('[pc-sdk][mcp] init failed:', err instanceof Error ? err.message : err));
  // Recovery order (docs/worktree-lifecycle.md 'Recovery' — locked):
  // 1. sealed-run recovery — non-terminal runs with a sealed deliverable
  //    (skipped by the boot sweep inside startServer) settle completed and
  //    re-verify/land from durable evidence; shares the per-repo landing lock
  //    with step 2;
  // 2. pending-landing re-drive (idempotent — ancestry probe first, full
  //    guard stack incl. base advancement when not yet merged);
  // 3. approved-abandonment re-drive — authority is durable before removal;
  // 4. teardown resume — landed contracts whose worktree survived the crash;
  // 5. independent-review workspace re-drive — retire every old-process
  //    reservation/checkout before any successor reviewer may be admitted;
  // 6. stranded scan — must see 1-5's FINAL state (a landed worktree awaiting
  //    teardown must never classify stranded; re-driven landings finish
  //    tearing down first);
  // 7. attach — only now can a dispatch start. A dispatch mid-flight during
  //    the scan has an async window between its worktree row (active) and its
  //    run row (live) that the scan would misclassify 'no-live-run' — until
  //    attach, dispatch verbs refuse 503 'server still booting'; chat itself
  //    is unaffected.
  await runPreAttachRepositoryRecovery(dispatch);
  dispatch.attach({
    registry: server.registry,
    hub: server.hub,
    conversationRelay: server.conversationRelay,
    serverPort: server.port,
  });
  // 8. review re-entry — AFTER attach (a review dispatch needs the live
  //    context): full-review contracts whose reviewer died (or was never
  //    dispatched pre-attach) re-enter the review gate re-dispatchable.
  await dispatch
    .recoverPendingReviews()
    .catch((err) => console.warn('[pc-sdk][dispatch] review re-entry failed:', err));
  // 9. auto-continue re-entry — AFTER attach, same reason as review re-entry:
  //    a run that settled 'failed'/'turn-budget-exhausted' but never got its
  //    auto-continuation fired (crash in that window) resumes here.
  await dispatch
    .recoverPendingAutoContinues()
    .catch((err) => console.warn('[pc-sdk][dispatch] auto-continue re-entry failed:', err));
  // 10. paused-ask revival (F1, comms-hardening) — AFTER attach, same reason:
  //    re-mints a live session for every run the boot sweep left 'paused'
  //    (its ask survives with it) so answering it doesn't 410 on a dead
  //    in-process handle.
  await dispatch
    .recoverPausedAsks()
    .catch((err) => console.warn('[pc-sdk][dispatch] paused-ask revival failed:', err));

  // 11. recovered conversation queue — only after the live port, dispatch
  // routes, paused-run sessions, and MCP initialization attempt are ready.
  // Queued rows need no browser connection, but they do need the same fully
  // composed runtime package as a newly submitted turn.
  await mcpReady;
  server.registry.kickRecoveredQueues();

  console.log(`[pc-sdk] server listening on ${server.url} (ws: ${server.url}/ws?projectId=…)`);

  // Active quota supply — boot poll + bounded interval per runtime account.
  subscriptionQuotaPoller = new SubscriptionQuotaPoller({
    accounts: accounts.list(),
    runtimes,
    service: subscriptionQuota,
  });
  subscriptionQuotaPoller.start();

  process.once('SIGINT', () => requestTermination('shutdown'));
  process.once('SIGTERM', () => requestTermination('shutdown'));
}

function requestTermination(mode: 'shutdown' | 'restart'): void {
  if (terminationMode !== null) return;
  terminationMode = mode;
  console.warn(
    mode === 'restart'
      ? '[pc-sdk] restart requested — quiescing engine before replacement.'
      : '[pc-sdk] shutdown requested — quiescing engine.',
  );
  void stopEngine().then(
    () => {
      if (mode === 'restart') {
        try {
          spawn(process.execPath, [...process.execArgv, ...process.argv.slice(1)], {
            cwd: process.cwd(),
            env: { ...process.env, [RESTART_ADMISSION_WAIT_ENV]: '1' },
            detached: true,
            stdio: respawnStdio(),
            windowsHide: true,
          }).unref();
        } catch (error) {
          console.error('[pc-sdk] replacement spawn failed after clean shutdown:', fatalText(error));
          process.exit(1);
        }
      }
      process.exit(0);
    },
    (error) => {
      console.error(
        `[pc-sdk] ${mode} refused because a tracked shutdown operation failed:`,
        fatalText(error),
      );
      // Do not spawn a replacement. Process exit lets the OS close any handle
      // whose explicit close was inconclusive; no success is inferred from it.
      process.exit(1);
    },
  );
}

function stopEngine(): Promise<void> {
  if (engineStopPromise) return engineStopPromise;
  engineStopPromise = (async () => {
    subscriptionQuotaPoller?.stop();

    const shutdownOperations: Promise<void>[] = [];
    // RunningServer.close() synchronously gates HTTP/upgrade admission before
    // its returned promise begins draining orchestrator sessions. Invoke that
    // door before starting the specialist drain.
    if (activeServer) {
      shutdownOperations.push(activeServer.close());
    }
    if (activeDispatch) shutdownOperations.push(activeDispatch.disposeAll());
    const shutdownResults = await Promise.allSettled(shutdownOperations);
    const shutdownFailures = shutdownResults
      .filter((result): result is PromiseRejectedResult => result.status === 'rejected')
      .map((result) => result.reason);
    if (shutdownFailures.length > 0) {
      throw new AggregateError(
        shutdownFailures,
        'one or more tracked engine shutdown operations failed',
      );
    }

    // Close known product-state resources, but deliberately retain the kernel
    // admission witness until actual process exit. The replacement's bounded
    // retry can proceed only after the OS positively releases that witness, so
    // incomplete in-process bookkeeping can never authorize overlap.
    closeDb();
    subscriptionQuotaPoller = null;
  })();
  return engineStopPromise;
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

function fatalText(error: unknown): string {
  return error instanceof Error ? error.stack ?? error.message : String(error);
}

void main().catch(async (error: unknown) => {
  let cleanupFailure: unknown = null;
  try {
    await stopEngine();
  } catch (cleanupError) {
    cleanupFailure = cleanupError;
  }

  if (error instanceof DataDirectoryAdmissionError) {
    console.error(`[pc-sdk][data-dir-admission] ${JSON.stringify({
      status: 'rejected',
      code: error.code,
      dataDir: error.dataDir,
      lockPath: error.lockPath,
      reasonCode: error.reasonCode,
    })}`);
    if (cleanupFailure) {
      console.error('[pc-sdk] admission-failure cleanup was inconclusive:', fatalText(cleanupFailure));
    }
    process.exit(
      error.code === 'data-directory-occupied'
        ? DATA_DIRECTORY_OCCUPIED_EXIT_CODE
        : DATA_DIRECTORY_UNAVAILABLE_EXIT_CODE,
    );
  }

  console.error('[pc-sdk] fatal startup failure:', fatalText(error));
  if (cleanupFailure) {
    console.error('[pc-sdk] startup-failure cleanup was inconclusive:', fatalText(cleanupFailure));
  }
  process.exit(1);
});
