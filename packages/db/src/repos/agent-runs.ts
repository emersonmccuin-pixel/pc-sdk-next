// Section 25 — agent_runs repo.
//
// Persists the FULL state machine (queued | spawning | running | paused |
// completed | failed | cancelled). Restart-time reconciliation is a SELECT *
// WHERE status IN ('queued','spawning','running','paused') — no in-memory
// state to lose.
//
// Continuation lineage via `continues` self-FK. `findActiveContinuation`
// guards `pc_continue_agent` against double-continuation of the same parent.

import { and, desc, eq, gte, inArray, isNull, or, sql } from 'drizzle-orm';

import {
  IllegalLifecycleTransitionError,
  PRESERVED_LIFECYCLE_STATES,
  RUN_LIFECYCLE_STATES,
  canTransition,
  type AgentRunFailureCause,
  type AgentRunRow,
  type AgentRunStatus,
  type RunLifecycleState,
  type ULID,
  type WorktreeGitReceipt,
  type WorktreePhaseReceipt,
} from '@pc/domain';

import { getDb } from '../connection.ts';
import { agentRuns } from '../schema-agent-system.ts';

export interface InsertAgentRunRowInput {
  /** PC-minted ULID. Matches the AgentRun wrapper's `agentRunId`. */
  id: ULID;
  projectId: ULID;
  podName: string;
  dispatcherSessionId: string;
  ccSessionId: string;
  /** Initial status. Usually `'queued'` at admission time; a downstream
   *  caller flips it to `'spawning'` when the cap frees. */
  status: AgentRunStatus;
  input: string | null;
  pmRef?: string | null;
  parentInvokeDepth?: number;
  /** Null for original dispatches; FK to parent row for continuations. */
  continues?: ULID | null;
  /** Pod row's `updated_at` (or revision hash) at dispatch time. Stored for
   *  drift detection on resume. Null when the materialiser didn't supply a
   *  revision. */
  podRevisionAtDispatch?: string | null;
  /** Slice 013 — FK to the first-class `agent_contracts` row this run is
   *  producing. NULL for legacy/non-contract dispatches. */
  contractId?: ULID | null;
  /** Absolute path to the worktree directory the agent was spawned in. Used to
   *  derive the correct CC JSONL path. NULL = main project dir (legacy rows). */
  worktreeDir?: string | null;
  /** Repo dispatch provenance. NULL for non-repo/legacy rows. */
  worktreeBaseBranch?: string | null;
  worktreeBaseSha?: string | null;
  /** Git provisioning receipt (docs/worktree-lifecycle.md). Known at insert
   *  time (provision precedes the row); preparation/readiness receipts land
   *  later via setAgentRunPhaseReceipt. */
  gitReceipt?: WorktreeGitReceipt | null;
  /** Runtime-selection stamp: adapter id / account / model for this run. */
  runtimeId?: string | null;
  accountId?: string | null;
  model?: string | null;
  /** Initial worktree-pipeline state. NULL (default) = non-repo/legacy run —
   *  no lifecycle vocabulary applies to the row, ever. */
  lifecycleState?: RunLifecycleState | null;
  /** Bounded auto-continue counter (docs: max-turns fix part 2). Omit (0) for
   *  a fresh dispatch or a manual continuation; the dispatch service passes
   *  `parent.autoContinueCount + 1` for an internal auto-continuation. */
  autoContinueCount?: number;
  queuedAt: number;
}

/** Insert a fresh row. Status starts at the caller's choice (typically
 *  'queued'); subsequent transitions go through `updateAgentRunStatus` +
 *  `markAgentRunTerminal`. */
