// Kill-recovery (standing test, plan DoD). FakeRuntime + a real SQLite file:
// start a turn → hang it mid-flight → "hard-stop" (drop the DB connection) →
// boot → assert exactly one turn-failed persisted, the session is not stuck
// busy, and replay is coherent. A second boot is a no-op (idempotent).
//
// Worktree-lifecycle guard 10 (docs/worktree-lifecycle.md): kill recovery
// preserves work and produces the SAME durable outcome as an uninterrupted
// lifecycle. Each scenario builds the exact durable state a crash leaves at
// one point in the pipeline, then runs the REAL index.ts boot order:
//  - killed after seal, before verification → boot settles the run completed
//    and (auto-merge policy, all-positive evidence) lands with the full receipt
//  - killed after merge, before the receipt → boot converges via the ancestry
//    probe (recovery case: 'merging' without a stored receipt) — no double-merge
//  - killed after the receipt, before teardown → boot resumes teardown only
//  - killed with a pending landing while the base advanced → the re-drive
//    revalidates like a fresh landing and parks 'stale-base' (guard 7)
//  - killed mid-prep (no seal) → failed loudly, worktree preserved, and the
//    stranded scan SURFACES it

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { ContractService } from '@pc/app-services';
import {
  closeDb,
  getActiveOrchestratorSession,
  getActiveWorktreeByName,
  getAgentRunRow,
  getContract,
  insertAgentRunRow,
  listConversationEvents,
  listStrandedWorktrees,
  markAgentRunDelivered,
  newId,
  setWorktreeContractId,
} from '@pc/db';
import type { ChatEvent, Contract } from '@pc/contracts';
import type { AgentRunStatus, RunLifecycleState, ULID } from '@pc/domain';
import { SessionService } from '../src/chat/session-service.ts';
import { SessionRegistry } from '../src/chat/registry.ts';
import { ProjectWebSocketHub } from '../src/ws/hub.ts';
import { FakeRuntime } from '../src/runner/fake-runtime.ts';
import { AccountRegistry } from '../src/runner/account-env.ts';
import { RuntimeRegistry } from '../src/runner/runtime.ts';
import type { McpManager } from '../src/mcp/manager.ts';
import { DispatchService } from '../src/dispatch/service.ts';
import { git, provisionWorktree, type ProvisionedWorktree } from '../src/dispatch/worktrees.ts';
import { reconcileStrandedWorktreesAtBoot, runBootRecovery } from '../src/boot-recovery.ts';
import { commitFile, freshDb, newGitProject, newProject, until, type GitProject } from './helpers.ts';

function kinds(sessionId: string): string[] {
  return listConversationEvents(sessionId).map((r) => r.kind ?? '');
}
function terminals(sessionId: string): ChatEvent[] {
  return listConversationEvents(sessionId)
    .map((r) => r.event as ChatEvent)
    .filter((e) => e.kind === 'turn-end' || e.kind === 'turn-failed');
}

test('server dies mid-turn → boot recovery persists exactly one turn-failed', async () => {
  freshDb();
  const project = newProject();

  // A turn that emits some content then hangs forever (models the process dying
  // with the turn in flight). We deliberately never resolve it.
  const backend = new FakeRuntime({
    turns: [[
      { type: 'init', sdkSessionId: 'sdk-1', model: 'opus', permissionMode: 'default' },
      { type: 'assistant-block', sdkUuid: 'u1', parentToolUseId: null, block: { kind: 'text', text: 'working on it' } },
      { hang: true },
    ]],
  });
  const svc = new SessionService({ projectId: project.id, mintSession: () => backend, broadcast: () => {} });
  const session = svc.ensureActiveSession();
  svc.handleSend('do the thing', 'cm1');

  // Wait until the turn is genuinely in flight (running persisted, no terminal).
  await until(() =>
    listConversationEvents(session.id).some(
      (r) => r.kind === 'session-state' && (r.event as { state: string }).state === 'running',
    ),
  );
  assert.equal(terminals(session.id).length, 0, 'no terminal yet — turn is in flight');

  // Hard stop: drop the DB connection (the process is gone). The hung backend
  // promise is abandoned on purpose.
  closeDb();

  // Boot.
  const result = runBootRecovery();
  assert.deepEqual(result.recovered, [session.id]);

  const t = terminals(session.id);
  assert.equal(t.length, 1, 'exactly one turn-failed');
  assert.equal(t[0].kind, 'turn-failed');
  assert.equal((t[0] as { source: string }).source, 'internal');

  // Not stuck busy: the last session-state is idle.
  const lastState = listConversationEvents(session.id)
    .filter((r) => r.kind === 'session-state')
    .at(-1);
  assert.equal((lastState?.event as { state: string }).state, 'idle');

  // Replay is coherent: the crashed turn is closed out, in order.
  assert.deepEqual(kinds(session.id).slice(-2), ['turn-failed', 'session-state']);

  // Idempotent: a second boot changes nothing.
  const again = runBootRecovery();
  assert.deepEqual(again.recovered, []);
  assert.equal(terminals(session.id).length, 1);
});

