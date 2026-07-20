// Thread- and turn-capable native Codex app-server transport.
//
// The admission client (app-server-client.ts, CX-001) is deliberately one-shot
// and refuses thread/turn methods, treats a server->client request as fatal, and
// rejects turn notifications. Driving a real product turn needs the opposite: a
// long-lived child that carries thread/start, turn/start, streaming turn
// notifications, answerable server->client approval requests, and turn/interrupt.
// This sibling transport provides exactly that, reusing the SAME spawn shape
// (resolvePinnedCodexExecutable + buildCodexEnvironment + the injectable process
// factory) so the live wire matches production admission byte-for-byte.
//
// It is intentionally a THIN wire: it frames JSONL, correlates request ids, and
// routes inbound frames to sinks. All provider-neutral capture, filtering, and
// policy live one layer up in live-peer.ts. Native prose never survives on the
// typed error here.

import { spawn } from 'node:child_process';

import type {
  CodexAppServerProcess,
  CodexAppServerProcessFactory,
  CodexAppServerSpawnOptions,
} from './app-server-client.ts';
import { buildCodexEnvironment } from './environment.ts';
import { resolvePinnedCodexExecutable } from './executable.ts';

export type CodexTurnTransportErrorCode =
  | 'process-spawn-failed'
  | 'transport-disposed'
  | 'transport-failed'
  | 'request-timeout'
  | 'request-encoding-invalid'
  | 'initialize-invalid'
  | 'frame-too-large';

export class CodexTurnTransportError extends Error {
  readonly name = 'CodexTurnTransportError';

  constructor(readonly code: CodexTurnTransportErrorCode) {
    super(`Codex turn transport unavailable: ${code}`);
  }
}

/** A server->client request (an approval ask, or any other server request). The
 * `id` is retained only to correlate the answer; native prose is not read here. */
export interface CodexServerRequestFrame {
  readonly id: string | number;
  readonly method: string;
  readonly params: Record<string, unknown>;
}

export interface CodexNotificationFrame {
  readonly method: string;
  readonly params: Record<string, unknown>;
}

export interface CodexTransportExit {
  readonly code: number | null;
  readonly signal: NodeJS.Signals | null;
}

export interface StartCodexTurnTransportOptions {
  readonly codexHome: string;
  readonly cwd: string;
  readonly requestTimeoutMs?: number;
  readonly maxFrameBytes?: number;
  readonly maxStderrBytes?: number;
  /** Every server-originated notification (unfiltered); the peer filters. */
  readonly onNotification: (notification: CodexNotificationFrame) => void;
  /** Every server->client request; the peer answers approvals and refuses rest. */
  readonly onServerRequest: (request: CodexServerRequestFrame) => void;
  /** Fired once when the child exits or the transport fails fatally. */
  readonly onExit: (exit: CodexTransportExit) => void;
  readonly spawnProcess?: CodexAppServerProcessFactory;
}

const DEFAULT_REQUEST_TIMEOUT_MS = 60_000;
const DEFAULT_MAX_FRAME_BYTES = 16 * 1024 * 1024;
const DEFAULT_MAX_STDERR_BYTES = 4 * 1024 * 1024;

const DEFAULT_PROCESS_FACTORY: CodexAppServerProcessFactory = (command, args, options) =>
  spawn(command, [...args], {
    cwd: options.cwd,
    env: options.env,
    shell: options.shell,
    windowsHide: options.windowsHide,
    detached: options.detached,
    stdio: ['pipe', 'pipe', 'pipe'],
  }) as unknown as CodexAppServerProcess;

interface PendingRequest {
  readonly resolve: (value: unknown) => void;
  readonly reject: (error: CodexTurnTransportError) => void;
  readonly timer: NodeJS.Timeout;
}

