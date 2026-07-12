import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type {
  ULID,
  WorktreeAbandonmentReceipt,
  WorktreeAbandonmentTeardownReceipt,
} from '@pc/domain';

const tmpDir = mkdtempSync(join(tmpdir(), 'pc-approved-abandonment-'));
process.env.PC_DATA_DIR = tmpDir;

const db = await import('../src/index.ts');

before(() => db.runMigrations());
after(() => {
  db.closeDb();
  rmSync(tmpDir, { recursive: true, force: true });
});

const repositoryIdentity = {
  protocol: 'git-common-dir-v1' as const,
  gitCommonDir: 'E:/repo/.git',
  leaseKey: `sha256:${'a'.repeat(64)}`,
};

function specialistSnapshot() {
  return {
    specialistId: db.newId() as ULID,
    revision: 'sha256:test-approved-abandonment',
    name: 'code-writer',
    charter: 'Write code.',
    contextDocs: [],
    maxTurns: 10,
  };
}

function seed(slug: string) {
  const project = db.createProject({ slug, name: slug, folderPath: '' });
  const producerRunId = db.newId() as ULID;
  const worktreePath = join(tmpDir, slug);
  const branch = `agent-${slug}`;
  const contract = db.createContract({
    projectId: project.id,
    agentRunId: producerRunId,
    podName: 'code-writer',
    expectedOutput: { kind: 'repo', auto_land: false },
    worktreePath,
    worktreeBaseBranch: 'main',
    worktreeBaseSha: 'b'.repeat(40),
  });
  db.insertAgentRunRow({
    id: producerRunId,
    projectId: project.id,
    dispatcherSessionId: `session-${slug}`,
    specialistSnapshot: specialistSnapshot(),
    selection: {
      runtimeId: 'runtime',
      accountId: 'account',
      model: 'model',
      effort: { kind: 'none' },
    },
    continuation: { mode: 'create' },
    status: 'queued',
    input: 'go',
    contractId: contract.id,
    lifecycleState: 'queued',
    queuedAt: 100,
  });
  const worktree = db.upsertWorktree({
    name: branch,
    path: worktreePath,
    projectId: project.id,
    agentRunId: producerRunId,
    contractId: contract.id,
    branch,
    baseBranch: 'main',
    baseSha: 'b'.repeat(40),
  });
  const receipt: WorktreeAbandonmentReceipt = {
    protocol: 'worktree-abandonment-v1',
    requestId: '123e4567-e89b-42d3-a456-426614174000',
    approvedBy: 'user',
    approvalSurface: 'browser',
    approvalReason: 'explicit-browser-confirmation',
    approvedAt: 200,
    reason: null,
    approvedContractVersion: contract.version,
    projectId: project.id,
    contractId: contract.id,
    producerRunId,
    worktreeId: worktree.id,
    worktreeStatus: 'active',
    repositoryIdentity,
    worktreePath,
    branch,
    branchTip: 'c'.repeat(40),
    baseBranch: 'main',
    validatedBaseSha: 'b'.repeat(40),
    targetTip: 'b'.repeat(40),
    integrationState: 'unmerged',
    worktreeState: {
      directory: 'present',
      registration: 'registered',
      status: 'clean',
      staged: 0,
      unstaged: 0,
      untracked: 0,
      worktreeStateDigest: `sha256:${'d'.repeat(64)}`,
      changedPaths: [],
      ignoredContents: 'uninspected',
    },
    previewDigest: `sha256:${'e'.repeat(64)}`,
  };
  return { project, producerRunId, contract, worktree, receipt };
}

function settle(
  authority: WorktreeAbandonmentReceipt,
  over: Partial<WorktreeAbandonmentTeardownReceipt> = {},
): WorktreeAbandonmentTeardownReceipt {
  return {
    protocol: 'worktree-abandonment-teardown-v1',
    authorityRequestId: authority.requestId,
    startedAt: 300,
    finishedAt: 400,
    repositoryIdentity: authority.repositoryIdentity,
    worktreePath: authority.worktreePath,
    branch: authority.branch,
    approvedBranchTip: authority.branchTip,
    observedBranchTip: authority.branchTip,
    directoryAbsent: true,
    registrationAbsent: true,
    branchPreserved: true,
    ...over,
  };
}

