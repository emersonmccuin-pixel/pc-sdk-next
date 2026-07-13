// Canonical worktree type — db's `WorktreeRow` aliases this
// (packages/db/src/repos/worktrees.ts). Binding fields (project/run/contract/
// branch provenance) are nullable — legacy rows predate them.

import { isUlid, type ULID } from './ulid.ts';

/** 'stranded' is DURABLE (docs/worktree-lifecycle.md 'Recovery'): the row's
 *  dir is gone or no live run owns it. A re-scan that no longer finds it
 *  stranded flips it back to 'active' (false positives self-heal). */
export type WorktreeStatus = 'active' | 'destroyed' | 'stranded';

export type WorktreeStrandedReason = 'dir-missing' | 'no-live-run';

export interface Worktree {
  id: ULID;
  /** Branch name == worktree dir name (the rig's convention, e.g. `wi-<id>` or `run-<short>`). */
  name: string;
  /** Absolute filesystem path to the worktree dir. */
  path: string;
  status: WorktreeStatus;
  /** Run-binding provenance (doc 'Ownership unit'). NULL = legacy rows. */
  projectId: ULID | null;
  agentRunId: ULID | null;
  /** Stamped after contract creation (contract is minted post-provision). */
  contractId: ULID | null;
  branch: string | null;
  baseBranch: string | null;
  baseSha: string | null;
  strandedReason: WorktreeStrandedReason | null;
  strandedAt: number | null;
  createdAt: number;
  destroyedAt: number | null;
}

// ── Worktree profile (docs/worktree-lifecycle.md 'Provisioning and readiness') ─

/** Per-project provisioning profile, stored in `projects.worktree_profile`
 *  (nullable JSON). NULL/empty profile == exactly the profile-less behavior. */
export interface WorktreeProfile {
  /** Provisioning base. Unset = the main/master probe. */
  baseBranch?: string;
  /** Deterministic setup run IN the worktree after `git worktree add`,
   *  before any agent phase. Sequential; first nonzero exit fails provisioning. */
  setupCommands: string[];
  /** Positive build/review prerequisite checks — run on every dispatch. */
  readinessCommands: string[];
  /** Best-effort teardown steps run in the worktree before removal. */
  cleanupCommands: string[];
  // allowedLocalInputs: LocalInputPolicy[] — DEFERRED. Secret/local-input
  // injection needs its own allowlist policy type, transcript scrubbing, and
  // accidental-commit checks (doc rules); do not add ad hoc fields here.
}

export const WORKTREE_PROFILE_MAX_COMMANDS = 20;
export const WORKTREE_PROFILE_MAX_COMMAND_CHARS = 2000;

/** Git ref-name shape for `baseBranch` (mirrors INTEGRATION_BRANCH_RE). */
export const WORKTREE_BASE_BRANCH_RE = /^[A-Za-z0-9][A-Za-z0-9._/-]*$/;

export type WorktreeProfileParse =
  | { ok: true; profile: WorktreeProfile | null }
  | { ok: false; errors: string[] };

/** Validate + normalize a stored/submitted profile. `null`/`undefined` and a
 *  fully empty profile both normalize to `profile: null` (today's behavior).
 *  Fail closed on garbage — a run must never start on a half-read profile. */
export function parseWorktreeProfile(value: unknown): WorktreeProfileParse {
  if (value === null || value === undefined) return { ok: true, profile: null };
  if (typeof value !== 'object' || Array.isArray(value)) {
    return { ok: false, errors: ['worktree profile must be an object'] };
  }
  const raw = value as Record<string, unknown>;
  const errors: string[] = [];

  let baseBranch: string | undefined;
  if (raw.baseBranch !== undefined && raw.baseBranch !== null) {
    if (typeof raw.baseBranch !== 'string' || !WORKTREE_BASE_BRANCH_RE.test(raw.baseBranch.trim())) {
      errors.push('baseBranch must be a valid git branch name');
    } else {
      baseBranch = raw.baseBranch.trim();
    }
  }

  const readCommands = (key: 'setupCommands' | 'readinessCommands' | 'cleanupCommands'): string[] => {
    const list = raw[key];
    if (list === undefined || list === null) return [];
    if (!Array.isArray(list)) {
      errors.push(`${key} must be an array of commands`);
      return [];
    }
    if (list.length > WORKTREE_PROFILE_MAX_COMMANDS) {
      errors.push(`${key} exceeds the ${WORKTREE_PROFILE_MAX_COMMANDS}-command cap`);
      return [];
    }
    const out: string[] = [];
    for (const item of list) {
      if (typeof item !== 'string' || item.trim().length === 0) {
        errors.push(`${key} entries must be non-empty strings`);
        return [];
      }
      if (item.length > WORKTREE_PROFILE_MAX_COMMAND_CHARS) {
        errors.push(`${key} entry exceeds ${WORKTREE_PROFILE_MAX_COMMAND_CHARS} chars`);
        return [];
      }
      out.push(item.trim());
    }
    return out;
  };

  const setupCommands = readCommands('setupCommands');
  const readinessCommands = readCommands('readinessCommands');
  const cleanupCommands = readCommands('cleanupCommands');
  if (errors.length > 0) return { ok: false, errors };
  if (!baseBranch && setupCommands.length === 0 && readinessCommands.length === 0 && cleanupCommands.length === 0) {
    return { ok: true, profile: null };
  }
  return {
    ok: true,
    profile: {
      ...(baseBranch !== undefined ? { baseBranch } : {}),
      setupCommands,
      readinessCommands,
      cleanupCommands,
    },
  };
}

