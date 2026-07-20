import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Contract } from '@pc/contracts';
import {
  createContract,
  createReviewCheckoutReservation,
  getAgentRunRow,
  getContract,
  getDb,
  getPendingAsk,
  getRawDb,
  getReviewCheckoutForReviewer,
  insertAgentRunRow,
  listContractsForProject,
  listReviewCheckoutBlockingCandidates,
  listReviewCheckoutsNeedingRecovery,
  markAgentRunTerminal,
  markReviewCheckoutTeardownPending,
  newId,
  setContractDeliverable,
  setContractReviewState,
  setContractRun,
  setContractVerification,
  setReviewAgentRunPhaseReceiptInDb,
  setReviewCheckoutPhaseReceiptInDb,
  setReviewCheckoutProvisionReceipt,
  setWorktreeContractId,
  settleReviewCheckoutTeardown,
  updateProjectWorktreeProfile,
} from '@pc/db';
import {
  createNotRequiredWorktreePhaseReceipt,
  type ReviewCheckout,
  type ReviewCheckoutAuthority,
  type ReviewCheckoutPhaseReceipt,
  type ULID,
} from '@pc/domain';
import { seedStockAgents } from '../src/agents/seed.ts';
import { runPreAttachRepositoryRecovery } from '../src/boot-recovery.ts';
import { SessionRegistry } from '../src/chat/registry.ts';
import { DispatchService, type DispatchServiceDeps } from '../src/dispatch/service.ts';
import {
  git,
  provisionReviewCheckout,
  provisionWorktree,
  requireReviewCheckoutOwnedRoot,
  sweepOrphanedWorktreeDirs,
  worktreesRoot,
} from '../src/dispatch/worktrees.ts';
import { CLAUDE_RUNTIME_ID } from '../src/runner/claude-adapter.ts';
import { FakeRuntime } from '../src/runner/fake-runtime.ts';
import {
  RuntimeRegistry,
  type AgentRuntimeAdapter,
  type CreateRuntimeSession,
  type ResumeRuntimeSession,
  type RuntimeEvent,
  type RuntimeSession,
} from '../src/runner/runtime.ts';
import { ProjectWebSocketHub } from '../src/ws/hub.ts';
import {
  advanceTestAgentRunStatus,
  commitFile,
  freshDb,
  newGitProject,
  testAgentRunExecution,
  testDispatchRuntimeDeps,
  until,
} from './helpers.ts';
import {
  testCapabilities,
  testModelDiscovery,
  testSessionSelectionDeps,
  testSubscriptionQuotaUnavailable,
  withRuntimeReceipt,
} from './runtime-fixtures.ts';

const FULL_REVIEW_SPEC = {
  kind: 'repo' as const,
  review: 'full' as const,
  paths_touched: ['feature.txt'],
};

function persistReviewPhase(input: {
  authority: ReviewCheckoutAuthority;
  expectedUpdatedAt: number;
  receipt: ReviewCheckoutPhaseReceipt;
}) {
  return getDb().transaction((tx) => {
    const run = setReviewAgentRunPhaseReceiptInDb(
      input.authority.reviewerRunId,
      input.receipt,
      tx,
    );
    if (!run) return null;
    const checkout = setReviewCheckoutPhaseReceiptInDb(input, tx);
    if (!checkout) throw new Error('review checkout phase CAS failed after reviewer phase write');
    return checkout;
  });
}

const OK_RESULT: RuntimeEvent = {
  type: 'result',
  ok: true,
  stopReason: 'complete',
  usage: null,
  durationMs: 1,
  error: null,
  outcome: 'ok',
  numTurns: null,
};

function deferred<T = void>(): {
  promise: Promise<T>;
  resolve: (value: T) => void;
} {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}

class ControlledAdapter implements AgentRuntimeAdapter {
  readonly id = CLAUDE_RUNTIME_ID;
  readonly appToolBridge = 'supported' as const;
  readonly created: CreateRuntimeSession[] = [];
  readonly turnInputs: string[] = [];
  readonly disposed: number[] = [];
  readonly mintEntered = deferred<void>();
  readonly disposeEntered = deferred<void>();
  private readonly mintRelease = deferred<void>();
  private readonly disposeRelease = deferred<void>();
  private readonly turnGates: Array<ReturnType<typeof deferred<void>>> = [];

  constructor(
    private readonly holdMint = false,
    private readonly holdDispose = false,
  ) {}

  async capabilities(accountId: string) { return testCapabilities(this.id, accountId); }
  async observeSubscriptionQuota(accountId: string) {
    return testSubscriptionQuotaUnavailable(this.id, accountId);
  }
  async listModels() { return testModelDiscovery(); }

  releaseMint(): void {
    this.mintRelease.resolve();
  }

  releaseDispose(): void {
    this.disposeRelease.resolve();
  }

  releaseTurn(index: number): void {
    this.turnGates[index]?.resolve();
  }

  releaseAll(): void {
    this.releaseMint();
    this.releaseDispose();
    for (const gate of this.turnGates) gate.resolve();
  }

  private async mint(
    input: CreateRuntimeSession,
    continuation: { mode: 'create' } | { mode: 'resume'; nativeSessionId: string },
  ): Promise<RuntimeSession> {
    const index = this.created.length;
    this.created.push(input);
    const turnGate = deferred<void>();
    this.turnGates[index] = turnGate;
    this.mintEntered.resolve();
    if (this.holdMint) await this.mintRelease.promise;
    let disposed = false;
    const runtime: RuntimeSession = {
      sendTurn: (message: string) => {
        this.turnInputs[index] = message;
        return (async function* (): AsyncGenerator<RuntimeEvent> {
          yield { type: 'system', subtype: 'review', level: 'info', message: 'reviewing' };
          await turnGate.promise;
          if (!disposed) yield OK_RESULT;
        })();
      },
      observeContext: async () => ({ confidence: 'unavailable', reason: 'unsupported' }),
      interrupt: async () => {},
      dispose: async () => {
        this.disposeEntered.resolve();
        if (this.holdDispose) await this.disposeRelease.promise;
        if (!disposed) this.disposed.push(index);
        disposed = true;
        turnGate.resolve();
      },
    };
    return withRuntimeReceipt(() => runtime)({
      projectId: input.projectId,
      appSessionId: input.appSessionId,
      continuationAttemptId: input.continuationAttemptId,
      selection: input.selection,
      continuation,
    });
  }

  createSession(input: CreateRuntimeSession): Promise<RuntimeSession> {
    return this.mint(input, { mode: 'create' });
  }

  resumeSession(input: ResumeRuntimeSession): Promise<RuntimeSession> {
    return this.mint(input, { mode: 'resume', nativeSessionId: input.nativeSessionId });
  }
}

function attachDispatch(dispatch: DispatchService): void {
  const hub = new ProjectWebSocketHub<ULID>();
  const registry = new SessionRegistry({
    hub,
    ...testSessionSelectionDeps(),
    mintSession: withRuntimeReceipt(() => new FakeRuntime()),
  });
  dispatch.attach({ registry, hub, serverPort: 1 });
}

function rig(
  adapter: AgentRuntimeAdapter,
  configureDeps?: (base: DispatchServiceDeps) => DispatchServiceDeps,
  attach = true,
): DispatchService {
  const runtimes = new RuntimeRegistry();
  runtimes.register(adapter);
  const base: DispatchServiceDeps = testDispatchRuntimeDeps(runtimes);
  const dispatch = new DispatchService(configureDeps ? configureDeps(base) : base);
  if (attach) attachDispatch(dispatch);
  return dispatch;
}

