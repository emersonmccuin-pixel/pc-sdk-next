import { TextDecoder } from 'node:util';

export type CodexRequestId = string | number;

export type CodexAppServerErrorCode =
  | 'invalid-client-option'
  | 'client-not-ready'
  | 'client-disposed'
  | 'initialize-already-started'
  | 'initialize-response-invalid'
  | 'initialize-home-mismatch'
  | 'request-method-not-allowed'
  | 'request-params-not-allowed'
  | 'too-many-pending-requests'
  | 'request-id-exhausted'
  | 'request-encoding-invalid'
  | 'outbound-frame-too-large'
  | 'request-timeout'
  | 'response-error'
  | 'frame-too-large'
  | 'invalid-utf8'
  | 'invalid-json'
  | 'malformed-message'
  | 'unknown-response'
  | 'duplicate-response'
  | 'conflicting-response'
  | 'late-response'
  | 'server-request-refused'
  | 'server-warning'
  | 'remote-control-enabled'
  | 'remote-control-status-unavailable'
  | 'unexpected-notification'
  | 'notification-listener-failed'
  | 'stderr-output'
  | 'stderr-overflow'
  | 'stdout-eof'
  | 'truncated-frame'
  | 'process-spawn-failed'
  | 'process-error'
  | 'process-exit'
  | 'process-lifecycle-invalid'
  | 'stdin-write-failed'
  | 'dispose-timeout';

/**
 * Closed, durable-safe evidence. Native messages, payloads, paths, stderr, and
 * process error prose are deliberately never retained on this error.
 */
export class CodexAppServerError extends Error {
  readonly name = 'CodexAppServerError';

  constructor(readonly code: CodexAppServerErrorCode) {
    super(`Codex app-server unavailable: ${code}`);
  }
}

export interface CodexResultResponse {
  readonly kind: 'response';
  readonly id: CodexRequestId;
  readonly outcome: 'result';
  readonly value: unknown;
}

export interface CodexErrorResponse {
  readonly kind: 'response';
  readonly id: CodexRequestId;
  readonly outcome: 'error';
}

export interface CodexServerRequest {
  readonly kind: 'request';
  readonly id: CodexRequestId;
  readonly method: string;
}

export interface CodexServerNotification {
  readonly kind: 'notification';
  readonly method: string;
  readonly params: unknown;
}

export type CodexServerFrame =
  | CodexResultResponse
  | CodexErrorResponse
  | CodexServerRequest
  | CodexServerNotification;

export type CodexNotificationReceipt = Readonly<{
  method: 'remoteControl/status/changed';
  status: 'disabled';
  environmentId: null;
}>;

const WARNING_METHODS: ReadonlySet<string> = new Set([
  'warning',
  'guardianWarning',
  'configWarning',
  'windows/worldWritableWarning',
  'deprecationNotice',
  'error',
]);

const LINE_FEED = 0x0a;
const EMPTY_BUFFER: Buffer = Buffer.alloc(0);

/** Incremental byte-bounded JSONL decoder with fatal UTF-8 decoding. */
export class CodexJsonLineDecoder {
  private pending: Buffer = EMPTY_BUFFER;

  constructor(private readonly maxFrameBytes: number) {}

  push(chunk: Uint8Array): CodexServerFrame[] {
    const bytes = Buffer.from(chunk);
    const frames: CodexServerFrame[] = [];
    let offset = 0;

    while (offset < bytes.length) {
      const newline = bytes.indexOf(LINE_FEED, offset);
      const end = newline === -1 ? bytes.length : newline;
      const segment = bytes.subarray(offset, end);
      const frameLength = this.pending.length + segment.length;
      if (frameLength > this.maxFrameBytes) fail('frame-too-large');

      if (newline === -1) {
        this.pending = append(this.pending, segment, frameLength);
        break;
      }

      const line = append(this.pending, segment, frameLength);
      this.pending = EMPTY_BUFFER;
      frames.push(parseCodexServerFrame(decodeUtf8(line)));
      offset = newline + 1;
    }

    return frames;
  }

  finish(): void {
    if (this.pending.length !== 0) fail('truncated-frame');
  }
}

