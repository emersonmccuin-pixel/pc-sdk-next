import assert from 'node:assert/strict';
import { resolve } from 'node:path';
import { test } from 'node:test';
import type { ServerRequest } from '../src/runner/codex/generated/ServerRequest.ts';
import type { ThreadItem } from '../src/runner/codex/generated/v2/ThreadItem.ts';
import {
  captureCodexDiscovery,
  captureInterruptResponse,
  captureProviderFreePolicyReceipt,
  captureProviderFreeTurnBoundaryReceipt,
  captureRuntimeNotification,
  captureThreadPeerReceipt,
  captureTurnStartResponse,
  CodexRuntimeMappingError,
  type CodexRuntimeMappingErrorCode,
} from '../src/runner/codex/runtime-mapping.ts';
import {
  CODEX_MODEL_PROVIDER,
  CODEX_PROTOCOL_VERSION,
  CODEX_RUNTIME_ID,
  CODEX_RUNTIME_NOTIFICATION_METHODS,
  CODEX_RUNTIME_REQUEST_METHODS,
  type CodexExecutionPolicyChallenge,
  type CodexTurnBoundaryChallenge,
} from '../src/runner/codex/runtime-peer.ts';

const ACCOUNT_ID = 'codex-personal';
const MODEL_ID = 'gpt-5.4';
const EFFORT = 'high';
const CWD = resolve('test-fixtures/codex-provider-free');
const THREAD_ID = '01900100-0000-7000-8000-000000000001';
const RESUME_THREAD_ID = '01900100-0000-7000-8000-000000000002';
const TURN_ID = '01900100-0000-7000-8000-000000000003';
const ITEM_ID = '01900100-0000-7000-8000-000000000004';
const PRIVATE_PROSE = 'PRIVATE provider payload must never cross';

function challenge(
  mode: 'create' | 'resume' = 'create',
): CodexExecutionPolicyChallenge {
  return {
    kind: 'provider-free-execution-policy-challenge',
    protocolVersion: CODEX_PROTOCOL_VERSION,
    runtimeId: CODEX_RUNTIME_ID,
    continuationAttemptId: 'codex-provider-free-attempt',
    selection: {
      runtimeId: CODEX_RUNTIME_ID,
      accountId: ACCOUNT_ID,
      model: MODEL_ID,
      effort: { kind: 'selected', value: EFFORT },
    },
    mode,
    requestedThreadId: mode === 'resume' ? RESUME_THREAD_ID : null,
    cwd: CWD,
    requestMethods: [...CODEX_RUNTIME_REQUEST_METHODS],
    notificationMethods: [...CODEX_RUNTIME_NOTIFICATION_METHODS],
  };
}

function policyReceipt(expected = challenge()): Record<string, unknown> {
  return {
    kind: 'provider-free-conformance',
    protocolVersion: CODEX_PROTOCOL_VERSION,
    runtimeId: CODEX_RUNTIME_ID,
    continuationAttemptId: expected.continuationAttemptId,
    selection: structuredClone(expected.selection),
    mode: expected.mode,
    requestedThreadId: expected.requestedThreadId,
    cwd: expected.cwd,
    requestMethods: [...CODEX_RUNTIME_REQUEST_METHODS],
    notificationMethods: [...CODEX_RUNTIME_NOTIFICATION_METHODS],
    effectiveNativeTools: [],
    effectiveMcpServers: [],
    approvalRequests: 'disabled',
    lifecycle: 'contained-fake',
  };
}

function threadReceipt(
  expected = challenge(),
  nativeThreadId = expected.requestedThreadId ?? THREAD_ID,
): Record<string, unknown> {
  return {
    policyReceipt: policyReceipt(expected),
    response: {
      thread: thread(nativeThreadId, expected.cwd),
      model: expected.selection.model,
      modelProvider: CODEX_MODEL_PROVIDER,
      serviceTier: null,
      cwd: expected.cwd,
      instructionSources: [],
      approvalPolicy: 'never',
      approvalsReviewer: 'user',
      sandbox: { type: 'readOnly', networkAccess: false },
      reasoningEffort: expected.selection.effort.kind === 'selected'
        ? expected.selection.effort.value
        : null,
    },
  };
}

function thread(id: string, cwd: string): Record<string, unknown> {
  return {
    id,
    sessionId: `session-${id}`,
    forkedFromId: null,
    parentThreadId: null,
    preview: '',
    ephemeral: false,
    modelProvider: CODEX_MODEL_PROVIDER,
    createdAt: 1,
    updatedAt: 2,
    recencyAt: null,
    status: { type: 'idle' },
    path: null,
    cwd,
    cliVersion: CODEX_PROTOCOL_VERSION,
    source: 'appServer',
    threadSource: null,
    agentNickname: null,
    agentRole: null,
    gitInfo: null,
    name: null,
    turns: [],
  };
}

