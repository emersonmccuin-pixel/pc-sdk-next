import { spawn } from 'node:child_process';
import { realpathSync, statSync } from 'node:fs';
import { constants as osConstants } from 'node:os';
import { isAbsolute, normalize, parse } from 'node:path';
import type { Readable, Writable } from 'node:stream';
import { buildCodexEnvironment } from './environment.ts';
import { resolvePinnedCodexExecutable } from './executable.ts';
import {
  CodexAppServerError,
  CodexJsonLineDecoder,
  encodeCodexFrame,
  isCanonicalMethod,
  sanitizeAdmissionNotification,
  serverRequestRefusal,
  type CodexAppServerErrorCode,
  type CodexNotificationReceipt,
  type CodexRequestId,
  type CodexServerFrame,
} from './protocol.ts';

export type { CodexNotificationReceipt } from './protocol.ts';

export const CODEX_ADMISSION_REQUEST_METHODS = Object.freeze([
  'config/read',
  'account/read',
  'model/list',
] as const);

export type CodexAdmissionRequestMethod =
  (typeof CODEX_ADMISSION_REQUEST_METHODS)[number];

export interface CodexStderrPolicy {
  /** Live admission uses `fail-on-any`. `discard` remains byte-bounded. */
  readonly mode?: 'fail-on-any' | 'discard';
  readonly maxBytes?: number;
}

export interface CodexAppServerSpawnOptions {
  readonly cwd: string;
  readonly env: Record<string, string>;
  readonly shell: false;
  readonly windowsHide: true;
  readonly detached: boolean;
  readonly stdio: readonly ['pipe', 'pipe', 'pipe'];
}

export interface CodexAppServerProcess {
  readonly stdin: Writable;
  readonly stdout: Readable;
  readonly stderr: Readable;
  readonly pid?: number;
  readonly exitCode: number | null;
  readonly signalCode: NodeJS.Signals | null;
  kill(signal?: NodeJS.Signals | number): boolean;
  on(event: 'spawn', listener: () => void): this;
  on(event: 'error', listener: (error: Error) => void): this;
  on(
    event: 'exit',
    listener: (code: unknown, signal: unknown) => void,
  ): this;
  on(
    event: 'close',
    listener: (code: unknown, signal: unknown) => void,
  ): this;
}

export type CodexAppServerProcessFactory = (
  command: string,
  args: readonly string[],
  options: CodexAppServerSpawnOptions,
) => CodexAppServerProcess;

export interface StartCodexAppServerOptions {
  readonly codexHome: string;
  readonly cwd: string;
  readonly requestTimeoutMs?: number;
  readonly maxFrameBytes?: number;
  readonly stderrPolicy?: CodexStderrPolicy;
  readonly disposalTimeoutMs?: number;
  readonly spawnProcess?: CodexAppServerProcessFactory;
}

export interface CodexRequestOptions {
  readonly timeoutMs?: number;
}

export interface CodexInitializeReceipt {
  readonly status: 'initialized';
  readonly exactCodexHome: true;
  readonly remoteControl: Readonly<{
    status: 'disabled';
    environmentId: null;
  }>;
}

export interface CodexProcessExitReceipt {
  readonly status: 'exited';
  readonly code: number | null;
  readonly signal: NodeJS.Signals | null;
}

type ClientState =
  | 'created'
  | 'initializing'
  | 'ready'
  | 'failed'
  | 'disposing'
  | 'exited';

type ResponseOutcome = 'result' | 'error';

interface PendingRequest {
  readonly resolve: (value: unknown) => void;
  readonly reject: (error: CodexAppServerError) => void;
  readonly timer: NodeJS.Timeout;
}

interface RemoteControlWaiter {
  readonly resolve: (receipt: Extract<
    CodexNotificationReceipt,
    { method: 'remoteControl/status/changed' }
  >) => void;
  readonly reject: (error: CodexAppServerError) => void;
  readonly timer: NodeJS.Timeout;
}

interface NormalizedClientOptions {
  readonly cwd: string;
  readonly requestTimeoutMs: number;
  readonly maxFrameBytes: number;
  readonly stderrMode: 'fail-on-any' | 'discard';
  readonly maxStderrBytes: number;
  readonly disposalTimeoutMs: number;
}

const DEFAULT_REQUEST_TIMEOUT_MS = 15_000;
const DEFAULT_MAX_FRAME_BYTES = 1024 * 1024;
const DEFAULT_MAX_STDERR_BYTES = 64 * 1024;
const DEFAULT_DISPOSAL_TIMEOUT_MS = 2_000;
const MAX_REQUEST_TIMEOUT_MS = 120_000;
const MAX_FRAME_BYTES = 16 * 1024 * 1024;
const MAX_STDERR_BYTES = 16 * 1024 * 1024;
const MAX_DISPOSAL_TIMEOUT_MS = 30_000;
const MAX_RESPONSE_HISTORY = 4_096;
const MAX_PENDING_REQUESTS = 128;
const MAX_MODEL_LIST_LIMIT = 1_000;
const PROCESS_SIGNAL_SET: ReadonlySet<string> = new Set(
  Object.keys(osConstants.signals),
);

