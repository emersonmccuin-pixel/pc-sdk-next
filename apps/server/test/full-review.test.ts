// Full independent review — the 'full-review' landing policy
// (docs/worktree-lifecycle.md 'Full independent review' :175-187, guard 4):
//  - a full-review contract does NOT auto-land (or park merge-ready) on a
//    verified pass — PC-SDK dispatches a review specialist against the SEALED
//    commit, in the target worktree, with the durable round + reviewRunId
//    markers stamped BEFORE the agent starts
//  - approve ⇒ verification stays passed, landing proceeds through the normal
//    guarded path with authorizer 'reviewer' + the full merge receipt
//  - reject ⇒ contract verification 'failed' with the structured findings
//    (JSON in verificationNotes) + lifecycle 'review-rejected'; a Fix
//    continuation reseals a NEW checkpoint (guard 4) that re-enters
//    verification then review (round 2)
//  - the bounded loop: rounds exhausted ⇒ verification 'failed' with the
//    'review rounds exhausted' park — the pc_review_contract door still works
//  - crash safety (kill-recovery style): a reviewer that died leaves the
//    contract re-dispatchable — boot re-entry dispatches the next round,
//    never a wedge

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { basename } from 'node:path';
import { getAgentRunRow, getContract, listContractsForProject, newId, setContractDeliverable } from '@pc/db';
import type { ULID } from '@pc/domain';
import { seedStockAgents } from '../src/agents/seed.ts';
import { AccountRegistry } from '../src/runner/account-env.ts';
import { CLAUDE_RUNTIME_ID } from '../src/runner/claude-adapter.ts';
import { FakeRuntime } from '../src/runner/fake-runtime.ts';
import {
  RuntimeRegistry,
  type AgentRuntimeAdapter,
  type CreateRuntimeSession,
  type RuntimeEvent,
  type RuntimeSession,
} from '../src/runner/runtime.ts';
import { DispatchService } from '../src/dispatch/service.ts';
import { SessionRegistry } from '../src/chat/registry.ts';
import { ProjectWebSocketHub } from '../src/ws/hub.ts';
import { runBootRecovery } from '../src/boot-recovery.ts';
import type { McpManager } from '../src/mcp/manager.ts';
import { git } from '../src/dispatch/worktrees.ts';
import { commitFile, freshDb, newGitProject, until } from './helpers.ts';

const OK_RESULT: RuntimeEvent = {
  type: 'result',
  ok: true,
  subtype: 'success',
  stopReason: 'end_turn',
  usage: null,
  durationMs: 1,
  error: null,
  outcome: 'ok',
  numTurns: null,
};

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => (resolve = r));
  return { promise, resolve };
}

/** Multi-session gated adapter: sessions open instantly (indexed in creation
 *  order — builder 0, reviewer 1, fix 2, …); each session's ONE turn hangs
 *  until releaseTurn(i). First messages are captured for brief assertions. */
class QueueAdapter implements AgentRuntimeAdapter {
  readonly id = CLAUDE_RUNTIME_ID;
  readonly created: CreateRuntimeSession[] = [];
  readonly turnInputs: string[] = [];
  private readonly gates: Array<ReturnType<typeof deferred>> = [];

  private gate(i: number): ReturnType<typeof deferred> {
    while (this.gates.length <= i) this.gates.push(deferred());
    return this.gates[i]!;
  }

  releaseTurn(i: number): void {
    this.gate(i).resolve();
  }

  async createSession(input: CreateRuntimeSession): Promise<RuntimeSession> {
    const idx = this.created.length;
    this.created.push(input);
    const gate = this.gate(idx).promise;
    return {
      sendTurn: (message: string) => {
        this.turnInputs[idx] = message;
        return turnStream(gate);
      },
      interrupt: async () => {},
      dispose: async () => {},
    };
  }

  resumeSession(input: CreateRuntimeSession): Promise<RuntimeSession> {
    return this.createSession(input);
  }
}

async function* turnStream(gate: Promise<void>): AsyncGenerator<RuntimeEvent> {
  yield { type: 'system', subtype: 'x', level: 'info', message: 'working…' };
  await gate;
  yield OK_RESULT;
}

