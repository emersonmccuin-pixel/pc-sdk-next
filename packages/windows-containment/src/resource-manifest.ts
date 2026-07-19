export const RESOURCE_OWNERSHIP_MANIFEST_SCHEMA_VERSION =
  'pc-sdk.cx-004.native-resource-ownership-manifest.v1' as const;
export const RESOURCE_OWNERSHIP_MANIFEST_CLASSIFICATION =
  'cx-004-native-resource-ownership-manifest' as const;
export const RESOURCE_ARTIFACT_IDS = ['addon', 'bootstrap', 'qualification'] as const;
export const RESOURCE_OWNERSHIP_CLASSES = ['borrowed', 'no-release', 'owned'] as const;
export const RESOURCE_DOMAINS = ['opaque', 'pseudo', 'recyclable-numeric'] as const;
export const RESOURCE_RELEASE_COMPLETIONS = [
  'not-applicable',
  'null-return',
  'positive-nonzero-return',
] as const;
export const RESOURCE_UNCERTAIN_DISPOSITIONS = [
  'durable-creation-poison-nonrestart',
  'not-applicable',
  'transient-failure-exit',
] as const;
export const MAX_RESOURCE_OWNERSHIP_MANIFEST_BYTES = 128 * 1024;
export const MAX_RESOURCE_OWNERSHIP_MANIFEST_SITES = 64;

export type ResourceArtifactId = (typeof RESOURCE_ARTIFACT_IDS)[number];
export type ResourceOwnershipClass = (typeof RESOURCE_OWNERSHIP_CLASSES)[number];
export type ResourceDomain = (typeof RESOURCE_DOMAINS)[number];
export type ResourceReleaseCompletion = (typeof RESOURCE_RELEASE_COMPLETIONS)[number];
export type ResourceUncertainDisposition = (typeof RESOURCE_UNCERTAIN_DISPOSITIONS)[number];
export type ResourceAbaCanaryKind =
  | 'exact-numeric-same-domain'
  | 'not-applicable'
  | 'type-specific-liveness-release';

export interface ResourceAbaCanary {
  readonly kind: ResourceAbaCanaryKind;
  readonly maxAttempts: number;
  readonly maxMonotonicMilliseconds: number;
  readonly noProofOutcome: 'inconclusive' | 'not-applicable';
  readonly proof: string;
}

export interface ResourceFaultCanary {
  readonly beforeCall: 'injected-failure-before-call' | 'not-applicable';
  readonly nonpositiveResult: 'not-applicable' | 'release-returned-nonpositive';
  readonly reportUncertainAfterSuccess:
    | 'not-applicable'
    | 'underlying-release-succeeded-report-uncertain';
}

export interface ResourceOwnershipManifestSite {
  readonly abaCanary: ResourceAbaCanary;
  readonly acquisitionApi: string;
  readonly artifactId: ResourceArtifactId;
  readonly callsiteAnchor: string;
  readonly faultCanary: ResourceFaultCanary;
  readonly faultCanaryId: string;
  readonly identitySlot: string;
  readonly inheritable: boolean;
  readonly lastUse: string;
  readonly ownerSiteId: string | null;
  readonly ownership: ResourceOwnershipClass;
  readonly releaseApi: string | null;
  readonly releaseCompletion: ResourceReleaseCompletion;
  readonly releaseOrder: number | null;
  readonly releaseProof: string;
  readonly resourceDomain: ResourceDomain;
  readonly resourceType: string;
  readonly rightsHeld: readonly string[];
  readonly rightsUsed: readonly string[];
  readonly siteId: string;
  readonly translationUnit: string;
  readonly uncertainDisposition: ResourceUncertainDisposition;
}

export interface ResourceOwnershipManifest {
  readonly artifactId: ResourceArtifactId;
  readonly classification: typeof RESOURCE_OWNERSHIP_MANIFEST_CLASSIFICATION;
  readonly registrySha256: string;
  readonly schemaVersion: typeof RESOURCE_OWNERSHIP_MANIFEST_SCHEMA_VERSION;
  readonly siteCount: number;
  readonly sites: readonly ResourceOwnershipManifestSite[];
}

