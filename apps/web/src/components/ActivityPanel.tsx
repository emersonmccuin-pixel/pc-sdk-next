// Right-rail activity panel — running agents + worktree-lifecycle surfacing
// (docs/worktree-lifecycle.md): merge-ready contracts awaiting review,
// conflicted/failed landings, and recovery-required runs/worktrees. The old
// workflow-run/inbox entities remain intentionally absent; recovery composes
// current agent-run, contract, and worktree read models instead.
//
// 36px collapsed gutter is owned by the Shell (panel sizing); this renders
// the gutter's contents and the expanded body.

import { useEffect, useMemo, useState } from 'react';

import type { Contract, ReviewCheckoutDto, ULID } from '@pc/contracts';
import type { Project } from '@/features/projects/client';
import type {
  AgentRunReadStatus,
  AgentRunView,
} from '@/features/agent-runs/use-project-agent-runs';
import { agentRunsApi } from '@/features/agent-runs/client';
import { useProjectContracts } from '@/features/contracts/use-project-contracts';
import {
  canRequestAbandonment,
  effectivePolicy,
  landingIssueDetail,
  landingIssueLabel,
  landingIssueContracts,
  mergeReadyContracts,
} from '@/features/contracts/view';
import {
  buildRecoveryProjection,
  reviewVerdictPresentation,
  isDismissibleRecoveryRun,
  preservationEvidenceMessage,
  reviewCheckoutsRequiringAttention,
  recoveryRunGuidance,
  recoveryRunLabel,
  sealedEvidenceMessage,
  type RecoveryProjection,
} from '@/features/recovery/view';
import {
  useRecoveryWorktrees,
  type RecoveryWorktreeReadStatus,
} from '@/features/recovery/use-recovery-worktrees';
import {
  useReviewCheckouts,
  type ReviewCheckoutReadStatus,
} from '@/features/recovery/use-review-checkouts';
import { useProjectActivity } from '@/state/activity-store';
import { useAgentTranscript } from '@/store/agent-transcript';
import { AbandonWorktreeModal } from './AbandonWorktreeModal';

interface ActivityPanelProps {
  project: Project | null;
  expanded: boolean;
  onExpand: () => void;
}

