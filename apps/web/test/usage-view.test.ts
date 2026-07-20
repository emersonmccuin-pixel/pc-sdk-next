// Usage-dashboard join logic — every registered runtime+account must appear,
// with or without a durable snapshot, and the adapter's own typed
// unsupported/unavailable reason must never be papered over.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { SubscriptionQuotaSnapshot } from '@pc/contracts';

import {
  buildUsageDashboardRows,
  capabilityUnavailableCode,
  usageDashboardRowKey,
} from '../src/features/usage/view.ts';
import type { UsageRuntimeAccountRef } from '../src/features/usage/types.ts';

function ref(over: Partial<UsageRuntimeAccountRef> = {}): UsageRuntimeAccountRef {
  return {
    runtimeId: 'claude-agent-sdk',
    runtimeLabel: 'Claude',
    accountId: 'personal',
    subscriptionQuota: { status: 'supported', sourceSemantics: ['used'], confidences: ['exact'] },
    ...over,
  };
}

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

test('every registered runtime+account produces a row, even with zero snapshots', () => {
  const codexRef = ref({
    runtimeId: 'openai-codex',
    runtimeLabel: 'Codex',
    accountId: 'chatgpt',
    subscriptionQuota: { status: 'unavailable', code: 'codex-quota-unavailable' },
  });
  const rows = buildUsageDashboardRows([ref(), codexRef], []);
  assert.equal(rows.length, 2);
  assert.ok(rows.every((row) => row.snapshot === null));
  // Never hidden: the Codex row is present with its account id intact.
  assert.ok(rows.some((row) => row.runtimeId === 'openai-codex' && row.accountId === 'chatgpt'));
});

test('a matching snapshot attaches to its exact runtime+account row and no other', () => {
  const claudeRef = ref();
  const codexRef = ref({ runtimeId: 'openai-codex', runtimeLabel: 'Codex', accountId: 'chatgpt' });
  const codexSnapshot = snapshot({
    runtimeId: 'openai-codex',
    accountId: 'chatgpt',
    availability: 'unavailable',
    unavailableReason: 'unsupported',
  });
  const rows = buildUsageDashboardRows([claudeRef, codexRef], [codexSnapshot]);
  const claudeRow = rows.find((r) => r.runtimeId === 'claude-agent-sdk')!;
  const codexRow = rows.find((r) => r.runtimeId === 'openai-codex')!;
  assert.equal(claudeRow.snapshot, null);
  assert.equal(codexRow.snapshot?.unavailableReason, 'unsupported');
});

test('rows sort by runtime label then account id for stable rendering', () => {
  const rows = buildUsageDashboardRows(
    [
      ref({ runtimeId: 'openai-codex', runtimeLabel: 'Codex', accountId: 'b' }),
      ref({ runtimeId: 'claude-agent-sdk', runtimeLabel: 'Claude', accountId: 'b' }),
      ref({ runtimeId: 'claude-agent-sdk', runtimeLabel: 'Claude', accountId: 'a' }),
    ],
    [],
  );
  assert.deepEqual(
    rows.map((r) => `${r.runtimeLabel}:${r.accountId}`),
    ['Claude:a', 'Claude:b', 'Codex:b'],
  );
});

test('capabilityUnavailableCode surfaces the adapter typed reason, honestly, never for a supported runtime', () => {
  const supportedRow = buildUsageDashboardRows([ref()], [])[0]!;
  assert.equal(capabilityUnavailableCode(supportedRow), null);

  const unsupportedRow = buildUsageDashboardRows(
    [ref({
      runtimeId: 'openai-codex',
      runtimeLabel: 'Codex',
      accountId: 'chatgpt',
      subscriptionQuota: { status: 'unavailable', code: 'codex-quota-unavailable' },
    })],
    [],
  )[0]!;
  assert.equal(capabilityUnavailableCode(unsupportedRow), 'codex-quota-unavailable');

  const unresolvedRow = buildUsageDashboardRows(
    [ref({ subscriptionQuota: null })],
    [],
  )[0]!;
  assert.equal(capabilityUnavailableCode(unresolvedRow), null);
});

test('usageDashboardRowKey is unique per runtime+account and stable across rebuilds', () => {
  const rows = buildUsageDashboardRows(
    [ref(), ref({ runtimeId: 'openai-codex', runtimeLabel: 'Codex', accountId: 'chatgpt' })],
    [],
  );
  const keys = rows.map(usageDashboardRowKey);
  assert.equal(new Set(keys).size, 2);
});
