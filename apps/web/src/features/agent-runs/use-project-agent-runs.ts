// Running-agents feed: HTTP seed + resource-store live overlay for the
// `agent-run` entity. The store already resolves to one latest-by-version
// frame per runId. HTTP is re-seeded on every socket epoch; overlay still
// compares revisions because a retained pre-reconnect live frame may be older
// than the newly fetched durable row.
//
// Terminal rows drop out EXCEPT preserved lifecycle states (merge-ready,
// conflict, stranded, review-rejected, failed — docs/worktree-lifecycle.md
// 'Teardown and retention'): those stay in `preserved` until resolved, so the
// ActivityPanel sections and transcript click-through can reach them.

import { useEffect, useMemo, useState } from 'react';
import {
  isAgentRunChangedLivePayload,
  isPreservedLifecycleState,
  type AgentRunChangedLivePayload,
  type AgentRunDto,
} from '@pc/contracts';

import type { Project } from '@/features/projects/client';
import { agentRunsApi } from './client';
import { useResourceEvents } from '@/state/resource-store';
import { useConnectionStore } from '@/state/connection';

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

export function overlayAgentRunPayloads(
  seeded: Iterable<AgentRunDto>,
  payloads: Iterable<AgentRunChangedLivePayload>,
): { runs: AgentRunView[]; preserved: AgentRunView[] } {
  const map = new Map<string, AgentRunDto>();
  // Keep every HTTP row as revision evidence, including non-preserved terminal
  // rows. Those terminal rows are tombstones: dropping them here would let a
  // retained pre-reconnect `running` resource resurrect a run that HTTP has
  // already proved terminal.
  for (const run of seeded) map.set(run.runId, run);
  const stalledIds = new Set<string>();
  for (const { run, reason } of payloads) {
    const current = map.get(run.runId);
    if (current && current.rev > run.rev) continue;
    if (!keepRun(run)) {
      // Retain the terminal revision as a tombstone for any later stale payload
      // in this overlay pass. Presentation filtering happens below.
      map.set(run.runId, run);
      stalledIds.delete(run.runId);
      continue;
    }
    map.set(run.runId, run);
    if (reason === 'stalled') stalledIds.add(run.runId);
    else stalledIds.delete(run.runId);
  }
  const all: AgentRunView[] = [...map.values()]
    .filter(keepRun)
    .map((run) => ({ ...run, stalled: stalledIds.has(run.runId) }))
    .sort((a, b) => a.startedAt - b.startedAt);
  return {
    runs: all.filter((run) => !TERMINAL.has(run.status)),
    preserved: all.filter((run) => TERMINAL.has(run.status)),
  };
}

export function useProjectAgentRuns(project: Project | null): {
  /** Non-terminal (running/queued/paused) runs. */
  runs: AgentRunView[];
  /** Terminal runs parked in a preserved lifecycle state — visible until resolved. */
  preserved: AgentRunView[];
} {
  const [seeded, setSeeded] = useState<Map<string, AgentRunDto>>(new Map());
  const connectionEpoch = useConnectionStore((state) => state.epoch);

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
        for (const r of runs) map.set(r.runId, r);
        setSeeded(map);
      })
      .catch(() => {
        // Degrade, never block — no backend route yet, or a transient error.
        if (!cancelled) setSeeded(new Map());
      });
    return () => {
      cancelled = true;
    };
  }, [project?.id, connectionEpoch]);

  const liveEvents = useResourceEvents('agent-run', project?.id ?? null);

  return useMemo(() => {
    const payloads: AgentRunChangedLivePayload[] = [];
    for (const ev of liveEvents) {
      if (!isAgentRunChangedLivePayload(ev.payload)) continue;
      payloads.push(ev.payload);
    }
    return overlayAgentRunPayloads(seeded.values(), payloads);
  }, [seeded, liveEvents]);
}