function turn(
  status: 'completed' | 'interrupted' | 'failed' | 'inProgress',
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    id: TURN_ID,
    items: [],
    itemsView: 'full',
    status,
    error: status === 'failed'
      ? { message: PRIVATE_PROSE, codexErrorInfo: null, additionalDetails: PRIVATE_PROSE }
      : null,
    startedAt: 1,
    completedAt: status === 'inProgress' ? null : 2,
    durationMs: status === 'inProgress' ? null : 12,
    ...overrides,
  };
}

function agentMessage(text: string): ThreadItem {
  return {
    type: 'agentMessage',
    id: ITEM_ID,
    text,
    phase: 'final_answer',
    memoryCitation: null,
  };
}

function assertMappingError(
  operation: () => unknown,
  code: CodexRuntimeMappingErrorCode,
): void {
  assert.throws(operation, (error: unknown) => {
    assert.ok(error instanceof CodexRuntimeMappingError);
    assert.equal(error.code, code);
    assert.doesNotMatch(error.message, /PRIVATE|provider payload|native-agent|secret/iu);
    return true;
  });
}

test('Codex discovery capture is exact, normalized, and defensively copied', () => {
  const observation = {
    status: 'available',
    protocolVersion: CODEX_PROTOCOL_VERSION,
    runtimeId: CODEX_RUNTIME_ID,
    accountId: ACCOUNT_ID,
    models: [{
      id: MODEL_ID,
      resolvedId: null,
      label: 'GPT-5.4',
      description: 'Provider-free catalog model',
      effort: { status: 'supported', values: ['low', EFFORT] },
    }],
  };
  const captured = captureCodexDiscovery(observation, ACCOUNT_ID);
  assert.deepEqual(captured, {
    status: 'available',
    models: [{
      id: MODEL_ID,
      resolvedId: null,
      label: 'GPT-5.4',
      description: 'Provider-free catalog model',
      effort: { status: 'supported', values: ['low', EFFORT] },
    }],
  });

  observation.models[0]!.id = 'mutated-native-model';
  observation.models[0]!.effort.values[0] = 'mutated-native-effort';
  assert.equal(captured.status, 'available');
  if (captured.status === 'available') {
    assert.equal(captured.models[0]?.id, MODEL_ID);
    assert.deepEqual(captured.models[0]?.effort, {
      status: 'supported',
      values: ['low', EFFORT],
    });
  }

  assert.deepEqual(captureCodexDiscovery({
    status: 'unavailable',
    protocolVersion: CODEX_PROTOCOL_VERSION,
    runtimeId: CODEX_RUNTIME_ID,
    accountId: ACCOUNT_ID,
    code: 'private-native-auth-prose',
  }, ACCOUNT_ID), {
    status: 'unavailable',
    code: 'codex-discovery-unavailable',
  });
});

test('Codex discovery rejects hostile shape, identity, duplicate, and accessor mutations', () => {
  const valid = {
    status: 'available',
    protocolVersion: CODEX_PROTOCOL_VERSION,
    runtimeId: CODEX_RUNTIME_ID,
    accountId: ACCOUNT_ID,
    models: [{
      id: MODEL_ID,
      resolvedId: null,
      label: 'GPT-5.4',
      description: '',
      effort: { status: 'supported', values: ['low', EFFORT] },
    }],
  };
  const invalid: unknown[] = [
    null,
    { ...valid, protocolVersion: '0.145.0' },
    { ...valid, runtimeId: 'not-codex' },
    { ...valid, accountId: 'other-account' },
    { ...valid, extra: true },
    { ...valid, models: [] },
    { ...valid, models: [valid.models[0], structuredClone(valid.models[0])] },
    { ...valid, models: [{ ...valid.models[0], id: ` ${MODEL_ID}` }] },
    { ...valid, models: [{ ...valid.models[0], effort: { status: 'supported', values: [] } }] },
    { ...valid, models: [{ ...valid.models[0], effort: { status: 'supported', values: ['low', 'low'] } }] },
  ];
  for (const value of invalid) {
    assertMappingError(() => captureCodexDiscovery(value, ACCOUNT_ID), 'discovery-invalid');
  }

  const accessor = structuredClone(valid) as Record<string, unknown>;
  Object.defineProperty(accessor, 'models', {
    enumerable: true,
    get() { throw new Error(`${PRIVATE_PROSE}: discovery getter`); },
  });
  assertMappingError(() => captureCodexDiscovery(accessor, ACCOUNT_ID), 'discovery-invalid');
});

test('provider-free policy capture requires an exact complete challenge echo', () => {
  const expected = challenge('resume');
  const value = policyReceipt(expected);
  const captured = captureProviderFreePolicyReceipt(value, expected);
  assert.deepEqual(captured, value);

  (value.selection as { model: string }).model = 'mutated-native-model';
  (value.requestMethods as string[])[0] = 'fs/writeFile';
  assert.equal(captured.selection.model, MODEL_ID);
  assert.deepEqual(captured.requestMethods, CODEX_RUNTIME_REQUEST_METHODS);
});

