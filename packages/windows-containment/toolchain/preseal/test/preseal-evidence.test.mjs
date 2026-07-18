import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { constants as fsConstants } from "node:fs";
import { copyFile, link, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import {
  assertReceiptPrivate,
  atomicWriteVerified,
  buildClosedEnvironment,
  buildGitCommandPlan,
  buildPnpmCommandPlan,
  canonicalJsonBytes,
  createLogicalizer,
  normalizeCanonicalLf,
  packageResolutionProjection,
  parseCanonicalJsonBytes,
  parseFilesystemAuditReceipt,
  parseGpgStatus,
  parsePnpmProgress,
  runCommand,
  sha256,
  summarizeFilesystemAudit,
  toMsysPath,
  verifyFile,
} from "../preseal-evidence.mjs";
import { assertBootstrapRuntimeShape, SEALED_RUNNER } from "../runner-bootstrap.mjs";
import { prepareFilesystemAuditAuthority } from "../system-tool-authority.mjs";
import {
  PRESEAL_RECEIPT_BINDING_SENTINEL,
  presealConfigAuthorityProjection,
} from "../../preseal-config-projection.mjs";

const TEST_DIRECTORY = path.dirname(fileURLToPath(import.meta.url));
const TOOLCHAIN_DIRECTORY = path.resolve(TEST_DIRECTORY, "..", "..");
const REPO_ROOT = path.resolve(TOOLCHAIN_DIRECTORY, "..", "..", "..");
const CAPTURE_PATH = path.join(TOOLCHAIN_DIRECTORY, "preseal", "capture-preseal-evidence.mjs");
const INLINE_LAUNCHER_PATH = path.join(TOOLCHAIN_DIRECTORY, "preseal", "preseal-inline-launcher.mjs");
const AUTHENTICODE_PROBE_PATH = path.join(TOOLCHAIN_DIRECTORY, "preseal", "authenticode-probe.ps1");
const MANIFEST_SET_PATH = path.join(TOOLCHAIN_DIRECTORY, "manifest-set.mjs");
const AUDIT_WORKER_PATH = path.join(TOOLCHAIN_DIRECTORY, "native-build-input-filesystem-audit.ps1");
const AUDIT_CORE_PATH = path.join(TOOLCHAIN_DIRECTORY, "preseal", "filesystem-audit-core.psm1");

function runAuditWorkerFixture(plan) {
  const powershell = path.join(process.env.SystemRoot, "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
  const result = spawnSync(powershell, [
    "-NoLogo",
    "-NoProfile",
    "-NonInteractive",
    "-ExecutionPolicy",
    "Bypass",
    "-Command",
    "Import-Module $env:PC_AUDIT_CORE -Force; & $env:PC_AUDIT_WORKER -AuditPlanText ([Console]::In.ReadToEnd())",
  ], {
    encoding: "utf8",
    env: {
      SystemRoot: process.env.SystemRoot,
      PC_AUDIT_CORE: AUDIT_CORE_PATH,
      PC_AUDIT_WORKER: AUDIT_WORKER_PATH,
      TEMP: process.env.TEMP,
      TMP: process.env.TMP,
      WINDIR: process.env.WINDIR ?? process.env.SystemRoot,
    },
    input: JSON.stringify(plan),
    shell: false,
    windowsHide: true,
  });
  assert.equal(result.error, undefined);
  assert.equal(result.status, 0);
  assert.equal(result.stderr, "");
  return JSON.parse(result.stdout.trim());
}

test("canonical JSON is compact, ordinal, lossless for hostile keys, and integer-only", () => {
  const value = Object.create(null);
  value.z = [true, null, "line\nencoded"];
  value["2"] = "two";
  value["10"] = "ten";
  Object.defineProperty(value, "__proto__", { enumerable: true, value: { safe: 1 } });
  value.a = false;
  const bytes = canonicalJsonBytes(value);
  assert.equal(
    bytes.toString("utf8"),
    '{"10":"ten","2":"two","__proto__":{"safe":1},"a":false,"z":[true,null,"line\\nencoded"]}',
  );
  assert.equal(bytes.includes(0x0a), false);
  const parsed = parseCanonicalJsonBytes(bytes);
  assert.equal(Object.hasOwn(parsed, "__proto__"), true);
  assert.throws(() => canonicalJsonBytes({ bad: 1.5 }), /safe integers/u);
  assert.throws(() => parseCanonicalJsonBytes(Buffer.from('{"z":1,"a":2}')), /not canonical/u);
  assert.throws(() => parseCanonicalJsonBytes(Buffer.from([0xef, 0xbb, 0xbf, 0x7b, 0x7d])), /BOM/u);
});

test("preseal config projection excludes only the cyclic root and surface bindings", async () => {
  const configPath = path.join(TOOLCHAIN_DIRECTORY, "native-build-input.config.json");
  const config = JSON.parse(await readFile(configPath, "utf8"));
  const projected = presealConfigAuthorityProjection(config);
  assert.equal(
    projected.root.provenance.presealReceipt,
    PRESEAL_RECEIPT_BINDING_SENTINEL,
  );
  assert.equal(
    projected.surfaces.some((surface) => surface.surfaceId === "preseal-receipt"),
    false,
  );
  assert.notEqual(projected, config);
  assert.notEqual(config.root.provenance.presealReceipt, PRESEAL_RECEIPT_BINDING_SENTINEL);

  const receiptOnlyMutation = structuredClone(config);
  receiptOnlyMutation.root.provenance.presealReceipt = { replacement: true };
  const receiptSurface = receiptOnlyMutation.surfaces.find(
    (surface) => surface.surfaceId === "preseal-receipt",
  );
  receiptSurface.expected = { byteLength: 1, fileCount: 1, surfaceSha256: "0".repeat(64) };
  receiptSurface.sources = [];
  assert.deepEqual(
    presealConfigAuthorityProjection(receiptOnlyMutation),
    projected,
  );

  const authorityMutation = structuredClone(config);
  authorityMutation.manifestSetId = `${authorityMutation.manifestSetId}-changed`;
  assert.notDeepEqual(presealConfigAuthorityProjection(authorityMutation), projected);

  const duplicate = structuredClone(config);
  duplicate.surfaces.push(structuredClone(
    duplicate.surfaces.find((surface) => surface.surfaceId === "preseal-receipt"),
  ));
  assert.throws(
    () => presealConfigAuthorityProjection(duplicate),
    /exactly one preseal-receipt surface/u,
  );
});

test("canonical LF normalization is exact and rejects ambiguous text", () => {
  const normalized = normalizeCanonicalLf(Buffer.from("alpha\r\nbeta\r\n", "utf8"));
  assert.equal(normalized.bytes.toString("utf8"), "alpha\nbeta\n");
  assert.equal(normalized.lineFeeds, 2);
  assert.equal(normalized.terminalLf, true);
  assert.equal(normalized.sha256, sha256(Buffer.from("alpha\nbeta\n")));
  assert.throws(() => normalizeCanonicalLf(Buffer.from("alpha\rbeta")), /bare CR/u);
  assert.throws(() => normalizeCanonicalLf(Buffer.from([0xef, 0xbb, 0xbf, 0x61])), /BOM/u);
  assert.throws(() => normalizeCanonicalLf(Buffer.from([0xc3, 0x28])), /encoded data/u);
});

test("all config-declared workspace resolution projections reproduce exactly", async () => {
  const config = JSON.parse(await readFile(path.join(TOOLCHAIN_DIRECTORY, "native-build-input.config.json"), "utf8"));
  for (const [relativePath, bytes, digest, projectionBytes, projectionDigest] of config.root.packageResolution.workspaceManifests) {
    const normalized = normalizeCanonicalLf(await readFile(path.join(REPO_ROOT, ...relativePath.split("/"))));
    assert.equal(normalized.byteLength, bytes, relativePath);
    assert.equal(normalized.sha256, digest, relativePath);
    const projection = packageResolutionProjection(JSON.parse(normalized.bytes.toString("utf8")));
    assert.equal(projection.length, projectionBytes, relativePath);
    assert.equal(sha256(projection), projectionDigest, relativePath);
  }
});

test("receipt privacy rejects host paths, provider material, and secret-shaped values", () => {
  for (const unsafe of [
    "prefix C:\\Users\\alice\\work",
    "value=E:/Claude Code Projects/repo",
    "\\\\server\\share\\receipt.json",
    "CODEX_HOME",
    "ANTHROPIC_API_KEY",
    "Bearer abcdef",
    "token sk-abcdefghijklmnop",
  ]) {
    assert.throws(() => assertReceiptPrivate({ unsafe }), /forbidden/u, unsafe);
  }
  const safe = {
    command: ["--registry=http://127.0.0.1:9/", "<repo>/package.json"],
    envProjectionNames: ["HOME", "PATH"],
    receipt: "<cache>/preseal/receipt.json",
  };
  assert.doesNotThrow(() => assertReceiptPrivate(safe));
});

test("logical path replacement covers Windows and MSYS arguments without touching URLs", () => {
  const logicalize = createLogicalizer({
    "<cache>": "C:\\Users\\alice\\AppData\\Local\\PC-SDK-Next",
    "<repo>": "E:\\work\\pc-sdk-next",
  });
  assert.equal(logicalize("E:\\work\\pc-sdk-next\\package.json"), "<repo>/package.json");
  assert.equal(logicalize("/c/Users/alice/AppData/Local/PC-SDK-Next/object"), "<cache>/object");
  assert.equal(logicalize("http://127.0.0.1:9/"), "http://127.0.0.1:9/");
  assert.equal(toMsysPath("C:\\Program Files\\Git\\usr\\bin"), "/c/Program Files/Git/usr/bin");
  assert.throws(() => toMsysPath("\\\\server\\share"), /absolute drive path/u);
});

test("Git and pnpm plans are shell-free and use a closed non-provider environment", () => {
  const env = buildClosedEnvironment({
    kind: "pnpm",
    runRoot: "C:\\cache\\run",
    cacheRoot: "C:\\cache",
    systemRoot: "C:\\Windows",
    nodeRoot: "C:\\cache\\node",
    gitRoot: "C:\\Program Files\\Git",
  });
  assert.equal(Object.keys(env).some((name) => /CODEX|CLAUDE|ANTHROPIC|OPENAI/u.test(name)), false);
  assert.equal(env.HTTP_PROXY, "http://127.0.0.1:9");
  assert.equal(env.NPM_CONFIG_REGISTRY, "http://127.0.0.1:9/");
  assert.equal(env.CI, "true");
  const git = buildGitCommandPlan({
    gitExe: "C:\\Program Files\\Git\\cmd\\git.exe",
    repoRoot: "E:\\repo",
    args: ["rev-parse", "HEAD"],
    env,
  });
  assert.equal(git.shell, false);
  assert.deepEqual(git.args, [
    "--no-pager",
    "--no-replace-objects",
    "--no-lazy-fetch",
    "-C",
    "E:\\repo",
    "rev-parse",
    "HEAD",
  ]);
  const pnpm = buildPnpmCommandPlan({
    nodeExe: "C:\\cache\\node\\node.exe",
    pnpmCjs: "C:\\cache\\pnpm\\bin\\pnpm.cjs",
    workspaceRoot: "C:\\cache\\run\\workspace",
    storeParent: "C:\\cache\\store",
    env,
  });
  assert.equal(pnpm.shell, false);
  for (const required of ["--offline", "--frozen-lockfile", "--ignore-scripts", "--registry=http://127.0.0.1:9/"]) {
    assert.equal(pnpm.args.includes(required), true, required);
  }
  assert.deepEqual(pnpm.args.slice(pnpm.args.indexOf("--store-dir"), pnpm.args.indexOf("--store-dir") + 2), ["--store-dir", "C:\\cache\\store"]);
});

test("GnuPG and pnpm factual parsers select exact terminal evidence", () => {
  const gpg = parseGpgStatus(Buffer.from(
    "[GNUPG:] NEWSIG\n[GNUPG:] VALIDSIG 108F52B48DB57BB0CC439B2997B01419BD92F80A 2025-01-07 1736277387 0 4 0 1 8 00 108F52B48DB57BB0CC439B2997B01419BD92F80A\n",
  ));
  assert.equal(gpg.fingerprint, "108F52B48DB57BB0CC439B2997B01419BD92F80A");
  assert.equal(gpg.signatureDate, "2025-01-07");
  assert.equal(gpg.publicKeyAlgorithmId, 1);
  assert.equal(gpg.digestAlgorithmId, 8);
  const progress = parsePnpmProgress(Buffer.from(
    "Progress: resolved 10, reused 9, downloaded 0, added 2\nProgress: resolved 491, reused 491, downloaded 0, added 491\n",
  ));
  assert.deepEqual(progress, { added: 491, downloaded: 0, resolved: 491, reused: 491 });
  assert.throws(() => parseGpgStatus(Buffer.from("[GNUPG:] GOODSIG x y\n")), /exactly one VALIDSIG/u);
});

test("bootstrap runner guard rejects every preload and runtime identity escape", () => {
  const valid = {
    architecture: SEALED_RUNNER.architecture,
    execArgv: [],
    execPath: process.execPath,
    localAppData: process.env.LOCALAPPDATA,
    modules: SEALED_RUNNER.modules,
    napi: SEALED_RUNNER.napi,
    nodeOptions: undefined,
    nodePath: undefined,
    platform: SEALED_RUNNER.platform,
    version: SEALED_RUNNER.version,
  };
  assert.equal(assertBootstrapRuntimeShape(valid).toLowerCase(), process.execPath.toLowerCase());
  for (const mutation of [
    { execArgv: ["--require", "hostile.cjs"] },
    { nodeOptions: "--no-warnings" },
    { nodePath: "C:\\hostile" },
    { version: "22.13.1" },
    { modules: "128" },
    { napi: "10" },
    { architecture: "ia32" },
    { platform: "linux" },
    { execPath: "C:\\hostile\\node.exe" },
  ]) {
    assert.throws(() => assertBootstrapRuntimeShape({ ...valid, ...mutation }), /sealed runner bootstrap rejected/u);
  }
  const launcherSource = "export {};";
  const launcherSha256 = sha256(Buffer.from(launcherSource, "utf8"));
  const launchArgvSha256 = sha256(canonicalJsonBytes([
    "--input-type=module",
    "-e",
    `<inline-launcher:${launcherSha256}>`,
  ]));
  const inlineOptions = { launchArgvSha256, launcherSha256 };
  const inlineValid = {
    ...valid,
    argv: [process.execPath],
    execArgv: ["--input-type=module", "-e", launcherSource],
  };
  assert.equal(
    assertBootstrapRuntimeShape(inlineValid, inlineOptions).toLowerCase(),
    process.execPath.toLowerCase(),
  );
  for (const [runtimeMutation, optionMutation] of [
    [{ argv: [process.execPath, "extra"] }, {}],
    [{ execArgv: ["--import", "data:text/javascript,0", "-e", launcherSource] }, {}],
    [{ execArgv: ["--input-type=module", "-e", `${launcherSource} `] }, {}],
    [{}, { launcherSha256: "0".repeat(64) }],
    [{}, { launchArgvSha256: "0".repeat(64) }],
  ]) {
    assert.throws(
      () => assertBootstrapRuntimeShape(
        { ...inlineValid, ...runtimeMutation },
        { ...inlineOptions, ...optionMutation },
      ),
      /sealed runner bootstrap rejected/u,
    );
  }
});

test("capture requires the fixed launcher and rejects ordinary CLI and NODE_OPTIONS preload profiles", async () => {
  const source = await readFile(CAPTURE_PATH, "utf8");
  assert.ok(source.indexOf("const LAUNCH_CONTEXT") < source.indexOf("async function main()"));
  assert.ok(source.indexOf("validateSealedRunnerBeforeInputRead({") < source.indexOf("preparePresealCaptureAuthority()"));
  assert.match(source, /const runId = systemToolAuthority\.run\.runId;/u);
  assert.match(source, /\^\[0-9a-f\]\{32\}\$/u);
  const minimalEnv = {
    LOCALAPPDATA: process.env.LOCALAPPDATA,
    SystemRoot: process.env.SystemRoot,
    WINDIR: process.env.WINDIR ?? process.env.SystemRoot,
  };
  const directCapture = spawnSync(
    process.execPath,
    [CAPTURE_PATH],
    { encoding: "utf8", env: minimalEnv, shell: false, windowsHide: true },
  );
  assert.notEqual(directCapture.status, 0);
  assert.match(directCapture.stderr, /requires the fixed in-memory launch context/u);
  const launcherSource = await readFile(INLINE_LAUNCHER_PATH, "utf8");
  const cliPreload = spawnSync(
    process.execPath,
    ["--import", "data:text/javascript,0", "--input-type=module", "-e", launcherSource],
    { cwd: REPO_ROOT, encoding: "utf8", env: minimalEnv, shell: false, windowsHide: true },
  );
  assert.notEqual(cliPreload.status, 0);
  assert.match(cliPreload.stderr, /sealed runtime boundary was invalid/u);
  const envPreload = spawnSync(
    process.execPath,
    ["--input-type=module", "-e", launcherSource],
    {
      cwd: REPO_ROOT,
      encoding: "utf8",
      env: { ...minimalEnv, NODE_OPTIONS: "--no-warnings" },
      shell: false,
      windowsHide: true,
    },
  );
  assert.notEqual(envPreload.status, 0);
  assert.match(envPreload.stderr, /sealed runtime boundary was invalid/u);
});

test("hardened audit receipt parsing makes same-size content mutations visible", () => {
  const plan = {
    schemaVersion: "pc-sdk.cx-004.native-build-input-filesystem-audit-plan.v1",
    sources: [{
      files: [],
      logicalPrefix: "fixture",
      mode: "tree",
      rootPath: "C:\\fixture",
      sourceId: "fixture-00",
      sourceIndex: 0,
      surfaceId: "fixture",
    }],
  };
  const make = (digest) => Buffer.from(`${JSON.stringify({
    fileCount: 1,
    ok: true,
    schemaVersion: "pc-sdk.cx-004.native-build-input-filesystem-audit-receipt.v1",
    sources: [{ files: [["fixture/a.bin", 4, digest]], sourceId: "fixture-00", sourceIndex: 0, surfaceId: "fixture" }],
  })}\n`);
  const first = summarizeFilesystemAudit(parseFilesystemAuditReceipt(make("a".repeat(64)), plan));
  const second = summarizeFilesystemAudit(parseFilesystemAuditReceipt(make("b".repeat(64)), plan));
  assert.equal(first.byteLength, second.byteLength);
  assert.notEqual(first.surfaceSha256, second.surfaceSha256);
  assert.notDeepEqual(first.tuples, second.tuples);
  assert.throws(() => parseFilesystemAuditReceipt(Buffer.from(`${make("a".repeat(64)).toString()}junk\n`), plan));
});

test("production config pins full pnpm, GPG, PowerShell, and Python key authorities", async () => {
  const config = JSON.parse(await readFile(path.join(TOOLCHAIN_DIRECTORY, "native-build-input.config.json"), "utf8"));
  assert.equal(config.locations.system, "C:/Windows");
  assert.equal(config.root.hostToolchain.signatureVerificationClosure.files.length, 15);
  assert.deepEqual(config.root.hostToolchain.signatureVerificationClosure.systemImports, ["KERNEL32.dll", "ntdll.dll", "USER32.dll"]);
  const systemPolicy = config.root.hostToolchain.servicedSystemToolPolicy;
  assert.deepEqual(systemPolicy, {
    bootstrapExecution: "os-tcb-bootstrap-then-verified-single-link-copy",
    bootstrapSourceExecutionLimit: 1,
    ownedRootExitTimeoutMs: 25_000,
    passedReceiptBootstrapFailureCleanupUsed: false,
    privateCopyIdentity: "run-private-single-link-copy-v1",
    sourceIdentity: "windows-servicing-hardlink-v1",
    terminationInvocation: "taskkill-tree-force-v1",
    terminationToolTimeoutMs: 10_000,
  });
  for (const tool of [config.root.hostToolchain.authenticodeVerificationTool, config.root.hostToolchain.processTreeTerminationTool]) {
    assert.equal(tool.hardlinkCount, 2);
    assert.equal(tool.logicalPaths.length, 2);
    assert.match(tool.sha256, /^[0-9a-f]{64}$/u);
    assert.deepEqual(Object.keys(tool.authenticode).sort(), ["serial", "status", "subject", "thumbprint"]);
    assert.equal(Object.hasOwn(tool, "fileVersion"), false);
  }
  assert.equal(config.root.hostToolchain.authenticodeVerificationTool.embeddedFileVersion, "10.0.26100.8875");
  assert.equal(config.root.hostToolchain.processTreeTerminationTool.embeddedFileVersion, "10.0.26100.1");
  const pnpmSurface = config.surfaces.find((surface) => surface.surfaceId === "pnpm-distribution");
  assert.equal(pnpmSurface.expected.fileCount, 1077);
  const gpgSurface = config.surfaces.find((surface) => surface.surfaceId === "git-signature-verification-closure");
  assert.equal(gpgSurface.expected.fileCount, 15);
  const python = config.root.officialInputs.find((entry) => entry.id === "python-3.13.14-embed-amd64");
  assert.deepEqual(Object.keys(python.signatureVerification.releaseKey).sort(), ["bytes", "logicalPath", "sha256"]);
  assert.match(python.signatureVerification.releaseKey.logicalPath, /^cache\/objects\/sha256\/[0-9a-f]{64}\//u);
});

test("Authenticode probe binds the embedded PE version instead of the serviced display overlay", async () => {
  const source = await readFile(AUTHENTICODE_PROBE_PATH, "utf8");
  assert.match(source, /embeddedFileVersion = \$item\.VersionInfo\.FileVersionRaw\.ToString\(\)/u);
  assert.doesNotMatch(source, /VersionInfo\.FileVersion(?!Raw)/u);
  assert.doesNotMatch(source, /VersionInfo\.ProductVersion/u);
});

test("preseal producer and consumer share the expanded member bound and ordinal GPG import projection", async () => {
  const [captureSource, authoritySource, manifestSource] = await Promise.all([
    readFile(CAPTURE_PATH, "utf8"),
    readFile(path.join(TOOLCHAIN_DIRECTORY, "preseal", "system-tool-authority.mjs"), "utf8"),
    readFile(MANIFEST_SET_PATH, "utf8"),
  ]);
  assert.match(captureSource, /MAX_PRESEAL_PAYLOAD_MEMBERS/u);
  assert.match(authoritySource, /MAX_PRESEAL_PAYLOAD_MEMBERS/u);
  assert.match(manifestSource, /maxManifestMembers: MAX_PRESEAL_PAYLOAD_MEMBERS/u);
  assert.match(
    captureSource,
    /const declaredSystemImports = \[\.\.\.gpgAuthority\.systemImports\]\.sort\(ordinalCompare\)/u,
  );
  assert.match(
    manifestSource,
    /systemImports: \[\.\.\.authority\.systemImports\]\.sort\(ordinalCompare\)/u,
  );
});

test("atomic receipt publication is bounded, exclusive, flushed, and postverified", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "cx004-preseal-atomic-"));
  try {
    const finalPath = path.join(directory, "receipt.json");
    const temporaryPath = path.join(directory, ".receipt.tmp");
    const bytes = canonicalJsonBytes({ outcome: "passed" });
    const observed = await atomicWriteVerified(finalPath, temporaryPath, bytes, 1024);
    assert.deepEqual(observed, { bytes: bytes.length, sha256: sha256(bytes) });
    assert.deepEqual(await readFile(finalPath), bytes);
    await assert.rejects(
      atomicWriteVerified(finalPath, path.join(directory, ".second.tmp"), bytes, 1024),
      /EEXIST/u,
    );
    await assert.rejects(
      atomicWriteVerified(path.join(directory, "too-large.json"), path.join(directory, ".large.tmp"), Buffer.alloc(33), 32),
      /fixed byte bound/u,
    );
  } finally {
    await rm(directory, { force: true, recursive: true });
  }
});

