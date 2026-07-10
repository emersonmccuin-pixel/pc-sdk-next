// Running-agents feed: HTTP seed (excludes terminal rows, per contract) +
// resource-store live overlay for the `agent-run` entity. The store already
// resolves to one latest-by-version frame per runId, so the overlay pass
// below is a single walk, not a version comparison — resource-store did that
// part already.

import { useEffect, useMemo, useState } from 'react';
import { isAgentRunChangedLivePayload, type AgentRunDto } from '@pc/contracts';

import type { Project } from '@/features/projects/client';
import { agentRunsApi } from './client';
import { useResourceEvents } from '@/state/resource-store';

const TERMINAL = new Set<AgentRunDto['status']>(['completed', 'failed', 'cancelled']);

export interface AgentRunView extends AgentRunDto {
  /** T2.2 — non-terminal watchdog warn, badge-only, derived from the latest
   *  live frame's `reason`. Never present on the HTTP seed. */
  stalled: boolean;
}

export function useProjectAgentRuns(project: Project | null): { runs: AgentRunView[] } {
  const [seeded, setSeeded] = useState<Map<string, AgentRunDto>>(new Map());

  useEffect(() => {
    if (!project) {
      setSeeded(new Map());
      return;
    }
    let cancelled = false;
    agentRunsApi
      .listAgentRuns(project.id)
      .then((runs) => {
        if (cancelled) return;
        const map = new Map<string, AgentRunDto>();
        for (const r of runs) if (!TERMINAL.has(r.status)) map.set(r.runId, r);
        setSeeded(map);
      })
      .catch(() => {
        // Degrade, never block — no backend route yet, or a transient error.
        if (!cancelled) setSeeded(new Map());
      });
    return () => {
      cancelled = true;
    };
  }, [project?.id]);

  const liveEvents = useResourceEvents('agent-run', project?.id ?? null);

  return useMemo(() => {
    const map = new Map(seeded);
    const stalledIds = new Set<string>();
    for (const ev of liveEvents) {
      if (!isAgentRunChangedLivePayload(ev.payload)) continue;
      const { run, reason } = ev.payload;
      if (TERMINAL.has(run.status)) {
        map.delete(run.runId);
        continue;
      }
      map.set(run.runId, run);
      if (reason === 'stalled') stalledIds.add(run.runId);
    }
    const runs: AgentRunView[] = [...map.values()]
      .map((r) => ({ ...r, stalled: stalledIds.has(r.runId) }))
      .sort((a, b) => a.startedAt - b.startedAt);
    return { runs };
  }, [seeded, liveEvents]);
}
