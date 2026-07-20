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
  type SubscriptionQuotaObservationBatch,
  type ToolStateEvent,
} from '@pc/contracts';
import type { ULID } from '@pc/domain';
import { ConversationRelay } from '../src/chat/conversation-relay.ts';
import { infrastructureFailureMessage, SessionService } from '../src/chat/session-service.ts';
import { FakeRuntime } from '../src/runner/fake-runtime.ts';
import type { MintRuntimeSession, RuntimeSession } from '../src/runner/runtime.ts';
import { ProjectWebSocketHub, type WebSocketLike } from '../src/ws/hub.ts';
import { freshDb, newProject, until } from './helpers.ts';
import {
  runtimeReceiptFor,
  TEST_SELECTION,
  testSessionSelectionDeps,
  withRuntimeReceipt,
} from './runtime-fixtures.ts';

function terminals(sessionId: string): ChatEvent[] {
  return listConversationEvents(sessionId)
    .map((row) => row.payload as ChatEvent)
    .filter((event) => event.kind === 'turn-end' || event.kind === 'turn-failed');
}

function contextRows(sessionId: string) {
  return listConversationEvents(sessionId)
    .filter((row) => row.eventType === 'context-observation');
}

function rig(
  projectId: ULID,
  runtime: FakeRuntime,
  opts: { contextObservationTimeoutMs?: number } = {},
) {
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
    ...opts,
  });
  return { service, frames, relay };
}

function quotaBatch(
  observedAt: number,
  overrides: Partial<Pick<SubscriptionQuotaObservationBatch, 'runtimeId' | 'accountId'>> = {},
): SubscriptionQuotaObservationBatch {
  return {
    runtimeId: overrides.runtimeId ?? TEST_SELECTION.runtimeId,
    accountId: overrides.accountId ?? TEST_SELECTION.accountId,
    availability: 'available',
    coverage: 'complete',
    observedAt,
    observations: [{
      window: { id: `window-${observedAt}`, label: '5h', durationMs: null },
      scope: { kind: 'account' },
      source: { semantics: 'used', fraction: 0.25 },
      confidence: 'exact',
      limitState: 'allowed',
      resetsAt: null,
    }],
  };
}

test('orchestrator quota ingress requires the exact positive runtime receipt and never enters chat', async () => {
  freshDb();
  const project = newProject('orchestrator-passive-quota');
  const admitted: SubscriptionQuotaObservationBatch[] = [];
  const service = new SessionService({
    projectId: project.id,
    mintSession: async (ctx): Promise<RuntimeSession> => ({
      async *sendTurn() {
        yield { type: 'subscription-quota', batch: quotaBatch(100) };
        yield runtimeReceiptFor(ctx);
        yield {
          type: 'subscription-quota',
          batch: quotaBatch(200, { accountId: 'foreign-account' }),
        };
        yield { type: 'subscription-quota', batch: quotaBatch(300) };
        yield {
          type: 'result', ok: true, stopReason: 'complete', usage: null,
          durationMs: 1, error: null, outcome: 'ok', numTurns: null,
        };
      },
      observeContext: async () => ({ confidence: 'unavailable', reason: 'unsupported' }),
      interrupt: async () => {},
      dispose: async () => {},
    }),
    ...testSessionSelectionDeps(),
    broadcast: () => {},
    onSubscriptionQuota: (batch) => {
      admitted.push(batch);
      throw new Error('forced non-critical quota sink failure');
    },
  });
  const session = await service.ensureActiveSession();
  await service.handleSend({
    type: 'send', commandId: 'quota-ingress-command', sessionId: session.id,
    text: 'go', clientMessageId: 'quota-ingress-client',
  });
  await until(() => terminals(session.id).length === 1);
  assert.deepEqual(admitted.map((batch) => batch.observedAt), [300]);
  assert.equal(terminals(session.id)[0]?.kind, 'turn-end');
  assert.equal(
    JSON.stringify(listConversationEvents(session.id)).includes('window-'),
    false,
  );
  await service.dispose();
});

