// SDK message → RuntimeEvent key-correlation guard. Envelope uuids are minted
// per emission (fresh per stream_event); the mapping must key deltas and final
// assistant blocks by the INNER Anthropic message id, or the web reducer opens
// one bubble per chunk (the phase-2 streaming bug this test pins).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { SDKMessage } from '@anthropic-ai/claude-agent-sdk';
import { createSdkKeyContext, mapSdkMessage } from '../src/runner/claude-adapter.ts';

const ACCOUNT = 'personal';

function sdk(msg: Record<string, unknown>): SDKMessage {
  return msg as unknown as SDKMessage;
}

function streamEvent(envelopeUuid: string, event: Record<string, unknown>): SDKMessage {
  return sdk({ type: 'stream_event', uuid: envelopeUuid, parent_tool_use_id: null, event });
}

test('deltas and final assistant blocks share the inner message id', () => {
  const keys = createSdkKeyContext();

  // message_start opens msg_A; every subsequent chunk has a DIFFERENT envelope uuid.
  const start = mapSdkMessage(
    streamEvent('env-1', { type: 'message_start', message: { id: 'msg_A' } }),
    ACCOUNT,
    keys,
  );
  const chunk1 = mapSdkMessage(
    streamEvent('env-2', { type: 'content_block_delta', delta: { type: 'text_delta', text: 'hel' } }),
    ACCOUNT,
    keys,
  );
  const chunk2 = mapSdkMessage(
    streamEvent('env-3', { type: 'content_block_delta', delta: { type: 'text_delta', text: 'lo' } }),
    ACCOUNT,
    keys,
  );
  const stop = mapSdkMessage(streamEvent('env-4', { type: 'message_stop' }), ACCOUNT, keys);

  for (const [label, out] of [
    ['message_start', start],
    ['chunk1', chunk1],
    ['chunk2', chunk2],
    ['message_stop', stop],
  ] as const) {
    assert.equal(out.length, 1, `${label} mapped to one delta`);
    const rm = out[0]!;
    assert.equal(rm.type, 'delta');
    assert.equal((rm as { sdkUuid: string }).sdkUuid, 'msg_A', `${label} keyed by inner message id`);
  }

  // The final assistant message (yet another envelope uuid, same message.id)
  // must land under the SAME key so the reducer discards the buffer.
  const final = mapSdkMessage(
    sdk({
      type: 'assistant',
      uuid: 'env-5',
      parent_tool_use_id: null,
      message: { id: 'msg_A', content: [{ type: 'text', text: 'hello' }] },
    }),
    ACCOUNT,
    keys,
  );
  assert.equal(final.length, 1);
  assert.equal(final[0]!.type, 'assistant-block');
  assert.equal((final[0] as { sdkUuid: string }).sdkUuid, 'msg_A');
});

test('the next streamed message opens a fresh key', () => {
  const keys = createSdkKeyContext();
  mapSdkMessage(streamEvent('env-1', { type: 'message_start', message: { id: 'msg_A' } }), ACCOUNT, keys);
  mapSdkMessage(streamEvent('env-2', { type: 'message_stop' }), ACCOUNT, keys);
  mapSdkMessage(streamEvent('env-3', { type: 'message_start', message: { id: 'msg_B' } }), ACCOUNT, keys);
  const chunk = mapSdkMessage(
    streamEvent('env-4', { type: 'content_block_delta', delta: { type: 'text_delta', text: 'x' } }),
    ACCOUNT,
    keys,
  );
  assert.equal((chunk[0] as { sdkUuid: string }).sdkUuid, 'msg_B');
});

test('supersedes lists are translated from envelope uuids to frame keys', () => {
  const keys = createSdkKeyContext();
  // An assistant message stamped msg_A arrived under envelope env-5…
  mapSdkMessage(
    sdk({
      type: 'assistant',
      uuid: 'env-5',
      parent_tool_use_id: null,
      message: { id: 'msg_A', content: [{ type: 'text', text: 'oops' }] },
    }),
    ACCOUNT,
    keys,
  );
  // …then a refusal retracts by ENVELOPE uuid — the retract must carry msg_A.
  const out = mapSdkMessage(
    sdk({
      type: 'system',
      subtype: 'model_refusal_fallback',
      content: 'refused',
      retracted_message_uuids: ['env-5'],
    }),
    ACCOUNT,
    keys,
  );
  const supersedes = out.find((rm) => rm.type === 'supersedes');
  assert.ok(supersedes, 'refusal emitted a supersedes message');
  assert.deepEqual((supersedes as { uuids: string[] }).uuids, ['msg_A']);
});

test('id-less messages fall back to the envelope uuid (never an empty key)', () => {
  const keys = createSdkKeyContext();
  const out = mapSdkMessage(
    streamEvent('env-9', { type: 'content_block_delta', delta: { type: 'text_delta', text: 'x' } }),
    ACCOUNT,
    keys,
  );
  assert.equal((out[0] as { sdkUuid: string }).sdkUuid, 'env-9');
});
