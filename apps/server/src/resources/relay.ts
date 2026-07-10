// Resource relay — Channel 2 (durable, global cursor). The live-outbox pattern:
// a gateway writes the event row inside its DB transaction; AFTER commit,
// `drain()` fans the committed rows to sockets as `resource` frames. Never call
// `drain()` inside a `db.transaction()` closure — a mid-transaction fan would
// announce a write that may still roll back.
//
// Two delivery paths, both here:
//  - live drain: new committed rows → the whole room (project scope) or every
//    room (global scope).
//  - per-socket subscribe handshake (`catchUp`): replay `(lastVersion, head]` to
//    ONE socket, or a `live-reset` if its cursor predates the pruned floor.

import {
  getLiveEventHighWater,
  listLiveEventsAfter,
  listLiveOutboxRowsAfter,
  type LiveOutboxEvent,
} from '@pc/db';
import type { LiveResetFrame, ResourceEvent, ResourceFrame } from '@pc/contracts';
import type { ULID } from '@pc/domain';
import { ProjectWebSocketHub, type WebSocketLike } from '../ws/hub.ts';

const DRAIN_BATCH_LIMIT = 500;

function toResourceFrame(e: LiveOutboxEvent): ResourceFrame {
  const event = {
    id: e.id,
    cursor: e.cursor,
    scope: e.scope,
    projectId: e.projectId,
    entity: e.entity,
    entityId: e.entityId ?? e.id,
    eventType: `${e.entity}.changed`,
    version: e.version,
    createdAt: e.createdAt,
    payload: e.payload,
  } as ResourceEvent;
  return { type: 'resource', event };
}

export interface ResourceRelayDeps {
  hub: ProjectWebSocketHub<ULID>;
  listRowsAfter?: typeof listLiveOutboxRowsAfter;
  listEventsAfter?: typeof listLiveEventsAfter;
  highWater?: typeof getLiveEventHighWater;
}

export class ResourceRelay {
  private readonly hub: ProjectWebSocketHub<ULID>;
  private readonly listRowsAfter: typeof listLiveOutboxRowsAfter;
  private readonly listEventsAfter: typeof listLiveEventsAfter;
  private readonly highWater: typeof getLiveEventHighWater;
  private deliveredCursor: number | null = null;
  private draining = false;
  private redrain = false;

  constructor(deps: ResourceRelayDeps) {
    this.hub = deps.hub;
    this.listRowsAfter = deps.listRowsAfter ?? listLiveOutboxRowsAfter;
    this.listEventsAfter = deps.listEventsAfter ?? listLiveEventsAfter;
    this.highWater = deps.highWater ?? getLiveEventHighWater;
  }

  /** Adopt the current outbox head so the live drain only fans rows committed
   *  from now on. Historical rows reach clients via the subscribe handshake. */
  primeToHead(): void {
    const head = this.highWater();
    this.deliveredCursor = head === null ? 0 : Number(head);
  }

  /** Post-commit drain. Re-entrant-safe: a drain arriving mid-drain coalesces
   *  into one more pass. */
  drain(): void {
    if (this.draining) {
      this.redrain = true;
      return;
    }
    this.draining = true;
    try {
      do {
        this.redrain = false;
        this.drainOnce();
      } while (this.redrain);
    } finally {
      this.draining = false;
    }
  }

  private drainOnce(): void {
    if (this.deliveredCursor === null) this.primeToHead();
    let cursor = this.deliveredCursor ?? 0;
    for (;;) {
      const rows = this.listRowsAfter(String(cursor), DRAIN_BATCH_LIMIT);
      if (rows.length === 0) break;
      for (const row of rows) this.fan(row);
      cursor = Number(rows[rows.length - 1].cursor);
      this.deliveredCursor = cursor;
      if (rows.length < DRAIN_BATCH_LIMIT) break;
    }
  }

  private fan(row: LiveOutboxEvent): void {
    const frame = toResourceFrame(row);
    if (row.scope === 'global') this.hub.broadcastAll(frame);
    else if (row.projectId) this.hub.broadcast(row.projectId as ULID, frame);
  }

  /** Per-socket subscribe handshake. Replay `(lastVersion, head]` to THIS socket
   *  (project-scoped + global unioned), or send `live-reset` if the cursor
   *  predates the pruned floor. Cold load (no cursor) replays nothing — the
   *  socket's room subscription carries live rows from here on. */
  catchUp(socket: WebSocketLike, lastVersion: string | undefined, projectId: ULID | null): void {
    if (socket.readyState !== socket.OPEN) return;
    if (lastVersion === undefined) return;
    let cursor = lastVersion;
    for (;;) {
      const batch = this.listEventsAfter(
        projectId
          ? { after: cursor, projectId, includeGlobal: true, limit: DRAIN_BATCH_LIMIT }
          : { after: cursor, limit: DRAIN_BATCH_LIMIT },
      );
      if (batch.resetRequired) {
        const reset: LiveResetFrame = { type: 'live-reset', projectId, cursor: this.highWater() };
        ProjectWebSocketHub.sendTo(socket, reset);
        return;
      }
      for (const event of batch.events) ProjectWebSocketHub.sendTo(socket, toResourceFrame(event));
      cursor = batch.nextCursor ?? cursor;
      if (batch.events.length < DRAIN_BATCH_LIMIT) break;
    }
  }
}
