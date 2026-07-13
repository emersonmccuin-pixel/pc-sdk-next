// Agent-run mutation gateway (slice 005) — the single durable write door for
// agent_runs status/terminal transitions the UI cares about. Mirrors the
// slice-003 WorkItemMutationGateway / slice-004 WorkflowRunMutationGateway.
//
// Pattern (slice 002/003/004):
//   run a caller-supplied product mutation -> insert a live_outbox row in the
//   SAME getDb().transaction -> re-read the post-write row for the correct rev
//   -> return a publication the server composition layer fans out as the new
//   `resource` frame (entity 'agent-run', eventType 'agent-run.changed') AFTER
//   commit. A rollback emits nothing.
//
// Boundary purity: imports only @pc/contracts, @pc/db, @pc/domain (+ the local
// adapters). No Hono, React, websocket hub, Channel, MCP SDK, or runtime
// process classes (AgentRun, host client). Fanout (broadcast) and the runtime/
// delivery side effects are wired at the server composition layer; the gateway
// owns ONLY the durable DB transition + the outbox fact.

import type {
  AgentRunChangedLivePayload,
  AgentRunChangedReason,
  AgentRunDto,
} from '@pc/contracts';
import {
  createPendingAsk as defaultCreatePendingAsk,
  getAgentRunRow as defaultGetAgentRunRow,
  getDb,
  insertLiveEvent,
  markAgentRunTerminal as defaultMarkAgentRunTerminal,
  markPendingAskAnswered as defaultMarkPendingAskAnswered,
  markPendingAskCancelled as defaultMarkPendingAskCancelled,
  setAgentRunPhaseReceiptInDb,
  setReviewAgentRunPhaseReceiptInDb,
  setReviewCheckoutPhaseReceiptInDb,
  transitionAgentRunLifecycleInDb,
  updateAgentRunStatus as defaultUpdateAgentRunStatus,
  type CreatePendingAskInput,
  type DbExecutor,
  type InsertLiveEventDraft,
  type LiveOutboxEvent,
  type MarkAgentRunTerminalInput,
  type SetReviewCheckoutPhaseReceiptInput,
  type UpdateAgentRunStatusInput,
} from '@pc/db';
import {
  reviewCheckoutPhaseMatchesRun,
  type AgentRunFailureCause,
  type AgentRunRow,
  type AgentRunStatus,
  type ReviewCheckout,
  type RunLifecycleState,
  type ULID,
  type WorktreePhaseReceipt,
} from '@pc/domain';
import { toAgentRunDto } from './adapters.ts';

export interface AgentRunChangedPublication {
  liveEvent: LiveOutboxEvent<AgentRunChangedLivePayload>;
  run: AgentRunDto;
}

export interface ReviewCheckoutPhasePublication extends AgentRunChangedPublication {
  checkout: ReviewCheckout;
}

const TERMINAL: ReadonlySet<AgentRunStatus> = new Set(['completed', 'failed', 'cancelled']);

export function buildAgentRunChangedDraft(input: {
  reason: AgentRunChangedReason;
  run: AgentRunDto;
  pendingAskId?: ULID | null;
}): InsertLiveEventDraft<AgentRunChangedLivePayload> {
  return buildDraft(input.reason, input.run, input.pendingAskId);
}

export interface AgentRunGatewayDeps {
  /** Single transaction door. Defaults to the live DB; tests inject a fake. */
  transaction?: <T>(fn: (tx: DbExecutor) => T) => T;
  /** Insert a live-outbox row inside the transaction. Defaults to @pc/db. */
  insertLiveEvent?: typeof insertLiveEvent;
  /** Read a run row by id. Overridable for tests. */
  getRun?: (id: ULID) => AgentRunRow | null;
  updateStatus?: (input: UpdateAgentRunStatusInput) => boolean;
  markTerminal?: (input: MarkAgentRunTerminalInput) => boolean;
  createPendingAsk?: (input: CreatePendingAskInput) => unknown;
  markPendingAskAnswered?: typeof defaultMarkPendingAskAnswered;
  markPendingAskCancelled?: typeof defaultMarkPendingAskCancelled;
}

