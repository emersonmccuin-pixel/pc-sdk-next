// MCP manager — the registry + health-probe + bridge subsystem, first-class and
// reliability-first (AGENTS.md). Registry rows live in `mcp_servers`; AInativePM
// is seeded from env on boot when configured. Every probe writes a typed
// `mcp-server` resource event (healthy | degraded | down | unknown + reason) —
// no silent failure. Bridging only exposes HEALTHY servers' tools; a down
// server degrades (its tools vanish) and never blocks chat.

import {
  createMcpServerRegistry,
  getDb,
  insertLiveEvent,
  listMcpServersRegistry,
  setMcpServerDiscovery,
} from '@pc/db';
import type { McpServerChangedPayload, McpServerStatus } from '@pc/contracts';
import type { McpServerRegistryRow, McpServerTransport, PodMcpServerConfig, ULID } from '@pc/domain';
import { discover, type RemoteTool } from './client.ts';
import { buildBridge, type BridgeBuild, type BridgeServer } from './bridge.ts';

interface ServerState {
  row: McpServerRegistryRow;
  config: PodMcpServerConfig | null;
  status: McpServerStatus;
  tools: RemoteTool[];
}

export interface McpManagerDeps {
  /** Discovery/probe timeout. */
  probeTimeoutMs?: number;
}

export class McpManager {
  private readonly states = new Map<string, ServerState>();
  private readonly probeTimeoutMs: number;

  constructor(deps: McpManagerDeps = {}) {
    this.probeTimeoutMs = deps.probeTimeoutMs ?? 10_000;
  }

  /** Boot entry: seed AInativePM from env (if configured + not already present),
   *  load the registry, and probe every server. Emits a resource event per
   *  server. Never throws — a bad server degrades, boot proceeds. */
  async initFromBoot(): Promise<void> {
    try {
      this.seedAiNativePmFromEnv();
    } catch (err) {
      console.warn('[pc-sdk][mcp] seed failed:', err instanceof Error ? err.message : err);
    }
    await this.reload();
  }

  /** Re-read the registry and probe all servers. */
  async reload(): Promise<void> {
    const rows = listMcpServersRegistry();
    // Drop states for servers that vanished.
    for (const id of [...this.states.keys()]) {
      if (!rows.some((r) => r.id === id)) this.states.delete(id);
    }
    for (const row of rows) this.ensureState(row);
    await Promise.all(rows.map((row) => this.probe(row.id as ULID)));
  }

  private ensureState(row: McpServerRegistryRow): ServerState {
    const existing = this.states.get(row.id);
    const config = toPlainConfig(row.transport);
    const state: ServerState = existing ?? {
      row,
      config,
      status: {
        id: row.id,
        name: row.name,
        status: 'unknown',
        reason: null,
        lastProbeAt: null,
        toolCount: null,
        lastError: null,
      },
      tools: [],
    };
    state.row = row;
    state.config = config;
    state.status.name = row.name;
    this.states.set(row.id, state);
    return state;
  }

  /** Probe one server, update state, persist discovery, emit a resource event. */
  async probe(id: ULID): Promise<McpServerStatus> {
    const state = this.states.get(id);
    if (!state) throw new Error(`mcp probe: unknown server ${id}`);
    const now = Date.now();

    if (!state.config) {
      state.tools = [];
      state.status = {
        ...state.status,
        status: 'down',
        reason: 'transport not resolvable (missing url/command or unsupported secret ref)',
        lastProbeAt: now,
        toolCount: null,
        lastError: 'unresolved transport',
      };
      this.persistAndEmit(state, 'failed', null);
      return state.status;
    }

    const result = await discover(state.config, this.probeTimeoutMs);
    if (result.ok) {
      state.tools = result.tools;
      state.status = {
        ...state.status,
        status: 'healthy',
        reason: null,
        lastProbeAt: now,
        toolCount: result.tools.length,
        lastError: null,
      };
      this.persistAndEmit(state, 'ok', result.tools.map((t) => t.name));
    } else {
      state.tools = [];
      state.status = {
        ...state.status,
        status: 'down',
        reason: result.timedOut ? 'probe timed out' : result.error,
        lastProbeAt: now,
        toolCount: null,
        lastError: result.error,
      };
      this.persistAndEmit(state, 'failed', null);
    }
    return state.status;
  }

