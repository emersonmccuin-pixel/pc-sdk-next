import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type {
  SubscriptionQuotaObservationBatch,
  SubscriptionQuotaSourceObservation,
} from '@pc/contracts';

const tmpDir = mkdtempSync(join(tmpdir(), 'pc-subscription-quota-service-'));
process.env.PC_DATA_DIR = tmpDir;

const db = await import('@pc/db');
const {
  FutureSubscriptionQuotaObservationError,
  OlderSubscriptionQuotaObservationError,
  SubscriptionQuotaService,
} = await import('../src/subscription-quota/index.ts');

before(() => db.runMigrations());
after(() => {
  db.closeDb();
  rmSync(tmpDir, { recursive: true, force: true });
});

function source(
  id: string,
  semantics: 'used' | 'remaining',
  fraction: number,
  confidence: 'exact' | 'approximate' = 'exact',
  resetsAt: number | null = null,
): SubscriptionQuotaSourceObservation {
  return {
    window: { id, label: id.toUpperCase(), durationMs: null },
    scope: { kind: 'account' },
    source: { semantics, fraction },
    confidence,
    limitState: 'allowed',
    resetsAt,
  };
}

function available(
  runtimeId: string,
  accountId: string,
  observedAt: number,
  observations: SubscriptionQuotaSourceObservation[],
  coverage: 'partial' | 'complete' = 'complete',
): SubscriptionQuotaObservationBatch {
  return {
    runtimeId,
    accountId,
    availability: 'available',
    coverage,
    observedAt,
    observations,
  };
}

test('record derives used fractions and publishes one bound full snapshot atomically', () => {
  const service = new SubscriptionQuotaService();
  const result = service.record(available('runtime-normalize', 'personal', 1_000, [
    source('used', 'used', 0.25, 'exact'),
    source('remaining-exact', 'remaining', 0.8, 'exact'),
    source('remaining-approx', 'remaining', 0.7, 'approximate'),
    source('reset-capped', 'used', 0.5, 'exact', 1_100),
  ]));

  const byId = new Map(result.snapshot.observations.map((item) => [item.window.id, item]));
  assert.equal(byId.get('used')?.usedFraction, 0.25);
  assert.equal(byId.get('used')?.confidence, 'exact');
  assert.ok(Math.abs(byId.get('remaining-exact')!.usedFraction - 0.2) <= 1e-12);
  assert.equal(byId.get('remaining-exact')?.confidence, 'derived');
  assert.ok(Math.abs(byId.get('remaining-approx')!.usedFraction - 0.3) <= 1e-12);
  assert.equal(byId.get('remaining-approx')?.confidence, 'approximate');
  assert.equal(byId.get('used')?.staleAt, 601_000);
  assert.equal(byId.get('reset-capped')?.staleAt, 1_100);

  assert.equal(result.liveEvent.entity, 'subscription-quota');
  assert.equal(result.liveEvent.scope, 'global');
  assert.equal(result.liveEvent.projectId, null);
  assert.equal(result.liveEvent.entityId, result.snapshot.id);
  assert.equal(result.liveEvent.version, result.snapshot.revision);
  assert.deepEqual(result.liveEvent.payload, result.snapshot);
  assert.deepEqual(service.get('runtime-normalize', 'personal'), result.snapshot);
});

