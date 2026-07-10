// Usage store — the seam the header usage meter + rail caps panel read.
//
// SHAPE ONLY here + a stub. A sibling wires the data flow: the `usage` resource
// event (durable, per-account UsageSnapshot) → `setSnapshot`, plus an HTTP
// re-prime on reconnect. Until then every account reads `null` and the UI shows
// its neutral empty state (never a fake number).
//
// UsageSnapshot is the wire type from @pc/contracts — do NOT redeclare it.

import { create } from 'zustand';
import type { UsageSnapshot } from '@pc/contracts';

export type { UsageSnapshot } from '@pc/contracts';

export interface UsageStore {
  /** Latest snapshot per accountId ('personal' | 'work' | …). */
  byAccount: Record<string, UsageSnapshot>;
  /** Durable-channel writer: last-write-wins by `updatedAt`. */
  setSnapshot: (snapshot: UsageSnapshot) => void;
  /** Full re-prime after a reconnect (HTTP heals). Replaces the map wholesale. */
  primeAll: (snapshots: UsageSnapshot[]) => void;
  clear: () => void;
}

export const useUsageStore = create<UsageStore>((set) => ({
  byAccount: {},
  setSnapshot: (snapshot) =>
    set((s) => {
      const prev = s.byAccount[snapshot.accountId];
      if (prev && prev.updatedAt >= snapshot.updatedAt) return s;
      return { byAccount: { ...s.byAccount, [snapshot.accountId]: snapshot } };
    }),
  primeAll: (snapshots) =>
    set(() => ({
      byAccount: Object.fromEntries(snapshots.map((u) => [u.accountId, u] as const)),
    })),
  clear: () => set({ byAccount: {} }),
}));

/** Subscribe to one account's snapshot (or null before the first arrives). */
export function useUsageSnapshot(accountId: string | null): UsageSnapshot | null {
  return useUsageStore((s) => (accountId ? s.byAccount[accountId] ?? null : null));
}
