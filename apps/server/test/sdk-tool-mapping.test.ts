import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { SDKMessage } from '@anthropic-ai/claude-agent-sdk';
import type { AskDecision, RuntimeEvent, RuntimeSelection } from '../src/runner/runtime.ts';
import {
  ClaudeRuntimeSession,
  createClaudePermissionHandler,
  createSdkKeyContext,
  mapSdkMessage,
} from '../src/runner/claude-adapter.ts';

const ACCOUNT = 'account-1';
const CONTINUATION_ATTEMPT_ID = 'continuation-attempt-1';
const SELECTION: RuntimeSelection = {
  runtimeId: 'claude-agent-sdk',
  accountId: ACCOUNT,
  model: 'opus',
  effort: { kind: 'none' },
};

function sdk(value: Record<string, unknown>): SDKMessage {
  return value as unknown as SDKMessage;
}

function keys() {
  let item = 0;
  let call = 0;
  return createSdkKeyContext(
    () => `item-${++item}`,
    () => `call-${++call}`,
  );
}

function assistantTool(nativeId = 'native-tool-1', name = 'Bash'): SDKMessage {
  return sdk({
    type: 'assistant',
    uuid: 'env-a',
    session_id: 'native-session',
    parent_tool_use_id: null,
    message: {
      id: 'msg-a',
      content: [{ type: 'tool_use', id: nativeId, name, input: { command: 'SECRET COMMAND' } }],
    },
  });
}

function progress(nativeId = 'native-tool-1', name = 'Bash'): SDKMessage {
  return sdk({
    type: 'tool_progress',
    tool_use_id: nativeId,
    tool_name: name,
    parent_tool_use_id: null,
    elapsed_time_seconds: 1.2,
    uuid: 'env-p',
    session_id: 'native-session',
  });
}

function result(nativeId = 'native-tool-1', isError = false): SDKMessage {
  return sdk({
    type: 'user',
    uuid: 'env-r',
    session_id: 'native-session',
    parent_tool_use_id: null,
    message: {
      content: [{
        type: 'tool_result',
        tool_use_id: nativeId,
        content: 'SECRET RESULT',
        is_error: isError,
      }],
    },
  });
}

function toolStates(events: RuntimeEvent[]) {
  return events.filter((event): event is Extract<RuntimeEvent, { type: 'tool-state' }> => (
    event.type === 'tool-state'
  ));
}

test('direct tool observations use one canonical call id and carry no native/input/result data', () => {
  const context = keys();
  const requested = mapSdkMessage(assistantTool(), ACCOUNT, context);
  const running = mapSdkMessage(progress(), ACCOUNT, context);
  const succeeded = mapSdkMessage(result(), ACCOUNT, context);
  assert.deepEqual(
    toolStates([...requested, ...running, ...succeeded]).map((event) => event.event.state),
    ['requested', 'running', 'succeeded'],
  );
  assert.deepEqual(
    toolStates([...requested, ...running, ...succeeded]).map((event) => event.event.callId),
    ['call-1', 'call-1', 'call-1'],
  );
  const serialized = JSON.stringify([...requested, ...running, ...succeeded]);
  for (const forbidden of ['native-tool-1', 'SECRET COMMAND', 'SECRET RESULT', 'elapsed_time_seconds']) {
    assert.equal(serialized.includes(forbidden), false);
  }
  assert.deepEqual(mapSdkMessage(progress(), ACCOUNT, context), [], 'duplicate progress is idempotent');
});

test('result without progress synthesizes running before success/error', () => {
  for (const isError of [false, true]) {
    const context = keys();
    mapSdkMessage(assistantTool(), ACCOUNT, context);
    const events = toolStates(mapSdkMessage(result('native-tool-1', isError), ACCOUNT, context));
    assert.deepEqual(events.map((event) => event.event.state), ['running', isError ? 'failed' : 'succeeded']);
    assert.deepEqual(events.at(-1)?.event.outcome, isError ? { reason: 'tool-error' } : null);
  }
});

