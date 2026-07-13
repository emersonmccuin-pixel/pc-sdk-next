// Right-rail activity panel — running agents + worktree-lifecycle surfacing
// (docs/worktree-lifecycle.md): merge-ready contracts awaiting review,
// conflicted/failed landings, and stranded worktrees. The old ActivityPanel's
// workflow-runs, inbox, and failed-recently regions all depended on dead
// entities (workflow-run, mailbox) or routes this phase doesn't build; they
// are not carried (see docs/phase-2-plan.md web port ledger).
//
// 36px collapsed gutter is owned by the Shell (panel sizing); this renders
// the gutter's contents and the expanded body.

import { useEffect, useMemo, useState } from 'react';

import type { Contract, ULID } from '@pc/contracts';
import type { Project } from '@/features/projects/client';
import type { AgentRunView } from '@/features/agent-runs/use-project-agent-runs';
import { useProjectContracts } from '@/features/contracts/use-project-contracts';
import {
  canRequestAbandonment,
  effectivePolicy,
  landingIssueDetail,
  landingIssueLabel,
  landingIssueContracts,
  mergeReadyContracts,
} from '@/features/contracts/view';
import { worktreesApi, type StrandedWorktreeDto } from '@/features/worktrees/client';
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
  useEffect(() => {
    const id = setInterval(() => setNowMs(Date.now()), 5000);
    return () => clearInterval(id);
  }, []);

  const { runningCount, runs, preserved } = useProjectActivity(project);
  const { contracts } = useProjectContracts(project?.id ?? null);
  const stranded = useStrandedWorktrees(project?.id ?? null, expanded);
  const openTranscript = useAgentTranscript((s) => s.open);

  const mergeReady = useMemo(() => mergeReadyContracts(contracts), [contracts]);
  const landingIssues = useMemo(() => landingIssueContracts(contracts), [contracts]);
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
          title={`Running agents · ${runningCount}`}
          className="inline-flex h-[22px] min-w-[22px] items-center justify-center rounded-full border border-border px-1 text-[11px] text-[var(--fg-dim)]"
        >
          {runningCount}
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
            <RunningAgentsRegion runs={runs} nowMs={nowMs} onOpenTranscript={(r) => openTranscript(r.runId, r)} />
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
            <StrandedWorktreesRegion
              worktrees={stranded}
              nowMs={nowMs}
              onOpenRun={openRun}
              onAbandon={setAbandonContractId}
              canAbandon={(contractId) => {
                const contract = contractById.get(contractId);
                return contract ? canRequestAbandonment(contract) : true;
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

/** Poll the stranded read while the panel is expanded — worktrees have no
 *  resource-entity flow (stranding is a boot-scan durable), so the Wave-E GET
 *  endpoint is the cheap path. Degrade, never block. */
function useStrandedWorktrees(projectId: string | null, enabled: boolean): StrandedWorktreeDto[] {
  const [items, setItems] = useState<StrandedWorktreeDto[]>([]);
  useEffect(() => {
    if (!projectId || !enabled) {
      setItems([]);
      return;
    }
    let cancelled = false;
    const load = () =>
      worktreesApi
        .listStranded(projectId)
        .then((w) => {
          if (!cancelled) setItems(w);
        })
        .catch(() => {
          if (!cancelled) setItems([]);
        });
    void load();
    const id = setInterval(load, 60_000);
    return () => {
      cancelled = true;
      clearInterval(id);
    };
  }, [projectId, enabled]);
  return items;
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

function RunningAgentsRegion({
  runs,
  nowMs,
  onOpenTranscript,
}: {
  runs: AgentRunView[];
  nowMs: number;
  onOpenTranscript: (run: AgentRunView) => void;
}) {
  return (
    <section className="border-b border-border">
      <RegionHeader label="Running agents" count={runs.length} />
      {runs.length === 0 ? (
        <div className="px-3 pb-2 text-[11px] italic text-muted-foreground/70">No agents running.</div>
      ) : (
        <ul className="divide-y divide-border/50">
          {runs.map((run) => (
            <RunningAgentCard key={run.runId} run={run} nowMs={nowMs} onOpenTranscript={onOpenTranscript} />
          ))}
        </ul>
      )}
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

/** Boot-scan durables: worktrees with no live run/lease. Preserved — never
 *  auto-torn-down (docs/worktree-lifecycle.md 'Recovery'). */
function StrandedWorktreesRegion({
  worktrees,
  nowMs,
  onOpenRun,
  onAbandon,
  canAbandon,
}: {
  worktrees: StrandedWorktreeDto[];
  nowMs: number;
  onOpenRun: (agentRunId: string | null) => void;
  onAbandon: (contractId: ULID) => void;
  canAbandon: (contractId: ULID) => boolean;
}) {
  if (worktrees.length === 0) return null;
  return (
    <section className="border-b border-border">
      <RegionHeader label="Stranded worktrees" count={worktrees.length} />
      <ul className="divide-y divide-border/50">
        {worktrees.map((w) => (
          <li key={w.id} className="flex items-stretch">
            <button
              type="button"
              onClick={() => onOpenRun(w.agentRunId)}
              className="block min-w-0 flex-1 cursor-pointer px-3 py-2 text-left hover:bg-muted/40"
              aria-label={`Stranded worktree ${w.name}`}
            >
              <div className="flex items-baseline justify-between gap-2">
                <div className="min-w-0 flex-1 truncate font-mono text-[11px] text-foreground" title={w.path}>
                  {w.branch ?? w.name}
                </div>
                {w.strandedAt !== null && (
                  <div className="shrink-0 font-mono text-[10px] text-muted-foreground">
                    {formatElapsed(nowMs - w.strandedAt)}
                  </div>
                )}
              </div>
              {w.strandedReason && (
                <div className="mt-0.5 line-clamp-2 text-[11px] text-muted-foreground" title={w.strandedReason}>
                  {w.strandedReason}
                </div>
              )}
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
        ))}
      </ul>
    </section>
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
