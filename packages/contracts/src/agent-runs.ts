// Agent-run contract family (slice 005). Browser-safe, zero runtime deps.
//
// Owns `AgentRunDto` (browser-safe mirror of the agent-run row) and the
// canonical agent-run resource payload (`{ reason, run, pendingAskId? }`) that
// rides the new `resource` frame (see events/resources.ts) as the full-snapshot
// payload for the `agent-run` entity. Agent-run resource events are
// PROJECT-scoped; the frame's `version` carries `agent_runs.rev`.

import { isUlid, type ULID } from './shared.ts';
import { isRuntimeSelection, type RuntimeSelection } from './runtime.ts';
import {
  isSessionContinuationState,
  type SessionContinuationState,
} from './events/session.ts';

export const AGENT_RUN_STATUSES = [
  'queued',
  'spawning',
  'running',
  'paused',
  'completed',
  'failed',
  'cancelled',
] as const;
export type AgentRunStatus = (typeof AGENT_RUN_STATUSES)[number];

/** Browser-safe mirror of @pc/domain RUN_LIFECYCLE_STATES (worktree pipeline,
 *  docs/worktree-lifecycle.md). Keep in lockstep. */
export const RUN_LIFECYCLE_STATES = [
  'queued',
  'provisioning',
  'preparing',
  'ready',
  'planning',
  'building',
  'verifying',
  'reviewing',
  'fixing',
  'merge-ready',
  'merging',
  'merged',
  'tearing-down',
  'completed',
  'provisioning-failed',
  'verification-failed',
  'review-rejected',
  'conflict',
  'failed',
  'cancelled',
  'stranded',
] as const;
export type RunLifecycleState = (typeof RUN_LIFECYCLE_STATES)[number];

/** Browser-safe mirror of @pc/domain PRESERVED_LIFECYCLE_STATES — runs in
 *  these states stay visible until resolved (no recent-terminal window).
 *  Keep in lockstep. */
export const PRESERVED_LIFECYCLE_STATES = [
  'merge-ready',
  'conflict',
  'stranded',
  'review-rejected',
  'failed',
] as const satisfies readonly RunLifecycleState[];

export function isPreservedLifecycleState(value: RunLifecycleState | null): boolean {
  return value !== null && (PRESERVED_LIFECYCLE_STATES as readonly string[]).includes(value);
}

// ── Provisioning receipts (browser-safe mirrors of @pc/domain worktree.ts) ──

export interface RepositoryIdentityReceiptDto {
  protocol: 'git-common-dir-v1';
  gitCommonDir: string;
  leaseKey: string;
}

export interface WorktreeGitReceiptDto {
  worktreePath: string;
  branch: string;
  baseBranch: string;
  baseSha: string;
  cleanStatus: boolean;
  /** Absent only on retained legacy receipts, which carry no mutation authority. */
  repositoryIdentity?: RepositoryIdentityReceiptDto | null;
}

export interface WorktreeCommandStepDto {
  command: string;
  exitCode: number;
  durationMs: number;
  stdoutTail: string;
  stderrTail: string;
  timedOut: boolean;
}

export type WorktreePhaseDto = 'preparation' | 'readiness';

export interface WorktreePhaseExecutedReceiptDto {
  phase: WorktreePhaseDto;
  outcome: 'executed';
  ok: boolean;
  steps: WorktreeCommandStepDto[];
  finishedAt: number;
}

export interface WorktreePhaseNoCommandsReceiptDto {
  phase: WorktreePhaseDto;
  outcome: 'not-required';
  reason: 'no-commands-configured';
  ok: true;
  steps: [];
  finishedAt: number;
}

export interface WorktreePhaseExistingWorktreeReceiptDto {
  phase: 'preparation';
  outcome: 'not-required';
  reason: 'existing-worktree-preparation';
  inheritedFromRunId: ULID;
  ok: true;
  steps: [];
  finishedAt: number;
}

export type WorktreePhaseNotRequiredReceiptDto =
  | WorktreePhaseNoCommandsReceiptDto
  | WorktreePhaseExistingWorktreeReceiptDto;

export type WorktreePhaseReceiptDto =
  | WorktreePhaseExecutedReceiptDto
  | WorktreePhaseNotRequiredReceiptDto;

// ── Workspace-owned independent-review checkout evidence (DL-004) ──────

export const REVIEW_CHECKOUT_STATUSES = [
  'reserved',
  'provisioned',
  'teardown-pending',
  'destroyed',
] as const;
export type ReviewCheckoutStatusDto = (typeof REVIEW_CHECKOUT_STATUSES)[number];

