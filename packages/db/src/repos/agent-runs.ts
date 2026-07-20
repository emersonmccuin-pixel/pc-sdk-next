// Section 25 — agent_runs repo.
//
// Persists the FULL state machine (queued | spawning | running | paused |
// completed | failed | cancelled). Restart-time reconciliation is a SELECT *
// WHERE status IN ('queued','spawning','running','paused') — no in-memory
// state to lose.
//
// Continuation lineage via `continues` self-FK. `findActiveContinuation`
// guards `pc_continue_agent` against double-continuation of the same parent.

import { and, count, desc, eq, gte, inArray, isNotNull, isNull, or, sql } from 'drizzle-orm';

import {
  isRuntimeSelection,
  isRuntimeSessionReceipt,
  runtimeSelectionsEqual,
  type RuntimeSelection,
  type RuntimeSessionReceipt,
} from '@pc/contracts';

import {
  IllegalLifecycleTransitionError,
  PRESERVED_LIFECYCLE_STATES,
  RUN_LIFECYCLE_STATES,
  canTransition,
  isMatchingReviewCheckoutPhase,
  isMatchingWorktreeAbandonmentTeardown,
  isPositivePreparationReceiptForRun,
  isPositiveWorktreePhaseReceipt,
  isReviewCheckoutGitReceipt,
  isReviewCheckoutPhaseReceipt,
  isWorktreePhaseReceipt,
  isSpecialistExecutionSnapshot,
  type AgentRunFailureCause,
  type AgentRunRow,
  type AgentRunStatus,
  type RunLifecycleState,
  type ReviewCheckoutPhaseReceipt,
  type SpecialistExecutionSnapshot,
  type ULID,
  type WorktreeGitReceipt,
  type WorktreePhaseReceipt,
} from '@pc/domain';

import { getDb, type DbExecutor } from '../connection.ts';
import { newId } from '../id.ts';
import { agentContracts, agentRuns } from '../schema-agent-system.ts';
import { worktrees } from '../schema.ts';

export interface InsertAgentRunRowInput {
  /** PC-minted ULID. Matches the AgentRun wrapper's `agentRunId`. */
  id: ULID;
  projectId: ULID;
  dispatcherSessionId: string;
  specialistSnapshot: SpecialistExecutionSnapshot;
  selection: RuntimeSelection;
  continuation:
    | { mode: 'create' }
    | { mode: 'resume'; nativeSessionId: string };
  /** One admission state only. Receipt-gated transitions happen afterward. */
  status: 'queued';
  input: string | null;
  pmRef?: string | null;
  parentInvokeDepth?: number;
  /** Null for original dispatches; FK to parent row for continuations. */
  continues?: ULID | null;
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
  /** Initial worktree-pipeline state. NULL (default) = non-repo/legacy run —
   *  no lifecycle vocabulary applies to the row, ever. */
  lifecycleState?: RunLifecycleState | null;
  /** Bounded auto-continue counter (docs: max-turns fix part 2). Omit (0) for
   *  a fresh dispatch or a manual continuation; the dispatch service passes
   *  `parent.autoContinueCount + 1` for an internal auto-continuation. */
  autoContinueCount?: number;
  queuedAt: number;
}

/** Insert a fresh queued row; subsequent transitions go through the guarded
 * status/receipt/terminal doors. */
export function insertAgentRunRow(input: InsertAgentRunRowInput): AgentRunRow {
  if (!isSpecialistExecutionSnapshot(input.specialistSnapshot)) {
    throw new Error('agent run requires an exact specialist execution snapshot');
  }
  if (!isRuntimeSelection(input.selection)) {
    throw new Error('agent run requires an exact complete runtime selection');
  }
  if (input.contractId) {
    const contract = getDb().select({
      landingStatus: agentContracts.landingStatus,
      abandonmentReceipt: agentContracts.abandonmentReceipt,
    }).from(agentContracts).where(eq(agentContracts.id, input.contractId)).get();
    if (
      contract &&
      (
        contract.abandonmentReceipt !== null ||
        contract.landingStatus === 'pending' ||
        contract.landingStatus === 'abandoning' ||
        contract.landingStatus === 'landed' ||
        contract.landingStatus === 'abandoned'
      )
    ) {
      throw new Error('agent run admission refused: contract abandonment or landing is reserved or settled');
    }
  }
  const nativeSessionId = input.continuation.mode === 'resume'
    ? exactNonEmpty(input.continuation.nativeSessionId, 'nativeSessionId')
    : null;
  const effort = flattenEffort(input.selection);
  const row: AgentRunRow = {
    id: input.id,
    projectId: input.projectId,
    dispatcherSessionId: input.dispatcherSessionId,
    snapshotState: 'stamped',
    specialistSnapshot: structuredClone(input.specialistSnapshot),
    nativeSessionId,
    nativeIdentityState: nativeSessionId === null ? 'unbound' : 'bound',
    continuationState: nativeSessionId === null ? 'clean-pending' : 'resume-pending',
    continuationAttemptId: newId(),
    podName: input.specialistSnapshot.name,
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
    selectionState: 'stamped',
    runtimeId: input.selection.runtimeId,
    accountId: input.selection.accountId,
    model: input.selection.model,
    ...effort,
    autoContinueCount: input.autoContinueCount ?? 0,
    dismissedAt: null,
  };
  getDb().insert(agentRuns).values(row).run();
  return row;
}

