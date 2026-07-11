// Worktree mechanics — provision / land / teardown / stranded scan.
//
// Repo-kind dispatches ALWAYS run in an isolated git worktree (contract rule:
// isolation derived from the kind, never chosen per dispatch). Worktrees live
// beside the project: `<projectDir>-worktrees/<branch>` (the workspace
// convention), so the project tree itself is never polluted.
//
// Landing v1 (personal tool, no push): merge the agent branch into the base
// branch IN THE PROJECT WORKING COPY, guarded — clean tree + HEAD still on the
// base branch, else a typed non-landing outcome. Positive receipt: the branch
// tip must be an ancestor of HEAD after the merge. The branch is ALWAYS
// preserved; only the worktree directory is reclaimed.

import { execFile, spawn } from 'node:child_process';
import { existsSync, mkdirSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import {
  getAgentRunRow,
  getContract,
  listAbandonedContractBranches,
  listActiveWorktrees,
  listNonTerminalAgentRuns,
  listStrandedWorktrees,
  markWorktreeDestroyed,
  markWorktreeStranded,
  reviveStrandedWorktree,
  updateAgentRunStatus,
  upsertWorktree,
} from '@pc/db';
import { canTransition, type ULID, type WorktreeCommandStep, type WorktreeStrandedReason } from '@pc/domain';

const GIT_TIMEOUT_MS = 60_000;
/** Per-command bound for profile setup/readiness steps (matches the
 *  verification runBash default). */
const PROFILE_CMD_TIMEOUT_MS = 10 * 60 * 1000;
/** Cleanup is best-effort — keep it short so teardown never hangs settlement. */
const CLEANUP_CMD_TIMEOUT_MS = 60_000;
const RECEIPT_TAIL_BYTES = 4096;

function receiptTail(s: string): string {
  return s.length > RECEIPT_TAIL_BYTES ? s.slice(-RECEIPT_TAIL_BYTES) : s;
}

export interface GitResult {
  ok: boolean;
  stdout: string;
  stderr: string;
  code: number;
}

export function git(args: string[], cwd: string, timeoutMs = GIT_TIMEOUT_MS): Promise<GitResult> {
  return new Promise((resolve) => {
    execFile(
      'git',
      args,
      { cwd, timeout: timeoutMs, maxBuffer: 4 * 1024 * 1024, windowsHide: true },
      (err, stdout, stderr) => {
        const code = err ? ((err as NodeJS.ErrnoException & { code?: unknown }).code as number | undefined) ?? 1 : 0;
        resolve({
          ok: !err,
          stdout: String(stdout ?? '').trim(),
          stderr: String(stderr ?? '').trim(),
          code: typeof code === 'number' ? code : 1,
        });
      },
    );
  });
}

/** Derived diff statistics between two commits (`git diff --numstat`). Null
 *  when git can't produce them — callers keep whatever they already had.
 *  Binary files count toward `files` but contribute no line counts. */
export async function deriveDiffStat(
  dir: string,
  baseSha: string,
  commit: string,
): Promise<{ files: number; insertions: number; deletions: number } | null> {
  const r = await git(['diff', '--numstat', `${baseSha}..${commit}`], dir);
  if (!r.ok) return null;
  let files = 0;
  let insertions = 0;
  let deletions = 0;
  for (const line of r.stdout.split('\n')) {
    if (!line.trim()) continue;
    files++;
    const [ins, del] = line.split('\t');
    if (ins !== '-') insertions += Number(ins) || 0;
    if (del !== '-') deletions += Number(del) || 0;
  }
  return { files, insertions, deletions };
}

export interface ProvisionedWorktree {
  dir: string;
  branch: string;
  baseBranch: string;
  baseSha: string;
  /** Positive clean-initial-status check — always true on ok (a dirty fresh
   *  worktree refuses). Recorded on the Git receipt. */
  cleanStatus: boolean;
}

export type ProvisionOutcome =
  | ({ ok: true } & ProvisionedWorktree)
  | { ok: false; error: string };

/** `git worktree add -b agent-<id8> <dir> refs/heads/<base>` + the durable row
 *  + the clean-initial-status check.
 *  The main copy must be ON the base branch — the profile's `baseBranch` when
 *  configured, else the main/master probe. Provisioning REFUSES, never
 *  auto-checkouts, when it is checked out elsewhere.
 *  Never throws — a typed failure feeds the `worktree-provision-failed` path. */
export async function provisionWorktree(
  projectDir: string,
  runId: string,
  opts: { baseBranch?: string | null; projectId?: ULID | null } = {},
): Promise<ProvisionOutcome> {
  if (!projectDir || !existsSync(projectDir)) {
    return { ok: false, error: `project folder missing: ${projectDir || '(unset)'}` };
  }
  const inside = await git(['rev-parse', '--is-inside-work-tree'], projectDir);
  if (!inside.ok || inside.stdout !== 'true') {
    return { ok: false, error: `not a git repository: ${projectDir}` };
  }
  // Base resolution: profile override wins; else probe main/master.
  let base: string | undefined;
  if (opts.baseBranch) {
    if (!(await git(['rev-parse', '--verify', '--quiet', `refs/heads/${opts.baseBranch}`], projectDir)).ok) {
      return { ok: false, error: `configured base branch '${opts.baseBranch}' does not exist in ${projectDir}` };
    }
    base = opts.baseBranch;
  } else {
    for (const candidate of ['main', 'master']) {
      if ((await git(['rev-parse', '--verify', '--quiet', `refs/heads/${candidate}`], projectDir)).ok) {
        base = candidate;
        break;
      }
    }
  }
  if (!base) {
    return { ok: false, error: `no base branch: neither 'main' nor 'master' exists in ${projectDir}` };
  }
  const current = await git(['rev-parse', '--abbrev-ref', 'HEAD'], projectDir);
  if (!current.ok) {
    return { ok: false, error: `cannot resolve HEAD: ${current.stderr}` };
  }
  if (current.stdout === 'HEAD') {
    return { ok: false, error: 'project is on a detached HEAD — check out a branch first' };
  }
  if (current.stdout !== base) {
    return {
      ok: false,
      error: `project is checked out on '${current.stdout}', not the base branch '${base}' — switch the main copy back to '${base}' first (provisioning never auto-checkouts)`,
    };
  }
  const baseSha = await git(['rev-parse', `refs/heads/${base}`], projectDir);
  if (!baseSha.ok) {
    return { ok: false, error: `cannot resolve base branch tip: ${baseSha.stderr}` };
  }
  const branch = `agent-${runId.slice(-8).toLowerCase()}`;
  const root = `${projectDir.replace(/[\\/]+$/, '')}-worktrees`;
  mkdirSync(root, { recursive: true });
  const dir = join(root, branch);
  const add = await git(['worktree', 'add', '-b', branch, dir, baseSha.stdout], projectDir);
  if (!add.ok) {
    return { ok: false, error: `git worktree add failed: ${add.stderr || add.stdout}` };
  }
  // Row first — a dirty refusal below preserves the dir, and the stranded scan
  // must still see it. Binding fields stamp here; contractId follows at
  // contract creation (setWorktreeContractId).
  upsertWorktree({
    name: branch,
    path: dir,
    projectId: opts.projectId ?? null,
    agentRunId: runId as ULID,
    branch,
    baseBranch: base,
    baseSha: baseSha.stdout,
  });
  // Git receipt: the fresh worktree must start POSITIVELY clean (filters,
  // eol config, or case collisions can dirty a checkout on arrival).
  const status = await git(['status', '--porcelain'], dir);
  if (!status.ok) {
    return { ok: false, error: `worktree initial status unreadable: ${status.stderr || 'no output'}` };
  }
  if (status.stdout.length > 0) {
    return {
      ok: false,
      error: `worktree not clean immediately after checkout (filters/eol/case config?) — refusing to start an agent on a dirty base:\n${receiptTail(status.stdout)}`,
    };
  }
  return { ok: true, dir, branch, baseBranch: base, baseSha: baseSha.stdout, cleanStatus: true };
}

// ── Review checkouts (full independent review) ───────────────────────────────

/** Deterministic dir name for a review run's disposable checkout — shared by
 *  provisioning and the terminal reclaim so the reclaim can positively
 *  identify a review checkout (and never touch a builder worktree). */
export function reviewCheckoutName(reviewRunId: string): string {
  return `review-${reviewRunId.slice(-8).toLowerCase()}`;
}

/** Detached checkout of the SEALED commit for a review specialist:
 *  `git worktree add --detach <dir> <commit>`. The reviewer never gets the
 *  builder's live worktree as cwd — a stray reviewer commit would move the
 *  agent branch tip (hard-failing the landing tip==seal guard) and untracked
 *  test/build artifacts would dirty the tree the Fix door resubmits from.
 *  Deliberately NOT registered in the worktrees table: no branch, no landing
 *  state, nothing for the stranded scan — reclaimed at the reviewer's
 *  terminal (an orphan from a crash window is inert). Never throws. */
export async function provisionReviewCheckout(
  projectDir: string,
  reviewRunId: string,
  commit: string,
): Promise<{ ok: true; dir: string } | { ok: false; error: string }> {
  if (!projectDir || !existsSync(projectDir)) {
    return { ok: false, error: `project folder missing: ${projectDir || '(unset)'}` };
  }
  const root = worktreesRoot(projectDir);
  mkdirSync(root, { recursive: true });
  const dir = join(root, reviewCheckoutName(reviewRunId));
  const add = await git(['worktree', 'add', '--detach', dir, commit], projectDir);
  if (!add.ok) {
    return { ok: false, error: `git worktree add --detach failed: ${add.stderr || add.stdout}` };
  }
  return { ok: true, dir };
}

/** Reclaim a review checkout. Best-effort (a leftover is inert — detached
 *  HEAD, no branch); converges to success when the dir is already gone and
 *  unregistered (same idempotency as teardownWorktree). Never throws. */
export async function removeReviewCheckout(projectDir: string, dir: string): Promise<boolean> {
  const removed = await git(['worktree', 'remove', '--force', dir], projectDir);
  if (removed.ok) return true;
  if (!existsSync(dir) && !(await isRegisteredWorktree(projectDir, dir))) return true;
  console.warn(`[pc-sdk][worktree] review checkout remove failed for ${dir}: ${removed.stderr}`);
  return false;
}

// ── Profile command runner (Prepare/Readiness/Cleanup phases) ────────────────

export interface ProfileCommandsResult {
  ok: boolean;
  steps: WorktreeCommandStep[];
}

/** Run profile commands sequentially IN the worktree via the platform shell
 *  (same spawn idiom as the verification runBash executor). Bounded output
 *  tails; stops at the first nonzero exit. Never throws. */
export function runProfileCommands(
  dir: string,
  commands: readonly string[],
  timeoutMs = PROFILE_CMD_TIMEOUT_MS,
): Promise<ProfileCommandsResult> {
  return (async () => {
    const steps: WorktreeCommandStep[] = [];
    for (const command of commands) {
      const step = await runProfileCommand(dir, command, timeoutMs);
      steps.push(step);
      if (step.exitCode !== 0) return { ok: false, steps };
    }
    return { ok: true, steps };
  })();
}

async function runProfileCommand(dir: string, command: string, timeoutMs: number): Promise<WorktreeCommandStep> {
  const startedAt = Date.now();
  const r = await runShellCommand(command, { cwd: dir, timeoutMs });
  let exitCode = r.exitCode;
  if (exitCode === 9009) exitCode = 127; // Windows command-not-found → POSIX 127
  return {
    command,
    exitCode: r.timedOut ? 124 : exitCode,
    durationMs: Date.now() - startedAt,
    stdoutTail: receiptTail(r.stdout),
    stderrTail: receiptTail(r.stderr),
    timedOut: r.timedOut,
  };
}

// ── Shell executor (profile + verification commands) ─────────────────────────

const SHELL_OUTPUT_CAP = 8 * 1024 * 1024;

export interface ShellCommandResult {
  exitCode: number;
  timedOut: boolean;
  stdout: string;
  stderr: string;
}

/** Command env: the server env MINUS the credentials account-env scrubs from
 *  agent sessions. Step output tails persist durably into phase receipts, so
 *  an env-echoing command must never see them (docs/worktree-lifecycle.md:
 *  secrets are injected through explicit policy only). */
export function sanitizedShellEnv(base: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...base };
  delete env.ANTHROPIC_API_KEY;
  delete env.ANTHROPIC_AUTH_TOKEN;
  return env;
}