const MANIFEST_KEYS = [
  'artifactId',
  'classification',
  'registrySha256',
  'schemaVersion',
  'siteCount',
  'sites',
] as const;
const SITE_KEYS = [
  'abaCanary',
  'acquisitionApi',
  'artifactId',
  'callsiteAnchor',
  'faultCanary',
  'faultCanaryId',
  'identitySlot',
  'inheritable',
  'lastUse',
  'ownerSiteId',
  'ownership',
  'releaseApi',
  'releaseCompletion',
  'releaseOrder',
  'releaseProof',
  'resourceDomain',
  'resourceType',
  'rightsHeld',
  'rightsUsed',
  'siteId',
  'translationUnit',
  'uncertainDisposition',
] as const;
const ABA_KEYS = [
  'kind',
  'maxAttempts',
  'maxMonotonicMilliseconds',
  'noProofOutcome',
  'proof',
] as const;
const FAULT_KEYS = [
  'beforeCall',
  'nonpositiveResult',
  'reportUncertainAfterSuccess',
] as const;
const encoder = new TextEncoder();

export class ResourceOwnershipManifestParseError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = 'ResourceOwnershipManifestParseError';
    this.code = code;
  }
}

function fail(code: string, message: string): never {
  throw new ResourceOwnershipManifestParseError(code, message);
}

function ordinalCompare(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return (prototype === Object.prototype || prototype === null)
    && Object.getOwnPropertySymbols(value).length === 0;
}

function exactRecord(
  value: unknown,
  keys: readonly string[],
  label: string,
): Record<string, unknown> {
  if (!isRecord(value)) fail('invalid-object', `${label} must be a plain object`);
  const ownKeys = Reflect.ownKeys(value);
  if (ownKeys.some((key) => typeof key !== 'string')) {
    fail('invalid-symbol-key', `${label} must not contain symbol keys`);
  }
  const actual = (ownKeys as string[]).sort(ordinalCompare);
  const expected = [...keys].sort(ordinalCompare);
  if (actual.length !== expected.length || actual.some((key, index) => key !== expected[index])) {
    fail(
      'invalid-keys',
      `${label} keys must be exactly ${JSON.stringify(expected)}; observed ${JSON.stringify(actual)}`,
    );
  }
  for (const key of expected) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (descriptor === undefined || !descriptor.enumerable || !Object.hasOwn(descriptor, 'value')) {
      fail('invalid-property-descriptor', `${label}.${key} must be an enumerable data property`);
    }
  }
  return value;
}

function denseArray(
  value: unknown,
  label: string,
  maximumItems: number,
  allowEmpty = false,
): unknown[] {
  if (
    !Array.isArray(value)
    || Object.getPrototypeOf(value) !== Array.prototype
    || (!allowEmpty && value.length === 0)
    || value.length > maximumItems
  ) {
    fail('invalid-array', `${label} must be an exact bounded dense array`);
  }
  const expected = Array.from({ length: value.length }, (_, index) => String(index));
  const ownKeys = Reflect.ownKeys(value);
  if (
    ownKeys.length !== expected.length + 1
    || ownKeys[ownKeys.length - 1] !== 'length'
    || ownKeys.slice(0, -1).some((key, index) => key !== expected[index])
  ) {
    fail('invalid-array', `${label} must not contain sparse, named, or symbol members`);
  }
  for (const key of expected) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (descriptor === undefined || !descriptor.enumerable || !Object.hasOwn(descriptor, 'value')) {
      fail('invalid-property-descriptor', `${label}[${key}] must be an enumerable data property`);
    }
  }
  return value;
}

function boundedString(
  value: unknown,
  label: string,
  maximumBytes = 4096,
  pattern?: RegExp,
): string {
  if (
    typeof value !== 'string'
    || value.length === 0
    || /\0|\r|\n/u.test(value)
    || encoder.encode(value).length > maximumBytes
    || (pattern !== undefined && !pattern.test(value))
  ) {
    fail('invalid-string', `${label} is not an admitted bounded string`);
  }
  for (let index = 0; index < value.length; index += 1) {
    const unit = value.charCodeAt(index);
    if (unit >= 0xd800 && unit <= 0xdbff) {
      const next = value.charCodeAt(index + 1);
      if (!(next >= 0xdc00 && next <= 0xdfff)) {
        fail('invalid-unicode-scalar', `${label} contains an unpaired high surrogate`);
      }
      index += 1;
    } else if (unit >= 0xdc00 && unit <= 0xdfff) {
      fail('invalid-unicode-scalar', `${label} contains an unpaired low surrogate`);
    }
  }
  return value;
}

