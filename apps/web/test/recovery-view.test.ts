import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import type { AgentRunDto, Contract, ReviewCheckoutDto } from '@pc/contracts';
import type { AgentRunView } from '../src/features/agent-runs/use-project-agent-runs.ts';
import type { StrandedWorktreeDto } from '../src/features/worktrees/client.ts';
import {
  buildRecoveryProjection,
  exactReviewVerdictEvidence,
  exactStrandedEvidenceForRun,
  isDismissibleRecoveryRun,
  preservationEvidenceMessage,
  recoveryRunGuidance,
  recoveryRunLabel,
  reviewCheckoutsRequiringAttention,
  reviewVerdictPresentation,
  sealedEvidenceMessage,
} from '../src/features/recovery/view.ts';
import { parseReviewCheckoutListResponse } from '../src/features/recovery/use-review-checkouts.ts';

function run(overrides: Partial<AgentRunDto> = {}): AgentRunView {
  return {
    runId: 'run-1',
    agentName: 'builder',
    selection: {
      runtimeId: 'claude-agent-sdk',
      accountId: 'personal',
      model: 'claude-opus',
      effort: { kind: 'selected', value: 'high' },
    },
    specialistRevision: 'sha256:revision',
    nativeSessionIdPresent: true,
    continuationState: 'clean-started',
    projectId: 'project-1',
    dispatcherSessionId: 'session-1',
    worktreeDir: 'C:\\repo-worktrees\\run-1',
    startedAt: 10,
    status: 'failed',
    lifecycleState: 'failed',
    result: '',
    failureReason: 'server restarted while the run was live',
    failureCause: 'server-restart',
    endedAt: 20,
    rev: 3,
    dismissedAt: null,
    continues: null,
    stalled: false,
    priorAttempts: [],
    ...overrides,
  };
}

function contract(overrides: Partial<Contract> = {}): Contract {
  return {
    id: 'contract-1',
    projectId: 'project-1',
    pmRef: null,
    agentRunId: 'run-1',
    podName: 'builder',
    expectedOutput: { kind: 'repo' },
    acceptanceCriteria: null,
    verificationTier: null,
    verificationStatus: 'pending',
    verificationNotes: null,
    report: null,
    deliverable: null,
    worktreePath: 'C:\\repo-worktrees\\run-1',
    worktreeBaseBranch: 'main',
    worktreeBaseSha: 'a'.repeat(40),
    landingStatus: null,
    landedBranch: null,
    landedSha: null,
    landingError: null,
    landedAt: null,
    targetShaBefore: null,
    targetShaAfter: null,
    mergeSha: null,
    landingAuthorizer: null,
    verifiedBaseSha: null,
    landingPolicy: null,
    reviewRound: null,
    reviewRunId: null,
    reviewSealedCommit: null,
    abandonmentReceipt: null,
    abandonmentTeardownReceipt: null,
    abandonmentError: null,
    status: 'issued',
    version: 2,
    createdAt: 1,
    updatedAt: 2,
    ...overrides,
  };
}

function worktree(overrides: Partial<StrandedWorktreeDto> = {}): StrandedWorktreeDto {
  return {
    id: 'worktree-1',
    name: 'run-1',
    path: 'C:\\repo-worktrees\\run-1',
    branch: 'run-1',
    baseBranch: 'main',
    agentRunId: 'run-1',
    contractId: 'contract-1',
    strandedReason: 'no-live-run',
    strandedAt: 30,
    ...overrides,
  };
}

function reviewCheckout(overrides: Partial<ReviewCheckoutDto> = {}): ReviewCheckoutDto {
  return {
    id: '01J00000000000000000000001',
    projectId: '01J00000000000000000000002',
    contractId: '01J00000000000000000000003',
    contractVersion: 4,
    producerRunId: '01J00000000000000000000004',
    reviewerRunId: '01J00000000000000000000005',
    repositoryIdentity: {
      protocol: 'git-common-dir-v1',
      gitCommonDir: 'C:\\repo\\.git',
      leaseKey: `sha256:${'b'.repeat(64)}`,
    },
    worktreePath: 'C:\\repo-worktrees\\review-00000005',
    ownedRootRealPath: 'C:\\repo-worktrees',
    sealedCommit: 'a'.repeat(40),
    status: 'reserved',
    provisionReceipt: null,
    preparationReceipt: null,
    readinessReceipt: null,
    verdictReceipt: null,
    verdictAppliedAt: null,
    teardownReceipt: null,
    cleanupError: null,
    createdAt: 10,
    updatedAt: 10,
    destroyedAt: null,
    ...overrides,
  };
}

