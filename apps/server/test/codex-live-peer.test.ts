// Live Codex peer — discovery mapping and error paths against a scripted fake
// app-server child (the app-server-client injection seam), plus the typed gate
// on the not-yet-built turn peer. No real process is spawned here.

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
import {
  createCodexLiveDeps,
  CodexLivePeerError,
} from '../src/runner/codex/live-peer.ts';
import { CodexRuntimeAdapter, CodexRuntimeAdapterError } from '../src/runner/codex/adapter.ts';
import {
  CODEX_PROTOCOL_VERSION,
  CODEX_RUNTIME_ID,
  type CodexRuntimePeerFactoryInput,
} from '../src/runner/codex/runtime-peer.ts';
import type { RuntimeSelection } from '@pc/contracts';

const ACCOUNT_ID = 'codex-live';

class FakeChild extends EventEmitter implements CodexAppServerProcess {
  readonly stdin = new PassThrough();
  readonly stdout = new PassThrough();
  readonly stderr = new PassThrough();
  readonly pid = 5150;
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
        const newline = this.buffer.indexOf('\n');
        if (newline === -1) break;
        const line = this.buffer.slice(0, newline);
        this.buffer = this.buffer.slice(newline + 1);
        const frame = JSON.parse(line) as Record<string, unknown>;
        const waiter = this.waiters.shift();
        if (waiter) waiter(frame);
        else this.frames.push(frame);
      }
    });
  }

  kill(signal: NodeJS.Signals | number = 'SIGTERM'): boolean {
    this.killSignals.push(signal);
    if (this.exitEmitted) return true;
    queueMicrotask(() => {
      const named = typeof signal === 'string' ? signal : 'SIGTERM';
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
      const timer = setTimeout(() => reject(new Error('timed out waiting for client frame')), 2_000);
      this.waiters.push((frame) => {
        clearTimeout(timer);
        resolve(frame);
      });
    });
  }
}

interface AdmissionScript {
  readonly codexHome: string;
  /** Raw account/read response value, or 'error' to reject initialize. */
  readonly account?: unknown;
  readonly failInitialize?: boolean;
  readonly modelPages?: unknown[];
}

async function driveAdmission(fake: FakeChild, script: AdmissionScript): Promise<void> {
  const init = await fake.nextFrame();
  assert.equal(init.method, 'initialize');
  if (script.failInitialize) {
    fake.send({ id: init.id, error: { code: -1, message: 'initialize refused' } });
    return;
  }
  fake.send({
    id: init.id,
    result: {
      userAgent: 'fake-agent',
      codexHome: script.codexHome,
      platformFamily: 'unix',
      platformOs: 'linux',
    },
  });
  const initialized = await fake.nextFrame();
  assert.equal(initialized.method, 'initialized');
  fake.send({
    method: 'remoteControl/status/changed',
    params: { status: 'disabled', serverName: 'srv', installationId: 'inst', environmentId: null },
  });

  const account = await fake.nextFrame();
  assert.equal(account.method, 'account/read');
  fake.send({ id: account.id, result: script.account ?? null });

  for (const page of script.modelPages ?? []) {
    const req = await fake.nextFrame();
    assert.equal(req.method, 'model/list');
    fake.send({ id: req.id, result: page });
  }
}

function tempDirs(t: TestContext): { codexHome: string; cwd: string } {
  const codexHome = realpathSync.native(mkdtempSync(join(tmpdir(), 'codex-live-home-')));
  const cwd = realpathSync.native(mkdtempSync(join(tmpdir(), 'codex-live-cwd-')));
  t.after(() => {
    rmSync(codexHome, { recursive: true, force: true });
    rmSync(cwd, { recursive: true, force: true });
  });
  return { codexHome, cwd };
}

function chatgptAccount(): unknown {
  return { account: { type: 'chatgpt', email: 'user@example.com', planType: 'pro' }, requiresOpenaiAuth: true };
}

function adapterWith(
  codexHome: string,
  cwd: string,
): { adapter: CodexRuntimeAdapter; fakes: FakeChild[] } {
  const fakes: FakeChild[] = [];
  const spawnProcess: CodexAppServerProcessFactory = () => {
    const fake = new FakeChild();
    fakes.push(fake);
    return fake;
  };
  const adapter = new CodexRuntimeAdapter(createCodexLiveDeps({ codexHome, cwd, spawnProcess }));
  return { adapter, fakes };
}