async function readyReviewTarget(
  gp: Awaited<ReturnType<typeof newGitProject>>,
): Promise<{ contractId: ULID; producerRunId: ULID; sealedCommit: string; worktreeDir: string }> {
  const producerRunId = newId() as ULID;
  const provisioned = await provisionWorktree(gp.dir, producerRunId, {
    projectId: gp.project.id,
  });
  if (!provisioned.ok) throw new Error(provisioned.error);
  const sealedCommit = await commitFile(provisioned.dir, 'feature.txt', 'reviewed change\n');
  const contract = createContract({
    projectId: gp.project.id,
    podName: 'code-writer',
    expectedOutput: FULL_REVIEW_SPEC,
    acceptanceCriteria: [],
    verificationTier: 'auto',
    landingPolicy: 'full-review',
    worktreePath: provisioned.dir,
    worktreeBaseBranch: provisioned.baseBranch,
    worktreeBaseSha: provisioned.baseSha,
  });
  setWorktreeContractId(provisioned.branch, contract.id);
  insertAgentRunRow({
    id: producerRunId,
    projectId: gp.project.id,
    ...testAgentRunExecution('code-writer'),
    dispatcherSessionId: 'review-recovery-target',
    status: 'queued',
    input: 'produce review target',
    contractId: contract.id,
    worktreeDir: provisioned.dir,
    worktreeBaseBranch: provisioned.baseBranch,
    worktreeBaseSha: provisioned.baseSha,
    gitReceipt: {
      worktreePath: provisioned.dir,
      branch: provisioned.branch,
      baseBranch: provisioned.baseBranch,
      baseSha: provisioned.baseSha,
      cleanStatus: provisioned.cleanStatus,
      repositoryIdentity: provisioned.repositoryIdentity,
    },
    lifecycleState: 'reviewing',
    queuedAt: Date.now(),
  });
  setContractRun(contract.id, producerRunId);
  advanceTestAgentRunStatus(producerRunId, 'completed');
  assert.ok(setContractDeliverable(contract.id, {
    deliverable: { kind: 'repo', branch: provisioned.branch, commit: sealedCommit },
    report: 'ready for independent review',
  }));
  assert.ok(setContractVerification(contract.id, {
    verificationStatus: 'passed',
    verifiedBaseSha: provisioned.baseSha,
  }));
  return {
    contractId: contract.id,
    producerRunId,
    sealedCommit,
    worktreeDir: provisioned.dir,
  };
}

function driveIndependentReview(dispatch: DispatchService, contractId: ULID): Promise<Contract | null> {
  return (
    dispatch as unknown as { ensureIndependentReview(id: ULID): Promise<Contract | null> }
  ).ensureIndependentReview(contractId);
}

async function startReviewer(
  dispatch: DispatchService,
  adapter: ControlledAdapter,
  contractId: ULID,
): Promise<ULID> {
  await driveIndependentReview(dispatch, contractId);
  await until(() => {
    const reviewRunId = getContract(contractId)?.reviewRunId;
    return reviewRunId !== null && reviewRunId !== undefined &&
      getAgentRunRow(reviewRunId as ULID) !== null && adapter.turnInputs.length === 1;
  }, 20000);
  return getContract(contractId)!.reviewRunId as ULID;
}

async function startPausedReviewer(
  dispatch: DispatchService,
  adapter: ControlledAdapter,
  projectId: ULID,
  contractId: ULID,
): Promise<{ reviewRunId: ULID; askId: ULID }> {
  const reviewRunId = await startReviewer(dispatch, adapter, contractId);
  const asked = dispatch.createPendingAsk({
    projectId,
    agentRunId: reviewRunId,
    kind: 'orchestrator',
    promptBody: 'Which review path should I inspect next?',
  });
  if (!asked.ok) assert.fail(asked.message);
  await until(() => getAgentRunRow(reviewRunId)?.status === 'paused', 20000);
  assert.equal(getPendingAsk(asked.pendingAskId)?.status, 'open');
  assert.equal(getReviewCheckoutForReviewer(reviewRunId)?.status, 'provisioned');
  return { reviewRunId, askId: asked.pendingAskId };
}

async function deliverVerdict(
  dispatch: DispatchService,
  adapter: ControlledAdapter,
  projectId: ULID,
  reviewRunId: ULID,
  verdict: 'approve' | 'reject',
): Promise<void> {
  const submitted = await dispatch.submitDeliverable({
    projectId,
    agentRunId: reviewRunId,
    deliverable: {
      kind: 'payload',
      data: {
        verdict,
        findings: verdict === 'reject'
          ? [{ file: 'feature.txt', line: 1, summary: 'fix it', severity: 'major' }]
          : [],
      },
    } as never,
    report: `${verdict} verdict`,
  });
  assert.equal(submitted.ok, true, JSON.stringify(submitted));
  adapter.releaseTurn(0);
}

function reviewerContractCount(projectId: ULID): number {
  return listContractsForProject(projectId)
    .filter((contract) => contract.podName === 'contract-reviewer').length;
}

async function recordDestroyedAdmissionWithoutVerdict(
  gp: Awaited<ReturnType<typeof newGitProject>>,
  target: Awaited<ReturnType<typeof readyReviewTarget>>,
  reviewerRunId: ULID,
  withTerminalReviewer: boolean,
): Promise<ReviewCheckout> {
  assert.ok(setContractReviewState(target.contractId, {
    reviewRound: 1,
    reviewRunId: reviewerRunId,
    reviewSealedCommit: target.sealedCommit,
  }));
  const reservedTarget = getContract(target.contractId)!;
  const producer = getAgentRunRow(target.producerRunId)!;
  const root = await requireReviewCheckoutOwnedRoot(gp.dir, producer.gitReceipt!.repositoryIdentity);
  if (!root.ok) throw new Error(root.error);
  assert.equal(root.ok, true, JSON.stringify(root));
  const authority: ReviewCheckoutAuthority = {
    id: newId() as ULID,
    projectId: gp.project.id,
    contractId: target.contractId,
    contractVersion: reservedTarget.version,
    producerRunId: target.producerRunId,
    reviewerRunId,
    repositoryIdentity: producer.gitReceipt!.repositoryIdentity,
    ownedRootRealPath: root.ownedRootRealPath,
    worktreePath: join(root.ownedRootRealPath, `review-${reviewerRunId.slice(-8).toLowerCase()}`),
    sealedCommit: target.sealedCommit,
  };
  let checkout = createReviewCheckoutReservation({ ...authority, createdAt: Date.now() });
  assert.ok(checkout);
  if (withTerminalReviewer) {
    insertAgentRunRow({
      id: reviewerRunId,
      projectId: gp.project.id,
      ...testAgentRunExecution('contract-reviewer'),
      dispatcherSessionId: 'review-admission-crash-negative-control',
      status: 'queued',
      input: 'review target',
      queuedAt: Date.now(),
    });
    advanceTestAgentRunStatus(reviewerRunId, 'failed');
  }
  checkout = markReviewCheckoutTeardownPending({
    authority,
    expectedUpdatedAt: checkout.updatedAt,
    fromStatus: 'reserved',
    at: Date.now(),
    error: null,
  });
  assert.ok(checkout);
  const finishedAt = Date.now();
  checkout = settleReviewCheckoutTeardown({
    authority,
    expectedUpdatedAt: checkout.updatedAt,
    receipt: {
      ...authority,
      protocol: 'review-checkout-teardown-v1',
      startedAt: finishedAt,
      finishedAt,
      directoryAbsent: true,
      registrationAbsent: true,
      branchDeletion: 'not-applicable-detached',
    },
    destroyedAt: finishedAt,
  });
  assert.ok(checkout);
  assert.equal(checkout.verdictReceipt, null);
  return checkout;
}

