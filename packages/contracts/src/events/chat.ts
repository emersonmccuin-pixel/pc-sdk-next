// Canonical conversation events. Stable content and visible stream deltas use
// the same durable, server-sequenced envelope. Provider-native identifiers and
// private reasoning content never cross this contract.

import type { ULID } from '../shared.ts';
import { isContextObservation, type ContextObservation } from '../context.ts';
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

export const ACTIVITY_PHASES = [
  'turn-starting',
  'requesting-runtime',
  'responding',
  'retrying',
  'compacting',
] as const;

export type ActivityPhase = (typeof ACTIVITY_PHASES)[number];

export const TOOL_CALL_STATES = [
  'requested',
  'approval-needed',
  'running',
  'succeeded',
  'failed',
  'denied',
] as const;

export type ToolCallState = (typeof TOOL_CALL_STATES)[number];

export type ToolApprovalSnapshot =
  | { status: 'unknown'; source: null; requestId: null }
  | { status: 'not-required'; source: 'policy' | 'runtime'; requestId: null }
  | { status: 'pending'; source: null; requestId: string }
  | { status: 'allowed'; source: 'user'; requestId: string }
  | { status: 'allowed'; source: 'runtime'; requestId: null }
  | {
      status: 'denied';
      source: 'user' | 'timeout' | 'session';
      requestId: string;
    }
  | { status: 'denied'; source: 'runtime'; requestId: null };

export type ToolTerminalReason = 'tool-error' | 'turn-ended' | 'runtime-lost';

export interface ToolStateEvent {
  kind: 'tool-state';
  callId: string;
  name: string;
  state: ToolCallState;
  /** Deterministic app-authored copy. It never contains tool input or output. */
  safeSummary: string;
  approval: ToolApprovalSnapshot;
  outcome: { reason: ToolTerminalReason } | null;
}

const TOOL_NAME_MAX_LENGTH = 160;
const TOOL_NAME_CONTROL = /[\u0000-\u001f\u007f]/;

export function isCanonicalToolName(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    value.length > 0 &&
    value.length <= TOOL_NAME_MAX_LENGTH &&
    !TOOL_NAME_CONTROL.test(value)
  );
}

/** The only durable tool summary constructor. Inputs/results never participate. */
export function safeToolSummary(name: string): string {
  return `Use ${name.slice(0, TOOL_NAME_MAX_LENGTH).replace(TOOL_NAME_CONTROL, '')}`;
}

export function isTerminalToolState(state: ToolCallState): boolean {
  return state === 'succeeded' || state === 'failed' || state === 'denied';
}

function sameToolApproval(left: ToolApprovalSnapshot, right: ToolApprovalSnapshot): boolean {
  return left.status === right.status
    && left.source === right.source
    && left.requestId === right.requestId;
}

/** Shared transition guard used by persistence and browser projection. */
export function toolStateTransitionError(
  previous: ToolStateEvent | null,
  next: ToolStateEvent,
): string | null {
  if (previous === null) return next.state === 'requested' ? null : 'first-state-not-requested';
  if (
    previous.callId !== next.callId ||
    previous.name !== next.name ||
    previous.safeSummary !== next.safeSummary
  ) return 'identity-changed';
  if (isTerminalToolState(previous.state)) return 'post-terminal';

  switch (previous.state) {
    case 'requested': {
      if (next.state === 'approval-needed') return null;
      if (next.state === 'running') {
        return (
          next.approval.status === 'not-required'
          || (next.approval.status === 'allowed' && next.approval.source === 'runtime')
        ) ? null : 'approval-provenance-invalid';
      }
      if (next.state === 'denied') {
        return next.approval.status === 'denied'
          && next.approval.source === 'runtime'
          && next.approval.requestId === null
          ? null
          : 'approval-provenance-invalid';
      }
      if (
        next.state === 'failed'
        && (next.outcome?.reason === 'turn-ended' || next.outcome?.reason === 'runtime-lost')
      ) {
        return sameToolApproval(next.approval, previous.approval)
          ? null
          : 'approval-provenance-changed';
      }
      return 'invalid-transition';
    }
    case 'approval-needed':
      if (next.state !== 'running' && next.state !== 'denied') return 'invalid-transition';
      return next.approval.requestId === previous.approval.requestId
        ? null
        : 'approval-request-changed';
    case 'running':
      if (next.state !== 'succeeded' && next.state !== 'failed') return 'invalid-transition';
      return sameToolApproval(next.approval, previous.approval)
        ? null
        : 'approval-provenance-changed';
    default:
      return 'post-terminal';
  }
}

