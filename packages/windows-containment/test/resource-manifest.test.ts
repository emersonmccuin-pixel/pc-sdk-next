import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { link, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

import {
  parseResourceOwnershipManifest,
  parseResourceOwnershipManifestJson,
  ResourceOwnershipManifestParseError,
  type ResourceOwnershipManifest,
} from '../src/index.js';

const execFileAsync = promisify(execFile);
const toolUrl = new URL('../build/resource-manifest.mjs', import.meta.url).href;
const tool: {
  DEFAULT_GENERATED_RESOURCE_MANIFEST_HEADER_PATH: string;
  DEFAULT_RESOURCE_SITE_REGISTRY_PATH: string;
  ResourceManifestError: new (...arguments_: never[]) => Error & { code: string };
  assertNativeResourceSourceGuard(input: unknown): Readonly<{
    fileCount: number;
    markerCount: number;
    rawCallCount: number;
    siteCount: number;
  }>;
  buildArtifactResourceOwnershipManifest(registry: unknown, artifactId: unknown): unknown;
  checkGeneratedResourceManifestHeader(options?: unknown): Promise<unknown>;
  decodeEmbeddedResourceOwnershipManifestFrame(frame: Uint8Array): Readonly<{
    artifactId: string;
    digestHex: string;
    manifest: unknown;
    payloadBytes: Uint8Array;
  }>;
  encodeEmbeddedResourceOwnershipManifestFrame(manifest: unknown): Buffer;
  inspectNativeResourceSource(input: unknown): unknown;
  loadResourceSiteRegistry(path?: string): Promise<Record<string, unknown> & { sites: unknown[] }>;
  renderGeneratedResourceManifestHeader(registry: unknown): string;
  stableResourceSiteIdHex(siteId: string): string;
  validateResourceSiteRegistry(registry: unknown): unknown;
  writeGeneratedResourceManifestHeader(options?: unknown): Promise<unknown>;
} = await import(toolUrl);

function clone<T>(value: T): T {
  return structuredClone(value);
}

function isToolError(error: unknown): boolean {
  return error instanceof tool.ResourceManifestError;
}

function isParserError(error: unknown): boolean {
  return error instanceof ResourceOwnershipManifestParseError;
}

async function withTemporaryDirectory(
  callback: (directory: string) => Promise<void>,
): Promise<void> {
  const directory = await mkdtemp(path.join(tmpdir(), 'pc-sdk-cx004-resource-manifest-'));
  try {
    await callback(directory);
  } finally {
    await rm(directory, { force: true, recursive: true });
  }
}

test('sole registry produces exact artifact-selected manifests and stable site IDs', async () => {
  const registry = await tool.loadResourceSiteRegistry();
  const siteIds = registry.sites.map((site) => (site as { siteId: string }).siteId);
  assert.deepEqual(siteIds, [
    'qualification_borrowed_event',
    'qualification_owned_event',
    'qualification_owned_local_alloc',
    'qualification_pseudo_process',
  ]);

  const qualification = tool.buildArtifactResourceOwnershipManifest(
    registry,
    'qualification',
  );
  const parsed = parseResourceOwnershipManifest(qualification);
  assert.equal(parsed.artifactId, 'qualification');
  assert.equal(parsed.siteCount, 4);
  assert(Object.isFrozen(parsed));
  assert(Object.isFrozen(parsed.sites));
  assert(parsed.sites.every((site) => site.artifactId === 'qualification'));
  assert.equal(
    parsed.sites.find((site) => site.siteId === 'qualification_owned_event')?.acquisitionApi,
    'CreateEventExW',
  );
  assert.deepEqual(
    parsed.sites.find((site) => site.siteId === 'qualification_owned_event')?.rightsHeld,
    ['EVENT_MODIFY_STATE', 'SYNCHRONIZE'],
  );
  assert.equal(
    parsed.sites.find((site) => site.siteId === 'qualification_borrowed_event')?.ownerSiteId,
    'qualification_owned_event',
  );
  assert.equal(
    parsed.sites.find((site) => site.siteId === 'qualification_owned_local_alloc')
      ?.releaseCompletion,
    'null-return',
  );
  assert.equal(
    parsed.sites.find((site) => site.siteId === 'qualification_owned_local_alloc')
      ?.faultCanary.nonpositiveResult,
    'release-returned-nonpositive',
  );
  assert.equal(
    parsed.sites.find((site) => site.siteId === 'qualification_pseudo_process')?.ownership,
    'no-release',
  );

  for (const artifactId of ['addon', 'bootstrap'] as const) {
    const empty = parseResourceOwnershipManifest(
      tool.buildArtifactResourceOwnershipManifest(registry, artifactId),
    );
    assert.equal(empty.artifactId, artifactId);
    assert.equal(empty.siteCount, 0);
    assert.deepEqual(empty.sites, []);
  }

  const stableValues = siteIds.map((siteId) => tool.stableResourceSiteIdHex(siteId));
  assert(stableValues.every((value) => /^[0-9a-f]{16}$/u.test(value)));
  assert.equal(new Set(stableValues).size, stableValues.length);
  assert.deepEqual(
    stableValues,
    siteIds.map((siteId) => tool.stableResourceSiteIdHex(siteId)),
  );
});

test('generated header is deterministic, artifact-selected, and has no inline embedded object', async () => {
  const registry = await tool.loadResourceSiteRegistry();
  const expected = tool.renderGeneratedResourceManifestHeader(registry);
  const observed = await readFile(tool.DEFAULT_GENERATED_RESOURCE_MANIFEST_HEADER_PATH, 'utf8');
  assert.equal(observed, expected);
  assert.match(observed, /enum class ResourceSiteId : std::uint64_t/u);
  assert.match(observed, /ResourceOwnershipManifestSourceFrame\(\)/u);
  assert.match(observed, /quarantine_poison_process_creation = true/u);
  assert.doesNotMatch(observed, /ResourceOwnershipManifestFrame\(\) noexcept/u);
  assert.doesNotMatch(observed, /kEmbeddedResourceOwnershipManifest/u);
  assert.match(
    observed,
    /defined\(PCSDK_ARTIFACT_BOOTSTRAP\).*defined\(PCSDK_ARTIFACT_ADDON\).*defined\(PCSDK_ARTIFACT_QUALIFICATION\)/u,
  );
  await tool.checkGeneratedResourceManifestHeader();

  await withTemporaryDirectory(async (directory) => {
    const headerPath = path.join(directory, 'resource_manifest.generated.h');
    await tool.writeGeneratedResourceManifestHeader({
      headerPath,
      registryPath: tool.DEFAULT_RESOURCE_SITE_REGISTRY_PATH,
    });
    assert.equal(await readFile(headerPath, 'utf8'), expected);
  });
});

test('registry validator rejects malformed, ambiguous, lossy, and duplicated authority', async () => {
  const registry = await tool.loadResourceSiteRegistry();

  const extraKey = clone(registry) as Record<string, unknown>;
  extraKey.unregistered = true;
  assert.throws(() => tool.validateResourceSiteRegistry(extraKey), isToolError);

  const duplicateSite = clone(registry) as { sites: unknown[] };
  duplicateSite.sites.splice(1, 0, clone(duplicateSite.sites[0]));
  assert.throws(() => tool.validateResourceSiteRegistry(duplicateSite), isToolError);

  const duplicateFaultCanary = clone(registry) as {
    sites: Array<{ faultCanaryId: string }>;
  };
  duplicateFaultCanary.sites[1].faultCanaryId = duplicateFaultCanary.sites[0].faultCanaryId;
  assert.throws(() => tool.validateResourceSiteRegistry(duplicateFaultCanary), isToolError);

  const rightsEscape = clone(registry) as {
    sites: Array<{ rightsUsed: string[] }>;
  };
  rightsEscape.sites[0].rightsUsed = ['WRITE_DAC'];
  assert.throws(() => tool.validateResourceSiteRegistry(rightsEscape), isToolError);

  const abaDomainMismatch = clone(registry) as {
    sites: Array<{ abaCanary: unknown }>;
  };
  abaDomainMismatch.sites[1].abaCanary = clone(
    (abaDomainMismatch.sites[2] as { abaCanary: unknown }).abaCanary,
  );
  assert.throws(() => tool.validateResourceSiteRegistry(abaDomainMismatch), isToolError);

  const lossy = clone(registry) as { sites: Array<{ lastUse: string }> };
  lossy.sites[0].lastUse = '\ud800';
  assert.throws(() => tool.validateResourceSiteRegistry(lossy), isToolError);

  const customPrototype = clone(registry);
  Object.setPrototypeOf(customPrototype, { hostile: true });
  assert.throws(() => tool.validateResourceSiteRegistry(customPrototype), isToolError);

  const symbolExtra = clone(registry) as Record<PropertyKey, unknown>;
  symbolExtra[Symbol('hidden')] = true;
  assert.throws(() => tool.validateResourceSiteRegistry(symbolExtra), isToolError);

  let getterCalled = false;
  const accessor = clone(registry);
  Object.defineProperty(accessor, 'classification', {
    enumerable: true,
    get() {
      getterCalled = true;
      throw new Error('validator invoked hostile getter');
    },
  });
  assert.throws(() => tool.validateResourceSiteRegistry(accessor), isToolError);
  assert.equal(getterCalled, false);
});

test('registry loader rejects duplicate JSON keys and hardlink ambiguity', async (context) => {
  await withTemporaryDirectory(async (directory) => {
    const duplicatePath = path.join(directory, 'duplicate.json');
    await writeFile(
      duplicatePath,
      '{"artifactIds":[],"artifactIds":[],"classification":"x","schemaVersion":"x","sites":[]}',
      'utf8',
    );
    await assert.rejects(tool.loadResourceSiteRegistry(duplicatePath), isToolError);

    const ordinaryPath = path.join(directory, 'registry.json');
    const hardlinkPath = path.join(directory, 'registry-link.json');
    await writeFile(
      ordinaryPath,
      await readFile(tool.DEFAULT_RESOURCE_SITE_REGISTRY_PATH),
    );
    try {
      await link(ordinaryPath, hardlinkPath);
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code === 'EPERM' || code === 'EACCES' || code === 'ENOTSUP') {
        context.skip(`hardlinks unavailable: ${code}`);
        return;
      }
      throw error;
    }
    await assert.rejects(tool.loadResourceSiteRegistry(ordinaryPath), isToolError);
  });
});

