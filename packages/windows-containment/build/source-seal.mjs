import { constants as fsConstants } from 'node:fs';
import {
  lstat,
  mkdir,
  open,
  readdir,
  realpath,
  writeFile,
} from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import {
  ROOT_FILE_NAME,
  canonicalJsonBytes,
  decodeCanonicalJsonBytes,
  hashStableFile,
  sha256Bytes,
  verifyManifestSet,
} from '../toolchain/manifest-set.mjs';

export const SOURCE_SEAL_SCHEMA_VERSION = 'pc-sdk.cx-004.native-source.v1';
export const SOURCE_SEAL_CLASSIFICATION = 'exact-closed-t3-resource-source-seal';
export const SOURCE_SEAL_RELATIVE_PATH =
  'docs/execution/manifests/CX-004-native-source.json';

export const SOURCE_SEAL_EXCLUDED_PATHS = Object.freeze([
  SOURCE_SEAL_RELATIVE_PATH,
  'docs/execution/receipts/CX-004-T3.md',
]);

export const SOURCE_PATHS = Object.freeze([
  'packages/windows-containment/build/build.mjs',
  'packages/windows-containment/build/resource-manifest.mjs',
  'packages/windows-containment/build/source-seal.mjs',
  'packages/windows-containment/native/core/resource.cc',
  'packages/windows-containment/native/core/resource_state.cc',
  'packages/windows-containment/native/include/pc_sdk_next/generated/resource_manifest.generated.h',
  'packages/windows-containment/native/include/pc_sdk_next/resource.h',
  'packages/windows-containment/native/include/pc_sdk_next/resource_manifest.h',
  'packages/windows-containment/native/include/pc_sdk_next/resource_state.h',
  'packages/windows-containment/native/resource-sites.json',
  'packages/windows-containment/native/test/fuzz/fuzz_manifest.cc',
  'packages/windows-containment/native/test/fuzz/fuzz_resource_state.cc',
  'packages/windows-containment/native/test/property/properties.cc',
  'packages/windows-containment/native/test/property/property_main.cc',
  'packages/windows-containment/qualification/run-fake-matrix.mjs',
  'packages/windows-containment/src/index.ts',
  'packages/windows-containment/src/resource-manifest.ts',
  'packages/windows-containment/test/resource-manifest.test.ts',
]);

const SCRIPT_PATH = fileURLToPath(import.meta.url);
const PACKAGE_ROOT = path.resolve(path.dirname(SCRIPT_PATH), '..');
const REPOSITORY_ROOT = path.resolve(PACKAGE_ROOT, '..', '..');
const NATIVE_INPUT_ROOT_PATH = path.join(
  REPOSITORY_ROOT,
  'docs',
  'execution',
  'manifests',
  ROOT_FILE_NAME,
);
const SOURCE_SEAL_PATH = path.join(
  REPOSITORY_ROOT,
  ...SOURCE_SEAL_RELATIVE_PATH.split('/'),
);
const SCANNED_SOURCE_ROOTS = Object.freeze([
  'packages/windows-containment/build',
  'packages/windows-containment/native',
  'packages/windows-containment/qualification',
  'packages/windows-containment/src',
  'packages/windows-containment/test',
]);
const MAX_DIRECTORY_DEPTH = 8;
const MAX_DIRECTORY_ENTRIES = 128;
const MAX_SOURCE_SEAL_BYTES = 1024 * 1024;

function ordinalCompare(left, right) {
  return left < right ? -1 : left > right ? 1 : 0;
}

function fail(code, message) {
  const error = new Error(`${code}: ${message}`);
  error.code = code;
  throw error;
}

function assertRepositoryRelativePath(value, label) {
  if (
    typeof value !== 'string'
    || value.length === 0
    || value.startsWith('/')
    || value.includes('\\')
    || value.split('/').some((segment) => segment === '' || segment === '.' || segment === '..')
  ) {
    fail('SOURCE_PATH_INVALID', `${label} is not a closed repository-relative path`);
  }
}

function repositoryPath(relativePath) {
  assertRepositoryRelativePath(relativePath, 'source path');
  const candidate = path.resolve(REPOSITORY_ROOT, ...relativePath.split('/'));
  const relative = path.relative(REPOSITORY_ROOT, candidate);
  if (
    relative === ''
    || relative === '..'
    || relative.startsWith(`..${path.sep}`)
    || path.isAbsolute(relative)
  ) {
    fail('SOURCE_PATH_ESCAPE', `${relativePath} resolves outside the repository`);
  }
  return candidate;
}

