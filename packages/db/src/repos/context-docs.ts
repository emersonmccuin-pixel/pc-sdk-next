// ContextDoc repo.
//
// Persistence only. DbExecutor-injectable `*InDb` variants + getDb() wrappers.
//
// Scope-pointer invariant: exactly one of (projectId, agentId) may be non-null.
// The writer throws before touching the DB when the constraint is violated.
// (The old area / work-item scopes and the FTS search + context-chain walk died
// with the board/work-item model — see docs/event-contract.md.)
//
// Agent-scoped mutations emit an `agent_audit` row (field 'context-doc') in the
// same transaction — the pod History tab reads it.

import { and, asc, eq, isNull } from 'drizzle-orm';
import type { ULID } from '@pc/domain';
import { getDb } from '../connection.ts';
import type { DbExecutor } from '../connection.ts';
import { newId } from '../id.ts';
import { agentAudit, contextDocs } from '../schema.ts';
import { type AuditInput, buildAuditRow } from './pod-audit.ts';

// ── Row types ────────────────────────────────────────────────────────────────

export interface ContextDocRow {
  id: ULID;
  projectId: ULID | null;
  agentId: ULID | null;
  title: string;
  body: string;
  author: string;
  createdAt: number;
  updatedAt: number;
  deletedAt: number | null;
}

/** One-scope constraint — exactly one field must be set. */
export type ContextDocScope =
  | { projectId: ULID; agentId?: undefined }
  | { agentId: ULID; projectId?: undefined };

export interface CreateContextDocInput {
  scope: ContextDocScope;
  title: string;
  body?: string;
  author?: string;
}

export interface UpdateContextDocInput {
  title?: string;
  body?: string;
}

// ── Helpers ──────────────────────────────────────────────────────────────────

function enforceScope(scope: ContextDocScope): void {
  const set = [scope.projectId, scope.agentId].filter(Boolean).length;
  if (set !== 1) {
    throw new Error(
      `ContextDoc scope must have exactly one non-null pointer; got ${set}`,
    );
  }
}

function scopeToColumns(scope: ContextDocScope): {
  projectId: ULID | null;
  agentId: ULID | null;
} {
  return {
    projectId: scope.projectId ?? null,
    agentId: scope.agentId ?? null,
  };
}

/** Compact `{title, body}` snapshot — what 'context-doc' audit rows carry in
 *  their value columns. */
function contextDocSnapshot(row: ContextDocRow): string {
  return JSON.stringify({ title: row.title, body: row.body });
}

const DEFAULT_DOC_AUDIT: AuditInput = { actor: 'user', reason: 'context-doc-edit' };

function emitAgentDocAudit(
  db: DbExecutor,
  row: ContextDocRow,
  opts: { prior?: ContextDocRow | null; deleted?: boolean; audit?: AuditInput },
): void {
  if (!row.agentId) return;
  const now = Date.now();
  db.insert(agentAudit)
    .values(
      buildAuditRow(
        {
          agentId: row.agentId,
          field: 'context-doc',
          fieldRef: row.id,
          priorValue: opts.prior ? contextDocSnapshot(opts.prior) : null,
          newValue: opts.deleted ? null : contextDocSnapshot(row),
          audit: opts.audit ?? DEFAULT_DOC_AUDIT,
        },
        now,
      ),
    )
    .run();
}

// ── CRUD ─────────────────────────────────────────────────────────────────────

export function createContextDoc(
  input: CreateContextDocInput,
  audit?: AuditInput,
): ContextDocRow {
  return getDb().transaction((tx) => createContextDocInDb(tx, input, audit));
}

export function createContextDocInDb(
  db: DbExecutor,
  input: CreateContextDocInput,
  audit?: AuditInput,
): ContextDocRow {
  enforceScope(input.scope);
  const now = Date.now();
  const row: ContextDocRow = {
    id: newId(),
    ...scopeToColumns(input.scope),
    title: input.title,
    body: input.body ?? '',
    author: input.author ?? 'user',
    createdAt: now,
    updatedAt: now,
    deletedAt: null,
  };
  db.insert(contextDocs).values(row).run();
  emitAgentDocAudit(db, row, { audit });
  return row;
}