const ADMISSION_METHOD_SET: ReadonlySet<string> = new Set(
  CODEX_ADMISSION_REQUEST_METHODS,
);

const DEFAULT_PROCESS_FACTORY: CodexAppServerProcessFactory = (
  command,
  args,
  options,
) => spawn(command, [...args], {
  cwd: options.cwd,
  env: options.env,
  shell: options.shell,
  windowsHide: options.windowsHide,
  detached: options.detached,
  stdio: ['pipe', 'pipe', 'pipe'],
}) as unknown as CodexAppServerProcess;

export function startCodexAppServer(
  options: StartCodexAppServerOptions,
): CodexAppServerClient {
  const normalized = normalizeOptions(options);
  const environment = buildCodexEnvironment(options.codexHome);
  const executable = resolvePinnedCodexExecutable();
  const args = [
    ...executable.argsPrefix,
    'app-server',
    '--stdio',
    '-c',
    'cli_auth_credentials_store="file"',
  ];
  const spawnOptions: CodexAppServerSpawnOptions = {
    cwd: normalized.cwd,
    env: environment,
    shell: false,
    windowsHide: true,
    detached: false,
    stdio: ['pipe', 'pipe', 'pipe'],
  };

  let child: CodexAppServerProcess;
  try {
    child = (options.spawnProcess ?? DEFAULT_PROCESS_FACTORY)(
      executable.command,
      args,
      spawnOptions,
    );
  } catch {
    throw new CodexAppServerError('process-spawn-failed');
  }

  installProcessErrorGuard(child);
  if (!isUsableProcess(child)) {
    bestEffortKillUnknownProcess(child);
    throw new CodexAppServerError('process-spawn-failed');
  }
  try {
    return new CodexAppServerClient(
      child,
      options.codexHome,
      normalized,
    );
  } catch {
    bestEffortKillUnknownProcess(child);
    throw new CodexAppServerError('process-spawn-failed');
  }
}

export class CodexAppServerClient {
  private state: ClientState = 'created';
  private readonly decoder: CodexJsonLineDecoder;
  private readonly pending = new Map<string, PendingRequest>();
  private readonly completed = new Map<string, ResponseOutcome>();
  private readonly timedOut = new Set<string>();
  private readonly cancelled = new Set<string>();
  private readonly notificationListeners = new Set<
    (notification: CodexNotificationReceipt) => void
  >();
  private readonly remoteControlWaiters = new Set<RemoteControlWaiter>();
  private remoteControlReceipt: Extract<
    CodexNotificationReceipt,
    { method: 'remoteControl/status/changed' }
  > | null = null;
  private remoteControlAdmissionOpen = false;
  private nextRequestId = 1;
  private stderrBytes = 0;
  private decoderFinished = false;
  private stdoutEnded = false;
  private stderrEnded = false;
  private spawnSucceeded: boolean;
  private spawnEventObserved = false;
  private spawnFailureObserved = false;
  private exitObserved = false;
  private closeObserved = false;
  private lifecycleInvalid = false;
  private fatalError: CodexAppServerError | null = null;
  private exitReceipt: CodexProcessExitReceipt | null = null;
  private closeReceipt: CodexProcessExitReceipt | null = null;
  private resolveExit!: (receipt: CodexProcessExitReceipt | null) => void;
  private readonly exitPromise: Promise<CodexProcessExitReceipt | null>;
  private resolveClose!: (receipt: CodexProcessExitReceipt | null) => void;
  private readonly closePromise: Promise<CodexProcessExitReceipt | null>;
  private resolveStdoutEnd!: () => void;
  private readonly stdoutEndPromise: Promise<void>;
  private resolveStderrEnd!: () => void;
  private readonly stderrEndPromise: Promise<void>;
  private terminationPromise: Promise<CodexProcessExitReceipt> | null = null;
  private disposalPromise: Promise<CodexProcessExitReceipt> | null = null;

  constructor(
    private readonly child: CodexAppServerProcess,
    private readonly selectedCodexHome: string,
    private readonly options: NormalizedClientOptions,
  ) {
    this.decoder = new CodexJsonLineDecoder(options.maxFrameBytes);
    this.spawnSucceeded = positiveProcessId(child) !== null;
    this.exitPromise = new Promise((resolve) => {
      this.resolveExit = resolve;
    });
    this.closePromise = new Promise((resolve) => {
      this.resolveClose = resolve;
    });
    this.stdoutEndPromise = new Promise((resolve) => {
      this.resolveStdoutEnd = resolve;
    });
    this.stderrEndPromise = new Promise((resolve) => {
      this.resolveStderrEnd = resolve;
    });

    child.on('error', () => this.onProcessError());
    child.on('spawn', () => this.onSpawn());
    child.on('exit', (code, signal) => this.onExit(code, signal));
    child.on('close', (code, signal) => this.onClose(code, signal));
    child.stdout.on('data', (chunk: unknown) => this.onStdout(chunk));
    child.stdout.on('end', () => this.onStdoutEnd());
    child.stdout.on('error', () => {
      this.recordFatal(new CodexAppServerError('process-error'));
    });
    child.stderr.on('data', (chunk: unknown) => this.onStderr(chunk));
    child.stderr.on('end', () => this.onStderrEnd());
    child.stderr.on('error', () => {
      this.recordFatal(new CodexAppServerError('process-error'));
    });
    child.stdin.on('error', () => {
      if (!this.disposalStarted()) {
        this.recordFatal(new CodexAppServerError('stdin-write-failed'));
      }
    });
    if (child.stdout.readableEnded) this.onStdoutEnd();
    if (child.stderr.readableEnded) this.onStderrEnd();
  }