// ── Provisioning receipts (doc: Git / preparation / readiness receipts) ──────

/** Stable protocol discriminator for the canonical local-repository identity
 *  frozen into every new Git provisioning receipt. */
export const REPOSITORY_IDENTITY_PROTOCOL = 'git-common-dir-v1' as const;

/** Immutable authority receipt for one physical local Git repository.
 *
 * `gitCommonDir` is the native real path derived from Git's absolute common-
 * directory result. `leaseKey` is the protocol-stable digest used by the
 * cooperative same-host lease. Both are independently revalidated before a
 * later repository-writing authority door may act. */
export interface RepositoryIdentityReceipt {
  readonly protocol: typeof REPOSITORY_IDENTITY_PROTOCOL;
  readonly gitCommonDir: string;
  readonly leaseKey: string;
}

// ── Explicit worktree abandonment receipts (DL-002) ────────────────────────

export const WORKTREE_ABANDONMENT_PREVIEW_PROTOCOL =
  'worktree-abandonment-preview-v1' as const;
export const WORKTREE_ABANDONMENT_PROTOCOL = 'worktree-abandonment-v1' as const;
export const WORKTREE_ABANDONMENT_TEARDOWN_PROTOCOL =
  'worktree-abandonment-teardown-v1' as const;
export const WORKTREE_ABANDONMENT_CHANGED_PATHS_MAX = 50;
export const WORKTREE_ABANDONMENT_REASON_MAX_CHARS = 1000;

export type WorktreeAbandonmentIntegrationState =
  | 'unmerged'
  | 'no-exclusive-commits';

export interface WorktreeAbandonmentPresentState {
  readonly directory: 'present';
  readonly registration: 'registered';
  readonly status: 'clean' | 'dirty';
  readonly staged: number;
  readonly unstaged: number;
  readonly untracked: number;
  readonly worktreeStateDigest: string;
  readonly changedPaths: string[];
  readonly ignoredContents: 'uninspected';
}

export interface WorktreeAbandonmentMissingState {
  readonly directory: 'missing';
  readonly registration: 'registered' | 'absent';
  readonly status: 'unavailable';
  readonly worktreeStateDigest: string;
  readonly changedPaths: [];
  readonly ignoredContents: 'uninspected';
}

export type WorktreeAbandonmentState =
  | WorktreeAbandonmentPresentState
  | WorktreeAbandonmentMissingState;

export interface WorktreeAbandonmentPreview {
  readonly protocol: typeof WORKTREE_ABANDONMENT_PREVIEW_PROTOCOL;
  readonly projectId: ULID;
  readonly contractId: ULID;
  readonly contractVersion: number;
  readonly producerRunId: ULID;
  readonly worktreeId: ULID;
  readonly worktreeStatus: 'active' | 'stranded';
  readonly worktreePath: string;
  readonly branch: string;
  readonly branchTip: string;
  readonly baseBranch: string;
  readonly validatedBaseSha: string;
  readonly targetTip: string;
  readonly integrationState: WorktreeAbandonmentIntegrationState;
  readonly repositoryIdentity: RepositoryIdentityReceipt;
  readonly worktreeState: WorktreeAbandonmentState;
  readonly previewDigest: string;
}

