// Landing guards through the DispatchService (docs/worktree-lifecycle.md),
// against real temp git repos:
//  - submit seal: a dirty worktree is a 409 refusal (retryable); resubmit
//    after committing backfills branch/commit receipts from COMMITTED state
//  - unreadable worktree (git status itself fails) is the same retryable 409
//    refusal — the seal is never silently skipped
//  - guard 9: the landing receipt is durable BEFORE teardown (teardown failure
//    cannot lose it); a confirmed land deletes the now-merged branch
//  - guard 6: concurrent accepts on one repository land serialized — one
//    merges; guard 7 parks the second (its verified base is stale)
//  - guard 7: base advancement after verification parks 'stale-base' (never
//    silently lands, never auto-rebases); a moved HEAD between check and
//    merge refuses; a re-driven already-merged branch converges to the
//    landed receipt without a duplicate merge
//  - merge receipt: target SHAs + merge commit + authorizer + verified base
//    persist durably; review-accept stamps 'orchestrator', auto-land 'auto'
//  - branch trust: only the provisioned worktree branch lands — a spoofed
//    deliverable.branch refuses instead of falsely converging
//  - probe hardening: zero-commit branches never converge to 'landed' and
//    never steal another contract's merge receipt
//  - guard 5: auto-merge refuses missing, failed, or inconclusive evidence —
//    pending/failed verification, an inconclusive subset, an open ask, or
//    missing changed-path scope evidence all park merge-ready with the WHY on
//    verificationNotes; only all-positive evidence lands (authorizer 'auto')
//  - policy is issuer-owned: a builder deliverable payload cannot flip
//    landingPolicy/auto_land through pc_submit_deliverable
//  - stale-base recovery: review accept revalidates against the current tip
//    (stamps verifiedBaseSha) and re-lands — no permanent park
//  - landed is final: a second drive off a stale snapshot short-circuits on
//    the durable receipt (authorizer/landedAt never overwritten)

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { ContractService } from '@pc/app-services';
import type { Contract, Deliverable } from '@pc/contracts';
import { bindProjectRepositoryIdentity, createContract, createPendingAsk, createProject, getActiveWorktreeByName, getAgentRunRow, getContract, getRawDb, getWorktreeById, getWorktreeForLandedContract, insertAgentRunRow, listAgentRunsForContract, listProjects, listStrandedWorktrees, markAgentRunDelivered, markPendingAskAnswered, markWorktreeStranded, newId, setContractReviewState, setWorktreeContractId, updateAgentRunStatus } from '@pc/db';
import type {
  AcceptanceCriteria,
  ExpectedOutput,
  RepositoryIdentityReceipt,
  ULID,
} from '@pc/domain';
import { AccountRegistry } from '../src/runner/account-env.ts';
import { FakeRuntime } from '../src/runner/fake-runtime.ts';
import { RuntimeRegistry } from '../src/runner/runtime.ts';
import { DispatchService, type DispatchServiceDeps } from '../src/dispatch/service.ts';
import { git, landBranch, provisionWorktree, settleLandedWorktree } from '../src/dispatch/worktrees.ts';
import {
  advanceTestAgentRunStatus,
  commitFile,
  freshDb,
  newGitProject,
  testAgentRunExecution,
  testDispatchRuntimeDeps,
  type GitProject,
} from './helpers.ts';
import { withRuntimeReceipt } from './runtime-fixtures.ts';

// No attach(): submit + land never touch the live server context.
function rig(overrides: Partial<DispatchServiceDeps> = {}): DispatchService {
  const runtimes = new RuntimeRegistry();
  const accounts = new AccountRegistry();
  return new DispatchService({
    ...testDispatchRuntimeDeps(runtimes, accounts),
    ...overrides,
  });
}

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => (resolve = done));
  return { promise, resolve };
}

