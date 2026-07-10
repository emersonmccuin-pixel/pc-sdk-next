// Guard tests for the two core invariants this shell port establishes.
// Self-contained: no '@/' alias, no React imports (tsx doesn't resolve tsconfig
// paths), so these run under `tsx --test` without extra config.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { TABS, COMMAND_TABS } from '../src/components/tabs-config.ts';
import { useUsageStore } from '../src/state/usage-store.ts';
import type { UsageSnapshot } from '../src/state/usage-store.ts';

// Invariant 1: dead surfaces are removed from the nav (not hidden). A stray
// import/label can't resurrect work-items / workflows / files tabs.
const DEAD_TABS = ['work-items', 'workflows', 'files', 'patterns'];
test('dead tabs are absent from the nav', () => {
  for (const dead of DEAD_TABS) {
    assert.ok(!(TABS as readonly string[]).includes(dead), `TABS still has ${dead}`);
    assert.ok(!(COMMAND_TABS as readonly string[]).includes(dead), `COMMAND_TABS still has ${dead}`);
  }
  assert.deepEqual([...TABS], ['orchestrator', 'agents']);
});

// Invariant 2: usage store is last-write-wins by updatedAt — a stale snapshot
// (re-delivery / out-of-order) never clobbers a fresher one.
function snap(accountId: string, updatedAt: number): UsageSnapshot {
  return { accountId, fiveHour: null, sevenDay: null, status: 'allowed', model: null, updatedAt };
}

test('usage store keeps the newest snapshot per account', () => {
  const { setSnapshot, clear } = useUsageStore.getState();
  clear();
  setSnapshot(snap('personal', 100));
  setSnapshot(snap('personal', 50)); // stale — must be ignored
  assert.equal(useUsageStore.getState().byAccount.personal?.updatedAt, 100);
  setSnapshot(snap('personal', 200)); // fresher — wins
  assert.equal(useUsageStore.getState().byAccount.personal?.updatedAt, 200);
  clear();
});