/** Run a command through the platform shell with a TREE-killing timeout.
 *  Node's built-in exec timeout signals only the shell — on Windows a
 *  timed-out `npm ci` (or a readiness command that starts a server) orphans
 *  grandchildren that keep running, hold worktree file locks, and later make
 *  `git worktree remove --force` fail. So: POSIX spawns detached (own process
 *  group, `kill(-pid)` reaps the tree); win32 uses `taskkill /PID /T /F`.
 *  Never throws; a spawn failure resolves exit 127. */
export function runShellCommand(
  command: string,
  opts: { cwd: string; timeoutMs: number; env?: NodeJS.ProcessEnv },
): Promise<ShellCommandResult> {
  return new Promise((resolve) => {
    const child = spawn(command, {
      cwd: opts.cwd,
      shell: true,
      windowsHide: true,
      env: opts.env ?? sanitizedShellEnv(),
      detached: process.platform !== 'win32',
    });
    let stdout = '';
    let stderr = '';
    child.stdout?.on('data', (d: Buffer) => {
      if (stdout.length < SHELL_OUTPUT_CAP) stdout += d.toString();
    });
    child.stderr?.on('data', (d: Buffer) => {
      if (stderr.length < SHELL_OUTPUT_CAP) stderr += d.toString();
    });
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      killProcessTree(child.pid);
    }, opts.timeoutMs);
    let settled = false;
    const settle = (exitCode: number): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ exitCode, timedOut, stdout, stderr });
    };
    child.on('error', () => settle(127));
    child.on('close', (code, signal) => settle(code ?? (signal ? 1 : 0)));
  });
}