async function recordQuarantinedLegacyTerminalReview(
  gp: Awaited<ReturnType<typeof newGitProject>>,
  target: Awaited<ReturnType<typeof readyReviewTarget>>,
  verdict: 'approve' | 'reject',
): Promise<{ checkoutId: ULID; reviewerRunId: ULID }> {
  const reviewerRunId = newId() as ULID;
  assert.ok(setContractReviewState(target.contractId, {
    reviewRound: 1,
    reviewRunId: reviewerRunId,
    reviewSealedCommit: target.sealedCommit,
  }));
  const reservedTarget = getContract(target.contractId)!;
  const producer = getAgentRunRow(target.producerRunId)!;
  const root = await requireReviewCheckoutOwnedRoot(gp.dir, producer.gitReceipt!.repositoryIdentity);
  if (!root.ok) throw new Error(root.error);
  assert.equal(root.ok, true, JSON.stringify(root));
  const authority: ReviewCheckoutAuthority = {
    id: newId() as ULID,
    projectId: gp.project.id,
    contractId: target.contractId,
    contractVersion: reservedTarget.version,
    producerRunId: target.producerRunId,
    reviewerRunId,
    repositoryIdentity: producer.gitReceipt!.repositoryIdentity,
    ownedRootRealPath: root.ownedRootRealPath,
    worktreePath: join(root.ownedRootRealPath, `review-${reviewerRunId.slice(-8).toLowerCase()}`),
    sealedCommit: target.sealedCommit,
  };
  const reservation = createReviewCheckoutReservation({ ...authority, createdAt: Date.now() });
  assert.ok(reservation);
  const provisioned = await provisionReviewCheckout({ ...authority, projectDir: gp.dir });
  if (!provisioned.ok) throw new Error(provisioned.error);
  assert.equal(provisioned.ok, true, JSON.stringify(provisioned));
  const workspace = setReviewCheckoutProvisionReceipt({
    authority,
    expectedUpdatedAt: reservation.updatedAt,
    receipt: provisioned.receipt,
  });
  assert.ok(workspace);

  const reviewGitReceipt = {
    ...provisioned.receipt,
    protocol: 'review-checkout-git-v1',
    branch: '(detached)',
    baseBranch: '(detached)',
    baseSha: authority.sealedCommit,
    cleanStatus: true,
  } as const;

  const reviewerContract = createContract({
    projectId: gp.project.id,
    podName: 'contract-reviewer',
    expectedOutput: {
      kind: 'payload',
      semantic: 'verdict',
      schema: {
        type: 'object',
        properties: {
          verdict: { type: 'string', enum: ['approve', 'reject'] },
          findings: { type: 'array' },
        },
        required: ['verdict', 'findings'],
      },
    },
    acceptanceCriteria: [],
    verificationTier: 'auto',
  });
  insertAgentRunRow({
    id: reviewerRunId,
    projectId: gp.project.id,
    ...testAgentRunExecution('contract-reviewer'),
    dispatcherSessionId: 'legacy-review-upgrade',
    status: 'queued',
    input: 'legacy review completed before migration 0019',
    contractId: reviewerContract.id,
    worktreeDir: authority.worktreePath,
    worktreeBaseBranch: '(detached)',
    worktreeBaseSha: authority.sealedCommit,
    gitReceipt: reviewGitReceipt,
    queuedAt: Date.now(),
  });
  assert.ok(setContractRun(reviewerContract.id, reviewerRunId));
  assert.ok(setContractDeliverable(reviewerContract.id, {
    deliverable: {
      kind: 'payload',
      data: {
        verdict,
        findings: verdict === 'reject'
          ? [{ file: 'feature.txt', line: 1, summary: 'legacy finding', severity: 'major' }]
          : [],
      },
    },
    report: `legacy ${verdict} payload`,
  }));
  assert.ok(setContractVerification(reviewerContract.id, { verificationStatus: 'passed' }));
  advanceTestAgentRunStatus(reviewerRunId, 'completed');

  // This is the exact post-upgrade state produced by migration 0019: generic
  // pre-0019 phase evidence is quarantined on both owners, while terminal run
  // and submitted-deliverable evidence remain available for honest display.
  assert.equal(getAgentRunRow(reviewerRunId)?.preparationReceipt, null);
  assert.equal(getAgentRunRow(reviewerRunId)?.readinessReceipt, null);
  assert.equal(getReviewCheckoutForReviewer(reviewerRunId)?.preparationReceipt, null);
  assert.equal(getReviewCheckoutForReviewer(reviewerRunId)?.readinessReceipt, null);
  return { checkoutId: authority.id, reviewerRunId };
}

type DispatchInternals = {
  applyReviewVerdictEffect(checkout: ReviewCheckout): Promise<void>;
  contracts: {
    get(id: ULID): Contract | null;
    setRun(id: ULID, runId: ULID): Contract | null;
  };
  ensureIndependentReview(contractId: ULID): Promise<Contract | null>;
  landAcceptedContract(contract: Contract, authorizer?: 'reviewer'): Promise<Contract | null>;
  settleReviewCheckoutCleanup(checkout: ReviewCheckout): Promise<ReviewCheckout>;
};

function suppressSuccessorReview(dispatch: DispatchService): void {
  (dispatch as unknown as DispatchInternals).ensureIndependentReview = async (contractId) =>
    getContract(contractId);
}

test('boot exact-clears a destroyed admission without a reviewer row but fences terminal no-verdict reviews', async () => {
  freshDb();
  const gp = await newGitProject();
  try {
    const absentTarget = await readyReviewTarget(gp);
    const absentReviewerRunId = newId() as ULID;
    const absentCheckout = await recordDestroyedAdmissionWithoutVerdict(
      gp,
      absentTarget,
      absentReviewerRunId,
      false,
    );
    assert.equal(absentCheckout.status, 'destroyed');
    assert.equal(getAgentRunRow(absentReviewerRunId), null);
    assert.equal(getContract(absentTarget.contractId)?.reviewRunId, absentReviewerRunId);

    const terminalTarget = await readyReviewTarget(gp);
    const terminalReviewerRunId = newId() as ULID;
    const terminalCheckout = await recordDestroyedAdmissionWithoutVerdict(
      gp,
      terminalTarget,
      terminalReviewerRunId,
      true,
    );
    assert.equal(terminalCheckout.status, 'destroyed');
    assert.equal(getAgentRunRow(terminalReviewerRunId)?.status, 'failed');
    assert.equal(
      listReviewCheckoutsNeedingRecovery().some((row) => row.id === terminalCheckout.id),
      false,
      'post-0019 terminal corruption is not executable recovery authority',
    );
    assert.equal(
      listReviewCheckoutBlockingCandidates().some((row) => row.id === terminalCheckout.id),
      true,
      'the exact blocking corruption remains in the unbounded browser projection',
    );

    const recovery = rig(new ControlledAdapter(), undefined, false);
    await runPreAttachRepositoryRecovery(recovery);

    assert.equal(
      getContract(absentTarget.contractId)?.reviewRunId,
      null,
      'positive destruction exact-releases an admission that never inserted its reviewer run',
    );
    assert.equal(
      getContract(terminalTarget.contractId)?.reviewRunId,
      terminalReviewerRunId,
      'a terminal reviewer without a verdict is not misclassified as a pre-run admission crash',
    );
    assert.equal(
      listReviewCheckoutBlockingCandidates().some((row) => row.id === terminalCheckout.id),
      true,
    );
    await recovery.disposeAll();
  } finally {
    await gp.cleanup();
  }
});

for (const legacyVerdict of ['approve', 'reject'] as const) {
  test(`boot quarantines a legacy ${legacyVerdict} payload whose reviewer phases were invalidated by 0019`, async () => {
    freshDb();
    seedStockAgents();
    const gp = await newGitProject();
    const adapter = new ControlledAdapter();
    let recovery: DispatchService | null = null;
    try {
      const target = await readyReviewTarget(gp);
      const legacy = await recordQuarantinedLegacyTerminalReview(gp, target, legacyVerdict);
      recovery = rig(adapter, undefined, false);

      await runPreAttachRepositoryRecovery(recovery);

      const retired = getReviewCheckoutForReviewer(legacy.reviewerRunId)!;
      assert.equal(retired.id, legacy.checkoutId);
      assert.equal(retired.status, 'destroyed');
      assert.ok(
        retired.verdictReceipt?.outcome === 'unavailable' ||
          retired.verdictReceipt?.outcome === 'void',
        `untrusted legacy payload settled '${retired.verdictReceipt?.outcome ?? 'without-receipt'}'`,
      );
      assert.notEqual(retired.verdictAppliedAt, null);
      const quarantined = getContract(target.contractId)!;
      assert.equal(quarantined.landingStatus, null, 'legacy approval cannot reserve or perform landing');
      assert.equal(quarantined.verificationStatus, 'passed', 'legacy rejection cannot fail the target');
      assert.equal(quarantined.reviewRunId, null, 'unavailable verdict releases only its exact old marker');
      assert.equal(reviewerContractCount(gp.project.id), 1);

      attachDispatch(recovery);
      await recovery.recoverPendingReviews();
      await until(() => {
        const next = getContract(target.contractId)?.reviewRunId;
        return next !== null && next !== undefined && next !== legacy.reviewerRunId;
      }, 20000);
      assert.equal(reviewerContractCount(gp.project.id), 2, 'upgrade quarantine requires a fresh reviewer');
      assert.equal(getContract(target.contractId)?.reviewRound, 2);
    } finally {
      adapter.releaseAll();
      if (recovery) await recovery.disposeAll().catch(() => {});
      await gp.cleanup();
    }
  });
}