test('open tool correlation is never evicted by an arbitrary map-size cap', () => {
  const context = keys();
  for (let index = 0; index < 501; index += 1) {
    const events = toolStates(mapSdkMessage(
      assistantTool(`native-tool-${index}`, 'Read'),
      ACCOUNT,
      context,
    ));
    assert.equal(events[0]?.event.callId, `call-${index + 1}`);
  }
  const lateResult = toolStates(mapSdkMessage(result('native-tool-0'), ACCOUNT, context));
  assert.deepEqual(lateResult.map((event) => [event.event.callId, event.event.state]), [
    ['call-1', 'running'],
    ['call-1', 'succeeded'],
  ]);
  assert.equal(context.nativeToCallId.get('native-tool-0'), 'call-1');
});

test('progress or native denial may race ahead of assistant without reopening terminal state', () => {
  const progressFirst = keys();
  assert.deepEqual(
    toolStates(mapSdkMessage(progress(), ACCOUNT, progressFirst)).map((event) => event.event.state),
    ['requested', 'running'],
  );
  assert.deepEqual(mapSdkMessage(assistantTool(), ACCOUNT, progressFirst), []);

  const deniedFirst = keys();
  const denied = sdk({
    type: 'system', subtype: 'permission_denied',
    tool_name: 'Bash', tool_use_id: 'native-tool-1',
    decision_reason: 'SECRET PROVIDER REASON', message: 'SECRET DENIAL',
    uuid: 'env-d', session_id: 'native-session',
  });
  assert.deepEqual(
    toolStates(mapSdkMessage(denied, ACCOUNT, deniedFirst)).map((event) => event.event.state),
    ['requested', 'denied'],
  );
  assert.deepEqual(mapSdkMessage(assistantTool(), ACCOUNT, deniedFirst), []);
  assert.deepEqual(mapSdkMessage(result('native-tool-1', true), ACCOUNT, deniedFirst), []);
  assert.equal(JSON.stringify(mapSdkMessage(denied, ACCOUNT, keys())).includes('SECRET'), false);
});

test('result permission-denial fallback precedes the turn result and omits raw tool input', () => {
  const context = keys();
  const events = mapSdkMessage(sdk({
    type: 'result', subtype: 'error_during_execution',
    permission_denials: [{ tool_name: 'Write', tool_use_id: 'native-denied', tool_input: { token: 'SECRET' } }],
    errors: ['failed'], duration_ms: 1, num_turns: 1,
  }), ACCOUNT, context);
  assert.deepEqual(events.map((event) => event.type), ['tool-state', 'tool-state', 'result']);
  assert.deepEqual(toolStates(events).map((event) => event.event.state), ['requested', 'denied']);
  assert.equal(JSON.stringify(events).includes('SECRET'), false);
});

