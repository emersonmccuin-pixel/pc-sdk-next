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
  getRawDb,
  getReviewCheckoutForReviewer,
  insertAgentRunRow,
  listContractsForProject,
  newId,
  setContractDeliverable,
  setContractReviewState,
  setContractRun,
  setContractVerification,
  setReviewCheckoutProvisionReceipt,
  setReviewCheckoutRunPhaseReceipt,
  setWorktreeContractId,
  updateProjectWorktreeProfile,
} from '@pc/db';
import {
  createNotRequiredWorktreePhaseReceipt,
  type ReviewCheckout,
  type ReviewCheckoutAuthority,
  type ULID,
} from '@pc/domain';
import { seedStockAgents } from '../src/agents/seed.ts';
import { runPreAttachRepositoryRecovery } from '../src/boot-recovery.ts';
import { SessionRegistry } from '../src/chat/registry.ts';
import { DispatchService, type DispatchServiceDeps } from '../src/dispatch/service.ts';
import {
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
  readonly created: CreateRuntimeSession[] = [];
  readonly turnInputs: string[] = [];
  readonly mintEntered = deferred<void>();
  private readonly mintRelease = deferred<void>();
  private readonly turnGates: Array<ReturnType<typeof deferred<void>>> = [];

  constructor(private readonly holdMint = false) {}

  async capabilities(accountId: string) { return testCapabilities(this.id, accountId); }
  async observeSubscriptionQuota(accountId: string) {
    return testSubscriptionQuotaUnavailable(this.id, accountId);
  }
  async listModels() { return testModelDiscovery(); }

  releaseMint(): void {
    this.mintRelease.resolve();
  }

  releaseTurn(index: number): void {
    this.turnGates[index]?.resolve();
  }

  releaseAll(): void {
    this.releaseMint();
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

type DispatchInternals = {
  applyReviewVerdictEffect(checkout: ReviewCheckout): Promise<void>;
  landAcceptedContract(contract: Contract, authorizer?: 'reviewer'): Promise<Contract | null>;
};

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
    assert.equal(setReviewCheckoutRunPhaseReceipt({
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
