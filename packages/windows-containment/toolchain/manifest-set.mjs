import { createHash } from 'node:crypto';
import { constants as fsConstants } from 'node:fs';
import {
  lstat,
  mkdir,
  open,
  readFile,
  readdir,
  realpath,
  rename,
  rm,
  unlink,
  writeFile,
} from 'node:fs/promises';
import path from 'node:path';
import { TextDecoder } from 'node:util';

import {
  countPresealPayloadMembers,
  MAX_PRESEAL_PAYLOAD_MEMBERS,
  PRESEAL_CONFIG_AUTHORITY_PROJECTION_ALGORITHM,
  presealConfigAuthorityProjection,
} from './preseal-config-projection.mjs';

export const CONFIG_SCHEMA_VERSION = 'pc-sdk.cx-004.native-build-input-config.v1';
export const ROOT_SCHEMA_VERSION = 'pc-sdk.cx-004.native-build-input.v2';
export const SHARD_SCHEMA_VERSION = 'pc-sdk.cx-004.native-build-input-files.v1';
export const ROOT_CLASSIFICATION = 'cx-004-native-build-input';
export const SHARD_CLASSIFICATION = 'cx-004-native-build-input-files';
export const HOST_TOOLCHAIN_METADATA_SCHEMA_VERSION =
  'pc-sdk.cx-004.native-build-input-host-toolchain.v1';
export const HOST_TOOLCHAIN_METADATA_CLASSIFICATION =
  'cx-004-native-build-input-host-toolchain';
export const ROOT_FILE_NAME = 'CX-004-native-build-input.json';
export const SHARD_FILE_PREFIX = 'CX-004-native-build-input-files-';
export const HOST_TOOLCHAIN_METADATA_FILE_PREFIX =
  'CX-004-native-build-input-host-toolchain-';
export const MAX_MANIFEST_BYTES = 384 * 1024;
export const MAX_MANIFEST_MEMBERS = 4096;
export const MAX_FILES_PER_SHARD = 384;
export const MAX_AUXILIARY_MANIFESTS = 256;
export const MAX_LOGICAL_PATH_BYTES = 4096;
export const MAX_CONFIG_BYTES = 384 * 1024;
export const MAX_CONFIG_MEMBERS = 16384;
export const MAX_CONFIG_DEPTH = 64;
export const CX004_HOST_TOOLCHAIN_SHA256 =
  '792a1be5f10a91a684e814b8aca2eb494776a94f289b697a66cf481feb23d290';
const CX004_ARTIFACT_POLICIES_SHA256 =
  'f473003d7daea62a091eb844dd784f02d60fef3821d7bfe0f7dc719b924cf537';
const CX004_COMPACT_ARTIFACT_POLICIES_SHA256 =
  '2adc429682a325cc50dde9d33515b3136d221db87fbc5d0c11e5095390fb39ef';
const CX004_SCOPE = Object.freeze({
  classification: 'tracked-pre-code-native-build-input-root',
  conclusion: 'fake lab input only; product source remains held until this exact seal guarded-lands',
  externalPmWrites: false,
  manifestFrameBytesMaximum: 393216,
  productionAdmission: false,
  productionComposition: false,
  providerProcesses: false,
  shardEntriesMaximum: 384,
  sourceImplementationIncluded: false,
  stableRepositoryMutation: false,
});

export const PRESEAL_PAYLOAD_SCHEMA_VERSION = 'pc-sdk.cx-004.preseal-evidence-payload.v2';
export const PRESEAL_ROOT_SCHEMA_VERSION = 'pc-sdk.cx-004.preseal-evidence-root.v2';
export const PRESEAL_BINDING_POLICY = 'root-payload-v2-config-projection-v1';
export const CX004_PRESEAL_COMMAND_COUNT = 54;
export const CX004_PRESEAL_GIT_TRACE_COUNT = 21;
export const MAX_PRESEAL_PAYLOAD_BYTES = 256 * 1024;
export const MAX_PRESEAL_ROOT_BYTES = 16 * 1024;

const CX004_T0_TRACKED_INPUT_PATHS = Object.freeze([
  'docs/execution/receipts/CX-004-Q0S.md',
  'docs/execution/slices/CX-004.md',
  'docs/current-state.md',
  'docs/execution/current.md',
  'package.json',
  'apps/server/package.json',
  'packages/db/package.json',
]);

export const CANONICAL_ENCODING = Object.freeze({
  bom: false,
  characterEncoding: 'UTF-8',
  jsonForm: 'compact-recursively-key-sorted',
  lineBreaks: false,
  terminalNewline: false,
});

const UTF8 = new TextDecoder('utf-8', { fatal: true });
const SHA256_PATTERN = /^[0-9a-f]{64}$/u;
const SURFACE_ID_PATTERN = /^[a-z0-9][a-z0-9._-]{0,95}$/u;
const WINDOWS_ABSOLUTE_PATTERN = /(?:^|[^A-Za-z0-9+.-])(?:[a-z]:[\\/]|\\\\)/iu;
const SENSITIVE_ENVIRONMENT_NAMES = [
  'USERPROFILE',
  'LOCALAPPDATA',
  'APPDATA',
  'HOME',
];
const LOCATION_ENVIRONMENT_ALLOWLIST = new Map([
  ['localappdata', 'LOCALAPPDATA'],
  ['programdata', 'ProgramData'],
  ['programfiles', 'ProgramFiles'],
  ['programfiles(x86)', 'ProgramFiles(x86)'],
  ['systemroot', 'SystemRoot'],
]);
const RESERVED_WINDOWS_BASENAMES = new Set([
  'CON',
  'PRN',
  'AUX',
  'NUL',
  'COM1',
  'COM2',
  'COM3',
  'COM4',
  'COM5',
  'COM6',
  'COM7',
  'COM8',
  'COM9',
  'LPT1',
  'LPT2',
  'LPT3',
  'LPT4',
  'LPT5',
  'LPT6',
  'LPT7',
  'LPT8',
  'LPT9',
]);

const ROOT_KEYS = [
  'artifactPolicies',
  'auxiliaryManifests',
  'buildRecipes',
  'canonicalEncoding',
  'classification',
  'hostToolchain',
  'manifestSetId',
  'observations',
  'officialInputs',
  'packageResolution',
  'provenance',
  'runnerIdentity',
  'schemaVersion',
  'scope',
  'surfaces',
];
const ROOT_METADATA_KEYS = [
  'artifactPolicies',
  'buildRecipes',
  'hostToolchain',
  'observations',
  'officialInputs',
  'packageResolution',
  'provenance',
  'runnerIdentity',
  'scope',
];
const SHARD_KEYS = [
  'classification',
  'files',
  'manifestSetId',
  'schemaVersion',
  'shardCount',
  'shardIndex',
  'surfaceId',
];
const AUXILIARY_FIELDS = ['byteLength', 'fileName', 'sha256', 'surfaceId'];
const SURFACE_FIELDS = ['byteLength', 'fileCount', 'shardCount', 'surfaceId', 'surfaceSha256'];
const FIXED_ROW_SET_KEYS = ['fields', 'rows'];
const PACKED_RECORD_SET_KEYS = ['encoding', 'fields', 'rows'];
const PACKED_RECORD_SET_ENCODING =
  'presence-bitmap-v1; bit i maps fields[i]; values follow present fields in field order';
const CONFIG_KEYS = [
  'locations',
  'manifestSetId',
  'output',
  'privacy',
  'root',
  'schemaVersion',
  'surfaces',
];

function fail(message) {
  throw new Error(message);
}

function isPlainObject(value) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    return false;
  }
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function assertPlainObject(value, label) {
  if (!isPlainObject(value)) {
    fail(`${label} must be a plain object`);
  }
}

function ordinalCompare(left, right) {
  return left < right ? -1 : left > right ? 1 : 0;
}

function assertExactKeys(value, expected, label) {
  assertPlainObject(value, label);
  const actual = Object.keys(value).sort(ordinalCompare);
  const wanted = [...expected].sort(ordinalCompare);
  if (actual.length !== wanted.length || actual.some((key, index) => key !== wanted[index])) {
    fail(`${label} keys must be exactly [${wanted.join(', ')}]; received [${actual.join(', ')}]`);
  }
}

function assertAllowedKeys(value, allowed, required, label) {
  assertPlainObject(value, label);
  const actual = Object.keys(value);
  for (const key of actual) {
    if (!allowed.includes(key)) {
      fail(`${label} contains unsupported key ${JSON.stringify(key)}`);
    }
  }
  for (const key of required) {
    if (!Object.hasOwn(value, key)) {
      fail(`${label} is missing required key ${JSON.stringify(key)}`);
    }
  }
}

function assertUnicodeScalarString(value, label) {
  if (typeof value !== 'string') {
    fail(`${label} must be a string`);
  }
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = value.charCodeAt(index + 1);
      if (!(next >= 0xdc00 && next <= 0xdfff)) {
        fail(`${label} contains an unpaired high surrogate`);
      }
      index += 1;
    } else if (code >= 0xdc00 && code <= 0xdfff) {
      fail(`${label} contains an unpaired low surrogate`);
    }
  }
}

function canonicalStringify(value, label, ancestors) {
  if (value === null || typeof value === 'boolean') {
    return JSON.stringify(value);
  }
  if (typeof value === 'string') {
    assertUnicodeScalarString(value, label);
    return JSON.stringify(value);
  }
  if (typeof value === 'number') {
    if (!Number.isSafeInteger(value) || Object.is(value, -0)) {
      fail(`${label} numbers must be non-negative-zero safe integers`);
    }
    return JSON.stringify(value);
  }
  if (typeof value !== 'object') {
    fail(`${label} contains unsupported ${typeof value} value`);
  }
  if (ancestors.has(value)) {
    fail(`${label} contains a cycle`);
  }
  ancestors.add(value);
  try {
    if (Array.isArray(value)) {
      return `[${value.map(
        (entry, index) => canonicalStringify(entry, `${label}[${index}]`, ancestors),
      ).join(',')}]`;
    }
    assertPlainObject(value, label);
    if (Object.getOwnPropertySymbols(value).length !== 0) {
      fail(`${label} contains symbol keys`);
    }
    const members = [];
    for (const key of Object.keys(value).sort(ordinalCompare)) {
      assertUnicodeScalarString(key, `${label} key`);
      members.push(`${JSON.stringify(key)}:${canonicalStringify(value[key], `${label}.${key}`, ancestors)}`);
    }
    return `{${members.join(',')}}`;
  } finally {
    ancestors.delete(value);
  }
}

export function canonicalJsonBytes(value) {
  const text = canonicalStringify(value, 'canonical JSON', new WeakSet());
  const bytes = Buffer.from(text, 'utf8');
  if (bytes.includes(0x00) || bytes.includes(0x0a) || bytes.includes(0x0d)) {
    fail('canonical JSON bytes must not contain NUL, CR, or LF');
  }
  if (bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) {
    fail('canonical JSON bytes must not contain a UTF-8 BOM');
  }
  return bytes;
}

export function sha256Bytes(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}

export function presealConfigAuthorityIdentity(config) {
  const bytes = canonicalJsonBytes(presealConfigAuthorityProjection(config));
  return {
    algorithm: PRESEAL_CONFIG_AUTHORITY_PROJECTION_ALGORITHM,
    bytes: bytes.length,
    sha256: sha256Bytes(bytes),
  };
}

function countMembers(value) {
  return countPresealPayloadMembers(value);
}

function assertManifestBounds(value, bytes, label, limits) {
  if (bytes.length === 0 || bytes.length > limits.maxManifestBytes) {
    fail(`${label} byte length ${bytes.length} exceeds 1..${limits.maxManifestBytes}`);
  }
  const members = countMembers(value);
  if (members > limits.maxManifestMembers) {
    fail(`${label} recursive member count ${members} exceeds ${limits.maxManifestMembers}`);
  }
}

function decodeCanonicalJsonBytesWithLimits(bytes, label, effective) {
  if (!Buffer.isBuffer(bytes)) {
    fail(`${label} bytes must be a Buffer`);
  }
  if (bytes.length === 0 || bytes.length > effective.maxManifestBytes) {
    fail(`${label} byte length ${bytes.length} exceeds 1..${effective.maxManifestBytes}`);
  }
  if (bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) {
    fail(`${label} must not have a UTF-8 BOM`);
  }
  if (bytes.includes(0x00) || bytes.includes(0x0a) || bytes.includes(0x0d)) {
    fail(`${label} must be one line with no NUL, CR, or LF bytes`);
  }
  let text;
  try {
    text = UTF8.decode(bytes);
  } catch (error) {
    fail(`${label} is not valid UTF-8: ${error.message}`);
  }
  let value;
  try {
    value = JSON.parse(text);
  } catch (error) {
    fail(`${label} is not valid JSON: ${error.message}`);
  }
  const canonical = canonicalJsonBytes(value);
  if (!bytes.equals(canonical)) {
    fail(`${label} is not exact compact recursively key-sorted canonical JSON`);
  }
  assertManifestBounds(value, bytes, label, effective);
  return value;
}

export function decodeCanonicalJsonBytes(bytes, label = 'manifest', limits = {}) {
  return decodeCanonicalJsonBytesWithLimits(bytes, label, effectiveLimits(limits));
}

export async function readCanonicalJsonFile(filePath, label = filePath, limits = {}) {
  return decodeCanonicalJsonBytes(await readFile(filePath), label, limits);
}

function effectiveLimits(overrides = {}) {
  const limits = {
    maxAuxiliaryManifests: overrides.maxAuxiliaryManifests ?? MAX_AUXILIARY_MANIFESTS,
    maxFilesPerShard: overrides.maxFilesPerShard ?? MAX_FILES_PER_SHARD,
    maxManifestBytes: overrides.maxManifestBytes ?? MAX_MANIFEST_BYTES,
    maxManifestMembers: overrides.maxManifestMembers ?? MAX_MANIFEST_MEMBERS,
  };
  for (const [name, value] of Object.entries(limits)) {
    if (!Number.isSafeInteger(value) || value <= 0) {
      fail(`${name} must be a positive safe integer`);
    }
  }
  if (limits.maxFilesPerShard > MAX_FILES_PER_SHARD) {
    fail(`maxFilesPerShard cannot exceed ${MAX_FILES_PER_SHARD}`);
  }
  if (limits.maxAuxiliaryManifests > MAX_AUXILIARY_MANIFESTS) {
    fail(`maxAuxiliaryManifests cannot exceed ${MAX_AUXILIARY_MANIFESTS}`);
  }
  if (limits.maxManifestBytes > MAX_MANIFEST_BYTES) {
    fail(`maxManifestBytes cannot exceed ${MAX_MANIFEST_BYTES}`);
  }
  if (limits.maxManifestMembers > MAX_MANIFEST_MEMBERS) {
    fail(`maxManifestMembers cannot exceed ${MAX_MANIFEST_MEMBERS}`);
  }
  return limits;
}

