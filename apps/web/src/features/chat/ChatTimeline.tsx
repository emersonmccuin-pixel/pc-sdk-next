// The message timeline: persisted frames (grouped) + live streaming buffers +
// optimistic sends + pending asks, one render pipeline. Auto-scrolls to the
// bottom while pinned. Read-only mode (past-session HTTP view) hides live
// buffers, optimistic sends, and ask cards.

import { useEffect, useMemo, useRef } from 'react';

import type { ConversationEventFrame } from '@pc/contracts';
import { buildRenderItems } from './chat-render';
import { RenderItemView, AssistantBubble, UserBubble } from './Bubbles';
import { AskCard } from './AskCard';
import { applyReplay, initialChatState, type ChatState } from './chat-reducer';
import { sequenceToArray } from './persistent-sequence';

export function ChatTimeline({
  state,
  onAskReply,
  readOnly,
}: {
  state: ChatState;
  onAskReply?: (askId: string, answer: string) => void;
  readOnly?: boolean;
}) {
  const items = useMemo(
    () => buildRenderItems(sequenceToArray(state.projectedFrames)),
    [state.projectedFrames],
  );
  const liveBuffers = useMemo(() => Object.values(state.deltas).filter((b) => b.text), [state.deltas]);

  const bottomRef = useRef<HTMLDivElement | null>(null);
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const pinnedRef = useRef(true);

  const liveTextLength = liveBuffers.reduce((length, buffer) => length + buffer.text.length, 0);
  useEffect(() => {
    if (pinnedRef.current) bottomRef.current?.scrollIntoView({ block: 'end' });
  }, [state.highWaterSequence, state.projectedThroughSequence, liveTextLength, state.optimistic.length]);

  const empty = items.length === 0 && liveBuffers.length === 0 && state.optimistic.length === 0 && state.asks.length === 0;

  return (
    <div
      ref={scrollRef}
      onScroll={(e) => {
        const el = e.currentTarget;
        pinnedRef.current = el.scrollHeight - el.scrollTop - el.clientHeight < 80;
      }}
      className="flex-1 overflow-y-auto"
    >
      <div className="flex max-w-none flex-col gap-2 px-4 py-4">
        {empty && (
          <div className="grid place-items-center py-16 text-center text-sm text-muted-foreground">
            {readOnly ? 'No events in this session.' : 'Send a message to start the conversation.'}
          </div>
        )}

        {items.map((item) => (
          <RenderItemView key={item.key} item={item} />
        ))}

        {!readOnly &&
          liveBuffers.map((b) => (
            <div key={`live-${b.streamId}`} className="flex flex-col gap-2">
              {b.text && <AssistantBubble text={b.text} live />}
            </div>
          ))}

        {!readOnly &&
          state.optimistic.map((o) => (
            <UserBubble
              key={`opt-${o.clientMessageId}`}
              text={o.text}
              pending={o.status === 'failed' ? 'failed' : o.status === 'queued' ? 'queued' : 'sending'}
            />
          ))}

        {!readOnly &&
          state.asks.map((ask) => (
            <div key={ask.askId} className="border border-accent/40 bg-accent/5 px-3 py-2">
              <AskCard
                toolName={ask.toolName}
                toolUseId={ask.toolUseId}
                toolInput={ask.toolInput}
                answered={state.answeredAsks[ask.askId]}
                onReply={(answer) => onAskReply?.(ask.askId, answer)}
              />
            </div>
          ))}

        <div ref={bottomRef} />
      </div>
    </div>
  );
}

/** Read-only timeline for a past session fetched over HTTP: reuses the exact
 *  render pipeline by seeding a bare ChatState from the fetched frames. */
export function PastSessionTimeline({ frames }: { frames: ConversationEventFrame[] }) {
  const state = useMemo<ChatState>(
    () => applyReplay(initialChatState(), {
      type: 'session-replay',
      projectId: frames[0]?.projectId ?? '',
      sessionId: frames[0]?.sessionId ?? '',
      highWaterSequence: frames.reduce((highest, frame) => Math.max(highest, frame.sequence), 0),
      events: frames,
    }),
    [frames],
  );
  return <ChatTimeline state={state} readOnly />;
}
