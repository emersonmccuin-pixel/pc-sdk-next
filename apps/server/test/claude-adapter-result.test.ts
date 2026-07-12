// mapResult (via mapSdkMessage) — provider-neutral outcome/numTurns
// classification. This is the ONLY place a Claude subtype (error_max_turns,
// error_max_budget_usd, ...) is interpreted; downstream (turn-runner, dispatch
// service) must never see the raw subtype, only `outcome`.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createSdkKeyContext, mapSdkMessage } from '../src/runner/claude-adapter.ts';
import type { RuntimeEvent } from '../src/runner/runtime.ts';

function resultMsg(fields: Record<string, unknown>): unknown {
  return { type: 'result', uuid: 'u1', session_id: 's1', ...fields };
}

function mapResult(fields: Record<string, unknown>): RuntimeEvent {
  const out = mapSdkMessage(resultMsg(fields) as never, 'acct-1', createSdkKeyContext());
  assert.equal(out.length, 1);
  return out[0];
}

test('native success and stop reason become canonical terminal fields', () => {
  const rm = mapResult({ subtype: 'success', stop_reason: 'end_turn', num_turns: 7 }) as {
    ok: boolean;
    outcome: string;
    stopReason: string | null;
    numTurns: number | null;
    subtype?: unknown;
  };
  assert.equal(rm.ok, true);
  assert.equal(rm.outcome, 'ok');
  assert.equal(rm.stopReason, 'complete');
  assert.equal(rm.numTurns, 7);
  assert.equal('subtype' in rm, false);
});

test('subtype error_max_turns -> outcome budget-exhausted, not a crash', () => {
  const rm = mapResult({ subtype: 'error_max_turns', num_turns: 100, errors: ['hit max turns'] }) as {
    ok: boolean;
    outcome: string;
    numTurns: number | null;
  };
  assert.equal(rm.ok, false);
  assert.equal(rm.outcome, 'budget-exhausted');
  assert.equal(rm.numTurns, 100);
});

test('subtype error_max_budget_usd -> outcome budget-exhausted', () => {
  const rm = mapResult({ subtype: 'error_max_budget_usd', num_turns: 42 }) as { outcome: string; numTurns: number | null };
  assert.equal(rm.outcome, 'budget-exhausted');
  assert.equal(rm.numTurns, 42);
});

test('subtype error_during_execution -> outcome error', () => {
  const rm = mapResult({
    subtype: 'error_during_execution', num_turns: 3, errors: ['SECRET technical failure'],
  }) as { outcome: string; numTurns: number | null; error: string | null };
  assert.equal(rm.outcome, 'error');
  assert.equal(rm.numTurns, 3);
  assert.equal(rm.error, 'runtime execution failed');
  assert.equal(JSON.stringify(rm).includes('SECRET'), false);
});

test('only documented native terminal reasons map to outcome aborted', () => {
  for (const terminal_reason of ['aborted_streaming', 'aborted_tools']) {
    const rm = mapResult({ subtype: 'error_during_execution', terminal_reason }) as {
      ok: boolean;
      outcome: string;
    };
    assert.equal(rm.ok, false);
    assert.equal(rm.outcome, 'aborted');
  }
  const inventedSubtype = mapResult({ subtype: 'aborted' }) as { outcome: string };
  assert.equal(inventedSubtype.outcome, 'error');
  const abortText = mapResult({
    subtype: 'error_during_execution',
    errors: ['AbortError: transport aborted independently'],
  }) as { outcome: string };
  assert.equal(abortText.outcome, 'error');
});

test('missing num_turns -> numTurns null', () => {
  const rm = mapResult({ subtype: 'success' }) as { numTurns: number | null };
  assert.equal(rm.numTurns, null);
});

test('result usage accepts only complete non-negative integer evidence', () => {
  const valid = {
    input_tokens: 10,
    output_tokens: 3,
    cache_creation_input_tokens: 2,
    cache_read_input_tokens: 5,
  };
  const observed = mapResult({
    subtype: 'success', usage: valid, modelUsage: { opus: {} },
  }) as Extract<RuntimeEvent, { type: 'result' }>;
  assert.deepEqual(observed.usage, {
    inputTokens: 10,
    outputTokens: 3,
    cacheCreationTokens: 2,
    cacheReadTokens: 5,
    model: 'opus',
  });

  for (const usage of [
    { ...valid, input_tokens: undefined },
    { ...valid, output_tokens: -1 },
    { ...valid, cache_creation_input_tokens: 1.5 },
    { ...valid, cache_read_input_tokens: Number.POSITIVE_INFINITY },
  ]) {
    const result = mapResult({ subtype: 'success', usage, modelUsage: { opus: {} } }) as
      Extract<RuntimeEvent, { type: 'result' }>;
    assert.equal(result.usage, null);
  }
});

test('result usage never assigns multi-model totals to an arbitrary first key', () => {
  const usage = {
    input_tokens: 10,
    output_tokens: 3,
    cache_creation_input_tokens: 2,
    cache_read_input_tokens: 5,
  };
  for (const [modelUsage, expected] of [
    [{}, null],
    [{ opus: {}, sonnet: {} }, null],
    [{ ' opus ': {} }, null],
    [{ opus: {} }, 'opus'],
    ['malformed', null],
    [42, null],
    [[], null],
  ] as const) {
    const result = mapResult({ subtype: 'success', usage, modelUsage }) as
      Extract<RuntimeEvent, { type: 'result' }>;
    assert.equal(result.usage?.model, expected);
  }
});

test('missing or malformed success discriminator fails closed', () => {
  for (const subtype of [undefined, null, 42]) {
    const rm = mapResult({ subtype }) as { ok: boolean; outcome: string; error: string | null };
    assert.equal(rm.ok, false);
    assert.equal(rm.outcome, 'error');
    assert.equal(rm.error, 'runtime execution failed');
  }
});
