import { test } from 'node:test';
import assert from 'node:assert/strict';
import type {
  ChatEvent,
  ConversationEvent,
  ConversationEventFrame,
  SessionReplayFrame,
} from '../../../packages/contracts/src/events/index.ts';
import {
  applyConversationEvent,
  applyReplay,
  initialChatState,
  reduceConversationEvent,
  reduceReplay,
  type ChatState,
  type ProjectionWork,
} from '../src/features/chat/chat-reducer.ts';
import { buildRenderItems } from '../src/features/chat/chat-render.ts';
import {
  PERSISTENT_SEQUENCE_CHUNK_SIZE,
  sequenceToArray,
  type PersistentSequence,
} from '../src/features/chat/persistent-sequence.ts';
import { sha256 } from '../src/features/chat/sha256.ts';

const SID = 'session-1';

function frame(
  sequence: number,
  event: ConversationEvent,
  extra: Partial<ConversationEventFrame> = {},
): ConversationEventFrame {
  return {
    type: 'conversation-event',
    eventId: `event-${sequence}`,
    projectId: 'project-1',
    conversationId: SID,
    sessionId: SID,
    sequence,
    family: event.kind === 'user' ? 'user' : event.kind === 'stream-delta' ? 'assistant' : 'control',
    itemId: `item-${sequence}`,
    occurredAt: sequence,
    event,
    ...extra,
  };
}

function usage(tokens: number): ChatEvent {
  return {
    kind: 'usage',
    inputTokens: tokens,
    outputTokens: tokens,
    cacheCreationTokens: 0,
    cacheReadTokens: 0,
    model: `model-${tokens}`,
  };
}

function seed(): ChatState {
  return initialChatState(SID);
}

function containsText(value: unknown, marker: string, seen = new WeakSet<object>()): boolean {
  if (typeof value === 'string') return value.includes(marker);
  if (value === null || typeof value !== 'object') return false;
  if (seen.has(value)) return false;
  seen.add(value);
  if (Array.isArray(value)) return value.some((entry) => containsText(entry, marker, seen));
  return Object.values(value).some((entry) => containsText(entry, marker, seen));
}

function projectionView(state: ChatState) {
  const frames = sequenceToArray(state.frames);
  const projectedFrames = sequenceToArray(state.projectedFrames);
  return {
    frames,
    projectedFrames,
    aggregates: state.aggregates,
    deltas: state.deltas,
    conflicts: state.integrityConflicts,
    highWaterSequence: state.highWaterSequence,
    projectedThroughSequence: state.projectedThroughSequence,
    rendered: buildRenderItems(projectedFrames),
  };
}

function maxChunkSize<Value>(sequence: PersistentSequence<Value>): number {
  let maximum = 0;
  let chunk = sequence.tail;
  while (chunk) {
    maximum = Math.max(maximum, chunk.values.length);
    chunk = chunk.previous;
  }
  return maximum;
}

function chunkCount<Value>(sequence: PersistentSequence<Value>): number {
  let count = 0;
  let chunk = sequence.tail;
  while (chunk) {
    count += 1;
    chunk = chunk.previous;
  }
  return count;
}

function addWork(total: ProjectionWork, next: ProjectionWork): void {
  total.acceptedEventVisits += next.acceptedEventVisits;
  total.historyVisits += next.historyVisits;
  total.fallbackRebuilds += next.fallbackRebuilds;
  total.compactedDeltaPayloads += next.compactedDeltaPayloads;
}

test('projector receipt digests use the standard SHA-256 identity', () => {
  assert.equal(
    sha256('abc'),
    'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad',
  );
});

test('shuffled live delivery produces the same complete state as server order', () => {
  const events = [
    frame(1, { kind: 'session-state', state: 'running', permissionMode: null }),
    frame(2, usage(10), { family: 'telemetry' }),
    frame(3, { kind: 'session-state', state: 'idle', permissionMode: null }),
  ];
  let ordered = seed();
  for (const event of events) ordered = applyConversationEvent(ordered, event);
  let shuffled = seed();
  for (const event of [events[2]!, events[0]!, events[1]!]) {
    shuffled = applyConversationEvent(shuffled, event);
  }
  assert.deepEqual(sequenceToArray(shuffled.frames), sequenceToArray(ordered.frames));
  assert.deepEqual(shuffled.aggregates, ordered.aggregates);
  assert.equal(shuffled.aggregates.sessionState, 'idle');
});

