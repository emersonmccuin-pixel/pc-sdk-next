import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, sep } from 'node:path';
import { PassThrough } from 'node:stream';
import { setImmediate as waitImmediate } from 'node:timers/promises';
import { test, type TestContext } from 'node:test';
import {
  startCodexAppServer,
  type CodexAppServerClient,
  type CodexAppServerProcess,
  type CodexAppServerSpawnOptions,
  type CodexNotificationReceipt,
  type CodexProcessExitReceipt,
  type StartCodexAppServerOptions,
} from '../src/runner/codex/app-server-client.ts';
import { resolvePinnedCodexExecutable } from '../src/runner/codex/executable.ts';
import {
  CodexAppServerError,
  type CodexAppServerErrorCode,
} from '../src/runner/codex/protocol.ts';

interface SpawnCapture {
  command: string;
  args: readonly string[];
  options: CodexAppServerSpawnOptions;
}

class FakeAppServerProcess extends EventEmitter implements CodexAppServerProcess {
  readonly stdin = new PassThrough();
  readonly stdout = new PassThrough();
  readonly stderr = new PassThrough();
  readonly pid = 4242;
  exitCode: number | null = null;
  signalCode: NodeJS.Signals | null = null;
  readonly killSignals: Array<NodeJS.Signals | number> = [];
  readonly stdinEndedAtKill: boolean[] = [];
  autoExitOnKill = true;
  autoCloseOnKill = true;
  killResult = true;
  killThrows = false;

  private exitEmitted = false;
  private closeScheduled = false;
  private closeEmitted = false;

  private clientBuffer = '';
  private readonly clientFrames: unknown[] = [];
  private readonly clientWaiters: Array<(frame: unknown) => void> = [];

  constructor() {
    super();
    this.stdin.on('data', (chunk: Buffer) => {
      this.clientBuffer += chunk.toString('utf8');
      for (;;) {
        const newline = this.clientBuffer.indexOf('\n');
        if (newline === -1) break;
        const line = this.clientBuffer.slice(0, newline);
        this.clientBuffer = this.clientBuffer.slice(newline + 1);
        const frame = JSON.parse(line) as unknown;
        const waiter = this.clientWaiters.shift();
        if (waiter) waiter(frame);
        else this.clientFrames.push(frame);
      }
    });
  }

  kill(signal: NodeJS.Signals | number = 'SIGTERM'): boolean {
    this.killSignals.push(signal);
    this.stdinEndedAtKill.push(this.stdin.writableEnded);
    if (this.killThrows) throw new Error('private injected kill failure');
    if (this.autoExitOnKill && this.exitCode === null && this.signalCode === null) {
      queueMicrotask(() => {
        this.emitExit(null, typeof signal === 'string' ? signal : null);
        if (this.autoCloseOnKill) {
          this.emitClose(null, typeof signal === 'string' ? signal : null);
        }
      });
    }
    return this.killResult;
  }

  emitExit(code: number | null, signal: NodeJS.Signals | null): void {
    if (this.exitEmitted) return;
    this.exitEmitted = true;
    this.exitCode = code;
    this.signalCode = signal;
    this.emit('exit', code, signal);
  }

  emitClose(
    code: number | null = this.exitCode,
    signal: NodeJS.Signals | null = this.signalCode,
  ): void {
    if (this.closeScheduled || this.closeEmitted) return;
    this.closeScheduled = true;
    this.stdin.end();
    this.stdout.end();
    this.stderr.end();
    setImmediate(() => {
      this.closeEmitted = true;
      this.emit('close', code, signal);
    });
  }

  async nextClientFrame(): Promise<Record<string, unknown>> {
    const queued = this.clientFrames.shift();
    if (queued !== undefined) return queued as Record<string, unknown>;
    return await new Promise<Record<string, unknown>>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('timed out waiting for client frame')), 1_000);
      this.clientWaiters.push((frame) => {
        clearTimeout(timer);
        resolve(frame as Record<string, unknown>);
      });
    });
  }

  queuedClientFrameCount(): number {
    return this.clientFrames.length;
  }

  sendJson(value: unknown, fragmentSizes: readonly number[] = []): void {
    this.sendBytes(Buffer.from(`${JSON.stringify(value)}\n`, 'utf8'), fragmentSizes);
  }

  sendBytes(bytes: Buffer, fragmentSizes: readonly number[] = []): void {
    let offset = 0;
    for (const size of fragmentSizes) {
      if (offset >= bytes.length) break;
      const end = Math.min(offset + size, bytes.length);
      this.stdout.write(bytes.subarray(offset, end));
      offset = end;
    }
    if (offset < bytes.length) this.stdout.write(bytes.subarray(offset));
  }
}

class FakeAsyncSpawnFailure extends EventEmitter implements CodexAppServerProcess {
  readonly stdin = new PassThrough();
  readonly stdout = new PassThrough();
  readonly stderr = new PassThrough();
  readonly exitCode = null;
  readonly signalCode = null;
  readonly killSignals: Array<NodeJS.Signals | number> = [];

  constructor() {
    super();
    this.stdin.resume();
  }

  kill(signal: NodeJS.Signals | number = 'SIGTERM'): boolean {
    this.killSignals.push(signal);
    return false;
  }

  fail(error: Error, closeCode = -4058, closeSignal: NodeJS.Signals | null = null): void {
    this.emit('error', error);
    this.stdout.end();
    this.stderr.end();
    setImmediate(() => this.emit('close', closeCode, closeSignal));
  }
}

