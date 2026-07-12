import { test } from 'node:test';
import assert from 'node:assert/strict';
import type {
  ModelInfo,
  Query,
  SDKMessage,
  SDKUserMessage,
} from '@anthropic-ai/claude-agent-sdk';

import { AccountRegistry } from '../src/runner/account-env.ts';
import {
  CLAUDE_RUNTIME_ID,
  ClaudeRuntimeAdapter,
  ClaudeRuntimeSession,
  type ClaudeQueryFactory,
} from '../src/runner/claude-adapter.ts';
import {
  RuntimeSelectionRejectedError,
  type RuntimeEvent,
  type RuntimeSelection,
} from '../src/runner/runtime.ts';

const MODELS: ModelInfo[] = [
  {
    value: 'opus',
    resolvedModel: 'claude-opus-current',
    displayName: 'Opus',
    description: 'Deep reasoning',
    supportsEffort: true,
    supportedEffortLevels: ['low', 'high'],
  },
  {
    value: 'plain',
    displayName: 'Plain',
    description: '',
    supportsEffort: false,
  },
  {
    value: 'unknown-effort',
    displayName: 'Unknown effort',
    description: '',
  },
];

const ATTEMPT_ID = 'continuation-attempt-1';

function accounts(): AccountRegistry {
  return new AccountRegistry([{
    id: 'personal',
    runtimeId: CLAUDE_RUNTIME_ID,
    configDir: 'C:/claude-personal',
  }]);
}

interface Gate {
  promise: Promise<void>;
  resolve: () => void;
}

function gate(): Gate {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => { resolve = done; });
  return { promise, resolve };
}

function queryObject(
  iterator: AsyncGenerator<SDKMessage, void>,
  models: ModelInfo[],
  close: () => void,
): Query {
  return Object.assign(iterator, {
    supportedModels: async () => models,
    interrupt: async () => { close(); return undefined; },
    close,
  }) as unknown as Query;
}

function discoveryQuery(models: ModelInfo[]): Query {
  const stopped = gate();
  async function* idle(): AsyncGenerator<SDKMessage, void> {
    await stopped.promise;
  }
  return queryObject(idle(), models, stopped.resolve);
}

function deferredDiscoveryQuery(
  models: ModelInfo[],
  started: Gate,
  release: Gate,
): Query {
  const stopped = gate();
  async function* idle(): AsyncGenerator<SDKMessage, void> {
    await stopped.promise;
  }
  const query = queryObject(idle(), models, stopped.resolve);
  return Object.assign(query, {
    supportedModels: async () => {
      started.resolve();
      await release.promise;
      return models;
    },
  }) as unknown as Query;
}

function sessionQuery(
  prompt: string | AsyncIterable<SDKUserMessage>,
  nativeSessionId: string,
): Query {
  const stopped = gate();
  async function* messages(): AsyncGenerator<SDKMessage, void> {
    if (typeof prompt !== 'string') await prompt[Symbol.asyncIterator]().next();
    yield {
      type: 'system',
      subtype: 'init',
      uuid: 'init-1',
      session_id: nativeSessionId,
    } as unknown as SDKMessage;
    await stopped.promise;
  }
  return queryObject(messages(), MODELS, stopped.resolve);
}

function sessionQueryWithoutInit(
  prompt: string | AsyncIterable<SDKUserMessage>,
): Query {
  const stopped = gate();
  async function* messages(): AsyncGenerator<SDKMessage, void> {
    if (typeof prompt !== 'string') await prompt[Symbol.asyncIterator]().next();
    yield {
      type: 'result', subtype: 'success', is_error: false,
      uuid: 'result-1', session_id: 'native-without-init',
    } as unknown as SDKMessage;
    await stopped.promise;
  }
  return queryObject(messages(), MODELS, stopped.resolve);
}

function factoryWithSession(
  nativeSessionId: string,
  captures: Array<Parameters<ClaudeQueryFactory>[0]>,
): ClaudeQueryFactory {
  return (params) => {
    captures.push(params);
    return captures.length % 2 === 1
      ? discoveryQuery(MODELS)
      : sessionQuery(params.prompt, nativeSessionId);
  };
}

function selection(effort: RuntimeSelection['effort']): RuntimeSelection {
  return {
    runtimeId: CLAUDE_RUNTIME_ID,
    accountId: 'personal',
    model: 'opus',
    effort,
  };
}

async function firstEvent(session: { sendTurn(text: string): AsyncIterable<RuntimeEvent> }): Promise<RuntimeEvent> {
  const event = await session.sendTurn('hello')[Symbol.asyncIterator]().next();
  assert.equal(event.done, false);
  return event.value as RuntimeEvent;
}