export interface ReviewCheckoutAuthorityDto {
  id: ULID;
  projectId: ULID;
  contractId: ULID;
  contractVersion: number;
  producerRunId: ULID;
  reviewerRunId: ULID;
  repositoryIdentity: RepositoryIdentityReceiptDto;
  worktreePath: string;
  ownedRootRealPath: string;
  sealedCommit: string;
}

export interface ReviewCheckoutProvisionReceiptDto extends ReviewCheckoutAuthorityDto {
  protocol: 'review-checkout-provision-v1';
  registrationCount: 1;
  registrationPath: string;
  headSha: string;
  detachedHead: true;
  trackedChanges: 0;
  stagedChanges: 0;
  observedAt: number;
}

export interface ReviewCheckoutGitReceiptDto
  extends WorktreeGitReceiptDto, ReviewCheckoutAuthorityDto {
  protocol: 'review-checkout-git-v1';
  branch: '(detached)';
  baseBranch: '(detached)';
  baseSha: string;
  cleanStatus: true;
  registrationCount: 1;
  registrationPath: string;
  headSha: string;
  detachedHead: true;
  trackedChanges: 0;
  stagedChanges: 0;
  observedAt: number;
  repositoryIdentity: RepositoryIdentityReceiptDto;
}

export interface ReviewCheckoutTeardownReceiptDto extends ReviewCheckoutAuthorityDto {
  protocol: 'review-checkout-teardown-v1';
  startedAt: number;
  finishedAt: number;
  directoryAbsent: true;
  registrationAbsent: true;
  branchDeletion: 'not-applicable-detached';
}

/** Separate workspace projection. It is intentionally not embedded in the
 * agent-run row/DTO because workspace lifecycle authority has one owner. */
export interface ReviewCheckoutDto extends ReviewCheckoutAuthorityDto {
  status: ReviewCheckoutStatusDto;
  provisionReceipt: ReviewCheckoutProvisionReceiptDto | null;
  preparationReceipt: WorktreePhaseReceiptDto | null;
  readinessReceipt: WorktreePhaseReceiptDto | null;
  teardownReceipt: ReviewCheckoutTeardownReceiptDto | null;
  cleanupError: string | null;
  createdAt: number;
  updatedAt: number;
  destroyedAt: number | null;
}

/** Browser-safe mirror of the agent-run row. */
export interface AgentRunDto {
  runId: ULID;
  agentName: string;
  /** Null only for conservatively quarantined legacy rows. */
  selection: RuntimeSelection | null;
  /** Opaque specialist snapshot revision; null for legacy rows. */
  specialistRevision: string | null;
  /** Presence only. Adapter-native identity never crosses this seam. */
  nativeSessionIdPresent: boolean;
  continuationState: SessionContinuationState;
  projectId: ULID;
  dispatcherSessionId: string;
  worktreeDir: string;
  startedAt: number;
  status: AgentRunStatus;
  /** Worktree-pipeline state (docs/worktree-lifecycle.md). Additive surface —
   *  the UI still keys terminal/non-terminal off `status`. null = non-repo/
   *  legacy run. */
  lifecycleState: RunLifecycleState | null;
  result: string;
  failureReason: string | null;
  failureCause: string | null;
  endedAt: number | null;
  /** Monotonic write counter (agent_runs.rev). */
  rev: number;
  /** Provisioning receipts (docs/worktree-lifecycle.md). Additive surface —
   *  new repository builders carry both phase receipts, including explicit
   *  no-ops. Absent/null remains only for non-repo, detached-review, and
   *  historical/incomplete rows. */
  gitReceipt?: WorktreeGitReceiptDto | ReviewCheckoutGitReceiptDto | null;
  preparationReceipt?: WorktreePhaseReceiptDto | null;
  readinessReceipt?: WorktreePhaseReceiptDto | null;
}

// ── Canonical resource payload (agent-run entity, full snapshot) ─────────────

export type AgentRunChangedReason =
  | 'queued'
  | 'spawning'
  | 'running'
  | 'paused'
  | 'resumed'
  // T2.2 — non-terminal watchdog warn: the run is quiet past WARN_MS but not yet
  // killed. Status stays `running`/`spawning`; the frame just flips a UI badge.
  | 'stalled'
  | 'completed'
  | 'failed'
  | 'cancelled'
  | 'reconciled';