test('authority is exact, versioned, live-run fenced, immutable, and recoverable', () => {
  const { project, producerRunId, contract, worktree, receipt } = seed('authority');

  assert.equal(
    db.authorizeContractAbandonment(contract.id, { receipt }),
    null,
    'a nonterminal producer prevents destructive reservation',
  );
  assert.equal(db.markAgentRunTerminal({
    id: producerRunId,
    status: 'failed',
    result: null,
    failureCause: 'unexpected-exit',
    failureReason: 'test terminal producer',
    completedAt: 250,
    lifecycleState: 'failed',
  }), true);

  const authorized = db.authorizeContractAbandonment(contract.id, { receipt });
  assert.ok(authorized);
  assert.equal(authorized.landingStatus, 'abandoning');
  assert.deepEqual(authorized.abandonmentReceipt, receipt);
  assert.equal(authorized.version, contract.version + 1);
  assert.equal(db.authorizeContractAbandonment(contract.id, { receipt }), null);
  assert.equal(db.setContractLanding(contract.id, { landingStatus: 'abandoned' }), null);
  assert.equal(db.setContractDeliverable(contract.id, { deliverable: null }), null);
  assert.equal(db.setContractVerification(contract.id, { verificationStatus: 'passed' }), null);
  assert.deepEqual(
    db.listContractsNeedingAbandonmentRecovery().map((row) => row.id),
    [contract.id],
  );
  assert.deepEqual(db.listProtectedAbandonmentWorktreePaths(project.id), [receipt.worktreePath]);

  assert.throws(() => db.insertAgentRunRow({
    id: db.newId() as ULID,
    projectId: project.id,
    dispatcherSessionId: 'continuation-after-authority',
    specialistSnapshot: specialistSnapshot(),
    selection: {
      runtimeId: 'runtime', accountId: 'account', model: 'model', effort: { kind: 'none' },
    },
    continuation: { mode: 'create' },
    status: 'queued',
    input: null,
    continues: producerRunId,
    contractId: contract.id,
    queuedAt: 500,
  }), /contract abandonment/);

  assert.throws(
    () => db.getRawDb().prepare(
      'UPDATE agent_contracts SET abandonment_receipt = ? WHERE id = ?',
    ).run(JSON.stringify({ ...receipt, approvedAt: 201 }), contract.id),
    /authority receipt is immutable/,
  );

  assert.equal(db.markExactWorktreeDestroyed({
    id: worktree.id,
    projectId: project.id,
    agentRunId: producerRunId,
    contractId: contract.id,
    path: `${worktree.path}-wrong`,
    name: worktree.name,
    branch: worktree.branch!,
    baseBranch: worktree.baseBranch!,
    destroyedAt: 600,
  }), false);
  assert.equal(db.markExactWorktreeDestroyed({
    id: worktree.id,
    projectId: project.id,
    agentRunId: producerRunId,
    contractId: contract.id,
    path: worktree.path,
    name: worktree.name,
    branch: worktree.branch!,
    baseBranch: worktree.baseBranch!,
    destroyedAt: 600,
  }), true);
  assert.equal(db.markExactWorktreeDestroyed({
    id: worktree.id,
    projectId: project.id,
    agentRunId: producerRunId,
    contractId: contract.id,
    path: worktree.path,
    name: worktree.name,
    branch: worktree.branch!,
    baseBranch: worktree.baseBranch!,
    destroyedAt: 601,
  }), false, 'destroy settlement is one exact CAS');
});