  /** Bridge build for a new orchestrator session: healthy servers' tools only. */
  buildBridge(): BridgeBuild {
    const servers: BridgeServer[] = [];
    for (const state of this.states.values()) {
      if (state.status.status === 'healthy' && state.config && state.tools.length > 0) {
        servers.push({ id: state.row.id, name: state.row.name, config: state.config, tools: state.tools });
      }
    }
    return buildBridge(servers);
  }

  statuses(): McpServerStatus[] {
    return [...this.states.values()].map((s) => s.status);
  }

  private persistAndEmit(state: ServerState, status: 'ok' | 'failed', tools: string[] | null): void {
    // Bump rev + cache tool names on the registry row; use the new rev as the
    // resource-event version (monotonic per entity, dedups stale deltas).
    const updated = setMcpServerDiscovery(state.row.id as ULID, { status, tools });
    if (updated) state.row = updated;
    const payload: McpServerChangedPayload = { server: state.status };
    try {
      insertLiveEvent(getDb(), {
        scope: state.row.scope === 'project' ? 'project' : 'global',
        projectId: state.row.scope === 'project' ? (state.row.projectId as ULID) : null,
        type: 'mcp-server.changed',
        entity: 'mcp-server',
        entityId: state.row.id as ULID,
        version: state.row.rev,
        payload,
      });
    } catch (err) {
      console.warn('[pc-sdk][mcp] emit failed:', err instanceof Error ? err.message : err);
    }
  }

  /** Seed a global AInativePM registry row from env when configured and absent.
   *  `PC_AINATIVE_PM_URL` → HTTP transport (+ `PC_AINATIVE_PM_TOKEN` Bearer);
   *  else `PC_AINATIVE_PM_CMD` (+ `PC_AINATIVE_PM_ARGS` space-split) → stdio. */
  private seedAiNativePmFromEnv(): void {
    const name = 'AInativePM';
    const already = listMcpServersRegistry({ scope: 'global' }).some((r) => r.name === name);
    if (already) return;

    const url = process.env.PC_AINATIVE_PM_URL?.trim();
    const cmd = process.env.PC_AINATIVE_PM_CMD?.trim();
    let transport: McpServerTransport | null = null;
    if (url) {
      const token = process.env.PC_AINATIVE_PM_TOKEN?.trim();
      transport = { type: 'http', url, ...(token ? { headers: { Authorization: `Bearer ${token}` } } : {}) };
    } else if (cmd) {
      const args = process.env.PC_AINATIVE_PM_ARGS?.trim();
      transport = { command: cmd, ...(args ? { args: args.split(/\s+/) } : {}) };
    }
    if (!transport) return; // nothing configured — degrade silently, no seed.

    createMcpServerRegistry({
      scope: 'global',
      name,
      description: 'AInativePM — project management over MCP (seeded from env).',
      transport,
    });
    console.log('[pc-sdk][mcp] seeded AInativePM from env');
  }
}

/** Stored transport → plain client config. Phase 2 seeds plain strings; a
 *  `SecretRef` value (vault-backed, unresolved here) makes the transport
 *  unusable → null (probe reports it `down`, never a silent skip). */
function toPlainConfig(transport: McpServerTransport): PodMcpServerConfig | null {
  const env = plainStringMap(transport.env);
  const headers = plainStringMap(transport.headers);
  if (env === null || headers === null) return null;
  const config: PodMcpServerConfig = {};
  if (transport.command) config.command = transport.command;
  if (transport.args) config.args = transport.args;
  if (env) config.env = env;
  if (transport.cwd) config.cwd = transport.cwd;
  if (transport.type) config.type = transport.type;
  if (transport.url) config.url = transport.url;
  if (headers) config.headers = headers;
  if (!config.command && !config.url) return null;
  return config;
}

/** Returns a plain string map, `undefined` if the input was undefined, or
 *  `null` if any value is a non-string (secret ref) we cannot resolve. */
function plainStringMap(
  map: Record<string, unknown> | undefined,
): Record<string, string> | undefined | null {
  if (!map) return undefined;
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(map)) {
    if (typeof v !== 'string') return null;
    out[k] = v;
  }
  return out;
}