test('boot replays a terminal approval after checkout destruction but before any verdict effect', async () => {
  freshDb();
  seedStockAgents();
  const gp = await newGitProject();
  try {
    const adapter = new ControlledAdapter();
    const crashed = rig(adapter);
    const target = await readyReviewTarget(gp);
    const reviewRunId = await startReviewer(crashed, adapter, target.contractId);
    let skipped = 0;
    (crashed as unknown as DispatchInternals).applyReviewVerdictEffect = async () => { skipped += 1; };

    await deliverVerdict(crashed, adapter, gp.project.id, reviewRunId, 'approve');
    await until(() => getReviewCheckoutForReviewer(reviewRunId)?.status === 'destroyed', 20000);
    assert.equal(skipped, 1);
    assert.equal(getContract(target.contractId)?.reviewRunId, reviewRunId);
    assert.equal(getContract(target.contractId)?.landingStatus, null);

    const recoveryAdapter = new ControlledAdapter();
    const recovery = rig(recoveryAdapter, undefined, false);
    await runPreAttachRepositoryRecovery(recovery);
    await until(() => getContract(target.contractId)?.landingStatus === 'landed', 20000);
    const first = getContract(target.contractId)!;
    assert.equal(first.reviewRunId, null);
    assert.equal(first.landingAuthorizer, 'reviewer');
    assert.equal(reviewerContractCount(gp.project.id), 1, 'replay applies the old verdict instead of admitting a successor');

    await runPreAttachRepositoryRecovery(recovery);
    assert.equal(getContract(target.contractId)?.version, first.version, 'second replay is effect-idempotent');
    attachDispatch(recovery);
    await recovery.recoverPendingReviews();
    assert.equal(reviewerContractCount(gp.project.id), 1);
    await recovery.disposeAll();
  } finally {
    await gp.cleanup();
  }
});
test('boot completes approval after atomic landing reservation but before Git landing without a successor', async () => {
  freshDb();
  seedStockAgents();
  const gp = await newGitProject();
  try {
    const adapter = new ControlledAdapter();
    const crashed = rig(adapter);
    const target = await readyReviewTarget(gp);
    const reviewRunId = await startReviewer(crashed, adapter, target.contractId);
    let skippedLanding = 0;
    (crashed as unknown as DispatchInternals).landAcceptedContract = async () => {
      skippedLanding += 1;
      return null;
    };

    await deliverVerdict(crashed, adapter, gp.project.id, reviewRunId, 'approve');
    await until(() => getReviewCheckoutForReviewer(reviewRunId)?.status === 'destroyed', 20000);
    await until(() => getContract(target.contractId)?.reviewRunId === null, 20000);
    assert.equal(skippedLanding, 1);
    assert.equal(getContract(target.contractId)?.landingStatus, 'pending');

    const recoveryAdapter = new ControlledAdapter();
    const recovery = rig(recoveryAdapter, undefined, false);
    await runPreAttachRepositoryRecovery(recovery);
    await until(() => getContract(target.contractId)?.landingStatus === 'landed', 20000);
    const landed = getContract(target.contractId)!;
    assert.equal(landed.landingAuthorizer, 'reviewer');
    assert.equal(reviewerContractCount(gp.project.id), 1);
    await runPreAttachRepositoryRecovery(recovery);
    assert.equal(getContract(target.contractId)?.version, landed.version);
    attachDispatch(recovery);
    await recovery.recoverPendingReviews();
    assert.equal(reviewerContractCount(gp.project.id), 1);
    await recovery.disposeAll();
  } finally {
    await gp.cleanup();
  }
});

test('boot replays a terminal rejection after checkout destruction without exhausting a round', async () => {
  freshDb();
  seedStockAgents();
  const gp = await newGitProject();
  try {
    const adapter = new ControlledAdapter();
    const crashed = rig(adapter);
    const target = await readyReviewTarget(gp);
    const reviewRunId = await startReviewer(crashed, adapter, target.contractId);
    let skipped = 0;
    (crashed as unknown as DispatchInternals).applyReviewVerdictEffect = async () => { skipped += 1; };

    await deliverVerdict(crashed, adapter, gp.project.id, reviewRunId, 'reject');
    await until(() => getReviewCheckoutForReviewer(reviewRunId)?.status === 'destroyed', 20000);
    assert.equal(skipped, 1);
    assert.equal(getContract(target.contractId)?.verificationStatus, 'passed');
    assert.equal(getContract(target.contractId)?.reviewRunId, reviewRunId);

    const recoveryAdapter = new ControlledAdapter();
    const recovery = rig(recoveryAdapter, undefined, false);
    await runPreAttachRepositoryRecovery(recovery);
    const rejected = getContract(target.contractId)!;
    assert.equal(rejected.reviewRunId, null);
    assert.equal(rejected.verificationStatus, 'failed');
    assert.equal(rejected.reviewRound, 1);
    assert.equal(reviewerContractCount(gp.project.id), 1);
    await runPreAttachRepositoryRecovery(recovery);
    assert.equal(getContract(target.contractId)?.version, rejected.version);
    attachDispatch(recovery);
    await recovery.recoverPendingReviews();
    assert.equal(reviewerContractCount(gp.project.id), 1);
    await recovery.disposeAll();
  } finally {
    await gp.cleanup();
  }
});

for (const window of ['profile', 'preflight', 'mint'] as const) {
  test(`graceful shutdown during review ${window} terminalizes the run and positively cleans its checkout`, async () => {
    freshDb();
    seedStockAgents();
    const gp = await newGitProject();
    const adapter = new ControlledAdapter(window === 'mint');
    const preflightEntered = deferred<void>();
    const releasePreflight = deferred<void>();
    let dispatch: DispatchService | null = null;
    try {
      const target = await readyReviewTarget(gp);
      if (window === 'profile') {
        assert.ok(updateProjectWorktreeProfile(gp.project.id, {
          setupCommands: [
            `node -e "require('node:fs').writeFileSync('review-profile-started.txt','yes');setTimeout(()=>process.exit(0),1200)"`,
          ],
          readinessCommands: [],
          cleanupCommands: [],
        }));
      }
      dispatch = rig(adapter, window === 'preflight' ? (base) => ({
        ...base,
        preflightRuntimeSession: async (selection, continuation) => {
          preflightEntered.resolve();
          await releasePreflight.promise;
          return base.preflightRuntimeSession(selection, continuation);
        },
      }) : undefined);

      const admission = driveIndependentReview(dispatch, target.contractId);
      let reviewRunId: ULID;
      if (window === 'profile') {
        await until(() => {
          const id = getContract(target.contractId)?.reviewRunId as ULID | null;
          const row = id ? getAgentRunRow(id) : null;
          return Boolean(row?.worktreeDir && existsSync(join(row.worktreeDir, 'review-profile-started.txt')));
        }, 20000);
        reviewRunId = getContract(target.contractId)!.reviewRunId as ULID;
      } else if (window === 'preflight') {
        await preflightEntered.promise;
        reviewRunId = getContract(target.contractId)!.reviewRunId as ULID;
      } else {
        await adapter.mintEntered.promise;
        reviewRunId = getContract(target.contractId)!.reviewRunId as ULID;
      }

      const disposing = dispatch.disposeAll();
      releasePreflight.resolve();
      adapter.releaseMint();
      await admission;
      await disposing;
      dispatch = null;

      const terminal = getAgentRunRow(reviewRunId)!;
      assert.ok(['failed', 'cancelled'].includes(terminal.status), `shutdown left reviewer '${terminal.status}'`);
      assert.equal(getReviewCheckoutForReviewer(reviewRunId)?.status, 'destroyed');
      assert.equal(getContract(target.contractId)?.reviewRunId, null);
      assert.equal(reviewerContractCount(gp.project.id), 1, 'shutdown cannot admit a successor');
    } finally {
      releasePreflight.resolve();
      adapter.releaseAll();
      if (dispatch) await dispatch.disposeAll().catch(() => {});
      await gp.cleanup();
    }
  });
}