test('closed native activity maps safely; reasoning and tool summaries stay dropped', () => {
  const context = keys();
  const status = (value: unknown) => mapSdkMessage(sdk({
    type: 'system', subtype: 'status', status: value, uuid: 'u', session_id: 's',
  }), ACCOUNT, context);
  assert.deepEqual(status('requesting'), [{ type: 'activity-state', phase: 'requesting-runtime' }]);
  assert.deepEqual(status('compacting'), [{ type: 'activity-state', phase: 'compacting' }]);
  assert.deepEqual(status(null), []);
  assert.deepEqual(mapSdkMessage(sdk({
    type: 'system', subtype: 'thinking_tokens', estimated_tokens: 50,
    estimated_tokens_delta: 5, uuid: 'u', session_id: 's',
  }), ACCOUNT, context), []);
  assert.deepEqual(mapSdkMessage(sdk({
    type: 'tool_use_summary', summary: 'SECRET provider prose',
    preceding_tool_use_ids: ['native-tool-1'], uuid: 'u', session_id: 's',
  }), ACCOUNT, context), []);
  assert.deepEqual(mapSdkMessage(sdk({
    type: 'stream_event', uuid: 'u', parent_tool_use_id: null,
    event: { type: 'content_block_delta', delta: { type: 'input_json_delta', partial_json: 'SECRET' } },
  }), ACCOUNT, context), []);
  const retry = mapSdkMessage(sdk({
    type: 'system', subtype: 'api_retry', attempt: 2, max_retries: 5,
    error: { message: 'SECRET provider retry error' }, uuid: 'u', session_id: 's',
  }), ACCOUNT, context);
  assert.deepEqual(retry, [
    { type: 'activity-state', phase: 'retrying' },
    { type: 'api-retry', attempt: 2, maxRetries: 5 },
  ]);
  for (const subtype of ['informational', 'notification', 'local_command_output'] as const) {
    const mapped = mapSdkMessage(sdk({
      type: 'system', subtype, content: 'SECRET status prose', text: 'SECRET notification',
      uuid: 'u', session_id: 's',
    }), ACCOUNT, context);
    assert.equal(JSON.stringify(mapped).includes('SECRET'), false);
  }
});

test('permission callback is callback-first safe, idempotent, and keeps provider request ids private', async () => {
  const context = keys();
  const emitted: RuntimeEvent[] = [];
  let resolveDecision!: (decision: AskDecision) => void;
  let askCount = 0;
  const handler = createClaudePermissionHandler({
    keys: context,
    appSessionId: 'app-session',
    isActive: () => true,
    turnGeneration: () => 1,
    emit: (events) => emitted.push(...events),
    ask: (request) => {
      askCount += 1;
      assert.equal(request.callId, 'call-1');
      return {
        requestId: 'app-approval-1',
        decision: new Promise((resolve) => { resolveDecision = resolve; }),
        cancel: () => resolveDecision({ behavior: 'deny', decidedBy: 'session' }),
      };
    },
  });
  const controller = new AbortController();
  const options = {
    signal: controller.signal,
    toolUseID: 'native-tool-1',
    requestId: 'native-request-1',
  };
  const response = handler('Bash', { command: 'SECRET' }, options);
  const duplicate = handler('Bash', { command: 'SECRET' }, options);
  assert.equal(response, duplicate);
  assert.equal(askCount, 1);
  assert.deepEqual(toolStates(emitted).map((event) => event.event.state), ['requested', 'approval-needed']);
  assert.deepEqual(mapSdkMessage(assistantTool(), ACCOUNT, context), [], 'late assistant request is a no-op');
  resolveDecision({ behavior: 'allow', decidedBy: 'user' });
  assert.deepEqual(await response, { behavior: 'allow', updatedInput: { command: 'SECRET' } });
  assert.deepEqual(toolStates(emitted).map((event) => event.event.state), ['requested', 'approval-needed', 'running']);
  const terminal = mapSdkMessage(result(), ACCOUNT, context);
  assert.deepEqual(toolStates(terminal).map((event) => event.event.state), ['succeeded']);
  const serialized = JSON.stringify([...emitted, ...terminal]);
  assert.equal(serialized.includes('native-request-1'), false);
  assert.equal(serialized.includes('native-tool-1'), false);
  assert.equal(serialized.includes('SECRET'), false);
});

