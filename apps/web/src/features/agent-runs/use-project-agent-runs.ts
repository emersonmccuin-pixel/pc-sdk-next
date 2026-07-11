// Running-agents feed: HTTP seed + resource-store live overlay for the
// `agent-run` entity. The store already resolves to one latest-by-version
// frame per runId, so the overlay pass below is a single walk, not a version
// comparison — resource-store did that part already.
//
// Terminal rows drop out EXCEPT preserved lifecycle states (merge-ready,
// conflict, stranded, review-rejected, failed — docs/worktree-lifecycle.md
// 'Teardown and retention'): those stay in `preserved` until resolved, so the
// ActivityPanel sections and transcript click-through can reach them.

import { useEffect, useMemo, useState } from 'react';
import {
  isAgentRunChangedLivePayload,
  isPreservedLifecycleState,
  type AgentRunDto,
} from '@pc/contracts';

import type { Project } from '@/features/projects/client';
import { agentRunsApi } from './client';
import { useResourceEvents } from '@/state/resource-store';

const TERMINAL = new Set<AgentRunDto['status']>(['completed', 'failed', 'cancelled']);

export interface AgentRunView extends AgentRunDto {
  /** T2.2 — non-terminal watchdog warn, badge-only, derived from the latest
   *  live frame's `reason`. Never present on the HTTP seed. */
  stalled: boolean;
}

/** True when the run should stay in the feed despite a terminal status. */
function keepRun(run: AgentRunDto): boolean {
  return !TERMINAL.has(run.status) || isPreservedLifecycleState(run.lifecycleState);
}

export function useProjectAgentRuns(project: Project | null): {
  /** Non-terminal (running/queued/paused) runs. */
  runs: AgentRunView[];
  /** Terminal runs parked in a preserved lifecycle state — visible until resolved. */
  preserved: AgentRunView[];
} {
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
        for (const r of runs) if (keepRun(r)) map.set(r.runId, r);
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
      if (!keepRun(run)) {
        map.delete(run.runId);
        continue;
      }
      map.set(run.runId, run);
      if (reason === 'stalled') stalledIds.add(run.runId);
    }
    const all: AgentRunView[] = [...map.values()]
      .map((r) => ({ ...r, stalled: stalledIds.has(r.runId) }))
      .sort((a, b) => a.startedAt - b.startedAt);
    return {
      runs: all.filter((r) => !TERMINAL.has(r.status)),
      preserved: all.filter((r) => TERMINAL.has(r.status)),
    };
  }, [seeded, liveEvents]);
}
