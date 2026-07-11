// Contract verification — the tier gate + real predicate executors + the
// settlement rules ported from the old app's agent-verification design:
//
// - tier 'orchestrator-review' / 'human-review' ⇒ park at pending (zero
//   predicates evaluated); the pc_review_contract door drives the verdict.
// - tier 'auto', EMPTY criteria: fail-closed for KINDS_REQUIRING_EVIDENCE
//   (action/external/repo) and for bare `answer` without trust_end_turn —
//   escalate to review instead of silently passing. Structural kinds
//   (prose/payload/binary, answer+trust_end_turn) accept on empty.
// - executor failures that are environment defects (exit 127, missing
//   worktree) are INCONCLUSIVE ⇒ pending, never a false 'failed'.

import { statSync } from 'node:fs';
import { isAbsolute, resolve, sep } from 'node:path';
import {
  deriveAcceptanceCriteriaV2,
  evaluateAcceptance,
  KINDS_REQUIRING_EVIDENCE,
  type AcceptanceCriteria,
  type AcceptancePredicateKind,
  type ContractLandingPolicy,
  type Deliverable,
  type EvaluationContext,
  type ExpectedOutput,
  type PredicateExecutors,
  type VerificationTier,
} from '@pc/domain';
import { git, runShellCommand } from './worktrees.ts';

const BASH_DEFAULT_TIMEOUT_MS = 10 * 60 * 1000;
const TAIL_BYTES = 4096;

function tail(s: string): string {
  return s.length > TAIL_BYTES ? s.slice(-TAIL_BYTES) : s;
}

export interface ExecutorScope {
  /** Repo dispatches: the isolated worktree. Null for non-repo kinds. */
  worktreeDir: string | null;
  projectDir: string;
  /** Provisioning base — anchors the committed-diff check. */
  baseSha?: string | null;
  /** Sealed deliverable commit (authoritative diff anchor when present —
   *  survives worktree teardown races). */
  deliverableCommit?: string | null;
}

/** Real side-effecting executors, scoped + path-guarded. */
export function createExecutors(scope: ExecutorScope): PredicateExecutors {
  const rootFor = (cwd: 'worktree' | 'project'): string | null =>
    cwd === 'worktree' ? scope.worktreeDir : scope.projectDir;

  return {
    async fileSize(relativePath: string): Promise<number | null> {
      const root = scope.worktreeDir ?? scope.projectDir;
      if (!root) return null;
      if (isAbsolute(relativePath)) return null; // spec paths are worktree-relative
      const full = resolve(root, relativePath);
      if (!full.startsWith(resolve(root) + sep) && full !== resolve(root)) return null; // containment
      try {
        const st = statSync(full);
        return st.isFile() ? st.size : null;
      } catch {
        return null;
      }
    },

    // Shared tree-killing executor (worktrees.ts): a timed-out command's
    // grandchildren die too, instead of surviving to hold worktree locks.
    async runBash(command, cwd, timeoutMs) {
      const dir = rootFor(cwd);
      if (!dir) return { exitCode: 127, timedOut: false };
      const r = await runShellCommand(command, { cwd: dir, timeoutMs: timeoutMs ?? BASH_DEFAULT_TIMEOUT_MS });
      // Windows cmd reports 9009 for command-not-found; normalize to 127
      // so the evaluator's spawn-error → inconclusive rule applies.
      let exitCode = r.exitCode;
      if (exitCode === 9009) exitCode = 127;
      return {
        exitCode: r.timedOut ? 124 : exitCode,
        timedOut: r.timedOut,
        stdoutTail: tail(r.stdout),
        stderrTail: tail(r.stderr),
      };
    },

    async hasGitDiff(cwd): Promise<boolean | null> {
      const dir = rootFor(cwd);
      if (!dir) return null;
      // Priority 1: sealed deliverable commit vs base (authoritative).
      if (scope.baseSha && scope.deliverableCommit) {
        const r = await git(['rev-list', '--count', `${scope.baseSha}..${scope.deliverableCommit}`], dir);
        if (r.ok) return Number(r.stdout) > 0;
      }
      // Priority 2: base..HEAD in the worktree.
      if (scope.baseSha) {
        const r = await git(['rev-list', '--count', `${scope.baseSha}..HEAD`], dir);
        if (r.ok) return Number(r.stdout) > 0;
      }
      // Evidence inaccessible — inconclusive, never a false "no work done".
      return null;
    },

    async changedPaths(): Promise<string[] | null> {
      // Anchors match hasGitDiff: sealed commit vs base (authoritative), else
      // base..HEAD in the worktree. The sealed commit lives in the SHARED
      // object store, so the project copy can still read it after teardown.
      // --no-renames: a rename must surface BOTH paths (delete+add) so a
      //   `git mv` out of a forbidden zone can't hide its source path.
      // core.quotepath=off: non-ASCII paths come back verbatim, not
      //   octal-escaped in quotes (which no glob could ever match).
      const nameOnly = ['-c', 'core.quotepath=off', 'diff', '--no-renames', '--name-only'];
      if (scope.baseSha && scope.deliverableCommit) {
        for (const dir of [scope.worktreeDir, scope.projectDir]) {
          if (!dir) continue;
          const r = await git([...nameOnly, `${scope.baseSha}..${scope.deliverableCommit}`], dir);
          if (r.ok) return r.stdout.length === 0 ? [] : r.stdout.split('\n').filter(Boolean);
        }
      }
      if (scope.baseSha && scope.worktreeDir) {
        const r = await git([...nameOnly, `${scope.baseSha}..HEAD`], scope.worktreeDir);
        if (r.ok) return r.stdout.length === 0 ? [] : r.stdout.split('\n').filter(Boolean);
      }
      // Evidence inaccessible — inconclusive, never a false "out of scope".
      return null;
    },
  };
}