async function assertOrdinaryDirectory(directoryPath, label) {
  const information = await lstat(directoryPath);
  if (!information.isDirectory() || information.isSymbolicLink()) {
    fail('SOURCE_DIRECTORY_UNSAFE', `${label} must be an ordinary directory`);
  }
  return realpath(directoryPath);
}

async function enumerateSourceTree(relativeRoot, repositoryRealPath) {
  const absoluteRoot = repositoryPath(relativeRoot);
  const rootRealPath = await assertOrdinaryDirectory(absoluteRoot, relativeRoot);
  const rootRelative = path.relative(repositoryRealPath, rootRealPath);
  if (
    rootRelative === '..'
    || rootRelative.startsWith(`..${path.sep}`)
    || path.isAbsolute(rootRelative)
  ) {
    fail('SOURCE_DIRECTORY_ESCAPE', `${relativeRoot} resolves outside the repository`);
  }

  const files = [];
  const visit = async (directoryPath, relativeDirectory, depth) => {
    if (depth > MAX_DIRECTORY_DEPTH) {
      fail('SOURCE_DIRECTORY_DEPTH', `${relativeDirectory} exceeds the closed depth bound`);
    }
    const entries = await readdir(directoryPath, { withFileTypes: true });
    if (entries.length > MAX_DIRECTORY_ENTRIES) {
      fail('SOURCE_DIRECTORY_ENTRIES', `${relativeDirectory} exceeds the entry bound`);
    }
    entries.sort((left, right) => ordinalCompare(left.name, right.name));
    for (const entry of entries) {
      const relativePath = `${relativeDirectory}/${entry.name}`.replaceAll('\\', '/');
      const absolutePath = path.join(directoryPath, entry.name);
      if (entry.isSymbolicLink()) {
        fail('SOURCE_REPARSE_FORBIDDEN', `${relativePath} is a symbolic link or junction`);
      }
      if (entry.isDirectory()) {
        const childRealPath = await assertOrdinaryDirectory(absolutePath, relativePath);
        const relative = path.relative(repositoryRealPath, childRealPath);
        if (
          relative === '..'
          || relative.startsWith(`..${path.sep}`)
          || path.isAbsolute(relative)
        ) {
          fail('SOURCE_DIRECTORY_ESCAPE', `${relativePath} resolves outside the repository`);
        }
        await visit(absolutePath, relativePath, depth + 1);
        continue;
      }
      if (!entry.isFile()) {
        fail('SOURCE_ENTRY_UNSUPPORTED', `${relativePath} is not an ordinary file or directory`);
      }
      files.push(relativePath);
      if (files.length > SOURCE_PATHS.length) {
        fail('SOURCE_SET_EXPANDED', 'the implementation tree contains an unsealed source file');
      }
    }
  };
  await visit(absoluteRoot, relativeRoot, 0);
  return files;
}

async function assertExactSourceClosure() {
  const expected = [...SOURCE_PATHS].sort(ordinalCompare);
  if (
    expected.length !== SOURCE_PATHS.length
    || expected.some((entry, index) => entry !== SOURCE_PATHS[index])
    || new Set(expected).size !== expected.length
  ) {
    fail('SOURCE_AUTHORITY_INVALID', 'SOURCE_PATHS must be sorted and unique');
  }
  for (const [index, relativePath] of SOURCE_SEAL_EXCLUDED_PATHS.entries()) {
    assertRepositoryRelativePath(relativePath, `excluded path ${index}`);
    if (expected.includes(relativePath)) {
      fail('SOURCE_SELF_REFERENCE', `${relativePath} is both sealed and excluded`);
    }
  }

  const repositoryRealPath = await assertOrdinaryDirectory(
    REPOSITORY_ROOT,
    'repository root',
  );
  const actual = [];
  for (const relativeRoot of SCANNED_SOURCE_ROOTS) {
    actual.push(...await enumerateSourceTree(relativeRoot, repositoryRealPath));
  }
  actual.sort(ordinalCompare);
  if (
    actual.length !== expected.length
    || actual.some((entry, index) => entry !== expected[index])
  ) {
    const expectedSet = new Set(expected);
    const actualSet = new Set(actual);
    const missing = expected.filter((entry) => !actualSet.has(entry));
    const unexpected = actual.filter((entry) => !expectedSet.has(entry));
    fail(
      'SOURCE_SET_MISMATCH',
      `closed source set mismatch; missing=[${missing.join(', ')}]; unexpected=[${unexpected.join(', ')}]`,
    );
  }
}

