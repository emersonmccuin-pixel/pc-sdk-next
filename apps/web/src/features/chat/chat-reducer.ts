// Pure canonical conversation projector. Live outbox frames, reconnect replay,
// and past-session HTTP checkpoints all reduce through this one path.

import {
  toolStateTransitionError,
  type ActivityPhase,
  type AskFrame,
  type ChatDeltaEvent,
  type ChatEvent,
  type ConversationCommandReceiptFrame,
  type ConversationEventFrame,
  type SendQueueItem,
  type SendQueueSnapshotFrame,
  type SessionChangedFrame,
  type SessionReplayFrame,
  type ToolStateEvent,
} from '@pc/contracts';

import {
  indexDelete,
  indexEntries,
  indexGet,
  indexSet,
  type PersistentIndex,
} from './persistent-index';
import {
  emptySequence,
  sequenceAppend,
  type PersistentSequence,
} from './persistent-sequence';
import { sha256 } from './sha256';

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
  ended: boolean;
  nextDeltaIndex: number;
  pending: PersistentIndex<ChatDeltaEvent>;
  /** Number of unique raw contributions represented by this live buffer. */
  retainedPayloadCount: number;
}

export interface ToolProjection extends ToolStateEvent {
  turnId: string | null;
  sequence: number;
  occurredAt: number;
}

export type ActivitySource =
  | { kind: 'activity'; phase: ActivityPhase }
  | {
      kind: 'tool';
      callId: string;
      state: ToolStateEvent['state'];
      safeSummary: string;
    };

export interface CurrentActivityProjection {
  turnId: string;
  startedAt: number;
  updatedAt: number;
  sequence: number;
  source: ActivitySource;
}

interface SequenceReceipt {
  eventId: string;
  digest: string;
}

interface DeltaReceipt {
  digest: string;
  sequence: number;
}

interface StreamReceipt {
  itemId: string | null;
  firstSequence: number | null;
  turnId: string | null;
  completed: boolean;
  retracted: boolean;
  deltaReceipts: PersistentIndex<DeltaReceipt>;
}

/** Internal immutable indexes. Values retain identities and digests, never
 * completed raw delta payloads. Plain-data tree nodes survive structuredClone. */
export interface ProjectorState {
  sequenceReceipts: PersistentIndex<SequenceReceipt>;
  eventSequences: PersistentIndex<number>;
  pendingFrames: PersistentIndex<ConversationEventFrame>;
  streams: PersistentIndex<StreamReceipt>;
}

export type OptimisticStatus =
  | 'sending'
  | 'queued'
  | 'delivering'
  | 'accepted'
  | 'failed'
  | 'cancelled';

export interface OptimisticSend {
  commandId: string;
  clientMessageId: string;
  text: string;
  status: OptimisticStatus;
  failureReason: string | null;
}

export interface InterruptProjection {
  requestId: string;
  targetTurnId: string;
  replacementQueueItemId: string | null;
  state: 'requested' | 'confirmed' | 'failed';
  result: 'aborted' | 'completed' | 'turn-failed' | 'recovered' | null;
  failure: { code: string; message: string } | null;
}

export interface ChatState {
  conversationId: string | null;
  sessionId: string | null;
  /** A connect checkpoint/replay has established the current session context. */
  sessionContextReady: boolean;
  /** Highest accepted or checkpointed server sequence. */
  highWaterSequence: number;
  /** Highest authoritative sequence whose transition has been folded. */
  projectedThroughSequence: number;
  /** Immutable accepted stable events in authoritative sequence order. */
  frames: PersistentSequence<ConversationEventFrame>;
  /** Stable render input after fail-closed stream/item exclusions. */
  projectedFrames: PersistentSequence<ConversationEventFrame>;
  aggregates: Aggregates;
  /** Guarded latest lifecycle snapshot per canonical call. */
  toolStates: PersistentIndex<ToolProjection>;
  /** Latest positive operational evidence for the active turn. */
  currentActivity: CurrentActivityProjection | null;
  /** Turns whose canonical terminal has already folded. */
  terminalTurns: PersistentIndex<true>;
  /** Raw/coalesced payload exists only while a stream is active. */
  deltas: Record<string, DeltaBuffer>;
  queueRevision: number;
  sendQueue: SendQueueItem[];
  optimistic: OptimisticSend[];
  acceptedClientMessageIds: Record<string, true>;
  cancelledClientMessages: Record<string, string | null>;
  commandReceipts: Record<string, ConversationCommandReceiptFrame>;
  interrupts: Record<string, InterruptProjection>;
  latestInterruptRequestId: string | null;
  asks: AskFrame[];
  /** Out-of-order ephemeral cards waiting for their canonical approval state. */
  pendingAsks: AskFrame[];
  answeredAsks: Record<string, string>;
  /** Fail-closed protocol/data conflicts; accepted projection is preserved. */
  integrityConflicts: string[];
  projector: ProjectorState;
}