test('exact redelivery is idempotent; conflicting sequence preserves accepted projection', () => {
  const accepted = frame(1, usage(10), { family: 'telemetry' });
  let state = applyConversationEvent(seed(), accepted);
  state = applyConversationEvent(state, accepted);
  assert.equal(state.frames.length, 1);
  assert.equal(state.aggregates.inputTokens, 10);
  state = applyConversationEvent(
    state,
    frame(1, usage(99), { eventId: 'other-event', family: 'telemetry' }),
  );
  assert.equal(sequenceToArray(state.frames)[0]!.eventId, accepted.eventId);
  assert.equal(state.aggregates.inputTokens, 10);
  assert.deepEqual(state.integrityConflicts, ['sequence:1']);
});

test('event-id collision consumes its sequence and cannot stall ordered or shuffled projection', () => {
  const events = [
    frame(1, usage(1), { eventId: 'shared-event', family: 'telemetry' }),
    frame(2, usage(99), { eventId: 'shared-event', family: 'telemetry' }),
    frame(3, { kind: 'session-state', state: 'idle', permissionMode: null }),
  ];
  let ordered = seed();
  for (const event of events) ordered = applyConversationEvent(ordered, event);
  let shuffled = seed();
  for (const event of [events[1]!, events[2]!, events[0]!]) {
    shuffled = applyConversationEvent(shuffled, event);
  }

  assert.equal(ordered.projectedThroughSequence, 3);
  assert.equal(ordered.highWaterSequence, 3);
  assert.deepEqual(sequenceToArray(ordered.frames).map((event) => event.sequence), [1, 3]);
  assert.equal(ordered.aggregates.inputTokens, 1);
  assert.equal(ordered.aggregates.sessionState, 'idle');
  assert.deepEqual(ordered.integrityConflicts, ['event:shared-event']);
  assert.deepEqual(projectionView(shuffled), projectionView(ordered));
  assert.deepEqual(shuffled.projector, ordered.projector);

  const exactRejectedRedelivery = applyConversationEvent(ordered, events[1]!);
  assert.equal(exactRejectedRedelivery, ordered);
});

test('delta indexes hold gaps, release contiguous content, and ignore exact duplicates', () => {
  const delta = (sequence: number, deltaIndex: number, text: string) =>
    frame(
      sequence,
      { kind: 'stream-delta', delta: { kind: 'text-delta', text } },
      { itemId: 'item-stream', streamId: 'stream-1', deltaIndex },
    );
  let state = seed();
  state = applyConversationEvent(state, delta(3, 2, 'c'));
  assert.equal(state.deltas['stream-1'], undefined);
  state = applyConversationEvent(state, delta(1, 0, 'a'));
  assert.equal(state.deltas['stream-1']?.text, 'a');
  state = applyConversationEvent(state, delta(2, 1, 'b'));
  assert.equal(state.deltas['stream-1']?.text, 'abc');
  state = applyConversationEvent(state, delta(2, 1, 'b'));
  assert.equal(state.deltas['stream-1']?.text, 'abc');
});

test('conflicting delta index records integrity failure without changing first payload', () => {
  let state = seed();
  state = applyConversationEvent(state, frame(1, {
    kind: 'stream-delta',
    delta: { kind: 'text-delta', text: 'first' },
  }, { itemId: 'i', streamId: 's', deltaIndex: 0 }));
  state = applyConversationEvent(state, frame(2, {
    kind: 'stream-delta',
    delta: { kind: 'text-delta', text: 'other' },
  }, { itemId: 'i', streamId: 's', deltaIndex: 0 }));
  assert.equal(state.deltas.s?.text, 'first');
  assert.ok(state.integrityConflicts.includes('delta:s:0'));
});

test('a stream stays bound to one item, including after completion', () => {
  let state = seed();
  state = applyConversationEvent(state, frame(1, {
    kind: 'stream-delta', delta: { kind: 'text-delta', text: 'first' },
  }, { itemId: 'item-a', streamId: 'stream-a', deltaIndex: 0 }));
  state = applyConversationEvent(state, frame(2, {
    kind: 'stream-delta', delta: { kind: 'text-delta', text: 'wrong' },
  }, { itemId: 'item-b', streamId: 'stream-a', deltaIndex: 1 }));
  assert.equal(state.deltas['stream-a']?.text, 'first');
  assert.ok(state.integrityConflicts.includes('stream:stream-a:item'));

  state = applyConversationEvent(state, frame(3, {
    kind: 'assistant-text', text: 'complete', midLoop: false,
  }, { itemId: 'item-a', streamId: 'stream-a', family: 'assistant' }));
  state = applyConversationEvent(state, frame(4, {
    kind: 'stream-delta', delta: { kind: 'text-delta', text: 'late wrong item' },
  }, { itemId: 'item-b', streamId: 'stream-a', deltaIndex: 2 }));
  assert.equal(state.deltas['stream-a'], undefined);
  assert.equal(state.integrityConflicts.filter((c) => c === 'stream:stream-a:item').length, 1);
});