export async function createSourceSeal() {
  await assertExactSourceClosure();
  const inputReceipt = await verifyManifestSet({ rootPath: NATIVE_INPUT_ROOT_PATH });
  const rows = [];
  for (const relativePath of SOURCE_PATHS) {
    const digest = await hashStableFile(
      repositoryPath(relativePath),
      `T3 source ${relativePath}`,
    );
    rows.push([relativePath, digest.byteLength, digest.sha256]);
  }
  const sourceSetBytes = canonicalJsonBytes(rows);
  const manifest = {
    authority: {
      nativeBuildInput: {
        byteLength: inputReceipt.rootByteLength,
        path: `docs/execution/manifests/${ROOT_FILE_NAME}`,
        sha256: inputReceipt.rootSha256,
      },
    },
    canonicalEncoding: {
      bom: false,
      characterEncoding: 'UTF-8',
      jsonForm: 'compact-recursively-key-sorted',
      lineBreaks: false,
      terminalNewline: false,
    },
    classification: SOURCE_SEAL_CLASSIFICATION,
    exclusionPolicy: {
      excludedOutputs: [...SOURCE_SEAL_EXCLUDED_PATHS],
      manifestSelfExcluded: true,
      receiptOutputsExcluded: true,
    },
    fileCount: rows.length,
    files: {
      fields: ['path', 'byteLength', 'sha256'],
      rows,
    },
    schemaVersion: SOURCE_SEAL_SCHEMA_VERSION,
    scope: {
      conclusion: 'resource-wrapper qualification only; full bootstrap/addon release unavailable',
      externalPmWrites: false,
      productionAdmission: false,
      productionComposition: false,
      providerProcesses: false,
      stableRepositoryMutation: false,
    },
    sourceByteLength: rows.reduce((total, row) => total + row[1], 0),
    sourceSetSha256: sha256Bytes(sourceSetBytes),
  };
  const bytes = canonicalJsonBytes(manifest);
  return {
    byteLength: bytes.length,
    bytes,
    fileCount: rows.length,
    manifest,
    path: SOURCE_SEAL_PATH,
    sha256: sha256Bytes(bytes),
    sourceSetSha256: manifest.sourceSetSha256,
  };
}

async function readOrdinaryFile(filePath, label) {
  const beforePath = await lstat(filePath, { bigint: true });
  if (
    !beforePath.isFile()
    || beforePath.isSymbolicLink()
    || beforePath.nlink !== 1n
    || beforePath.size < 0n
    || beforePath.size > BigInt(MAX_SOURCE_SEAL_BYTES)
  ) {
    fail('SOURCE_SEAL_FILE_UNSAFE', `${label} must be one ordinary single-link file`);
  }
  const handle = await open(filePath, fsConstants.O_RDONLY);
  try {
    const beforeHandle = await handle.stat({ bigint: true });
    const sameIdentity = (left, right) => {
      const devicesEqual = left.dev === 0n || right.dev === 0n || left.dev === right.dev;
      return devicesEqual
        && left.ino === right.ino
        && left.mode === right.mode
        && left.nlink === right.nlink
        && left.size === right.size
        && left.mtimeNs === right.mtimeNs
        && left.ctimeNs === right.ctimeNs;
    };
    if (
      !beforeHandle.isFile()
      || beforeHandle.nlink !== 1n
      || !sameIdentity(beforePath, beforeHandle)
    ) {
      fail('SOURCE_SEAL_CHANGED', `${label} changed while its read handle was opened`);
    }
    const byteLength = Number(beforeHandle.size);
    const readExactly = async () => {
      const bytes = Buffer.alloc(byteLength);
      let offset = 0;
      while (offset < byteLength) {
        const result = await handle.read(bytes, offset, byteLength - offset, offset);
        if (result.bytesRead === 0) {
          fail('SOURCE_SEAL_CHANGED', `${label} became truncated while being read`);
        }
        offset += result.bytesRead;
      }
      const trailing = Buffer.alloc(1);
      const trailingRead = await handle.read(trailing, 0, 1, byteLength);
      if (trailingRead.bytesRead !== 0) {
        fail('SOURCE_SEAL_CHANGED', `${label} grew while being read`);
      }
      return bytes;
    };
    const first = await readExactly();
    const second = await readExactly();
    if (!first.equals(second)) {
      fail('SOURCE_SEAL_CHANGED', `${label} changed while being read`);
    }
    const afterHandle = await handle.stat({ bigint: true });
    const afterPath = await lstat(filePath, { bigint: true });
    if (
      !afterPath.isFile()
      || afterPath.isSymbolicLink()
      || afterPath.nlink !== 1n
      || !sameIdentity(beforeHandle, afterHandle)
      || !sameIdentity(beforePath, afterPath)
    ) {
      fail('SOURCE_SEAL_CHANGED', `${label} identity changed while being read`);
    }
    return first;
  } finally {
    await handle.close();
  }
}

