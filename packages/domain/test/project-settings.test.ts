import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  defaultProjectSettings,
  INTEGRATION_BRANCH_RE,
  resolveContractLandingPolicy,
  withProjectSettingsDefaults,
} from '../src/project.ts';
import type { ExpectedOutput } from '../src/contract.ts';

// withProjectSettingsDefaults rebuilds the object key-by-key — any key it
// doesn't know is silently erased on the next read OR write. This round-trip
// is the regression that would have eaten integrationBranch.
test('integrationBranch survives the settings defaults round-trip', () => {
  const out = withProjectSettingsDefaults({ integrationBranch: 'reporting-rebuild-phase2' });
  assert.equal(out.integrationBranch, 'reporting-rebuild-phase2');

  // double round-trip (read → write merge → read)
  const again = withProjectSettingsDefaults({ ...out });
  assert.equal(again.integrationBranch, 'reporting-rebuild-phase2');
});

test('integrationBranch defaults to null and rejects junk', () => {
  assert.equal(defaultProjectSettings().integrationBranch, null);
  assert.equal(withProjectSettingsDefaults(undefined).integrationBranch, null);
  assert.equal(withProjectSettingsDefaults({}).integrationBranch, null);
  assert.equal(withProjectSettingsDefaults({ integrationBranch: '   ' }).integrationBranch, null);
  assert.equal(
    withProjectSettingsDefaults({ integrationBranch: '-leading-dash' }).integrationBranch,
    null,
  );
  // trims + accepts slashes
  assert.equal(
    withProjectSettingsDefaults({ integrationBranch: ' release/2026 ' }).integrationBranch,
    'release/2026',
  );
});

test('INTEGRATION_BRANCH_RE accepts real-world refs and rejects malformed ones', () => {
  for (const ok of ['dev', 'main', 'reporting-rebuild-phase2', 'release/2026.1', 'a.b_c-d']) {
    assert.equal(INTEGRATION_BRANCH_RE.test(ok), true, ok);
  }
  for (const bad of ['-x', '.hidden', '/abs', 'spa ce', '']) {
    assert.equal(INTEGRATION_BRANCH_RE.test(bad), false, bad);
  }
});

test('existing settings keys are unaffected by the new field', () => {
  const out = withProjectSettingsDefaults({
    cancelledVisibility: 'force-hidden',
    remoteControl: 'on',
  });
  assert.deepEqual(out, {
    cancelledVisibility: 'force-hidden',
    remoteControl: 'on',
    integrationBranch: null,
    defaultAccountId: null,
    defaultRuntimeId: null,
    reviewPolicy: 'orchestrator-review',
    autoMergeEligible: false,
  });
});

test('defaultRuntimeId defaults to null, trims, and rejects non-strings', () => {
  assert.equal(defaultProjectSettings().defaultRuntimeId, null);
  assert.equal(withProjectSettingsDefaults(undefined).defaultRuntimeId, null);
  assert.equal(withProjectSettingsDefaults({}).defaultRuntimeId, null);
  assert.equal(
    withProjectSettingsDefaults({ defaultRuntimeId: '  openai-codex  ' }).defaultRuntimeId,
    'openai-codex',
  );
  assert.equal(
    withProjectSettingsDefaults({ defaultRuntimeId: '' }).defaultRuntimeId,
    null,
  );
  assert.equal(
    withProjectSettingsDefaults({ defaultRuntimeId: 7 as unknown as string }).defaultRuntimeId,
    null,
  );

  // round-trip
  const out = withProjectSettingsDefaults({ defaultRuntimeId: 'openai-codex' });
  const again = withProjectSettingsDefaults({ ...out });
  assert.equal(again.defaultRuntimeId, 'openai-codex');
});

// ── WF-2: reviewPolicy / autoMergeEligible ────────────────────────────────

test('reviewPolicy defaults to orchestrator-review and rejects junk', () => {
  assert.equal(defaultProjectSettings().reviewPolicy, 'orchestrator-review');
  assert.equal(withProjectSettingsDefaults(undefined).reviewPolicy, 'orchestrator-review');
  assert.equal(withProjectSettingsDefaults({}).reviewPolicy, 'orchestrator-review');
  assert.equal(
    withProjectSettingsDefaults({ reviewPolicy: 'full-review' }).reviewPolicy,
    'full-review',
  );
  assert.equal(
    withProjectSettingsDefaults({ reviewPolicy: 'bogus' as never }).reviewPolicy,
    'orchestrator-review',
  );

  // round-trip
  const out = withProjectSettingsDefaults({ reviewPolicy: 'full-review' });
  const again = withProjectSettingsDefaults({ ...out });
  assert.equal(again.reviewPolicy, 'full-review');
});

