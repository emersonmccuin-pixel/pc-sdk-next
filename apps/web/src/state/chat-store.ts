// The live chat store: a zustand wrapper over the pure reducer (chat-reducer.ts).
// One store, scoped to the shown project's active session. The ws-client feeds
// server frames in via `ingest`; the composer adds optimistic sends and answers
// asks. All timeline logic lives in the reducer — do NOT grow a second one here.

import { create } from 'zustand';
import type {
  AskFrame,
  ConversationEventFrame,
  SendAckFrame,
  SendQueueSnapshotFrame,
  SessionChangedFrame,
  SessionReplayFrame,
} from '@pc/contracts';

import {
  addOptimistic,
  answerAsk,
  applyAsk,
  applyConversationEvent,
  applyReplay,
  applySendAck,
  applySendQueueSnapshot,
  applySessionChanged,
  initialChatState,
  type ChatState,
} from '@/features/chat/chat-reducer';

/** Channel-1 frames the chat store owns. Resource/usage/mcp/orchestrator frames
 *  are routed elsewhere by the ws-client. */
export type ChatChannelFrame =
  | ConversationEventFrame
  | SessionChangedFrame
  | SessionReplayFrame
  | SendAckFrame
  | SendQueueSnapshotFrame
  | AskFrame;

interface ChatStore {
  state: ChatState;
  ingest: (frame: ChatChannelFrame) => void;
  addOptimistic: (clientMessageId: string, text: string) => void;
  answerAsk: (askId: string, answer: string) => void;
  reset: (sessionId?: string | null) => void;
}

export const useChatStore = create<ChatStore>((set) => ({
  state: initialChatState(),
  ingest: (frame) =>
    set((s) => {
      switch (frame.type) {
        case 'conversation-event':
          return { state: applyConversationEvent(s.state, frame) };
        case 'session-replay':
          return { state: applyReplay(s.state, frame) };
        case 'session-changed':
          return { state: applySessionChanged(s.state, frame) };
        case 'send-ack':
          return { state: applySendAck(s.state, frame) };
        case 'send-queue-snapshot':
          return { state: applySendQueueSnapshot(s.state, frame) };
        case 'ask':
          return { state: applyAsk(s.state, frame) };
        default:
          return s;
      }
    }),
  addOptimistic: (clientMessageId, text) =>
    set((s) => ({ state: addOptimistic(s.state, clientMessageId, text) })),
  answerAsk: (askId, answer) => set((s) => ({ state: answerAsk(s.state, askId, answer) })),
  reset: (sessionId = null) => set({ state: initialChatState(sessionId) }),
}));
