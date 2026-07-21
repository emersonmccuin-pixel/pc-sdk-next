import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  subscriptionQuotaKey,
  type SubscriptionQuotaSnapshot,
} from '@pc/contracts';

import { ProjectSocket } from '../src/lib/ws-client.ts';
import { useAccounts } from '../src/state/accounts.ts';
import { useChatStore } from '../src/state/chat-store.ts';
import { useConnectionStore } from '../src/state/connection.ts';
import { useAgentEventStore } from '../src/state/agent-event-store.ts';
import { useSessionNav } from '../src/state/sessions.ts';
import { useResourceStore } from '../src/state/resource-store.ts';
import { useSubscriptionQuotaStore } from '../src/state/subscription-quota-store.ts';

const PROJECT_ID = 'project-1';
const SESSION_ID = 'session-1';

function route(socket: ProjectSocket, frame: unknown): void {
  (socket as unknown as { route: (candidate: unknown) => void }).route(frame);
}

function quotaSnapshot(
  over: Partial<SubscriptionQuotaSnapshot> = {},
): SubscriptionQuotaSnapshot {
  return {
    id: '01KXAV30000000000000000001',
    runtimeId: 'runtime-a',
    accountId: 'personal',
    revision: 1,
    availability: 'available',
    unavailableReason: null,
    observedAt: 1_000,
    observations: [{
      window: { id: 'five-hour', label: '5 hours', durationMs: 18_000_000 },
      scope: { kind: 'account' },
      source: { semantics: 'used', fraction: 0.4 },
      usedFraction: 0.4,
      confidence: 'exact',
      limitState: 'allowed',
      resetsAt: 2_000,
      observedAt: 1_000,
      staleAt: 2_000,
    }],
    ...over,
  };
}

function quotaFrame(snapshot: SubscriptionQuotaSnapshot, cursor: string) {
  return {
    type: 'resource',
    event: {
      id: `01KXAV3${cursor.padStart(19, '0')}`,
      cursor,
      scope: 'global',
      projectId: null,
      entity: 'subscription-quota',
      entityId: snapshot.id,
      eventType: 'subscription-quota.changed',
      version: snapshot.revision,
      createdAt: snapshot.observedAt,
      payload: snapshot,
    },
  };
}

function resourceCursor(socket: ProjectSocket): string | undefined {
  return (socket as unknown as { cursor: string | undefined }).cursor;
}

function queueItem() {
  return {
    id: 'queue-1',
    clientMessageId: 'client-1',
    origin: 'user',
    enqueuePosition: 1,
    revision: 1,
    deliveryRevision: null,
    text: 'saved',
    status: 'queued',
    interruptRequestId: null,
    failureReason: null,
    createdAt: 1,
    updatedAt: 1,
  };
}

function sessionChanged(
  sessionId: string,
  accountId: string,
  transition: 'new-session' | 'resume-session',
  continuationState: 'clean-started' | 'native-resumed',
  projectId = PROJECT_ID,
) {
  return {
    type: 'session-changed',
    projectId,
    transition,
    session: {
      id: sessionId,
      projectId,
      selection: {
        runtimeId: 'claude-agent-sdk',
        accountId,
        model: 'claude-opus',
        effort: { kind: 'none' },
      },
      title: null,
      status: 'active',
      nativeSessionIdPresent: true,
      continuationState,
      resumeAvailability: { status: 'unavailable', code: 'session-active' },
      startedAt: 1,
    },
  };
}

function sessionUpdated(
  sessionId: string,
  accountId: string,
  continuationState: 'clean-started' | 'native-resumed' | 'resume-failed',
) {
  const changed = sessionChanged(
    sessionId,
    accountId,
    'resume-session',
    continuationState === 'resume-failed' ? 'native-resumed' : continuationState,
  );
  return {
    type: 'session-updated',
    projectId: PROJECT_ID,
    session: {
      ...changed.session,
      continuationState,
    },
  };
}

