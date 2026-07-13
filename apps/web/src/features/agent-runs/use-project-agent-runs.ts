// Running-agents feed: HTTP seed + resource-store live overlay for the
// `agent-run` entity. The store already resolves to one latest-by-version
// frame per runId. HTTP is re-seeded on every socket epoch; overlay still
// compares revisions because a retained pre-reconnect live frame may be older
// than the newly fetched durable row.
//
// Terminal success rows drop out. Server-retained unresolved rows and bounded
// recent failed/cancelled outcomes stay in `preserved`, so Activity can render
// recovery truth and contract sections can still open their transcript.

import { useCallback, useEffect, useMemo, useState } from 'react';
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

/** True when a terminal row is actionable recovery truth. The server bounds
 * ordinary recent rows and retains exact unresolved worktree owners; the
 * browser must preserve every failed/cancelled row it is given without trying
 * to reproduce that retention query. */
function isRetainedTerminalRun(run: AgentRunDto): boolean {
  return TERMINAL.has(run.status) && (
    // Successful independent reviewers remain a bounded recent transcript
    // door for their append-only review-checkout settlement evidence. The
    // server still owns the 24h bound; ordinary successful runs stay hidden.
    (run.agentName === 'contract-reviewer' && run.status === 'completed') ||
    run.status === 'failed' ||
    run.status === 'cancelled' ||
    isPreservedLifecycleState(run.lifecycleState) ||
    run.lifecycleState === 'merging' ||
    run.lifecycleState === 'merged' ||
    run.lifecycleState === 'tearing-down' ||
    run.lifecycleState === 'provisioning-failed' ||
    run.lifecycleState === 'verification-failed' ||
    run.lifecycleState === 'cancelled'
  );
}

export function isRecoveryTerminalRun(
  run: AgentRunDto,
  contractLandingStatus: string | null = null,
): boolean {
  if (run.agentName === 'contract-reviewer' && run.status === 'completed') return false;
  return isRetainedTerminalRun(run) && (
    run.lifecycleState !== 'merge-ready' || contractLandingStatus === 'landed'
  );
}

export function overlayAgentRunPayloads(
  seeded: Iterable<AgentRunDto>,
  payloads: Iterable<AgentRunChangedLivePayload & { resourceCursor?: string }>,
  authoritativeCursor: string | null = null,
): { runs: AgentRunView[]; preserved: AgentRunView[] } {
  const map = new Map<string, AgentRunDto>();
  // Keep every HTTP row as revision evidence, including non-preserved terminal
  // rows. Those terminal rows are tombstones: dropping them here would let a
  // retained pre-reconnect `running` resource resurrect a run that HTTP has
  // already proved terminal.
  for (const run of seeded) map.set(run.runId, run);
  const stalledIds = new Set<string>();
  for (const { run, reason, resourceCursor } of payloads) {
    const current = map.get(run.runId);
    if (
      !current &&
      authoritativeCursor !== null &&
      resourceCursor !== undefined &&
      cursorAtOrBefore(resourceCursor, authoritativeCursor)
    ) {
      // A successful HTTP seed is authoritative for active and terminal
      // retention as of its server outbox high-water. Any older resource it
      // omitted was positively resolved or aged out and cannot resurrect.
      continue;
    }
    if (current && current.rev > run.rev) continue;
    if (
      current &&
      current.rev === run.rev &&
      TERMINAL.has(current.status) &&
      !TERMINAL.has(run.status)
    ) {
      // Same-revision activity can legitimately refine presentation (for
      // example `stalled`) while a run is live, but can never resurrect a
      // terminal durable seed after reconnect.
      continue;
    }
    map.set(run.runId, run);
    if (TERMINAL.has(run.status)) stalledIds.delete(run.runId);
    else if (reason === 'stalled') stalledIds.add(run.runId);
    else stalledIds.delete(run.runId);
  }
  const all: AgentRunView[] = [...map.values()]
    .map((run) => ({ ...run, stalled: stalledIds.has(run.runId) }))
    .sort((a, b) => a.startedAt - b.startedAt);
  return {
    runs: all.filter((run) => !TERMINAL.has(run.status)),
    preserved: all.filter(isRetainedTerminalRun),
  };
}

function cursorAtOrBefore(cursor: string, highWater: string): boolean {
  if (!/^(?:0|[1-9][0-9]*)$/u.test(cursor) || !/^(?:0|[1-9][0-9]*)$/u.test(highWater)) {
    return false;
  }
  return BigInt(cursor) <= BigInt(highWater);
}

export type AgentRunReadStatus = 'idle' | 'loading' | 'ready' | 'error';

interface AgentRunSeedState {
  projectId: string | null;
  runs: Map<string, AgentRunDto>;
  authoritativeCursor: string | null;
  status: AgentRunReadStatus;
  error: string | null;
}

export function useProjectAgentRuns(project: Project | null): {
  /** Non-terminal (running/queued/paused) runs. */
  runs: AgentRunView[];
  /** Server-retained unresolved rows plus bounded recent failed/cancelled rows. */
  preserved: AgentRunView[];
  readStatus: AgentRunReadStatus;
  readError: string | null;
  retry: () => void;
} {
  const [seed, setSeed] = useState<AgentRunSeedState>({
    projectId: null,
    runs: new Map(),
    authoritativeCursor: null,
    status: 'idle',
    error: null,
  });
  const [retryNonce, setRetryNonce] = useState(0);
  const connectionEpoch = useConnectionStore((state) => state.epoch);
  const retry = useCallback(() => setRetryNonce((value) => value + 1), []);

  useEffect(() => {
    if (!project) {
      setSeed({ projectId: null, runs: new Map(), authoritativeCursor: null, status: 'idle', error: null });
      return;
    }
    const projectId = project.id;
    let cancelled = false;
    setSeed((current) => ({
      projectId,
      runs: current.projectId === projectId ? current.runs : new Map(),
      authoritativeCursor: current.projectId === projectId ? current.authoritativeCursor : null,
      status: 'loading',
      error: null,
    }));
    agentRunsApi
      .listAgentRuns(projectId)
      .then(({ runs, asOfCursor }) => {
        if (cancelled) return;
        const map = new Map<string, AgentRunDto>();
        for (const r of runs) map.set(r.runId, r);
        setSeed({ projectId, runs: map, authoritativeCursor: asOfCursor, status: 'ready', error: null });
      })
      .catch((error: unknown) => {
        if (cancelled) return;
        setSeed((current) => ({
          projectId,
          runs: current.projectId === projectId ? current.runs : new Map(),
          authoritativeCursor: current.projectId === projectId ? current.authoritativeCursor : null,
          status: 'error',
          error: error instanceof Error ? error.message : String(error),
        }));
      });
    return () => {
      cancelled = true;
    };
  }, [project?.id, connectionEpoch, retryNonce]);

  const liveEvents = useResourceEvents('agent-run', project?.id ?? null);

  return useMemo(() => {
    const payloads: Array<AgentRunChangedLivePayload & { resourceCursor: string }> = [];
    for (const ev of liveEvents) {
      if (!isAgentRunChangedLivePayload(ev.payload)) continue;
      payloads.push({ ...ev.payload, resourceCursor: ev.cursor });
    }
    return {
      ...overlayAgentRunPayloads(seed.runs.values(), payloads, seed.authoritativeCursor),
      readStatus: seed.status,
      readError: seed.error,
      retry,
    };
  }, [seed, liveEvents, retry]);
}