export class AgentRunMutationGateway {
  private readonly tx: <T>(fn: (tx: DbExecutor) => T) => T;
  private readonly insert: typeof insertLiveEvent;
  private readonly getRun: (id: ULID) => AgentRunRow | null;
  private readonly updateStatus: (input: UpdateAgentRunStatusInput) => boolean;
  private readonly markTerminal: (input: MarkAgentRunTerminalInput) => boolean;
  private readonly createPendingAsk: (input: CreatePendingAskInput) => unknown;
  private readonly markAnswered: typeof defaultMarkPendingAskAnswered;
  private readonly markCancelled: typeof defaultMarkPendingAskCancelled;

  constructor(deps: AgentRunGatewayDeps = {}) {
    this.tx = deps.transaction ?? ((fn) => getDb().transaction(fn));
    this.insert = deps.insertLiveEvent ?? insertLiveEvent;
    this.getRun = deps.getRun ?? ((id) => defaultGetAgentRunRow(id));
    this.updateStatus = deps.updateStatus ?? defaultUpdateAgentRunStatus;
    this.markTerminal = deps.markTerminal ?? defaultMarkAgentRunTerminal;
    this.createPendingAsk = deps.createPendingAsk ?? defaultCreatePendingAsk;
    this.markAnswered = deps.markPendingAskAnswered ?? defaultMarkPendingAskAnswered;
    this.markCancelled = deps.markPendingAskCancelled ?? defaultMarkPendingAskCancelled;
  }

  /** Run a product mutation that returns the changed run row + record the
   *  matching agent-run.changed resource fact atomically. The fact's rev comes
   *  from the row the mutation returns (the post-write row). */
  commitRunChange(input: {
    reason: AgentRunChangedReason;
    mutate: (tx: DbExecutor) => AgentRunRow | null;
    worktreeDir?: string;
    startedAt?: number;
    pendingAskId?: ULID | null;
  }): AgentRunChangedPublication {
    return this.tx((tx) => {
      const row = input.mutate(tx);
      if (!row) throw new Error('agent run mutation produced no row');
      const run = toAgentRunDto(row, {
        ...(input.worktreeDir !== undefined ? { worktreeDir: input.worktreeDir } : {}),
        ...(input.startedAt !== undefined ? { startedAt: input.startedAt } : {}),
      });
      const draft = buildDraft(input.reason, run, input.pendingAskId);
      const liveEvent = this.insert(tx, draft);
      return { liveEvent, run };
    });
  }

  /** Commit a generic builder phase plus its versioned agent-run fact. */
  commitPhaseReceipt(input: {
    runId: ULID;
    receipt: WorktreePhaseReceipt;
  }): AgentRunChangedPublication | null {
    return this.tx((tx) => {
      const row = setAgentRunPhaseReceiptInDb(input.runId, input.receipt, tx);
      if (!row) return null;
      const run = toAgentRunDto(row);
      const liveEvent = this.insert(tx, buildDraft('reconciled', run));
      return { liveEvent, run };
    });
  }

  /** Coordinate the agent-run and review-workspace owners without moving
   * either state machine into the other repository. The run rev, both copies
   * of phase evidence, and the replayable agent-run fact commit together. */
  commitReviewCheckoutPhaseReceipt(
    input: SetReviewCheckoutPhaseReceiptInput,
  ): ReviewCheckoutPhasePublication | null {
    return this.tx((tx) => {
      const row = setReviewAgentRunPhaseReceiptInDb(
        input.authority.reviewerRunId,
        input.receipt,
        tx,
      );
      if (!row) return null;
      const checkout = setReviewCheckoutPhaseReceiptInDb(input, tx);
      if (!checkout) {
        throw new Error('review checkout phase CAS failed after reviewer phase write');
      }
      const phase = input.receipt.evidence.phase;
      const checkoutReceipt = phase === 'preparation'
        ? checkout.preparationReceipt
        : checkout.readinessReceipt;
      const runReceipt = phase === 'preparation'
        ? row.preparationReceipt
        : row.readinessReceipt;
      if (!reviewCheckoutPhaseMatchesRun(checkout, checkoutReceipt, runReceipt, phase)) {
        throw new Error('review checkout phase evidence diverged inside its atomic write');
      }
      const run = toAgentRunDto(row);
      const liveEvent = this.insert(tx, buildDraft('reconciled', run));
      return { liveEvent, run, checkout };
    });
  }

