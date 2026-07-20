// WF-2 — per-project lifecycle policy settings (docs/master-plan.md
// "MCP manager — reliability requirements" / Phase 4: cheap orchestrator-
// review default, full-review escalation, auto-merge eligibility) wired
// into the REAL dispatch pipeline at contract creation
// (DispatchService.resolveLandingPolicy):
//  - default project settings ⇒ default-review, exactly today's behavior
//  - project autoMergeEligible=true opts a silent repo spec into auto-merge,
//    and the run actually auto-lands
//  - project reviewPolicy='full-review' escalates a silent repo spec into
//    the independent-review phase (lifecycle 'reviewing', never merge-ready)
//  - guard: project autoMergeEligible=true cannot weaken an issuer-authored
//    review:'full' spec — full-review wins, and the override is logged

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import {
  getAgentRunRow,
  getContract,
  updateProjectMeta,
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
import {
  commitFile,
  freshDb,
  newGitProject,
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

async function* turnStream(gate: Promise<void>): AsyncGenerator<RuntimeEvent> {
  yield { type: 'system', subtype: 'x', level: 'info', message: 'working…' };
  await gate;
  yield OK_RESULT;
}

/** Same minimal test-gated adapter as dispatch-lifecycle.test.ts. */
class GatedAdapter implements AgentRuntimeAdapter {
  readonly id = CLAUDE_RUNTIME_ID;
  readonly appToolBridge = 'supported' as const;
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

function note(runId: ULID): RunLifecycleState | null {
  return getAgentRunRow(runId)?.lifecycleState ?? null;
}

test('default project settings ⇒ default-review, exactly today\'s behavior', async () => {
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
      expectedOutput: { kind: 'repo' },
    });
    assert.equal(result.ok, true, JSON.stringify(result));
    const runId = (result as { run: { runId: string } }).run.runId as ULID;
    const contractId = getAgentRunRow(runId)!.contractId!;
    assert.equal(getContract(contractId)!.landingPolicy, 'default-review');

    // Drive to completion so the worktree/process is quiescent before cleanup.
    adapter.releaseSession();
    await until(() => note(runId) === 'building', 20000);
    const row = getAgentRunRow(runId)!;
    await commitFile(row.worktreeDir!, 'feature.txt', 'work\n');
    await dispatch.submitDeliverable({ projectId: gp.project.id, agentRunId: runId, deliverable: { kind: 'repo' }, report: 'done' });
    adapter.releaseTurn();
    await until(() => note(runId) === 'merge-ready', 20000);
    assert.equal(getContract(contractId)!.landingStatus, null, 'parked, nothing landed');
  } finally {
    await gp.cleanup();
  }
});

test('project autoMergeEligible=true opts a silent repo spec into auto-merge, and it really lands', async () => {
  freshDb();
  seedStockAgents();
  const gp = await newGitProject();
  try {
    assert.ok(updateProjectMeta(gp.project.id, { settings: { autoMergeEligible: true } }));
    const adapter = new GatedAdapter();
    const dispatch = rig(adapter);
    const result = await dispatch.dispatchFresh({
      projectId: gp.project.id,
      agentName: 'code-writer',
      input: 'do the work',
      dispatcherSessionId: 'S1',
      expectedOutput: { kind: 'repo' }, // silent — no auto_land/review of its own
    });
    assert.equal(result.ok, true, JSON.stringify(result));
    const runId = (result as { run: { runId: string } }).run.runId as ULID;
    const contractId = getAgentRunRow(runId)!.contractId!;
    assert.equal(getContract(contractId)!.landingPolicy, 'auto-merge');

    adapter.releaseSession();
    await until(() => note(runId) === 'building', 20000);
    const row = getAgentRunRow(runId)!;
    await commitFile(row.worktreeDir!, 'feature.txt', 'work\n');
    await dispatch.submitDeliverable({ projectId: gp.project.id, agentRunId: runId, deliverable: { kind: 'repo' }, report: 'done' });
    adapter.releaseTurn();
    await until(() => note(runId) === 'completed', 20000);
    assert.equal(getContract(contractId)!.landingStatus, 'landed');
    assert.equal(getContract(contractId)!.landingAuthorizer, 'auto');
    assert.equal(existsSync(row.worktreeDir!), false, 'worktree torn down after the project-driven auto-land');
  } finally {
    await gp.cleanup();
  }
});