test('a cleanly-idle session is not touched by boot recovery', async () => {
  freshDb();
  const project = newProject();
  const backend = new FakeRuntime({
    turns: [[{ type: 'result', ok: true, subtype: 'success', stopReason: 'end_turn', usage: null, durationMs: 1, error: null, outcome: 'ok', numTurns: null }]],
  });
  const svc = new SessionService({ projectId: project.id, mintSession: () => backend, broadcast: () => {} });
  const session = svc.ensureActiveSession();
  svc.handleSend('hi', 'cm1');
  await until(() => terminals(session.id).length === 1);

  const before = listConversationEvents(session.id).length;
  const result = runBootRecovery();
  assert.deepEqual(result.recovered, []);
  assert.equal(listConversationEvents(session.id).length, before);
});

// ── guard 10: kill at each pipeline point ≡ the uninterrupted outcome ────────

/** The index.ts boot order, verbatim: sweep → sealed-run recovery →
 *  pending-landing re-drive → teardown resume → stranded scan. Guard 10
 *  exercises the REAL sequence, not one door in isolation. */
async function bootAll(dispatch: DispatchService): Promise<void> {
  runBootRecovery();
  await dispatch.recoverSealedRuns();
  await dispatch.recoverPendingLandings();
  await dispatch.recoverIncompleteTeardowns();
  await reconcileStrandedWorktreesAtBoot();
}

/** Pre-attach, exactly like boot (recovery runs before dispatch.attach). */
function dispatchRig(): DispatchService {
  return new DispatchService({ runtimes: new RuntimeRegistry(), accounts: new AccountRegistry(), mcp: {} as McpManager });
}

/** The durable state a crashed repo run leaves behind: provisioned worktree
 *  (bound row), contract, run row at the given status/lifecycle, optional
 *  sealed deliverable at the branch tip. */
async function crashedRepoRun(
  gp: GitProject,
  contracts: ContractService,
  opts: {
    status: AgentRunStatus;
    lifecycleState: RunLifecycleState;
    seal: boolean;
    landingPolicy?: Contract['landingPolicy'];
  },
): Promise<{ runId: ULID; contract: Contract; wt: ProvisionedWorktree; tip: string }> {
  const runId = newId() as ULID;
  const provisioned = await provisionWorktree(gp.dir, runId, { projectId: gp.project.id });
  if (!provisioned.ok) throw new Error(`provision failed: ${provisioned.error}`);
  const wt = provisioned;
  const tip = await commitFile(wt.dir, 'feature.txt', 'work\n');
  let contract = contracts.create({
    projectId: gp.project.id,
    podName: 'code-writer',
    expectedOutput: { kind: 'repo', paths_touched: ['feature.txt'], ...(opts.landingPolicy === 'auto-merge' ? { auto_land: true } : {}) },
    acceptanceCriteria: [
      { kind: 'git_diff_nonempty', cwd: 'worktree' },
      { kind: 'changed_paths_within', allowed: ['feature.txt'] },
    ],
    verificationTier: 'auto',
    worktreePath: wt.dir,
    worktreeBaseBranch: wt.baseBranch,
    worktreeBaseSha: wt.baseSha,
    landingPolicy: opts.landingPolicy ?? null,
  });
  setWorktreeContractId(wt.branch, contract.id as ULID);
  insertAgentRunRow({
    id: runId,
    projectId: gp.project.id,
    podName: 'code-writer',
    dispatcherSessionId: 'S1',
    ccSessionId: `cc-${runId}`,
    status: opts.status,
    input: 'go',
    contractId: contract.id as ULID,
    worktreeDir: wt.dir,
    worktreeBaseBranch: wt.baseBranch,
    worktreeBaseSha: wt.baseSha,
    lifecycleState: opts.lifecycleState,
    queuedAt: Date.now(),
  });
  contract = contracts.setRun(contract.id, runId) ?? contract;
  if (opts.seal) {
    const sealed = contracts.setDeliverable({
      id: contract.id,
      deliverable: { kind: 'repo', branch: wt.branch, commit: tip },
      report: 'done',
    });
    assert.ok(sealed, 'deliverable sealed');
    contract = sealed;
    // Match the real submit flow: submitDeliverable stamps THE RUN's
    // deliveredAt in the same motion — sealed-run recovery keys on it.
    markAgentRunDelivered(runId, Date.now());
  }
  return { runId, contract, wt, tip };
}