test('provider-free policy mismatch matrix fails before execution admission', () => {
  const expected = challenge('resume');
  const mutations: Array<[string, (value: Record<string, unknown>) => void]> = [
    ['kind', (value) => { value.kind = 'native-production'; }],
    ['protocol', (value) => { value.protocolVersion = '0.145.0'; }],
    ['runtime', (value) => { value.runtimeId = 'other-runtime'; }],
    ['attempt', (value) => { value.continuationAttemptId = 'stale-attempt'; }],
    ['selection', (value) => {
      (value.selection as { model: string }).model = 'different-model';
    }],
    ['mode', (value) => { value.mode = 'create'; }],
    ['thread', (value) => { value.requestedThreadId = THREAD_ID; }],
    ['cwd', (value) => { value.cwd = 'E:\\wrong'; }],
    ['request methods', (value) => {
      value.requestMethods = [...CODEX_RUNTIME_REQUEST_METHODS].reverse();
    }],
    ['notification methods', (value) => {
      value.notificationMethods = [...CODEX_RUNTIME_NOTIFICATION_METHODS, 'warning'];
    }],
    ['native tools', (value) => { value.effectiveNativeTools = ['shell']; }],
    ['MCP', (value) => { value.effectiveMcpServers = ['private-mcp']; }],
    ['approvals', (value) => { value.approvalRequests = 'routed'; }],
    ['lifecycle', (value) => { value.lifecycle = 'direct-child'; }],
    ['extra key', (value) => { value.extra = true; }],
  ];
  for (const [label, mutate] of mutations) {
    const value = policyReceipt(expected);
    mutate(value);
    assertMappingError(
      () => captureProviderFreePolicyReceipt(value, expected),
      'execution-policy-invalid',
    );
    assert.ok(label.length > 0);
  }
});

test('thread receipt capture proves exact create and exact resume without native payload escape', () => {
  const createExpected = challenge('create');
  assert.deepEqual(captureThreadPeerReceipt(threadReceipt(createExpected), createExpected), {
    nativeThreadId: THREAD_ID,
    historicalTurnIds: [],
    historicalItemIds: [],
    policyReceipt: policyReceipt(createExpected),
  });

  const resumeExpected = challenge('resume');
  const resumeReceipt = threadReceipt(resumeExpected);
  threadObject(resumeReceipt).gitInfo = {
    sha: '0123456789abcdef',
    branch: 'codex/cx-002',
    originUrl: 'https://example.invalid/repository.git',
  };
  threadObject(resumeReceipt).turns = [turn('completed', {
    id: '01900100-0000-7000-8000-000000000009',
    items: [{ type: 'reasoning', id: ITEM_ID, summary: [PRIVATE_PROSE], content: [] }],
  })];
  const capturedResume = captureThreadPeerReceipt(resumeReceipt, resumeExpected);
  assert.deepEqual(capturedResume, {
    nativeThreadId: RESUME_THREAD_ID,
    historicalTurnIds: ['01900100-0000-7000-8000-000000000009'],
    historicalItemIds: [ITEM_ID],
    policyReceipt: policyReceipt(resumeExpected),
  });
  assert.doesNotMatch(JSON.stringify(capturedResume), /PRIVATE provider payload/iu);
});

