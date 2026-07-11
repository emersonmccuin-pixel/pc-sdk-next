// Slide-in transcript panel for a running (or recently-run) agent. Opens from
// ActivityPanel / AgentsList via useAgentTranscript. Backfills prior events
// over HTTP, then layers the live `agent-event` buffer on top, deduped by
// dedupId (features/agent-runs/transcript.ts).
//
// Trimmed from the PC-PTY-Chat original: no PTY liveness diagnostics
// (pid/idle/last-action — there's no PTY), no Cancel/Force-kill (dispatch
// control is Phase 3). Explicit-close only — no Escape, no backdrop click.

import { useEffect, useMemo, useState } from 'react';

import type { AgentRunDto, Contract, WorktreePhaseReceiptDto } from '@pc/contracts';
import { agentRunsApi, type AgentRunEventEntry, type AgentRunTranscriptStatus } from '@/features/agent-runs/client';
import { useProjectContracts } from '@/features/contracts/use-project-contracts';
import { effectivePolicy } from '@/features/contracts/view';
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

  // Landing receipt lives on the contract; find this run's (newest-first, so
  // `find` picks the latest if a run somehow produced several).
  const { contracts } = useProjectContracts(run.projectId);
  const contract = useMemo(
    () => contracts.find((c) => c.agentRunId === run.runId) ?? null,
    [contracts, run.runId],
  );

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
                {run.lifecycleState && (
                  <span
                    title="Worktree pipeline state (docs/worktree-lifecycle.md)"
                    className="shrink-0 border border-border px-1.5 py-0.5 font-mono text-[10px] uppercase tracking-wider text-muted-foreground"
                  >
                    {run.lifecycleState}
                  </span>
                )}
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
          <PhaseReceiptDetails receipt={run.preparationReceipt ?? null} />
          <PhaseReceiptDetails receipt={run.readinessReceipt ?? null} />
          <LandingReceiptDetails contract={contract} />
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

/** Collapsed preparation/readiness receipt summary — per-step command + exit
 *  + duration, with the bounded output tails one more click in. */
function PhaseReceiptDetails({ receipt }: { receipt: WorktreePhaseReceiptDto | null }) {
  if (!receipt) return null;
  return (
    <details className="mt-1 border border-border/60 bg-card/40 px-2 py-1">
      <summary className="cursor-pointer select-none text-[10px] uppercase tracking-wider text-muted-foreground">
        {receipt.phase} ·{' '}
        <span className={receipt.ok ? 'text-primary' : 'text-destructive'}>
          {receipt.ok ? 'ok' : 'failed'}
        </span>{' '}
        · {receipt.steps.length} step{receipt.steps.length === 1 ? '' : 's'}
      </summary>
      <ul className="mt-1 max-h-48 space-y-1 overflow-y-auto">
        {receipt.steps.map((step, i) => (
          <li key={i} className="font-mono text-[10px]">
            <div className="flex items-baseline justify-between gap-2">
              <span className="min-w-0 flex-1 truncate text-foreground" title={step.command}>
                {step.command}
              </span>
              <span
                className={`shrink-0 ${step.exitCode === 0 && !step.timedOut ? 'text-muted-foreground' : 'text-destructive'}`}
              >
                {step.timedOut ? 'timeout' : `exit ${step.exitCode}`} · {formatDuration(step.durationMs)}
              </span>
            </div>
            {(step.stdoutTail || step.stderrTail) && (
              <details className="ml-2">
                <summary className="cursor-pointer select-none text-muted-foreground/80">output tail</summary>
                {step.stdoutTail && (
                  <pre className="mt-0.5 max-h-32 overflow-auto whitespace-pre-wrap border-l border-border pl-2 text-muted-foreground">
                    {step.stdoutTail}
                  </pre>
                )}
                {step.stderrTail && (
                  <pre className="mt-0.5 max-h-32 overflow-auto whitespace-pre-wrap border-l border-destructive/40 pl-2 text-destructive/90">
                    {step.stderrTail}
                  </pre>
                )}
              </details>
            )}
          </li>
        ))}
      </ul>
    </details>
  );
}

/** Landing receipt (docs/worktree-lifecycle.md 'Merge receipt') — target
 *  before/after, merge sha, authorizer, policy. Renders once landing state or
 *  a merge-ready park exists on the run's contract. */
function LandingReceiptDetails({ contract }: { contract: Contract | null }) {
  if (!contract) return null;
  // Repo-only: null landing status means 'not applicable' for every other
  // kind (a passed answer/payload run is NOT parked merge-ready) — same
  // guard as mergeReadyContracts in features/contracts/view.ts.
  const parked =
    contract.expectedOutput?.kind === 'repo' &&
    contract.verificationStatus === 'passed' &&
    contract.landingStatus === null;
  if (contract.landingStatus === null && !parked) return null;
  const rows: [string, string | null][] = [
    ['status', contract.landingStatus ?? 'merge-ready (awaiting review)'],
    ['policy', effectivePolicy(contract)],
    ['authorizer', contract.landingAuthorizer],
    ['target', contract.landedBranch],
    [
      'target sha',
      contract.targetShaBefore || contract.targetShaAfter
        ? `${shortSha(contract.targetShaBefore)} → ${shortSha(contract.targetShaAfter)}`
        : null,
    ],
    ['merge sha', shortSha(contract.mergeSha)],
    ['branch tip', shortSha(contract.landedSha)],
    ['verified base', shortSha(contract.verifiedBaseSha)],
    ['landed at', contract.landedAt ? new Date(contract.landedAt).toLocaleString() : null],
  ];
  return (
    <details className="mt-1 border border-border/60 bg-card/40 px-2 py-1">
      <summary className="cursor-pointer select-none text-[10px] uppercase tracking-wider text-muted-foreground">
        landing ·{' '}
        <span
          className={
            contract.landingStatus === 'landed'
              ? 'text-primary'
              : contract.landingStatus === null
                ? 'text-muted-foreground'
                : 'text-destructive'
          }
        >
          {contract.landingStatus ?? 'merge-ready'}
        </span>
      </summary>
      <dl className="mt-1 space-y-0.5 font-mono text-[10px]">
        {rows
          .filter((r): r is [string, string] => r[1] !== null)
          .map(([label, value]) => (
            <div key={label} className="flex gap-2">
              <dt className="w-24 shrink-0 text-muted-foreground/80">{label}</dt>
              <dd className="min-w-0 flex-1 truncate text-foreground" title={value}>
                {value}
              </dd>
            </div>
          ))}
      </dl>
      {contract.landingError && (
        <div className="mt-1 text-[11px] text-destructive">{contract.landingError}</div>
      )}
      {contract.verificationNotes && (
        <div className="mt-1 whitespace-pre-wrap text-[11px] text-muted-foreground">
          {contract.verificationNotes}
        </div>
      )}
    </details>
  );
}

function shortSha(sha: string | null): string | null {
  return sha ? sha.slice(0, 10) : null;
}

function formatDuration(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) return '—';
  if (ms < 1000) return `${ms}ms`;
  return `${(ms / 1000).toFixed(1)}s`;
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
