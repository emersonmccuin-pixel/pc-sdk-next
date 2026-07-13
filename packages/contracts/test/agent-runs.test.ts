import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  isAgentRunChangedLivePayload,
  isAgentRunDto,
  isReviewCheckoutDto,
  isReviewCheckoutGitReceiptDto,
  isWorktreePhaseReceiptDto,
  isPendingAskDto,
  parseAnswerPendingAskRequest,
  parseCancelPendingAskRequest,
  parseCreatePendingAskRequest,
  type AgentRunDto,
} from '../src/index.ts';

test('review checkout DTO and reviewer Git receipt require exact detached authority', () => {
  const authority = {
    id: '01J00000000000000000000001',
    projectId: '01J00000000000000000000002',
    contractId: '01J00000000000000000000003',
    contractVersion: 4,
    producerRunId: '01J00000000000000000000004',
    reviewerRunId: '01J00000000000000000000005',
    repositoryIdentity: {
      protocol: 'git-common-dir-v1' as const,
      gitCommonDir: '/repo/.git',
      leaseKey: `sha256:${'a'.repeat(64)}`,
    },
    worktreePath: '/repo/reviews/reviewer',
    ownedRootRealPath: '/repo/reviews',
    sealedCommit: 'b'.repeat(40),
  };
  const provision = {
    protocol: 'review-checkout-provision-v1' as const,
    ...authority,
    registrationCount: 1 as const,
    registrationPath: authority.worktreePath,
    headSha: authority.sealedCommit,
    detachedHead: true as const,
    trackedChanges: 0 as const,
    stagedChanges: 0 as const,
    observedAt: 10,
  };
  const gitReceipt = {
    ...provision,
    protocol: 'review-checkout-git-v1' as const,
    branch: '(detached)' as const,
    baseBranch: '(detached)' as const,
    baseSha: authority.sealedCommit,
    cleanStatus: true as const,
  };
  const checkout = {
    ...authority,
    status: 'provisioned' as const,
    provisionReceipt: provision,
    preparationReceipt: null,
    readinessReceipt: null,
    verdictReceipt: null,
    verdictAppliedAt: null,
    teardownReceipt: null,
    cleanupError: null,
    createdAt: 1,
    updatedAt: 10,
    destroyedAt: null,
  };

  assert.equal(isReviewCheckoutDto(checkout), true);
  assert.equal(isReviewCheckoutDto({
    ...checkout,
    provisionReceipt: { ...provision, reviewerRunId: authority.producerRunId },
  }), false);
  assert.equal(isReviewCheckoutGitReceiptDto(gitReceipt), true);
  assert.equal(isAgentRunDto(makeDto({ gitReceipt })), true);
  assert.equal(isReviewCheckoutGitReceiptDto({ ...gitReceipt, branch: 'review-00000005' }), false);
  assert.equal(isReviewCheckoutGitReceiptDto({ ...gitReceipt, providerSessionId: 'leak' }), false);
});

function makeDto(over: Partial<AgentRunDto> = {}): AgentRunDto {
  return {
    runId: 'run1',
    agentName: 'builder',
    selection: {
      runtimeId: 'runtime-a',
      accountId: 'account-a',
      model: 'model-a',
      effort: { kind: 'selected', value: 'high' },
    },
    specialistRevision: 'sha256:abc',
    nativeSessionIdPresent: true,
    continuationState: 'clean-started',
    projectId: 'p1',
    dispatcherSessionId: 'disp1',
    worktreeDir: '/tmp/wt',
    startedAt: 100,
    status: 'running',
    lifecycleState: null,
    result: '',
    failureReason: null,
    failureCause: null,
    endedAt: null,
    rev: 3,
    gitReceipt: null,
    preparationReceipt: null,
    readinessReceipt: null,
    ...over,
  };
}

test('isAgentRunDto accepts a full DTO and rejects malformed', () => {
  assert.equal(isAgentRunDto(makeDto()), true);
  assert.equal(isAgentRunDto({ ...makeDto(), status: 'bogus' }), false);
  assert.equal(isAgentRunDto({ ...makeDto(), rev: 'x' }), false);
  assert.equal(isAgentRunDto({ ...makeDto(), ccSessionId: 'native-leak' }), false);
  assert.equal(isAgentRunDto({ ...makeDto(), continuationAttemptId: 'attempt-leak' }), false);
  assert.equal(isAgentRunDto({ ...makeDto(), continuationState: 'clean-pending' }), false);
  assert.equal(isAgentRunDto({
    ...makeDto(),
    preparationReceipt: { nativeSessionId: 'nested-native-leak' },
  }), false);
  assert.equal(isAgentRunDto({
    ...makeDto(),
    preparationReceipt: {
      phase: 'preparation', outcome: 'not-required', reason: 'no-commands-configured',
      ok: true, steps: [], finishedAt: 1,
    },
  }), true);
  assert.equal(isAgentRunDto({
    ...makeDto(),
    readinessReceipt: {
      phase: 'readiness',
      outcome: 'executed',
      ok: true,
      steps: [{
        command: 'check', exitCode: 0, durationMs: 1, stdoutTail: '', stderrTail: '',
        timedOut: false, nativeSessionId: 'nested-native-leak',
      }],
      finishedAt: 1,
    },
  }), false);
  assert.equal(isAgentRunDto({
    ...makeDto(),
    selection: null,
    specialistRevision: null,
    nativeSessionIdPresent: false,
    continuationState: 'legacy-unavailable',
  }), true);
  assert.equal(isAgentRunDto(null), false);
});

