import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  isAgentRunChangedLivePayload,
  isAgentRunDto,
  isPendingAskDto,
  parseAnswerPendingAskRequest,
  parseCreatePendingAskRequest,
  type AgentRunDto,
} from '../src/index.ts';

function makeDto(over: Partial<AgentRunDto> = {}): AgentRunDto {
  return {
    runId: 'run1',
    sessionId: 'cc-1',
    agentName: 'builder',
    model: 'opus',
    projectId: 'p1',
    dispatcherSessionId: 'disp1',
    worktreeDir: '/tmp/wt',
    startedAt: 100,
    status: 'running',
    result: '',
    failureReason: null,
    failureCause: null,
    endedAt: null,
    rev: 3,
    ...over,
  };
}

test('isAgentRunDto accepts a full DTO and rejects malformed', () => {
  assert.equal(isAgentRunDto(makeDto()), true);
  assert.equal(isAgentRunDto({ ...makeDto(), status: 'bogus' }), false);
  assert.equal(isAgentRunDto({ ...makeDto(), rev: 'x' }), false);
  assert.equal(isAgentRunDto(null), false);
});

test('isPendingAskDto accepts a full DTO and rejects bad kind/status', () => {
  const ask = {
    id: 'a1',
    agentRunId: 'run1',
    ccSessionId: 'cc-1',
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
});

test('canonical agent-run payload guard validates reason + run', () => {
  assert.equal(isAgentRunChangedLivePayload({ reason: 'paused', run: makeDto() }), true);
  assert.equal(
    isAgentRunChangedLivePayload({ reason: 'paused', run: makeDto(), pendingAskId: 'a1' }),
    true,
  );
  assert.equal(isAgentRunChangedLivePayload({ reason: 'bogus', run: makeDto() }), false);
  assert.equal(isAgentRunChangedLivePayload({ reason: 'paused' }), false);
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
});

test('parseAnswerPendingAskRequest enforces answer + answeredBy enum', () => {
  assert.equal(parseAnswerPendingAskRequest({ answer: 'a' }).ok, false);
  assert.equal(parseAnswerPendingAskRequest({ answer: 'a', answeredBy: 'bot' }).ok, false);
  assert.equal(parseAnswerPendingAskRequest({ answer: 'a', answeredBy: 'user' }).ok, true);
});