export function insertAgentRunRow(input: InsertAgentRunRowInput): AgentRunRow {
  const row: AgentRunRow = {
    id: input.id,
    projectId: input.projectId,
    dispatcherSessionId: input.dispatcherSessionId,
    ccSessionId: input.ccSessionId,
    podName: input.podName,
    podRevisionAtDispatch: input.podRevisionAtDispatch ?? null,
    podRevisionAtResume: null,
    status: input.status,
    lifecycleState: input.lifecycleState ?? null,
    continues: input.continues ?? null,
    parentInvokeDepth: input.parentInvokeDepth ?? 0,
    pmRef: input.pmRef ?? null,
    input: input.input,
    result: null,
    failureCause: null,
    failureReason: null,
    queuedAt: input.queuedAt,
    spawnedAt: null,
    readyAt: null,
    pid: null,
    lastActivityAt: null,
    deliveredAt: null,
    completedAt: null,
    rev: 0,
    contractId: input.contractId ?? null,
    worktreeDir: input.worktreeDir ?? null,
    worktreeBaseBranch: input.worktreeBaseBranch ?? null,
    worktreeBaseSha: input.worktreeBaseSha ?? null,
    gitReceipt: input.gitReceipt ?? null,
    preparationReceipt: null,
    readinessReceipt: null,
    runtimeId: input.runtimeId ?? null,
    accountId: input.accountId ?? null,
    model: input.model ?? null,
    autoContinueCount: input.autoContinueCount ?? 0,
  };
  getDb().insert(agentRuns).values(row).run();
  return row;
}

export interface UpdateAgentRunStatusInput {
  id: ULID;
  status: AgentRunStatus;
  /** Set when transitioning into 'spawning' (or 'spawning' from 'paused' on
   *  resume — both paths re-arm the spawn timestamp). */
  spawnedAt?: number;
  /** Set when transitioning into 'running'. */
  readyAt?: number;
  /** Host-backed runs (2026-06-10): OS pid of the live claude.exe child from
   *  the host snapshot (null after exit). Persisted so peek/kill can answer
   *  "is anything actually alive" — host runs used to always show pid null. */
  pid?: number | null;
  /** Set on the resume path (paused → spawning). Captures pod-row revision
   *  at resume time for drift detection. */
  podRevisionAtResume?: string | null;
  /** Worktree-pipeline transition to stamp alongside. Guarded: an illegal
   *  move (per ALLOWED_LIFECYCLE_TRANSITIONS) rejects the WHOLE update with
   *  a typed IllegalLifecycleTransitionError. Omit = leave untouched. */
  lifecycleState?: RunLifecycleState;
}

const REV_INC = sql`rev + 1` as unknown as number;

/** WHERE guard for a lifecycle stamp: the current value must be a legal
 *  source for `to` (NULL adoption + same-state always legal). Enforced in the
 *  SAME statement as the write — no read-then-write window. */
function legalLifecycleSources(to: RunLifecycleState) {
  const sources = RUN_LIFECYCLE_STATES.filter((s) => canTransition(s, to));
  return or(isNull(agentRuns.lifecycleState), inArray(agentRuns.lifecycleState, sources));
}

/** Zero-row lifecycle write: missing row keeps the historical silent no-op;
 *  an existing row means the transition was illegal — typed rejection. */
function throwIfIllegalTransition(id: ULID, to: RunLifecycleState): void {
  const row = getAgentRunRow(id);
  if (row) throw new IllegalLifecycleTransitionError(id, row.lifecycleState, to);
}

/** Non-terminal status transition. Idempotent at the row level — caller is
 *  responsible for ordering. A supplied `lifecycleState` is rejected (typed
 *  error, nothing written) when the move is illegal. */
export function updateAgentRunStatus(input: UpdateAgentRunStatusInput): void {
  const patch: Partial<AgentRunRow> = { status: input.status, rev: REV_INC };
  if (input.spawnedAt !== undefined) patch.spawnedAt = input.spawnedAt;
  if (input.readyAt !== undefined) patch.readyAt = input.readyAt;
  if (input.pid !== undefined) patch.pid = input.pid;
  if (input.podRevisionAtResume !== undefined) {
    patch.podRevisionAtResume = input.podRevisionAtResume;
  }
  if (input.lifecycleState === undefined) {
    getDb().update(agentRuns).set(patch).where(eq(agentRuns.id, input.id)).run();
    return;
  }
  patch.lifecycleState = input.lifecycleState;
  const result = getDb()
    .update(agentRuns)
    .set(patch)
    .where(and(eq(agentRuns.id, input.id), legalLifecycleSources(input.lifecycleState)))
    .run();
  if (result.changes === 0) throwIfIllegalTransition(input.id, input.lifecycleState);
}

