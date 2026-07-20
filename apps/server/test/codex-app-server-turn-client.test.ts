// Thread/turn transport unit tests: request correlation, notification + server
// request routing, answerable approvals, and child-death fan-out — all against a
// scripted fake child (no real process spawned).

import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';
import { test } from 'node:test';

import type {
  CodexAppServerProcess,
  CodexAppServerProcessFactory,
} from '../src/runner/codex/app-server-client.ts';
import {
  startCodexTurnTransport,
  CodexTurnTransportError,
  type CodexNotificationFrame,
  type CodexServerRequestFrame,
  type CodexTransportExit,
} from '../src/runner/codex/app-server-turn-client.ts';

// The transport resolves the real pinned executable and builds a real child
// environment at spawn (matching production admission), so the home/cwd must be
// canonical existing directories even though the child itself is faked.
const CODEX_HOME = realpathSync.native(mkdtempSync(join(tmpdir(), 'codex-turn-home-')));
const CWD = realpathSync.native(mkdtempSync(join(tmpdir(), 'codex-turn-cwd-')));
process.on('exit', () => {
  rmSync(CODEX_HOME, { recursive: true, force: true });
  rmSync(CWD, { recursive: true, force: true });
});

class FakeChild extends EventEmitter implements CodexAppServerProcess {
  readonly stdin = new PassThrough();
  readonly stdout = new PassThrough();
  readonly stderr = new PassThrough();
  readonly pid = 4242;
  exitCode: number | null = null;
  signalCode: NodeJS.Signals | null = null;
  readonly killSignals: Array<NodeJS.Signals | number> = [];

  private buffer = '';
  private readonly frames: Record<string, unknown>[] = [];
  private readonly waiters: Array<(frame: Record<string, unknown>) => void> = [];

  constructor() {
    super();
    this.stdin.on('data', (chunk: Buffer) => {
      this.buffer += chunk.toString('utf8');
      for (;;) {
        const nl = this.buffer.indexOf('\n');
        if (nl === -1) break;
        const line = this.buffer.slice(0, nl);
        this.buffer = this.buffer.slice(nl + 1);
        const frame = JSON.parse(line) as Record<string, unknown>;
        const waiter = this.waiters.shift();
        if (waiter) waiter(frame);
        else this.frames.push(frame);
      }
    });
  }

  kill(signal: NodeJS.Signals | number = 'SIGKILL'): boolean {
    this.killSignals.push(signal);
    return true;
  }

  send(value: unknown): void {
    this.stdout.write(`${JSON.stringify(value)}\n`);
  }

  emitExit(code: number | null, signal: NodeJS.Signals | null): void {
    this.exitCode = code;
    this.signalCode = signal;
    this.emit('exit', code, signal);
  }

  async nextFrame(): Promise<Record<string, unknown>> {
    const queued = this.frames.shift();
    if (queued !== undefined) return queued;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('timed out waiting for client frame')), 2_000);
      this.waiters.push((frame) => {
        clearTimeout(timer);
        resolve(frame);
      });
    });
  }
}

interface Harness {
  readonly transport: ReturnType<typeof startCodexTurnTransport>;
  readonly child: FakeChild;
  readonly notifications: CodexNotificationFrame[];
  readonly serverRequests: CodexServerRequestFrame[];
  readonly exits: CodexTransportExit[];
}

function harness(): Harness {
  const child = new FakeChild();
  const notifications: CodexNotificationFrame[] = [];
  const serverRequests: CodexServerRequestFrame[] = [];
  const exits: CodexTransportExit[] = [];
  const spawnProcess: CodexAppServerProcessFactory = () => child;
  const transport = startCodexTurnTransport({
    codexHome: CODEX_HOME,
    cwd: CWD,
    onNotification: (n) => notifications.push(n),
    onServerRequest: (r) => serverRequests.push(r),
    onExit: (e) => exits.push(e),
    spawnProcess,
  });
  return { transport, child, notifications, serverRequests, exits };
}