/** Kill a shell AND everything it spawned. Best-effort, never throws. */
function killProcessTree(pid: number | undefined): void {
  if (!pid) return;
  if (process.platform === 'win32') {
    execFile('taskkill', ['/PID', String(pid), '/T', '/F'], { windowsHide: true }, () => {});
    return;
  }
  try {
    process.kill(-pid, 'SIGKILL'); // detached ⇒ pid leads its own group
  } catch {
    try {
      process.kill(pid, 'SIGKILL');
    } catch {
      /* already gone */
    }
  }
}

export type LandOutcome =
  // targetShaBefore = target-branch HEAD before the merge; mergeSha = the
  // --no-ff merge commit (HEAD after); branchSha = the agent branch tip.
  | { outcome: 'landed'; mergeSha: string; branchSha: string; targetShaBefore: string }
  // 'stale-base' — the target HEAD is not the SHA the caller validated
  // (guard 7): the base advanced between check and merge. Nothing merged.
  | { outcome: 'stale-base'; error: string }
  | { outcome: 'conflict'; error: string }
  | { outcome: 'failed'; error: string };

/** Merge the agent branch into the base branch in the project working copy.
 *  Guarded, receipt-checked, never throws. `expectedHeadSha` is the target
 *  HEAD the caller validated — a moved HEAD refuses instead of merging. */
