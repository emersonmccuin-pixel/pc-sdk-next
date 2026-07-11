// Worktree mechanics (docs/worktree-lifecycle.md) against real temp git repos:
//  - provisionWorktree refuses missing dir / non-repo / detached HEAD /
//    no main-or-master / main copy off the base branch, and branches from
//    the BASE BRANCH TIP on success (never a feature-branch HEAD)
//  - landBranch: clean-tree guard, wrong-branch guard, expected-HEAD guard
//    (guard 7 — a moved target refuses, never merges), conflict aborts back
//    to a clean tree, success carries the positive ancestry receipt (guard 8)
//  - teardown reclaims the DIRECTORY only — the branch is always preserved;
//    removal failure defers to boot recovery (row stays active)

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { getActiveWorktreeByName, newId } from '@pc/db';
import {
  git,
  landBranch,
  provisionWorktree,
  teardownWorktree,
  worktreesRoot,
} from '../src/dispatch/worktrees.ts';
import { commitFile, freshDb, newGitProject } from './helpers.ts';

async function provisionOk(projectDir: string) {
  const out = await provisionWorktree(projectDir, newId());
  if (!out.ok) throw new Error(`provision failed: ${out.error}`);
  return out;
}

test('provision refuses a missing project folder', async () => {
  freshDb();
  const unset = await provisionWorktree('', 'RUN0001');
  assert.equal(unset.ok, false);
  if (!unset.ok) assert.match(unset.error, /project folder missing/);
  const gone = await provisionWorktree(join(tmpdir(), `pc-sdk-nope-${newId()}`), 'RUN0002');
  assert.equal(gone.ok, false);
  if (!gone.ok) assert.match(gone.error, /project folder missing/);
});