  async initialize(expectedCodexHome = this.selectedCodexHome): Promise<CodexInitializeReceipt> {
    if (this.fatalError) throw this.fatalError;
    if (this.state !== 'created') {
      throw new CodexAppServerError('initialize-already-started');
    }
    this.state = 'initializing';
    // Pinned 0.144.1 can publish its remote-control snapshot while the
    // initialize request is in flight. Open a fresh handshake epoch here so a
    // snapshot processed before initialize() can never satisfy this attempt.
    this.remoteControlReceipt = null;
    this.remoteControlAdmissionOpen = true;

    try {
      if (expectedCodexHome !== this.selectedCodexHome) {
        throw new CodexAppServerError('initialize-home-mismatch');
      }
      const result = await this.sendRequest('initialize', {
        clientInfo: {
          name: 'pc-sdk-next',
          title: 'PC-SDK Next',
          version: '0.0.0',
        },
        capabilities: {
          experimentalApi: false,
          requestAttestation: false,
        },
      }, this.options.requestTimeoutMs);

      if (!isInitializeResponse(result)) {
        throw new CodexAppServerError('initialize-response-invalid');
      }
      if (result.codexHome !== expectedCodexHome) {
        throw new CodexAppServerError('initialize-home-mismatch');
      }
      this.throwIfFailed();
      await this.writeFrame({ method: 'initialized' });
      this.throwIfFailed();
      const remoteControl = await this.waitForRemoteControl(this.options.requestTimeoutMs);
      this.throwIfFailed();
      if (this.state !== 'initializing') {
        throw new CodexAppServerError('client-disposed');
      }
      this.state = 'ready';
      return Object.freeze({
        status: 'initialized',
        exactCodexHome: true,
        remoteControl: Object.freeze({
          status: remoteControl.status,
          environmentId: remoteControl.environmentId,
        }),
      });
    } catch (error) {
      const safeError = asCodexError(error, 'initialize-response-invalid');
      if (
        safeError.code === 'client-disposed' &&
        this.disposalStarted()
      ) {
        throw safeError;
      }
      this.recordFatal(safeError);
      throw safeError;
    }
  }

  request(
    method: CodexAdmissionRequestMethod,
    params: unknown,
    options: CodexRequestOptions = {},
  ): Promise<unknown> {
    if (this.state !== 'ready' || this.fatalError) {
      return Promise.reject(this.fatalError ?? new CodexAppServerError('client-not-ready'));
    }
    if (!isCanonicalMethod(method) || !ADMISSION_METHOD_SET.has(method)) {
      return Promise.reject(new CodexAppServerError('request-method-not-allowed'));
    }
    const normalizedParams = normalizeAdmissionRequestParams(method, params, this.options.cwd);
    if (normalizedParams === null) {
      return Promise.reject(new CodexAppServerError('request-params-not-allowed'));
    }

    let timeoutMs: number;
    try {
      timeoutMs = normalizeRequestTimeout(options, this.options.requestTimeoutMs);
    } catch {
      return Promise.reject(new CodexAppServerError('invalid-client-option'));
    }
    return this.sendRequest(method, normalizedParams, timeoutMs);
  }

  onNotification(listener: (notification: CodexNotificationReceipt) => void): () => void {
    if (typeof listener !== 'function') {
      throw new CodexAppServerError('invalid-client-option');
    }
    this.notificationListeners.add(listener);
    let subscribed = true;
    return () => {
      if (!subscribed) return;
      subscribed = false;
      this.notificationListeners.delete(listener);
    };
  }

  dispose(): Promise<CodexProcessExitReceipt> {
    if (!this.disposalPromise) {
      this.disposalPromise = (async () => {
        if (this.state !== 'exited') {
          this.state = 'disposing';
          this.rejectOutstanding(new CodexAppServerError('client-disposed'), true);
        }
        let receipt: CodexProcessExitReceipt;
        try {
          receipt = await this.stopProcess();
        } catch (error) {
          const cleanupError = asCodexError(error, 'dispose-timeout');
          if (
            cleanupError.code === 'dispose-timeout' ||
            cleanupError.code === 'process-lifecycle-invalid'
          ) {
            throw cleanupError;
          }
          if (this.fatalError) throw this.fatalError;
          throw cleanupError;
        }
        this.state = 'exited';
        if (this.lifecycleInvalid) {
          throw new CodexAppServerError('process-lifecycle-invalid');
        }
        if (this.fatalError) throw this.fatalError;
        return receipt;
      })();
    }
    return this.disposalPromise;
  }

