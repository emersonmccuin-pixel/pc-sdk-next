// Agent-contract family (slice 013). Browser-safe, zero runtime deps.
//
// Boundary purity (slices 001–006): no imports from apps, @pc/db, @pc/domain.
// The v2 `ExpectedOutput` / `Deliverable` / acceptance-predicate union is
// MIRRORED here from `@pc/domain/src/contract.ts` (the same way `pending-asks.ts`
// mirrors `PendingAskRow`) so the browser bundle never reaches into @pc/domain.
//
// Owns:
//   - the `Contract` DTO (the first-class agent contract — a machine assignment
//     with a typed, verified output; carries an external PM ref, not a work-item FK),
//   - the v2 union types (ExpectedOutput / Deliverable / AcceptancePredicate),
//   - the canonical contract resource payload (`{ reason, contract }`) that rides
//     the new `resource` frame (see events/resources.ts) as the full-snapshot
//     payload for the `contract` entity.
//
// Contract resource events are PROJECT-scoped; the frame's `version` carries
// `agent_contracts.version` for rev-aware upserts.

import { isUlid, parseErr, parseOk, type ParseResult, type ULID } from './shared.ts';
import {
  isRepositoryIdentityReceiptDto,
  type RepositoryIdentityReceiptDto,
} from './agent-runs.ts';

// ── v2 union (mirror of @pc/domain contract.ts) ──────────────────────────────

export const VERIFICATION_TIERS = ['auto', 'orchestrator-review', 'human-review'] as const;
export type VerificationTier = (typeof VERIFICATION_TIERS)[number];

export const VERIFICATION_STATUSES = ['pending', 'passed', 'failed'] as const;
export type VerificationStatus = (typeof VERIFICATION_STATUSES)[number];

export const DELIVERABLE_KINDS = [
  'answer',
  'prose',
  'payload',
  'repo',
  'external',
  'binary',
  'action',
] as const;
export type DeliverableKind = (typeof DELIVERABLE_KINDS)[number];

export type JsonSchema = {
  type?: 'object' | 'array' | 'string' | 'number' | 'boolean' | 'null';
  properties?: Record<string, JsonSchema>;
  items?: JsonSchema;
  required?: string[];
  enum?: unknown[];
  [k: string]: unknown;
};

export type ProseDocType =
  | 'plan'
  | 'prd'
  | 'research'
  | 'design'
  | 'adr'
  | 'spec'
  | 'runbook'
  | 'summary'
  | 'postmortem'
  | 'note';
// M5 (FD-5) — ☠ 'work_item_body' (body = brief only; mirror of domain's ProseStore).
export type ProseStore = 'contract' | 'attachment' | 'repo_file';
export type PayloadSemantic =
  | 'extraction'
  | 'classification'
  | 'decision'
  | 'verdict'
  | 'decomposition'
  | 'score';
export type RepoCheck =
  | { preset: 'build' | 'test' | 'lint'; timeout_ms?: number }
  | { command: string; cwd?: 'worktree' | 'project'; timeout_ms?: number };
export type BinaryArtifactType = 'diagram' | 'screenshot' | 'export' | 'dataset' | 'build';
export const EXTERNAL_SYSTEMS = ['email', 'calendar', 'chat', 'ticket', 'crm', 'api'] as const;
export type ExternalSystem = (typeof EXTERNAL_SYSTEMS)[number];

export type ExpectedOutput =
  // `trust_end_turn`: opt-in to auto-accept on an EMPTY acceptance set. Without
  // it a bare `answer` escalates to review instead of passing silently. Mirror
  // of @pc/domain contract.ts (the 2026-06-07 empty-contract finding).
  | { kind: 'answer'; must_address?: string[]; min_chars?: number; trust_end_turn?: boolean }
  | {
      kind: 'prose';
      doc_type?: ProseDocType;
      sections?: string[];
      min_chars?: number;
      store?: ProseStore;
      path?: string;
    }
  | { kind: 'payload'; schema: JsonSchema; semantic?: PayloadSemantic }
  | {
      kind: 'repo';
      // pc-pty-chat-415 (R3) — in_place deleted; repo work is always isolated.
      isolation?: 'worktree';
      paths_touched?: string[];
      checks?: RepoCheck[];
      require_diff?: boolean;
      /** docs/worktree-lifecycle.md — opt-in auto-merge on verified pass.
       *  Default: park merge-ready for orchestrator accept. */
      auto_land?: boolean;
      /** 'full' = independent review phase (mirror of @pc/domain). Issuer-owned
       *  like auto_land; wins over it. */
      review?: 'full';
    }
  | {
      kind: 'external';
      system: ExternalSystem;
      action: string;
      confirm: 'always' | 'pre-authorized';
      idempotency_key: string;
      verify_handle?: boolean;
    }
  | { kind: 'binary'; artifact_type?: BinaryArtifactType; mime?: string; min_size_bytes?: number }
  | { kind: 'action'; tool: string; min_count?: number; before_end_turn?: boolean };