test('orphan sweep preserves an unresolved durable review directory even without Git registration', async () => {
  freshDb();
  const gp = await newGitProject();
  try {
    const target = await readyReviewTarget(gp);
    const reviewerRunId = newId() as ULID;
    assert.ok(setContractReviewState(target.contractId, {
      reviewRound: 1,
      reviewRunId: reviewerRunId,
      reviewSealedCommit: target.sealedCommit,
    }));
    const reservedTarget = getContract(target.contractId)!;
    const root = await requireReviewCheckoutOwnedRoot(
      gp.dir,
      getAgentRunRow(target.producerRunId)!.gitReceipt!.repositoryIdentity,
    );
    assert.equal(root.ok, true, JSON.stringify(root));
    if (!root.ok) return;
    const path = join(root.ownedRootRealPath, `review-${reviewerRunId.slice(-8).toLowerCase()}`);
    const authority: ReviewCheckoutAuthority = {
      id: newId() as ULID,
      projectId: gp.project.id,
      contractId: target.contractId,
      contractVersion: reservedTarget.version,
      producerRunId: target.producerRunId,
      reviewerRunId,
      repositoryIdentity: getAgentRunRow(target.producerRunId)!.gitReceipt!.repositoryIdentity,
      ownedRootRealPath: root.ownedRootRealPath,
      worktreePath: path,
      sealedCommit: target.sealedCommit,
    };
    assert.ok(createReviewCheckoutReservation({ ...authority, createdAt: Date.now() }));
    mkdirSync(path, { recursive: true });
    writeFileSync(join(path, 'preserve.txt'), 'unregistered crash-window evidence\n');

    const removed = await sweepOrphanedWorktreeDirs(gp.dir, authority.repositoryIdentity);
    assert.equal(removed.includes(path.split(/[\\/]/).pop()!), false);
    assert.equal(existsSync(path), true, 'durable unresolved review authority is in the orphan keep-set');
    assert.equal(getReviewCheckoutForReviewer(reviewerRunId)?.status, 'reserved');
  } finally {
    await gp.cleanup();
  }
});

test('generic copied phase receipts cannot become review authority', async () => {
  freshDb();
  const gp = await newGitProject();
  try {
    const target = await readyReviewTarget(gp);
    const reviewerRunId = newId() as ULID;
    assert.ok(setContractReviewState(target.contractId, {
      reviewRound: 1,
      reviewRunId: reviewerRunId,
      reviewSealedCommit: target.sealedCommit,
    }));
    const reservedTarget = getContract(target.contractId)!;
    const producer = getAgentRunRow(target.producerRunId)!;
    const root = await requireReviewCheckoutOwnedRoot(gp.dir, producer.gitReceipt!.repositoryIdentity);
    assert.equal(root.ok, true, JSON.stringify(root));
    if (!root.ok) return;
    const authority: ReviewCheckoutAuthority = {
      id: newId() as ULID,
      projectId: gp.project.id,
      contractId: target.contractId,
      contractVersion: reservedTarget.version,
      producerRunId: target.producerRunId,
      reviewerRunId,
      repositoryIdentity: producer.gitReceipt!.repositoryIdentity,
      ownedRootRealPath: root.ownedRootRealPath,
      worktreePath: join(root.ownedRootRealPath, `review-${reviewerRunId.slice(-8).toLowerCase()}`),
      sealedCommit: target.sealedCommit,
    };
    const reserved = createReviewCheckoutReservation({ ...authority, createdAt: Date.now() });
    assert.ok(reserved);
    const provisioned = await provisionReviewCheckout({ ...authority, projectDir: gp.dir });
    assert.equal(provisioned.ok, true, JSON.stringify(provisioned));
    if (!provisioned.ok) return;
    const workspace = setReviewCheckoutProvisionReceipt({
      authority,
      expectedUpdatedAt: reserved.updatedAt,
      receipt: provisioned.receipt,
    });
    assert.ok(workspace);
    const copiedBuilderReceipt = createNotRequiredWorktreePhaseReceipt({
      phase: 'preparation',
      reason: 'existing-worktree-preparation',
      inheritedFromRunId: target.producerRunId,
      finishedAt: Date.now(),
    });
    assert.equal(persistReviewPhase({
      authority,
      expectedUpdatedAt: workspace.updatedAt,
      receipt: copiedBuilderReceipt as never,
    }), null, 'a generic or builder-inherited phase receipt is not checkout-bound review authority');
  } finally {
    await gp.cleanup();
  }
});

test('review mint refuses when run-side phase evidence no longer equals workspace evidence', async () => {
  freshDb();
  seedStockAgents();
  const gp = await newGitProject();
  const adapter = new ControlledAdapter();
  const preflightEntered = deferred<void>();
  const releasePreflight = deferred<void>();
  let dispatch: DispatchService | null = null;
  try {
    const target = await readyReviewTarget(gp);
    dispatch = rig(adapter, (base) => ({
      ...base,
      preflightRuntimeSession: async (selection, continuation) => {
        preflightEntered.resolve();
        await releasePreflight.promise;
        return base.preflightRuntimeSession(selection, continuation);
      },
    }));
    const admission = driveIndependentReview(dispatch, target.contractId);
    await preflightEntered.promise;
    const reviewRunId = getContract(target.contractId)!.reviewRunId as ULID;
    const checkout = getReviewCheckoutForReviewer(reviewRunId)!;
    assert.ok(checkout.preparationReceipt);
    (dispatch as unknown as DispatchInternals).applyReviewVerdictEffect = async () => {};
    const copiedBuilderReceipt = createNotRequiredWorktreePhaseReceipt({
      phase: 'preparation',
      reason: 'existing-worktree-preparation',
      inheritedFromRunId: target.producerRunId,
      finishedAt: Date.now() + 1000,
    });
    assert.throws(
      () => getRawDb().prepare('UPDATE agent_runs SET preparation_receipt = ? WHERE id = ?')
        .run(JSON.stringify(copiedBuilderReceipt), reviewRunId),
      /immutable once checkout-bound/,
      'the SQL trust boundary rejects reviewer phase replacement',
    );
    // Defense in depth: simulate a compromised/legacy DB with the migration
    // trigger absent; the final mint gate must still compare both owners.
    getRawDb().exec('DROP TRIGGER agent_runs_review_preparation_immutable');
    getRawDb().prepare('UPDATE agent_runs SET preparation_receipt = ? WHERE id = ?')
      .run(JSON.stringify(copiedBuilderReceipt), reviewRunId);
    releasePreflight.resolve();
    await admission;
    await until(() => {
      const row = getAgentRunRow(reviewRunId);
      return adapter.created.length > 0 || row?.status === 'failed' || row?.status === 'cancelled';
    }, 20000);
    const refused = getAgentRunRow(reviewRunId)!;
    assert.equal(adapter.created.length, 0, 'mismatched run/workspace receipts cannot reach native create');
    assert.ok(['failed', 'cancelled'].includes(refused.status));
    assert.match(refused.failureReason ?? '', /phase|receipt|workspace/i);
  } finally {
    releasePreflight.resolve();
    adapter.releaseAll();
    if (dispatch) await dispatch.disposeAll().catch(() => {});
    await gp.cleanup();
  }
});

test('durable reviewer authority blocks manual and boot auto-continuation while recovery settles unavailable', async () => {
  freshDb();
  seedStockAgents();
  const gp = await newGitProject();
  const crashedAdapter = new ControlledAdapter();
  const recoveryAdapter = new ControlledAdapter();
  let crashed: DispatchService | null = null;
  let recovery: DispatchService | null = null;
  try {
    const target = await readyReviewTarget(gp);
    crashed = rig(crashedAdapter);
    const reviewRunId = await startReviewer(crashed, crashedAdapter, target.contractId);
    assert.equal(markAgentRunTerminal({
      id: reviewRunId,
      status: 'failed',
      result: null,
      failureCause: 'turn-budget-exhausted',
      failureReason: 'simulated crash after durable turn-budget terminal',
      completedAt: Date.now(),
    }), true);

    // Model boot before server attach: reviewer cleanup is safe here, while a
    // fresh successor review remains deferred to the normal post-attach door.
    recovery = rig(recoveryAdapter, undefined, false);
    await recovery.recoverPendingAutoContinues();

    const settled = getReviewCheckoutForReviewer(reviewRunId)!;
    assert.equal(settled.status, 'destroyed');
    assert.equal(settled.verdictReceipt?.outcome, 'unavailable');
    assert.notEqual(settled.verdictAppliedAt, null);
    assert.equal(getContract(target.contractId)?.reviewRunId, null);
    const childCount = getRawDb().prepare(
      'SELECT count(*) AS count FROM agent_runs WHERE continues = ?',
    ).get(reviewRunId) as { count: number };
    assert.equal(childCount.count, 0, 'boot recovery never mints a continuation child for a reviewer');
    assert.equal(recoveryAdapter.created.length, 0);

    attachDispatch(recovery);
    const manual = await recovery.dispatchContinue({
      projectId: gp.project.id,
      runId: reviewRunId,
      input: 'continue the terminal reviewer',
      dispatcherSessionId: 'manual-reviewer-continue',
    });
    assert.equal(manual.ok, false);
    if (!manual.ok) {
      assert.equal(manual.cause, 'not-continuable');
      assert.match(manual.message, /immutable checkout authority|cannot be continued/i);
    }
    assert.equal(
      (getRawDb().prepare('SELECT count(*) AS count FROM agent_runs WHERE continues = ?')
        .get(reviewRunId) as { count: number }).count,
      0,
    );
  } finally {
    crashedAdapter.releaseAll();
    recoveryAdapter.releaseAll();
    if (recovery) await recovery.disposeAll().catch(() => {});
    if (crashed) await crashed.disposeAll().catch(() => {});
    await gp.cleanup();
  }
});

