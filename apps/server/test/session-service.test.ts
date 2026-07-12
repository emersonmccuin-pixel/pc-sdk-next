import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  getActiveConversationTurn,
  getRawDb,
  listConversationEvents,
  listUnrelayedConversationEvents,
} from '@pc/db';
import {
  safeToolSummary,
  type AskFrame,
  type ChatEvent,
  type ConversationEventFrame,
  type ServerFrame,
  type ToolStateEvent,
} from '@pc/contracts';
import type { ULID } from '@pc/domain';
import { ConversationRelay } from '../src/chat/conversation-relay.ts';
import { SessionService } from '../src/chat/session-service.ts';
import { FakeRuntime } from '../src/runner/fake-runtime.ts';
import type { MintRuntimeSession, RuntimeSession } from '../src/runner/runtime.ts';
import { ProjectWebSocketHub, type WebSocketLike } from '../src/ws/hub.ts';
import { freshDb, newProject, until } from './helpers.ts';
import { testSessionSelectionDeps, withRuntimeReceipt } from './runtime-fixtures.ts';

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
    mintSession: withRuntimeReceipt(() => runtime),
    ...testSessionSelectionDeps(),
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
      { type: 'delta', itemId: 'item-1', scope: 'primary', delta: { kind: 'message-start' } },
      { type: 'delta', itemId: 'item-1', scope: 'primary', delta: { kind: 'text-delta', text: 'hi' } },
      { type: 'assistant-block', itemId: 'item-1', scope: 'primary', block: { kind: 'text', text: 'hi' } },
      { type: 'result', ok: true, stopReason: 'complete', usage: null, durationMs: 1, error: null, outcome: 'ok', numTurns: null },
    ]],
  });
  const { service, frames } = rig(project.id, runtime);
  const session = await service.ensureActiveSession();
  assert.equal((await service.handleSend({
    type: 'send', commandId: 'cmd1', sessionId: session.id, text: 'hello', clientMessageId: 'cm1',
  })).status, 'applied');
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
    mintSession: withRuntimeReceipt(() => runtime),
    ...testSessionSelectionDeps(),
    broadcast: (frame) => frames.push(frame),
    drainConversationOutbox: () => { throw new Error('relay unavailable'); },
    onConversationRelayError: (error) => relayErrors.push(error),
  });
  const session = await service.ensureActiveSession();
  assert.equal((await service.handleSend({
    type: 'send', commandId: 'cmd1', sessionId: session.id, text: 'go', clientMessageId: 'cm-relay-failure',
  })).status, 'applied');
  await until(() => terminals(session.id).length === 1);
  assert.deepEqual(runtime.sentTexts, ['go']);
  assert.equal(terminals(session.id)[0]?.kind, 'turn-end');
  assert.ok(listUnrelayedConversationEvents().length > 0);
  assert.ok(relayErrors.length > 0);
});

test('approval ask still carries an authoritative active turn when canonical relay fails from the first event', async () => {
  freshDb();
  const project = newProject('approval-relay-gap');
  const frames: ServerFrame[] = [];
  const relayErrors: unknown[] = [];
  const service = new SessionService({
    projectId: project.id,
    mintSession: withRuntimeReceipt((ctx): RuntimeSession => ({
      async *sendTurn() {
        assert.ok(ctx.ask);
        const requested: ToolStateEvent = {
          kind: 'tool-state', callId: 'call-relay-gap', name: 'Bash', state: 'requested',
          safeSummary: safeToolSummary('Bash'),
          approval: { status: 'unknown', source: null, requestId: null }, outcome: null,
        };
        const ask = ctx.ask({
          toolName: requested.name, callId: requested.callId, toolInput: {},
          appSessionId: ctx.appSessionId,
        });
        yield { type: 'tool-state', scope: 'primary', event: requested };
        yield {
          type: 'tool-state', scope: 'primary',
          event: {
            ...requested, state: 'approval-needed',
            approval: { status: 'pending', source: null, requestId: ask.requestId },
          },
        };
        const decision = await ask.decision;
        assert.equal(decision.behavior, 'allow');
        assert.equal(decision.decidedBy, 'user');
        const running: ToolStateEvent = {
          ...requested, state: 'running',
          approval: { status: 'allowed', source: 'user', requestId: ask.requestId },
        };
        yield { type: 'tool-state', scope: 'primary', event: running };
        yield { type: 'tool-state', scope: 'primary', event: { ...running, state: 'succeeded' } };
        yield {
          type: 'result', ok: true, stopReason: 'complete', usage: null,
          durationMs: 1, error: null, outcome: 'ok', numTurns: null,
        };
      },
      interrupt: async () => {},
      dispose: async () => {},
    })),
    ...testSessionSelectionDeps(),
    broadcast: (frame) => frames.push(frame),
    drainConversationOutbox: () => { throw new Error('relay unavailable from first event'); },
    onConversationRelayError: (error) => relayErrors.push(error),
  });
  const session = await service.ensureActiveSession();
  await service.handleSend({
    type: 'send', commandId: 'approval-relay-command', sessionId: session.id,
    text: 'go', clientMessageId: 'approval-relay-client',
  });
  await until(() => frames.some((frame) => frame.type === 'ask'));
  const ask = frames.find((frame): frame is AskFrame => frame.type === 'ask')!;
  const active = frames.filter((frame) => frame.type === 'orchestrator-state').at(-1);
  assert.ok(active?.type === 'orchestrator-state' && active.activeTurnId);
  assert.equal(frames.some((frame) => frame.type === 'conversation-event'), false);
  assert.ok(relayErrors.length > 0);
  assert.equal(service.handleAskReply(ask.askId, 'allow'), true);
  await until(() => terminals(session.id).length === 1);
  await service.dispose();
});

