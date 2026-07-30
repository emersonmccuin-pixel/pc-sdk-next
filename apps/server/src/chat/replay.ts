// The only canonical row-to-wire mapper. Live outbox relay, WS replay, and
// past-session HTTP all use this function.

import {
  getOrchestratorSession,
  listConversationEvents,
  runtimeSelectionForSession,
  type ConversationEventRow,
  type OrchestratorSessionRow,
} from '@pc/db';
import type {
  ConversationEvent,
  ConversationEventFrame,
  PriorSessionTranscriptBlock,
} from '@pc/contracts';

/** Chain-walk depth cap for `priorSessionTranscript`. A future cross-account
 * handoff chain shares this same cap — bounded regardless of how many
 * selection changes or handoffs a conversation has accumulated. */
export const PRIOR_TRANSCRIPT_MAX_CHAIN_DEPTH = 20;

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

/** Walk `session.sourceSessionId` back through a same-runtime, same-account
 * native-continuation chain (Phase 1) — a future cross-account handoff link
 * reuses the same column and walk. Oldest source first, so the caller can
 * render them ahead of the live transcript in chronological order. Depth is
 * bounded by `PRIOR_TRANSCRIPT_MAX_CHAIN_DEPTH`; a cycle (which the durable
 * transition never produces) also stops the walk rather than looping. */
export function priorSessionTranscript(
  session: OrchestratorSessionRow,
  maxDepth = PRIOR_TRANSCRIPT_MAX_CHAIN_DEPTH,
): PriorSessionTranscriptBlock[] {
  const blocks: PriorSessionTranscriptBlock[] = [];
  const seen = new Set<string>([session.id]);
  let cursorId = session.sourceSessionId;
  let depth = 0;
  while (cursorId && depth < maxDepth && !seen.has(cursorId)) {
    seen.add(cursorId);
    const row = getOrchestratorSession(cursorId);
    if (!row) break;
    blocks.push({
      sessionId: row.id,
      selection: runtimeSelectionForSession(row),
      events: replayConversationEvents(row.id),
    });
    cursorId = row.sourceSessionId;
    depth += 1;
  }
  return blocks.reverse();
}
