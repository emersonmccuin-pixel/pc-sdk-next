import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  createNotRequiredWorktreePhaseReceipt,
  isReviewCheckoutRuntimeReady,
  type ReviewCheckoutAuthority,
  type ReviewCheckoutGitReceipt,
  type ReviewCheckoutProvisionReceipt,
  type ReviewCheckoutTeardownReceipt,
  type ULID,
} from '@pc/domain';

const tmpDir = mkdtempSync(join(tmpdir(), 'pc-review-checkouts-'));
process.env.PC_DATA_DIR = tmpDir;
const db = await import('../src/index.ts');

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

function reserve(slug: string): ReviewCheckoutAuthority {
  const project = db.createProject({ slug, name: slug, folderPath: join(tmpDir, slug) });
  const producerRunId = db.newId() as ULID;
  const reviewerRunId = db.newId() as ULID;
  const contract = db.createContract({
    projectId: project.id,
    agentRunId: producerRunId,
    expectedOutput: { kind: 'repo', review: 'full' },
    landingPolicy: 'full-review',
  });
  const verified = db.setContractVerification(contract.id, {
    verificationStatus: 'passed',
  });
  assert.ok(verified);
  const reserved = db.reserveContractReview(contract.id, {
    expectedVersion: verified.version,
    expectedReviewRunId: null,
    expectedAgentRunId: producerRunId,
    reviewRound: 1,
    reviewRunId: reviewerRunId,
    reviewSealedCommit: sealedCommit,
  });
  assert.ok(reserved);
  return {
    id: db.newId() as ULID,
    projectId: project.id,
    contractId: contract.id,
    contractVersion: reserved.version,
    producerRunId,
    reviewerRunId,
    repositoryIdentity: identity,
    worktreePath: join(tmpDir, 'review-worktrees', reviewerRunId),
    ownedRootRealPath: join(tmpDir, 'review-worktrees'),
    sealedCommit,
  };
}