test('valid session changes synchronize chat, navigation, and stamped account A -> B -> resume A', () => {
  useChatStore.getState().reset();
  useSessionNav.getState().setActive(PROJECT_ID, null);
  useAccounts.getState().bindProject(null);
  useAccounts.getState().bindProject(PROJECT_ID);
  useAccounts.getState().select('unrelated-default');
  const socket = new ProjectSocket(PROJECT_ID);

  route(socket, sessionChanged('session-a-1', 'account-a', 'new-session', 'clean-started'));
  assert.equal(useChatStore.getState().state.sessionId, 'session-a-1');
  assert.equal(useSessionNav.getState().activeByProject[PROJECT_ID], 'session-a-1');
  assert.equal(useAccounts.getState().selectedId, 'account-a');
  assert.equal(useAccounts.getState().activeSession?.continuationState, 'clean-started');
  useAccounts.getState().select('account-b');
  assert.equal(useAccounts.getState().selectedId, 'account-a', 'local display choice cannot rewrite a stamp');

  route(socket, sessionChanged('session-b', 'account-b', 'new-session', 'clean-started'));
  assert.equal(useChatStore.getState().state.sessionId, 'session-b');
  assert.equal(useSessionNav.getState().activeByProject[PROJECT_ID], 'session-b');
  assert.equal(useAccounts.getState().selectedId, 'account-b');

  route(socket, sessionChanged('session-a-1', 'account-a', 'resume-session', 'native-resumed'));
  assert.equal(useChatStore.getState().state.sessionId, 'session-a-1');
  assert.equal(useSessionNav.getState().activeByProject[PROJECT_ID], 'session-a-1');
  assert.equal(useAccounts.getState().selectedId, 'account-a');
  assert.equal(useAccounts.getState().activeSession?.continuationState, 'native-resumed');
});

test('malformed or foreign session changes mutate none of the project-scoped stores', () => {
  useChatStore.getState().reset();
  useSessionNav.getState().setActive(PROJECT_ID, null);
  useAccounts.getState().bindProject(null);
  useAccounts.getState().bindProject(PROJECT_ID);
  const socket = new ProjectSocket(PROJECT_ID);
  route(socket, sessionChanged('session-safe', 'account-a', 'new-session', 'clean-started'));

  const chatBefore = useChatStore.getState().state;
  const navBefore = useSessionNav.getState().activeByProject[PROJECT_ID];
  const navNonceBefore = useSessionNav.getState().nonce;
  const accountBefore = useAccounts.getState().selectedId;
  const accountSessionBefore = useAccounts.getState().activeSession;

  const malformed = sessionChanged('session-bad', 'account-b', 'resume-session', 'native-resumed');
  route(socket, {
    ...malformed,
    session: {
      ...malformed.session,
      nativeSessionId: 'must-not-cross-browser-contract',
    },
  });
  route(socket, {
    ...malformed,
    provider: 'must-not-cross-browser-contract',
  });
  route(socket, sessionChanged(
    'session-foreign',
    'foreign-account',
    'resume-session',
    'native-resumed',
    'foreign-project',
  ));

  assert.strictEqual(useChatStore.getState().state, chatBefore);
  assert.equal(useSessionNav.getState().activeByProject[PROJECT_ID], navBefore);
  assert.equal(useSessionNav.getState().nonce, navNonceBefore);
  assert.equal(useAccounts.getState().selectedId, accountBefore);
  assert.strictEqual(useAccounts.getState().activeSession, accountSessionBefore);
});

test('session metadata updates provenance without resetting the chat timeline', () => {
  useChatStore.getState().reset();
  useSessionNav.getState().setActive(PROJECT_ID, null);
  useAccounts.getState().bindProject(null);
  useAccounts.getState().bindProject(PROJECT_ID);
  const socket = new ProjectSocket(PROJECT_ID);
  route(socket, sessionChanged('session-live', 'account-a', 'new-session', 'clean-started'));

  const chatBefore = useChatStore.getState().state;
  const nonceBefore = useSessionNav.getState().nonce;
  route(socket, sessionUpdated('session-live', 'account-a', 'native-resumed'));

  assert.strictEqual(useChatStore.getState().state, chatBefore);
  assert.equal(useSessionNav.getState().activeByProject[PROJECT_ID], 'session-live');
  assert.equal(useSessionNav.getState().nonce, nonceBefore + 1);
  assert.equal(useAccounts.getState().activeSession?.continuationState, 'native-resumed');

  const accountBefore = useAccounts.getState().activeSession;
  const nonceAfter = useSessionNav.getState().nonce;
  route(socket, {
    ...sessionUpdated('session-live', 'account-a', 'clean-started'),
    continuationAttemptId: 'must-not-cross-browser-contract',
  });
  assert.strictEqual(useChatStore.getState().state, chatBefore);
  assert.strictEqual(useAccounts.getState().activeSession, accountBefore);
  assert.equal(useSessionNav.getState().nonce, nonceAfter);
});

