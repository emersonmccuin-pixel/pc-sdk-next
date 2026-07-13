// Guard tests for the contract-view pure logic (features/contracts/view.ts):
// seed/live overlay version rule, merge-ready + landing-issue section
// predicates, and the landingPolicy legacy fallback. Self-contained: no '@/'
// alias so this runs under `tsx --test` without extra config.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import type { Contract, ResourceEvent } from '../../../packages/contracts/src/index.ts';
import {
  canRequestAbandonment,
  effectivePolicy,
  isLegacyAbandonment,
  isSettledAbandonment,
  landingIssueDetail,
  landingIssueLabel,
  landingIssueContracts,
  mergeReadyContracts,
  overlayContracts,
} from '../src/features/contracts/view.ts';

function contract(overrides: Partial<Contract> & { id: string }): Contract {
  return {
    projectId: 'p1',
    pmRef: null,
    agentRunId: null,
    podName: 'builder',
    expectedOutput: { kind: 'repo' },
    acceptanceCriteria: null,
    verificationTier: null,
    verificationStatus: null,
    verificationNotes: null,
    report: null,
    deliverable: null,
    worktreePath: null,
    worktreeBaseBranch: null,
    worktreeBaseSha: null,
    landingStatus: null,
    landedBranch: null,
    landedSha: null,
    landingError: null,
    landedAt: null,
    targetShaBefore: null,
    targetShaAfter: null,
    mergeSha: null,
    landingAuthorizer: null,
    verifiedBaseSha: null,
    landingPolicy: null,
    reviewRound: null,
    reviewRunId: null,
    reviewSealedCommit: null,
    abandonmentReceipt: null,
    abandonmentTeardownReceipt: null,
    abandonmentError: null,
    status: 'issued',
    version: 1,
    createdAt: 0,
    updatedAt: 0,
    ...overrides,
  };
}

function contractEvent(c: Contract, cursor: string): ResourceEvent {
  return {
    id: `evt-${cursor}`,
    cursor,
    scope: 'project',
    projectId: c.projectId,
    entity: 'contract',
    entityId: c.id,
    eventType: 'contract.changed',
    version: c.version,
    createdAt: c.updatedAt,
    payload: { reason: 'patched', contract: c },
  };
}

test('overlayContracts: live frame with newer version replaces the seed row', () => {
  const seed = contract({ id: 'c1', version: 2, verificationStatus: null });
  const live = contract({ id: 'c1', version: 3, verificationStatus: 'passed' });
  const out = overlayContracts([seed], [contractEvent(live, '10')]);
  assert.equal(out.length, 1);
  assert.equal(out[0].verificationStatus, 'passed');
});

test('overlayContracts: stale live frame never regresses a fresher seed', () => {
  const seed = contract({ id: 'c1', version: 5, verificationStatus: 'passed' });
  const stale = contract({ id: 'c1', version: 4, verificationStatus: null });
  const out = overlayContracts([seed], [contractEvent(stale, '10')]);
  assert.equal(out[0].verificationStatus, 'passed');
});

test('overlayContracts: live-only contract appears; newest-first ordering', () => {
  const seed = contract({ id: 'c1', version: 1, createdAt: 100 });
  const liveOnly = contract({ id: 'c2', version: 1, createdAt: 200 });
  const out = overlayContracts([seed], [contractEvent(liveOnly, '10')]);
  assert.deepEqual(
    out.map((c) => c.id),
    ['c2', 'c1'],
  );
});

test('mergeReadyContracts: repo + passed + unlanded only', () => {
  const parked = contract({ id: 'parked', verificationStatus: 'passed', landingStatus: null });
  const pending = contract({ id: 'pending', verificationStatus: 'passed', landingStatus: 'pending' });
  const landed = contract({ id: 'landed', verificationStatus: 'passed', landingStatus: 'landed' });
  const failedVerify = contract({ id: 'fv', verificationStatus: 'failed' });
  const nonRepo = contract({
    id: 'answer',
    expectedOutput: { kind: 'answer' },
    verificationStatus: 'passed',
  });
  // Full-review with an independent review in flight — not the orchestrator's.
  const reviewing = contract({
    id: 'reviewing',
    verificationStatus: 'passed',
    landingStatus: null,
    landingPolicy: 'full-review',
    reviewRound: 1,
    reviewRunId: 'run-9',
  });
  const out = mergeReadyContracts([parked, pending, landed, failedVerify, nonRepo, reviewing]);
  assert.deepEqual(
    out.map((c) => c.id),
    ['parked', 'pending'],
  );
});