async function initialize(h: Harness): Promise<void> {
  const pending = h.transport.initialize();
  const init = await h.child.nextFrame();
  assert.equal(init.method, 'initialize');
  h.child.send({ id: init.id, result: { codexHome: CODEX_HOME, userAgent: 'x', platformFamily: 'unix', platformOs: 'linux' } });
  await pending;
  const initialized = await h.child.nextFrame();
  assert.equal(initialized.method, 'initialized');
}

test('transport initialize confirms the exact codex home then arms the session', async () => {
  const h = harness();
  await initialize(h);
});

test('transport initialize rejects a mismatched codex home', async () => {
  const h = harness();
  const pending = h.transport.initialize();
  const init = await h.child.nextFrame();
  h.child.send({ id: init.id, result: { codexHome: `${CODEX_HOME}-alias` } });
  await assert.rejects(pending, (e: unknown) => e instanceof CodexTurnTransportError && e.code === 'initialize-invalid');
});

test('transport correlates a request to its response and surfaces an error response as typed failure', async () => {
  const h = harness();
  await initialize(h);
  const ok = h.transport.request('turn/start', { threadId: 't' });
  const req = await h.child.nextFrame();
  assert.equal(req.method, 'turn/start');
  h.child.send({ id: req.id, result: { turn: { id: 'x' } } });
  assert.deepEqual(await ok, { turn: { id: 'x' } });

  const bad = h.transport.request('turn/interrupt', {});
  const badReq = await h.child.nextFrame();
  h.child.send({ id: badReq.id, error: { code: -1, message: 'nope' } });
  await assert.rejects(bad, (e: unknown) => e instanceof CodexTurnTransportError && e.code === 'transport-failed');
});

test('transport routes notifications and server requests to their sinks and answers by id', async () => {
  const h = harness();
  await initialize(h);
  h.child.send({ method: 'turn/started', params: { threadId: 't', turn: { id: 'u' } } });
  h.child.send({ method: 'account/rateLimits/updated', params: { primary: null } });
  await tick();
  assert.deepEqual(h.notifications.map((n) => n.method), ['turn/started', 'account/rateLimits/updated']);

  h.child.send({ id: 99, method: 'item/commandExecution/requestApproval', params: { command: 'ls', cwd: CWD } });
  await tick();
  assert.equal(h.serverRequests.length, 1);
  assert.equal(h.serverRequests[0]?.id, 99);
  h.transport.answerServerRequest(99, { decision: 'accept' });
  const answer = await h.child.nextFrame();
  assert.deepEqual(answer, { id: 99, result: { decision: 'accept' } });
});

test('transport fans child death out to onExit and rejects in-flight requests', async () => {
  const h = harness();
  await initialize(h);
  const inflight = h.transport.request('turn/start', { threadId: 't' });
  await h.child.nextFrame();
  h.child.emitExit(1, null);
  await assert.rejects(inflight, (e: unknown) => e instanceof CodexTurnTransportError && e.code === 'transport-failed');
  assert.deepEqual(h.exits, [{ code: 1, signal: null }]);
});

test('transport tolerates benign non-JSON stdout noise without failing a turn', async () => {
  const h = harness();
  await initialize(h);
  h.child.stdout.write('this is not json\n');
  h.child.send({ method: 'turn/completed', params: { threadId: 't', turn: { id: 'u' } } });
  await tick();
  assert.deepEqual(h.notifications.map((n) => n.method), ['turn/completed']);
});

test('transport dispose reaps the child and fails later requests closed', async () => {
  const h = harness();
  await initialize(h);
  await h.transport.dispose();
  assert.ok(h.child.killSignals.length >= 1);
  await assert.rejects(
    h.transport.request('turn/start', {}),
    (e: unknown) => e instanceof CodexTurnTransportError && e.code === 'transport-disposed',
  );
});

function tick(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}