test('socket routes only strictly guarded queue and command frames', () => {
  useChatStore.getState().reset(SESSION_ID);
  useChatStore.getState().addOptimistic('command-1', 'client-1', 'saved');
  const socket = new ProjectSocket(PROJECT_ID);

  route(socket, {
    type: 'send-queue-snapshot',
    projectId: PROJECT_ID,
    sessionId: SESSION_ID,
    queueRevision: 1,
    items: [queueItem()],
  });
  assert.equal(useChatStore.getState().state.sendQueue[0]?.text, 'saved');

  route(socket, {
    type: 'send-queue-snapshot',
    projectId: PROJECT_ID,
    sessionId: SESSION_ID,
    queueRevision: 2,
    items: [{ ...queueItem(), revision: 0, text: 'malformed overwrite' }],
  });
  assert.equal(useChatStore.getState().state.queueRevision, 1);

  route(socket, {
    type: 'conversation-command-receipt',
    projectId: PROJECT_ID,
    sessionId: SESSION_ID,
    commandId: 'command-1',
    command: 'send',
    status: 'applied',
    queueItemId: 'queue-1',
    revision: 1,
    error: null,
  });
  assert.equal(useChatStore.getState().state.optimistic[0]?.status, 'queued');

  route(socket, {
    type: 'conversation-command-receipt',
    projectId: PROJECT_ID,
    sessionId: SESSION_ID,
    commandId: 'command-1',
    command: 'send',
    status: 'applied',
    error: { code: 'internal', message: 'contradictory' },
  });
  assert.equal(useChatStore.getState().state.commandReceipts['command-1']?.error, null);
});

test('socket rejects foreign projects and exposes exact active-turn identity', () => {
  const socket = new ProjectSocket(PROJECT_ID);
  route(socket, {
    type: 'orchestrator-state',
    projectId: PROJECT_ID,
    sessionId: SESSION_ID,
    activeTurnId: 'turn-1',
    health: 'busy',
    queueDepth: 2,
    failureReason: null,
  });
  assert.equal(useConnectionStore.getState().activeTurnId, 'turn-1');
  assert.equal(useConnectionStore.getState().queueDepth, 2);

  route(socket, {
    type: 'orchestrator-state',
    projectId: 'foreign-project',
    sessionId: 'foreign-session',
    activeTurnId: 'foreign-turn',
    health: 'failed',
    queueDepth: 99,
    failureReason: 'wrong project',
  });
  assert.equal(useConnectionStore.getState().activeTurnId, 'turn-1');
  assert.equal(useConnectionStore.getState().queueDepth, 2);

  route(socket, {
    type: 'orchestrator-state',
    projectId: PROJECT_ID,
    sessionId: SESSION_ID,
    activeTurnId: '',
    health: 'busy',
    queueDepth: 3,
    failureReason: null,
  });
  assert.equal(useConnectionStore.getState().activeTurnId, 'turn-1');
});

test('socket admits only strict canonical agent transcript frames', () => {
  useAgentEventStore.getState().clearAll();
  const socket = new ProjectSocket(PROJECT_ID);
  const frame = {
    type: 'agent-event',
    projectId: PROJECT_ID,
    runId: 'run-1',
    dedupId: 'agent-event-1',
    event: { kind: 'assistant-text', text: 'safe', midLoop: false },
  };
  route(socket, frame);
  assert.equal(useAgentEventStore.getState().byRunId.get('run-1')?.length, 1);

  route(socket, { ...frame, dedupId: 'agent-event-2', nativeSessionId: 'SECRET' });
  route(socket, {
    ...frame,
    dedupId: 'agent-event-3',
    event: { ...frame.event, rawThinking: 'SECRET' },
  });
  assert.equal(useAgentEventStore.getState().byRunId.get('run-1')?.length, 1);
});

