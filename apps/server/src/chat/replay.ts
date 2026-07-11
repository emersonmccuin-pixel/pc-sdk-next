// The only canonical row-to-wire mapper. Live outbox relay, WS replay, and
// past-session HTTP all use this function.

import { listConversationEvents, type ConversationEventRow } from '@pc/db';
import type { ConversationEvent, ConversationEventFrame } from '@pc/contracts';

export function rowToConversationEventFrame(r: ConversationEventRow): ConversationEventFrame {
  return {
    type: 'conversation-event',
    eventId: r.eventId,
    projectId: r.projectId,
    conversationId: r.conversationId,
    sessionId: r.sessionId,
    sequence: r.sequence,
    family: r.family,
    itemId: r.itemId,
    occurredAt: r.occurredAt,
    event: r.payload as ConversationEvent,
    ...(r.turnId ? { turnId: r.turnId } : {}),
    ...(r.streamId ? { streamId: r.streamId } : {}),
    ...(r.deltaIndex !== null ? { deltaIndex: r.deltaIndex } : {}),
    ...(r.clientMessageId ? { clientMessageId: r.clientMessageId } : {}),
  };
}

export function replayConversationEvents(conversationId: string): ConversationEventFrame[] {
  return listConversationEvents(conversationId).map(rowToConversationEventFrame);
}
