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

import { execFile } from 'node:child_process';
import { existsSync, mkdirSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { listActiveWorktrees, markWorktreeDestroyed, upsertWorktree } from '@pc/db';

const GIT_TIMEOUT_MS = 60_000;

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

export interface ProvisionedWorktree {
  dir: string;
  branch: string;
  baseBranch: string;
  baseSha: string;
}

export type ProvisionOutcome =
  | ({ ok: true } & ProvisionedWorktree)
  | { ok: false; error: string };

/** `git worktree add -b agent-<id8> <dir> <baseSha>` + the durable row.
 *  Never throws — a typed failure feeds the `worktree-provision-failed` path. */
export async function provisionWorktree(projectDir: string, runId: string): Promise<ProvisionOutcome> {
  if (!projectDir || !existsSync(projectDir)) {
    return { ok: false, error: `project folder missing: ${projectDir || '(unset)'}` };
  }
  const inside = await git(['rev-parse', '--is-inside-work-tree'], projectDir);
  if (!inside.ok || inside.stdout !== 'true') {
    return { ok: false, error: `not a git repository: ${projectDir}` };
  }
  const head = await git(['rev-parse', 'HEAD'], projectDir);
  const baseBranch = await git(['rev-parse', '--abbrev-ref', 'HEAD'], projectDir);
  if (!head.ok || !baseBranch.ok) {
    return { ok: false, error: `cannot resolve HEAD: ${head.stderr || baseBranch.stderr}` };
  }
  if (baseBranch.stdout === 'HEAD') {
    return { ok: false, error: 'project is on a detached HEAD — check out a branch first' };
  }
  const branch = `agent-${runId.slice(-8).toLowerCase()}`;
  const root = `${projectDir.replace(/[\\/]+$/, '')}-worktrees`;
  mkdirSync(root, { recursive: true });
  const dir = join(root, branch);
  const add = await git(['worktree', 'add', '-b', branch, dir, head.stdout], projectDir);
  if (!add.ok) {
    return { ok: false, error: `git worktree add failed: ${add.stderr || add.stdout}` };
  }
  upsertWorktree({ name: branch, path: dir });
  return { ok: true, dir, branch, baseBranch: baseBranch.stdout, baseSha: head.stdout };
}

export type LandOutcome =
  | { outcome: 'landed'; mergeSha: string; branchSha: string }
  | { outcome: 'conflict'; error: string }
  | { outcome: 'failed'; error: string };

/** Merge the agent branch into the base branch in the project working copy.
 *  Guarded, receipt-checked, never throws. */
export async function landBranch(input: {
  projectDir: string;
  branch: string;
  baseBranch: string;
  podName: string;
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
  return { outcome: 'landed', mergeSha: mergeSha.stdout, branchSha: branchSha.stdout };
}

/** Reclaim the worktree DIRECTORY. The branch is preserved on purpose —
 *  landed work is merged, unlanded work stays recoverable from the branch. */
export async function teardownWorktree(projectDir: string, dir: string): Promise<void> {
  const removed = await git(['worktree', 'remove', '--force', dir], projectDir);
  if (!removed.ok) {
    // Sweep retries later; never block settlement on cleanup.
    console.warn(`[pc-sdk][worktree] remove failed for ${dir}: ${removed.stderr}`);
    return;
  }
  markWorktreeDestroyed(basename(dir));
}

/** Active worktree rows whose directory or run is gone — surfaced loudly at
 *  boot (premortem #5: stranded isolation is visible, never silent). */
export function scanStrandedWorktrees(liveRunWorktreeDirs: ReadonlySet<string>): Array<{
  name: string;
  path: string;
  reason: 'dir-missing' | 'no-live-run';
}> {
  const stranded: Array<{ name: string; path: string; reason: 'dir-missing' | 'no-live-run' }> = [];
  for (const row of listActiveWorktrees()) {
    if (!existsSync(row.path)) stranded.push({ name: row.name, path: row.path, reason: 'dir-missing' });
    else if (!liveRunWorktreeDirs.has(row.path)) stranded.push({ name: row.name, path: row.path, reason: 'no-live-run' });
  }
  return stranded;
}

/** The worktrees root for a project (`<projectDir>-worktrees`). */
export function worktreesRoot(projectDir: string): string {
  return `${projectDir.replace(/[\\/]+$/, '')}-worktrees`;
}

export function worktreeParent(dir: string): string {
  return dirname(dir);
}