  private sendRequest(method: string, params: unknown, timeoutMs: number): Promise<unknown> {
    if (this.pending.size >= MAX_PENDING_REQUESTS) {
      return Promise.reject(new CodexAppServerError('too-many-pending-requests'));
    }
    if (!Number.isSafeInteger(this.nextRequestId)) {
      const error = new CodexAppServerError('request-id-exhausted');
      this.recordFatal(error);
      return Promise.reject(error);
    }
    const id = this.nextRequestId++;
    let frame: Buffer;
    try {
      frame = encodeCodexFrame({ method, id, params }, this.options.maxFrameBytes);
    } catch (error) {
      return Promise.reject(asCodexError(error, 'request-encoding-invalid'));
    }

    const key = requestKey(id);
    const promise = new Promise<unknown>((resolve, reject) => {
      const timer = setTimeout(() => {
        if (!this.pending.has(key)) return;
        this.timedOut.add(key);
        this.recordFatal(new CodexAppServerError('request-timeout'));
      }, timeoutMs);
      this.pending.set(key, { resolve, reject, timer });
    });

    void this.writeBytes(frame).catch((error: unknown) => {
      if (this.disposalStarted()) return;
      this.recordFatal(asCodexError(error, 'stdin-write-failed'));
    });
    return promise;
  }

  private onStdout(chunk: unknown): void {
    if (this.fatalError || this.state === 'exited') return;
    let bytes: Buffer;
    if (typeof chunk === 'string') bytes = Buffer.from(chunk, 'utf8');
    else if (chunk instanceof Uint8Array) bytes = Buffer.from(chunk);
    else {
      this.recordFatal(new CodexAppServerError('malformed-message'));
      return;
    }

    let frames: CodexServerFrame[];
    try {
      frames = this.decoder.push(bytes);
    } catch (error) {
      this.recordFatal(asCodexError(error, 'malformed-message'));
      return;
    }
    for (const frame of frames) {
      if (this.fatalError) break;
      this.onFrame(frame);
    }
  }

  private onFrame(frame: CodexServerFrame): void {
    if (frame.kind === 'response') {
      this.onResponse(frame);
      return;
    }
    if (frame.kind === 'request') {
      this.refuseServerRequest(frame.id);
      return;
    }

    let receipt: CodexNotificationReceipt;
    try {
      receipt = sanitizeAdmissionNotification(frame);
    } catch (error) {
      this.recordFatal(asCodexError(error, 'unexpected-notification'));
      return;
    }
    if (receipt.method === 'remoteControl/status/changed') {
      if (!this.remoteControlAdmissionOpen) return;
      this.remoteControlReceipt = receipt;
      for (const waiter of this.remoteControlWaiters) {
        this.remoteControlWaiters.delete(waiter);
        clearTimeout(waiter.timer);
        waiter.resolve(receipt);
      }
    }
    for (const listener of [...this.notificationListeners]) {
      try {
        listener(receipt);
      } catch {
        this.recordFatal(new CodexAppServerError('notification-listener-failed'));
        return;
      }
    }
  }

  private onResponse(frame: Extract<CodexServerFrame, { kind: 'response' }>): void {
    const key = requestKey(frame.id);
    const previous = this.completed.get(key);
    if (previous) {
      this.recordFatal(new CodexAppServerError(
        previous === frame.outcome ? 'duplicate-response' : 'conflicting-response',
      ));
      return;
    }
    if (this.timedOut.has(key)) {
      this.recordFatal(new CodexAppServerError('late-response'));
      return;
    }
    if (this.cancelled.delete(key) && this.disposalStarted()) return;

    const pending = this.pending.get(key);
    if (!pending) {
      this.recordFatal(new CodexAppServerError('unknown-response'));
      return;
    }
    this.pending.delete(key);
    clearTimeout(pending.timer);
    rememberOutcome(this.completed, key, frame.outcome);

    if (frame.outcome === 'error') {
      pending.reject(new CodexAppServerError('response-error'));
    } else {
      pending.resolve(frame.value);
    }
  }

  private refuseServerRequest(id: CodexRequestId): void {
    const failure = new CodexAppServerError('server-request-refused');
    this.recordFatal(failure, false);
    let refusal: Buffer;
    try {
      refusal = encodeCodexFrame(serverRequestRefusal(id), this.options.maxFrameBytes);
    } catch {
      void this.stopProcess().catch(() => {});
      return;
    }
    void this.writeBytes(refusal)
      .catch(() => {})
      .finally(() => {
        void this.stopProcess().catch(() => {});
      });
  }

  private onStdoutEnd(): void {
    if (this.stdoutEnded) return;
    this.stdoutEnded = true;
    this.finishDecoder();
    this.resolveStdoutEnd();
    if (this.state === 'disposing' || this.state === 'exited' || this.fatalError) return;
    this.recordFatal(new CodexAppServerError('stdout-eof'));
  }

  private finishDecoder(): void {
    if (this.decoderFinished) return;
    this.decoderFinished = true;
    try {
      this.decoder.finish();
    } catch (error) {
      this.recordFatal(asCodexError(error, 'truncated-frame'));
    }
  }

