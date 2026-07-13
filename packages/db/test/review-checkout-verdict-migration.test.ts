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
      lifecycle_state text,
      preparation_receipt text,
      readiness_receipt text,
      rev integer NOT NULL DEFAULT 1
    );
    CREATE TABLE agent_contracts (
      id text PRIMARY KEY NOT NULL,
      project_id text,
      version integer,
      agent_run_id text,
      verification_status text,
      deliverable text,
      review_run_id text,
      review_sealed_commit text,
      landing_status text,
      landing_authorizer text,
      abandonment_receipt text
    );
    CREATE TABLE live_outbox (
      seq integer PRIMARY KEY AUTOINCREMENT,
      id text,
      scope text,
      project_id text,
      type text,
      entity text NOT NULL,
      entity_id text,
      version integer,
      created_at integer,
      published_at integer,
      payload text NOT NULL
    );
    CREATE TRIGGER review_checkouts_preparation_guard
      BEFORE UPDATE OF preparation_receipt ON review_checkouts
      BEGIN SELECT 1; END;
    CREATE TRIGGER review_checkouts_readiness_guard
      BEFORE UPDATE OF readiness_receipt ON review_checkouts
      BEGIN SELECT 1; END;
    CREATE TRIGGER review_checkouts_insert_guard
      BEFORE INSERT ON review_checkouts
      BEGIN SELECT 1; END;
    CREATE TRIGGER review_checkouts_provision_guard
      BEFORE UPDATE OF provision_receipt ON review_checkouts
      BEGIN SELECT 1; END;
    CREATE TRIGGER review_checkouts_teardown_guard
      BEFORE UPDATE OF teardown_receipt ON review_checkouts
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
  db.prepare(`
    INSERT INTO agent_runs
      (id, status, contract_id, preparation_receipt, readiness_receipt)
      VALUES ('legacy-reviewer', 'completed', 'legacy-review-contract', ?, ?)
  `).run(JSON.stringify(preparation), JSON.stringify(readiness));
  db.exec(`
    INSERT INTO agent_runs
      (id, status, contract_id, lifecycle_state)
      VALUES ('producer', 'completed', 'legacy-target', 'reviewing');
    INSERT INTO agent_contracts
      (id, project_id, version, agent_run_id, verification_status, deliverable,
       review_run_id, review_sealed_commit, landing_status, landing_authorizer,
       abandonment_receipt)
      VALUES ('legacy-target', 'project', 9, 'producer', 'passed',
        '{"kind":"repo","commit":"${'b'.repeat(40)}"}', 'legacy-reviewer',
        '${'b'.repeat(40)}', NULL, NULL, NULL);
  `);
  db.prepare(`
    INSERT INTO review_checkouts (
      id, project_id, contract_id, contract_version, producer_run_id,
      reviewer_run_id, repository_identity, worktree_path,
      owned_root_real_path, sealed_commit, status, provision_receipt,
      preparation_receipt, readiness_receipt, teardown_receipt,
      created_at, updated_at, destroyed_at
    ) VALUES (
      'legacy-checkout', 'project', 'legacy-target', 9, 'producer',
      'legacy-reviewer', ?, 'E:/repo/reviews/legacy-reviewer',
      'E:/repo/reviews', ?, 'destroyed', '{}', ?, ?, '{}', 1, 120, 120
    )
  `).run(
    JSON.stringify(repositoryIdentity),
    'b'.repeat(40),
    JSON.stringify(preparation),
    JSON.stringify(readiness),
  );
  db.prepare(`
    INSERT INTO agent_runs
      (id, status, contract_id, lifecycle_state)
      VALUES ('stale-producer', 'completed', 'legacy-stale-target', 'reviewing')
  `).run();
  db.prepare(`
    INSERT INTO agent_runs
      (id, status, contract_id, preparation_receipt, readiness_receipt)
      VALUES ('legacy-stale-reviewer', 'completed', 'legacy-stale-review-contract', ?, ?)
  `).run(JSON.stringify(preparation), JSON.stringify(readiness));
  db.exec(`
    INSERT INTO agent_contracts
      (id, project_id, version, agent_run_id, verification_status, deliverable,
       review_run_id, review_sealed_commit, landing_status, landing_authorizer,
       abandonment_receipt)
      VALUES ('legacy-stale-target', 'project', 10, 'stale-producer', 'failed',
        '{"kind":"repo","commit":"${'c'.repeat(40)}"}', 'legacy-stale-reviewer',
        '${'c'.repeat(40)}', NULL, NULL, NULL);
  `);
  db.prepare(`
    INSERT INTO review_checkouts (
      id, project_id, contract_id, contract_version, producer_run_id,
      reviewer_run_id, repository_identity, worktree_path,
      owned_root_real_path, sealed_commit, status, provision_receipt,
      preparation_receipt, readiness_receipt, teardown_receipt,
      created_at, updated_at, destroyed_at
    ) VALUES (
      'legacy-stale-checkout', 'project', 'legacy-stale-target', 9,
      'stale-producer', 'legacy-stale-reviewer', ?,
      'E:/repo/reviews/legacy-stale-reviewer', 'E:/repo/reviews', ?,
      'destroyed', '{}', ?, ?, '{}', 1, 121, 121
    )
  `).run(
    JSON.stringify(repositoryIdentity),
    'b'.repeat(40),
    JSON.stringify(preparation),
    JSON.stringify(readiness),
  );
  db.exec(`
    INSERT INTO live_outbox (entity, entity_id, version, payload) VALUES
      ('agent-run', 'other-run', 4, '{"run":{"rev":4,"preparationReceipt":{"retained":true},"readinessReceipt":{"retained":true}}}'),
      ('agent-run', 'reviewer', 1, '{"run":{"rev":1,"preparationReceipt":{"stale":true},"readinessReceipt":{"stale":true}}}'),
      ('agent-run', 'other-run-2', 6, '{"run":{"rev":6,"preparationReceipt":null,"readinessReceipt":null}}'),
      ('usage', NULL, 8, '{"retained":true}');
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
    SELECT preparation_receipt preparation, readiness_receipt readiness, rev
    FROM agent_runs WHERE id = 'reviewer'
  `).get(), { preparation: null, readiness: null, rev: 2 });
  assert.deepEqual(db.prepare(`
    SELECT id, rev FROM agent_runs ORDER BY id
  `).all(), [
    { id: 'legacy-reviewer', rev: 2 },
    { id: 'legacy-stale-reviewer', rev: 2 },
    { id: 'producer', rev: 1 },
    { id: 'reviewer', rev: 2 },
    { id: 'stale-producer', rev: 1 },
  ], 'only reviewer runs whose legacy phase evidence was quarantined advance');
  const legacyVerdict = JSON.parse(db.prepare(
    "SELECT verdict_receipt FROM review_checkouts WHERE id = 'legacy-checkout'",
  ).pluck().get() as string) as Record<string, unknown>;
  assert.equal(legacyVerdict.outcome, 'unavailable');
  assert.equal(legacyVerdict.reviewerRunId, 'legacy-reviewer');
  assert.equal(legacyVerdict.reviewerContractId, 'legacy-review-contract');
  assert.deepEqual(legacyVerdict.findings, []);
  const staleVerdict = JSON.parse(db.prepare(
    "SELECT verdict_receipt FROM review_checkouts WHERE id = 'legacy-stale-checkout'",
  ).pluck().get() as string) as Record<string, unknown>;
  assert.equal(staleVerdict.outcome, 'void');
  const outbox = db.prepare(
    'SELECT seq, entity, entity_id entityId, version, payload FROM live_outbox ORDER BY seq',
  ).all() as Array<{
    seq: number;
    entity: string;
    entityId: string | null;
    version: number;
    payload: string;
  }>;
  assert.deepEqual(outbox.map((row) => row.seq), [1, 2, 3, 4, 5], 'migration preserves a gapless cursor stream');
  assert.deepEqual(outbox.map((row) => [row.entity, row.entityId]), [
    ['agent-run', 'other-run'],
    ['agent-run', 'reviewer'],
    ['agent-run', 'other-run-2'],
    ['usage', null],
    ['agent-run', 'reviewer'],
  ]);
  assert.deepEqual(JSON.parse(outbox[1]!.payload), {
    run: { rev: 1, preparationReceipt: null, readinessReceipt: null },
  });
  assert.equal(outbox[1]!.version, 1, 'the historical frame keeps its original revision');
  assert.deepEqual(JSON.parse(outbox[4]!.payload), {
    run: { rev: 2, preparationReceipt: null, readinessReceipt: null },
  }, 'a post-cursor reconciliation frame carries the quarantined projection');
  assert.equal(outbox[4]!.version, 2, 'the appended frame announces the durable revision');

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
