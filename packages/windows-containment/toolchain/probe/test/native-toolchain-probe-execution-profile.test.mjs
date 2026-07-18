import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';

import {
  NATIVE_TOOLCHAIN_PROBE_OPERATION_IDS,
  createNativeToolchainProbeExecutionProfile,
  isAdmittedAsanNegativeTerminal,
  logicalizeNativeToolchainProbeReceiptValue,
} from '../native-toolchain-probe-execution-profile.mjs';
import {
  assertReceiptPrivate,
  createLogicalizer,
} from '../../preseal/preseal-evidence.mjs';
import { SEALED_SYSTEM_TOOL_AUTHORITY } from '../../preseal/system-tool-authority.mjs';

const EXPECTED_OPERATION_IDS = Object.freeze([
  'release-a-compile-input-digest-resource',
  'release-a-compile-core',
  'release-a-archive-core',
  'release-a-compile-bootstrap',
  'release-a-link-bootstrap',
  'release-a-compile-addon',
  'release-a-link-addon',
  'release-a-compile-sqlite-c-flags',
  'release-b-compile-input-digest-resource',
  'release-b-compile-core',
  'release-b-archive-core',
  'release-b-compile-bootstrap',
  'release-b-link-bootstrap',
  'release-b-compile-addon',
  'release-b-link-addon',
  'release-b-compile-sqlite-c-flags',
  'release-a-dumpbin-pc-sdk-next-bootstrap',
  'release-a-dumpbin-pc-sdk-next-containment-addon',
  'release-a-extract-bootstrap-manifest',
  'release-a-run-bootstrap',
  'load-direct-napi-addon',
  'asan-compile',
  'asan-link-via-cl-driver',
  'asan-directives',
  'asan-positive-canary',
  'asan-negative-canary',
  'llvm-fuzz-compile-projection',
  'llvm-fuzz-compile',
  'llvm-fuzz-link-projection',
  'llvm-fuzz-link',
  'llvm-fuzzer-positive-canary',
  'llvm-coverage-compile-projection',
  'llvm-coverage-compile',
  'llvm-coverage-link-projection',
  'llvm-coverage-link',
  'llvm-coverage-negative-branch',
  'llvm-coverage-zero-branch',
  'llvm-coverage-positive-branch',
  'llvm-profdata-merge',
  'llvm-cov-report',
  'llvm-cov-show',
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

const REPOSITORY_ROOT = 'C:\\sealed-repository';
const RUN_ROOT = `C:\\sealed-cache\\runs\\${'a'.repeat(32)}`;

function privateToolTuples() {
  return [
    SEALED_SYSTEM_TOOL_AUTHORITY.authenticodeVerificationTool,
    SEALED_SYSTEM_TOOL_AUTHORITY.processTreeTerminationTool,
  ].map((tool) => [
    `run-private/system-tools/${tool.privateCopyFileName}`,
    tool.bytes,
    tool.sha256,
  ]).sort((left, right) => left[0].localeCompare(right[0], 'en'));
}

function fixture() {
  const logicalToolPaths = Object.fromEntries(
    STABLE_TOOL_IDS.map((id) => [`sealed-tools/${id}.exe`, `C:\\sealed-tools\\${id}.exe`]),
  );
  const configuredTools = STABLE_TOOL_IDS.map((id) => [
    id,
    `sealed-tools/${id}.exe`,
    1,
    'test',
    '0'.repeat(64),
  ]);
  const locations = {
    cache: 'C:\\sealed-cache',
    git: 'C:\\sealed-git',
    preseal: 'C:\\sealed-cache\\preseal\\receipts',
    q0s: 'C:\\sealed-q0s',
    repo: REPOSITORY_ROOT,
    sdk: 'C:\\sealed-sdk',
    system: 'C:\\Windows',
    vs: 'C:\\sealed-vs',
    vsinstaller: 'C:\\sealed-vs-installer',
    vsstate: 'C:\\sealed-vs-state',
  };
  const authority = {
    configContext: {
      config: {
        root: {
          hostToolchain: {
            ...SEALED_SYSTEM_TOOL_AUTHORITY,
            tools: configuredTools,
          },
        },
      },
      locations,
    },
    finalize: async () => ({ outcome: 'finalized' }),
    finalized: false,
    privateSystemToolSurface: {
      byteLength: privateToolTuples().reduce((total, tuple) => total + tuple[1], 0),
      fileCount: 2,
      identityPolicy: SEALED_SYSTEM_TOOL_AUTHORITY.servicedSystemToolPolicy.privateCopyIdentity,
      surfaceSha256: '0'.repeat(64),
      tuples: privateToolTuples(),
    },
    run: {
      runRoot: RUN_ROOT,
      tempRoot: path.join(RUN_ROOT, 'temp'),
    },
    teardown: async () => ({ outcome: 'removed' }),
  };
  const environment = {
    ComSpec: 'C:\\Windows\\System32\\cmd.exe',
    INCLUDE: 'C:\\sealed-vs\\include;C:\\sealed-sdk\\include',
    LIB: 'C:\\sealed-vs\\lib;C:\\sealed-sdk\\lib',
    LIBPATH: 'C:\\sealed-vs\\lib',
    NO_COLOR: '1',
    PATHEXT: '.COM;.EXE;.BAT;.CMD',
    Path: 'C:\\sealed-vs\\bin;C:\\sealed-sdk\\bin;C:\\Windows\\System32',
    PROCESSOR_ARCHITECTURE: 'AMD64',
    SystemRoot: 'C:\\Windows',
    TEMP: path.join(RUN_ROOT, 'temp'),
    TERM: 'dumb',
    TMP: path.join(RUN_ROOT, 'temp'),
    VSLANG: '1033',
    WINDIR: 'C:\\Windows',
  };
  const tools = Object.fromEntries(
    STABLE_TOOL_IDS.map((id) => [id, `C:\\sealed-tools\\${id}.exe`]),
  );
  const resolveLogical = (logicalPath) => logicalToolPaths[logicalPath];
  return { authority, environment, repositoryRoot: REPOSITORY_ROOT, resolveLogical, tools };
}

function validFirstOperation(overrides = {}) {
  return {
    args: [],
    cwd: path.join(RUN_ROOT, 'build-a', 'generated'),
    label: EXPECTED_OPERATION_IDS[0],
    tool: 'rc',
    ...overrides,
  };
}

test('exports the immutable exact ordered 41-operation closure', () => {
  assert.equal(NATIVE_TOOLCHAIN_PROBE_OPERATION_IDS.length, 41);
  assert.equal(Object.isFrozen(NATIVE_TOOLCHAIN_PROBE_OPERATION_IDS), true);
  assert.deepEqual(NATIVE_TOOLCHAIN_PROBE_OPERATION_IDS, EXPECTED_OPERATION_IDS);
});

test('receipt logicalization closes every current concatenated MSVC path form', () => {
  const visualStudioRoot = 'C:\\sealed-vs';
  const logicalize = createLogicalizer({
    '<run>': RUN_ROOT,
    '<vs>': visualStudioRoot,
  });
  const cases = [
    [`/Fo${path.join(RUN_ROOT, 'build-a', 'out', 'core.obj')}`, '/Fo<run>/build-a/out/core.obj'],
    [`/Fd${path.join(RUN_ROOT, 'asan', 'out', 'compile.pdb')}`, '/Fd<run>/asan/out/compile.pdb'],
    [`/Fe${path.join(RUN_ROOT, 'asan', 'out', 'canary.exe')}`, '/Fe<run>/asan/out/canary.exe'],
    [`/I${path.join(visualStudioRoot, 'include')}`, '/I<vs>/include'],
    [`/OUT:${path.join(RUN_ROOT, 'build-a', 'out', 'probe.exe')}`, '/OUT:<run>/build-a/out/probe.exe'],
    [
      `/clang:-ffile-prefix-map=${path.join(RUN_ROOT, 'llvm')}=packages/windows-containment/native`,
      '/clang:-ffile-prefix-map=<run>/llvm=packages/windows-containment/native',
    ],
    [path.join(RUN_ROOT, 'build-a', 'src', 'fixture.cc'), '<run>/build-a/src/fixture.cc'],
  ];
  const rendered = cases.map(([input, expected]) => {
    const actual = logicalizeNativeToolchainProbeReceiptValue(input, logicalize);
    assert.equal(actual, expected);
    return actual;
  });
  assert.doesNotThrow(() => assertReceiptPrivate(
    { argv: rendered },
    { actualRoots: [RUN_ROOT, visualStudioRoot] },
  ));
});

test('ASan negative terminal admission is one exact nonzero-exit-or-signal union', () => {
  for (const [exitCode, signal] of [
    [1, null],
    [-1, null],
    [0xc0000005, null],
    [null, 'SIGABRT'],
    [null, 'SIGSEGV'],
  ]) {
    assert.equal(isAdmittedAsanNegativeTerminal(exitCode, signal), true);
  }
  for (const [exitCode, signal] of [
    [0, null],
    [null, null],
    [undefined, null],
    [null, undefined],
    [1, 'SIGABRT'],
    [0, 'SIGABRT'],
    ['1', null],
    [Number.NaN, null],
    [Number.POSITIVE_INFINITY, null],
    [null, ''],
  ]) {
    assert.equal(isAdmittedAsanNegativeTerminal(exitCode, signal), false);
  }
});

test('profile owns no direct process primitive or kill fallback', async () => {
  const source = await readFile(new URL('../native-toolchain-probe-execution-profile.mjs', import.meta.url), 'utf8');
  assert.doesNotMatch(source, /(?:node:)?child_process/u);
  assert.doesNotMatch(source, /(?<![\w.])(?:exec|execFile|fork|spawn|spawnSync)\s*\(/u);
  assert.doesNotMatch(source, /\.kill\s*\(/u);
  assert.match(source, /runCommand\(plan,/u);
  assert.match(source, /commandReceipt\(plan, result,/u);
  assert.match(source, /verifyFile\(filePath, expected,/u);
});

test('factory requires the exact sealed authority, environment, and verified tool map', () => {
  const exact = fixture();
  const profile = createNativeToolchainProbeExecutionProfile(exact);
  assert.equal(Object.isFrozen(profile), true);
  assert.deepEqual(profile.receipts, []);
  assert.equal(Object.isFrozen(profile.receipts), true);
  assert.throws(
    () => createNativeToolchainProbeExecutionProfile(exact),
    /authority was already claimed/u,
  );

  const wrongAuthority = fixture();
  wrongAuthority.authority.privateSystemToolSurface.tuples[1][2] = 'f'.repeat(64);
  assert.throws(
    () => createNativeToolchainProbeExecutionProfile(wrongAuthority),
    /private system tool surface/u,
  );

  const wrongTools = fixture();
  wrongTools.tools.unsealed = 'C:\\unsealed\\tool.exe';
  assert.throws(
    () => createNativeToolchainProbeExecutionProfile(wrongTools),
    /verified tool map keys/u,
  );

  const missingResolver = fixture();
  delete missingResolver.resolveLogical;
  assert.throws(
    () => createNativeToolchainProbeExecutionProfile(missingResolver),
    /execution profile options keys/u,
  );

  const nonFunctionResolver = fixture();
  nonFunctionResolver.resolveLogical = 'not-a-function';
  assert.throws(
    () => createNativeToolchainProbeExecutionProfile(nonFunctionResolver),
    /configured native tool cl identity was malformed/u,
  );

  const driftedResolver = fixture();
  const sealedResolveLogical = driftedResolver.resolveLogical;
  driftedResolver.resolveLogical = (logicalPath) => (
    logicalPath === 'sealed-tools/cl.exe'
      ? 'C:\\different-sealed-tools\\cl.exe'
      : sealedResolveLogical(logicalPath)
  );
  assert.throws(
    () => createNativeToolchainProbeExecutionProfile(driftedResolver),
    /verified native tool cl did not equal its config-derived path/u,
  );

  const wrongEnvironment = fixture();
  wrongEnvironment.environment.CODEX_HOME = 'C:\\secret';
  assert.throws(
    () => createNativeToolchainProbeExecutionProfile(wrongEnvironment),
    /base environment keys/u,
  );
});

test('one profile serializes operations while its bounded command is in progress', async () => {
  const profile = createNativeToolchainProbeExecutionProfile(fixture());
  const first = profile.run(validFirstOperation());
  await assert.rejects(
    profile.run({
      args: [],
      cwd: path.join(RUN_ROOT, 'build-a'),
      label: EXPECTED_OPERATION_IDS[1],
      tool: 'cl',
    }),
    /execution profile was no longer active/u,
  );
  await assert.rejects(first, /private taskkill executable verification failed/u);
});

test('run fails before process access on operation, tool, cwd, and argument drift', async () => {
  await assert.rejects(
    createNativeToolchainProbeExecutionProfile(fixture()).run(validFirstOperation({ label: EXPECTED_OPERATION_IDS[1] })),
    /operation release-a-compile-input-digest-resource label changed/u,
  );
  await assert.rejects(
    createNativeToolchainProbeExecutionProfile(fixture()).run(validFirstOperation({ tool: 'cl' })),
    /operation release-a-compile-input-digest-resource tool changed/u,
  );
  await assert.rejects(
    createNativeToolchainProbeExecutionProfile(fixture()).run(validFirstOperation({ cwd: path.join(RUN_ROOT, 'build-a') })),
    /cwd changed from its exact run-owned directory/u,
  );
  await assert.rejects(
    createNativeToolchainProbeExecutionProfile(fixture()).run(validFirstOperation({ args: Array(513).fill('/nologo') })),
    /arguments exceeded the exact count bound/u,
  );
  await assert.rejects(
    createNativeToolchainProbeExecutionProfile(fixture()).run(validFirstOperation({ args: ['@unsealed.rsp'] })),
    /bounded literal argument/u,
  );
});

test('run rejects environment, timeout, output-bound, and option escape hatches', async () => {
  const poisonedEnvironment = { ...fixture().environment, OPENAI_API_KEY: 'secret' };
  await assert.rejects(
    createNativeToolchainProbeExecutionProfile(fixture()).run(validFirstOperation({ env: poisonedEnvironment })),
    /provider-free string map/u,
  );
  await assert.rejects(
    createNativeToolchainProbeExecutionProfile(fixture()).run(validFirstOperation({ timeoutMs: 1 })),
    /timeout changed from its exact bound/u,
  );
  await assert.rejects(
    createNativeToolchainProbeExecutionProfile(fixture()).run(validFirstOperation({ maxOutputBytes: 16 * 1024 * 1024 + 1 })),
    /output bound was invalid/u,
  );
  await assert.rejects(
    createNativeToolchainProbeExecutionProfile(fixture()).run({ ...validFirstOperation(), shell: true }),
    /undeclared override/u,
  );
});

test('finalize refuses any incomplete operation closure without touching authority', async () => {
  const input = fixture();
  let finalizeCalls = 0;
  input.authority.finalize = async () => {
    finalizeCalls += 1;
    return { outcome: 'finalized' };
  };
  const profile = createNativeToolchainProbeExecutionProfile(input);
  await assert.rejects(profile.finalize(), /exact 41-operation closure/u);
  assert.equal(finalizeCalls, 0);
});
