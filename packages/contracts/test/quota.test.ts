import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  isSubscriptionQuotaCapability,
  isSubscriptionQuotaListResponse,
  isSubscriptionQuotaObservation,
  isSubscriptionQuotaObservationBatch,
  isSubscriptionQuotaSnapshot,
  isSubscriptionQuotaSourceObservation,
  subscriptionQuotaKey,
  subscriptionQuotaStaleAt,
  type SubscriptionQuotaObservation,
  type SubscriptionQuotaSnapshot,
  type SubscriptionQuotaSourceObservation,
} from '../src/index.ts';

const SNAPSHOT_ID = '01KXAV00000000000000000001';

const USED_SOURCE: SubscriptionQuotaSourceObservation = {
  window: { id: 'five-hour', label: '5 hours', durationMs: 5 * 60 * 60_000 },
  scope: { kind: 'account' },
  source: { semantics: 'used', fraction: 0.4 },
  confidence: 'exact',
  limitState: 'allowed',
  resetsAt: 2_000,
};

const USED_OBSERVATION: SubscriptionQuotaObservation = {
  ...USED_SOURCE,
  usedFraction: 0.4,
  observedAt: 1_000,
  staleAt: 2_000,
};

const REMAINING_OBSERVATION: SubscriptionQuotaObservation = {
  window: { id: 'weekly', label: '7 days', durationMs: 7 * 24 * 60 * 60_000 },
  scope: { kind: 'model', model: 'model-a' },
  source: { semantics: 'remaining', fraction: 0.25 },
  usedFraction: 0.75,
  confidence: 'derived',
  limitState: 'warning',
  resetsAt: 3_000,
  observedAt: 1_000,
  staleAt: 3_000,
};

const SNAPSHOT: SubscriptionQuotaSnapshot = {
  id: SNAPSHOT_ID,
  runtimeId: 'runtime-a',
  accountId: 'personal',
  revision: 3,
  availability: 'available',
  unavailableReason: null,
  observedAt: 1_000,
  observations: [USED_OBSERVATION, REMAINING_OBSERVATION],
};

test('source observation and batch guards are exact and coverage-aware', () => {
  assert.equal(isSubscriptionQuotaSourceObservation(USED_SOURCE), true);
  assert.equal(isSubscriptionQuotaSourceObservation({
    ...USED_SOURCE,
    source: { ...USED_SOURCE.source, nativeUnit: 'percent' },
  }), false);
  assert.equal(isSubscriptionQuotaSourceObservation({
    ...USED_SOURCE,
    window: { ...USED_SOURCE.window, providerKey: 'five_hour' },
  }), false);
  assert.equal(isSubscriptionQuotaSourceObservation({
    ...USED_SOURCE,
    scope: { kind: 'account', model: 'must-not-cross' },
  }), false);
  assert.equal(isSubscriptionQuotaSourceObservation({ ...USED_SOURCE, confidence: 'derived' }), false);

  const partial = {
    runtimeId: 'runtime-a',
    accountId: 'personal',
    availability: 'available',
    coverage: 'partial',
    observedAt: 1_000,
    observations: [USED_SOURCE],
  };
  assert.equal(isSubscriptionQuotaObservationBatch(partial), true);
  assert.equal(isSubscriptionQuotaObservationBatch({ ...partial, observations: [] }), false);
  assert.equal(isSubscriptionQuotaObservationBatch({
    ...partial,
    coverage: 'complete',
    observations: [],
  }), true, 'complete coverage may positively remove every prior bucket');
  assert.equal(isSubscriptionQuotaObservationBatch({
    ...partial,
    observations: [USED_SOURCE, { ...USED_SOURCE }],
  }), false, 'window ids are unique within a batch');
  assert.equal(isSubscriptionQuotaObservationBatch({
    ...partial,
    observations: Array.from({ length: 65 }, (_, index) => ({
      ...USED_SOURCE,
      window: { ...USED_SOURCE.window, id: `window-${index}` },
    })),
  }), false, 'quota batches are globally bounded');
  assert.equal(isSubscriptionQuotaObservationBatch({ ...partial, observedAt: 1.5 }), false);
  assert.equal(isSubscriptionQuotaObservationBatch({ ...partial, nativePayload: {} }), false);

  const unavailable = {
    runtimeId: 'runtime-a',
    accountId: 'personal',
    availability: 'unavailable',
    reason: 'runtime-unavailable',
    observedAt: 1_000,
  };
  assert.equal(isSubscriptionQuotaObservationBatch(unavailable), true);
  assert.equal(isSubscriptionQuotaObservationBatch({ ...unavailable, observations: [] }), false);
  assert.equal(isSubscriptionQuotaObservationBatch({ ...unavailable, reason: 'network-error' }), false);
  assert.equal(isSubscriptionQuotaObservationBatch({ ...unavailable, runtimeId: ' runtime-a ' }), false);
  assert.equal(isSubscriptionQuotaObservationBatch({ ...unavailable, accountId: '' }), false);
  assert.equal(isSubscriptionQuotaObservationBatch({ ...unavailable, runtimeId: 'runtime-😀' }), false);
  assert.equal(isSubscriptionQuotaObservationBatch({ ...unavailable, accountId: '\tpersonal' }), false);
  assert.equal(isSubscriptionQuotaObservationBatch({ ...unavailable, runtimeId: 'r'.repeat(201) }), false);
  assert.equal(isSubscriptionQuotaObservationBatch({
    ...unavailable, observedAt: Number.MAX_SAFE_INTEGER,
  }), true, 'wire/durable guards stay structural; the receipt boundary rejects future evidence');
});