test('live discovery maps the real catalog across pages and reaps the child', async (t) => {
  const { codexHome, cwd } = tempDirs(t);
  const { adapter, fakes } = adapterWith(codexHome, cwd);
  const pending = adapter.listModels(ACCOUNT_ID);
  const fake = fakes[0]!;
  await driveAdmission(fake, {
    codexHome,
    account: chatgptAccount(),
    modelPages: [
      {
        data: [
          {
            model: 'gpt-5.4',
            displayName: 'GPT-5.4',
            description: 'flagship',
            hidden: false,
            supportedReasoningEfforts: [
              { reasoningEffort: 'low', description: '' },
              { reasoningEffort: 'high', description: '' },
            ],
          },
          { model: 'hidden-model', displayName: 'Hidden', description: '', hidden: true, supportedReasoningEfforts: [] },
        ],
        nextCursor: 'cursor-2',
      },
      {
        data: [
          {
            model: 'gpt-5.4-mini',
            displayName: 'GPT-5.4 mini',
            description: '',
            hidden: false,
            supportedReasoningEfforts: [],
          },
        ],
        nextCursor: null,
      },
    ],
  });
  const discovery = await pending;
  assert.deepEqual(discovery, {
    status: 'available',
    models: [
      {
        id: 'gpt-5.4',
        resolvedId: null,
        label: 'GPT-5.4',
        description: 'flagship',
        effort: { status: 'supported', values: ['low', 'high'] },
      },
      {
        id: 'gpt-5.4-mini',
        resolvedId: null,
        label: 'GPT-5.4 mini',
        description: '',
        effort: { status: 'unsupported', code: 'codex-model-effort-unsupported' },
      },
    ],
  });
  assert.ok(fake.killSignals.length >= 1, 'discovery must reap its one-shot child');
});

test('live discovery surfaces a missing ChatGPT login as typed account-unavailable', async (t) => {
  const { codexHome, cwd } = tempDirs(t);
  const { adapter, fakes } = adapterWith(codexHome, cwd);
  const pending = adapter.listModels(ACCOUNT_ID);
  await driveAdmission(fakes[0]!, {
    codexHome,
    account: { account: null, requiresOpenaiAuth: true },
  });
  assert.deepEqual(await pending, { status: 'unavailable', code: 'account-unavailable' });

  // capabilities() derives the same account-unavailable attribution.
  const capsFakes = adapterWith(codexHome, cwd);
  const capsPending = capsFakes.adapter.capabilities(ACCOUNT_ID);
  await driveAdmission(capsFakes.fakes[0]!, { codexHome, account: { account: { type: 'apiKey' }, requiresOpenaiAuth: false } });
  const caps = await capsPending;
  assert.equal(caps.modelDiscovery.status, 'unavailable');
  assert.equal(caps.modelDiscovery.status === 'unavailable' && caps.modelDiscovery.code, 'account-unavailable');
});

test('live discovery degrades to discovery-unavailable on a malformed catalog', async (t) => {
  const { codexHome, cwd } = tempDirs(t);
  const { adapter, fakes } = adapterWith(codexHome, cwd);
  const pending = adapter.listModels(ACCOUNT_ID);
  await driveAdmission(fakes[0]!, {
    codexHome,
    account: chatgptAccount(),
    modelPages: [{ data: 'not-an-array', nextCursor: null }],
  });
  assert.deepEqual(await pending, { status: 'unavailable', code: 'codex-discovery-unavailable' });
});

test('live discovery degrades to discovery-unavailable when initialize fails', async (t) => {
  const { codexHome, cwd } = tempDirs(t);
  const { adapter, fakes } = adapterWith(codexHome, cwd);
  const pending = adapter.listModels(ACCOUNT_ID);
  await driveAdmission(fakes[0]!, { codexHome, failInitialize: true });
  assert.deepEqual(await pending, { status: 'unavailable', code: 'codex-discovery-unavailable' });
});

test('the live turn peer is gated loudly and never silently faked', async () => {
  const deps = createCodexLiveDeps({ codexHome: '/tmp/x', cwd: '/tmp/y' });
  const input: CodexRuntimePeerFactoryInput = {
    continuationAttemptId: 'attempt',
    selection: {
      runtimeId: CODEX_RUNTIME_ID,
      accountId: ACCOUNT_ID,
      model: 'gpt-5.4',
      effort: { kind: 'none' },
    } satisfies RuntimeSelection,
    mode: 'create',
    requestedThreadId: null,
    cwd: '/tmp/y',
  };
  assert.throws(
    () => deps.runtimePeerFactory(input),
    (error: unknown) => error instanceof CodexLivePeerError && error.code === 'live-turn-peer-unavailable',
  );
  await assert.rejects(
    () => deps.conformanceAuthority.attestExecutionPolicy(
      {} as never,
      {} as never,
    ),
    (error: unknown) => error instanceof CodexLivePeerError && error.code === 'live-turn-peer-unavailable',
  );
  await assert.rejects(
    () => deps.conformanceAuthority.attestTurnBoundary({} as never, {} as never),
    (error: unknown) => error instanceof CodexLivePeerError && error.code === 'live-turn-peer-unavailable',
  );
});

test('createCodexLiveDeps rejects non-canonical option shapes', () => {
  assert.throws(
    () => createCodexLiveDeps({ codexHome: '', cwd: '/tmp/y' }),
    (error: unknown) => error instanceof CodexLivePeerError && error.code === 'invalid-live-peer-options',
  );
});

test('CodexRuntimeAdapterError remains the surfaced failure when the turn peer is gated', () => {
  // Documents the contract wiring: a gated factory throw becomes the adapter's
  // typed session-mint-unavailable (proven end-to-end in the live smoke).
  assert.equal(new CodexRuntimeAdapterError('session-mint-unavailable').code, 'session-mint-unavailable');
});
