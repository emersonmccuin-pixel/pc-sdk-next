// AccountSwitcher's footer copy — conditional-continuity wording (Phase 2).
// The server decides whether a switch hands off or starts clean; the UI
// never brands the outcome by provider or asserts one path unconditionally.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { accountSwitcherFooterCopy } from '../src/components/AccountSwitcher.tsx';

test('accountSwitcherFooterCopy states continuity is conditional, never unconditional loss', () => {
  const copy = accountSwitcherFooterCopy('project-1');
  assert.match(copy, /new session/);
  // Must not claim continuity is impossible — the server may hand off.
  assert.doesNotMatch(copy, /^Switching starts a new session\.$/);
  assert.match(copy, /continuing.*when possible/i);
});

test('accountSwitcherFooterCopy prompts project selection when there is no project', () => {
  assert.equal(accountSwitcherFooterCopy(null), 'Select a project to switch account.');
});
