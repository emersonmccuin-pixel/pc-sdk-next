// Slide-in transcript panel for a running (or recently-run) agent. Opens from
// ActivityPanel / AgentsList via useAgentTranscript. Backfills prior events
// over HTTP, then layers the live `agent-event` buffer on top, deduped by
// dedupId (features/agent-runs/transcript.ts).
//
// Trimmed from the PC-PTY-Chat original: no PTY liveness diagnostics
// (pid/idle/last-action — there's no PTY), no Cancel/Force-kill (dispatch
// control is Phase 3). Explicit-close only — no Escape, no backdrop click.

import { useEffect, useMemo, useState } from 'react';

import type {
  AgentRunDto,
  Contract,
  ReviewCheckoutDto,
  WorktreePhaseReceiptDto,
} from '@pc/contracts';
import { agentRunsApi, type AgentRunEventEntry, type AgentRunTranscriptStatus } from '@/features/agent-runs/client';
import { useProjectContracts } from '@/features/contracts/use-project-contracts';
import {
  canRequestAbandonment,
  effectivePolicy,
  isLegacyAbandonment,
  isSettledAbandonment,
} from '@/features/contracts/view';
import {
  agentTranscriptEmptyMessage,
  mergeAgentTranscriptEvents,
  type AgentTranscriptLoadStatus,
} from '@/features/agent-runs/transcript';
import { useLiveAgentEvents } from '@/state/agent-event-store';
import { useResourceEvent } from '@/state/resource-store';
import { useAgentTranscript } from '@/store/agent-transcript';
import { isRecoveryTerminalRun } from '@/features/agent-runs/use-project-agent-runs';
import {
  exactStrandedEvidenceForRun,
  exactReviewVerdictEvidence,
  preservationEvidenceMessage,
  sealedEvidenceMessage,
} from '@/features/recovery/view';
import { useRecoveryWorktrees } from '@/features/recovery/use-recovery-worktrees';
import {
  useReviewCheckouts,
  type ReviewCheckoutReadStatus,
} from '@/features/recovery/use-review-checkouts';
import type { StrandedWorktreeDto } from '@/features/worktrees/client';
import { AbandonWorktreeModal } from './AbandonWorktreeModal';
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
  const [showAbandonment, setShowAbandonment] = useState(false);

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

  // Landing receipt lives on the contract. A continuation advances
  // `agentRunId`, so the immutable worktree binding is the fallback when an
  // earlier retained run opens the same contract.
  const { contracts } = useProjectContracts(run.projectId);
  const runContract = useMemo(
    () =>
      contracts.find((c) => c.agentRunId === run.runId) ??
      contracts.find((c) => run.worktreeDir.length > 0 && c.worktreePath === run.worktreeDir) ??
      null,
    [contracts, run.runId, run.worktreeDir],
  );
  const reviewCheckoutRead = useReviewCheckouts(run.projectId, true);
  const reviewCheckout = useMemo(
    () => reviewCheckoutRead.reviewCheckouts.find(
      (checkout) => checkout.reviewerRunId === run.runId,
    ) ?? null,
    [reviewCheckoutRead.reviewCheckouts, run.runId],
  );
  const targetContract = useMemo(
    () => reviewCheckout
      ? contracts.find((candidate) => candidate.id === reviewCheckout.contractId) ?? null
      : null,
    [contracts, reviewCheckout],
  );
  const reviewerContract = reviewCheckout ? runContract : null;
  const contract = targetContract ?? runContract;
  const isReviewRun = reviewCheckout !== null || run.agentName === 'contract-reviewer';
  const recoveryWorktrees = useRecoveryWorktrees(run.projectId, true);
  const recoveryWorktree = useMemo(
    () => exactStrandedEvidenceForRun(
      run,
      contract,
      recoveryWorktrees.status === 'ready' ? recoveryWorktrees.worktrees : [],
    ),
    [run, contract, recoveryWorktrees.status, recoveryWorktrees.worktrees],
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

          <div className="mt-1.5 truncate font-mono text-[10px] text-muted-foreground/80" title={run.runId}>
            run: {run.runId}
          </div>
          <div className="truncate font-mono text-[10px] text-muted-foreground/80">
            runtime: {formatRunSelection(run)}
          </div>
          <div className="truncate font-mono text-[10px] text-muted-foreground/80">
            specialist: {run.specialistRevision ?? 'legacy unavailable'} · {run.continuationState}
            {' · '}native id {run.nativeSessionIdPresent
              ? 'bound'
              : run.continuationState === 'legacy-unavailable'
                ? 'legacy unavailable'
                : 'unbound'}
          </div>
          <div className="truncate font-mono text-[10px] text-muted-foreground/80" title={run.worktreeDir}>
            cwd: {run.worktreeDir}
          </div>
          {run.status === 'failed' && run.failureReason && (
            <div className="mt-1 text-[11px] text-destructive">{run.failureReason}</div>
          )}
          {isRecoveryTerminalRun(run, contract?.landingStatus ?? null) && !isReviewRun && (
            <RunRecoveryDetails
              run={run}
              contract={contract}
              worktree={recoveryWorktree}
              worktreeReadUnavailable={recoveryWorktrees.status !== 'ready'}
              onRetryWorktreeRead={recoveryWorktrees.retry}
            />
          )}
          {isReviewRun && (
            <ReviewCheckoutDetails
              run={run}
              checkout={reviewCheckout}
              readStatus={reviewCheckoutRead.status}
              readError={reviewCheckoutRead.error}
              onRetry={reviewCheckoutRead.retry}
              reviewerContract={reviewerContract}
            />
          )}
          <PhaseReceiptDetails
            phase="preparation"
            applicable={isReviewRun || run.lifecycleState !== null || contract?.expectedOutput?.kind === 'repo'}
            receipt={isReviewRun
              ? reviewCheckout?.preparationReceipt ?? null
              : run.preparationReceipt ?? null}
          />
          <PhaseReceiptDetails
            phase="readiness"
            applicable={isReviewRun || run.lifecycleState !== null || contract?.expectedOutput?.kind === 'repo'}
            receipt={isReviewRun
              ? reviewCheckout?.readinessReceipt ?? null
              : run.readinessReceipt ?? null}
          />
          <LandingReceiptDetails contract={contract} />
          {!nonTerminal && contract && canRequestAbandonment(contract) && (
            <button
              type="button"
              onClick={() => setShowAbandonment(true)}
              className="mt-1 border border-destructive/40 bg-destructive/10 px-2 py-1 text-[10px] font-medium uppercase tracking-wider text-destructive hover:bg-destructive/20"
            >
              Abandon worktree…
            </button>
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
      {showAbandonment && contract && (
        <AbandonWorktreeModal
          projectId={contract.projectId}
          contractId={contract.id}
          onClose={() => setShowAbandonment(false)}
        />
      )}
    </div>
  );
}

export function ReviewCheckoutDetails({
  run,
  checkout,
  readStatus,
  readError,
  onRetry,
  reviewerContract,
}: {
  run: AgentRunDto;
  checkout: ReviewCheckoutDto | null;
  readStatus: ReviewCheckoutReadStatus;
  readError: string | null;
  onRetry?: () => void;
  reviewerContract: Contract | null;
}) {
  if (readStatus === 'loading' && !checkout) {
    return (
      <div className="mt-1 border border-border/60 bg-card/40 px-2 py-1 text-[10px] uppercase tracking-wider text-muted-foreground">
        review checkout evidence · loading
      </div>
    );
  }
  if (readStatus === 'error' && !checkout) {
    return (
      <div className="mt-1 flex items-center justify-between gap-2 border border-destructive/30 bg-destructive/5 px-2 py-1 text-[11px] text-destructive">
        <span title={readError ?? undefined}>Review checkout evidence unavailable.</span>
        {onRetry && (
          <button
            type="button"
            onClick={onRetry}
            className="shrink-0 border border-border bg-card px-2 py-0.5 text-[10px] text-foreground hover:bg-muted"
          >
            Retry
          </button>
        )}
      </div>
    );
  }
  if (!checkout) {
    return (
      <div className="mt-1 border border-destructive/30 bg-destructive/5 px-2 py-1 text-[10px] uppercase tracking-wider text-destructive">
        review checkout authority unavailable
      </div>
    );
  }

  const verdict = exactReviewVerdictEvidence(reviewerContract);
  const summary = checkout.status === 'destroyed'
    ? 'cleanup settled'
    : checkout.status === 'teardown-pending'
      ? 'cleanup pending'
      : checkout.status === 'provisioned'
        ? 'provisioned'
        : 'authority reserved';
  const summaryClass = checkout.status === 'destroyed'
    ? 'text-primary'
    : checkout.status === 'teardown-pending'
      ? 'text-destructive'
      : 'text-warning';
  const provision = checkout.provisionReceipt;
  const teardown = checkout.teardownReceipt;
  const verdictLabel = verdict
    ? `${verdict.verdict} · ${verdict.findingCount} finding${verdict.findingCount === 1 ? '' : 's'}`
    : NON_TERMINAL.has(run.status)
      ? 'pending'
      : 'typed verdict unavailable or void';

  return (
    <details className="mt-1 border border-border/60 bg-card/40 px-2 py-1" open>
      <summary className="cursor-pointer select-none text-[10px] uppercase tracking-wider text-muted-foreground">
        review checkout · <span className={summaryClass}>{summary}</span>
      </summary>
      <dl className="mt-1 space-y-0.5 font-mono text-[10px]">
        <ReceiptRow label="workspace" value={checkout.id} />
        <ReceiptRow label="target" value={`${checkout.contractId} · v${checkout.contractVersion}`} />
        <ReceiptRow label="sealed commit" value={checkout.sealedCommit} />
        <ReceiptRow label="path" value={checkout.worktreePath} />
        <ReceiptRow
          label="provision"
          value={provision
            ? `exact registration · detached HEAD ${provision.headSha} · clean`
            : checkout.status === 'reserved' ? 'pending' : 'unavailable'}
        />
        <ReceiptRow label="verdict" value={verdictLabel} />
        <ReceiptRow
          label="decision gate"
          value={checkout.status === 'destroyed'
            ? 'positive cleanup settled'
            : 'blocked until positive cleanup settlement'}
        />
        {teardown && (
          <ReceiptRow
            label="teardown"
            value={`directory absent · registration absent · ${new Date(teardown.finishedAt).toLocaleString()}`}
          />
        )}
      </dl>
      {checkout.cleanupError && (
        <div className="mt-1 whitespace-pre-wrap text-[11px] text-destructive">
          Cleanup unavailable: {checkout.cleanupError}
        </div>
      )}
      {readStatus === 'error' && (
        <div className="mt-1 flex items-center justify-between gap-2 text-[11px] text-destructive">
          <span title={readError ?? undefined}>Refresh unavailable; showing the last positive workspace evidence.</span>
          {onRetry && (
            <button
              type="button"
              onClick={onRetry}
              className="shrink-0 border border-border bg-card px-2 py-0.5 text-[10px] text-foreground hover:bg-muted"
            >
              Retry
            </button>
          )}
        </div>
      )}
    </details>
  );
}

export function RunRecoveryDetails({
  run,
  contract,
  worktree,
  worktreeReadUnavailable = false,
  onRetryWorktreeRead,
}: {
  run: AgentRunDto;
  contract: Contract | null;
  worktree: StrandedWorktreeDto | null;
  worktreeReadUnavailable?: boolean;
  onRetryWorktreeRead?: () => void;
}) {
  const sealed = sealedEvidenceMessage(contract);
  return (
    <details className="mt-1 border border-destructive/30 bg-destructive/5 px-2 py-1" open>
      <summary className="cursor-pointer select-none text-[10px] uppercase tracking-wider text-destructive">
        recovery evidence
      </summary>
      <dl className="mt-1 space-y-0.5 font-mono text-[10px]">
        <ReceiptRow label="failure cause" value={run.failureCause ?? 'unavailable'} />
        <ReceiptRow label="lifecycle" value={run.lifecycleState ?? 'unavailable'} />
      </dl>
      {sealed && <div className="mt-1 text-[11px] text-muted-foreground">{sealed}</div>}
      {worktreeReadUnavailable ? (
        <div className="mt-1 flex items-center justify-between gap-2 text-[11px] text-destructive">
          <span>Worktree recovery status unavailable; preservation is not proven.</span>
          {onRetryWorktreeRead && (
            <button
              type="button"
              onClick={onRetryWorktreeRead}
              className="shrink-0 border border-border bg-card px-2 py-0.5 text-[10px] text-foreground hover:bg-muted"
            >
              Retry
            </button>
          )}
        </div>
      ) : (
        <div className="mt-1 text-[11px] text-muted-foreground">
          {preservationEvidenceMessage(worktree)}
        </div>
      )}
    </details>
  );
}

/** Collapsed preparation/readiness receipt summary — per-step command + exit
 *  + duration, with the bounded output tails one more click in. */
export function PhaseReceiptDetails({
  phase,
  applicable,
  receipt,
}: {
  phase: WorktreePhaseReceiptDto['phase'];
  applicable: boolean;
  receipt: WorktreePhaseReceiptDto | null;
}) {
  if (!applicable) return null;
  if (!receipt) {
    return (
      <div className="mt-1 border border-border/60 bg-card/40 px-2 py-1 text-[10px] uppercase tracking-wider text-muted-foreground">
        {phase} · <span className="text-destructive">unavailable</span>
      </div>
    );
  }
  const noOp = receipt.outcome === 'not-required';
  const noOpLabel = noOp
    ? receipt.reason === 'existing-worktree-preparation'
      ? `existing worktree reused from parent ${receipt.inheritedFromRunId.slice(0, 8)}`
      : 'no commands configured'
    : null;
  return (
    <details className="mt-1 border border-border/60 bg-card/40 px-2 py-1">
      <summary className="cursor-pointer select-none text-[10px] uppercase tracking-wider text-muted-foreground">
        {receipt.phase} ·{' '}
        {noOp ? (
          <span className="text-primary">not required · {noOpLabel}</span>
        ) : (
          <>
            <span className={receipt.ok ? 'text-primary' : 'text-destructive'}>
              {receipt.ok ? 'ok' : 'failed'}
            </span>{' '}
            · {receipt.steps.length} step{receipt.steps.length === 1 ? '' : 's'}
          </>
        )}
      </summary>
      {receipt.outcome === 'executed' && (
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
      )}
    </details>
  );
}

/** Landing receipt (docs/worktree-lifecycle.md 'Merge receipt') — target
 *  before/after, merge sha, authorizer, policy. Renders once landing state or
 *  a merge-ready park exists on the run's contract. */
export function LandingReceiptDetails({ contract }: { contract: Contract | null }) {
  if (!contract) return null;
  // Repo-only: null landing status means 'not applicable' for every other
  // kind (a passed answer/payload run is NOT parked merge-ready) — same
  // guard as mergeReadyContracts in features/contracts/view.ts.
  const parked =
    contract.expectedOutput?.kind === 'repo' &&
    contract.verificationStatus === 'passed' &&
    contract.landingStatus === null;
  if (contract.landingStatus === null && !parked) return null;
  if (
    contract.landingStatus === 'abandoning' ||
    contract.landingStatus === 'abandoned'
  ) {
    return <AbandonmentReceiptDetails contract={contract} />;
  }
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

export function AbandonmentReceiptDetails({ contract }: { contract: Contract }) {
  const authority = contract.abandonmentReceipt;
  const settlement = contract.abandonmentTeardownReceipt;
  const legacy = isLegacyAbandonment(contract);
  const settled = isSettledAbandonment(contract);
  const summary = legacy
    ? 'authority unavailable'
    : settled
      ? 'settled · branch retained'
      : 'approval recorded · cleanup pending';
  const summaryClass = legacy || contract.abandonmentError
    ? 'text-destructive'
    : settled
      ? 'text-primary'
      : 'text-warning';

  return (
    <details className="mt-1 border border-border/60 bg-card/40 px-2 py-1">
      <summary className="cursor-pointer select-none text-[10px] uppercase tracking-wider text-muted-foreground">
        abandonment · <span className={summaryClass}>{summary}</span>
      </summary>
      {legacy ? (
        <div className="mt-1 text-[11px] text-destructive">
          This legacy status has no explicit user approval receipt. The branch and worktree remain preserved;
          automatic cleanup is not authorized.
        </div>
      ) : authority ? (
        <div className="mt-1 space-y-1 text-[11px]">
          <dl className="space-y-0.5 font-mono text-[10px]">
            <ReceiptRow label="approved by" value="user · browser" />
            <ReceiptRow label="approved at" value={new Date(authority.approvedAt).toLocaleString()} />
            <ReceiptRow label="branch" value={authority.branch} />
            <ReceiptRow label="branch tip" value={authority.branchTip} />
            <ReceiptRow label="integration" value={authority.integrationState === 'unmerged' ? 'not integrated' : 'no exclusive commits'} />
            <ReceiptRow
              label="contents"
              value={`${authority.worktreeState.status} · ${authority.worktreeState.staged} staged · ${authority.worktreeState.unstaged} unstaged · ${authority.worktreeState.untracked} untracked`}
            />
            <ReceiptRow
              label="worktree"
              value={settlement ? 'removed' : 'cleanup pending'}
            />
            <ReceiptRow
              label="branch proof"
              value={settlement ? `retained @ ${settlement.observedBranchTip}` : 'pending'}
            />
            {settlement && (
              <ReceiptRow label="settled at" value={new Date(settlement.finishedAt).toLocaleString()} />
            )}
          </dl>
          <div className="text-muted-foreground">
            This action did not merge the branch. Ignored worktree contents were uninspected before removal.
          </div>
          {authority.reason && (
            <div className="whitespace-pre-wrap text-muted-foreground">Reason: {authority.reason}</div>
          )}
          {contract.abandonmentError && (
            <div className="text-destructive">{contract.abandonmentError}</div>
          )}
        </div>
      ) : (
        <div className="mt-1 text-[11px] text-destructive">Abandonment evidence is unavailable.</div>
      )}
    </details>
  );
}

function ReceiptRow({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex gap-2">
      <dt className="w-24 shrink-0 text-muted-foreground/80">{label}</dt>
      <dd className="min-w-0 flex-1 break-all text-foreground" title={value}>{value}</dd>
    </div>
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

function formatRunSelection(run: AgentRunDto): string {
  if (!run.selection) return 'legacy unavailable';
  const effort = run.selection.effort.kind === 'selected'
    ? run.selection.effort.value
    : run.selection.effort.kind;
  return `${run.selection.runtimeId} / ${run.selection.accountId} / ${run.selection.model} / effort ${effort}`;
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
