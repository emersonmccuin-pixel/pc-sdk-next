// Phase-3 dispatch invariants (master plan: "every core invariant gets a guard
// test when built"):
//  - unknown agent / spec-less dispatch are refused loudly, with NO rows minted
//  - repo kind requires provisioned isolation; provision failure is a durable
//    typed terminal, never a fallback to the live checkout
//  - delivery is the sole done-signal (completed + no deliverable ⇒
//    failed 'no-deliverable')
//  - every run is stamped with its runtime selection (guard rule 2)
//  - a delivered trust_end_turn answer verifies 'passed' end-to-end
//  - boot recovery fails live runs loudly (server-restart), cancels open asks,
//    parks the contract at verification 'pending' (kill-test, premortem #5)

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  addAgentToProject,
  commitConversationEvent,
  createAgent,
  createContract,
  createPendingAsk,
  getAgentRunRow,
  getContract,
  getPendingAsk,
  insertAgentRunRow,
  listAgentRunsForSession,
  listConversationEvents,
  listContractsForProject,
  listNonTerminalAgentRuns,
  newId,
} from '@pc/db';
import { safeToolSummary, type ToolStateEvent } from '@pc/contracts';
import { seedStockAgents } from '../src/agents/seed.ts';
import type { ULID } from '@pc/domain';
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
import { runBootRecovery } from '../src/boot-recovery.ts';
import type { McpManager } from '../src/mcp/manager.ts';
import { git } from '../src/dispatch/worktrees.ts';
import { freshDb, newGitProject, newProject, until } from './helpers.ts';
import {
  testCapabilities,
  testModelDiscovery,
  testSessionSelectionDeps,
  withRuntimeReceipt,
} from './runtime-fixtures.ts';

const OK_RESULT = {
  type: 'result',
  ok: true,
  stopReason: 'complete',
  usage: null,
  durationMs: 1,
  error: null,
  outcome: 'ok',
  numTurns: null,
} as const;

class FakeAdapter implements AgentRuntimeAdapter {
  readonly id = CLAUDE_RUNTIME_ID;
  created: CreateRuntimeSession[] = [];
  resumed: ResumeRuntimeSession[] = [];
  /** One entry per minted session (create OR resume), in order — lets a test
   *  reach the FakeRuntime a revival produced. */
  runtimes: FakeRuntime[] = [];
  constructor(private readonly turns: ScriptedTurn[], private readonly stepDelayMs = 0) {}
  async capabilities(accountId: string) { return testCapabilities(this.id, accountId); }
  async listModels() { return testModelDiscovery(); }
  async createSession(input: CreateRuntimeSession): Promise<RuntimeSession> {
    this.created.push(input);
    const rt = new FakeRuntime({ turns: this.turns, stepDelayMs: this.stepDelayMs });
    this.runtimes.push(rt);
    return withRuntimeReceipt(() => rt)({
      projectId: input.projectId, appSessionId: input.appSessionId,
      continuationAttemptId: input.continuationAttemptId,
      selection: input.selection, continuation: { mode: 'create' },
    });
  }
  async resumeSession(input: ResumeRuntimeSession): Promise<RuntimeSession> {
    this.resumed.push(input);
    const rt = new FakeRuntime({ turns: this.turns, stepDelayMs: this.stepDelayMs });
    this.runtimes.push(rt);
    return withRuntimeReceipt(() => rt)({
      projectId: input.projectId, appSessionId: input.appSessionId,
      continuationAttemptId: input.continuationAttemptId,
      selection: input.selection,
      continuation: { mode: 'resume', nativeSessionId: input.nativeSessionId },
    });
  }
}

class DeferredResumeAdapter implements AgentRuntimeAdapter {
  readonly id = CLAUDE_RUNTIME_ID;
  resumed: ResumeRuntimeSession[] = [];
  private markStarted!: () => void;
  readonly started = new Promise<void>((resolve) => { this.markStarted = resolve; });
  private resolveResume!: (session: RuntimeSession) => void;
  private readonly resumedSession = new Promise<RuntimeSession>((resolve) => { this.resolveResume = resolve; });
  async capabilities(accountId: string) { return testCapabilities(this.id, accountId); }
  async listModels() { return testModelDiscovery(); }