export const AGENT_RUN_CHANGED_REASONS: readonly AgentRunChangedReason[] = [
  'queued',
  'spawning',
  'running',
  'paused',
  'resumed',
  'stalled',
  'completed',
  'failed',
  'cancelled',
  'reconciled',
];

export interface AgentRunChangedLivePayload {
  reason: AgentRunChangedReason;
  /** Full snapshot with the current rev. */
  run: AgentRunDto;
  /** Set on `reason:'paused'`. */
  pendingAskId?: ULID | null;
}

// ── Guards ───────────────────────────────────────────────────────────────────

export function isAgentRunStatus(value: unknown): value is AgentRunStatus {
  return typeof value === 'string' && (AGENT_RUN_STATUSES as readonly string[]).includes(value);
}

export function isRunLifecycleState(value: unknown): value is RunLifecycleState {
  return typeof value === 'string' && (RUN_LIFECYCLE_STATES as readonly string[]).includes(value);
}

export function isReviewCheckoutStatus(
  value: unknown,
): value is ReviewCheckoutStatusDto {
  return typeof value === 'string' &&
    (REVIEW_CHECKOUT_STATUSES as readonly string[]).includes(value);
}

function isReviewCheckoutAuthorityDto(
  value: unknown,
): value is ReviewCheckoutAuthorityDto {
  return isRecord(value) &&
    isUlid(value.id) &&
    isUlid(value.projectId) &&
    isUlid(value.contractId) &&
    Number.isSafeInteger(value.contractVersion) &&
    (value.contractVersion as number) > 0 &&
    isUlid(value.producerRunId) &&
    isUlid(value.reviewerRunId) &&
    isRepositoryIdentityReceiptDto(value.repositoryIdentity) &&
    exactNonEmptyString(value.worktreePath) &&
    exactNonEmptyString(value.ownedRootRealPath) &&
    typeof value.sealedCommit === 'string' &&
    /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/.test(value.sealedCommit);
}

function hasMatchingReviewCheckoutAuthorityDto(
  authority: ReviewCheckoutAuthorityDto,
  receipt: ReviewCheckoutAuthorityDto,
): boolean {
  return receipt.id === authority.id &&
    receipt.projectId === authority.projectId &&
    receipt.contractId === authority.contractId &&
    receipt.contractVersion === authority.contractVersion &&
    receipt.producerRunId === authority.producerRunId &&
    receipt.reviewerRunId === authority.reviewerRunId &&
    receipt.worktreePath === authority.worktreePath &&
    receipt.ownedRootRealPath === authority.ownedRootRealPath &&
    receipt.sealedCommit === authority.sealedCommit &&
    receipt.repositoryIdentity.protocol === authority.repositoryIdentity.protocol &&
    receipt.repositoryIdentity.gitCommonDir === authority.repositoryIdentity.gitCommonDir &&
    receipt.repositoryIdentity.leaseKey === authority.repositoryIdentity.leaseKey;
}

export function isReviewCheckoutProvisionReceiptDto(
  value: unknown,
): value is ReviewCheckoutProvisionReceiptDto {
  if (!isRecord(value) || !isReviewCheckoutAuthorityDto(value)) return false;
  return hasOnlyKeys(value, [
      'protocol', 'id', 'projectId', 'contractId', 'contractVersion',
      'producerRunId', 'reviewerRunId', 'repositoryIdentity', 'worktreePath',
      'ownedRootRealPath', 'sealedCommit', 'registrationCount',
      'registrationPath', 'headSha', 'detachedHead', 'trackedChanges',
      'stagedChanges', 'observedAt',
    ]) &&
    value.protocol === 'review-checkout-provision-v1' &&
    value.registrationCount === 1 &&
    value.registrationPath === value.worktreePath &&
    value.headSha === value.sealedCommit &&
    value.detachedHead === true &&
    value.trackedChanges === 0 &&
    value.stagedChanges === 0 &&
    Number.isSafeInteger(value.observedAt) &&
    (value.observedAt as number) >= 0;
}