interface Harness {
  readonly home: string;
  readonly process: FakeAppServerProcess;
  readonly client: CodexAppServerClient;
  readonly capture: SpawnCapture;
}

function harness(
  t: TestContext,
  overrides: Partial<StartCodexAppServerOptions> = {},
): Harness {
  const temporaryHome = mkdtempSync(join(tmpdir(), 'pc-sdk-codex-client-'));
  const home = realpathSync.native(temporaryHome);
  t.after(() => rmSync(temporaryHome, { recursive: true, force: true }));
  const process = new FakeAppServerProcess();
  let capture: SpawnCapture | null = null;
  const client = startCodexAppServer({
    codexHome: home,
    cwd: home,
    requestTimeoutMs: 500,
    disposalTimeoutMs: 50,
    ...overrides,
    spawnProcess(command, args, options) {
      capture = { command, args: [...args], options };
      return process;
    },
  });
  assert.ok(capture);
  return { home, process, client, capture };
}

function initializeResult(home: string): Record<string, unknown> {
  return {
    userAgent: 'codex-cli/0.144.1',
    codexHome: home,
    platformFamily: process.platform === 'win32' ? 'windows' : 'unix',
    platformOs: process.platform === 'win32' ? 'windows' : 'linux',
  };
}

function remoteControlNotification(
  status: 'disabled' | 'connecting' | 'connected' | 'errored' = 'disabled',
  environmentId: string | null = null,
): Record<string, unknown> {
  return {
    method: 'remoteControl/status/changed',
    params: {
      status,
      serverName: 'private-server-name',
      installationId: 'private-installation-id',
      environmentId,
    },
  };
}

async function initializeHealthy(
  value: Harness,
  fragmentSizes: readonly number[] = [1, 2, 3, 5, 8],
): Promise<void> {
  const initializing = value.client.initialize();
  const request = await value.process.nextClientFrame();
  assert.equal(request.method, 'initialize');
  value.process.sendJson({
    id: request.id,
    result: initializeResult(value.home),
  }, fragmentSizes);
  assert.deepEqual(await value.process.nextClientFrame(), { method: 'initialized' });
  value.process.sendJson(remoteControlNotification());
  assert.deepEqual(await initializing, {
    status: 'initialized',
    exactCodexHome: true,
    remoteControl: { status: 'disabled', environmentId: null },
  });
}

async function assertCodexError(
  promise: Promise<unknown>,
  code: CodexAppServerErrorCode,
  sensitiveValue?: string,
): Promise<void> {
  await assert.rejects(promise, (error: unknown) => {
    assert.ok(error instanceof CodexAppServerError);
    assert.equal(error.code, code);
    assert.equal(error.message, `Codex app-server unavailable: ${code}`);
    assert.equal('cause' in error, false);
    if (sensitiveValue) assert.equal(error.message.includes(sensitiveValue), false);
    return true;
  });
}

test('spawns the pinned native app-server and enforces handshake, correlation, and sanitized notifications', async (t) => {
  const value = harness(t);
  const notifications: CodexNotificationReceipt[] = [];
  const unsubscribe = value.client.onNotification((notification) => {
    notifications.push(notification);
  });

  await assertCodexError(
    value.client.request('account/read', { refreshToken: false }),
    'client-not-ready',
  );
  assert.equal(value.process.queuedClientFrameCount(), 0);

  const initializing = value.client.initialize();
  const initializeRequest = await value.process.nextClientFrame();
  assert.deepEqual(initializeRequest, {
    method: 'initialize',
    id: 1,
    params: {
      clientInfo: {
        name: 'pc-sdk-next',
        title: 'PC-SDK Next',
        version: '0.0.0',
      },
      capabilities: {
        experimentalApi: false,
        requestAttestation: false,
      },
    },
  });
  value.process.sendJson({ id: 1, result: initializeResult(value.home) }, [1, 1, 2, 3, 5]);
  assert.deepEqual(await value.process.nextClientFrame(), { method: 'initialized' });
  value.process.sendJson(remoteControlNotification(), [2, 7, 1]);
  const initializeReceipt = await initializing;
  assert.deepEqual(initializeReceipt, {
    status: 'initialized',
    exactCodexHome: true,
    remoteControl: { status: 'disabled', environmentId: null },
  });
  assert.equal(JSON.stringify(initializeReceipt).includes('private-'), false);

  await assertCodexError(value.client.initialize(), 'initialize-already-started');

  const config = value.client.request('config/read', { includeLayers: true, cwd: value.home });
  const account = value.client.request('account/read', { refreshToken: false });
  const models = value.client.request('model/list', { includeHidden: false });
  const configRequest = await value.process.nextClientFrame();
  const accountRequest = await value.process.nextClientFrame();
  const modelRequest = await value.process.nextClientFrame();
  assert.deepEqual(
    [configRequest.method, accountRequest.method, modelRequest.method],
    ['config/read', 'account/read', 'model/list'],
  );

  value.process.sendJson({ id: modelRequest.id, result: { models: ['m1'] } }, [1, 4, 2]);
  value.process.sendJson({ id: configRequest.id, result: { config: 'safe' } }, [2, 1, 9]);
  value.process.sendJson({ id: accountRequest.id, result: { account: 'chatgpt' } });

  assert.deepEqual(await models, { models: ['m1'] });
  assert.deepEqual(await config, { config: 'safe' });
  assert.deepEqual(await account, { account: 'chatgpt' });
  assert.deepEqual(notifications, [
    { method: 'remoteControl/status/changed', status: 'disabled', environmentId: null },
  ]);
  assert.equal(JSON.stringify(notifications).includes('private-'), false);

  unsubscribe();
  assert.equal(notifications.length, 1);

  const executable = resolvePinnedCodexExecutable();
  assert.equal(value.capture.command, executable.command);
  assert.deepEqual(value.capture.args, [
    'app-server',
    '--stdio',
    '-c',
    'cli_auth_credentials_store="file"',
  ]);
  assert.equal(value.capture.options.cwd, value.home);
  assert.equal(value.capture.options.shell, false);
  assert.equal(value.capture.options.windowsHide, true);
  assert.equal(value.capture.options.detached, false);
  assert.deepEqual(value.capture.options.stdio, ['pipe', 'pipe', 'pipe']);
  assert.equal(value.capture.options.env.CODEX_HOME, value.home);
  assert.equal('OPENAI_API_KEY' in value.capture.options.env, false);
  assert.equal('OPENAI_BASE_URL' in value.capture.options.env, false);
  assert.equal('CLAUDE_CONFIG_DIR' in value.capture.options.env, false);

  const firstDisposal = value.client.dispose();
  const secondDisposal = value.client.dispose();
  assert.strictEqual(firstDisposal, secondDisposal);
  assert.deepEqual(await firstDisposal, {
    status: 'exited',
    code: null,
    signal: 'SIGTERM',
  });
  assert.deepEqual(value.process.killSignals, ['SIGTERM']);
  assert.deepEqual(value.process.stdinEndedAtKill, [false]);
});

