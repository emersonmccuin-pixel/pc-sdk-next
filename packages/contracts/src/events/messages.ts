// Conversation commands, durable queue snapshots, ask/permission, and
// transport heartbeat. Browser-safe, zero runtime dependencies.

import type { ULID } from '../shared.ts';

// ── Client → server conversation commands ───────────────────────────────────

export interface SendMessage {
  type: 'send';
  commandId: string;
  sessionId: string | null;
  text: string;
  clientMessageId: string;
}

export interface EditQueuedMessage {
  type: 'edit-queued-message';
  commandId: string;
  sessionId: string;
  queueItemId: string;
  expectedRevision: number;
  text: string;
}

export interface RemoveQueuedMessage {
  type: 'remove-queued-message';
  commandId: string;
  sessionId: string;
  queueItemId: string;
  expectedRevision: number;
}

/** Request interruption of one exact active turn. Socket write is not success;
 * the durable interrupt-state event supplies requested/confirmed/failed truth. */
export interface InterruptMessage {
  type: 'interrupt';
  requestId: string;
  sessionId: string;
  targetTurnId: string;
}

export type InterruptReplacement =
  | { kind: 'new'; clientMessageId: string; text: string }
  | { kind: 'queued'; queueItemId: string; expectedRevision: number };

/** Link the FIFO head (or a new item when the queue is empty) to an interrupt.
 * The replacement remains unclaimable until the exact target turn aborts. */
export interface InterruptAndSendMessage {
  type: 'interrupt-and-send';
  requestId: string;
  sessionId: string;
  targetTurnId: string;
  replacement: InterruptReplacement;
}

export interface AskReplyMessage {
  type: 'ask-reply';
  askId: string;
  answer: string;
}
export interface SubscribeMessage {
  type: 'subscribe';
  lastVersion?: string;
}
export interface ClientPingMessage {
  type: 'client-ping';
  nonce: string;
  sentAt: number;
}

export type ConversationCommand =
  | SendMessage
  | EditQueuedMessage
  | RemoveQueuedMessage
  | InterruptMessage
  | InterruptAndSendMessage;

export type ConversationCommandKind = ConversationCommand['type'];

export type ClientMessage =
  | ConversationCommand
  | AskReplyMessage
  | SubscribeMessage
  | ClientPingMessage;

export const CLIENT_MESSAGE_TYPES = [
  'send',
  'edit-queued-message',
  'remove-queued-message',
  'interrupt',
  'interrupt-and-send',
  'ask-reply',
  'subscribe',
  'client-ping',
] as const satisfies readonly ClientMessage['type'][];

// ── Sender-only command receipt ──────────────────────────────────────────────

export type ConversationCommandStatus = 'applied' | 'duplicate' | 'rejected';

export type ConversationCommandErrorCode =
  | 'invalid'
  | 'idempotency-conflict'
  | 'session-changed'
  | 'not-found'
  | 'not-queued'
  | 'revision-conflict'
  | 'queue-not-empty'
  | 'not-head'
  | 'no-active-turn'
  | 'interrupt-in-progress'
  | 'internal';

export interface ConversationCommandError {
  code: ConversationCommandErrorCode;
  message: string;
  currentRevision?: number;
}

/** Transport feedback only. Canonical send-state/interrupt-state events and
 * connect snapshots remain projection authority. */
export interface ConversationCommandReceiptFrame {
  type: 'conversation-command-receipt';
  projectId: ULID;
  sessionId: string | null;
  commandId: string;
  command: ConversationCommandKind;
  status: ConversationCommandStatus;
  queueItemId?: string;
  revision?: number;
  interruptRequestId?: string;
  error: ConversationCommandError | null;
}

// ── Durable send-queue snapshot (connect/reconnect baseline) ─────────────────

export type SendQueueItemOrigin = 'user' | 'agent-envelope';

/** Typed durable metadata for an internal agent-envelope queue revision. The
 * envelope transport text is stored separately and never sent to the browser. */
export interface QueuedAgentEnvelope {
  runId: string;
  agentName: string;
  pendingAskId?: string;
  status: 'waiting' | 'done' | 'failed';
  summary: string;
  detail: string;
}
export type SendQueueItemStatus =
  | 'queued'
  | 'delivering'
  | 'accepted'
  | 'failed'
  | 'cancelled';

