import { test } from 'node:test';
import assert from 'node:assert/strict';
import { getActiveConversationTurn, listConversationEvents, listUnrelayedConversationEvents } from '@pc/db';
import type { ChatEvent, ConversationEventFrame, ServerFrame } from '@pc/contracts';
import type { ULID } from '@pc/domain';
import { ConversationRelay } from '../src/chat/conversation-relay.ts';
import { SessionService } from '../src/chat/session-service.ts';
import { FakeRuntime } from '../src/runner/fake-runtime.ts';
import { ProjectWebSocketHub, type WebSocketLike } from '../src/ws/hub.ts';
import { freshDb, newProject, until } from './helpers.ts';

function terminals(sessionId: string): ChatEvent[] {
  return listConversationEvents(sessionId)
    .map((row) => row.payload as ChatEvent)
    .filter((event) => event.kind === 'turn-end' || event.kind === 'turn-failed');
}

function rig(projectId: ULID, runtime: FakeRuntime) {
  const frames: ServerFrame[] = [];
  const hub = new ProjectWebSocketHub<ULID>();
  const socket: WebSocketLike = {
    OPEN: 1,
    readyState: 1,
    send: (data) => frames.push(JSON.parse(data) as ServerFrame),
  };
  hub.subscribe(projectId, socket);
  const relay = new ConversationRelay({ hub });
  const service = new SessionService({
    projectId,
    mintSession: () => runtime,
    broadcast: (frame) => hub.broadcast(projectId, frame),
    drainConversationOutbox: () => relay.drain(),
  });
  return { service, frames, relay };
}

test('event, sequence, and outbox commit before the one relay path broadcasts', async () => {
  freshDb();
  const project = newProject();
  const runtime = new FakeRuntime({
    turns: [[
      { type: 'init', nativeSessionId: 'native-1', model: 'opus', permissionMode: 'default' },
      { type: 'delta', itemId: 'item-1', scope: 'primary', delta: { kind: 'message-start' } },
      { type: 'delta', itemId: 'item-1', scope: 'primary', delta: { kind: 'text-delta', text: 'hi' } },
      { type: 'assistant-block', itemId: 'item-1', scope: 'primary', block: { kind: 'text', text: 'hi' } },
      { type: 'result', ok: true, stopReason: 'complete', usage: null, durationMs: 1, error: null, outcome: 'ok', numTurns: null },
    ]],
  });
  const { service, frames } = rig(project.id, runtime);
  const session = service.ensureActiveSession();
  assert.equal(service.handleSend({
    type: 'send', commandId: 'cmd1', sessionId: session.id, text: 'hello', clientMessageId: 'cm1',
  }).status, 'applied');
  await until(() => terminals(session.id).length === 1);

  const rows = listConversationEvents(session.id);
  assert.deepEqual(rows.map((row) => row.sequence), rows.map((_, index) => index + 1));
  assert.ok(rows.every((row) => row.itemId.length > 0));
  assert.equal(listUnrelayedConversationEvents().length, 0);
  const live = frames.filter((frame): frame is ConversationEventFrame => frame.type === 'conversation-event');
  assert.deepEqual(live.map((frame) => frame.eventId), rows.map((row) => row.eventId));
  assert.equal(live.find((frame) => frame.event.kind === 'user')?.clientMessageId, 'cm1');
  assert.deepEqual(
    live.filter((frame) => frame.event.kind === 'stream-delta').map((frame) => frame.deltaIndex),
    [0, 1],
  );
});

test('post-commit relay failure leaves the outbox pending without failing the delivered turn', async () => {
  freshDb();
  const project = newProject();
  const runtime = new FakeRuntime({
    turns: [[
      { type: 'assistant-block', itemId: 'item-1', scope: 'primary', block: { kind: 'text', text: 'done' } },
      { type: 'result', ok: true, stopReason: 'complete', usage: null, durationMs: 1, error: null, outcome: 'ok', numTurns: null },
    ]],
  });
  const frames: ServerFrame[] = [];
  const relayErrors: unknown[] = [];
  const service = new SessionService({
    projectId: project.id,
    mintSession: () => runtime,
    broadcast: (frame) => frames.push(frame),
    drainConversationOutbox: () => { throw new Error('relay unavailable'); },
    onConversationRelayError: (error) => relayErrors.push(error),
  });
  const session = service.ensureActiveSession();
  assert.equal(service.handleSend({
    type: 'send', commandId: 'cmd1', sessionId: session.id, text: 'go', clientMessageId: 'cm-relay-failure',
  }).status, 'applied');
  await until(() => terminals(session.id).length === 1);
  assert.deepEqual(runtime.sentTexts, ['go']);
  assert.equal(terminals(session.id)[0]?.kind, 'turn-end');
  assert.ok(listUnrelayedConversationEvents().length > 0);
  assert.ok(relayErrors.length > 0);
});