/** Persist the spawned OS pid for an in-process run. Called once right after
 *  the PTY child spawns. Does NOT bump rev — pid is liveness bookkeeping, not a
 *  status transition the frontend needs to version. */
export function updateAgentRunPid(id: ULID, pid: number | null): void {
  getDb().update(agentRuns).set({ pid }).where(eq(agentRuns.id, id)).run();
}

/** Stamp last-observed JSONL activity. Called by the tailer on each event so
 *  the liveness sweep can distinguish a working run from a wedged one. No rev
 *  bump (high-frequency, not a status change). */
export function touchAgentRunActivity(id: ULID, at: number): void {
  getDb().update(agentRuns).set({ lastActivityAt: at }).where(eq(agentRuns.id, id)).run();
}

/** T2.2 — bump rev with NO state change, returning the post-bump row. The
 *  watchdog's non-terminal `stalled` signal carries no status change, so it
 *  would otherwise reuse the last frame's rev and be dropped by the client live
 *  store's version dedup. A rev bump lets the stalled (and un-stall) frame
 *  out-version the prior frame and land. */
export function bumpAgentRunRev(id: ULID): AgentRunRow | null {
  getDb().update(agentRuns).set({ rev: REV_INC }).where(eq(agentRuns.id, id)).run();
  return getAgentRunRow(id);
}

export interface MarkAgentRunTerminalInput {
  id: ULID;
  status: Extract<AgentRunStatus, 'completed' | 'failed' | 'cancelled'>;
  result: string | null;
  failureCause: AgentRunFailureCause | null;
  failureReason: string | null;
  completedAt: number;
  /** Worktree-pipeline transition to stamp alongside (same guard as
   *  updateAgentRunStatus). Omit = leave untouched — a repo run's lifecycle
   *  outlives its dispatch terminal (verify/land continue past 'completed'). */
  lifecycleState?: RunLifecycleState;
}

/** Flip to a terminal status. Idempotent at the row level — repeated calls
 *  with the same terminal status are no-ops. A supplied `lifecycleState` is
 *  rejected (typed error, nothing written) when the move is illegal. */
export function markAgentRunTerminal(input: MarkAgentRunTerminalInput): void {
  const patch: Partial<AgentRunRow> = {
    status: input.status,
    result: input.result,
    failureCause: input.failureCause,
    failureReason: input.failureReason,
    completedAt: input.completedAt,
    rev: REV_INC,
  };
  if (input.lifecycleState === undefined) {
    getDb().update(agentRuns).set(patch).where(eq(agentRuns.id, input.id)).run();
    return;
  }
  patch.lifecycleState = input.lifecycleState;
  const result = getDb()
    .update(agentRuns)
    .set(patch)
    .where(and(eq(agentRuns.id, input.id), legalLifecycleSources(input.lifecycleState)))
    .run();
  if (result.changes === 0) throwIfIllegalTransition(input.id, input.lifecycleState);
}

/** Workflow-engine redesign — stamp the delivery receipt when the worker
 *  submits its deliverable (`pc_submit_deliverable`). The positive done-signal:
 *  read back at terminal time to distinguish a real completion from a
 *  `no-deliverable` failure. Idempotent (first delivery wins); does NOT bump rev
 *  (delivery is not itself a status transition — completion follows it). */
export function markAgentRunDelivered(id: ULID, at: number): void {
  getDb()
    .update(agentRuns)
    .set({ deliveredAt: at })
    .where(and(eq(agentRuns.id, id), sql`${agentRuns.deliveredAt} IS NULL`))
    .run();
}

/** Persist a preparation/readiness receipt (docs/worktree-lifecycle.md).
 *  Bumps rev — the receipt rides the run DTO, so the frame must out-version
 *  the prior delivery. Last write wins (continuations re-run readiness). */
export function setAgentRunPhaseReceipt(
  id: ULID,
  receipt: WorktreePhaseReceipt,
): void {
  const patch: Partial<AgentRunRow> =
    receipt.phase === 'preparation' ? { preparationReceipt: receipt } : { readinessReceipt: receipt };
  patch.rev = REV_INC;
  getDb().update(agentRuns).set(patch).where(eq(agentRuns.id, id)).run();
}