test('strongest evidence wins across merge/landing, retained run, and stranded row', () => {
  const retainedRun = run();
  const retainedContract = contract();
  const exactWorktree = worktree();
  const standalone = worktree({
    id: 'worktree-2',
    name: 'orphan',
    path: 'C:\\repo-worktrees\\orphan',
    branch: 'orphan',
    agentRunId: null,
    contractId: null,
  });

  const projected = buildRecoveryProjection({
    runs: [retainedRun],
    contracts: [retainedContract],
    strongerContractIds: new Set(),
    worktrees: [exactWorktree, standalone],
  });
  assert.equal(projected.runCards.length, 1);
  assert.equal(projected.runCards[0]?.worktree?.id, exactWorktree.id);
  assert.deepEqual(projected.strandedWorktrees.map((item) => item.id), [standalone.id]);

  const priorAttempt = run({
    runId: 'prior-run',
    startedAt: 1,
    failureCause: 'turn-failed',
    failureReason: 'prior attempt failed',
  });
  const deduped = buildRecoveryProjection({
    runs: [priorAttempt, retainedRun],
    contracts: [retainedContract],
    strongerContractIds: new Set(),
    worktrees: [exactWorktree],
  });
  assert.equal(deduped.runCards.length, 1, 'one contract/worktree recovery owner becomes one card');
  assert.equal(deduped.runCards[0]?.run.runId, retainedRun.runId, 'exact current owner wins');

  const stronger = buildRecoveryProjection({
    runs: [retainedRun],
    contracts: [retainedContract],
    strongerContractIds: new Set([retainedContract.id]),
    worktrees: [exactWorktree],
  });
  assert.deepEqual(stronger, { runCards: [], strandedWorktrees: [] });
});

test('a dismissed run is excluded from the recovery projection (FIX B)', () => {
  const dismissed = run({ dismissedAt: 12345 });
  const notDismissed = run({ runId: 'run-2', dismissedAt: null });

  const projected = buildRecoveryProjection({
    runs: [dismissed, notDismissed],
    contracts: [],
    strongerContractIds: new Set(),
    worktrees: [],
  });

  assert.equal(projected.runCards.length, 1, 'only the non-dismissed run remains a recovery card');
  assert.equal(projected.runCards[0]?.run.runId, notDismissed.runId);
  assert.equal(
    projected.runCards.some((card) => card.run.runId === dismissed.runId),
    false,
    'a dismissed run must never appear as a recovery run card',
  );
});

test('merge-ready rows never become recovery failures even without a matching contract', () => {
  const projected = buildRecoveryProjection({
    runs: [run({ status: 'completed', lifecycleState: 'merge-ready', failureCause: null, failureReason: null })],
    contracts: [],
    strongerContractIds: new Set(),
    worktrees: [],
  });
  assert.deepEqual(projected, { runCards: [], strandedWorktrees: [] });
});

test('a landed merge-ready producer remains visible until positive cleanup completes', () => {
  const cleanupContract = contract({
    landingStatus: 'landed',
    landedBranch: 'run-1',
    landedSha: 'b'.repeat(40),
  });
  const projected = buildRecoveryProjection({
    runs: [run({ status: 'completed', lifecycleState: 'merge-ready', failureCause: null, failureReason: null })],
    contracts: [cleanupContract],
    strongerContractIds: new Set(),
    worktrees: [worktree()],
  });
  assert.equal(projected.runCards[0]?.contract?.id, cleanupContract.id);
  assert.equal(projected.runCards[0]?.worktree?.id, 'worktree-1');
});

