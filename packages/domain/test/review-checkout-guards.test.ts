import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  createReviewCheckoutPhaseReceipt,
  isReviewCheckoutPhaseReceipt,
  reviewCheckoutPhaseMatchesRun,
  type ReviewCheckoutAuthority,
  type WorktreePhaseReceipt,
} from '../src/index.ts';

const authority: ReviewCheckoutAuthority = {
  id: '01J00000000000000000000001',
  projectId: '01J00000000000000000000002',
  contractId: '01J00000000000000000000003',
  contractVersion: 4,
  producerRunId: '01J00000000000000000000004',
  reviewerRunId: '01J00000000000000000000005',
  repositoryIdentity: {
    protocol: 'git-common-dir-v1',
    gitCommonDir: '/repo/.git',
    leaseKey: `sha256:${'a'.repeat(64)}`,
  },
  worktreePath: '/repo/reviews/exact',
  ownedRootRealPath: '/repo/reviews',
  sealedCommit: 'b'.repeat(40),
};

function noCommands(phase: 'preparation' | 'readiness', finishedAt: number): WorktreePhaseReceipt {
  return {
    phase,
    outcome: 'not-required',
    reason: 'no-commands-configured',
    ok: true,
    steps: [],
    finishedAt,
  };
}

test('review phase factory refuses inherited and malformed generic evidence', () => {
  assert.throws(
    () => createReviewCheckoutPhaseReceipt(authority, {
      phase: 'preparation',
      outcome: 'not-required',
      reason: 'existing-worktree-preparation',
      inheritedFromRunId: authority.producerRunId,
      ok: true,
      steps: [],
      finishedAt: 10,
    } as never),
    /exact fresh checkout evidence/,
  );

  for (const malformed of [
    {
      phase: 'preparation', outcome: 'executed', ok: true, steps: [], finishedAt: 11,
    },
    {
      phase: 'preparation', outcome: 'executed', ok: true,
      steps: [{
        command: 'pnpm install', exitCode: 1, durationMs: 1,
        stdoutTail: '', stderrTail: 'failed', timedOut: false,
      }],
      finishedAt: 12,
    },
    {
      ...noCommands('preparation', 13),
      providerReceipt: 'must-not-cross-the-boundary',
    },
    {
      ...noCommands('readiness', 14),
      finishedAt: -1,
    },
  ]) {
    assert.throws(
      () => createReviewCheckoutPhaseReceipt(authority, malformed as never),
      /exact fresh checkout evidence/,
    );
  }
});

test('checkout phase guard is a closed wrapper and equality is byte-semantic', () => {
  const evidence = noCommands('preparation', 20);
  const receipt = createReviewCheckoutPhaseReceipt(authority, evidence);
  assert.equal(isReviewCheckoutPhaseReceipt(receipt), true);
  assert.equal(
    isReviewCheckoutPhaseReceipt({ ...receipt, providerReceipt: 'native-leak' }),
    false,
    'unknown wrapper evidence is rejected',
  );
  assert.equal(
    isReviewCheckoutPhaseReceipt(evidence),
    false,
    'a generic builder phase receipt is not checkout authority',
  );
  assert.equal(reviewCheckoutPhaseMatchesRun(authority, receipt, evidence, 'preparation'), true);
  assert.equal(reviewCheckoutPhaseMatchesRun(
    authority,
    receipt,
    { ...evidence, finishedAt: evidence.finishedAt + 1 },
    'preparation',
  ), false);
  assert.equal(reviewCheckoutPhaseMatchesRun(
    authority,
    receipt,
    noCommands('readiness', evidence.finishedAt),
    'preparation',
  ), false);
});
