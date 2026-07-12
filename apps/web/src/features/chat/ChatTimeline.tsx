// The message timeline: persisted frames (grouped) + live streaming buffers +
// optimistic sends + pending asks, one render pipeline. Auto-scrolls to the
// bottom while pinned. Read-only mode (past-session HTTP view) hides live
// buffers, optimistic sends, and ask cards.

import { useEffect, useMemo, useRef } from 'react';

import type { SessionReplayFrame } from '@pc/contracts';
import { buildRenderItems } from './chat-render';
import { RenderItemView, AssistantBubble } from './Bubbles';
import { AskCard } from './AskCard';
import { applyReplay, initialChatState, type ChatState } from './chat-reducer';
import { sequenceToArray } from './persistent-sequence';
import { ContextBar } from './ContextBar';

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
  }, [state.highWaterSequence, state.projectedThroughSequence, liveTextLength]);

  const empty = items.length === 0 && liveBuffers.length === 0 && state.asks.length === 0;

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
          state.asks.map((ask) => (
            <div key={ask.askId} className="border border-accent/40 bg-accent/5 px-3 py-2">
              <AskCard
                toolName={ask.toolName}
                callId={ask.callId}
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
export function PastSessionTimeline({ replay }: { replay: SessionReplayFrame }) {
  const state = useMemo<ChatState>(
    () => applyReplay(initialChatState(), replay),
    [replay],
  );
  return (
    <>
      <ChatTimeline state={state} readOnly />
      <div className="border-t border-border bg-card px-4 py-2">
        <ContextBar
          sessionId={state.sessionId}
          ready={state.contextProjectionReady}
          projection={state.contextProjection}
          readOnly
        />
      </div>
    </>
  );
}