export function validateLogicalPath(value, label = 'logical path', { allowEmpty = false } = {}) {
  assertUnicodeScalarString(value, label);
  if (value.length === 0) {
    if (allowEmpty) {
      return value;
    }
    fail(`${label} must not be empty`);
  }
  if (Buffer.byteLength(value, 'utf8') > MAX_LOGICAL_PATH_BYTES) {
    fail(`${label} exceeds ${MAX_LOGICAL_PATH_BYTES} UTF-8 bytes`);
  }
  if (value.startsWith('/') || value.includes('\\') || /^[a-z]:/iu.test(value)) {
    fail(`${label} must be a relative forward-slash path`);
  }
  if (/[\u0000-\u001f\u007f<>:"|?*]/u.test(value)) {
    fail(`${label} contains a forbidden control or Windows path character`);
  }
  const segments = value.split('/');
  for (const segment of segments) {
    if (segment.length === 0 || segment === '.' || segment === '..') {
      fail(`${label} contains an empty, dot, or dot-dot segment`);
    }
    if (/[. ]$/u.test(segment)) {
      fail(`${label} contains a Windows-ambiguous trailing dot or space`);
    }
    const base = segment.split('.')[0].toUpperCase();
    if (RESERVED_WINDOWS_BASENAMES.has(base)) {
      fail(`${label} contains reserved Windows basename ${JSON.stringify(base)}`);
    }
  }
  return value;
}

function assertSurfaceId(value, label = 'surfaceId') {
  if (typeof value !== 'string' || !SURFACE_ID_PATTERN.test(value)) {
    fail(`${label} must match ${SURFACE_ID_PATTERN}`);
  }
}

function assertSha256(value, label) {
  if (typeof value !== 'string' || !SHA256_PATTERN.test(value)) {
    fail(`${label} must be a lowercase SHA-256`);
  }
}

function assertNonNegativeSafeInteger(value, label) {
  if (!Number.isSafeInteger(value) || value < 0) {
    fail(`${label} must be a non-negative safe integer`);
  }
}

function assertPositiveSafeInteger(value, label) {
  if (!Number.isSafeInteger(value) || value <= 0) {
    fail(`${label} must be a positive safe integer`);
  }
}

function normalizePrivacyTokens(tokens = []) {
  if (!Array.isArray(tokens)) {
    fail('privacy forbiddenSubstrings must be an array');
  }
  const normalized = new Set();
  for (const [index, token] of tokens.entries()) {
    assertUnicodeScalarString(token, `privacy forbiddenSubstrings[${index}]`);
    if (token.length === 0) {
      fail('privacy forbidden substrings must not be empty');
    }
    normalized.add(token.toLocaleLowerCase('en-US'));
    normalized.add(token.replaceAll('\\', '/').toLocaleLowerCase('en-US'));
    normalized.add(token.replaceAll('/', '\\').toLocaleLowerCase('en-US'));
  }
  return [...normalized].sort(ordinalCompare);
}

function defaultPrivacyTokens() {
  const tokens = [];
  for (const name of SENSITIVE_ENVIRONMENT_NAMES) {
    if (process.env[name]) {
      tokens.push(process.env[name]);
    }
  }
  if (process.env.HOMEDRIVE && process.env.HOMEPATH) {
    tokens.push(`${process.env.HOMEDRIVE}${process.env.HOMEPATH}`);
  }
  return tokens;
}

export function assertPrivacySafe(value, forbiddenSubstrings = [], label = 'manifest') {
  const tokens = normalizePrivacyTokens([...defaultPrivacyTokens(), ...forbiddenSubstrings]);
  const visit = (entry, entryLabel) => {
    if (typeof entry === 'string') {
      if (WINDOWS_ABSOLUTE_PATTERN.test(entry)) {
        fail(`${entryLabel} contains a host-absolute Windows path`);
      }
      const lowered = entry.toLocaleLowerCase('en-US');
      const slashLowered = entry.replaceAll('\\', '/').toLocaleLowerCase('en-US');
      const backslashLowered = entry.replaceAll('/', '\\').toLocaleLowerCase('en-US');
      for (const token of tokens) {
        if (lowered.includes(token) || slashLowered.includes(token) || backslashLowered.includes(token)) {
          fail(`${entryLabel} contains a forbidden host/profile substring`);
        }
      }
      return;
    }
    if (Array.isArray(entry)) {
      entry.forEach((child, index) => visit(child, `${entryLabel}[${index}]`));
      return;
    }
    if (entry !== null && typeof entry === 'object') {
      for (const [key, child] of Object.entries(entry)) {
        visit(key, `${entryLabel} key`);
        visit(child, `${entryLabel}.${key}`);
      }
    }
  };
  visit(value, label);
}

function assertStableIdentity(before, after, label) {
  const fields = ['ino', 'mode', 'nlink', 'size', 'mtimeNs', 'ctimeNs'];
  const fieldsEqual = fields.every(
    (field) => before[field]?.toString() === after[field]?.toString(),
  );
  // On Windows, path-based stat reports dev=0 while handle-based stat reports the
  // volume serial. Treat zero as unavailable; require equality when both are known.
  const beforeDevice = before.dev?.toString();
  const afterDevice = after.dev?.toString();
  const devicesEqual = beforeDevice === '0' || afterDevice === '0' || beforeDevice === afterDevice;
  if (!fieldsEqual || !devicesEqual) {
    fail(`${label} changed while its digest was being sealed`);
  }
}

async function assertRegularPath(filePath, label, expectedLinkCount = 1n) {
  const stats = await lstat(filePath, { bigint: true });
  if (stats.isSymbolicLink()) {
    fail(`${label} must not be a symbolic link or junction/reparse traversal`);
  }
  if (!stats.isFile()) {
    fail(`${label} must be a regular file`);
  }
  if (expectedLinkCount === 0n && stats.nlink < 1n) {
    fail(`${label} must have a positive observed filesystem link count`);
  }
  if (expectedLinkCount !== 0n && stats.nlink !== expectedLinkCount) {
    const count = expectedLinkCount === 1n ? 'one' : expectedLinkCount.toString();
    fail(`${label} must have exactly ${count} filesystem link(s)`);
  }
  return stats;
}

async function assertNoReparsePathComponents(inputPath, label) {
  const absolutePath = path.resolve(inputPath);
  const parsed = path.parse(absolutePath);
  const relative = path.relative(parsed.root, absolutePath);
  const components = relative === '' ? [] : relative.split(path.sep);
  let cursor = parsed.root;
  for (const component of components) {
    cursor = path.join(cursor, component);
    const stats = await lstat(cursor, { bigint: true });
    if (stats.isSymbolicLink()) {
      fail(`${label} contains a symbolic link or junction/reparse traversal`);
    }
  }
}

async function assertDirectoryPath(directoryPath, label) {
  const stats = await lstat(directoryPath, { bigint: true });
  if (stats.isSymbolicLink()) {
    fail(`${label} must not be a symbolic link or junction/reparse traversal`);
  }
  if (!stats.isDirectory()) {
    fail(`${label} must be a directory`);
  }
  return stats;
}

function assertContainedRealPath(rootRealPath, entryRealPath, label) {
  const relative = path.relative(rootRealPath, entryRealPath);
  if (relative === '' || relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    fail(`${label} resolves outside its declared source root`);
  }
}

async function collectTreeRelativePaths(rootPath) {
  const files = [];
  const walk = async (relativeDirectory) => {
    const directoryPath = relativeDirectory === ''
      ? rootPath
      : path.join(rootPath, ...relativeDirectory.split('/'));
    await assertDirectoryPath(directoryPath, `source directory ${JSON.stringify(relativeDirectory || '.')}`);
    const entries = await readdir(directoryPath, { withFileTypes: true });
    entries.sort((left, right) => ordinalCompare(left.name, right.name));
    for (const entry of entries) {
      const relativePath = relativeDirectory === '' ? entry.name : `${relativeDirectory}/${entry.name}`;
      validateLogicalPath(relativePath, 'source-relative path');
      const entryPath = path.join(directoryPath, entry.name);
      const stats = await lstat(entryPath, { bigint: true });
      if (stats.isSymbolicLink()) {
        fail(`source-relative path ${JSON.stringify(relativePath)} is a symbolic link or junction/reparse traversal`);
      }
      if (stats.isDirectory()) {
        await walk(relativePath);
      } else if (stats.isFile()) {
        files.push(relativePath);
      } else {
        fail(`source-relative path ${JSON.stringify(relativePath)} is not a regular file or directory`);
      }
    }
  };
  await walk('');
  return files;
}

async function hashOpenFile(fileHandle, expectedLength, label) {
  const hash = createHash('sha256');
  const buffer = Buffer.allocUnsafe(1024 * 1024);
  let position = 0;
  while (position < expectedLength) {
    const requested = Math.min(buffer.length, expectedLength - position);
    const { bytesRead } = await fileHandle.read(buffer, 0, requested, position);
    if (bytesRead === 0) {
      fail(`${label} became truncated while being hashed`);
    }
    hash.update(buffer.subarray(0, bytesRead));
    position += bytesRead;
  }
  const trailing = Buffer.allocUnsafe(1);
  const { bytesRead: trailingBytes } = await fileHandle.read(trailing, 0, 1, position);
  if (trailingBytes !== 0) {
    fail(`${label} grew while being hashed`);
  }
  return hash.digest('hex');
}

async function readOpenFileExactly(fileHandle, expectedLength, label) {
  const bytes = Buffer.alloc(expectedLength);
  let position = 0;
  while (position < expectedLength) {
    const { bytesRead } = await fileHandle.read(
      bytes,
      position,
      expectedLength - position,
      position,
    );
    if (bytesRead === 0) {
      fail(`${label} became truncated while being read`);
    }
    position += bytesRead;
  }
  const trailing = Buffer.allocUnsafe(1);
  const { bytesRead: trailingBytes } = await fileHandle.read(trailing, 0, 1, position);
  if (trailingBytes !== 0) {
    fail(`${label} grew while being read`);
  }
  return bytes;
}

async function readStableBoundedFile(filePath, label, maximumBytes) {
  const beforePathStats = await assertRegularPath(filePath, label);
  if (beforePathStats.size > BigInt(maximumBytes)) {
    fail(`${label} byte length exceeds ${maximumBytes} before read`);
  }
  const fileHandle = await open(filePath, fsConstants.O_RDONLY);
  try {
    const beforeHandleStats = await fileHandle.stat({ bigint: true });
    if (!beforeHandleStats.isFile()) {
      fail(`${label} open handle is not a regular file`);
    }
    assertStableIdentity(beforePathStats, beforeHandleStats, label);
    const byteLength = Number(beforeHandleStats.size);
    const first = await readOpenFileExactly(fileHandle, byteLength, label);
    const second = await readOpenFileExactly(fileHandle, byteLength, label);
    if (!first.equals(second)) {
      fail(`${label} yielded different bytes across two reads`);
    }
    const afterHandleStats = await fileHandle.stat({ bigint: true });
    assertStableIdentity(beforeHandleStats, afterHandleStats, label);
    const afterPathStats = await assertRegularPath(filePath, label);
    assertStableIdentity(beforePathStats, afterPathStats, label);
    return first;
  } finally {
    await fileHandle.close();
  }
}

export async function hashStableFile(filePath, label = filePath, options = {}) {
  const expectedLinkCount = BigInt(options.expectedLinkCount ?? 1);
  if (expectedLinkCount < 0n) {
    fail(`${label} expected link count must be non-negative`);
  }
  const beforePathStats = await assertRegularPath(filePath, label, expectedLinkCount);
  const admittedLinkCount = expectedLinkCount === 0n
    ? beforePathStats.nlink
    : expectedLinkCount;
  if (beforePathStats.size > BigInt(Number.MAX_SAFE_INTEGER)) {
    fail(`${label} is too large for an exact JSON byte-length integer`);
  }
  const fileHandle = await open(filePath, fsConstants.O_RDONLY);
  try {
    const beforeHandleStats = await fileHandle.stat({ bigint: true });
    if (!beforeHandleStats.isFile()) {
      fail(`${label} open handle is not a regular file`);
    }
    if (beforeHandleStats.nlink !== admittedLinkCount) {
      fail(`${label} open handle does not have the expected filesystem link count`);
    }
    assertStableIdentity(beforePathStats, beforeHandleStats, label);
    const byteLength = Number(beforeHandleStats.size);
    const firstSha256 = await hashOpenFile(fileHandle, byteLength, label);
    const secondSha256 = await hashOpenFile(fileHandle, byteLength, label);
    if (firstSha256 !== secondSha256) {
      fail(`${label} yielded different hashes across two reads`);
    }
    const afterHandleStats = await fileHandle.stat({ bigint: true });
    assertStableIdentity(beforeHandleStats, afterHandleStats, label);
    const afterPathStats = await assertRegularPath(filePath, label, admittedLinkCount);
    assertStableIdentity(beforePathStats, afterPathStats, label);
    return {
      byteLength,
      identity: {
        device: beforeHandleStats.dev.toString(16).padStart(8, '0'),
        fileId: beforeHandleStats.ino.toString(16).padStart(16, '0'),
        linkCount: Number(beforeHandleStats.nlink),
      },
      sha256: firstSha256,
    };
  } finally {
    await fileHandle.close();
  }
}

function resolveSourceRoot(source, locations, configDirectory, label) {
  const hasRoot = Object.hasOwn(source, 'root');
  const hasLocation = Object.hasOwn(source, 'location');
  if (hasRoot === hasLocation) {
    fail(`${label} must provide exactly one of root or location`);
  }
  let rootValue;
  if (hasRoot) {
    assertUnicodeScalarString(source.root, `${label}.root`);
    if (source.root.length === 0 || source.root.includes('\0')) {
      fail(`${label}.root must be a non-empty filesystem path without NUL`);
    }
    rootValue = source.root;
  } else {
    assertUnicodeScalarString(source.location, `${label}.location`);
    if (!Object.hasOwn(locations, source.location)) {
      fail(`${label}.location ${JSON.stringify(source.location)} is not declared`);
    }
    const relativeRoot = source.relativeRoot ?? '';
    validateLogicalPath(relativeRoot, `${label}.relativeRoot`, { allowEmpty: true });
    rootValue = relativeRoot === ''
      ? locations[source.location]
      : path.join(locations[source.location], ...relativeRoot.split('/'));
  }
  return path.resolve(configDirectory, rootValue);
}

function sourceAllowedKeys(source) {
  return Object.hasOwn(source, 'root')
    ? ['files', 'identityPolicy', 'logicalPrefix', 'mode', 'root']
    : ['files', 'identityPolicy', 'location', 'logicalPrefix', 'mode', 'relativeRoot'];
}

function validateSourceIdentityPolicy(source, selected, label, surfaceId) {
  if (source.identityPolicy === undefined) {
    return { expectedLinkCount: 1, sharedIdentityRequired: false };
  }
  assertExactKeys(
    source.identityPolicy,
    source.identityPolicy.kind === 'pnpm-content-addressed-store-hardlink-v1'
      ? ['kind']
      : ['kind', 'linkCount', 'relativePaths'],
    `${label}.identityPolicy`,
  );
  if (source.identityPolicy.kind === 'pnpm-content-addressed-store-hardlink-v1') {
    if (
      surfaceId !== 'pnpm-store-v10' ||
      source.mode !== 'tree'
    ) {
      fail(`${label}.identityPolicy is outside the exact pnpm-store-v10 tree authority`);
    }
    return { expectedLinkCount: 0, sharedIdentityRequired: false };
  }
  const admittedKinds = new Set([
    'git-for-windows-runtime-hardlink-v1',
    'windows-servicing-hardlink-v1',
  ]);
  if (
    source.mode !== 'files' ||
    !admittedKinds.has(source.identityPolicy.kind) ||
    source.identityPolicy.linkCount !== 2
  ) {
    fail(`${label}.identityPolicy is not an exact admitted closed hardlink policy`);
  }
  assertExactStringArray(
    source.identityPolicy.relativePaths,
    selected,
    `${label}.identityPolicy.relativePaths`,
  );
  return { expectedLinkCount: 2, sharedIdentityRequired: true };
}

async function enumerateSource(source, context, label, surfaceId) {
  assertPlainObject(source, label);
  assertAllowedKeys(source, sourceAllowedKeys(source), ['logicalPrefix', 'mode'], label);
  if (source.mode !== 'tree' && source.mode !== 'files') {
    fail(`${label}.mode must be exactly "tree" or "files"`);
  }
  validateLogicalPath(source.logicalPrefix, `${label}.logicalPrefix`, { allowEmpty: true });
  if (source.mode === 'tree' && Object.hasOwn(source, 'files')) {
    fail(`${label}.files is forbidden in tree mode`);
  }
  if (source.mode === 'files' && !Array.isArray(source.files)) {
    fail(`${label}.files must be an array in files mode`);
  }
  const rootPath = resolveSourceRoot(source, context.locations, context.configDirectory, label);
  await assertNoReparsePathComponents(rootPath, `${label} root`);
  const rootBefore = await assertDirectoryPath(rootPath, `${label} root`);
  const rootRealPath = await realpath(rootPath);
  const selected = source.mode === 'tree'
    ? await collectTreeRelativePaths(rootPath)
    : source.files.map((entry, index) => validateLogicalPath(entry, `${label}.files[${index}]`));
  const uniqueSelected = [...new Set(selected)].sort(ordinalCompare);
  if (uniqueSelected.length !== selected.length) {
    fail(`${label} selects a source-relative path more than once`);
  }
  if (uniqueSelected.length === 0) {
    fail(`${label} must select at least one regular file`);
  }
  const identityPolicy = validateSourceIdentityPolicy(source, uniqueSelected, label, surfaceId);
  const files = [];
  let sharedIdentity;
  for (const relativePath of uniqueSelected) {
    const filePath = path.join(rootPath, ...relativePath.split('/'));
    if (source.mode === 'files') {
      await assertNoReparsePathComponents(
        filePath,
        `${label} file ${JSON.stringify(relativePath)}`,
      );
    }
    const fileRealPath = await realpath(filePath);
    assertContainedRealPath(rootRealPath, fileRealPath, `${label} file ${JSON.stringify(relativePath)}`);
    const logicalPath = source.logicalPrefix === ''
      ? relativePath
      : `${source.logicalPrefix}/${relativePath}`;
    validateLogicalPath(logicalPath, `${label} logical path`);
    const digest = await hashStableFile(
      filePath,
      `${label} file ${JSON.stringify(relativePath)}`,
      { expectedLinkCount: identityPolicy.expectedLinkCount },
    );
    if (identityPolicy.sharedIdentityRequired) {
      const identity = canonicalJsonBytes(digest.identity).toString('utf8');
      if (sharedIdentity === undefined) {
        sharedIdentity = identity;
      } else if (identity !== sharedIdentity) {
        fail(`${label}.identityPolicy paths are not aliases for one stable file identity`);
      }
    }
    if (context.logicalFiles !== undefined) {
      const caseFolded = logicalPath.toLocaleLowerCase('en-US');
      const prior = context.caseFoldedLogicalFiles.get(caseFolded);
      if (prior !== undefined) {
        fail(
          `${label} logical path ${JSON.stringify(logicalPath)} collides globally with ` +
          `${JSON.stringify(prior)} under Windows case-insensitive comparison`,
        );
      }
      context.caseFoldedLogicalFiles.set(caseFolded, logicalPath);
      context.logicalFiles.set(logicalPath, {
        byteLength: digest.byteLength,
        filePath,
        sha256: digest.sha256,
      });
    }
    files.push([logicalPath, digest.byteLength, digest.sha256]);
  }
  if (source.mode === 'tree') {
    const afterSelection = (await collectTreeRelativePaths(rootPath)).sort(ordinalCompare);
    if (
      afterSelection.length !== uniqueSelected.length ||
      afterSelection.some((entry, index) => entry !== uniqueSelected[index])
    ) {
      fail(`${label} directory membership changed while being sealed`);
    }
  }
  const rootAfter = await assertDirectoryPath(rootPath, `${label} root`);
  assertStableIdentity(rootBefore, rootAfter, `${label} root`);
  assertPrivacySafe(
    files,
    [...context.forbiddenSubstrings, rootPath, rootRealPath],
    `${label} output file tuples`,
  );
  return files;
}

function summarizeFiles(files) {
  return {
    byteLength: files.reduce((total, file) => total + file[1], 0),
    fileCount: files.length,
    surfaceSha256: sha256Bytes(canonicalJsonBytes(files)),
  };
}

function validateExpectedSummary(expected, actual, label) {
  if (expected === undefined) {
    return;
  }
  assertExactKeys(expected, ['byteLength', 'fileCount', 'surfaceSha256'], label);
  assertNonNegativeSafeInteger(expected.byteLength, `${label}.byteLength`);
  assertPositiveSafeInteger(expected.fileCount, `${label}.fileCount`);
  assertSha256(expected.surfaceSha256, `${label}.surfaceSha256`);
  for (const key of ['byteLength', 'fileCount', 'surfaceSha256']) {
    if (expected[key] !== actual[key]) {
      fail(`${label}.${key} expected ${JSON.stringify(expected[key])}, received ${JSON.stringify(actual[key])}`);
    }
  }
}

export async function enumerateSurface(surface, context = {}) {
  assertAllowedKeys(surface, ['expected', 'sources', 'surfaceId'], ['sources', 'surfaceId'], 'surface');
  assertSurfaceId(surface.surfaceId, 'surface.surfaceId');
  if (!Array.isArray(surface.sources) || surface.sources.length === 0) {
    fail(`surface ${JSON.stringify(surface.surfaceId)} must have at least one source`);
  }
  const effectiveContext = {
    caseFoldedLogicalFiles: context.caseFoldedLogicalFiles,
    configDirectory: path.resolve(context.configDirectory ?? process.cwd()),
    forbiddenSubstrings: context.forbiddenSubstrings ?? [],
    logicalFiles: context.logicalFiles,
    locations: context.locations ?? {},
  };
  const files = [];
  for (const [index, source] of surface.sources.entries()) {
    files.push(...await enumerateSource(
      source,
      effectiveContext,
      `surface ${surface.surfaceId}.sources[${index}]`,
      surface.surfaceId,
    ));
  }
  files.sort((left, right) => ordinalCompare(left[0], right[0]));
  for (let index = 1; index < files.length; index += 1) {
    if (files[index - 1][0] === files[index][0]) {
      fail(`surface ${JSON.stringify(surface.surfaceId)} contains duplicate logical path ${JSON.stringify(files[index][0])}`);
    }
  }
  const summary = summarizeFiles(files);
  validateExpectedSummary(surface.expected, summary, `surface ${surface.surfaceId}.expected`);
  return { files, surfaceId: surface.surfaceId, ...summary };
}

function requireBoundFile(logicalFiles, logicalPath, label) {
  validateLogicalPath(logicalPath, `${label} logical path`);
  const bound = logicalFiles.get(logicalPath);
  if (bound === undefined) {
    fail(`${label} is not bound to enumerated logical file ${JSON.stringify(logicalPath)}`);
  }
  return bound;
}

function assertBoundFile(logicalFiles, logicalPath, byteLength, sha256, label) {
  const bound = requireBoundFile(logicalFiles, logicalPath, label);
  assertNonNegativeSafeInteger(byteLength, `${label} byteLength`);
  assertSha256(sha256, `${label} sha256`);
  if (bound.byteLength !== byteLength || bound.sha256 !== sha256) {
    fail(`${label} byte length/SHA-256 does not equal its enumerated file tuple`);
  }
  return bound;
}

function assertDigestBoundExactlyOnce(logicalFiles, sha256, label) {
  assertSha256(sha256, `${label} sha256`);
  const matches = [...logicalFiles.entries()].filter(([, value]) => value.sha256 === sha256);
  if (matches.length !== 1) {
    fail(`${label} SHA-256 must bind exactly one enumerated file; received ${matches.length}`);
  }
  return matches[0];
}

async function canonicalLfDigest(bound, label) {
  const bytes = await readStableBoundedFile(bound.filePath, label, 16 * 1024 * 1024);
  if (bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) {
    fail(`${label} must not have a UTF-8 BOM`);
  }
  let text;
  try {
    text = UTF8.decode(bytes);
  } catch (error) {
    fail(`${label} is not valid UTF-8: ${error.message}`);
  }
  const canonical = text.replaceAll('\r\n', '\n');
  if (canonical.includes('\r')) {
    fail(`${label} contains a non-CRLF carriage return`);
  }
  const canonicalBytes = Buffer.from(canonical, 'utf8');
  return {
    byteLength: canonicalBytes.length,
    sha256: sha256Bytes(canonicalBytes),
  };
}

async function assertCanonicalLfBound(logicalFiles, logicalPath, byteLength, sha256, label) {
  const bound = requireBoundFile(logicalFiles, logicalPath, label);
  assertNonNegativeSafeInteger(byteLength, `${label} canonical LF byteLength`);
  assertSha256(sha256, `${label} canonical LF sha256`);
  const actual = await canonicalLfDigest(bound, label);
  if (actual.byteLength !== byteLength || actual.sha256 !== sha256) {
    fail(`${label} canonical LF byte length/SHA-256 does not equal the enumerated source`);
  }
}

async function validateStorePackageTuple(tuple, logicalFiles, label) {
  if (!Array.isArray(tuple) || tuple.length !== 8) {
    fail(`${label} must match selectedPackageTupleSchema`);
  }
  const [
    expectedName,
    expectedVersion,
    ,
    indexRelativePath,
    expectedFileCount,
    expectedFileBytes,
    expectedProjectionBytes,
    expectedProjectionSha256,
  ] = tuple;
  const bound = requireBoundFile(
    logicalFiles,
    `pnpm-store/v10/index/${indexRelativePath}`,
    `${label} store index`,
  );
  const indexBytes = await readStableBoundedFile(bound.filePath, `${label} store index`, MAX_CONFIG_BYTES);
  const index = decodeDeclarativeJson(indexBytes, `${label} store index`);
  assertAllowedKeys(index, ['files', 'name', 'requiresBuild', 'version'], ['files', 'name', 'version'], label);
  assertPlainObject(index.files, `${label}.files`);
  const projectedFiles = Object.create(null);
  let fileBytes = 0;
  for (const filePath of Object.keys(index.files).sort(ordinalCompare)) {
    validateLogicalPath(filePath, `${label}.files key`);
    const file = index.files[filePath];
    assertAllowedKeys(
      file,
      ['checkedAt', 'integrity', 'mode', 'sideEffects', 'size'],
      ['integrity', 'mode', 'size'],
      `${label}.files.${filePath}`,
    );
    assertNonNegativeSafeInteger(file.mode, `${label}.files.${filePath}.mode`);
    assertNonNegativeSafeInteger(file.size, `${label}.files.${filePath}.size`);
    assertUnicodeScalarString(file.integrity, `${label}.files.${filePath}.integrity`);
    projectedFiles[filePath] = {
      integrity: file.integrity,
      mode: file.mode,
      size: file.size,
    };
    fileBytes += file.size;
  }
  const projection = {
    files: projectedFiles,
    name: index.name,
    requiresBuild: index.requiresBuild ?? false,
    version: index.version,
  };
  const projectionBytes = canonicalJsonBytes(projection);
  if (
    index.name !== expectedName ||
    index.version !== expectedVersion ||
    Object.keys(index.files).length !== expectedFileCount ||
    fileBytes !== expectedFileBytes ||
    projectionBytes.length !== expectedProjectionBytes ||
    sha256Bytes(projectionBytes) !== expectedProjectionSha256
  ) {
    fail(`${label} normalized store-index projection does not equal its declared tuple`);
  }
}

async function validateQ0sReceiptBinding(root, logicalFiles) {
  const bundle = root.runnerIdentity.bundle;
  if (bundle === undefined) {
    return;
  }
  const label = 'root.runnerIdentity.bundle tracked receipt';
  const bound = requireBoundFile(logicalFiles, bundle.trackedReceiptLogicalPath, label);
  const bytes = await readStableBoundedFile(bound.filePath, label, 64 * 1024);
  if (bytes.length !== bound.byteLength || sha256Bytes(bytes) !== bound.sha256) {
    fail(`${label} changed after enumeration`);
  }
  const receipt = decodeDeclarativeJson(bytes, label);
  const runner = root.runnerIdentity;
  const expected = {
    hostSmokeScope: 'host-smoke-only',
    localEvidenceBundleSha256: bundle.aggregateSha256,
    outcome: runner.outcome,
    schemaVersion: runner.schema,
    scope: runner.scope,
    semanticFacts: {
      cliVersion: runner.sandbox.cliVersion,
      guestArchitecture: runner.guest.architecture,
      guestDisplayVersion: runner.guest.displayVersion,
      guestEditionId: runner.guest.editionId,
      guestFullBuild: runner.guest.revision,
      guestGroupCount: runner.guest.groupCount,
      guestInstallationType: runner.guest.installationType,
      guestIntegrityLevel: runner.guest.integrity,
      guestPrivilegeCount: runner.guest.privilegeCount,
      guestProcessArchitecture: runner.guest.processArchitecture,
      guestProductType: runner.guest.productType,
      hostArchitecture: runner.host.architecture,
      hostEditionId: runner.host.editionId,
      hostFullBuild: runner.host.revision,
      hostInstallationType: runner.host.installationType,
      hostSmokeOutcome: runner.boundedHostSmoke,
      inputMappingReadOnly: runner.sandbox.inputMappingReadOnly,
      networkIsolation: runner.sandbox.networkIsolation,
      persistenceReset: runner.sandbox.persistenceReset,
      requestedAudioInput: runner.requestedConfiguration.audioInput,
      requestedClipboard: runner.requestedConfiguration.clipboard,
      requestedMemoryMiB: runner.requestedConfiguration.memoryMiB,
      requestedNetworking: runner.requestedConfiguration.networking,
      requestedPrinter: runner.requestedConfiguration.printer,
      requestedProtectedClient: runner.requestedConfiguration.protectedClient,
      requestedVGpu: runner.requestedConfiguration.vGPU,
      requestedVideoInput: runner.requestedConfiguration.videoInput,
      sandboxPackageFullName: runner.sandbox.packageFullName,
      sandboxPackageVersion: runner.sandbox.packageVersion,
      sessionRuns: runner.sandbox.freshSessionRuns,
      stableManifestSha256: runner.sourceSeal.stableRenderedManifestSha256,
      templateSha256: runner.sourceSeal.templateSha256,
    },
    teardownLevel: runner.teardownLevel,
  };
  if (!canonicalJsonBytes(receipt).equals(canonicalJsonBytes(expected))) {
    fail(`${label} semantic content does not equal the declared Q0S runner identity`);
  }
}

function assertCanonicalValueEqual(actual, expected, label) {
  if (!canonicalJsonBytes(actual).equals(canonicalJsonBytes(expected))) {
    fail(`${label} does not equal its declared root identity`);
  }
}

function projectSignatureAssets(input) {
  return input.assets.map((asset) => ({
    bytes: asset.bytes,
    fileName: asset.fileName,
    logicalPath: asset.cacheKey,
    role: asset.role,
    sha256: asset.sha256,
  }));
}

const PRESEAL_SIGNATURE_FAMILIES = Object.freeze([
  'node-gpg',
  'llvm-gpg',
  'python-gpg',
  'pnpm-ecdsa',
  'node-authenticode',
  'python-authenticode',
  'powershell-authenticode',
  'taskkill-authenticode',
]);

const PRESEAL_PAYLOAD_KEYS = Object.freeze([
  'authenticode',
  'capturedAtUtc',
  'commands',
  'configAuthority',
  'executableFacts',
  'filesystemAudits',
  'gpgRuntimeClosure',
  'gitRuntimeClosure',
  'networkPolicy',
  'outcome',
  'packageMaterialization',
  'pathPolicy',
  'repository',
  'runId',
  'runtime',
  'schemaVersion',
  'scope',
  'servicedSystemTools',
  'signatures',
]);

function validatePresealFileDescriptor(value, label, expectedSchema) {
  assertExactKeys(value, ['bytes', 'logicalPath', 'schema', 'sha256'], label);
  assertPositiveSafeInteger(value.bytes, `${label}.bytes`);
  validateLogicalPath(value.logicalPath, `${label}.logicalPath`);
  assertSha256(value.sha256, `${label}.sha256`);
  if (value.schema !== expectedSchema) {
    fail(`${label}.schema must equal ${expectedSchema}`);
  }
}

function validatePresealBindingPolicy(value, label) {
  if (value !== PRESEAL_BINDING_POLICY) {
    fail(`${label} must equal ${PRESEAL_BINDING_POLICY}`);
  }
}

function validatePresealConfigProjectionDescriptor(value, label) {
  assertExactKeys(value, ['algorithm', 'bytes', 'sha256'], label);
  assertPositiveSafeInteger(value.bytes, `${label}.bytes`);
  assertSha256(value.sha256, `${label}.sha256`);
  if (value.algorithm !== PRESEAL_CONFIG_AUTHORITY_PROJECTION_ALGORITHM) {
    fail(`${label}.algorithm does not equal the shared projection authority`);
  }
}

function validatePresealPendingDescriptor(declared, label = 'root.provenance.presealReceipt') {
  assertExactKeys(declared, [
    'bindingPolicy',
    'configProjection',
    'status',
  ], label);
  validatePresealBindingPolicy(declared.bindingPolicy, `${label}.bindingPolicy`);
  validatePresealConfigProjectionDescriptor(declared.configProjection, `${label}.configProjection`);
  if (declared.status !== 'pending') fail(`${label}.status must equal pending`);
}

function validatePresealV2Descriptor(declared, label = 'root.provenance.presealReceipt') {
  assertExactKeys(declared, [
    'bindingPolicy',
    'commandCount',
    'configProjection',
    'offlineDownloaded',
    'offlineReused',
    'payload',
    'rootReceipt',
    'signatureFamilies',
    'status',
  ], label);
  validatePresealBindingPolicy(declared.bindingPolicy, `${label}.bindingPolicy`);
  assertPositiveSafeInteger(declared.commandCount, `${label}.commandCount`);
  assertNonNegativeSafeInteger(declared.offlineDownloaded, `${label}.offlineDownloaded`);
  assertNonNegativeSafeInteger(declared.offlineReused, `${label}.offlineReused`);
  if (declared.offlineDownloaded !== 0 || declared.status !== 'passed') {
    fail(`${label} must declare a passed, zero-download offline capture`);
  }
  assertExactStringArray(declared.signatureFamilies, PRESEAL_SIGNATURE_FAMILIES, `${label}.signatureFamilies`);
  validatePresealConfigProjectionDescriptor(declared.configProjection, `${label}.configProjection`);
  validatePresealFileDescriptor(
    declared.rootReceipt,
    `${label}.rootReceipt`,
    PRESEAL_ROOT_SCHEMA_VERSION,
  );
  validatePresealFileDescriptor(
    declared.payload,
    `${label}.payload`,
    PRESEAL_PAYLOAD_SCHEMA_VERSION,
  );
  const rootMatch = /^preseal\/cx004-preseal-([0-9a-f]{32})\.json$/u.exec(
    declared.rootReceipt.logicalPath,
  );
  const payloadMatch = /^preseal\/cx004-preseal-([0-9a-f]{32})\.payload\.json$/u.exec(
    declared.payload.logicalPath,
  );
  if (rootMatch === null || payloadMatch === null || rootMatch[1] !== payloadMatch[1]) {
    fail(`${label} root/payload paths must carry one shared 128-bit run id`);
  }
  return rootMatch[1];
}

function validatePresealLifecycleDescriptor(declared, label = 'root.provenance.presealReceipt') {
  if (declared?.status === 'pending') {
    validatePresealPendingDescriptor(declared, label);
    return 'pending';
  }
  validatePresealV2Descriptor(declared, label);
  return 'passed';
}

function expectedPresealV2Surface(declared) {
  const files = [
    path.posix.basename(declared.rootReceipt.logicalPath),
    path.posix.basename(declared.payload.logicalPath),
  ].sort(ordinalCompare);
  const tuples = [
    [declared.rootReceipt.logicalPath, declared.rootReceipt.bytes, declared.rootReceipt.sha256],
    [declared.payload.logicalPath, declared.payload.bytes, declared.payload.sha256],
  ].sort((left, right) => ordinalCompare(left[0], right[0]));
  return {
    expected: {
      byteLength: declared.rootReceipt.bytes + declared.payload.bytes,
      fileCount: 2,
      surfaceSha256: sha256Bytes(canonicalJsonBytes(tuples)),
    },
    sources: [{
      files,
      location: 'preseal',
      logicalPrefix: 'preseal',
      mode: 'files',
      relativeRoot: '',
    }],
    surfaceId: 'preseal-receipt',
  };
}

function validatePresealV2Surface(config, declared) {
  const matches = config.surfaces.filter((surface) => surface.surfaceId === 'preseal-receipt');
  if (matches.length !== 1) {
    fail(`config must contain exactly one preseal-receipt surface; received ${matches.length}`);
  }
  assertCanonicalValueEqual(matches[0], expectedPresealV2Surface(declared), 'config surface preseal-receipt');
}

function validatePresealPendingSurface(config) {
  const matches = config.surfaces.filter((surface) => surface.surfaceId === 'preseal-receipt');
  if (matches.length !== 1) {
    fail(`config must contain exactly one preseal-receipt surface; received ${matches.length}`);
  }
  assertCanonicalValueEqual(matches[0], {
    sources: [],
    surfaceId: 'preseal-receipt',
  }, 'config pending surface preseal-receipt');
}

function validatePresealLifecycleSurface(config, declared) {
  if (declared.status === 'pending') {
    validatePresealPendingSurface(config);
    return;
  }
  validatePresealV2Surface(config, declared);
}

function assertPresealPassedForGeneration(config, label = 'native-build-input generation') {
  if (config.root?.scope?.classification !== 'tracked-pre-code-native-build-input-root') return;
  const declared = config.root.provenance.presealReceipt;
  if (declared?.status === 'pending') {
    fail(`${label} refuses the pending preseal lifecycle until an exact passed v2 receipt pair is bound`);
  }
  validatePresealV2Descriptor(declared);
  validatePresealV2Surface(config, declared);
}

function assertPresealCapturedAt(value, label) {
  if (
    typeof value !== 'string' ||
    !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u.test(value) ||
    Number.isNaN(Date.parse(value)) ||
    new Date(value).toISOString() !== value
  ) {
    fail(`${label} must be an exact millisecond UTC timestamp`);
  }
}

export function validatePresealV2Envelope(config, rootBytes, payloadBytes) {
  assertPlainObject(config, 'preseal envelope config');
  const declared = config.root?.provenance?.presealReceipt;
  const label = 'root.provenance.presealReceipt';
  const runId = validatePresealV2Descriptor(declared, label);
  validatePresealV2Surface(config, declared);
  if (!Buffer.isBuffer(rootBytes) || !Buffer.isBuffer(payloadBytes)) {
    fail(`${label} root and payload inputs must be Buffers`);
  }
  if (
    rootBytes.length !== declared.rootReceipt.bytes ||
    sha256Bytes(rootBytes) !== declared.rootReceipt.sha256
  ) {
    fail(`${label}.rootReceipt bytes/SHA-256 do not equal the declared root envelope`);
  }
  if (
    payloadBytes.length !== declared.payload.bytes ||
    sha256Bytes(payloadBytes) !== declared.payload.sha256
  ) {
    fail(`${label}.payload bytes/SHA-256 do not equal the declared payload`);
  }
  const receiptRoot = decodeCanonicalJsonBytes(rootBytes, `${label}.rootReceipt`, {
    maxManifestBytes: MAX_PRESEAL_ROOT_BYTES,
    maxManifestMembers: 512,
  });
  const payload = decodeCanonicalJsonBytesWithLimits(payloadBytes, `${label}.payload`, {
    maxManifestBytes: MAX_PRESEAL_PAYLOAD_BYTES,
    maxManifestMembers: MAX_PRESEAL_PAYLOAD_MEMBERS,
  });
  if (
    !Array.isArray(config.privacy?.forbiddenSubstrings) ||
    config.privacy.forbiddenSubstrings.some((entry) => typeof entry !== 'string' || entry.length === 0)
  ) {
    fail(`${label} config privacy authority must provide non-empty forbidden substrings`);
  }
  assertPrivacySafe(receiptRoot, config.privacy.forbiddenSubstrings, `${label}.rootReceipt content`);
  assertPrivacySafe(payload, config.privacy.forbiddenSubstrings, `${label}.payload content`);
  assertExactKeys(receiptRoot, ['outcome', 'payload', 'runId', 'schemaVersion', 'teardown'], `${label}.rootReceipt`);
  assertExactKeys(receiptRoot.payload, ['bytes', 'logicalPath', 'sha256'], `${label}.rootReceipt.payload`);
  assertExactKeys(receiptRoot.teardown, [
    'outcome',
    'parentIdentityReplayed',
    'runId',
    'runRootAbsent',
    'runRootDirectChild',
  ], `${label}.rootReceipt.teardown`);
  if (
    receiptRoot.schemaVersion !== PRESEAL_ROOT_SCHEMA_VERSION ||
    receiptRoot.outcome !== 'passed' ||
    receiptRoot.runId !== runId ||
    receiptRoot.teardown.outcome !== 'removed' ||
    receiptRoot.teardown.parentIdentityReplayed !== true ||
    receiptRoot.teardown.runId !== runId ||
    receiptRoot.teardown.runRootAbsent !== true ||
    receiptRoot.teardown.runRootDirectChild !== true
  ) {
    fail(`${label}.rootReceipt does not carry the passed capture and positive teardown identity`);
  }
  assertCanonicalValueEqual(receiptRoot.payload, {
    bytes: declared.payload.bytes,
    logicalPath: `<cache>/preseal/receipts/${path.posix.basename(declared.payload.logicalPath)}`,
    sha256: declared.payload.sha256,
  }, `${label}.rootReceipt.payload`);

  assertExactKeys(payload, PRESEAL_PAYLOAD_KEYS, `${label}.payload`);
  if (
    payload.schemaVersion !== PRESEAL_PAYLOAD_SCHEMA_VERSION ||
    payload.outcome !== 'passed' ||
    payload.runId !== runId
  ) {
    fail(`${label}.payload does not equal the passed root envelope identity`);
  }
  assertPresealCapturedAt(payload.capturedAtUtc, `${label}.payload.capturedAtUtc`);
  assertExactKeys(payload.scope, [
    'externalProjectDataAccessed',
    'payloadLogicalPath',
    'providerProcessesStarted',
    'receiptLogicalPath',
    'stableRepositoryMutated',
    'workspaceMaterializationLogicalPath',
  ], `${label}.payload.scope`);
  assertCanonicalValueEqual(payload.scope, {
    externalProjectDataAccessed: false,
    payloadLogicalPath: `<cache>/preseal/receipts/${path.posix.basename(declared.payload.logicalPath)}`,
    providerProcessesStarted: false,
    receiptLogicalPath: `<cache>/preseal/receipts/${path.posix.basename(declared.rootReceipt.logicalPath)}`,
    stableRepositoryMutated: false,
    workspaceMaterializationLogicalPath: '<run>/workspace',
  }, `${label}.payload.scope`);
  assertExactKeys(payload.configAuthority, ['algorithm', 'capturedConfig', 'projection'], `${label}.payload.configAuthority`);
  assertExactKeys(payload.configAuthority.capturedConfig, ['bytes', 'sha256'], `${label}.payload.configAuthority.capturedConfig`);
  assertExactKeys(payload.configAuthority.projection, ['bytes', 'sha256'], `${label}.payload.configAuthority.projection`);
  assertPositiveSafeInteger(payload.configAuthority.capturedConfig.bytes, `${label}.payload.configAuthority.capturedConfig.bytes`);
  assertSha256(payload.configAuthority.capturedConfig.sha256, `${label}.payload.configAuthority.capturedConfig.sha256`);
  if (payload.configAuthority.capturedConfig.bytes > MAX_CONFIG_BYTES) {
    fail(`${label}.payload.configAuthority.capturedConfig exceeds the fixed config byte bound`);
  }
  const projection = presealConfigAuthorityIdentity(config);
  assertCanonicalValueEqual(payload.configAuthority, {
    algorithm: PRESEAL_CONFIG_AUTHORITY_PROJECTION_ALGORITHM,
    capturedConfig: payload.configAuthority.capturedConfig,
    projection: {
      bytes: projection.bytes,
      sha256: projection.sha256,
    },
  }, `${label}.payload.configAuthority`);
  assertCanonicalValueEqual(declared.configProjection, projection, `${label}.configProjection`);
  return { declared, payload, receiptRoot, runId };
}

function validatePresealTuple(tuple, label) {
  if (!Array.isArray(tuple) || tuple.length !== 3) {
    fail(`${label} must be [id,bytes,sha256]`);
  }
  assertUnicodeScalarString(tuple[0], `${label}[0]`);
  if (tuple[0].length === 0 || tuple[0].includes('\\') || tuple[0].includes('\0')) {
    fail(`${label}[0] must be a non-empty logical id`);
  }
  assertPositiveSafeInteger(tuple[1], `${label}[1]`);
  assertSha256(tuple[2], `${label}[2]`);
}

const PRESEAL_NATIVE_FILE_IDENTITY_POLICY =
  'regular-nonreparse-components-single-link-double-content-hash-stable-handle';
const PRESEAL_IN_PROCESS_LOADER_SHA256 =
  '1291d7594917dab87f77d10688e23295d3c0cffa581960488dacd26848323b77';
const PRESEAL_POWERSHELL_ARGV = Object.freeze([
  '-NoLogo',
  '-NoProfile',
  '-NonInteractive',
  '-ExecutionPolicy',
  'Bypass',
  '-EncodedCommand',
  `<in-process-loader:${PRESEAL_IN_PROCESS_LOADER_SHA256}>`,
]);
const PRESEAL_POWERSHELL_ENV_NAMES = Object.freeze([
  'SYSTEMROOT',
  'TEMP',
  'TMP',
  'WINDIR',
]);
const PRESEAL_NODE_ENV_NAMES = Object.freeze([
  'APPDATA',
  'COMSPEC',
  'FORCE_COLOR',
  'HOME',
  'LOCALAPPDATA',
  'NO_COLOR',
  'PATH',
  'PATHEXT',
  'SYSTEMROOT',
  'TEMP',
  'TMP',
  'USERPROFILE',
  'WINDIR',
  'XDG_CONFIG_HOME',
]);
const PRESEAL_PNPM_ENV_NAMES = Object.freeze([
  'ALL_PROXY',
  'APPDATA',
  'CI',
  'COMSPEC',
  'FORCE_COLOR',
  'HOME',
  'HTTPS_PROXY',
  'HTTP_PROXY',
  'LOCALAPPDATA',
  'NO_COLOR',
  'NO_PROXY',
  'NPM_CONFIG_CACHE',
  'NPM_CONFIG_REGISTRY',
  'NPM_CONFIG_USERCONFIG',
  'PATH',
  'PATHEXT',
  'PNPM_DISABLE_SELF_UPDATE_CHECK',
  'SYSTEMROOT',
  'TEMP',
  'TMP',
  'USERPROFILE',
  'WINDIR',
  'XDG_CONFIG_HOME',
]);
const PRESEAL_GIT_ENV_NAMES = Object.freeze([
  'APPDATA',
  'COMSPEC',
  'FORCE_COLOR',
  'GCM_INTERACTIVE',
  'GIT_ATTR_NOSYSTEM',
  'GIT_CONFIG_GLOBAL',
  'GIT_CONFIG_NOSYSTEM',
  'GIT_CONFIG_SYSTEM',
  'GIT_EXEC_PATH',
  'GIT_NO_REPLACE_OBJECTS',
  'GIT_OPTIONAL_LOCKS',
  'GIT_TERMINAL_PROMPT',
  'GIT_TRACE2_EVENT',
  'HOME',
  'LANG',
  'LC_ALL',
  'LOCALAPPDATA',
  'NO_COLOR',
  'PATH',
  'PATHEXT',
  'SYSTEMROOT',
  'TEMP',
  'TMP',
  'USERPROFILE',
  'WINDIR',
  'XDG_CONFIG_HOME',
]);
const PRESEAL_GPG_ENV_NAMES = Object.freeze([
  'APPDATA',
  'COMSPEC',
  'FORCE_COLOR',
  'GCM_INTERACTIVE',
  'GIT_CONFIG_GLOBAL',
  'GIT_CONFIG_NOSYSTEM',
  'GIT_CONFIG_SYSTEM',
  'GIT_NO_REPLACE_OBJECTS',
  'GIT_OPTIONAL_LOCKS',
  'GIT_TERMINAL_PROMPT',
  'HOME',
  'LANG',
  'LC_ALL',
  'LOCALAPPDATA',
  'NO_COLOR',
  'PATH',
  'PATHEXT',
  'SYSTEMROOT',
  'TEMP',
  'TMP',
  'USERPROFILE',
  'WINDIR',
  'XDG_CONFIG_HOME',
]);
const PRESEAL_RUNTIME_PROBE_CODE =
  'process.stdout.write(JSON.stringify({arch:process.arch,execArgv:process.execArgv,modules:process.versions.modules,napi:process.versions.napi,nodeOptions:process.env.NODE_OPTIONS??null,nodePath:process.env.NODE_PATH??null,platform:process.platform,version:process.versions.node}))';
const PRESEAL_BOOTSTRAP_PLAN_SCHEMA = 'pc-sdk.cx-004.system-tool-authority-bootstrap-plan.v1';
const PRESEAL_FILESYSTEM_AUDIT_PLAN_SCHEMA = 'pc-sdk.cx-004.native-build-input-filesystem-audit-plan.v1';
const PRESEAL_PATH_POLICY_PLAN_SCHEMA = 'pc-sdk.cx-004.preseal-path-policy.v1';
const PRESEAL_AUTHENTICODE_PLAN_SCHEMA = 'pc-sdk.cx-004.authenticode-probe-plan.v1';
const PRESEAL_EXCLUSION_IDS = Object.freeze([
  'provider-codex-configured-home',
  'provider-codex-default-home',
  'provider-claude-configured-home',
  'provider-claude-default-home',
  'stable-repository',
  'active-repository',
]);
const PRESEAL_LOADED_MODULE_BINDINGS = Object.freeze([
  ['preseal-capture-entry', 'manifest-authority/toolchain/preseal/capture-preseal-evidence.mjs'],
  ['system-tool-authority-module', 'manifest-authority/toolchain/preseal/system-tool-authority.mjs'],
  ['preseal-evidence-module', 'manifest-authority/toolchain/preseal/preseal-evidence.mjs'],
  ['runner-bootstrap-module', 'manifest-authority/toolchain/preseal/runner-bootstrap.mjs'],
  ['manifest-set-module', 'manifest-authority/toolchain/manifest-set.mjs'],
  ['preseal-config-projection-module', 'manifest-authority/toolchain/preseal-config-projection.mjs'],
  ['pe-inspect-module', 'manifest-authority/toolchain/probe/pe-inspect.mjs'],
]);
const PRESEAL_INLINE_LAUNCHER_ID = 'preseal-inline-launcher';
const PRESEAL_INLINE_LAUNCHER_LOGICAL_PATH =
  'manifest-authority/toolchain/preseal/preseal-inline-launcher.mjs';
const PRESEAL_INLINE_LAUNCHER_KIND = 'pinned-node-inline-memory-loader-v1';
const PRESEAL_IN_MEMORY_LOADER_ID = 'preseal-in-memory-loader';
const PRESEAL_IN_MEMORY_LOADER_LOGICAL_PATH =
  'manifest-authority/toolchain/preseal/preseal-in-memory-loader.mjs';
const PRESEAL_IN_MEMORY_LOADER_SHA256 =
  '0f8703f49ad74b0b45f836c50c049a3782afdc10b73504a9f208dcc8e8b1c37a';
const PRESEAL_INLINE_LOADER_READY_SCHEMA = 'pc-sdk.cx-004.preseal-loader-ready.v1';

function presealEntryPlanSha256(logicalPlan) {
  return sha256Bytes(canonicalJsonBytes(logicalPlan));
}

function presealAuthorityPath(id) {
  return `<authority-path:${id}>`;
}

function presealAuthorityRoot(sourceId) {
  return `<authority-root:${sourceId}>`;
}

function presealProjectedExclusions({ pathOnly = false } = {}) {
  return PRESEAL_EXCLUSION_IDS.map((id) => ({
    id,
    ...(pathOnly ? {} : { mustExist: false }),
    path: `<exclusion:${id}>`,
    ...(pathOnly ? {} : { role: 'exclusion' }),
  }));
}

function presealProjectedAuditSource(source, sourceIndex, phase) {
  const sourceId = `${phase}-${String(sourceIndex).padStart(2, '0')}`;
  const identityPolicy = source.identityPolicy === undefined
    ? {}
    : source.identityPolicy.kind === 'pnpm-content-addressed-store-hardlink-v1'
      ? { identityPolicy: { kind: source.identityPolicy.kind } }
      : {
          identityPolicy: {
            kind: source.identityPolicy.kind,
            linkCount: source.identityPolicy.linkCount,
            relativePaths: [...source.identityPolicy.relativePaths],
          },
        };
  return {
    files: source.mode === 'files' ? [...source.files] : [],
    ...identityPolicy,
    logicalPrefix: source.logicalPrefix,
    mode: source.mode,
    rootPath: presealAuthorityRoot(sourceId),
    sourceId,
    sourceIndex,
    surfaceId: source.surfaceId,
  };
}

function presealProjectedSurfaceAuditPlan(config, surfaceId, phase) {
  const surface = requirePresealEntry(
    config.surfaces,
    (entry) => entry.surfaceId === surfaceId,
    `${surfaceId} audit surface`,
  );
  return {
    schemaVersion: PRESEAL_FILESYSTEM_AUDIT_PLAN_SCHEMA,
    sources: surface.sources.map((source, sourceIndex) => presealProjectedAuditSource({
      ...source,
      surfaceId,
    }, sourceIndex, phase)),
  };
}

function presealProjectedPrivateAuditPlan(surfaceId, sourceId, logicalPrefix, mode = 'tree') {
  return {
    schemaVersion: PRESEAL_FILESYSTEM_AUDIT_PLAN_SCHEMA,
    sources: [{
      files: [],
      logicalPrefix,
      mode,
      rootPath: presealAuthorityRoot(sourceId),
      sourceId,
      sourceIndex: 0,
      surfaceId,
    }],
  };
}

function presealExpectedAuditPlan(config, evidenceId) {
  const surfacePlans = new Map([
    ['git-source-before', 'git-execution-closure'],
    ['git-source-after', 'git-execution-closure'],
    ['gpg-source-preuse', 'git-signature-verification-closure'],
    ['official-objects-preuse', 'official-object-inputs'],
    ['pnpm-dist-preuse', 'pnpm-distribution'],
    ['pnpm-dist-after', 'pnpm-distribution'],
    ['pnpm-store-before', 'pnpm-store-v10'],
    ['pnpm-store-after', 'pnpm-store-v10'],
  ]);
  if (surfacePlans.has(evidenceId)) {
    return presealProjectedSurfaceAuditPlan(config, surfacePlans.get(evidenceId), evidenceId);
  }
  if (['private-system-tools-before', 'private-system-tools-after'].includes(evidenceId)) {
    return presealProjectedPrivateAuditPlan(
      'private-system-tools',
      'private-system-tools',
      'run-private/system-tools',
    );
  }
  if (['private-git-before', 'private-git-after'].includes(evidenceId)) {
    return presealProjectedPrivateAuditPlan(
      'private-git-runtime',
      'private-git-00',
      'run-private/git',
    );
  }
  if (['git-exec-path-before', 'git-exec-path-after'].includes(evidenceId)) {
    return presealProjectedPrivateAuditPlan(
      'git-exec-path-empty',
      'git-exec-path-00',
      'run-private/git-exec-path',
      'empty-tree',
    );
  }
  if (['gpg-copy-before', 'gpg-copy-after'].includes(evidenceId)) {
    return presealProjectedPrivateAuditPlan(
      'git-signature-verification-closure',
      'gpg-copy-00',
      'git/usr/bin',
    );
  }
  fail(`preseal audit evidence id ${JSON.stringify(evidenceId)} has no exact entry-plan authority`);
}

function presealProjectedPathPolicyPlan(phase) {
  const staged = phase !== 'prestage';
  const entry = (id, mustExist, role) => ({
    id,
    mustExist,
    path: presealAuthorityPath(id),
    role,
  });
  const paths = [
    entry('cache-root', true, 'input'),
    entry('git-root', true, 'input'),
    entry('receipt-directory', true, 'input'),
    entry('repo-root', true, 'input'),
    entry('system-root', true, 'input'),
    entry('node-executable', true, 'input'),
    entry('run-root', true, 'output'),
    entry('temp-root', true, 'output'),
    entry('workspace-root', staged, 'output'),
    entry('gpg-runtime-root', staged, 'output'),
    entry('private-git-root', staged, 'output'),
    entry('git-exec-path', staged, 'output'),
  ];
  if (phase === 'git-rewrite-inputs') {
    paths.push(
      entry('git-common-directory', true, 'input'),
      entry('git-grafts-file', false, 'input'),
      entry('git-shallow-file', false, 'input'),
    );
  }
  paths.push(
    entry('payload-final', false, 'output'),
    entry('payload-temporary', false, 'output'),
    entry('root-final', false, 'output'),
    entry('root-temporary', false, 'output'),
  );
  return {
    exclusions: presealProjectedExclusions(),
    paths,
    schemaVersion: PRESEAL_PATH_POLICY_PLAN_SCHEMA,
  };
}

function presealProjectedBootstrapPlan(root, payload, serviced) {
  const bindings = serviced.workerBindings.map((tuple) => ({
    bytes: tuple[1],
    id: tuple[0],
    path: presealAuthorityPath(tuple[0]),
    sha256: tuple[2],
  }));
  const powershell = root.hostToolchain.authenticodeVerificationTool;
  const taskkill = root.hostToolchain.processTreeTerminationTool;
  const sourceInputs = (id, tool) => tool.logicalPaths.map((_, index) => ({
    id: `${id}-source-${index}`,
    path: presealAuthorityPath(`${id}-source-${index}`),
  }));
  const tools = [
    ['powershell', powershell],
    ['taskkill', taskkill],
  ].map(([id, tool]) => ({
    bytes: tool.bytes,
    destinationFileName: tool.privateCopyFileName,
    id,
    privateLinkCount: 1,
    sha256: tool.sha256,
    sourceLinkCount: tool.hardlinkCount,
    sourceRelativePaths: tool.logicalPaths.map((logicalPath) => logicalPath.slice('windows/'.length)),
  }));
  return {
    authorityParent: '<cache>/runs',
    bindings,
    bootstrapScratchRoot: '<system>/Temp',
    pathPolicy: {
      exclusions: presealProjectedExclusions({ pathOnly: true }),
      inputs: [
        { id: 'authority-parent', path: presealAuthorityPath('authority-parent') },
        { id: 'bootstrap-scratch-root', path: presealAuthorityPath('bootstrap-scratch-root') },
        { id: 'system-root', path: presealAuthorityPath('system-root') },
        ...bindings.map((binding) => ({ id: binding.id, path: presealAuthorityPath(binding.id) })),
        ...sourceInputs('powershell', powershell),
        ...sourceInputs('taskkill', taskkill),
      ],
      outputs: [
        { id: 'run-root', path: presealAuthorityPath('run-root') },
        { id: 'private-tool-root', path: presealAuthorityPath('private-tool-root') },
        { id: 'temp-root', path: presealAuthorityPath('temp-root') },
      ],
    },
    privateToolRoot: '<run>/system-tools',
    runLeaf: payload.runId,
    runRoot: '<run>',
    schemaVersion: PRESEAL_BOOTSTRAP_PLAN_SCHEMA,
    systemRoot: '<system>',
    tempRoot: '<run>/temp',
    tools,
  };
}

function presealBindingMap(tuples, label) {
  const bindings = new Map();
  for (const [index, tuple] of tuples.entries()) {
    validatePresealTuple(tuple, `${label}[${index}]`);
    if (bindings.has(tuple[0])) fail(`${label} repeats binding ${tuple[0]}`);
    bindings.set(tuple[0], tuple);
  }
  return bindings;
}

function presealScriptBinding(tuple, label) {
  if (tuple === undefined) fail(`${label} binding is unavailable`);
  return {
    bytes: tuple[1],
    id: tuple[0],
    identityPolicy: PRESEAL_NATIVE_FILE_IDENTITY_POLICY,
    sha256: tuple[2],
  };
}

function presealExecutionAuthority(bytes, sha256, kind, identityPolicy) {
  return { bytes, identityPolicy, kind, sha256 };
}

function presealCacheLogicalPath(logicalPath, label) {
  if (
    typeof logicalPath !== 'string' ||
    !logicalPath.startsWith('cache/') ||
    logicalPath.includes('\\') ||
    logicalPath.includes('\0')
  ) {
    fail(`${label} must be one cache-relative logical path`);
  }
  return `<cache>/${logicalPath.slice('cache/'.length)}`;
}

function presealAssetByRole(input, role, label) {
  return requirePresealEntry(input.assets, (asset) => asset.role === role, `${label} ${role}`);
}

function presealCacheSurfaceRoot(config, surfaceId) {
  const surface = requirePresealEntry(config.surfaces, (entry) => entry.surfaceId === surfaceId, `${surfaceId} surface`);
  if (
    !Array.isArray(surface.sources) ||
    surface.sources.length !== 1 ||
    surface.sources[0].location !== 'cache' ||
    typeof surface.sources[0].relativeRoot !== 'string' ||
    surface.sources[0].relativeRoot.length === 0
  ) {
    fail(`${surfaceId} must have one cache-rooted source authority`);
  }
  return `<cache>/${surface.sources[0].relativeRoot}`;
}

function presealStoreParent(config) {
  const surface = requirePresealEntry(config.surfaces, (entry) => entry.surfaceId === 'pnpm-store-v10', 'pnpm-store-v10 surface');
  if (!Array.isArray(surface.sources) || surface.sources.length === 0) {
    fail('pnpm-store-v10 must have source authority');
  }
  const parents = new Set(surface.sources.map((source) => {
    if (source.location !== 'cache' || typeof source.relativeRoot !== 'string') {
      fail('pnpm-store-v10 sources must be cache-rooted');
    }
    return path.posix.dirname(source.relativeRoot);
  }));
  if (parents.size !== 1) fail('pnpm-store-v10 sources must share one v10 parent');
  return `<cache>/${path.posix.dirname([...parents][0])}`;
}

function expectedPresealCommandSpecs(config, payload) {
  const root = config.root;
  const serviced = payload.servicedSystemTools;
  const policy = root.hostToolchain.servicedSystemToolPolicy;
  const powershell = root.hostToolchain.authenticodeVerificationTool;
  const node = requirePresealEntry(root.officialInputs, (entry) => entry.id === 'node-v22.13.0-win-x64', 'Node official input');
  const llvm = requirePresealEntry(root.officialInputs, (entry) => entry.id === 'llvm-19.1.7-windows-msvc', 'LLVM official input');
  const python = requirePresealEntry(root.officialInputs, (entry) => entry.id === 'python-3.13.14-embed-amd64', 'Python official input');
  const gpg = requirePresealEntry(root.hostToolchain.signatureVerificationClosure.files, (tuple) => tuple[0].endsWith('/gpg.exe'), 'GPG executable tuple');
  const gpgv = requirePresealEntry(root.hostToolchain.signatureVerificationClosure.files, (tuple) => tuple[0].endsWith('/gpgv.exe'), 'GPGV executable tuple');
  const entries = presealBindingMap(serviced.entryBindings, 'servicedSystemTools.entryBindings');
  const workers = presealBindingMap(serviced.workerBindings, 'servicedSystemTools.workerBindings');
  const powershellArgv = [...PRESEAL_POWERSHELL_ARGV];
  const powershellEnvironment = [...PRESEAL_POWERSHELL_ENV_NAMES];
  const privatePowerShellAuthority = presealExecutionAuthority(
    powershell.bytes,
    powershell.sha256,
    'powershell-private',
    policy.privateCopyIdentity,
  );
  const sourcePowerShellAuthority = presealExecutionAuthority(
    powershell.bytes,
    powershell.sha256,
    'powershell-source-bootstrap',
    policy.sourceIdentity,
  );
  const nativeAuthority = (tuple) => presealExecutionAuthority(
    tuple[0],
    tuple[1],
    'native-executable',
    PRESEAL_NATIVE_FILE_IDENTITY_POLICY,
  );
  const powerShell = (executableId, binding, entryPlan, {
    cwd = '<run>',
    executionAuthority = privatePowerShellAuthority,
    terminationToolId = 'taskkill-private',
    timeoutMs = 120_000,
  } = {}) => ({
    argv: powershellArgv,
    commandTimeoutMs: timeoutMs,
    cwd,
    entryBinding: presealScriptBinding(binding, executableId),
    entryPlanSha256: presealEntryPlanSha256(entryPlan),
    envProjectionNames: powershellEnvironment,
    executableId,
    executionAuthority,
    inProcessLoaderSha256: PRESEAL_IN_PROCESS_LOADER_SHA256,
    stdinRequired: true,
    terminationToolId,
  });
  const native = (executableId, argv, cwd, envProjectionNames, authority, timeoutMs = 120_000) => ({
    argv,
    commandTimeoutMs: timeoutMs,
    cwd,
    envProjectionNames,
    executableId,
    executionAuthority: authority,
    stdinRequired: false,
    terminationToolId: 'taskkill-private',
  });
  const audit = (evidenceId, timeoutMs = 30 * 60_000) => powerShell(
    `filesystem-audit-${evidenceId}`,
    workers.get('audit-worker'),
    presealExpectedAuditPlan(config, evidenceId),
    { timeoutMs },
  );
  const pathPolicy = (phase) => powerShell(
    'path-policy-probe',
    entries.get('path-policy-probe'),
    presealProjectedPathPolicyPlan(phase),
  );
  const nodeAuthority = nativeAuthority([node.nodeExe.bytes, node.nodeExe.sha256]);
  const gitAuthority = nativeAuthority([
    root.hostToolchain.git.sourceExecutable[1],
    root.hostToolchain.git.sourceExecutable[2],
  ]);
  const gpgAuthority = nativeAuthority([gpg[1], gpg[2]]);
  const gpgvAuthority = nativeAuthority([gpgv[1], gpgv[2]]);
  const git = (executableId, args) => native(
    executableId,
    ['--no-pager', '--no-replace-objects', '--no-lazy-fetch', '-C', '<repo>', ...args],
    '<repo>',
    [...PRESEAL_GIT_ENV_NAMES],
    gitAuthority,
  );
  const gpgCommand = (executableId, argv, authority, timeoutMs = 120_000) => native(
    executableId,
    argv,
    '<run>',
    [...PRESEAL_GPG_ENV_NAMES],
    authority,
    timeoutMs,
  );
  const repositoryAuthorities = presealRepositoryChainAuthorities(
    root.provenance,
    'preseal command repository authority',
  );
  const publishedCommit = repositoryAuthorities.publishedBase.landing;
  const t0Commit = repositoryAuthorities.historicalT0.landing;
  const specs = [
    powerShell(
      'system-tool-authority-bootstrap',
      workers.get('bootstrap-wrapper'),
      presealProjectedBootstrapPlan(root, payload, serviced),
      {
      cwd: '<bootstrap-scratch>',
      executionAuthority: sourcePowerShellAuthority,
      terminationToolId: 'taskkill-source-bootstrap-failure-only',
      },
    ),
    audit('private-system-tools-before', 120_000),
    pathPolicy('prestage'),
    pathPolicy('postcreate'),
    native(
      'node-runtime-replay',
      ['-e', PRESEAL_RUNTIME_PROBE_CODE],
      '<run>',
      [...PRESEAL_NODE_ENV_NAMES],
      nodeAuthority,
    ),
    audit('git-source-before'),
    audit('private-git-before'),
    audit('git-exec-path-before'),
    git('git-head-commit', ['rev-parse', 'HEAD^{commit}']),
    git('git-head-tree', ['rev-parse', `${publishedCommit}^{tree}`]),
    git('git-head-parents', ['show', '-s', '--format=%P', publishedCommit]),
    git('git-t0-commit', ['rev-parse', `${t0Commit}^{commit}`]),
    git('git-t0-tree', ['rev-parse', `${t0Commit}^{tree}`]),
    git('git-t0-parents', ['show', '-s', '--format=%P', t0Commit]),
    git('git-common-dir', ['rev-parse', '--path-format=absolute', '--git-common-dir']),
    pathPolicy('git-rewrite-inputs'),
  ];
  for (const [index, [relativePath]] of root.provenance.t0TrackedInputs.entries()) {
    const suffix = String(index).padStart(2, '0');
    const objectSpec = `${t0Commit}:${relativePath}`;
    specs.push(
      git(`git-t0-blob-id-${suffix}`, ['rev-parse', objectSpec]),
      git(`git-t0-blob-content-${suffix}`, ['cat-file', 'blob', objectSpec]),
    );
  }
  const pnpmCjs = `${presealCacheSurfaceRoot(config, 'pnpm-distribution')}/bin/pnpm.cjs`;
  specs.push(
    audit('pnpm-dist-preuse'),
    audit('pnpm-store-before'),
    native(
      'node-pnpm-version',
      [pnpmCjs, '--version'],
      '<run>/workspace',
      [...PRESEAL_PNPM_ENV_NAMES],
      nodeAuthority,
    ),
    native(
      'node-pnpm-install',
      [
        pnpmCjs,
        'install',
        '--offline',
        '--frozen-lockfile',
        '--ignore-scripts',
        '--store-dir',
        presealStoreParent(config),
        '--reporter=append-only',
        '--registry=http://127.0.0.1:9/',
        '--network-concurrency=1',
        '--fetch-retries=0',
      ],
      '<run>/workspace',
      [...PRESEAL_PNPM_ENV_NAMES],
      nodeAuthority,
      15 * 60_000,
    ),
    audit('pnpm-store-after'),
    audit('pnpm-dist-after'),
    audit('official-objects-preuse'),
    audit('gpg-source-preuse'),
    pathPolicy('gpg-copy'),
    audit('gpg-copy-before'),
  );
  const cacheAsset = (input, role, label) => presealCacheLogicalPath(
    presealAssetByRole(input, role, label).cacheKey,
    `${label} ${role}`,
  );
  const nodeKeyPath = presealCacheLogicalPath(
    payload.signatures?.node?.historicalKeyring?.logicalPath,
    'payload.signatures.node.historicalKeyring.logicalPath',
  );
  const pythonKeyPath = presealCacheLogicalPath(
    python.signatureVerification.releaseKey.logicalPath,
    'Python release key logicalPath',
  );
  specs.push(
    gpgCommand('pinned-gpgv-node-detached', [
      '--homedir', '<run>/gpgv-home', '--status-fd', '1', '--keyring', nodeKeyPath,
      cacheAsset(node, 'detached-checksum-signature', 'Node'),
      cacheAsset(node, 'signed-checksum-manifest', 'Node'),
    ], gpgvAuthority),
    gpgCommand('pinned-gpgv-node-clearsigned', [
      '--homedir', '<run>/gpgv-home', '--status-fd', '1', '--keyring', nodeKeyPath,
      '--output', '<run>/node-clearsigned-payload.txt',
      cacheAsset(node, 'clear-signed-checksum-manifest', 'Node'),
    ], gpgvAuthority),
    gpgCommand('pinned-gpg-llvm-key-dearmor', [
      '--no-options', '--batch', '--no-tty', '--no-autostart', '--yes', '--dearmor', '--output',
      '<run>/llvm-gpg-home/llvm-release-keyring.gpg', cacheAsset(llvm, 'official-release-public-keys', 'LLVM'),
    ], gpgAuthority),
    gpgCommand('pinned-gpg-llvm-explicit-sha1-allowance', [
      '--no-options', '--homedir', '<run>/llvm-gpg-home', '--batch', '--no-tty', '--no-autostart',
      '--no-auto-key-retrieve', '--no-default-keyring', '--keyring', '<run>/llvm-gpg-home/llvm-release-keyring.gpg',
      '--status-fd', '1', '--trust-model', 'always', '--allow-weak-digest-algos', '--verify',
      cacheAsset(llvm, 'detached-package-signature', 'LLVM'),
      cacheAsset(llvm, 'official-signed-windows-msvc-package', 'LLVM'),
    ], gpgAuthority, 5 * 60_000),
    gpgCommand('pinned-gpg-python-key-inspection', [
      '--no-options', '--homedir', '<run>/python-key-inspection-home', '--batch', '--no-tty', '--no-autostart',
      '--with-colons', '--import-options', 'show-only', '--dry-run', '--import', pythonKeyPath,
    ], gpgAuthority),
    gpgCommand('pinned-gpg-python-key-dearmor', [
      '--no-options', '--batch', '--no-tty', '--no-autostart', '--yes', '--dearmor', '--output',
      '<run>/python-release-keyring.gpg', pythonKeyPath,
    ], gpgAuthority),
    gpgCommand('pinned-gpgv-python-detached', [
      '--homedir', '<run>/gpgv-home', '--status-fd', '1', '--keyring',
      '<run>/python-release-keyring.gpg', cacheAsset(python, 'detached-package-signature', 'Python'),
      cacheAsset(python, 'official-isolated-windows-python', 'Python'),
    ], gpgvAuthority),
    audit('gpg-copy-after'),
    powerShell('authenticode-probe', entries.get('authenticode-probe'), {
      nodePath: `${presealCacheSurfaceRoot(config, 'node-distribution')}/node.exe`,
      powershellPath: `<run>/system-tools/${powershell.privateCopyFileName}`,
      pythonPath: `${presealCacheSurfaceRoot(config, 'python-embed')}/python.exe`,
      schemaVersion: PRESEAL_AUTHENTICODE_PLAN_SCHEMA,
      taskkillPath: `<run>/system-tools/${root.hostToolchain.processTreeTerminationTool.privateCopyFileName}`,
    }),
    pathPolicy('prewrite'),
    audit('git-source-after'),
    audit('private-git-after'),
    audit('git-exec-path-after'),
    audit('private-system-tools-after', 120_000),
  );
  return specs;
}

function validatePresealCommandClosure(config, payload, declared, serviced, policy, label) {
  const commands = payload.commands;
  const expectedSpecs = expectedPresealCommandSpecs(config, payload);
  if (!Array.isArray(commands) || commands.length !== declared.commandCount) {
    fail(`${label} length does not equal the declared commandCount`);
  }
  if (
    declared.commandCount !== CX004_PRESEAL_COMMAND_COUNT ||
    serviced.commandCount !== CX004_PRESEAL_COMMAND_COUNT ||
    commands.length !== CX004_PRESEAL_COMMAND_COUNT ||
    expectedSpecs.length !== CX004_PRESEAL_COMMAND_COUNT
  ) {
    fail(`${label} must contain the exact ${CX004_PRESEAL_COMMAND_COUNT}-command closure`);
  }
  if (serviced.commandCount !== commands.length) {
    fail(`${label} length does not equal servicedSystemTools.commandCount`);
  }
  if (expectedSpecs.length !== commands.length) {
    fail(`${label} length does not equal the config-derived exact operation closure (${expectedSpecs.length})`);
  }
  assertExactStringArray(
    commands.map((command) => command?.executableId),
    expectedSpecs.map((spec) => spec.executableId),
    `${label} exact operation sequence`,
  );
  const allowedKeys = [
    'argv',
    'cleanupErrorCode',
    'cleanupOutcome',
    'commandTimeoutMs',
    'cwd',
    'durationMs',
    'entryBinding',
    'entryPlanSha256',
    'envProjectionNames',
    'executableId',
    'executionAuthority',
    'exitCode',
    'inProcessLoaderSha256',
    'overflow',
    'ownedRootExitObserved',
    'ownedRootExitTimeoutMs',
    'shell',
    'signal',
    'stderr',
    'stdin',
    'stdout',
    'timedOut',
    'terminationPolicyId',
    'terminationReason',
    'terminationRequested',
    'terminationToolCompletionObserved',
    'terminationToolExitCode',
    'terminationToolId',
    'terminationToolReceipt',
    'terminationToolSignal',
    'terminationToolTimeoutMs',
  ];
  const requiredKeys = allowedKeys.filter((key) => ![
    'entryBinding',
    'entryPlanSha256',
    'inProcessLoaderSha256',
    'stdin',
    'terminationToolReceipt',
  ].includes(key));
  let sourcePowerShellCount = 0;
  for (const [index, command] of commands.entries()) {
    const commandLabel = `${label}[${index}]`;
    assertAllowedKeys(command, allowedKeys, requiredKeys, commandLabel);
    if (!Array.isArray(command.argv) || command.argv.some((entry) => typeof entry !== 'string')) {
      fail(`${commandLabel}.argv must be a string array`);
    }
    if (!Array.isArray(command.envProjectionNames)) {
      fail(`${commandLabel}.envProjectionNames must be an array`);
    }
    assertExactStringArray(
      command.envProjectionNames,
      [...command.envProjectionNames].sort(ordinalCompare),
      `${commandLabel}.envProjectionNames`,
    );
    if (new Set(command.envProjectionNames.map((name) => name.toLocaleLowerCase('en-US'))).size !== command.envProjectionNames.length) {
      fail(`${commandLabel}.envProjectionNames must be case-insensitively unique`);
    }
    assertUnicodeScalarString(command.cwd, `${commandLabel}.cwd`);
    assertUnicodeScalarString(command.executableId, `${commandLabel}.executableId`);
    if (command.executableId.length === 0) {
      fail(`${commandLabel}.executableId must be a non-empty operation id`);
    }
    assertNonNegativeSafeInteger(command.durationMs, `${commandLabel}.durationMs`);
    assertPositiveSafeInteger(command.commandTimeoutMs, `${commandLabel}.commandTimeoutMs`);
    assertExactKeys(command.executionAuthority, ['bytes', 'identityPolicy', 'kind', 'sha256'], `${commandLabel}.executionAuthority`);
    assertPositiveSafeInteger(command.executionAuthority.bytes, `${commandLabel}.executionAuthority.bytes`);
    assertSha256(command.executionAuthority.sha256, `${commandLabel}.executionAuthority.sha256`);
    assertUnicodeScalarString(command.executionAuthority.identityPolicy, `${commandLabel}.executionAuthority.identityPolicy`);
    assertUnicodeScalarString(command.executionAuthority.kind, `${commandLabel}.executionAuthority.kind`);
    if (!['native-executable', 'powershell-private', 'powershell-source-bootstrap'].includes(command.executionAuthority.kind)) {
      fail(`${commandLabel}.executionAuthority.kind is outside the admitted command authority`);
    }
    if (command.executionAuthority.kind === 'powershell-source-bootstrap') sourcePowerShellCount += 1;
    for (const stream of ['stderr', 'stdout', ...(command.stdin === undefined ? [] : ['stdin'])]) {
      assertExactKeys(command[stream], ['bytes', 'sha256'], `${commandLabel}.${stream}`);
      assertNonNegativeSafeInteger(command[stream].bytes, `${commandLabel}.${stream}.bytes`);
      assertSha256(command[stream].sha256, `${commandLabel}.${stream}.sha256`);
    }
    if (command.entryBinding !== undefined) {
      assertExactKeys(command.entryBinding, ['bytes', 'id', 'identityPolicy', 'sha256'], `${commandLabel}.entryBinding`);
      assertPositiveSafeInteger(command.entryBinding.bytes, `${commandLabel}.entryBinding.bytes`);
      assertSha256(command.entryBinding.sha256, `${commandLabel}.entryBinding.sha256`);
    }
    if (command.inProcessLoaderSha256 !== undefined) {
      assertSha256(command.inProcessLoaderSha256, `${commandLabel}.inProcessLoaderSha256`);
    }
    if (command.entryPlanSha256 !== undefined) {
      assertSha256(command.entryPlanSha256, `${commandLabel}.entryPlanSha256`);
    }
    const powerShellBindingsPresent = [
      command.entryBinding,
      command.entryPlanSha256,
      command.inProcessLoaderSha256,
    ].filter((entry) => entry !== undefined).length;
    if (![0, 3].includes(powerShellBindingsPresent)) {
      fail(`${commandLabel} must carry entryBinding, entryPlanSha256, and inProcessLoaderSha256 together`);
    }
    const expectedSpec = expectedSpecs[index];
    if (
      (expectedSpec.stdinRequired && command.stdin === undefined) ||
      (!expectedSpec.stdinRequired && command.stdin !== undefined) ||
      (expectedSpec.stdinRequired && command.stdin.bytes < 1)
    ) {
      fail(`${commandLabel}.stdin presence does not equal its exact operation contract`);
    }
    const expectedPlanProjection = {
      argv: expectedSpec.argv,
      commandTimeoutMs: expectedSpec.commandTimeoutMs,
      cwd: expectedSpec.cwd,
      envProjectionNames: expectedSpec.envProjectionNames,
      executableId: expectedSpec.executableId,
      executionAuthority: expectedSpec.executionAuthority,
      terminationToolId: expectedSpec.terminationToolId,
      ...(expectedSpec.entryBinding === undefined ? {} : {
        entryBinding: expectedSpec.entryBinding,
        entryPlanSha256: expectedSpec.entryPlanSha256,
        inProcessLoaderSha256: expectedSpec.inProcessLoaderSha256,
      }),
    };
    const actualPlanProjection = {
      argv: command.argv,
      commandTimeoutMs: command.commandTimeoutMs,
      cwd: command.cwd,
      envProjectionNames: command.envProjectionNames,
      executableId: command.executableId,
      executionAuthority: command.executionAuthority,
      terminationToolId: command.terminationToolId,
      ...(command.entryBinding === undefined ? {} : {
        entryBinding: command.entryBinding,
        entryPlanSha256: command.entryPlanSha256,
        inProcessLoaderSha256: command.inProcessLoaderSha256,
      }),
    };
    assertCanonicalValueEqual(actualPlanProjection, expectedPlanProjection, `${commandLabel} exact operation plan`);
    if (
      command.cleanupErrorCode !== null ||
      command.cleanupOutcome !== 'not-required' ||
      command.durationMs > command.commandTimeoutMs ||
      command.exitCode !== 0 ||
      command.overflow !== false ||
      command.ownedRootExitObserved !== true ||
      command.ownedRootExitTimeoutMs !== policy.ownedRootExitTimeoutMs ||
      command.shell !== false ||
      command.signal !== null ||
      command.timedOut !== false ||
      command.terminationPolicyId !== policy.terminationInvocation ||
      command.terminationReason !== null ||
      command.terminationRequested !== false ||
      command.terminationToolCompletionObserved !== false ||
      command.terminationToolExitCode !== null ||
      !['taskkill-private', 'taskkill-source-bootstrap-failure-only'].includes(command.terminationToolId) ||
      command.terminationToolReceipt !== undefined ||
      command.terminationToolSignal !== null ||
      command.terminationToolTimeoutMs !== policy.terminationToolTimeoutMs
    ) {
      fail(`${commandLabel} is not an admitted closed, successful shell:false command`);
    }
  }
  const expectedNativeIds = expectedSpecs
    .filter((spec) => spec.entryBinding === undefined)
    .map((spec) => spec.executableId);
  const actualNativeIds = commands
    .filter((command) => command.executionAuthority.kind === 'native-executable')
    .map((command) => command.executableId);
  if (new Set(actualNativeIds).size !== actualNativeIds.length) {
    fail(`${label} repeats a one-shot native operation id`);
  }
  assertExactStringArray(actualNativeIds, expectedNativeIds, `${label} one-shot native operation closure`);
  if (
    sourcePowerShellCount !== 1 ||
    sourcePowerShellCount !== serviced.bootstrapSourceExecutionCount ||
    serviced.sourceTaskkillExecutionCount !== 0
  ) {
    fail(`${label} does not prove exactly one source PowerShell bootstrap and zero source taskkill executions`);
  }
}

function validatePresealServicedSystemTools(config, payload, declared, root, label) {
  const serviced = payload.servicedSystemTools;
  const policy = root.hostToolchain.servicedSystemToolPolicy;
  const powershell = root.hostToolchain.authenticodeVerificationTool;
  const taskkill = root.hostToolchain.processTreeTerminationTool;
  assertExactKeys(serviced, [
    'bootstrapExecutionPolicy',
    'bootstrapFailureCleanupUsed',
    'bootstrapSourceExecutionCount',
    'commandCount',
    'entryBindings',
    'exclusionIds',
    'loadedModuleBindings',
    'loadedModuleExecution',
    'privateCopy',
    'sourceIdentityPolicy',
    'sourceTaskkillExecutionCount',
    'sourceTopology',
    'termination',
    'workerBindings',
  ], label);
  assertPositiveSafeInteger(serviced.commandCount, `${label}.commandCount`);
  if (
    serviced.bootstrapExecutionPolicy !== policy.bootstrapExecution ||
    serviced.bootstrapFailureCleanupUsed !== false ||
    serviced.bootstrapSourceExecutionCount !== policy.bootstrapSourceExecutionLimit ||
    serviced.sourceIdentityPolicy !== policy.sourceIdentity ||
    serviced.sourceTaskkillExecutionCount !== 0
  ) {
    fail(`${label} does not equal the sealed system-tool execution policy`);
  }
  if (!Array.isArray(serviced.entryBindings) || serviced.entryBindings.length !== 2) {
    fail(`${label}.entryBindings must contain exactly two script bindings`);
  }
  serviced.entryBindings.forEach((tuple, index) => validatePresealTuple(tuple, `${label}.entryBindings[${index}]`));
  assertExactStringArray(serviced.entryBindings.map((tuple) => tuple[0]), [
    'authenticode-probe',
    'path-policy-probe',
  ], `${label}.entryBindings ids`);
  assertExactStringArray(serviced.exclusionIds, PRESEAL_EXCLUSION_IDS, `${label}.exclusionIds`);
  if (
    !Array.isArray(serviced.loadedModuleBindings) ||
    serviced.loadedModuleBindings.length !== PRESEAL_LOADED_MODULE_BINDINGS.length
  ) {
    fail(`${label}.loadedModuleBindings must contain the exact loaded local ESM graph`);
  }
  serviced.loadedModuleBindings.forEach((tuple, index) => (
    validatePresealTuple(tuple, `${label}.loadedModuleBindings[${index}]`)
  ));
  assertExactStringArray(
    serviced.loadedModuleBindings.map((tuple) => tuple[0]),
    PRESEAL_LOADED_MODULE_BINDINGS.map(([id]) => id),
    `${label}.loadedModuleBindings ids`,
  );
  assertExactKeys(serviced.loadedModuleExecution, [
    'executionGraphSha256',
    'inMemoryExecution',
    'launchArgvSha256',
    'launcherBinding',
    'launcherKind',
    'loadEventIds',
    'loaderBinding',
    'loaderReadyChallenge',
    'loaderReadyReceiptSha256',
    'loaderSha256',
    'rejectedRequestCount',
    'sourceStableReplayedAfterUse',
  ], `${label}.loadedModuleExecution`);
  const moduleExecution = serviced.loadedModuleExecution;
  validatePresealTuple(moduleExecution.launcherBinding, `${label}.loadedModuleExecution.launcherBinding`);
  if (moduleExecution.launcherBinding[0] !== PRESEAL_INLINE_LAUNCHER_ID) {
    fail(`${label}.loadedModuleExecution.launcherBinding does not equal the fixed inline launcher id`);
  }
  validatePresealTuple(moduleExecution.loaderBinding, `${label}.loadedModuleExecution.loaderBinding`);
  if (moduleExecution.loaderBinding[0] !== PRESEAL_IN_MEMORY_LOADER_ID) {
    fail(`${label}.loadedModuleExecution.loaderBinding does not equal the fixed in-memory loader id`);
  }
  assertSha256(moduleExecution.launchArgvSha256, `${label}.loadedModuleExecution.launchArgvSha256`);
  assertSha256(moduleExecution.loaderSha256, `${label}.loadedModuleExecution.loaderSha256`);
  assertSha256(moduleExecution.executionGraphSha256, `${label}.loadedModuleExecution.executionGraphSha256`);
  assertSha256(
    moduleExecution.loaderReadyReceiptSha256,
    `${label}.loadedModuleExecution.loaderReadyReceiptSha256`,
  );
  if (!/^[0-9a-f]{32}$/u.test(moduleExecution.loaderReadyChallenge)) {
    fail(`${label}.loadedModuleExecution.loaderReadyChallenge must be 128-bit lowercase hexadecimal`);
  }
  const expectedLaunchArgvSha256 = sha256Bytes(canonicalJsonBytes([
    '--input-type=module',
    '-e',
    `<inline-launcher:${moduleExecution.launcherBinding[2]}>`,
  ]));
  const expectedExecutionGraphSha256 = sha256Bytes(canonicalJsonBytes({
    launcherBinding: moduleExecution.launcherBinding,
    loaderBinding: moduleExecution.loaderBinding,
    moduleBindings: serviced.loadedModuleBindings,
  }));
  const expectedLoaderReadyReceiptSha256 = sha256Bytes(canonicalJsonBytes({
    challenge: moduleExecution.loaderReadyChallenge,
    executionGraphSha256: expectedExecutionGraphSha256,
    loaderSha256: moduleExecution.loaderSha256,
    moduleCount: PRESEAL_LOADED_MODULE_BINDINGS.length,
    schemaVersion: PRESEAL_INLINE_LOADER_READY_SCHEMA,
  }));
  assertExactStringArray(
    moduleExecution.loadEventIds,
    PRESEAL_LOADED_MODULE_BINDINGS.map(([id]) => id),
    `${label}.loadedModuleExecution.loadEventIds`,
  );
  if (
    moduleExecution.executionGraphSha256 !== expectedExecutionGraphSha256 ||
    moduleExecution.inMemoryExecution !== true ||
    moduleExecution.launchArgvSha256 !== expectedLaunchArgvSha256 ||
    moduleExecution.launcherKind !== PRESEAL_INLINE_LAUNCHER_KIND ||
    moduleExecution.loaderBinding[2] !== PRESEAL_IN_MEMORY_LOADER_SHA256 ||
    moduleExecution.loaderSha256 !== PRESEAL_IN_MEMORY_LOADER_SHA256 ||
    moduleExecution.loaderSha256 !== moduleExecution.loaderBinding[2] ||
    moduleExecution.loaderReadyReceiptSha256 !== expectedLoaderReadyReceiptSha256 ||
    moduleExecution.rejectedRequestCount !== 0 ||
    moduleExecution.sourceStableReplayedAfterUse !== true
  ) {
    fail(`${label}.loadedModuleExecution does not equal the admitted in-memory module graph`);
  }
  if (!Array.isArray(serviced.workerBindings) || serviced.workerBindings.length !== 4) {
    fail(`${label}.workerBindings must contain exactly four authority bindings`);
  }
  serviced.workerBindings.forEach((tuple, index) => validatePresealTuple(tuple, `${label}.workerBindings[${index}]`));
  assertExactStringArray(serviced.workerBindings.map((tuple) => tuple[0]), [
    'config',
    'bootstrap-wrapper',
    'audit-core',
    'audit-worker',
  ], `${label}.workerBindings ids`);
  assertCanonicalValueEqual(
    serviced.workerBindings[0].slice(1),
    [payload.configAuthority.capturedConfig.bytes, payload.configAuthority.capturedConfig.sha256],
    `${label}.workerBindings config authority`,
  );
  assertExactKeys(serviced.privateCopy, ['creation', 'identityPolicy', 'logicalRoot', 'tools'], `${label}.privateCopy`);
  assertCanonicalValueEqual(serviced.privateCopy, {
    creation: 'COPYFILE_EXCL; flush; close; reopen; double-hash',
    identityPolicy: policy.privateCopyIdentity,
    logicalRoot: '<private-tools>',
    tools: [
      {
        bytes: powershell.bytes,
        id: 'powershell-private',
        logicalPath: `<private-tools>/${powershell.privateCopyFileName}`,
        sha256: powershell.sha256,
      },
      {
        bytes: taskkill.bytes,
        id: 'taskkill-private',
        logicalPath: `<private-tools>/${taskkill.privateCopyFileName}`,
        sha256: taskkill.sha256,
      },
    ],
  }, `${label}.privateCopy`);
  if (!Array.isArray(serviced.sourceTopology) || serviced.sourceTopology.length !== 2) {
    fail(`${label}.sourceTopology must contain exactly the two serviced source tools`);
  }
  const expectedTopologies = [
    ['powershell-source', powershell],
    ['taskkill-source', taskkill],
  ];
  for (const [index, topology] of serviced.sourceTopology.entries()) {
    const topologyLabel = `${label}.sourceTopology[${index}]`;
    assertExactKeys(topology, [
      'aliasesShareOneStableIdentity',
      'bytes',
      'doubleHashReplay',
      'hardlinkCount',
      'id',
      'logicalPaths',
      'noReparseComponents',
      'sha256',
      'sourceSurfaceSha256',
      'stableIdentityReplayedAfterUse',
    ], topologyLabel);
    const [expectedId, expectedTool] = expectedTopologies[index];
    assertCanonicalValueEqual(topology, {
      aliasesShareOneStableIdentity: true,
      bytes: expectedTool.bytes,
      doubleHashReplay: true,
      hardlinkCount: expectedTool.hardlinkCount,
      id: expectedId,
      logicalPaths: expectedTool.logicalPaths,
      noReparseComponents: true,
      sha256: expectedTool.sha256,
      sourceSurfaceSha256: sha256Bytes(canonicalJsonBytes(
        expectedTool.logicalPaths.map((logicalPath) => [logicalPath, expectedTool.bytes, expectedTool.sha256]),
      )),
      stableIdentityReplayedAfterUse: true,
    }, topologyLabel);
  }
  assertExactKeys(serviced.termination, [
    'invocationPolicy',
    'ownedRootExitTimeoutMs',
    'privateToolLogicalPath',
    'requestedCount',
    'terminationToolTimeoutMs',
  ], `${label}.termination`);
  assertCanonicalValueEqual(serviced.termination, {
    invocationPolicy: policy.terminationInvocation,
    ownedRootExitTimeoutMs: policy.ownedRootExitTimeoutMs,
    privateToolLogicalPath: `<private-tools>/${taskkill.privateCopyFileName}`,
    requestedCount: 0,
    terminationToolTimeoutMs: policy.terminationToolTimeoutMs,
  }, `${label}.termination`);
  validatePresealCommandClosure(config, payload, declared, serviced, policy, 'root.provenance.presealReceipt.payload.commands');
}

function requirePresealEntry(entries, predicate, label) {
  if (!Array.isArray(entries)) fail(`${label} collection must be an array`);
  const matches = entries.filter(predicate);
  if (matches.length !== 1) fail(`${label} must have exactly one match; received ${matches.length}`);
  return matches[0];
}

function assertGitObjectId(value, label) {
  if (typeof value !== 'string' || !/^[0-9a-f]{40}$/u.test(value)) {
    fail(`${label} must be an exact lowercase Git object id`);
  }
}

function validateCx004T0TrackedInputs(provenance, label) {
  assertExactStringArray(
    provenance.t0TrackedInputTupleSchema,
    ['path', 'canonicalLfBytes', 'canonicalLfSha256', 'gitBlob'],
    `${label}.t0TrackedInputTupleSchema`,
  );
  if (
    !Array.isArray(provenance.t0TrackedInputs) ||
    provenance.t0TrackedInputs.length !== CX004_T0_TRACKED_INPUT_PATHS.length
  ) {
    fail(
      `${label}.t0TrackedInputs must contain the exact ordered ` +
      `${CX004_T0_TRACKED_INPUT_PATHS.length}-input T0 closure`,
    );
  }
  for (const [index, tuple] of provenance.t0TrackedInputs.entries()) {
    const tupleLabel = `${label}.t0TrackedInputs[${index}]`;
    if (!Array.isArray(tuple) || tuple.length !== 4) {
      fail(`${tupleLabel} must be [path,canonicalLfBytes,canonicalLfSha256,gitBlob]`);
    }
    const [relativePath, bytes, sha256, gitBlob] = tuple;
    if (relativePath !== CX004_T0_TRACKED_INPUT_PATHS[index]) {
      fail(
        `${label}.t0TrackedInputs must carry the exact ordered T0 paths ` +
        `${JSON.stringify(CX004_T0_TRACKED_INPUT_PATHS)}`,
      );
    }
    validateLogicalPath(relativePath, `${tupleLabel}[0]`);
    assertPositiveSafeInteger(bytes, `${tupleLabel}[1]`);
    assertSha256(sha256, `${tupleLabel}[2]`);
    assertGitObjectId(gitBlob, `${tupleLabel}[3]`);
  }
}

export function presealRepositoryChainAuthorities(provenance, label) {
  assertPlainObject(provenance, label);
  validateCx004T0TrackedInputs(provenance, label);
  if (!Array.isArray(provenance.repositoryChain) || provenance.repositoryChain.length === 0) {
    fail(`${label}.repositoryChain must be a non-empty array`);
  }
  let priorLanding;
  for (const [index, entry] of provenance.repositoryChain.entries()) {
    const entryLabel = `${label}.repositoryChain[${index}]`;
    assertExactKeys(entry, [
      'feature',
      'featureTree',
      'landing',
      'landingTree',
      'orderedLandingParents',
      'stage',
    ], entryLabel);
    for (const field of ['feature', 'featureTree', 'landing', 'landingTree']) {
      assertGitObjectId(entry[field], `${entryLabel}.${field}`);
    }
    if (
      !Array.isArray(entry.orderedLandingParents) ||
      entry.orderedLandingParents.length !== 2
    ) {
      fail(`${entryLabel}.orderedLandingParents must contain exactly two Git object ids`);
    }
    for (const [parentIndex, parent] of entry.orderedLandingParents.entries()) {
      assertGitObjectId(parent, `${entryLabel}.orderedLandingParents[${parentIndex}]`);
    }
    if (typeof entry.stage !== 'string' || entry.stage.length === 0) {
      fail(`${entryLabel}.stage must be a non-empty string`);
    }
    if (
      entry.orderedLandingParents[1] !== entry.feature ||
      entry.featureTree !== entry.landingTree
    ) {
      fail(`${entryLabel} does not describe an exact no-ff feature landing`);
    }
    if (priorLanding !== undefined && entry.orderedLandingParents[0] !== priorLanding) {
      fail(`${entryLabel} does not continue the ordered landing chain`);
    }
    priorLanding = entry.landing;
  }
  assertPlainObject(provenance.t0PreCodeBase, `${label}.t0PreCodeBase`);
  assertExactKeys(provenance.t0PreCodeBase, ['commit', 'tree'], `${label}.t0PreCodeBase`);
  assertGitObjectId(provenance.t0PreCodeBase.commit, `${label}.t0PreCodeBase.commit`);
  assertGitObjectId(provenance.t0PreCodeBase.tree, `${label}.t0PreCodeBase.tree`);
  const historicalT0 = requirePresealEntry(
    provenance.repositoryChain,
    (entry) => entry.stage === 'T0-native-toolchain-pin',
    `${label} historical T0 repository chain entry`,
  );
  if (
    historicalT0.landing !== provenance.t0PreCodeBase.commit ||
    historicalT0.landingTree !== provenance.t0PreCodeBase.tree
  ) {
    fail(`${label}.t0PreCodeBase does not equal the historical T0 landing identity`);
  }
  return {
    historicalT0,
    publishedBase: provenance.repositoryChain.at(-1),
  };
}

export function validatePresealRepositoryEvidence(
  repository,
  provenance,
  label = 'preseal repository evidence',
) {
  const authorities = presealRepositoryChainAuthorities(provenance, label);
  assertCanonicalValueEqual(repository, {
    gitObjectRewriteInputs: {
      commonDirectoryPathPolicy: true,
      graftsAbsent: true,
      replaceObjectsDisabledByArgvAndEnvironment: true,
      shallowAbsent: true,
    },
    historicalT0: {
      commit: provenance.t0PreCodeBase.commit,
      orderedParents: authorities.historicalT0.orderedLandingParents,
      t0TrackedInputs: provenance.t0TrackedInputs,
      trackedInputTupleSchema: provenance.t0TrackedInputTupleSchema,
      tree: provenance.t0PreCodeBase.tree,
    },
    publishedBase: {
      commit: authorities.publishedBase.landing,
      orderedParents: authorities.publishedBase.orderedLandingParents,
      tree: authorities.publishedBase.landingTree,
    },
  }, label);
  return repository;
}

function requirePresealSurface(config, surfaceId, label = `preseal surface ${surfaceId}`) {
  const surface = requirePresealEntry(config.surfaces, (entry) => entry.surfaceId === surfaceId, label);
  if (surface.expected === undefined) fail(`${label} must have an expected summary`);
  return surface.expected;
}

function validatePresealSurfaceFact(fact, expected, surfaceId, label) {
  assertExactKeys(fact, [
    'byteLength',
    'fileCount',
    'hardenedIdentityPolicy',
    'surfaceId',
    'surfaceSha256',
  ], label);
  assertCanonicalValueEqual(fact, {
    byteLength: expected.byteLength,
    fileCount: expected.fileCount,
    hardenedIdentityPolicy: surfaceId === 'pnpm-store-v10'
      ? 'regular-nonreparse-positive-observed-link-count-one-unnamed-stream-double-content-hash-stable-handle'
      : 'regular-nonreparse-single-link-one-unnamed-stream-double-content-hash-stable-handle',
    surfaceId,
    surfaceSha256: expected.surfaceSha256,
  }, label);
}

function validatePresealFilesystemAudits(config, payload, root, label) {
  const audits = payload.filesystemAudits;
  const auditKeys = [
    'gitExecPathAfter',
    'gitExecPathBefore',
    'gitPrivateAfter',
    'gitPrivateBefore',
    'gitSourceAfter',
    'gitSourceBefore',
    'gpgCopiedAfter',
    'gpgCopiedBefore',
    'gpgSource',
    'officialObjects',
    'privateSystemToolsAfter',
    'privateSystemToolsBefore',
    'pnpmDistributionAfter',
    'pnpmDistributionBefore',
    'pnpmStoreAfter',
    'pnpmStoreBefore',
  ];
  assertExactKeys(audits, auditKeys, label);
  const expectedByKey = new Map([
    ['gitSourceAfter', ['git-execution-closure', requirePresealSurface(config, 'git-execution-closure')]],
    ['gitSourceBefore', ['git-execution-closure', requirePresealSurface(config, 'git-execution-closure')]],
    ['gpgCopiedAfter', ['git-signature-verification-closure', requirePresealSurface(config, 'git-signature-verification-closure')]],
    ['gpgCopiedBefore', ['git-signature-verification-closure', requirePresealSurface(config, 'git-signature-verification-closure')]],
    ['gpgSource', ['git-signature-verification-closure', requirePresealSurface(config, 'git-signature-verification-closure')]],
    ['officialObjects', ['official-object-inputs', requirePresealSurface(config, 'official-object-inputs')]],
    ['pnpmDistributionAfter', ['pnpm-distribution', requirePresealSurface(config, 'pnpm-distribution')]],
    ['pnpmDistributionBefore', ['pnpm-distribution', requirePresealSurface(config, 'pnpm-distribution')]],
    ['pnpmStoreAfter', ['pnpm-store-v10', requirePresealSurface(config, 'pnpm-store-v10')]],
    ['pnpmStoreBefore', ['pnpm-store-v10', requirePresealSurface(config, 'pnpm-store-v10')]],
  ]);
  const emptySummary = {
    byteLength: 0,
    fileCount: 0,
    surfaceSha256: sha256Bytes(canonicalJsonBytes([])),
  };
  expectedByKey.set('gitExecPathAfter', ['git-exec-path-empty', emptySummary]);
  expectedByKey.set('gitExecPathBefore', ['git-exec-path-empty', emptySummary]);
  const privateGit = root.hostToolchain.git.privateCopy;
  expectedByKey.set('gitPrivateAfter', ['private-git-runtime', privateGit]);
  expectedByKey.set('gitPrivateBefore', ['private-git-runtime', privateGit]);
  const powershell = root.hostToolchain.authenticodeVerificationTool;
  const taskkill = root.hostToolchain.processTreeTerminationTool;
  const privateSystemTuples = [powershell, taskkill]
    .map((tool) => [`run-private/system-tools/${tool.privateCopyFileName}`, tool.bytes, tool.sha256])
    .sort((left, right) => ordinalCompare(left[0], right[0]));
  const privateSystem = summarizeFiles(privateSystemTuples);
  expectedByKey.set('privateSystemToolsAfter', ['private-system-tools', privateSystem]);
  expectedByKey.set('privateSystemToolsBefore', ['private-system-tools', privateSystem]);
  for (const key of auditKeys) {
    const [surfaceId, expected] = expectedByKey.get(key);
    validatePresealSurfaceFact(audits[key], expected, surfaceId, `${label}.${key}`);
  }
}

function validatePresealAuthenticode(payload, root, label) {
  const authenticode = payload.authenticode;
  assertExactKeys(authenticode, [
    'facts',
    'osBound',
    'verificationToolIdentityPolicy',
    'verificationToolSha256',
  ], label);
  if (!Array.isArray(authenticode.facts) || authenticode.facts.length !== 4) {
    fail(`${label}.facts must contain exactly four OS-bound facts`);
  }
  const factIds = authenticode.facts.map((fact) => fact.id);
  assertExactStringArray(factIds, [
    'node',
    'python',
    'powershell-private',
    'taskkill-private',
  ], `${label}.facts ids`);
  const facts = new Map();
  for (const [index, fact] of authenticode.facts.entries()) {
    const factLabel = `${label}.facts[${index}]`;
    const serviced = ['powershell-private', 'taskkill-private'].includes(fact.id);
    const keys = serviced
      ? ['certificateSubject', 'embeddedFileVersion', 'id', 'serial', 'status', 'thumbprint']
      : ['id', 'serial', 'status', 'subject', 'thumbprint'];
    assertExactKeys(fact, keys, factLabel);
    for (const key of keys) {
      assertUnicodeScalarString(fact[key], `${factLabel}.${key}`);
      if (fact[key].length === 0) fail(`${factLabel}.${key} must be non-empty`);
    }
    facts.set(fact.id, fact);
  }
  const node = requirePresealEntry(root.officialInputs, (entry) => entry.id === 'node-v22.13.0-win-x64', 'Node official input');
  const python = requirePresealEntry(root.officialInputs, (entry) => entry.id === 'python-3.13.14-embed-amd64', 'Python official input');
  const powershell = root.hostToolchain.authenticodeVerificationTool;
  const taskkill = root.hostToolchain.processTreeTerminationTool;
  for (const [id, expected] of [
    ['node', node.nodeExe.authenticode],
    ['python', python.pythonExe.authenticode],
  ]) {
    const fact = facts.get(id);
    for (const key of ['serial', 'status', 'subject', 'thumbprint']) {
      if (fact[key] !== expected[key]) fail(`${label}.facts ${id}.${key} does not equal its official input`);
    }
  }
  for (const [id, expected] of [
    ['powershell-private', powershell],
    ['taskkill-private', taskkill],
  ]) {
    const fact = facts.get(id);
    if (
      fact.certificateSubject !== expected.authenticode.subject ||
      fact.embeddedFileVersion !== expected.embeddedFileVersion ||
      fact.serial !== expected.authenticode.serial ||
      fact.status !== expected.authenticode.status ||
      fact.thumbprint !== expected.authenticode.thumbprint
    ) {
      fail(`${label}.facts ${id} does not equal its serviced system-tool identity`);
    }
  }
  if (
    authenticode.osBound !== true ||
    authenticode.verificationToolIdentityPolicy !== root.hostToolchain.servicedSystemToolPolicy.bootstrapExecution ||
    authenticode.verificationToolSha256 !== powershell.sha256
  ) {
    fail(`${label} does not carry the sealed OS-bound verification-tool identity`);
  }
}

function validatePresealSignatures(payload, declared, root, logicalFiles, label) {
  const signatures = payload.signatures;
  assertExactKeys(signatures, ['llvm', 'node', 'pnpmRegistry', 'python'], label);
  const node = requirePresealEntry(root.officialInputs, (entry) => entry.id === 'node-v22.13.0-win-x64', 'Node official input');
  const llvm = requirePresealEntry(root.officialInputs, (entry) => entry.id === 'llvm-19.1.7-windows-msvc', 'LLVM official input');
  const python = requirePresealEntry(root.officialInputs, (entry) => entry.id === 'python-3.13.14-embed-amd64', 'Python official input');
  const pnpm = requirePresealEntry(root.officialInputs, (entry) => entry.id === 'pnpm-10.33.0', 'pnpm official input');
  for (const [signatureKey, input] of [
    ['node', node],
    ['llvm', llvm],
    ['python', python],
    ['pnpmRegistry', pnpm],
  ]) {
    if (!Array.isArray(signatures[signatureKey].assets)) {
      fail(`${label}.${signatureKey}.assets must be an array`);
    }
    assertCanonicalValueEqual(
      signatures[signatureKey].assets,
      projectSignatureAssets(input),
      `${label}.${signatureKey}.assets`,
    );
  }
  assertExactKeys(signatures.node, [
    'assets',
    'clearSignedAndDetachedPayloadEquality',
    'clearSignedDigestAlgorithmId',
    'detachedDigestAlgorithmId',
    'fingerprint',
    'historicalKeyring',
    'result',
    'signatureDate',
  ], `${label}.node`);
  if (
    signatures.node.result !== 'valid' ||
    signatures.node.clearSignedDigestAlgorithmId !== 8 ||
    signatures.node.detachedDigestAlgorithmId !== 8 ||
    signatures.node.fingerprint !== node.signatureVerification.signerFingerprint ||
    signatures.node.signatureDate !== node.signatureVerification.signatureTimestamp ||
    signatures.node.clearSignedAndDetachedPayloadEquality !== node.signatureVerification.clearSignedAndDetachedPayloadEquality
  ) fail(`${label}.node does not equal the declared Node signature identity`);
  const historicalKeyring = signatures.node.historicalKeyring;
  assertExactKeys(historicalKeyring, ['bytes', 'logicalPath', 'sha256'], `${label}.node.historicalKeyring`);
  validateLogicalPath(historicalKeyring.logicalPath, `${label}.node.historicalKeyring.logicalPath`);
  const historicalKeyPrefix = `cache/objects/sha256/${node.signatureVerification.historicalKeyring.sha256}/`;
  if (
    historicalKeyring.bytes !== node.signatureVerification.historicalKeyring.bytes ||
    historicalKeyring.sha256 !== node.signatureVerification.historicalKeyring.sha256 ||
    !historicalKeyring.logicalPath.startsWith(historicalKeyPrefix) ||
    historicalKeyring.logicalPath.slice(historicalKeyPrefix.length).includes('/') ||
    historicalKeyring.logicalPath.length === historicalKeyPrefix.length
  ) {
    fail(`${label}.node.historicalKeyring does not equal its unique official-object authority`);
  }
  assertExactKeys(signatures.llvm, [
    'assets',
    'digestAlgorithmId',
    'explicitWeakDigestAllowance',
    'fingerprint',
    'result',
    'signatureDate',
  ], `${label}.llvm`);
  if (
    signatures.llvm.result !== 'valid' ||
    llvm.signatureVerification.result !== 'valid-with-explicit-weak-digest-allowance' ||
    signatures.llvm.digestAlgorithmId !== 2 ||
    signatures.llvm.explicitWeakDigestAllowance !== '--allow-weak-digest-algos' ||
    signatures.llvm.fingerprint !== llvm.signatureVerification.signerFingerprint ||
    signatures.llvm.signatureDate !== llvm.signatureVerification.signatureTimestamp
  ) fail(`${label}.llvm does not equal the explicit SHA-1 allowance identity`);
  assertExactKeys(signatures.python, [
    'assets',
    'digestAlgorithmId',
    'fingerprint',
    'releaseKey',
    'result',
    'signatureDate',
  ], `${label}.python`);
  if (
    signatures.python.result !== 'valid' ||
    signatures.python.digestAlgorithmId !== 8 ||
    signatures.python.fingerprint !== python.signatureVerification.signerFingerprint ||
    signatures.python.signatureDate !== python.signatureVerification.signatureTimestamp
  ) fail(`${label}.python does not equal the declared Python signature identity`);
  assertCanonicalValueEqual(signatures.python.releaseKey, {
    bytes: python.signatureVerification.releaseKey.bytes,
    logicalPath: python.signatureVerification.releaseKey.logicalPath,
    sha256: python.signatureVerification.releaseKey.sha256,
  }, `${label}.python.releaseKey`);
  assertExactKeys(signatures.pnpmRegistry, [
    'algorithm',
    'assets',
    'derivedMessageSha256',
    'keyId',
    'result',
  ], `${label}.pnpmRegistry`);
  if (
    signatures.pnpmRegistry.result !== 'valid' ||
    signatures.pnpmRegistry.algorithm !== pnpm.signatureVerification.algorithm ||
    signatures.pnpmRegistry.keyId !== pnpm.signatureVerification.keyId ||
    signatures.pnpmRegistry.derivedMessageSha256 !== sha256Bytes(Buffer.from(pnpm.signatureVerification.message, 'utf8'))
  ) fail(`${label}.pnpmRegistry does not equal the declared pnpm registry signature identity`);
  assertExactStringArray(declared.signatureFamilies, PRESEAL_SIGNATURE_FAMILIES, `${label} derived signature families`);
  if (logicalFiles !== undefined) {
    for (const [input, bindingLabel] of [
      [historicalKeyring, `${label}.node.historicalKeyring`],
      [python.signatureVerification.releaseKey, `${label}.python.releaseKey`],
    ]) {
      assertDigestBoundExactlyOnce(logicalFiles, input.sha256, bindingLabel);
      assertBoundFile(logicalFiles, input.logicalPath, input.bytes, input.sha256, bindingLabel);
    }
  }
}

function validatePresealRuntimeAndRepository(payload, root, label) {
  const node = requirePresealEntry(root.officialInputs, (entry) => entry.id === 'node-v22.13.0-win-x64', 'Node official input');
  assertCanonicalValueEqual(payload.runtime, {
    abi: node.distributionIdentity.abi,
    architecture: node.distributionIdentity.architecture,
    bytes: node.nodeExe.bytes,
    execArgvPolicy: 'pinned-inline-launcher-v1',
    launchArgvSha256: payload.servicedSystemTools.loadedModuleExecution.launchArgvSha256,
    nApi: node.distributionIdentity.nodeApi,
    nodeOptionsEmpty: true,
    nodePathEmpty: true,
    platform: 'win32',
    sha256: node.nodeExe.sha256,
    version: node.distributionIdentity.version,
  }, `${label}.runtime`);
  validatePresealRepositoryEvidence(
    payload.repository,
    root.provenance,
    `${label}.repository`,
  );
}

function validatePresealPackageMaterialization(payload, declared, config, root, label) {
  const materialization = payload.packageMaterialization;
  assertExactKeys(materialization, [
    'lock',
    'pnpm',
    'store',
    'workspaceManifests',
    'workspaceManifestTupleSchema',
    'workspaceYaml',
  ], label);
  assertCanonicalValueEqual(materialization.workspaceManifestTupleSchema, root.packageResolution.workspaceManifestTupleSchema, `${label}.workspaceManifestTupleSchema`);
  assertCanonicalValueEqual(materialization.workspaceManifests, root.packageResolution.workspaceManifests, `${label}.workspaceManifests`);
  assertCanonicalValueEqual(materialization.workspaceYaml, {
    bytes: root.packageResolution.workspaceYaml.canonicalLfBytes,
    path: root.packageResolution.workspaceYaml.path,
    sha256: root.packageResolution.workspaceYaml.canonicalLfSha256,
  }, `${label}.workspaceYaml`);
  assertCanonicalValueEqual(materialization.lock, {
    bytes: root.packageResolution.lock.t1CanonicalLf.bytes,
    lineFeeds: root.packageResolution.lock.t1CanonicalLf.lineFeeds,
    sha256: root.packageResolution.lock.t1CanonicalLf.sha256,
    terminalLf: root.packageResolution.lock.t1CanonicalLf.terminalLf,
    unchangedAfterInstall: true,
  }, `${label}.lock`);
  assertExactKeys(materialization.pnpm, [
    'downloaded',
    'exitCode',
    'resolved',
    'reused',
    'version',
    'virtualStoreDirectories',
  ], `${label}.pnpm`);
  const observation = requirePresealEntry(
    root.observations,
    (entry) => entry.id === 'pnpm-offline-materialization',
    'pnpm offline materialization observation',
  ).facts;
  assertCanonicalValueEqual(materialization.pnpm, {
    downloaded: declared.offlineDownloaded,
    exitCode: 0,
    resolved: root.packageResolution.store.indexFiles,
    reused: declared.offlineReused,
    version: root.packageResolution.pnpmDistribution.version,
    virtualStoreDirectories: observation.virtualStoreDirectories,
  }, `${label}.pnpm`);
  if (
    declared.offlineDownloaded !== observation.downloads ||
    declared.offlineReused !== observation.reusedPackages ||
    declared.offlineReused !== root.packageResolution.store.indexFiles
  ) fail(`${label}.pnpm does not equal the declared provider-free offline observation`);
  const storeSurface = requirePresealSurface(config, 'pnpm-store-v10');
  assertCanonicalValueEqual(materialization.store, {
    beforeAfterExactTupleEquality: true,
    files: root.packageResolution.store.files,
    sha256: storeSurface.surfaceSha256,
    totalBytes: root.packageResolution.store.totalBytes,
  }, `${label}.store`);
}

function validatePresealRuntimeClosures(payload, config, root, label) {
  const git = root.hostToolchain.git;
  const gitClosure = payload.gitRuntimeClosure;
  assertExactKeys(gitClosure, [
    'builtins',
    'commandCount',
    'executionPolicy',
    'gitExecPathEmptyAfter',
    'gitExecPathEmptyBefore',
    'noChildEvents',
    'privateCopySurfaceSha256',
    'sourceSurfaceSha256',
    'systemImports',
    'traceFacts',
  ], `${label}.gitRuntimeClosure`);
  if (
    !Array.isArray(gitClosure.traceFacts) ||
    gitClosure.traceFacts.length !== gitClosure.commandCount
  ) {
    fail(`${label}.gitRuntimeClosure trace count mismatch`);
  }
  if (
    gitClosure.commandCount !== CX004_PRESEAL_GIT_TRACE_COUNT ||
    gitClosure.traceFacts.length !== CX004_PRESEAL_GIT_TRACE_COUNT
  ) {
    fail(
      `${label}.gitRuntimeClosure must contain the exact ` +
      `${CX004_PRESEAL_GIT_TRACE_COUNT}-command Git trace closure`,
    );
  }
  const expectedGitCommands = payload.commands.filter((command) =>
    command.executionAuthority.kind === 'native-executable' &&
    command.executionAuthority.sha256 === git.sourceExecutable[2]);
  const expectedGitBuiltins = expectedGitCommands.map((command) => command.argv[5]);
  if (
    expectedGitCommands.length !== CX004_PRESEAL_GIT_TRACE_COUNT ||
    gitClosure.commandCount !== expectedGitCommands.length
  ) {
    fail(`${label}.gitRuntimeClosure command count does not equal the exact Git operation closure`);
  }
  assertExactStringArray(
    gitClosure.traceFacts.map((fact) => fact?.builtin),
    expectedGitBuiltins,
    `${label}.gitRuntimeClosure builtin sequence`,
  );
  const observedBuiltins = new Set();
  for (const [index, fact] of gitClosure.traceFacts.entries()) {
    assertExactKeys(fact, ['argvSha256', 'builtin', 'childEventCount', 'eventCount'], `${label}.gitRuntimeClosure.traceFacts[${index}]`);
    assertSha256(fact.argvSha256, `${label}.gitRuntimeClosure.traceFacts[${index}].argvSha256`);
    assertPositiveSafeInteger(fact.eventCount, `${label}.gitRuntimeClosure.traceFacts[${index}].eventCount`);
    if (!git.builtins.includes(fact.builtin) || fact.childEventCount !== 0 || fact.eventCount < 5) {
      fail(`${label}.gitRuntimeClosure.traceFacts[${index}] escaped the admitted builtin/descendant policy`);
    }
    const expectedArgvSha256 = sha256Bytes(canonicalJsonBytes(expectedGitCommands[index].argv));
    if (fact.argvSha256 !== expectedArgvSha256) {
      fail(`${label}.gitRuntimeClosure.traceFacts[${index}].argvSha256 does not bind its exact logical command argv`);
    }
    observedBuiltins.add(fact.builtin);
  }
  assertExactStringArray([...observedBuiltins].sort(ordinalCompare), [...git.builtins].sort(ordinalCompare), `${label}.gitRuntimeClosure observed builtins`);
  assertCanonicalValueEqual({
    builtins: gitClosure.builtins,
    executionPolicy: gitClosure.executionPolicy,
    gitExecPathEmptyAfter: gitClosure.gitExecPathEmptyAfter,
    gitExecPathEmptyBefore: gitClosure.gitExecPathEmptyBefore,
    noChildEvents: gitClosure.noChildEvents,
    privateCopySurfaceSha256: gitClosure.privateCopySurfaceSha256,
    sourceSurfaceSha256: gitClosure.sourceSurfaceSha256,
    systemImports: gitClosure.systemImports,
  }, {
    builtins: git.builtins,
    executionPolicy: git.executionPolicy,
    gitExecPathEmptyAfter: true,
    gitExecPathEmptyBefore: true,
    noChildEvents: true,
    privateCopySurfaceSha256: git.privateCopy.surfaceSha256,
    sourceSurfaceSha256: requirePresealSurface(config, 'git-execution-closure').surfaceSha256,
    systemImports: git.systemImports,
  }, `${label}.gitRuntimeClosure policy`);

  const gpg = payload.gpgRuntimeClosure;
  const authority = root.hostToolchain.signatureVerificationClosure;
  assertExactKeys(gpg, [
    'authoritySha256',
    'delayImports',
    'fileCount',
    'localClosureReachableFrom',
    'noUnexpectedDescendantsAfterUse',
    'pathPolicy',
    'systemImports',
  ], `${label}.gpgRuntimeClosure`);
  const authorityTuples = [...authority.files].sort((left, right) => ordinalCompare(left[0], right[0]));
  assertCanonicalValueEqual(gpg, {
    authoritySha256: sha256Bytes(canonicalJsonBytes(authorityTuples)),
    delayImports: 'absent',
    fileCount: authorityTuples.length,
    localClosureReachableFrom: ['gpg.exe', 'gpgv.exe'],
    noUnexpectedDescendantsAfterUse: true,
    pathPolicy: 'copied-fresh-runtime; PATH is copied closure plus System32 only',
    systemImports: [...authority.systemImports].sort(ordinalCompare),
  }, `${label}.gpgRuntimeClosure`);
}

function validatePresealPathPolicy(payload, label) {
  const policy = payload.pathPolicy;
  assertExactKeys(policy, ['gitRewriteInputs', 'gpgCopy', 'postcreate', 'prestage', 'prewrite'], label);
  const fact = (id, role, exists) => ({
    exists,
    fixedVolume: true,
    id,
    noReparseComponents: true,
    role,
    unnamedStreamOnly: true,
  });
  const base = [
    fact('cache-root', 'input', true),
    fact('git-root', 'input', true),
    fact('receipt-directory', 'input', true),
    fact('repo-root', 'input', true),
    fact('system-root', 'input', true),
    fact('node-executable', 'input', true),
  ];
  const outputs = (allCreated) => [
    fact('run-root', 'output', true),
    fact('temp-root', 'output', true),
    fact('workspace-root', 'output', allCreated),
    fact('gpg-runtime-root', 'output', allCreated),
    fact('private-git-root', 'output', allCreated),
    fact('git-exec-path', 'output', allCreated),
  ];
  const receiptOutputs = [
    fact('payload-final', 'output', false),
    fact('payload-temporary', 'output', false),
    fact('root-final', 'output', false),
    fact('root-temporary', 'output', false),
  ];
  const created = [...base, ...outputs(true), ...receiptOutputs];
  const expected = {
    gitRewriteInputs: [
      ...base,
      ...outputs(true),
      fact('git-common-directory', 'input', true),
      fact('git-grafts-file', 'input', false),
      fact('git-shallow-file', 'input', false),
      ...receiptOutputs,
    ],
    gpgCopy: created,
    postcreate: created,
    prestage: [...base, ...outputs(false), ...receiptOutputs],
    prewrite: created,
  };
  for (const phase of ['gitRewriteInputs', 'gpgCopy', 'postcreate', 'prestage', 'prewrite']) {
    assertCanonicalValueEqual(policy[phase], expected[phase], `${label}.${phase}`);
  }
}

function validatePresealExecutableFacts(payload, config, root, logicalFiles, label) {
  if (!Array.isArray(payload.executableFacts)) fail(`${label} must be an array`);
  const expectedIds = [
    'node',
    'powershell-source',
    'taskkill-source',
    'powershell-private',
    'taskkill-private',
    'git-private',
    'pnpm-cjs',
    'pinned-gpg',
    'pinned-gpgv',
    'authenticode-probe',
    'path-policy-probe',
    'filesystem-audit-worker',
  ];
  assertExactStringArray(payload.executableFacts.map((fact) => fact.id), expectedIds, `${label} ids`);
  const node = requirePresealEntry(root.officialInputs, (entry) => entry.id === 'node-v22.13.0-win-x64', 'Node official input');
  const pnpm = requirePresealEntry(root.officialInputs, (entry) => entry.id === 'pnpm-10.33.0', 'pnpm official input');
  const powershell = root.hostToolchain.authenticodeVerificationTool;
  const taskkill = root.hostToolchain.processTreeTerminationTool;
  const git = root.hostToolchain.git;
  const gpg = requirePresealEntry(root.hostToolchain.signatureVerificationClosure.files, (tuple) => tuple[0].endsWith('/gpg.exe'), 'GPG executable tuple');
  const gpgv = requirePresealEntry(root.hostToolchain.signatureVerificationClosure.files, (tuple) => tuple[0].endsWith('/gpgv.exe'), 'GPGV executable tuple');
  const entryBindings = new Map(payload.servicedSystemTools.entryBindings.map((tuple) => [tuple[0], tuple]));
  const workerBindings = new Map(payload.servicedSystemTools.workerBindings.map((tuple) => [tuple[0], tuple]));
  const expected = new Map([
    ['node', [
      node.nodeExe.bytes,
      node.nodeExe.sha256,
      `${presealCacheSurfaceRoot(config, 'node-distribution')}/node.exe`,
    ]],
    ['powershell-source', [powershell.bytes, powershell.sha256, powershell.logicalPaths[0]]],
    ['taskkill-source', [taskkill.bytes, taskkill.sha256, taskkill.logicalPaths[0]]],
    ['powershell-private', [powershell.bytes, powershell.sha256, `<private-tools>/${powershell.privateCopyFileName}`]],
    ['taskkill-private', [taskkill.bytes, taskkill.sha256, `<private-tools>/${taskkill.privateCopyFileName}`]],
    ['git-private', [git.sourceExecutable[1], git.sourceExecutable[2], '<private-git>/git.exe']],
    ['pnpm-cjs', [
      pnpm.distribution.binPnpmCjsBytes,
      pnpm.distribution.binPnpmCjsSha256,
      `${presealCacheSurfaceRoot(config, 'pnpm-distribution')}/bin/pnpm.cjs`,
    ]],
    ['pinned-gpg', [gpg[1], gpg[2], '<gpg-runtime>/gpg.exe']],
    ['pinned-gpgv', [gpgv[1], gpgv[2], '<gpg-runtime>/gpgv.exe']],
    ['authenticode-probe', [entryBindings.get('authenticode-probe')[1], entryBindings.get('authenticode-probe')[2], '<repo>/packages/windows-containment/toolchain/preseal/authenticode-probe.ps1']],
    ['path-policy-probe', [entryBindings.get('path-policy-probe')[1], entryBindings.get('path-policy-probe')[2], '<repo>/packages/windows-containment/toolchain/preseal/path-policy-probe.ps1']],
    ['filesystem-audit-worker', [workerBindings.get('audit-worker')[1], workerBindings.get('audit-worker')[2], '<repo>/packages/windows-containment/toolchain/native-build-input-filesystem-audit.ps1']],
  ]);
  for (const [index, fact] of payload.executableFacts.entries()) {
    const factLabel = `${label}[${index}]`;
    assertExactKeys(fact, ['bytes', 'id', 'logicalPath', 'sha256'], factLabel);
    assertPositiveSafeInteger(fact.bytes, `${factLabel}.bytes`);
    assertSha256(fact.sha256, `${factLabel}.sha256`);
    assertUnicodeScalarString(fact.logicalPath, `${factLabel}.logicalPath`);
    const wanted = expected.get(fact.id);
    if (fact.bytes !== wanted[0] || fact.sha256 !== wanted[1] || (wanted[2] !== undefined && fact.logicalPath !== wanted[2])) {
      fail(`${factLabel} does not equal its sealed execution authority`);
    }
  }
  if (logicalFiles !== undefined) {
    for (const [id, logicalPath] of [
      ['authenticode-probe', 'manifest-authority/toolchain/preseal/authenticode-probe.ps1'],
      ['path-policy-probe', 'manifest-authority/toolchain/preseal/path-policy-probe.ps1'],
      ['filesystem-audit-worker', 'manifest-authority/toolchain/native-build-input-filesystem-audit.ps1'],
    ]) {
      const fact = payload.executableFacts.find((entry) => entry.id === id);
      assertBoundFile(logicalFiles, logicalPath, fact.bytes, fact.sha256, `${label} ${id}`);
    }
  }
}

export function validatePresealV2PayloadSemantics(config, envelope, options = {}) {
  assertPlainObject(envelope, 'preseal v2 envelope result');
  const { declared, payload } = envelope;
  const root = config.root;
  const label = 'root.provenance.presealReceipt.payload';
  validatePresealServicedSystemTools(config, payload, declared, root, `${label}.servicedSystemTools`);
  validatePresealRuntimeAndRepository(payload, root, label);
  validatePresealPackageMaterialization(payload, declared, config, root, `${label}.packageMaterialization`);
  assertCanonicalValueEqual(payload.networkPolicy, {
    credentialConfiguration: 'absent-from-closed-child-environments',
    installMode: ['offline', 'frozen-lockfile', 'ignore-scripts', 'global-virtual-store-disabled'],
    providerAccess: false,
    proxyAndRegistry: 'loopback-blackhole-127.0.0.1:9',
  }, `${label}.networkPolicy`);
  validatePresealFilesystemAudits(config, payload, root, `${label}.filesystemAudits`);
  validatePresealRuntimeClosures(payload, config, root, label);
  validatePresealPathPolicy(payload, `${label}.pathPolicy`);
  validatePresealAuthenticode(payload, root, `${label}.authenticode`);
  validatePresealSignatures(payload, declared, root, options.logicalFiles, `${label}.signatures`);
  validatePresealExecutableFacts(payload, config, root, options.logicalFiles, `${label}.executableFacts`);
  if (options.logicalFiles !== undefined) {
    const bindings = new Map(payload.servicedSystemTools.workerBindings.map((tuple) => [tuple[0], tuple]));
    for (const [id, logicalPath] of [
      ['bootstrap-wrapper', 'manifest-authority/toolchain/preseal/system-tool-authority-bootstrap.ps1'],
      ['audit-core', 'manifest-authority/toolchain/preseal/filesystem-audit-core.psm1'],
      ['audit-worker', 'manifest-authority/toolchain/native-build-input-filesystem-audit.ps1'],
    ]) {
      const tuple = bindings.get(id);
      assertBoundFile(options.logicalFiles, logicalPath, tuple[1], tuple[2], `${label}.servicedSystemTools.workerBindings ${id}`);
    }
    const loadedModules = new Map(
      payload.servicedSystemTools.loadedModuleBindings.map((tuple) => [tuple[0], tuple]),
    );
    for (const [id, logicalPath] of PRESEAL_LOADED_MODULE_BINDINGS) {
      const tuple = loadedModules.get(id);
      assertBoundFile(
        options.logicalFiles,
        logicalPath,
        tuple[1],
        tuple[2],
        `${label}.servicedSystemTools.loadedModuleBindings ${id}`,
      );
    }
    const launcherBinding = payload.servicedSystemTools.loadedModuleExecution.launcherBinding;
    assertBoundFile(
      options.logicalFiles,
      PRESEAL_INLINE_LAUNCHER_LOGICAL_PATH,
      launcherBinding[1],
      launcherBinding[2],
      `${label}.servicedSystemTools.loadedModuleExecution.launcherBinding`,
    );
    const loaderBinding = payload.servicedSystemTools.loadedModuleExecution.loaderBinding;
    assertBoundFile(
      options.logicalFiles,
      PRESEAL_IN_MEMORY_LOADER_LOGICAL_PATH,
      loaderBinding[1],
      loaderBinding[2],
      `${label}.servicedSystemTools.loadedModuleExecution.loaderBinding`,
    );
    assertDigestBoundExactlyOnce(
      options.logicalFiles,
      PRESEAL_IN_MEMORY_LOADER_SHA256,
      `${label}.servicedSystemTools.loadedModuleExecution.loaderBinding`,
    );
  }
  return envelope;
}

async function validatePresealReceiptBindingV2(config, logicalFiles) {
  const declared = config.root.provenance.presealReceipt;
  const label = 'root.provenance.presealReceipt';
  const rootBound = assertBoundFile(
    logicalFiles,
    declared.rootReceipt.logicalPath,
    declared.rootReceipt.bytes,
    declared.rootReceipt.sha256,
    `${label}.rootReceipt`,
  );
  const payloadBound = assertBoundFile(
    logicalFiles,
    declared.payload.logicalPath,
    declared.payload.bytes,
    declared.payload.sha256,
    `${label}.payload`,
  );
  const [rootBytes, payloadBytes] = await Promise.all([
    readStableBoundedFile(rootBound.filePath, `${label}.rootReceipt`, MAX_PRESEAL_ROOT_BYTES),
    readStableBoundedFile(payloadBound.filePath, `${label}.payload`, MAX_PRESEAL_PAYLOAD_BYTES),
  ]);
  if (
    rootBytes.length !== rootBound.byteLength || sha256Bytes(rootBytes) !== rootBound.sha256 ||
    payloadBytes.length !== payloadBound.byteLength || sha256Bytes(payloadBytes) !== payloadBound.sha256
  ) {
    fail(`${label} root/payload changed after enumeration`);
  }
  const envelope = validatePresealV2Envelope(config, rootBytes, payloadBytes);
  validatePresealV2PayloadSemantics(config, envelope, { logicalFiles });
}

async function validateRootBindings(config, surfaces, logicalFiles) {
  assertPresealPassedForGeneration(config, 'root binding validation');
  const root = config.root;
  if (root.hostToolchain.authenticodeVerificationTool !== undefined) {
    const tool = root.hostToolchain.authenticodeVerificationTool;
    for (const [index, logicalPath] of tool.logicalPaths.entries()) {
      assertBoundFile(
        logicalFiles,
        logicalPath,
        tool.bytes,
        tool.sha256,
        `root.hostToolchain.authenticodeVerificationTool.logicalPaths[${index}]`,
      );
    }
  }
  if (root.hostToolchain.processTreeTerminationTool !== undefined) {
    const tool = root.hostToolchain.processTreeTerminationTool;
    for (const [index, logicalPath] of tool.logicalPaths.entries()) {
      assertBoundFile(
        logicalFiles,
        logicalPath,
        tool.bytes,
        tool.sha256,
        `root.hostToolchain.processTreeTerminationTool.logicalPaths[${index}]`,
      );
    }
  }
  for (const [index, tool] of (root.hostToolchain.tools ?? []).entries()) {
    if (!Array.isArray(tool) || tool.length !== 5) {
      fail(`root.hostToolchain.tools[${index}] must be [id,path,bytes,version,sha256]`);
    }
    assertBoundFile(logicalFiles, tool[1], tool[2], tool[4], `root.hostToolchain.tools[${index}]`);
  }
  const git = root.hostToolchain.git;
  if (git !== undefined) {
    assertBoundFile(
      logicalFiles,
      git.sourceExecutable[0],
      git.sourceExecutable[1],
      git.sourceExecutable[2],
      'root.hostToolchain.git.sourceExecutable',
    );
    for (const [groupIndex, group] of git.sourceAliasGroups.entries()) {
      for (const [pathIndex, logicalPath] of group.logicalPaths.entries()) {
        assertBoundFile(
          logicalFiles,
          logicalPath,
          group.bytes,
          group.sha256,
          `root.hostToolchain.git.sourceAliasGroups[${groupIndex}].logicalPaths[${pathIndex}]`,
        );
      }
    }
    const gitSurface = surfaces.find((surface) => surface.surfaceId === 'git-execution-closure');
    if (gitSurface === undefined) {
      fail('root.hostToolchain.git has no git-execution-closure surface');
    }
    assertCanonicalValueEqual({
      byteLength: gitSurface.byteLength,
      fileCount: gitSurface.fileCount,
      surfaceSha256: gitSurface.surfaceSha256,
    }, {
      byteLength: 8949162,
      fileCount: 11,
      surfaceSha256: 'c2b3b9c75250b54c42d89ac7a4df0b765b2dbe4b645447bf242e3f9ec63ff939',
    }, 'root.hostToolchain.git source surface');
  }
  for (const [index, file] of (root.hostToolchain.signatureVerificationClosure?.files ?? []).entries()) {
    if (!Array.isArray(file) || file.length !== 3) {
      fail(`root.hostToolchain.signatureVerificationClosure.files[${index}] must be [path,bytes,sha256]`);
    }
    assertBoundFile(
      logicalFiles,
      file[0],
      file[1],
      file[2],
      `root.hostToolchain.signatureVerificationClosure.files[${index}]`,
    );
  }
  for (const [index, state] of (root.hostToolchain.selectedVisualStudio?.stateFiles ?? []).entries()) {
    assertBoundFile(
      logicalFiles,
      `vs-state/${root.hostToolchain.selectedVisualStudio.instanceId}/${state[0]}`,
      state[1],
      state[2],
      `root.hostToolchain.selectedVisualStudio.stateFiles[${index}]`,
    );
  }
  for (const [inputIndex, input] of root.officialInputs.entries()) {
    for (const [assetIndex, asset] of input.assets.entries()) {
      assertBoundFile(
        logicalFiles,
        asset.cacheKey,
        asset.bytes,
        asset.sha256,
        `root.officialInputs[${inputIndex}].assets[${assetIndex}]`,
      );
    }
    if (input.nodeExe !== undefined) {
      assertBoundFile(
        logicalFiles,
        'node-distribution/node.exe',
        input.nodeExe.bytes,
        input.nodeExe.sha256,
        `root.officialInputs[${inputIndex}].nodeExe`,
      );
    }
    if (input.pythonExe !== undefined) {
      assertBoundFile(
        logicalFiles,
        'python-embed/python.exe',
        input.pythonExe.bytes,
        input.pythonExe.sha256,
        `root.officialInputs[${inputIndex}].pythonExe`,
      );
    }
    if (input.distribution?.binPnpmCjsSha256 !== undefined) {
      assertBoundFile(
        logicalFiles,
        'pnpm-distribution/bin/pnpm.cjs',
        input.distribution.binPnpmCjsBytes,
        input.distribution.binPnpmCjsSha256,
        `root.officialInputs[${inputIndex}].distribution.binPnpmCjs`,
      );
    }
    for (const [runtimeIndex, runtime] of (input.selectedRuntime?.runtimeHashes ?? []).entries()) {
      assertDigestBoundExactlyOnce(
        logicalFiles,
        runtime[1],
        `root.officialInputs[${inputIndex}].selectedRuntime.runtimeHashes[${runtimeIndex}]`,
      );
    }
  }
  for (const [name, sha256] of Object.entries(root.hostToolchain.verificationArtifacts ?? {})) {
    assertDigestBoundExactlyOnce(logicalFiles, sha256, `root.hostToolchain.verificationArtifacts.${name}`);
  }
  for (const [index, tuple] of (root.packageResolution.workspaceManifests ?? []).entries()) {
    await assertCanonicalLfBound(
      logicalFiles,
      `repo/${tuple[0]}`,
      tuple[1],
      tuple[2],
      `root.packageResolution.workspaceManifests[${index}]`,
    );
  }
  if (root.packageResolution.workspaceYaml !== undefined) {
    await assertCanonicalLfBound(
      logicalFiles,
      `repo/${root.packageResolution.workspaceYaml.path}`,
      root.packageResolution.workspaceYaml.canonicalLfBytes,
      root.packageResolution.workspaceYaml.canonicalLfSha256,
      'root.packageResolution.workspaceYaml',
    );
  }
  if (root.packageResolution.lock?.t1CanonicalLf !== undefined) {
    await assertCanonicalLfBound(
      logicalFiles,
      'repo/pnpm-lock.yaml',
      root.packageResolution.lock.t1CanonicalLf.bytes,
      root.packageResolution.lock.t1CanonicalLf.sha256,
      'root.packageResolution.lock.t1CanonicalLf',
    );
  }
  for (const [index, tuple] of (root.packageResolution.selectedPackages ?? []).entries()) {
    await validateStorePackageTuple(tuple, logicalFiles, `root.packageResolution.selectedPackages[${index}]`);
  }
  if (root.packageResolution.store !== undefined) {
    const storeSurface = surfaces.find((surface) => surface.surfaceId === 'pnpm-store-v10');
    if (
      storeSurface === undefined ||
      storeSurface.fileCount !== root.packageResolution.store.files ||
      storeSurface.byteLength !== root.packageResolution.store.totalBytes
    ) {
      fail('root.packageResolution.store counts do not equal the pnpm-store-v10 surface');
    }
  }
  for (const [index, source] of (root.runnerIdentity.sourceSeal?.sourceFiles ?? []).entries()) {
    assertBoundFile(
      logicalFiles,
      `repo/${source[0]}`,
      source[1],
      source[2],
      `root.runnerIdentity.sourceSeal.sourceFiles[${index}]`,
    );
  }
  if (root.runnerIdentity.sourceSeal !== undefined) {
    assertBoundFile(
      logicalFiles,
      `repo/${root.runnerIdentity.sourceSeal.manifestPath}`,
      root.runnerIdentity.sourceSeal.manifestBytes,
      root.runnerIdentity.sourceSeal.manifestSha256,
      'root.runnerIdentity.sourceSeal manifest',
    );
  }
  if (root.runnerIdentity.bundle !== undefined) {
    assertBoundFile(
      logicalFiles,
      root.runnerIdentity.bundle.trackedReceiptLogicalPath,
      root.runnerIdentity.bundle.trackedReceiptBytes,
      root.runnerIdentity.bundle.localTrackedReceiptJsonSha256,
      'root.runnerIdentity.bundle tracked receipt',
    );
    await validateQ0sReceiptBinding(root, logicalFiles);
  }
  if (root.scope.classification === 'tracked-pre-code-native-build-input-root') {
    await validatePresealReceiptBindingV2(config, logicalFiles);
  }
}

async function validateGenerationRunner(root, logicalFiles) {
  const nodeInput = root.officialInputs.find((input) => input.nodeExe !== undefined);
  if (nodeInput === undefined) {
    return;
  }
  const expected = nodeInput.distributionIdentity;
  const actual = {
    abi: Number(process.versions.modules),
    architecture: process.arch,
    nodeApi: Number(process.versions.napi),
    version: process.versions.node,
  };
  if (
    process.platform !== 'win32' ||
    actual.abi !== expected.abi ||
    actual.architecture !== expected.architecture ||
    actual.nodeApi !== expected.nodeApi ||
    actual.version !== expected.version
  ) {
    fail(`generation runner does not equal the sealed Node identity: ${JSON.stringify(actual)}`);
  }
  if (process.env.NODE_OPTIONS || process.env.NODE_PATH || process.execArgv.length !== 0) {
    fail('generation runner must have empty NODE_OPTIONS, NODE_PATH, and execArgv');
  }
  const bound = assertBoundFile(
    logicalFiles,
    'node-distribution/node.exe',
    nodeInput.nodeExe.bytes,
    nodeInput.nodeExe.sha256,
    'generation runner',
  );
  const executableRealPath = await realpath(process.execPath);
  const boundRealPath = await realpath(bound.filePath);
  if (path.normalize(executableRealPath).toLocaleLowerCase('en-US') !== path.normalize(boundRealPath).toLocaleLowerCase('en-US')) {
    fail('generation runner executable path does not equal the sealed node-distribution/node.exe');
  }
  const digest = await hashStableFile(process.execPath, 'generation runner executable');
  if (digest.byteLength !== nodeInput.nodeExe.bytes || digest.sha256 !== nodeInput.nodeExe.sha256) {
    fail('generation runner executable bytes do not equal the sealed Node identity');
  }
}

function assertManifestSetId(value, label = 'manifestSetId') {
  if (typeof value !== 'string' || !/^[a-z0-9][a-z0-9._:-]{0,127}$/u.test(value)) {
    fail(`${label} must be a lowercase stable identifier of at most 128 characters`);
  }
}

function packRecordSet(records, label) {
  if (!Array.isArray(records)) {
    fail(`${label} must be an array`);
  }
  const fields = [...new Set(records.flatMap((record, index) => {
    assertPlainObject(record, `${label}[${index}]`);
    if (Object.getOwnPropertySymbols(record).length !== 0) {
      fail(`${label}[${index}] contains symbol keys`);
    }
    return Object.keys(record);
  }))].sort(ordinalCompare);
  const rows = records.map((record) => {
    let presence = 0n;
    const values = [];
    for (const [index, field] of fields.entries()) {
      if (Object.hasOwn(record, field)) {
        presence |= 1n << BigInt(index);
        values.push(record[field]);
      }
    }
    return [presence.toString(16), values];
  });
  return {
    encoding: PACKED_RECORD_SET_ENCODING,
    fields,
    rows,
  };
}

function validatePackedRecordSet(recordSet, label) {
  assertExactKeys(recordSet, PACKED_RECORD_SET_KEYS, label);
  if (recordSet.encoding !== PACKED_RECORD_SET_ENCODING) {
    fail(`${label}.encoding must equal the closed presence-bitmap encoding`);
  }
  if (!Array.isArray(recordSet.fields)) {
    fail(`${label}.fields must be an array`);
  }
  for (const [index, field] of recordSet.fields.entries()) {
    assertUnicodeScalarString(field, `${label}.fields[${index}]`);
    if (field.length === 0) {
      fail(`${label}.fields[${index}] must not be empty`);
    }
    if (index > 0 && ordinalCompare(recordSet.fields[index - 1], field) >= 0) {
      fail(`${label}.fields must be strictly ordinal-sorted and unique`);
    }
  }
  if (!Array.isArray(recordSet.rows)) {
    fail(`${label}.rows must be an array`);
  }
  for (const [index, row] of recordSet.rows.entries()) {
    if (!Array.isArray(row) || row.length !== 2 || !Array.isArray(row[1])) {
      fail(`${label}.rows[${index}] must be [lowercaseHexPresenceBitmap, values]`);
    }
    if (typeof row[0] !== 'string' || !/^(?:0|[1-9a-f][0-9a-f]*)$/u.test(row[0])) {
      fail(`${label}.rows[${index}][0] must be canonical lowercase hexadecimal`);
    }
    const presence = BigInt(`0x${row[0]}`);
    if ((presence >> BigInt(recordSet.fields.length)) !== 0n) {
      fail(`${label}.rows[${index}] selects a field outside the declared schema`);
    }
    let selectedCount = 0;
    let remaining = presence;
    while (remaining !== 0n) {
      selectedCount += Number(remaining & 1n);
      remaining >>= 1n;
    }
    if (row[1].length !== selectedCount) {
      fail(`${label}.rows[${index}][1] length does not equal its presence bitmap`);
    }
  }
}

function compactArtifactPolicies(policies) {
  const normalized = policies.map((policy, index) => {
    const label = `root metadata.artifactPolicies[${index}]`;
    assertExactKeys(policy, [
      'admissionClass',
      'artifactId',
      'delayImports',
      'directImports',
      'exports',
      'hardening',
      'loadConfiguration',
      'machine',
      'sections',
      'subsystem',
      'transitiveClosure',
    ], label);
    let directImports;
    if (Object.hasOwn(policy.directImports, 'allowed')) {
      assertExactKeys(policy.directImports, ['allowed', 'forbidden'], `${label}.directImports`);
      directImports = ['allowed', policy.directImports.allowed, policy.directImports.forbidden];
    } else {
      assertExactKeys(policy.directImports, ['observed'], `${label}.directImports`);
      directImports = ['observed', policy.directImports.observed, []];
    }
    assertPlainObject(policy.hardening, `${label}.hardening`);
    const hardening = Object.entries(policy.hardening)
      .sort(([left], [right]) => ordinalCompare(left, right))
      .map(([control, evidence]) => {
        assertExactKeys(evidence, ['evidence', 'status'], `${label}.hardening.${control}`);
        if (!['required', 'unsupported', 'exception-pending-decision'].includes(evidence.status)) {
          fail(
            `${label}.hardening.${control}.status must be required, unsupported, or ` +
            'exception-pending-decision',
          );
        }
        assertUnicodeScalarString(evidence.evidence, `${label}.hardening.${control}.evidence`);
        return [control, evidence.status, evidence.evidence];
      });
    if (hardening.length === 0) {
      fail(`${label}.hardening must declare at least one control`);
    }
    const loadFields = [
      'dependentLoadFlags',
      'guardCfCheckPointer',
      'guardCfDispatchPointer',
      'guardCfFunctionCount',
      'securityCookie',
    ];
    assertExactKeys(policy.loadConfiguration, loadFields, `${label}.loadConfiguration`);
    let sections;
    if (Object.hasOwn(policy.sections, 'allowed')) {
      assertExactKeys(policy.sections, ['allowed', 'forbidden', 'policy'], `${label}.sections`);
      sections = ['policy', policy.sections.allowed, policy.sections.forbidden, policy.sections.policy];
    } else {
      assertExactKeys(policy.sections, ['observedExact', 'policy'], `${label}.sections`);
      sections = ['observedExact', policy.sections.observedExact, [], policy.sections.policy];
    }
    return {
      admissionClass: policy.admissionClass,
      artifactId: policy.artifactId,
      delayImports: policy.delayImports,
      'directImports:[mode,positive,forbidden]': directImports,
      exports: policy.exports,
      'hardening:[control,status,evidence][]': hardening,
      'loadConfiguration:[dependentLoadFlags,guardCfCheckPointer,guardCfDispatchPointer,guardCfFunctionCount,securityCookie]':
        loadFields.map((field) => policy.loadConfiguration[field]),
      machine: policy.machine,
      'sections:[mode,positive,forbidden,policy]': sections,
      subsystem: policy.subsystem,
      transitiveClosure: policy.transitiveClosure,
    };
  });
  return packRecordSet(normalized, 'root metadata.artifactPolicies');
}

function compactBuildRecipes(recipes) {
  const firstArrayOccurrence = new Map();
  const normalized = recipes.map((recipe, index) => {
    const label = `root metadata.buildRecipes[${index}]`;
    assertPlainObject(recipe, label);
    if (typeof recipe.id !== 'string' || recipe.id.length === 0) {
      fail(`${label}.id must be a non-empty string`);
    }
    const compacted = Object.create(null);
    for (const [field, value] of Object.entries(recipe)) {
      if (!Array.isArray(value) || value.length < 4) {
        compacted[field] = value;
        continue;
      }
      const identity = `${field}:${sha256Bytes(canonicalJsonBytes(value))}`;
      const first = firstArrayOccurrence.get(identity);
      if (first === undefined) {
        firstArrayOccurrence.set(identity, `${recipe.id}.${field}`);
        compacted[field] = value;
      } else {
        compacted[field] = { sameAs: first };
      }
    }
    return compacted;
  });
  return packRecordSet(normalized, 'root metadata.buildRecipes');
}

function compactRootMetadata(metadata) {
  const officialInputs = metadata.officialInputs.map((input, index) => {
    assertPlainObject(input, `root metadata.officialInputs[${index}]`);
    if (!Array.isArray(input.assets)) {
      fail(`root metadata.officialInputs[${index}].assets must be an array`);
    }
    return Object.fromEntries(Object.entries(input).map(([key, value]) => [
      key,
      key === 'assets'
        ? packRecordSet(value, `root metadata.officialInputs[${index}].assets`)
        : value,
    ]));
  });
  const provenance = Object.fromEntries(Object.entries(metadata.provenance));
  if (Array.isArray(provenance.repositoryChain)) {
    provenance.repositoryChain = packRecordSet(
      provenance.repositoryChain,
      'root metadata.provenance.repositoryChain',
    );
  }
  return {
    artifactPolicies: compactArtifactPolicies(metadata.artifactPolicies),
    buildRecipes: compactBuildRecipes(metadata.buildRecipes),
    hostToolchain: metadata.hostToolchain,
    observations: packRecordSet(metadata.observations, 'root metadata.observations'),
    officialInputs: packRecordSet(officialInputs, 'root metadata.officialInputs'),
    packageResolution: metadata.packageResolution,
    provenance,
    runnerIdentity: metadata.runnerIdentity,
    scope: metadata.scope,
  };
}

const CX004_PRODUCTION_MANIFEST_SET_ID_PATTERN =
  /^cx004-native-input-v1:[0-9a-f]{40}:[0-9a-f]{40}$/u;

function assertCx004RootDiscriminator(metadata, label, manifestSetId) {
  const classified = metadata.scope.classification === 'tracked-pre-code-native-build-input-root';
  const carriesCx004Authority =
    Object.hasOwn(metadata.provenance, 'presealReceipt') ||
    Object.hasOwn(metadata.provenance, 'q0sBindings') ||
    Object.hasOwn(metadata.provenance, 't0PreCodeBase') ||
    Object.hasOwn(metadata.hostToolchain, 'servicedSystemToolPolicy') ||
    Object.hasOwn(metadata.scope, 'productionAdmission');
  const productionManifestSetId =
    manifestSetId !== undefined && CX004_PRODUCTION_MANIFEST_SET_ID_PATTERN.test(manifestSetId);
  if ((carriesCx004Authority || productionManifestSetId) && !classified) {
    fail(`${label}.scope.classification cannot downgrade a CX-004 production root authority`);
  }
  if (classified && manifestSetId !== undefined && !productionManifestSetId) {
    fail(`${label} CX-004 production classification requires its exact manifestSetId identity`);
  }
  return classified;
}

function assertRootMetadata(metadata, label = 'root metadata', options = {}) {
  assertExactKeys(metadata, ROOT_METADATA_KEYS, label);
  for (const key of ['artifactPolicies', 'buildRecipes', 'observations', 'officialInputs']) {
    if (!Array.isArray(metadata[key])) {
      fail(`${label}.${key} must be an array`);
    }
  }
  for (const key of ['hostToolchain', 'packageResolution', 'provenance', 'runnerIdentity', 'scope']) {
    assertPlainObject(metadata[key], `${label}.${key}`);
  }
  if (assertCx004RootDiscriminator(metadata, label, options.manifestSetId)) {
    validateCx004RootMetadata(metadata, label, options);
  }
  canonicalJsonBytes(metadata);
}

function assertExactStringArray(value, expected, label) {
  if (
    !Array.isArray(value) ||
    value.length !== expected.length ||
    value.some((entry, index) => entry !== expected[index])
  ) {
    fail(`${label} must equal ${JSON.stringify(expected)}`);
  }
}

function validateServicedSystemTool(tool, expected, label) {
  assertExactKeys(tool, [
    'authenticode',
    'bytes',
    'executionMode',
    'embeddedFileVersion',
    'hardlinkCount',
    'logicalPaths',
    'privateCopyFileName',
    'sha256',
  ], label);
  assertExactKeys(tool.authenticode, ['serial', 'status', 'subject', 'thumbprint'], `${label}.authenticode`);
  assertPositiveSafeInteger(tool.bytes, `${label}.bytes`);
  assertSha256(tool.sha256, `${label}.sha256`);
  assertExactStringArray(tool.logicalPaths, expected.logicalPaths, `${label}.logicalPaths`);
  for (const [index, logicalPath] of tool.logicalPaths.entries()) {
    validateLogicalPath(logicalPath, `${label}.logicalPaths[${index}]`);
  }
  assertCanonicalValueEqual(tool, expected, label);
}

function validateGitToolchain(git, label) {
  assertExactKeys(git, [
    'builtins',
    'executionPolicy',
    'fileVersion',
    'privateCopy',
    'sourceAliasGroups',
    'sourceExecutable',
    'systemImports',
    'tupleSchema',
  ], label);
  assertCanonicalValueEqual(git, {
    builtins: ['cat-file', 'rev-parse', 'show'],
    executionPolicy: 'run-private-git-builtins-v1',
    fileVersion: '2.51.0.windows.2',
    privateCopy: {
      byteLength: 6616989,
      fileCount: 6,
      files: [
        ['git.exe', 4284816, 'e996432581a70df2e7aaac5db71e3811ec0daa7f93a8ba73fe6db6f9941f4bf9'],
        ['libiconv-2.dll', 1136529, 'ff31fa811f9c07cc7fdaa68c9e8bca3a7b4fdf6e0a079a58175ea58ba139c7ae'],
        ['libintl-8.dll', 301688, '17bdd3de3329156e032949abcf3f0f9163febd0fb9299864b7eff7f31e7c15d4'],
        ['libpcre2-8-0.dll', 708739, '623e348e0ff02ee6ddfe687b161bcdde08fa925d2b94a23f10bcd34b34ee3e56'],
        ['libwinpthread-1.dll', 64403, 'f0c48bcf1f1f0a65b4f99406f56db7349ded8866cd86548687ab6a98e859af35'],
        ['zlib1.dll', 120814, 'cb7ab3788d10940df874acd97b1821bbb5ee4a91f3eec11982bb5bf7a3c96443'],
      ],
      surfaceSha256: 'b89c1cc53dd05a868ef31ef46fc0bcd25d55fbaef9c393ee7755f43e61f49b2b',
    },
    sourceAliasGroups: [
      {
        bytes: 1136529,
        kind: 'git-for-windows-runtime-hardlink-v1',
        linkCount: 2,
        logicalPaths: ['git/mingw64/bin/libiconv-2.dll', 'git/mingw64/libexec/git-core/libiconv-2.dll'],
        sha256: 'ff31fa811f9c07cc7fdaa68c9e8bca3a7b4fdf6e0a079a58175ea58ba139c7ae',
      },
      {
        bytes: 301688,
        kind: 'git-for-windows-runtime-hardlink-v1',
        linkCount: 2,
        logicalPaths: ['git/mingw64/bin/libintl-8.dll', 'git/mingw64/libexec/git-core/libintl-8.dll'],
        sha256: '17bdd3de3329156e032949abcf3f0f9163febd0fb9299864b7eff7f31e7c15d4',
      },
      {
        bytes: 708739,
        kind: 'git-for-windows-runtime-hardlink-v1',
        linkCount: 2,
        logicalPaths: ['git/mingw64/bin/libpcre2-8-0.dll', 'git/mingw64/libexec/git-core/libpcre2-8-0.dll'],
        sha256: '623e348e0ff02ee6ddfe687b161bcdde08fa925d2b94a23f10bcd34b34ee3e56',
      },
      {
        bytes: 64403,
        kind: 'git-for-windows-runtime-hardlink-v1',
        linkCount: 2,
        logicalPaths: ['git/mingw64/bin/libwinpthread-1.dll', 'git/mingw64/libexec/git-core/libwinpthread-1.dll'],
        sha256: 'f0c48bcf1f1f0a65b4f99406f56db7349ded8866cd86548687ab6a98e859af35',
      },
      {
        bytes: 120814,
        kind: 'git-for-windows-runtime-hardlink-v1',
        linkCount: 2,
        logicalPaths: ['git/mingw64/bin/zlib1.dll', 'git/mingw64/libexec/git-core/zlib1.dll'],
        sha256: 'cb7ab3788d10940df874acd97b1821bbb5ee4a91f3eec11982bb5bf7a3c96443',
      },
    ],
    sourceExecutable: ['git/mingw64/libexec/git-core/git.exe', 4284816, 'e996432581a70df2e7aaac5db71e3811ec0daa7f93a8ba73fe6db6f9941f4bf9'],
    systemImports: ['ADVAPI32.dll', 'KERNEL32.dll', 'msvcrt.dll', 'ntdll.dll', 'USER32.dll', 'WS2_32.dll'],
    tupleSchema: ['logicalPath', 'bytes', 'sha256'],
  }, label);
}

function validateCx004HostToolchain(hostToolchain, label) {
  const metadata = { hostToolchain };
  assertExactKeys(metadata.hostToolchain, [
    'authenticodeVerificationTool',
    'buildEnvironment',
    'git',
    'nodeGypDiscovery',
    'processTreeTerminationTool',
    'selectedVisualStudio',
    'servicedSystemToolPolicy',
    'signatureVerificationClosure',
    'tools',
    'verificationArtifacts',
  ], `${label}.hostToolchain`);
  validateGitToolchain(metadata.hostToolchain.git, `${label}.hostToolchain.git`);
  validateServicedSystemTool(metadata.hostToolchain.authenticodeVerificationTool, {
    authenticode: {
      serial: '330000059B7ABC51A19E71241800000000059B',
      status: 'Valid',
      subject: 'CN=Microsoft Windows, O=Microsoft Corporation, L=Redmond, S=Washington, C=US',
      thumbprint: 'DC91E564D5BC1E3A8E02D6A8508682ABEA8A2443',
    },
    bytes: 454656,
    executionMode: 'bootstrap-source-once-then-private-copy',
    embeddedFileVersion: '10.0.26100.8875',
    hardlinkCount: 2,
    logicalPaths: [
      'windows/System32/WindowsPowerShell/v1.0/powershell.exe',
      'windows/WinSxS/amd64_microsoft-windows-powershell-exe_31bf3856ad364e35_10.0.26100.8875_none_04b33bacb253ee82/powershell.exe',
    ],
    privateCopyFileName: 'powershell.exe',
    sha256: '7600ffe12da441fe89d035b13801e8e91d064bc544a27b19a5cf49f6ab8b18f5',
  }, `${label}.hostToolchain.authenticodeVerificationTool`);
  validateServicedSystemTool(metadata.hostToolchain.processTreeTerminationTool, {
    authenticode: {
      serial: '3300000519DADDAA8BDC44B292000000000519',
      status: 'Valid',
      subject: 'CN=Microsoft Windows, O=Microsoft Corporation, L=Redmond, S=Washington, C=US',
      thumbprint: '3B77DB29AC72AA6B5880ECB2ED5EC1EC6601D847',
    },
    bytes: 118784,
    executionMode: 'private-copy-with-bootstrap-failure-only-source',
    embeddedFileVersion: '10.0.26100.1',
    hardlinkCount: 2,
    logicalPaths: [
      'windows/System32/taskkill.exe',
      'windows/WinSxS/amd64_microsoft-windows-taskkill_31bf3856ad364e35_10.0.26100.1_none_2271a765c49d2684/taskkill.exe',
    ],
    privateCopyFileName: 'taskkill.exe',
    sha256: '1249717315fc8f4d2df17d5db9da0444795fdb9fb83dfb1f763c3f39282244f7',
  }, `${label}.hostToolchain.processTreeTerminationTool`);
  assertExactKeys(metadata.hostToolchain.servicedSystemToolPolicy, [
    'bootstrapExecution',
    'bootstrapSourceExecutionLimit',
    'ownedRootExitTimeoutMs',
    'passedReceiptBootstrapFailureCleanupUsed',
    'privateCopyIdentity',
    'sourceIdentity',
    'terminationInvocation',
    'terminationToolTimeoutMs',
  ], `${label}.hostToolchain.servicedSystemToolPolicy`);
  assertCanonicalValueEqual(metadata.hostToolchain.servicedSystemToolPolicy, {
    bootstrapExecution: 'os-tcb-bootstrap-then-verified-single-link-copy',
    bootstrapSourceExecutionLimit: 1,
    ownedRootExitTimeoutMs: 25000,
    passedReceiptBootstrapFailureCleanupUsed: false,
    privateCopyIdentity: 'run-private-single-link-copy-v1',
    sourceIdentity: 'windows-servicing-hardlink-v1',
    terminationInvocation: 'taskkill-tree-force-v1',
    terminationToolTimeoutMs: 10000,
  }, `${label}.hostToolchain.servicedSystemToolPolicy`);
  assertExactKeys(metadata.hostToolchain.signatureVerificationClosure, [
    'dependencyPolicy',
    'files',
    'systemImports',
    'tupleSchema',
  ], `${label}.hostToolchain.signatureVerificationClosure`);
  assertExactStringArray(
    metadata.hostToolchain.signatureVerificationClosure.tupleSchema,
    ['logicalPath', 'bytes', 'sha256'],
    `${label}.hostToolchain.signatureVerificationClosure.tupleSchema`,
  );
  assertExactStringArray(
    metadata.hostToolchain.signatureVerificationClosure.systemImports,
    ['KERNEL32.dll', 'ntdll.dll', 'USER32.dll'],
    `${label}.hostToolchain.signatureVerificationClosure.systemImports`,
  );
  if (
    metadata.hostToolchain.signatureVerificationClosure.dependencyPolicy !==
    'exact Git-for-Windows GPG/GPGV local PE closure plus OS-bound KERNEL32/ntdll/USER32'
  ) {
    fail(`${label}.hostToolchain.signatureVerificationClosure.dependencyPolicy is not exact`);
  }
  if (metadata.hostToolchain.signatureVerificationClosure.files.length !== 15) {
    fail(`${label}.hostToolchain.signatureVerificationClosure must contain exactly 15 local PEs`);
  }
  const signatureClosurePaths = new Set();
  for (const [index, file] of metadata.hostToolchain.signatureVerificationClosure.files.entries()) {
    if (!Array.isArray(file) || file.length !== 3) {
      fail(`${label}.hostToolchain.signatureVerificationClosure.files[${index}] must be [path,bytes,sha256]`);
    }
    validateLogicalPath(file[0], `${label}.hostToolchain.signatureVerificationClosure.files[${index}][0]`);
    assertPositiveSafeInteger(file[1], `${label}.hostToolchain.signatureVerificationClosure.files[${index}][1]`);
    assertSha256(file[2], `${label}.hostToolchain.signatureVerificationClosure.files[${index}][2]`);
    if (signatureClosurePaths.has(file[0])) {
      fail(`${label}.hostToolchain.signatureVerificationClosure contains duplicate ${JSON.stringify(file[0])}`);
    }
    signatureClosurePaths.add(file[0]);
  }
  if (sha256Bytes(canonicalJsonBytes(hostToolchain)) !== CX004_HOST_TOOLCHAIN_SHA256) {
    fail(`${label}.hostToolchain does not equal the exact CX-004 host-toolchain authority`);
  }
}

function validateCx004Scope(scope, label) {
  assertExactKeys(scope, [
    'classification',
    'conclusion',
    'externalPmWrites',
    'manifestFrameBytesMaximum',
    'productionAdmission',
    'productionComposition',
    'providerProcesses',
    'shardEntriesMaximum',
    'sourceImplementationIncluded',
    'stableRepositoryMutation',
  ], label);
  if (
    MAX_MANIFEST_BYTES !== CX004_SCOPE.manifestFrameBytesMaximum ||
    MAX_FILES_PER_SHARD !== CX004_SCOPE.shardEntriesMaximum
  ) {
    fail('CX-004 manifest implementation bounds no longer equal the sealed scope authority');
  }
  assertCanonicalValueEqual(scope, CX004_SCOPE, label);
}

function validateCx004RootMetadata(metadata, label, { allowPendingPreseal = false } = {}) {
  validateCx004HostToolchain(metadata.hostToolchain, label);
  if (
    sha256Bytes(canonicalJsonBytes(metadata.artifactPolicies)) !==
    CX004_ARTIFACT_POLICIES_SHA256
  ) {
    fail(`${label}.artifactPolicies does not equal the exact CX-004 artifact-policy authority`);
  }
  assertExactKeys(metadata.packageResolution, [
    'lock',
    'nodeGypClosure',
    'packageSelection',
    'pnpmDistribution',
    'postSealMutationPolicy',
    'selectedPackageTupleSchema',
    'selectedPackages',
    'store',
    'storeIndexProjectionAlgorithm',
    'workspaceManifestTupleSchema',
    'workspaceManifests',
    'workspaceYaml',
  ], `${label}.packageResolution`);
  assertExactKeys(metadata.provenance, [
    'manifestSelfReferencePolicy',
    'origin',
    'presealReceipt',
    'q0sBindings',
    'repositoryChain',
    't0PreCodeBase',
    't0TrackedInputTupleSchema',
    't0TrackedInputs',
  ], `${label}.provenance`);
  presealRepositoryChainAuthorities(metadata.provenance, `${label}.provenance`);
  const presealReceipt = metadata.provenance.presealReceipt;
  const presealLifecycle = validatePresealLifecycleDescriptor(
    presealReceipt,
    `${label}.provenance.presealReceipt`,
  );
  if (presealLifecycle === 'pending') {
    if (!allowPendingPreseal) {
      fail(`${label}.provenance.presealReceipt pending lifecycle is permitted only while loading capture config`);
    }
  } else {
    if (
      presealReceipt.commandCount !== CX004_PRESEAL_COMMAND_COUNT ||
      presealReceipt.offlineReused !== 491
    ) {
      fail(`${label}.provenance.presealReceipt does not carry the exact passed offline v2 command identity`);
    }
  }
  assertExactKeys(metadata.runnerIdentity, [
    'boundedHostSmoke',
    'bundle',
    'guest',
    'host',
    'outcome',
    'requestedConfiguration',
    'sandbox',
    'schema',
    'scope',
    'sourceSeal',
    'teardownLevel',
  ], `${label}.runnerIdentity`);
  validateCx004Scope(metadata.scope, `${label}.scope`);
  assertExactKeys(metadata.runnerIdentity.bundle, [
    'aggregateSha256',
    'id',
    'localTrackedReceiptJsonSha256',
    'trackedReceiptBytes',
    'trackedReceiptLogicalPath',
  ], `${label}.runnerIdentity.bundle`);
  assertExactKeys(metadata.runnerIdentity.guest, [
    'architecture',
    'displayVersion',
    'editionId',
    'groupCount',
    'installationType',
    'integrity',
    'marketingIdentity',
    'privilegeCount',
    'processArchitecture',
    'productType',
    'rawCompatibilityRegistryProductName',
    'revision',
  ], `${label}.runnerIdentity.guest`);
  assertExactKeys(metadata.runnerIdentity.host, [
    'architecture',
    'editionId',
    'installationType',
    'product',
    'revision',
  ], `${label}.runnerIdentity.host`);
  assertExactKeys(metadata.runnerIdentity.requestedConfiguration, [
    'audioInput',
    'clipboard',
    'memoryMiB',
    'networking',
    'printer',
    'protectedClient',
    'vGPU',
    'videoInput',
  ], `${label}.runnerIdentity.requestedConfiguration`);
  assertExactKeys(metadata.runnerIdentity.sandbox, [
    'cliVersion',
    'feature',
    'freshSessionRuns',
    'inputMappingReadOnly',
    'networkIsolation',
    'packageFullName',
    'packageVersion',
    'persistenceReset',
    'positiveExactIdStop',
    'terminalSessionInventory',
  ], `${label}.runnerIdentity.sandbox`);
  assertExactKeys(metadata.runnerIdentity.sourceSeal, [
    'classification',
    'gitBlob',
    'manifestBytes',
    'manifestPath',
    'manifestSha256',
    'sourceFileTupleSchema',
    'sourceFiles',
    'stableRenderedManifestSha256',
    'templateSha256',
  ], `${label}.runnerIdentity.sourceSeal`);
  if (
    metadata.runnerIdentity.boundedHostSmoke !== 'passed' ||
    metadata.runnerIdentity.outcome !== 'passed' ||
    metadata.runnerIdentity.schema !== 'cx004-q0s-v1' ||
    metadata.runnerIdentity.scope !== 'runner-readiness-only' ||
    metadata.runnerIdentity.teardownLevel !== 'sandbox-session-stopped'
  ) {
    fail(`${label}.runnerIdentity does not carry the passed Q0S identity`);
  }
  assertExactStringArray(
    metadata.packageResolution.selectedPackageTupleSchema,
    [
      'name',
      'version',
      'lockIntegrity',
      'storeIndexRelativePath',
      'packageFileCount',
      'packageFileBytes',
      'normalizedIndexProjectionBytes',
      'normalizedIndexProjectionSha256',
    ],
    `${label}.packageResolution.selectedPackageTupleSchema`,
  );
  assertExactStringArray(
    metadata.packageResolution.workspaceManifestTupleSchema,
    [
      'path',
      'canonicalLfBytes',
      'canonicalLfSha256',
      'resolutionProjectionBytes',
      'resolutionProjectionSha256',
    ],
    `${label}.packageResolution.workspaceManifestTupleSchema`,
  );
  const recipeAllowedKeys = [
    'archiveDriver', 'artifactId', 'buildInputs', 'casePolicy', 'compileDriver', 'compileFlags',
    'compileFlagsC', 'compileFlagsCxx', 'controllerPolicy', 'defines', 'driverSelectionFlags',
    'entryPoint', 'environmentProjectionId', 'id', 'includeRootRoles', 'libraries', 'libraryFlags',
    'linkDriver', 'linkDriverFlags', 'linkDriverSeparator', 'linkFlags', 'linker', 'nodeGypArguments',
    'nodeImportMode', 'outputKind', 'patchPolicy', 'portableCore', 'profilePolicy', 'resourceCompiler',
    'resourceFlags', 'resourcePayloads', 'resourcePayloadTupleSchema', 'targets', 'targetTupleSchema',
    'translationUnits', 'unsupportedSanitizers', 'variant',
  ];
  const recipeRequiredKeys = new Map([
    ['llvm-19.1.7-coverage-replay', [
      'compileDriver', 'compileFlags', 'driverSelectionFlags', 'entryPoint', 'linkDriver',
      'linkDriverFlags', 'linkDriverSeparator', 'linker', 'linkFlags', 'portableCore',
      'profilePolicy', 'targetTupleSchema', 'targets',
    ]],
    ['llvm-19.1.7-fuzz', [
      'compileDriver', 'compileFlags', 'controllerPolicy', 'driverSelectionFlags', 'linkDriver',
      'linkDriverFlags', 'linkDriverSeparator', 'linker', 'linkFlags', 'portableCore',
      'targetTupleSchema', 'targets',
    ]],
    ['msvc-asan-qualification', [
      'compileDriver', 'compileFlags', 'linkDriver', 'linkDriverFlags', 'linkDriverSeparator',
      'linkFlags', 'portableCore', 'targetTupleSchema', 'targets', 'unsupportedSanitizers',
    ]],
    ['msvc-input-manifest-resource', [
      'entryPoint', 'resourceCompiler', 'resourceFlags', 'resourcePayloads',
      'resourcePayloadTupleSchema',
    ]],
    ['msvc-native-properties', [
      'casePolicy', 'compileDriver', 'compileFlags', 'linkDriver', 'targets', 'translationUnits',
    ]],
    ['msvc-release-addon', [
      'compileDriver', 'compileFlags', 'defines', 'includeRootRoles', 'libraries', 'linkDriver',
      'linkFlags', 'nodeImportMode', 'translationUnits',
    ]],
    ['msvc-release-bootstrap', [
      'compileDriver', 'compileFlags', 'defines', 'includeRootRoles', 'libraries', 'linkDriver',
      'linkFlags', 'translationUnits',
    ]],
    ['msvc-release-core', [
      'archiveDriver', 'compileDriver', 'compileFlags', 'defines', 'includeRootRoles',
      'libraryFlags', 'translationUnits',
    ]],
    ['msvc-static-analysis-all-tu', ['compileDriver', 'compileFlags', 'translationUnits']],
    ['node-gyp-release-sqlite', [
      'compileDriver', 'compileFlagsC', 'compileFlagsCxx', 'defines', 'includeRootRoles',
      'libraries', 'linkDriver', 'linkFlags', 'nodeGypArguments', 'nodeImportMode',
      'patchPolicy', 'translationUnits',
    ]],
  ]);
  const recipeIds = [];
  const releaseStaticRuntimeFields = new Map([
    ['msvc-release-core', ['compileFlags']],
    ['msvc-release-bootstrap', ['compileFlags']],
    ['msvc-release-addon', ['compileFlags']],
    ['node-gyp-release-sqlite', ['compileFlagsC', 'compileFlagsCxx']],
  ]);
  for (const [index, recipe] of metadata.buildRecipes.entries()) {
    const recipeLabel = `${label}.buildRecipes[${index}]`;
    const recipeSpecificRequiredKeys = recipeRequiredKeys.get(recipe.id);
    if (recipeSpecificRequiredKeys === undefined) {
      fail(`${recipeLabel}.id is not an admitted CX-004 build recipe`);
    }
    assertAllowedKeys(
      recipe,
      recipeAllowedKeys,
      [
        'artifactId',
        'buildInputs',
        'environmentProjectionId',
        'id',
        'outputKind',
        'variant',
        ...recipeSpecificRequiredKeys,
      ],
      recipeLabel,
    );
    assertUnicodeScalarString(recipe.id, `${recipeLabel}.id`);
    assertUnicodeScalarString(recipe.artifactId, `${recipeLabel}.artifactId`);
    if (!Array.isArray(recipe.buildInputs) || recipe.buildInputs.length === 0) {
      fail(`${recipeLabel}.buildInputs must be a non-empty array`);
    }
    if (Object.hasOwn(recipe, 'linkFlags')) {
      if (!Array.isArray(recipe.linkFlags) || recipe.linkFlags.length === 0) {
        fail(`${recipeLabel}.linkFlags must be a non-empty array`);
      }
      const normalizedLinkFlags = new Set();
      for (const [flagIndex, flag] of recipe.linkFlags.entries()) {
        assertUnicodeScalarString(flag, `${recipeLabel}.linkFlags[${flagIndex}]`);
        normalizedLinkFlags.add(flag.toLocaleUpperCase('en-US'));
      }
      if (normalizedLinkFlags.has('/DLL') && normalizedLinkFlags.has('/ALLOWISOLATION')) {
        fail(`${recipeLabel}.linkFlags cannot combine /DLL with /ALLOWISOLATION`);
      }
      if (['msvc-release-bootstrap', 'msvc-release-addon', 'node-gyp-release-sqlite'].includes(recipe.id)) {
        if (!normalizedLinkFlags.has('/LTCG') || !normalizedLinkFlags.has('/VERBOSE:LIB')) {
          fail(`${recipeLabel}.linkFlags must select /LTCG and /VERBOSE:LIB`);
        }
      }
    }
    for (const field of releaseStaticRuntimeFields.get(recipe.id) ?? []) {
      if (!Array.isArray(recipe[field]) || recipe[field].length === 0) {
        fail(`${recipeLabel}.${field} must be a non-empty array`);
      }
      const normalizedFlags = recipe[field].map((flag, flagIndex) => {
        assertUnicodeScalarString(flag, `${recipeLabel}.${field}[${flagIndex}]`);
        return flag.toLocaleUpperCase('en-US');
      });
      const runtimeSelectors = normalizedFlags.filter(
        (flag) => ['/MT', '/MTD', '/MD', '/MDD'].includes(flag),
      );
      if (
        runtimeSelectors.length !== 1
        || runtimeSelectors[0] !== '/MT'
        || !normalizedFlags.includes('/GL')
        || normalizedFlags.includes('/ZL')
        || normalizedFlags.includes('/LD')
        || normalizedFlags.includes('/LDD')
      ) {
        fail(`${recipeLabel}.${field} must select exactly /GL plus the retail static CRT /MT`);
      }
    }
    recipeIds.push(recipe.id);
  }
  const expectedRecipeIds = [
    'llvm-19.1.7-coverage-replay',
    'llvm-19.1.7-fuzz',
    'msvc-asan-qualification',
    'msvc-input-manifest-resource',
    'msvc-native-properties',
    'msvc-release-addon',
    'msvc-release-bootstrap',
    'msvc-release-core',
    'msvc-static-analysis-all-tu',
    'node-gyp-release-sqlite',
  ];
  assertExactStringArray(recipeIds.sort(ordinalCompare), expectedRecipeIds, `${label}.buildRecipes ids`);
  const resourceRecipe = metadata.buildRecipes.find(
    (recipe) => recipe.id === 'msvc-input-manifest-resource',
  );
  if (
    resourceRecipe.resourceCompiler !== 'sdk/bin/10.0.22621.0/x64/rc.exe' ||
    resourceRecipe.entryPoint !== 'generated/cx004-native-build-input-digest.rc'
  ) {
    fail(`${label}.buildRecipes resource recipe does not bind the sealed rc.exe/source pair`);
  }
  assertExactStringArray(
    resourceRecipe.resourceFlags,
    ['/nologo', '/x', '/fo', '${INPUT_MANIFEST_RES}', '${INPUT_MANIFEST_RC}'],
    `${label}.buildRecipes resource flags`,
  );
  assertExactStringArray(
    resourceRecipe.resourcePayloadTupleSchema,
    ['resourceName', 'resourceType', 'source', 'encoding', 'bytes', 'value'],
    `${label}.buildRecipes resource payload tuple schema`,
  );
  const expectedResourcePayloads = [[
    'PCSDK_CX004_NATIVE_BUILD_INPUT_SHA256',
    'RCDATA',
    'generated/CX-004-native-build-input.sha256.bin',
    'raw-sha256',
    32,
    'SHA-256 of the exact canonical docs/execution/manifests/CX-004-native-build-input.json bytes',
  ]];
  if (!canonicalJsonBytes(resourceRecipe.resourcePayloads).equals(canonicalJsonBytes(expectedResourcePayloads))) {
    fail(`${label}.buildRecipes resource payload does not exactly bind the canonical root digest`);
  }
  const asanRecipe = metadata.buildRecipes.find((recipe) => recipe.id === 'msvc-asan-qualification');
  assertExactStringArray(
    asanRecipe.targetTupleSchema,
    ['artifact', 'outputKind', 'sharedTranslationUnits', 'translationUnits'],
    `${label}.buildRecipes MSVC ASan target tuple schema`,
  );
  assertExactStringArray(
    asanRecipe.targets.map((target) => target[0]),
    [
      'pc-sdk-next-bootstrap-asan.exe',
      'pc_sdk_next_containment_asan.node',
      'better_sqlite3_asan.node',
      'cx004-native-properties-asan.exe',
    ],
    `${label}.buildRecipes MSVC ASan targets`,
  );
  for (const [targetIndex, target] of asanRecipe.targets.entries()) {
    if (
      !Array.isArray(target) ||
      target.length !== 4 ||
      typeof target[2] !== 'string' ||
      !Array.isArray(target[3]) ||
      target[3].length === 0
    ) {
      fail(`${label}.buildRecipes MSVC ASan target ${targetIndex} is not an exact source mapping`);
    }
  }
  for (const recipeId of ['llvm-19.1.7-fuzz', 'llvm-19.1.7-coverage-replay']) {
    const recipe = metadata.buildRecipes.find((entry) => entry.id === recipeId);
    assertExactStringArray(
      recipe.targetTupleSchema,
      ['target', 'translationUnit', 'artifact'],
      `${label}.buildRecipes ${recipeId} target tuple schema`,
    );
  }
  const coverageRecipe = metadata.buildRecipes.find(
    (recipe) => recipe.id === 'llvm-19.1.7-coverage-replay',
  );
  if (coverageRecipe.entryPoint !== 'packages/windows-containment/native/test/coverage/corpus_replay_main.cc') {
    fail(`${label}.buildRecipes coverage replay entry point is not exact`);
  }
  const coveragePrefixMaps = coverageRecipe.compileFlags.filter(
    (flag) => flag.startsWith('/clang:-ffile-prefix-map='),
  );
  const coverageCompilationDirectories = coverageRecipe.compileFlags.filter(
    (flag) => flag.startsWith('/clang:-fcoverage-compilation-dir='),
  );
  const coveragePathAliases = coverageRecipe.compileFlags.filter((flag) => (
    flag.startsWith('/clang:-ffile-compilation-dir=')
      || flag.startsWith('/clang:-fcoverage-prefix-map=')
      || flag.startsWith('-ffile-compilation-dir=')
      || flag.startsWith('-fcoverage-compilation-dir=')
      || flag.startsWith('-fcoverage-prefix-map=')
  ));
  if (
    coveragePrefixMaps.length !== 1
    || coveragePrefixMaps[0] !== '/clang:-ffile-prefix-map=${SOURCE_ROOT}=packages/windows-containment/native'
    || coverageCompilationDirectories.length !== 1
    || coverageCompilationDirectories[0] !== '/clang:-fcoverage-compilation-dir=.'
    || coveragePathAliases.length !== 0
  ) {
    fail(`${label}.buildRecipes coverage replay must carry the exact singleton source prefix map and current-directory coverage mapping`);
  }
  const exactLlvmCompileFlags = new Map([
    ['llvm-19.1.7-coverage-replay', [
      '/nologo', '/c', '/TP', '/std:c++20', '/permissive-', '/EHsc', '/GR-', '/W4', '/WX',
      '/GS', '/guard:cf', '/O1', '/Oy-', '/Z7', '/MT', '/utf-8',
      '/clang:-fno-omit-frame-pointer', '-fprofile-instr-generate', '-fcoverage-mapping',
      '/clang:-ffile-prefix-map=${SOURCE_ROOT}=packages/windows-containment/native',
      '/clang:-fcoverage-compilation-dir=.',
    ]],
    ['llvm-19.1.7-fuzz', [
      '/nologo', '/c', '/TP', '/std:c++20', '/permissive-', '/EHsc', '/GR-', '/W4', '/WX',
      '/GS', '/guard:cf', '/O1', '/Oy-', '/Z7', '/MT', '/utf-8', '/Zc:__cplusplus',
      '/clang:-fno-omit-frame-pointer', '-fsanitize=fuzzer-no-link,address',
      '-fsanitize-coverage=edge,indirect-calls,trace-cmp,trace-div,trace-gep',
      '/clang:-ffile-prefix-map=${SOURCE_ROOT}=packages/windows-containment/native',
    ]],
  ]);
  for (const [recipeId, expectedFlags] of exactLlvmCompileFlags) {
    const recipe = metadata.buildRecipes.find((entry) => entry.id === recipeId);
    assertExactStringArray(
      recipe.compileFlags,
      expectedFlags,
      `${label}.buildRecipes ${recipeId} compileFlags`,
    );
  }
  const expectedOfficialKeys = new Map([
    ['node-v22.13.0-win-x64', ['assets', 'distributionIdentity', 'id', 'nodeExe', 'signatureVerification']],
    ['llvm-19.1.7-windows-msvc', ['assets', 'distributionIdentity', 'id', 'selectedRuntime', 'signatureVerification', 'tagIdentity']],
    ['python-3.13.14-embed-amd64', ['assets', 'id', 'pythonExe', 'signatureVerification']],
    ['pnpm-10.33.0', ['assets', 'distribution', 'id', 'signatureVerification']],
  ]);
  const expectedSignatureKeys = new Map([
    ['node-v22.13.0-win-x64', [
      'clearSignedAndDetachedPayloadEquality',
      'historicalKeyCommit',
      'historicalKeyring',
      'result',
      'signatureTimestamp',
      'signer',
      'signerFingerprint',
    ]],
    ['llvm-19.1.7-windows-msvc', [
      'digestAlgorithm',
      'result',
      'signatureTimestamp',
      'signer',
      'signerFingerprint',
    ]],
    ['python-3.13.14-embed-amd64', [
      'digestAlgorithm',
      'releaseKey',
      'result',
      'signatureTimestamp',
      'signer',
      'signerFingerprint',
    ]],
    ['pnpm-10.33.0', ['algorithm', 'keyId', 'message', 'result']],
  ]);
  if (metadata.officialInputs.length !== expectedOfficialKeys.size) {
    fail(`${label}.officialInputs must contain exactly ${expectedOfficialKeys.size} entries`);
  }
  for (const [index, input] of metadata.officialInputs.entries()) {
    const inputLabel = `${label}.officialInputs[${index}]`;
    const keys = expectedOfficialKeys.get(input.id);
    if (keys === undefined) {
      fail(`${inputLabel}.id is not an admitted official input`);
    }
    assertExactKeys(input, keys, inputLabel);
    assertExactKeys(input.signatureVerification, expectedSignatureKeys.get(input.id), `${inputLabel}.signatureVerification`);
    if (!Array.isArray(input.assets) || input.assets.length === 0) {
      fail(`${inputLabel}.assets must be a non-empty array`);
    }
    for (const [assetIndex, asset] of input.assets.entries()) {
      assertAllowedKeys(
        asset,
        ['assetId', 'bytes', 'cacheKey', 'fileName', 'role', 'sha1', 'sha256', 'sha512Integrity', 'shasumsLine', 'sourceUrl'],
        ['bytes', 'cacheKey', 'fileName', 'role', 'sha256', 'sourceUrl'],
        `${inputLabel}.assets[${assetIndex}]`,
      );
      assertNonNegativeSafeInteger(asset.bytes, `${inputLabel}.assets[${assetIndex}].bytes`);
      assertSha256(asset.sha256, `${inputLabel}.assets[${assetIndex}].sha256`);
    }
  }
  const pythonInput = metadata.officialInputs.find(
    (input) => input.id === 'python-3.13.14-embed-amd64',
  );
  assertExactKeys(
    pythonInput.signatureVerification.releaseKey,
    ['bytes', 'logicalPath', 'sha256'],
    `${label}.officialInputs Python release key`,
  );
  assertPositiveSafeInteger(
    pythonInput.signatureVerification.releaseKey.bytes,
    `${label}.officialInputs Python release key bytes`,
  );
  validateLogicalPath(
    pythonInput.signatureVerification.releaseKey.logicalPath,
    `${label}.officialInputs Python release key logicalPath`,
  );
  assertSha256(
    pythonInput.signatureVerification.releaseKey.sha256,
    `${label}.officialInputs Python release key sha256`,
  );
  if (
    pythonInput.signatureVerification.releaseKey.logicalPath !==
    `cache/objects/sha256/${pythonInput.signatureVerification.releaseKey.sha256}/python-steve-dower-release-key.asc`
  ) {
    fail(`${label}.officialInputs Python release key logicalPath is not content-addressed`);
  }
  const pnpmInput = metadata.officialInputs.find((input) => input.id === 'pnpm-10.33.0');
  if (
    pnpmInput.signatureVerification.message !==
    `pnpm@${pnpmInput.distribution.version}:${metadata.packageResolution.pnpmDistribution.integrity}`
  ) {
    fail(`${label}.officialInputs pnpm signature message is not derived from the sealed version/integrity`);
  }
  const observationIds = new Set();
  for (const [index, observation] of metadata.observations.entries()) {
    assertAllowedKeys(
      observation,
      ['classification', 'conditions', 'disposition', 'facts', 'id', 'reason'],
      ['classification', 'facts', 'id'],
      `${label}.observations[${index}]`,
    );
    if (observationIds.has(observation.id)) {
      fail(`${label}.observations contains duplicate id ${JSON.stringify(observation.id)}`);
    }
    observationIds.add(observation.id);
  }
}

function assertCompactedRootMetadata(metadata, label = 'root metadata', options = {}) {
  assertExactKeys(metadata, ROOT_METADATA_KEYS, label);
  for (const key of ['artifactPolicies', 'buildRecipes', 'observations', 'officialInputs']) {
    validatePackedRecordSet(metadata[key], `${label}.${key}`);
  }
  for (const key of ['hostToolchain', 'packageResolution', 'provenance', 'runnerIdentity', 'scope']) {
    assertPlainObject(metadata[key], `${label}.${key}`);
  }
  if (Object.hasOwn(metadata.provenance, 'repositoryChain')) {
    validatePackedRecordSet(metadata.provenance.repositoryChain, `${label}.provenance.repositoryChain`);
  }
  if (assertCx004RootDiscriminator(metadata, label, options.manifestSetId)) {
    const declared = metadata.provenance.presealReceipt;
    if (declared?.status === 'pending') {
      fail(`${label}.provenance.presealReceipt pending lifecycle is forbidden in a root manifest`);
    }
    validatePresealV2Descriptor(declared, `${label}.provenance.presealReceipt`);
    validateCx004Scope(metadata.scope, `${label}.scope`);
    if (
      sha256Bytes(canonicalJsonBytes(metadata.artifactPolicies)) !==
      CX004_COMPACT_ARTIFACT_POLICIES_SHA256
    ) {
      fail(`${label}.artifactPolicies does not equal the exact compact CX-004 artifact-policy authority`);
    }
  }
  canonicalJsonBytes(metadata);
}

function assertFileTuple(file, label) {
  if (!Array.isArray(file) || file.length !== 3) {
    fail(`${label} must be [relativePath, byteLength, lowercaseSha256]`);
  }
  validateLogicalPath(file[0], `${label}[0]`);
  assertNonNegativeSafeInteger(file[1], `${label}[1]`);
  assertSha256(file[2], `${label}[2]`);
}

function assertSortedUniqueFiles(files, label) {
  if (!Array.isArray(files) || files.length === 0) {
    fail(`${label} must be a non-empty file tuple array`);
  }
  for (const [index, file] of files.entries()) {
    assertFileTuple(file, `${label}[${index}]`);
    if (index > 0 && ordinalCompare(files[index - 1][0], file[0]) >= 0) {
      fail(`${label} paths must be strictly ordinal-sorted and unique`);
    }
  }
}

function makeShardFileName(surfaceId, shardIndex, sha256) {
  assertSha256(sha256, 'shard filename SHA-256');
  return `${SHARD_FILE_PREFIX}${surfaceId}-${String(shardIndex + 1).padStart(3, '0')}-${sha256}.json`;
}

function makeHostToolchainMetadataFileName(sha256) {
  assertSha256(sha256, 'host-toolchain metadata filename SHA-256');
  return `${HOST_TOOLCHAIN_METADATA_FILE_PREFIX}${sha256}.json`;
}

function makeHostToolchainMetadataManifest(manifestSetId, hostToolchain) {
  return {
    classification: HOST_TOOLCHAIN_METADATA_CLASSIFICATION,
    hostToolchain,
    manifestSetId,
    schemaVersion: HOST_TOOLCHAIN_METADATA_SCHEMA_VERSION,
  };
}

function validateHostToolchainMetadataDescriptor(descriptor, label) {
  assertExactKeys(
    descriptor,
    ['byteLength', 'fileName', 'schemaVersion', 'sha256'],
    label,
  );
  assertPositiveSafeInteger(descriptor.byteLength, `${label}.byteLength`);
  assertSha256(descriptor.sha256, `${label}.sha256`);
  if (descriptor.schemaVersion !== HOST_TOOLCHAIN_METADATA_SCHEMA_VERSION) {
    fail(`${label}.schemaVersion must equal ${HOST_TOOLCHAIN_METADATA_SCHEMA_VERSION}`);
  }
  if (
    typeof descriptor.fileName !== 'string' ||
    path.basename(descriptor.fileName) !== descriptor.fileName ||
    descriptor.fileName !== makeHostToolchainMetadataFileName(descriptor.sha256)
  ) {
    fail(`${label}.fileName does not equal its content-addressed host-toolchain metadata name`);
  }
  return descriptor;
}

function validateHostToolchainMetadataManifest(manifest, manifestSetId, label) {
  assertExactKeys(
    manifest,
    ['classification', 'hostToolchain', 'manifestSetId', 'schemaVersion'],
    label,
  );
  if (
    manifest.classification !== HOST_TOOLCHAIN_METADATA_CLASSIFICATION ||
    manifest.schemaVersion !== HOST_TOOLCHAIN_METADATA_SCHEMA_VERSION ||
    manifest.manifestSetId !== manifestSetId
  ) {
    fail(`${label} does not equal the root-bound host-toolchain metadata identity`);
  }
  assertPlainObject(manifest.hostToolchain, `${label}.hostToolchain`);
  if (CX004_PRODUCTION_MANIFEST_SET_ID_PATTERN.test(manifestSetId)) {
    validateCx004HostToolchain(manifest.hostToolchain, label);
  }
  return manifest.hostToolchain;
}

function makeShard(manifestSetId, surfaceId, files, shardIndex, shardCount) {
  return {
    classification: SHARD_CLASSIFICATION,
    files,
    manifestSetId,
    schemaVersion: SHARD_SCHEMA_VERSION,
    shardCount,
    shardIndex,
    surfaceId,
  };
}

function shardFits(manifestSetId, surfaceId, files, limits) {
  try {
    const worstIndex = limits.maxAuxiliaryManifests - 1;
    const shard = makeShard(
      manifestSetId,
      surfaceId,
      files,
      worstIndex,
      limits.maxAuxiliaryManifests,
    );
    const bytes = canonicalJsonBytes(shard);
    assertManifestBounds(shard, bytes, `prospective ${surfaceId} shard`, limits);
    return true;
  } catch {
    return false;
  }
}

function partitionSurfaceFiles(manifestSetId, surface, limits) {
  const partitions = [];
  let current = [];
  for (const file of surface.files) {
    const candidate = [...current, file];
    const fitsEntryCount = candidate.length <= limits.maxFilesPerShard;
    if (fitsEntryCount && shardFits(manifestSetId, surface.surfaceId, candidate, limits)) {
      current = candidate;
      continue;
    }
    if (current.length === 0) {
      fail(`surface ${surface.surfaceId} file ${JSON.stringify(file[0])} cannot fit in one bounded shard`);
    }
    partitions.push(current);
    current = [file];
    if (!shardFits(manifestSetId, surface.surfaceId, current, limits)) {
      fail(`surface ${surface.surfaceId} file ${JSON.stringify(file[0])} cannot fit in one bounded shard`);
    }
  }
  if (current.length !== 0) {
    partitions.push(current);
  }
  return partitions;
}

function validateSurfaceInput(surface, label) {
  assertAllowedKeys(
    surface,
    ['byteLength', 'fileCount', 'files', 'surfaceId', 'surfaceSha256'],
    ['files', 'surfaceId'],
    label,
  );
  assertSurfaceId(surface.surfaceId, `${label}.surfaceId`);
  assertSortedUniqueFiles(surface.files, `${label}.files`);
  const actual = summarizeFiles(surface.files);
  for (const key of ['byteLength', 'fileCount', 'surfaceSha256']) {
    if (Object.hasOwn(surface, key) && surface[key] !== actual[key]) {
      fail(`${label}.${key} does not equal its file tuples`);
    }
  }
  return { files: surface.files, surfaceId: surface.surfaceId, ...actual };
}

export function buildManifestSet({ manifestSetId, rootMetadata, surfaces }, options = {}) {
  const limits = effectiveLimits(options);
  assertManifestSetId(manifestSetId);
  assertRootMetadata(rootMetadata, 'root metadata', { manifestSetId });
  const compactedRootMetadata = compactRootMetadata(rootMetadata);
  assertCompactedRootMetadata(compactedRootMetadata, 'root metadata', { manifestSetId });
  if (!Array.isArray(surfaces) || surfaces.length === 0) {
    fail('surfaces must be a non-empty array');
  }
  const normalizedSurfaces = surfaces
    .map((surface, index) => validateSurfaceInput(surface, `surfaces[${index}]`))
    .sort((left, right) => ordinalCompare(left.surfaceId, right.surfaceId));
  for (let index = 1; index < normalizedSurfaces.length; index += 1) {
    if (normalizedSurfaces[index - 1].surfaceId === normalizedSurfaces[index].surfaceId) {
      fail(`duplicate surfaceId ${JSON.stringify(normalizedSurfaces[index].surfaceId)}`);
    }
  }

  const hostToolchainMetadata = makeHostToolchainMetadataManifest(
    manifestSetId,
    compactedRootMetadata.hostToolchain,
  );
  const hostToolchainMetadataBytes = canonicalJsonBytes(hostToolchainMetadata);
  assertManifestBounds(
    hostToolchainMetadata,
    hostToolchainMetadataBytes,
    'host-toolchain metadata manifest',
    limits,
  );
  assertPrivacySafe(
    hostToolchainMetadata,
    options.forbiddenSubstrings ?? [],
    'host-toolchain metadata manifest',
  );
  const hostToolchainMetadataSha256 = sha256Bytes(hostToolchainMetadataBytes);
  const hostToolchainMetadataFileName = makeHostToolchainMetadataFileName(
    hostToolchainMetadataSha256,
  );
  const serializedRootMetadata = {
    ...compactedRootMetadata,
    hostToolchain: validateHostToolchainMetadataDescriptor({
      byteLength: hostToolchainMetadataBytes.length,
      fileName: hostToolchainMetadataFileName,
      schemaVersion: HOST_TOOLCHAIN_METADATA_SCHEMA_VERSION,
      sha256: hostToolchainMetadataSha256,
    }, 'root metadata.hostToolchain'),
  };
  const auxiliaryManifests = [];
  const outputFiles = new Map([[
    hostToolchainMetadataFileName,
    hostToolchainMetadataBytes,
  ]]);
  const surfaceSummaries = [];
  for (const surface of normalizedSurfaces) {
    const partitions = partitionSurfaceFiles(manifestSetId, surface, limits);
    if (auxiliaryManifests.length + partitions.length + 1 > limits.maxAuxiliaryManifests) {
      fail(`manifest set requires more than ${limits.maxAuxiliaryManifests} auxiliary manifests`);
    }
    for (const [shardIndex, files] of partitions.entries()) {
      const shard = makeShard(manifestSetId, surface.surfaceId, files, shardIndex, partitions.length);
      const bytes = canonicalJsonBytes(shard);
      assertManifestBounds(shard, bytes, `shard ${surface.surfaceId}[${shardIndex}]`, limits);
      const shardSha256 = sha256Bytes(bytes);
      const fileName = makeShardFileName(surface.surfaceId, shardIndex, shardSha256);
      outputFiles.set(fileName, bytes);
      auxiliaryManifests.push([
        bytes.length,
        fileName,
        shardSha256,
        surface.surfaceId,
      ]);
    }
    surfaceSummaries.push([
      surface.byteLength,
      surface.fileCount,
      partitions.length,
      surface.surfaceId,
      surface.surfaceSha256,
    ]);
  }
  auxiliaryManifests.sort((left, right) => ordinalCompare(left[1], right[1]));
  const root = {
    ...serializedRootMetadata,
    auxiliaryManifests: { fields: AUXILIARY_FIELDS, rows: auxiliaryManifests },
    canonicalEncoding: CANONICAL_ENCODING,
    classification: ROOT_CLASSIFICATION,
    manifestSetId,
    schemaVersion: ROOT_SCHEMA_VERSION,
    surfaces: { fields: SURFACE_FIELDS, rows: surfaceSummaries },
  };
  assertExactKeys(root, ROOT_KEYS, 'root manifest');
  assertPrivacySafe(root, options.forbiddenSubstrings ?? [], 'root manifest');
  for (const [fileName, bytes] of outputFiles) {
    if (fileName === hostToolchainMetadataFileName) continue;
    const shard = decodeCanonicalJsonBytes(bytes, fileName, limits);
    assertPrivacySafe(shard, options.forbiddenSubstrings ?? [], fileName);
  }
  const rootBytes = canonicalJsonBytes(root);
  assertManifestBounds(root, rootBytes, 'root manifest', limits);
  outputFiles.set(ROOT_FILE_NAME, rootBytes);
  return {
    files: outputFiles,
    limits,
    root,
    rootBytes,
    rootFileName: ROOT_FILE_NAME,
    rootSha256: sha256Bytes(rootBytes),
  };
}

function assertCanonicalEncoding(value) {
  assertExactKeys(value, Object.keys(CANONICAL_ENCODING), 'root.canonicalEncoding');
  for (const [key, expected] of Object.entries(CANONICAL_ENCODING)) {
    if (value[key] !== expected) {
      fail(`root.canonicalEncoding.${key} must equal ${JSON.stringify(expected)}`);
    }
  }
}

function validateFixedRowSet(value, expectedFields, label) {
  assertExactKeys(value, FIXED_ROW_SET_KEYS, label);
  if (
    !Array.isArray(value.fields) ||
    value.fields.length !== expectedFields.length ||
    value.fields.some((field, index) => field !== expectedFields[index])
  ) {
    fail(`${label}.fields must equal [${expectedFields.join(', ')}]`);
  }
  if (!Array.isArray(value.rows) || value.rows.length === 0) {
    fail(`${label}.rows must be a non-empty array`);
  }
  for (const [index, row] of value.rows.entries()) {
    if (!Array.isArray(row) || row.length !== expectedFields.length) {
      fail(`${label}.rows[${index}] must contain exactly ${expectedFields.length} fields`);
    }
  }
}

function validateRootManifest(root, limits) {
  assertExactKeys(root, ROOT_KEYS, 'root manifest');
  if (root.schemaVersion !== ROOT_SCHEMA_VERSION) {
    fail(`root.schemaVersion must equal ${ROOT_SCHEMA_VERSION}`);
  }
  if (root.classification !== ROOT_CLASSIFICATION) {
    fail(`root.classification must equal ${ROOT_CLASSIFICATION}`);
  }
  assertManifestSetId(root.manifestSetId, 'root.manifestSetId');
  assertCanonicalEncoding(root.canonicalEncoding);
  const serializedMetadata = Object.fromEntries(
    ROOT_METADATA_KEYS.map((key) => [key, root[key]]),
  );
  const hostToolchainDescriptor = validateHostToolchainMetadataDescriptor(
    serializedMetadata.hostToolchain,
    'root metadata.hostToolchain',
  );
  assertCompactedRootMetadata(
    { ...serializedMetadata, hostToolchain: {} },
    'root metadata',
    { manifestSetId: root.manifestSetId },
  );
  validateFixedRowSet(root.auxiliaryManifests, AUXILIARY_FIELDS, 'root.auxiliaryManifests');
  if (root.auxiliaryManifests.rows.length + 1 > limits.maxAuxiliaryManifests) {
    fail(`root auxiliary manifest count exceeds ${limits.maxAuxiliaryManifests}`);
  }
  for (const [index, auxiliary] of root.auxiliaryManifests.rows.entries()) {
    assertPositiveSafeInteger(auxiliary[0], `root.auxiliaryManifests.rows[${index}][0]`);
    if (
      typeof auxiliary[1] !== 'string' ||
      !auxiliary[1].startsWith(SHARD_FILE_PREFIX) ||
      !auxiliary[1].endsWith('.json') ||
      path.basename(auxiliary[1]) !== auxiliary[1]
    ) {
      fail(`root.auxiliaryManifests.rows[${index}][1] is not a closed shard filename`);
    }
    assertSha256(auxiliary[2], `root.auxiliaryManifests.rows[${index}][2]`);
    assertSurfaceId(auxiliary[3], `root.auxiliaryManifests.rows[${index}][3]`);
    if (
      index > 0 &&
      ordinalCompare(root.auxiliaryManifests.rows[index - 1][1], auxiliary[1]) >= 0
    ) {
      fail('root.auxiliaryManifests must be strictly filename-sorted and unique');
    }
  }
  validateFixedRowSet(root.surfaces, SURFACE_FIELDS, 'root.surfaces');
  for (const [index, surface] of root.surfaces.rows.entries()) {
    assertNonNegativeSafeInteger(surface[0], `root.surfaces.rows[${index}][0]`);
    assertPositiveSafeInteger(surface[1], `root.surfaces.rows[${index}][1]`);
    assertPositiveSafeInteger(surface[2], `root.surfaces.rows[${index}][2]`);
    assertSurfaceId(surface[3], `root.surfaces.rows[${index}][3]`);
    assertSha256(surface[4], `root.surfaces.rows[${index}][4]`);
    if (index > 0 && ordinalCompare(root.surfaces.rows[index - 1][3], surface[3]) >= 0) {
      fail('root.surfaces must be strictly surfaceId-sorted and unique');
    }
  }
  return hostToolchainDescriptor;
}

function decodeAuxiliaryRows(root) {
  return root.auxiliaryManifests.rows.map((row) => ({
    byteLength: row[0],
    fileName: row[1],
    sha256: row[2],
    surfaceId: row[3],
  }));
}

function decodeSurfaceRows(root) {
  return root.surfaces.rows.map((row) => ({
    byteLength: row[0],
    fileCount: row[1],
    shardCount: row[2],
    surfaceId: row[3],
    surfaceSha256: row[4],
  }));
}

function validateShardManifest(shard, label, limits) {
  assertExactKeys(shard, SHARD_KEYS, label);
  if (shard.schemaVersion !== SHARD_SCHEMA_VERSION) {
    fail(`${label}.schemaVersion must equal ${SHARD_SCHEMA_VERSION}`);
  }
  if (shard.classification !== SHARD_CLASSIFICATION) {
    fail(`${label}.classification must equal ${SHARD_CLASSIFICATION}`);
  }
  assertManifestSetId(shard.manifestSetId, `${label}.manifestSetId`);
  assertSurfaceId(shard.surfaceId, `${label}.surfaceId`);
  assertPositiveSafeInteger(shard.shardCount, `${label}.shardCount`);
  assertNonNegativeSafeInteger(shard.shardIndex, `${label}.shardIndex`);
  if (shard.shardIndex >= shard.shardCount) {
    fail(`${label}.shardIndex must be below shardCount`);
  }
  if (!Array.isArray(shard.files) || shard.files.length === 0 || shard.files.length > limits.maxFilesPerShard) {
    fail(`${label}.files must contain 1..${limits.maxFilesPerShard} tuples`);
  }
  assertSortedUniqueFiles(shard.files, `${label}.files`);
}

function validateReconstructedSurfaceClosure(surfaces, shardsBySurface) {
  const rootSurfaceIds = new Set(surfaces.map((surface) => surface.surfaceId));
  for (const surfaceId of shardsBySurface.keys()) {
    if (!rootSurfaceIds.has(surfaceId)) {
      fail(`auxiliary manifests contain unlisted surface ${JSON.stringify(surfaceId)}`);
    }
  }
  for (const surface of surfaces) {
    const group = (shardsBySurface.get(surface.surfaceId) ?? [])
      .sort((left, right) => left.shard.shardIndex - right.shard.shardIndex);
    if (group.length !== surface.shardCount) {
      fail(`surface ${surface.surfaceId} shardCount does not equal referenced shards`);
    }
    const files = [];
    for (const [index, entry] of group.entries()) {
      if (entry.shard.shardIndex !== index || entry.shard.shardCount !== group.length) {
        fail(`surface ${surface.surfaceId} shard indices/counts are not a closed 0-based sequence`);
      }
      files.push(...entry.shard.files);
    }
    assertSortedUniqueFiles(files, `surface ${surface.surfaceId} reconstructed files`);
    const summary = summarizeFiles(files);
    for (const key of ['byteLength', 'fileCount', 'surfaceSha256']) {
      if (summary[key] !== surface[key]) {
        fail(`surface ${surface.surfaceId}.${key} does not equal reconstructed shard closure`);
      }
    }
  }
}

async function lstatIfPresent(filePath) {
  try {
    return await lstat(filePath, { bigint: true });
  } catch (error) {
    if (error?.code === 'ENOENT') {
      return null;
    }
    throw error;
  }
}

export async function verifyManifestSet({
  forbiddenSubstrings = [],
  limits: limitOverrides = {},
  rootPath,
}) {
  if (path.basename(rootPath) !== ROOT_FILE_NAME) {
    fail(`root manifest filename must be exactly ${ROOT_FILE_NAME}`);
  }
  const limits = effectiveLimits(limitOverrides);
  const rootBytes = await readStableBoundedFile(
    rootPath,
    ROOT_FILE_NAME,
    limits.maxManifestBytes,
  );
  const root = decodeCanonicalJsonBytes(rootBytes, ROOT_FILE_NAME, limits);
  const hostToolchainDescriptor = validateRootManifest(root, limits);
  assertPrivacySafe(root, forbiddenSubstrings, ROOT_FILE_NAME);
  const directory = path.dirname(rootPath);
  if (hostToolchainDescriptor.byteLength > limits.maxManifestBytes) {
    fail(
      `${hostToolchainDescriptor.fileName} declared byte length exceeds ` +
      `${limits.maxManifestBytes}`,
    );
  }
  const hostToolchainMetadataPath = path.join(
    directory,
    hostToolchainDescriptor.fileName,
  );
  const hostToolchainMetadataStats = await lstatIfPresent(hostToolchainMetadataPath);
  if (hostToolchainMetadataStats === null) {
    fail('root-bound host-toolchain metadata manifest is missing');
  }
  if (!hostToolchainMetadataStats.isFile() || hostToolchainMetadataStats.isSymbolicLink()) {
    fail('root-bound host-toolchain metadata manifest is not a regular file');
  }
  const hostToolchainMetadataBytes = await readStableBoundedFile(
    hostToolchainMetadataPath,
    hostToolchainDescriptor.fileName,
    limits.maxManifestBytes,
  );
  if (hostToolchainMetadataBytes.length !== hostToolchainDescriptor.byteLength) {
    fail(`${hostToolchainDescriptor.fileName} byte length does not equal its root reference`);
  }
  if (sha256Bytes(hostToolchainMetadataBytes) !== hostToolchainDescriptor.sha256) {
    fail(`${hostToolchainDescriptor.fileName} SHA-256 does not equal its root reference`);
  }
  const hostToolchainMetadata = decodeCanonicalJsonBytes(
    hostToolchainMetadataBytes,
    hostToolchainDescriptor.fileName,
    limits,
  );
  const hydratedHostToolchain = validateHostToolchainMetadataManifest(
    hostToolchainMetadata,
    root.manifestSetId,
    hostToolchainDescriptor.fileName,
  );
  assertPrivacySafe(
    hostToolchainMetadata,
    forbiddenSubstrings,
    hostToolchainDescriptor.fileName,
  );
  assertCompactedRootMetadata({
    ...Object.fromEntries(ROOT_METADATA_KEYS.map((key) => [key, root[key]])),
    hostToolchain: hydratedHostToolchain,
  }, 'hydrated root metadata', { manifestSetId: root.manifestSetId });
  const auxiliaryManifests = decodeAuxiliaryRows(root);
  const surfaces = decodeSurfaceRows(root);

  const referencedNames = new Set(auxiliaryManifests.map((entry) => entry.fileName));
  const directoryEntries = await readdir(directory, { withFileTypes: true });
  const actualShardNames = directoryEntries
    .filter((entry) => entry.name.startsWith(SHARD_FILE_PREFIX) && entry.name.endsWith('.json'))
    .map((entry) => entry.name)
    .sort(ordinalCompare);
  for (const entry of directoryEntries) {
    const isAuxiliaryCandidate =
      (
        entry.name.startsWith(SHARD_FILE_PREFIX) ||
        entry.name.startsWith(HOST_TOOLCHAIN_METADATA_FILE_PREFIX)
      ) && entry.name.endsWith('.json');
    if (isAuxiliaryCandidate && !entry.isFile()) {
      fail(`auxiliary manifest candidate ${JSON.stringify(entry.name)} is not a regular file`);
    }
  }
  const actualShardNameSet = new Set(actualShardNames);
  const expectedShardNames = [...referencedNames].sort(ordinalCompare);
  if (expectedShardNames.some((name) => !actualShardNameSet.has(name))) {
    fail('auxiliary manifest directory closure has a missing referenced shard file');
  }

  const shardsBySurface = new Map();
  for (const auxiliary of auxiliaryManifests) {
    const shardPath = path.join(directory, auxiliary.fileName);
    if (auxiliary.byteLength > limits.maxManifestBytes) {
      fail(`${auxiliary.fileName} declared byte length exceeds ${limits.maxManifestBytes}`);
    }
    const shardBytes = await readStableBoundedFile(
      shardPath,
      auxiliary.fileName,
      limits.maxManifestBytes,
    );
    if (shardBytes.length !== auxiliary.byteLength) {
      fail(`${auxiliary.fileName} byte length does not equal its root reference`);
    }
    if (sha256Bytes(shardBytes) !== auxiliary.sha256) {
      fail(`${auxiliary.fileName} SHA-256 does not equal its root reference`);
    }
    const shard = decodeCanonicalJsonBytes(shardBytes, auxiliary.fileName, limits);
    validateShardManifest(shard, auxiliary.fileName, limits);
    assertPrivacySafe(shard, forbiddenSubstrings, auxiliary.fileName);
    if (shard.manifestSetId !== root.manifestSetId) {
      fail(`${auxiliary.fileName} manifestSetId does not equal the root`);
    }
    if (shard.surfaceId !== auxiliary.surfaceId) {
      fail(`${auxiliary.fileName} surfaceId does not equal its root reference`);
    }
    if (makeShardFileName(shard.surfaceId, shard.shardIndex, auxiliary.sha256) !== auxiliary.fileName) {
      fail(`${auxiliary.fileName} does not equal its canonical surface/index filename`);
    }
    const group = shardsBySurface.get(shard.surfaceId) ?? [];
    group.push({ auxiliary, shard });
    shardsBySurface.set(shard.surfaceId, group);
  }

  validateReconstructedSurfaceClosure(surfaces, shardsBySurface);

  return {
    auxiliaryManifestCount: auxiliaryManifests.length,
    hostToolchainMetadataManifestCount: 1,
    manifestSetId: root.manifestSetId,
    rootByteLength: rootBytes.length,
    rootFileName: ROOT_FILE_NAME,
    rootSha256: sha256Bytes(rootBytes),
    surfaceCount: surfaces.length,
    totalAuxiliaryManifestCount: auxiliaryManifests.length + 1,
  };
}

function validateManifestSetForPublication(manifestSet, forbiddenSubstrings) {
  assertExactKeys(
    manifestSet,
    ['files', 'limits', 'root', 'rootBytes', 'rootFileName', 'rootSha256'],
    'manifest set publication input',
  );
  if (!(manifestSet.files instanceof Map)) {
    fail('manifest set publication files must be a Map');
  }
  assertExactKeys(
    manifestSet.limits,
    ['maxAuxiliaryManifests', 'maxFilesPerShard', 'maxManifestBytes', 'maxManifestMembers'],
    'manifest set publication limits',
  );
  const limits = effectiveLimits(manifestSet.limits);
  if (manifestSet.rootFileName !== ROOT_FILE_NAME) {
    fail(`manifest set publication rootFileName must equal ${ROOT_FILE_NAME}`);
  }
  const actualNames = [];
  for (const [name, bytes] of manifestSet.files) {
    if (
      typeof name !== 'string' ||
      name.length === 0 ||
      path.basename(name) !== name ||
      !name.endsWith('.json')
    ) {
      fail(`manifest set publication contains unsafe filename ${JSON.stringify(name)}`);
    }
    if (!Buffer.isBuffer(bytes)) {
      fail(`manifest set publication ${name} bytes must be a Buffer`);
    }
    actualNames.push(name);
  }
  actualNames.sort(ordinalCompare);

  const rootBytes = manifestSet.files.get(ROOT_FILE_NAME);
  if (rootBytes === undefined) {
    fail(`manifest set publication does not contain ${ROOT_FILE_NAME}`);
  }
  const root = decodeCanonicalJsonBytes(rootBytes, ROOT_FILE_NAME, limits);
  const hostToolchainDescriptor = validateRootManifest(root, limits);
  assertCanonicalValueEqual(manifestSet.root, root, 'manifest set publication root object');
  if (!Buffer.isBuffer(manifestSet.rootBytes) || !manifestSet.rootBytes.equals(rootBytes)) {
    fail('manifest set publication rootBytes do not equal the root file bytes');
  }
  if (manifestSet.rootSha256 !== sha256Bytes(rootBytes)) {
    fail('manifest set publication rootSha256 does not equal the root file bytes');
  }
  assertPrivacySafe(root, forbiddenSubstrings, ROOT_FILE_NAME);

  const auxiliaryManifests = decodeAuxiliaryRows(root);
  const surfaces = decodeSurfaceRows(root);
  const expectedNames = [
    ROOT_FILE_NAME,
    hostToolchainDescriptor.fileName,
    ...auxiliaryManifests.map((entry) => entry.fileName),
  ].sort(ordinalCompare);
  if (
    actualNames.length !== expectedNames.length ||
    actualNames.some((name, index) => name !== expectedNames[index])
  ) {
    fail('manifest set publication files do not equal the exact root-referenced closure');
  }

  const hostToolchainBytes = manifestSet.files.get(hostToolchainDescriptor.fileName);
  if (
    hostToolchainBytes.length !== hostToolchainDescriptor.byteLength ||
    sha256Bytes(hostToolchainBytes) !== hostToolchainDescriptor.sha256
  ) {
    fail('manifest set publication host-toolchain bytes do not equal the root descriptor');
  }
  const hostToolchainMetadata = decodeCanonicalJsonBytes(
    hostToolchainBytes,
    hostToolchainDescriptor.fileName,
    limits,
  );
  validateHostToolchainMetadataManifest(
    hostToolchainMetadata,
    root.manifestSetId,
    hostToolchainDescriptor.fileName,
  );
  assertPrivacySafe(
    hostToolchainMetadata,
    forbiddenSubstrings,
    hostToolchainDescriptor.fileName,
  );

  const shardsBySurface = new Map();
  for (const auxiliary of auxiliaryManifests) {
    const shardBytes = manifestSet.files.get(auxiliary.fileName);
    if (
      shardBytes.length !== auxiliary.byteLength ||
      sha256Bytes(shardBytes) !== auxiliary.sha256
    ) {
      fail(`manifest set publication ${auxiliary.fileName} bytes do not equal the root reference`);
    }
    const shard = decodeCanonicalJsonBytes(shardBytes, auxiliary.fileName, limits);
    validateShardManifest(shard, auxiliary.fileName, limits);
    if (
      shard.manifestSetId !== root.manifestSetId ||
      shard.surfaceId !== auxiliary.surfaceId ||
      makeShardFileName(shard.surfaceId, shard.shardIndex, auxiliary.sha256) !== auxiliary.fileName
    ) {
      fail(`manifest set publication ${auxiliary.fileName} identity does not equal the root reference`);
    }
    assertPrivacySafe(shard, forbiddenSubstrings, auxiliary.fileName);
    const group = shardsBySurface.get(shard.surfaceId) ?? [];
    group.push({ auxiliary, shard });
    shardsBySurface.set(shard.surfaceId, group);
  }
  validateReconstructedSurfaceClosure(surfaces, shardsBySurface);
  return limits;
}

async function assertWritableManifestDirectory(directory) {
  await mkdir(directory, { recursive: true });
  await assertDirectoryPath(directory, 'manifest output directory');
}

async function replaceRegularFileAtomically(filePath, bytes) {
  const directory = path.dirname(filePath);
  const tempPath = path.join(directory, `.${path.basename(filePath)}.${process.pid}.tmp`);
  const existingTemp = await lstatIfPresent(tempPath);
  if (existingTemp !== null) {
    if (!existingTemp.isFile() || existingTemp.isSymbolicLink()) {
      fail(`refusing to replace unsafe temporary path ${tempPath}`);
    }
    await unlink(tempPath);
  }
  await writeFile(tempPath, bytes, { flag: 'wx' });
  try {
    const existing = await lstatIfPresent(filePath);
    if (existing !== null) {
      if (!existing.isFile() || existing.isSymbolicLink()) {
        fail(`refusing to replace non-regular manifest path ${filePath}`);
      }
    }
    await rename(tempPath, filePath);
  } finally {
    await rm(tempPath, { force: true });
  }
}

export async function writeManifestSet(manifestSet, outputDirectory, options = {}) {
  const forbiddenSubstrings = options.forbiddenSubstrings ?? [];
  const limits = validateManifestSetForPublication(manifestSet, forbiddenSubstrings);
  const directory = path.resolve(outputDirectory);
  await assertWritableManifestDirectory(directory);
  const targetNames = new Set(manifestSet.files.keys());
  if (!targetNames.has(ROOT_FILE_NAME)) {
    fail(`manifest set does not contain ${ROOT_FILE_NAME}`);
  }
  const auxiliaryNames = [...targetNames]
    .filter((name) => name !== ROOT_FILE_NAME)
    .sort(ordinalCompare);
  for (const name of auxiliaryNames) {
    const auxiliaryPath = path.join(directory, name);
    const existing = await lstatIfPresent(auxiliaryPath);
    if (existing === null) {
      await replaceRegularFileAtomically(auxiliaryPath, manifestSet.files.get(name));
      continue;
    }
    if (!existing.isFile() || existing.isSymbolicLink()) {
      fail(`refusing to reuse non-regular content-addressed auxiliary manifest ${auxiliaryPath}`);
    }
    const existingBytes = await readStableBoundedFile(
      auxiliaryPath,
      name,
      limits.maxManifestBytes,
    );
    if (!existingBytes.equals(manifestSet.files.get(name))) {
      fail(`content-addressed auxiliary manifest ${name} exists with different bytes`);
    }
  }
  await replaceRegularFileAtomically(
    path.join(directory, ROOT_FILE_NAME),
    manifestSet.files.get(ROOT_FILE_NAME),
  );
  const publishedEntries = await readdir(directory, { withFileTypes: true });
  for (const entry of publishedEntries) {
    if (
      (
        entry.name.startsWith(SHARD_FILE_PREFIX) ||
        entry.name.startsWith(HOST_TOOLCHAIN_METADATA_FILE_PREFIX)
      ) &&
      entry.name.endsWith('.json') &&
      !targetNames.has(entry.name)
    ) {
      const stalePath = path.join(directory, entry.name);
      const stats = await lstat(stalePath, { bigint: true });
      if (!stats.isFile() || stats.isSymbolicLink()) {
        fail(`refusing to remove non-regular stale auxiliary manifest ${stalePath}`);
      }
      await unlink(stalePath);
    }
  }
  return verifyManifestSet({
    forbiddenSubstrings,
    limits,
    rootPath: path.join(directory, ROOT_FILE_NAME),
  });
}

export async function assertManifestSetMatchesDisk(manifestSet, outputDirectory, options = {}) {
  const directory = path.resolve(outputDirectory);
  const receipt = await verifyManifestSet({
    forbiddenSubstrings: options.forbiddenSubstrings ?? [],
    limits: manifestSet.limits,
    rootPath: path.join(directory, ROOT_FILE_NAME),
  });
  for (const [name, expectedBytes] of manifestSet.files) {
    const actualBytes = await readFile(path.join(directory, name));
    if (!actualBytes.equals(expectedBytes)) {
      fail(`${name} does not byte-equal the regenerated manifest set`);
    }
  }
  return receipt;
}

function inspectDeclarativeJson(text, label) {
  let index = 0;
  let members = 0;
  const skipWhitespace = () => {
    while (index < text.length && /[\u0009\u000a\u000d\u0020]/u.test(text[index])) {
      index += 1;
    }
  };
  const parseString = () => {
    if (text[index] !== '"') {
      fail(`${label} expected a JSON string at character ${index}`);
    }
    const start = index;
    index += 1;
    while (index < text.length) {
      const character = text[index];
      if (character === '"') {
        index += 1;
        const raw = text.slice(start, index);
        try {
          return JSON.parse(raw);
        } catch (error) {
          fail(`${label} has an invalid JSON string at character ${start}: ${error.message}`);
        }
      }
      if (character === '\\') {
        index += 2;
        continue;
      }
      if (character.charCodeAt(0) < 0x20) {
        fail(`${label} has an unescaped control character at character ${index}`);
      }
      index += 1;
    }
    fail(`${label} has an unterminated JSON string at character ${start}`);
  };
  const addMember = () => {
    members += 1;
    if (members > MAX_CONFIG_MEMBERS) {
      fail(`${label} exceeds ${MAX_CONFIG_MEMBERS} JSON members`);
    }
  };
  const parseValue = (depth) => {
    if (depth > MAX_CONFIG_DEPTH) {
      fail(`${label} exceeds JSON nesting depth ${MAX_CONFIG_DEPTH}`);
    }
    skipWhitespace();
    const character = text[index];
    if (character === '{') {
      index += 1;
      skipWhitespace();
      const keys = new Set();
      if (text[index] === '}') {
        index += 1;
        return;
      }
      while (index < text.length) {
        skipWhitespace();
        const key = parseString();
        if (keys.has(key)) {
          fail(`${label} contains duplicate object key ${JSON.stringify(key)}`);
        }
        keys.add(key);
        addMember();
        skipWhitespace();
        if (text[index] !== ':') {
          fail(`${label} expected ':' after object key at character ${index}`);
        }
        index += 1;
        parseValue(depth + 1);
        skipWhitespace();
        if (text[index] === '}') {
          index += 1;
          return;
        }
        if (text[index] !== ',') {
          fail(`${label} expected ',' or '}' at character ${index}`);
        }
        index += 1;
      }
      fail(`${label} has an unterminated JSON object`);
    }
    if (character === '[') {
      index += 1;
      skipWhitespace();
      if (text[index] === ']') {
        index += 1;
        return;
      }
      while (index < text.length) {
        addMember();
        parseValue(depth + 1);
        skipWhitespace();
        if (text[index] === ']') {
          index += 1;
          return;
        }
        if (text[index] !== ',') {
          fail(`${label} expected ',' or ']' at character ${index}`);
        }
        index += 1;
      }
      fail(`${label} has an unterminated JSON array`);
    }
    if (character === '"') {
      parseString();
      return;
    }
    const remaining = text.slice(index);
    const primitive = /^(?:true|false|null|-?(?:0|[1-9][0-9]*)(?:\.[0-9]+)?(?:[eE][+-]?[0-9]+)?)/u.exec(remaining);
    if (primitive === null) {
      fail(`${label} has an invalid JSON value at character ${index}`);
    }
    index += primitive[0].length;
  };
  skipWhitespace();
  parseValue(0);
  skipWhitespace();
  if (index !== text.length) {
    fail(`${label} has trailing content at character ${index}`);
  }
}

function decodeDeclarativeJson(bytes, label) {
  if (bytes.length === 0 || bytes.length > MAX_CONFIG_BYTES) {
    fail(`${label} byte length must be within 1..${MAX_CONFIG_BYTES}`);
  }
  if (bytes.includes(0x00)) {
    fail(`${label} contains a NUL byte`);
  }
  if (bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) {
    fail(`${label} must not have a UTF-8 BOM`);
  }
  let text;
  try {
    text = UTF8.decode(bytes);
  } catch (error) {
    fail(`${label} is not valid UTF-8: ${error.message}`);
  }
  inspectDeclarativeJson(text, label);
  try {
    return JSON.parse(text);
  } catch (error) {
    fail(`${label} is not valid JSON: ${error.message}`);
  }
}

function readAllowedLocationEnvironment(name, label) {
  assertUnicodeScalarString(name, `${label}.env`);
  const canonicalName = LOCATION_ENVIRONMENT_ALLOWLIST.get(name.toLocaleLowerCase('en-US'));
  if (canonicalName === undefined) {
    fail(`${label}.env is not in the closed noncredential location allowlist`);
  }
  const environmentKey = Object.keys(process.env).find(
    (key) => key.toLocaleLowerCase('en-US') === canonicalName.toLocaleLowerCase('en-US'),
  );
  const value = environmentKey === undefined ? undefined : process.env[environmentKey];
  if (!value) {
    fail(`${label}.env ${JSON.stringify(canonicalName)} is unavailable`);
  }
  return value;
}

function expandLocationSpec(spec, configDirectory, label) {
  if (typeof spec === 'string') {
    assertUnicodeScalarString(spec, label);
    if (spec.length === 0 || spec.includes('\0')) {
      fail(`${label} must be a non-empty filesystem location without NUL`);
    }
    const environmentMatch = /^%([^%]+)%(?:[\\/](.*))?$/u.exec(spec);
    if (environmentMatch !== null) {
      const base = readAllowedLocationEnvironment(environmentMatch[1], label);
      const relativeRoot = (environmentMatch[2] ?? '').replaceAll('\\', '/');
      validateLogicalPath(relativeRoot, `${label} environment-relative path`, { allowEmpty: true });
      return relativeRoot === '' ? path.resolve(base) : path.resolve(base, ...relativeRoot.split('/'));
    }
    if (spec.includes('%')) {
      fail(`${label} contains an unsupported environment expansion`);
    }
    return path.resolve(configDirectory, spec);
  }
  assertExactKeys(spec, ['env', 'relativeRoot'], label);
  const base = readAllowedLocationEnvironment(spec.env, label);
  validateLogicalPath(spec.relativeRoot, `${label}.relativeRoot`, { allowEmpty: true });
  return spec.relativeRoot === ''
    ? path.resolve(base)
    : path.resolve(base, ...spec.relativeRoot.split('/'));
}

function validateLocationMap(value, configDirectory, overrides) {
  const locations = {};
  const input = value ?? {};
  assertPlainObject(input, 'config.locations');
  for (const [locationId, locationSpec] of Object.entries(input)) {
    assertSurfaceId(locationId, `config.locations key ${JSON.stringify(locationId)}`);
    locations[locationId] = expandLocationSpec(
      locationSpec,
      configDirectory,
      `config.locations.${locationId}`,
    );
  }
  assertPlainObject(overrides, 'location overrides');
  if (Object.keys(overrides).length !== 0) {
    fail('location overrides are forbidden for the admitted native-build-input seal');
  }
  return locations;
}

function validateConfigSurfaceShape(surface, index) {
  const label = `config.surfaces[${index}]`;
  assertAllowedKeys(
    surface,
    ['expected', 'sources', 'surfaceId'],
    ['sources', 'surfaceId'],
    label,
  );
  assertSurfaceId(surface.surfaceId, `${label}.surfaceId`);
  const pendingPresealSurface =
    surface.surfaceId === 'preseal-receipt' &&
    surface.expected === undefined &&
    Array.isArray(surface.sources) &&
    surface.sources.length === 0;
  if (
    surface.surfaceId !== 'manifest-authority' &&
    surface.expected === undefined &&
    !pendingPresealSurface
  ) {
    fail(`${label}.expected is required for every non-self surface`);
  }
  if (!Array.isArray(surface.sources) || (surface.sources.length === 0 && !pendingPresealSurface)) {
    fail(`${label}.sources must be a non-empty array`);
  }
  if (pendingPresealSurface) return;
  for (const [sourceIndex, source] of surface.sources.entries()) {
    const sourceLabel = `${label}.sources[${sourceIndex}]`;
    assertPlainObject(source, sourceLabel);
    assertAllowedKeys(source, sourceAllowedKeys(source), ['logicalPrefix', 'mode'], sourceLabel);
    if (source.mode !== 'tree' && source.mode !== 'files') {
      fail(`${sourceLabel}.mode must be exactly "tree" or "files"`);
    }
    validateLogicalPath(source.logicalPrefix, `${sourceLabel}.logicalPrefix`, { allowEmpty: true });
    if (Object.hasOwn(source, 'root') === Object.hasOwn(source, 'location')) {
      fail(`${sourceLabel} must provide exactly one of root or location`);
    }
    if (Object.hasOwn(source, 'location')) {
      assertSurfaceId(source.location, `${sourceLabel}.location`);
      validateLogicalPath(source.relativeRoot ?? '', `${sourceLabel}.relativeRoot`, { allowEmpty: true });
    } else {
      assertUnicodeScalarString(source.root, `${sourceLabel}.root`);
      if (source.root.length === 0 || source.root.includes('\0')) {
        fail(`${sourceLabel}.root must be a non-empty filesystem path without NUL`);
      }
    }
    if (source.mode === 'tree' && Object.hasOwn(source, 'files')) {
      fail(`${sourceLabel}.files is forbidden in tree mode`);
    }
    if (source.mode === 'files') {
      if (!Array.isArray(source.files) || source.files.length === 0) {
        fail(`${sourceLabel}.files must be a non-empty array in files mode`);
      }
      const validatedFiles = source.files.map((entry, fileIndex) =>
        validateLogicalPath(entry, `${sourceLabel}.files[${fileIndex}]`));
      if (new Set(validatedFiles).size !== validatedFiles.length) {
        fail(`${sourceLabel}.files must be unique`);
      }
      validateSourceIdentityPolicy(source, validatedFiles, sourceLabel, surface.surfaceId);
    } else if (source.identityPolicy !== undefined) {
      validateSourceIdentityPolicy(source, [], sourceLabel, surface.surfaceId);
    }
  }
  if (surface.expected !== undefined) {
    validateExpectedSummary(surface.expected, surface.expected, `${label}.expected`);
  }
}

function validateCx004IdentitySurfaceDefinitions(config) {
  const requireSurface = (surfaceId) => {
    const surface = config.surfaces.find((entry) => entry.surfaceId === surfaceId);
    if (surface === undefined) {
      fail(`config is missing the required ${surfaceId} identity surface`);
    }
    return surface;
  };
  const systemSurface = (surfaceId, tool, expected) => {
    const relativePaths = tool.logicalPaths.map((logicalPath, index) => {
      if (!logicalPath.startsWith('windows/')) {
        fail(`config.root.hostToolchain ${surfaceId} logicalPaths[${index}] is outside windows/`);
      }
      return logicalPath.slice('windows/'.length);
    });
    assertCanonicalValueEqual(requireSurface(surfaceId), {
      expected,
      sources: [{
        files: relativePaths,
        identityPolicy: {
          kind: 'windows-servicing-hardlink-v1',
          linkCount: 2,
          relativePaths,
        },
        location: 'system',
        logicalPrefix: 'windows',
        mode: 'files',
        relativeRoot: '',
      }],
      surfaceId,
    }, `config surface ${surfaceId}`);
  };

  const presealDescriptor = config.root.provenance.presealReceipt;
  validatePresealLifecycleDescriptor(presealDescriptor);
  validatePresealLifecycleSurface(config, presealDescriptor);
  assertCanonicalValueEqual(
    presealDescriptor.configProjection,
    presealConfigAuthorityIdentity(config),
    'root.provenance.presealReceipt.configProjection',
  );

  const git = config.root.hostToolchain.git;
  const gitSources = [{
    files: ['git.exe'],
    location: 'git',
    logicalPrefix: 'git/mingw64/libexec/git-core',
    mode: 'files',
    relativeRoot: 'mingw64/libexec/git-core',
  }];
  for (const [index, group] of git.sourceAliasGroups.entries()) {
    const relativePaths = group.logicalPaths.map((logicalPath) => {
      if (!logicalPath.startsWith('git/')) {
        fail(`config.root.hostToolchain.git.sourceAliasGroups[${index}] is outside git/`);
      }
      return logicalPath.slice('git/'.length);
    });
    gitSources.push({
      files: relativePaths,
      identityPolicy: {
        kind: group.kind,
        linkCount: group.linkCount,
        relativePaths,
      },
      location: 'git',
      logicalPrefix: 'git',
      mode: 'files',
      relativeRoot: '',
    });
  }
  assertCanonicalValueEqual(requireSurface('git-execution-closure'), {
    expected: {
      byteLength: 8949162,
      fileCount: 11,
      surfaceSha256: 'c2b3b9c75250b54c42d89ac7a4df0b765b2dbe4b645447bf242e3f9ec63ff939',
    },
    sources: gitSources,
    surfaceId: 'git-execution-closure',
  }, 'config surface git-execution-closure');
  const pnpmStore = requireSurface('pnpm-store-v10');
  if (!Array.isArray(pnpmStore.sources) || pnpmStore.sources.length !== 2) {
    fail('config surface pnpm-store-v10 must have its exact two tree sources');
  }
  for (const [index, source] of pnpmStore.sources.entries()) {
    if (source.mode !== 'tree') {
      fail(`config surface pnpm-store-v10.sources[${index}] must use tree mode`);
    }
    if (source.identityPolicy === undefined) {
      fail(`config surface pnpm-store-v10.sources[${index}].identityPolicy is required`);
    }
    assertCanonicalValueEqual(source.identityPolicy, {
      kind: 'pnpm-content-addressed-store-hardlink-v1',
    }, `config surface pnpm-store-v10.sources[${index}].identityPolicy`);
  }
  systemSurface(
    'authenticode-verification-tool',
    config.root.hostToolchain.authenticodeVerificationTool,
    {
      byteLength: 909312,
      fileCount: 2,
      surfaceSha256: '1a76de12c5df0303481b6bee128ef66ec933c781cec94cfb2a6653ee1500cb92',
    },
  );
  systemSurface(
    'process-tree-termination-tool',
    config.root.hostToolchain.processTreeTerminationTool,
    {
      byteLength: 237568,
      fileCount: 2,
      surfaceSha256: '01a616469c8e5f6dd4c5b42e67450e368d47496e5866a407fb9cf5494f687953',
    },
  );
}

export async function loadManifestConfig(configPath, options = {}) {
  const absoluteConfigPath = path.resolve(configPath);
  const configDirectory = path.dirname(absoluteConfigPath);
  const config = decodeDeclarativeJson(await readFile(absoluteConfigPath), absoluteConfigPath);
  assertAllowedKeys(
    config,
    CONFIG_KEYS,
    ['manifestSetId', 'root', 'schemaVersion', 'surfaces'],
    'config',
  );
  if (config.schemaVersion !== CONFIG_SCHEMA_VERSION) {
    fail(`config.schemaVersion must equal ${CONFIG_SCHEMA_VERSION}`);
  }
  assertManifestSetId(config.manifestSetId, 'config.manifestSetId');
  assertRootMetadata(config.root, 'config.root', {
    allowPendingPreseal: true,
    manifestSetId: config.manifestSetId,
  });
  if (!Array.isArray(config.surfaces) || config.surfaces.length === 0) {
    fail('config.surfaces must be a non-empty array');
  }
  config.surfaces.forEach(validateConfigSurfaceShape);
  if (config.root.scope.classification === 'tracked-pre-code-native-build-input-root') {
    validateCx004IdentitySurfaceDefinitions(config);
  }
  const sortedSurfaceIds = config.surfaces.map((surface) => surface.surfaceId).sort(ordinalCompare);
  for (let index = 1; index < sortedSurfaceIds.length; index += 1) {
    if (sortedSurfaceIds[index - 1] === sortedSurfaceIds[index]) {
      fail(`config has duplicate surfaceId ${JSON.stringify(sortedSurfaceIds[index])}`);
    }
  }

  const locations = validateLocationMap(config.locations, configDirectory, options.locationOverrides ?? {});
  const privacy = config.privacy ?? { forbiddenSubstrings: [] };
  assertExactKeys(privacy, ['forbiddenSubstrings'], 'config.privacy');
  const forbiddenSubstrings = normalizePrivacyTokens(privacy.forbiddenSubstrings);

  const output = config.output ?? {};
  assertAllowedKeys(output, ['directory', 'rootFileName'], [], 'config.output');
  if (output.rootFileName !== undefined && output.rootFileName !== ROOT_FILE_NAME) {
    fail(`config.output.rootFileName must equal ${ROOT_FILE_NAME}`);
  }
  const outputValue = output.directory;
  if (typeof outputValue !== 'string' || outputValue.length === 0 || outputValue.includes('\0')) {
    fail('config.output.directory must supply the admitted output directory');
  }
  const outputDirectory = path.resolve(configDirectory, outputValue);
  if (
    options.outputDirectory !== undefined &&
    path.resolve(process.cwd(), options.outputDirectory) !== outputDirectory
  ) {
    fail('output directory overrides are forbidden for the admitted native-build-input seal');
  }
  return {
    config,
    configDirectory,
    configPath: absoluteConfigPath,
    forbiddenSubstrings,
    locations,
    outputDirectory,
  };
}

function collectResolvedSourceRoots(configContext) {
  const roots = [...Object.values(configContext.locations)];
  for (const surface of configContext.config.surfaces) {
    for (const source of surface.sources) {
      roots.push(resolveSourceRoot(
        source,
        configContext.locations,
        configContext.configDirectory,
        `surface ${surface.surfaceId} source`,
      ));
    }
  }
  return roots;
}

export async function generateManifestSetFromConfig(configPath, options = {}) {
  const context = await loadManifestConfig(configPath, options);
  assertPresealPassedForGeneration(context.config);
  const privacyTokens = [
    ...context.forbiddenSubstrings,
    ...collectResolvedSourceRoots(context),
  ];
  const surfaces = [];
  const logicalFiles = new Map();
  const caseFoldedLogicalFiles = new Map();
  for (const surface of context.config.surfaces) {
    surfaces.push(await enumerateSurface(surface, {
      caseFoldedLogicalFiles,
      configDirectory: context.configDirectory,
      forbiddenSubstrings: privacyTokens,
      logicalFiles,
      locations: context.locations,
    }));
  }
  await validateRootBindings(context.config, surfaces, logicalFiles);
  await validateGenerationRunner(context.config.root, logicalFiles);
  const manifestSet = buildManifestSet({
    manifestSetId: context.config.manifestSetId,
    rootMetadata: context.config.root,
    surfaces,
  }, {
    ...options.limits,
    forbiddenSubstrings: privacyTokens,
  });
  return {
    ...context,
    forbiddenSubstrings: privacyTokens,
    manifestSet,
  };
}