export function ActivityPanel({ project, expanded, onExpand }: ActivityPanelProps) {
  const [nowMs, setNowMs] = useState(() => Date.now());
  const [abandonContractId, setAbandonContractId] = useState<ULID | null>(null);
  const [dismissingRunId, setDismissingRunId] = useState<ULID | null>(null);
  const [dismissError, setDismissError] = useState<{ runId: ULID; message: string } | null>(null);
  useEffect(() => {
    const id = setInterval(() => setNowMs(Date.now()), 5000);
    return () => clearInterval(id);
  }, []);

  const {
    runningCount,
    runs,
    preserved,
    runReadStatus,
    runReadError,
    retryRunRead,
  } = useProjectActivity(project);

  const handleDismiss = async (runId: ULID) => {
    if (!project) return;
    setDismissingRunId(runId);
    setDismissError(null);
    try {
      await agentRunsApi.dismissRun(project.id, runId);
      retryRunRead();
    } catch (cause) {
      setDismissError({ runId, message: cause instanceof Error ? cause.message : String(cause) });
    } finally {
      setDismissingRunId(null);
    }
  };
  const { contracts } = useProjectContracts(project?.id ?? null);
  const strandedRead = useRecoveryWorktrees(project?.id ?? null, project !== null);
  const reviewCheckoutRead = useReviewCheckouts(project?.id ?? null, project !== null);
  const openTranscript = useAgentTranscript((s) => s.open);

  const mergeReady = useMemo(() => mergeReadyContracts(contracts), [contracts]);
  const landingIssues = useMemo(() => landingIssueContracts(contracts), [contracts]);
  const reviewCleanup = useMemo(
    () => reviewCheckoutsRequiringAttention(reviewCheckoutRead.reviewCheckouts),
    [reviewCheckoutRead.reviewCheckouts],
  );
  const settledReviewCheckouts = useMemo(
    () => reviewCheckoutRead.reviewCheckouts.filter((checkout) =>
      checkout.status === 'destroyed' && checkout.verdictAppliedAt !== null,
    ),
    [reviewCheckoutRead.reviewCheckouts],
  );
  const knownReviewerRunIds = useMemo(
    () => new Set(reviewCheckoutRead.reviewCheckouts.map((checkout) => checkout.reviewerRunId)),
    [reviewCheckoutRead.reviewCheckouts],
  );
  const recovery = useMemo(() => buildRecoveryProjection({
    runs: preserved.filter((run) => !knownReviewerRunIds.has(run.runId)),
    contracts,
    strongerContractIds: new Set([
      ...mergeReady.map((contract) => contract.id),
      ...landingIssues.map((contract) => contract.id),
    ]),
    worktrees: strandedRead.status === 'ready' ? strandedRead.worktrees : [],
  }), [preserved, knownReviewerRunIds, contracts, mergeReady, landingIssues, strandedRead.status, strandedRead.worktrees]);
  const recoveryCount = landingIssues.length +
    reviewCleanup.length +
    recovery.runCards.length +
    recovery.strandedWorktrees.length +
    (runReadStatus === 'error' ? 1 : 0) +
    (strandedRead.status === 'error' ? 1 : 0) +
    (reviewCheckoutRead.status === 'error' ? 1 : 0);
  const recoveryLoading = recoveryCount === 0 && (
    runReadStatus === 'loading' ||
    strandedRead.status === 'loading' ||
    reviewCheckoutRead.status === 'loading'
  );
  const contractById = useMemo(
    () => new Map(contracts.map((contract) => [contract.id, contract])),
    [contracts],
  );
  const runById = useMemo(() => {
    const map = new Map<string, AgentRunView>();
    for (const r of [...runs, ...preserved]) map.set(r.runId, r);
    return map;
  }, [runs, preserved]);
  const openRun = (agentRunId: string | null) => {
    const run = agentRunId ? runById.get(agentRunId) : undefined;
    if (run) openTranscript(run.runId, run);
  };
  const runningStatusLabel = runReadStatus === 'error'
    ? 'Running agent status unavailable'
    : runReadStatus === 'loading' && runningCount === 0
      ? 'Running agent status loading'
      : `Running agents · ${runningCount}`;
  const runningStatusValue = runReadStatus === 'error'
    ? '?'
    : runReadStatus === 'loading' && runningCount === 0
      ? '…'
      : String(runningCount);

  if (!expanded) {
    return (
      <button
        type="button"
        onClick={onExpand}
        title="Expand activity panel"
        className="flex h-full w-full flex-col items-center gap-3 border-l border-border bg-card py-3 hover:bg-muted/40"
      >
        <span
          className="text-[9px] uppercase tracking-[0.18em] text-muted-foreground"
          style={{ writingMode: 'vertical-rl', textOrientation: 'mixed' }}
        >
          activity
        </span>
        <span
          title={runningStatusLabel}
          aria-label={runningStatusLabel}
          className="inline-flex min-h-[22px] min-w-[24px] items-center justify-center border border-border px-1 text-[10px] text-[var(--fg-dim)]"
        >
          ▶ {runningStatusValue}
        </span>
        <span
          title={recoveryLoading ? 'Recovery status loading' : `Recovery required · ${recoveryCount}`}
          aria-label={recoveryLoading ? 'Recovery status loading' : `${recoveryCount} recovery issues`}
          className={
            'inline-flex min-h-[22px] min-w-[24px] items-center justify-center border px-1 text-[10px] ' +
            (recoveryCount > 0
              ? 'border-destructive/50 bg-destructive/10 text-destructive'
              : 'border-border text-[var(--fg-dim)]')
          }
        >
          ! {recoveryLoading ? '…' : recoveryCount}
        </span>
        <span className="mt-auto text-xs text-[var(--fg-dim)]">«</span>
      </button>
    );
  }

  return (
    <>
      <div className="flex h-full flex-col border-l border-border bg-card">
        <div className="border-b border-border px-3 py-2 text-sm uppercase tracking-wider text-muted-foreground">
          Activity
        </div>
        {project === null ? (
          <div className="flex-1 px-3 py-2 text-xs text-muted-foreground">No project selected.</div>
        ) : (
          <div className="flex flex-1 flex-col overflow-y-auto">
            <RunningAgentsRegion
              runs={runs}
              nowMs={nowMs}
              onOpenTranscript={(r) => openTranscript(r.runId, r)}
              readStatus={runReadStatus}
              readError={runReadError}
              onRetry={retryRunRead}
            />
            <ReviewEvidenceRegion
              reviewCheckouts={settledReviewCheckouts}
              contracts={contracts}
              onOpenRun={openRun}
              canInspectRun={(runId) => runById.has(runId)}
            />
            <MergeReadyRegion
              contracts={mergeReady}
              onOpenRun={openRun}
              onAbandon={setAbandonContractId}
            />
            <LandingIssuesRegion
              contracts={landingIssues}
              onOpenRun={openRun}
              onAbandon={setAbandonContractId}
            />
            <RecoveryRequiredRegion
              projection={recovery}
              reviewCheckouts={reviewCleanup}
              contracts={contracts}
              nowMs={nowMs}
              onOpenRun={openRun}
              onAbandon={setAbandonContractId}
              onDismiss={handleDismiss}
              dismissingRunId={dismissingRunId}
              dismissError={dismissError}
              runReadStatus={runReadStatus}
              runReadError={runReadError}
              onRetryRunRead={retryRunRead}
              worktreeReadStatus={strandedRead.status}
              worktreeReadError={strandedRead.error}
              onRetryWorktreeRead={strandedRead.retry}
              reviewCheckoutReadStatus={reviewCheckoutRead.status}
              reviewCheckoutReadError={reviewCheckoutRead.error}
              onRetryReviewCheckoutRead={reviewCheckoutRead.retry}
              canInspectRun={(runId) => runById.has(runId)}
              canAbandon={(contractId) => {
                const contract = contractById.get(contractId);
                return contract ? canRequestAbandonment(contract) : false;
              }}
            />
          </div>
        )}
      </div>
      {project && abandonContractId && (
        <AbandonWorktreeModal
          key={abandonContractId}
          projectId={project.id}
          contractId={abandonContractId}
          onClose={() => setAbandonContractId(null)}
        />
      )}
    </>
  );
}