test('error and settlement CAS preserve authority, require exact positive proof, and resolve activity', () => {
  const { project, producerRunId, contract, worktree, receipt } = seed('settlement');
  db.markAgentRunTerminal({
    id: producerRunId,
    status: 'failed',
    result: null,
    failureCause: 'unexpected-exit',
    failureReason: 'test terminal producer',
    completedAt: 250,
    lifecycleState: 'failed',
  });
  const authorized = db.authorizeContractAbandonment(contract.id, { receipt })!;

  assert.equal(db.setContractAbandonmentError(contract.id, {
    expectedVersion: authorized.version - 1,
    authorityRequestId: receipt.requestId,
    error: 'remove failed',
  }), null);
  const errored = db.setContractAbandonmentError(contract.id, {
    expectedVersion: authorized.version,
    authorityRequestId: receipt.requestId,
    error: 'remove failed',
  });
  assert.ok(errored);
  assert.deepEqual(errored.abandonmentReceipt, receipt);

  assert.equal(db.settleContractAbandonment(contract.id, {
    expectedVersion: errored.version,
    receipt: settle(receipt, { observedBranchTip: 'f'.repeat(40) }),
  }), null, 'a changed branch tip cannot settle approved destruction');
  const settlement = settle(receipt);
  assert.equal(db.settleContractAbandonment(contract.id, {
    expectedVersion: errored.version,
    receipt: settlement,
  }), null, 'a receipt cannot settle before the exact worktree row is destroyed');
  assert.equal(db.markExactWorktreeDestroyed({
    id: worktree.id,
    projectId: project.id,
    agentRunId: producerRunId,
    contractId: contract.id,
    path: worktree.path,
    name: worktree.name,
    branch: worktree.branch!,
    baseBranch: worktree.baseBranch!,
    destroyedAt: settlement.finishedAt,
  }), true);
  const settled = db.settleContractAbandonment(contract.id, {
    expectedVersion: errored.version,
    receipt: settlement,
  });
  assert.ok(settled);
  assert.equal(settled.landingStatus, 'abandoned');
  assert.deepEqual(settled.abandonmentReceipt, receipt);
  assert.deepEqual(settled.abandonmentTeardownReceipt, settlement);
  assert.equal(settled.abandonmentError, null);
  assert.equal(db.settleContractAbandonment(contract.id, {
    expectedVersion: errored.version,
    receipt: settlement,
  }), null);
  assert.equal(db.listContractsNeedingAbandonmentRecovery().some((row) => row.id === contract.id), false);
  assert.equal(db.listProtectedAbandonmentWorktreePaths(project.id).includes(receipt.worktreePath), false);
  assert.equal(db.listPreservedTerminalAgentRuns(project.id).some((run) => run.id === producerRunId), false);

  assert.throws(
    () => db.getRawDb().prepare(
      'UPDATE agent_contracts SET abandonment_teardown_receipt = ? WHERE id = ?',
    ).run(JSON.stringify({ ...settlement, finishedAt: 401 }), contract.id),
    /teardown receipt is immutable/,
  );
});

test('post-migration raw writes cannot manufacture legacy abandonment', () => {
  const project = db.createProject({ slug: 'raw-guard', name: 'raw-guard', folderPath: '' });
  const contract = db.createContract({ projectId: project.id, podName: 'writer' });
  assert.throws(
    () => db.getRawDb().prepare(
      "UPDATE agent_contracts SET landing_status = 'abandoned' WHERE id = ?",
    ).run(contract.id),
    /new abandonment requires authority and teardown receipts/,
  );
  assert.equal(db.getContract(contract.id)?.landingStatus, null);
});

test('producer continuation atomically transfers exact worktree ownership', () => {
  const { project, producerRunId, contract, worktree } = seed('producer-transfer');
  db.markAgentRunTerminal({
    id: producerRunId,
    status: 'failed',
    result: null,
    failureCause: 'unexpected-exit',
    failureReason: 'continue from terminal producer',
    completedAt: 250,
    lifecycleState: 'failed',
  });
  const continuationRunId = db.newId() as ULID;
  db.insertAgentRunRow({
    id: continuationRunId,
    projectId: project.id,
    dispatcherSessionId: 'producer-transfer-child',
    specialistSnapshot: specialistSnapshot(),
    selection: {
      runtimeId: 'runtime', accountId: 'account', model: 'model', effort: { kind: 'none' },
    },
    continuation: { mode: 'create' },
    status: 'queued',
    input: 'continue',
    contractId: contract.id,
    queuedAt: 300,
  });
  const moved = db.setContractRun(contract.id, continuationRunId);
  assert.ok(moved);
  assert.equal(moved.agentRunId, continuationRunId);
  assert.equal(db.getWorktreeById(worktree.id)?.agentRunId, continuationRunId);

  db.getRawDb().prepare('UPDATE worktrees SET agent_run_id = ? WHERE id = ?')
    .run(producerRunId, worktree.id);
  const refusedRunId = db.newId() as ULID;
  assert.equal(db.setContractRun(contract.id, refusedRunId), null);
  assert.equal(db.getContract(contract.id)?.agentRunId, continuationRunId);
});

