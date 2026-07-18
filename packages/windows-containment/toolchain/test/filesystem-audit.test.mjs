import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import {
  link,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  symlink,
  writeFile,
} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';

import {
  AUDIT_PLAN_SCHEMA,
  parseAuditArguments,
  replayNativeBuildInputsWithinAuthority,
  runFilesystemAuditPlan,
} from '../audit-native-build-input.mjs';
import {
  canonicalJsonBytes,
  generateManifestSetFromConfig,
  HOST_TOOLCHAIN_METADATA_FILE_PREFIX,
  loadManifestConfig,
  writeManifestSet,
} from '../manifest-set.mjs';

const TOOLCHAIN_DIRECTORY = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const WINDOWS_ONLY = { skip: process.platform !== 'win32' };

function sha256(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}

function sourcePlan(rootPath, { files = [], mode = 'tree' } = {}) {
  return {
    schemaVersion: AUDIT_PLAN_SCHEMA,
    sources: [{
      files,
      logicalPrefix: 'fixture',
      mode,
      rootPath,
      sourceId: 'source-000',
      sourceIndex: 0,
      surfaceId: 'fixture',
    }],
  };
}

async function withTemporaryDirectory(prefix, action) {
  const directory = await mkdtemp(path.join(os.tmpdir(), prefix));
  try {
    return await action(directory);
  } finally {
    await rm(directory, { force: true, recursive: true });
  }
}

test('audit CLI parser rejects all filesystem authority overrides', () => {
  assert.deepEqual(parseAuditArguments([]), {});
  assert.deepEqual(parseAuditArguments(['--help']), { help: true });
  assert.throws(() => parseAuditArguments(['--config', 'config.json']), /unsupported argument/u);
  assert.throws(() => parseAuditArguments(['--location', 'cache=C:/one']), /unsupported argument/u);
  assert.throws(() => parseAuditArguments(['--output-dir', 'C:/elsewhere']), /unsupported argument/u);
  assert.throws(() => parseAuditArguments(['--unknown']), /unsupported argument/u);
});

