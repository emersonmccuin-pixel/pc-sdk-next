// Provider-neutral subscription-quota contracts.
//
// Runtime adapters report source observations. PC-SDK derives the authoritative
// used fraction, freshness deadline, durable identity, and revision. Per-turn
// token usage and per-session context are intentionally separate contracts.

import { isUlid, type ULID } from './shared.ts';

export const SUBSCRIPTION_QUOTA_SOURCE_SEMANTICS = ['used', 'remaining'] as const;
export type SubscriptionQuotaSourceSemantics =
  (typeof SUBSCRIPTION_QUOTA_SOURCE_SEMANTICS)[number];

export const SUBSCRIPTION_QUOTA_CONFIDENCES = [
  'exact',
  'derived',
  'approximate',
] as const;
export type SubscriptionQuotaConfidence =
  (typeof SUBSCRIPTION_QUOTA_CONFIDENCES)[number];

export const SUBSCRIPTION_QUOTA_LIMIT_STATES = [
  'allowed',
  'warning',
  'rejected',
  'unknown',
] as const;
export type SubscriptionQuotaLimitState =
  (typeof SUBSCRIPTION_QUOTA_LIMIT_STATES)[number];

export const SUBSCRIPTION_QUOTA_UNAVAILABLE_REASONS = [
  'unsupported',
  'not-applicable',
  'account-unavailable',
  'runtime-unavailable',
  'invalid-observation',
  'observation-timeout',
] as const;
export type SubscriptionQuotaUnavailableReason =
  (typeof SUBSCRIPTION_QUOTA_UNAVAILABLE_REASONS)[number];

export const SUBSCRIPTION_QUOTA_MAX_OBSERVATIONS = 64;
export const SUBSCRIPTION_QUOTA_FRESH_MS = 10 * 60_000;

export type SubscriptionQuotaScope =
  | { kind: 'account' }
  | { kind: 'model'; model: string };

export interface SubscriptionQuotaWindowDescriptor {
  /** Stable adapter-issued bucket identity within one runtime/account. */
  id: string;
  /** Safe user-facing label; provider-native wrapper keys never cross. */
  label: string;
  /** Known window duration, or null when the runtime does not disclose it. */
  durationMs: number | null;
}

export interface SubscriptionQuotaSource {
  semantics: SubscriptionQuotaSourceSemantics;
  /** Native meaning normalized to 0..1; PC-SDK derives `usedFraction`. */
  fraction: number;
}

/** One strict adapter observation. It cannot author usedFraction/staleness. */
export interface SubscriptionQuotaSourceObservation {
  window: SubscriptionQuotaWindowDescriptor;
  scope: SubscriptionQuotaScope;
  source: SubscriptionQuotaSource;
  confidence: Exclude<SubscriptionQuotaConfidence, 'derived'>;
  limitState: SubscriptionQuotaLimitState;
  resetsAt: number | null;
}

export type SubscriptionQuotaObservationBatch =
  | {
      runtimeId: string;
      accountId: string;
      availability: 'available';
      /** Partial preserves omitted buckets; complete positively removes them. */
      coverage: 'partial' | 'complete';
      observedAt: number;
      observations: SubscriptionQuotaSourceObservation[];
    }
  | {
      runtimeId: string;
      accountId: string;
      availability: 'unavailable';
      reason: SubscriptionQuotaUnavailableReason;
      observedAt: number;
    };

/** Durable app-owned observation after normalization and freshness policy. */
export interface SubscriptionQuotaObservation
  extends Omit<SubscriptionQuotaSourceObservation, 'confidence'> {
  usedFraction: number;
  observedAt: number;
  staleAt: number;
  confidence: SubscriptionQuotaConfidence;
}

/** Full current-state resource for one exact runtime/account. */
export interface SubscriptionQuotaSnapshot {
  id: ULID;
  runtimeId: string;
  accountId: string;
  revision: number;
  availability: 'available' | 'unavailable';
  unavailableReason: SubscriptionQuotaUnavailableReason | null;
  /** Latest attempted observation time; individual windows retain their own. */
  observedAt: number;
  observations: SubscriptionQuotaObservation[];
}

export interface SubscriptionQuotaListResponse {
  ok: true;
  snapshots: SubscriptionQuotaSnapshot[];
}

export type SubscriptionQuotaCapability =
  | {
      status: 'supported';
      sourceSemantics: SubscriptionQuotaSourceSemantics[];
      confidences: Array<Exclude<SubscriptionQuotaConfidence, 'derived'>>;
    }
  | { status: 'unsupported'; code: string }
  | { status: 'unavailable'; code: string };

const MAX_IDENTITY_LENGTH = 200;
const MAX_LABEL_LENGTH = 100;
const PRINTABLE_ASCII = /^[\x21-\x7e](?:[\x20-\x7e]*[\x21-\x7e])?$/;

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function hasOnlyKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  const allowed = new Set(keys);
  return Object.keys(value).every((key) => allowed.has(key));
}