export async function landBranch(input: {
  projectDir: string;
  branch: string;
  baseBranch: string;
  podName: string;
  expectedHeadSha: string;
}): Promise<LandOutcome> {
  const { projectDir, branch, baseBranch } = input;
  const status = await git(['status', '--porcelain'], projectDir);
  if (!status.ok) return { outcome: 'failed', error: `git status failed: ${status.stderr}` };
  if (status.stdout.length > 0) {
    return {
      outcome: 'conflict',
      error: 'project working tree has uncommitted changes — commit/stash them, then re-land via pc_review_contract accept',
    };
  }
  const current = await git(['rev-parse', '--abbrev-ref', 'HEAD'], projectDir);
  if (!current.ok) return { outcome: 'failed', error: `rev-parse failed: ${current.stderr}` };
  if (current.stdout !== baseBranch) {
    return {
      outcome: 'conflict',
      error: `project is on '${current.stdout}', not the dispatch base '${baseBranch}' — switch back, then re-land`,
    };
  }
  const branchSha = await git(['rev-parse', branch], projectDir);
  if (!branchSha.ok) return { outcome: 'failed', error: `agent branch missing: ${branch}` };
  const targetBefore = await git(['rev-parse', 'HEAD'], projectDir);
  if (!targetBefore.ok) return { outcome: 'failed', error: `rev-parse HEAD failed: ${targetBefore.stderr}` };
  if (targetBefore.stdout !== input.expectedHeadSha) {
    return {
      outcome: 'stale-base',
      error: `target '${baseBranch}' moved to ${targetBefore.stdout.slice(0, 12)} after the pre-merge check (expected ${input.expectedHeadSha.slice(0, 12)}) — revalidate against the new tip, then re-land`,
    };
  }

  const merge = await git(
    ['merge', '--no-ff', '--no-edit', '-m', `land(${input.podName}): ${branch}`, branch],
    projectDir,
  );
  if (!merge.ok) {
    await git(['merge', '--abort'], projectDir); // best-effort; leaves the tree clean
    return { outcome: 'conflict', error: `merge conflict: ${merge.stderr || merge.stdout}` };
  }
  // Positive receipt #1 — the branch tip is now an ancestor of HEAD.
  const receipt = await git(['merge-base', '--is-ancestor', branchSha.stdout, 'HEAD'], projectDir);
  if (!receipt.ok) {
    return { outcome: 'failed', error: 'post-merge receipt failed: branch tip is not an ancestor of HEAD' };
  }
  const mergeSha = await git(['rev-parse', 'HEAD'], projectDir);
  return { outcome: 'landed', mergeSha: mergeSha.stdout, branchSha: branchSha.stdout, targetShaBefore: targetBefore.stdout };
}

