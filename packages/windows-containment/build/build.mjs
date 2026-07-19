import { spawn } from 'node:child_process';
import { constants as fsConstants } from 'node:fs';
import {
  copyFile,
  lstat,
  mkdir,
  mkdtemp,
  open,
  rm,
} from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import {
  ROOT_FILE_NAME,
  canonicalJsonBytes,
  decodeCanonicalJsonBytes,
  enumerateSurface,
  hashStableFile,
  loadManifestConfig,
  sha256Bytes,
  verifyManifestSet,
} from '../toolchain/manifest-set.mjs';
import {
  assertNativeResourceSourceGuard,
  buildArtifactResourceOwnershipManifest,
  encodeEmbeddedResourceOwnershipManifestFrame,
  loadResourceSiteRegistry,
  renderGeneratedResourceManifestHeader,
  verifyEmbeddedResourceOwnershipManifestInPe,
} from './resource-manifest.mjs';
import { verifySourceSeal } from './source-seal.mjs';

export const QUALIFICATION_ARTIFACT_MACRO = 'PCSDK_ARTIFACT_QUALIFICATION=1';
export const QUALIFICATION_MODE = 'resource-ownership';

const SCRIPT_PATH = fileURLToPath(import.meta.url);
const BUILD_DIRECTORY = path.dirname(SCRIPT_PATH);
const PACKAGE_ROOT = path.resolve(BUILD_DIRECTORY, '..');
const REPOSITORY_ROOT = path.resolve(PACKAGE_ROOT, '..', '..');
const CONFIG_PATH = path.join(PACKAGE_ROOT, 'toolchain', 'native-build-input.config.json');
const NATIVE_INPUT_ROOT_PATH = path.join(
  REPOSITORY_ROOT,
  'docs',
  'execution',
  'manifests',
  ROOT_FILE_NAME,
);
const RESOURCE_GENERATOR_PATH = path.join(BUILD_DIRECTORY, 'resource-manifest.mjs');
const QUALIFICATION_TRANSLATION_UNITS = Object.freeze([
  'packages/windows-containment/native/core/resource.cc',
  'packages/windows-containment/native/core/resource_state.cc',
  'packages/windows-containment/native/test/property/properties.cc',
  'packages/windows-containment/native/test/property/property_main.cc',
]);
const RELEASE_RECIPE_IDS = Object.freeze([
  'msvc-release-core',
  'msvc-release-bootstrap',
  'msvc-release-addon',
]);
const T1_EXCLUDED_SURFACE_ID = 'repo-precode-inputs';
const T1_AUTHORIZED_POST_T1_LOGICAL_PATHS = Object.freeze([
  'repo/.gitattributes',
  'repo/docs/current-state.md',
  'repo/docs/execution/current.md',
  'repo/docs/execution/slices/CX-004.md',
]);
const T1_SHARD_SCHEMA_VERSION = 'pc-sdk.cx-004.native-build-input-files.v1';
const DEFAULT_COMMAND_TIMEOUT_MS = 120_000;
const MAX_CAPTURE_BYTES = 1024 * 1024;
const MAX_QUALIFICATION_PE_BYTES = 16 * 1024 * 1024;
const MAX_T1_MANIFEST_BYTES = 8 * 1024 * 1024;
const MAX_STAGED_SOURCE_BYTES = 2 * 1024 * 1024;

function ordinalCompare(left, right) {
  return left < right ? -1 : left > right ? 1 : 0;
}

function fail(code, message, details) {
  const error = new Error(`${code}: ${message}`);
  error.code = code;
  if (details !== undefined) error.details = details;
  throw error;
}

function invariant(condition, code, message, details) {
  if (!condition) fail(code, message, details);
}

function repositoryPath(relativePath) {
  invariant(
    typeof relativePath === 'string'
      && relativePath.length !== 0
      && !relativePath.startsWith('/')
      && !relativePath.includes('\\')
      && !relativePath.split('/').some((segment) => segment === '' || segment === '.' || segment === '..'),
    'REPOSITORY_PATH_INVALID',
    'build authority contains a noncanonical repository path',
  );
  const candidate = path.resolve(REPOSITORY_ROOT, ...relativePath.split('/'));
  const relative = path.relative(REPOSITORY_ROOT, candidate);
  invariant(
    relative !== ''
      && relative !== '..'
      && !relative.startsWith(`..${path.sep}`)
      && !path.isAbsolute(relative),
    'REPOSITORY_PATH_ESCAPE',
    `${relativePath} resolves outside the repository`,
  );
  return candidate;
}

function environmentValue(name) {
  const key = Object.keys(process.env).find(
    (candidate) => candidate.toLocaleLowerCase('en-US') === name.toLocaleLowerCase('en-US'),
  );
  return key === undefined ? undefined : process.env[key];
}

function normalizedWindowsPath(value) {
  return path.normalize(value).toLocaleLowerCase('en-US');
}

function decodeRootSurfaces(root) {
  const expectedFields = [
    'byteLength',
    'fileCount',
    'shardCount',
    'surfaceId',
    'surfaceSha256',
  ];
  invariant(
    root?.surfaces !== null
      && typeof root?.surfaces === 'object'
      && Array.isArray(root.surfaces.fields)
      && Array.isArray(root.surfaces.rows)
      && root.surfaces.fields.length === expectedFields.length
      && root.surfaces.fields.every((field, index) => field === expectedFields[index]),
    'T1_ROOT_SURFACE_SCHEMA_MISMATCH',
    'sealed root surface table has an unexpected schema',
  );
  const surfaces = new Map();
  for (const [index, row] of root.surfaces.rows.entries()) {
    invariant(
      Array.isArray(row) && row.length === expectedFields.length,
      'T1_ROOT_SURFACE_ROW_INVALID',
      `sealed root surface row ${index} has an unexpected shape`,
    );
    const surface = Object.fromEntries(expectedFields.map((field, fieldIndex) => [field, row[fieldIndex]]));
    invariant(
      typeof surface.surfaceId === 'string' && !surfaces.has(surface.surfaceId),
      'T1_ROOT_SURFACE_DUPLICATE',
      `sealed root surface row ${index} has a duplicate or invalid id`,
    );
    surfaces.set(surface.surfaceId, surface);
  }
  return surfaces;
}

function decodeRootAuxiliaryManifests(root) {
  const expectedFields = ['byteLength', 'fileName', 'sha256', 'surfaceId'];
  invariant(
    root?.auxiliaryManifests !== null
      && typeof root?.auxiliaryManifests === 'object'
      && Array.isArray(root.auxiliaryManifests.fields)
      && Array.isArray(root.auxiliaryManifests.rows)
      && root.auxiliaryManifests.fields.length === expectedFields.length
      && root.auxiliaryManifests.fields.every((field, index) => field === expectedFields[index]),
    'T1_ROOT_AUXILIARY_SCHEMA_MISMATCH',
    'sealed root auxiliary-manifest table has an unexpected schema',
  );
  return root.auxiliaryManifests.rows.map((row, index) => {
    invariant(
      Array.isArray(row) && row.length === expectedFields.length,
      'T1_ROOT_AUXILIARY_ROW_INVALID',
      `sealed root auxiliary-manifest row ${index} has an unexpected shape`,
    );
    return Object.fromEntries(expectedFields.map((field, fieldIndex) => [field, row[fieldIndex]]));
  });
}

function assertSameSurfaceSummary(actual, expected) {
  for (const field of ['byteLength', 'fileCount', 'surfaceSha256']) {
    invariant(
      actual[field] === expected[field],
      'T1_SURFACE_DRIFT',
      `${actual.surfaceId}.${field} no longer equals the sealed root`,
      { actual: actual[field], expected: expected[field], surfaceId: actual.surfaceId },
    );
  }
}

function platformPreflight() {
  invariant(
    process.platform === 'win32' && process.arch === 'x64',
    'T3_PLATFORM_UNAVAILABLE',
    'T3 native qualification requires Windows AMD64',
  );
  const nonemptyNodeEnvironment = Object.entries(process.env)
    .filter(([name, value]) => /^NODE_/iu.test(name) && value !== undefined && value !== '')
    .map(([name]) => name)
    .sort(ordinalCompare);
  invariant(
    nonemptyNodeEnvironment.length === 0,
    'RUNNER_NODE_ENVIRONMENT_FORBIDDEN',
    `every NODE_* setting must be absent; observed ${nonemptyNodeEnvironment.join(', ')}`,
  );
  invariant(
    Array.isArray(process.execArgv) && process.execArgv.length === 0,
    'RUNNER_NODE_EXEC_ARGV_FORBIDDEN',
    'build invocation requires empty Node execArgv',
  );
}

