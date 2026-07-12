// Account switcher guards: the subscription-shadowing credentials are ALWAYS
// scrubbed and CLAUDE_CONFIG_DIR is forced (an API key would shadow the Max
// login), and a project's default account resolves from its settings.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { updateProjectMeta } from '@pc/db';
import type { ULID } from '@pc/domain';
import {
  AccountRegistry,
  AccountUnavailableError,
  buildAccountEnv,
  defaultAccounts,
} from '../src/runner/account-env.ts';
import { freshDb, newProject } from './helpers.ts';

test('buildAccountEnv scrubs credentials and ambient Git selectors, then forces CLAUDE_CONFIG_DIR', () => {
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
  };
  const env = buildAccountEnv('C:/Users/emers/.claude-work', base);
  assert.equal(env.ANTHROPIC_API_KEY, undefined);
  assert.equal(env.ANTHROPIC_AUTH_TOKEN, undefined);
  assert.equal(env.CLAUDE_CONFIG_DIR, 'C:/Users/emers/.claude-work');
  assert.equal(Object.keys(env).some((key) => key.toUpperCase() === 'ANTHROPIC_API_KEY'), false);
  assert.equal(Object.keys(env).some((key) => key.toUpperCase() === 'ANTHROPIC_AUTH_TOKEN'), false);
  assert.equal(Object.keys(env).filter((key) => key.toUpperCase() === 'CLAUDE_CONFIG_DIR').length, 1);
  assert.equal(Object.keys(env).some((key) => key.toUpperCase() === 'GIT_DIR'), false);
  assert.equal(Object.keys(env).some((key) => key.toUpperCase() === 'GIT_WORK_TREE'), false);
  assert.equal(Object.keys(env).some((key) => key.toUpperCase() === 'GIT_COMMON_DIR'), false);
  assert.equal(env.PATH, '/usr/bin'); // inherited vars survive
});

test('registry.buildEnv scrubs for a named account', () => {
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
    KEEP: '1',
  });
  assert.equal(env.ANTHROPIC_API_KEY, undefined);
  assert.equal(env.CLAUDE_CONFIG_DIR, '/home/.claude-work');
  assert.equal(env.GIT_DIR, undefined);
  assert.equal(env.KEEP, '1');
  assert.throws(() => reg.buildEnv('claude-agent-sdk', 'nope'), /unknown account/);
});

test('defaultAccounts seeds personal + work under the home dir', () => {
  const accts = defaultAccounts('C:/Users/emers');
  assert.deepEqual(
    accts.map((a) => a.id),
    ['personal', 'work'],
  );
  assert.ok(accts[0].configDir.endsWith('.claude'));
  assert.ok(accts[1].configDir.endsWith('.claude-work'));
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
  const source = {
    id: 'personal', runtimeId: 'claude-agent-sdk', configDir: 'C:/original-home',
  };
  const reg = new AccountRegistry([source]);
  source.id = 'mutated';
  source.configDir = 'C:/mutated-source';
  const fromGet = reg.get('claude-agent-sdk', 'personal');
  assert.ok(fromGet);
  fromGet.configDir = 'C:/mutated-get';
  const fromList = reg.list()[0]!;
  fromList.configDir = 'C:/mutated-list';

  assert.equal(reg.has('claude-agent-sdk', 'personal'), true);
  assert.equal(
    reg.buildEnv('claude-agent-sdk', 'personal', {}).CLAUDE_CONFIG_DIR,
    'C:/original-home',
  );
});

test('credential homes are unique per runtime after path normalization', () => {
  assert.throws(() => new AccountRegistry([
    { id: 'first', runtimeId: 'claude-agent-sdk', configDir: 'C:/homes/../shared' },
    { id: 'second', runtimeId: 'claude-agent-sdk', configDir: 'C:/shared' },
  ]), /duplicate runtime credential home/);

  const peers = new AccountRegistry([
    { id: 'personal', runtimeId: 'claude-agent-sdk', configDir: 'C:/shared' },
    { id: 'personal', runtimeId: 'openai-codex', configDir: 'C:/shared' },
  ]);
  assert.equal(peers.list().length, 2);
});

test('registry rejects malformed identities and non-absolute credential homes', () => {
  assert.throws(() => new AccountRegistry([{
    id: ' personal ', runtimeId: 'claude-agent-sdk', configDir: 'C:/home',
  }]), /identity must be canonical/);
  assert.throws(() => new AccountRegistry([{
    id: 'personal', runtimeId: 'claude-agent-sdk\u0000peer', configDir: 'C:/home',
  }]), /identity must be canonical/);
  for (const id of ['a'.repeat(201), 'account-😀', '\taccount', '\u00a0account']) {
    assert.throws(() => new AccountRegistry([{
      id, runtimeId: 'claude-agent-sdk', configDir: 'C:/home',
    }]), /identity must be canonical/);
  }
  assert.throws(() => new AccountRegistry([{
    id: 'personal', runtimeId: 'claude-agent-sdk', configDir: 'relative-home',
  }]), /absolute canonical path/);
  assert.throws(() => new AccountRegistry([{
    id: 7, runtimeId: 'claude-agent-sdk', configDir: 'C:/home',
  } as never]), /identity must be canonical/);
  assert.throws(
    () => new AccountRegistry([{
      id: 'personal', runtimeId: 'claude-agent-sdk', configDir: 'C:/home',
    }]).buildEnv('openai-codex', 'personal'),
    /unknown account for runtime/,
  );
});
