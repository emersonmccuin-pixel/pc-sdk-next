// Migration 0005 — worktree-row run bindings + durable stranded state.
// Round-trip of the new nullable fields, the stranded flip/unflip, and the
// active-name/path partial unique indexes staying honest across the flip.

import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ULID } from '@pc/domain';

const tmpDir = mkdtempSync(join(tmpdir(), 'pc-worktree-bindings-'));
process.env.PC_DATA_DIR = tmpDir;

const {
  assertSchemaIntact,
  closeDb,
  getActiveWorktreeByName,
  getRawDb,
  listActiveWorktrees,
  listStrandedWorktrees,
  markWorktreeStranded,
  newId,
  reviveStrandedWorktree,
  runMigrations,
  setWorktreeContractId,
  upsertWorktree,
} = await import('../src/index.ts');

before(() => runMigrations());
after(() => {
  closeDb();
  rmSync(tmpDir, { recursive: true, force: true });
});

test('0005 adds the binding + stranded columns; schema intact', () => {
  const cols = (getRawDb().pragma('table_info("worktrees")') as { name: string }[]).map((c) => c.name);
  for (const col of ['project_id', 'agent_run_id', 'contract_id', 'branch', 'base_branch', 'base_sha', 'stranded_reason', 'stranded_at']) {
    assert.ok(cols.includes(col), `worktrees.${col} should exist after migration 0005`);
  }
  assert.doesNotThrow(() => assertSchemaIntact());
});

test('binding fields round-trip; contractId stamps later', () => {
  const projectId = newId() as ULID;
  const agentRunId = newId() as ULID;
  const row = upsertWorktree({
    name: 'agent-bind0001',
    path: join(tmpDir, 'agent-bind0001'),
    projectId,
    agentRunId,
    branch: 'agent-bind0001',
    baseBranch: 'main',
    baseSha: 'a'.repeat(40),
  });
  assert.equal(row.contractId, null, 'contract postdates provisioning');
  const contractId = newId() as ULID;
  setWorktreeContractId('agent-bind0001', contractId);
  const read = getActiveWorktreeByName('agent-bind0001')!;
  assert.equal(read.projectId, projectId);
  assert.equal(read.agentRunId, agentRunId);
  assert.equal(read.contractId, contractId);
  assert.equal(read.branch, 'agent-bind0001');
  assert.equal(read.baseBranch, 'main');
  assert.equal(read.baseSha, 'a'.repeat(40));
  assert.equal(read.strandedReason, null);
});

test('legacy upsert (no bindings) stays valid — all NULL', () => {
  const row = upsertWorktree({ name: 'agent-legacy01', path: join(tmpDir, 'agent-legacy01') });
  assert.equal(row.projectId, null);
  assert.equal(row.agentRunId, null);
  assert.equal(row.branch, null);
});

test('stranded flip is durable; revive clears the stamp', () => {
  const projectId = newId() as ULID;
  const row = upsertWorktree({ name: 'agent-strand01', path: join(tmpDir, 'agent-strand01'), projectId });
  markWorktreeStranded('agent-strand01', 'no-live-run', 123456);

  assert.equal(getActiveWorktreeByName('agent-strand01'), null, 'no longer active');
  const stranded = listStrandedWorktrees(projectId);
  assert.equal(stranded.length, 1);
  assert.equal(stranded[0].strandedReason, 'no-live-run');
  assert.equal(stranded[0].strandedAt, 123456);
  assert.ok(!listActiveWorktrees().some((w) => w.name === 'agent-strand01'));

  assert.equal(reviveStrandedWorktree(row.id), true);
  const back = getActiveWorktreeByName('agent-strand01')!;
  assert.equal(back.status, 'active');
  assert.equal(back.strandedReason, null, 'reason cleared');
  assert.equal(back.strandedAt, null);
  assert.equal(listStrandedWorktrees(projectId).length, 0);
});

test('a stranded row frees its name for a new active row; revive then refuses', () => {
  const path = join(tmpDir, 'agent-strand02');
  const first = upsertWorktree({ name: 'agent-strand02', path });
  markWorktreeStranded('agent-strand02', 'dir-missing');
  // Partial unique index is on status='active' only — reuse must not throw.
  const second = upsertWorktree({ name: 'agent-strand02', path });
  assert.notEqual(second.id, first.id);
  assert.equal(second.status, 'active');
  // Reviving the old row would collide with the new active row — refused.
  assert.equal(reviveStrandedWorktree(first.id), false);
  assert.equal(listStrandedWorktrees().some((w) => w.id === first.id), true, 'old row stays stranded');
});

test('revive is a no-op on non-stranded rows', () => {
  const row = upsertWorktree({ name: 'agent-active01', path: join(tmpDir, 'agent-active01') });
  assert.equal(reviveStrandedWorktree(row.id), false);
});