test("system-file hardlink exception is explicit and preserves an exact replay identity", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "cx004-preseal-hardlink-"));
  try {
    const filePath = path.join(directory, "system-tool.exe");
    await writeFile(filePath, Buffer.from("pinned-system-tool", "utf8"));
    await link(filePath, path.join(directory, "servicing-alias.exe"));
    await assert.rejects(verifyFile(filePath, {}), /single-link/u);
    const initial = await verifyFile(filePath, {}, { requireSingleLink: false });
    const replay = await verifyFile(filePath, {}, { requireSingleLink: false });
    assert.equal(initial.identity.nlink, "2");
    assert.deepEqual(replay.identity, initial.identity);
    assert.deepEqual(replay.observed, initial.observed);
  } finally {
    await rm(directory, { force: true, recursive: true });
  }
});

test("bounded timeout cleanup uses an exact taskkill tree receipt and observes root close", { skip: process.platform !== "win32" }, async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "cx004-preseal-taskkill-"));
  try {
    const taskkill = path.join(directory, "taskkill.exe");
    await copyFile(path.join(process.env.SystemRoot, "System32", "taskkill.exe"), taskkill, fsConstants.COPYFILE_EXCL);
    const closedEnv = { SystemRoot: process.env.SystemRoot, WINDIR: process.env.SystemRoot };
    const result = await runCommand(
      {
        args: ["-e", "setInterval(() => {}, 1000)"],
        cwd: directory,
        env: closedEnv,
        executable: process.execPath,
        shell: false,
      },
      {
        ownedRootExitTimeoutMs: 5_000,
        terminationAuthority: {
          cwd: directory,
          env: closedEnv,
          executable: taskkill,
          executableId: "run-private-taskkill",
          policyId: "taskkill-tree-force-v1",
        },
        terminationToolTimeoutMs: 5_000,
        timeoutMs: 100,
      },
    );
    assert.equal(result.timedOut, true);
    assert.equal(result.cleanupOutcome, "proven");
    assert.equal(result.terminationReason, "timeout");
    assert.equal(result.terminationToolCompletionObserved, true);
    assert.equal(result.terminationToolExitCode, 0);
    assert.equal(result.terminationToolSignal, null);
    assert.equal(result.ownedRootExitObserved, true);
  } finally {
    await rm(directory, { force: true, maxRetries: 10, recursive: true, retryDelay: 100 });
  }
});

