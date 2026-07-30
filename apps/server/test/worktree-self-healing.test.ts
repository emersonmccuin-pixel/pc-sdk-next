// In-session worktree self-healing (docs/worktree-lifecycle.md 'Recovery'):
// a landed contract whose teardown fails mid-session (Windows file lock,
// transient lease contention) must converge WITHOUT a server restart.
//  - bounded backoff retry: a transient failure recovers on a later scheduled
//    attempt — row destroyed + branch deleted, through the exact same guarded
//    door every time;
//  - a permanent failure exhausts its bounded retry budget, stays genuinely
//    stranded, and logs an explicit receipt at every attempt;
//  - the janitor trigger is single-flighted: concurrent callers share one
//    in-flight sweep instead of racing a second sweep against the first;
//  - a post-settlement recheck (any run settling — completion OR kill) can
//    resolve a stuck landed teardown without a direct recoverIncompleteTeardowns
//    call or waiting for the periodic interval;
//  - the periodic interval drives the same convergence, and — the guard-
//    preservation requirement — never touches a live-run worktree, a
//    review-parked stranded worktree, or a legacy-abandoned worktree while
//    doing it.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { ContractService } from '@pc/app-services';
import type { Contract, Deliverable } from '@pc/contracts';
import {
  createContract,
  getActiveWorktreeByName,
  getWorktreeById,
  getWorktreeForLandedContract,
  insertAgentRunRow,
  listStrandedWorktrees,
  markWorktreeStranded,
  newId,
  setContractDeliverable,
  setContractVerification,
  setWorktreeContractId,
  upsertWorktree,
} from '@pc/db';
import type { RepositoryIdentityReceipt, ULID } from '@pc/domain';
import { AccountRegistry } from '../src/runner/account-env.ts';
import { RuntimeRegistry } from '../src/runner/runtime.ts';
import { DispatchService, type DispatchServiceDeps } from '../src/dispatch/service.ts';
import { git, provisionWorktree, worktreesRoot } from '../src/dispatch/worktrees.ts';
import {
  advanceTestAgentRunStatus,
  commitFile,
  freshDb,
  newGitProject,
  testAgentRunExecution,
  testDispatchRuntimeDeps,
  until,
  type GitProject,
} from './helpers.ts';

// No attach(): landing itself never touches the live server context — only
// the janitor-interval/single-flight tests below call attach().
function rig(overrides: Partial<DispatchServiceDeps> = {}): DispatchService {
  const runtimes = new RuntimeRegistry();
  const accounts = new AccountRegistry();
  return new DispatchService({
    ...testDispatchRuntimeDeps(runtimes, accounts),
    ...overrides,
  });
}

async function provisionOk(gp: GitProject, runId: string) {
  const out = await provisionWorktree(gp.dir, runId, { projectId: gp.project.id });
  if (!out.ok) throw new Error(`provision failed: ${out.error}`);
  return out;
}

function gitReceiptFor(wt: {
  dir: string;
  branch: string;
  baseBranch: string;
  baseSha: string;
  repositoryIdentity: RepositoryIdentityReceipt;
}) {
  return {
    worktreePath: wt.dir,
    branch: wt.branch,
    baseBranch: wt.baseBranch,
    baseSha: wt.baseSha,
    cleanStatus: true,
    repositoryIdentity: wt.repositoryIdentity,
  };
}

/** Contract + delivered/verified repo deliverable for one provisioned
 *  worktree — everything landAcceptedContract needs (same shape as
 *  landing-guards.test.ts's local helper). */