test('same-session resume re-emits a still-pending canonical approval after replay', async () => {
  freshDb();
  const project = newProject('approval-resume');
  const frames: ServerFrame[] = [];
  const runtimeFor = (ctx: MintRuntimeSession): RuntimeSession => ({
    async *sendTurn() {
      assert.ok(ctx.ask);
      const request = ctx.ask({
        toolName: 'Bash', callId: 'call-approval', toolInput: { command: 'echo safe' },
        appSessionId: ctx.appSessionId,
      });
      const requested: ToolStateEvent = {
        kind: 'tool-state', callId: 'call-approval', name: 'Bash', state: 'requested',
        safeSummary: safeToolSummary('Bash'),
        approval: { status: 'unknown', source: null, requestId: null }, outcome: null,
      };
      yield { type: 'tool-state', scope: 'primary', event: requested };
      yield {
        type: 'tool-state', scope: 'primary',
        event: {
          ...requested, state: 'approval-needed',
          approval: { status: 'pending', source: null, requestId: request.requestId },
        },
      };
      const decision = await request.decision;
      if (decision.behavior === 'allow') {
        const running: ToolStateEvent = {
          ...requested, state: 'running',
          approval: { status: 'allowed', source: 'user', requestId: request.requestId },
        };
        yield { type: 'tool-state', scope: 'primary', event: running };
        yield { type: 'tool-state', scope: 'primary', event: { ...running, state: 'succeeded' } };
      } else {
        yield {
          type: 'tool-state', scope: 'primary',
          event: {
            ...requested, state: 'denied',
            approval: { status: 'denied', source: decision.decidedBy, requestId: request.requestId },
          },
        };
      }
      yield {
        type: 'result', ok: true, stopReason: 'complete', usage: null,
        durationMs: 1, error: null, outcome: 'ok', numTurns: null,
      };
    },
    interrupt: async () => {},
    dispose: async () => {},
  });
  const service = new SessionService({
    projectId: project.id,
    mintSession: withRuntimeReceipt(runtimeFor),
    ...testSessionSelectionDeps(),
    broadcast: (frame) => frames.push(frame),
  });
  const session = await service.ensureActiveSession();
  await service.handleSend({
    type: 'send', commandId: 'approval-command', sessionId: session.id,
    text: 'needs approval', clientMessageId: 'approval-client',
  });
  await until(() => frames.some((frame) => frame.type === 'ask'));
  const firstAsk = frames.find((frame): frame is AskFrame => frame.type === 'ask')!;
  const beforeResume = frames.length;
  assert.equal((await service.resumeSession(session.id))?.id, session.id);
  const resumed = frames.slice(beforeResume);
  const replayIndex = resumed.findIndex((frame) => frame.type === 'session-replay');
  const queueIndex = resumed.findIndex((frame) => frame.type === 'send-queue-snapshot');
  const askIndex = resumed.findIndex((frame) => frame.type === 'ask');
  assert.ok(replayIndex >= 0 && queueIndex > replayIndex && askIndex > queueIndex);
  assert.deepEqual(resumed[askIndex], firstAsk);

  assert.equal(service.handleAskReply(firstAsk.askId, 'allow'), true);
  await until(() => terminals(session.id).length === 1);
  await service.dispose();
});