test('landing reserve/settle is one exact producer/version/authorizer CAS', () => {
  const project = db.createProject({ slug: 'landing-cas', name: 'landing-cas', folderPath: '' });
  const producerRunId = db.newId() as ULID;
  const contract = db.createContract({
    projectId: project.id,
    agentRunId: producerRunId,
    podName: 'code-writer',
    expectedOutput: { kind: 'repo', auto_land: true },
  });
  const verified = db.setContractVerification(contract.id, { verificationStatus: 'passed' })!;

  assert.equal(db.reserveContractLanding(contract.id, {
    expectedVersion: verified.version - 1,
    expectedAgentRunId: producerRunId,
    landingAuthorizer: 'orchestrator',
  }), null);
  assert.equal(db.reserveContractLanding(contract.id, {
    expectedVersion: verified.version,
    expectedAgentRunId: db.newId() as ULID,
    landingAuthorizer: 'orchestrator',
  }), null);
  const reserved = db.reserveContractLanding(contract.id, {
    expectedVersion: verified.version,
    expectedAgentRunId: producerRunId,
    landingAuthorizer: 'orchestrator',
  });
  assert.ok(reserved);
  assert.equal(reserved.landingStatus, 'pending');
  assert.equal(reserved.landingAuthorizer, 'orchestrator');
  const childRunId = db.newId() as ULID;
  assert.throws(() => db.insertAgentRunRow({
    id: childRunId,
    projectId: project.id,
    dispatcherSessionId: 'landing-reservation-race',
    specialistSnapshot: specialistSnapshot(),
    selection: {
      runtimeId: 'runtime', accountId: 'account', model: 'model', effort: { kind: 'none' },
    },
    continuation: { mode: 'create' },
    status: 'queued',
    input: 'must lose to landing',
    contractId: contract.id,
    queuedAt: 400,
  }), /contract abandonment or landing/);
  assert.equal(
    db.setContractRun(contract.id, childRunId),
    null,
    'pending landing reservation cannot transfer producer ownership',
  );

  assert.equal(db.settleContractLanding(contract.id, {
    expectedVersion: reserved.version,
    expectedAgentRunId: producerRunId,
    landingStatus: 'landed',
    landingAuthorizer: 'user',
  }), null, 'settlement cannot replace the reservation authorizer');
  const settled = db.settleContractLanding(contract.id, {
    expectedVersion: reserved.version,
    expectedAgentRunId: producerRunId,
    landingStatus: 'landed',
    landingAuthorizer: 'orchestrator',
    landedBranch: 'agent-landing-cas',
    landedSha: 'a'.repeat(40),
    landedAt: 500,
  });
  assert.ok(settled);
  assert.equal(settled.landingStatus, 'landed');
  assert.equal(settled.landingAuthorizer, 'orchestrator');
  assert.equal(db.setContractRun(contract.id, childRunId), null);
  assert.equal(db.settleContractLanding(contract.id, {
    expectedVersion: reserved.version,
    expectedAgentRunId: producerRunId,
    landingStatus: 'failed',
  }), null);
});

test('unpublished rollback settles only its exact active row and preserves same-name history', () => {
  const project = db.createProject({ slug: 'unpublished-cas', name: 'unpublished-cas', folderPath: '' });
  const name = 'agent-shared-name';
  const historical = db.upsertWorktree({
    name,
    path: join(tmpDir, 'unpublished-history'),
    projectId: project.id,
    agentRunId: db.newId() as ULID,
    branch: name,
    baseBranch: 'main',
    baseSha: 'a'.repeat(40),
  });
  db.markWorktreeStranded(name, 'process-lost', 100);
  const producerRunId = db.newId() as ULID;
  const current = db.upsertWorktree({
    name,
    path: join(tmpDir, 'unpublished-current'),
    projectId: project.id,
    agentRunId: producerRunId,
    branch: name,
    baseBranch: 'main',
    baseSha: 'b'.repeat(40),
  });
  const exact = {
    id: current.id,
    projectId: project.id,
    agentRunId: producerRunId,
    path: current.path,
    name,
    branch: name,
    baseBranch: 'main',
    baseSha: 'b'.repeat(40),
    destroyedAt: 200,
  };
  assert.equal(db.markExactUnpublishedWorktreeDestroyed({ ...exact, id: historical.id }), false);
  assert.equal(db.markExactUnpublishedWorktreeDestroyed(exact), true);
  assert.equal(db.getWorktreeById(current.id)?.status, 'destroyed');
  assert.equal(db.getWorktreeById(current.id)?.destroyedAt, 200);
  assert.equal(db.getWorktreeById(historical.id)?.status, 'stranded');
  assert.equal(db.getWorktreeById(historical.id)?.strandedAt, 100);
});
