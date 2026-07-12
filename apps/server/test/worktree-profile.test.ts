// Slice E1 — WorktreeProfile + Prepare/Readiness receipts (guard 2,
// docs/worktree-lifecycle.md 'Provisioning and readiness') through the REAL
// dispatch pipeline on real temp git repos:
//  - passing setup+readiness → git/preparation/readiness receipts persisted,
//    lifecycle passes preparing/ready, run lands + cleanup commands run
//    best-effort on teardown (a failing cleanup step never blocks removal)
//  - failing setup → typed worktree-provision-failed with the receipt
//    persisted, lifecycle 'provisioning-failed', worktree PRESERVED
//  - dirty initial status (smudge filter) → provisioning refuses
//  - profile baseBranch overrides the main/master probe
//  - continuation re-runs readiness (receipt on the NEW row)
// Empty-profile behavior is proven by the untouched existing suites.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { getAgentRunRow, getContract, newId, updateProjectWorktreeProfile } from '@pc/db';
import type { RunLifecycleState, ULID } from '@pc/domain';
import { seedStockAgents } from '../src/agents/seed.ts';
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
import { git, provisionWorktree, worktreesRoot } from '../src/dispatch/worktrees.ts';
import { SessionRegistry } from '../src/chat/registry.ts';
import { ProjectWebSocketHub } from '../src/ws/hub.ts';
import { commitFile, freshDb, newGitProject, testDispatchRuntimeDeps, until } from './helpers.ts';
import {
  testCapabilities,
  testModelDiscovery,
  testSessionSelectionDeps,
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

const NODE_OK = (tag: string) => `node -e "console.log('${tag}')"`;
const NODE_FAIL = (code: number) => `node -e "process.exit(${code})"`;

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => (resolve = r));
  return { promise, resolve };
}

/** Test-gated adapter (same rig as dispatch-lifecycle.test.ts): sessions open
 *  only after releaseSession(), each turn ends only after releaseTurn(). */
