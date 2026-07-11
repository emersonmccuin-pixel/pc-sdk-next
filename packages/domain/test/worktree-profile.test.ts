// WorktreeProfile validation (docs/worktree-lifecycle.md 'Provisioning and
// readiness'): null/empty normalizes to null (profile-less behavior), garbage
// fails closed, caps enforced.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  parseWorktreeProfile,
  WORKTREE_PROFILE_MAX_COMMANDS,
  WORKTREE_PROFILE_MAX_COMMAND_CHARS,
} from '../src/worktree.ts';

test('null/undefined/empty profiles normalize to null (exactly today’s behavior)', () => {
  for (const value of [null, undefined, {}, { setupCommands: [], readinessCommands: [], cleanupCommands: [] }]) {
    const parsed = parseWorktreeProfile(value);
    assert.equal(parsed.ok, true);
    if (parsed.ok) assert.equal(parsed.profile, null);
  }
});

test('valid profile normalizes: trims commands + baseBranch, fills missing arrays', () => {
  const parsed = parseWorktreeProfile({
    baseBranch: ' dev ',
    setupCommands: ['  npm ci  '],
    readinessCommands: ['npm test'],
  });
  assert.equal(parsed.ok, true);
  if (!parsed.ok) return;
  assert.deepEqual(parsed.profile, {
    baseBranch: 'dev',
    setupCommands: ['npm ci'],
    readinessCommands: ['npm test'],
    cleanupCommands: [],
  });
});

test('baseBranch alone is a real profile (not normalized away)', () => {
  const parsed = parseWorktreeProfile({ baseBranch: 'release/2026' });
  assert.equal(parsed.ok, true);
  if (parsed.ok) assert.equal(parsed.profile?.baseBranch, 'release/2026');
});

test('rejects non-object, array, and non-array command lists', () => {
  for (const value of ['x', 42, ['npm ci'], { setupCommands: 'npm ci' }]) {
    const parsed = parseWorktreeProfile(value);
    assert.equal(parsed.ok, false, JSON.stringify(value));
  }
});

test('rejects empty/non-string command entries', () => {
  for (const list of [[''], ['   '], [1], [null], ['ok', '']]) {
    const parsed = parseWorktreeProfile({ setupCommands: list });
    assert.equal(parsed.ok, false, JSON.stringify(list));
    if (!parsed.ok) assert.match(parsed.errors.join(' '), /non-empty strings/);
  }
});

test('rejects a command list over the cap and a command over the char cap', () => {
  const tooMany = Array.from({ length: WORKTREE_PROFILE_MAX_COMMANDS + 1 }, (_, i) => `echo ${i}`);
  const over = parseWorktreeProfile({ readinessCommands: tooMany });
  assert.equal(over.ok, false);
  if (!over.ok) assert.match(over.errors.join(' '), /cap/);

  const long = parseWorktreeProfile({ setupCommands: ['x'.repeat(WORKTREE_PROFILE_MAX_COMMAND_CHARS + 1)] });
  assert.equal(long.ok, false);
  if (!long.ok) assert.match(long.errors.join(' '), /chars/);
});

test('rejects an invalid baseBranch shape', () => {
  for (const branch of ['-dev', 'has space', '', 42]) {
    const parsed = parseWorktreeProfile({ baseBranch: branch, setupCommands: ['echo hi'] });
    assert.equal(parsed.ok, false, JSON.stringify(branch));
    if (!parsed.ok) assert.match(parsed.errors.join(' '), /baseBranch/);
  }
});

test('collects errors across fields instead of stopping at the first', () => {
  const parsed = parseWorktreeProfile({ baseBranch: '-x', setupCommands: [''], cleanupCommands: 'rm' });
  assert.equal(parsed.ok, false);
  if (!parsed.ok) assert.ok(parsed.errors.length >= 3, parsed.errors.join('; '));
});
