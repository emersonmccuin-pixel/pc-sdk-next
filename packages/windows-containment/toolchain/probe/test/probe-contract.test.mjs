import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  ProbeFailure,
  assertCorrectedLlvmFlags,
  assertGuardEhContinuationConsistency,
  assertLlvmCoverageShow,
  assertReleaseLinkIsolationPolicy,
  assertReleaseStaticRuntimeFlags,
  assertSectionPolicy,
  assertStaticCrtLinkTrace,
  assertSystemRootAuthority,
  buildRelease,
  canonicalJson,
  compareReleaseBuilds,
  expandTokens,
  llvmLinkArguments,
  parseLlvmBranchCoverageReport,
  parseArguments,
  validateProbeNodeEnvironment,
} from '../run-native-toolchain-probe.mjs';

test('expands every declared command token without shell interpolation', () => {
  assert.deepEqual(
    expandTokens(
      ['/pathmap:${BUILD_ROOT}=.', '/OUT:${OUTPUT_FILE}', 'literal'],
      { BUILD_ROOT: 'C:\\sealed build', OUTPUT_FILE: 'C:\\sealed build\\probe.exe' },
    ),
    ['/pathmap:C:\\sealed build=.', '/OUT:C:\\sealed build\\probe.exe', 'literal'],
  );
  assert.throws(
    () => expandTokens(['/OUT:${MISSING}'], {}),
    (error) => error instanceof ProbeFailure && error.code === 'RECIPE_TOKEN_UNRESOLVED',
  );
});

test('argument parsing rejects undeclared escape hatches', () => {
  assert.throws(
    () => parseArguments(['--skip-asan']),
    (error) => error instanceof ProbeFailure && error.code === 'ARGUMENT_UNSUPPORTED',
  );
  assert.throws(
    () => parseArguments(['--config', 'elsewhere.json']),
    (error) => error instanceof ProbeFailure && error.code === 'ARGUMENT_UNSUPPORTED',
  );
  assert.throws(
    () => parseArguments(['--run-root', 'C:\\redirected']),
    (error) => error instanceof ProbeFailure && error.code === 'ARGUMENT_UNSUPPORTED',
  );
});

test('runner rejects every nonempty NODE_* setting and returns receipt-bound empty proof', () => {
  assert.deepEqual(
    validateProbeNodeEnvironment({
      NODE_OPTIONS: '',
      NODE_PATH: undefined,
      PATH: 'C:\\Windows\\System32',
    }),
    { nodeEnvironmentEmpty: true },
  );
  for (const [name, value] of [
    ['NODE_OPTIONS', '--require=C:\\hostile.cjs'],
    ['node_path', 'C:\\hostile-modules'],
    ['Node_V8_Coverage', 'C:\\outside-authority'],
    ['NODE_COMPILE_CACHE', 'C:\\outside-authority'],
    ['NODE_EXTRA_CA_CERTS', 'C:\\host-certificate.pem'],
    ['NODE_REDIRECT_WARNINGS', 'C:\\outside-authority\\warnings.log'],
    ['NODE_NO_WARNINGS', '0'],
  ]) {
    assert.throws(
      () => validateProbeNodeEnvironment({ [name]: value }),
      (error) => (
        error instanceof ProbeFailure
        && error.code === 'RUNNER_NODE_ENVIRONMENT_FORBIDDEN'
      ),
      name,
    );
  }
});

