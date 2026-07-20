// MCP manager HTTP surface (N6 requirement 5/6/7). List with full health
// detail, CRUD, write-only secret, manual reprobe, and explicit per-consumer
// attachment. Degrade-never-block: every endpoint is a DB/registry operation
// and works with any server down — health is data, not a precondition.

import type { Hono } from 'hono';
import {
  attachMcpConsumer,
  createMcpServerRegistry,
  detachMcpConsumer,
  getMcpServerRegistry,
  listMcpConsumersForServer,
  listMcpServersRegistry,
  patchMcpServerRegistry,
  softDeleteMcpServerRegistry,
} from '@pc/db';
import type { McpConsumerKey, McpServerRegistryRow, McpServerTransport, ULID } from '@pc/domain';
import type { McpManager } from '../mcp/manager.ts';
import { putServerSecret, serverSecretPresence } from '../mcp/secrets-vault.ts';

export interface McpHttpDeps {
  mcp: McpManager;
}

/** Full server DTO for the manager UI: registry row (minus raw secret values)
 *  plus live health, secret presence (no plaintext), and attachments. */
function toDto(row: McpServerRegistryRow) {
  const presence = serverSecretPresence(row.id);
  return {
    id: row.id,
    scope: row.scope,
    projectId: row.projectId,
    name: row.name,
    description: row.description,
    enabled: row.enabled,
    transport: redactTransport(row.transport),
    health: {
      state: row.healthState,
      reason: row.healthReason,
      lastProbeAt: row.lastProbeAt,
      lastOkProbeAt: row.lastOkProbeAt,
      toolCount: row.toolCount,
      lastError: row.lastError,
      consecutiveFailures: row.consecutiveFailures,
    },
    tools: row.discoveredTools ?? [],
    secret: { present: presence.present, authState: presence.authState, expiresAt: presence.expiresAt, expired: presence.expired },
    consumers: listMcpConsumersForServer(row.id),
    rev: row.rev,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

/** Never leak stored secret values. `$secretRef` sentinels stay (they carry no
 *  secret); any plain-string header/env value is masked. */
function redactTransport(transport: McpServerTransport): McpServerTransport {
  const mask = (m: Record<string, unknown> | undefined) => {
    if (!m) return undefined;
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(m)) {
      out[k] = typeof v === 'string' ? '••••' : v;
    }
    return out as McpServerTransport['headers'];
  };
  return {
    ...transport,
    headers: mask(transport.headers),
    env: mask(transport.env) as McpServerTransport['env'],
  };
}

function parseTransport(raw: unknown): { ok: true; transport: McpServerTransport } | { ok: false; error: string } {
  if (raw === null || typeof raw !== 'object') return { ok: false, error: 'transport must be an object' };
  const t = raw as Record<string, unknown>;
  const url = typeof t.url === 'string' ? t.url.trim() : undefined;
  const command = typeof t.command === 'string' ? t.command.trim() : undefined;
  if (!url && !command) return { ok: false, error: 'transport needs a url (http) or command (stdio)' };
  if (url && command) return { ok: false, error: 'transport cannot set both url and command' };
  const transport: McpServerTransport = {};
  if (url) {
    transport.url = url;
    transport.type = 'http';
    if (Array.isArray(t.headers) || (t.headers && typeof t.headers === 'object')) {
      transport.headers = t.headers as McpServerTransport['headers'];
    }
  } else if (command) {
    transport.command = command;
    if (Array.isArray(t.args)) transport.args = (t.args as unknown[]).map(String);
    if (t.env && typeof t.env === 'object') transport.env = t.env as McpServerTransport['env'];
    if (typeof t.cwd === 'string') transport.cwd = t.cwd;
  }
  return { ok: true, transport };
}

function parseConsumer(raw: unknown): McpConsumerKey | null {
  if (typeof raw !== 'string') return null;
  if (raw === 'orchestrator') return 'orchestrator';
  if (raw.startsWith('agent:') && raw.length > 'agent:'.length) return raw as McpConsumerKey;
  return null;
}

export function mountMcp(app: Hono, deps: McpHttpDeps): void {
  const { mcp } = deps;

  // List — full health detail, always works regardless of server health.
  app.get('/api/mcp', (c) => {
    const rows = listMcpServersRegistry();
    return c.json({ ok: true, servers: rows.map(toDto) });
  });

  app.get('/api/mcp/:id', (c) => {
    const row = getMcpServerRegistry(c.req.param('id') as ULID);
    if (!row) return c.json({ ok: false, error: 'not found' }, 404);
    return c.json({ ok: true, server: toDto(row) });
  });

  // Create — seeds an orchestrator attachment (default orchestrator-only), then
  // probes the new server best-effort (never blocks the response on health).
  app.post('/api/mcp', async (c) => {
    const body = (await c.req.json().catch(() => ({}))) as Record<string, unknown>;
    const name = typeof body.name === 'string' ? body.name.trim() : '';
    if (!name) return c.json({ ok: false, error: 'name is required' }, 400);
    const parsed = parseTransport(body.transport);
    if (!parsed.ok) return c.json({ ok: false, error: parsed.error }, 400);
    let row: McpServerRegistryRow;
    try {
      row = createMcpServerRegistry({
        scope: 'global',
        name,
        description: typeof body.description === 'string' ? body.description : '',
        enabled: body.enabled === undefined ? true : Boolean(body.enabled),
        transport: parsed.transport,
      });
    } catch (err) {
      if (err instanceof Error && /UNIQUE/i.test(err.message)) {
        return c.json({ ok: false, error: `a server named '${name}' already exists` }, 400);
      }
      throw err;
    }
    attachMcpConsumer({ mcpServerId: row.id, consumer: 'orchestrator' });
    mcp.syncFromRegistry();
    void mcp.probe(row.id).catch(() => {});
    return c.json({ ok: true, server: toDto(getMcpServerRegistry(row.id)!) }, 201);
  });

  app.patch('/api/mcp/:id', async (c) => {
    const id = c.req.param('id') as ULID;
    if (!getMcpServerRegistry(id)) return c.json({ ok: false, error: 'not found' }, 404);
    const body = (await c.req.json().catch(() => ({}))) as Record<string, unknown>;
    const patch: Parameters<typeof patchMcpServerRegistry>[1] = {};
    if (typeof body.name === 'string') patch.name = body.name.trim();
    if (typeof body.description === 'string') patch.description = body.description;
    if (body.enabled !== undefined) patch.enabled = Boolean(body.enabled);
    if (body.transport !== undefined) {
      const parsed = parseTransport(body.transport);
      if (!parsed.ok) return c.json({ ok: false, error: parsed.error }, 400);
      patch.transport = parsed.transport;
    }
    let updated: McpServerRegistryRow | null;
    try {
      updated = patchMcpServerRegistry(id, patch);
    } catch (err) {
      if (err instanceof Error && /UNIQUE/i.test(err.message)) {
        return c.json({ ok: false, error: 'name already in use' }, 400);
      }
      throw err;
    }
    mcp.syncFromRegistry();
    void mcp.probe(id).catch(() => {});
    return c.json({ ok: true, server: toDto(updated ?? getMcpServerRegistry(id)!) });
  });

  app.delete('/api/mcp/:id', (c) => {
    const id = c.req.param('id') as ULID;
    if (!getMcpServerRegistry(id)) return c.json({ ok: false, error: 'not found' }, 404);
    softDeleteMcpServerRegistry(id);
    mcp.syncFromRegistry();
    return c.json({ ok: true });
  });

  // Write-only secret — plaintext goes in, only a presence flag ever comes back.
  app.post('/api/mcp/:id/secret', async (c) => {
    const id = c.req.param('id') as ULID;
    if (!getMcpServerRegistry(id)) return c.json({ ok: false, error: 'not found' }, 404);
    const body = (await c.req.json().catch(() => ({}))) as Record<string, unknown>;
    const value = typeof body.value === 'string' ? body.value : '';
    if (!value) return c.json({ ok: false, error: 'value is required' }, 400);
    putServerSecret(id, {
      value,
      kind: body.kind === 'oauth_tokens' || body.kind === 'provider_tokens' ? body.kind : 'static',
      expiresAt: typeof body.expiresAt === 'number' ? body.expiresAt : null,
      headerName: typeof body.headerName === 'string' ? body.headerName : undefined,
      envName: typeof body.envName === 'string' ? body.envName : undefined,
    });
    mcp.syncFromRegistry();
    void mcp.probe(id).catch(() => {});
    const presence = serverSecretPresence(id);
    return c.json({ ok: true, secret: { present: presence.present, authState: presence.authState, expiresAt: presence.expiresAt } }, 201);
  });

  // Manual reprobe.
  app.post('/api/mcp/:id/probe', async (c) => {
    const id = c.req.param('id') as ULID;
    if (!getMcpServerRegistry(id)) return c.json({ ok: false, error: 'not found' }, 404);
    mcp.syncFromRegistry();
    const status = await mcp.probe(id);
    return c.json({ ok: true, health: status });
  });

  // Attachments — explicit per-consumer read/write.
  app.get('/api/mcp/:id/attachments', (c) => {
    const id = c.req.param('id') as ULID;
    if (!getMcpServerRegistry(id)) return c.json({ ok: false, error: 'not found' }, 404);
    return c.json({ ok: true, consumers: listMcpConsumersForServer(id) });
  });

  app.post('/api/mcp/:id/attachments', async (c) => {
    const id = c.req.param('id') as ULID;
    if (!getMcpServerRegistry(id)) return c.json({ ok: false, error: 'not found' }, 404);
    const body = (await c.req.json().catch(() => ({}))) as Record<string, unknown>;
    const consumer = parseConsumer(body.consumer);
    if (!consumer) return c.json({ ok: false, error: "consumer must be 'orchestrator' or 'agent:<name>'" }, 400);
    attachMcpConsumer({ mcpServerId: id, consumer });
    return c.json({ ok: true, consumers: listMcpConsumersForServer(id) }, 201);
  });

  app.delete('/api/mcp/:id/attachments', async (c) => {
    const id = c.req.param('id') as ULID;
    if (!getMcpServerRegistry(id)) return c.json({ ok: false, error: 'not found' }, 404);
    const body = (await c.req.json().catch(() => ({}))) as Record<string, unknown>;
    const consumer = parseConsumer(body.consumer);
    if (!consumer) return c.json({ ok: false, error: "consumer must be 'orchestrator' or 'agent:<name>'" }, 400);
    const removed = detachMcpConsumer(id, consumer);
    return c.json({ ok: true, removed, consumers: listMcpConsumersForServer(id) });
  });
}