test('autoMergeEligible defaults to false and rejects non-booleans', () => {
  assert.equal(defaultProjectSettings().autoMergeEligible, false);
  assert.equal(withProjectSettingsDefaults(undefined).autoMergeEligible, false);
  assert.equal(withProjectSettingsDefaults({}).autoMergeEligible, false);
  assert.equal(withProjectSettingsDefaults({ autoMergeEligible: true }).autoMergeEligible, true);
  assert.equal(
    withProjectSettingsDefaults({ autoMergeEligible: 'true' as never }).autoMergeEligible,
    false,
  );

  // round-trip
  const out = withProjectSettingsDefaults({ autoMergeEligible: true });
  const again = withProjectSettingsDefaults({ ...out });
  assert.equal(again.autoMergeEligible, true);
});

// ── resolveContractLandingPolicy ──────────────────────────────────────────

const PLAIN_REPO: ExpectedOutput = { kind: 'repo' };
const FULL_REVIEW_SPEC: ExpectedOutput = { kind: 'repo', review: 'full' };
const AUTO_LAND_SPEC: ExpectedOutput = { kind: 'repo', auto_land: true };

test('resolveContractLandingPolicy: project defaults park merge-ready, no guard override', () => {
  const out = resolveContractLandingPolicy(undefined, PLAIN_REPO);
  assert.equal(out.policy, 'default-review');
  assert.equal(out.guardOverride, null);
});

test('resolveContractLandingPolicy: project reviewPolicy full-review escalates a silent spec', () => {
  const out = resolveContractLandingPolicy({ reviewPolicy: 'full-review' }, PLAIN_REPO);
  assert.equal(out.policy, 'full-review');
  assert.equal(out.guardOverride, null);
});

test('resolveContractLandingPolicy: project autoMergeEligible opts a silent spec into auto-merge', () => {
  const out = resolveContractLandingPolicy({ autoMergeEligible: true }, PLAIN_REPO);
  assert.equal(out.policy, 'auto-merge');
  assert.equal(out.guardOverride, null);
});

test('resolveContractLandingPolicy: reviewPolicy full-review wins over autoMergeEligible (stricter, no downgrade)', () => {
  const out = resolveContractLandingPolicy(
    { reviewPolicy: 'full-review', autoMergeEligible: true },
    PLAIN_REPO,
  );
  assert.equal(out.policy, 'full-review');
  assert.equal(out.guardOverride, null, 'escalating to full-review is not a weakened guard');
});

test('resolveContractLandingPolicy: an issuer-authored full-review spec is never downgraded by project defaults', () => {
  const out = resolveContractLandingPolicy(undefined, FULL_REVIEW_SPEC);
  assert.equal(out.policy, 'full-review');
  assert.equal(out.guardOverride, null);
});

test('resolveContractLandingPolicy: project autoMergeEligible cannot weaken an issuer full-review spec — guard wins, logged', () => {
  const out = resolveContractLandingPolicy({ autoMergeEligible: true }, FULL_REVIEW_SPEC);
  assert.equal(out.policy, 'full-review', 'guard wins');
  assert.match(out.guardOverride ?? '', /autoMergeEligible ignored/);
});

test('resolveContractLandingPolicy: an issuer-authored auto_land spec is unaffected by a false project autoMergeEligible', () => {
  const out = resolveContractLandingPolicy({ autoMergeEligible: false }, AUTO_LAND_SPEC);
  assert.equal(out.policy, 'auto-merge');
  assert.equal(out.guardOverride, null);
});

test('resolveContractLandingPolicy: project reviewPolicy full-review still escalates an auto_land spec (stricter wins)', () => {
  const out = resolveContractLandingPolicy({ reviewPolicy: 'full-review' }, AUTO_LAND_SPEC);
  assert.equal(out.policy, 'full-review');
  assert.equal(out.guardOverride, null);
});

test('resolveContractLandingPolicy: non-repo specs always park default-review regardless of project settings', () => {
  const out = resolveContractLandingPolicy(
    { reviewPolicy: 'full-review', autoMergeEligible: true },
    { kind: 'answer' },
  );
  assert.equal(out.policy, 'default-review');
  assert.equal(out.guardOverride, null);
});