export type LandedProbe =
  | { landed: true; branchSha: string; mergeSha: string | null; targetShaBefore: string | null }
  | { landed: false };

/** Idempotency probe for boot re-drives: the branch tip already an ancestor of
 *  the base tip means a prior drive merged before the receipt was recorded.
 *  Callers converge to the landed receipt; they never re-run `git merge`.
 *  Two false-convergence guards:
 *  - a branch with NO commits past the validated base (zero-commit run, or a
 *    ref that never left the base) is trivially an ancestor of the base tip —
 *    that proves nothing, so the probe reports not-landed and the normal
 *    landing path (guard 7 / landBranch) decides;
 *  - merge-commit recovery is positive-receipt only: a candidate merge is
 *    attributed solely when its SECOND PARENT is this branch tip, so another
 *    contract's landing on the same base is never stamped into this receipt. */
export async function probeAlreadyLanded(
  projectDir: string,
  branch: string,
  baseBranch: string,
  validatedBaseSha: string | null,
): Promise<LandedProbe> {
  const branchSha = await git(['rev-parse', '--verify', '--quiet', `refs/heads/${branch}`], projectDir);
  if (!branchSha.ok) return { landed: false };
  if (!validatedBaseSha || branchSha.stdout === validatedBaseSha) return { landed: false };
  const ahead = await git(['rev-list', '--count', `${validatedBaseSha}..${branchSha.stdout}`], projectDir);
  if (!ahead.ok || ahead.stdout === '0') return { landed: false };
  const ancestor = await git(
    ['merge-base', '--is-ancestor', branchSha.stdout, `refs/heads/${baseBranch}`],
    projectDir,
  );
  if (!ancestor.ok) return { landed: false };
  const merges = await git(
    ['rev-list', '--reverse', '--merges', '--ancestry-path', `${branchSha.stdout}..refs/heads/${baseBranch}`],
    projectDir,
  );
  let mergeSha: string | null = null;
  if (merges.ok && merges.stdout) {
    for (const candidate of merges.stdout.split('\n').filter(Boolean)) {
      const secondParent = await git(['rev-parse', '--verify', '--quiet', `${candidate}^2`], projectDir);
      if (secondParent.ok && secondParent.stdout === branchSha.stdout) {
        mergeSha = candidate;
        break;
      }
    }
  }
  const firstParent = mergeSha ? await git(['rev-parse', `${mergeSha}^1`], projectDir) : null;
  return {
    landed: true,
    branchSha: branchSha.stdout,
    mergeSha,
    targetShaBefore: firstParent?.ok ? firstParent.stdout : null,
  };
}