test('a mismatched stable item is excluded from the render projection', () => {
  let state = seed();
  state = applyConversationEvent(state, frame(1, {
    kind: 'stream-delta', delta: { kind: 'text-delta', text: 'partial' },
  }, { itemId: 'item-a', streamId: 'stream-a', deltaIndex: 0 }));
  state = applyConversationEvent(state, frame(2, {
    kind: 'assistant-text', text: 'wrong completion', midLoop: false,
  }, { itemId: 'item-b', streamId: 'stream-a', family: 'assistant' }));
  assert.deepEqual(sequenceToArray(state.frames).map((event) => event.sequence), [2]);
  assert.deepEqual(sequenceToArray(state.projectedFrames), []);
  assert.equal(state.deltas['stream-a']?.text, 'partial');
  assert.ok(state.integrityConflicts.includes('stream:stream-a:item'));
});

test('delta conflicts remain deterministic after completion and retraction', () => {
  const events = [
    frame(1, {
      kind: 'stream-delta', delta: { kind: 'text-delta', text: 'first' },
    }, { itemId: 'item-a', streamId: 'stream-a', deltaIndex: 0 }),
    frame(2, {
      kind: 'assistant-text', text: 'complete', midLoop: false,
    }, { itemId: 'item-a', streamId: 'stream-a', family: 'assistant' }),
    frame(3, {
      kind: 'stream-delta', delta: { kind: 'text-delta', text: 'conflict' },
    }, { itemId: 'item-a', streamId: 'stream-a', deltaIndex: 0 }),
    frame(4, { kind: 'retract', streamIds: ['stream-a'] }),
  ];
  let ordered = seed();
  for (const event of events) ordered = applyConversationEvent(ordered, event);
  let shuffled = seed();
  for (const event of [events[3]!, events[2]!, events[0]!, events[1]!]) {
    shuffled = applyConversationEvent(shuffled, event);
  }
  assert.ok(ordered.integrityConflicts.includes('delta:stream-a:0'));
  assert.deepEqual(shuffled.integrityConflicts, ordered.integrityConflicts);
  assert.deepEqual(
    sequenceToArray(shuffled.projectedFrames),
    sequenceToArray(ordered.projectedFrames),
  );
  assert.deepEqual(shuffled.deltas, ordered.deltas);
});

test('stable completion supersedes its stream buffer and late deltas cannot resurrect it', () => {
  let state = seed();
  state = applyConversationEvent(state, frame(1, {
    kind: 'stream-delta',
    delta: { kind: 'text-delta', text: 'partial' },
  }, { itemId: 'i', streamId: 's', deltaIndex: 0 }));
  state = applyConversationEvent(state, frame(2, {
    kind: 'assistant-text', text: 'complete', midLoop: false,
  }, { itemId: 'i', streamId: 's', family: 'assistant' }));
  assert.equal(state.deltas.s, undefined);
  state = applyConversationEvent(state, frame(3, {
    kind: 'stream-delta', delta: { kind: 'text-delta', text: 'late' },
  }, { itemId: 'i', streamId: 's', deltaIndex: 1 }));
  assert.equal(state.deltas.s, undefined);
});

test('replay with shuffled exact duplicates equals uninterrupted live projection', () => {
  const events = [
    frame(1, { kind: 'user', text: 'hi' }, { clientMessageId: 'cm1' }),
    frame(2, usage(50), { family: 'telemetry' }),
    frame(3, { kind: 'turn-duration', durationMs: 1200 }, { family: 'telemetry' }),
  ];
  let live = seed();
  for (const event of events) live = applyConversationEvent(live, event);
  const replay: SessionReplayFrame = {
    type: 'session-replay',
    projectId: 'project-1',
    sessionId: SID,
    highWaterSequence: 3,
    events: [events[2]!, events[0]!, events[1]!, events[1]!],
  };
  const restored = applyReplay(seed(), replay);
  assert.deepEqual(sequenceToArray(restored.frames), sequenceToArray(live.frames));
  assert.deepEqual(restored.aggregates, live.aggregates);
  assert.deepEqual(restored.deltas, live.deltas);
});

