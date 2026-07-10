// Send-queue — serializes user turns while the orchestrator is busy.
//
// Every send lands here. One turn is delivered at a time (FIFO); sends arriving
// mid-turn queue and drain in order. Statuses follow the contract
// (docs/event-contract.md §Send path): queued → delivering → delivered, or
// failed / cancelled. Snapshot replaces snapshot (no per-item deltas); a
// `delivered` item rides exactly one snapshot then is pruned.

import { newId } from '@pc/db';
import type { SendQueueItem, SendQueueItemStatus, ULID } from '@pc/contracts';

interface QueueItem {
  id: ULID;
  clientMessageId: string;
  text: string;
  status: SendQueueItemStatus;
  failureReason: string | null;
  createdAt: number;
  updatedAt: number;
}

export interface SendQueueDeps {
  /** Deliver one turn. Resolves when the turn reached the model + ran to its
   *  terminal; rejects only on a delivery-infrastructure failure (backend won't
   *  start) — a model-side turn error is still a successful delivery. */
  deliver: (item: { id: ULID; clientMessageId: string; text: string }) => Promise<void>;
  /** Broadcast the current snapshot to the room. */
  onSnapshot: (items: SendQueueItem[]) => void;
  now?: () => number;
}

export class SendQueue {
  private readonly items: QueueItem[] = [];
  private readonly deliver: SendQueueDeps['deliver'];
  private readonly onSnapshot: SendQueueDeps['onSnapshot'];
  private readonly now: () => number;
  private busy = false;

  constructor(deps: SendQueueDeps) {
    this.deliver = deps.deliver;
    this.onSnapshot = deps.onSnapshot;
    this.now = deps.now ?? Date.now;
  }

  /** Enqueue a send. Returns whether it will run immediately (queue was idle) —
   *  the caller maps that to the `received` vs `queued` send-ack status. */
  enqueue(text: string, clientMessageId: string): { id: ULID; ranImmediately: boolean } {
    const ranImmediately = !this.busy && this.pendingCount === 0;
    const t = this.now();
    const item: QueueItem = {
      id: newId(),
      clientMessageId,
      text,
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

  get queueDepth(): number {
    return this.items.filter((i) => i.status === 'queued').length;
  }

  get isBusy(): boolean {
    return this.busy;
  }

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

  private emit(): void {
    this.onSnapshot(this.snapshot());
    // Terminal items ride exactly one snapshot, then drop out.
    for (let n = this.items.length - 1; n >= 0; n--) {
      const s = this.items[n].status;
      if (s === 'delivered' || s === 'cancelled') this.items.splice(n, 1);
    }
  }

  private async drainSoon(): Promise<void> {
    if (this.busy) return;
    const next = this.items.find((i) => i.status === 'queued');
    if (!next) return;
    this.busy = true;
    next.status = 'delivering';
    next.updatedAt = this.now();
    this.emit();
    try {
      await this.deliver({ id: next.id, clientMessageId: next.clientMessageId, text: next.text });
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
