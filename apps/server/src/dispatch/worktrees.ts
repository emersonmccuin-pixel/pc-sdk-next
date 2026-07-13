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
// tip must be an ancestor of HEAD after the merge. The branch is preserved for
// unlanded/abandoned work (recoverable from the branch); it is deleted after
// a successful land. The worktree directory is always reclaimed on teardown.

import { execFile, spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, lstatSync, mkdirSync, readdirSync, realpathSync, rmSync } from 'node:fs';
import { basename, dirname, isAbsolute, join, normalize, resolve } from 'node:path';
import {
  getAgentRunRow,
  getContract,
  getWorktreeById,
  listAbandonedContractBranches,
  listActiveWorktrees,
  listNonTerminalAgentRuns,
  listProjects,
  listProtectedAbandonmentWorktreePaths,
  listStrandedWorktrees,
  markExactWorktreeDestroyed,
  markExactWorktreeSnapshotDestroyed,
  markExactUnpublishedWorktreeDestroyed,
  markWorktreeStranded,
  reviveStrandedWorktree,
  updateAgentRunStatus,
  upsertWorktree,
} from '@pc/db';
import {
  canTransition,
  isMatchingWorktreeAbandonmentTeardown,
  isWorktreeAbandonmentReceipt,
  WORKTREE_ABANDONMENT_CHANGED_PATHS_MAX,
  WORKTREE_ABANDONMENT_PREVIEW_PROTOCOL,
  WORKTREE_ABANDONMENT_TEARDOWN_PROTOCOL,
  type RepositoryIdentityReceipt,
  type ULID,
  type Worktree,
  type WorktreeAbandonmentPresentState,
  type WorktreeAbandonmentPreview,
  type WorktreeAbandonmentReceipt,
  type WorktreeAbandonmentState,
  type WorktreeAbandonmentTeardownReceipt,
  type WorktreeCommandStep,
  type WorktreeStrandedReason,
} from '@pc/domain';
import {
  requireRepositoryWorktreeRoot,
  RepositoryLeaseError,
  repositoryLeaseManager,
} from './repository-lease.ts';
import { buildChildEnvironment } from '../operations/child-environment.ts';

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
      {
        cwd,
        env: buildChildEnvironment(),
        timeout: timeoutMs,
        maxBuffer: 4 * 1024 * 1024,
        windowsHide: true,
      },
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

interface RawGitResult {
  ok: boolean;
  stdout: Buffer;
  stderr: string;
  code: number;
}

const RAW_GIT_MAX_BYTES = 64 * 1024 * 1024;
const RAW_GIT_STDERR_MAX_BYTES = 64 * 1024;

/** NUL-safe Git capture for machine-readable porcelain. The ordinary `git`
 * helper intentionally returns trimmed text; abandonment evidence instead
 * preserves exact bytes and fails closed when a pathological status listing
 * exceeds the bounded capture. */
function gitRaw(
  args: readonly string[],
  cwd: string,
  timeoutMs = GIT_TIMEOUT_MS,
): Promise<RawGitResult> {
  return new Promise((resolveResult) => {
    const child = spawn('git', [...args], {
      cwd,
      env: buildChildEnvironment(),
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    let stdoutBytes = 0;
    let stderrBytes = 0;
    let timedOut = false;
    let oversized = false;
    let finished = false;
    const finish = (code: number, extra = '') => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      const captured = Buffer.concat(stderr, stderrBytes).toString('utf8');
      resolveResult({
        ok: code === 0 && !timedOut && !oversized,
        stdout: Buffer.concat(stdout, stdoutBytes),
        stderr: [captured, extra].filter(Boolean).join('; '),
        code,
      });
    };
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill();
    }, timeoutMs);
    child.stdout.on('data', (chunk: Buffer) => {
      stdoutBytes += chunk.length;
      if (stdoutBytes > RAW_GIT_MAX_BYTES) {
        oversized = true;
        child.kill();
        return;
      }
      stdout.push(chunk);
    });
    child.stderr.on('data', (chunk: Buffer) => {
      if (stderrBytes >= RAW_GIT_STDERR_MAX_BYTES) return;
      const keep = chunk.subarray(0, RAW_GIT_STDERR_MAX_BYTES - stderrBytes);
      stderr.push(keep);
      stderrBytes += keep.length;
    });
    child.once('error', (error) => finish(1, error.message));
    child.once('close', (code) => finish(code ?? 1, timedOut ? 'git command timed out' : oversized ? 'git output exceeded evidence bound' : ''));
  });
}

interface GitOutputDigestResult {
  ok: boolean;
  digest: string;
  bytes: number;
  error: string;
}

/** Stream arbitrary Git output directly into SHA-256. Binary patches never
 * become JS strings and have no output-size truncation; only stderr is
 * retained, bounded, for an actionable refusal. */
