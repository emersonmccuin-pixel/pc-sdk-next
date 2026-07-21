// "Jump back in": boot recovery must not merely settle an interrupted
// orchestrator turn failed and go idle — it re-engages the orchestrator with
// a fresh turn so it can pick its own work back up. This exercises the real
// hook (`DispatchService.deliverBootRecoveryReengagement`, wired the same way
// server.ts wires it) rather than a bespoke test double, so a regression in
// the actual production plumbing fails here too.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  closeDb,
  listConversationEvents,
} from '@pc/db';
import type { ULID } from '@pc/domain';
import { runBootRecovery, type BootRecoveryDeps } from '../src/boot-recovery.ts';
import { SessionService } from '../src/chat/session-service.ts';
import { SessionRegistry } from '../src/chat/registry.ts';
import { ProjectWebSocketHub } from '../src/ws/hub.ts';
import { FakeRuntime } from '../src/runner/fake-runtime.ts';
import { RuntimeRegistry } from '../src/runner/runtime.ts';
import { DispatchService } from '../src/dispatch/service.ts';
import { freshDb, newProject, testDispatchRuntimeDeps, until } from './helpers.ts';
import { testSessionSelectionDeps, withRuntimeReceipt } from './runtime-fixtures.ts';

/** Pre-attach, exactly like real boot (recovery runs before dispatch.attach). */
function dispatchRig(): DispatchService {
  const runtimes = new RuntimeRegistry();
  return new DispatchService({ ...testDispatchRuntimeDeps(runtimes) });
}

function reengagementEnvelopes(sessionId: string): Array<{ status: string; envelope: string }> {
  return listConversationEvents(sessionId)
    .filter((r) => r.eventType === 'agent-envelope')
    .map((r) => r.payload as { status: string; envelope: string; runId: string })
    .filter((p) => p.envelope.includes('[boot-recovery]'));
}

/** A turn hung mid-flight — models the process dying with the orchestrator's
 *  OWN turn in flight, then a hard stop (drop the DB connection). */
async function hangSessionMidTurn(project: { id: ULID }): Promise<string> {
  const backend = new FakeRuntime({
    turns: [[
      { type: 'assistant-block', itemId: 'u1', scope: 'primary', block: { kind: 'text', text: 'working on it' } },
      { hang: true },
    ]],
  });
  const svc = new SessionService({
    projectId: project.id,
    mintSession: withRuntimeReceipt(() => backend),
    ...testSessionSelectionDeps(),
    broadcast: () => {},
  });
  const session = await svc.ensureActiveSession();
  await svc.handleSend({ type: 'send', commandId: 'cmd1', sessionId: session.id, text: 'do the thing', clientMessageId: 'cm1' });
  await until(() =>
    listConversationEvents(session.id).some(
      (r) => r.eventType === 'session-state' && (r.payload as { state: string }).state === 'running',
    ),
  );
  closeDb();
  return session.id;
}

test('boot recovery re-engages the orchestrator exactly once after an interrupted turn', async () => {
  freshDb();
  const project = newProject();
  const sessionId = await hangSessionMidTurn(project);

  const dispatch = dispatchRig();
  const result = runBootRecovery({
    reengageOrchestrator: (input) => dispatch.deliverBootRecoveryReengagement(input),
  });
  assert.deepEqual(result.recovered, [sessionId]);

  // Pre-attach: the envelope is queued (F3), not yet delivered into the session.
  assert.equal(reengagementEnvelopes(sessionId).length, 0, 'nothing delivered until attach');

  // Boot finishes — attach, exactly like index.ts after MCP/repository recovery.
  const hub = new ProjectWebSocketHub<ULID>();
  const registry = new SessionRegistry({
    hub,
    mintSession: withRuntimeReceipt(() => new FakeRuntime()),
    ...testSessionSelectionDeps(),
  });
  dispatch.attach({ registry, hub, serverPort: 1 });
  registry.kickRecoveredQueues();

  await until(() => reengagementEnvelopes(sessionId).length === 1, 5000);
  const [envelope] = reengagementEnvelopes(sessionId);
  assert.equal(envelope.status, 'failed');
  assert.match(envelope.envelope, /server restarted/i);
  assert.match(envelope.envelope, /continue|report/i);

  // A fresh orchestrator turn actually ran from the re-engagement (FakeRuntime
  // with no scripted turns yields a lone success result) — not just a queued
  // message sitting idle.
  await until(
    () => listConversationEvents(sessionId).some((r) => r.eventType === 'turn-end'),
    5000,
  );
});

