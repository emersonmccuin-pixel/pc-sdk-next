// Agent-run contract family (slice 005). Browser-safe, zero runtime deps.
//
// Owns `AgentRunDto` (browser-safe mirror of the agent-run row) and the
// canonical agent-run resource payload (`{ reason, run, pendingAskId? }`) that
// rides the new `resource` frame (see events/resources.ts) as the full-snapshot
// payload for the `agent-run` entity. Agent-run resource events are
// PROJECT-scoped; the frame's `version` carries `agent_runs.rev`.

import { type ULID } from './shared.ts';

export const AGENT_RUN_STATUSES = [
  'queued',
  'spawning',
  'running',
  'paused',
  'completed',
  'failed',
  'cancelled',
] as const;
export type AgentRunStatus = (typeof AGENT_RUN_STATUSES)[number];

/** Browser-safe mirror of the agent-run row. */
export interface AgentRunDto {
  runId: ULID;
  /** = ccSessionId. */
  sessionId: string;
  agentName: string;
  model: string;
  projectId: ULID;
  dispatcherSessionId: string;
  worktreeDir: string;
  startedAt: number;
  status: AgentRunStatus;
  result: string;
  failureReason: string | null;
  failureCause: string | null;
  endedAt: number | null;
  /** Monotonic write counter (agent_runs.rev). */
  rev: number;
}

// ── Canonical resource payload (agent-run entity, full snapshot) ─────────────

export type AgentRunChangedReason =
  | 'queued'
  | 'spawning'
  | 'running'
  | 'paused'
  | 'resumed'
  // T2.2 — non-terminal watchdog warn: the run is quiet past WARN_MS but not yet
  // killed. Status stays `running`/`spawning`; the frame just flips a UI badge.
  | 'stalled'
  | 'completed'
  | 'failed'
  | 'cancelled'
  | 'reconciled';

export const AGENT_RUN_CHANGED_REASONS: readonly AgentRunChangedReason[] = [
  'queued',
  'spawning',
  'running',
  'paused',
  'resumed',
  'stalled',
  'completed',
  'failed',
  'cancelled',
  'reconciled',
];

export interface AgentRunChangedLivePayload {
  reason: AgentRunChangedReason;
  /** Full snapshot with the current rev. */
  run: AgentRunDto;
  /** Set on `reason:'paused'`. */
  pendingAskId?: ULID | null;
}

// ── Guards ───────────────────────────────────────────────────────────────────

export function isAgentRunStatus(value: unknown): value is AgentRunStatus {
  return typeof value === 'string' && (AGENT_RUN_STATUSES as readonly string[]).includes(value);
}

export function isAgentRunChangedReason(value: unknown): value is AgentRunChangedReason {
  return (
    typeof value === 'string' &&
    (AGENT_RUN_CHANGED_REASONS as readonly string[]).includes(value)
  );
}

export function isAgentRunDto(value: unknown): value is AgentRunDto {
  if (!isRecord(value)) return false;
  return (
    typeof value.runId === 'string' &&
    typeof value.sessionId === 'string' &&
    typeof value.agentName === 'string' &&
    typeof value.model === 'string' &&
    typeof value.projectId === 'string' &&
    typeof value.dispatcherSessionId === 'string' &&
    typeof value.worktreeDir === 'string' &&
    typeof value.startedAt === 'number' &&
    isAgentRunStatus(value.status) &&
    typeof value.result === 'string' &&
    (value.failureReason === null || typeof value.failureReason === 'string') &&
    (value.failureCause === null || typeof value.failureCause === 'string') &&
    (value.endedAt === null || typeof value.endedAt === 'number') &&
    typeof value.rev === 'number'
  );
}

export function isAgentRunChangedLivePayload(
  value: unknown,
): value is AgentRunChangedLivePayload {
  if (!isRecord(value) || !isAgentRunChangedReason(value.reason)) return false;
  if (!isAgentRunDto(value.run)) return false;
  if (
    value.pendingAskId !== undefined &&
    value.pendingAskId !== null &&
    typeof value.pendingAskId !== 'string'
  ) {
    return false;
  }
  return true;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}
