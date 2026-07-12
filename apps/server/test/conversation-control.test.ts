import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  createOrchestratorSession,
  enqueueConversationSend,
  getActiveConversationTurn,
  getConversationQueueSnapshot,
  getTurnInterruptRequest,
  listConversationEvents,
} from '@pc/db';
import type { ChatEvent, ServerFrame } from '@pc/contracts';
import type { ULID } from '@pc/domain';
import { ConversationRelay } from '../src/chat/conversation-relay.ts';
import { SessionRegistry } from '../src/chat/registry.ts';
import { SessionService } from '../src/chat/session-service.ts';
import { FakeRuntime } from '../src/runner/fake-runtime.ts';
import type { RuntimeEvent, RuntimeSession } from '../src/runner/runtime.ts';
import { ProjectWebSocketHub } from '../src/ws/hub.ts';
import { freshDb, newProject, sleep, until } from './helpers.ts';
import {
  TEST_SELECTION,
  testSessionSelectionDeps,
  withRuntimeReceipt,
} from './runtime-fixtures.ts';

function events(sessionId: string): ChatEvent[] {
  return listConversationEvents(sessionId).map((row) => row.payload as ChatEvent);
}

function terminals(sessionId: string): ChatEvent[] {
  return events(sessionId).filter((event) => event.kind === 'turn-end' || event.kind === 'turn-failed');
}

function serviceFor(projectId: ULID, runtime: FakeRuntime): SessionService {
  const hub = new ProjectWebSocketHub<ULID>();
  const relay = new ConversationRelay({ hub });
  return new SessionService({
    projectId,
    mintSession: withRuntimeReceipt(() => runtime),
    ...testSessionSelectionDeps(),
    broadcast: () => {},
    drainConversationOutbox: () => relay.drain(),
  });
}

test('confirmed interrupt-and-send releases exactly the edited FIFO head', async () => {
  freshDb();
  const project = newProject();
  let interrupts = 0;
  const runtime = new FakeRuntime({
    turns: [
      [{ type: 'assistant-block', itemId: 'working', scope: 'primary', block: { kind: 'text', text: 'working' } }, { hang: true }],
      [{ type: 'result', ok: true, stopReason: 'complete', usage: null, durationMs: 1, error: null, outcome: 'ok', numTurns: null }],
    ],
  });
  const nativeInterrupt = runtime.interrupt.bind(runtime);
  runtime.interrupt = async () => {
    interrupts++;
    await nativeInterrupt();
  };
  const service = serviceFor(project.id, runtime);
  const session = await service.ensureActiveSession();
  await service.handleSend({
    type: 'send', commandId: 'send-1', sessionId: session.id, text: 'first', clientMessageId: 'cm-1',
  });
  await until(() => getActiveConversationTurn(session.id) !== null);
  await until(() => runtime.sentTexts.length === 1);

  const queued = await service.handleSend({
    type: 'send', commandId: 'send-2', sessionId: session.id, text: 'old second', clientMessageId: 'cm-2',
  });
  assert.equal(queued.status, 'applied');
  assert.ok(queued.queueItemId);
  const edited = await service.handleConversationCommand({
    type: 'edit-queued-message',
    commandId: 'edit-2',
    sessionId: session.id,
    queueItemId: queued.queueItemId,
    expectedRevision: 1,
    text: 'edited second',
  });
  assert.equal(edited.status, 'applied');
  assert.equal(edited.revision, 2);

  const active = getActiveConversationTurn(session.id)!;
  const request = {
    type: 'interrupt-and-send' as const,
    requestId: 'interrupt-1',
    sessionId: session.id,
    targetTurnId: active.id,
    replacement: { kind: 'queued' as const, queueItemId: queued.queueItemId, expectedRevision: 2 },
  };
  const receipt = await service.handleConversationCommand(request);
  assert.equal(receipt.status, 'applied');
  // Transport replay is receipt-only; it cannot repeat the provider action.
  const duplicate = await service.handleConversationCommand(request);
  assert.equal(duplicate.status, 'duplicate');
  await until(() => interrupts === 1);
  assert.equal(interrupts, 1);

  await until(() => terminals(session.id).length === 2);
  assert.deepEqual(runtime.sentTexts, ['first', 'edited second']);
  const interruptStates = events(session.id)
    .filter((event): event is Extract<ChatEvent, { kind: 'interrupt-state' }> => event.kind === 'interrupt-state');
  assert.deepEqual(interruptStates.map((event) => event.state), ['requested', 'confirmed']);
  assert.equal(interruptStates[1]?.result, 'aborted');
  await service.dispose();
});

