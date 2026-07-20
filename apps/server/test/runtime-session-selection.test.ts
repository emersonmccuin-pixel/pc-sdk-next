import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  confirmRuntimeSessionReceipt,
  createProject,
  getActiveConversationTurn,
  getActiveOrchestratorSession,
  getConversationQueueSnapshot,
  getOrchestratorSession,
  getProjectById,
  listConversationEvents,
  settleConversationTurn,
} from '@pc/db';
import type {
  RuntimeSelection,
  RuntimeSelectionValidation,
  ServerFrame,
} from '@pc/contracts';
import { SessionService } from '../src/chat/session-service.ts';
import { FakeRuntime } from '../src/runner/fake-runtime.ts';
import {
  RuntimeSelectionRejectedError,
  type MintRuntimeSession,
  type RuntimeSession,
} from '../src/runner/runtime.ts';
import { freshDb, newProject, until } from './helpers.ts';
import {
  TEST_SELECTION,
  runtimeReceiptFor,
  testSessionSelectionDeps,
  withRuntimeReceipt,
} from './runtime-fixtures.ts';

function deferred<T = void>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}

const terminal = {
  type: 'result' as const,
  ok: true as const,
  stopReason: 'complete' as const,
  usage: null,
  durationMs: 1,
  error: null,
  outcome: 'ok' as const,
  numTurns: 1,
};

function terminalCount(sessionId: string): number {
  return listConversationEvents(sessionId).filter((row) =>
    row.eventType === 'turn-end' || row.eventType === 'turn-failed',
  ).length;
}

function copyContext(ctx: MintRuntimeSession): MintRuntimeSession {
  return {
    ...ctx,
    selection: structuredClone(ctx.selection),
    continuation: { ...ctx.continuation },
  };
}

test('creation, restart remint, and mutable defaults all use the immutable row stamp', async () => {
  freshDb();
  const project = newProject('immutable-selection');
  let nextSelection: RuntimeSelection = structuredClone(TEST_SELECTION);
  let rev = 1;
  const minted: MintRuntimeSession[] = [];
  const frames: ServerFrame[] = [];
  const preflighted: Array<{ selection: RuntimeSelection; mode: string }> = [];
  const mintSession = withRuntimeReceipt((ctx) => {
    minted.push(copyContext(ctx));
    return new FakeRuntime({ turns: [[terminal]] });
  });
  const service = new SessionService({
    projectId: project.id,
    broadcast: (frame) => frames.push(frame),
    mintSession,
    resolveNewSessionSelection: async (): Promise<RuntimeSelectionValidation> => ({
      status: 'valid', selection: structuredClone(nextSelection),
    }),
    preflightRuntimeSession: async (selection, continuation) => {
      preflighted.push({ selection: structuredClone(selection), mode: continuation.mode });
      return { status: 'valid', selection };
    },
    orchestratorRev: () => rev,
  });

  const session = await service.ensureActiveSession();
  nextSelection = {
    runtimeId: TEST_SELECTION.runtimeId,
    accountId: 'work',
    model: 'sonnet',
    effort: { kind: 'selected', value: 'high' },
  };
  assert.equal((await service.handleSend({
    type: 'send', commandId: 'immutable-1', sessionId: session.id,
    text: 'first', clientMessageId: 'immutable-client-1',
  })).status, 'applied');
  await until(() => terminalCount(session.id) === 1);
  const bound = getOrchestratorSession(session.id)!;
  assert.deepEqual(minted[0]!.selection, TEST_SELECTION);
  assert.equal(minted[0]!.continuation.mode, 'create');
  assert.equal(bound.nativeIdentityState, 'bound');
  assert.equal(bound.continuationState, 'clean-started');
  assert.equal(frames.some((frame) =>
    frame.type === 'session-updated' && frame.session.continuationState === 'clean-started'
  ), true);

  // Prompt/default revision remints the native loop, but never the selection.
  rev = 2;
  assert.equal((await service.handleSend({
    type: 'send', commandId: 'immutable-2', sessionId: session.id,
    text: 'second', clientMessageId: 'immutable-client-2',
  })).status, 'applied');
  await until(() => terminalCount(session.id) === 2);
  assert.equal(minted.length, 2);
  assert.deepEqual(minted[1]!.selection, TEST_SELECTION);
  assert.notEqual(minted[1]!.continuationAttemptId, minted[0]!.continuationAttemptId);
  assert.deepEqual(minted[1]!.continuation, {
    mode: 'resume', nativeSessionId: bound.nativeSessionId,
  });
  assert.equal(preflighted.at(-1)?.mode, 'resume');
  assert.deepEqual(preflighted.at(-1)?.selection, TEST_SELECTION);
  assert.equal(getOrchestratorSession(session.id)?.continuationState, 'native-resumed');
  assert.equal(
    getOrchestratorSession(session.id)?.continuationAttemptId,
    minted[1]!.continuationAttemptId,
  );
  assert.equal(frames.some((frame) =>
    frame.type === 'session-updated' && frame.session.continuationState === 'native-resumed'
  ), true);
  await service.dispose();
});

