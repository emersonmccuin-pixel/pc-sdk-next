// Account switcher guards: ambient capabilities are reduced to the shared
// positive allowlist and CLAUDE_CONFIG_DIR is forced (an API key would shadow
// the Max login), and a project's default account resolves from its settings.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { resolve, sep } from 'node:path';
import { updateProjectMeta } from '@pc/db';
import type { ULID } from '@pc/domain';
import {
  AccountRegistry,
  AccountUnavailableError,
  buildAccountEnv,
  defaultAccounts,
  defaultCodexAccounts,
} from '../src/runner/account-env.ts';
import { freshDb, newProject } from './helpers.ts';

const TEST_HOME = resolve('test-fixtures/account-home');
const TEST_CLAUDE_HOME = resolve(TEST_HOME, '.claude-work');

test('buildAccountEnv allowlists OS essentials, then forces only the selected CLAUDE_CONFIG_DIR', () => {
  const base = {
    PATH: '/usr/bin',
    ANTHROPIC_API_KEY: 'sk-should-be-removed',
    ANTHROPIC_AUTH_TOKEN: 'tok-should-be-removed',
    CLAUDE_CONFIG_DIR: '/stale/dir',
    anthropic_api_key: 'lowercase-key',
    Anthropic_Auth_Token: 'mixed-case-token',
    claude_config_dir: '/lowercase/stale-dir',
    GIT_DIR: '/malicious/repository',
    git_work_tree: '/malicious/worktree',
    Git_Common_Dir: '/malicious/common-dir',
    PC_AINATIVE_PM_TOKEN: 'pm-token-should-be-removed',
    OPENAI_API_KEY: 'openai-key-should-be-removed',
    UNRELATED_CANARY: 'ambient-value-should-be-removed',
    NODE_OPTIONS: '--require=/malicious/preload.js',
  };
  const env = buildAccountEnv(TEST_CLAUDE_HOME, base);
  assert.deepEqual(env, {
    PATH: '/usr/bin',
    CLAUDE_CONFIG_DIR: TEST_CLAUDE_HOME,
  });
});

test('registry.buildEnv applies the positive allowlist for a named account', () => {
  const reg = new AccountRegistry(
    [
      { id: 'personal', runtimeId: 'claude-agent-sdk', configDir: '/home/.claude' },
      { id: 'work', runtimeId: 'claude-agent-sdk', configDir: '/home/.claude-work' },
    ],
    'personal',
  );
  const env = reg.buildEnv('claude-agent-sdk', 'work', {
    ANTHROPIC_API_KEY: 'x',
    GIT_DIR: '/wrong/repository',
    PATH: '/safe/bin',
    KEEP: '1',
  });
  assert.deepEqual(env, {
    PATH: '/safe/bin',
    CLAUDE_CONFIG_DIR: '/home/.claude-work',
  });
  assert.throws(() => reg.buildEnv('claude-agent-sdk', 'nope'), /unknown account/);
});

test('defaultAccounts seeds personal + work under the home dir', () => {
  const accts = defaultAccounts(TEST_HOME);
  assert.deepEqual(
    accts.map((a) => a.id),
    ['personal', 'work'],
  );
  assert.ok(accts[0].configDir.endsWith('.claude'));
  assert.ok(accts[1].configDir.endsWith('.claude-work'));
});

test('defaultCodexAccounts seeds one personal account under <home>/.codex', () => {
  const accts = defaultCodexAccounts(TEST_HOME);
  assert.deepEqual(accts.map((a) => ({ id: a.id, runtimeId: a.runtimeId })), [
    { id: 'personal', runtimeId: 'openai-codex' },
  ]);
  assert.ok(accts[0].configDir.endsWith('.codex'));
});

test('Claude and Codex seeds combine into one runtime-scoped registry', () => {
  const reg = new AccountRegistry([
    ...defaultAccounts(TEST_HOME),
    ...defaultCodexAccounts(TEST_HOME),
  ]);
  assert.equal(reg.has('claude-agent-sdk', 'personal'), true);
  assert.equal(reg.has('claude-agent-sdk', 'work'), true);
  assert.equal(reg.has('openai-codex', 'personal'), true);
  assert.equal(reg.get('openai-codex', 'personal')?.configDir.endsWith('.codex'), true);
  // The registry only stores the credential home; buildEnv is Claude-only and
  // refuses to mislabel a Codex account's home as CLAUDE_CONFIG_DIR.
  assert.throws(
    () => reg.buildEnv('openai-codex', 'personal'),
    /buildEnv only builds the Claude Code environment/,
  );
});