test('post-send persistence failure quarantines the accepted runtime before a successor turn', async () => {
  freshDb();
  const project = newProject('runtime-quarantine');
  const first = new FakeRuntime({ turns: [[{ hang: true }]] });
  let firstDisposeCalls = 0;
  const disposeFirst = first.dispose.bind(first);
  first.dispose = async () => {
    firstDisposeCalls += 1;
    await disposeFirst();
  };
  const second = new FakeRuntime({ turns: [[{
    type: 'result', ok: true, stopReason: 'complete', usage: null,
    durationMs: 1, error: null, outcome: 'ok', numTurns: null,
  }]] });
  let releaseFirst!: (runtime: RuntimeSession) => void;
  const firstMint = new Promise<RuntimeSession>((resolve) => { releaseFirst = resolve; });
  let mintCalls = 0;
  const service = new SessionService({
    projectId: project.id,
    mintSession: withRuntimeReceipt(() => (++mintCalls === 1 ? firstMint : second)),
    ...testSessionSelectionDeps(),
    broadcast: () => {},
  });
  const session = await service.ensureActiveSession();
  await service.handleSend({
    type: 'send', commandId: 'failing-command', sessionId: session.id,
    text: 'first', clientMessageId: 'failing-client',
  });
  await until(() => getActiveConversationTurn(session.id) !== null);
  const raw = getRawDb();
  raw.exec(`
    CREATE TEMP TRIGGER fail_requesting_runtime_activity
    BEFORE INSERT ON conversation_events
    WHEN NEW.event_type = 'activity-state'
      AND json_extract(NEW.payload, '$.phase') = 'requesting-runtime'
    BEGIN SELECT RAISE(ABORT, 'forced post-send persistence failure'); END;
  `);
  releaseFirst(first);
  await until(() => terminals(session.id).length === 1);
  assert.deepEqual(terminals(session.id), [{
    kind: 'turn-failed', error: 'runtime delivery failed', source: 'internal',
  }]);
  assert.equal(JSON.stringify(listConversationEvents(session.id)).includes('forced post-send persistence failure'), false);
  raw.exec('DROP TRIGGER fail_requesting_runtime_activity');
  await until(() => firstDisposeCalls === 1);
  assert.deepEqual(first.sentTexts, ['first']);

  await service.handleSend({
    type: 'send', commandId: 'successor-command', sessionId: session.id,
    text: 'second', clientMessageId: 'successor-client',
  });
  await until(() => terminals(session.id).length === 2);
  assert.equal(mintCalls, 2);
  assert.deepEqual(second.sentTexts, ['second']);
  await service.dispose();
});

test('runtime startup and synchronous delivery exceptions persist only app-authored prose', async () => {
  for (const failure of ['startup', 'delivery'] as const) {
    freshDb();
    const project = newProject(`closed-${failure}-error`);
    const deadRuntime: RuntimeSession = {
      sendTurn: () => { throw new Error('SECRET provider send detail'); },
      interrupt: async () => {},
      dispose: async () => {},
    };
    const successorRuntime = new FakeRuntime({ turns: [[{
      type: 'result', ok: true, stopReason: 'complete', usage: null,
      durationMs: 1, error: null, outcome: 'ok', numTurns: null,
    }]] });
    let mintCalls = 0;
    const service = new SessionService({
      projectId: project.id,
      mintSession: withRuntimeReceipt(failure === 'startup'
        ? async () => { throw new Error('SECRET provider startup detail'); }
        : () => (++mintCalls === 1 ? deadRuntime : successorRuntime)),
      ...testSessionSelectionDeps(),
      broadcast: () => {},
    });
    const session = await service.ensureActiveSession();
    await service.handleSend({
      type: 'send', commandId: `closed-${failure}-command`, sessionId: session.id,
      text: 'go', clientMessageId: `closed-${failure}-client`,
    });
    await until(() => terminals(session.id).length === 1);
    assert.deepEqual(terminals(session.id), [{
      kind: 'turn-failed', error: 'runtime failed to start', source: 'internal',
    }]);
    assert.equal(JSON.stringify(listConversationEvents(session.id)).includes('SECRET'), false);
    if (failure === 'delivery') {
      await service.handleSend({
        type: 'send', commandId: 'closed-delivery-successor-command', sessionId: session.id,
        text: 'next', clientMessageId: 'closed-delivery-successor-client',
      });
      await until(() => terminals(session.id).length === 2);
      assert.equal(mintCalls, 2);
      assert.deepEqual(successorRuntime.sentTexts, ['next']);
      assert.equal(terminals(session.id)[1]?.kind, 'turn-end');
    }
    await service.dispose();
  }
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
    const session = await service.ensureActiveSession();
    await service.handleSend({
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
  const session = await service.ensureActiveSession();
  assert.equal((await service.handleSend({
    type: 'send', commandId: 'cmd1', sessionId: session.id, text: 'first', clientMessageId: 'cm1',
  })).status, 'applied');
  assert.equal((await service.handleSend({
    type: 'send', commandId: 'cmd2', sessionId: session.id, text: 'second', clientMessageId: 'cm2',
  })).status, 'applied');
  await service.injectAgentEnvelope({
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
