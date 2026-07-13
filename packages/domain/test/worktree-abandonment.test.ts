import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  isMatchingWorktreeAbandonmentTeardown,
  isWorktreeAbandonmentPreview,
  isWorktreeAbandonmentReceipt,
  isWorktreeAbandonmentState,
  isWorktreeAbandonmentTeardownReceipt,
  type WorktreeAbandonmentPreview,
  type WorktreeAbandonmentReceipt,
  type WorktreeAbandonmentTeardownReceipt,
} from '../src/index.ts';

const projectId = '01J00000000000000000000000';
const contractId = '01J00000000000000000000001';
const producerRunId = '01J00000000000000000000002';
const worktreeId = '01J00000000000000000000003';
const branchTip = 'a'.repeat(40);
const requestId = '123e4567-e89b-42d3-a456-426614174000';
const repositoryIdentity = {
  protocol: 'git-common-dir-v1' as const,
  gitCommonDir: 'C:/repo/.git',
  leaseKey: `sha256:${'b'.repeat(64)}`,
};
const presentState = {
  directory: 'present' as const,
  registration: 'registered' as const,
  status: 'dirty' as const,
  staged: 1,
  unstaged: 2,
  untracked: 1,
  worktreeStateDigest: `sha256:${'c'.repeat(64)}`,
  changedPaths: ['src/a.ts', 'new.txt'],
  ignoredContents: 'uninspected' as const,
};
const preview: WorktreeAbandonmentPreview = {
  protocol: 'worktree-abandonment-preview-v1',
  projectId,
  contractId,
  contractVersion: 7,
  producerRunId,
  worktreeId,
  worktreeStatus: 'stranded',
  worktreePath: 'C:/repo-worktrees/agent-one',
  branch: 'agent-one',
  branchTip,
  baseBranch: 'main',
  validatedBaseSha: 'd'.repeat(40),
  targetTip: 'e'.repeat(40),
  integrationState: 'unmerged',
  repositoryIdentity,
  worktreeState: presentState,
  previewDigest: `sha256:${'f'.repeat(64)}`,
};
const authority: WorktreeAbandonmentReceipt = {
  protocol: 'worktree-abandonment-v1',
  requestId,
  approvedBy: 'user',
  approvalSurface: 'browser',
  approvalReason: 'explicit-browser-confirmation',
  approvedAt: 100,
  reason: 'No longer needed',
  approvedContractVersion: 7,
  projectId,
  contractId,
  producerRunId,
  worktreeId,
  worktreeStatus: 'stranded',
  repositoryIdentity,
  worktreePath: preview.worktreePath,
  branch: preview.branch,
  branchTip,
  baseBranch: preview.baseBranch,
  validatedBaseSha: preview.validatedBaseSha,
  targetTip: preview.targetTip,
  integrationState: preview.integrationState,
  worktreeState: presentState,
  previewDigest: preview.previewDigest,
};
const settlement: WorktreeAbandonmentTeardownReceipt = {
  protocol: 'worktree-abandonment-teardown-v1',
  authorityRequestId: requestId,
  startedAt: 110,
  finishedAt: 120,
  repositoryIdentity,
  worktreePath: preview.worktreePath,
  branch: preview.branch,
  approvedBranchTip: branchTip,
  observedBranchTip: branchTip,
  directoryAbsent: true,
  registrationAbsent: true,
  branchPreserved: true,
};

test('abandonment guards accept exact preview, authority, and matching settlement', () => {
  assert.equal(isWorktreeAbandonmentState(presentState), true);
  assert.equal(isWorktreeAbandonmentPreview(preview), true);
  assert.equal(isWorktreeAbandonmentReceipt(authority), true);
  assert.equal(isWorktreeAbandonmentTeardownReceipt(settlement), true);
  assert.equal(isMatchingWorktreeAbandonmentTeardown(authority, settlement), true);
});

test('abandonment state guards reject inconsistent counts, extras, and malformed evidence', () => {
  assert.equal(isWorktreeAbandonmentState({ ...presentState, status: 'clean' }), false);
  assert.equal(isWorktreeAbandonmentState({ ...presentState, provider: 'native' }), false);
  assert.equal(isWorktreeAbandonmentPreview({ ...preview, contractVersion: Number.MAX_SAFE_INTEGER + 1 }), false);
  assert.equal(isWorktreeAbandonmentPreview({ ...preview, projectId: projectId.toLowerCase() }), false);
  assert.equal(isWorktreeAbandonmentPreview({ ...preview, branchTip: 'abc' }), false);
  assert.equal(isWorktreeAbandonmentPreview({ ...preview, previewDigest: 'sha256:nope' }), false);
  assert.equal(isWorktreeAbandonmentReceipt({ ...authority, requestId: 'not-a-uuid' }), false);
  assert.equal(isWorktreeAbandonmentReceipt({ ...authority, reason: ' padded ' }), false);
  assert.equal(isWorktreeAbandonmentReceipt({ ...authority, worktreeState: {
    directory: 'missing',
    registration: 'absent',
    status: 'unavailable',
    worktreeStateDigest: `sha256:${'a'.repeat(64)}`,
    changedPaths: [],
    ignoredContents: 'uninspected',
  } }), false, 'fresh authority requires present registered work');
});

test('settlement structure is strict and matching binds authority identity and branch tip', () => {
  assert.equal(isWorktreeAbandonmentTeardownReceipt({ ...settlement, finishedAt: 109 }), false);
  assert.equal(isWorktreeAbandonmentTeardownReceipt({ ...settlement, directoryAbsent: false }), false);
  assert.equal(isMatchingWorktreeAbandonmentTeardown(authority, {
    ...settlement,
    observedBranchTip: '1'.repeat(40),
  }), false);
  assert.equal(isMatchingWorktreeAbandonmentTeardown(authority, {
    ...settlement,
    authorityRequestId: '123e4567-e89b-42d3-b456-426614174000',
  }), false);
});