test('account A to B then historical A resume routes through A while B stays the project default', async () => {
  freshDb();
  const project = newProject('account-roundtrip');
  const minted: MintRuntimeSession[] = [];
  const deps = testSessionSelectionDeps();
  const service = new SessionService({
    projectId: project.id,
    broadcast: () => {},
    mintSession: withRuntimeReceipt((ctx) => {
      minted.push(copyContext(ctx));
      return new FakeRuntime({ turns: [[terminal]] });
    }),
    ...deps,
  });

  const accountA = await service.ensureActiveSession();
  await service.handleSend({
    type: 'send', commandId: 'account-a', sessionId: accountA.id,
    text: 'A', clientMessageId: 'account-a-client',
  });
  await until(() => terminalCount(accountA.id) === 1);
  const accountANativeId = getOrchestratorSession(accountA.id)!.nativeSessionId;

  const accountB = await service.switchAccountSession('work');
  await service.handleSend({
    type: 'send', commandId: 'account-b', sessionId: accountB.id,
    text: 'B', clientMessageId: 'account-b-client',
  });
  await until(() => terminalCount(accountB.id) === 1);
  assert.equal((await service.resumeSession(accountA.id))?.id, accountA.id);
  await service.handleSend({
    type: 'send', commandId: 'account-a-resumed', sessionId: accountA.id,
    text: 'A again', clientMessageId: 'account-a-resumed-client',
  });
  await until(() => terminalCount(accountA.id) === 2);

  const resumedMint = minted.at(-1)!;
  assert.equal(resumedMint.selection.accountId, 'personal');
  assert.deepEqual(resumedMint.continuation, {
    mode: 'resume', nativeSessionId: accountANativeId,
  });
  assert.equal(getActiveOrchestratorSession(project.id)?.id, accountA.id);
  assert.equal(getOrchestratorSession(accountB.id)?.status, 'ended');
  assert.equal(getOrchestratorSession(accountA.id)?.continuationState, 'native-resumed');
  assert.equal(getProjectById(project.id)?.settings.defaultAccountId, 'work');
  await service.dispose();
});

test('negative resume preflight preserves the active session, FIFO, and project default', async () => {
  freshDb();
  const project = newProject('resume-preflight-rollback');
  let rejectResume = false;
  const baseDeps = testSessionSelectionDeps();
  const service = new SessionService({
    projectId: project.id,
    broadcast: () => {},
    mintSession: withRuntimeReceipt(() => new FakeRuntime({ turns: [[terminal]] })),
    resolveNewSessionSelection: baseDeps.resolveNewSessionSelection,
    preflightRuntimeSession: async (selection, continuation) => {
      if (rejectResume && continuation.mode === 'resume') {
        return { status: 'invalid', code: 'account-unavailable' };
      }
      return { status: 'valid', selection };
    },
    queueDrainEnabled: false,
  });

  const accountA = await service.ensureActiveSession();
  const nativeA = `native-${accountA.id}`;
  assert.equal(confirmRuntimeSessionReceipt({
    sessionId: accountA.id,
    receipt: {
      mode: 'created', selection: TEST_SELECTION, nativeSessionId: nativeA,
      continuationAttemptId: accountA.continuationAttemptId!,
      requestedNativeSessionId: null,
    },
  }).status, 'confirmed');
  const accountB = await service.switchAccountSession('work');
  assert.equal((await service.handleSend({
    type: 'send', commandId: 'queued-b', sessionId: accountB.id,
    text: 'preserve me', clientMessageId: 'queued-b-client',
  })).status, 'applied');
  rejectResume = true;

  await assert.rejects(
    () => service.resumeSession(accountA.id),
    (error: unknown) =>
      error instanceof RuntimeSelectionRejectedError && error.code === 'account-unavailable',
  );
  assert.equal(getActiveOrchestratorSession(project.id)?.id, accountB.id);
  assert.equal(getOrchestratorSession(accountA.id)?.status, 'ended');
  assert.equal(getProjectById(project.id)?.settings.defaultAccountId, 'work');
  assert.deepEqual(
    getConversationQueueSnapshot(accountB.id).items.map((item) => [item.text, item.status]),
    [['preserve me', 'queued']],
  );
  await service.dispose();
});