test('a cleanly-idle boot never re-engages the orchestrator', async () => {
  freshDb();
  const project = newProject();
  const backend = new FakeRuntime({
    turns: [[{ type: 'result', ok: true, stopReason: 'complete', usage: null, durationMs: 1, error: null, outcome: 'ok', numTurns: null }]],
  });
  const svc = new SessionService({
    projectId: project.id,
    mintSession: withRuntimeReceipt(() => backend),
    ...testSessionSelectionDeps(),
    broadcast: () => {},
  });
  const session = await svc.ensureActiveSession();
  await svc.handleSend({ type: 'send', commandId: 'cmd1', sessionId: session.id, text: 'hi', clientMessageId: 'cm1' });
  await until(() =>
    listConversationEvents(session.id).some((r) => r.eventType === 'turn-end' || r.eventType === 'turn-failed'),
  );

  let calls = 0;
  const result = runBootRecovery({ reengageOrchestrator: () => { calls += 1; } });
  assert.deepEqual(result.recovered, [], 'clean idle session is untouched');
  assert.equal(calls, 0, 'a clean idle boot must never fire a re-engagement');
});

test('a second restart does not re-fire re-engagement for an already-recovered turn', async () => {
  freshDb();
  const project = newProject();
  const sessionId = await hangSessionMidTurn(project);

  const calls: Array<{ projectId: ULID; sessionId: string; turnId: string }> = [];
  const deps: BootRecoveryDeps = { reengageOrchestrator: (input) => { calls.push(input); } };

  const first = runBootRecovery(deps);
  assert.deepEqual(first.recovered, [sessionId]);
  assert.equal(calls.length, 1, 'first restart fires exactly one re-engagement');

  // Simulate a second restart with no new interruption: the turn already
  // settled terminal, so it can never be re-selected by a later sweep.
  const second = runBootRecovery(deps);
  assert.deepEqual(second.recovered, [], 'already-settled turn is not recovered twice');
  assert.equal(calls.length, 1, 'bounded — the second restart must not re-fire for the same turn');
});

test('boot recovery degrades safely when the orchestrator session cannot be re-engaged', async () => {
  freshDb();
  const project = newProject();
  const sessionId = await hangSessionMidTurn(project);

  // The hook throws (e.g. the runtime/session is unavailable) — recovery
  // itself must still complete and leave the existing turn-failed+idle
  // settlement in place, never throw out of runBootRecovery.
  let threw = false;
  assert.doesNotThrow(() => {
    const result = runBootRecovery({
      reengageOrchestrator: () => {
        threw = true;
        throw new Error('session unavailable');
      },
    });
    assert.deepEqual(result.recovered, [sessionId]);
  });
  assert.equal(threw, true, 'the hook was attempted');

  const kinds = listConversationEvents(sessionId).map((r) => r.eventType);
  assert.ok(kinds.includes('turn-failed'), 'the interrupted turn is still settled failed');
  const lastState = listConversationEvents(sessionId).filter((r) => r.eventType === 'session-state').at(-1);
  assert.equal((lastState?.payload as { state: string }).state, 'idle', 'session is still left idle, not stuck');
});

test('boot recovery is a no-op degrade when no re-engagement hook is wired at all', async () => {
  freshDb();
  const project = newProject();
  const sessionId = await hangSessionMidTurn(project);

  // Mirrors every pre-existing boot-recovery test/caller: no deps at all.
  const result = runBootRecovery();
  assert.deepEqual(result.recovered, [sessionId]);
  assert.ok(
    listConversationEvents(sessionId).some((r) => r.eventType === 'turn-failed'),
    'settlement is unaffected by an absent hook',
  );
});