test('initialize requires the exact home, nonempty response fields, and a positive remote-control snapshot', async (t) => {
  await t.test('exact home', async (t) => {
    const value = harness(t);
    const initializing = value.client.initialize();
    const request = await value.process.nextClientFrame();
    const sensitiveAlias = `${value.home}-alias`;
    value.process.sendJson({ id: request.id, result: initializeResult(sensitiveAlias) });
    await assertCodexError(initializing, 'initialize-home-mismatch', sensitiveAlias);
    assert.equal(value.process.queuedClientFrameCount(), 0);
    await assertCodexError(value.client.dispose(), 'initialize-home-mismatch');
  });

  await t.test('strict nonempty fields', async (t) => {
    const value = harness(t);
    const initializing = value.client.initialize();
    const request = await value.process.nextClientFrame();
    value.process.sendJson({
      id: request.id,
      result: { ...initializeResult(value.home), platformFamily: '   ' },
    });
    await assertCodexError(initializing, 'initialize-response-invalid');
    assert.equal(value.process.queuedClientFrameCount(), 0);
    await assertCodexError(value.client.dispose(), 'initialize-response-invalid');
  });

  await t.test('remote-control receipt is mandatory in the current initialize handshake', async (t) => {
    const value = harness(t, { requestTimeoutMs: 10 });
    const initializing = value.client.initialize();
    const request = await value.process.nextClientFrame();
    value.process.sendJson({ id: request.id, result: initializeResult(value.home) });
    assert.deepEqual(await value.process.nextClientFrame(), { method: 'initialized' });
    await assertCodexError(initializing, 'remote-control-status-unavailable');
    await assertCodexError(value.client.dispose(), 'remote-control-status-unavailable');
  });

  await t.test('the pinned in-flight remote-control snapshot satisfies only the current handshake', async (t) => {
    const value = harness(t);
    const initializing = value.client.initialize();
    const request = await value.process.nextClientFrame();
    value.process.sendJson(remoteControlNotification());
    value.process.sendJson({ id: request.id, result: initializeResult(value.home) });
    assert.deepEqual(await value.process.nextClientFrame(), { method: 'initialized' });
    assert.deepEqual(await initializing, {
      status: 'initialized',
      exactCodexHome: true,
      remoteControl: { status: 'disabled', environmentId: null },
    });
    await value.client.dispose();
  });

  await t.test('a snapshot processed before initialize cannot satisfy its handshake', async (t) => {
    const value = harness(t, { requestTimeoutMs: 10 });
    value.process.sendJson(remoteControlNotification());
    await waitImmediate();
    const initializing = value.client.initialize();
    const request = await value.process.nextClientFrame();
    value.process.sendJson({ id: request.id, result: initializeResult(value.home) });
    assert.deepEqual(await value.process.nextClientFrame(), { method: 'initialized' });
    await assertCodexError(initializing, 'remote-control-status-unavailable');
    await assertCodexError(value.client.dispose(), 'remote-control-status-unavailable');
  });

  await t.test('notification reentrancy cannot restore ready after disposal starts', async (t) => {
    const value = harness(t);
    let disposal: Promise<CodexProcessExitReceipt> | null = null;
    value.client.onNotification(() => {
      disposal = value.client.dispose();
    });
    const initializing = value.client.initialize();
    const request = await value.process.nextClientFrame();
    value.process.sendJson({ id: request.id, result: initializeResult(value.home) });
    assert.deepEqual(await value.process.nextClientFrame(), { method: 'initialized' });
    value.process.sendJson(remoteControlNotification());
    await assertCodexError(initializing, 'client-disposed');
    await assertCodexError(
      value.client.request('account/read', { refreshToken: false }),
      'client-not-ready',
    );
    assert.ok(disposal);
    assert.deepEqual(await disposal, {
      status: 'exited',
      code: null,
      signal: 'SIGTERM',
    });
  });
});