export function parseCodexServerFrame(source: string): CodexServerFrame {
  let parsed: unknown;
  try {
    parsed = JSON.parse(source) as unknown;
  } catch {
    fail('invalid-json');
  }
  if (!isRecord(parsed)) fail('malformed-message');

  const hasId = owns(parsed, 'id');
  const hasMethod = owns(parsed, 'method');
  const hasResult = owns(parsed, 'result');
  const hasError = owns(parsed, 'error');

  if (hasResult || hasError) {
    if (
      !hasId || hasMethod || hasResult === hasError ||
      !hasExactKeys(parsed, hasResult ? ['id', 'result'] : ['id', 'error']) ||
      !isRequestId(parsed.id)
    ) fail('malformed-message');

    if (hasError) {
      if (!isProtocolError(parsed.error)) fail('malformed-message');
      return Object.freeze({ kind: 'response', id: parsed.id, outcome: 'error' });
    }
    return Object.freeze({
      kind: 'response',
      id: parsed.id,
      outcome: 'result',
      value: parsed.result,
    });
  }

  if (!hasMethod || typeof parsed.method !== 'string' || !isCanonicalMethod(parsed.method)) {
    fail('malformed-message');
  }
  if (!owns(parsed, 'params')) fail('malformed-message');

  if (hasId) {
    if (!isRequestId(parsed.id) || !hasExactKeys(parsed, ['method', 'id', 'params'])) {
      fail('malformed-message');
    }
    return Object.freeze({
      kind: 'request',
      id: parsed.id,
      method: parsed.method,
    });
  }

  if (!hasExactKeys(parsed, ['method', 'params'])) fail('malformed-message');
  return Object.freeze({
    kind: 'notification',
    method: parsed.method,
    params: parsed.params,
  });
}

export function encodeCodexFrame(value: unknown, maxFrameBytes: number): Buffer {
  let json: string | undefined;
  try {
    json = JSON.stringify(value);
  } catch {
    fail('request-encoding-invalid');
  }
  if (json === undefined) fail('request-encoding-invalid');
  const frame = Buffer.from(json, 'utf8');
  if (frame.length > maxFrameBytes) fail('outbound-frame-too-large');
  return Buffer.concat([frame, Buffer.from([LINE_FEED])], frame.length + 1);
}

/**
 * Admit only the startup notification proven necessary for the no-turn live
 * gate. Remote identity fields are validated then discarded and never cross
 * this boundary.
 */
export function sanitizeAdmissionNotification(
  notification: CodexServerNotification,
): CodexNotificationReceipt {
  if (WARNING_METHODS.has(notification.method)) fail('server-warning');

  if (notification.method === 'remoteControl/status/changed') {
    const params = notification.params;
    if (
      !isRecord(params) ||
      !hasExactKeys(params, ['status', 'serverName', 'installationId', 'environmentId']) ||
      typeof params.serverName !== 'string' ||
      typeof params.installationId !== 'string'
    ) fail('malformed-message');
    if (params.status !== 'disabled' || params.environmentId !== null) {
      fail('remote-control-enabled');
    }
    return Object.freeze({
      method: 'remoteControl/status/changed',
      status: 'disabled',
      environmentId: null,
    });
  }

  fail('unexpected-notification');
}

export function serverRequestRefusal(id: CodexRequestId): Readonly<Record<string, unknown>> {
  return Object.freeze({
    id,
    error: Object.freeze({
      code: -32601,
      message: 'server requests are not supported',
    }),
  });
}

export function isCanonicalMethod(value: string): boolean {
  return value.length > 0 && value.trim() === value && !value.includes('\u0000');
}

function decodeUtf8(bytes: Uint8Array): string {
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    fail('invalid-utf8');
  }
}

function append(left: Buffer, right: Buffer, length: number): Buffer {
  if (left.length === 0) return Buffer.from(right);
  if (right.length === 0) return left;
  return Buffer.concat([left, right], length);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function owns(value: object, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(value, key);
}

function hasExactKeys(value: object, expected: readonly string[]): boolean {
  const keys = Object.keys(value);
  return keys.length === expected.length && expected.every((key) => owns(value, key));
}

function isRequestId(value: unknown): value is CodexRequestId {
  return typeof value === 'string'
    ? value.length > 0 && !value.includes('\u0000')
    : typeof value === 'number' && Number.isSafeInteger(value);
}

function isProtocolError(value: unknown): boolean {
  if (!isRecord(value)) return false;
  if (!hasExactKeys(value, owns(value, 'data') ? ['code', 'message', 'data'] : ['code', 'message'])) {
    return false;
  }
  return typeof value.code === 'number' && Number.isFinite(value.code) &&
    typeof value.message === 'string';
}

function fail(code: CodexAppServerErrorCode): never {
  throw new CodexAppServerError(code);
}
