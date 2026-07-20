// Subscription-quota scheduler guards: exact runtime/account attribution,
// explicit unavailable evidence, bounded native observations, and durable
// refreshes all remain provider-neutral.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { SubscriptionQuotaService } from '@pc/app-services';
import type { SubscriptionQuotaObservationBatch } from '@pc/contracts';
import { listLiveOutboxRowsAfter } from '@pc/db';
import { SubscriptionQuotaPoller } from '../src/subscription-quota/poller.ts';
import {
  RuntimeRegistry,
  type AgentRuntimeAdapter,
} from '../src/runner/runtime.ts';
import { freshDb } from './helpers.ts';

type ObserveQuota = AgentRuntimeAdapter['observeSubscriptionQuota'];

function availableBatch(
  runtimeId: string,
  accountId: string,
  observedAt: number,
  fraction = 0.25,
): SubscriptionQuotaObservationBatch {
  return {
    runtimeId,
    accountId,
    availability: 'available',
    coverage: 'complete',
    observedAt,
    observations: [{
      window: { id: 'five-hour', label: '5h', durationMs: 18_000_000 },
      scope: { kind: 'account' },
      source: { semantics: 'used', fraction },
      confidence: 'exact',
      limitState: 'allowed',
      resetsAt: null,
    }],
  };
}

function adapter(runtimeId: string, observe: ObserveQuota): AgentRuntimeAdapter {
  return {
    id: runtimeId,
    appToolBridge: 'supported',
    capabilities: async (accountId) => ({
      runtimeId,
      accountId,
      nativeContinuation: { status: 'supported' },
      modelDiscovery: { status: 'supported' },
      effortControl: { status: 'supported' },
      context: {
        currentUse: { status: 'unsupported', code: 'test-only' },
        compaction: { status: 'unsupported', code: 'test-only' },
      },
      subscriptionQuota: {
        status: 'supported',
        sourceSemantics: ['used'],
        confidences: ['exact'],
      },
    }),
    listModels: async () => ({ status: 'unsupported', code: 'test-only' }),
    observeSubscriptionQuota: observe,
    createSession: async () => {
      throw new Error('not used by subscription-quota scheduler tests');
    },
    resumeSession: async () => {
      throw new Error('not used by subscription-quota scheduler tests');
    },
  };
}

test('polls each account through its exact runtime and isolates peer-runtime account ids', async () => {
  freshDb();
  const service = new SubscriptionQuotaService();
  const runtimes = new RuntimeRegistry();
  const calls: string[] = [];
  runtimes.register(adapter('runtime-a', async (accountId) => {
    calls.push(`runtime-a:${accountId}`);
    return availableBatch('runtime-a', accountId, 1_000, 0.2);
  }));
  runtimes.register(adapter('runtime-b', async (accountId) => {
    calls.push(`runtime-b:${accountId}`);
    return availableBatch('runtime-b', accountId, 1_001, 0.7);
  }));

  const poller = new SubscriptionQuotaPoller({
    accounts: [
      { id: 'personal', runtimeId: 'runtime-a', configDir: 'C:/quota/runtime-a' },
      { id: 'personal', runtimeId: 'runtime-b', configDir: 'C:/quota/runtime-b' },
    ],
    runtimes,
    service,
  });
  await poller.pollOnce();

  assert.deepEqual(calls.sort(), ['runtime-a:personal', 'runtime-b:personal']);
  const snapshots = service.list();
  assert.equal(snapshots.length, 2);
  const runtimeA = service.get('runtime-a', 'personal');
  const runtimeB = service.get('runtime-b', 'personal');
  assert.ok(runtimeA);
  assert.ok(runtimeB);
  assert.notEqual(runtimeA.id, runtimeB.id);
  assert.equal(runtimeA.observations[0]?.usedFraction, 0.2);
  assert.equal(runtimeB.observations[0]?.usedFraction, 0.7);
});

test('an unknown runtime records unavailable without calling a registered provider', async () => {
  freshDb();
  const service = new SubscriptionQuotaService();
  const runtimes = new RuntimeRegistry();
  let providerCalls = 0;
  runtimes.register(adapter('known-runtime', async (accountId) => {
    providerCalls += 1;
    return availableBatch('known-runtime', accountId, 2_000);
  }));

  const poller = new SubscriptionQuotaPoller({
    accounts: [{
      id: 'personal',
      runtimeId: 'missing-runtime',
      configDir: 'C:/quota/missing',
    }],
    runtimes,
    service,
    now: () => 2_000,
  });
  await poller.pollOnce();

  assert.equal(providerCalls, 0);
  const snapshot = service.get('missing-runtime', 'personal');
  assert.ok(snapshot);
  assert.equal(snapshot.availability, 'unavailable');
  assert.equal(snapshot.unavailableReason, 'runtime-unavailable');
  assert.equal(snapshot.observedAt, 2_000);
});

