// Canonical conversation persistence. Sequence allocation, immutable event
// insert, and publication-outbox insert are one SQLite transaction.

import { and, asc, count, desc, eq, gt, inArray, isNull, max, sql } from 'drizzle-orm';
import {
  conversationFamilyForEvent,
  isConversationEvent,
  isTerminalToolState,
  toolStateTransitionError,
  type ConversationEvent,
  type ConversationFamily,
  type ToolStateEvent,
} from '@pc/contracts';
import type { ULID } from '@pc/domain';

import { getDb, type DbTransaction } from '../connection.ts';
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

export interface CloseOpenConversationToolCallsInput {
  conversationId: string;
  /** Omit to close every open call in the conversation (agent-run recovery). */
  turnId?: string;
  reason: 'turn-ended' | 'runtime-lost';
  deliveryKind: ConversationDeliveryKind;
  occurredAt?: number;
}

export function commitConversationEvent(
  input: CommitConversationEventInput,
): CommitConversationEventResult {
  validateConversationEventInput(input);
  return getDb().transaction((tx) => commitConversationEventInDb(input, tx));
}

/** Executor-aware atomic seam for a Conversation-owned unit of work that must
 * commit its state transition and canonical event/outbox rows together. */
export function commitConversationEventInDb(
  input: CommitConversationEventInput,
  tx: DbTransaction,
): CommitConversationEventResult {
  validateConversationEventInput(input);
  validateTurnIsOpenInDb(input, tx);
  validateContextObservationInDb(input, tx);
  validateToolTransitionInDb(input, tx);
  if (input.event.kind === 'turn-end' || input.event.kind === 'turn-failed') {
    closeOpenConversationToolCallsInDb({
      conversationId: input.conversationId,
      ...(input.turnId ? { turnId: input.turnId } : {}),
      reason: 'turn-ended',
      deliveryKind: input.deliveryKind,
      occurredAt: input.occurredAt,
    }, tx);
  }
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
}

function validateTurnIsOpenInDb(
  input: CommitConversationEventInput,
  tx: DbTransaction,
): void {
  if (input.event.kind !== 'activity-state' && input.event.kind !== 'tool-state') return;
  const terminal = tx
    .select({ eventId: conversationEvents.eventId })
    .from(conversationEvents)
    .where(and(
      eq(conversationEvents.conversationId, input.conversationId),
      eq(conversationEvents.turnId, input.turnId!),
      inArray(conversationEvents.eventType, ['turn-end', 'turn-failed']),
      eq(conversationEvents.projectionState, 'visible'),
    ))
    .limit(1)
    .get();
  if (terminal) throw new Error(`turn already terminal: ${input.turnId}`);
}

function validateContextObservationInDb(
  input: CommitConversationEventInput,
  tx: DbTransaction,
): void {
  if (input.event.kind !== 'context-observation') return;
  const terminal = tx
    .select({ eventId: conversationEvents.eventId })
    .from(conversationEvents)
    .where(and(
      eq(conversationEvents.projectId, input.projectId),
      eq(conversationEvents.conversationId, input.conversationId),
      eq(conversationEvents.sessionId, input.sessionId),
      eq(conversationEvents.turnId, input.turnId!),
      inArray(conversationEvents.eventType, ['turn-end', 'turn-failed']),
      eq(conversationEvents.projectionState, 'visible'),
    ))
    .limit(1)
    .get();
  if (!terminal) {
    throw new Error(`context observation requires a settled terminal: ${input.turnId}`);
  }

  const previous = tx
    .select({ eventId: conversationEvents.eventId })
    .from(conversationEvents)
    .where(and(
      eq(conversationEvents.projectId, input.projectId),
      eq(conversationEvents.conversationId, input.conversationId),
      eq(conversationEvents.sessionId, input.sessionId),
      eq(conversationEvents.turnId, input.turnId!),
      eq(conversationEvents.eventType, 'context-observation'),
    ))
    .limit(1)
    .get();
  if (previous) {
    throw new Error(`context observation already exists for turn: ${input.turnId}`);
  }
}

