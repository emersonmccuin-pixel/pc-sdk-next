import type { AgentRunDto, Contract, ReviewCheckoutDto } from '@pc/contracts';
import {
  isRecoveryTerminalRun,
  type AgentRunView,
} from '@/features/agent-runs/use-project-agent-runs';
import type { StrandedWorktreeDto } from '@/features/worktrees/client';

export interface RecoveryRunCard {
  run: AgentRunView;
  contract: Contract | null;
  worktree: StrandedWorktreeDto | null;
}

export interface RecoveryProjection {
  runCards: RecoveryRunCard[];
  strandedWorktrees: StrandedWorktreeDto[];
}

export interface ReviewVerdictEvidence {
  verdict: 'approve' | 'reject';
  findingCount: number;
}

export interface ReviewVerdictPresentation {
  outcome: 'approve' | 'reject' | 'unavailable' | 'void' | 'overridden';
  findingCount: number;
  authority: 'recorded' | 'submitted';
  effect: 'applied' | 'pending' | 'unrecorded';
}

export function reviewCheckoutsRequiringAttention(
  reviewCheckouts: readonly ReviewCheckoutDto[],
): ReviewCheckoutDto[] {
  return reviewCheckouts.filter((checkout) =>
    checkout.status === 'teardown-pending' ||
    (checkout.status === 'destroyed' && checkout.verdictAppliedAt === null),
  );
}

/** Only the reviewer's schema-validated payload contract is verdict evidence.
 * Final prose, the target contract state, and a terminal run are not parsed as
 * a verdict. This browser check is defensive presentation; server settlement
 * remains the authority door. */
export function exactReviewVerdictEvidence(
  reviewerContract: Contract | null,
): ReviewVerdictEvidence | null {
  const expected = reviewerContract?.expectedOutput;
  if (
    !reviewerContract ||
    !expected ||
    expected.kind !== 'payload' ||
    expected.semantic !== 'verdict' ||
    reviewerContract.verificationStatus !== 'passed' ||
    reviewerContract.deliverable?.kind !== 'payload'
  ) return null;
  const data = reviewerContract.deliverable.data;
  if (data === null || typeof data !== 'object' || Array.isArray(data)) return null;
  const record = data as Record<string, unknown>;
  if (
    (record.verdict !== 'approve' && record.verdict !== 'reject') ||
    !Array.isArray(record.findings)
  ) return null;
  for (const finding of record.findings) {
    if (finding === null || typeof finding !== 'object' || Array.isArray(finding)) return null;
    const item = finding as Record<string, unknown>;
    if (
      typeof item.file !== 'string' ||
      typeof item.summary !== 'string' ||
      !['critical', 'major', 'minor'].includes(String(item.severity)) ||
      (item.line !== undefined && typeof item.line !== 'number')
    ) return null;
  }
  return { verdict: record.verdict, findingCount: record.findings.length };
}

/** The immutable checkout receipt is the presentation authority. A validated
 * reviewer payload is shown only as an unrecorded submission while no receipt
 * exists; it can never override a durable void/overridden/unavailable result. */
export function reviewVerdictPresentation(
  checkout: ReviewCheckoutDto,
  reviewerContract: Contract | null,
): ReviewVerdictPresentation | null {
  if (checkout.verdictReceipt) {
    return {
      outcome: checkout.verdictReceipt.outcome,
      findingCount: checkout.verdictReceipt.findings.length,
      authority: 'recorded',
      effect: checkout.verdictAppliedAt === null ? 'pending' : 'applied',
    };
  }
  const submitted = exactReviewVerdictEvidence(reviewerContract);
  return submitted
    ? {
        outcome: submitted.verdict,
        findingCount: submitted.findingCount,
        authority: 'submitted',
        effect: 'unrecorded',
      }
    : null;
}

export function contractForRecoveryRun(
  run: AgentRunDto,
  contracts: readonly Contract[],
): Contract | null {
  return contracts.find((contract) => contract.agentRunId === run.runId) ??
    contracts.find((contract) => (
      run.worktreeDir.length > 0 && contract.worktreePath === run.worktreeDir
    )) ??
    null;
}

/** A positive browser preservation statement requires the exact stranded row,
 * producer, contract, and path. Merely retaining a run or carrying a path
 * string is not filesystem/Git evidence. */
