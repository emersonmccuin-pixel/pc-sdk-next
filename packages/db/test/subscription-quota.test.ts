import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import type { SubscriptionQuotaSnapshot } from '@pc/contracts';

const tmpDir = mkdtempSync(join(tmpdir(), 'pc-subscription-quota-db-'));
process.env.PC_DATA_DIR = tmpDir;

const db = await import('../src/index.ts');

before(() => db.runMigrations());
after(() => {
  db.closeDb();
  rmSync(tmpDir, { recursive: true, force: true });
});

function snapshot(
  runtimeId: string,
  accountId: string,
  observedAt: number,
  overrides: Partial<SubscriptionQuotaSnapshot> = {},
): SubscriptionQuotaSnapshot {
  const id = overrides.id ?? db.newId();
  const revision = overrides.revision ?? 1;
  return {
    id,
    runtimeId,
    accountId,
    revision,
    availability: 'available',
    unavailableReason: null,
    observedAt,
    observations: [{
      window: { id: 'five-hour', label: '5h', durationMs: 5 * 60 * 60_000 },
      scope: { kind: 'account' },
      source: { semantics: 'used', fraction: 0.25 },
      usedFraction: 0.25,
      confidence: 'exact',
      limitState: 'allowed',
      resetsAt: null,
      observedAt,
      staleAt: observedAt + 10 * 60_000,
    }],
    ...overrides,
  };
}