test('socket admits only exact browser-safe agent-run resources', () => {
  useResourceStore.getState().clearAll();
  const socket = new ProjectSocket(PROJECT_ID);
  const run = {
    runId: 'run-resource-1',
    agentName: 'researcher',
    selection: {
      runtimeId: 'claude-agent-sdk',
      accountId: 'personal',
      model: 'claude-opus',
      effort: { kind: 'none' },
    },
    specialistRevision: 'sha256:safe',
    nativeSessionIdPresent: true,
    continuationState: 'clean-started',
    projectId: PROJECT_ID,
    dispatcherSessionId: SESSION_ID,
    worktreeDir: '',
    startedAt: 1,
    status: 'running',
    lifecycleState: null,
    result: '',
    failureReason: null,
    failureCause: null,
    endedAt: null,
    rev: 1,
    dismissedAt: null,
    continues: null,
  };
  const frame = {
    type: 'resource',
    event: {
      id: '01KXAV30000000000000000003',
      cursor: '1',
      scope: 'project',
      projectId: PROJECT_ID,
      entity: 'agent-run',
      entityId: run.runId,
      eventType: 'agent-run.changed',
      version: 1,
      createdAt: 1,
      payload: { reason: 'running', run },
    },
  };

  route(socket, frame);
  const key = `agent-run::${run.runId}`;
  assert.equal(useResourceStore.getState().byKey.get(key)?.version, 1);

  route(socket, {
    ...frame,
    event: {
      ...frame.event,
      cursor: '2',
      version: 2,
      payload: {
        ...frame.event.payload,
        continuationAttemptId: 'attempt-secret',
        run: { ...run, nativeSessionId: 'native-secret', rev: 2 },
      },
    },
  });
  route(socket, { ...frame, rawProviderPayload: 'secret' });
  route(socket, {
    ...frame,
    event: { ...frame.event, cursor: '3', entityId: 'other-run' },
  });
  route(socket, {
    ...frame,
    event: { ...frame.event, cursor: '4', projectId: 'other-project' },
  });
  route(socket, {
    ...frame,
    event: {
      ...frame.event,
      cursor: '4b',
      projectId: 'other-project',
      version: 2,
      payload: {
        ...frame.event.payload,
        run: { ...run, projectId: 'other-project', rev: 2 },
      },
    },
  });
  route(socket, {
    ...frame,
    event: { ...frame.event, cursor: '5', version: 5 },
  });
  route(socket, {
    ...frame,
    event: { ...frame.event, cursor: '6', scope: 'global', projectId: null },
  });
  assert.equal(useResourceStore.getState().byKey.get(key)?.version, 1);
});

test('malformed subscription-quota resources are rejected before cursor advancement', () => {
  useResourceStore.getState().clearAll();
  useSubscriptionQuotaStore.getState().clear();
  const socket = new ProjectSocket(PROJECT_ID);
  const accepted = quotaSnapshot();
  route(socket, quotaFrame(accepted, '21'));

  const key = subscriptionQuotaKey(accepted.runtimeId, accepted.accountId);
  assert.equal(resourceCursor(socket), '21');
  assert.equal(useSubscriptionQuotaStore.getState().byRuntimeAccount[key]?.revision, 1);
  assert.equal(
    useResourceStore.getState().byKey.get(`subscription-quota::${accepted.id}`)?.version,
    1,
  );

  const newer = quotaSnapshot({ revision: 2 });
  const malformed = quotaFrame(newer, '22');
  route(socket, {
    ...malformed,
    event: {
      ...malformed.event,
      payload: { ...newer, rawRateLimitInfo: { five_hour: 'secret' } },
    },
  });
  route(socket, {
    ...quotaFrame(newer, '23'),
    event: { ...quotaFrame(newer, '23').event, version: 99 },
  });
  route(socket, {
    ...quotaFrame(newer, '24'),
    event: {
      ...quotaFrame(newer, '24').event,
      entityId: '01KXAV30000000000000000099',
    },
  });

  assert.equal(resourceCursor(socket), '21', 'rejected frames cannot move the replay cursor');
  assert.equal(useSubscriptionQuotaStore.getState().byRuntimeAccount[key]?.revision, 1);
  assert.equal(
    useResourceStore.getState().byKey.get(`subscription-quota::${accepted.id}`)?.version,
    1,
  );
});

