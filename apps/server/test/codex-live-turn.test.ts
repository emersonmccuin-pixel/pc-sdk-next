// Live Codex turn — end-to-end through the REAL adapter path (CodexRuntimeAdapter
// + createCodexLiveDeps) against scripted fake app-server children. No real
// process is spawned. This exercises the SAME wire the live smoke drives: native
// discovery, thread/start, turn/start, the canonical turn-notification stream
// (interleaved with the real stream's operational noise, which the live peer must
// filter out before capture), the independent turn-boundary attestation, and a
// real interrupt resolving to a typed aborted outcome.

import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';
import { test, type TestContext } from 'node:test';

import type {
  CodexAppServerProcess,
  CodexAppServerProcessFactory,
} from '../src/runner/codex/app-server-client.ts';
import { createCodexLiveDeps } from '../src/runner/codex/live-peer.ts';
import { CodexRuntimeAdapter } from '../src/runner/codex/adapter.ts';
import { CODEX_MODEL_PROVIDER, CODEX_PROTOCOL_VERSION, CODEX_RUNTIME_ID } from '../src/runner/codex/runtime-peer.ts';
import type { RuntimeEvent } from '../src/runner/runtime.ts';
import type { RuntimeSelection } from '@pc/contracts';

const ACCOUNT_ID = 'codex-live-turn';
const MODEL_ID = 'gpt-5.4';
const THREAD_ID = '01900100-0000-7000-8000-000000000001';
const TURN_ID = '01900100-0000-7000-8000-000000000002';
const ITEM_ID = '01900100-0000-7000-8000-000000000003';
const PONG = 'pong';

const SELECTION: RuntimeSelection = {
  runtimeId: CODEX_RUNTIME_ID,
  accountId: ACCOUNT_ID,
  model: MODEL_ID,
  effort: { kind: 'unavailable' },
};

class FakeChild extends EventEmitter implements CodexAppServerProcess {
  readonly stdin = new PassThrough();
  readonly stdout = new PassThrough();
  readonly stderr = new PassThrough();
  readonly pid = 7000;
  exitCode: number | null = null;
  signalCode: NodeJS.Signals | null = null;
  readonly killSignals: Array<NodeJS.Signals | number> = [];

  private buffer = '';
  private readonly frames: Record<string, unknown>[] = [];
  private readonly waiters: Array<(frame: Record<string, unknown>) => void> = [];
  private exitEmitted = false;
  private closeEmitted = false;

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
    if (this.exitEmitted) return true;
    queueMicrotask(() => {
      const named = typeof signal === 'string' ? signal : 'SIGKILL';
      this.exitEmitted = true;
      this.exitCode = null;
      this.signalCode = named;
      this.emit('exit', null, named);
      this.stdin.end();
      this.stdout.end();
      this.stderr.end();
      setImmediate(() => {
        if (this.closeEmitted) return;
        this.closeEmitted = true;
        this.emit('close', null, named);
      });
    });
    return true;
  }

  send(value: unknown): void {
    this.stdout.write(`${JSON.stringify(value)}\n`);
  }

  async nextFrame(): Promise<Record<string, unknown>> {
    const queued = this.frames.shift();
    if (queued !== undefined) return queued;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('timed out waiting for client frame')), 3_000);
      this.waiters.push((frame) => {
        clearTimeout(timer);
        resolve(frame);
      });
    });
  }
}

interface DriverScript {
  readonly codexHome: string;
  readonly cwd: string;
  readonly scenario: 'complete' | 'interrupt';
}

// One unified frame dispatcher that serves BOTH the admission wire (discovery)
// and the thread/turn wire (a real turn) over a child's lifetime.
function driveChild(fake: FakeChild, script: DriverScript): Promise<void> {
  return (async () => {
    let stop = false;
    while (!stop) {
      let frame: Record<string, unknown>;
      try {
        frame = await fake.nextFrame();
      } catch {
        return; // Child idle/disposed; end the driver.
      }
      const method = frame.method;
      const id = frame.id;
      switch (method) {
        case 'initialize':
          fake.send({ id, result: { codexHome: script.codexHome, userAgent: 'x', platformFamily: 'unix', platformOs: 'linux' } });
          break;
        case 'initialized':
          // The admission (discovery) client blocks on this startup snapshot; the
          // turn transport simply drops it as non-canonical noise.
          fake.send({ method: 'remoteControl/status/changed', params: { status: 'disabled', serverName: 'srv', installationId: 'inst', environmentId: null } });
          break;
        case 'account/read':
          fake.send({ id, result: { account: { type: 'chatgpt', email: 'u@example.com', planType: 'pro' }, requiresOpenaiAuth: true } });
          break;
        case 'model/list':
          fake.send({ id, result: { data: [{ model: MODEL_ID, displayName: 'GPT-5.4', description: '', hidden: false, supportedReasoningEfforts: [] }], nextCursor: null } });
          break;
        case 'thread/start':
          fake.send({ id, result: threadResponse(script.cwd) });
          break;
        case 'turn/start':
          fake.send({ id, result: { turn: turn(TURN_ID, 'inProgress') } });
          if (script.scenario === 'complete') {
            emitCompletedTurn(fake, script.cwd);
          } else {
            emitInterruptibleTurn(fake);
          }
          break;
        case 'turn/interrupt':
          fake.send({ id, result: {} });
          fake.send(turnCompleted(TURN_ID, 'interrupted'));
          stop = true;
          break;
        default:
          if (typeof id !== 'undefined') fake.send({ id, error: { code: -32601, message: 'unsupported' } });
      }
    }
  })();
}

