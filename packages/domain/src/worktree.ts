// Canonical worktree type — db's `WorktreeRow` aliases this
// (packages/db/src/repos/worktrees.ts). Binding fields (project/run/contract/
// branch provenance) are nullable — legacy rows predate them.

import type { ULID } from './ulid.ts';

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

/** Git receipt — recorded after `git worktree add`. `cleanStatus` is the
 *  positive clean-initial-status check; provisioning refuses when false. */
export interface WorktreeGitReceipt {
  worktreePath: string;
  branch: string;
  baseBranch: string;
  baseSha: string;
  cleanStatus: boolean;
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

/** Preparation/readiness receipt — captured exit status per step. */
export interface WorktreePhaseReceipt {
  phase: 'preparation' | 'readiness';
  ok: boolean;
  steps: WorktreeCommandStep[];
  finishedAt: number;
}