test('landingIssueContracts: pending cleanup and legacy abandonment stay visible; settled abandonment resolves', () => {
  const conflict = contract({ id: 'c', landingStatus: 'conflict' });
  const failed = contract({ id: 'f', landingStatus: 'failed' });
  const stale = contract({ id: 's', landingStatus: 'stale-base' });
  const legacy = contract({ id: 'legacy', landingStatus: 'abandoned' });
  const authority = {} as NonNullable<Contract['abandonmentReceipt']>;
  const teardown = {} as NonNullable<Contract['abandonmentTeardownReceipt']>;
  const abandoning = contract({
    id: 'pending-cleanup',
    landingStatus: 'abandoning',
    abandonmentReceipt: authority,
    abandonmentError: 'locked file',
  });
  const abandoned = contract({
    id: 'settled',
    landingStatus: 'abandoned',
    abandonmentReceipt: authority,
    abandonmentTeardownReceipt: teardown,
  });
  const landed = contract({ id: 'l', landingStatus: 'landed' });
  const out = landingIssueContracts([conflict, failed, stale, legacy, abandoning, abandoned, landed]);
  assert.deepEqual(
    out.map((c) => c.id),
    ['c', 'f', 's', 'legacy', 'pending-cleanup'],
  );
  assert.equal(isLegacyAbandonment(legacy), true);
  assert.equal(isSettledAbandonment(abandoned), true);
  assert.equal(landingIssueLabel(abandoning), 'cleanup pending');
  assert.equal(landingIssueDetail(abandoning), 'locked file');
  assert.equal(landingIssueLabel(legacy), 'authority unavailable');
  assert.match(landingIssueDetail(legacy) ?? '', /no approval receipt/);
});

test('canRequestAbandonment is only a conservative presentation gate', () => {
  const eligible = contract({ id: 'eligible', worktreePath: 'C:\\repo-worktrees\\run-1' });
  assert.equal(canRequestAbandonment(eligible), true);
  assert.equal(canRequestAbandonment(contract({
    id: 'reviewed', worktreePath: 'x', reviewRunId: 'review-1',
  })), true, 'a historical review link is not evidence that the reviewer remains live');
  assert.equal(canRequestAbandonment(contract({
    id: 'legacy', worktreePath: 'x', landingStatus: 'abandoned',
  })), true, 'legacy status is not authority and may enter a fresh explicit preview');
  assert.equal(canRequestAbandonment(contract({
    id: 'landing', worktreePath: 'x', landingStatus: 'pending',
  })), false);
  assert.equal(canRequestAbandonment(contract({
    id: 'non-repo', worktreePath: 'x', expectedOutput: { kind: 'answer' },
  })), false);
});

test('effectivePolicy: column wins; legacy NULL falls back through auto_land', () => {
  assert.equal(effectivePolicy(contract({ id: '1', landingPolicy: 'full-review' })), 'full-review');
  assert.equal(
    effectivePolicy(contract({ id: '2', expectedOutput: { kind: 'repo', auto_land: true } })),
    'auto-merge',
  );
  assert.equal(effectivePolicy(contract({ id: '3' })), 'default-review');
  assert.equal(
    effectivePolicy(contract({ id: '4', expectedOutput: { kind: 'answer' } })),
    'default-review',
  );
  // Legacy NULL + spec review 'full' ⇒ full-review; wins over auto_land.
  assert.equal(
    effectivePolicy(contract({ id: '5', expectedOutput: { kind: 'repo', review: 'full', auto_land: true } })),
    'full-review',
  );
});
