// Canonical conversation persistence. Sequence allocation, immutable event
// insert, and publication-outbox insert are one SQLite transaction.

import { and, asc, count, eq, gt, isNull, max, sql } from 'drizzle-orm';
import {
  conversationFamilyForEvent,
  isConversationEvent,
  type ConversationEvent,
  type ConversationFamily,
} from '@pc/contracts';
import type { ULID } from '@pc/domain';

import { getDb } from '../connection.ts';
import { newId } from '../id.ts';
import { conversationEvents, conversationOutbox, conversationSequences } from '../schema.ts';

export type ConversationEventRow = typeof conversationEvents.$inferSelect;
export type ConversationDeliveryKind = 'chat' | 'agent';

export interface CommitConversationEventInput {
  eventId?: string;
  projectId: ULID;
  /** CF-001 binds one app session to one conversation; future handoff may
   * intentionally group successor sessions under a shared conversation id. */
  conversationId: string;
  sessionId: string;
  family: ConversationFamily;
  event: ConversationEvent;
  turnId?: string | null;
  itemId: string;
  streamId?: string | null;
  deltaIndex?: number | null;
  clientMessageId?: string | null;
  occurredAt: number;
  deliveryKind: ConversationDeliveryKind;
}

export interface CommitConversationEventResult {
  event: ConversationEventRow;
  outboxSequence: number;
}

export interface ConversationOutboxEntry {
  outboxSequence: number;
  deliveryKind: ConversationDeliveryKind;
  event: ConversationEventRow;
}

export function commitConversationEvent(
  input: CommitConversationEventInput,
): CommitConversationEventResult {
  if (!input.projectId || !input.conversationId || !input.sessionId || !input.itemId) {
    throw new Error('projectId, conversationId, sessionId, and itemId are required');
  }
  if (input.eventId !== undefined && !input.eventId) throw new Error('eventId must be non-empty');
  if (input.turnId !== undefined && input.turnId !== null && !input.turnId) {
    throw new Error('turnId must be non-empty when provided');
  }
  if (input.streamId !== undefined && input.streamId !== null && !input.streamId) {
    throw new Error('streamId must be non-empty when provided');
  }
  if (input.clientMessageId !== undefined && input.clientMessageId !== null && !input.clientMessageId) {
    throw new Error('clientMessageId must be non-empty when provided');
  }
  if (!Number.isFinite(input.occurredAt)) throw new Error('occurredAt must be finite');
  if (!isConversationEvent(input.event)) throw new Error('invalid canonical conversation event');
  if (input.family !== conversationFamilyForEvent(input.event)) {
    throw new Error(`conversation family mismatch for ${input.event.kind}`);
  }
  const hasDeltaIndex = input.deltaIndex !== undefined && input.deltaIndex !== null;
  if (input.event.kind === 'stream-delta') {
    if (!hasDeltaIndex || !Number.isSafeInteger(input.deltaIndex) || input.deltaIndex! < 0 || !input.streamId) {
      throw new Error('stream-delta requires a non-empty streamId and non-negative deltaIndex');
    }
  } else if (hasDeltaIndex) {
    throw new Error('stable conversation events cannot carry deltaIndex');
  }
  const db = getDb();
  return db.transaction((tx) => {
    const cursor = tx
      .insert(conversationSequences)
      .values({
        conversationId: input.conversationId,
        projectId: input.projectId,
        nextSequence: 2,
        updatedAt: input.occurredAt,
      })
      .onConflictDoUpdate({
        target: conversationSequences.conversationId,
        set: {
          nextSequence: sql`${conversationSequences.nextSequence} + 1`,
          updatedAt: input.occurredAt,
        },
      })
      .returning({
        projectId: conversationSequences.projectId,
        nextSequence: conversationSequences.nextSequence,
      })
      .get();
    if (!cursor) throw new Error(`conversation sequence allocation failed: ${input.conversationId}`);
    if (cursor.projectId !== input.projectId) {
      throw new Error(`conversation project mismatch: ${input.conversationId}`);
    }
    const sequence = cursor.nextSequence - 1;
    const eventId = input.eventId ?? newId();
    const row: ConversationEventRow = {
      eventId,
      projectId: input.projectId,
      conversationId: input.conversationId,
      sessionId: input.sessionId,
      sequence,
      family: input.family,
      eventType: input.event.kind,
      turnId: input.turnId ?? null,
      itemId: input.itemId,
      streamId: input.streamId ?? null,
      deltaIndex: input.deltaIndex ?? null,
      payload: input.event,
      clientMessageId: input.clientMessageId ?? null,
      occurredAt: input.occurredAt,
      projectionState: 'visible',
    };
    tx.insert(conversationEvents).values(row).run();
    const outbox = tx
      .insert(conversationOutbox)
      .values({
        eventId,
        deliveryKind: input.deliveryKind,
        createdAt: input.occurredAt,
        relayedAt: null,
      })
      .returning({ outboxSequence: conversationOutbox.outboxSequence })
      .get();
    if (!outbox) throw new Error(`conversation outbox insert disappeared: ${eventId}`);
    return { event: row, outboxSequence: outbox.outboxSequence };
  });
}