test('provision refuses a folder that is not a git repository', async () => {
  freshDb();
  const dir = mkdtempSync(join(tmpdir(), 'pc-sdk-norepo-'));
  try {
    const out = await provisionWorktree(dir, 'RUN0003');
    assert.equal(out.ok, false);
    if (!out.ok) assert.match(out.error, /not a git repository/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('provision refuses a detached HEAD', async () => {
  freshDb();
  const gp = await newGitProject();
  try {
    const detach = await git(['checkout', '--detach'], gp.dir);
    assert.equal(detach.ok, true);
    const out = await provisionWorktree(gp.dir, newId());
    assert.equal(out.ok, false);
    if (!out.ok) assert.match(out.error, /detached HEAD/);
  } finally {
    gp.cleanup();
  }
});

test('provision refuses when the main copy is checked out on a feature branch', async () => {
  freshDb();
  const gp = await newGitProject();
  try {
    assert.equal((await git(['checkout', '-b', 'feature-x'], gp.dir)).ok, true);
    const out = await provisionWorktree(gp.dir, newId());
    assert.equal(out.ok, false);
    if (!out.ok) assert.match(out.error, /checked out on 'feature-x', not the base branch 'main'/);
  } finally {
    gp.cleanup();
  }
});

test('provision refuses when neither main nor master exists', async () => {
  freshDb();
  const dir = mkdtempSync(join(tmpdir(), 'pc-sdk-trunk-'));
  try {
    for (const args of [
      ['init', '-b', 'trunk'],
      ['config', 'user.name', 'PC-SDK Test'],
      ['config', 'user.email', 'test@pc-sdk.invalid'],
    ]) assert.equal((await git(args, dir)).ok, true);
    writeFileSync(join(dir, 'README.md'), 'seed\n');
    assert.equal((await git(['add', '.'], dir)).ok, true);
    assert.equal((await git(['commit', '-m', 'initial'], dir)).ok, true);
    const out = await provisionWorktree(dir, newId());
    assert.equal(out.ok, false);
    if (!out.ok) assert.match(out.error, /no base branch/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('provision falls back to master when main does not exist', async () => {
  freshDb();
  const gp = await newGitProject();
  try {
    assert.equal((await git(['branch', '-m', 'main', 'master'], gp.dir)).ok, true);
    const wt = await provisionOk(gp.dir);
    assert.equal(wt.baseBranch, 'master');
  } finally {
    gp.cleanup();
  }
});

test('provision branches from the base branch TIP and registers the row', async () => {
  freshDb();
  const gp = await newGitProject();
  try {
    // Advance main first — the base must be the CURRENT tip, not the seed.
    const advanced = await commitFile(gp.dir, 'later.txt', 'later\n');
    const wt = await provisionOk(gp.dir);
    assert.equal(wt.baseBranch, 'main');
    assert.equal(wt.baseSha, advanced);
    assert.equal(wt.baseSha, (await git(['rev-parse', 'refs/heads/main'], gp.dir)).stdout, 'base SHA is the branch tip');
    assert.match(wt.branch, /^agent-[0-9a-z]{8}$/);
    assert.equal(wt.dir, join(worktreesRoot(gp.dir), wt.branch));
    assert.ok(existsSync(wt.dir), 'worktree directory exists');
    assert.equal((await git(['rev-parse', 'HEAD'], wt.dir)).stdout, wt.baseSha, 'worktree starts at base SHA');
    assert.equal(getActiveWorktreeByName(wt.branch)?.path, wt.dir, 'durable row registered');
  } finally {
    gp.cleanup();
  }
});

test('landBranch refuses a dirty project tree', async () => {
  freshDb();
  const gp = await newGitProject();
  try {
    const wt = await provisionOk(gp.dir);
    await commitFile(wt.dir, 'feature.txt', 'work\n');
    writeFileSync(join(gp.dir, 'dirty.txt'), 'uncommitted\n');
    const out = await landBranch({ projectDir: gp.dir, branch: wt.branch, baseBranch: 'main', podName: 'tester', expectedHeadSha: wt.baseSha });
    assert.equal(out.outcome, 'conflict');
    if (out.outcome === 'conflict') assert.match(out.error, /uncommitted changes/);
  } finally {
    gp.cleanup();
  }
});

test('landBranch refuses when HEAD left the base branch', async () => {
  freshDb();
  const gp = await newGitProject();
  try {
    const wt = await provisionOk(gp.dir);
    await commitFile(wt.dir, 'feature.txt', 'work\n');
    assert.equal((await git(['checkout', '-b', 'sidetrack'], gp.dir)).ok, true);
    const out = await landBranch({ projectDir: gp.dir, branch: wt.branch, baseBranch: 'main', podName: 'tester', expectedHeadSha: wt.baseSha });
    assert.equal(out.outcome, 'conflict');
    if (out.outcome === 'conflict') assert.match(out.error, /not the dispatch base/);
  } finally {
    gp.cleanup();
  }
});

test('landBranch fails typed when the agent branch is missing', async () => {
  freshDb();
  const gp = await newGitProject();
  try {
    const out = await landBranch({
      projectDir: gp.dir,
      branch: 'agent-missing1',
      baseBranch: 'main',
      podName: 'tester',
      expectedHeadSha: (await git(['rev-parse', 'main'], gp.dir)).stdout,
    });
    assert.equal(out.outcome, 'failed');
    if (out.outcome === 'failed') assert.match(out.error, /agent branch missing/);
  } finally {
    gp.cleanup();
  }
});

test('merge conflict aborts and leaves the project tree clean', async () => {
  freshDb();
  const gp = await newGitProject();
  try {
    const wt = await provisionOk(gp.dir);
    // Same line of the same file diverges on both sides — guaranteed conflict.
    await commitFile(wt.dir, 'README.md', 'agent version\n', 'agent edit');
    const mainTip = await commitFile(gp.dir, 'README.md', 'main version\n', 'main edit');
    const out = await landBranch({ projectDir: gp.dir, branch: wt.branch, baseBranch: 'main', podName: 'tester', expectedHeadSha: mainTip });
    assert.equal(out.outcome, 'conflict');
    if (out.outcome === 'conflict') assert.match(out.error, /merge conflict/);
    // Abort receipt: clean tree, no merge in progress, HEAD unmoved.
    assert.equal((await git(['status', '--porcelain'], gp.dir)).stdout, '');
    assert.equal((await git(['rev-parse', '-q', '--verify', 'MERGE_HEAD'], gp.dir)).ok, false, 'no merge in progress');
    assert.equal((await git(['rev-parse', 'HEAD'], gp.dir)).stdout, mainTip);
  } finally {
    gp.cleanup();
  }
});

test('successful land returns the positive ancestry receipt (guard 8)', async () => {
  freshDb();
  const gp = await newGitProject();
  try {
    const wt = await provisionOk(gp.dir);
    const tip = await commitFile(wt.dir, 'feature.txt', 'work\n');
    const out = await landBranch({ projectDir: gp.dir, branch: wt.branch, baseBranch: 'main', podName: 'tester', expectedHeadSha: wt.baseSha });
    assert.equal(out.outcome, 'landed');
    if (out.outcome === 'landed') {
      assert.equal(out.branchSha, tip, 'branchSha is the branch tip');
      assert.equal(out.mergeSha, (await git(['rev-parse', 'HEAD'], gp.dir)).stdout);
      assert.notEqual(out.mergeSha, tip, '--no-ff merge commit, not a fast-forward');
    }
    // Positive receipt independently re-checked: branch tip is an ancestor of HEAD.
    assert.equal((await git(['merge-base', '--is-ancestor', tip, 'HEAD'], gp.dir)).ok, true);
    assert.ok(existsSync(join(gp.dir, 'feature.txt')), 'merged content present in the project');
  } finally {
    gp.cleanup();
  }
});

test('teardown reclaims the directory but ALWAYS preserves the branch', async () => {
  freshDb();
  const gp = await newGitProject();
  try {
    // Landed worktree.
    const landedWt = await provisionOk(gp.dir);
    await commitFile(landedWt.dir, 'a.txt', 'a\n');
    const landed = await landBranch({ projectDir: gp.dir, branch: landedWt.branch, baseBranch: 'main', podName: 'tester', expectedHeadSha: landedWt.baseSha });
    assert.equal(landed.outcome, 'landed');
    await teardownWorktree(gp.dir, landedWt.dir);
    assert.equal(existsSync(landedWt.dir), false, 'directory reclaimed');
    assert.equal((await git(['rev-parse', landedWt.branch], gp.dir)).ok, true, 'landed branch preserved');
    assert.equal(getActiveWorktreeByName(landedWt.branch), null, 'row marked destroyed');

    // UNlanded worktree — the branch must survive teardown too (recoverable work).
    const unlandedWt = await provisionOk(gp.dir);
    const unlandedTip = await commitFile(unlandedWt.dir, 'b.txt', 'b\n');
    await teardownWorktree(gp.dir, unlandedWt.dir);
    assert.equal(existsSync(unlandedWt.dir), false);
    assert.equal((await git(['rev-parse', unlandedWt.branch], gp.dir)).stdout, unlandedTip, 'unlanded branch preserved');
  } finally {
    gp.cleanup();
  }
});

test('teardown removal failure never throws — row stays active for boot recovery', async () => {
  freshDb();
  const gp = await newGitProject();
  try {
    const wt = await provisionOk(gp.dir);
    // A locked worktree survives a single --force: deterministic removal failure.
    assert.equal((await git(['worktree', 'lock', wt.dir], gp.dir)).ok, true);
    await teardownWorktree(gp.dir, wt.dir); // must not throw
    assert.equal(existsSync(wt.dir), true, 'directory still present');
    assert.notEqual(getActiveWorktreeByName(wt.branch), null, 'row stays active — stranded scan will surface it');
    await git(['worktree', 'unlock', wt.dir], gp.dir);
  } finally {
    gp.cleanup();
  }
});
