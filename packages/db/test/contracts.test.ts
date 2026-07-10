// agent_contracts schema applies, contracts repo CRUD + list-by-run, and the
// agent_runs.contract_id link round-trips. Contracts carry an external PM ref
// (`pm_ref`) instead of an internal work-item FK.

import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const tmpDir = mkdtempSync(join(tmpdir(), 'pc-contracts-'));
process.env.PC_DATA_DIR = tmpDir;

const {
  assertSchemaIntact,
  closeDb,
  createContract,
  createProject,
  getContract,
  getRawDb,
  insertAgentRunRow,
  listContractsForRun,
  newId,
  runMigrations,
  setAgentRunContractId,
  setContractDeliverable,
  setContractRun,
  setContractVerification,
} = await import('../src/index.ts');

before(() => runMigrations());
after(() => {
  closeDb();
  rmSync(tmpDir, { recursive: true, force: true });
});

function seedProject(slug: string) {
  return createProject({ slug, name: slug, folderPath: '' });
}

test('agent_contracts carries pm_ref (not work_item_id)', () => {
  const raw = getRawDb();
  const cols = (raw.pragma('table_info("agent_contracts")') as { name: string }[]).map(
    (c) => c.name,
  );
  for (const col of [
    'id', 'project_id', 'pm_ref', 'agent_run_id',
    'pod_name', 'expected_output', 'acceptance_criteria', 'verification_tier',
    'verification_status', 'verification_notes', 'report', 'deliverable',
    'worktree_path', 'worktree_base_branch', 'worktree_base_sha',
    'status', 'version', 'created_at', 'updated_at',
  ]) {
    assert.ok(cols.includes(col), `agent_contracts.${col} should exist`);
  }
  assert.ok(!cols.includes('work_item_id'), 'agent_contracts.work_item_id is dead');

  const runCols = (raw.pragma('table_info("agent_runs")') as { name: string }[]).map(
    (c) => c.name,
  );
  assert.ok(runCols.includes('contract_id'), 'agent_runs.contract_id should exist');
  assert.ok(runCols.includes('pm_ref'), 'agent_runs.pm_ref should exist');
  assert.ok(!runCols.includes('parent_work_item_id'), 'agent_runs.parent_work_item_id is dead');
});

test('assertSchemaIntact does not throw after a fresh migrate', () => {
  assert.doesNotThrow(() => assertSchemaIntact());
});

test('contracts repo: create / setRun / setDeliverable / setVerification + version bumps', () => {
  const p = seedProject('crud');
  const c0 = createContract({
    projectId: p.id,
    pmRef: null,
    podName: 'writer',
    expectedOutput: { kind: 'prose', doc_type: 'prd' },
    acceptanceCriteria: [{ kind: 'body_contains', pattern: 'Goals' }],
    verificationTier: 'auto',
  });
  assert.equal(c0.status, 'issued');
  assert.equal(c0.version, 1);
  assert.equal(c0.pmRef, null);
  assert.equal(c0.deliverable, null);

  const runId = newId();
  const c1 = setContractRun(c0.id, runId);
  assert.ok(c1);
  assert.equal(c1!.agentRunId, runId);
  assert.equal(c1!.status, 'dispatched');
  assert.equal(c1!.version, 2);

  const c2 = setContractDeliverable(c0.id, {
    deliverable: { kind: 'prose', text: '## Goals' },
    report: 'wrote the PRD',
  });
  assert.ok(c2);
  assert.deepEqual(c2!.deliverable, { kind: 'prose', text: '## Goals' });
  assert.equal(c2!.report, 'wrote the PRD');
  assert.equal(c2!.status, 'submitted');
  assert.equal(c2!.version, 3);

  const c3 = setContractVerification(c0.id, { verificationStatus: 'passed' });
  assert.ok(c3);
  assert.equal(c3!.verificationStatus, 'passed');
  assert.equal(c3!.status, 'accepted');
  assert.equal(c3!.version, 4);

  // round-trips through getContract
  const fetched = getContract(c0.id);
  assert.deepEqual(fetched, c3);

  // missing-id mutations return null
  assert.equal(setContractDeliverable('nope', { deliverable: null }), null);
  assert.equal(setContractVerification('nope', { verificationStatus: 'failed' }), null);
});

test('contracts carry an external pm_ref and list by run, newest first', () => {
  const p = seedProject('pmref');
  const runId = newId();
  const a = createContract({ projectId: p.id, pmRef: 'AINPM-1', agentRunId: runId, podName: 'a' });
  const b = createContract({ projectId: p.id, pmRef: 'AINPM-2', agentRunId: runId, podName: 'b' });
  assert.equal(a.pmRef, 'AINPM-1');
  const list = listContractsForRun(runId);
  assert.equal(list.length, 2);
  // newest-first
  assert.deepEqual(list.map((c) => c.id), [b.id, a.id]);
});

test('agent_runs.contract_id round-trips via insert + setter', () => {
  const p = seedProject('runlink');
  const runId = newId();
  const contractId = newId();
  insertAgentRunRow({
    id: runId,
    projectId: p.id,
    podName: 'x',
    dispatcherSessionId: 's',
    ccSessionId: 'cc',
    status: 'queued',
    input: null,
    contractId,
    queuedAt: Date.now(),
  });
  const raw = getRawDb();
  let row = raw.prepare('SELECT contract_id FROM agent_runs WHERE id = ?').get(runId) as {
    contract_id: string | null;
  };
  assert.equal(row.contract_id, contractId);

  setAgentRunContractId(runId, null);
  row = raw.prepare('SELECT contract_id FROM agent_runs WHERE id = ?').get(runId) as {
    contract_id: string | null;
  };
  assert.equal(row.contract_id, null);
});