export const EXPECTED_OUTPUT_KINDS = [
  'answer',
  'prose',
  'payload',
  'repo',
  'external',
  'binary',
  'action',
] as const;
export type ExpectedOutputKind = (typeof EXPECTED_OUTPUT_KINDS)[number];

export type Deliverable =
  | { kind: 'answer'; text: string }
  | { kind: 'prose'; text?: string; attachmentId?: string; ref?: string }
  | { kind: 'payload'; data: unknown }
  | {
      kind: 'repo';
      branch?: string;
      commit?: string;
      baseBranch?: string;
      baseCommit?: string;
      diffStat?: { files: number; insertions: number; deletions: number };
      prUrl?: string;
    }
  | { kind: 'external'; system: ExternalSystem; handle: string; idempotencyKey: string; url?: string }
  | { kind: 'binary'; attachmentId: string; mime: string; bytes: number }
  | { kind: 'action'; tool: string; count: number };

/** Canonical "deliverable → readable text" projection. `answer`/`prose` carry
 *  their text inline; every other (structured) kind has no prose body, so the
 *  contract's free-text `report` is surfaced instead. This is the ONE place that
 *  decides what a submitted deliverable "reads as" — the terminal envelope
 *  (agent completion) resolver calls it so they can never diverge. Returns ''
 *  when there is nothing to show. */
export function contractDeliverableText(
  deliverable: Deliverable | null | undefined,
  report?: string | null,
): string {
  if (deliverable && (deliverable.kind === 'answer' || deliverable.kind === 'prose')) {
    return deliverable.text ?? '';
  }
  return report ?? '';
}

export type AcceptancePredicate =
  | { kind: 'files_exist'; paths: string[]; min_size_bytes?: number }
  | { kind: 'fields_populated'; keys: string[] }
  | { kind: 'field_matches'; key: string; pattern: string }
  | { kind: 'bash_exit_zero'; command: string; cwd?: 'worktree' | 'project'; timeout_ms?: number }
  | { kind: 'attachments_present'; names: string[] }
  | { kind: 'body_contains'; pattern: string; regex?: boolean }
  | { kind: 'schema_valid'; schema: JsonSchema }
  | { kind: 'git_diff_nonempty'; cwd?: 'worktree' | 'project' }
  | { kind: 'external_handle_present' }
  | { kind: 'tool_called'; name: string; min_count?: number }
  | { kind: 'pending_ask_created' }
  | { kind: 'report_contains'; pattern: string; regex?: boolean }
  | { kind: 'min_length'; min: number }
  // guard 3 mirror — derived changed paths vs declared scope (see @pc/domain
  // contract.ts for the pattern semantics; forbidden defaults to ['.git/**']).
  | { kind: 'changed_paths_within'; allowed: string[]; forbidden?: string[] };

export type AcceptanceCriteria = AcceptancePredicate[];

export const CONTRACT_STATUSES = [
  'issued',
  'dispatched',
  'submitted',
  'verifying',
  'accepted',
  'rejected',
] as const;
export type ContractStatus = (typeof CONTRACT_STATUSES)[number];

// ── Explicit worktree abandonment (DL-002) ─────────────────────────────────

export const WORKTREE_ABANDONMENT_PREVIEW_PROTOCOL =
  'worktree-abandonment-preview-v1' as const;
export const WORKTREE_ABANDONMENT_PROTOCOL = 'worktree-abandonment-v1' as const;
export const WORKTREE_ABANDONMENT_TEARDOWN_PROTOCOL =
  'worktree-abandonment-teardown-v1' as const;
export const WORKTREE_ABANDONMENT_CHANGED_PATHS_MAX = 50;
export const WORKTREE_ABANDONMENT_REASON_MAX_CHARS = 1000;

