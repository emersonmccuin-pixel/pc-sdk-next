import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import Database from 'better-sqlite3';

const here = dirname(fileURLToPath(import.meta.url));

function apply0019(db: Database.Database): void {
  const sql = readFileSync(
    join(here, '..', 'drizzle', '0019_review_checkout_verdicts.sql'),
    'utf8',
  );
  db.transaction(() => {
    for (const statement of sql.split('--> statement-breakpoint')) {
      if (statement.trim()) db.exec(statement);
    }
  })();
}

const preparation = {
  phase: 'preparation',
  outcome: 'not-required',
  reason: 'no-commands-configured',
  ok: true,
  steps: [],
  finishedAt: 100,
};
const readiness = {
  phase: 'readiness',
  outcome: 'not-required',
  reason: 'no-commands-configured',
  ok: true,
  steps: [],
  finishedAt: 101,
};
const repositoryIdentity = {
  protocol: 'git-common-dir-v1',
  gitCommonDir: 'E:/repo/.git',
  leaseKey: `sha256:${'a'.repeat(64)}`,
};

function checkoutPhase(
  phase: typeof preparation | typeof readiness,
  over: Record<string, unknown> = {},
) {
  return {
    protocol: 'review-checkout-phase-v1',
    id: 'checkout',
    projectId: 'project',
    contractId: 'target',
    contractVersion: 7,
    producerRunId: 'producer',
    reviewerRunId: 'reviewer',
    repositoryIdentity,
    worktreePath: 'E:/repo/reviews/reviewer',
    ownedRootRealPath: 'E:/repo/reviews',
    sealedCommit: 'b'.repeat(40),
    evidence: phase,
    ...over,
  };
}

test('0019 quarantines generic review phases and installs checkout-bound phase/verdict fences', () => {
  const db = new Database(':memory:');
  db.exec(`
    CREATE TABLE review_checkouts (
      id text PRIMARY KEY NOT NULL,
      project_id text NOT NULL,
      contract_id text NOT NULL,
      contract_version integer NOT NULL,
      producer_run_id text NOT NULL,
      reviewer_run_id text NOT NULL,
      repository_identity text NOT NULL,
      worktree_path text NOT NULL,
      owned_root_real_path text NOT NULL,
      sealed_commit text NOT NULL,
      status text NOT NULL,
      provision_receipt text,
      preparation_receipt text,
      readiness_receipt text,
      teardown_receipt text,
      cleanup_error text,
      created_at integer NOT NULL,
      updated_at integer NOT NULL,
      destroyed_at integer
    );
    CREATE TABLE agent_runs (
      id text PRIMARY KEY NOT NULL,
      status text NOT NULL,
      contract_id text,
      preparation_receipt text,
      readiness_receipt text
    );
    CREATE TABLE agent_contracts (
      id text PRIMARY KEY NOT NULL,
      verification_status text,
      deliverable text,
      review_run_id text,
      landing_status text,
      landing_authorizer text
    );
    CREATE TABLE live_outbox (
      seq integer PRIMARY KEY AUTOINCREMENT,
      entity text NOT NULL,
      entity_id text,
      payload text NOT NULL
    );
    CREATE TRIGGER review_checkouts_preparation_guard
      BEFORE UPDATE OF preparation_receipt ON review_checkouts
      BEGIN SELECT 1; END;
    CREATE TRIGGER review_checkouts_readiness_guard
      BEFORE UPDATE OF readiness_receipt ON review_checkouts
      BEGIN SELECT 1; END;
  `);
  db.prepare(`
    INSERT INTO agent_runs
      (id, status, contract_id, preparation_receipt, readiness_receipt)
      VALUES ('reviewer', 'queued', 'review-contract', ?, ?)
  `).run(JSON.stringify(preparation), JSON.stringify(readiness));
  db.prepare(`
    INSERT INTO review_checkouts (
      id, project_id, contract_id, contract_version, producer_run_id,
      reviewer_run_id, repository_identity, worktree_path,
      owned_root_real_path, sealed_commit, status, provision_receipt,
      preparation_receipt, readiness_receipt, created_at, updated_at
    ) VALUES (
      'checkout', 'project', 'target', 7, 'producer', 'reviewer', ?,
      'E:/repo/reviews/reviewer', 'E:/repo/reviews', ?, 'provisioned', '{}',
      ?, ?, 1, 101
    )
  `).run(
    JSON.stringify(repositoryIdentity),
    'b'.repeat(40),
    JSON.stringify(preparation),
    JSON.stringify(readiness),
  );
  db.exec(`
    INSERT INTO live_outbox (entity, entity_id, payload) VALUES
      ('agent-run', 'reviewer', '{"stale":"generic-review-phases"}'),
      ('agent-run', 'other-run', '{"retained":true}'),
      ('usage', NULL, '{"retained":true}');
  `);

  assert.doesNotThrow(() => apply0019(db));
  assert.deepEqual(db.prepare(`
    SELECT preparation_receipt preparation, readiness_receipt readiness,
           verdict_receipt verdict, verdict_applied_at applied
    FROM review_checkouts WHERE id = 'checkout'
  `).get(), {
    preparation: null,
    readiness: null,
    verdict: null,
    applied: null,
  });
  assert.deepEqual(db.prepare(`
    SELECT preparation_receipt preparation, readiness_receipt readiness
    FROM agent_runs WHERE id = 'reviewer'
  `).get(), { preparation: null, readiness: null });
  assert.deepEqual(
    db.prepare('SELECT entity, entity_id entityId, payload FROM live_outbox ORDER BY seq').all(),
    [
      { entity: 'agent-run', entityId: 'other-run', payload: '{"retained":true}' },
      { entity: 'usage', entityId: null, payload: '{"retained":true}' },
    ],
  );

  db.prepare(
    "UPDATE agent_runs SET preparation_receipt = ? WHERE id = 'reviewer'",
  ).run(JSON.stringify(preparation));
  for (const hostile of [
    preparation,
    checkoutPhase(preparation, { contractVersion: 8 }),
    checkoutPhase({ ...preparation, phase: 'readiness' } as never),
    checkoutPhase(preparation, { providerReceipt: 'native-leak' }),
  ]) {
    assert.throws(
      () => db.prepare(
        "UPDATE review_checkouts SET preparation_receipt = ? WHERE id = 'checkout'",
      ).run(JSON.stringify(hostile)),
      /invalid checkout-bound review preparation receipt/,
    );
  }
  assert.equal(
    db.prepare("SELECT preparation_receipt FROM review_checkouts WHERE id = 'checkout'")
      .pluck().get(),
    null,
  );
  db.close();
});