test('guard 10: killed after seal, before verification — boot resumes to verification and auto-lands the full receipt', async () => {
  freshDb();
  const gp = await newGitProject();
  try {
    const dispatch = dispatchRig();
    const contracts = new ContractService();
    // Crash point: deliverable sealed (submit stamped 'verifying'), process
    // died before settlement/verification. The run row is still 'running'.
    const { runId, contract, wt, tip } = await crashedRepoRun(gp, contracts, {
      status: 'running',
      lifecycleState: 'verifying',
      seal: true,
      landingPolicy: 'auto-merge',
    });

    await bootAll(dispatch);

    // Same durable outcome as the uninterrupted auto-land pipeline.
    const run = getAgentRunRow(runId)!;
    assert.equal(run.status, 'completed', 'sealed evidence settles completed, never a blanket failed');
    assert.equal(run.failureCause, null);
    assert.equal(run.lifecycleState, 'completed');
    const row = getContract(contract.id as ULID)!;
    assert.equal(row.verificationStatus, 'passed', 'verification re-fired from durable evidence');
    assert.equal(row.landingStatus, 'landed');
    assert.equal(row.landingAuthorizer, 'auto');
    assert.equal(row.landedSha, tip, 'landedSha is the branch tip');
    assert.equal(row.targetShaBefore, wt.baseSha);
    const mainTip = (await git(['rev-parse', 'main'], gp.dir)).stdout;
    assert.equal(row.mergeSha, mainTip, 'merge commit recorded');
    assert.equal(row.targetShaAfter, mainTip);
    assert.equal(row.verifiedBaseSha, wt.baseSha);
    assert.ok(typeof row.landedAt === 'number');
    assert.equal((await git(['merge-base', '--is-ancestor', tip, 'main'], gp.dir)).ok, true, 'positive ancestry proof');
    assert.equal(existsSync(wt.dir), false, 'worktree torn down');
    assert.equal(getActiveWorktreeByName(wt.branch), null, 'row destroyed');
    assert.equal((await git(['rev-parse', '-q', '--verify', wt.branch], gp.dir)).ok, false, 'merged branch deleted after a confirmed land');
    assert.equal(listStrandedWorktrees().length, 0, 'nothing stranded');

    // Idempotent: a second boot changes nothing durable.
    await bootAll(dispatch);
    const again = getContract(contract.id as ULID)!;
    assert.equal(again.landedAt, row.landedAt);
    assert.equal(again.version, row.version, 'no second write at all');
  } finally {
    gp.cleanup();
  }
});

test('guard 10: killed after merge, before the receipt — boot converges via the ancestry probe, no double-merge', async () => {
  freshDb();
  const gp = await newGitProject();
  try {
    const dispatch = dispatchRig();
    const contracts = new ContractService();
    // Crash point: run settled, verification passed, landing stamped
    // 'pending', `git merge` COMPLETED — the process died before the landed
    // receipt was written ("'merging' without a stored receipt").
    const { runId, contract, wt, tip } = await crashedRepoRun(gp, contracts, {
      status: 'completed',
      lifecycleState: 'merging',
      seal: true,
    });
    assert.ok(contracts.setVerification({ id: contract.id, verificationStatus: 'passed', verificationNotes: 'verified pre-crash' }));
    contracts.setLanding({ id: contract.id, landingStatus: 'pending', landingAuthorizer: 'orchestrator' });
    assert.equal((await git(['merge', '--no-ff', '--no-edit', '-m', `land(code-writer): ${wt.branch}`, wt.branch], gp.dir)).ok, true);
    const mergeSha = (await git(['rev-parse', 'HEAD'], gp.dir)).stdout;
    const commitCount = (await git(['rev-list', '--count', 'HEAD'], gp.dir)).stdout;

    await bootAll(dispatch);

    // Ancestry inspected FIRST — converged to the landed receipt, no re-merge.
    const row = getContract(contract.id as ULID)!;
    assert.equal(row.landingStatus, 'landed');
    assert.equal(row.mergeSha, mergeSha, 'converged on the EXISTING merge commit');
    assert.equal(row.targetShaAfter, mergeSha);
    assert.equal(row.targetShaBefore, wt.baseSha, 'recovered from the merge commit first parent');
    assert.equal(row.landedSha, tip);
    assert.equal(row.landingAuthorizer, 'orchestrator', 're-drive keeps the authorizer stamped at pending');
    assert.equal((await git(['rev-list', '--count', 'HEAD'], gp.dir)).stdout, commitCount, 'no duplicate merge commit');
    assert.equal(getAgentRunRow(runId)!.lifecycleState, 'completed', 'merging → merged → tearing-down → completed');
    assert.equal(existsSync(wt.dir), false, 'teardown completed on convergence');
    assert.equal(getActiveWorktreeByName(wt.branch), null);
    assert.equal(listStrandedWorktrees().length, 0);
  } finally {
    gp.cleanup();
  }
});

