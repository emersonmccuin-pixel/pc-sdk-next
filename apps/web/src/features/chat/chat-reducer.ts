// Pure canonical conversation projector. Live outbox frames, reconnect replay,
// and past-session HTTP checkpoints all reduce through this one path.

import type {
  AskFrame,
  ChatDeltaEvent,
  ChatEvent,
  ConversationEventFrame,
  SendAckFrame,
  SendQueueItem,
  SendQueueSnapshotFrame,
  SessionChangedFrame,
  SessionReplayFrame,
} from '@pc/contracts';

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

export interface DeltaBuffer {
  itemId: string;
  streamId: string;
  text: string;
  toolInput: Record<string, string>;
  ended: boolean;
  nextDeltaIndex: number;
  pending: Record<number, ChatDeltaEvent>;
}

export type OptimisticStatus =
  | 'sending'
  | 'queued'
  | 'delivering'
  | 'delivered'
  | 'failed'
  | 'cancelled';

export interface OptimisticSend {
  clientMessageId: string;
  text: string;
  status: OptimisticStatus;
  failureReason: string | null;
}

export interface ChatState {
  conversationId: string | null;
  sessionId: string | null;
  highWaterSequence: number;
  /** Immutable accepted canonical events, sorted by authoritative sequence. */
  frames: ConversationEventFrame[];
  /** Deterministic render input after fail-closed stream/item exclusions. */
  projectedFrames: ConversationEventFrame[];
  aggregates: Aggregates;
  deltas: Record<string, DeltaBuffer>;
  sendQueue: SendQueueItem[];
  optimistic: OptimisticSend[];
  asks: AskFrame[];
  answeredAsks: Record<string, string>;
  /** Fail-closed protocol/data conflicts; accepted projection is preserved. */
  integrityConflicts: string[];
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

export function initialChatState(
  sessionId: string | null = null,
  conversationId: string | null = sessionId,
): ChatState {
  return {
    conversationId,
    sessionId,
    highWaterSequence: 0,
    frames: [],
    projectedFrames: [],
    aggregates: emptyAggregates(),
    deltas: {},
    sendQueue: [],
    optimistic: [],
    asks: [],
    answeredAsks: {},
    integrityConflicts: [],
  };
}

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

function sameFrame(a: ConversationEventFrame, b: ConversationEventFrame): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

function addConflict(conflicts: string[], conflict: string): string[] {
  return conflicts.includes(conflict) ? conflicts : [...conflicts, conflict];
}

function applyDeltaToBuffer(buffer: DeltaBuffer, delta: ChatDeltaEvent): void {
  switch (delta.kind) {
    case 'message-start':
      break;
    case 'text-delta':
      buffer.text += delta.text;
      break;
    case 'tool-input-delta': {
      const key = delta.toolUseId ?? '';
      buffer.toolInput[key] = (buffer.toolInput[key] ?? '') + delta.partialJson;
      break;
    }
    case 'message-end':
      buffer.ended = true;
      break;
  }
}

function derive(
  frames: readonly ConversationEventFrame[],
  protocolConflicts: readonly string[],
): {
  aggregates: Aggregates;
  deltas: Record<string, DeltaBuffer>;
  conflicts: string[];
  projectedFrames: ConversationEventFrame[];
} {
  let aggregates = emptyAggregates();
  let conflicts = [...protocolConflicts];
  const excludedEventIds = new Set<string>();
  const streamItems = new Map<string, string>();
  const deltaPayloads = new Map<string, Map<number, string>>();

  // Validate identity from the complete sequence-sorted set before applying
  // retraction/completion suppression. This keeps conflicts and exclusions
  // deterministic under shuffled live delivery and replay.
  for (const frame of frames) {
    if (frame.streamId) {
      const priorItemId = streamItems.get(frame.streamId);
      if (priorItemId !== undefined && priorItemId !== frame.itemId) {
        conflicts = addConflict(conflicts, `stream:${frame.streamId}:item`);
        excludedEventIds.add(frame.eventId);
        continue;
      }
      streamItems.set(frame.streamId, frame.itemId);
    }
    if (frame.event.kind !== 'stream-delta') continue;
    const streamId = frame.streamId!;
    const index = frame.deltaIndex!;
    const payload = JSON.stringify(frame.event.delta);
    const byIndex = deltaPayloads.get(streamId) ?? new Map<number, string>();
    const prior = byIndex.get(index);
    if (prior !== undefined) {
      if (prior !== payload) conflicts = addConflict(conflicts, `delta:${streamId}:${index}`);
      excludedEventIds.add(frame.eventId);
      continue;
    }
    byIndex.set(index, payload);
    deltaPayloads.set(streamId, byIndex);
  }

  const retracted = new Set<string>();
  for (const frame of frames) {
    if (excludedEventIds.has(frame.eventId)) continue;
    if (frame.event.kind === 'retract') {
      for (const streamId of frame.event.streamIds) retracted.add(streamId);
    }
  }
  const deltas: Record<string, DeltaBuffer> = {};
  const completed = new Set<string>();

  for (const frame of frames) {
    if (excludedEventIds.has(frame.eventId)) continue;
    if (frame.streamId && retracted.has(frame.streamId)) continue;
    if (frame.event.kind === 'stream-delta') {
      const streamId = frame.streamId!;
      if (completed.has(streamId)) continue;
      const index = frame.deltaIndex!;
      const buffer = deltas[streamId] ?? {
        itemId: frame.itemId,
        streamId,
        text: '',
        toolInput: {},
        ended: false,
        nextDeltaIndex: 0,
        pending: {},
      };
      buffer.pending[index] = frame.event.delta;
      while (buffer.pending[buffer.nextDeltaIndex]) {
        const next = buffer.pending[buffer.nextDeltaIndex]!;
        delete buffer.pending[buffer.nextDeltaIndex];
        applyDeltaToBuffer(buffer, next);
        buffer.nextDeltaIndex += 1;
      }
      deltas[streamId] = buffer;
      continue;
    }
    aggregates = foldAggregate(aggregates, frame.event);
    if (frame.streamId) {
      completed.add(frame.streamId);
      delete deltas[frame.streamId];
    }
    if (frame.event.kind === 'turn-end' || frame.event.kind === 'turn-failed') {
      for (const key of Object.keys(deltas)) delete deltas[key];
    }
  }
  for (const streamId of retracted) delete deltas[streamId];
  return {
    aggregates,
    deltas,
    conflicts,
    projectedFrames: frames.filter((frame) => !excludedEventIds.has(frame.eventId)),
  };
}

export function applyConversationEvent(
  state: ChatState,
  frame: ConversationEventFrame,
): ChatState {
  if (state.sessionId !== null && frame.sessionId !== state.sessionId) return state;
  if (state.conversationId !== null && frame.conversationId !== state.conversationId) return state;

  const sameSequence = state.frames.find((accepted) => accepted.sequence === frame.sequence);
  if (sameSequence) {
    if (sameFrame(sameSequence, frame)) return state;
    return {
      ...state,
      integrityConflicts: addConflict(state.integrityConflicts, `sequence:${frame.sequence}`),
    };
  }
  const sameEventId = state.frames.find((accepted) => accepted.eventId === frame.eventId);
  if (sameEventId) {
    return {
      ...state,
      integrityConflicts: addConflict(state.integrityConflicts, `event:${frame.eventId}`),
    };
  }

  const frames = [...state.frames, frame].sort((a, b) => a.sequence - b.sequence);
  const derived = derive(frames, state.integrityConflicts);
  let optimistic = state.optimistic;
  if (frame.event.kind === 'user' && frame.clientMessageId) {
    optimistic = optimistic.filter((send) => send.clientMessageId !== frame.clientMessageId);
  }
  return {
    ...state,
    conversationId: frame.conversationId,
    sessionId: frame.sessionId,
    frames,
    projectedFrames: derived.projectedFrames,
    aggregates: derived.aggregates,
    deltas: derived.deltas,
    optimistic,
    integrityConflicts: derived.conflicts,
    highWaterSequence: Math.max(state.highWaterSequence, frame.sequence),
  };
}

export function applyReplay(state: ChatState, replay: SessionReplayFrame): ChatState {
  let next = initialChatState(replay.sessionId, replay.events[0]?.conversationId ?? replay.sessionId);
  next = { ...next, optimistic: state.optimistic, sendQueue: state.sendQueue };
  for (const event of replay.events) next = applyConversationEvent(next, event);
  const observed = next.frames.at(-1)?.sequence ?? 0;
  if (replay.highWaterSequence < observed) {
    next = {
      ...next,
      integrityConflicts: addConflict(next.integrityConflicts, 'replay:high-water'),
    };
  }
  return { ...next, highWaterSequence: Math.max(replay.highWaterSequence, observed) };
}

export function applySessionChanged(state: ChatState, frame: SessionChangedFrame): ChatState {
  void state;
  return initialChatState(frame.session?.id ?? null);
}

export function addOptimistic(state: ChatState, clientMessageId: string, text: string): ChatState {
  if (state.optimistic.some((send) => send.clientMessageId === clientMessageId)) return state;
  return {
    ...state,
    optimistic: [
      ...state.optimistic,
      { clientMessageId, text, status: 'sending', failureReason: null },
    ],
  };
}

export function applySendAck(state: ChatState, ack: SendAckFrame): ChatState {
  const optimistic = state.optimistic.map((send) => {
    if (send.clientMessageId !== ack.clientMessageId) return send;
    if (ack.status === 'queued') return { ...send, status: 'queued' as const };
    if (ack.status === 'invalid' || ack.status === 'error') {
      return { ...send, status: 'failed' as const, failureReason: ack.error ?? ack.status };
    }
    return send;
  });
  return { ...state, optimistic };
}

export function applySendQueueSnapshot(state: ChatState, frame: SendQueueSnapshotFrame): ChatState {
  if (state.sessionId && frame.sessionId && frame.sessionId !== state.sessionId) return state;
  const byClientId = new Map(frame.items.map((item) => [item.clientMessageId, item] as const));
  const optimistic: OptimisticSend[] = [];
  for (const send of state.optimistic) {
    const item = byClientId.get(send.clientMessageId);
    if (!item) {
      optimistic.push(send);
      continue;
    }
    if (item.status === 'delivered') continue;
    optimistic.push({ ...send, status: item.status, failureReason: item.failureReason });
  }
  return { ...state, sendQueue: frame.items, optimistic };
}

export function applyAsk(state: ChatState, frame: AskFrame): ChatState {
  if (state.answeredAsks[frame.askId] || state.asks.some((ask) => ask.askId === frame.askId)) return state;
  return { ...state, asks: [...state.asks, frame] };
}

export function answerAsk(state: ChatState, askId: string, answer: string): ChatState {
  return {
    ...state,
    asks: state.asks.filter((ask) => ask.askId !== askId),
    answeredAsks: { ...state.answeredAsks, [askId]: answer },
  };
}