test('concurrent first sends resolve one selection and preserve call-order FIFO in one session', async () => {
  freshDb();
  const project = newProject('concurrent-first-sends');
  const gate = deferred();
  let selectionResolutions = 0;
  const service = new SessionService({
    projectId: project.id,
    broadcast: () => {},
    mintSession: withRuntimeReceipt(() => new FakeRuntime({ turns: [[terminal]] })),
    resolveNewSessionSelection: async () => {
      selectionResolutions += 1;
      await gate.promise;
      return { status: 'valid' as const, selection: structuredClone(TEST_SELECTION) };
    },
    preflightRuntimeSession: testSessionSelectionDeps().preflightRuntimeSession,
    queueDrainEnabled: false,
  });

  const first = service.handleSend({
    type: 'send', commandId: 'first-command', sessionId: null,
    text: 'first', clientMessageId: 'first-client',
  });
  const second = service.handleSend({
    type: 'send', commandId: 'second-command', sessionId: null,
    text: 'second', clientMessageId: 'second-client',
  });
  await until(() => selectionResolutions === 1);
  gate.resolve();
  const [firstReceipt, secondReceipt] = await Promise.all([first, second]);

  assert.equal(firstReceipt.status, 'applied');
  assert.equal(secondReceipt.status, 'applied');
  assert.equal(selectionResolutions, 1);
  const active = getActiveOrchestratorSession(project.id)!;
  assert.equal(firstReceipt.sessionId, active.id);
  assert.equal(secondReceipt.sessionId, active.id);
  assert.deepEqual(
    getConversationQueueSnapshot(active.id).items.map((item) => item.text),
    ['first', 'second'],
  );
  await service.dispose();
});

test('account switch rejects a resolver result that does not match the requested account', async () => {
  freshDb();
  const project = newProject('resolver-account-mismatch');
  const service = new SessionService({
    projectId: project.id,
    broadcast: () => {},
    mintSession: withRuntimeReceipt(() => new FakeRuntime({ turns: [[terminal]] })),
    resolveNewSessionSelection: async () => ({
      status: 'valid', selection: structuredClone(TEST_SELECTION),
    }),
    preflightRuntimeSession: testSessionSelectionDeps().preflightRuntimeSession,
    queueDrainEnabled: false,
  });
  const original = await service.ensureActiveSession();

  await assert.rejects(
    () => service.switchAccountSession('work'),
    (error: unknown) =>
      error instanceof RuntimeSelectionRejectedError && error.code === 'account-runtime-mismatch',
  );
  assert.equal(getActiveOrchestratorSession(project.id)?.id, original.id);
  assert.equal(getProjectById(project.id)?.settings.defaultAccountId, null);
  assert.equal(getOrchestratorSession(original.id)?.accountId, 'personal');
  await service.dispose();
});

test('runtime switch stamps the new session, persists the project default, and ends the prior session', async () => {
  freshDb();
  const project = newProject('runtime-roundtrip');
  const service = new SessionService({
    projectId: project.id,
    broadcast: () => {},
    mintSession: withRuntimeReceipt(() => new FakeRuntime({ turns: [[terminal]] })),
    ...testSessionSelectionDeps(),
    queueDrainEnabled: false,
  });
  const claudeSession = await service.ensureActiveSession();
  assert.equal(getOrchestratorSession(claudeSession.id)?.runtimeId, TEST_SELECTION.runtimeId);

  const codexSession = await service.switchRuntimeSession('openai-codex');
  assert.notEqual(codexSession.id, claudeSession.id);
  assert.equal(getOrchestratorSession(codexSession.id)?.runtimeId, 'openai-codex');
  assert.equal(getOrchestratorSession(claudeSession.id)?.status, 'ended');
  assert.equal(getOrchestratorSession(claudeSession.id)?.endedReason, 'runtime_switched');
  assert.equal(getProjectById(project.id)?.settings.defaultRuntimeId, 'openai-codex');
  assert.equal(getActiveOrchestratorSession(project.id)?.id, codexSession.id);
  await service.dispose();
});

test('runtime switch rejects a resolver result that does not match the requested runtime', async () => {
  freshDb();
  const project = newProject('resolver-runtime-mismatch');
  const service = new SessionService({
    projectId: project.id,
    broadcast: () => {},
    mintSession: withRuntimeReceipt(() => new FakeRuntime({ turns: [[terminal]] })),
    resolveNewSessionSelection: async () => ({
      status: 'valid', selection: structuredClone(TEST_SELECTION),
    }),
    preflightRuntimeSession: testSessionSelectionDeps().preflightRuntimeSession,
    queueDrainEnabled: false,
  });
  const original = await service.ensureActiveSession();

  await assert.rejects(
    () => service.switchRuntimeSession('openai-codex'),
    (error: unknown) =>
      error instanceof RuntimeSelectionRejectedError && error.code === 'runtime-not-registered',
  );
  assert.equal(getActiveOrchestratorSession(project.id)?.id, original.id);
  assert.equal(getProjectById(project.id)?.settings.defaultRuntimeId, null);
  assert.equal(getOrchestratorSession(original.id)?.runtimeId, TEST_SELECTION.runtimeId);
  await service.dispose();
});

