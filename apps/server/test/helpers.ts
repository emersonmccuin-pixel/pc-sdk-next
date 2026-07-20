// Shared test rig: a fresh on-disk SQLite DB per file, real migrations.

import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  closeDb,
  confirmAgentRunRuntimeSessionReceipt,
  createProject,
  getAgentRunRow,
  markAgentRunTerminal,
  newId,
  prepareAgentRunCreate,
  prepareAgentRunResume,
  runMigrations,
  runtimeSelectionForAgentRun,
  updateAgentRunStatus,
} from '@pc/db';
import type { RuntimeSelection } from '@pc/contracts';
import type {
  AgentRunStatus,
  Project,
  SpecialistExecutionSnapshot,
  ULID,
} from '@pc/domain';
import { AccountRegistry } from '../src/runner/account-env.ts';
import { RuntimeRegistry } from '../src/runner/runtime.ts';
import type { DispatchServiceDeps } from '../src/dispatch/service.ts';
import { git } from '../src/dispatch/worktrees.ts';
import {
  discoverRepositoryIdentity,
  releaseAllRepositoryLeasesForTesting,
} from '../src/dispatch/repository-lease.ts';

export const TEST_RUNTIME_SELECTION: RuntimeSelection = {
  runtimeId: 'claude-agent-sdk',
  accountId: 'default',
  model: 'sonnet',
  effort: { kind: 'none' },
};

export function testAgentRunExecution(
  podName: string,
  selection: RuntimeSelection = TEST_RUNTIME_SELECTION,
): {
  specialistSnapshot: SpecialistExecutionSnapshot;
  selection: RuntimeSelection;
  continuation: { mode: 'create' };
} {
  return {
    specialistSnapshot: {
      specialistId: `specialist-${podName}` as ULID,
      revision: `sha256:test-${podName}`,
      name: podName,
      charter: `Test charter for ${podName}`,
      contextDocs: [],
      maxTurns: 10,
    },
    selection,
    continuation: { mode: 'create' },
  };
}

/** Test-only lifecycle driver. Production admission is queued-only and every
 * running/completed/paused fixture must cross the same positive receipt door. */
export function advanceTestAgentRunStatus(id: ULID, status: AgentRunStatus): void {
  if (status === 'queued') return;
  if (status === 'failed' || status === 'cancelled') {
    const changed = markAgentRunTerminal({
      id,
      status,
      result: null,
      failureCause: status === 'failed' ? 'unexpected-exit' : 'cancelled',
      failureReason: `test ${status}`,
      completedAt: Date.now(),
    });
    if (!changed) throw new Error(`test run ${id} could not become ${status}`);
    return;
  }

  const before = getAgentRunRow(id);
  if (!before) throw new Error(`missing test run ${id}`);
  const prepared = before.continuationState === 'clean-pending'
    ? prepareAgentRunCreate(id)
    : prepareAgentRunResume(id);
  if (!prepared?.continuationAttemptId) throw new Error(`test run ${id} could not prepare`);
  if (!updateAgentRunStatus({ id, status: 'spawning', spawnedAt: Date.now() })) {
    throw new Error(`test run ${id} could not spawn`);
  }
  if (status === 'spawning') return;

  const selection = runtimeSelectionForAgentRun(prepared);
  if (!selection) throw new Error(`test run ${id} has no selection`);
  const nativeSessionId = prepared.nativeSessionId ?? `native-${id}`;
  const receipt = before.continuationState === 'clean-pending'
    ? {
        mode: 'created' as const,
        selection,
        continuationAttemptId: prepared.continuationAttemptId,
        nativeSessionId,
        requestedNativeSessionId: null,
      }
    : {
        mode: 'resumed' as const,
        selection,
        continuationAttemptId: prepared.continuationAttemptId,
        nativeSessionId,
        requestedNativeSessionId: nativeSessionId,
      };
  const confirmation = confirmAgentRunRuntimeSessionReceipt({ runId: id, receipt });
  if (confirmation.status !== 'confirmed') {
    throw new Error(`test run ${id} receipt rejected: ${confirmation.reason}`);
  }
  if (!updateAgentRunStatus({ id, status: 'running', readyAt: Date.now() })) {
    throw new Error(`test run ${id} could not run`);
  }
  if (status === 'running') return;
  if (status === 'paused') {
    if (!updateAgentRunStatus({ id, status: 'paused' })) {
      throw new Error(`test run ${id} could not pause`);
    }
    return;
  }
  const completed = markAgentRunTerminal({
    id,
    status: 'completed',
    result: 'test completed',
    failureCause: null,
    failureReason: null,
    completedAt: Date.now(),
  });
  if (!completed) throw new Error(`test run ${id} could not complete`);
}

/** Composition-owned runtime seams for DispatchService tests. */
export function testDispatchRuntimeDeps(
  runtimes: RuntimeRegistry,
  accounts = new AccountRegistry(),
  runtimeId = 'claude-agent-sdk',
): Pick<
  DispatchServiceDeps,
  | 'resolveNewSpecialistSelection'
  | 'preflightRuntimeSession'
  | 'mintSpecialistRuntimeSession'
  | 'appToolBridgeForRuntime'
> {
  return {
    appToolBridgeForRuntime: (rid) => {
      const resolution = runtimes.resolve(rid);
      return resolution.status === 'resolved' ? resolution.adapter.appToolBridge : 'supported';
    },
    resolveNewSpecialistSelection: async (input) => {
      let account;
      try {
        account = accounts.resolveForProject(input.projectId, runtimeId);
      } catch {
        return { status: 'invalid', code: 'account-unavailable' };
      }
      return runtimes.resolveSelection({
        runtimeId,
        accountId: account.id,
        model: input.model?.trim() || 'sonnet',
        effort: input.effort,
      });
    },
    preflightRuntimeSession: (selection, continuation) =>
      runtimes.preflight(selection, continuation),
    mintSpecialistRuntimeSession: async (input) => {
      const { continuation, ...sessionInput } = input;
      const adapter = runtimes.get(sessionInput.selection.runtimeId);
      return continuation.mode === 'resume'
        ? adapter.resumeSession({ ...sessionInput, nativeSessionId: continuation.nativeSessionId })
        : adapter.createSession(sessionInput);
    },
  };
}

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
  /** Awaited barrier: releases process-wide repository authority, then removes
   * the repo and its sibling `<dir>-worktrees`. */
  cleanup: () => Promise<void>;
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
  const project = createProject({
    name,
    slug: `t-${newId().toLowerCase()}`,
    folderPath: dir,
    repositoryIdentity: await discoverRepositoryIdentity(dir),
  });
  const rm = (p: string) => {
    try {
      rmSync(p, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
    } catch {
      /* temp dir — leave it to the OS */
    }
  };
  return {
    project,
    dir,
    cleanup: async () => {
      // The production manager retains repository authority until engine exit.
      // Fixtures explicitly release so their temporary .git SQLite handle is
      // closed before recursive removal.
      await releaseAllRepositoryLeasesForTesting();
      rm(`${dir}-worktrees`);
      rm(dir);
    },
  };
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