test('paused reviewer revival succeeds only with exact runtime-ready checkout authority', async () => {
  freshDb();
  seedStockAgents();
  const gp = await newGitProject();
  const crashedAdapter = new ControlledAdapter();
  const recoveryAdapter = new ControlledAdapter();
  let crashed: DispatchService | null = null;
  let recovery: DispatchService | null = null;
  try {
    const target = await readyReviewTarget(gp);
    crashed = rig(crashedAdapter);
    const { reviewRunId, askId } = await startPausedReviewer(
      crashed,
      crashedAdapter,
      gp.project.id,
      target.contractId,
    );
    const checkout = getReviewCheckoutForReviewer(reviewRunId)!;

    recovery = rig(recoveryAdapter);
    await recovery.recoverPausedAsks();

    assert.equal(recoveryAdapter.created.length, 1, 'exact authority reaches one native resume');
    assert.equal(recoveryAdapter.created[0]?.cwd, checkout.worktreePath);
    assert.equal(recovery.hasLiveRun(reviewRunId), true);
    assert.equal(getAgentRunRow(reviewRunId)?.status, 'paused');
    assert.equal(getPendingAsk(askId)?.status, 'open');

    await recovery.disposeAll();
    recovery = null;
    assert.equal(getPendingAsk(askId)?.status, 'cancelled');
    assert.equal(getReviewCheckoutForReviewer(reviewRunId)?.status, 'destroyed');
  } finally {
    crashedAdapter.releaseAll();
    recoveryAdapter.releaseAll();
    if (recovery) await recovery.disposeAll().catch(() => {});
    if (crashed) await crashed.disposeAll().catch(() => {});
    await gp.cleanup();
  }
});

test('paused reviewer with missing checkout phase evidence terminalizes and cleans without native resume', async () => {
  freshDb();
  seedStockAgents();
  const gp = await newGitProject();
  const crashedAdapter = new ControlledAdapter();
  const recoveryAdapter = new ControlledAdapter();
  let crashed: DispatchService | null = null;
  let recovery: DispatchService | null = null;
  try {
    const target = await readyReviewTarget(gp);
    crashed = rig(crashedAdapter);
    const { reviewRunId, askId } = await startPausedReviewer(
      crashed,
      crashedAdapter,
      gp.project.id,
      target.contractId,
    );
    const checkout = getReviewCheckoutForReviewer(reviewRunId)!;
    getRawDb().exec('DROP TRIGGER review_checkouts_readiness_guard');
    getRawDb().prepare('UPDATE review_checkouts SET readiness_receipt = NULL WHERE id = ?')
      .run(checkout.id);

    recovery = rig(recoveryAdapter);
    suppressSuccessorReview(recovery);
    await recovery.recoverPausedAsks();

    assert.equal(recoveryAdapter.created.length, 0);
    assert.ok(['failed', 'cancelled'].includes(getAgentRunRow(reviewRunId)!.status));
    assert.equal(getPendingAsk(askId)?.status, 'cancelled');
    await until(() => getReviewCheckoutForReviewer(reviewRunId)?.status === 'destroyed', 20000);
    const settled = getReviewCheckoutForReviewer(reviewRunId)!;
    assert.equal(settled.status, 'destroyed');
    assert.equal(settled.verdictReceipt?.outcome, 'unavailable');
    assert.notEqual(settled.verdictAppliedAt, null);
    assert.equal(getContract(target.contractId)?.reviewRunId, null);
  } finally {
    crashedAdapter.releaseAll();
    recoveryAdapter.releaseAll();
    if (recovery) await recovery.disposeAll().catch(() => {});
    if (crashed) await crashed.disposeAll().catch(() => {});
    await gp.cleanup();
  }
});

test('paused reviewer phase drift during preflight terminalizes and cleans before native resume', async () => {
  freshDb();
  seedStockAgents();
  const gp = await newGitProject();
  const crashedAdapter = new ControlledAdapter();
  const recoveryAdapter = new ControlledAdapter();
  const preflightEntered = deferred<void>();
  const releasePreflight = deferred<void>();
  let crashed: DispatchService | null = null;
  let recovery: DispatchService | null = null;
  try {
    const target = await readyReviewTarget(gp);
    crashed = rig(crashedAdapter);
    const { reviewRunId, askId } = await startPausedReviewer(
      crashed,
      crashedAdapter,
      gp.project.id,
      target.contractId,
    );
    recovery = rig(recoveryAdapter, (base) => ({
      ...base,
      preflightRuntimeSession: async (selection, continuation) => {
        preflightEntered.resolve();
        await releasePreflight.promise;
        return base.preflightRuntimeSession(selection, continuation);
      },
    }));
    suppressSuccessorReview(recovery);

    const revival = recovery.recoverPausedAsks();
    await preflightEntered.promise;
    getRawDb().exec('DROP TRIGGER agent_runs_review_readiness_immutable');
    getRawDb().prepare('UPDATE agent_runs SET readiness_receipt = NULL WHERE id = ?')
      .run(reviewRunId);
    releasePreflight.resolve();
    await revival;

    assert.equal(recoveryAdapter.created.length, 0, 'post-preflight phase recheck fences mint');
    assert.ok(['failed', 'cancelled'].includes(getAgentRunRow(reviewRunId)!.status));
    assert.equal(getPendingAsk(askId)?.status, 'cancelled');
    await until(() => getReviewCheckoutForReviewer(reviewRunId)?.status === 'destroyed', 20000);
    const settled = getReviewCheckoutForReviewer(reviewRunId)!;
    assert.equal(settled.status, 'destroyed');
    assert.equal(settled.verdictReceipt?.outcome, 'unavailable');
    assert.notEqual(settled.verdictAppliedAt, null);
  } finally {
    releasePreflight.resolve();
    crashedAdapter.releaseAll();
    recoveryAdapter.releaseAll();
    if (recovery) await recovery.disposeAll().catch(() => {});
    if (crashed) await crashed.disposeAll().catch(() => {});
    await gp.cleanup();
  }
});

