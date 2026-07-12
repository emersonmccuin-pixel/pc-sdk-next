// Bounded auto-continue on turn-budget exhaustion (max-turns fix, part 2).
//
// Part 1 (landed) classified an SDK max-turns/max-budget terminal as
// failureCause 'turn-budget-exhausted' — a real terminal result, not a crash.
// Part 2 (this file): the dispatch service resumes that run automatically,
// through the SAME session-resume + worktree + contract mechanism
// pc_continue_agent uses, up to a hard ceiling (MAX_AUTO_CONTINUES = 5) —
// so a healthy long task finishes on its own, while a genuinely stuck task
// still stops and surfaces to the orchestrator.
//
// Invariants under test:
//  - chain reaches the ceiling, then settles failed + delivers ONE envelope
//  - error/cancelled terminals never auto-continue (only turn-budget-exhausted)
//  - the durable per-chain counter (auto_continue_count) survives a
//    simulated restart — boot re-entry resumes from it, never double-fires
//  - intermediate auto-continues suppress the orchestrator envelope; only
//    the final outcome (ceiling or eventual success) delivers one

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  createContract,
  getActiveOrchestratorSession,
  getAgentRunRow,
  hasContinuation,
  insertAgentRunRow,
  listAgentRunsForContract,
  listConversationEvents,
  markAgentRunTerminal,
  newId,
} from '@pc/db';
import { safeToolSummary, type ToolStateEvent } from '@pc/contracts';
import type { ULID } from '@pc/domain';
import { seedStockAgents } from '../src/agents/seed.ts';
import { AccountRegistry } from '../src/runner/account-env.ts';
import { CLAUDE_RUNTIME_ID } from '../src/runner/claude-adapter.ts';
import { FakeRuntime, type ScriptedTurn } from '../src/runner/fake-runtime.ts';
import {
  RuntimeRegistry,
  type AgentRuntimeAdapter,
  type CreateRuntimeSession,
  type ResumeRuntimeSession,
  type RuntimeSession,
} from '../src/runner/runtime.ts';
import { DispatchService } from '../src/dispatch/service.ts';
import { SessionRegistry } from '../src/chat/registry.ts';
import { ProjectWebSocketHub } from '../src/ws/hub.ts';
import type { McpManager } from '../src/mcp/manager.ts';
import { freshDb, newProject, until } from './helpers.ts';
import {
  TEST_SELECTION,
  testCapabilities,
  testModelDiscovery,
  testSessionSelectionDeps,
  withRuntimeReceipt,
} from './runtime-fixtures.ts';

// Mirrors the MAX_AUTO_CONTINUES constant in dispatch/service.ts (not
// exported — the ceiling is an implementation detail; tests assert against
// the literal, same convention as MAX_REVIEW_ROUNDS in full-review.test.ts).
const MAX_AUTO_CONTINUES = 5;

const BUDGET_RESULT = {
  type: 'result',
  ok: false,
  stopReason: null,
  usage: null,
  durationMs: null,
  error: 'hit max turns',
  outcome: 'budget-exhausted',
  numTurns: 100,
} as const;

const CRASH_RESULT = {
  type: 'result',
  ok: false,
  stopReason: null,
  usage: null,
  durationMs: null,
  error: 'boom',
  outcome: 'error',
  numTurns: null,
} as const;

/** Each session (fresh or resumed) gets its OWN FakeRuntime replaying the
 *  SAME scripted turns from index 0 — a continuation's session hits the
 *  same script as its parent, so a budget-exhausted script re-fires on every
 *  auto-continuation deterministically. */
class FakeAdapter implements AgentRuntimeAdapter {
  readonly id = CLAUDE_RUNTIME_ID;
  created: CreateRuntimeSession[] = [];
  constructor(private readonly turns: ScriptedTurn[]) {}
  async capabilities(accountId: string) { return testCapabilities(this.id, accountId); }
  async listModels() { return testModelDiscovery(); }
  async createSession(input: CreateRuntimeSession): Promise<RuntimeSession> {
    this.created.push(input);
    return withRuntimeReceipt(() => new FakeRuntime({ turns: this.turns }))({
      projectId: input.projectId,
      appSessionId: input.appSessionId,
      continuationAttemptId: input.continuationAttemptId,
      selection: input.selection,
      continuation: { mode: 'create' },
    });
  }
  async resumeSession(input: ResumeRuntimeSession): Promise<RuntimeSession> {
    this.created.push(input);
    return withRuntimeReceipt(() => new FakeRuntime({ turns: this.turns }))({
      projectId: input.projectId,
      appSessionId: input.appSessionId,
      continuationAttemptId: input.continuationAttemptId,
      selection: input.selection,
      continuation: { mode: 'resume', nativeSessionId: input.nativeSessionId },
    });
  }
}