export function listConversationEvents(
  conversationId: string,
  opts: { afterSequence?: number; limit?: number } = {},
): ConversationEventRow[] {
  const after =
    opts.afterSequence !== undefined && Number.isSafeInteger(opts.afterSequence) && opts.afterSequence > 0
      ? opts.afterSequence
      : null;
  const visible = eq(conversationEvents.projectionState, 'visible');
  const where = after === null
    ? and(eq(conversationEvents.conversationId, conversationId), visible)
    : and(
        eq(conversationEvents.conversationId, conversationId),
        visible,
        gt(conversationEvents.sequence, after),
      );
  const base = getDb()
    .select()
    .from(conversationEvents)
    .where(where)
    .orderBy(asc(conversationEvents.sequence));
  return opts.limit !== undefined && Number.isSafeInteger(opts.limit) && opts.limit > 0
    ? base.limit(opts.limit).all()
    : base.all();
}

/** Evidence/migration inspection only. Product replay must use the visible
 * query above so retained private-reasoning history is never projected. */
export function listConversationEventsRaw(conversationId: string): ConversationEventRow[] {
  return getDb()
    .select()
    .from(conversationEvents)
    .where(eq(conversationEvents.conversationId, conversationId))
    .orderBy(asc(conversationEvents.sequence))
    .all();
}

export function getConversationHighWaterSequence(conversationId: string): number {
  const row = getDb()
    .select({ highest: max(conversationEvents.sequence) })
    .from(conversationEvents)
    .where(eq(conversationEvents.conversationId, conversationId))
    .get();
  return row?.highest ?? 0;
}

export function countConversationEvents(conversationId: string): number {
  const row = getDb()
    .select({ n: count() })
    .from(conversationEvents)
    .where(
      and(
        eq(conversationEvents.conversationId, conversationId),
        eq(conversationEvents.projectionState, 'visible'),
      ),
    )
    .get();
  return row?.n ?? 0;
}

export function hasConversationEvents(conversationId: string): boolean {
  return countConversationEvents(conversationId) > 0;
}

export function listUnrelayedConversationEvents(limit = 500): ConversationOutboxEntry[] {
  const db = getDb();
  const pending = db
    .select({
      outboxSequence: conversationOutbox.outboxSequence,
      eventId: conversationOutbox.eventId,
      deliveryKind: conversationOutbox.deliveryKind,
    })
    .from(conversationOutbox)
    .where(isNull(conversationOutbox.relayedAt))
    .orderBy(asc(conversationOutbox.outboxSequence))
    .limit(Math.max(1, Math.min(500, Math.trunc(limit))))
    .all();
  return pending.map((entry) => {
    const event = db
      .select()
      .from(conversationEvents)
      .where(eq(conversationEvents.eventId, entry.eventId))
      .get();
    if (!event) throw new Error(`conversation outbox references missing event: ${entry.eventId}`);
    return { outboxSequence: entry.outboxSequence, deliveryKind: entry.deliveryKind, event };
  });
}

export function markConversationEventsRelayed(
  outboxSequences: readonly number[],
  relayedAt = Date.now(),
): void {
  const db = getDb();
  db.transaction((tx) => {
    for (const outboxSequence of outboxSequences) {
      tx.update(conversationOutbox)
        .set({ relayedAt })
        .where(eq(conversationOutbox.outboxSequence, outboxSequence))
        .run();
    }
  });
}