test('native interrupt rejection durably fails the request and blocks its replacement', async () => {
  freshDb();
  const project = newProject();
  const runtime = new FakeRuntime({ turns: [[{ hang: true }]] });
  runtime.interrupt = async () => {
    throw new Error('SECRET native interrupt rejection detail');
  };
  const service = serviceFor(project.id, runtime);
  const session = await service.ensureActiveSession();
  await service.handleSend({
    type: 'send', commandId: 'send-1', sessionId: session.id, text: 'first', clientMessageId: 'cm-1',
  });
  await until(() => getActiveConversationTurn(session.id) !== null);
  const active = getActiveConversationTurn(session.id)!;
  const receipt = await service.handleConversationCommand({
    type: 'interrupt-and-send',
    requestId: 'interrupt-fails',
    sessionId: session.id,
    targetTurnId: active.id,
    replacement: { kind: 'new', clientMessageId: 'cm-replacement', text: 'replacement' },
  });
  assert.equal(receipt.status, 'applied');
  await until(() => events(session.id).some((event) => event.kind === 'interrupt-state' && event.state === 'failed'));
  const failed = events(session.id).find(
    (event): event is Extract<ChatEvent, { kind: 'interrupt-state' }> =>
      event.kind === 'interrupt-state' && event.state === 'failed',
  );
  assert.equal(failed?.failure?.code, 'runtime-interrupt-failed');
  assert.equal(failed?.failure?.message, 'the runtime did not accept the interruption request');
  const replacement = getConversationQueueSnapshot(session.id).items.find(
    (item) => item.clientMessageId === 'cm-replacement',
  );
  assert.equal(replacement?.status, 'failed');
  assert.equal(JSON.stringify(events(session.id)).includes('SECRET'), false);
  assert.equal(JSON.stringify(getConversationQueueSnapshot(session.id)).includes('SECRET'), false);
  assert.deepEqual(runtime.sentTexts, ['first']);
  // Restore a successful interrupt so disposal can release the fake hung turn.
  runtime.interrupt = FakeRuntime.prototype.interrupt.bind(runtime);
  await service.dispose();
  await until(() => terminals(session.id).length === 1);
});

test('abort-like stream exception cannot confirm an interrupt or release its replacement', async () => {
  freshDb();
  const project = newProject('false-abort');
  const sentTexts: string[] = [];
  const runtime: RuntimeSession = {
    sendTurn(text: string): AsyncIterable<RuntimeEvent> {
      sentTexts.push(text);
      return (async function* (): AsyncGenerator<RuntimeEvent> {
        await sleep(25);
        throw new Error('AbortError: transport aborted independently');
      })();
    },
    observeContext: async () => ({ confidence: 'unavailable', reason: 'unsupported' }),
    interrupt: () => new Promise<void>(() => {}),
    async dispose() {},
  };
  const service = new SessionService({
    projectId: project.id,
    mintSession: withRuntimeReceipt(() => runtime),
    ...testSessionSelectionDeps(),
    broadcast: () => {},
    interruptTimeoutMs: 1_000,
  });
  const session = await service.ensureActiveSession();
  await service.handleSend({
    type: 'send', commandId: 'false-abort-send', sessionId: session.id,
    text: 'first', clientMessageId: 'false-abort-client',
  });
  await until(() => getActiveConversationTurn(session.id) !== null);
  const active = getActiveConversationTurn(session.id)!;
  const receipt = await service.handleConversationCommand({
    type: 'interrupt-and-send', requestId: 'false-abort-interrupt', sessionId: session.id,
    targetTurnId: active.id,
    replacement: { kind: 'new', clientMessageId: 'false-abort-next', text: 'must stay blocked' },
  });
  assert.equal(receipt.status, 'applied');
  await until(() => terminals(session.id).length === 1);
  assert.equal(getTurnInterruptRequest('false-abort-interrupt')?.status, 'failed');
  assert.equal(
    events(session.id).some((event) => event.kind === 'interrupt-state' && event.state === 'confirmed'),
    false,
  );
  assert.equal(
    getConversationQueueSnapshot(session.id).items.find((item) => item.clientMessageId === 'false-abort-next')?.status,
    'failed',
  );
  assert.deepEqual(sentTexts, ['first']);
  await service.dispose();
});

