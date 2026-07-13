import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  createNotRequiredWorktreePhaseReceipt,
  isMatchingReviewCheckoutProvision,
  isMatchingReviewCheckoutTeardown,
  isReviewCheckoutGitReceipt,
  isReviewCheckoutRuntimeReady,
  type ReviewCheckout,
  type ReviewCheckoutAuthority,
} from '../src/index.ts';

const authority: ReviewCheckoutAuthority = {
  id: '01J00000000000000000000001',
  projectId: '01J00000000000000000000002',
  contractId: '01J00000000000000000000003',
  contractVersion: 7,
  producerRunId: '01J00000000000000000000004',
  reviewerRunId: '01J00000000000000000000005',
  repositoryIdentity: {
    protocol: 'git-common-dir-v1',
    gitCommonDir: '/repo/.git',
    leaseKey: `sha256:${'a'.repeat(64)}`,
  },
  worktreePath: '/repo/reviews/reviewer',
  ownedRootRealPath: '/repo/reviews',
  sealedCommit: 'b'.repeat(40),
};

const provision = {
  protocol: 'review-checkout-provision-v1' as const,
  ...authority,
  registrationCount: 1 as const,
  registrationPath: authority.worktreePath,
  headSha: authority.sealedCommit,
  detachedHead: true as const,
  trackedChanges: 0 as const,
  stagedChanges: 0 as const,
  observedAt: 10,
};

test('review checkout receipts bind every authority field and positive observation', () => {
  assert.equal(isMatchingReviewCheckoutProvision(authority, provision), true);
  assert.equal(isMatchingReviewCheckoutProvision(authority, {
    ...provision,
    contractVersion: authority.contractVersion + 1,
  }), false);
  assert.equal(isMatchingReviewCheckoutProvision(authority, {
    ...provision,
    detachedHead: false,
  }), false);

  const teardown = {
    protocol: 'review-checkout-teardown-v1' as const,
    ...authority,
    startedAt: 20,
    finishedAt: 21,
    directoryAbsent: true as const,
    registrationAbsent: true as const,
    branchDeletion: 'not-applicable-detached' as const,
  };
  assert.equal(isMatchingReviewCheckoutTeardown(authority, teardown), true);
  assert.equal(isMatchingReviewCheckoutTeardown(authority, {
    ...teardown,
    registrationAbsent: false,
  }), false);
});

test('reviewer Git receipt is detached, exact, and runtime readiness needs both phases', () => {
  const gitReceipt = {
    ...provision,
    protocol: 'review-checkout-git-v1' as const,
    branch: '(detached)' as const,
    baseBranch: '(detached)' as const,
    baseSha: authority.sealedCommit,
    cleanStatus: true as const,
  };
  assert.equal(isReviewCheckoutGitReceipt(gitReceipt), true);
  assert.equal(isReviewCheckoutGitReceipt({ ...gitReceipt, branch: 'reviewer-00000005' }), false);
  assert.equal(isReviewCheckoutGitReceipt({ ...gitReceipt, baseSha: 'c'.repeat(40) }), false);

  const preparation = createNotRequiredWorktreePhaseReceipt({
    phase: 'preparation', reason: 'no-commands-configured', finishedAt: 11,
  });
  const readiness = createNotRequiredWorktreePhaseReceipt({
    phase: 'readiness', reason: 'no-commands-configured', finishedAt: 12,
  });
  const checkout: ReviewCheckout = {
    ...authority,
    status: 'provisioned',
    provisionReceipt: provision,
    preparationReceipt: preparation,
    readinessReceipt: readiness,
    teardownReceipt: null,
    cleanupError: null,
    createdAt: 1,
    updatedAt: 12,
    destroyedAt: null,
  };
  assert.equal(isReviewCheckoutRuntimeReady(checkout), true);
  assert.equal(isReviewCheckoutRuntimeReady({ ...checkout, readinessReceipt: null }), false);
  assert.equal(isReviewCheckoutRuntimeReady({ ...checkout, status: 'teardown-pending' }), false);
});
