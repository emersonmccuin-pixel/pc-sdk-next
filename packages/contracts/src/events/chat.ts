// Channel 1 — Chat (durable, per-session seq). See docs/event-contract.md.
//
// The chat spine: every content event the server persists to conversation_events
// and broadcasts, plus the ephemeral streaming-delta frame that rides outside
// the seq'd store. Browser-safe, zero runtime deps.

import type { ULID } from '../shared.ts';

// ── ChatEvent — persisted + broadcast content kinds ──────────────────────────

export type ChatEvent =
  | { kind: 'user'; text: string }
  | { kind: 'assistant-text'; text: string; midLoop: boolean } // complete block
  | { kind: 'thinking'; text: string }
  | { kind: 'turn-end'; text: string; stopReason: string | null }
  | { kind: 'turn-failed'; error: string; source: 'api' | 'abort' | 'internal' }
  | { kind: 'tool-call'; toolUseId: string; name: string; input: unknown }
  | { kind: 'tool-result'; toolUseId: string; result: unknown; isError: boolean }
  | { kind: 'tool-denied'; toolUseId: string; name: string; reason: string }
  | {
      kind: 'usage';
      inputTokens: number;
      outputTokens: number;
      cacheCreationTokens: number;
      cacheReadTokens: number;
      model: string | null;
    }
  | { kind: 'turn-duration'; durationMs: number | null }
  | {
      kind: 'session-state';
      state: 'idle' | 'running' | 'requires_action';
      permissionMode: string | null;
    }
  | {
      kind: 'system';
      subtype: string;
      level: 'info' | 'notice' | 'warning' | 'error';
      message: string;
      raw?: unknown;
    }
  | { kind: 'compaction'; trigger: 'manual' | 'auto'; preTokens: number; postTokens: number | null }
  // pre-shaped server-side; no raw transcript rows on the wire
  | { kind: 'sidechain'; role: 'user' | 'assistant' | 'tool'; text: string }
  // anchor only — the bubble hydrates status from agent-run/contract resource
  // events by runId
  | { kind: 'agent-dispatch'; runId: ULID; agentName: string }
  // Agent → orchestrator envelope (ask + terminal), injected by
  // SessionService.injectAgentEnvelope. Collapsed per-run card in chat;
  // repeated events for the same runId coalesce into one card (latest wins).
  | {
      kind: 'agent-envelope';
      runId: ULID;
      agentName: string;
      /** Set only while this envelope is an open ask — the durable
       *  pending-ask row the orchestrator answers via pc_answer_pending. */
      pendingAskId?: ULID;
      status: 'waiting' | 'done' | 'failed';
      /** One-line label for the collapsed card. */
      summary: string;
      /** Shown when the card expands. */
      detail: string;
      /** Verbatim envelope text — also the turn text sent to the runtime. */
      envelope: string;
    }
  // model-refusal fallback: evict already-delivered events by sdkUuid
  | { kind: 'retract'; uuids: string[] };

export type ChatEventKind = ChatEvent['kind'];

export const CHAT_EVENT_KINDS = [
  'user',
  'assistant-text',
  'thinking',
  'turn-end',
  'turn-failed',
  'tool-call',
  'tool-result',
  'tool-denied',
  'usage',
  'turn-duration',
  'session-state',
  'system',
  'compaction',
  'sidechain',
  'agent-dispatch',
  'agent-envelope',
  'retract',
] as const satisfies readonly ChatEventKind[];

export function isChatEventKind(value: unknown): value is ChatEventKind {
  return typeof value === 'string' && (CHAT_EVENT_KINDS as readonly string[]).includes(value);
}

// ── Envelope ──────────────────────────────────────────────────────────────────

export interface ChatFrame {
  type: 'chat';
  projectId: ULID;
  sessionId: string;
  /** Per-session monotonic, allocated at persist time. */
  seq: number;
  /** THE dedup key; `${sessionId}:${seq}`; UNIQUE(session_id, seq) in DB. */
  id: `${string}:${number}`;
  /** Stamped server-side on the user-turn row before broadcast. */
  clientMessageId?: string;
  /** The SDK message uuid — stored per event for retraction + delta reconcile. */
  sdkUuid?: string;
  event: ChatEvent;
}

// ── Streaming deltas (ephemeral, broadcast-only, never persisted) ─────────────

export type ChatDeltaEvent =
  | { kind: 'message-start' }
  | { kind: 'text-delta'; text: string }
  | { kind: 'thinking-delta'; text: string }
  | { kind: 'tool-input-delta'; toolUseId?: string; partialJson: string }
  | { kind: 'message-end' };

export interface ChatDeltaFrame {
  type: 'chat-delta';
  projectId: ULID;
  sessionId: string;
  /** The in-flight assistant message. Client dedupes against the persisted
   *  ChatFrame with the same sdkUuid (final block wins). */
  sdkUuid: string;
  event: ChatDeltaEvent;
}

// ── Guards (cheap discriminant checks) ───────────────────────────────────────

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

export function isChatFrame(value: unknown): value is ChatFrame {
  return (
    isRecord(value) &&
    value.type === 'chat' &&
    typeof value.sessionId === 'string' &&
    typeof value.seq === 'number' &&
    isRecord(value.event) &&
    isChatEventKind((value.event as Record<string, unknown>).kind)
  );
}

const CHAT_DELTA_KINDS = [
  'message-start',
  'text-delta',
  'thinking-delta',
  'tool-input-delta',
  'message-end',
] as const;

export function isChatDeltaFrame(value: unknown): value is ChatDeltaFrame {
  return (
    isRecord(value) &&
    value.type === 'chat-delta' &&
    typeof value.sdkUuid === 'string' &&
    isRecord(value.event) &&
    typeof (value.event as Record<string, unknown>).kind === 'string' &&
    (CHAT_DELTA_KINDS as readonly string[]).includes(
      (value.event as Record<string, unknown>).kind as string,
    )
  );
}