test('interrupt receipt is immediate and an inconclusive native attempt is quarantined across turns', async () => {
  freshDb();
  const project = newProject('interrupt-quarantine');
  let interruptResolved = false;
  let disposed = false;
  let currentAbort: (() => void) | null = null;
  const firstTexts: string[] = [];
  const firstRuntime: RuntimeSession = {
    sendTurn(text: string): AsyncIterable<RuntimeEvent> {
      firstTexts.push(text);
      let abort = false;
      let resolveAbort!: () => void;
      const aborted = new Promise<void>((resolve) => {
        resolveAbort = resolve;
      });
      const abortCurrent = () => {
        abort = true;
        resolveAbort();
      };
      currentAbort = abortCurrent;
      return (async function* (): AsyncGenerator<RuntimeEvent> {
        await Promise.race([sleep(60), aborted]);
        if (currentAbort === abortCurrent) currentAbort = null;
        yield abort
          ? {
              type: 'result', ok: false, stopReason: null, usage: null, durationMs: 1,
              error: 'interrupted', outcome: 'aborted', numTurns: null,
            }
          : {
              type: 'result', ok: true, stopReason: 'complete', usage: null, durationMs: 60,
              error: null, outcome: 'ok', numTurns: null,
            };
      })();
    },
    observeContext: async () => ({ confidence: 'unavailable', reason: 'unsupported' }),
    interrupt(): Promise<void> {
      return new Promise((resolve) => {
        setTimeout(() => {
          currentAbort?.();
          interruptResolved = true;
          resolve();
        }, 90);
      });
    },
    async dispose(): Promise<void> {
      disposed = true;
      currentAbort?.();
    },
  };
  const successor = new FakeRuntime();
  let mintCount = 0;
  const service = new SessionService({
    projectId: project.id,
    mintSession: withRuntimeReceipt(() => mintCount++ === 0 ? firstRuntime : successor),
    ...testSessionSelectionDeps(),
    broadcast: () => {},
    interruptTimeoutMs: 15,
  });
  const session = await service.ensureActiveSession();
  await service.handleSend({
    type: 'send', commandId: 'quarantine-send-1', sessionId: session.id,
    text: 'first', clientMessageId: 'quarantine-client-1',
  });
  await until(() => getActiveConversationTurn(session.id) !== null);

  const active = getActiveConversationTurn(session.id)!;
  const receipt = await service.handleConversationCommand({
    type: 'interrupt', requestId: 'quarantine-interrupt', sessionId: session.id,
    targetTurnId: active.id,
  });
  assert.equal(receipt.status, 'applied');
  assert.equal(interruptResolved, false, 'sender receipt cannot await native interruption');
  await service.handleSend({
    type: 'send', commandId: 'quarantine-send-2', sessionId: session.id,
    text: 'second', clientMessageId: 'quarantine-client-2',
  });

  await until(() => terminals(session.id).length === 2);
  await sleep(100); // let the original, deliberately late interrupt resolve
  const request = getTurnInterruptRequest('quarantine-interrupt');
  assert.equal(request?.status, 'failed');
  assert.equal(request?.failureCode, 'runtime-interrupt-inconclusive');
  assert.equal(disposed, true);
  assert.deepEqual(firstTexts, ['first']);
  assert.deepEqual(successor.sentTexts, ['second']);
  assert.equal(terminals(session.id).at(-1)?.kind, 'turn-end');
  await service.dispose();
});

test('service shutdown fails an uncertain interrupt before runtime disposal can emit abort', async () => {
  freshDb();
  const project = newProject('interrupt-shutdown');
  const runtime = new FakeRuntime({ turns: [[{ hang: true }]] });
  runtime.interrupt = () => new Promise<void>(() => {});
  const service = new SessionService({
    projectId: project.id,
    mintSession: withRuntimeReceipt(() => runtime),
    ...testSessionSelectionDeps(),
    broadcast: () => {},
    interruptTimeoutMs: 5_000,
  });
  const session = await service.ensureActiveSession();
  await service.handleSend({
    type: 'send', commandId: 'shutdown-send', sessionId: session.id,
    text: 'first', clientMessageId: 'shutdown-client',
  });
  await until(() => getActiveConversationTurn(session.id) !== null);
  await until(() => runtime.sentTexts.length === 1);
  const active = getActiveConversationTurn(session.id)!;
  const receipt = await service.handleConversationCommand({
    type: 'interrupt-and-send', requestId: 'shutdown-interrupt', sessionId: session.id,
    targetTurnId: active.id,
    replacement: { kind: 'new', clientMessageId: 'shutdown-replacement', text: 'must not run' },
  });
  assert.equal(receipt.status, 'applied');

  await service.dispose();
  await until(() => terminals(session.id).length === 1);
  const request = getTurnInterruptRequest('shutdown-interrupt');
  assert.equal(request?.status, 'failed');
  assert.equal(request?.failureCode, 'runtime-interrupt-inconclusive');
  assert.equal(
    events(session.id).some((event) => event.kind === 'interrupt-state' && event.state === 'confirmed'),
    false,
  );
  const replacement = getConversationQueueSnapshot(session.id).items.find(
    (item) => item.clientMessageId === 'shutdown-replacement',
  );
  assert.equal(replacement?.status, 'failed');
  assert.deepEqual(runtime.sentTexts, ['first']);
});