/** Stable/checkpoint content. Historical private reasoning is retained in the
 * database as `legacy-hidden` rows and is deliberately absent from this union. */
export type ChatEvent =
  | { kind: 'user'; text: string }
  | { kind: 'assistant-text'; text: string; midLoop: boolean }
  | { kind: 'turn-end'; text: string; stopReason: TurnStopReason | null }
  | {
      kind: 'turn-failed';
      error: string;
      source: 'api' | 'abort' | 'internal';
      /** Optional bounded, secret-scrubbed provider diagnostic text (see
       *  @pc/utils scrubProviderDetail). Display-only: never woven into
       *  `error`, never used for control flow. */
      providerDetail?: string;
    }
  | { kind: 'activity-state'; phase: ActivityPhase }
  | ToolStateEvent
  | {
      kind: 'usage';
      inputTokens: number;
      outputTokens: number;
      cacheCreationTokens: number;
      cacheReadTokens: number;
      model: string | null;
    }
  | ({ kind: 'context-observation' } & ContextObservation)
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
    }
  | {
      kind: 'compaction';
      trigger: 'manual' | 'auto' | 'unknown';
      preTokens: number | null;
      postTokens: number | null;
    }
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
  'activity-state',
  'tool-state',
  'usage',
  'context-observation',
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

function nonNegativeSafeInteger(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) >= 0;
}

function nullableString(value: unknown): value is string | null {
  return value === null || typeof value === 'string';
}

const PROVIDER_DETAIL_MAX_LENGTH = 500;

function isBoundedProviderDetail(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= PROVIDER_DETAIL_MAX_LENGTH;
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

export function isConversationFamily(value: unknown): value is ConversationFamily {
  return typeof value === 'string' && (CONVERSATION_FAMILIES as readonly string[]).includes(value);
}

export function isChatEventKind(value: unknown): value is ChatEventKind {
  return typeof value === 'string' && (CHAT_EVENT_KINDS as readonly string[]).includes(value);
}

const CHAT_DELTA_KINDS = [
  'message-start',
  'text-delta',
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
      return hasOnlyKeys(value, ['kind']);
    case 'text-delta':
      return hasOnlyKeys(value, ['kind', 'text']) && typeof value.text === 'string';
    default:
      return false;
  }
}

function hasOnlyKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  const allowed = new Set(keys);
  return Object.keys(value).every((key) => allowed.has(key));
}

function isToolApprovalSnapshot(value: unknown): value is ToolApprovalSnapshot {
  if (
    !isRecord(value) ||
    !hasOnlyKeys(value, ['status', 'source', 'requestId']) ||
    typeof value.status !== 'string'
  ) return false;
  switch (value.status) {
    case 'unknown':
      return value.source === null && value.requestId === null;
    case 'not-required':
      return (value.source === 'policy' || value.source === 'runtime') && value.requestId === null;
    case 'pending':
      return value.source === null && nonEmptyString(value.requestId);
    case 'allowed':
      return (
        (value.source === 'user' && nonEmptyString(value.requestId)) ||
        (value.source === 'runtime' && value.requestId === null)
      );
    case 'denied':
      return (
        ((value.source === 'user' || value.source === 'timeout' || value.source === 'session') &&
          nonEmptyString(value.requestId)) ||
        (value.source === 'runtime' && value.requestId === null)
      );
    default:
      return false;
  }
}