test('binary frame binds magic, scalar artifact, length, canonical payload, and digest', async () => {
  const registry = await tool.loadResourceSiteRegistry();
  const manifest = tool.buildArtifactResourceOwnershipManifest(registry, 'qualification');
  const frame = tool.encodeEmbeddedResourceOwnershipManifestFrame(manifest);
  const decoded = tool.decodeEmbeddedResourceOwnershipManifestFrame(frame);
  assert.equal(decoded.artifactId, 'qualification');
  assert.equal(decoded.digestHex.length, 64);
  assert.deepEqual(parseResourceOwnershipManifest(decoded.manifest), manifest);
  assert.deepEqual(parseResourceOwnershipManifestJson(decoded.payloadBytes), manifest);

  const digestTamper = Buffer.from(frame);
  digestTamper[32] ^= 0x01;
  assert.throws(
    () => tool.decodeEmbeddedResourceOwnershipManifestFrame(digestTamper),
    isToolError,
  );

  const lengthTamper = Buffer.from(frame);
  lengthTamper.writeUInt32LE(128 * 1024 + 1, 24);
  assert.throws(
    () => tool.decodeEmbeddedResourceOwnershipManifestFrame(lengthTamper),
    isToolError,
  );

  const trailing = Buffer.concat([frame, Buffer.from([0])]);
  assert.throws(
    () => tool.decodeEmbeddedResourceOwnershipManifestFrame(trailing),
    isToolError,
  );
  assert.throws(
    () => tool.buildArtifactResourceOwnershipManifest(
      registry,
      ['bootstrap', 'addon'],
    ),
    isToolError,
  );
});

