// Bridges the durable `usage` resource entity into the usage-store the header
// meter / caps panel already read (usage-store.ts's setSnapshot/primeAll are
// fully built — this is the missing wire, not a rebuild of the store).
//
// Two paths, both belt-and-suspenders per the contract's replay + epoch
// pattern: the live resource-store overlay (once ws-client applies `usage`
// resource frames — nothing does yet, see resource-store.ts) and an HTTP
// re-prime on mount so a cold load doesn't wait for the next live frame.
//
// LOOSE END: `/api/usage` is an assumed path — apps/server's Phase 2 HTTP
// list (docs/phase-2-plan.md) names "usage re-prime" but not the exact route.
// Degrades silently (empty state) until the server sibling wires it.

import { useEffect } from 'react';
import { getJson } from '@/api/http';
import type { UsageSnapshot } from '@pc/contracts';
import { useResourceStore } from './resource-store';
import { useUsageStore } from './usage-store';

const usageApi = {
  reprime: () => getJson<{ snapshots: UsageSnapshot[] }>('/api/usage').then((r) => r.snapshots),
};

/** Mount once (App level). Not project-scoped — usage is account-scoped. */
export function useUsageResourceSync(): void {
  const byKey = useResourceStore((s) => s.byKey);
  const setSnapshot = useUsageStore((s) => s.setSnapshot);
  const primeAll = useUsageStore((s) => s.primeAll);

  useEffect(() => {
    for (const ev of byKey.values()) {
      if (ev.entity !== 'usage') continue;
      setSnapshot(ev.payload);
    }
  }, [byKey, setSnapshot]);

  useEffect(() => {
    let cancelled = false;
    usageApi
      .reprime()
      .then((snapshots) => {
        if (!cancelled) primeAll(snapshots);
      })
      .catch(() => {
        // Degrade, never block — route not live yet, or transient failure.
      });
    return () => {
      cancelled = true;
    };
  }, [primeAll]);
}