export function isReviewCheckoutGitReceiptDto(
  value: unknown,
): value is ReviewCheckoutGitReceiptDto {
  if (!isRecord(value) || !isReviewCheckoutAuthorityDto(value)) return false;
  return hasOnlyKeys(value, [
      'protocol', 'id', 'projectId', 'contractId', 'contractVersion',
      'producerRunId', 'reviewerRunId', 'repositoryIdentity', 'worktreePath',
      'ownedRootRealPath', 'sealedCommit', 'branch', 'baseBranch', 'baseSha',
      'cleanStatus', 'registrationCount', 'registrationPath', 'headSha',
      'detachedHead', 'trackedChanges', 'stagedChanges', 'observedAt',
    ]) &&
    value.protocol === 'review-checkout-git-v1' &&
    value.branch === '(detached)' &&
    value.baseBranch === '(detached)' &&
    value.baseSha === value.sealedCommit &&
    value.cleanStatus === true &&
    value.registrationCount === 1 &&
    value.registrationPath === value.worktreePath &&
    value.headSha === value.sealedCommit &&
    value.detachedHead === true &&
    value.trackedChanges === 0 &&
    value.stagedChanges === 0 &&
    Number.isSafeInteger(value.observedAt) &&
    (value.observedAt as number) >= 0;
}

export function isReviewCheckoutTeardownReceiptDto(
  value: unknown,
): value is ReviewCheckoutTeardownReceiptDto {
  if (!isRecord(value) || !isReviewCheckoutAuthorityDto(value)) return false;
  return hasOnlyKeys(value, [
      'protocol', 'id', 'projectId', 'contractId', 'contractVersion',
      'producerRunId', 'reviewerRunId', 'repositoryIdentity', 'worktreePath',
      'ownedRootRealPath', 'sealedCommit', 'startedAt', 'finishedAt',
      'directoryAbsent', 'registrationAbsent', 'branchDeletion',
    ]) &&
    value.protocol === 'review-checkout-teardown-v1' &&
    Number.isSafeInteger(value.startedAt) &&
    (value.startedAt as number) >= 0 &&
    Number.isSafeInteger(value.finishedAt) &&
    (value.finishedAt as number) >= (value.startedAt as number) &&
    value.directoryAbsent === true &&
    value.registrationAbsent === true &&
    value.branchDeletion === 'not-applicable-detached';
}

export function isReviewCheckoutDto(value: unknown): value is ReviewCheckoutDto {
  if (!isRecord(value) || !isReviewCheckoutAuthorityDto(value) || !hasOnlyKeys(value, [
    'id', 'projectId', 'contractId', 'contractVersion', 'producerRunId',
    'reviewerRunId', 'repositoryIdentity', 'worktreePath', 'ownedRootRealPath',
    'sealedCommit', 'status', 'provisionReceipt', 'preparationReceipt',
    'readinessReceipt', 'teardownReceipt', 'cleanupError', 'createdAt',
    'updatedAt', 'destroyedAt',
  ])) return false;
  if (!isReviewCheckoutStatus(value.status)) return false;
  if (value.provisionReceipt !== null && (
    !isReviewCheckoutProvisionReceiptDto(value.provisionReceipt) ||
    !hasMatchingReviewCheckoutAuthorityDto(value, value.provisionReceipt)
  )) return false;
  if (value.teardownReceipt !== null && (
    !isReviewCheckoutTeardownReceiptDto(value.teardownReceipt) ||
    !hasMatchingReviewCheckoutAuthorityDto(value, value.teardownReceipt)
  )) return false;
  if (value.preparationReceipt !== null &&
      !isWorktreePhaseReceiptDto(value.preparationReceipt, 'preparation')) return false;
  if (value.readinessReceipt !== null &&
      !isWorktreePhaseReceiptDto(value.readinessReceipt, 'readiness')) return false;
  if (value.cleanupError !== null && !exactNonEmptyString(value.cleanupError)) return false;
  if (!Number.isSafeInteger(value.createdAt) || (value.createdAt as number) < 0 ||
      !Number.isSafeInteger(value.updatedAt) || (value.updatedAt as number) < 0 ||
      (value.updatedAt as number) < (value.createdAt as number)) return false;
  if (value.destroyedAt !== null &&
      (!Number.isSafeInteger(value.destroyedAt) ||
       (value.destroyedAt as number) !== (value.updatedAt as number))) return false;
  if (value.status === 'reserved') {
    return value.provisionReceipt === null && value.teardownReceipt === null &&
      value.preparationReceipt === null && value.readinessReceipt === null &&
      value.destroyedAt === null && value.cleanupError === null;
  }
  if (value.status === 'provisioned') {
    return value.provisionReceipt !== null && value.teardownReceipt === null &&
      value.destroyedAt === null && value.cleanupError === null;
  }
  if (value.status === 'teardown-pending') {
    return value.teardownReceipt === null && value.destroyedAt === null;
  }
  return value.teardownReceipt !== null && value.destroyedAt !== null &&
    value.cleanupError === null;
}