function rig(adapter: AgentRuntimeAdapter): DispatchService {
  const runtimes = new RuntimeRegistry();
  runtimes.register(adapter);
  const dispatch = new DispatchService({ runtimes, accounts: new AccountRegistry(), mcp: {} as McpManager });
  const hub = new ProjectWebSocketHub<ULID>();
  const registry = new SessionRegistry({ hub, mintSession: () => new FakeRuntime() });
  dispatch.attach({ registry, hub, serverPort: 1 });
  return dispatch;
}

const FULL_REVIEW_SPEC = { kind: 'repo' as const, review: 'full' as const, paths_touched: ['feature.txt'] };

/** Dispatch a full-review builder, do one in-scope commit, seal, end the turn
 *  (session index `sessionIdx`), and wait for the review round to dispatch. */
async function buildAndSeal(
  dispatch: DispatchService,
  adapter: QueueAdapter,
  projectId: ULID,
  sessionIdx: number,
): Promise<{ builderRunId: ULID; contractId: ULID; worktreeDir: string; sealedCommit: string }> {
  const result = await dispatch.dispatchFresh({
    projectId,
    agentName: 'code-writer',
    input: 'do the work',
    dispatcherSessionId: 'S1',
    expectedOutput: FULL_REVIEW_SPEC,
  });
  assert.equal(result.ok, true, JSON.stringify(result));
  const builderRunId = (result as { run: { runId: string } }).run.runId as ULID;
  await until(() => getAgentRunRow(builderRunId)?.lifecycleState === 'building', 20000);
  const row = getAgentRunRow(builderRunId)!;
  const worktreeDir = row.worktreeDir!;
  const sealedCommit = await commitFile(worktreeDir, 'feature.txt', `work-${sessionIdx}\n`);
  const submitted = await dispatch.submitDeliverable({
    projectId,
    agentRunId: builderRunId,
    deliverable: { kind: 'repo' },
    report: 'done',
  });
  assert.equal(submitted.ok, true, JSON.stringify(submitted));
  adapter.releaseTurn(sessionIdx);
  const contractId = row.contractId!;
  await until(() => getContract(contractId)?.reviewRunId !== null, 20000);
  return { builderRunId, contractId, worktreeDir, sealedCommit };
}

/** Reseal from a Fix continuation: continue the parent run, commit a new
 *  checkpoint in the SAME worktree, submit, end the turn. */
async function fixAndReseal(
  dispatch: DispatchService,
  adapter: QueueAdapter,
  projectId: ULID,
  parentRunId: ULID,
  worktreeDir: string,
  sessionIdx: number,
): Promise<{ fixRunId: ULID; newCommit: string }> {
  const cont = await dispatch.dispatchContinue({
    projectId,
    runId: parentRunId,
    input: 'fix the findings',
    dispatcherSessionId: 'S1',
  });
  assert.equal(cont.ok, true, JSON.stringify(cont));
  const fixRunId = (cont as { run: { runId: string } }).run.runId as ULID;
  await until(() => getAgentRunRow(fixRunId)?.lifecycleState === 'building', 20000);
  const newCommit = await commitFile(worktreeDir, 'feature.txt', `fixed-${sessionIdx}\n`);
  const submitted = await dispatch.submitDeliverable({
    projectId,
    agentRunId: fixRunId,
    deliverable: { kind: 'repo' },
    report: 'fixed',
  });
  assert.equal(submitted.ok, true, JSON.stringify(submitted));
  adapter.releaseTurn(sessionIdx);
  return { fixRunId, newCommit };
}

/** Submit the reviewer's verdict payload and end its turn. */
async function deliverVerdict(
  dispatch: DispatchService,
  adapter: QueueAdapter,
  projectId: ULID,
  reviewRunId: ULID,
  sessionIdx: number,
  data: unknown,
): Promise<void> {
  const submitted = await dispatch.submitDeliverable({
    projectId,
    agentRunId: reviewRunId,
    deliverable: { kind: 'payload', data } as never,
    report: 'verdict delivered',
  });
  assert.equal(submitted.ok, true, JSON.stringify(submitted));
  adapter.releaseTurn(sessionIdx);
}

