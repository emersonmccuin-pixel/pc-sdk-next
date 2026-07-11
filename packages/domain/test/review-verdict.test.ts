// Full-review vocabulary guards: effectiveLandingPolicy precedence (review
// 'full' wins over auto_land; column wins over both) and the strict verdict
// parser — no usable verdict is treated like a crashed review by callers, so
// leniency here would fake verdicts.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  effectiveLandingPolicy,
  parseReviewVerdictPayload,
  reviewVerdictExpectedOutput,
  REVIEW_VERDICT_SCHEMA,
} from '../src/contract.ts';

test('effectiveLandingPolicy: review full wins over auto_land; the stamped column wins over the spec', () => {
  assert.equal(effectiveLandingPolicy(null, { kind: 'repo', review: 'full' }), 'full-review');
  assert.equal(effectiveLandingPolicy(null, { kind: 'repo', review: 'full', auto_land: true }), 'full-review');
  assert.equal(effectiveLandingPolicy(null, { kind: 'repo', auto_land: true }), 'auto-merge');
  assert.equal(effectiveLandingPolicy(null, { kind: 'repo' }), 'default-review');
  assert.equal(effectiveLandingPolicy(null, { kind: 'answer' }), 'default-review');
  assert.equal(effectiveLandingPolicy('default-review', { kind: 'repo', review: 'full' }), 'default-review');
});

test('reviewVerdictExpectedOutput is the payload verdict spec', () => {
  const spec = reviewVerdictExpectedOutput();
  assert.equal(spec.kind, 'payload');
  assert.equal(spec.semantic, 'verdict');
  assert.deepEqual(spec.schema, REVIEW_VERDICT_SCHEMA);
});

test('parseReviewVerdictPayload: accepts well-formed verdicts', () => {
  assert.deepEqual(parseReviewVerdictPayload({ verdict: 'approve', findings: [] }), {
    verdict: 'approve',
    findings: [],
  });
  const rejected = parseReviewVerdictPayload({
    verdict: 'reject',
    findings: [{ file: 'a.ts', line: 3, summary: 'wrong', severity: 'critical' }],
  });
  assert.deepEqual(rejected, {
    verdict: 'reject',
    findings: [{ file: 'a.ts', line: 3, summary: 'wrong', severity: 'critical' }],
  });
});

test('parseReviewVerdictPayload: strict — anything malformed is null, never a fake verdict', () => {
  assert.equal(parseReviewVerdictPayload(null), null);
  assert.equal(parseReviewVerdictPayload('approve'), null);
  assert.equal(parseReviewVerdictPayload({ verdict: 'ship it', findings: [] }), null);
  assert.equal(parseReviewVerdictPayload({ verdict: 'approve' }), null); // findings missing
  assert.equal(parseReviewVerdictPayload({ verdict: 'approve', findings: 'none' }), null);
  assert.equal(
    parseReviewVerdictPayload({ verdict: 'reject', findings: [{ summary: 'no file', severity: 'major' }] }),
    null,
  );
  assert.equal(
    parseReviewVerdictPayload({ verdict: 'reject', findings: [{ file: 'a.ts', summary: 'x', severity: 'blocker' }] }),
    null,
  );
});
