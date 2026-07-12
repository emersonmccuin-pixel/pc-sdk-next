// Canonical conversation events. Stable content and visible stream deltas use
// the same durable, server-sequenced envelope. Provider-native identifiers and
// private reasoning content never cross this contract.

import type { ULID } from '../shared.ts';
import { isSendQueueItem, type SendQueueItem } from './messages.ts';

export type ConversationFamily =
  | 'user'
  | 'assistant'
  | 'activity'
  | 'tool'
  | 'agent'
  | 'control'
  | 'telemetry'
  | 'system';

export const CONVERSATION_FAMILIES = [
  'user',
  'assistant',
  'activity',
  'tool',
  'agent',
  'control',
  'telemetry',
  'system',
] as const satisfies readonly ConversationFamily[];

export type TurnStopReason =
  | 'complete'
  | 'max-output'
  | 'stop-sequence'
  | 'tool-use'
  | 'other';

/** Stable/checkpoint content. Historical private reasoning is retained in the
 * database as `legacy-hidden` rows and is deliberately absent from this union. */
export type ChatEvent =
  | { kind: 'user'; text: string }
  | { kind: 'assistant-text'; text: string; midLoop: boolean }
  | { kind: 'turn-end'; text: string; stopReason: TurnStopReason | null }
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
  | { kind: 'sidechain'; role: 'user' | 'assistant' | 'tool'; text: string }
  | { kind: 'agent-dispatch'; runId: ULID; agentName: string }
  | {
      kind: 'agent-envelope';
      runId: ULID;
      agentName: string;
      pendingAskId?: ULID;
      status: 'waiting' | 'done' | 'failed';
      summary: string;
      detail: string;
      envelope: string;
    }
  | { kind: 'send-state'; queueRevision: number; item: SendQueueItem }
  | {
      kind: 'interrupt-state';
      requestId: string;
      targetTurnId: string;
      replacementQueueItemId: string | null;
      state: 'requested' | 'confirmed' | 'failed';
      terminalEventId: string | null;
      result: 'aborted' | 'completed' | 'turn-failed' | 'recovered' | null;
      failure: { code: string; message: string } | null;
    }
  | { kind: 'retract'; streamIds: string[] };

export type ChatEventKind = ChatEvent['kind'];

export const CHAT_EVENT_KINDS = [
  'user',
  'assistant-text',
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
  'send-state',
  'interrupt-state',
  'retract',
] as const satisfies readonly ChatEventKind[];

export type ChatDeltaEvent =
  | { kind: 'message-start' }
  | { kind: 'text-delta'; text: string }
  | { kind: 'tool-input-delta'; toolUseId?: string; partialJson: string }
  | { kind: 'message-end' };

export interface ChatStreamEvent {
  kind: 'stream-delta';
  delta: ChatDeltaEvent;
}

export type ConversationEvent = ChatEvent | ChatStreamEvent;

export interface ConversationEventFrame {
  type: 'conversation-event';
  eventId: string;
  projectId: ULID;
  conversationId: string;
  sessionId: string;
  sequence: number;
  family: ConversationFamily;
  turnId?: string;
  itemId: string;
  streamId?: string;
  deltaIndex?: number;
  clientMessageId?: string;
  occurredAt: number;
  event: ConversationEvent;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function nonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0;
}

function finiteNonNegativeNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0;
}

function nullableString(value: unknown): value is string | null {
  return value === null || typeof value === 'string';
}

function isTurnStopReason(value: unknown): value is TurnStopReason {
  return (
    value === 'complete' ||
    value === 'max-output' ||
    value === 'stop-sequence' ||
    value === 'tool-use' ||
    value === 'other'
  );
}

function hasOwn(value: Record<string, unknown>, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(value, key);
}

export function isConversationFamily(value: unknown): value is ConversationFamily {
  return typeof value === 'string' && (CONVERSATION_FAMILIES as readonly string[]).includes(value);
}

export function isChatEventKind(value: unknown): value is ChatEventKind {
  return typeof value === 'string' && (CHAT_EVENT_KINDS as readonly string[]).includes(value);
}

const CHAT_DELTA_KINDS = [
  'message-start',
  'text-delta',
  'tool-input-delta',
  'message-end',
] as const;

export function isChatDeltaEvent(value: unknown): value is ChatDeltaEvent {
  if (
    !isRecord(value) ||
    typeof value.kind !== 'string' ||
    !(CHAT_DELTA_KINDS as readonly string[]).includes(value.kind)
  ) return false;
  switch (value.kind) {
    case 'message-start':
    case 'message-end':
      return true;
    case 'text-delta':
      return typeof value.text === 'string';
    case 'tool-input-delta':
      return (
        typeof value.partialJson === 'string' &&
        (value.toolUseId === undefined || nonEmptyString(value.toolUseId))
      );
    default:
      return false;
  }
}