async function provisionOk(projectDir: string, runId: string) {
  const projectId = listProjects().find((project) => project.folderPath === projectDir)?.id;
  const out = await provisionWorktree(projectDir, runId, projectId ? { projectId } : {});
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

/** Contract + delivered repo deliverable for one provisioned worktree —
 *  everything landAcceptedContract needs. */
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
  landingPolicy: Contract['landingPolicy'] = null,
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
    landingPolicy,
  });
  setWorktreeContractId(wt.branch, contract.id as ULID);
  insertAgentRunRow({
    id: runId,
    projectId: gp.project.id,
    ...testAgentRunExecution('code-writer'),
    dispatcherSessionId: 'landing-guard',
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

test('submit seal: dirty worktree ⇒ 409; committed resubmit backfills receipts', async () => {
  freshDb();
  const gp = await newGitProject();
  try {
    const dispatch = rig();
    const runId = newId() as ULID;
    const wt = await provisionOk(gp.dir, runId);
    const contract = createContract({
      projectId: gp.project.id,
      podName: 'code-writer',
      expectedOutput: { kind: 'repo' },
      acceptanceCriteria: [],
      verificationTier: 'auto',
      worktreePath: wt.dir,
      worktreeBaseBranch: wt.baseBranch,
      worktreeBaseSha: wt.baseSha,
    });
    insertAgentRunRow({
      id: runId,
      projectId: gp.project.id,
      ...testAgentRunExecution('code-writer'),
      dispatcherSessionId: 'S1',
      status: 'queued',
      input: 'go',
      contractId: contract.id,
      worktreeDir: wt.dir,
      worktreeBaseBranch: wt.baseBranch,
      worktreeBaseSha: wt.baseSha,
      gitReceipt: gitReceiptFor(wt),
      queuedAt: Date.now(),
    });

    advanceTestAgentRunStatus(runId, 'running');
    writeFileSync(join(wt.dir, 'wip.txt'), 'uncommitted\n');
    const refused = await dispatch.submitDeliverable({
      projectId: gp.project.id,
      agentRunId: runId,
      deliverable: { kind: 'repo' },
    });
    assert.equal(refused.ok, false);
    if (!refused.ok) {
      assert.equal(refused.httpStatus, 409);
      assert.match(refused.message, /uncommitted changes/);
    }

    // Seal satisfied: commit, resubmit — receipts come from committed state.
    const tip = await commitFile(wt.dir, 'wip.txt', 'done\n', 'agent work');
    const accepted = await dispatch.submitDeliverable({
      projectId: gp.project.id,
      agentRunId: runId,
      deliverable: { kind: 'repo' },
    });
    assert.equal(accepted.ok, true);
    if (accepted.ok) {
      const d = accepted.contract.deliverable as { branch?: string; commit?: string; baseBranch?: string; baseCommit?: string };
      assert.equal(d.commit, tip, 'commit backfilled from the sealed HEAD');
      assert.equal(d.branch, wt.branch);
      assert.equal(d.baseBranch, 'main');
      assert.equal(d.baseCommit, wt.baseSha);
    }
  } finally {
    await gp.cleanup();
  }
});

// If `git status` itself errors after repository authority is proven, the worktree
// state is unreadable — the submit is refused with the same retryable 409
// shape as the dirty-tree seal, never accepted unsealed.
test('submit seal: failing `git status` refuses the submit (worktree state unreadable)', async () => {
  freshDb();
  const gp = await newGitProject();
  try {
    const runId = newId() as ULID;
    const wt = await provisionOk(gp.dir, runId);
    const dispatch = rig({
      gitCommand: async (args, cwd) => args[0] === 'status'
        ? { ok: false, stdout: '', stderr: 'injected status failure', code: 1 }
        : git(args, cwd),
    });
    const contract = createContract({
      projectId: gp.project.id,
      podName: 'code-writer',
      expectedOutput: { kind: 'repo' },
      acceptanceCriteria: [],
      verificationTier: 'auto',
      worktreePath: wt.dir,
      worktreeBaseBranch: 'main',
      worktreeBaseSha: wt.baseSha,
    });
    insertAgentRunRow({
      id: runId,
      projectId: gp.project.id,
      ...testAgentRunExecution('code-writer'),
      dispatcherSessionId: 'S1',
      status: 'queued',
      input: 'go',
      contractId: contract.id,
      worktreeDir: wt.dir,
      worktreeBaseBranch: 'main',
      worktreeBaseSha: wt.baseSha,
      gitReceipt: gitReceiptFor(wt),
      queuedAt: Date.now(),
    });
    advanceTestAgentRunStatus(runId, 'running');
    const submitted = await dispatch.submitDeliverable({
      projectId: gp.project.id,
      agentRunId: runId,
      deliverable: { kind: 'repo', branch: 'agent-x', commit: 'deadbeef' },
    });
    assert.equal(submitted.ok, false, 'unreadable worktree state is refused, never accepted unsealed');
    if (!submitted.ok) {
      assert.equal(submitted.httpStatus, 409);
      assert.match(submitted.message, /worktree state unreadable/);
    }
  } finally {
    await gp.cleanup();
  }
});

// The commit is SEALED from the worktree HEAD: a builder-supplied SHA below
// the tip would anchor verification to base..thatCommit while landing merges
// the whole branch — unverified tip commits would land. Mismatch ⇒ 409.
test('submit seal: a builder-supplied commit that is not the worktree HEAD is refused', async () => {
  freshDb();
  const gp = await newGitProject();
  try {
    const dispatch = rig();
    const runId = newId() as ULID;
    const wt = await provisionOk(gp.dir, runId);
    const contract = createContract({
      projectId: gp.project.id,
      podName: 'code-writer',
      expectedOutput: { kind: 'repo' },
      acceptanceCriteria: [],
      verificationTier: 'auto',
      worktreePath: wt.dir,
      worktreeBaseBranch: wt.baseBranch,
      worktreeBaseSha: wt.baseSha,
    });
    insertAgentRunRow({
      id: runId,
      projectId: gp.project.id,
      ...testAgentRunExecution('code-writer'),
      dispatcherSessionId: 'S1',
      status: 'queued',
      input: 'go',
      contractId: contract.id,
      worktreeDir: wt.dir,
      worktreeBaseBranch: wt.baseBranch,
      worktreeBaseSha: wt.baseSha,
      gitReceipt: gitReceiptFor(wt),
      queuedAt: Date.now(),
    });
    advanceTestAgentRunStatus(runId, 'running');
    // In-scope commit, then a second commit at the tip.
    const inScope = await commitFile(wt.dir, 'feature.txt', 'ok\n');
    const tip = await commitFile(wt.dir, 'smuggled.txt', 'extra\n');

    const refused = await dispatch.submitDeliverable({
      projectId: gp.project.id,
      agentRunId: runId,
      deliverable: { kind: 'repo', commit: inScope },
    });
    assert.equal(refused.ok, false, 'a commit below the tip is refused, never sealed');
    if (!refused.ok) {
      assert.equal(refused.httpStatus, 409);
      assert.match(refused.message, /does not match the worktree HEAD/);
    }

    // Matching commit accepted; baseCommit/diffStat sealed from git, not the builder.
    const accepted = await dispatch.submitDeliverable({
      projectId: gp.project.id,
      agentRunId: runId,
      deliverable: {
        kind: 'repo',
        commit: tip,
        baseCommit: inScope, // builder tries to shrink the reported diff
        diffStat: { files: 1, insertions: 1, deletions: 0 },
      },
    });
    assert.equal(accepted.ok, true);
    if (accepted.ok) {
      const d = accepted.contract.deliverable as {
        commit?: string;
        baseCommit?: string;
        diffStat?: { files: number; insertions: number; deletions: number };
      };
      assert.equal(d.commit, tip, 'sealed to the worktree HEAD');
      assert.equal(d.baseCommit, wt.baseSha, 'baseCommit sealed from provisioning, not the builder');
      assert.equal(d.diffStat?.files, 2, 'diffStat derived over the FULL base..HEAD range');
    }
  } finally {
    await gp.cleanup();
  }
});

test('guard 9: landing receipt recorded, teardown done, merged branch deleted', async () => {
  freshDb();
  const gp = await newGitProject();
  try {
    const dispatch = rig();
    const contracts = new ContractService();
    const wt = await provisionOk(gp.dir, newId());
    const tip = await commitFile(wt.dir, 'feature.txt', 'work\n');
    const contract = deliveredContract(contracts, gp, wt, tip);

    const landed = await dispatch.landAcceptedContract(contract);
    assert.ok(landed, 'landing returned the updated contract');
    assert.equal(landed.landingStatus, 'landed');
    assert.equal(landed.landedSha, tip, 'landedSha is the BRANCH TIP, not the merge commit');
    assert.equal(landed.landedBranch, wt.branch);
    assert.ok(typeof landed.landedAt === 'number');

    assert.equal(existsSync(wt.dir), false, 'worktree torn down after landing');
    assert.equal(
      (await git(['rev-parse', '-q', '--verify', wt.branch], gp.dir)).ok,
      false,
      'merged branch deleted after a confirmed land — history lives on in the merge',
    );
    assert.equal((await git(['merge-base', '--is-ancestor', tip, 'HEAD'], gp.dir)).ok, true, 'ancestry receipt holds');
  } finally {
    await gp.cleanup();
  }
});

test('guard 9: teardown failure cannot lose the landing receipt', async () => {
  freshDb();
  const gp = await newGitProject();
  try {
    const dispatch = rig();
    const contracts = new ContractService();
    const wt = await provisionOk(gp.dir, newId());
    const tip = await commitFile(wt.dir, 'feature.txt', 'work\n');
    const contract = deliveredContract(contracts, gp, wt, tip);
    // git's own lock makes `git worktree remove --force` fail deterministically
    // — the receipt must already be durable BEFORE that call runs, regardless
    // of how teardown itself resolves (the FS fallback still reclaims the dir).
    assert.equal((await git(['worktree', 'lock', wt.dir], gp.dir)).ok, true);

    const landed = await dispatch.landAcceptedContract(contract);
    assert.ok(landed);
    assert.equal(landed.landingStatus, 'landed', 'receipt recorded regardless of how teardown resolves');
    assert.equal(landed.landedSha, tip);
    assert.equal(existsSync(wt.dir), false, 'the FS fallback reclaimed the directory despite the git-level lock');
    // Durable, not just the in-memory return value.
    assert.equal(getContract(landed.id as ULID)?.landingStatus, 'landed');
  } finally {
    await gp.cleanup();
  }
});

test('landed cleanup retries an active-to-stranded locked registration on the next boot', async () => {
  freshDb();
  const gp = await newGitProject();
  try {
    const dispatch = rig();
    const contracts = new ContractService();
    const wt = await provisionOk(gp.dir, newId());
    const tip = await commitFile(wt.dir, 'locked.txt', 'work\n');
    const contract = deliveredContract(contracts, gp, wt, tip);
    assert.equal((await git(['worktree', 'lock', wt.dir], gp.dir)).ok, true);

    const landed = await dispatch.landAcceptedContract(contract);
    assert.equal(landed?.landingStatus, 'landed');
    assert.equal(existsSync(wt.dir), false, 'owned filesystem fallback removes the directory');
    assert.equal((await git(['rev-parse', wt.branch], gp.dir)).stdout, tip, 'branch remains while registration is locked');
    const active = getActiveWorktreeByName(wt.branch);
    assert.ok(active, 'positive cleanup did not destroy the row');

    markWorktreeStranded(wt.branch, 'no-live-run', Date.now());
    assert.equal(listStrandedWorktrees(gp.project.id).some((row) => row.id === active.id), true);
    assert.equal((await git(['worktree', 'unlock', wt.dir], gp.dir)).ok, true);

    const restarted = rig();
    await restarted.recoverIncompleteTeardowns();
    assert.equal(getWorktreeById(active.id)?.status, 'destroyed');
    assert.equal((await git(['for-each-ref', '--format=%(refname)', `refs/heads/${wt.branch}`], gp.dir)).stdout, '');
    assert.equal(listStrandedWorktrees(gp.project.id).some((row) => row.id === active.id), false);
  } finally {
    await gp.cleanup();
  }
});

test('landed cleanup requires the project identity to match the producer receipt', async () => {
  freshDb();
  const gp = await newGitProject();
  try {
    const dispatch = rig();
    const contracts = new ContractService();
    const unboundProject = createProject({
      name: 'Unbound recovery project',
      slug: `unbound-${newId().toLowerCase()}`,
      folderPath: gp.dir,
    });
    const provisioned = await provisionWorktree(gp.dir, newId(), { projectId: unboundProject.id });
    if (!provisioned.ok) throw new Error(`provision failed: ${provisioned.error}`);
    const wt = provisioned;
    const tip = await commitFile(wt.dir, 'identity-gate.txt', 'work\n');
    const contract = deliveredContract(contracts, { ...gp, project: unboundProject }, wt, tip);

    const landed = await dispatch.landAcceptedContract(contract);
    assert.equal(landed?.landingStatus, 'landed', 'merge receipt remains durable');
    assert.equal(existsSync(wt.dir), true, 'missing project identity grants no teardown authority');
    assert.equal((await git(['rev-parse', wt.branch], gp.dir)).stdout, tip);
    const row = getWorktreeForLandedContract(contract.id as ULID)!;
    assert.notEqual(row.status, 'destroyed');

    assert.ok(bindProjectRepositoryIdentity(unboundProject.id, wt.repositoryIdentity));
    await rig().recoverIncompleteTeardowns();
    assert.equal(getWorktreeById(row.id)?.status, 'destroyed');
    assert.equal(existsSync(wt.dir), false);
    assert.equal((await git(['for-each-ref', '--format=%(refname)', `refs/heads/${wt.branch}`], gp.dir)).stdout, '');
  } finally {
    await gp.cleanup();
  }
});

test('destroyed exact row re-enters cleanup to finish the lifecycle crash window', async () => {
  freshDb();
  const gp = await newGitProject();
  try {
    const dispatch = rig();
    const contracts = new ContractService();
    const wt = await provisionOk(gp.dir, newId());
    const tip = await commitFile(wt.dir, 'lifecycle-crash.txt', 'work\n');
    const contract = deliveredContract(contracts, gp, wt, tip);
    const landed = await dispatch.landAcceptedContract(contract);
    assert.equal(landed?.landingStatus, 'landed');
    const row = getWorktreeForLandedContract(contract.id as ULID)!;
    assert.equal(row.status, 'destroyed');
    assert.equal(updateAgentRunStatus({
      id: contract.agentRunId as ULID,
      status: 'completed',
      lifecycleState: 'tearing-down',
    }), true, 'fixture models crash after row settlement before lifecycle completion');

    const restarted = rig();
    await restarted.recoverIncompleteTeardowns();
    assert.equal(getAgentRunRow(contract.agentRunId as ULID)?.lifecycleState, 'completed');
    assert.equal(getWorktreeById(row.id)?.status, 'destroyed');
    assert.equal(existsSync(wt.dir), false);
    assert.equal((await git(['for-each-ref', '--format=%(refname)', `refs/heads/${wt.branch}`], gp.dir)).stdout, '');
  } finally {
    await gp.cleanup();
  }
});

test('landed cleanup refuses registration drift before removal', async () => {
  freshDb();
  const gp = await newGitProject();
  try {
    const contracts = new ContractService();
    const wt = await provisionOk(gp.dir, newId());
    const tip = await commitFile(wt.dir, 'drift.txt', 'work\n');
    const contract = deliveredContract(contracts, gp, wt, tip);
    const merged = await landBranch({
      projectDir: gp.dir,
      branch: wt.branch,
      baseBranch: wt.baseBranch,
      podName: 'tester',
      expectedHeadSha: wt.baseSha,
      repositoryIdentity: wt.repositoryIdentity,
    });
    assert.equal(merged.outcome, 'landed');
    const advanced = await commitFile(gp.dir, 'after.txt', 'after\n');
    assert.equal((await git(['reset', '--hard', advanced], wt.dir)).ok, true);
    const worktree = getWorktreeForLandedContract(contract.id as ULID)!;
    const result = await settleLandedWorktree({
      projectDir: gp.dir,
      projectId: gp.project.id,
      contractId: contract.id as ULID,
      producerRunId: contract.agentRunId as ULID,
      worktree,
      branch: wt.branch,
      branchTip: tip,
      repositoryIdentity: wt.repositoryIdentity,
    });
    assert.equal(result.ok, false);
    if (!result.ok) assert.equal(result.code, 'invalid-binding');
    assert.equal(existsSync(wt.dir), true, 'retargeted checkout is preserved');
    assert.equal(getWorktreeById(worktree.id)?.status, 'active');
  } finally {
    await gp.cleanup();
  }
});

test('landed cleanup keeps row retryable when exact branch ref deletion cannot lock', async () => {
  freshDb();
  const gp = await newGitProject();
  try {
    const contracts = new ContractService();
    const wt = await provisionOk(gp.dir, newId());
    const tip = await commitFile(wt.dir, 'ref-lock.txt', 'work\n');
    const contract = deliveredContract(contracts, gp, wt, tip);
    const merged = await landBranch({
      projectDir: gp.dir,
      branch: wt.branch,
      baseBranch: wt.baseBranch,
      podName: 'tester',
      expectedHeadSha: wt.baseSha,
      repositoryIdentity: wt.repositoryIdentity,
    });
    assert.equal(merged.outcome, 'landed');
    const worktree = getWorktreeForLandedContract(contract.id as ULID)!;
    const lockPath = join(wt.repositoryIdentity.gitCommonDir, 'refs', 'heads', `${wt.branch}.lock`);
    writeFileSync(lockPath, 'held');
    const input = {
      projectDir: gp.dir,
      projectId: gp.project.id,
      contractId: contract.id as ULID,
      producerRunId: contract.agentRunId as ULID,
      worktree,
      branch: wt.branch,
      branchTip: tip,
      repositoryIdentity: wt.repositoryIdentity,
    };
    const blocked = await settleLandedWorktree(input);
    assert.equal(blocked.ok, false);
    if (!blocked.ok) assert.equal(blocked.code, 'branch-delete-failed');
    assert.equal(getWorktreeById(worktree.id)?.status, 'active');
    assert.equal(existsSync(wt.dir), false, 'directory proof alone does not settle the row');
    assert.equal((await git(['rev-parse', wt.branch], gp.dir)).stdout, tip);

    rmSync(lockPath, { force: true });
    assert.deepEqual(await settleLandedWorktree(input), { ok: true });
    assert.equal(getWorktreeById(worktree.id)?.status, 'destroyed');
    assert.equal((await git(['for-each-ref', '--format=%(refname)', `refs/heads/${wt.branch}`], gp.dir)).stdout, '');
  } finally {
    await gp.cleanup();
  }
});

test('merge receipt: full receipt persists on a real landing; authorizer auto vs orchestrator', async () => {
  freshDb();
  const gp = await newGitProject();
  try {
    const dispatch = rig();
    const contracts = new ContractService();

    // Orchestrator path — pc_review_contract accept lands the branch.
    const wtA = await provisionOk(gp.dir, newId());
    const tipA = await commitFile(wtA.dir, 'a.txt', 'a\n');
    const contractA = deliveredContract(contracts, gp, wtA, tipA);
    const mainBefore = (await git(['rev-parse', 'main'], gp.dir)).stdout;
    const reviewed = await dispatch.reviewContract({
      projectId: gp.project.id,
      contractId: contractA.id as ULID,
      verdict: 'accept',
    });
    assert.equal(reviewed.ok, true);

    // Durable receipt, read back from the DB — not the in-memory return.
    const a = getContract(contractA.id as ULID);
    assert.equal(a?.landingStatus, 'landed');
    assert.equal(a?.landingAuthorizer, 'orchestrator', 'review-accept landing is orchestrator-authorized');
    assert.equal(a?.landedSha, tipA, 'landedSha keeps the BRANCH-TIP meaning');
    assert.equal(a?.targetShaBefore, mainBefore, 'target SHA before the merge');
    const mainAfter = (await git(['rev-parse', 'main'], gp.dir)).stdout;
    assert.equal(a?.mergeSha, mainAfter, 'mergeSha is the merge commit on the target');
    assert.equal(a?.targetShaAfter, mainAfter, 'target SHA after the merge');
    assert.notEqual(a?.mergeSha, a?.landedSha, 'merge commit never overwrites the branch tip');
    assert.equal(a?.verifiedBaseSha, wtA.baseSha, 'the base SHA verification covered is recorded');
    // Git proves the receipt: merge parents are target-before + branch tip.
    assert.equal((await git(['rev-parse', `${a!.mergeSha}^1`], gp.dir)).stdout, mainBefore);
    assert.equal((await git(['rev-parse', `${a!.mergeSha}^2`], gp.dir)).stdout, tipA);

    // Auto path — the auto-merge policy door stamps 'auto'.
    const wtB = await provisionOk(gp.dir, newId());
    const tipB = await commitFile(wtB.dir, 'b.txt', 'b\n');
    const contractB = deliveredContract(contracts, gp, wtB, tipB, 'auto-merge');
    assert.equal(contractB.landingPolicy, 'auto-merge');
    const landedB = await dispatch.landAcceptedContract(contractB, 'auto');
    assert.equal(landedB?.landingStatus, 'landed');
    assert.equal(landedB?.landedSha, tipB);
    assert.equal(getContract(contractB.id as ULID)?.landingAuthorizer, 'auto', 'auto-land is auto-authorized');
  } finally {
    await gp.cleanup();
  }
});

test('guard 6: concurrent accepts on one repository land serialized', async () => {
  freshDb();
  const gp = await newGitProject();
  try {
    const dispatch = rig();
    const contracts = new ContractService();
    const wtA = await provisionOk(gp.dir, newId());
    const wtB = await provisionOk(gp.dir, newId());
    const tipA = await commitFile(wtA.dir, 'a.txt', 'a\n');
    const tipB = await commitFile(wtB.dir, 'b.txt', 'b\n');
    const contractA = deliveredContract(contracts, gp, wtA, tipA);
    const contractB = deliveredContract(contracts, gp, wtB, tipB);

    // Unserialized, these would race two `git merge`s in ONE working copy
    // (index.lock / moved HEAD ⇒ typed conflict). Serialized, A lands first;
    // guard 7 then parks B — A's merge advanced the target past B's verified
    // base, and stale verification never silently lands.
    const [a, b] = await Promise.all([
      dispatch.landAcceptedContract(contractA),
      dispatch.landAcceptedContract(contractB),
    ]);
    const outcomes = [
      { contract: a, wt: wtA, tip: tipA, file: 'a.txt' },
      { contract: b, wt: wtB, tip: tipB, file: 'b.txt' },
    ];
    const winner = outcomes.find((entry) => entry.contract?.landingStatus === 'landed');
    const parked = outcomes.find((entry) => entry.contract?.landingStatus === 'stale-base');
    assert.ok(winner, `one serialized landing wins: ${a?.landingStatus}/${b?.landingStatus}`);
    assert.ok(parked, `the later landing parks stale: ${a?.landingStatus}/${b?.landingStatus}`);

    assert.equal((await git(['merge-base', '--is-ancestor', winner.tip, 'HEAD'], gp.dir)).ok, true);
    assert.equal((await git(['merge-base', '--is-ancestor', parked.tip, 'HEAD'], gp.dir)).ok, false, 'parked work never merged');
    assert.ok(existsSync(join(gp.dir, winner.file)));
    assert.equal(existsSync(parked.wt.dir), true, 'parked worktree preserved for revalidation');
    assert.equal((await git(['rev-parse', parked.wt.branch], gp.dir)).stdout, parked.tip, 'parked branch preserved');
    // Exactly initial + winning branch commit + its --no-ff merge commit.
    assert.equal((await git(['rev-list', '--count', 'HEAD'], gp.dir)).stdout, '3');
  } finally {
    await gp.cleanup();
  }
});

test('guard 7: base advanced after verification ⇒ parked stale-base, nothing merged', async () => {
  freshDb();
  const gp = await newGitProject();
  try {
    const dispatch = rig();
    const contracts = new ContractService();
    const wt = await provisionOk(gp.dir, newId());
    const tip = await commitFile(wt.dir, 'feature.txt', 'work\n');
    const contract = deliveredContract(contracts, gp, wt, tip);
    // Unrelated work advances the target AFTER this run's verified base.
    const advanced = await commitFile(gp.dir, 'unrelated.txt', 'x\n');

    const parked = await dispatch.landAcceptedContract(contract);
    assert.equal(parked?.landingStatus, 'stale-base');
    assert.match(parked?.landingError ?? '', /advanced to .+ past the verified base/);
    assert.match(parked?.landingError ?? '', /no auto-rebase/);
    // Nothing merged, nothing torn down — parked for orchestrator revalidation.
    assert.equal((await git(['rev-parse', 'main'], gp.dir)).stdout, advanced, 'target HEAD unmoved');
    assert.equal((await git(['merge-base', '--is-ancestor', tip, 'main'], gp.dir)).ok, false, 'no merge commit created');
    assert.equal(existsSync(wt.dir), true, 'worktree preserved');
    assert.equal((await git(['rev-parse', wt.branch], gp.dir)).stdout, tip, 'branch preserved');
    assert.equal(getContract(contract.id as ULID)?.landingStatus, 'stale-base', 'durable, not just in-memory');
  } finally {
    await gp.cleanup();
  }
});

test('guard 7 / recovery: re-driving an already-merged branch converges — no duplicate merge', async () => {
  freshDb();
  const gp = await newGitProject();
  try {
    const dispatch = rig();
    const contracts = new ContractService();
    const wt = await provisionOk(gp.dir, newId());
    const tip = await commitFile(wt.dir, 'feature.txt', 'work\n');
    const contract = deliveredContract(contracts, gp, wt, tip);
    // Crash between merge and receipt: the merge exists, the row says 'pending'.
    contracts.setLanding({ id: contract.id, landingStatus: 'pending', landingAuthorizer: 'orchestrator' });
    assert.equal((await git(['merge', '--no-ff', '--no-edit', '-m', `land(code-writer): ${wt.branch}`, wt.branch], gp.dir)).ok, true);
    const mergeSha = (await git(['rev-parse', 'HEAD'], gp.dir)).stdout;
    const commitCount = (await git(['rev-list', '--count', 'HEAD'], gp.dir)).stdout;

    const pending = contracts.get(contract.id);
    assert.ok(pending);
    const redriven = await dispatch.landAcceptedContract(pending, 'orchestrator');
    assert.equal(redriven?.landingStatus, 'landed');
    assert.equal(redriven?.landedSha, tip, 'landedSha stays the branch tip');
    assert.equal(redriven?.mergeSha, mergeSha, 'converges on the EXISTING merge commit');
    assert.equal(redriven?.targetShaAfter, mergeSha);
    assert.equal(redriven?.targetShaBefore, wt.baseSha, 'recovered from the merge commit first parent');
    assert.equal((await git(['rev-list', '--count', 'HEAD'], gp.dir)).stdout, commitCount, 'no duplicate merge commit');
    assert.equal(existsSync(wt.dir), false, 'teardown completed on convergence');
    assert.equal(getContract(contract.id as ULID)?.landingStatus, 'landed', 'durable receipt');
  } finally {
    await gp.cleanup();
  }
});

test('landing merges only the provisioned worktree branch — a spoofed deliverable.branch refuses', async () => {
  freshDb();
  const gp = await newGitProject();
  try {
    const dispatch = rig();
    const contracts = new ContractService();
    const wt = await provisionOk(gp.dir, newId());
    const tip = await commitFile(wt.dir, 'feature.txt', 'work\n');
    const contract = deliveredContract(contracts, gp, wt, tip);
    // Agent submits 'main' (already an ancestor of itself) — pre-fix this
    // falsely converged the probe: contract stamped landed, nothing merged.
    const spoofed = contracts.setDeliverable({
      id: contract.id,
      deliverable: { kind: 'repo', branch: 'main', commit: tip },
    });
    assert.ok(spoofed);

    const out = await dispatch.landAcceptedContract(spoofed);
    assert.equal(out?.landingStatus, 'failed');
    assert.match(out?.landingError ?? '', /does not match the provisioned worktree branch/);
    assert.equal((await git(['merge-base', '--is-ancestor', tip, 'main'], gp.dir)).ok, false, 'nothing merged');
    assert.equal(existsSync(wt.dir), true, 'worktree preserved — work never silently marked landed');
  } finally {
    await gp.cleanup();
  }
});

test('landing refuses when the branch tip moved off the sealed deliverable commit', async () => {
  freshDb();
  const gp = await newGitProject();
  try {
    const dispatch = rig();
    const contracts = new ContractService();
    const wt = await provisionOk(gp.dir, newId());
    const sealed = await commitFile(wt.dir, 'feature.txt', 'work\n');
    const contract = deliveredContract(contracts, gp, wt, sealed);
    // An unverified commit lands on the tip AFTER the seal.
    const moved = await commitFile(wt.dir, 'smuggled.txt', 'x\n');

    const out = await dispatch.landAcceptedContract(contract);
    assert.equal(out?.landingStatus, 'failed');
    assert.match(out?.landingError ?? '', /is not the sealed deliverable commit/);
    assert.equal((await git(['merge-base', '--is-ancestor', moved, 'main'], gp.dir)).ok, false, 'unverified tip never merged');
    assert.equal((await git(['merge-base', '--is-ancestor', sealed, 'main'], gp.dir)).ok, false, 'nothing merged at all');
    assert.equal(existsSync(wt.dir), true, 'worktree preserved');
  } finally {
    await gp.cleanup();
  }
});

test('probe: a branch reset onto the advanced base tip never stamps a false landed receipt', async () => {
  freshDb();
  const gp = await newGitProject();
  try {
    const dispatch = rig();
    const contracts = new ContractService();
    const wt = await provisionOk(gp.dir, newId());
    const sealed = await commitFile(wt.dir, 'feature.txt', 'work\n');
    const contract = deliveredContract(contracts, gp, wt, sealed);
    // The base advances (another landing); the branch is reset onto the new
    // tip — pre-fix the probe converged (tip past validatedBase + ancestor of
    // base) and stamped 'landed' though the verified commit never merged.
    const advanced = await commitFile(gp.dir, 'other.txt', 'x\n');
    assert.equal((await git(['reset', '--hard', advanced], wt.dir)).ok, true);

    const out = await dispatch.landAcceptedContract(contract);
    assert.equal(out?.landingStatus, 'failed', 'never falsely stamped landed');
    assert.match(out?.landingError ?? '', /is not the sealed deliverable commit/);
    assert.equal((await git(['merge-base', '--is-ancestor', sealed, 'main'], gp.dir)).ok, false, 'verified work never merged');
    assert.equal(existsSync(wt.dir), true, 'worktree preserved');
  } finally {
    await gp.cleanup();
  }
});

test('probe: a zero-commit branch never converges to landed (no stolen merge receipt)', async () => {
  freshDb();
  const gp = await newGitProject();
  try {
    const dispatch = rig();
    const contracts = new ContractService();
    // Zero-commit run: the agent committed nothing; branch tip == base SHA.
    const wt = await provisionOk(gp.dir, newId());
    const contract = deliveredContract(contracts, gp, wt, wt.baseSha);
    // Another contract lands first, advancing the base with a --no-ff merge —
    // pre-fix the probe attributed THAT merge to the zero-commit contract.
    const wtOther = await provisionOk(gp.dir, newId());
    const tipOther = await commitFile(wtOther.dir, 'other.txt', 'x\n');
    const other = deliveredContract(contracts, gp, wtOther, tipOther);
    assert.equal((await dispatch.landAcceptedContract(other))?.landingStatus, 'landed');

    const parked = await dispatch.landAcceptedContract(contract);
    assert.equal(parked?.landingStatus, 'stale-base', 'never falsely landed');
    assert.equal(parked?.mergeSha ?? null, null, 'no other contract merge attributed to this receipt');
    assert.equal(existsSync(wt.dir), true, 'worktree preserved');
  } finally {
    await gp.cleanup();
  }
});

test('stale-base recovery: review accept revalidates against the new tip, then re-lands', async () => {
  freshDb();
  const gp = await newGitProject();
  try {
    const dispatch = rig();
    const contracts = new ContractService();
    const wt = await provisionOk(gp.dir, newId());
    const tip = await commitFile(wt.dir, 'feature.txt', 'work\n');
    const contract = deliveredContract(contracts, gp, wt, tip);
    const advanced = await commitFile(gp.dir, 'unrelated.txt', 'x\n');
    const parked = await dispatch.landAcceptedContract(contract);
    assert.equal(parked?.landingStatus, 'stale-base');

    // The door the error message advertises — pre-fix this re-parked forever.
    const reviewed = await dispatch.reviewContract({
      projectId: gp.project.id,
      contractId: contract.id as ULID,
      verdict: 'accept',
    });
    assert.equal(reviewed.ok, true);
    const row = getContract(contract.id as ULID);
    assert.equal(row?.landingStatus, 'landed');
    assert.equal(row?.verifiedBaseSha, advanced, 'receipt records the REVALIDATED base, not the provision-time base');
    assert.equal((await git(['merge-base', '--is-ancestor', tip, 'main'], gp.dir)).ok, true, 'branch really merged');
    assert.equal((await git(['rev-parse', `${row!.mergeSha}^1`], gp.dir)).stdout, advanced, 'merged onto the new tip');
  } finally {
    await gp.cleanup();
  }
});

test('a second land of an already-landed contract short-circuits — receipt never overwritten', async () => {
  freshDb();
  const gp = await newGitProject();
  try {
    const dispatch = rig();
    const contracts = new ContractService();
    const wt = await provisionOk(gp.dir, newId());
    const tip = await commitFile(wt.dir, 'feature.txt', 'work\n');
    const contract = deliveredContract(contracts, gp, wt, tip, 'auto-merge');

    const first = await dispatch.landAcceptedContract(contract, 'auto');
    assert.equal(first?.landingStatus, 'landed');
    const receipt = getContract(contract.id as ULID);
    // A racing accept re-drives with the STALE pre-land snapshot.
    const second = await dispatch.landAcceptedContract(contract, 'orchestrator');
    assert.equal(second?.landingStatus, 'landed');
    const after = getContract(contract.id as ULID);
    assert.equal(after?.landingAuthorizer, 'auto', 'first authorizer preserved');
    assert.equal(after?.landedAt, receipt?.landedAt, 'landedAt preserved');
    assert.equal(after?.version, receipt?.version, 'no second write at all');
  } finally {
    await gp.cleanup();
  }
});

// ── guard 5: the auto-land gate through the real verify→land path ───────────

/** The terminal-settlement door verifyAndLand hangs off settleTerminal; tests
 *  drive it directly against a completed row (no live session needed). */
function driveVerifyAndLand(dispatch: DispatchService, runId: ULID): Promise<void> {
  return (
    dispatch as unknown as { verifyAndLand(id: ULID, s: 'completed'): Promise<void> }
  ).verifyAndLand(runId, 'completed');
}

/** Provisioned worktree + one commit + contract + completed run row +
 *  delivered repo deliverable — everything verifyAndLand consumes. */
async function completedRepoRun(
  contracts: ContractService,
  gp: GitProject,
  opts: {
    spec: ExpectedOutput;
    acceptanceCriteria: AcceptanceCriteria;
    landingPolicy?: Contract['landingPolicy'];
    verificationTier?: 'auto' | 'orchestrator-review';
    /** Most verify/land tests consume a terminal row; submit-door tests need
     *  the run to remain live until the deliverable has been accepted. */
    runStatus?: 'running' | 'completed';
    /** Row-level evidence sabotage (e.g. null base SHA ⇒ unreadable git). */
    rowBaseSha?: string | null;
  },
): Promise<{
  runId: ULID;
  contract: Contract;
  wt: Awaited<ReturnType<typeof provisionOk>>;
  tip: string;
}> {
  const runId = newId() as ULID;
  const wt = await provisionOk(gp.dir, runId);
  const tip = await commitFile(wt.dir, 'feature.txt', 'work\n');
  const contract = contracts.create({
    projectId: gp.project.id,
    podName: 'code-writer',
    expectedOutput: opts.spec,
    acceptanceCriteria: opts.acceptanceCriteria,
    verificationTier: opts.verificationTier ?? 'auto',
    worktreePath: wt.dir,
    worktreeBaseBranch: wt.baseBranch,
    worktreeBaseSha: wt.baseSha,
    landingPolicy: opts.landingPolicy === undefined ? 'auto-merge' : opts.landingPolicy,
  });
  setWorktreeContractId(wt.branch, contract.id as ULID);
  const desiredStatus = opts.runStatus ?? 'completed';
  insertAgentRunRow({
    id: runId,
    projectId: gp.project.id,
    ...testAgentRunExecution('code-writer'),
    dispatcherSessionId: 'S1',
    status: 'queued',
    input: 'go',
    contractId: contract.id as ULID,
    worktreeDir: wt.dir,
    worktreeBaseBranch: wt.baseBranch,
    worktreeBaseSha: opts.rowBaseSha === undefined ? wt.baseSha : opts.rowBaseSha,
    gitReceipt: gitReceiptFor(wt),
    queuedAt: Date.now(),
  });
  contracts.setRun(contract.id, runId);
  advanceTestAgentRunStatus(runId, desiredStatus);
  const updated = contracts.setDeliverable({
    id: contract.id,
    deliverable: { kind: 'repo', branch: wt.branch, commit: tip },
    report: 'done',
  });
  assert.ok(updated, 'deliverable recorded');
  return { runId, contract: updated, wt, tip };
}

const SCOPED_SPEC: ExpectedOutput = { kind: 'repo', paths_touched: ['feature.txt'], auto_land: true };
const SCOPED_CRITERIA: AcceptanceCriteria = [
  { kind: 'git_diff_nonempty', cwd: 'worktree' },
  { kind: 'changed_paths_within', allowed: ['feature.txt'] },
];

test('post-terminal verification fences continuation, abandonment, review, and shutdown until it settles', async () => {
  freshDb();
  const gp = await newGitProject();
  const verificationStarted = deferred();
  const releaseVerification = deferred();
  const dispatch = rig({
    verifyContract: async () => {
      verificationStarted.resolve();
      await releaseVerification.promise;
      return {
        verificationStatus: 'passed',
        notes: 'delayed positive verification',
        escalatedToReview: false,
        evaluatedPredicateKinds: ['git_diff_nonempty', 'changed_paths_within'],
        inconclusiveCount: 0,
      };
    },
  });
  dispatch.attach({
    registry: { get: () => ({ injectAgentEnvelope: async () => {} }) } as never,
    hub: {} as never,
    serverPort: 5124,
  });
  try {
    const contracts = new ContractService();
    const { runId, contract } = await completedRepoRun(contracts, gp, {
      spec: SCOPED_SPEC,
      acceptanceCriteria: SCOPED_CRITERIA,
      landingPolicy: 'default-review',
      runStatus: 'running',
    });
    markAgentRunDelivered(runId, Date.now());
    const internals = dispatch as unknown as {
      settleTerminal(
        id: ULID,
        input: {
          status: 'completed';
          result: string | null;
          failureCause: null;
          failureReason: null;
        },
      ): void;
      postTerminalTasks: Map<string, { promise: Promise<void>; status: string }>;
      reviewTargetsByRun: Map<string, string>;
    };
    internals.settleTerminal(runId, {
      status: 'completed',
      result: 'done',
      failureCause: null,
      failureReason: null,
    });
    await verificationStarted.promise;
    assert.equal(internals.postTerminalTasks.get(runId)?.status, 'pending');

    const continuation = await dispatch.dispatchContinue({
      projectId: gp.project.id,
      runId,
      input: 'must wait for verification',
      dispatcherSessionId: 'post-terminal-fence',
    });
    assert.equal(continuation.ok, false);
    if (!continuation.ok) assert.match(continuation.message, /post-terminal settlement is still pending/);

    const abandonment = await dispatch.previewContractAbandonment({
      projectId: gp.project.id,
      contractId: contract.id as ULID,
    });
    assert.equal(abandonment.ok, false);
    if (!abandonment.ok) assert.match(abandonment.message, /post-terminal settlement is still pending/);

    const reservedReviewerId = newId() as ULID;
    assert.ok(setContractReviewState(contract.id as ULID, {
      reviewRound: 1,
      reviewRunId: reservedReviewerId,
      reviewSealedCommit: (contract.deliverable as { commit: string }).commit,
    }));
    internals.reviewTargetsByRun.set(reservedReviewerId, contract.id);
    const review = await dispatch.reviewContract({
      projectId: gp.project.id,
      contractId: contract.id as ULID,
      verdict: 'accept',
    });
    assert.equal(review.ok, false);
    if (!review.ok) assert.match(review.message, /post-terminal settlement is still pending/);
    assert.equal(
      getContract(contract.id as ULID)?.reviewRunId,
      reservedReviewerId,
      'producer preflight refuses before mutating the reviewer reservation',
    );
    let disposed = false;
    const disposal = dispatch.disposeAll().then(() => {
      disposed = true;
    });
    await new Promise((resolve) => setTimeout(resolve, 20));
    assert.equal(disposed, false, 'shutdown drains post-terminal repository authority');

    releaseVerification.resolve();
    await disposal;
    assert.equal(internals.postTerminalTasks.get(runId)?.status, 'completed');
    assert.equal(
      getContract(contract.id as ULID)?.verificationStatus,
      null,
      'the synthetic reservation changes the version, so the delayed outcome is correctly discarded',
    );
    assert.equal(getContract(contract.id as ULID)?.landingStatus, null, 'default-review remains parked');
    internals.reviewTargetsByRun.delete(reservedReviewerId);
    assert.ok(setContractReviewState(contract.id as ULID, {
      reviewRunId: null,
      reviewSealedCommit: null,
    }));
  } finally {
    releaseVerification.resolve();
    await gp.cleanup();
  }
});

test('review cleanup rejection fails its post-terminal owner and shutdown', async () => {
  freshDb();
  const gp = await newGitProject();
  const dispatch = rig();
  try {
    const contracts = new ContractService();
    const { runId } = await completedRepoRun(contracts, gp, {
      spec: SCOPED_SPEC,
      acceptanceCriteria: SCOPED_CRITERIA,
      landingPolicy: 'default-review',
    });
    const row = getAgentRunRow(runId)!;
    const cleanupFailure = new Error('forced reviewer cleanup failure');
    const internals = dispatch as unknown as {
      trackPostTerminalTask(id: ULID, work: () => Promise<void>): Promise<void>;
      ensureReviewCleanup(
        id: ULID,
        observed: NonNullable<ReturnType<typeof getAgentRunRow>>,
        targetId: ULID | null,
      ): Promise<void>;
      reclaimReviewCheckout(observed: NonNullable<ReturnType<typeof getAgentRunRow>>): Promise<void>;
      postTerminalTasks: Map<string, { status: string }>;
    };
    internals.reclaimReviewCheckout = async () => {
      throw cleanupFailure;
    };
    const owner = internals.trackPostTerminalTask(
      runId,
      () => internals.ensureReviewCleanup(runId, row, null),
    );
    await assert.rejects(owner, /forced reviewer cleanup failure/);
    assert.equal(internals.postTerminalTasks.get(runId)?.status, 'failed');
    await assert.rejects(
      dispatch.disposeAll(),
      (error: unknown) => error instanceof AggregateError && error.errors.includes(cleanupFailure),
    );
  } finally {
    await gp.cleanup();
  }
});

test('shutdown drains tracked task generations to a fixed point', async () => {
  freshDb();
  const dispatch = rig();
  const firstGeneration = deferred();
  const secondGeneration = deferred();
  const producerId = newId() as ULID;
  const settlementId = newId() as ULID;
  const internals = dispatch as unknown as {
    runTasks: Map<string, Promise<void>>;
    trackPostTerminalTask(id: ULID, work: () => Promise<void>): Promise<void>;
  };
  const producer = firstGeneration.promise.then(() => {
    void internals.trackPostTerminalTask(settlementId, () => secondGeneration.promise).catch(() => {});
  });
  internals.runTasks.set(producerId, producer);
  void producer.finally(() => {
    internals.runTasks.delete(producerId);
  });

  let disposed = false;
  const disposal = dispatch.disposeAll().then(() => {
    disposed = true;
  });
  firstGeneration.resolve();
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(disposed, false, 'a second-generation settlement keeps shutdown open');
  secondGeneration.resolve();
  await disposal;
  assert.equal(disposed, true);
});

test('continuation rechecks shutdown after repository authority before child insertion', async () => {
  freshDb();
  const gp = await newGitProject();
  const repositoryAuthorityHeld = deferred();
  const releaseRepositoryAuthority = deferred();
  const dispatch = rig({
    preflightRuntimeSession: async (selection) => ({ status: 'valid' as const, selection }),
    mintSpecialistRuntimeSession: async (input) => withRuntimeReceipt(() => new FakeRuntime())(input),
  });
  dispatch.attach({
    registry: { get: () => ({ injectAgentEnvelope: async () => {} }) } as never,
    hub: {} as never,
    serverPort: 5124,
  });
  try {
    const contracts = new ContractService();
    const wt = await provisionOk(gp.dir, newId());
    const tip = await commitFile(wt.dir, 'feature.txt', 'work\n');
    const contract = deliveredContract(contracts, gp, wt, tip);
    const parentRunId = contract.agentRunId as ULID;
    const leases = (
      dispatch as unknown as {
        repositoryLeases: {
          acquire(path: string, identity: RepositoryIdentityReceipt): Promise<unknown>;
        };
      }
    ).repositoryLeases;
    const originalAcquire = leases.acquire.bind(leases);
    leases.acquire = async (path, identity) => {
      const guard = await originalAcquire(path, identity);
      repositoryAuthorityHeld.resolve();
      await releaseRepositoryAuthority.promise;
      return guard;
    };

    const continuation = dispatch.dispatchContinue({
      projectId: gp.project.id,
      runId: parentRunId,
      input: 'must lose to shutdown after lease acquisition',
      dispatcherSessionId: 'shutdown-recheck',
    });
    await repositoryAuthorityHeld.promise;
    const disposal = dispatch.disposeAll();
    releaseRepositoryAuthority.resolve();
    const refused = await continuation;
    assert.equal(refused.ok, false);
    if (!refused.ok) {
      assert.equal(refused.cause, 'not-attached');
      assert.match(refused.message, /repository authority/);
    }
    assert.equal(listAgentRunsForContract(contract.id as ULID).length, 1, 'no child row was inserted');
    await disposal;
  } finally {
    releaseRepositoryAuthority.resolve();
    await gp.cleanup();
  }
});

test('guard 5 happy path: all-positive evidence auto-lands with authorizer auto', async () => {
  freshDb();
  const gp = await newGitProject();
  try {
    const dispatch = rig();
    const contracts = new ContractService();
    const { runId, contract, tip } = await completedRepoRun(contracts, gp, {
      spec: SCOPED_SPEC,
      acceptanceCriteria: SCOPED_CRITERIA,
    });
    await driveVerifyAndLand(dispatch, runId);
    const row = getContract(contract.id as ULID)!;
    assert.equal(row.verificationStatus, 'passed');
    assert.equal(row.landingStatus, 'landed');
    assert.equal(row.landingAuthorizer, 'auto');
    assert.doesNotMatch(row.verificationNotes ?? '', /auto-land refused/);
    assert.equal((await git(['merge-base', '--is-ancestor', tip, 'main'], gp.dir)).ok, true, 'branch really merged');
  } finally {
    await gp.cleanup();
  }
});

test('landing authorization is stale when the contract moves to a live producer before the lock', async () => {
  freshDb();
  const gp = await newGitProject();
  try {
    const dispatch = rig();
    const contracts = new ContractService();
    const wt = await provisionOk(gp.dir, newId());
    const tip = await commitFile(wt.dir, 'feature.txt', 'work\n');
    const authorized = deliveredContract(contracts, gp, wt, tip);

    const childRunId = newId() as ULID;
    insertAgentRunRow({
      id: childRunId,
      projectId: gp.project.id,
      ...testAgentRunExecution('code-writer'),
      dispatcherSessionId: 'landing-race',
      status: 'queued',
      input: 'continue before landing lock',
      contractId: authorized.id as ULID,
      worktreeDir: wt.dir,
      worktreeBaseBranch: wt.baseBranch,
      worktreeBaseSha: wt.baseSha,
      gitReceipt: gitReceiptFor(wt),
      queuedAt: Date.now(),
    });
    contracts.setRun(authorized.id, childRunId);
    advanceTestAgentRunStatus(childRunId, 'running');

    const refused = await dispatch.landAcceptedContract(authorized, 'reviewer');
    assert.ok(refused);
    assert.equal(refused.landingStatus, null, 'stale approval does not land');
    assert.equal(refused.agentRunId, childRunId, 'new producer remains authoritative');
    assert.equal(existsSync(wt.dir), true, 'live producer worktree is not torn down');
  } finally {
    await gp.cleanup();
  }
});

test('deferred continuation preflight wins before queued landing and invalidates the stale approval', async () => {
  freshDb();
  const gp = await newGitProject();
  const continuationGate = deferred();
  const preflightStarted = deferred();
  const landingGate = deferred();
  let preflightCalls = 0;
  const dispatch = rig({
    preflightRuntimeSession: async (selection) => {
      preflightCalls += 1;
      if (preflightCalls === 1) {
        preflightStarted.resolve();
        await continuationGate.promise;
      }
      return { status: 'valid' as const, selection };
    },
    mintSpecialistRuntimeSession: async (input) => withRuntimeReceipt(
      () => new FakeRuntime({ turns: [[{ hang: true }]] }),
    )(input),
  });
  dispatch.attach({
    registry: {
      get: () => ({ injectAgentEnvelope: async () => {} }),
    } as never,
    hub: {} as never,
    serverPort: 5124,
  });
  try {
    const contracts = new ContractService();
    const wt = await provisionOk(gp.dir, newId());
    const tip = await commitFile(wt.dir, 'feature.txt', 'work\n');
    const authorized = deliveredContract(contracts, gp, wt, tip);
    const parentRunId = authorized.agentRunId as ULID;

    const key = wt.repositoryIdentity.leaseKey;
    (dispatch as unknown as { landingLocks: Map<string, Promise<unknown>> })
      .landingLocks.set(key, landingGate.promise);

    const continuation = dispatch.dispatchContinue({
      projectId: gp.project.id,
      runId: parentRunId,
      input: 'continue while approval is waiting for the repository lock',
      dispatcherSessionId: 'landing-race',
    });
    await preflightStarted.promise;
    const landing = dispatch.landAcceptedContract(authorized, 'reviewer');

    continuationGate.resolve();
    const continued = await continuation;
    assert.equal(continued.ok, true, JSON.stringify(continued));
    const childRunId = (continued as { run: { runId: string } }).run.runId as ULID;

    landingGate.resolve();
    const refused = await landing;
    assert.ok(refused);
    assert.equal(refused.agentRunId, childRunId, 'continuation owns the current producer');
    assert.equal(refused.landingStatus, null, 'approval snapshot cannot land after producer drift');
    assert.equal(existsSync(wt.dir), true, 'continuation worktree remains available');

    await dispatch.killRun(gp.project.id, childRunId);
  } finally {
    continuationGate.resolve();
    landingGate.resolve();
    await dispatch.disposeAll();
    await gp.cleanup();
  }
});

test('continuation refuses and terminalizes its child when exact worktree ownership transfer fails', async () => {
  freshDb();
  const gp = await newGitProject();
  let mintCalls = 0;
  const dispatch = rig({
    preflightRuntimeSession: async (selection) => ({ status: 'valid' as const, selection }),
    mintSpecialistRuntimeSession: async (input) => {
      mintCalls += 1;
      return withRuntimeReceipt(() => new FakeRuntime())(input);
    },
  });
  dispatch.attach({ registry: {} as never, hub: {} as never, serverPort: 5124 });
  try {
    const contracts = new ContractService();
    const wt = await provisionOk(gp.dir, newId());
    const tip = await commitFile(wt.dir, 'feature.txt', 'work\n');
    const contract = deliveredContract(contracts, gp, wt, tip);
    const parentRunId = contract.agentRunId as ULID;
    const row = getActiveWorktreeByName(wt.branch);
    assert.ok(row);
    getRawDb().prepare('UPDATE worktrees SET agent_run_id = NULL WHERE id = ?').run(row.id);

    const refused = await dispatch.dispatchContinue({
      projectId: gp.project.id,
      runId: parentRunId,
      input: 'must not start without ownership transfer',
      dispatcherSessionId: 'ownership-transfer-refusal',
    });
    assert.equal(refused.ok, false);
    if (!refused.ok) {
      assert.equal(refused.cause, 'not-continuable');
      assert.match(refused.message, /ownership transfer/);
    }
    assert.equal(mintCalls, 0);
    assert.equal(getContract(contract.id as ULID)?.agentRunId, parentRunId);
    const child = listAgentRunsForContract(contract.id as ULID)
      .find((run) => run.id !== parentRunId);
    assert.equal(child?.status, 'failed');
    assert.match(child?.failureReason ?? '', /ownership transfer/);
  } finally {
    await dispatch.disposeAll();
    await gp.cleanup();
  }
});

test('verification drift: a reseal while predicates await discards the stale pass and never lands it', async () => {
  freshDb();
  const gp = await newGitProject();
  try {
    const verificationStarted = deferred();
    const releaseVerification = deferred();
    let verifiedCommit: string | null | undefined;
    const dispatch = rig({
      verifyContract: async (input) => {
        verifiedCommit = input.scope.deliverableCommit;
        verificationStarted.resolve();
        await releaseVerification.promise;
        return {
          verificationStatus: 'passed',
          notes: 'stale pass must be discarded',
          escalatedToReview: false,
          evaluatedPredicateKinds: ['git_diff_nonempty', 'changed_paths_within'],
          inconclusiveCount: 0,
        };
      },
    });
    const contracts = new ContractService();
    const { runId, contract, wt, tip } = await completedRepoRun(contracts, gp, {
      spec: SCOPED_SPEC,
      acceptanceCriteria: SCOPED_CRITERIA,
    });

    const verification = driveVerifyAndLand(dispatch, runId);
    await verificationStarted.promise;
    assert.equal(verifiedCommit, tip, 'the pending verification is bound to the original seal');

    const resealedCommit = await commitFile(wt.dir, 'feature.txt', 'resealed while verification waits\n');
    assert.ok(contracts.setDeliverable({
      id: contract.id,
      deliverable: { kind: 'repo', branch: wt.branch, commit: resealedCommit },
      report: 'newer evidence',
    }));
    releaseVerification.resolve();
    await verification;

    const current = getContract(contract.id as ULID)!;
    assert.equal((current.deliverable as { commit?: string }).commit, resealedCommit, 'newer seal remains authoritative');
    assert.equal(current.verificationStatus, null, 'the original seal pass is not written onto the reseal');
    assert.equal(current.landingStatus, null, 'stale verification cannot enter the landing gate');
    assert.doesNotMatch(current.verificationNotes ?? '', /stale pass must be discarded/);
    assert.equal((await git(['merge-base', '--is-ancestor', tip, 'main'], gp.dir)).ok, false, 'old seal did not land');
    assert.equal((await git(['merge-base', '--is-ancestor', resealedCommit, 'main'], gp.dir)).ok, false, 'new seal did not land unverified');
    assert.equal(existsSync(wt.dir), true, 'worktree stays available for the newer evidence path');
  } finally {
    await gp.cleanup();
  }
});

test('guard 5: pending verification (review tier) cannot auto-land', async () => {
  freshDb();
  const gp = await newGitProject();
  try {
    const dispatch = rig();
    const contracts = new ContractService();
    const { runId, contract, tip } = await completedRepoRun(contracts, gp, {
      spec: SCOPED_SPEC,
      acceptanceCriteria: SCOPED_CRITERIA,
      verificationTier: 'orchestrator-review',
    });
    await driveVerifyAndLand(dispatch, runId);
    const row = getContract(contract.id as ULID)!;
    assert.equal(row.verificationStatus, 'pending');
    assert.equal(row.landingStatus, null, 'parked merge-ready, nothing landed');
    assert.equal(row.landingAuthorizer, null);
    assert.equal((await git(['merge-base', '--is-ancestor', tip, 'main'], gp.dir)).ok, false, 'nothing merged');
  } finally {
    await gp.cleanup();
  }
});

test('guard 5: failed verification cannot auto-land', async () => {
  freshDb();
  const gp = await newGitProject();
  try {
    const dispatch = rig();
    const contracts = new ContractService();
    const { runId, contract, tip, wt } = await completedRepoRun(contracts, gp, {
      spec: SCOPED_SPEC,
      // The commit touches feature.txt — out of this declared scope ⇒ failed.
      acceptanceCriteria: [{ kind: 'changed_paths_within', allowed: ['other.txt'] }],
    });
    await driveVerifyAndLand(dispatch, runId);
    const row = getContract(contract.id as ULID)!;
    assert.equal(row.verificationStatus, 'failed');
    assert.equal(row.landingStatus, null);
    assert.equal((await git(['merge-base', '--is-ancestor', tip, 'main'], gp.dir)).ok, false, 'nothing merged');
    assert.equal(existsSync(wt.dir), true, 'worktree preserved');
  } finally {
    await gp.cleanup();
  }
});

test('guard 5: an inconclusive subset parks pending — a partial pass never auto-lands', async () => {
  freshDb();
  const gp = await newGitProject();
  try {
    const dispatch = rig();
    const contracts = new ContractService();
    // report_contains passes; git evidence is unreadable (row base SHA lost)
    // ⇒ git_diff_nonempty is inconclusive ⇒ the whole run parks pending.
    const { runId, contract, tip } = await completedRepoRun(contracts, gp, {
      spec: SCOPED_SPEC,
      acceptanceCriteria: [
        { kind: 'report_contains', pattern: 'done' },
        { kind: 'git_diff_nonempty', cwd: 'worktree' },
      ],
      rowBaseSha: null,
    });
    await driveVerifyAndLand(dispatch, runId);
    const row = getContract(contract.id as ULID)!;
    assert.equal(row.verificationStatus, 'pending', 'inconclusive evidence never counts as pass');
    assert.match(row.verificationNotes ?? '', /inconclusive/);
    assert.equal(row.landingStatus, null);
    assert.equal(row.landingAuthorizer, null);
    assert.equal((await git(['merge-base', '--is-ancestor', tip, 'main'], gp.dir)).ok, false, 'nothing merged');
  } finally {
    await gp.cleanup();
  }
});

test('guard 5: an unresolved ask blocks auto-land even on a verified pass', async () => {
  freshDb();
  const gp = await newGitProject();
  try {
    const dispatch = rig();
    const contracts = new ContractService();
    const { runId, contract, tip, wt } = await completedRepoRun(contracts, gp, {
      spec: SCOPED_SPEC,
      acceptanceCriteria: SCOPED_CRITERIA,
    });
    createPendingAsk({
      id: newId() as ULID,
      agentRunId: runId,
      projectId: gp.project.id,
      kind: 'orchestrator',
      promptBody: 'may I?',
      now: Date.now(),
    });
    await driveVerifyAndLand(dispatch, runId);
    const row = getContract(contract.id as ULID)!;
    assert.equal(row.verificationStatus, 'passed', 'the work itself verified fine');
    assert.equal(row.landingStatus, null, 'parked merge-ready for orchestrator review');
    assert.match(row.verificationNotes ?? '', /auto-land refused/);
    assert.match(row.verificationNotes ?? '', /unresolved pending ask/);
    assert.equal((await git(['merge-base', '--is-ancestor', tip, 'main'], gp.dir)).ok, false, 'nothing merged');
    assert.equal(existsSync(wt.dir), true, 'worktree preserved for the review door');
  } finally {
    await gp.cleanup();
  }
});

test('guard 5: an ANSWERED ask is resolved — it does not block auto-land', async () => {
  freshDb();
  const gp = await newGitProject();
  try {
    const dispatch = rig();
    const contracts = new ContractService();
    const { runId, contract, tip } = await completedRepoRun(contracts, gp, {
      spec: SCOPED_SPEC,
      acceptanceCriteria: SCOPED_CRITERIA,
    });
    const askId = newId() as ULID;
    createPendingAsk({
      id: askId,
      agentRunId: runId,
      projectId: gp.project.id,
      kind: 'orchestrator',
      promptBody: 'may I?',
      now: Date.now(),
    });
    assert.equal(markPendingAskAnswered({ id: askId, answer: 'yes', answeredBy: 'orchestrator', now: Date.now() }), true);
    await driveVerifyAndLand(dispatch, runId);
    const row = getContract(contract.id as ULID)!;
    assert.equal(row.verificationStatus, 'passed');
    assert.equal(row.landingStatus, 'landed', 'answered ask never parks the merge');
    assert.equal(row.landingAuthorizer, 'auto');
    assert.doesNotMatch(row.verificationNotes ?? '', /unresolved pending ask/);
    assert.equal((await git(['merge-base', '--is-ancestor', tip, 'main'], gp.dir)).ok, true, 'branch really merged');
  } finally {
    await gp.cleanup();
  }
});

test('guard 5: declared paths_touched without scope evidence parks for review (missing evidence ≠ pass)', async () => {
  freshDb();
  const gp = await newGitProject();
  try {
    const dispatch = rig();
    const contracts = new ContractService();
    // Explicit criteria omit changed_paths_within while the spec declares
    // paths_touched — the pass is real but scope evidence is MISSING.
    const { runId, contract, tip } = await completedRepoRun(contracts, gp, {
      spec: SCOPED_SPEC,
      acceptanceCriteria: [{ kind: 'git_diff_nonempty', cwd: 'worktree' }],
    });
    await driveVerifyAndLand(dispatch, runId);
    const row = getContract(contract.id as ULID)!;
    assert.equal(row.verificationStatus, 'passed');
    assert.equal(row.landingStatus, null, 'routed to orchestrator review instead of auto-landing');
    assert.match(row.verificationNotes ?? '', /auto-land refused/);
    assert.match(row.verificationNotes ?? '', /scope evidence missing/);
    assert.equal((await git(['merge-base', '--is-ancestor', tip, 'main'], gp.dir)).ok, false, 'nothing merged');
    // The recovery door still works: orchestrator accept lands it.
    const reviewed = await dispatch.reviewContract({ projectId: gp.project.id, contractId: contract.id as ULID, verdict: 'accept' });
    assert.equal(reviewed.ok, true);
    assert.equal(getContract(contract.id as ULID)?.landingStatus, 'landed');
    assert.equal(getContract(contract.id as ULID)?.landingAuthorizer, 'orchestrator');
  } finally {
    await gp.cleanup();
  }
});

test('policy is issuer-owned: a deliverable payload cannot flip landingPolicy/auto_land', async () => {
  freshDb();
  const gp = await newGitProject();
  try {
    const dispatch = rig();
    const contracts = new ContractService();
    const { runId, contract, tip } = await completedRepoRun(contracts, gp, {
      spec: { kind: 'repo' }, // no auto_land
      acceptanceCriteria: [{ kind: 'git_diff_nonempty', cwd: 'worktree' }],
      landingPolicy: 'default-review',
      runStatus: 'running',
    });
    // The builder door — smuggle policy keys inside the deliverable payload.
    // (The door refuses terminal runs now, so submit while 'running' like a
    // real builder, then settle before driving verification.)
    const submitted = await dispatch.submitDeliverable({
      projectId: gp.project.id,
      agentRunId: runId,
      deliverable: { kind: 'repo', commit: tip, auto_land: true, landingPolicy: 'auto-merge', landing_policy: 'auto-merge' },
    });
    assert.equal(submitted.ok, true);
    updateAgentRunStatus({ id: runId, status: 'completed' });
    await driveVerifyAndLand(dispatch, runId);
    const row = getContract(contract.id as ULID)!;
    assert.equal(row.landingPolicy, 'default-review', 'landingPolicy untouched by the deliverable');
    assert.equal((row.expectedOutput as { auto_land?: boolean }).auto_land, undefined, 'spec auto_land untouched');
    assert.equal(row.verificationStatus, 'passed');
    assert.equal(row.landingStatus, null, 'parked merge-ready — never auto-landed');
    assert.equal(row.landingAuthorizer, null);
    assert.equal((await git(['merge-base', '--is-ancestor', tip, 'main'], gp.dir)).ok, false, 'nothing merged');
  } finally {
    await gp.cleanup();
  }
});

test('guard 7: landBranch refuses when the target HEAD moved between check and merge', async () => {
  freshDb();
  const gp = await newGitProject();
  try {
    const wt = await provisionOk(gp.dir, newId());
    const tip = await commitFile(wt.dir, 'feature.txt', 'work\n');
    // The caller validated wt.baseSha; the target moves before the merge runs.
    const moved = await commitFile(gp.dir, 'race.txt', 'race\n');
    const out = await landBranch({
      projectDir: gp.dir,
      branch: wt.branch,
      baseBranch: 'main',
      podName: 'tester',
      expectedHeadSha: wt.baseSha,
    });
    assert.equal(out.outcome, 'stale-base');
    if (out.outcome === 'stale-base') assert.match(out.error, /moved to .+ after the pre-merge check/);
    assert.equal((await git(['rev-parse', 'main'], gp.dir)).stdout, moved, 'refusal never mutates the target');
    assert.equal((await git(['merge-base', '--is-ancestor', tip, 'main'], gp.dir)).ok, false, 'nothing merged');
  } finally {
    await gp.cleanup();
  }
});
