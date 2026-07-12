// WorktreeProfile validation (docs/worktree-lifecycle.md 'Provisioning and
// readiness'): null/empty normalizes to null (profile-less behavior), garbage
// fails closed, caps enforced.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  createNotRequiredWorktreePhaseReceipt,
  isPositivePreparationReceiptForRun,
  isPositiveWorktreePhaseReceipt,
  isWorktreePhaseReceipt,
  parseWorktreeProfile,
  WORKTREE_PROFILE_MAX_COMMANDS,
  WORKTREE_PROFILE_MAX_COMMAND_CHARS,
} from '../src/worktree.ts';

const parentRunId = '01J00000000000000000000000' as never;

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

test('phase receipt guard accepts exact executed evidence and derives positivity', () => {
  const passed = {
    phase: 'preparation',
    outcome: 'executed',
    ok: true,
    steps: [{
      command: 'pnpm install',
      exitCode: 0,
      durationMs: 12,
      stdoutTail: 'done',
      stderrTail: '',
      timedOut: false,
    }],
    finishedAt: 100,
  };
  assert.equal(isWorktreePhaseReceipt(passed, 'preparation'), true);
  assert.equal(isPositiveWorktreePhaseReceipt(passed, 'preparation'), true);
  assert.equal(isWorktreePhaseReceipt(passed, 'readiness'), false);

  const failed = {
    ...passed,
    ok: false,
    steps: [{ ...passed.steps[0], exitCode: 1 }],
  };
  assert.equal(isWorktreePhaseReceipt(failed), true);
  assert.equal(isPositiveWorktreePhaseReceipt(failed), false);
});

test('phase receipt guard rejects empty, inconsistent, malformed, and non-exact execution evidence', () => {
  const step = {
    command: 'pnpm test', exitCode: 0, durationMs: 1,
    stdoutTail: '', stderrTail: '', timedOut: false,
  };
  const base = {
    phase: 'readiness', outcome: 'executed', ok: true,
    steps: [step], finishedAt: 100,
  };
  for (const receipt of [
    { ...base, steps: [] },
    { ...base, ok: false },
    { ...base, steps: [{ ...step, timedOut: true }] },
    { ...base, steps: [{ ...step, exitCode: 1 }] },
    { ...base, steps: [{ ...step, command: ' pnpm test ' }] },
    { ...base, steps: [{ ...step, durationMs: -1 }] },
    { ...base, finishedAt: Number.NaN },
    { ...base, providerReceipt: 'leak' },
  ]) assert.equal(isWorktreePhaseReceipt(receipt), false, JSON.stringify(receipt));
});

test('not-required creator mints only exact reason-specific positive receipts', () => {
  const empty = createNotRequiredWorktreePhaseReceipt({
    phase: 'readiness', reason: 'no-commands-configured', finishedAt: 200,
  });
  assert.deepEqual(empty, {
    phase: 'readiness', outcome: 'not-required', reason: 'no-commands-configured',
    ok: true, steps: [], finishedAt: 200,
  });
  assert.equal(isPositiveWorktreePhaseReceipt(empty, 'readiness'), true);

  const inherited = createNotRequiredWorktreePhaseReceipt({
    phase: 'preparation',
    reason: 'existing-worktree-preparation',
    inheritedFromRunId: parentRunId,
    finishedAt: 201,
  });
  assert.equal(isPositiveWorktreePhaseReceipt(inherited, 'preparation'), true);
  assert.equal(inherited.inheritedFromRunId, parentRunId);

  for (const receipt of [
    { ...empty, inheritedFromRunId: parentRunId },
    { ...empty, ok: false },
    { ...inherited, phase: 'readiness' },
    { ...inherited, inheritedFromRunId: 'not-a-ulid' },
    { ...inherited, inheritedFromRunId: '01j00000000000000000000000' },
    { ...inherited, steps: [{}] },
    { ...inherited, extra: true },
  ]) assert.equal(isWorktreePhaseReceipt(receipt), false, JSON.stringify(receipt));
  assert.throws(() => createNotRequiredWorktreePhaseReceipt({
    phase: 'preparation', reason: 'no-commands-configured', finishedAt: -1,
  }), /invalid not-required/);
});

test('preparation authority is bound to fresh versus exact continuation parent context', () => {
  const freshNoCommands = createNotRequiredWorktreePhaseReceipt({
    phase: 'preparation', reason: 'no-commands-configured', finishedAt: 300,
  });
  const inherited = createNotRequiredWorktreePhaseReceipt({
    phase: 'preparation', reason: 'existing-worktree-preparation',
    inheritedFromRunId: parentRunId, finishedAt: 301,
  });
  const executed = {
    phase: 'preparation' as const,
    outcome: 'executed' as const,
    ok: true,
    steps: [{
      command: 'pnpm install', exitCode: 0, durationMs: 1,
      stdoutTail: '', stderrTail: '', timedOut: false,
    }] as const,
    finishedAt: 302,
  };

  assert.equal(isPositivePreparationReceiptForRun(freshNoCommands, null), true);
  assert.equal(isPositivePreparationReceiptForRun(executed, null), true);
  assert.equal(isPositivePreparationReceiptForRun(inherited, null), false, 'fresh run cannot borrow preparation');
  assert.equal(isPositivePreparationReceiptForRun(inherited, parentRunId), true);
  assert.equal(isPositivePreparationReceiptForRun(freshNoCommands, parentRunId), false);
  assert.equal(isPositivePreparationReceiptForRun(executed, parentRunId), false);
  assert.equal(isPositivePreparationReceiptForRun(
    inherited,
    '01J11111111111111111111111' as never,
  ), false, 'continuation cannot cite another parent');
});