export type VerificationOutcome = {
  /** What lands on the contract row. */
  verificationStatus: 'passed' | 'failed' | 'pending';
  notes: string | null;
  /** True when pending means "needs a reviewer", not "inconclusive env". */
  escalatedToReview: boolean;
  /** Predicate kinds actually evaluated. Empty when no predicate ran (review
   *  tiers, empty acceptance sets) — the auto-land gate reads this to require
   *  POSITIVE scope evidence, not just an unopposed pass. */
  evaluatedPredicateKinds: AcceptancePredicateKind[];
  /** Failures tagged inconclusive (unreadable git/fs evidence). Always 0 on
   *  'passed' today; the auto-land gate still checks it so a future pass-with-
   *  inconclusive-subset can never auto-land. */
  inconclusiveCount: number;
};

export interface VerifyInput {
  expectedOutput: ExpectedOutput;
  acceptanceCriteria: AcceptanceCriteria | null;
  verificationTier: VerificationTier | null;
  deliverable: Deliverable | null;
  report: string | null;
  /** Bare tool names the run actually called (adapter-neutral evidence). */
  toolCalls: ReadonlyArray<{ name: string }>;
  pendingAskCreated: boolean;
  scope: ExecutorScope;
}

/** Tier-aware verification of a submitted deliverable. Pure decision +
 *  injected executors; the caller writes the outcome onto the contract. */
