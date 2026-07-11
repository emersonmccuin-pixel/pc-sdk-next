// Dedicated conversation outbox relay. Producers only commit; this service is
// the single live-publication path for chat and agent transcript events.

import {
  listUnrelayedConversationEvents,
  markConversationEventsRelayed,
  type ConversationOutboxEntry,
} from '@pc/db';
import type { AgentEventFrame, ChatEvent, ULID } from '@pc/contracts';
import { ProjectWebSocketHub } from '../ws/hub.ts';
import { rowToConversationEventFrame } from './replay.ts';

const BATCH_LIMIT = 500;

export interface ConversationRelayDeps {
  hub: ProjectWebSocketHub<ULID>;
  listPending?: typeof listUnrelayedConversationEvents;
  markRelayed?: typeof markConversationEventsRelayed;
}

export class ConversationRelay {
  private readonly hub: ProjectWebSocketHub<ULID>;
  private readonly listPending: typeof listUnrelayedConversationEvents;
  private readonly markRelayed: typeof markConversationEventsRelayed;
  private draining = false;
  private redrain = false;

  constructor(deps: ConversationRelayDeps) {
    this.hub = deps.hub;
    this.listPending = deps.listPending ?? listUnrelayedConversationEvents;
    this.markRelayed = deps.markRelayed ?? markConversationEventsRelayed;
  }

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
    for (;;) {
      const batch = this.listPending(BATCH_LIMIT);
      if (batch.length === 0) return;
      for (const entry of batch) {
        this.fan(entry);
        // Mark only after fanout. A crash here intentionally redelivers the
        // immutable event; browser projection dedupes by event/sequence.
        this.markRelayed([entry.outboxSequence]);
      }
      if (batch.length < BATCH_LIMIT) return;
    }
  }

  private fan(entry: ConversationOutboxEntry): void {
    // Only migration/raw inspection can produce hidden rows. Defense in depth:
    // if one is ever left pending, consume its outbox entry without exposing it.
    if (entry.event.projectionState !== 'visible') return;
    if (entry.deliveryKind === 'chat') {
      this.hub.broadcast(entry.event.projectId, rowToConversationEventFrame(entry.event));
      return;
    }
    const frame: AgentEventFrame = {
      type: 'agent-event',
      projectId: entry.event.projectId,
      runId: entry.event.sessionId as ULID,
      event: entry.event.payload as ChatEvent,
      dedupId: entry.event.eventId,
    };
    this.hub.broadcast(entry.event.projectId, frame);
  }
}