test('request allowlist is runtime-enforced and provider errors are redacted without poisoning the client', async (t) => {
  const value = harness(t);
  await initializeHealthy(value);

  await assertCodexError(
    value.client.request('turn/start' as 'account/read', { dangerous: true }),
    'request-method-not-allowed',
  );
  assert.equal(value.process.queuedClientFrameCount(), 0);

  const sensitiveProviderError = 'native provider error for private@example.invalid';
  const failed = value.client.request('account/read', { refreshToken: false });
  const failedRequest = await value.process.nextClientFrame();
  value.process.sendJson({
    id: failedRequest.id,
    error: { code: -32000, message: sensitiveProviderError, data: { token: 'secret' } },
  });
  await assertCodexError(failed, 'response-error', sensitiveProviderError);

  const succeeding = value.client.request('model/list', { includeHidden: false });
  const succeedingRequest = await value.process.nextClientFrame();
  value.process.sendJson({ id: succeedingRequest.id, result: { data: ['model'] } });
  assert.deepEqual(await succeeding, { data: ['model'] });
  await value.client.dispose();
});

test('admission request parameters are exact, cwd-bound, refresh-free, and bounded', async (t) => {
  const value = harness(t);
  await initializeHealthy(value);
  const invalid: ReadonlyArray<readonly [
    'config/read' | 'account/read' | 'model/list',
    unknown,
  ]> = [
    ['config/read', {}],
    ['config/read', { cwd: value.home, includeLayers: false }],
    ['config/read', { cwd: `${value.home}-other`, includeLayers: true }],
    ['config/read', { cwd: value.home, includeLayers: true, extra: true }],
    ['account/read', {}],
    ['account/read', { refreshToken: true }],
    ['account/read', { refreshToken: false, extra: true }],
    ['model/list', {}],
    ['model/list', { includeHidden: true }],
    ['model/list', { includeHidden: null }],
    ['model/list', { includeHidden: false, cursor: '' }],
    ['model/list', { includeHidden: false, cursor: ' padded ' }],
    ['model/list', { includeHidden: false, cursor: 7 }],
    ['model/list', { includeHidden: false, limit: 0 }],
    ['model/list', { includeHidden: false, limit: 1.5 }],
    ['model/list', { includeHidden: false, limit: 1_001 }],
    ['model/list', { includeHidden: false, extra: true }],
  ];

  for (const [method, params] of invalid) {
    await assertCodexError(
      value.client.request(method, params),
      'request-params-not-allowed',
    );
  }
  assert.equal(value.process.queuedClientFrameCount(), 0);

  const valid = value.client.request('model/list', {
    cursor: null,
    includeHidden: false,
    limit: 1_000,
  });
  const request = await value.process.nextClientFrame();
  assert.deepEqual(request.params, {
    cursor: null,
    includeHidden: false,
    limit: 1_000,
  });
  value.process.sendJson({ id: request.id, result: { data: [] } });
  assert.deepEqual(await valid, { data: [] });
  await value.client.dispose();
});

test('admission request parameters reject accessors and serialize normalized data once', async (t) => {
  const value = harness(t);
  await initializeHealthy(value);

  let refreshReads = 0;
  const refreshAccessor = Object.defineProperty({}, 'refreshToken', {
    enumerable: true,
    get() {
      refreshReads += 1;
      return refreshReads === 1 ? false : true;
    },
  });
  await assertCodexError(
    value.client.request('account/read', refreshAccessor),
    'request-params-not-allowed',
  );
  assert.equal(refreshReads, 0);

  let descriptorReads = 0;
  const source = { includeHidden: false };
  const shiftingProxy = new Proxy(source, {
    getOwnPropertyDescriptor(target, property) {
      descriptorReads += 1;
      const descriptor = Reflect.getOwnPropertyDescriptor(target, property);
      if (descriptor && property === 'includeHidden' && descriptorReads > 1) {
        return { ...descriptor, value: true };
      }
      return descriptor;
    },
  });
  const pending = value.client.request('model/list', shiftingProxy);
  const request = await value.process.nextClientFrame();
  assert.deepEqual(request.params, { includeHidden: false });
  assert.equal(descriptorReads, 1);
  value.process.sendJson({ id: request.id, result: { data: [] } });
  assert.deepEqual(await pending, { data: [] });
  assert.equal(value.process.queuedClientFrameCount(), 0);
  await value.client.dispose();
});

test('request options require an exact plain own-key object', async (t) => {
  const value = harness(t);
  await initializeHealthy(value);
  const request = value.client.request.bind(value.client) as (
    method: string,
    params: unknown,
    options: unknown,
  ) => Promise<unknown>;
  const inherited = Object.create({ timeoutMs: 10 }) as object;
  const throwing = Object.defineProperty({}, 'timeoutMs', {
    enumerable: true,
    get() {
      throw new Error('private getter failure');
    },
  });
  const returning = Object.defineProperty({}, 'timeoutMs', {
    enumerable: true,
    get() {
      return 10;
    },
  });
  for (const options of [
    null,
    0,
    true,
    'timeout',
    [],
    () => {},
    new Date(),
    inherited,
    { extra: true },
    throwing,
    returning,
  ]) {
    await assertCodexError(
      request('model/list', { includeHidden: false }, options),
      'invalid-client-option',
    );
  }
  assert.equal(value.process.queuedClientFrameCount(), 0);
  await value.client.dispose();
});