function sameFileIdentity(left, right) {
  const devicesEqual = left.dev === 0n || right.dev === 0n || left.dev === right.dev;
  return devicesEqual
    && left.ino === right.ino
    && left.mode === right.mode
    && left.size === right.size
    && left.nlink === right.nlink
    && left.mtimeNs === right.mtimeNs
    && left.ctimeNs === right.ctimeNs;
}

async function readHandleExactly(handle, byteLength, label) {
  const bytes = Buffer.alloc(byteLength);
  let offset = 0;
  while (offset < byteLength) {
    const result = await handle.read(bytes, offset, byteLength - offset, offset);
    invariant(
      result.bytesRead > 0,
      'BUILD_INPUT_TRUNCATED',
      `${label} ended before its admitted byte length`,
    );
    offset += result.bytesRead;
  }
  const trailing = Buffer.alloc(1);
  const trailingRead = await handle.read(trailing, 0, 1, byteLength);
  invariant(
    trailingRead.bytesRead === 0,
    'BUILD_INPUT_GREW',
    `${label} grew beyond its admitted byte length`,
  );
  return bytes;
}

async function readStableSingleLinkFile(filePath, label, maximumBytes) {
  const beforePath = await lstat(filePath, { bigint: true });
  invariant(
    beforePath.isFile()
      && !beforePath.isSymbolicLink()
      && beforePath.nlink === 1n
      && beforePath.size >= 0n
      && beforePath.size <= BigInt(maximumBytes),
    'BUILD_INPUT_NOT_STABLE_FILE',
    `${label} must be one ordinary single-link file within its byte bound`,
  );
  const handle = await open(filePath, fsConstants.O_RDONLY);
  try {
    const beforeHandle = await handle.stat({ bigint: true });
    invariant(
      beforeHandle.isFile()
        && beforeHandle.nlink === 1n
        && sameFileIdentity(beforePath, beforeHandle),
      'BUILD_INPUT_CHANGED',
      `${label} changed while its read handle was opened`,
    );
    const byteLength = Number(beforeHandle.size);
    const first = await readHandleExactly(handle, byteLength, label);
    const second = await readHandleExactly(handle, byteLength, label);
    invariant(
      first.equals(second),
      'BUILD_INPUT_CHANGED',
      `${label} yielded different bytes across two reads`,
    );
    const afterHandle = await handle.stat({ bigint: true });
    const afterPath = await lstat(filePath, { bigint: true });
    invariant(
      afterPath.isFile()
        && !afterPath.isSymbolicLink()
        && afterPath.nlink === 1n
        && sameFileIdentity(beforeHandle, afterHandle)
        && sameFileIdentity(beforePath, afterPath),
      'BUILD_INPUT_CHANGED',
      `${label} changed while being read`,
    );
    return first;
  } finally {
    await handle.close();
  }
}

async function loadSealedRepoPrecodeRows(root, expectedSurface) {
  const auxiliaryRows = decodeRootAuxiliaryManifests(root)
    .filter((row) => row.surfaceId === T1_EXCLUDED_SURFACE_ID);
  invariant(
    auxiliaryRows.length === expectedSurface.shardCount,
    'T1_REPO_PRECODE_SHARD_COUNT_MISMATCH',
    'repo-precode-inputs auxiliary shard count differs from the sealed surface summary',
  );
  const shards = [];
  for (const auxiliary of auxiliaryRows) {
    invariant(
      typeof auxiliary.fileName === 'string'
        && path.basename(auxiliary.fileName) === auxiliary.fileName,
      'T1_REPO_PRECODE_SHARD_PATH_INVALID',
      'repo-precode-inputs shard filename is not closed',
    );
    const shardPath = path.join(path.dirname(NATIVE_INPUT_ROOT_PATH), auxiliary.fileName);
    const bytes = await readStableSingleLinkFile(
      shardPath,
      `sealed repo-precode-inputs shard ${auxiliary.fileName}`,
      MAX_T1_MANIFEST_BYTES,
    );
    invariant(
      bytes.length === auxiliary.byteLength && sha256Bytes(bytes) === auxiliary.sha256,
      'T1_REPO_PRECODE_SHARD_DRIFT',
      `${auxiliary.fileName} no longer equals its sealed root tuple`,
    );
    const shard = decodeCanonicalJsonBytes(bytes, auxiliary.fileName);
    invariant(
      shard?.schemaVersion === T1_SHARD_SCHEMA_VERSION
        && shard.manifestSetId === root.manifestSetId
        && shard.surfaceId === T1_EXCLUDED_SURFACE_ID
        && shard.shardCount === expectedSurface.shardCount
        && Number.isSafeInteger(shard.shardIndex)
        && shard.shardIndex >= 0
        && shard.shardIndex < expectedSurface.shardCount
        && Array.isArray(shard.files),
      'T1_REPO_PRECODE_SHARD_SCHEMA_MISMATCH',
      `${auxiliary.fileName} has an unexpected sealed shard identity`,
    );
    shards.push(shard);
  }
  shards.sort((left, right) => left.shardIndex - right.shardIndex);
  invariant(
    shards.every((shard, index) => shard.shardIndex === index),
    'T1_REPO_PRECODE_SHARD_INDEX_MISMATCH',
    'repo-precode-inputs shard indexes are not a dense closed sequence',
  );
  const files = shards.flatMap((shard) => shard.files);
  invariant(
    files.length === expectedSurface.fileCount
      && files.every((row, index) => (
        Array.isArray(row)
        && row.length === 3
        && typeof row[0] === 'string'
        && Number.isSafeInteger(row[1])
        && row[1] >= 0
        && typeof row[2] === 'string'
        && /^[0-9a-f]{64}$/u.test(row[2])
        && (index === 0 || files[index - 1][0] < row[0])
      ))
      && files.reduce((total, row) => total + row[1], 0) === expectedSurface.byteLength
      && sha256Bytes(canonicalJsonBytes(files)) === expectedSurface.surfaceSha256,
    'T1_REPO_PRECODE_FILE_TABLE_MISMATCH',
    'repo-precode-inputs shard rows do not reproduce the sealed surface summary',
  );
  return files;
}

function verifyRepoPrecodeSubset(actual, sealedFiles) {
  const authorized = new Set(T1_AUTHORIZED_POST_T1_LOGICAL_PATHS);
  invariant(
    authorized.size === T1_AUTHORIZED_POST_T1_LOGICAL_PATHS.length
      && T1_AUTHORIZED_POST_T1_LOGICAL_PATHS.every(
        (logicalPath, index) => index === 0 || T1_AUTHORIZED_POST_T1_LOGICAL_PATHS[index - 1] < logicalPath,
      ),
    'T1_POST_T1_AUTHORITY_INVALID',
    'authorized post-T1 path list must be sorted and unique',
  );
  invariant(
    actual.surfaceId === T1_EXCLUDED_SURFACE_ID
      && actual.files.length === sealedFiles.length
      && actual.files.every((row, index) => row[0] === sealedFiles[index][0]),
    'T1_REPO_PRECODE_PATH_CLOSURE_DRIFT',
    'repo-precode-inputs path closure no longer equals its sealed shard',
  );
  const observedAuthorized = new Set();
  let verifiedFileCount = 0;
  for (const [index, sealed] of sealedFiles.entries()) {
    const actualRow = actual.files[index];
    if (authorized.has(sealed[0])) {
      observedAuthorized.add(sealed[0]);
      continue;
    }
    invariant(
      actualRow[1] === sealed[1] && actualRow[2] === sealed[2],
      'T1_REPO_PRECODE_IMMUTABLE_DRIFT',
      `${sealed[0]} changed after the T1 seal without authorization`,
      { actual: actualRow.slice(1), expected: sealed.slice(1), logicalPath: sealed[0] },
    );
    verifiedFileCount += 1;
  }
  invariant(
    observedAuthorized.size === authorized.size,
    'T1_POST_T1_AUTHORIZED_PATH_MISSING',
    'the sealed repo-precode-inputs closure does not contain every authorized handoff path',
  );
  const immutablePackageConfigPaths = sealedFiles
    .map((row) => row[0])
    .filter((logicalPath) => (
      logicalPath.endsWith('/package.json')
      || logicalPath.endsWith('/tsconfig.json')
      || logicalPath === 'repo/pnpm-lock.yaml'
      || logicalPath === 'repo/pnpm-workspace.yaml'
    ));
  invariant(
    immutablePackageConfigPaths.length >= 4
      && immutablePackageConfigPaths.every((logicalPath) => !authorized.has(logicalPath)),
    'T1_PACKAGE_CONFIG_AUTHORITY_MISSING',
    'sealed package, lock, workspace, and TypeScript inputs are not all immutable',
  );
  return {
    authorizedPostT1LogicalPaths: [...T1_AUTHORIZED_POST_T1_LOGICAL_PATHS],
    immutablePackageConfigPaths,
    sealedFileCount: sealedFiles.length,
    verifiedFileCount,
  };
}

