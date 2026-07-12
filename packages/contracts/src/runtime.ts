// Provider-neutral runtime selection and capability contracts.
// Browser-safe, exact-shape guarded, and intentionally free of runtime deps.

export const RUNTIME_EFFORT_SELECTION_KINDS = [
  'selected',
  'none',
  'unavailable',
] as const;

export type RuntimeEffortSelection =
  | { kind: 'selected'; value: string }
  | { kind: 'none' }
  | { kind: 'unavailable' };

/** Immutable execution selection stamped on one PC-SDK app session. */
export interface RuntimeSelection {
  runtimeId: string;
  accountId: string;
  model: string;
  effort: RuntimeEffortSelection;
}

export type RuntimeCapabilityState =
  | { status: 'supported' }
  | { status: 'unsupported'; code: string }
  | { status: 'unavailable'; code: string };

export interface RuntimeCapabilities {
  runtimeId: string;
  accountId: string;
  nativeContinuation: RuntimeCapabilityState;
  modelDiscovery: RuntimeCapabilityState;
  effortControl: RuntimeCapabilityState;
}

export type RuntimeModelEffortCapability =
  | { status: 'supported'; values: string[] }
  | { status: 'unsupported'; code: string }
  | { status: 'unavailable'; code: string };

export interface RuntimeModel {
  id: string;
  resolvedId: string | null;
  label: string;
  description: string;
  effort: RuntimeModelEffortCapability;
}

export type RuntimeModelDiscovery =
  | { status: 'available'; models: RuntimeModel[] }
  | { status: 'unsupported'; code: string }
  | { status: 'unavailable'; code: string };

export const RUNTIME_SELECTION_ERROR_CODES = [
  'runtime-not-registered',
  'account-unavailable',
  'account-runtime-mismatch',
  'capabilities-unavailable',
  'model-discovery-unsupported',
  'model-discovery-unavailable',
  'model-unsupported',
  'effort-unsupported',
  'effort-unavailable',
  'effort-value-unsupported',
  'native-resume-unsupported',
  'native-session-missing',
  'selection-unavailable',
  'native-resume-mismatch',
  'session-active',
  'resume-failed',
] as const;
export type RuntimeSelectionErrorCode = (typeof RUNTIME_SELECTION_ERROR_CODES)[number];

export type RuntimeSelectionValidation =
  | { status: 'valid'; selection: RuntimeSelection }
  | { status: 'invalid'; code: RuntimeSelectionErrorCode };

/** Positive adapter observation that a native session was created or attached. */
export interface RuntimeSessionReceipt {
  mode: 'created' | 'resumed';
  /** Exact durable attempt identity that authorized this native mint/attach. */
  continuationAttemptId: string;
  selection: RuntimeSelection;
  nativeSessionId: string;
  requestedNativeSessionId: string | null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function hasOnlyKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  const allowed = new Set(keys);
  return Object.keys(value).every((key) => allowed.has(key));
}

function nonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

function exactNonEmptyString(value: unknown): value is string {
  return nonEmptyString(value) && value === value.trim();
}

function distinctNonEmptyStrings(value: unknown): value is string[] {
  return Array.isArray(value) &&
    value.every(exactNonEmptyString) &&
    new Set(value).size === value.length;
}

export function isRuntimeEffortSelection(value: unknown): value is RuntimeEffortSelection {
  if (!isRecord(value)) return false;
  if (value.kind === 'selected') {
    return hasOnlyKeys(value, ['kind', 'value']) && exactNonEmptyString(value.value);
  }
  return (
    (value.kind === 'none' || value.kind === 'unavailable') &&
    hasOnlyKeys(value, ['kind'])
  );
}

export function isRuntimeSelection(value: unknown): value is RuntimeSelection {
  return (
    isRecord(value) &&
    hasOnlyKeys(value, ['runtimeId', 'accountId', 'model', 'effort']) &&
    exactNonEmptyString(value.runtimeId) &&
    exactNonEmptyString(value.accountId) &&
    exactNonEmptyString(value.model) &&
    isRuntimeEffortSelection(value.effort)
  );
}

export function runtimeSelectionsEqual(a: RuntimeSelection, b: RuntimeSelection): boolean {
  return a.runtimeId === b.runtimeId &&
    a.accountId === b.accountId &&
    a.model === b.model &&
    a.effort.kind === b.effort.kind &&
    (a.effort.kind !== 'selected' ||
      (b.effort.kind === 'selected' && a.effort.value === b.effort.value));
}

