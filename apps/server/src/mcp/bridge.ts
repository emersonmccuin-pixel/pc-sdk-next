// MCP bridge — turns discovered REMOTE MCP tools into tool DEFINITIONS the
// orchestrator's SDK loop can expose. The definitions are plain data + a
// handler; `claude-adapter.ts` (the sole SDK importer) wraps them with the SDK's
// `tool()` / `createSdkMcpServer()`. Keeping the wrapping out of here preserves
// the one-SDK-import invariant.
//
// Degrade-never-block: only HEALTHY servers are bridged. Each tool call goes
// through the stateless client (typed failure, hard timeout); a remote error
// becomes an `isError` tool result the model sees — the chat turn is never
// stalled or crashed.

import { z, type ZodRawShape, type ZodTypeAny } from 'zod';
import type { PodMcpServerConfig } from '@pc/domain';
import { callTool, type RemoteTool } from './client.ts';

/** The SDK `tool()` handler return shape (CallToolResult, minimal). */
export interface ToolCallResult {
  content: Array<{ type: 'text'; text: string }>;
  isError?: boolean;
}

export interface BridgeToolDef {
  /** Unique name within the bridge server (`<serverSlug>__<remoteTool>`). */
  name: string;
  description: string;
  inputSchema: ZodRawShape;
  handler: (args: Record<string, unknown>) => Promise<ToolCallResult>;
}

export interface BridgeServer {
  id: string;
  name: string;
  config: PodMcpServerConfig;
  tools: RemoteTool[];
  /** pc-sdk-15 — optional per-attachment allowlist of bare remote tool names.
   *  Null/undefined bridges every discovered tool (unchanged default
   *  behavior). Intersection semantics: a filter entry with no matching
   *  discovered tool is silently ignored, never an error. */
  toolFilter?: string[] | null;
}

/** Liveness gate (N6 requirement 5 — stale tools can't be called). Returns
 *  false when a tool has vanished from the server's live cache since the bridge
 *  was built; the handler then returns a typed error instead of dialing (which
 *  would hang or 404). */
export type IsToolLive = (serverId: string, remoteToolName: string) => boolean;

export interface BridgeBuild {
  /** SDK MCP server key — tools surface as `mcp__<serverKey>__<name>`. */
  serverKey: string;
  toolDefs: BridgeToolDef[];
  /** Fully-qualified names for `allowedTools` so the model may call them. */
  allowedToolNames: string[];
}

export const BRIDGE_SERVER_KEY = 'pc';

function slug(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '') || 'mcp';
}

/** Build the bridge from the currently-healthy servers' cached tool lists.
 *  `isToolLive` (optional) is consulted at call time so a tool that vanished on
 *  a later reconnect returns a typed error instead of hanging. */
export function buildBridge(servers: BridgeServer[], isToolLive?: IsToolLive): BridgeBuild {
  const toolDefs: BridgeToolDef[] = [];
  const seen = new Set<string>();
  for (const server of servers) {
    const prefix = slug(server.name || server.id);
    const allowed = server.toolFilter ? new Set(server.toolFilter) : null;
    for (const remote of server.tools) {
      if (allowed && !allowed.has(remote.name)) continue;
      let name = `${prefix}__${remote.name}`;
      // Collision guard (two servers exposing the same tool name).
      if (seen.has(name)) name = `${prefix}_${server.id.slice(-4).toLowerCase()}__${remote.name}`;
      if (seen.has(name)) continue;
      seen.add(name);
      toolDefs.push({
        name,
        description: remote.description || `Proxied MCP tool ${remote.name} on ${server.name}`,
        inputSchema: jsonSchemaToZodShape(remote.inputSchema),
        handler: makeHandler(server.id, server.config, remote.name, isToolLive),
      });
    }
  }
  return {
    serverKey: BRIDGE_SERVER_KEY,
    toolDefs,
    allowedToolNames: toolDefs.map((d) => `mcp__${BRIDGE_SERVER_KEY}__${d.name}`),
  };
}

function makeHandler(
  serverId: string,
  config: PodMcpServerConfig,
  remoteName: string,
  isToolLive?: IsToolLive,
): (args: Record<string, unknown>) => Promise<ToolCallResult> {
  return async (args) => {
    if (isToolLive && !isToolLive(serverId, remoteName)) {
      return {
        content: [
          {
            type: 'text',
            text: `MCP tool error (${remoteName}): tool is no longer available on its server (removed since last connect)`,
          },
        ],
        isError: true,
      };
    }
    const r = await callTool(config, remoteName, args ?? {});
    if (!r.ok) {
      return { content: [{ type: 'text', text: `MCP tool error (${remoteName}): ${r.error}` }], isError: true };
    }
    const text = r.structured !== undefined && r.structured !== null ? JSON.stringify(r.structured) : r.text;
    return { content: [{ type: 'text', text: text || '(no output)' }] };
  };
}

// ── JSON Schema → Zod (best-effort; unknowns fall back to passthrough) ─────────

/** Convert a JSON-Schema object's `properties` into a Zod raw shape. Non-object
 *  or malformed schemas yield a single passthrough `args` field so the tool
 *  still works (the model just loses per-field typing). */
export function jsonSchemaToZodShape(schema: Record<string, unknown>): ZodRawShape {
  const props = isRecord(schema.properties) ? schema.properties : null;
  if (!props) {
    return { args: z.record(z.string(), z.unknown()).optional().describe('Tool arguments (untyped)') };
  }
  const required = new Set(Array.isArray(schema.required) ? (schema.required as string[]) : []);
  const shape: Record<string, ZodTypeAny> = {};
  for (const [key, raw] of Object.entries(props)) {
    if (!isRecord(raw)) continue;
    let t = jsonSchemaToZodType(raw);
    if (!required.has(key)) t = t.optional();
    shape[key] = t;
  }
  return shape;
}

function jsonSchemaToZodType(schema: Record<string, unknown>): ZodTypeAny {
  const describe = (t: ZodTypeAny): ZodTypeAny =>
    typeof schema.description === 'string' ? t.describe(schema.description) : t;

  const enumVals = schema.enum;
  if (Array.isArray(enumVals) && enumVals.length > 0 && enumVals.every((v) => typeof v === 'string')) {
    return describe(z.enum(enumVals as [string, ...string[]]));
  }

  const type = typeof schema.type === 'string' ? schema.type : Array.isArray(schema.type) ? schema.type[0] : undefined;
  switch (type) {
    case 'string':
      return describe(z.string());
    case 'number':
    case 'integer':
      return describe(z.number());
    case 'boolean':
      return describe(z.boolean());
    case 'array': {
      const items = isRecord(schema.items) ? jsonSchemaToZodType(schema.items) : z.unknown();
      return describe(z.array(items));
    }
    case 'object': {
      const nested = isRecord(schema.properties) ? z.object(jsonSchemaToZodShape(schema)) : z.record(z.string(), z.unknown());
      return describe(nested);
    }
    default:
      return describe(z.unknown());
  }
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return v !== null && typeof v === 'object' && !Array.isArray(v);
}