function canonicalString(value: unknown, max = MAX_IDENTITY_LENGTH): value is string {
  return typeof value === 'string' &&
    value.length > 0 &&
    value.length <= max &&
    PRINTABLE_ASCII.test(value);
}

/** Runtime/account identity domain shared with adapter registries and SQLite. */
export function isSubscriptionQuotaIdentity(value: unknown): value is string {
  return canonicalString(value);
}

function safeTimestamp(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) >= 0;
}

function positiveSafeInteger(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) > 0;
}

function fraction(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= 1;
}

function isSourceSemantics(value: unknown): value is SubscriptionQuotaSourceSemantics {
  return typeof value === 'string' &&
    (SUBSCRIPTION_QUOTA_SOURCE_SEMANTICS as readonly string[]).includes(value);
}

function isSourceConfidence(
  value: unknown,
): value is Exclude<SubscriptionQuotaConfidence, 'derived'> {
  return value === 'exact' || value === 'approximate';
}

export function isSubscriptionQuotaConfidence(
  value: unknown,
): value is SubscriptionQuotaConfidence {
  return typeof value === 'string' &&
    (SUBSCRIPTION_QUOTA_CONFIDENCES as readonly string[]).includes(value);
}

export function isSubscriptionQuotaLimitState(
  value: unknown,
): value is SubscriptionQuotaLimitState {
  return typeof value === 'string' &&
    (SUBSCRIPTION_QUOTA_LIMIT_STATES as readonly string[]).includes(value);
}

export function isSubscriptionQuotaUnavailableReason(
  value: unknown,
): value is SubscriptionQuotaUnavailableReason {
  return typeof value === 'string' &&
    (SUBSCRIPTION_QUOTA_UNAVAILABLE_REASONS as readonly string[]).includes(value);
}

export function isSubscriptionQuotaScope(value: unknown): value is SubscriptionQuotaScope {
  if (!isRecord(value)) return false;
  if (value.kind === 'account') return hasOnlyKeys(value, ['kind']);
  return value.kind === 'model' &&
    hasOnlyKeys(value, ['kind', 'model']) &&
    canonicalString(value.model, MAX_LABEL_LENGTH);
}

export function isSubscriptionQuotaWindowDescriptor(
  value: unknown,
): value is SubscriptionQuotaWindowDescriptor {
  return isRecord(value) &&
    hasOnlyKeys(value, ['id', 'label', 'durationMs']) &&
    canonicalString(value.id) &&
    canonicalString(value.label, MAX_LABEL_LENGTH) &&
    (value.durationMs === null || positiveSafeInteger(value.durationMs));
}

export function isSubscriptionQuotaSource(value: unknown): value is SubscriptionQuotaSource {
  return isRecord(value) &&
    hasOnlyKeys(value, ['semantics', 'fraction']) &&
    isSourceSemantics(value.semantics) &&
    fraction(value.fraction);
}

export function isSubscriptionQuotaSourceObservation(
  value: unknown,
): value is SubscriptionQuotaSourceObservation {
  return isRecord(value) &&
    hasOnlyKeys(value, [
      'window',
      'scope',
      'source',
      'confidence',
      'limitState',
      'resetsAt',
    ]) &&
    isSubscriptionQuotaWindowDescriptor(value.window) &&
    isSubscriptionQuotaScope(value.scope) &&
    isSubscriptionQuotaSource(value.source) &&
    isSourceConfidence(value.confidence) &&
    isSubscriptionQuotaLimitState(value.limitState) &&
    (value.resetsAt === null || safeTimestamp(value.resetsAt));
}

export function isSubscriptionQuotaObservationBatch(
  value: unknown,
): value is SubscriptionQuotaObservationBatch {
  if (
    !isRecord(value) ||
    !isSubscriptionQuotaIdentity(value.runtimeId) ||
    !isSubscriptionQuotaIdentity(value.accountId) ||
    !safeTimestamp(value.observedAt)
  ) return false;
  if (value.availability === 'unavailable') {
    return hasOnlyKeys(value, [
      'runtimeId',
      'accountId',
      'availability',
      'reason',
      'observedAt',
    ]) && isSubscriptionQuotaUnavailableReason(value.reason);
  }
  if (
    value.availability !== 'available' ||
    !hasOnlyKeys(value, [
      'runtimeId',
      'accountId',
      'availability',
      'coverage',
      'observedAt',
      'observations',
    ]) ||
    (value.coverage !== 'partial' && value.coverage !== 'complete') ||
    !Array.isArray(value.observations) ||
    value.observations.length > SUBSCRIPTION_QUOTA_MAX_OBSERVATIONS ||
    !value.observations.every(isSubscriptionQuotaSourceObservation) ||
    (value.coverage === 'partial' && value.observations.length === 0)
  ) return false;
  return new Set(value.observations.map((item) => item.window.id)).size ===
    value.observations.length;
}

function expectedUsedFraction(source: SubscriptionQuotaSource): number {
  return source.semantics === 'used' ? source.fraction : 1 - source.fraction;
}