function isToolStateEvent(value: unknown): value is ToolStateEvent {
  if (!isRecord(value)) return false;
  if (
    !hasOnlyKeys(value, ['kind', 'callId', 'name', 'state', 'safeSummary', 'approval', 'outcome']) ||
    !nonEmptyString(value.callId) ||
    !isCanonicalToolName(value.name) ||
    !(TOOL_CALL_STATES as readonly unknown[]).includes(value.state) ||
    value.safeSummary !== safeToolSummary(value.name) ||
    !isToolApprovalSnapshot(value.approval)
  ) return false;
  const outcome = value.outcome;
  const state = value.state as ToolCallState;
  if (state === 'failed') {
    if (
      !isRecord(outcome) ||
      !hasOnlyKeys(outcome, ['reason']) ||
      (outcome.reason !== 'tool-error' && outcome.reason !== 'turn-ended' && outcome.reason !== 'runtime-lost')
    ) return false;
  } else if (outcome !== null) {
    return false;
  }
  const approval = value.approval as ToolApprovalSnapshot;
  switch (state) {
    case 'requested':
      return approval.status === 'unknown';
    case 'approval-needed':
      return approval.status === 'pending';
    case 'running':
    case 'succeeded':
      return approval.status === 'not-required' || approval.status === 'allowed';
    case 'failed':
      return approval.status !== 'pending' && approval.status !== 'denied';
    case 'denied':
      return approval.status === 'denied';
  }
}