test('permission receipts never authorize outside their exact active turn and scope', async () => {
  const context = keys();
  const emitted: RuntimeEvent[] = [];
  let active = true;
  let generation = 1;
  let asks = 0;
  const handler = createClaudePermissionHandler({
    keys: context,
    appSessionId: 'app',
    isActive: () => active,
    turnGeneration: () => generation,
    emit: (events) => emitted.push(...events),
    ask: () => {
      asks += 1;
      return {
        requestId: 'app-ask',
        decision: Promise.resolve({ behavior: 'allow', decidedBy: 'user' }),
        cancel: () => {},
      };
    },
  });
  const options = {
    signal: new AbortController().signal,
    toolUseID: 'native-tool',
    requestId: 'native-request',
  };

  assert.deepEqual(await handler('Bash', {}, options), { behavior: 'allow', updatedInput: {} });
  assert.deepEqual(await handler('Bash', {}, { ...options, agentID: 'sidechain-agent' }), {
    behavior: 'deny',
    message: 'conflicting runtime permission request identity',
  });
  active = false;
  assert.deepEqual(await handler('Bash', {}, options), {
    behavior: 'deny',
    message: 'no active app turn',
  });
  active = true;
  generation = 2;
  assert.deepEqual(await handler('Bash', {}, options), {
    behavior: 'deny',
    message: 'conflicting runtime permission request identity',
  });
  assert.equal(asks, 1);
  assert.equal(JSON.stringify(emitted).includes('native-'), false);
});

test('a pending approval cannot complete into a successor turn', async () => {
  const context = keys();
  const emitted: RuntimeEvent[] = [];
  let generation = 1;
  let resolveDecision!: (decision: AskDecision) => void;
  const handler = createClaudePermissionHandler({
    keys: context,
    appSessionId: 'app',
    isActive: () => true,
    turnGeneration: () => generation,
    emit: (events) => emitted.push(...events),
    ask: () => ({
      requestId: 'app-ask',
      decision: new Promise((resolve) => { resolveDecision = resolve; }),
      cancel: () => {},
    }),
  });
  const response = handler('Bash', {}, {
    signal: new AbortController().signal,
    toolUseID: 'native-tool',
    requestId: 'native-request',
  });
  generation = 2;
  resolveDecision({ behavior: 'allow', decidedBy: 'user' });

  assert.deepEqual(await response, {
    behavior: 'deny',
    message: 'app turn changed before approval completed',
  });
  assert.deepEqual(toolStates(emitted).map((event) => event.event.state), [
    'requested',
    'approval-needed',
  ]);
});

test('permission denial and callback abort preserve app request provenance', async () => {
  for (const decidedBy of ['user', 'timeout'] as const) {
    const context = keys();
    const emitted: RuntimeEvent[] = [];
    const handler = createClaudePermissionHandler({
      keys: context, appSessionId: 'app', isActive: () => true,
      turnGeneration: () => 1,
      emit: (events) => emitted.push(...events),
      ask: () => ({
        requestId: 'app-ask',
        decision: Promise.resolve({ behavior: 'deny', decidedBy }),
        cancel: () => {},
      }),
    });
    await handler('Bash', {}, {
      signal: new AbortController().signal,
      toolUseID: 'native-tool', requestId: `native-${decidedBy}`,
    });
    assert.deepEqual(toolStates(emitted).at(-1)?.event.approval, {
      status: 'denied', source: decidedBy, requestId: 'app-ask',
    });
  }

  const context = keys();
  const emitted: RuntimeEvent[] = [];
  const controller = new AbortController();
  let cancel!: () => void;
  const handler = createClaudePermissionHandler({
    keys: context, appSessionId: 'app', isActive: () => true,
    turnGeneration: () => 1,
    emit: (events) => emitted.push(...events),
    ask: () => {
      let resolve!: (decision: AskDecision) => void;
      const decision = new Promise<AskDecision>((done) => { resolve = done; });
      cancel = () => resolve({ behavior: 'deny', decidedBy: 'session' });
      return { requestId: 'app-ask', decision, cancel };
    },
  });
  const response = handler('Bash', {}, {
    signal: controller.signal, toolUseID: 'native-tool', requestId: 'native-request',
  });
  controller.abort();
  await response;
  assert.deepEqual(toolStates(emitted).at(-1)?.event.approval, {
    status: 'denied', source: 'session', requestId: 'app-ask',
  });
  void cancel;
});