export interface SendQueueItem {
  id: ULID;
  clientMessageId: string;
  origin: SendQueueItemOrigin;
  enqueuePosition: number;
  revision: number;
  deliveryRevision: number | null;
  /** User text, or a safe agent-envelope summary (never raw transport text). */
  text: string;
  status: SendQueueItemStatus;
  interruptRequestId: string | null;
  failureReason: string | null;
  createdAt: number;
  updatedAt: number;
}

export interface SendQueueSnapshotFrame {
  type: 'send-queue-snapshot';
  projectId: ULID;
  sessionId: string;
  queueRevision: number;
  items: SendQueueItem[];
}

// ── Ask / permission ─────────────────────────────────────────────────────────

export interface AskFrame {
  type: 'ask';
  projectId: ULID;
  askId: ULID;
  sessionId: string | null;
  toolName: string;
  toolUseId: string;
  toolInput: unknown;
}

// ── Heartbeat ────────────────────────────────────────────────────────────────

export interface ServerPongFrame {
  type: 'server-pong';
  projectId: ULID;
  nonce: string;
  sentAt: number;
  serverTime: number;
}

// ── Guards ───────────────────────────────────────────────────────────────────

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function nonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0;
}

function positiveInteger(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) > 0;
}

function finiteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

export function isClientMessageType(value: unknown): value is ClientMessage['type'] {
  return typeof value === 'string' && (CLIENT_MESSAGE_TYPES as readonly string[]).includes(value);
}

export function isClientMessage(value: unknown): value is ClientMessage {
  if (!isRecord(value) || !isClientMessageType(value.type)) return false;
  switch (value.type) {
    case 'send':
      return (
        nonEmptyString(value.commandId) &&
        (value.sessionId === null || nonEmptyString(value.sessionId)) &&
        nonEmptyString(value.clientMessageId) &&
        typeof value.text === 'string'
      );
    case 'edit-queued-message':
      return (
        nonEmptyString(value.commandId) &&
        nonEmptyString(value.sessionId) &&
        nonEmptyString(value.queueItemId) &&
        positiveInteger(value.expectedRevision) &&
        typeof value.text === 'string'
      );
    case 'remove-queued-message':
      return (
        nonEmptyString(value.commandId) &&
        nonEmptyString(value.sessionId) &&
        nonEmptyString(value.queueItemId) &&
        positiveInteger(value.expectedRevision)
      );
    case 'interrupt':
      return (
        nonEmptyString(value.requestId) &&
        nonEmptyString(value.sessionId) &&
        nonEmptyString(value.targetTurnId)
      );
    case 'interrupt-and-send': {
      if (
        !nonEmptyString(value.requestId) ||
        !nonEmptyString(value.sessionId) ||
        !nonEmptyString(value.targetTurnId) ||
        !isRecord(value.replacement)
      ) return false;
      if (value.replacement.kind === 'new') {
        return (
          nonEmptyString(value.replacement.clientMessageId) &&
          typeof value.replacement.text === 'string'
        );
      }
      return (
        value.replacement.kind === 'queued' &&
        nonEmptyString(value.replacement.queueItemId) &&
        positiveInteger(value.replacement.expectedRevision)
      );
    }
    case 'ask-reply':
      return nonEmptyString(value.askId) && typeof value.answer === 'string';
    case 'subscribe':
      return value.lastVersion === undefined || typeof value.lastVersion === 'string';
    case 'client-ping':
      return nonEmptyString(value.nonce) && finiteNumber(value.sentAt);
  }
}

const COMMAND_KINDS: readonly ConversationCommandKind[] = [
  'send',
  'edit-queued-message',
  'remove-queued-message',
  'interrupt',
  'interrupt-and-send',
];
const COMMAND_STATUSES: readonly ConversationCommandStatus[] = [
  'applied',
  'duplicate',
  'rejected',
];
const COMMAND_ERROR_CODES: readonly ConversationCommandErrorCode[] = [
  'invalid',
  'idempotency-conflict',
  'session-changed',
  'not-found',
  'not-queued',
  'revision-conflict',
  'queue-not-empty',
  'not-head',
  'no-active-turn',
  'interrupt-in-progress',
  'internal',
];
const QUEUE_ORIGINS: readonly SendQueueItemOrigin[] = ['user', 'agent-envelope'];
const QUEUE_STATUSES: readonly SendQueueItemStatus[] = [
  'queued',
  'delivering',
  'accepted',
  'failed',
  'cancelled',
];

export function isSendQueueItemStatus(value: unknown): value is SendQueueItemStatus {
  return typeof value === 'string' && (QUEUE_STATUSES as readonly string[]).includes(value);
}

