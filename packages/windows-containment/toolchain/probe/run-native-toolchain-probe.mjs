import { createHash } from 'node:crypto';
import {
  copyFile,
  lstat,
  mkdir,
  readFile,
  readdir,
  realpath,
  stat,
  writeFile,
} from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  AUDIT_PLAN_SCHEMA,
  auditNativeBuildInputsWithinAuthority,
  replayNativeBuildInputsWithinAuthority,
} from '../audit-native-build-input.mjs';
import { assertReceiptPrivate } from '../preseal/preseal-evidence.mjs';
import { validateSealedRunnerBeforeInputRead } from '../preseal/runner-bootstrap.mjs';
import { prepareFilesystemAuditAuthority } from '../preseal/system-tool-authority.mjs';
import {
  createNativeToolchainProbeExecutionProfile,
  isAdmittedAsanNegativeTerminal,
} from './native-toolchain-probe-execution-profile.mjs';
import { parsePe, peConstants } from './pe-inspect.mjs';

const SCRIPT_DIRECTORY = path.dirname(fileURLToPath(import.meta.url));
const TOOLCHAIN_DIRECTORY = path.dirname(SCRIPT_DIRECTORY);
const DEFAULT_CONFIG_PATH = path.join(TOOLCHAIN_DIRECTORY, 'native-build-input.config.json');
const FIXTURE_DIRECTORY = path.join(SCRIPT_DIRECTORY, 'fixtures');
const MAX_CAPTURE_BYTES = 16 * 1024 * 1024;
const DEFAULT_TIMEOUT_MS = 120_000;
const INPUT_AUDIT_TIMEOUT_MS = 30 * 60 * 1000;
const RUN_ROOT_MARKER = '.cx004-native-probe-run.v1';
const PROBE_CACHE_MARKER = '.cx004-native-probe-root.v1';
const MARKER_BYTES = Buffer.from('pc-sdk-next cx-004 native probe path identity v1\n', 'utf8');
const EXPECTED_SYSTEM_ROOT = 'C:\\Windows';
let activeRedactor = (value) => String(value)
  .replace(/[A-Za-z]:[\\/]Users[\\/][^\\/\s"']+/giu, '${PROFILE_ROOT}')
  .replaceAll('\\', '/');
let activeRunId;

const REQUIRED_TOOL_IDS = Object.freeze([
  'cl',
  'link',
  'lib',
  'dumpbin',
  'rc',
  'mt',
  'clang-cl',
  'lld-link',
  'llvm-profdata',
  'llvm-cov',
  'llvm-symbolizer',
  'node',
]);

const RELEASE_FILES = Object.freeze([
  'msvc-static-crt-contract.h',
  'release-core.cc',
  'bootstrap.cc',
  'napi-direct-addon.cc',
  'sqlite-c-flags.c',
  'load-addon.cjs',
]);
const ALL_FIXTURE_FILES = Object.freeze([
  ...RELEASE_FILES,
  'asan-canary.cc',
  'llvm-fuzzer.cc',
  'llvm-coverage.cc',
]);

class ProbeFailure extends Error {
  constructor(code, message, detail = undefined) {
    super(message);
    this.name = 'ProbeFailure';
    this.code = code;
    this.detail = detail;
  }
}

function fail(code, message, detail = undefined) {
  throw new ProbeFailure(code, message, detail);
}

function invariant(condition, code, message, detail = undefined) {
  if (!condition) {
    fail(code, message, detail);
  }
}

function canonicalize(value) {
  if (Array.isArray(value)) {
    return value.map(canonicalize);
  }
  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(
      Object.keys(value).sort().map((key) => [key, canonicalize(value[key])]),
    );
  }
  return value;
}

function canonicalJson(value) {
  return JSON.stringify(canonicalize(value));
}

function sha256Bytes(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}

async function sha256File(filePath) {
  return sha256Bytes(await readFile(filePath));
}

function parseArguments(argv) {
  const options = {};
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === '--help') {
      options.help = true;
    } else {
      fail('ARGUMENT_UNSUPPORTED', `unsupported argument ${JSON.stringify(argument)}`);
    }
  }
  return options;
}

function validateProbeNodeEnvironment(environment = process.env) {
  const nonemptyNodeKeys = Object.entries(environment)
    .filter(([name, value]) => /^NODE_/iu.test(name) && value !== undefined && value !== '')
    .map(([name]) => name)
    .sort();
  invariant(
    nonemptyNodeKeys.length === 0,
    'RUNNER_NODE_ENVIRONMENT_FORBIDDEN',
    `probe invocation requires every NODE_* setting absent; observed ${nonemptyNodeKeys.join(', ')}`,
  );
  return { nodeEnvironmentEmpty: true };
}

function normalizedPath(value) {
  return path.normalize(value).toLocaleLowerCase('en-US');
}

function isPathWithin(candidate, root) {
  const relative = path.relative(root, candidate);
  return relative === '' || (
    relative !== '..'
    && !relative.startsWith(`..${path.sep}`)
    && !path.isAbsolute(relative)
  );
}

function pathsOverlap(left, right) {
  return isPathWithin(left, right) || isPathWithin(right, left);
}

function assertSystemRootAuthority(systemRoot, windir, configuredRoot = EXPECTED_SYSTEM_ROOT) {
  invariant(
    normalizedPath(configuredRoot) === normalizedPath(EXPECTED_SYSTEM_ROOT)
      && normalizedPath(systemRoot) === normalizedPath(configuredRoot)
      && normalizedPath(windir) === normalizedPath(configuredRoot),
    'SYSTEM_ROOT_AUTHORITY_MISMATCH',
    'SystemRoot, WINDIR, and the sealed system location must all equal C:/Windows',
  );
  return path.normalize(configuredRoot);
}

function selectedEnvironment(name) {
  const allowed = new Set(['LOCALAPPDATA', 'SystemRoot', 'WINDIR']);
  invariant(allowed.has(name), 'ENVIRONMENT_NOT_ALLOWED', `configuration requested forbidden environment variable ${name}`);
  const value = process.env[name];
  invariant(typeof value === 'string' && value.length !== 0, 'ENVIRONMENT_MISSING', `${name} is required`);
  return value;
}

function resolveLocation(configDirectory, specification) {
  if (typeof specification === 'string') {
    return path.isAbsolute(specification)
      ? path.normalize(specification)
      : path.resolve(configDirectory, specification);
  }
  invariant(
    specification !== null
      && typeof specification === 'object'
      && typeof specification.env === 'string'
      && typeof specification.relativeRoot === 'string',
    'LOCATION_INVALID',
    'location must be an absolute/relative string or {env,relativeRoot}',
  );
  return path.resolve(selectedEnvironment(specification.env), specification.relativeRoot);
}