test('explicit disposal ignores cancelled responses and outbound write errors while requiring lifecycle proof', async (t) => {
  const value = harness(t, { disposalTimeoutMs: 50 });
  await initializeHealthy(value);
  const pending = value.client.request('account/read', { refreshToken: false });
  const request = await value.process.nextClientFrame();
  const disposal = value.client.dispose();
  value.process.sendJson({ id: request.id, result: { account: null } });
  value.process.stdin.emit('error', new Error('private EPIPE after explicit disposal'));
  await assertCodexError(pending, 'client-disposed');
  assert.deepEqual(await disposal, {
    status: 'exited',
    code: null,
    signal: 'SIGTERM',
  });
});

test('notification listener registration rejects nonfunctions without poisoning the client', async (t) => {
  const value = harness(t);
  await initializeHealthy(value);
  const subscribe = value.client.onNotification.bind(value.client) as (listener: unknown) => () => void;
  for (const listener of [null, 7, {}, 'listener']) {
    assert.throws(
      () => subscribe(listener),
      (error: unknown) => error instanceof CodexAppServerError &&
        error.code === 'invalid-client-option',
    );
  }
  const notifications: CodexNotificationReceipt[] = [];
  const unsubscribe = value.client.onNotification((notification) => {
    notifications.push(notification);
  });
  value.process.sendJson(remoteControlNotification());
  await waitImmediate();
  assert.equal(notifications.length, 1);
  unsubscribe();
  await value.client.dispose();
});

test('duplicate, conflicting, and unknown responses fail every pending request', async (t) => {
  for (const scenario of ['duplicate', 'conflicting', 'unknown'] as const) {
    await t.test(scenario, async (t) => {
      const value = harness(t);
      await initializeHealthy(value);

      let priorRequest: Record<string, unknown> | null = null;
      if (scenario !== 'unknown') {
        const prior = value.client.request('config/read', {
          cwd: value.home,
          includeLayers: true,
        });
        priorRequest = await value.process.nextClientFrame();
        value.process.sendJson({ id: priorRequest.id, result: { first: true } });
        await prior;
      }

      const pending = value.client.request('account/read', { refreshToken: false });
      await value.process.nextClientFrame();
      if (scenario === 'duplicate') {
        value.process.sendJson({ id: priorRequest?.id, result: { first: true } });
      } else if (scenario === 'conflicting') {
        value.process.sendJson({
          id: priorRequest?.id,
          error: { code: -1, message: 'conflict' },
        });
      } else {
        value.process.sendJson({ id: 999_999, result: {} });
      }

      const expected = scenario === 'duplicate'
        ? 'duplicate-response'
        : scenario === 'conflicting'
        ? 'conflicting-response'
        : 'unknown-response';
      await assertCodexError(pending, expected);
      await assertCodexError(value.client.dispose(), expected);
    });
  }
});

test('request timeout rejects concurrent work and a late frame cannot recover it', async (t) => {
  const value = harness(t, { requestTimeoutMs: 500 });
  await initializeHealthy(value);

  const first = value.client.request('config/read', {
    cwd: value.home,
    includeLayers: true,
  }, { timeoutMs: 10 });
  const second = value.client.request('model/list', { includeHidden: false });
  const firstRequest = await value.process.nextClientFrame();
  await value.process.nextClientFrame();
  await Promise.all([
    assertCodexError(first, 'request-timeout'),
    assertCodexError(second, 'request-timeout'),
  ]);

  value.process.sendJson({ id: firstRequest.id, result: { tooLate: true } });
  await assertCodexError(value.client.dispose(), 'dispose-timeout');
});

test('strict byte framing rejects malformed, oversized, and invalid UTF-8 input', async (t) => {
  const cases: ReadonlyArray<{
    name: string;
    code: CodexAppServerErrorCode;
    send(process: FakeAppServerProcess): void;
  }> = [
    {
      name: 'invalid JSON',
      code: 'invalid-json',
      send: (process) => process.sendBytes(Buffer.from('{not-json}\n')),
    },
    {
      name: 'malformed response',
      code: 'malformed-message',
      send: (process) => process.sendJson({
        id: 1,
        result: {},
        error: { code: -1, message: 'both' },
      }),
    },
    {
      name: 'invalid UTF-8',
      code: 'invalid-utf8',
      send: (process) => process.sendBytes(Buffer.from([0xc3, 0x28, 0x0a])),
    },
    {
      name: 'oversized unterminated frame',
      code: 'frame-too-large',
      send: (process) => process.sendBytes(Buffer.alloc(513, 0x61)),
    },
  ];

  for (const scenario of cases) {
    await t.test(scenario.name, async (t) => {
      const value = harness(t, { maxFrameBytes: 512 });
      const initializing = value.client.initialize();
      await value.process.nextClientFrame();
      scenario.send(value.process);
      await assertCodexError(initializing, scenario.code);
      await assertCodexError(value.client.dispose(), scenario.code);
    });
  }
});

