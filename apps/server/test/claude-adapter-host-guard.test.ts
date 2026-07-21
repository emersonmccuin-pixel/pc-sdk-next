// Wiring check for the host self-preservation guard: the PreToolUse hook
// tool-safety.ts backs must actually reach the native Options passed to
// query(), and must deny using the live hostPort threaded through session
// input — the whole point being it holds even though this adapter always
// mints the orchestrator with permissionMode 'bypassPermissions' (where
// canUseTool itself is never consulted).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import type {
  HookJSONOutput,
  ModelInfo,
  Options,
  PreToolUseHookInput,
  Query,
  SDKMessage,
} from '@anthropic-ai/claude-agent-sdk';
import { AccountRegistry } from '../src/runner/account-env.ts';
import { CLAUDE_RUNTIME_ID, ClaudeRuntimeAdapter } from '../src/runner/claude-adapter.ts';

const MODELS: ModelInfo[] = [{ value: 'opus', displayName: 'Opus', description: '', supportsEffort: false }];

function accounts(): AccountRegistry {
  return new AccountRegistry([{ id: 'personal', runtimeId: CLAUDE_RUNTIME_ID, configDir: 'C:/claude-personal' }]);
}

interface Gate { promise: Promise<void>; resolve: () => void }
function gate(): Gate {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => { resolve = done; });
  return { promise, resolve };
}

function queryObject(iterator: AsyncGenerator<SDKMessage, void>, models: ModelInfo[], close: () => void): Query {
  return Object.assign(iterator, {
    supportedModels: async () => models,
    getContextUsage: async () => ({ totalTokens: 0, maxTokens: 100, rawMaxTokens: 100 }),
    interrupt: async () => { close(); return undefined; },
    close,
  }) as unknown as Query;
}

function discoveryQuery(): Query {
  const stopped = gate();
  async function* idle(): AsyncGenerator<SDKMessage, void> { await stopped.promise; }
  return queryObject(idle(), MODELS, stopped.resolve);
}

async function preToolUseHook(options: Options | undefined, input: PreToolUseHookInput): Promise<HookJSONOutput> {
  const matcher = options?.hooks?.PreToolUse?.[0];
  assert.ok(matcher, 'PreToolUse hook must be wired into Options');
  const hook = matcher!.hooks[0]!;
  return hook(input, input.tool_use_id, { signal: new AbortController().signal });
}

function preToolUseInput(command: string): PreToolUseHookInput {
  return {
    hook_event_name: 'PreToolUse',
    session_id: 's1',
    transcript_path: '/dev/null',
    cwd: '.',
    tool_name: 'Bash',
    tool_input: { command },
    tool_use_id: 'call-1',
  };
}

test('the PreToolUse hook denies a taskkill against this exact session\'s hostPort', async () => {
  let capturedOptions: Options | undefined;
  const adapter = new ClaudeRuntimeAdapter({
    accounts: accounts(),
    queryFactory: (params) => {
      if (params.options?.model === undefined) return discoveryQuery();
      capturedOptions = params.options;
      const stopped = gate();
      async function* idle(): AsyncGenerator<SDKMessage, void> { await stopped.promise; }
      return queryObject(idle(), MODELS, stopped.resolve);
    },
  });

  const session = await adapter.createSession({
    appSessionId: 'app-1',
    projectId: 'p1',
    continuationAttemptId: 'attempt-1',
    selection: { runtimeId: CLAUDE_RUNTIME_ID, accountId: 'personal', model: 'opus', effort: { kind: 'unavailable' } },
    bypassPermissions: true,
    hostPort: 5124,
  });

  const denied = await preToolUseHook(capturedOptions, preToolUseInput('taskkill /PID ' + process.pid + ' /F'));
  assert.equal((denied as { decision?: string }).decision, 'block');
  assert.match(
    String((denied as { hookSpecificOutput?: { permissionDecisionReason?: string } }).hookSpecificOutput?.permissionDecisionReason),
    /this session runs inside|pid /i,
  );

  const allowed = await preToolUseHook(capturedOptions, preToolUseInput('git status'));
  assert.deepEqual(allowed, {});

  await session.dispose();
});