export type WorktreeAbandonmentIntegrationStateDto =
  | 'unmerged'
  | 'no-exclusive-commits';

export interface WorktreeAbandonmentPresentStateDto {
  directory: 'present';
  registration: 'registered';
  status: 'clean' | 'dirty';
  staged: number;
  unstaged: number;
  untracked: number;
  worktreeStateDigest: string;
  changedPaths: string[];
  ignoredContents: 'uninspected';
}

export interface WorktreeAbandonmentMissingStateDto {
  directory: 'missing';
  registration: 'registered' | 'absent';
  status: 'unavailable';
  worktreeStateDigest: string;
  changedPaths: [];
  ignoredContents: 'uninspected';
}

export type WorktreeAbandonmentStateDto =
  | WorktreeAbandonmentPresentStateDto
  | WorktreeAbandonmentMissingStateDto;

export interface WorktreeAbandonmentPreviewDto {
  protocol: typeof WORKTREE_ABANDONMENT_PREVIEW_PROTOCOL;
  projectId: ULID;
  contractId: ULID;
  contractVersion: number;
  producerRunId: ULID;
  worktreeId: ULID;
  worktreeStatus: 'active' | 'stranded';
  worktreePath: string;
  branch: string;
  branchTip: string;
  baseBranch: string;
  validatedBaseSha: string;
  targetTip: string;
  integrationState: WorktreeAbandonmentIntegrationStateDto;
  repositoryIdentity: RepositoryIdentityReceiptDto;
  worktreeState: WorktreeAbandonmentStateDto;
  previewDigest: string;
}

export interface WorktreeAbandonmentReceiptDto {
  protocol: typeof WORKTREE_ABANDONMENT_PROTOCOL;
  requestId: string;
  approvedBy: 'user';
  approvalSurface: 'browser';
  approvalReason: 'explicit-browser-confirmation';
  approvedAt: number;
  reason: string | null;
  approvedContractVersion: number;
  projectId: ULID;
  contractId: ULID;
  producerRunId: ULID;
  worktreeId: ULID;
  worktreeStatus: 'active' | 'stranded';
  repositoryIdentity: RepositoryIdentityReceiptDto;
  worktreePath: string;
  branch: string;
  branchTip: string;
  baseBranch: string;
  validatedBaseSha: string;
  targetTip: string;
  integrationState: WorktreeAbandonmentIntegrationStateDto;
  worktreeState: WorktreeAbandonmentPresentStateDto;
  previewDigest: string;
}

export interface WorktreeAbandonmentTeardownReceiptDto {
  protocol: typeof WORKTREE_ABANDONMENT_TEARDOWN_PROTOCOL;
  authorityRequestId: string;
  startedAt: number;
  finishedAt: number;
  repositoryIdentity: RepositoryIdentityReceiptDto;
  worktreePath: string;
  branch: string;
  approvedBranchTip: string;
  observedBranchTip: string;
  directoryAbsent: true;
  registrationAbsent: true;
  branchPreserved: true;
}

export interface ApproveWorktreeAbandonmentRequest {
  requestId: string;
  expectedContractVersion: number;
  previewDigest: string;
  confirmation: string;
  reason?: string;
}

export interface WorktreeAbandonmentPreviewResponse {
  ok: true;
  preview: WorktreeAbandonmentPreviewDto;
}

export interface ApproveWorktreeAbandonmentResponse {
  ok: true;
  settlement: 'completed' | 'pending';
  contract: Contract;
}

// ── Contract DTO ─────────────────────────────────────────────────────────────

/** The first-class agent contract. A machine assignment with a typed output.
 *  Optionally carries an external PM-item ref (AInativePM over MCP). */
