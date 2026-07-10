// Specialist resource frames — signal-only `specialist` events through the
// live outbox (the relay's 250ms drain broadcasts; AgentsList refetches on
// arrival). All frames carry `version: null` (last-write-wins by cursor):
// the payload is a refetch signal, and membership changes don't bump the
// agent's rev, so rev-based dedup would swallow attach/detach signals.
//
// Emit AFTER the repo call returns — never inside a repo transaction (the
// outbox insert is its own tiny write; same rule as mcp/manager.ts).

import { getDb, insertLiveEvent } from '@pc/db';
import type { SpecialistChangedPayload } from '@pc/contracts';
import type { ULID } from '@pc/domain';

/** Agent content changed (create/update/delete/reset). Global scope — stock
 *  and pool agents affect every project view. */
export function announceSpecialist(specialistId: ULID): void {
  emit(specialistId, 'global', null);
}

/** Membership changed for one project (attach/detach) — only that project's
 *  sockets need to refetch. */
export function announceSpecialistToProject(specialistId: ULID, projectId: ULID): void {
  emit(specialistId, 'project', projectId);
}

function emit(specialistId: ULID, scope: 'global' | 'project', projectId: ULID | null): void {
  const payload: SpecialistChangedPayload = { specialistId };
  try {
    insertLiveEvent(getDb(), {
      scope,
      projectId,
      type: 'specialist.changed',
      entity: 'specialist',
      entityId: specialistId,
      version: null,
      payload,
    });
  } catch (err) {
    console.warn('[pc-sdk][agents] emit failed:', err instanceof Error ? err.message : err);
  }
}