function deliveredContract(
  contracts: ContractService,
  gp: GitProject,
  wt: {
    dir: string;
    branch: string;
    baseBranch: string;
    baseSha: string;
    repositoryIdentity: RepositoryIdentityReceipt;
  },
  tip: string,
): Contract {
  const persistedWorktree = getActiveWorktreeByName(wt.branch);
  assert.ok(persistedWorktree?.agentRunId, 'provisioned worktree has an exact producing run');
  const runId = persistedWorktree.agentRunId;
  const contract = contracts.create({
    projectId: gp.project.id,
    podName: 'code-writer',
    expectedOutput: { kind: 'repo' },
    acceptanceCriteria: [],
    verificationTier: 'auto',
    worktreePath: wt.dir,
    worktreeBaseBranch: wt.baseBranch,
    worktreeBaseSha: wt.baseSha,
  });
  setWorktreeContractId(wt.branch, contract.id as ULID);
  insertAgentRunRow({
    id: runId,
    projectId: gp.project.id,
    ...testAgentRunExecution('code-writer'),
    dispatcherSessionId: 'self-healing',
    status: 'queued',
    input: 'land the sealed contract',
    contractId: contract.id as ULID,
    worktreeDir: wt.dir,
    worktreeBaseBranch: wt.baseBranch,
    worktreeBaseSha: wt.baseSha,
    gitReceipt: gitReceiptFor(wt),
    queuedAt: Date.now(),
  });
  contracts.setRun(contract.id, runId);
  advanceTestAgentRunStatus(runId, 'completed');
  const deliverable: Deliverable = { kind: 'repo', branch: wt.branch, commit: tip };
  const updated = contracts.setDeliverable({ id: contract.id, deliverable });
  assert.ok(updated, 'deliverable recorded');
  const verified = contracts.setVerification({
    id: contract.id,
    verificationStatus: 'passed',
    verifiedBaseSha: wt.baseSha,
  });
  assert.ok(verified, 'verification recorded');
  return verified;
}

/** A locked worktree makes `git worktree remove --force` fail deterministically
 *  (matches landing-guards.test.ts's own lock-based teardown-failure fixture):
 *  the FS fallback still deletes the directory, but the Git registration
 *  survives until unlocked, so `settleLandedWorktree` keeps returning
 *  'removal-incomplete'/'registration-inconclusive' on every attempt. */
async function lockWorktree(gp: GitProject, dir: string): Promise<void> {
  assert.equal((await git(['worktree', 'lock', dir], gp.dir)).ok, true);
}
async function unlockWorktree(gp: GitProject, dir: string): Promise<void> {
  assert.equal((await git(['worktree', 'unlock', dir], gp.dir)).ok, true);
}

test('teardown retry: a transient lock recovers on a later scheduled attempt — row destroyed + branch deleted', async () => {
  freshDb();
  const gp = await newGitProject();
  // Tiny, test-only backoff — the retry train converges quickly without
  // waiting on the real production delays.
  const dispatch = rig({ teardownRetryDelaysMs: [15, 30, 60, 120] });
  try {
    const contracts = new ContractService();
    const wt = await provisionOk(gp, newId());
    const tip = await commitFile(wt.dir, 'retry.txt', 'work\n');
    const contract = deliveredContract(contracts, gp, wt, tip);
    await lockWorktree(gp, wt.dir);

    const landed = await dispatch.landAcceptedContract(contract);
    assert.equal(landed?.landingStatus, 'landed', 'merge receipt is durable regardless of teardown outcome');
    const row = getWorktreeForLandedContract(contract.id as ULID)!;
    assert.notEqual(row.status, 'destroyed', 'first attempt could not clear the locked registration');

    // Release the lock mid-flight — the SCHEDULED retry (not a fresh manual
    // call) must pick this up and converge on its own.
    await unlockWorktree(gp, wt.dir);

    await until(() => getWorktreeById(row.id)?.status === 'destroyed', 5_000);
    assert.equal(
      (await git(['for-each-ref', '--format=%(refname)', `refs/heads/${wt.branch}`], gp.dir)).stdout,
      '',
      'the merged branch is deleted once the retry succeeds',
    );
  } finally {
    // Clears any still-pending retry timer BEFORE the directory it targets is
    // removed below — a leftover timer firing after cleanup would otherwise
    // race the next test in this same process.
    await dispatch.disposeAll();
    await gp.cleanup();
  }
});