function createLogicalResolver(config, configDirectory) {
  const locations = Object.fromEntries(
    Object.entries(config.locations).map(([id, specification]) => [id, resolveLocation(configDirectory, specification)]),
  );
  const mappings = [];
  for (const surface of config.surfaces) {
    for (const source of surface.sources) {
      mappings.push({
        actualRoot: path.resolve(locations[source.location], source.relativeRoot),
        logicalPrefix: source.logicalPrefix.replaceAll('\\', '/').replace(/\/$/, ''),
        surfaceId: surface.surfaceId,
      });
    }
  }
  mappings.sort((left, right) => right.logicalPrefix.length - left.logicalPrefix.length);
  invariant(typeof locations.system === 'string', 'SYSTEM_LOCATION_MISSING', 'configuration omits the sealed system location');
  const systemRoot = assertSystemRootAuthority(
    selectedEnvironment('SystemRoot'),
    selectedEnvironment('WINDIR'),
    locations.system,
  );
  const resolveLogical = (logicalPath) => {
    const normalized = logicalPath.replaceAll('\\', '/').replace(/^\.\//, '');
    if (normalized === 'windows/System32' || normalized.startsWith('windows/System32/')) {
      const suffix = normalized.slice('windows/System32'.length).replace(/^\//, '');
      return path.resolve(systemRoot, 'System32', ...suffix.split('/').filter(Boolean));
    }
    for (const mapping of mappings) {
      if (normalized === mapping.logicalPrefix || normalized.startsWith(`${mapping.logicalPrefix}/`)) {
        const suffix = normalized.slice(mapping.logicalPrefix.length).replace(/^\//, '');
        return path.resolve(mapping.actualRoot, ...suffix.split('/').filter(Boolean));
      }
    }
    for (const [locationId, root] of Object.entries(locations)) {
      if (normalized === locationId || normalized.startsWith(`${locationId}/`)) {
        const suffix = normalized.slice(locationId.length).replace(/^\//, '');
        return path.resolve(root, ...suffix.split('/').filter(Boolean));
      }
    }
    fail('LOGICAL_PATH_UNRESOLVED', `no sealed location resolves logical path ${JSON.stringify(logicalPath)}`);
  };
  return { locations, mappings, resolveLogical, systemRoot };
}

function createRedactor(roots) {
  const replacements = Object.entries(roots)
    .filter(([, value]) => typeof value === 'string' && value.length !== 0)
    .sort((left, right) => right[1].length - left[1].length);
  return (input) => {
    let output = String(input);
    for (const [label, root] of replacements) {
      const escaped = root.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      output = output.replace(new RegExp(escaped, 'gi'), `\${${label}}`);
    }
    return output.replaceAll('\\', '/');
  };
}

function findRecipe(config, id) {
  const recipe = config.root.buildRecipes.find((candidate) => candidate.id === id);
  invariant(recipe !== undefined, 'RECIPE_MISSING', `native-build-input is missing recipe ${id}`);
  return recipe;
}

function expandTokens(values, replacements) {
  return values.map((value) => {
    let expanded = value;
    for (const [name, replacement] of Object.entries(replacements)) {
      expanded = expanded.replaceAll(`\${${name}}`, replacement);
    }
    const unresolved = expanded.match(/\$\{[A-Z0-9_]+\}/u);
    invariant(unresolved === null, 'RECIPE_TOKEN_UNRESOLVED', `unresolved recipe token ${unresolved?.[0] ?? ''}`);
    return expanded;
  });
}

async function assertOrdinaryFile(filePath, label) {
  const information = await lstat(filePath);
  invariant(information.isFile() && !information.isSymbolicLink(), 'INPUT_NOT_FILE', `${label} is not an ordinary non-link file`);
  return information;
}

async function verifyTools(config, resolver) {
  const tuples = new Map(config.root.hostToolchain.tools.map((tuple) => [tuple[0], tuple]));
  const tools = {};
  const identities = {};
  for (const id of REQUIRED_TOOL_IDS) {
    const tuple = tuples.get(id);
    invariant(tuple !== undefined, 'TOOL_NOT_DECLARED', `sealed tool tuple ${id} is missing`);
    const [tupleId, logicalPath, expectedBytes, version, expectedSha256] = tuple;
    const filePath = resolver.resolveLogical(logicalPath);
    const information = await assertOrdinaryFile(filePath, `tool ${id}`);
    const actualSha256 = await sha256File(filePath);
    invariant(information.size === expectedBytes, 'TOOL_SIZE_MISMATCH', `${id} byte length changed`, {
      actual: information.size,
      expected: expectedBytes,
    });
    invariant(actualSha256 === expectedSha256, 'TOOL_HASH_MISMATCH', `${id} SHA-256 changed`);
    tools[tupleId] = filePath;
    identities[tupleId] = { bytes: expectedBytes, logicalPath, sha256: expectedSha256, version };
  }
  const currentNodeHash = await sha256File(process.execPath);
  invariant(
    currentNodeHash === identities.node.sha256,
    'ORCHESTRATOR_NODE_MISMATCH',
    'invoke the probe with the exact sealed Node 22.13.0 executable',
  );
  return { identities, tools };
}

async function verifyNodeLibrary(config, resolver) {
  const nodeInput = config.root.officialInputs.find((input) => input.id === 'node-v22.13.0-win-x64');
  invariant(nodeInput !== undefined, 'NODE_INPUT_MISSING', 'official Node input is missing');
  const library = nodeInput.assets.find((asset) => asset.role === 'official-amd64-import-library');
  invariant(library !== undefined, 'NODE_LIBRARY_IDENTITY_MISSING', 'official node.lib identity is missing');
  const nodeLibraryPath = resolver.resolveLogical('node-sdk/Release/node.lib');
  const information = await assertOrdinaryFile(nodeLibraryPath, 'sealed node.lib');
  invariant(information.size === library.bytes, 'NODE_LIBRARY_SIZE_MISMATCH', 'sealed node.lib byte length changed');
  invariant(await sha256File(nodeLibraryPath) === library.sha256, 'NODE_LIBRARY_HASH_MISMATCH', 'sealed node.lib SHA-256 changed');
  const nodeIncludePath = resolver.resolveLogical('node-sdk/include/node');
  await assertOrdinaryFile(path.join(nodeIncludePath, 'node_api.h'), 'sealed node_api.h');
  await assertOrdinaryFile(path.join(nodeIncludePath, 'js_native_api.h'), 'sealed js_native_api.h');
  return { nodeIncludePath, nodeLibraryPath, nodeLibrarySha256: library.sha256 };
}

async function verifyLlvmRuntimes(config, resolver) {
  const llvm = config.root.officialInputs.find((input) => input.id === 'llvm-19.1.7-windows-msvc');
  invariant(llvm !== undefined, 'LLVM_INPUT_MISSING', 'official LLVM input is missing');
  const identities = {};
  for (const [name, expectedSha256] of llvm.selectedRuntime.runtimeHashes) {
    const logicalPath = `llvm/lib/clang/19/lib/windows/${name}`;
    const filePath = resolver.resolveLogical(logicalPath);
    await assertOrdinaryFile(filePath, `LLVM runtime ${name}`);
    invariant(await sha256File(filePath) === expectedSha256, 'LLVM_RUNTIME_HASH_MISMATCH', `${name} SHA-256 changed`);
    identities[name] = { logicalPath, sha256: expectedSha256 };
  }
  for (const required of [
    'clang_rt.asan-x86_64.lib',
    'clang_rt.asan_cxx-x86_64.lib',
    'clang_rt.fuzzer-x86_64.lib',
    'clang_rt.profile-x86_64.lib',
  ]) {
    invariant(Object.hasOwn(identities, required), 'LLVM_SELECTED_RUNTIME_MISSING', `selected runtime list omits ${required}`);
  }
  return identities;
}

async function verifyMsvcAsanRuntime(config, tools) {
  const expectedSha256 = config.root.hostToolchain.verificationArtifacts.msvcAsanDllSha256;
  invariant(typeof expectedSha256 === 'string' && expectedSha256.length === 64, 'MSVC_ASAN_IDENTITY_MISSING', 'MSVC ASan runtime identity is missing');
  const filePath = path.join(path.dirname(tools.cl), 'clang_rt.asan_dynamic-x86_64.dll');
  const information = await assertOrdinaryFile(filePath, 'MSVC ASan runtime');
  invariant(await sha256File(filePath) === expectedSha256, 'MSVC_ASAN_HASH_MISMATCH', 'MSVC ASan runtime SHA-256 changed');
  return { bytes: information.size, filePath, sha256: expectedSha256 };
}

function buildEnvironment(config, resolver, temporaryDirectory) {
  const projection = config.root.hostToolchain.buildEnvironment;
  invariant(projection.id === 'cx004-build-environment-v1', 'BUILD_ENVIRONMENT_ID_MISMATCH', 'unexpected build environment projection');
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

async function runCommand(context, options) {
  const {
    args,
    cwd,
    env = context.environment,
    expectedExit = (exitCode) => exitCode === 0,
    label,
    maxOutputBytes = MAX_CAPTURE_BYTES,
    timeoutMs = DEFAULT_TIMEOUT_MS,
    tool,
  } = options;
  let result;
  try {
    result = await context.executionProfile.run({
      args,
      cwd,
      env,
      expectedExit,
      label,
      maxOutputBytes,
      timeoutMs,
      tool,
    });
  } catch (error) {
    fail('COMMAND_FAILED', `${label} failed`, context.redact(error.message));
  }
  invariant(
    expectedExit(result.exitCode, result.signal),
    'COMMAND_EXIT_POLICY_MISMATCH',
    `${label} failed with exit ${result.exitCode ?? 'null'} signal ${result.signal ?? 'none'}`,
    context.redact(result.stderr.toString('utf8').slice(-4000)),
  );
  return {
    ...result,
    stderrText: result.stderr.toString('utf8'),
    stdoutText: result.stdout.toString('utf8'),
  };
}

async function copyFixtures(targetRoot, names) {
  const sourceDirectory = path.join(targetRoot, 'src');
  const outputDirectory = path.join(targetRoot, 'out');
  await mkdir(sourceDirectory, { recursive: false });
  await mkdir(outputDirectory, { recursive: false });
  for (const name of names) {
    const source = path.join(FIXTURE_DIRECTORY, name);
    await assertOrdinaryFile(source, `tracked fixture ${name}`);
    const destination = path.join(sourceDirectory, name);
    const expectedSha256 = await sha256File(source);
    await copyFile(source, destination);
    invariant(await sha256File(destination) === expectedSha256, 'FIXTURE_COPY_HASH_MISMATCH', `copied fixture ${name} changed`);
  }
  return { outputDirectory, sourceDirectory };
}

async function verifyFixtureIdentities() {
  const identities = {};
  for (const name of ALL_FIXTURE_FILES) {
    const filePath = path.join(FIXTURE_DIRECTORY, name);
    const information = await assertOrdinaryFile(filePath, `tracked fixture ${name}`);
    identities[name] = { bytes: information.size, sha256: await sha256File(filePath) };
  }
  return identities;
}

function defineArguments(defines) {
  return defines.map((definition) => `/D${definition}`);
}

function includeArguments(includes) {
  return includes.map((include) => `/I${include}`);
}

async function buildInputDigestResource(context, buildRoot, outputDirectory, label) {
  const recipe = findRecipe(context.config, 'msvc-input-manifest-resource');
  invariant(recipe.resourceCompiler === context.toolIdentities.rc.logicalPath, 'RESOURCE_COMPILER_MISMATCH', 'resource recipe does not select the sealed rc.exe tuple');
  invariant(
    canonicalJson(recipe.resourcePayloadTupleSchema) === canonicalJson([
      'resourceName',
      'resourceType',
      'source',
      'encoding',
      'bytes',
      'value',
    ]),
    'RESOURCE_PAYLOAD_SCHEMA_MISMATCH',
    'resource recipe payload tuple schema changed',
  );
  invariant(Array.isArray(recipe.resourcePayloads) && recipe.resourcePayloads.length === 1, 'RESOURCE_PAYLOAD_COUNT_MISMATCH', 'resource recipe must declare exactly one payload');
  const [resourceName, resourceType, source, encoding, byteLength] = recipe.resourcePayloads[0];
  invariant(resourceName === 'PCSDK_CX004_NATIVE_BUILD_INPUT_SHA256', 'RESOURCE_NAME_MISMATCH', 'resource recipe changed the input-digest resource name');
  invariant(resourceType === 'RCDATA' && encoding === 'raw-sha256' && byteLength === 32, 'RESOURCE_ENCODING_MISMATCH', 'resource recipe does not declare one raw 32-byte RCDATA digest');
  invariant(source === 'generated/CX-004-native-build-input.sha256.bin', 'RESOURCE_SOURCE_MISMATCH', 'resource recipe changed the generated digest source');
  invariant(recipe.entryPoint === 'generated/cx004-native-build-input-digest.rc', 'RESOURCE_ENTRY_POINT_MISMATCH', 'resource recipe changed the generated .rc entry point');
  const generatedDirectory = path.join(buildRoot, 'generated');
  await mkdir(generatedDirectory, { recursive: false });
  const digestPath = path.join(buildRoot, ...source.split('/'));
  const rcPath = path.join(buildRoot, ...recipe.entryPoint.split('/'));
  const resPath = path.join(outputDirectory, 'cx004-native-build-input-digest.res');
  const digestBytes = Buffer.from(context.inputManifest.rootSha256, 'hex');
  invariant(digestBytes.length === 32, 'INPUT_MANIFEST_DIGEST_INVALID', 'audited input-manifest root SHA-256 is not 32 bytes');
  await writeFile(digestPath, digestBytes, { flag: 'wx' });
  await writeFile(
    rcPath,
    Buffer.from(`${resourceName} ${resourceType} "${path.basename(digestPath)}"\n`, 'ascii'),
    { flag: 'wx' },
  );
  const replacements = { INPUT_MANIFEST_RC: rcPath, INPUT_MANIFEST_RES: resPath };
  await runCommand(context, {
    args: expandTokens(recipe.resourceFlags, replacements),
    cwd: generatedDirectory,
    label: `${label}-compile-input-digest-resource`,
    tool: 'rc',
  });
  await assertOrdinaryFile(resPath, `${label} compiled input-digest resource`);
  return { digestPath, rcPath, resPath };
}

async function buildRelease(context, buildRoot, label) {
  const directories = await copyFixtures(buildRoot, RELEASE_FILES);
  const coreRecipe = findRecipe(context.config, 'msvc-release-core');
  const bootstrapRecipe = findRecipe(context.config, 'msvc-release-bootstrap');
  const addonRecipe = findRecipe(context.config, 'msvc-release-addon');
  const sqliteRecipe = findRecipe(context.config, 'node-gyp-release-sqlite');
  const paths = {
    addon: path.join(directories.outputDirectory, 'pc_sdk_next_containment_probe.node'),
    addonObject: path.join(directories.outputDirectory, 'napi-direct-addon.obj'),
    bootstrap: path.join(directories.outputDirectory, 'pc-sdk-next-bootstrap-probe.exe'),
    bootstrapObject: path.join(directories.outputDirectory, 'bootstrap.obj'),
    coreLibrary: path.join(directories.outputDirectory, 'pc-sdk-next-core-probe.lib'),
    coreObject: path.join(directories.outputDirectory, 'release-core.obj'),
    loader: path.join(directories.sourceDirectory, 'load-addon.cjs'),
    sqliteCObject: path.join(directories.outputDirectory, 'sqlite-c-flags.obj'),
  };
  const resource = await buildInputDigestResource(
    context,
    buildRoot,
    directories.outputDirectory,
    label,
  );
  const replacements = { BUILD_ROOT: buildRoot, CORE_LIB: paths.coreLibrary };
  await runCommand(context, {
    args: [
      ...expandTokens(coreRecipe.compileFlags, replacements),
      ...defineArguments(coreRecipe.defines),
      `/Fo${paths.coreObject}`,
      path.join(directories.sourceDirectory, 'release-core.cc'),
    ],
    cwd: buildRoot,
    label: `${label}-compile-core`,
    tool: 'cl',
  });
  await runCommand(context, {
    args: [
      ...expandTokens(coreRecipe.libraryFlags, replacements),
      paths.coreObject,
    ],
    cwd: buildRoot,
    label: `${label}-archive-core`,
    tool: 'lib',
  });
  await runCommand(context, {
    args: [
      ...expandTokens(bootstrapRecipe.compileFlags, replacements),
      ...defineArguments(bootstrapRecipe.defines),
      `/Fo${paths.bootstrapObject}`,
      path.join(directories.sourceDirectory, 'bootstrap.cc'),
    ],
    cwd: buildRoot,
    label: `${label}-compile-bootstrap`,
    tool: 'cl',
  });
  await runStaticCrtLink(context, {
    args: [
      ...expandTokens(bootstrapRecipe.linkFlags, replacements),
      `/OUT:${paths.bootstrap}`,
      paths.bootstrapObject,
      paths.coreLibrary,
      resource.resPath,
      ...bootstrapRecipe.libraries,
    ],
    cwd: buildRoot,
    label: `${label}-link-bootstrap`,
    tool: 'link',
  }, `${label}/bootstrap`);
  await runCommand(context, {
    args: [
      ...expandTokens(addonRecipe.compileFlags, replacements),
      ...defineArguments(addonRecipe.defines),
      ...includeArguments([context.nodeIncludePath]),
      `/Fo${paths.addonObject}`,
      path.join(directories.sourceDirectory, 'napi-direct-addon.cc'),
    ],
    cwd: buildRoot,
    label: `${label}-compile-addon`,
    tool: 'cl',
  });
  const addonLibraries = addonRecipe.libraries.map((library) => library.toLowerCase() === 'node.lib'
    ? context.nodeLibraryPath
    : library);
  await runStaticCrtLink(context, {
    args: [
      ...expandTokens(addonRecipe.linkFlags, replacements),
      `/OUT:${paths.addon}`,
      paths.addonObject,
      paths.coreLibrary,
      resource.resPath,
      ...addonLibraries,
    ],
    cwd: buildRoot,
    label: `${label}-link-addon`,
    tool: 'link',
  }, `${label}/addon`);
  await runCommand(context, {
    args: [
      ...expandTokens(sqliteRecipe.compileFlagsC, replacements),
      ...defineArguments(sqliteRecipe.defines),
      `/Fo${paths.sqliteCObject}`,
      path.join(directories.sourceDirectory, 'sqlite-c-flags.c'),
    ],
    cwd: buildRoot,
    label: `${label}-compile-sqlite-c-flags`,
    tool: 'cl',
  });
  return {
    ...directories,
    ...paths,
    inputManifestDigest: resource.digestPath,
    inputManifestRc: resource.rcPath,
    inputManifestResource: resource.resPath,
  };
}

function assertStaticCrtDirectives(text, label) {
  invariant(/(?:defaultlib:)["']?libcmt(?:\.lib)?["']?/iu.test(text), 'STATIC_CRT_DIRECTIVE_MISSING', `${label} does not declare LIBCMT`);
  invariant(!/(?:defaultlib:)["']?msvcrt(?:\.lib)?["']?/iu.test(text), 'DYNAMIC_CRT_DIRECTIVE_PRESENT', `${label} declares MSVCRT`);
}

function assertReleaseStaticRuntimeFlags(flags, label) {
  invariant(Array.isArray(flags), 'RELEASE_RUNTIME_FLAGS_INVALID', `${label} flags are missing`);
  const normalized = flags.map((flag) => String(flag).toLocaleUpperCase('en-US'));
  const runtimeSelectors = normalized.filter((flag) => ['/MT', '/MTD', '/MD', '/MDD'].includes(flag));
  invariant(
    runtimeSelectors.length === 1 && runtimeSelectors[0] === '/MT',
    'RELEASE_STATIC_CRT_SELECTION_INVALID',
    `${label} must select exactly the retail static CRT with /MT`,
  );
  invariant(normalized.includes('/GL'), 'RELEASE_LTCG_COMPILE_MISSING', `${label} does not select /GL`);
  invariant(!normalized.includes('/ZL'), 'RELEASE_DEFAULT_LIBRARY_OMITTED', `${label} suppresses default-library selection`);
  invariant(
    !normalized.some((flag) => flag === '/LD' || flag === '/LDD'),
    'RELEASE_DLL_COMPILE_MODE_FORBIDDEN',
    `${label} selects compiler-managed DLL mode`,
  );
}

function assertReleaseStaticRuntimePolicy(config) {
  const recipe = (id) => findRecipe(config, id);
  assertReleaseStaticRuntimeFlags(recipe('msvc-release-core').compileFlags, 'msvc-release-core.compileFlags');
  assertReleaseStaticRuntimeFlags(recipe('msvc-release-bootstrap').compileFlags, 'msvc-release-bootstrap.compileFlags');
  assertReleaseStaticRuntimeFlags(recipe('msvc-release-addon').compileFlags, 'msvc-release-addon.compileFlags');
  assertReleaseStaticRuntimeFlags(recipe('node-gyp-release-sqlite').compileFlagsC, 'node-gyp-release-sqlite.compileFlagsC');
  assertReleaseStaticRuntimeFlags(recipe('node-gyp-release-sqlite').compileFlagsCxx, 'node-gyp-release-sqlite.compileFlagsCxx');
  for (const id of ['msvc-release-bootstrap', 'msvc-release-addon', 'node-gyp-release-sqlite']) {
    const linkFlags = recipe(id).linkFlags.map((flag) => flag.toLocaleUpperCase('en-US'));
    invariant(linkFlags.includes('/LTCG'), 'RELEASE_LTCG_LINK_MISSING', `${id} does not select /LTCG`);
    invariant(linkFlags.includes('/VERBOSE:LIB'), 'RELEASE_LINK_TRACE_MISSING', `${id} does not select /VERBOSE:LIB`);
  }
}

function assertStaticCrtLinkTrace(text, label) {
  const libraries = new Set(
    [...text.matchAll(/(?:^|[\\/:\s])([A-Za-z0-9_.-]+\.lib)(?=[:\s]|$)/gmu)]
      .map((match) => match[1].toLocaleLowerCase('en-US')),
  );
  for (const required of ['libcmt.lib', 'libvcruntime.lib', 'libucrt.lib']) {
    invariant(libraries.has(required), 'STATIC_CRT_LINK_TRACE_MISSING', `${label} did not search ${required}`);
  }
  for (const forbidden of [
    'msvcrt.lib',
    'msvcrtd.lib',
    'libcmtd.lib',
    'vcruntime.lib',
    'vcruntimed.lib',
    'libvcruntimed.lib',
    'ucrt.lib',
    'ucrtd.lib',
    'libucrtd.lib',
  ]) {
    invariant(!libraries.has(forbidden), 'DYNAMIC_OR_DEBUG_CRT_LINK_TRACE', `${label} searched forbidden ${forbidden}`);
  }
  return [...libraries].sort();
}

async function runStaticCrtLink(context, options, label) {
  const result = await runCommand(context, options);
  assertStaticCrtLinkTrace(`${result.stdoutText}\n${result.stderrText}`, label);
  return result;
}

function parseHex(value) {
  return BigInt(value);
}

function assertGuardEhContinuationConsistency(loadConfig, artifactId) {
  const tablePresent = parseHex(loadConfig.guardEhContinuationTable) !== 0n;
  const countPresent = parseHex(loadConfig.guardEhContinuationCount) > 0n;
  invariant(
    tablePresent === countPresent,
    'PE_EH_CONTINUATION_STATE_INCONSISTENT',
    `${artifactId} Guard EH continuation table/count disagree`,
  );
}

function assertSectionPolicy(sections, allowedNames, artifactId) {
  const allowed = new Set(allowedNames);
  const classes = new Map([
    ['.text', { executable: true, readable: true, writable: false }],
    ['.data', { executable: false, readable: true, writable: true }],
    ['.pdata', { executable: false, readable: true, writable: false }],
    ['.rdata', { executable: false, readable: true, writable: false }],
    ['.reloc', { executable: false, readable: true, writable: false }],
    ['.rsrc', { executable: false, readable: true, writable: false }],
    ['_RDATA', { executable: false, readable: true, writable: false }],
  ]);
  for (const section of sections) {
    invariant(allowed.has(section.name), 'PE_SECTION_UNEXPECTED', `${artifactId} has unexpected section ${section.name}`);
    invariant((section.characteristics & peConstants.IMAGE_SCN_MEM_SHARED) === 0, 'PE_SECTION_SHARED', `${artifactId} has shared section ${section.name}`);
    const expected = classes.get(section.name);
    invariant(expected !== undefined, 'PE_SECTION_CLASS_UNDECLARED', `${artifactId} section ${section.name} has no closed memory class`);
    invariant(
      section.executable === expected.executable
        && section.readable === expected.readable
        && section.writable === expected.writable,
      'PE_SECTION_MEMORY_CLASS_MISMATCH',
      `${artifactId} section ${section.name} does not equal its required R/W/X class`,
    );
    if (section.name === '.reloc') {
      invariant(
        (section.characteristics & peConstants.IMAGE_SCN_MEM_DISCARDABLE) !== 0,
        'PE_RELOC_NOT_DISCARDABLE',
        `${artifactId} .reloc is not discardable`,
      );
    }
  }
}

function assertReleasePe(parsed, policy, artifactId) {
  invariant(parsed.machine === peConstants.IMAGE_FILE_MACHINE_AMD64, 'PE_MACHINE_MISMATCH', `${artifactId} is not AMD64`);
  invariant(parsed.subsystem === peConstants.IMAGE_SUBSYSTEM_WINDOWS_GUI, 'PE_SUBSYSTEM_MISMATCH', `${artifactId} is not Windows GUI subsystem`);
  invariant(parsed.subsystemVersion.major === 10 && parsed.subsystemVersion.minor === 0, 'PE_SUBSYSTEM_VERSION_MISMATCH', `${artifactId} subsystem version is not 10.00`);
  const requiredDllBits = peConstants.IMAGE_DLLCHARACTERISTICS_HIGH_ENTROPY_VA
    | peConstants.IMAGE_DLLCHARACTERISTICS_DYNAMIC_BASE
    | peConstants.IMAGE_DLLCHARACTERISTICS_NX_COMPAT
    | peConstants.IMAGE_DLLCHARACTERISTICS_GUARD_CF;
  invariant((parsed.dllCharacteristics & requiredDllBits) === requiredDllBits, 'PE_DLL_CHARACTERISTICS_MISSING', `${artifactId} lacks required ASLR/NX/CFG bits`);
  invariant(
    (parsed.exDllCharacteristics & peConstants.IMAGE_DLLCHARACTERISTICS_EX_CET_COMPAT) !== 0,
    'PE_CET_MISSING',
    `${artifactId} lacks CET compatibility`,
  );
  invariant(parsed.baseRelocationDirectory.rva !== 0 && parsed.baseRelocationDirectory.size !== 0, 'PE_RELOCATIONS_MISSING', `${artifactId} lacks base relocations`);
  invariant(parsed.checksum !== 0, 'PE_RELEASE_CHECKSUM_MISSING', `${artifactId} has a zero /RELEASE checksum`);
  invariant(parsed.delayImportDirectory.rva === 0 && parsed.delayImportDirectory.size === 0, 'PE_DELAY_IMPORT_PRESENT', `${artifactId} has a delay-import directory`);
  invariant(parsed.debug.some((entry) => entry.reproducible), 'PE_REPRO_RECORD_MISSING', `${artifactId} lacks a reproducible-build debug record`);
  assertSectionPolicy(parsed.sections, policy.sections.allowed, artifactId);
  invariant(parsed.sections.some((section) => section.name === '.reloc'), 'PE_RELOC_SECTION_MISSING', `${artifactId} lacks a discardable .reloc section`);
  invariant(!parsed.sections.some((section) => section.name === '.tls'), 'PE_TLS_SECTION_FORBIDDEN', `${artifactId} contains .tls`);
  const loadConfig = parsed.loadConfig;
  invariant(loadConfig !== undefined, 'PE_LOAD_CONFIG_MISSING', `${artifactId} lacks load configuration`);
  invariant(loadConfig.dependentLoadFlags === 0x800, 'PE_DEPENDENT_LOAD_FLAGS_MISMATCH', `${artifactId} DependentLoadFlags is not 0x800`);
  invariant(parseHex(loadConfig.securityCookie) !== 0n, 'PE_SECURITY_COOKIE_MISSING', `${artifactId} security cookie is zero`);
  invariant(parseHex(loadConfig.guardCfCheckPointer) !== 0n, 'PE_CFG_CHECK_POINTER_MISSING', `${artifactId} Guard CF check pointer is zero`);
  invariant(parseHex(loadConfig.guardCfDispatchPointer) !== 0n, 'PE_CFG_DISPATCH_POINTER_MISSING', `${artifactId} Guard CF dispatch pointer is zero`);
  invariant(parseHex(loadConfig.guardCfFunctionTable) !== 0n, 'PE_CFG_TABLE_MISSING', `${artifactId} Guard CF function table is zero`);
  invariant(parseHex(loadConfig.guardCfFunctionCount) > 0n, 'PE_CFG_COUNT_MISSING', `${artifactId} Guard CF function count is zero`);
  const requiredGuardFlags = peConstants.IMAGE_GUARD_CF_INSTRUMENTED | peConstants.IMAGE_GUARD_CF_FUNCTION_TABLE_PRESENT;
  invariant((loadConfig.guardFlags & requiredGuardFlags) === requiredGuardFlags, 'PE_CFG_FLAGS_MISSING', `${artifactId} Guard flags omit instrumentation/table bits`);
  assertGuardEhContinuationConsistency(loadConfig, artifactId);
  const allowedImports = new Set(policy.directImports.allowed.map((name) => name.toUpperCase()));
  for (const imported of parsed.imports) {
    invariant(allowedImports.has(imported.toUpperCase()), 'PE_IMPORT_UNEXPECTED', `${artifactId} imports undeclared ${imported}`);
    invariant(!/^(?:VCRUNTIME|MSVCP|UCRTBASE|API-MS-WIN-CRT)/iu.test(imported), 'PE_DYNAMIC_CRT_IMPORT', `${artifactId} imports dynamic CRT ${imported}`);
  }
}

function summarizePe(parsed) {
  return {
    checksum: `0x${parsed.checksum.toString(16)}`,
    delayImportDirectory: parsed.delayImportDirectory,
    dllCharacteristics: `0x${parsed.dllCharacteristics.toString(16)}`,
    exDllCharacteristics: `0x${parsed.exDllCharacteristics.toString(16)}`,
    exportDirectory: parsed.exportDirectory,
    exports: parsed.exports,
    imports: parsed.imports,
    loadConfig: parsed.loadConfig,
    machine: `0x${parsed.machine.toString(16)}`,
    resources: parsed.resources.map((resource) => ({
      bytes: resource.data.length,
      codePage: resource.codePage,
      language: resource.language,
      name: resource.name,
      sha256: sha256Bytes(resource.data),
      type: resource.type,
    })),
    sections: parsed.sections.map((section) => ({
      characteristics: `0x${section.characteristics.toString(16)}`,
      name: section.name,
      rawSize: section.rawSize,
      virtualSize: section.virtualSize,
    })),
    subsystem: parsed.subsystem,
    subsystemVersion: parsed.subsystemVersion,
  };
}

function assertEmbeddedInputDigest(parsed, expectedRootSha256, artifactId) {
  const matches = parsed.resources.filter((resource) => (
    resource.type === 10
    && resource.name === 'PCSDK_CX004_NATIVE_BUILD_INPUT_SHA256'
  ));
  invariant(matches.length === 1, 'PE_INPUT_DIGEST_RESOURCE_COUNT_MISMATCH', `${artifactId} does not contain exactly one named RCDATA input digest`);
  const expected = Buffer.from(expectedRootSha256, 'hex');
  invariant(matches[0].data.length === 32, 'PE_INPUT_DIGEST_RESOURCE_SIZE_MISMATCH', `${artifactId} input digest resource is not 32 bytes`);
  invariant(matches[0].data.equals(expected), 'PE_INPUT_DIGEST_RESOURCE_MISMATCH', `${artifactId} input digest resource does not equal the audited root SHA-256`);
}

function assertQualificationPe(parsed, artifactId) {
  invariant(parsed.machine === peConstants.IMAGE_FILE_MACHINE_AMD64, 'QUALIFICATION_PE_MACHINE_MISMATCH', `${artifactId} is not AMD64`);
  const requiredDllBits = peConstants.IMAGE_DLLCHARACTERISTICS_HIGH_ENTROPY_VA
    | peConstants.IMAGE_DLLCHARACTERISTICS_DYNAMIC_BASE
    | peConstants.IMAGE_DLLCHARACTERISTICS_NX_COMPAT
    | peConstants.IMAGE_DLLCHARACTERISTICS_GUARD_CF;
  invariant((parsed.dllCharacteristics & requiredDllBits) === requiredDllBits, 'QUALIFICATION_PE_HARDENING_MISSING', `${artifactId} lacks required ASLR/NX/CFG bits`);
  invariant(
    (parsed.exDllCharacteristics & peConstants.IMAGE_DLLCHARACTERISTICS_EX_CET_COMPAT) !== 0,
    'QUALIFICATION_PE_CET_MISSING',
    `${artifactId} lacks CET compatibility`,
  );
  for (const section of parsed.sections) {
    invariant(!(section.executable && section.writable), 'QUALIFICATION_PE_WRITABLE_EXECUTABLE', `${artifactId} has writable-executable section ${section.name}`);
  }
  for (const imported of parsed.imports) {
    invariant(!/^(?:VCRUNTIME|MSVCP|UCRTBASE|API-MS-WIN-CRT)/iu.test(imported), 'QUALIFICATION_PE_DYNAMIC_CRT_IMPORT', `${artifactId} imports dynamic CRT ${imported}`);
  }
}

async function inspectReleaseBuild(context, build, label) {
  const policies = new Map(context.config.root.artifactPolicies.map((policy) => [policy.artifactId, policy]));
  const inspected = {};
  for (const [artifactId, filePath] of [
    ['pc-sdk-next-bootstrap', build.bootstrap],
    ['pc-sdk-next-containment-addon', build.addon],
  ]) {
    const policy = policies.get(artifactId);
    invariant(policy !== undefined, 'ARTIFACT_POLICY_MISSING', `missing policy for ${artifactId}`);
    await runCommand(context, {
      args: ['/HEADERS', '/LOADCONFIG', '/IMPORTS', '/DEPENDENTS', '/EXPORTS', filePath],
      cwd: build.outputDirectory,
      label: `${label}-dumpbin-${artifactId}`,
      tool: 'dumpbin',
    });
    let parsed;
    try {
      parsed = parsePe(await readFile(filePath));
    } catch (error) {
      fail('PE_PARSE_FAILED', `${artifactId}: ${error.message}`);
    }
    assertReleasePe(parsed, policy, artifactId);
    if (artifactId === 'pc-sdk-next-bootstrap') {
      invariant(
        parsed.exports.length === 0
          && parsed.exportDirectory.numberOfFunctions === 0
          && parsed.exportDirectory.numberOfNames === 0
          && parsed.exportDirectory.ordinalOnlyOrdinals.length === 0,
        'BOOTSTRAP_EXPORT_UNEXPECTED',
        'bootstrap probe unexpectedly exports named or ordinal-only symbols',
      );
    } else {
      invariant(
        canonicalJson(parsed.exports) === canonicalJson(['napi_register_module_v1', 'node_api_module_get_api_version_v1'])
          && parsed.exportDirectory.numberOfFunctions === 2
          && parsed.exportDirectory.numberOfNames === 2
          && parsed.exportDirectory.ordinalOnlyOrdinals.length === 0,
        'ADDON_EXPORTS_MISMATCH',
        'addon exports do not equal exactly the two named raw Node-API registration symbols',
        { exportDirectory: parsed.exportDirectory, exports: parsed.exports },
      );
      invariant(parsed.imports.some((name) => name.toLowerCase() === 'node.exe'), 'NODE_DIRECT_IMPORT_MISSING', 'addon does not directly import node.exe');
    }
    assertEmbeddedInputDigest(parsed, context.inputManifest.rootSha256, artifactId);
    inspected[artifactId] = summarizePe(parsed);
  }
  const manifestPath = path.join(build.outputDirectory, 'bootstrap.manifest.xml');
  await runCommand(context, {
    args: [`-inputresource:${build.bootstrap};#1`, `-out:${manifestPath}`],
    cwd: build.outputDirectory,
    label: `${label}-extract-bootstrap-manifest`,
    tool: 'mt',
  });
  const manifest = await readFile(manifestPath, 'utf8');
  invariant(/requestedExecutionLevel[^>]+level=["']asInvoker["'][^>]+uiAccess=["']false["']/iu.test(manifest), 'BOOTSTRAP_UAC_MANIFEST_MISMATCH', 'bootstrap embedded manifest does not declare asInvoker/uiAccess=false');
  await runCommand(context, {
    args: [],
    cwd: build.outputDirectory,
    label: `${label}-run-bootstrap`,
    tool: '__bootstrap__',
  });
  return inspected;
}

async function compareReleaseBuilds(first, second) {
  const reproducibleOutputKeys = [
    'bootstrap',
    'addon',
    'inputManifestDigest',
    'inputManifestRc',
    'inputManifestResource',
  ];
  const reproducibleOutputs = {};
  for (const key of reproducibleOutputKeys) {
    const firstHash = await sha256File(first[key]);
    const secondHash = await sha256File(second[key]);
    invariant(firstHash === secondHash, 'REPRODUCIBILITY_MISMATCH', `${key} differs across the two build roots`, {
      first: firstHash,
      second: secondHash,
    });
    reproducibleOutputs[key] = firstHash;
  }
  const pathBoundLtcgIntermediates = {};
  for (const key of ['coreObject', 'coreLibrary', 'bootstrapObject', 'addonObject', 'sqliteCObject']) {
    const firstSha256 = await sha256File(first[key]);
    const secondSha256 = await sha256File(second[key]);
    pathBoundLtcgIntermediates[key] = {
      byteIdentical: firstSha256 === secondSha256,
      firstSha256,
      secondSha256,
    };
  }
  return { pathBoundLtcgIntermediates, reproducibleOutputs };
}

async function loadAddon(context, build) {
  const result = await runCommand(context, {
    args: [build.loader, build.addon],
    cwd: build.outputDirectory,
    label: 'load-direct-napi-addon',
    tool: 'node',
  });
  invariant(
    result.stdoutText === '{"abi":"127","napi":"9","value":116}\n',
    'NODE_ADDON_RESULT_MISMATCH',
    'exact Node returned an unexpected addon result',
  );
  return { abi: '127', napi: '9', value: 116 };
}

async function runAsanProbe(context, root) {
  const directories = await copyFixtures(root, ['asan-canary.cc']);
  const recipe = findRecipe(context.config, 'msvc-asan-qualification');
  const objectPath = path.join(directories.outputDirectory, 'asan-canary.obj');
  const executablePath = path.join(directories.outputDirectory, 'asan-canary.exe');
  const compilerPdb = path.join(directories.outputDirectory, 'asan-canary-compile.pdb');
  const outputPdb = path.join(directories.outputDirectory, 'asan-canary.pdb');
  const replacements = { BUILD_ROOT: root, OUTPUT_PDB: outputPdb };
  await runCommand(context, {
    args: [
      ...expandTokens(recipe.compileFlags, replacements),
      `/Fd${compilerPdb}`,
      `/Fo${objectPath}`,
      path.join(directories.sourceDirectory, 'asan-canary.cc'),
    ],
    cwd: root,
    label: 'asan-compile',
    tool: 'cl',
  });
  const configuredLinkFlags = expandTokens(recipe.linkFlags ?? [], replacements);
  const driverFlags = recipe.linkDriverFlags ?? configuredLinkFlags.filter((flag) => flag.toLowerCase() === '/fsanitize=address');
  const linkerFlags = recipe.linkerFlags ?? configuredLinkFlags.filter((flag) => flag.toLowerCase() !== '/fsanitize=address');
  invariant(driverFlags.some((flag) => flag.toLowerCase() === '/fsanitize=address'), 'ASAN_DRIVER_FLAG_MISSING', 'ASan link driver lacks /fsanitize=address');
  await runCommand(context, {
    args: [
      '/nologo',
      objectPath,
      `/Fe${executablePath}`,
      ...driverFlags,
      '/link',
      ...linkerFlags,
    ],
    cwd: root,
    label: 'asan-link-via-cl-driver',
    tool: 'cl',
  });
  const directives = await runCommand(context, {
    args: ['/DIRECTIVES', objectPath],
    cwd: root,
    label: 'asan-directives',
    tool: 'dumpbin',
  });
  assertStaticCrtDirectives(`${directives.stdoutText}\n${directives.stderrText}`, 'ASan canary');
  const llvmSymbolizerDirectory = path.dirname(context.tools['llvm-symbolizer']);
  const runtimeEnvironment = {
    ...context.environment,
    ASAN_OPTIONS: 'abort_on_error=1:halt_on_error=1:symbolize=1',
    ASAN_SYMBOLIZER_PATH: context.tools['llvm-symbolizer'],
    Path: `${path.dirname(context.tools.cl)};${llvmSymbolizerDirectory};${context.environment.Path}`,
  };
  await runCommand(context, {
    args: [],
    cwd: directories.outputDirectory,
    env: runtimeEnvironment,
    label: 'asan-positive-canary',
    tool: '__asan__',
  });
  const negative = await runCommand(context, {
    args: ['trip'],
    cwd: directories.outputDirectory,
    env: runtimeEnvironment,
    expectedExit: isAdmittedAsanNegativeTerminal,
    label: 'asan-negative-canary',
    timeoutMs: 30_000,
    tool: '__asan__',
  });
  const negativeText = `${negative.stdoutText}\n${negative.stderrText}`;
  invariant(/AddressSanitizer/iu.test(negativeText), 'ASAN_NEGATIVE_NOT_DETECTED', 'intentional ASan fault produced no sanitizer diagnostic');
  invariant(/heap-buffer-overflow/iu.test(negativeText), 'ASAN_NEGATIVE_WRONG_CLASS', 'intentional ASan fault was not classified as heap-buffer-overflow');
  let parsed;
  try {
    parsed = parsePe(await readFile(executablePath));
  } catch (error) {
    fail('PE_PARSE_FAILED', `MSVC ASan canary: ${error.message}`);
  }
  assertQualificationPe(parsed, 'MSVC ASan canary');
  return {
    executableSha256: await sha256File(executablePath),
    negativeClass: 'heap-buffer-overflow',
    positiveExit: 0,
  };
}

function llvmDriverSelection(context, recipe) {
  const selected = context.config.root.hostToolchain.selectedVisualStudio;
  const visualStudioRoot = context.resolver.locations.vs;
  const sdkRoot = context.resolver.locations.sdk;
  const compatibilityVersion = context.toolIdentities.cl.version.replace(/\.0$/u, '');
  const expanded = expandTokens(recipe.driverSelectionFlags, {
    MSVC_TOOLS_ROOT: path.join(visualStudioRoot, 'VC', 'Tools', 'MSVC', selected.msvcToolsVersion),
    WINDOWS_SDK_ROOT: sdkRoot,
  });
  invariant(
    canonicalJson(expanded) === canonicalJson([
      '/vctoolsdir',
      path.join(visualStudioRoot, 'VC', 'Tools', 'MSVC', selected.msvcToolsVersion),
      '/winsdkdir',
      sdkRoot,
      '/winsdkversion',
      selected.windowsSdkVersion,
      `/clang:-fms-compatibility-version=${compatibilityVersion}`,
    ]),
    'LLVM_DRIVER_SELECTION_MISMATCH',
    `${recipe.id} does not equal the sealed MSVC/Windows SDK/compatibility selection`,
  );
  return expanded;
}

function assertCorrectedLlvmFlags(recipe) {
  const flags = recipe.compileFlags;
  const expectedFlags = {
    'llvm-19.1.7-coverage-replay': [
      '/nologo', '/c', '/TP', '/std:c++20', '/permissive-', '/EHsc', '/GR-', '/W4', '/WX',
      '/GS', '/guard:cf', '/O1', '/Oy-', '/Z7', '/MT', '/utf-8',
      '/clang:-fno-omit-frame-pointer', '-fprofile-instr-generate', '-fcoverage-mapping',
      '/clang:-ffile-prefix-map=${SOURCE_ROOT}=packages/windows-containment/native',
      '/clang:-fcoverage-compilation-dir=.',
    ],
    'llvm-19.1.7-fuzz': [
      '/nologo', '/c', '/TP', '/std:c++20', '/permissive-', '/EHsc', '/GR-', '/W4', '/WX',
      '/GS', '/guard:cf', '/O1', '/Oy-', '/Z7', '/MT', '/utf-8', '/Zc:__cplusplus',
      '/clang:-fno-omit-frame-pointer', '-fsanitize=fuzzer-no-link,address',
      '-fsanitize-coverage=edge,indirect-calls,trace-cmp,trace-div,trace-gep',
      '/clang:-ffile-prefix-map=${SOURCE_ROOT}=packages/windows-containment/native',
    ],
  }[recipe.id];
  const prefixMaps = flags.filter((flag) => flag.startsWith('/clang:-ffile-prefix-map='));
  const coverageCompilationDirectories = flags.filter(
    (flag) => flag.startsWith('/clang:-fcoverage-compilation-dir='),
  );
  const coveragePathAliases = flags.filter((flag) => (
    flag.startsWith('/clang:-ffile-compilation-dir=')
      || flag.startsWith('/clang:-fcoverage-prefix-map=')
      || flag.startsWith('-ffile-compilation-dir=')
      || flag.startsWith('-fcoverage-compilation-dir=')
      || flag.startsWith('-fcoverage-prefix-map=')
  ));
  invariant(!flags.includes('-fno-omit-frame-pointer'), 'LLVM_FLAG_INVALID', `${recipe.id} uses clang rather than clang-cl frame-pointer syntax`);
  invariant(!flags.some((flag) => flag.startsWith('-ffile-prefix-map=')), 'LLVM_FLAG_INVALID', `${recipe.id} uses clang rather than clang-cl prefix-map syntax`);
  invariant(!flags.includes('/Zc:preprocessor'), 'LLVM_FLAG_INVALID', `${recipe.id} carries unused /Zc:preprocessor under /WX`);
  invariant(flags.includes('/clang:-fno-omit-frame-pointer'), 'LLVM_FRAME_POINTER_FLAG_MISSING', `${recipe.id} does not force x64 frame pointers`);
  invariant(
    prefixMaps.length === 1
      && prefixMaps[0] === '/clang:-ffile-prefix-map=${SOURCE_ROOT}=packages/windows-containment/native',
    'LLVM_PREFIX_MAP_MISMATCH',
    `${recipe.id} does not carry the exact single sealed source prefix map`,
  );
  invariant(
    coveragePathAliases.length === 0,
    'LLVM_COVERAGE_PATH_ALIAS_FORBIDDEN',
    `${recipe.id} carries a competing coverage path alias`,
  );
  if (flags.includes('-fcoverage-mapping')) {
    invariant(
      coverageCompilationDirectories.length === 1
        && coverageCompilationDirectories[0] === '/clang:-fcoverage-compilation-dir=.',
      'LLVM_COVERAGE_COMPILATION_DIR_MISMATCH',
      `${recipe.id} must use the current directory so its mapped source prefix is not duplicated`,
    );
  } else {
    invariant(
      coverageCompilationDirectories.length === 0,
      'LLVM_COVERAGE_COMPILATION_DIR_UNEXPECTED',
      `${recipe.id} declares a coverage compilation directory without coverage mapping`,
    );
  }
  invariant(
    expectedFlags !== undefined && canonicalJson(flags) === canonicalJson(expectedFlags),
    'LLVM_COMPILE_FLAGS_MISMATCH',
    `${recipe.id} compile flags do not equal the exact sealed ordered projection`,
  );
}

function llvmLinkArguments(recipe, selection, objectPath, executablePath, replacements) {
  invariant(Array.isArray(recipe.linkDriverFlags) && recipe.linkDriverFlags.length !== 0, 'LLVM_LINK_DRIVER_FLAGS_MISSING', `${recipe.id} omits declared clang-cl link-driver flags`);
  invariant(recipe.linkDriverSeparator === '/link', 'LLVM_LINK_SEPARATOR_MISMATCH', `${recipe.id} does not use the exact clang-cl /link separator`);
  invariant(Array.isArray(recipe.linkFlags) && recipe.linkFlags.length !== 0, 'LLVM_LINKER_FLAGS_MISSING', `${recipe.id} omits lld-link flags`);
  return [
    ...selection,
    ...expandTokens(recipe.linkDriverFlags, replacements),
    objectPath,
    `/Fe${executablePath}`,
    recipe.linkDriverSeparator,
    ...expandTokens(recipe.linkFlags, replacements),
  ];
}

function parseLlvmBranchCoverageReport(text, expectedSourcePath) {
  const lines = String(text).split(/\r?\n/u);
  invariant(
    lines.some((line) => /Filename/iu.test(line) && /Branches/iu.test(line)),
    'LLVM_COVERAGE_BRANCH_HEADER_MISSING',
    'llvm-cov report omitted its branch summary header',
  );
  const normalizedExpectedSourcePath = expectedSourcePath.replaceAll('\\', '/');
  const sourceLines = lines.filter((line) => {
    const [reportedPath] = line.trim().split(/\s+/u);
    return reportedPath?.replaceAll('\\', '/') === normalizedExpectedSourcePath;
  });
  invariant(
    sourceLines.length === 1,
    'LLVM_COVERAGE_REPORT_MISSING_SOURCE',
    `llvm-cov report did not contain exactly one ${expectedSourcePath} row`,
  );
  const [sourceLine] = sourceLines;
  const fields = sourceLine.trim().split(/\s+/u);
  invariant(fields.length >= 4, 'LLVM_COVERAGE_BRANCH_ROW_INVALID', 'llvm-cov branch summary row is too short');
  const coverage = fields.at(-1);
  const missed = Number.parseInt(fields.at(-2), 10);
  const branches = Number.parseInt(fields.at(-3), 10);
  invariant(
    Number.isSafeInteger(branches)
      && branches > 0
      && Number.isSafeInteger(missed)
      && missed === 0
      && coverage === '100.00%',
    'LLVM_COVERAGE_BRANCH_THRESHOLD_FAILED',
    `llvm-cov reported ${String(coverage)} branch coverage with ${String(missed)} missed of ${String(branches)}`,
  );
  return { branches, coverage, missed };
}

function assertLlvmCoverageShow({ stderrText, stdoutText }) {
  invariant(
    stderrText.trim().length === 0,
    'LLVM_COVERAGE_SHOW_DIAGNOSTIC',
    'llvm-cov show emitted a diagnostic instead of rendering the mapped fixture source',
    stderrText.trim(),
  );
  invariant(
    /classify\(argument_count - 2\)/u.test(stdoutText),
    'LLVM_COVERAGE_SHOW_FIXTURE_CANARY_MISSING',
    'llvm-cov show did not render the sealed fixture canary',
  );
  invariant(
    /True:\s*[1-9][0-9]*,\s*False:\s*[1-9][0-9]*/iu.test(stdoutText),
    'LLVM_COVERAGE_SHOW_BRANCH_COUNTS_MISSING',
    'llvm-cov show omitted positive true/false branch counts',
  );
}

async function runLlvmProbe(context, root) {
  const directories = await copyFixtures(root, ['llvm-fuzzer.cc', 'llvm-coverage.cc']);
  const fuzzRecipe = findRecipe(context.config, 'llvm-19.1.7-fuzz');
  const coverageRecipe = findRecipe(context.config, 'llvm-19.1.7-coverage-replay');
  const selection = llvmDriverSelection(context, fuzzRecipe);
  invariant(
    canonicalJson(selection) === canonicalJson(llvmDriverSelection(context, coverageRecipe)),
    'LLVM_DRIVER_SELECTION_DIVERGED',
    'fuzz and coverage recipes do not share one sealed driver selection',
  );
  assertCorrectedLlvmFlags(fuzzRecipe);
  assertCorrectedLlvmFlags(coverageRecipe);
  const replacements = { SOURCE_ROOT: root };
  const fuzzObject = path.join(directories.outputDirectory, 'llvm-fuzzer.obj');
  const fuzzExecutable = path.join(directories.outputDirectory, 'llvm-fuzzer.exe');
  const fuzzCompileArgs = [
    ...selection,
    ...expandTokens(fuzzRecipe.compileFlags, replacements),
    `/Fo${fuzzObject}`,
    path.join(directories.sourceDirectory, 'llvm-fuzzer.cc'),
  ];
  const fuzzProjection = await runCommand(context, {
    args: ['-###', ...fuzzCompileArgs],
    cwd: root,
    label: 'llvm-fuzz-compile-projection',
    tool: 'clang-cl',
  });
  invariant(/-mframe-pointer=all/iu.test(fuzzProjection.stderrText), 'LLVM_FRAME_POINTER_PROJECTION_MISMATCH', 'clang-cl projection did not retain frame pointers');
  invariant(/--dependent-lib=libcmt/iu.test(fuzzProjection.stderrText), 'LLVM_STATIC_CRT_PROJECTION_MISSING', 'LLVM fuzz compile projection did not select LIBCMT');
  await runCommand(context, {
    args: fuzzCompileArgs,
    cwd: root,
    label: 'llvm-fuzz-compile',
    tool: 'clang-cl',
  });
  const fuzzLinkArgs = llvmLinkArguments(
    fuzzRecipe,
    selection,
    fuzzObject,
    fuzzExecutable,
    replacements,
  );
  const fuzzLinkProjection = await runCommand(context, {
    args: ['-###', ...fuzzLinkArgs],
    cwd: root,
    label: 'llvm-fuzz-link-projection',
    tool: 'clang-cl',
  });
  const fuzzProjectionText = `${fuzzLinkProjection.stdoutText}\n${fuzzLinkProjection.stderrText}`;
  for (const required of ['lld-link', 'clang_rt.fuzzer-x86_64.lib', 'clang_rt.asan-x86_64.lib', 'clang_rt.asan_cxx-x86_64.lib']) {
    invariant(fuzzProjectionText.includes(required), 'LLVM_LINK_PROJECTION_MISSING_INPUT', `LLVM fuzz link projection omits ${required}`);
  }
  await runCommand(context, {
    args: fuzzLinkArgs,
    cwd: root,
    label: 'llvm-fuzz-link',
    tool: 'clang-cl',
  });
  let parsedFuzzer;
  try {
    parsedFuzzer = parsePe(await readFile(fuzzExecutable));
  } catch (error) {
    fail('PE_PARSE_FAILED', `LLVM fuzzer: ${error.message}`);
  }
  assertQualificationPe(parsedFuzzer, 'LLVM fuzzer');
  const corpusDirectory = path.join(root, 'corpus');
  await mkdir(corpusDirectory, { recursive: false });
  await writeFile(path.join(corpusDirectory, 'seed'), Buffer.from('CX004', 'ascii'));
  await runCommand(context, {
    args: ['-runs=8', '-jobs=1', '-workers=1', '-seed=424242', corpusDirectory],
    cwd: directories.outputDirectory,
    label: 'llvm-fuzzer-positive-canary',
    timeoutMs: 60_000,
    tool: '__llvm_fuzzer__',
  });

  const coverageObject = path.join(directories.outputDirectory, 'llvm-coverage.obj');
  const coverageExecutable = path.join(directories.outputDirectory, 'llvm-coverage.exe');
  const coverageCompileArgs = [
    ...selection,
    ...expandTokens(coverageRecipe.compileFlags, replacements),
    `/Fo${coverageObject}`,
    path.join(directories.sourceDirectory, 'llvm-coverage.cc'),
  ];
  const coverageProjection = await runCommand(context, {
    args: ['-###', ...coverageCompileArgs],
    cwd: root,
    label: 'llvm-coverage-compile-projection',
    tool: 'clang-cl',
  });
  invariant(/-mframe-pointer=all/iu.test(coverageProjection.stderrText), 'LLVM_COVERAGE_FRAME_POINTER_PROJECTION_MISMATCH', 'coverage projection did not retain frame pointers');
  invariant(/--dependent-lib=libcmt/iu.test(coverageProjection.stderrText), 'LLVM_COVERAGE_STATIC_CRT_PROJECTION_MISSING', 'LLVM coverage compile projection did not select LIBCMT');
  await runCommand(context, {
    args: coverageCompileArgs,
    cwd: root,
    label: 'llvm-coverage-compile',
    tool: 'clang-cl',
  });
  const coverageLinkArgs = llvmLinkArguments(
    coverageRecipe,
    selection,
    coverageObject,
    coverageExecutable,
    replacements,
  );
  const coverageLinkProjection = await runCommand(context, {
    args: ['-###', ...coverageLinkArgs],
    cwd: root,
    label: 'llvm-coverage-link-projection',
    tool: 'clang-cl',
  });
  const coverageProjectionText = `${coverageLinkProjection.stdoutText}\n${coverageLinkProjection.stderrText}`;
  for (const required of ['lld-link', 'clang_rt.profile-x86_64.lib']) {
    invariant(coverageProjectionText.includes(required), 'LLVM_COVERAGE_PROJECTION_MISSING_INPUT', `LLVM coverage link projection omits ${required}`);
  }
  await runCommand(context, {
    args: coverageLinkArgs,
    cwd: root,
    label: 'llvm-coverage-link',
    tool: 'clang-cl',
  });
  let parsedCoverage;
  try {
    parsedCoverage = parsePe(await readFile(coverageExecutable));
  } catch (error) {
    fail('PE_PARSE_FAILED', `LLVM coverage probe: ${error.message}`);
  }
  assertQualificationPe(parsedCoverage, 'LLVM coverage probe');
  invariant(
    coverageRecipe.profilePolicy === 'LLVM_PROFILE_FILE=${SEALED_RUN_DIR}/%m-%p.profraw; llvm-profdata merge -sparse; exact llvm-cov report/show; 100% branch coverage for declared bounded validation/state-transition region',
    'LLVM_PROFILE_POLICY_MISMATCH',
    'coverage recipe changed the sealed raw-profile naming/merge policy',
  );
  invariant(
    coverageRecipe.entryPoint === 'packages/windows-containment/native/test/coverage/corpus_replay_main.cc',
    'LLVM_COVERAGE_ENTRY_POINT_MISMATCH',
    'coverage recipe changed its declared entry point',
  );
  const profileDirectory = path.join(root, 'profiles');
  await mkdir(profileDirectory, { recursive: false });
  const coverageEnvironment = {
    ...context.environment,
    LLVM_PROFILE_FILE: path.join(profileDirectory, '%m-%p.profraw'),
  };
  await runCommand(context, {
    args: [],
    cwd: directories.outputDirectory,
    env: coverageEnvironment,
    label: 'llvm-coverage-negative-branch',
    tool: '__llvm_coverage__',
  });
  await runCommand(context, {
    args: ['zero'],
    cwd: directories.outputDirectory,
    env: coverageEnvironment,
    label: 'llvm-coverage-zero-branch',
    tool: '__llvm_coverage__',
  });
  await runCommand(context, {
    args: ['positive', 'branch'],
    cwd: directories.outputDirectory,
    env: coverageEnvironment,
    label: 'llvm-coverage-positive-branch',
    tool: '__llvm_coverage__',
  });
  const profiles = (await readdir(profileDirectory))
    .filter((name) => name.endsWith('.profraw'))
    .sort()
    .map((name) => path.join(profileDirectory, name));
  invariant(profiles.length === 3, 'LLVM_PROFILE_COUNT_MISMATCH', `expected three raw profiles, found ${profiles.length}`);
  for (const profile of profiles) {
    invariant((await stat(profile)).size > 0, 'LLVM_PROFILE_EMPTY', 'coverage runtime emitted an empty profile');
  }
  const mergedProfile = path.join(profileDirectory, 'coverage.profdata');
  await runCommand(context, {
    args: ['merge', '-sparse', '-o', mergedProfile, ...profiles],
    cwd: root,
    label: 'llvm-profdata-merge',
    tool: 'llvm-profdata',
  });
  const pathEquivalence = `-path-equivalence=packages/windows-containment/native,${root}`;
  const report = await runCommand(context, {
    args: ['report', coverageExecutable, `-instr-profile=${mergedProfile}`, pathEquivalence, '-show-branch-summary'],
    cwd: root,
    label: 'llvm-cov-report',
    tool: 'llvm-cov',
  });
  const branchCoverage = parseLlvmBranchCoverageReport(
    report.stdoutText,
    'packages/windows-containment/native/src/llvm-coverage.cc',
  );
  const show = await runCommand(context, {
    args: ['show', coverageExecutable, `-instr-profile=${mergedProfile}`, pathEquivalence, '-show-branches=count'],
    cwd: root,
    label: 'llvm-cov-show',
    tool: 'llvm-cov',
  });
  assertLlvmCoverageShow(show);
  return {
    branchCoverage,
    coverageExecutableSha256: await sha256File(coverageExecutable),
    fuzzExecutableSha256: await sha256File(fuzzExecutable),
    mergedProfileSha256: await sha256File(mergedProfile),
    rawProfiles: profiles.length,
  };
}

function assertReleaseLinkIsolationPolicy(config) {
  const recipes = new Map(config.root.buildRecipes.map((recipe) => [recipe.id, recipe]));
  const flagsFor = (id) => {
    const recipe = recipes.get(id);
    invariant(recipe !== undefined, 'RECIPE_MISSING', `native-build-input is missing recipe ${id}`);
    invariant(Array.isArray(recipe.linkFlags), 'RECIPE_LINK_FLAGS_INVALID', `${id} link flags are missing`);
    return new Set(recipe.linkFlags.map((flag) => flag.toLocaleUpperCase('en-US')));
  };
  const bootstrapFlags = flagsFor('msvc-release-bootstrap');
  invariant(
    !bootstrapFlags.has('/DLL') && bootstrapFlags.has('/ALLOWISOLATION'),
    'BOOTSTRAP_ISOLATION_POLICY_INVALID',
    'release bootstrap must be an isolated executable rather than a DLL',
  );
  for (const id of ['msvc-release-addon', 'node-gyp-release-sqlite']) {
    const flags = flagsFor(id);
    invariant(flags.has('/DLL'), 'DLL_LINK_MODE_MISSING', `${id} does not select DLL link mode`);
    invariant(
      !flags.has('/ALLOWISOLATION'),
      'DLL_ALLOWISOLATION_FORBIDDEN',
      `${id} combines incompatible /DLL and /ALLOWISOLATION flags`,
    );
  }
}

function assertConfigurationAuthority(config, resolver, context) {
  const { localAppData, repositoryRoot } = context;
  invariant(config.schemaVersion === 'pc-sdk.cx-004.native-build-input-config.v1', 'CONFIG_SCHEMA_MISMATCH', 'native-build-input config schema changed');
  assertReleaseLinkIsolationPolicy(config);
  assertReleaseStaticRuntimePolicy(config);
  const expectedExact = new Map([
    ['cache', path.join(localAppData, 'PC-SDK-Next', 'toolchains', 'cx-004')],
    ['git', 'C:\\Program Files\\Git'],
    ['preseal', path.join(localAppData, 'PC-SDK-Next', 'toolchains', 'cx-004', 'preseal', 'receipts')],
    ['repo', repositoryRoot],
    ['sdk', 'C:\\Program Files (x86)\\Windows Kits\\10'],
    ['system', EXPECTED_SYSTEM_ROOT],
    ['vs', 'C:\\Program Files (x86)\\Microsoft Visual Studio\\2022\\BuildTools'],
    ['vsinstaller', 'C:\\Program Files (x86)\\Microsoft Visual Studio\\Installer'],
    ['vsstate', 'C:\\ProgramData\\Microsoft\\VisualStudio\\Packages\\_Instances\\84e262f3'],
  ]);
  invariant(
    canonicalJson(Object.keys(resolver.locations).sort())
      === canonicalJson([...expectedExact.keys(), 'q0s'].sort()),
    'CONFIG_LOCATION_SET_MISMATCH',
    'native-build-input config declares an unapproved location authority',
  );
  for (const [id, expected] of expectedExact) {
    invariant(normalizedPath(resolver.locations[id]) === normalizedPath(expected), 'CONFIG_LOCATION_MISMATCH', `native-build-input location ${id} changed`);
  }
  const q0sBase = path.join(localAppData, 'PC-SDK-Next', 'cx-004-runs');
  invariant(
    isPathWithin(resolver.locations.q0s, q0sBase) && normalizedPath(resolver.locations.q0s) !== normalizedPath(q0sBase),
    'CONFIG_Q0S_LOCATION_INVALID',
    'native-build-input q0s location is outside the dedicated local evidence root',
  );
  const profileRoot = path.dirname(path.dirname(localAppData));
  const providerRoots = [
    process.env.CODEX_HOME,
    process.env.CLAUDE_CONFIG_DIR,
    path.join(profileRoot, '.codex'),
    path.join(profileRoot, '.claude'),
  ].filter((value) => typeof value === 'string' && value.length !== 0).map((value) => path.resolve(value));
  for (const [id, location] of Object.entries(resolver.locations)) {
    for (const providerRoot of providerRoots) {
      invariant(!pathsOverlap(location, providerRoot), 'CONFIG_PROVIDER_HOME_OVERLAP', `native-build-input location ${id} overlaps a provider home`);
    }
  }
  for (const surface of config.surfaces) {
    for (const source of surface.sources) {
      invariant(
        typeof source.location === 'string'
          && Object.hasOwn(resolver.locations, source.location)
          && typeof source.relativeRoot === 'string'
          && !path.isAbsolute(source.relativeRoot),
        'CONFIG_SOURCE_AUTHORITY_INVALID',
        `${surface.surfaceId} contains an unbound source authority`,
      );
      const sourceRoot = path.resolve(resolver.locations[source.location], source.relativeRoot);
      invariant(
        isPathWithin(sourceRoot, resolver.locations[source.location]),
        'CONFIG_SOURCE_ESCAPES_LOCATION',
        `${surface.surfaceId} source escapes location ${source.location}`,
      );
      for (const providerRoot of providerRoots) {
        invariant(!pathsOverlap(sourceRoot, providerRoot), 'CONFIG_SOURCE_PROVIDER_HOME_OVERLAP', `${surface.surfaceId} source overlaps a provider home`);
      }
    }
  }
  invariant(
    normalizedPath(path.resolve(path.dirname(DEFAULT_CONFIG_PATH), config.output.directory))
      === normalizedPath(path.join(repositoryRoot, 'docs', 'execution', 'manifests'))
      && config.output.rootFileName === 'CX-004-native-build-input.json',
    'CONFIG_OUTPUT_AUTHORITY_INVALID',
    'native-build-input output is not the fixed repository manifest directory/root file',
  );
}

function assertOutputAuthority(localAppData, repositoryRoot, probeCacheRoot) {
  const profileRoot = path.dirname(path.dirname(localAppData));
  invariant(
    normalizedPath(localAppData) === normalizedPath(path.join(profileRoot, 'AppData', 'Local')),
    'LOCALAPPDATA_SHAPE_INVALID',
    'LOCALAPPDATA is not the profile Local AppData directory',
  );
  const loweredSegments = probeCacheRoot.replaceAll('\\', '/').toLocaleLowerCase('en-US').split('/');
  invariant(!loweredSegments.includes('.codex') && !loweredSegments.includes('.claude'), 'OUTPUT_PROVIDER_HOME_OVERLAP', 'probe output overlaps a provider home');
  const forbiddenRoots = [
    process.env.CODEX_HOME,
    process.env.CLAUDE_CONFIG_DIR,
    path.join(profileRoot, '.codex'),
    path.join(profileRoot, '.claude'),
    repositoryRoot,
    path.join(path.dirname(repositoryRoot), 'PC-SDK'),
  ].filter((value) => typeof value === 'string' && value.length !== 0).map((value) => path.resolve(value));
  for (const forbidden of forbiddenRoots) {
    invariant(!pathsOverlap(probeCacheRoot, forbidden), 'OUTPUT_FORBIDDEN_ROOT_OVERLAP', 'probe output overlaps a provider home or repository');
  }
}

async function assertOrdinaryDirectory(directoryPath, label) {
  const information = await lstat(directoryPath);
  invariant(information.isDirectory() && !information.isSymbolicLink(), 'OUTPUT_DIRECTORY_NOT_ORDINARY', `${label} is not an ordinary directory`);
  invariant(normalizedPath(await realpath(directoryPath)) === normalizedPath(directoryPath), 'OUTPUT_DIRECTORY_REPARSE_PATH', `${label} traverses a reparse path`);
}

async function verifyInputManifest(context, hardenedAudit) {
  const output = context.config.output;
  const outputDirectory = path.resolve(path.dirname(context.configPath), output.directory);
  const rootPath = path.join(outputDirectory, output.rootFileName);
  try {
    await assertOrdinaryFile(rootPath, 'generated native-build-input root');
  } catch (error) {
    if (error?.code === 'ENOENT') {
      fail('INPUT_MANIFEST_NOT_GENERATED', 'generate the final native-build-input manifest before running the probe');
    }
    throw error;
  }
  const rootSha256 = await sha256File(rootPath);
  invariant(rootSha256 === hardenedAudit.rootSha256, 'INPUT_MANIFEST_AUDIT_BINDING_MISMATCH', 'generated root bytes do not equal the hardened filesystem-audit receipt');
  invariant(context.config.manifestSetId === hardenedAudit.manifestSetId, 'INPUT_MANIFEST_SET_ID_MISMATCH', 'config manifestSetId does not equal the hardened filesystem-audit receipt');
  return {
    audit: hardenedAudit,
    rootSha256,
  };
}

function markerAuditSource(rootPath, marker, sourceIndex, sourceId) {
  return {
    files: [marker],
    logicalPrefix: sourceId,
    mode: 'files',
    rootPath,
    sourceId,
    sourceIndex,
    surfaceId: 'probe-output-identity',
  };
}

async function ensureMarker(rootPath, marker, label) {
  await assertOrdinaryDirectory(rootPath, `${label} root`);
  const markerPath = path.join(rootPath, marker);
  try {
    await writeFile(markerPath, MARKER_BYTES, { flag: 'wx' });
  } catch (error) {
    if (error?.code !== 'EEXIST') throw error;
  }
  const information = await assertOrdinaryFile(markerPath, `${label} marker`);
  invariant(
    information.size === MARKER_BYTES.length
      && await sha256File(markerPath) === sha256Bytes(MARKER_BYTES),
    'PROBE_OUTPUT_MARKER_MISMATCH',
    `${label} marker did not equal its fixed identity`,
  );
}

function assertMarkerAudit(receipt, expectedSources, label) {
  invariant(
    receipt?.ok === true
      && receipt.fileCount === expectedSources.length
      && Array.isArray(receipt.sources)
      && receipt.sources.length === expectedSources.length,
    'PROBE_OUTPUT_AUDIT_INVALID',
    `${label} did not return the exact marker closure`,
  );
  for (const expected of expectedSources) {
    const source = receipt.sources.find((candidate) => candidate.sourceId === expected.sourceId);
    invariant(
      source !== undefined
        && source.sourceIndex === expected.sourceIndex
        && source.surfaceId === 'probe-output-identity'
        && canonicalJson(source.files) === canonicalJson([[
          `${expected.sourceId}/${expected.marker}`,
          MARKER_BYTES.length,
          sha256Bytes(MARKER_BYTES),
        ]]),
      'PROBE_OUTPUT_AUDIT_BINDING_MISMATCH',
      `${label}/${expected.sourceId} did not bind the fixed marker`,
    );
  }
}

function buildReceipt(context, result, execution) {
  const receipt = canonicalize({
    commands: execution.operationReceipts,
    conclusion: 'provider-free synthetic native toolchain feasibility only',
    credentialHomesAccessed: false,
    executionAuthority: {
      finalization: execution.authorityFinalization,
      teardown: execution.authorityTeardown,
    },
    externalProjectDataAccessed: false,
    outcome: 'passed',
    providerProcessesStarted: false,
    result,
    runId: context.runId,
    runner: context.runnerIdentity,
    schema: 'cx004-native-toolchain-probe-v2',
    stableRepositoryMutated: false,
    tools: context.toolIdentities,
  });
  assertReceiptPrivate(receipt, {
    actualRoots: [
      context.repositoryRoot,
      context.runRoot,
      ...Object.values(context.resolver.locations),
    ],
    forbiddenSubstrings: context.config.privacy.forbiddenSubstrings,
  });
  const bytes = Buffer.from(canonicalJson(receipt), 'utf8');
  return {
    bytes: bytes.length,
    document: receipt,
    sha256: sha256Bytes(bytes),
  };
}

async function main(argv = process.argv.slice(2)) {
  const options = parseArguments(argv);
  if (options.help) {
    process.stdout.write('Usage: node toolchain/probe/run-native-toolchain-probe.mjs\n');
    return;
  }

  const nodeEnvironmentAuthority = validateProbeNodeEnvironment();
  const runnerIdentity = {
    ...await validateSealedRunnerBeforeInputRead(),
    ...nodeEnvironmentAuthority,
  };
  const localAppData = selectedEnvironment('LOCALAPPDATA');
  const systemRoot = assertSystemRootAuthority(
    selectedEnvironment('SystemRoot'),
    selectedEnvironment('WINDIR'),
  );
  const repositoryRoot = path.resolve(TOOLCHAIN_DIRECTORY, '..', '..', '..');
  const profileRoot = path.dirname(path.dirname(localAppData));
  const authority = await prepareFilesystemAuditAuthority();
  const runId = authority.run.runId;
  const runRoot = authority.run.runRoot;
  const temporaryDirectory = authority.run.tempRoot;
  const cacheRunRoot = path.dirname(runRoot);
  activeRunId = runId;

  let redact = createRedactor({
    LOCALAPPDATA: localAppData,
    PROFILE_ROOT: profileRoot,
    REPOSITORY_ROOT: repositoryRoot,
    RUN_ROOT: runRoot,
    SYSTEM_ROOT: systemRoot,
  });
  activeRedactor = redact;
  assertOutputAuthority(localAppData, repositoryRoot, cacheRunRoot);
  await assertOrdinaryDirectory(runRoot, 'filesystem-authority run root');
  await assertOrdinaryDirectory(temporaryDirectory, 'filesystem-authority temp root');

  const configBytes = authority.configBytes;
  const config = authority.configContext.config;
  const configPath = DEFAULT_CONFIG_PATH;
  const resolver = createLogicalResolver(config, path.dirname(configPath));
  assertConfigurationAuthority(config, resolver, { localAppData, repositoryRoot });
  invariant(
    normalizedPath(authority.configContext.locations.repo) === normalizedPath(repositoryRoot)
      && normalizedPath(authority.configContext.locations.system) === normalizedPath(systemRoot)
      && canonicalJson(config) === canonicalJson(JSON.parse(configBytes.toString('utf8'))),
    'FILESYSTEM_AUTHORITY_CONFIG_MISMATCH',
    'filesystem authority config context did not equal its captured bytes and fixed roots',
  );
  redact = createRedactor({
    LOCALAPPDATA: localAppData,
    PROFILE_ROOT: profileRoot,
    REPOSITORY_ROOT: repositoryRoot,
    RUN_ROOT: runRoot,
    SYSTEM_ROOT: systemRoot,
    ...Object.fromEntries(Object.entries(resolver.locations).map(([id, value]) => [`LOCATION_${id.toUpperCase()}`, value])),
  });
  activeRedactor = redact;

  process.stdout.write('native toolchain probe: hardened complete input audit\n');
  const admittedInputAudit = await auditNativeBuildInputsWithinAuthority(authority, {
    timeoutMs: INPUT_AUDIT_TIMEOUT_MS,
  });
  const { replayBinding, ...fullInputAudit } = admittedInputAudit;

  await ensureMarker(cacheRunRoot, PROBE_CACHE_MARKER, 'probe cache');
  await ensureMarker(runRoot, RUN_ROOT_MARKER, 'probe run');
  const cacheSources = [
    markerAuditSource(cacheRunRoot, PROBE_CACHE_MARKER, 0, 'probe-cache'),
  ];
  const cachePathAudit = await authority.runAuditPlan({
    schemaVersion: AUDIT_PLAN_SCHEMA,
    sources: cacheSources,
  });
  assertMarkerAudit(cachePathAudit, [{
    marker: PROBE_CACHE_MARKER,
    sourceId: 'probe-cache',
    sourceIndex: 0,
  }], 'probe cache audit');
  const runSources = [
    markerAuditSource(cacheRunRoot, PROBE_CACHE_MARKER, 0, 'probe-cache'),
    markerAuditSource(runRoot, RUN_ROOT_MARKER, 1, 'probe-run'),
  ];
  const runPathAudit = await authority.runAuditPlan({
    schemaVersion: AUDIT_PLAN_SCHEMA,
    sources: runSources,
  });
  assertMarkerAudit(runPathAudit, [
    { marker: PROBE_CACHE_MARKER, sourceId: 'probe-cache', sourceIndex: 0 },
    { marker: RUN_ROOT_MARKER, sourceId: 'probe-run', sourceIndex: 1 },
  ], 'probe cache/run audit');

  const verifiedTools = await verifyTools(config, resolver);
  const nodeSdk = await verifyNodeLibrary(config, resolver);
  const llvmRuntimeIdentities = await verifyLlvmRuntimes(config, resolver);
  const msvcAsanRuntime = await verifyMsvcAsanRuntime(config, verifiedTools.tools);
  const fixtureIdentities = await verifyFixtureIdentities();
  const environment = buildEnvironment(config, resolver, temporaryDirectory);
  const tools = { ...verifiedTools.tools };
  const executionProfile = createNativeToolchainProbeExecutionProfile({
    authority,
    environment,
    repositoryRoot,
    resolveLogical: resolver.resolveLogical,
    tools,
  });
  const context = {
    config,
    configPath,
    environment,
    executionProfile,
    llvmRuntimeIdentities,
    nodeIncludePath: nodeSdk.nodeIncludePath,
    nodeLibraryPath: nodeSdk.nodeLibraryPath,
    redact,
    repositoryRoot,
    resolver,
    runId,
    runnerIdentity,
    runRoot,
    toolIdentities: verifiedTools.identities,
    tools,
  };

  process.stdout.write('native toolchain probe: sealed input preflight\n');
  const inputManifest = await verifyInputManifest(context, fullInputAudit);
  context.inputManifest = inputManifest;
  const buildAPath = path.join(runRoot, 'build-a');
  const buildBPath = path.join(runRoot, 'build-second-root-with-distinct-length');
  await mkdir(buildAPath, { recursive: false });
  await mkdir(buildBPath, { recursive: false });

  process.stdout.write('native toolchain probe: MSVC release/direct Node-API\n');
  const buildA = await buildRelease(context, buildAPath, 'release-a');
  const buildB = await buildRelease(context, buildBPath, 'release-b');
  tools.__bootstrap__ = buildA.bootstrap;
  const pe = await inspectReleaseBuild(context, buildA, 'release-a');
  const releaseHashes = await compareReleaseBuilds(buildA, buildB);
  const nodeLoad = await loadAddon(context, buildA);

  process.stdout.write('native toolchain probe: MSVC ASan\n');
  const asanRoot = path.join(runRoot, 'asan');
  await mkdir(asanRoot, { recursive: false });
  tools.__asan__ = path.join(asanRoot, 'out', 'asan-canary.exe');
  const asan = await runAsanProbe(context, asanRoot);

  process.stdout.write('native toolchain probe: LLVM fuzz/coverage\n');
  const llvmRoot = path.join(runRoot, 'llvm');
  await mkdir(llvmRoot, { recursive: false });
  tools.__llvm_fuzzer__ = path.join(llvmRoot, 'out', 'llvm-fuzzer.exe');
  tools.__llvm_coverage__ = path.join(llvmRoot, 'out', 'llvm-coverage.exe');
  const llvm = await runLlvmProbe(context, llvmRoot);
  process.stdout.write('native toolchain probe: post-use input replay\n');
  const inputReplay = await replayNativeBuildInputsWithinAuthority(
    authority,
    replayBinding,
    { timeoutMs: INPUT_AUDIT_TIMEOUT_MS },
  );

  const result = {
    asan,
    configAuthority: {
      bytes: configBytes.length,
      sha256: sha256Bytes(configBytes),
    },
    fixtureIdentities,
    inputManifest,
    inputReplay,
    llvm,
    llvmRuntimeIdentities,
    msvcAsanRuntime: {
      bytes: msvcAsanRuntime.bytes,
      logicalPath: 'msvc/bin/Hostx64/x64/clang_rt.asan_dynamic-x86_64.dll',
      sha256: msvcAsanRuntime.sha256,
    },
    nodeLibrarySha256: nodeSdk.nodeLibrarySha256,
    nodeLoad,
    outputPathAudit: {
      cache: cachePathAudit,
      run: runPathAudit,
    },
    pe,
    privateSystemToolSurface: authority.privateSystemToolSurface,
    releaseHashes,
    admittedOutputsByteIdenticalAcrossDistinctRoots: true,
  };

  const execution = await executionProfile.finalize();
  invariant(
    execution.operationReceipts.length === 41
      && execution.authorityFinalization.bootstrapSourcePowerShellExecutions === 1
      && execution.authorityFinalization.commandCount === 10
      && execution.authorityFinalization.sourceTaskkillExecutions === 0
      && execution.authorityFinalization.terminationRequestedCount === 0
      && execution.authorityFinalization.privateCopy.beforeAfterExactTupleEquality === true
      && execution.authorityTeardown.outcome === 'removed'
      && execution.authorityTeardown.runRootAbsent === true,
    'EXECUTION_AUTHORITY_CLOSURE_MISMATCH',
    'native probe did not finish with the exact positive process and teardown closure',
  );
  const receipt = buildReceipt(context, result, execution);
  process.stdout.write(`${canonicalJson({
    outcome: 'passed',
    receipt: receipt.document,
    receiptBytes: receipt.bytes,
    receiptSha256: receipt.sha256,
    runId,
  })}\n`);
}

const invokedPath = process.argv[1] === undefined ? '' : path.resolve(process.argv[1]);
if (invokedPath === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    const code = error instanceof ProbeFailure ? error.code : 'UNEXPECTED_ERROR';
    const detail = error instanceof ProbeFailure && error.detail !== undefined
      ? activeRedactor(typeof error.detail === 'string' ? error.detail : canonicalJson(error.detail))
      : undefined;
    process.stderr.write(`${canonicalJson({ code, detail, message: activeRedactor(error.message), outcome: 'failed', runId: activeRunId })}\n`);
    process.exitCode = 1;
  });
}

export {
  ProbeFailure,
  assertCorrectedLlvmFlags,
  assertSectionPolicy,
  assertSystemRootAuthority,
  assertReleaseLinkIsolationPolicy,
  assertReleaseStaticRuntimeFlags,
  assertStaticCrtLinkTrace,
  assertGuardEhContinuationConsistency,
  assertLlvmCoverageShow,
  buildRelease,
  canonicalJson,
  compareReleaseBuilds,
  createLogicalResolver,
  expandTokens,
  llvmLinkArguments,
  parseLlvmBranchCoverageReport,
  parseArguments,
  validateProbeNodeEnvironment,
};
