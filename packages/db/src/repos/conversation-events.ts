// conversation_events repo — the orchestrator chat's durable replay store.
//
// Persist-then-broadcast (docs/event-contract.md, Channel 1): the single writer
// allocates `seq`, persists here, then broadcasts the same payload. Replay is a
// query by per-session `seq`. The UNIQUE (session_id, seq) index makes a
// double-write throw — the caller's seq allocation is the authority. Plain repo
// door: no live_outbox row (chat rides its own WS channel).

import { and, asc, count, eq, gt, max } from 'drizzle-orm';
import type { ULID } from '@pc/domain';

import { getDb } from '../connection.ts';
import { conversationEvents } from '../schema.ts';

export type ConversationEventRow = typeof conversationEvents.$inferSelect;

export interface AppendConversationEventInput {
  projectId: ULID;
  sessionId: string;
  seq: number;
  kind: string | null;
  event: unknown;
  /** SDK message uuid — for retraction + delta reconciliation. Nullable. */
  sdkUuid?: string | null;
  /** Stamped on the user-turn row before broadcast. Nullable. */
  clientMessageId?: string | null;
  now: number;
}

function toRow(input: AppendConversationEventInput): ConversationEventRow {
  return {
    id: `${input.sessionId}:${input.seq}`,
    projectId: input.projectId,
    sessionId: input.sessionId,
    seq: input.seq,
    kind: input.kind,
    event: input.event,
    sdkUuid: input.sdkUuid ?? null,
    clientMessageId: input.clientMessageId ?? null,
    createdAt: input.now,
  };
}

/** Append one replay event. `id` = `<sessionId>:<seq>` (the dedup key the UI
 *  keys on). */
export function appendConversationEvent(input: AppendConversationEventInput): ConversationEventRow {
  const row = toRow(input);
  getDb().insert(conversationEvents).values(row).run();
  return row;
}

/** Bulk import — one txn for the batch. */
export function appendConversationEvents(rows: readonly AppendConversationEventInput[]): number {
  if (rows.length === 0) return 0;
  const db = getDb();
  db.transaction((tx) => {
    for (const input of rows) {
      tx.insert(conversationEvents).values(toRow(input)).run();
    }
  });
  return rows.length;
}

/** Writer resume state: the next free seq for a session (the seq allocator's
 *  authority across a restart). */
export function getConversationReplayState(sessionId: string): { nextSeq: number } {
  const row = getDb()
    .select({ maxSeq: max(conversationEvents.seq) })
    .from(conversationEvents)
    .where(eq(conversationEvents.sessionId, sessionId))
    .get();
  return { nextSeq: (row?.maxSeq ?? 0) + 1 };
}

/** Replay read: a session's events ordered by seq; `afterSeq` returns only
 *  rows past the cursor; `limit` caps oldest-first. */
export function listConversationEvents(
  sessionId: string,
  opts: { afterSeq?: number; limit?: number } = {},
): ConversationEventRow[] {
  const afterSeq =
    opts.afterSeq !== undefined && Number.isSafeInteger(opts.afterSeq) && opts.afterSeq > 0
      ? opts.afterSeq
      : null;
  const where = afterSeq === null
    ? eq(conversationEvents.sessionId, sessionId)
    : and(eq(conversationEvents.sessionId, sessionId), gt(conversationEvents.seq, afterSeq));
  const base = getDb()
    .select()
    .from(conversationEvents)
    .where(where)
    .orderBy(asc(conversationEvents.seq));
  const limited =
    opts.limit !== undefined && Number.isSafeInteger(opts.limit) && opts.limit > 0
      ? base.limit(opts.limit)
      : base;
  return limited.all();
}

/** The session's replay high water (0 when empty). Stable across afterSeq
 *  reads — reconnect contracts depend on it. */
export function getConversationHighWaterSeq(sessionId: string): number {
  const row = getDb()
    .select({ maxSeq: max(conversationEvents.seq) })
    .from(conversationEvents)
    .where(eq(conversationEvents.sessionId, sessionId))
    .get();
  return row?.maxSeq ?? 0;
}

/** Row count for a session. */
export function countConversationEvents(sessionId: string): number {
  const row = getDb()
    .select({ n: count() })
    .from(conversationEvents)
    .where(eq(conversationEvents.sessionId, sessionId))
    .get();
  return row?.n ?? 0;
}

/** Backfill guard: true once ANY row exists for the session. */
export function hasConversationEvents(sessionId: string): boolean {
  const row = getDb()
    .select({ id: conversationEvents.id })
    .from(conversationEvents)
    .where(eq(conversationEvents.sessionId, sessionId))
    .limit(1)
    .get();
  return row !== undefined;
}
