// N6 MCP reliability (requirement 6 — attachment is explicit).
//
// One row per (server, consumer). `consumer` is `'orchestrator'` or
// `agent:<name>`. A server with no rows here is bridged to NO consumer; the
// create path seeds an `orchestrator` row so a new server defaults to
// orchestrator-only. Idempotent create (UNIQUE on server+consumer).

import { and, eq } from 'drizzle-orm';
import type { McpConsumerAttachmentRow, McpConsumerKey, ULID } from '@pc/domain';
import { getDb } from '../connection.ts';
import { newId } from '../id.ts';
import { mcpConsumerAttachments } from '../schema.ts';

function rowToAttachment(
  row: typeof mcpConsumerAttachments.$inferSelect,
): McpConsumerAttachmentRow {
  return {
    id: row.id as ULID,
    mcpServerId: row.mcpServerId as ULID,
    consumer: row.consumer,
    toolFilter: row.toolFilter ?? null,
    createdAt: row.createdAt,
  };
}

export interface AttachMcpConsumerInput {
  mcpServerId: ULID;
  consumer: McpConsumerKey;
  /** pc-sdk-15 — optional tool allowlist. Omitted ⇒ leave an existing row's
   *  filter untouched (or null on first create). Passing an explicit value
   *  (including `null`) on an already-attached pair updates its filter —
   *  this is how the boot seed keeps a fixed default filter in sync across
   *  restarts without ever widening a user's own edit silently, since the
   *  seed always passes the exact same literal list. */
  toolFilter?: string[] | null;
}

/** Attach a consumer to a server. Idempotent — returns the existing row when
 *  the pair is already attached (updating its `toolFilter` when the caller
 *  passed one explicitly). */
export function attachMcpConsumer(input: AttachMcpConsumerInput): McpConsumerAttachmentRow {
  const db = getDb();
  const existing = db
    .select()
    .from(mcpConsumerAttachments)
    .where(
      and(
        eq(mcpConsumerAttachments.mcpServerId, input.mcpServerId),
        eq(mcpConsumerAttachments.consumer, input.consumer),
      ),
    )
    .get();
  if (existing) {
    if (input.toolFilter === undefined) return rowToAttachment(existing);
    db.update(mcpConsumerAttachments)
      .set({ toolFilter: input.toolFilter })
      .where(eq(mcpConsumerAttachments.id, existing.id))
      .run();
    return rowToAttachment({ ...existing, toolFilter: input.toolFilter });
  }
  const row = {
    id: newId() as ULID,
    mcpServerId: input.mcpServerId,
    consumer: input.consumer,
    toolFilter: input.toolFilter ?? null,
    createdAt: Date.now(),
  };
  db.insert(mcpConsumerAttachments).values(row).run();
  return rowToAttachment(row);
}

/** Detach a consumer from a server. Returns true when a row was removed. */
export function detachMcpConsumer(mcpServerId: ULID, consumer: McpConsumerKey): boolean {
  const existing = getDb()
    .select()
    .from(mcpConsumerAttachments)
    .where(
      and(
        eq(mcpConsumerAttachments.mcpServerId, mcpServerId),
        eq(mcpConsumerAttachments.consumer, consumer),
      ),
    )
    .get();
  if (!existing) return false;
  getDb()
    .delete(mcpConsumerAttachments)
    .where(eq(mcpConsumerAttachments.id, existing.id))
    .run();
  return true;
}

/** The consumers a server is attached to. */
export function listMcpConsumersForServer(mcpServerId: ULID): McpConsumerKey[] {
  return getDb()
    .select()
    .from(mcpConsumerAttachments)
    .where(eq(mcpConsumerAttachments.mcpServerId, mcpServerId))
    .all()
    .map((r) => r.consumer);
}

/** The server ids a given consumer is attached to. */
export function listMcpServerIdsForConsumer(consumer: McpConsumerKey): ULID[] {
  return getDb()
    .select()
    .from(mcpConsumerAttachments)
    .where(eq(mcpConsumerAttachments.consumer, consumer))
    .all()
    .map((r) => r.mcpServerId as ULID);
}

/** Full attachment rows (including `toolFilter`) for a given consumer —
 *  pc-sdk-15's `buildBridge` needs the per-server filter, not just the id. */
export function listMcpConsumerAttachmentsForConsumer(
  consumer: McpConsumerKey,
): McpConsumerAttachmentRow[] {
  return getDb()
    .select()
    .from(mcpConsumerAttachments)
    .where(eq(mcpConsumerAttachments.consumer, consumer))
    .all()
    .map(rowToAttachment);
}
