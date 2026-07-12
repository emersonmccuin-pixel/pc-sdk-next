import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import Database from 'better-sqlite3';

const here = dirname(fileURLToPath(import.meta.url));

function apply0017(db: Database.Database): void {
  const sql = readFileSync(
    join(here, '..', 'drizzle', '0017_worktree_abandonment.sql'),
    'utf8',
  );
  db.transaction(() => {
    for (const statement of sql.split('--> statement-breakpoint')) {
      if (statement.trim()) db.exec(statement);
    }
  })();
}

function authority() {
  return {
    protocol: 'worktree-abandonment-v1',
    requestId: '123e4567-e89b-42d3-a456-426614174000',
    approvedBy: 'user',
    approvalSurface: 'browser',
    approvalReason: 'explicit-browser-confirmation',
    approvedAt: 100,
    reason: null,
    approvedContractVersion: 1,
    projectId: 'project',
    contractId: 'approved',
    producerRunId: 'producer',
    worktreeId: 'worktree',
    worktreeStatus: 'active',
    repositoryIdentity: {
      protocol: 'git-common-dir-v1',
      gitCommonDir: 'E:/repo/.git',
      leaseKey: `sha256:${'a'.repeat(64)}`,
    },
    worktreePath: 'E:/repo/wt',
    branch: 'agent-approved',
    branchTip: 'b'.repeat(40),
    baseBranch: 'main',
    validatedBaseSha: 'c'.repeat(40),
    targetTip: 'c'.repeat(40),
    integrationState: 'unmerged',
    worktreeState: {
      directory: 'present', registration: 'registered', status: 'clean',
      staged: 0, unstaged: 0, untracked: 0,
      worktreeStateDigest: `sha256:${'d'.repeat(64)}`,
      changedPaths: [], ignoredContents: 'uninspected',
    },
    previewDigest: `sha256:${'e'.repeat(64)}`,
  };
}

function settlement() {
  const receipt = authority();
  return {
    protocol: 'worktree-abandonment-teardown-v1',
    authorityRequestId: receipt.requestId,
    startedAt: 200,
    finishedAt: 300,
    repositoryIdentity: receipt.repositoryIdentity,
    worktreePath: receipt.worktreePath,
    branch: receipt.branch,
    approvedBranchTip: receipt.branchTip,
    observedBranchTip: receipt.branchTip,
    directoryAbsent: true,
    registrationAbsent: true,
    branchPreserved: true,
  };
}

