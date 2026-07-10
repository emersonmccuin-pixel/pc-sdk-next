// The chat reducer — the event contract, exactly. Pure (no React, no zustand)
// so it runs under `tsx --test` and its invariants are guard-tested directly.
//
// Rules (docs/event-contract.md §Channel 1):
//   1. Ordered dedup by `sessionId:seq` — out-of-order arrivals insert into seq
//      position; a duplicate `seq` REPLACES the frame WITHOUT re-folding
//      aggregates (re-delivery must never double-count tokens).
//   2. Aggregate folding: usage totals, latest model, session state, last turn
//      duration — folded once, on first arrival of each seq.
//   3. Streaming deltas buffer per `sdkUuid`; the buffer is discarded the moment
//      the persisted `chat` frame with that `sdkUuid` lands (final block wins).
//   4. `session-replay` re-seeds the timeline wholesale and RECOMPUTES aggregates
//      from the set (never carried forward).
//   5. `retract` evicts already-delivered events by `sdkUuid`.
//   6. Send reconcile: optimistic sends clear on the `clientMessageId`-stamped
//      canonical user frame or a `delivered` send-queue item — no fuzzy text match.
//   7. `session-changed` wipes the timeline (new-session) / resets for resume.

import type {
  AskFrame,
  ChatDeltaFrame,
  ChatEvent,
  ChatFrame,
  SendAckFrame,
  SendQueueItem,
  SendQueueSnapshotFrame,
  SessionChangedFrame,
  SessionReplayFrame,
} from '@pc/contracts';

// ── State shapes ──────────────────────────────────────────────────────────────

export interface Aggregates {
  inputTokens: number;
  outputTokens: number;
  cacheCreationTokens: number;
  cacheReadTokens: number;
  latestModel: string | null;
  sessionState: 'idle' | 'running' | 'requires_action' | null;
  permissionMode: string | null;
  lastTurnDurationMs: number | null;
}

/** One in-flight assistant message, assembled from `chat-delta` frames. Lives
 *  only until the persisted `chat` frame with the same `sdkUuid` arrives. */
export interface DeltaBuffer {
  sdkUuid: string;
  text: string;
  thinking: string;
  /** Accumulated partial tool-input JSON, keyed by toolUseId ('' when absent). */
  toolInput: Record<string, string>;
  ended: boolean;
}

export type OptimisticStatus =
  | 'sending'
  | 'queued'
  | 'delivering'
  | 'delivered'
  | 'failed'
  | 'cancelled';

/** A user send the composer showed immediately, before the server confirmed it. */
export interface OptimisticSend {
  clientMessageId: string;
  text: string;
  status: OptimisticStatus;
  failureReason: string | null;
}

export interface ChatState {
  sessionId: string | null;
  highWaterSeq: number;
  /** Active session only, sorted ascending by seq. */
  frames: ChatFrame[];
  aggregates: Aggregates;
  /** In-flight streaming buffers, keyed by sdkUuid. */
  deltas: Record<string, DeltaBuffer>;
  /** Latest send-queue snapshot (snapshot replaces snapshot). */
  sendQueue: SendQueueItem[];
  /** Local-only sends awaiting reconcile. */
  optimistic: OptimisticSend[];
  /** Pending permission asks, keyed by askId. */
  asks: AskFrame[];
  answeredAsks: Record<string, string>;
}

export function emptyAggregates(): Aggregates {
  return {
    inputTokens: 0,
    outputTokens: 0,
    cacheCreationTokens: 0,
    cacheReadTokens: 0,
    latestModel: null,
    sessionState: null,
    permissionMode: null,
    lastTurnDurationMs: null,
  };
}

export function initialChatState(sessionId: string | null = null): ChatState {
  return {
    sessionId,
    highWaterSeq: 0,
    frames: [],
    aggregates: emptyAggregates(),
    deltas: {},
    sendQueue: [],
    optimistic: [],
    asks: [],
    answeredAsks: {},
  };
}

// ── Aggregate folding ─────────────────────────────────────────────────────────

