import { isDeepStrictEqual } from 'node:util';
import path from 'node:path';

import {
  commandReceipt,
  createLogicalizer,
  runCommand,
  verifyFile,
} from '../preseal/preseal-evidence.mjs';
import {
  SEALED_SYSTEM_TOOL_AUTHORITY,
  assertSealedSystemToolAuthority,
} from '../preseal/system-tool-authority.mjs';

const DEFAULT_MAX_OUTPUT_BYTES = 16 * 1024 * 1024;
const MAX_ARGUMENT_COUNT = 512;
const MAX_COMMAND_LINE_CODE_UNITS = 32_767;
const MAX_OUTPUT_BYTES = 16 * 1024 * 1024;
const DEFAULT_TIMEOUT_MS = 120_000;
const ASAN_TIMEOUT_MS = 30_000;
const LLVM_FUZZ_TIMEOUT_MS = 60_000;

const BASE_ENVIRONMENT_KEYS = Object.freeze([
  'ComSpec',
  'INCLUDE',
  'LIB',
  'LIBPATH',
  'NO_COLOR',
  'PATHEXT',
  'Path',
  'PROCESSOR_ARCHITECTURE',
  'SystemRoot',
  'TEMP',
  'TERM',
  'TMP',
  'VSLANG',
  'WINDIR',
]);