test('0017 preserves legacy rows, invalidates stale contract frames, and installs hostile fences', () => {
  const db = new Database(':memory:');
  db.exec(`
    CREATE TABLE agent_contracts (
      id text PRIMARY KEY NOT NULL,
      project_id text NOT NULL,
      agent_run_id text,
      worktree_path text,
      worktree_base_branch text,
      worktree_base_sha text,
      landing_status text,
      merge_sha text,
      landed_at integer,
      review_run_id text,
      version integer NOT NULL DEFAULT 1
    );
    CREATE TABLE agent_runs (
      id text PRIMARY KEY NOT NULL,
      project_id text,
      contract_id text,
      worktree_dir text,
      worktree_base_branch text,
      worktree_base_sha text,
      status text NOT NULL
    );
    CREATE TABLE worktrees (
      id text PRIMARY KEY NOT NULL,
      project_id text,
      agent_run_id text,
      contract_id text,
      path text NOT NULL,
      name text NOT NULL,
      branch text,
      base_branch text,
      base_sha text,
      status text NOT NULL,
      destroyed_at integer
    );
    CREATE TABLE live_outbox (
      seq integer PRIMARY KEY AUTOINCREMENT,
      entity text NOT NULL,
      payload text NOT NULL
    );
    INSERT INTO agent_contracts
      (id, project_id, landing_status, version)
      VALUES ('legacy', 'project', 'abandoned', 7);
    INSERT INTO agent_contracts
      (id, project_id, agent_run_id, worktree_path, worktree_base_branch, version)
      VALUES ('approved', 'project', 'producer', 'E:/repo/wt', 'main', 1);
    INSERT INTO worktrees
      (id, project_id, agent_run_id, contract_id, path, name, branch, base_branch, base_sha, status)
      VALUES (
        'worktree', 'project', 'producer', 'approved', 'E:/repo/wt',
        'agent-approved', 'agent-approved', 'main', '${'f'.repeat(40)}', 'active'
      );
    INSERT INTO agent_contracts
      (id, project_id, agent_run_id, worktree_path, worktree_base_branch, worktree_base_sha, version)
      VALUES ('continued', 'project', 'current-run', 'E:/repo/continued', 'main', '${'a'.repeat(40)}', 3);
    INSERT INTO agent_runs
      (id, project_id, contract_id, worktree_dir, worktree_base_branch, worktree_base_sha, status)
      VALUES
        ('original-run', 'project', 'continued', 'E:/repo/continued', 'main', '${'a'.repeat(40)}', 'completed'),
        ('current-run', 'project', 'continued', 'E:/repo/continued', 'main', '${'a'.repeat(40)}', 'completed');
    INSERT INTO worktrees
      (id, project_id, agent_run_id, contract_id, path, name, branch, base_branch, base_sha, status)
      VALUES (
        'continued-worktree', 'project', 'original-run', 'continued', 'E:/repo/continued',
        'agent-continued', 'agent-continued', 'main', '${'a'.repeat(40)}', 'stranded'
      );
    INSERT INTO live_outbox (entity, payload) VALUES
      ('contract', '{"stale":true}'),
      ('usage', '{"retained":true}');
  `);

  assert.doesNotThrow(() => apply0017(db));
  assert.deepEqual(db.prepare(`
    SELECT landing_status landingStatus,
           abandonment_receipt authority,
           abandonment_teardown_receipt settlement,
           abandonment_error error
    FROM agent_contracts WHERE id = 'legacy'
  `).get(), {
    landingStatus: 'abandoned', authority: null, settlement: null, error: null,
  });
  assert.deepEqual(
    db.prepare('SELECT entity, payload FROM live_outbox ORDER BY seq').all(),
    [{ entity: 'usage', payload: '{"retained":true}' }],
  );
  assert.equal(
    db.prepare("SELECT agent_run_id FROM worktrees WHERE id = 'continued-worktree'").pluck().get(),
    'current-run',
    'a uniquely provable legacy continuation transfers to the current producer',
  );

  assert.throws(
    () => db.prepare(
      "UPDATE agent_contracts SET landing_status = 'abandoned' WHERE id = 'approved'",
    ).run(),
    /new abandonment requires authority and teardown receipts/,
  );
  assert.throws(
    () => db.prepare(
      "INSERT INTO agent_contracts (id, project_id, landing_status) VALUES ('raw', 'project', 'abandoned')",
    ).run(),
    /guarded update authority/,
  );
  assert.throws(
    () => db.prepare(`
      UPDATE agent_contracts
      SET landing_status = 'abandoning', abandonment_receipt = '{}'
      WHERE id = 'approved'
    `).run(),
    /invalid abandonment authority receipt/,
  );

  db.prepare("UPDATE agent_contracts SET landing_status = 'pending' WHERE id = 'approved'").run();
  assert.throws(
    () => db.prepare(
      "INSERT INTO agent_runs (id, contract_id) VALUES ('landing-continuation', 'approved')",
    ).run(),
    /contract abandonment or landing forbids new agent runs/,
  );
  db.prepare("UPDATE agent_contracts SET landing_status = NULL WHERE id = 'approved'").run();

  const authorityJson = JSON.stringify(authority());
  db.prepare("UPDATE worktrees SET agent_run_id = 'wrong' WHERE id = 'worktree'").run();
  assert.throws(
    () => db.prepare(`
      UPDATE agent_contracts
      SET landing_status = 'abandoning', abandonment_receipt = ?, version = 2
      WHERE id = 'approved'
    `).run(authorityJson),
    /invalid abandonment authority receipt/,
  );
  db.prepare("UPDATE worktrees SET agent_run_id = 'producer' WHERE id = 'worktree'").run();
  db.prepare(
    "INSERT INTO agent_runs (id, contract_id, status) VALUES ('live', 'approved', 'running')",
  ).run();
  assert.throws(
    () => db.prepare(`
      UPDATE agent_contracts
      SET landing_status = 'abandoning', abandonment_receipt = ?, version = 2
      WHERE id = 'approved'
    `).run(authorityJson),
    /invalid abandonment authority receipt/,
  );
  db.prepare("DELETE FROM agent_runs WHERE id = 'live'").run();
  db.prepare(`
    UPDATE agent_contracts
    SET landing_status = 'abandoning', abandonment_receipt = ?, version = 2
    WHERE id = 'approved'
  `).run(authorityJson);
  assert.throws(
    () => db.prepare(
      "INSERT INTO agent_runs (id, contract_id) VALUES ('continuation', 'approved')",
    ).run(),
    /contract abandonment or landing forbids new agent runs/,
  );
  assert.throws(
    () => db.prepare(
      "UPDATE agent_contracts SET abandonment_receipt = json_set(abandonment_receipt, '$.approvedAt', 101) WHERE id = 'approved'",
    ).run(),
    /authority receipt is immutable/,
  );

  const wrongIdentity = settlement();
  wrongIdentity.repositoryIdentity = {
    ...wrongIdentity.repositoryIdentity,
    leaseKey: `sha256:${'f'.repeat(64)}`,
  };
  assert.throws(
    () => db.prepare(`
      UPDATE agent_contracts
      SET landing_status = 'abandoned', abandonment_teardown_receipt = ?
      WHERE id = 'approved'
    `).run(JSON.stringify(wrongIdentity)),
    /invalid abandonment teardown receipt/,
  );
  assert.throws(
    () => db.prepare(`
      UPDATE agent_contracts
      SET landing_status = 'abandoned', abandonment_teardown_receipt = '{}'
      WHERE id = 'approved'
    `).run(),
    /invalid abandonment teardown receipt/,
  );

  const settlementJson = JSON.stringify(settlement());
  assert.throws(
    () => db.prepare(`
      UPDATE agent_contracts
      SET landing_status = 'abandoned', abandonment_teardown_receipt = ?, version = 3
      WHERE id = 'approved'
    `).run(settlementJson),
    /invalid abandonment teardown receipt/,
  );
  db.prepare(`
    UPDATE worktrees SET status = 'destroyed', destroyed_at = 300
    WHERE id = 'worktree'
  `).run();
  db.prepare(`
    UPDATE agent_contracts
    SET landing_status = 'abandoned', abandonment_teardown_receipt = ?, version = 3
    WHERE id = 'approved'
  `).run(settlementJson);
  assert.throws(
    () => db.prepare(
      "UPDATE agent_contracts SET abandonment_teardown_receipt = json_set(abandonment_teardown_receipt, '$.finishedAt', 301) WHERE id = 'approved'",
    ).run(),
    /teardown receipt is immutable/,
  );
  db.close();
});
