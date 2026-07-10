// Usage cache — per-account subscription-quota state. Fed by the runner's
// `rate_limit_event`s (via SessionService.onRateLimit); merges the 5-hour /
// 7-day windows per account (each event carries one window) and emits a durable
// `usage` resource event through live_outbox so the meter survives reconnects
// (the old statusline-snapshot's "stale caps forever" wart dies here). A
// `status: 'rejected' | 'allowed_warning'` is the premortem tripwire — it rides
// the durable channel loudly.

import { getDb, insertLiveEvent } from '@pc/db';
import type { UsageSnapshot } from '@pc/contracts';
import type { ULID } from '@pc/domain';

export class UsageCache {
  private readonly byAccount = new Map<string, UsageSnapshot>();

  /** Merge one (possibly partial) snapshot and emit the durable resource event.
   *  Windows absent from the incoming snapshot keep their prior value. */
  record(incoming: UsageSnapshot): UsageSnapshot {
    const prev = this.byAccount.get(incoming.accountId);
    const merged: UsageSnapshot = {
      accountId: incoming.accountId,
      fiveHour: incoming.fiveHour ?? prev?.fiveHour ?? null,
      sevenDay: incoming.sevenDay ?? prev?.sevenDay ?? null,
      status: incoming.status,
      model: incoming.model ?? prev?.model ?? null,
      updatedAt: incoming.updatedAt,
    };
    this.byAccount.set(merged.accountId, merged);
    this.emit(merged);
    return merged;
  }

  get(accountId: string): UsageSnapshot | null {
    return this.byAccount.get(accountId) ?? null;
  }

  list(): UsageSnapshot[] {
    return [...this.byAccount.values()];
  }

  private emit(snapshot: UsageSnapshot): void {
    try {
      insertLiveEvent(getDb(), {
        scope: 'global',
        projectId: null,
        type: 'usage.changed',
        entity: 'usage',
        // Per-account dedup key. Runtime is a text column; the ULID brand is
        // compile-time only — the account id is a stable, meaningful key.
        entityId: snapshot.accountId as unknown as ULID,
        version: null, // last-write-wins by cursor
        payload: snapshot,
      });
    } catch (err) {
      console.warn('[pc-sdk][usage] emit failed:', err instanceof Error ? err.message : err);
    }
  }
}
