// Slide-in transcript panel for a running (or recently-run) agent. Opens from
// ActivityPanel / AgentsList via useAgentTranscript. Backfills prior events
// over HTTP, then layers the live `agent-event` buffer on top, deduped by
// dedupId (features/agent-runs/transcript.ts).
//
// Trimmed from the PC-PTY-Chat original: no PTY liveness diagnostics
// (pid/idle/last-action — there's no PTY), no Cancel/Force-kill (dispatch
// control is Phase 3). Explicit-close only — no Escape, no backdrop click.

import { useEffect, useMemo, useState } from 'react';

import type { AgentRunDto } from '@pc/contracts';
import { agentRunsApi, type AgentRunEventEntry, type AgentRunTranscriptStatus } from '@/features/agent-runs/client';
import {
  agentTranscriptEmptyMessage,
  mergeAgentTranscriptEvents,
  type AgentTranscriptLoadStatus,
} from '@/features/agent-runs/transcript';
import { useLiveAgentEvents } from '@/state/agent-event-store';
import { useResourceEvent } from '@/state/resource-store';
import { useAgentTranscript } from '@/store/agent-transcript';
import { RichAgentTranscript } from './RichAgentTranscript';

interface AgentTranscriptModalProps {
  run: AgentRunDto;
  onClose: () => void;
}

const NON_TERMINAL = new Set<AgentRunDto['status']>(['queued', 'spawning', 'running', 'paused']);

export function AgentTranscriptModal({ run: initialRun, onClose }: AgentTranscriptModalProps) {
  // Prefer the live resource-store snapshot (current status) over the
  // opener's prop, which may be stale by the time the modal renders.
  const liveResource = useResourceEvent('agent-run', initialRun.runId);
  const run =
    liveResource && liveResource.entity === 'agent-run' ? liveResource.payload.run : initialRun;

  const [backfill, setBackfill] = useState<{
    status: AgentTranscriptLoadStatus;
    transcriptStatus: AgentRunTranscriptStatus | null;
    events: AgentRunEventEntry[];
    error: string | null;
  }>({ status: 'loading', transcriptStatus: null, events: [], error: null });

  useEffect(() => {
    let cancelled = false;
    setBackfill({ status: 'loading', transcriptStatus: null, events: [], error: null });
    agentRunsApi
      .getAgentRunEvents(run.projectId, run.runId)
      .then((res) => {
        if (cancelled) return;
        setBackfill({
          status: 'ready',
          transcriptStatus: res.transcriptStatus,
          events: res.events,
          error: null,
        });
      })
      .catch((err: unknown) => {
        if (cancelled) return;
        setBackfill({
          status: 'error',
          transcriptStatus: null,
          events: [],
          error: err instanceof Error ? err.message : String(err),
        });
      });
    return () => {
      cancelled = true;
    };
  }, [run.projectId, run.runId]);

  const liveEvents = useLiveAgentEvents(run.runId);

  const items = useMemo(
    () =>
      mergeAgentTranscriptEvents({
        runId: run.runId,
        backfillEvents: backfill.events,
        liveEvents,
      }),
    [backfill.events, liveEvents, run.runId],
  );

  const nonTerminal = NON_TERMINAL.has(run.status);
  const statusPillClasses =
    run.status === 'paused'
      ? 'bg-warning/25 text-warning'
      : run.status === 'spawning' || run.status === 'queued'
        ? 'bg-muted text-muted-foreground'
        : run.status === 'failed'
          ? 'bg-destructive/20 text-destructive'
          : 'bg-primary/20 text-primary';

  return (
    <div className="fixed inset-0 z-50 flex" role="dialog" aria-modal aria-label="Agent transcript">
      <div className="flex-1 bg-black/40" aria-hidden="true" />
      <aside className="flex h-full w-full max-w-6xl flex-col border-l border-border bg-card shadow-2xl">
        <header className="shrink-0 border-b border-border bg-muted/30 px-4 py-3">
          <div className="flex items-start justify-between gap-3">
            <div className="min-w-0">
              <div className="text-[10px] uppercase tracking-wider text-muted-foreground">Agent</div>
              <div className="flex items-center gap-2">
                <span className="truncate text-sm font-semibold text-foreground">{run.agentName}</span>
                <span className={`shrink-0 px-1.5 py-0.5 text-[10px] uppercase tracking-wider ${statusPillClasses}`}>
                  {run.status}
                </span>
              </div>
            </div>
            <button
              type="button"
              onClick={onClose}
              aria-label="Close transcript"
              className="shrink-0 border border-border bg-card px-2 py-1 text-xs font-medium hover:bg-muted"
            >
              ✕ Close
            </button>
          </div>

          <div className="mt-1.5 truncate font-mono text-[10px] text-muted-foreground/80" title={run.sessionId}>
            session: {run.sessionId}
          </div>
          <div className="truncate font-mono text-[10px] text-muted-foreground/80" title={run.worktreeDir}>
            cwd: {run.worktreeDir}
          </div>
          {run.status === 'failed' && run.failureReason && (
            <div className="mt-1 text-[11px] text-destructive">{run.failureReason}</div>
          )}
        </header>

        <div className="flex min-h-0 flex-1 flex-col">
          <RichAgentTranscript
            items={items}
            emptyState={
              <span className={nonTerminal ? 'animate-pulse' : ''}>
                {agentTranscriptEmptyMessage({
                  loadStatus: backfill.status,
                  transcriptStatus: backfill.transcriptStatus,
                  runStatus: run.status,
                })}
              </span>
            }
          />
          {backfill.status === 'error' && (
            <div className="shrink-0 border-t border-border px-4 py-2 text-xs text-destructive">
              Backfill unavailable: {backfill.error}
            </div>
          )}
        </div>
      </aside>
    </div>
  );
}

/** Always-mounted Shell-level instance, driven by useAgentTranscript. Renders
 *  nothing when no run is open. Resolves the run from the live resource store
 *  by runId, falling back to the opener's preloaded snapshot. */
export function AgentTranscriptModalMount() {
  const runId = useAgentTranscript((s) => s.runId);
  const preloadedRun = useAgentTranscript((s) => s.preloadedRun);
  const close = useAgentTranscript((s) => s.close);
  const liveResource = useResourceEvent('agent-run', runId);
  const run =
    liveResource && liveResource.entity === 'agent-run' ? liveResource.payload.run : preloadedRun;

  if (!runId || !run) return null;
  return <AgentTranscriptModal run={run} onClose={close} />;
}
