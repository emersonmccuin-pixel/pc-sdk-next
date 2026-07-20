// MCP manager — the registry + health state machine + bridge subsystem, built
// to the N6 reliability bar (docs/master-plan.md §MCP manager). Registry rows
// live in `mcp_servers`; AInativePM is seeded from env on boot when configured.
//
// Every probe ends in an EXPLICIT state — healthy | degraded(reason) |
// down(reason) | auth-expired — never a guess. State, last-probe timestamps,
// tool count, and the verbatim last error are persisted so the manager UI shows
// honest health. Reconnect uses exponential backoff; a flapping server is
// pinned degraded, never toggled healthy/down. The tool cache invalidates on
// reconnect and a vanished tool returns a typed error via the bridge. Bridging
// is filtered by explicit per-consumer attachment (default orchestrator-only),
// and only healthy servers are exposed — any server down degrades visibly and
// never blocks chat.

import {
  attachMcpConsumer,
  createMcpServerRegistry,
  getDb,
  insertLiveEvent,
  listMcpServerIdsForConsumer,
  listMcpServersRegistry,
  setMcpServerHealth,
} from '@pc/db';
import type { McpServerChangedPayload, McpServerStatus } from '@pc/contracts';
import {
  consumerKey,
  type McpConsumer,
  type McpHealthState,
  type McpServerRegistryRow,
  type McpServerTransport,
  type ULID,
} from '@pc/domain';
import { discover as discoverLive, type DiscoverResult, type RemoteTool } from './client.ts';
import { buildBridge, type BridgeBuild, type BridgeServer } from './bridge.ts';
import {
  markServerAuthConnected,
  markServerAuthExpired,
  resolveTransportSecrets,
  type ResolveResult,
} from './secrets-vault.ts';

/** Failures with a prior success below this stay `degraded`; at/above go `down`. */
const DEGRADE_THRESHOLD = 3;
/** Recent-outcome window used to pin a flapping server to `degraded`. */
const FLAP_WINDOW = 4;
/** Backoff schedule (ms) indexed by consecutiveFailures (clamped). */
const BACKOFF_MS = [5_000, 15_000, 60_000, 300_000];

interface ServerState {
  row: McpServerRegistryRow;
  status: McpServerStatus;
  tools: RemoteTool[];
  toolNames: Set<string>;
  consecutiveFailures: number;
  lastOkProbeAt: number | null;
  /** Rolling ring of the last few probe outcomes (true = ok) for flap detection. */
  recent: boolean[];
  timer: ReturnType<typeof setTimeout> | null;
}

export interface McpManagerDeps {
  /** Discovery/probe timeout. */
  probeTimeoutMs?: number;
  /** Override the live discovery probe (tests inject deterministic outcomes). */
  probeFn?: (transport: McpServerTransport, timeoutMs: number) => Promise<DiscoverResult>;
  /** When true, schedule backoff re-probes automatically. Default false so
   *  tests drive `probe()` deterministically; the composition root enables it. */
  autoReprobe?: boolean;
}

export class McpManager {
  private readonly states = new Map<string, ServerState>();
  private readonly probeTimeoutMs: number;
  private readonly probeFn: (t: McpServerTransport, ms: number) => Promise<DiscoverResult>;
  private readonly autoReprobe: boolean;

  constructor(deps: McpManagerDeps = {}) {
    this.probeTimeoutMs = deps.probeTimeoutMs ?? 10_000;
    this.autoReprobe = deps.autoReprobe ?? false;
    const inject = deps.probeFn;
    this.probeFn = inject
      ? (t, ms) => inject(t, ms)
      : (t, ms) => {
          const r = resolveTransportSecrets(t);
          if (!r.ok) {
            // Surface an expired vault secret as an auth error so the state
            // machine routes it to `auth-expired`, not a generic `down`.
            const error = r.reason === 'auth-expired' ? `authentication expired: ${r.error}` : r.error;
            return Promise.resolve<DiscoverResult>({ ok: false, error });
          }
          return discoverLive(r.config, ms);
        };
  }

  /** Boot entry: seed AInativePM from env (if configured + absent), load the
   *  registry, and probe every enabled server. Never throws — a bad server
   *  degrades, boot proceeds. */
  async initFromBoot(): Promise<void> {
    try {
      this.seedAiNativePmFromEnv();
    } catch (err) {
      console.warn('[pc-sdk][mcp] seed failed:', err instanceof Error ? err.message : err);
    }
    await this.reload();
  }

  /** Re-read the registry and probe all enabled servers. */
  async reload(): Promise<void> {
    this.syncFromRegistry();
    const rows = listMcpServersRegistry();
    await Promise.all(rows.filter((r) => r.enabled).map((r) => this.probe(r.id as ULID)));
  }