/** Reclaim the worktree DIRECTORY. The branch is preserved on purpose —
 *  landed work is merged, unlanded work stays recoverable from the branch.
 *  Profile `cleanupCommands` run first, IN the worktree, bounded and
 *  best-effort — a cleanup failure logs and defers to removal (never blocks
 *  settlement). Returns false when removal fails (worktree row stays active)
 *  so callers can stamp 'stranded' instead of falsely claiming completion. */
export async function teardownWorktree(
  projectDir: string,
  dir: string,
  cleanupCommands: readonly string[] = [],
): Promise<boolean> {
  if (cleanupCommands.length > 0 && existsSync(dir)) {
    const cleanup = await runProfileCommands(dir, cleanupCommands, CLEANUP_CMD_TIMEOUT_MS);
    if (!cleanup.ok) {
      const failed = cleanup.steps[cleanup.steps.length - 1];
      console.warn(
        `[pc-sdk][worktree] cleanup command failed in ${dir} (exit ${failed?.exitCode}): ${failed?.command} — proceeding to removal`,
      );
    }
  }
  const removed = await git(['worktree', 'remove', '--force', dir], projectDir);
  if (!removed.ok) {
    // Crash-window idempotency: a prior teardown can succeed at removal and
    // die before markWorktreeDestroyed — the boot re-run's removal then fails
    // ('not a working tree') on a dir git no longer knows. Dir absent AND
    // unregistered is positive proof the removal already happened; converge
    // to success instead of stranding a finished teardown every boot.
    if (!existsSync(dir) && !(await isRegisteredWorktree(projectDir, dir))) {
      markWorktreeDestroyed(basename(dir));
      return true;
    }
    // Removal failure is logged and left to boot recovery (stranded scan);
    // never block settlement on cleanup.
    console.warn(`[pc-sdk][worktree] remove failed for ${dir}: ${removed.stderr}`);
    return false;
  }
  markWorktreeDestroyed(basename(dir));
  return true;
}

/** True when git still lists `dir` as a registered worktree of the repo.
 *  Fails CLOSED (true) when the list itself fails — absence must be proven
 *  before teardown converges to success. */
async function isRegisteredWorktree(projectDir: string, dir: string): Promise<boolean> {
  const list = await git(['worktree', 'list', '--porcelain'], projectDir);
  if (!list.ok) return true;
  const target = normalizePathKey(dir);
  return list.stdout
    .split('\n')
    .filter((line) => line.startsWith('worktree '))
    .some((line) => normalizePathKey(line.slice('worktree '.length)) === target);
}

/** Canonical path key for comparison: resolved, forward slashes, case-folded
 *  on win32 (mirrors the landing-lock key idiom). */
function normalizePathKey(p: string): string {
  const resolved = resolve(p.trim()).replace(/[\\/]+/g, '/');
  return process.platform === 'win32' ? resolved.toLowerCase() : resolved;
}

export interface StrandedWorktreeFinding {
  name: string;
  path: string;
  reason: WorktreeStrandedReason;
}

export interface StrandedReconcileResult {
  /** Newly (or still) stranded rows this pass wrote. */
  stranded: StrandedWorktreeFinding[];
  /** Previously stranded rows that self-healed back to active. */
  revived: string[];
}

/** Durable stranded reconcile (docs/worktree-lifecycle.md 'Recovery' —
 *  premortem #5: stranded isolation is visible, never silent).
 *
 *  The live set is the REAL one: non-terminal runs' worktreeDir values.
 *  Abandoned-contract branches are excluded — abandonment is an explicit
 *  user-approved state awaiting cleanup, not stranding. Findings are written
 *  through the repo: row → status 'stranded' + reason + strandedAt; the bound
 *  run (when resolvable) gets lifecycle 'stranded' where canTransition allows.
 *  A stranded row whose dir + live run are back flips to active (self-heal;
 *  fuller recovery is a later slice). Never throws. */
