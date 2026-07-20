// Pure MCP-manager view logic — no '@/' imports so the guard tests run under
// `tsx --test` (mirrors features/contracts/view.ts). The panel component
// consumes these; keeping them pure keeps the reliability rules testable
// without React or a DOM.

import { isMcpServerStatus, type ResourceEvent } from '@pc/contracts';
import type { McpHealthState } from '@pc/domain';
import type { McpServerDto, McpTransportInput } from './types';

// ── Health presentation (N6 requirement 1/2 — explicit state, always visible) ──

export const HEALTH_LABELS: Record<McpHealthState, string> = {
  healthy: 'Healthy',
  degraded: 'Degraded',
  down: 'Down',
  'auth-expired': 'Auth expired',
  unknown: 'Unknown',
};

export function healthLabel(state: McpHealthState): string {
  return HEALTH_LABELS[state];
}

/** Presentation tone bucket — never collapses a bad state into "ok". */
export type HealthTone = 'ok' | 'warn' | 'error' | 'neutral';

export function healthTone(state: McpHealthState): HealthTone {
  switch (state) {
    case 'healthy':
      return 'ok';
    case 'degraded':
      return 'warn';
    case 'down':
    case 'auth-expired':
      return 'error';
    case 'unknown':
      return 'neutral';
  }
}

/** Severity rank for sorting — unreachable/actionable states surface first so
 *  an outage is never buried below healthy rows (visible-never-hidden). */
export function healthSeverityRank(state: McpHealthState): number {
  switch (state) {
    case 'auth-expired':
      return 0;
    case 'down':
      return 1;
    case 'degraded':
      return 2;
    case 'unknown':
      return 3;
    case 'healthy':
      return 4;
  }
}

export function sortServersBySeverity(servers: readonly McpServerDto[]): McpServerDto[] {
  return [...servers].sort((a, b) => {
    const rank = healthSeverityRank(a.health.state) - healthSeverityRank(b.health.state);
    if (rank !== 0) return rank;
    return a.name.localeCompare(b.name);
  });
}

/** The verbatim reason a server isn't healthy — requirement 2 says "last
 *  error verbatim"; a server can be non-healthy with a state reason but no
 *  captured error (e.g. `auth-expired` before any probe), so this prefers the
 *  probe's `lastError` and falls back to the state's `reason`. Null only when
 *  genuinely healthy/unknown with nothing to report. */
export function healthReasonText(server: McpServerDto): string | null {
  const { health } = server;
  if (health.state === 'healthy' || health.state === 'unknown') return health.reason ?? health.lastError ?? null;
  return health.lastError ?? health.reason ?? null;
}

// ── Live overlay (self-healing reconnect stays visible without a refetch) ─────

/** Merge live `mcp-server` health signals onto an HTTP-fetched server list.
 *  A stale event (behind the row's own `rev`) never regresses what's shown —
 *  same dedup shape as `overlayContracts`. Fields outside health (transport,
 *  consumers, secret) are untouched; those only change via explicit CRUD. */
export function overlayMcpHealth(
  servers: readonly McpServerDto[],
  liveEvents: readonly ResourceEvent[],
): McpServerDto[] {
  if (liveEvents.length === 0) return [...servers];
  const byId = new Map<string, ResourceEvent>();
  for (const ev of liveEvents) {
    if (ev.entity !== 'mcp-server') continue;
    if (!isMcpServerStatus(ev.payload.server)) continue;
    const prev = byId.get(ev.entityId);
    if (!prev || (ev.version ?? -1) >= (prev.version ?? -1)) byId.set(ev.entityId, ev);
  }
  return servers.map((server) => {
    const ev = byId.get(server.id);
    if (!ev || ev.entity !== 'mcp-server') return server;
    if (ev.version !== null && ev.version < server.rev) return server; // stale vs. the fetch we already have
    const status = ev.payload.server;
    return {
      ...server,
      rev: ev.version ?? server.rev,
      health: {
        ...server.health,
        state: status.status,
        reason: status.reason,
        lastProbeAt: status.lastProbeAt,
        lastOkProbeAt: status.lastOkProbeAt,
        toolCount: status.toolCount,
        lastError: status.lastError,
      },
    };
  });
}

// ── Transport form validation (client-side mirror of the server's parse) ──────

export interface ParsedTransport {
  ok: true;
  transport: McpTransportInput;
}
export interface TransportError {
  ok: false;
  error: string;
}

/** Validates the add/edit-server transport form before it ever reaches the
 *  network — same rule the server enforces (`parseTransport` in
 *  apps/server/src/http/mcp.ts): exactly one of url (HTTP) / command (stdio). */
export function parseTransportForm(input: {
  url: string;
  command: string;
}): ParsedTransport | TransportError {
  const url = input.url.trim();
  const command = input.command.trim();
  if (!url && !command) return { ok: false, error: 'transport needs a url (http) or command (stdio)' };
  if (url && command) return { ok: false, error: 'transport cannot set both url and command' };
  return { ok: true, transport: url ? { url } : { command } };
}

/** One-line human summary for the server list row. */
export function transportSummary(transport: McpTransportInput | { url?: string; command?: string }): string {
  if (transport.url) return `HTTP → ${transport.url}`;
  if (transport.command) return `stdio → ${transport.command}`;
  return 'unconfigured';
}

// ── Secret presence — never renders a value, only lifecycle state ────────────

export function secretStatusLabel(server: McpServerDto): string {
  const { secret } = server;
  if (!secret.present) return 'No secret set';
  if (secret.expired) return 'Expired';
  if (secret.authState === 'error') return 'Auth error';
  if (secret.authState === 'needs-auth') return 'Needs auth';
  return 'Set';
}