function validateToolTransitionInDb(
  input: CommitConversationEventInput,
  tx: DbTransaction,
): void {
  if (input.event.kind !== 'tool-state') return;
  if (input.itemId !== input.event.callId) {
    throw new Error(`tool item/call identity mismatch: ${input.event.callId}`);
  }
  const previous = tx
    .select()
    .from(conversationEvents)
    .where(and(
      eq(conversationEvents.conversationId, input.conversationId),
      eq(conversationEvents.itemId, input.event.callId),
      eq(conversationEvents.eventType, 'tool-state'),
      eq(conversationEvents.projectionState, 'visible'),
    ))
    .orderBy(desc(conversationEvents.sequence))
    .limit(1)
    .get();
  if (previous) {
    if (
      previous.projectId !== input.projectId ||
      previous.sessionId !== input.sessionId ||
      previous.turnId !== (input.turnId ?? null)
    ) {
      throw new Error(`tool ownership changed: ${input.event.callId}`);
    }
    const priorEvent = previous.payload;
    if (!isConversationEvent(priorEvent) || priorEvent.kind !== 'tool-state') {
      throw new Error(`invalid prior tool event: ${input.event.callId}`);
    }
    const transitionError = toolStateTransitionError(priorEvent, input.event);
    if (transitionError) {
      throw new Error(`invalid tool transition ${input.event.callId}: ${transitionError}`);
    }
    return;
  }
  const transitionError = toolStateTransitionError(null, input.event);
  if (transitionError) {
    throw new Error(`invalid tool transition ${input.event.callId}: ${transitionError}`);
  }
}

/** Close every nonterminal call through the same event/outbox transaction.
 * Turn settlement calls the in-DB variant before its terminal event; boot
 * recovery for lost specialist runs uses the public wrapper. */
export function closeOpenConversationToolCalls(
  input: CloseOpenConversationToolCallsInput,
): number {
  return getDb().transaction((tx) => closeOpenConversationToolCallsInDb(input, tx));
}

export function closeOpenConversationToolCallsInDb(
  input: CloseOpenConversationToolCallsInput,
  tx: DbTransaction,
): number {
  const where = input.turnId === undefined
    ? and(
        eq(conversationEvents.conversationId, input.conversationId),
        eq(conversationEvents.eventType, 'tool-state'),
        eq(conversationEvents.projectionState, 'visible'),
      )
    : and(
        eq(conversationEvents.conversationId, input.conversationId),
        eq(conversationEvents.turnId, input.turnId),
        eq(conversationEvents.eventType, 'tool-state'),
        eq(conversationEvents.projectionState, 'visible'),
      );
  const rows = tx
    .select()
    .from(conversationEvents)
    .where(where)
    .orderBy(asc(conversationEvents.sequence))
    .all();
  const latest = new Map<string, ConversationEventRow>();
  for (const row of rows) latest.set(row.itemId, row);
  const open = [...latest.values()]
    .filter((row) => {
      const event = row.payload;
      return isConversationEvent(event) && event.kind === 'tool-state' && !isTerminalToolState(event.state);
    })
    .sort((left, right) => left.sequence - right.sequence);
  const occurredAt = input.occurredAt ?? Date.now();
  for (const row of open) {
    const previous = row.payload as ToolStateEvent;
    let event: ToolStateEvent;
    if (previous.state === 'approval-needed') {
      if (previous.approval.status !== 'pending') {
        throw new Error(`invalid pending approval snapshot: ${previous.callId}`);
      }
      event = {
          ...previous,
          state: 'denied',
          approval: {
            status: 'denied',
            source: 'session',
            requestId: previous.approval.requestId,
          },
          outcome: null,
        };
    } else {
      event = {
          ...previous,
          state: 'failed',
          outcome: { reason: input.reason },
        };
    }
    commitConversationEventInDb({
      projectId: row.projectId,
      conversationId: row.conversationId,
      sessionId: row.sessionId,
      family: 'tool',
      event,
      turnId: row.turnId,
      itemId: event.callId,
      occurredAt,
      deliveryKind: input.deliveryKind,
    }, tx);
  }
  return open.length;
}

function validateConversationEventInput(input: CommitConversationEventInput): void {
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
  if (
    (
      input.event.kind === 'activity-state'
      || input.event.kind === 'tool-state'
      || input.event.kind === 'turn-end'
      || input.event.kind === 'turn-failed'
      || input.event.kind === 'context-observation'
    )
    && !input.turnId
  ) throw new Error(`${input.event.kind} requires a non-empty turnId`);
  const hasDeltaIndex = input.deltaIndex !== undefined && input.deltaIndex !== null;
  if (input.event.kind === 'stream-delta') {
    if (!hasDeltaIndex || !Number.isSafeInteger(input.deltaIndex) || input.deltaIndex! < 0 || !input.streamId) {
      throw new Error('stream-delta requires a non-empty streamId and non-negative deltaIndex');
    }
  } else if (hasDeltaIndex) {
    throw new Error('stable conversation events cannot carry deltaIndex');
  }
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
