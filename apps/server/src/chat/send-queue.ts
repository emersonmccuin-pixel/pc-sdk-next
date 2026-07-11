// Send-queue — serializes user turns while the orchestrator is busy.
//
// Every send lands here. One turn is delivered at a time (FIFO); sends arriving
// mid-turn queue and drain in order. Statuses follow the contract
// (docs/event-contract.md §Send path): queued → delivering → delivered, or
// failed / cancelled. Snapshot replaces snapshot (no per-item deltas); a
// `delivered` item rides exactly one snapshot then is pruned.

import { newId } from '@pc/db';
import type { SendQueueItem, SendQueueItemStatus, ULID } from '@pc/contracts';

/** Carried alongside an enqueued turn whose text is an agent envelope (ask or
 *  terminal), not a plain user message — lets `deliver()` persist the typed
 *  `agent-envelope` chat event instead of a bare `user` bubble, without
 *  changing what text is sent to the runtime as the turn. */
export interface AgentEnvelopeMeta {
  runId: string;
  agentName: string;
  pendingAskId?: string;
  status: 'waiting' | 'done' | 'failed';
  summary: string;
  detail: string;
}

interface QueueItem {
  id: ULID;
  clientMessageId: string;
  text: string;
  agentEnvelope?: AgentEnvelopeMeta;
  status: SendQueueItemStatus;
  failureReason: string | null;
  createdAt: number;
  updatedAt: number;
}

// Dependencies injected into the queue: delivery, broadcast, clock.
export interface SendQueueDeps {
  /** Deliver one turn. Resolves when the turn reached the model + ran to its
   *  terminal; rejects only on a delivery-infrastructure failure (backend won't
   *  start) — a model-side turn error is still a successful delivery. */
  deliver: (item: { id: ULID; clientMessageId: string; text: string; agentEnvelope?: AgentEnvelopeMeta }) => Promise<void>;
  /** Broadcast the current snapshot to the room. */
  onSnapshot: (items: SendQueueItem[]) => void;
  // Clock override for tests; defaults to Date.now.
  now?: () => number;
}

// FIFO queue that delivers one turn at a time.
export class SendQueue {
  private readonly items: QueueItem[] = [];
  private readonly deliver: SendQueueDeps['deliver'];
  private readonly onSnapshot: SendQueueDeps['onSnapshot'];
  private readonly now: () => number;
  private busy = false;

  // Wires in delivery, snapshot, and clock dependencies.
  constructor(deps: SendQueueDeps) {
    this.deliver = deps.deliver;
    this.onSnapshot = deps.onSnapshot;
    this.now = deps.now ?? Date.now;
  }

  /** Enqueue a send. Returns whether it will run immediately (queue was idle) —
   *  the caller maps that to the `received` vs `queued` send-ack status. */
  enqueue(text: string, clientMessageId: string, agentEnvelope?: AgentEnvelopeMeta): { id: ULID; ranImmediately: boolean } {
    const ranImmediately = !this.busy && this.pendingCount === 0;
    const t = this.now();
    const item: QueueItem = {
      id: newId(),
      clientMessageId,
      text,
      agentEnvelope,
      status: 'queued',
      failureReason: null,
      createdAt: t,
      updatedAt: t,
    };
    this.items.push(item);
    this.emit();
    void this.drainSoon();
    return { id: item.id, ranImmediately };
  }

  // Count of items still waiting to be delivered.
  get queueDepth(): number {
    return this.items.filter((i) => i.status === 'queued').length;
  }

  // Whether a turn is currently being delivered.
  get isBusy(): boolean {
    return this.busy;
  }

  // Count of items not yet resolved (queued or delivering).
  private get pendingCount(): number {
    return this.items.filter((i) => i.status === 'queued' || i.status === 'delivering').length;
  }

  /** Cancel every not-yet-delivered item (session reset / new-session). */
  cancelAll(reason = 'session reset'): void {
    let changed = false;
    for (const i of this.items) {
      if (i.status === 'queued' || i.status === 'delivering') {
        i.status = 'cancelled';
        i.failureReason = reason;
        i.updatedAt = this.now();
        changed = true;
      }
    }
    if (changed) this.emit();
  }

  // Returns a plain-object copy of the current queue.
  snapshot(): SendQueueItem[] {
    return this.items.map((i) => ({
      id: i.id,
      clientMessageId: i.clientMessageId,
      text: i.text,
      status: i.status,
      failureReason: i.failureReason,
      createdAt: i.createdAt,
      updatedAt: i.updatedAt,
    }));
  }

  // Broadcasts the snapshot, then prunes finished items.
  private emit(): void {
    this.onSnapshot(this.snapshot());
    // Terminal items ride exactly one snapshot, then drop out.
    for (let n = this.items.length - 1; n >= 0; n--) {
      const s = this.items[n].status;
      if (s === 'delivered' || s === 'cancelled') this.items.splice(n, 1);
    }
  }

  // Delivers the next queued item, then loops until empty.
  private async drainSoon(): Promise<void> {
    if (this.busy) return;
    const next = this.items.find((i) => i.status === 'queued');
    if (!next) return;
    this.busy = true;
    next.status = 'delivering';
    next.updatedAt = this.now();
    this.emit();
    try {
      await this.deliver({ id: next.id, clientMessageId: next.clientMessageId, text: next.text, agentEnvelope: next.agentEnvelope });
      next.status = 'delivered';
      next.failureReason = null;
    } catch (err) {
      next.status = 'failed';
      next.failureReason = err instanceof Error ? err.message : String(err);
    }
    next.updatedAt = this.now();
    this.emit();
    this.busy = false;
    void this.drainSoon();
  }
}
