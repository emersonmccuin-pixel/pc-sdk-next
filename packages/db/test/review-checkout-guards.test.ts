import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  createNotRequiredWorktreePhaseReceipt,
  createReviewCheckoutPhaseReceipt,
  reviewCheckoutPhaseMatchesRun,
  type ReviewCheckoutAuthority,
  type ReviewCheckoutGitReceipt,
  type ReviewCheckoutProvisionReceipt,
  type ReviewCheckoutTeardownReceipt,
  type ReviewCheckoutVerdictReceipt,
  type ULID,
  type WorktreePhaseReceipt,
} from '@pc/domain';

const tmpDir = mkdtempSync(join(tmpdir(), 'pc-review-checkout-guards-'));
process.env.PC_DATA_DIR = tmpDir;
const db = await import('../src/index.ts');
const { getDb } = await import('../src/connection.ts');

before(() => db.runMigrations());
after(() => {
  db.closeDb();
  rmSync(tmpDir, { recursive: true, force: true });
});

const sealedCommit = 'a'.repeat(40);
const identity = {
  protocol: 'git-common-dir-v1' as const,
  gitCommonDir: 'E:/repo/.git',
  leaseKey: `sha256:${'b'.repeat(64)}`,
};

function snapshot(name: string) {
  return {
    specialistId: db.newId() as ULID,
    revision: `sha256:${name}`,
    name,
    charter: `${name} charter`,
    contextDocs: [],
    maxTurns: 10,
  };
}

function runInput(input: {
  id: ULID;
  projectId: ULID;
  name: string;
  contractId: ULID | null;
  worktreeDir?: string | null;
  worktreeBaseBranch?: string | null;
  worktreeBaseSha?: string | null;
  gitReceipt?: ReviewCheckoutGitReceipt | null;
}) {
  return {
    id: input.id,
    projectId: input.projectId,
    dispatcherSessionId: `dispatch-${input.name}`,
    specialistSnapshot: snapshot(input.name),
    selection: {
      runtimeId: 'runtime', accountId: 'account', model: 'model',
      effort: { kind: 'none' as const },
    },
    continuation: { mode: 'create' as const },
    status: 'queued' as const,
    input: input.name,
    contractId: input.contractId,
    worktreeDir: input.worktreeDir ?? null,
    worktreeBaseBranch: input.worktreeBaseBranch ?? null,
    worktreeBaseSha: input.worktreeBaseSha ?? null,
    gitReceipt: input.gitReceipt ?? null,
    queuedAt: Date.now(),
  };
}

function completeQueuedRun(id: ULID, result: string, completedAt: number): void {
  const prepared = db.prepareAgentRunCreate(id);
  assert.ok(prepared?.continuationAttemptId);
  assert.equal(db.updateAgentRunStatus({ id, status: 'spawning', spawnedAt: completedAt - 1 }), true);
  const current = db.getAgentRunRow(id)!;
  const selection = db.runtimeSelectionForAgentRun(current);
  assert.ok(selection);
  assert.equal(db.confirmAgentRunRuntimeSessionReceipt({
    runId: id,
    receipt: {
      mode: 'created',
      selection,
      continuationAttemptId: prepared.continuationAttemptId,
      nativeSessionId: `native-${id}`,
      requestedNativeSessionId: null,
    },
  }).status, 'confirmed');
  assert.equal(db.markAgentRunTerminal({
    id,
    status: 'completed',
    result,
    failureCause: null,
    failureReason: null,
    completedAt,
  }), true);
}

function provision(
  authority: ReviewCheckoutAuthority,
  observedAt: number,
): ReviewCheckoutProvisionReceipt {
  return {
    protocol: 'review-checkout-provision-v1',
    ...authority,
    registrationCount: 1,
    registrationPath: authority.worktreePath,
    headSha: authority.sealedCommit,
    detachedHead: true,
    trackedChanges: 0,
    stagedChanges: 0,
    observedAt,
  };
}

function gitReceipt(
  authority: ReviewCheckoutAuthority,
  observedAt: number,
): ReviewCheckoutGitReceipt {
  return {
    protocol: 'review-checkout-git-v1',
    ...authority,
    branch: '(detached)',
    baseBranch: '(detached)',
    baseSha: authority.sealedCommit,
    cleanStatus: true,
    registrationCount: 1,
    registrationPath: authority.worktreePath,
    headSha: authority.sealedCommit,
    detachedHead: true,
    trackedChanges: 0,
    stagedChanges: 0,
    observedAt,
  };
}

