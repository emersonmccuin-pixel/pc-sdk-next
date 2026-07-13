import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  createNotRequiredWorktreePhaseReceipt,
  createReviewCheckoutPhaseReceipt,
  type ReviewCheckoutAuthority,
  type ReviewCheckoutGitReceipt,
  type ReviewCheckoutProvisionReceipt,
  type ReviewCheckoutTeardownReceipt,
  type ReviewCheckoutVerdictReceipt,
  type ReviewFinding,
  type ULID,
} from '@pc/domain';

const tmpDir = mkdtempSync(join(tmpdir(), 'pc-review-verdict-coordination-'));
process.env.PC_DATA_DIR = tmpDir;

const db = await import('@pc/db');
const { AgentRunMutationGateway } = await import('../src/agent-runs/index.ts');
const { ContractService } = await import('../src/contracts/index.ts');

before(() => db.runMigrations());
after(() => {
  db.closeDb();
  rmSync(tmpDir, { recursive: true, force: true });
});

const sealedCommit = 'a'.repeat(40);
const repositoryIdentity = {
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
  assert.equal(db.updateAgentRunStatus({
    id,
    status: 'spawning',
    spawnedAt: completedAt - 1,
  }), true);
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

type TerminalVerdict = 'approve' | 'reject';

interface VerdictHarness {
  authority: ReviewCheckoutAuthority;
  receipt: ReviewCheckoutVerdictReceipt;
  destroyedUpdatedAt: number;
  appliedAt: number;
}

function seedDestroyedVerdict(label: string, outcome: TerminalVerdict): VerdictHarness {
  const clock = Date.now();
  const project = db.createProject({
    slug: `${label}-${db.newId().toLowerCase()}`,
    name: label,
    folderPath: join(tmpDir, label),
  });

  const producerRunId = db.newId() as ULID;
  const target = db.createContract({
    projectId: project.id,
    agentRunId: producerRunId,
    expectedOutput: { kind: 'repo', review: 'full' },
    landingPolicy: 'full-review',
  });
  db.insertAgentRunRow(runInput({
    id: producerRunId,
    projectId: project.id,
    name: `${label}-producer`,
    contractId: target.id,
  }));
  completeQueuedRun(producerRunId, 'produced', clock + 2);
  assert.equal(db.updateAgentRunStatus({
    id: producerRunId,
    status: 'completed',
    lifecycleState: 'reviewing',
  }), true);
  assert.ok(db.setContractDeliverable(target.id, {
    deliverable: { kind: 'repo', branch: 'feature', commit: sealedCommit },
  }));
  const verified = db.setContractVerification(target.id, {
    verificationStatus: 'passed',
  });
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
    repositoryIdentity,
    worktreePath: join(tmpDir, 'reviews', reviewerRunId),
    ownedRootRealPath: join(tmpDir, 'reviews'),
    sealedCommit,
  };
  const created = db.createReviewCheckoutReservation({
    ...authority,
    createdAt: clock + 10,
  });
  assert.ok(created);
  const provisioned = db.setReviewCheckoutProvisionReceipt({
    authority,
    expectedUpdatedAt: created.updatedAt,
    receipt: provision(authority, clock + 20),
  });
  assert.ok(provisioned);

  const reviewerContract = db.createContract({
    projectId: project.id,
    expectedOutput: {
      kind: 'payload',
      semantic: 'verdict',
      schema: {
        type: 'object',
        properties: {
          verdict: { type: 'string' },
          findings: { type: 'array' },
        },
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
    gitReceipt: gitReceipt(authority, clock + 20),
  }));

  const phaseGateway = new AgentRunMutationGateway();
  const prepared = phaseGateway.commitReviewCheckoutPhaseReceipt({
    authority,
    expectedUpdatedAt: provisioned.updatedAt,
    receipt: createReviewCheckoutPhaseReceipt(
      authority,
      createNotRequiredWorktreePhaseReceipt({
        phase: 'preparation',
        reason: 'no-commands-configured',
        finishedAt: clock + 30,
      }),
    ),
  });
  assert.ok(prepared);
  const ready = phaseGateway.commitReviewCheckoutPhaseReceipt({
    authority,
    expectedUpdatedAt: prepared.checkout.updatedAt,
    receipt: createReviewCheckoutPhaseReceipt(
      authority,
      createNotRequiredWorktreePhaseReceipt({
        phase: 'readiness',
        reason: 'no-commands-configured',
        finishedAt: clock + 40,
      }),
    ),
  });
  assert.ok(ready);

  const findings: ReviewFinding[] = outcome === 'approve' ? [] : [{
    file: 'src/reviewed.ts',
    line: 17,
    summary: 'The reviewed change violates its accepted invariant.',
    severity: 'major',
  }];
  assert.ok(db.setContractDeliverable(reviewerContract.id, {
    deliverable: { kind: 'payload', data: { verdict: outcome, findings } },
  }));
  assert.ok(db.setContractVerification(reviewerContract.id, {
    verificationStatus: 'passed',
  }));
  completeQueuedRun(reviewerRunId, `${outcome} verdict`, clock + 50);

  const receipt: ReviewCheckoutVerdictReceipt = {
    protocol: 'review-checkout-verdict-v1',
    ...authority,
    reviewerContractId: reviewerContract.id,
    terminalStatus: 'completed',
    outcome,
    findings,
    recordedAt: clock + 60,
  };
  const recorded = db.setReviewCheckoutVerdictReceipt({
    authority,
    expectedUpdatedAt: ready.checkout.updatedAt,
    receipt,
  });
  assert.ok(recorded);
  const pending = db.markReviewCheckoutTeardownPending({
    authority,
    expectedUpdatedAt: recorded.updatedAt,
    fromStatus: 'provisioned',
    at: clock + 70,
    error: null,
  });
  assert.ok(pending);
  const destroyed = db.settleReviewCheckoutTeardown({
    authority,
    expectedUpdatedAt: pending.updatedAt,
    receipt: teardown(authority, clock + 80),
    destroyedAt: clock + 82,
  });
  assert.ok(destroyed);
  assert.equal(destroyed.status, 'destroyed');
  assert.equal(destroyed.verdictAppliedAt, null);
  return {
    authority,
    receipt,
    destroyedUpdatedAt: destroyed.updatedAt,
    appliedAt: clock + 90,
  };
}

function eventsAfter(harness: VerdictHarness, after: string) {
  return db.listLiveEventsAfter({
    after,
    projectId: harness.authority.projectId,
    includeGlobal: false,
  }).events;
}

for (const outcome of ['approve', 'reject'] as const) {
  test(`${outcome} closes the post-contract-effect/pre-stamp crash window in one commit`, () => {
    const h = seedDestroyedVerdict(`atomic-${outcome}`, outcome);
    const service = new ContractService();
    const producerBefore = db.getAgentRunRow(h.authority.producerRunId)!;
    const beforeOutbox = db.getLiveEventHighWater() ?? '0';

    const result = service.applyReviewCheckoutVerdict({
      receipt: h.receipt,
      expectedCheckoutUpdatedAt: h.destroyedUpdatedAt,
      appliedAt: h.appliedAt,
    });

    assert.ok(result);
    assert.equal(result.reviewRunId, null);
    assert.equal(result.reviewSealedCommit, null);
    const expectedLifecycle = outcome === 'approve' ? 'merge-ready' : 'review-rejected';
    if (outcome === 'approve') {
      assert.equal(result.status, 'accepted');
      assert.equal(result.verificationStatus, 'passed');
      assert.equal(result.landingStatus, 'pending');
      assert.equal(result.landingAuthorizer, 'reviewer');
    } else {
      assert.equal(result.status, 'rejected');
      assert.equal(result.verificationStatus, 'failed');
      assert.equal(result.landingStatus, null);
      assert.equal(result.landingAuthorizer, null);
    }

    const producer = db.getAgentRunRow(h.authority.producerRunId)!;
    assert.equal(producer.lifecycleState, expectedLifecycle);
    assert.equal(producer.rev, producerBefore.rev + 1);
    const checkout = db.getReviewCheckoutById(h.authority.id)!;
    assert.equal(checkout.verdictAppliedAt, h.appliedAt);
    assert.deepEqual(checkout.verdictReceipt, h.receipt);

    const events = eventsAfter(h, beforeOutbox);
    assert.equal(events.length, 2);
    const runEvent = events.find((event) => event.type === 'agent-run.changed');
    assert.ok(runEvent);
    assert.equal(runEvent.entity, 'agent-run');
    assert.equal(runEvent.entityId, h.authority.producerRunId);
    assert.equal(runEvent.version, producer.rev);
    assert.equal((runEvent.payload as { reason: string }).reason, 'reconciled');
    assert.equal(
      (runEvent.payload as { run: { lifecycleState: string } }).run.lifecycleState,
      expectedLifecycle,
    );
    const contractEvent = events.find((event) => event.type === 'contract.changed');
    assert.ok(contractEvent);
    assert.equal(contractEvent.entity, 'contract');
    assert.equal(contractEvent.entityId, h.authority.contractId);
    assert.equal(contractEvent.version, result.version);
    assert.equal((contractEvent.payload as { reason: string }).reason, 'patched');
    assert.deepEqual(
      (contractEvent.payload as { contract: unknown }).contract,
      result,
    );
  });
}

test('workspace verdict CAS rejection rolls back contract, lifecycle, and both outbox facts', () => {
  const h = seedDestroyedVerdict('workspace-cas-rollback', 'approve');
  const service = new ContractService();
  const targetBefore = db.getContract(h.authority.contractId)!;
  const producerBefore = db.getAgentRunRow(h.authority.producerRunId)!;
  const checkoutBefore = db.getReviewCheckoutById(h.authority.id)!;
  const beforeOutbox = db.getLiveEventHighWater();

  assert.throws(() => service.applyReviewCheckoutVerdict({
    receipt: h.receipt,
    expectedCheckoutUpdatedAt: h.destroyedUpdatedAt + 1,
    appliedAt: h.appliedAt,
  }), /review checkout verdict evidence CAS failed after contract transition/);

  assert.deepEqual(db.getContract(h.authority.contractId), targetBefore);
  assert.deepEqual(db.getAgentRunRow(h.authority.producerRunId), producerBefore);
  assert.deepEqual(db.getReviewCheckoutById(h.authority.id), checkoutBefore);
  assert.equal(db.getLiveEventHighWater(), beforeOutbox);
  assert.equal(db.getContract(h.authority.contractId)?.reviewRunId, h.authority.reviewerRunId);
  assert.equal(db.getAgentRunRow(h.authority.producerRunId)?.lifecycleState, 'reviewing');
  assert.equal(db.getReviewCheckoutById(h.authority.id)?.verdictAppliedAt, null);
});

test('producer frame refusal returns null before contract, workspace, or outbox mutation', () => {
  const h = seedDestroyedVerdict('lifecycle-cas-rollback', 'reject');
  const service = new ContractService();
  assert.equal(db.updateAgentRunStatus({
    id: h.authority.producerRunId,
    status: 'completed',
    lifecycleState: 'fixing',
  }), true, 'force the producer away from the exact reviewing CAS source');
  const targetBefore = db.getContract(h.authority.contractId)!;
  const producerBefore = db.getAgentRunRow(h.authority.producerRunId)!;
  const checkoutBefore = db.getReviewCheckoutById(h.authority.id)!;
  const beforeOutbox = db.getLiveEventHighWater();

  const result = service.applyReviewCheckoutVerdict({
    receipt: h.receipt,
    expectedCheckoutUpdatedAt: h.destroyedUpdatedAt,
    appliedAt: h.appliedAt,
  });

  assert.equal(result, null);
  assert.deepEqual(db.getContract(h.authority.contractId), targetBefore);
  assert.deepEqual(db.getAgentRunRow(h.authority.producerRunId), producerBefore);
  assert.deepEqual(db.getReviewCheckoutById(h.authority.id), checkoutBefore);
  assert.equal(db.getLiveEventHighWater(), beforeOutbox);
  assert.equal(db.getContract(h.authority.contractId)?.reviewRunId, h.authority.reviewerRunId);
  assert.equal(db.getAgentRunRow(h.authority.producerRunId)?.lifecycleState, 'fixing');
  assert.equal(db.getReviewCheckoutById(h.authority.id)?.verdictAppliedAt, null);
});

test('contract CAS refusal after stable run validation returns null before any mutation', () => {
  const h = seedDestroyedVerdict('contract-cas-refusal', 'approve');
  const service = new ContractService();
  const producerFrame = db.getAgentRunRow(h.authority.producerRunId)!;
  assert.equal(producerFrame.contractId, h.authority.contractId);
  assert.equal(producerFrame.status, 'completed');
  assert.equal(producerFrame.lifecycleState, 'reviewing');

  const staleTarget = db.setContractVerification(h.authority.contractId, {
    verificationStatus: 'passed',
    verificationNotes: 'target changed after the sealed review frame',
  });
  assert.ok(staleTarget);
  assert.notEqual(staleTarget.version, h.receipt.contractVersion);
  const targetBefore = db.getContract(h.authority.contractId)!;
  const producerBefore = db.getAgentRunRow(h.authority.producerRunId)!;
  const checkoutBefore = db.getReviewCheckoutById(h.authority.id)!;
  const beforeOutbox = db.getLiveEventHighWater();

  const result = service.applyReviewCheckoutVerdict({
    receipt: h.receipt,
    expectedCheckoutUpdatedAt: h.destroyedUpdatedAt,
    appliedAt: h.appliedAt,
  });

  assert.equal(result, null);
  assert.deepEqual(db.getContract(h.authority.contractId), targetBefore);
  assert.deepEqual(db.getAgentRunRow(h.authority.producerRunId), producerBefore);
  assert.deepEqual(db.getReviewCheckoutById(h.authority.id), checkoutBefore);
  assert.equal(db.getLiveEventHighWater(), beforeOutbox);
  assert.equal(db.getAgentRunRow(h.authority.producerRunId)?.lifecycleState, 'reviewing');
  assert.equal(db.getAgentRunRow(h.authority.producerRunId)?.rev, producerBefore.rev);
  assert.equal(db.getReviewCheckoutById(h.authority.id)?.verdictAppliedAt, null);
});
