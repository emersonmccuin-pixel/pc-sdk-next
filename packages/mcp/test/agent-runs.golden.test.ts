import { test } from 'node:test';
import assert from 'node:assert/strict';

import { handleAgentRunTool } from '../src/tools/agent-runs.ts';
import { makeFakeContext, ok, err, firstText } from './helpers.ts';

// 11E golden text-compat tests — byte-identical result strings + frozen wire.

const BASE = {
  projectId: 'P01',
  dispatcherSessionId: 'DSESS',
  agentRunId: 'AR1',
};

function agentRun(runId = 'RUN1') {
  return {
    runId,
    agentName: 'researcher',
    selection: {
      runtimeId: 'runtime-a',
      accountId: 'account-a',
      model: 'model-a',
      effort: { kind: 'none' },
    },
    specialistRevision: 'sha256:researcher',
    nativeSessionIdPresent: false,
    continuationState: 'clean-pending',
    projectId: 'P01',
    dispatcherSessionId: 'DSESS',
    worktreeDir: '',
    startedAt: 1,
    status: 'queued',
    lifecycleState: null,
    result: '',
    failureReason: null,
    failureCause: null,
    endedAt: null,
    rev: 1,
  };
}

function pendingAsk(overrides: Record<string, unknown> = {}) {
  return {
    id: 'PA1',
    agentRunId: 'AR1',
    projectId: 'P01',
    pmRef: null,
    kind: 'orchestrator',
    promptBody: 'which way?',
    context: null,
    options: null,
    status: 'open',
    answeredBy: null,
    createdAt: 1,
    answeredAt: null,
    cancelledAt: null,
    ...overrides,
  };
}

function invokeResponse(run = agentRun()) {
  return { ok: true, mode: 'async', run };
}

function createAskResponse(ask = pendingAsk()) {
  return {
    ok: true,
    pendingAsk: ask,
    status: 'waiting',
    message: 'run paused',
  };
}

test('pc_invoke_agent success: emits raw body; posts invoke payload', async () => {
  const serverBody = JSON.stringify(invokeResponse());
  const { ctx, calls } = makeFakeContext({ ...BASE, responder: () => ok(serverBody) });
  const res = await handleAgentRunTool(
    'pc_invoke_agent',
    { name: 'researcher', input: 'Begin.', pmRef: 'AINPM-42' },
    ctx,
  );
  assert.equal(firstText(res), serverBody);
  assert.deepEqual(calls[0], {
    method: 'POST',
    path: '/api/projects/P01/agents/researcher/invoke',
    body: {
      input: 'Begin.',
      parentInvokeDepth: 0,
      dispatcherSessionId: 'DSESS',
      pmRef: 'AINPM-42',
    },
  });
});

test('pc_invoke_agent failure: exact failure string', async () => {
  const { ctx } = makeFakeContext({ ...BASE, responder: () => err(500, 'boom') });
  const res = await handleAgentRunTool(
    'pc_invoke_agent',
    { name: 'researcher', input: 'Begin.' },
    ctx,
  );
  assert.equal(firstText(res), 'pc_invoke_agent failed (500): boom');
  assert.equal(res!.isError, true);
});

test('pc_continue_agent success: emits raw body; posts continue payload', async () => {
  const serverBody = JSON.stringify(invokeResponse(agentRun('RUN2')));
  const { ctx, calls } = makeFakeContext({ ...BASE, responder: () => ok(serverBody) });
  const res = await handleAgentRunTool(
    'pc_continue_agent',
    { runId: 'RUN1', input: 'keep going' },
    ctx,
  );
  assert.equal(firstText(res), serverBody);
  assert.deepEqual(calls[0], {
    method: 'POST',
    path: '/api/projects/P01/agent-runs/RUN1/continue',
    body: { input: 'keep going', dispatcherSessionId: 'DSESS' },
  });
});