export function reconcileStrandedWorktrees(): StrandedReconcileResult {
  const live = new Set<string>();
  for (const run of listNonTerminalAgentRuns()) {
    if (run.worktreeDir) live.add(run.worktreeDir);
  }
  const abandonedByProject = new Map<string, ReadonlySet<string>>();
  const abandoned = (projectId: ULID): ReadonlySet<string> => {
    let set = abandonedByProject.get(projectId);
    if (!set) {
      set = new Set(listAbandonedContractBranches(projectId));
      abandonedByProject.set(projectId, set);
    }
    return set;
  };
  const now = Date.now();
  const stranded: StrandedWorktreeFinding[] = [];
  for (const row of listActiveWorktrees()) {
    // Abandoned work is preserved on purpose — its record lives on the contract.
    if (row.projectId && abandoned(row.projectId).has(row.branch ?? row.name)) continue;
    // Review-parked work is NOT stranded: the producing run is terminal BY
    // DESIGN while the contract awaits orchestrator accept ⇒ land (default
    // review policy). Stranding it would stamp terminal lifecycle 'stranded'
    // onto merge-ready work, poisoning the receipt after the merge lands.
    if (awaitingReviewOrLanding(row.contractId)) continue;
    const reason: WorktreeStrandedReason | null = !existsSync(row.path)
      ? 'dir-missing'
      : !live.has(row.path)
        ? 'no-live-run'
        : null;
    if (!reason) continue;
    markWorktreeStranded(row.name, reason, now);
    strandRunLifecycle(row.agentRunId);
    stranded.push({ name: row.name, path: row.path, reason });
  }
  const revived: string[] = [];
  for (const row of listStrandedWorktrees()) {
    // Self-heal: dir back + live run, OR the contract is (still) awaiting
    // review/landing — heals rows stranded by earlier scans of parked work.
    const healed =
      existsSync(row.path) && (live.has(row.path) || awaitingReviewOrLanding(row.contractId));
    if (!healed) continue;
    if (reviveStrandedWorktree(row.id)) revived.push(row.name);
  }
  return { stranded, revived };
}

/** True when the worktree's contract is parked for review/landing: verification
 *  passed (merge-ready), or pending/failed WITH a deliverable ('pending' =
 *  review tier / restart-parked sealed work; 'failed' = verification-failed
 *  or review-rejected, whose declared recovery is a fix continuation IN this
 *  worktree), and the work is neither landed nor abandoned. Such worktrees
 *  are deliberately runless — landing + teardown, a fix continuation, or
 *  abandonment reclaims them, never the stranded scan. A contract with
 *  NOTHING delivered has no reclaim path — its dead run's worktree is
 *  genuinely stranded (doc Recovery: worktree present without a live run →
 *  stranded and surfaced) and must not hide behind the boot sweep's
 *  verification-'pending' park. */
function awaitingReviewOrLanding(contractId: ULID | null): boolean {
  if (!contractId) return false;
  const contract = getContract(contractId);
  if (!contract) return false;
  if (contract.landingStatus === 'landed' || contract.landingStatus === 'abandoned') return false;
  if (contract.verificationStatus === 'passed') return true;
  return (
    (contract.verificationStatus === 'pending' || contract.verificationStatus === 'failed') &&
    contract.deliverable != null
  );
}

/** Stamp lifecycle 'stranded' on the bound run — same guarded-write idiom as
 *  DispatchService.stampLifecycle. Run-lifecycle 'stranded' is terminal (no
 *  unflip); only the worktree ROW self-heals. */
function strandRunLifecycle(runId: ULID | null): void {
  if (!runId) return;
  const run = getAgentRunRow(runId);
  if (!run || run.lifecycleState === null) return;
  if (!canTransition(run.lifecycleState, 'stranded')) return;
  try {
    updateAgentRunStatus({ id: runId, status: run.status, lifecycleState: 'stranded' });
  } catch (err) {
    console.error(`[pc-sdk][worktree] lifecycle 'stranded' stamp refused for run ${runId}:`, err);
  }
}

/** The worktrees root for a project (`<projectDir>-worktrees`). */
export function worktreesRoot(projectDir: string): string {
  return `${projectDir.replace(/[\\/]+$/, '')}-worktrees`;
}

export function worktreeParent(dir: string): string {
  return dirname(dir);
}
