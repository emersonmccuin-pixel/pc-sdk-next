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
    createdAt: row.createdAt,
  };
}

export interface AttachMcpConsumerInput {
  mcpServerId: ULID;
  consumer: McpConsumerKey;
}

/** Attach a consumer to a server. Idempotent — returns the existing row when
 *  the pair is already attached. */
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
  if (existing) return rowToAttachment(existing);
  const row = {
    id: newId() as ULID,
    mcpServerId: input.mcpServerId,
    consumer: input.consumer,
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
