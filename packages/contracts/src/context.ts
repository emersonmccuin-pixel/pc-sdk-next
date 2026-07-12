// Provider-neutral per-session context observation contracts.
// Native category/path/tool details and rounded provider percentages stay in
// runtime adapters; browser consumers receive only bounded canonical truth.

export const CONTEXT_AVAILABLE_CONFIDENCES = [
  'exact',
  'derived',
  'approximate',
] as const;

export type ContextAvailableConfidence =
  (typeof CONTEXT_AVAILABLE_CONFIDENCES)[number];

export const CONTEXT_UNAVAILABLE_REASONS = [
  'unsupported',
  'runtime-unavailable',
  'invalid-observation',
  'observation-timeout',
] as const;

export type ContextUnavailableReason =
  (typeof CONTEXT_UNAVAILABLE_REASONS)[number];

export type ContextObservation =
  | {
      confidence: ContextAvailableConfidence;
      usedTokens: number;
      usableTokens: number;
      contextWindowTokens: number;
    }
  | {
      confidence: 'unavailable';
      reason: ContextUnavailableReason;
    };

export type ContextObservationCapability =
  | {
      status: 'supported';
      confidences: ContextAvailableConfidence[];
    }
  | { status: 'unsupported'; code: string }
  | { status: 'unavailable'; code: string };

export type ContextCompactionCapability =
  | { status: 'supported' }
  | { status: 'unsupported'; code: string }
  | { status: 'unavailable'; code: string };

export interface RuntimeContextCapabilities {
  currentUse: ContextObservationCapability;
  compaction: ContextCompactionCapability;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function hasOnlyKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  const allowed = new Set(keys);
  return Object.keys(value).every((key) => allowed.has(key));
}

function exactNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0 && value === value.trim();
}

function nonNegativeSafeInteger(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) >= 0;
}

function positiveSafeInteger(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) > 0;
}

export function isContextAvailableConfidence(
  value: unknown,
): value is ContextAvailableConfidence {
  return typeof value === 'string' &&
    (CONTEXT_AVAILABLE_CONFIDENCES as readonly string[]).includes(value);
}

export function isContextUnavailableReason(
  value: unknown,
): value is ContextUnavailableReason {
  return typeof value === 'string' &&
    (CONTEXT_UNAVAILABLE_REASONS as readonly string[]).includes(value);
}

export function isContextObservation(value: unknown): value is ContextObservation {
  if (!isRecord(value)) return false;
  if (value.confidence === 'unavailable') {
    return hasOnlyKeys(value, ['confidence', 'reason']) &&
      isContextUnavailableReason(value.reason);
  }
  return (
    hasOnlyKeys(value, [
      'confidence',
      'usedTokens',
      'usableTokens',
      'contextWindowTokens',
    ]) &&
    isContextAvailableConfidence(value.confidence) &&
    nonNegativeSafeInteger(value.usedTokens) &&
    positiveSafeInteger(value.usableTokens) &&
    positiveSafeInteger(value.contextWindowTokens) &&
    value.usedTokens <= value.usableTokens &&
    value.usableTokens <= value.contextWindowTokens
  );
}

function isNegativeCapability(value: Record<string, unknown>): boolean {
  return (
    (value.status === 'unsupported' || value.status === 'unavailable') &&
    hasOnlyKeys(value, ['status', 'code']) &&
    exactNonEmptyString(value.code)
  );
}

export function isContextObservationCapability(
  value: unknown,
): value is ContextObservationCapability {
  if (!isRecord(value)) return false;
  if (value.status !== 'supported') return isNegativeCapability(value);
  return (
    hasOnlyKeys(value, ['status', 'confidences']) &&
    Array.isArray(value.confidences) &&
    value.confidences.length > 0 &&
    value.confidences.every(isContextAvailableConfidence) &&
    new Set(value.confidences).size === value.confidences.length
  );
}

export function isContextCompactionCapability(
  value: unknown,
): value is ContextCompactionCapability {
  if (!isRecord(value)) return false;
  if (value.status === 'supported') return hasOnlyKeys(value, ['status']);
  return isNegativeCapability(value);
}

export function isRuntimeContextCapabilities(
  value: unknown,
): value is RuntimeContextCapabilities {
  return (
    isRecord(value) &&
    hasOnlyKeys(value, ['currentUse', 'compaction']) &&
    isContextObservationCapability(value.currentUse) &&
    isContextCompactionCapability(value.compaction)
  );
}