test("pnpm store hardlink policy is store-tree-only and retains hostile file guards", { skip: process.platform !== "win32" }, async (t) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "cx004-pnpm-hardlink-policy-"));
  const storeRoot = path.join(directory, "store");
  const outsideRoot = path.join(directory, "outside");
  await mkdir(storeRoot);
  await mkdir(outsideRoot);
  const first = path.join(storeRoot, "a.bin");
  const second = path.join(storeRoot, "b.bin");
  await writeFile(first, Buffer.from("content-addressed-store-fixture", "utf8"));
  await link(first, second);
  const source = {
    files: [],
    identityPolicy: { kind: "pnpm-content-addressed-store-hardlink-v1" },
    logicalPrefix: "pnpm-store/v10/files",
    mode: "tree",
    rootPath: storeRoot,
    sourceId: "pnpm-store-fixture",
    sourceIndex: 0,
    surfaceId: "pnpm-store-v10",
  };
  const plan = { schemaVersion: "pc-sdk.cx-004.native-build-input-filesystem-audit-plan.v1", sources: [source] };
  try {
    const passed = runAuditWorkerFixture(plan);
    assert.equal(passed.ok, true);
    assert.equal(passed.fileCount, 2);
    assert.deepEqual(passed.sources[0].files.map((tuple) => tuple[0]), [
      "pnpm-store/v10/files/a.bin",
      "pnpm-store/v10/files/b.bin",
    ]);
    for (const [mutation, expectedCode] of [
      [{ ...source, surfaceId: "not-pnpm-store" }, "invalid-identity-policy"],
      [{ ...source, files: ["a.bin", "b.bin"], mode: "files" }, "invalid-identity-policy"],
      [{ ...source, identityPolicy: { kind: source.identityPolicy.kind, linkCount: 0 } }, "invalid-plan-shape"],
    ]) {
      const rejected = runAuditWorkerFixture({ ...plan, sources: [mutation] });
      assert.equal(rejected.ok, false);
      assert.equal(rejected.code, expectedCode);
    }

    await writeFile(`${first}:hostile`, Buffer.from("ads", "utf8"));
    const adsRejected = runAuditWorkerFixture(plan);
    assert.equal(adsRejected.ok, false);
    assert.equal(adsRejected.code, "unexpected-alternate-stream");
    await rm(`${first}:hostile`, { force: true });

    try {
      await symlink(outsideRoot, path.join(storeRoot, "junction"), "junction");
      const reparseRejected = runAuditWorkerFixture(plan);
      assert.equal(reparseRejected.ok, false);
      assert.match(reparseRejected.code, /reparse/u);
    } catch (error) {
      if (error?.code === "EPERM") t.diagnostic("junction creation unavailable; production reparse guard remains source-asserted");
      else throw error;
    }

    const coreSource = await readFile(path.join(TOOLCHAIN_DIRECTORY, "preseal", "filesystem-audit-core.psm1"), "utf8");
    assert.match(coreSource, /\$information\.linkCount -lt 1/u);
    assert.match(coreSource, /expectedLinkCount = \[uint32\] \$information\.linkCount/u);
    assert.match(coreSource, /\$current\.linkCount -ne \$Session\.expectedLinkCount/u);
  } finally {
    await rm(directory, { force: true, recursive: true });
  }
});