test('a recovered resume-pending session is re-preflighted and never falls back to create', async () => {
  freshDb();
  const project = newProject('resume-pending-revalidation');
  let rejectResume = false;
  let resumePreflights = 0;
  const minted: MintRuntimeSession[] = [];
  const baseDeps = testSessionSelectionDeps();
  const service = new SessionService({
    projectId: project.id,
    broadcast: () => {},
    mintSession: withRuntimeReceipt((ctx) => {
      minted.push(copyContext(ctx));
      return new FakeRuntime({ turns: [[terminal]] });
    }),
    resolveNewSessionSelection: baseDeps.resolveNewSessionSelection,
    preflightRuntimeSession: async (selection, continuation) => {
      if (continuation.mode === 'resume') {
        resumePreflights += 1;
        if (rejectResume) return { status: 'invalid', code: 'account-unavailable' };
      }
      return { status: 'valid', selection };
    },
  });

  const accountA = await service.ensureActiveSession();
  await service.handleSend({
    type: 'send', commandId: 'pending-a', sessionId: accountA.id,
    text: 'bind A', clientMessageId: 'pending-a-client',
  });
  await until(() => terminalCount(accountA.id) === 1);
  await service.switchAccountSession('work');
  assert.equal((await service.resumeSession(accountA.id))?.id, accountA.id);
  assert.equal(getOrchestratorSession(accountA.id)?.continuationState, 'resume-pending');
  rejectResume = true;
  const mintsBeforeSend = minted.length;

  assert.equal((await service.handleSend({
    type: 'send', commandId: 'pending-resume', sessionId: accountA.id,
    text: 'must not clean start', clientMessageId: 'pending-resume-client',
  })).status, 'applied');
  await until(() => terminalCount(accountA.id) === 2);

  assert.equal(resumePreflights, 2, 'historical activation and runtime mint each preflight');
  assert.equal(minted.length, mintsBeforeSend, 'negative resume preflight cannot mint any runtime');
  assert.equal(getOrchestratorSession(accountA.id)?.continuationState, 'resume-failed');
  const failedEvent = listConversationEvents(accountA.id)
    .filter((row) => row.eventType === 'turn-failed')
    .at(-1);
  assert.equal((failedEvent?.payload as { kind?: unknown } | undefined)?.kind, 'turn-failed');
  await service.dispose();
});

for (const firstAttempt of ['missing', 'mismatched'] as const) {
  test(`${firstAttempt} resume receipt fails closed and a retry remains native resume`, async () => {
    freshDb();
    const project = newProject(`${firstAttempt}-resume-receipt`);
    const minted: MintRuntimeSession[] = [];
    const frames: ServerFrame[] = [];
    const service = new SessionService({
      projectId: project.id,
      broadcast: (frame) => frames.push(frame),
      mintSession: async (ctx): Promise<RuntimeSession> => {
        const mintIndex = minted.push(copyContext(ctx));
        return {
          sendTurn() {
            return (async function* () {
              if (mintIndex === 1 && firstAttempt === 'mismatched') {
                const started = runtimeReceiptFor(ctx);
                yield {
                  ...started,
                  receipt: {
                    ...started.receipt,
                    selection: { ...started.receipt.selection, accountId: 'wrong-account' },
                  },
                };
              } else if (mintIndex > 1) {
                yield runtimeReceiptFor(ctx);
              }
              yield terminal;
            })();
          },
          observeContext: async () => ({ confidence: 'unavailable', reason: 'unsupported' }),
          interrupt: async () => {},
          dispose: async () => {},
        };
      },
      ...testSessionSelectionDeps(),
    });

    const session = await service.ensureActiveSession();
    const nativeSessionId = `native-${session.id}`;
    assert.equal(confirmRuntimeSessionReceipt({
      sessionId: session.id,
      receipt: {
        mode: 'created', selection: TEST_SELECTION, nativeSessionId,
        continuationAttemptId: session.continuationAttemptId!,
        requestedNativeSessionId: null,
      },
    }).status, 'confirmed');
    await service.handleSend({
      type: 'send', commandId: `${firstAttempt}-first`, sessionId: session.id,
      text: 'first resume', clientMessageId: `${firstAttempt}-first-client`,
    });
    await until(() => terminalCount(session.id) === 1);
    assert.equal(getOrchestratorSession(session.id)?.continuationState, 'resume-failed');
    assert.equal(frames.some((frame) =>
      frame.type === 'session-updated' && frame.session.continuationState === 'resume-failed'
    ), true);

    await service.handleSend({
      type: 'send', commandId: `${firstAttempt}-retry`, sessionId: session.id,
      text: 'retry resume', clientMessageId: `${firstAttempt}-retry-client`,
    });
    await until(() => terminalCount(session.id) === 2);

    assert.equal(minted.length, 2);
    assert.deepEqual(minted.map((ctx) => ctx.continuation.mode), ['resume', 'resume']);
    assert.equal(getOrchestratorSession(session.id)?.continuationState, 'native-resumed');
    assert.equal(frames.some((frame) =>
      frame.type === 'session-updated' && frame.session.continuationState === 'native-resumed'
    ), true);
    await service.dispose();
  });
}