function foldAggregate(agg: Aggregates, event: ChatEvent): Aggregates {
  switch (event.kind) {
    case 'usage':
      return {
        ...agg,
        inputTokens: agg.inputTokens + event.inputTokens,
        outputTokens: agg.outputTokens + event.outputTokens,
        cacheCreationTokens: agg.cacheCreationTokens + event.cacheCreationTokens,
        cacheReadTokens: agg.cacheReadTokens + event.cacheReadTokens,
        latestModel: event.model ?? agg.latestModel,
      };
    case 'turn-duration':
      return { ...agg, lastTurnDurationMs: event.durationMs };
    case 'session-state':
      return { ...agg, sessionState: event.state, permissionMode: event.permissionMode };
    default:
      return agg;
  }
}

export function recomputeAggregates(frames: readonly ChatFrame[]): Aggregates {
  let agg = emptyAggregates();
  for (const f of frames) agg = foldAggregate(agg, f.event);
  return agg;
}

// ── Frame insertion ───────────────────────────────────────────────────────────

/** Index of the frame with this seq, or -1. */
function seqIndex(frames: readonly ChatFrame[], seq: number): number {
  for (let i = frames.length - 1; i >= 0; i--) {
    if (frames[i]!.seq === seq) return i;
    if (frames[i]!.seq < seq) return -1; // sorted — no earlier match possible
  }
  return -1;
}

function insertBySeq(frames: readonly ChatFrame[], frame: ChatFrame): ChatFrame[] {
  const next = frames.slice();
  let i = next.length;
  while (i > 0 && next[i - 1]!.seq > frame.seq) i--;
  next.splice(i, 0, frame);
  return next;
}

function omit<T>(map: Record<string, T>, key: string): Record<string, T> {
  if (!(key in map)) return map;
  const next = { ...map };
  delete next[key];
  return next;
}

// ── Chat frame ────────────────────────────────────────────────────────────────

export function applyChatFrame(state: ChatState, frame: ChatFrame): ChatState {
  // Frames for a non-active session are dropped client-side.
  if (state.sessionId !== null && frame.sessionId !== state.sessionId) return state;

  const existing = seqIndex(state.frames, frame.seq);
  if (existing !== -1) {
    // Rule 1: duplicate seq REPLACES without re-folding aggregates.
    const frames = state.frames.slice();
    frames[existing] = frame;
    const deltas = frame.sdkUuid ? omit(state.deltas, frame.sdkUuid) : state.deltas;
    return { ...state, frames, deltas };
  }

  // New seq — insert in order, fold aggregates once.
  let frames = insertBySeq(state.frames, frame);
  let aggregates = foldAggregate(state.aggregates, frame.event);
  // Rule 3: the persisted block supersedes any live buffer for its sdkUuid.
  let deltas = frame.sdkUuid ? omit(state.deltas, frame.sdkUuid) : state.deltas;

  // Rule 5: retract evicts already-delivered events by sdkUuid.
  if (frame.event.kind === 'retract') {
    const evict = new Set(frame.event.uuids);
    frames = frames.filter(
      (f) => f.event.kind === 'retract' || !(f.sdkUuid && evict.has(f.sdkUuid)),
    );
    for (const u of frame.event.uuids) deltas = omit(deltas, u);
    aggregates = recomputeAggregates(frames);
  }

  // Rule 6: the canonical clientMessageId-stamped user frame clears its optimistic.
  let optimistic = state.optimistic;
  if (frame.event.kind === 'user' && frame.clientMessageId) {
    const cid = frame.clientMessageId;
    optimistic = optimistic.filter((o) => o.clientMessageId !== cid);
  }

  const highWaterSeq = Math.max(state.highWaterSeq, frame.seq);
  return { ...state, frames, aggregates, deltas, optimistic, highWaterSeq };
}

// ── Streaming delta ───────────────────────────────────────────────────────────

