// Durable stranded reconcile (docs/worktree-lifecycle.md 'Recovery') against
// real temp git repos + a real DB:
//  - a worktree owned by a live (non-terminal) run is NOT stranded
//  - a dead run's worktree goes durable 'no-live-run' + the run's lifecycle
//    stamps 'stranded' (canTransition-guarded)
//  - a missing directory goes 'dir-missing'
//  - an abandoned-contract branch is EXCLUDED (awaiting user-approved cleanup)
//  - a false positive self-heals: dir back + live run ⇒ row flips to active
//    with the stranded stamp cleared

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { rmSync } from 'node:fs';
import {
  createContract,
  getActiveWorktreeByName,
  getAgentRunRow,
  insertAgentRunRow,
  listStrandedWorktrees,
  newId,
  setContractLanding,
} from '@pc/db';
import type { AgentRunStatus, RunLifecycleState, ULID } from '@pc/domain';
import { provisionWorktree, reconcileStrandedWorktrees } from '../src/dispatch/worktrees.ts';
import { freshDb, newGitProject, type GitProject } from './helpers.ts';

async function provisionFor(gp: GitProject, runId: ULID) {
  const out = await provisionWorktree(gp.dir, runId, { projectId: gp.project.id });
  if (!out.ok) throw new Error(`provision failed: ${out.error}`);
  return out;
}

function insertRun(input: {
  id: ULID;
  projectId: ULID;
  status: AgentRunStatus;
  worktreeDir: string | null;
  lifecycleState?: RunLifecycleState | null;
}): void {
  insertAgentRunRow({
    id: input.id,
    projectId: input.projectId,
    podName: 'builder',
    dispatcherSessionId: 'S1',
    ccSessionId: `cc-${input.id}`,
    status: input.status,
    input: 'go',
    worktreeDir: input.worktreeDir,
    lifecycleState: input.lifecycleState ?? null,
    queuedAt: Date.now(),
  });
}

test('reconcile: live run excluded, dead run stranded, dir-missing stranded, abandoned excluded', async () => {
  freshDb();
  const gp = await newGitProject();
  try {
    // A — live: non-terminal run owns the dir.
    const runA = newId() as ULID;
    const wtA = await provisionFor(gp, runA);
    insertRun({ id: runA, projectId: gp.project.id, status: 'running', worktreeDir: wtA.dir, lifecycleState: 'building' });

    // B — dead: terminal run, dir present.
    const runB = newId() as ULID;
    const wtB = await provisionFor(gp, runB);
    insertRun({ id: runB, projectId: gp.project.id, status: 'failed', worktreeDir: wtB.dir, lifecycleState: 'verifying' });

    // C — dir gone, no run at all.
    const wtC = await provisionFor(gp, newId() as ULID);
    rmSync(wtC.dir, { recursive: true, force: true });

    // D — abandoned contract branch: preserved on purpose, never stranded.
    const wtD = await provisionFor(gp, newId() as ULID);
    const contract = createContract({ projectId: gp.project.id, podName: 'builder' });
    setContractLanding(contract.id, { landingStatus: 'abandoned', landedBranch: wtD.branch });

    const { stranded, revived } = reconcileStrandedWorktrees();
    assert.equal(revived.length, 0);
    const byName = new Map(stranded.map((s) => [s.name, s.reason]));
    assert.equal(byName.has(wtA.branch), false, 'live worktree not stranded');
    assert.equal(byName.get(wtB.branch), 'no-live-run');
    assert.equal(byName.get(wtC.branch), 'dir-missing');
    assert.equal(byName.has(wtD.branch), false, 'abandoned branch excluded');

    // Durable rows: B + C stranded, A + D still active.
    const strandedRows = listStrandedWorktrees(gp.project.id);
    assert.deepEqual(new Set(strandedRows.map((w) => w.name)), new Set([wtB.branch, wtC.branch]));
    assert.ok(strandedRows.every((w) => w.strandedAt !== null && w.strandedReason !== null));
    assert.notEqual(getActiveWorktreeByName(wtA.branch), null);
    assert.notEqual(getActiveWorktreeByName(wtD.branch), null);

    // B's run lifecycle stamped 'stranded' (verifying → stranded is legal).
    assert.equal(getAgentRunRow(runB)!.lifecycleState, 'stranded');
    // A's live run untouched.
    assert.equal(getAgentRunRow(runA)!.lifecycleState, 'building');
  } finally {
    gp.cleanup();
  }
});

test('reconcile: a false positive self-heals — dir back + live run flips the row to active', async () => {
  freshDb();
  const gp = await newGitProject();
  try {
    const runId = newId() as ULID;
    const wt = await provisionFor(gp, runId);
    insertRun({ id: runId, projectId: gp.project.id, status: 'failed', worktreeDir: wt.dir });

    const first = reconcileStrandedWorktrees();
    assert.equal(first.stranded[0]?.reason, 'no-live-run');
    assert.equal(getActiveWorktreeByName(wt.branch), null);

    // The run resumes (a continuation owns the same dir) — re-scan self-heals.
    insertRun({ id: newId() as ULID, projectId: gp.project.id, status: 'running', worktreeDir: wt.dir });
    const second = reconcileStrandedWorktrees();
    assert.deepEqual(second.stranded, []);
    assert.deepEqual(second.revived, [wt.branch]);
    const row = getActiveWorktreeByName(wt.branch)!;
    assert.equal(row.status, 'active');
    assert.equal(row.strandedReason, null, 'stamp cleared on revive');
    assert.equal(row.strandedAt, null);
  } finally {
    gp.cleanup();
  }
});

test('reconcile: legacy rows (no projectId) still classify by dir + live set', async () => {
  freshDb();
  const gp = await newGitProject();
  try {
    // Provision WITHOUT projectId (legacy shape) — abandoned exclusion can't
    // apply, but dir/live classification must still work.
    const out = await provisionWorktree(gp.dir, newId());
    if (!out.ok) throw new Error(out.error);
    rmSync(out.dir, { recursive: true, force: true });
    const { stranded } = reconcileStrandedWorktrees();
    assert.equal(stranded.find((s) => s.name === out.branch)?.reason, 'dir-missing');
    // Not visible in the per-project surface (NULL projectId) — unfiltered only.
    assert.equal(listStrandedWorktrees(gp.project.id).some((w) => w.name === out.branch), false);
    assert.equal(listStrandedWorktrees().some((w) => w.name === out.branch), true);
  } finally {
    gp.cleanup();
  }
});
