// Turn-runner unit tests — mapping table + guard rules 3 & 5, subagent filter.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { ChatEvent, ChatDeltaEvent } from '@pc/contracts';
import type { RunnerMessage } from '../src/runner/backend.ts';
import { runTurn } from '../src/chat/turn-runner.ts';

function collector() {
  const chat: ChatEvent[] = [];
  const deltas: Array<{ sdkUuid: string; event: ChatDeltaEvent }> = [];
  const dropped: string[] = [];
  return {
    chat,
    deltas,
    dropped,
    deps: {
      emitChat: (event: ChatEvent) => chat.push(event),
      emitDelta: (sdkUuid: string, event: ChatDeltaEvent) => deltas.push({ sdkUuid, event }),
      onDropped: (reason: string) => dropped.push(reason),
    },
  };
}

async function* stream(msgs: RunnerMessage[]): AsyncIterable<RunnerMessage> {
  for (const m of msgs) yield m;
}

function terminals(chat: ChatEvent[]): ChatEvent[] {
  return chat.filter((e) => e.kind === 'turn-end' || e.kind === 'turn-failed');
}

test('success turn maps blocks and ends in exactly one turn-end', async () => {
  const c = collector();
  const term = await runTurn(
    stream([
      { type: 'init', sdkSessionId: 's1', model: 'opus', permissionMode: 'default' },
      { type: 'assistant-block', sdkUuid: 'u1', parentToolUseId: null, block: { kind: 'text', text: 'hi' } },
      { type: 'assistant-block', sdkUuid: 'u1', parentToolUseId: null, block: { kind: 'tool_use', toolUseId: 't1', name: 'Read', input: {} } },
      { type: 'tool-result', sdkUuid: 'u2', parentToolUseId: null, toolUseId: 't1', result: 'ok', isError: false },
      { type: 'result', ok: true, subtype: 'success', stopReason: 'end_turn', usage: { inputTokens: 1, outputTokens: 2, cacheCreationTokens: 0, cacheReadTokens: 0, model: 'opus' }, durationMs: 5, error: null },
    ]),
    c.deps,
  );
  assert.equal(term, 'turn-end');
  assert.equal(terminals(c.chat).length, 1);
  assert.equal(terminals(c.chat)[0].kind, 'turn-end');
  assert.ok(c.chat.some((e) => e.kind === 'usage'));
  assert.ok(c.chat.some((e) => e.kind === 'turn-duration'));
  assert.ok(c.chat.some((e) => e.kind === 'tool-call'));
});

test('error result ends in exactly one turn-failed (api)', async () => {
  const c = collector();
  const term = await runTurn(
    stream([{ type: 'result', ok: false, subtype: 'error_max_turns', stopReason: null, usage: null, durationMs: null, error: 'boom' }]),
    c.deps,
  );
  assert.equal(term, 'turn-failed');
  const t = terminals(c.chat);
  assert.equal(t.length, 1);
  assert.deepEqual(t[0], { kind: 'turn-failed', error: 'boom', source: 'api' });
});

test('abort subtype maps to turn-failed source abort', async () => {
  const c = collector();
  await runTurn(
    stream([{ type: 'result', ok: false, subtype: 'aborted', stopReason: null, usage: null, durationMs: null, error: 'interrupted' }]),
    c.deps,
  );
  const t = terminals(c.chat);
  assert.equal(t.length, 1);
  assert.equal((t[0] as { source: string }).source, 'abort');
});

test('stream ending with no result still terminates (internal) — rule 3', async () => {
  const c = collector();
  const term = await runTurn(
    stream([{ type: 'assistant-block', sdkUuid: 'u1', parentToolUseId: null, block: { kind: 'text', text: 'orphan' } }]),
    c.deps,
  );
  assert.equal(term, 'turn-failed');
  const t = terminals(c.chat);
  assert.equal(t.length, 1);
  assert.equal((t[0] as { source: string }).source, 'internal');
});

test('subagent messages (parentToolUseId != null) are not forwarded', async () => {
  const c = collector();
  await runTurn(
    stream([
      { type: 'assistant-block', sdkUuid: 'x', parentToolUseId: 'parent', block: { kind: 'text', text: 'sub' } },
      { type: 'delta', sdkUuid: 'x', parentToolUseId: 'parent', delta: { kind: 'text-delta', text: 'sub' } },
      { type: 'result', ok: true, subtype: 'success', stopReason: 'end_turn', usage: null, durationMs: 0, error: null },
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
      { type: 'no-such-variant' } as unknown as RunnerMessage,
      { type: 'result', ok: true, subtype: 'success', stopReason: 'end_turn', usage: null, durationMs: 0, error: null },
    ]),
    c.deps,
  );
  assert.equal(term, 'turn-end');
  assert.ok(c.dropped.some((r) => r.includes('unknown')));
});

test('deltas ride the delta channel, not chat', async () => {
  const c = collector();
  await runTurn(
    stream([
      { type: 'delta', sdkUuid: 'u1', parentToolUseId: null, delta: { kind: 'message-start' } },
      { type: 'delta', sdkUuid: 'u1', parentToolUseId: null, delta: { kind: 'text-delta', text: 'yo' } },
      { type: 'result', ok: true, subtype: 'success', stopReason: 'end_turn', usage: null, durationMs: 0, error: null },
    ]),
    c.deps,
  );
  assert.equal(c.deltas.length, 2);
  assert.equal(c.chat.filter((e) => e.kind === 'assistant-text').length, 0);
});