  /** Move a settled repository run through one exact lifecycle edge and
   * publish the matching versioned fact in the same transaction. Recovery
   * callers use this instead of a write followed by a separately committed
   * announcement, so a crash cannot leave the durable row and outbox split. */
  commitLifecycleTransition(input: {
    runId: ULID;
    expectedFrom: RunLifecycleState;
    to: RunLifecycleState;
  }): AgentRunChangedPublication | null {
    return this.tx((tx) => {
      const row = transitionAgentRunLifecycleInDb({
        id: input.runId,
        expectedFrom: input.expectedFrom,
        to: input.to,
      }, tx);
      if (!row) return null;
      const run = toAgentRunDto(row);
      const liveEvent = this.insert(tx, buildDraft('reconciled', run));
      return { liveEvent, run };
    });
  }

  /** Record a run fact when the product mutation already happened (used by the
   *  state-transition broadcast sites after a repo write). Re-reads the row so
   *  the fact carries the post-write rev (closes the stale-rev issue). */
  announceRunChange(input: {
    runId: ULID;
    reason: AgentRunChangedReason;
    worktreeDir?: string;
    startedAt?: number;
    pendingAskId?: ULID | null;
  }): AgentRunChangedPublication | null {
    const row = this.getRun(input.runId);
    if (!row) return null;
    return this.commitRunChange({
      reason: input.reason,
      mutate: () => row,
      ...(input.worktreeDir !== undefined ? { worktreeDir: input.worktreeDir } : {}),
      ...(input.startedAt !== undefined ? { startedAt: input.startedAt } : {}),
      ...(input.pendingAskId !== undefined ? { pendingAskId: input.pendingAskId } : {}),
    });
  }

  /** Pause: write the open pending-ask + the `paused` run transition + the
   *  durable fact (reason:'paused', pendingAskId) in one tx. The runtime
   *  markPaused + the agent-asks-* delivery are post-commit (caller's job). */
  pauseRun(input: {
    pendingAsk: CreatePendingAskInput;
    worktreeDir?: string;
    startedAt?: number;
  }): AgentRunChangedPublication {
    return this.commitRunChange({
      reason: 'paused',
      pendingAskId: input.pendingAsk.id,
      ...(input.worktreeDir !== undefined ? { worktreeDir: input.worktreeDir } : {}),
      ...(input.startedAt !== undefined ? { startedAt: input.startedAt } : {}),
      mutate: () => {
        this.createPendingAsk(input.pendingAsk);
        if (!this.updateStatus({ id: input.pendingAsk.agentRunId, status: 'paused' })) {
          throw new Error('agent run became terminal before pause');
        }
        return this.getRun(input.pendingAsk.agentRunId);
      },
    });
  }

  /** Answer: atomic open->answered flip + persist `spawning`
   *  + emit the fact (reason:'resumed') in one tx. Returns null (emits nothing)
   *  if the atomic flip was a no-op (already answered/cancelled/replayed).
   *  Resumability MUST be validated by the caller BEFORE this call. */
  answerAndResume(input: {
    pendingAskId: ULID;
    agentRunId: ULID;
    answer: string;
    answeredBy: 'orchestrator' | 'user';
    now: number;
    worktreeDir?: string;
    startedAt?: number;
  }): AgentRunChangedPublication | null {
    return this.tx((tx) => {
      const flipped = this.markAnswered({
        id: input.pendingAskId,
        answer: input.answer,
        answeredBy: input.answeredBy,
        now: input.now,
      });
      if (!flipped) return null;
      if (!this.updateStatus({
        id: input.agentRunId,
        status: 'spawning',
        spawnedAt: input.now,
      })) throw new Error('agent run became terminal before answer resume');
      const row = this.getRun(input.agentRunId);
      if (!row) throw new Error('agent run mutation produced no row');
      const run = toAgentRunDto(row, {
        ...(input.worktreeDir !== undefined ? { worktreeDir: input.worktreeDir } : {}),
        ...(input.startedAt !== undefined ? { startedAt: input.startedAt } : {}),
      });
      const liveEvent = this.insert(tx, buildDraft('resumed', run));
      return { liveEvent, run };
    });
  }