test('Claude session config requires an exact durable continuation attempt identity', () => {
  for (const continuationAttemptId of ['', ' attempt-padded ']) {
    assert.throws(
      () => new ClaudeRuntimeSession({
        env: {}, continuationAttemptId, selection: selection({ kind: 'none' }),
      }),
      /runtime continuation attempt identity is invalid/,
    );
  }
  assert.throws(
    () => new ClaudeRuntimeSession({
      env: {}, selection: selection({ kind: 'none' }),
    } as never),
    /runtime continuation attempt identity is invalid/,
  );
});

test('Claude discovery is account-scoped and retains per-model effort truth', async () => {
  const captures: Array<Parameters<ClaudeQueryFactory>[0]> = [];
  const adapter = new ClaudeRuntimeAdapter({
    accounts: accounts(),
    queryFactory: (params) => {
      captures.push(params);
      return discoveryQuery(MODELS);
    },
  });

  assert.deepEqual(await adapter.capabilities('missing'), {
    runtimeId: CLAUDE_RUNTIME_ID,
    accountId: 'missing',
    nativeContinuation: { status: 'unavailable', code: 'account-unavailable' },
    modelDiscovery: { status: 'unavailable', code: 'account-unavailable' },
    effortControl: { status: 'unavailable', code: 'account-unavailable' },
  });
  assert.deepEqual(await adapter.listModels('missing'), {
    status: 'unavailable', code: 'account-unavailable',
  });
  assert.equal(captures.length, 0);

  const discovery = await adapter.listModels('personal');
  assert.deepEqual(discovery, {
    status: 'available',
    models: [
      {
        id: 'opus', resolvedId: 'claude-opus-current', label: 'Opus',
        description: 'Deep reasoning', effort: { status: 'supported', values: ['low', 'high'] },
      },
      {
        id: 'plain', resolvedId: null, label: 'Plain', description: '',
        effort: { status: 'unsupported', code: 'model-effort-unsupported' },
      },
      {
        id: 'unknown-effort', resolvedId: null, label: 'Unknown effort', description: '',
        effort: { status: 'unavailable', code: 'model-effort-metadata-unavailable' },
      },
    ],
  });
  assert.equal(captures[0]?.options?.env?.CLAUDE_CONFIG_DIR, 'C:/claude-personal');
});

test('Claude discovery converts auth/runtime exceptions to fixed typed unavailability', async () => {
  const adapter = new ClaudeRuntimeAdapter({
    accounts: accounts(),
    queryFactory: () => { throw new Error('SECRET native auth detail'); },
  });
  const result = await adapter.listModels('personal');
  assert.deepEqual(result, {
    status: 'unavailable', code: 'account-auth-or-runtime-unavailable',
  });
  assert.equal(JSON.stringify(result).includes('SECRET'), false);
});

test('Claude create revalidates selection, passes selected effort, and emits a positive create receipt', async () => {
  const captures: Array<Parameters<ClaudeQueryFactory>[0]> = [];
  const adapter = new ClaudeRuntimeAdapter({
    accounts: accounts(),
    queryFactory: factoryWithSession('native-created', captures),
  });
  const selected = selection({ kind: 'selected', value: 'high' });
  const expectedSelection = selection({ kind: 'selected', value: 'high' });
  const runtime = await adapter.createSession({
    appSessionId: 'app-1', projectId: 'project-1',
    continuationAttemptId: ATTEMPT_ID, selection: selected,
  });
  selected.model = 'mutated-after-mint';
  if (selected.effort.kind === 'selected') selected.effort.value = 'low';

  assert.equal(captures.length, 2);
  assert.equal(captures[1]?.options?.model, 'opus');
  assert.equal(captures[1]?.options?.effort, 'high');
  assert.equal(captures[1]?.options?.resume, undefined);
  const started = await firstEvent(runtime);
  assert.deepEqual(started, {
    type: 'session-started',
    receipt: {
      mode: 'created',
      continuationAttemptId: ATTEMPT_ID,
      selection: expectedSelection,
      nativeSessionId: 'native-created',
      requestedNativeSessionId: null,
    },
  });
  assert.equal(started.type, 'session-started');
  if (started.type === 'session-started') {
    assert.equal(Object.isFrozen(started.receipt.selection), true);
    assert.equal(Object.isFrozen(started.receipt.selection.effort), true);
    assert.throws(() => { started.receipt.selection.model = 'mutated-receipt'; }, TypeError);
  }
  await runtime.dispose();
});