test('preservation requires exact run, contract, and path evidence', () => {
  const retainedRun = run();
  const retainedContract = contract();
  assert.equal(exactStrandedEvidenceForRun(retainedRun, retainedContract, [worktree()])?.id, 'worktree-1');
  assert.equal(exactStrandedEvidenceForRun(retainedRun, retainedContract, [
    worktree({ agentRunId: 'another-run' }),
  ]), null);
  assert.equal(exactStrandedEvidenceForRun(retainedRun, retainedContract, [
    worktree({ contractId: 'another-contract' }),
  ]), null);
  assert.equal(exactStrandedEvidenceForRun(retainedRun, retainedContract, [
    worktree({ path: 'C:\\repo-worktrees\\other' }),
  ]), null);

  assert.match(preservationEvidenceMessage(worktree()), /confirms the worktree remains preserved/i);
  assert.match(preservationEvidenceMessage(worktree({ strandedReason: 'dir-missing' })), /directory is missing/i);
  assert.match(preservationEvidenceMessage(null), /evidence is unavailable/i);
});

test('typed labels, sealed evidence, and guidance stay provider-neutral', () => {
  assert.equal(recoveryRunLabel(run()), 'server restart');
  assert.equal(recoveryRunLabel(run({
    failureCause: 'worktree-provision-failed',
    lifecycleState: 'provisioning-failed',
  })), 'preparation failed');
  assert.equal(recoveryRunLabel(run({
    failureCause: 'verification-failed',
    lifecycleState: 'verification-failed',
  })), 'verification failed');
  assert.equal(recoveryRunLabel(run({
    status: 'completed',
    failureCause: null,
    lifecycleState: 'review-rejected',
  })), 'review rejected');
  assert.equal(recoveryRunLabel(run({ status: 'cancelled', failureCause: 'cancelled' })), 'cancelled');
  assert.match(recoveryRunGuidance(run()), /ask the orchestrator/i);
  assert.doesNotMatch(recoveryRunGuidance(run()), /claude|codex|native session/i);

  assert.equal(sealedEvidenceMessage(contract()), 'No sealed deliverable is recorded.');
  assert.match(sealedEvidenceMessage(contract({
    deliverable: { kind: 'repo', branch: 'run-1', commit: 'b'.repeat(40) },
  })) ?? '', /bbbbbbbbbbbb/);
  assert.equal(sealedEvidenceMessage(contract({ expectedOutput: { kind: 'answer' } })), null);
});

test('the Dismiss control is offered only for eligible recovery run cards', () => {
  const eligibleFailedNull = { run: run({ status: 'failed', lifecycleState: null }), contract: null, worktree: null };
  const eligibleFailedProv = {
    run: run({ status: 'failed', lifecycleState: 'provisioning-failed' }),
    contract: null,
    worktree: null,
  };
  const eligibleCancelled = {
    run: run({ status: 'cancelled', lifecycleState: null }),
    contract: null,
    worktree: null,
  };
  assert.equal(isDismissibleRecoveryRun(eligibleFailedNull), true);
  assert.equal(isDismissibleRecoveryRun(eligibleFailedProv), true);
  assert.equal(isDismissibleRecoveryRun(eligibleCancelled), true);

  // Not eligible: real recovery evidence retained by the normal flow.
  assert.equal(
    isDismissibleRecoveryRun({ run: run({ lifecycleState: 'verification-failed' }), contract: null, worktree: null }),
    false,
  );
  // Not eligible: a bound stranded worktree is real preserved state.
  assert.equal(
    isDismissibleRecoveryRun({
      run: run({ status: 'failed', lifecycleState: 'provisioning-failed' }),
      contract: null,
      worktree: worktree(),
    }),
    false,
  );
  // Not eligible: a sealed deliverable is real recoverable work.
  assert.equal(
    isDismissibleRecoveryRun({
      run: run({ status: 'failed', lifecycleState: null }),
      contract: contract({ deliverable: { kind: 'repo', branch: 'run-1', commit: 'c'.repeat(40) } }),
      worktree: null,
    }),
    false,
  );
});

test('review checkout read and recovery attention are strict and state-based', () => {
  const reserved = reviewCheckout();
  const pending = reviewCheckout({
    id: '01J00000000000000000000006',
    reviewerRunId: '01J00000000000000000000007',
    status: 'teardown-pending',
    cleanupError: 'locked registration',
    updatedAt: 11,
  });
  assert.deepEqual(
    parseReviewCheckoutListResponse({ ok: true, reviewCheckouts: [reserved, pending] }),
    [reserved, pending],
  );
  assert.deepEqual(reviewCheckoutsRequiringAttention([reserved, pending]).map((item) => item.id), [pending.id]);
  assert.throws(
    () => parseReviewCheckoutListResponse({ ok: true, reviewCheckouts: [pending], native: 'leak' }),
    /invalid review checkout response/,
  );
  assert.throws(
    () => parseReviewCheckoutListResponse({ ok: true, reviewCheckouts: [{ ...reserved, sealedCommit: 'bad' }] }),
    /invalid review checkout response/,
  );
});