test('a stale receipt on the current stream cannot fail the current resume attempt', async () => {
  freshDb();
  const project = newProject('current-stream-stale-receipt');
  const minted: MintRuntimeSession[] = [];
  const service = new SessionService({
    projectId: project.id,
    broadcast: () => {},
    mintSession: async (ctx): Promise<RuntimeSession> => {
      minted.push(copyContext(ctx));
      return {
        sendTurn() {
          return (async function* () {
            yield {
              type: 'session-started' as const,
              receipt: {
                mode: 'resumed' as const,
                continuationAttemptId: abandonedAttempt,
                selection: ctx.selection,
                nativeSessionId,
                requestedNativeSessionId: nativeSessionId,
              },
            };
            yield terminal;
          })();
        },
        observeContext: async () => ({ confidence: 'unavailable', reason: 'unsupported' }),
        interrupt: async () => {},
        dispose: async () => {},
      };
    },
    ...testSessionSelectionDeps(),
  });

  const session = await service.ensureActiveSession();
  const nativeSessionId = `native-${session.id}`;
  const abandonedAttempt = session.continuationAttemptId!;
  assert.equal(confirmRuntimeSessionReceipt({
    sessionId: session.id,
    receipt: {
      mode: 'created',
      continuationAttemptId: abandonedAttempt,
      selection: TEST_SELECTION,
      nativeSessionId,
      requestedNativeSessionId: null,
    },
  }).status, 'confirmed');

  await service.handleSend({
    type: 'send', commandId: 'stale-current', sessionId: session.id,
    text: 'reject stale receipt', clientMessageId: 'stale-current-client',
  });
  await until(() => terminalCount(session.id) === 1);

  const currentMint = minted.at(-1);
  assert.ok(currentMint);
  assert.notEqual(currentMint.continuationAttemptId, abandonedAttempt);
  assert.equal(currentMint.continuation.mode, 'resume');
  assert.deepEqual(
    getOrchestratorSession(session.id) && {
      continuationState: getOrchestratorSession(session.id)!.continuationState,
      continuationAttemptId: getOrchestratorSession(session.id)!.continuationAttemptId,
    },
    {
      continuationState: 'resume-pending',
      continuationAttemptId: currentMint.continuationAttemptId,
    },
  );
  assert.equal(
    listConversationEvents(session.id)
      .filter((row) => row.eventType === 'turn-failed')
      .at(-1)?.eventType,
    'turn-failed',
  );
  await service.dispose();
});

test('session-list availability preflight deduplicates identical selections per request', async () => {
  freshDb();
  const project = newProject('resume-availability-dedupe');
  let preflightCalls = 0;
  const service = new SessionService({
    projectId: project.id,
    broadcast: () => {},
    mintSession: withRuntimeReceipt(() => new FakeRuntime({ turns: [[terminal]] })),
    resolveNewSessionSelection: testSessionSelectionDeps().resolveNewSessionSelection,
    preflightRuntimeSession: async (selection) => {
      preflightCalls += 1;
      return { status: 'valid', selection };
    },
    queueDrainEnabled: false,
  });
  const bind = (session: Awaited<ReturnType<SessionService['ensureActiveSession']>>) => {
    assert.equal(confirmRuntimeSessionReceipt({
      sessionId: session.id,
      receipt: {
        mode: 'created',
        continuationAttemptId: session.continuationAttemptId!,
        selection: TEST_SELECTION,
        nativeSessionId: `native-${session.id}`,
        requestedNativeSessionId: null,
      },
    }).status, 'confirmed');
  };

  const first = await service.ensureActiveSession();
  bind(first);
  const second = await service.startNewSession();
  bind(second);
  await service.startNewSession();

  const cache = new Map<string, Promise<RuntimeSelectionValidation>>();
  assert.deepEqual(await Promise.all([
    service.resumeAvailabilityCode(getOrchestratorSession(first.id)!, cache),
    service.resumeAvailabilityCode(getOrchestratorSession(second.id)!, cache),
  ]), [null, null]);
  assert.equal(preflightCalls, 1);
  await service.dispose();
});