const STABLE_TOOL_IDS = Object.freeze([
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

const DYNAMIC_TOOL_PATHS = Object.freeze({
  __asan__: ['asan', 'out', 'asan-canary.exe'],
  __bootstrap__: ['build-a', 'out', 'pc-sdk-next-bootstrap-probe.exe'],
  __llvm_coverage__: ['llvm', 'out', 'llvm-coverage.exe'],
  __llvm_fuzzer__: ['llvm', 'out', 'llvm-fuzzer.exe'],
});

const OPERATION_DEFINITIONS = Object.freeze([
  ['release-a-compile-input-digest-resource', 'rc', ['build-a', 'generated']],
  ['release-a-compile-core', 'cl', ['build-a']],
  ['release-a-archive-core', 'lib', ['build-a']],
  ['release-a-compile-bootstrap', 'cl', ['build-a']],
  ['release-a-link-bootstrap', 'link', ['build-a']],
  ['release-a-compile-addon', 'cl', ['build-a']],
  ['release-a-link-addon', 'link', ['build-a']],
  ['release-a-compile-sqlite-c-flags', 'cl', ['build-a']],
  ['release-b-compile-input-digest-resource', 'rc', ['build-second-root-with-distinct-length', 'generated']],
  ['release-b-compile-core', 'cl', ['build-second-root-with-distinct-length']],
  ['release-b-archive-core', 'lib', ['build-second-root-with-distinct-length']],
  ['release-b-compile-bootstrap', 'cl', ['build-second-root-with-distinct-length']],
  ['release-b-link-bootstrap', 'link', ['build-second-root-with-distinct-length']],
  ['release-b-compile-addon', 'cl', ['build-second-root-with-distinct-length']],
  ['release-b-link-addon', 'link', ['build-second-root-with-distinct-length']],
  ['release-b-compile-sqlite-c-flags', 'cl', ['build-second-root-with-distinct-length']],
  ['release-a-dumpbin-pc-sdk-next-bootstrap', 'dumpbin', ['build-a', 'out']],
  ['release-a-dumpbin-pc-sdk-next-containment-addon', 'dumpbin', ['build-a', 'out']],
  ['release-a-extract-bootstrap-manifest', 'mt', ['build-a', 'out']],
  ['release-a-run-bootstrap', '__bootstrap__', ['build-a', 'out']],
  ['load-direct-napi-addon', 'node', ['build-a', 'out']],
  ['asan-compile', 'cl', ['asan']],
  ['asan-link-via-cl-driver', 'cl', ['asan']],
  ['asan-directives', 'dumpbin', ['asan']],
  ['asan-positive-canary', '__asan__', ['asan', 'out'], 'asan'],
  ['asan-negative-canary', '__asan__', ['asan', 'out'], 'asan', ASAN_TIMEOUT_MS],
  ['llvm-fuzz-compile-projection', 'clang-cl', ['llvm']],
  ['llvm-fuzz-compile', 'clang-cl', ['llvm']],
  ['llvm-fuzz-link-projection', 'clang-cl', ['llvm']],
  ['llvm-fuzz-link', 'clang-cl', ['llvm']],
  ['llvm-fuzzer-positive-canary', '__llvm_fuzzer__', ['llvm', 'out'], 'base', LLVM_FUZZ_TIMEOUT_MS],
  ['llvm-coverage-compile-projection', 'clang-cl', ['llvm']],
  ['llvm-coverage-compile', 'clang-cl', ['llvm']],
  ['llvm-coverage-link-projection', 'clang-cl', ['llvm']],
  ['llvm-coverage-link', 'clang-cl', ['llvm']],
  ['llvm-coverage-negative-branch', '__llvm_coverage__', ['llvm', 'out'], 'coverage'],
  ['llvm-coverage-zero-branch', '__llvm_coverage__', ['llvm', 'out'], 'coverage'],
  ['llvm-coverage-positive-branch', '__llvm_coverage__', ['llvm', 'out'], 'coverage'],
  ['llvm-profdata-merge', 'llvm-profdata', ['llvm']],
  ['llvm-cov-report', 'llvm-cov', ['llvm']],
  ['llvm-cov-show', 'llvm-cov', ['llvm']],
].map(([id, tool, cwdParts, environmentKind = 'base', timeoutMs = DEFAULT_TIMEOUT_MS]) => Object.freeze({
  cwdParts: Object.freeze(cwdParts),
  environmentKind,
  id,
  timeoutMs,
  tool,
})));

export const NATIVE_TOOLCHAIN_PROBE_OPERATION_IDS = Object.freeze(
  OPERATION_DEFINITIONS.map(({ id }) => id),
);

const SHA256_PATTERN = /^[0-9a-f]{64}$/u;
const PROVIDER_ENVIRONMENT_PATTERN = /^(?:ANTHROPIC|CLAUDE|CODEX|OPENAI)(?:_|$)/u;
const WINDOWS_ABSOLUTE_PATH_PATTERN = /[A-Za-z]:[\\/]/gu;
const CONCATENATED_MSVC_PATH_ARGUMENT_PATTERN = /^(\/(?:Fd|Fe|Fo|I))(?=[A-Za-z]:[\\/])/iu;
const CLAIMED_AUTHORITIES = new WeakSet();

function fail(message) {
  throw new Error(`native toolchain probe execution profile: ${message}`);
}

function assertPlainObject(value, label) {
  if (
    value === null
    || typeof value !== 'object'
    || Array.isArray(value)
    || Object.getPrototypeOf(value) !== Object.prototype
  ) {
    fail(`${label} must be one plain object`);
  }
}

function assertExactKeys(value, expected, label) {
  assertPlainObject(value, label);
  const actual = Object.keys(value).sort(compareOrdinal);
  const sortedExpected = [...expected].sort(compareOrdinal);
  if (!isDeepStrictEqual(actual, sortedExpected)) {
    fail(`${label} keys did not equal the exact closed set`);
  }
}

function compareOrdinal(left, right) {
  return left < right ? -1 : left > right ? 1 : 0;
}

function normalizedPath(value) {
  return path.resolve(value).replaceAll('\\', '/').toLowerCase();
}

function samePath(left, right) {
  return normalizedPath(left) === normalizedPath(right);
}

function isPathWithin(candidate, root) {
  const relative = path.relative(root, candidate);
  return relative === '' || (
    relative !== '..'
    && !relative.startsWith(`..${path.sep}`)
    && !path.isAbsolute(relative)
  );
}

function assertLocalAbsolutePath(value, label) {
  if (
    typeof value !== 'string'
    || value.length === 0
    || value.includes('\0')
    || !/^[A-Za-z]:[\\/]/u.test(value)
    || value.startsWith('\\\\')
    || !path.isAbsolute(value)
  ) {
    fail(`${label} must be one absolute local Windows path`);
  }
  return path.resolve(value);
}

function deepFreeze(value) {
  if (value === null || typeof value !== 'object' || Object.isFrozen(value)) return value;
  for (const child of Object.values(value)) deepFreeze(child);
  return Object.freeze(value);
}

function cloneStringMap(value, label) {
  assertPlainObject(value, label);
  const clone = {};
  const folded = new Set();
  for (const [name, setting] of Object.entries(value)) {
    const foldedName = name.toUpperCase();
    if (
      !/^[A-Za-z_][A-Za-z0-9_()]*$/u.test(name)
      || folded.has(foldedName)
      || PROVIDER_ENVIRONMENT_PATTERN.test(foldedName)
      || typeof setting !== 'string'
      || setting.includes('\0')
      || setting.includes('\r')
      || setting.includes('\n')
      || setting.length > MAX_COMMAND_LINE_CODE_UNITS
    ) {
      fail(`${label} was not one bounded provider-free string map`);
    }
    folded.add(foldedName);
    clone[name] = setting;
  }
  return clone;
}

function absolutePathStartsWithinAllowedRoot(value, start, allowedRoots) {
  const tail = value.slice(start).replaceAll('\\', '/').toLowerCase();
  return allowedRoots.some((root) => {
    const normalizedRoot = root.replaceAll('\\', '/').replace(/\/+$/u, '').toLowerCase();
    if (!tail.startsWith(normalizedRoot)) return false;
    const next = tail[normalizedRoot.length];
    return next === undefined || next === '/' || /[=,;:"'\s)]/u.test(next);
  });
}

function assertOnlyAllowedAbsolutePaths(value, allowedRoots, label) {
  WINDOWS_ABSOLUTE_PATH_PATTERN.lastIndex = 0;
  for (const match of value.matchAll(WINDOWS_ABSOLUTE_PATH_PATTERN)) {
    if (!absolutePathStartsWithinAllowedRoot(value, match.index, allowedRoots)) {
      fail(`${label} contained an absolute path outside the admitted roots`);
    }
  }
}

function assertClosedBaseEnvironment(environment, { allowedRoots, systemRoot, tempRoot }) {
  assertExactKeys(environment, BASE_ENVIRONMENT_KEYS, 'base environment');
  const clone = cloneStringMap(environment, 'base environment');
  if (
    !samePath(clone.ComSpec, path.join(systemRoot, 'System32', 'cmd.exe'))
    || !samePath(clone.SystemRoot, systemRoot)
    || !samePath(clone.WINDIR, systemRoot)
    || !samePath(clone.TEMP, tempRoot)
    || !samePath(clone.TMP, tempRoot)
    || clone.NO_COLOR !== '1'
    || clone.PATHEXT !== '.COM;.EXE;.BAT;.CMD'
    || clone.PROCESSOR_ARCHITECTURE !== 'AMD64'
    || clone.TERM !== 'dumb'
    || clone.VSLANG !== '1033'
  ) {
    fail('base environment did not equal the fixed Windows build profile');
  }
  for (const [name, setting] of Object.entries(clone)) {
    assertOnlyAllowedAbsolutePaths(setting, allowedRoots, `base environment ${name}`);
  }
  return deepFreeze(clone);
}

function expectedEnvironmentForOperation(definition, provided, state) {
  const selected = provided === undefined ? state.environment : provided;
  const environment = cloneStringMap(selected, `${definition.id} environment`);
  let expected;
  if (definition.environmentKind === 'base') {
    expected = state.environment;
  } else if (definition.environmentKind === 'asan') {
    expected = {
      ...state.environment,
      ASAN_OPTIONS: 'abort_on_error=1:halt_on_error=1:symbolize=1',
      ASAN_SYMBOLIZER_PATH: state.stableToolPaths['llvm-symbolizer'],
      Path: `${path.dirname(state.stableToolPaths.cl)};${path.dirname(state.stableToolPaths['llvm-symbolizer'])};${state.environment.Path}`,
    };
  } else if (definition.environmentKind === 'coverage') {
    expected = {
      ...state.environment,
      LLVM_PROFILE_FILE: path.join(state.runRoot, 'llvm', 'profiles', '%m-%p.profraw'),
    };
  } else {
    fail(`${definition.id} referenced an unknown environment profile`);
  }
  if (!isDeepStrictEqual(environment, expected)) {
    fail(`${definition.id} environment did not equal its exact admitted projection`);
  }
  for (const [name, setting] of Object.entries(environment)) {
    assertOnlyAllowedAbsolutePaths(setting, state.allowedRoots, `${definition.id} environment ${name}`);
  }
  return deepFreeze(environment);
}

function validateArguments(args, allowedRoots, operationId) {
  if (!Array.isArray(args) || args.length > MAX_ARGUMENT_COUNT) {
    fail(`${operationId} arguments exceeded the exact count bound`);
  }
  let commandLineCodeUnits = 0;
  const snapshot = args.map((argument, index) => {
    if (
      typeof argument !== 'string'
      || argument.includes('\0')
      || argument.includes('\r')
      || argument.includes('\n')
      || argument.length > MAX_COMMAND_LINE_CODE_UNITS
      || argument.startsWith('@')
    ) {
      fail(`${operationId} argument ${index} was not one bounded literal argument`);
    }
    commandLineCodeUnits += argument.length + 3;
    assertOnlyAllowedAbsolutePaths(argument, allowedRoots, `${operationId} argument ${index}`);
    return argument;
  });
  if (commandLineCodeUnits > MAX_COMMAND_LINE_CODE_UNITS) {
    fail(`${operationId} arguments exceeded the Windows command-line bound`);
  }
  return Object.freeze(snapshot);
}

export function logicalizeNativeToolchainProbeReceiptValue(value, logicalize) {
  if (typeof logicalize !== 'function') {
    fail('receipt logicalizer was unavailable');
  }
  const rendered = String(value).replaceAll('\\', '/');
  const direct = logicalize(rendered);
  const concatenated = CONCATENATED_MSVC_PATH_ARGUMENT_PATTERN.exec(rendered);
  if (concatenated === null) return direct;
  return `${concatenated[1]}${logicalize(rendered.slice(concatenated[1].length))}`;
}

export function isAdmittedAsanNegativeTerminal(exitCode, signal) {
  return (
    Number.isSafeInteger(exitCode)
    && exitCode !== 0
    && signal === null
  ) || (
    exitCode === null
    && typeof signal === 'string'
    && signal.length > 0
  );
}

function expectedPrivateToolTuples() {
  return [
    SEALED_SYSTEM_TOOL_AUTHORITY.authenticodeVerificationTool,
    SEALED_SYSTEM_TOOL_AUTHORITY.processTreeTerminationTool,
  ].map((tool) => [
    `run-private/system-tools/${tool.privateCopyFileName}`,
    tool.bytes,
    tool.sha256,
  ]).sort((left, right) => compareOrdinal(left[0], right[0]));
}

function validateAuthority(authority, repositoryRoot) {
  assertPlainObject(authority, 'filesystem audit authority');
  if (
    typeof authority.finalize !== 'function'
    || typeof authority.teardown !== 'function'
    || authority.finalized !== false
  ) {
    fail('filesystem audit authority was not one active unfinalized authority');
  }
  assertPlainObject(authority.configContext, 'filesystem audit config context');
  assertPlainObject(authority.configContext.config, 'filesystem audit config');
  assertSealedSystemToolAuthority(authority.configContext.config.root?.hostToolchain);
  const locations = authority.configContext.locations;
  assertPlainObject(locations, 'filesystem audit locations');
  const configuredRepositoryRoot = assertLocalAbsolutePath(locations.repo, 'configured repository root');
  if (!samePath(repositoryRoot, configuredRepositoryRoot)) {
    fail('repository root did not equal the filesystem audit config authority');
  }
  assertPlainObject(authority.run, 'filesystem audit run');
  const runRoot = assertLocalAbsolutePath(authority.run.runRoot, 'filesystem audit run root');
  const tempRoot = assertLocalAbsolutePath(authority.run.tempRoot, 'filesystem audit temp root');
  const cacheRoot = assertLocalAbsolutePath(locations.cache, 'configured cache root');
  if (
    !samePath(path.dirname(runRoot), path.join(cacheRoot, 'runs'))
    || !/^[0-9a-f]{32}$/u.test(path.basename(runRoot))
    || !samePath(tempRoot, path.join(runRoot, 'temp'))
  ) {
    fail('filesystem audit run/temp roots did not equal the fixed authority layout');
  }
  assertPlainObject(authority.privateSystemToolSurface, 'private system tool surface');
  const privateSurface = authority.privateSystemToolSurface;
  const expectedTuples = expectedPrivateToolTuples();
  if (
    privateSurface.identityPolicy !== SEALED_SYSTEM_TOOL_AUTHORITY.servicedSystemToolPolicy.privateCopyIdentity
    || privateSurface.fileCount !== expectedTuples.length
    || privateSurface.byteLength !== expectedTuples.reduce((total, tuple) => total + tuple[1], 0)
    || !isDeepStrictEqual(privateSurface.tuples, expectedTuples)
  ) {
    fail('private system tool surface did not bind the exact sealed copies');
  }
  const systemRoot = assertLocalAbsolutePath(locations.system, 'configured system root');
  const allowedRoots = [runRoot, repositoryRoot];
  for (const [id, location] of Object.entries(locations)) {
    allowedRoots.push(assertLocalAbsolutePath(location, `configured location ${id}`));
  }
  return {
    allowedRoots: Object.freeze([...new Set(allowedRoots.map((root) => path.resolve(root)))]),
    config: authority.configContext.config,
    locations,
    runRoot,
    systemRoot,
    tempRoot,
  };
}

function validateStableTools(tools, config, resolveLogical) {
  assertExactKeys(tools, STABLE_TOOL_IDS, 'verified tool map');
  const configuredTuples = new Map();
  for (const tuple of config.root?.hostToolchain?.tools ?? []) {
    if (!Array.isArray(tuple) || tuple.length !== 5 || configuredTuples.has(tuple[0])) {
      fail('configured native tool tuple closure was malformed');
    }
    configuredTuples.set(tuple[0], tuple);
  }
  const stableToolPaths = {};
  const stableToolExpectations = {};
  for (const id of STABLE_TOOL_IDS) {
    const tuple = configuredTuples.get(id);
    if (tuple === undefined) fail(`configured native tool ${id} was absent`);
    const [, logicalPath, bytes, , sha256] = tuple;
    if (
      typeof logicalPath !== 'string'
      || !Number.isSafeInteger(bytes)
      || bytes < 1
      || typeof sha256 !== 'string'
      || !SHA256_PATTERN.test(sha256)
      || typeof resolveLogical !== 'function'
    ) {
      fail(`configured native tool ${id} identity was malformed`);
    }
    const expectedPath = assertLocalAbsolutePath(resolveLogical(logicalPath), `configured native tool ${id}`);
    const selectedPath = assertLocalAbsolutePath(tools[id], `verified native tool ${id}`);
    if (!samePath(selectedPath, expectedPath)) {
      fail(`verified native tool ${id} did not equal its config-derived path`);
    }
    stableToolPaths[id] = expectedPath;
    stableToolExpectations[id] = deepFreeze({ bytes, logicalPath, sha256 });
  }
  return {
    stableToolExpectations: deepFreeze(stableToolExpectations),
    stableToolPaths: deepFreeze(stableToolPaths),
  };
}

function validateRunOptions(options, expectedDefinition, state) {
  const allowedOptionKeys = ['args', 'cwd', 'env', 'expectedExit', 'label', 'maxOutputBytes', 'timeoutMs', 'tool'];
  assertPlainObject(options, 'run options');
  if (Object.keys(options).some((key) => !allowedOptionKeys.includes(key))) {
    fail(`${expectedDefinition.id} run options contained an undeclared override`);
  }
  for (const required of ['args', 'cwd', 'label', 'tool']) {
    if (!Object.hasOwn(options, required)) fail(`${expectedDefinition.id} omitted required ${required}`);
  }
  if (options.label !== expectedDefinition.id) {
    fail(`operation ${expectedDefinition.id} label changed`);
  }
  if (options.tool !== expectedDefinition.tool) {
    fail(`operation ${expectedDefinition.id} tool changed`);
  }
  const expectedCwd = path.join(state.runRoot, ...expectedDefinition.cwdParts);
  const cwd = assertLocalAbsolutePath(options.cwd, `${expectedDefinition.id} cwd`);
  if (!samePath(cwd, expectedCwd) || !isPathWithin(cwd, state.runRoot)) {
    fail(`${expectedDefinition.id} cwd changed from its exact run-owned directory`);
  }
  const timeoutMs = options.timeoutMs ?? expectedDefinition.timeoutMs;
  if (timeoutMs !== expectedDefinition.timeoutMs) {
    fail(`${expectedDefinition.id} timeout changed from its exact bound`);
  }
  const maxOutputBytes = options.maxOutputBytes ?? DEFAULT_MAX_OUTPUT_BYTES;
  if (!Number.isSafeInteger(maxOutputBytes) || maxOutputBytes < 1 || maxOutputBytes > MAX_OUTPUT_BYTES) {
    fail(`${expectedDefinition.id} output bound was invalid`);
  }
  if (options.expectedExit !== undefined && typeof options.expectedExit !== 'function') {
    fail(`${expectedDefinition.id} expected-exit predicate was invalid`);
  }
  return {
    args: validateArguments(options.args, state.allowedRoots, expectedDefinition.id),
    cwd,
    env: expectedEnvironmentForOperation(expectedDefinition, options.env, state),
    expectedExit: options.expectedExit,
    maxOutputBytes,
    timeoutMs,
  };
}

async function verifyExactFile(filePath, expected, label, requireSingleLink = true) {
  try {
    return await verifyFile(filePath, expected, { requireSingleLink });
  } catch (error) {
    fail(`${label} verification failed: ${error.message}`);
  }
}

function assertCleanCompletion(result, definition, expectedExit) {
  if (
    !Buffer.isBuffer(result.stdout)
    || !Buffer.isBuffer(result.stderr)
    || result.cleanupErrorCode !== null
    || result.cleanupOutcome !== 'not-required'
    || result.ownedRootExitObserved !== true
    || result.overflow !== false
    || result.timedOut !== false
    || result.terminationRequested !== false
    || result.terminationReason !== null
    || result.terminationToolCompletionObserved !== false
    || result.terminationToolExitCode !== null
    || result.terminationToolSignal !== null
  ) {
    fail(`${definition.id} lacked one clean bounded completion receipt`);
  }
  const admitted = definition.id === 'asan-negative-canary'
    ? isAdmittedAsanNegativeTerminal(result.exitCode, result.signal)
    : result.exitCode === 0 && result.signal === null;
  if (!admitted || (expectedExit !== undefined && expectedExit(result.exitCode, result.signal) !== true)) {
    fail(`${definition.id} returned an unadmitted exit result`);
  }
}

export function createNativeToolchainProbeExecutionProfile(options) {
  assertExactKeys(
    options,
    ['authority', 'environment', 'repositoryRoot', 'resolveLogical', 'tools'],
    'execution profile options',
  );
  const { authority, tools } = options;
  const repositoryRoot = assertLocalAbsolutePath(options.repositoryRoot, 'repository root');
  const authorityContext = validateAuthority(authority, repositoryRoot);
  const toolContext = validateStableTools(
    tools,
    authority.configContext.config,
    options.resolveLogical,
  );
  const state = {
    ...authorityContext,
    ...toolContext,
    environment: undefined,
  };
  state.environment = assertClosedBaseEnvironment(options.environment, state);
  if (CLAIMED_AUTHORITIES.has(authority)) {
    fail('filesystem audit authority was already claimed by an execution profile');
  }
  CLAIMED_AUTHORITIES.add(authority);
  const logicalize = createLogicalizer({
    '<run>': state.runRoot,
    '<repo>': repositoryRoot,
    '<cache>': state.locations.cache,
    '<system>': state.systemRoot,
    ...Object.fromEntries(Object.entries(state.locations).map(([id, root]) => [`<location:${id}>`, root])),
  });
  const logicalizeReceiptValue = (value) => (
    logicalizeNativeToolchainProbeReceiptValue(value, logicalize)
  );
  const terminationTool = SEALED_SYSTEM_TOOL_AUTHORITY.processTreeTerminationTool;
  const terminationPolicy = SEALED_SYSTEM_TOOL_AUTHORITY.servicedSystemToolPolicy;
  const taskkillPath = path.join(state.runRoot, 'system-tools', terminationTool.privateCopyFileName);
  const terminationAuthority = deepFreeze({
    cwd: state.runRoot,
    env: {
      SYSTEMROOT: state.systemRoot,
      TEMP: state.tempRoot,
      TMP: state.tempRoot,
      WINDIR: state.systemRoot,
    },
    executable: taskkillPath,
    executableId: 'taskkill-private',
    policyId: terminationPolicy.terminationInvocation,
  });
  let failed = false;
  let finalizationStarted = false;
  let finalized = false;
  let inProgress = false;
  let nextOperationIndex = 0;
  const operationReceipts = [];
  const executableBindings = new Map();
  let initializationPromise;
  let taskkillBinding;

  async function initialize() {
    initializationPromise ??= (async () => {
      taskkillBinding = await verifyExactFile(
        taskkillPath,
        terminationTool,
        'private taskkill executable',
      );
      for (const id of STABLE_TOOL_IDS) {
        const binding = await verifyExactFile(
          state.stableToolPaths[id],
          state.stableToolExpectations[id],
          `stable native tool ${id}`,
          false,
        );
        executableBindings.set(normalizedPath(state.stableToolPaths[id]), {
          binding,
          expected: state.stableToolExpectations[id],
          id,
          path: state.stableToolPaths[id],
          requireSingleLink: false,
        });
      }
    })();
    return await initializationPromise;
  }

  async function replayBinding(bindingRecord, label) {
    const replay = await verifyExactFile(
      bindingRecord.path,
      bindingRecord.expected,
      label,
      bindingRecord.requireSingleLink,
    );
    if (!isDeepStrictEqual(replay, bindingRecord.binding)) {
      fail(`${label} stable identity replay changed`);
    }
  }

  async function selectExecutable(definition) {
    if (Object.hasOwn(state.stableToolPaths, definition.tool)) {
      const record = executableBindings.get(normalizedPath(state.stableToolPaths[definition.tool]));
      await replayBinding(record, `${definition.id} executable`);
      return record;
    }
    const relativePath = DYNAMIC_TOOL_PATHS[definition.tool];
    if (relativePath === undefined) fail(`${definition.id} dynamic tool authority was absent`);
    if (Object.keys(tools).some((id) => !STABLE_TOOL_IDS.includes(id) && !Object.hasOwn(DYNAMIC_TOOL_PATHS, id))) {
      fail(`${definition.id} tool map contained an undeclared dynamic role`);
    }
    const expectedPath = path.join(state.runRoot, ...relativePath);
    const selectedPath = assertLocalAbsolutePath(tools[definition.tool], `${definition.id} dynamic executable`);
    if (!samePath(selectedPath, expectedPath)) {
      fail(`${definition.id} dynamic executable changed from its exact run-owned path`);
    }
    const key = normalizedPath(expectedPath);
    const existing = executableBindings.get(key);
    if (existing !== undefined) {
      await replayBinding(existing, `${definition.id} executable`);
      return existing;
    }
    const binding = await verifyExactFile(expectedPath, {}, `${definition.id} executable`);
    const record = {
      binding,
      expected: {
        bytes: binding.observed.bytes,
        sha256: binding.observed.sha256,
      },
      id: definition.tool,
      path: expectedPath,
      requireSingleLink: true,
    };
    executableBindings.set(key, record);
    return record;
  }

  const profile = {
    get receipts() {
      return deepFreeze(operationReceipts.map((receipt) => structuredClone(receipt)));
    },
    async run(runOptions) {
      if (failed || finalizationStarted || finalized || inProgress) {
        fail('execution profile was no longer active');
      }
      inProgress = true;
      const definition = OPERATION_DEFINITIONS[nextOperationIndex];
      if (definition === undefined) {
        failed = true;
        fail('all exact operations were already consumed');
      }
      let admitted;
      try {
        admitted = validateRunOptions(runOptions, definition, state);
      } catch (error) {
        failed = true;
        throw error;
      }
      nextOperationIndex += 1;
      try {
        await initialize();
        const executable = await selectExecutable(definition);
        const taskkillRecord = {
          binding: taskkillBinding,
          expected: terminationTool,
          path: taskkillPath,
          requireSingleLink: true,
        };
        await replayBinding(taskkillRecord, `${definition.id} taskkill authority`);
        const plan = {
          args: [...admitted.args],
          cwd: admitted.cwd,
          env: { ...admitted.env },
          executable: executable.path,
          shell: false,
        };
        const result = await runCommand(plan, {
          maxOutputBytes: admitted.maxOutputBytes,
          ownedRootExitTimeoutMs: terminationPolicy.ownedRootExitTimeoutMs,
          terminationAuthority,
          terminationToolTimeoutMs: terminationPolicy.terminationToolTimeoutMs,
          timeoutMs: admitted.timeoutMs,
        });
        await replayBinding(executable, `${definition.id} executable post-use`);
        if (result.terminationRequested) {
          await replayBinding(taskkillRecord, `${definition.id} taskkill authority post-use`);
        }
        const receipt = deepFreeze({
          operationId: definition.id,
          label: definition.id,
          tool: definition.tool,
          executable: {
            bytes: executable.binding.observed.bytes,
            sha256: executable.binding.observed.sha256,
          },
          ...commandReceipt(plan, result, {
            executableId: definition.tool,
            logicalize: logicalizeReceiptValue,
          }),
        });
        operationReceipts.push(receipt);
        assertCleanCompletion(result, definition, admitted.expectedExit);
        return {
          ...result,
          stderr: Buffer.from(result.stderr),
          stdout: Buffer.from(result.stdout),
        };
      } catch (error) {
        failed = true;
        throw error;
      } finally {
        inProgress = false;
      }
    },
    async finalize() {
      if (failed || finalizationStarted || finalized || inProgress) {
        fail('execution profile could not be finalized');
      }
      if (nextOperationIndex !== OPERATION_DEFINITIONS.length) {
        fail('execution profile did not consume the exact 41-operation closure');
      }
      finalizationStarted = true;
      try {
        await initialize();
        for (const record of executableBindings.values()) {
          await replayBinding(record, `final ${record.id} executable`);
        }
        await replayBinding({
          binding: taskkillBinding,
          expected: terminationTool,
          path: taskkillPath,
          requireSingleLink: true,
        }, 'final taskkill authority');
        const authorityFinalization = await authority.finalize();
        const authorityTeardown = await authority.teardown();
        finalized = true;
        return deepFreeze({
          authorityFinalization,
          authorityTeardown,
          operationReceipts: operationReceipts.map((receipt) => structuredClone(receipt)),
        });
      } catch (error) {
        failed = true;
        throw error;
      }
    },
  };
  return Object.freeze(profile);
}