function nullableString(
  value: unknown,
  label: string,
  maximumBytes: number,
  pattern: RegExp,
): string | null {
  return value === null ? null : boundedString(value, label, maximumBytes, pattern);
}

function enumValue<const T extends readonly string[]>(
  value: unknown,
  allowed: T,
  label: string,
): T[number] {
  if (typeof value !== 'string' || !(allowed as readonly string[]).includes(value)) {
    fail('invalid-enum', `${label} must be one of ${JSON.stringify(allowed)}`);
  }
  return value as T[number];
}

function boundedInteger(value: unknown, label: string, minimum: number, maximum: number): number {
  if (
    !Number.isSafeInteger(value)
    || Object.is(value, -0)
    || (value as number) < minimum
    || (value as number) > maximum
  ) {
    fail('invalid-integer', `${label} must be an integer in [${minimum}, ${maximum}]`);
  }
  return value as number;
}

function sortedStrings(
  value: unknown,
  label: string,
  maximumItems = 8,
): readonly string[] {
  const entries = denseArray(value, label, maximumItems);
  const result = entries.map((entry, index) => boundedString(
    entry,
    `${label}[${index}]`,
    128,
    /^[A-Za-z0-9][A-Za-z0-9_-]*$/u,
  ));
  const sorted = [...result].sort(ordinalCompare);
  if (
    result.some((entry, index) => entry !== sorted[index])
    || new Set(result).size !== result.length
  ) {
    fail('invalid-array-order', `${label} must use strict unique ordinal order`);
  }
  return Object.freeze(result);
}

function parseAbaCanary(value: unknown, label: string): ResourceAbaCanary {
  const record = exactRecord(value, ABA_KEYS, label);
  const kind = enumValue(
    record.kind,
    ['exact-numeric-same-domain', 'not-applicable', 'type-specific-liveness-release'] as const,
    `${label}.kind`,
  );
  const maxAttempts = boundedInteger(record.maxAttempts, `${label}.maxAttempts`, 0, 1_000_000);
  const maxMonotonicMilliseconds = boundedInteger(
    record.maxMonotonicMilliseconds,
    `${label}.maxMonotonicMilliseconds`,
    0,
    60_000,
  );
  const noProofOutcome = enumValue(
    record.noProofOutcome,
    ['inconclusive', 'not-applicable'] as const,
    `${label}.noProofOutcome`,
  );
  if (kind === 'not-applicable') {
    if (maxAttempts !== 0 || maxMonotonicMilliseconds !== 0 || noProofOutcome !== 'not-applicable') {
      fail('invalid-aba-policy', `${label} not-applicable policy has nonzero proof bounds`);
    }
  } else if (kind === 'exact-numeric-same-domain') {
    if (
      maxAttempts !== 65_536
      || maxMonotonicMilliseconds !== 5_000
      || noProofOutcome !== 'inconclusive'
    ) {
      fail('invalid-aba-policy', `${label} exact-numeric policy differs from the sealed bounds`);
    }
  } else if (
    maxAttempts < 1
    || maxMonotonicMilliseconds < 1
    || noProofOutcome !== 'inconclusive'
  ) {
    fail('invalid-aba-policy', `${label} type-specific policy lacks positive bounded proof`);
  }
  return Object.freeze({
    kind,
    maxAttempts,
    maxMonotonicMilliseconds,
    noProofOutcome,
    proof: boundedString(record.proof, `${label}.proof`, 2048),
  });
}

function parseFaultCanary(
  value: unknown,
  label: string,
  owned: boolean,
): ResourceFaultCanary {
  const record = exactRecord(value, FAULT_KEYS, label);
  const beforeCall = enumValue(
    record.beforeCall,
    ['injected-failure-before-call', 'not-applicable'] as const,
    `${label}.beforeCall`,
  );
  const reportUncertainAfterSuccess = enumValue(
    record.reportUncertainAfterSuccess,
    ['not-applicable', 'underlying-release-succeeded-report-uncertain'] as const,
    `${label}.reportUncertainAfterSuccess`,
  );
  const nonpositiveResult = enumValue(
    record.nonpositiveResult,
    ['not-applicable', 'release-returned-nonpositive'] as const,
    `${label}.nonpositiveResult`,
  );
  if (
    owned
      ? beforeCall !== 'injected-failure-before-call'
        || nonpositiveResult !== 'release-returned-nonpositive'
        || reportUncertainAfterSuccess !== 'underlying-release-succeeded-report-uncertain'
      : beforeCall !== 'not-applicable'
        || nonpositiveResult !== 'not-applicable'
        || reportUncertainAfterSuccess !== 'not-applicable'
  ) {
    fail('invalid-fault-policy', `${label} does not match the ownership class`);
  }
  return Object.freeze({ beforeCall, nonpositiveResult, reportUncertainAfterSuccess });
}

