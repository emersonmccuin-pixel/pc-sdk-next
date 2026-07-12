// Turn-runner unit tests — mapping table + guard rules 3 & 5, subagent filter.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { safeToolSummary, type ChatEvent, type ChatDeltaEvent, type ToolStateEvent } from '@pc/contracts';
import type { RuntimeEvent } from '../src/runner/runtime.ts';
import { runTurn } from '../src/chat/turn-runner.ts';

function collector() {
  const chat: ChatEvent[] = [];
  const deltas: Array<{ itemId: string; deltaIndex: number; event: ChatDeltaEvent }> = [];
  const dropped: string[] = [];
  return {
    chat,
    deltas,
    dropped,
    deps: {
      emitChat: (event: ChatEvent) => chat.push(event),
      emitDelta: (itemId: string, deltaIndex: number, event: ChatDeltaEvent) =>
        deltas.push({ itemId, deltaIndex, event }),
      onDropped: (reason: string) => dropped.push(reason),
    },
  };
}

async function* stream(msgs: RuntimeEvent[]): AsyncIterable<RuntimeEvent> {
  for (const m of msgs) yield m;
}

function terminals(chat: ChatEvent[]): ChatEvent[] {
  return chat.filter((e) => e.kind === 'turn-end' || e.kind === 'turn-failed');
}

function tool(
  state: ToolStateEvent['state'],
  over: Partial<ToolStateEvent> = {},
): ToolStateEvent {
  const approval: ToolStateEvent['approval'] = state === 'requested'
    ? { status: 'unknown', source: null, requestId: null }
    : state === 'approval-needed'
      ? { status: 'pending', source: null, requestId: 'approval-1' }
      : state === 'denied'
        ? { status: 'denied', source: 'user', requestId: 'approval-1' }
        : { status: 'not-required', source: 'runtime', requestId: null };
  return {
    kind: 'tool-state',
    callId: 'call-1',
    name: 'Read',
    state,
    safeSummary: safeToolSummary('Read'),
    approval,
    outcome: state === 'failed' ? { reason: 'tool-error' } : null,
    ...over,
  };
}

test('success turn maps blocks and ends in exactly one turn-end', async () => {
  const c = collector();
  const term = await runTurn(
    stream([
      { type: 'init', nativeSessionId: 's1', model: 'opus', permissionMode: 'default' },
      { type: 'assistant-block', itemId: 'u1', scope: 'primary', block: { kind: 'text', text: 'hi' } },
      { type: 'tool-state', scope: 'primary', event: tool('requested') },
      { type: 'tool-state', scope: 'primary', event: tool('running') },
      { type: 'tool-state', scope: 'primary', event: tool('succeeded') },
      { type: 'result', ok: true, stopReason: 'complete', usage: { inputTokens: 1, outputTokens: 2, cacheCreationTokens: 0, cacheReadTokens: 0, model: 'opus' }, durationMs: 5, error: null, outcome: 'ok', numTurns: 3 },
    ]),
    c.deps,
  );
  assert.deepEqual(term, { terminal: 'turn-end', outcome: 'ok', numTurns: 3 });
  assert.equal(terminals(c.chat).length, 1);
  assert.equal(terminals(c.chat)[0].kind, 'turn-end');
  assert.ok(c.chat.some((e) => e.kind === 'usage'));
  assert.ok(c.chat.some((e) => e.kind === 'turn-duration'));
  assert.deepEqual(
    c.chat.filter((e): e is ToolStateEvent => e.kind === 'tool-state').map((e) => e.state),
    ['requested', 'running', 'succeeded'],
  );
  assert.ok(c.chat.some((e) => e.kind === 'activity-state' && e.phase === 'responding'));
});

test('error result ends in exactly one turn-failed (api)', async () => {
  const c = collector();
  const term = await runTurn(
    stream([{ type: 'result', ok: false, stopReason: null, usage: null, durationMs: null, error: 'boom', outcome: 'error', numTurns: 4 }]),
    c.deps,
  );
  assert.deepEqual(term, { terminal: 'turn-failed', outcome: 'error', numTurns: 4 });
  const t = terminals(c.chat);
  assert.equal(t.length, 1);
  assert.deepEqual(t[0], { kind: 'turn-failed', error: 'boom', source: 'api' });
});