  async createSession(_input: CreateRuntimeSession): Promise<RuntimeSession> {
    throw new Error('create is not expected in a paused-run revival');
  }

  async resumeSession(input: ResumeRuntimeSession): Promise<RuntimeSession> {
    this.resumed.push(input);
    this.markStarted();
    const runtime = await this.resumedSession;
    return withRuntimeReceipt(() => runtime)({
      projectId: input.projectId, appSessionId: input.appSessionId,
      continuationAttemptId: input.continuationAttemptId,
      selection: input.selection,
      continuation: { mode: 'resume', nativeSessionId: input.nativeSessionId },
    });
  }

  resolve(session: RuntimeSession): void { this.resolveResume(session); }
}

class TrackingRuntime implements RuntimeSession {
  sendCalls = 0;
  disposeCalls = 0;

  sendTurn(): AsyncIterable<never> {
    this.sendCalls += 1;
    return (async function* () {})();
  }

  async interrupt(): Promise<void> {}
  async dispose(): Promise<void> { this.disposeCalls += 1; }
}

class ThrowingCreateAdapter implements AgentRuntimeAdapter {
  readonly id = CLAUDE_RUNTIME_ID;
  async capabilities(accountId: string) { return testCapabilities(this.id, accountId); }
  async listModels() { return testModelDiscovery(); }
  async createSession(_input: CreateRuntimeSession): Promise<RuntimeSession> {
    throw new Error('SECRET provider create detail');
  }
  async resumeSession(_input: ResumeRuntimeSession): Promise<RuntimeSession> {
    throw new Error('SECRET provider resume detail');
  }
}