test('invalid and mismatched adapter results become explicit unavailable truth', async () => {
  freshDb();
  const service = new SubscriptionQuotaService();
  const runtimes = new RuntimeRegistry();
  runtimes.register(adapter('runtime-invalid', async (accountId) => {
    if (accountId === 'malformed') {
      return {
        ...availableBatch('runtime-invalid', accountId, 3_000),
        providerNativeField: true,
      } as unknown as SubscriptionQuotaObservationBatch;
    }
    return availableBatch('another-runtime', 'another-account', 3_000);
  }));

  const poller = new SubscriptionQuotaPoller({
    accounts: [
      { id: 'malformed', runtimeId: 'runtime-invalid', configDir: 'C:/quota/malformed' },
      { id: 'mismatched', runtimeId: 'runtime-invalid', configDir: 'C:/quota/mismatched' },
    ],
    runtimes,
    service,
    now: () => 3_100,
  });
  await poller.pollOnce();

  for (const accountId of ['malformed', 'mismatched']) {
    const snapshot = service.get('runtime-invalid', accountId);
    assert.ok(snapshot);
    assert.equal(snapshot.availability, 'unavailable');
    assert.equal(snapshot.unavailableReason, 'invalid-observation');
    assert.equal(snapshot.observedAt, 3_100);
  }
});

test('future adapter time becomes unavailable and cannot block a later normal pull', async () => {
  freshDb();
  const service = new SubscriptionQuotaService();
  const runtimes = new RuntimeRegistry();
  let observedAt = Number.MAX_SAFE_INTEGER;
  let receiptTime = 3_500;
  runtimes.register(adapter('runtime-future', async (accountId) =>
    availableBatch('runtime-future', accountId, observedAt)));
  const poller = new SubscriptionQuotaPoller({
    accounts: [{
      id: 'personal', runtimeId: 'runtime-future', configDir: 'C:/quota/future',
    }],
    runtimes,
    service,
    now: () => receiptTime,
  });

  await poller.pollOnce();
  const rejected = service.get('runtime-future', 'personal');
  assert.ok(rejected);
  assert.equal(rejected.revision, 1);
  assert.equal(rejected.availability, 'unavailable');
  assert.equal(rejected.unavailableReason, 'invalid-observation');
  assert.equal(rejected.observedAt, receiptTime);

  receiptTime = 3_600;
  observedAt = receiptTime;
  await poller.pollOnce();
  const recovered = service.get('runtime-future', 'personal');
  assert.ok(recovered);
  assert.equal(recovered.revision, 2);
  assert.equal(recovered.availability, 'available');
  assert.equal(recovered.observedAt, receiptTime);
});

test('unchanged successful observations still refresh durable revision and freshness', async () => {
  freshDb();
  const service = new SubscriptionQuotaService();
  const runtimes = new RuntimeRegistry();
  let observedAt = 4_000;
  runtimes.register(adapter('runtime-refresh', async (accountId) =>
    availableBatch('runtime-refresh', accountId, observedAt, 0.4)));
  const poller = new SubscriptionQuotaPoller({
    accounts: [{
      id: 'personal',
      runtimeId: 'runtime-refresh',
      configDir: 'C:/quota/refresh',
    }],
    runtimes,
    service,
  });

  await poller.pollOnce();
  observedAt = 5_000;
  await poller.pollOnce();

  const snapshot = service.get('runtime-refresh', 'personal');
  assert.ok(snapshot);
  assert.equal(snapshot.revision, 2);
  assert.equal(snapshot.observedAt, 5_000);
  assert.equal(snapshot.observations[0]?.observedAt, 5_000);
  assert.equal(snapshot.observations[0]?.staleAt, 605_000);
  const events = listLiveOutboxRowsAfter('0', 100)
    .filter((row) => row.entity === 'subscription-quota');
  assert.deepEqual(events.map((row) => row.version), [1, 2]);
});

test('a timed-out native observation is aborted and cannot overlap its successor', async () => {
  freshDb();
  const service = new SubscriptionQuotaService();
  const runtimes = new RuntimeRegistry();
  let release!: (batch: SubscriptionQuotaObservationBatch) => void;
  const pending = new Promise<SubscriptionQuotaObservationBatch>((resolve) => {
    release = resolve;
  });
  const signals: AbortSignal[] = [];
  let providerCalls = 0;
  let pollNow = 6_000;
  runtimes.register(adapter('runtime-slow', async (accountId, options) => {
    providerCalls += 1;
    if (options?.signal) signals.push(options.signal);
    return pending.then(() => availableBatch('runtime-slow', accountId, 6_001, 0.6));
  }));
  const poller = new SubscriptionQuotaPoller({
    accounts: [{ id: 'personal', runtimeId: 'runtime-slow', configDir: 'C:/quota/slow' }],
    runtimes,
    service,
    timeoutMs: 5,
    now: () => pollNow,
  });

  await poller.pollOnce();
  assert.equal(providerCalls, 1);
  assert.equal(signals[0]?.aborted, true);
  const timedOut = service.get('runtime-slow', 'personal');
  assert.ok(timedOut);
  assert.equal(timedOut.revision, 1);
  assert.equal(timedOut.unavailableReason, 'observation-timeout');

  await poller.pollOnce();
  assert.equal(providerCalls, 1, 'still-running native work must not overlap');
  assert.equal(service.get('runtime-slow', 'personal')?.revision, 1);

  release(availableBatch('runtime-slow', 'personal', 6_001, 0.6));
  await new Promise<void>((resolve) => setImmediate(resolve));
  pollNow = 6_001;
  await poller.pollOnce();
  assert.equal(providerCalls, 2);
  const recovered = service.get('runtime-slow', 'personal');
  assert.ok(recovered);
  assert.equal(recovered.revision, 2);
  assert.equal(recovered.availability, 'available');
  assert.equal(recovered.observations[0]?.usedFraction, 0.6);
  poller.stop();
});