function parseSite(
  value: unknown,
  index: number,
  artifactId: ResourceArtifactId,
): ResourceOwnershipManifestSite {
  const label = `resource ownership manifest.sites[${index}]`;
  const record = exactRecord(value, SITE_KEYS, label);
  const siteArtifactId = enumValue(record.artifactId, RESOURCE_ARTIFACT_IDS, `${label}.artifactId`);
  if (siteArtifactId !== artifactId) {
    fail('artifact-union', `${label} does not match the scalar manifest artifact`);
  }
  const ownership = enumValue(record.ownership, RESOURCE_OWNERSHIP_CLASSES, `${label}.ownership`);
  const resourceDomain = enumValue(record.resourceDomain, RESOURCE_DOMAINS, `${label}.resourceDomain`);
  const releaseCompletion = enumValue(
    record.releaseCompletion,
    RESOURCE_RELEASE_COMPLETIONS,
    `${label}.releaseCompletion`,
  );
  const uncertainDisposition = enumValue(
    record.uncertainDisposition,
    RESOURCE_UNCERTAIN_DISPOSITIONS,
    `${label}.uncertainDisposition`,
  );
  const ownerSiteId = nullableString(
    record.ownerSiteId,
    `${label}.ownerSiteId`,
    64,
    /^[a-z][a-z0-9_]*$/u,
  );
  const releaseApi = nullableString(
    record.releaseApi,
    `${label}.releaseApi`,
    128,
    /^[A-Za-z_][A-Za-z0-9_]*$/u,
  );
  const releaseOrder = record.releaseOrder === null
    ? null
    : boundedInteger(record.releaseOrder, `${label}.releaseOrder`, 1, 65_535);
  const abaCanary = parseAbaCanary(record.abaCanary, `${label}.abaCanary`);
  const faultCanary = parseFaultCanary(
    record.faultCanary,
    `${label}.faultCanary`,
    ownership === 'owned',
  );
  const rightsHeld = sortedStrings(record.rightsHeld, `${label}.rightsHeld`);
  const rightsUsed = sortedStrings(record.rightsUsed, `${label}.rightsUsed`);
  if (rightsUsed.some((right) => !rightsHeld.includes(right))) {
    fail('invalid-rights', `${label}.rightsUsed must be a subset of rightsHeld`);
  }

  if (ownership === 'owned') {
    const expectedAbaKind = resourceDomain === 'recyclable-numeric'
      ? 'exact-numeric-same-domain'
      : resourceDomain === 'opaque' ? 'type-specific-liveness-release' : null;
    if (expectedAbaKind === null || abaCanary.kind !== expectedAbaKind) {
      fail(
        'invalid-aba-domain',
        `${label}.abaCanary.kind does not match owned ${resourceDomain} resource semantics`,
      );
    }
  }

  if (ownership === 'owned') {
    if (
      ownerSiteId !== null
      || releaseApi === null
      || releaseOrder === null
      || releaseCompletion === 'not-applicable'
      || uncertainDisposition === 'not-applicable'
      || abaCanary.kind === 'not-applicable'
    ) {
      fail('invalid-owned-site', `${label} lacks typed release/quarantine metadata`);
    }
  } else if (
    releaseApi !== null
    || releaseOrder !== null
    || releaseCompletion !== 'not-applicable'
    || uncertainDisposition !== 'not-applicable'
    || abaCanary.kind !== 'not-applicable'
  ) {
    fail('invalid-nonowned-site', `${label} exposes an owned release policy`);
  }
  const acquisitionApi = boundedString(
    record.acquisitionApi,
    `${label}.acquisitionApi`,
    128,
    /^(?:[A-Za-z_][A-Za-z0-9_]*|borrow:[a-z][a-z0-9_]*)$/u,
  );
  if (ownership === 'borrowed') {
    if (ownerSiteId === null || acquisitionApi !== `borrow:${ownerSiteId}`) {
      fail('invalid-borrowed-site', `${label} does not bind its exact owner`);
    }
  } else if (ownerSiteId !== null) {
    fail('invalid-owner-link', `${label} may not bind ownerSiteId`);
  }
  if (
    (ownership === 'no-release') !== (resourceDomain === 'pseudo')
  ) {
    fail('invalid-pseudo-site', `${label} must bind pseudo domain to no-release ownership`);
  }
  if (typeof record.inheritable !== 'boolean') {
    fail('invalid-boolean', `${label}.inheritable must be boolean`);
  }
  const translationUnit = boundedString(
    record.translationUnit,
    `${label}.translationUnit`,
    512,
    /^packages\/windows-containment\/native\/[A-Za-z0-9_./-]+\.(?:cc|h)$/u,
  );
  if (translationUnit.includes('/../') || translationUnit.includes('/./') || translationUnit.includes('\\')) {
    fail('invalid-path', `${label}.translationUnit must be a normalized native path`);
  }
  return Object.freeze({
    abaCanary,
    acquisitionApi,
    artifactId: siteArtifactId,
    callsiteAnchor: boundedString(
      record.callsiteAnchor,
      `${label}.callsiteAnchor`,
      128,
      /^[A-Za-z_][A-Za-z0-9_]*$/u,
    ),
    faultCanary,
    faultCanaryId: boundedString(
      record.faultCanaryId,
      `${label}.faultCanaryId`,
      128,
      /^[a-z][a-z0-9_]*$/u,
    ),
    identitySlot: boundedString(
      record.identitySlot,
      `${label}.identitySlot`,
      256,
      /^[a-z0-9][a-z0-9.-]*$/u,
    ),
    inheritable: record.inheritable,
    lastUse: boundedString(record.lastUse, `${label}.lastUse`, 2048),
    ownerSiteId,
    ownership,
    releaseApi,
    releaseCompletion,
    releaseOrder,
    releaseProof: boundedString(record.releaseProof, `${label}.releaseProof`, 2048),
    resourceDomain,
    resourceType: boundedString(
      record.resourceType,
      `${label}.resourceType`,
      128,
      /^[a-z][a-z0-9-]*$/u,
    ),
    rightsHeld,
    rightsUsed,
    siteId: boundedString(
      record.siteId,
      `${label}.siteId`,
      64,
      /^[a-z][a-z0-9_]*$/u,
    ),
    translationUnit,
    uncertainDisposition,
  });
}

