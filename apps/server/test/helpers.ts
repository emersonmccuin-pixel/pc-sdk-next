// Shared test rig: a fresh on-disk SQLite DB per file, real migrations.

import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { closeDb, createProject, newId, runMigrations } from '@pc/db';
import type { Project } from '@pc/domain';

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