  private onStderr(chunk: unknown): void {
    if (this.state === 'exited' || this.fatalError) return;
    const size = typeof chunk === 'string'
      ? Buffer.byteLength(chunk, 'utf8')
      : chunk instanceof Uint8Array
      ? chunk.byteLength
      : 1;
    if (size === 0) return;
    this.stderrBytes += size;
    if (this.stderrBytes > this.options.maxStderrBytes) {
      this.recordFatal(new CodexAppServerError('stderr-overflow'));
    } else if (this.options.stderrMode === 'fail-on-any') {
      this.recordFatal(new CodexAppServerError('stderr-output'));
    }
  }

  private onStderrEnd(): void {
    if (this.stderrEnded) return;
    this.stderrEnded = true;
    this.resolveStderrEnd();
  }

  private onSpawn(): void {
    if (this.spawnEventObserved || this.spawnFailureObserved) {
      this.recordLifecycleInvalid();
      return;
    }
    this.spawnEventObserved = true;
    if (positiveProcessId(this.child) === null) {
      this.spawnFailureObserved = true;
      this.recordFatal(new CodexAppServerError('process-spawn-failed'));
      return;
    }
    this.spawnSucceeded = true;
  }

  private onProcessError(): void {
    const failedSpawn = !this.spawnSucceeded && !this.spawnEventObserved;
    if (failedSpawn) this.spawnFailureObserved = true;
    this.recordFatal(new CodexAppServerError(
      failedSpawn ? 'process-spawn-failed' : 'process-error',
    ));
  }

  private onExit(code: unknown, signal: unknown): void {
    if (this.exitObserved) {
      this.recordLifecycleInvalid();
      return;
    }
    this.exitObserved = true;
    const receipt = processExitReceipt(code, signal);
    if (!receipt) {
      this.resolveExit(null);
      this.recordLifecycleInvalid();
      return;
    }
    this.exitReceipt = receipt;
    this.resolveExit(receipt);

    if (this.closeReceipt && !matchingExitReceipts(receipt, this.closeReceipt)) {
      this.recordLifecycleInvalid();
    }

    if (this.state !== 'disposing' && !this.fatalError) {
      this.recordFatal(new CodexAppServerError('process-exit'), false);
    }
  }

  private onClose(code: unknown, signal: unknown): void {
    if (this.closeObserved) {
      this.recordLifecycleInvalid();
      return;
    }
    this.closeObserved = true;
    if (this.spawnFailureObserved && !this.exitObserved) {
      this.resolveClose(null);
      if (!isFailedSpawnClosePayload(code, signal)) {
        this.recordLifecycleInvalid();
      }
      return;
    }
    const receipt = processExitReceipt(code, signal);
    if (!receipt) {
      this.resolveClose(null);
      this.recordLifecycleInvalid();
      return;
    }
    this.closeReceipt = receipt;
    this.resolveClose(receipt);
    if (!this.exitObserved) {
      this.recordLifecycleInvalid();
      return;
    }
    if (this.exitReceipt && !matchingExitReceipts(this.exitReceipt, receipt)) {
      this.recordLifecycleInvalid();
    }
  }

  private recordFatal(error: CodexAppServerError, stop = true): void {
    if (!this.fatalError) this.fatalError = error;
    const failure = this.fatalError;
    if (this.state !== 'disposing' && this.state !== 'exited') this.state = 'failed';
    this.rejectOutstanding(failure);
    if (stop) void this.stopProcess().catch(() => {});
  }

  private recordLifecycleInvalid(): void {
    this.lifecycleInvalid = true;
    this.recordFatal(new CodexAppServerError('process-lifecycle-invalid'));
  }

  private rejectOutstanding(failure: CodexAppServerError, markCancelled = false): void {
    for (const [key, pending] of this.pending) {
      this.pending.delete(key);
      if (markCancelled) this.cancelled.add(key);
      clearTimeout(pending.timer);
      pending.reject(failure);
    }
    for (const waiter of this.remoteControlWaiters) {
      this.remoteControlWaiters.delete(waiter);
      clearTimeout(waiter.timer);
      waiter.reject(failure);
    }
  }

  private waitForRemoteControl(
    timeoutMs: number,
  ): Promise<Extract<CodexNotificationReceipt, { method: 'remoteControl/status/changed' }>> {
    if (this.remoteControlReceipt) return Promise.resolve(this.remoteControlReceipt);
    return new Promise((resolve, reject) => {
      const waiter: RemoteControlWaiter = {
        resolve,
        reject,
        timer: setTimeout(() => {
          this.remoteControlWaiters.delete(waiter);
          reject(new CodexAppServerError('remote-control-status-unavailable'));
        }, timeoutMs),
      };
      this.remoteControlWaiters.add(waiter);
    });
  }

  private throwIfFailed(): void {
    if (this.fatalError) throw this.fatalError;
  }

  private disposalStarted(): boolean {
    return this.state === 'disposing' || this.state === 'exited';
  }

  private writeFrame(value: unknown): Promise<void> {
    let frame: Buffer;
    try {
      frame = encodeCodexFrame(value, this.options.maxFrameBytes);
    } catch (error) {
      return Promise.reject(asCodexError(error, 'request-encoding-invalid'));
    }
    return this.writeBytes(frame);
  }

