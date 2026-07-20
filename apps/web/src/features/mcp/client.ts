// MCP manager HTTP client — full CRUD, write-only secret, manual reprobe, and
// explicit per-consumer attachment over apps/server/src/http/mcp.ts.

import { deleteJson, deleteJsonWithBody, getJson, postJson, postJsonMethod } from '@/api/http';
import type { McpServerStatus } from '@pc/contracts';
import type { McpConsumerKey } from '@pc/domain';
import type {
  CreateMcpServerInput,
  McpServerDto,
  PutMcpSecretInput,
  UpdateMcpServerInput,
} from './types';

export * from './types';

const base = '/api/mcp';

export const mcpApi = {
  list: () => getJson<{ ok: true; servers: McpServerDto[] }>(base).then((r) => r.servers),

  get: (id: string) => getJson<{ ok: true; server: McpServerDto }>(`${base}/${id}`).then((r) => r.server),

  create: (input: CreateMcpServerInput) =>
    postJson<{ ok: true; server: McpServerDto }>(base, input).then((r) => r.server),

  update: (id: string, patch: UpdateMcpServerInput) =>
    postJsonMethod<{ ok: true; server: McpServerDto }>(`${base}/${id}`, patch, 'PATCH').then((r) => r.server),

  remove: (id: string) => deleteJson<{ ok: true }>(`${base}/${id}`).then(() => undefined),

  /** Write-only — the server never echoes the plaintext back, only presence. */
  putSecret: (id: string, input: PutMcpSecretInput) =>
    postJson<{
      ok: true;
      secret: { present: boolean; authState: string | null; expiresAt: number | null };
    }>(`${base}/${id}/secret`, input).then((r) => r.secret),

  probe: (id: string) => postJson<{ ok: true; health: McpServerStatus }>(`${base}/${id}/probe`, {}).then((r) => r.health),

  listAttachments: (id: string) =>
    getJson<{ ok: true; consumers: McpConsumerKey[] }>(`${base}/${id}/attachments`).then((r) => r.consumers),

  attach: (id: string, consumer: McpConsumerKey) =>
    postJson<{ ok: true; consumers: McpConsumerKey[] }>(`${base}/${id}/attachments`, { consumer }).then(
      (r) => r.consumers,
    ),

  detach: (id: string, consumer: McpConsumerKey) =>
    deleteJsonWithBody<{ ok: true; consumers: McpConsumerKey[] }>(`${base}/${id}/attachments`, { consumer }).then(
      (r) => r.consumers,
    ),
};