export function exactStrandedEvidenceForRun(
  run: AgentRunDto,
  contract: Contract | null,
  worktrees: readonly StrandedWorktreeDto[],
): StrandedWorktreeDto | null {
  if (!contract || run.worktreeDir.length === 0) return null;
  return worktrees.find((worktree) => (
    worktree.agentRunId === run.runId &&
    worktree.contractId === contract.id &&
    worktree.path === run.worktreeDir &&
    contract.worktreePath === worktree.path
  )) ?? null;
}

/** Strongest evidence wins: landing issues render in their existing region;
 * retained/recent failed runs outrank their matching stranded row; only
 * otherwise-unrepresented stranded rows remain standalone. */
export function buildRecoveryProjection(input: {
  runs: readonly AgentRunView[];
  contracts: readonly Contract[];
  strongerContractIds: ReadonlySet<string>;
  worktrees: readonly StrandedWorktreeDto[];
}): RecoveryProjection {
  const cardByOwner = new Map<string, RecoveryRunCard>();
  const representedWorktreeIds = new Set<string>();

  for (const run of input.runs) {
    const contract = contractForRecoveryRun(run, input.contracts);
    if (!isRecoveryTerminalRun(run, contract?.landingStatus ?? null)) continue;
    if (contract && input.strongerContractIds.has(contract.id)) continue;
    const worktree = exactStrandedEvidenceForRun(run, contract, input.worktrees);
    const candidate = { run, contract, worktree };
    const ownerKey = contract ? `contract:${contract.id}` : `run:${run.runId}`;
    const current = cardByOwner.get(ownerKey);
    if (!current || recoveryCardWins(candidate, current)) {
      cardByOwner.set(ownerKey, candidate);
    }
  }

  const runCards = [...cardByOwner.values()].sort((a, b) => a.run.startedAt - b.run.startedAt);
  for (const card of runCards) {
    if (card.worktree) representedWorktreeIds.add(card.worktree.id);
  }

  const strandedWorktrees = input.worktrees.filter((worktree) => {
    if (representedWorktreeIds.has(worktree.id)) return false;
    return worktree.contractId === null || !input.strongerContractIds.has(worktree.contractId);
  });

  return { runCards, strandedWorktrees };
}

function recoveryCardWins(candidate: RecoveryRunCard, current: RecoveryRunCard): boolean {
  if (Boolean(candidate.worktree) !== Boolean(current.worktree)) return candidate.worktree !== null;
  const candidateIsProducer = candidate.contract?.agentRunId === candidate.run.runId;
  const currentIsProducer = current.contract?.agentRunId === current.run.runId;
  if (candidateIsProducer !== currentIsProducer) return candidateIsProducer;
  return candidate.run.startedAt >= current.run.startedAt;
}

export function recoveryRunLabel(run: AgentRunDto): string {
  if (run.failureCause === 'server-restart') return 'server restart';
  if (run.lifecycleState === 'provisioning-failed') return 'preparation failed';
  if (run.lifecycleState === 'verification-failed') return 'verification failed';
  if (run.lifecycleState === 'review-rejected') return 'review rejected';
  if (run.lifecycleState === 'stranded') return 'stranded';
  if (run.status === 'cancelled' || run.lifecycleState === 'cancelled') return 'cancelled';
  return 'run failed';
}

export function recoveryRunGuidance(run: AgentRunDto): string {
  if (run.lifecycleState === 'provisioning-failed') {
    return 'Inspect the preparation evidence, then ask the orchestrator to re-dispatch after the workspace issue is fixed.';
  }
  if (
    run.lifecycleState === 'verification-failed' ||
    run.lifecycleState === 'review-rejected'
  ) {
    return 'Inspect the evidence, then ask the orchestrator to continue or fix the retained work.';
  }
  return 'Inspect the evidence, then ask the orchestrator to continue or re-dispatch if more work is needed.';
}

export function sealedEvidenceMessage(contract: Contract | null): string | null {
  if (contract?.expectedOutput?.kind !== 'repo') return null;
  return contract.deliverable?.kind === 'repo' && typeof contract.deliverable.commit === 'string'
    ? `Sealed deliverable recorded at ${contract.deliverable.commit.slice(0, 12)}.`
    : 'No sealed deliverable is recorded.';
}

export function preservationEvidenceMessage(
  worktree: StrandedWorktreeDto | null,
): string {
  if (!worktree) {
    return 'Current durable worktree preservation evidence is unavailable in this view.';
  }
  if (worktree.strandedReason === 'dir-missing') {
    return 'The recorded worktree directory is missing; cleanup and branch state are not proven.';
  }
  return 'Durable worktree evidence confirms the worktree remains preserved for recovery.';
}
