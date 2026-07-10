// Replay-frame mapper. The one place conversation_events rows become ChatFrames.
// Replay shape === live shape (docs/event-contract.md): HTTP replay and WS
// session-replay both go through here so a past session renders identically.

import { listConversationEvents, type ConversationEventRow } from '@pc/db';
import type { ChatEvent, ChatFrame, ULID } from '@pc/contracts';

export function rowToChatFrame(projectId: ULID, sessionId: string, r: ConversationEventRow): ChatFrame {
  return {
    type: 'chat',
    projectId,
    sessionId,
    seq: r.seq,
    id: `${sessionId}:${r.seq}`,
    event: r.event as ChatEvent,
    ...(r.sdkUuid ? { sdkUuid: r.sdkUuid } : {}),
    ...(r.clientMessageId ? { clientMessageId: r.clientMessageId } : {}),
  };
}

export function replayFrames(projectId: ULID, sessionId: string): ChatFrame[] {
  return listConversationEvents(sessionId).map((r) => rowToChatFrame(projectId, sessionId, r));
}