test('paused reviewer provision drift during native resume disposes the mint and positively cleans', async () => {
  freshDb();
  seedStockAgents();
  const gp = await newGitProject();
  const crashedAdapter = new ControlledAdapter();
  const recoveryAdapter = new ControlledAdapter(true);
  let crashed: DispatchService | null = null;
  let recovery: DispatchService | null = null;
  try {
    const target = await readyReviewTarget(gp);
    crashed = rig(crashedAdapter);
    const { reviewRunId, askId } = await startPausedReviewer(
      crashed,
      crashedAdapter,
      gp.project.id,
      target.contractId,
    );
    const checkout = getReviewCheckoutForReviewer(reviewRunId)!;
    recovery = rig(recoveryAdapter);
    suppressSuccessorReview(recovery);

    const revival = recovery.recoverPausedAsks();
    await recoveryAdapter.mintEntered.promise;
    getRawDb().exec('DROP TRIGGER review_checkouts_provision_guard');
    getRawDb().prepare(
      "UPDATE review_checkouts SET provision_receipt = json_set(provision_receipt, '$.trackedChanges', 1) WHERE id = ?",
    ).run(checkout.id);
    recoveryAdapter.releaseMint();
    await revival;

    assert.equal(recoveryAdapter.created.length, 1, 'drift occurs after native mint entered');
    assert.deepEqual(recoveryAdapter.disposed, [0], 'uninstalled native resume is positively disposed');
    assert.equal(recovery.hasLiveRun(reviewRunId), false);
    assert.ok(['failed', 'cancelled'].includes(getAgentRunRow(reviewRunId)!.status));
    assert.equal(getPendingAsk(askId)?.status, 'cancelled');
    await until(() => getReviewCheckoutForReviewer(reviewRunId)?.status === 'destroyed', 20000);
    const settled = getReviewCheckoutForReviewer(reviewRunId)!;
    assert.equal(settled.status, 'destroyed');
    assert.equal(settled.verdictReceipt?.outcome, 'unavailable');
    assert.notEqual(settled.verdictAppliedAt, null);
  } finally {
    recoveryAdapter.releaseMint();
    crashedAdapter.releaseAll();
    recoveryAdapter.releaseAll();
    if (recovery) await recovery.disposeAll().catch(() => {});
    if (crashed) await crashed.disposeAll().catch(() => {});
    await gp.cleanup();
  }
});

test('graceful shutdown atomically cancels a paused reviewer ask, terminalizes, and cleans checkout', async () => {
  freshDb();
  seedStockAgents();
  const gp = await newGitProject();
  const adapter = new ControlledAdapter();
  let dispatch: DispatchService | null = null;
  try {
    const target = await readyReviewTarget(gp);
    dispatch = rig(adapter);
    const { reviewRunId, askId } = await startPausedReviewer(
      dispatch,
      adapter,
      gp.project.id,
      target.contractId,
    );

    await dispatch.disposeAll();
    dispatch = null;

    const terminal = getAgentRunRow(reviewRunId)!;
    assert.ok(['failed', 'cancelled'].includes(terminal.status));
    assert.equal(getPendingAsk(askId)?.status, 'cancelled');
    const checkout = getReviewCheckoutForReviewer(reviewRunId)!;
    assert.equal(checkout.status, 'destroyed');
    assert.notEqual(checkout.teardownReceipt, null);
    assert.equal(checkout.verdictReceipt?.outcome, 'unavailable');
    assert.notEqual(checkout.verdictAppliedAt, null);
    assert.equal(getContract(target.contractId)?.reviewRunId, null);
    assert.equal(reviewerContractCount(gp.project.id), 1, 'shutdown does not admit a successor reviewer');
  } finally {
    adapter.releaseAll();
    if (dispatch) await dispatch.disposeAll().catch(() => {});
    await gp.cleanup();
  }
});

test('fresh reviewer workspace drift during mint disposes the uninstalled session before any turn and cleans', async () => {
  freshDb();
  seedStockAgents();
  const gp = await newGitProject();
  const adapter = new ControlledAdapter(true, true);
  let dispatch: DispatchService | null = null;
  try {
    const target = await readyReviewTarget(gp);
    dispatch = rig(adapter);
    const admission = driveIndependentReview(dispatch, target.contractId);
    await adapter.mintEntered.promise;
    const reviewRunId = getContract(target.contractId)!.reviewRunId as ULID;
    const checkout = getReviewCheckoutForReviewer(reviewRunId)!;
    suppressSuccessorReview(dispatch);

    // The pre-mint authority check already passed. Drift the actual checkout
    // while the provider create is suspended so only the post-mint callback
    // can prevent the fresh session from installing or sending its first turn.
    writeFileSync(join(checkout.worktreePath, 'feature.txt'), 'drifted during native mint\n');
    adapter.releaseMint();
    await adapter.disposeEntered.promise;
    assert.equal(adapter.turnInputs.length, 0, 'post-mint rejection occurs before sendTurn');

    // Disposal is the barrier between immutable rejection and teardown. Put
    // the disposable checkout back on its seal so cleanup can prove absence.
    const restored = await git(
      ['restore', '--source=HEAD', '--staged', '--worktree', '--', 'feature.txt'],
      checkout.worktreePath,
    );
    assert.equal(restored.ok, true, restored.stderr || restored.stdout);
    adapter.releaseDispose();
    await admission;
    await until(() => getReviewCheckoutForReviewer(reviewRunId)?.status === 'destroyed', 20000);

    const terminal = getAgentRunRow(reviewRunId)!;
    assert.ok(['failed', 'cancelled'].includes(terminal.status));
    assert.match(terminal.failureReason ?? '', /after runtime mint|post-mint/i);
    assert.deepEqual(adapter.disposed, [0]);
    assert.equal(adapter.turnInputs.length, 0);
    const settled = getReviewCheckoutForReviewer(reviewRunId)!;
    assert.equal(settled.verdictReceipt?.outcome, 'unavailable');
    assert.notEqual(settled.verdictAppliedAt, null);
    assert.equal(existsSync(checkout.worktreePath), false);
    const reviewTarget = getContract(target.contractId)!;
    assert.equal(reviewTarget.reviewRunId, null);
    assert.equal(reviewTarget.landingStatus, null);
    assert.equal(reviewerContractCount(gp.project.id), 1);
  } finally {
    adapter.releaseAll();
    if (dispatch) await dispatch.disposeAll().catch(() => {});
    await gp.cleanup();
  }
});

test('post-terminal reviewer workspace drift is immutably unavailable even when restored for cleanup', async () => {
  freshDb();
  seedStockAgents();
  const gp = await newGitProject();
  const adapter = new ControlledAdapter(false, true);
  let dispatch: DispatchService | null = null;
  try {
    const target = await readyReviewTarget(gp);
    dispatch = rig(adapter);
    const reviewRunId = await startReviewer(dispatch, adapter, target.contractId);
    const checkout = getReviewCheckoutForReviewer(reviewRunId)!;
    suppressSuccessorReview(dispatch);

    // Restore only after the one-way verdict decision is recorded. This keeps
    // Git drift visible throughout terminal runtime quiescence and the verdict
    // authority check, yet still lets teardown establish positive absence.
    const internals = dispatch as unknown as DispatchInternals;
    const settleCleanup = internals.settleReviewCheckoutCleanup.bind(dispatch);
    let restoredForCleanup = false;
    internals.settleReviewCheckoutCleanup = async (observed) => {
      if (observed.id === checkout.id) {
        const restored = await git(
          ['restore', '--source=HEAD', '--staged', '--worktree', '--', 'feature.txt'],
          checkout.worktreePath,
        );
        assert.equal(restored.ok, true, restored.stderr || restored.stdout);
        restoredForCleanup = true;
      }
      return settleCleanup(observed);
    };

    await deliverVerdict(dispatch, adapter, gp.project.id, reviewRunId, 'approve');
    await adapter.disposeEntered.promise;
    await until(() => getAgentRunRow(reviewRunId)?.status === 'completed', 20000);
    writeFileSync(join(checkout.worktreePath, 'feature.txt'), 'drifted after terminal\n');
    adapter.releaseDispose();
    await until(() => getReviewCheckoutForReviewer(reviewRunId)?.status === 'destroyed', 20000);

    assert.equal(restoredForCleanup, true);
    assert.deepEqual(adapter.disposed, [0]);
    const settled = getReviewCheckoutForReviewer(reviewRunId)!;
    assert.ok(
      settled.verdictReceipt?.outcome === 'unavailable' ||
        settled.verdictReceipt?.outcome === 'void',
      `post-terminal drift was incorrectly accepted as '${settled.verdictReceipt?.outcome ?? 'missing'}'`,
    );
    assert.notEqual(settled.verdictReceipt?.outcome, 'approve');
    assert.notEqual(settled.verdictReceipt?.outcome, 'reject');
    assert.notEqual(settled.verdictAppliedAt, null);
    const reviewTarget = getContract(target.contractId)!;
    assert.equal(reviewTarget.reviewRunId, null);
    assert.equal(reviewTarget.landingStatus, null, 'restoring for cleanup cannot retroactively authorize landing');
    assert.equal(reviewTarget.verificationStatus, 'passed');
    assert.equal(reviewerContractCount(gp.project.id), 1);
  } finally {
    adapter.releaseAll();
    if (dispatch) await dispatch.disposeAll().catch(() => {});
    await gp.cleanup();
  }
});

