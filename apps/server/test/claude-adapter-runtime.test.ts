import { test } from 'node:test';
import assert from 'node:assert/strict';
import { resolve } from 'node:path';
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
import {
  genericRuntimeAdapterConformanceFixture,
  runtimeAdapterConformance,
  type RuntimeAdapterConformanceFactory,
  type RuntimeAdapterConformanceScenario,
} from './runtime-adapter-conformance.ts';

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
const TEST_CLAUDE_ENV = Object.freeze({
  CLAUDE_CONFIG_DIR: resolve('test-fixtures/claude-personal'),
});

const DIRTY_RUNTIME_ENV: NodeJS.ProcessEnv = {
  PATH: 'C:/safe-bin',
  CLAUDE_CONFIG_DIR: 'C:/ambient-claude-home',
  claude_config_dir: 'C:/lowercase-lookalike',
  ANTHROPIC_API_KEY: 'anthropic-api-key-canary',
  ANTHROPIC_AUTH_TOKEN: 'anthropic-auth-token-canary',
  OPENAI_API_KEY: 'openai-api-key-canary',
  PC_AINATIVE_PM_TOKEN: 'pm-token-canary',
  PC_DATA_DIR: 'C:/private-app-data',
  GIT_DIR: 'C:/attacker/repository',
  NODE_OPTIONS: '--require=C:/attacker/preload.js',
  UNRELATED_CANARY: 'ambient-canary',
};

class TestAccountRegistry extends AccountRegistry {
  constructor(private readonly fixedBase?: NodeJS.ProcessEnv) {
    super([{
      id: 'personal',
      runtimeId: CLAUDE_RUNTIME_ID,
      configDir: 'C:/claude-personal',
    }]);
  }

  override buildEnv(
    runtimeId: string,
    accountId: string,
    base: NodeJS.ProcessEnv = this.fixedBase ?? process.env,
  ): Record<string, string> {
    return super.buildEnv(runtimeId, accountId, base);
  }
}

function accounts(base?: NodeJS.ProcessEnv): AccountRegistry {
  return new TestAccountRegistry(base);
}

function assertLeastPrivilegeClaudeEnv(env: NodeJS.ProcessEnv | undefined): void {
  assert.deepEqual(env, {
    PATH: 'C:/safe-bin',
    CLAUDE_CONFIG_DIR: 'C:/claude-personal',
  });
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
  getContextUsage: () => Promise<unknown> = async () => ({
    totalTokens: 0,
    maxTokens: 100,
    rawMaxTokens: 100,
  }),
): Query {
  return Object.assign(iterator, {
    supportedModels: async () => models,
    getContextUsage,
    interrupt: async () => { close(); return undefined; },
    close,
  }) as unknown as Query;
}

function completedSessionQuery(input: {
  prompt: string | AsyncIterable<SDKUserMessage>;
  context: () => Promise<unknown>;
  iterations?: unknown;
  messageUsage?: unknown;
  sidechainIterations?: unknown;
  additionalMessages?: SDKMessage[];
}): Query {
  const stopped = gate();
  async function* messages(): AsyncGenerator<SDKMessage, void> {
    if (typeof input.prompt !== 'string') await input.prompt[Symbol.asyncIterator]().next();
    yield {
      type: 'system', subtype: 'init', uuid: 'init-context', session_id: 'native-context',
    } as unknown as SDKMessage;
    yield {
      type: 'assistant', uuid: 'assistant-primary', session_id: 'native-context',
      parent_tool_use_id: null,
      message: {
        id: 'message-primary', content: [],
        usage: input.messageUsage ?? { iterations: input.iterations ?? null },
      },
    } as unknown as SDKMessage;
    if (input.sidechainIterations !== undefined) {
      yield {
        type: 'assistant', uuid: 'assistant-sidechain', session_id: 'native-context',
        parent_tool_use_id: 'parent-tool',
        message: {
          id: 'message-sidechain', content: [],
          usage: { iterations: input.sidechainIterations },
        },
      } as unknown as SDKMessage;
    }
    for (const message of input.additionalMessages ?? []) yield message;
    yield {
      type: 'result', subtype: 'success', is_error: false,
      uuid: 'result-context', session_id: 'native-context',
      usage: {
        input_tokens: 1, output_tokens: 2,
        cache_creation_input_tokens: 0, cache_read_input_tokens: 0,
      },
      modelUsage: { opus: {} },
    } as unknown as SDKMessage;
    await stopped.promise;
  }
  return queryObject(messages(), MODELS, stopped.resolve, input.context);
}

