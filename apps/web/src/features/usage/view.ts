// Pure usage-dashboard view logic — no '@/' imports so the guard tests run
// under `tsx --test` (mirrors features/mcp/view.ts). Joins every registered
// runtime+account (GET /api/runtimes) against the durable per-runtime/account
// quota projection (GET /api/subscription-quota + live resource events) so
// the dashboard shows EVERY runtime, not just the actively selected one.

import { subscriptionQuotaKey, type SubscriptionQuotaSnapshot } from '@pc/contracts';
import type { UsageDashboardRow, UsageRuntimeAccountRef } from './types';

/** Joins the registered runtime+account refs against known snapshots. A ref
 *  with no matching snapshot still produces a row (snapshot: null) — visible-
 *  never-hidden, matching the panel's own "not observed yet" rendering. */
export function buildUsageDashboardRows(
  refs: readonly UsageRuntimeAccountRef[],
  snapshots: readonly SubscriptionQuotaSnapshot[],
): UsageDashboardRow[] {
  const byKey = new Map(
    snapshots.map((snapshot) =>
      [subscriptionQuotaKey(snapshot.runtimeId, snapshot.accountId), snapshot] as const),
  );
  return refs
    .map((ref): UsageDashboardRow => ({
      runtimeId: ref.runtimeId,
      runtimeLabel: ref.runtimeLabel,
      accountId: ref.accountId,
      subscriptionQuota: ref.subscriptionQuota,
      snapshot: byKey.get(subscriptionQuotaKey(ref.runtimeId, ref.accountId)) ?? null,
    }))
    .sort((a, b) =>
      a.runtimeLabel.localeCompare(b.runtimeLabel) ||
      a.accountId.localeCompare(b.accountId));
}

/** The adapter's own typed reason quota is unsupported/unavailable for this
 *  account — distinct from a transient per-observation reason (timeout,
 *  stale, account momentarily unreachable). Null when the runtime supports
 *  quota (Claude today) or capability hasn't resolved yet. Never invents a
 *  reason; only surfaces what the adapter actually declared. */
export function capabilityUnavailableCode(row: UsageDashboardRow): string | null {
  const capability = row.subscriptionQuota;
  if (!capability || capability.status === 'supported') return null;
  return capability.code;
}

/** Stable row key for React lists / test assertions — a runtime+account pair
 *  is unique per dashboard render. */
export function usageDashboardRowKey(row: Pick<UsageDashboardRow, 'runtimeId' | 'accountId'>): string {
  return subscriptionQuotaKey(row.runtimeId, row.accountId);
}