export function isChatEvent(value: unknown): value is ChatEvent {
  if (!isRecord(value) || !isChatEventKind(value.kind)) return false;
  switch (value.kind) {
    case 'user':
      return typeof value.text === 'string';
    case 'assistant-text':
      return typeof value.text === 'string' && typeof value.midLoop === 'boolean';
    case 'turn-end':
      return (
        typeof value.text === 'string' &&
        (value.stopReason === null || isTurnStopReason(value.stopReason))
      );
    case 'turn-failed':
      return (
        typeof value.error === 'string' &&
        (value.source === 'api' || value.source === 'abort' || value.source === 'internal')
      );
    case 'tool-call':
      return nonEmptyString(value.toolUseId) && nonEmptyString(value.name) && hasOwn(value, 'input');
    case 'tool-result':
      return nonEmptyString(value.toolUseId) && hasOwn(value, 'result') && typeof value.isError === 'boolean';
    case 'tool-denied':
      return nonEmptyString(value.toolUseId) && nonEmptyString(value.name) && typeof value.reason === 'string';
    case 'usage':
      return (
        finiteNonNegativeNumber(value.inputTokens) &&
        finiteNonNegativeNumber(value.outputTokens) &&
        finiteNonNegativeNumber(value.cacheCreationTokens) &&
        finiteNonNegativeNumber(value.cacheReadTokens) &&
        nullableString(value.model)
      );
    case 'turn-duration':
      return value.durationMs === null || finiteNonNegativeNumber(value.durationMs);
    case 'session-state':
      return (
        (value.state === 'idle' || value.state === 'running' || value.state === 'requires_action') &&
        nullableString(value.permissionMode)
      );
    case 'system':
      return (
        nonEmptyString(value.subtype) &&
        (value.level === 'info' || value.level === 'notice' || value.level === 'warning' || value.level === 'error') &&
        typeof value.message === 'string'
      );
    case 'compaction':
      return (
        (value.trigger === 'manual' || value.trigger === 'auto') &&
        finiteNonNegativeNumber(value.preTokens) &&
        (value.postTokens === null || finiteNonNegativeNumber(value.postTokens))
      );
    case 'sidechain':
      return (
        (value.role === 'user' || value.role === 'assistant' || value.role === 'tool') &&
        typeof value.text === 'string'
      );
    case 'agent-dispatch':
      return nonEmptyString(value.runId) && nonEmptyString(value.agentName);
    case 'agent-envelope':
      return (
        nonEmptyString(value.runId) &&
        nonEmptyString(value.agentName) &&
        (value.pendingAskId === undefined || nonEmptyString(value.pendingAskId)) &&
        (value.status === 'waiting' || value.status === 'done' || value.status === 'failed') &&
        typeof value.summary === 'string' &&
        typeof value.detail === 'string' &&
        typeof value.envelope === 'string'
      );
    case 'send-state':
      return (
        Number.isSafeInteger(value.queueRevision) &&
        (value.queueRevision as number) > 0 &&
        isSendQueueItem(value.item)
      );
    case 'interrupt-state': {
      const shape = (
        nonEmptyString(value.requestId) &&
        nonEmptyString(value.targetTurnId) &&
        (value.replacementQueueItemId === null || nonEmptyString(value.replacementQueueItemId)) &&
        (value.state === 'requested' || value.state === 'confirmed' || value.state === 'failed') &&
        (value.terminalEventId === null || nonEmptyString(value.terminalEventId)) &&
        (
          value.result === null ||
          value.result === 'aborted' ||
          value.result === 'completed' ||
          value.result === 'turn-failed' ||
          value.result === 'recovered'
        ) &&
        (
          value.failure === null ||
          (isRecord(value.failure) && nonEmptyString(value.failure.code) && typeof value.failure.message === 'string')
        )
      );
      if (!shape) return false;
      if (value.state === 'requested') {
        return value.terminalEventId === null && value.result === null && value.failure === null;
      }
      if (value.state === 'confirmed') {
        return nonEmptyString(value.terminalEventId) && value.result === 'aborted' && value.failure === null;
      }
      if (value.failure === null) return false;
      if (value.terminalEventId === null) return value.result === null;
      return (
        value.result === 'completed' ||
        value.result === 'turn-failed' ||
        value.result === 'recovered'
      );
    }
    case 'retract':
      return Array.isArray(value.streamIds) && value.streamIds.every(nonEmptyString);
    default:
      return false;
  }
}

export function isConversationEvent(value: unknown): value is ConversationEvent {
  if (!isRecord(value) || typeof value.kind !== 'string') return false;
  if (value.kind === 'stream-delta') return isChatDeltaEvent(value.delta);
  return isChatEvent(value);
}

export function conversationFamilyForEvent(event: ConversationEvent): ConversationFamily {
  switch (event.kind) {
    case 'user':
      return 'user';
    case 'assistant-text':
    case 'stream-delta':
      return 'assistant';
    case 'tool-call':
    case 'tool-result':
    case 'tool-denied':
      return 'tool';
    case 'agent-dispatch':
    case 'agent-envelope':
    case 'sidechain':
      return 'agent';
    case 'send-state':
      return event.item.origin === 'user' ? 'user' : 'agent';
    case 'usage':
    case 'turn-duration':
      return 'telemetry';
    case 'system':
      return 'system';
    default:
      return 'control';
  }
}

export function isConversationEventFrame(value: unknown): value is ConversationEventFrame {
  if (!isRecord(value) || value.type !== 'conversation-event') return false;
  if (
    !nonEmptyString(value.eventId) ||
    !nonEmptyString(value.projectId) ||
    !nonEmptyString(value.conversationId) ||
    !nonEmptyString(value.sessionId) ||
    !Number.isSafeInteger(value.sequence) ||
    (value.sequence as number) < 1 ||
    !isConversationFamily(value.family) ||
    !nonEmptyString(value.itemId) ||
    !Number.isFinite(value.occurredAt) ||
    !isConversationEvent(value.event)
  ) return false;
  if (value.family !== conversationFamilyForEvent(value.event)) return false;
  if (value.turnId !== undefined && !nonEmptyString(value.turnId)) return false;
  if (value.streamId !== undefined && !nonEmptyString(value.streamId)) return false;
  if (value.clientMessageId !== undefined && !nonEmptyString(value.clientMessageId)) return false;
  if (value.deltaIndex !== undefined && (!Number.isSafeInteger(value.deltaIndex) || (value.deltaIndex as number) < 0)) {
    return false;
  }
  if (value.event.kind === 'stream-delta') {
    return nonEmptyString(value.streamId) && value.deltaIndex !== undefined;
  }
  return value.deltaIndex === undefined;
}