test('full-review pass does NOT land or park merge-ready — a reviewer is dispatched against the sealed commit; approve lands with authorizer reviewer', async () => {
  freshDb();
  seedStockAgents();
  const gp = await newGitProject();
  try {
    const adapter = new QueueAdapter();
    const dispatch = rig(adapter);
    const { builderRunId, contractId, worktreeDir, sealedCommit } = await buildAndSeal(
      dispatch,
      adapter,
      gp.project.id,
      0,
    );

    // Policy stamped at creation from the ORCHESTRATOR-authored spec.
    const parked = getContract(contractId)!;
    assert.equal(parked.landingPolicy, 'full-review');
    // Verified pass, but NOTHING landed and no merge-ready park — review gate.
    assert.equal(parked.verificationStatus, 'passed');
    assert.equal(parked.landingStatus, null, 'never lands on the pass alone');
    assert.equal(parked.reviewRound, 1, 'round counter incremented at dispatch');
    assert.ok(parked.reviewRunId, 'durable in-flight review marker');
    assert.equal(
      (await git(['merge-base', '--is-ancestor', sealedCommit, 'main'], gp.dir)).ok,
      false,
      'nothing merged',
    );
    assert.equal(getAgentRunRow(builderRunId)!.lifecycleState, 'reviewing');

    // The reviewer run: contract-reviewer pod, a DISPOSABLE detached checkout
    // of the sealed commit as cwd (never the builder's live worktree — a
    // reviewer side effect must not move the branch tip or dirty the tree the
    // Fix door resubmits from), and a brief tied to the contract + SEALED
    // commit (guard 4).
    const reviewRunId = parked.reviewRunId as ULID;
    assert.equal(parked.reviewSealedCommit, sealedCommit, 'briefed seal rides the durable marker');
    const reviewRun = getAgentRunRow(reviewRunId)!;
    assert.equal(reviewRun.podName, 'contract-reviewer');
    const reviewCheckout = reviewRun.worktreeDir!;
    assert.notEqual(reviewCheckout, worktreeDir, 'reviewer never runs in the builder worktree');
    assert.match(basename(reviewCheckout), /^review-/);
    assert.equal(
      (await git(['rev-parse', 'HEAD'], reviewCheckout)).stdout,
      sealedCommit,
      'checkout sits detached at the sealed commit',
    );
    assert.equal(reviewRun.lifecycleState, null, 'payload-kind review run has no lifecycle vocabulary');
    assert.equal(adapter.created[1]!.cwd, reviewCheckout, 'reviewer cwd is its own review checkout');
    assert.match(adapter.created[1]!.instructions ?? '', /READ-ONLY|read-only/i);
    assert.match(adapter.turnInputs[1] ?? '', new RegExp(sealedCommit));
    assert.match(adapter.turnInputs[1] ?? '', new RegExp(contractId));

    // Approve ⇒ verification stays passed; landing proceeds per the normal
    // guarded path with the full merge receipt, authorizer 'reviewer'.
    await deliverVerdict(dispatch, adapter, gp.project.id, reviewRunId, 1, {
      verdict: 'approve',
      findings: [],
    });
    await until(() => getContract(contractId)?.landingStatus === 'landed', 20000);
    const landed = getContract(contractId)!;
    assert.equal(landed.verificationStatus, 'passed');
    assert.equal(landed.landingAuthorizer, 'reviewer');
    assert.equal(landed.landedSha, sealedCommit);
    assert.ok(landed.mergeSha, 'merge receipt recorded');
    assert.equal(landed.reviewRunId, null, 'marker cleared on verdict');
    assert.equal(landed.reviewSealedCommit, null, 'briefed seal cleared with the marker');
    assert.equal(
      (await git(['merge-base', '--is-ancestor', sealedCommit, 'main'], gp.dir)).ok,
      true,
      'branch really merged',
    );
    await until(() => getAgentRunRow(builderRunId)?.lifecycleState === 'completed', 20000);
    assert.equal(existsSync(worktreeDir), false, 'worktree torn down after the landed receipt');
    await until(() => !existsSync(reviewCheckout), 20000);
  } finally {
    gp.cleanup();
  }
});