test('historical resume is unavailable before preflight when repository identity is missing', async () => {
  const projectFolder = freshDb();
  const project = createProject({
    name: 'Resume without repository identity',
    slug: 'resume-without-repository-identity',
    folderPath: projectFolder,
  });
  let preflightCalls = 0;
  const service = new SessionService({
    projectId: project.id,
    broadcast: () => {},
    mintSession: withRuntimeReceipt(() => new FakeRuntime({ turns: [[terminal]] })),
    resolveNewSessionSelection: testSessionSelectionDeps().resolveNewSessionSelection,
    preflightRuntimeSession: async (selection) => {
      preflightCalls += 1;
      return { status: 'valid', selection };
    },
    queueDrainEnabled: false,
  });

  const historical = await service.ensureActiveSession();
  assert.equal(confirmRuntimeSessionReceipt({
    sessionId: historical.id,
    receipt: {
      mode: 'created',
      continuationAttemptId: historical.continuationAttemptId!,
      selection: TEST_SELECTION,
      nativeSessionId: `native-${historical.id}`,
      requestedNativeSessionId: null,
    },
  }).status, 'confirmed');
  const current = await service.startNewSession();
  const historicalBefore = getOrchestratorSession(historical.id)!;
  const activeBefore = getActiveOrchestratorSession(project.id)!;
  assert.equal(historicalBefore.status, 'ended');
  assert.equal(activeBefore.id, current.id);

  assert.equal(
    await service.resumeAvailabilityCode(historicalBefore),
    'repository-identity-unavailable',
  );
  assert.equal(preflightCalls, 0);
  await assert.rejects(
    () => service.resumeSession(historical.id),
    (error: unknown) =>
      error instanceof RuntimeSelectionRejectedError &&
      error.code === 'repository-identity-unavailable',
  );

  assert.equal(preflightCalls, 0);
  assert.deepEqual(getOrchestratorSession(historical.id), historicalBefore);
  assert.deepEqual(getActiveOrchestratorSession(project.id), activeBefore);
  await service.dispose();
});

test('active remint refuses missing repository identity before resume state or preflight changes', async () => {
  const projectFolder = freshDb();
  const project = createProject({
    name: 'Active remint without repository identity',
    slug: 'active-remint-without-repository-identity',
    folderPath: projectFolder,
  });
  let preflightCalls = 0;
  let mintCalls = 0;
  const service = new SessionService({
    projectId: project.id,
    broadcast: () => {},
    mintSession: withRuntimeReceipt(() => {
      mintCalls += 1;
      return new FakeRuntime({ turns: [[terminal]] });
    }),
    resolveNewSessionSelection: testSessionSelectionDeps().resolveNewSessionSelection,
    preflightRuntimeSession: async (selection) => {
      preflightCalls += 1;
      return { status: 'valid', selection };
    },
  });

  const session = await service.ensureActiveSession();
  assert.equal(confirmRuntimeSessionReceipt({
    sessionId: session.id,
    receipt: {
      mode: 'created',
      continuationAttemptId: session.continuationAttemptId!,
      selection: TEST_SELECTION,
      nativeSessionId: `native-${session.id}`,
      requestedNativeSessionId: null,
    },
  }).status, 'confirmed');
  const before = structuredClone(getOrchestratorSession(session.id)!);
  assert.equal(before.continuationState, 'clean-started');

  assert.equal((await service.handleSend({
    type: 'send',
    commandId: 'missing-repository-remint',
    sessionId: session.id,
    text: 'must refuse before native resume',
    clientMessageId: 'missing-repository-remint-client',
  })).status, 'applied');
  await until(() => terminalCount(session.id) === 1);

  assert.equal(preflightCalls, 0);
  assert.equal(mintCalls, 0);
  const after = getOrchestratorSession(session.id)!;
  assert.deepEqual({
    status: after.status,
    nativeIdentityState: after.nativeIdentityState,
    nativeSessionId: after.nativeSessionId,
    continuationState: after.continuationState,
    continuationAttemptId: after.continuationAttemptId,
    selectionState: after.selectionState,
    runtimeId: after.runtimeId,
    accountId: after.accountId,
    model: after.model,
    effortState: after.effortState,
    effort: after.effort,
  }, {
    status: before.status,
    nativeIdentityState: before.nativeIdentityState,
    nativeSessionId: before.nativeSessionId,
    continuationState: before.continuationState,
    continuationAttemptId: before.continuationAttemptId,
    selectionState: before.selectionState,
    runtimeId: before.runtimeId,
    accountId: before.accountId,
    model: before.model,
    effortState: before.effortState,
    effort: before.effort,
  });
  const queued = getConversationQueueSnapshot(session.id).items;
  assert.equal(queued.length, 1);
  assert.equal(queued[0]?.status, 'failed');
  // The rejection is a typed RuntimeSelectionRejectedError — its code is app
  // vocabulary, so it rides along instead of being swallowed as generic copy.
  assert.equal(queued[0]?.failureReason, 'runtime failed to start (repository-identity-unavailable)');
  await service.dispose();
});

