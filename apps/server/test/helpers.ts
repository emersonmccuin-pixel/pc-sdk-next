// Shared test rig: a fresh on-disk SQLite DB per file, real migrations.

import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { closeDb, createProject, newId, runMigrations } from '@pc/db';
import type { Project } from '@pc/domain';
import { git } from '../src/dispatch/worktrees.ts';

/** Point PC_DATA_DIR at a fresh temp dir and migrate. Call first in each test. */
export function freshDb(): string {
  const dir = mkdtempSync(join(tmpdir(), 'pc-sdk-test-'));
  process.env.PC_DATA_DIR = dir;
  closeDb();
  runMigrations();
  return dir;
}

export function newProject(name = 'Test'): Project {
  return createProject({ name, slug: `t-${newId().toLowerCase()}`, folderPath: '' });
}

export interface GitProject {
  project: Project;
  /** Repo root — also the project's folderPath. */
  dir: string;
  /** Best-effort: removes the repo AND its sibling `<dir>-worktrees`. */
  cleanup: () => void;
}

/** Real temp git repo (local identity, one initial commit on `main`)
 *  registered as a project. Call freshDb() first. */
export async function newGitProject(name = 'GitTest'): Promise<GitProject> {
  const dir = mkdtempSync(join(tmpdir(), 'pc-sdk-git-'));
  await gitOk(['init', '-b', 'main'], dir);
  await gitOk(['config', 'user.name', 'PC-SDK Test'], dir);
  await gitOk(['config', 'user.email', 'test@pc-sdk.invalid'], dir);
  writeFileSync(join(dir, 'README.md'), 'seed\n');
  await gitOk(['add', '.'], dir);
  await gitOk(['commit', '-m', 'initial'], dir);
  const project = createProject({ name, slug: `t-${newId().toLowerCase()}`, folderPath: dir });
  const rm = (p: string) => {
    try {
      rmSync(p, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
    } catch {
      /* temp dir — leave it to the OS */
    }
  };
  return { project, dir, cleanup: () => { rm(`${dir}-worktrees`); rm(dir); } };
}

/** Write + stage + commit one file. Returns the new HEAD sha. */
export async function commitFile(dir: string, relPath: string, content: string, message = `add ${relPath}`): Promise<string> {
  writeFileSync(join(dir, relPath), content);
  await gitOk(['add', relPath], dir);
  await gitOk(['commit', '-m', message], dir);
  return (await git(['rev-parse', 'HEAD'], dir)).stdout;
}

async function gitOk(args: string[], cwd: string): Promise<void> {
  const r = await git(args, cwd);
  if (!r.ok) throw new Error(`git ${args.join(' ')} failed in ${cwd}: ${r.stderr || r.stdout}`);
}

/** Poll `fn` until truthy or timeout. */
export async function until(fn: () => boolean, timeoutMs = 2000, stepMs = 5): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (fn()) return;
    await sleep(stepMs);
  }
  if (!fn()) throw new Error('until: condition not met before timeout');
}

export function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}
