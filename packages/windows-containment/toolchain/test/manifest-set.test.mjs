import assert from 'node:assert/strict';
import {
  link,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  symlink,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

import {
  buildManifestSet,
  canonicalJsonBytes,
  decodeCanonicalJsonBytes,
  generateManifestSetFromConfig,
  HOST_TOOLCHAIN_METADATA_FILE_PREFIX,
  loadManifestConfig,
  MAX_FILES_PER_SHARD,
  MAX_MANIFEST_BYTES,
  MAX_MANIFEST_MEMBERS,
  MAX_PRESEAL_PAYLOAD_BYTES,
  PRESEAL_BINDING_POLICY,
  PRESEAL_PAYLOAD_SCHEMA_VERSION,
  PRESEAL_ROOT_SCHEMA_VERSION,
  presealConfigAuthorityIdentity,
  ROOT_FILE_NAME,
  ROOT_SCHEMA_VERSION,
  sha256Bytes,
  SHARD_FILE_PREFIX,
  validatePresealV2Envelope,
  validatePresealRepositoryEvidence,
  verifyManifestSet,
  writeManifestSet,
} from '../manifest-set.mjs';
import {
  countPresealPayloadMembers,
  MAX_PRESEAL_PAYLOAD_MEMBERS,
} from '../preseal-config-projection.mjs';

function rootMetadata(overrides = {}) {
  return {
    artifactPolicies: [],
    buildRecipes: [],
    hostToolchain: {},
    observations: [],
    officialInputs: [],
    packageResolution: {},
    provenance: {},
    runnerIdentity: {},
    scope: { slice: 'CX-004' },
    ...overrides,
  };
}

function tuple(relativePath, contents = relativePath) {
  const bytes = Buffer.from(contents, 'utf8');
  return [relativePath, bytes.length, sha256Bytes(bytes)];
}

function surface(surfaceId, files) {
  return { files, surfaceId };
}

async function writeReboundHostToolchainMetadata(directory, root, manifest) {
  const bytes = canonicalJsonBytes(manifest);
  const sha256 = sha256Bytes(bytes);
  const fileName = `${HOST_TOOLCHAIN_METADATA_FILE_PREFIX}${sha256}.json`;
  root.hostToolchain = {
    ...root.hostToolchain,
    byteLength: bytes.length,
    fileName,
    sha256,
  };
  await writeFile(path.join(directory, fileName), bytes);
  await writeFile(path.join(directory, ROOT_FILE_NAME), canonicalJsonBytes(root));
  return { bytes, fileName };
}

const PRESEAL_SIGNATURE_FAMILIES = [
  'node-gpg',
  'llvm-gpg',
  'python-gpg',
  'pnpm-ecdsa',
  'node-authenticode',
  'python-authenticode',
  'powershell-authenticode',
  'taskkill-authenticode',
];
const PRODUCTION_CONFIG_PATH = fileURLToPath(
  new URL('../native-build-input.config.json', import.meta.url),
);

function bindPresealConfigProjection(config) {
  config.root.provenance.presealReceipt.configProjection = presealConfigAuthorityIdentity(config);
  return config;
}

function pendingPresealConfig(config) {
  const pending = structuredClone(config);
  const projection = presealConfigAuthorityIdentity(pending);
  pending.root.provenance.presealReceipt = {
    bindingPolicy: PRESEAL_BINDING_POLICY,
    configProjection: projection,
    status: 'pending',
  };
  const receiptIndex = pending.surfaces.findIndex((surface) => surface.surfaceId === 'preseal-receipt');
  assert.notEqual(receiptIndex, -1);
  pending.surfaces[receiptIndex] = {
    sources: [],
    surfaceId: 'preseal-receipt',
  };
  assert.deepEqual(presealConfigAuthorityIdentity(pending), projection);
  return pending;
}

function bindPassedTestPreseal(config) {
  const fixture = presealEnvelopeFixture().bind().config;
  const receipt = structuredClone(fixture.root.provenance.presealReceipt);
  receipt.commandCount = 54;
  receipt.configProjection = presealConfigAuthorityIdentity(config);
  receipt.offlineReused = 491;
  config.root.provenance.presealReceipt = receipt;
  const surfaceIndex = config.surfaces.findIndex(
    (candidate) => candidate.surfaceId === 'preseal-receipt',
  );
  assert.notEqual(surfaceIndex, -1);
  config.surfaces[surfaceIndex] = structuredClone(fixture.surfaces[0]);
  return config;
}

function presealEnvelopeFixture() {
  const runId = '0123456789abcdef0123456789abcdef';
  const rootName = `cx004-preseal-${runId}.json`;
  const payloadName = `cx004-preseal-${runId}.payload.json`;
  const config = {
    privacy: { forbiddenSubstrings: ['PRIVATE_SENTINEL'] },
    root: { provenance: { presealReceipt: {} } },
    surfaces: [{ surfaceId: 'preseal-receipt' }],
  };
  const projection = presealConfigAuthorityIdentity(config);
  const payload = {
    authenticode: {},
    capturedAtUtc: '2026-07-14T12:34:56.789Z',
    commands: [{}],
    configAuthority: {
      algorithm: projection.algorithm,
      capturedConfig: { bytes: 123, sha256: '1'.repeat(64) },
      projection: { bytes: projection.bytes, sha256: projection.sha256 },
    },
    executableFacts: [],
    filesystemAudits: {},
    gpgRuntimeClosure: {},
    gitRuntimeClosure: {},
    networkPolicy: {},
    outcome: 'passed',
    packageMaterialization: {},
    pathPolicy: {},
    repository: {},
    runId,
    runtime: {},
    schemaVersion: PRESEAL_PAYLOAD_SCHEMA_VERSION,
    scope: {
      externalProjectDataAccessed: false,
      payloadLogicalPath: `<cache>/preseal/receipts/${payloadName}`,
      providerProcessesStarted: false,
      receiptLogicalPath: `<cache>/preseal/receipts/${rootName}`,
      stableRepositoryMutated: false,
      workspaceMaterializationLogicalPath: '<run>/workspace',
    },
    servicedSystemTools: {},
    signatures: {},
  };
  const bind = (rootEncoder = canonicalJsonBytes, payloadEncoder = canonicalJsonBytes) => {
    const payloadBytes = payloadEncoder(payload);
    const payloadDescriptor = {
      bytes: payloadBytes.length,
      logicalPath: `preseal/${payloadName}`,
      schema: PRESEAL_PAYLOAD_SCHEMA_VERSION,
      sha256: sha256Bytes(payloadBytes),
    };
    const receiptRoot = {
      outcome: 'passed',
      payload: {
        bytes: payloadDescriptor.bytes,
        logicalPath: `<cache>/preseal/receipts/${payloadName}`,
        sha256: payloadDescriptor.sha256,
      },
      runId,
      schemaVersion: PRESEAL_ROOT_SCHEMA_VERSION,
      teardown: {
        outcome: 'removed',
        parentIdentityReplayed: true,
        runId,
        runRootAbsent: true,
        runRootDirectChild: true,
      },
    };
    const rootBytes = rootEncoder(receiptRoot);
    const rootDescriptor = {
      bytes: rootBytes.length,
      logicalPath: `preseal/${rootName}`,
      schema: PRESEAL_ROOT_SCHEMA_VERSION,
      sha256: sha256Bytes(rootBytes),
    };
    config.root.provenance.presealReceipt = {
      bindingPolicy: PRESEAL_BINDING_POLICY,
      commandCount: 1,
      configProjection: projection,
      offlineDownloaded: 0,
      offlineReused: 1,
      payload: payloadDescriptor,
      rootReceipt: rootDescriptor,
      signatureFamilies: PRESEAL_SIGNATURE_FAMILIES,
      status: 'passed',
    };
    const tuples = [
      [rootDescriptor.logicalPath, rootDescriptor.bytes, rootDescriptor.sha256],
      [payloadDescriptor.logicalPath, payloadDescriptor.bytes, payloadDescriptor.sha256],
    ].sort((left, right) => (left[0] < right[0] ? -1 : left[0] > right[0] ? 1 : 0));
    config.surfaces[0] = {
      expected: {
        byteLength: rootDescriptor.bytes + payloadDescriptor.bytes,
        fileCount: 2,
        surfaceSha256: sha256Bytes(canonicalJsonBytes(tuples)),
      },
      sources: [{
        files: [rootName, payloadName].sort(),
        location: 'preseal',
        logicalPrefix: 'preseal',
        mode: 'files',
        relativeRoot: '',
      }],
      surfaceId: 'preseal-receipt',
    };
    return { config, payload, payloadBytes, receiptRoot, rootBytes };
  };
  return { bind, config, payload, projection, runId };
}

function repositoryEvidenceFixture() {
  const historicalFeature = '1'.repeat(40);
  const historicalTree = '2'.repeat(40);
  const historicalCommit = '3'.repeat(40);
  const publishedFeature = '4'.repeat(40);
  const publishedTree = '5'.repeat(40);
  const publishedCommit = '6'.repeat(40);
  const historicalInputs = [
    'docs/execution/receipts/CX-004-Q0S.md',
    'docs/execution/slices/CX-004.md',
    'docs/current-state.md',
    'docs/execution/current.md',
    'package.json',
    'apps/server/package.json',
    'packages/db/package.json',
  ].map((relativePath, index) => [
    relativePath,
    index + 1,
    'a'.repeat(64),
    '7'.repeat(40),
  ]);
  const provenance = {
    repositoryChain: [
      {
        feature: historicalFeature,
        featureTree: historicalTree,
        landing: historicalCommit,
        landingTree: historicalTree,
        orderedLandingParents: ['0'.repeat(40), historicalFeature],
        stage: 'T0-native-toolchain-pin',
      },
      {
        feature: publishedFeature,
        featureTree: publishedTree,
        landing: publishedCommit,
        landingTree: publishedTree,
        orderedLandingParents: [historicalCommit, publishedFeature],
        stage: 'T1-native-input-lf-policy-amendment',
      },
    ],
    t0PreCodeBase: { commit: historicalCommit, tree: historicalTree },
    t0TrackedInputTupleSchema: ['path', 'canonicalLfBytes', 'canonicalLfSha256', 'gitBlob'],
    t0TrackedInputs: historicalInputs,
  };
  const repository = {
    gitObjectRewriteInputs: {
      commonDirectoryPathPolicy: true,
      graftsAbsent: true,
      replaceObjectsDisabledByArgvAndEnvironment: true,
      shallowAbsent: true,
    },
    historicalT0: {
      commit: historicalCommit,
      orderedParents: ['0'.repeat(40), historicalFeature],
      t0TrackedInputs: historicalInputs,
      trackedInputTupleSchema: provenance.t0TrackedInputTupleSchema,
      tree: historicalTree,
    },
    publishedBase: {
      commit: publishedCommit,
      orderedParents: [historicalCommit, publishedFeature],
      tree: publishedTree,
    },
  };
  return { provenance, repository };
}

async function withTempDirectory(prefix, callback) {
  const directory = await mkdtemp(path.join(tmpdir(), prefix));
  try {
    return await callback(directory);
  } finally {
    await rm(directory, { force: true, recursive: true });
  }
}

test('384-entry shard cap is exact and the 385th file creates a second shard', () => {
  const files = Array.from({ length: MAX_FILES_PER_SHARD + 1 }, (_, index) => (
    tuple(`store/${String(index).padStart(4, '0')}.bin`)
  ));
  const set = buildManifestSet({
    manifestSetId: 'cx-004-test-shard-boundary',
    rootMetadata: rootMetadata(),
    surfaces: [surface('pnpm-store', files)],
  });
  assert.equal(set.root.surfaces.rows[0][2], 2);
  const shardNames = [...set.files.keys()].filter((name) => name.startsWith(SHARD_FILE_PREFIX));
  assert.equal(shardNames.length, 2);
  const first = JSON.parse(set.files.get(shardNames[0]).toString('utf8'));
  const second = JSON.parse(set.files.get(shardNames[1]).toString('utf8'));
  assert.equal(first.files.length, MAX_FILES_PER_SHARD);
  assert.equal(second.files.length, 1);
  for (const bytes of set.files.values()) {
    assert.ok(bytes.length <= MAX_MANIFEST_BYTES);
  }
});

test('manifest-set construction is byte-deterministic across object and surface insertion order', () => {
  const first = buildManifestSet({
    manifestSetId: 'cx-004-test-determinism',
    rootMetadata: rootMetadata({ provenance: { z: 2, a: 1 } }),
    surfaces: [
      surface('z-surface', [tuple('z/file.bin')]),
      surface('a-surface', [tuple('a/file.bin')]),
    ],
  });
  const second = buildManifestSet({
    manifestSetId: 'cx-004-test-determinism',
    rootMetadata: {
      scope: { slice: 'CX-004' },
      runnerIdentity: {},
      provenance: { a: 1, z: 2 },
      packageResolution: {},
      officialInputs: [],
      observations: [],
      hostToolchain: {},
      buildRecipes: [],
      artifactPolicies: [],
    },
    surfaces: [
      surface('a-surface', [tuple('a/file.bin')]),
      surface('z-surface', [tuple('z/file.bin')]),
    ],
  });
  assert.deepEqual([...first.files.keys()], [...second.files.keys()]);
  for (const [name, bytes] of first.files) {
    assert.equal(bytes.equals(second.files.get(name)), true, name);
  }
  assert.equal(first.rootSha256, second.rootSha256);
});

test('v2 preseal root and payload envelope is exact, canonical, and projection-bound', () => {
  const valid = presealEnvelopeFixture().bind();
  assert.doesNotThrow(() => validatePresealV2Envelope(
    valid.config,
    valid.rootBytes,
    valid.payloadBytes,
  ));

  const changedPayload = Buffer.from(valid.payloadBytes);
  const outcomeOffset = changedPayload.indexOf(Buffer.from('"passed"', 'utf8'));
  assert.notEqual(outcomeOffset, -1);
  changedPayload[outcomeOffset + 1] = 0x66;
  assert.throws(
    () => validatePresealV2Envelope(valid.config, valid.rootBytes, changedPayload),
    /payload bytes\/SHA-256/u,
  );

  const noncanonicalFixture = presealEnvelopeFixture();
  const noncanonical = noncanonicalFixture.bind(
    canonicalJsonBytes,
    (value) => Buffer.concat([canonicalJsonBytes(value), Buffer.from('\n')]),
  );
  assert.throws(
    () => validatePresealV2Envelope(noncanonical.config, noncanonical.rootBytes, noncanonical.payloadBytes),
    /one line/u,
  );

  const expandedFixture = presealEnvelopeFixture();
  expandedFixture.payload.unexpected = true;
  const expanded = expandedFixture.bind();
  assert.throws(
    () => validatePresealV2Envelope(expanded.config, expanded.rootBytes, expanded.payloadBytes),
    /payload keys must be exactly/u,
  );

  const wrongRunFixture = presealEnvelopeFixture();
  wrongRunFixture.payload.runId = 'f'.repeat(32);
  const wrongRun = wrongRunFixture.bind();
  assert.throws(
    () => validatePresealV2Envelope(wrongRun.config, wrongRun.rootBytes, wrongRun.payloadBytes),
    /passed root envelope identity/u,
  );

  const authorityMutation = presealEnvelopeFixture().bind();
  authorityMutation.config.manifestSetId = 'changed-outside-the-elided-binding';
  assert.throws(
    () => validatePresealV2Envelope(
      authorityMutation.config,
      authorityMutation.rootBytes,
      authorityMutation.payloadBytes,
    ),
    /payload\.configAuthority does not equal/u,
  );

  const privacyLeakFixture = presealEnvelopeFixture();
  privacyLeakFixture.payload.repository.leak = 'PRIVATE_SENTINEL';
  const privacyLeak = privacyLeakFixture.bind();
  assert.throws(
    () => validatePresealV2Envelope(
      privacyLeak.config,
      privacyLeak.rootBytes,
      privacyLeak.payloadBytes,
    ),
    /forbidden host\/profile substring/u,
  );
});

test('v2 preseal payload has its own producer-compatible recursive member bound', () => {
  assert.throws(
    () => decodeCanonicalJsonBytes(Buffer.from('{}'), 'generic manifest', {
      maxManifestMembers: MAX_MANIFEST_MEMBERS + 1,
    }),
    /maxManifestMembers cannot exceed 4096/u,
  );
  const admittedFixture = presealEnvelopeFixture();
  admittedFixture.payload.repository.padding = Array.from({ length: 5_000 }, () => null);
  const admitted = admittedFixture.bind();
  assert.ok(admitted.payloadBytes.length < MAX_PRESEAL_PAYLOAD_BYTES);
  assert.doesNotThrow(() => validatePresealV2Envelope(
    admitted.config,
    admitted.rootBytes,
    admitted.payloadBytes,
  ));

  const rejectedFixture = presealEnvelopeFixture();
  rejectedFixture.payload.repository.padding = Array.from(
    { length: MAX_PRESEAL_PAYLOAD_MEMBERS },
    () => null,
  );
  const rejected = rejectedFixture.bind();
  assert.ok(rejected.payloadBytes.length < MAX_PRESEAL_PAYLOAD_BYTES);
  assert.throws(
    () => validatePresealV2Envelope(rejected.config, rejected.rootBytes, rejected.payloadBytes),
    /recursive member count .* exceeds 16384/u,
  );
});

test('v2 preseal descriptor and exact two-file surface reject transitional identities', () => {
  const legacy = presealEnvelopeFixture().bind();
  legacy.config.root.provenance.presealReceipt.payload.schema = 'pc-sdk.cx-004.preseal-evidence.v1';
  assert.throws(
    () => validatePresealV2Envelope(legacy.config, legacy.rootBytes, legacy.payloadBytes),
    /payload\.schema must equal/u,
  );

  const oneFile = presealEnvelopeFixture().bind();
  oneFile.config.surfaces[0].sources[0].files.pop();
  assert.throws(
    () => validatePresealV2Envelope(oneFile.config, oneFile.rootBytes, oneFile.payloadBytes),
    /config surface preseal-receipt does not equal/u,
  );

  const duplicate = presealEnvelopeFixture().bind();
  duplicate.config.surfaces.push(structuredClone(duplicate.config.surfaces[0]));
  assert.throws(
    () => validatePresealV2Envelope(duplicate.config, duplicate.rootBytes, duplicate.payloadBytes),
    /exactly one preseal-receipt surface/u,
  );
});

test('v2 pending preseal lifecycle is load-only and cannot escape into generation or manifests', async () => {
  const production = JSON.parse((await readFile(PRODUCTION_CONFIG_PATH)).toString('utf8'));
  const pending = pendingPresealConfig(production);
  const pendingProjection = presealConfigAuthorityIdentity(pending);
  const passedFixture = presealEnvelopeFixture().bind();
  const projectedPassed = structuredClone(pending);
  projectedPassed.root.provenance.presealReceipt = passedFixture.config.root.provenance.presealReceipt;
  projectedPassed.surfaces[projectedPassed.surfaces.findIndex(
    (surface) => surface.surfaceId === 'preseal-receipt',
  )] = passedFixture.config.surfaces[0];
  assert.deepEqual(presealConfigAuthorityIdentity(projectedPassed), pendingProjection);

  await withTempDirectory('pc-cx004-pending-lifecycle-', async (directory) => {
    const writeConfig = async (name, config) => {
      const configPath = path.join(directory, name);
      await writeFile(configPath, JSON.stringify(config));
      return configPath;
    };
    const pendingPath = await writeConfig('pending.json', pending);
    await assert.doesNotReject(loadManifestConfig(pendingPath));
    const hostileDllFlags = structuredClone(pending);
    hostileDllFlags.root.buildRecipes.find(
      (recipe) => recipe.id === 'msvc-release-addon',
    ).linkFlags.push('/allowisolation');
    bindPresealConfigProjection(hostileDllFlags);
    await assert.rejects(
      loadManifestConfig(await writeConfig('hostile-dll-flags.json', hostileDllFlags)),
      /cannot combine \/DLL with \/ALLOWISOLATION/u,
    );
    for (const [id, field] of [
      ['msvc-release-core', 'compileFlags'],
      ['msvc-release-bootstrap', 'compileFlags'],
      ['msvc-release-addon', 'compileFlags'],
      ['node-gyp-release-sqlite', 'compileFlagsC'],
      ['node-gyp-release-sqlite', 'compileFlagsCxx'],
    ]) {
      const hostileRuntime = structuredClone(pending);
      const flags = hostileRuntime.root.buildRecipes.find((recipe) => recipe.id === id)[field];
      flags[flags.indexOf('/MT')] = '/MD';
      bindPresealConfigProjection(hostileRuntime);
      await assert.rejects(
        loadManifestConfig(await writeConfig(`hostile-runtime-${id}-${field}.json`, hostileRuntime)),
        /retail static CRT \/MT/u,
      );
    }
    const missingLinkTrace = structuredClone(pending);
    const bootstrapLinkFlags = missingLinkTrace.root.buildRecipes.find(
      (recipe) => recipe.id === 'msvc-release-bootstrap',
    ).linkFlags;
    bootstrapLinkFlags.splice(bootstrapLinkFlags.indexOf('/VERBOSE:LIB'), 1);
    bindPresealConfigProjection(missingLinkTrace);
    await assert.rejects(
      loadManifestConfig(await writeConfig('missing-link-trace.json', missingLinkTrace)),
      /must select \/LTCG and \/VERBOSE:LIB/u,
    );
    for (const hostileCoverageDirectory of [
      '/clang:-fcoverage-compilation-dir=packages/windows-containment/native',
      '/clang:-fcoverage-compilation-dir=C:\\ambient',
    ]) {
      const hostileCoverage = structuredClone(pending);
      const coverageFlags = hostileCoverage.root.buildRecipes.find(
        (recipe) => recipe.id === 'llvm-19.1.7-coverage-replay',
      ).compileFlags;
      coverageFlags.splice(
        coverageFlags.findIndex((flag) => flag.startsWith('/clang:-fcoverage-compilation-dir=')),
        1,
        hostileCoverageDirectory,
      );
      bindPresealConfigProjection(hostileCoverage);
      await assert.rejects(
        loadManifestConfig(await writeConfig('hostile-coverage-directory.json', hostileCoverage)),
        /exact singleton source prefix map and current-directory coverage mapping/u,
      );
    }
    for (const hostileCoverageAlias of [
      '/clang:-ffile-compilation-dir=C:\\ambient',
      '/clang:-fcoverage-prefix-map=${SOURCE_ROOT}=ambient',
      '-ffile-compilation-dir=C:\\ambient',
      '-fcoverage-compilation-dir=C:\\ambient',
      '-fcoverage-prefix-map=${SOURCE_ROOT}=ambient',
    ]) {
      const hostileCoverage = structuredClone(pending);
      hostileCoverage.root.buildRecipes.find(
        (recipe) => recipe.id === 'llvm-19.1.7-coverage-replay',
      ).compileFlags.push(hostileCoverageAlias);
      bindPresealConfigProjection(hostileCoverage);
      await assert.rejects(
        loadManifestConfig(await writeConfig('hostile-coverage-alias.json', hostileCoverage)),
        /exact singleton source prefix map and current-directory coverage mapping/u,
      );
    }
    const unknownCoverageAlias = structuredClone(pending);
    unknownCoverageAlias.root.buildRecipes.find(
      (recipe) => recipe.id === 'llvm-19.1.7-coverage-replay',
    ).compileFlags.push('/clang:-future-coverage-path-alias=ambient');
    bindPresealConfigProjection(unknownCoverageAlias);
    await assert.rejects(
      loadManifestConfig(await writeConfig('unknown-coverage-alias.json', unknownCoverageAlias)),
      /compileFlags must equal/u,
    );
    await assert.rejects(
      generateManifestSetFromConfig(pendingPath),
      /refuses the pending preseal lifecycle/u,
    );
    assert.throws(
      () => buildManifestSet({
        manifestSetId: pending.manifestSetId,
        rootMetadata: pending.root,
        surfaces: [surface('fixture', [tuple('fixture/file.bin')])],
      }),
      /pending lifecycle is permitted only while loading capture config/u,
    );

    const generic = buildManifestSet({
      manifestSetId: 'cx-004-pending-root-rejection',
      rootMetadata: rootMetadata(),
      surfaces: [surface('fixture', [tuple('fixture/file.bin')])],
    });
    const escapedRoot = structuredClone(generic.root);
    escapedRoot.manifestSetId = pending.manifestSetId;
    escapedRoot.scope = { classification: 'tracked-pre-code-native-build-input-root' };
    escapedRoot.provenance = { presealReceipt: pending.root.provenance.presealReceipt };
    const escapedRootPath = path.join(directory, ROOT_FILE_NAME);
    await writeFile(escapedRootPath, canonicalJsonBytes(escapedRoot));
    await assert.rejects(
      verifyManifestSet({ rootPath: escapedRootPath }),
      /pending lifecycle is forbidden in a root manifest/u,
    );

    const downgradedRoot = structuredClone(escapedRoot);
    downgradedRoot.scope.classification = 'downgraded-generic';
    await writeFile(escapedRootPath, canonicalJsonBytes(downgradedRoot));
    await assert.rejects(
      verifyManifestSet({ rootPath: escapedRootPath }),
      /cannot downgrade a CX-004 production root authority/u,
    );

    const downgradedConfig = structuredClone(pending);
    downgradedConfig.root.scope.classification = 'downgraded-generic';
    bindPresealConfigProjection(downgradedConfig);
    await assert.rejects(
      loadManifestConfig(await writeConfig('downgraded-config.json', downgradedConfig)),
      /cannot downgrade a CX-004 production root authority/u,
    );
    assert.throws(
      () => buildManifestSet({
        manifestSetId: downgradedConfig.manifestSetId,
        rootMetadata: downgradedConfig.root,
        surfaces: [surface('fixture', [tuple('fixture/file.bin')])],
      }),
      /cannot downgrade a CX-004 production root authority/u,
    );

    const expanded = structuredClone(pending);
    expanded.root.provenance.presealReceipt.commandCount = 54;
    await assert.rejects(
      loadManifestConfig(await writeConfig('expanded-pending.json', expanded)),
      /presealReceipt keys must be exactly/u,
    );
    const unknown = structuredClone(pending);
    unknown.root.provenance.presealReceipt.status = 'capturing';
    await assert.rejects(
      loadManifestConfig(await writeConfig('unknown-pending.json', unknown)),
      /presealReceipt keys must be exactly/u,
    );
    const legacy = structuredClone(pending);
    legacy.root.provenance.presealReceipt = {
      bytes: 1,
      commandCount: 1,
      logicalPath: 'preseal/legacy.json',
      offlineDownloaded: 0,
      offlineReused: 1,
      schema: 'pc-sdk.cx-004.preseal-evidence.v1',
      sha256: '0'.repeat(64),
      signatureFamilies: [],
      status: 'passed',
    };
    await assert.rejects(
      loadManifestConfig(await writeConfig('legacy-v1.json', legacy)),
      /presealReceipt keys must be exactly/u,
    );
  });
});

test('manifest and single-file shard bounds fail closed', () => {
  assert.throws(() => buildManifestSet({
    manifestSetId: 'cx-004-test-root-too-large',
    rootMetadata: rootMetadata({ observations: [{ payload: 'x'.repeat(MAX_MANIFEST_BYTES) }] }),
    surfaces: [surface('one', [tuple('one/file.bin')])],
  }), /root manifest byte length/u);

  assert.throws(() => buildManifestSet({
    manifestSetId: 'cx-004-test-shard-too-small',
    rootMetadata: rootMetadata(),
    surfaces: [surface('one', [tuple('one/file.bin')])],
  }, { maxManifestBytes: 250 }), /cannot fit in one bounded shard/u);

  const baseline = buildManifestSet({
    manifestSetId: 'cx-004-test-host-sidecar-bound',
    rootMetadata: rootMetadata(),
    surfaces: [surface('one', [tuple('one/file.bin')])],
  });
  const hostBytes = baseline.files.get(baseline.root.hostToolchain.fileName);
  assert.throws(() => buildManifestSet({
    manifestSetId: 'cx-004-test-host-sidecar-bound',
    rootMetadata: rootMetadata(),
    surfaces: [surface('one', [tuple('one/file.bin')])],
  }, { maxManifestBytes: hostBytes.length - 1 }), /host-toolchain metadata manifest byte length/u);

  assert.throws(() => buildManifestSet({
    manifestSetId: 'cx-004-test-host-sidecar-members',
    rootMetadata: rootMetadata({
      hostToolchain: { padding: Array.from({ length: MAX_MANIFEST_MEMBERS }, () => null) },
    }),
    surfaces: [surface('one', [tuple('one/file.bin')])],
  }), /host-toolchain metadata manifest recursive member count .* exceeds 4096/u);
});

test('preseal repository evidence keeps published base and historical T0 authority separate', () => {
  const fixture = repositoryEvidenceFixture();
  assert.equal(
    validatePresealRepositoryEvidence(fixture.repository, fixture.provenance),
    fixture.repository,
  );

  const publishedDrift = structuredClone(fixture.repository);
  publishedDrift.publishedBase.tree = '8'.repeat(40);
  assert.throws(
    () => validatePresealRepositoryEvidence(publishedDrift, fixture.provenance),
    /does not equal/u,
  );

  const historicalDrift = structuredClone(fixture.repository);
  historicalDrift.historicalT0.t0TrackedInputs[0][2] = 'b'.repeat(64);
  assert.throws(
    () => validatePresealRepositoryEvidence(historicalDrift, fixture.provenance),
    /does not equal/u,
  );

  const discontinuous = structuredClone(fixture.provenance);
  discontinuous.repositoryChain[1].orderedLandingParents[0] = '9'.repeat(40);
  assert.throws(
    () => validatePresealRepositoryEvidence(fixture.repository, discontinuous),
    /does not continue the ordered landing chain/u,
  );
});

test('config-backed enumeration, write, and regeneration are deterministic and private', async () => {
  await withTempDirectory('pc-cx004-manifest-', async (directory) => {
    const source = path.join(directory, 'source');
    const output = path.join(directory, 'output');
    // The directory name is a prefix of the sibling file name. A depth-first
    // traversal yields a/b.txt before a.txt, while global ordinal order is the
    // reverse; membership comparison must normalize both passes identically.
    await mkdir(path.join(source, 'a'), { recursive: true });
    await writeFile(path.join(source, 'a.txt'), 'alpha');
    await writeFile(path.join(source, 'a', 'b.txt'), 'bravo');
    const expectedFiles = [
      tuple('sealed/cache/a.txt', 'alpha'),
      tuple('sealed/cache/a/b.txt', 'bravo'),
    ];
    const configPath = path.join(directory, 'config.json');
    await writeFile(configPath, JSON.stringify({
      schemaVersion: 'pc-sdk.cx-004.native-build-input-config.v1',
      manifestSetId: 'cx-004-test-config',
      locations: { cache: source },
      output: { directory: output, rootFileName: ROOT_FILE_NAME },
      privacy: { forbiddenSubstrings: ['Alice'] },
      root: rootMetadata(),
      surfaces: [{
        expected: {
          byteLength: 10,
          fileCount: 2,
          surfaceSha256: sha256Bytes(canonicalJsonBytes(expectedFiles)),
        },
        surfaceId: 'cache',
        sources: [{ location: 'cache', logicalPrefix: 'sealed/cache', mode: 'tree', relativeRoot: '' }],
      }],
    }, null, 2));

    const first = await generateManifestSetFromConfig(configPath);
    const second = await generateManifestSetFromConfig(configPath);
    assert.equal(first.manifestSet.rootBytes.equals(second.manifestSet.rootBytes), true);
    assert.equal(first.manifestSet.root.schemaVersion, ROOT_SCHEMA_VERSION);
    assert.ok(
      first.manifestSet.root.hostToolchain.fileName.startsWith(
        HOST_TOOLCHAIN_METADATA_FILE_PREFIX,
      ),
    );
    assert.equal(
      first.manifestSet.root.hostToolchain.fileName,
      second.manifestSet.root.hostToolchain.fileName,
    );
    assert.ok(
      countPresealPayloadMembers(first.manifestSet.root) <= MAX_MANIFEST_MEMBERS,
    );
    const hostToolchainMetadata = decodeCanonicalJsonBytes(
      first.manifestSet.files.get(first.manifestSet.root.hostToolchain.fileName),
      first.manifestSet.root.hostToolchain.fileName,
    );
    assert.deepEqual(hostToolchainMetadata.hostToolchain, first.config.root.hostToolchain);
    assert.ok(countPresealPayloadMembers(hostToolchainMetadata) <= MAX_MANIFEST_MEMBERS);
    for (const [name, bytes] of first.manifestSet.files) {
      assert.equal(bytes.equals(second.manifestSet.files.get(name)), true, name);
      assert.equal(bytes.toString('utf8').includes(directory), false, name);
    }
    const receipt = await writeManifestSet(first.manifestSet, output, {
      forbiddenSubstrings: first.forbiddenSubstrings,
    });
    assert.equal(receipt.manifestSetId, 'cx-004-test-config');
    assert.equal(receipt.auxiliaryManifestCount, first.manifestSet.root.auxiliaryManifests.rows.length);
    assert.equal(receipt.hostToolchainMetadataManifestCount, 1);
    assert.equal(receipt.totalAuxiliaryManifestCount, first.manifestSet.files.size - 1);
    const verified = await verifyManifestSet({
      forbiddenSubstrings: first.forbiddenSubstrings,
      rootPath: path.join(output, ROOT_FILE_NAME),
    });
    assert.equal(verified.rootSha256, first.manifestSet.rootSha256);
  });
});

test('current repo bytes do not overwrite or impersonate historical T0 tuples', async () => {
  await withTempDirectory('pc-cx004-history-current-split-', async (directory) => {
    const source = path.join(directory, 'source');
    const output = path.join(directory, 'output');
    const currentContents = 'current T1 bytes\n';
    const historicalContents = Buffer.from('historical T0 bytes\n', 'utf8');
    await mkdir(source, { recursive: true });
    await writeFile(path.join(source, 'package.json'), currentContents);
    const currentFiles = [tuple('repo/package.json', currentContents)];
    const configPath = path.join(directory, 'config.json');
    await writeFile(configPath, JSON.stringify({
      schemaVersion: 'pc-sdk.cx-004.native-build-input-config.v1',
      manifestSetId: 'cx-004-test-history-current-split',
      locations: { repo: source },
      output: { directory: output, rootFileName: ROOT_FILE_NAME },
      privacy: { forbiddenSubstrings: [] },
      root: rootMetadata({
        provenance: {
          t0TrackedInputs: [[
            'package.json',
            historicalContents.length,
            sha256Bytes(historicalContents),
            'a'.repeat(40),
          ]],
        },
      }),
      surfaces: [{
        expected: {
          byteLength: currentFiles[0][1],
          fileCount: 1,
          surfaceSha256: sha256Bytes(canonicalJsonBytes(currentFiles)),
        },
        surfaceId: 'repo-current',
        sources: [{ location: 'repo', logicalPrefix: 'repo', mode: 'tree', relativeRoot: '' }],
      }],
    }, null, 2));

    const generated = await generateManifestSetFromConfig(configPath);
    const currentSurface = generated.manifestSet.root.surfaces.rows.find(
      (row) => row[3] === 'repo-current',
    );
    assert.equal(currentSurface[4], sha256Bytes(canonicalJsonBytes(currentFiles)));
    assert.deepEqual(
      generated.config.root.provenance.t0TrackedInputs,
      [[
        'package.json',
        historicalContents.length,
        sha256Bytes(historicalContents),
        'a'.repeat(40),
      ]],
    );
  });
});

test('verifier closes referenced sidecar and shard bytes while tolerating only regular crash residue', async () => {
  await withTempDirectory('pc-cx004-closure-', async (directory) => {
    const set = buildManifestSet({
      manifestSetId: 'cx-004-test-closure',
      rootMetadata: rootMetadata(),
      surfaces: [surface('surface', [tuple('surface/file.bin')])],
    });
    await writeManifestSet(set, directory);
    const rootPath = path.join(directory, ROOT_FILE_NAME);
    const hostName = set.root.hostToolchain.fileName;
    const hostPath = path.join(directory, hostName);
    const originalHostBytes = await readFile(hostPath);
    await rm(hostPath);
    await assert.rejects(
      verifyManifestSet({ rootPath }),
      /host-toolchain metadata manifest is missing/u,
    );
    await writeFile(hostPath, originalHostBytes);
    const tamperedHost = Buffer.from(originalHostBytes);
    tamperedHost[tamperedHost.length - 2] = tamperedHost[tamperedHost.length - 2] === 0x30 ? 0x31 : 0x30;
    await writeFile(hostPath, tamperedHost);
    await assert.rejects(
      verifyManifestSet({ rootPath }),
      /SHA-256 does not equal its root reference/u,
    );
    await writeFile(hostPath, originalHostBytes);

    const shardName = set.root.auxiliaryManifests.rows[0][1];
    const shardPath = path.join(directory, shardName);
    const originalShardBytes = await readFile(shardPath);
    await rm(shardPath);
    await assert.rejects(
      verifyManifestSet({ rootPath }),
      /missing referenced shard/u,
    );
    await writeFile(shardPath, originalShardBytes);
    const staleShardPath = path.join(directory, `${SHARD_FILE_PREFIX}stale-001.json`);
    const staleHostPath = path.join(
      directory,
      `${HOST_TOOLCHAIN_METADATA_FILE_PREFIX}stale.json`,
    );
    await writeFile(staleShardPath, canonicalJsonBytes({ stale: true }));
    await writeFile(staleHostPath, canonicalJsonBytes({ stale: true }));
    await assert.doesNotReject(
      verifyManifestSet({ rootPath }),
    );
    await writeManifestSet(set, directory);
    await assert.rejects(readFile(staleShardPath), { code: 'ENOENT' });
    await assert.rejects(readFile(staleHostPath), { code: 'ENOENT' });

    const unsafeStaleHostPath = path.join(
      directory,
      `${HOST_TOOLCHAIN_METADATA_FILE_PREFIX}unsafe.json`,
    );
    await mkdir(unsafeStaleHostPath);
    await assert.rejects(
      verifyManifestSet({ rootPath }),
      /auxiliary manifest candidate .* is not a regular file/u,
    );
    await rm(unsafeStaleHostPath, { recursive: true });

    const shardBytes = await readFile(shardPath);
    const tampered = Buffer.from(shardBytes);
    tampered[tampered.length - 2] = tampered[tampered.length - 2] === 0x30 ? 0x31 : 0x30;
    await writeFile(shardPath, tampered);
    await assert.rejects(
      verifyManifestSet({ rootPath }),
      /SHA-256 does not equal/u,
    );
  });
});

test('publication rejects every file outside the exact root-referenced basename closure before writing', async () => {
  await withTempDirectory('pc-cx004-publication-closure-', async (directory) => {
    const set = buildManifestSet({
      manifestSetId: 'cx-004-test-publication-closure',
      rootMetadata: rootMetadata(),
      surfaces: [surface('surface', [tuple('surface/file.bin')])],
    });
    const escapedName = `escape-${path.basename(directory)}.json`;
    const escapedPath = path.resolve(directory, '..', escapedName);
    set.files.set(`../${escapedName}`, canonicalJsonBytes({ escaped: true }));
    await assert.rejects(
      writeManifestSet(set, directory),
      /unsafe filename/u,
    );
    await assert.rejects(readFile(escapedPath), { code: 'ENOENT' });
    await assert.rejects(readFile(path.join(directory, ROOT_FILE_NAME)), { code: 'ENOENT' });
  });
});

test('publication reconstructs the complete surface closure before any mutation', async () => {
  await withTempDirectory('pc-cx004-publication-surface-', async (directory) => {
    const set = buildManifestSet({
      manifestSetId: 'cx-004-test-publication-surface',
      rootMetadata: rootMetadata(),
      surfaces: [surface('surface', [tuple('surface/file.bin')])],
    });
    const originalShardName = set.root.auxiliaryManifests.rows[0][1];
    const shard = decodeCanonicalJsonBytes(set.files.get(originalShardName), originalShardName);
    shard.shardCount = 2;
    const shardBytes = canonicalJsonBytes(shard);
    const shardSha256 = sha256Bytes(shardBytes);
    const shardName = `${SHARD_FILE_PREFIX}surface-001-${shardSha256}.json`;
    set.files.delete(originalShardName);
    set.files.set(shardName, shardBytes);
    set.root.auxiliaryManifests.rows[0] = [
      shardBytes.length,
      shardName,
      shardSha256,
      'surface',
    ];
    set.rootBytes = canonicalJsonBytes(set.root);
    set.rootSha256 = sha256Bytes(set.rootBytes);
    set.files.set(ROOT_FILE_NAME, set.rootBytes);
    await assert.rejects(
      writeManifestSet(set, directory),
      /shard indices\/counts are not a closed 0-based sequence/u,
    );
    await assert.rejects(readFile(path.join(directory, ROOT_FILE_NAME)), { code: 'ENOENT' });
  });
});

test('standalone verifier enforces stricter caller shard and auxiliary limits', async () => {
  await withTempDirectory('pc-cx004-verifier-limits-', async (directory) => {
    const set = buildManifestSet({
      manifestSetId: 'cx-004-test-verifier-limits',
      rootMetadata: rootMetadata(),
      surfaces: [surface('surface', [
        tuple('surface/one.bin'),
        tuple('surface/two.bin'),
      ])],
    });
    await writeManifestSet(set, directory);
    const rootPath = path.join(directory, ROOT_FILE_NAME);
    await assert.rejects(
      verifyManifestSet({ limits: { maxAuxiliaryManifests: 1 }, rootPath }),
      /auxiliary manifest count exceeds 1/u,
    );
    await assert.rejects(
      verifyManifestSet({ limits: { maxFilesPerShard: 1 }, rootPath }),
      /files must contain 1\.\.1 tuples/u,
    );
  });
});

test('verifier rejects canonical root schema expansion', async () => {
  await withTempDirectory('pc-cx004-schema-', async (directory) => {
    const set = buildManifestSet({
      manifestSetId: 'cx-004-test-schema',
      rootMetadata: rootMetadata(),
      surfaces: [surface('surface', [tuple('surface/file.bin')])],
    });
    await writeManifestSet(set, directory);
    const rootPath = path.join(directory, ROOT_FILE_NAME);
    const root = JSON.parse((await readFile(rootPath)).toString('utf8'));
    root.unexpected = true;
    await writeFile(rootPath, canonicalJsonBytes(root));
    await assert.rejects(verifyManifestSet({ rootPath }), /keys must be exactly/u);
  });
});

test('root-bound host-toolchain descriptor and sidecar wrapper fail closed', async () => {
  await withTempDirectory('pc-cx004-host-sidecar-schema-', async (directory) => {
    const set = buildManifestSet({
      manifestSetId: 'cx-004-test-host-sidecar-schema',
      rootMetadata: rootMetadata(),
      surfaces: [surface('surface', [tuple('surface/file.bin')])],
    });
    const rootPath = path.join(directory, ROOT_FILE_NAME);
    const originalSidecar = decodeCanonicalJsonBytes(
      set.files.get(set.root.hostToolchain.fileName),
      set.root.hostToolchain.fileName,
    );

    const rootMutations = [
      ['legacy root schema', (root) => { root.schemaVersion = 'pc-sdk.cx-004.native-build-input.v1'; }, /root\.schemaVersion must equal/u],
      ['descriptor schema', (root) => { root.hostToolchain.schemaVersion = 'unexpected'; }, /hostToolchain\.schemaVersion must equal/u],
      ['descriptor bytes', (root) => { root.hostToolchain.byteLength += 1; }, /byte length does not equal its root reference/u],
      ['descriptor SHA', (root) => { root.hostToolchain.sha256 = '0'.repeat(64); }, /content-addressed host-toolchain metadata name/u],
      ['descriptor filename', (root) => { root.hostToolchain.fileName = 'other.json'; }, /content-addressed host-toolchain metadata name/u],
    ];
    for (const [label, mutate, expected] of rootMutations) {
      await writeManifestSet(set, directory);
      const root = structuredClone(set.root);
      mutate(root);
      await writeFile(rootPath, canonicalJsonBytes(root));
      await assert.rejects(verifyManifestSet({ rootPath }), expected, label);
    }

    const wrapperMutations = [
      ['classification', (manifest) => { manifest.classification = 'unexpected'; }],
      ['schemaVersion', (manifest) => { manifest.schemaVersion = 'unexpected'; }],
      ['manifestSetId', (manifest) => { manifest.manifestSetId = 'unexpected'; }],
      ['extra key', (manifest) => { manifest.unexpected = true; }],
    ];
    for (const [label, mutate] of wrapperMutations) {
      await writeManifestSet(set, directory);
      const root = structuredClone(set.root);
      const manifest = structuredClone(originalSidecar);
      mutate(manifest);
      await writeReboundHostToolchainMetadata(directory, root, manifest);
      await assert.rejects(
        verifyManifestSet({ rootPath }),
        /keys must be exactly|root-bound host-toolchain metadata identity/u,
        label,
      );
    }

    await writeManifestSet(set, directory);
    const memberOverflowRoot = structuredClone(set.root);
    const memberOverflowSidecar = structuredClone(originalSidecar);
    memberOverflowSidecar.hostToolchain = {
      padding: Array.from({ length: MAX_MANIFEST_MEMBERS }, () => null),
    };
    await writeReboundHostToolchainMetadata(
      directory,
      memberOverflowRoot,
      memberOverflowSidecar,
    );
    await assert.rejects(
      verifyManifestSet({ rootPath }),
      /recursive member count .* exceeds 4096/u,
    );

    await writeManifestSet(set, directory);
    const oversizedRoot = structuredClone(set.root);
    const oversizedSidecar = structuredClone(originalSidecar);
    oversizedSidecar.hostToolchain = { padding: 'x'.repeat(MAX_MANIFEST_BYTES) };
    await writeReboundHostToolchainMetadata(directory, oversizedRoot, oversizedSidecar);
    await assert.rejects(
      verifyManifestSet({ rootPath }),
      /declared byte length exceeds/u,
    );
  });
});

test('standalone verification revalidates the exact production host-toolchain schema', async () => {
  await withTempDirectory('pc-cx004-production-host-sidecar-', async (directory) => {
    const config = JSON.parse((await readFile(PRODUCTION_CONFIG_PATH)).toString('utf8'));
    const passedReceipt = presealEnvelopeFixture().bind().config.root.provenance.presealReceipt;
    passedReceipt.commandCount = 54;
    passedReceipt.configProjection = config.root.provenance.presealReceipt.configProjection;
    passedReceipt.offlineReused = 491;
    config.root.provenance.presealReceipt = passedReceipt;
    const set = buildManifestSet({
      manifestSetId: config.manifestSetId,
      rootMetadata: config.root,
      surfaces: [surface('fixture', [tuple('fixture/file.bin')])],
    });
    await writeManifestSet(set, directory);
    const root = structuredClone(set.root);
    const sidecar = decodeCanonicalJsonBytes(
      set.files.get(set.root.hostToolchain.fileName),
      set.root.hostToolchain.fileName,
    );
    sidecar.hostToolchain.buildEnvironment.unexpectedExpansion = true;
    await writeReboundHostToolchainMetadata(directory, root, sidecar);
    await assert.rejects(
      verifyManifestSet({ rootPath: path.join(directory, ROOT_FILE_NAME) }),
      /hostToolchain does not equal the exact CX-004 host-toolchain authority/u,
    );
  });
});

test('production config satisfies the strict CX-004 root schema and rejects expansion', async () => {
  const productionConfigPath = PRODUCTION_CONFIG_PATH;
  await assert.doesNotReject(loadManifestConfig(productionConfigPath));
  await withTempDirectory('pc-cx004-production-schema-', async (directory) => {
    const config = JSON.parse((await readFile(productionConfigPath)).toString('utf8'));
    config.root.provenance.unexpected = true;
    const expandedPath = path.join(directory, 'expanded-config.json');
    await writeFile(expandedPath, JSON.stringify(config));
    await assert.rejects(
      loadManifestConfig(expandedPath),
      /root\.provenance keys must be exactly/u,
    );
    const wrongIdentity = JSON.parse((await readFile(productionConfigPath)).toString('utf8'));
    const gitSurface = wrongIdentity.surfaces.find(
      (surface) => surface.surfaceId === 'git-execution-closure',
    );
    gitSurface.sources[1].identityPolicy.kind = 'windows-servicing-hardlink-v1';
    bindPresealConfigProjection(wrongIdentity);
    const wrongIdentityPath = path.join(directory, 'wrong-identity-config.json');
    await writeFile(wrongIdentityPath, JSON.stringify(wrongIdentity));
    await assert.rejects(
      loadManifestConfig(wrongIdentityPath),
      /config surface git-execution-closure does not equal its declared root identity/u,
    );
    const wrongSystemTool = JSON.parse((await readFile(productionConfigPath)).toString('utf8'));
    wrongSystemTool.root.hostToolchain.authenticodeVerificationTool.sha256 = '0'.repeat(64);
    bindPresealConfigProjection(wrongSystemTool);
    const wrongSystemToolPath = path.join(directory, 'wrong-system-tool-config.json');
    await writeFile(wrongSystemToolPath, JSON.stringify(wrongSystemTool));
    await assert.rejects(
      loadManifestConfig(wrongSystemToolPath),
      /authenticodeVerificationTool does not equal its declared root identity/u,
    );
    for (const [toolName, label] of [
      ['authenticodeVerificationTool', 'powershell'],
      ['processTreeTerminationTool', 'taskkill'],
    ]) {
      const wrongEmbeddedVersion = JSON.parse((await readFile(productionConfigPath)).toString('utf8'));
      wrongEmbeddedVersion.root.hostToolchain[toolName].embeddedFileVersion = '10.0.26100.8457';
      bindPresealConfigProjection(wrongEmbeddedVersion);
      const wrongEmbeddedVersionPath = path.join(directory, `wrong-${label}-embedded-version-config.json`);
      await writeFile(wrongEmbeddedVersionPath, JSON.stringify(wrongEmbeddedVersion));
      await assert.rejects(
        loadManifestConfig(wrongEmbeddedVersionPath),
        new RegExp(`${toolName} does not equal its declared root identity`, 'u'),
      );
    }
    const missingStorePolicy = JSON.parse((await readFile(productionConfigPath)).toString('utf8'));
    const storeSurface = missingStorePolicy.surfaces.find(
      (surface) => surface.surfaceId === 'pnpm-store-v10',
    );
    delete storeSurface.sources[1].identityPolicy;
    bindPresealConfigProjection(missingStorePolicy);
    const missingStorePolicyPath = path.join(directory, 'missing-store-policy-config.json');
    await writeFile(missingStorePolicyPath, JSON.stringify(missingStorePolicy));
    await assert.rejects(
      loadManifestConfig(missingStorePolicyPath),
      /pnpm-store-v10\.sources\[1\]\.identityPolicy is required/u,
    );
  });
});

test('production policy authority rejects scope promotion and artifact-policy drift', async () => {
  const source = JSON.parse((await readFile(PRODUCTION_CONFIG_PATH)).toString('utf8'));
  const mutations = [
    [
      'production admission promotion',
      (config) => { config.root.scope.productionAdmission = true; },
      /productionAdmission|fake-only scope|scope does not equal its declared root identity/u,
    ],
    [
      'artifact policy omission',
      (config) => {
        config.root.artifactPolicies = config.root.artifactPolicies.filter(
          (policy) => policy.artifactId !== 'better-sqlite3-hardened',
        );
      },
      /artifactPolicies|artifact policy/u,
    ],
    [
      'artifact policy duplication',
      (config) => {
        config.root.artifactPolicies.push(structuredClone(config.root.artifactPolicies[0]));
      },
      /artifactPolicies|artifact policy/u,
    ],
    [
      'artifact policy identity substitution',
      (config) => {
        const policy = config.root.artifactPolicies.find(
          (candidate) => candidate.artifactId === 'better-sqlite3-hardened',
        );
        assert.ok(policy);
        policy.artifactId = 'better-sqlite3-unhardened';
      },
      /artifactPolicies|artifact policy/u,
    ],
    [
      'SQLite hardening downgrade',
      (config) => {
        const policy = config.root.artifactPolicies.find(
          (candidate) => candidate.artifactId === 'better-sqlite3-hardened',
        );
        assert.ok(policy);
        policy.hardening.cetShadowStack.status = 'exception-pending-decision';
      },
      /artifactPolicies|artifact policy|cetShadowStack|hardening/u,
    ],
  ];

  await withTempDirectory('pc-cx004-production-policy-', async (directory) => {
    for (const [name, mutate, expected] of mutations) {
      const candidate = structuredClone(source);
      mutate(candidate);
      bindPassedTestPreseal(candidate);
      const candidatePath = path.join(directory, `${name.replaceAll(' ', '-')}.json`);
      await writeFile(candidatePath, JSON.stringify(candidate));
      await assert.rejects(loadManifestConfig(candidatePath), expected, name);
      assert.throws(
        () => buildManifestSet({
          manifestSetId: candidate.manifestSetId,
          rootMetadata: candidate.root,
          surfaces: [surface('fixture', [tuple('fixture/file.bin')])],
        }),
        expected,
        name,
      );
    }
  });
});

test('standalone verification revalidates compact production policy authority', async () => {
  const config = JSON.parse((await readFile(PRODUCTION_CONFIG_PATH)).toString('utf8'));
  bindPassedTestPreseal(config);
  const set = buildManifestSet({
    manifestSetId: config.manifestSetId,
    rootMetadata: config.root,
    surfaces: [surface('fixture', [tuple('fixture/file.bin')])],
  });
  const policyIndexes = Object.fromEntries(
    set.root.artifactPolicies.fields.map((field, index) => [field, index]),
  );
  const artifactIdIndex = policyIndexes.artifactId;
  const hardeningIndex = policyIndexes['hardening:[control,status,evidence][]'];
  assert.equal(Number.isSafeInteger(artifactIdIndex), true);
  assert.equal(Number.isSafeInteger(hardeningIndex), true);

  function findCompactPolicy(root, artifactId) {
    const row = root.artifactPolicies.rows.find(
      (candidate) => candidate[1][artifactIdIndex] === artifactId,
    );
    assert.ok(row, `missing compact policy ${artifactId}`);
    return row;
  }

  const mutations = [
    [
      'production admission promotion',
      (root) => { root.scope.productionAdmission = true; },
      /productionAdmission|fake-only scope|scope does not equal its declared root identity/u,
    ],
    [
      'artifact policy omission',
      (root) => {
        const row = findCompactPolicy(root, 'better-sqlite3-hardened');
        root.artifactPolicies.rows.splice(root.artifactPolicies.rows.indexOf(row), 1);
      },
      /artifactPolicies|artifact policy/u,
    ],
    [
      'artifact policy duplication',
      (root) => {
        root.artifactPolicies.rows.push(structuredClone(root.artifactPolicies.rows[0]));
      },
      /artifactPolicies|artifact policy/u,
    ],
    [
      'artifact policy identity substitution',
      (root) => {
        const row = findCompactPolicy(root, 'better-sqlite3-hardened');
        row[1][artifactIdIndex] = 'better-sqlite3-unhardened';
      },
      /artifactPolicies|artifact policy/u,
    ],
    [
      'SQLite hardening downgrade',
      (root) => {
        const row = findCompactPolicy(root, 'better-sqlite3-hardened');
        const control = row[1][hardeningIndex].find(
          ([controlName]) => controlName === 'cetShadowStack',
        );
        assert.ok(control);
        control[1] = 'exception-pending-decision';
      },
      /artifactPolicies|artifact policy|cetShadowStack|hardening/u,
    ],
  ];

  await withTempDirectory('pc-cx004-compact-production-policy-', async (directory) => {
    const rootPath = path.join(directory, ROOT_FILE_NAME);
    for (const [name, mutate, expected] of mutations) {
      await writeManifestSet(set, directory);
      const root = structuredClone(set.root);
      mutate(root);
      await writeFile(rootPath, canonicalJsonBytes(root));
      await assert.rejects(verifyManifestSet({ rootPath }), expected, name);
    }
  });
});

test('production config requires the exact ordered seven-input historical T0 closure', async () => {
  const source = JSON.parse((await readFile(PRODUCTION_CONFIG_PATH)).toString('utf8'));
  const mutations = [
    ['empty', (config) => { config.root.provenance.t0TrackedInputs = []; }],
    ['missing', (config) => { config.root.provenance.t0TrackedInputs.pop(); }],
    ['duplicate', (config) => {
      config.root.provenance.t0TrackedInputs[1] = structuredClone(
        config.root.provenance.t0TrackedInputs[0],
      );
    }],
    ['reordered', (config) => {
      [
        config.root.provenance.t0TrackedInputs[0],
        config.root.provenance.t0TrackedInputs[1],
      ] = [
        config.root.provenance.t0TrackedInputs[1],
        config.root.provenance.t0TrackedInputs[0],
      ];
    }],
    ['substituted-path', (config) => {
      config.root.provenance.t0TrackedInputs[0][0] = 'README.md';
    }],
    ['short-tuple', (config) => { config.root.provenance.t0TrackedInputs[0].pop(); }],
    ['zero-bytes', (config) => { config.root.provenance.t0TrackedInputs[0][1] = 0; }],
    ['bad-sha', (config) => { config.root.provenance.t0TrackedInputs[0][2] = '0'.repeat(63); }],
    ['bad-blob', (config) => { config.root.provenance.t0TrackedInputs[0][3] = '0'.repeat(39); }],
  ];
  await withTempDirectory('pc-cx004-t0-closure-', async (directory) => {
    for (const [name, mutate] of mutations) {
      const candidate = structuredClone(source);
      mutate(candidate);
      bindPresealConfigProjection(candidate);
      const candidatePath = path.join(directory, `${name}.json`);
      await writeFile(candidatePath, JSON.stringify(candidate));
      await assert.rejects(loadManifestConfig(candidatePath), /t0TrackedInputs/u, name);
    }
  });
});

test('passed production config requires exactly 54 preseal commands', async () => {
  const source = JSON.parse((await readFile(PRODUCTION_CONFIG_PATH)).toString('utf8'));
  const runId = '0123456789abcdef0123456789abcdef';
  const rootReceipt = {
    bytes: 1,
    logicalPath: `preseal/cx004-preseal-${runId}.json`,
    schema: PRESEAL_ROOT_SCHEMA_VERSION,
    sha256: '1'.repeat(64),
  };
  const payload = {
    bytes: 2,
    logicalPath: `preseal/cx004-preseal-${runId}.payload.json`,
    schema: PRESEAL_PAYLOAD_SCHEMA_VERSION,
    sha256: '2'.repeat(64),
  };
  source.root.provenance.presealReceipt = {
    bindingPolicy: PRESEAL_BINDING_POLICY,
    commandCount: 54,
    configProjection: source.root.provenance.presealReceipt.configProjection,
    offlineDownloaded: 0,
    offlineReused: 491,
    payload,
    rootReceipt,
    signatureFamilies: PRESEAL_SIGNATURE_FAMILIES,
    status: 'passed',
  };
  const tuples = [
    [rootReceipt.logicalPath, rootReceipt.bytes, rootReceipt.sha256],
    [payload.logicalPath, payload.bytes, payload.sha256],
  ].sort((left, right) => left[0].localeCompare(right[0], 'en-US'));
  source.surfaces[source.surfaces.findIndex((surface) => surface.surfaceId === 'preseal-receipt')] = {
    expected: {
      byteLength: rootReceipt.bytes + payload.bytes,
      fileCount: 2,
      surfaceSha256: sha256Bytes(canonicalJsonBytes(tuples)),
    },
    sources: [{
      files: [path.basename(rootReceipt.logicalPath), path.basename(payload.logicalPath)].sort(),
      location: 'preseal',
      logicalPrefix: 'preseal',
      mode: 'files',
      relativeRoot: '',
    }],
    surfaceId: 'preseal-receipt',
  };
  await withTempDirectory('pc-cx004-command-count-', async (directory) => {
    for (const commandCount of [53, 55]) {
      const candidate = structuredClone(source);
      candidate.root.provenance.presealReceipt.commandCount = commandCount;
      bindPresealConfigProjection(candidate);
      const candidatePath = path.join(directory, `${commandCount}.json`);
      await writeFile(candidatePath, JSON.stringify(candidate));
      await assert.rejects(
        loadManifestConfig(candidatePath),
        /exact passed offline v2 command identity/u,
      );
    }
  });
});

test('verifier rejects an oversized root before decoding it', async () => {
  await withTempDirectory('pc-cx004-oversized-root-', async (directory) => {
    const rootPath = path.join(directory, ROOT_FILE_NAME);
    await writeFile(rootPath, Buffer.alloc(MAX_MANIFEST_BYTES + 1, 0x20));
    await assert.rejects(
      verifyManifestSet({ rootPath }),
      /byte length exceeds .* before read/u,
    );
  });
});

test('privacy failure occurs before a root manifest can be emitted', () => {
  assert.throws(() => buildManifestSet({
    manifestSetId: 'cx-004-test-privacy',
    rootMetadata: rootMetadata({ observations: [{ path: 'C:\\Users\\Alice\\secret' }] }),
    surfaces: [surface('surface', [tuple('surface/file.bin')])],
  }), /host-absolute Windows path/u);
});

test('host-toolchain sidecar privacy is enforced by producer and standalone verifier', async () => {
  const input = {
    manifestSetId: 'cx-004-test-host-sidecar-privacy',
    rootMetadata: rootMetadata({ hostToolchain: { note: 'PRIVATE_SENTINEL' } }),
    surfaces: [surface('surface', [tuple('surface/file.bin')])],
  };
  assert.throws(
    () => buildManifestSet(input, { forbiddenSubstrings: ['PRIVATE_SENTINEL'] }),
    /forbidden host\/profile substring/u,
  );
  await withTempDirectory('pc-cx004-host-sidecar-privacy-', async (directory) => {
    const set = buildManifestSet(input);
    await writeManifestSet(set, directory);
    await assert.rejects(
      verifyManifestSet({
        forbiddenSubstrings: ['PRIVATE_SENTINEL'],
        rootPath: path.join(directory, ROOT_FILE_NAME),
      }),
      /forbidden host\/profile substring/u,
    );
  });
});

test('tree enumeration rejects symbolic-link or junction traversal', async (t) => {
  await withTempDirectory('pc-cx004-reparse-', async (directory) => {
    const source = path.join(directory, 'source');
    const target = path.join(directory, 'target');
    await mkdir(source);
    await mkdir(target);
    await writeFile(path.join(target, 'outside.txt'), 'outside');
    try {
      await symlink(target, path.join(source, 'linked'), process.platform === 'win32' ? 'junction' : 'dir');
    } catch (error) {
      if (error?.code === 'EPERM' || error?.code === 'EACCES') {
        t.skip(`host cannot create a reparse fixture: ${error.code}`);
        return;
      }
      throw error;
    }
    const configPath = path.join(directory, 'config.json');
    await writeFile(configPath, JSON.stringify({
      schemaVersion: 'pc-sdk.cx-004.native-build-input-config.v1',
      manifestSetId: 'cx-004-test-reparse',
      output: { directory: path.join(directory, 'output') },
      root: rootMetadata(),
      surfaces: [{
        expected: { byteLength: 1, fileCount: 1, surfaceSha256: '0'.repeat(64) },
        surfaceId: 'source',
        sources: [{ logicalPrefix: 'source', mode: 'tree', root: source }],
      }],
    }));
    await assert.rejects(
      generateManifestSetFromConfig(configPath),
      /symbolic link or junction\/reparse traversal/u,
    );
  });
});

test('files enumeration rejects an intermediate junction even when it resolves inside the source root', async (t) => {
  await withTempDirectory('pc-cx004-intermediate-reparse-', async (directory) => {
    const source = path.join(directory, 'source');
    const target = path.join(source, 'target');
    await mkdir(source);
    await mkdir(target);
    await writeFile(path.join(target, 'sealed.bin'), 'sealed');
    try {
      await symlink(target, path.join(source, 'alias'), process.platform === 'win32' ? 'junction' : 'dir');
    } catch (error) {
      if (error?.code === 'EPERM' || error?.code === 'EACCES') {
        t.skip(`host cannot create a reparse fixture: ${error.code}`);
        return;
      }
      throw error;
    }
    const configPath = path.join(directory, 'config.json');
    await writeFile(configPath, JSON.stringify({
      schemaVersion: 'pc-sdk.cx-004.native-build-input-config.v1',
      manifestSetId: 'cx-004-test-intermediate-reparse',
      output: { directory: path.join(directory, 'output') },
      root: rootMetadata(),
      surfaces: [{
        expected: { byteLength: 6, fileCount: 1, surfaceSha256: '0'.repeat(64) },
        surfaceId: 'source',
        sources: [{
          files: ['alias/sealed.bin'],
          logicalPrefix: 'source',
          mode: 'files',
          root: source,
        }],
      }],
    }));
    await assert.rejects(
      generateManifestSetFromConfig(configPath),
      /symbolic link or junction\/reparse traversal/u,
    );
  });
});

test('tree enumeration rejects multiply linked regular files', async () => {
  await withTempDirectory('pc-cx004-hardlink-', async (directory) => {
    const source = path.join(directory, 'source');
    await mkdir(source);
    await writeFile(path.join(source, 'first.bin'), 'sealed bytes');
    await link(path.join(source, 'first.bin'), path.join(source, 'second.bin'));
    const configPath = path.join(directory, 'config.json');
    await writeFile(configPath, JSON.stringify({
      schemaVersion: 'pc-sdk.cx-004.native-build-input-config.v1',
      manifestSetId: 'cx-004-test-hardlink',
      output: { directory: path.join(directory, 'output') },
      root: rootMetadata(),
      surfaces: [{
        expected: { byteLength: 24, fileCount: 2, surfaceSha256: '0'.repeat(64) },
        surfaceId: 'source',
        sources: [{ logicalPrefix: 'source', mode: 'tree', root: source }],
      }],
    }));
    await assert.rejects(
      generateManifestSetFromConfig(configPath),
      /exactly one filesystem link/u,
    );
  });
});

test('pnpm content-addressed store tree admits only its exact positive-observed hardlink policy', async () => {
  await withTempDirectory('pc-cx004-pnpm-store-hardlink-', async (directory) => {
    const source = path.join(directory, 'source');
    await mkdir(source);
    await writeFile(path.join(source, 'first.bin'), 'sealed bytes');
    await link(path.join(source, 'first.bin'), path.join(source, 'second.bin'));
    const files = [
      tuple('pnpm-store/first.bin', 'sealed bytes'),
      tuple('pnpm-store/second.bin', 'sealed bytes'),
    ];
    const baseConfig = {
      schemaVersion: 'pc-sdk.cx-004.native-build-input-config.v1',
      manifestSetId: 'cx-004-test-pnpm-store-hardlink',
      output: { directory: path.join(directory, 'output') },
      root: rootMetadata(),
      surfaces: [{
        expected: {
          byteLength: 24,
          fileCount: 2,
          surfaceSha256: sha256Bytes(canonicalJsonBytes(files)),
        },
        surfaceId: 'pnpm-store-v10',
        sources: [{
          identityPolicy: { kind: 'pnpm-content-addressed-store-hardlink-v1' },
          logicalPrefix: 'pnpm-store',
          mode: 'tree',
          root: source,
        }],
      }],
    };
    const configPath = path.join(directory, 'config.json');
    await writeFile(configPath, JSON.stringify(baseConfig));
    const generated = await generateManifestSetFromConfig(configPath);
    assert.equal(
      JSON.parse(generated.manifestSet.rootBytes.toString('utf8')).manifestSetId,
      'cx-004-test-pnpm-store-hardlink',
    );

    const wrongSurface = structuredClone(baseConfig);
    wrongSurface.manifestSetId = 'cx-004-test-wrong-store-surface';
    wrongSurface.surfaces[0].surfaceId = 'not-pnpm-store';
    const wrongSurfacePath = path.join(directory, 'wrong-surface.json');
    await writeFile(wrongSurfacePath, JSON.stringify(wrongSurface));
    await assert.rejects(
      loadManifestConfig(wrongSurfacePath),
      /outside the exact pnpm-store-v10 tree authority/u,
    );

    const wrongMode = structuredClone(baseConfig);
    wrongMode.manifestSetId = 'cx-004-test-wrong-store-mode';
    wrongMode.surfaces[0].sources[0] = {
      files: ['first.bin'],
      identityPolicy: { kind: 'pnpm-content-addressed-store-hardlink-v1' },
      logicalPrefix: 'pnpm-store',
      mode: 'files',
      root: source,
    };
    const wrongModePath = path.join(directory, 'wrong-mode.json');
    await writeFile(wrongModePath, JSON.stringify(wrongMode));
    await assert.rejects(
      loadManifestConfig(wrongModePath),
      /outside the exact pnpm-store-v10 tree authority/u,
    );

    const expandedPolicy = structuredClone(baseConfig);
    expandedPolicy.manifestSetId = 'cx-004-test-expanded-store-policy';
    expandedPolicy.surfaces[0].sources[0].identityPolicy.linkCount = 0;
    const expandedPolicyPath = path.join(directory, 'expanded-policy.json');
    await writeFile(expandedPolicyPath, JSON.stringify(expandedPolicy));
    await assert.rejects(
      loadManifestConfig(expandedPolicyPath),
      /identityPolicy keys must be exactly \[kind\]/u,
    );
  });
});

test('files enumeration admits only an exact closed Windows servicing hardlink set', async () => {
  await withTempDirectory('pc-cx004-servicing-hardlink-', async (directory) => {
    const source = path.join(directory, 'source');
    await mkdir(source);
    await writeFile(path.join(source, 'primary.bin'), 'sealed bytes');
    await link(path.join(source, 'primary.bin'), path.join(source, 'servicing.bin'));
    const files = [
      tuple('system/primary.bin', 'sealed bytes'),
      tuple('system/servicing.bin', 'sealed bytes'),
    ];
    const configPath = path.join(directory, 'config.json');
    await writeFile(configPath, JSON.stringify({
      schemaVersion: 'pc-sdk.cx-004.native-build-input-config.v1',
      manifestSetId: 'cx-004-test-servicing-hardlink',
      output: { directory: path.join(directory, 'output') },
      root: rootMetadata(),
      surfaces: [{
        expected: {
          byteLength: 24,
          fileCount: 2,
          surfaceSha256: sha256Bytes(canonicalJsonBytes(files)),
        },
        surfaceId: 'system-tool',
        sources: [{
          files: ['primary.bin', 'servicing.bin'],
          identityPolicy: {
            kind: 'windows-servicing-hardlink-v1',
            linkCount: 2,
            relativePaths: ['primary.bin', 'servicing.bin'],
          },
          logicalPrefix: 'system',
          mode: 'files',
          root: source,
        }],
      }],
    }));
    const generated = await generateManifestSetFromConfig(configPath);
    assert.equal(
      JSON.parse(generated.manifestSet.rootBytes.toString('utf8')).manifestSetId,
      'cx-004-test-servicing-hardlink',
    );

    await writeFile(path.join(source, 'other.bin'), 'sealed bytes');
    await link(path.join(source, 'other.bin'), path.join(source, 'other-servicing.bin'));
    const mismatchedFiles = [
      tuple('system/other.bin', 'sealed bytes'),
      tuple('system/primary.bin', 'sealed bytes'),
    ];
    const mismatchedPath = path.join(directory, 'mismatched-config.json');
    await writeFile(mismatchedPath, JSON.stringify({
      schemaVersion: 'pc-sdk.cx-004.native-build-input-config.v1',
      manifestSetId: 'cx-004-test-mismatched-hardlinks',
      output: { directory: path.join(directory, 'mismatched-output') },
      root: rootMetadata(),
      surfaces: [{
        expected: {
          byteLength: 24,
          fileCount: 2,
          surfaceSha256: sha256Bytes(canonicalJsonBytes(mismatchedFiles)),
        },
        surfaceId: 'system-tool',
        sources: [{
          files: ['other.bin', 'primary.bin'],
          identityPolicy: {
            kind: 'windows-servicing-hardlink-v1',
            linkCount: 2,
            relativePaths: ['other.bin', 'primary.bin'],
          },
          logicalPrefix: 'system',
          mode: 'files',
          root: source,
        }],
      }],
    }));
    await assert.rejects(
      generateManifestSetFromConfig(mismatchedPath),
      /not aliases for one stable file identity/u,
    );
  });
});

test('LOCALAPPDATA location expansion is local-only and never serialized', {
  skip: !process.env.LOCALAPPDATA,
}, async () => {
  await withTempDirectory('pc-cx004-env-', async (directory) => {
    const configPath = path.join(directory, 'config.json');
    await writeFile(configPath, JSON.stringify({
      schemaVersion: 'pc-sdk.cx-004.native-build-input-config.v1',
      manifestSetId: 'cx-004-test-env-location',
      locations: { cache: '%LOCALAPPDATA%/PC-SDK-Next/toolchains/cx-004' },
      output: { directory: path.join(directory, 'output') },
      root: rootMetadata(),
      surfaces: [{
        expected: { byteLength: 1, fileCount: 1, surfaceSha256: '0'.repeat(64) },
        surfaceId: 'placeholder',
        sources: [{ files: ['file.bin'], location: 'cache', logicalPrefix: 'cache', mode: 'files', relativeRoot: '' }],
      }],
    }));
    const loaded = await loadManifestConfig(configPath);
    assert.ok(loaded.locations.cache.startsWith(path.resolve(process.env.LOCALAPPDATA)));
    assert.equal(JSON.stringify(loaded.config.root).includes(process.env.LOCALAPPDATA), false);
  });
});
