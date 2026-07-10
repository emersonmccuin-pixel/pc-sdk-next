// Account switcher guards: the subscription-shadowing credentials are ALWAYS
// scrubbed and CLAUDE_CONFIG_DIR is forced (an API key would shadow the Max
// login), and a project's default account resolves from its settings.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { updateProjectMeta } from '@pc/db';
import type { ULID } from '@pc/domain';
import { AccountRegistry, buildAccountEnv, defaultAccounts } from '../src/runner/account-env.ts';
import { freshDb, newProject } from './helpers.ts';

test('buildAccountEnv scrubs ANTHROPIC_* and forces CLAUDE_CONFIG_DIR', () => {
  const base = {
    PATH: '/usr/bin',
    ANTHROPIC_API_KEY: 'sk-should-be-removed',
    ANTHROPIC_AUTH_TOKEN: 'tok-should-be-removed',
    CLAUDE_CONFIG_DIR: '/stale/dir',
  };
  const env = buildAccountEnv('C:/Users/emers/.claude-work', base);
  assert.equal(env.ANTHROPIC_API_KEY, undefined);
  assert.equal(env.ANTHROPIC_AUTH_TOKEN, undefined);
  assert.equal(env.CLAUDE_CONFIG_DIR, 'C:/Users/emers/.claude-work');
  assert.equal(env.PATH, '/usr/bin'); // inherited vars survive
});

test('registry.buildEnv scrubs for a named account', () => {
  const reg = new AccountRegistry(
    [
      { id: 'personal', configDir: '/home/.claude' },
      { id: 'work', configDir: '/home/.claude-work' },
    ],
    'personal',
  );
  const env = reg.buildEnv('work', { ANTHROPIC_API_KEY: 'x', KEEP: '1' });
  assert.equal(env.ANTHROPIC_API_KEY, undefined);
  assert.equal(env.CLAUDE_CONFIG_DIR, '/home/.claude-work');
  assert.equal(env.KEEP, '1');
  assert.throws(() => reg.buildEnv('nope'), /unknown account/);
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

test('resolveForProject: default, override, and junk fallback', () => {
  freshDb();
  const reg = new AccountRegistry(
    [
      { id: 'personal', configDir: '/p' },
      { id: 'work', configDir: '/w' },
    ],
    'personal',
  );
  const project = newProject();

  // No stored default → registry default.
  assert.equal(reg.resolveForProject(project.id).id, 'personal');

  // Stored valid override wins.
  updateProjectMeta(project.id, { settings: { defaultAccountId: 'work' } });
  assert.equal(reg.resolveForProject(project.id).id, 'work');

  // Unknown stored account → falls back to registry default.
  updateProjectMeta(project.id, { settings: { defaultAccountId: 'ghost' as string } });
  assert.equal(reg.resolveForProject(project.id as ULID).id, 'personal');
});