test('persisted history accepts every stable ThreadItem shape and retains only identity', () => {
  const fixtures = {
    userMessage: {
      type: 'userMessage',
      id: 'history-user-message',
      clientId: null,
      content: [{ type: 'text', text: PRIVATE_PROSE, text_elements: [] }],
    },
    hookPrompt: {
      type: 'hookPrompt',
      id: 'history-hook-prompt',
      fragments: [{ text: PRIVATE_PROSE, hookRunId: 'history-hook-run' }],
    },
    agentMessage: {
      type: 'agentMessage',
      id: 'history-agent-message',
      text: PRIVATE_PROSE,
      phase: 'final_answer',
      memoryCitation: null,
    },
    plan: { type: 'plan', id: 'history-plan', text: PRIVATE_PROSE },
    reasoning: {
      type: 'reasoning',
      id: 'history-reasoning',
      summary: [PRIVATE_PROSE],
      content: [PRIVATE_PROSE],
    },
    commandExecution: {
      type: 'commandExecution',
      id: 'history-command-execution',
      command: PRIVATE_PROSE,
      cwd: CWD,
      processId: null,
      source: 'agent',
      status: 'completed',
      commandActions: [{ type: 'unknown', command: PRIVATE_PROSE }],
      aggregatedOutput: PRIVATE_PROSE,
      exitCode: 0,
      durationMs: 1,
    },
    fileChange: {
      type: 'fileChange',
      id: 'history-file-change',
      changes: [{
        path: 'private-change.ts',
        kind: { type: 'update', move_path: null },
        diff: PRIVATE_PROSE,
      }],
      status: 'completed',
    },
    mcpToolCall: {
      type: 'mcpToolCall',
      id: 'history-mcp-tool-call',
      server: 'history-server',
      tool: 'history-tool',
      status: 'completed',
      arguments: { secret: PRIVATE_PROSE },
      appContext: {
        connectorId: 'history-connector',
        linkId: null,
        resourceUri: null,
        appName: null,
        templateId: null,
        actionName: null,
      },
      mcpAppResourceUri: 'history://private-resource',
      pluginId: null,
      result: { content: [], structuredContent: { secret: PRIVATE_PROSE }, _meta: null },
      error: null,
      durationMs: 1,
    },
    dynamicToolCall: {
      type: 'dynamicToolCall',
      id: 'history-dynamic-tool-call',
      namespace: null,
      tool: 'history-tool',
      arguments: { secret: PRIVATE_PROSE },
      status: 'completed',
      contentItems: [{ type: 'inputText', text: PRIVATE_PROSE }],
      success: true,
      durationMs: 1,
    },
    collabAgentToolCall: {
      type: 'collabAgentToolCall',
      id: 'history-collab-agent-tool-call',
      tool: 'spawnAgent',
      status: 'completed',
      senderThreadId: THREAD_ID,
      receiverThreadIds: [RESUME_THREAD_ID],
      prompt: PRIVATE_PROSE,
      model: null,
      reasoningEffort: null,
      agentsStates: {
        'history-agent': { status: 'completed', message: PRIVATE_PROSE },
      },
    },
    subAgentActivity: {
      type: 'subAgentActivity',
      id: 'history-sub-agent-activity',
      kind: 'interacted',
      agentThreadId: THREAD_ID,
      agentPath: PRIVATE_PROSE,
    },
    webSearch: {
      type: 'webSearch',
      id: 'history-web-search',
      query: PRIVATE_PROSE,
      action: { type: 'search', query: PRIVATE_PROSE, queries: [PRIVATE_PROSE] },
    },
    imageView: { type: 'imageView', id: 'history-image-view', path: CWD },
    sleep: { type: 'sleep', id: 'history-sleep', durationMs: 1 },
    imageGeneration: {
      type: 'imageGeneration',
      id: 'history-image-generation',
      status: 'completed',
      revisedPrompt: PRIVATE_PROSE,
      result: PRIVATE_PROSE,
      savedPath: CWD,
    },
    enteredReviewMode: {
      type: 'enteredReviewMode',
      id: 'history-entered-review-mode',
      review: PRIVATE_PROSE,
    },
    exitedReviewMode: {
      type: 'exitedReviewMode',
      id: 'history-exited-review-mode',
      review: PRIVATE_PROSE,
    },
    contextCompaction: { type: 'contextCompaction', id: 'history-context-compaction' },
  } satisfies {
    [Type in ThreadItem['type']]: Extract<ThreadItem, { type: Type }>;
  };
  const expectedTypes = [
    'userMessage',
    'hookPrompt',
    'agentMessage',
    'plan',
    'reasoning',
    'commandExecution',
    'fileChange',
    'mcpToolCall',
    'dynamicToolCall',
    'collabAgentToolCall',
    'subAgentActivity',
    'webSearch',
    'imageView',
    'sleep',
    'imageGeneration',
    'enteredReviewMode',
    'exitedReviewMode',
    'contextCompaction',
  ] as const satisfies readonly ThreadItem['type'][];
  assert.deepEqual(Object.keys(fixtures), expectedTypes);

  const expected = challenge('resume');
  const receipt = threadReceipt(expected);
  const historicalItems = Object.values(fixtures);
  threadObject(receipt).turns = [turn('completed', {
    id: '01900100-0000-7000-8000-000000000009',
    items: historicalItems,
  })];

  const captured = captureThreadPeerReceipt(receipt, expected);
  assert.deepEqual(captured, {
    nativeThreadId: RESUME_THREAD_ID,
    historicalTurnIds: ['01900100-0000-7000-8000-000000000009'],
    historicalItemIds: historicalItems.map((item) => item.id),
    policyReceipt: policyReceipt(expected),
  });
  assert.doesNotMatch(JSON.stringify(captured), /PRIVATE provider payload/iu);
});