function hashGitOutput(
  args: readonly string[],
  cwd: string,
  timeoutMs = GIT_TIMEOUT_MS,
): Promise<GitOutputDigestResult> {
  return new Promise((resolveResult) => {
    const child = spawn('git', [...args], {
      cwd,
      env: buildChildEnvironment(),
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const hash = createHash('sha256');
    const stderr: Buffer[] = [];
    let bytes = 0;
    let stderrBytes = 0;
    let timedOut = false;
    let finished = false;
    const finish = (code: number, extra = '') => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      const detail = [Buffer.concat(stderr, stderrBytes).toString('utf8'), extra]
        .filter(Boolean)
        .join('; ');
      resolveResult({
        ok: code === 0 && !timedOut,
        digest: `sha256:${hash.digest('hex')}`,
        bytes,
        error: detail,
      });
    };
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill();
    }, timeoutMs);
    child.stdout.on('data', (chunk: Buffer) => {
      hash.update(chunk);
      bytes += chunk.length;
    });
    child.stderr.on('data', (chunk: Buffer) => {
      if (stderrBytes >= RAW_GIT_STDERR_MAX_BYTES) return;
      const keep = chunk.subarray(0, RAW_GIT_STDERR_MAX_BYTES - stderrBytes);
      stderr.push(keep);
      stderrBytes += keep.length;
    });
    child.once('error', (error) => finish(1, error.message));
    child.once('close', (code) => finish(code ?? 1, timedOut ? 'git command timed out' : ''));
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
  worktreeId: ULID;
  projectId: ULID | null;
  agentRunId: ULID;
  dir: string;
  branch: string;
  baseBranch: string;
  baseSha: string;
  /** Positive clean-initial-status check — always true on ok (a dirty fresh
   *  worktree refuses). Recorded on the Git receipt. */
  cleanStatus: boolean;
  /** Immutable canonical repository authority frozen into the Git receipt. */
  repositoryIdentity: RepositoryIdentityReceipt;
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
  opts: {
    baseBranch?: string | null;
    projectId?: ULID | null;
    expectedIdentity?: RepositoryIdentityReceipt | null;
  } = {},
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
  let current = await git(['rev-parse', '--abbrev-ref', 'HEAD'], projectDir);
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
  let baseSha = await git(['rev-parse', `refs/heads/${base}`], projectDir);
  if (!baseSha.ok) {
    return { ok: false, error: `cannot resolve base branch tip: ${baseSha.stderr}` };
  }
  let repositoryIdentity: RepositoryIdentityReceipt;
  let authorizedProjectDir: string;
  try {
    const repositoryLease = await repositoryLeaseManager.acquire(
      projectDir,
      opts.expectedIdentity ?? null,
    );
    repositoryIdentity = repositoryLease.identity;
    authorizedProjectDir = await repositoryLeaseManager.resolveHeldRuntimeCwd(
      repositoryLease,
      projectDir,
      repositoryIdentity,
    );
    authorizedProjectDir = await requireRepositoryWorktreeRoot(authorizedProjectDir);
  } catch (error) {
    return { ok: false, error: repositoryLeaseMessage(error) };
  }
  // Every preliminary check above is repeated after positive authority. Only
  // this under-lease evidence can authorize the worktree mutation.
  current = await git(['rev-parse', '--abbrev-ref', 'HEAD'], authorizedProjectDir);
  if (!current.ok || current.stdout !== base) {
    return {
      ok: false,
      error: !current.ok
        ? `cannot resolve HEAD under repository authority: ${current.stderr}`
        : `project moved to '${current.stdout}' after repository admission (expected '${base}')`,
    };
  }
  baseSha = await git(['rev-parse', `refs/heads/${base}`], authorizedProjectDir);
  if (!baseSha.ok) {
    return { ok: false, error: `cannot resolve base branch tip under repository authority: ${baseSha.stderr}` };
  }
  const branch = `agent-${runId.slice(-8).toLowerCase()}`;
  const root = worktreesRoot(authorizedProjectDir);
  if (!isSafeWorktreeRoot(authorizedProjectDir)) {
    return { ok: false, error: `worktree root is not a real owned directory: ${root}` };
  }
  mkdirSync(root, { recursive: true });
  if (!isSafeWorktreeRoot(authorizedProjectDir)) {
    return { ok: false, error: `worktree root became unsafe during provisioning: ${root}` };
  }
  const dir = join(root, branch);
  const add = await git(['worktree', 'add', '-b', branch, dir, baseSha.stdout], authorizedProjectDir);
  if (!add.ok) {
    return { ok: false, error: `git worktree add failed: ${add.stderr || add.stdout}` };
  }
  // Row first — a dirty refusal below preserves the dir, and the stranded scan
  // must still see it. Binding fields stamp here; contractId follows at
  // contract creation (setWorktreeContractId).
  const worktreeRow = upsertWorktree({
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
  return {
    ok: true,
    worktreeId: worktreeRow.id,
    projectId: worktreeRow.projectId,
    agentRunId: runId as ULID,
    dir,
    branch,
    baseBranch: base,
    baseSha: baseSha.stdout,
    cleanStatus: true,
    repositoryIdentity,
  };
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
  expectedIdentity: RepositoryIdentityReceipt,
): Promise<{ ok: true; dir: string } | { ok: false; error: string }> {
  if (!projectDir || !existsSync(projectDir)) {
    return { ok: false, error: `project folder missing: ${projectDir || '(unset)'}` };
  }
  try {
    await repositoryLeaseManager.acquire(projectDir, expectedIdentity);
  } catch (error) {
    return { ok: false, error: repositoryLeaseMessage(error) };
  }
  const root = worktreesRoot(projectDir);
  if (!isSafeWorktreeRoot(projectDir)) {
    return { ok: false, error: `worktree root is not a real owned directory: ${root}` };
  }
  mkdirSync(root, { recursive: true });
  if (!isSafeWorktreeRoot(projectDir)) {
    return { ok: false, error: `worktree root became unsafe during review provisioning: ${root}` };
  }
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
export async function removeReviewCheckout(
  projectDir: string,
  dir: string,
  expectedIdentity: RepositoryIdentityReceipt,
): Promise<boolean> {
  if (!isOwnedWorktreePath(projectDir, dir)) {
    console.warn(`[pc-sdk][worktree] review checkout path is outside the owned worktree root: ${dir}`);
    return false;
  }
  try {
    await repositoryLeaseManager.acquire(projectDir, expectedIdentity);
  } catch (error) {
    console.warn(`[pc-sdk][worktree] review checkout authority unavailable for ${dir}: ${repositoryLeaseMessage(error)}`);
    return false;
  }
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
  /** The owning run became terminal while lease/command work was awaiting.
   * No later command was admitted and callers must not persist phase evidence. */
  cancelled: boolean;
}

/** Run profile commands sequentially IN the worktree via the platform shell
 *  (same spawn idiom as the verification runBash executor). Bounded output
 *  tails; stops at the first nonzero exit. Never throws. */
export function runProfileCommands(
  dir: string,
  commands: readonly string[],
  timeoutMs = PROFILE_CMD_TIMEOUT_MS,
  expectedIdentity: RepositoryIdentityReceipt | null = null,
  shouldContinue: (() => boolean) | null = null,
): Promise<ProfileCommandsResult> {
  return (async () => {
    try {
      await repositoryLeaseManager.acquire(dir, expectedIdentity);
    } catch (error) {
      return {
        ok: false,
        cancelled: false,
        steps: commands.length === 0
          ? []
          : [{
              command: commands[0]!,
              exitCode: 1,
              durationMs: 0,
              stdoutTail: '',
              stderrTail: repositoryLeaseMessage(error),
              timedOut: false,
            }],
      };
    }
    // Lease discovery is asynchronous. The owning run may have been killed
    // after the dispatch-side check but before this mutation door reopened.
    if (shouldContinue && !shouldContinue()) {
      return { ok: false, steps: [], cancelled: true };
    }
    const steps: WorktreeCommandStep[] = [];
    for (const command of commands) {
      if (shouldContinue && !shouldContinue()) {
        return { ok: false, steps, cancelled: true };
      }
      const step = await runProfileCommand(dir, command, timeoutMs);
      steps.push(step);
      if (step.exitCode !== 0) return { ok: false, steps, cancelled: false };
      // A cancellation during one command prevents admission of the next.
      if (shouldContinue && !shouldContinue()) {
        return { ok: false, steps, cancelled: true };
      }
    }
    return { ok: true, steps, cancelled: false };
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

/** Build every profile/verification shell environment from the shared positive
 *  OS-essential allowlist. Step output tails persist durably into phase
 *  receipts, so an env-echoing command must never receive an unrelated ambient
 *  capability (docs/worktree-lifecycle.md: secrets require explicit policy). */
export function sanitizedShellEnv(base: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  return buildChildEnvironment(base);
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
  const shell = trustedPlatformShell();
  if (shell === null) {
    return Promise.resolve({
      exitCode: 127,
      timedOut: false,
      stdout: '',
      stderr: 'trusted platform shell is unavailable',
    });
  }
  const env = sanitizedShellEnv(opts.env);
  if (process.platform === 'win32') env.COMSPEC = shell;
  return new Promise((resolve) => {
    const child = spawn(command, {
      cwd: opts.cwd,
      shell,
      windowsHide: true,
      env,
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

/** Pin the shell executable rather than letting Node consult ambient ComSpec.
 *  Windows SystemRoot/windir are independently allowlisted OS inputs; when
 *  both exist they must identify the same absolute native directory. Missing,
 *  conflicting, or non-file evidence fails closed with exit 127. */
function trustedPlatformShell(): string | null {
  if (process.platform !== 'win32') return '/bin/sh';
  const host = buildChildEnvironment();
  const roots = [host.SYSTEMROOT, host.WINDIR].filter(
    (value): value is string => typeof value === 'string' && isAbsolute(value),
  );
  if (roots.length === 0) return null;
  const identities = new Set(roots.map((root) => normalize(resolve(root)).toLowerCase()));
  if (identities.size !== 1) return null;
  const shell = join(roots[0]!, 'System32', 'cmd.exe');
  try {
    return lstatSync(shell).isFile() ? realpathSync(shell) : null;
  } catch {
    return null;
  }
}

/** Kill a shell AND everything it spawned. Best-effort, never throws. */
function killProcessTree(pid: number | undefined): void {
  if (!pid) return;
  if (process.platform === 'win32') {
    execFile('taskkill', ['/PID', String(pid), '/T', '/F'], {
      env: buildChildEnvironment(),
      windowsHide: true,
    }, () => {});
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
  repositoryIdentity?: RepositoryIdentityReceipt | null;
}): Promise<LandOutcome> {
  const { projectDir, branch, baseBranch } = input;
  try {
    await repositoryLeaseManager.acquire(projectDir, input.repositoryIdentity ?? null);
  } catch (error) {
    return { outcome: 'failed', error: repositoryLeaseMessage(error) };
  }
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

/** Roll back a fresh worktree that lost service admission before any contract
 * or run was published. Unlike normal teardown, this exact pristine branch has
 * no durable owner and must not leak. Any dirty state, tip/branch drift,
 * removal uncertainty, or branch-delete uncertainty preserves the active row
 * for recovery instead of claiming rollback. */
export async function rollbackUnpublishedWorktree(
  projectDir: string,
  provisioned: ProvisionedWorktree,
): Promise<boolean> {
  if (!provisioned.projectId) return false;
  try {
    await repositoryLeaseManager.acquire(projectDir, provisioned.repositoryIdentity);
    await repositoryLeaseManager.acquire(provisioned.dir, provisioned.repositoryIdentity);
  } catch (error) {
    console.warn(
      `[pc-sdk][worktree] unpublished rollback authority unavailable for ${provisioned.dir}: ${repositoryLeaseMessage(error)}`,
    );
    return false;
  }
  const [branch, tip, status] = await Promise.all([
    git(['rev-parse', '--abbrev-ref', 'HEAD'], provisioned.dir),
    git(['rev-parse', 'HEAD'], provisioned.dir),
    git(['status', '--porcelain=v1', '--untracked-files=all'], provisioned.dir),
  ]);
  if (
    !branch.ok ||
    !tip.ok ||
    !status.ok ||
    branch.stdout !== provisioned.branch ||
    tip.stdout !== provisioned.baseSha ||
    status.stdout !== ''
  ) {
    console.warn(
      `[pc-sdk][worktree] unpublished rollback preserved ${provisioned.dir}: checkout is no longer the exact pristine provision`,
    );
    return false;
  }
  // Deliberately non-force: Git rechecks dirty/untracked state at the mutation
  // door, closing the gap after the diagnostic pristine snapshot above.
  const removed = await git(['worktree', 'remove', provisioned.dir], projectDir);
  if (
    !removed.ok ||
    existsSync(provisioned.dir) ||
    await isRegisteredWorktree(projectDir, provisioned.dir)
  ) {
    console.warn(
      `[pc-sdk][worktree] unpublished rollback could not positively remove ${provisioned.dir}: ${removed.stderr}`,
    );
    return false;
  }
  const branchRef = `refs/heads/${provisioned.branch}`;
  // Atomic compare-and-delete: a manual/nonparticipant ref advance wins and is
  // preserved rather than being erased after an earlier tip observation.
  const deleted = await git(
    ['update-ref', '-d', branchRef, provisioned.baseSha],
    projectDir,
  );
  const branchAbsence = await git(
    ['for-each-ref', '--format=%(refname)', branchRef],
    projectDir,
  );
  if (!deleted.ok || !branchAbsence.ok || branchAbsence.stdout !== '') {
    console.warn(
      `[pc-sdk][worktree] unpublished rollback branch delete failed for ${provisioned.branch}: ${deleted.stderr}`,
    );
    return false;
  }
  return markExactUnpublishedWorktreeDestroyed({
    id: provisioned.worktreeId,
    projectId: provisioned.projectId,
    agentRunId: provisioned.agentRunId,
    path: provisioned.dir,
    name: provisioned.branch,
    branch: provisioned.branch,
    baseBranch: provisioned.baseBranch,
    baseSha: provisioned.baseSha,
    destroyedAt: Date.now(),
  });
}

// ── Browser-approved abandonment evidence (DL-002) ─────────────────────────

const ABANDONMENT_STATE_DIGEST_PROTOCOL = 'worktree-abandonment-state-v1';

export interface InspectWorktreeAbandonmentInput {
  projectDir: string;
  projectId: ULID;
  contractId: ULID;
  contractVersion: number;
  producerRunId: ULID;
  /** Exact durable ownership row selected by the service/persistence door. */
  worktree: Worktree;
  expectedBaseBranch: string;
  provisionedBaseSha: string;
  /** Verification-covered target base, falling back to provision-time base. */
  validatedBaseSha: string;
  repositoryIdentity: RepositoryIdentityReceipt;
}

export type WorktreeAbandonmentInspectionCode =
  | 'repository-unavailable'
  | 'binding-mismatch'
  | 'registration-mismatch'
  | 'branch-unavailable'
  | 'integration-inconclusive'
  | 'already-merged'
  | 'worktree-state-unavailable'
  | 'worktree-state-changed';

export type WorktreeAbandonmentInspectionResult =
  | { ok: true; preview: WorktreeAbandonmentPreview }
  | { ok: false; code: WorktreeAbandonmentInspectionCode; error: string };

interface WorktreeRegistration {
  path: string;
  head: string | null;
  branch: string | null;
}

type RegistrationRead =
  | { ok: true; rows: WorktreeRegistration[] }
  | { ok: false; error: string };

function splitNul(input: Buffer): Buffer[] {
  const out: Buffer[] = [];
  let start = 0;
  for (let i = 0; i < input.length; i += 1) {
    if (input[i] !== 0) continue;
    out.push(input.subarray(start, i));
    start = i + 1;
  }
  if (start < input.length) out.push(input.subarray(start));
  return out;
}

async function readWorktreeRegistrations(projectDir: string): Promise<RegistrationRead> {
  const result = await gitRaw(['worktree', 'list', '--porcelain', '-z'], projectDir);
  if (!result.ok) {
    return { ok: false, error: result.stderr || 'git worktree list failed' };
  }
  const rows: WorktreeRegistration[] = [];
  let fields: Buffer[] = [];
  const flush = (): boolean => {
    if (fields.length === 0) return true;
    const pathField = fields.find((field) => field.subarray(0, 9).equals(Buffer.from('worktree ')));
    if (!pathField) return false;
    const headField = fields.find((field) => field.subarray(0, 5).equals(Buffer.from('HEAD ')));
    const branchField = fields.find((field) => field.subarray(0, 7).equals(Buffer.from('branch ')));
    const branchRef = branchField?.subarray(7).toString('utf8') ?? null;
    rows.push({
      path: pathField.subarray(9).toString('utf8'),
      head: headField?.subarray(5).toString('ascii') ?? null,
      branch: branchRef?.startsWith('refs/heads/') ? branchRef.slice('refs/heads/'.length) : null,
    });
    fields = [];
    return true;
  };
  for (const field of splitNul(result.stdout)) {
    if (field.length === 0) {
      if (!flush()) return { ok: false, error: 'malformed git worktree registration evidence' };
    } else {
      fields.push(field);
    }
  }
  if (!flush()) return { ok: false, error: 'malformed git worktree registration evidence' };
  return { ok: true, rows };
}

function registrationForPath(
  rows: readonly WorktreeRegistration[],
  path: string,
): WorktreeRegistration | null | 'duplicate' {
  const target = normalizePathKey(path);
  const matches = rows.filter((row) => normalizePathKey(row.path) === target);
  if (matches.length > 1) return 'duplicate';
  return matches[0] ?? null;
}

function canonicalJson(value: unknown): string {
  if (value === null || typeof value === 'boolean' || typeof value === 'string') {
    return JSON.stringify(value);
  }
  if (typeof value === 'number') {
    if (!Number.isSafeInteger(value)) throw new Error('canonical abandonment evidence requires safe integers');
    return String(value);
  }
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (typeof value !== 'object') throw new Error('unsupported abandonment evidence value');
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`).join(',')}}`;
}

function sha256Canonical(value: unknown): string {
  return `sha256:${createHash('sha256').update(canonicalJson(value), 'utf8').digest('hex')}`;
}

function sha256Buffer(value: Buffer): string {
  return `sha256:${createHash('sha256').update(value).digest('hex')}`;
}

/** Deterministic browser approval binding. Object key insertion order is not
 * authority: canonical JSON sorts every record key and preserves array order. */
export function computeWorktreeAbandonmentPreviewDigest(
  preview: Omit<WorktreeAbandonmentPreview, 'previewDigest'>,
): string {
  return sha256Canonical(preview);
}

interface ParsedPorcelainStatus {
  staged: number;
  unstaged: number;
  untracked: Buffer[];
  changedPaths: Buffer[];
}

function parsePorcelainV1Z(raw: Buffer): ParsedPorcelainStatus | null {
  const fields = splitNul(raw);
  const untracked: Buffer[] = [];
  const changedPaths: Buffer[] = [];
  let staged = 0;
  let unstaged = 0;
  for (let i = 0; i < fields.length; i += 1) {
    const field = fields[i]!;
    if (field.length === 0) continue;
    if (field.length < 4 || field[2] !== 0x20) return null;
    const x = String.fromCharCode(field[0]!);
    const y = String.fromCharCode(field[1]!);
    const path = Buffer.from(field.subarray(3));
    if (x === '?' && y === '?') {
      untracked.push(path);
      changedPaths.push(path);
      continue;
    }
    if (x === '!' && y === '!') return null; // ignored entries were not requested
    if (x !== ' ') staged += 1;
    if (y !== ' ') unstaged += 1;
    changedPaths.push(path);
    if (x === 'R' || x === 'C') {
      const original = fields[i + 1];
      if (!original || original.length === 0) return null;
      changedPaths.push(Buffer.from(original));
      i += 1;
    }
  }
  return { staged, unstaged, untracked, changedPaths };
}

async function hashUntrackedPath(dir: string, path: Buffer): Promise<string | null> {
  // Windows worktree paths are UTF-8 representable. `--` prevents a hostile
  // leading dash in a filename from becoming an option.
  const name = path.toString('utf8');
  const result = await gitRaw(['hash-object', '--no-filters', '--', name], dir);
  if (!result.ok) return null;
  const oid = result.stdout.toString('ascii').trim();
  return /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/u.test(oid) ? oid : null;
}

async function capturePresentAbandonmentState(
  dir: string,
): Promise<WorktreeAbandonmentPresentState | null> {
  const statusResult = await gitRaw(
    ['--no-optional-locks', 'status', '--porcelain=v1', '-z', '--untracked-files=all', '--ignore-submodules=none'],
    dir,
  );
  if (!statusResult.ok) return null;
  const parsed = parsePorcelainV1Z(statusResult.stdout);
  if (!parsed) return null;

  const diffArgs = ['diff', '--binary', '--full-index', '--no-ext-diff', '--no-textconv', '--no-color', '--no-renames'];
  const [stagedDiff, unstagedDiff] = await Promise.all([
    hashGitOutput([...diffArgs, '--cached', '--'], dir),
    hashGitOutput([...diffArgs, '--'], dir),
  ]);
  if (!stagedDiff.ok || !unstagedDiff.ok) return null;

  const sortedUntracked = [...parsed.untracked].sort(Buffer.compare);
  const untrackedEvidence: Array<{ pathBase64: string; objectId: string }> = [];
  for (const path of sortedUntracked) {
    const objectId = await hashUntrackedPath(dir, path);
    if (!objectId) return null;
    untrackedEvidence.push({ pathBase64: path.toString('base64'), objectId });
  }

  const worktreeStateDigest = sha256Canonical({
    protocol: ABANDONMENT_STATE_DIGEST_PROTOCOL,
    porcelainV1Z: sha256Buffer(statusResult.stdout),
    stagedDiff: { bytes: stagedDiff.bytes, digest: stagedDiff.digest },
    unstagedDiff: { bytes: unstagedDiff.bytes, digest: unstagedDiff.digest },
    untracked: untrackedEvidence,
  });
  const summary = [...parsed.changedPaths]
    .sort(Buffer.compare)
    .filter((path, index, all) => index === 0 || !path.equals(all[index - 1]!))
    .slice(0, WORKTREE_ABANDONMENT_CHANGED_PATHS_MAX)
    .map((path) => path.toString('utf8'));
  const dirty = parsed.staged > 0 || parsed.unstaged > 0 || parsed.untracked.length > 0;
  return {
    directory: 'present',
    registration: 'registered',
    status: dirty ? 'dirty' : 'clean',
    staged: parsed.staged,
    unstaged: parsed.unstaged,
    untracked: parsed.untracked.length,
    worktreeStateDigest,
    changedPaths: summary,
    ignoredContents: 'uninspected',
  };
}

interface IntegrationEvidence {
  branchTip: string;
  targetTip: string;
  integrationState: WorktreeAbandonmentPreview['integrationState'];
}

type IntegrationResult =
  | { ok: true; evidence: IntegrationEvidence }
  | { ok: false; code: 'branch-unavailable' | 'integration-inconclusive' | 'already-merged'; error: string };

async function inspectBranchIntegration(input: {
  projectDir: string;
  branch: string;
  baseBranch: string;
  provisionedBaseSha: string;
  validatedBaseSha: string;
}): Promise<IntegrationResult> {
  const branchTip = await git(['rev-parse', '--verify', '--quiet', `refs/heads/${input.branch}`], input.projectDir);
  if (!branchTip.ok || !/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/u.test(branchTip.stdout)) {
    return { ok: false, code: 'branch-unavailable', error: `approved branch '${input.branch}' is unavailable` };
  }
  const targetTip = await git(['rev-parse', '--verify', '--quiet', `refs/heads/${input.baseBranch}`], input.projectDir);
  if (!targetTip.ok || !/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/u.test(targetTip.stdout)) {
    return { ok: false, code: 'integration-inconclusive', error: `target branch '${input.baseBranch}' is unavailable` };
  }

  // The provision receipt must still be in the feature branch history; a
  // force-reset onto unrelated history is not the work PC-SDK provisioned.
  const provisionAncestor = await git(
    ['merge-base', '--is-ancestor', input.provisionedBaseSha, branchTip.stdout],
    input.projectDir,
  );
  if (!provisionAncestor.ok) {
    return {
      ok: false,
      code: 'integration-inconclusive',
      error: `branch '${input.branch}' no longer descends from its provisioned base`,
    };
  }
  // The verification-covered target must remain on the target branch's
  // current lineage. Exit 1 is drift/rewriting, not positive non-integration.
  const validatedAncestor = await git(
    ['merge-base', '--is-ancestor', input.validatedBaseSha, targetTip.stdout],
    input.projectDir,
  );
  if (!validatedAncestor.ok) {
    return {
      ok: false,
      code: 'integration-inconclusive',
      error: `target '${input.baseBranch}' no longer descends from the validated base`,
    };
  }
  const validatedBranchAncestor = await git(
    ['merge-base', '--is-ancestor', input.validatedBaseSha, branchTip.stdout],
    input.projectDir,
  );
  if (!validatedBranchAncestor.ok) {
    return {
      ok: false,
      code: 'integration-inconclusive',
      error: `branch '${input.branch}' does not descend from the validated base`,
    };
  }
  const ahead = await git(
    ['rev-list', '--count', `${input.validatedBaseSha}..${branchTip.stdout}`],
    input.projectDir,
  );
  const exclusiveCommits = Number(ahead.stdout);
  if (!ahead.ok || !Number.isSafeInteger(exclusiveCommits) || exclusiveCommits < 0) {
    return { ok: false, code: 'integration-inconclusive', error: 'cannot count branch-exclusive commits' };
  }
  if (exclusiveCommits === 0) {
    return {
      ok: true,
      evidence: { branchTip: branchTip.stdout, targetTip: targetTip.stdout, integrationState: 'no-exclusive-commits' },
    };
  }
  const integrated = await git(
    ['merge-base', '--is-ancestor', branchTip.stdout, targetTip.stdout],
    input.projectDir,
  );
  if (integrated.ok) {
    return {
      ok: false,
      code: 'already-merged',
      error: `branch '${input.branch}' tip is already integrated into '${input.baseBranch}'`,
    };
  }
  if (integrated.code !== 1) {
    return { ok: false, code: 'integration-inconclusive', error: 'branch integration probe was inconclusive' };
  }
  return {
    ok: true,
    evidence: { branchTip: branchTip.stdout, targetTip: targetTip.stdout, integrationState: 'unmerged' },
  };
}

function bindingError(input: InspectWorktreeAbandonmentInput): string | null {
  const row = input.worktree;
  if (row.status !== 'active' && row.status !== 'stranded') return 'worktree row is not active or stranded';
  if (row.projectId !== input.projectId) return 'worktree project binding does not match the contract';
  if (row.contractId !== input.contractId) return 'worktree contract binding does not match';
  if (row.agentRunId !== input.producerRunId) return 'worktree producer binding does not match';
  if (!row.branch || row.name !== row.branch || basename(row.path) !== row.branch) return 'worktree branch/path binding is invalid';
  if (!row.baseBranch || !row.baseSha) return 'worktree base evidence is unavailable';
  if (row.baseBranch !== input.expectedBaseBranch) return 'worktree base branch does not match the contract';
  if (row.baseSha !== input.provisionedBaseSha) return 'worktree provisioned base does not match the contract';
  if (!/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/u.test(row.baseSha)) return 'worktree provisioned base is invalid';
  if (!/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/u.test(input.validatedBaseSha)) return 'validated base is invalid';
  if (!Number.isSafeInteger(input.contractVersion) || input.contractVersion < 1) return 'contract version is invalid';
  if (!isOwnedWorktreePath(input.projectDir, row.path)) return 'worktree path is outside the app-owned root';
  return null;
}

/** Read-only, content-binding abandonment preview. The caller owns contract
 * eligibility/liveness; this function owns repository/path/row/Git evidence.
 * Every inconclusive Git result refuses rather than being interpreted as
 * "not merged". */
export async function inspectWorktreeAbandonment(
  input: InspectWorktreeAbandonmentInput,
): Promise<WorktreeAbandonmentInspectionResult> {
  const invalid = bindingError(input);
  if (invalid) return { ok: false, code: 'binding-mismatch', error: invalid };
  try {
    const lease = await repositoryLeaseManager.acquire(input.projectDir, input.repositoryIdentity);
    const root = await requireRepositoryWorktreeRoot(input.projectDir);
    await repositoryLeaseManager.assertHeld(lease, root, input.repositoryIdentity);
    if (existsSync(input.worktree.path)) {
      await repositoryLeaseManager.acquire(input.worktree.path, input.repositoryIdentity);
    }
  } catch (error) {
    return { ok: false, code: 'repository-unavailable', error: repositoryLeaseMessage(error) };
  }

  const registrations = await readWorktreeRegistrations(input.projectDir);
  if (!registrations.ok) {
    return { ok: false, code: 'registration-mismatch', error: registrations.error };
  }
  const registration = registrationForPath(registrations.rows, input.worktree.path);
  if (registration === 'duplicate') {
    return { ok: false, code: 'registration-mismatch', error: 'duplicate worktree registrations exist for the approved path' };
  }

  const branch = input.worktree.branch!;
  const baseBranch = input.worktree.baseBranch!;
  const integration = await inspectBranchIntegration({
    projectDir: input.projectDir,
    branch,
    baseBranch,
    provisionedBaseSha: input.worktree.baseSha!,
    validatedBaseSha: input.validatedBaseSha,
  });
  if (!integration.ok) return integration;

  if (registration && (registration.branch !== branch || registration.head !== integration.evidence.branchTip)) {
    return {
      ok: false,
      code: 'registration-mismatch',
      error: 'worktree registration does not bind the exact approved path, branch, and tip',
    };
  }

  const present = existsSync(input.worktree.path);
  let worktreeState: WorktreeAbandonmentState;
  if (!present) {
    worktreeState = {
      directory: 'missing',
      registration: registration ? 'registered' : 'absent',
      status: 'unavailable',
      worktreeStateDigest: sha256Canonical({
        protocol: ABANDONMENT_STATE_DIGEST_PROTOCOL,
        directory: 'missing',
        registration: registration ? 'registered' : 'absent',
      }),
      changedPaths: [],
      ignoredContents: 'uninspected',
    };
  } else {
    if (!registration) {
      return {
        ok: false,
        code: 'registration-mismatch',
        error: 'present worktree path has no exact Git registration',
      };
    }
    // Capture twice so a mutation concurrent with inspection cannot produce a
    // receipt assembled from different filesystem moments.
    const first = await capturePresentAbandonmentState(input.worktree.path);
    const second = await capturePresentAbandonmentState(input.worktree.path);
    if (!first || !second) {
      return { ok: false, code: 'worktree-state-unavailable', error: 'cannot read exact worktree status/diff/content evidence' };
    }
    if (first.worktreeStateDigest !== second.worktreeStateDigest) {
      return { ok: false, code: 'worktree-state-changed', error: 'worktree contents changed during abandonment inspection' };
    }
    worktreeState = second;
  }

  const material: Omit<WorktreeAbandonmentPreview, 'previewDigest'> = {
    protocol: WORKTREE_ABANDONMENT_PREVIEW_PROTOCOL,
    projectId: input.projectId,
    contractId: input.contractId,
    contractVersion: input.contractVersion,
    producerRunId: input.producerRunId,
    worktreeId: input.worktree.id,
    worktreeStatus: input.worktree.status as 'active' | 'stranded',
    worktreePath: input.worktree.path,
    branch,
    branchTip: integration.evidence.branchTip,
    baseBranch,
    validatedBaseSha: input.validatedBaseSha,
    targetTip: integration.evidence.targetTip,
    integrationState: integration.evidence.integrationState,
    repositoryIdentity: input.repositoryIdentity,
    worktreeState,
  };
  return {
    ok: true,
    preview: { ...material, previewDigest: computeWorktreeAbandonmentPreviewDigest(material) },
  };
}

/** Force-delete a worktree directory on the filesystem — the fallback for
 *  when `git worktree remove --force` unregisters the worktree but can't
 *  actually delete it (Windows holds locked binaries inside node_modules
 *  after an agent's `pnpm install`). Best-effort, never throws. */
function forceRemoveDir(dir: string): void {
  try {
    rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  } catch (err) {
    console.warn(`[pc-sdk][worktree] filesystem force-delete failed for ${dir}:`, err);
  }
}

export type WorktreeAbandonmentTeardownCode =
  | 'invalid-authority'
  | 'repository-unavailable'
  | 'binding-mismatch'
  | 'branch-drifted'
  | 'registration-mismatch'
  | 'removal-incomplete';

export type WorktreeAbandonmentTeardownResult =
  | { ok: true; receipt: WorktreeAbandonmentTeardownReceipt }
  | { ok: false; code: WorktreeAbandonmentTeardownCode; error: string };

export interface SettleAbandonedWorktreeInput {
  projectDir: string;
  authority: WorktreeAbandonmentReceipt;
}

/** Receipt-backed destructive settlement. This is deliberately separate from
 * ordinary landed teardown: it runs no profile cleanup, never deletes/moves a
 * branch, accepts partial prior removal only after durable authority, and
 * returns success solely from three positive observations (directory absent,
 * registration absent, branch still at the approved tip). */
export async function settleAbandonedWorktree(
  input: SettleAbandonedWorktreeInput,
): Promise<WorktreeAbandonmentTeardownResult> {
  const { authority } = input;
  if (!isWorktreeAbandonmentReceipt(authority)) {
    return { ok: false, code: 'invalid-authority', error: 'abandonment authority receipt is invalid' };
  }
  if (
    basename(authority.worktreePath) !== authority.branch ||
    !isOwnedWorktreePath(input.projectDir, authority.worktreePath)
  ) {
    return { ok: false, code: 'binding-mismatch', error: 'approved worktree path is outside the app-owned root or no longer matches its branch' };
  }

  const startedAt = Date.now();
  try {
    const lease = await repositoryLeaseManager.acquire(input.projectDir, authority.repositoryIdentity);
    const root = await requireRepositoryWorktreeRoot(input.projectDir);
    await repositoryLeaseManager.assertHeld(lease, root, authority.repositoryIdentity);
    if (existsSync(authority.worktreePath)) {
      await repositoryLeaseManager.acquire(authority.worktreePath, authority.repositoryIdentity);
    }
  } catch (error) {
    return { ok: false, code: 'repository-unavailable', error: repositoryLeaseMessage(error) };
  }

  const beforeTip = await git(
    ['rev-parse', '--verify', '--quiet', `refs/heads/${authority.branch}`],
    input.projectDir,
  );
  if (!beforeTip.ok || beforeTip.stdout !== authority.branchTip) {
    return {
      ok: false,
      code: 'branch-drifted',
      error: `approved branch '${authority.branch}' is missing or no longer at ${authority.branchTip}`,
    };
  }

  const beforeList = await readWorktreeRegistrations(input.projectDir);
  if (!beforeList.ok) {
    return { ok: false, code: 'registration-mismatch', error: beforeList.error };
  }
  const beforeRegistration = registrationForPath(beforeList.rows, authority.worktreePath);
  if (beforeRegistration === 'duplicate') {
    return { ok: false, code: 'registration-mismatch', error: 'duplicate worktree registrations exist for the approved path' };
  }
  if (
    beforeRegistration &&
    (beforeRegistration.branch !== authority.branch || beforeRegistration.head !== authority.branchTip)
  ) {
    return {
      ok: false,
      code: 'registration-mismatch',
      error: 'worktree registration no longer binds the approved branch and tip',
    };
  }
  // Re-check immediately before the first recursive/remove mutation. Git and
  // branch evidence above awaited child processes; an owned root/path that
  // became a symlink or junction in that interval must fail closed.
  if (!isOwnedWorktreePath(input.projectDir, authority.worktreePath)) {
    return { ok: false, code: 'binding-mismatch', error: 'approved worktree root/path became unsafe before removal' };
  }

  if (beforeRegistration) {
    const removed = await git(['worktree', 'remove', '--force', authority.worktreePath], input.projectDir);
    if (!removed.ok && existsSync(authority.worktreePath)) {
      // Authority is already durable and exact. A Windows lock can let Git
      // unregister yet leave files behind; remove only this positively owned
      // direct child and prove the result below.
      if (!isOwnedWorktreePath(input.projectDir, authority.worktreePath)) {
        return { ok: false, code: 'binding-mismatch', error: 'approved worktree root/path became unsafe after Git removal failed' };
      }
      forceRemoveDir(authority.worktreePath);
    }
    await git(['worktree', 'prune'], input.projectDir);
  } else if (existsSync(authority.worktreePath)) {
    // Crash recovery after Git unregistered but before filesystem removal.
    forceRemoveDir(authority.worktreePath);
    await git(['worktree', 'prune'], input.projectDir);
  }

  if (existsSync(authority.worktreePath)) {
    return { ok: false, code: 'removal-incomplete', error: 'approved worktree directory still exists after removal' };
  }
  const afterList = await readWorktreeRegistrations(input.projectDir);
  if (!afterList.ok) {
    return { ok: false, code: 'registration-mismatch', error: afterList.error };
  }
  if (registrationForPath(afterList.rows, authority.worktreePath) !== null) {
    return { ok: false, code: 'removal-incomplete', error: 'Git still registers the approved worktree path' };
  }
  const observed = await git(
    ['rev-parse', '--verify', '--quiet', `refs/heads/${authority.branch}`],
    input.projectDir,
  );
  if (!observed.ok || observed.stdout !== authority.branchTip) {
    return {
      ok: false,
      code: 'branch-drifted',
      error: `branch preservation proof failed for '${authority.branch}'`,
    };
  }
  let receiptStartedAt = startedAt;
  let finishedAt: number;
  const existingRow = getWorktreeById(authority.worktreeId);
  const alreadyExact = existingRow !== null &&
    existingRow.destroyedAt !== null &&
    existingRow.status === 'destroyed' &&
    existingRow.projectId === authority.projectId &&
    existingRow.contractId === authority.contractId &&
    existingRow.agentRunId === authority.producerRunId &&
    existingRow.path === authority.worktreePath &&
    existingRow.name === authority.branch &&
    existingRow.branch === authority.branch &&
    existingRow.baseBranch === authority.baseBranch;
  if (alreadyExact) {
    // Crash convergence: persistence requires the teardown receipt's finish
    // stamp to equal the row's already-durable destroyedAt. The original
    // start was not durable, so recovery truthfully records a zero-duration
    // proof observation at that existing finish stamp.
    finishedAt = existingRow.destroyedAt!;
    receiptStartedAt = finishedAt;
  } else {
    finishedAt = Date.now();
    const destroyed = markExactWorktreeDestroyed({
      id: authority.worktreeId,
      projectId: authority.projectId,
      agentRunId: authority.producerRunId,
      contractId: authority.contractId,
      path: authority.worktreePath,
      name: authority.branch,
      branch: authority.branch,
      baseBranch: authority.baseBranch,
      destroyedAt: finishedAt,
    });
    if (!destroyed) {
      const row = getWorktreeById(authority.worktreeId);
      const racedExact = row !== null &&
        row.destroyedAt === finishedAt &&
        row.status === 'destroyed' &&
        row.projectId === authority.projectId &&
        row.contractId === authority.contractId &&
        row.agentRunId === authority.producerRunId &&
        row.path === authority.worktreePath &&
        row.name === authority.branch &&
        row.branch === authority.branch &&
        row.baseBranch === authority.baseBranch;
      if (!racedExact) {
        return {
          ok: false,
          code: 'binding-mismatch',
          error: 'durable worktree row no longer matches the approved ownership receipt',
        };
      }
    }
  }
  return {
    ok: true,
    receipt: {
      protocol: WORKTREE_ABANDONMENT_TEARDOWN_PROTOCOL,
      authorityRequestId: authority.requestId,
      startedAt: receiptStartedAt,
      finishedAt,
      repositoryIdentity: authority.repositoryIdentity,
      worktreePath: authority.worktreePath,
      branch: authority.branch,
      approvedBranchTip: authority.branchTip,
      observedBranchTip: observed.stdout,
      directoryAbsent: true,
      registrationAbsent: true,
      branchPreserved: true,
    },
  };
}

/** Reclaim the worktree DIRECTORY. The branch is preserved on purpose —
 *  unlanded/abandoned work stays recoverable from the branch. Landed cleanup
 *  uses the separate exact positive settlement door below.
 *  Profile `cleanupCommands` run first, IN the worktree, bounded and
 *  best-effort — a cleanup failure logs and defers to removal (never blocks
 *  settlement). Returns false when removal fails (the exact active/stranded
 *  row remains retryable) so callers never falsely claim completion. */
export async function teardownWorktree(
  projectDir: string,
  dir: string,
  cleanupCommands: readonly string[] = [],
  expectedIdentity: RepositoryIdentityReceipt | null = null,
): Promise<boolean> {
  if (!isOwnedWorktreePath(projectDir, dir)) {
    console.warn(`[pc-sdk][worktree] teardown path is outside the owned worktree root: ${dir}`);
    return false;
  }
  try {
    await repositoryLeaseManager.acquire(projectDir, expectedIdentity);
    if (existsSync(dir)) {
      await repositoryLeaseManager.acquire(dir, expectedIdentity);
    }
  } catch (error) {
    console.warn(`[pc-sdk][worktree] teardown authority unavailable for ${dir}: ${repositoryLeaseMessage(error)}`);
    return false;
  }
  const candidates = [...listActiveWorktrees(), ...listStrandedWorktrees()].filter(
    (row) => normalizePathKey(row.path) === normalizePathKey(dir),
  );
  if (candidates.length > 1 || (existsSync(dir) && candidates.length !== 1)) {
    console.warn(`[pc-sdk][worktree] teardown exact row is unavailable or ambiguous for ${dir}`);
    return false;
  }
  if (cleanupCommands.length > 0 && existsSync(dir)) {
    const cleanup = await runProfileCommands(
      dir,
      cleanupCommands,
      CLEANUP_CMD_TIMEOUT_MS,
      expectedIdentity,
    );
    if (!cleanup.ok) {
      const failed = cleanup.steps[cleanup.steps.length - 1];
      console.warn(
        `[pc-sdk][worktree] cleanup command failed in ${dir} (exit ${failed?.exitCode}): ${failed?.command} — proceeding to removal`,
      );
    }
  }
  const removed = await git(['worktree', 'remove', '--force', dir], projectDir);
  if (!removed.ok) {
    // FS fallback: locked files (Windows node_modules binaries) can make
    // `git worktree remove --force` fail outright. Force the directory off
    // the filesystem ourselves. This is not settlement evidence by itself:
    // an explicit Git lock can preserve a stale registration after the path
    // disappears, so the shared proof below still requires both absences.
    if (existsSync(dir)) {
      console.warn(`[pc-sdk][worktree] git remove failed for ${dir} (${removed.stderr}) — trying filesystem force-delete`);
      forceRemoveDir(dir);
    }
  }
  await git(['worktree', 'prune'], projectDir);
  if (existsSync(dir) || await isRegisteredWorktree(projectDir, dir)) {
    console.warn(
      `[pc-sdk][worktree] remove remains incomplete for ${dir}: ` +
        `${existsSync(dir) ? 'directory present' : 'Git registration present'}`,
    );
    return false;
  }
  if (candidates.length === 0) return true;
  return markExactWorktreeSnapshotDestroyed({
    worktree: candidates[0]!,
    destroyedAt: Date.now(),
  });
}

export type LandedWorktreeSettlementResult =
  | { ok: true }
  | {
      ok: false;
      code:
        | 'invalid-binding'
        | 'repository-unavailable'
        | 'removal-incomplete'
        | 'registration-inconclusive'
        | 'branch-delete-failed'
        | 'branch-absence-inconclusive'
        | 'row-settlement-failed';
      error: string;
    };

/** Positive landed cleanup for one exact durable binding. The merge receipt
 * proves history only; this door independently proves directory, Git
 * registration, and exact merged-branch absence before the row is destroyed.
 * An already-destroyed exact row is accepted only after re-running those
 * external absence proofs, closing the crash window before lifecycle stamp. */
export async function settleLandedWorktree(input: {
  projectDir: string;
  projectId: ULID;
  contractId: ULID;
  producerRunId: ULID;
  worktree: Worktree;
  branch: string;
  branchTip: string;
  cleanupCommands?: readonly string[];
  repositoryIdentity: RepositoryIdentityReceipt;
}): Promise<LandedWorktreeSettlementResult> {
  const { worktree } = input;
  if (
    !['active', 'stranded', 'destroyed'].includes(worktree.status) ||
    worktree.projectId !== input.projectId ||
    worktree.contractId !== input.contractId ||
    worktree.agentRunId !== input.producerRunId ||
    worktree.path === '' ||
    worktree.name !== input.branch ||
    worktree.branch !== input.branch ||
    basename(worktree.path) !== input.branch ||
    !worktree.baseBranch ||
    !isOwnedWorktreePath(input.projectDir, worktree.path) ||
    !/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/u.test(input.branchTip)
  ) {
    return { ok: false, code: 'invalid-binding', error: 'landed cleanup binding is unavailable or inconsistent' };
  }
  try {
    await repositoryLeaseManager.acquire(input.projectDir, input.repositoryIdentity);
    if (existsSync(worktree.path)) {
      await repositoryLeaseManager.acquire(worktree.path, input.repositoryIdentity);
    }
  } catch (error) {
    return { ok: false, code: 'repository-unavailable', error: repositoryLeaseMessage(error) };
  }

  const beforeRegistrations = await readWorktreeRegistrations(input.projectDir);
  if (!beforeRegistrations.ok) {
    return { ok: false, code: 'registration-inconclusive', error: beforeRegistrations.error };
  }
  const beforeRegistration = registrationForPath(beforeRegistrations.rows, worktree.path);
  if (beforeRegistration === 'duplicate') {
    return { ok: false, code: 'invalid-binding', error: 'duplicate landed worktree registrations exist' };
  }
  if (
    beforeRegistration &&
    (
      beforeRegistration.branch !== input.branch ||
      beforeRegistration.head !== input.branchTip
    )
  ) {
    return {
      ok: false,
      code: 'invalid-binding',
      error: 'landed worktree registration no longer matches the exact path, branch, and receipted tip',
    };
  }
  if (existsSync(worktree.path) && beforeRegistration === null) {
    return {
      ok: false,
      code: 'invalid-binding',
      error: 'present landed worktree directory has no exact Git registration',
    };
  }

  const currentExactBinding = (): Worktree | null => {
    const current = getWorktreeById(worktree.id);
    if (
      !current ||
      !['active', 'stranded', 'destroyed'].includes(current.status) ||
      current.projectId !== input.projectId ||
      current.contractId !== input.contractId ||
      current.agentRunId !== input.producerRunId ||
      current.path !== worktree.path ||
      current.name !== input.branch ||
      current.branch !== input.branch ||
      current.baseBranch !== worktree.baseBranch ||
      current.baseSha !== worktree.baseSha ||
      current.createdAt !== worktree.createdAt
    ) return null;
    return current;
  };

  const verifyPresentBinding = async (): Promise<LandedWorktreeSettlementResult | null> => {
    if (!currentExactBinding()) {
      return { ok: false, code: 'row-settlement-failed', error: 'durable worktree ownership changed' };
    }
    if (!existsSync(worktree.path)) return null;
    if (!isOwnedWorktreePath(input.projectDir, worktree.path)) {
      return { ok: false, code: 'invalid-binding', error: 'landed worktree path is no longer owned' };
    }
    try {
      await repositoryLeaseManager.acquire(worktree.path, input.repositoryIdentity);
    } catch (error) {
      return { ok: false, code: 'repository-unavailable', error: repositoryLeaseMessage(error) };
    }
    const currentRegistrations = await readWorktreeRegistrations(input.projectDir);
    if (!currentRegistrations.ok) {
      return { ok: false, code: 'registration-inconclusive', error: currentRegistrations.error };
    }
    const currentRegistration = registrationForPath(currentRegistrations.rows, worktree.path);
    if (
      currentRegistration === 'duplicate' ||
      currentRegistration === null ||
      currentRegistration.branch !== input.branch ||
      currentRegistration.head !== input.branchTip
    ) {
      return {
        ok: false,
        code: 'invalid-binding',
        error: 'present landed worktree no longer matches its exact Git registration',
      };
    }
    return null;
  };

  if ((input.cleanupCommands?.length ?? 0) > 0 && existsSync(worktree.path)) {
    const unsafe = await verifyPresentBinding();
    if (unsafe) return unsafe;
    const cleanup = await runProfileCommands(
      worktree.path,
      input.cleanupCommands!,
      CLEANUP_CMD_TIMEOUT_MS,
      input.repositoryIdentity,
    );
    if (!cleanup.ok) {
      const failed = cleanup.steps[cleanup.steps.length - 1];
      console.warn(
        `[pc-sdk][worktree] cleanup command failed in ${worktree.path} (exit ${failed?.exitCode}): ${failed?.command} — proceeding to exact removal`,
      );
    }
  }

  if (existsSync(worktree.path)) {
    const unsafe = await verifyPresentBinding();
    if (unsafe) return unsafe;
    const removed = await git(['worktree', 'remove', '--force', worktree.path], input.projectDir);
    if (!removed.ok && existsSync(worktree.path)) {
      const fallbackUnsafe = await verifyPresentBinding();
      if (fallbackUnsafe) return fallbackUnsafe;
      forceRemoveDir(worktree.path);
    }
  }
  // Missing-directory recovery may still have a stale unlocked registration.
  await git(['worktree', 'prune'], input.projectDir);
  if (existsSync(worktree.path)) {
    return { ok: false, code: 'removal-incomplete', error: 'landed worktree directory is still present' };
  }
  const registrations = await readWorktreeRegistrations(input.projectDir);
  if (!registrations.ok) {
    return { ok: false, code: 'registration-inconclusive', error: registrations.error };
  }
  if (registrationForPath(registrations.rows, worktree.path) !== null) {
    return { ok: false, code: 'removal-incomplete', error: 'Git still registers the landed worktree path' };
  }

  const branchRef = `refs/heads/${input.branch}`;
  if (!currentExactBinding()) {
    return { ok: false, code: 'row-settlement-failed', error: 'durable worktree ownership changed before branch cleanup' };
  }
  const before = await git(['for-each-ref', '--format=%(refname)', branchRef], input.projectDir);
  if (!before.ok) {
    return { ok: false, code: 'branch-absence-inconclusive', error: 'landed branch state could not be read' };
  }
  if (before.stdout !== '') {
    const deleted = await git(['update-ref', '-d', branchRef, input.branchTip], input.projectDir);
    if (!deleted.ok) {
      return {
        ok: false,
        code: 'branch-delete-failed',
        error: `exact landed branch '${input.branch}' could not be deleted at its receipted tip`,
      };
    }
  }
  const after = await git(['for-each-ref', '--format=%(refname)', branchRef], input.projectDir);
  if (!after.ok || after.stdout !== '') {
    return {
      ok: false,
      code: 'branch-absence-inconclusive',
      error: `exact absence of landed branch '${input.branch}' was not proven`,
    };
  }

  const current = currentExactBinding();
  if (!current) {
    return { ok: false, code: 'row-settlement-failed', error: 'durable worktree ownership changed before cleanup settlement' };
  }
  if (current.status === 'destroyed') return { ok: true };
  if (current.status !== 'active' && current.status !== 'stranded') {
    return { ok: false, code: 'row-settlement-failed', error: 'durable worktree row is not retryable' };
  }
  const destroyed = markExactWorktreeSnapshotDestroyed({
    worktree: current,
    destroyedAt: Date.now(),
  });
  return destroyed
    ? { ok: true }
    : { ok: false, code: 'row-settlement-failed', error: 'exact worktree row settlement lost its compare-and-set' };
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

/** Canonical path key for comparison. Native realpath converges ordinary
 * Windows aliases while preserving distinct names inside a case-sensitive
 * directory; app-level lowercasing would conflate distinct worktrees. */
function normalizePathKey(p: string): string {
  const resolved = resolve(p.trim());
  let canonical = resolved;
  try {
    canonical = realpathSync.native(resolved);
  } catch {
    // Missing-path recovery must compare against the exact recorded spelling.
  }
  return canonical.replace(/[\\/]+/g, '/');
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
  /** Previously stranded rows resolved to terminal 'destroyed' — the
   *  contract already landed/abandoned and the directory is gone, so there
   *  is nothing left to reclaim (just a finished dispatch's leftover row). */
  resolved: string[];
}

/** Durable stranded reconcile (docs/worktree-lifecycle.md 'Recovery' —
 *  premortem #5: stranded isolation is visible, never silent).
 *
 *  The live set is the REAL one: non-terminal runs' worktreeDir values.
 *  Abandoned-contract branches are excluded — abandonment is an explicit
 *  user-approved state awaiting cleanup, not stranding. Findings are written
 *  through the repo: row → status 'stranded' + reason + strandedAt; the bound
 *  run (when resolvable) gets lifecycle 'stranded' where canTransition allows.
 *  A stranded row whose dir + live run are back flips to active (self-heal).
 *  Only positively settled abandonment may resolve a missing row here.
 *  Landing proves merge history, not registration/branch cleanup, so landed
 *  rows remain retryable for the dedicated positive teardown door. */
export function reconcileStrandedWorktrees(
  authorizedProjectIds?: ReadonlySet<string>,
): StrandedReconcileResult {
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
    if (
      authorizedProjectIds &&
      (!row.projectId || !authorizedProjectIds.has(row.projectId))
    ) continue;
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
  const resolved: string[] = [];
  for (const row of listStrandedWorktrees()) {
    if (
      authorizedProjectIds &&
      (!row.projectId || !authorizedProjectIds.has(row.projectId))
    ) continue;
    // Self-heal: dir back + live run, OR the contract is (still) awaiting
    // review/landing — heals rows stranded by earlier scans of parked work.
    const healed =
      existsSync(row.path) && (live.has(row.path) || awaitingReviewOrLanding(row.contractId));
    if (healed) {
      if (reviveStrandedWorktree(row.id)) revived.push(row.name);
      continue;
    }
    // Resolve to terminal: the contract already landed or has a positively
    // settled abandonment receipt and the dir
    // is gone — there is no live run to revive and nothing left to reclaim,
    // so this is a finished dispatch's leftover row, not a genuine stranding.
    // A dir-gone row whose contract is NOT positively settled (or has none)
    // stays surfaced as 'stranded' — that is the real, actionable case.
    if (!existsSync(row.path) && isSettledAbandonment(row.contractId)) {
      if (markExactWorktreeSnapshotDestroyed({ worktree: row, destroyedAt: Date.now() })) {
        resolved.push(row.name);
      }
    }
  }
  return { stranded, revived, resolved };
}

/** True only for a positively settled abandonment. A landed receipt proves
 * merge history but cannot authorize this reconcile path to skip registration
 * and branch cleanup. Legacy raw `abandoned` is also inconclusive. */
function isSettledAbandonment(contractId: ULID | null): boolean {
  if (!contractId) return false;
  const contract = getContract(contractId);
  if (!contract) return false;
  return contract.landingStatus === 'abandoned' &&
    isMatchingWorktreeAbandonmentTeardown(
      contract.abandonmentReceipt,
      contract.abandonmentTeardownReceipt,
    );
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

/** Orphan directory GC (docs/worktree-lifecycle.md 'Recovery'): the stranded
 *  scan above only FLAGS leftover directories — it never deletes them, and
 *  teardown's own removal can fail outright (locked Windows binaries under a
 *  prior `pnpm install`'s node_modules), leaving a full worktree directory
 *  behind with its `.git` link already gone. This sweep does the actual
 *  deletion, scanning the filesystem directly (not the DB) so it also catches
 *  directories that never made it into a row (a crash before upsertWorktree).
 *
 *  A subdirectory of `<projectDir>-worktrees` is deleted ONLY when it is
 *  provably orphaned — ALL of:
 *   - not a currently registered git worktree (`git worktree list`) — this
 *     alone protects live review checkouts, which are never rows in the
 *     `worktrees` table but stay registered with git until reclaimed;
 *   - not the path of an active worktree row, nor a stranded row whose
 *     contract is awaiting review/landing (the same runless-park guard the
 *     stranded scan uses — such a row can be 'stranded' from an earlier pass
 *     that predates the contract entering that state);
 *   - not a live (non-terminal) run's worktreeDir.
 *
 *  Force-deletes survivors with the same filesystem fallback as teardown,
 *  then prunes git's registration. Never throws; returns the removed
 *  directory names (each logged as it goes). */
export async function sweepOrphanedWorktreeDirs(
  projectDir: string,
  expectedIdentity: RepositoryIdentityReceipt | null = null,
): Promise<string[]> {
  await repositoryLeaseManager.acquire(projectDir, expectedIdentity);
  const root = worktreesRoot(projectDir);
  if (!isSafeWorktreeRoot(projectDir)) {
    console.warn(`[pc-sdk][worktree] orphan sweep skipped: worktree root is an alias or not a directory: ${root}`);
    return [];
  }
  let names: string[];
  try {
    names = readdirSync(root, { withFileTypes: true })
      .filter((e) => e.isDirectory())
      .map((e) => e.name);
  } catch {
    return [];
  }

  const registered = new Set<string>();
  try {
    const list = await git(['worktree', 'list', '--porcelain'], projectDir);
    if (!list.ok) {
      console.warn(`[pc-sdk][worktree] orphan sweep skipped: git worktree list failed for ${projectDir}: ${list.stderr}`);
      return [];
    }
    for (const line of list.stdout.split('\n')) {
      if (line.startsWith('worktree ')) registered.add(normalizePathKey(line.slice('worktree '.length)));
    }
  } catch {
    // Registered absence is not proven. Fail closed rather than deleting a
    // different engine's or user's checkout.
    return [];
  }

  const keep = new Set<string>();
  for (const row of listActiveWorktrees()) keep.add(normalizePathKey(row.path));
  for (const row of listStrandedWorktrees()) {
    if (awaitingReviewOrLanding(row.contractId)) keep.add(normalizePathKey(row.path));
  }
  for (const run of listNonTerminalAgentRuns()) {
    if (run.worktreeDir) keep.add(normalizePathKey(run.worktreeDir));
  }
  const projectKey = normalizePathKey(projectDir);
  const projectIds = listProjects()
    .filter((project) => project.folderPath && normalizePathKey(project.folderPath) === projectKey)
    .map((project) => project.id);
  if (projectIds.length !== 1) {
    console.warn(
      `[pc-sdk][worktree] orphan sweep skipped: expected one persisted project for ${projectDir}, found ${projectIds.length}`,
    );
    return [];
  }
  for (const path of listProtectedAbandonmentWorktreePaths(projectIds[0]!)) {
    keep.add(normalizePathKey(path));
  }

  const removed: string[] = [];
  for (const name of names) {
    if (!isSafeWorktreeRoot(projectDir)) {
      console.warn(`[pc-sdk][worktree] orphan sweep stopped: worktree root changed during scan: ${root}`);
      return removed;
    }
    const dir = join(root, name);
    const key = normalizePathKey(dir);
    if (registered.has(key) || keep.has(key)) continue;
    const rowCandidates = [...listActiveWorktrees(), ...listStrandedWorktrees()].filter(
      (row) => normalizePathKey(row.path) === key,
    );
    if (rowCandidates.length > 1) {
      console.warn(`[pc-sdk][worktree] orphan sweep preserved ambiguous durable bindings for ${dir}`);
      continue;
    }
    forceRemoveDir(dir);
    if (existsSync(dir)) {
      console.warn(`[pc-sdk][worktree] orphan sweep could not remove ${dir}`);
      continue;
    }
    if (
      rowCandidates.length === 1 &&
      !markExactWorktreeSnapshotDestroyed({
        worktree: rowCandidates[0]!,
        destroyedAt: Date.now(),
      })
    ) {
      console.warn(`[pc-sdk][worktree] orphan sweep removed ${dir} but exact row settlement lost its compare-and-set`);
      continue;
    }
    removed.push(name);
    console.warn(`[pc-sdk][worktree] orphan sweep removed ${dir}`);
  }
  await git(['worktree', 'prune'], projectDir);
  return removed;
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

function repositoryLeaseMessage(error: unknown): string {
  if (error instanceof RepositoryLeaseError) {
    return `${error.code}: ${error.message}`;
  }
  return error instanceof Error ? error.message : String(error);
}

/** The worktrees root for a project (`<projectDir>-worktrees`). */
export function worktreesRoot(projectDir: string): string {
  let root = projectDir.replace(/[\\/]+$/, '');
  try {
    root = realpathSync.native(resolve(root));
  } catch {
    // Missing-path recovery retains the durable spelling for fail-closed checks.
  }
  return `${root}-worktrees`;
}

export function worktreeParent(dir: string): string {
  return dirname(dir);
}

function isOwnedWorktreePath(projectDir: string, dir: string): boolean {
  if (!projectDir || !dir || basename(dir) === '.' || basename(dir) === '..') return false;
  if (!isSafeWorktreeRoot(projectDir)) return false;
  try {
    if (lstatSync(dir).isSymbolicLink()) return false;
  } catch (error) {
    if (nodeErrorCode(error) !== 'ENOENT') return false;
  }
  return normalizePathKey(dirname(dir)) === normalizePathKey(worktreesRoot(projectDir));
}

/** The app-owned sibling root must be a real directory, never a symlink or
 * Windows junction that can redirect recursive cleanup outside the project. */
function isSafeWorktreeRoot(projectDir: string): boolean {
  const root = worktreesRoot(projectDir);
  try {
    const stat = lstatSync(root);
    return stat.isDirectory() && !stat.isSymbolicLink();
  } catch (error) {
    return nodeErrorCode(error) === 'ENOENT';
  }
}

function nodeErrorCode(error: unknown): string {
  if (typeof error !== 'object' || error === null || !('code' in error)) return 'UNKNOWN';
  const code = (error as { code?: unknown }).code;
  return typeof code === 'string' ? code : 'UNKNOWN';
}
