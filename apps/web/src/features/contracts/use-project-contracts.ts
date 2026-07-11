// Project contracts feed: HTTP seed (contractRoutes.forProject) + resource-
// store live overlay for the `contract` entity — the first consumer of the
// contract resource flow. Pattern mirror of use-project-agent-runs.ts.

import { useEffect, useMemo, useState } from 'react';
import type { Contract, ULID } from '@pc/contracts';

import { useResourceEvents } from '@/state/resource-store';
import { contractsApi } from './client';
import { overlayContracts } from './view';

export function useProjectContracts(projectId: ULID | null): { contracts: Contract[] } {
  const [seeded, setSeeded] = useState<Contract[]>([]);

  useEffect(() => {
    if (!projectId) {
      setSeeded([]);
      return;
    }
    let cancelled = false;
    contractsApi
      .listContracts(projectId)
      .then((contracts) => {
        if (!cancelled) setSeeded(contracts);
      })
      .catch(() => {
        // Degrade, never block.
        if (!cancelled) setSeeded([]);
      });
    return () => {
      cancelled = true;
    };
  }, [projectId]);

  const liveEvents = useResourceEvents('contract', projectId);

  return useMemo(
    () => ({ contracts: overlayContracts(seeded, liveEvents) }),
    [seeded, liveEvents],
  );
}
