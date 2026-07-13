import assert from 'node:assert/strict';
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import {
  existsSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test, { type TestContext } from 'node:test';
import { closeDb } from '@pc/db';
import {
  acquireDataDirectoryAdmission,
  DATA_DIRECTORY_ADMISSION_FILE,
  DATA_DIRECTORY_OCCUPIED_EXIT_CODE,
  DataDirectoryAdmissionError,
} from '../src/operations/data-dir-admission.ts';
import { DispatchService } from '../src/dispatch/service.ts';
import { SessionService } from '../src/chat/session-service.ts';
import { FakeRuntime } from '../src/runner/fake-runtime.ts';
import { startServer, type RunningServer } from '../src/server.ts';
import { freshDb, newProject } from './helpers.ts';
import { testSessionSelectionDeps, withRuntimeReceipt } from './runtime-fixtures.ts';

const FIXTURE = fileURLToPath(
  new URL('./fixtures/data-dir-admission-child.ts', import.meta.url),
);
const PRODUCTION_ENTRY = fileURLToPath(new URL('../src/index.ts', import.meta.url));

interface ChildMessage {
  kind: 'acquired' | 'rejected' | 'released' | 'already-released' | 'failed';
  pid: number;
  code?: string;
  dataDir?: string;
  lockPath?: string;
  reasonCode?: string;
}

type AdmissionHandle = Awaited<ReturnType<typeof acquireDataDirectoryAdmission>>;

test('canonical aliases collide, distinct directories coexist, and release is fenced/idempotent', async (t) => {
  const root = tempRoot();
  const admissions: AdmissionHandle[] = [];
  try {
    const firstDir = join(root, 'one');
    const secondDir = join(root, 'two');
    mkdirSync(join(root, 'alias-parent'), { recursive: true });

    const [first, second] = await Promise.all([
      acquireDataDirectoryAdmission(firstDir),
      acquireDataDirectoryAdmission(secondDir),
    ]);
    admissions.push(first, second);
    assert.equal(first.status, 'acquired');
    assert.equal(second.status, 'acquired');
    assert.equal(first.dataDir, realpathSync.native(firstDir));
    assert.equal(existsSync(first.lockPath), true);

    await assert.rejects(
      acquireDataDirectoryAdmission(join(root, 'alias-parent', '..', 'one', '.')),
      (error: unknown) =>
        error instanceof DataDirectoryAdmissionError &&
        error.code === 'data-directory-occupied' &&
        error.reasonCode === 'EADDRINUSE',
    );

    const linkedAlias = join(root, 'linked-one');
    try {
      symlinkSync(firstDir, linkedAlias, process.platform === 'win32' ? 'junction' : 'dir');
      await assert.rejects(
        acquireDataDirectoryAdmission(linkedAlias),
        (error: unknown) =>
          error instanceof DataDirectoryAdmissionError &&
          error.code === 'data-directory-occupied',
      );
    } catch (error) {
      const code = typeof error === 'object' && error !== null && 'code' in error
        ? (error as { code?: unknown }).code
        : null;
      if (code !== 'EPERM' && code !== 'EACCES') throw error;
      t.diagnostic(`filesystem alias check unavailable: ${String(code)}`);
    }

    assert.equal((await first.release()).status, 'released');
    assert.equal((await first.release()).status, 'already-released');
    const successor = await acquireDataDirectoryAdmission(join(root, 'one', '.'));
    admissions.push(successor);
    assert.equal(successor.status, 'acquired');
    assert.equal((await first.release()).status, 'already-released', 'stale handle cannot touch successor');
    assert.equal((await successor.release()).status, 'released');
    assert.equal((await second.release()).status, 'released');
  } finally {
    await cleanupAdmissions(root, admissions);
  }
});

test('invalid paths, denied opens, and corrupt state fail closed without destructive repair', async () => {
  const root = tempRoot();
  const admissions: AdmissionHandle[] = [];
  try {
    await assert.rejects(
      acquireDataDirectoryAdmission(''),
      (error: unknown) =>
        error instanceof DataDirectoryAdmissionError &&
        error.code === 'data-directory-unavailable' &&
        error.reasonCode === 'INVALID_DATA_DIRECTORY',
    );

    const parentFile = join(root, 'not-a-directory');
    writeFileSync(parentFile, 'file', 'utf8');
    await assert.rejects(
      acquireDataDirectoryAdmission(join(parentFile, 'child')),
      (error: unknown) =>
        error instanceof DataDirectoryAdmissionError &&
        error.code === 'data-directory-unavailable',
    );

    const corruptDir = join(root, 'corrupt');
    mkdirSync(corruptDir);
    const corruptPath = join(corruptDir, DATA_DIRECTORY_ADMISSION_FILE);
    writeFileSync(corruptPath, 'not sqlite', 'utf8');
    await assert.rejects(
      acquireDataDirectoryAdmission(corruptDir),
      (error: unknown) =>
        error instanceof DataDirectoryAdmissionError &&
        error.code === 'data-directory-unavailable' &&
        error.reasonCode === 'SQLITE_NOTADB',
    );
    assert.equal(readFileSync(corruptPath, 'utf8'), 'not sqlite');
    assert.equal(existsSync(join(corruptDir, 'pc.sqlite')), false);

    const deniedDir = join(root, 'denied');
    await assert.rejects(
      acquireDataDirectoryAdmission(deniedDir, {
        openDatabase: () => {
          throw Object.assign(new Error('injected permission denial'), { code: 'EACCES' });
        },
      }),
      (error: unknown) =>
        error instanceof DataDirectoryAdmissionError &&
        error.code === 'data-directory-unavailable' &&
        error.reasonCode === 'EACCES',
    );
    assert.equal(existsSync(join(deniedDir, 'pc.sqlite')), false);
    const afterDenied = await acquireDataDirectoryAdmission(deniedDir);
    admissions.push(afterDenied);
    await afterDenied.release();
  } finally {
    await cleanupAdmissions(root, admissions);
  }
});

test('kernel witness survives admission-path replacement and restart waiting needs a positive acquisition', async (t) => {
  const root = tempRoot();
  const admissions: AdmissionHandle[] = [];
  try {
    const dataDir = join(root, 'replacement');
    const holder = await acquireDataDirectoryAdmission(dataDir);
    admissions.push(holder);
    let replaced = false;
    try {
      rmSync(holder.lockPath, { force: true });
      writeFileSync(holder.lockPath, 'replacement path', 'utf8');
      replaced = true;
    } catch (error) {
      const code = typeof error === 'object' && error !== null && 'code' in error
        ? (error as { code?: unknown }).code
        : null;
      if (code !== 'EBUSY' && code !== 'EPERM' && code !== 'EACCES') throw error;
      t.diagnostic(`platform prevented live admission-path replacement: ${String(code)}`);
    }

    await assert.rejects(
      acquireDataDirectoryAdmission(dataDir),
      (error: unknown) =>
        error instanceof DataDirectoryAdmissionError &&
        error.code === 'data-directory-occupied' &&
        error.reasonCode === 'EADDRINUSE',
    );
    await holder.release();
    if (replaced) rmSync(holder.lockPath, { force: true });

    const secondHolder = await acquireDataDirectoryAdmission(dataDir);
    admissions.push(secondHolder);
    let waitSettled = false;
    let observeOccupied!: () => void;
    const occupiedAttempt = new Promise<void>((resolve) => { observeOccupied = resolve; });
    const waiting = acquireDataDirectoryAdmission(dataDir, {
      waitForOccupiedMs: 2_000,
      retryIntervalMs: 5,
      onOccupied: observeOccupied,
    }).then((receipt) => {
      waitSettled = true;
      return receipt;
    });
    await withTestTimeout(occupiedAttempt, 1_000, 'restart waiter contention receipt');
    assert.equal(waitSettled, false, 'restart waiter cannot pass while ownership is live');
    await secondHolder.release();
    const successor = await waiting;
    admissions.push(successor);
    assert.equal(successor.status, 'acquired');
    await successor.release();
  } finally {
    await cleanupAdmissions(root, admissions);
  }
});

test('a real contender exits occupied before its admitted callback or product DB can run', async (t) => {
  const root = tempRoot();
  const children = childCleanup(t, root);
  const dataDir = join(root, 'shared');
  const holderMarker = join(root, 'holder.marker');
  const contenderMarker = join(root, 'contender.marker');

  const holder = children.spawn(dataDir, holderMarker);
  assert.equal((await holder.firstMessage).kind, 'acquired');
  assert.equal(existsSync(holderMarker), true);

  const contender = children.spawn(join(root, 'alias', '..', 'shared'), contenderMarker);
  const rejection = await contender.firstMessage;
  assert.equal(rejection.kind, 'rejected');
  assert.equal(rejection.code, 'data-directory-occupied');
  assert.equal(await contender.exitCode, DATA_DIRECTORY_OCCUPIED_EXIT_CODE);
  assert.equal(existsSync(contenderMarker), false);
  assert.equal(existsSync(join(dataDir, 'pc.sqlite')), false);

  await holder.release();
});

test('the production entrypoint rejects an occupied directory before migration or provider startup', async () => {
  const root = tempRoot();
  const dataDir = join(root, 'production-loser');
  const holder = await acquireDataDirectoryAdmission(dataDir);
  let child: ChildProcessWithoutNullStreams | null = null;
  let exitReceipt: Promise<number | null> | null = null;
  try {
    const spawned = spawn(
      process.execPath,
      ['--import', 'tsx', PRODUCTION_ENTRY],
      {
        cwd: fileURLToPath(new URL('..', import.meta.url)),
        env: {
          ...process.env,
          PC_DATA_DIR: dataDir,
          PC_PORT: '0',
          PC_INSTANCE_ID: 'sf-001-production-loser',
        },
        stdio: 'pipe',
      },
    );
    child = spawned;
    let stderr = '';
    spawned.stderr.setEncoding('utf8');
    spawned.stderr.on('data', (chunk: string) => { stderr += chunk; });
    exitReceipt = new Promise<number | null>((resolve) => {
      spawned.once('exit', resolve);
    });
    const code = await withTestTimeout(exitReceipt, 10_000, 'production contender exit');
    assert.equal(code, DATA_DIRECTORY_OCCUPIED_EXIT_CODE, stderr);
    assert.match(stderr, /\[pc-sdk\]\[data-dir-admission\].*data-directory-occupied/u);
    assert.equal(existsSync(join(dataDir, 'pc.sqlite')), false);
  } finally {
    try {
      if (child && child.exitCode === null && child.signalCode === null) {
        child.kill('SIGKILL');
        if (exitReceipt) {
          await withTestTimeout(exitReceipt, 10_000, 'production contender cleanup');
        }
      }
    } finally {
      try {
        await holder.release();
      } finally {
        removeTempRoot(root);
      }
    }
  }
});

test('distinct child processes coexist and graceful release admits a successor', async (t) => {
  const root = tempRoot();
  const children = childCleanup(t, root);
  const firstDir = join(root, 'first');
  const secondDir = join(root, 'second');

  const first = children.spawn(firstDir);
  const second = children.spawn(secondDir);
  const [firstReady, secondReady] = await Promise.all([
    first.firstMessage,
    second.firstMessage,
  ]);
  assert.equal(firstReady.kind, 'acquired');
  assert.equal(secondReady.kind, 'acquired');

  await first.release();
  const successor = children.spawn(join(firstDir, '.'));
  assert.equal((await successor.firstMessage).kind, 'acquired');
  await Promise.all([successor.release(), second.release()]);
});

test('hard process death releases OS ownership and simultaneous reclaimers admit exactly one', async (t) => {
  const root = tempRoot();
  const children = childCleanup(t, root);
  const dataDir = join(root, 'crash');

  const holder = children.spawn(dataDir);
  assert.equal((await holder.firstMessage).kind, 'acquired');
  await holder.killHard();

  const contenderA = children.spawn(dataDir);
  const contenderB = children.spawn(join(dataDir, '.'));
  const messages = await Promise.all([
    contenderA.firstMessage,
    contenderB.firstMessage,
  ]);
  assert.deepEqual(
    messages.map((message) => message.kind).sort(),
    ['acquired', 'rejected'],
  );

  const winner = messages[0]!.kind === 'acquired' ? contenderA : contenderB;
  const loser = winner === contenderA ? contenderB : contenderA;
  assert.equal((await loser.exitCode), DATA_DIRECTORY_OCCUPIED_EXIT_CODE);
  await winner.release();

  const final = await acquireDataDirectoryAdmission(dataDir);
  assert.equal(final.status, 'acquired');
  await final.release();
});

test('production source keeps admission first and quiesces DB ownership before restart spawn', () => {
  const indexSource = readFileSync(fileURLToPath(new URL('../src/index.ts', import.meta.url)), 'utf8');
  const launcherSource = readFileSync(
    fileURLToPath(new URL('../../../launcher/pc-sdk-launcher.ps1', import.meta.url)),
    'utf8',
  );

  const mainStart = indexSource.indexOf('async function main()');
  const acquire = indexSource.indexOf('acquireDataDirectoryAdmission(', mainStart);
  const migrate = indexSource.indexOf('runMigrations()', mainStart);
  assert.ok(mainStart >= 0 && acquire > mainStart && acquire < migrate);
  const accountRegistry = indexSource.indexOf('new AccountRegistry()', migrate);
  const runtimeRegistry = indexSource.indexOf('new RuntimeRegistry()', migrate);
  const serverStart = indexSource.indexOf('await startServer(', migrate);
  assert.ok(migrate < accountRegistry && accountRegistry < runtimeRegistry && runtimeRegistry < serverStart);

  const terminationDoor = indexSource.indexOf('void stopEngine().then', migrate);
  const restartSpawn = indexSource.indexOf('spawn(process.execPath', terminationDoor);
  const stopEngine = indexSource.indexOf('function stopEngine()', restartSpawn);
  const closeServerAdmission = indexSource.indexOf('activeServer.close()', stopEngine);
  const disposeDispatch = indexSource.indexOf('activeDispatch.disposeAll()', stopEngine);
  const closeDb = indexSource.indexOf('closeDb()', stopEngine);
  assert.ok(terminationDoor > migrate && restartSpawn > terminationDoor);
  assert.ok(
    stopEngine > restartSpawn &&
    closeServerAdmission > stopEngine &&
    disposeDispatch > closeServerAdmission &&
    closeDb > disposeDispatch,
  );
  const stopEngineEnd = indexSource.indexOf('/** Respawn stdio:', stopEngine);
  assert.doesNotMatch(
    indexSource.slice(stopEngine, stopEngineEnd),
    /dataDirectoryAdmission\?*\.release|dataDirectoryAdmission\.release/u,
    'production retains the kernel witness until actual process exit',
  );
  const restartWait = indexSource.indexOf("[RESTART_ADMISSION_WAIT_ENV]: '1'", terminationDoor);
  const restartExit = indexSource.indexOf('process.exit(0)', restartSpawn);
  assert.ok(restartSpawn < restartWait && restartWait < restartExit);
  assert.match(indexSource, /void main\(\)\.catch\(/u);
  const passThru = launcherSource.indexOf('-PassThru');
  const hasExited = launcherSource.indexOf('$ServerProcess.HasExited', passThru);
  const occupiedExit = launcherSource.indexOf('$ServerProcess.ExitCode -eq 73', hasExited);
  const unavailableExit = launcherSource.indexOf('$ServerProcess.ExitCode -eq 74', hasExited);
  const healthSleep = launcherSource.indexOf('Start-Sleep -Seconds 1', hasExited);
  assert.ok(passThru >= 0 && hasExited > passThru);
  assert.ok(hasExited < occupiedExit && occupiedExit < unavailableExit && unavailableExit < healthSleep);
});

test('dispatch disposal waits for every runtime and propagates an uncertain close', async () => {
  const previousDataDir = process.env.PC_DATA_DIR;
  const dbDir = freshDb();
  try {
    let acknowledgeDispose!: () => void;
    const disposeGate = new Promise<void>((resolve) => { acknowledgeDispose = resolve; });
    const dispatch = probeDispatch([
      { dispose: () => disposeGate },
    ]);
    let settled = false;
    const receipt = dispatch.disposeAll().then(() => { settled = true; });
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.equal(settled, false, 'ownership cannot release before runtime disposal settles');
    acknowledgeDispose();
    await receipt;
    assert.equal(settled, true);

    const disposalFailure = new Error('provider close was not acknowledged');
    const uncertain = probeDispatch([
      { dispose: async () => { throw disposalFailure; } },
    ]);
    await assert.rejects(
      uncertain.disposeAll(),
      (error: unknown) =>
        error instanceof AggregateError && error.errors.includes(disposalFailure),
    );

    let secondDisposeAttempted = false;
    const synchronousFailure = new Error('synchronous provider close failure');
    const allAttempted = probeDispatch([
      { dispose: () => { throw synchronousFailure; } },
      { dispose: async () => { secondDisposeAttempted = true; } },
    ]);
    await assert.rejects(
      allAttempted.disposeAll(),
      (error: unknown) =>
        error instanceof AggregateError && error.errors.includes(synchronousFailure),
    );
    assert.equal(secondDisposeAttempted, true);
  } finally {
    closeDb();
    if (previousDataDir === undefined) delete process.env.PC_DATA_DIR;
    else process.env.PC_DATA_DIR = previousDataDir;
    rmSync(dbDir, { recursive: true, force: true });
  }
});

test('active orchestrator disposal failure stays an explicit shutdown failure', async () => {
  const previousDataDir = process.env.PC_DATA_DIR;
  const dbDir = freshDb();
  try {
    const runtimeFailure = new Error('orchestrator runtime close was not acknowledged');
    const service = new SessionService({
      projectId: newProject('strict-dispose').id,
      broadcast: () => {},
      mintSession: async () => { throw new Error('not used'); },
      ...testSessionSelectionDeps(),
    });
    (service as unknown as {
      runtime: { dispose(): Promise<void> } | null;
    }).runtime = {
      dispose: async () => { throw runtimeFailure; },
    };
    await assert.rejects(service.dispose(), (error: unknown) => error === runtimeFailure);
  } finally {
    closeDb();
    if (previousDataDir === undefined) delete process.env.PC_DATA_DIR;
    else process.env.PC_DATA_DIR = previousDataDir;
    rmSync(dbDir, { recursive: true, force: true });
  }
});

test('server shutdown closes HTTP admission before waiting on runtime disposal', async () => {
  const previousDataDir = process.env.PC_DATA_DIR;
  const dbDir = freshDb();
  let server: RunningServer | null = null;
  let acknowledgeDispose = (): void => {};
  try {
    server = await startServer({
      mintSession: withRuntimeReceipt(
        () => new FakeRuntime({ turns: [] as never, stepDelayMs: 1 }),
      ),
      ...testSessionSelectionDeps(),
      port: 0,
      runRecovery: false,
    });
    const disposalGate = new Promise<void>((resolve) => { acknowledgeDispose = resolve; });
    const lateProject = newProject('late-shutdown-request');
    server.registry.disposeAll = () => disposalGate;

    const closing = server.close();
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.throws(
      () => server!.registry.get(lateProject.id),
      /session registry is shutting down/u,
      'an admitted in-flight handler cannot create a service after the disposal snapshot',
    );
    const status = await fetch(`${server.url}/health`, {
      signal: AbortSignal.timeout(2_000),
    }).then(
      (response) => response.status,
      () => 0,
    );
    assert.notEqual(status, 200, 'shutdown must reject work before the disposal snapshot settles');
    acknowledgeDispose();
    await closing;
  } finally {
    acknowledgeDispose();
    await server?.close().catch(() => {});
    closeDb();
    if (previousDataDir === undefined) delete process.env.PC_DATA_DIR;
    else process.env.PC_DATA_DIR = previousDataDir;
    rmSync(dbDir, { recursive: true, force: true });
  }
});

function tempRoot(): string {
  return mkdtempSync(join(tmpdir(), 'pc-sdk-data-admission-'));
}

function removeTempRoot(root: string): void {
  const canonicalTemp = realpathSync.native(tmpdir());
  const canonicalParent = realpathSync.native(dirname(root));
  assert.equal(canonicalParent, canonicalTemp, 'cleanup target must remain in OS temp');
  assert.match(root.split(/[\\/]/u).at(-1) ?? '', /^pc-sdk-data-admission-/u);
  rmSync(root, { recursive: true, force: true });
}

async function cleanupAdmissions(root: string, admissions: AdmissionHandle[]): Promise<void> {
  const settled = await Promise.allSettled(
    admissions.map((admission) => admission.release()),
  );
  const failures: unknown[] = settled
    .filter((result): result is PromiseRejectedResult => result.status === 'rejected')
    .map((result) => result.reason);
  try {
    removeTempRoot(root);
  } catch (error) {
    failures.push(error);
  }
  if (failures.length > 0) {
    throw new AggregateError(failures, 'admission test cleanup failed');
  }
}

function childCleanup(t: TestContext, root: string): {
  spawn(dataDir: string, markerPath?: string, waitForOccupiedMs?: number): ChildHarness;
} {
  const live = new Set<ChildHarness>();
  t.after(async () => {
    const settled = await Promise.allSettled([...live].map((child) => child.killHard()));
    try {
      const failures = settled
        .filter((result): result is PromiseRejectedResult => result.status === 'rejected')
        .map((result) => result.reason);
      if (failures.length > 0) throw new AggregateError(failures, 'child cleanup failed');
    } finally {
      removeTempRoot(root);
    }
  });
  return {
    spawn(dataDir: string, markerPath = '', waitForOccupiedMs = 0): ChildHarness {
      const child = new ChildHarness(dataDir, markerPath, waitForOccupiedMs);
      live.add(child);
      void child.exitCode.then(() => live.delete(child));
      return child;
    },
  };
}

class ChildHarness {
  readonly process: ChildProcessWithoutNullStreams;
  readonly firstMessage: Promise<ChildMessage>;
  readonly exitCode: Promise<number | null>;
  private stderr = '';

  constructor(dataDir: string, markerPath: string, waitForOccupiedMs: number) {
    this.process = spawn(
      process.execPath,
      ['--import', 'tsx', FIXTURE, dataDir, markerPath, String(waitForOccupiedMs)],
      { cwd: fileURLToPath(new URL('..', import.meta.url)), stdio: 'pipe' },
    );
    this.process.stderr.setEncoding('utf8');
    this.process.stderr.on('data', (chunk: string) => { this.stderr += chunk; });
    this.firstMessage = firstJsonLine(this.process, () => this.stderr);
    this.exitCode = new Promise((resolve) => {
      this.process.once('exit', (code) => resolve(code));
    });
  }

  async release(): Promise<void> {
    if (this.process.exitCode !== null || this.process.signalCode !== null) return;
    this.process.stdin.write('release\n');
    const code = await withTestTimeout(this.exitCode, 10_000, 'child graceful release');
    assert.equal(code, 0, this.stderr);
  }

  async killHard(): Promise<void> {
    if (this.process.exitCode !== null || this.process.signalCode !== null) return;
    const signalled = this.process.kill('SIGKILL');
    assert.equal(
      signalled || this.process.exitCode !== null || this.process.signalCode !== null,
      true,
      `failed to signal child ${this.process.pid ?? 'unknown'}`,
    );
    await withTestTimeout(this.exitCode, 10_000, 'child hard exit');
  }
}

function firstJsonLine(
  child: ChildProcessWithoutNullStreams,
  stderr: () => string,
): Promise<ChildMessage> {
  return withTestTimeout(new Promise((resolve, reject) => {
    let buffered = '';
    const onData = (chunk: Buffer): void => {
      buffered += chunk.toString('utf8');
      const newline = buffered.indexOf('\n');
      if (newline < 0) return;
      cleanup();
      try {
        resolve(JSON.parse(buffered.slice(0, newline)) as ChildMessage);
      } catch (error) {
        reject(error);
      }
    };
    const onExit = (code: number | null): void => {
      cleanup();
      reject(new Error(`child exited ${String(code)} before receipt: ${stderr()}`));
    };
    const cleanup = (): void => {
      child.stdout.off('data', onData);
      child.off('exit', onExit);
    };
    child.stdout.on('data', onData);
    child.once('exit', onExit);
  }), 10_000, 'child admission receipt');
}

function withTestTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms);
    promise.then(
      (value) => { clearTimeout(timer); resolve(value); },
      (error) => { clearTimeout(timer); reject(error); },
    );
  });
}

function probeDispatch(
  sessions: Array<{ dispose(): Promise<void> }>,
): DispatchService {
  const dispatch = new DispatchService(
    {} as ConstructorParameters<typeof DispatchService>[0],
  );
  const live = (dispatch as unknown as {
    live: Map<string, {
      wallClock: ReturnType<typeof setTimeout>;
      session: { dispose(): Promise<void> };
    }>;
  }).live;
  sessions.forEach((session, index) => {
    const wallClock = setTimeout(() => {}, 60_000);
    wallClock.unref?.();
    live.set(String(index), { wallClock, session });
  });
  return dispatch;
}