test('projection callback failure cannot strand a committed interrupt request', async () => {
  freshDb();
  const project = newProject('interrupt-projection-failure');
  const runtime = new FakeRuntime({ turns: [[{ hang: true }]] });
  let interrupts = 0;
  const nativeInterrupt = runtime.interrupt.bind(runtime);
  runtime.interrupt = async () => {
    interrupts += 1;
    await nativeInterrupt();
  };
  let failNextBroadcast = false;
  const service = new SessionService({
    projectId: project.id,
    mintSession: withRuntimeReceipt(() => runtime),
    ...testSessionSelectionDeps(),
    broadcast: () => {
      if (failNextBroadcast) {
        failNextBroadcast = false;
        throw new Error('socket send failed');
      }
    },
  });
  const session = await service.ensureActiveSession();
  await service.handleSend({
    type: 'send', commandId: 'projection-send', sessionId: session.id,
    text: 'first', clientMessageId: 'projection-client',
  });
  await until(() => getActiveConversationTurn(session.id) !== null);
  await until(() => runtime.sentTexts.length === 1);
  const active = getActiveConversationTurn(session.id)!;
  failNextBroadcast = true;
  await assert.rejects(
    service.handleConversationCommand({
      type: 'interrupt', requestId: 'projection-interrupt', sessionId: session.id,
      targetTurnId: active.id,
    }),
    /socket send failed/,
  );
  await until(() => getTurnInterruptRequest('projection-interrupt')?.status !== 'requested');
  assert.equal(interrupts, 1);
  assert.equal(getTurnInterruptRequest('projection-interrupt')?.status, 'confirmed');
  await service.dispose();
});

test('websocket hub isolates a throwing socket from durable projection fanout', () => {
  const hub = new ProjectWebSocketHub<string>();
  const sent: string[] = [];
  hub.subscribe('project', { OPEN: 1, readyState: 1, send: () => { throw new Error('dead socket'); } });
  hub.subscribe('project', { OPEN: 1, readyState: 1, send: (data) => sent.push(data) });
  assert.doesNotThrow(() => hub.broadcast('project', { type: 'frame' }));
  assert.equal(hub.count('project'), 1);
  assert.deepEqual(sent.map((value) => JSON.parse(value)), [{ type: 'frame' }]);
});

test('registry drains durable queued work only after the explicit boot-readiness kick', async () => {
  freshDb();
  const project = newProject();
  const session = createOrchestratorSession({ projectId: project.id, selection: TEST_SELECTION });
  const queued = enqueueConversationSend({
    projectId: project.id,
    conversationId: session.id,
    sessionId: session.id,
    commandId: 'boot-send',
    clientMessageId: 'boot-cm',
    text: 'survived restart',
    origin: 'user',
  });
  assert.equal(queued.status, 'applied');

  const runtime = new FakeRuntime();
  let mintCalls = 0;
  const hub = new ProjectWebSocketHub<ULID>();
  const relay = new ConversationRelay({ hub });
  const registry = new SessionRegistry({
    hub,
    conversationRelay: relay,
    mintSession: withRuntimeReceipt(() => {
      mintCalls += 1;
      return runtime;
    }),
    ...testSessionSelectionDeps(),
  });
  await Promise.resolve();
  await Promise.resolve();
  assert.equal(mintCalls, 0, 'registry construction cannot mint before composition readiness');
  assert.deepEqual(runtime.sentTexts, []);

  registry.kickRecoveredQueues();
  await until(() => terminals(session.id).length === 1);
  assert.equal(mintCalls, 1);
  assert.deepEqual(runtime.sentTexts, ['survived restart']);
  await registry.disposeAll();
});