test('phase receipt DTO guard enforces exact outcome-specific evidence', () => {
  const step = {
    command: 'pnpm test', exitCode: 0, durationMs: 1,
    stdoutTail: '', stderrTail: '', timedOut: false,
  };
  const executed = {
    phase: 'readiness', outcome: 'executed', ok: true,
    steps: [step], finishedAt: 10,
  };
  const noCommands = {
    phase: 'preparation', outcome: 'not-required', reason: 'no-commands-configured',
    ok: true, steps: [], finishedAt: 11,
  };
  const inherited = {
    phase: 'preparation', outcome: 'not-required', reason: 'existing-worktree-preparation',
    inheritedFromRunId: '01J00000000000000000000000',
    ok: true, steps: [], finishedAt: 12,
  };
  assert.equal(isWorktreePhaseReceiptDto(executed, 'readiness'), true);
  assert.equal(isWorktreePhaseReceiptDto(noCommands, 'preparation'), true);
  assert.equal(isWorktreePhaseReceiptDto(inherited, 'preparation'), true);

  for (const receipt of [
    { ...executed, steps: [] },
    { ...executed, ok: false },
    { ...executed, steps: [{ ...step, timedOut: true }] },
    { ...executed, steps: [{ ...step, command: ' pnpm test' }] },
    { ...executed, finishedAt: Number.POSITIVE_INFINITY },
    { ...noCommands, inheritedFromRunId: inherited.inheritedFromRunId },
    { ...noCommands, steps: [step] },
    { ...inherited, phase: 'readiness' },
    { ...inherited, inheritedFromRunId: '01j00000000000000000000000' },
    { ...inherited, providerReceipt: 'leak' },
  ]) assert.equal(isWorktreePhaseReceiptDto(receipt), false, JSON.stringify(receipt));
});

test('repository identity receipts are strict while retained legacy receipts remain readable', () => {
  const gitReceipt = {
    worktreePath: '/tmp/wt',
    branch: 'run-1',
    baseBranch: 'main',
    baseSha: 'abc123',
    cleanStatus: true,
    repositoryIdentity: {
      protocol: 'git-common-dir-v1' as const,
      gitCommonDir: '/tmp/repo/.git',
      leaseKey: `sha256:${'a'.repeat(64)}`,
    },
  };

  assert.equal(isAgentRunDto(makeDto({ gitReceipt })), true);
  assert.equal(isAgentRunDto(makeDto({
    gitReceipt: { ...gitReceipt, repositoryIdentity: undefined },
  })), true);
  assert.equal(isAgentRunDto(makeDto({
    gitReceipt: { ...gitReceipt, repositoryIdentity: null },
  })), true);
  assert.equal(isAgentRunDto({ ...makeDto(),
    gitReceipt: {
      ...gitReceipt,
      repositoryIdentity: { ...gitReceipt.repositoryIdentity, protocol: 'git-dir-v0' },
    },
  }), false);
  assert.equal(isAgentRunDto({ ...makeDto(),
    gitReceipt: {
      ...gitReceipt,
      repositoryIdentity: { ...gitReceipt.repositoryIdentity, gitCommonDir: '  ' },
    },
  }), false);
  assert.equal(isAgentRunDto({ ...makeDto(),
    gitReceipt: {
      ...gitReceipt,
      repositoryIdentity: { ...gitReceipt.repositoryIdentity, leaseKey: `sha256:${'A'.repeat(64)}` },
    },
  }), false);
  assert.equal(isAgentRunDto({ ...makeDto(),
    gitReceipt: {
      ...gitReceipt,
      repositoryIdentity: {
        ...gitReceipt.repositoryIdentity,
        leaseKey: { toString: () => gitReceipt.repositoryIdentity.leaseKey },
      },
    },
  }), false);
  assert.equal(isAgentRunDto({ ...makeDto(),
    gitReceipt: {
      ...gitReceipt,
      repositoryIdentity: { ...gitReceipt.repositoryIdentity, nativeSessionId: 'leak' },
    },
  }), false);
});

test('pending and failed continuation provenance accepts every legitimate durable phase', () => {
  for (const status of ['failed', 'cancelled'] as const) {
    assert.equal(isAgentRunDto(makeDto({
      status,
      nativeSessionIdPresent: false,
      continuationState: 'clean-pending',
      endedAt: 2,
    })), true);
  }
  for (const status of ['paused', 'failed'] as const) {
    assert.equal(isAgentRunDto(makeDto({ status, continuationState: 'resume-pending' })), true);
    assert.equal(isAgentRunDto(makeDto({ status, continuationState: 'resume-failed' })), true);
  }
  assert.equal(isAgentRunDto(makeDto({
    status: 'running', nativeSessionIdPresent: false, continuationState: 'clean-pending',
  })), false);
  assert.equal(isAgentRunDto(makeDto({ status: 'running', continuationState: 'resume-pending' })), false);
  assert.equal(isAgentRunDto(makeDto({ status: 'queued', continuationState: 'clean-started' })), false);
  assert.equal(isAgentRunDto(makeDto({ status: 'queued', continuationState: 'native-resumed' })), false);
});