export async function preverifyT1Inputs({ onProgress = () => {} } = {}) {
  platformPreflight();
  onProgress({ phase: 't1-root', status: 'started' });
  const rootReceipt = await verifyManifestSet({ rootPath: NATIVE_INPUT_ROOT_PATH });
  const rootBytes = await readStableSingleLinkFile(
    NATIVE_INPUT_ROOT_PATH,
    ROOT_FILE_NAME,
    MAX_T1_MANIFEST_BYTES,
  );
  invariant(
    rootBytes.length === rootReceipt.rootByteLength
      && sha256Bytes(rootBytes) === rootReceipt.rootSha256,
    'T1_ROOT_CHANGED',
    'sealed root changed between manifest-set verification and build admission',
  );
  const root = decodeCanonicalJsonBytes(rootBytes, ROOT_FILE_NAME);
  const rootSurfaces = decodeRootSurfaces(root);
  const context = await loadManifestConfig(CONFIG_PATH);
  invariant(
    context.config.manifestSetId === root.manifestSetId,
    'T1_MANIFEST_SET_ID_MISMATCH',
    'sealed config and root manifest set ids differ',
  );
  const configSurfaceIds = context.config.surfaces
    .map((surface) => surface.surfaceId)
    .sort(ordinalCompare);
  const rootSurfaceIds = [...rootSurfaces.keys()].sort(ordinalCompare);
  invariant(
    configSurfaceIds.length === rootSurfaceIds.length
      && configSurfaceIds.every((surfaceId, index) => surfaceId === rootSurfaceIds[index]),
    'T1_SURFACE_AUTHORITY_MISMATCH',
    'sealed config and root surface identities differ',
  );
  invariant(
    rootSurfaces.has(T1_EXCLUDED_SURFACE_ID)
      && context.config.surfaces.some((surface) => surface.surfaceId === T1_EXCLUDED_SURFACE_ID),
    'T1_EXCLUDED_SURFACE_MISSING',
    'the one intentional post-T1 source surface is absent',
  );
  const sealedRepoPrecodeFiles = await loadSealedRepoPrecodeRows(
    root,
    rootSurfaces.get(T1_EXCLUDED_SURFACE_ID),
  );

  const logicalFiles = new Map();
  const caseFoldedLogicalFiles = new Map();
  const verifiedSurfaceIds = [];
  let repoPrecodeVerification;
  for (const surface of context.config.surfaces) {
    onProgress({ phase: 't1-surface', status: 'started', surfaceId: surface.surfaceId });
    const actual = await enumerateSurface(
      { sources: surface.sources, surfaceId: surface.surfaceId },
      {
        caseFoldedLogicalFiles,
        configDirectory: context.configDirectory,
        forbiddenSubstrings: context.forbiddenSubstrings,
        locations: context.locations,
        logicalFiles,
      },
    );
    if (surface.surfaceId === T1_EXCLUDED_SURFACE_ID) {
      repoPrecodeVerification = verifyRepoPrecodeSubset(actual, sealedRepoPrecodeFiles);
      onProgress({
        authorizedPathCount: repoPrecodeVerification.authorizedPostT1LogicalPaths.length,
        phase: 't1-surface',
        status: 'verified-with-authorized-paths',
        surfaceId: surface.surfaceId,
        verifiedFileCount: repoPrecodeVerification.verifiedFileCount,
      });
      continue;
    }
    assertSameSurfaceSummary(actual, rootSurfaces.get(surface.surfaceId));
    verifiedSurfaceIds.push(surface.surfaceId);
    onProgress({ phase: 't1-surface', status: 'verified', surfaceId: surface.surfaceId });
  }
  invariant(
    repoPrecodeVerification !== undefined,
    'T1_REPO_PRECODE_VERIFICATION_MISSING',
    'repo-precode-inputs was not independently verified',
  );
  onProgress({ phase: 't1-root', status: 'verified' });
  return {
    configContext: context,
    excludedSurface: {
      authorizedPostT1LogicalPaths: repoPrecodeVerification.authorizedPostT1LogicalPaths,
      immutablePackageConfigPaths: repoPrecodeVerification.immutablePackageConfigPaths,
      reason: 'only .gitattributes and three named handoff documents may differ; the sealed path closure and every other repo-precode input are byte-reverified',
      sealedFileCount: repoPrecodeVerification.sealedFileCount,
      surfaceId: T1_EXCLUDED_SURFACE_ID,
      verifiedFileCount: repoPrecodeVerification.verifiedFileCount,
    },
    manifestSetId: rootReceipt.manifestSetId,
    rootByteLength: rootReceipt.rootByteLength,
    rootSha256: rootReceipt.rootSha256,
    runnerNodeExecArgvEmpty: true,
    status: 'verified',
    verifiedSurfaceCount: verifiedSurfaceIds.length,
    verifiedSurfaceIds,
  };
}