class GatedAdapter implements AgentRuntimeAdapter {
  readonly id = CLAUDE_RUNTIME_ID;
  private sessionGate = deferred();
  private turnGate = deferred();
  releaseSession(): void {
    this.sessionGate.resolve();
  }
  releaseTurn(): void {
    this.turnGate.resolve();
  }
  /** Re-arm both gates (for a continuation session in the same test). */
  rearm(): void {
    this.sessionGate = deferred();
    this.turnGate = deferred();
  }
  async capabilities(accountId: string) { return testCapabilities(this.id, accountId); }
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
  const dispatch = new DispatchService({
    ...testDispatchRuntimeDeps(runtimes),
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

function observer(runId: ULID) {
  const seen: RunLifecycleState[] = [];
  const note = (): RunLifecycleState | null => {
    const lc = getAgentRunRow(runId)?.lifecycleState ?? null;
    if (lc !== null && seen[seen.length - 1] !== lc) seen.push(lc);
    return lc;
  };
  return { seen, note, untilState: (s: RunLifecycleState) => until(() => note() === s, 20000, 2) };
}

test('passing setup+readiness lands receipts, reaches completed; cleanup runs best-effort on teardown', async () => {
  freshDb();
  seedStockAgents();
  const gp = await newGitProject();
  try {
    const markerPath = join(worktreesRoot(gp.dir), 'cleanup-marker.txt');
    assert.ok(
      updateProjectWorktreeProfile(gp.project.id, {
        setupCommands: [NODE_OK('setup-ok')],
        readinessCommands: [NODE_OK('ready-ok')],
        // Marker proves cleanup ran; the failing step AFTER it proves a
        // cleanup failure never blocks removal (best-effort).
        cleanupCommands: [
          `node -e "require('fs').writeFileSync(require('path').join('..','cleanup-marker.txt'),'x')"`,
          NODE_FAIL(1),
        ],
      }),
    );
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

    // Session gate holds startRun — 'ready' is the durable post-prep park.
    await o.untilState('ready');
    assert.ok(o.seen.includes('preparing'), `preparing observed — saw: ${o.seen.join(' → ')}`);

    const row = getAgentRunRow(runId)!;
    assert.ok(row.worktreeDir, 'worktree provisioned');
    // Git receipt (doc :101-102): identity + positive clean status.
    assert.deepEqual(row.gitReceipt, {
      worktreePath: row.worktreeDir,
      branch: row.worktreeDir!.split(/[\\/]/).pop(),
      baseBranch: 'main',
      baseSha: row.worktreeBaseSha,
      cleanStatus: true,
    });
    // Preparation + readiness receipts: per-step exit/duration/output tails.
    assert.equal(row.preparationReceipt?.ok, true);
    assert.equal(row.preparationReceipt?.steps.length, 1);
    assert.equal(row.preparationReceipt?.steps[0]?.exitCode, 0);
    assert.match(row.preparationReceipt?.steps[0]?.stdoutTail ?? '', /setup-ok/);
    assert.equal(row.readinessReceipt?.ok, true);
    assert.match(row.readinessReceipt?.steps[0]?.stdoutTail ?? '', /ready-ok/);

    adapter.releaseSession();
    await o.untilState('building');
    await commitFile(row.worktreeDir!, 'feature.txt', 'work\n');
    const submitted = await dispatch.submitDeliverable({
      projectId: gp.project.id,
      agentRunId: runId,
      deliverable: { kind: 'repo' },
      report: 'done',
    });
    assert.equal(submitted.ok, true, JSON.stringify(submitted));
    adapter.releaseTurn();
    await o.untilState('completed');

    assert.equal(getContract(getAgentRunRow(runId)!.contractId!)!.landingStatus, 'landed');
    assert.equal(existsSync(row.worktreeDir!), false, 'worktree torn down despite the failing cleanup step');
    assert.ok(existsSync(markerPath), 'cleanup command ran before removal');
    // 'provisioning' is transient here (prep starts immediately, no gate) —
    // the deterministic landmarks are the gated/durable ones.
    assert.ok(
      ['preparing', 'ready', 'building', 'verifying', 'completed'].every((s) =>
        o.seen.includes(s as RunLifecycleState),
      ),
      `landmarks — saw: ${o.seen.join(' → ')}`,
    );
  } finally {
    gp.cleanup();
  }
});

test('failing setup → worktree-provision-failed with receipt, provisioning-failed lifecycle, worktree PRESERVED', async () => {
  freshDb();
  seedStockAgents();
  const gp = await newGitProject();
  try {
    assert.ok(
      updateProjectWorktreeProfile(gp.project.id, {
        setupCommands: [NODE_OK('first-ok'), NODE_FAIL(3), NODE_OK('never-runs')],
        readinessCommands: [NODE_OK('never-runs')],
        cleanupCommands: [],
      }),
    );
    const adapter = new GatedAdapter();
    const dispatch = rig(adapter);
    const result = await dispatch.dispatchFresh({
      projectId: gp.project.id,
      agentName: 'code-writer',
      input: 'doomed',
      dispatcherSessionId: 'S1',
      expectedOutput: { kind: 'repo' },
    });
    assert.equal(result.ok, true, 'dispatch admits; preparation fails async');
    const runId = (result as { run: { runId: string } }).run.runId as ULID;

    await until(() => getAgentRunRow(runId)?.status === 'failed', 20000);
    const row = getAgentRunRow(runId)!;
    assert.equal(row.failureCause, 'worktree-provision-failed');
    assert.match(row.failureReason ?? '', /preparation command failed \(exit 3\)/);
    assert.equal(row.lifecycleState, 'provisioning-failed');
    // Receipt persisted: the passing step + the failing step, nothing after.
    assert.equal(row.preparationReceipt?.ok, false);
    assert.equal(row.preparationReceipt?.steps.length, 2);
    assert.equal(row.preparationReceipt?.steps[0]?.exitCode, 0);
    assert.equal(row.preparationReceipt?.steps[1]?.exitCode, 3);
    assert.equal(row.readinessReceipt, null, 'readiness never ran');
    // Retention: prep failure preserves the worktree for debugging.
    assert.ok(row.worktreeDir && existsSync(row.worktreeDir), 'worktree preserved');
    assert.equal(getContract(row.contractId!)!.verificationStatus, 'failed');
  } finally {
    gp.cleanup();
  }
});

test('dirty initial status refuses provisioning (clean-initial-status receipt check)', async () => {
  freshDb();
  seedStockAgents();
  const gp = await newGitProject();
  try {
    // Smudge filter dirties every fresh checkout: worktree add materializes
    // 'dirty', the index holds 'clean' — deterministic non-empty status.
    assert.equal((await git(['config', 'filter.tamper.smudge', 'echo dirty'], gp.dir)).ok, true);
    writeFileSync(join(gp.dir, '.gitattributes'), 'tampered.txt filter=tamper\n');
    writeFileSync(join(gp.dir, 'tampered.txt'), 'clean\n');
    assert.equal((await git(['add', '.'], gp.dir)).ok, true);
    assert.equal((await git(['commit', '-m', 'add tampered file'], gp.dir)).ok, true);

    const dispatch = rig(new GatedAdapter());
    const result = await dispatch.dispatchFresh({
      projectId: gp.project.id,
      agentName: 'code-writer',
      input: 'refused',
      dispatcherSessionId: 'S1',
      expectedOutput: { kind: 'repo' },
    });
    assert.equal(result.ok, false);
    if (!result.ok) {
      assert.equal(result.cause, 'worktree-provision-failed');
      assert.match(result.message, /not clean immediately after checkout/);
    }
  } finally {
    gp.cleanup();
  }
});

test('profile baseBranch overrides the main/master probe', async () => {
  freshDb();
  seedStockAgents();
  const gp = await newGitProject();
  try {
    assert.equal((await git(['checkout', '-b', 'dev'], gp.dir)).ok, true);
    const devTip = await commitFile(gp.dir, 'dev.txt', 'dev\n');

    // Probe path refuses (main copy off 'main'); the override provisions.
    const probed = await provisionWorktree(gp.dir, newId());
    assert.equal(probed.ok, false);
    const missing = await provisionWorktree(gp.dir, newId(), { baseBranch: 'nope' });
    assert.equal(missing.ok, false);
    if (!missing.ok) assert.match(missing.error, /configured base branch 'nope' does not exist/);

    assert.ok(updateProjectWorktreeProfile(gp.project.id, { baseBranch: 'dev', setupCommands: [], readinessCommands: [], cleanupCommands: [] }));
    const adapter = new GatedAdapter();
    const dispatch = rig(adapter);
    const result = await dispatch.dispatchFresh({
      projectId: gp.project.id,
      agentName: 'code-writer',
      input: 'work on dev',
      dispatcherSessionId: 'S1',
      expectedOutput: { kind: 'repo' },
    });
    assert.equal(result.ok, true, JSON.stringify(result));
    const runId = (result as { run: { runId: string } }).run.runId as ULID;
    const row = getAgentRunRow(runId)!;
    assert.equal(row.worktreeBaseBranch, 'dev');
    assert.equal(row.worktreeBaseSha, devTip);
    assert.equal(row.gitReceipt?.baseBranch, 'dev');
    // Settle the run so nothing lingers (no deliverable ⇒ typed failure).
    adapter.releaseSession();
    adapter.releaseTurn();
    await until(() => getAgentRunRow(runId)?.status !== 'queued' && getAgentRunRow(runId)?.status !== 'spawning' && getAgentRunRow(runId)?.status !== 'running', 20000);
  } finally {
    gp.cleanup();
  }
});

test('continuation re-runs readiness — receipt lands on the NEW row (readiness on every dispatch)', async () => {
  freshDb();
  seedStockAgents();
  const gp = await newGitProject();
  try {
    assert.ok(
      updateProjectWorktreeProfile(gp.project.id, {
        setupCommands: [],
        readinessCommands: [NODE_OK('re-ready')],
        cleanupCommands: [],
      }),
    );
    const adapter = new GatedAdapter();
    const dispatch = rig(adapter);
    const result = await dispatch.dispatchFresh({
      projectId: gp.project.id,
      agentName: 'code-writer',
      input: 'park it',
      dispatcherSessionId: 'S1',
      expectedOutput: { kind: 'repo' }, // default review ⇒ worktree survives the park
    });
    assert.equal(result.ok, true, JSON.stringify(result));
    const runId = (result as { run: { runId: string } }).run.runId as ULID;
    const o = observer(runId);
    adapter.releaseSession();
    await o.untilState('building');
    const row = getAgentRunRow(runId)!;
    await commitFile(row.worktreeDir!, 'feature.txt', 'work\n');
    assert.equal(
      (await dispatch.submitDeliverable({ projectId: gp.project.id, agentRunId: runId, deliverable: { kind: 'repo' }, report: 'done' })).ok,
      true,
    );
    adapter.releaseTurn();
    await o.untilState('merge-ready');
    assert.ok(existsSync(row.worktreeDir!), 'worktree survives the merge-ready park');

    adapter.rearm();
    const cont = await dispatch.dispatchContinue({
      projectId: gp.project.id,
      runId,
      input: 'keep going',
      dispatcherSessionId: 'S1',
    });
    assert.equal(cont.ok, true, JSON.stringify(cont));
    const contId = (cont as { run: { runId: string } }).run.runId as ULID;
    // Readiness re-ran in the existing workspace before the agent phase.
    await until(() => getAgentRunRow(contId)?.readinessReceipt !== null, 20000);
    const contRow = getAgentRunRow(contId)!;
    assert.equal(contRow.readinessReceipt?.ok, true);
    assert.match(contRow.readinessReceipt?.steps[0]?.stdoutTail ?? '', /re-ready/);
    assert.equal(contRow.preparationReceipt, null, 'setup does not re-run on continuation');
    // Settle the continuation (no deliverable ⇒ typed failure) — no leaks.
    adapter.releaseSession();
    adapter.releaseTurn();
    await until(() => {
      const s = getAgentRunRow(contId)?.status;
      return s === 'completed' || s === 'failed' || s === 'cancelled';
    }, 20000);
  } finally {
    gp.cleanup();
  }
});
