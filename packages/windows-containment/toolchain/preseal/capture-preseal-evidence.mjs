#!/usr/bin/env node

import { createHash, createPublicKey, verify as verifySignature } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";
import { isDeepStrictEqual } from "node:util";
import {
  assertReceiptPrivate,
  buildClosedEnvironment,
  buildGitCommandPlan,
  cacheKeyToPath,
  canonicalJsonBytes,
  countImmediateDirectories,
  createLogicalizer,
  normalizeCanonicalLf,
  packageResolutionProjection,
  parseGpgFingerprints,
  parseGpgStatus,
  parsePnpmProgress,
  sha256,
  summarizeFilesystemAudit,
  surfaceRoot,
  verifyFile,
} from "./preseal-evidence.mjs";
import {
  assertNoReparseExistingPath,
  validateSealedRunnerBeforeInputRead,
} from "./runner-bootstrap.mjs";
import { preparePresealCaptureAuthority } from "./system-tool-authority.mjs";
import {
  countPresealPayloadMembers,
  MAX_PRESEAL_PAYLOAD_MEMBERS,
  PRESEAL_CONFIG_AUTHORITY_PROJECTION_ALGORITHM,
  presealConfigAuthorityProjection,
} from "../preseal-config-projection.mjs";
import {
  CX004_PRESEAL_GIT_TRACE_COUNT,
  presealRepositoryChainAuthorities,
} from "../manifest-set.mjs";

const LAUNCH_CONTEXT = globalThis.__PC_SDK_PRESEAL_LAUNCH_CONTEXT__;
if (LAUNCH_CONTEXT === null || typeof LAUNCH_CONTEXT !== "object" || Array.isArray(LAUNCH_CONTEXT)) {
  throw new Error("preseal capture requires the fixed in-memory launch context");
}
const TOOLCHAIN_DIRECTORY = path.join(
  LAUNCH_CONTEXT.sourceRoot,
  "packages",
  "windows-containment",
  "toolchain",
);
const CONFIG_PATH = path.join(TOOLCHAIN_DIRECTORY, "native-build-input.config.json");
const AUDIT_PLAN_SCHEMA = "pc-sdk.cx-004.native-build-input-filesystem-audit-plan.v1";
const PAYLOAD_SCHEMA = "pc-sdk.cx-004.preseal-evidence-payload.v2";
const ROOT_SCHEMA = "pc-sdk.cx-004.preseal-evidence-root.v2";
const MAX_PAYLOAD_BYTES = 256 * 1024;
const MAX_ROOT_BYTES = 16 * 1024;

function requireEqual(actual, expected, label) {
  if (actual !== expected) throw new Error(`${label} mismatch`);
}

function requireArrayEqual(actual, expected, label) {
  if (!Array.isArray(actual) || !Array.isArray(expected) || actual.length !== expected.length) {
    throw new Error(`${label} mismatch`);
  }
  for (let index = 0; index < expected.length; index += 1) {
    if (actual[index] !== expected[index]) throw new Error(`${label} mismatch`);
  }
}

function requiredEntry(entries, predicate, label) {
  const matches = entries.filter(predicate);
  if (matches.length !== 1) throw new Error(`expected exactly one ${label}, observed ${matches.length}`);
  return matches[0];
}

function decodeJson(bytes, label) {
  const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  try {
    return JSON.parse(text);
  } catch {
    throw new Error(`${label} is not valid UTF-8 JSON`);
  }
}

function ordinalCompare(left, right) {
  return left < right ? -1 : left > right ? 1 : 0;
}

function assertSurfaceExpected(surface, summary, label) {
  requireEqual(summary.fileCount, surface.expected.fileCount, `${label} file count`);
  requireEqual(summary.byteLength, surface.expected.byteLength, `${label} byte length`);
  requireEqual(summary.surfaceSha256, surface.expected.surfaceSha256, `${label} surface SHA-256`);
}

function localDrivePaths(values) {
  const unique = new Map();
  for (const value of values) {
    if (typeof value !== "string" || value.length === 0) continue;
    const absolute = path.resolve(value);
    if (!/^[A-Za-z]:[\\/]/u.test(absolute) || absolute.startsWith("\\\\")) continue;
    unique.set(absolute.toLowerCase(), absolute);
  }
  return [...unique.values()];
}

function actualPathForLogical(logicalPath, roots) {
  if (logicalPath.startsWith("cache/")) return path.join(roots.cache, ...logicalPath.slice(6).split("/"));
  if (logicalPath.startsWith("git/")) return path.join(roots.git, ...logicalPath.slice(4).split("/"));
  if (logicalPath.startsWith("windows/")) return path.join(roots.system, ...logicalPath.slice(8).split("/"));
  throw new Error("logical path does not select an admitted root");
}

function tupleForExactFact(summary, logicalPath, bytes, digest, label) {
  const matches = summary.tuples.filter((tuple) => tuple[0] === logicalPath && tuple[1] === bytes && tuple[2] === digest);
  if (matches.length !== 1) throw new Error(`${label} was not exactly bound to the hardened surface closure`);
  return matches[0];
}

function assertCompactCanonical(value, maximum, label, maximumMembers) {
  const bytes = canonicalJsonBytes(value);
  if (bytes.length === 0 || bytes.length > maximum) throw new Error(`${label} exceeded its fixed canonical byte bound`);
  if (maximumMembers !== undefined && countPresealPayloadMembers(value) > maximumMembers) {
    throw new Error(`${label} exceeded its fixed recursive member bound`);
  }
  return bytes;
}

function parseGitTrace2(bytes, plan, builtin, logicalizeArgv) {
  const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  const lines = text.split(/\r?\n/u).filter((line) => line.length !== 0);
  if (lines.length < 5 || text.includes("\r") && !text.includes("\r\n")) {
    throw new Error(`Git ${builtin} Trace2 evidence was incomplete`);
  }
  const events = lines.map((line) => {
    const event = JSON.parse(line);
    if (event === null || typeof event !== "object" || Array.isArray(event) || typeof event.event !== "string") {
      throw new Error(`Git ${builtin} Trace2 event shape mismatch`);
    }
    return event;
  });
  const starts = events.filter((event) => event.event === "start");
  const commandNames = events.filter((event) => event.event === "cmd_name");
  const exits = events.filter((event) => event.event === "exit");
  const childEvents = events.filter((event) => event.event.startsWith("child_"));
  if (
    starts.length !== 1 ||
    commandNames.length !== 1 ||
    exits.length !== 1 ||
    childEvents.length !== 0 ||
    commandNames[0].name !== builtin ||
    exits[0].code !== 0 ||
    !Array.isArray(starts[0].argv) ||
    starts[0].argv.length !== plan.args.length + 1 ||
    path.resolve(starts[0].argv[0]).toLowerCase() !== path.resolve(plan.executable).toLowerCase() ||
    !isDeepStrictEqual(starts[0].argv.slice(1), plan.args)
  ) {
    throw new Error(`Git ${builtin} Trace2 command/descendant evidence mismatch`);
  }
  return {
    argvSha256: sha256(canonicalJsonBytes(starts[0].argv.slice(1).map((entry) => logicalizeArgv(entry)))),
    builtin,
    childEventCount: 0,
    eventCount: events.length,
  };
}

async function copyStableExclusiveFile(sourcePath, destinationPath, expected, expectedSourceLinks) {
  await assertNoReparseExistingPath(sourcePath, `private-copy source ${path.basename(sourcePath)}`);
  if (!Number.isSafeInteger(expectedSourceLinks) || expectedSourceLinks < 1) {
    throw new Error("private-copy source link authority mismatch");
  }
  const source = await fs.open(sourcePath, "r");
  let destination;
  try {
    const initial = await source.stat({ bigint: true });
    if (!initial.isFile() || initial.nlink !== BigInt(expectedSourceLinks) || initial.size !== BigInt(expected.bytes)) {
      throw new Error("private-copy source identity mismatch");
    }
    const hashPass = async () => {
      const digest = createHash("sha256");
      const buffer = Buffer.allocUnsafe(1024 * 1024);
      let position = 0;
      while (position < expected.bytes) {
        const length = Math.min(buffer.length, expected.bytes - position);
        const { bytesRead } = await source.read(buffer, 0, length, position);
        if (bytesRead !== length) throw new Error("private-copy source became truncated");
        digest.update(buffer.subarray(0, bytesRead));
        position += bytesRead;
      }
      return digest.digest("hex");
    };
    const beforeHash = await hashPass();
    if (beforeHash !== expected.sha256) throw new Error("private-copy source SHA-256 mismatch");
    destination = await fs.open(destinationPath, "wx");
    const buffer = Buffer.allocUnsafe(1024 * 1024);
    let position = 0;
    while (position < expected.bytes) {
      const length = Math.min(buffer.length, expected.bytes - position);
      const { bytesRead } = await source.read(buffer, 0, length, position);
      if (bytesRead !== length) throw new Error("private-copy source changed during copy");
      let written = 0;
      while (written < bytesRead) {
        const result = await destination.write(buffer, written, bytesRead - written, position + written);
        if (result.bytesWritten < 1) throw new Error("private-copy destination write made no progress");
        written += result.bytesWritten;
      }
      position += bytesRead;
    }
    await destination.sync();
    await destination.close();
    destination = undefined;
    const afterHash = await hashPass();
    const final = await source.stat({ bigint: true });
    if (
      afterHash !== beforeHash ||
      initial.dev !== final.dev ||
      initial.ino !== final.ino ||
      initial.size !== final.size ||
      initial.mtimeNs !== final.mtimeNs ||
      initial.nlink !== final.nlink
    ) {
      throw new Error("private-copy source identity changed during retained-handle copy");
    }
  } finally {
    if (destination !== undefined) await destination.close().catch(() => {});
    await source.close();
  }
  return await verifyFile(destinationPath, expected);
}