test('resolveForProject uses an absent default but rejects an unknown stored account', () => {
  freshDb();
  const reg = new AccountRegistry(
    [
      { id: 'personal', runtimeId: 'claude-agent-sdk', configDir: '/p' },
      { id: 'work', runtimeId: 'claude-agent-sdk', configDir: '/w' },
    ],
    'personal',
  );
  const project = newProject();

  // No stored default → registry default.
  assert.equal(reg.resolveForProject(project.id, 'claude-agent-sdk').id, 'personal');

  // Stored valid override wins.
  updateProjectMeta(project.id, { settings: { defaultAccountId: 'work' } });
  assert.equal(reg.resolveForProject(project.id, 'claude-agent-sdk').id, 'work');

  // Unknown stored account is typed negative evidence, never another login.
  updateProjectMeta(project.id, { settings: { defaultAccountId: 'ghost' as string } });
  assert.throws(
    () => reg.resolveForProject(project.id as ULID, 'claude-agent-sdk'),
    (error: unknown) =>
      error instanceof AccountUnavailableError && error.code === 'account-unavailable',
  );
});

test('account identity is runtime-scoped and scoped duplicates are rejected', () => {
  const reg = new AccountRegistry([
    { id: 'personal', runtimeId: 'claude-agent-sdk', configDir: '/claude' },
    { id: 'personal', runtimeId: 'openai-codex', configDir: '/codex' },
  ]);
  assert.equal(reg.has('claude-agent-sdk', 'personal'), true);
  assert.equal(reg.has('openai-codex', 'personal'), true);
  assert.equal(reg.get('claude-agent-sdk', 'personal')?.configDir, '/claude');
  assert.throws(() => new AccountRegistry([
    { id: 'personal', runtimeId: 'claude-agent-sdk', configDir: '/one' },
    { id: 'personal', runtimeId: 'claude-agent-sdk', configDir: '/two' },
  ]), /duplicate runtime account id/);
});

test('account records are isolated from constructor and read-result mutation', () => {
  const originalHome = resolve(TEST_HOME, 'original-home');
  const source = {
    id: 'personal', runtimeId: 'claude-agent-sdk', configDir: originalHome,
  };
  const reg = new AccountRegistry([source]);
  source.id = 'mutated';
  source.configDir = resolve(TEST_HOME, 'mutated-source');
  const fromGet = reg.get('claude-agent-sdk', 'personal');
  assert.ok(fromGet);
  fromGet.configDir = resolve(TEST_HOME, 'mutated-get');
  const fromList = reg.list()[0]!;
  fromList.configDir = resolve(TEST_HOME, 'mutated-list');

  assert.equal(reg.has('claude-agent-sdk', 'personal'), true);
  assert.equal(
    reg.buildEnv('claude-agent-sdk', 'personal', {}).CLAUDE_CONFIG_DIR,
    originalHome,
  );
});

test('credential homes are unique per runtime after path normalization', () => {
  const sharedHome = resolve(TEST_HOME, 'shared');
  const sharedHomeAlias = `${resolve(TEST_HOME, 'homes')}${sep}..${sep}shared`;
  assert.throws(() => new AccountRegistry([
    { id: 'first', runtimeId: 'claude-agent-sdk', configDir: sharedHomeAlias },
    { id: 'second', runtimeId: 'claude-agent-sdk', configDir: sharedHome },
  ]), /duplicate runtime credential home/);

  const peers = new AccountRegistry([
    { id: 'personal', runtimeId: 'claude-agent-sdk', configDir: sharedHome },
    { id: 'personal', runtimeId: 'openai-codex', configDir: sharedHome },
  ]);
  assert.equal(peers.list().length, 2);
});

test('registry rejects malformed identities and non-absolute credential homes', () => {
  assert.throws(() => new AccountRegistry([{
    id: ' personal ', runtimeId: 'claude-agent-sdk', configDir: TEST_HOME,
  }]), /identity must be canonical/);
  assert.throws(() => new AccountRegistry([{
    id: 'personal', runtimeId: 'claude-agent-sdk\u0000peer', configDir: TEST_HOME,
  }]), /identity must be canonical/);
  for (const id of ['a'.repeat(201), 'account-😀', '\taccount', '\u00a0account']) {
    assert.throws(() => new AccountRegistry([{
      id, runtimeId: 'claude-agent-sdk', configDir: TEST_HOME,
    }]), /identity must be canonical/);
  }
  assert.throws(() => new AccountRegistry([{
    id: 'personal', runtimeId: 'claude-agent-sdk', configDir: 'relative-home',
  }]), /absolute canonical path/);
  assert.throws(() => new AccountRegistry([{
    id: 7, runtimeId: 'claude-agent-sdk', configDir: TEST_HOME,
  } as never]), /identity must be canonical/);
  assert.throws(
    () => new AccountRegistry([{
      id: 'personal', runtimeId: 'claude-agent-sdk', configDir: TEST_HOME,
    }]).buildEnv('openai-codex', 'personal'),
    /unknown account for runtime/,
  );
});
