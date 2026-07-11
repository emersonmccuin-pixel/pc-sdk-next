// Lifecycle transition map (docs/worktree-lifecycle.md 'Lifecycle states').
// The interesting edges: review-rejected→fixing IS legal; tearing-down is
// reached only from merged (normal reclaim) and stranded (boot teardown
// retry); preserved parks have a `completed` resolution door so the run feed
// doesn't grow without bound; null/same-state are always legal.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  ALLOWED_LIFECYCLE_TRANSITIONS,
  RUN_LIFECYCLE_STATES,
  canTransition,
  isRunLifecycleState,
  type RunLifecycleState,
} from '../src/run-lifecycle.ts';

test('map is closed over the state union — every state keyed, every target valid', () => {
  assert.deepEqual(Object.keys(ALLOWED_LIFECYCLE_TRANSITIONS).sort(), [...RUN_LIFECYCLE_STATES].sort());
  for (const [from, targets] of Object.entries(ALLOWED_LIFECYCLE_TRANSITIONS)) {
    for (const to of targets) {
      assert.ok(isRunLifecycleState(to), `${from} → ${to}: unknown target`);
      assert.notEqual(to, from, `${from}: self-edge is implicit, not mapped`);
    }
  }
});

test('null (legacy/adoption) and same-state (idempotent re-stamp) are always legal', () => {
  for (const s of RUN_LIFECYCLE_STATES) {
    assert.ok(canTransition(null, s), `null → ${s}`);
    assert.ok(canTransition(s, s), `${s} → ${s}`);
  }
});

test('review-rejected → fixing is legal (not necessarily terminal)', () => {
  assert.ok(canTransition('review-rejected', 'fixing'));
});

test('tearing-down is reached only from merged and stranded (boot teardown retry)', () => {
  for (const s of RUN_LIFECYCLE_STATES) {
    if (s === 'merged' || s === 'stranded' || s === 'tearing-down') continue;
    assert.ok(!canTransition(s, 'tearing-down'), `${s} must not reach tearing-down`);
  }
  assert.ok(canTransition('merged', 'tearing-down'));
  assert.ok(canTransition('stranded', 'tearing-down'), 'landed-contract teardown retry');
});

test('terminal-failure states never falsely reach merged', () => {
  const failures: RunLifecycleState[] = ['provisioning-failed', 'failed', 'cancelled', 'stranded'];
  for (const s of failures) {
    assert.ok(!canTransition(s, 'merged'), `${s} → merged`);
  }
  // conflict → merged is the ONE exception: probe convergence on a merge a
  // crashed drive already made (positive ancestry proof, not a new mutation).
  assert.ok(canTransition('conflict', 'merged'));
});

test('preserved parks have the completed resolution door; failed has the re-land door', () => {
  // docs 'Teardown and retention': preserved states stay visible UNTIL
  // RESOLVED — resolution (contract landed + worktree reclaimed, possibly via
  // a later run) stamps them completed so the feed doesn't grow forever.
  for (const s of ['merge-ready', 'conflict', 'review-rejected', 'failed', 'stranded'] as const) {
    assert.ok(canTransition(s, 'completed'), `${s} → completed (resolution)`);
  }
  // pc_review_contract re-accept re-drives a mechanically failed landing.
  assert.ok(canTransition('failed', 'merging'));
});

test('cancelled/completed/provisioning-failed are dead ends', () => {
  for (const s of ['cancelled', 'completed', 'provisioning-failed'] as const) {
    assert.equal(ALLOWED_LIFECYCLE_TRANSITIONS[s].length, 0, `${s} has outgoing edges`);
  }
});

test('happy-path auto-land chain is legal edge by edge', () => {
  const chain: RunLifecycleState[] = ['provisioning', 'building', 'verifying', 'merging', 'merged', 'tearing-down', 'completed'];
  for (let i = 1; i < chain.length; i++) {
    assert.ok(canTransition(chain[i - 1]!, chain[i]!), `${chain[i - 1]} → ${chain[i]}`);
  }
});

test('park + review chain: verifying → merge-ready → merging; reject door works', () => {
  assert.ok(canTransition('verifying', 'merge-ready'));
  assert.ok(canTransition('merge-ready', 'merging'));
  assert.ok(canTransition('merge-ready', 'review-rejected'));
  assert.ok(canTransition('verifying', 'verification-failed'));
  assert.ok(canTransition('verification-failed', 'fixing'));
  // Orchestrator accept after a park/conflict re-lands.
  assert.ok(canTransition('conflict', 'merging'));
});

test('illegal jumps are rejected', () => {
  assert.ok(!canTransition('building', 'merged'), 'building cannot skip verification/landing');
  assert.ok(!canTransition('queued', 'building'), 'queued goes through provisioning');
  assert.ok(!canTransition('completed', 'building'), 'completed is final');
  assert.ok(!canTransition('merging', 'cancelled'), 'a landing mutation is never cancelled mid-merge');
});