test('used and remaining observations preserve source semantics and exact algebra', () => {
  assert.equal(isSubscriptionQuotaObservation(USED_OBSERVATION), true);
  assert.equal(isSubscriptionQuotaObservation(REMAINING_OBSERVATION), true);
  assert.equal(isSubscriptionQuotaObservation({
    ...USED_OBSERVATION,
    usedFraction: 0.6,
  }), false, 'used source must project the same used fraction');
  assert.equal(isSubscriptionQuotaObservation({
    ...USED_OBSERVATION,
    usedFraction: USED_OBSERVATION.usedFraction + Number.EPSILON,
  }), false, 'even a tiny contradictory normalized fraction is rejected');
  assert.equal(isSubscriptionQuotaObservation({
    ...REMAINING_OBSERVATION,
    usedFraction: 0.25,
  }), false, '25% remaining means 75% used');
  assert.equal(isSubscriptionQuotaObservation({
    ...REMAINING_OBSERVATION,
    confidence: 'exact',
  }), false, 'remaining-to-used normalization is derived, never exact');
  assert.equal(isSubscriptionQuotaObservation({
    ...USED_OBSERVATION,
    confidence: 'derived',
  }), false, 'a used-source fraction is not derived');
  assert.equal(isSubscriptionQuotaObservation({
    ...REMAINING_OBSERVATION,
    confidence: 'approximate',
  }), true);
});

