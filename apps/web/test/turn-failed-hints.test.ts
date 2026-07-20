// Guard tests for the turn-failed hint mapping — every code the mapping knows
// about, unknown codes, and messages without a code at all.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { extractTurnFailedCode, turnFailedHint } from '../src/features/chat/turn-failed-hints.ts';

test('extracts the trailing parenthesized code, or null when absent', () => {
  assert.equal(extractTurnFailedCode('runtime failed to start (session-mint-unavailable)'), 'session-mint-unavailable');
  assert.equal(extractTurnFailedCode('runtime delivery failed (account-unavailable)'), 'account-unavailable');
  assert.equal(extractTurnFailedCode('runtime failed to start'), null);
  assert.equal(extractTurnFailedCode('runtime stream failed'), null);
  // A code must trail the message — not appear mid-sentence.
  assert.equal(extractTurnFailedCode('(session-mint-unavailable) leading'), null);
});

test('known codes each resolve to their documented actionable hint', () => {
  assert.equal(
    turnFailedHint('runtime failed to start (account-unavailable)'),
    "Check the runtime's login (and its subscription quota) on this machine.",
  );
  assert.equal(
    turnFailedHint('runtime failed to start (account-auth-or-runtime-unavailable)'),
    "Check the runtime's login (and its subscription quota) on this machine.",
  );
  for (const code of ['session-mint-unavailable', 'thread-start-failed', 'runtime-turn-failed']) {
    assert.equal(
      turnFailedHint(`runtime failed to start (${code})`),
      'The provider refused to start or run the session — often quota exhaustion or an expired login. Try again later or re-login.',
    );
  }
  assert.equal(
    turnFailedHint('runtime failed to start (model-unsupported)'),
    "The selected model isn't available on this runtime — pick another in settings.",
  );
  assert.equal(
    turnFailedHint('runtime failed to start (repository-unavailable)'),
    "The project folder's repository is locked or missing.",
  );
});

test('unknown codes and code-less messages carry no hint', () => {
  assert.equal(turnFailedHint('runtime failed to start (some-future-code)'), null);
  assert.equal(turnFailedHint('runtime failed to start'), null);
  assert.equal(turnFailedHint('runtime stream failed'), null);
  assert.equal(turnFailedHint('runtime ended without a durable terminal'), null);
});