test('typed DTO parser rejects sparse, named, symbol, accessor, and artifact-union shapes', async () => {
  const registry = await tool.loadResourceSiteRegistry();
  const manifest = tool.buildArtifactResourceOwnershipManifest(
    registry,
    'qualification',
  ) as ResourceOwnershipManifest;

  const sparse = clone(manifest) as unknown as { siteCount: number; sites: unknown[] };
  sparse.sites = new Array(sparse.siteCount);
  assert.throws(() => parseResourceOwnershipManifest(sparse), isParserError);

  const named = clone(manifest) as unknown as { sites: unknown[] };
  Object.defineProperty(named.sites, 'extra', { enumerable: true, value: true });
  assert.throws(() => parseResourceOwnershipManifest(named), isParserError);

  const symbol = clone(manifest) as unknown as { sites: Record<PropertyKey, unknown> };
  symbol.sites[Symbol('hidden')] = true;
  assert.throws(() => parseResourceOwnershipManifest(symbol), isParserError);

  let getterCalled = false;
  const accessor = clone(manifest);
  Object.defineProperty(accessor, 'artifactId', {
    enumerable: true,
    get() {
      getterCalled = true;
      throw new Error('parser invoked hostile getter');
    },
  });
  assert.throws(() => parseResourceOwnershipManifest(accessor), isParserError);
  assert.equal(getterCalled, false);

  const union = clone(manifest) as unknown as {
    sites: Array<{ artifactId: string }>;
  };
  union.sites[0].artifactId = 'bootstrap';
  assert.throws(() => parseResourceOwnershipManifest(union), isParserError);

  const negativeZero = clone(manifest) as unknown as { siteCount: number };
  negativeZero.siteCount = -0;
  assert.throws(() => parseResourceOwnershipManifest(negativeZero), isParserError);

  const registryNegativeZero = clone(registry) as unknown as {
    sites: Array<{ abaCanary: { maxAttempts: number } }>;
  };
  registryNegativeZero.sites[0].abaCanary.maxAttempts = -0;
  assert.throws(
    () => tool.buildArtifactResourceOwnershipManifest(registryNegativeZero, 'qualification'),
    isToolError,
  );

  const manifestDomainMismatch = clone(manifest) as unknown as {
    sites: Array<{ abaCanary: unknown }>;
  };
  manifestDomainMismatch.sites[1].abaCanary = clone(
    manifestDomainMismatch.sites[2].abaCanary,
  );
  assert.throws(() => parseResourceOwnershipManifest(manifestDomainMismatch), isParserError);

  const oversized = clone(manifest) as unknown as {
    siteCount: number;
    sites: Array<Record<string, unknown>>;
  };
  const opaqueTemplate = clone(oversized.sites[2]);
  oversized.sites = Array.from({ length: 64 }, (_, index) => ({
    ...clone(opaqueTemplate),
    callsiteAnchor: `Oversized${index}`,
    faultCanaryId: `qualification_oversized_${String(index).padStart(2, '0')}_fault`,
    identitySlot: `qualification.oversized.${String(index).padStart(2, '0')}`,
    lastUse: 'l'.repeat(2_048),
    releaseOrder: 1_000 + index,
    releaseProof: 'r'.repeat(2_048),
    siteId: `qualification_oversized_${String(index).padStart(2, '0')}`,
    abaCanary: {
      ...(clone(opaqueTemplate.abaCanary) as Record<string, unknown>),
      proof: 'p'.repeat(2_048),
    },
  }));
  oversized.siteCount = oversized.sites.length;
  assert.throws(() => parseResourceOwnershipManifest(oversized), isParserError);
});

