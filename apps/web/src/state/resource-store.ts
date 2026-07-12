// Resource store — Channel 2 (durable, global cursor). See docs/event-contract.md.
//
// Identity-keyed by (entity, entityId), NOT scanned positionally off any
// timeline. This is what makes a rebuild (session-replay, tab refresh) safe:
// the store just re-applies whatever frames arrive, in any order, and the
// (entity, entityId) + version dedup converges on the same state every time.
//
// Dedup rule (contract): strictly-older loses, equal wins (same-version
// overlays like the `stalled` badge must still apply), null version =
// last-write-wins by cursor.
//
// The websocket client admits guarded `resource` / `live-reset` frames here;
// HTTP-backed consumers may also call `seed` before the socket is live.
// Consumers read through selector hooks regardless of source.

import { useMemo } from 'react';
import { create } from 'zustand';
import type {
  LiveResetFrame,
  ResourceEntity,
  ResourceEvent,
  ResourceFrame,
} from '@pc/contracts';

type Key = string; // `${entity}::${entityId}`

function keyOf(entity: ResourceEntity, entityId: string): Key {
  return `${entity}::${entityId}`;
}

/** Numeric-string cursor comparison: does `a` come at-or-after `b`?
 *  Non-numeric input (shouldn't happen — both are server-minted) always
 *  wins, so a malformed frame never gets silently stuck behind a bad prior
 *  value. */
function cursorAtOrAfter(a: string, b: string): boolean {
  const na = Number(a);
  const nb = Number(b);
  if (!Number.isFinite(na) || !Number.isFinite(nb)) return true;
  return na >= nb;
}

/** True iff `ev` should replace `prev` under the contract's dedup rule.
 *  Exported for the guard tests. */
export function resourceEventWins(prev: ResourceEvent | undefined, ev: ResourceEvent): boolean {
  if (!prev) return true;
  if (ev.version !== null) {
    // Versioned entity: strictly-older loses, equal (or newer) wins.
    if (prev.version !== null && ev.version < prev.version) return false;
    return true;
  }
  // null version = last-write-wins by cursor.
  return cursorAtOrAfter(ev.cursor, prev.cursor);
}

interface ResourceStoreState {
  byKey: Map<Key, ResourceEvent>;
  /** Apply one live 'resource' frame. No-op if a newer/equal frame is
   *  already held for that (entity, entityId). */
  applyResourceFrame: (frame: ResourceFrame) => void;
  /** Cold-load HTTP seed: merge a batch of raw ResourceEvents with the SAME
   *  dedup rule as the live path, so a fresh load doesn't need to wait for
   *  the next live frame to show current state. Order-independent. */
  seed: (events: readonly ResourceEvent[]) => void;
  /** `live-reset`: the client's cursor fell below the pruned floor. Contract
   *  says "clear store, clear cursor, epoch-refetch everything" — cursor is
   *  GLOBAL (not per-project), so a reset invalidates the whole store, not
   *  just one project's slice, even though the frame carries a projectId for
   *  logging. Callers still epoch-refetch on top of this. */
  applyLiveReset: (frame: LiveResetFrame) => void;
  /** Drop everything (e.g. socket epoch bump before a fresh reseed). */
  clearAll: () => void;
}

function mergeOne(byKey: Map<Key, ResourceEvent>, ev: ResourceEvent): Map<Key, ResourceEvent> | null {
  const key = keyOf(ev.entity, ev.entityId);
  if (!resourceEventWins(byKey.get(key), ev)) return null;
  const next = new Map(byKey);
  next.set(key, ev);
  return next;
}

export const useResourceStore = create<ResourceStoreState>((set, get) => ({
  byKey: new Map(),
  applyResourceFrame: (frame) => {
    const next = mergeOne(get().byKey, frame.event);
    if (next) set({ byKey: next });
  },
  seed: (events) => {
    let map = get().byKey;
    let changed = false;
    for (const ev of events) {
      const next = mergeOne(map, ev);
      if (next) {
        map = next;
        changed = true;
      }
    }
    if (changed) set({ byKey: map });
  },
  applyLiveReset: () => set({ byKey: new Map() }),
  clearAll: () => set({ byKey: new Map() }),
}));

/** Every event the store holds for `entity` in scope for `projectId`:
 *  project-scoped frames matching the project PLUS global-scope frames
 *  (`projectId === null`) — global-scope facts (e.g. stock specialists)
 *  legitimately affect every project view. */
export function selectResourceEvents(
  byKey: Map<Key, ResourceEvent>,
  entity: ResourceEntity,
  projectId: string | null,
): ResourceEvent[] {
  const out: ResourceEvent[] = [];
  for (const ev of byKey.values()) {
    if (ev.entity !== entity) continue;
    if (ev.projectId !== null && ev.projectId !== projectId) continue;
    out.push(ev);
  }
  return out;
}

/** Hook form of `selectResourceEvents`, memoized on the store map identity
 *  (which only changes reference on an actual merge) so it's cheap to call
 *  from render. */
export function useResourceEvents(
  entity: ResourceEntity,
  projectId: string | null,
): ResourceEvent[] {
  const byKey = useResourceStore((s) => s.byKey);
  return useMemo(() => selectResourceEvents(byKey, entity, projectId), [byKey, entity, projectId]);
}

/** Single (entity, entityId) lookup — current snapshot or null. */
export function useResourceEvent(
  entity: ResourceEntity,
  entityId: string | null,
): ResourceEvent | null {
  const byKey = useResourceStore((s) => s.byKey);
  return useMemo(
    () => (entityId ? (byKey.get(keyOf(entity, entityId)) ?? null) : null),
    [byKey, entity, entityId],
  );
}