async function runCompletedTurn(session: ClaudeRuntimeSession): Promise<RuntimeEvent[]> {
  const events: RuntimeEvent[] = [];
  for await (const event of session.sendTurn('context please')) events.push(event);
  return events;
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

// Reproduces the observed raw-SDK stream order for a SessionStart hook
// (e.g. a ~/.claude plugin's session-start injection): hook_started and
// hook_response arrive before the init that carries the native session id.
function sessionQueryWithPreInitHookNoise(
  prompt: string | AsyncIterable<SDKUserMessage>,
  nativeSessionId: string,
): Query {
  const stopped = gate();
  async function* messages(): AsyncGenerator<SDKMessage, void> {
    if (typeof prompt !== 'string') await prompt[Symbol.asyncIterator]().next();
    yield { type: 'system', subtype: 'hook_started', uuid: 'hook-started-1' } as unknown as SDKMessage;
    yield { type: 'system', subtype: 'hook_started', uuid: 'hook-started-2' } as unknown as SDKMessage;
    yield { type: 'system', subtype: 'hook_started', uuid: 'hook-started-3' } as unknown as SDKMessage;
    yield { type: 'system', subtype: 'hook_response', uuid: 'hook-response-1' } as unknown as SDKMessage;
    yield { type: 'system', subtype: 'hook_response', uuid: 'hook-response-2' } as unknown as SDKMessage;
    yield { type: 'system', subtype: 'hook_response', uuid: 'hook-response-3' } as unknown as SDKMessage;
    yield {
      type: 'system', subtype: 'init', uuid: 'init-1', session_id: nativeSessionId,
    } as unknown as SDKMessage;
    yield {
      type: 'assistant', uuid: 'assistant-1', session_id: nativeSessionId,
      parent_tool_use_id: null,
      message: { id: 'message-1', content: [], usage: { iterations: null } },
    } as unknown as SDKMessage;
    yield {
      type: 'result', subtype: 'success', is_error: false,
      uuid: 'result-1', session_id: nativeSessionId,
      usage: {
        input_tokens: 1, output_tokens: 2,
        cache_creation_input_tokens: 0, cache_read_input_tokens: 0,
      },
      modelUsage: { opus: {} },
    } as unknown as SDKMessage;
    await stopped.promise;
  }
  return queryObject(messages(), MODELS, stopped.resolve);
}

/** Like `sessionQuery`, but records every user message pulled off the prompt
 * async iterable instead of consuming exactly one. Used to prove a leading
 * seedContext message is queued ahead of the real user turn. */
function sessionQueryCapturingPrompts(
  prompt: string | AsyncIterable<SDKUserMessage>,
  nativeSessionId: string,
  capturedPrompts: SDKUserMessage[],
): Query {
  const stopped = gate();
  async function* messages(): AsyncGenerator<SDKMessage, void> {
    if (typeof prompt === 'string') {
      yield {
        type: 'system', subtype: 'init', uuid: 'init-1', session_id: nativeSessionId,
      } as unknown as SDKMessage;
      await stopped.promise;
      return;
    }
    const iter = prompt[Symbol.asyncIterator]();
    const first = await iter.next();
    if (!first.done) capturedPrompts.push(first.value);
    yield {
      type: 'system', subtype: 'init', uuid: 'init-1', session_id: nativeSessionId,
    } as unknown as SDKMessage;
    const second = await iter.next();
    if (!second.done) capturedPrompts.push(second.value);
    yield {
      type: 'assistant', uuid: 'assistant-1', session_id: nativeSessionId,
      parent_tool_use_id: null,
      message: { id: 'message-1', content: [], usage: { iterations: null } },
    } as unknown as SDKMessage;
    yield {
      type: 'result', subtype: 'success', is_error: false,
      uuid: 'result-1', session_id: nativeSessionId,
      usage: {
        input_tokens: 1, output_tokens: 2,
        cache_creation_input_tokens: 0, cache_read_input_tokens: 0,
      },
      modelUsage: { opus: {} },
    } as unknown as SDKMessage;
    await stopped.promise;
  }
  return queryObject(messages(), MODELS, stopped.resolve);
}

/** Like `sessionQuery`, but records the single user message it consumes. */
function sessionQuerySingleCapture(
  prompt: string | AsyncIterable<SDKUserMessage>,
  nativeSessionId: string,
  capturedPrompts: SDKUserMessage[],
): Query {
  const stopped = gate();
  async function* messages(): AsyncGenerator<SDKMessage, void> {
    if (typeof prompt === 'string') {
      yield {
        type: 'system', subtype: 'init', uuid: 'init-1', session_id: nativeSessionId,
      } as unknown as SDKMessage;
      await stopped.promise;
      return;
    }
    const first = await prompt[Symbol.asyncIterator]().next();
    if (!first.done) capturedPrompts.push(first.value);
    yield {
      type: 'system', subtype: 'init', uuid: 'init-1', session_id: nativeSessionId,
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

const CLAUDE_CONFORMANCE_CREATED_NATIVE_ID = 'claude-created-native';
const CLAUDE_CONFORMANCE_RESUMED_NATIVE_ID = 'claude-resumed-native';
const CLAUDE_CONFORMANCE_TEXT = 'claude conformance response';

function claudeConformanceSessionQuery(input: {
  prompt: string | AsyncIterable<SDKUserMessage>;
  nativeSessionId: string;
  scenario: RuntimeAdapterConformanceScenario;
  blocked: Gate;
  interruptedTerminal: Gate;
  onInterrupt: () => void;
  onClose: () => void;
}): Query {
  const stopped = gate();
  let closed = false;
  async function* messages(): AsyncGenerator<SDKMessage, void> {
    yield {
      type: 'system', subtype: 'init', uuid: 'conformance-init',
      session_id: input.nativeSessionId,
    } as unknown as SDKMessage;
    if (typeof input.prompt !== 'string') {
      await input.prompt[Symbol.asyncIterator]().next();
    }

    if (input.scenario === 'interrupt' || input.scenario === 'dispose') {
      // A provider-neutral activity frame makes the conformance scanner prove
      // that command acceptance is correlated to the result, not array shape.
      yield {
        type: 'system', subtype: 'status', status: 'requesting',
        uuid: 'conformance-status', session_id: input.nativeSessionId,
      } as unknown as SDKMessage;
      input.blocked.resolve();
      if (input.scenario === 'interrupt') {
        await input.interruptedTerminal.promise;
        yield {
          type: 'result', subtype: 'error_during_execution', is_error: true,
          terminal_reason: 'aborted_streaming', uuid: 'conformance-aborted',
          session_id: input.nativeSessionId,
        } as unknown as SDKMessage;
      } else {
        await stopped.promise;
      }
      return;
    }

    yield {
      type: 'assistant', uuid: 'conformance-assistant',
      session_id: input.nativeSessionId, parent_tool_use_id: null,
      message: {
        id: 'conformance-message',
        content: [{ type: 'text', text: CLAUDE_CONFORMANCE_TEXT }],
        usage: { iterations: null },
      },
    } as unknown as SDKMessage;
    yield {
      type: 'result', subtype: 'success', is_error: false,
      stop_reason: 'end_turn', num_turns: 1, duration_ms: 1,
      uuid: 'conformance-result', session_id: input.nativeSessionId,
      usage: {
        input_tokens: 1, output_tokens: 2,
        cache_creation_input_tokens: 0, cache_read_input_tokens: 0,
      },
      modelUsage: { opus: {} },
    } as unknown as SDKMessage;
    await stopped.promise;
  }

  const iterator = messages();
  return Object.assign(iterator, {
    supportedModels: async () => MODELS,
    getContextUsage: async () => ({
      totalTokens: 12, maxTokens: 100, rawMaxTokens: 100,
    }),
    interrupt: async () => { input.onInterrupt(); return undefined; },
    close: () => {
      if (closed) return;
      closed = true;
      input.onClose();
      stopped.resolve();
    },
  }) as unknown as Query;
}

const claudeRuntimeAdapterConformanceFixture: RuntimeAdapterConformanceFactory = (
  scenario,
) => {
  const blocked = gate();
  const interruptedTerminal = gate();
  let interruptAcceptances = 0;
  let nativeCloses = 0;
  const adapter = new ClaudeRuntimeAdapter({
    accounts: accounts(),
    queryFactory: (params) => {
      if (params.options?.model === undefined) return discoveryQuery(MODELS);
      const requestedNativeSessionId = params.options.resume;
      return claudeConformanceSessionQuery({
        prompt: params.prompt,
        nativeSessionId: typeof requestedNativeSessionId === 'string'
          ? requestedNativeSessionId
          : CLAUDE_CONFORMANCE_CREATED_NATIVE_ID,
        scenario,
        blocked,
        interruptedTerminal,
        onInterrupt: () => { interruptAcceptances += 1; },
        onClose: () => { nativeCloses += 1; },
      });
    },
  });
  return {
    adapter,
    selection: selection({ kind: 'selected', value: 'high' }),
    missingAccountId: 'missing',
    expectedText: CLAUDE_CONFORMANCE_TEXT,
    expectedContext: {
      confidence: 'derived', usedTokens: 12,
      usableTokens: 100, contextWindowTokens: 100,
    },
    createdNativeSessionId: CLAUDE_CONFORMANCE_CREATED_NATIVE_ID,
    resumedNativeSessionId: CLAUDE_CONFORMANCE_RESUMED_NATIVE_ID,
    cwd: resolve('.'),
    blockedTurnReady: blocked.promise,
    releaseInterruptedTurn: interruptedTerminal.resolve,
    interruptAcceptanceCount: () => interruptAcceptances,
    nativeCloseCount: () => nativeCloses,
  };
};

runtimeAdapterConformance('generic fake', genericRuntimeAdapterConformanceFixture);
runtimeAdapterConformance('Claude', claudeRuntimeAdapterConformanceFixture);

test('generic fake adapter accepts an app-owned seedContext with no native effect', async () => {
  const fixture = await genericRuntimeAdapterConformanceFixture('receipts');
  const session = await fixture.adapter.createSession({
    appSessionId: 'generic-seed-context', projectId: 'conformance-project',
    continuationAttemptId: 'conformance-create-attempt', selection: fixture.selection,
    cwd: fixture.cwd, seedContext: 'PRIOR CONVERSATION SEED',
  });
  const events = [];
  for await (const event of session.sendTurn('one conformance turn')) events.push(event);
  assert.equal(events.at(-1)?.type, 'result');
  await session.dispose();
});

test('Claude adapter declares app-tool bridging supported', async () => {
  const fixture = await claudeRuntimeAdapterConformanceFixture('discovery');
  assert.equal(fixture.adapter.appToolBridge, 'supported');
});

test('Claude session config requires an exact durable continuation attempt identity', () => {
  for (const continuationAttemptId of ['', ' attempt-padded ']) {
    assert.throws(
      () => new ClaudeRuntimeSession({
        env: TEST_CLAUDE_ENV, continuationAttemptId, selection: selection({ kind: 'none' }),
      }),
      /runtime continuation attempt identity is invalid/,
    );
  }
  assert.throws(
    () => new ClaudeRuntimeSession({
      env: TEST_CLAUDE_ENV, selection: selection({ kind: 'none' }),
    } as never),
    /runtime continuation attempt identity is invalid/,
  );
});

test('Claude final query seam re-sanitizes a direct dirty session environment', async () => {
  const captures: Array<Parameters<ClaudeQueryFactory>[0]> = [];
  const session = new ClaudeRuntimeSession({
    env: {
      ...DIRTY_RUNTIME_ENV,
      CLAUDE_CONFIG_DIR: 'C:/claude-personal',
    } as Record<string, string>,
    continuationAttemptId: ATTEMPT_ID,
    selection: selection({ kind: 'none' }),
    queryFactory: (params) => {
      captures.push(params);
      return discoveryQuery(MODELS);
    },
  });

  // Exercise the final query boundary, not only the constructor snapshot.
  // A late internal canary still cannot restore an ambient capability.
  const internal = session as unknown as {
    config: { env: Record<string, string> };
  };
  internal.config.env.PC_AINATIVE_PM_TOKEN = 'late-pm-token-canary';
  internal.config.env.NODE_OPTIONS = '--require=C:/attacker/late-preload.js';
  internal.config.env.claude_config_dir = 'C:/late-lowercase-lookalike';

  await session.start({ appSessionId: 'app-direct-env' });
  assert.equal(captures.length, 1);
  assertLeastPrivilegeClaudeEnv(captures[0]?.options?.env);
  await session.dispose();
});

test('Claude final query seam refuses a missing or malformed selected credential home', () => {
  const inheritedHome = Object.create({
    CLAUDE_CONFIG_DIR: resolve('test-fixtures/inherited-home'),
  }) as Record<string, string>;
  const invalidEnvironments: Array<Record<string, string>> = [
    {},
    { CLAUDE_CONFIG_DIR: 'relative-home' },
    { CLAUDE_CONFIG_DIR: ' padded-home ' },
    { claude_config_dir: resolve('test-fixtures/lowercase-lookalike') },
    inheritedHome,
  ];
  for (const env of invalidEnvironments) {
    assert.throws(
      () => new ClaudeRuntimeSession({
        env,
        continuationAttemptId: ATTEMPT_ID,
        selection: selection({ kind: 'none' }),
      }),
      /runtime credential home is unavailable/,
    );
  }
});

test('Claude context observation uses the latest primary iteration as the exact numerator', async () => {
  const session = new ClaudeRuntimeSession({
    env: TEST_CLAUDE_ENV, continuationAttemptId: ATTEMPT_ID, selection: selection({ kind: 'none' }),
    queryFactory: ({ prompt }) => completedSessionQuery({
      prompt,
      iterations: [{
        type: 'message', input_tokens: 40,
        cache_creation_input_tokens: 5, cache_read_input_tokens: 5,
      }],
      sidechainIterations: [{
        type: 'message', input_tokens: 90,
        cache_creation_input_tokens: 5, cache_read_input_tokens: 5,
      }],
      context: async () => ({
        totalTokens: 41, maxTokens: 100, rawMaxTokens: 200,
        percentage: 99,
        categories: [{ path: 'SECRET', tool: 'SECRET' }],
      }),
    }),
  });
  await session.start({ appSessionId: 'app-context' });
  assert.equal((await runCompletedTurn(session)).at(-1)?.type, 'result');
  assert.deepEqual(await session.observeContext(), {
    confidence: 'exact', usedTokens: 50, usableTokens: 100, contextWindowTokens: 200,
  });
  assert.equal(JSON.stringify(await session.observeContext()).includes('SECRET'), false);
  await session.dispose();
});

test('Claude compaction invalidates prior exact evidence but preserves its runtime event', async () => {
  const session = new ClaudeRuntimeSession({
    env: TEST_CLAUDE_ENV, continuationAttemptId: ATTEMPT_ID, selection: selection({ kind: 'none' }),
    queryFactory: ({ prompt }) => completedSessionQuery({
      prompt,
      iterations: [{
        type: 'message', input_tokens: 40,
        cache_creation_input_tokens: 5, cache_read_input_tokens: 5,
      }],
      additionalMessages: [{
        type: 'system', subtype: 'compact_boundary', uuid: 'compact-context',
        session_id: 'native-context',
        compact_metadata: { trigger: 'auto', pre_tokens: 50, post_tokens: 20 },
      } as unknown as SDKMessage],
      context: async () => ({ totalTokens: 20, maxTokens: 100, rawMaxTokens: 200 }),
    }),
  });
  await session.start({ appSessionId: 'app-context-compacted' });
  const events = await runCompletedTurn(session);
  assert.equal(events.some((event) => event.type === 'compaction'), true);
  assert.deepEqual(await session.observeContext(), {
    confidence: 'derived', usedTokens: 20, usableTokens: 100, contextWindowTokens: 200,
  });
  await session.dispose();
});

test('Claude accepts valid primary evidence emitted after compaction as exact', async () => {
  const session = new ClaudeRuntimeSession({
    env: TEST_CLAUDE_ENV, continuationAttemptId: ATTEMPT_ID, selection: selection({ kind: 'none' }),
    queryFactory: ({ prompt }) => completedSessionQuery({
      prompt,
      iterations: [{
        type: 'message', input_tokens: 40,
        cache_creation_input_tokens: 5, cache_read_input_tokens: 5,
      }],
      additionalMessages: [
        {
          type: 'system', subtype: 'compact_boundary', uuid: 'compact-before-primary',
          session_id: 'native-context',
          compact_metadata: { trigger: 'manual', pre_tokens: 50, post_tokens: 20 },
        } as unknown as SDKMessage,
        {
          type: 'assistant', uuid: 'assistant-after-compact', session_id: 'native-context',
          parent_tool_use_id: null,
          message: {
            id: 'message-after-compact', content: [],
            usage: {
              iterations: [{
                type: 'message', input_tokens: 30,
                cache_creation_input_tokens: 0, cache_read_input_tokens: 0,
              }],
            },
          },
        } as unknown as SDKMessage,
      ],
      context: async () => ({ totalTokens: 20, maxTokens: 100, rawMaxTokens: 200 }),
    }),
  });
  await session.start({ appSessionId: 'app-context-post-compact-primary' });
  await runCompletedTurn(session);
  assert.deepEqual(await session.observeContext(), {
    confidence: 'exact', usedTokens: 30, usableTokens: 100, contextWindowTokens: 200,
  });
  await session.dispose();
});

test('Claude fails closed when malformed assistant ownership follows exact evidence', async () => {
  for (const parentToolUseId of [undefined, '', 42]) {
    const malformedAssistant = {
      type: 'assistant', uuid: `assistant-malformed-parent-${String(parentToolUseId)}`,
      session_id: 'native-context',
      ...(parentToolUseId === undefined ? {} : { parent_tool_use_id: parentToolUseId }),
      message: {
        id: `message-malformed-parent-${String(parentToolUseId)}`, content: [],
        usage: {
          iterations: [{
            type: 'message', input_tokens: 90,
            cache_creation_input_tokens: 0, cache_read_input_tokens: 0,
          }],
        },
      },
    } as unknown as SDKMessage;
    const session = new ClaudeRuntimeSession({
      env: TEST_CLAUDE_ENV, continuationAttemptId: ATTEMPT_ID, selection: selection({ kind: 'none' }),
      queryFactory: ({ prompt }) => completedSessionQuery({
        prompt,
        iterations: [{
          type: 'message', input_tokens: 40,
          cache_creation_input_tokens: 5, cache_read_input_tokens: 5,
        }],
        additionalMessages: [malformedAssistant],
        context: async () => ({ totalTokens: 20, maxTokens: 100, rawMaxTokens: 200 }),
      }),
    });
    await session.start({ appSessionId: `app-context-malformed-parent-${String(parentToolUseId)}` });
    await runCompletedTurn(session);
    assert.deepEqual(await session.observeContext(), {
      confidence: 'unavailable', reason: 'invalid-observation',
    });
    await session.dispose();
  }
});

test('Claude fences a pending context control from a late compact boundary', async () => {
  const controlStarted = gate();
  const releaseControl = gate();
  const session = new ClaudeRuntimeSession({
    env: TEST_CLAUDE_ENV, continuationAttemptId: ATTEMPT_ID, selection: selection({ kind: 'none' }),
    queryFactory: ({ prompt }) => completedSessionQuery({
      prompt,
      iterations: [{
        type: 'message', input_tokens: 40,
        cache_creation_input_tokens: 5, cache_read_input_tokens: 5,
      }],
      context: async () => {
        controlStarted.resolve();
        await releaseControl.promise;
        return { totalTokens: 20, maxTokens: 100, rawMaxTokens: 200 };
      },
    }),
  });
  await session.start({ appSessionId: 'app-context-late-compact' });
  await runCompletedTurn(session);
  const pending = session.observeContext();
  await controlStarted.promise;
  (session as unknown as { route(message: SDKMessage): void }).route({
    type: 'system', subtype: 'compact_boundary', uuid: 'late-compact-context',
    session_id: 'native-context',
    compact_metadata: { trigger: 'auto', pre_tokens: 50, post_tokens: 20 },
  } as unknown as SDKMessage);
  releaseControl.resolve();
  assert.deepEqual(await pending, {
    confidence: 'derived', usedTokens: 20, usableTokens: 100, contextWindowTokens: 200,
  });
  await session.dispose();
});

test('Claude context observation uses valid direct message usage as an exact fallback', async () => {
  const session = new ClaudeRuntimeSession({
    env: TEST_CLAUDE_ENV, continuationAttemptId: ATTEMPT_ID, selection: selection({ kind: 'none' }),
    queryFactory: ({ prompt }) => completedSessionQuery({
      prompt,
      messageUsage: {
        iterations: null,
        input_tokens: 30,
        cache_creation_input_tokens: 10,
        cache_read_input_tokens: 10,
      },
      context: async () => ({ totalTokens: 7, maxTokens: 100, rawMaxTokens: 200 }),
    }),
  });
  await session.start({ appSessionId: 'app-context-fallback' });
  await runCompletedTurn(session);
  assert.deepEqual(await session.observeContext(), {
    confidence: 'exact', usedTokens: 50, usableTokens: 100, contextWindowTokens: 200,
  });
  await session.dispose();
});

test('Claude context observation accepts a fallback_message iteration as exact', async () => {
  const session = new ClaudeRuntimeSession({
    env: TEST_CLAUDE_ENV, continuationAttemptId: ATTEMPT_ID, selection: selection({ kind: 'none' }),
    queryFactory: ({ prompt }) => completedSessionQuery({
      prompt,
      iterations: [{
        type: 'fallback_message',
        input_tokens: 30,
        cache_creation_input_tokens: 10,
        cache_read_input_tokens: 10,
      }],
      context: async () => ({ totalTokens: 7, maxTokens: 100, rawMaxTokens: 200 }),
    }),
  });
  await session.start({ appSessionId: 'app-context-fallback-iteration' });
  await runCompletedTurn(session);
  assert.deepEqual(await session.observeContext(), {
    confidence: 'exact', usedTokens: 50, usableTokens: 100, contextWindowTokens: 200,
  });
  await session.dispose();
});

test('Claude context observation is derived only when local input/cache evidence is absent', async () => {
  for (const messageUsage of [
    { iterations: null },
    {},
  ]) {
    const session = new ClaudeRuntimeSession({
      env: TEST_CLAUDE_ENV, continuationAttemptId: ATTEMPT_ID, selection: selection({ kind: 'none' }),
      queryFactory: ({ prompt }) => completedSessionQuery({
        prompt,
        messageUsage,
        context: async () => ({ totalTokens: 50, maxTokens: 100, rawMaxTokens: 200 }),
      }),
    });
    await session.start({ appSessionId: 'app-context-derived' });
    await runCompletedTurn(session);
    assert.deepEqual(await session.observeContext(), {
      confidence: 'derived', usedTokens: 50, usableTokens: 100, contextWindowTokens: 200,
    });
    await session.dispose();
  }
});

test('Claude context observation fails closed on malformed non-null local evidence', async () => {
  const throwingUsage = Object.defineProperty({}, 'iterations', {
    enumerable: true,
    get: () => { throw new Error('SECRET native usage getter'); },
  });
  for (const messageUsage of [
    'malformed',
    [],
    { iterations: [] },
    { iterations: 'malformed' },
    { iterations: undefined },
    {
      input_tokens: 40,
      cache_creation_input_tokens: 5,
      cache_read_input_tokens: 5,
    },
    {
      iterations: [{
        input_tokens: 40,
        cache_creation_input_tokens: 5,
        cache_read_input_tokens: 5,
      }],
    },
    {
      iterations: [{
        type: 'compaction',
        input_tokens: 40,
        cache_creation_input_tokens: 5,
        cache_read_input_tokens: 5,
      }],
    },
    {
      iterations: [{
        type: 'advisor_message',
        input_tokens: 40,
        cache_creation_input_tokens: 5,
        cache_read_input_tokens: 5,
      }],
    },
    {
      iterations: [{
        type: 'message',
        input_tokens: 40,
        cache_creation_input_tokens: null,
        cache_read_input_tokens: 5,
      }],
    },
    { iterations: null, input_tokens: 40 },
    {
      iterations: null,
      input_tokens: 40,
      cache_creation_input_tokens: null,
      cache_read_input_tokens: 5,
    },
    throwingUsage,
  ]) {
    const session = new ClaudeRuntimeSession({
      env: TEST_CLAUDE_ENV, continuationAttemptId: ATTEMPT_ID, selection: selection({ kind: 'none' }),
      queryFactory: ({ prompt }) => completedSessionQuery({
        prompt,
        messageUsage,
        context: async () => ({ totalTokens: 50, maxTokens: 100, rawMaxTokens: 200 }),
      }),
    });
    await session.start({ appSessionId: 'app-context-invalid-local' });
    const events = await runCompletedTurn(session);
    const terminal = events.at(-1);
    assert.ok(terminal?.type === 'result' && terminal.ok, 'context parsing cannot fail the turn');
    assert.deepEqual(await session.observeContext(), {
      confidence: 'unavailable', reason: 'invalid-observation',
    });
    await session.dispose();
  }
});

test('Claude context observation rejects malformed native counts and scrubs failures', async () => {
  const observations = [
    { totalTokens: -1, maxTokens: 100, rawMaxTokens: 200 },
    { totalTokens: 50.5, maxTokens: 100, rawMaxTokens: 200 },
    { totalTokens: 50, maxTokens: 0, rawMaxTokens: 200 },
    { totalTokens: 101, maxTokens: 100, rawMaxTokens: 200 },
    { totalTokens: 50, maxTokens: 201, rawMaxTokens: 200 },
    { totalTokens: 50, maxTokens: 100 },
  ];
  for (const native of observations) {
    const session = new ClaudeRuntimeSession({
      env: TEST_CLAUDE_ENV, continuationAttemptId: ATTEMPT_ID, selection: selection({ kind: 'none' }),
      queryFactory: ({ prompt }) => completedSessionQuery({
        prompt,
        context: async () => native,
      }),
    });
    await session.start({ appSessionId: 'app-context-invalid' });
    await runCompletedTurn(session);
    assert.deepEqual(await session.observeContext(), {
      confidence: 'unavailable', reason: 'invalid-observation',
    });
    await session.dispose();
  }

  const invalidControlWithExactEvidence = new ClaudeRuntimeSession({
    env: TEST_CLAUDE_ENV, continuationAttemptId: ATTEMPT_ID, selection: selection({ kind: 'none' }),
    queryFactory: ({ prompt }) => completedSessionQuery({
      prompt,
      iterations: [{
        type: 'fallback_message',
        input_tokens: 40,
        cache_creation_input_tokens: 5,
        cache_read_input_tokens: 5,
      }],
      context: async () => ({ totalTokens: -1, maxTokens: 100, rawMaxTokens: 200 }),
    }),
  });
  await invalidControlWithExactEvidence.start({ appSessionId: 'app-context-invalid-control' });
  await runCompletedTurn(invalidControlWithExactEvidence);
  assert.deepEqual(await invalidControlWithExactEvidence.observeContext(), {
    confidence: 'unavailable', reason: 'invalid-observation',
  });
  await invalidControlWithExactEvidence.dispose();

  const failed = new ClaudeRuntimeSession({
    env: TEST_CLAUDE_ENV, continuationAttemptId: ATTEMPT_ID, selection: selection({ kind: 'none' }),
    queryFactory: ({ prompt }) => completedSessionQuery({
      prompt,
      context: async () => { throw new Error('SECRET native context failure'); },
    }),
  });
  await failed.start({ appSessionId: 'app-context-failed' });
  await runCompletedTurn(failed);
  const unavailable = await failed.observeContext();
  assert.deepEqual(unavailable, { confidence: 'unavailable', reason: 'runtime-unavailable' });
  assert.equal(JSON.stringify(unavailable).includes('SECRET'), false);
  await failed.dispose();
});

test('Claude never starts a context control request while a turn is active', async () => {
  const allowResult = gate();
  let contextCalls = 0;
  const session = new ClaudeRuntimeSession({
    env: TEST_CLAUDE_ENV, continuationAttemptId: ATTEMPT_ID, selection: selection({ kind: 'none' }),
    queryFactory: ({ prompt }) => {
      const stopped = gate();
      async function* messages(): AsyncGenerator<SDKMessage, void> {
        if (typeof prompt !== 'string') await prompt[Symbol.asyncIterator]().next();
        yield {
          type: 'system', subtype: 'init', uuid: 'init-active-context',
          session_id: 'native-active-context',
        } as unknown as SDKMessage;
        await allowResult.promise;
        yield {
          type: 'result', subtype: 'success', is_error: false,
          uuid: 'result-active-context', session_id: 'native-active-context',
          usage: {
            input_tokens: 1, output_tokens: 1,
            cache_creation_input_tokens: 0, cache_read_input_tokens: 0,
          },
          modelUsage: { opus: {} },
        } as unknown as SDKMessage;
        await stopped.promise;
      }
      return queryObject(messages(), MODELS, stopped.resolve, async () => {
        contextCalls += 1;
        return { totalTokens: 1, maxTokens: 100, rawMaxTokens: 100 };
      });
    },
  });
  await session.start({ appSessionId: 'app-context-active' });
  const iterator = session.sendTurn('hold active')[Symbol.asyncIterator]();
  assert.equal((await iterator.next()).value?.type, 'session-started');
  assert.deepEqual(await session.observeContext(), {
    confidence: 'unavailable', reason: 'runtime-unavailable',
  });
  assert.equal(contextCalls, 0);
  allowResult.resolve();
  while (!(await iterator.next()).done) { /* drain */ }
  await session.dispose();
});

test('Claude bounds a hung context control and fences successor/disposal races', async () => {
  const controlStarted = gate();
  const releaseControl = gate();
  let contextCalls = 0;
  const session = new ClaudeRuntimeSession({
    env: TEST_CLAUDE_ENV, continuationAttemptId: ATTEMPT_ID, selection: selection({ kind: 'none' }),
    queryFactory: ({ prompt }) => completedSessionQuery({
      prompt,
      context: async () => {
        contextCalls += 1;
        controlStarted.resolve();
        await releaseControl.promise;
        return { totalTokens: 1, maxTokens: 100, rawMaxTokens: 100 };
      },
    }),
  });
  await session.start({ appSessionId: 'app-context-hung' });
  await runCompletedTurn(session);
  const pending = session.observeContext();
  await controlStarted.promise;
  assert.deepEqual(await session.observeContext(), {
    confidence: 'unavailable', reason: 'runtime-unavailable',
  });
  assert.equal(contextCalls, 1, 'a hung native control is never multiplied');

  session.sendTurn('successor');
  assert.deepEqual(await session.observeContext(), {
    confidence: 'unavailable', reason: 'runtime-unavailable',
  });
  await session.dispose();
  releaseControl.resolve();
  assert.deepEqual(await pending, {
    confidence: 'unavailable', reason: 'runtime-unavailable',
  });
  assert.equal(contextCalls, 1);
});

test('Claude rejects a pending context receipt after native identity failure', async () => {
  const controlStarted = gate();
  const releaseControl = gate();
  const session = new ClaudeRuntimeSession({
    env: TEST_CLAUDE_ENV, continuationAttemptId: ATTEMPT_ID, selection: selection({ kind: 'none' }),
    queryFactory: ({ prompt }) => completedSessionQuery({
      prompt,
      context: async () => {
        controlStarted.resolve();
        await releaseControl.promise;
        return { totalTokens: 1, maxTokens: 100, rawMaxTokens: 100 };
      },
    }),
  });
  await session.start({ appSessionId: 'app-context-identity-fence' });
  await runCompletedTurn(session);
  const pending = session.observeContext();
  await controlStarted.promise;
  (session as unknown as { route(message: SDKMessage): void }).route({
    type: 'system', subtype: 'init', uuid: 'conflicting-init',
    session_id: 'different-native-session',
  } as unknown as SDKMessage);
  releaseControl.resolve();
  assert.deepEqual(await pending, {
    confidence: 'unavailable', reason: 'runtime-unavailable',
  });
  await session.dispose();
});

test('Claude discovery is account-scoped and retains per-model effort truth', async () => {
  const captures: Array<Parameters<ClaudeQueryFactory>[0]> = [];
  const adapter = new ClaudeRuntimeAdapter({
    accounts: accounts(DIRTY_RUNTIME_ENV),
    queryFactory: (params) => {
      captures.push(params);
      return discoveryQuery(MODELS);
    },
  });

  assert.deepEqual(await adapter.capabilities('missing'), {
    runtimeId: CLAUDE_RUNTIME_ID,
    accountId: 'missing',
    nativeContinuation: { status: 'unavailable', code: 'account-unavailable' },
    continuationAcrossSelectionChange: { status: 'unavailable', code: 'account-unavailable' },
    modelDiscovery: { status: 'unavailable', code: 'account-unavailable' },
    effortControl: { status: 'unavailable', code: 'account-unavailable' },
    context: {
      currentUse: { status: 'unavailable', code: 'account-unavailable' },
      compaction: { status: 'unavailable', code: 'account-unavailable' },
    },
    subscriptionQuota: { status: 'unavailable', code: 'account-unavailable' },
  });
  assert.deepEqual(await adapter.listModels('missing'), {
    status: 'unavailable', code: 'account-unavailable',
  });
  assert.equal(captures.length, 0);

  assert.deepEqual(await adapter.capabilities('personal'), {
    runtimeId: CLAUDE_RUNTIME_ID,
    accountId: 'personal',
    nativeContinuation: { status: 'supported' },
    continuationAcrossSelectionChange: { status: 'supported' },
    modelDiscovery: { status: 'supported' },
    effortControl: { status: 'supported' },
    context: {
      currentUse: { status: 'supported', confidences: ['exact', 'derived'] },
      compaction: { status: 'supported' },
    },
    subscriptionQuota: {
      status: 'supported', sourceSemantics: ['used'], confidences: ['exact'],
    },
  });

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
  assertLeastPrivilegeClaudeEnv(captures[0]?.options?.env);
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
    accounts: accounts(DIRTY_RUNTIME_ENV),
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
  assertLeastPrivilegeClaudeEnv(captures[0]?.options?.env);
  assertLeastPrivilegeClaudeEnv(captures[1]?.options?.env);
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

test("Claude create omits options.model for the 'default' selection instead of passing it verbatim", async () => {
  const DEFAULT_MODELS: ModelInfo[] = [
    { value: 'default', displayName: 'Default', description: '', supportsEffort: false },
    ...MODELS,
  ];
  const captures: Array<Parameters<ClaudeQueryFactory>[0]> = [];
  const adapter = new ClaudeRuntimeAdapter({
    accounts: accounts(DIRTY_RUNTIME_ENV),
    queryFactory: (params) => {
      captures.push(params);
      return captures.length % 2 === 1
        ? discoveryQuery(DEFAULT_MODELS)
        : sessionQuery(params.prompt, 'native-created-default');
    },
  });
  const selected: RuntimeSelection = {
    runtimeId: CLAUDE_RUNTIME_ID, accountId: 'personal', model: 'default', effort: { kind: 'unavailable' },
  };
  const runtime = await adapter.createSession({
    appSessionId: 'app-1', projectId: 'project-1',
    continuationAttemptId: ATTEMPT_ID, selection: selected,
  });

  assert.equal(captures.length, 2);
  // 'default' is a legitimate discovered id meaning "let the SDK pick its
  // own default" — passing it through verbatim as options.model would make
  // the SDK look for a model literally named 'default'. The option must be
  // omitted entirely rather than set to 'default'.
  assert.equal('model' in (captures[1]?.options ?? {}), false);
  const started = await firstEvent(runtime);
  assert.equal(started.type, 'session-started');
  if (started.type === 'session-started') {
    // The stamped selection still honestly records 'default' as what was
    // chosen — only the SDK-facing option is omitted, not the receipt.
    assert.equal(started.receipt.selection.model, 'default');
  }
  await runtime.dispose();
});

test('Claude create with seedContext injects a leading context message before the first real user turn', async () => {
  const capturedPrompts: SDKUserMessage[] = [];
  let calls = 0;
  const adapter = new ClaudeRuntimeAdapter({
    accounts: accounts(DIRTY_RUNTIME_ENV),
    queryFactory: (params) => {
      calls += 1;
      return calls % 2 === 1
        ? discoveryQuery(MODELS)
        : sessionQueryCapturingPrompts(params.prompt, 'native-seeded', capturedPrompts);
    },
  });
  const runtime = await adapter.createSession({
    appSessionId: 'app-1', projectId: 'project-1',
    continuationAttemptId: ATTEMPT_ID, selection: selection({ kind: 'none' }),
    seedContext: 'PRIOR CONVERSATION SEED',
  });
  const events: RuntimeEvent[] = [];
  for await (const event of runtime.sendTurn('real turn text')) events.push(event);

  assert.equal(capturedPrompts.length, 2);
  assert.deepEqual(capturedPrompts[0]?.message, { role: 'user', content: 'PRIOR CONVERSATION SEED' });
  assert.deepEqual(capturedPrompts[1]?.message, { role: 'user', content: 'real turn text' });
  // The seed's own native reply is out-of-turn (no active `currentTurn` yet)
  // and must never surface as a second session-started/result pair.
  assert.equal(events.filter((e) => e.type === 'session-started').length, 1);
  assert.equal(events.filter((e) => e.type === 'result').length, 1);
  await runtime.dispose();
});

test('Claude create without seedContext queues only the real user turn, unchanged', async () => {
  const capturedPrompts: SDKUserMessage[] = [];
  let calls = 0;
  const adapter = new ClaudeRuntimeAdapter({
    accounts: accounts(DIRTY_RUNTIME_ENV),
    queryFactory: (params) => {
      calls += 1;
      return calls % 2 === 1
        ? discoveryQuery(MODELS)
        : sessionQuerySingleCapture(params.prompt, 'native-unseeded', capturedPrompts);
    },
  });
  const runtime = await adapter.createSession({
    appSessionId: 'app-1', projectId: 'project-1',
    continuationAttemptId: ATTEMPT_ID, selection: selection({ kind: 'none' }),
  });
  await firstEvent(runtime);
  assert.equal(capturedPrompts.length, 1);
  assert.deepEqual(capturedPrompts[0]?.message, { role: 'user', content: 'hello' });
  await runtime.dispose();
});

test('Claude resume requires an exact native init receipt and never falls back to create', async () => {
  const captures: Array<Parameters<ClaudeQueryFactory>[0]> = [];
  const adapter = new ClaudeRuntimeAdapter({
    accounts: accounts(DIRTY_RUNTIME_ENV),
    queryFactory: factoryWithSession('native-other', captures),
  });
  const selected = selection({ kind: 'none' });
  const runtime = await adapter.resumeSession({
    appSessionId: 'app-1', projectId: 'project-1',
    continuationAttemptId: ATTEMPT_ID, selection: selected,
    nativeSessionId: 'native-requested',
  });

  assert.equal(captures[1]?.options?.resume, 'native-requested');
  assertLeastPrivilegeClaudeEnv(captures[0]?.options?.env);
  assertLeastPrivilegeClaudeEnv(captures[1]?.options?.env);
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

test('Claude tolerates pre-init SessionStart hook noise (hook_started/hook_response) ahead of init', async () => {
  let calls = 0;
  const adapter = new ClaudeRuntimeAdapter({
    accounts: accounts(),
    queryFactory: (params) => {
      calls += 1;
      return calls === 1
        ? discoveryQuery(MODELS)
        : sessionQueryWithPreInitHookNoise(params.prompt, 'native-hook-noise');
    },
  });
  const runtime = await adapter.createSession({
    appSessionId: 'app-1', projectId: 'project-1',
    continuationAttemptId: ATTEMPT_ID,
    selection: selection({ kind: 'none' }),
  });
  const events: RuntimeEvent[] = [];
  for await (const event of runtime.sendTurn('hello')) events.push(event);
  assert.equal(events[0]?.type, 'session-started');
  if (events[0]?.type === 'session-started') {
    assert.equal(events[0].receipt.nativeSessionId, 'native-hook-noise');
  }
  const result = events.find((e) => e.type === 'result');
  assert.ok(result, 'a clean result must follow the pre-init hook noise');
  if (result?.type === 'result') assert.equal(result.ok, true);
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
