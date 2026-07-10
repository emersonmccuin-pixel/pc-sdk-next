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
  createAgent,
  createContract,
  createPendingAsk,
  getAgentRunRow,
  getContract,
  getPendingAsk,
  insertAgentRunRow,
  listContractsForProject,
  listNonTerminalAgentRuns,
  newId,
} from '@pc/db';
import { seedStockAgents } from '../src/agents/seed.ts';
import type { ULID } from '@pc/domain';
import { AccountRegistry } from '../src/runner/account-env.ts';
import { CLAUDE_RUNTIME_ID } from '../src/runner/claude-adapter.ts';
import { FakeRuntime, type ScriptedTurn } from '../src/runner/fake-runtime.ts';
import {
  RuntimeRegistry,
  type AgentRuntimeAdapter,
  type CreateRuntimeSession,
  type RuntimeSession,
} from '../src/runner/runtime.ts';
import { DispatchService } from '../src/dispatch/service.ts';
import { SessionRegistry } from '../src/chat/registry.ts';
import { ProjectWebSocketHub } from '../src/ws/hub.ts';
import { runBootRecovery } from '../src/boot-recovery.ts';
import type { McpManager } from '../src/mcp/manager.ts';
import { freshDb, newProject, until } from './helpers.ts';

const OK_RESULT = {
  type: 'result',
  ok: true,
  subtype: 'success',
  stopReason: 'end_turn',
  usage: null,
  durationMs: 1,
  error: null,
} as const;

class FakeAdapter implements AgentRuntimeAdapter {
  readonly id = CLAUDE_RUNTIME_ID;
  created: CreateRuntimeSession[] = [];
  constructor(private readonly turns: ScriptedTurn[], private readonly stepDelayMs = 0) {}
  async createSession(input: CreateRuntimeSession): Promise<RuntimeSession> {
    this.created.push(input);
    return new FakeRuntime({ turns: this.turns, stepDelayMs: this.stepDelayMs });
  }
  async resumeSession(input: CreateRuntimeSession): Promise<RuntimeSession> {
    return this.createSession(input);
  }
}

function rig(adapter: FakeAdapter): DispatchService {
  const runtimes = new RuntimeRegistry();
  runtimes.register(adapter);
  const dispatch = new DispatchService({
    runtimes,
    accounts: new AccountRegistry(),
    mcp: {} as McpManager,
  });
  const hub = new ProjectWebSocketHub<ULID>();
  const registry = new SessionRegistry({ hub, mintSession: () => new FakeRuntime() });
  dispatch.attach({ registry, hub, serverPort: 1 });
  return dispatch;
}

const AUDIT = { actor: 'user' as const };

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
