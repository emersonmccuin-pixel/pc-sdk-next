// DL-002 worktree mechanics against real Git repositories. These tests stay
// below DispatchService: exact preview evidence, integration refusal, and the
// receipt-backed branch-preserving teardown are independently guardable.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { getActiveWorktreeByName, getWorktreeById, newId, setWorktreeContractId } from '@pc/db';
import type {
  ULID,
  Worktree,
  WorktreeAbandonmentPresentState,
  WorktreeAbandonmentReceipt,
  WorktreeAbandonmentPreview,
} from '@pc/domain';
import { isWorktreeAbandonmentTeardownReceipt } from '@pc/domain';
import {
  git,
  inspectWorktreeAbandonment,
  provisionWorktree,
  settleAbandonedWorktree,
} from '../src/dispatch/worktrees.ts';
import { commitFile, freshDb, newGitProject, type GitProject } from './helpers.ts';

async function provisionBound(gp: GitProject) {
  const runId = newId() as ULID;
  const contractId = newId() as ULID;
  const provisioned = await provisionWorktree(gp.dir, runId, { projectId: gp.project.id });
  if (!provisioned.ok) throw new Error(provisioned.error);
  setWorktreeContractId(provisioned.branch, contractId);
  const persisted = getActiveWorktreeByName(provisioned.branch);
  assert.ok(persisted);
  const worktree: Worktree = persisted;
  return { ...provisioned, runId, contractId, worktree };
}

async function inspect(
  gp: GitProject,
  bound: Awaited<ReturnType<typeof provisionBound>>,
  version = 7,
  validatedBaseSha = bound.baseSha,
) {
  return inspectWorktreeAbandonment({
    projectDir: gp.dir,
    projectId: gp.project.id,
    contractId: bound.contractId,
    contractVersion: version,
    producerRunId: bound.runId,
    worktree: bound.worktree,
    expectedBaseBranch: bound.baseBranch,
    provisionedBaseSha: bound.baseSha,
    validatedBaseSha,
    repositoryIdentity: bound.repositoryIdentity,
  });
}

function authority(preview: WorktreeAbandonmentPreview): WorktreeAbandonmentReceipt {
  assert.equal(preview.worktreeState.directory, 'present');
  return {
    protocol: 'worktree-abandonment-v1',
    requestId: '5b198c5e-2d18-4ee1-988f-8653f0df3c23',
    approvedBy: 'user',
    approvalSurface: 'browser',
    approvalReason: 'explicit-browser-confirmation',
    approvedAt: Date.now(),
    reason: null,
    approvedContractVersion: preview.contractVersion,
    projectId: preview.projectId,
    contractId: preview.contractId,
    producerRunId: preview.producerRunId,
    worktreeId: preview.worktreeId,
    worktreeStatus: preview.worktreeStatus,
    repositoryIdentity: preview.repositoryIdentity,
    worktreePath: preview.worktreePath,
    branch: preview.branch,
    branchTip: preview.branchTip,
    baseBranch: preview.baseBranch,
    validatedBaseSha: preview.validatedBaseSha,
    targetTip: preview.targetTip,
    integrationState: preview.integrationState,
    worktreeState: preview.worktreeState as WorktreeAbandonmentPresentState,
    previewDigest: preview.previewDigest,
  };
}

test('preview binds clean no-exclusive-commit work to exact row/repository evidence', async () => {
  freshDb();
  const gp = await newGitProject('abandon-preview-clean');
  try {
    const bound = await provisionBound(gp);
    const first = await inspect(gp, bound);
    const second = await inspect(gp, bound);
    assert.equal(first.ok, true, first.ok ? '' : first.error);
    assert.equal(second.ok, true, second.ok ? '' : second.error);
    if (!first.ok || !second.ok) return;
    assert.equal(first.preview.integrationState, 'no-exclusive-commits');
    assert.equal(first.preview.branchTip, bound.baseSha);
    assert.equal(first.preview.targetTip, bound.baseSha);
    assert.equal(first.preview.worktreeId, bound.worktree.id);
    assert.equal(first.preview.worktreeStatus, 'active');
    assert.deepEqual(first.preview.worktreeState, {
      directory: 'present',
      registration: 'registered',
      status: 'clean',
      staged: 0,
      unstaged: 0,
      untracked: 0,
      worktreeStateDigest: first.preview.worktreeState.worktreeStateDigest,
      changedPaths: [],
      ignoredContents: 'uninspected',
    });
    assert.equal(first.preview.previewDigest, second.preview.previewDigest, 'unchanged evidence is deterministic');
  } finally {
    await gp.cleanup();
  }
});

