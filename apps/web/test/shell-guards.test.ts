// Guard tests for the two core invariants this shell port establishes.
// Self-contained: no '@/' alias, no React imports (tsx doesn't resolve tsconfig
// paths), so these run under `tsx --test` without extra config.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  subscriptionQuotaKey,
  type SubscriptionQuotaSnapshot,
} from '@pc/contracts';

import { TABS, COMMAND_TABS } from '../src/components/tabs-config.ts';
import { useAccounts } from '../src/state/accounts.ts';
import { useSubscriptionQuotaStore } from '../src/state/subscription-quota-store.ts';

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

function quotaSnapshot(input: {
  id: string;
  runtimeId: string;
  accountId?: string;
  revision: number;
  usedFraction?: number;
}): SubscriptionQuotaSnapshot {
  const usedFraction = input.usedFraction ?? 0.4;
  return {
    id: input.id,
    runtimeId: input.runtimeId,
    accountId: input.accountId ?? 'personal',
    revision: input.revision,
    availability: 'available',
    unavailableReason: null,
    observedAt: 1_000,
    observations: [{
      window: { id: 'five-hour', label: '5 hours', durationMs: 18_000_000 },
      scope: { kind: 'account' },
      source: { semantics: 'used', fraction: usedFraction },
      usedFraction,
      confidence: 'exact',
      limitState: 'allowed',
      resetsAt: 2_000,
      observedAt: 1_000,
      staleAt: 2_000,
    }],
  };
}

test('subscription quota store isolates the same account id under peer runtimes', () => {
  const { setSnapshot, clear } = useSubscriptionQuotaStore.getState();
  clear();
  const runtimeA = quotaSnapshot({
    id: '01KXAV10000000000000000001', runtimeId: 'runtime-a', revision: 1,
  });
  const runtimeB = quotaSnapshot({
    id: '01KXAV10000000000000000002', runtimeId: 'runtime-b', revision: 1,
    usedFraction: 0.8,
  });
  setSnapshot(runtimeA);
  setSnapshot(runtimeB);
  const state = useSubscriptionQuotaStore.getState().byRuntimeAccount;
  assert.equal(Object.keys(state).length, 2);
  assert.strictEqual(state[subscriptionQuotaKey('runtime-a', 'personal')], runtimeA);
  assert.strictEqual(state[subscriptionQuotaKey('runtime-b', 'personal')], runtimeB);
  clear();
});

test('subscription quota HTTP seeds cannot regress live revision and equal conflicts fail closed', () => {
  const { setSnapshot, primeAll, clear } = useSubscriptionQuotaStore.getState();
  clear();
  const live = quotaSnapshot({
    id: '01KXAV10000000000000000003', runtimeId: 'runtime-a', revision: 3,
    usedFraction: 0.6,
  });
  setSnapshot(live);
  primeAll([quotaSnapshot({
    id: live.id, runtimeId: live.runtimeId, revision: 2, usedFraction: 0.2,
  })]);
  const key = subscriptionQuotaKey(live.runtimeId, live.accountId);
  assert.strictEqual(useSubscriptionQuotaStore.getState().byRuntimeAccount[key], live);

  const equalConflict = quotaSnapshot({
    id: live.id, runtimeId: live.runtimeId, revision: live.revision, usedFraction: 0.9,
  });
  setSnapshot(equalConflict);
  primeAll([equalConflict]);
  assert.strictEqual(
    useSubscriptionQuotaStore.getState().byRuntimeAccount[key],
    live,
    'same revision cannot rewrite already accepted quota truth',
  );

  const newerHttp = quotaSnapshot({
    id: live.id, runtimeId: live.runtimeId, revision: 4, usedFraction: 0.7,
  });
  primeAll([newerHttp]);
  assert.strictEqual(useSubscriptionQuotaStore.getState().byRuntimeAccount[key], newerHttp);
  clear();
});

