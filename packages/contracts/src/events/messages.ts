// Send path + ask/permission + transport heartbeat. See docs/event-contract.md.
// Browser-safe, zero runtime deps.

import type { ULID } from '../shared.ts';

// ── Client → server ───────────────────────────────────────────────────────────

export interface SendMessage {
  type: 'send';
  text: string;
  clientMessageId: string;
}
/** Abort the in-flight turn. */
export interface InterruptMessage {
  type: 'interrupt';
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

export type ClientMessage =
  | SendMessage
  | InterruptMessage
  | AskReplyMessage
  | SubscribeMessage
  | ClientPingMessage;

export const CLIENT_MESSAGE_TYPES = [
  'send',
  'interrupt',
  'ask-reply',
  'subscribe',
  'client-ping',
] as const satisfies readonly ClientMessage['type'][];

export function isClientMessageType(value: unknown): value is ClientMessage['type'] {
  return typeof value === 'string' && (CLIENT_MESSAGE_TYPES as readonly string[]).includes(value);
}

// ── Send-ack (server → sender only) ───────────────────────────────────────────

export type SendAckStatus = 'received' | 'queued' | 'invalid' | 'error';

export interface SendAckFrame {
  type: 'send-ack';
  projectId: ULID;
  clientMessageId: string;
  ok: boolean;
  status: SendAckStatus;
  error?: string;
}

// ── Send-queue snapshot (server → broadcast) ──────────────────────────────────
// Snapshot replaces snapshot (no per-item deltas). PTY-era statuses are dead.

export type SendQueueItemStatus = 'queued' | 'delivering' | 'delivered' | 'failed' | 'cancelled';

export interface SendQueueItem {
  id: ULID;
  clientMessageId: string;
  text: string;
  status: SendQueueItemStatus;
  failureReason: string | null;
  createdAt: number;
  updatedAt: number;
}

export interface SendQueueSnapshotFrame {
  type: 'send-queue-snapshot';
  projectId: ULID;
  sessionId: string;
  items: SendQueueItem[];
}

// ── Ask / permission ──────────────────────────────────────────────────────────
// The SDK canUseTool callback blocks on a browser answer. Keyed by askId (one
// tool use can re-ask after edits). A watchdog auto-resolves abandoned asks as
// denied (typed, visible — never a hang).

export interface AskFrame {
  type: 'ask';
  projectId: ULID;
  askId: ULID;
  sessionId: string | null;
  toolName: string;
  toolUseId: string;
  toolInput: unknown;
}

// ── Heartbeat (server → sender) ───────────────────────────────────────────────

export interface ServerPongFrame {
  type: 'server-pong';
  projectId: ULID;
  nonce: string;
  sentAt: number;
  serverTime: number;
}

// ── Guards ─────────────────────────────────────────────────────────────────────

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

const SEND_ACK_STATUSES: readonly SendAckStatus[] = ['received', 'queued', 'invalid', 'error'];
const SEND_QUEUE_ITEM_STATUSES: readonly SendQueueItemStatus[] = [
  'queued',
  'delivering',
  'delivered',
  'failed',
  'cancelled',
];

export function isSendAckStatus(value: unknown): value is SendAckStatus {
  return typeof value === 'string' && (SEND_ACK_STATUSES as readonly string[]).includes(value);
}

export function isSendQueueItemStatus(value: unknown): value is SendQueueItemStatus {
  return (
    typeof value === 'string' && (SEND_QUEUE_ITEM_STATUSES as readonly string[]).includes(value)
  );
}

export function isSendQueueItem(value: unknown): value is SendQueueItem {
  return (
    isRecord(value) &&
    typeof value.id === 'string' &&
    typeof value.clientMessageId === 'string' &&
    typeof value.text === 'string' &&
    isSendQueueItemStatus(value.status) &&
    (value.failureReason === null || typeof value.failureReason === 'string') &&
    typeof value.createdAt === 'number' &&
    typeof value.updatedAt === 'number'
  );
}

export function isAskFrame(value: unknown): value is AskFrame {
  return (
    isRecord(value) &&
    value.type === 'ask' &&
    typeof value.askId === 'string' &&
    (value.sessionId === null || typeof value.sessionId === 'string') &&
    typeof value.toolName === 'string' &&
    typeof value.toolUseId === 'string'
  );
}