function createLogicalResolver(configContext) {
  const mappings = [];
  for (const surface of configContext.config.surfaces) {
    for (const source of surface.sources) {
      let actualRoot;
      if (Object.hasOwn(source, 'location')) {
        const location = configContext.locations[source.location];
        invariant(
          typeof location === 'string',
          'SEALED_LOCATION_MISSING',
          `sealed location ${source.location} is unavailable`,
        );
        actualRoot = path.resolve(location, ...(source.relativeRoot ?? '').split('/').filter(Boolean));
      } else {
        actualRoot = path.resolve(configContext.configDirectory, source.root);
      }
      mappings.push({
        actualRoot,
        logicalPrefix: source.logicalPrefix.replaceAll('\\', '/').replace(/\/$/u, ''),
      });
    }
  }
  mappings.sort((left, right) => right.logicalPrefix.length - left.logicalPrefix.length);

  const configuredSystemRoot = configContext.locations.system;
  const ambientSystemRoot = environmentValue('SystemRoot');
  const ambientWindir = environmentValue('WINDIR');
  invariant(
    typeof configuredSystemRoot === 'string'
      && typeof ambientSystemRoot === 'string'
      && typeof ambientWindir === 'string'
      && normalizedWindowsPath(configuredSystemRoot) === normalizedWindowsPath('C:/Windows')
      && normalizedWindowsPath(ambientSystemRoot) === normalizedWindowsPath(configuredSystemRoot)
      && normalizedWindowsPath(ambientWindir) === normalizedWindowsPath(configuredSystemRoot),
    'SYSTEM_ROOT_AUTHORITY_MISMATCH',
    'SystemRoot, WINDIR, and the sealed system location must all equal C:/Windows',
  );
  const systemRoot = path.normalize(configuredSystemRoot);

  const resolveLogical = (logicalPath) => {
    invariant(
      typeof logicalPath === 'string'
        && logicalPath.length !== 0
        && !logicalPath.includes('\\')
        && !logicalPath.startsWith('/')
        && !logicalPath.split('/').some((segment) => segment === '' || segment === '.' || segment === '..'),
      'LOGICAL_PATH_INVALID',
      'sealed logical path is invalid',
    );
    if (logicalPath === 'windows/System32' || logicalPath.startsWith('windows/System32/')) {
      const suffix = logicalPath.slice('windows/System32'.length).replace(/^\//u, '');
      return path.resolve(systemRoot, 'System32', ...suffix.split('/').filter(Boolean));
    }
    for (const mapping of mappings) {
      if (
        logicalPath === mapping.logicalPrefix
        || logicalPath.startsWith(`${mapping.logicalPrefix}/`)
      ) {
        const suffix = logicalPath.slice(mapping.logicalPrefix.length).replace(/^\//u, '');
        return path.resolve(mapping.actualRoot, ...suffix.split('/').filter(Boolean));
      }
    }
    fail('LOGICAL_PATH_UNRESOLVED', `no sealed location resolves ${logicalPath}`);
  };
  return { resolveLogical, systemRoot };
}

async function assertOrdinaryFile(filePath, label) {
  const information = await lstat(filePath);
  invariant(
    information.isFile() && !information.isSymbolicLink() && information.nlink === 1,
    'BUILD_INPUT_NOT_ORDINARY',
    `${label} must be one ordinary single-link file`,
  );
  return information;
}

async function verifySelectedTools(config, resolver) {
  const tuples = new Map(config.root.hostToolchain.tools.map((tuple) => [tuple[0], tuple]));
  const tools = {};
  const identities = {};
  for (const id of ['cl', 'link', 'node']) {
    const tuple = tuples.get(id);
    invariant(tuple !== undefined, 'SEALED_TOOL_MISSING', `sealed tool ${id} is missing`);
    const [, logicalPath, expectedBytes, version, expectedSha256] = tuple;
    const filePath = resolver.resolveLogical(logicalPath);
    const digest = await hashStableFile(filePath, `sealed tool ${id}`);
    invariant(
      digest.byteLength === expectedBytes && digest.sha256 === expectedSha256,
      'SEALED_TOOL_DRIFT',
      `${id} no longer equals its sealed byte identity`,
    );
    tools[id] = filePath;
    identities[id] = { byteLength: expectedBytes, logicalPath, sha256: expectedSha256, version };
  }
  const runningNode = await hashStableFile(process.execPath, 'build orchestrator Node');
  invariant(
    runningNode.byteLength === identities.node.byteLength
      && runningNode.sha256 === identities.node.sha256,
    'ORCHESTRATOR_NODE_MISMATCH',
    'invoke the build with the exact sealed Node executable',
  );
  const termination = config.root.hostToolchain.processTreeTerminationTool;
  const terminationPolicy = config.root.hostToolchain.servicedSystemToolPolicy;
  invariant(
    termination?.executionMode === 'private-copy-with-bootstrap-failure-only-source'
      && termination.privateCopyFileName === 'taskkill.exe'
      && termination.hardlinkCount === 2
      && Array.isArray(termination.logicalPaths)
      && terminationPolicy?.privateCopyIdentity === 'run-private-single-link-copy-v1'
      && terminationPolicy.sourceIdentity === 'windows-servicing-hardlink-v1'
      && terminationPolicy.terminationInvocation === 'taskkill-tree-force-v1'
      && Number.isSafeInteger(terminationPolicy.terminationToolTimeoutMs)
      && terminationPolicy.terminationToolTimeoutMs > 0,
    'TERMINATION_TOOL_POLICY_MISMATCH',
    'sealed process-tree termination policy changed',
  );
  const terminationLogicalPath = termination.logicalPaths.find(
    (logicalPath) => logicalPath === 'windows/System32/taskkill.exe',
  );
  invariant(
    terminationLogicalPath !== undefined,
    'TERMINATION_TOOL_SOURCE_MISSING',
    'sealed taskkill source does not bind windows/System32/taskkill.exe',
  );
  const terminationSource = resolver.resolveLogical(terminationLogicalPath);
  const terminationDigest = await hashStableFile(
    terminationSource,
    'sealed taskkill source',
    { expectedLinkCount: termination.hardlinkCount },
  );
  invariant(
    terminationDigest.byteLength === termination.bytes
      && terminationDigest.sha256 === termination.sha256,
    'TERMINATION_TOOL_DRIFT',
    'sealed taskkill source no longer equals its admitted identity',
  );
  identities.taskkill = {
    byteLength: termination.bytes,
    logicalPath: terminationLogicalPath,
    sha256: termination.sha256,
    version: termination.embeddedFileVersion,
  };
  return { identities, termination, terminationPolicy, terminationSource, tools };
}

async function createPrivateTerminationTool(selectedTools, buildRoot) {
  const destination = path.join(buildRoot, selectedTools.termination.privateCopyFileName);
  await copyFile(selectedTools.terminationSource, destination, fsConstants.COPYFILE_EXCL);
  const digest = await hashStableFile(destination, 'run-private taskkill copy');
  invariant(
    digest.byteLength === selectedTools.termination.bytes
      && digest.sha256 === selectedTools.termination.sha256
      && digest.identity.linkCount === 1,
    'TERMINATION_PRIVATE_COPY_DRIFT',
    'run-private taskkill copy does not equal its sealed source identity',
  );
  return {
    path: destination,
    timeoutMs: selectedTools.terminationPolicy.terminationToolTimeoutMs,
  };
}

function buildEnvironment(config, resolver, temporaryDirectory) {
  const projection = config.root.hostToolchain.buildEnvironment;
  invariant(
    projection.id === 'cx004-build-environment-v1'
      && projection.ambientTailPolicy === 'discard'
      && projection.architecture?.host === 'x64'
      && projection.architecture?.target === 'x64',
    'BUILD_ENVIRONMENT_AUTHORITY_MISMATCH',
    'sealed build environment projection changed',
  );
  const resolveList = (values) => values.map((value) => resolver.resolveLogical(value));
  return {
    ComSpec: path.join(resolver.systemRoot, 'System32', 'cmd.exe'),
    INCLUDE: resolveList(projection.include).join(';'),
    LIB: resolveList(projection.lib).join(';'),
    LIBPATH: resolveList(projection.libpath).join(';'),
    NO_COLOR: '1',
    PATHEXT: '.COM;.EXE;.BAT;.CMD',
    Path: resolveList(projection.path).join(';'),
    PROCESSOR_ARCHITECTURE: 'AMD64',
    SystemRoot: resolver.systemRoot,
    TEMP: temporaryDirectory,
    TERM: 'dumb',
    TMP: temporaryDirectory,
    VSLANG: '1033',
    WINDIR: resolver.systemRoot,
  };
}

function createRedactor(values) {
  const roots = [...new Set(values.filter((value) => typeof value === 'string' && value.length !== 0))]
    .sort((left, right) => right.length - left.length);
  return (input) => {
    let output = String(input);
    for (const root of roots) {
      const escaped = root.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&');
      output = output.replace(new RegExp(escaped, 'giu'), '${SEALED_ROOT}');
    }
    return output.replaceAll('\\', '/');
  };
}

function boundedUtf8Tail(value, maximumBytes) {
  const bytes = Buffer.isBuffer(value) ? value : Buffer.from(String(value), 'utf8');
  let start = Math.max(0, bytes.length - maximumBytes);
  while (start < bytes.length && (bytes[start] & 0xc0) === 0x80) start += 1;
  let text = bytes.subarray(start).toString('utf8');
  while (Buffer.byteLength(text, 'utf8') > maximumBytes) text = text.slice(1);
  return text;
}

function boundedCommandDiagnostic(error, redactor) {
  const parts = [];
  for (const streamName of ['stdout', 'stderr']) {
    const bytes = error?.[streamName];
    if (Buffer.isBuffer(bytes) && bytes.length > 0) {
      parts.push(`${streamName}:\n${boundedUtf8Tail(redactor(bytes.toString('utf8')), 4000)}`);
    }
  }
  const diagnostic = parts.length > 0
    ? parts.join('\n')
    : redactor(error?.message ?? 'command returned no diagnostic');
  return boundedUtf8Tail(diagnostic, 8192);
}

async function terminateProcessTree({ cwd, env, label, pid, terminationTool }) {
  invariant(
    Number.isSafeInteger(pid) && pid > 0,
    'COMMAND_PID_INVALID',
    `${label} has no positive process id for tree termination`,
  );
  invariant(
    terminationTool !== null
      && typeof terminationTool === 'object'
      && typeof terminationTool.path === 'string'
      && Number.isSafeInteger(terminationTool.timeoutMs)
      && terminationTool.timeoutMs > 0,
    'TERMINATION_TOOL_ARGUMENT_INVALID',
    'run-private termination authority is incomplete',
  );
  await assertOrdinaryFile(terminationTool.path, 'run-private process-tree termination tool');
  return new Promise((resolve, reject) => {
    let terminator;
    try {
      terminator = spawn(
        terminationTool.path,
        ['/PID', String(pid), '/T', '/F'],
        {
          cwd,
          env,
          shell: false,
          stdio: ['ignore', 'pipe', 'pipe'],
          windowsHide: true,
        },
      );
    } catch (error) {
      reject(Object.assign(new Error(`${label} tree termination could not start`), {
        cause: error,
        code: 'COMMAND_TERMINATION_UNCERTAIN',
        preserveBuildRoot: true,
      }));
      return;
    }
    let outputBytes = 0;
    let outputOverflow = false;
    let settled = false;
    const observe = (chunk) => {
      outputBytes += chunk.length;
      if (outputBytes > 64 * 1024) outputOverflow = true;
    };
    terminator.stdout.on('data', observe);
    terminator.stderr.on('data', observe);
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      try {
        terminator.kill();
      } catch {
        // The typed uncertain receipt below remains authoritative.
      }
      reject(Object.assign(new Error(`${label} tree termination did not settle`), {
        code: 'COMMAND_TERMINATION_UNCERTAIN',
        preserveBuildRoot: true,
      }));
    }, terminationTool.timeoutMs);
    terminator.once('error', (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(Object.assign(new Error(`${label} tree termination process error`), {
        cause: error,
        code: 'COMMAND_TERMINATION_UNCERTAIN',
        preserveBuildRoot: true,
      }));
    });
    terminator.once('close', (exitCode, signal) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (exitCode !== 0 || signal !== null || outputOverflow) {
        reject(Object.assign(new Error(`${label} tree termination lacked a positive receipt`), {
          code: 'COMMAND_TERMINATION_UNCERTAIN',
          preserveBuildRoot: true,
        }));
        return;
      }
      resolve({ exitCode, signal });
    });
  });
}