test('thread response mismatch matrix rejects every immutable selection and posture echo', () => {
  const expected = challenge('resume');
  const mutations: Array<(root: Record<string, unknown>) => void> = [
    (root) => { root.extra = true; },
    (root) => { root.response = null; },
    (root) => { response(root).model = 'different-model'; },
    (root) => { response(root).modelProvider = 'azure'; },
    (root) => { response(root).serviceTier = 'priority'; },
    (root) => { response(root).cwd = 'E:\\wrong'; },
    (root) => { response(root).instructionSources = ['E:\\private\\AGENTS.md']; },
    (root) => { response(root).approvalPolicy = 'on-request'; },
    (root) => { response(root).approvalsReviewer = 'auto_review'; },
    (root) => { response(root).sandbox = { type: 'readOnly', networkAccess: true }; },
    (root) => { response(root).reasoningEffort = 'low'; },
    (root) => { threadObject(root).id = THREAD_ID; },
    (root) => { threadObject(root).cwd = 'E:\\wrong'; },
    (root) => { threadObject(root).modelProvider = 'azure'; },
    (root) => { threadObject(root).cliVersion = '0.145.0'; },
    (root) => { threadObject(root).source = 'exec'; },
    (root) => { threadObject(root).forkedFromId = THREAD_ID; },
    (root) => { threadObject(root).parentThreadId = THREAD_ID; },
    (root) => { threadObject(root).agentNickname = 'worker'; },
    (root) => { threadObject(root).agentRole = 'subagent'; },
    (root) => { threadObject(root).gitInfo = { sha: PRIVATE_PROSE }; },
    (root) => { threadObject(root).ephemeral = true; },
    (root) => { threadObject(root).status = { type: 'notLoaded' }; },
    (root) => { threadObject(root).status = { type: 'systemError' }; },
    (root) => { threadObject(root).status = { type: 'active', activeFlags: [] }; },
  ];
  for (const mutate of mutations) {
    const value = threadReceipt(expected);
    mutate(value);
    assertMappingError(
      () => captureThreadPeerReceipt(value, expected),
      'thread-response-invalid',
    );
  }

  const badPolicy = threadReceipt(expected);
  (badPolicy.policyReceipt as Record<string, unknown>).lifecycle = 'native-process';
  assertMappingError(
    () => captureThreadPeerReceipt(badPolicy, expected),
    'execution-policy-invalid',
  );

  const createExpected = challenge('create');
  const createHistory = threadReceipt(createExpected);
  threadObject(createHistory).turns = [turn('completed')];
  assertMappingError(
    () => captureThreadPeerReceipt(createHistory, createExpected),
    'thread-response-invalid',
  );

  const duplicateHistory = threadReceipt(expected);
  threadObject(duplicateHistory).turns = [turn('completed'), turn('completed')];
  assertMappingError(
    () => captureThreadPeerReceipt(duplicateHistory, expected),
    'thread-response-invalid',
  );

  const malformedHistory = threadReceipt(expected);
  threadObject(malformedHistory).turns = [turn('completed', {
    items: [{ type: 'reasoning', private: PRIVATE_PROSE }],
  })];
  assertMappingError(
    () => captureThreadPeerReceipt(malformedHistory, expected),
    'thread-response-invalid',
  );

  const partialHistory = threadReceipt(expected);
  threadObject(partialHistory).turns = [turn('completed', { itemsView: 'summary' })];
  assertMappingError(
    () => captureThreadPeerReceipt(partialHistory, expected),
    'thread-response-invalid',
  );

  const accessorArrayHistory = threadReceipt(expected);
  const accessorSummary: string[] = [];
  Object.defineProperty(accessorSummary, '0', {
    enumerable: true,
    get() { return PRIVATE_PROSE; },
  });
  threadObject(accessorArrayHistory).turns = [turn('completed', {
    items: [{ type: 'reasoning', id: ITEM_ID, summary: accessorSummary, content: [] }],
  })];
  assertMappingError(
    () => captureThreadPeerReceipt(accessorArrayHistory, expected),
    'thread-response-invalid',
  );

  class HistoricalArraySubclass extends Array<string> {}
  const subclassHistory = threadReceipt(expected);
  threadObject(subclassHistory).turns = [turn('completed', {
    items: [{
      type: 'reasoning',
      id: ITEM_ID,
      summary: new HistoricalArraySubclass(PRIVATE_PROSE),
      content: [],
    }],
  })];
  assertMappingError(
    () => captureThreadPeerReceipt(subclassHistory, expected),
    'thread-response-invalid',
  );

  const duplicateHistoricalItems = threadReceipt(expected);
  threadObject(duplicateHistoricalItems).turns = [
    turn('completed', { id: TURN_ID, items: [agentMessage('one')] }),
    turn('completed', {
      id: '01900100-0000-7000-8000-000000000009',
      items: [agentMessage('two')],
    }),
  ];
  assertMappingError(
    () => captureThreadPeerReceipt(duplicateHistoricalItems, expected),
    'thread-response-invalid',
  );
});

test('turn start capture admits only one clean in-progress UUIDv7 turn', () => {
  assert.equal(captureTurnStartResponse({ turn: turn('inProgress') }), TURN_ID);
  const invalid: unknown[] = [
    {},
    { turn: turn('inProgress'), extra: true },
    { turn: turn('completed') },
    { turn: turn('inProgress', { id: 'native-private-id' }) },
    { turn: turn('inProgress', { items: [agentMessage('')] }) },
    { turn: turn('inProgress', { error: { message: PRIVATE_PROSE } }) },
    { turn: turn('inProgress', { completedAt: 2 }) },
    { turn: turn('inProgress', { durationMs: 1 }) },
    { turn: turn('inProgress', { itemsView: 'summary' }) },
  ];
  for (const value of invalid) {
    assertMappingError(() => captureTurnStartResponse(value), 'turn-response-invalid');
  }
});