test('every server request is refused on the wire before the client fails closed', async (t) => {
  const value = harness(t);
  await initializeHealthy(value);
  const sensitiveParams = 'private approval details';

  value.process.sendJson({
    method: 'item/tool/requestUserInput',
    id: 'server-request-1',
    params: { prompt: sensitiveParams },
  });
  const refusal = await value.process.nextClientFrame();
  assert.deepEqual(refusal, {
    id: 'server-request-1',
    error: {
      code: -32601,
      message: 'server requests are not supported',
    },
  });
  assert.equal(JSON.stringify(refusal).includes(sensitiveParams), false);
  await assertCodexError(value.client.dispose(), 'server-request-refused');
  assert.deepEqual(value.process.killSignals, ['SIGTERM']);
});

test('notification admission fails every warning channel, remote activation, and all unproven methods', async (t) => {
  const warnings = [
    'warning',
    'guardianWarning',
    'configWarning',
    'windows/worldWritableWarning',
    'deprecationNotice',
    'error',
  ];
  for (const method of warnings) {
    await t.test(method, async (t) => {
      const value = harness(t);
      await initializeHealthy(value);
      value.process.sendJson({ method, params: { privateMessage: 'do not expose' } });
      await assertCodexError(value.client.dispose(), 'server-warning', 'do not expose');
    });
  }

  await t.test('remote control must remain disabled and unbound', async (t) => {
    const value = harness(t);
    await initializeHealthy(value);
    value.process.sendJson(remoteControlNotification('connected', 'remote-environment'));
    await assertCodexError(value.client.dispose(), 'remote-control-enabled', 'remote-environment');
  });

  for (const method of [
    'account/updated',
    'account/rateLimits/updated',
    'thread/started',
    'item/started',
    'app/list/updated',
  ]) {
    await t.test(method, async (t) => {
      const value = harness(t);
      await initializeHealthy(value);
      value.process.sendJson({ method, params: {} });
      await assertCodexError(value.client.dispose(), 'unexpected-notification');
    });
  }
});

test('stderr, EOF, process errors, and early exit are bounded redacted failures', async (t) => {
  await t.test('default stderr policy fails on any byte', async (t) => {
    const value = harness(t);
    const initializing = value.client.initialize();
    await value.process.nextClientFrame();
    const sensitiveStderr = 'private native stderr details';
    value.process.stderr.write(sensitiveStderr);
    await assertCodexError(initializing, 'stderr-output', sensitiveStderr);
    await assertCodexError(value.client.dispose(), 'stderr-output');
  });

  await t.test('discard mode remains cumulatively bounded', async (t) => {
    const value = harness(t, {
      stderrPolicy: { mode: 'discard', maxBytes: 4 },
    });
    await initializeHealthy(value);
    value.process.stderr.write('1234');
    await waitImmediate();
    value.process.stderr.write('5');
    await assertCodexError(value.client.dispose(), 'stderr-overflow');
  });

  await t.test('unexpected process exit', async (t) => {
    const value = harness(t);
    const initializing = value.client.initialize();
    await value.process.nextClientFrame();
    value.process.emitExit(17, null);
    await assertCodexError(initializing, 'process-exit');
    await assertCodexError(value.client.dispose(), 'dispose-timeout');
  });

  await t.test('clean stdout EOF is unavailable', async (t) => {
    const value = harness(t);
    const initializing = value.client.initialize();
    await value.process.nextClientFrame();
    value.process.stdout.end();
    await assertCodexError(initializing, 'stdout-eof');
    await assertCodexError(value.client.dispose(), 'stdout-eof');
  });

  await t.test('partial stdout EOF is a truncated frame', async (t) => {
    const value = harness(t);
    const initializing = value.client.initialize();
    await value.process.nextClientFrame();
    value.process.stdout.write('{"id":');
    value.process.stdout.end();
    await assertCodexError(initializing, 'truncated-frame');
    await assertCodexError(value.client.dispose(), 'truncated-frame');
  });

  await t.test('native process errors are redacted', async (t) => {
    const value = harness(t);
    const initializing = value.client.initialize();
    await value.process.nextClientFrame();
    const sensitiveError = 'spawn error at private path';
    value.process.emit('error', new Error(sensitiveError));
    await assertCodexError(initializing, 'process-error', sensitiveError);
    await assertCodexError(value.client.dispose(), 'process-error');
  });
});

test('async spawn failure is redacted, handled, and bounded without an exit event', async (t) => {
  const temporaryHome = mkdtempSync(join(tmpdir(), 'pc-sdk-codex-async-spawn-'));
  const home = realpathSync.native(temporaryHome);
  t.after(() => rmSync(temporaryHome, { recursive: true, force: true }));
  const process = new FakeAsyncSpawnFailure();
  const client = startCodexAppServer({
    codexHome: home,
    cwd: home,
    requestTimeoutMs: 100,
    disposalTimeoutMs: 20,
    spawnProcess() {
      return process;
    },
  });
  const initializing = client.initialize();
  const sensitiveError = 'spawn failed at private path';
  assert.doesNotThrow(() => process.fail(new Error(sensitiveError)));
  await assertCodexError(initializing, 'process-spawn-failed', sensitiveError);
  await assertCodexError(client.dispose(), 'process-spawn-failed', sensitiveError);
  assert.deepEqual(process.killSignals, []);
});

