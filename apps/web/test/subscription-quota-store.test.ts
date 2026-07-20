// Generalized store selector — the usage dashboard needs every runtime+
// account snapshot at once, not just the actively selected pair.
//
// Exercised via `.getState()` + the plain selector function, not a rendered
// hook: `react-dom/server`'s static render always resolves a zustand hook
// through its server-snapshot path (bound to *initial* state at `create()`
// time), so a component-render test could never observe a later `set()`
// call — confirmed by direct probe, not assumption.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { SubscriptionQuotaSnapshot } from '@pc/contracts';

import {
  selectAllSubscriptionQuotaSnapshots,
  useSubscriptionQuotaStore,
} from '../src/state/subscription-quota-store.ts';

function snapshot(over: Partial<SubscriptionQuotaSnapshot> = {}): SubscriptionQuotaSnapshot {
  return {
    id: '01KXAV20000000000000000001',
    runtimeId: 'claude-agent-sdk',
    accountId: 'personal',
    revision: 1,
    availability: 'available',
    unavailableReason: null,
    observedAt: Date.now(),
    observations: [],
    ...over,
  };
}

test('the generalized selector surfaces every registered runtime+account, not just one selection', () => {
  useSubscriptionQuotaStore.getState().clear();
  const claude = snapshot();
  const codex = snapshot({
    id: '01KXAV20000000000000000002',
    runtimeId: 'openai-codex',
    accountId: 'chatgpt',
    availability: 'unavailable',
    unavailableReason: 'unsupported',
  });
  useSubscriptionQuotaStore.getState().setSnapshot(claude);
  useSubscriptionQuotaStore.getState().setSnapshot(codex);

  const all = selectAllSubscriptionQuotaSnapshots(useSubscriptionQuotaStore.getState());
  assert.equal(all.length, 2);
  assert.ok(all.some((s) => s.runtimeId === 'claude-agent-sdk' && s.availability === 'available'));
  assert.ok(all.some((s) => s.runtimeId === 'openai-codex' && s.unavailableReason === 'unsupported'));

  useSubscriptionQuotaStore.getState().clear();
});

test('an empty store selects an empty list, never a stale prior snapshot', () => {
  useSubscriptionQuotaStore.getState().clear();
  assert.deepEqual(selectAllSubscriptionQuotaSnapshots(useSubscriptionQuotaStore.getState()), []);
});

test('clearing the store empties the generalized selector output too', () => {
  useSubscriptionQuotaStore.getState().setSnapshot(snapshot());
  assert.equal(selectAllSubscriptionQuotaSnapshots(useSubscriptionQuotaStore.getState()).length, 1);
  useSubscriptionQuotaStore.getState().clear();
  assert.equal(selectAllSubscriptionQuotaSnapshots(useSubscriptionQuotaStore.getState()).length, 0);
});

test('a stale-revision write never regresses the generalized selector (mirrors single-selection semantics)', () => {
  useSubscriptionQuotaStore.getState().clear();
  useSubscriptionQuotaStore.getState().setSnapshot(snapshot({ revision: 2 }));
  useSubscriptionQuotaStore.getState().setSnapshot(snapshot({ revision: 1 }));
  const all = selectAllSubscriptionQuotaSnapshots(useSubscriptionQuotaStore.getState());
  assert.equal(all.length, 1);
  assert.equal(all[0]!.revision, 2);
  useSubscriptionQuotaStore.getState().clear();
});
