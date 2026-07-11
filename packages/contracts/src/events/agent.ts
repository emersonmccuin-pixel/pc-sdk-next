// Channel 3 — Latency-class broadcasts (no replay; HTTP heals).
// See docs/event-contract.md. Browser-safe, zero runtime deps.

import type { ULID } from '../shared.ts';
import type { ChatEvent } from './chat.ts';

/** Agent transcript streaming. Reuses ChatEvent — one render pipeline for
 *  orchestrator chat and agent run views. Missed frames heal on modal open via
 *  HTTP backfill, merged by `dedupId`. */
export interface AgentEventFrame {
  type: 'agent-event';
  projectId: ULID;
  runId: ULID;
  event: ChatEvent;
  /** Stable canonical conversation event id. */
  dedupId: string;
}

export type OrchestratorHealth = 'idle' | 'starting' | 'busy' | 'failed';

/** Latest-wins, no dedup key. The whole shape — the PTY-era snapshot is dead. */
export interface OrchestratorStateFrame {
  type: 'orchestrator-state';
  projectId: ULID;
  sessionId: string | null;
  health: OrchestratorHealth;
  queueDepth: number;
  failureReason: string | null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

export function isOrchestratorHealth(value: unknown): value is OrchestratorHealth {
  return (
    value === 'idle' || value === 'starting' || value === 'busy' || value === 'failed'
  );
}

export function isOrchestratorStateFrame(value: unknown): value is OrchestratorStateFrame {
  return (
    isRecord(value) &&
    value.type === 'orchestrator-state' &&
    (value.sessionId === null || typeof value.sessionId === 'string') &&
    isOrchestratorHealth(value.health) &&
    typeof value.queueDepth === 'number' &&
    (value.failureReason === null || typeof value.failureReason === 'string')
  );
}
