// Guard tests for the chat reducer — the contract invariants that must hold.
// Self-contained (no '@/' alias, no React), runs under `tsx --test`.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import type {
  ChatDeltaFrame,
  ChatEvent,
  ChatFrame,
  SessionReplayFrame,
} from '../../../packages/contracts/src/events/index.ts';
import {
  applyChatFrame,
  applyDelta,
  applyReplay,
  initialChatState,
  type ChatState,
} from '../src/features/chat/chat-reducer.ts';

const SID = 'sess-1';

function frame(seq: number, event: ChatEvent, extra: Partial<ChatFrame> = {}): ChatFrame {
  return {
    type: 'chat',
    projectId: 'proj-1',
    sessionId: SID,
    seq,
    id: `${SID}:${seq}`,
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
    model: 'claude-opus',
  };
}

function seed(): ChatState {
  return initialChatState(SID);
}

// Rule 1 + 2: duplicate seq replaces WITHOUT re-folding aggregates.
test('duplicate seq delivery does not double-count aggregates', () => {
  let s = seed();
  s = applyChatFrame(s, frame(1, { kind: 'user', text: 'hi' }));
  s = applyChatFrame(s, frame(2, usage(100)));
  assert.equal(s.aggregates.inputTokens, 100);
  // Re-deliver seq 2 (same payload) — must not add another 100.
  s = applyChatFrame(s, frame(2, usage(100)));
  assert.equal(s.aggregates.inputTokens, 100, 're-delivery double-counted tokens');
  assert.equal(s.frames.length, 2);
});

// Rule 1: out-of-order arrival inserts into seq position.
test('out-of-order frames insert in seq order', () => {
  let s = seed();
  s = applyChatFrame(s, frame(3, { kind: 'assistant-text', text: 'c', midLoop: false }));
  s = applyChatFrame(s, frame(1, { kind: 'user', text: 'a' }));
  s = applyChatFrame(s, frame(2, { kind: 'assistant-text', text: 'b', midLoop: false }));
  assert.deepEqual(s.frames.map((f) => f.seq), [1, 2, 3]);
});

// Rule 3: a persisted frame with a given sdkUuid discards its live delta buffer.
test('persisted frame replaces the delta buffer by sdkUuid', () => {
  const uuid = 'msg-abc';
  let s = seed();
  const delta: ChatDeltaFrame = {
    type: 'chat-delta',
    projectId: 'proj-1',
    sessionId: SID,
    sdkUuid: uuid,
    event: { kind: 'text-delta', text: 'partial ' },
  };
  s = applyDelta(s, delta);
  s = applyDelta(s, { ...delta, event: { kind: 'text-delta', text: 'more' } });
  assert.equal(s.deltas[uuid]?.text, 'partial more');
  // The persisted block lands — buffer must be gone.
  s = applyChatFrame(
    s,
    frame(1, { kind: 'assistant-text', text: 'partial more', midLoop: false }, { sdkUuid: uuid }),
  );
  assert.equal(s.deltas[uuid], undefined, 'delta buffer survived the persisted frame');
  // A late delta for an already-persisted uuid is ignored.
  s = applyDelta(s, { ...delta, event: { kind: 'text-delta', text: 'late' } });
  assert.equal(s.deltas[uuid], undefined, 'late delta resurrected a persisted buffer');
});

// Turn terminal clears orphaned delta buffers (a buffer whose persisted block
// never landed must not ghost into the next turn).
test('turn-end drops orphaned delta buffers', () => {
  let s = seed();
  s = applyDelta(s, {
    type: 'chat-delta',
    projectId: 'proj-1',
    sessionId: SID,
    sdkUuid: 'msg-orphan',
    event: { kind: 'text-delta', text: 'stray' },
  });
  assert.equal(s.deltas['msg-orphan']?.text, 'stray');
  s = applyChatFrame(s, frame(1, { kind: 'turn-end', text: 'done', stopReason: null }));
  assert.deepEqual(s.deltas, {}, 'orphan buffer survived turn-end');
});

// Rule 4 + 6: replay re-seed produces state identical to an uninterrupted socket.
test('replay re-seed equals uninterrupted delivery (frames + aggregates)', () => {
  const events: ChatFrame[] = [
    frame(1, { kind: 'user', text: 'hi' }),
    frame(2, usage(50)),
    frame(3, { kind: 'assistant-text', text: 'yo', midLoop: false }),
    frame(4, { kind: 'turn-duration', durationMs: 1200 }),
    frame(5, { kind: 'session-state', state: 'idle', permissionMode: null }),
  ];
  // Uninterrupted socket.
  let live = seed();
  for (const f of events) live = applyChatFrame(live, f);

  // Reconnect: replay reseeds wholesale (events delivered shuffled).
  let reconnected = seed();
  const replay: SessionReplayFrame = {
    type: 'session-replay',
    projectId: 'proj-1',
    sessionId: SID,
    highWaterSeq: 5,
    events: [events[2]!, events[0]!, events[4]!, events[1]!, events[3]!],
  };
  reconnected = applyReplay(reconnected, replay);

  assert.deepEqual(
    reconnected.frames.map((f) => f.seq),
    live.frames.map((f) => f.seq),
  );
  assert.deepEqual(reconnected.aggregates, live.aggregates);
  assert.equal(reconnected.aggregates.inputTokens, 50);
  assert.equal(reconnected.aggregates.lastTurnDurationMs, 1200);
  assert.equal(reconnected.aggregates.sessionState, 'idle');
});

// Rule 5: retract evicts already-delivered events by sdkUuid and recomputes.
test('retract evicts frames by sdkUuid and recomputes aggregates', () => {
  const uuid = 'msg-refused';
  let s = seed();
  s = applyChatFrame(s, frame(1, { kind: 'user', text: 'go' }));
  s = applyChatFrame(s, frame(2, usage(80), { sdkUuid: uuid }));
  s = applyChatFrame(
    s,
    frame(3, { kind: 'assistant-text', text: 'oops', midLoop: false }, { sdkUuid: uuid }),
  );
  assert.equal(s.aggregates.inputTokens, 80);
  // Refusal fallback: retract the two uuid-tagged events.
  s = applyChatFrame(s, frame(4, { kind: 'retract', uuids: [uuid] }));
  const remaining = s.frames.filter((f) => f.sdkUuid === uuid);
  assert.equal(remaining.length, 0, 'retracted frames still present');
  assert.equal(s.aggregates.inputTokens, 0, 'aggregates not recomputed after retract');
  // The user frame survives.
  assert.ok(s.frames.some((f) => f.event.kind === 'user'));
});

// Rule 6: the clientMessageId-stamped user frame clears its optimistic send.
test('canonical user frame reconciles the optimistic send', () => {
  const cid = 'client-msg-1';
  let s = seed();
  s = { ...s, optimistic: [{ clientMessageId: cid, text: 'hello', status: 'sending', failureReason: null }] };
  s = applyChatFrame(s, frame(1, { kind: 'user', text: 'hello' }, { clientMessageId: cid }));
  assert.equal(s.optimistic.length, 0, 'optimistic send not reconciled by clientMessageId');
});

// Cross-session frames are dropped client-side.
test('frames for a non-active session are dropped', () => {
  let s = seed();
  const foreign = frame(1, { kind: 'user', text: 'nope' }, { sessionId: 'other', id: 'other:1' });
  s = applyChatFrame(s, foreign);
  assert.equal(s.frames.length, 0);
});
