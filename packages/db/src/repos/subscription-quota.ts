import { and, asc, eq } from 'drizzle-orm';
import {
  isSubscriptionQuotaSnapshot,
  type SubscriptionQuotaSnapshot,
  type SubscriptionQuotaUnavailableReason,
} from '@pc/contracts';
import type { ULID as DomainULID } from '@pc/domain';
import { getDb, type DbExecutor } from '../connection.ts';
import { subscriptionQuota } from '../schema.ts';

export interface SubscriptionQuotaRow {
  id: SubscriptionQuotaSnapshot['id'];
  runtimeId: string;
  accountId: string;
  revision: number;
  availability: 'available' | 'unavailable';
  unavailableReason: SubscriptionQuotaUnavailableReason | null;
  observedAt: number;
  snapshot: SubscriptionQuotaSnapshot;
}

export class SubscriptionQuotaRevisionConflictError extends Error {
  constructor(id: string, expectedRevision: number) {
    super(`subscription quota revision conflict: ${id}@${expectedRevision}`);
    this.name = 'SubscriptionQuotaRevisionConflictError';
  }
}

export function getSubscriptionQuotaSnapshotInDb(
  db: DbExecutor,
  runtimeId: string,
  accountId: string,
): SubscriptionQuotaSnapshot | null {
  const row = db
    .select()
    .from(subscriptionQuota)
    .where(and(
      eq(subscriptionQuota.runtimeId, runtimeId),
      eq(subscriptionQuota.accountId, accountId),
    ))
    .limit(1)
    .get();
  return row ? rowToQuota(row).snapshot : null;
}

export function getSubscriptionQuotaSnapshot(
  runtimeId: string,
  accountId: string,
): SubscriptionQuotaSnapshot | null {
  return getSubscriptionQuotaSnapshotInDb(getDb(), runtimeId, accountId);
}

export function listSubscriptionQuotaSnapshotsInDb(
  db: DbExecutor,
): SubscriptionQuotaSnapshot[] {
  return db
    .select()
    .from(subscriptionQuota)
    .orderBy(asc(subscriptionQuota.runtimeId), asc(subscriptionQuota.accountId))
    .all()
    .map((row) => rowToQuota(row).snapshot);
}

export function listSubscriptionQuotaSnapshots(): SubscriptionQuotaSnapshot[] {
  return listSubscriptionQuotaSnapshotsInDb(getDb());
}

export function insertSubscriptionQuotaSnapshotInDb(
  db: DbExecutor,
  snapshot: SubscriptionQuotaSnapshot,
): SubscriptionQuotaSnapshot {
  assertSnapshot(snapshot);
  if (snapshot.revision !== 1) {
    throw new SubscriptionQuotaRevisionConflictError(snapshot.id, 0);
  }
  db.insert(subscriptionQuota).values(toValues(snapshot)).run();
  const written = getSubscriptionQuotaSnapshotInDb(
    db,
    snapshot.runtimeId,
    snapshot.accountId,
  );
  if (!written) throw new Error(`subscription quota insert disappeared: ${snapshot.id}`);
  return written;
}

export function updateSubscriptionQuotaSnapshotInDb(
  db: DbExecutor,
  snapshot: SubscriptionQuotaSnapshot,
  expectedRevision: number,
): SubscriptionQuotaSnapshot {
  assertSnapshot(snapshot);
  if (snapshot.revision !== expectedRevision + 1) {
    throw new SubscriptionQuotaRevisionConflictError(snapshot.id, expectedRevision);
  }
  const result = db
    .update(subscriptionQuota)
    .set({
      revision: snapshot.revision,
      availability: snapshot.availability,
      unavailableReason: snapshot.unavailableReason,
      observedAt: snapshot.observedAt,
      snapshot,
    })
    .where(and(
      eq(subscriptionQuota.id, snapshot.id as DomainULID),
      eq(subscriptionQuota.runtimeId, snapshot.runtimeId),
      eq(subscriptionQuota.accountId, snapshot.accountId),
      eq(subscriptionQuota.revision, expectedRevision),
    ))
    .run();
  if (Number(result.changes ?? 0) !== 1) {
    throw new SubscriptionQuotaRevisionConflictError(snapshot.id, expectedRevision);
  }
  const written = getSubscriptionQuotaSnapshotInDb(
    db,
    snapshot.runtimeId,
    snapshot.accountId,
  );
  if (!written) throw new Error(`subscription quota update disappeared: ${snapshot.id}`);
  return written;
}

function assertSnapshot(snapshot: SubscriptionQuotaSnapshot): void {
  if (!isSubscriptionQuotaSnapshot(snapshot)) {
    throw new Error('invalid subscription quota snapshot');
  }
}

function toValues(snapshot: SubscriptionQuotaSnapshot) {
  return {
    id: snapshot.id as DomainULID,
    runtimeId: snapshot.runtimeId,
    accountId: snapshot.accountId,
    revision: snapshot.revision,
    availability: snapshot.availability,
    unavailableReason: snapshot.unavailableReason,
    observedAt: snapshot.observedAt,
    snapshot,
  };
}

function rowToQuota(
  row: typeof subscriptionQuota.$inferSelect,
): SubscriptionQuotaRow {
  if (!isSubscriptionQuotaSnapshot(row.snapshot)) {
    throw new Error(`invalid durable subscription quota snapshot: ${row.id}`);
  }
  if (
    row.snapshot.id !== row.id ||
    row.snapshot.runtimeId !== row.runtimeId ||
    row.snapshot.accountId !== row.accountId ||
    row.snapshot.revision !== row.revision ||
    row.snapshot.availability !== row.availability ||
    row.snapshot.unavailableReason !== row.unavailableReason ||
    row.snapshot.observedAt !== row.observedAt
  ) {
    throw new Error(`subscription quota scalar/snapshot mismatch: ${row.id}`);
  }
  return {
    id: row.id,
    runtimeId: row.runtimeId,
    accountId: row.accountId,
    revision: row.revision,
    availability: row.availability,
    unavailableReason: row.unavailableReason,
    observedAt: row.observedAt,
    snapshot: row.snapshot,
  };
}