class LateAfterDisposeRuntime implements RuntimeSession {
  sentTexts: string[] = [];
  private releaseDispose!: () => void;
  private readonly disposed = new Promise<void>((resolve) => { this.releaseDispose = resolve; });
  private markLateDelivered!: () => void;
  readonly lateDelivered = new Promise<void>((resolve) => { this.markLateDelivered = resolve; });

  async *sendTurn(text: string) {
    this.sentTexts.push(text);
    const requested: ToolStateEvent = {
      kind: 'tool-state', callId: 'before-kill-call', name: 'Read', state: 'requested',
      safeSummary: safeToolSummary('Read'),
      approval: { status: 'unknown', source: null, requestId: null }, outcome: null,
    };
    yield { type: 'tool-state', scope: 'primary', event: requested } as const;
    yield {
      type: 'tool-state', scope: 'primary',
      event: {
        ...requested, state: 'running',
        approval: { status: 'not-required', source: 'runtime', requestId: null },
      },
    } as const;
    await this.disposed;
    yield {
      type: 'session-started',
      receipt: {
        mode: 'created', selection: TEST_SELECTION,
        continuationAttemptId: 'late-attempt-after-kill',
        nativeSessionId: 'late-runtime-after-kill', requestedNativeSessionId: null,
      },
    } as const;
    yield {
      type: 'tool-state', scope: 'primary',
      event: {
        ...requested, callId: 'late-after-kill-call', state: 'requested',
      },
    } as const;
    this.markLateDelivered();
    yield {
      type: 'result', ok: false, stopReason: null, usage: null, durationMs: null,
      error: 'interrupted', outcome: 'aborted', numTurns: null,
    } as const;
  }

  async interrupt(): Promise<void> {}
  async dispose(): Promise<void> { this.releaseDispose(); }
}

class SingleRuntimeAdapter implements AgentRuntimeAdapter {
  readonly id = CLAUDE_RUNTIME_ID;
  constructor(private readonly runtime: RuntimeSession) {}
  async capabilities(accountId: string) { return testCapabilities(this.id, accountId); }
  async listModels() { return testModelDiscovery(); }
  async createSession(input: CreateRuntimeSession): Promise<RuntimeSession> {
    return withRuntimeReceipt(() => this.runtime)({
      projectId: input.projectId, appSessionId: input.appSessionId,
      continuationAttemptId: input.continuationAttemptId,
      selection: input.selection, continuation: { mode: 'create' },
    });
  }
  async resumeSession(input: ResumeRuntimeSession): Promise<RuntimeSession> {
    return withRuntimeReceipt(() => this.runtime)({
      projectId: input.projectId, appSessionId: input.appSessionId,
      continuationAttemptId: input.continuationAttemptId,
      selection: input.selection,
      continuation: { mode: 'resume', nativeSessionId: input.nativeSessionId },
    });
  }
}

class DeferredRuntime implements RuntimeSession {
  sendCalls = 0;
  disposeCalls = 0;

  sendTurn(): AsyncIterable<never> {
    this.sendCalls += 1;
    return (async function* () {})();
  }

  async interrupt(): Promise<void> {}
  async dispose(): Promise<void> { this.disposeCalls += 1; }
}

class DeferredCreateAdapter implements AgentRuntimeAdapter {
  readonly id = CLAUDE_RUNTIME_ID;
  private markStarted!: () => void;
  readonly started = new Promise<void>((resolve) => { this.markStarted = resolve; });
  private resolveMint!: (session: RuntimeSession) => void;
  private readonly mint = new Promise<RuntimeSession>((resolve) => { this.resolveMint = resolve; });
  async capabilities(accountId: string) { return testCapabilities(this.id, accountId); }
  async listModels() { return testModelDiscovery(); }

  async createSession(input: CreateRuntimeSession): Promise<RuntimeSession> {
    this.markStarted();
    const runtime = await this.mint;
    return withRuntimeReceipt(() => runtime)({
      projectId: input.projectId, appSessionId: input.appSessionId,
      continuationAttemptId: input.continuationAttemptId,
      selection: input.selection, continuation: { mode: 'create' },
    });
  }