test('Claude resume requires an exact native init receipt and never falls back to create', async () => {
  const captures: Array<Parameters<ClaudeQueryFactory>[0]> = [];
  const adapter = new ClaudeRuntimeAdapter({
    accounts: accounts(),
    queryFactory: factoryWithSession('native-other', captures),
  });
  const selected = selection({ kind: 'none' });
  const runtime = await adapter.resumeSession({
    appSessionId: 'app-1', projectId: 'project-1',
    continuationAttemptId: ATTEMPT_ID, selection: selected,
    nativeSessionId: 'native-requested',
  });

  assert.equal(captures[1]?.options?.resume, 'native-requested');
  const event = await firstEvent(runtime);
  assert.equal(event.type, 'result');
  if (event.type === 'result') {
    assert.equal(event.ok, false);
    assert.equal(event.error, 'runtime native resume receipt mismatch');
  }
  assert.equal(JSON.stringify(event).includes('session-started'), false);
  await runtime.dispose();
});

test('Claude resume emits resumed provenance only after the exact requested native id', async () => {
  const captures: Array<Parameters<ClaudeQueryFactory>[0]> = [];
  const adapter = new ClaudeRuntimeAdapter({
    accounts: accounts(),
    queryFactory: factoryWithSession('native-requested', captures),
  });
  const selected = selection({ kind: 'none' });
  const runtime = await adapter.resumeSession({
    appSessionId: 'app-1', projectId: 'project-1',
    continuationAttemptId: ATTEMPT_ID, selection: selected,
    nativeSessionId: 'native-requested',
  });

  assert.deepEqual(await firstEvent(runtime), {
    type: 'session-started',
    receipt: {
      mode: 'resumed',
      continuationAttemptId: ATTEMPT_ID,
      selection: selected,
      nativeSessionId: 'native-requested',
      requestedNativeSessionId: 'native-requested',
    },
  });
  await runtime.dispose();
});

test('Claude rejects an empty native init identity without a created receipt', async () => {
  const captures: Array<Parameters<ClaudeQueryFactory>[0]> = [];
  const adapter = new ClaudeRuntimeAdapter({
    accounts: accounts(),
    queryFactory: factoryWithSession('', captures),
  });
  const runtime = await adapter.createSession({
    appSessionId: 'app-1', projectId: 'project-1',
    continuationAttemptId: ATTEMPT_ID,
    selection: selection({ kind: 'none' }),
  });
  const event = await firstEvent(runtime);
  assert.equal(event.type, 'result');
  if (event.type === 'result') {
    assert.equal(event.ok, false);
    assert.equal(event.error, 'runtime native session identity unavailable');
  }
  await runtime.dispose();
});

test('Claude rejects native output that arrives before a positive init receipt', async () => {
  let calls = 0;
  const adapter = new ClaudeRuntimeAdapter({
    accounts: accounts(),
    queryFactory: (params) => {
      calls += 1;
      return calls === 1
        ? discoveryQuery(MODELS)
        : sessionQueryWithoutInit(params.prompt);
    },
  });
  const runtime = await adapter.createSession({
    appSessionId: 'app-1', projectId: 'project-1',
    continuationAttemptId: ATTEMPT_ID,
    selection: selection({ kind: 'none' }),
  });
  const event = await firstEvent(runtime);
  assert.equal(event.type, 'result');
  if (event.type === 'result') {
    assert.equal(event.ok, false);
    assert.equal(event.error, 'runtime native session receipt missing');
  }
  await runtime.dispose();
});

test('Claude refuses unsupported effort before minting a native session', async () => {
  let calls = 0;
  const adapter = new ClaudeRuntimeAdapter({
    accounts: accounts(),
    queryFactory: () => {
      calls += 1;
      return discoveryQuery(MODELS);
    },
  });
  await assert.rejects(
    () => adapter.createSession({
      appSessionId: 'app-1',
      projectId: 'project-1',
      continuationAttemptId: ATTEMPT_ID,
      selection: selection({ kind: 'selected', value: 'max' }),
    }),
    (error: unknown) => (
      error instanceof RuntimeSelectionRejectedError &&
      error.code === 'effort-value-unsupported'
    ),
  );
  assert.equal(calls, 1, 'discovery ran, but no session query was created');
});

