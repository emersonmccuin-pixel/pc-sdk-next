// The host-safety notice is composed fresh at session mint (never stored),
// so it always reflects the LIVE pid/port of the process the orchestrator
// actually runs inside.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildHostSafetyNotice, composeOrchestratorInstructions } from '../src/agents/host-safety-notice.ts';

test('the notice carries the exact live pid and port passed in', () => {
  const notice = buildHostSafetyNotice(41234, 5124);
  assert.match(notice, /pid 41234/);
  assert.match(notice, /port 5124/);
  assert.match(notice, /PC-SDK-Next-Launch/);
  assert.match(notice, /PC-SDK-Next-Watchdog/);
});

test('a different pid/port produces a different notice (never a cached/static line)', () => {
  const first = buildHostSafetyNotice(111, 4000);
  const second = buildHostSafetyNotice(222, 4001);
  assert.notEqual(first, second);
  assert.match(first, /pid 111/);
  assert.match(first, /port 4000/);
  assert.match(second, /pid 222/);
  assert.match(second, /port 4001/);
});

test('composeOrchestratorInstructions appends the live notice to the stored prompt', () => {
  const composed = composeOrchestratorInstructions('You are the orchestrator.', 999, 5124);
  assert.ok(composed);
  assert.ok(composed!.startsWith('You are the orchestrator.'));
  assert.match(composed!, /pid 999/);
  assert.match(composed!, /port 5124/);
});

test('composeOrchestratorInstructions returns undefined for a missing/blank prompt', () => {
  assert.equal(composeOrchestratorInstructions(undefined, 1, 2), undefined);
  assert.equal(composeOrchestratorInstructions(null, 1, 2), undefined);
  assert.equal(composeOrchestratorInstructions('   ', 1, 2), undefined);
});