export async function runBoundedCommand({
  acceptExit = (exitCode) => exitCode === 0,
  args,
  cwd,
  env,
  label,
  maxOutputBytes = MAX_CAPTURE_BYTES,
  terminationTool,
  timeoutMs = DEFAULT_COMMAND_TIMEOUT_MS,
  tool,
}) {
  invariant(Array.isArray(args), 'COMMAND_ARGUMENTS_INVALID', `${label} args must be an array`);
  invariant(
    Number.isSafeInteger(timeoutMs) && timeoutMs > 0,
    'COMMAND_TIMEOUT_INVALID',
    `${label} timeout must be a positive safe integer`,
  );
  invariant(
    Number.isSafeInteger(maxOutputBytes) && maxOutputBytes > 0,
    'COMMAND_OUTPUT_BOUND_INVALID',
    `${label} output bound must be a positive safe integer`,
  );
  await assertOrdinaryFile(tool, `${label} executable`);
  invariant(
    terminationTool !== null && typeof terminationTool === 'object',
    'TERMINATION_TOOL_ARGUMENT_INVALID',
    'run-private termination authority is required',
  );
  await assertOrdinaryFile(terminationTool.path, 'run-private process-tree termination tool');
  return new Promise((resolve, reject) => {
    let child;
    try {
      child = spawn(tool, args, {
        cwd,
        env,
        shell: false,
        stdio: ['ignore', 'pipe', 'pipe'],
        windowsHide: true,
      });
    } catch (error) {
      reject(Object.assign(new Error(`${label} could not start`), { code: 'COMMAND_START_FAILED' }));
      return;
    }
    const stdoutChunks = [];
    const stderrChunks = [];
    let stdoutBytes = 0;
    let stderrBytes = 0;
    let settled = false;
    let timedOut = false;
    let overflow = false;
    let terminationPromise;
    let postTerminationSettlementTimer;
    const terminate = () => {
      if (terminationPromise === undefined) {
        terminationPromise = terminateProcessTree({
          cwd,
          env,
          label,
          pid: child.pid,
          terminationTool,
        });
        void terminationPromise.then(
          () => {
            if (settled) return;
            postTerminationSettlementTimer = setTimeout(() => {
              if (settled) return;
              settled = true;
              clearTimeout(timer);
              reject(Object.assign(
                new Error(`${label} did not settle after positive tree termination`),
                {
                  code: 'COMMAND_TERMINATION_SETTLEMENT_UNCERTAIN',
                  preserveBuildRoot: true,
                },
              ));
            }, terminationTool.timeoutMs);
          },
          (error) => {
            if (settled) return;
            settled = true;
            clearTimeout(timer);
            reject(error);
          },
        );
      }
      return terminationPromise;
    };
    const timer = setTimeout(() => {
      timedOut = true;
      void terminate();
    }, timeoutMs);
    const collect = (chunks, streamName) => (chunk) => {
      const copy = Buffer.from(chunk);
      if (streamName === 'stdout') stdoutBytes += copy.length;
      else stderrBytes += copy.length;
      if (stdoutBytes + stderrBytes > maxOutputBytes && !overflow) {
        overflow = true;
        child.stdout.pause();
        child.stderr.pause();
        void terminate();
        return;
      }
      if (overflow) return;
      chunks.push(copy);
    };
    child.stdout.on('data', collect(stdoutChunks, 'stdout'));
    child.stderr.on('data', collect(stderrChunks, 'stderr'));
    child.once('error', (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      clearTimeout(postTerminationSettlementTimer);
      reject(Object.assign(new Error(`${label} process error`), {
        cause: error,
        code: 'COMMAND_PROCESS_ERROR',
      }));
    });
    child.once('close', (exitCode, signal) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      clearTimeout(postTerminationSettlementTimer);
      void (async () => {
        if (terminationPromise !== undefined) {
          try {
            await terminationPromise;
          } catch (error) {
            reject(error);
            return;
          }
        }
        const stdout = Buffer.concat(stdoutChunks);
        const stderr = Buffer.concat(stderrChunks);
        if (timedOut) {
          reject(Object.assign(new Error(`${label} exceeded ${timeoutMs}ms`), {
            code: 'COMMAND_TIMEOUT_INCONCLUSIVE',
          }));
          return;
        }
        if (overflow) {
          reject(Object.assign(new Error(`${label} exceeded its output bound`), {
            code: 'COMMAND_OUTPUT_BOUND_EXCEEDED',
          }));
          return;
        }
        if (!acceptExit(exitCode, signal)) {
          const error = new Error(`${label} exited with ${exitCode ?? 'null'} / ${signal ?? 'none'}`);
          error.code = 'COMMAND_EXIT_REJECTED';
          error.stdout = stdout;
          error.stderr = stderr;
          reject(error);
          return;
        }
        resolve({ exitCode, signal, stderr, stdout });
      })();
    });
  });
}

function findRecipe(config, recipeId) {
  const recipe = config.root.buildRecipes.find((candidate) => candidate.id === recipeId);
  invariant(recipe !== undefined, 'SEALED_RECIPE_MISSING', `sealed recipe ${recipeId} is missing`);
  return recipe;
}

function requireRecipeFlag(recipe, flag) {
  invariant(
    Array.isArray(recipe.linkFlags) && recipe.linkFlags.includes(flag),
    'SEALED_LINK_FLAG_MISSING',
    `${recipe.id} no longer supplies ${flag}`,
  );
  return flag;
}

function requireRecipeLibrary(recipe, library) {
  invariant(
    Array.isArray(recipe.libraries) && recipe.libraries.includes(library),
    'SEALED_LINK_LIBRARY_MISSING',
    `${recipe.id} no longer supplies ${library}`,
  );
  return library;
}