export async function verifySourceSeal({ includeFiles = false } = {}) {
  if (typeof includeFiles !== 'boolean') {
    fail('SOURCE_SEAL_OPTIONS_INVALID', 'includeFiles must be boolean');
  }
  const generated = await createSourceSeal();
  let trackedBytes;
  try {
    trackedBytes = await readOrdinaryFile(SOURCE_SEAL_PATH, SOURCE_SEAL_RELATIVE_PATH);
  } catch (error) {
    if (error?.code === 'ENOENT') {
      fail('SOURCE_SEAL_MISSING', `${SOURCE_SEAL_RELATIVE_PATH} is missing`);
    }
    throw error;
  }
  decodeCanonicalJsonBytes(trackedBytes, SOURCE_SEAL_RELATIVE_PATH);
  if (!trackedBytes.equals(generated.bytes)) {
    fail('SOURCE_SEAL_DRIFT', `${SOURCE_SEAL_RELATIVE_PATH} does not byte-equal regeneration`);
  }
  const receipt = {
    byteLength: generated.byteLength,
    fileCount: generated.fileCount,
    path: SOURCE_SEAL_RELATIVE_PATH,
    sha256: generated.sha256,
    sourceSetSha256: generated.sourceSetSha256,
    status: 'verified',
  };
  if (includeFiles) {
    receipt.files = generated.manifest.files.rows.map((row) => [...row]);
  }
  return receipt;
}

export async function writeSourceSeal() {
  const generated = await createSourceSeal();
  await mkdir(path.dirname(SOURCE_SEAL_PATH), { recursive: true });
  try {
    await writeFile(SOURCE_SEAL_PATH, generated.bytes, { flag: 'wx' });
  } catch (error) {
    if (error?.code !== 'EEXIST') {
      throw error;
    }
    const existing = await readOrdinaryFile(SOURCE_SEAL_PATH, SOURCE_SEAL_RELATIVE_PATH);
    if (!existing.equals(generated.bytes)) {
      fail(
        'SOURCE_SEAL_REPLACEMENT_REFUSED',
        `${SOURCE_SEAL_RELATIVE_PATH} exists with different bytes; recorded amendment required`,
      );
    }
  }
  return verifySourceSeal();
}

function parseArguments(argv) {
  if (argv.length !== 1 || !['--check', '--print', '--write'].includes(argv[0])) {
    fail('SOURCE_SEAL_USAGE', 'usage: node build/source-seal.mjs --check|--print|--write');
  }
  return argv[0];
}

export async function runSourceSealCli(argv = process.argv.slice(2)) {
  const mode = parseArguments(argv);
  if (mode === '--print') {
    const generated = await createSourceSeal();
    process.stdout.write(generated.bytes);
    process.stdout.write('\n');
    return;
  }
  const receipt = mode === '--write' ? await writeSourceSeal() : await verifySourceSeal();
  process.stdout.write(canonicalJsonBytes(receipt));
  process.stdout.write('\n');
}

const invokedPath = process.argv[1] === undefined
  ? undefined
  : pathToFileURL(path.resolve(process.argv[1])).href;
if (invokedPath === import.meta.url) {
  runSourceSealCli().catch((error) => {
    process.stderr.write(`${error?.message ?? String(error)}\n`);
    process.exitCode = 1;
  });
}