async function main() {
  const bootstrapRuntime = await validateSealedRunnerBeforeInputRead({
    launchArgvSha256: LAUNCH_CONTEXT.launchArgvSha256,
    launcherSha256: LAUNCH_CONTEXT.launcherBinding?.tuple?.[2],
  });

  const systemToolAuthority = await preparePresealCaptureAuthority();
  const configBytes = systemToolAuthority.configBytes;
  const config = decodeJson(configBytes, "native build input config");
  requireEqual(
    isDeepStrictEqual(config, systemToolAuthority.configContext.config),
    true,
    "authority-held config snapshot",
  );
  requireEqual(config.locations.cache.env, "LOCALAPPDATA", "cache environment selector");
  requireEqual(config.locations.preseal.env, "LOCALAPPDATA", "preseal environment selector");
  requireEqual(config.locations.system.replaceAll("\\", "/"), "C:/Windows", "fixed system root authority");
  const localAppData = process.env.LOCALAPPDATA;
  const ambientSystemRoot = process.env.SystemRoot ?? process.env.WINDIR;
  if (!localAppData || !ambientSystemRoot) throw new Error("required Windows roots are unavailable");

  const cacheRoot = path.resolve(localAppData, ...config.locations.cache.relativeRoot.split("/"));
  const receiptDirectory = path.resolve(localAppData, ...config.locations.preseal.relativeRoot.split("/"));
  const repoRoot = path.resolve(TOOLCHAIN_DIRECTORY, config.locations.repo);
  const gitRoot = path.resolve(config.locations.git);
  const systemRoot = path.resolve(config.locations.system);
  requireEqual(path.resolve(ambientSystemRoot).toLowerCase(), systemRoot.toLowerCase(), "ambient SystemRoot");
  requireEqual(receiptDirectory.toLowerCase(), path.join(cacheRoot, "preseal", "receipts").toLowerCase(), "preseal receipt root");

  const nodeRoot = surfaceRoot(cacheRoot, config, "node-distribution");
  const pnpmRoot = surfaceRoot(cacheRoot, config, "pnpm-distribution");
  const pythonRoot = surfaceRoot(cacheRoot, config, "python-embed");
  const officialObjectsRoot = surfaceRoot(cacheRoot, config, "official-object-inputs");
  const nodeExe = path.join(nodeRoot, "node.exe");
  const pnpmCjs = path.join(pnpmRoot, "bin", "pnpm.cjs");
  const pythonExe = path.join(pythonRoot, "python.exe");
  const hostToolchain = config.root.hostToolchain;
  const servicedPolicy = hostToolchain.servicedSystemToolPolicy;
  requireArrayEqual(Object.keys(servicedPolicy).sort(ordinalCompare), [
    "bootstrapExecution",
    "bootstrapSourceExecutionLimit",
    "ownedRootExitTimeoutMs",
    "passedReceiptBootstrapFailureCleanupUsed",
    "privateCopyIdentity",
    "sourceIdentity",
    "terminationInvocation",
    "terminationToolTimeoutMs",
  ], "serviced system tool policy shape");
  requireEqual(servicedPolicy.bootstrapExecution, "os-tcb-bootstrap-then-verified-single-link-copy", "system tool bootstrap policy");
  requireEqual(servicedPolicy.bootstrapSourceExecutionLimit, 1, "source PowerShell execution limit");
  requireEqual(servicedPolicy.passedReceiptBootstrapFailureCleanupUsed, false, "passed bootstrap failure cleanup policy");
  requireEqual(servicedPolicy.privateCopyIdentity, "run-private-single-link-copy-v1", "private system tool copy policy");
  requireEqual(servicedPolicy.sourceIdentity, "windows-servicing-hardlink-v1", "serviced source identity policy");
  requireEqual(servicedPolicy.terminationInvocation, "taskkill-tree-force-v1", "tree termination invocation policy");

  const powershellPin = hostToolchain.authenticodeVerificationTool;
  const taskkillPin = hostToolchain.processTreeTerminationTool;
  requireEqual(powershellPin.executionMode, "bootstrap-source-once-then-private-copy", "PowerShell execution mode");
  requireEqual(taskkillPin.executionMode, "private-copy-with-bootstrap-failure-only-source", "taskkill execution mode");

  const nodeInput = requiredEntry(config.root.officialInputs, (entry) => entry.id === "node-v22.13.0-win-x64", "Node official input");
  const llvmInput = requiredEntry(config.root.officialInputs, (entry) => entry.id === "llvm-19.1.7-windows-msvc", "LLVM official input");
  const pythonInput = requiredEntry(config.root.officialInputs, (entry) => entry.id === "python-3.13.14-embed-amd64", "Python official input");
  const pnpmInput = requiredEntry(config.root.officialInputs, (entry) => entry.id === "pnpm-10.33.0", "pnpm official input");
  requireEqual(path.resolve(process.execPath).toLowerCase(), path.resolve(nodeExe).toLowerCase(), "config-bound running Node path");
  requireEqual(nodeInput.nodeExe.sha256, bootstrapRuntime.sha256, "config-bound running Node hash");
  requireEqual(nodeInput.nodeExe.bytes, bootstrapRuntime.bytes, "config-bound running Node bytes");

  const runId = systemToolAuthority.run.runId;
  if (!/^[0-9a-f]{32}$/u.test(runId)) throw new Error("generated run identifier shape mismatch");
  const runRoot = systemToolAuthority.run.runRoot;
  const workspaceRoot = path.join(runRoot, "workspace");
  const gpgRuntimeRoot = path.join(runRoot, "gpg-runtime", "usr", "bin");
  const privateGitRoot = path.join(runRoot, "git-runtime");
  const gitExecPath = path.join(runRoot, "git-exec-path-empty");
  const gitExe = path.join(privateGitRoot, "git.exe");
  const payloadLogicalPath = systemToolAuthority.run.receipts.payloadLogicalPath;
  const receiptLogicalPath = systemToolAuthority.run.receipts.rootLogicalPath;
  const logicalize = createLogicalizer({
    "<gpg-runtime>": gpgRuntimeRoot,
    "<private-git>": privateGitRoot,
    "<git-exec-path>": gitExecPath,
    "<run>": runRoot,
    "<repo>": repoRoot,
    "<cache>": cacheRoot,
    "<git>": gitRoot,
    "<system>": systemRoot,
  });
  const logicalizeAuthorityNativeValue = createLogicalizer({
    "<run>": runRoot,
    "<repo>": repoRoot,
    "<cache>": cacheRoot,
    "<git>": gitRoot,
    "<system>": systemRoot,
  });

  for (const [candidate, label] of [
    [CONFIG_PATH, "config"],
    [repoRoot, "repository"],
    [cacheRoot, "cache"],
    [gitRoot, "Git root"],
    [systemRoot, "system root"],
  ]) {
    await assertNoReparseExistingPath(candidate, label);
  }

  async function execute(operationId) {
    return await systemToolAuthority.runNativeOperation(operationId);
  }
  const providerExclusions = localDrivePaths([
    process.env.CODEX_HOME,
    process.env.CLAUDE_CONFIG_DIR,
    process.env.USERPROFILE ? path.join(process.env.USERPROFILE, ".codex") : undefined,
    process.env.USERPROFILE ? path.join(process.env.USERPROFILE, ".claude") : undefined,
    path.join(path.dirname(repoRoot), "PC-SDK"),
    path.join(path.dirname(repoRoot), "PC-SDK-Next"),
    repoRoot,
  ]);
  async function runPathPolicy(phase) {
    const receipt = await systemToolAuthority.runCapturePathPolicyPhase(phase);
    return receipt.facts;
  }

  const pathPolicyFacts = { prestage: await runPathPolicy("prestage") };
  for (const directory of [
    workspaceRoot,
    path.join(runRoot, "gpg-runtime"),
    path.join(runRoot, "gpg-runtime", "usr"),
    gpgRuntimeRoot,
    privateGitRoot,
    gitExecPath,
    path.join(runRoot, "home"),
  ]) await fs.mkdir(directory);

  const gitEnv = buildClosedEnvironment({
    kind: "git",
    runRoot,
    systemRoot,
    nodeRoot,
    gitRoot,
    privateGitRoot,
    gitExecPath,
  });
  pathPolicyFacts.postcreate = await runPathPolicy("postcreate");

  const executableFacts = [
    { bytes: bootstrapRuntime.bytes, id: "node", logicalPath: logicalize(nodeExe), sha256: bootstrapRuntime.sha256 },
    { bytes: powershellPin.bytes, id: "powershell-source", logicalPath: powershellPin.logicalPaths[0], sha256: powershellPin.sha256 },
    { bytes: taskkillPin.bytes, id: "taskkill-source", logicalPath: taskkillPin.logicalPaths[0], sha256: taskkillPin.sha256 },
    { bytes: powershellPin.bytes, id: "powershell-private", logicalPath: `<private-tools>/${powershellPin.privateCopyFileName}`, sha256: powershellPin.sha256 },
    { bytes: taskkillPin.bytes, id: "taskkill-private", logicalPath: `<private-tools>/${taskkillPin.privateCopyFileName}`, sha256: taskkillPin.sha256 },
  ];
  async function executableFact(id, executablePath, expected = {}) {
    const verified = await verifyFile(executablePath, expected);
    const fact = { bytes: verified.observed.bytes, id, logicalPath: logicalize(executablePath), sha256: verified.observed.sha256 };
    executableFacts.push(fact);
    return fact;
  }

  const locationRoots = { cache: cacheRoot, git: gitRoot, system: systemRoot };
  function buildSurfaceAuditPlan(surfaceId, phase) {
    const surface = requiredEntry(config.surfaces, (entry) => entry.surfaceId === surfaceId, `${surfaceId} surface`);
    const sources = surface.sources.map((source, sourceIndex) => {
      const locationRoot = locationRoots[source.location];
      if (locationRoot === undefined) throw new Error(`${surfaceId} uses an inadmissible audit location`);
      return {
        files: source.mode === "files" ? [...source.files] : [],
        ...(Object.hasOwn(source, "identityPolicy") ? {
          identityPolicy: source.identityPolicy.kind === "pnpm-content-addressed-store-hardlink-v1"
            ? { kind: source.identityPolicy.kind }
            : {
              kind: source.identityPolicy.kind,
              linkCount: source.identityPolicy.linkCount,
              relativePaths: [...source.identityPolicy.relativePaths],
            },
        } : {}),
        logicalPrefix: source.logicalPrefix,
        mode: source.mode,
        rootPath: source.relativeRoot === "" ? locationRoot : path.join(locationRoot, ...source.relativeRoot.split("/")),
        sourceId: `${phase}-${String(sourceIndex).padStart(2, "0")}`,
        sourceIndex,
        surfaceId,
      };
    });
    return { plan: { schemaVersion: AUDIT_PLAN_SCHEMA, sources }, surface };
  }

  async function runHardenedAudit(plan, evidenceId, timeoutMs = 30 * 60_000) {
    try {
      return await systemToolAuthority.runAuditPlan(plan, { evidenceId, timeoutMs });
    } catch (error) {
      throw new Error(`${evidenceId} hardened audit failed: ${error instanceof Error ? error.message : "unknown audit failure"}`);
    }
  }

  async function auditSurface(surfaceId, phase, timeoutMs) {
    const { plan, surface } = buildSurfaceAuditPlan(surfaceId, phase);
    const receipt = await runHardenedAudit(plan, phase, timeoutMs);
    const summary = summarizeFilesystemAudit(receipt);
    assertSurfaceExpected(surface, summary, phase);
    return { receipt, summary, surface };
  }

  const runtimeProbeCode = "process.stdout.write(JSON.stringify({arch:process.arch,execArgv:process.execArgv,modules:process.versions.modules,napi:process.versions.napi,nodeOptions:process.env.NODE_OPTIONS??null,nodePath:process.env.NODE_PATH??null,platform:process.platform,version:process.versions.node}))";
  const runtimeResult = await execute("node-runtime-replay");
  const runtimeReplay = decodeJson(runtimeResult.stdout, "Node runtime replay");
  requireEqual(runtimeReplay.arch, "x64", "runtime replay architecture");
  requireEqual(runtimeReplay.platform, "win32", "runtime replay platform");
  requireEqual(runtimeReplay.version, "22.13.0", "runtime replay version");
  requireEqual(runtimeReplay.modules, "127", "runtime replay ABI");
  requireEqual(runtimeReplay.napi, "9", "runtime replay N-API");
  requireArrayEqual(runtimeReplay.execArgv, ["-e", runtimeProbeCode], "runtime replay execArgv provenance");
  requireEqual(runtimeReplay.nodeOptions, null, "runtime replay NODE_OPTIONS");
  requireEqual(runtimeReplay.nodePath, null, "runtime replay NODE_PATH");

  const gitPin = config.root.hostToolchain.git;
  requireArrayEqual(Object.keys(gitPin).sort(ordinalCompare), [
    "builtins",
    "executionPolicy",
    "fileVersion",
    "privateCopy",
    "sourceAliasGroups",
    "sourceExecutable",
    "systemImports",
    "tupleSchema",
  ], "Git authority shape");
  requireEqual(gitPin.executionPolicy, "run-private-git-builtins-v1", "Git execution policy");
  requireArrayEqual(gitPin.builtins, ["cat-file", "rev-parse", "show"], "Git builtin allowlist");
  requireArrayEqual(gitPin.tupleSchema, ["logicalPath", "bytes", "sha256"], "Git tuple schema");
  const gitSourceBefore = await auditSurface("git-execution-closure", "git-source-before");
  const gitSourceTupleMap = new Map(gitSourceBefore.summary.tuples.map((tuple) => [tuple[0], tuple]));
  const gitCopySources = new Map([[path.basename(gitPin.sourceExecutable[0]), gitPin.sourceExecutable]]);
  for (const group of gitPin.sourceAliasGroups) {
    requireEqual(group.kind, "git-for-windows-runtime-hardlink-v1", "Git source alias policy");
    requireEqual(group.linkCount, 2, "Git source alias link count");
    const selected = group.logicalPaths.filter((entry) => entry.includes("/libexec/git-core/"));
    requireEqual(selected.length, 1, "Git source alias private-copy selection");
    gitCopySources.set(path.basename(selected[0]), [selected[0], group.bytes, group.sha256]);
  }
  const expectedPrivateGitTuples = gitPin.privateCopy.files.map(([fileName, bytes, digest]) => [
    `run-private/git/${fileName}`,
    bytes,
    digest,
  ]).sort((left, right) => ordinalCompare(left[0], right[0]));
  requireEqual(expectedPrivateGitTuples.length, gitPin.privateCopy.fileCount, "private Git declared file count");
  requireEqual(
    expectedPrivateGitTuples.reduce((total, tuple) => total + tuple[1], 0),
    gitPin.privateCopy.byteLength,
    "private Git declared byte length",
  );
  requireEqual(
    sha256(canonicalJsonBytes(expectedPrivateGitTuples)),
    gitPin.privateCopy.surfaceSha256,
    "private Git closure digest",
  );
  for (const [fileName, bytes, digest] of gitPin.privateCopy.files) {
    const source = gitCopySources.get(fileName);
    if (!source || source[1] !== bytes || source[2] !== digest) {
      throw new Error(`private Git copy authority mismatch for ${fileName}`);
    }
    tupleForExactFact(gitSourceBefore.summary, source[0], bytes, digest, `Git source ${fileName}`);
    await copyStableExclusiveFile(
      actualPathForLogical(source[0], { cache: cacheRoot, git: gitRoot, system: systemRoot }),
      path.join(privateGitRoot, fileName),
      { bytes, sha256: digest },
      source[0] === gitPin.sourceExecutable[0] ? 1 : 2,
    );
  }
  requireEqual(gitCopySources.size, gitPin.privateCopy.fileCount, "private Git exact file count");
  const privateGitPlan = {
    schemaVersion: AUDIT_PLAN_SCHEMA,
    sources: [{
      files: [],
      logicalPrefix: "run-private/git",
      mode: "tree",
      rootPath: privateGitRoot,
      sourceId: "private-git-00",
      sourceIndex: 0,
      surfaceId: "private-git-runtime",
    }],
  };
  const gitExecPathPlan = {
    schemaVersion: AUDIT_PLAN_SCHEMA,
    sources: [{
      files: [],
      logicalPrefix: "run-private/git-exec-path",
      mode: "empty-tree",
      rootPath: gitExecPath,
      sourceId: "git-exec-path-00",
      sourceIndex: 0,
      surfaceId: "git-exec-path-empty",
    }],
  };
  const privateGitBefore = summarizeFilesystemAudit(await runHardenedAudit(privateGitPlan, "private-git-before"));
  requireEqual(isDeepStrictEqual(privateGitBefore.tuples, expectedPrivateGitTuples), true, "private Git closure before use");
  const gitExecPathBefore = summarizeFilesystemAudit(await runHardenedAudit(gitExecPathPlan, "git-exec-path-before"));
  requireEqual(gitExecPathBefore.fileCount, 0, "empty Git exec-path before use");
  await executableFact("git-private", gitExe, { bytes: gitPin.sourceExecutable[1], sha256: gitPin.sourceExecutable[2] });
  const gitTraceFacts = [];
  async function git(operationId, args) {
    if (!Array.isArray(args) || !gitPin.builtins.includes(args[0])) {
      throw new Error("Git command did not select one exact admitted builtin");
    }
    const plan = buildGitCommandPlan({ gitExe, repoRoot, args, env: gitEnv });
    const result = await execute(operationId);
    gitTraceFacts.push(parseGitTrace2(result.stderr, plan, args[0], logicalizeAuthorityNativeValue));
    return result;
  }
  const provenance = config.root.provenance;
  const repositoryAuthorities = presealRepositoryChainAuthorities(
    provenance,
    "capture repository authority",
  );
  const publishedCommit = repositoryAuthorities.publishedBase.landing;
  const t0Commit = repositoryAuthorities.historicalT0.landing;
  const publishedHead = (await git("git-head-commit", ["rev-parse", "HEAD^{commit}"])).stdout.toString("utf8").trim();
  const publishedTree = (await git("git-head-tree", ["rev-parse", `${publishedCommit}^{tree}`])).stdout.toString("utf8").trim();
  const publishedParents = (await git("git-head-parents", ["show", "-s", "--format=%P", publishedCommit])).stdout.toString("utf8").trim().split(" ").filter(Boolean);
  const t0Head = (await git("git-t0-commit", ["rev-parse", `${t0Commit}^{commit}`])).stdout.toString("utf8").trim();
  const t0Tree = (await git("git-t0-tree", ["rev-parse", `${t0Commit}^{tree}`])).stdout.toString("utf8").trim();
  const t0Parents = (await git("git-t0-parents", ["show", "-s", "--format=%P", t0Commit])).stdout.toString("utf8").trim().split(" ").filter(Boolean);
  for (const [value, label] of [
    [publishedHead, "published HEAD"],
    [publishedTree, "published tree"],
    [t0Head, "historical T0 commit"],
    [t0Tree, "historical T0 tree"],
  ]) {
    if (!/^[0-9a-f]{40}$/u.test(value)) throw new Error(`Git resolved an invalid ${label}`);
  }
  const commonDirectoryText = (await git("git-common-dir", ["rev-parse", "--path-format=absolute", "--git-common-dir"])).stdout.toString("utf8").trim();
  const gitCommonDirectory = path.resolve(repoRoot, commonDirectoryText);
  pathPolicyFacts.gitRewriteInputs = await runPathPolicy("git-rewrite-inputs");
  const rewriteFacts = new Map(pathPolicyFacts.gitRewriteInputs.map((fact) => [fact.id, fact]));
  requireEqual(rewriteFacts.get("git-common-directory")?.exists, true, "Git common directory existence");
  requireEqual(rewriteFacts.get("git-grafts-file")?.exists, false, "Git grafts absence");
  requireEqual(rewriteFacts.get("git-shallow-file")?.exists, false, "Git shallow marker absence");
  requireEqual(publishedHead, publishedCommit, "published HEAD");
  requireEqual(publishedTree, repositoryAuthorities.publishedBase.landingTree, "published tree");
  requireArrayEqual(publishedParents, repositoryAuthorities.publishedBase.orderedLandingParents, "published ordered parents");
  requireEqual(t0Head, provenance.t0PreCodeBase.commit, "historical T0 commit");
  requireEqual(t0Tree, provenance.t0PreCodeBase.tree, "historical T0 tree");
  requireArrayEqual(t0Parents, repositoryAuthorities.historicalT0.orderedLandingParents, "historical T0 ordered parents");
  const t0TrackedInputs = [];
  for (const [index, [relativePath, expectedBytes, expectedSha, expectedBlob]] of provenance.t0TrackedInputs.entries()) {
    const suffix = String(index).padStart(2, "0");
    const objectSpec = `${t0Commit}:${relativePath}`;
    const blob = (await git(`git-t0-blob-id-${suffix}`, ["rev-parse", objectSpec])).stdout.toString("utf8").trim();
    requireEqual(blob, expectedBlob, `T0 blob ${relativePath}`);
    const blobResult = await git(`git-t0-blob-content-${suffix}`, ["cat-file", "blob", objectSpec]);
    const canonical = normalizeCanonicalLf(blobResult.stdout);
    requireEqual(canonical.byteLength, expectedBytes, `T0 canonical bytes ${relativePath}`);
    requireEqual(canonical.sha256, expectedSha, `T0 canonical SHA-256 ${relativePath}`);
    t0TrackedInputs.push([relativePath, canonical.byteLength, canonical.sha256, blob]);
  }

  const resolution = config.root.packageResolution;
  const materializedManifests = [];
  for (const [relativePath, expectedBytes, expectedSha, expectedProjectionBytes, expectedProjectionSha] of resolution.workspaceManifests) {
    const canonical = normalizeCanonicalLf(await fs.readFile(path.join(repoRoot, ...relativePath.split("/"))));
    requireEqual(canonical.byteLength, expectedBytes, `workspace manifest bytes ${relativePath}`);
    requireEqual(canonical.sha256, expectedSha, `workspace manifest SHA-256 ${relativePath}`);
    const projection = packageResolutionProjection(decodeJson(canonical.bytes, `workspace manifest ${relativePath}`));
    requireEqual(projection.length, expectedProjectionBytes, `workspace projection bytes ${relativePath}`);
    requireEqual(sha256(projection), expectedProjectionSha, `workspace projection SHA-256 ${relativePath}`);
    const destination = path.join(workspaceRoot, ...relativePath.split("/"));
    await fs.mkdir(path.dirname(destination), { recursive: true });
    await fs.writeFile(destination, canonical.bytes, { flag: "wx" });
    materializedManifests.push([relativePath, canonical.byteLength, canonical.sha256, projection.length, sha256(projection)]);
  }
  const workspaceYaml = normalizeCanonicalLf(await fs.readFile(path.join(repoRoot, ...resolution.workspaceYaml.path.split("/"))));
  requireEqual(workspaceYaml.byteLength, resolution.workspaceYaml.canonicalLfBytes, "workspace YAML bytes");
  requireEqual(workspaceYaml.sha256, resolution.workspaceYaml.canonicalLfSha256, "workspace YAML SHA-256");
  await fs.writeFile(path.join(workspaceRoot, resolution.workspaceYaml.path), workspaceYaml.bytes, { flag: "wx" });
  const lock = normalizeCanonicalLf(await fs.readFile(path.join(repoRoot, "pnpm-lock.yaml")));
  const expectedLock = resolution.lock.t1CanonicalLf;
  requireEqual(lock.bom, expectedLock.bom, "lock BOM");
  requireEqual(lock.byteLength, expectedLock.bytes, "lock canonical bytes");
  requireEqual(lock.lineFeeds, expectedLock.lineFeeds, "lock line feeds");
  requireEqual(lock.sha256, expectedLock.sha256, "lock canonical SHA-256");
  requireEqual(lock.terminalLf, expectedLock.terminalLf, "lock terminal LF");
  await fs.writeFile(path.join(workspaceRoot, "pnpm-lock.yaml"), lock.bytes, { flag: "wx" });
  await fs.writeFile(path.join(workspaceRoot, ".npmrc"), Buffer.alloc(0), { flag: "wx" });

  const pnpmDistributionBefore = await auditSurface("pnpm-distribution", "pnpm-dist-preuse");
  requireEqual(pnpmDistributionBefore.summary.fileCount, pnpmInput.distribution.entries, "pnpm distribution entry count");
  tupleForExactFact(
    pnpmDistributionBefore.summary,
    "pnpm-distribution/bin/pnpm.cjs",
    pnpmInput.distribution.binPnpmCjsBytes,
    pnpmInput.distribution.binPnpmCjsSha256,
    "pnpm executable wrapper",
  );
  await executableFact("pnpm-cjs", pnpmCjs, {
    bytes: pnpmInput.distribution.binPnpmCjsBytes,
    sha256: pnpmInput.distribution.binPnpmCjsSha256,
  });

  const storeBeforeAudit = await auditSurface("pnpm-store-v10", "pnpm-store-before", 30 * 60_000);
  requireEqual(storeBeforeAudit.summary.fileCount, resolution.store.files, "pnpm store file count before install");
  requireEqual(storeBeforeAudit.summary.byteLength, resolution.store.totalBytes, "pnpm store byte length before install");
  const storeSurface = storeBeforeAudit.surface;
  const storeSourceRoots = storeSurface.sources.map((source) => path.posix.dirname(source.relativeRoot));
  requireEqual(new Set(storeSourceRoots).size, 1, "pnpm store source root agreement");
  const storeV10 = path.join(cacheRoot, ...storeSourceRoots[0].split("/"));
  requireEqual(path.basename(storeV10), resolution.store.schemaVersion, "pnpm store schema directory");

  const pnpmVersionResult = await execute("node-pnpm-version");
  requireEqual(pnpmVersionResult.stdout.toString("utf8").trim(), pnpmInput.distribution.version, "executed pnpm version");
  const pnpmResult = await execute("node-pnpm-install");
  const pnpmProgress = parsePnpmProgress(Buffer.concat([pnpmResult.stdout, Buffer.from("\n"), pnpmResult.stderr]));
  const observedOffline = requiredEntry(
    config.root.observations,
    (entry) => entry.id === "pnpm-offline-materialization",
    "pnpm materialization observation",
  ).facts;
  requireEqual(pnpmProgress.reused, observedOffline.reusedPackages, "pnpm reused packages");
  requireEqual(pnpmProgress.downloaded, observedOffline.downloads, "pnpm downloaded packages");
  const copiedLockAfter = normalizeCanonicalLf(await fs.readFile(path.join(workspaceRoot, "pnpm-lock.yaml")));
  requireEqual(copiedLockAfter.byteLength, lock.byteLength, "materialized lock bytes");
  requireEqual(copiedLockAfter.sha256, lock.sha256, "materialized lock SHA-256");
  const virtualStoreDirectories = await countImmediateDirectories(path.join(workspaceRoot, "node_modules", ".pnpm"));
  requireEqual(virtualStoreDirectories, observedOffline.virtualStoreDirectories, "virtual store directory count");

  const storeAfterAudit = await auditSurface("pnpm-store-v10", "pnpm-store-after", 30 * 60_000);
  if (!isDeepStrictEqual(storeAfterAudit.summary.tuples, storeBeforeAudit.summary.tuples)) {
    throw new Error("pnpm store per-file content/identity closure changed during materialization");
  }
  const pnpmDistributionAfter = await auditSurface("pnpm-distribution", "pnpm-dist-after");
  if (!isDeepStrictEqual(pnpmDistributionAfter.summary.tuples, pnpmDistributionBefore.summary.tuples)) {
    throw new Error("pnpm distribution closure changed while it was executed");
  }

  const officialObjectsAudit = await auditSurface("official-object-inputs", "official-objects-preuse", 30 * 60_000);
  const gpgSourceAudit = await auditSurface("git-signature-verification-closure", "gpg-source-preuse");
  const gpgAuthority = config.root.hostToolchain.signatureVerificationClosure;
  requireArrayEqual(gpgAuthority.tupleSchema, ["logicalPath", "bytes", "sha256"], "GPG closure tuple schema");
  const authorityTuples = [...gpgAuthority.files].sort((left, right) => ordinalCompare(left[0], right[0]));
  if (!isDeepStrictEqual(gpgSourceAudit.summary.tuples, authorityTuples)) {
    throw new Error("GPG hardened source closure did not equal config authority");
  }
  for (const [logicalPath, bytes, digest] of authorityTuples) {
    const sourcePath = actualPathForLogical(logicalPath, { cache: cacheRoot, git: gitRoot, system: systemRoot });
    const destination = path.join(gpgRuntimeRoot, path.posix.basename(logicalPath));
    await copyStableExclusiveFile(sourcePath, destination, { bytes, sha256: digest }, 1);
  }
  pathPolicyFacts.gpgCopy = await runPathPolicy("gpg-copy");

  const copiedGpgPlan = {
    schemaVersion: AUDIT_PLAN_SCHEMA,
    sources: [{
      files: [],
      logicalPrefix: "git/usr/bin",
      mode: "tree",
      rootPath: gpgRuntimeRoot,
      sourceId: "gpg-copy-00",
      sourceIndex: 0,
      surfaceId: "git-signature-verification-closure",
    }],
  };
  const copiedGpgBeforeReceipt = await runHardenedAudit(copiedGpgPlan, "gpg-copy-before");
  const copiedGpgBefore = summarizeFilesystemAudit(copiedGpgBeforeReceipt);
  if (!isDeepStrictEqual(copiedGpgBefore.tuples, authorityTuples)) {
    throw new Error("copied GPG runtime closure did not equal config authority");
  }

  const { parsePe } = await import("../probe/pe-inspect.mjs");
  const closureNames = new Map(authorityTuples.map((tuple) => [path.posix.basename(tuple[0]).toLowerCase(), path.posix.basename(tuple[0])]));
  const declaredSystemImports = [...gpgAuthority.systemImports].sort(ordinalCompare);
  const importGraph = new Map();
  const observedSystemImports = new Set();
  for (const [logicalPath, bytes, digest] of authorityTuples) {
    const name = path.posix.basename(logicalPath);
    const filePath = path.join(gpgRuntimeRoot, name);
    const peBytes = await fs.readFile(filePath);
    requireEqual(peBytes.length, bytes, `${name} PE bytes`);
    requireEqual(sha256(peBytes), digest, `${name} PE SHA-256`);
    const parsed = parsePe(peBytes);
    requireEqual(parsed.delayImportDirectory.rva, 0, `${name} delay-import RVA`);
    requireEqual(parsed.delayImportDirectory.size, 0, `${name} delay-import size`);
    const localImports = [];
    for (const imported of parsed.imports) {
      const local = closureNames.get(imported.toLowerCase());
      if (local !== undefined) {
        localImports.push(local);
      } else {
        if (!declaredSystemImports.includes(imported)) throw new Error(`${name} imports undeclared external runtime material`);
        observedSystemImports.add(imported);
      }
    }
    localImports.sort(ordinalCompare);
    importGraph.set(name, localImports);
  }
  requireArrayEqual([...observedSystemImports].sort(ordinalCompare), declaredSystemImports, "GPG system import closure");
  const reachable = new Set();
  const pending = ["gpg.exe", "gpgv.exe"];
  while (pending.length > 0) {
    const name = pending.pop();
    if (reachable.has(name)) continue;
    if (!importGraph.has(name)) throw new Error("GPG import graph escaped the pinned closure");
    reachable.add(name);
    pending.push(...importGraph.get(name));
  }
  requireArrayEqual([...reachable].sort(ordinalCompare), [...closureNames.values()].sort(ordinalCompare), "recursive GPG local PE closure");
  const gpgClosureDigest = sha256(canonicalJsonBytes(authorityTuples));
  const gpgExe = path.join(gpgRuntimeRoot, "gpg.exe");
  const gpgvExe = path.join(gpgRuntimeRoot, "gpgv.exe");
  const gpgTuple = requiredEntry(authorityTuples, (tuple) => tuple[0].endsWith("/gpg.exe"), "GPG executable tuple");
  const gpgvTuple = requiredEntry(authorityTuples, (tuple) => tuple[0].endsWith("/gpgv.exe"), "GPGV executable tuple");
  await executableFact("pinned-gpg", gpgExe, { bytes: gpgTuple[1], sha256: gpgTuple[2] });
  await executableFact("pinned-gpgv", gpgvExe, { bytes: gpgvTuple[1], sha256: gpgvTuple[2] });
  const nodeManifestAsset = requiredEntry(nodeInput.assets, (entry) => entry.role === "signed-checksum-manifest", "Node checksum manifest");
  const nodeDetachedAsset = requiredEntry(nodeInput.assets, (entry) => entry.role === "detached-checksum-signature", "Node detached signature");
  const nodeClearAsset = requiredEntry(nodeInput.assets, (entry) => entry.role === "clear-signed-checksum-manifest", "Node clear-signed manifest");
  const nodeManifestPath = cacheKeyToPath(cacheRoot, nodeManifestAsset.cacheKey);
  const nodeDetachedPath = cacheKeyToPath(cacheRoot, nodeDetachedAsset.cacheKey);
  const nodeClearPath = cacheKeyToPath(cacheRoot, nodeClearAsset.cacheKey);
  await Promise.all([
    verifyFile(nodeManifestPath, { bytes: nodeManifestAsset.bytes, sha256: nodeManifestAsset.sha256 }),
    verifyFile(nodeDetachedPath, { bytes: nodeDetachedAsset.bytes, sha256: nodeDetachedAsset.sha256 }),
    verifyFile(nodeClearPath, { bytes: nodeClearAsset.bytes, sha256: nodeClearAsset.sha256 }),
  ]);
  const nodeManifestBytes = await fs.readFile(nodeManifestPath);
  const nodeManifestText = new TextDecoder("utf-8", { fatal: true }).decode(nodeManifestBytes);
  for (const asset of nodeInput.assets.filter((entry) => entry.shasumsLine)) {
    if (!nodeManifestText.split(/\r?\n/u).includes(asset.shasumsLine)) throw new Error(`Node SHASUMS line is absent for ${asset.fileName}`);
  }
  const nodeKeyAuthority = nodeInput.signatureVerification.historicalKeyring;
  const nodeKeyMatches = officialObjectsAudit.summary.tuples.filter((tuple) => tuple[1] === nodeKeyAuthority.bytes && tuple[2] === nodeKeyAuthority.sha256);
  if (nodeKeyMatches.length !== 1) throw new Error("Node historical keyring was not uniquely config-bound");
  const nodeKeyTuple = nodeKeyMatches[0];
  const nodeKeyringPath = actualPathForLogical(nodeKeyTuple[0], { cache: cacheRoot, git: gitRoot, system: systemRoot });
  await verifyFile(nodeKeyringPath, { bytes: nodeKeyTuple[1], sha256: nodeKeyTuple[2] });

  const gpgvHome = path.join(runRoot, "gpgv-home");
  await fs.mkdir(gpgvHome, { recursive: true });
  const nodeDetachedResult = await execute("pinned-gpgv-node-detached");
  const nodeDetachedStatus = parseGpgStatus(nodeDetachedResult.stdout);
  if (![nodeDetachedStatus.fingerprint, nodeDetachedStatus.primaryFingerprint].includes(nodeInput.signatureVerification.signerFingerprint)) {
    throw new Error("Node detached signer fingerprint mismatch");
  }
  requireEqual(nodeDetachedStatus.signatureDate, nodeInput.signatureVerification.signatureTimestamp, "Node detached signature date");
  requireEqual(nodeDetachedStatus.digestAlgorithmId, 8, "Node detached digest algorithm");

  const clearPayloadPath = path.join(runRoot, "node-clearsigned-payload.txt");
  const nodeClearResult = await execute("pinned-gpgv-node-clearsigned");
  const nodeClearStatus = parseGpgStatus(nodeClearResult.stdout);
  if (![nodeClearStatus.fingerprint, nodeClearStatus.primaryFingerprint].includes(nodeInput.signatureVerification.signerFingerprint)) {
    throw new Error("Node clear-signed signer fingerprint mismatch");
  }
  requireEqual(nodeClearStatus.signatureDate, nodeInput.signatureVerification.signatureTimestamp, "Node clear signature date");
  requireEqual(nodeClearStatus.digestAlgorithmId, 8, "Node clear digest algorithm");
  const clearPayload = await fs.readFile(clearPayloadPath);
  requireEqual(clearPayload.equals(nodeManifestBytes), true, "Node signed payload equality");

  const llvmKeyAsset = requiredEntry(llvmInput.assets, (entry) => entry.role === "official-release-public-keys", "LLVM release keys");
  const llvmSignatureAsset = requiredEntry(llvmInput.assets, (entry) => entry.role === "detached-package-signature", "LLVM detached signature");
  const llvmArchiveAsset = requiredEntry(llvmInput.assets, (entry) => entry.role === "official-signed-windows-msvc-package", "LLVM archive");
  const llvmKeyPath = cacheKeyToPath(cacheRoot, llvmKeyAsset.cacheKey);
  const llvmSignaturePath = cacheKeyToPath(cacheRoot, llvmSignatureAsset.cacheKey);
  const llvmArchivePath = cacheKeyToPath(cacheRoot, llvmArchiveAsset.cacheKey);
  await Promise.all([
    verifyFile(llvmKeyPath, { bytes: llvmKeyAsset.bytes, sha256: llvmKeyAsset.sha256 }),
    verifyFile(llvmSignaturePath, { bytes: llvmSignatureAsset.bytes, sha256: llvmSignatureAsset.sha256 }),
    verifyFile(llvmArchivePath, { bytes: llvmArchiveAsset.bytes, sha256: llvmArchiveAsset.sha256 }),
  ]);
  const llvmHome = path.join(runRoot, "llvm-gpg-home");
  await fs.mkdir(llvmHome, { recursive: true });
  await execute("pinned-gpg-llvm-key-dearmor");
  const llvmVerifyResult = await execute("pinned-gpg-llvm-explicit-sha1-allowance");
  const llvmStatus = parseGpgStatus(llvmVerifyResult.stdout);
  if (![llvmStatus.fingerprint, llvmStatus.primaryFingerprint].includes(llvmInput.signatureVerification.signerFingerprint)) {
    throw new Error("LLVM signer fingerprint mismatch");
  }
  requireEqual(llvmStatus.signatureDate, llvmInput.signatureVerification.signatureTimestamp, "LLVM signature date");
  requireEqual(llvmStatus.digestAlgorithmId, 2, "LLVM digest algorithm");

  const pythonReleaseKey = pythonInput.signatureVerification.releaseKey;
  if (typeof pythonReleaseKey.logicalPath !== "string" || !pythonReleaseKey.logicalPath.startsWith("cache/objects/sha256/")) {
    throw new Error("Python release key lacks one config-pinned logical path");
  }
  const pythonKeyTuple = tupleForExactFact(
    officialObjectsAudit.summary,
    pythonReleaseKey.logicalPath,
    pythonReleaseKey.bytes,
    pythonReleaseKey.sha256,
    "Python release key",
  );
  const pythonKeyPath = actualPathForLogical(pythonKeyTuple[0], { cache: cacheRoot, git: gitRoot, system: systemRoot });
  await verifyFile(pythonKeyPath, { bytes: pythonKeyTuple[1], sha256: pythonKeyTuple[2] });
  const pythonInspectHome = path.join(runRoot, "python-key-inspection-home");
  await fs.mkdir(pythonInspectHome, { recursive: true });
  const pythonInspect = await execute("pinned-gpg-python-key-inspection");
  if (!parseGpgFingerprints(pythonInspect.stdout).includes(pythonInput.signatureVerification.signerFingerprint)) {
    throw new Error("Python release key fingerprint mismatch");
  }
  const pythonKeyringPath = path.join(runRoot, "python-release-keyring.gpg");
  await execute("pinned-gpg-python-key-dearmor");
  const pythonSignatureAsset = requiredEntry(pythonInput.assets, (entry) => entry.role === "detached-package-signature", "Python detached signature");
  const pythonArchiveAsset = requiredEntry(pythonInput.assets, (entry) => entry.role === "official-isolated-windows-python", "Python archive");
  const pythonSignaturePath = cacheKeyToPath(cacheRoot, pythonSignatureAsset.cacheKey);
  const pythonArchivePath = cacheKeyToPath(cacheRoot, pythonArchiveAsset.cacheKey);
  await Promise.all([
    verifyFile(pythonSignaturePath, { bytes: pythonSignatureAsset.bytes, sha256: pythonSignatureAsset.sha256 }),
    verifyFile(pythonArchivePath, { bytes: pythonArchiveAsset.bytes, sha256: pythonArchiveAsset.sha256 }),
  ]);
  const pythonVerifyResult = await execute("pinned-gpgv-python-detached");
  const pythonStatus = parseGpgStatus(pythonVerifyResult.stdout);
  if (![pythonStatus.fingerprint, pythonStatus.primaryFingerprint].includes(pythonInput.signatureVerification.signerFingerprint)) {
    throw new Error("Python signer fingerprint mismatch");
  }
  requireEqual(pythonStatus.signatureDate, pythonInput.signatureVerification.signatureTimestamp, "Python signature date");
  requireEqual(pythonStatus.digestAlgorithmId, 8, "Python digest algorithm");

  const copiedGpgAfterReceipt = await runHardenedAudit(copiedGpgPlan, "gpg-copy-after");
  const copiedGpgAfter = summarizeFilesystemAudit(copiedGpgAfterReceipt);
  if (!isDeepStrictEqual(copiedGpgAfter.tuples, copiedGpgBefore.tuples)) {
    throw new Error("pinned GPG runtime gained descendants or changed during verification");
  }

  const authenticode = await systemToolAuthority.runAuthenticodePlan({
    node: { bytes: nodeInput.nodeExe.bytes, path: nodeExe, sha256: nodeInput.nodeExe.sha256 },
    python: { bytes: pythonInput.pythonExe.bytes, path: pythonExe, sha256: pythonInput.pythonExe.sha256 },
  });
  requireEqual(authenticode.osBound, true, "Authenticode OS-bound marker");
  const nodeAuthenticode = requiredEntry(authenticode.facts, (entry) => entry.id === "node", "Node Authenticode fact");
  const pythonAuthenticode = requiredEntry(authenticode.facts, (entry) => entry.id === "python", "Python Authenticode fact");
  const powershellAuthenticode = requiredEntry(authenticode.facts, (entry) => entry.id === "powershell-private", "private PowerShell Authenticode fact");
  const taskkillAuthenticode = requiredEntry(authenticode.facts, (entry) => entry.id === "taskkill-private", "private taskkill Authenticode fact");
  for (const [observed, expected, label] of [
    [nodeAuthenticode, nodeInput.nodeExe.authenticode, "Node"],
    [pythonAuthenticode, pythonInput.pythonExe.authenticode, "Python"],
  ]) {
    requireEqual(observed.status, expected.status, `${label} Authenticode status`);
    requireEqual(observed.subject, expected.subject, `${label} Authenticode subject`);
    requireEqual(observed.thumbprint, expected.thumbprint, `${label} Authenticode thumbprint`);
    requireEqual(observed.serial, expected.serial, `${label} Authenticode serial`);
  }
  for (const [observed, pin, label] of [
    [powershellAuthenticode, powershellPin, "private PowerShell"],
    [taskkillAuthenticode, taskkillPin, "private taskkill"],
  ]) {
    requireEqual(observed.status, pin.authenticode.status, `${label} Authenticode status`);
    requireEqual(observed.certificateSubject, pin.authenticode.subject, `${label} Authenticode subject`);
    requireEqual(observed.thumbprint, pin.authenticode.thumbprint, `${label} Authenticode thumbprint`);
    requireEqual(observed.serial, pin.authenticode.serial, `${label} Authenticode serial`);
    requireEqual(observed.embeddedFileVersion, pin.embeddedFileVersion, `${label} embedded file version`);
  }
  const normalizedAuthenticodeFacts = [
    {
      id: nodeAuthenticode.id,
      serial: nodeAuthenticode.serial,
      status: nodeAuthenticode.status,
      subject: nodeAuthenticode.subject,
      thumbprint: nodeAuthenticode.thumbprint,
    },
    {
      id: pythonAuthenticode.id,
      serial: pythonAuthenticode.serial,
      status: pythonAuthenticode.status,
      subject: pythonAuthenticode.subject,
      thumbprint: pythonAuthenticode.thumbprint,
    },
    {
      certificateSubject: powershellAuthenticode.certificateSubject,
      embeddedFileVersion: powershellAuthenticode.embeddedFileVersion,
      id: powershellAuthenticode.id,
      serial: powershellAuthenticode.serial,
      status: powershellAuthenticode.status,
      thumbprint: powershellAuthenticode.thumbprint,
    },
    {
      certificateSubject: taskkillAuthenticode.certificateSubject,
      embeddedFileVersion: taskkillAuthenticode.embeddedFileVersion,
      id: taskkillAuthenticode.id,
      serial: taskkillAuthenticode.serial,
      status: taskkillAuthenticode.status,
      thumbprint: taskkillAuthenticode.thumbprint,
    },
  ];

  const pnpmTarballAsset = requiredEntry(pnpmInput.assets, (entry) => entry.role === "official-registry-distribution", "pnpm tarball");
  const pnpmMetadataAsset = requiredEntry(pnpmInput.assets, (entry) => entry.role === "registry-version-signature-document", "pnpm registry metadata");
  const pnpmKeysAsset = requiredEntry(pnpmInput.assets, (entry) => entry.role === "registry-public-verification-keys", "npm registry keys");
  const pnpmTarball = await fs.readFile(cacheKeyToPath(cacheRoot, pnpmTarballAsset.cacheKey));
  requireEqual(createHash("sha1").update(pnpmTarball).digest("hex"), pnpmTarballAsset.sha1, "pnpm tarball SHA-1 binding");
  requireEqual(`sha512-${createHash("sha512").update(pnpmTarball).digest("base64")}`, pnpmTarballAsset.sha512Integrity, "pnpm tarball SHA-512 integrity");
  const pnpmMetadata = decodeJson(await fs.readFile(cacheKeyToPath(cacheRoot, pnpmMetadataAsset.cacheKey)), "pnpm registry metadata");
  const pnpmKeys = decodeJson(await fs.readFile(cacheKeyToPath(cacheRoot, pnpmKeysAsset.cacheKey)), "npm registry keys");
  requireEqual(pnpmMetadata.name, "pnpm", "pnpm registry name");
  requireEqual(pnpmMetadata.version, pnpmInput.distribution.version, "pnpm registry version");
  requireEqual(pnpmMetadata.dist.integrity, pnpmTarballAsset.sha512Integrity, "pnpm registry integrity");
  requireEqual(pnpmMetadata.dist.shasum, pnpmTarballAsset.sha1, "pnpm registry shasum");
  const derivedRegistryMessage = `${pnpmMetadata.name}@${pnpmMetadata.version}:${pnpmMetadata.dist.integrity}`;
  requireEqual(derivedRegistryMessage, pnpmInput.signatureVerification.message, "pnpm derived registry signature message");
  const registrySignature = requiredEntry(pnpmMetadata.dist.signatures, (entry) => entry.keyid === pnpmInput.signatureVerification.keyId, "pnpm registry signature");
  const registryKey = requiredEntry(pnpmKeys.keys, (entry) => entry.keyid === pnpmInput.signatureVerification.keyId, "npm registry public key");
  requireEqual(registryKey.keytype, "ecdsa-sha2-nistp256", "npm registry key type");
  requireEqual(registryKey.scheme, "ecdsa-sha2-nistp256", "npm registry key scheme");
  const publicKey = createPublicKey({ key: Buffer.from(registryKey.key, "base64"), format: "der", type: "spki" });
  const registrySignatureValid = verifySignature(
    "sha256",
    Buffer.from(derivedRegistryMessage, "utf8"),
    publicKey,
    Buffer.from(registrySignature.sig, "base64"),
  );
  requireEqual(registrySignatureValid, true, "pnpm registry ECDSA signature");

  pathPolicyFacts.prewrite = await runPathPolicy("prewrite");
  const gitSourceAfter = await auditSurface("git-execution-closure", "git-source-after");
  requireEqual(
    isDeepStrictEqual(gitSourceAfter.summary.tuples, gitSourceBefore.summary.tuples),
    true,
    "Git source closure after use",
  );
  const privateGitAfter = summarizeFilesystemAudit(await runHardenedAudit(privateGitPlan, "private-git-after"));
  requireEqual(isDeepStrictEqual(privateGitAfter.tuples, privateGitBefore.tuples), true, "private Git closure after use");
  const gitExecPathAfter = summarizeFilesystemAudit(await runHardenedAudit(gitExecPathPlan, "git-exec-path-after"));
  requireEqual(gitExecPathAfter.fileCount, 0, "empty Git exec-path after use");
  if (
    gitTraceFacts.length !== CX004_PRESEAL_GIT_TRACE_COUNT ||
    gitTraceFacts.some((fact) => fact.childEventCount !== 0)
  ) {
    throw new Error("private Git command/descendant evidence was incomplete");
  }
  const authorityFinalization = await systemToolAuthority.finalize();
  requireEqual(authorityFinalization.privateCopy.beforeAfterExactTupleEquality, true, "private system tool closure after use");
  const commandEvidence = authorityFinalization.commands;
  if (commandEvidence.some((command) => command.terminationRequested || command.cleanupOutcome !== "not-required")) {
    throw new Error("passed capture observed a command termination or nontrivial cleanup");
  }
  for (const [id, tuple] of [
    ["authenticode-probe", authorityFinalization.entryBindings.find((entry) => entry[0] === "authenticode-probe")],
    ["path-policy-probe", authorityFinalization.entryBindings.find((entry) => entry[0] === "path-policy-probe")],
    ["filesystem-audit-worker", authorityFinalization.workerBindings.find((entry) => entry[0] === "audit-worker")],
  ]) {
    if (!tuple) throw new Error(`${id} authority binding was unavailable`);
    executableFacts.push({ bytes: tuple[1], id, logicalPath: `<repo>/packages/windows-containment/toolchain/${id === "filesystem-audit-worker" ? "native-build-input-filesystem-audit.ps1" : `preseal/${id}.ps1`}`, sha256: tuple[2] });
  }
  const configProjectionBytes = canonicalJsonBytes(presealConfigAuthorityProjection(config));
  const configAuthority = {
    algorithm: PRESEAL_CONFIG_AUTHORITY_PROJECTION_ALGORITHM,
    capturedConfig: { bytes: configBytes.length, sha256: sha256(configBytes) },
    projection: { bytes: configProjectionBytes.length, sha256: sha256(configProjectionBytes) },
  };
  const payload = {
    authenticode: {
      facts: normalizedAuthenticodeFacts,
      osBound: true,
      verificationToolIdentityPolicy: servicedPolicy.bootstrapExecution,
      verificationToolSha256: powershellPin.sha256,
    },
    capturedAtUtc: new Date().toISOString(),
    commands: commandEvidence,
    configAuthority,
    executableFacts,
    filesystemAudits: authorityFinalization.payloadEvidence.filesystemAudits,
    gpgRuntimeClosure: {
      authoritySha256: gpgClosureDigest,
      delayImports: "absent",
      fileCount: authorityTuples.length,
      localClosureReachableFrom: ["gpg.exe", "gpgv.exe"],
      noUnexpectedDescendantsAfterUse: true,
      pathPolicy: "copied-fresh-runtime; PATH is copied closure plus System32 only",
      systemImports: declaredSystemImports,
    },
    gitRuntimeClosure: {
      builtins: [...gitPin.builtins],
      commandCount: gitTraceFacts.length,
      executionPolicy: gitPin.executionPolicy,
      gitExecPathEmptyAfter: true,
      gitExecPathEmptyBefore: true,
      noChildEvents: true,
      privateCopySurfaceSha256: privateGitBefore.surfaceSha256,
      sourceSurfaceSha256: gitSourceBefore.summary.surfaceSha256,
      systemImports: [...gitPin.systemImports],
      traceFacts: gitTraceFacts,
    },
    networkPolicy: {
      credentialConfiguration: "absent-from-closed-child-environments",
      installMode: ["offline", "frozen-lockfile", "ignore-scripts", "global-virtual-store-disabled"],
      providerAccess: false,
      proxyAndRegistry: "loopback-blackhole-127.0.0.1:9",
    },
    outcome: "passed",
    packageMaterialization: {
      lock: {
        bytes: lock.byteLength,
        lineFeeds: lock.lineFeeds,
        sha256: lock.sha256,
        terminalLf: lock.terminalLf,
        unchangedAfterInstall: copiedLockAfter.sha256 === lock.sha256,
      },
      pnpm: {
        downloaded: pnpmProgress.downloaded,
        exitCode: 0,
        resolved: pnpmProgress.resolved,
        reused: pnpmProgress.reused,
        version: pnpmInput.distribution.version,
        virtualStoreDirectories,
      },
      store: {
        beforeAfterExactTupleEquality: true,
        files: storeBeforeAudit.summary.fileCount,
        sha256: storeBeforeAudit.summary.surfaceSha256,
        totalBytes: storeBeforeAudit.summary.byteLength,
      },
      workspaceManifests: materializedManifests,
      workspaceManifestTupleSchema: resolution.workspaceManifestTupleSchema,
      workspaceYaml: { bytes: workspaceYaml.byteLength, path: resolution.workspaceYaml.path, sha256: workspaceYaml.sha256 },
    },
    pathPolicy: authorityFinalization.payloadEvidence.pathPolicy,
    repository: {
      gitObjectRewriteInputs: {
        commonDirectoryPathPolicy: true,
        graftsAbsent: true,
        replaceObjectsDisabledByArgvAndEnvironment: true,
        shallowAbsent: true,
      },
      historicalT0: {
        commit: t0Head,
        orderedParents: t0Parents,
        t0TrackedInputs,
        trackedInputTupleSchema: provenance.t0TrackedInputTupleSchema,
        tree: t0Tree,
      },
      publishedBase: {
        commit: publishedHead,
        orderedParents: publishedParents,
        tree: publishedTree,
      },
    },
    runId,
    runtime: bootstrapRuntime,
    schemaVersion: PAYLOAD_SCHEMA,
    scope: {
      externalProjectDataAccessed: false,
      payloadLogicalPath,
      providerProcessesStarted: false,
      receiptLogicalPath,
      stableRepositoryMutated: false,
      workspaceMaterializationLogicalPath: "<run>/workspace",
    },
    servicedSystemTools: {
      bootstrapExecutionPolicy: servicedPolicy.bootstrapExecution,
      bootstrapFailureCleanupUsed: authorityFinalization.bootstrapFailureCleanupUsed,
      bootstrapSourceExecutionCount: authorityFinalization.bootstrapSourcePowerShellExecutions,
      commandCount: authorityFinalization.commandCount,
      entryBindings: authorityFinalization.entryBindings,
      exclusionIds: authorityFinalization.exclusionIds,
      loadedModuleBindings: authorityFinalization.loadedModuleBindings,
      loadedModuleExecution: authorityFinalization.loadedModuleExecution,
      privateCopy: {
        creation: "COPYFILE_EXCL; flush; close; reopen; double-hash",
        identityPolicy: servicedPolicy.privateCopyIdentity,
        logicalRoot: "<private-tools>",
        tools: [
          { bytes: powershellPin.bytes, id: "powershell-private", logicalPath: `<private-tools>/${powershellPin.privateCopyFileName}`, sha256: powershellPin.sha256 },
          { bytes: taskkillPin.bytes, id: "taskkill-private", logicalPath: `<private-tools>/${taskkillPin.privateCopyFileName}`, sha256: taskkillPin.sha256 },
        ],
      },
      sourceIdentityPolicy: servicedPolicy.sourceIdentity,
      sourceTaskkillExecutionCount: authorityFinalization.sourceTaskkillExecutions,
      sourceTopology: authorityFinalization.sourceTopologies,
      termination: {
        invocationPolicy: servicedPolicy.terminationInvocation,
        ownedRootExitTimeoutMs: servicedPolicy.ownedRootExitTimeoutMs,
        privateToolLogicalPath: `<private-tools>/${taskkillPin.privateCopyFileName}`,
        requestedCount: authorityFinalization.terminationRequestedCount,
        terminationToolTimeoutMs: servicedPolicy.terminationToolTimeoutMs,
      },
      workerBindings: authorityFinalization.workerBindings,
    },
    signatures: authorityFinalization.payloadEvidence.signatures,
  };

  const privacyOptions = {
    actualRoots: [repoRoot, cacheRoot, gitRoot, systemRoot, process.execPath, ...providerExclusions],
    forbiddenSubstrings: config.privacy.forbiddenSubstrings,
  };
  assertReceiptPrivate(payload, privacyOptions);
  const payloadBytes = assertCompactCanonical(
    payload,
    MAX_PAYLOAD_BYTES,
    "preseal evidence payload",
    MAX_PRESEAL_PAYLOAD_MEMBERS,
  );
  const payloadPostwrite = await systemToolAuthority.writePayload(payloadBytes);
  const teardown = await systemToolAuthority.teardown();
  const receiptRoot = {
    outcome: "passed",
    payload: {
      bytes: payloadPostwrite.bytes,
      logicalPath: payloadPostwrite.logicalPath,
      sha256: payloadPostwrite.sha256,
    },
    runId,
    schemaVersion: ROOT_SCHEMA,
    teardown,
  };
  assertReceiptPrivate(receiptRoot, privacyOptions);
  const rootBytes = assertCompactCanonical(receiptRoot, MAX_ROOT_BYTES, "preseal evidence root");
  const rootPostwrite = await systemToolAuthority.writeRoot(rootBytes);
  const output = canonicalJsonBytes({
    outcome: "passed",
    payloadSha256: payloadPostwrite.sha256,
    receiptLogicalPath: rootPostwrite.logicalPath,
    receiptSha256: rootPostwrite.sha256,
  });
  process.stdout.write(`${output.toString("utf8")}\n`);
}

try {
  await main();
} catch (error) {
  const message = error instanceof Error ? error.message : "unknown failure";
  const unsafe = /(?:[A-Za-z]:[\\/]|\\\\|CODEX_HOME|CLAUDE_CONFIG_DIR|ANTHROPIC_|OPENAI_API_KEY|sessionId)/iu.test(message);
  const detail = unsafe ? (error?.code ? ` (${String(error.code)})` : "") : `: ${message.slice(0, 512)}`;
  process.stderr.write(`preseal capture failed; no receipt was admitted${detail}\n`);
  process.exitCode = 1;
}