export function startCodexTurnTransport(
  options: StartCodexTurnTransportOptions,
): CodexTurnTransport {
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
    cwd: options.cwd,
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
    throw new CodexTurnTransportError('process-spawn-failed');
  }
  return new CodexTurnTransport(child, options);
}

export class CodexTurnTransport {
  private buffer = '';
  private nextId = 1;
  private readonly pending = new Map<number, PendingRequest>();
  private readonly codexHome: string;
  private readonly requestTimeoutMs: number;
  private readonly maxFrameBytes: number;
  private readonly maxStderrBytes: number;
  private stderrBytes = 0;
  private fatal: CodexTurnTransportError | null = null;
  private exited = false;
  private disposed = false;
  private disposalPromise: Promise<void> | null = null;

  constructor(
    private readonly child: CodexAppServerProcess,
    private readonly options: StartCodexTurnTransportOptions,
  ) {
    this.codexHome = options.codexHome;
    this.requestTimeoutMs = options.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;
    this.maxFrameBytes = options.maxFrameBytes ?? DEFAULT_MAX_FRAME_BYTES;
    this.maxStderrBytes = options.maxStderrBytes ?? DEFAULT_MAX_STDERR_BYTES;
    child.on('error', () => this.failFatal('transport-failed'));
    child.on('exit', (code, signal) => this.onExit(code, signal));
    child.stdout.on('data', (chunk: unknown) => this.onStdout(chunk));
    child.stdout.on('error', () => this.failFatal('transport-failed'));
    // The real ~/.codex home emits benign operational stderr (stale model cache
    // warnings, failing user MCP servers). It is bounded, not turn-fatal.
    child.stderr.on('data', (chunk: unknown) => this.onStderr(chunk));
    child.stderr.on('error', () => {});
    child.stdin.on('error', () => {
      if (!this.disposed) this.failFatal('transport-failed');
    });
  }

  /** Initialize the native session and confirm the exact credential home. */
  async initialize(): Promise<void> {
    const result = await this.request('initialize', {
      clientInfo: { name: 'pc-sdk-next', title: 'PC-SDK Next', version: '0.0.0' },
      capabilities: { experimentalApi: false, requestAttestation: false },
    });
    if (!isRecord(result) || result.codexHome !== this.codexHome) {
      throw new CodexTurnTransportError('initialize-invalid');
    }
    this.notify('initialized');
  }

  request(method: string, params: unknown, timeoutMs?: number): Promise<unknown> {
    if (this.fatal) return Promise.reject(this.fatal);
    if (this.disposed) return Promise.reject(new CodexTurnTransportError('transport-disposed'));
    const id = this.nextId++;
    let frame: string;
    try {
      frame = JSON.stringify({ method, id, params });
    } catch {
      return Promise.reject(new CodexTurnTransportError('request-encoding-invalid'));
    }
    const promise = new Promise<unknown>((resolve, reject) => {
      const timer = setTimeout(() => {
        if (!this.pending.has(id)) return;
        this.pending.delete(id);
        reject(new CodexTurnTransportError('request-timeout'));
      }, timeoutMs ?? this.requestTimeoutMs);
      this.pending.set(id, { resolve, reject, timer });
    });
    this.writeLine(frame);
    return promise;
  }

  notify(method: string): void {
    this.writeLine(JSON.stringify({ method }));
  }

  /** Answer a server->client request by its wire id (e.g. an approval verdict). */
  answerServerRequest(id: string | number, result: unknown): void {
    this.writeLine(JSON.stringify({ id, result }));
  }

  /** Refuse an unsupported server->client request without tearing the child down. */
  refuseServerRequest(id: string | number): void {
    this.writeLine(JSON.stringify({
      id,
      error: { code: -32601, message: 'server requests are not supported' },
    }));
  }

  dispose(): Promise<void> {
    if (!this.disposalPromise) {
      this.disposed = true;
      this.rejectAll(new CodexTurnTransportError('transport-disposed'));
      this.disposalPromise = this.reapChild();
    }
    return this.disposalPromise;
  }