test('a stale disposed orchestrator attempt cannot publish passive quota or fail its transcript', async () => {
  freshDb();
  const project = newProject('orchestrator-stale-quota-attempt');
  const admitted: SubscriptionQuotaObservationBatch[] = [];
  let markReceiptConsumed!: () => void;
  const receiptConsumed = new Promise<void>((resolve) => { markReceiptConsumed = resolve; });
  let releaseStale!: () => void;
  const staleGate = new Promise<void>((resolve) => { releaseStale = resolve; });
  const service = new SessionService({
    projectId: project.id,
    mintSession: async (ctx): Promise<RuntimeSession> => ({
      async *sendTurn() {
        yield runtimeReceiptFor(ctx);
        markReceiptConsumed();
        await staleGate;
        yield { type: 'subscription-quota', batch: quotaBatch(500) };
        yield {
          type: 'result', ok: true, stopReason: 'complete', usage: null,
          durationMs: 1, error: null, outcome: 'ok', numTurns: null,
        };
      },
      observeContext: async () => ({ confidence: 'unavailable', reason: 'unsupported' }),
      interrupt: async () => {},
      dispose: async () => {},
    }),
    ...testSessionSelectionDeps(),
    broadcast: () => {},
    onSubscriptionQuota: (batch) => admitted.push(batch),
  });
  const session = await service.ensureActiveSession();
  await service.handleSend({
    type: 'send', commandId: 'stale-quota-command', sessionId: session.id,
    text: 'go', clientMessageId: 'stale-quota-client',
  });
  await receiptConsumed;
  const disposing = service.dispose();
  releaseStale();
  await disposing;

  assert.deepEqual(admitted, []);
  assert.deepEqual(terminals(session.id).map((event) => event.kind), ['turn-end']);
  assert.equal(
    JSON.stringify(listConversationEvents(session.id)).includes('window-500'),
    false,
  );
});

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
      observeContext: async () => ({ confidence: 'unavailable', reason: 'unsupported' }),
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
    observeContext: async () => ({ confidence: 'unavailable', reason: 'unsupported' }),
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

test('a typed error code rides along in the runtime-failed-to-start message; an untyped error stays generic', async () => {
  class FakeTypedError extends Error {
    constructor(readonly code: string) {
      super('SECRET provider detail that must never surface');
    }
  }
  freshDb();
  const project = newProject('typed-startup-error');
  const service = new SessionService({
    projectId: project.id,
    mintSession: withRuntimeReceipt(async () => { throw new FakeTypedError('session-mint-unavailable'); }),
    ...testSessionSelectionDeps(),
    broadcast: () => {},
  });
  const session = await service.ensureActiveSession();
  await service.handleSend({
    type: 'send', commandId: 'typed-startup-command', sessionId: session.id,
    text: 'go', clientMessageId: 'typed-startup-client',
  });
  await until(() => terminals(session.id).length === 1);
  assert.deepEqual(terminals(session.id), [{
    kind: 'turn-failed', error: 'runtime failed to start (session-mint-unavailable)', source: 'internal',
  }]);
  assert.equal(JSON.stringify(listConversationEvents(session.id)).includes('SECRET'), false);
  await service.dispose();

  // An untyped error keeps today's generic copy (already covered end-to-end
  // above and by the "...persist only app-authored prose" test below).
});

test('infrastructureFailureMessage appends a typed code and never a raw provider-shaped one', () => {
  class FakeTypedError extends Error {
    constructor(readonly code: string) {
      super('irrelevant');
    }
  }
  assert.equal(
    infrastructureFailureMessage('runtime failed to start', new FakeTypedError('session-mint-unavailable')),
    'runtime failed to start (session-mint-unavailable)',
  );
  assert.equal(
    infrastructureFailureMessage('runtime delivery failed', new FakeTypedError('account-unavailable')),
    'runtime delivery failed (account-unavailable)',
  );
  // Untyped error: no code to append.
  assert.equal(
    infrastructureFailureMessage('runtime failed to start', new Error('plain error')),
    'runtime failed to start',
  );
  // A `.code` that isn't a lowercase-kebab app-vocabulary word is never
  // trusted, even if present — guards against a raw provider/SDK error code
  // (e.g. uppercase SQLite/HTTP codes) leaking through.
  assert.equal(
    infrastructureFailureMessage(
      'runtime failed to start',
      Object.assign(new Error('bad code'), { code: 'SQLITE_CONSTRAINT_TRIGGER' }),
    ),
    'runtime failed to start',
  );
  assert.equal(
    infrastructureFailureMessage(
      'runtime failed to start',
      Object.assign(new Error('bad code'), { code: 'Not Valid! spaces' }),
    ),
    'runtime failed to start',
  );
  // Non-object and non-string-code throws also fall back cleanly.
  assert.equal(infrastructureFailureMessage('runtime failed to start', 'a string throw'), 'runtime failed to start');
  assert.equal(
    infrastructureFailureMessage('runtime failed to start', Object.assign(new Error('x'), { code: 42 })),
    'runtime failed to start',
  );
});