test('integration counts from the validated base after an eligible branch rebase', async () => {
  freshDb();
  const gp = await newGitProject('abandon-preview-validated-base');
  try {
    const bound = await provisionBound(gp);
    const validatedBase = await commitFile(gp.dir, 'advanced.txt', 'base advanced\n', 'advance validated base');
    assert.notEqual(validatedBase, bound.baseSha);
    assert.equal((await git(['reset', '--hard', validatedBase], bound.dir)).ok, true);

    const result = await inspect(gp, bound, 7, validatedBase);
    assert.equal(result.ok, true, result.ok ? '' : result.error);
    if (!result.ok) return;
    assert.equal(result.preview.validatedBaseSha, validatedBase);
    assert.equal(result.preview.branchTip, validatedBase);
    assert.equal(result.preview.targetTip, validatedBase);
    assert.equal(result.preview.integrationState, 'no-exclusive-commits');
  } finally {
    await gp.cleanup();
  }
});

test('preview digest binds staged/unstaged binary diff bytes and deterministic untracked contents', async () => {
  freshDb();
  const gp = await newGitProject('abandon-preview-dirty');
  try {
    const bound = await provisionBound(gp);
    writeFileSync(join(bound.dir, '.gitignore'), 'ignored-*/\n');
    writeFileSync(join(bound.dir, 'tracked.bin'), Buffer.from([0, 1, 2, 3, 255]));
    assert.equal((await git(['add', '.gitignore', 'tracked.bin'], bound.dir)).ok, true);
    assert.equal((await git(['commit', '-m', 'feature baseline'], bound.dir)).ok, true);

    writeFileSync(join(bound.dir, 'tracked.bin'), Buffer.from([0, 1, 9, 3, 255]));
    writeFileSync(join(bound.dir, 'staged.bin'), Buffer.from([255, 0, 254, 1]));
    assert.equal((await git(['add', 'staged.bin'], bound.dir)).ok, true);
    const odd = 'leading - and renamed unicode ü.txt';
    writeFileSync(join(bound.dir, odd), 'first untracked value\n');
    mkdirSync(join(bound.dir, 'ignored-cache'));
    writeFileSync(join(bound.dir, 'ignored-cache', 'ignored.txt'), 'not individually inspected');

    const first = await inspect(gp, bound);
    assert.equal(first.ok, true, first.ok ? '' : first.error);
    if (!first.ok) return;
    assert.equal(first.preview.integrationState, 'unmerged');
    assert.equal(first.preview.worktreeState.directory, 'present');
    if (first.preview.worktreeState.directory !== 'present') return;
    assert.equal(first.preview.worktreeState.status, 'dirty');
    assert.equal(first.preview.worktreeState.staged, 1);
    assert.equal(first.preview.worktreeState.unstaged, 1);
    assert.equal(first.preview.worktreeState.untracked, 1);
    assert.ok(first.preview.worktreeState.changedPaths.includes(odd));
    assert.equal(first.preview.worktreeState.changedPaths.some((p) => p.includes('ignored-cache')), false);
    assert.equal(first.preview.worktreeState.ignoredContents, 'uninspected');

    writeFileSync(join(bound.dir, odd), 'second untracked value, same path and status\n');
    const second = await inspect(gp, bound);
    assert.equal(second.ok, true, second.ok ? '' : second.error);
    if (!second.ok || second.preview.worktreeState.directory !== 'present') return;
    assert.notEqual(
      first.preview.worktreeState.worktreeStateDigest,
      second.preview.worktreeState.worktreeStateDigest,
      'same porcelain path/status with different untracked bytes changes authority',
    );
    assert.notEqual(first.preview.previewDigest, second.preview.previewDigest);

    writeFileSync(join(bound.dir, 'tracked.bin'), Buffer.from([0, 1, 8, 3, 255]));
    const third = await inspect(gp, bound);
    assert.equal(third.ok, true, third.ok ? '' : third.error);
    if (!third.ok || third.preview.worktreeState.directory !== 'present') return;
    assert.notEqual(
      second.preview.worktreeState.worktreeStateDigest,
      third.preview.worktreeState.worktreeStateDigest,
      'same tracked status/path with different binary diff bytes changes authority',
    );
  } finally {
    await gp.cleanup();
  }
});