  /** Re-read the registry into in-memory state WITHOUT probing — used after an
   *  HTTP create/patch/delete so a follow-up `probe(id)` sees the fresh row. */
  syncFromRegistry(): void {
    const rows = listMcpServersRegistry();
    for (const id of [...this.states.keys()]) {
      if (!rows.some((r) => r.id === id)) this.dropState(id);
    }
    for (const row of rows) this.ensureState(row);
  }

  private dropState(id: string): void {
    const s = this.states.get(id);
    if (s?.timer) clearTimeout(s.timer);
    this.states.delete(id);
  }

  private ensureState(row: McpServerRegistryRow): ServerState {
    const existing = this.states.get(row.id);
    if (existing) {
      existing.row = row;
      existing.status.name = row.name;
      return existing;
    }
    const state: ServerState = {
      row,
      status: {
        id: row.id,
        name: row.name,
        status: row.healthState,
        reason: row.healthReason,
        lastProbeAt: row.lastProbeAt,
        lastOkProbeAt: row.lastOkProbeAt,
        toolCount: row.toolCount,
        lastError: row.lastError,
      },
      tools: [],
      toolNames: new Set(),
      consecutiveFailures: row.consecutiveFailures,
      lastOkProbeAt: row.lastOkProbeAt,
      recent: [],
      timer: null,
    };
    this.states.set(row.id, state);
    return state;
  }

  /** Probe one server, run the state machine, persist, emit a resource event,
   *  and (when enabled) schedule the next backoff re-probe. Always resolves. */
  async probe(id: ULID): Promise<McpServerStatus> {
    const state = this.states.get(id);
    if (!state) throw new Error(`mcp probe: unknown server ${id}`);
    if (!state.row.enabled) return state.status;
    const now = Date.now();

    const result = await this.probeFn(state.row.transport, this.probeTimeoutMs);
    if (result.ok) {
      this.applyOk(state, now, result.tools);
    } else {
      this.applyFailure(state, now, result);
    }
    this.persistAndEmit(state, now);
    this.scheduleReprobe(id, state);
    return state.status;
  }

  private applyOk(state: ServerState, now: number, tools: RemoteTool[]): void {
    state.consecutiveFailures = 0;
    state.lastOkProbeAt = now;
    markServerAuthConnected(state.row.id as ULID);
    // Reconnect always refreshes the tool cache (requirement 5).
    state.tools = tools;
    state.toolNames = new Set(tools.map((t) => t.name));
    this.pushRecent(state, true);
    // If recent outcomes were unstable, pin degraded (flapping) rather than
    // reporting a clean healthy — anti-toggle (requirement 3).
    const flapping = state.recent.slice(0, -1).some((ok) => !ok);
    if (flapping) {
      state.status = {
        ...state.status,
        status: 'degraded',
        reason: 'flapping — recovered after recent failures',
        lastProbeAt: now,
        lastOkProbeAt: now,
        toolCount: tools.length,
        lastError: null,
      };
    } else {
      state.status = {
        ...state.status,
        status: 'healthy',
        reason: null,
        lastProbeAt: now,
        lastOkProbeAt: now,
        toolCount: tools.length,
        lastError: null,
      };
    }
  }

  private applyFailure(state: ServerState, now: number, result: DiscoverResult & { ok: false }): void {
    this.pushRecent(state, false);
    const authFailed = isAuthError(result.error);
    if (authFailed) {
      markServerAuthExpired(state.row.id as ULID, result.error);
      // Auth failures do not feed the down-escalation counter — they are their
      // own actionable state.
      state.tools = [];
      state.toolNames = new Set();
      state.status = {
        ...state.status,
        status: 'auth-expired',
        reason: 'authentication rejected or expired',
        lastProbeAt: now,
        toolCount: null,
        lastError: result.error,
      };
      return;
    }
    state.consecutiveFailures += 1;
    state.tools = [];
    state.toolNames = new Set();
    const nextState: McpHealthState =
      state.lastOkProbeAt !== null && state.consecutiveFailures < DEGRADE_THRESHOLD
        ? 'degraded'
        : 'down';
    state.status = {
      ...state.status,
      status: nextState,
      reason:
        nextState === 'degraded'
          ? `transient failure (${state.consecutiveFailures}/${DEGRADE_THRESHOLD})`
          : result.timedOut
            ? 'probe timed out'
            : 'unreachable',
      lastProbeAt: now,
      toolCount: null,
      lastError: result.error,
    };
  }