  private writeBytes(frame: Buffer): Promise<void> {
    return new Promise((resolve, reject) => {
      let settled = false;
      const timer = setTimeout(() => {
        settle(() => reject(new CodexAppServerError('stdin-write-failed')));
      }, this.options.requestTimeoutMs);
      const settle = (complete: () => void): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        complete();
      };
      try {
        this.child.stdin.write(frame, (error?: Error | null) => {
          settle(() => {
            if (error) reject(new CodexAppServerError('stdin-write-failed'));
            else resolve();
          });
        });
      } catch {
        settle(() => reject(new CodexAppServerError('stdin-write-failed')));
      }
    });
  }

  private stopProcess(): Promise<CodexProcessExitReceipt> {
    if (this.terminationPromise) return this.terminationPromise;
    this.terminationPromise = Promise.resolve().then(() => this.terminateProcess());
    return this.terminationPromise;
  }

  private async terminateProcess(): Promise<CodexProcessExitReceipt> {
    if (this.spawnFailureObserved) {
      await waitForFailedSpawnCleanup(
        this.closePromise,
        this.stdoutEndPromise,
        this.stderrEndPromise,
        this.options.disposalTimeoutMs,
      );
      if (this.lifecycleInvalid) {
        throw new CodexAppServerError('process-lifecycle-invalid');
      }
      throw new CodexAppServerError('process-spawn-failed');
    }

    if (this.exitObserved || this.closeObserved) {
      return await this.waitForLifecycle();
    }

    const first = await this.terminationAttempt('SIGTERM');
    if (first !== null) return first;
    if (this.exitObserved || this.closeObserved) {
      throw new CodexAppServerError('dispose-timeout');
    }
    const second = await this.terminationAttempt('SIGKILL');
    if (second !== null) return second;

    throw new CodexAppServerError('dispose-timeout');
  }

  private async terminationAttempt(
    signal: NodeJS.Signals,
  ): Promise<CodexProcessExitReceipt | null> {
    try {
      this.child.kill(signal);
    } catch {
      // A failed kill is never absence proof; lifecycle evidence still decides.
    }
    try {
      return await this.waitForLifecycle();
    } catch (error) {
      if (this.lifecycleInvalid) {
        throw new CodexAppServerError('process-lifecycle-invalid');
      }
      if (
        error instanceof CodexAppServerError &&
        error.code === 'process-lifecycle-invalid'
      ) {
        throw error;
      }
      return null;
    }
  }

  private waitForLifecycle(): Promise<CodexProcessExitReceipt> {
    return waitForProcessLifecycle(
      this.exitPromise,
      this.closePromise,
      this.stdoutEndPromise,
      this.stderrEndPromise,
      this.options.disposalTimeoutMs,
    );
  }
}

function normalizeOptions(options: StartCodexAppServerOptions): NormalizedClientOptions {
  if (options === null || typeof options !== 'object') {
    throw new CodexAppServerError('invalid-client-option');
  }
  const stderrPolicy = options.stderrPolicy ?? {};
  if (
    stderrPolicy === null || typeof stderrPolicy !== 'object' ||
    Array.isArray(stderrPolicy)
  ) throw new CodexAppServerError('invalid-client-option');
  const stderrMode = stderrPolicy.mode ?? 'fail-on-any';
  if (stderrMode !== 'fail-on-any' && stderrMode !== 'discard') {
    throw new CodexAppServerError('invalid-client-option');
  }
  try {
    return Object.freeze({
      cwd: canonicalWorkingDirectory(options.cwd),
      requestTimeoutMs: boundedInteger(
        options.requestTimeoutMs,
        DEFAULT_REQUEST_TIMEOUT_MS,
        1,
        MAX_REQUEST_TIMEOUT_MS,
      ),
      maxFrameBytes: boundedInteger(
        options.maxFrameBytes,
        DEFAULT_MAX_FRAME_BYTES,
        128,
        MAX_FRAME_BYTES,
      ),
      stderrMode,
      maxStderrBytes: boundedInteger(
        stderrPolicy.maxBytes,
        DEFAULT_MAX_STDERR_BYTES,
        1,
        MAX_STDERR_BYTES,
      ),
      disposalTimeoutMs: boundedInteger(
        options.disposalTimeoutMs,
        DEFAULT_DISPOSAL_TIMEOUT_MS,
        1,
        MAX_DISPOSAL_TIMEOUT_MS,
      ),
    });
  } catch {
    throw new CodexAppServerError('invalid-client-option');
  }
}

function canonicalWorkingDirectory(value: string): string {
  if (
    typeof value !== 'string' || value.length === 0 || value.trim() !== value ||
    value.includes('\u0000') || !isExplicitAbsoluteWorkingDirectory(value) ||
    normalize(value) !== value
  ) throw new Error('canonical working directory required');
  const canonical = realpathSync.native(value);
  if (canonical !== value || !statSync(canonical).isDirectory()) {
    throw new Error('canonical working directory required');
  }
  return canonical;
}