export function parseResourceOwnershipManifest(input: unknown): ResourceOwnershipManifest {
  const record = exactRecord(input, MANIFEST_KEYS, 'resource ownership manifest');
  if (record.schemaVersion !== RESOURCE_OWNERSHIP_MANIFEST_SCHEMA_VERSION) {
    fail('invalid-schema', 'resource ownership manifest schemaVersion is unsupported');
  }
  if (record.classification !== RESOURCE_OWNERSHIP_MANIFEST_CLASSIFICATION) {
    fail('invalid-classification', 'resource ownership manifest classification is unsupported');
  }
  const artifactId = enumValue(
    record.artifactId,
    RESOURCE_ARTIFACT_IDS,
    'resource ownership manifest.artifactId',
  );
  const siteCount = boundedInteger(
    record.siteCount,
    'resource ownership manifest.siteCount',
    0,
    MAX_RESOURCE_OWNERSHIP_MANIFEST_SITES,
  );
  const siteInputs = denseArray(
    record.sites,
    'resource ownership manifest.sites',
    MAX_RESOURCE_OWNERSHIP_MANIFEST_SITES,
    true,
  );
  if (siteInputs.length !== siteCount) {
    fail('site-count-mismatch', 'resource ownership manifest sites do not match siteCount');
  }
  const sites = siteInputs.map((site, index) => parseSite(site, index, artifactId));
  const siteIds = sites.map((site) => site.siteId);
  const sortedSiteIds = [...siteIds].sort(ordinalCompare);
  if (
    siteIds.some((siteId, index) => siteId !== sortedSiteIds[index])
    || new Set(siteIds).size !== siteIds.length
  ) {
    fail('invalid-site-order', 'resource ownership manifest sites must use unique ordinal siteId order');
  }
  const byId = new Map(sites.map((site) => [site.siteId, site]));
  for (const field of ['callsiteAnchor', 'faultCanaryId', 'identitySlot'] as const) {
    const values = sites.map((site) => site[field]);
    if (new Set(values).size !== values.length) {
      fail('duplicate-site-metadata', `resource ownership manifest repeats ${field}`);
    }
  }
  for (const site of sites) {
    if (site.ownership !== 'borrowed') continue;
    const owner = byId.get(site.ownerSiteId ?? '');
    if (
      owner?.ownership !== 'owned'
      || owner.resourceType !== site.resourceType
      || owner.resourceDomain !== site.resourceDomain
      || owner.inheritable !== site.inheritable
      || JSON.stringify(owner.rightsHeld) !== JSON.stringify(site.rightsHeld)
    ) {
      fail('invalid-owner-link', `borrowed site ${site.siteId} lacks a same-type owned owner`);
    }
  }
  const releaseOrders = sites
    .filter((site) => site.releaseOrder !== null)
    .map((site) => site.releaseOrder as number);
  if (new Set(releaseOrders).size !== releaseOrders.length) {
    fail('duplicate-release-order', 'resource ownership manifest repeats a release order');
  }
  const manifest = Object.freeze({
    artifactId,
    classification: RESOURCE_OWNERSHIP_MANIFEST_CLASSIFICATION,
    registrySha256: boundedString(
      record.registrySha256,
      'resource ownership manifest.registrySha256',
      64,
      /^[0-9a-f]{64}$/u,
    ),
    schemaVersion: RESOURCE_OWNERSHIP_MANIFEST_SCHEMA_VERSION,
    siteCount,
    sites: Object.freeze(sites),
  });
  if (
    new TextEncoder().encode(canonicalJson(manifest)).byteLength
      > MAX_RESOURCE_OWNERSHIP_MANIFEST_BYTES
  ) {
    fail('manifest-too-large', 'resource ownership manifest exceeds its aggregate byte bound');
  }
  return manifest;
}