export function isSendQueueItem(value: unknown): value is SendQueueItem {
  return (
    isRecord(value) &&
    nonEmptyString(value.id) &&
    nonEmptyString(value.clientMessageId) &&
    typeof value.origin === 'string' &&
    (QUEUE_ORIGINS as readonly string[]).includes(value.origin) &&
    positiveInteger(value.enqueuePosition) &&
    positiveInteger(value.revision) &&
    (value.deliveryRevision === null || positiveInteger(value.deliveryRevision)) &&
    typeof value.text === 'string' &&
    isSendQueueItemStatus(value.status) &&
    (value.interruptRequestId === null || nonEmptyString(value.interruptRequestId)) &&
    (value.failureReason === null || typeof value.failureReason === 'string') &&
    finiteNumber(value.createdAt) &&
    finiteNumber(value.updatedAt)
  );
}

export function isQueuedAgentEnvelope(value: unknown): value is QueuedAgentEnvelope {
  return (
    isRecord(value) &&
    nonEmptyString(value.runId) &&
    nonEmptyString(value.agentName) &&
    (value.pendingAskId === undefined || nonEmptyString(value.pendingAskId)) &&
    (value.status === 'waiting' || value.status === 'done' || value.status === 'failed') &&
    typeof value.summary === 'string' &&
    typeof value.detail === 'string'
  );
}

export function isSendQueueSnapshotFrame(value: unknown): value is SendQueueSnapshotFrame {
  if (!(
    isRecord(value) &&
    value.type === 'send-queue-snapshot' &&
    nonEmptyString(value.projectId) &&
    nonEmptyString(value.sessionId) &&
    Number.isSafeInteger(value.queueRevision) &&
    (value.queueRevision as number) >= 0 &&
    Array.isArray(value.items) &&
    value.items.every(isSendQueueItem)
  )) return false;
  const ids = new Set<string>();
  const clientIds = new Set<string>();
  const positions = new Set<number>();
  for (const item of value.items) {
    if (item.status === 'accepted' || item.status === 'cancelled') return false;
    if (ids.has(item.id) || clientIds.has(item.clientMessageId) || positions.has(item.enqueuePosition)) {
      return false;
    }
    ids.add(item.id);
    clientIds.add(item.clientMessageId);
    positions.add(item.enqueuePosition);
  }
  return true;
}

export function isConversationCommandReceiptFrame(
  value: unknown,
): value is ConversationCommandReceiptFrame {
  if (
    !isRecord(value) ||
    value.type !== 'conversation-command-receipt' ||
    !nonEmptyString(value.projectId) ||
    !(value.sessionId === null || nonEmptyString(value.sessionId)) ||
    !nonEmptyString(value.commandId) ||
    typeof value.command !== 'string' ||
    !(COMMAND_KINDS as readonly string[]).includes(value.command) ||
    typeof value.status !== 'string' ||
    !(COMMAND_STATUSES as readonly string[]).includes(value.status) ||
    (value.queueItemId !== undefined && !nonEmptyString(value.queueItemId)) ||
    (value.revision !== undefined && !positiveInteger(value.revision)) ||
    (value.interruptRequestId !== undefined && !nonEmptyString(value.interruptRequestId))
  ) return false;
  if (value.error !== null) return value.status === 'rejected' && (
    isRecord(value.error) &&
    typeof value.error.code === 'string' &&
    (COMMAND_ERROR_CODES as readonly string[]).includes(value.error.code) &&
    typeof value.error.message === 'string' &&
    (value.error.currentRevision === undefined || positiveInteger(value.error.currentRevision))
  );
  if (value.status === 'rejected') return false;
  switch (value.command) {
    case 'send':
    case 'edit-queued-message':
    case 'remove-queued-message':
      return nonEmptyString(value.queueItemId) && positiveInteger(value.revision);
    case 'interrupt':
      return nonEmptyString(value.interruptRequestId);
    case 'interrupt-and-send':
      return (
        nonEmptyString(value.interruptRequestId) &&
        nonEmptyString(value.queueItemId) &&
        positiveInteger(value.revision)
      );
  }
  return false;
}

export function isAskFrame(value: unknown): value is AskFrame {
  return (
    isRecord(value) &&
    value.type === 'ask' &&
    nonEmptyString(value.projectId) &&
    nonEmptyString(value.askId) &&
    (value.sessionId === null || nonEmptyString(value.sessionId)) &&
    nonEmptyString(value.toolName) &&
    nonEmptyString(value.toolUseId)
  );
}