test('preview refuses an already-integrated feature tip and exact registration drift', async () => {
  freshDb();
  const gp = await newGitProject('abandon-preview-refusals');
  try {
    const merged = await provisionBound(gp);
    await commitFile(merged.dir, 'feature.txt', 'work\n');
    assert.equal((await git(['merge', '--no-ff', '--no-edit', merged.branch], gp.dir)).ok, true);
    const integrated = await inspect(gp, merged);
    assert.equal(integrated.ok, false);
    if (!integrated.ok) assert.equal(integrated.code, 'already-merged');

    const detached = await provisionBound(gp);
    assert.equal((await git(['checkout', '--detach'], detached.dir)).ok, true);
    const registration = await inspect(gp, detached);
    assert.equal(registration.ok, false);
    if (!registration.ok) assert.equal(registration.code, 'registration-mismatch');

    const outside = await inspect(gp, { ...detached, worktree: { ...detached.worktree, path: gp.dir } });
    assert.equal(outside.ok, false);
    if (!outside.ok) assert.equal(outside.code, 'binding-mismatch');
  } finally {
    await gp.cleanup();
  }
});

test('missing directory is diagnostic only; registered state remains explicit', async () => {
  freshDb();
  const gp = await newGitProject('abandon-preview-missing');
  try {
    const bound = await provisionBound(gp);
    rmSync(bound.dir, { recursive: true, force: true });
    const result = await inspect(gp, bound);
    assert.equal(result.ok, true, result.ok ? '' : result.error);
    if (!result.ok) return;
    assert.deepEqual(result.preview.worktreeState, {
      directory: 'missing',
      registration: 'registered',
      status: 'unavailable',
      worktreeStateDigest: result.preview.worktreeState.worktreeStateDigest,
      changedPaths: [],
      ignoredContents: 'uninspected',
    });
  } finally {
    await gp.cleanup();
  }
});

test('receipt-backed teardown removes directory/registration and preserves exact branch tip', async () => {
  freshDb();
  const gp = await newGitProject('abandon-teardown');
  try {
    const bound = await provisionBound(gp);
    await commitFile(bound.dir, 'feature.txt', 'work\n');
    writeFileSync(join(bound.dir, 'untracked.txt'), 'explicitly discarded\n');
    const inspected = await inspect(gp, bound);
    assert.equal(inspected.ok, true, inspected.ok ? '' : inspected.error);
    if (!inspected.ok || inspected.preview.worktreeState.directory !== 'present') return;
    const approved = authority(inspected.preview);
    const settled = await settleAbandonedWorktree({ projectDir: gp.dir, authority: approved });
    assert.equal(settled.ok, true, settled.ok ? '' : settled.error);
    if (!settled.ok) return;
    assert.equal(existsSync(bound.dir), false);
    assert.equal((await git(['rev-parse', `refs/heads/${bound.branch}`], gp.dir)).stdout, approved.branchTip);
    assert.equal((await git(['worktree', 'list', '--porcelain'], gp.dir)).stdout.includes(bound.dir), false);
    assert.equal(settled.receipt.directoryAbsent, true);
    assert.equal(settled.receipt.registrationAbsent, true);
    assert.equal(settled.receipt.branchPreserved, true);
    assert.equal(isWorktreeAbandonmentTeardownReceipt(settled.receipt), true);
    assert.equal(getWorktreeById(bound.worktree.id)?.status, 'destroyed', 'only the exact durable row settles');

    const again = await settleAbandonedWorktree({ projectDir: gp.dir, authority: approved });
    assert.equal(again.ok, true, again.ok ? 'receipt-backed recovery is idempotent' : again.error);
    if (again.ok) {
      assert.equal(isWorktreeAbandonmentTeardownReceipt(again.receipt), true);
      assert.equal(again.receipt.finishedAt, settled.receipt.finishedAt, 'recovery reuses durable destroyedAt');
    }
  } finally {
    await gp.cleanup();
  }
});