function qualificationRecipe(config) {
  const propertyRecipe = findRecipe(config, 'msvc-native-properties');
  const consolePolicy = findRecipe(config, 'llvm-19.1.7-fuzz');
  const releasePolicy = findRecipe(config, 'msvc-release-bootstrap');
  const corePolicy = findRecipe(config, 'msvc-release-core');
  invariant(
    propertyRecipe.compileDriver === 'msvc/bin/Hostx64/x64/cl.exe'
      && propertyRecipe.linkDriver === 'msvc/bin/Hostx64/x64/link.exe'
      && propertyRecipe.environmentProjectionId === 'cx004-build-environment-v1'
      && propertyRecipe.outputKind === 'console-qualification-executable',
    'QUALIFICATION_RECIPE_AUTHORITY_MISMATCH',
    'sealed native property recipe changed',
  );
  invariant(
    consolePolicy.outputKind === 'eight-qualification-only-fuzzer-executables'
      && consolePolicy.linker === 'llvm/bin/lld-link.exe'
      && Array.isArray(consolePolicy.linkFlags),
    'CONSOLE_LINK_POLICY_MISMATCH',
    'sealed console qualification link policy changed',
  );
  invariant(
    Array.isArray(corePolicy.defines)
      && corePolicy.defines.length > 0
      && !corePolicy.defines.some((define) => define.startsWith('PCSDK_ARTIFACT_'))
      && !corePolicy.defines.includes('PCSDK_QUALIFICATION=1'),
    'QUALIFICATION_DEFINE_AUTHORITY_MISMATCH',
    'sealed core define projection cannot be specialized for qualification',
  );
  return {
    compileFlags: [
      ...propertyRecipe.compileFlags,
      ...corePolicy.defines.map((define) => `/D${define}`),
      '/DPCSDK_QUALIFICATION=1',
      `/D${QUALIFICATION_ARTIFACT_MACRO}`,
    ],
    linkLibraries: [requireRecipeLibrary(releasePolicy, 'kernel32.lib')],
    linkFlags: [
      ...consolePolicy.linkFlags,
      requireRecipeFlag(releasePolicy, '/BREPRO'),
      requireRecipeFlag(releasePolicy, '/RELEASE'),
      requireRecipeFlag(releasePolicy, '/DEPENDENTLOADFLAG:0x800'),
      requireRecipeFlag(releasePolicy, '/MANIFEST:EMBED'),
    ],
    recipeId: propertyRecipe.id,
  };
}

async function releaseAvailability(config) {
  const artifacts = [];
  const coreTranslationUnits = findRecipe(config, 'msvc-release-core').translationUnits;
  for (const recipeId of RELEASE_RECIPE_IDS) {
    const recipe = findRecipe(config, recipeId);
    const missingSourcePaths = [];
    const translationUnitClosure = [...new Set([
      ...(recipeId === 'msvc-release-core' ? [] : coreTranslationUnits),
      ...recipe.translationUnits,
    ])].sort(ordinalCompare);
    for (const relativePath of translationUnitClosure) {
      try {
        await assertOrdinaryFile(repositoryPath(relativePath), `${recipeId} source ${relativePath}`);
      } catch (error) {
        if (error?.code === 'ENOENT') missingSourcePaths.push(relativePath);
        else throw error;
      }
    }
    artifacts.push({
      artifactId: recipe.artifactId,
      missingSourcePaths,
      recipeId,
      status: missingSourcePaths.length === 0 ? 'available' : 'unavailable',
    });
  }
  invariant(
    artifacts.some((artifact) => artifact.missingSourcePaths.length !== 0),
    'RELEASE_CLOSURE_CHANGED',
    'full release translation-unit closure unexpectedly became complete; a recorded amendment is required',
  );
  return {
    artifacts,
    reason: 'incomplete-sealed-translation-unit-closure',
    status: 'unavailable',
  };
}

async function checkGeneratedManifest(context, redactor) {
  const result = await runBoundedCommand({
    args: [RESOURCE_GENERATOR_PATH, '--check'],
    cwd: REPOSITORY_ROOT,
    env: context.environment,
    label: 'resource manifest generator check',
    maxOutputBytes: 64 * 1024,
    terminationTool: context.terminationTool,
    timeoutMs: 30_000,
    tool: context.tools.node,
  }).catch((error) => {
    if (error?.preserveBuildRoot === true) throw error;
    fail(
      'RESOURCE_MANIFEST_GENERATOR_DRIFT',
      'resource manifest generator check failed',
      { diagnostic: boundedCommandDiagnostic(error, redactor) },
    );
  });
  invariant(
    result.exitCode === 0,
    'RESOURCE_MANIFEST_GENERATOR_DRIFT',
    'resource manifest generator check did not pass',
  );
  return { status: 'verified' };
}

async function stageSealedSources(buildRoot, sealedFiles) {
  invariant(
    Array.isArray(sealedFiles)
      && sealedFiles.length > 0
      && sealedFiles.every((row, index) => (
        Array.isArray(row)
        && row.length === 3
        && typeof row[0] === 'string'
        && Number.isSafeInteger(row[1])
        && row[1] >= 0
        && typeof row[2] === 'string'
        && /^[0-9a-f]{64}$/u.test(row[2])
        && (index === 0 || sealedFiles[index - 1][0] < row[0])
      )),
    'SOURCE_STAGE_AUTHORITY_INVALID',
    'source seal file rows must be a nonempty sorted closed tuple set',
  );
  const stagingRoot = path.join(buildRoot, 'source');
  await mkdir(stagingRoot, { recursive: false });
  const sourcePaths = new Map();
  const stagedRows = [];
  for (const [relativePath, expectedBytes, expectedSha256] of sealedFiles) {
    const sourcePath = repositoryPath(relativePath);
    const stagedPath = path.resolve(stagingRoot, ...relativePath.split('/'));
    const relativeStagedPath = path.relative(stagingRoot, stagedPath);
    invariant(
      relativeStagedPath !== ''
        && relativeStagedPath !== '..'
        && !relativeStagedPath.startsWith(`..${path.sep}`)
        && !path.isAbsolute(relativeStagedPath),
      'SOURCE_STAGE_PATH_ESCAPE',
      `${relativePath} escaped the private source stage`,
    );
    await mkdir(path.dirname(stagedPath), { recursive: true });
    await copyFile(sourcePath, stagedPath, fsConstants.COPYFILE_EXCL);
    const digest = await hashStableFile(stagedPath, `staged T3 source ${relativePath}`);
    invariant(
      digest.byteLength === expectedBytes && digest.sha256 === expectedSha256,
      'SOURCE_STAGE_SEAL_MISMATCH',
      `${relativePath} did not copy as its exact sealed bytes`,
    );
    sourcePaths.set(relativePath, stagedPath);
    stagedRows.push([relativePath, digest.byteLength, digest.sha256]);
  }
  invariant(
    stagedRows.length === sealedFiles.length
      && sha256Bytes(canonicalJsonBytes(stagedRows)) === sha256Bytes(canonicalJsonBytes(sealedFiles)),
    'SOURCE_STAGE_CLOSURE_MISMATCH',
    'private source stage does not reproduce the exact source-seal tuple set',
  );
  const requiredPaths = [
    ...QUALIFICATION_TRANSLATION_UNITS,
    'packages/windows-containment/native/include/pc_sdk_next/generated/resource_manifest.generated.h',
    'packages/windows-containment/native/resource-sites.json',
  ];
  invariant(
    requiredPaths.every((relativePath) => sourcePaths.has(relativePath)),
    'SOURCE_STAGE_REQUIRED_INPUT_MISSING',
    'private source stage is missing a qualification compiler or manifest input',
  );
  return {
    generatedHeaderPath: sourcePaths.get(
      'packages/windows-containment/native/include/pc_sdk_next/generated/resource_manifest.generated.h',
    ),
    includePath: path.join(
      stagingRoot,
      'packages',
      'windows-containment',
      'native',
      'include',
    ),
    nativeRoot: path.join(
      stagingRoot,
      'packages',
      'windows-containment',
      'native',
    ),
    receipt: {
      fileCount: stagedRows.length,
      sourceSetSha256: sha256Bytes(canonicalJsonBytes(stagedRows)),
      status: 'verified-private-copy',
    },
    registryPath: sourcePaths.get('packages/windows-containment/native/resource-sites.json'),
    sourcePaths,
    stagingRoot,
  };
}

async function checkStagedGeneratedManifest(stagedSources) {
  const registry = await loadResourceSiteRegistry(stagedSources.registryPath);
  const expectedHeader = Buffer.from(renderGeneratedResourceManifestHeader(registry), 'utf8');
  const observedHeader = await readStableSingleLinkFile(
    stagedSources.generatedHeaderPath,
    'staged generated resource manifest header',
    MAX_STAGED_SOURCE_BYTES,
  );
  invariant(
    observedHeader.equals(expectedHeader),
    'STAGED_RESOURCE_MANIFEST_HEADER_DRIFT',
    'staged generated header is not the deterministic staged-registry projection',
  );
  const sources = [];
  for (const [logicalPath, sourcePath] of stagedSources.sourcePaths) {
    if (
      !logicalPath.startsWith('packages/windows-containment/native/')
      || !/\.(?:cc|h)$/u.test(logicalPath)
    ) {
      continue;
    }
    const bytes = await readStableSingleLinkFile(
      sourcePath,
      `staged native guard source ${logicalPath}`,
      MAX_STAGED_SOURCE_BYTES,
    );
    const source = bytes.toString('utf8');
    invariant(
      Buffer.from(source, 'utf8').equals(bytes),
      'STAGED_NATIVE_SOURCE_ENCODING_INVALID',
      `${logicalPath} is not exact UTF-8 source text`,
    );
    sources.push({ logicalPath, source });
  }
  sources.sort((left, right) => ordinalCompare(left.logicalPath, right.logicalPath));
  const sourceGuard = assertNativeResourceSourceGuard({ registry, sources });
  return {
    header: {
      byteLength: expectedHeader.length,
      sha256: sha256Bytes(expectedHeader),
      status: 'verified-stable-copy',
    },
    sourceGuard,
    status: 'verified-staged-inputs',
  };
}

