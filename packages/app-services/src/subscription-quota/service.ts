import {
  isSubscriptionQuotaObservationBatch,
  isSubscriptionQuotaSnapshot,
  subscriptionQuotaStaleAt,
  SUBSCRIPTION_QUOTA_FRESH_MS,
  type SubscriptionQuotaObservation,
  type SubscriptionQuotaObservationBatch,
  type SubscriptionQuotaSnapshot,
  type SubscriptionQuotaSourceObservation,
} from '@pc/contracts';
import {
  getDb,
  getSubscriptionQuotaSnapshotInDb,
  insertLiveEvent,
  insertSubscriptionQuotaSnapshotInDb,
  listSubscriptionQuotaSnapshotsInDb,
  newId,
  updateSubscriptionQuotaSnapshotInDb,
  type DbExecutor,
  type InsertLiveEventDraft,
  type LiveOutboxEvent,
} from '@pc/db';
import type { ULID as DomainULID } from '@pc/domain';

export { SUBSCRIPTION_QUOTA_FRESH_MS } from '@pc/contracts';

export interface SubscriptionQuotaPublication {
  snapshot: SubscriptionQuotaSnapshot;
  liveEvent: LiveOutboxEvent<SubscriptionQuotaSnapshot>;
}

export class InvalidSubscriptionQuotaBatchError extends Error {
  constructor() {
    super('invalid subscription quota observation batch');
    this.name = 'InvalidSubscriptionQuotaBatchError';
  }
}

export class OlderSubscriptionQuotaObservationError extends Error {
  readonly observedAt: number;
  readonly currentObservedAt: number;

  constructor(observedAt: number, currentObservedAt: number) {
    super(`older subscription quota observation: ${observedAt} < ${currentObservedAt}`);
    this.name = 'OlderSubscriptionQuotaObservationError';
    this.observedAt = observedAt;
    this.currentObservedAt = currentObservedAt;
  }
}

export class FutureSubscriptionQuotaObservationError extends Error {
  readonly observedAt: number;
  readonly receivedAt: number;

  constructor(observedAt: number, receivedAt: number) {
    super(`future subscription quota observation: ${observedAt} > ${receivedAt}`);
    this.name = 'FutureSubscriptionQuotaObservationError';
    this.observedAt = observedAt;
    this.receivedAt = receivedAt;
  }
}

export function buildSubscriptionQuotaChangedDraft(
  snapshot: SubscriptionQuotaSnapshot,
): InsertLiveEventDraft<SubscriptionQuotaSnapshot> {
  if (!isSubscriptionQuotaSnapshot(snapshot)) {
    throw new Error('invalid subscription quota publication snapshot');
  }
  return {
    scope: 'global',
    projectId: null,
    type: 'subscription-quota.changed',
    entity: 'subscription-quota',
    entityId: snapshot.id as DomainULID,
    version: snapshot.revision,
    payload: snapshot,
  };
}

export interface SubscriptionQuotaServiceDeps {
  transaction?: <T>(fn: (tx: DbExecutor) => T) => T;
  getSnapshot?: typeof getSubscriptionQuotaSnapshotInDb;
  listSnapshots?: typeof listSubscriptionQuotaSnapshotsInDb;
  insertSnapshot?: typeof insertSubscriptionQuotaSnapshotInDb;
  updateSnapshot?: typeof updateSubscriptionQuotaSnapshotInDb;
  insertLiveEvent?: typeof insertLiveEvent;
  newId?: typeof newId;
  now?: () => number;
}

export class SubscriptionQuotaService {
  private readonly tx: <T>(fn: (tx: DbExecutor) => T) => T;
  private readonly getSnapshotInDb: typeof getSubscriptionQuotaSnapshotInDb;
  private readonly listSnapshotsInDb: typeof listSubscriptionQuotaSnapshotsInDb;
  private readonly insertSnapshotInDb: typeof insertSubscriptionQuotaSnapshotInDb;
  private readonly updateSnapshotInDb: typeof updateSubscriptionQuotaSnapshotInDb;
  private readonly insert: typeof insertLiveEvent;
  private readonly mintId: typeof newId;
  private readonly now: () => number;

  constructor(deps: SubscriptionQuotaServiceDeps = {}) {
    this.tx = deps.transaction ?? ((fn) => getDb().transaction(fn));
    this.getSnapshotInDb = deps.getSnapshot ?? getSubscriptionQuotaSnapshotInDb;
    this.listSnapshotsInDb = deps.listSnapshots ?? listSubscriptionQuotaSnapshotsInDb;
    this.insertSnapshotInDb = deps.insertSnapshot ?? insertSubscriptionQuotaSnapshotInDb;
    this.updateSnapshotInDb = deps.updateSnapshot ?? updateSubscriptionQuotaSnapshotInDb;
    this.insert = deps.insertLiveEvent ?? insertLiveEvent;
    this.mintId = deps.newId ?? newId;
    this.now = deps.now ?? Date.now;
  }

  get(runtimeId: string, accountId: string): SubscriptionQuotaSnapshot | null {
    return this.getSnapshotInDb(getDb(), runtimeId, accountId);
  }