export interface Contract {
  id: ULID;
  projectId: ULID;
  /** External PM-item reference (AInativePM), or null. Replaces the dead
   *  work-item FK. */
  pmRef: string | null;
  /** The producing run. Null until dispatched. */
  agentRunId: ULID | null;
  podName: string | null;
  /** The typed spec the orchestrator authored. */
  expectedOutput: ExpectedOutput | null;
  /** Derived predicate set. Empty array = no auto-checks. */
  acceptanceCriteria: AcceptanceCriteria | null;
  verificationTier: VerificationTier | null;
  verificationStatus: VerificationStatus | null;
  verificationNotes: string | null;
  /** Free text to the orchestrator. Always present once the run reports. */
  report: string | null;
  /** The typed, captured artifact — owned HERE. */
  deliverable: Deliverable | null;
  /** Isolation axis for repo/file producers. */
  worktreePath: string | null;
  /** Repo dispatch provenance: canonical branch and commit SHA the worktree
   *  branch forked from. Null for non-repo and legacy rows. */
  worktreeBaseBranch: string | null;
  worktreeBaseSha: string | null;
  /** pc-pty-chat-415 (R5/R12) — accept ⇒ land. Null = not applicable
   *  (non-repo, pre-415). The receipts outlive the worktree; 'abandoned'
   *  preserves the branch + records its tip before reclaim; 'stale-base'
   *  parks work whose verified base the target advanced past (guard 7). */
  landingStatus:
    | 'pending'
    | 'landed'
    | 'conflict'
    | 'failed'
    | 'abandoning'
    | 'abandoned'
    | 'stale-base'
    | null;
  landedBranch: string | null;
  /** The agent BRANCH TIP — never the merge commit (that's `mergeSha`). */
  landedSha: string | null;
  landingError: string | null;
  landedAt: number | null;
  /** worktree-lifecycle merge receipt (mirror of @pc/domain) — target branch
   *  SHA before/after the merge, the merge commit, who authorized, and the
   *  base SHA verification covered. Null = pre-receipt row. */
  targetShaBefore: string | null;
  targetShaAfter: string | null;
  mergeSha: string | null;
  landingAuthorizer: 'auto' | 'orchestrator' | 'user' | 'reviewer' | null;
  verifiedBaseSha: string | null;
  /** Landing policy stamped at creation from the repo spec's auto_land /
   *  review flags. Null = legacy row — readers fall back through the spec. */
  landingPolicy: 'default-review' | 'auto-merge' | 'full-review' | null;
  /** Full-review loop (mirror of @pc/domain): reviewer dispatches consumed so
   *  far (bounded), and the in-flight review run — null = none dispatched /
   *  verdict recorded. Null on non-full-review and legacy rows. */
  reviewRound: number | null;
  reviewRunId: ULID | null;
  /** Sealed deliverable commit the in-flight reviewer was briefed on —
   *  approve settlement re-checks it against the CURRENT deliverable commit
   *  so a mid-review reseal voids the verdict. Cleared with reviewRunId. */
  reviewSealedCommit: string | null;
  /** Browser-approved destructive worktree reclaim. Legacy `abandoned` rows
   * have both receipts null and carry no cleanup authority. */
  abandonmentReceipt: WorktreeAbandonmentReceiptDto | null;
  abandonmentTeardownReceipt: WorktreeAbandonmentTeardownReceiptDto | null;
  abandonmentError: string | null;
  status: ContractStatus;
  /** Optimistic-concurrency counter. */
  version: number;
  createdAt: number;
  updatedAt: number;
}

// ── Request schemas ──────────────────────────────────────────────────────────

export const contractRoutes = {
  detail: (id: ULID) => `/api/contracts/${encodeURIComponent(id)}`,
  /** Slice 022 — project-scoped contract list. */
  forProject: (projectId: ULID) =>
    `/api/projects/${encodeURIComponent(projectId)}/contracts`,
  abandonmentPreview: (projectId: ULID, contractId: ULID) =>
    `/api/projects/${encodeURIComponent(projectId)}/contracts/${encodeURIComponent(contractId)}/abandonment-preview`,
  abandonment: (projectId: ULID, contractId: ULID) =>
    `/api/projects/${encodeURIComponent(projectId)}/contracts/${encodeURIComponent(contractId)}/abandonment`,
} as const;

export interface ListContractsResponse {
  ok: true;
  contracts: Contract[];
}

export interface ContractDetailResponse {
  ok: true;
  contract: Contract;
}

// ── Resource payload ──────────────────────────────────────────────────────────

export type ContractMutationReason =
  | 'created'
  | 'dispatched'
  | 'deliverable-set'
  | 'verification-set'
  | 'landing-set'
  | 'abandonment-authorized'
  | 'abandonment-settled'
  | 'abandonment-error'
  | 'patched';

export interface ContractChangedLivePayload {
  reason: ContractMutationReason;
  contract: Contract;
}

// ── Guards ────────────────────────────────────────────────────────────────────

export function isVerificationTier(value: unknown): value is VerificationTier {
  return typeof value === 'string' && (VERIFICATION_TIERS as readonly string[]).includes(value);
}