function isExplicitAbsoluteWorkingDirectory(value: string): boolean {
  if (!isAbsolute(value)) return false;
  if (process.platform !== 'win32') return true;
  const root = parse(value).root;
  return /^[A-Za-z]:[\\/]$/.test(root) ||
    /^(?:\\\\|\/\/)[^\\/]+[\\/][^\\/]+[\\/]$/.test(root);
}

function boundedInteger(
  value: unknown,
  fallback: number,
  minimum: number,
  maximum: number,
): number {
  const selected = value ?? fallback;
  if (
    typeof selected !== 'number' || !Number.isSafeInteger(selected) ||
    selected < minimum || selected > maximum
  ) {
    throw new Error('bounded integer required');
  }
  return selected;
}

function isUsableProcess(value: unknown): value is CodexAppServerProcess {
  if (value === null || typeof value !== 'object') return false;
  try {
    const candidate = value as Partial<CodexAppServerProcess>;
    return candidate.stdin !== undefined &&
      typeof candidate.stdin.write === 'function' &&
      typeof candidate.stdin.end === 'function' &&
      typeof candidate.stdin.on === 'function' &&
      candidate.stdout !== undefined && typeof candidate.stdout.on === 'function' &&
      candidate.stderr !== undefined && typeof candidate.stderr.on === 'function' &&
      typeof candidate.kill === 'function' && typeof candidate.on === 'function';
  } catch {
    return false;
  }
}

function positiveProcessId(value: unknown): number | null {
  if (value === null || typeof value !== 'object') return null;
  const pid = (value as { pid?: unknown }).pid;
  return Number.isSafeInteger(pid) && (pid as number) > 0 ? pid as number : null;
}

function normalizeAdmissionRequestParams(
  method: CodexAdmissionRequestMethod,
  value: unknown,
  cwd: string,
): Readonly<Record<string, unknown>> | null {
  try {
    if (!isPlainRecord(value)) return null;
    const descriptors = Object.getOwnPropertyDescriptors(value);
    const keys = Reflect.ownKeys(descriptors);
    if (keys.some((key) => typeof key !== 'string')) return null;
    const readData = (key: string): unknown | typeof MISSING_DATA_PROPERTY => {
      const descriptor = descriptors[key];
      if (
        descriptor === undefined || descriptor.enumerable !== true ||
        !Object.prototype.hasOwnProperty.call(descriptor, 'value')
      ) return MISSING_DATA_PROPERTY;
      return descriptor.value;
    };
    if (method === 'config/read') {
      if (!hasExactKeys(keys, ['cwd', 'includeLayers'])) return null;
      const configuredCwd = readData('cwd');
      const includeLayers = readData('includeLayers');
      if (configuredCwd !== cwd || includeLayers !== true) return null;
      return Object.freeze({ cwd: configuredCwd, includeLayers });
    }
    if (method === 'account/read') {
      if (!hasExactKeys(keys, ['refreshToken'])) return null;
      const refreshToken = readData('refreshToken');
      if (refreshToken !== false) return null;
      return Object.freeze({ refreshToken });
    }
    if (!hasOnlyKeys(keys, ['cursor', 'includeHidden', 'limit']) ||
      !keys.includes('includeHidden')) {
      return null;
    }
    const includeHidden = readData('includeHidden');
    if (includeHidden !== false) return null;
    const normalized: Record<string, unknown> = { includeHidden };
    if (keys.includes('cursor')) {
      const cursor = readData('cursor');
      if (cursor !== null && (
        typeof cursor !== 'string' || cursor.length === 0 || cursor.length > 4_096 ||
        cursor.trim() !== cursor || cursor.includes('\u0000')
      )) return null;
      normalized.cursor = cursor;
    }
    if (keys.includes('limit')) {
      const limit = readData('limit');
      if (!Number.isSafeInteger(limit) || (limit as number) < 1 ||
        (limit as number) > MAX_MODEL_LIST_LIMIT) return null;
      normalized.limit = limit;
    }
    return Object.freeze(normalized);
  } catch {
    return null;
  }
}

const MISSING_DATA_PROPERTY = Symbol('missing-data-property');

function hasExactKeys(
  actual: readonly PropertyKey[],
  expected: readonly string[],
): boolean {
  return actual.length === expected.length && expected.every((key) => actual.includes(key));
}

function hasOnlyKeys(actual: readonly PropertyKey[], allowed: readonly string[]): boolean {
  return actual.every((key) => typeof key === 'string' && allowed.includes(key));
}