test('guard 10: killed after the receipt, before teardown — boot resumes teardown; never classified stranded', async () => {
  freshDb();
  const gp = await newGitProject();
  try {
    const dispatch = dispatchRig();
    const contracts = new ContractService();
    // Crash point: merge done AND landed receipt durable; the worktree
    // directory (and its active row) survived the crash mid-teardown.
    const { runId, contract, wt, tip } = await crashedRepoRun(gp, contracts, {
      status: 'completed',
      lifecycleState: 'tearing-down',
      seal: true,
    });
    assert.ok(contracts.setVerification({ id: contract.id, verificationStatus: 'passed', verificationNotes: 'verified pre-crash' }));
    assert.equal((await git(['merge', '--no-ff', '--no-edit', '-m', `land(code-writer): ${wt.branch}`, wt.branch], gp.dir)).ok, true);
    const mergeSha = (await git(['rev-parse', 'HEAD'], gp.dir)).stdout;
    const receipt = contracts.setLanding({
      id: contract.id,
      landingStatus: 'landed',
      landedBranch: wt.branch,
      landedSha: tip,
      targetShaBefore: wt.baseSha,
      targetShaAfter: mergeSha,
      mergeSha,
      landingAuthorizer: 'auto',
      verifiedBaseSha: wt.baseSha,
      landedAt: Date.now(),
      landingError: null,
    });
    assert.ok(receipt);
    assert.equal(existsSync(wt.dir), true, 'crash left the worktree behind');

    await bootAll(dispatch);

    assert.equal(existsSync(wt.dir), false, 'teardown resumed');
    assert.equal(getActiveWorktreeByName(wt.branch), null, 'row destroyed');
    assert.equal((await git(['rev-parse', '-q', '--verify', wt.branch], gp.dir)).ok, false, 'merged branch deleted after a confirmed land');
    assert.equal(getAgentRunRow(runId)!.lifecycleState, 'completed');
    assert.equal(listStrandedWorktrees().length, 0, 'a landed worktree awaiting teardown never classifies stranded');
    // The receipt is untouched — teardown resume writes nothing to the contract.
    const after = getContract(contract.id as ULID)!;
    assert.equal(after.landedAt, receipt!.landedAt);
    assert.equal(after.landingAuthorizer, 'auto');
    assert.equal(after.version, receipt!.version);
  } finally {
    gp.cleanup();
  }
});