export function isVerificationStatus(value: unknown): value is VerificationStatus {
  return typeof value === 'string' && (VERIFICATION_STATUSES as readonly string[]).includes(value);
}

export function isDeliverableKind(value: unknown): value is DeliverableKind {
  return typeof value === 'string' && (DELIVERABLE_KINDS as readonly string[]).includes(value);
}

export function isExpectedOutputKind(value: unknown): value is ExpectedOutputKind {
  return typeof value === 'string' && (EXPECTED_OUTPUT_KINDS as readonly string[]).includes(value);
}

export function isContractStatus(value: unknown): value is ContractStatus {
  return typeof value === 'string' && (CONTRACT_STATUSES as readonly string[]).includes(value);
}

export function isContractMutationReason(value: unknown): value is ContractMutationReason {
  return (
    value === 'created' ||
    value === 'dispatched' ||
    value === 'deliverable-set' ||
    value === 'verification-set' ||
    value === 'landing-set' ||
    value === 'abandonment-authorized' ||
    value === 'abandonment-settled' ||
    value === 'abandonment-error' ||
    value === 'patched'
  );
}

function isContractLandingStatus(value: unknown): value is Contract['landingStatus'] {
  return value === null ||
    value === 'pending' ||
    value === 'landed' ||
    value === 'conflict' ||
    value === 'failed' ||
    value === 'abandoning' ||
    value === 'abandoned' ||
    value === 'stale-base';
}

function isNonNegativeSafeInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
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

