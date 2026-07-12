import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  isAgentRunChangedLivePayload,
  isAgentRunDto,
  isPendingAskDto,
  parseAnswerPendingAskRequest,
  parseCancelPendingAskRequest,
  parseCreatePendingAskRequest,
  type AgentRunDto,
} from '../src/index.ts';

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
      phase: 'preparation', ok: true, steps: [], finishedAt: 1,
    },
  }), true);
  assert.equal(isAgentRunDto({
    ...makeDto(),
    readinessReceipt: {
      phase: 'readiness',
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
