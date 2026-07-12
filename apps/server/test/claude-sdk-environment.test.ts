import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { resolve } from 'node:path';
import { PassThrough } from 'node:stream';
import { test } from 'node:test';
import {
  query,
  type SpawnedProcess,
  type SpawnOptions,
} from '@anthropic-ai/claude-agent-sdk';
import { buildAccountEnv } from '../src/runner/account-env.ts';

/** Minimal provider-free process used only to capture the pinned SDK's final
 * spawn options. EOF or a kill request produces the lifecycle receipts the SDK
 * expects without launching Claude Code or making a provider request. */
class FakeClaudeProcess extends EventEmitter implements SpawnedProcess {
  readonly stdin = new PassThrough();
  readonly stdout = new PassThrough();
  killed = false;
  exitCode: number | null = null;

  constructor() {
    super();
    this.stdin.once('finish', () => this.finish());
  }

  kill(_signal: NodeJS.Signals): boolean {
    this.killed = true;
    this.finish();
    return true;
  }

  private finish(): void {
    if (this.exitCode !== null) return;
    this.exitCode = 0;
    this.emit('exit', 0, null);
  }
}

test('pinned Claude SDK final spawn retains only the allowlist, selected home, and SDK markers', () => {
  const selectedConfigDir = resolve('test-fixtures/claude-personal');
  const accountEnv = buildAccountEnv(selectedConfigDir, {
    PATH: 'C:/safe-bin',
    HOME: 'C:/Users/operator',
    PC_AINATIVE_PM_TOKEN: 'pm-token-canary',
    OPENAI_API_KEY: 'openai-api-key-canary',
    ANTHROPIC_API_KEY: 'anthropic-api-key-canary',
    CLAUDE_CONFIG_DIR: 'C:/ambient-claude-home',
    NODE_OPTIONS: '--require=C:/attacker/preload.js',
    UNRELATED_CANARY: 'ambient-canary',
  });
  let captured: SpawnOptions | null = null;
  const previousSdkVersion = process.env.CLAUDE_AGENT_SDK_VERSION;
  let sdkQuery: ReturnType<typeof query> | null = null;
  try {
    sdkQuery = query({
      prompt: '',
      options: {
        env: accountEnv,
        pathToClaudeCodeExecutable: process.execPath,
        spawnClaudeCodeProcess: (options) => {
          captured = options;
          return new FakeClaudeProcess();
        },
      },
    });

    const finalSpawn = captured as SpawnOptions | null;
    assert.ok(finalSpawn, 'the pinned SDK must reach its final spawn seam');
    assert.deepEqual(finalSpawn.env, {
      PATH: 'C:/safe-bin',
      HOME: 'C:/Users/operator',
      CLAUDE_CONFIG_DIR: selectedConfigDir,
      CLAUDE_CODE_ENTRYPOINT: 'sdk-ts',
      CLAUDE_AGENT_SDK_VERSION: '0.3.206',
    });
  } finally {
    sdkQuery?.close();
    if (previousSdkVersion === undefined) delete process.env.CLAUDE_AGENT_SDK_VERSION;
    else process.env.CLAUDE_AGENT_SDK_VERSION = previousSdkVersion;
  }
});