test('isPendingAskDto accepts a full DTO and rejects bad kind/status', () => {
  const ask = {
    id: 'a1',
    agentRunId: 'run1',
    projectId: 'p1',
    pmRef: null,
    kind: 'orchestrator',
    promptBody: 'q?',
    context: null,
    options: [{ label: 'Yes', value: 'y' }],
    status: 'open',
    answeredBy: null,
    createdAt: 1,
    answeredAt: null,
    cancelledAt: null,
  };
  assert.equal(isPendingAskDto(ask), true);
  assert.equal(isPendingAskDto({ ...ask, kind: 'nope' }), false);
  assert.equal(isPendingAskDto({ ...ask, status: 'waiting' }), false);
  assert.equal(isPendingAskDto({ ...ask, nativeSessionId: 'leak' }), false);
  assert.equal(isPendingAskDto({
    ...ask,
    options: [{ label: 'Yes', value: 'y', nativeSessionId: 'nested-leak' }],
  }), false);
});

test('canonical agent-run payload guard validates reason + run', () => {
  assert.equal(isAgentRunChangedLivePayload({
    reason: 'paused', run: makeDto({ status: 'paused' }), pendingAskId: 'a1',
  }), true);
  assert.equal(
    isAgentRunChangedLivePayload({ reason: 'paused', run: makeDto({ status: 'paused' }) }),
    false,
  );
  assert.equal(isAgentRunChangedLivePayload({ reason: 'bogus', run: makeDto() }), false);
  assert.equal(isAgentRunChangedLivePayload({ reason: 'paused' }), false);
  assert.equal(
    isAgentRunChangedLivePayload({
      reason: 'paused', run: makeDto({ status: 'paused' }), pendingAskId: 'a1',
      nativeSessionId: 'leak',
    }),
    false,
  );
  assert.equal(isAgentRunChangedLivePayload({ reason: 'completed', run: makeDto() }), false);
  assert.equal(isAgentRunChangedLivePayload({
    reason: 'completed', run: makeDto({ status: 'completed', endedAt: 2 }),
  }), true);
});

test('parseCreatePendingAskRequest requires options for approval kind', () => {
  assert.equal(
    parseCreatePendingAskRequest({ agentRunId: 'r1', kind: 'approval', promptBody: 'ok?' }).ok,
    false,
  );
  const ok = parseCreatePendingAskRequest({
    agentRunId: 'r1',
    kind: 'approval',
    promptBody: 'ok?',
    options: [{ label: 'Yes', value: 'y' }],
  });
  assert.equal(ok.ok, true);
  assert.equal(parseCreatePendingAskRequest({ agentRunId: 'r1', kind: 'orchestrator', promptBody: 'q' }).ok, true);
  assert.equal(parseCreatePendingAskRequest({ kind: 'orchestrator', promptBody: 'q' }).ok, false);
  assert.equal(parseCreatePendingAskRequest({
    agentRunId: 'r1', kind: 'approval', promptBody: 'ok?', options: [],
  }).ok, false);
  assert.equal(parseCreatePendingAskRequest({
    agentRunId: 'r1', kind: 'approval', promptBody: 'ok?',
    options: [{ label: 'Yes', value: 'y', nativeSessionId: 'leak' }],
  }).ok, false);
  assert.equal(parseCreatePendingAskRequest({
    agentRunId: 'r1', kind: 'orchestrator', promptBody: 'q', raw: 'extra',
  }).ok, false);
});

test('parseAnswerPendingAskRequest enforces answer + answeredBy enum', () => {
  assert.equal(parseAnswerPendingAskRequest({ answer: 'a' }).ok, false);
  assert.equal(parseAnswerPendingAskRequest({ answer: 'a', answeredBy: 'bot' }).ok, false);
  assert.equal(parseAnswerPendingAskRequest({ answer: 'a', answeredBy: 'user' }).ok, true);
  assert.equal(parseAnswerPendingAskRequest({
    answer: 'a', answeredBy: 'user', nativeSessionId: 'leak',
  }).ok, false);
});

test('parseCancelPendingAskRequest accepts only the empty request shape', () => {
  assert.equal(parseCancelPendingAskRequest(undefined).ok, true);
  assert.equal(parseCancelPendingAskRequest(null).ok, true);
  assert.equal(parseCancelPendingAskRequest({}).ok, true);
  assert.equal(parseCancelPendingAskRequest({ nativeSessionId: 'leak' }).ok, false);
  assert.equal(parseCancelPendingAskRequest({ continuationAttemptId: 'leak' }).ok, false);
});