test('dispose during remint preflight fences DB preparation and a late runtime mint', async () => {
  freshDb();
  const project = newProject('dispose-preflight-fence');
  let revision = 1;
  let blockResume = false;
  let preflightFinished = false;
  const entered = deferred();
  const release = deferred();
  let mintCalls = 0;
  const service = new SessionService({
    projectId: project.id,
    broadcast: () => {},
    mintSession: withRuntimeReceipt(() => {
      mintCalls += 1;
      return new FakeRuntime({ turns: [[terminal]] });
    }),
    resolveNewSessionSelection: testSessionSelectionDeps().resolveNewSessionSelection,
    preflightRuntimeSession: async (selection, continuation) => {
      if (blockResume && continuation.mode === 'resume') {
        entered.resolve();
        await release.promise;
        preflightFinished = true;
      }
      return { status: 'valid', selection };
    },
    orchestratorRev: () => revision,
  });

  const session = await service.ensureActiveSession();
  await service.handleSend({
    type: 'send', commandId: 'dispose-first', sessionId: session.id,
    text: 'first', clientMessageId: 'dispose-first-client',
  });
  await until(() => terminalCount(session.id) === 1);
  revision = 2;
  blockResume = true;
  await service.handleSend({
    type: 'send', commandId: 'dispose-second', sessionId: session.id,
    text: 'second', clientMessageId: 'dispose-second-client',
  });
  await entered.promise;
  const disposing = service.dispose();
  release.resolve();
  await disposing;
  await until(() => preflightFinished);

  assert.equal(mintCalls, 1);
  assert.equal(getOrchestratorSession(session.id)?.continuationState, 'clean-started');
});

test('disposed services reject cached session access and new durable admission', async () => {
  freshDb();
  const project = newProject('disposed-admission-fence');
  const service = new SessionService({
    projectId: project.id,
    broadcast: () => {},
    mintSession: withRuntimeReceipt(() => new FakeRuntime({ turns: [[terminal]] })),
    ...testSessionSelectionDeps(),
    queueDrainEnabled: false,
  });
  const session = await service.ensureActiveSession();
  await service.dispose();

  await assert.rejects(() => service.ensureActiveSession(), /session service is disposed/);
  assert.deepEqual(await service.handleSend({
    type: 'send', commandId: 'disposed-send', sessionId: session.id,
    text: 'must not persist', clientMessageId: 'disposed-send-client',
  }), {
    status: 'rejected',
    sessionId: null,
    error: {
      code: 'session-changed',
      message: 'the command targets a session that is no longer active',
    },
  });
  assert.deepEqual(getConversationQueueSnapshot(session.id).items, []);
});

test('a receipt emitted after disposal begins cannot bind native identity', async () => {
  freshDb();
  const project = newProject('late-receipt-disposal');
  const release = deferred();
  const sendStarted = deferred();
  let context: MintRuntimeSession | null = null;
  const service = new SessionService({
    projectId: project.id,
    broadcast: () => {},
    mintSession: async (ctx): Promise<RuntimeSession> => {
      context = copyContext(ctx);
      return {
        sendTurn() {
          sendStarted.resolve();
          return (async function* () {
            await release.promise;
            yield runtimeReceiptFor(context!);
            yield terminal;
          })();
        },
        observeContext: async () => ({ confidence: 'unavailable', reason: 'unsupported' }),
        interrupt: async () => {},
        dispose: async () => { release.resolve(); },
      };
    },
    ...testSessionSelectionDeps(),
  });

  const session = await service.ensureActiveSession();
  await service.handleSend({
    type: 'send', commandId: 'late-receipt', sessionId: session.id,
    text: 'wait', clientMessageId: 'late-receipt-client',
  });
  await sendStarted.promise;
  await service.dispose();

  const persisted = getOrchestratorSession(session.id)!;
  assert.equal(persisted.nativeIdentityState, 'unbound');
  assert.equal(persisted.nativeSessionId, null);
  assert.equal(persisted.continuationState, 'clean-pending');
});

