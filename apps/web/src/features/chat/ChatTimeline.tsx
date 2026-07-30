// The message timeline: persisted frames (grouped) + live streaming buffers +
// optimistic sends + pending asks, one render pipeline. Auto-scrolls to the
// bottom while pinned. Read-only mode (past-session HTTP view) hides live
// buffers, optimistic sends, and ask cards.

import { useEffect, useMemo, useRef } from 'react';

import type { PriorSessionTranscriptBlock, RuntimeSelection, SessionReplayFrame } from '@pc/contracts';
import { buildRenderItems } from './chat-render';
import { RenderItemView, AssistantBubble } from './Bubbles';
import { AskCard } from './AskCard';
import { applyReplay, initialChatState, type ChatState } from './chat-reducer';
import { sequenceToArray } from './persistent-sequence';
import { ContextBar } from './ContextBar';

function shortSelection(selection: RuntimeSelection | null | undefined): string {
  if (!selection) return 'unknown selection';
  const effort = selection.effort.kind === 'selected' ? ` (${selection.effort.value})` : '';
  return `${selection.model}${effort}`;
}

/** "sonnet -> opus"-style label for the divider between two selections in a
 *  continuation chain — either a same-runtime, same-account model/effort
 *  continuation, or a same-runtime cross-account context handoff (Phase 2).
 *  Provider-neutral — never branches on runtimeId, only formats whichever of
 *  the account or the model/effort actually changed. An account change wins
 *  the label (docs/agent-runtime-architecture.md "Sessions and switching":
 *  the account, not the model, is the meaningful delta for a handoff). */
export function selectionDeltaLabel(
  from: RuntimeSelection | null | undefined,
  to: RuntimeSelection | null | undefined,
): string {
  if (from && to && from.accountId !== to.accountId) {
    return `account: ${from.accountId} → ${to.accountId}`;
  }
  return `${shortSelection(from)} → ${shortSelection(to)}`;
}

function SelectionDivider({ label }: { label: string }) {
  return (
    <div className="flex items-center gap-2 py-1 text-[10px] uppercase tracking-wider text-muted-foreground/70">
      <span className="h-px flex-1 bg-border" />
      <span>{label}</span>
      <span className="h-px flex-1 bg-border" />
    </div>
  );
}

/** Read-only, dimmed transcript from each prior app session a same-runtime,
 *  same-account selection change native-continued from — oldest first, one
 *  divider per selection change, so a model/effort switch is visible
 *  provenance rather than a silent seam. Renders nothing when there is no
 *  continuation chain. `liveSelection` labels the trailing divider into the
 *  live/current transcript; omit it (e.g. a past-session view that hasn't
 *  fetched its own selection) to fall back to "unknown selection". */
function PriorTranscriptBlocks({
  blocks,
  liveSelection,
}: {
  blocks: PriorSessionTranscriptBlock[];
  liveSelection?: RuntimeSelection | null;
}) {
  if (blocks.length === 0) return null;
  return (
    <div className="flex flex-col gap-2 opacity-60">
      {blocks.map((block, index) => (
        <div key={block.sessionId} className="flex flex-col gap-2">
          {index > 0 && (
            <SelectionDivider label={selectionDeltaLabel(blocks[index - 1]!.selection, block.selection)} />
          )}
          {buildRenderItems(block.events).map((item) => (
            <RenderItemView key={item.key} item={item} />
          ))}
        </div>
      ))}
      <SelectionDivider label={selectionDeltaLabel(blocks.at(-1)!.selection, liveSelection)} />
    </div>
  );
}

export function ChatTimeline({
  state,
  onAskReply,
  readOnly,
  liveSelection,
}: {
  state: ChatState;
  onAskReply?: (askId: string, answer: string) => void;
  readOnly?: boolean;
  /** The live/current session's own selection — only used to label the
   *  trailing continuation-chain divider (see PriorTranscriptBlocks). */
  liveSelection?: RuntimeSelection | null;
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
        {empty && state.priorTranscript.length === 0 && (
          <div className="grid place-items-center py-16 text-center text-sm text-muted-foreground">
            {readOnly ? 'No events in this session.' : 'Send a message to start the conversation.'}
          </div>
        )}

        <PriorTranscriptBlocks blocks={state.priorTranscript} liveSelection={liveSelection} />

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
      {/* This past session's own selection isn't fetched separately here, so
       *  the trailing continuation divider (if any) falls back to "unknown
       *  selection" rather than inventing it. */}
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