export async function verifyContract(input: VerifyInput): Promise<VerificationOutcome> {
  const tier = input.verificationTier ?? 'auto';
  const unevaluated = { evaluatedPredicateKinds: [] as AcceptancePredicateKind[], inconclusiveCount: 0 };
  if (tier === 'orchestrator-review' || tier === 'human-review') {
    return {
      verificationStatus: 'pending',
      notes: `tier ${tier}: parked for review (pc_review_contract)`,
      escalatedToReview: true,
      ...unevaluated,
    };
  }

  const criteria = input.acceptanceCriteria ?? deriveAcceptanceCriteriaV2(input.expectedOutput);

  if (criteria.length === 0) {
    const kind = input.expectedOutput.kind;
    if ((KINDS_REQUIRING_EVIDENCE as readonly string[]).includes(kind)) {
      return {
        verificationStatus: 'pending',
        notes: `empty acceptance set for evidence kind '${kind}' — escalated to review instead of auto-passing`,
        escalatedToReview: true,
        ...unevaluated,
      };
    }
    if (kind === 'answer' && input.expectedOutput.kind === 'answer' && input.expectedOutput.trust_end_turn !== true) {
      return {
        verificationStatus: 'pending',
        notes: "bare 'answer' with no criteria and no trust_end_turn — escalated to review",
        escalatedToReview: true,
        ...unevaluated,
      };
    }
    return {
      verificationStatus: 'passed',
      notes: 'empty acceptance set — structural kind, capture is the evidence',
      escalatedToReview: false,
      ...unevaluated,
    };
  }

  const ctx = buildEvaluationContext(input);
  const executors = createExecutors(input.scope);
  const result = await evaluateAcceptance(criteria, ctx, executors);
  const evaluatedPredicateKinds = criteria.map((c) => c.kind);
  const inconclusiveCount = result.failures.filter((f) => f.inconclusive === true).length;
  if (result.pass) {
    return {
      verificationStatus: 'passed',
      notes: `${criteria.length} predicate(s) passed`,
      escalatedToReview: false,
      evaluatedPredicateKinds,
      inconclusiveCount,
    };
  }
  const allInconclusive = result.failures.every((f) => f.inconclusive === true);
  const notes = JSON.stringify(result.failures, null, 2);
  if (allInconclusive) {
    // Verification-environment defect, not a work defect.
    return {
      verificationStatus: 'pending',
      notes: `inconclusive — ${notes}`,
      escalatedToReview: false,
      evaluatedPredicateKinds,
      inconclusiveCount,
    };
  }
  return { verificationStatus: 'failed', notes, escalatedToReview: false, evaluatedPredicateKinds, inconclusiveCount };
}

// ── Auto-land gate (guard 5, docs/worktree-lifecycle.md) ────────────────────

export interface AutoLandGateInput {
  /** The contract's EFFECTIVE landing policy (effectiveLandingPolicy()). */
  landingPolicy: ContractLandingPolicy;
  spec: Extract<ExpectedOutput, { kind: 'repo' }>;
  /** The fresh outcome from THIS settlement's verifyContract run. Null when no
   *  verification ran — fail closed, never land on a stale row status. */
  outcome: VerificationOutcome | null;
  /** Live pending-ask check for the producing run, taken at land time. */
  hasPendingAsk: boolean;
}

/** Why auto-merge may NOT land this contract; empty = every requirement has
 *  positive evidence. Missing evidence is a blocker, never a pass — the caller
 *  parks merge-ready for orchestrator review and records the reasons. Pure. */
export function autoLandBlockers(input: AutoLandGateInput): string[] {
  const blockers: string[] = [];
  if (input.landingPolicy !== 'auto-merge') {
    blockers.push(`landing policy is '${input.landingPolicy}', not 'auto-merge'`);
  }
  if (input.outcome === null) {
    blockers.push('no fresh verification outcome for this settlement');
  } else {
    if (input.outcome.verificationStatus !== 'passed') {
      blockers.push(`verification is '${input.outcome.verificationStatus}', not 'passed'`);
    }
    if (input.outcome.inconclusiveCount > 0) {
      blockers.push(`${input.outcome.inconclusiveCount} inconclusive predicate result(s) — unreadable evidence never counts as a pass`);
    }
    if ((input.spec.paths_touched?.length ?? 0) > 0 && !input.outcome.evaluatedPredicateKinds.includes('changed_paths_within')) {
      blockers.push('contract declares paths_touched but no changed_paths_within predicate was evaluated — scope evidence missing');
    }
  }
  if (input.hasPendingAsk) {
    blockers.push('run has an unresolved pending ask');
  }
  return blockers;
}

function buildEvaluationContext(input: VerifyInput): EvaluationContext {
  const d = input.deliverable;
  let deliverableText = '';
  if (d?.kind === 'answer') deliverableText = d.text ?? '';
  else if (d?.kind === 'prose') deliverableText = d.text ?? '';
  return {
    body: '',
    fields: {},
    attachments: [],
    report: input.report ?? '',
    deliverableText,
    toolCalls: input.toolCalls,
    pendingAskCreated: input.pendingAskCreated,
    ...(d?.kind === 'payload' ? { payload: d.data } : {}),
    externalHandle: d?.kind === 'external' ? d.handle : null,
  };
}