test('live-reset clears quota projection and advances epoch for HTTP healing', () => {
  useResourceStore.getState().clearAll();
  useSubscriptionQuotaStore.getState().clear();
  const socket = new ProjectSocket(PROJECT_ID);
  const accepted = quotaSnapshot();
  route(socket, quotaFrame(accepted, '31'));
  assert.equal(Object.keys(useSubscriptionQuotaStore.getState().byRuntimeAccount).length, 1);
  assert.equal(useResourceStore.getState().byKey.size, 1);

  const epochBefore = useConnectionStore.getState().epoch;
  route(socket, { type: 'live-reset', projectId: PROJECT_ID, cursor: '31' });
  assert.deepEqual(useSubscriptionQuotaStore.getState().byRuntimeAccount, {});
  assert.equal(useResourceStore.getState().byKey.size, 0);
  assert.equal(resourceCursor(socket), undefined);
  assert.equal(useConnectionStore.getState().epoch, epochBefore + 1);
});

test('socket generation guards suppress connecting duplicates and superseded handlers', () => {
  const listeners = new Map<string, () => void>();
  const storage = new Map<string, string>();
  class FakeWebSocket {
    static readonly CONNECTING = 0;
    static readonly OPEN = 1;
    static readonly CLOSING = 2;
    static readonly CLOSED = 3;
    static readonly instances: FakeWebSocket[] = [];
    readyState = FakeWebSocket.CONNECTING;
    onopen: (() => void) | null = null;
    onmessage: ((event: { data: string }) => void) | null = null;
    onclose: (() => void) | null = null;
    onerror: (() => void) | null = null;
    readonly sent: string[] = [];
    constructor(readonly url: string) {
      FakeWebSocket.instances.push(this);
    }
    send(value: string): void { this.sent.push(value); }
    close(): void { this.readyState = FakeWebSocket.CLOSED; this.onclose?.(); }
  }
  Object.assign(globalThis, {
    WebSocket: FakeWebSocket,
    location: { protocol: 'http:', host: 'localhost' },
    localStorage: {
      getItem: (key: string) => storage.get(key) ?? null,
      setItem: (key: string, value: string) => storage.set(key, value),
      removeItem: (key: string) => storage.delete(key),
    },
    window: {
      addEventListener: (name: string, listener: () => void) => listeners.set(name, listener),
      removeEventListener: (name: string) => listeners.delete(name),
    },
    document: {
      visibilityState: 'visible',
      addEventListener: (name: string, listener: () => void) => listeners.set(name, listener),
      removeEventListener: (name: string) => listeners.delete(name),
    },
  });

  storage.set(`pc:resource-cursor:${PROJECT_ID}`, '09');
  const socket = new ProjectSocket(PROJECT_ID);
  assert.equal(storage.has(`pc:resource-cursor:${PROJECT_ID}`), false, 'invalid stored cursor is cleared');
  socket.start();
  assert.equal(FakeWebSocket.instances.length, 1);
  const forceReconnect = (socket as unknown as { forceReconnect: () => void }).forceReconnect;
  forceReconnect();
  assert.equal(FakeWebSocket.instances.length, 1, 'CONNECTING socket is not duplicated');

  const first = FakeWebSocket.instances[0]!;
  const staleOpen = first.onopen!;
  const staleMessage = first.onmessage!;
  first.readyState = FakeWebSocket.CLOSING;
  forceReconnect();
  assert.equal(FakeWebSocket.instances.length, 2);
  const epochBefore = useConnectionStore.getState().epoch;
  staleOpen();
  assert.equal(useConnectionStore.getState().epoch, epochBefore, 'superseded open is inert');

  const second = FakeWebSocket.instances[1]!;
  second.readyState = FakeWebSocket.OPEN;
  second.onopen?.();
  assert.equal(useConnectionStore.getState().epoch, epochBefore + 1);
  assert.deepEqual(JSON.parse(second.sent[0]!), { type: 'subscribe' });
  useChatStore.getState().reset(SESSION_ID);
  socket.stop();
  staleMessage({
    data: JSON.stringify({
      type: 'session-changed',
      projectId: PROJECT_ID,
      transition: 'new-session',
      session: null,
    }),
  });
  assert.equal(useChatStore.getState().state.sessionId, SESSION_ID, 'closed socket frame is inert');
  assert.equal(second.onmessage, null);
});