test('async spawn failure cannot mask an invalid failed-spawn close receipt', async (t) => {
  const temporaryHome = mkdtempSync(join(tmpdir(), 'pc-sdk-codex-async-spawn-invalid-'));
  const home = realpathSync.native(temporaryHome);
  t.after(() => rmSync(temporaryHome, { recursive: true, force: true }));
  const process = new FakeAsyncSpawnFailure();
  const client = startCodexAppServer({
    codexHome: home,
    cwd: home,
    requestTimeoutMs: 100,
    disposalTimeoutMs: 20,
    spawnProcess() {
      return process;
    },
  });
  const initializing = client.initialize();
  process.fail(new Error('private async spawn failure'), 0, null);
  await assertCodexError(initializing, 'process-spawn-failed');
  await assertCodexError(client.dispose(), 'process-lifecycle-invalid');
});

test('direct disposal requires exit, close, drained streams, and decoder finish', async (t) => {
  await t.test('direct termination starts before stdin EOF and exit alone cannot settle', async (t) => {
    const value = harness(t, { disposalTimeoutMs: 50 });
    value.process.autoCloseOnKill = false;
    let settled = false;
    const disposal = value.client.dispose().finally(() => {
      settled = true;
    });
    await waitImmediate();
    assert.deepEqual(value.process.killSignals, ['SIGTERM']);
    assert.deepEqual(value.process.stdinEndedAtKill, [false]);
    assert.equal(settled, false);
    value.process.emitClose(null, 'SIGTERM');
    assert.deepEqual(await disposal, {
      status: 'exited',
      code: null,
      signal: 'SIGTERM',
    });
  });

  await t.test('missing close times out after a positive exit receipt', async (t) => {
    const value = harness(t, { disposalTimeoutMs: 5 });
    value.process.autoCloseOnKill = false;
    await assertCodexError(value.client.dispose(), 'dispose-timeout');
    assert.deepEqual(value.process.killSignals, ['SIGTERM']);
  });

  await t.test('missing lifecycle proof outranks an earlier trailing-output fatal', async (t) => {
    const value = harness(t, { disposalTimeoutMs: 5 });
    value.process.autoCloseOnKill = false;
    value.process.stderr.write('private trailing stderr');
    await assertCodexError(value.client.dispose(), 'dispose-timeout', 'private');
    assert.deepEqual(value.process.killSignals, ['SIGTERM']);
  });

  for (const scenario of ['stderr', 'warning', 'truncated'] as const) {
    await t.test(`post-exit ${scenario} fails before close receipt`, async (t) => {
      const value = harness(t, { disposalTimeoutMs: 50 });
      value.process.autoCloseOnKill = false;
      const disposal = value.client.dispose();
      await waitImmediate();
      if (scenario === 'stderr') {
        value.process.stderr.write('private trailing stderr');
      } else if (scenario === 'warning') {
        value.process.sendJson({ method: 'warning', params: { private: 'secret' } });
      } else {
        value.process.stdout.write('{"method":"warning"');
      }
      value.process.emitClose(null, 'SIGTERM');
      await assertCodexError(
        disposal,
        scenario === 'stderr'
          ? 'stderr-output'
          : scenario === 'warning'
          ? 'server-warning'
          : 'truncated-frame',
        'private',
      );
    });
  }

  await t.test('conflicting exit and close receipts fail closed', async (t) => {
    const value = harness(t, { disposalTimeoutMs: 50 });
    value.process.autoCloseOnKill = false;
    const disposal = value.client.dispose();
    await waitImmediate();
    value.process.emitClose(0, null);
    await assertCodexError(disposal, 'process-lifecycle-invalid');
  });

  await t.test('an already-completed matching drained lifecycle needs no signal', async (t) => {
    const value = harness(t, { disposalTimeoutMs: 50 });
    value.process.autoExitOnKill = false;
    const disposal = value.client.dispose();
    value.process.emitExit(0, null);
    value.process.emitClose(0, null);
    assert.deepEqual(await disposal, { status: 'exited', code: 0, signal: null });
    assert.deepEqual(value.process.killSignals, []);
  });
});

test('direct disposal escalates once, is idempotent, and remains deadline-bounded', async (t) => {
  const value = harness(t, { disposalTimeoutMs: 5 });
  value.process.autoExitOnKill = false;

  const first = value.client.dispose();
  const second = value.client.dispose();
  assert.strictEqual(first, second);
  await assertCodexError(first, 'dispose-timeout');
  await assertCodexError(second, 'dispose-timeout');
  assert.deepEqual(value.process.killSignals, ['SIGTERM', 'SIGKILL']);
});