test('sidechain permission requests deny immediately without opening an unpublishable Ask', async () => {
  const context = keys();
  const emitted: RuntimeEvent[] = [];
  let askCount = 0;
  const handler = createClaudePermissionHandler({
    keys: context,
    appSessionId: 'app',
    isActive: () => true,
    turnGeneration: () => 1,
    emit: (events) => emitted.push(...events),
    ask: () => {
      askCount += 1;
      throw new Error('sidechain approval must not register an Ask');
    },
  });
  const decision = await handler('Bash', { command: 'SECRET' }, {
    signal: new AbortController().signal,
    toolUseID: 'native-sidechain-tool',
    requestId: 'native-sidechain-request',
    agentID: 'native-sidechain-agent',
  });
  assert.deepEqual(decision, {
    behavior: 'deny',
    message: 'sidechain tool approval is unsupported',
  });
  assert.equal(askCount, 0);
  assert.deepEqual(toolStates(emitted).map((event) => [event.scope, event.event.state]), [
    ['sidechain', 'requested'],
    ['sidechain', 'denied'],
  ]);
  assert.equal(JSON.stringify(emitted).includes('SECRET'), false);
});

test('a result cannot fabricate user approval while the app request is pending', async () => {
  const context = keys();
  const emitted: RuntimeEvent[] = [];
  let resolveDecision!: (decision: AskDecision) => void;
  const handler = createClaudePermissionHandler({
    keys: context, appSessionId: 'app', isActive: () => true,
    turnGeneration: () => 1,
    emit: (events) => emitted.push(...events),
    ask: () => ({
      requestId: 'app-pending',
      decision: new Promise((resolve) => { resolveDecision = resolve; }),
      cancel: () => resolveDecision({ behavior: 'deny', decidedBy: 'session' }),
    }),
  });
  const response = handler('Bash', {}, {
    signal: new AbortController().signal,
    toolUseID: 'native-pending-tool', requestId: 'native-pending-request',
  });
  assert.deepEqual(toolStates(emitted).map((event) => event.event.state), [
    'requested', 'approval-needed',
  ]);
  assert.deepEqual(mapSdkMessage(result('native-pending-tool'), ACCOUNT, context), []);
  resolveDecision({ behavior: 'deny', decidedBy: 'user' });
  await response;
  assert.equal(toolStates(emitted).at(-1)?.event.state, 'denied');
});

test('answer-style rejection denies canonically without a transient running state', async () => {
  const context = keys();
  const emitted: RuntimeEvent[] = [];
  const handler = createClaudePermissionHandler({
    keys: context,
    appSessionId: 'app',
    isActive: () => true,
    turnGeneration: () => 1,
    emit: (events) => emitted.push(...events),
    ask: () => ({
      requestId: 'app-plan-approval',
      decision: Promise.resolve({ behavior: 'allow', decidedBy: 'user', rawAnswer: 'reject' }),
      cancel: () => {},
    }),
  });
  const result = await handler('ExitPlanMode', {}, {
    signal: new AbortController().signal,
    toolUseID: 'native-plan-tool',
    requestId: 'native-plan-request',
  });
  assert.deepEqual(result, { behavior: 'deny', message: 'plan rejected' });
  assert.deepEqual(toolStates(emitted).map((event) => event.event.state), [
    'requested', 'approval-needed', 'denied',
  ]);
  assert.deepEqual(toolStates(emitted).at(-1)?.event.approval, {
    status: 'denied', source: 'user', requestId: 'app-plan-approval',
  });
});