export function isWorktreeAbandonmentStateDto(
  value: unknown,
): value is WorktreeAbandonmentStateDto {
  if (!isRecord(value)) return false;
  if (value.directory === 'present') {
    if (!hasExactKeys(value, [
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
    hasExactKeys(value, [
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

export function isWorktreeAbandonmentPreviewDto(
  value: unknown,
): value is WorktreeAbandonmentPreviewDto {
  return isRecord(value) &&
    hasExactKeys(value, [
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
    isUlid(value.projectId) &&
    isUlid(value.contractId) &&
    isNonNegativeSafeInteger(value.contractVersion) &&
    value.contractVersion > 0 &&
    isUlid(value.producerRunId) &&
    isUlid(value.worktreeId) &&
    (value.worktreeStatus === 'active' || value.worktreeStatus === 'stranded') &&
    isNonEmptyTrimmedString(value.worktreePath) &&
    isNonEmptyTrimmedString(value.branch) &&
    isGitObjectId(value.branchTip) &&
    isNonEmptyTrimmedString(value.baseBranch) &&
    isGitObjectId(value.validatedBaseSha) &&
    isGitObjectId(value.targetTip) &&
    (value.integrationState === 'unmerged' || value.integrationState === 'no-exclusive-commits') &&
    isRepositoryIdentityReceiptDto(value.repositoryIdentity) &&
    isWorktreeAbandonmentStateDto(value.worktreeState) &&
    isSha256Digest(value.previewDigest);
}

export function isWorktreeAbandonmentReceiptDto(
  value: unknown,
): value is WorktreeAbandonmentReceiptDto {
  return isRecord(value) &&
    hasExactKeys(value, [
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
    isUlid(value.projectId) &&
    isUlid(value.contractId) &&
    isUlid(value.producerRunId) &&
    isUlid(value.worktreeId) &&
    (value.worktreeStatus === 'active' || value.worktreeStatus === 'stranded') &&
    isRepositoryIdentityReceiptDto(value.repositoryIdentity) &&
    isNonEmptyTrimmedString(value.worktreePath) &&
    isNonEmptyTrimmedString(value.branch) &&
    isGitObjectId(value.branchTip) &&
    isNonEmptyTrimmedString(value.baseBranch) &&
    isGitObjectId(value.validatedBaseSha) &&
    isGitObjectId(value.targetTip) &&
    (value.integrationState === 'unmerged' || value.integrationState === 'no-exclusive-commits') &&
    isWorktreeAbandonmentStateDto(value.worktreeState) &&
    value.worktreeState.directory === 'present' &&
    isSha256Digest(value.previewDigest);
}

export function isWorktreeAbandonmentTeardownReceiptDto(
  value: unknown,
): value is WorktreeAbandonmentTeardownReceiptDto {
  return isRecord(value) &&
    hasExactKeys(value, [
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
    isRepositoryIdentityReceiptDto(value.repositoryIdentity) &&
    isNonEmptyTrimmedString(value.worktreePath) &&
    isNonEmptyTrimmedString(value.branch) &&
    isGitObjectId(value.approvedBranchTip) &&
    isGitObjectId(value.observedBranchTip) &&
    value.directoryAbsent === true &&
    value.registrationAbsent === true &&
    value.branchPreserved === true;
}

export function isMatchingWorktreeAbandonmentTeardownDto(
  authority: unknown,
  settlement: unknown,
): settlement is WorktreeAbandonmentTeardownReceiptDto {
  if (
    !isWorktreeAbandonmentReceiptDto(authority) ||
    !isWorktreeAbandonmentTeardownReceiptDto(settlement)
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

export function parseApproveWorktreeAbandonmentRequest(
  input: unknown,
): ParseResult<ApproveWorktreeAbandonmentRequest> {
  if (!isRecord(input)) return parseErr('request body must be an object');
  if (!hasOnlyKeys(input, [
    'requestId',
    'expectedContractVersion',
    'previewDigest',
    'confirmation',
    'reason',
  ])) return parseErr('request body contains unsupported fields');
  if (!isUuidV4(input.requestId)) return parseErr('requestId must be a canonical UUID v4');
  if (
    !isNonNegativeSafeInteger(input.expectedContractVersion) ||
    input.expectedContractVersion < 1
  ) return parseErr('expectedContractVersion must be a positive safe integer');
  if (!isSha256Digest(input.previewDigest)) return parseErr('previewDigest must be sha256 evidence');
  if (!isNonEmptyTrimmedString(input.confirmation)) return parseErr('confirmation required');
  if (input.reason !== undefined && typeof input.reason !== 'string') {
    return parseErr('reason must be a string');
  }
  const reason = typeof input.reason === 'string' ? input.reason.trim() : '';
  if (reason.length > WORKTREE_ABANDONMENT_REASON_MAX_CHARS) {
    return parseErr(`reason exceeds ${WORKTREE_ABANDONMENT_REASON_MAX_CHARS} characters`);
  }
  return parseOk({
    requestId: input.requestId,
    expectedContractVersion: input.expectedContractVersion,
    previewDigest: input.previewDigest,
    confirmation: input.confirmation,
    ...(reason ? { reason } : {}),
  });
}

export function isContract(value: unknown): value is Contract {
  if (!isRecord(value)) return false;
  if (!hasExactKeys(value, [
    'id',
    'projectId',
    'pmRef',
    'agentRunId',
    'podName',
    'expectedOutput',
    'acceptanceCriteria',
    'verificationTier',
    'verificationStatus',
    'verificationNotes',
    'report',
    'deliverable',
    'worktreePath',
    'worktreeBaseBranch',
    'worktreeBaseSha',
    'landingStatus',
    'landedBranch',
    'landedSha',
    'landingError',
    'landedAt',
    'targetShaBefore',
    'targetShaAfter',
    'mergeSha',
    'landingAuthorizer',
    'verifiedBaseSha',
    'landingPolicy',
    'reviewRound',
    'reviewRunId',
    'reviewSealedCommit',
    'abandonmentReceipt',
    'abandonmentTeardownReceipt',
    'abandonmentError',
    'status',
    'version',
    'createdAt',
    'updatedAt',
  ])) return false;
  const abandonmentReceipt = value.abandonmentReceipt === null
    ? null
    : isWorktreeAbandonmentReceiptDto(value.abandonmentReceipt)
      ? value.abandonmentReceipt
      : undefined;
  const abandonmentTeardownReceipt = value.abandonmentTeardownReceipt === null
    ? null
    : isWorktreeAbandonmentTeardownReceiptDto(value.abandonmentTeardownReceipt)
      ? value.abandonmentTeardownReceipt
      : undefined;
  if (abandonmentReceipt === undefined || abandonmentTeardownReceipt === undefined) return false;
  const abandonmentErrorValid = value.abandonmentError === null ||
    (typeof value.abandonmentError === 'string' && value.abandonmentError.length > 0);
  if (!abandonmentErrorValid) return false;
  const authorityMatchesContract = abandonmentReceipt === null || (
    abandonmentReceipt.projectId === value.projectId &&
    abandonmentReceipt.contractId === value.id &&
    abandonmentReceipt.producerRunId === value.agentRunId &&
    abandonmentReceipt.worktreePath === value.worktreePath &&
    abandonmentReceipt.baseBranch === value.worktreeBaseBranch &&
    typeof value.version === 'number' &&
    value.version > abandonmentReceipt.approvedContractVersion
  );
  if (!authorityMatchesContract) return false;
  const abandonmentStateValid = value.landingStatus === 'abandoning'
    ? abandonmentReceipt !== null &&
      abandonmentTeardownReceipt === null
    : value.landingStatus === 'abandoned'
      ? (
          abandonmentReceipt === null &&
          abandonmentTeardownReceipt === null &&
          value.abandonmentError === null
        ) || (
          abandonmentReceipt !== null &&
          abandonmentTeardownReceipt !== null &&
          value.abandonmentError === null &&
          isMatchingWorktreeAbandonmentTeardownDto(
            abandonmentReceipt,
            abandonmentTeardownReceipt,
          )
        )
      : abandonmentReceipt === null &&
        abandonmentTeardownReceipt === null &&
        value.abandonmentError === null;
  if (!abandonmentStateValid) return false;
  return (
    typeof value.id === 'string' &&
    typeof value.projectId === 'string' &&
    (value.pmRef === null || typeof value.pmRef === 'string') &&
    (value.agentRunId === null || typeof value.agentRunId === 'string') &&
    (value.podName === null || typeof value.podName === 'string') &&
    (value.expectedOutput === null || isRecord(value.expectedOutput)) &&
    (value.acceptanceCriteria === null || Array.isArray(value.acceptanceCriteria)) &&
    (value.verificationTier === null || isVerificationTier(value.verificationTier)) &&
    (value.verificationStatus === null || isVerificationStatus(value.verificationStatus)) &&
    (value.verificationNotes === null || typeof value.verificationNotes === 'string') &&
    (value.report === null || typeof value.report === 'string') &&
    (value.deliverable === null || isRecord(value.deliverable)) &&
    (value.worktreePath === null || typeof value.worktreePath === 'string') &&
    (value.worktreeBaseBranch === null || typeof value.worktreeBaseBranch === 'string') &&
    (value.worktreeBaseSha === null || typeof value.worktreeBaseSha === 'string') &&
    isContractLandingStatus(value.landingStatus) &&
    (value.landedBranch === null || typeof value.landedBranch === 'string') &&
    (value.landedSha === null || typeof value.landedSha === 'string') &&
    (value.landingError === null || typeof value.landingError === 'string') &&
    (value.landedAt === null || isNonNegativeSafeInteger(value.landedAt)) &&
    (value.targetShaBefore === null || typeof value.targetShaBefore === 'string') &&
    (value.targetShaAfter === null || typeof value.targetShaAfter === 'string') &&
    (value.mergeSha === null || typeof value.mergeSha === 'string') &&
    (value.landingAuthorizer === null ||
      value.landingAuthorizer === 'auto' ||
      value.landingAuthorizer === 'orchestrator' ||
      value.landingAuthorizer === 'user' ||
      value.landingAuthorizer === 'reviewer') &&
    (value.verifiedBaseSha === null || typeof value.verifiedBaseSha === 'string') &&
    (value.landingPolicy === null ||
      value.landingPolicy === 'default-review' ||
      value.landingPolicy === 'auto-merge' ||
      value.landingPolicy === 'full-review') &&
    (value.reviewRound === null || isNonNegativeSafeInteger(value.reviewRound)) &&
    (value.reviewRunId === null || typeof value.reviewRunId === 'string') &&
    (value.reviewSealedCommit === null || typeof value.reviewSealedCommit === 'string') &&
    isContractStatus(value.status) &&
    isNonNegativeSafeInteger(value.version) &&
    value.version > 0 &&
    isNonNegativeSafeInteger(value.createdAt) &&
    isNonNegativeSafeInteger(value.updatedAt)
  );
}

export function isContractChangedLivePayload(
  value: unknown,
): value is ContractChangedLivePayload {
  if (!isRecord(value) || !isContractMutationReason(value.reason)) return false;
  return isContract(value.contract);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function hasOnlyKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  const allowed = new Set(keys);
  return Object.keys(value).every((key) => allowed.has(key));
}

function hasExactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  return hasOnlyKeys(value, keys) && Object.keys(value).length === keys.length;
}