function fractionsEqual(a: number, b: number): boolean {
  return a === b;
}

export function isSubscriptionQuotaObservation(
  value: unknown,
): value is SubscriptionQuotaObservation {
  if (
    !isRecord(value) ||
    !hasOnlyKeys(value, [
      'window',
      'scope',
      'source',
      'usedFraction',
      'confidence',
      'limitState',
      'resetsAt',
      'observedAt',
      'staleAt',
    ]) ||
    !isSubscriptionQuotaWindowDescriptor(value.window) ||
    !isSubscriptionQuotaScope(value.scope) ||
    !isSubscriptionQuotaSource(value.source) ||
    !fraction(value.usedFraction) ||
    !isSubscriptionQuotaConfidence(value.confidence) ||
    !isSubscriptionQuotaLimitState(value.limitState) ||
    (value.resetsAt !== null && !safeTimestamp(value.resetsAt)) ||
    !safeTimestamp(value.observedAt) ||
    !safeTimestamp(value.staleAt) ||
    value.staleAt !== subscriptionQuotaStaleAt(
      value.observedAt as number,
      value.resetsAt as number | null,
    ) ||
    !fractionsEqual(value.usedFraction, expectedUsedFraction(value.source))
  ) return false;
  if (
    (value.source.semantics === 'remaining' && value.confidence === 'exact') ||
    (value.source.semantics === 'used' && value.confidence === 'derived')
  ) return false;
  return true;
}

export function isSubscriptionQuotaSnapshot(
  value: unknown,
): value is SubscriptionQuotaSnapshot {
  if (
    !isRecord(value) ||
    !hasOnlyKeys(value, [
      'id',
      'runtimeId',
      'accountId',
      'revision',
      'availability',
      'unavailableReason',
      'observedAt',
      'observations',
    ]) ||
    !isUlid(value.id) ||
    !isSubscriptionQuotaIdentity(value.runtimeId) ||
    !isSubscriptionQuotaIdentity(value.accountId) ||
    !positiveSafeInteger(value.revision) ||
    !safeTimestamp(value.observedAt) ||
    !Array.isArray(value.observations) ||
    value.observations.length > SUBSCRIPTION_QUOTA_MAX_OBSERVATIONS ||
    !value.observations.every(isSubscriptionQuotaObservation) ||
    new Set(value.observations.map((item) => item.window.id)).size !==
      value.observations.length ||
    value.observations.some((item) => item.observedAt > (value.observedAt as number))
  ) return false;
  if (value.availability === 'available') {
    return value.unavailableReason === null;
  }
  return value.availability === 'unavailable' &&
    isSubscriptionQuotaUnavailableReason(value.unavailableReason);
}

export function isSubscriptionQuotaListResponse(
  value: unknown,
): value is SubscriptionQuotaListResponse {
  if (
    !isRecord(value) ||
    !hasOnlyKeys(value, ['ok', 'snapshots']) ||
    value.ok !== true ||
    !Array.isArray(value.snapshots) ||
    !value.snapshots.every(isSubscriptionQuotaSnapshot)
  ) return false;
  const keys = value.snapshots.map((snapshot) =>
    subscriptionQuotaKey(snapshot.runtimeId, snapshot.accountId));
  return new Set(keys).size === keys.length &&
    new Set(value.snapshots.map((snapshot) => snapshot.id)).size === value.snapshots.length;
}

export function isSubscriptionQuotaCapability(
  value: unknown,
): value is SubscriptionQuotaCapability {
  if (!isRecord(value)) return false;
  if (value.status !== 'supported') {
    return (value.status === 'unsupported' || value.status === 'unavailable') &&
      hasOnlyKeys(value, ['status', 'code']) &&
      canonicalString(value.code);
  }
  return hasOnlyKeys(value, ['status', 'sourceSemantics', 'confidences']) &&
    Array.isArray(value.sourceSemantics) &&
    value.sourceSemantics.length > 0 &&
    value.sourceSemantics.every(isSourceSemantics) &&
    new Set(value.sourceSemantics).size === value.sourceSemantics.length &&
    Array.isArray(value.confidences) &&
    value.confidences.length > 0 &&
    value.confidences.every(isSourceConfidence) &&
    new Set(value.confidences).size === value.confidences.length;
}

/** Total collision-safe key. Length prefixes make embedded delimiters inert. */
export function subscriptionQuotaKey(runtimeId: string, accountId: string): string {
  return `${runtimeId.length}:${runtimeId}|${accountId.length}:${accountId}`;
}

export function subscriptionQuotaStaleAt(
  observedAt: number,
  resetsAt: number | null,
): number {
  const policyDeadline = observedAt > Number.MAX_SAFE_INTEGER - SUBSCRIPTION_QUOTA_FRESH_MS
    ? Number.MAX_SAFE_INTEGER
    : observedAt + SUBSCRIPTION_QUOTA_FRESH_MS;
  return Math.max(observedAt, Math.min(policyDeadline, resetsAt ?? policyDeadline));
}
