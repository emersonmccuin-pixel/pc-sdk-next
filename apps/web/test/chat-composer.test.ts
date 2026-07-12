import { test } from 'node:test';
import assert from 'node:assert/strict';

import { canRemoveQueueItem, canSubmitDraft } from '../src/features/chat/ChatComposer.tsx';

test('composer submit guard rejects blank and rapid duplicate submissions', () => {
  assert.equal(canSubmitDraft('', false), false);
  assert.equal(canSubmitDraft('   ', false), false);
  assert.equal(canSubmitDraft('queue this', false), true);
  assert.equal(canSubmitDraft('queue this', true), false);
});

test('failed linked user replacements remain explicitly removable', () => {
  assert.equal(canRemoveQueueItem({
    origin: 'user', status: 'failed', interruptRequestId: 'interrupt-1',
  }), true);
  assert.equal(canRemoveQueueItem({
    origin: 'user', status: 'queued', interruptRequestId: 'interrupt-1',
  }), false);
  assert.equal(canRemoveQueueItem({
    origin: 'agent-envelope', status: 'failed', interruptRequestId: null,
  }), false);
});