  private writeLine(line: string): void {
    if (this.disposed && !line.includes('"error"') && !line.includes('"result"')) return;
    try {
      this.child.stdin.write(`${line}\n`);
    } catch {
      this.failFatal('transport-failed');
    }
  }

  private onStdout(chunk: unknown): void {
    if (this.fatal) return;
    const text = typeof chunk === 'string'
      ? chunk
      : chunk instanceof Uint8Array
      ? Buffer.from(chunk).toString('utf8')
      : '';
    this.buffer += text;
    if (this.buffer.length > this.maxFrameBytes && this.buffer.indexOf('\n') === -1) {
      this.failFatal('frame-too-large');
      return;
    }
    for (let nl = this.buffer.indexOf('\n'); nl !== -1; nl = this.buffer.indexOf('\n')) {
      const line = this.buffer.slice(0, nl);
      this.buffer = this.buffer.slice(nl + 1);
      if (line.trim().length === 0) continue;
      this.onLine(line);
      if (this.fatal) return;
    }
  }

  private onLine(line: string): void {
    let message: unknown;
    try {
      message = JSON.parse(line);
    } catch {
      return; // A non-JSON line on stdout is tolerated, never turn-fatal.
    }
    if (!isRecord(message)) return;
    const hasId = Object.prototype.hasOwnProperty.call(message, 'id');
    const hasMethod = typeof message.method === 'string';
    if (hasId && (message.result !== undefined || message.error !== undefined)) {
      this.settle(message);
      return;
    }
    if (hasId && hasMethod) {
      this.options.onServerRequest({
        id: message.id as string | number,
        method: message.method as string,
        params: isRecord(message.params) ? message.params : {},
      });
      return;
    }
    if (hasMethod) {
      this.options.onNotification({
        method: message.method as string,
        params: isRecord(message.params) ? message.params : {},
      });
    }
  }

  private settle(message: Record<string, unknown>): void {
    const id = message.id;
    if (typeof id !== 'number') return;
    const entry = this.pending.get(id);
    if (!entry) return;
    this.pending.delete(id);
    clearTimeout(entry.timer);
    if (message.error !== undefined) {
      entry.reject(new CodexTurnTransportError('transport-failed'));
    } else {
      entry.resolve(message.result);
    }
  }

  private onStderr(chunk: unknown): void {
    const size = typeof chunk === 'string'
      ? Buffer.byteLength(chunk, 'utf8')
      : chunk instanceof Uint8Array
      ? chunk.byteLength
      : 0;
    this.stderrBytes += size;
    if (this.stderrBytes > this.maxStderrBytes) this.failFatal('transport-failed');
  }

  private onExit(code: unknown, signal: unknown): void {
    if (this.exited) return;
    this.exited = true;
    const exit: CodexTransportExit = {
      code: typeof code === 'number' ? code : null,
      signal: typeof signal === 'string' ? (signal as NodeJS.Signals) : null,
    };
    this.rejectAll(new CodexTurnTransportError('transport-failed'));
    if (!this.disposed) this.options.onExit(exit);
  }

  private failFatal(code: CodexTurnTransportErrorCode): void {
    if (!this.fatal) this.fatal = new CodexTurnTransportError(code);
    this.rejectAll(this.fatal);
    if (!this.disposed && !this.exited) {
      this.options.onExit({ code: null, signal: null });
    }
    void this.reapChild().catch(() => {});
  }

  private rejectAll(error: CodexTurnTransportError): void {
    for (const [id, entry] of this.pending) {
      this.pending.delete(id);
      clearTimeout(entry.timer);
      entry.reject(error);
    }
  }

  private async reapChild(): Promise<void> {
    if (this.exited) return;
    try {
      this.child.kill('SIGKILL');
    } catch {
      // A failed kill is best-effort; the child is otherwise abandoned bounded.
    }
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}
