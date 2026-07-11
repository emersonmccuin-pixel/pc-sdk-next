// Guard 3 (docs/worktree-lifecycle.md) — changed_paths_within: derived changed
// paths vs declared scope. Unreadable git evidence parks inconclusive (null),
// never a false fail.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  deriveAcceptanceCriteriaV2,
  evaluateAcceptance,
  pathMatchesPattern,
  type PredicateExecutors,
} from '../src/index.ts';
import type { AcceptanceCriteria, ExpectedOutput } from '../src/contract.ts';

const ctx = { body: '', fields: {}, attachments: [] };

function exec(changed: string[] | null | undefined): PredicateExecutors {
  return {
    fileSize: async () => null,
    runBash: async () => ({ exitCode: 1, timedOut: false }),
    ...(changed !== undefined ? { changedPaths: async () => changed } : {}),
  };
}

const crit = (allowed: string[], forbidden?: string[]): AcceptanceCriteria => [
  { kind: 'changed_paths_within', allowed, ...(forbidden ? { forbidden } : {}) },
];

test('in-scope changed paths pass', async () => {
  const r = await evaluateAcceptance(
    crit(['src/**', 'docs/plan.md']),
    ctx,
    exec(['src/a.ts', 'src/deep/b.ts', 'docs/plan.md']),
  );
  assert.equal(r.pass, true);
});

test('an empty diff passes (nothing out of scope)', async () => {
  const r = await evaluateAcceptance(crit(['src/**']), ctx, exec([]));
  assert.equal(r.pass, true);
});

test('out-of-scope path fails with the path named', async () => {
  const r = await evaluateAcceptance(crit(['src/**']), ctx, exec(['src/a.ts', 'infra/deploy.yml']));
  assert.equal(r.pass, false);
  assert.match(r.failures[0]!.reason, /outside declared scope/);
  assert.match(r.failures[0]!.reason, /infra\/deploy\.yml/);
  assert.notEqual(r.failures[0]!.inconclusive, true);
});

test('forbidden path fails even when the allowed set covers it', async () => {
  const r = await evaluateAcceptance(
    crit(['**'], ['secrets/**']),
    ctx,
    exec(['src/a.ts', 'secrets/key.pem']),
  );
  assert.equal(r.pass, false);
  assert.match(r.failures[0]!.reason, /forbidden path/);
  assert.match(r.failures[0]!.reason, /secrets\/key\.pem/);
});

test('default forbidden list blocks .git/** without a declared forbidden field', async () => {
  const r = await evaluateAcceptance(crit(['**']), ctx, exec(['.git/hooks/pre-commit']));
  assert.equal(r.pass, false);
  assert.match(r.failures[0]!.reason, /forbidden path/);
});

test('unreadable git state (null) → inconclusive, never false', async () => {
  const r = await evaluateAcceptance(crit(['src/**']), ctx, exec(null));
  assert.equal(r.pass, false);
  assert.equal(r.failures[0]!.inconclusive, true);
  assert.match(r.failures[0]!.reason, /inconclusive/);
});

test('missing executor fails with a clear reason (not inconclusive)', async () => {
  const r = await evaluateAcceptance(crit(['src/**']), ctx, exec(undefined));
  assert.equal(r.pass, false);
  assert.match(r.failures[0]!.reason, /no changed-paths executor/);
  assert.notEqual(r.failures[0]!.inconclusive, true);
});

// ── pattern semantics ───────────────────────────────────────────────────────

test('pathMatchesPattern: ** spans segments, * stays within one', () => {
  assert.equal(pathMatchesPattern('src/a/b/c.ts', 'src/**'), true);
  assert.equal(pathMatchesPattern('src/a.ts', 'src/*.ts'), true);
  assert.equal(pathMatchesPattern('src/a/b.ts', 'src/*.ts'), false); // '*' never crosses '/'
  assert.equal(pathMatchesPattern('a/b/foo.ts', '**/foo.ts'), true);
  assert.equal(pathMatchesPattern('foo.ts', '**/foo.ts'), true); // '**/' matches zero segments
});

test('pathMatchesPattern: a glob-free pattern matches exact path or directory prefix', () => {
  assert.equal(pathMatchesPattern('src/api/x.ts', 'src/api'), true);
  assert.equal(pathMatchesPattern('src/api', 'src/api'), true);
  assert.equal(pathMatchesPattern('src/api2/x.ts', 'src/api'), false); // prefix is per-segment
  assert.equal(pathMatchesPattern('README.md', 'README.md'), true);
});

// ── derivation ──────────────────────────────────────────────────────────────

test('deriveRepoV2 compiles paths_touched into changed_paths_within', () => {
  const spec: ExpectedOutput = { kind: 'repo', paths_touched: ['src/**', 'docs/x.md'] };
  const derived = deriveAcceptanceCriteriaV2(spec);
  const pred = derived.find((p) => p.kind === 'changed_paths_within');
  assert.ok(pred, 'changed_paths_within must be derived');
  assert.deepEqual((pred as { allowed: string[] }).allowed, ['src/**', 'docs/x.md']);
});

test('deriveRepoV2 without paths_touched derives no scope predicate', () => {
  for (const spec of [{ kind: 'repo' } as ExpectedOutput, { kind: 'repo', paths_touched: [] } as ExpectedOutput]) {
    const derived = deriveAcceptanceCriteriaV2(spec);
    assert.equal(derived.some((p) => p.kind === 'changed_paths_within'), false);
  }
});