export type ProjectionPath =
  | 'ignored'
  | 'duplicate'
  | 'conflict'
  | 'buffered'
  | 'ordered'
  | 'replay';

/** Deterministic work evidence. It intentionally avoids wall-clock thresholds. */
export interface ProjectionWork {
  path: ProjectionPath;
  acceptedEventVisits: number;
  historyVisits: number;
  fallbackRebuilds: number;
  compactedDeltaPayloads: number;
}

export interface ProjectionReceipt {
  state: ChatState;
  work: ProjectionWork;
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

function emptyProjector(): ProjectorState {
  return {
    sequenceReceipts: null,
    eventSequences: null,
    pendingFrames: null,
    streams: null,
  };
}

function emptyStreamReceipt(): StreamReceipt {
  return {
    itemId: null,
    firstSequence: null,
    turnId: null,
    completed: false,
    retracted: false,
    deltaReceipts: null,
  };
}

export function initialChatState(
  sessionId: string | null = null,
  conversationId: string | null = sessionId,
): ChatState {
  return {
    conversationId,
    sessionId,
    sessionContextReady: false,
    highWaterSequence: 0,
    projectedThroughSequence: 0,
    frames: emptySequence(),
    projectedFrames: emptySequence(),
    aggregates: emptyAggregates(),
    toolStates: null,
    currentActivity: null,
    terminalTurns: null,
    deltas: {},
    queueRevision: 0,
    sendQueue: [],
    optimistic: [],
    acceptedClientMessageIds: {},
    cancelledClientMessages: {},
    commandReceipts: {},
    interrupts: {},
    latestInterruptRequestId: null,
    asks: [],
    pendingAsks: [],
    answeredAsks: {},
    integrityConflicts: [],
    projector: emptyProjector(),
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

function sequenceKey(sequence: number): string {
  return String(sequence);
}

function frameDigest(frame: ConversationEventFrame): string {
  return sha256(JSON.stringify(frame));
}

function deltaDigest(delta: ChatDeltaEvent): string {
  return sha256(JSON.stringify(delta));
}

function addConflict(conflicts: string[], conflict: string): string[] {
  if (conflicts.includes(conflict)) return conflicts;
  return [...conflicts, conflict].sort();
}

function withConflict(state: ChatState, conflict: string): ChatState {
  const integrityConflicts = addConflict(state.integrityConflicts, conflict);
  return integrityConflicts === state.integrityConflicts
    ? state
    : { ...state, integrityConflicts };
}

function applyDeltaToBuffer(buffer: DeltaBuffer, delta: ChatDeltaEvent): DeltaBuffer {
  switch (delta.kind) {
    case 'message-start':
      return buffer;
    case 'text-delta':
      return { ...buffer, text: buffer.text + delta.text };
    case 'message-end':
      return { ...buffer, ended: true };
  }
}

function bufferDelta(
  buffer: DeltaBuffer,
  deltaIndex: number,
  delta: ChatDeltaEvent,
): DeltaBuffer {
  let next: DeltaBuffer = {
    ...buffer,
    pending: indexSet(buffer.pending, sequenceKey(deltaIndex), delta),
    retainedPayloadCount: buffer.retainedPayloadCount + 1,
  };
  while (true) {
    const queued = indexGet(next.pending, sequenceKey(next.nextDeltaIndex));
    if (!queued) return next;
    const pending = indexDelete(next.pending, sequenceKey(next.nextDeltaIndex));
    next = applyDeltaToBuffer({
      ...next,
      pending,
      nextDeltaIndex: next.nextDeltaIndex + 1,
    }, queued);
  }
}

function removeDeltaBuffer(
  deltas: Record<string, DeltaBuffer>,
  streamId: string,
  work: ProjectionWork,
): Record<string, DeltaBuffer> {
  const buffer = deltas[streamId];
  if (!buffer) return deltas;
  work.compactedDeltaPayloads += buffer.retainedPayloadCount;
  const next = { ...deltas };
  delete next[streamId];
  return next;
}

interface StreamBinding {
  projector: ProjectorState;
  conflicts: string[];
  receipt: StreamReceipt | null;
  valid: boolean;
}

function bindStream(
  projector: ProjectorState,
  conflicts: string[],
  frame: ConversationEventFrame,
): StreamBinding {
  if (!frame.streamId) return { projector, conflicts, receipt: null, valid: true };
  const current = indexGet(projector.streams, frame.streamId) ?? emptyStreamReceipt();
  if (current.itemId !== null && current.itemId !== frame.itemId) {
    return {
      projector,
      conflicts: addConflict(conflicts, `stream:${frame.streamId}:item`),
      receipt: current,
      valid: false,
    };
  }
  if (current.itemId !== null) {
    return { projector, conflicts, receipt: current, valid: true };
  }
  const receipt: StreamReceipt = {
    ...current,
    itemId: frame.itemId,
    firstSequence: frame.sequence,
    turnId: frame.turnId ?? null,
  };
  return {
    projector: { ...projector, streams: indexSet(projector.streams, frame.streamId, receipt) },
    conflicts,
    receipt,
    valid: true,
  };
}

function foldDeltaFrame(
  state: ChatState,
  frame: ConversationEventFrame,
  binding: StreamBinding,
): ChatState {
  if (frame.event.kind !== 'stream-delta') return state;
  const event = frame.event;
  const streamId = frame.streamId;
  const deltaIndex = frame.deltaIndex;
  if (!streamId || deltaIndex === undefined || !binding.receipt) {
    return withConflict(
      { ...state, projector: binding.projector, integrityConflicts: binding.conflicts },
      `stream:${frame.eventId}:shape`,
    );
  }
  if (!binding.valid) {
    return {
      ...state,
      projector: binding.projector,
      integrityConflicts: binding.conflicts,
    };
  }

  const key = sequenceKey(deltaIndex);
  const digest = deltaDigest(event.delta);
  const prior = indexGet(binding.receipt.deltaReceipts, key);
  if (prior) {
    const integrityConflicts = prior.digest === digest
      ? binding.conflicts
      : addConflict(binding.conflicts, `delta:${streamId}:${deltaIndex}`);
    return {
      ...state,
      projector: binding.projector,
      integrityConflicts,
    };
  }

  const receipt: StreamReceipt = {
    ...binding.receipt,
    deltaReceipts: indexSet(binding.receipt.deltaReceipts, key, {
      digest,
      sequence: frame.sequence,
    }),
  };
  const projector: ProjectorState = {
    ...binding.projector,
    streams: indexSet(binding.projector.streams, streamId, receipt),
  };
  if (receipt.completed || receipt.retracted) {
    return { ...state, projector, integrityConflicts: binding.conflicts };
  }

  const buffer = state.deltas[streamId] ?? {
    itemId: frame.itemId,
    streamId,
    text: '',
    ended: false,
    nextDeltaIndex: 0,
    pending: null,
    retainedPayloadCount: 0,
  };
  return {
    ...state,
    projector,
    integrityConflicts: binding.conflicts,
    deltas: {
      ...state.deltas,
      [streamId]: bufferDelta(buffer, deltaIndex, event.delta),
    },
  };
}

function foldStableFrame(
  state: ChatState,
  frame: ConversationEventFrame,
  binding: StreamBinding,
  work: ProjectionWork,
): ChatState {
  if (frame.event.kind === 'stream-delta') return state;
  const event = frame.event;
  const streamWasRetracted = binding.receipt?.retracted ?? false;
  let projector = binding.projector;
  let deltas = state.deltas;
  let optimistic = state.optimistic;
  let acceptedClientMessageIds = state.acceptedClientMessageIds;
  let cancelledClientMessages = state.cancelledClientMessages;
  let queueRevision = state.queueRevision;
  let sendQueue = state.sendQueue;
  let interrupts = state.interrupts;
  let latestInterruptRequestId = state.latestInterruptRequestId;
  let toolStates = state.toolStates;
  let currentActivity = state.currentActivity;
  let terminalTurns = state.terminalTurns;
  let asks = state.asks;
  let pendingAsks = state.pendingAsks;
  let answeredAsks = state.answeredAsks;

  if (binding.valid && event.kind === 'tool-state') {
    const previous = indexGet(toolStates, event.callId);
    const transitionError = toolStateTransitionError(previous ?? null, event);
    const turnId = frame.turnId ?? null;
    const ownershipError = frame.itemId !== event.callId
      ? 'item'
      : turnId === null
        ? 'turn'
        : indexGet(terminalTurns, turnId)
          ? 'post-terminal'
          : previous && previous.turnId !== turnId
            ? 'turn'
            : null;
    if (ownershipError || transitionError) {
      binding.valid = false;
      binding.conflicts = addConflict(
        binding.conflicts,
        `tool:${event.callId}:${ownershipError ?? transitionError}`,
      );
    } else {
      const projection: ToolProjection = {
        ...event,
        turnId,
        sequence: frame.sequence,
        occurredAt: frame.occurredAt,
      };
      toolStates = indexSet(toolStates, event.callId, projection);
      const startedAt = currentActivity?.turnId === turnId
        ? currentActivity.startedAt
        : frame.occurredAt;
      currentActivity = {
        turnId: turnId!,
        startedAt,
        updatedAt: frame.occurredAt,
        sequence: frame.sequence,
        source: {
          kind: 'tool',
          callId: event.callId,
          state: event.state,
          safeSummary: event.safeSummary,
        },
      };
      if (event.state === 'approval-needed' && event.approval.status === 'pending') {
        const ready = pendingAsks.filter((ask) => (
          ask.sessionId === state.sessionId
          && ask.callId === event.callId
          && ask.toolName === event.name
          && ask.askId === event.approval.requestId
          && !Object.prototype.hasOwnProperty.call(answeredAsks, ask.askId)
        ));
        if (ready.length > 0) {
          const existing = new Set(asks.map((ask) => ask.askId));
          asks = [...asks, ...ready.filter((ask) => !existing.has(ask.askId))];
          pendingAsks = pendingAsks.filter((ask) => !ready.some((readyAsk) => readyAsk.askId === ask.askId));
        }
      } else if (event.state !== 'requested') {
        const removed = asks.filter((ask) => ask.callId === event.callId);
        if (removed.length > 0) {
          asks = asks.filter((ask) => ask.callId !== event.callId);
          answeredAsks = { ...answeredAsks };
          for (const ask of removed) delete answeredAsks[ask.askId];
        }
        pendingAsks = pendingAsks.filter((ask) => ask.callId !== event.callId);
      }
    }
  }

  if (binding.valid && event.kind === 'activity-state') {
    if (!frame.turnId) {
      binding.valid = false;
      binding.conflicts = addConflict(binding.conflicts, `activity:${frame.eventId}:turn`);
    } else if (indexGet(terminalTurns, frame.turnId)) {
      binding.valid = false;
      binding.conflicts = addConflict(binding.conflicts, `activity:${frame.eventId}:post-terminal`);
    } else {
      const startedAt = event.phase === 'turn-starting' || currentActivity?.turnId !== frame.turnId
        ? frame.occurredAt
        : currentActivity.startedAt;
      currentActivity = {
        turnId: frame.turnId,
        startedAt,
        updatedAt: frame.occurredAt,
        sequence: frame.sequence,
        source: { kind: 'activity', phase: event.phase },
      };
    }
  }

  if (binding.valid && event.kind === 'user' && frame.clientMessageId) {
    optimistic = optimistic.filter((send) => send.clientMessageId !== frame.clientMessageId);
    acceptedClientMessageIds = {
      ...acceptedClientMessageIds,
      [frame.clientMessageId]: true,
    };
  }

  if (binding.valid && event.kind === 'send-state') {
    if (event.queueRevision < queueRevision) {
      // A reconnect snapshot may overtake still-pending older outbox rows.
      // They are durably accounted for by the newer queue revision.
    } else if (event.queueRevision === queueRevision) {
      const current = sendQueue.find((item) => item.id === event.item.id);
      const terminalAbsent =
        (event.item.status === 'accepted' || event.item.status === 'cancelled') && !current;
      if (!terminalAbsent && JSON.stringify(current) !== JSON.stringify(event.item)) {
        binding.conflicts = addConflict(binding.conflicts, `queue-revision:${event.queueRevision}`);
      }
    } else {
      queueRevision = event.queueRevision;
      const withoutItem = sendQueue.filter((item) => item.id !== event.item.id);
      sendQueue = event.item.status === 'accepted' || event.item.status === 'cancelled'
        ? withoutItem
        : [...withoutItem, event.item].sort((left, right) =>
            left.enqueuePosition - right.enqueuePosition || left.id.localeCompare(right.id));
      optimistic = optimistic.flatMap((send) => {
        if (send.clientMessageId !== event.item.clientMessageId) return [send];
        if (event.item.status === 'accepted' || event.item.status === 'cancelled') return [];
        return [{
          ...send,
          status: event.item.status,
          failureReason: event.item.failureReason,
        }];
      });
    }
    // A reconnect snapshot may overtake the terminal event and omit its row.
    // Terminal client identity still folds from the canonical event even when
    // its queue topology revision is already checkpointed by that snapshot.
    if (event.item.status === 'accepted' || event.item.status === 'cancelled') {
      optimistic = optimistic.filter(
        (send) => send.clientMessageId !== event.item.clientMessageId,
      );
      if (event.item.status === 'accepted') {
        acceptedClientMessageIds = {
          ...acceptedClientMessageIds,
          [event.item.clientMessageId]: true,
        };
      } else {
        cancelledClientMessages = {
          ...cancelledClientMessages,
          [event.item.clientMessageId]: event.item.failureReason,
        };
      }
    }
  }

  if (binding.valid && event.kind === 'interrupt-state') {
    interrupts = {
      ...interrupts,
      [event.requestId]: {
        requestId: event.requestId,
        targetTurnId: event.targetTurnId,
        replacementQueueItemId: event.replacementQueueItemId,
        state: event.state,
        result: event.result,
        failure: event.failure,
      },
    };
    if (event.state === 'requested') latestInterruptRequestId = event.requestId;
  }

  if (binding.valid && frame.streamId && !streamWasRetracted && binding.receipt) {
    const completed: StreamReceipt = { ...binding.receipt, completed: true };
    projector = {
      ...projector,
      streams: indexSet(projector.streams, frame.streamId, completed),
    };
    deltas = removeDeltaBuffer(deltas, frame.streamId, work);
  }

  if (binding.valid && event.kind === 'retract') {
    for (const streamId of new Set(event.streamIds)) {
      const current = indexGet(projector.streams, streamId) ?? emptyStreamReceipt();
      projector = {
        ...projector,
        streams: indexSet(projector.streams, streamId, { ...current, retracted: true }),
      };
      deltas = removeDeltaBuffer(deltas, streamId, work);
    }
  }

  if (
    binding.valid &&
    (event.kind === 'turn-end' || event.kind === 'turn-failed')
  ) {
    if (frame.turnId) {
      for (const [, tool] of indexEntries(toolStates)) {
        if (
          tool.turnId === frame.turnId &&
          tool.state !== 'succeeded' && tool.state !== 'failed' && tool.state !== 'denied'
        ) {
          binding.conflicts = addConflict(
            binding.conflicts,
            `turn:${frame.turnId}:open-tool:${tool.callId}`,
          );
        }
      }
    }
    if (frame.turnId) terminalTurns = indexSet(terminalTurns, frame.turnId, true);
    currentActivity = null;
    asks = [];
    pendingAsks = [];
    answeredAsks = {};
    for (const streamId of Object.keys(deltas)) {
      const current = indexGet(projector.streams, streamId);
      if (current && !current.completed) {
        projector = {
          ...projector,
          streams: indexSet(projector.streams, streamId, { ...current, completed: true }),
        };
      }
      deltas = removeDeltaBuffer(deltas, streamId, work);
    }
  }

  if (binding.valid && event.kind === 'session-state' && event.state === 'idle') {
    currentActivity = null;
    asks = [];
    pendingAsks = [];
    answeredAsks = {};
  }

  return {
    ...state,
    frames: sequenceAppend(state.frames, frame),
    projectedFrames: binding.valid
      ? sequenceAppend(state.projectedFrames, frame)
      : state.projectedFrames,
    aggregates: binding.valid && !streamWasRetracted
      ? foldAggregate(state.aggregates, event)
      : state.aggregates,
    toolStates,
    currentActivity,
    terminalTurns,
    deltas,
    queueRevision,
    sendQueue,
    optimistic,
    acceptedClientMessageIds,
    cancelledClientMessages,
    interrupts,
    latestInterruptRequestId,
    asks,
    pendingAsks,
    answeredAsks,
    integrityConflicts: binding.conflicts,
    projector,
  };
}

function foldFrame(
  state: ChatState,
  frame: ConversationEventFrame,
  work: ProjectionWork,
): ChatState {
  const priorEventSequence = indexGet(state.projector.eventSequences, frame.eventId);
  if (priorEventSequence !== undefined) {
    work.path = 'conflict';
    return withConflict(state, `event:${frame.eventId}`);
  }
  const projector: ProjectorState = {
    ...state.projector,
    eventSequences: indexSet(state.projector.eventSequences, frame.eventId, frame.sequence),
  };
  const indexedState = { ...state, projector };
  const binding = bindStream(projector, state.integrityConflicts, frame);
  if (frame.event.kind === 'stream-delta') {
    return foldDeltaFrame(indexedState, frame, binding);
  }
  return foldStableFrame(indexedState, frame, binding, work);
}

function drainContiguous(
  state: ChatState,
  first: ConversationEventFrame,
  work: ProjectionWork,
): ChatState {
  let next = state;
  let frame: ConversationEventFrame | undefined = first;
  while (frame) {
    next = foldFrame(next, frame, work);
    next = { ...next, projectedThroughSequence: frame.sequence };

    const pendingKey = sequenceKey(frame.sequence + 1);
    frame = indexGet(next.projector.pendingFrames, pendingKey);
    if (frame) {
      next = {
        ...next,
        projector: {
          ...next.projector,
          pendingFrames: indexDelete(next.projector.pendingFrames, pendingKey),
        },
      };
    }
  }
  return next;
}

function work(path: ProjectionPath): ProjectionWork {
  return {
    path,
    acceptedEventVisits: 0,
    historyVisits: 0,
    fallbackRebuilds: 0,
    compactedDeltaPayloads: 0,
  };
}

export function reduceConversationEvent(
  state: ChatState,
  frame: ConversationEventFrame,
): ProjectionReceipt {
  const receiptWork = work('ignored');
  if (state.sessionId !== null && frame.sessionId !== state.sessionId) {
    return { state, work: receiptWork };
  }
  if (state.conversationId !== null && frame.conversationId !== state.conversationId) {
    return { state, work: receiptWork };
  }

  const key = sequenceKey(frame.sequence);
  const digest = frameDigest(frame);
  const sameSequence = indexGet(state.projector.sequenceReceipts, key);
  if (sameSequence) {
    if (sameSequence.eventId === frame.eventId && sameSequence.digest === digest) {
      receiptWork.path = 'duplicate';
      return { state, work: receiptWork };
    }
    receiptWork.path = 'conflict';
    return { state: withConflict(state, `sequence:${frame.sequence}`), work: receiptWork };
  }
  // A replay checkpoint positively accounts for every lower sequence, including
  // hidden legacy rows. An unseen late frame cannot be safely inserted behind it.
  if (frame.sequence <= state.projectedThroughSequence) {
    receiptWork.path = 'conflict';
    return { state: withConflict(state, `sequence:${frame.sequence}`), work: receiptWork };
  }

  receiptWork.acceptedEventVisits = 1;
  let projector: ProjectorState = {
    ...state.projector,
    sequenceReceipts: indexSet(state.projector.sequenceReceipts, key, {
      eventId: frame.eventId,
      digest,
    }),
  };
  let next: ChatState = {
    ...state,
    conversationId: frame.conversationId,
    sessionId: frame.sessionId,
    highWaterSequence: Math.max(state.highWaterSequence, frame.sequence),
    projector,
  };

  if (frame.sequence > state.projectedThroughSequence + 1) {
    receiptWork.path = 'buffered';
    projector = {
      ...projector,
      pendingFrames: indexSet(projector.pendingFrames, key, frame),
    };
    next = { ...next, projector };
    return { state: next, work: receiptWork };
  }

  receiptWork.path = 'ordered';
  return { state: drainContiguous(next, frame, receiptWork), work: receiptWork };
}

export function applyConversationEvent(
  state: ChatState,
  frame: ConversationEventFrame,
): ChatState {
  return reduceConversationEvent(state, frame).state;
}

export function reduceReplay(state: ChatState, replay: SessionReplayFrame): ProjectionReceipt {
  const receiptWork = work('replay');
  receiptWork.fallbackRebuilds = 1;
  receiptWork.historyVisits = replay.events.length;

  const ordered = replay.events
    .map((event, inputIndex) => ({ event, inputIndex }))
    .sort((left, right) =>
      left.event.sequence - right.event.sequence || left.inputIndex - right.inputIndex)
    .map(({ event }) => event);
  let next = initialChatState(
    replay.sessionId,
    ordered[0]?.conversationId ?? replay.sessionId,
  );
  next = { ...next, optimistic: state.optimistic };

  for (const event of ordered) {
    const belongs =
      event.sessionId === next.sessionId && event.conversationId === next.conversationId;
    if (belongs && event.sequence > next.projectedThroughSequence + 1) {
      // Replay high-water is the positive checkpoint that lets visible rows skip
      // sequences occupied by hidden historical evidence.
      next = { ...next, projectedThroughSequence: event.sequence - 1 };
    }
    const reduced = reduceConversationEvent(next, event);
    next = reduced.state;
    receiptWork.acceptedEventVisits += reduced.work.acceptedEventVisits;
    receiptWork.compactedDeltaPayloads += reduced.work.compactedDeltaPayloads;
  }

  const highestVisible = ordered.at(-1)?.sequence ?? 0;
  if (replay.highWaterSequence < highestVisible) {
    next = withConflict(next, 'replay:high-water');
  }
  const checkpoint = Math.max(
    replay.highWaterSequence,
    highestVisible,
    next.highWaterSequence,
  );
  next = {
    ...next,
    highWaterSequence: checkpoint,
    projectedThroughSequence: checkpoint,
    sessionContextReady: true,
  };
  return { state: next, work: receiptWork };
}

export function applyReplay(state: ChatState, replay: SessionReplayFrame): ChatState {
  return reduceReplay(state, replay).state;
}

export function applySessionChanged(state: ChatState, frame: SessionChangedFrame): ChatState {
  const next = {
    ...initialChatState(frame.session?.id ?? null),
    sessionContextReady: frame.session === null,
  };
  return state.sessionId === null && state.optimistic.length > 0
    ? { ...next, optimistic: state.optimistic }
    : next;
}

export function addOptimistic(
  state: ChatState,
  commandId: string,
  clientMessageId: string,
  text: string,
): ChatState {
  if (state.optimistic.some((send) => send.clientMessageId === clientMessageId)) return state;
  return {
    ...state,
    optimistic: [
      ...state.optimistic,
      { commandId, clientMessageId, text, status: 'sending', failureReason: null },
    ],
  };
}

export function applyConversationCommandReceipt(
  state: ChatState,
  receipt: ConversationCommandReceiptFrame,
): ChatState {
  const optimistic = state.optimistic.map((send) => {
    if (send.commandId !== receipt.commandId) return send;
    if (receipt.status === 'applied' || receipt.status === 'duplicate') {
      return { ...send, status: 'queued' as const, failureReason: null };
    }
    return {
      ...send,
      status: 'failed' as const,
      failureReason: receipt.error?.message ?? 'Command rejected',
    };
  });
  return {
    ...state,
    optimistic,
    commandReceipts: { ...state.commandReceipts, [receipt.commandId]: receipt },
  };
}

export function applySendQueueSnapshot(state: ChatState, frame: SendQueueSnapshotFrame): ChatState {
  if (state.sessionId && frame.sessionId && frame.sessionId !== state.sessionId) return state;
  const checkpointed = state.sessionContextReady ? state : { ...state, sessionContextReady: true };
  const normalizedItems = [...frame.items].sort((left, right) =>
    left.enqueuePosition - right.enqueuePosition || left.id.localeCompare(right.id));
  if (frame.queueRevision < checkpointed.queueRevision) return checkpointed;
  if (frame.queueRevision === checkpointed.queueRevision) {
    if (JSON.stringify(normalizedItems) === JSON.stringify(checkpointed.sendQueue)) return checkpointed;
    return withConflict(checkpointed, `queue-snapshot:${frame.queueRevision}`);
  }
  const byClientId = new Map(normalizedItems.map((item) => [item.clientMessageId, item] as const));
  const optimistic: OptimisticSend[] = [];
  for (const send of checkpointed.optimistic) {
    const item = byClientId.get(send.clientMessageId);
    if (!item) {
      optimistic.push(send);
      continue;
    }
    if (item.status === 'accepted' || item.status === 'cancelled') continue;
    optimistic.push({ ...send, status: item.status, failureReason: item.failureReason });
  }
  return {
    ...checkpointed,
    queueRevision: frame.queueRevision,
    sendQueue: normalizedItems,
    optimistic,
  };
}

export function applyAsk(
  state: ChatState,
  frame: AskFrame,
  activeTurnId: string | null = null,
): ChatState {
  if (frame.sessionId !== state.sessionId) return state;
  if (
    Object.prototype.hasOwnProperty.call(state.answeredAsks, frame.askId)
    || state.asks.some((ask) => ask.askId === frame.askId)
    || state.pendingAsks.some((ask) => ask.askId === frame.askId)
  ) return state;
  const requestOwner = indexEntries(state.toolStates)
    .map(([, candidate]) => candidate)
    .find((candidate) => (
      candidate.state === 'approval-needed'
      && candidate.approval.status === 'pending'
      && candidate.approval.requestId === frame.askId
    ));
  if (
    requestOwner
    && (requestOwner.callId !== frame.callId || requestOwner.name !== frame.toolName)
  ) return state;
  const tool = indexGet(state.toolStates, frame.callId);
  if (tool) {
    if (
      tool.name === frame.toolName
      && tool.state === 'approval-needed'
      && tool.approval.status === 'pending'
      && tool.approval.requestId === frame.askId
    ) {
      return state.currentActivity?.turnId === tool.turnId
        ? { ...state, asks: [...state.asks, frame] }
        : state;
    }
    if (
      tool.name === frame.toolName
      && tool.state === 'requested'
      && state.currentActivity?.turnId === tool.turnId
    ) {
      return { ...state, pendingAsks: [...state.pendingAsks, frame].slice(-100) };
    }
    // Existing lifecycle evidence can only advance; a mismatched card is
    // stale or corrupt and can never become actionable later.
    return state;
  }
  const turnIsActive = (
    activeTurnId !== null && !indexGet(state.terminalTurns, activeTurnId)
  ) || state.currentActivity !== null
    || state.aggregates.sessionState === 'running'
    || state.aggregates.sessionState === 'requires_action';
  return turnIsActive
    ? { ...state, pendingAsks: [...state.pendingAsks, frame].slice(-100) }
    : state;
}

export function answerAsk(state: ChatState, askId: string, answer: string): ChatState {
  return {
    ...state,
    answeredAsks: { ...state.answeredAsks, [askId]: answer },
  };
}