test('reject stamps review-rejected + structured findings; a Fix continuation reseals and re-enters review; the round cap parks for the orchestrator', async () => {
  freshDb();
  seedStockAgents();
  const gp = await newGitProject();
  try {
    const adapter = new QueueAdapter();
    const dispatch = rig(adapter);
    const { builderRunId, contractId, worktreeDir, sealedCommit } = await buildAndSeal(
      dispatch,
      adapter,
      gp.project.id,
      0,
    );

    // Round 1 reject with findings tied to the sealed commit.
    const round1ReviewId = getContract(contractId)!.reviewRunId as ULID;
    const findings = [{ file: 'feature.txt', line: 1, summary: 'does not meet the spec', severity: 'major' }];
    await deliverVerdict(dispatch, adapter, gp.project.id, round1ReviewId, 1, { verdict: 'reject', findings });
    await until(() => getContract(contractId)?.verificationStatus === 'failed', 20000);
    const rejected = getContract(contractId)!;
    assert.equal(rejected.landingStatus, null, 'nothing landed');
    assert.equal(rejected.reviewRunId, null, 'marker cleared');
    assert.equal(rejected.reviewRound, 1);
    const parsedNotes = JSON.parse(rejected.verificationNotes ?? '{}') as {
      independentReview?: { verdict?: string; findings?: unknown[]; sealedCommit?: string; reviewRunId?: string };
    };
    assert.equal(parsedNotes.independentReview?.verdict, 'reject');
    assert.deepEqual(parsedNotes.independentReview?.findings, findings);
    assert.equal(parsedNotes.independentReview?.sealedCommit, sealedCommit, 'findings tied to the sealed commit');
    assert.equal(parsedNotes.independentReview?.reviewRunId, round1ReviewId);
    assert.equal(getAgentRunRow(builderRunId)!.lifecycleState, 'review-rejected');
    assert.equal(existsSync(worktreeDir), true, 'worktree preserved for the Fix phase');

    // Fix continuation: a NEW sealed checkpoint (guard 4) re-enters
    // verification, then review round 2.
    const { newCommit } = await fixAndReseal(dispatch, adapter, gp.project.id, builderRunId, worktreeDir, 2);
    await until(() => getContract(contractId)?.reviewRunId !== null, 20000);
    const round2 = getContract(contractId)!;
    assert.equal(round2.verificationStatus, 'passed', 'fix checkpoint re-verified');
    assert.equal(round2.reviewRound, 2);
    assert.equal((round2.deliverable as { commit?: string }).commit, newCommit, 'review consumes the NEW seal');
    assert.notEqual(newCommit, sealedCommit, 'Fix created a new checkpoint');
    assert.match(adapter.turnInputs[3] ?? '', /round 2/);
    assert.match(adapter.turnInputs[3] ?? '', new RegExp(newCommit));

    // Round 2 reject, then a second fix: rounds exhausted ⇒ parked loudly for
    // the orchestrator/user instead of looping (doc :186-187).
    const round2ReviewId = round2.reviewRunId as ULID;
    await deliverVerdict(dispatch, adapter, gp.project.id, round2ReviewId, 3, { verdict: 'reject', findings });
    await until(() => getContract(contractId)?.verificationStatus === 'failed', 20000);
    const { fixRunId } = await fixAndReseal(dispatch, adapter, gp.project.id, builderRunId, worktreeDir, 4);
    await until(() => /review rounds exhausted/.test(getContract(contractId)?.verificationNotes ?? ''), 20000);
    const exhausted = getContract(contractId)!;
    assert.equal(exhausted.verificationStatus, 'failed', 'exhausted park is a verification failure');
    assert.equal(exhausted.reviewRound, 2, 'no third round dispatched');
    assert.equal(exhausted.reviewRunId, null);
    assert.equal(exhausted.landingStatus, null);
    assert.equal(
      listContractsForProject(gp.project.id).filter((c) => c.podName === 'contract-reviewer').length,
      2,
      'exactly two reviewer contracts ever minted',
    );
    await until(() => getAgentRunRow(fixRunId)?.lifecycleState === 'review-rejected', 20000);

    // The human override still works: orchestrator accept lands the park.
    const accepted = await dispatch.reviewContract({
      projectId: gp.project.id,
      contractId,
      verdict: 'accept',
      notes: 'reviewed by hand after the exhausted park',
    });
    assert.equal(accepted.ok, true, JSON.stringify(accepted));
    assert.equal(getContract(contractId)!.landingStatus, 'landed');
    assert.equal(getContract(contractId)!.landingAuthorizer, 'orchestrator');
    // Resolution door (docs 'until resolved'): landing + reclaim resolves the
    // EARLIER preserved parks of this contract too — the builder's round-1
    // review-rejected row leaves the preserved feed instead of sitting there
    // forever after the work actually landed.
    assert.equal(getAgentRunRow(builderRunId)!.lifecycleState, 'completed');
    assert.equal(getAgentRunRow(fixRunId)!.lifecycleState, 'completed');
  } finally {
    gp.cleanup();
  }
});