test('subscription quota store rejects one durable id aliased to another runtime account', () => {
  useSubscriptionQuotaStore.getState().clear();
  const first = quotaSnapshot({
    id: 'quota-alias-id', runtimeId: 'runtime-a', accountId: 'personal', revision: 1,
  });
  useSubscriptionQuotaStore.getState().setSnapshot(first);
  useSubscriptionQuotaStore.getState().setSnapshot({
    ...quotaSnapshot({
      id: 'quota-other-id', runtimeId: 'runtime-b', accountId: 'work', revision: 2,
    }),
    id: first.id,
  });
  assert.equal(Object.keys(useSubscriptionQuotaStore.getState().byRuntimeAccount).length, 1);
  assert.ok(useSubscriptionQuotaStore.getState().byRuntimeAccount[
    subscriptionQuotaKey('runtime-a', 'personal')
  ]);
});

test('subscription quota bridge uses strict HTTP admission and re-primes on websocket epoch', () => {
  const bridgeSource = readFileSync(
    new URL('../src/state/subscription-quota-bridge.ts', import.meta.url),
    'utf8',
  );
  assert.match(bridgeSource, /isSubscriptionQuotaListResponse\(value\)/);
  assert.match(bridgeSource, /useConnectionStore\(\(state\) => state\.epoch\)/);
  assert.match(bridgeSource, /useConnectionStore\.getState\(\)\.epoch === connectionEpoch/);
  assert.match(bridgeSource, /\[connectionEpoch, primeAll\]/);
  assert.match(bridgeSource, /\/api\/subscription-quota/);
  assert.doesNotMatch(bridgeSource, /fiveHour|sevenDay|fable|UsageSnapshot/);
});

test('project binding marks account attribution unresolved until successor evidence arrives', () => {
  const accounts = useAccounts.getState();
  accounts.bindProject(null);
  accounts.select('personal');
  accounts.bindProject('project-successor');
  assert.equal(useAccounts.getState().selectionResolved, false);
  assert.equal(useAccounts.getState().activeSession, null);
  useAccounts.getState().bindProject(null);
});

test('failed project-account reads stay explicit and a retry restores exact attribution', async () => {
  const originalFetch = globalThis.fetch;
  try {
    globalThis.fetch = (async () => new Response('{}', { status: 500 })) as typeof fetch;
    await useAccounts.getState().loadForProject('project-account-retry');
    assert.equal(useAccounts.getState().selectionResolved, false);
    assert.equal(useAccounts.getState().status, 'error');
    assert.match(useAccounts.getState().error ?? '', /Retry or reconnect/);

    globalThis.fetch = (async () => new Response(JSON.stringify({ accountId: 'work' }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    })) as typeof fetch;
    await useAccounts.getState().loadForProject('project-account-retry');
    assert.equal(useAccounts.getState().selectionResolved, true);
    assert.equal(useAccounts.getState().selectedId, 'work');
    assert.equal(useAccounts.getState().status, 'idle');
    assert.equal(useAccounts.getState().error, null);
  } finally {
    globalThis.fetch = originalFetch;
    useAccounts.getState().bindProject(null);
  }
});

test('account control retries unresolved selection on websocket recovery', () => {
  const source = readFileSync(
    new URL('../src/components/AccountSwitcher.tsx', import.meta.url),
    'utf8',
  );
  assert.match(source, /useConnectionStore\(\(s\) => s\.epoch\)/);
  assert.match(source, /\[projectId, connectionEpoch, bindProject, loadForProject\]/);
  assert.match(source, /Retry account/);
});

test('project transitions blank singleton chat state before paint and remount the composer', () => {
  const socketSource = readFileSync(
    new URL('../src/lib/ws-client.ts', import.meta.url),
    'utf8',
  );
  const surfaceSource = readFileSync(
    new URL('../src/features/chat/ChatSurface.tsx', import.meta.url),
    'utf8',
  );
  assert.match(socketSource, /useLayoutEffect\(\(\) => \{/);
  const reset = socketSource.indexOf('useChatStore.getState().reset();');
  const connect = socketSource.indexOf('const socket = new ProjectSocket(projectId);', reset);
  assert.ok(reset >= 0 && connect > reset, 'chat state resets before the successor socket starts');
  assert.match(socketSource, /resetProjectState\(\)/);
  assert.match(surfaceSource, /<ChatComposer\s+key=\{project\.id\}/);
});