function exactNonEmpty(value: string, field: string): string {
  if (!value.trim() || value !== value.trim()) {
    throw new Error(`${field} must be an exact non-empty value`);
  }
  return value;
}

function flattenEffort(selection: RuntimeSelection): {
  effortState: 'selected' | 'none' | 'unavailable';
  effort: string | null;
} {
  if (selection.effort.kind === 'selected') {
    return {
      effortState: 'selected',
      effort: exactNonEmpty(selection.effort.value, 'effort.value'),
    };
  }
  return { effortState: selection.effort.kind, effort: null };
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
export function updateAgentRunStatus(input: UpdateAgentRunStatusInput): boolean {
  const patch: Partial<AgentRunRow> = { status: input.status, rev: REV_INC };
  if (input.spawnedAt !== undefined) patch.spawnedAt = input.spawnedAt;
  if (input.readyAt !== undefined) patch.readyAt = input.readyAt;
  if (input.pid !== undefined) patch.pid = input.pid;
  const statuses = ['queued', 'spawning', 'running', 'paused'].includes(input.status)
    ? inArray(agentRuns.status, ['queued', 'spawning', 'running', 'paused'])
    : eq(agentRuns.status, input.status);
  const receiptEvidence = input.status === 'running'
    ? and(
        eq(agentRuns.nativeIdentityState, 'bound'),
        inArray(agentRuns.continuationState, ['clean-started', 'native-resumed']),
      )
    : undefined;
  if (input.lifecycleState === undefined) {
    return getDb().update(agentRuns).set(patch)
      .where(and(eq(agentRuns.id, input.id), statuses, receiptEvidence)).run().changes === 1;
  }
  patch.lifecycleState = input.lifecycleState;
  const result = getDb()
    .update(agentRuns)
    .set(patch)
    .where(and(
      eq(agentRuns.id, input.id),
      statuses,
      receiptEvidence,
      legalLifecycleSources(input.lifecycleState),
    ))
    .run();
  if (result.changes === 0) {
    const current = getAgentRunRow(input.id);
    if (!current || (
      ['queued', 'spawning', 'running', 'paused'].includes(input.status) &&
      ['completed', 'failed', 'cancelled'].includes(current.status)
    ) || (
      input.status === 'running' &&
      (current.nativeIdentityState !== 'bound' ||
        (current.continuationState !== 'clean-started' && current.continuationState !== 'native-resumed'))
    )) return false;
    throwIfIllegalTransition(input.id, input.lifecycleState);
    return false;
  }
  return true;
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
  /** Optional durable generation fence for async runtime callbacks. */
  continuationAttemptId?: string;
  /** Worktree-pipeline transition to stamp alongside (same guard as
   *  updateAgentRunStatus). Omit = leave untouched — a repo run's lifecycle
   *  outlives its dispatch terminal (verify/land continue past 'completed'). */
  lifecycleState?: RunLifecycleState;
}

/** Flip to a terminal status. Idempotent at the row level — repeated calls
 *  with the same terminal status are no-ops. A supplied `lifecycleState` is
 *  rejected (typed error, nothing written) when the move is illegal. */
export function markAgentRunTerminal(input: MarkAgentRunTerminalInput): boolean {
  const patch: Partial<AgentRunRow> = {
    status: input.status,
    result: input.result,
    failureCause: input.failureCause,
    failureReason: input.failureReason,
    completedAt: input.completedAt,
    rev: REV_INC,
  };
  const sources = [
    eq(agentRuns.id, input.id),
    inArray(agentRuns.status, ['queued', 'spawning', 'running', 'paused']),
  ];
  if (input.continuationAttemptId !== undefined) {
    sources.push(eq(agentRuns.continuationAttemptId, input.continuationAttemptId));
  }
  if (input.lifecycleState === undefined) {
    return getDb().update(agentRuns).set(patch).where(and(...sources)).run().changes === 1;
  }
  patch.lifecycleState = input.lifecycleState;
  const result = getDb()
    .update(agentRuns)
    .set(patch)
    .where(and(...sources, legalLifecycleSources(input.lifecycleState)))
    .run();
  if (result.changes === 0) {
    const current = getAgentRunRow(input.id);
    if (
      !current ||
      ['completed', 'failed', 'cancelled'].includes(current.status) ||
      (input.continuationAttemptId !== undefined &&
        current.continuationAttemptId !== input.continuationAttemptId)
    ) return false;
    throwIfIllegalTransition(input.id, input.lifecycleState);
    return false;
  }
  return true;
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

/** Persist one immutable preparation/readiness receipt.
 *
 * First-write wins and only while the exact run is still queued in its
 * preparing lifecycle state. A provider runtime can never append evidence
 * after it starts. A continuation gets its own row, so it never replaces its
 * parent's readiness evidence. Bumps rev because the receipt rides the
 * versioned run DTO. */
export function setAgentRunPhaseReceipt(
  id: ULID,
  receipt: WorktreePhaseReceipt,
): boolean {
  return setAgentRunPhaseReceiptInDb(id, receipt, getDb()) !== null;
}

/** Agent-run-owned executor-aware phase command. Application services use
 * this door when the versioned run mutation and its outbox fact must share a
 * transaction. Detached review runs have a separate authority-aware command
 * below; generic builder evidence cannot be copied onto them. */
export function setAgentRunPhaseReceiptInDb(
  id: ULID,
  receipt: WorktreePhaseReceipt,
  db: DbExecutor,
): AgentRunRow | null {
  if (!isWorktreePhaseReceipt(receipt)) return null;
  const current = db.select().from(agentRuns).where(eq(agentRuns.id, id)).get();
  if (!current) return null;
  // Detached reviewers use the checkout-bound application-service
  // coordinator. Letting the generic door accept a copied builder receipt
  // would erase checkout provenance even if the payload happened to be
  // byte-identical.
  if (isReviewCheckoutGitReceipt(current.gitReceipt)) return null;
  if (receipt.phase === 'preparation') {
    if (receipt.ok && !isPositivePreparationReceiptForRun(receipt, current.continues)) {
      return null;
    }
    // Failed command evidence is valid only for a fresh preparation phase;
    // continuations never re-run setup in an existing worktree.
    if (current.continues !== null && receipt.outcome === 'executed') return null;
  } else if (!isPositiveWorktreePhaseReceipt(current.preparationReceipt, 'preparation')) {
    return null;
  } else if (!isPositivePreparationReceiptForRun(current.preparationReceipt, current.continues)) {
    return null;
  }
  const receiptColumn = receipt.phase === 'preparation'
    ? agentRuns.preparationReceipt
    : agentRuns.readinessReceipt;
  const patch: Partial<AgentRunRow> =
    receipt.phase === 'preparation' ? { preparationReceipt: receipt } : { readinessReceipt: receipt };
  patch.rev = REV_INC;
  const changed = db.update(agentRuns).set(patch).where(and(
    eq(agentRuns.id, id),
    eq(agentRuns.status, 'queued'),
    eq(agentRuns.lifecycleState, 'preparing'),
    isNull(receiptColumn),
  )).run();
  return changed.changes === 1
    ? db.select().from(agentRuns).where(eq(agentRuns.id, id)).get() ?? null
    : null;
}

/** Agent-run-owned command for one detached reviewer phase. The bound receipt
 * must match the immutable review Git receipt and the run's pre-runtime shape.
 * Checkout state is deliberately not read here; the app-service coordinator
 * invokes the workspace owner in the same transaction. */
export function setReviewAgentRunPhaseReceiptInDb(
  id: ULID,
  receipt: ReviewCheckoutPhaseReceipt,
  db: DbExecutor,
): AgentRunRow | null {
  if (!isReviewCheckoutPhaseReceipt(receipt) || receipt.reviewerRunId !== id) return null;
  const current = db.select().from(agentRuns).where(eq(agentRuns.id, id)).get();
  const gitReceipt = current?.gitReceipt;
  if (!current ||
      current.projectId !== receipt.projectId ||
      current.status !== 'queued' ||
      current.lifecycleState !== null ||
      current.continues !== null ||
      current.nativeSessionId !== null ||
      current.nativeIdentityState !== 'unbound' ||
      current.continuationState !== 'clean-pending' ||
      current.spawnedAt !== null ||
      current.pid !== null ||
      current.worktreeDir !== receipt.worktreePath ||
      current.worktreeBaseBranch !== '(detached)' ||
      current.worktreeBaseSha !== receipt.sealedCommit ||
      !isReviewCheckoutGitReceipt(gitReceipt) ||
      !isMatchingReviewCheckoutPhase(gitReceipt, receipt)) return null;

  const phase = receipt.evidence.phase;
  if (phase === 'preparation') {
    if (current.preparationReceipt !== null || current.readinessReceipt !== null) return null;
  } else if (current.readinessReceipt !== null ||
      !isPositiveWorktreePhaseReceipt(current.preparationReceipt, 'preparation')) {
    return null;
  }
  const receiptColumn = phase === 'preparation'
    ? agentRuns.preparationReceipt
    : agentRuns.readinessReceipt;
  const patch: Partial<AgentRunRow> = phase === 'preparation'
    ? { preparationReceipt: receipt.evidence, rev: REV_INC }
    : { readinessReceipt: receipt.evidence, rev: REV_INC };
  const changed = db.update(agentRuns).set(patch).where(and(
    eq(agentRuns.id, id),
    eq(agentRuns.status, 'queued'),
    isNull(agentRuns.lifecycleState),
    isNull(agentRuns.continues),
    isNull(agentRuns.nativeSessionId),
    eq(agentRuns.nativeIdentityState, 'unbound'),
    eq(agentRuns.continuationState, 'clean-pending'),
    isNull(agentRuns.spawnedAt),
    isNull(agentRuns.pid),
    eq(agentRuns.gitReceipt, gitReceipt),
    isNull(receiptColumn),
  )).run();
  return changed.changes === 1
    ? db.select().from(agentRuns).where(eq(agentRuns.id, id)).get() ?? null
    : null;
}

export interface TransitionAgentRunLifecycleInput {
  id: ULID;
  expectedFrom: RunLifecycleState;
  to: RunLifecycleState;
}

/** Agent-run-owned exact lifecycle CAS for cross-component application-service
 * coordinators. It never reads another component's state and returns the
 * versioned post-write row for same-transaction outbox publication. */
export function transitionAgentRunLifecycleInDb(
  input: TransitionAgentRunLifecycleInput,
  db: DbExecutor,
): AgentRunRow | null {
  if (input.expectedFrom === input.to || !canTransition(input.expectedFrom, input.to)) return null;
  const changed = db.update(agentRuns).set({
    lifecycleState: input.to,
    rev: REV_INC,
  }).where(and(
    eq(agentRuns.id, input.id),
    eq(agentRuns.lifecycleState, input.expectedFrom),
    inArray(agentRuns.status, ['completed', 'failed', 'cancelled']),
  )).run();
  return changed.changes === 1
    ? db.select().from(agentRuns).where(eq(agentRuns.id, input.id)).get() ?? null
    : null;
}

export interface ValidateReviewVerdictAgentRunFrameInput {
  contractId: ULID;
  producerRunId: ULID;
}

/** Agent-run-owned stable-frame guard for review-verdict application. It is a
 * read-only same-transaction precondition: the application-service coordinator
 * performs the exact lifecycle CAS only after the contract owner succeeds, so
 * every later refusal can still return without committing a partial run move. */
export function validateReviewVerdictAgentRunFrameInDb(
  input: ValidateReviewVerdictAgentRunFrameInput,
  db: DbExecutor,
): AgentRunRow | null {
  const live = db.select({ id: agentRuns.id }).from(agentRuns).where(and(
    eq(agentRuns.contractId, input.contractId),
    inArray(agentRuns.status, ['queued', 'spawning', 'running', 'paused']),
  )).limit(1).get();
  if (live) return null;
  const producer = db.select().from(agentRuns).where(and(
    eq(agentRuns.id, input.producerRunId),
    eq(agentRuns.contractId, input.contractId),
    inArray(agentRuns.status, ['completed', 'failed', 'cancelled']),
    eq(agentRuns.lifecycleState, 'reviewing'),
  )).get() as AgentRunRow | undefined;
  return producer ?? null;
}

/** Point read by ULID. `pc_continue_agent` calls this to validate the
 *  parent exists + is in a continuable state. */
export function getAgentRunRow(id: ULID): AgentRunRow | null {
  const row = getDb().select().from(agentRuns).where(eq(agentRuns.id, id)).get();
  return row ?? null;
}

export function runtimeSelectionForAgentRun(row: AgentRunRow): RuntimeSelection | null {
  if (
    row.selectionState !== 'stamped' ||
    !row.runtimeId ||
    !row.accountId ||
    !row.model ||
    row.effortState === 'legacy-unknown'
  ) return null;
  const effort: RuntimeSelection['effort'] | null = row.effortState === 'selected'
    ? row.effort
      ? { kind: 'selected', value: row.effort }
      : null
    : { kind: row.effortState };
  if (!effort) return null;
  const selection = {
    runtimeId: row.runtimeId,
    accountId: row.accountId,
    model: row.model,
    effort,
  };
  return isRuntimeSelection(selection) ? selection : null;
}

export function specialistSnapshotForAgentRun(
  row: AgentRunRow,
): SpecialistExecutionSnapshot | null {
  return row.snapshotState === 'stamped' &&
    isSpecialistExecutionSnapshot(row.specialistSnapshot)
    ? structuredClone(row.specialistSnapshot)
    : null;
}

export function isAgentRunNativeResumeReady(row: AgentRunRow): boolean {
  return row.selectionState === 'stamped' &&
    runtimeSelectionForAgentRun(row) !== null &&
    row.snapshotState === 'stamped' &&
    specialistSnapshotForAgentRun(row) !== null &&
    row.nativeIdentityState === 'bound' &&
    typeof row.nativeSessionId === 'string' &&
    row.nativeSessionId.trim().length > 0 &&
    row.continuationState !== 'clean-pending' &&
    row.continuationState !== 'legacy-unavailable' &&
    typeof row.continuationAttemptId === 'string' &&
    row.continuationAttemptId.trim().length > 0;
}

function nonTerminalStatus(row: AgentRunRow): boolean {
  return row.status === 'queued' ||
    row.status === 'spawning' ||
    row.status === 'running' ||
    row.status === 'paused';
}

function freshAttemptId(previous: string): ULID {
  let attemptId = newId();
  while (attemptId === previous) attemptId = newId();
  return attemptId;
}

/** Rotate the durable generation immediately before an adapter clean create. */
export function prepareAgentRunCreate(id: ULID): AgentRunRow | null {
  return getDb().transaction((tx) => {
    const row = tx.select().from(agentRuns).where(eq(agentRuns.id, id)).get();
    if (
      !row ||
      !nonTerminalStatus(row) ||
      row.status === 'paused' ||
      runtimeSelectionForAgentRun(row) === null ||
      specialistSnapshotForAgentRun(row) === null ||
      row.nativeIdentityState !== 'unbound' ||
      row.nativeSessionId !== null ||
      row.continuationState !== 'clean-pending' ||
      !row.continuationAttemptId
    ) return null;
    const continuationAttemptId = freshAttemptId(row.continuationAttemptId);
    const changed = tx.update(agentRuns)
      .set({ continuationAttemptId })
      .where(and(
        eq(agentRuns.id, id),
        inArray(agentRuns.status, ['queued', 'spawning', 'running']),
        eq(agentRuns.selectionState, 'stamped'),
        eq(agentRuns.snapshotState, 'stamped'),
        eq(agentRuns.nativeIdentityState, 'unbound'),
        eq(agentRuns.continuationState, 'clean-pending'),
        eq(agentRuns.continuationAttemptId, row.continuationAttemptId),
        isNull(agentRuns.nativeSessionId),
      ))
      .run();
    return changed.changes === 1 ? { ...row, continuationAttemptId } : null;
  });
}

/** Rotate the durable generation immediately before an adapter native resume. */
export function prepareAgentRunResume(id: ULID): AgentRunRow | null {
  return getDb().transaction((tx) => prepareAgentRunResumeInDb(id, tx));
}

/** Executor-aware resume preparation for atomic state + outbox publication. */
export function prepareAgentRunResumeInDb(
  id: ULID,
  db: DbExecutor,
): AgentRunRow | null {
  const row = db.select().from(agentRuns).where(eq(agentRuns.id, id)).get();
  if (
    !row ||
    (row.status !== 'queued' && row.status !== 'paused') ||
    !isAgentRunNativeResumeReady(row)
  ) return null;
  const continuationAttemptId = freshAttemptId(row.continuationAttemptId!);
  const changed = db.update(agentRuns)
    .set({ continuationState: 'resume-pending', continuationAttemptId, rev: REV_INC })
    .where(and(
      eq(agentRuns.id, id),
      inArray(agentRuns.status, ['queued', 'paused']),
      eq(agentRuns.selectionState, 'stamped'),
      eq(agentRuns.snapshotState, 'stamped'),
      eq(agentRuns.nativeIdentityState, 'bound'),
      eq(agentRuns.nativeSessionId, row.nativeSessionId!),
      eq(agentRuns.continuationState, row.continuationState),
      eq(agentRuns.continuationAttemptId, row.continuationAttemptId!),
    ))
    .run();
  return changed.changes === 1
    ? { ...row, continuationState: 'resume-pending', continuationAttemptId, rev: row.rev + 1 }
    : null;
}

export type AgentRunRuntimeReceiptRejection =
  | 'not-found'
  | 'run-inactive'
  | 'legacy-unavailable'
  | 'malformed-receipt'
  | 'selection-mismatch'
  | 'continuation-attempt-mismatch'
  | 'receipt-mode-mismatch'
  | 'native-session-id-conflict'
  | 'continuation-state-conflict';

export type ConfirmAgentRunRuntimeReceiptResult =
  | { status: 'confirmed'; duplicate: boolean; run: AgentRunRow }
  | { status: 'rejected'; reason: AgentRunRuntimeReceiptRejection };

/** Confirm one exact current create/resume receipt. Every rejection is read-only. */
export function confirmAgentRunRuntimeSessionReceipt(input: {
  runId: ULID;
  receipt: RuntimeSessionReceipt;
}): ConfirmAgentRunRuntimeReceiptResult {
  return getDb().transaction((tx) => {
    const row = tx.select().from(agentRuns).where(eq(agentRuns.id, input.runId)).get();
    if (!row) return { status: 'rejected', reason: 'not-found' };
    if (row.status !== 'spawning' && row.status !== 'running') {
      return { status: 'rejected', reason: 'run-inactive' };
    }
    const selection = runtimeSelectionForAgentRun(row);
    if (!selection || specialistSnapshotForAgentRun(row) === null) {
      return { status: 'rejected', reason: 'legacy-unavailable' };
    }
    if (!isRuntimeSessionReceipt(input.receipt)) {
      return { status: 'rejected', reason: 'malformed-receipt' };
    }
    if (!runtimeSelectionsEqual(selection, input.receipt.selection)) {
      return { status: 'rejected', reason: 'selection-mismatch' };
    }
    if (row.continuationAttemptId !== input.receipt.continuationAttemptId) {
      return { status: 'rejected', reason: 'continuation-attempt-mismatch' };
    }
    const expectedMode = row.continuationState === 'clean-pending' ||
      row.continuationState === 'clean-started'
      ? 'created'
      : 'resumed';
    if (input.receipt.mode !== expectedMode) {
      return { status: 'rejected', reason: 'receipt-mode-mismatch' };
    }
    const nativeSessionId = input.receipt.nativeSessionId;
    if (input.receipt.mode === 'created') {
      if (input.receipt.requestedNativeSessionId !== null) {
        return { status: 'rejected', reason: 'receipt-mode-mismatch' };
      }
      if (
        row.nativeIdentityState === 'bound' &&
        row.nativeSessionId === nativeSessionId &&
        row.continuationState === 'clean-started'
      ) return { status: 'confirmed', duplicate: true, run: row };
      if (row.nativeIdentityState === 'bound' && row.nativeSessionId !== nativeSessionId) {
        return { status: 'rejected', reason: 'native-session-id-conflict' };
      }
      if (
        row.nativeIdentityState !== 'unbound' ||
        row.nativeSessionId !== null ||
        row.continuationState !== 'clean-pending'
      ) return { status: 'rejected', reason: 'continuation-state-conflict' };
      const bound = tx.update(agentRuns).set({
        nativeSessionId,
        nativeIdentityState: 'bound',
        continuationState: 'clean-started',
        rev: REV_INC,
      }).where(and(
        eq(agentRuns.id, row.id),
        eq(agentRuns.status, 'spawning'),
        eq(agentRuns.selectionState, 'stamped'),
        eq(agentRuns.snapshotState, 'stamped'),
        eq(agentRuns.continuationAttemptId, input.receipt.continuationAttemptId),
        eq(agentRuns.nativeIdentityState, 'unbound'),
        eq(agentRuns.continuationState, 'clean-pending'),
        isNull(agentRuns.nativeSessionId),
      )).run();
      if (bound.changes !== 1) {
        return { status: 'rejected', reason: 'continuation-state-conflict' };
      }
    } else {
      if (
        input.receipt.requestedNativeSessionId !== nativeSessionId ||
        row.nativeIdentityState !== 'bound' ||
        row.nativeSessionId !== nativeSessionId
      ) return { status: 'rejected', reason: 'native-session-id-conflict' };
      if (row.continuationState === 'native-resumed') {
        return { status: 'confirmed', duplicate: true, run: row };
      }
      if (row.continuationState !== 'resume-pending') {
        return { status: 'rejected', reason: 'continuation-state-conflict' };
      }
      const resumed = tx.update(agentRuns).set({
        continuationState: 'native-resumed',
        rev: REV_INC,
      }).where(and(
        eq(agentRuns.id, row.id),
        eq(agentRuns.status, 'spawning'),
        eq(agentRuns.selectionState, 'stamped'),
        eq(agentRuns.snapshotState, 'stamped'),
        eq(agentRuns.continuationAttemptId, input.receipt.continuationAttemptId),
        eq(agentRuns.nativeIdentityState, 'bound'),
        eq(agentRuns.nativeSessionId, nativeSessionId),
        eq(agentRuns.continuationState, 'resume-pending'),
      )).run();
      if (resumed.changes !== 1) {
        return { status: 'rejected', reason: 'continuation-state-conflict' };
      }
    }
    const confirmed = tx.select().from(agentRuns).where(eq(agentRuns.id, row.id)).get();
    return confirmed
      ? { status: 'confirmed', duplicate: false, run: confirmed }
      : { status: 'rejected', reason: 'not-found' };
  });
}

/** Fail only the exact still-current native resume attempt. */
export function failAgentRunRuntimeResume(
  runId: ULID,
  continuationAttemptId: string,
): boolean {
  if (!continuationAttemptId.trim()) return false;
  return getDb().transaction((tx) =>
    failAgentRunRuntimeResumeInDb(runId, continuationAttemptId, tx) !== null,
  );
}

/** Executor-aware exact failure stamp for atomic state + outbox publication. */
export function failAgentRunRuntimeResumeInDb(
  runId: ULID,
  continuationAttemptId: string,
  db: DbExecutor,
): AgentRunRow | null {
  if (!continuationAttemptId.trim()) return null;
  const changed = db.update(agentRuns)
    .set({ continuationState: 'resume-failed', rev: REV_INC })
    .where(and(
      eq(agentRuns.id, runId),
      inArray(agentRuns.status, ['spawning', 'paused']),
      eq(agentRuns.selectionState, 'stamped'),
      eq(agentRuns.snapshotState, 'stamped'),
      eq(agentRuns.continuationState, 'resume-pending'),
      eq(agentRuns.continuationAttemptId, continuationAttemptId),
    ))
    .run();
  return changed.changes === 1
    ? db.select().from(agentRuns).where(eq(agentRuns.id, runId)).get() ?? null
    : null;
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

/** Dispatch loop-cap input (docs/phase-3-dispatch.md F5): how many times has
 *  this dispatcher session already dispatched THIS pod, ever (any status).
 *  A session that keeps re-dispatching the same agent — a looping dispatch
 *  pattern rather than a deepening chain — trips the loop cap even though
 *  `parentInvokeDepth` never grows. */
export function countAgentRunsForSessionAndPod(
  projectId: ULID,
  dispatcherSessionId: string,
  podName: string,
): number {
  const row = getDb()
    .select({ n: count() })
    .from(agentRuns)
    .where(
      and(
        eq(agentRuns.projectId, projectId),
        eq(agentRuns.dispatcherSessionId, dispatcherSessionId),
        eq(agentRuns.podName, podName),
      ),
    )
    .get();
  return row?.n ?? 0;
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

/** State-based recovery retention. In addition to the established preserved
 * lifecycle parks, a terminal run remains visible while it is the exact
 * current owner of an active/stranded worktree. That covers cancellation and
 * preparation failure without making those lifecycle sinks globally immortal.
 * Ownership transfer removes the prior attempt; positive cleanup removes the
 * worktree feeder. */
export function listPreservedTerminalAgentRuns(projectId: ULID): AgentRunRow[] {
  const db = getDb();
  const exactUnresolvedOwner = db
    .select({ runId: worktrees.agentRunId })
    .from(worktrees)
    .where(and(
      eq(worktrees.projectId, projectId),
      inArray(worktrees.status, ['active', 'stranded']),
      isNotNull(worktrees.agentRunId),
    ));
  const rows = db
    .select()
    .from(agentRuns)
    .where(
      and(
        eq(agentRuns.projectId, projectId),
        inArray(agentRuns.status, ['completed', 'failed', 'cancelled']),
        or(
          inArray(agentRuns.lifecycleState, PRESERVED_LIFECYCLE_STATES as unknown as RunLifecycleState[]),
          inArray(agentRuns.id, exactUnresolvedOwner),
        ),
      ),
    )
    .orderBy(desc(agentRuns.completedAt))
    .all();
  return rows.filter((run) => {
    const ownedRows = db.select({
      contractId: worktrees.contractId,
      path: worktrees.path,
    }).from(worktrees).where(and(
      eq(worktrees.projectId, projectId),
      eq(worktrees.agentRunId, run.id),
      inArray(worktrees.status, ['active', 'stranded']),
    )).limit(2).all();
    const exactOwned = ownedRows.length === 1 &&
      ownedRows[0]!.contractId === run.contractId &&
      ownedRows[0]!.path === run.worktreeDir;
    const lifecyclePreserved = run.lifecycleState !== null &&
      (PRESERVED_LIFECYCLE_STATES as readonly string[]).includes(run.lifecycleState);
    if (!exactOwned && !lifecyclePreserved) return false;
    const currentWorktree = run.contractId === null
      ? null
      : db.select({
          agentRunId: worktrees.agentRunId,
          path: worktrees.path,
          status: worktrees.status,
        }).from(worktrees).where(and(
          eq(worktrees.contractId, run.contractId),
          inArray(worktrees.status, ['active', 'stranded']),
        )).limit(2).all();
    if (currentWorktree && currentWorktree.length > 1) return false;
    if (
      currentWorktree?.length === 1 &&
      (
        currentWorktree[0]!.agentRunId !== run.id ||
        currentWorktree[0]!.path !== run.worktreeDir
      )
    ) return false;
    if (run.contractId === null) return exactOwned || lifecyclePreserved;
    const contract = db.select({
      landingStatus: agentContracts.landingStatus,
      abandonmentReceipt: agentContracts.abandonmentReceipt,
      abandonmentTeardownReceipt: agentContracts.abandonmentTeardownReceipt,
    }).from(agentContracts).where(eq(agentContracts.id, run.contractId)).get();
    return contract?.landingStatus !== 'abandoned' ||
      !isMatchingWorktreeAbandonmentTeardown(
        contract.abandonmentReceipt,
        contract.abandonmentTeardownReceipt,
      );
  });
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

/** Recovery-view dismissal. Idempotent (first dismissal wins) and does NOT
 *  bump `rev` — dismissal is a recovery-projection concern, not a run
 *  lifecycle transition. Eligibility (terminal + no worktree + no sealed
 *  deliverable) is enforced by the caller before this door is reached. */
export function dismissAgentRun(id: ULID, at: number): void {
  getDb()
    .update(agentRuns)
    .set({ dismissedAt: at })
    .where(and(eq(agentRuns.id, id), sql`${agentRuns.dismissedAt} IS NULL`))
    .run();
}

// Step 2 (2026-06-03) — the boot-time bulk-fail sweeps (`reconcileOrphanedRunningRuns`,
// `listAndReconcileOrphanedRuns`) are DELETED. They flipped rows terminal with a raw
// UPDATE — bypassing the one terminal authority — and killed `paused` rows (FD-14
// violation). The agent-run reconciler loop (apps/server agent-run-reconciler.ts)
// owns orphan detection now; every finalize routes through applyAgentRunTerminalEffects.
