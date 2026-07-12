import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  isRuntimeCapabilities,
  isRuntimeModelDiscovery,
  isRuntimeSelection,
  isRuntimeSessionReceipt,
  runtimeSelectionsEqual,
  type RuntimeSelection,
} from '../src/index.ts';

const selection: RuntimeSelection = {
  runtimeId: 'claude-agent-sdk',
  accountId: 'personal',
  model: 'opus',
  effort: { kind: 'selected', value: 'high' },
};

test('runtime selection is exact and effort absence is explicit', () => {
  assert.equal(isRuntimeSelection(selection), true);
  assert.equal(isRuntimeSelection({ ...selection, effort: { kind: 'none' } }), true);
  assert.equal(isRuntimeSelection({ ...selection, effort: { kind: 'unavailable' } }), true);
  assert.equal(isRuntimeSelection({ ...selection, effort: null }), false);
  assert.equal(isRuntimeSelection({ ...selection, runtimeId: ' ' }), false);
  assert.equal(isRuntimeSelection({ ...selection, runtimeId: ' claude-agent-sdk ' }), false);
  assert.equal(isRuntimeSelection({ ...selection, accountId: ' personal ' }), false);
  assert.equal(isRuntimeSelection({ ...selection, model: ' opus ' }), false);
  assert.equal(isRuntimeSelection({
    ...selection,
    effort: { kind: 'selected', value: ' high ' },
  }), false);
  assert.equal(isRuntimeSelection({ ...selection, provider: 'claude' }), false);
  assert.equal(runtimeSelectionsEqual(selection, { ...selection }), true);
  assert.equal(runtimeSelectionsEqual(selection, { ...selection, model: 'sonnet' }), false);
});

test('capabilities and model discovery retain supported/unsupported/unavailable truth', () => {
  assert.equal(isRuntimeCapabilities({
    runtimeId: selection.runtimeId,
    accountId: selection.accountId,
    nativeContinuation: { status: 'supported' },
    modelDiscovery: { status: 'supported' },
    effortControl: { status: 'supported' },
  }), true);
  assert.equal(isRuntimeCapabilities({
    runtimeId: selection.runtimeId,
    accountId: selection.accountId,
    nativeContinuation: { status: 'unsupported', code: '' },
    modelDiscovery: { status: 'supported' },
    effortControl: { status: 'supported' },
  }), false);
  assert.equal(isRuntimeModelDiscovery({
    status: 'available',
    models: [{
      id: 'opus', resolvedId: 'claude-opus', label: 'Opus', description: '',
      effort: { status: 'supported', values: ['low', 'high'] },
    }],
  }), true);
  assert.equal(isRuntimeModelDiscovery({
    status: 'available',
    models: [{
      id: ' opus ', resolvedId: 'claude-opus', label: 'Opus', description: '',
      effort: { status: 'supported', values: ['low', 'high'] },
    }],
  }), false);
  assert.equal(isRuntimeModelDiscovery({
    status: 'available',
    models: [{
      id: 'opus', resolvedId: ' claude-opus ', label: 'Opus', description: '',
      effort: { status: 'supported', values: ['low', 'high'] },
    }],
  }), false);
  assert.equal(isRuntimeModelDiscovery({
    status: 'available',
    models: [{
      id: 'opus', resolvedId: 'claude-opus', label: 'Opus', description: '',
      effort: { status: 'supported', values: [' low ', 'high'] },
    }],
  }), false);
  assert.equal(isRuntimeModelDiscovery({
    status: 'available',
    models: [
      { id: 'opus', resolvedId: null, label: 'Opus', description: '', effort: { status: 'unsupported', code: 'no-effort' } },
      { id: 'opus', resolvedId: null, label: 'Duplicate', description: '', effort: { status: 'unsupported', code: 'no-effort' } },
    ],
  }), false);
  assert.equal(isRuntimeModelDiscovery({ status: 'unavailable', code: 'auth-unavailable' }), true);
});

test('session receipt is a positive exact create/resume observation', () => {
  assert.equal(isRuntimeSessionReceipt({
    mode: 'created', continuationAttemptId: 'attempt-create', selection,
    nativeSessionId: 'native-1', requestedNativeSessionId: null,
  }), true);
  assert.equal(isRuntimeSessionReceipt({
    mode: 'resumed', continuationAttemptId: 'attempt-resume', selection,
    nativeSessionId: 'native-1', requestedNativeSessionId: 'native-1',
  }), true);
  assert.equal(isRuntimeSessionReceipt({
    mode: 'resumed', continuationAttemptId: 'attempt-resume', selection,
    nativeSessionId: 'native-2', requestedNativeSessionId: 'native-1',
  }), false);
  assert.equal(isRuntimeSessionReceipt({
    mode: 'created', continuationAttemptId: 'attempt-create', selection,
    nativeSessionId: '', requestedNativeSessionId: null,
  }), false);
  assert.equal(isRuntimeSessionReceipt({
    mode: 'created', continuationAttemptId: 'attempt-create', selection,
    nativeSessionId: 'native-1', requestedNativeSessionId: null, raw: 'secret',
  }), false);
  assert.equal(isRuntimeSessionReceipt({
    mode: 'created', selection, nativeSessionId: 'native-1', requestedNativeSessionId: null,
  }), false, 'attempt identity is required');
  assert.equal(isRuntimeSessionReceipt({
    mode: 'created', continuationAttemptId: '', selection,
    nativeSessionId: 'native-1', requestedNativeSessionId: null,
  }), false);
  assert.equal(isRuntimeSessionReceipt({
    mode: 'created', continuationAttemptId: ' attempt-create ', selection,
    nativeSessionId: 'native-1', requestedNativeSessionId: null,
  }), false, 'attempt identity is exact and never normalized');
  assert.equal(isRuntimeSessionReceipt({
    mode: 'created', continuationAttemptId: 'attempt-create', selection,
    nativeSessionId: ' native-1 ', requestedNativeSessionId: null,
  }), false, 'native identity is exact and never normalized');
  assert.equal(isRuntimeSessionReceipt({
    mode: 'resumed', continuationAttemptId: 'attempt-resume', selection,
    nativeSessionId: 'native-1', requestedNativeSessionId: ' native-1 ',
  }), false, 'requested native identity is exact and never normalized');
});