export interface WorktreeAbandonmentReceipt {
  readonly protocol: typeof WORKTREE_ABANDONMENT_PROTOCOL;
  readonly requestId: string;
  readonly approvedBy: 'user';
  readonly approvalSurface: 'browser';
  readonly approvalReason: 'explicit-browser-confirmation';
  readonly approvedAt: number;
  readonly reason: string | null;
  readonly approvedContractVersion: number;
  readonly projectId: ULID;
  readonly contractId: ULID;
  readonly producerRunId: ULID;
  readonly worktreeId: ULID;
  readonly worktreeStatus: 'active' | 'stranded';
  readonly repositoryIdentity: RepositoryIdentityReceipt;
  readonly worktreePath: string;
  readonly branch: string;
  readonly branchTip: string;
  readonly baseBranch: string;
  readonly validatedBaseSha: string;
  readonly targetTip: string;
  readonly integrationState: WorktreeAbandonmentIntegrationState;
  readonly worktreeState: WorktreeAbandonmentPresentState;
  readonly previewDigest: string;
}

export interface WorktreeAbandonmentTeardownReceipt {
  readonly protocol: typeof WORKTREE_ABANDONMENT_TEARDOWN_PROTOCOL;
  readonly authorityRequestId: string;
  readonly startedAt: number;
  readonly finishedAt: number;
  readonly repositoryIdentity: RepositoryIdentityReceipt;
  readonly worktreePath: string;
  readonly branch: string;
  readonly approvedBranchTip: string;
  readonly observedBranchTip: string;
  readonly directoryAbsent: true;
  readonly registrationAbsent: true;
  readonly branchPreserved: true;
}

function isSha256Digest(value: unknown): value is string {
  return typeof value === 'string' && /^sha256:[0-9a-f]{64}$/u.test(value);
}

function isGitObjectId(value: unknown): value is string {
  return typeof value === 'string' && /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/u.test(value);
}

function isUuidV4(value: unknown): value is string {
  return typeof value === 'string' &&
    /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u.test(value);
}

function isNonEmptyTrimmedString(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && value === value.trim();
}

function isAbandonmentIntegrationState(
  value: unknown,
): value is WorktreeAbandonmentIntegrationState {
  return value === 'unmerged' || value === 'no-exclusive-commits';
}

function isChangedPathSummary(value: unknown): value is string[] {
  if (!Array.isArray(value) || value.length > WORKTREE_ABANDONMENT_CHANGED_PATHS_MAX) {
    return false;
  }
  const unique = new Set<string>();
  for (const path of value) {
    if (
      typeof path !== 'string' ||
      path.length === 0 ||
      path.length > 2000 ||
      path.includes('\0')
    ) return false;
    unique.add(path);
  }
  return unique.size === value.length;
}

export function isWorktreeAbandonmentState(
  value: unknown,
): value is WorktreeAbandonmentState {
  if (!isRecord(value)) return false;
  if (value.directory === 'present') {
    if (!hasOnlyKeys(value, [
      'directory',
      'registration',
      'status',
      'staged',
      'unstaged',
      'untracked',
      'worktreeStateDigest',
      'changedPaths',
      'ignoredContents',
    ])) return false;
    if (
      value.registration !== 'registered' ||
      (value.status !== 'clean' && value.status !== 'dirty') ||
      !isNonNegativeSafeInteger(value.staged) ||
      !isNonNegativeSafeInteger(value.unstaged) ||
      !isNonNegativeSafeInteger(value.untracked) ||
      !isSha256Digest(value.worktreeStateDigest) ||
      !isChangedPathSummary(value.changedPaths) ||
      value.ignoredContents !== 'uninspected'
    ) return false;
    const count = value.staged + value.unstaged + value.untracked;
    return value.status === (count === 0 ? 'clean' : 'dirty') &&
      (count !== 0 || value.changedPaths.length === 0);
  }
  return value.directory === 'missing' &&
    hasOnlyKeys(value, [
      'directory',
      'registration',
      'status',
      'worktreeStateDigest',
      'changedPaths',
      'ignoredContents',
    ]) &&
    (value.registration === 'registered' || value.registration === 'absent') &&
    value.status === 'unavailable' &&
    isSha256Digest(value.worktreeStateDigest) &&
    Array.isArray(value.changedPaths) &&
    value.changedPaths.length === 0 &&
    value.ignoredContents === 'uninspected';
}