function canonicalJson(value: unknown, ancestors = new WeakSet<object>()): string {
  if (value === null || typeof value === 'boolean' || typeof value === 'string') {
    return JSON.stringify(value);
  }
  if (typeof value === 'number') {
    if (!Number.isSafeInteger(value) || Object.is(value, -0)) {
      fail('noncanonical-number', 'canonical manifest JSON permits only non-negative-zero safe integers');
    }
    return JSON.stringify(value);
  }
  if (typeof value !== 'object') fail('noncanonical-value', 'canonical manifest JSON has unsupported value');
  if (ancestors.has(value)) fail('noncanonical-cycle', 'canonical manifest JSON contains a cycle');
  ancestors.add(value);
  try {
    if (Array.isArray(value)) {
      return `[${value.map((entry) => canonicalJson(entry, ancestors)).join(',')}]`;
    }
    if (!isRecord(value)) fail('noncanonical-object', 'canonical manifest JSON requires plain objects');
    return `{${Object.keys(value).sort(ordinalCompare).map(
      (key) => `${JSON.stringify(key)}:${canonicalJson(value[key], ancestors)}`,
    ).join(',')}}`;
  } finally {
    ancestors.delete(value);
  }
}

export function parseResourceOwnershipManifestJson(
  input: string | Uint8Array,
): ResourceOwnershipManifest {
  let text: string;
  if (typeof input === 'string') {
    text = input;
  } else if (input instanceof Uint8Array) {
    if (input.byteLength > MAX_RESOURCE_OWNERSHIP_MANIFEST_BYTES) {
      fail('manifest-too-large', 'resource ownership manifest exceeds its byte bound');
    }
    try {
      text = new TextDecoder('utf-8', { fatal: true }).decode(input);
    } catch (error) {
      fail('invalid-utf8', `resource ownership manifest is not UTF-8: ${String(error)}`);
    }
  } else {
    fail('invalid-input', 'resource ownership manifest JSON must be string or Uint8Array');
  }
  if (
    text.length === 0
    || encoder.encode(text).length > MAX_RESOURCE_OWNERSHIP_MANIFEST_BYTES
    || /\0|\r|\n/u.test(text)
    || text.charCodeAt(0) === 0xfeff
  ) {
    fail('invalid-json-bytes', 'resource ownership manifest JSON violates its exact byte contract');
  }
  let decoded: unknown;
  try {
    decoded = JSON.parse(text);
  } catch (error) {
    fail('invalid-json', `resource ownership manifest is not JSON: ${String(error)}`);
  }
  const manifest = parseResourceOwnershipManifest(decoded);
  if (text !== canonicalJson(manifest)) {
    fail('noncanonical-json', 'resource ownership manifest JSON is not exact recursively sorted canonical JSON');
  }
  return manifest;
}
