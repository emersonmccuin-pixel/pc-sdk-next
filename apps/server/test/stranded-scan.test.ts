// Durable stranded reconcile (docs/worktree-lifecycle.md 'Recovery') against
// real temp git repos + a real DB:
//  - a worktree owned by a live (non-terminal) run is NOT stranded
//  - a dead run's worktree goes durable 'no-live-run' + the run's lifecycle
//    stamps 'stranded' (canTransition-guarded)
//  - a missing directory goes 'dir-missing'
//  - an abandoned-contract branch is EXCLUDED (awaiting user-approved cleanup)
//  - a false positive self-heals: dir back + live run ⇒ row flips to active
//    with the stranded stamp cleared
//  - sweepOrphanedWorktreeDirs (orphan GC): a registered git worktree, an
//    active-row directory, and a stranded-but-awaiting-review directory are
//    all KEPT; a directory with none of those backing it is REMOVED

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  createContract,
  getActiveWorktreeByName,
  getAgentRunRow,
  insertAgentRunRow,
  listStrandedWorktrees,
  markWorktreeStranded,
  newId,
  setContractDeliverable,
  setContractLanding,
  setContractVerification,
  setWorktreeContractId,
  upsertWorktree,
} from '@pc/db';
import type { AgentRunStatus, RunLifecycleState, ULID } from '@pc/domain';
import { provisionWorktree, reconcileStrandedWorktrees, sweepOrphanedWorktreeDirs, worktreesRoot } from '../src/dispatch/worktrees.ts';
import {
  advanceTestAgentRunStatus,
  freshDb,
  newGitProject,
  testAgentRunExecution,
  type GitProject,
} from './helpers.ts';

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
    ...testAgentRunExecution('builder'),
    dispatcherSessionId: 'S1',
    status: 'queued',
    input: 'go',
    worktreeDir: input.worktreeDir,
    lifecycleState: input.lifecycleState ?? null,
    queuedAt: Date.now(),
  });
  advanceTestAgentRunStatus(input.id, input.status);
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

test('reconcile: a stranded row whose contract landed (dir gone) resolves to destroyed, not left stranded forever', async () => {
  freshDb();
  const gp = await newGitProject();
  try {
    // Stranded first (dir gone, no live run) — the genuine stranded case.
    const wt = await provisionFor(gp, newId() as ULID);
    const contract = createContract({ projectId: gp.project.id, podName: 'builder' });
    setWorktreeContractId(wt.branch, contract.id);
    rmSync(wt.dir, { recursive: true, force: true });

    const first = reconcileStrandedWorktrees();
    assert.equal(first.stranded[0]?.reason, 'dir-missing');
    assert.deepEqual(first.resolved, []);
    assert.equal(listStrandedWorktrees(gp.project.id).some((w) => w.name === wt.branch), true);

    // The contract lands — the row is still stamped 'stranded' from the prior
    // pass, but nothing has flipped it yet.
    setContractLanding(contract.id, { landingStatus: 'landed', landedBranch: wt.branch });

    const second = reconcileStrandedWorktrees();
    assert.deepEqual(second.stranded, []);
    assert.deepEqual(second.revived, []);
    assert.deepEqual(second.resolved, [wt.branch]);
    assert.equal(listStrandedWorktrees(gp.project.id).some((w) => w.name === wt.branch), false, 'no longer surfaced as stranded');

    // Boot-time reconcile must heal pre-existing stuck rows the same way —
    // re-scanning a row already resolved to destroyed is a no-op, not an error.
    const third = reconcileStrandedWorktrees();
    assert.deepEqual(third.resolved, []);
  } finally {
    gp.cleanup();
  }
});

test('reconcile: a stranded row whose contract is NOT landed (dir gone) stays surfaced as stranded', async () => {
  freshDb();
  const gp = await newGitProject();
  try {
    const wt = await provisionFor(gp, newId() as ULID);
    const contract = createContract({ projectId: gp.project.id, podName: 'builder' });
    setWorktreeContractId(wt.branch, contract.id);
    rmSync(wt.dir, { recursive: true, force: true });

    reconcileStrandedWorktrees();
    const second = reconcileStrandedWorktrees();
    assert.deepEqual(second.resolved, []);
    assert.equal(listStrandedWorktrees(gp.project.id).some((w) => w.name === wt.branch), true, 'genuine stranded case stays surfaced');
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

test('sweepOrphanedWorktreeDirs: registered/active-row/awaiting-review dirs are KEPT, a true orphan is REMOVED', async () => {
  freshDb();
  const gp = await newGitProject();
  try {
    const root = worktreesRoot(gp.dir);

    // A — a currently registered git worktree (live run) — kept via the
    // `git worktree list` check alone.
    const runA = newId() as ULID;
    const wtA = await provisionFor(gp, runA);
    insertRun({ id: runA, projectId: gp.project.id, status: 'running', worktreeDir: wtA.dir, lifecycleState: 'building' });

    // B — an ACTIVE worktree row backing a plain directory (not a real git
    // worktree) — kept because the row itself is active.
    const dirB = join(root, 'agent-activerow');
    mkdirSync(dirB, { recursive: true });
    upsertWorktree({ name: 'agent-activerow', path: dirB, projectId: gp.project.id });

    // C — a STRANDED row whose contract is awaiting review/landing (verified,
    // deliverable sealed, not yet landed/abandoned) — kept by the same
    // runless-park guard the stranded scan itself uses.
    const dirC = join(root, 'agent-awaitingreview');
    mkdirSync(dirC, { recursive: true });
    upsertWorktree({ name: 'agent-awaitingreview', path: dirC, projectId: gp.project.id });
    const contractC = createContract({ projectId: gp.project.id, podName: 'builder' });
    setContractDeliverable(contractC.id, { deliverable: { kind: 'repo', branch: 'agent-awaitingreview', commit: '0'.repeat(40) } });
    setContractVerification(contractC.id, { verificationStatus: 'passed' });
    setWorktreeContractId('agent-awaitingreview', contractC.id);
    markWorktreeStranded('agent-awaitingreview', 'no-live-run');

    // D — a true orphan: no git registration, no worktree row at all, no live
    // run — exactly the leftover a locked `git worktree remove --force`
    // (or a crash before registration) can strand.
    const dirD = join(root, 'agent-trueorphan');
    mkdirSync(join(dirD, 'nested'), { recursive: true });
    writeFileSync(join(dirD, 'file.txt'), 'x');

    const removed = await sweepOrphanedWorktreeDirs(gp.dir);

    assert.deepEqual(removed, ['agent-trueorphan']);
    assert.equal(existsSync(wtA.dir), true, 'registered/live worktree kept');
    assert.equal(existsSync(dirB), true, 'active row directory kept');
    assert.equal(existsSync(dirC), true, 'stranded-but-awaiting-review directory kept');
    assert.equal(existsSync(dirD), false, 'true orphan removed');
  } finally {
    gp.cleanup();
  }
});