test('lifecycle events reject malformed payloads, duplicates, close-before-exit, and mismatches', async (t) => {
  const invalidExitPayloads: ReadonlyArray<readonly [unknown, unknown]> = [
    [undefined, undefined],
    [null, null],
    [Number.NaN, null],
    [Number.POSITIVE_INFINITY, null],
    [1.5, null],
    [-1, null],
    [0, 'SIGTERM'],
    [null, 'NOT_A_SIGNAL'],
  ];
  for (const [code, signal] of invalidExitPayloads) {
    await t.test(`invalid exit ${String(code)} ${String(signal)}`, async (t) => {
      const value = harness(t, { disposalTimeoutMs: 20 });
      value.process.autoExitOnKill = false;
      const disposal = value.client.dispose();
      value.process.emit('exit', code, signal);
      value.process.emitClose(0, null);
      await assertCodexError(disposal, 'process-lifecycle-invalid');
    });
  }

  await t.test('invalid close payload', async (t) => {
    const value = harness(t, { disposalTimeoutMs: 20 });
    value.process.autoExitOnKill = false;
    const disposal = value.client.dispose();
    value.process.emitExit(0, null);
    value.process.stdout.end();
    value.process.stderr.end();
    value.process.stdin.end();
    value.process.emit('close', '0', null);
    await assertCodexError(disposal, 'process-lifecycle-invalid');
  });

  await t.test('duplicate exit', async (t) => {
    const value = harness(t, { disposalTimeoutMs: 20 });
    value.process.autoExitOnKill = false;
    const disposal = value.client.dispose();
    value.process.emitExit(0, null);
    value.process.emit('exit', 0, null);
    value.process.emitClose(0, null);
    await assertCodexError(disposal, 'process-lifecycle-invalid');
  });

  await t.test('close before exit', async (t) => {
    const value = harness(t, { disposalTimeoutMs: 20 });
    value.process.autoExitOnKill = false;
    const disposal = value.client.dispose();
    value.process.emitClose(0, null);
    await waitImmediate();
    value.process.emitExit(0, null);
    await assertCodexError(disposal, 'process-lifecycle-invalid');
  });

  await t.test('valid numeric exit receipt', async (t) => {
    const value = harness(t, { disposalTimeoutMs: 20 });
    value.process.autoExitOnKill = false;
    const disposal = value.client.dispose();
    value.process.emitExit(0, null);
    value.process.emitClose(0, null);
    assert.deepEqual(await disposal, { status: 'exited', code: 0, signal: null });
  });
});

test('kill false or throw never implies direct-child absence', async (t) => {
  for (const behavior of ['false', 'throw'] as const) {
    await t.test(behavior, async (t) => {
      const value = harness(t, { disposalTimeoutMs: 5 });
      value.process.autoExitOnKill = false;
      value.process.killResult = false;
      value.process.killThrows = behavior === 'throw';
      await assertCodexError(value.client.dispose(), 'dispose-timeout');
      assert.deepEqual(value.process.killSignals, ['SIGTERM', 'SIGKILL']);
    });
  }
});

test('invalid process/config seams fail before use and best-effort terminate an unusable spawn', (t) => {
  const temporaryHome = mkdtempSync(join(tmpdir(), 'pc-sdk-codex-client-invalid-'));
  const home = realpathSync.native(temporaryHome);
  t.after(() => rmSync(temporaryHome, { recursive: true, force: true }));

  let spawned = false;
  assert.throws(
    () => startCodexAppServer({
      codexHome: home,
      cwd: home,
      stderrPolicy: 'invalid' as unknown as StartCodexAppServerOptions['stderrPolicy'],
      spawnProcess() {
        spawned = true;
        return new FakeAppServerProcess();
      },
    }),
    (error: unknown) => error instanceof CodexAppServerError &&
      error.code === 'invalid-client-option',
  );
  assert.equal(spawned, false);

  for (const cwd of [undefined, 'relative-cwd', `${home}${sep}.`, join(home, 'missing')]) {
    spawned = false;
    assert.throws(
      () => startCodexAppServer({
        codexHome: home,
        cwd: cwd as string,
        spawnProcess() {
          spawned = true;
          return new FakeAppServerProcess();
        },
      }),
      (error: unknown) => error instanceof CodexAppServerError &&
        error.code === 'invalid-client-option',
    );
    assert.equal(spawned, false);
  }

  const killSignals: unknown[] = [];
  assert.throws(
    () => startCodexAppServer({
      codexHome: home,
      cwd: home,
      spawnProcess() {
        return {
          kill(signal: unknown) {
            killSignals.push(signal);
            return true;
          },
        } as unknown as CodexAppServerProcess;
      },
    }),
    (error: unknown) => error instanceof CodexAppServerError &&
      error.code === 'process-spawn-failed',
  );
  assert.deepEqual(killSignals, ['SIGKILL']);

  const positivePidKillSignals: unknown[] = [];
  assert.throws(
    () => startCodexAppServer({
      codexHome: home,
      cwd: home,
      spawnProcess() {
        return {
          pid: 777,
          kill(signal: unknown) {
            positivePidKillSignals.push(signal);
            return true;
          },
        } as unknown as CodexAppServerProcess;
      },
    }),
    (error: unknown) => error instanceof CodexAppServerError &&
      error.code === 'process-spawn-failed',
  );
  assert.deepEqual(positivePidKillSignals, ['SIGKILL']);
});

test('pending admission requests are bounded and healthy disposal rejects them without losing exit proof', async (t) => {
  const value = harness(t, { requestTimeoutMs: 2_000 });
  await initializeHealthy(value);

  const pending = Array.from({ length: 128 }, () =>
    value.client.request('model/list', { includeHidden: false })
  );
  const observed = Promise.allSettled(pending);
  for (let index = 0; index < 128; index += 1) {
    await value.process.nextClientFrame();
  }
  await assertCodexError(
    value.client.request('model/list', { includeHidden: false }),
    'too-many-pending-requests',
  );

  assert.deepEqual(await value.client.dispose(), {
    status: 'exited',
    code: null,
    signal: 'SIGTERM',
  });
  const results = await observed;
  assert.equal(results.every((result) =>
    result.status === 'rejected' && result.reason instanceof CodexAppServerError &&
    result.reason.code === 'client-disposed'
  ), true);
});