test('fresh sends admitted during boot remain durable but cannot mint until readiness release', async () => {
  freshDb();
  const project = newProject('boot-admission-gate');
  const runtime = new FakeRuntime();
  let mintCalls = 0;
  const registry = new SessionRegistry({
    hub: new ProjectWebSocketHub<ULID>(),
    mintSession: withRuntimeReceipt(() => {
      mintCalls += 1;
      return runtime;
    }),
    ...testSessionSelectionDeps(),
  });
  const service = registry.get(project.id);
  const session = await service.ensureActiveSession();
  const receipt = await service.handleSend({
    type: 'send', commandId: 'boot-live-send', sessionId: session.id,
    text: 'wait for composition', clientMessageId: 'boot-live-client',
  });
  assert.equal(receipt.status, 'applied');
  await Promise.resolve();
  await Promise.resolve();
  assert.equal(mintCalls, 0);
  assert.equal(getConversationQueueSnapshot(session.id).items[0]?.status, 'queued');

  registry.kickRecoveredQueues();
  await until(() => terminals(session.id).length === 1);
  assert.equal(mintCalls, 1);
  assert.deepEqual(runtime.sentTexts, ['wait for composition']);
  await registry.disposeAll();
});

test('session switching cancels queued rows, but refuses an active claimed turn', async () => {
  freshDb();
  const project = newProject();
  const session = createOrchestratorSession({ projectId: project.id, selection: TEST_SELECTION });
  enqueueConversationSend({
    projectId: project.id,
    conversationId: session.id,
    sessionId: session.id,
    commandId: 'queued-send',
    clientMessageId: 'queued-cm',
    text: 'cancel me',
    origin: 'user',
  });
  const service = serviceFor(project.id, new FakeRuntime());
  const same = await service.resumeSession(session.id);
  assert.equal(same?.id, session.id);
  assert.equal(getConversationQueueSnapshot(session.id).items[0]?.status, 'queued');
  const replacement = await service.startNewSession();
  assert.notEqual(replacement.id, session.id);
  const cancellation = events(session.id).filter(
    (event): event is Extract<ChatEvent, { kind: 'send-state' }> =>
      event.kind === 'send-state' && event.item.clientMessageId === 'queued-cm',
  ).at(-1);
  assert.equal(cancellation?.item.status, 'cancelled');

  const hung = new FakeRuntime({ turns: [[{ hang: true }]] });
  const activeService = serviceFor(newProject('active').id, hung);
  const activeSession = await activeService.ensureActiveSession();
  await activeService.handleSend({
    type: 'send', commandId: 'active-send', sessionId: activeSession.id, text: 'busy', clientMessageId: 'active-cm',
  });
  await until(() => getActiveConversationTurn(activeSession.id) !== null);
  assert.equal(activeService.canSwitchSession(), false);
  await assert.rejects(
    activeService.startNewSession(),
    /runtime selection rejected: session-active/,
  );
  assert.equal((await activeService.resumeSession(activeSession.id))?.id, activeSession.id);
  assert.equal(getActiveConversationTurn(activeSession.id)?.sessionId, activeSession.id);
  await activeService.dispose();
  await service.dispose();
});

test('dispose fences a turn whose runtime mint resolves after shutdown', async () => {
  freshDb();
  const project = newProject('dispose-fence');
  let resolveMint!: (runtime: RuntimeSession) => void;
  const mintPending = new Promise<RuntimeSession>((resolve) => {
    resolveMint = resolve;
  });
  const service = new SessionService({
    projectId: project.id,
    mintSession: withRuntimeReceipt(() => mintPending),
    ...testSessionSelectionDeps(),
    broadcast: () => {},
  });
  const session = await service.ensureActiveSession();
  await service.handleSend({
    type: 'send',
    commandId: 'dispose-send',
    sessionId: session.id,
    text: 'must not send after dispose',
    clientMessageId: 'dispose-client',
  });
  await until(() => getActiveConversationTurn(session.id) !== null);

  await service.dispose();
  const lateRuntime = new FakeRuntime();
  let disposeCalls = 0;
  const nativeDispose = lateRuntime.dispose.bind(lateRuntime);
  lateRuntime.dispose = async () => {
    disposeCalls += 1;
    await nativeDispose();
  };
  resolveMint(lateRuntime);
  await until(() => disposeCalls === 1);

  assert.deepEqual(lateRuntime.sentTexts, []);
  assert.ok(getActiveConversationTurn(session.id), 'boot recovery retains the uncertain claimed turn');
  assert.equal(terminals(session.id).length, 0);
});