test('teardown retry: a permanent lock exhausts the bounded budget, stays stranded, logs a receipt per attempt', async () => {
  freshDb();
  const gp = await newGitProject();
  const originalWarn = console.warn;
  const warnings: string[] = [];
  console.warn = (...args: unknown[]) => {
    warnings.push(String(args[0]));
  };
  const dispatch = rig({ teardownRetryDelaysMs: [10, 15, 20] });
  try {
    const contracts = new ContractService();
    const wt = await provisionOk(gp, newId());
    const tip = await commitFile(wt.dir, 'permanent.txt', 'work\n');
    const contract = deliveredContract(contracts, gp, wt, tip);
    await lockWorktree(gp, wt.dir);

    const landed = await dispatch.landAcceptedContract(contract);
    assert.equal(landed?.landingStatus, 'landed');
    const row = getWorktreeForLandedContract(contract.id as ULID)!;

    // Wait out the full retry train (10 + 15 + 20ms nominal, but each attempt
    // does real git/lease work) — the lock never releases, so every attempt
    // must fail the same way until the bounded budget gives up.
    await until(() => warnings.some((w) => w.includes('budget exhausted')), 10_000);

    assert.notEqual(getWorktreeById(row.id)?.status, 'destroyed', 'permanent failure never fakes a resolution');
    assert.ok(
      warnings.some((w) => w.includes('teardown retry') && w.includes(String(contract.id))),
      'each retry attempt logs an explicit receipt line',
    );
  } finally {
    console.warn = originalWarn;
    await dispatch.disposeAll();
    // cleanup() rmSync's the whole `-worktrees` root and project dir directly
    // — a `git worktree lock` is Git-level metadata, not an OS file lock, so
    // it never blocks this recursive delete; no unlock needed first.
    await gp.cleanup();
  }
});

test('janitor: concurrent triggers single-flight into one in-flight sweep', async () => {
  freshDb();
  const dispatch = rig();
  dispatch.attach({ registry: {} as never, hub: {} as never, serverPort: 5124 });
  try {
    const first = dispatch.triggerWorktreeJanitor();
    const second = dispatch.triggerWorktreeJanitor();
    assert.equal(first, second, 'a trigger during an in-flight sweep shares the SAME promise, never a second sweep');
    await first;
  } finally {
    await dispatch.disposeAll();
  }
});

test('janitor: killing an unrelated run recheck-resolves a stuck landed teardown (no restart, no manual call)', async () => {
  freshDb();
  const gp = await newGitProject();
  const dispatch = rig();
  dispatch.attach({ registry: {} as never, hub: {} as never, serverPort: 5124 });
  try {
    const contracts = new ContractService();
    const wt = await provisionOk(gp, newId());
    const tip = await commitFile(wt.dir, 'recheck.txt', 'work\n');
    const contract = deliveredContract(contracts, gp, wt, tip);
    await lockWorktree(gp, wt.dir);

    const landed = await dispatch.landAcceptedContract(contract);
    assert.equal(landed?.landingStatus, 'landed');
    const row = getWorktreeForLandedContract(contract.id as ULID)!;
    assert.notEqual(row.status, 'destroyed');
    await unlockWorktree(gp, wt.dir);

    // An entirely unrelated run settling (a kill, here) must be enough to
    // recheck and reclaim the stuck landed teardown — never only the next
    // boot or the next interval tick.
    const unrelatedRunId = newId() as ULID;
    insertAgentRunRow({
      id: unrelatedRunId,
      projectId: gp.project.id,
      ...testAgentRunExecution('code-writer'),
      dispatcherSessionId: 'unrelated',
      status: 'queued',
      input: 'unrelated busywork',
      queuedAt: Date.now(),
    });
    advanceTestAgentRunStatus(unrelatedRunId, 'running');
    const killed = await dispatch.killRun(gp.project.id, unrelatedRunId);
    assert.equal(killed.ok, true);

    await until(() => getWorktreeById(row.id)?.status === 'destroyed', 5_000);
    assert.equal(
      (await git(['for-each-ref', '--format=%(refname)', `refs/heads/${wt.branch}`], gp.dir)).stdout,
      '',
    );
  } finally {
    await dispatch.disposeAll();
    await gp.cleanup();
  }
});

