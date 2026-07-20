// Section 25 — agent system domain types (post-Phase-E bare names).
//
// Persisted shapes for the agent dispatch + pause + delivery layer. Mirrors
// the `agent_runs` / `pending_asks` / `agent_inbox` / `agent_delivery_audit`
// tables in `@pc/db`. Wire-level event kinds + payloads live in
// `agent-comms.ts` (`AgentChannelEventKind` etc.).

import type { ULID } from './ulid.ts';
import type { PendingAskOption } from './agent-comms.ts';
import type { RunLifecycleState } from './run-lifecycle.ts';
import type { WorktreeGitReceipt, WorktreePhaseReceipt } from './worktree.ts';

/** One context document frozen into the exact specialist execution package. */
export interface SpecialistContextSnapshot {
  id: ULID;
  title: string;
  body: string;
  updatedAt: number;
}

/**
 * Run-owned, provider-neutral specialist material consumed by dispatch.
 * Contracts freeze expected output separately and RuntimeSelection freezes
 * model/effort, so neither is duplicated here. Secrets and native provider
 * configuration are deliberately excluded.
 */
export interface SpecialistExecutionSnapshot {
  specialistId: ULID;
  revision: string;
  name: string;
  charter: string;
  contextDocs: SpecialistContextSnapshot[];
  maxTurns: number;
}

export type AgentRunSelectionState = 'stamped' | 'legacy-unavailable';
export type AgentRunEffortState = 'selected' | 'none' | 'unavailable' | 'legacy-unknown';
export type AgentRunSnapshotState = 'stamped' | 'legacy-unavailable';
export type AgentRunNativeIdentityState = 'unbound' | 'bound' | 'legacy-untrusted';
export type AgentRunContinuationState =
  | 'clean-pending'
  | 'clean-started'
  | 'resume-pending'
  | 'native-resumed'
  | 'resume-failed'
  | 'legacy-unavailable';

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function hasOnlyKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  const allowed = new Set(keys);
  return Object.keys(value).every((key) => allowed.has(key));
}

function exactNonEmpty(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && value === value.trim();
}

function isSpecialistContextSnapshot(value: unknown): value is SpecialistContextSnapshot {
  return isRecord(value) &&
    hasOnlyKeys(value, ['id', 'title', 'body', 'updatedAt']) &&
    exactNonEmpty(value.id) &&
    exactNonEmpty(value.title) &&
    typeof value.body === 'string' &&
    Number.isSafeInteger(value.updatedAt) &&
    (value.updatedAt as number) >= 0;
}

export function isSpecialistExecutionSnapshot(
  value: unknown,
): value is SpecialistExecutionSnapshot {
  return isRecord(value) &&
    hasOnlyKeys(value, [
      'specialistId',
      'revision',
      'name',
      'charter',
      'contextDocs',
      'maxTurns',
    ]) &&
    exactNonEmpty(value.specialistId) &&
    exactNonEmpty(value.revision) &&
    exactNonEmpty(value.name) &&
    typeof value.charter === 'string' &&
    Array.isArray(value.contextDocs) &&
    value.contextDocs.every(isSpecialistContextSnapshot) &&
    new Set(value.contextDocs.map((doc) => doc.id)).size === value.contextDocs.length &&
    Number.isSafeInteger(value.maxTurns) &&
    (value.maxTurns as number) >= 1;
}

/** Full in-memory state machine, persisted 1:1. */
export type AgentRunStatus =
  | 'queued'
  | 'spawning'
  | 'running'
  | 'paused'
  | 'completed'
  | 'failed'
  | 'cancelled';

export const AGENT_RUN_STATUSES: readonly AgentRunStatus[] = [
  'queued',
  'spawning',
  'running',
  'paused',
  'completed',
  'failed',
  'cancelled',
];

/** Coarse failure taxonomy. The wrapper picks one at terminal-failed; the
 *  route layer never invents new ones (preserves the closed-world property). */