function provision(authority: ReviewCheckoutAuthority, observedAt: number): ReviewCheckoutProvisionReceipt {
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

function teardown(authority: ReviewCheckoutAuthority, startedAt: number): ReviewCheckoutTeardownReceipt {
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

function reviewerGitReceipt(
  authority: ReviewCheckoutAuthority,
  observedAt: number,
): ReviewCheckoutGitReceipt {
  return {
    ...authority,
    protocol: 'review-checkout-git-v1',
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

function reviewerSnapshot() {
  return {
    specialistId: db.newId() as ULID,
    revision: 'sha256:review-checkout',
    name: 'reviewer',
    charter: 'Review.',
    contextDocs: [],
    maxTurns: 10,
  };
}

test('exact review checkout reservation gates provision, phases, recovery, and settlement', () => {
  const authority = reserve(`review-${db.newId().toLowerCase()}`);
  const created = db.createReviewCheckoutReservation({ ...authority, createdAt: 100 });
  assert.ok(created);
  assert.equal(created.status, 'reserved');
  assert.equal(db.getReviewCheckoutForReviewer(authority.reviewerRunId)?.id, authority.id);
  assert.equal(db.getCurrentReviewCheckoutForContract(authority.contractId)?.id, authority.id);
  assert.deepEqual(db.listReviewCheckoutsNeedingRecovery().map((row) => row.id), [authority.id]);

  assert.equal(db.createReviewCheckoutReservation({
    ...authority,
    id: db.newId() as ULID,
    reviewerRunId: db.newId() as ULID,
    createdAt: 101,
  }), null, 'one unresolved checkout owns the contract');

  assert.equal(db.setReviewCheckoutProvisionReceipt({
    authority,
    expectedUpdatedAt: created.updatedAt,
    receipt: { ...provision(authority, 110), headSha: 'c'.repeat(40) },
  }), null, 'moved HEAD is not provision authority');

  const provisioned = db.setReviewCheckoutProvisionReceipt({
    authority,
    expectedUpdatedAt: created.updatedAt,
    receipt: provision(authority, 110),
  });
  assert.ok(provisioned);
  assert.equal(provisioned.status, 'provisioned');

  const reviewContract = db.createContract({
    projectId: authority.projectId,
    expectedOutput: { kind: 'payload', semantic: 'verdict', schema: { type: 'object' } },
  });
  const runInput = {
    id: authority.reviewerRunId,
    projectId: authority.projectId,
    dispatcherSessionId: 'review-dispatch',
    specialistSnapshot: reviewerSnapshot(),
    selection: {
      runtimeId: 'runtime', accountId: 'account', model: 'model',
      effort: { kind: 'none' as const },
    },
    continuation: { mode: 'create' as const },
    status: 'queued' as const,
    input: 'review',
    contractId: reviewContract.id,
    worktreeDir: authority.worktreePath,
    worktreeBaseBranch: '(detached)',
    worktreeBaseSha: authority.sealedCommit,
    queuedAt: 115,
  };
  assert.throws(() => db.insertAgentRunRow({
    ...runInput,
    gitReceipt: {
      ...reviewerGitReceipt(authority, 110),
      providerSessionId: 'native-leak',
    } as ReviewCheckoutGitReceipt,
  }), /exact detached-review authority/);
  assert.doesNotThrow(() => db.insertAgentRunRow({
    ...runInput,
    gitReceipt: reviewerGitReceipt(authority, 110),
  }));
  assert.deepEqual(
    db.getAgentRunRow(authority.reviewerRunId)?.gitReceipt,
    reviewerGitReceipt(authority, 110),
  );

  const preparation = createNotRequiredWorktreePhaseReceipt({
    phase: 'preparation', reason: 'no-commands-configured', finishedAt: 120,
  });
  const prepared = db.setReviewCheckoutPhaseReceipt({
    authority,
    expectedUpdatedAt: provisioned.updatedAt,
    receipt: preparation,
  });
  assert.ok(prepared);
  assert.equal(isReviewCheckoutRuntimeReady(prepared), false);

  const readiness = createNotRequiredWorktreePhaseReceipt({
    phase: 'readiness', reason: 'no-commands-configured', finishedAt: 130,
  });
  assert.equal(db.setReviewCheckoutPhaseReceipt({
    authority,
    expectedUpdatedAt: provisioned.updatedAt,
    receipt: readiness,
  }), null, 'stale CAS cannot write readiness');
  const ready = db.setReviewCheckoutPhaseReceipt({
    authority,
    expectedUpdatedAt: prepared.updatedAt,
    receipt: readiness,
  });
  assert.ok(ready);
  assert.equal(isReviewCheckoutRuntimeReady(ready), true);

  const pending = db.markReviewCheckoutTeardownPending({
    authority,
    expectedUpdatedAt: ready.updatedAt,
    fromStatus: 'provisioned',
    at: 140,
    error: null,
  });
  assert.ok(pending);
  assert.equal(isReviewCheckoutRuntimeReady(pending), false);

  const failedCleanup = db.setReviewCheckoutCleanupError({
    authority,
    expectedUpdatedAt: pending.updatedAt,
    error: 'registration is locked',
    at: 150,
  });
  assert.ok(failedCleanup);
  assert.equal(failedCleanup.cleanupError, 'registration is locked');
  assert.equal(db.listReviewCheckoutsNeedingRecovery().some((row) => row.id === authority.id), true);

  assert.equal(db.settleReviewCheckoutTeardown({
    authority,
    expectedUpdatedAt: failedCleanup.updatedAt,
    receipt: { ...teardown(authority, 160), registrationAbsent: false as never },
    destroyedAt: 170,
  }), null, 'negative absence evidence cannot settle');
  const destroyed = db.settleReviewCheckoutTeardown({
    authority,
    expectedUpdatedAt: failedCleanup.updatedAt,
    receipt: teardown(authority, 160),
    destroyedAt: 170,
  });
  assert.ok(destroyed);
  assert.equal(destroyed.status, 'destroyed');
  assert.equal(destroyed.cleanupError, null);
  assert.equal(db.getCurrentReviewCheckoutForContract(authority.contractId), null);
  assert.equal(db.listReviewCheckoutsNeedingRecovery().some((row) => row.id === authority.id), false);

  const raw = db.getRawDb();
  assert.throws(
    () => raw.prepare('UPDATE review_checkouts SET worktree_path = ? WHERE id = ?')
      .run(`${authority.worktreePath}-retargeted`, authority.id),
    /authority is immutable/,
  );
  assert.throws(
    () => raw.prepare("UPDATE review_checkouts SET status = 'teardown-pending' WHERE id = ?")
      .run(authority.id),
    /invalid review checkout state transition/,
  );
  assert.throws(
    () => raw.prepare('DELETE FROM review_checkouts WHERE id = ?').run(authority.id),
    /append-only/,
  );
});

test('failed preparation is durable but cannot authorize readiness or runtime mint', () => {
  const authority = reserve(`failed-${db.newId().toLowerCase()}`);
  const created = db.createReviewCheckoutReservation({ ...authority, createdAt: 200 });
  assert.ok(created);
  const provisioned = db.setReviewCheckoutProvisionReceipt({
    authority,
    expectedUpdatedAt: created.updatedAt,
    receipt: provision(authority, 210),
  });
  assert.ok(provisioned);
  const failed = db.setReviewCheckoutPhaseReceipt({
    authority,
    expectedUpdatedAt: provisioned.updatedAt,
    receipt: {
      phase: 'preparation', outcome: 'executed', ok: false,
      steps: [{
        command: 'setup', exitCode: 1, durationMs: 1,
        stdoutTail: '', stderrTail: 'failed', timedOut: false,
      }],
      finishedAt: 220,
    },
  });
  assert.ok(failed);
  assert.equal(failed.preparationReceipt?.ok, false);
  assert.equal(isReviewCheckoutRuntimeReady(failed), false);
  assert.equal(db.setReviewCheckoutPhaseReceipt({
    authority,
    expectedUpdatedAt: failed.updatedAt,
    receipt: createNotRequiredWorktreePhaseReceipt({
      phase: 'readiness', reason: 'no-commands-configured', finishedAt: 230,
    }),
  }), null);
});