  private pushRecent(state: ServerState, ok: boolean): void {
    state.recent.push(ok);
    if (state.recent.length > FLAP_WINDOW) state.recent.shift();
  }

  private scheduleReprobe(id: ULID, state: ServerState): void {
    if (!this.autoReprobe) return;
    if (state.timer) clearTimeout(state.timer);
    if (state.status.status === 'healthy') {
      // Steady servers do not need aggressive re-probing; a slow heartbeat is
      // enough to catch a silent drop.
      state.timer = setTimeout(() => void this.probe(id).catch(() => {}), BACKOFF_MS[BACKOFF_MS.length - 1]);
    } else {
      const idx = Math.min(state.consecutiveFailures, BACKOFF_MS.length - 1);
      state.timer = setTimeout(() => void this.probe(id).catch(() => {}), BACKOFF_MS[idx]);
    }
    if (typeof state.timer.unref === 'function') state.timer.unref();
  }

  /** Bridge build for a consumer (default: orchestrator). Only ENABLED,
   *  HEALTHY servers ATTACHED to that consumer are exposed. */
  buildBridge(consumer: McpConsumer = { kind: 'orchestrator' }): BridgeBuild {
    const attached = new Set(listMcpServerIdsForConsumer(consumerKey(consumer)));
    const servers: BridgeServer[] = [];
    for (const state of this.states.values()) {
      if (!state.row.enabled) continue;
      if (state.status.status !== 'healthy') continue;
      if (!attached.has(state.row.id as ULID)) continue;
      if (state.tools.length === 0) continue;
      const resolved = resolveConfig(state.row.transport);
      if (!resolved.ok) continue;
      servers.push({ id: state.row.id, name: state.row.name, config: resolved.config, tools: state.tools });
    }
    return buildBridge(servers, (serverId, toolName) => this.isToolLive(serverId, toolName));
  }

  /** True when a tool is still in a server's live cache (requirement 5). */
  isToolLive(serverId: string, toolName: string): boolean {
    const state = this.states.get(serverId);
    return !!state && state.status.status === 'healthy' && state.toolNames.has(toolName);
  }

  statuses(): McpServerStatus[] {
    return [...this.states.values()].map((s) => s.status);
  }

  /** Stop all scheduled re-probes (shutdown). */
  stop(): void {
    for (const s of this.states.values()) {
      if (s.timer) clearTimeout(s.timer);
      s.timer = null;
    }
  }

  private persistAndEmit(state: ServerState, now: number): void {
    const s = state.status;
    const updated = setMcpServerHealth(state.row.id as ULID, {
      state: s.status,
      reason: s.reason,
      lastProbeAt: now,
      lastOkProbeAt: s.status === 'healthy' || s.status === 'degraded' ? state.lastOkProbeAt : undefined,
      toolCount: s.toolCount,
      lastError: s.lastError,
      consecutiveFailures: state.consecutiveFailures,
      tools: state.tools.map((t) => t.name),
    });
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

  /** Seed a global AInativePM registry row from env when configured and absent,
   *  and attach it to the orchestrator (default orchestrator-only). Idempotent:
   *  a re-run finds the existing row and skips.
   *  `PC_AINATIVE_PM_URL` → HTTP (+ `PC_AINATIVE_PM_TOKEN` Bearer);
   *  else `PC_AINATIVE_PM_CMD` (+ `PC_AINATIVE_PM_ARGS` space-split) → stdio. */
  private seedAiNativePmFromEnv(): void {
    const name = 'AInativePM';
    const existing = listMcpServersRegistry({ scope: 'global' }).find((r) => r.name === name);
    if (existing) {
      // Keep the default attachment intact across restarts (idempotent).
      attachMcpConsumer({ mcpServerId: existing.id, consumer: 'orchestrator' });
      return;
    }

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

    const row = createMcpServerRegistry({
      scope: 'global',
      name,
      description: 'AInativePM — project management over MCP (seeded from env).',
      transport,
    });
    attachMcpConsumer({ mcpServerId: row.id, consumer: 'orchestrator' });
    console.log('[pc-sdk][mcp] seeded AInativePM from env (attached to orchestrator)');
  }
}

/** Resolve a stored transport to a plain client config for bridging. Shares the
 *  vault resolver so bridged calls use the same secrets as the probe. */
function resolveConfig(transport: McpServerTransport): ResolveResult {
  return resolveTransportSecrets(transport);
}

const AUTH_ERROR_RE = /\b(401|403|unauthorized|forbidden|invalid[_ -]?token|token[_ -]?expired|authentication)\b/i;

function isAuthError(message: string): boolean {
  return AUTH_ERROR_RE.test(message);
}