test('foreign session events are ignored and canonical user event reconciles optimistic send', () => {
  let state = seed();
  state = {
    ...state,
    optimistic: [{ clientMessageId: 'cm1', text: 'hello', status: 'sending', failureReason: null }],
  };
  state = applyConversationEvent(state, frame(1, { kind: 'user', text: 'hello' }, { clientMessageId: 'cm1' }));
  assert.equal(state.optimistic.length, 0);
  const foreign = frame(2, { kind: 'user', text: 'no' }, {
    eventId: 'foreign', conversationId: 'other', sessionId: 'other',
  });
  assert.equal(applyConversationEvent(state, foreign), state);
});

test('ordered large-stream projection stays incremental and compacts every completed raw payload', () => {
  const marker = 'RAW-PAYLOAD-';
  const streamCount = 64;
  const deltasPerStream = 64;
  const total: ProjectionWork = {
    path: 'ordered',
    acceptedEventVisits: 0,
    historyVisits: 0,
    fallbackRebuilds: 0,
    compactedDeltaPayloads: 0,
  };
  let sequence = 0;
  let state = seed();

  for (let stream = 0; stream < streamCount; stream += 1) {
    const streamId = `scale-stream-${stream}`;
    const itemId = `scale-item-${stream}`;
    for (let index = 0; index < deltasPerStream; index += 1) {
      sequence += 1;
      const beforeProjection = state.projectedFrames;
      const reduced = reduceConversationEvent(state, frame(sequence, {
        kind: 'stream-delta',
        delta: { kind: 'text-delta', text: `${marker}${stream}-${index};` },
      }, { itemId, streamId, deltaIndex: index, family: 'assistant' }));
      assert.equal(reduced.work.path, 'ordered');
      assert.equal(reduced.state.projectedFrames, beforeProjection);
      addWork(total, reduced.work);
      state = reduced.state;
    }
    sequence += 1;
    const reduced = reduceConversationEvent(state, frame(sequence, {
      kind: 'assistant-text', text: `complete stream ${stream}`, midLoop: false,
    }, { itemId, streamId, family: 'assistant' }));
    assert.equal(reduced.work.compactedDeltaPayloads, deltasPerStream);
    addWork(total, reduced.work);
    state = reduced.state;
  }

  assert.equal(sequence, streamCount * (deltasPerStream + 1));
  assert.equal(total.acceptedEventVisits, sequence);
  assert.equal(total.historyVisits, 0);
  assert.equal(total.fallbackRebuilds, 0);
  assert.equal(total.compactedDeltaPayloads, streamCount * deltasPerStream);
  assert.equal(state.frames.length, streamCount);
  assert.equal(state.projectedFrames.length, streamCount);
  assert.equal(Object.keys(state.deltas).length, 0);
  assert.equal(state.projector.pendingFrames, null);
  assert.equal(state.projector.sequenceReceipts?.size, sequence);
  assert.equal(containsText(state, marker), false);
});