test('runtime startup and synchronous delivery exceptions persist only app-authored prose', async () => {
  for (const failure of ['startup', 'delivery'] as const) {
    freshDb();
    const project = newProject(`closed-${failure}-error`);
    const deadRuntime: RuntimeSession = {
      sendTurn: () => { throw new Error('SECRET provider send detail'); },
      observeContext: async () => ({ confidence: 'unavailable', reason: 'unsupported' }),
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

test('terminal becomes idle before context observation while FIFO successors remain held', async () => {
  freshDb();
  const project = newProject('context-fifo');
  let releaseFirst!: () => void;
  const firstObservationGate = new Promise<void>((resolve) => { releaseFirst = resolve; });
  let observationCalls = 0;
  const observation = {
    confidence: 'exact' as const,
    usedTokens: 25,
    usableTokens: 80,
    contextWindowTokens: 100,
  };
  const runtime = new FakeRuntime({
    turns: [
      [{
        type: 'result', ok: true, stopReason: 'complete', usage: null,
        durationMs: 1, error: null, outcome: 'ok', numTurns: null,
      }],
      [{
        type: 'result', ok: true, stopReason: 'complete', usage: null,
        durationMs: 1, error: null, outcome: 'ok', numTurns: null,
      }],
    ],
    contextObservation: async () => {
      observationCalls += 1;
      if (observationCalls === 1) await firstObservationGate;
      return observation;
    },
  });
  const { service, frames } = rig(project.id, runtime, {
    contextObservationTimeoutMs: 1_000,
  });
  const session = await service.ensureActiveSession();
  await service.handleSend({
    type: 'send', commandId: 'context-first', sessionId: session.id,
    text: 'first', clientMessageId: 'context-first-client',
  });
  await service.handleSend({
    type: 'send', commandId: 'context-second', sessionId: session.id,
    text: 'second', clientMessageId: 'context-second-client',
  });

  await until(() => terminals(session.id).length === 1);
  await until(() => frames.some((frame) => (
    frame.type === 'orchestrator-state'
      && frame.sessionId === session.id
      && frame.activeTurnId === null
      && frame.health === 'idle'
  )));
  assert.deepEqual(runtime.sentTexts, ['first']);
  assert.equal(contextRows(session.id).length, 0);
  const terminalFrameIndex = frames.findIndex((frame) => (
    frame.type === 'conversation-event' && frame.event.kind === 'turn-end'
  ));
  const idleFrameIndex = frames.findIndex((frame, index) => (
    index > terminalFrameIndex
      && frame.type === 'orchestrator-state'
      && frame.activeTurnId === null
      && frame.health === 'idle'
  ));
  assert.ok(terminalFrameIndex >= 0 && idleFrameIndex > terminalFrameIndex);

  releaseFirst();
  await until(() => terminals(session.id).length === 2);
  await until(() => contextRows(session.id).length === 2);
  assert.deepEqual(runtime.sentTexts, ['first', 'second']);
  assert.deepEqual(
    contextRows(session.id).map((row) => row.payload),
    [
      { kind: 'context-observation', ...observation },
      { kind: 'context-observation', ...observation },
    ],
  );
  await service.dispose();
});

test('context timeout is explicit and a late native response cannot duplicate or cross turns', async () => {
  freshDb();
  const project = newProject('context-timeout');
  let releaseLate!: () => void;
  const lateGate = new Promise<void>((resolve) => { releaseLate = resolve; });
  let observationCalls = 0;
  const runtime = new FakeRuntime({
    turns: [
      [{
        type: 'result', ok: true, stopReason: 'complete', usage: null,
        durationMs: 1, error: null, outcome: 'ok', numTurns: null,
      }],
      [{
        type: 'result', ok: true, stopReason: 'complete', usage: null,
        durationMs: 1, error: null, outcome: 'ok', numTurns: null,
      }],
    ],
    contextObservation: async () => {
      observationCalls += 1;
      if (observationCalls === 1) await lateGate;
      return {
        confidence: 'derived',
        usedTokens: observationCalls,
        usableTokens: 80,
        contextWindowTokens: 100,
      };
    },
  });
  const { service } = rig(project.id, runtime, { contextObservationTimeoutMs: 10 });
  const session = await service.ensureActiveSession();
  await service.handleSend({
    type: 'send', commandId: 'timeout-first', sessionId: session.id,
    text: 'first', clientMessageId: 'timeout-first-client',
  });
  await service.handleSend({
    type: 'send', commandId: 'timeout-second', sessionId: session.id,
    text: 'second', clientMessageId: 'timeout-second-client',
  });

  await until(() => terminals(session.id).length === 2);
  await until(() => contextRows(session.id).length === 2);
  const beforeLate = contextRows(session.id);
  assert.deepEqual(beforeLate.map((row) => row.payload), [
    {
      kind: 'context-observation',
      confidence: 'unavailable',
      reason: 'observation-timeout',
    },
    {
      kind: 'context-observation',
      confidence: 'derived',
      usedTokens: 2,
      usableTokens: 80,
      contextWindowTokens: 100,
    },
  ]);
  releaseLate();
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.deepEqual(contextRows(session.id), beforeLate);
  await service.dispose();
});

test('context persistence retries before releasing the same-session FIFO successor', async () => {
  freshDb();
  const project = newProject('context-persistence-retry');
  const observation = {
    confidence: 'exact' as const,
    usedTokens: 2,
    usableTokens: 8,
    contextWindowTokens: 10,
  };
  const runtime = new FakeRuntime({
    turns: [
      [{
        type: 'result', ok: true, stopReason: 'complete', usage: null,
        durationMs: 1, error: null, outcome: 'ok', numTurns: null,
      }],
      [{
        type: 'result', ok: true, stopReason: 'complete', usage: null,
        durationMs: 1, error: null, outcome: 'ok', numTurns: null,
      }],
    ],
    contextObservation: observation,
  });
  const { service, frames } = rig(project.id, runtime);
  const session = await service.ensureActiveSession();
  const raw = getRawDb();
  raw.exec(`
    CREATE TEMP TABLE context_persistence_gate (blocked INTEGER NOT NULL);
    INSERT INTO context_persistence_gate (blocked) VALUES (1);
    CREATE TEMP TRIGGER fail_context_persistence_while_blocked
    BEFORE INSERT ON conversation_events
    WHEN NEW.event_type = 'context-observation'
      AND (SELECT blocked FROM context_persistence_gate LIMIT 1) = 1
    BEGIN SELECT RAISE(ABORT, 'forced context persistence failure'); END;
  `);

  await service.handleSend({
    type: 'send', commandId: 'persistence-first', sessionId: session.id,
    text: 'first', clientMessageId: 'persistence-first-client',
  });
  await service.handleSend({
    type: 'send', commandId: 'persistence-second', sessionId: session.id,
    text: 'second', clientMessageId: 'persistence-second-client',
  });
  await until(() => terminals(session.id).length === 1);
  await until(() => frames.some((frame) => (
    frame.type === 'orchestrator-state'
      && frame.health === 'failed'
      && frame.failureReason === 'context observation persistence unavailable'
  )));
  const failureFrameIndex = frames.findIndex((frame) => (
    frame.type === 'orchestrator-state'
      && frame.health === 'failed'
      && frame.failureReason === 'context observation persistence unavailable'
  ));
  assert.notEqual(failureFrameIndex, -1);
  assert.equal(contextRows(session.id).length, 0);
  assert.deepEqual(runtime.sentTexts, ['first']);
  assert.equal(terminals(session.id)[0]?.kind, 'turn-end');

  const observationReceiptDeadline = Date.now();
  await new Promise((resolve) => setTimeout(resolve, 25));
  const retryReleaseAt = Date.now();
  raw.prepare('UPDATE context_persistence_gate SET blocked = 0').run();
  await until(() => terminals(session.id).length === 2, 4_000);
  await until(() => contextRows(session.id).length === 2, 4_000);
  assert.deepEqual(runtime.sentTexts, ['first', 'second']);
  const persistedContextRows = contextRows(session.id);
  assert.deepEqual(persistedContextRows.map((row) => row.payload), [
    { kind: 'context-observation', ...observation },
    { kind: 'context-observation', ...observation },
  ]);
  assert.ok(persistedContextRows[0]!.occurredAt <= observationReceiptDeadline);
  assert.ok(persistedContextRows[0]!.occurredAt < retryReleaseAt);
  assert.equal(frames.slice(failureFrameIndex + 1).some((frame) => (
    frame.type === 'orchestrator-state'
      && frame.health === 'idle'
      && frame.failureReason === null
  )), true);
  const latestState = [...frames].reverse()
    .find((frame) => frame.type === 'orchestrator-state');
  assert.ok(latestState?.type === 'orchestrator-state');
  assert.equal(latestState.health, 'idle');
  assert.equal(latestState.failureReason, null);
  raw.exec('DROP TRIGGER fail_context_persistence_while_blocked');
  raw.exec('DROP TABLE context_persistence_gate');
  await service.dispose();
});

test('session replacement aborts a permanent context persistence retry', async () => {
  freshDb();
  const project = newProject('context-persistence-replacement');
  const priorRuntime = new FakeRuntime({
    turns: [[{
      type: 'result', ok: true, stopReason: 'complete', usage: null,
      durationMs: 1, error: null, outcome: 'ok', numTurns: null,
    }]],
    contextObservation: {
      confidence: 'exact', usedTokens: 1, usableTokens: 8, contextWindowTokens: 10,
    },
  });
  const replacementRuntime = new FakeRuntime({
    turns: [[{
      type: 'result', ok: true, stopReason: 'complete', usage: null,
      durationMs: 1, error: null, outcome: 'ok', numTurns: null,
    }]],
    contextObservation: {
      confidence: 'exact', usedTokens: 2, usableTokens: 8, contextWindowTokens: 10,
    },
  });
  let mintCalls = 0;
  const frames: ServerFrame[] = [];
  const service = new SessionService({
    projectId: project.id,
    mintSession: withRuntimeReceipt(() => (
      ++mintCalls === 1 ? priorRuntime : replacementRuntime
    )),
    ...testSessionSelectionDeps(),
    broadcast: (frame) => frames.push(frame),
  });
  const prior = await service.ensureActiveSession();
  const raw = getRawDb();
  raw.exec(`
    CREATE TEMP TABLE context_persistence_blocked_session (session_id TEXT NOT NULL);
    CREATE TEMP TRIGGER fail_context_persistence_for_blocked_session
    BEFORE INSERT ON conversation_events
    WHEN NEW.event_type = 'context-observation'
      AND NEW.session_id = (SELECT session_id FROM context_persistence_blocked_session LIMIT 1)
    BEGIN SELECT RAISE(ABORT, 'forced permanent context persistence failure'); END;
  `);
  raw.prepare('INSERT INTO context_persistence_blocked_session (session_id) VALUES (?)')
    .run(prior.id);

  await service.handleSend({
    type: 'send', commandId: 'persistence-replacement-first', sessionId: prior.id,
    text: 'first', clientMessageId: 'persistence-replacement-first-client',
  });
  await until(() => frames.some((frame) => (
    frame.type === 'orchestrator-state'
      && frame.health === 'failed'
      && frame.failureReason === 'context observation persistence unavailable'
  )));

  const replacement = await Promise.race([
    service.startNewSession(),
    new Promise<never>((_, reject) => {
      const timer = setTimeout(
        () => reject(new Error('session replacement did not abort context persistence retry')),
        1_000,
      );
      if (typeof timer.unref === 'function') timer.unref();
    }),
  ]);
  await service.handleSend({
    type: 'send', commandId: 'persistence-replacement-next', sessionId: replacement.id,
    text: 'next', clientMessageId: 'persistence-replacement-next-client',
  });
  await until(() => contextRows(replacement.id).length === 1);
  assert.equal(contextRows(prior.id).length, 0);
  assert.deepEqual(contextRows(replacement.id)[0]?.payload, {
    kind: 'context-observation',
    confidence: 'exact',
    usedTokens: 2,
    usableTokens: 8,
    contextWindowTokens: 10,
  });
  raw.exec('DROP TRIGGER fail_context_persistence_for_blocked_session');
  raw.exec('DROP TABLE context_persistence_blocked_session');
  await service.dispose();
});

test('disposal aborts a permanent context persistence retry', async () => {
  freshDb();
  const project = newProject('context-persistence-disposal');
  const runtime = new FakeRuntime({
    turns: [[{
      type: 'result', ok: true, stopReason: 'complete', usage: null,
      durationMs: 1, error: null, outcome: 'ok', numTurns: null,
    }]],
    contextObservation: {
      confidence: 'exact', usedTokens: 1, usableTokens: 8, contextWindowTokens: 10,
    },
  });
  const { service, frames } = rig(project.id, runtime);
  const session = await service.ensureActiveSession();
  const raw = getRawDb();
  raw.exec(`
    CREATE TEMP TRIGGER fail_all_context_persistence
    BEFORE INSERT ON conversation_events
    WHEN NEW.event_type = 'context-observation'
    BEGIN SELECT RAISE(ABORT, 'forced permanent context persistence failure'); END;
  `);

  await service.handleSend({
    type: 'send', commandId: 'persistence-disposal', sessionId: session.id,
    text: 'first', clientMessageId: 'persistence-disposal-client',
  });
  await until(() => frames.some((frame) => (
    frame.type === 'orchestrator-state'
      && frame.health === 'failed'
      && frame.failureReason === 'context observation persistence unavailable'
  )));
  const disposed = await Promise.race([
    service.dispose().then(() => true),
    new Promise<boolean>((resolve) => {
      const timer = setTimeout(() => resolve(false), 1_000);
      if (typeof timer.unref === 'function') timer.unref();
    }),
  ]);
  assert.equal(disposed, true);
  assert.equal(contextRows(session.id).length, 0);
  raw.exec('DROP TRIGGER fail_all_context_persistence');
});

test('context failure stays typed and cannot rewrite the settled turn', async () => {
  freshDb();
  const project = newProject('context-failure');
  const runtime = new FakeRuntime({
    turns: [[{
      type: 'result', ok: true, stopReason: 'complete', usage: null,
      durationMs: 1, error: null, outcome: 'ok', numTurns: null,
    }]],
    contextObservation: async () => { throw new Error('SECRET native context detail'); },
  });
  const { service } = rig(project.id, runtime);
  const session = await service.ensureActiveSession();
  await service.handleSend({
    type: 'send', commandId: 'context-failure-command', sessionId: session.id,
    text: 'go', clientMessageId: 'context-failure-client',
  });
  await until(() => contextRows(session.id).length === 1);
  assert.deepEqual(terminals(session.id), [{
    kind: 'turn-end', text: '', stopReason: 'complete',
  }]);
  assert.deepEqual(contextRows(session.id)[0]?.payload, {
    kind: 'context-observation',
    confidence: 'unavailable',
    reason: 'runtime-unavailable',
  });
  assert.equal(JSON.stringify(listConversationEvents(session.id)).includes('SECRET'), false);
  await service.dispose();
});

test('malformed runtime context is persisted only as invalid-observation', async () => {
  freshDb();
  const project = newProject('context-invalid');
  const runtime = new FakeRuntime({
    turns: [[{
      type: 'result', ok: true, stopReason: 'complete', usage: null,
      durationMs: 1, error: null, outcome: 'ok', numTurns: null,
    }]],
  });
  runtime.observeContext = async () => ({
    confidence: 'exact',
    usedTokens: 9,
    usableTokens: 8,
    contextWindowTokens: 10,
    nativeCategories: { system: 9 },
  }) as never;
  const { service } = rig(project.id, runtime);
  const session = await service.ensureActiveSession();
  await service.handleSend({
    type: 'send', commandId: 'context-invalid-command', sessionId: session.id,
    text: 'go', clientMessageId: 'context-invalid-client',
  });
  await until(() => contextRows(session.id).length === 1);
  assert.deepEqual(contextRows(session.id)[0]?.payload, {
    kind: 'context-observation',
    confidence: 'unavailable',
    reason: 'invalid-observation',
  });
  assert.equal(JSON.stringify(listConversationEvents(session.id)).includes('nativeCategories'), false);
  await service.dispose();
});

test('throwing runtime context accessors degrade without losing telemetry or releasing raw detail', async () => {
  freshDb();
  const project = newProject('context-throwing-accessor');
  const runtime = new FakeRuntime({
    turns: [[{
      type: 'result', ok: true, stopReason: 'complete', usage: null,
      durationMs: 1, error: null, outcome: 'ok', numTurns: null,
    }]],
  });
  runtime.observeContext = async () => Object.defineProperty({}, 'confidence', {
    enumerable: true,
    get: () => { throw new Error('SECRET throwing context getter'); },
  }) as never;
  const { service } = rig(project.id, runtime);
  const session = await service.ensureActiveSession();
  await service.handleSend({
    type: 'send', commandId: 'context-throwing-command', sessionId: session.id,
    text: 'go', clientMessageId: 'context-throwing-client',
  });
  await until(() => contextRows(session.id).length === 1);
  assert.equal(terminals(session.id)[0]?.kind, 'turn-end');
  assert.deepEqual(contextRows(session.id)[0]?.payload, {
    kind: 'context-observation',
    confidence: 'unavailable',
    reason: 'invalid-observation',
  });
  assert.equal(JSON.stringify(listConversationEvents(session.id)).includes('SECRET'), false);
  await service.dispose();
});

test('disposal fences a pending context observation without manufacturing telemetry', async () => {
  freshDb();
  const project = newProject('context-disposal');
  let releaseLate!: () => void;
  const lateGate = new Promise<void>((resolve) => { releaseLate = resolve; });
  const runtime = new FakeRuntime({
    turns: [[{
      type: 'result', ok: true, stopReason: 'complete', usage: null,
      durationMs: 1, error: null, outcome: 'ok', numTurns: null,
    }]],
    contextObservation: async () => {
      await lateGate;
      return {
        confidence: 'exact', usedTokens: 1, usableTokens: 8, contextWindowTokens: 10,
      };
    },
  });
  const { service } = rig(project.id, runtime, { contextObservationTimeoutMs: 1_000 });
  const session = await service.ensureActiveSession();
  await service.handleSend({
    type: 'send', commandId: 'context-disposal-command', sessionId: session.id,
    text: 'go', clientMessageId: 'context-disposal-client',
  });
  await until(() => terminals(session.id).length === 1);
  await service.dispose();
  releaseLate();
  await new Promise((resolve) => setTimeout(resolve, 10));
  assert.equal(contextRows(session.id).length, 0);
});

test('session replacement fences a late context observation from the prior runtime', async () => {
  freshDb();
  const project = newProject('context-session-replacement');
  let releaseLate!: () => void;
  const lateGate = new Promise<void>((resolve) => { releaseLate = resolve; });
  const priorRuntime = new FakeRuntime({
    turns: [[{
      type: 'result', ok: true, stopReason: 'complete', usage: null,
      durationMs: 1, error: null, outcome: 'ok', numTurns: null,
    }]],
    contextObservation: async () => {
      await lateGate;
      return {
        confidence: 'exact', usedTokens: 1, usableTokens: 8, contextWindowTokens: 10,
      };
    },
  });
  const replacementRuntime = new FakeRuntime({
    turns: [[{
      type: 'result', ok: true, stopReason: 'complete', usage: null,
      durationMs: 1, error: null, outcome: 'ok', numTurns: null,
    }]],
    contextObservation: {
      confidence: 'exact', usedTokens: 2, usableTokens: 8, contextWindowTokens: 10,
    },
  });
  let mintCalls = 0;
  const service = new SessionService({
    projectId: project.id,
    mintSession: withRuntimeReceipt(() => (
      ++mintCalls === 1 ? priorRuntime : replacementRuntime
    )),
    ...testSessionSelectionDeps(),
    broadcast: () => {},
    contextObservationTimeoutMs: 5_000,
  });
  const prior = await service.ensureActiveSession();
  await service.handleSend({
    type: 'send', commandId: 'context-replacement-command', sessionId: prior.id,
    text: 'go', clientMessageId: 'context-replacement-client',
  });
  await until(() => terminals(prior.id).length === 1);
  const replacement = await service.startNewSession();
  assert.notEqual(replacement.id, prior.id);
  await service.handleSend({
    type: 'send', commandId: 'context-replacement-next-command', sessionId: replacement.id,
    text: 'next', clientMessageId: 'context-replacement-next-client',
  });
  await until(() => replacementRuntime.sentTexts.length === 1, 1_500);
  await until(() => contextRows(replacement.id).length === 1);
  assert.deepEqual(replacementRuntime.sentTexts, ['next']);
  releaseLate();
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(contextRows(prior.id).length, 0);
  await service.dispose();
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