export function isRuntimeCapabilityState(value: unknown): value is RuntimeCapabilityState {
  if (!isRecord(value)) return false;
  if (value.status === 'supported') return hasOnlyKeys(value, ['status']);
  return (
    (value.status === 'unsupported' || value.status === 'unavailable') &&
    hasOnlyKeys(value, ['status', 'code']) &&
    nonEmptyString(value.code)
  );
}

export function isRuntimeCapabilities(value: unknown): value is RuntimeCapabilities {
  return (
    isRecord(value) &&
    hasOnlyKeys(value, [
      'runtimeId',
      'accountId',
      'nativeContinuation',
      'modelDiscovery',
      'effortControl',
    ]) &&
    exactNonEmptyString(value.runtimeId) &&
    exactNonEmptyString(value.accountId) &&
    isRuntimeCapabilityState(value.nativeContinuation) &&
    isRuntimeCapabilityState(value.modelDiscovery) &&
    isRuntimeCapabilityState(value.effortControl)
  );
}

export function isRuntimeModelEffortCapability(
  value: unknown,
): value is RuntimeModelEffortCapability {
  if (!isRecord(value)) return false;
  if (value.status === 'supported') {
    return (
      hasOnlyKeys(value, ['status', 'values']) &&
      distinctNonEmptyStrings(value.values) &&
      value.values.length > 0
    );
  }
  return (
    (value.status === 'unsupported' || value.status === 'unavailable') &&
    hasOnlyKeys(value, ['status', 'code']) &&
    nonEmptyString(value.code)
  );
}

export function isRuntimeModel(value: unknown): value is RuntimeModel {
  return (
    isRecord(value) &&
    hasOnlyKeys(value, ['id', 'resolvedId', 'label', 'description', 'effort']) &&
    exactNonEmptyString(value.id) &&
    (value.resolvedId === null || exactNonEmptyString(value.resolvedId)) &&
    nonEmptyString(value.label) &&
    typeof value.description === 'string' &&
    isRuntimeModelEffortCapability(value.effort)
  );
}

export function isRuntimeModelDiscovery(value: unknown): value is RuntimeModelDiscovery {
  if (!isRecord(value)) return false;
  if (value.status === 'available') {
    return (
      hasOnlyKeys(value, ['status', 'models']) &&
      Array.isArray(value.models) &&
      value.models.length > 0 &&
      value.models.every(isRuntimeModel) &&
      new Set(value.models.map((model) => model.id)).size === value.models.length
    );
  }
  return (
    (value.status === 'unsupported' || value.status === 'unavailable') &&
    hasOnlyKeys(value, ['status', 'code']) &&
    nonEmptyString(value.code)
  );
}

export function isRuntimeSelectionErrorCode(
  value: unknown,
): value is RuntimeSelectionErrorCode {
  return typeof value === 'string' &&
    (RUNTIME_SELECTION_ERROR_CODES as readonly string[]).includes(value);
}

export function isRuntimeSelectionValidation(
  value: unknown,
): value is RuntimeSelectionValidation {
  if (!isRecord(value)) return false;
  if (value.status === 'valid') {
    return hasOnlyKeys(value, ['status', 'selection']) && isRuntimeSelection(value.selection);
  }
  return value.status === 'invalid' &&
    hasOnlyKeys(value, ['status', 'code']) &&
    isRuntimeSelectionErrorCode(value.code);
}

export function isRuntimeSessionReceipt(value: unknown): value is RuntimeSessionReceipt {
  if (
    !isRecord(value) ||
    !hasOnlyKeys(value, [
      'mode',
      'continuationAttemptId',
      'selection',
      'nativeSessionId',
      'requestedNativeSessionId',
    ]) ||
    !exactNonEmptyString(value.continuationAttemptId) ||
    !isRuntimeSelection(value.selection) ||
    !exactNonEmptyString(value.nativeSessionId)
  ) return false;
  if (value.mode === 'created') return value.requestedNativeSessionId === null;
  return value.mode === 'resumed' &&
    exactNonEmptyString(value.requestedNativeSessionId) &&
    value.requestedNativeSessionId === value.nativeSessionId;
}