export function isChatEvent(value: unknown): value is ChatEvent {
  if (!isRecord(value) || !isChatEventKind(value.kind)) return false;
  switch (value.kind) {
    case 'user':
      return hasOnlyKeys(value, ['kind', 'text']) && typeof value.text === 'string';
    case 'assistant-text':
      return (
        hasOnlyKeys(value, ['kind', 'text', 'midLoop']) &&
        typeof value.text === 'string' &&
        typeof value.midLoop === 'boolean'
      );
    case 'turn-end':
      return (
        hasOnlyKeys(value, ['kind', 'text', 'stopReason']) &&
        typeof value.text === 'string' &&
        (value.stopReason === null || isTurnStopReason(value.stopReason))
      );
    case 'turn-failed':
      return (
        hasOnlyKeys(value, ['kind', 'error', 'source', 'providerDetail']) &&
        typeof value.error === 'string' &&
        (value.source === 'api' || value.source === 'abort' || value.source === 'internal') &&
        // Bound matches @pc/utils scrubProviderDetail's cap; absent stays valid.
        (value.providerDetail === undefined || isBoundedProviderDetail(value.providerDetail))
      );
    case 'activity-state':
      return (
        hasOnlyKeys(value, ['kind', 'phase']) &&
        (ACTIVITY_PHASES as readonly unknown[]).includes(value.phase)
      );
    case 'tool-state':
      return isToolStateEvent(value);
    case 'usage':
      return (
        hasOnlyKeys(value, [
          'kind',
          'inputTokens',
          'outputTokens',
          'cacheCreationTokens',
          'cacheReadTokens',
          'model',
        ]) &&
        finiteNonNegativeNumber(value.inputTokens) &&
        finiteNonNegativeNumber(value.outputTokens) &&
        finiteNonNegativeNumber(value.cacheCreationTokens) &&
        finiteNonNegativeNumber(value.cacheReadTokens) &&
        nullableString(value.model)
      );
    case 'context-observation': {
      const { kind: _kind, ...observation } = value;
      return isContextObservation(observation);
    }
    case 'turn-duration':
      return (
        hasOnlyKeys(value, ['kind', 'durationMs']) &&
        (value.durationMs === null || finiteNonNegativeNumber(value.durationMs))
      );
    case 'session-state':
      return (
        hasOnlyKeys(value, ['kind', 'state', 'permissionMode']) &&
        (value.state === 'idle' || value.state === 'running' || value.state === 'requires_action') &&
        nullableString(value.permissionMode)
      );
    case 'system':
      return (
        hasOnlyKeys(value, ['kind', 'subtype', 'level', 'message']) &&
        nonEmptyString(value.subtype) &&
        (value.level === 'info' || value.level === 'notice' || value.level === 'warning' || value.level === 'error') &&
        typeof value.message === 'string'
      );
    case 'compaction':
      return (
        hasOnlyKeys(value, ['kind', 'trigger', 'preTokens', 'postTokens']) &&
        (value.trigger === 'manual' || value.trigger === 'auto' || value.trigger === 'unknown') &&
        (value.preTokens === null || nonNegativeSafeInteger(value.preTokens)) &&
        (value.postTokens === null || nonNegativeSafeInteger(value.postTokens))
      );
    case 'sidechain':
      return (
        hasOnlyKeys(value, ['kind', 'role', 'text']) &&
        (value.role === 'user' || value.role === 'assistant' || value.role === 'tool') &&
        typeof value.text === 'string'
      );
    case 'agent-dispatch':
      return (
        hasOnlyKeys(value, ['kind', 'runId', 'agentName']) &&
        nonEmptyString(value.runId) &&
        nonEmptyString(value.agentName)
      );
    case 'agent-envelope':
      return (
        hasOnlyKeys(value, [
          'kind',
          'runId',
          'agentName',
          'pendingAskId',
          'status',
          'summary',
          'detail',
          'envelope',
        ]) &&
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
        hasOnlyKeys(value, ['kind', 'queueRevision', 'item']) &&
        Number.isSafeInteger(value.queueRevision) &&
        (value.queueRevision as number) > 0 &&
        isSendQueueItem(value.item)
      );
    case 'interrupt-state': {
      const shape = (
        hasOnlyKeys(value, [
          'kind',
          'requestId',
          'targetTurnId',
          'replacementQueueItemId',
          'state',
          'terminalEventId',
          'result',
          'failure',
        ]) &&
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
          (
            isRecord(value.failure) &&
            hasOnlyKeys(value.failure, ['code', 'message']) &&
            nonEmptyString(value.failure.code) &&
            typeof value.failure.message === 'string'
          )
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
      return (
        hasOnlyKeys(value, ['kind', 'streamIds']) &&
        Array.isArray(value.streamIds) &&
        value.streamIds.every(nonEmptyString)
      );
    default:
      return false;
  }
}

export function isConversationEvent(value: unknown): value is ConversationEvent {
  if (!isRecord(value) || typeof value.kind !== 'string') return false;
  if (value.kind === 'stream-delta') {
    return hasOnlyKeys(value, ['kind', 'delta']) && isChatDeltaEvent(value.delta);
  }
  return isChatEvent(value);
}

export function conversationFamilyForEvent(event: ConversationEvent): ConversationFamily {
  switch (event.kind) {
    case 'user':
      return 'user';
    case 'assistant-text':
    case 'stream-delta':
      return 'assistant';
    case 'activity-state':
      return 'activity';
    case 'tool-state':
      return 'tool';
    case 'agent-dispatch':
    case 'agent-envelope':
    case 'sidechain':
      return 'agent';
    case 'send-state':
      return event.item.origin === 'user' ? 'user' : 'agent';
    case 'usage':
    case 'context-observation':
    case 'turn-duration':
      return 'telemetry';
    case 'system':
      return 'system';
    default:
      return 'control';
  }
}

export function isConversationEventFrame(value: unknown): value is ConversationEventFrame {
  if (
    !isRecord(value) ||
    !hasOnlyKeys(value, [
      'type',
      'eventId',
      'projectId',
      'conversationId',
      'sessionId',
      'sequence',
      'family',
      'turnId',
      'itemId',
      'streamId',
      'deltaIndex',
      'clientMessageId',
      'occurredAt',
      'event',
    ]) ||
    value.type !== 'conversation-event'
  ) return false;
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
  if (
    (
      value.event.kind === 'activity-state'
      || value.event.kind === 'tool-state'
      || value.event.kind === 'context-observation'
    )
    && !nonEmptyString(value.turnId)
  ) return false;
  if (value.event.kind === 'tool-state' && value.itemId !== value.event.callId) return false;
  return value.deltaIndex === undefined;
}