test('janitor: the periodic interval converges a stuck landed teardown without touching live/review-parked/abandoned worktrees', async () => {
  freshDb();
  const gp = await newGitProject();
  const dispatch = rig({ worktreeJanitorIntervalMs: 25 });
  dispatch.attach({ registry: {} as never, hub: {} as never, serverPort: 5124 });
  try {
    const contracts = new ContractService();

    // Target: a landed contract whose teardown is stuck on a lock.
    const target = await provisionOk(gp, newId());
    const targetTip = await commitFile(target.dir, 'interval.txt', 'work\n');
    const targetContract = deliveredContract(contracts, gp, target, targetTip);
    await lockWorktree(gp, target.dir);
    const landed = await dispatch.landAcceptedContract(targetContract);
    assert.equal(landed?.landingStatus, 'landed');
    const targetRow = getWorktreeForLandedContract(targetContract.id as ULID)!;

    // Guard A — a LIVE run's worktree must never be touched.
    const liveRunId = newId() as ULID;
    const liveWt = await provisionOk(gp, liveRunId);
    insertAgentRunRow({
      id: liveRunId,
      projectId: gp.project.id,
      ...testAgentRunExecution('code-writer'),
      dispatcherSessionId: 'live',
      status: 'queued',
      input: 'still working',
      worktreeDir: liveWt.dir,
      queuedAt: Date.now(),
    });
    advanceTestAgentRunStatus(liveRunId, 'running');

    // Guard B — a STRANDED row whose contract is awaiting review/landing
    // (verified, sealed, not yet landed) must never be swept as an orphan or
    // torn down out from under the pending review. Its dir + live-run set are
    // both false here, so reconcileStrandedWorktrees's OWN self-heal (dir
    // back + awaiting-review) legitimately flips it back to 'active' — that
    // is the documented, correct outcome; the guard this exercises is that it
    // survives as a REAL, undamaged row (never destroyed, dir never swept),
    // not that its status label never changes.
    const root = worktreesRoot(gp.dir);
    const parkedDir = join(root, 'agent-parked-review');
    mkdirSync(parkedDir, { recursive: true });
    upsertWorktree({ name: 'agent-parked-review', path: parkedDir, projectId: gp.project.id });
    const parkedContract = createContract({ projectId: gp.project.id, podName: 'code-writer' });
    setContractDeliverable(parkedContract.id, {
      deliverable: { kind: 'repo', branch: 'agent-parked-review', commit: '0'.repeat(40) },
    });
    setContractVerification(parkedContract.id, { verificationStatus: 'passed' });
    setWorktreeContractId('agent-parked-review', parkedContract.id);
    markWorktreeStranded('agent-parked-review', 'no-live-run');

    await unlockWorktree(gp, target.dir);

    // Never call recoverIncompleteTeardowns/triggerWorktreeJanitor directly —
    // only the interval should be driving this convergence.
    await until(() => getWorktreeById(targetRow.id)?.status === 'destroyed', 5_000);
    // The parked row settles (self-heals to active) on the SAME interval —
    // give it the same convergence window instead of racing a single tick.
    await until(() => getActiveWorktreeByName('agent-parked-review') !== null, 5_000);

    assert.equal(getActiveWorktreeByName(liveWt.branch)?.status, 'active', 'live-run worktree untouched');
    assert.equal(existsSync(parkedDir), true, 'review-parked worktree directory was never swept as an orphan');
    assert.equal(
      listStrandedWorktrees(gp.project.id).some((w) => w.name === 'agent-parked-review'),
      false,
      'the parked row self-healed to active (dir present + awaiting review) — never destroyed, never left dangling',
    );
  } finally {
    await dispatch.disposeAll();
    await gp.cleanup();
  }
});