export type AgentRunFailureCause =
  | 'spawn-stuck'
  /** ☠ HISTORICAL ONLY (Step 8/FD-17): no live writer — idle-kill is deleted.
   *  Kept so pre-P9 terminal rows still type/display. */
  | 'idle-timeout'
  | 'wall-clock-timeout'
  | 'ready-timeout'
  | 'spawn-error'
  | 'send-failed'
  | 'unexpected-exit'
  | 'cancel-while-queued'
  | 'cancelled'
  | 'mcp-handshake-never'
  | 'kill-during-spawn'
  | 'server-restart'
  | 'host-unavailable'
  | 'host-lost'
  | 'host-crashed'
  | 'host-protocol-error'
  /** The host was reachable and ANSWERED, but rejected the command (e.g. a
   *  genuine run-id/cc-session collision). Distinct from 'host-unavailable'
   *  (no answer at all) — conflating the two produced the misleading
   *  "run already exists / host-unavailable" spawn error (2026-06-10). */
  | 'host-rejected'
  /** Workflow-engine redesign — the dispatched worker reached a terminal
   *  WITHOUT submitting a deliverable against its contract. Delivery is the
   *  sole done-signal; ending a turn / exiting with nothing delivered is a
   *  failure with a reason, not a silent "completed-but-empty". */
  | 'no-deliverable'
  /** Tool-bridge-less delivery door (Codex et al.): a deliverable FILE was
   *  present at the worktree root but could not be honored — malformed JSON,
   *  a shape/kind mismatch the canonical validation rejected, or the signal
   *  file could not be removed before the sealed commit. A typed failure with
   *  the validation reason, never a silent no-deliverable. */
  | 'invalid-deliverable'
  /** Contract invariant: the dispatch was aborted because the contract could
   *  not be resolved or created. A run must ALWAYS have a contract before the
   *  agent spawns; if one can't be guaranteed the dispatch is refused. */
  | 'contract-required'
  /** Isolation invariant: the dispatch declared `isolation: "worktree"` but
   *  the worktree provisioning step failed. Never fall back to the main repo. */
  | 'worktree-provision-failed'
  /** Another cooperating engine positively owns the canonical Git repository.
   *  No repository-writing phase may start or continue in this process. */
  | 'repository-occupied'
  /** Canonical repository identity or its lease authority could not be proven.
   *  Missing, drifted, corrupt, unsupported, or inconclusive state fails closed. */
  | 'repository-unavailable'
  /** The runtime hit its turn budget (SDK `error_max_turns` / a sibling
   *  `error_max_budget_usd`) — a real terminal result, NOT a crash. Distinct
   *  from `unexpected-exit` so the run is resumable, not misreported. */
  | 'turn-budget-exhausted';

export const AGENT_RUN_FAILURE_CAUSES: readonly AgentRunFailureCause[] = [
  'spawn-stuck',
  'idle-timeout',
  'wall-clock-timeout',
  'ready-timeout',
  'spawn-error',
  'send-failed',
  'unexpected-exit',
  'cancel-while-queued',
  'cancelled',
  'mcp-handshake-never',
  'kill-during-spawn',
  'server-restart',
  'host-unavailable',
  'host-lost',
  'host-crashed',
  'host-protocol-error',
  'host-rejected',
  'no-deliverable',
  'invalid-deliverable',
  'contract-required',
  'worktree-provision-failed',
  'repository-occupied',
  'repository-unavailable',
  'turn-budget-exhausted',
];

/** One persisted agent_runs row. Mirrors the in-memory AgentRunRecord plus
 *  drift-detection fields and explicit lifecycle timestamps. */