function teardown(
  authority: ReviewCheckoutAuthority,
  startedAt: number,
): ReviewCheckoutTeardownReceipt {
  return {
    protocol: 'review-checkout-teardown-v1',
    ...authority,
    startedAt,
    finishedAt: startedAt + 1,
    directoryAbsent: true,
    registrationAbsent: true,
    branchDeletion: 'not-applicable-detached',
  };
}

interface Harness {
  authority: ReviewCheckoutAuthority;
  reviewerContractId: ULID;
  provisionedUpdatedAt: number;
}

function harness(label: string): Harness {
  const project = db.createProject({
    slug: `${label}-${db.newId().toLowerCase()}`,
    name: label,
    folderPath: join(tmpDir, label),
  });
  const producerRunId = db.newId() as ULID;
  db.insertAgentRunRow(runInput({
    id: producerRunId,
    projectId: project.id,
    name: `${label}-producer`,
    contractId: null,
  }));
  completeQueuedRun(producerRunId, 'produced', Date.now());

  const target = db.createContract({
    projectId: project.id,
    agentRunId: producerRunId,
    expectedOutput: { kind: 'repo', review: 'full' },
    landingPolicy: 'full-review',
  });
  assert.ok(db.setContractDeliverable(target.id, {
    deliverable: { kind: 'repo', branch: 'feature', commit: sealedCommit },
  }));
  const verified = db.setContractVerification(target.id, { verificationStatus: 'passed' });
  assert.ok(verified);

  const reviewerRunId = db.newId() as ULID;
  const reserved = db.reserveContractReview(target.id, {
    expectedVersion: verified.version,
    expectedReviewRunId: null,
    expectedAgentRunId: producerRunId,
    reviewRound: 1,
    reviewRunId: reviewerRunId,
    reviewSealedCommit: sealedCommit,
  });
  assert.ok(reserved);
  const authority: ReviewCheckoutAuthority = {
    id: db.newId() as ULID,
    projectId: project.id,
    contractId: target.id,
    contractVersion: reserved.version,
    producerRunId,
    reviewerRunId,
    repositoryIdentity: identity,
    worktreePath: join(tmpDir, 'reviews', reviewerRunId),
    ownedRootRealPath: join(tmpDir, 'reviews'),
    sealedCommit,
  };
  const created = db.createReviewCheckoutReservation({ ...authority, createdAt: 100 });
  assert.ok(created);
  const provisioned = db.setReviewCheckoutProvisionReceipt({
    authority,
    expectedUpdatedAt: created.updatedAt,
    receipt: provision(authority, 110),
  });
  assert.ok(provisioned);

  const reviewerContract = db.createContract({
    projectId: project.id,
    expectedOutput: {
      kind: 'payload', semantic: 'verdict',
      schema: {
        type: 'object',
        properties: { verdict: { type: 'string' }, findings: { type: 'array' } },
        required: ['verdict', 'findings'],
      },
    },
  });
  db.insertAgentRunRow(runInput({
    id: reviewerRunId,
    projectId: project.id,
    name: `${label}-reviewer`,
    contractId: reviewerContract.id,
    worktreeDir: authority.worktreePath,
    worktreeBaseBranch: '(detached)',
    worktreeBaseSha: authority.sealedCommit,
    gitReceipt: gitReceipt(authority, 110),
  }));
  return {
    authority,
    reviewerContractId: reviewerContract.id,
    provisionedUpdatedAt: provisioned.updatedAt,
  };
}

function noCommands(
  phase: 'preparation' | 'readiness',
  finishedAt: number,
): WorktreePhaseReceipt {
  return createNotRequiredWorktreePhaseReceipt({
    phase,
    reason: 'no-commands-configured',
    finishedAt,
  });
}