function normalizeRequestTimeout(value: unknown, fallback: number): number {
  if (!isPlainRecord(value) || !hasOnlyOwnKeys(value, ['timeoutMs'])) {
    throw new Error('exact request options required');
  }
  const descriptor = Object.getOwnPropertyDescriptor(value, 'timeoutMs');
  if (descriptor && !Object.prototype.hasOwnProperty.call(descriptor, 'value')) {
    throw new Error('request options accessors are not allowed');
  }
  const timeout = descriptor?.value;
  return boundedInteger(timeout, fallback, 1, MAX_REQUEST_TIMEOUT_MS);
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function hasExactOwnKeys(
  value: Record<string, unknown>,
  expected: readonly string[],
): boolean {
  const keys = Reflect.ownKeys(value);
  return keys.length === expected.length &&
    expected.every((key) => Object.prototype.hasOwnProperty.call(value, key));
}

function hasOnlyOwnKeys(
  value: Record<string, unknown>,
  allowed: readonly string[],
): boolean {
  const keys = Reflect.ownKeys(value);
  return keys.every((key) => typeof key === 'string' && allowed.includes(key));
}

function isInitializeResponse(value: unknown): value is {
  userAgent: string;
  codexHome: string;
  platformFamily: string;
  platformOs: string;
} {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  const expected = ['userAgent', 'codexHome', 'platformFamily', 'platformOs'];
  const keys = Object.keys(record);
  return keys.length === expected.length && expected.every((key) =>
    Object.prototype.hasOwnProperty.call(record, key)
  ) && isNonEmptyString(record.userAgent) && isNonEmptyString(record.codexHome) &&
    isNonEmptyString(record.platformFamily) && isNonEmptyString(record.platformOs);
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && value.trim() === value &&
    !value.includes('\u0000');
}

function requestKey(id: CodexRequestId): string {
  return `${typeof id}:${String(id)}`;
}

function rememberOutcome(
  history: Map<string, ResponseOutcome>,
  key: string,
  outcome: ResponseOutcome,
): void {
  history.set(key, outcome);
  if (history.size <= MAX_RESPONSE_HISTORY) return;
  const oldest = history.keys().next().value as string | undefined;
  if (oldest !== undefined) history.delete(oldest);
}

function asCodexError(
  error: unknown,
  fallback: CodexAppServerErrorCode,
): CodexAppServerError {
  return error instanceof CodexAppServerError ? error : new CodexAppServerError(fallback);
}

function bestEffortKillUnknownProcess(value: unknown): void {
  if (value === null || typeof value !== 'object') return;
  const kill = (value as { kill?: unknown }).kill;
  if (typeof kill !== 'function') return;
  try {
    kill.call(value, 'SIGKILL');
  } catch {
    // The unusable process cannot provide a stronger receipt.
  }
}

function installProcessErrorGuard(value: unknown): void {
  if (value === null || typeof value !== 'object') return;
  try {
    const on = (value as { on?: unknown }).on;
    if (typeof on === 'function') on.call(value, 'error', () => {});
  } catch {
    // An invalid injected process is rejected and killed best-effort below.
  }
}

function waitForProcessLifecycle(
  exit: Promise<CodexProcessExitReceipt | null>,
  close: Promise<CodexProcessExitReceipt | null>,
  stdoutEnd: Promise<void>,
  stderrEnd: Promise<void>,
  timeoutMs: number,
): Promise<CodexProcessExitReceipt> {
  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = (operation: () => void): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      operation();
    };
    const timer = setTimeout(() => {
      finish(() => reject(new CodexAppServerError('dispose-timeout')));
    }, timeoutMs);
    void Promise.all([exit, close, stdoutEnd, stderrEnd]).then(([exitReceipt, closeReceipt]) => {
      finish(() => {
        if (
          exitReceipt === null || closeReceipt === null ||
          !matchingExitReceipts(exitReceipt, closeReceipt)
        ) {
          reject(new CodexAppServerError('process-lifecycle-invalid'));
          return;
        }
        resolve(exitReceipt);
      });
    });
  });
}

function waitForFailedSpawnCleanup(
  close: Promise<CodexProcessExitReceipt | null>,
  stdoutEnd: Promise<void>,
  stderrEnd: Promise<void>,
  timeoutMs: number,
): Promise<void> {
  return boundedCompletion(
    Promise.all([close, stdoutEnd, stderrEnd]).then(() => undefined),
    timeoutMs,
  );
}

function boundedCompletion(operation: Promise<void>, timeoutMs: number): Promise<void> {
  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = (complete: () => void): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      complete();
    };
    const timer = setTimeout(() => {
      finish(() => reject(new CodexAppServerError('dispose-timeout')));
    }, timeoutMs);
    void operation.then(
      () => finish(resolve),
      () => finish(() => reject(new CodexAppServerError('dispose-timeout'))),
    );
  });
}

function processExitReceipt(
  code: unknown,
  signal: unknown,
): CodexProcessExitReceipt | null {
  if (
    Number.isSafeInteger(code) && (code as number) >= 0 && signal === null
  ) {
    return Object.freeze({ status: 'exited', code: code as number, signal: null });
  }
  if (
    code === null && typeof signal === 'string' && PROCESS_SIGNAL_SET.has(signal)
  ) {
    return Object.freeze({
      status: 'exited',
      code: null,
      signal: signal as NodeJS.Signals,
    });
  }
  return null;
}

function isFailedSpawnClosePayload(code: unknown, signal: unknown): boolean {
  return Number.isSafeInteger(code) && (code as number) < 0 && signal === null;
}

function matchingExitReceipts(
  left: CodexProcessExitReceipt,
  right: CodexProcessExitReceipt,
): boolean {
  return left.code === right.code && left.signal === right.signal;
}