test('stable runtime notifications map only ordered public agent text and redacted terminals', () => {
  assert.deepEqual(captureRuntimeNotification({
    method: 'turn/started',
    params: { threadId: THREAD_ID, turn: turn('inProgress') },
  }), { kind: 'turn-started', threadId: THREAD_ID, turnId: TURN_ID });

  assert.deepEqual(captureRuntimeNotification({
    method: 'item/started',
    params: { threadId: THREAD_ID, turnId: TURN_ID, item: agentMessage(''), startedAtMs: 1 },
  }), {
    kind: 'agent-message-started',
    threadId: THREAD_ID,
    turnId: TURN_ID,
    itemId: ITEM_ID,
  });

  assert.deepEqual(captureRuntimeNotification({
    method: 'item/agentMessage/delta',
    params: { threadId: THREAD_ID, turnId: TURN_ID, itemId: ITEM_ID, delta: 'safe text' },
  }), {
    kind: 'agent-message-delta',
    threadId: THREAD_ID,
    turnId: TURN_ID,
    itemId: ITEM_ID,
    delta: 'safe text',
  });

  assert.deepEqual(captureRuntimeNotification({
    method: 'item/completed',
    params: {
      threadId: THREAD_ID,
      turnId: TURN_ID,
      item: agentMessage('safe complete text'),
      completedAtMs: 2,
    },
  }), {
    kind: 'agent-message-completed',
    threadId: THREAD_ID,
    turnId: TURN_ID,
    itemId: ITEM_ID,
    text: 'safe complete text',
    phase: 'final_answer',
  });

  const failed = captureRuntimeNotification({
    method: 'turn/completed',
    params: { threadId: THREAD_ID, turn: turn('failed') },
  });
  assert.deepEqual(failed, {
    kind: 'turn-completed',
    threadId: THREAD_ID,
    turnId: TURN_ID,
    status: 'failed',
    durationMs: 12,
    items: [],
  });
  assert.doesNotMatch(JSON.stringify(failed), /PRIVATE|provider payload/iu);
});

test('stable live item identity is exact nonempty text and is not invented as UUIDv7', () => {
  const stableItemId = 'stable-agent-item-1';
  assert.deepEqual(captureRuntimeNotification({
    method: 'item/started',
    params: {
      threadId: THREAD_ID,
      turnId: TURN_ID,
      item: { ...agentMessage(''), id: stableItemId },
      startedAtMs: 1,
    },
  }), {
    kind: 'agent-message-started',
    threadId: THREAD_ID,
    turnId: TURN_ID,
    itemId: stableItemId,
  });
});

test('every non-agent stable ThreadItem discriminant fails closed as unsafe', () => {
  const expectedTypes = [
    'userMessage',
    'hookPrompt',
    'plan',
    'reasoning',
    'commandExecution',
    'fileChange',
    'mcpToolCall',
    'dynamicToolCall',
    'collabAgentToolCall',
    'subAgentActivity',
    'webSearch',
    'imageView',
    'sleep',
    'imageGeneration',
    'enteredReviewMode',
    'exitedReviewMode',
    'contextCompaction',
  ] as const satisfies readonly Exclude<ThreadItem['type'], 'agentMessage'>[];
  type MissingUnsafeItem = Exclude<
    Exclude<ThreadItem['type'], 'agentMessage'>,
    (typeof expectedTypes)[number]
  >;
  const exhaustive: MissingUnsafeItem extends never ? true : false = true;
  assert.equal(exhaustive, true);
  const unsafeItems: ThreadItem[] = [
    { type: 'userMessage', id: ITEM_ID, clientId: null, content: [] },
    { type: 'hookPrompt', id: ITEM_ID, fragments: [] },
    { type: 'plan', id: ITEM_ID, text: PRIVATE_PROSE },
    { type: 'reasoning', id: ITEM_ID, summary: [PRIVATE_PROSE], content: [PRIVATE_PROSE] },
    {
      type: 'commandExecution',
      id: ITEM_ID,
      command: PRIVATE_PROSE,
      cwd: CWD,
      processId: null,
      source: 'agent',
      status: 'inProgress',
      commandActions: [],
      aggregatedOutput: PRIVATE_PROSE,
      exitCode: null,
      durationMs: null,
    },
    { type: 'fileChange', id: ITEM_ID, changes: [], status: 'inProgress' },
    {
      type: 'mcpToolCall',
      id: ITEM_ID,
      server: 'private-server',
      tool: 'private-tool',
      status: 'inProgress',
      arguments: { secret: PRIVATE_PROSE },
      appContext: null,
      pluginId: null,
      result: null,
      error: null,
      durationMs: null,
    },
    {
      type: 'dynamicToolCall',
      id: ITEM_ID,
      namespace: null,
      tool: 'private-tool',
      arguments: { secret: PRIVATE_PROSE },
      status: 'inProgress',
      contentItems: null,
      success: null,
      durationMs: null,
    },
    {
      type: 'collabAgentToolCall',
      id: ITEM_ID,
      tool: 'spawnAgent',
      status: 'inProgress',
      senderThreadId: THREAD_ID,
      receiverThreadIds: [],
      prompt: PRIVATE_PROSE,
      model: null,
      reasoningEffort: null,
      agentsStates: {},
    },
    {
      type: 'subAgentActivity',
      id: ITEM_ID,
      kind: 'started',
      agentThreadId: THREAD_ID,
      agentPath: PRIVATE_PROSE,
    },
    { type: 'webSearch', id: ITEM_ID, query: PRIVATE_PROSE, action: null },
    { type: 'imageView', id: ITEM_ID, path: CWD },
    { type: 'sleep', id: ITEM_ID, durationMs: 1 },
    {
      type: 'imageGeneration',
      id: ITEM_ID,
      status: 'inProgress',
      revisedPrompt: PRIVATE_PROSE,
      result: PRIVATE_PROSE,
    },
    { type: 'enteredReviewMode', id: ITEM_ID, review: PRIVATE_PROSE },
    { type: 'exitedReviewMode', id: ITEM_ID, review: PRIVATE_PROSE },
    { type: 'contextCompaction', id: ITEM_ID },
  ];
  assert.deepEqual(unsafeItems.map((item) => item.type), expectedTypes);

  for (const item of unsafeItems) {
    for (const [method, timestampKey] of [
      ['item/started', 'startedAtMs'],
      ['item/completed', 'completedAtMs'],
    ] as const) {
      assertMappingError(() => captureRuntimeNotification({
        method,
        params: { threadId: THREAD_ID, turnId: TURN_ID, item, [timestampKey]: 1 },
      }), 'runtime-notification-unsafe');
    }
  }
});

