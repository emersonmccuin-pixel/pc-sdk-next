// Guard 3 against a real temp git repo: the changed-paths executor derives the
// actual diff (never builder prose), verifyContract enforces declared scope,
// unreadable git state parks inconclusive, and deriveDiffStat computes the
// numbers the submit door stamps over builder input.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createExecutors, verifyContract } from '../src/dispatch/verification.ts';
import { deriveDiffStat, git } from '../src/dispatch/worktrees.ts';
import { commitFile, freshDb, newGitProject, type GitProject } from './helpers.ts';

/** Seed repo + one in-scope commit under src/. Returns base + deliverable SHAs. */
async function seedScopedCommit(gp: GitProject): Promise<{ baseSha: string; commitSha: string }> {
  const baseSha = (await git(['rev-parse', 'HEAD'], gp.dir)).stdout;
  mkdirSync(join(gp.dir, 'src'), { recursive: true });
  const commitSha = await commitFile(gp.dir, 'src/feature.ts', 'export const x = 1;\n');
  return { baseSha, commitSha };
}

test('changedPaths executor derives the real diff between base and deliverable', async () => {
  freshDb();
  const gp = await newGitProject();
  try {
    const { baseSha, commitSha } = await seedScopedCommit(gp);
    const ex = createExecutors({
      worktreeDir: gp.dir,
      projectDir: gp.dir,
      baseSha,
      deliverableCommit: commitSha,
    });
    assert.deepEqual(await ex.changedPaths!(), ['src/feature.ts']);
  } finally {
    gp.cleanup();
  }
});

test('in-scope change passes; out-of-scope declared scope fails with the path in notes', async () => {
  freshDb();
  const gp = await newGitProject();
  try {
    const { baseSha, commitSha } = await seedScopedCommit(gp);
    const base = {
      expectedOutput: { kind: 'repo' as const, require_diff: false },
      verificationTier: 'auto' as const,
      deliverable: { kind: 'repo' as const, commit: commitSha, baseCommit: baseSha },
      report: null,
      toolCalls: [],
      pendingAskCreated: false,
      scope: { worktreeDir: gp.dir, projectDir: gp.dir, baseSha, deliverableCommit: commitSha },
    };
    const pass = await verifyContract({
      ...base,
      acceptanceCriteria: [{ kind: 'changed_paths_within', allowed: ['src/**'] }],
    });
    assert.equal(pass.verificationStatus, 'passed');

    const fail = await verifyContract({
      ...base,
      acceptanceCriteria: [{ kind: 'changed_paths_within', allowed: ['docs/**'] }],
    });
    assert.equal(fail.verificationStatus, 'failed');
    assert.match(fail.notes ?? '', /src\/feature\.ts/);
  } finally {
    gp.cleanup();
  }
});

// Default rename detection reports only the DESTINATION of a `git mv` — the
// source deletion would be invisible to scope checks. --no-renames surfaces
// both paths, so moving a file out of a forbidden/undeclared zone fails.
test('a rename surfaces BOTH paths — the source cannot hide from scope checks', async () => {
  freshDb();
  const gp = await newGitProject();
  try {
    mkdirSync(join(gp.dir, 'secret'), { recursive: true });
    await commitFile(gp.dir, 'secret/creds.txt', 'shh\n');
    const baseSha = (await git(['rev-parse', 'HEAD'], gp.dir)).stdout;
    mkdirSync(join(gp.dir, 'src'), { recursive: true });
    await gitOkLocal(['mv', 'secret/creds.txt', 'src/moved.txt'], gp.dir);
    await gitOkLocal(['commit', '-m', 'mv'], gp.dir);
    const commitSha = (await git(['rev-parse', 'HEAD'], gp.dir)).stdout;

    const ex = createExecutors({ worktreeDir: gp.dir, projectDir: gp.dir, baseSha, deliverableCommit: commitSha });
    const paths = await ex.changedPaths!();
    assert.deepEqual([...(paths ?? [])].sort(), ['secret/creds.txt', 'src/moved.txt']);

    const outcome = await verifyContract({
      expectedOutput: { kind: 'repo', require_diff: false },
      acceptanceCriteria: [{ kind: 'changed_paths_within', allowed: ['src/**'] }],
      verificationTier: 'auto',
      deliverable: { kind: 'repo', commit: commitSha, baseCommit: baseSha },
      report: null,
      toolCalls: [],
      pendingAskCreated: false,
      scope: { worktreeDir: gp.dir, projectDir: gp.dir, baseSha, deliverableCommit: commitSha },
    });
    assert.equal(outcome.verificationStatus, 'failed', 'the rename SOURCE is out of scope');
    assert.match(outcome.notes ?? '', /secret\/creds\.txt/);
  } finally {
    gp.cleanup();
  }
});

