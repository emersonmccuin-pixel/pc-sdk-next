import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  isContextCompactionCapability,
  isContextObservation,
  isContextObservationCapability,
  isRuntimeContextCapabilities,
} from '../src/index.ts';

test('context observations are exact, bounded, safe-integer snapshots', () => {
  assert.equal(isContextObservation({
    confidence: 'exact',
    usedTokens: 12_000,
    usableTokens: 180_000,
    contextWindowTokens: 200_000,
  }), true);
  assert.equal(isContextObservation({
    confidence: 'derived',
    usedTokens: 0,
    usableTokens: 180_000,
    contextWindowTokens: 200_000,
  }), true);
  assert.equal(isContextObservation({
    confidence: 'unavailable',
    reason: 'observation-timeout',
  }), true);

  for (const observation of [
    { confidence: 'exact', usedTokens: -1, usableTokens: 10, contextWindowTokens: 10 },
    { confidence: 'exact', usedTokens: 1.5, usableTokens: 10, contextWindowTokens: 10 },
    { confidence: 'exact', usedTokens: 11, usableTokens: 10, contextWindowTokens: 12 },
    { confidence: 'exact', usedTokens: 1, usableTokens: 13, contextWindowTokens: 12 },
    { confidence: 'exact', usedTokens: 1, usableTokens: 0, contextWindowTokens: 12 },
    { confidence: 'exact', usedTokens: 1, usableTokens: 10, contextWindowTokens: 10, percentage: 10 },
    { confidence: 'unavailable', reason: 'native-error' },
    { confidence: 'unavailable', reason: 'unsupported', usedTokens: 0 },
  ]) {
    assert.equal(isContextObservation(observation), false);
  }
});

test('context capability truth is explicit and closed', () => {
  const supported = {
    currentUse: { status: 'supported', confidences: ['exact', 'derived'] },
    compaction: { status: 'supported' },
  };
  assert.equal(isRuntimeContextCapabilities(supported), true);
  assert.equal(isContextObservationCapability({
    status: 'supported', confidences: ['approximate'],
  }), true);
  assert.equal(isContextObservationCapability({
    status: 'supported', confidences: [],
  }), false);
  assert.equal(isContextObservationCapability({
    status: 'supported', confidences: ['exact', 'exact'],
  }), false);
  assert.equal(isContextObservationCapability({
    status: 'unsupported', code: 'not-available', confidences: [],
  }), false);
  assert.equal(isContextCompactionCapability({
    status: 'unavailable', code: 'account-unavailable',
  }), true);
  assert.equal(isContextCompactionCapability({
    status: 'unavailable', code: ' account-unavailable ',
  }), false);
  assert.equal(isRuntimeContextCapabilities({ ...supported, native: 'SECRET' }), false);
});