test('canonical budget-exhausted outcome remains distinct from a crash', async () => {
  const c = collector();
  const term = await runTurn(
    stream([{ type: 'result', ok: false, stopReason: null, usage: null, durationMs: null, error: 'turn limit reached', outcome: 'budget-exhausted', numTurns: 100 }]),
    c.deps,
  );
  assert.deepEqual(term, { terminal: 'turn-failed', outcome: 'budget-exhausted', numTurns: 100 });
});

test('canonical aborted outcome maps to turn-failed source abort', async () => {
  const c = collector();
  const term = await runTurn(
    stream([{ type: 'result', ok: false, stopReason: null, usage: null, durationMs: null, error: 'interrupted', outcome: 'aborted', numTurns: null }]),
    c.deps,
  );
  const t = terminals(c.chat);
  assert.equal(t.length, 1);
  assert.equal((t[0] as { source: string }).source, 'abort');
  assert.deepEqual(term, { terminal: 'turn-failed', outcome: 'aborted', numTurns: null });
});

test('runtime exception text is neither interruption evidence nor durable provider prose', async () => {
  const c = collector();
  async function* throwsAbortText(): AsyncIterable<RuntimeEvent> {
    throw new Error('AbortError: SECRET provider transport detail');
  }
  const term = await runTurn(throwsAbortText(), c.deps);
  assert.deepEqual(term, { terminal: 'turn-failed', outcome: 'error', numTurns: null });
  assert.deepEqual(terminals(c.chat), [{
    kind: 'turn-failed',
    error: 'runtime stream failed',
    source: 'internal',
  }]);
  assert.equal(JSON.stringify(c.chat).includes('SECRET'), false);
  assert.ok(c.dropped.includes('runtime stream error'));
});

test('an incoherent runtime result fails closed with app-authored prose', async () => {
  const c = collector();
  const contradictory = {
    type: 'result', ok: true, stopReason: null, usage: null, durationMs: 1,
    error: 'SECRET contradictory provider error', outcome: 'error', numTurns: 7,
  } as unknown as RuntimeEvent;
  const term = await runTurn(stream([contradictory]), c.deps);
  assert.deepEqual(term, { terminal: 'turn-failed', outcome: 'error', numTurns: null });
  assert.deepEqual(terminals(c.chat), [{
    kind: 'turn-failed',
    error: 'runtime returned an invalid terminal receipt',
    source: 'internal',
  }]);
  assert.equal(JSON.stringify(c.chat).includes('SECRET'), false);
  assert.ok(c.dropped.includes('incoherent runtime result'));
});

test('stream ending with no result still terminates (internal) — rule 3', async () => {
  const c = collector();
  const term = await runTurn(
    stream([{ type: 'assistant-block', itemId: 'u1', scope: 'primary', block: { kind: 'text', text: 'orphan' } }]),
    c.deps,
  );
  assert.deepEqual(term, { terminal: 'turn-failed', outcome: 'error', numTurns: null });
  const t = terminals(c.chat);
  assert.equal(t.length, 1);
  assert.equal((t[0] as { source: string }).source, 'internal');
});

test('result evidence synthesizes running and every open tool closes before turn terminal', async () => {
  const direct = collector();
  await runTurn(stream([
    { type: 'tool-state', scope: 'primary', event: tool('requested') },
    { type: 'tool-state', scope: 'primary', event: tool('succeeded') },
    { type: 'result', ok: true, stopReason: 'complete', usage: null, durationMs: 0, error: null, outcome: 'ok', numTurns: null },
  ]), direct.deps);
  assert.deepEqual(
    direct.chat.filter((e): e is ToolStateEvent => e.kind === 'tool-state').map((e) => e.state),
    ['requested', 'running', 'succeeded'],
  );

  const open = collector();
  await runTurn(stream([
    { type: 'tool-state', scope: 'primary', event: tool('requested') },
    { type: 'result', ok: false, stopReason: null, usage: null, durationMs: 0, error: 'runtime failed', outcome: 'error', numTurns: null },
  ]), open.deps);
  const kinds = open.chat.map((event) => event.kind === 'tool-state' ? `tool:${event.state}` : event.kind);
  assert.deepEqual(kinds.slice(-4), ['tool:requested', 'tool:failed', 'turn-duration', 'turn-failed']);
  const closed = open.chat.find((event): event is ToolStateEvent => (
    event.kind === 'tool-state' && event.state === 'failed'
  ));
  assert.deepEqual(closed?.outcome, { reason: 'turn-ended' });
});