export function isWorktreeAbandonmentPreview(
  value: unknown,
): value is WorktreeAbandonmentPreview {
  return isRecord(value) &&
    hasOnlyKeys(value, [
      'protocol',
      'projectId',
      'contractId',
      'contractVersion',
      'producerRunId',
      'worktreeId',
      'worktreeStatus',
      'worktreePath',
      'branch',
      'branchTip',
      'baseBranch',
      'validatedBaseSha',
      'targetTip',
      'integrationState',
      'repositoryIdentity',
      'worktreeState',
      'previewDigest',
    ]) &&
    value.protocol === WORKTREE_ABANDONMENT_PREVIEW_PROTOCOL &&
    isAppMintedUlid(value.projectId) &&
    isAppMintedUlid(value.contractId) &&
    isNonNegativeSafeInteger(value.contractVersion) &&
    value.contractVersion > 0 &&
    isAppMintedUlid(value.producerRunId) &&
    isAppMintedUlid(value.worktreeId) &&
    (value.worktreeStatus === 'active' || value.worktreeStatus === 'stranded') &&
    isNonEmptyTrimmedString(value.worktreePath) &&
    isNonEmptyTrimmedString(value.branch) &&
    WORKTREE_BASE_BRANCH_RE.test(value.branch) &&
    isGitObjectId(value.branchTip) &&
    isNonEmptyTrimmedString(value.baseBranch) &&
    WORKTREE_BASE_BRANCH_RE.test(value.baseBranch) &&
    isGitObjectId(value.validatedBaseSha) &&
    isGitObjectId(value.targetTip) &&
    isAbandonmentIntegrationState(value.integrationState) &&
    isRepositoryIdentityReceipt(value.repositoryIdentity) &&
    isWorktreeAbandonmentState(value.worktreeState) &&
    isSha256Digest(value.previewDigest);
}

export function isWorktreeAbandonmentReceipt(
  value: unknown,
): value is WorktreeAbandonmentReceipt {
  return isRecord(value) &&
    hasOnlyKeys(value, [
      'protocol',
      'requestId',
      'approvedBy',
      'approvalSurface',
      'approvalReason',
      'approvedAt',
      'reason',
      'approvedContractVersion',
      'projectId',
      'contractId',
      'producerRunId',
      'worktreeId',
      'worktreeStatus',
      'repositoryIdentity',
      'worktreePath',
      'branch',
      'branchTip',
      'baseBranch',
      'validatedBaseSha',
      'targetTip',
      'integrationState',
      'worktreeState',
      'previewDigest',
    ]) &&
    value.protocol === WORKTREE_ABANDONMENT_PROTOCOL &&
    isUuidV4(value.requestId) &&
    value.approvedBy === 'user' &&
    value.approvalSurface === 'browser' &&
    value.approvalReason === 'explicit-browser-confirmation' &&
    isNonNegativeSafeInteger(value.approvedAt) &&
    (
      value.reason === null ||
      (
        isNonEmptyTrimmedString(value.reason) &&
        value.reason.length <= WORKTREE_ABANDONMENT_REASON_MAX_CHARS
      )
    ) &&
    isNonNegativeSafeInteger(value.approvedContractVersion) &&
    value.approvedContractVersion > 0 &&
    isAppMintedUlid(value.projectId) &&
    isAppMintedUlid(value.contractId) &&
    isAppMintedUlid(value.producerRunId) &&
    isAppMintedUlid(value.worktreeId) &&
    (value.worktreeStatus === 'active' || value.worktreeStatus === 'stranded') &&
    isRepositoryIdentityReceipt(value.repositoryIdentity) &&
    isNonEmptyTrimmedString(value.worktreePath) &&
    isNonEmptyTrimmedString(value.branch) &&
    WORKTREE_BASE_BRANCH_RE.test(value.branch) &&
    isGitObjectId(value.branchTip) &&
    isNonEmptyTrimmedString(value.baseBranch) &&
    WORKTREE_BASE_BRANCH_RE.test(value.baseBranch) &&
    isGitObjectId(value.validatedBaseSha) &&
    isGitObjectId(value.targetTip) &&
    isAbandonmentIntegrationState(value.integrationState) &&
    isWorktreeAbandonmentState(value.worktreeState) &&
    value.worktreeState.directory === 'present' &&
    isSha256Digest(value.previewDigest);
}

export function isWorktreeAbandonmentTeardownReceipt(
  value: unknown,
): value is WorktreeAbandonmentTeardownReceipt {
  return isRecord(value) &&
    hasOnlyKeys(value, [
      'protocol',
      'authorityRequestId',
      'startedAt',
      'finishedAt',
      'repositoryIdentity',
      'worktreePath',
      'branch',
      'approvedBranchTip',
      'observedBranchTip',
      'directoryAbsent',
      'registrationAbsent',
      'branchPreserved',
    ]) &&
    value.protocol === WORKTREE_ABANDONMENT_TEARDOWN_PROTOCOL &&
    isUuidV4(value.authorityRequestId) &&
    isNonNegativeSafeInteger(value.startedAt) &&
    isNonNegativeSafeInteger(value.finishedAt) &&
    value.finishedAt >= value.startedAt &&
    isRepositoryIdentityReceipt(value.repositoryIdentity) &&
    isNonEmptyTrimmedString(value.worktreePath) &&
    isNonEmptyTrimmedString(value.branch) &&
    WORKTREE_BASE_BRANCH_RE.test(value.branch) &&
    isGitObjectId(value.approvedBranchTip) &&
    isGitObjectId(value.observedBranchTip) &&
    value.directoryAbsent === true &&
    value.registrationAbsent === true &&
    value.branchPreserved === true;
}

