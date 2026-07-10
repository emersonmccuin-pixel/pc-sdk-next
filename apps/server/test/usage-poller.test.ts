// Usage poller guards: the OAuth response maps to the contract snapshot
// (0–100 → 0–1, ISO → epoch ms), expired tokens degrade without recording,
// unchanged polls skip the outbox, and boot hydrate restores last-known state.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { UsageCache } from '../src/usage/cache.ts';
import { mapOauthUsage, UsagePoller, type OauthUsageResponse } from '../src/usage/poller.ts';
import { freshDb } from './helpers.ts';

const RESPONSE: OauthUsageResponse = {
  five_hour: { utilization: 50.0, resets_at: '2026-07-10T23:00:00.000000+00:00' },
  seven_day: { utilization: 26.0, resets_at: '2026-07-15T06:00:00.000000+00:00' },
  limits: [
    { severity: 'normal', is_active: true },
    { severity: 'normal', is_active: false },
  ],
};

test('mapOauthUsage normalizes scale, timestamps, and status', () => {
  const snap = mapOauthUsage(RESPONSE, 'work', 123);
  assert.equal(snap.accountId, 'work');
  assert.equal(snap.fiveHour!.utilization, 0.5);
  assert.equal(snap.fiveHour!.resetsAt, Date.parse('2026-07-10T23:00:00.000000+00:00'));
  assert.equal(snap.sevenDay!.utilization, 0.26);
  assert.equal(snap.status, 'allowed');
  assert.equal(snap.updatedAt, 123);

  const warned = mapOauthUsage({ ...RESPONSE, limits: [{ severity: 'warning' }] }, 'work');
  assert.equal(warned.status, 'allowed_warning');

  const maxed = mapOauthUsage(
    { five_hour: { utilization: 100, resets_at: RESPONSE.five_hour!.resets_at }, seven_day: null },
    'work',
  );
  assert.equal(maxed.status, 'rejected');
  assert.equal(maxed.sevenDay, null);
});

test('poll records into the cache; unchanged polls skip the outbox', async () => {
  freshDb();
  const cache = new UsageCache();
  let fetches = 0;
  const poller = new UsagePoller({
    accounts: [{ id: 'work', configDir: 'X:/nowhere' }],
    cache,
    fetchImpl: (async () => {
      fetches++;
      return { ok: true, json: async () => RESPONSE } as Response;
    }) as typeof fetch,
    readCredentials: async () =>
      JSON.stringify({ claudeAiOauth: { accessToken: 'tok', expiresAt: Date.now() + 60_000 } }),
  });

  await poller.pollOnce();
  const first = cache.get('work');
  assert.ok(first, 'first poll recorded');
  assert.equal(first!.fiveHour!.utilization, 0.5);

  // Same quota state on the next poll → no new record (updatedAt unchanged).
  await poller.pollOnce();
  assert.equal(cache.get('work')!.updatedAt, first!.updatedAt, 'unchanged poll re-recorded');
  assert.equal(fetches, 2);
});

test('expired token degrades: nothing recorded, no throw', async () => {
  freshDb();
  const cache = new UsageCache();
  const poller = new UsagePoller({
    accounts: [{ id: 'personal', configDir: 'X:/nowhere' }],
    cache,
    fetchImpl: (async () => {
      throw new Error('fetch must not run with an expired token');
    }) as typeof fetch,
    readCredentials: async () =>
      JSON.stringify({ claudeAiOauth: { accessToken: 'tok', expiresAt: Date.now() - 1 } }),
  });
  await poller.pollOnce();
  assert.equal(cache.get('personal'), null);
});

test('hydrateFromDb restores the latest snapshot per account', () => {
  freshDb();
  const writer = new UsageCache();
  writer.record({ accountId: 'personal', fiveHour: { utilization: 0.1, resetsAt: 1 }, sevenDay: null, status: 'allowed', model: null, updatedAt: 1 });
  writer.record({ accountId: 'personal', fiveHour: { utilization: 0.2, resetsAt: 2 }, sevenDay: null, status: 'allowed', model: null, updatedAt: 2 });
  writer.record({ accountId: 'work', fiveHour: { utilization: 0.9, resetsAt: 3 }, sevenDay: null, status: 'allowed_warning', model: null, updatedAt: 3 });

  // A fresh cache (new boot) starts empty; hydrate restores last-known rows.
  const rebooted = new UsageCache();
  assert.equal(rebooted.get('personal'), null);
  const count = rebooted.hydrateFromDb();
  assert.equal(count, 2);
  assert.equal(rebooted.get('personal')!.fiveHour!.utilization, 0.2, 'latest row wins');
  assert.equal(rebooted.get('work')!.status, 'allowed_warning');
});