test('crashed reviewer (kill-recovery style): boot fails the run loudly and review re-entry re-dispatches — the contract is never wedged', async () => {
  freshDb();
  seedStockAgents();
  const gp = await newGitProject();
  try {
    const adapter = new QueueAdapter();
    const dispatch = rig(adapter);
    const { builderRunId, contractId, worktreeDir, sealedCommit } = await buildAndSeal(
      dispatch,
      adapter,
      gp.project.id,
      0,
    );
    const crashedReviewId = getContract(contractId)!.reviewRunId as ULID;
    assert.equal(getAgentRunRow(crashedReviewId)!.status !== 'completed', true, 'review in flight');

    // "Crash": the process dies with the reviewer mid-turn. Boot sweep — the
    // reviewer never sealed, so it fails loudly like any crashed run.
    runBootRecovery();
    const crashed = getAgentRunRow(crashedReviewId)!;
    assert.equal(crashed.status, 'failed');
    assert.equal(crashed.failureCause, 'server-restart');
    // Target contract state survived: passed, unlanded, marker at a dead run.
    const stale = getContract(contractId)!;
    assert.equal(stale.verificationStatus, 'passed');
    assert.equal(stale.landingStatus, null);
    assert.equal(stale.reviewRunId, crashedReviewId, 'durable marker points at the dead reviewer');

    // Boot re-entry (index.ts step 6, post-attach) re-dispatches — round 2.
    const adapter2 = new QueueAdapter();
    const dispatch2 = rig(adapter2);
    await dispatch2.recoverPendingReviews();
    const redispatched = getContract(contractId)!;
    assert.equal(redispatched.reviewRound, 2, 'a crash burns a round — bounded, never an endless loop');
    assert.ok(redispatched.reviewRunId, 're-dispatched');
    assert.notEqual(redispatched.reviewRunId, crashedReviewId);
    const newReview = getAgentRunRow(redispatched.reviewRunId as ULID)!;
    assert.equal(newReview.podName, 'contract-reviewer');
    assert.notEqual(newReview.worktreeDir, worktreeDir, 'round 2 reviews from its own checkout too');
    assert.match(basename(newReview.worktreeDir!), /^review-/);

    // The recovered round works end-to-end: approve lands the sealed commit.
    await deliverVerdict(dispatch2, adapter2, gp.project.id, redispatched.reviewRunId as ULID, 0, {
      verdict: 'approve',
      findings: [],
    });
    await until(() => getContract(contractId)?.landingStatus === 'landed', 20000);
    assert.equal(getContract(contractId)!.landingAuthorizer, 'reviewer');
    assert.equal(getContract(contractId)!.landedSha, sealedCommit);
    await until(() => getAgentRunRow(builderRunId)?.lifecycleState === 'completed', 20000);
  } finally {
    gp.cleanup();
  }
});

test('a garbage verdict payload never lands or rejects — it re-enters the gate like a crash', async () => {
  freshDb();
  seedStockAgents();
  const gp = await newGitProject();
  try {
    const adapter = new QueueAdapter();
    const dispatch = rig(adapter);
    const { contractId } = await buildAndSeal(dispatch, adapter, gp.project.id, 0);
    const round1ReviewId = getContract(contractId)!.reviewRunId as ULID;

    // Schema-invalid payload: fails the reviewer's own contract, so there is
    // no usable verdict — round 2 dispatches instead of a false verdict.
    await deliverVerdict(dispatch, adapter, gp.project.id, round1ReviewId, 1, {
      verdict: 'ship it',
      findings: 'looks fine',
    });
    await until(() => getContract(contractId)?.reviewRound === 2, 20000);
    const c = getContract(contractId)!;
    assert.equal(c.verificationStatus, 'passed', 'target verification untouched by the garbage verdict');
    assert.equal(c.landingStatus, null, 'nothing landed');
    assert.ok(c.reviewRunId, 'round 2 in flight');
    assert.notEqual(c.reviewRunId, round1ReviewId);
  } finally {
    gp.cleanup();
  }
});