  list(): SubscriptionQuotaSnapshot[] {
    return this.listSnapshotsInDb(getDb());
  }

  /** Normalize one exact runtime/account observation and atomically commit the
   * current-state row plus its full-snapshot resource event. */
  record(batch: SubscriptionQuotaObservationBatch): SubscriptionQuotaPublication {
    if (!isSubscriptionQuotaObservationBatch(batch)) {
      throw new InvalidSubscriptionQuotaBatchError();
    }
    const receivedAt = this.now();
    if (!Number.isSafeInteger(receivedAt) || receivedAt < 0) {
      throw new Error('subscription quota receipt clock is invalid');
    }
    if (batch.observedAt > receivedAt) {
      throw new FutureSubscriptionQuotaObservationError(batch.observedAt, receivedAt);
    }
    return this.tx((tx) => {
      const current = this.getSnapshotInDb(tx, batch.runtimeId, batch.accountId);
      if (current && batch.observedAt < current.observedAt) {
        throw new OlderSubscriptionQuotaObservationError(
          batch.observedAt,
          current.observedAt,
        );
      }
      const snapshot = buildNextSnapshot(batch, current, this.mintId);
      const persisted = current
        ? this.updateSnapshotInDb(tx, snapshot, current.revision)
        : this.insertSnapshotInDb(tx, snapshot);
      const liveEvent = this.insert(tx, buildSubscriptionQuotaChangedDraft(persisted));
      return { snapshot: persisted, liveEvent };
    });
  }
}

export function buildNextSnapshot(
  batch: SubscriptionQuotaObservationBatch,
  current: SubscriptionQuotaSnapshot | null,
  mintId: typeof newId = newId,
): SubscriptionQuotaSnapshot {
  if (!isSubscriptionQuotaObservationBatch(batch)) {
    throw new InvalidSubscriptionQuotaBatchError();
  }
  if (current && batch.observedAt < current.observedAt) {
    throw new OlderSubscriptionQuotaObservationError(batch.observedAt, current.observedAt);
  }
  const revision = current ? nextRevision(current.revision) : 1;
  const observations = batch.availability === 'unavailable'
    ? cloneObservations(current?.observations ?? [])
    : mergeAvailableObservations(batch, current?.observations ?? []);
  const snapshot: SubscriptionQuotaSnapshot = {
    id: current?.id ?? mintId(),
    runtimeId: batch.runtimeId,
    accountId: batch.accountId,
    revision,
    availability: batch.availability,
    unavailableReason: batch.availability === 'unavailable' ? batch.reason : null,
    observedAt: batch.observedAt,
    observations,
  };
  if (!isSubscriptionQuotaSnapshot(snapshot)) {
    throw new Error('subscription quota normalization produced an invalid snapshot');
  }
  return snapshot;
}

function mergeAvailableObservations(
  batch: Extract<SubscriptionQuotaObservationBatch, { availability: 'available' }>,
  current: readonly SubscriptionQuotaObservation[],
): SubscriptionQuotaObservation[] {
  const merged = new Map<string, SubscriptionQuotaObservation>();
  if (batch.coverage === 'partial') {
    for (const observation of current) {
      merged.set(observation.window.id, cloneObservation(observation));
    }
  }
  for (const observation of batch.observations) {
    merged.set(observation.window.id, normalizeObservation(observation, batch.observedAt));
  }
  return [...merged.values()].sort((a, b) => a.window.id.localeCompare(b.window.id));
}

function normalizeObservation(
  observation: SubscriptionQuotaSourceObservation,
  observedAt: number,
): SubscriptionQuotaObservation {
  const usedFraction = observation.source.semantics === 'used'
    ? observation.source.fraction
    : 1 - observation.source.fraction;
  return {
    window: { ...observation.window },
    scope: observation.scope.kind === 'account'
      ? { kind: 'account' }
      : { kind: 'model', model: observation.scope.model },
    source: { ...observation.source },
    usedFraction,
    confidence: observation.source.semantics === 'remaining' && observation.confidence === 'exact'
      ? 'derived'
      : observation.confidence,
    limitState: observation.limitState,
    resetsAt: observation.resetsAt,
    observedAt,
    staleAt: subscriptionQuotaStaleAt(observedAt, observation.resetsAt),
  };
}

function nextRevision(revision: number): number {
  if (!Number.isSafeInteger(revision) || revision < 1 || revision >= Number.MAX_SAFE_INTEGER) {
    throw new Error('subscription quota revision exhausted');
  }
  return revision + 1;
}

function cloneObservations(
  observations: readonly SubscriptionQuotaObservation[],
): SubscriptionQuotaObservation[] {
  return observations.map(cloneObservation);
}

function cloneObservation(
  observation: SubscriptionQuotaObservation,
): SubscriptionQuotaObservation {
  return {
    window: { ...observation.window },
    scope: observation.scope.kind === 'account'
      ? { kind: 'account' }
      : { kind: 'model', model: observation.scope.model },
    source: { ...observation.source },
    usedFraction: observation.usedFraction,
    confidence: observation.confidence,
    limitState: observation.limitState,
    resetsAt: observation.resetsAt,
    observedAt: observation.observedAt,
    staleAt: observation.staleAt,
  };
}
