import { lstat, mkdir, open, readFile, readdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  canonicalJsonBytes,
  decodeCanonicalJsonBytes,
  sha256Bytes,
} from '../toolchain/manifest-set.mjs';
import { parsePe } from '../toolchain/probe/pe-inspect.mjs';

export const RESOURCE_SITE_REGISTRY_SCHEMA_VERSION =
  'pc-sdk.cx-004.native-resource-site-registry.v1';
export const RESOURCE_SITE_REGISTRY_CLASSIFICATION =
  'cx-004-native-resource-site-registry';
export const RESOURCE_OWNERSHIP_MANIFEST_SCHEMA_VERSION =
  'pc-sdk.cx-004.native-resource-ownership-manifest.v1';
export const RESOURCE_OWNERSHIP_MANIFEST_CLASSIFICATION =
  'cx-004-native-resource-ownership-manifest';
export const RESOURCE_ARTIFACT_IDS = Object.freeze([
  'addon',
  'bootstrap',
  'qualification',
]);
export const RESOURCE_OWNERSHIP_CLASSES = Object.freeze([
  'borrowed',
  'no-release',
  'owned',
]);
export const RESOURCE_DOMAINS = Object.freeze([
  'opaque',
  'pseudo',
  'recyclable-numeric',
]);
export const RESOURCE_RELEASE_COMPLETIONS = Object.freeze([
  'not-applicable',
  'null-return',
  'positive-nonzero-return',
]);
export const RESOURCE_UNCERTAIN_DISPOSITIONS = Object.freeze([
  'durable-creation-poison-nonrestart',
  'not-applicable',
  'transient-failure-exit',
]);

export const MAX_RESOURCE_REGISTRY_BYTES = 128 * 1024;
export const MAX_RESOURCE_MANIFEST_BYTES = 128 * 1024;
export const MAX_RESOURCE_SITES = 64;
export const MAX_NATIVE_GUARD_FILES = 1024;
export const MAX_NATIVE_GUARD_FILE_BYTES = 2 * 1024 * 1024;
export const MAX_NATIVE_GUARD_TOTAL_BYTES = 16 * 1024 * 1024;

const SCRIPT_DIRECTORY = path.dirname(fileURLToPath(import.meta.url));
const PACKAGE_DIRECTORY = path.resolve(SCRIPT_DIRECTORY, '..');
export const DEFAULT_RESOURCE_SITE_REGISTRY_PATH = path.join(
  PACKAGE_DIRECTORY,
  'native',
  'resource-sites.json',
);
export const DEFAULT_GENERATED_RESOURCE_MANIFEST_HEADER_PATH = path.join(
  PACKAGE_DIRECTORY,
  'native',
  'include',
  'pc_sdk_next',
  'generated',
  'resource_manifest.generated.h',
);

const REGISTRY_KEYS = Object.freeze([
  'artifactIds',
  'classification',
  'schemaVersion',
  'sites',
]);
const SITE_KEYS = Object.freeze([
  'abaCanary',
  'acquisitionApi',
  'artifactIds',
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
]);
const MANIFEST_KEYS = Object.freeze([
  'artifactId',
  'classification',
  'registrySha256',
  'schemaVersion',
  'siteCount',
  'sites',
]);
const MANIFEST_SITE_KEYS = Object.freeze([
  ...SITE_KEYS.filter((key) => key !== 'artifactIds'),
  'artifactId',
].sort());
const ABA_CANARY_KEYS = Object.freeze([
  'kind',
  'maxAttempts',
  'maxMonotonicMilliseconds',
  'noProofOutcome',
  'proof',
]);
const FAULT_CANARY_KEYS = Object.freeze([
  'beforeCall',
  'nonpositiveResult',
  'reportUncertainAfterSuccess',
]);
const ABA_KINDS = Object.freeze([
  'exact-numeric-same-domain',
  'not-applicable',
  'type-specific-liveness-release',
]);

const FRAME_MAGIC = Buffer.concat([
  Buffer.from('PCSDK-CX004-RM1', 'ascii'),
  Buffer.from([0]),
]);
const FRAME_FOOTER_MAGIC = Buffer.concat([
  Buffer.from('PCSDK-CX004-END', 'ascii'),
  Buffer.from([0]),
]);
export const RESOURCE_MANIFEST_FRAME_MAGIC_HEX = FRAME_MAGIC.toString('hex');
export const RESOURCE_MANIFEST_FRAME_FOOTER_MAGIC_HEX =
  FRAME_FOOTER_MAGIC.toString('hex');
export const RESOURCE_MANIFEST_FRAME_VERSION = 1;
export const RESOURCE_MANIFEST_FRAME_HEADER_BYTES = 64;
export const RESOURCE_MANIFEST_FRAME_FOOTER_BYTES = 16;

const ARTIFACT_CODES = Object.freeze({ addon: 2, bootstrap: 1, qualification: 3 });
const ARTIFACT_IDS_BY_CODE = new Map(
  Object.entries(ARTIFACT_CODES).map(([artifactId, code]) => [code, artifactId]),
);

export class ResourceManifestError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'ResourceManifestError';
    this.code = code;
  }
}

function fail(code, message) {
  throw new ResourceManifestError(code, message);
}

function ordinalCompare(left, right) {
  return left < right ? -1 : left > right ? 1 : 0;
}

function isPlainObject(value) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function assertPlainObject(value, label) {
  if (!isPlainObject(value)) fail('invalid-object', `${label} must be a plain object`);
  if (Object.getOwnPropertySymbols(value).length !== 0) {
    fail('invalid-symbol-key', `${label} must not contain symbol keys`);
  }
}

function assertExactKeys(value, expected, label) {
  assertPlainObject(value, label);
  const ownKeys = Reflect.ownKeys(value);
  if (ownKeys.some((key) => typeof key !== 'string')) {
    fail('invalid-symbol-key', `${label} must not contain symbol keys`);
  }
  const actual = ownKeys.sort(ordinalCompare);
  const sortedExpected = [...expected].sort(ordinalCompare);
  if (
    actual.length !== sortedExpected.length
    || actual.some((key, index) => key !== sortedExpected[index])
  ) {
    fail(
      'invalid-keys',
      `${label} keys must be exactly ${JSON.stringify(sortedExpected)}; observed ${JSON.stringify(actual)}`,
    );
  }
  for (const key of sortedExpected) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (descriptor === undefined || !descriptor.enumerable || !Object.hasOwn(descriptor, 'value')) {
      fail('invalid-property-descriptor', `${label}.${key} must be an enumerable data property`);
    }
  }
}

function assertDenseArray(value, label, { allowEmpty = false, maximumItems = 64 } = {}) {
  if (
    !Array.isArray(value)
    || Object.getPrototypeOf(value) !== Array.prototype
    || (!allowEmpty && value.length === 0)
    || value.length > maximumItems
  ) {
    fail('invalid-array', `${label} must be an exact bounded dense array`);
  }
  const expectedKeys = Array.from({ length: value.length }, (_, index) => String(index));
  const ownKeys = Reflect.ownKeys(value);
  if (
    ownKeys.length !== expectedKeys.length + 1
    || ownKeys[ownKeys.length - 1] !== 'length'
    || ownKeys.slice(0, -1).some((key, index) => key !== expectedKeys[index])
  ) {
    fail('invalid-array', `${label} must not contain sparse, named, or symbol members`);
  }
  for (const key of expectedKeys) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (descriptor === undefined || !descriptor.enumerable || !Object.hasOwn(descriptor, 'value')) {
      fail('invalid-property-descriptor', `${label}[${key}] must be an enumerable data property`);
    }
  }
  return value;
}