test('killed reviewer re-enters the gate immediately (no reboot needed)', async () => {
  freshDb();
  seedStockAgents();
  const gp = await newGitProject();
  try {
    const adapter = new QueueAdapter();
    const dispatch = rig(adapter);
    const { contractId } = await buildAndSeal(dispatch, adapter, gp.project.id, 0);
    const round1ReviewId = getContract(contractId)!.reviewRunId as ULID;

    const killed = await dispatch.killRun(gp.project.id, round1ReviewId);
    assert.equal(killed.ok, true);
    await until(() => getContract(contractId)?.reviewRound === 2, 20000);
    const c = getContract(contractId)!;
    assert.equal(c.verificationStatus, 'passed');
    assert.ok(c.reviewRunId, 'next round dispatched');
    assert.notEqual(c.reviewRunId, round1ReviewId);
  } finally {
    gp.cleanup();
  }
});

test('review dispatch refusal fails closed: no contract-reviewer pod ⇒ parked merge-ready for the orchestrator', async () => {
  freshDb();
  // Stock agents deliberately NOT seeded: a custom builder dispatches with an
  // inline spec, so 'contract-reviewer' is absent when the review gate fires.
  const { createAgent, addAgentToProject } = await import('@pc/db');
  const project = await newGitProject();
  try {
    const custom = createAgent(
      { name: 'my-builder', scope: 'global', prompt: 'You build.', shareable: true },
      { actor: 'user' as const },
    );
    addAgentToProject(custom.id, project.project.id, { actor: 'user' as const });
    const adapter = new QueueAdapter();
    const dispatch = rig(adapter);
    const result = await dispatch.dispatchFresh({
      projectId: project.project.id,
      agentName: 'my-builder',
      input: 'go',
      dispatcherSessionId: 'S1',
      expectedOutput: FULL_REVIEW_SPEC,
    });
    assert.equal(result.ok, true, JSON.stringify(result));
    const runId = (result as { run: { runId: string } }).run.runId as ULID;
    await until(() => getAgentRunRow(runId)?.lifecycleState === 'building', 20000);
    const row = getAgentRunRow(runId)!;
    await commitFile(row.worktreeDir!, 'feature.txt', 'work\n');
    const submitted = await dispatch.submitDeliverable({
      projectId: project.project.id,
      agentRunId: runId,
      deliverable: { kind: 'repo' },
      report: 'done',
    });
    assert.equal(submitted.ok, true);
    adapter.releaseTurn(0);
    await until(() => /independent review not dispatchable/.test(getContract(row.contractId!)?.verificationNotes ?? ''), 20000);
    const c = getContract(row.contractId!)!;
    assert.equal(c.verificationStatus, 'passed');
    assert.equal(c.landingStatus, null, 'parked, not landed');
    assert.equal(c.reviewRunId, null, 'no phantom review run');
    // The orchestrator door reclaims the park.
    const accepted = await dispatch.reviewContract({ projectId: project.project.id, contractId: c.id, verdict: 'accept' });
    assert.equal(accepted.ok, true);
    assert.equal(getContract(c.id)!.landingStatus, 'landed');
  } finally {
    project.cleanup();
  }
});