function RegionHeader({ label, count }: { label: string; count: number }) {
  return (
    <div className="flex items-center justify-between px-3 py-1.5">
      <div className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
        {label}
      </div>
      <div className="bg-muted px-1.5 py-0.5 text-[10px] font-mono text-muted-foreground">{count}</div>
    </div>
  );
}

function ReviewEvidenceRegion({
  reviewCheckouts,
  contracts,
  onOpenRun,
  canInspectRun,
}: {
  reviewCheckouts: ReviewCheckoutDto[];
  contracts: Contract[];
  onOpenRun: (agentRunId: string | null) => void;
  canInspectRun: (runId: string) => boolean;
}) {
  if (reviewCheckouts.length === 0) return null;
  return (
    <section className="border-b border-border">
      <RegionHeader label="Recent review evidence" count={reviewCheckouts.length} />
      <ul className="divide-y divide-border/50">
        {reviewCheckouts.map((checkout) => {
          const inspectable = canInspectRun(checkout.reviewerRunId);
          const reviewerContract = contracts.find(
            (contract) => contract.agentRunId === checkout.reviewerRunId,
          ) ?? null;
          const verdict = reviewVerdictPresentation(checkout, reviewerContract);
          return (
            <li key={checkout.id}>
              <button
                type="button"
                onClick={() => onOpenRun(checkout.reviewerRunId)}
                disabled={!inspectable}
                className="block w-full cursor-pointer px-3 py-2 text-left hover:bg-muted/40 disabled:cursor-default"
                aria-label={inspectable
                  ? `Inspect settled review checkout ${checkout.id}`
                  : `Settled review checkout ${checkout.id} has no retained transcript`}
              >
                <div className="flex items-baseline justify-between gap-2">
                  <div className="min-w-0 flex-1 truncate text-[12px] font-medium text-foreground">
                    Independent review
                  </div>
                  <span className="shrink-0 border border-primary/40 bg-primary/10 px-1 py-px text-[9px] uppercase tracking-wider text-primary">
                    cleanup settled
                  </span>
                </div>
                <div className="mt-0.5 truncate font-mono text-[10px] text-muted-foreground" title={checkout.worktreePath}>
                  seal {checkout.sealedCommit.slice(0, 12)} · detached checkout
                </div>
                <div className="mt-0.5 text-[11px] text-muted-foreground">
                  {checkout.provisionReceipt
                    ? 'Exact detached registration and clean HEAD were positively provisioned.'
                    : 'Provision evidence unavailable.'}
                </div>
                <div className="mt-0.5 text-[11px] text-muted-foreground">
                  preparation {phaseEvidenceLabel(checkout.preparationReceipt?.evidence ?? null)} · readiness{' '}
                  {phaseEvidenceLabel(checkout.readinessReceipt?.evidence ?? null)} · verdict{' '}
                  {verdictEvidenceLabel(verdict, 'typed verdict unavailable')}
                </div>
                <div className="mt-1 flex items-center justify-between text-[10px] text-muted-foreground">
                  <span>Directory and Git registration absence positively settled.</span>
                  <span className="font-medium text-foreground">{inspectable ? 'Inspect' : 'No transcript'}</span>
                </div>
              </button>
            </li>
          );
        })}
      </ul>
    </section>
  );
}