  /** Cancel: finalize the run row to `cancelled` durably (+ cancel an open ask)
   *  EVEN WHEN no registry handle exists (phantom paused run). Terminal runs are
   *  a no-op (returns null, emits nothing). The best-effort runtime cancel /
   *  pid-kill is the caller's post-commit job. Phantom-safe. */
  cancelRun(input: {
    runId: ULID;
    now: number;
    failureCause?: AgentRunFailureCause | null;
    failureReason?: string | null;
    cancelOpenAsk?: ULID | null;
    /** Worktree-pipeline stamp (guarded in @pc/db). Omit for null-lifecycle rows. */
    lifecycleState?: RunLifecycleState;
    worktreeDir?: string;
    startedAt?: number;
  }): AgentRunChangedPublication | null {
    const existing = this.getRun(input.runId);
    if (!existing) return null;
    if (TERMINAL.has(existing.status)) return null;
    return this.commitRunChange({
      reason: 'cancelled',
      ...(input.worktreeDir !== undefined ? { worktreeDir: input.worktreeDir } : {}),
      ...(input.startedAt !== undefined ? { startedAt: input.startedAt } : {}),
      mutate: () => {
        if (input.cancelOpenAsk) this.markCancelled(input.cancelOpenAsk, input.now);
        this.markTerminal({
          id: input.runId,
          status: 'cancelled',
          result: null,
          failureCause: input.failureCause ?? 'cancelled',
          failureReason: input.failureReason ?? 'run cancelled',
          completedAt: input.now,
          ...(input.lifecycleState !== undefined ? { lifecycleState: input.lifecycleState } : {}),
        });
        return this.getRun(input.runId);
      },
    });
  }

  /** Terminal: record a completed/failed/cancelled transition + fact in one tx.
   *  Idempotent — a no-op (already terminal) returns null and emits nothing. The
   *  markTerminal call mirrors `applyAgentRunTerminalEffects`'s row flip. */
  commitTerminal(input: {
    runId: ULID;
    status: Extract<AgentRunStatus, 'completed' | 'failed' | 'cancelled'>;
    result: string | null;
    failureCause: AgentRunFailureCause | null;
    failureReason: string | null;
    completedAt: number;
    /** Exact runtime attempt for async terminal callbacks. Omit for user/app
     * control such as kill or boot recovery. */
    continuationAttemptId?: string;
    /** Worktree-pipeline stamp (guarded in @pc/db). Omit for null-lifecycle
     *  rows and for repo completions (verify/land continue past terminal). */
    lifecycleState?: RunLifecycleState;
    worktreeDir?: string;
    startedAt?: number;
  }): AgentRunChangedPublication | null {
    return this.tx((tx) => {
      const changed = this.markTerminal({
        id: input.runId,
        status: input.status,
        result: input.result,
        failureCause: input.failureCause,
        failureReason: input.failureReason,
        completedAt: input.completedAt,
        ...(input.continuationAttemptId !== undefined
          ? { continuationAttemptId: input.continuationAttemptId }
          : {}),
        ...(input.lifecycleState !== undefined ? { lifecycleState: input.lifecycleState } : {}),
      });
      if (!changed) return null;
      const row = this.getRun(input.runId);
      if (!row) throw new Error('agent run terminal mutation produced no row');
      const run = toAgentRunDto(row, {
        ...(input.worktreeDir !== undefined ? { worktreeDir: input.worktreeDir } : {}),
        ...(input.startedAt !== undefined ? { startedAt: input.startedAt } : {}),
      });
      const liveEvent = this.insert(tx, buildDraft(input.status, run));
      return { liveEvent, run };
    });
  }
}

function buildDraft(
  reason: AgentRunChangedReason,
  run: AgentRunDto,
  pendingAskId?: ULID | null,
): InsertLiveEventDraft<AgentRunChangedLivePayload> {
  const payload: AgentRunChangedLivePayload = { reason, run };
  if (pendingAskId !== undefined) payload.pendingAskId = pendingAskId;
  return {
    scope: 'project',
    projectId: run.projectId as ULID,
    type: 'agent-run.changed',
    entity: 'agent-run',
    entityId: run.runId as ULID,
    version: run.rev,
    payload,
  };
}

export { TERMINAL as AGENT_RUN_TERMINAL_STATUSES };