test('stable-heavy projection appends through bounded persistent chunks without history copies', () => {
  const eventCount = 4_096;
  const total: ProjectionWork = {
    path: 'ordered',
    acceptedEventVisits: 0,
    historyVisits: 0,
    fallbackRebuilds: 0,
    compactedDeltaPayloads: 0,
  };
  let state = seed();
  let partial: ChatState | null = null;
  for (let sequence = 1; sequence <= eventCount; sequence += 1) {
    const reduced = reduceConversationEvent(
      state,
      frame(sequence, usage(1), { family: 'telemetry' }),
    );
    addWork(total, reduced.work);
    state = reduced.state;
    if (sequence === PERSISTENT_SEQUENCE_CHUNK_SIZE - 1) partial = state;
  }

  assert.equal(total.acceptedEventVisits, eventCount);
  assert.equal(total.historyVisits, 0);
  assert.equal(total.fallbackRebuilds, 0);
  assert.equal(state.aggregates.inputTokens, eventCount);
  assert.equal(state.frames.length, eventCount);
  assert.equal(state.projectedFrames.length, eventCount);
  assert.equal(maxChunkSize(state.frames), PERSISTENT_SEQUENCE_CHUNK_SIZE);
  assert.equal(maxChunkSize(state.projectedFrames), PERSISTENT_SEQUENCE_CHUNK_SIZE);
  assert.equal(chunkCount(state.frames), eventCount / PERSISTENT_SEQUENCE_CHUNK_SIZE);
  assert.equal(chunkCount(state.projectedFrames), eventCount / PERSISTENT_SEQUENCE_CHUNK_SIZE);
  const materialized = sequenceToArray(state.frames);
  assert.equal(materialized[0]!.sequence, 1);
  assert.equal(materialized.at(-1)!.sequence, eventCount);
  assert.deepEqual(
    materialized.map((event) => event.sequence),
    Array.from({ length: eventCount }, (_, index) => index + 1),
  );
  assert.deepEqual(sequenceToArray(state.projectedFrames), materialized);

  assert.ok(partial);
  const branch = applyConversationEvent(
    partial,
    frame(PERSISTENT_SEQUENCE_CHUNK_SIZE, usage(9), { family: 'telemetry' }),
  );
  assert.equal(partial.frames.length, PERSISTENT_SEQUENCE_CHUNK_SIZE - 1);
  assert.equal(sequenceToArray(partial.frames).at(-1)!.sequence, PERSISTENT_SEQUENCE_CHUNK_SIZE - 1);
  assert.equal(branch.frames.length, PERSISTENT_SEQUENCE_CHUNK_SIZE);
  assert.equal(branch.aggregates.inputTokens, PERSISTENT_SEQUENCE_CHUNK_SIZE - 1 + 9);
});

test('post-compaction receipts preserve exact duplicates and fail closed on changed payload or item', () => {
  const raw = frame(1, {
    kind: 'stream-delta', delta: { kind: 'text-delta', text: 'RAW-COMPACT-ME' },
  }, { itemId: 'item-a', streamId: 'stream-a', deltaIndex: 0, family: 'assistant' });
  const complete = frame(2, {
    kind: 'assistant-text', text: 'stable replacement', midLoop: false,
  }, { itemId: 'item-a', streamId: 'stream-a', family: 'assistant' });
  let state = applyConversationEvent(seed(), raw);
  state = applyConversationEvent(state, complete);
  assert.equal(containsText(state, 'RAW-COMPACT-ME'), false);

  const exact = reduceConversationEvent(state, raw);
  assert.equal(exact.work.path, 'duplicate');
  assert.equal(exact.state, state);

  state = applyConversationEvent(state, frame(3, {
    kind: 'stream-delta', delta: { kind: 'text-delta', text: 'changed payload' },
  }, { itemId: 'item-a', streamId: 'stream-a', deltaIndex: 0, family: 'assistant' }));
  assert.ok(state.integrityConflicts.includes('delta:stream-a:0'));
  assert.equal(state.deltas['stream-a'], undefined);

  state = applyConversationEvent(state, frame(4, {
    kind: 'stream-delta', delta: { kind: 'text-delta', text: 'wrong item' },
  }, { itemId: 'item-b', streamId: 'stream-a', deltaIndex: 1, family: 'assistant' }));
  assert.ok(state.integrityConflicts.includes('stream:stream-a:item'));
  assert.equal(state.deltas['stream-a'], undefined);
});

test('completion and terminal compaction are stream-scoped then exhaustive', () => {
  let state = seed();
  state = applyConversationEvent(state, frame(1, {
    kind: 'stream-delta', delta: { kind: 'text-delta', text: 'alpha raw' },
  }, { itemId: 'item-a', streamId: 'stream-a', deltaIndex: 0, family: 'assistant' }));
  state = applyConversationEvent(state, frame(2, {
    kind: 'stream-delta', delta: { kind: 'text-delta', text: 'beta raw' },
  }, { itemId: 'item-b', streamId: 'stream-b', deltaIndex: 0, family: 'assistant' }));
  const completed = reduceConversationEvent(state, frame(3, {
    kind: 'assistant-text', text: 'alpha stable', midLoop: false,
  }, { itemId: 'item-a', streamId: 'stream-a', family: 'assistant' }));
  assert.equal(completed.work.compactedDeltaPayloads, 1);
  assert.equal(completed.state.deltas['stream-a'], undefined);
  assert.equal(completed.state.deltas['stream-b']?.text, 'beta raw');

  const terminal = reduceConversationEvent(completed.state, frame(4, {
    kind: 'turn-end', text: '', stopReason: 'complete',
  }, { itemId: 'turn-terminal', family: 'control' }));
  assert.equal(terminal.work.compactedDeltaPayloads, 1);
  assert.deepEqual(terminal.state.deltas, {});
  const late = applyConversationEvent(terminal.state, frame(5, {
    kind: 'stream-delta', delta: { kind: 'text-delta', text: 'late beta' },
  }, { itemId: 'item-b', streamId: 'stream-b', deltaIndex: 1, family: 'assistant' }));
  assert.equal(late.deltas['stream-b'], undefined);
});