test('runner has no private process primitive and replays inputs before finalization', async () => {
  const source = await readFile(new URL('../run-native-toolchain-probe.mjs', import.meta.url), 'utf8');
  assert.doesNotMatch(source, /node:child_process|\bspawn\s*\(|\.kill\s*\(|\bexec(?:File)?\s*\(/u);
  const buildIndex = source.indexOf('const llvm = await runLlvmProbe');
  const replayIndex = source.indexOf('await replayNativeBuildInputsWithinAuthority');
  const finalizeIndex = source.indexOf('await executionProfile.finalize()');
  assert.ok(buildIndex >= 0 && replayIndex > buildIndex && finalizeIndex > replayIndex);
  assert.match(source, /assertReceiptPrivate\(receipt/u);
  assert.match(source, /authorityFinalization\.commandCount === 10/u);
});

test('system-root authority is exact', () => {
  assert.equal(assertSystemRootAuthority('C:\\Windows', 'c:\\WINDOWS'), 'C:\\Windows');
  assert.throws(
    () => assertSystemRootAuthority('D:\\redirected', 'D:\\redirected'),
    (error) => error instanceof ProbeFailure && error.code === 'SYSTEM_ROOT_AUTHORITY_MISMATCH',
  );
});

test('LLVM link projection preserves driver flags before the /link separator', () => {
  assert.deepEqual(
    llvmLinkArguments(
      {
        id: 'fixture',
        linkDriverFlags: ['-fuse-ld=lld', '-fsanitize=fuzzer,address'],
        linkDriverSeparator: '/link',
        linkFlags: ['/OUT:${OUTPUT}', '/WX'],
      },
      ['/vctoolsdir', 'C:\\sealed-msvc'],
      'fixture.obj',
      'fixture.exe',
      { OUTPUT: 'fixture.exe' },
    ),
    [
      '/vctoolsdir',
      'C:\\sealed-msvc',
      '-fuse-ld=lld',
      '-fsanitize=fuzzer,address',
      'fixture.obj',
      '/Fefixture.exe',
      '/link',
      '/OUT:fixture.exe',
      '/WX',
    ],
  );
});

test('LLVM branch coverage parser requires an exact nonempty 100.00% source row', () => {
  const header = 'Filename Regions Missed Regions Cover Functions Missed Functions Executed Lines Missed Lines Cover Branches Missed Branches Cover';
  const canonicalSource = 'packages/windows-containment/native/src/llvm-coverage.cc';
  assert.deepEqual(
    parseLlvmBranchCoverageReport(
      `${header}\npackages\\windows-containment\\native\\src\\llvm-coverage.cc 8 0 100.00% 2 0 100.00% 12 0 100.00% 4 0 100.00%\n`,
      canonicalSource,
    ),
    { branches: 4, coverage: '100.00%', missed: 0 },
  );
  assert.throws(
    () => parseLlvmBranchCoverageReport(
      `${header}\n${canonicalSource} 8 0 100.00% 2 0 100.00% 12 0 100.00% 4 1 75.00%\n`,
      canonicalSource,
    ),
    (error) => error instanceof ProbeFailure && error.code === 'LLVM_COVERAGE_BRANCH_THRESHOLD_FAILED',
  );
  for (const wrongSource of [
    'llvm-coverage.cc',
    `packages/windows-containment/native/${canonicalSource}`,
  ]) {
    assert.throws(
      () => parseLlvmBranchCoverageReport(
        `${header}\n${wrongSource} 8 0 100.00% 2 0 100.00% 12 0 100.00% 4 0 100.00%\n`,
        canonicalSource,
      ),
      (error) => error instanceof ProbeFailure && error.code === 'LLVM_COVERAGE_REPORT_MISSING_SOURCE',
      wrongSource,
    );
  }
});

test('LLVM coverage path policy prevents duplicated canonical source prefixes', async () => {
  const config = JSON.parse(await readFile(
    new URL('../../native-build-input.config.json', import.meta.url),
    'utf8',
  ));
  const coverageRecipe = config.root.buildRecipes.find(
    (recipe) => recipe.id === 'llvm-19.1.7-coverage-replay',
  );
  assert.doesNotThrow(() => assertCorrectedLlvmFlags(coverageRecipe));
  for (const coverageDirectory of [
    '/clang:-fcoverage-compilation-dir=packages/windows-containment/native',
    '/clang:-fcoverage-compilation-dir=C:\\ambient',
  ]) {
    const hostile = structuredClone(coverageRecipe);
    hostile.compileFlags = hostile.compileFlags
      .filter((flag) => !flag.startsWith('/clang:-fcoverage-compilation-dir='));
    hostile.compileFlags.push(coverageDirectory);
    assert.throws(
      () => assertCorrectedLlvmFlags(hostile),
      (error) => (
        error instanceof ProbeFailure
        && error.code === 'LLVM_COVERAGE_COMPILATION_DIR_MISMATCH'
      ),
      coverageDirectory,
    );
  }
  for (const alias of [
    '/clang:-ffile-compilation-dir=C:\\ambient',
    '/clang:-fcoverage-prefix-map=${SOURCE_ROOT}=ambient',
    '-ffile-compilation-dir=C:\\ambient',
    '-fcoverage-compilation-dir=C:\\ambient',
    '-fcoverage-prefix-map=${SOURCE_ROOT}=ambient',
  ]) {
    const hostile = structuredClone(coverageRecipe);
    hostile.compileFlags.push(alias);
    assert.throws(
      () => assertCorrectedLlvmFlags(hostile),
      (error) => (
        error instanceof ProbeFailure
        && error.code === 'LLVM_COVERAGE_PATH_ALIAS_FORBIDDEN'
      ),
      alias,
    );
  }
  const unknownAlias = structuredClone(coverageRecipe);
  unknownAlias.compileFlags.push('/clang:-future-coverage-path-alias=ambient');
  assert.throws(
    () => assertCorrectedLlvmFlags(unknownAlias),
    (error) => error instanceof ProbeFailure && error.code === 'LLVM_COMPILE_FLAGS_MISMATCH',
  );
});

test('LLVM coverage show accepts source annotations without a filename header and rejects diagnostics', () => {
  const annotations = [
    '    6|      3|  if (value > 0) {',
    '  |  Branch (6:7): [True: 1, False: 2]',
    '   20|      3|  volatile int observed = classify(argument_count - 2);',
  ].join('\n');
  assert.doesNotThrow(() => assertLlvmCoverageShow({ stderrText: '', stdoutText: annotations }));
  assert.throws(
    () => assertLlvmCoverageShow({
      stderrText: 'error: mapped source: no such file or directory',
      stdoutText: annotations,
    }),
    (error) => error instanceof ProbeFailure && error.code === 'LLVM_COVERAGE_SHOW_DIAGNOSTIC',
  );
  assert.throws(
    () => assertLlvmCoverageShow({
      stderrText: '',
      stdoutText: 'classify(argument_count - 2) rendered without branches',
    }),
    (error) => (
      error instanceof ProbeFailure
      && error.code === 'LLVM_COVERAGE_SHOW_BRANCH_COUNTS_MISSING'
    ),
  );
  assert.throws(
    () => assertLlvmCoverageShow({
      stderrText: '',
      stdoutText: 'Branch (6:7): [True: 1, False: 2] from another source',
    }),
    (error) => (
      error instanceof ProbeFailure
      && error.code === 'LLVM_COVERAGE_SHOW_FIXTURE_CANARY_MISSING'
    ),
  );
});

test('release link isolation rejects /ALLOWISOLATION on every DLL recipe', async () => {
  const config = JSON.parse(await readFile(
    new URL('../../native-build-input.config.json', import.meta.url),
    'utf8',
  ));
  assert.doesNotThrow(() => assertReleaseLinkIsolationPolicy(config));
  for (const id of ['msvc-release-addon', 'node-gyp-release-sqlite']) {
    const hostile = structuredClone(config);
    hostile.root.buildRecipes.find((recipe) => recipe.id === id).linkFlags.push('/ALLOWISOLATION');
    assert.throws(
      () => assertReleaseLinkIsolationPolicy(hostile),
      (error) => error instanceof ProbeFailure && error.code === 'DLL_ALLOWISOLATION_FORBIDDEN',
      id,
    );
  }
});

test('release runtime policy and linker trace prove the retail static CRT', () => {
  assert.doesNotThrow(() => assertReleaseStaticRuntimeFlags(['/nologo', '/GL', '/MT'], 'fixture'));
  for (const flags of [
    ['/GL'],
    ['/GL', '/MD'],
    ['/GL', '/MT', '/MD'],
    ['/GL', '/MTd'],
    ['/GL', '/MT', '/Zl'],
    ['/GL', '/MT', '/LD'],
  ]) {
    assert.throws(() => assertReleaseStaticRuntimeFlags(flags, 'fixture'), ProbeFailure);
  }
  const staticTrace = [
    'Searching C:\\sealed\\LIBCMT.lib:',
    'Searching C:\\sealed\\libvcruntime.lib:',
    'Searching C:\\sealed\\libucrt.lib:',
  ].join('\n');
  assert.deepEqual(
    assertStaticCrtLinkTrace(staticTrace, 'fixture')
      .filter((library) => ['libcmt.lib', 'libvcruntime.lib', 'libucrt.lib'].includes(library)),
    ['libcmt.lib', 'libucrt.lib', 'libvcruntime.lib'],
  );
  assert.throws(
    () => assertStaticCrtLinkTrace(`${staticTrace}\nSearching C:\\sealed\\MSVCRT.lib:`, 'fixture'),
    (error) => error instanceof ProbeFailure && error.code === 'DYNAMIC_OR_DEBUG_CRT_LINK_TRACE',
  );
  assert.throws(
    () => assertStaticCrtLinkTrace('Searching C:\\sealed\\LIBCMT.lib:', 'fixture'),
    (error) => error instanceof ProbeFailure && error.code === 'STATIC_CRT_LINK_TRACE_MISSING',
  );
});

test('release build routes only the two link operations through static CRT trace validation', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'pc-cx004-release-build-'));
  const buildRoot = path.join(directory, 'build-root');
  await mkdir(buildRoot);
  const config = JSON.parse(await readFile(
    new URL('../../native-build-input.config.json', import.meta.url),
    'utf8',
  ));
  const labels = [];
  const staticTrace = Buffer.from([
    'Searching C:\\sealed\\LIBCMT.lib:',
    'Searching C:\\sealed\\libvcruntime.lib:',
    'Searching C:\\sealed\\libucrt.lib:',
    '',
  ].join('\n'));
  const executionProfile = {
    async run(options) {
      labels.push(options.label);
      if (options.label.endsWith('-compile-input-digest-resource')) {
        const outputIndex = options.args.indexOf('/fo') + 1;
        await writeFile(options.args[outputIndex], 'diagnostic resource');
      }
      return {
        exitCode: 0,
        signal: null,
        stderr: Buffer.alloc(0),
        stdout: options.tool === 'link' ? staticTrace : Buffer.alloc(0),
      };
    },
  };
  try {
    const build = await buildRelease({
      config,
      executionProfile,
      inputManifest: { rootSha256: 'a'.repeat(64) },
      nodeIncludePath: 'C:\\sealed-node-sdk\\include\\node',
      nodeLibraryPath: 'C:\\sealed-node-sdk\\Release\\node.lib',
      redact: (value) => value,
      toolIdentities: { rc: { logicalPath: 'sdk/bin/10.0.22621.0/x64/rc.exe' } },
    }, buildRoot, 'release-test');
    assert.equal(path.basename(build.bootstrap), 'pc-sdk-next-bootstrap-probe.exe');
    assert.deepEqual(labels, [
      'release-test-compile-input-digest-resource',
      'release-test-compile-core',
      'release-test-archive-core',
      'release-test-compile-bootstrap',
      'release-test-link-bootstrap',
      'release-test-compile-addon',
      'release-test-link-addon',
      'release-test-compile-sqlite-c-flags',
    ]);
  } finally {
    await rm(directory, { force: true, recursive: true });
  }
});

test('Guard EH continuation evidence admits absence but rejects partial state', () => {
  assert.doesNotThrow(() => assertGuardEhContinuationConsistency({
    guardEhContinuationCount: '0x0',
    guardEhContinuationTable: '0x0',
  }, 'fixture'));
  assert.doesNotThrow(() => assertGuardEhContinuationConsistency({
    guardEhContinuationCount: '0x2',
    guardEhContinuationTable: '0x140001000',
  }, 'fixture'));
  assert.throws(
    () => assertGuardEhContinuationConsistency({
      guardEhContinuationCount: '0x0',
      guardEhContinuationTable: '0x140001000',
    }, 'fixture'),
    (error) => error instanceof ProbeFailure && error.code === 'PE_EH_CONTINUATION_STATE_INCONSISTENT',
  );
});

test('distinct-root reproducibility is exact for admitted outputs and observational for LTCG intermediates', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'pc-cx004-release-repro-'));
  const finalKeys = ['bootstrap', 'addon', 'inputManifestDigest', 'inputManifestRc', 'inputManifestResource'];
  const intermediateKeys = ['coreObject', 'coreLibrary', 'bootstrapObject', 'addonObject', 'sqliteCObject'];
  const first = {};
  const second = {};
  try {
    for (const key of [...finalKeys, ...intermediateKeys]) {
      first[key] = path.join(directory, `first-${key}`);
      second[key] = path.join(directory, `second-${key}`);
      await writeFile(first[key], key);
      await writeFile(second[key], finalKeys.includes(key) ? key : `${key}-root-two`);
    }
    const result = await compareReleaseBuilds(first, second);
    assert.deepEqual(Object.keys(result.reproducibleOutputs).sort(), [...finalKeys].sort());
    assert.equal(result.pathBoundLtcgIntermediates.coreObject.byteIdentical, false);
    await writeFile(second.addon, 'changed-addon');
    await assert.rejects(
      compareReleaseBuilds(first, second),
      (error) => error instanceof ProbeFailure && error.code === 'REPRODUCIBILITY_MISMATCH',
    );
  } finally {
    await rm(directory, { force: true, recursive: true });
  }
});

test('release section policy rejects shared, wrong-class, and nondiscardable relocation sections', () => {
  const section = (name, characteristics, readable, writable, executable) => ({
    characteristics,
    executable,
    name,
    readable,
    writable,
  });
  assert.doesNotThrow(() => assertSectionPolicy([
    section('.text', 0x60000020, true, false, true),
    section('.reloc', 0x42000040, true, false, false),
  ], ['.text', '.reloc'], 'fixture'));
  assert.throws(() => assertSectionPolicy([
    section('.text', 0xf0000020, true, true, true),
  ], ['.text'], 'fixture'), /shared section|R\/W\/X class/u);
  assert.throws(() => assertSectionPolicy([
    section('.reloc', 0x40000040, true, false, false),
  ], ['.reloc'], 'fixture'), /not discardable/u);
});

test('receipt JSON is recursively key-sorted and newline-free', () => {
  assert.equal(canonicalJson({ z: 1, a: { y: 2, b: 3 } }), '{"a":{"b":3,"y":2},"z":1}');
  assert.equal(canonicalJson({ value: 'line' }).includes('\n'), false);
});