class ThrowingSendRuntime implements RuntimeSession {
  sendTurn(): AsyncIterable<never> { throw new Error('SECRET provider send detail'); }
  async interrupt(): Promise<void> {}
  async dispose(): Promise<void> {}
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

function rig(
  adapter: AgentRuntimeAdapter,
  opts: { gitCommand?: typeof git } = {},
): DispatchService {
  const runtimes = new RuntimeRegistry();
  runtimes.register(adapter);
  const dispatch = new DispatchService({
    runtimes,
    accounts: new AccountRegistry(),
    mcp: {} as McpManager,
    ...opts,
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

const AUDIT = { actor: 'user' as const };

function seedPausedRun(projectId: ULID): { runId: ULID; askId: ULID } {
  const contract = createContract({
    projectId,
    podName: 'researcher',
    expectedOutput: { kind: 'answer' },
    acceptanceCriteria: [],
    verificationTier: 'auto',
  });
  const runId = newId() as ULID;
  insertAgentRunRow({
    id: runId,
    projectId,
    podName: 'researcher',
    dispatcherSessionId: 'S1',
    ccSessionId: 'native-paused',
    status: 'paused',
    input: 'go',
    contractId: contract.id,
    queuedAt: Date.now(),
  });
  const askId = newId() as ULID;
  createPendingAsk({
    id: askId,
    agentRunId: runId,
    ccSessionId: 'native-paused',
    projectId,
    kind: 'orchestrator',
    promptBody: 'which way?',
    now: Date.now(),
  });
  return { runId, askId };
}

test('unknown agent is refused loudly — no rows minted', async () => {
  freshDb();
  const project = newProject();
  const dispatch = rig(new FakeAdapter([]));
  const result = await dispatch.dispatchFresh({
    projectId: project.id,
    agentName: 'no-such-agent',
    input: 'go',
    dispatcherSessionId: 'S1',
  });
  assert.equal(result.ok, false);
  if (!result.ok) assert.equal(result.cause, 'unknown-agent');
  assert.equal(listNonTerminalAgentRuns().length, 0);
  assert.equal(listContractsForProject(project.id).length, 0);
});

test('spec-less dispatch of a custom pod is refused (contract-required) — no rows minted', async () => {
  freshDb();
  const project = newProject();
  const custom = createAgent(
    { name: 'my-custom-pod', scope: 'global', prompt: 'You are custom.', shareable: true },
    AUDIT,
  );
  addAgentToProject(custom.id, project.id, AUDIT);
  const dispatch = rig(new FakeAdapter([]));
  const result = await dispatch.dispatchFresh({
    projectId: project.id,
    agentName: 'my-custom-pod',
    input: 'go',
    dispatcherSessionId: 'S1',
  });
  assert.equal(result.ok, false);
  if (!result.ok) assert.equal(result.cause, 'contract-required');
  assert.equal(listNonTerminalAgentRuns().length, 0);
  assert.equal(listContractsForProject(project.id).length, 0, 'a contract that checks nothing must never be minted');
});

test('dispatch past the max invoke depth is refused (depth-cap) — no rows minted', async () => {
  freshDb();
  seedStockAgents();
  const project = newProject();
  const dispatch = rig(new FakeAdapter([]));
  const result = await dispatch.dispatchFresh({
    projectId: project.id,
    agentName: 'researcher',
    input: 'go',
    dispatcherSessionId: 'S1',
    parentInvokeDepth: 6, // would nest to depth 7 — past MAX_INVOKE_DEPTH (6)
  });
  assert.equal(result.ok, false);
  if (!result.ok) assert.equal(result.cause, 'depth-cap');
  assert.equal(listNonTerminalAgentRuns().length, 0);
  assert.equal(listContractsForProject(project.id).length, 0);
});

test('a dispatch loop past the max dispatch loop is refused (loop-cap) — no rows minted', async () => {
  freshDb();
  seedStockAgents();
  const project = newProject();
  // Seed 20 prior dispatches of the same agent by the same dispatcher
  // session — a looping pattern, at the cap, before the 21st attempt.
  for (let i = 0; i < 20; i++) {
    insertAgentRunRow({
      id: newId() as ULID,
      projectId: project.id,
      podName: 'researcher',
      dispatcherSessionId: 'S1',
      ccSessionId: `cc-${i}`,
      status: 'completed',
      input: 'go',
      queuedAt: Date.now(),
    });
  }
  const dispatch = rig(new FakeAdapter([]));
  const result = await dispatch.dispatchFresh({
    projectId: project.id,
    agentName: 'researcher',
    input: 'go',
    dispatcherSessionId: 'S1',
  });
  assert.equal(result.ok, false);
  if (!result.ok) assert.equal(result.cause, 'loop-cap');
  assert.equal(
    listAgentRunsForSession(project.id, 'S1', { podName: 'researcher', limit: 100 }).length,
    20,
    'the refused dispatch must not mint a 21st row',
  );
  assert.equal(listContractsForProject(project.id).length, 0);
});

test('repo kind with no provisionable folder ⇒ durable worktree-provision-failed terminal, never a fallback', async () => {
  freshDb();
  seedStockAgents();
  const project = newProject(); // folderPath '' — nothing to provision
  const dispatch = rig(new FakeAdapter([]));
  const result = await dispatch.dispatchFresh({
    projectId: project.id,
    agentName: 'code-writer', // stock default: { kind: 'repo' }
    input: 'fix it',
    dispatcherSessionId: 'S1',
  });
  assert.equal(result.ok, false);
  if (!result.ok) assert.equal(result.cause, 'worktree-provision-failed');
  // The refusal is durable + typed on the row.
  const rows = listNonTerminalAgentRuns();
  assert.equal(rows.length, 0);
});

test('provider session-create exceptions settle with fixed app-authored failure evidence', async () => {
  freshDb();
  seedStockAgents();
  const project = newProject('create-error-redaction');
  const dispatch = rig(new ThrowingCreateAdapter());
  const result = await dispatch.dispatchFresh({
    projectId: project.id,
    agentName: 'researcher',
    input: 'start',
    dispatcherSessionId: 'S1',
  });
  assert.equal(result.ok, true);
  const runId = (result as { run: { runId: string } }).run.runId as ULID;
  await until(() => getAgentRunRow(runId)?.status === 'failed');

  const row = getAgentRunRow(runId)!;
  assert.equal(row.failureCause, 'spawn-error');
  assert.equal(row.failureReason, 'agent runtime session could not be started');
  assert.equal(JSON.stringify(row).includes('SECRET'), false);
});

test('provider send exceptions retain send-failed classification without storing provider prose', async () => {
  freshDb();
  seedStockAgents();
  const project = newProject('send-error-redaction');
  const dispatch = rig(new SingleRuntimeAdapter(new ThrowingSendRuntime()));
  const result = await dispatch.dispatchFresh({
    projectId: project.id,
    agentName: 'researcher',
    input: 'send',
    dispatcherSessionId: 'S1',
  });
  assert.equal(result.ok, true);
  const runId = (result as { run: { runId: string } }).run.runId as ULID;
  await until(() => getAgentRunRow(runId)?.status === 'failed');

  const row = getAgentRunRow(runId)!;
  assert.equal(row.failureCause, 'send-failed');
  assert.equal(row.failureReason, 'agent runtime turn could not be sent');
  assert.equal(JSON.stringify(row).includes('SECRET'), false);
  assert.equal(JSON.stringify(listConversationEvents(runId)).includes('SECRET'), false);
});

test('submitDeliverable rejects a late repo seal when kill wins during async Git evidence', async () => {
  freshDb();
  seedStockAgents();
  const gp = await newGitProject('submit-kill-race');
  let markStatusStarted!: () => void;
  const statusStarted = new Promise<void>((resolve) => { markStatusStarted = resolve; });
  let releaseStatus!: () => void;
  const statusGate = new Promise<void>((resolve) => { releaseStatus = resolve; });
  let deferNextStatus = true;
  const dispatch = rig(
    new FakeAdapter([[
      { hang: true },
    ]]),
    {
      gitCommand: async (args, cwd, timeoutMs) => {
        if (deferNextStatus && args[0] === 'status' && args[1] === '--porcelain') {
          deferNextStatus = false;
          markStatusStarted();
          await statusGate;
        }
        return git(args, cwd, timeoutMs);
      },
    },
  );
  try {
    const result = await dispatch.dispatchFresh({
      projectId: gp.project.id,
      agentName: 'code-writer',
      input: 'build it',
      dispatcherSessionId: 'S1',
    });
    assert.equal(result.ok, true);
    const runId = (result as { run: { runId: string } }).run.runId as ULID;
    await until(() => getAgentRunRow(runId)?.status === 'running', 5000);
    const row = getAgentRunRow(runId)!;

    const submit = dispatch.submitDeliverable({
      projectId: gp.project.id,
      agentRunId: runId,
      deliverable: { kind: 'repo' },
      report: 'must not seal after kill',
    });
    await statusStarted;
    assert.equal((await dispatch.killRun(gp.project.id, runId)).ok, true);
    releaseStatus();
    const submitted = await submit;

    assert.equal(submitted.ok, false);
    if (!submitted.ok) assert.equal(submitted.httpStatus, 409);
    const cancelled = getAgentRunRow(runId)!;
    assert.equal(cancelled.status, 'cancelled');
    assert.equal(cancelled.deliveredAt, null);
    assert.equal(getContract(row.contractId!)?.deliverable, null);
  } finally {
    releaseStatus();
    await dispatch.disposeAll();
    gp.cleanup();
  }
});

test('completed run with no deliverable fails no-deliverable; selection stamped; contract verification failed', async () => {
  freshDb();
  seedStockAgents();
  const project = newProject();
  const adapter = new FakeAdapter([[OK_RESULT]]);
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
  assert.equal(row.failureCause, 'no-deliverable');
  // Guard rule 2 — the runtime selection is stamped on the row.
  assert.equal(row.runtimeId, CLAUDE_RUNTIME_ID);
  assert.ok(row.accountId, 'accountId stamped');
  assert.ok(row.model, 'model stamped');
  // The specialist got the contract block + non-interactive permissions.
  assert.equal(adapter.created.length, 1);
  assert.match(adapter.created[0]!.instructions ?? '', /## Your contract/);
  assert.equal(adapter.created[0]!.bypassPermissions, true);
  // Verification recorded the run failure on the contract.
  await until(() => getContract(row.contractId!)?.verificationStatus === 'failed');
});

test('a turn that hits the SDK turn budget settles turn-budget-exhausted, not unexpected-exit', async () => {
  freshDb();
  seedStockAgents();
  const project = newProject();
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
  const adapter = new FakeAdapter([[BUDGET_RESULT]]);
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
  // A real terminal result (SDK error_max_turns), never mistaken for a crash.
  assert.equal(row.failureCause, 'turn-budget-exhausted');
  assert.match(row.failureReason ?? '', /100 turns/);
  assert.match(row.failureReason ?? '', /resumable/);
});

test('delivered trust_end_turn answer verifies passed end-to-end', async () => {
  freshDb();
  seedStockAgents();
  const project = newProject();
  // Slow script: the turn stays open long enough for the submit to land first.
  const slowTurn: ScriptedTurn = [
    { type: 'system', subtype: 'x', level: 'info', message: 'working…' },
    { type: 'system', subtype: 'x', level: 'info', message: 'still working…' },
    OK_RESULT,
  ];
  const dispatch = rig(new FakeAdapter([slowTurn], 120));
  const result = await dispatch.dispatchFresh({
    projectId: project.id,
    agentName: 'researcher',
    input: 'answer me',
    dispatcherSessionId: 'S1',
    expectedOutput: { kind: 'answer', trust_end_turn: true },
  });
  assert.equal(result.ok, true);
  const runId = (result as { run: { runId: string } }).run.runId as ULID;

  const submitted = await dispatch.submitDeliverable({
    projectId: project.id,
    agentRunId: runId,
    deliverable: { kind: 'answer', text: 'The answer is 42.' },
    report: 'done',
  });
  assert.equal(submitted.ok, true);

  await until(() => getAgentRunRow(runId)?.status === 'completed', 5000);
  const row = getAgentRunRow(runId)!;
  assert.equal(row.failureCause, null);
  await until(() => getContract(row.contractId!)?.verificationStatus === 'passed', 5000);
  const contract = getContract(row.contractId!)!;
  assert.equal(contract.status, 'accepted');
  assert.equal((contract.deliverable as { text?: string } | null)?.text, 'The answer is 42.');
});

test('kill-test: boot recovery fails live runs loudly, cancels open asks, parks contract pending', () => {
  freshDb();
  const project = newProject();
  const contract = createContract({
    projectId: project.id,
    podName: 'researcher',
    expectedOutput: { kind: 'answer' },
    acceptanceCriteria: [],
    verificationTier: 'auto',
  });
  const runId = newId() as ULID;
  insertAgentRunRow({
    id: runId,
    projectId: project.id,
    podName: 'researcher',
    dispatcherSessionId: 'S1',
    ccSessionId: 'cc-1',
    status: 'running',
    input: 'go',
    contractId: contract.id,
    queuedAt: Date.now(),
  });
  const askId = newId() as ULID;
  createPendingAsk({
    id: askId,
    agentRunId: runId,
    ccSessionId: 'cc-1',
    projectId: project.id,
    kind: 'orchestrator',
    promptBody: 'which way?',
    now: Date.now(),
  });
  const recovery = runBootRecovery();

  assert.ok(recovery.failedRuns.includes(runId), 'live run failed loudly at boot');
  const row = getAgentRunRow(runId)!;
  assert.equal(row.status, 'failed');
  assert.equal(row.failureCause, 'server-restart');
  assert.equal(getPendingAsk(askId)!.status, 'cancelled');
  assert.equal(getContract(contract.id)!.verificationStatus, 'pending');
});

// ── F1 (comms-hardening): a paused ask survives a server restart ───────────

test('F1: boot leaves a paused run + its open ask intact (never failed/cancelled)', () => {
  freshDb();
  const project = newProject();
  const contract = createContract({
    projectId: project.id,
    podName: 'researcher',
    expectedOutput: { kind: 'answer' },
    acceptanceCriteria: [],
    verificationTier: 'auto',
  });
  const runId = newId() as ULID;
  insertAgentRunRow({
    id: runId,
    projectId: project.id,
    podName: 'researcher',
    dispatcherSessionId: 'S1',
    ccSessionId: 'native-cc-1',
    status: 'paused',
    input: 'go',
    contractId: contract.id,
    queuedAt: Date.now(),
  });
  const askId = newId() as ULID;
  createPendingAsk({
    id: askId,
    agentRunId: runId,
    ccSessionId: 'native-cc-1',
    projectId: project.id,
    kind: 'orchestrator',
    promptBody: 'which way?',
    now: Date.now(),
  });
  const requested: ToolStateEvent = {
    kind: 'tool-state', callId: 'paused-call', name: 'pc_ask_orchestrator', state: 'requested',
    safeSummary: safeToolSummary('pc_ask_orchestrator'),
    approval: { status: 'unknown', source: null, requestId: null }, outcome: null,
  };
  for (const event of [
    requested,
    {
      ...requested, state: 'running' as const,
      approval: { status: 'not-required' as const, source: 'runtime' as const, requestId: null },
    },
  ]) {
    commitConversationEvent({
      projectId: project.id, conversationId: runId, sessionId: runId,
      family: 'tool', event, turnId: 'paused-transcript-turn', itemId: event.callId,
      occurredAt: Date.now(), deliveryKind: 'agent',
    });
  }

  const recovery = runBootRecovery();

  assert.equal(recovery.failedRuns.includes(runId), false, 'a paused run is never failed loudly at boot');
  assert.equal(getAgentRunRow(runId)!.status, 'paused', 'row stays paused');
  assert.equal(getPendingAsk(askId)!.status, 'open', 'ask stays open — never orphaned');
  assert.equal(getContract(contract.id)!.verificationStatus, null, 'not touched — the run never settled');
  const toolEvents = listConversationEvents(runId)
    .map((row) => row.payload)
    .filter((event): event is ToolStateEvent => (
      typeof event === 'object' && event !== null && (event as { kind?: string }).kind === 'tool-state'
    ));
  assert.equal(toolEvents.at(-1)?.state, 'failed');
  assert.deepEqual(toolEvents.at(-1)?.outcome, { reason: 'runtime-lost' });
});

test('F1: recoverPausedAsks revives a paused run across a restart — answering its ask no longer 410s', async () => {
  freshDb();
  seedStockAgents();
  const project = newProject();
  const contract = createContract({
    projectId: project.id,
    podName: 'researcher',
    expectedOutput: { kind: 'answer' },
    acceptanceCriteria: [],
    verificationTier: 'auto',
  });
  const runId = newId() as ULID;
  insertAgentRunRow({
    id: runId,
    projectId: project.id,
    podName: 'researcher',
    dispatcherSessionId: 'S1',
    ccSessionId: 'native-cc-1',
    status: 'paused',
    input: 'go find it',
    contractId: contract.id,
    queuedAt: Date.now(),
  });
  const askId = newId() as ULID;
  createPendingAsk({
    id: askId,
    agentRunId: runId,
    ccSessionId: 'native-cc-1',
    projectId: project.id,
    kind: 'orchestrator',
    promptBody: 'which way?',
    now: Date.now(),
  });

  // The boot sweep must leave this run+ask alone (covered by the test above);
  // a FRESH DispatchService instance below models the restart itself — its
  // `this.live` map starts empty, exactly like a new process.
  runBootRecovery();

  const adapter = new FakeAdapter([[OK_RESULT]]);
  const dispatch = rig(adapter);
  await dispatch.recoverPausedAsks();

  assert.equal(adapter.resumed.length, 1, 'the native session was resumed at boot, not created fresh');
  assert.equal(adapter.resumed[0]!.nativeSessionId, 'native-cc-1');
  assert.equal(adapter.created.length, 0);
  assert.equal(dispatch.hasLiveRun(runId), true);

  const result = await dispatch.answerPendingAsk({
    projectId: project.id,
    pendingAskId: askId,
    answer: 'go left',
    answeredBy: 'orchestrator',
  });
  assert.equal(result.ok, true, 'answering a revived paused ask no longer 410s');
  assert.deepEqual(adapter.runtimes[0]!.sentTexts, ['[answer from orchestrator] go left']);
});

test('killRun atomically cancels a paused run and its open ask', async () => {
  freshDb();
  seedStockAgents();
  const project = newProject('paused-kill');
  const { runId, askId } = seedPausedRun(project.id);
  const dispatch = rig(new FakeAdapter([]));

  const killed = await dispatch.killRun(project.id, runId);

  assert.equal(killed.ok, true);
  assert.equal(getAgentRunRow(runId)?.status, 'cancelled');
  assert.equal(getPendingAsk(askId)?.status, 'cancelled');
});

test('recoverPausedAsks disposes a revived session when kill wins during provider resume', async () => {
  freshDb();
  seedStockAgents();
  const project = newProject('recover-revive-kill');
  const { runId, askId } = seedPausedRun(project.id);
  const adapter = new DeferredResumeAdapter();
  const dispatch = rig(adapter);

  const recovery = dispatch.recoverPausedAsks();
  await adapter.started;
  assert.equal((await dispatch.killRun(project.id, runId)).ok, true);
  const runtime = new TrackingRuntime();
  adapter.resolve(runtime);
  await recovery;

  assert.equal(getAgentRunRow(runId)?.status, 'cancelled');
  assert.equal(getPendingAsk(askId)?.status, 'cancelled');
  assert.equal(runtime.disposeCalls, 1);
  assert.equal(runtime.sendCalls, 0);
  assert.equal(dispatch.hasLiveRun(runId), false);
});

test('shutdown prevents an in-flight paused revival from installing a live runtime', async () => {
  freshDb();
  seedStockAgents();
  const project = newProject('recover-revive-shutdown');
  const { runId } = seedPausedRun(project.id);
  const adapter = new DeferredResumeAdapter();
  const dispatch = rig(adapter);

  const recovery = dispatch.recoverPausedAsks();
  await adapter.started;
  await dispatch.disposeAll();
  const runtime = new TrackingRuntime();
  adapter.resolve(runtime);
  await recovery;

  assert.equal(runtime.disposeCalls, 1);
  assert.equal(runtime.sendCalls, 0);
  assert.equal(dispatch.hasLiveRun(runId), false);
});

test('boot recovery and an incoming answer share one paused-run revival', async () => {
  freshDb();
  seedStockAgents();
  const project = newProject('recover-answer-revival-race');
  const { runId, askId } = seedPausedRun(project.id);
  const adapter = new DeferredResumeAdapter();
  const dispatch = rig(adapter);

  const recovery = dispatch.recoverPausedAsks();
  await adapter.started;
  const answer = dispatch.answerPendingAsk({
    projectId: project.id,
    pendingAskId: askId,
    answer: 'go left',
    answeredBy: 'orchestrator',
  });
  assert.equal(adapter.resumed.length, 1, 'the answer joins the in-flight provider resume');

  const runtime = new TrackingRuntime();
  adapter.resolve(runtime);
  const [, result] = await Promise.all([recovery, answer]);

  assert.equal(result.ok, true);
  assert.equal(adapter.resumed.length, 1);
  assert.equal(runtime.sendCalls, 1);
  await dispatch.disposeAll();
});

test('answerPendingAsk disposes a revived session when kill wins during provider resume', async () => {
  freshDb();
  seedStockAgents();
  const project = newProject('answer-revive-kill');
  const { runId, askId } = seedPausedRun(project.id);
  const adapter = new DeferredResumeAdapter();
  const dispatch = rig(adapter);

  const answer = dispatch.answerPendingAsk({
    projectId: project.id,
    pendingAskId: askId,
    answer: 'go left',
    answeredBy: 'orchestrator',
  });
  await adapter.started;
  assert.equal((await dispatch.killRun(project.id, runId)).ok, true);
  const runtime = new TrackingRuntime();
  adapter.resolve(runtime);
  const result = await answer;

  assert.equal(result.ok, false);
  if (!result.ok) assert.equal(result.httpStatus, 410);
  assert.equal(getAgentRunRow(runId)?.status, 'cancelled');
  assert.equal(getPendingAsk(askId)?.status, 'cancelled');
  assert.equal(runtime.disposeCalls, 1);
  assert.equal(runtime.sendCalls, 0);
  assert.equal(dispatch.hasLiveRun(runId), false);
});