export interface AgentRunRow {
  id: ULID;
  projectId: ULID;
  /** PC session-id (ULID) of the orchestrator (or other AgentRun) that
   *  dispatched this run. */
  dispatcherSessionId: string;
  /** Immutable run-owned specialist package. Null only on migrated rows whose
   * execution-effective revision cannot be reconstructed honestly. */
  snapshotState: AgentRunSnapshotState;
  specialistSnapshot: SpecialistExecutionSnapshot | null;
  /** Adapter-native identity. New clean runs bind it from one exact positive
   * receipt; continuations inherit only a positively bound parent identity. */
  nativeSessionId: string | null;
  nativeIdentityState: AgentRunNativeIdentityState;
  continuationState: AgentRunContinuationState;
  /** Durable generation fence for the currently authorized native mint. */
  continuationAttemptId: string | null;
  podName: string;
  status: AgentRunStatus;
  /** Worktree-pipeline state (docs/worktree-lifecycle.md 'Lifecycle states'),
   *  layered beside `status` (which stays authoritative for dispatch).
   *  NULL = legacy/non-repo run — no lifecycle vocabulary applies. */
  lifecycleState: RunLifecycleState | null;
  /** Self-FK to parent run for continuations. */
  continues: ULID | null;
  parentInvokeDepth: number;
  /** External PM-item ref (AInativePM over MCP), or null. Replaces the dead
   *  internal work-item FK — PM lives outside this app now. */
  pmRef: string | null;
  /** Slice 013 — FK to the first-class `agent_contracts` row this run produces.
   *  NULL for legacy/non-contract dispatches + un-backfilled rows. */
  contractId: ULID | null;
  /** Verbatim initial input. NULL on resumes that carry no new input. */
  input: string | null;
  /** Final assistant text. NULL until terminal-completed. */
  result: string | null;
  failureCause: AgentRunFailureCause | null;
  failureReason: string | null;
  queuedAt: number;
  spawnedAt: number | null;
  readyAt: number | null;
  /** OS pid of the spawned claude.exe (in-process path). Persisted at spawn so
   *  the liveness sweep can probe process existence and hard-kill can target the
   *  real process. NULL before spawn / host-mode runs. */
  pid: number | null;
  /** Epoch-ms of the last observed JSONL activity. Drives the stall ladder's
   *  idle computation (badge → verify-alive → notify — never a kill).
   *  NULL until the first event lands. */
  lastActivityAt: number | null;
  /** Workflow-engine redesign — epoch-ms when the worker submitted its
   *  deliverable (`pc_submit_deliverable`). The positive done-receipt: a run
   *  with a contract but no `deliveredAt` that reaches a terminal is a
   *  `no-deliverable` failure. NULL until/unless a deliverable is submitted. */
  deliveredAt: number | null;
  completedAt: number | null;
  /** Monotonic write counter. Incremented by every status transition so WS
   *  deltas can carry a version the frontend uses to discard stale delivery. */
  rev: number;
  /** Absolute path to the worktree directory the agent was spawned in. Used to
   *  compute the correct CC JSONL path (CC keys its projects/ dir off the spawn
   *  cwd). NULL for rows created before this column was added — callers fall back
   *  to `project.folderPath` when null. */
  worktreeDir: string | null;
  /** Repo dispatch provenance. NULL for non-repo and legacy rows. */
  worktreeBaseBranch: string | null;
  worktreeBaseSha: string | null;
  /** Provisioning receipts (docs/worktree-lifecycle.md 'Provisioning and
   *  readiness'). New repository builder runs always carry both phase
   *  receipts before runtime mint, including explicit no-ops. NULL remains
   *  valid only for non-repo, detached-review, and historical/incomplete
   *  rows. */
  gitReceipt: WorktreeGitReceipt | null;
  preparationReceipt: WorktreePhaseReceipt | null;
  readinessReceipt: WorktreePhaseReceipt | null;
  /** Runtime-selection stamp (agent-runtime architecture guard rule 2). */
  selectionState: AgentRunSelectionState;
  runtimeId: string | null;
  accountId: string | null;
  model: string | null;
  effortState: AgentRunEffortState;
  effort: string | null;
  /** Bounded auto-continue on turn-budget exhaustion (max-turns fix part 2):
   *  how many automatic continuations preceded THIS run in its chain. 0 for a
   *  fresh dispatch or a manual `pc_continue_agent`; N+1 for an
   *  auto-continuation of a run whose own count was N. Durable so the ceiling
   *  (MAX_AUTO_CONTINUES) survives a server restart mid-chain. */
  autoContinueCount: number;
}

/** Pending-ask kind. ☠ M7 (FD-6, 2026-06-04) — `'user'` deleted with
 *  `pc_ask_user`: ONE ask door, agents only ask the orchestrator. Historical
 *  rows with `kind='user'` may exist in old DBs; reads stay tolerant. */
export type PendingAskKind = 'orchestrator' | 'approval';

export const PENDING_ASK_KINDS: readonly PendingAskKind[] = [
  'orchestrator',
  'approval',
];

export type PendingAskStatus = 'open' | 'answered' | 'cancelled';

export const PENDING_ASK_STATUSES: readonly PendingAskStatus[] = [
  'open',
  'answered',
  'cancelled',
];

export interface PendingAskRow {
  id: ULID;
  agentRunId: ULID;
  projectId: ULID;
  /** External PM-item ref (AInativePM over MCP), or null. Replaces the dead
   *  internal work-item FK. */
  pmRef: string | null;
  kind: PendingAskKind;
  promptBody: string;
  context: string | null;
  /** Multi-choice for `approval` (always populated) and optional for
   *  `orchestrator` asks. */
  options: PendingAskOption[] | null;
  status: PendingAskStatus;
  answerBody: string | null;
  answeredBy: 'orchestrator' | 'user' | null;
  createdAt: number;
  answeredAt: number | null;
  cancelledAt: number | null;
}

/** Inbox event-kind set. Superset of the wire `AgentChannelEventKind` —
 *  adds `agent-run-changed` + `agent-jsonl-event` for Activity Panel
 *  consumers. ☠ M7 (FD-6) — `agent-asks-user` deleted with `pc_ask_user`. */
export type AgentInboxEventKind =
  | 'agent-asks-orchestrator'
  | 'agent-approval-request'
  | 'agent-completed'
  | 'agent-failed'
  | 'agent-queued-started'
  | 'agent-run-changed'
  | 'agent-jsonl-event';

export const AGENT_INBOX_EVENT_KINDS: readonly AgentInboxEventKind[] = [
  'agent-asks-orchestrator',
  'agent-approval-request',
  'agent-completed',
  'agent-failed',
  'agent-queued-started',
  'agent-run-changed',
  'agent-jsonl-event',
];

// ☠ M4a (2026-06-04) — AgentInboxStatus/Driver/Row + AgentDeliveryAuditRow
// deleted with the `agent_inbox` tables (migration 0041 archive). The
// AgentInboxEventKind union above SURVIVES — it names the envelope kinds the
// mailbox delivery path still routes (deliverAgentEnvelope).
