// Channel 3 — Latency-class broadcasts (no replay; HTTP heals).
// See docs/event-contract.md. Browser-safe, zero runtime deps.

import type { ULID } from '../shared.ts';
import { isChatEvent, type ChatEvent } from './chat.ts';

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
  activeTurnId: string | null;
  health: OrchestratorHealth;
  queueDepth: number;
  failureReason: string | null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function hasOnlyKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  const allowed = new Set(keys);
  return Object.keys(value).every((key) => allowed.has(key));
}

export function isAgentEventFrame(value: unknown): value is AgentEventFrame {
  return (
    isRecord(value) &&
    hasOnlyKeys(value, ['type', 'projectId', 'runId', 'event', 'dedupId']) &&
    value.type === 'agent-event' &&
    typeof value.projectId === 'string' &&
    value.projectId.length > 0 &&
    typeof value.runId === 'string' &&
    value.runId.length > 0 &&
    isChatEvent(value.event) &&
    typeof value.dedupId === 'string' &&
    value.dedupId.length > 0
  );
}

export function isOrchestratorHealth(value: unknown): value is OrchestratorHealth {
  return (
    value === 'idle' || value === 'starting' || value === 'busy' || value === 'failed'
  );
}

export function isOrchestratorStateFrame(value: unknown): value is OrchestratorStateFrame {
  return (
    isRecord(value) &&
    hasOnlyKeys(value, [
      'type',
      'projectId',
      'sessionId',
      'activeTurnId',
      'health',
      'queueDepth',
      'failureReason',
    ]) &&
    value.type === 'orchestrator-state' &&
    typeof value.projectId === 'string' &&
    value.projectId.length > 0 &&
    (value.sessionId === null || (typeof value.sessionId === 'string' && value.sessionId.length > 0)) &&
    (value.activeTurnId === null || (typeof value.activeTurnId === 'string' && value.activeTurnId.length > 0)) &&
    isOrchestratorHealth(value.health) &&
    Number.isSafeInteger(value.queueDepth) &&
    (value.queueDepth as number) >= 0 &&
    (value.failureReason === null || typeof value.failureReason === 'string')
  );
}