function phaseEvidenceLabel(receipt: { ok: boolean } | null): string {
  return receipt === null ? 'unavailable' : receipt.ok ? 'ok' : 'failed';
}

function verdictEvidenceLabel(
  verdict: ReturnType<typeof reviewVerdictPresentation>,
  unavailable: string,
): string {
  if (!verdict) return unavailable;
  const prefix = verdict.authority === 'recorded'
    ? verdict.outcome
    : `submitted ${verdict.outcome}`;
  const state = verdict.authority === 'recorded'
    ? `effect ${verdict.effect}`
    : 'not yet recorded';
  return `${prefix} (${verdict.findingCount}) · ${state}`;
}

function RunningAgentsRegion({
  runs,
  nowMs,
  onOpenTranscript,
  readStatus,
  readError,
  onRetry,
}: {
  runs: AgentRunView[];
  nowMs: number;
  onOpenTranscript: (run: AgentRunView) => void;
  readStatus: AgentRunReadStatus;
  readError: string | null;
  onRetry: () => void;
}) {
  return (
    <section className="border-b border-border">
      <RegionHeader label="Running agents" count={runs.length} />
      {readStatus === 'error' && (
        <RecoveryUnavailable source="Run status" error={readError} onRetry={onRetry} />
      )}
      {runs.length === 0 && readStatus === 'loading' ? (
        <div className="px-3 pb-2 text-[11px] text-muted-foreground">Loading running agents…</div>
      ) : runs.length === 0 && readStatus === 'ready' ? (
        <div className="px-3 pb-2 text-[11px] italic text-muted-foreground/70">No agents running.</div>
      ) : runs.length > 0 ? (
        <ul className="divide-y divide-border/50">
          {runs.map((run) => (
            <RunningAgentCard key={run.runId} run={run} nowMs={nowMs} onOpenTranscript={onOpenTranscript} />
          ))}
        </ul>
      ) : null}
    </section>
  );
}

/** Verification passed, parked awaiting orchestrator review — WHY parked
 *  rides `verificationNotes`. Renders nothing when the queue is empty. */
function MergeReadyRegion({
  contracts,
  onOpenRun,
  onAbandon,
}: {
  contracts: Contract[];
  onOpenRun: (agentRunId: string | null) => void;
  onAbandon: (contractId: ULID) => void;
}) {
  if (contracts.length === 0) return null;
  return (
    <section className="border-b border-border">
      <RegionHeader label="Merge-ready" count={contracts.length} />
      <ul className="divide-y divide-border/50">
        {contracts.map((c) => (
          <li key={c.id} className="flex items-stretch">
            <button
              type="button"
              onClick={() => onOpenRun(c.agentRunId)}
              className="block min-w-0 flex-1 cursor-pointer px-3 py-2 text-left hover:bg-muted/40"
              aria-label={`Open transcript for merge-ready contract ${c.id}`}
            >
              <div className="flex items-baseline justify-between gap-2">
                <div className="min-w-0 flex-1 truncate text-[12px] font-medium text-foreground">
                  {c.podName ?? c.id}
                </div>
                <span className="shrink-0 border border-emerald-500/40 bg-emerald-500/10 px-1 py-px text-[9px] uppercase tracking-wider text-emerald-600 dark:text-emerald-400">
                  awaiting review
                </span>
              </div>
              <div className="mt-0.5 font-mono text-[10px] text-muted-foreground">{effectivePolicy(c)}</div>
              {c.verificationNotes && (
                <div className="mt-0.5 line-clamp-3 text-[11px] text-muted-foreground" title={c.verificationNotes}>
                  {c.verificationNotes}
                </div>
              )}
            </button>
            {canRequestAbandonment(c) && (
              <AbandonButton contract={c} onAbandon={onAbandon} />
            )}
          </li>
        ))}
      </ul>
    </section>
  );
}

