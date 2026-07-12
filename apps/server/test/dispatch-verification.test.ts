// verifyContract guard tests — the empty-contract auto-pass stays closed
// (2026-06-07 finding) and inconclusive never false-fails.
// Plus guard 5 (autoLandBlockers): auto-merge refuses missing, failed,
// warning, or inconclusive evidence — the gate is pure and fails closed.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { autoLandBlockers, verifyContract, type VerificationOutcome } from '../src/dispatch/verification.ts';

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

test('verification shell removes ambient app/provider/injection variables without changing evidence semantics', async () => {
  const canaries = {
    PC_AINATIVE_PM_TOKEN: 'pm-secret-must-not-cross',
    OPENAI_API_KEY: 'peer-secret-must-not-cross',
    INNOCENT_CANARY: 'unknown-name-must-not-cross',
    NODE_OPTIONS: '--sec-003-invalid-node-option',
    BASH_ENV: 'shell-startup-must-not-cross',
  };
  const previous = new Map<string, string | undefined>();
  for (const [name, value] of Object.entries(canaries)) {
    previous.set(name, process.env[name]);
    process.env[name] = value;
  }
  try {
    const command = "node -e \"const names=['PC_AINATIVE_PM_TOKEN','OPENAI_API_KEY','INNOCENT_CANARY','NODE_OPTIONS','BASH_ENV'];if(names.some((name)=>process.env[name]!==undefined))process.exit(29)\"";
    const outcome = await verifyContract(
      base({
        acceptanceCriteria: [{ kind: 'bash_exit_zero', command, cwd: 'project' }],
        scope: { worktreeDir: null, projectDir: process.cwd() },
      }),
    );
    assert.equal(outcome.verificationStatus, 'passed', outcome.notes ?? 'no notes');
    assert.deepEqual(outcome.evaluatedPredicateKinds, ['bash_exit_zero']);
    assert.equal(outcome.inconclusiveCount, 0);
  } finally {
    for (const [name, value] of previous) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  }
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
  assert.equal(outcome.inconclusiveCount, 1, 'inconclusive results are counted on the outcome');
  assert.deepEqual(outcome.evaluatedPredicateKinds, ['git_diff_nonempty']);
});

test('outcome records the evaluated predicate kinds; review parks record none', async () => {
  const evaluated = await verifyContract(
    base({
      acceptanceCriteria: [
        { kind: 'min_length', min: 5 },
        { kind: 'tool_called', name: 'pc_submit_deliverable' },
      ],
      deliverable: { kind: 'answer', text: 'long enough answer' },
      toolCalls: [{ name: 'pc_submit_deliverable' }],
    }),
  );
  assert.deepEqual(evaluated.evaluatedPredicateKinds, ['min_length', 'tool_called']);
  assert.equal(evaluated.inconclusiveCount, 0);

  const parked = await verifyContract(base({ verificationTier: 'orchestrator-review' }));
  assert.deepEqual(parked.evaluatedPredicateKinds, [], 'a park without evaluation claims no evidence');
});

// ── guard 5: the auto-land gate (pure) ──────────────────────────────────────

const REPO_SPEC = { kind: 'repo' as const, paths_touched: ['src/**'], auto_land: true };

function passedOutcome(overrides: Partial<VerificationOutcome> = {}): VerificationOutcome {
  return {
    verificationStatus: 'passed',
    notes: null,
    escalatedToReview: false,
    evaluatedPredicateKinds: ['git_diff_nonempty', 'changed_paths_within'],
    inconclusiveCount: 0,
    ...overrides,
  };
}

test('guard 5: all-positive evidence is auto-land eligible', () => {
  const blockers = autoLandBlockers({ landingPolicy: 'auto-merge', spec: REPO_SPEC, outcome: passedOutcome(), hasPendingAsk: false });
  assert.deepEqual(blockers, []);
});

test('guard 5: pending and failed verification cannot auto-land', () => {
  for (const verificationStatus of ['pending', 'failed'] as const) {
    const blockers = autoLandBlockers({
      landingPolicy: 'auto-merge',
      spec: REPO_SPEC,
      outcome: passedOutcome({ verificationStatus }),
      hasPendingAsk: false,
    });
    assert.match(blockers.join('; '), new RegExp(`'${verificationStatus}', not 'passed'`));
  }
});

test('guard 5: an inconclusive subset blocks even when the status says passed (hole closed)', () => {
  const blockers = autoLandBlockers({
    landingPolicy: 'auto-merge',
    spec: REPO_SPEC,
    outcome: passedOutcome({ inconclusiveCount: 1 }),
    hasPendingAsk: false,
  });
  assert.match(blockers.join('; '), /inconclusive predicate result/);
});

test('guard 5: declared paths_touched without evaluated scope evidence blocks (missing evidence ≠ pass)', () => {
  const blockers = autoLandBlockers({
    landingPolicy: 'auto-merge',
    spec: REPO_SPEC,
    outcome: passedOutcome({ evaluatedPredicateKinds: ['git_diff_nonempty'] }),
    hasPendingAsk: false,
  });
  assert.match(blockers.join('; '), /scope evidence missing/);
  // No declared scope ⇒ no scope-evidence requirement.
  const noScope = autoLandBlockers({
    landingPolicy: 'auto-merge',
    spec: { kind: 'repo', auto_land: true },
    outcome: passedOutcome({ evaluatedPredicateKinds: ['git_diff_nonempty'] }),
    hasPendingAsk: false,
  });
  assert.deepEqual(noScope, []);
});

test('guard 5: a missing outcome, an open ask, or a non-auto-merge policy each block', () => {
  assert.match(
    autoLandBlockers({ landingPolicy: 'auto-merge', spec: REPO_SPEC, outcome: null, hasPendingAsk: false }).join('; '),
    /no fresh verification outcome/,
  );
  assert.match(
    autoLandBlockers({ landingPolicy: 'auto-merge', spec: REPO_SPEC, outcome: passedOutcome(), hasPendingAsk: true }).join('; '),
    /unresolved pending ask/,
  );
  assert.match(
    autoLandBlockers({ landingPolicy: 'default-review', spec: REPO_SPEC, outcome: passedOutcome(), hasPendingAsk: false }).join('; '),
    /not 'auto-merge'/,
  );
});