function emitCompletedTurn(fake: FakeChild, cwd: string): void {
  fake.send(turnStarted(TURN_ID));
  // Real-stream noise the live peer must filter BEFORE capture:
  fake.send({ method: 'thread/status/changed', params: { threadId: THREAD_ID, status: { type: 'active' } } });
  fake.send(itemStarted(TURN_ID, userMessageItem()));
  fake.send(itemCompleted(TURN_ID, userMessageItem()));
  // The canonical agent-message stream:
  fake.send(itemStarted(TURN_ID, agentMessage(ITEM_ID, '')));
  fake.send(agentDelta(TURN_ID, ITEM_ID, PONG));
  fake.send(itemCompleted(TURN_ID, agentMessage(ITEM_ID, PONG)));
  fake.send(turnCompleted(TURN_ID, 'completed', [agentMessage(ITEM_ID, PONG)]));
  // Trailing noise after the terminal frame (must never count as pending):
  fake.send({ method: 'account/rateLimits/updated', params: { primary: null } });
  fake.send({ method: 'thread/tokenUsage/updated', params: { threadId: THREAD_ID } });
}

function emitInterruptibleTurn(fake: FakeChild): void {
  fake.send(turnStarted(TURN_ID));
  fake.send(itemStarted(TURN_ID, agentMessage(ITEM_ID, '')));
  // First delta signals the turn is genuinely streaming and interruptible.
  fake.send(agentDelta(TURN_ID, ITEM_ID, 'The history of mechanical clocks '));
}

function tempDirs(t: TestContext): { codexHome: string; cwd: string } {
  const codexHome = realpathSync.native(mkdtempSync(join(tmpdir(), 'codex-lt-home-')));
  const cwd = realpathSync.native(mkdtempSync(join(tmpdir(), 'codex-lt-cwd-')));
  t.after(() => {
    rmSync(codexHome, { recursive: true, force: true });
    rmSync(cwd, { recursive: true, force: true });
  });
  return { codexHome, cwd };
}

function adapterWith(codexHome: string, cwd: string, scenario: 'complete' | 'interrupt'): {
  adapter: CodexRuntimeAdapter;
  drivers: Promise<void>[];
} {
  const drivers: Promise<void>[] = [];
  const spawnProcess: CodexAppServerProcessFactory = () => {
    const fake = new FakeChild();
    drivers.push(driveChild(fake, { codexHome, cwd, scenario }));
    return fake;
  };
  const adapter = new CodexRuntimeAdapter(createCodexLiveDeps({ codexHome, cwd, spawnProcess }));
  return { adapter, drivers };
}

test('a live create session round-trips a real pong turn and filters stream noise', async (t) => {
  const { codexHome, cwd } = tempDirs(t);
  const { adapter } = adapterWith(codexHome, cwd, 'complete');
  const session = await adapter.createSession({
    appSessionId: 'live-turn-app',
    projectId: 'live-turn-project',
    continuationAttemptId: 'live-turn-attempt',
    selection: structuredClone(SELECTION),
    cwd,
  });
  const events = await collect(session.sendTurn('Reply with exactly the single word: pong'));
  const types = events.map((e) => e.type);
  assert.deepEqual(types, [
    'session-started', 'session-state', 'delta', 'delta', 'delta', 'assistant-block', 'session-state', 'result',
  ]);
  const block = events.find((e) => e.type === 'assistant-block');
  assert.equal(block?.type === 'assistant-block' && block.block.kind === 'text' && block.block.text, PONG);
  const terminal = events.at(-1);
  assert.equal(terminal?.type === 'result' && terminal.ok, true);
  assert.equal(terminal?.type === 'result' && terminal.outcome, 'ok');
  // Native ids must never leak into the public event stream.
  const publicFrames = JSON.stringify(events.slice(1));
  assert.doesNotMatch(publicFrames, new RegExp(TURN_ID, 'u'));
  assert.doesNotMatch(publicFrames, new RegExp(ITEM_ID, 'u'));
  await session.dispose();
});