// Default core.quotepath octal-escapes non-ASCII names ("h\303\251llo.ts" in
// literal quotes) — no glob could ever match that, so a legitimately in-scope
// unicode file failed with a false out-of-scope verdict.
test('non-ASCII paths come back verbatim and match their scope globs', async () => {
  freshDb();
  const gp = await newGitProject();
  try {
    const baseSha = (await git(['rev-parse', 'HEAD'], gp.dir)).stdout;
    mkdirSync(join(gp.dir, 'src'), { recursive: true });
    const commitSha = await commitFile(gp.dir, 'src/héllo.ts', 'export const x = 1;\n');

    const ex = createExecutors({ worktreeDir: gp.dir, projectDir: gp.dir, baseSha, deliverableCommit: commitSha });
    assert.deepEqual(await ex.changedPaths!(), ['src/héllo.ts']);

    const outcome = await verifyContract({
      expectedOutput: { kind: 'repo', require_diff: false },
      acceptanceCriteria: [{ kind: 'changed_paths_within', allowed: ['src/**'] }],
      verificationTier: 'auto',
      deliverable: { kind: 'repo', commit: commitSha, baseCommit: baseSha },
      report: null,
      toolCalls: [],
      pendingAskCreated: false,
      scope: { worktreeDir: gp.dir, projectDir: gp.dir, baseSha, deliverableCommit: commitSha },
    });
    assert.equal(outcome.verificationStatus, 'passed', 'in-scope unicode name is not a false scope violation');
  } finally {
    gp.cleanup();
  }
});

async function gitOkLocal(args: string[], cwd: string): Promise<void> {
  const r = await git(args, cwd);
  assert.ok(r.ok, `git ${args.join(' ')} failed: ${r.stderr || r.stdout}`);
}

test('unreadable git state parks pending (inconclusive), never failed', async () => {
  freshDb();
  const outcome = await verifyContract({
    expectedOutput: { kind: 'repo', require_diff: false },
    acceptanceCriteria: [{ kind: 'changed_paths_within', allowed: ['src/**'] }],
    verificationTier: 'auto',
    deliverable: { kind: 'repo', commit: 'deadbeef' },
    report: null,
    toolCalls: [],
    pendingAskCreated: false,
    // No baseSha and no worktree — changed-path evidence is underivable.
    scope: { worktreeDir: null, projectDir: '' },
  });
  assert.equal(outcome.verificationStatus, 'pending');
  assert.equal(outcome.escalatedToReview, false);
  assert.match(outcome.notes ?? '', /inconclusive/);
});

test('deriveDiffStat computes files/insertions/deletions from git, and null on garbage', async () => {
  freshDb();
  const gp = await newGitProject();
  try {
    const baseSha = (await git(['rev-parse', 'HEAD'], gp.dir)).stdout;
    // README.md was 'seed\n' — replace it (1 in, 1 del) and add a 3-line file.
    writeFileSync(join(gp.dir, 'README.md'), 'replaced\n');
    await git(['add', 'README.md'], gp.dir);
    const commitSha = await commitFile(gp.dir, 'notes.txt', 'a\nb\nc\n');
    const stat = await deriveDiffStat(gp.dir, baseSha, commitSha);
    assert.deepEqual(stat, { files: 2, insertions: 4, deletions: 1 });

    const bad = await deriveDiffStat(gp.dir, 'not-a-sha', commitSha);
    assert.equal(bad, null);
  } finally {
    gp.cleanup();
  }
});
