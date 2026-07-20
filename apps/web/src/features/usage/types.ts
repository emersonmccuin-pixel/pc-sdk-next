// Usage-dashboard join shapes. Decoupled from the runtimes/quota zustand
// stores (mirrors features/mcp/types.ts) so the pure view logic in view.ts
// stays testable without '@/' aliases or store side effects.

import type { SubscriptionQuotaCapability, SubscriptionQuotaSnapshot } from '@pc/contracts';

/** One registered runtime+account pair from GET /api/runtimes. The dashboard
 *  must always list every one of these, even before a quota snapshot exists —
 *  a runtime is never hidden for lack of an observation. */
export interface UsageRuntimeAccountRef {
  runtimeId: string;
  runtimeLabel: string;
  accountId: string;
  /** Adapter-declared capability truth; null only before the registry has
   *  resolved (first paint). Distinct from a per-observation reason — this is
   *  the runtime's own permanent-or-not stance on quota support. */
  subscriptionQuota: SubscriptionQuotaCapability | null;
}

/** One dashboard row: identity + capability truth + the durable current-state
 *  snapshot (or null when none has been recorded yet). */
export interface UsageDashboardRow {
  runtimeId: string;
  runtimeLabel: string;
  accountId: string;
  subscriptionQuota: SubscriptionQuotaCapability | null;
  snapshot: SubscriptionQuotaSnapshot | null;
}