export function isAgentRunChangedReason(value: unknown): value is AgentRunChangedReason {
  return (
    typeof value === 'string' &&
    (AGENT_RUN_CHANGED_REASONS as readonly string[]).includes(value)
  );
}

export function isAgentRunDto(value: unknown): value is AgentRunDto {
  if (!isRecord(value)) return false;
  return (
    hasOnlyKeys(value, [
      'runId',
      'agentName',
      'selection',
      'specialistRevision',
      'nativeSessionIdPresent',
      'continuationState',
      'projectId',
      'dispatcherSessionId',
      'worktreeDir',
      'startedAt',
      'status',
      'lifecycleState',
      'result',
      'failureReason',
      'failureCause',
      'endedAt',
      'rev',
      'gitReceipt',
      'preparationReceipt',
      'readinessReceipt',
    ]) &&
    typeof value.runId === 'string' &&
    typeof value.agentName === 'string' &&
    (value.selection === null || isRuntimeSelection(value.selection)) &&
    (value.specialistRevision === null || exactNonEmptyString(value.specialistRevision)) &&
    typeof value.nativeSessionIdPresent === 'boolean' &&
    isSessionContinuationState(value.continuationState) &&
    validExecutionProvenance(value) &&
    typeof value.projectId === 'string' &&
    typeof value.dispatcherSessionId === 'string' &&
    typeof value.worktreeDir === 'string' &&
    typeof value.startedAt === 'number' &&
    isAgentRunStatus(value.status) &&
    (value.lifecycleState === null || isRunLifecycleState(value.lifecycleState)) &&
    typeof value.result === 'string' &&
    (value.failureReason === null || typeof value.failureReason === 'string') &&
    (value.failureCause === null || typeof value.failureCause === 'string') &&
    (value.endedAt === null || typeof value.endedAt === 'number') &&
    typeof value.rev === 'number' &&
    isOptionalGitReceipt(value.gitReceipt) &&
    isOptionalPhaseReceipt(value.preparationReceipt, 'preparation') &&
    isOptionalPhaseReceipt(value.readinessReceipt, 'readiness')
  );
}

function isOptionalGitReceipt(value: unknown): boolean {
  return value === undefined || value === null || isReviewCheckoutGitReceiptDto(value) || (
    isRecord(value) &&
    hasOnlyKeys(value, [
      'worktreePath',
      'branch',
      'baseBranch',
      'baseSha',
      'cleanStatus',
      'repositoryIdentity',
    ]) &&
    typeof value.worktreePath === 'string' &&
    typeof value.branch === 'string' &&
    typeof value.baseBranch === 'string' &&
    typeof value.baseSha === 'string' &&
    typeof value.cleanStatus === 'boolean' &&
    (
      value.repositoryIdentity === undefined ||
      value.repositoryIdentity === null ||
      isRepositoryIdentityReceiptDto(value.repositoryIdentity)
    )
  );
}

export function isRepositoryIdentityReceiptDto(
  value: unknown,
): value is RepositoryIdentityReceiptDto {
  return isRecord(value) &&
    hasOnlyKeys(value, ['protocol', 'gitCommonDir', 'leaseKey']) &&
    value.protocol === 'git-common-dir-v1' &&
    exactNonEmptyString(value.gitCommonDir) &&
    typeof value.leaseKey === 'string' &&
    /^sha256:[0-9a-f]{64}$/.test(value.leaseKey);
}

function isCommandStep(value: unknown): value is WorktreeCommandStepDto {
  return isRecord(value) &&
    hasOnlyKeys(value, [
      'command',
      'exitCode',
      'durationMs',
      'stdoutTail',
      'stderrTail',
      'timedOut',
    ]) &&
    typeof value.command === 'string' &&
    value.command.length > 0 &&
    value.command === value.command.trim() &&
    Number.isSafeInteger(value.exitCode) &&
    Number.isSafeInteger(value.durationMs) &&
    (value.durationMs as number) >= 0 &&
    typeof value.stdoutTail === 'string' &&
    typeof value.stderrTail === 'string' &&
    typeof value.timedOut === 'boolean';
}

