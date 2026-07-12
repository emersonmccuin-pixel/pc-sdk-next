import { test } from 'node:test';
import assert from 'node:assert/strict';

import { ProjectSocket } from '../src/lib/ws-client.ts';
import { useChatStore } from '../src/state/chat-store.ts';
import { useConnectionStore } from '../src/state/connection.ts';

const PROJECT_ID = 'project-1';
const SESSION_ID = 'session-1';

function route(socket: ProjectSocket, frame: unknown): void {
  (socket as unknown as { route: (candidate: unknown) => void }).route(frame);
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

  const socket = new ProjectSocket(PROJECT_ID);
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