async function readExactQualificationPe(executablePath, artifactDigest) {
  const handle = await open(executablePath, fsConstants.O_RDONLY);
  try {
    const before = await handle.stat({ bigint: true });
    const observedIdentity = {
      device: before.dev.toString(16).padStart(8, '0'),
      fileId: before.ino.toString(16).padStart(16, '0'),
      linkCount: Number(before.nlink),
    };
    invariant(
      before.isFile()
        && before.size === BigInt(artifactDigest.byteLength)
        && JSON.stringify(observedIdentity) === JSON.stringify(artifactDigest.identity),
      'QUALIFICATION_PE_CHANGED',
      'qualification PE open handle differs from its stable identity',
    );
    const bytes = Buffer.alloc(artifactDigest.byteLength);
    let offset = 0;
    while (offset < bytes.length) {
      const result = await handle.read(bytes, offset, bytes.length - offset, offset);
      invariant(
        result.bytesRead > 0,
        'QUALIFICATION_PE_TRUNCATED',
        'qualification PE ended before its admitted byte length',
      );
      offset += result.bytesRead;
    }
    const trailing = Buffer.alloc(1);
    const trailingRead = await handle.read(trailing, 0, 1, bytes.length);
    invariant(
      trailingRead.bytesRead === 0,
      'QUALIFICATION_PE_GREW',
      'qualification PE grew while being read',
    );
    const after = await handle.stat({ bigint: true });
    invariant(
      after.size === before.size
        && after.dev === before.dev
        && after.ino === before.ino
        && after.nlink === before.nlink
        && after.mtimeNs === before.mtimeNs
        && after.ctimeNs === before.ctimeNs,
      'QUALIFICATION_PE_CHANGED',
      'qualification PE identity changed while being read',
    );
    return bytes;
  } finally {
    await handle.close();
  }
}

async function inspectQualificationPe(executablePath, artifactDigest, registryPath) {
  invariant(
    artifactDigest.byteLength > 0 && artifactDigest.byteLength <= MAX_QUALIFICATION_PE_BYTES,
    'QUALIFICATION_PE_SIZE_INVALID',
    'qualification PE is outside its exact inspection byte bound',
  );
  const peBytes = await readExactQualificationPe(executablePath, artifactDigest);
  invariant(
    peBytes.length === artifactDigest.byteLength
      && sha256Bytes(peBytes) === artifactDigest.sha256,
    'QUALIFICATION_PE_CHANGED',
    'qualification PE changed between stable hashing and inspection',
  );
  const registry = await loadResourceSiteRegistry(registryPath);
  const expectedManifest = buildArtifactResourceOwnershipManifest(
    registry,
    'qualification',
  );
  const expectedPayload = canonicalJsonBytes(expectedManifest);
  const expectedFrame = encodeEmbeddedResourceOwnershipManifestFrame(expectedManifest);
  const observed = verifyEmbeddedResourceOwnershipManifestInPe(peBytes, expectedManifest);
  invariant(
    observed.frameBytes.equals(expectedFrame)
      && observed.payloadBytes.equals(expectedPayload)
      && observed.digestHex === sha256Bytes(expectedPayload)
      && Number.isSafeInteger(observed.offset)
      && observed.offset >= 0
      && observed.section.readable === true
      && observed.section.writable === false
      && observed.section.executable === false,
    'QUALIFICATION_PE_MANIFEST_MISMATCH',
    'qualification PE did not retain the exact generated read-only manifest frame',
  );
  const after = await hashStableFile(executablePath, 'qualification executable after PE inspection');
  invariant(
    after.byteLength === artifactDigest.byteLength
      && after.sha256 === artifactDigest.sha256
      && JSON.stringify(after.identity) === JSON.stringify(artifactDigest.identity),
    'QUALIFICATION_PE_CHANGED',
    'qualification PE identity changed during manifest inspection',
  );
  return {
    abaCanaries: expectedManifest.sites
      .filter((site) => (
        site.abaCanary.noProofOutcome === 'inconclusive'
        && site.abaCanary.maxAttempts > 0
        && site.abaCanary.maxMonotonicMilliseconds > 0
      ))
      .map((site) => ({
        kind: site.abaCanary.kind,
        maxAttempts: site.abaCanary.maxAttempts,
        maxMonotonicMilliseconds: site.abaCanary.maxMonotonicMilliseconds,
        noProofOutcome: site.abaCanary.noProofOutcome,
        siteId: site.siteId,
      })),
    artifactId: observed.artifactId,
    frame: {
      byteLength: observed.frameBytes.length,
      generatedByteEqual: true,
      offset: observed.offset,
      section: {
        executable: observed.section.executable,
        name: observed.section.name,
        readable: observed.section.readable,
        writable: observed.section.writable,
      },
      sha256: sha256Bytes(observed.frameBytes),
    },
    payload: {
      byteLength: observed.payloadBytes.length,
      generatedByteEqual: true,
      sha256: observed.digestHex,
    },
    siteCount: expectedManifest.siteCount,
    siteIds: expectedManifest.sites.map((site) => site.siteId),
    status: 'verified',
  };
}

export async function cleanupQualificationArtifact(buildResult) {
  if (buildResult?.buildRoot === undefined) return;
  const resolved = path.resolve(buildResult.buildRoot);
  try {
    const relative = path.relative(PACKAGE_ROOT, resolved);
    invariant(
      relative.startsWith('.cx004-t3-')
        && !relative.includes(path.sep)
        && path.dirname(resolved) === PACKAGE_ROOT,
      'BUILD_CLEANUP_SCOPE_REFUSED',
      'refusing to clean a path outside the exact T3 temporary-build scope',
    );
    await rm(resolved, { recursive: true, force: false });
    try {
      await lstat(resolved);
    } catch (error) {
      if (error?.code === 'ENOENT') return { status: 'removed' };
      throw error;
    }
    fail('BUILD_CLEANUP_UNCERTAIN', 'temporary T3 build root still exists after removal');
  } catch (error) {
    if (error?.code === 'BUILD_CLEANUP_UNCERTAIN') {
      error.preserveBuildRoot = true;
      error.strandedBuildRoot = resolved;
      throw error;
    }
    const uncertain = new Error('temporary T3 build root cleanup did not settle positively');
    uncertain.code = 'BUILD_CLEANUP_UNCERTAIN';
    uncertain.cause = error;
    uncertain.preserveBuildRoot = true;
    uncertain.strandedBuildRoot = resolved;
    throw uncertain;
  }
}