test('review verdict presentation accepts only a verified typed reviewer contract', () => {
  const reviewer = contract({
    expectedOutput: { kind: 'payload', semantic: 'verdict', schema: { type: 'object' } },
    verificationStatus: 'passed',
    deliverable: {
      kind: 'payload',
      data: {
        verdict: 'reject',
        findings: [{ file: 'src/a.ts', line: 7, summary: 'unsafe', severity: 'major' }],
      },
    },
  });
  assert.deepEqual(exactReviewVerdictEvidence(reviewer), { verdict: 'reject', findingCount: 1 });
  assert.equal(exactReviewVerdictEvidence(contract({
    ...reviewer,
    verificationStatus: 'failed',
  })), null);
  assert.equal(exactReviewVerdictEvidence(contract({
    ...reviewer,
    deliverable: {
      kind: 'payload',
      data: { verdict: 'approve', findings: [{ file: 'x', summary: 'bad', severity: 'unknown' }] },
    },
  })), null);

  const checkout = reviewCheckout();
  const recorded = reviewCheckout({
    verdictReceipt: {
      protocol: 'review-checkout-verdict-v1',
      id: checkout.id,
      projectId: checkout.projectId,
      contractId: checkout.contractId,
      contractVersion: checkout.contractVersion,
      producerRunId: checkout.producerRunId,
      reviewerRunId: checkout.reviewerRunId,
      repositoryIdentity: checkout.repositoryIdentity,
      worktreePath: checkout.worktreePath,
      ownedRootRealPath: checkout.ownedRootRealPath,
      sealedCommit: checkout.sealedCommit,
      reviewerContractId: reviewer.id,
      terminalStatus: 'completed',
      outcome: 'overridden',
      findings: [],
      recordedAt: 20,
    },
    verdictAppliedAt: null,
  });
  assert.deepEqual(reviewVerdictPresentation(recorded, reviewer), {
    outcome: 'overridden',
    findingCount: 0,
    authority: 'recorded',
    effect: 'pending',
  }, 'immutable receipt overrides the stale submitted reject payload');
  assert.deepEqual(reviewVerdictPresentation(
    { ...recorded, verdictAppliedAt: 21 },
    reviewer,
  ), {
    outcome: 'overridden',
    findingCount: 0,
    authority: 'recorded',
    effect: 'applied',
  });
  assert.deepEqual(reviewVerdictPresentation(checkout, reviewer), {
    outcome: 'reject',
    findingCount: 1,
    authority: 'submitted',
    effect: 'unrecorded',
  });
});

test('activity source keeps separate counts, explicit unavailable retries, and no continuation door', () => {
  const source = readFileSync(new URL('../src/components/ActivityPanel.tsx', import.meta.url), 'utf8');
  assert.match(source, /Recovery required/);
  assert.match(source, /Running agents/);
  assert.match(source, /runReadStatus === 'error'/);
  assert.match(source, /worktreeReadStatus === 'error'/);
  assert.match(source, /reviewCheckoutReadStatus === 'error'/);
  assert.match(source, /Review checkout/);
  assert.match(source, /cleanup pending/);
  assert.match(source, /Recent review evidence/);
  assert.match(source, /cleanup settled/);
  assert.match(source, /status unavailable/);
  assert.match(source, /Running agent status unavailable/);
  assert.match(source, /strandedRead\.status === 'ready' \? strandedRead\.worktrees : \[\]/);
  assert.match(source, /contract \? canRequestAbandonment\(contract\) : false/);
  assert.match(source, />\s*Retry\s*</);
  assert.match(source, />Inspect</);
  assert.match(source, /<AbandonButton/);
  assert.doesNotMatch(source, /dispatchContinue|agent-runs\/\$\{[^}]+\}\/continue/);
});
