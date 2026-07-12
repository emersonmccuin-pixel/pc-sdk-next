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