test('partial preserves omitted windows, complete clears them, and unavailable retains freshness', () => {
  const service = new SubscriptionQuotaService();
  const first = service.record(available('runtime-coverage', 'work', 10_000, [
    source('five-hour', 'used', 0.1),
    source('seven-day', 'used', 0.2),
  ]));
  const partial = service.record(available(
    'runtime-coverage',
    'work',
    20_000,
    [source('five-hour', 'used', 0.3)],
    'partial',
  ));
  assert.equal(partial.snapshot.id, first.snapshot.id);
  assert.equal(partial.snapshot.revision, 2);
  assert.deepEqual(partial.snapshot.observations.map((item) => item.window.id), [
    'five-hour',
    'seven-day',
  ]);
  const preserved = partial.snapshot.observations.find((item) => item.window.id === 'seven-day')!;
  assert.equal(preserved.observedAt, 10_000);
  assert.equal(preserved.staleAt, 610_000);

  const complete = service.record(available(
    'runtime-coverage',
    'work',
    30_000,
    [source('five-hour', 'used', 0.4)],
  ));
  assert.deepEqual(complete.snapshot.observations.map((item) => item.window.id), ['five-hour']);

  const unavailable = service.record({
    runtimeId: 'runtime-coverage',
    accountId: 'work',
    availability: 'unavailable',
    reason: 'runtime-unavailable',
    observedAt: 40_000,
  });
  assert.equal(unavailable.snapshot.availability, 'unavailable');
  assert.equal(unavailable.snapshot.unavailableReason, 'runtime-unavailable');
  assert.deepEqual(unavailable.snapshot.observations, complete.snapshot.observations);
});

test('older evidence is rejected without a revision or outbox write', () => {
  const service = new SubscriptionQuotaService();
  const first = service.record(available(
    'runtime-older',
    'personal',
    5_000,
    [source('five-hour', 'used', 0.1)],
  ));
  const beforeHead = db.getLiveEventHighWater();
  assert.throws(
    () => service.record(available(
      'runtime-older',
      'personal',
      4_999,
      [source('five-hour', 'used', 0.9)],
    )),
    OlderSubscriptionQuotaObservationError,
  );
  assert.deepEqual(service.get('runtime-older', 'personal'), first.snapshot);
  assert.equal(db.getLiveEventHighWater(), beforeHead);
});

test('future evidence cannot poison durable ordering and a later normal observation recovers', () => {
  let receiptTime = 50_000;
  const service = new SubscriptionQuotaService({ now: () => receiptTime });
  const beforeHead = db.getLiveEventHighWater();
  assert.throws(
    () => service.record(available(
      'runtime-future-guard',
      'personal',
      Number.MAX_SAFE_INTEGER,
      [source('five-hour', 'used', 0.9)],
    )),
    FutureSubscriptionQuotaObservationError,
  );
  assert.equal(service.get('runtime-future-guard', 'personal'), null);
  assert.equal(db.getLiveEventHighWater(), beforeHead);

  receiptTime = 60_000;
  const recovered = service.record(available(
    'runtime-future-guard',
    'personal',
    receiptTime,
    [source('five-hour', 'used', 0.2)],
  ));
  assert.equal(recovered.snapshot.revision, 1);
  assert.equal(recovered.snapshot.observedAt, receiptTime);
});

test('runtime/account identity is composite and stable across revisions', () => {
  const service = new SubscriptionQuotaService();
  const claude = service.record(available(
    'claude-runtime',
    'personal',
    1,
    [source('five-hour', 'used', 0.1)],
  ));
  const codex = service.record(available(
    'codex-runtime',
    'personal',
    1,
    [source('five-hour', 'remaining', 0.6)],
  ));
  const claudeNext = service.record(available(
    'claude-runtime',
    'personal',
    2,
    [source('five-hour', 'used', 0.2)],
  ));
  assert.notEqual(claude.snapshot.id, codex.snapshot.id);
  assert.equal(claudeNext.snapshot.id, claude.snapshot.id);
  assert.equal(claudeNext.snapshot.revision, 2);
});

test('outbox failure rolls back the current-state mutation', () => {
  const service = new SubscriptionQuotaService({
    insertLiveEvent: (() => {
      throw new Error('forced outbox failure');
    }) as typeof db.insertLiveEvent,
  });
  assert.throws(
    () => service.record(available(
      'runtime-rollback',
      'personal',
      1,
      [source('five-hour', 'used', 0.2)],
    )),
    /forced outbox failure/,
  );
  assert.equal(service.get('runtime-rollback', 'personal'), null);
});
