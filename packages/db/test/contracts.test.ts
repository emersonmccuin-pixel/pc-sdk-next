// agent_contracts schema applies, contracts repo CRUD + list-by-run, and the
// agent_runs.contract_id link round-trips. Contracts carry an external PM ref
// (`pm_ref`) instead of an internal work-item FK.

import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ULID } from '@pc/domain';

const tmpDir = mkdtempSync(join(tmpdir(), 'pc-contracts-'));
process.env.PC_DATA_DIR = tmpDir;

const {
  assertSchemaIntact,
  closeDb,
  createContract,
  createProject,
  findContractByReviewRun,
  getContract,
  getRawDb,
  insertAgentRunRow,
  listContractsAwaitingIndependentReview,
  listContractsForRun,
  newId,
  runMigrations,
  setContractDeliverable,
  setContractLanding,
  setContractReviewState,
  setContractRun,
  setContractRunRecoveryVerification,
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
    'target_sha_before', 'target_sha_after', 'merge_sha',
    'landing_authorizer', 'verified_base_sha', 'landing_policy',
    'review_round', 'review_run_id',
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

test('run-recovery verification park is producer/project/version CAS with one issued-unbound window', () => {
  const p = seedProject('recovery-cas');
  const otherProject = seedProject('recovery-cas-other');
  const producerRunId = newId();
  const movedRunId = newId();
  const bound = createContract({
    projectId: p.id,
    podName: 'writer',
    expectedOutput: { kind: 'prose', doc_type: 'note' },
  });
  setContractRun(bound.id, producerRunId);
  const passed = setContractVerification(bound.id, {
    verificationStatus: 'passed',
    verificationNotes: 'newer producer evidence',
  })!;

  for (const input of [
    { expectedVersion: passed.version - 1, projectId: p.id, producerRunId },
    { expectedVersion: passed.version, projectId: otherProject.id, producerRunId },
    { expectedVersion: passed.version, projectId: p.id, producerRunId: movedRunId },
  ]) {
    assert.equal(setContractRunRecoveryVerification(bound.id, {
      ...input,
      verificationNotes: 'must not land',
      allowIssuedUnbound: true,
    }), null);
    assert.deepEqual(getContract(bound.id), passed, 'failed CAS leaves newer evidence byte-for-byte intact');
  }

  const parked = setContractRunRecoveryVerification(bound.id, {
    expectedVersion: passed.version,
    projectId: p.id,
    producerRunId,
    verificationNotes: 'producer lost at restart',
    allowIssuedUnbound: false,
  });
  assert.ok(parked);
  assert.equal(parked!.verificationStatus, 'pending');
  assert.equal(parked!.verificationNotes, 'producer lost at restart');
  assert.equal(parked!.status, 'verifying');
  assert.equal(parked!.version, passed.version + 1);

  const issued = createContract({
    projectId: p.id,
    podName: 'writer',
    expectedOutput: { kind: 'prose', doc_type: 'note' },
  });
  assert.equal(setContractRunRecoveryVerification(issued.id, {
    expectedVersion: issued.version,
    projectId: p.id,
    producerRunId,
    verificationNotes: 'not allowed without crash-window authority',
    allowIssuedUnbound: false,
  }), null);
  const unboundPark = setContractRunRecoveryVerification(issued.id, {
    expectedVersion: issued.version,
    projectId: p.id,
    producerRunId,
    verificationNotes: 'crashed before reciprocal binding',
    allowIssuedUnbound: true,
  });
  assert.ok(unboundPark);
  assert.equal(unboundPark!.agentRunId, null);
  assert.equal(unboundPark!.verificationStatus, 'pending');

  const unboundButMoved = createContract({
    projectId: p.id,
    podName: 'writer',
    expectedOutput: { kind: 'prose', doc_type: 'note' },
    status: 'submitted',
  });
  assert.equal(setContractRunRecoveryVerification(unboundButMoved.id, {
    expectedVersion: unboundButMoved.version,
    projectId: p.id,
    producerRunId,
    verificationNotes: 'must remain untouched',
    allowIssuedUnbound: true,
  }), null, 'null producer is accepted only while the contract is still issued');
});

test('merge receipt + landing policy round-trip; legacy fields keep their meaning', () => {
  const p = seedProject('receipt');
  const c0 = createContract({
    projectId: p.id,
    podName: 'code-writer',
    expectedOutput: { kind: 'repo', auto_land: true },
    landingPolicy: 'auto-merge',
    worktreeBaseSha: 'base'.padEnd(40, '0'),
  });
  assert.equal(c0.landingPolicy, 'auto-merge');
  // Receipt columns start NULL (legacy-row shape).
  assert.equal(c0.targetShaBefore, null);
  assert.equal(c0.targetShaAfter, null);
  assert.equal(c0.mergeSha, null);
  assert.equal(c0.landingAuthorizer, null);
  assert.equal(c0.verifiedBaseSha, null);

  const branchTip = 'a'.repeat(40);
  const before = 'b'.repeat(40);
  const merge = 'c'.repeat(40);
  const landed = setContractLanding(c0.id, {
    landingStatus: 'landed',
    landedBranch: 'agent-xyz',
    landedSha: branchTip,
    targetShaBefore: before,
    targetShaAfter: merge,
    mergeSha: merge,
    landingAuthorizer: 'auto',
    verifiedBaseSha: c0.worktreeBaseSha,
    landedAt: Date.now(),
    landingError: null,
  });
  assert.ok(landed);
  // landedSha keeps its branch-tip meaning; the merge commit is NEW columns.
  assert.equal(landed!.landedSha, branchTip);
  assert.equal(landed!.mergeSha, merge);
  assert.equal(landed!.targetShaBefore, before);
  assert.equal(landed!.targetShaAfter, merge);
  assert.equal(landed!.landingAuthorizer, 'auto');
  assert.equal(landed!.verifiedBaseSha, c0.worktreeBaseSha);
  assert.deepEqual(getContract(c0.id), landed);

  // A contract created without a policy stays NULL (legacy read-through).
  const legacy = createContract({ projectId: p.id, podName: 'code-writer' });
  assert.equal(legacy.landingPolicy, null);
});

test('full-review markers round-trip; awaiting-review list keys on policy + passed + unlanded', () => {
  const p = seedProject('fullreview');
  const c0 = createContract({
    projectId: p.id,
    podName: 'code-writer',
    expectedOutput: { kind: 'repo', review: 'full' },
    landingPolicy: 'full-review',
  });
  assert.equal(c0.reviewRound, null);
  assert.equal(c0.reviewRunId, null);
  // Not listed until verification passes.
  assert.equal(listContractsAwaitingIndependentReview().some((c) => c.id === c0.id), false);
  setContractVerification(c0.id, { verificationStatus: 'passed' });
  assert.equal(listContractsAwaitingIndependentReview().some((c) => c.id === c0.id), true);

  const reviewRunId = newId();
  const briefedSeal = 'a'.repeat(40);
  const marked = setContractReviewState(c0.id, { reviewRound: 1, reviewRunId, reviewSealedCommit: briefedSeal });
  assert.ok(marked);
  assert.equal(marked!.reviewRound, 1);
  assert.equal(marked!.reviewRunId, reviewRunId);
  assert.equal(marked!.reviewSealedCommit, briefedSeal, 'briefed seal rides the marker');
  assert.equal(findContractByReviewRun(reviewRunId)?.id, c0.id);

  // Clearing the marker keeps the round; the reverse lookup empties.
  const cleared = setContractReviewState(c0.id, { reviewRunId: null, reviewSealedCommit: null });
  assert.equal(cleared!.reviewRound, 1);
  assert.equal(cleared!.reviewRunId, null);
  assert.equal(cleared!.reviewSealedCommit, null);
  assert.equal(findContractByReviewRun(reviewRunId), null);

  // A landed full-review contract leaves the awaiting list.
  setContractLanding(c0.id, { landingStatus: 'landed' });
  assert.equal(listContractsAwaitingIndependentReview().some((c) => c.id === c0.id), false);
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

test('agent_runs.contract_id is frozen at stamped admission', () => {
  const p = seedProject('runlink');
  const runId = newId();
  const contractId = newId();
  insertAgentRunRow({
    id: runId,
    projectId: p.id,
    dispatcherSessionId: 's',
    specialistSnapshot: {
      specialistId: 'specialist-x' as ULID,
      revision: 'sha256:test-x',
      name: 'x',
      charter: 'Test.',
      contextDocs: [],
      maxTurns: 10,
    },
    selection: {
      runtimeId: 'runtime',
      accountId: 'account',
      model: 'model',
      effort: { kind: 'none' },
    },
    continuation: { mode: 'create' },
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

  assert.throws(
    () => raw.prepare('UPDATE agent_runs SET contract_id = NULL WHERE id = ?').run(runId),
    /agent run execution scope is immutable/,
  );
  row = raw.prepare('SELECT contract_id FROM agent_runs WHERE id = ?').get(runId) as {
    contract_id: string | null;
  };
  assert.equal(row.contract_id, contractId);
});
