// Stateless MCP client — connect, act, disconnect. Every remote MCP call opens
// a fresh transport, does one round-trip, and tears down (mirrors the ported
// @pc/mcp probe/call pattern: no phantom processes, hard timeout, TYPED result,
// never rejects). Degrade-never-block: a broken server yields a typed failure,
// never a hang or a throw that could stall a chat turn.

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport, getDefaultEnvironment } from '@modelcontextprotocol/sdk/client/stdio.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import type { PodMcpServerConfig } from '@pc/domain';

export const DISCOVER_TIMEOUT_MS = 10_000;
export const CALL_TIMEOUT_MS = 120_000;

/** One remote tool as advertised by `tools/list`. `inputSchema` is a JSON Schema
 *  object (`{ type:'object', properties, required }`). */
export interface RemoteTool {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

export type DiscoverResult =
  | { ok: true; tools: RemoteTool[] }
  | { ok: false; error: string; timedOut?: boolean };

export type CallResult =
  | { ok: true; text: string; structured: unknown }
  | { ok: false; error: string; timedOut?: boolean };

function buildTransport(
  config: PodMcpServerConfig,
): { ok: true; transport: StdioClientTransport | StreamableHTTPClientTransport } | { ok: false; error: string } {
  if (config.command) {
    return {
      ok: true,
      transport: new StdioClientTransport({
        command: config.command,
        args: config.args,
        env: config.env ? { ...getDefaultEnvironment(), ...config.env } : undefined,
        stderr: 'pipe',
      }),
    };
  }
  if (config.url) {
    return {
      ok: true,
      transport: new StreamableHTTPClientTransport(new URL(config.url), {
        requestInit: config.headers ? { headers: config.headers } : undefined,
      }),
    };
  }
  return { ok: false, error: 'transport has neither command nor url' };
}

async function withClient<T>(
  config: PodMcpServerConfig,
  timeoutMs: number,
  timedOutValue: T,
  body: (client: Client) => Promise<T>,
  onError: (msg: string) => T,
): Promise<T> {
  let close: (() => Promise<void>) | null = null;
  const timeout = new Promise<T>((resolve) => {
    const timer = setTimeout(() => {
      if (close) void close().catch(() => {});
      resolve(timedOutValue);
    }, timeoutMs);
    if (typeof timer.unref === 'function') timer.unref();
  });
  const work = (async (): Promise<T> => {
    const client = new Client({ name: 'pc-sdk-bridge', version: '0.0.0' }, { capabilities: {} });
    try {
      const built = buildTransport(config);
      if (!built.ok) return onError(built.error);
      close = () => client.close();
      await client.connect(built.transport);
      return await body(client);
    } catch (err) {
      return onError(err instanceof Error ? err.message : String(err));
    } finally {
      try {
        await client.close();
      } catch {
        /* best-effort */
      }
    }
  })();
  return Promise.race([work, timeout]);
}

/** List a server's tools (full defs incl. inputSchema). Always resolves. */
export async function discover(
  config: PodMcpServerConfig,
  timeoutMs = DISCOVER_TIMEOUT_MS,
): Promise<DiscoverResult> {
  return withClient<DiscoverResult>(
    config,
    timeoutMs,
    { ok: false, error: `discover timed out after ${timeoutMs}ms`, timedOut: true },
    async (client) => {
      const res = await client.listTools();
      const tools: RemoteTool[] = (res.tools ?? []).map((t) => ({
        name: t.name,
        description: t.description ?? '',
        inputSchema: (t.inputSchema ?? { type: 'object' }) as Record<string, unknown>,
      }));
      return { ok: true, tools };
    },
    (error) => ({ ok: false, error }),
  );
}

/** Call one tool. Always resolves; a tool-level `isError` becomes a typed
 *  failure so the bridge can surface it as a tool error to the model. */
export async function callTool(
  config: PodMcpServerConfig,
  name: string,
  args: Record<string, unknown>,
  timeoutMs = CALL_TIMEOUT_MS,
): Promise<CallResult> {
  return withClient<CallResult>(
    config,
    timeoutMs,
    { ok: false, error: `tool call timed out after ${timeoutMs}ms`, timedOut: true },
    async (client) => {
      const result = await client.callTool({ name, arguments: args }, undefined, { timeout: timeoutMs });
      const text = renderContent(result as Record<string, unknown>);
      if ((result as { isError?: boolean }).isError) {
        return { ok: false, error: text || 'tool returned an error with no message' };
      }
      return { ok: true, text, structured: (result as { structuredContent?: unknown }).structuredContent };
    },
    (error) => ({ ok: false, error }),
  );
}

function renderContent(result: Record<string, unknown>): string {
  const blocks = Array.isArray(result.content) ? result.content : [];
  const texts = blocks
    .map((b) =>
      b !== null && typeof b === 'object' && (b as { type?: unknown }).type === 'text'
        ? String((b as { text?: unknown }).text ?? '')
        : '',
    )
    .filter((t) => t !== '');
  return texts.join('\n');
}