test('all ten stable server-request methods fail closed without payload disclosure', () => {
  const expectedMethods = [
    'item/commandExecution/requestApproval',
    'item/fileChange/requestApproval',
    'item/tool/requestUserInput',
    'mcpServer/elicitation/request',
    'item/permissions/requestApproval',
    'item/tool/call',
    'account/chatgptAuthTokens/refresh',
    'attestation/generate',
    'applyPatchApproval',
    'execCommandApproval',
  ] as const satisfies readonly ServerRequest['method'][];
  type MissingServerRequest = Exclude<ServerRequest['method'], (typeof expectedMethods)[number]>;
  const exhaustive: MissingServerRequest extends never ? true : false = true;
  assert.equal(exhaustive, true);
  const requests: ServerRequest[] = [
    {
      method: 'item/commandExecution/requestApproval',
      id: 1,
      params: {
        threadId: THREAD_ID,
        turnId: TURN_ID,
        itemId: ITEM_ID,
        startedAtMs: 1,
        environmentId: null,
        command: PRIVATE_PROSE,
      },
    },
    {
      method: 'item/fileChange/requestApproval',
      id: 2,
      params: { threadId: THREAD_ID, turnId: TURN_ID, itemId: ITEM_ID, startedAtMs: 1 },
    },
    {
      method: 'item/tool/requestUserInput',
      id: 3,
      params: {
        threadId: THREAD_ID,
        turnId: TURN_ID,
        itemId: ITEM_ID,
        questions: [],
        autoResolutionMs: null,
      },
    },
    {
      method: 'mcpServer/elicitation/request',
      id: 4,
      params: {
        threadId: THREAD_ID,
        turnId: TURN_ID,
        serverName: 'private-server',
        mode: 'form',
        _meta: { secret: PRIVATE_PROSE },
        message: PRIVATE_PROSE,
        requestedSchema: { type: 'object', properties: {} },
      },
    },
    {
      method: 'item/permissions/requestApproval',
      id: 5,
      params: {
        threadId: THREAD_ID,
        turnId: TURN_ID,
        itemId: ITEM_ID,
        environmentId: null,
        startedAtMs: 1,
        cwd: CWD,
        reason: PRIVATE_PROSE,
        permissions: { network: null, fileSystem: null },
      },
    },
    {
      method: 'item/tool/call',
      id: 6,
      params: {
        threadId: THREAD_ID,
        turnId: TURN_ID,
        callId: ITEM_ID,
        namespace: null,
        tool: 'private-tool',
        arguments: { secret: PRIVATE_PROSE },
      },
    },
    {
      method: 'account/chatgptAuthTokens/refresh',
      id: 7,
      params: { reason: 'unauthorized', previousAccountId: 'private-account' },
    },
    { method: 'attestation/generate', id: 8, params: {} },
    {
      method: 'applyPatchApproval',
      id: 9,
      params: {
        conversationId: THREAD_ID,
        callId: ITEM_ID,
        fileChanges: {},
        reason: PRIVATE_PROSE,
        grantRoot: null,
      },
    },
    {
      method: 'execCommandApproval',
      id: 10,
      params: {
        conversationId: THREAD_ID,
        callId: ITEM_ID,
        approvalId: null,
        command: [PRIVATE_PROSE],
        cwd: CWD,
        reason: PRIVATE_PROSE,
        parsedCmd: [],
      },
    },
  ];
  assert.equal(requests.length, 10);
  assert.deepEqual(requests.map((request) => request.method), expectedMethods);
  for (const request of requests) {
    assertMappingError(
      () => captureRuntimeNotification(request),
      'runtime-notification-invalid',
    );
  }
});