export function isMatchingWorktreeAbandonmentTeardown(
  authority: unknown,
  settlement: unknown,
): settlement is WorktreeAbandonmentTeardownReceipt {
  if (
    !isWorktreeAbandonmentReceipt(authority) ||
    !isWorktreeAbandonmentTeardownReceipt(settlement)
  ) return false;
  return settlement.authorityRequestId === authority.requestId &&
    settlement.worktreePath === authority.worktreePath &&
    settlement.branch === authority.branch &&
    settlement.approvedBranchTip === authority.branchTip &&
    settlement.observedBranchTip === authority.branchTip &&
    settlement.repositoryIdentity.protocol === authority.repositoryIdentity.protocol &&
    settlement.repositoryIdentity.gitCommonDir === authority.repositoryIdentity.gitCommonDir &&
    settlement.repositoryIdentity.leaseKey === authority.repositoryIdentity.leaseKey;
}

export function isRepositoryIdentityReceipt(value: unknown): value is RepositoryIdentityReceipt {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  const keys = Object.keys(record).sort();
  return (
    keys.length === 3 &&
    keys[0] === 'gitCommonDir' &&
    keys[1] === 'leaseKey' &&
    keys[2] === 'protocol' &&
    record.protocol === REPOSITORY_IDENTITY_PROTOCOL &&
    typeof record.gitCommonDir === 'string' &&
    record.gitCommonDir.length > 0 &&
    record.gitCommonDir === record.gitCommonDir.trim() &&
    typeof record.leaseKey === 'string' &&
    /^sha256:[0-9a-f]{64}$/u.test(record.leaseKey)
  );
}

/** Git receipt — recorded after `git worktree add`. `cleanStatus` is the
 *  positive clean-initial-status check; provisioning refuses when false. */
export interface WorktreeGitReceipt {
  worktreePath: string;
  branch: string;
  baseBranch: string;
  baseSha: string;
  cleanStatus: boolean;
  /** Required on every new receipt; legacy persisted receipts without it do
   *  not carry repository-mutation authority. */
  readonly repositoryIdentity: RepositoryIdentityReceipt;
}

// ── Independent-review checkout authority (DL-004) ────────────────────────────

export const REVIEW_CHECKOUT_PROVISION_PROTOCOL =
  'review-checkout-provision-v1' as const;
export const REVIEW_CHECKOUT_GIT_PROTOCOL = 'review-checkout-git-v1' as const;
export const REVIEW_CHECKOUT_TEARDOWN_PROTOCOL =
  'review-checkout-teardown-v1' as const;

export const REVIEW_CHECKOUT_STATUSES = [
  'reserved',
  'provisioned',
  'teardown-pending',
  'destroyed',
] as const;
export type ReviewCheckoutStatus = (typeof REVIEW_CHECKOUT_STATUSES)[number];

/** Immutable workspace authority persisted before `git worktree add`. */
export interface ReviewCheckoutAuthority {
  readonly id: ULID;
  readonly projectId: ULID;
  readonly contractId: ULID;
  readonly contractVersion: number;
  readonly producerRunId: ULID;
  readonly reviewerRunId: ULID;
  readonly repositoryIdentity: RepositoryIdentityReceipt;
  readonly worktreePath: string;
  readonly ownedRootRealPath: string;
  readonly sealedCommit: string;
}

/** Positive observation of the exact detached checkout. This is deliberately
 * checkout-specific: a producer's branch receipt cannot satisfy it. */
export interface ReviewCheckoutProvisionReceipt extends ReviewCheckoutAuthority {
  readonly protocol: typeof REVIEW_CHECKOUT_PROVISION_PROTOCOL;
  readonly registrationCount: 1;
  readonly registrationPath: string;
  readonly headSha: string;
  readonly detachedHead: true;
  readonly trackedChanges: 0;
  readonly stagedChanges: 0;
  readonly observedAt: number;
}