test('audit lane has no network/provider launch surface and fixes PowerShell down', async () => {
  const nodeSource = await readFile(
    path.join(TOOLCHAIN_DIRECTORY, 'audit-native-build-input.mjs'),
    'utf8',
  );
  const workerSource = await readFile(
    path.join(TOOLCHAIN_DIRECTORY, 'native-build-input-filesystem-audit.ps1'),
    'utf8',
  );
  const coreSource = await readFile(
    path.join(TOOLCHAIN_DIRECTORY, 'preseal', 'filesystem-audit-core.psm1'),
    'utf8',
  );
  const authoritySource = await readFile(
    path.join(TOOLCHAIN_DIRECTORY, 'preseal', 'system-tool-authority.mjs'),
    'utf8',
  );
  assert.doesNotMatch(
    nodeSource,
    /node:(?:cluster|dgram|dns|http|https|net|tls|worker_threads)/u,
  );
  assert.doesNotMatch(
    workerSource,
    /(?:Invoke-WebRequest|Invoke-RestMethod|Start-Process|System\.Net|WebClient|HttpClient)/iu,
  );
  assert.doesNotMatch(
    authoritySource,
    /node:(?:cluster|dgram|dns|http|https|net|tls|worker_threads)/u,
  );
  assert.match(authoritySource, /WindowsPowerShell[\s\S]*powershell\.exe/u);
  assert.match(authoritySource, /["']-NoProfile["']/u);
  assert.match(authoritySource, /["']-EncodedCommand["']/u);
  assert.match(authoritySource, /shell: false/u);
  assert.doesNotMatch(coreSource, /Add-Type|CodeDom|csc\.exe/iu);
  assert.match(coreSource, /Reflection\.Emit\.AssemblyBuilderAccess\]::Run/u);
  assert.match(coreSource, /DllImportAttribute/u);
  assert.match(
    coreSource,
    /CreateFileW\([\s\S]*?\[uint32\] 2147483776,[\s\S]*?\[uint32\] 0x00000001,[\s\S]*?\[uint32\] 0x08200000/u,
  );
  assert.match(coreSource, /information\.linkCount -ne \$ExpectedLinkCount/u);
  assert.match(coreSource, /GetFinalPathNameByHandleW/u);
  assert.match(coreSource, /for \(\$pass = 0; \$pass -lt 2; \$pass \+= 1\)/u);
  assert.match(coreSource, /FindFirstStreamW/u);
  assert.match(coreSource, /name -cne '::\$DATA'/u);
  assert.match(workerSource, /\[Parameter\(Mandatory\)\] \[string\] \$AuditPlanText/u);
  assert.doesNotMatch(workerSource, /Import-Module|Console\]::In/u);
});

test('audit CLI owns authority lifecycle while the capture-safe inner audit does not', async () => {
  const nodeSource = await readFile(
    path.join(TOOLCHAIN_DIRECTORY, 'audit-native-build-input.mjs'),
    'utf8',
  );
  const innerStart = nodeSource.indexOf(
    'export async function auditNativeBuildInputsWithinAuthority',
  );
  const wrapperStart = nodeSource.indexOf(
    'export async function auditNativeBuildInputs(options',
  );
  const parserStart = nodeSource.indexOf('export function parseAuditArguments');
  assert.ok(innerStart >= 0 && wrapperStart > innerStart && parserStart > wrapperStart);

  const innerSource = nodeSource.slice(innerStart, wrapperStart);
  assert.match(innerSource, /authority\.runAuditPlan/u);
  assert.doesNotMatch(
    innerSource,
    /prepareFilesystemAuditAuthority|authority\.finalize|authority\.teardown|executionAuthority/u,
  );

  const wrapperSource = nodeSource.slice(wrapperStart, parserStart);
  const prepareIndex = wrapperSource.indexOf('prepareFilesystemAuditAuthority()');
  const innerIndex = wrapperSource.indexOf('auditNativeBuildInputsWithinAuthority(authority, options)');
  const finalizeIndex = wrapperSource.indexOf('authority.finalize()');
  const attachIndex = wrapperSource.indexOf('{ ...receipt, executionAuthority }');
  const teardownIndex = wrapperSource.indexOf('authority.teardown()');
  assert.ok(
    prepareIndex >= 0 &&
    innerIndex > prepareIndex &&
    finalizeIndex > innerIndex &&
    attachIndex > finalizeIndex &&
    teardownIndex > attachIndex,
  );
});

test('post-use replay rejects a persistent input change before authority finalization', async () => {
  const configPath = path.join(TOOLCHAIN_DIRECTORY, 'native-build-input.config.json');
  const configBytes = await readFile(configPath);
  const configReceipt = {
    fileCount: 1,
    ok: true,
    schemaVersion: 'pc-sdk.cx-004.native-build-input-filesystem-audit-receipt.v1',
    sources: [{
      files: [['audit-config/native-build-input.config.json', configBytes.length, sha256(configBytes)]],
      sourceId: 'audit-config',
      sourceIndex: 0,
      surfaceId: 'audit-config',
    }],
  };
  const initialInputs = { fileCount: 1, sources: [{ files: [['fixture/a', 1, 'a'.repeat(64)]] }] };
  const changedInputs = { fileCount: 1, sources: [{ files: [['fixture/a', 1, 'b'.repeat(64)]] }] };
  const observedPlans = [];
  const authority = {
    configContext: await loadManifestConfig(configPath),
    async runAuditPlan(plan) {
      observedPlans.push(plan);
      return observedPlans.length === 1 ? configReceipt : changedInputs;
    },
  };
  await assert.rejects(
    replayNativeBuildInputsWithinAuthority(authority, {
      config: configReceipt,
      inputs: initialInputs,
    }),
    /surface changed between admission and completed use/u,
  );
  assert.equal(observedPlans.length, 2);
});

test('Windows worker returns stable logical tuples for tree and files sources', WINDOWS_ONLY, async () => {
  await withTemporaryDirectory('cx004-filesystem-audit-good-', async (directory) => {
    await mkdir(path.join(directory, 'nested'));
    await writeFile(path.join(directory, 'alpha.txt'), 'alpha', 'utf8');
    await writeFile(path.join(directory, 'empty.bin'), Buffer.alloc(0));
    await writeFile(path.join(directory, 'nested', 'beta.bin'), Buffer.from([0, 1, 2, 3]));
    const treeReceipt = await runFilesystemAuditPlan(sourcePlan(directory), {
      timeoutMs: 120_000,
    });
    assert.deepEqual(treeReceipt.sources[0].files, [
      ['fixture/alpha.txt', 5, sha256(Buffer.from('alpha'))],
      ['fixture/empty.bin', 0, sha256(Buffer.alloc(0))],
      ['fixture/nested/beta.bin', 4, sha256(Buffer.from([0, 1, 2, 3]))],
    ]);

    const filesReceipt = await runFilesystemAuditPlan(
      sourcePlan(directory, { files: ['nested/beta.bin'], mode: 'files' }),
      { timeoutMs: 120_000 },
    );
    assert.deepEqual(filesReceipt.sources[0].files, [
      ['fixture/nested/beta.bin', 4, sha256(Buffer.from([0, 1, 2, 3]))],
    ]);

    const emptyTreeRoot = path.join(directory, 'empty-tree');
    await mkdir(emptyTreeRoot);
    const emptyTreeReceipt = await runFilesystemAuditPlan(
      sourcePlan(emptyTreeRoot, { mode: 'empty-tree' }),
      { timeoutMs: 120_000 },
    );
    assert.deepEqual(emptyTreeReceipt.sources[0].files, []);

    const singleTreeRoot = path.join(directory, 'single-tree');
    await mkdir(singleTreeRoot);
    await writeFile(path.join(singleTreeRoot, 'only.bin'), 'only', 'utf8');
    const singleTreeReceipt = await runFilesystemAuditPlan(sourcePlan(singleTreeRoot), {
      timeoutMs: 120_000,
    });
    assert.deepEqual(singleTreeReceipt.sources[0].files, [
      ['fixture/only.bin', 4, sha256(Buffer.from('only'))],
    ]);
  });
});

test('Windows worker rejects real hardlink, ADS, and junction fixtures', WINDOWS_ONLY, async () => {
  await withTemporaryDirectory('cx004-filesystem-audit-hostile-', async (directory) => {
    const providerNamedRoot = path.join(directory, '.codex', 'sealed-inputs');
    await mkdir(providerNamedRoot, { recursive: true });
    await writeFile(path.join(providerNamedRoot, 'forbidden.bin'), 'forbidden', 'utf8');
    await assert.rejects(
      runFilesystemAuditPlan(sourcePlan(providerNamedRoot), { timeoutMs: 120_000 }),
      /provider-home-path/u,
    );
    const customProviderRoot = path.join(directory, 'custom-provider-home');
    await mkdir(customProviderRoot);
    await writeFile(path.join(customProviderRoot, 'forbidden.bin'), 'forbidden', 'utf8');
    const previousProviderHome = process.env.CODEX_HOME;
    try {
      process.env.CODEX_HOME = customProviderRoot;
      await assert.rejects(
        runFilesystemAuditPlan(
          sourcePlan(customProviderRoot),
          { timeoutMs: 120_000 },
        ),
        /(?:provider-home-path|forbidden provider home)/u,
      );
    } finally {
      if (previousProviderHome === undefined) {
        delete process.env.CODEX_HOME;
      } else {
        process.env.CODEX_HOME = previousProviderHome;
      }
    }
    await assert.rejects(
      runFilesystemAuditPlan(sourcePlan('\\\\server\\share'), { timeoutMs: 120_000 }),
      /local Windows drive/u,
    );

    const hardlinkRoot = path.join(directory, 'hardlink');
    await mkdir(hardlinkRoot);
    await writeFile(path.join(hardlinkRoot, 'first.bin'), 'hardlink', 'utf8');
    await link(
      path.join(hardlinkRoot, 'first.bin'),
      path.join(hardlinkRoot, 'second.bin'),
    );
    await assert.rejects(
      runFilesystemAuditPlan(sourcePlan(hardlinkRoot), { timeoutMs: 120_000 }),
      /file-identity-unproven/u,
    );
    const caseFoldAliasPlan = sourcePlan(hardlinkRoot, {
      files: ['FIRST.BIN', 'first.bin'],
      mode: 'files',
    });
    caseFoldAliasPlan.sources[0].surfaceId = 'git-execution-closure';
    caseFoldAliasPlan.sources[0].identityPolicy = {
      kind: 'git-for-windows-runtime-hardlink-v1',
      linkCount: 2,
      relativePaths: ['FIRST.BIN', 'first.bin'],
    };
    await assert.rejects(
      runFilesystemAuditPlan(caseFoldAliasPlan, { timeoutMs: 120_000 }),
      /ordinal case-insensitive unique paths/u,
    );

    const adsRoot = path.join(directory, 'ads');
    await mkdir(adsRoot);
    await writeFile(path.join(adsRoot, 'visible.bin'), 'visible', 'utf8');
    await writeFile(path.join(adsRoot, 'visible.bin:hidden'), 'hidden', 'utf8');
    await assert.rejects(
      runFilesystemAuditPlan(
        sourcePlan(adsRoot, { files: ['visible.bin'], mode: 'files' }),
        { timeoutMs: 120_000 },
      ),
      /unexpected-alternate-stream/u,
    );

    const directoryAdsRoot = path.join(directory, 'directory-ads');
    await mkdir(directoryAdsRoot);
    await writeFile(path.join(directoryAdsRoot, 'visible.bin'), 'visible', 'utf8');
    await writeFile(`${directoryAdsRoot}:hidden`, 'hidden', 'utf8');
    await assert.rejects(
      runFilesystemAuditPlan(sourcePlan(directoryAdsRoot), { timeoutMs: 120_000 }),
      /unexpected-alternate-stream/u,
    );

    const junctionTarget = path.join(directory, 'junction-target');
    const junctionRoot = path.join(directory, 'junction-root');
    await mkdir(junctionTarget);
    await mkdir(junctionRoot);
    await writeFile(path.join(junctionTarget, 'escaped.bin'), 'escaped', 'utf8');
    await symlink(junctionTarget, path.join(junctionRoot, 'redirect'), 'junction');
    await assert.rejects(
      runFilesystemAuditPlan(sourcePlan(junctionRoot), { timeoutMs: 120_000 }),
      /reparse-path/u,
    );
    await assert.rejects(
      runFilesystemAuditPlan(
        sourcePlan(path.join(junctionRoot, 'redirect')),
        { timeoutMs: 120_000 },
      ),
      /reparse-path/u,
    );
  });
});

test('worker receipts bind fixture tuples to generated root and shards', WINDOWS_ONLY, async () => {
  await withTemporaryDirectory('cx004-filesystem-audit-manifest-', async (directory) => {
    const inputDirectory = path.join(directory, 'inputs');
    const nestedDirectory = path.join(inputDirectory, 'nested');
    await mkdir(nestedDirectory, { recursive: true });
    const alpha = Buffer.from('alpha', 'utf8');
    const beta = Buffer.from([9, 8, 7]);
    await writeFile(path.join(inputDirectory, 'alpha.txt'), alpha);
    await writeFile(path.join(nestedDirectory, 'beta.bin'), beta);

    const alphaTuple = ['fixture/files/alpha.txt', alpha.length, sha256(alpha)];
    const betaTuple = ['fixture/tree/beta.bin', beta.length, sha256(beta)];
    const summarize = (tuples) => ({
      byteLength: tuples.reduce((total, tuple) => total + tuple[1], 0),
      fileCount: tuples.length,
      surfaceSha256: sha256(canonicalJsonBytes(tuples)),
    });
    const fixtureConfig = {
      manifestSetId: 'cx004-filesystem-audit-fixture-v1',
      locations: { fixture: 'inputs' },
      output: {
        directory: 'manifests',
        rootFileName: 'CX-004-native-build-input.json',
      },
      privacy: { forbiddenSubstrings: [] },
      root: {
        artifactPolicies: [],
        buildRecipes: [],
        hostToolchain: {},
        observations: [],
        officialInputs: [],
        packageResolution: {},
        provenance: {},
        runnerIdentity: {},
        scope: {},
      },
      schemaVersion: 'pc-sdk.cx-004.native-build-input-config.v1',
      surfaces: [
        {
          expected: summarize([alphaTuple]),
          sources: [{
            files: ['alpha.txt'],
            location: 'fixture',
            logicalPrefix: 'fixture/files',
            mode: 'files',
            relativeRoot: '',
          }],
          surfaceId: 'fixture-files',
        },
        {
          expected: summarize([betaTuple]),
          sources: [{
            location: 'fixture',
            logicalPrefix: 'fixture/tree',
            mode: 'tree',
            relativeRoot: 'nested',
          }],
          surfaceId: 'fixture-tree',
        },
      ],
    };
    const configPath = path.join(directory, 'fixture.config.json');
    await writeFile(configPath, JSON.stringify(fixtureConfig), 'utf8');
    const generated = await generateManifestSetFromConfig(configPath);
    await writeManifestSet(generated.manifestSet, generated.outputDirectory, {
      forbiddenSubstrings: generated.forbiddenSubstrings,
    });

    const inputReceipt = await runFilesystemAuditPlan({
      schemaVersion: AUDIT_PLAN_SCHEMA,
      sources: [
        {
          files: ['alpha.txt'],
          logicalPrefix: 'fixture/files',
          mode: 'files',
          rootPath: inputDirectory,
          sourceId: 'fixture-files',
          sourceIndex: 0,
          surfaceId: 'fixture-files',
        },
        {
          files: [],
          logicalPrefix: 'fixture/tree',
          mode: 'tree',
          rootPath: nestedDirectory,
          sourceId: 'fixture-tree',
          sourceIndex: 1,
          surfaceId: 'fixture-tree',
        },
      ],
    }, { timeoutMs: 120_000 });
    assert.deepEqual(inputReceipt.sources[0].files, [alphaTuple]);
    assert.deepEqual(inputReceipt.sources[1].files, [betaTuple]);

    const manifestReceipt = await runFilesystemAuditPlan(
      sourcePlan(generated.outputDirectory),
      { timeoutMs: 120_000 },
    );
    const expectedManifestTuples = [...generated.manifestSet.files.entries()]
      .map(([name, bytes]) => [`fixture/${name}`, bytes.length, sha256(bytes)])
      .sort((left, right) => left[0] < right[0] ? -1 : left[0] > right[0] ? 1 : 0);
    assert.deepEqual(manifestReceipt.sources[0].files, expectedManifestTuples);
    assert.equal(
      manifestReceipt.sources[0].files.filter(
        ([logicalPath]) => path.basename(logicalPath).startsWith(
          HOST_TOOLCHAIN_METADATA_FILE_PREFIX,
        ),
      ).length,
      1,
    );

    const extraLink = path.join(directory, 'root-manifest-hardlink.json');
    await link(
      path.join(generated.outputDirectory, 'CX-004-native-build-input.json'),
      extraLink,
    );
    await assert.rejects(
      runFilesystemAuditPlan(sourcePlan(generated.outputDirectory), { timeoutMs: 120_000 }),
      /file-identity-unproven/u,
    );
  });
});
