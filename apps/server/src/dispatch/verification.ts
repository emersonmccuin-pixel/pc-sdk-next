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
import { exec } from 'node:child_process';
import { isAbsolute, resolve, sep } from 'node:path';
import {
  deriveAcceptanceCriteriaV2,
  evaluateAcceptance,
  KINDS_REQUIRING_EVIDENCE,
  type AcceptanceCriteria,
  type Deliverable,
  type EvaluationContext,
  type ExpectedOutput,
  type PredicateExecutors,
  type VerificationTier,
} from '@pc/domain';
import { git } from './worktrees.ts';

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

    runBash(command, cwd, timeoutMs) {
      const dir = rootFor(cwd);
      return new Promise((resolveRun) => {
        if (!dir) {
          resolveRun({ exitCode: 127, timedOut: false });
          return;
        }
        let timedOut = false;
        const child = exec(
          command,
          { cwd: dir, timeout: timeoutMs ?? BASH_DEFAULT_TIMEOUT_MS, maxBuffer: 8 * 1024 * 1024, windowsHide: true },
          (err, stdout, stderr) => {
            const anyErr = err as (NodeJS.ErrnoException & { killed?: boolean; code?: unknown }) | null;
            if (anyErr?.killed) timedOut = true;
            const rawCode = anyErr ? anyErr.code : 0;
            // Windows cmd reports 9009 for command-not-found; normalize to 127
            // so the evaluator's spawn-error → inconclusive rule applies.
            let exitCode = typeof rawCode === 'number' ? rawCode : anyErr ? 1 : 0;
            if (exitCode === 9009) exitCode = 127;
            resolveRun({
              exitCode: timedOut ? 124 : exitCode,
              timedOut,
              stdoutTail: tail(String(stdout ?? '')),
              stderrTail: tail(String(stderr ?? '')),
            });
          },
        );
        void child;
      });
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
  };
}

export type VerificationOutcome = {
  /** What lands on the contract row. */
  verificationStatus: 'passed' | 'failed' | 'pending';
  notes: string | null;
  /** True when pending means "needs a reviewer", not "inconclusive env". */
  escalatedToReview: boolean;
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
  if (tier === 'orchestrator-review' || tier === 'human-review') {
    return {
      verificationStatus: 'pending',
      notes: `tier ${tier}: parked for review (pc_review_contract)`,
      escalatedToReview: true,
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
      };
    }
    if (kind === 'answer' && input.expectedOutput.kind === 'answer' && input.expectedOutput.trust_end_turn !== true) {
      return {
        verificationStatus: 'pending',
        notes: "bare 'answer' with no criteria and no trust_end_turn — escalated to review",
        escalatedToReview: true,
      };
    }
    return { verificationStatus: 'passed', notes: 'empty acceptance set — structural kind, capture is the evidence', escalatedToReview: false };
  }

  const ctx = buildEvaluationContext(input);
  const executors = createExecutors(input.scope);
  const result = await evaluateAcceptance(criteria, ctx, executors);
  if (result.pass) {
    return { verificationStatus: 'passed', notes: `${criteria.length} predicate(s) passed`, escalatedToReview: false };
  }
  const allInconclusive = result.failures.every((f) => f.inconclusive === true);
  const notes = JSON.stringify(result.failures, null, 2);
  if (allInconclusive) {
    // Verification-environment defect, not a work defect.
    return { verificationStatus: 'pending', notes: `inconclusive — ${notes}`, escalatedToReview: false };
  }
  return { verificationStatus: 'failed', notes, escalatedToReview: false };
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
