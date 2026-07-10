// Usage cache guards: partial per-window snapshots merge per account, a
// 'rejected' status rides through loudly, and each record emits a durable
// `usage` resource event (survives reconnect — not a lucky broadcast).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { getLatestLiveEventForEntity } from '@pc/db';
import type { UsageSnapshot } from '@pc/contracts';
import { UsageCache } from '../src/usage/cache.ts';
import { freshDb } from './helpers.ts';

test('record merges windows per account and preserves the untouched window', () => {
  freshDb();
  const cache = new UsageCache();

  cache.record({
    accountId: 'personal',
    fiveHour: { utilization: 42, resetsAt: 1000 },
    sevenDay: null,
    status: 'allowed',
    model: 'opus',
    updatedAt: 1,
  });
  // A later event carrying only the 7-day window must NOT wipe the 5-hour one.
  const merged = cache.record({
    accountId: 'personal',
    fiveHour: null,
    sevenDay: { utilization: 10, resetsAt: 2000 },
    status: 'allowed_warning',
    model: null,
    updatedAt: 2,
  });

  assert.deepEqual(merged.fiveHour, { utilization: 42, resetsAt: 1000 });
  assert.deepEqual(merged.sevenDay, { utilization: 10, resetsAt: 2000 });
  assert.equal(merged.status, 'allowed_warning');
  assert.equal(merged.model, 'opus'); // carried forward
});

test('accounts are isolated', () => {
  freshDb();
  const cache = new UsageCache();
  cache.record({ accountId: 'personal', fiveHour: { utilization: 1, resetsAt: null }, sevenDay: null, status: 'allowed', model: null, updatedAt: 1 });
  cache.record({ accountId: 'work', fiveHour: { utilization: 99, resetsAt: null }, sevenDay: null, status: 'rejected', model: null, updatedAt: 1 });
  assert.equal(cache.get('personal')!.fiveHour!.utilization, 1);
  assert.equal(cache.get('work')!.status, 'rejected');
  assert.equal(cache.list().length, 2);
});

test('record emits a durable usage resource event', () => {
  freshDb();
  const cache = new UsageCache();
  const snap: UsageSnapshot = {
    accountId: 'work',
    fiveHour: { utilization: 88, resetsAt: 5000 },
    sevenDay: null,
    status: 'rejected',
    model: 'opus',
    updatedAt: 7,
  };
  cache.record(snap);

  const row = getLatestLiveEventForEntity<UsageSnapshot>('usage');
  assert.ok(row, 'expected a usage live_outbox row');
  assert.equal(row!.entity, 'usage');
  assert.equal(row!.scope, 'global');
  assert.equal(row!.entityId, 'work'); // per-account dedup key
  assert.equal(row!.payload.status, 'rejected');
  assert.equal(row!.payload.fiveHour!.utilization, 88);
});