test('teardown refuses branch drift before destructive removal', async () => {
  freshDb();
  const gp = await newGitProject('abandon-teardown-drift');
  try {
    const bound = await provisionBound(gp);
    await commitFile(bound.dir, 'approved.txt', 'approved\n');
    const inspected = await inspect(gp, bound);
    assert.equal(inspected.ok, true, inspected.ok ? '' : inspected.error);
    if (!inspected.ok || inspected.preview.worktreeState.directory !== 'present') return;
    const approved = authority(inspected.preview);
    await commitFile(bound.dir, 'late.txt', 'late\n');
    const refused = await settleAbandonedWorktree({ projectDir: gp.dir, authority: approved });
    assert.equal(refused.ok, false);
    if (!refused.ok) assert.equal(refused.code, 'branch-drifted');
    assert.equal(existsSync(bound.dir), true, 'no deletion followed stale authority');
  } finally {
    await gp.cleanup();
  }
});

test('receipt-backed recovery converges a missing directory with stale Git registration', async () => {
  freshDb();
  const gp = await newGitProject('abandon-teardown-stale-registration');
  try {
    const bound = await provisionBound(gp);
    await commitFile(bound.dir, 'feature.txt', 'work\n');
    const inspected = await inspect(gp, bound);
    assert.equal(inspected.ok, true, inspected.ok ? '' : inspected.error);
    if (!inspected.ok || inspected.preview.worktreeState.directory !== 'present') return;
    const approved = authority(inspected.preview);

    // Simulate a crash/partial external remove after authority persisted: the
    // directory is gone but Git's registration still names it.
    rmSync(bound.dir, { recursive: true, force: true });
    const before = await git(['worktree', 'list', '--porcelain'], gp.dir);
    assert.equal(before.stdout.includes(`branch refs/heads/${bound.branch}`), true);

    const settled = await settleAbandonedWorktree({ projectDir: gp.dir, authority: approved });
    assert.equal(settled.ok, true, settled.ok ? '' : settled.error);
    assert.equal(
      (await git(['worktree', 'list', '--porcelain'], gp.dir)).stdout.includes(`branch refs/heads/${bound.branch}`),
      false,
    );
    assert.equal((await git(['rev-parse', `refs/heads/${bound.branch}`], gp.dir)).stdout, approved.branchTip);
  } finally {
    await gp.cleanup();
  }
});

test('teardown never settles while a locked stale Git registration survives', async () => {
  freshDb();
  const gp = await newGitProject('abandon-teardown-locked-registration');
  let worktreePath: string | null = null;
  try {
    const bound = await provisionBound(gp);
    worktreePath = bound.dir;
    await commitFile(bound.dir, 'feature.txt', 'work\n');
    const inspected = await inspect(gp, bound);
    assert.equal(inspected.ok, true, inspected.ok ? '' : inspected.error);
    if (!inspected.ok || inspected.preview.worktreeState.directory !== 'present') return;
    const approved = authority(inspected.preview);
    assert.equal((await git(['worktree', 'lock', bound.dir], gp.dir)).ok, true);

    const refused = await settleAbandonedWorktree({ projectDir: gp.dir, authority: approved });
    assert.equal(refused.ok, false);
    if (!refused.ok) assert.equal(refused.code, 'removal-incomplete');
    assert.equal((await git(['rev-parse', `refs/heads/${bound.branch}`], gp.dir)).stdout, approved.branchTip);
    assert.notEqual(getWorktreeById(bound.worktree.id)?.status, 'destroyed', 'no positive registration proof means no DB settlement');
  } finally {
    if (worktreePath) {
      await git(['worktree', 'unlock', worktreePath], gp.dir);
      await git(['worktree', 'prune'], gp.dir);
    }
    await gp.cleanup();
  }
});
