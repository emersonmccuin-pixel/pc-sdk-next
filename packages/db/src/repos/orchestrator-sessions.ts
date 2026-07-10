// OrchestratorSession repo. One active row per project (DB-enforced via
// `orch_sessions_active_per_project_idx`). `providerSessionId` is the SDK
// session id — minted at create time and reused via `resume` on subsequent
// turns so chat history matches what the model actually has in context.

import { and, desc, eq, isNull } from 'drizzle-orm';
import type { ProviderId, SessionEndedReason, SessionStatus, ULID } from '@pc/domain';
import { getDb } from '../connection.ts';
import { newId } from '../id.ts';
import { orchestratorSessions } from '../schema.ts';

/** Persisted session shape. Local to the repo — the PTY-era jsonlPath /
 *  jsonlLineCursor fields are gone with the terminal transport. */
export interface OrchestratorSessionRow {
  id: ULID;
  projectId: ULID;
  provider: ProviderId;
  providerSessionId: string | null;
  model: string | null;
  title: string | null;
  status: SessionStatus;
  endedReason: SessionEndedReason | null;
  startedAt: number;
  endedAt: number | null;
  deletedAt: number | null;
}

function toDomain(row: OrchestratorSessionRow): OrchestratorSessionRow {
  return {
    id: row.id,
    projectId: row.projectId,
    provider: row.provider,
    providerSessionId: row.providerSessionId,
    model: row.model,
    title: row.title,
    status: row.status,
    endedReason: row.endedReason,
    startedAt: row.startedAt,
    endedAt: row.endedAt,
    deletedAt: row.deletedAt,
  };
}

export interface CreateOrchestratorSessionInput {
  projectId: ULID;
  /** SDK session id. We mint it ourselves so we can pass it on the first turn
   *  and write the row before any event fires. */
  providerSessionId: string;
  provider?: ProviderId;
  model?: string | null;
  title?: string | null;
}

export function createOrchestratorSession(
  input: CreateOrchestratorSessionInput,
): OrchestratorSessionRow {
  const now = Date.now();
  const id = newId();
  getDb()
    .insert(orchestratorSessions)
    .values({
      id,
      projectId: input.projectId,
      provider: input.provider ?? 'claude',
      providerSessionId: input.providerSessionId,
      model: input.model ?? null,
      title: input.title ?? null,
      status: 'active',
      startedAt: now,
    })
    .run();
  return {
    id,
    projectId: input.projectId,
    provider: input.provider ?? 'claude',
    providerSessionId: input.providerSessionId,
    model: input.model ?? null,
    title: input.title ?? null,
    status: 'active',
    endedReason: null,
    startedAt: now,
    endedAt: null,
    deletedAt: null,
  };
}

export function getOrchestratorSession(id: ULID): OrchestratorSessionRow | null {
  const row = getDb()
    .select()
    .from(orchestratorSessions)
    .where(
      and(
        eq(orchestratorSessions.id, id),
        isNull(orchestratorSessions.deletedAt),
      ),
    )
    .get() as OrchestratorSessionRow | undefined;
  return row ? toDomain(row) : null;
}

export function getActiveOrchestratorSession(projectId: ULID): OrchestratorSessionRow | null {
  const row = getDb()
    .select()
    .from(orchestratorSessions)
    .where(
      and(
        eq(orchestratorSessions.projectId, projectId),
        eq(orchestratorSessions.status, 'active'),
        isNull(orchestratorSessions.deletedAt),
      ),
    )
    .get() as OrchestratorSessionRow | undefined;
  return row ? toDomain(row) : null;
}

export function listOrchestratorSessionsForProject(
  projectId: ULID,
): OrchestratorSessionRow[] {
  const rows = getDb()
    .select()
    .from(orchestratorSessions)
    .where(
      and(
        eq(orchestratorSessions.projectId, projectId),
        isNull(orchestratorSessions.deletedAt),
      ),
    )
    .orderBy(desc(orchestratorSessions.startedAt))
    .all() as OrchestratorSessionRow[];
  return rows.map(toDomain);
}

export function endOrchestratorSession(
  id: ULID,
  reason: SessionEndedReason,
): OrchestratorSessionRow | null {
  const now = Date.now();
  getDb()
    .update(orchestratorSessions)
    .set({ status: 'ended', endedReason: reason, endedAt: now })
    .where(eq(orchestratorSessions.id, id))
    .run();
  const row = getDb()
    .select()
    .from(orchestratorSessions)
    .where(eq(orchestratorSessions.id, id))
    .get() as OrchestratorSessionRow | undefined;
  return row ? toDomain(row) : null;
}

/** Flip an ended session back to active. Used by resume so clicking a past
 *  session brings THAT row back to life (keeps its title + conversation),
 *  instead of minting a new row. `startedAt` is bumped so the row sorts to the
 *  top of the Sessions list. */
export function reactivateOrchestratorSession(id: ULID): OrchestratorSessionRow | null {
  const now = Date.now();
  getDb()
    .update(orchestratorSessions)
    .set({ status: 'active', endedReason: null, endedAt: null, startedAt: now })
    .where(eq(orchestratorSessions.id, id))
    .run();
  const row = getDb()
    .select()
    .from(orchestratorSessions)
    .where(eq(orchestratorSessions.id, id))
    .get() as OrchestratorSessionRow | undefined;
  return row ? toDomain(row) : null;
}

/** Set or update the title. Caller decides when (first user message today). */
export function setOrchestratorSessionTitle(id: ULID, title: string): void {
  getDb()
    .update(orchestratorSessions)
    .set({ title })
    .where(eq(orchestratorSessions.id, id))
    .run();
}
