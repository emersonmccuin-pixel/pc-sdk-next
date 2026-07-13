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
  type ULID,
} from '@pc/domain';

const tmpDir = mkdtempSync(join(tmpdir(), 'pc-agent-run-review-phase-gateway-'));
process.env.PC_DATA_DIR = tmpDir;

const db = await import('@pc/db');
const { AgentRunMutationGateway } = await import('../src/agent-runs/index.ts');

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

function completeQueuedRun(id: ULID): void {
  const now = Date.now();
  const prepared = db.prepareAgentRunCreate(id);
  assert.ok(prepared?.continuationAttemptId);
  assert.equal(db.updateAgentRunStatus({ id, status: 'spawning', spawnedAt: now }), true);
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
    result: 'produced',
    failureCause: null,
    failureReason: null,
    completedAt: now + 1,
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

interface ReviewHarness {
  authority: ReviewCheckoutAuthority;
  provisionedUpdatedAt: number;
}

function seedReview(label: string): ReviewHarness {
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
  completeQueuedRun(producerRunId);

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
    repositoryIdentity,
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
  return { authority, provisionedUpdatedAt: provisioned.updatedAt };
}

test('review phase gateway rolls back run evidence and outbox when checkout CAS fails', () => {
  const h = seedReview('phase-cas-rollback');
  const gateway = new AgentRunMutationGateway();
  const beforeRun = db.getAgentRunRow(h.authority.reviewerRunId)!;
  const beforeOutbox = db.getLiveEventHighWater();
  const evidence = createNotRequiredWorktreePhaseReceipt({
    phase: 'preparation',
    reason: 'no-commands-configured',
    finishedAt: 120,
  });

  assert.throws(() => gateway.commitReviewCheckoutPhaseReceipt({
    authority: h.authority,
    expectedUpdatedAt: h.provisionedUpdatedAt + 1,
    receipt: createReviewCheckoutPhaseReceipt(h.authority, evidence),
  }), /checkout phase CAS failed/);

  const afterRun = db.getAgentRunRow(h.authority.reviewerRunId)!;
  const afterCheckout = db.getReviewCheckoutById(h.authority.id)!;
  assert.equal(afterRun.preparationReceipt, null);
  assert.equal(afterRun.rev, beforeRun.rev);
  assert.equal(afterCheckout.preparationReceipt, null);
  assert.equal(afterCheckout.updatedAt, h.provisionedUpdatedAt);
  assert.equal(db.getLiveEventHighWater(), beforeOutbox);
});

test('review phase gateway commits both receipts with one matching agent-run event', () => {
  const h = seedReview('phase-event');
  const gateway = new AgentRunMutationGateway();
  const beforeRun = db.getAgentRunRow(h.authority.reviewerRunId)!;
  const beforeOutbox = db.getLiveEventHighWater() ?? '0';
  const evidence = createNotRequiredWorktreePhaseReceipt({
    phase: 'preparation',
    reason: 'no-commands-configured',
    finishedAt: 220,
  });
  const receipt = createReviewCheckoutPhaseReceipt(h.authority, evidence);

  const publication = gateway.commitReviewCheckoutPhaseReceipt({
    authority: h.authority,
    expectedUpdatedAt: h.provisionedUpdatedAt,
    receipt,
  });

  assert.ok(publication);
  assert.equal(publication.run.rev, beforeRun.rev + 1);
  assert.deepEqual(publication.run.preparationReceipt, evidence);
  assert.deepEqual(publication.checkout.preparationReceipt, receipt);
  assert.equal(reviewCheckoutPhaseMatchesRun(
    publication.checkout,
    publication.checkout.preparationReceipt,
    db.getAgentRunRow(h.authority.reviewerRunId)?.preparationReceipt ?? null,
    'preparation',
  ), true);

  const events = db.listLiveEventsAfter({
    after: beforeOutbox,
    projectId: h.authority.projectId,
    includeGlobal: false,
  }).events;
  assert.equal(events.length, 1);
  assert.equal(events[0]!.type, 'agent-run.changed');
  assert.equal(events[0]!.entity, 'agent-run');
  assert.equal(events[0]!.entityId, h.authority.reviewerRunId);
  assert.equal(events[0]!.version, publication.run.rev);
  assert.equal((events[0]!.payload as { reason: string }).reason, 'reconciled');
  assert.deepEqual(
    (events[0]!.payload as { run: { preparationReceipt: unknown } }).run.preparationReceipt,
    evidence,
  );
});

function seedMergeReadyRun(label: string) {
  const project = db.createProject({
    slug: `${label}-${db.newId().toLowerCase()}`,
    name: label,
    folderPath: join(tmpDir, label),
  });
  const runId = db.newId() as ULID;
  db.insertAgentRunRow(runInput({
    id: runId,
    projectId: project.id,
    name: `${label}-producer`,
    contractId: null,
  }));
  completeQueuedRun(runId);
  assert.equal(db.updateAgentRunStatus({
    id: runId,
    status: 'completed',
    lifecycleState: 'merge-ready',
  }), true);
  return { projectId: project.id, runId };
}

test('lifecycle gateway commits exact merge-ready to reviewing row, rev, and outbox fact', () => {
  const seeded = seedMergeReadyRun('lifecycle-reviewing');
  const gateway = new AgentRunMutationGateway();
  const beforeRun = db.getAgentRunRow(seeded.runId)!;
  const beforeOutbox = db.getLiveEventHighWater() ?? '0';

  const publication = gateway.commitLifecycleTransition({
    runId: seeded.runId,
    expectedFrom: 'merge-ready',
    to: 'reviewing',
  });

  assert.ok(publication);
  assert.equal(publication.run.lifecycleState, 'reviewing');
  assert.equal(publication.run.rev, beforeRun.rev + 1);
  const persisted = db.getAgentRunRow(seeded.runId)!;
  assert.equal(persisted.lifecycleState, 'reviewing');
  assert.equal(persisted.rev, beforeRun.rev + 1);
  const events = db.listLiveEventsAfter({
    after: beforeOutbox,
    projectId: seeded.projectId,
    includeGlobal: false,
  }).events;
  assert.equal(events.length, 1);
  assert.equal(events[0]!.type, 'agent-run.changed');
  assert.equal(events[0]!.entity, 'agent-run');
  assert.equal(events[0]!.entityId, seeded.runId);
  assert.equal(events[0]!.version, persisted.rev);
  assert.equal((events[0]!.payload as { reason: string }).reason, 'reconciled');
  assert.equal(
    (events[0]!.payload as { run: { lifecycleState: string } }).run.lifecycleState,
    'reviewing',
  );
});

test('lifecycle gateway rolls back merge-ready to reviewing when its outbox fact fails', () => {
  const seeded = seedMergeReadyRun('lifecycle-reviewing-rollback');
  const beforeRun = db.getAgentRunRow(seeded.runId)!;
  const beforeOutbox = db.getLiveEventHighWater();
  const gateway = new AgentRunMutationGateway({
    insertLiveEvent: (() => {
      throw new Error('forced lifecycle outbox failure');
    }) as typeof db.insertLiveEvent,
  });

  assert.throws(() => gateway.commitLifecycleTransition({
    runId: seeded.runId,
    expectedFrom: 'merge-ready',
    to: 'reviewing',
  }), /forced lifecycle outbox failure/);

  assert.deepEqual(db.getAgentRunRow(seeded.runId), beforeRun);
  assert.equal(db.getLiveEventHighWater(), beforeOutbox);
});