test("authority-owned path policy rejects output overlap and admits its exact run topology", { skip: process.platform !== "win32" }, async () => {
  const authority = await prepareFilesystemAuditAuthority();
  const entry = (id, selectedPath, role, mustExist = false) => ({ id, mustExist, path: selectedPath, role });
  const receiptDirectory = authority.configContext.locations.preseal;
  const outputs = [
    entry("run-root", authority.run.runRoot, "output", true),
    entry("temp-root", authority.run.tempRoot, "output", true),
    entry("workspace-root", path.join(authority.run.runRoot, "workspace"), "output"),
    entry("gpg-runtime-root", path.join(authority.run.runRoot, "gpg-runtime", "usr", "bin"), "output"),
    entry("private-git-root", path.join(authority.run.runRoot, "git-runtime"), "output"),
    entry("git-exec-path", path.join(authority.run.runRoot, "git-exec-path-empty"), "output"),
  ];
  const receiptInput = entry("receipt-directory", receiptDirectory, "input", true);
  try {
    assert.equal(Object.isFrozen(authority.run), true);
    assert.equal(Object.isFrozen(authority.run.receipts), true);
    assert.equal(Object.isFrozen(authority.configContext), true);
    assert.equal(Object.isFrozen(authority.privateSystemToolSurface), true);
    await assert.rejects(authority.teardown(), /lacked positive finalized/u);
    await assert.rejects(authority.runNativeOperation("not-admitted"), /not admitted/u);
    const escapedStorePolicyPlan = {
      schemaVersion: "pc-sdk.cx-004.native-build-input-filesystem-audit-plan.v1",
      sources: [{
        files: [],
        identityPolicy: { kind: "pnpm-content-addressed-store-hardlink-v1" },
        logicalPrefix: "pnpm-store/v10/files",
        mode: "tree",
        rootPath: path.join(authority.run.runRoot, "system-tools"),
        sourceId: "escaped-pnpm-store-policy",
        sourceIndex: 0,
        surfaceId: "pnpm-store-v10",
      }],
    };
    await assert.rejects(authority.runAuditPlan(escapedStorePolicyPlan), /escaped its exact config-bound tree root/u);
    await assert.rejects(authority.runPathPolicyPlan({
      exclusions: [entry("excluded", authority.run.runRoot, "exclusion")],
      paths: [receiptInput, ...outputs],
      schemaVersion: "pc-sdk.cx-004.preseal-path-policy.v1",
    }), /overlapped an exclusion/u);
    await assert.rejects(authority.runPathPolicyPlan({
      exclusions: [],
      paths: [receiptInput, ...outputs.slice(0, -1)],
      schemaVersion: "pc-sdk.cx-004.preseal-path-policy.v1",
    }), /output-id closure was incomplete/u);
    const cacheRoot = authority.configContext.locations.cache;
    const receipt = await authority.runPathPolicyPlan({
      exclusions: [],
      paths: [
        entry("cache-root", cacheRoot, "input", true),
        receiptInput,
        ...outputs,
      ],
      schemaVersion: "pc-sdk.cx-004.preseal-path-policy.v1",
    });
    assert.equal(Object.isFrozen(receipt), true);
    assert.deepEqual(receipt.facts.map((fact) => fact.id), [
      "cache-root",
      "receipt-directory",
      ...outputs.map((output) => output.id),
      "payload-final",
      "payload-temporary",
      "root-final",
      "root-temporary",
    ]);
    const runtime = await authority.runNativeOperation("node-runtime-replay");
    assert.equal(runtime.exitCode, 0);
    await assert.rejects(authority.runNativeOperation("node-runtime-replay"), /already consumed/u);
    const auditPlan = {
      schemaVersion: "pc-sdk.cx-004.native-build-input-filesystem-audit-plan.v1",
      sources: [{
        files: [],
        logicalPrefix: "run-private/system-tools",
        mode: "tree",
        rootPath: path.join(authority.run.runRoot, "system-tools"),
        sourceId: "exclusive-operation-test",
        sourceIndex: 0,
        surfaceId: "private-system-tools",
      }],
    };
    const firstAudit = authority.runAuditPlan(auditPlan, { evidenceId: "exclusive-operation-test" });
    await assert.rejects(authority.runAuditPlan(auditPlan, { evidenceId: "exclusive-operation-second" }), /already in progress/u);
    await firstAudit;
    const finalized = await authority.finalize();
    assert.equal(Object.isFrozen(finalized), true);
    assert.equal(Object.isFrozen(finalized.commands), true);
    const teardown = await authority.teardown();
    assert.equal(Object.isFrozen(teardown), true);
    assert.equal(teardown.outcome, "removed");
  } finally {
    // Failed authority roots are deliberately preserved; the positive path above tears itself down.
  }
});