test('success, API error, and interrupt each persist exactly one terminal', async () => {
  for (const scenario of ['success', 'error', 'interrupt'] as const) {
    freshDb();
    const project = newProject(scenario);
    const turn = scenario === 'success'
      ? [{ type: 'result', ok: true, stopReason: 'complete', usage: null, durationMs: 1, error: null, outcome: 'ok', numTurns: null } as const]
      : scenario === 'error'
        ? [{ type: 'result', ok: false, stopReason: null, usage: null, durationMs: 1, error: 'boom', outcome: 'error', numTurns: null } as const]
        : [{ type: 'assistant-block', itemId: 'item', scope: 'primary', block: { kind: 'text', text: 'working' } } as const, { hang: true } as const];
    const runtime = new FakeRuntime({ turns: [turn] });
    const { service } = rig(project.id, runtime);
    const session = service.ensureActiveSession();
    service.handleSend({
      type: 'send', commandId: 'cmd1', sessionId: session.id, text: 'go', clientMessageId: 'cm1',
    });
    if (scenario === 'interrupt') {
      await until(() => listConversationEvents(session.id).some((row) => row.eventType === 'assistant-text'));
      const active = getActiveConversationTurn(session.id);
      assert.ok(active);
      await service.handleConversationCommand({
        type: 'interrupt', requestId: 'interrupt-1', sessionId: session.id, targetTurnId: active.id,
      });
    }
    await until(() => terminals(session.id).length === 1);
    const terminal = terminals(session.id)[0]!;
    assert.equal(terminal.kind, scenario === 'success' ? 'turn-end' : 'turn-failed');
    if (scenario === 'interrupt' && terminal.kind === 'turn-failed') assert.equal(terminal.source, 'abort');
  }
});

test('queued sends drain FIFO and typed agent envelopes remain typed', async () => {
  freshDb();
  const project = newProject();
  const runtime = new FakeRuntime({
    turns: [
      [{ type: 'result', ok: true, stopReason: 'complete', usage: null, durationMs: 1, error: null, outcome: 'ok', numTurns: null }],
      [{ type: 'result', ok: true, stopReason: 'complete', usage: null, durationMs: 1, error: null, outcome: 'ok', numTurns: null }],
      [{ type: 'result', ok: true, stopReason: 'complete', usage: null, durationMs: 1, error: null, outcome: 'ok', numTurns: null }],
    ],
    stepDelayMs: 5,
  });
  const { service } = rig(project.id, runtime);
  const session = service.ensureActiveSession();
  assert.equal(service.handleSend({
    type: 'send', commandId: 'cmd1', sessionId: session.id, text: 'first', clientMessageId: 'cm1',
  }).status, 'applied');
  assert.equal(service.handleSend({
    type: 'send', commandId: 'cmd2', sessionId: session.id, text: 'second', clientMessageId: 'cm2',
  }).status, 'applied');
  service.injectAgentEnvelope({
    runId: 'run-1',
    agentName: 'researcher',
    pendingAskId: 'ask-1',
    status: 'waiting',
    summary: 'Question',
    detail: 'Question detail',
    envelope: '[agent-asks] question',
    clientMessageId: 'agent-ask:ask-1',
  });
  await until(() => terminals(session.id).length === 3, 4000);
  assert.deepEqual(runtime.sentTexts, ['first', 'second', '[agent-asks] question']);
  const rows = listConversationEvents(session.id);
  assert.equal(rows.filter((row) => row.eventType === 'user').length, 2);
  assert.equal(rows.filter((row) => row.eventType === 'agent-envelope').length, 1);
});