function insertRawQuota(candidate: SubscriptionQuotaSnapshot): void {
  db.getRawDb().prepare(`
    INSERT INTO subscription_quota (
      id, runtime_id, account_id, revision, availability,
      unavailable_reason, observed_at, snapshot_json
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    candidate.id,
    candidate.runtimeId,
    candidate.accountId,
    candidate.revision,
    candidate.availability,
    candidate.unavailableReason,
    candidate.observedAt,
    JSON.stringify(candidate),
  );
}

test('current-state repo round-trips exact snapshots and isolates peer runtime accounts', () => {
  const first = snapshot('runtime-db-a', 'personal', 1_000);
  const peer = snapshot('runtime-db-b', 'personal', 1_000);
  assert.deepEqual(db.insertSubscriptionQuotaSnapshotInDb(db.getDb(), first), first);
  assert.deepEqual(db.insertSubscriptionQuotaSnapshotInDb(db.getDb(), peer), peer);
  assert.deepEqual(db.getSubscriptionQuotaSnapshot('runtime-db-a', 'personal'), first);
  assert.deepEqual(db.getSubscriptionQuotaSnapshot('runtime-db-b', 'personal'), peer);

  const updated = snapshot('runtime-db-a', 'personal', 2_000, {
    id: first.id,
    revision: 2,
  });
  assert.deepEqual(
    db.updateSubscriptionQuotaSnapshotInDb(db.getDb(), updated, 1),
    updated,
  );
  assert.equal(db.getSubscriptionQuotaSnapshot('runtime-db-a', 'personal')?.id, first.id);
  assert.equal(db.getSubscriptionQuotaSnapshot('runtime-db-a', 'personal')?.revision, 2);
});

test('raw SQL cannot mutate identity, skip revision, or admit malformed snapshot JSON', () => {
  const original = snapshot('runtime-raw-guard', 'work', 10_000);
  db.insertSubscriptionQuotaSnapshotInDb(db.getDb(), original);
  const raw = db.getRawDb();

  assert.throws(
    () => raw.prepare(`
      UPDATE subscription_quota
      SET runtime_id = 'other', revision = 2,
          snapshot_json = json_set(snapshot_json, '$.runtimeId', 'other', '$.revision', 2)
      WHERE id = ?
    `).run(original.id),
    /invalid subscription quota update/,
  );
  assert.throws(
    () => raw.prepare(`
      UPDATE subscription_quota
      SET revision = 3, snapshot_json = json_set(snapshot_json, '$.revision', 3)
      WHERE id = ?
    `).run(original.id),
    /invalid subscription quota update/,
  );
  assert.throws(
    () => raw.prepare(`
      UPDATE subscription_quota
      SET revision = 2,
          snapshot_json = json_set(snapshot_json, '$.revision', 2, '$.providerSecret', 'nope')
      WHERE id = ?
    `).run(original.id),
    /invalid subscription quota snapshot/,
  );
  assert.throws(
    () => raw.prepare(`
      UPDATE subscription_quota
      SET revision = 2,
          snapshot_json = json_set(
            snapshot_json,
            '$.revision', 2,
            '$.observations[0].confidence', 'derived'
          )
      WHERE id = ?
    `).run(original.id),
    /invalid subscription quota snapshot/,
  );
  assert.throws(
    () => raw.prepare(`
      UPDATE subscription_quota
      SET revision = 2,
          snapshot_json = json_set(
            snapshot_json,
            '$.revision', 2,
            '$.observations[0].usedFraction', 0.75
          )
      WHERE id = ?
    `).run(original.id),
    /invalid subscription quota snapshot/,
  );
  assert.throws(
    () => raw.prepare(`
      UPDATE subscription_quota
      SET revision = 2,
          snapshot_json = json_remove(
            json_set(snapshot_json, '$.revision', 2),
            '$.observations[0].confidence'
          )
      WHERE id = ?
    `).run(original.id),
    /invalid subscription quota snapshot/,
  );
  const future = Date.now() + 60_000;
  assert.throws(
    () => raw.prepare(`
      UPDATE subscription_quota
      SET revision = 2, observed_at = ?,
          snapshot_json = json_set(
            snapshot_json,
            '$.revision', 2,
            '$.observedAt', ?,
            '$.observations[0].observedAt', ?,
            '$.observations[0].staleAt', ?
          )
      WHERE id = ?
    `).run(future, future, future, future + 600000, original.id),
    /invalid subscription quota update/,
  );
  assert.throws(
    () => raw.prepare('DELETE FROM subscription_quota WHERE id = ?').run(original.id),
    /subscription quota deletion is unsupported/,
  );
  assert.equal(db.getSubscriptionQuotaSnapshot('runtime-raw-guard', 'work')?.revision, 1);
});

test('insert guards require revision one, exact ULID, canonical ASCII, bounded windows, and receipt time', () => {
  assert.throws(
    () => db.insertSubscriptionQuotaSnapshotInDb(
      db.getDb(),
      snapshot('runtime-repo-revision', 'personal', 1_000, { revision: 2 }),
    ),
    /revision conflict/,
  );

  const candidates: SubscriptionQuotaSnapshot[] = [
    snapshot('runtime-raw-revision', 'personal', 1_000, { revision: 500 }),
    snapshot('runtime-raw-id', 'personal', 1_000, { id: 'not-a-ulid' }),
    snapshot('runtime-raw-id-overflow', 'personal', 1_000, {
      id: `8${'0'.repeat(25)}`,
    }),
    snapshot('runtime-raw-id-nul', 'personal', 1_000, {
      id: `${db.newId()}\u0000suffix`,
    }),
    snapshot('\truntime-tab', 'personal', 1_000),
    snapshot('runtime\u0000peer', 'personal', 1_000),
    snapshot('\u00a0runtime-nbsp', 'personal', 1_000),
    snapshot('runtime-emoji-😀', 'personal', 1_000),
    snapshot('r'.repeat(201), 'personal', 1_000),
  ];
  for (const candidate of candidates) {
    assert.throws(() => insertRawQuota(candidate));
  }

  const badWindow = snapshot('runtime-raw-window', 'personal', 1_000);
  badWindow.observations[0]!.window.id = '\twindow';
  assert.throws(() => insertRawQuota(badWindow), /invalid subscription quota snapshot/);
  const nulWindow = snapshot('runtime-raw-window-nul', 'personal', 1_000);
  nulWindow.observations[0]!.window.id = 'window\u0000suffix';
  assert.throws(() => insertRawQuota(nulWindow), /invalid subscription quota snapshot/);
  const badLabel = snapshot('runtime-raw-label', 'personal', 1_000);
  badLabel.observations[0]!.window.label = 'quota 😀';
  assert.throws(() => insertRawQuota(badLabel), /invalid subscription quota snapshot/);
  const nulLabel = snapshot('runtime-raw-label-nul', 'personal', 1_000);
  nulLabel.observations[0]!.window.label = 'quota\u0000suffix';
  assert.throws(() => insertRawQuota(nulLabel), /invalid subscription quota snapshot/);
  const badModel = snapshot('runtime-raw-model', 'personal', 1_000);
  badModel.observations[0]!.scope = { kind: 'model', model: '\u00a0opus' };
  assert.throws(() => insertRawQuota(badModel), /invalid subscription quota snapshot/);
  const nulModel = snapshot('runtime-raw-model-nul', 'personal', 1_000);
  nulModel.observations[0]!.scope = { kind: 'model', model: 'opus\u0000suffix' };
  assert.throws(() => insertRawQuota(nulModel), /invalid subscription quota snapshot/);

  const stale = snapshot('runtime-raw-stale', 'personal', 1_000);
  stale.observations[0] = {
    ...stale.observations[0]!,
    staleAt: Number.MAX_SAFE_INTEGER,
  };
  assert.throws(() => insertRawQuota(stale), /invalid subscription quota snapshot/);

  const tooMany = snapshot('runtime-raw-count', 'personal', 1_000);
  tooMany.observations = Array.from({ length: 65 }, (_, index) => ({
    ...tooMany.observations[0]!,
    window: { ...tooMany.observations[0]!.window, id: `window-${index}` },
  }));
  assert.throws(() => insertRawQuota(tooMany), /invalid subscription quota snapshot/);

  const future = snapshot('runtime-raw-future', 'personal', Date.now() + 60_000);
  assert.throws(() => insertRawQuota(future), /invalid subscription quota insert/);
});

test('current-state truth survives complete live-outbox pruning and DB reopen', () => {
  const current = snapshot('runtime-prune-proof', 'personal', 20_000);
  db.insertSubscriptionQuotaSnapshotInDb(db.getDb(), current);
  db.insertLiveEvent(db.getDb(), {
    scope: 'global',
    projectId: null,
    type: 'subscription-quota.changed',
    entity: 'subscription-quota',
    entityId: current.id as never,
    version: current.revision,
    payload: current,
  });
  db.pruneLiveOutbox({ maxRows: 0 });
  assert.equal(db.listLiveOutboxRowsAfter('0', 500).length, 0);

  db.closeDb();
  db.runMigrations();
  assert.deepEqual(
    db.getSubscriptionQuotaSnapshot('runtime-prune-proof', 'personal'),
    current,
  );
});

test('0014 removes legacy usage projections instead of inventing canonical evidence', () => {
  const dir = mkdtempSync(join(tmpdir(), 'pc-subscription-quota-migration-'));
  const sqlite = new Database(join(dir, 'legacy.sqlite'));
  try {
    sqlite.exec('CREATE TABLE live_outbox (entity text NOT NULL)');
    sqlite.prepare('INSERT INTO live_outbox (entity) VALUES (?)').run('usage');
    sqlite.prepare('INSERT INTO live_outbox (entity) VALUES (?)').run('project');
    const migration = readFileSync(
      new URL('../drizzle/0014_subscription_quota.sql', import.meta.url),
      'utf8',
    );
    sqlite.transaction(() => {
      for (const statement of migration.split('--> statement-breakpoint')) {
        const sql = statement.trim();
        if (sql) sqlite.exec(sql);
      }
    })();
    assert.deepEqual(
      sqlite.prepare('SELECT entity FROM live_outbox ORDER BY entity').all(),
      [{ entity: 'project' }],
    );
    assert.equal(
      (sqlite.prepare('SELECT count(*) AS n FROM subscription_quota').get() as { n: number }).n,
      0,
    );
  } finally {
    sqlite.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