test('fraction, timestamp, reset, and nested-shape guards fail closed', () => {
  for (const invalid of [Number.NaN, Number.POSITIVE_INFINITY, -0.01, 1.01]) {
    assert.equal(isSubscriptionQuotaSourceObservation({
      ...USED_SOURCE,
      source: { ...USED_SOURCE.source, fraction: invalid },
    }), false, `source fraction ${String(invalid)} is invalid`);
    assert.equal(isSubscriptionQuotaObservation({
      ...USED_OBSERVATION,
      usedFraction: invalid,
    }), false, `used fraction ${String(invalid)} is invalid`);
  }
  for (const invalid of [-1, 1.5, Number.NaN, Number.MAX_SAFE_INTEGER + 1]) {
    assert.equal(isSubscriptionQuotaObservation({
      ...USED_OBSERVATION,
      observedAt: invalid,
    }), false, `observation timestamp ${String(invalid)} is invalid`);
  }
  assert.equal(isSubscriptionQuotaObservation({
    ...USED_OBSERVATION,
    staleAt: USED_OBSERVATION.observedAt - 1,
  }), false);
  assert.equal(isSubscriptionQuotaObservation({
    ...USED_OBSERVATION,
    resetsAt: null,
    staleAt: Number.MAX_SAFE_INTEGER,
  }), false, 'freshness is exactly app-authored, never an arbitrary upper bound');
  assert.equal(subscriptionQuotaStaleAt(1_000, null), 601_000);
  assert.equal(subscriptionQuotaStaleAt(1_000, 2_000), 2_000);
  assert.equal(isSubscriptionQuotaObservation({
    ...USED_OBSERVATION,
    resetsAt: 1_250,
    staleAt: 1_251,
  }), false, 'freshness cannot survive a known reset');
  assert.equal(isSubscriptionQuotaObservation({
    ...USED_OBSERVATION,
    resetsAt: 999,
    staleAt: 1_000,
  }), true, 'an already-passed reset is represented as immediately stale');
  assert.equal(isSubscriptionQuotaObservation({
    ...USED_OBSERVATION,
    resetsAt: 999,
    staleAt: 1_001,
  }), false, 'a passed reset cannot retain a fresh interval');
  assert.equal(isSubscriptionQuotaObservation({
    ...USED_OBSERVATION,
    source: { ...USED_OBSERVATION.source, raw: 'provider-secret' },
  }), false);
  assert.equal(isSubscriptionQuotaObservation({ ...USED_OBSERVATION, raw: {} }), false);
});

test('snapshot guard binds availability, revision, observation order, and unique windows', () => {
  assert.equal(isSubscriptionQuotaSnapshot(SNAPSHOT), true);
  assert.equal(isSubscriptionQuotaSnapshot({
    accountId: 'personal',
    fiveHour: { utilization: 0.4, resetsAt: 2_000 },
    sevenDay: null,
    fable: null,
    status: 'allowed',
    model: null,
    updatedAt: 1_000,
  }), false, 'the retired Claude-shaped UsageSnapshot is not a quota snapshot');
  assert.equal(isSubscriptionQuotaSnapshot({ ...SNAPSHOT, revision: 0 }), false);
  assert.equal(isSubscriptionQuotaSnapshot({ ...SNAPSHOT, revision: 1.5 }), false);
  assert.equal(isSubscriptionQuotaSnapshot({ ...SNAPSHOT, id: ' padded ' }), false);
  assert.equal(isSubscriptionQuotaSnapshot({ ...SNAPSHOT, id: '01kxav00000000000000000001' }), false);
  assert.equal(isSubscriptionQuotaSnapshot({ ...SNAPSHOT, id: `8${'0'.repeat(25)}` }), false);
  assert.equal(isSubscriptionQuotaSnapshot({ ...SNAPSHOT, id: 'Z'.repeat(26) }), false);
  assert.equal(isSubscriptionQuotaSnapshot({ ...SNAPSHOT, unavailableReason: 'runtime-unavailable' }), false);
  assert.equal(isSubscriptionQuotaSnapshot({
    ...SNAPSHOT,
    availability: 'unavailable',
    unavailableReason: 'runtime-unavailable',
  }), true, 'unavailable truth may retain last-known per-window observations');
  assert.equal(isSubscriptionQuotaSnapshot({
    ...SNAPSHOT,
    availability: 'unavailable',
    unavailableReason: null,
  }), false);
  assert.equal(isSubscriptionQuotaSnapshot({
    ...SNAPSHOT,
    observedAt: 999,
  }), false, 'snapshot time cannot predate a retained observation');
  assert.equal(isSubscriptionQuotaSnapshot({
    ...SNAPSHOT,
    observations: [USED_OBSERVATION, { ...USED_OBSERVATION }],
  }), false);
  assert.equal(isSubscriptionQuotaSnapshot({ ...SNAPSHOT, nativePayload: {} }), false);
  assert.equal(isSubscriptionQuotaSnapshot({
    ...SNAPSHOT,
    observations: Array.from({ length: 65 }, (_, index) => ({
      ...USED_OBSERVATION,
      window: { ...USED_OBSERVATION.window, id: `window-${index}` },
    })),
  }), false);
  assert.equal(isSubscriptionQuotaSnapshot({
    ...SNAPSHOT,
    observedAt: Number.MAX_SAFE_INTEGER,
    observations: [],
  }), true, 'replay validation does not depend on the reader clock');
});