test('guard 10 / guard 7: a re-driven pending landing revalidates the base — advanced target parks stale-base', async () => {
  freshDb();
  const gp = await newGitProject();
  try {
    const dispatch = dispatchRig();
    const contracts = new ContractService();
    // Crash point: landing stamped 'pending' but the merge never ran; another
    // landing advanced the target past this run's verified base meanwhile.
    const { runId, contract, wt, tip } = await crashedRepoRun(gp, contracts, {
      status: 'completed',
      lifecycleState: 'merging',
      seal: true,
    });
    assert.ok(contracts.setVerification({ id: contract.id, verificationStatus: 'passed', verificationNotes: 'verified pre-crash' }));
    contracts.setLanding({ id: contract.id, landingStatus: 'pending', landingAuthorizer: 'auto' });
    const advanced = await commitFile(gp.dir, 'unrelated.txt', 'x\n');

    await bootAll(dispatch);

    // The re-drive went through the FULL guard stack: stale base never lands.
    const row = getContract(contract.id as ULID)!;
    assert.equal(row.landingStatus, 'stale-base');
    assert.match(row.landingError ?? '', /advanced to .+ past the verified base/);
    assert.equal((await git(['rev-parse', 'main'], gp.dir)).stdout, advanced, 'target HEAD unmoved');
    assert.equal((await git(['merge-base', '--is-ancestor', tip, 'main'], gp.dir)).ok, false, 'nothing merged');
    assert.equal(getAgentRunRow(runId)!.lifecycleState, 'conflict', 'the durable stale-base gate');
    assert.equal(existsSync(wt.dir), true, 'worktree preserved for revalidation');
    assert.equal((await git(['rev-parse', wt.branch], gp.dir)).stdout, tip, 'branch preserved');
    // Parked for re-accept (verification passed) — review-parked, not stranded.
    assert.notEqual(getActiveWorktreeByName(wt.branch), null, 'row stays active awaiting the re-accept door');
    assert.equal(listStrandedWorktrees().length, 0);
  } finally {
    gp.cleanup();
  }
});

test('guard 10: killed mid-prep (no seal) — failed loudly, worktree preserved, stranded scan surfaces it', async () => {
  freshDb();
  const gp = await newGitProject();
  try {
    const dispatch = dispatchRig();
    const contracts = new ContractService();
    // Crash point: worktree provisioned, prep still running — no deliverable.
    const { runId, contract, wt, tip } = await crashedRepoRun(gp, contracts, {
      status: 'running',
      lifecycleState: 'preparing',
      seal: false,
    });

    await bootAll(dispatch);

    // No sealed evidence ⇒ the loud restart failure (unchanged route).
    const run = getAgentRunRow(runId)!;
    assert.equal(run.status, 'failed');
    assert.equal(run.failureCause, 'server-restart');
    assert.equal(run.lifecycleState, 'failed');
    assert.equal(getContract(contract.id as ULID)!.verificationStatus, 'pending', 're-dispatchable, not rejected');
    // Work preserved…
    assert.equal(existsSync(wt.dir), true, 'worktree preserved');
    assert.equal((await git(['rev-parse', wt.branch], gp.dir)).stdout, tip, 'branch preserved');
    // …and SURFACED: nothing delivered means no accept⇒land reclaim path, so
    // the runless worktree is durable 'stranded', not silently parked.
    const stranded = listStrandedWorktrees(gp.project.id);
    assert.equal(stranded.length, 1);
    assert.equal(stranded[0].name, wt.branch);
    assert.equal(stranded[0].strandedReason, 'no-live-run');
  } finally {
    gp.cleanup();
  }
});

// ── F3 (comms-hardening): boot-time terminal envelope is queued, not dropped ─

test('F3: a terminal envelope minted before attach is queued, not dropped — replayed once attach() runs', async () => {
  freshDb();
  const gp = await newGitProject();
  try {
    const dispatch = dispatchRig(); // pre-attach, exactly like real boot order
    const contracts = new ContractService();
    // Crash point: deliverable sealed, process died before settlement — same
    // shape as the first guard-10 test above. recoverSealedRuns settles it
    // completed and mints the `[agent-completed]` terminal envelope, but ctx
    // is still null here (attach hasn't run yet) — the old behavior silently
    // dropped that envelope.
    const { runId } = await crashedRepoRun(gp, contracts, {
      status: 'running',
      lifecycleState: 'verifying',
      seal: true,
      landingPolicy: 'auto-merge',
    });

    await dispatch.recoverSealedRuns();
    assert.equal(getAgentRunRow(runId)!.status, 'completed', 'sealed evidence settled the run pre-attach');
    assert.equal(getActiveOrchestratorSession(gp.project.id), null, 'nothing live yet to deliver into');

    // Boot finishes — attach. F3: the queued envelope must replay now.
    const hub = new ProjectWebSocketHub<ULID>();
    const registry = new SessionRegistry({ hub, mintSession: () => new FakeRuntime() });
    dispatch.attach({ registry, hub, serverPort: 1 });

    await until(() => getActiveOrchestratorSession(gp.project.id) !== null);
    const session = getActiveOrchestratorSession(gp.project.id)!;
    await until(() =>
      listConversationEvents(session.id).some(
        (r) => r.kind === 'user' && (r.event as { text: string }).text.includes(`[agent-completed] agent=code-writer runId=${runId}`),
      ),
      5000,
    );
  } finally {
    gp.cleanup();
  }
});