test('a live turn interrupt resolves to the typed aborted terminal', async (t) => {
  const { codexHome, cwd } = tempDirs(t);
  const { adapter } = adapterWith(codexHome, cwd, 'interrupt');
  const session = await adapter.createSession({
    appSessionId: 'live-turn-app',
    projectId: 'live-turn-project',
    continuationAttemptId: 'live-turn-attempt',
    selection: structuredClone(SELECTION),
    cwd,
  });
  const iterator = session.sendTurn('Write a long essay, one sentence per line, do not stop.')[Symbol.asyncIterator]();
  // Drain until the first streaming delta proves the turn is interruptible.
  let sawDelta = false;
  const observed: RuntimeEvent[] = [];
  while (!sawDelta) {
    const next = await iterator.next();
    assert.equal(next.done, false);
    observed.push(next.value!);
    if (next.value!.type === 'delta' && next.value!.delta.kind === 'text-delta') sawDelta = true;
  }
  await session.interrupt();
  for (;;) {
    const next = await iterator.next();
    if (next.done) break;
    observed.push(next.value);
  }
  const terminal = observed.at(-1);
  assert.equal(terminal?.type === 'result' && terminal.ok, false);
  assert.equal(terminal?.type === 'result' && terminal.outcome, 'aborted');
  await session.dispose();
});

async function collect(stream: AsyncIterable<RuntimeEvent>): Promise<RuntimeEvent[]> {
  const events: RuntimeEvent[] = [];
  for await (const event of stream) events.push(event);
  return events;
}

function threadResponse(cwd: string): Record<string, unknown> {
  return {
    thread: thread(cwd),
    model: MODEL_ID,
    modelProvider: CODEX_MODEL_PROVIDER,
    serviceTier: null,
    cwd,
    instructionSources: [],
    approvalPolicy: 'on-request',
    approvalsReviewer: 'user',
    sandbox: workspaceWriteSandbox(cwd),
    reasoningEffort: null,
  };
}

function workspaceWriteSandbox(cwd: string): Record<string, unknown> {
  return { type: 'workspaceWrite', writableRoots: [cwd], networkAccess: false, excludeTmpdirEnvVar: true, excludeSlashTmp: true };
}

function thread(cwd: string): Record<string, unknown> {
  return {
    id: THREAD_ID, sessionId: `session-${THREAD_ID}`, forkedFromId: null, parentThreadId: null,
    preview: '', ephemeral: false, modelProvider: CODEX_MODEL_PROVIDER, createdAt: 1, updatedAt: 1,
    recencyAt: null, status: { type: 'idle' }, path: null, cwd, cliVersion: CODEX_PROTOCOL_VERSION,
    source: 'appServer', threadSource: null, agentNickname: null, agentRole: null, gitInfo: null,
    name: null, turns: [],
  };
}

function turn(id: string, status: 'completed' | 'interrupted' | 'failed' | 'inProgress', items: unknown[] = []): Record<string, unknown> {
  return {
    id, items, itemsView: 'full', status, error: null, startedAt: 1,
    completedAt: status === 'inProgress' ? null : 2, durationMs: status === 'inProgress' ? null : 10,
  };
}

function agentMessage(id: string, text: string): Record<string, unknown> {
  return { type: 'agentMessage', id, text, phase: 'final_answer', memoryCitation: null };
}

function userMessageItem(): Record<string, unknown> {
  return { type: 'userMessage', id: '01900100-0000-7000-8000-0000000000ff', clientId: null, content: [] };
}

function turnStarted(turnId: string): Record<string, unknown> {
  return { method: 'turn/started', params: { threadId: THREAD_ID, turn: turn(turnId, 'inProgress') } };
}

function itemStarted(turnId: string, item: unknown): Record<string, unknown> {
  return { method: 'item/started', params: { threadId: THREAD_ID, turnId, item, startedAtMs: 1 } };
}

function agentDelta(turnId: string, itemId: string, delta: string): Record<string, unknown> {
  return { method: 'item/agentMessage/delta', params: { threadId: THREAD_ID, turnId, itemId, delta } };
}

function itemCompleted(turnId: string, item: unknown): Record<string, unknown> {
  return { method: 'item/completed', params: { threadId: THREAD_ID, turnId, item, completedAtMs: 2 } };
}

function turnCompleted(turnId: string, status: 'completed' | 'interrupted' | 'failed', items: unknown[] = []): Record<string, unknown> {
  return { method: 'turn/completed', params: { threadId: THREAD_ID, turn: turn(turnId, status, items) } };
}