export async function buildQualificationArtifact({ onProgress = () => {} } = {}) {
  let buildRoot;
  try {
    const t1 = await preverifyT1Inputs({ onProgress });
    const resolver = createLogicalResolver(t1.configContext);
    const selectedTools = await verifySelectedTools(t1.configContext.config, resolver);
    buildRoot = await mkdtemp(path.join(PACKAGE_ROOT, '.cx004-t3-'));
    const terminationTool = await createPrivateTerminationTool(selectedTools, buildRoot);
    const objectDirectory = path.join(buildRoot, 'obj');
    await mkdir(objectDirectory, { recursive: false });
    const environment = buildEnvironment(t1.configContext.config, resolver, buildRoot);
    const redactor = createRedactor([
      REPOSITORY_ROOT,
      buildRoot,
      ...Object.values(t1.configContext.locations),
    ]);
    const context = {
      environment,
      terminationTool,
      tools: selectedTools.tools,
    };

    onProgress({ phase: 'resource-manifest', status: 'started' });
    const repositoryManifestCheck = await checkGeneratedManifest(context, redactor);
    onProgress({ phase: 'resource-manifest', status: 'repository-verified' });
    onProgress({ phase: 'source-seal', status: 'started' });
    const sourceSealWithFiles = await verifySourceSeal({ includeFiles: true });
    const { files: sealedFiles, ...sourceSeal } = sourceSealWithFiles;
    const stagedSources = await stageSealedSources(buildRoot, sealedFiles);
    const stagedManifestCheck = await checkStagedGeneratedManifest(stagedSources);
    const generatedManifest = {
      repository: repositoryManifestCheck,
      staged: stagedManifestCheck,
      status: 'verified',
    };
    onProgress({ phase: 'source-seal', status: 'verified' });
    const recipe = qualificationRecipe(t1.configContext.config);
    const objects = [];
    for (const [index, relativePath] of QUALIFICATION_TRANSLATION_UNITS.entries()) {
      const sourcePath = stagedSources.sourcePaths.get(relativePath);
      invariant(
        typeof sourcePath === 'string',
        'SOURCE_STAGE_TRANSLATION_UNIT_MISSING',
        `${relativePath} is absent from the private source stage`,
      );
      await assertOrdinaryFile(sourcePath, `qualification source ${relativePath}`);
      const objectPath = path.join(objectDirectory, `${String(index).padStart(2, '0')}.obj`);
      onProgress({ phase: 'compile', source: relativePath, status: 'started' });
      await runBoundedCommand({
        args: [
          ...recipe.compileFlags,
          `/I${stagedSources.includePath}`,
          `/Fo${objectPath}`,
          sourcePath,
        ],
        cwd: stagedSources.stagingRoot,
        env: environment,
        label: `compile ${relativePath}`,
        terminationTool,
        tool: selectedTools.tools.cl,
      }).catch((error) => {
        if (error?.preserveBuildRoot === true) throw error;
        fail(
          'QUALIFICATION_COMPILE_FAILED',
          `compile failed for ${relativePath}`,
          {
            diagnostic: boundedCommandDiagnostic(error, redactor),
            source: relativePath,
          },
        );
      });
      objects.push(objectPath);
      onProgress({ phase: 'compile', source: relativePath, status: 'completed' });
    }
    const executablePath = path.join(buildRoot, 'cx004-resource-qualification.exe');
    onProgress({ phase: 'link', status: 'started' });
    await runBoundedCommand({
      args: [
        ...recipe.linkFlags,
        `/OUT:${executablePath}`,
        ...objects,
        ...recipe.linkLibraries,
      ],
      cwd: buildRoot,
      env: environment,
      label: 'link resource ownership qualification executable',
      terminationTool,
      tool: selectedTools.tools.link,
    }).catch((error) => {
      if (error?.preserveBuildRoot === true) throw error;
      fail(
        'QUALIFICATION_LINK_FAILED',
        'qualification link failed',
        { diagnostic: boundedCommandDiagnostic(error, redactor) },
      );
    });
    const artifactDigest = await hashStableFile(executablePath, 'qualification executable');
    const embeddedManifest = await inspectQualificationPe(
      executablePath,
      artifactDigest,
      stagedSources.registryPath,
    );
    const unavailableRelease = await releaseAvailability(t1.configContext.config);
    onProgress({ phase: 'link', status: 'completed' });
    return {
      buildRoot,
      environment,
      executablePath,
      terminationTool,
      receipt: {
        artifact: {
          byteLength: artifactDigest.byteLength,
          identity: artifactDigest.identity,
          kind: 'console-qualification-executable',
          sha256: artifactDigest.sha256,
        },
        embeddedManifest,
        generatedManifest,
        productionAdmission: false,
        qualification: {
          artifactMacro: QUALIFICATION_ARTIFACT_MACRO,
          mode: QUALIFICATION_MODE,
          recipeId: recipe.recipeId,
          translationUnits: [...QUALIFICATION_TRANSLATION_UNITS],
        },
        release: unavailableRelease,
        schemaVersion: 'pc-sdk.cx-004.resource-qualification-build.v1',
        scope: 't3-resource-wrapper-qualification-only',
        sourceSeal,
        sourceStaging: stagedSources.receipt,
        status: 'built',
        t1: {
          excludedSurface: t1.excludedSurface,
          manifestSetId: t1.manifestSetId,
          rootByteLength: t1.rootByteLength,
          rootSha256: t1.rootSha256,
          runnerNodeExecArgvEmpty: t1.runnerNodeExecArgvEmpty,
          status: t1.status,
          verifiedSurfaceCount: t1.verifiedSurfaceCount,
        },
        tools: selectedTools.identities,
      },
    };
  } catch (error) {
    if (buildRoot !== undefined) {
      if (error?.preserveBuildRoot === true) {
        error.strandedBuildRoot = buildRoot;
        throw error;
      }
      try {
        await cleanupQualificationArtifact({ buildRoot });
      } catch (cleanupError) {
        const uncertain = new Error('temporary T3 build root cleanup did not settle positively');
        uncertain.code = 'BUILD_CLEANUP_UNCERTAIN';
        uncertain.cause = cleanupError;
        uncertain.originalError = error;
        uncertain.preserveBuildRoot = true;
        uncertain.strandedBuildRoot = buildRoot;
        throw uncertain;
      }
    }
    throw error;
  }
}

function progressToStderr(event) {
  const fields = [event.phase, event.status, event.surfaceId, event.source]
    .filter((value) => value !== undefined);
  process.stderr.write(`[cx004-t3] ${fields.join(' ')}\n`);
}

function parseCliArguments(argv) {
  if (argv.length === 0) return '--qualification';
  if (
    argv.length === 1
    && ['--preverify', '--qualification', '--release-availability'].includes(argv[0])
  ) {
    return argv[0];
  }
  fail(
    'BUILD_USAGE',
    'usage: node build/build.mjs [--preverify|--qualification|--release-availability]',
  );
}

export async function runBuildCli(argv = process.argv.slice(2)) {
  const mode = parseCliArguments(argv);
  if (mode === '--preverify') {
    const t1 = await preverifyT1Inputs({ onProgress: progressToStderr });
    process.stdout.write(canonicalJsonBytes({
      excludedSurface: t1.excludedSurface,
      manifestSetId: t1.manifestSetId,
      rootByteLength: t1.rootByteLength,
      rootSha256: t1.rootSha256,
      runnerNodeExecArgvEmpty: t1.runnerNodeExecArgvEmpty,
      schemaVersion: 'pc-sdk.cx-004.t1-preverification.v1',
      status: t1.status,
      verifiedSurfaceCount: t1.verifiedSurfaceCount,
    }));
    process.stdout.write('\n');
    return;
  }
  if (mode === '--release-availability') {
    const t1 = await preverifyT1Inputs({ onProgress: progressToStderr });
    const receipt = await releaseAvailability(t1.configContext.config);
    process.stdout.write(canonicalJsonBytes({
      ...receipt,
      productionAdmission: false,
      schemaVersion: 'pc-sdk.cx-004.release-availability.v1',
    }));
    process.stdout.write('\n');
    return;
  }
  const result = await buildQualificationArtifact({ onProgress: progressToStderr });
  await cleanupQualificationArtifact(result);
  process.stdout.write(canonicalJsonBytes(result.receipt));
  process.stdout.write('\n');
}

const invokedPath = process.argv[1] === undefined
  ? undefined
  : pathToFileURL(path.resolve(process.argv[1])).href;
if (invokedPath === import.meta.url) {
  runBuildCli().catch((error) => {
    process.stderr.write(canonicalJsonBytes({
      reason: typeof error?.code === 'string' ? error.code : 'BUILD_FAILED',
      schemaVersion: 'pc-sdk.cx-004.resource-qualification-build-failure.v1',
      strandedBuildRoot: error?.preserveBuildRoot === true
        && typeof error?.strandedBuildRoot === 'string'
        ? error.strandedBuildRoot
        : null,
      status: error?.code === 'COMMAND_TIMEOUT_INCONCLUSIVE' ? 'inconclusive' : 'failed',
      temporaryBuildRootDisposition: error?.preserveBuildRoot === true
        ? 'preserved-due-to-cleanup-or-termination-uncertainty'
        : 'absent-or-positively-removed',
    }));
    process.stderr.write('\n');
    process.exitCode = 1;
  });
}
