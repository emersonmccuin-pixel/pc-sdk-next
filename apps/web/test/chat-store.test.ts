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
  type ChatState,
} from '../src/features/chat/chat-reducer.ts';

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
  assert.deepEqual(shuffled.frames, ordered.frames);
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
  assert.equal(state.frames[0]!.eventId, accepted.eventId);
  assert.equal(state.aggregates.inputTokens, 10);
  assert.deepEqual(state.integrityConflicts, ['sequence:1']);
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
  assert.equal(state.deltas['stream-1']?.text, '');
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
  assert.deepEqual(state.projectedFrames.map((event) => event.sequence), [1]);
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
  assert.deepEqual(shuffled.projectedFrames, ordered.projectedFrames);
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
  assert.deepEqual(restored.frames, live.frames);
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
