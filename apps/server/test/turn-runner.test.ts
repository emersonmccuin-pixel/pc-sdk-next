// Turn-runner unit tests — mapping table + guard rules 3 & 5, subagent filter.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { ChatEvent, ChatDeltaEvent } from '@pc/contracts';
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

test('success turn maps blocks and ends in exactly one turn-end', async () => {
  const c = collector();
  const term = await runTurn(
    stream([
      { type: 'init', nativeSessionId: 's1', model: 'opus', permissionMode: 'default' },
      { type: 'assistant-block', itemId: 'u1', scope: 'primary', block: { kind: 'text', text: 'hi' } },
      { type: 'assistant-block', itemId: 'u1', scope: 'primary', block: { kind: 'tool_use', toolUseId: 't1', name: 'Read', input: {} } },
      { type: 'tool-result', itemId: 'u2', scope: 'primary', toolUseId: 't1', result: 'ok', isError: false },
      { type: 'result', ok: true, stopReason: 'complete', usage: { inputTokens: 1, outputTokens: 2, cacheCreationTokens: 0, cacheReadTokens: 0, model: 'opus' }, durationMs: 5, error: null, outcome: 'ok', numTurns: 3 },
    ]),
    c.deps,
  );
  assert.deepEqual(term, { terminal: 'turn-end', outcome: 'ok', numTurns: 3 });
  assert.equal(terminals(c.chat).length, 1);
  assert.equal(terminals(c.chat)[0].kind, 'turn-end');
  assert.ok(c.chat.some((e) => e.kind === 'usage'));
  assert.ok(c.chat.some((e) => e.kind === 'turn-duration'));
  assert.ok(c.chat.some((e) => e.kind === 'tool-call'));
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

test('sidechain runtime messages are not forwarded', async () => {
  const c = collector();
  await runTurn(
    stream([
      { type: 'assistant-block', itemId: 'x', scope: 'sidechain', block: { kind: 'text', text: 'sub' } },
      { type: 'delta', itemId: 'x', scope: 'sidechain', delta: { kind: 'text-delta', text: 'sub' } },
      { type: 'result', ok: true, stopReason: 'complete', usage: null, durationMs: 0, error: null, outcome: 'ok', numTurns: null },
    ]),
    c.deps,
  );
  assert.equal(c.chat.filter((e) => e.kind === 'assistant-text').length, 0);
  assert.equal(c.deltas.length, 0);
  assert.ok(c.dropped.length >= 2);
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