/** Agent-run Git receipt for an independent reviewer. It deliberately remains
 * structurally compatible with WorktreeGitReceipt so existing repository-
 * identity consumers stay provider-neutral, while its discriminator and full
 * authority prevent a producer receipt from being substituted. */
export interface ReviewCheckoutGitReceipt extends ReviewCheckoutAuthority {
  readonly protocol: typeof REVIEW_CHECKOUT_GIT_PROTOCOL;
  readonly worktreePath: string;
  readonly branch: '(detached)';
  readonly baseBranch: '(detached)';
  readonly baseSha: string;
  readonly cleanStatus: true;
  readonly registrationCount: 1;
  readonly registrationPath: string;
  readonly headSha: string;
  readonly detachedHead: true;
  readonly trackedChanges: 0;
  readonly stagedChanges: 0;
  readonly observedAt: number;
}

/** Positive teardown settlement. Detached review checkouts never own a branch
 * and therefore never authorize branch deletion. */
export interface ReviewCheckoutTeardownReceipt extends ReviewCheckoutAuthority {
  readonly protocol: typeof REVIEW_CHECKOUT_TEARDOWN_PROTOCOL;
  readonly startedAt: number;
  readonly finishedAt: number;
  readonly directoryAbsent: true;
  readonly registrationAbsent: true;
  readonly branchDeletion: 'not-applicable-detached';
}

export interface ReviewCheckout extends ReviewCheckoutAuthority {
  readonly status: ReviewCheckoutStatus;
  readonly provisionReceipt: ReviewCheckoutProvisionReceipt | null;
  readonly preparationReceipt: WorktreePhaseReceipt | null;
  readonly readinessReceipt: WorktreePhaseReceipt | null;
  readonly teardownReceipt: ReviewCheckoutTeardownReceipt | null;
  readonly cleanupError: string | null;
  readonly createdAt: number;
  readonly updatedAt: number;
  readonly destroyedAt: number | null;
}

export function isReviewCheckoutAuthority(value: unknown): value is ReviewCheckoutAuthority {
  return isRecord(value) &&
    isAppMintedUlid(value.id) &&
    isAppMintedUlid(value.projectId) &&
    isAppMintedUlid(value.contractId) &&
    isNonNegativeSafeInteger(value.contractVersion) &&
    value.contractVersion > 0 &&
    isAppMintedUlid(value.producerRunId) &&
    isAppMintedUlid(value.reviewerRunId) &&
    isRepositoryIdentityReceipt(value.repositoryIdentity) &&
    isNonEmptyTrimmedString(value.worktreePath) &&
    isNonEmptyTrimmedString(value.ownedRootRealPath) &&
    isGitObjectId(value.sealedCommit);
}

function hasMatchingReviewCheckoutAuthority(
  authority: ReviewCheckoutAuthority,
  evidence: ReviewCheckoutAuthority,
): boolean {
  return evidence.id === authority.id &&
    evidence.projectId === authority.projectId &&
    evidence.contractId === authority.contractId &&
    evidence.contractVersion === authority.contractVersion &&
    evidence.producerRunId === authority.producerRunId &&
    evidence.reviewerRunId === authority.reviewerRunId &&
    evidence.worktreePath === authority.worktreePath &&
    evidence.ownedRootRealPath === authority.ownedRootRealPath &&
    evidence.sealedCommit === authority.sealedCommit &&
    evidence.repositoryIdentity.protocol === authority.repositoryIdentity.protocol &&
    evidence.repositoryIdentity.gitCommonDir === authority.repositoryIdentity.gitCommonDir &&
    evidence.repositoryIdentity.leaseKey === authority.repositoryIdentity.leaseKey;
}

export function isReviewCheckoutProvisionReceipt(
  value: unknown,
): value is ReviewCheckoutProvisionReceipt {
  if (!isRecord(value) || !isReviewCheckoutAuthority(value)) return false;
  return hasOnlyKeys(value, [
      'protocol', 'id', 'projectId', 'contractId', 'contractVersion',
      'producerRunId', 'reviewerRunId', 'repositoryIdentity', 'worktreePath',
      'ownedRootRealPath', 'sealedCommit', 'registrationCount',
      'registrationPath', 'headSha', 'detachedHead', 'trackedChanges',
      'stagedChanges', 'observedAt',
    ]) &&
    value.protocol === REVIEW_CHECKOUT_PROVISION_PROTOCOL &&
    value.registrationCount === 1 &&
    value.registrationPath === value.worktreePath &&
    value.headSha === value.sealedCommit &&
    value.detachedHead === true &&
    value.trackedChanges === 0 &&
    value.stagedChanges === 0 &&
    isNonNegativeSafeInteger(value.observedAt);
}