test('a disposed service receipt cannot confirm a replacement service resume attempt', async () => {
  freshDb();
  const project = newProject('stale-receipt-generation');
  const oldRelease = deferred();
  const oldSendStarted = deferred();
  let oldContext: MintRuntimeSession | null = null;
  const deps = testSessionSelectionDeps();
  const oldService = new SessionService({
    projectId: project.id,
    broadcast: () => {},
    mintSession: async (ctx): Promise<RuntimeSession> => {
      oldContext = copyContext(ctx);
      return {
        sendTurn() {
          oldSendStarted.resolve();
          return (async function* () {
            await oldRelease.promise;
            yield runtimeReceiptFor(oldContext!);
            yield terminal;
          })();
        },
        observeContext: async () => ({ confidence: 'unavailable', reason: 'unsupported' }),
        interrupt: async () => {},
        // Model a provider iterator that outlives its acknowledged teardown.
        dispose: async () => {},
      };
    },
    ...deps,
  });

  const session = await oldService.ensureActiveSession();
  const nativeSessionId = `native-${session.id}`;
  assert.equal(confirmRuntimeSessionReceipt({
    sessionId: session.id,
    receipt: {
      mode: 'created', selection: TEST_SELECTION, nativeSessionId,
      continuationAttemptId: session.continuationAttemptId!,
      requestedNativeSessionId: null,
    },
  }).status, 'confirmed');
  await oldService.handleSend({
    type: 'send', commandId: 'stale-old', sessionId: session.id,
    text: 'old attempt', clientMessageId: 'stale-old-client',
  });
  await oldSendStarted.promise;
  assert.equal(getOrchestratorSession(session.id)?.continuationState, 'resume-pending');
  const oldTurn = getActiveConversationTurn(session.id)!;

  // Disposal fences the old callback synchronously. Boot recovery can then
  // close its lost turn and a replacement service can re-enter the pending
  // continuation without trusting an event from the disposed runtime.
  const oldDisposal = oldService.dispose();
  assert.equal(settleConversationTurn({
    turnId: oldTurn.id,
    terminalEvent: {
      kind: 'turn-failed', error: 'server restarted mid-turn', source: 'internal',
    },
    terminalOutcome: 'recovered',
    queueStatus: 'failed',
    queueFailureReason: 'server restarted while delivery outcome was uncertain',
  }), true);

  const replacementRelease = deferred();
  const replacementSendStarted = deferred();
  let replacementContext: MintRuntimeSession | null = null;
  const replacementService = new SessionService({
    projectId: project.id,
    broadcast: () => {},
    mintSession: async (ctx): Promise<RuntimeSession> => {
      replacementContext = copyContext(ctx);
      return {
        sendTurn() {
          replacementSendStarted.resolve();
          return (async function* () {
            await replacementRelease.promise;
            yield runtimeReceiptFor(replacementContext!);
            yield terminal;
          })();
        },
        observeContext: async () => ({ confidence: 'unavailable', reason: 'unsupported' }),
        interrupt: async () => {},
        dispose: async () => { replacementRelease.resolve(); },
      };
    },
    ...deps,
  });
  await replacementService.handleSend({
    type: 'send', commandId: 'stale-new', sessionId: session.id,
    text: 'replacement attempt', clientMessageId: 'stale-new-client',
  });
  await replacementSendStarted.promise;
  assert.equal(getOrchestratorSession(session.id)?.continuationState, 'resume-pending');

  oldRelease.resolve();
  await oldDisposal;
  assert.equal(
    getOrchestratorSession(session.id)?.continuationState,
    'resume-pending',
    'the disposed runtime receipt must not confirm the replacement attempt',
  );

  replacementRelease.resolve();
  await until(() => getOrchestratorSession(session.id)?.continuationState === 'native-resumed');
  await replacementService.dispose();
});

test('a send that becomes active during resume preflight prevents the switch and preserves B', async () => {
  freshDb();
  const project = newProject('resume-send-interleaving');
  const entered = deferred();
  const release = deferred();
  let blockHistoricalResume = false;
  const baseDeps = testSessionSelectionDeps();
  const service = new SessionService({
    projectId: project.id,
    broadcast: () => {},
    mintSession: withRuntimeReceipt((ctx) => new FakeRuntime({
      turns: [[ctx.selection.accountId === 'work' ? { hang: true } : terminal]],
    })),
    resolveNewSessionSelection: baseDeps.resolveNewSessionSelection,
    preflightRuntimeSession: async (selection, continuation) => {
      if (blockHistoricalResume && continuation.mode === 'resume') {
        entered.resolve();
        await release.promise;
      }
      return { status: 'valid', selection };
    },
  });

  const accountA = await service.ensureActiveSession();
  await service.handleSend({
    type: 'send', commandId: 'interleave-a', sessionId: accountA.id,
    text: 'A', clientMessageId: 'interleave-a-client',
  });
  await until(() => terminalCount(accountA.id) === 1);
  const accountB = await service.switchAccountSession('work');
  blockHistoricalResume = true;
  const resume = service.resumeSession(accountA.id);
  await entered.promise;
  await service.handleSend({
    type: 'send', commandId: 'interleave-b', sessionId: accountB.id,
    text: 'B stays active', clientMessageId: 'interleave-b-client',
  });
  await until(() => getActiveConversationTurn(accountB.id) !== null);
  release.resolve();

  await assert.rejects(
    () => resume,
    (error: unknown) =>
      error instanceof RuntimeSelectionRejectedError && error.code === 'session-active',
  );
  assert.equal(getActiveOrchestratorSession(project.id)?.id, accountB.id);
  assert.equal(getOrchestratorSession(accountA.id)?.status, 'ended');
  assert.ok(getConversationQueueSnapshot(accountB.id).items.some((item) => item.text === 'B stays active'));
  await service.dispose();
});
