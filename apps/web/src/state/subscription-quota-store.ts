// Revisioned browser projection of durable subscription-quota snapshots.

import { create } from 'zustand';
import {
  subscriptionQuotaKey,
  type SubscriptionQuotaSnapshot,
} from '@pc/contracts';

export interface SubscriptionQuotaStore {
  byRuntimeAccount: Record<string, SubscriptionQuotaSnapshot>;
  /** Live full-snapshot writer. Older/equal-conflicting revisions fail closed. */
  setSnapshot: (snapshot: SubscriptionQuotaSnapshot) => void;
  /** HTTP seed merges by revision, so a delayed seed cannot regress live state. */
  primeAll: (snapshots: SubscriptionQuotaSnapshot[]) => void;
  clear: () => void;
}

function mergeSnapshot(
  current: Record<string, SubscriptionQuotaSnapshot>,
  incoming: SubscriptionQuotaSnapshot,
): Record<string, SubscriptionQuotaSnapshot> {
  const key = subscriptionQuotaKey(incoming.runtimeId, incoming.accountId);
  if (Object.entries(current).some(([otherKey, snapshot]) =>
    otherKey !== key && snapshot.id === incoming.id)) return current;
  const prior = current[key];
  if (prior) {
    if (prior.id !== incoming.id || prior.revision > incoming.revision) return current;
    if (prior.revision === incoming.revision) return current;
  }
  return { ...current, [key]: incoming };
}

export const useSubscriptionQuotaStore = create<SubscriptionQuotaStore>((set) => ({
  byRuntimeAccount: {},
  setSnapshot: (snapshot) =>
    set((state) => {
      const merged = mergeSnapshot(state.byRuntimeAccount, snapshot);
      return merged === state.byRuntimeAccount ? state : { byRuntimeAccount: merged };
    }),
  primeAll: (snapshots) =>
    set((state) => {
      let merged = state.byRuntimeAccount;
      for (const snapshot of snapshots) merged = mergeSnapshot(merged, snapshot);
      return merged === state.byRuntimeAccount ? state : { byRuntimeAccount: merged };
    }),
  clear: () => set({ byRuntimeAccount: {} }),
}));

export function useSubscriptionQuotaSnapshot(
  runtimeId: string | null,
  accountId: string | null,
): SubscriptionQuotaSnapshot | null {
  return useSubscriptionQuotaStore((state) =>
    runtimeId && accountId
      ? state.byRuntimeAccount[subscriptionQuotaKey(runtimeId, accountId)] ?? null
      : null);
}

/** Plain selector logic behind `useAllSubscriptionQuotaSnapshots`, kept
 *  separate from the hook so it's testable via `.getState()` directly —
 *  `react-dom/server`'s static render always calls a store hook's
 *  server-snapshot path (bound to *initial* state at `create()` time), so a
 *  rendered-hook test could never observe a later `set()` call. */
export function selectAllSubscriptionQuotaSnapshots(
  state: Pick<SubscriptionQuotaStore, 'byRuntimeAccount'>,
): SubscriptionQuotaSnapshot[] {
  return Object.values(state.byRuntimeAccount);
}

/** Every durably observed snapshot across every runtime+account — the usage
 *  dashboard's join input. Distinct from `useSubscriptionQuotaSnapshot`, which
 *  reads exactly one selection; this generalizes to all of them at once. */
export function useAllSubscriptionQuotaSnapshots(): SubscriptionQuotaSnapshot[] {
  return useSubscriptionQuotaStore(selectAllSubscriptionQuotaSnapshots);
}