export function isReviewCheckoutGitReceipt(
  value: unknown,
): value is ReviewCheckoutGitReceipt {
  if (!isRecord(value) || !isReviewCheckoutAuthority(value)) return false;
  return hasOnlyKeys(value, [
      'protocol', 'id', 'projectId', 'contractId', 'contractVersion',
      'producerRunId', 'reviewerRunId', 'repositoryIdentity', 'worktreePath',
      'ownedRootRealPath', 'sealedCommit', 'branch', 'baseBranch', 'baseSha',
      'cleanStatus', 'registrationCount', 'registrationPath', 'headSha',
      'detachedHead', 'trackedChanges', 'stagedChanges', 'observedAt',
    ]) &&
    value.protocol === REVIEW_CHECKOUT_GIT_PROTOCOL &&
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
    isNonNegativeSafeInteger(value.observedAt);
}

export function isReviewCheckoutTeardownReceipt(
  value: unknown,
): value is ReviewCheckoutTeardownReceipt {
  if (!isRecord(value) || !isReviewCheckoutAuthority(value)) return false;
  return hasOnlyKeys(value, [
      'protocol', 'id', 'projectId', 'contractId', 'contractVersion',
      'producerRunId', 'reviewerRunId', 'repositoryIdentity', 'worktreePath',
      'ownedRootRealPath', 'sealedCommit', 'startedAt', 'finishedAt',
      'directoryAbsent', 'registrationAbsent', 'branchDeletion',
    ]) &&
    value.protocol === REVIEW_CHECKOUT_TEARDOWN_PROTOCOL &&
    isNonNegativeSafeInteger(value.startedAt) &&
    isNonNegativeSafeInteger(value.finishedAt) &&
    value.finishedAt >= value.startedAt &&
    value.directoryAbsent === true &&
    value.registrationAbsent === true &&
    value.branchDeletion === 'not-applicable-detached';
}

export function isMatchingReviewCheckoutProvision(
  authority: ReviewCheckoutAuthority,
  receipt: unknown,
): receipt is ReviewCheckoutProvisionReceipt {
  return isReviewCheckoutAuthority(authority) &&
    isReviewCheckoutProvisionReceipt(receipt) &&
    hasMatchingReviewCheckoutAuthority(authority, receipt);
}

export function isMatchingReviewCheckoutTeardown(
  authority: ReviewCheckoutAuthority,
  receipt: unknown,
): receipt is ReviewCheckoutTeardownReceipt {
  return isReviewCheckoutAuthority(authority) &&
    isReviewCheckoutTeardownReceipt(receipt) &&
    hasMatchingReviewCheckoutAuthority(authority, receipt);
}

/** Complete authority required immediately before reviewer runtime mint. */
export function isReviewCheckoutRuntimeReady(
  checkout: ReviewCheckout,
): boolean {
  return checkout.status === 'provisioned' &&
    isMatchingReviewCheckoutProvision(checkout, checkout.provisionReceipt) &&
    isPositiveWorktreePhaseReceipt(checkout.preparationReceipt, 'preparation') &&
    isPositiveWorktreePhaseReceipt(checkout.readinessReceipt, 'readiness') &&
    checkout.teardownReceipt === null &&
    checkout.cleanupError === null &&
    checkout.destroyedAt === null;
}

/** One executed profile command, output bounded to a tail. */
export interface WorktreeCommandStep {
  command: string;
  exitCode: number;
  durationMs: number;
  stdoutTail: string;
  stderrTail: string;
  timedOut: boolean;
}

export type WorktreePhase = 'preparation' | 'readiness';

export type WorktreePhaseNotRequiredReason =
  | 'no-commands-configured'
  | 'existing-worktree-preparation';

/** A command-bearing phase receipt. Failed execution is still durable
 * evidence, but only an `ok: true` receipt is positive authority. */
export interface WorktreePhaseExecutedReceipt {
  phase: WorktreePhase;
  outcome: 'executed';
  ok: boolean;
  /** Executed receipts are command-bearing; an empty list proves nothing. */
  steps: WorktreeCommandStep[];
  finishedAt: number;
}

/** Exact positive no-op for a phase whose configured command list is empty. */
export interface WorktreePhaseNoCommandsReceipt {
  phase: WorktreePhase;
  outcome: 'not-required';
  reason: 'no-commands-configured';
  ok: true;
  steps: [];
  finishedAt: number;
}

/** Exact positive no-op for preparation already owned by a continuation's
 * existing worktree. Readiness is never inherited and gets its own receipt. */