  async resumeSession(input: ResumeRuntimeSession): Promise<RuntimeSession> {
    this.markStarted();
    const runtime = await this.mint;
    return withRuntimeReceipt(() => runtime)({
      projectId: input.projectId, appSessionId: input.appSessionId,
      continuationAttemptId: input.continuationAttemptId,
      selection: input.selection,
      continuation: { mode: 'resume', nativeSessionId: input.nativeSessionId },
    });
  }

  resolve(session: RuntimeSession): void { this.resolveMint(session); }
}

function rig(adapter: AgentRuntimeAdapter): DispatchService {
  const runtimes = new RuntimeRegistry();
  runtimes.register(adapter);
  const dispatch = new DispatchService({
    runtimes,
    accounts: new AccountRegistry(),
    mcp: {} as McpManager,
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

/** True once every run in the contract's chain is terminal. */
function chainSettled(contractId: ULID): boolean {
  const rows = listAgentRunsForContract(contractId);
  return rows.length > 0 && rows.every((r) => ['completed', 'failed', 'cancelled'].includes(r.status));
}

/** Did the orchestrator receive the terminal envelope for this run? Envelope
 *  delivery rides a durable 'agent-envelope' conversation event keyed by
 *  `agent-terminal:<runId>` (DispatchService.deliverToOrchestrator). */
function envelopeDelivered(projectId: ULID, runId: string): boolean {
  const session = getActiveOrchestratorSession(projectId);
  if (!session) return false;
  return listConversationEvents(session.id).some((e) => e.clientMessageId === `agent-terminal:${runId}`);
}

test('a chain that keeps hitting the turn budget auto-continues to the ceiling, then settles failed and delivers exactly one envelope', async () => {
  freshDb();
  seedStockAgents();
  const project = newProject();
  const adapter = new FakeAdapter([[BUDGET_RESULT]]);
  const dispatch = rig(adapter);

  const result = await dispatch.dispatchFresh({
    projectId: project.id,
    agentName: 'researcher',
    input: 'find the answer',
    dispatcherSessionId: 'S1',
  });
  assert.equal(result.ok, true);
  const rootRunId = (result as { run: { runId: string } }).run.runId as ULID;
  const contractId = getAgentRunRow(rootRunId)!.contractId!;

  await until(() => chainSettled(contractId), 8000);
  const chain = listAgentRunsForContract(contractId).sort((a, b) => a.autoContinueCount - b.autoContinueCount);

  // The root dispatch + exactly MAX_AUTO_CONTINUES auto-continuations.
  assert.equal(chain.length, MAX_AUTO_CONTINUES + 1, 'root + 5 auto-continues');
  assert.deepEqual(
    chain.map((r) => r.autoContinueCount),
    [0, 1, 2, 3, 4, 5],
  );
  // Every run in the chain is linked continues -> its immediate predecessor.
  for (let i = 1; i < chain.length; i++) {
    assert.equal(chain[i]!.continues, chain[i - 1]!.id);
  }
  // Every run genuinely hit the budget — never mistaken for a crash.
  for (const row of chain) {
    assert.equal(row.status, 'failed');
    assert.equal(row.failureCause, 'turn-budget-exhausted');
  }

  const finalRun = chain[chain.length - 1]!;
  assert.match(finalRun.failureReason ?? '', /5×/, 'ceiling reason names the bound');
  assert.match(finalRun.failureReason ?? '', /needs attention/);

  // Chat noise: intermediate auto-continues (count 0-4) never reach the
  // orchestrator; only the ceiling outcome (count 5) does.
  for (const row of chain.slice(0, -1)) {
    assert.equal(envelopeDelivered(project.id, row.id), false, `run ${row.id} (attempt ${row.autoContinueCount}) must be silent`);
  }
  assert.equal(envelopeDelivered(project.id, finalRun.id), true, 'the ceiling outcome delivers the agent-failed envelope');
});

test('a crashed (non-budget) turn never auto-continues', async () => {
  freshDb();
  seedStockAgents();
  const project = newProject();
  const adapter = new FakeAdapter([[CRASH_RESULT]]);
  const dispatch = rig(adapter);

  const result = await dispatch.dispatchFresh({
    projectId: project.id,
    agentName: 'researcher',
    input: 'find the answer',
    dispatcherSessionId: 'S1',
  });
  assert.equal(result.ok, true);
  const runId = (result as { run: { runId: string } }).run.runId as ULID;

  await until(() => getAgentRunRow(runId)?.status === 'failed');
  const row = getAgentRunRow(runId)!;
  assert.equal(row.failureCause, 'unexpected-exit');

  // Give any (wrongly) fired auto-continue a beat to land, then assert none did.
  await new Promise((r) => setTimeout(r, 50));
  assert.equal(hasContinuation(runId), false, 'a crash is never auto-continued');
  assert.equal(envelopeDelivered(project.id, runId), true, 'a genuine terminal still delivers its envelope');
});

test('a killed (cancelled) run never auto-continues', async () => {
  freshDb();
  seedStockAgents();
  const project = newProject();
  // Hang forever — the run is only ended by killRun. The adapter wrapper's
  // positive session receipt moves the run to `running` before the tool state.
  const hangingTurn: ScriptedTurn = [
    {
      type: 'tool-state', scope: 'primary',
      event: {
        kind: 'tool-state', callId: 'kill-call', name: 'Read', state: 'requested',
        safeSummary: safeToolSummary('Read'),
        approval: { status: 'unknown', source: null, requestId: null }, outcome: null,
      },
    },
    {
      type: 'tool-state', scope: 'primary',
      event: {
        kind: 'tool-state', callId: 'kill-call', name: 'Read', state: 'running',
        safeSummary: safeToolSummary('Read'),
        approval: { status: 'not-required', source: 'runtime', requestId: null }, outcome: null,
      },
    },
    { hang: true },
  ];
  const adapter = new FakeAdapter([hangingTurn]);
  const dispatch = rig(adapter);

  const result = await dispatch.dispatchFresh({
    projectId: project.id,
    agentName: 'researcher',
    input: 'find the answer',
    dispatcherSessionId: 'S1',
  });
  assert.equal(result.ok, true);
  const runId = (result as { run: { runId: string } }).run.runId as ULID;
  await until(() => getAgentRunRow(runId)?.status === 'running');
  await until(() => listConversationEvents(runId).some((row) => (
    (row.payload as { kind?: string; state?: string }).kind === 'tool-state'
    && (row.payload as { state?: string }).state === 'running'
  )));

  const killed = await dispatch.killRun(project.id, runId);
  assert.equal(killed.ok, true);
  await until(() => getAgentRunRow(runId)?.status === 'cancelled');
  assert.equal(getAgentRunRow(runId)!.failureCause, 'cancelled');
  const toolEvents = listConversationEvents(runId)
    .map((row) => row.payload)
    .filter((event): event is ToolStateEvent => (
      typeof event === 'object' && event !== null && (event as { kind?: string }).kind === 'tool-state'
    ));
  assert.equal(toolEvents.at(-1)?.state, 'failed');
  assert.deepEqual(toolEvents.at(-1)?.outcome, { reason: 'turn-ended' });

  await new Promise((r) => setTimeout(r, 50));
  assert.equal(hasContinuation(runId), false, 'a cancelled run is never auto-continued');
});

test('runtime output with a fresh call id after kill cannot reopen a terminal agent transcript', async () => {
  freshDb();
  seedStockAgents();
  const project = newProject('late-after-kill');
  const runtime = new LateAfterDisposeRuntime();
  const dispatch = rig(new SingleRuntimeAdapter(runtime));
  const result = await dispatch.dispatchFresh({
    projectId: project.id,
    agentName: 'researcher',
    input: 'wait to be killed',
    dispatcherSessionId: 'S1',
  });
  assert.equal(result.ok, true);
  const runId = (result as { run: { runId: string } }).run.runId as ULID;
  await until(() => listConversationEvents(runId).some((row) => (
    (row.payload as { kind?: string; state?: string }).kind === 'tool-state'
    && (row.payload as { state?: string }).state === 'running'
  )));
  const liveNativeSessionId = getAgentRunRow(runId)!.ccSessionId;
  assert.equal((await dispatch.killRun(project.id, runId)).ok, true);
  await runtime.lateDelivered;
  const cancelled = getAgentRunRow(runId)!;
  assert.equal(cancelled.status, 'cancelled');
  assert.equal(cancelled.ccSessionId, liveNativeSessionId, 'late init cannot replace the last live native id');
  const callIds = listConversationEvents(runId)
    .map((row) => row.payload)
    .filter((event): event is ToolStateEvent => (
      typeof event === 'object' && event !== null && (event as { kind?: string }).kind === 'tool-state'
    ))
    .map((event) => event.callId);
  assert.equal(callIds.includes('late-after-kill-call'), false);
});

test('kill while runtime creation is deferred disposes the late session before any turn can be sent', async () => {
  freshDb();
  seedStockAgents();
  const project = newProject('deferred-create-kill');
  const adapter = new DeferredCreateAdapter();
  const dispatch = rig(adapter);
  const result = await dispatch.dispatchFresh({
    projectId: project.id,
    agentName: 'researcher',
    input: 'must never reach the provider after kill',
    dispatcherSessionId: 'S1',
  });
  assert.equal(result.ok, true);
  const runId = (result as { run: { runId: string } }).run.runId as ULID;
  await adapter.started;

  assert.equal((await dispatch.killRun(project.id, runId)).ok, true);
  const runtime = new DeferredRuntime();
  adapter.resolve(runtime);
  await until(() => runtime.disposeCalls === 1);

  assert.equal(getAgentRunRow(runId)?.status, 'cancelled');
  assert.equal(runtime.sendCalls, 0, 'late native session has no send/worktree mutation path');
  assert.equal(dispatch.hasLiveRun(runId), false);
  assert.equal(listConversationEvents(runId).length, 0);
});

test('the auto-continue counter is durable and survives a simulated restart — boot re-entry resumes from it exactly once', async () => {
  freshDb();
  seedStockAgents();
  const project = newProject();

  // Hand-build a chain that already burned 4 of the 5 auto-continues
  // (autoContinueCount 0..4), as if the process had crashed in the window
  // between the LAST run's terminal commit and its own fireAutoContinue call
  // — the row is durably 'failed'/'turn-budget-exhausted' but has no
  // continuation yet.
  const contract = createContract({
    projectId: project.id,
    podName: 'researcher',
    expectedOutput: { kind: 'answer' },
    acceptanceCriteria: [],
    verificationTier: 'auto',
  });
  let previousId: ULID | null = null;
  for (let i = 0; i <= 4; i++) {
    const id = newId() as ULID;
    insertAgentRunRow({
      id,
      projectId: project.id,
      podName: 'researcher',
      dispatcherSessionId: 'S1',
      ccSessionId: newId(),
      status: 'running',
      input: i === 0 ? 'find the answer' : null,
      contractId: contract.id as ULID,
      continues: previousId,
      autoContinueCount: i,
      queuedAt: Date.now(),
    });
    markAgentRunTerminal({
      id,
      status: 'failed',
      result: null,
      failureCause: 'turn-budget-exhausted',
      failureReason: 'hit turn budget (100 turns) — resumable',
      completedAt: Date.now(),
    });
    previousId = id;
  }
  const lastPreRestartId = previousId!;
  assert.equal(hasContinuation(lastPreRestartId), false, 'no continuation fired yet — the simulated crash window');

  // "Restart": a fresh DispatchService (no in-memory state from the chain
  // above) attached fresh, adapter scripted to hit the budget one more time.
  const adapter2 = new FakeAdapter([[BUDGET_RESULT]]);
  const dispatch2 = rig(adapter2);
  await dispatch2.recoverPendingAutoContinues();

  await until(() => hasContinuation(lastPreRestartId), 4000);
  const rows = listAgentRunsForContract(contract.id as ULID);
  const resumed = rows.find((r) => r.continues === lastPreRestartId)!;
  assert.ok(resumed, 'boot re-entry fired exactly the next attempt');
  assert.equal(resumed.autoContinueCount, 5, 'counter carried forward correctly across the restart');

  await until(() => ['completed', 'failed', 'cancelled'].includes(getAgentRunRow(resumed.id)!.status), 4000);
  const settled = getAgentRunRow(resumed.id)!;
  // Attempt 5 == MAX_AUTO_CONTINUES: this is the ceiling — no further
  // auto-continue, and the envelope is delivered off this final row.
  assert.equal(settled.status, 'failed');
  assert.equal(settled.failureCause, 'turn-budget-exhausted');
  assert.match(settled.failureReason ?? '', /5×/);
  assert.equal(hasContinuation(resumed.id), false, 'the ceiling stops the chain — no 6th auto-continue');
  assert.equal(envelopeDelivered(project.id, resumed.id), true);

  // Re-running recovery again (a second boot, or a duplicate call) must not
  // double-fire anything — every row in the chain already has its next hop
  // (or is the ceiling), so this is a pure no-op.
  await dispatch2.recoverPendingAutoContinues();
  assert.equal(listAgentRunsForContract(contract.id as ULID).length, rows.length, 'idempotent — no duplicate continuation');
});