/** Conflicted / failed / stale-base landings — preserved until resolved. */
function LandingIssuesRegion({
  contracts,
  onOpenRun,
  onAbandon,
}: {
  contracts: Contract[];
  onOpenRun: (agentRunId: string | null) => void;
  onAbandon: (contractId: ULID) => void;
}) {
  if (contracts.length === 0) return null;
  return (
    <section className="border-b border-border">
      <RegionHeader label="Landing issues" count={contracts.length} />
      <ul className="divide-y divide-border/50">
        {contracts.map((c) => (
          <li key={c.id} className="flex items-stretch">
            <button
              type="button"
              onClick={() => onOpenRun(c.agentRunId)}
              className="block min-w-0 flex-1 cursor-pointer px-3 py-2 text-left hover:bg-muted/40"
              aria-label={`Open transcript for landing issue on contract ${c.id}`}
            >
              <div className="flex items-baseline justify-between gap-2">
                <div className="min-w-0 flex-1 truncate text-[12px] font-medium text-foreground">
                  {c.podName ?? c.id}
                </div>
                <span className="shrink-0 border border-destructive/40 bg-destructive/10 px-1 py-px text-[9px] uppercase tracking-wider text-destructive">
                  {landingIssueLabel(c)}
                </span>
              </div>
              {landingIssueDetail(c) && (
                <div className="mt-0.5 line-clamp-2 text-[11px] text-muted-foreground" title={landingIssueDetail(c) ?? undefined}>
                  {landingIssueDetail(c)}
                </div>
              )}
            </button>
            {canRequestAbandonment(c) && (
              <AbandonButton contract={c} onAbandon={onAbandon} />
            )}
          </li>
        ))}
      </ul>
    </section>
  );
}

/** Terminal recovery outcomes plus otherwise-unrepresented stranded rows.
 * Landing issues stay in their stronger existing region above. */