/** Point read by ULID. `pc_continue_agent` calls this to validate the
 *  parent exists + is in a continuable state. */
export function getAgentRunRow(id: ULID): AgentRunRow | null {
  const row = getDb().select().from(agentRuns).where(eq(agentRuns.id, id)).get();
  return row ?? null;
}

export interface ListAgentRunsForSessionOptions {
  podName?: string;
  status?: AgentRunStatus;
  /** 1-based cap on returned rows. */
  limit: number;
}

/** Hot path for `pc_list_my_runs`. Filter by (project, dispatcher session),
 *  optionally by pod name / status. Newest first. */
export function listAgentRunsForSession(
  projectId: ULID,
  dispatcherSessionId: string,
  opts: ListAgentRunsForSessionOptions,
): AgentRunRow[] {
  const filters = [
    eq(agentRuns.projectId, projectId),
    eq(agentRuns.dispatcherSessionId, dispatcherSessionId),
  ];
  if (opts.podName) filters.push(eq(agentRuns.podName, opts.podName));
  if (opts.status) filters.push(eq(agentRuns.status, opts.status));
  return getDb()
    .select()
    .from(agentRuns)
    .where(and(...filters))
    .orderBy(desc(agentRuns.queuedAt))
    .limit(opts.limit)
    .all();
}

/** Activity Panel feeder. Lists non-terminal rows for a project
 *  (queued | spawning | running | paused). Newest first. */
export function listActiveAgentRunsForProject(projectId: ULID): AgentRunRow[] {
  return getDb()
    .select()
    .from(agentRuns)
    .where(
      and(
        eq(agentRuns.projectId, projectId),
        inArray(agentRuns.status, ['queued', 'spawning', 'running', 'paused']),
      ),
    )
    .orderBy(desc(agentRuns.queuedAt))
    .all();
}

/** Boot/reconcile feeder. Lists every non-terminal row across projects. */
export function listNonTerminalAgentRuns(): AgentRunRow[] {
  return getDb()
    .select()
    .from(agentRuns)
    .where(inArray(agentRuns.status, ['queued', 'spawning', 'running', 'paused']))
    .orderBy(desc(agentRuns.queuedAt))
    .all();
}

/** S3 envelope-replay feeder. Lists terminal rows that finalized at/after
 *  `since` across projects (bounds the replay scan to a recent window so it's
 *  not a full-table sweep). Newest first. */
export function listRecentTerminalAgentRuns(since: number): AgentRunRow[] {
  return getDb()
    .select()
    .from(agentRuns)
    .where(
      and(
        inArray(agentRuns.status, ['completed', 'failed', 'cancelled']),
        gte(agentRuns.completedAt, since),
      ),
    )
    .orderBy(desc(agentRuns.completedAt))
    .all();
}

/** State-based retention (docs/worktree-lifecycle.md 'Teardown and
 *  retention'): terminal rows parked in a preserved lifecycle state
 *  (merge-ready, conflict, stranded, review-rejected, failed) stay listed
 *  until resolved — no age window. Non-repo rows (lifecycleState NULL) never
 *  match; they keep the recent-terminal window. Newest first. */
export function listPreservedTerminalAgentRuns(projectId: ULID): AgentRunRow[] {
  return getDb()
    .select()
    .from(agentRuns)
    .where(
      and(
        eq(agentRuns.projectId, projectId),
        inArray(agentRuns.status, ['completed', 'failed', 'cancelled']),
        inArray(agentRuns.lifecycleState, PRESERVED_LIFECYCLE_STATES as unknown as RunLifecycleState[]),
      ),
    )
    .orderBy(desc(agentRuns.completedAt))
    .all();
}

/** Every run bound to one contract — the original dispatch plus its
 *  continuations/re-drives. Feeds the landed-contract resolution pass:
 *  once the contract lands and its worktree is reclaimed, earlier runs
 *  parked in preserved lifecycle states resolve to 'completed'. Newest
 *  first. */