test('the seal is locked: terminal-run resubmission and mid-review continuation are refused', async () => {
  freshDb();
  seedStockAgents();
  const gp = await newGitProject();
  try {
    const adapter = new QueueAdapter();
    const dispatch = rig(adapter);
    const { builderRunId, contractId, worktreeDir } = await buildAndSeal(dispatch, adapter, gp.project.id, 0);
    assert.ok(getContract(contractId)!.reviewRunId, 'review in flight');

    // A leftover builder process resubmitting after settlement: refused —
    // the run is terminal, so nothing would ever re-verify the new seal.
    await commitFile(worktreeDir, 'feature.txt', 'sneaky-reseal\n');
    const resubmit = await dispatch.submitDeliverable({
      projectId: gp.project.id,
      agentRunId: builderRunId,
      deliverable: { kind: 'repo' },
    });
    assert.equal(resubmit.ok, false);
    assert.equal((resubmit as { httpStatus: number }).httpStatus, 409);
    assert.match((resubmit as { message: string }).message, /continuation/);

    // A continuation while the reviewer is LIVE: refused — it would mutate
    // the tree under review and reseal mid-review.
    const cont = await dispatch.dispatchContinue({
      projectId: gp.project.id,
      runId: builderRunId,
      input: 'tweak it',
      dispatcherSessionId: 'S1',
    });
    assert.equal(cont.ok, false);
    assert.equal((cont as { cause: string }).cause, 'concurrent-continuation');

    // The sealed deliverable never moved off the briefed seal.
    const c = getContract(contractId)!;
    assert.equal((c.deliverable as { commit?: string }).commit, c.reviewSealedCommit);
  } finally {
    gp.cleanup();
  }
});

test('a mid-review reseal voids an approve verdict — the never-reviewed commit does not land', async () => {
  freshDb();
  seedStockAgents();
  const gp = await newGitProject();
  try {
    const adapter = new QueueAdapter();
    const dispatch = rig(adapter);
    const { contractId, worktreeDir } = await buildAndSeal(dispatch, adapter, gp.project.id, 0);
    const round1ReviewId = getContract(contractId)!.reviewRunId as ULID;

    // Defense in depth: the submit/continue doors refuse a mid-review reseal,
    // so move the seal directly (what a bug or bypass would do).
    const swapped = await commitFile(worktreeDir, 'feature.txt', 'swapped-after-brief\n');
    setContractDeliverable(contractId, { deliverable: { kind: 'repo', commit: swapped } as never });

    await deliverVerdict(dispatch, adapter, gp.project.id, round1ReviewId, 1, { verdict: 'approve', findings: [] });
    await until(() => getContract(contractId)?.reviewRound === 2, 20000);
    const c = getContract(contractId)!;
    assert.equal(c.landingStatus, null, 'the swapped commit never lands under the stale approval');
    assert.ok(c.reviewRunId, 'gate re-entered — a fresh round reviews the new seal');
    assert.notEqual(c.reviewRunId, round1ReviewId);
    assert.equal(c.reviewSealedCommit, swapped, 'round 2 is briefed on the new seal');
  } finally {
    gp.cleanup();
  }
});

test('orchestrator override kills the live reviewer: no verdict race, no burned wall clock, checkout reclaimed', async () => {
  freshDb();
  seedStockAgents();
  const gp = await newGitProject();
  try {
    const adapter = new QueueAdapter();
    const dispatch = rig(adapter);
    const { builderRunId, contractId, worktreeDir, sealedCommit } = await buildAndSeal(
      dispatch,
      adapter,
      gp.project.id,
      0,
    );
    const reviewRunId = getContract(contractId)!.reviewRunId as ULID;
    const reviewCheckout = getAgentRunRow(reviewRunId)!.worktreeDir!;

    const accepted = await dispatch.reviewContract({
      projectId: gp.project.id,
      contractId,
      verdict: 'accept',
      notes: 'human override during the live review',
    });
    assert.equal(accepted.ok, true, JSON.stringify(accepted));
    const c = getContract(contractId)!;
    assert.equal(c.landingStatus, 'landed');
    assert.equal(c.landingAuthorizer, 'orchestrator');
    assert.equal(c.reviewRunId, null, 'marker cleared');
    assert.equal(getAgentRunRow(reviewRunId)!.status, 'cancelled', 'live reviewer killed, not left to the wall clock');
    assert.equal(c.reviewRound, 1, 'the override kill never re-dispatches another round');
    assert.equal(
      (await git(['merge-base', '--is-ancestor', sealedCommit, 'main'], gp.dir)).ok,
      true,
      'sealed work landed under the orchestrator authorizer',
    );
    await until(() => !existsSync(worktreeDir), 20000);
    await until(() => !existsSync(reviewCheckout), 20000);
    await until(() => getAgentRunRow(builderRunId)?.lifecycleState === 'completed', 20000);
  } finally {
    gp.cleanup();
  }
});