for (const retryVerdict of ['approve', 'reject'] as const) {
  test(`restart re-enters a merge-ready producer before successor review ${retryVerdict} is authoritative`, async () => {
    freshDb();
    seedStockAgents();
    const gp = await newGitProject();
    const failedAdapter = new ControlledAdapter();
    const recoveryAdapter = new ControlledAdapter();
    const selectionEntered = deferred<void>();
    const releaseSelectionFailure = deferred<void>();
    let failedDispatch: DispatchService | null = null;
    let recovery: DispatchService | null = null;
    try {
      const target = await readyReviewTarget(gp);
      failedDispatch = rig(failedAdapter, (base) => ({
        ...base,
        resolveNewSpecialistSelection: async () => {
          selectionEntered.resolve();
          await releaseSelectionFailure.promise;
          return { status: 'invalid' as const, code: 'account-unavailable' as const };
        },
      }));

      const failedAdmission = driveIndependentReview(failedDispatch, target.contractId);
      await selectionEntered.promise;
      const failedReviewRunId = getContract(target.contractId)!.reviewRunId as ULID;
      assert.ok(failedReviewRunId, 'retryable failure occurs after durable review reservation');
      assert.equal(getReviewCheckoutForReviewer(failedReviewRunId)?.status, 'reserved');
      releaseSelectionFailure.resolve();
      await failedAdmission;

      const parked = getContract(target.contractId)!;
      assert.equal(parked.reviewRunId, null);
      assert.equal(parked.reviewRound, 1);
      assert.equal(parked.verificationStatus, 'passed');
      assert.match(parked.verificationNotes ?? '', /not dispatchable|runtime selection unavailable/i);
      assert.equal(getAgentRunRow(target.producerRunId)?.lifecycleState, 'merge-ready');
      assert.equal(getReviewCheckoutForReviewer(failedReviewRunId)?.status, 'destroyed');
      assert.equal(failedAdapter.created.length, 0);
      assert.equal(reviewerContractCount(gp.project.id), 0);
      await failedDispatch.disposeAll();
      failedDispatch = null;

      // A fresh service models restart ordering: repository recovery occurs
      // before attach, then the ordinary pending-review feeder admits round 2.
      recovery = rig(recoveryAdapter, undefined, false);
      await runPreAttachRepositoryRecovery(recovery);
      attachDispatch(recovery);
      await recovery.recoverPendingReviews();
      await until(() => {
        const id = getContract(target.contractId)?.reviewRunId as ULID | null;
        return Boolean(id && id !== failedReviewRunId && recoveryAdapter.turnInputs.length === 1);
      }, 20000);

      const successorRunId = getContract(target.contractId)!.reviewRunId as ULID;
      assert.notEqual(successorRunId, failedReviewRunId);
      assert.equal(getContract(target.contractId)?.reviewRound, 2);
      assert.equal(
        getAgentRunRow(target.producerRunId)?.lifecycleState,
        'reviewing',
        'successor reservation re-enters the producer before its verdict can be trusted',
      );
      const successorCheckout = getReviewCheckoutForReviewer(successorRunId)!;
      assert.equal(successorCheckout.status, 'provisioned');

      await deliverVerdict(
        recovery,
        recoveryAdapter,
        gp.project.id,
        successorRunId,
        retryVerdict,
      );
      await until(() => {
        const checkout = getReviewCheckoutForReviewer(successorRunId);
        return checkout?.status === 'destroyed' && checkout.verdictAppliedAt !== null;
      }, 20000);

      const settledCheckout = getReviewCheckoutForReviewer(successorRunId)!;
      assert.equal(settledCheckout.verdictReceipt?.outcome, retryVerdict);
      assert.notEqual(settledCheckout.verdictReceipt?.outcome, 'void');
      assert.notEqual(settledCheckout.verdictReceipt?.outcome, 'unavailable');
      const settledTarget = getContract(target.contractId)!;
      assert.equal(settledTarget.reviewRunId, null);
      assert.equal(reviewerContractCount(gp.project.id), 1);
      if (retryVerdict === 'approve') {
        await until(() => getContract(target.contractId)?.landingStatus === 'landed', 20000);
        assert.equal(getContract(target.contractId)?.landingAuthorizer, 'reviewer');
      } else {
        assert.equal(settledTarget.verificationStatus, 'failed');
        assert.equal(settledTarget.landingStatus, null);
        assert.equal(getAgentRunRow(target.producerRunId)?.lifecycleState, 'review-rejected');
      }
    } finally {
      releaseSelectionFailure.resolve();
      failedAdapter.releaseAll();
      recoveryAdapter.releaseAll();
      if (recovery) await recovery.disposeAll().catch(() => {});
      if (failedDispatch) await failedDispatch.disposeAll().catch(() => {});
      await gp.cleanup();
    }
  });
}

test('reviewer contract binding failure releases its admission fence before exact cleanup and one successor', async () => {
  freshDb();
  seedStockAgents();
  const gp = await newGitProject();
  const adapter = new ControlledAdapter();
  let dispatch: DispatchService | null = null;
  try {
    const target = await readyReviewTarget(gp);
    dispatch = rig(adapter);
    const internals = dispatch as unknown as DispatchInternals;
    const setRun = internals.contracts.setRun.bind(internals.contracts);
    const bindingRefused = deferred<void>();
    let failedReviewerRunId: ULID | null = null;
    let refusedOnce = false;
    internals.contracts.setRun = (contractId, runId) => {
      const contract = internals.contracts.get(contractId);
      if (!refusedOnce && contract?.podName === 'contract-reviewer') {
        refusedOnce = true;
        failedReviewerRunId = runId;
        assert.ok(getAgentRunRow(runId), 'reviewer row is published before the binding failure seam');
        bindingRefused.resolve();
        return null;
      }
      return setRun(contractId, runId);
    };

    const admission = driveIndependentReview(dispatch, target.contractId);
    await bindingRefused.promise;
    let timeout: ReturnType<typeof setTimeout> | null = null;
    try {
      await Promise.race([
        admission,
        new Promise<never>((_resolve, reject) => {
          timeout = setTimeout(
            () => reject(new Error('review binding-failure admission self-deadlocked')),
            10000,
          );
        }),
      ]);
    } finally {
      if (timeout) clearTimeout(timeout);
    }

    assert.ok(failedReviewerRunId);
    const failedRun = getAgentRunRow(failedReviewerRunId)!;
    assert.equal(failedRun.status, 'failed');
    assert.match(failedRun.failureReason ?? '', /ownership binding was not positively committed/i);
    const failedCheckout = getReviewCheckoutForReviewer(failedReviewerRunId)!;
    assert.equal(failedCheckout.status, 'destroyed');
    assert.notEqual(failedCheckout.teardownReceipt, null);
    assert.equal(failedCheckout.verdictReceipt?.outcome, 'unavailable');
    assert.notEqual(failedCheckout.verdictAppliedAt, null);

    // Unavailable review recovery may synchronously admit the next round, but
    // it must do so only after the old checkout is gone and its marker effect
    // commits. Re-running the feeder cannot race in a duplicate successor.
    await until(() => {
      const successor = getContract(target.contractId)?.reviewRunId as ULID | null;
      return Boolean(
        successor && successor !== failedReviewerRunId &&
        getReviewCheckoutForReviewer(successor)?.status === 'provisioned' &&
        adapter.turnInputs.length === 1,
      );
    }, 20000);
    const successorRunId = getContract(target.contractId)!.reviewRunId as ULID;
    assert.notEqual(successorRunId, failedReviewerRunId);
    assert.equal(getContract(target.contractId)?.reviewRound, 2);
    assert.equal(reviewerContractCount(gp.project.id), 2, 'failed binding plus exactly one successor');
    await Promise.all([
      dispatch.recoverPendingReviews(),
      dispatch.recoverPendingReviews(),
    ]);
    assert.equal(getContract(target.contractId)?.reviewRunId, successorRunId);
    assert.equal(reviewerContractCount(gp.project.id), 2, 'duplicate recovery cannot race another successor');
    assert.equal(getReviewCheckoutForReviewer(successorRunId)?.status, 'provisioned');
  } finally {
    adapter.releaseAll();
    if (dispatch) await dispatch.disposeAll().catch(() => {});
    await gp.cleanup();
  }
});