test('portable native guard closes markers and rejects raw or dynamic-resolution escapes', async () => {
  const registry = await tool.loadResourceSiteRegistry();
  const logicalPath = 'packages/windows-containment/native/core/resource.cc';
  const resourceBody = String.raw`
    void AcquireQualificationOwnedEvent() {
      PCSDK_RESOURCE_ACQUIRE(ResourceSiteId::qualification_owned_event, ::CreateEventExW(nullptr, nullptr, CREATE_EVENT_MANUAL_RESET, EVENT_MODIFY_STATE | SYNCHRONIZE));
    }
    void ReleaseQualificationOwnedEvent() {
      PCSDK_RESOURCE_RELEASE(ResourceSiteId::qualification_owned_event, ::CloseHandle(reinterpret_cast<HANDLE>(value)));
    }
    void BorrowQualificationEvent() {
      PCSDK_RESOURCE_BORROW(ResourceSiteId::qualification_borrowed_event, owned_event);
    }
    void AcquireQualificationOwnedLocalAlloc() {
      PCSDK_RESOURCE_ACQUIRE(ResourceSiteId::qualification_owned_local_alloc, ::LocalAlloc(LMEM_FIXED, bytes));
    }
    void ReleaseQualificationOwnedLocalAlloc() {
      PCSDK_RESOURCE_RELEASE(ResourceSiteId::qualification_owned_local_alloc, ::LocalFree(reinterpret_cast<HLOCAL>(value)));
    }
    void AcquireQualificationPseudoProcess() {
      PCSDK_RESOURCE_NO_RELEASE(ResourceSiteId::qualification_pseudo_process, ::GetCurrentProcess());
    }
    // GetProcAddress(LoadLibraryW(L"not-a-call"), "ignored");
    const char* ignored = R"fixture(CreateEventExW(ignored))fixture";
  `;
  const source = `#if defined(PCSDK_QUALIFICATION)\n${resourceBody}\n#endif`;
  const result = tool.assertNativeResourceSourceGuard({
    registry,
    sources: [{ logicalPath, source }],
  });
  assert.deepEqual(result, {
    fileCount: 1,
    markerCount: 6,
    rawCallCount: 5,
    siteCount: 4,
  });

  assert.throws(
    () => tool.inspectNativeResourceSource({
      logicalPath,
      registry,
      source: `${source}\nvoid Escape() { CreateEventExW(0, 0, 0, 0); }`,
    }),
    isToolError,
  );
  assert.throws(
    () => tool.inspectNativeResourceSource({
      logicalPath,
      registry,
      source: `${source}\nvoid Escape() { ::CreateEvent(nullptr, FALSE, FALSE, nullptr); }`,
    }),
    isToolError,
  );
  assert.throws(
    () => tool.inspectNativeResourceSource({
      logicalPath,
      registry,
      source: `${source}\nvoid Escape() { ::CreateEventA(nullptr, FALSE, FALSE, nullptr); }`,
    }),
    isToolError,
  );
  assert.throws(
    () => tool.inspectNativeResourceSource({
      logicalPath,
      registry,
      source: `${source}\nvoid Escape() { ::LoadLibrary(L"unsealed.dll"); }`,
    }),
    isToolError,
  );
  assert.throws(
    () => tool.inspectNativeResourceSource({
      logicalPath,
      registry,
      source: resourceBody,
    }),
    isToolError,
  );
  assert.throws(
    () => tool.inspectNativeResourceSource({
      logicalPath,
      registry,
      source: `${source}\n#if defined(PCSDK_QUALIFICATION)\nvoid WrongAnchor() {\n  if (AcquireQualificationOwnedEvent()) {\n    PCSDK_RESOURCE_ACQUIRE(ResourceSiteId::qualification_owned_event, ::CreateEventExW(nullptr, nullptr, CREATE_EVENT_MANUAL_RESET, EVENT_MODIFY_STATE | SYNCHRONIZE));\n  }\n}\n#endif`,
    }),
    isToolError,
  );
  assert.throws(
    () => tool.inspectNativeResourceSource({
      logicalPath,
      registry,
      source: `${source}\nvoid Escape() { GetProcAddress(module, "name"); }`,
    }),
    isToolError,
  );
  assert.throws(
    () => tool.inspectNativeResourceSource({
      logicalPath,
      registry,
      source: `#if 0\n${source}\n#endif`,
    }),
    isToolError,
  );
  assert.throws(
    () => tool.inspectNativeResourceSource({
      logicalPath,
      registry,
      source: `#if defined(_WIN32)\n#if !defined(_WIN32)\n${source}\n#endif\n#endif`,
    }),
    isToolError,
  );
  assert.throws(
    () => tool.assertNativeResourceSourceGuard({
      registry,
      sources: [{
        logicalPath,
        source: `#if defined(PCSDK_QUALIFICATION)\n#if defined(_WIN32)\n${source}\n#endif\n#endif`,
      }],
    }),
    isToolError,
  );
  assert.throws(
    () => tool.inspectNativeResourceSource({
      logicalPath,
      registry,
      source: `${source}\nvoid Escape() { auto create = &::CreateEventExW; static_cast<void>(create); }`,
    }),
    isToolError,
  );
  assert.throws(
    () => tool.inspectNativeResourceSource({
      logicalPath,
      registry,
      source: `${source}\nvoid Escape() { auto close = &::CloseHandle; static_cast<void>(close); }`,
    }),
    isToolError,
  );
  assert.throws(
    () => tool.inspectNativeResourceSource({
      logicalPath,
      registry,
      source: `${source}\nvoid Escape() { shim.CreateEventExW(nullptr, nullptr, 0, 0); }`,
    }),
    isToolError,
  );
  assert.throws(
    () => tool.inspectNativeResourceSource({
      logicalPath,
      registry,
      source: `${source}\nvoid Escape() { ::CreateEventEx${'\\'}\nW(nullptr, nullptr, 0, 0); }`,
    }),
    isToolError,
  );
  const directiveNoise = String.raw`
    const char* raw = R"fixture(
      #if 0
      #endif
    )fixture";
    /*
      #if defined(_WIN32)
      #endif
    */
  `;
  assert.doesNotThrow(() => tool.inspectNativeResourceSource({
    logicalPath,
    registry,
    source: `${directiveNoise}\n${source}`,
  }));
  assert.throws(
    () => tool.inspectNativeResourceSource({
      logicalPath,
      registry,
      source: `#include "../../../../unsealed.h"\n${source}`,
    }),
    isToolError,
  );
  assert.throws(
    () => tool.inspectNativeResourceSource({
      logicalPath,
      registry,
      source: `#define CALL_CREATE CreateEventExW\n${source}`,
    }),
    isToolError,
  );
  assert.throws(
    () => tool.inspectNativeResourceSource({
      logicalPath,
      registry,
      source: `${source}\nvoid Wrong() { PCSDK_RESOURCE_RELEASE(ResourceSiteId::qualification_owned_local_alloc, CloseHandle(handle)); }`,
    }),
    isToolError,
  );
  assert.throws(
    () => tool.assertNativeResourceSourceGuard({
      registry,
      sources: [{
        logicalPath,
        source: source.replace(
          'EVENT_MODIFY_STATE | SYNCHRONIZE',
          'SYNCHRONIZE',
        ),
      }],
    }),
    isToolError,
  );
  assert.throws(
    () => tool.assertNativeResourceSourceGuard({
      registry,
      sources: [{
        logicalPath,
        source: source.replace(
          '::CreateEventExW(nullptr, nullptr,',
          '::CreateEventExW(&attributes, nullptr,',
        ),
      }],
    }),
    isToolError,
  );
});

test('stable --check CLI verifies deterministic header and full native source closure', async () => {
  const scriptPath = new URL('../build/resource-manifest.mjs', import.meta.url);
  const { stdout, stderr } = await execFileAsync(
    process.execPath,
    [fileURLToPath(scriptPath), '--check'],
    { cwd: fileURLToPath(new URL('..', import.meta.url)) },
  );
  assert.equal(stderr, '');
  const receipt = JSON.parse(stdout) as {
    action: string;
    result: {
      sourceGuard: {
        fileCount: number;
        markerCount: number;
        rawCallCount: number;
        siteCount: number;
      };
    };
  };
  assert.equal(receipt.action, 'resource-manifest-checked');
  assert.deepEqual(receipt.result.sourceGuard, {
    fileCount: 10,
    markerCount: 11,
    rawCallCount: 5,
    siteCount: 4,
  });
});