test('unknown, malformed, accessor, and prose-bearing runtime frames fail with fixed errors', () => {
  const invalid: Array<[unknown, CodexRuntimeMappingErrorCode]> = [
    [{ method: 'warning', params: { message: PRIVATE_PROSE } }, 'runtime-notification-unsafe'],
    [{ method: 'item/reasoning/textDelta', params: { delta: PRIVATE_PROSE } }, 'runtime-notification-unsafe'],
    [{ method: 'turn/started', params: { threadId: ' wrong ', turn: turn('inProgress') } }, 'runtime-notification-invalid'],
    [{
      method: 'turn/completed',
      params: { threadId: THREAD_ID, turn: turn('completed', { itemsView: 'summary' }) },
    }, 'runtime-notification-invalid'],
    [{
      method: 'item/agentMessage/delta',
      params: { threadId: THREAD_ID, turnId: TURN_ID, itemId: ITEM_ID, delta: '' },
    }, 'runtime-notification-invalid'],
    [{
      method: 'item/started',
      params: {
        threadId: THREAD_ID,
        turnId: TURN_ID,
        item: { ...agentMessage(''), memoryCitation: { private: PRIVATE_PROSE } },
        startedAtMs: 1,
      },
    }, 'runtime-notification-invalid'],
  ];
  for (const [value, code] of invalid) assertMappingError(() => captureRuntimeNotification(value), code);

  const accessor: Record<string, unknown> = { method: 'warning', params: {} };
  Object.defineProperty(accessor, 'params', {
    enumerable: true,
    get() { throw new Error(`${PRIVATE_PROSE}: runtime getter`); },
  });
  assertMappingError(() => captureRuntimeNotification(accessor), 'runtime-notification-invalid');
});

test('outward notification fields are captured once before validation and return', () => {
  let textReads = 0;
  const item = agentMessage('safe') as unknown as Record<string, unknown>;
  Object.defineProperty(item, 'text', {
    enumerable: true,
    get() {
      textReads += 1;
      return textReads === 1 ? 'safe once' : PRIVATE_PROSE;
    },
  });
  const captured = captureRuntimeNotification({
    method: 'item/completed',
    params: { threadId: THREAD_ID, turnId: TURN_ID, item, completedAtMs: 2 },
  });
  assert.equal(textReads, 1);
  assert.deepEqual(captured, {
    kind: 'agent-message-completed',
    threadId: THREAD_ID,
    turnId: TURN_ID,
    itemId: ITEM_ID,
    text: 'safe once',
    phase: 'final_answer',
  });
  assert.doesNotMatch(JSON.stringify(captured), /PRIVATE/iu);
});

test('interrupt acknowledgement is exact and never a terminal receipt', () => {
  assert.equal(captureInterruptResponse({}), undefined);
  for (const value of [null, [], { accepted: true }]) {
    assertMappingError(() => captureInterruptResponse(value), 'interrupt-response-invalid');
  }
});

test('provider-free turn boundary requires an exact closed and empty fake stream receipt', () => {
  const expected: CodexTurnBoundaryChallenge = {
    kind: 'provider-free-turn-boundary-challenge',
    protocolVersion: CODEX_PROTOCOL_VERSION,
    runtimeId: CODEX_RUNTIME_ID,
    continuationAttemptId: 'codex-provider-free-attempt',
    threadId: THREAD_ID,
    turnId: TURN_ID,
    turnSequence: 1,
    status: 'completed',
  };
  const receipt: Record<string, unknown> = {
    kind: 'provider-free-conformance-turn-boundary',
    protocolVersion: CODEX_PROTOCOL_VERSION,
    runtimeId: CODEX_RUNTIME_ID,
    continuationAttemptId: expected.continuationAttemptId,
    threadId: expected.threadId,
    turnId: expected.turnId,
    turnSequence: expected.turnSequence,
    status: expected.status,
    notificationBoundary: 'closed-fake',
    pendingNotifications: 0,
  };
  assert.deepEqual(captureProviderFreeTurnBoundaryReceipt(receipt, expected), receipt);

  const mutations: Array<(value: Record<string, unknown>) => void> = [
    (value) => { value.kind = 'native-production-turn-boundary'; },
    (value) => { value.protocolVersion = '0.145.0'; },
    (value) => { value.runtimeId = 'other-runtime'; },
    (value) => { value.continuationAttemptId = 'stale-attempt'; },
    (value) => { value.threadId = RESUME_THREAD_ID; },
    (value) => { value.turnId = ITEM_ID; },
    (value) => { value.turnSequence = 2; },
    (value) => { value.status = 'failed'; },
    (value) => { value.notificationBoundary = 'open-fake'; },
    (value) => { value.pendingNotifications = 1; },
    (value) => { value.extra = PRIVATE_PROSE; },
  ];
  for (const mutate of mutations) {
    const value = structuredClone(receipt);
    mutate(value);
    assertMappingError(
      () => captureProviderFreeTurnBoundaryReceipt(value, expected),
      'turn-boundary-invalid',
    );
  }
});

function response(root: Record<string, unknown>): Record<string, unknown> {
  return root.response as Record<string, unknown>;
}

function threadObject(root: Record<string, unknown>): Record<string, unknown> {
  return response(root).thread as Record<string, unknown>;
}