test('phase persistence rejects wrong authority and closed-shape/raw SQL substitutions', () => {
  const wrongHarness = harness('wrong-authority');
  const wrongAuthority = {
    ...wrongHarness.authority,
    reviewerRunId: db.newId() as ULID,
  };
  assert.equal(db.setReviewCheckoutRunPhaseReceipt({
    authority: wrongAuthority,
    expectedUpdatedAt: wrongHarness.provisionedUpdatedAt,
    receipt: createReviewCheckoutPhaseReceipt(wrongAuthority, noCommands('preparation', 120)),
  }), null);
  assert.equal(db.getAgentRunRow(wrongHarness.authority.reviewerRunId)?.preparationReceipt, null);
  assert.equal(db.getReviewCheckoutById(wrongHarness.authority.id)?.preparationReceipt, null);

  const exactReceipt = createReviewCheckoutPhaseReceipt(
    wrongHarness.authority,
    noCommands('preparation', 121),
  );
  assert.equal(db.setReviewCheckoutRunPhaseReceipt({
    authority: wrongHarness.authority,
    expectedUpdatedAt: wrongHarness.provisionedUpdatedAt,
    receipt: { ...exactReceipt, providerReceipt: 'native-leak' } as never,
  }), null);

  const rawHarness = harness('raw-phase');
  const raw = db.getRawDb();
  const preparation = noCommands('preparation', 130);
  assert.equal(raw.prepare(
    'UPDATE agent_runs SET preparation_receipt = ? WHERE id = ?',
  ).run(JSON.stringify(preparation), rawHarness.authority.reviewerRunId).changes, 1);

  const canonical = createReviewCheckoutPhaseReceipt(rawHarness.authority, preparation);
  for (const hostile of [
    preparation,
    { ...canonical, contractVersion: canonical.contractVersion + 1 },
    { ...canonical, evidence: { ...preparation, phase: 'readiness' } },
    { ...canonical, providerReceipt: 'native-leak' },
  ]) {
    assert.throws(
      () => raw.prepare(
        'UPDATE review_checkouts SET preparation_receipt = ? WHERE id = ?',
      ).run(JSON.stringify(hostile), rawHarness.authority.id),
      /invalid checkout-bound review preparation receipt/,
    );
  }
  assert.equal(db.getReviewCheckoutById(rawHarness.authority.id)?.preparationReceipt, null);
});

test('review phase writes roll back both copies on failure and persist exact equality', () => {
  const h = harness('atomic-phase');
  const preparation = noCommands('preparation', 200);
  const preparationReceipt = createReviewCheckoutPhaseReceipt(h.authority, preparation);
  const beforeRun = db.getAgentRunRow(h.authority.reviewerRunId)!;
  const raw = db.getRawDb();
  raw.exec(`
    CREATE TRIGGER dl004_test_reject_workspace_phase
    BEFORE UPDATE OF preparation_receipt ON review_checkouts
    BEGIN
      SELECT RAISE(ABORT, 'forced workspace phase rejection');
    END;
  `);
  try {
    assert.throws(() => db.setReviewCheckoutRunPhaseReceipt({
      authority: h.authority,
      expectedUpdatedAt: h.provisionedUpdatedAt,
      receipt: preparationReceipt,
    }), /forced workspace phase rejection/);
  } finally {
    raw.exec('DROP TRIGGER dl004_test_reject_workspace_phase');
  }
  const rolledBackRun = db.getAgentRunRow(h.authority.reviewerRunId)!;
  const rolledBackCheckout = db.getReviewCheckoutById(h.authority.id)!;
  assert.equal(rolledBackRun.preparationReceipt, null);
  assert.equal(rolledBackRun.rev, beforeRun.rev, 'the run rev rolls back with its receipt');
  assert.equal(rolledBackCheckout.preparationReceipt, null);
  assert.equal(rolledBackCheckout.updatedAt, h.provisionedUpdatedAt);

  const prepared = db.setReviewCheckoutRunPhaseReceipt({
    authority: h.authority,
    expectedUpdatedAt: h.provisionedUpdatedAt,
    receipt: preparationReceipt,
  });
  assert.ok(prepared);
  const preparedRun = db.getAgentRunRow(h.authority.reviewerRunId)!;
  assert.equal(reviewCheckoutPhaseMatchesRun(
    prepared,
    prepared.preparationReceipt,
    preparedRun.preparationReceipt,
    'preparation',
  ), true);
  assert.deepEqual(preparedRun.preparationReceipt, preparation);

  assert.throws(
    () => raw.prepare(
      'UPDATE agent_runs SET preparation_receipt = NULL WHERE id = ?',
    ).run(h.authority.reviewerRunId),
    /reviewer preparation evidence is immutable once checkout-bound/,
  );

  const readiness = noCommands('readiness', 210);
  const ready = db.setReviewCheckoutRunPhaseReceipt({
    authority: h.authority,
    expectedUpdatedAt: prepared.updatedAt,
    receipt: createReviewCheckoutPhaseReceipt(h.authority, readiness),
  });
  assert.ok(ready);
  const readyRun = db.getAgentRunRow(h.authority.reviewerRunId)!;
  assert.equal(reviewCheckoutPhaseMatchesRun(
    ready,
    ready.readinessReceipt,
    readyRun.readinessReceipt,
    'readiness',
  ), true);
  assert.deepEqual(readyRun.readinessReceipt, readiness);
});