export function applyDelta(state: ChatState, frame: ChatDeltaFrame): ChatState {
  if (state.sessionId !== null && frame.sessionId !== state.sessionId) return state;
  // Final block already landed → ignore late deltas (dedupe by sdkUuid).
  if (state.frames.some((f) => f.sdkUuid === frame.sdkUuid)) return state;

  const prev =
    state.deltas[frame.sdkUuid] ??
    ({ sdkUuid: frame.sdkUuid, text: '', thinking: '', toolInput: {}, ended: false } satisfies DeltaBuffer);
  const buf: DeltaBuffer = { ...prev, toolInput: { ...prev.toolInput } };

  switch (frame.event.kind) {
    case 'message-start':
      break;
    case 'text-delta':
      buf.text += frame.event.text;
      break;
    case 'thinking-delta':
      buf.thinking += frame.event.text;
      break;
    case 'tool-input-delta': {
      const key = frame.event.toolUseId ?? '';
      buf.toolInput[key] = (buf.toolInput[key] ?? '') + frame.event.partialJson;
      break;
    }
    case 'message-end':
      buf.ended = true;
      break;
  }
  return { ...state, deltas: { ...state.deltas, [frame.sdkUuid]: buf } };
}

// ── Session replay (rule 4) ───────────────────────────────────────────────────

export function applyReplay(state: ChatState, frame: SessionReplayFrame): ChatState {
  const frames = frame.events.slice().sort((a, b) => a.seq - b.seq);
  const aggregates = recomputeAggregates(frames);
  const persisted = new Set(frames.map((f) => f.sdkUuid).filter((u): u is string => !!u));
  const deltas: Record<string, DeltaBuffer> = {};
  for (const [uuid, buf] of Object.entries(state.deltas)) {
    if (!persisted.has(uuid)) deltas[uuid] = buf;
  }
  return {
    ...state,
    sessionId: frame.sessionId,
    frames,
    aggregates,
    deltas,
    highWaterSeq: frame.highWaterSeq,
  };
}

// ── Session lifecycle (rule 7) ────────────────────────────────────────────────

export function applySessionChanged(state: ChatState, frame: SessionChangedFrame): ChatState {
  // Both transitions reset the timeline; a session-replay reseeds resume.
  void state;
  return initialChatState(frame.session?.id ?? null);
}

// ── Send path ─────────────────────────────────────────────────────────────────

export function addOptimistic(state: ChatState, clientMessageId: string, text: string): ChatState {
  if (state.optimistic.some((o) => o.clientMessageId === clientMessageId)) return state;
  const send: OptimisticSend = { clientMessageId, text, status: 'sending', failureReason: null };
  return { ...state, optimistic: [...state.optimistic, send] };
}

export function applySendAck(state: ChatState, ack: SendAckFrame): ChatState {
  const optimistic = state.optimistic.map((o) => {
    if (o.clientMessageId !== ack.clientMessageId) return o;
    if (ack.status === 'queued') return { ...o, status: 'queued' as const };
    if (ack.status === 'invalid' || ack.status === 'error') {
      return { ...o, status: 'failed' as const, failureReason: ack.error ?? ack.status };
    }
    return o; // 'received' — stays optimistic until the canonical user frame lands
  });
  return { ...state, optimistic };
}

export function applySendQueueSnapshot(state: ChatState, frame: SendQueueSnapshotFrame): ChatState {
  const byCid = new Map(frame.items.map((it) => [it.clientMessageId, it] as const));
  const optimistic: OptimisticSend[] = [];
  for (const o of state.optimistic) {
    const item = byCid.get(o.clientMessageId);
    if (!item) {
      optimistic.push(o);
      continue;
    }
    if (item.status === 'delivered') continue; // reconciled — drop the placeholder
    optimistic.push({ ...o, status: item.status, failureReason: item.failureReason });
  }
  return { ...state, sendQueue: frame.items, optimistic };
}

// ── Asks ──────────────────────────────────────────────────────────────────────

export function applyAsk(state: ChatState, frame: AskFrame): ChatState {
  if (state.answeredAsks[frame.askId]) return state;
  if (state.asks.some((a) => a.askId === frame.askId)) return state;
  return { ...state, asks: [...state.asks, frame] };
}

export function answerAsk(state: ChatState, askId: string, answer: string): ChatState {
  return {
    ...state,
    asks: state.asks.filter((a) => a.askId !== askId),
    answeredAsks: { ...state.answeredAsks, [askId]: answer },
  };
}