export function updateContextDoc(
  id: ULID,
  input: UpdateContextDocInput,
  audit?: AuditInput,
): ContextDocRow | null {
  return getDb().transaction((tx) => updateContextDocInDb(tx, id, input, audit));
}

export function updateContextDocInDb(
  db: DbExecutor,
  id: ULID,
  input: UpdateContextDocInput,
  audit?: AuditInput,
): ContextDocRow | null {
  const existing = getContextDocInDb(db, id);
  if (!existing || existing.deletedAt !== null) return null;
  if (input.title === undefined && input.body === undefined) return existing;
  if (
    (input.title === undefined || input.title === existing.title) &&
    (input.body === undefined || input.body === existing.body)
  ) {
    return existing;
  }
  const now = Date.now();
  const patch: Partial<ContextDocRow> & { updatedAt: number } = { updatedAt: now };
  if (input.title !== undefined) patch.title = input.title;
  if (input.body !== undefined) patch.body = input.body;
  db.update(contextDocs).set(patch).where(eq(contextDocs.id, id)).run();
  const next = getContextDocInDb(db, id);
  if (next) emitAgentDocAudit(db, next, { prior: existing, audit });
  return next;
}

export function getContextDoc(id: ULID): ContextDocRow | null {
  return getContextDocInDb(getDb(), id);
}

export function getContextDocInDb(db: DbExecutor, id: ULID): ContextDocRow | null {
  const row = db
    .select()
    .from(contextDocs)
    .where(and(eq(contextDocs.id, id), isNull(contextDocs.deletedAt)))
    .get() as ContextDocRow | undefined;
  return row ?? null;
}

export function softDeleteContextDoc(id: ULID, audit?: AuditInput): ContextDocRow | null {
  return getDb().transaction((tx) => softDeleteContextDocInDb(tx, id, audit));
}

export function softDeleteContextDocInDb(
  db: DbExecutor,
  id: ULID,
  audit?: AuditInput,
): ContextDocRow | null {
  const existing = getContextDocInDb(db, id);
  if (!existing) return null;
  const now = Date.now();
  db.update(contextDocs)
    .set({ deletedAt: now, updatedAt: now })
    .where(eq(contextDocs.id, id))
    .run();
  emitAgentDocAudit(db, existing, { prior: existing, deleted: true, audit });
  return db
    .select()
    .from(contextDocs)
    .where(eq(contextDocs.id, id))
    .get() as ContextDocRow | null ?? null;
}

// ── Scope list ─────────────────────────────────────────────────────────────

export interface ListContextDocsOptions {
  scope: ContextDocScope;
}

/** List docs directly attached to exactly one scope. */
export function listContextDocsForScope(opts: ListContextDocsOptions): ContextDocRow[] {
  return listContextDocsForScopeInDb(getDb(), opts);
}

export function listContextDocsForScopeInDb(
  db: DbExecutor,
  opts: ListContextDocsOptions,
): ContextDocRow[] {
  enforceScope(opts.scope);
  const { projectId, agentId } = scopeToColumns(opts.scope);
  const whereClause = projectId
    ? and(eq(contextDocs.projectId, projectId), isNull(contextDocs.deletedAt))
    : and(eq(contextDocs.agentId, agentId!), isNull(contextDocs.deletedAt));
  return db
    .select()
    .from(contextDocs)
    .where(whereClause)
    .orderBy(asc(contextDocs.createdAt))
    .all() as ContextDocRow[];
}

/** Title-keyed lookup within one agent's docs — the stock seeder's "does this
 *  doc already exist" probe. Titles are not unique-constrained; returns the
 *  oldest match. */
export function getAgentContextDocByTitle(input: {
  agentId: ULID;
  title: string;
}): ContextDocRow | null {
  const row = getDb()
    .select()
    .from(contextDocs)
    .where(
      and(
        eq(contextDocs.agentId, input.agentId),
        eq(contextDocs.title, input.title),
        isNull(contextDocs.deletedAt),
      ),
    )
    .orderBy(asc(contextDocs.createdAt))
    .get() as ContextDocRow | undefined;
  return row ?? null;
}
