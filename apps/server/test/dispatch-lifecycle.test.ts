// Slice D — lifecycle-state stamps through the REAL dispatch pipeline
// (docs/worktree-lifecycle.md 'Lifecycle states'):
//  - happy-path auto-land: provisioning → building → verifying → merging →
//    merged → tearing-down → completed (observable subset asserted at gated
//    checkpoints; every observed hop must be map-legal — the @pc/db gateway
//    rejects illegal moves, so reaching 'completed' proves a legal chain)
//  - default-review park: pipeline parks durable 'merge-ready'; reject stamps
//    'review-rejected'; a later accept re-lands to 'completed'
//  - non-repo runs NEVER acquire lifecycle vocabulary (lifecycleState null)
//  - boot recovery is evidence-aware (doc Recovery case 'sealed commit after
//    process loss'): the sweep fails only UNSEALED runs; sealed-deliverable
//    runs are deferred to DispatchService.recoverSealedRuns, which settles
//    them completed and re-fires verification from durable evidence

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ContractService } from '@pc/app-services';
import {
  createContract,
  createProject,
  getAgentRunRow,
  getContract,
  insertAgentRunRow,
  markAgentRunDelivered,
  newId,
  setWorktreeContractId,
} from '@pc/db';
import type { RunLifecycleState, ULID } from '@pc/domain';
import { seedStockAgents } from '../src/agents/seed.ts';
import { AccountRegistry } from '../src/runner/account-env.ts';
import { CLAUDE_RUNTIME_ID } from '../src/runner/claude-adapter.ts';
import { FakeRuntime } from '../src/runner/fake-runtime.ts';
import {
  RuntimeRegistry,
  type AgentRuntimeAdapter,
  type CreateRuntimeSession,
  type ResumeRuntimeSession,
  type RuntimeEvent,
  type RuntimeSession,
} from '../src/runner/runtime.ts';
import { DispatchService } from '../src/dispatch/service.ts';
import { SessionRegistry } from '../src/chat/registry.ts';
import { ProjectWebSocketHub } from '../src/ws/hub.ts';
import { runBootRecovery } from '../src/boot-recovery.ts';
import {
  releaseAllRepositoryLeasesForTesting,
} from '../src/dispatch/repository-lease.ts';
import { provisionWorktree } from '../src/dispatch/worktrees.ts';
import {
  advanceTestAgentRunStatus,
  commitFile,
  freshDb,
  newGitProject,
  testAgentRunExecution,
  testDispatchRuntimeDeps,
  until,
} from './helpers.ts';
import {
  testCapabilities,
  testModelDiscovery,
  testSessionSelectionDeps,
  testSubscriptionQuotaUnavailable,
  withRuntimeReceipt,
} from './runtime-fixtures.ts';