function RecoveryRequiredRegion({
  projection,
  reviewCheckouts,
  contracts,
  nowMs,
  onOpenRun,
  onAbandon,
  onDismiss,
  dismissingRunId,
  dismissError,
  canAbandon,
  runReadStatus,
  runReadError,
  onRetryRunRead,
  worktreeReadStatus,
  worktreeReadError,
  onRetryWorktreeRead,
  reviewCheckoutReadStatus,
  reviewCheckoutReadError,
  onRetryReviewCheckoutRead,
  canInspectRun,
}: {
  projection: RecoveryProjection;
  reviewCheckouts: ReviewCheckoutDto[];
  contracts: Contract[];
  nowMs: number;
  onOpenRun: (agentRunId: string | null) => void;
  onAbandon: (contractId: ULID) => void;
  onDismiss: (runId: ULID) => void;
  dismissingRunId: ULID | null;
  dismissError: { runId: ULID; message: string } | null;
  canAbandon: (contractId: ULID) => boolean;
  runReadStatus: AgentRunReadStatus;
  runReadError: string | null;
  onRetryRunRead: () => void;
  worktreeReadStatus: RecoveryWorktreeReadStatus;
  worktreeReadError: string | null;
  onRetryWorktreeRead: () => void;
  reviewCheckoutReadStatus: ReviewCheckoutReadStatus;
  reviewCheckoutReadError: string | null;
  onRetryReviewCheckoutRead: () => void;
  canInspectRun: (runId: string) => boolean;
}) {
  const unavailableCount = (runReadStatus === 'error' ? 1 : 0) +
    (worktreeReadStatus === 'error' ? 1 : 0) +
    (reviewCheckoutReadStatus === 'error' ? 1 : 0);
  const count = reviewCheckouts.length + projection.runCards.length +
    projection.strandedWorktrees.length + unavailableCount;
  if (
    count === 0 &&
    runReadStatus !== 'loading' &&
    worktreeReadStatus !== 'loading' &&
    reviewCheckoutReadStatus !== 'loading'
  ) return null;
  return (
    <section className="border-b border-border">
      <RegionHeader label="Recovery required" count={count} />
      {runReadStatus === 'error' && (
        <RecoveryUnavailable
          source="Run recovery"
          error={runReadError}
          onRetry={onRetryRunRead}
        />
      )}
      {worktreeReadStatus === 'error' && (
        <RecoveryUnavailable
          source="Worktree recovery"
          error={worktreeReadError}
          onRetry={onRetryWorktreeRead}
        />
      )}
      {reviewCheckoutReadStatus === 'error' && (
        <RecoveryUnavailable
          source="Review checkout"
          error={reviewCheckoutReadError}
          onRetry={onRetryReviewCheckoutRead}
        />
      )}
      {count === 0 && (
        runReadStatus === 'loading' ||
        worktreeReadStatus === 'loading' ||
        reviewCheckoutReadStatus === 'loading'
      ) && (
        <div className="px-3 pb-2 text-[11px] text-muted-foreground">Loading recovery status…</div>
      )}
      <ul className="divide-y divide-border/50">
        {reviewCheckouts.map((checkout) => {
          const inspectable = canInspectRun(checkout.reviewerRunId);
          const reviewerContract = contracts.find(
            (contract) => contract.agentRunId === checkout.reviewerRunId,
          ) ?? null;
          const verdict = reviewVerdictPresentation(checkout, reviewerContract);
          return (
            <li key={`review:${checkout.id}`} className="flex items-stretch">
              <button
                type="button"
                onClick={() => onOpenRun(checkout.reviewerRunId)}
                disabled={!inspectable}
                className="block min-w-0 flex-1 cursor-pointer px-3 py-2 text-left hover:bg-muted/40 disabled:cursor-default"
                aria-label={inspectable
                  ? `Inspect review checkout ${checkout.id}`
                  : `Review checkout ${checkout.id} has no retained transcript`}
              >
                <div className="flex items-baseline justify-between gap-2">
                  <div className="min-w-0 flex-1 truncate text-[12px] font-medium text-foreground">
                    Independent review
                  </div>
                  <span className="shrink-0 border border-destructive/40 bg-destructive/10 px-1 py-px text-[9px] uppercase tracking-wider text-destructive">
                    {checkout.status === 'destroyed' ? 'effect pending' : 'cleanup pending'}
                  </span>
                </div>
                <div className="mt-0.5 truncate font-mono text-[10px] text-muted-foreground" title={checkout.worktreePath}>
                  seal {checkout.sealedCommit.slice(0, 12)} · checkout {checkout.id.slice(0, 8)}
                </div>
                <div className="mt-0.5 text-[11px] text-muted-foreground">
                  {checkout.status === 'destroyed'
                    ? 'Checkout cleanup is positively settled, but its typed contract effect is pending or unavailable.'
                    : 'Detached review cleanup has not positively proved both directory and Git-registration absence.'}
                </div>
                <div className="mt-0.5 text-[11px] text-muted-foreground">
                  provision {checkout.provisionReceipt ? 'exact detached clean HEAD' : 'unavailable'} · preparation{' '}
                  {phaseEvidenceLabel(checkout.preparationReceipt?.evidence ?? null)} · readiness{' '}
                  {phaseEvidenceLabel(checkout.readinessReceipt?.evidence ?? null)} · verdict{' '}
                  {verdictEvidenceLabel(verdict, 'pending or unavailable')}
                </div>
                {checkout.cleanupError && (
                  <div className="mt-0.5 line-clamp-2 text-[11px] text-destructive" title={checkout.cleanupError}>
                    {checkout.cleanupError}
                  </div>
                )}
                <div className="mt-1 flex items-center justify-between gap-2 text-[10px] text-muted-foreground">
                  <span>{checkout.status === 'destroyed'
                    ? 'Landing, Fix, and successor review remain blocked until the exact verdict effect settles.'
                    : 'Landing, Fix, override, and successor review remain blocked.'}</span>
                  <span className="shrink-0 font-medium text-foreground">
                    {inspectable ? 'Inspect' : 'No transcript'}
                  </span>
                </div>
              </button>
            </li>
          );
        })}
        {projection.runCards.map((card) => {
          const { run, contract, worktree } = card;
          const dismissible = isDismissibleRecoveryRun(card);
          const runDismissError = dismissError?.runId === run.runId ? dismissError.message : null;
          return (
          <li key={`run:${run.runId}`} className="flex flex-col">
            <div className="flex items-stretch">
              <button
                type="button"
                onClick={() => onOpenRun(run.runId)}
                className="block min-w-0 flex-1 cursor-pointer px-3 py-2 text-left hover:bg-muted/40"
                aria-label={`Inspect recovery run ${run.runId}`}
              >
                <div className="flex items-baseline justify-between gap-2">
                  <div className="min-w-0 flex-1 truncate text-[12px] font-medium text-foreground">
                    {run.agentName}
                  </div>
                  <span className="shrink-0 border border-destructive/40 bg-destructive/10 px-1 py-px text-[9px] uppercase tracking-wider text-destructive">
                    {recoveryRunLabel(run)}
                  </span>
                </div>
                {run.failureReason && (
                  <div className="mt-0.5 line-clamp-2 text-[11px] text-muted-foreground" title={run.failureReason}>
                    {run.failureReason}
                  </div>
                )}
                {sealedEvidenceMessage(contract) && (
                  <div className="mt-0.5 text-[11px] text-muted-foreground">
                    {sealedEvidenceMessage(contract)}
                  </div>
                )}
                <div className="mt-0.5 text-[11px] text-muted-foreground">
                  {preservationEvidenceMessage(worktree)}
                </div>
                <div className="mt-1 flex items-center justify-between gap-2 text-[10px]">
                  <span className="line-clamp-2 text-muted-foreground">{recoveryRunGuidance(run)}</span>
                  <span className="shrink-0 font-medium text-foreground">Inspect</span>
                </div>
              </button>
              {contract && canRequestAbandonment(contract) && (
                <AbandonButton contract={contract} onAbandon={onAbandon} />
              )}
              {dismissible && (
                <DismissButton
                  runId={run.runId}
                  busy={dismissingRunId === run.runId}
                  onDismiss={onDismiss}
                />
              )}
            </div>
            {runDismissError && (
              <div className="px-3 pb-2 text-[11px] text-destructive">{runDismissError}</div>
            )}
          </li>
          );
        })}
        {projection.strandedWorktrees.map((w) => {
          const inspectable = w.agentRunId !== null && canInspectRun(w.agentRunId);
          return (
          <li key={w.id} className="flex items-stretch">
            <button
              type="button"
              onClick={() => onOpenRun(w.agentRunId)}
              disabled={!inspectable}
              className="block min-w-0 flex-1 cursor-pointer px-3 py-2 text-left hover:bg-muted/40"
              aria-label={inspectable ? `Inspect stranded worktree ${w.name}` : `Stranded worktree ${w.name} has no retained transcript`}
            >
              <div className="flex items-baseline justify-between gap-2">
                <div className="min-w-0 flex-1 truncate font-mono text-[11px] text-foreground" title={w.path}>
                  {w.branch ?? w.name}
                </div>
                <span className="shrink-0 border border-destructive/40 bg-destructive/10 px-1 py-px text-[9px] uppercase tracking-wider text-destructive">
                  stranded
                </span>
              </div>
              {w.strandedReason && (
                <div className="mt-0.5 line-clamp-2 text-[11px] text-muted-foreground" title={w.strandedReason}>
                  {w.strandedReason === 'dir-missing'
                    ? 'The recorded worktree directory is missing; cleanup and branch state are not proven.'
                    : 'No live run owns this retained worktree.'}
                </div>
              )}
              <div className="mt-1 flex items-center justify-between text-[10px] text-muted-foreground">
                <span>{w.strandedAt === null ? 'age unavailable' : formatElapsed(nowMs - w.strandedAt)}</span>
                <span className="font-medium text-foreground">{inspectable ? 'Inspect' : 'No transcript'}</span>
              </div>
            </button>
            {w.contractId && canAbandon(w.contractId) && (
              <button
                type="button"
                onClick={() => onAbandon(w.contractId!)}
                className="shrink-0 border-l border-destructive/30 px-2 text-[10px] font-medium text-destructive hover:bg-destructive/10"
                aria-label={`Abandon stranded worktree ${w.name}`}
                title="Preview and explicitly approve worktree abandonment"
              >
                Abandon…
              </button>
            )}
          </li>
          );
        })}
      </ul>
    </section>
  );
}