test('pc_ask_orchestrator success: emits raw body; posts pending-ask', async () => {
  const serverBody = JSON.stringify(createAskResponse());
  const { ctx, calls } = makeFakeContext({ ...BASE, responder: () => ok(serverBody) });
  const res = await handleAgentRunTool(
    'pc_ask_orchestrator',
    { question: 'which way?' },
    ctx,
  );
  assert.equal(firstText(res), serverBody);
  assert.deepEqual(calls[0], {
    method: 'POST',
    path: '/api/projects/P01/agent-pending-asks',
    body: { agentRunId: 'AR1', kind: 'orchestrator', promptBody: 'which way?' },
  });
});

// M7 (FD-6): ☠ pc_ask_user — options now ride the ONE ask door.
test('pc_ask_orchestrator with options: options forwarded', async () => {
  const ask = pendingAsk({ options: [{ value: 'a', label: 'A' }] });
  const { ctx, calls } = makeFakeContext({
    ...BASE,
    responder: () => ok(createAskResponse(ask)),
  });
  await handleAgentRunTool(
    'pc_ask_orchestrator',
    { question: 'pick', options: [{ value: 'a', label: 'A' }] },
    ctx,
  );
  assert.deepEqual(calls[0].body, {
    agentRunId: 'AR1',
    kind: 'orchestrator',
    promptBody: 'pick',
    options: [{ value: 'a', label: 'A' }],
  });
});

test('pc_ask_user is gone (M7 FD-6): unknown tool returns null', async () => {
  const { ctx } = makeFakeContext({ ...BASE, responder: () => ok('{}') });
  const res = await handleAgentRunTool(
    'pc_ask_user',
    { question: 'pick' },
    ctx,
  );
  assert.equal(res, null);
});

test('pc_request_approval success: kind=approval', async () => {
  const ask = pendingAsk({
    kind: 'approval',
    promptBody: 'proceed?',
    options: [{ value: 'y', label: 'Yes' }],
  });
  const { ctx, calls } = makeFakeContext({
    ...BASE,
    responder: () => ok(createAskResponse(ask)),
  });
  await handleAgentRunTool(
    'pc_request_approval',
    { decision: 'proceed?', options: [{ value: 'y', label: 'Yes' }] },
    ctx,
  );
  assert.deepEqual(calls[0].body, {
    agentRunId: 'AR1',
    kind: 'approval',
    promptBody: 'proceed?',
    options: [{ value: 'y', label: 'Yes' }],
  });
});

test('pc_request_approval failure: exact failure string preserves toolName prefix', async () => {
  const { ctx } = makeFakeContext({ ...BASE, responder: () => err(409, 'conflict') });
  const res = await handleAgentRunTool(
    'pc_request_approval',
    { decision: 'proceed?', options: [{ value: 'y', label: 'Yes' }] },
    ctx,
  );
  assert.equal(firstText(res), 'pc_request_approval failed (409): conflict');
  assert.equal(res!.isError, true);
});

test('pc_answer_pending success: emits raw body; posts answer', async () => {
  const serverBody = JSON.stringify({
    ok: true,
    pendingAsk: pendingAsk({
      status: 'answered',
      answeredBy: 'orchestrator',
      answeredAt: 2,
    }),
  });
  const { ctx, calls } = makeFakeContext({ ...BASE, responder: () => ok(serverBody) });
  const res = await handleAgentRunTool(
    'pc_answer_pending',
    { pendingAskId: 'PA1', answer: '42', answeredBy: 'orchestrator' },
    ctx,
  );
  assert.equal(firstText(res), serverBody);
  assert.deepEqual(calls[0], {
    method: 'POST',
    path: '/api/projects/P01/agent-pending-asks/PA1/answer',
    body: { answer: '42', answeredBy: 'orchestrator' },
  });
});

