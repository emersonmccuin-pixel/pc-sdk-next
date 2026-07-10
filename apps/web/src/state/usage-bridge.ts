// Cold-load prime for the usage caps panel: GET /api/usage on mount fills the
// usage-store before the first live frame. Live updates need no bridge —
// ws-client routes `usage` resource frames straight into the usage-store.

import { useEffect } from 'react';
import { getJson } from '@/api/http';
import type { UsageSnapshot } from '@pc/contracts';
import { useUsageStore } from './usage-store';

const usageApi = {
  reprime: () => getJson<{ snapshots: UsageSnapshot[] }>('/api/usage').then((r) => r.snapshots),
};

/** Mount once (App level). Not project-scoped — usage is account-scoped. */
export function useUsageResourceSync(): void {
  const primeAll = useUsageStore((s) => s.primeAll);

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