export function listAgentRunsForContract(contractId: ULID): AgentRunRow[] {
  return getDb()
    .select()
    .from(agentRuns)
    .where(eq(agentRuns.contractId, contractId))
    .orderBy(desc(agentRuns.queuedAt))
    .all();
}

/** Concurrent-continuation guard. Returns a non-terminal continuation row
 *  if one exists for `priorRunId`. `pc_continue_agent` rejects with 409
 *  when this comes back non-null. */
export function findActiveContinuation(priorRunId: ULID): AgentRunRow | null {
  const row = getDb()
    .select()
    .from(agentRuns)
    .where(
      and(
        eq(agentRuns.continues, priorRunId),
        inArray(agentRuns.status, ['queued', 'spawning', 'running', 'paused']),
      ),
    )
    .get();
  return row ?? null;
}

/** Auto-continue idempotency guard (docs: max-turns fix part 2). True iff
 *  ANY continuation row exists for `priorRunId`, terminal or not — unlike
 *  `findActiveContinuation`, this also catches the case where a prior
 *  auto-continue attempt was already dispatched and has since settled (e.g.
 *  force-failed 'server-restart' by the boot sweep). Boot re-entry
 *  (`recoverPendingAutoContinues`) uses this to never double-fire. */
export function hasContinuation(priorRunId: ULID): boolean {
  const row = getDb()
    .select({ id: agentRuns.id })
    .from(agentRuns)
    .where(eq(agentRuns.continues, priorRunId))
    .limit(1)
    .get();
  return row !== undefined;
}

/** Boot re-entry feeder for bounded auto-continue (docs: max-turns fix part
 *  2). Every run that settled 'failed' with cause 'turn-budget-exhausted' —
 *  the dispatch service filters by MAX_AUTO_CONTINUES and `hasContinuation`
 *  to find the ones still needing an auto-continuation fired. */
export function listTurnBudgetExhaustedRuns(): AgentRunRow[] {
  return getDb()
    .select()
    .from(agentRuns)
    .where(and(eq(agentRuns.status, 'failed'), eq(agentRuns.failureCause, 'turn-budget-exhausted')))
    .orderBy(desc(agentRuns.completedAt))
    .all();
}

/** Patch the failure reason on an already-terminal row without touching its
 *  status (unlike `markAgentRunTerminal`, no terminal-idempotency guard — the
 *  caller already knows the row is terminal). Used to record why an
 *  auto-continue attempt itself failed to dispatch (docs: max-turns fix part
 *  2) before delivering the ceiling envelope off the existing terminal row. */
export function setAgentRunFailureReason(id: ULID, failureReason: string): void {
  getDb().update(agentRuns).set({ failureReason }).where(eq(agentRuns.id, id)).run();
}

// Step 2 (2026-06-03) — the boot-time bulk-fail sweeps (`reconcileOrphanedRunningRuns`,
// `listAndReconcileOrphanedRuns`) are DELETED. They flipped rows terminal with a raw
// UPDATE — bypassing the one terminal authority — and killed `paused` rows (FD-14
// violation). The agent-run reconciler loop (apps/server agent-run-reconciler.ts)
// owns orphan detection now; every finalize routes through applyAgentRunTerminalEffects.

// ── Slice 013 — agent_runs.contract_id link (additive) ───────────────────────

/** Point an agent_run at the first-class contract it's producing. Does NOT
 *  bump rev — the contract link is dispatch bookkeeping, not a status
 *  transition the frontend versions. Idempotent. */
/** Stamp the adapter-native session id once the runtime's init event lands
 *  (the SDK mints it; we can't choose it up front). Resume routes through it. */
export function setAgentRunCcSession(id: ULID, ccSessionId: string): void {
  getDb()
    .update(agentRuns)
    .set({ ccSessionId, rev: sql`${agentRuns.rev} + 1` })
    .where(eq(agentRuns.id, id))
    .run();
}

export function setAgentRunContractId(id: ULID, contractId: ULID | null): void {
  getDb().update(agentRuns).set({ contractId }).where(eq(agentRuns.id, id)).run();
}