test('Claude snapshots selection, native resume identity, and attempt identity before async discovery', async () => {
  const captures: Array<Parameters<ClaudeQueryFactory>[0]> = [];
  const discoveryStarted = gate();
  const releaseDiscovery = gate();
  const adapter = new ClaudeRuntimeAdapter({
    accounts: accounts(),
    queryFactory: (params) => {
      captures.push(params);
      return captures.length === 1
        ? deferredDiscoveryQuery(MODELS, discoveryStarted, releaseDiscovery)
        : sessionQuery(params.prompt, 'native-original');
    },
  });
  const mutableSelection = selection({ kind: 'selected', value: 'high' });
  const input = {
    appSessionId: 'app-1', projectId: 'project-1', selection: mutableSelection,
    nativeSessionId: 'native-original', continuationAttemptId: 'attempt-original',
  };
  const pending = adapter.resumeSession(input);
  await discoveryStarted.promise;
  mutableSelection.accountId = 'missing-account';
  mutableSelection.model = 'mutated-model';
  if (mutableSelection.effort.kind === 'selected') mutableSelection.effort.value = 'low';
  input.nativeSessionId = 'native-mutated';
  input.continuationAttemptId = 'attempt-mutated';
  releaseDiscovery.resolve();
  const runtime = await pending;

  assert.equal(captures[1]?.options?.model, 'opus');
  assert.equal(captures[1]?.options?.effort, 'high');
  assert.equal(captures[1]?.options?.resume, 'native-original');
  assert.deepEqual(await firstEvent(runtime), {
    type: 'session-started',
    receipt: {
      mode: 'resumed',
      continuationAttemptId: 'attempt-original',
      selection: selection({ kind: 'selected', value: 'high' }),
      nativeSessionId: 'native-original',
      requestedNativeSessionId: 'native-original',
    },
  });
  await runtime.dispose();
});

test('Claude rejects malformed selection and noncanonical resume ids before discovery', async () => {
  let calls = 0;
  const adapter = new ClaudeRuntimeAdapter({
    accounts: accounts(),
    queryFactory: () => {
      calls += 1;
      return discoveryQuery(MODELS);
    },
  });
  await assert.rejects(
    () => adapter.createSession({
      appSessionId: 'app-1', projectId: 'project-1', selection: null,
    } as never),
    (error: unknown) => error instanceof RuntimeSelectionRejectedError &&
      error.code === 'selection-unavailable',
  );
  await assert.rejects(
    () => adapter.resumeSession({
      appSessionId: 'app-1', projectId: 'project-1',
      continuationAttemptId: ATTEMPT_ID,
      selection: selection({ kind: 'none' }), nativeSessionId: ' native-a ',
    }),
    (error: unknown) => error instanceof RuntimeSelectionRejectedError &&
      error.code === 'native-session-missing',
  );
  for (const continuationAttemptId of ['', ' attempt-padded ']) {
    await assert.rejects(
      () => adapter.createSession({
        appSessionId: 'app-1', projectId: 'project-1',
        continuationAttemptId,
        selection: selection({ kind: 'none' }),
      }),
      /runtime continuation attempt identity is invalid/,
    );
  }
  assert.equal(calls, 0);
});

test('Claude discovery cleanup errors cannot rewrite a successful typed result', async () => {
  const adapter = new ClaudeRuntimeAdapter({
    accounts: accounts(),
    queryFactory: () => {
      const stopped = gate();
      async function* idle(): AsyncGenerator<SDKMessage, void> {
        await stopped.promise;
      }
      return queryObject(idle(), MODELS, () => {
        stopped.resolve();
        throw new Error('close failed');
      });
    },
  });
  assert.equal((await adapter.listModels('personal')).status, 'available');
});

test('Claude discovery rejects malformed native model identities without normalization', async () => {
  const adapter = new ClaudeRuntimeAdapter({
    accounts: accounts(),
    queryFactory: () => discoveryQuery([{
      ...MODELS[0]!,
      value: ' opus ',
    }]),
  });
  assert.deepEqual(await adapter.listModels('personal'), {
    status: 'unavailable', code: 'invalid-model-discovery',
  });
});

test('Claude dispose closes immediately even when native interrupt never settles', async () => {
  let calls = 0;
  let sessionCloseCount = 0;
  const adapter = new ClaudeRuntimeAdapter({
    accounts: accounts(),
    queryFactory: (params) => {
      calls += 1;
      if (calls === 1) return discoveryQuery(MODELS);
      const stopped = gate();
      async function* messages(): AsyncGenerator<SDKMessage, void> {
        if (typeof params.prompt !== 'string') await params.prompt[Symbol.asyncIterator]().next();
        yield {
          type: 'system', subtype: 'init', uuid: 'init-hanging', session_id: 'native-hanging',
        } as unknown as SDKMessage;
        await stopped.promise;
      }
      const iterator = messages();
      return Object.assign(iterator, {
        supportedModels: async () => MODELS,
        interrupt: () => new Promise<void>(() => {}),
        close: () => {
          sessionCloseCount += 1;
          stopped.resolve();
        },
      }) as unknown as Query;
    },
  });
  const runtime = await adapter.createSession({
    appSessionId: 'app-1', projectId: 'project-1',
    continuationAttemptId: ATTEMPT_ID,
    selection: selection({ kind: 'none' }),
  });
  assert.equal((await firstEvent(runtime)).type, 'session-started');
  await Promise.race([
    runtime.dispose(),
    new Promise<never>((_resolve, reject) => {
      setTimeout(() => reject(new Error('dispose hung on native interrupt')), 100);
    }),
  ]);
  assert.equal(sessionCloseCount, 1);
});
