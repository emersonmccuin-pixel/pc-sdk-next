// Cold/reconnect seed for the global subscription-quota projection. Live
// updates flow directly from the guarded websocket resource frame.

import { useEffect } from 'react';
import {
  isSubscriptionQuotaListResponse,
  type SubscriptionQuotaSnapshot,
} from '@pc/contracts';

import { getJson } from '@/api/http';
import { useConnectionStore } from './connection';
import { useSubscriptionQuotaStore } from './subscription-quota-store';

async function fetchSubscriptionQuota(): Promise<SubscriptionQuotaSnapshot[]> {
  const value: unknown = await getJson<unknown>('/api/subscription-quota');
  if (!isSubscriptionQuotaListResponse(value)) {
    throw new Error('invalid subscription quota response');
  }
  return value.snapshots;
}

export function useSubscriptionQuotaResourceSync(): void {
  const connectionEpoch = useConnectionStore((state) => state.epoch);
  const primeAll = useSubscriptionQuotaStore((state) => state.primeAll);

  useEffect(() => {
    let cancelled = false;
    void fetchSubscriptionQuota()
      .then((snapshots) => {
        if (
          !cancelled &&
          useConnectionStore.getState().epoch === connectionEpoch
        ) primeAll(snapshots);
      })
      .catch(() => {
        // Explicit stale/unavailable rendering owns degradation; never block UI.
      });
    return () => {
      cancelled = true;
    };
  }, [connectionEpoch, primeAll]);
}
