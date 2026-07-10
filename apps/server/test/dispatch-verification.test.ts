// verifyContract guard tests — the empty-contract auto-pass stays closed
// (2026-06-07 finding) and inconclusive never false-fails.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { verifyContract } from '../src/dispatch/verification.ts';

const SCOPE = { worktreeDir: null, projectDir: '' };

function base(overrides: Partial<Parameters<typeof verifyContract>[0]>): Parameters<typeof verifyContract>[0] {
  return {
    expectedOutput: { kind: 'answer' },
    acceptanceCriteria: [],
    verificationTier: 'auto',
    deliverable: { kind: 'answer', text: 'x' },
    report: null,
    toolCalls: [],
    pendingAskCreated: false,
    scope: SCOPE,
    ...overrides,
  };
}

test('bare answer with empty criteria and no trust_end_turn ESCALATES to review (never auto-passes)', async () => {
  const outcome = await verifyContract(base({}));
  assert.equal(outcome.verificationStatus, 'pending');
  assert.equal(outcome.escalatedToReview, true);
});

test('answer with trust_end_turn accepts on empty criteria (explicit opt-in)', async () => {
  const outcome = await verifyContract(base({ expectedOutput: { kind: 'answer', trust_end_turn: true } }));
  assert.equal(outcome.verificationStatus, 'passed');
});

test('evidence kinds (repo/action/external) fail-closed on empty criteria', async () => {
  for (const expectedOutput of [
    { kind: 'repo' as const, require_diff: false },
    { kind: 'action' as const, tool: 'x' },
    { kind: 'external' as const, system: 'email' as const, action: 'send', confirm: 'always' as const, idempotency_key: 'k', verify_handle: false },
  ]) {
    const outcome = await verifyContract(base({ expectedOutput, acceptanceCriteria: [] }));
    assert.equal(outcome.verificationStatus, 'pending', `${expectedOutput.kind} must not auto-pass empty`);
    assert.equal(outcome.escalatedToReview, true);
  }
});

test('review tiers park pending without evaluating predicates', async () => {
  const outcome = await verifyContract(
    base({
      verificationTier: 'orchestrator-review',
      acceptanceCriteria: [{ kind: 'min_length', min: 10_000 }], // would fail if evaluated
    }),
  );
  assert.equal(outcome.verificationStatus, 'pending');
  assert.equal(outcome.escalatedToReview, true);
});

test('failing predicate ⇒ failed with evidence notes', async () => {
  const outcome = await verifyContract(
    base({
      acceptanceCriteria: [{ kind: 'min_length', min: 100 }],
      deliverable: { kind: 'answer', text: 'too short' },
    }),
  );
  assert.equal(outcome.verificationStatus, 'failed');
  assert.match(outcome.notes ?? '', /min_length/);
});

test('passing predicates ⇒ passed', async () => {
  const outcome = await verifyContract(
    base({
      acceptanceCriteria: [
        { kind: 'min_length', min: 5 },
        { kind: 'tool_called', name: 'pc_submit_deliverable' },
      ],
      deliverable: { kind: 'answer', text: 'long enough answer' },
      toolCalls: [{ name: 'pc_submit_deliverable' }],
    }),
  );
  assert.equal(outcome.verificationStatus, 'passed');
});

test('inconclusive-only failures park pending (env defect ≠ work defect)', async () => {
  // git_diff_nonempty with no worktree/baseSha ⇒ hasGitDiff returns null ⇒ inconclusive.
  const outcome = await verifyContract(
    base({
      expectedOutput: { kind: 'repo' },
      acceptanceCriteria: [{ kind: 'git_diff_nonempty', cwd: 'worktree' }],
      deliverable: { kind: 'repo', branch: 'agent-x', commit: 'abc' },
    }),
  );
  assert.equal(outcome.verificationStatus, 'pending');
  assert.equal(outcome.escalatedToReview, false);
});