test('permission request-id collisions never reuse authorization across tool identities', async () => {
  let asks = 0;
  const emitted: RuntimeEvent[] = [];
  const handler = createClaudePermissionHandler({
    keys: keys(), appSessionId: 'app', isActive: () => true,
    turnGeneration: () => 1,
    emit: (events) => emitted.push(...events),
    ask: () => {
      asks += 1;
      return {
        requestId: 'app-ask',
        decision: Promise.resolve({ behavior: 'allow', decidedBy: 'user' }),
        cancel: () => {},
      };
    },
  });
  await handler('Read', {}, {
    signal: new AbortController().signal,
    toolUseID: 'native-tool-1',
    requestId: 'native-request-collision',
  });
  assert.deepEqual(await handler('Write', {}, {
    signal: new AbortController().signal,
    toolUseID: 'native-tool-2',
    requestId: 'native-request-collision',
  }), {
    behavior: 'deny',
    message: 'conflicting runtime permission request identity',
  });
  assert.equal(asks, 1);
  assert.deepEqual(toolStates(emitted).slice(-2).map((event) => event.event.state), [
    'requested', 'denied',
  ]);
  assert.deepEqual(toolStates(emitted).at(-1)?.event.approval, {
    status: 'denied', source: 'runtime', requestId: null,
  });
});

test('Claude runtime refuses to overwrite an active turn queue', () => {
  const session = new ClaudeRuntimeSession({
    env: {}, continuationAttemptId: CONTINUATION_ATTEMPT_ID, selection: SELECTION,
  });
  const internals = session as unknown as { started: boolean; currentTurn: object | null };
  internals.started = true;
  internals.currentTurn = {};
  assert.throws(() => session.sendTurn('successor'), /already has an active turn/);
});

test('Claude runtime drops out-of-turn native frames and resets correlation at the next turn', async () => {
  const session = new ClaudeRuntimeSession({
    env: {}, continuationAttemptId: CONTINUATION_ATTEMPT_ID, selection: SELECTION,
  });
  const internals = session as unknown as {
    started: boolean;
    keys: ReturnType<typeof createSdkKeyContext>;
    route: (message: SDKMessage) => void;
  };
  internals.started = true;

  internals.route(assistantTool('out-of-turn'));
  assert.equal(internals.keys.nativeToCallId.size, 0);
  mapSdkMessage(assistantTool('previous-turn'), ACCOUNT, internals.keys);
  assert.equal(internals.keys.nativeToCallId.size, 1);
  session.sendTurn('successor');
  assert.equal(internals.keys.nativeToCallId.size, 0);
  assert.equal(internals.keys.toolStates.size, 0);
  await session.dispose();
});

test('Claude runtime records an idle query-loop death and rejects the next turn', async () => {
  const session = new ClaudeRuntimeSession({
    env: {}, continuationAttemptId: CONTINUATION_ATTEMPT_ID, selection: SELECTION,
  });
  const internals = session as unknown as {
    started: boolean;
    queryClosed: boolean;
    consume: (query: AsyncIterable<SDKMessage>) => Promise<void>;
  };
  internals.started = true;
  async function* deadQuery(): AsyncIterable<SDKMessage> {
    throw new Error('SECRET idle provider query failure');
  }
  await internals.consume(deadQuery());
  assert.equal(internals.queryClosed, true);
  assert.throws(() => session.sendTurn('next'), /query loop is closed/);
});

test('Claude query exceptions become fixed app-authored terminal errors', () => {
  const session = new ClaudeRuntimeSession({
    env: {}, continuationAttemptId: CONTINUATION_ATTEMPT_ID, selection: SELECTION,
  });
  const events: RuntimeEvent[] = [];
  let ended = false;
  const internals = session as unknown as {
    currentTurn: { push: (event: RuntimeEvent) => void; end: () => void } | null;
    failCurrentTurn: (error: unknown) => void;
  };
  internals.currentTurn = {
    push: (event) => events.push(event),
    end: () => { ended = true; },
  };
  internals.failCurrentTurn(new Error('SECRET provider query detail'));
  assert.equal(ended, true);
  assert.equal(events.length, 1);
  assert.equal((events[0] as Extract<RuntimeEvent, { type: 'result' }>).error, 'runtime query failed');
  assert.equal(JSON.stringify(events).includes('SECRET'), false);
});