function RecoveryUnavailable({
  source,
  error,
  onRetry,
}: {
  source: string;
  error: string | null;
  onRetry: () => void;
}) {
  return (
    <div className="flex items-start gap-2 border-t border-destructive/20 bg-destructive/5 px-3 py-2 text-[11px]">
      <div className="min-w-0 flex-1 text-destructive">
        <div className="font-medium">{source} status unavailable.</div>
        {error && <div className="truncate text-[10px] text-muted-foreground" title={error}>{error}</div>}
      </div>
      <button
        type="button"
        onClick={onRetry}
        className="shrink-0 border border-border bg-card px-2 py-1 text-[10px] font-medium text-foreground hover:bg-muted"
      >
        Retry
      </button>
    </div>
  );
}

function AbandonButton({
  contract,
  onAbandon,
}: {
  contract: Contract;
  onAbandon: (contractId: ULID) => void;
}) {
  return (
    <button
      type="button"
      onClick={() => onAbandon(contract.id)}
      className="shrink-0 border-l border-destructive/30 px-2 text-[10px] font-medium text-destructive hover:bg-destructive/10"
      aria-label={`Abandon worktree for contract ${contract.id}`}
      title="Preview and explicitly approve worktree abandonment"
    >
      Abandon…
    </button>
  );
}

