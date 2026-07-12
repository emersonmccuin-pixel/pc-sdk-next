// Slice 011 (11B) — typed localhost client.
//
// A thin wrapper over the existing raw-HTTP `ToolContext` helpers. It does NOT
// re-implement `node:http`; it injects the raw helpers and runs the matching
// `@pc/contracts` DTO guard over the response body. Every method returns BOTH
// the parsed DTO (when the exact response envelope + DTO match) AND the raw
// `{ status, body }`. Handlers may preserve a valid body's byte-identical text,
// but MUST fail closed on `parsed.ok === false`; malformed 2xx bodies never
// cross the MCP seam.
//
// The client lives in `packages/mcp` (NOT a shared package): it is
// MCP-process-specific (localhost loopback to PC_SERVER_PORT) and a shared
// package would drag HTTP concerns into a browser-safe boundary.

import {
  isAgentRunDto,
  isPendingAskDto,
  parseErr,
  parseOk,
  type AgentRunDto,
  type ParseResult,
  type PendingAskDto,
} from '@pc/contracts';
import type { ServerResponse, ToolContext } from '../tools/context.ts';

/** The raw-HTTP transport surface the typed client needs from ToolContext.
 *  Injected (not re-implemented) so transport stays in one place. */
export interface TypedClientTransport {
  postServer: (path: string, body: unknown) => Promise<ServerResponse>;
  putServer: (path: string, body: unknown) => Promise<ServerResponse>;
  getServer: (path: string) => Promise<ServerResponse>;
  patchServer: (path: string, body: unknown) => Promise<ServerResponse>;
  deleteServer: (path: string) => Promise<ServerResponse>;
}

/** A typed-client outcome. `status`/`body` retain the raw server response for
 *  diagnostics and byte-identical emission after successful validation only.
 *  `parsed` is the mandatory admission result for handlers. */
export interface TypedResult<T> {
  status: number;
  body: string;
  parsed: ParseResult<T>;
}

function isOkStatus(status: number): boolean {
  return status >= 200 && status < 300;
}

function hasOnlyKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  const allowed = new Set(keys);
  return Object.keys(value).every((key) => allowed.has(key));
}

/** Parse a raw response into a DTO drawn out of the response envelope.
 *  `extract` validates the owned response envelope and pulls its DTO candidate;
 *  `guard` validates that candidate. Never throws — a malformed body or shape
 *  miss surfaces as a typed error while the handler decides safe presentation. */
function toTyped<T>(
  res: ServerResponse,
  extract: (body: Record<string, unknown>) => unknown,
  guard: (value: unknown) => value is T,
  label: string,
): TypedResult<T> {
  if (!isOkStatus(res.status)) {
    return {
      status: res.status,
      body: res.body,
      parsed: parseErr(`${label} failed (${res.status})`, 'INTERNAL', { status: res.status }),
    };
  }
  let json: unknown;
  try {
    json = JSON.parse(res.body);
  } catch {
    return {
      status: res.status,
      body: res.body,
      parsed: parseErr(`${label}: malformed JSON body`, 'INTERNAL'),
    };
  }
  if (json === null || typeof json !== 'object' || Array.isArray(json)) {
    return {
      status: res.status,
      body: res.body,
      parsed: parseErr(`${label}: response body is not an object`, 'INTERNAL'),
    };
  }
  const candidate = extract(json as Record<string, unknown>);
  if (!guard(candidate)) {
    return {
      status: res.status,
      body: res.body,
      parsed: parseErr(`${label}: response envelope or DTO did not match the contract`, 'INTERNAL'),
    };
  }
  return { status: res.status, body: res.body, parsed: parseOk(candidate) };
}

/**
 * Typed localhost client. Construct from a `ToolContext` (or any compatible
 * transport). Each method shapes the request EXACTLY as the legacy handler
 * does (no wire change), issues it through the injected raw helper, and parses
 * the response through an exact envelope + contract DTO guard. The raw
 * `{ status, body }` is preserved for byte-identical output only after that
 * admission succeeds.
 */
export class TypedLocalhostClient {
  private readonly t: TypedClientTransport;

  constructor(transport: TypedClientTransport) {
    this.t = transport;
  }

  static fromContext(ctx: ToolContext): TypedLocalhostClient {
    return new TypedLocalhostClient({
      postServer: ctx.postServer,
      putServer: ctx.putServer,
      getServer: ctx.getServer,
      patchServer: ctx.patchServer,
      deleteServer: ctx.deleteServer,
    });
  }

  // ── agent-run / pending family ───────────────────────────────────────────

  async invokeAgent(path: string, payload: unknown): Promise<TypedResult<AgentRunDto>> {
    const res = await this.t.postServer(path, payload);
    return toTyped(
      res,
      (b) => hasOnlyKeys(b, ['ok', 'mode', 'run']) && b.ok === true && b.mode === 'async'
        ? b.run
        : undefined,
      isAgentRunDto,
      'invokeAgent',
    );
  }

  async continueAgent(path: string, payload: unknown): Promise<TypedResult<AgentRunDto>> {
    const res = await this.t.postServer(path, payload);
    return toTyped(
      res,
      (b) => hasOnlyKeys(b, ['ok', 'mode', 'run']) && b.ok === true && b.mode === 'async'
        ? b.run
        : undefined,
      isAgentRunDto,
      'continueAgent',
    );
  }

  async createPendingAsk(path: string, payload: unknown): Promise<TypedResult<PendingAskDto>> {
    const res = await this.t.postServer(path, payload);
    return toTyped(
      res,
      (b) => hasOnlyKeys(b, ['ok', 'pendingAsk', 'status', 'message']) &&
          b.ok === true && b.status === 'waiting' && typeof b.message === 'string'
        ? b.pendingAsk
        : undefined,
      isPendingAskDto,
      'createPendingAsk',
    );
  }

  async answerPendingAsk(path: string, payload: unknown): Promise<TypedResult<PendingAskDto>> {
    const res = await this.t.postServer(path, payload);
    return toTyped(
      res,
      (b) => hasOnlyKeys(b, ['ok', 'pendingAsk']) && b.ok === true ? b.pendingAsk : undefined,
      isPendingAskDto,
      'answerPendingAsk',
    );
  }
}
