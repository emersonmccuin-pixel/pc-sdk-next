import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  buildChildEnvironment,
  POSIX_CHILD_ENVIRONMENT_ALLOWLIST,
  WINDOWS_CHILD_ENVIRONMENT_ALLOWLIST,
} from '../src/operations/child-environment.ts';

test('POSIX child environments retain only exact allowlisted OS essentials', () => {
  const base: NodeJS.ProcessEnv = {
    PATH: '/usr/local/bin:/usr/bin',
    HOME: '/home/operator',
    TMPDIR: '/tmp/pc-sdk',
    LANG: 'en_US.UTF-8',
    LC_CTYPE: 'en_US.UTF-8',
    TERM: 'xterm-256color',
    XDG_CONFIG_HOME: '/home/operator/.config',
    path: '/attacker/bin',
    home: '/attacker/home',
    LC_PLUGIN_PATH: '/attacker/locale-plugin',
    OPENAI_API_KEY: 'raw-provider-key',
    PC_AINATIVE_PM_TOKEN: 'pm-token',
    PC_DATA_DIR: '/private/app-data',
    GIT_DIR: '/attacker/repository',
    NODE_OPTIONS: '--require=/attacker/preload.js',
    BASH_ENV: '/attacker/bashrc',
    LD_PRELOAD: '/attacker/library.so',
    HTTPS_PROXY: 'http://attacker.invalid',
  };
  const before = { ...base };

  assert.deepEqual(buildChildEnvironment(base, 'linux'), {
    PATH: '/usr/local/bin:/usr/bin',
    HOME: '/home/operator',
    TMPDIR: '/tmp/pc-sdk',
    LANG: 'en_US.UTF-8',
    LC_CTYPE: 'en_US.UTF-8',
    TERM: 'xterm-256color',
    XDG_CONFIG_HOME: '/home/operator/.config',
  });
  assert.deepEqual(base, before, 'the caller-owned input must remain unchanged');
});

test('every documented POSIX allowlist name survives with an ordinary value', () => {
  const base = Object.fromEntries(
    POSIX_CHILD_ENVIRONMENT_ALLOWLIST.map((name) => [name, `value-for-${name}`]),
  );

  assert.deepEqual(buildChildEnvironment(base, 'darwin'), base);
});

test('Windows child environments match case-insensitively and emit canonical names', () => {
  const base: NodeJS.ProcessEnv = {
    Path: 'C:\\Windows\\System32',
    systemRoot: 'C:\\Windows',
    USERprofile: 'C:\\Users\\operator',
    temp: 'C:\\Temp',
    xdg_config_home: 'C:\\Users\\operator\\.config',
    '\u017FystemRoot': 'C:\\Unicode-case-fold-bypass',
    OPENAI_API_KEY: 'raw-provider-key',
    pc_ainative_pm_token: 'pm-token',
    Git_Work_Tree: 'C:\\attacker\\worktree',
    node_options: '--require=C:\\attacker\\preload.js',
  };
  const before = { ...base };

  assert.deepEqual(buildChildEnvironment(base, 'win32'), {
    PATH: 'C:\\Windows\\System32',
    SYSTEMROOT: 'C:\\Windows',
    USERPROFILE: 'C:\\Users\\operator',
    TEMP: 'C:\\Temp',
    XDG_CONFIG_HOME: 'C:\\Users\\operator\\.config',
  });
  assert.deepEqual(base, before, 'the caller-owned input must remain unchanged');
});

test('Windows drops every spelling of an allowed name when spellings collide', () => {
  const base: NodeJS.ProcessEnv = {
    PATH: 'C:\\trusted',
    Path: 'C:\\selected-by-property-order',
    HOME: 'C:\\Users\\operator',
    home: 'C:\\Users\\attacker',
    TEMP: 'C:\\Temp',
  };

  assert.deepEqual(buildChildEnvironment(base, 'win32'), { TEMP: 'C:\\Temp' });
});

test('every documented Windows allowlist name survives with an ordinary value', () => {
  const base = Object.fromEntries(
    WINDOWS_CHILD_ENVIRONMENT_ALLOWLIST.map((name) => [name, `value-for-${name}`]),
  );

  assert.deepEqual(buildChildEnvironment(base, 'win32'), base);
});

test('undefined, non-string, NUL-bearing, and exported-function values fail closed', () => {
  const base = {
    PATH: undefined,
    HOME: 7,
    TMPDIR: '/tmp\u0000attacker',
    LANG: '() { /attacker/payload; }',
    LC_ALL: '  () exported-function-marker',
    TERM: 'xterm-256color',
  } as unknown as NodeJS.ProcessEnv;

  assert.deepEqual(buildChildEnvironment(base, 'linux'), { TERM: 'xterm-256color' });
});