test('list response is exact and rejects duplicate snapshot identity', () => {
  assert.equal(isSubscriptionQuotaListResponse({ ok: true, snapshots: [SNAPSHOT] }), true);
  assert.equal(isSubscriptionQuotaListResponse({ ok: true, snapshots: [], extra: true }), false);
  assert.equal(isSubscriptionQuotaListResponse({ ok: false, snapshots: [SNAPSHOT] }), false);
  assert.equal(isSubscriptionQuotaListResponse({
    ok: true,
    snapshots: [SNAPSHOT, { ...SNAPSHOT, id: '01KXAV00000000000000000002', revision: 4 }],
  }), false, 'one runtime/account has exactly one snapshot');
  assert.equal(isSubscriptionQuotaListResponse({
    ok: true,
    snapshots: [SNAPSHOT, { ...SNAPSHOT, accountId: 'work' }],
  }), false, 'snapshot ids are globally unique');
  assert.equal(isSubscriptionQuotaListResponse({
    ok: true,
    snapshots: [{ ...SNAPSHOT, revision: 0 }],
  }), false);

  assert.notEqual(
    subscriptionQuotaKey('runtime|a', 'account'),
    subscriptionQuotaKey('runtime', 'a|account'),
    'encoded components cannot collide across the separator',
  );
  assert.doesNotThrow(() => subscriptionQuotaKey('\ud800', 'account'));
});

test('subscription-quota capability is closed, non-empty, and duplicate-free', () => {
  const supported = {
    status: 'supported',
    sourceSemantics: ['used', 'remaining'],
    confidences: ['exact', 'approximate'],
  };
  assert.equal(isSubscriptionQuotaCapability(supported), true);
  assert.equal(isSubscriptionQuotaCapability({ ...supported, sourceSemantics: [] }), false);
  assert.equal(isSubscriptionQuotaCapability({ ...supported, sourceSemantics: ['used', 'used'] }), false);
  assert.equal(isSubscriptionQuotaCapability({ ...supported, sourceSemantics: ['consumed'] }), false);
  assert.equal(isSubscriptionQuotaCapability({ ...supported, confidences: [] }), false);
  assert.equal(isSubscriptionQuotaCapability({ ...supported, confidences: ['exact', 'exact'] }), false);
  assert.equal(isSubscriptionQuotaCapability({ ...supported, confidences: ['derived'] }), false);
  assert.equal(isSubscriptionQuotaCapability({ ...supported, provider: 'native' }), false);
  assert.equal(isSubscriptionQuotaCapability({ status: 'unsupported', code: 'not-exposed' }), true);
  assert.equal(isSubscriptionQuotaCapability({ status: 'unavailable', code: 'account-offline' }), true);
  assert.equal(isSubscriptionQuotaCapability({ status: 'unsupported', code: '' }), false);
  assert.equal(isSubscriptionQuotaCapability({ status: 'unsupported', code: ' padded ' }), false);
  assert.equal(isSubscriptionQuotaCapability({ status: 'supported', code: 'contradictory' }), false);
});