test('project reviewPolicy=full-review escalates a silent repo spec into the independent-review phase', async () => {
  freshDb();
  seedStockAgents();
  const gp = await newGitProject();
  let dispatch: DispatchService | undefined;
  try {
    assert.ok(updateProjectMeta(gp.project.id, { settings: { reviewPolicy: 'full-review' } }));
    const adapter = new GatedAdapter();
    dispatch = rig(adapter);
    const result = await dispatch.dispatchFresh({
      projectId: gp.project.id,
      agentName: 'code-writer',
      input: 'do the work',
      dispatcherSessionId: 'S1',
      expectedOutput: { kind: 'repo' }, // silent — the project decides
    });
    assert.equal(result.ok, true, JSON.stringify(result));
    const runId = (result as { run: { runId: string } }).run.runId as ULID;
    const contractId = getAgentRunRow(runId)!.contractId!;
    assert.equal(getContract(contractId)!.landingPolicy, 'full-review');

    adapter.releaseSession();
    await until(() => note(runId) === 'building', 20000);
    const row = getAgentRunRow(runId)!;
    await commitFile(row.worktreeDir!, 'feature.txt', 'work\n');
    await dispatch.submitDeliverable({ projectId: gp.project.id, agentRunId: runId, deliverable: { kind: 'repo' }, report: 'done' });
    adapter.releaseTurn();
    // Full-review never parks merge-ready — it enters the independent review
    // phase instead (docs/worktree-lifecycle.md 'Full independent review').
    await until(() => note(runId) === 'reviewing', 20000);
    assert.equal(getContract(contractId)!.landingStatus, null, 'no auto-land, no orchestrator park');
  } finally {
    // Drain the dispatched reviewer before tearing down — otherwise its
    // background completion races the next test's freshDb().
    await dispatch?.disposeAll();
    await gp.cleanup();
  }
});

test('guard: project autoMergeEligible=true cannot weaken an issuer-authored full-review spec (guard wins, logged)', async () => {
  freshDb();
  seedStockAgents();
  const gp = await newGitProject();
  const warnings: string[] = [];
  const originalWarn = console.warn;
  console.warn = (...args: unknown[]) => {
    warnings.push(args.map(String).join(' '));
  };
  let dispatch: DispatchService | undefined;
  try {
    assert.ok(updateProjectMeta(gp.project.id, { settings: { autoMergeEligible: true } }));
    const adapter = new GatedAdapter();
    dispatch = rig(adapter);
    const result = await dispatch.dispatchFresh({
      projectId: gp.project.id,
      agentName: 'code-writer',
      input: 'do the work',
      dispatcherSessionId: 'S1',
      expectedOutput: { kind: 'repo', review: 'full' }, // issuer-authored — always wins
    });
    assert.equal(result.ok, true, JSON.stringify(result));
    const runId = (result as { run: { runId: string } }).run.runId as ULID;
    const contractId = getAgentRunRow(runId)!.contractId!;
    assert.equal(getContract(contractId)!.landingPolicy, 'full-review', 'guard wins — never downgraded to auto-merge');
    assert.ok(
      warnings.some((w) => w.includes('autoMergeEligible ignored') && w.includes('full-review')),
      `expected a logged guard override, got: ${JSON.stringify(warnings)}`,
    );

    adapter.releaseSession();
    await until(() => note(runId) === 'building', 20000);
    const row = getAgentRunRow(runId)!;
    await commitFile(row.worktreeDir!, 'feature.txt', 'work\n');
    await dispatch.submitDeliverable({ projectId: gp.project.id, agentRunId: runId, deliverable: { kind: 'repo' }, report: 'done' });
    adapter.releaseTurn();
    await until(() => note(runId) === 'reviewing', 20000);
  } finally {
    console.warn = originalWarn;
    await dispatch?.disposeAll();
    await gp.cleanup();
  }
});