function DismissButton({
  runId,
  busy,
  onDismiss,
}: {
  runId: ULID;
  busy: boolean;
  onDismiss: (runId: ULID) => void;
}) {
  return (
    <button
      type="button"
      onClick={() => onDismiss(runId)}
      disabled={busy}
      className="shrink-0 border-l border-border px-2 text-[10px] font-medium text-muted-foreground hover:bg-muted disabled:cursor-default disabled:opacity-60"
      aria-label={`Dismiss recovery run ${runId}`}
      title="Nothing to recover here — clear this card"
    >
      {busy ? 'Dismissing…' : 'Dismiss'}
    </button>
  );
}

function RunningAgentCard({
  run,
  nowMs,
  onOpenTranscript,
}: {
  run: AgentRunView;
  nowMs: number;
  onOpenTranscript: (run: AgentRunView) => void;
}) {
  const elapsed = formatElapsed(nowMs - run.startedAt);
  const statusLabel =
    run.status === 'spawning' || run.status === 'queued'
      ? 'starting…'
      : run.status === 'paused'
        ? 'paused'
        : null;
  const showStalled = run.stalled && (run.status === 'running' || run.status === 'spawning');

  return (
    <li>
      <button
        type="button"
        onClick={() => onOpenTranscript(run)}
        className="block w-full cursor-pointer px-3 py-2 text-left hover:bg-muted/40"
        aria-label={`Open transcript for ${run.agentName}`}
      >
        <div className="flex items-baseline justify-between gap-2">
          <div className="min-w-0 flex-1 truncate text-[12px] font-medium text-foreground">{run.agentName}</div>
          <div className="shrink-0 font-mono text-[10px] text-muted-foreground">{elapsed}</div>
        </div>
        {(statusLabel || showStalled) && (
          <div className="mt-0.5 flex items-center gap-1.5 text-[11px] text-muted-foreground">
            {statusLabel && <span className="truncate">{statusLabel}</span>}
            {showStalled && (
              <span
                title="No activity for several minutes — still running, not yet timed out."
                className="shrink-0 border border-amber-500/40 bg-amber-500/10 px-1 py-px text-[9px] uppercase tracking-wider text-amber-600 dark:text-amber-400"
              >
                stalled
              </span>
            )}
          </div>
        )}
      </button>
    </li>
  );
}

function formatElapsed(ms: number): string {
  if (ms < 0 || !Number.isFinite(ms)) return '—';
  const s = Math.floor(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  return `${h}h ${m % 60}m`;
}