test('verdict effect is recoverable only after teardown and settles atomically once', () => {
  const h = harness('verdict-recovery');
  const prepared = db.setReviewCheckoutRunPhaseReceipt({
    authority: h.authority,
    expectedUpdatedAt: h.provisionedUpdatedAt,
    receipt: createReviewCheckoutPhaseReceipt(h.authority, noCommands('preparation', 300)),
  });
  assert.ok(prepared);
  const ready = db.setReviewCheckoutRunPhaseReceipt({
    authority: h.authority,
    expectedUpdatedAt: prepared.updatedAt,
    receipt: createReviewCheckoutPhaseReceipt(h.authority, noCommands('readiness', 310)),
  });
  assert.ok(ready);

  assert.ok(db.setContractDeliverable(h.reviewerContractId, {
    deliverable: { kind: 'payload', data: { verdict: 'approve', findings: [] } },
  }));
  assert.ok(db.setContractVerification(h.reviewerContractId, {
    verificationStatus: 'passed',
  }));
  completeQueuedRun(h.authority.reviewerRunId, 'approved', 320);

  const verdict: ReviewCheckoutVerdictReceipt = {
    protocol: 'review-checkout-verdict-v1',
    ...h.authority,
    reviewerContractId: h.reviewerContractId,
    terminalStatus: 'completed',
    outcome: 'approve',
    findings: [],
    recordedAt: 330,
  };
  const recorded = db.setReviewCheckoutVerdictReceipt({
    authority: h.authority,
    expectedUpdatedAt: ready.updatedAt,
    receipt: verdict,
  });
  assert.ok(recorded);

  const applyInTransaction = (expectedCheckoutUpdatedAt: number, appliedAt: number) =>
    getDb().transaction((tx) => db.applyReviewCheckoutVerdict({
      receipt: verdict,
      expectedCheckoutUpdatedAt,
      appliedAt,
    }, tx));

  assert.equal(applyInTransaction(recorded.updatedAt, 340), null, 'teardown is mandatory');
  assert.equal(db.getContract(h.authority.contractId)?.reviewRunId, h.authority.reviewerRunId);
  assert.equal(db.getReviewCheckoutById(h.authority.id)?.verdictAppliedAt, null);

  const pending = db.markReviewCheckoutTeardownPending({
    authority: h.authority,
    expectedUpdatedAt: recorded.updatedAt,
    fromStatus: 'provisioned',
    at: 350,
    error: null,
  });
  assert.ok(pending);
  const destroyed = db.settleReviewCheckoutTeardown({
    authority: h.authority,
    expectedUpdatedAt: pending.updatedAt,
    receipt: teardown(h.authority, 360),
    destroyedAt: 370,
  });
  assert.ok(destroyed);
  assert.equal(
    db.listReviewCheckoutsNeedingRecovery().some((row) => row.id === h.authority.id),
    true,
    'destroyed-but-unapplied verdict remains a recovery feeder',
  );
  assert.equal(applyInTransaction(destroyed.updatedAt - 1, 380), null, 'stale checkout CAS refuses');

  assert.throws(
    () => db.getRawDb().prepare(
      'UPDATE review_checkouts SET verdict_applied_at = ? WHERE id = ?',
    ).run(380, h.authority.id),
    /review verdict effect requires positive teardown and atomic marker settlement/,
  );

  const targetBefore = db.getContract(h.authority.contractId)!;
  const raw = db.getRawDb();
  raw.exec(`
    CREATE TRIGGER dl004_test_reject_verdict_apply
    BEFORE UPDATE OF verdict_applied_at ON review_checkouts
    BEGIN
      SELECT RAISE(ABORT, 'forced verdict evidence rejection');
    END;
  `);
  try {
    assert.throws(
      () => applyInTransaction(destroyed.updatedAt, 380),
      /forced verdict evidence rejection/,
    );
  } finally {
    raw.exec('DROP TRIGGER dl004_test_reject_verdict_apply');
  }
  assert.deepEqual(
    db.getContract(h.authority.contractId),
    targetBefore,
    'contract marker and landing reservation roll back with evidence CAS',
  );
  assert.equal(db.getReviewCheckoutById(h.authority.id)?.verdictAppliedAt, null);

  const applied = applyInTransaction(destroyed.updatedAt, 380);
  assert.ok(applied);
  assert.equal(applied.reviewRunId, null);
  assert.equal(applied.reviewSealedCommit, null);
  assert.equal(applied.landingStatus, 'pending');
  assert.equal(applied.landingAuthorizer, 'reviewer');
  assert.equal(db.getReviewCheckoutById(h.authority.id)?.verdictAppliedAt, 380);
  assert.equal(
    db.listReviewCheckoutsNeedingRecovery().some((row) => row.id === h.authority.id),
    false,
  );
  assert.equal(applyInTransaction(destroyed.updatedAt, 381), null, 'verdict application is first-write');
});