test('completion-first shuffled live delivery and shuffled replay converge with ordered projection', () => {
  const events = [
    frame(1, {
      kind: 'stream-delta', delta: { kind: 'text-delta', text: 'part one ' },
    }, { itemId: 'item-a', streamId: 'stream-a', deltaIndex: 0, family: 'assistant' }),
    frame(2, {
      kind: 'stream-delta', delta: { kind: 'text-delta', text: 'part two' },
    }, { itemId: 'item-a', streamId: 'stream-a', deltaIndex: 1, family: 'assistant' }),
    frame(3, {
      kind: 'assistant-text', text: 'stable answer', midLoop: false,
    }, { itemId: 'item-a', streamId: 'stream-a', family: 'assistant' }),
    frame(4, { kind: 'retract', streamIds: ['stream-a'] }, { family: 'control' }),
    frame(5, { kind: 'session-state', state: 'idle', permissionMode: null }),
  ];
  let ordered = seed();
  for (const event of events) ordered = applyConversationEvent(ordered, event);

  let shuffled = seed();
  for (const event of [events[2]!, events[4]!, events[3]!, events[1]!, events[0]!]) {
    shuffled = applyConversationEvent(shuffled, event);
  }

  const replay = reduceReplay(seed(), {
    type: 'session-replay',
    projectId: 'project-1',
    sessionId: SID,
    highWaterSequence: 5,
    events: [events[3]!, events[1]!, events[4]!, events[0]!, events[2]!],
  });
  assert.equal(replay.work.fallbackRebuilds, 1);
  assert.equal(replay.work.historyVisits, events.length);
  assert.deepEqual(projectionView(shuffled), projectionView(ordered));
  assert.deepEqual(projectionView(replay.state), projectionView(ordered));
  assert.deepEqual(replay.state.projector, ordered.projector);
});

test('replay checkpoint skips hidden gaps once and admits the next live sequence directly', () => {
  const visible = [
    frame(2, { kind: 'user', text: 'visible after hidden row' }),
    frame(5, usage(5), { family: 'telemetry' }),
  ];
  const replay = reduceReplay(seed(), {
    type: 'session-replay',
    projectId: 'project-1',
    sessionId: SID,
    highWaterSequence: 7,
    events: [visible[1]!, visible[0]!],
  });
  assert.equal(replay.state.highWaterSequence, 7);
  assert.equal(replay.state.projectedThroughSequence, 7);
  assert.equal(replay.state.projector.pendingFrames, null);

  const live = reduceConversationEvent(replay.state, frame(8, {
    kind: 'session-state', state: 'idle', permissionMode: null,
  }));
  assert.equal(live.work.path, 'ordered');
  assert.equal(live.state.projectedThroughSequence, 8);
  assert.equal(live.state.projector.pendingFrames, null);
});

test('persistent projector indexes keep prior states immutable and branch deterministically', () => {
  const first = frame(1, {
    kind: 'stream-delta', delta: { kind: 'text-delta', text: 'first' },
  }, { itemId: 'item-a', streamId: 'stream-a', deltaIndex: 0, family: 'assistant' });
  const base = applyConversationEvent(seed(), first);
  const untouched = structuredClone(base);
  const clonedBranch = structuredClone(base);
  const second = frame(2, {
    kind: 'stream-delta', delta: { kind: 'text-delta', text: ' second' },
  }, { itemId: 'item-a', streamId: 'stream-a', deltaIndex: 1, family: 'assistant' });
  const completion = frame(2, {
    kind: 'assistant-text', text: 'stable', midLoop: false,
  }, { itemId: 'item-a', streamId: 'stream-a', family: 'assistant' });

  const streamed = applyConversationEvent(base, second);
  const streamedFromClone = applyConversationEvent(clonedBranch, second);
  const completed = applyConversationEvent(base, completion);
  assert.deepEqual(base, untouched);
  assert.deepEqual(streamed, streamedFromClone);
  assert.equal(streamed.deltas['stream-a']?.text, 'first second');
  assert.equal(completed.deltas['stream-a'], undefined);
  assert.deepEqual(base, untouched);
});