test('typed agent and pending-ask tools never relay malformed 2xx bodies', async () => {
  const secret = 'provider-native-secret';
  const cases = [
    {
      tool: 'pc_invoke_agent',
      args: { name: 'researcher', input: 'Begin.' },
      body: invokeResponse({ ...agentRun(), nativeSessionId: secret }),
    },
    {
      tool: 'pc_continue_agent',
      args: { runId: 'RUN1', input: 'Continue.' },
      body: { ...invokeResponse(), continuationAttemptId: secret },
    },
    {
      tool: 'pc_ask_orchestrator',
      args: { question: 'which way?' },
      body: createAskResponse({ ...pendingAsk(), nativeSessionId: secret }),
    },
    {
      tool: 'pc_answer_pending',
      args: { pendingAskId: 'PA1', answer: '42', answeredBy: 'orchestrator' },
      body: { ok: true, pendingAsk: pendingAsk(), continuationAttemptId: secret },
    },
  ] as const;

  for (const candidate of cases) {
    const raw = JSON.stringify(candidate.body);
    const { ctx } = makeFakeContext({ ...BASE, responder: () => ok(raw) });
    const result = await handleAgentRunTool(candidate.tool, candidate.args, ctx);
    assert.equal(result?.isError, true, `${candidate.tool} must reject malformed 2xx`);
    assert.match(firstText(result), /invalid localhost response/);
    assert.doesNotMatch(firstText(result), new RegExp(secret));
    assert.notEqual(firstText(result), raw);
  }
});

test('pc_submit_deliverable success: posts to run deliverable route, merges kind', async () => {
  const serverBody = JSON.stringify({ ok: true, contractId: 'C1', status: 'submitted' });
  const { ctx, calls } = makeFakeContext({ ...BASE, responder: () => ok(serverBody) });
  const res = await handleAgentRunTool(
    'pc_submit_deliverable',
    { kind: 'answer', deliverable: { text: 'Node LTS is 22.' }, report: 'done' },
    ctx,
  );
  assert.equal(firstText(res), serverBody);
  assert.deepEqual(calls[0], {
    method: 'POST',
    path: '/api/projects/P01/agent-runs/AR1/deliverable',
    body: { agentRunId: 'AR1', deliverable: { text: 'Node LTS is 22.', kind: 'answer' }, report: 'done' },
  });
});

test('pc_submit_deliverable requires PC_AGENT_RUN_ID', async () => {
  const { ctx } = makeFakeContext({ projectId: 'P01', dispatcherSessionId: 'D', responder: () => ok('{}') });
  const res = await handleAgentRunTool('pc_submit_deliverable', { kind: 'answer' }, ctx);
  assert.equal(res!.isError, true);
  assert.match(firstText(res), /PC_AGENT_RUN_ID not set/);
});

test('pc_submit_deliverable failure: exact failure string', async () => {
  const { ctx } = makeFakeContext({ ...BASE, responder: () => err(400, 'kind-mismatch') });
  const res = await handleAgentRunTool('pc_submit_deliverable', { kind: 'repo' }, ctx);
  assert.equal(firstText(res), 'pc_submit_deliverable failed (400): kind-mismatch');
  assert.equal(res!.isError, true);
});

test('pc_list_my_runs success: emits raw body (left raw — no covering DTO)', async () => {
  const serverBody = JSON.stringify({ ok: true, runs: [] });
  const { ctx, calls } = makeFakeContext({ ...BASE, responder: () => ok(serverBody) });
  const res = await handleAgentRunTool('pc_list_my_runs', {}, ctx);
  assert.equal(firstText(res), serverBody);
  assert.equal(calls[0].path, '/api/projects/P01/agent-runs/by-dispatcher?dispatcherSessionId=DSESS');
});

test('pc_inspect_agent_run success: emits raw body (left raw)', async () => {
  const serverBody = JSON.stringify({ ok: true, inspection: { runId: 'RUN1' } });
  const { ctx, calls } = makeFakeContext({ ...BASE, responder: () => ok(serverBody) });
  const res = await handleAgentRunTool('pc_inspect_agent_run', { runId: 'RUN1' }, ctx);
  assert.equal(firstText(res), serverBody);
  assert.equal(calls[0].path, '/api/projects/P01/agent-runs/RUN1/inspect');
});