const OK_RESULT: RuntimeEvent = {
  type: 'result',
  ok: true,
  stopReason: 'complete',
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

/** Test-gated adapter: the session opens only after releaseSession(), the one
 *  turn ends only after releaseTurn() — deterministic checkpoints, no timing. */
class GatedAdapter implements AgentRuntimeAdapter {
  readonly id = CLAUDE_RUNTIME_ID;
  private readonly sessionGate = deferred();
  private readonly turnGate = deferred();
  releaseSession(): void {
    this.sessionGate.resolve();
  }
  releaseTurn(): void {
    this.turnGate.resolve();
  }
  async capabilities(accountId: string) { return testCapabilities(this.id, accountId); }
  async observeSubscriptionQuota(accountId: string) {
    return testSubscriptionQuotaUnavailable(this.id, accountId);
  }
  async listModels() { return testModelDiscovery(); }
  private async mint(
    input: CreateRuntimeSession,
    continuation: { mode: 'create' } | { mode: 'resume'; nativeSessionId: string },
  ): Promise<RuntimeSession> {
    await this.sessionGate.promise;
    const gate = this.turnGate.promise;
    const runtime: RuntimeSession = {
      sendTurn: () => turnStream(gate),
      observeContext: async () => ({ confidence: 'unavailable', reason: 'unsupported' }),
      interrupt: async () => {},
      dispose: async () => {},
    };
    return withRuntimeReceipt(() => runtime)({
      projectId: input.projectId,
      appSessionId: input.appSessionId,
      continuationAttemptId: input.continuationAttemptId,
      selection: input.selection,
      continuation,
    });
  }
  createSession(input: CreateRuntimeSession): Promise<RuntimeSession> {
    return this.mint(input, { mode: 'create' });
  }
  resumeSession(input: ResumeRuntimeSession): Promise<RuntimeSession> {
    return this.mint(input, { mode: 'resume', nativeSessionId: input.nativeSessionId });
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
  const accounts = new AccountRegistry();
  const dispatch = new DispatchService({
    ...testDispatchRuntimeDeps(runtimes, accounts),
  });
  const hub = new ProjectWebSocketHub<ULID>();
  const registry = new SessionRegistry({
    hub,
    ...testSessionSelectionDeps(),
    mintSession: withRuntimeReceipt(() => new FakeRuntime()),
  });
  dispatch.attach({ registry, hub, serverPort: 1 });
  return dispatch;
}

/** Records every DISTINCT lifecycleState it sees; polling helpers note() on
 *  each check so transient stamps between checkpoints get a chance to land. */
function observer(runId: ULID) {
  const seen: RunLifecycleState[] = [];
  const note = (): RunLifecycleState | null => {
    const lc = getAgentRunRow(runId)?.lifecycleState ?? null;
    if (lc !== null && seen[seen.length - 1] !== lc) seen.push(lc);
    return lc;
  };
  return { seen, note, untilState: (s: RunLifecycleState) => until(() => note() === s, 20000, 2) };
}

/** Every observed state appears in `expected` order (gaps allowed). */
function assertSubsequence(observed: RunLifecycleState[], expected: RunLifecycleState[]): void {
  let cursor = 0;
  for (const s of observed) {
    const idx = expected.indexOf(s, cursor);
    assert.notEqual(idx, -1, `state '${s}' unexpected/out of order — observed: ${observed.join(' → ')}`);
    cursor = idx;
  }
}

test('happy-path auto-land stamps provisioning → building → verifying → … → completed', async () => {
  freshDb();
  seedStockAgents();
  const gp = await newGitProject();
  try {
    const adapter = new GatedAdapter();
    const dispatch = rig(adapter);
    const result = await dispatch.dispatchFresh({
      projectId: gp.project.id,
      agentName: 'code-writer',
      input: 'do the work',
      dispatcherSessionId: 'S1',
      expectedOutput: { kind: 'repo', auto_land: true, paths_touched: ['feature.txt'] },
    });
    assert.equal(result.ok, true, JSON.stringify(result));
    const runId = (result as { run: { runId: string } }).run.runId as ULID;
    const o = observer(runId);

    // Born post-provision: the session gate holds startRun before 'building'.
    assert.equal(o.note(), 'provisioning');
    const row = getAgentRunRow(runId)!;
    assert.ok(row.worktreeDir, 'worktree provisioned');

    adapter.releaseSession();
    await o.untilState('building');

    // Builder work: one in-scope commit, then the sealed submit.
    await commitFile(row.worktreeDir!, 'feature.txt', 'work\n');
    const submitted = await dispatch.submitDeliverable({
      projectId: gp.project.id,
      agentRunId: runId,
      deliverable: { kind: 'repo' },
      report: 'done',
    });
    assert.equal(submitted.ok, true, JSON.stringify(submitted));
    assert.equal(o.note(), 'verifying', 'sealed deliverable moves the pipeline to verification');

    // Turn ends → settle → verify → auto-land → teardown → completed.
    adapter.releaseTurn();
    await o.untilState('completed');

    const final = getAgentRunRow(runId)!;
    assert.equal(final.status, 'completed', 'dispatch status column untouched by the lifecycle vocabulary');
    const contract = getContract(final.contractId!)!;
    assert.equal(contract.verificationStatus, 'passed');
    assert.equal(contract.landingStatus, 'landed');
    assert.equal(contract.landingAuthorizer, 'auto');
    assert.equal(existsSync(row.worktreeDir!), false, 'worktree torn down');

    // Polling may skip transient hops (merging/merged) — subsequence order +
    // deterministic landmarks are the observable contract; the gateway guard
    // already proves each ACTUAL hop was legal (else 'completed' is unreachable).
    assertSubsequence(o.seen, ['provisioning', 'building', 'verifying', 'merging', 'merged', 'tearing-down', 'completed']);
    for (const landmark of ['provisioning', 'building', 'verifying', 'completed'] as const) {
      assert.ok(o.seen.includes(landmark), `landmark '${landmark}' missing — observed: ${o.seen.join(' → ')}`);
    }
  } finally {
    await gp.cleanup();
  }
});

test('default-review park stamps merge-ready; reject → review-rejected; accept re-lands to completed', async () => {
  freshDb();
  seedStockAgents();
  const gp = await newGitProject();
  try {
    const adapter = new GatedAdapter();
    const dispatch = rig(adapter);
    const result = await dispatch.dispatchFresh({
      projectId: gp.project.id,
      agentName: 'code-writer',
      input: 'do the work',
      dispatcherSessionId: 'S1',
      expectedOutput: { kind: 'repo' }, // no auto_land ⇒ default-review policy
    });
    assert.equal(result.ok, true, JSON.stringify(result));
    const runId = (result as { run: { runId: string } }).run.runId as ULID;
    const o = observer(runId);
    adapter.releaseSession();
    await o.untilState('building');
    const row = getAgentRunRow(runId)!;
    await commitFile(row.worktreeDir!, 'feature.txt', 'work\n');
    const submitted = await dispatch.submitDeliverable({ projectId: gp.project.id, agentRunId: runId, deliverable: { kind: 'repo' }, report: 'done' });
    assert.equal(submitted.ok, true);
    adapter.releaseTurn();

    // Parks durable merge-ready — verified pass, nothing landed.
    await o.untilState('merge-ready');
    const contractId = getAgentRunRow(runId)!.contractId!;
    assert.equal(getContract(contractId)!.verificationStatus, 'passed');
    assert.equal(getContract(contractId)!.landingStatus, null, 'parked, nothing landed');
    assert.equal(getAgentRunRow(runId)!.status, 'completed');

    // Reject door: not necessarily terminal.
    const rejected = await dispatch.reviewContract({ projectId: gp.project.id, contractId, verdict: 'reject', notes: 'needs work' });
    assert.equal(rejected.ok, true);
    assert.equal(o.note(), 'review-rejected');

    // Accept door re-lands (review-rejected → merging is legal).
    const accepted = await dispatch.reviewContract({ projectId: gp.project.id, contractId, verdict: 'accept' });
    assert.equal(accepted.ok, true);
    await o.untilState('completed');
    assert.equal(getContract(contractId)!.landingStatus, 'landed');
    assert.equal(getContract(contractId)!.landingAuthorizer, 'orchestrator');
    assertSubsequence(o.seen, ['provisioning', 'building', 'verifying', 'merge-ready', 'review-rejected', 'merging', 'merged', 'tearing-down', 'completed']);
  } finally {
    await gp.cleanup();
  }
});

test('non-repo runs in an adopted non-Git folder remain supported without lifecycle vocabulary', async () => {
  freshDb();
  seedStockAgents();
  const adapter = new GatedAdapter();
  const dispatch = rig(adapter);
  const projectDir = mkdtempSync(join(tmpdir(), 'pc-sdk-nongit-'));
  const project = createProject({
    name: 'Adopted non-Git',
    slug: `t-${newId().toLowerCase()}`,
    folderPath: projectDir,
  });
  try {
    const result = await dispatch.dispatchFresh({
      projectId: project.id,
      agentName: 'researcher',
      input: 'answer me',
      dispatcherSessionId: 'S1',
      expectedOutput: { kind: 'answer', trust_end_turn: true },
    });
    assert.equal(result.ok, true);
    assert.equal(
      existsSync(join(projectDir, '.git', 'HEAD')),
      true,
      'deferred project Git initialization completes before native runtime admission',
    );
    const runId = (result as { run: { runId: string } }).run.runId as ULID;
    adapter.releaseSession();
    const submitted = await until(() => getAgentRunRow(runId)?.status === 'running' || getAgentRunRow(runId)?.status === 'spawning').then(() =>
      dispatch.submitDeliverable({ projectId: project.id, agentRunId: runId, deliverable: { kind: 'answer', text: '42' } }),
    );
    assert.equal(submitted.ok, true);
    adapter.releaseTurn();
    await until(() => getAgentRunRow(runId)?.status === 'completed', 10000);
    assert.equal(getAgentRunRow(runId)!.lifecycleState, null);
  } finally {
    await dispatch.disposeAll();
    await releaseAllRepositoryLeasesForTesting();
    rmSync(projectDir, { recursive: true, force: true });
  }
});

test('boot recovery: unsealed runs fail; sealed-deliverable runs settle completed + re-verify', async (t) => {
  freshDb();
  const gitProject = await newGitProject('boot-sealed-recovery');
  const project = gitProject.project;
  t.after(async () => {
    try {
      await releaseAllRepositoryLeasesForTesting();
    } finally {
      await gitProject.cleanup();
      assert.equal(existsSync(`${gitProject.dir}-worktrees`), false);
      assert.equal(existsSync(gitProject.dir), false);
    }
  });
  const contracts = new ContractService();

  const mkRun = async (lifecycleState: RunLifecycleState, sealed: boolean): Promise<ULID> => {
    const id = newId() as ULID;
    const provisioned = await provisionWorktree(gitProject.dir, id, {
      projectId: project.id,
    });
    if (!provisioned.ok) throw new Error(provisioned.error);

    const contract = createContract({
      projectId: project.id,
      podName: 'code-writer',
      expectedOutput: { kind: 'repo' },
      acceptanceCriteria: [],
      verificationTier: 'auto',
      worktreePath: provisioned.dir,
      worktreeBaseBranch: provisioned.baseBranch,
      worktreeBaseSha: provisioned.baseSha,
    });
    setWorktreeContractId(provisioned.branch, contract.id);
    if (sealed) {
      const commit = await commitFile(
        provisioned.dir,
        'sealed.txt',
        `sealed evidence for ${id}\n`,
        `seal ${id.slice(-8)}`,
      );
      assert.ok(contracts.setDeliverable({
        id: contract.id,
        deliverable: {
          kind: 'repo',
          branch: provisioned.branch,
          commit,
          baseBranch: provisioned.baseBranch,
          baseCommit: provisioned.baseSha,
        },
      }));
    }
    insertAgentRunRow({
      id,
      projectId: project.id,
      ...testAgentRunExecution('code-writer'),
      dispatcherSessionId: 'S1',
      status: 'queued',
      input: 'go',
      contractId: contract.id,
      worktreeDir: provisioned.dir,
      worktreeBaseBranch: provisioned.baseBranch,
      worktreeBaseSha: provisioned.baseSha,
      gitReceipt: {
        worktreePath: provisioned.dir,
        branch: provisioned.branch,
        baseBranch: provisioned.baseBranch,
        baseSha: provisioned.baseSha,
        cleanStatus: true,
        repositoryIdentity: provisioned.repositoryIdentity,
      },
      lifecycleState,
      queuedAt: Date.now(),
    });
    contracts.setRun(contract.id, id);
    advanceTestAgentRunStatus(id, 'running');
    // Match the real submit flow: the RUN's deliveredAt is stamped in the
    // same motion as the seal — sealed-run recovery keys on it.
    if (sealed) markAgentRunDelivered(id, Date.now());
    return id;
  };

  const unsealed = await mkRun('building', false);
  const sealedBuilding = await mkRun('building', true); // sealed evidence ⇒ verifying
  const sealedVerifying = await mkRun('verifying', true);
  const sealedParked = await mkRun('merge-ready', true);

  runBootRecovery();

  // The sweep fails only the UNSEALED run loudly…
  assert.equal(getAgentRunRow(unsealed)!.status, 'failed');
  assert.equal(getAgentRunRow(unsealed)!.failureCause, 'server-restart');
  assert.equal(getAgentRunRow(unsealed)!.lifecycleState, 'failed');
  // …and defers sealed evidence to the dispatch door (still non-terminal).
  for (const id of [sealedBuilding, sealedVerifying, sealedParked]) {
    assert.equal(getAgentRunRow(id)!.status, 'running', 'sealed run left for recoverSealedRuns');
  }

  // The dispatch door (index.ts boot order, pre-attach) settles them
  // completed-with-deliverable…
  const runtimes = new RuntimeRegistry();
  const accounts = new AccountRegistry();
  const dispatch = new DispatchService({
    ...testDispatchRuntimeDeps(runtimes, accounts),
  });
  await dispatch.recoverSealedRuns();
  for (const id of [sealedBuilding, sealedVerifying, sealedParked]) {
    assert.equal(getAgentRunRow(id)!.status, 'completed');
    assert.equal(getAgentRunRow(id)!.failureCause, null);
  }
  // …with the lifecycle resumed at verification (merge-ready keeps its park)…
  assert.equal(getAgentRunRow(sealedBuilding)!.lifecycleState, 'verifying');
  assert.equal(getAgentRunRow(sealedVerifying)!.lifecycleState, 'verifying');
  assert.equal(getAgentRunRow(sealedParked)!.lifecycleState, 'merge-ready');
  // …and verification RE-FIRED from durable evidence: repo + empty criteria
  // is fail-closed ⇒ escalates to review, never a silent pass.
  for (const id of [sealedBuilding, sealedVerifying, sealedParked]) {
    assert.equal(getContract(getAgentRunRow(id)!.contractId!)!.verificationStatus, 'pending');
  }
});