export function isWorktreePhaseReceiptDto(
  value: unknown,
  phase?: WorktreePhaseDto,
): value is WorktreePhaseReceiptDto {
  if (!isRecord(value) || (value.phase !== 'preparation' && value.phase !== 'readiness')) {
    return false;
  }
  if (phase !== undefined && value.phase !== phase) return false;
  if (!Number.isSafeInteger(value.finishedAt) || (value.finishedAt as number) < 0) return false;

  if (value.outcome === 'executed') {
    if (!hasOnlyKeys(value, ['phase', 'outcome', 'ok', 'steps', 'finishedAt'])) return false;
    if (typeof value.ok !== 'boolean' || !Array.isArray(value.steps) || value.steps.length === 0) {
      return false;
    }
    if (!value.steps.every(isCommandStep)) return false;
    const commandsPassed = value.steps.every((step) => step.exitCode === 0 && !step.timedOut);
    return value.ok === commandsPassed;
  }

  if (value.outcome !== 'not-required' || value.ok !== true || !Array.isArray(value.steps) || value.steps.length !== 0) {
    return false;
  }
  if (value.reason === 'no-commands-configured') {
    return hasOnlyKeys(value, ['phase', 'outcome', 'reason', 'ok', 'steps', 'finishedAt']);
  }
  return value.phase === 'preparation' &&
    value.reason === 'existing-worktree-preparation' &&
    hasOnlyKeys(value, [
      'phase',
      'outcome',
      'reason',
      'inheritedFromRunId',
      'ok',
      'steps',
      'finishedAt',
    ]) &&
    isUlid(value.inheritedFromRunId);
}

function isOptionalPhaseReceipt(
  value: unknown,
  phase: WorktreePhaseDto,
): boolean {
  return value === undefined || value === null || isWorktreePhaseReceiptDto(value, phase);
}

export function isAgentRunChangedLivePayload(
  value: unknown,
): value is AgentRunChangedLivePayload {
  if (
    !isRecord(value) ||
    !hasOnlyKeys(value, ['reason', 'run', 'pendingAskId']) ||
    !isAgentRunChangedReason(value.reason)
  ) return false;
  if (!isAgentRunDto(value.run)) return false;
  if (
    value.pendingAskId !== undefined &&
    value.pendingAskId !== null &&
    typeof value.pendingAskId !== 'string'
  ) {
    return false;
  }
  return validLiveReason(value);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function hasOnlyKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  const allowed = new Set(keys);
  return Object.keys(value).every((key) => allowed.has(key));
}

function exactNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && value === value.trim();
}

function validExecutionProvenance(value: Record<string, unknown>): boolean {
  if (value.continuationState === 'legacy-unavailable') {
    return value.selection === null &&
      value.specialistRevision === null &&
      value.nativeSessionIdPresent === false;
  }
  if (!isRuntimeSelection(value.selection) || !exactNonEmptyString(value.specialistRevision)) {
    return false;
  }
  if (value.continuationState === 'clean-pending') {
    return value.nativeSessionIdPresent === false &&
      (value.status === 'queued' || value.status === 'spawning' ||
        value.status === 'failed' || value.status === 'cancelled');
  }
  if (value.continuationState === 'resume-pending') {
    return value.nativeSessionIdPresent === true &&
      (value.status === 'queued' || value.status === 'spawning' || value.status === 'paused' ||
        value.status === 'failed' || value.status === 'cancelled');
  }
  if (value.continuationState === 'resume-failed') {
    return value.nativeSessionIdPresent === true &&
      (value.status === 'spawning' || value.status === 'paused' ||
        value.status === 'failed' || value.status === 'cancelled');
  }
  if (
    value.continuationState === 'clean-started' ||
    value.continuationState === 'native-resumed'
  ) {
    return value.nativeSessionIdPresent === true &&
      (value.status === 'spawning' || value.status === 'running' ||
        value.status === 'paused' || value.status === 'completed' ||
        value.status === 'failed' || value.status === 'cancelled');
  }
  return false;
}

function validLiveReason(value: Record<string, unknown>): boolean {
  const run = value.run as AgentRunDto;
  if (value.reason === 'paused') {
    return run.status === 'paused' && exactNonEmptyString(value.pendingAskId);
  }
  if (value.pendingAskId !== undefined && value.pendingAskId !== null) return false;
  switch (value.reason) {
    case 'queued': return run.status === 'queued';
    case 'spawning': return run.status === 'spawning';
    case 'running': return run.status === 'running';
    case 'resumed': return run.status === 'spawning';
    case 'stalled': return run.status === 'spawning' || run.status === 'running';
    case 'completed': return run.status === 'completed';
    case 'failed': return run.status === 'failed';
    case 'cancelled': return run.status === 'cancelled';
    case 'reconciled': return true;
    default: return false;
  }
}