function assertString(value, label, { maximumBytes = 4096, pattern } = {}) {
  if (typeof value !== 'string' || value.length === 0) {
    fail('invalid-string', `${label} must be a non-empty string`);
  }
  if (/\0|\r|\n/u.test(value) || Buffer.byteLength(value, 'utf8') > maximumBytes) {
    fail('invalid-string', `${label} is outside its encoding/byte bound`);
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
  if (pattern !== undefined && !pattern.test(value)) {
    fail('invalid-string', `${label} has invalid syntax: ${JSON.stringify(value)}`);
  }
  return value;
}

function assertNullableString(value, label, options) {
  if (value === null) return null;
  return assertString(value, label, options);
}

function assertEnum(value, allowed, label) {
  assertString(value, label, { maximumBytes: 128 });
  if (!allowed.includes(value)) {
    fail('invalid-enum', `${label} must be one of ${JSON.stringify(allowed)}`);
  }
  return value;
}

function assertBoundedInteger(value, label, minimum, maximum) {
  if (!Number.isSafeInteger(value) || Object.is(value, -0) || value < minimum || value > maximum) {
    fail('invalid-integer', `${label} must be an integer in [${minimum}, ${maximum}]`);
  }
  return value;
}

function assertSortedUniqueStrings(value, label, options = {}) {
  assertDenseArray(value, label, { maximumItems: options.maximumItems ?? 64 });
  const result = value.map((entry, index) => assertString(
    entry,
    `${label}[${index}]`,
    { maximumBytes: options.maximumBytes ?? 256, pattern: options.pattern },
  ));
  const sorted = [...result].sort(ordinalCompare);
  if (result.some((entry, index) => entry !== sorted[index])) {
    fail('invalid-order', `${label} must use strict ordinal order`);
  }
  if (new Set(result).size !== result.length) {
    fail('duplicate-value', `${label} must not contain duplicates`);
  }
  return result;
}

function assertTranslationUnit(value, label) {
  assertString(value, label, {
    maximumBytes: 512,
    pattern: /^packages\/windows-containment\/native\/[A-Za-z0-9_./-]+\.(?:cc|h)$/u,
  });
  if (value.includes('/../') || value.includes('/./') || value.includes('\\')) {
    fail('invalid-path', `${label} must be a normalized repository-relative native path`);
  }
  return value;
}

function validateAbaCanary(value, label) {
  assertExactKeys(value, ABA_CANARY_KEYS, label);
  const kind = assertEnum(value.kind, ABA_KINDS, `${label}.kind`);
  const maxAttempts = assertBoundedInteger(value.maxAttempts, `${label}.maxAttempts`, 0, 1_000_000);
  const maxMilliseconds = assertBoundedInteger(
    value.maxMonotonicMilliseconds,
    `${label}.maxMonotonicMilliseconds`,
    0,
    60_000,
  );
  const noProofOutcome = assertEnum(
    value.noProofOutcome,
    ['inconclusive', 'not-applicable'],
    `${label}.noProofOutcome`,
  );
  assertString(value.proof, `${label}.proof`, { maximumBytes: 2048 });

  if (kind === 'not-applicable') {
    if (maxAttempts !== 0 || maxMilliseconds !== 0 || noProofOutcome !== 'not-applicable') {
      fail('invalid-aba-policy', `${label} not-applicable policy must have zero bounds and outcome`);
    }
  } else if (kind === 'exact-numeric-same-domain') {
    if (maxAttempts !== 65_536 || maxMilliseconds !== 5_000 || noProofOutcome !== 'inconclusive') {
      fail('invalid-aba-policy', `${label} exact-numeric policy must use the sealed 65536/5000 bounds`);
    }
  } else if (maxAttempts < 1 || maxMilliseconds < 1 || noProofOutcome !== 'inconclusive') {
    fail('invalid-aba-policy', `${label} type-specific policy requires positive bounds and inconclusive failure`);
  }
}

function validateFaultCanary(value, label, owned) {
  assertExactKeys(value, FAULT_CANARY_KEYS, label);
  const beforeCall = assertEnum(
    value.beforeCall,
    ['injected-failure-before-call', 'not-applicable'],
    `${label}.beforeCall`,
  );
  const reportUncertain = assertEnum(
    value.reportUncertainAfterSuccess,
    ['not-applicable', 'underlying-release-succeeded-report-uncertain'],
    `${label}.reportUncertainAfterSuccess`,
  );
  const nonpositiveResult = assertEnum(
    value.nonpositiveResult,
    ['not-applicable', 'release-returned-nonpositive'],
    `${label}.nonpositiveResult`,
  );
  if (
    owned
      ? beforeCall !== 'injected-failure-before-call'
        || nonpositiveResult !== 'release-returned-nonpositive'
        || reportUncertain !== 'underlying-release-succeeded-report-uncertain'
      : beforeCall !== 'not-applicable'
        || nonpositiveResult !== 'not-applicable'
        || reportUncertain !== 'not-applicable'
  ) {
    fail('invalid-fault-policy', `${label} does not match its ownership class`);
  }
}

function validateSite(value, label, { manifestArtifactId } = {}) {
  assertExactKeys(value, manifestArtifactId === undefined ? SITE_KEYS : MANIFEST_SITE_KEYS, label);
  const siteId = assertString(value.siteId, `${label}.siteId`, {
    maximumBytes: 64,
    pattern: /^[a-z][a-z0-9_]*$/u,
  });
  const artifactIds = manifestArtifactId === undefined
    ? assertSortedUniqueStrings(value.artifactIds, `${label}.artifactIds`, {
      maximumItems: RESOURCE_ARTIFACT_IDS.length,
      maximumBytes: 32,
      pattern: /^[a-z][a-z0-9-]*$/u,
    })
    : [assertEnum(value.artifactId, RESOURCE_ARTIFACT_IDS, `${label}.artifactId`)];
  for (const artifactId of artifactIds) {
    if (!RESOURCE_ARTIFACT_IDS.includes(artifactId)) {
      fail('invalid-artifact', `${label} names undeclared artifact ${JSON.stringify(artifactId)}`);
    }
    if (manifestArtifactId !== undefined && artifactId !== manifestArtifactId) {
      fail('artifact-union', `${label} does not belong to the scalar manifest artifact`);
    }
  }

  const ownership = assertEnum(value.ownership, RESOURCE_OWNERSHIP_CLASSES, `${label}.ownership`);
  const domain = assertEnum(value.resourceDomain, RESOURCE_DOMAINS, `${label}.resourceDomain`);
  assertString(value.acquisitionApi, `${label}.acquisitionApi`, {
    maximumBytes: 128,
    pattern: /^(?:[A-Za-z_][A-Za-z0-9_]*|borrow:[a-z][a-z0-9_]*)$/u,
  });
  assertString(value.callsiteAnchor, `${label}.callsiteAnchor`, {
    maximumBytes: 128,
    pattern: /^[A-Za-z_][A-Za-z0-9_]*$/u,
  });
  assertString(value.faultCanaryId, `${label}.faultCanaryId`, {
    maximumBytes: 128,
    pattern: /^[a-z][a-z0-9_]*$/u,
  });
  assertString(value.identitySlot, `${label}.identitySlot`, {
    maximumBytes: 256,
    pattern: /^[a-z0-9][a-z0-9.-]*$/u,
  });
  if (typeof value.inheritable !== 'boolean') {
    fail('invalid-boolean', `${label}.inheritable must be boolean`);
  }
  assertString(value.lastUse, `${label}.lastUse`, { maximumBytes: 2048 });
  const ownerSiteId = assertNullableString(value.ownerSiteId, `${label}.ownerSiteId`, {
    maximumBytes: 64,
    pattern: /^[a-z][a-z0-9_]*$/u,
  });
  const releaseApi = assertNullableString(value.releaseApi, `${label}.releaseApi`, {
    maximumBytes: 128,
    pattern: /^[A-Za-z_][A-Za-z0-9_]*$/u,
  });
  const releaseCompletion = assertEnum(
    value.releaseCompletion,
    RESOURCE_RELEASE_COMPLETIONS,
    `${label}.releaseCompletion`,
  );
  const releaseOrder = value.releaseOrder === null
    ? null
    : assertBoundedInteger(value.releaseOrder, `${label}.releaseOrder`, 1, 65_535);
  assertString(value.releaseProof, `${label}.releaseProof`, { maximumBytes: 2048 });
  assertString(value.resourceType, `${label}.resourceType`, {
    maximumBytes: 128,
    pattern: /^[a-z][a-z0-9-]*$/u,
  });
  const rightsHeld = assertSortedUniqueStrings(value.rightsHeld, `${label}.rightsHeld`, {
    maximumItems: 8,
    maximumBytes: 128,
    pattern: /^[A-Za-z0-9][A-Za-z0-9_-]*$/u,
  });
  const rightsUsed = assertSortedUniqueStrings(value.rightsUsed, `${label}.rightsUsed`, {
    maximumItems: 8,
    maximumBytes: 128,
    pattern: /^[A-Za-z0-9][A-Za-z0-9_-]*$/u,
  });
  if (rightsUsed.some((right) => !rightsHeld.includes(right))) {
    fail('invalid-rights', `${label}.rightsUsed must be a subset of rightsHeld`);
  }
  assertTranslationUnit(value.translationUnit, `${label}.translationUnit`);
  const uncertainDisposition = assertEnum(
    value.uncertainDisposition,
    RESOURCE_UNCERTAIN_DISPOSITIONS,
    `${label}.uncertainDisposition`,
  );
  validateFaultCanary(value.faultCanary, `${label}.faultCanary`, ownership === 'owned');
  validateAbaCanary(value.abaCanary, `${label}.abaCanary`);

  if (ownership === 'owned') {
    const expectedAbaKind = domain === 'recyclable-numeric'
      ? 'exact-numeric-same-domain'
      : domain === 'opaque' ? 'type-specific-liveness-release' : null;
    if (expectedAbaKind === null || value.abaCanary.kind !== expectedAbaKind) {
      fail(
        'invalid-aba-domain',
        `${label}.abaCanary.kind does not match owned ${domain} resource semantics`,
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
      || value.abaCanary.kind === 'not-applicable'
    ) {
      fail('invalid-owned-site', `${label} lacks typed owned release/quarantine metadata`);
    }
  } else if (
    releaseApi !== null
    || releaseOrder !== null
    || releaseCompletion !== 'not-applicable'
    || uncertainDisposition !== 'not-applicable'
    || value.abaCanary.kind !== 'not-applicable'
  ) {
    fail('invalid-nonowned-site', `${label} must not expose an owned release policy`);
  }
  if (ownership === 'borrowed') {
    if (ownerSiteId === null || value.acquisitionApi !== `borrow:${ownerSiteId}`) {
      fail('invalid-borrowed-site', `${label} must bind its exact owner site`);
    }
  } else if (ownerSiteId !== null) {
    fail('invalid-owner-link', `${label} may not bind ownerSiteId for ${ownership}`);
  }
  if (ownership === 'no-release' && domain !== 'pseudo') {
    fail('invalid-no-release-site', `${label} no-release site must use pseudo domain`);
  }
  if (domain === 'pseudo' && ownership !== 'no-release') {
    fail('invalid-pseudo-site', `${label} pseudo resource must use no-release ownership`);
  }
  return { artifactIds, ownerSiteId, ownership, releaseOrder, siteId };
}

function validateSiteRelations(sites, label, artifactIdsForSite) {
  const byId = new Map(sites.map((site) => [site.siteId, site]));
  if (byId.size !== sites.length) fail('duplicate-site-id', `${label} contains duplicate siteId`);
  for (const field of ['callsiteAnchor', 'faultCanaryId', 'identitySlot']) {
    const values = sites.map((site) => site[field]);
    if (new Set(values).size !== values.length) {
      fail('duplicate-site-metadata', `${label} repeats ${field}`);
    }
  }
  const stableIds = sites.map((site) => stableResourceSiteIdHex(site.siteId));
  if (new Set(stableIds).size !== stableIds.length) {
    fail('resource-site-id-collision', `${label} contains a stable 64-bit ResourceSiteId collision`);
  }
  const orderedIds = sites.map((site) => site.siteId);
  const sortedIds = [...orderedIds].sort(ordinalCompare);
  if (orderedIds.some((siteId, index) => siteId !== sortedIds[index])) {
    fail('invalid-site-order', `${label} sites must use strict ordinal siteId order`);
  }

  for (const site of sites) {
    if (site.ownership !== 'borrowed') continue;
    const owner = byId.get(site.ownerSiteId);
    if (owner === undefined || owner.ownership !== 'owned') {
      fail('invalid-owner-link', `${label} borrowed site ${site.siteId} lacks an owned owner`);
    }
    if (owner.resourceType !== site.resourceType || owner.resourceDomain !== site.resourceDomain) {
      fail('invalid-owner-link', `${label} borrowed site ${site.siteId} changes owner type/domain`);
    }
    if (
      owner.inheritable !== site.inheritable
      || canonicalJsonBytes(owner.rightsHeld).toString('utf8')
        !== canonicalJsonBytes(site.rightsHeld).toString('utf8')
    ) {
      fail('invalid-owner-link', `${label} borrowed site ${site.siteId} changes owner rights/inheritance`);
    }
    const ownerArtifacts = artifactIdsForSite(owner);
    for (const artifactId of artifactIdsForSite(site)) {
      if (!ownerArtifacts.includes(artifactId)) {
        fail('invalid-owner-link', `${label} owner is absent from borrower artifact ${artifactId}`);
      }
    }
  }

  for (const artifactId of RESOURCE_ARTIFACT_IDS) {
    const orders = sites
      .filter((site) => artifactIdsForSite(site).includes(artifactId) && site.releaseOrder !== null)
      .map((site) => site.releaseOrder);
    if (new Set(orders).size !== orders.length) {
      fail('duplicate-release-order', `${label} repeats an owned release order in ${artifactId}`);
    }
  }
}

function deepFreeze(value) {
  if (value !== null && typeof value === 'object' && !Object.isFrozen(value)) {
    for (const child of Object.values(value)) deepFreeze(child);
    Object.freeze(value);
  }
  return value;
}

export function validateResourceSiteRegistry(input, label = 'resource site registry') {
  const value = input;
  assertExactKeys(value, REGISTRY_KEYS, label);
  if (value.schemaVersion !== RESOURCE_SITE_REGISTRY_SCHEMA_VERSION) {
    fail('invalid-schema', `${label}.schemaVersion is not supported`);
  }
  if (value.classification !== RESOURCE_SITE_REGISTRY_CLASSIFICATION) {
    fail('invalid-classification', `${label}.classification is not supported`);
  }
  const artifacts = assertSortedUniqueStrings(value.artifactIds, `${label}.artifactIds`, {
    maximumItems: RESOURCE_ARTIFACT_IDS.length,
    maximumBytes: 32,
    pattern: /^[a-z][a-z0-9-]*$/u,
  });
  if (
    artifacts.length !== RESOURCE_ARTIFACT_IDS.length
    || artifacts.some((artifactId, index) => artifactId !== RESOURCE_ARTIFACT_IDS[index])
  ) {
    fail('invalid-artifacts', `${label} must declare the exact closed artifact vocabulary`);
  }
  assertDenseArray(value.sites, `${label}.sites`, { maximumItems: MAX_RESOURCE_SITES });
  value.sites.forEach((site, index) => validateSite(site, `${label}.sites[${index}]`));
  validateSiteRelations(value.sites, label, (site) => site.artifactIds);
  const canonical = canonicalJsonBytes(value);
  if (canonical.length > MAX_RESOURCE_REGISTRY_BYTES) {
    fail('registry-too-large', `${label} exceeds ${MAX_RESOURCE_REGISTRY_BYTES} canonical bytes`);
  }
  return deepFreeze(structuredClone(value));
}

function sameFileFacts(left, right) {
  return (left.dev === 0 || right.dev === 0 || left.dev === right.dev)
    && left.ino === right.ino
    && left.nlink === right.nlink
    && left.size === right.size
    && left.mtimeMs === right.mtimeMs
    && left.ctimeMs === right.ctimeMs;
}

async function readHandleExactly(fileHandle, expectedSize, label) {
  const buffer = Buffer.alloc(expectedSize + 1);
  let total = 0;
  while (total < buffer.length) {
    const { bytesRead } = await fileHandle.read(
      buffer,
      total,
      buffer.length - total,
      total,
    );
    if (bytesRead === 0) break;
    total += bytesRead;
  }
  if (total !== expectedSize) {
    fail('unstable-registry-file', `${label} did not retain its exact byte length`);
  }
  return buffer.subarray(0, expectedSize);
}

function inspectDeclarativeJson(text, label) {
  let cursor = 0;
  let members = 0;
  const skipWhitespace = () => {
    while (cursor < text.length && /[\u0009\u000a\u000d\u0020]/u.test(text[cursor])) cursor += 1;
  };
  const parseString = () => {
    const start = cursor;
    if (text[cursor] !== '"') fail('invalid-json', `${label} expected a JSON string at ${cursor}`);
    cursor += 1;
    let escaped = false;
    while (cursor < text.length) {
      const character = text[cursor];
      if (!escaped && character === '"') {
        cursor += 1;
        try {
          return JSON.parse(text.slice(start, cursor));
        } catch (error) {
          fail('invalid-json', `${label} has invalid string at ${start}: ${error.message}`);
        }
      }
      if (!escaped && character.charCodeAt(0) < 0x20) {
        fail('invalid-json', `${label} has an unescaped control character at ${cursor}`);
      }
      if (escaped && character === 'u') {
        if (!/^[0-9A-Fa-f]{4}$/u.test(text.slice(cursor + 1, cursor + 5))) {
          fail('invalid-json', `${label} has an invalid Unicode escape at ${cursor}`);
        }
        cursor += 5;
        escaped = false;
        continue;
      }
      if (escaped && !/^["\\/bfnrt]$/u.test(character)) {
        fail('invalid-json', `${label} has an invalid escape at ${cursor}`);
      }
      if (character === '\\' && !escaped) escaped = true;
      else escaped = false;
      cursor += 1;
    }
    fail('invalid-json', `${label} has an unterminated string at ${start}`);
  };
  const parseValue = (depth) => {
    if (depth > 64) fail('json-too-deep', `${label} exceeds the JSON depth bound`);
    skipWhitespace();
    if (text[cursor] === '{') {
      cursor += 1;
      const keys = new Set();
      skipWhitespace();
      if (text[cursor] === '}') {
        cursor += 1;
        return;
      }
      while (cursor < text.length) {
        skipWhitespace();
        const key = parseString();
        if (keys.has(key)) fail('duplicate-json-key', `${label} repeats object key ${JSON.stringify(key)}`);
        keys.add(key);
        members += 1;
        if (members > 16_384) fail('json-too-large', `${label} exceeds the JSON member bound`);
        skipWhitespace();
        if (text[cursor] !== ':') fail('invalid-json', `${label} expected ':' at ${cursor}`);
        cursor += 1;
        parseValue(depth + 1);
        skipWhitespace();
        if (text[cursor] === '}') {
          cursor += 1;
          return;
        }
        if (text[cursor] !== ',') fail('invalid-json', `${label} expected ',' at ${cursor}`);
        cursor += 1;
      }
      fail('invalid-json', `${label} has an unterminated object`);
    }
    if (text[cursor] === '[') {
      cursor += 1;
      skipWhitespace();
      if (text[cursor] === ']') {
        cursor += 1;
        return;
      }
      while (cursor < text.length) {
        members += 1;
        if (members > 16_384) fail('json-too-large', `${label} exceeds the JSON member bound`);
        parseValue(depth + 1);
        skipWhitespace();
        if (text[cursor] === ']') {
          cursor += 1;
          return;
        }
        if (text[cursor] !== ',') fail('invalid-json', `${label} expected ',' at ${cursor}`);
        cursor += 1;
      }
      fail('invalid-json', `${label} has an unterminated array`);
    }
    if (text[cursor] === '"') {
      parseString();
      return;
    }
    const scalar = /^(?:true|false|null|-?(?:0|[1-9][0-9]*)(?:\.[0-9]+)?(?:[eE][+-]?[0-9]+)?)/u.exec(text.slice(cursor));
    if (scalar === null) fail('invalid-json', `${label} has invalid value at ${cursor}`);
    cursor += scalar[0].length;
  };
  parseValue(0);
  skipWhitespace();
  if (cursor !== text.length) fail('invalid-json', `${label} has trailing content at ${cursor}`);
}

export async function loadResourceSiteRegistry(
  registryPath = DEFAULT_RESOURCE_SITE_REGISTRY_PATH,
) {
  const pathBefore = await lstat(registryPath);
  if (
    !pathBefore.isFile()
    || pathBefore.isSymbolicLink()
    || pathBefore.nlink !== 1
    || pathBefore.size <= 0
  ) {
    fail('invalid-registry-file', `${registryPath} must be a nonempty ordinary file`);
  }
  if (pathBefore.size > MAX_RESOURCE_REGISTRY_BYTES) {
    fail('registry-too-large', `${registryPath} exceeds ${MAX_RESOURCE_REGISTRY_BYTES} bytes`);
  }
  const fileHandle = await open(registryPath, 'r');
  let bytes;
  try {
    const handleBefore = await fileHandle.stat();
    if (handleBefore.nlink !== 1 || !handleBefore.isFile() || !sameFileFacts(pathBefore, handleBefore)) {
      fail('unstable-registry-file', `${registryPath} identity changed before the guarded read`);
    }
    const first = await readHandleExactly(fileHandle, handleBefore.size, registryPath);
    const handleMiddle = await fileHandle.stat();
    const second = await readHandleExactly(fileHandle, handleBefore.size, registryPath);
    const handleAfter = await fileHandle.stat();
    if (
      !sameFileFacts(handleBefore, handleMiddle)
      || !sameFileFacts(handleBefore, handleAfter)
      || !first.equals(second)
    ) {
      fail('unstable-registry-file', `${registryPath} changed during the guarded double read`);
    }
    bytes = Buffer.from(first);
  } finally {
    await fileHandle.close();
  }
  const pathAfter = await lstat(registryPath);
  if (
    pathAfter.isSymbolicLink()
    || pathAfter.nlink !== 1
    || !sameFileFacts(pathBefore, pathAfter)
    || bytes.includes(0)
  ) {
    fail('unstable-registry-file', `${registryPath} changed or contains NUL`);
  }
  let text;
  try {
    text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch (error) {
    fail('invalid-utf8', `${registryPath} is not exact UTF-8: ${error.message}`);
  }
  if (text.charCodeAt(0) === 0xfeff) fail('invalid-bom', `${registryPath} must not contain a BOM`);
  inspectDeclarativeJson(text, registryPath);
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch (error) {
    fail('invalid-json', `${registryPath} is not valid JSON: ${error.message}`);
  }
  return validateResourceSiteRegistry(parsed, registryPath);
}

export function validateResourceOwnershipManifest(
  input,
  label = 'resource ownership manifest',
) {
  const value = input;
  assertExactKeys(value, MANIFEST_KEYS, label);
  const artifactId = assertEnum(value.artifactId, RESOURCE_ARTIFACT_IDS, `${label}.artifactId`);
  if (value.schemaVersion !== RESOURCE_OWNERSHIP_MANIFEST_SCHEMA_VERSION) {
    fail('invalid-schema', `${label}.schemaVersion is not supported`);
  }
  if (value.classification !== RESOURCE_OWNERSHIP_MANIFEST_CLASSIFICATION) {
    fail('invalid-classification', `${label}.classification is not supported`);
  }
  assertString(value.registrySha256, `${label}.registrySha256`, {
    maximumBytes: 64,
    pattern: /^[0-9a-f]{64}$/u,
  });
  assertBoundedInteger(value.siteCount, `${label}.siteCount`, 0, MAX_RESOURCE_SITES);
  assertDenseArray(value.sites, `${label}.sites`, {
    allowEmpty: true,
    maximumItems: MAX_RESOURCE_SITES,
  });
  if (value.siteCount !== value.sites.length) {
    fail('site-count-mismatch', `${label}.siteCount does not match sites`);
  }
  value.sites.forEach((site, index) => validateSite(
    site,
    `${label}.sites[${index}]`,
    { manifestArtifactId: artifactId },
  ));
  validateSiteRelations(value.sites, label, () => [artifactId]);
  const canonical = canonicalJsonBytes(value);
  if (canonical.length > MAX_RESOURCE_MANIFEST_BYTES) {
    fail('manifest-too-large', `${label} exceeds ${MAX_RESOURCE_MANIFEST_BYTES} canonical bytes`);
  }
  return deepFreeze(structuredClone(value));
}

export function buildArtifactResourceOwnershipManifest(registryInput, artifactId) {
  const registry = validateResourceSiteRegistry(registryInput);
  if (typeof artifactId !== 'string' || !RESOURCE_ARTIFACT_IDS.includes(artifactId)) {
    fail('artifact-union', 'artifact manifest selection requires exactly one scalar artifactId');
  }
  const sites = registry.sites
    .filter((site) => site.artifactIds.includes(artifactId))
    .map((site) => {
      const { artifactIds: _artifactIds, ...metadata } = structuredClone(site);
      return { ...metadata, artifactId };
    });
  return validateResourceOwnershipManifest({
    artifactId,
    classification: RESOURCE_OWNERSHIP_MANIFEST_CLASSIFICATION,
    registrySha256: sha256Bytes(canonicalJsonBytes(registry)),
    schemaVersion: RESOURCE_OWNERSHIP_MANIFEST_SCHEMA_VERSION,
    siteCount: sites.length,
    sites,
  });
}

function toBuffer(bytes, label) {
  if (!(bytes instanceof Uint8Array)) fail('invalid-bytes', `${label} must be Uint8Array`);
  return Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
}

export function encodeEmbeddedResourceOwnershipManifestFrame(manifestInput) {
  const manifest = validateResourceOwnershipManifest(manifestInput);
  const payload = canonicalJsonBytes(manifest);
  const digestHex = sha256Bytes(payload);
  const digest = Buffer.from(digestHex, 'hex');
  const frame = Buffer.alloc(
    RESOURCE_MANIFEST_FRAME_HEADER_BYTES
      + payload.length
      + RESOURCE_MANIFEST_FRAME_FOOTER_BYTES,
  );
  FRAME_MAGIC.copy(frame, 0);
  frame.writeUInt16LE(RESOURCE_MANIFEST_FRAME_VERSION, 16);
  frame.writeUInt16LE(RESOURCE_MANIFEST_FRAME_HEADER_BYTES, 18);
  frame.writeUInt8(ARTIFACT_CODES[manifest.artifactId], 20);
  frame.fill(0, 21, 24);
  frame.writeUInt32LE(payload.length, 24);
  frame.writeUInt32LE(manifest.siteCount, 28);
  digest.copy(frame, 32);
  payload.copy(frame, RESOURCE_MANIFEST_FRAME_HEADER_BYTES);
  FRAME_FOOTER_MAGIC.copy(
    frame,
    RESOURCE_MANIFEST_FRAME_HEADER_BYTES + payload.length,
  );
  return frame;
}

function framedLengthAt(bytes, offset, label) {
  if (!Number.isSafeInteger(offset) || offset < 0 || offset + RESOURCE_MANIFEST_FRAME_HEADER_BYTES > bytes.length) {
    fail('truncated-frame', `${label} does not contain a complete frame header`);
  }
  if (!bytes.subarray(offset, offset + FRAME_MAGIC.length).equals(FRAME_MAGIC)) {
    fail('invalid-frame-magic', `${label} has invalid frame magic`);
  }
  const payloadLength = bytes.readUInt32LE(offset + 24);
  if (payloadLength > MAX_RESOURCE_MANIFEST_BYTES) {
    fail('manifest-too-large', `${label} payload exceeds ${MAX_RESOURCE_MANIFEST_BYTES} bytes`);
  }
  const total = RESOURCE_MANIFEST_FRAME_HEADER_BYTES
    + payloadLength
    + RESOURCE_MANIFEST_FRAME_FOOTER_BYTES;
  if (offset + total > bytes.length) fail('truncated-frame', `${label} frame is truncated`);
  return total;
}

export function decodeEmbeddedResourceOwnershipManifestFrame(frameInput, label = 'embedded frame') {
  const frame = toBuffer(frameInput, label);
  const expectedLength = framedLengthAt(frame, 0, label);
  if (frame.length !== expectedLength) {
    fail('frame-trailing-bytes', `${label} must contain exactly one frame`);
  }
  if (frame.readUInt16LE(16) !== RESOURCE_MANIFEST_FRAME_VERSION) {
    fail('invalid-frame-version', `${label} has unsupported version`);
  }
  if (frame.readUInt16LE(18) !== RESOURCE_MANIFEST_FRAME_HEADER_BYTES) {
    fail('invalid-frame-header', `${label} has invalid header length`);
  }
  if (frame[21] !== 0 || frame[22] !== 0 || frame[23] !== 0) {
    fail('invalid-frame-reserved', `${label} reserved bytes must be zero`);
  }
  const artifactId = ARTIFACT_IDS_BY_CODE.get(frame.readUInt8(20));
  if (artifactId === undefined) fail('invalid-frame-artifact', `${label} has unknown artifact code`);
  const payloadLength = frame.readUInt32LE(24);
  const siteCount = frame.readUInt32LE(28);
  if (siteCount > MAX_RESOURCE_SITES) fail('invalid-frame-sites', `${label} site count is out of bounds`);
  const digest = frame.subarray(32, 64);
  const payload = frame.subarray(64, 64 + payloadLength);
  const footer = frame.subarray(64 + payloadLength);
  if (!footer.equals(FRAME_FOOTER_MAGIC)) {
    fail('invalid-frame-footer', `${label} has invalid footer magic`);
  }
  const digestHex = sha256Bytes(payload);
  if (!digest.equals(Buffer.from(digestHex, 'hex'))) {
    fail('frame-digest-mismatch', `${label} canonical payload digest does not match`);
  }
  let decoded;
  try {
    decoded = decodeCanonicalJsonBytes(payload, `${label} payload`, {
      maxManifestBytes: MAX_RESOURCE_MANIFEST_BYTES,
      maxManifestMembers: 4096,
    });
  } catch (error) {
    fail('invalid-frame-payload', `${label} payload is not bounded canonical JSON: ${error.message}`);
  }
  const manifest = validateResourceOwnershipManifest(decoded, `${label} payload`);
  if (manifest.artifactId !== artifactId || manifest.siteCount !== siteCount) {
    fail('frame-binding-mismatch', `${label} header does not match its canonical payload`);
  }
  return Object.freeze({
    artifactId,
    digestHex,
    frameBytes: Buffer.from(frame),
    manifest,
    payloadBytes: Buffer.from(payload),
  });
}

export function extractEmbeddedResourceOwnershipManifestFromPe(peInput) {
  const peBytes = toBuffer(peInput, 'PE image');
  let pe;
  try {
    pe = parsePe(peBytes);
  } catch (error) {
    fail('invalid-pe', `PE image inspection failed: ${error.message}`);
  }
  const occurrences = [];
  for (const section of pe.sections) {
    if (
      !['.rdata', '_RDATA'].includes(section.name)
      || section.executable
      || section.writable
      || !section.readable
      || section.rawSize === 0
    ) continue;
    const start = section.rawOffset;
    const end = start + section.rawSize;
    let cursor = start;
    while (cursor < end) {
      const offset = peBytes.indexOf(FRAME_MAGIC, cursor);
      if (offset < 0 || offset >= end) break;
      occurrences.push({ offset, section });
      cursor = offset + FRAME_MAGIC.length;
    }
  }
  if (occurrences.length !== 1) {
    fail('pe-frame-count', `PE image must contain exactly one read-only resource manifest frame; observed ${occurrences.length}`);
  }
  const [{ offset, section }] = occurrences;
  const length = framedLengthAt(peBytes, offset, 'PE resource manifest frame');
  if (offset + length > section.rawOffset + section.rawSize) {
    fail('pe-frame-section-crossing', 'PE resource manifest frame crosses its read-only section');
  }
  const decoded = decodeEmbeddedResourceOwnershipManifestFrame(
    peBytes.subarray(offset, offset + length),
    'PE resource manifest frame',
  );
  return Object.freeze({ ...decoded, offset, section: Object.freeze({ ...section }) });
}

export function verifyEmbeddedResourceOwnershipManifestInPe(peInput, expectedManifestInput) {
  const expected = validateResourceOwnershipManifest(expectedManifestInput, 'expected manifest');
  const observed = extractEmbeddedResourceOwnershipManifestFromPe(peInput);
  const expectedBytes = canonicalJsonBytes(expected);
  if (!observed.payloadBytes.equals(expectedBytes)) {
    fail('pe-manifest-mismatch', 'embedded PE manifest differs from the exact expected artifact manifest');
  }
  return observed;
}

function cppString(value) {
  if (!/^[\x20-\x7e]*$/u.test(value)) {
    fail('non-ascii-generated-string', `generated C++ metadata must be printable ASCII: ${JSON.stringify(value)}`);
  }
  return JSON.stringify(value);
}

function cppEnum(value) {
  return value.replaceAll('-', '_');
}

export function stableResourceSiteIdHex(siteId) {
  assertString(siteId, 'resource site ID', {
    maximumBytes: 64,
    pattern: /^[a-z][a-z0-9_]*$/u,
  });
  const value = sha256Bytes(Buffer.from(`pc-sdk.cx-004.resource-site\0${siteId}`, 'utf8')).slice(0, 16);
  if (value === '0000000000000000') fail('resource-site-id-zero', `${siteId} hashes to reserved zero`);
  return value;
}

function renderByteFactory(name, bytes) {
  const values = [];
  for (let offset = 0; offset < bytes.length; offset += 16) {
    values.push(`    ${[...bytes.subarray(offset, offset + 16)]
      .map((value) => `0x${value.toString(16).padStart(2, '0')}`)
      .join(', ')},`);
  }
  return [
    `[[nodiscard]] consteval std::array<std::uint8_t, ${bytes.length}> ${name}() noexcept {`,
    `  return {`,
    ...values,
    `  };`,
    `}`,
  ].join('\n');
}

function renderSiteTraits(site) {
  const artifactIds = site.artifactIds.map(cppString).join(', ');
  return `template <>\nstruct ResourceSiteTraits<ResourceSiteId::${site.siteId}> final {\n`
    + `  static constexpr std::string_view site_id = ${cppString(site.siteId)};\n`
    + `  static constexpr std::array<std::string_view, ${site.artifactIds.length}> artifact_ids = { ${artifactIds} };\n`
    + `  static constexpr ResourceOwnershipClass ownership = ResourceOwnershipClass::${cppEnum(site.ownership)};\n`
    + `  static constexpr ResourceDomain domain = ResourceDomain::${cppEnum(site.resourceDomain)};\n`
    + `  static constexpr ReleaseCompletion release_completion = ReleaseCompletion::${cppEnum(site.releaseCompletion)};\n`
    + `  static constexpr UncertainDisposition uncertain_disposition = UncertainDisposition::${cppEnum(site.uncertainDisposition)};\n`
    + `  static constexpr std::string_view resource_type = ${cppString(site.resourceType)};\n`
    + `  static constexpr std::string_view acquisition_api = ${cppString(site.acquisitionApi)};\n`
    + `  static constexpr std::string_view release_api = ${cppString(site.releaseApi ?? '')};\n`
    + `  static constexpr std::string_view owner_site_id = ${cppString(site.ownerSiteId ?? '')};\n`
    + `  static constexpr std::string_view fault_canary_id = ${cppString(site.faultCanaryId)};\n`
    + `  static constexpr bool fault_inject_before_call = ${site.ownership === 'owned' ? 'true' : 'false'};\n`
    + `  static constexpr bool fault_inject_nonpositive_result = ${site.ownership === 'owned' ? 'true' : 'false'};\n`
    + `  static constexpr bool fault_inject_report_uncertain_after_success = ${site.ownership === 'owned' ? 'true' : 'false'};\n`
    + `  static constexpr bool inheritable = ${site.inheritable ? 'true' : 'false'};\n`
    + `  static constexpr bool quarantine_poison_process_creation = ${site.ownership === 'owned' && site.uncertainDisposition !== 'not-applicable' ? 'true' : 'false'};\n`
    + `  static constexpr bool quarantine_nonrestart_shutdown_required = ${site.ownership === 'owned' && site.uncertainDisposition !== 'not-applicable' ? 'true' : 'false'};\n`
    + `  static constexpr bool has_release_order = ${site.releaseOrder === null ? 'false' : 'true'};\n`
    + `  static constexpr std::uint32_t release_order = ${site.releaseOrder ?? 0}U;\n`
    + `  static constexpr std::uint32_t aba_max_attempts = ${site.abaCanary.maxAttempts}U;\n`
    + `  static constexpr std::uint32_t aba_max_monotonic_milliseconds = ${site.abaCanary.maxMonotonicMilliseconds}U;\n`
    + '};';
}

function renderArtifactSelection(registry, artifactId) {
  const manifest = buildArtifactResourceOwnershipManifest(registry, artifactId);
  const payload = canonicalJsonBytes(manifest);
  const digest = Buffer.from(sha256Bytes(payload), 'hex');
  const frame = encodeEmbeddedResourceOwnershipManifestFrame(manifest);
  const ids = manifest.sites.map((site) => `ResourceSiteId::${site.siteId}`).join(', ');
  const idStrings = manifest.sites.map((site) => cppString(site.siteId)).join(', ');
  return [
    `inline constexpr std::string_view kResourceOwnershipManifestArtifactId = ${cppString(artifactId)};`,
    `inline constexpr std::uint32_t kResourceOwnershipManifestSiteCount = ${manifest.siteCount}U;`,
    `inline constexpr std::array<ResourceSiteId, ${manifest.siteCount}> kResourceSiteIds${manifest.siteCount === 0 ? '{}' : ` = { ${ids} }`};`,
    `inline constexpr std::array<std::string_view, ${manifest.siteCount}> kResourceSiteIdStrings${manifest.siteCount === 0 ? '{}' : ` = { ${idStrings} }`};`,
    renderByteFactory('ResourceOwnershipManifestSourceSha256', digest),
    renderByteFactory('ResourceOwnershipManifestSourceFrame', frame),
  ].join('\n\n');
}

export function renderGeneratedResourceManifestHeader(registryInput) {
  const registry = validateResourceSiteRegistry(registryInput);
  const enumValues = registry.sites.map(
    (site) => `  ${site.siteId} = 0x${stableResourceSiteIdHex(site.siteId)}ULL,`,
  ).join('\n');
  const traits = registry.sites.map(renderSiteTraits).join('\n\n');
  const bootstrap = renderArtifactSelection(registry, 'bootstrap');
  const addon = renderArtifactSelection(registry, 'addon');
  const qualification = renderArtifactSelection(registry, 'qualification');
  return `// Generated by build/resource-manifest.mjs --write. Do not edit.\n`
    + `#pragma once\n\n`
    + `#include <array>\n#include <cstddef>\n#include <cstdint>\n#include <string_view>\n\n`
    + `#if (defined(PCSDK_ARTIFACT_BOOTSTRAP) + defined(PCSDK_ARTIFACT_ADDON) + defined(PCSDK_ARTIFACT_QUALIFICATION)) != 1\n`
    + `#error "Define exactly one PCSDK_ARTIFACT_BOOTSTRAP, PCSDK_ARTIFACT_ADDON, or PCSDK_ARTIFACT_QUALIFICATION"\n#endif\n\n`
    + `namespace pc_sdk_next::containment {\n\n`
    + `enum class ResourceSiteId : std::uint64_t {\n${enumValues}\n};\n\n`
    + `enum class ResourceOwnershipClass : std::uint8_t { borrowed, no_release, owned };\n`
    + `enum class ResourceDomain : std::uint8_t { opaque, pseudo, recyclable_numeric };\n`
    + `enum class ReleaseCompletion : std::uint8_t { not_applicable, null_return, positive_nonzero_return };\n`
    + `enum class UncertainDisposition : std::uint8_t { durable_creation_poison_nonrestart, not_applicable, transient_failure_exit };\n\n`
    + `template <ResourceSiteId Site>\nstruct ResourceSiteTraits;\n\n${traits}\n\n`
    + `#if defined(PCSDK_ARTIFACT_BOOTSTRAP)\n${bootstrap}\n`
    + `#elif defined(PCSDK_ARTIFACT_ADDON)\n${addon}\n`
    + `#elif defined(PCSDK_ARTIFACT_QUALIFICATION)\n${qualification}\n#endif\n\n`
    + `static_assert(ResourceOwnershipManifestSourceFrame().size() <= ${MAX_RESOURCE_MANIFEST_BYTES + RESOURCE_MANIFEST_FRAME_HEADER_BYTES + RESOURCE_MANIFEST_FRAME_FOOTER_BYTES}U);\n\n`
    + `}  // namespace pc_sdk_next::containment\n`;
}

export async function writeGeneratedResourceManifestHeader({
  registryPath = DEFAULT_RESOURCE_SITE_REGISTRY_PATH,
  headerPath = DEFAULT_GENERATED_RESOURCE_MANIFEST_HEADER_PATH,
} = {}) {
  const registry = await loadResourceSiteRegistry(registryPath);
  const rendered = renderGeneratedResourceManifestHeader(registry);
  await mkdir(path.dirname(headerPath), { recursive: true });
  await writeFile(headerPath, rendered, { encoding: 'utf8', flag: 'w' });
  return Object.freeze({
    headerPath,
    registryPath,
    sha256: sha256Bytes(Buffer.from(rendered, 'utf8')),
  });
}

export async function checkGeneratedResourceManifestHeader({
  registryPath = DEFAULT_RESOURCE_SITE_REGISTRY_PATH,
  headerPath = DEFAULT_GENERATED_RESOURCE_MANIFEST_HEADER_PATH,
} = {}) {
  const registry = await loadResourceSiteRegistry(registryPath);
  const expected = Buffer.from(renderGeneratedResourceManifestHeader(registry), 'utf8');
  let observed;
  try {
    observed = await readFile(headerPath);
  } catch (error) {
    fail('generated-header-missing', `${headerPath} cannot be read: ${error.message}`);
  }
  if (!observed.equals(expected)) {
    fail('generated-header-mismatch', `${headerPath} is not the deterministic registry projection`);
  }
  return Object.freeze({
    headerPath,
    registryPath,
    sha256: sha256Bytes(expected),
  });
}

const RESOURCE_MARKERS = Object.freeze({
  PCSDK_RESOURCE_ACQUIRE: 'acquire',
  PCSDK_RESOURCE_BORROW: 'borrow',
  PCSDK_RESOURCE_NO_RELEASE: 'no-release',
  PCSDK_RESOURCE_RELEASE: 'release',
});

function withWindowsGenericApiAliases(apiNames) {
  const closed = new Set(apiNames);
  for (const apiName of apiNames) {
    if (!/[AW]$/u.test(apiName)) continue;
    const baseName = apiName.slice(0, -1);
    closed.add(baseName);
    closed.add(`${baseName}A`);
    closed.add(`${baseName}W`);
  }
  return closed;
}

const GUARDED_ACQUISITION_APIS = withWindowsGenericApiAliases([
  'AddSIDToBoundaryDescriptor',
  'BCryptCreateHash',
  'BCryptGenerateSymmetricKey',
  'BCryptOpenAlgorithmProvider',
  'CertOpenStore',
  'CommandLineToArgvW',
  'CreateActCtxW',
  'CreateBoundaryDescriptorW',
  'CreateDesktopW',
  'CreateEventExW',
  'CreateEventW',
  'CreateFileW',
  'CreateFileMappingW',
  'CreateIoCompletionPort',
  'CreateJobObjectW',
  'CreateMailslotW',
  'CreateMutexExW',
  'CreateMutexW',
  'CreateNamedPipeW',
  'CreatePipe',
  'CreatePrivateNamespaceW',
  'CreateProcessAsUserW',
  'CreateProcessWithLogonW',
  'CreateProcessWithTokenW',
  'CreateProcessW',
  'CreateRestrictedToken',
  'CreateSemaphoreExW',
  'CreateSemaphoreW',
  'CreateThread',
  'CreateWaitableTimerExW',
  'CreateWaitableTimerW',
  'CreateWindowStationW',
  'CryptCATAdminAcquireContext',
  'CryptCATAdminAcquireContext2',
  'CryptCATOpen',
  'CryptQueryObject',
  'DuplicateHandle',
  'DuplicateTokenEx',
  'FindFirstChangeNotificationW',
  'FindFirstFileExW',
  'FindFirstFileW',
  'FormatMessageW',
  'GetCurrentProcess',
  'GetCurrentThread',
  'GetModuleHandleW',
  'GetProcessHeap',
  'GetProcessWindowStation',
  'GetStdHandle',
  'GetThreadDesktop',
  'GlobalAlloc',
  'HeapAlloc',
  'InitializeProcThreadAttributeList',
  'LocalAlloc',
  'LogonUserW',
  'MapViewOfFile',
  'NCryptOpenKey',
  'NCryptOpenStorageProvider',
  'OpenDesktopW',
  'OpenEventW',
  'OpenFileMappingW',
  'OpenJobObjectW',
  'OpenMutexW',
  'OpenProcess',
  'OpenProcessToken',
  'OpenPrivateNamespaceW',
  'OpenSemaphoreW',
  'OpenThread',
  'OpenThreadToken',
  'OpenWaitableTimerW',
  'OpenWindowStationW',
  'RegCreateKeyExW',
  'RegOpenKeyExW',
]);

const GUARDED_RELEASE_APIS = new Set([
  'BCryptCloseAlgorithmProvider',
  'BCryptDestroyHash',
  'BCryptDestroyKey',
  'CertCloseStore',
  'CertFreeCertificateContext',
  'ClosePrivateNamespace',
  'CloseDesktop',
  'CloseHandle',
  'CloseWindowStation',
  'CryptCATAdminReleaseContext',
  'CryptCATClose',
  'DeleteBoundaryDescriptor',
  'DeleteProcThreadAttributeList',
  'DestroyEnvironmentBlock',
  'FindClose',
  'FindCloseChangeNotification',
  'FreeLibrary',
  'FreeSid',
  'GlobalFree',
  'HeapFree',
  'LocalFree',
  'NCryptFreeObject',
  'RegCloseKey',
  'ReleaseActCtx',
  'UnmapViewOfFile',
  'VirtualFree',
]);

const FORBIDDEN_DYNAMIC_RESOLUTION_APIS = withWindowsGenericApiAliases([
  'GetProcAddress',
  'LdrGetProcedureAddress',
  'LoadLibraryA',
  'LoadLibraryExA',
  'LoadLibraryExW',
  'LoadPackagedLibrary',
  'LoadLibraryW',
]);

function advanceLineCount(source, start, end, lineState) {
  for (let index = start; index < end; index += 1) {
    if (source.charCodeAt(index) === 0x0a) lineState.line += 1;
  }
}

function tokenizeCpp(source, label) {
  const tokens = [];
  const lineState = { line: 1 };
  let index = 0;
  while (index < source.length) {
    const code = source.charCodeAt(index);
    if (/\s/u.test(source[index])) {
      if (code === 0x0a) lineState.line += 1;
      index += 1;
      continue;
    }
    if (source.startsWith('//', index)) {
      const end = source.indexOf('\n', index + 2);
      index = end < 0 ? source.length : end;
      continue;
    }
    if (source.startsWith('/*', index)) {
      const end = source.indexOf('*/', index + 2);
      if (end < 0) fail('native-guard-lex', `${label}:${lineState.line} has unterminated block comment`);
      advanceLineCount(source, index, end + 2, lineState);
      index = end + 2;
      continue;
    }

    const rawMatch = /^(?:u8|u|U|L)?R"([^\s()\\]{0,16})\(/u.exec(source.slice(index));
    if (rawMatch !== null) {
      const terminator = `)${rawMatch[1]}"`;
      const end = source.indexOf(terminator, index + rawMatch[0].length);
      if (end < 0) fail('native-guard-lex', `${label}:${lineState.line} has unterminated raw literal`);
      const after = end + terminator.length;
      advanceLineCount(source, index, after, lineState);
      index = after;
      continue;
    }

    if (
      source[index] === "'"
      && /[0-9A-Fa-f]/u.test(source[index - 1] ?? '')
      && /[0-9A-Fa-f]/u.test(source[index + 1] ?? '')
    ) {
      tokens.push({ end: index + 1, kind: 'punctuation', line: lineState.line, start: index, value: "'" });
      index += 1;
      continue;
    }

    const quotedMatch = /^(?:u8|u|U|L)?(["'])/u.exec(source.slice(index));
    if (quotedMatch !== null) {
      const quote = quotedMatch[1];
      let cursor = index + quotedMatch[0].length;
      let closed = false;
      while (cursor < source.length) {
        if (source[cursor] === '\\') {
          cursor += 2;
          continue;
        }
        if (source[cursor] === quote) {
          cursor += 1;
          closed = true;
          break;
        }
        if (source[cursor] === '\n') lineState.line += 1;
        cursor += 1;
      }
      if (!closed) fail('native-guard-lex', `${label}:${lineState.line} has unterminated literal`);
      index = cursor;
      continue;
    }

    const identifier = /^[A-Za-z_][A-Za-z0-9_]*/u.exec(source.slice(index));
    if (identifier !== null) {
      tokens.push({
        end: index + identifier[0].length,
        kind: 'identifier',
        line: lineState.line,
        start: index,
        value: identifier[0],
      });
      index += identifier[0].length;
      continue;
    }
    if (source.startsWith('::', index)) {
      tokens.push({ end: index + 2, kind: 'punctuation', line: lineState.line, start: index, value: '::' });
      index += 2;
      continue;
    }
    tokens.push({ end: index + 1, kind: 'punctuation', line: lineState.line, start: index, value: source[index] });
    index += 1;
  }
  return tokens;
}

function findMatchingToken(tokens, openIndex, openValue, closeValue, label) {
  let depth = 0;
  for (let index = openIndex; index < tokens.length; index += 1) {
    if (tokens[index].value === openValue) depth += 1;
    if (tokens[index].value === closeValue) {
      depth -= 1;
      if (depth === 0) return index;
    }
  }
  fail('native-guard-lex', `${label}:${tokens[openIndex].line} has unclosed ${openValue}`);
}

function splitMacroArguments(tokens, openIndex, closeIndex, label) {
  const boundaries = [];
  let parentheses = 0;
  let braces = 0;
  let brackets = 0;
  let start = openIndex + 1;
  for (let index = openIndex + 1; index < closeIndex; index += 1) {
    const value = tokens[index].value;
    if (value === '(') parentheses += 1;
    else if (value === ')') parentheses -= 1;
    else if (value === '{') braces += 1;
    else if (value === '}') braces -= 1;
    else if (value === '[') brackets += 1;
    else if (value === ']') brackets -= 1;
    else if (value === ',' && parentheses === 0 && braces === 0 && brackets === 0) {
      boundaries.push([start, index]);
      start = index + 1;
    }
    if (parentheses < 0 || braces < 0 || brackets < 0) {
      fail('native-guard-lex', `${label}:${tokens[index].line} has unbalanced marker arguments`);
    }
  }
  boundaries.push([start, closeIndex]);
  return boundaries;
}

function siteIdFromMarkerArgument(tokens, start, end, label) {
  const values = tokens.slice(start, end).map((token) => token.value);
  const resourceSiteIndex = values.lastIndexOf('ResourceSiteId');
  if (
    resourceSiteIndex < 0
    || values[resourceSiteIndex + 1] !== '::'
    || resourceSiteIndex + 3 !== values.length
    || !/^[a-z][a-z0-9_]*$/u.test(values[resourceSiteIndex + 2] ?? '')
  ) {
    fail('native-guard-marker', `${label} marker must use ResourceSiteId::<site_id> as its first argument`);
  }
  return values[resourceSiteIndex + 2];
}

function isMacroDefinition(source, token) {
  const lineStart = source.lastIndexOf('\n', token.start - 1) + 1;
  return /^\s*#\s*define\s+$/u.test(source.slice(lineStart, token.start));
}

const NATIVE_GUARD_PROFILES = Object.freeze([
  Object.freeze({
    artifactId: 'qualification',
    defines: new Set(['PCSDK_ARTIFACT_QUALIFICATION', 'PCSDK_QUALIFICATION', '_MSC_VER', '_WIN32']),
    name: 'qualification-windows-msvc',
  }),
  Object.freeze({
    artifactId: 'qualification',
    defines: new Set(['PCSDK_ARTIFACT_QUALIFICATION', 'PCSDK_QUALIFICATION']),
    name: 'qualification-portable',
  }),
  Object.freeze({
    artifactId: 'bootstrap',
    defines: new Set(['PCSDK_ARTIFACT_BOOTSTRAP', '_MSC_VER', '_WIN32']),
    name: 'bootstrap-windows-msvc',
  }),
  Object.freeze({
    artifactId: 'addon',
    defines: new Set(['PCSDK_ARTIFACT_ADDON', '_MSC_VER', '_WIN32']),
    name: 'addon-windows-msvc',
  }),
]);
const NATIVE_GUARD_ALL_PROFILE_MASK = (1 << NATIVE_GUARD_PROFILES.length) - 1;
const NATIVE_GUARD_PROJECT_INCLUDES = new Set([
  'pc_sdk_next/generated/resource_manifest.generated.h',
  'pc_sdk_next/resource.h',
  'pc_sdk_next/resource_manifest.h',
  'pc_sdk_next/resource_state.h',
]);
const NATIVE_GUARD_SYSTEM_INCLUDES = new Set([
  'Windows.h',
  'algorithm',
  'array',
  'atomic',
  'charconv',
  'chrono',
  'concepts',
  'cstddef',
  'cstdint',
  'cstdio',
  'cstdlib',
  'cstring',
  'exception',
  'fcntl.h',
  'functional',
  'io.h',
  'iterator',
  'limits',
  'memory',
  'new',
  'optional',
  'span',
  'string',
  'string_view',
  'thread',
  'type_traits',
  'utility',
  'vector',
]);
const NATIVE_GUARD_RAW_CALL_POLICIES = Object.freeze({
  'CreateEventExW|acquire|win32-event-handle': Object.freeze({
    arguments: Object.freeze([
      Object.freeze(['nullptr']),
      Object.freeze(['nullptr']),
      Object.freeze(['CREATE_EVENT_MANUAL_RESET']),
      Object.freeze(['EVENT_MODIFY_STATE', '|', 'SYNCHRONIZE']),
    ]),
    metadata: Object.freeze({
      inheritable: false,
      ownership: 'owned',
      resourceDomain: 'recyclable-numeric',
      rightsHeld: Object.freeze(['EVENT_MODIFY_STATE', 'SYNCHRONIZE']),
      rightsUsed: Object.freeze(['SYNCHRONIZE']),
    }),
  }),
  'CloseHandle|release|win32-event-handle': Object.freeze({
    arguments: Object.freeze([
      Object.freeze(['reinterpret_cast', '<', 'HANDLE', '>', '(', 'value', ')']),
    ]),
    metadata: Object.freeze({
      ownership: 'owned',
      releaseCompletion: 'positive-nonzero-return',
      resourceDomain: 'recyclable-numeric',
    }),
  }),
  'GetCurrentProcess|no-release|win32-current-process-pseudo-handle': Object.freeze({
    arguments: Object.freeze([]),
    metadata: Object.freeze({
      inheritable: false,
      ownership: 'no-release',
      resourceDomain: 'pseudo',
      rightsHeld: Object.freeze([
        'PROCESS_QUERY_LIMITED_INFORMATION',
        'documented-current-process-pseudo-handle-access',
      ]),
      rightsUsed: Object.freeze(['PROCESS_QUERY_LIMITED_INFORMATION']),
    }),
  }),
  'LocalAlloc|acquire|win32-local-fixed-memory': Object.freeze({
    arguments: Object.freeze([
      Object.freeze(['LMEM_FIXED']),
      Object.freeze(['bytes']),
    ]),
    metadata: Object.freeze({
      inheritable: false,
      ownership: 'owned',
      resourceDomain: 'opaque',
      rightsHeld: Object.freeze(['read-write-local-fixed-block']),
      rightsUsed: Object.freeze(['read-write-local-fixed-block']),
    }),
  }),
  'LocalFree|release|win32-local-fixed-memory': Object.freeze({
    arguments: Object.freeze([
      Object.freeze(['reinterpret_cast', '<', 'HLOCAL', '>', '(', 'value', ')']),
    ]),
    metadata: Object.freeze({
      ownership: 'owned',
      releaseCompletion: 'null-return',
      resourceDomain: 'opaque',
    }),
  }),
});

function nativeGuardConditionMask(expression, label, line) {
  const compact = expression.replace(/\s+/gu, '');
  const namedDefine = /^defined\(([A-Za-z_][A-Za-z0-9_]*)\)$/u.exec(compact);
  const negatedDefine = /^!defined\(([A-Za-z_][A-Za-z0-9_]*)\)$/u.exec(compact);
  const qualificationPortable = compact ===
    'defined(PCSDK_QUALIFICATION)&&!defined(_WIN32)';
  const oneArtifact = compact ===
    '(defined(PCSDK_ARTIFACT_BOOTSTRAP)+defined(PCSDK_ARTIFACT_ADDON)+defined(PCSDK_ARTIFACT_QUALIFICATION))!=1';
  const admittedNames = new Set([
    'PCSDK_ARTIFACT_ADDON',
    'PCSDK_ARTIFACT_BOOTSTRAP',
    'PCSDK_ARTIFACT_QUALIFICATION',
    'PCSDK_QUALIFICATION',
    '_MSC_VER',
    '_WIN32',
  ]);
  if (
    (namedDefine !== null && admittedNames.has(namedDefine[1]))
    || (negatedDefine !== null && admittedNames.has(negatedDefine[1]))
    || qualificationPortable
    || oneArtifact
  ) {
    let mask = 0;
    for (let index = 0; index < NATIVE_GUARD_PROFILES.length; index += 1) {
      const profile = NATIVE_GUARD_PROFILES[index];
      let matches;
      if (namedDefine !== null) matches = profile.defines.has(namedDefine[1]);
      else if (negatedDefine !== null) matches = !profile.defines.has(negatedDefine[1]);
      else if (qualificationPortable) {
        matches = profile.defines.has('PCSDK_QUALIFICATION') && !profile.defines.has('_WIN32');
      } else {
        const count = [
          'PCSDK_ARTIFACT_BOOTSTRAP',
          'PCSDK_ARTIFACT_ADDON',
          'PCSDK_ARTIFACT_QUALIFICATION',
        ].filter((name) => profile.defines.has(name)).length;
        matches = count !== 1;
      }
      if (matches) mask |= 1 << index;
    }
    return mask;
  }
  fail(
    'native-guard-preprocessor',
    `${label}:${line} uses a conditional outside the exact sealed build profiles`,
  );
}

function nativeGuardLineProfileMasks(source, label, tokens) {
  const masks = [];
  const stack = [];
  let activeMask = NATIVE_GUARD_ALL_PROFILE_MASK;
  const lines = source.split('\n');
  const firstTokenByLine = new Map();
  for (const token of tokens) {
    if (!firstTokenByLine.has(token.line)) firstTokenByLine.set(token.line, token);
  }
  const directiveLines = new Set(
    [...firstTokenByLine.entries()]
      .filter(([, token]) => token.value === '#')
      .map(([line]) => line),
  );
  for (let index = 0; index < lines.length; index += 1) {
    const lineNumber = index + 1;
    const line = lines[index].replace(/\r$/u, '');
    masks[lineNumber] = activeMask;
    if (line.endsWith('\\')) {
      const exactMarkerDefinition =
        /^\s*#\s*define\s+PCSDK_RESOURCE_(?:ACQUIRE|BORROW|NO_RELEASE|RELEASE)\(site,\s*expression\)\s*\\$/u
          .test(line);
      if (!exactMarkerDefinition) {
        fail(
          'native-guard-line-splice',
          `${label}:${lineNumber} uses a line splice outside an exact resource marker definition`,
        );
      }
    }
    if (!directiveLines.has(lineNumber)) continue;
    const directive = /^\s*#\s*([A-Za-z_][A-Za-z0-9_]*)(.*)$/u.exec(line);
    if (directive === null) {
      fail('native-guard-preprocessor', `${label}:${lineNumber} has a malformed directive`);
    }
    const name = directive[1];
    const argument = directive[2].trim();
    if (name === 'if' || name === 'ifdef' || name === 'ifndef') {
      const expression = name === 'if'
        ? argument
        : `${name === 'ifndef' ? '!' : ''}defined(${argument})`;
      const conditionMask = nativeGuardConditionMask(expression, label, lineNumber);
      const selectedMask = activeMask & conditionMask;
      stack.push({ elseSeen: false, parentMask: activeMask, takenMask: selectedMask });
      activeMask = selectedMask;
    } else if (name === 'elif') {
      const frame = stack.at(-1);
      if (frame === undefined || frame.elseSeen) {
        fail('native-guard-preprocessor', `${label}:${lineNumber} has an unmatched #elif`);
      }
      const conditionMask = nativeGuardConditionMask(argument, label, lineNumber);
      activeMask = frame.parentMask & ~frame.takenMask & conditionMask;
      frame.takenMask |= activeMask;
    } else if (name === 'else') {
      const frame = stack.at(-1);
      if (frame === undefined || frame.elseSeen || argument !== '') {
        fail('native-guard-preprocessor', `${label}:${lineNumber} has an invalid #else`);
      }
      frame.elseSeen = true;
      activeMask = frame.parentMask & ~frame.takenMask & NATIVE_GUARD_ALL_PROFILE_MASK;
      frame.takenMask |= activeMask;
    } else if (name === 'endif') {
      const frame = stack.pop();
      if (frame === undefined || argument !== '') {
        fail('native-guard-preprocessor', `${label}:${lineNumber} has an invalid #endif`);
      }
      activeMask = frame.parentMask;
    } else if (name === 'define') {
      if (
        argument !== 'WIN32_LEAN_AND_MEAN'
        && !/^PCSDK_RESOURCE_(?:ACQUIRE|BORROW|NO_RELEASE|RELEASE)\(site,\s*expression\)\s*\\$/u.test(argument)
      ) {
        fail('native-guard-preprocessor', `${label}:${lineNumber} has an unsealed macro definition`);
      }
    } else if (name === 'undef' || name === 'line') {
      fail('native-guard-preprocessor', `${label}:${lineNumber} uses forbidden #${name}`);
    } else if (name === 'include') {
      const projectInclude = /^"([^"]+)"$/u.exec(argument);
      const systemInclude = /^<([^>]+)>$/u.exec(argument);
      if (
        (projectInclude === null || !NATIVE_GUARD_PROJECT_INCLUDES.has(projectInclude[1]))
        && (systemInclude === null || !NATIVE_GUARD_SYSTEM_INCLUDES.has(systemInclude[1]))
      ) {
        fail(
          'native-guard-include',
          `${label}:${lineNumber} includes a file outside the exact sealed header closure`,
        );
      }
    } else if (name === 'pragma') {
      if (argument !== 'once' && argument !== 'section(".rdata$PCSDKRM", read)') {
        fail('native-guard-preprocessor', `${label}:${lineNumber} uses an unsealed pragma`);
      }
    } else if (name === 'error') {
      if (
        argument !==
          '"Define exactly one PCSDK_ARTIFACT_BOOTSTRAP, PCSDK_ARTIFACT_ADDON, or PCSDK_ARTIFACT_QUALIFICATION"'
      ) {
        fail('native-guard-preprocessor', `${label}:${lineNumber} uses an unsealed #error`);
      }
    } else {
      fail('native-guard-preprocessor', `${label}:${lineNumber} uses unsupported #${name}`);
    }
  }
  if (stack.length !== 0) {
    fail('native-guard-preprocessor', `${label} has an unterminated conditional directive`);
  }
  return masks;
}

function nativeGuardSiteProfileMask(site) {
  let mask = 0;
  for (let index = 0; index < NATIVE_GUARD_PROFILES.length; index += 1) {
    if (site.artifactIds.includes(NATIVE_GUARD_PROFILES[index].artifactId)) mask |= 1 << index;
  }
  return mask;
}

function assertNativeGuardRawCallPolicy({ api, label, marker, tokenIndex, tokens }) {
  const policyKey = `${api}|${marker.kind}|${marker.site.resourceType}`;
  const policy = NATIVE_GUARD_RAW_CALL_POLICIES[policyKey];
  if (policy === undefined) {
    fail(
      'native-guard-api-policy',
      `${label} has no exact argument/metadata policy for ${policyKey}`,
    );
  }
  for (const [field, expected] of Object.entries(policy.metadata)) {
    const observed = marker.site[field];
    const equal = Array.isArray(expected)
      ? Array.isArray(observed)
        && observed.length === expected.length
        && observed.every((entry, index) => entry === expected[index])
      : observed === expected;
    if (!equal) {
      fail(
        'native-guard-api-metadata',
        `${label} ${api} arguments do not bind the registry's ${field} metadata`,
      );
    }
  }
  const closeIndex = findMatchingToken(tokens, tokenIndex + 1, '(', ')', label);
  const argumentRanges = tokenIndex + 2 === closeIndex
    ? []
    : splitMacroArguments(tokens, tokenIndex + 1, closeIndex, label);
  const observedArguments = argumentRanges.map(([start, end]) =>
    tokens.slice(start, end).map((token) => token.value));
  if (
    observedArguments.length !== policy.arguments.length
    || observedArguments.some((argument, index) =>
      argument.length !== policy.arguments[index].length
      || argument.some((token, tokenIndexWithinArgument) =>
        token !== policy.arguments[index][tokenIndexWithinArgument]))
  ) {
    fail(
      'native-guard-api-arguments',
      `${label} ${api} call differs from its exact sealed argument policy`,
    );
  }
}

function markerMatchesAnchor(tokens, marker, anchor) {
  for (let index = 0; index < marker.tokenIndex; index += 1) {
    if (tokens[index].value !== anchor || tokens[index + 1]?.value !== '(') continue;
    if (['.', '->', '::'].includes(tokens[index - 1]?.value)) continue;
    const parameterClose = findMatchingToken(tokens, index + 1, '(', ')', anchor);
    let braceOpen = parameterClose + 1;
    if (tokens[braceOpen]?.value === 'noexcept') {
      braceOpen += 1;
      if (tokens[braceOpen]?.value === '(') {
        braceOpen = findMatchingToken(tokens, braceOpen, '(', ')', anchor) + 1;
      }
    }
    if (tokens[braceOpen]?.value !== '{') continue;
    const braceClose = findMatchingToken(tokens, braceOpen, '{', '}', anchor);
    if (braceOpen < marker.tokenIndex && marker.tokenIndex < braceClose) return true;
  }
  return false;
}

export function inspectNativeResourceSource({ logicalPath, registry: registryInput, source }) {
  const registry = validateResourceSiteRegistry(registryInput);
  assertTranslationUnit(logicalPath, 'native source logicalPath');
  if (typeof source !== 'string' || Buffer.byteLength(source, 'utf8') > MAX_NATIVE_GUARD_FILE_BYTES) {
    fail('native-guard-size', `${logicalPath} is outside the native source byte bound`);
  }
  if (source.includes('\0')) fail('native-guard-nul', `${logicalPath} contains NUL`);
  const tokens = tokenizeCpp(source, logicalPath);
  const lineProfileMasks = nativeGuardLineProfileMasks(source, logicalPath, tokens);
  const sitesById = new Map(registry.sites.map((site) => [site.siteId, site]));
  const acquisitionApis = new Set([
    ...GUARDED_ACQUISITION_APIS,
    ...registry.sites
      .map((site) => site.acquisitionApi)
      .filter((api) => !api.startsWith('borrow:')),
  ]);
  const releaseApis = new Set([
    ...GUARDED_RELEASE_APIS,
    ...registry.sites.map((site) => site.releaseApi).filter((api) => api !== null),
  ]);
  const markers = [];

  for (let tokenIndex = 0; tokenIndex < tokens.length; tokenIndex += 1) {
    const token = tokens[tokenIndex];
    const markerKind = RESOURCE_MARKERS[token.value];
    if (markerKind === undefined || isMacroDefinition(source, token)) continue;
    if (tokens[tokenIndex + 1]?.value !== '(') {
      fail('native-guard-marker', `${logicalPath}:${token.line} resource marker is not invoked`);
    }
    const closeIndex = findMatchingToken(tokens, tokenIndex + 1, '(', ')', logicalPath);
    const argumentsFound = splitMacroArguments(tokens, tokenIndex + 1, closeIndex, logicalPath);
    if (argumentsFound.length !== 2 || argumentsFound.some(([start, end]) => start === end)) {
      fail('native-guard-marker', `${logicalPath}:${token.line} resource marker requires exactly two arguments`);
    }
    const siteId = siteIdFromMarkerArgument(
      tokens,
      argumentsFound[0][0],
      argumentsFound[0][1],
      `${logicalPath}:${token.line}`,
    );
    const site = sitesById.get(siteId);
    if (site === undefined) {
      fail('native-guard-unregistered-site', `${logicalPath}:${token.line} marker names unknown site ${siteId}`);
    }
    if (site.translationUnit !== logicalPath) {
      fail('native-guard-callsite', `${logicalPath}:${token.line} marker ${siteId} is outside its registered translation unit`);
    }
    const profileMask = lineProfileMasks[token.line] ?? 0;
    const siteProfileMask = nativeGuardSiteProfileMask(site);
    if ((profileMask & siteProfileMask) === 0) {
      fail(
        'native-guard-inactive-marker',
        `${logicalPath}:${token.line} marker ${siteId} is inactive in every sealed artifact profile`,
      );
    }
    if ((profileMask & ~siteProfileMask) !== 0) {
      fail(
        'native-guard-artifact-escape',
        `${logicalPath}:${token.line} marker ${siteId} is active outside its registered artifact profiles`,
      );
    }
    const expectedKind = site.ownership === 'owned'
      ? markerKind === 'release' ? 'release' : 'acquire'
      : site.ownership === 'borrowed' ? 'borrow' : 'no-release';
    if (markerKind !== expectedKind) {
      fail('native-guard-ownership', `${logicalPath}:${token.line} ${token.value} is incompatible with ${site.ownership} site ${siteId}`);
    }
    markers.push({
      closeIndex,
      end: tokens[argumentsFound[1][1] - 1].end,
      kind: markerKind,
      line: token.line,
      rawCalls: [],
      profileMask,
      site,
      siteId,
      start: tokens[argumentsFound[1][0]].start,
      tokenIndex,
    });
    tokenIndex = closeIndex;
  }

  const rawCalls = [];
  for (let tokenIndex = 0; tokenIndex < tokens.length; tokenIndex += 1) {
    const token = tokens[tokenIndex];
    if (token.kind !== 'identifier') continue;
    const api = token.value;
    if (FORBIDDEN_DYNAMIC_RESOLUTION_APIS.has(api)) {
      fail('native-guard-dynamic-resolution', `${logicalPath}:${token.line} references forbidden dynamic resolver ${api}`);
    }
    const acquisition = acquisitionApis.has(api);
    const release = releaseApis.has(api);
    if (!acquisition && !release) continue;
    if (tokens[tokenIndex + 1]?.value !== '(') {
      fail(
        'native-guard-api-reference',
        `${logicalPath}:${token.line} references guarded API ${api} outside an exact direct call`,
      );
    }
    if (
      tokens[tokenIndex - 1]?.value !== '::'
      || tokens[tokenIndex - 2]?.kind === 'identifier'
    ) {
      fail(
        'native-guard-api-reference',
        `${logicalPath}:${token.line} guarded API ${api} must use an exact global-scope direct call`,
      );
    }
    const enclosing = markers.filter((marker) => marker.start <= token.start && token.end <= marker.end);
    if (enclosing.length !== 1) {
      fail('native-guard-raw-call', `${logicalPath}:${token.line} raw ${api} call is not inside exactly one resource marker`);
    }
    const [marker] = enclosing;
    if (
      release
        ? marker.kind !== 'release' || marker.site.releaseApi !== api
        : !['acquire', 'no-release'].includes(marker.kind) || marker.site.acquisitionApi !== api
    ) {
      fail('native-guard-api-binding', `${logicalPath}:${token.line} raw ${api} call does not match site ${marker.siteId}`);
    }
    assertNativeGuardRawCallPolicy({
      api,
      label: `${logicalPath}:${token.line}`,
      marker,
      tokenIndex,
      tokens,
    });
    marker.rawCalls.push(api);
    rawCalls.push(Object.freeze({ api, kind: release ? 'release' : 'acquisition', line: token.line, siteId: marker.siteId }));
  }

  for (const marker of markers) {
    if (marker.kind === 'borrow') {
      if (marker.rawCalls.length !== 0) {
        fail('native-guard-borrow-call', `${logicalPath}:${marker.line} borrowed marker may not acquire/release`);
      }
    } else if (marker.rawCalls.length > 1) {
      fail('native-guard-marker-call-count', `${logicalPath}:${marker.line} ${marker.kind} marker contains multiple raw API calls`);
    }
    if (marker.kind !== 'release' && !markerMatchesAnchor(tokens, marker, marker.site.callsiteAnchor)) {
      fail('native-guard-callsite', `${logicalPath}:${marker.line} ${marker.siteId} is outside ${marker.site.callsiteAnchor}`);
    }
  }

  return Object.freeze({
    logicalPath,
    markers: Object.freeze(markers.map((marker) => Object.freeze({
      kind: marker.kind,
      line: marker.line,
      profileMask: marker.profileMask,
      rawCallCount: marker.rawCalls.length,
      siteId: marker.siteId,
    }))),
    rawCalls: Object.freeze(rawCalls),
  });
}

export function assertNativeResourceSourceGuard({ registry: registryInput, sources }) {
  const registry = validateResourceSiteRegistry(registryInput);
  if (!Array.isArray(sources) || sources.length === 0 || sources.length > MAX_NATIVE_GUARD_FILES) {
    fail('native-guard-files', 'native source guard requires a nonempty bounded source list');
  }
  const logicalPaths = sources.map((source) => source.logicalPath);
  if (new Set(logicalPaths).size !== logicalPaths.length) {
    fail('native-guard-duplicate-file', 'native source guard input repeats a logical path');
  }
  const sortedPaths = [...logicalPaths].sort(ordinalCompare);
  if (logicalPaths.some((logicalPath, index) => logicalPath !== sortedPaths[index])) {
    fail('native-guard-file-order', 'native source guard input must use strict ordinal logical-path order');
  }
  const totalBytes = sources.reduce(
    (total, source) => total + (typeof source.source === 'string' ? Buffer.byteLength(source.source, 'utf8') : 0),
    0,
  );
  if (totalBytes > MAX_NATIVE_GUARD_TOTAL_BYTES) {
    fail('native-guard-size', 'native source guard input exceeds its total byte bound');
  }
  const inspections = sources.map((source) => inspectNativeResourceSource({ ...source, registry }));
  const markers = inspections.flatMap((inspection) => inspection.markers);
  for (const site of registry.sites) {
    const expectedPrimary = site.ownership === 'owned'
      ? 'acquire'
      : site.ownership === 'borrowed' ? 'borrow' : 'no-release';
    const primary = markers.filter((marker) => marker.siteId === site.siteId
      && marker.kind === expectedPrimary
      && (marker.kind === 'borrow' || marker.rawCallCount === 1));
    if (primary.length !== 1) {
      fail('native-guard-site-closure', `site ${site.siteId} must have exactly one ${expectedPrimary} marker; observed ${primary.length}`);
    }
    const releases = markers.filter((marker) => marker.siteId === site.siteId
      && marker.kind === 'release'
      && marker.rawCallCount === 1);
    const expectedReleases = site.ownership === 'owned' ? 1 : 0;
    if (releases.length !== expectedReleases) {
      fail('native-guard-site-closure', `site ${site.siteId} must have ${expectedReleases} release marker(s); observed ${releases.length}`);
    }
    const siteProfileMask = nativeGuardSiteProfileMask(site);
    for (let profileIndex = 0; profileIndex < NATIVE_GUARD_PROFILES.length; profileIndex += 1) {
      const profileBit = 1 << profileIndex;
      if ((siteProfileMask & profileBit) === 0) continue;
      const profile = NATIVE_GUARD_PROFILES[profileIndex];
      const profilePrimary = markers.filter((marker) => marker.siteId === site.siteId
        && marker.kind === expectedPrimary
        && (marker.profileMask & profileBit) !== 0);
      if (profilePrimary.length !== 1) {
        fail(
          'native-guard-profile-closure',
          `site ${site.siteId} must have exactly one ${expectedPrimary} marker in ${profile.name}; observed ${profilePrimary.length}`,
        );
      }
      const profileReleases = markers.filter((marker) => marker.siteId === site.siteId
        && marker.kind === 'release'
        && (marker.profileMask & profileBit) !== 0);
      if (profileReleases.length !== expectedReleases) {
        fail(
          'native-guard-profile-closure',
          `site ${site.siteId} must have ${expectedReleases} release marker(s) in ${profile.name}; observed ${profileReleases.length}`,
        );
      }
    }
  }
  return Object.freeze({
    fileCount: inspections.length,
    markerCount: markers.length,
    rawCallCount: inspections.reduce((total, inspection) => total + inspection.rawCalls.length, 0),
    siteCount: registry.sites.length,
  });
}

async function collectNativeSourcePaths(directory, result = []) {
  const entries = await readdir(directory, { withFileTypes: true });
  entries.sort((left, right) => ordinalCompare(left.name, right.name));
  for (const entry of entries) {
    const absolutePath = path.join(directory, entry.name);
    if (entry.isSymbolicLink()) fail('native-guard-symlink', `${absolutePath} must not be a symbolic link`);
    if (entry.isDirectory()) {
      await collectNativeSourcePaths(absolutePath, result);
    } else if (entry.isFile() && /\.(?:cc|h)$/u.test(entry.name)) {
      result.push(absolutePath);
    }
  }
  return result;
}

export async function loadNativeResourceGuardSources(
  nativeRoot = path.join(PACKAGE_DIRECTORY, 'native'),
) {
  const paths = await collectNativeSourcePaths(nativeRoot);
  const sources = [];
  for (const absolutePath of paths) {
    const metadata = await lstat(absolutePath);
    if (!metadata.isFile() || metadata.isSymbolicLink() || metadata.size > MAX_NATIVE_GUARD_FILE_BYTES) {
      fail('native-guard-file', `${absolutePath} is not an admitted ordinary bounded source`);
    }
    const source = await readFile(absolutePath, 'utf8');
    const relative = path.relative(PACKAGE_DIRECTORY, absolutePath).split(path.sep).join('/');
    sources.push({ logicalPath: `packages/windows-containment/${relative}`, source });
  }
  sources.sort((left, right) => ordinalCompare(left.logicalPath, right.logicalPath));
  return sources;
}

export async function checkResourceManifestArtifacts({
  registryPath = DEFAULT_RESOURCE_SITE_REGISTRY_PATH,
  headerPath = DEFAULT_GENERATED_RESOURCE_MANIFEST_HEADER_PATH,
  nativeRoot = path.join(PACKAGE_DIRECTORY, 'native'),
} = {}) {
  const header = await checkGeneratedResourceManifestHeader({ headerPath, registryPath });
  const registry = await loadResourceSiteRegistry(registryPath);
  const sources = await loadNativeResourceGuardSources(nativeRoot);
  const sourceGuard = assertNativeResourceSourceGuard({ registry, sources });
  return Object.freeze({ header, sourceGuard });
}

function parseCliArguments(argv) {
  if (argv.length !== 1 || !['--check', '--write'].includes(argv[0])) {
    fail('invalid-arguments', 'usage: node build/resource-manifest.mjs --check|--write');
  }
  return argv[0];
}

async function main(argv = process.argv.slice(2)) {
  const mode = parseCliArguments(argv);
  const result = mode === '--write'
    ? await writeGeneratedResourceManifestHeader()
    : await checkResourceManifestArtifacts();
  process.stdout.write(`${canonicalJsonBytes({
    action: mode === '--write' ? 'resource-manifest-written' : 'resource-manifest-checked',
    result,
  }).toString('utf8')}\n`);
}

const invokedPath = process.argv[1] === undefined ? '' : path.resolve(process.argv[1]);
if (invokedPath === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    const code = error instanceof ResourceManifestError ? error.code : 'unexpected-error';
    process.stderr.write(`${canonicalJsonBytes({
      code,
      message: error instanceof Error ? error.message : String(error),
      outcome: 'failed',
    }).toString('utf8')}\n`);
    process.exitCode = 1;
  });
}