test('pending approval is session-denied before an exceptional turn terminal', async () => {
  const c = collector();
  await runTurn(stream([
    { type: 'tool-state', scope: 'primary', event: tool('requested') },
    { type: 'tool-state', scope: 'primary', event: tool('approval-needed') },
    { type: 'tool-state', scope: 'primary', event: tool('succeeded') },
  ]), c.deps);
  const states = c.chat.filter((event): event is ToolStateEvent => event.kind === 'tool-state');
  assert.deepEqual(states.map((event) => event.state), ['requested', 'approval-needed', 'denied']);
  assert.deepEqual(states.at(-1)?.approval, {
    status: 'denied', source: 'session', requestId: 'approval-1',
  });
  assert.equal(c.chat.at(-1)?.kind, 'turn-failed');
  assert.ok(c.dropped.some((reason) => reason.includes('approval provenance')));
});

test('sidechain runtime messages are not forwarded', async () => {
  const c = collector();
  await runTurn(
    stream([
      { type: 'assistant-block', itemId: 'x', scope: 'sidechain', block: { kind: 'text', text: 'sub' } },
      { type: 'delta', itemId: 'x', scope: 'sidechain', delta: { kind: 'text-delta', text: 'sub' } },
      { type: 'tool-state', scope: 'sidechain', event: tool('requested') },
      { type: 'result', ok: true, stopReason: 'complete', usage: null, durationMs: 0, error: null, outcome: 'ok', numTurns: null },
    ]),
    c.deps,
  );
  assert.equal(c.chat.filter((e) => e.kind === 'assistant-text').length, 0);
  assert.equal(c.deltas.length, 0);
  assert.ok(c.dropped.length >= 3);
});

test('unknown variant is dropped + logged, loop continues — rule 5', async () => {
  const c = collector();
  const term = await runTurn(
    stream([
      { type: 'no-such-variant' } as unknown as RuntimeEvent,
      { type: 'result', ok: true, stopReason: 'complete', usage: null, durationMs: 0, error: null, outcome: 'ok', numTurns: null },
    ]),
    c.deps,
  );
  assert.deepEqual(term, { terminal: 'turn-end', outcome: 'ok', numTurns: null });
  assert.ok(c.dropped.some((r) => r.includes('unknown')));
});

test('runtime retry persists only app-authored numeric status', async () => {
  const c = collector();
  await runTurn(stream([
    { type: 'api-retry', attempt: 2, maxRetries: 5 },
    { type: 'result', ok: true, stopReason: 'complete', usage: null, durationMs: 0, error: null, outcome: 'ok', numTurns: null },
  ]), c.deps);
  assert.ok(c.chat.some((event) => event.kind === 'activity-state' && event.phase === 'retrying'));
  assert.ok(c.chat.some((event) => (
    event.kind === 'system'
    && event.subtype === 'runtime-retry'
    && event.message === 'Retrying the runtime request (attempt 2 of 5).'
    && !('raw' in event)
  )));
});

test('visible deltas use the canonical delta emission door', async () => {
  const c = collector();
  await runTurn(
    stream([
      { type: 'delta', itemId: 'u1', scope: 'primary', delta: { kind: 'message-start' } },
      { type: 'delta', itemId: 'u1', scope: 'primary', delta: { kind: 'text-delta', text: 'yo' } },
      { type: 'result', ok: true, stopReason: 'complete', usage: null, durationMs: 0, error: null, outcome: 'ok', numTurns: null },
    ]),
    c.deps,
  );
  assert.equal(c.deltas.length, 2);
  assert.equal(c.chat.filter((e) => e.kind === 'assistant-text').length, 0);
});