export interface WorktreePhaseExistingWorktreeReceipt {
  phase: 'preparation';
  outcome: 'not-required';
  reason: 'existing-worktree-preparation';
  inheritedFromRunId: ULID;
  ok: true;
  steps: [];
  finishedAt: number;
}

export type WorktreePhaseNotRequiredReceipt =
  | WorktreePhaseNoCommandsReceipt
  | WorktreePhaseExistingWorktreeReceipt;

/** Immutable preparation/readiness evidence. Absence is unavailable, never a
 * successful no-op. */
export type WorktreePhaseReceipt =
  | WorktreePhaseExecutedReceipt
  | WorktreePhaseNotRequiredReceipt;

export type CreateNotRequiredWorktreePhaseReceiptInput =
  | {
      phase: WorktreePhase;
      reason: 'no-commands-configured';
      finishedAt: number;
      inheritedFromRunId?: never;
    }
  | {
      phase: 'preparation';
      reason: 'existing-worktree-preparation';
      inheritedFromRunId: ULID;
      finishedAt: number;
    };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function hasOnlyKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  return actual.length === expected.length && actual.every((key, index) => key === expected[index]);
}

function isNonNegativeSafeInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}

function isSafeInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value);
}

function isAppMintedUlid(value: unknown): value is ULID {
  return isUlid(value) && /^[0-7][0-9A-HJKMNP-TV-Z]{25}$/u.test(value);
}

function isWorktreeCommandStep(value: unknown): value is WorktreeCommandStep {
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
    isSafeInteger(value.exitCode) &&
    isNonNegativeSafeInteger(value.durationMs) &&
    typeof value.stdoutTail === 'string' &&
    typeof value.stderrTail === 'string' &&
    typeof value.timedOut === 'boolean';
}

/** Validate the exact canonical phase-receipt shape at a trust boundary. */
export function isWorktreePhaseReceipt(
  value: unknown,
  phase?: WorktreePhase,
): value is WorktreePhaseReceipt {
  if (!isRecord(value) || (value.phase !== 'preparation' && value.phase !== 'readiness')) {
    return false;
  }
  if (phase !== undefined && value.phase !== phase) return false;
  if (!isNonNegativeSafeInteger(value.finishedAt)) return false;

  if (value.outcome === 'executed') {
    if (!hasOnlyKeys(value, ['phase', 'outcome', 'ok', 'steps', 'finishedAt'])) return false;
    if (typeof value.ok !== 'boolean' || !Array.isArray(value.steps) || value.steps.length === 0) {
      return false;
    }
    if (!value.steps.every(isWorktreeCommandStep)) return false;
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
    isAppMintedUlid(value.inheritedFromRunId);
}

/** True only for exact evidence that authorizes advancing beyond the phase. */
export function isPositiveWorktreePhaseReceipt(
  value: unknown,
  phase?: WorktreePhase,
): value is WorktreePhaseReceipt {
  return isWorktreePhaseReceipt(value, phase) && value.ok;
}

/** Contextual preparation authority for one run. Fresh work may execute
 * setup or positively declare no configured commands. A continuation must
 * instead bind its no-op to its exact parent; another run's preparation can
 * never be borrowed. */
export function isPositivePreparationReceiptForRun(
  value: unknown,
  continues: ULID | null,
): value is WorktreePhaseReceipt {
  if (!isPositiveWorktreePhaseReceipt(value, 'preparation')) return false;
  if (continues === null) {
    return value.outcome !== 'not-required' || value.reason !== 'existing-worktree-preparation';
  }
  return value.outcome === 'not-required' &&
    value.reason === 'existing-worktree-preparation' &&
    value.inheritedFromRunId === continues;
}

/** Mint one exact, positive no-op receipt. Invalid runtime input fails closed. */
export function createNotRequiredWorktreePhaseReceipt(
  input: CreateNotRequiredWorktreePhaseReceiptInput,
): WorktreePhaseNotRequiredReceipt {
  const receipt: WorktreePhaseNotRequiredReceipt = input.reason === 'existing-worktree-preparation'
    ? {
        phase: input.phase,
        outcome: 'not-required',
        reason: input.reason,
        inheritedFromRunId: input.inheritedFromRunId,
        ok: true,
        steps: [],
        finishedAt: input.finishedAt,
      }
    : {
        phase: input.phase,
        outcome: 'not-required',
        reason: input.reason,
        ok: true,
        steps: [],
        finishedAt: input.finishedAt,
      };
  if (!isWorktreePhaseReceipt(receipt, input.phase)) {
    throw new Error('invalid not-required worktree phase receipt');
  }
  return receipt;
}
