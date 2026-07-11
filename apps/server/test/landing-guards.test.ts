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
import { existsSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ContractService } from '@pc/app-services';
import type { Contract, Deliverable } from '@pc/contracts';
import { createContract, createPendingAsk, getContract, insertAgentRunRow, markPendingAskAnswered, newId, updateAgentRunStatus } from '@pc/db';
import type { AcceptanceCriteria, ExpectedOutput, ULID } from '@pc/domain';
import { AccountRegistry } from '../src/runner/account-env.ts';
import { RuntimeRegistry } from '../src/runner/runtime.ts';
import type { McpManager } from '../src/mcp/manager.ts';
import { DispatchService } from '../src/dispatch/service.ts';
import { git, landBranch, provisionWorktree } from '../src/dispatch/worktrees.ts';
import { commitFile, freshDb, newGitProject, type GitProject } from './helpers.ts';

// No attach(): submit + land never touch the live server context.
function rig(): DispatchService {
  return new DispatchService({ runtimes: new RuntimeRegistry(), accounts: new AccountRegistry(), mcp: {} as McpManager });
}

async function provisionOk(projectDir: string, runId: string) {
  const out = await provisionWorktree(projectDir, runId);
  if (!out.ok) throw new Error(`provision failed: ${out.error}`);
  return out;
}

/** Contract + delivered repo deliverable for one provisioned worktree —
 *  everything landAcceptedContract needs. */
function deliveredContract(
  contracts: ContractService,
  gp: GitProject,
  wt: { dir: string; branch: string; baseBranch: string; baseSha: string },
  tip: string,
  landingPolicy: Contract['landingPolicy'] = null,
): Contract {
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
  const deliverable: Deliverable = { kind: 'repo', branch: wt.branch, commit: tip };
  const updated = contracts.setDeliverable({ id: contract.id, deliverable });
  assert.ok(updated, 'deliverable recorded');
  return updated;
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
      podName: 'code-writer',
      dispatcherSessionId: 'S1',
      ccSessionId: 'cc-1',
      status: 'running',
      input: 'go',
      contractId: contract.id,
      worktreeDir: wt.dir,
      worktreeBaseBranch: wt.baseBranch,
      worktreeBaseSha: wt.baseSha,
      queuedAt: Date.now(),
    });

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
    gp.cleanup();
  }
});

// If `git status` itself errors (worktree dir gone, git broken), the worktree
// state is unreadable — the submit is refused with the same retryable 409
// shape as the dirty-tree seal, never accepted unsealed.
test('submit seal: failing `git status` refuses the submit (worktree state unreadable)', async () => {
  freshDb();
  const gp = await newGitProject();
  try {
    const dispatch = rig();
    const runId = newId() as ULID;
    const goneDir = join(tmpdir(), `pc-sdk-gone-${newId().toLowerCase()}`); // never created
    const contract = createContract({
      projectId: gp.project.id,
      podName: 'code-writer',
      expectedOutput: { kind: 'repo' },
      acceptanceCriteria: [],
      verificationTier: 'auto',
      worktreePath: goneDir,
      worktreeBaseBranch: 'main',
      worktreeBaseSha: '0'.repeat(40),
    });
    insertAgentRunRow({
      id: runId,
      projectId: gp.project.id,
      podName: 'code-writer',
      dispatcherSessionId: 'S1',
      ccSessionId: 'cc-1',
      status: 'running',
      input: 'go',
      contractId: contract.id,
      worktreeDir: goneDir,
      worktreeBaseBranch: 'main',
      worktreeBaseSha: '0'.repeat(40),
      queuedAt: Date.now(),
    });
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
    gp.cleanup();
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
      podName: 'code-writer',
      dispatcherSessionId: 'S1',
      ccSessionId: 'cc-1',
      status: 'running',
      input: 'go',
      contractId: contract.id,
      worktreeDir: wt.dir,
      worktreeBaseBranch: wt.baseBranch,
      worktreeBaseSha: wt.baseSha,
      queuedAt: Date.now(),
    });
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
    gp.cleanup();
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
    gp.cleanup();
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
    gp.cleanup();
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
    gp.cleanup();
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
    assert.equal(a?.landingStatus, 'landed', a?.landingError ?? '');
    assert.equal(b?.landingStatus, 'stale-base', b?.landingError ?? '');

    assert.equal((await git(['merge-base', '--is-ancestor', tipA, 'HEAD'], gp.dir)).ok, true);
    assert.equal((await git(['merge-base', '--is-ancestor', tipB, 'HEAD'], gp.dir)).ok, false, 'B never merged');
    assert.ok(existsSync(join(gp.dir, 'a.txt')));
    assert.equal(existsSync(wtB.dir), true, 'B worktree preserved for revalidation');
    assert.equal((await git(['rev-parse', wtB.branch], gp.dir)).stdout, tipB, 'B branch preserved');
    // Exactly initial + A's branch commit + A's --no-ff merge commit.
    assert.equal((await git(['rev-list', '--count', 'HEAD'], gp.dir)).stdout, '3');
  } finally {
    gp.cleanup();
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
    gp.cleanup();
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
    gp.cleanup();
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
    gp.cleanup();
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
    gp.cleanup();
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
    gp.cleanup();
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
    gp.cleanup();
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
    gp.cleanup();
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
    gp.cleanup();
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
    /** Row-level evidence sabotage (e.g. null base SHA ⇒ unreadable git). */
    rowBaseSha?: string | null;
  },
): Promise<{ runId: ULID; contract: Contract; wt: { dir: string; branch: string; baseBranch: string; baseSha: string }; tip: string }> {
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
  insertAgentRunRow({
    id: runId,
    projectId: gp.project.id,
    podName: 'code-writer',
    dispatcherSessionId: 'S1',
    ccSessionId: `cc-${runId}`,
    status: 'completed',
    input: 'go',
    contractId: contract.id as ULID,
    worktreeDir: wt.dir,
    worktreeBaseBranch: wt.baseBranch,
    worktreeBaseSha: opts.rowBaseSha === undefined ? wt.baseSha : opts.rowBaseSha,
    queuedAt: Date.now(),
  });
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
    gp.cleanup();
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
    gp.cleanup();
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
    gp.cleanup();
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
    gp.cleanup();
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
      ccSessionId: `cc-${runId}`,
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
    gp.cleanup();
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
      ccSessionId: `cc-${runId}`,
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
    gp.cleanup();
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
    gp.cleanup();
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
    });
    // The builder door — smuggle policy keys inside the deliverable payload.
    // (The door refuses terminal runs now, so submit while 'running' like a
    // real builder, then settle before driving verification.)
    updateAgentRunStatus({ id: runId, status: 'running' });
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
    gp.cleanup();
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
    gp.cleanup();
  }
});
