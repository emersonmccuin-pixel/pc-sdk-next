import { createHash, createPublicKey, randomBytes, verify as verifySignature } from "node:crypto";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { isDeepStrictEqual } from "node:util";

import {
  CX004_PRESEAL_COMMAND_COUNT,
  loadManifestConfig,
  presealRepositoryChainAuthorities,
} from "../manifest-set.mjs";
import {
  buildClosedEnvironment,
  buildGitCommandPlan,
  buildPnpmCommandPlan,
  atomicWriteVerified,
  cacheKeyToPath,
  canonicalJsonBytes,
  createLogicalizer,
  parseGpgFingerprints,
  parseGpgStatus,
  parseFilesystemAuditReceipt,
  runCommand,
  sha256,
  summarizeFilesystemAudit,
  verifyFile,
} from "./preseal-evidence.mjs";
import { assertNoReparseExistingPath } from "./runner-bootstrap.mjs";
import {
  countPresealPayloadMembers,
  MAX_PRESEAL_PAYLOAD_MEMBERS,
  PRESEAL_CONFIG_AUTHORITY_PROJECTION_ALGORITHM,
  presealConfigAuthorityProjection,
} from "../preseal-config-projection.mjs";

export const SYSTEM_TOOL_BOOTSTRAP_PLAN_SCHEMA = "pc-sdk.cx-004.system-tool-authority-bootstrap-plan.v1";
export const SYSTEM_TOOL_BOOTSTRAP_RECEIPT_SCHEMA = "pc-sdk.cx-004.system-tool-authority-bootstrap-receipt.v1";
export const FILESYSTEM_AUDIT_PLAN_SCHEMA = "pc-sdk.cx-004.native-build-input-filesystem-audit-plan.v1";

const MODULE_DIRECTORY = path.dirname(fileURLToPath(import.meta.url));
const DEFAULT_AUTHORITY_MODULE_PATH = fileURLToPath(import.meta.url);
const DEFAULT_AUTHENTICODE_PATH = path.join(MODULE_DIRECTORY, "authenticode-probe.ps1");
const DEFAULT_BOOTSTRAP_PATH = path.join(MODULE_DIRECTORY, "system-tool-authority-bootstrap.ps1");
const DEFAULT_CAPTURE_PATH = path.join(MODULE_DIRECTORY, "capture-preseal-evidence.mjs");
const DEFAULT_CORE_PATH = path.join(MODULE_DIRECTORY, "filesystem-audit-core.psm1");
const DEFAULT_INLINE_LAUNCHER_PATH = path.join(MODULE_DIRECTORY, "preseal-inline-launcher.mjs");
const DEFAULT_IN_MEMORY_LOADER_PATH = path.join(MODULE_DIRECTORY, "preseal-in-memory-loader.mjs");
const DEFAULT_PATH_POLICY_PATH = path.join(MODULE_DIRECTORY, "path-policy-probe.ps1");
const DEFAULT_WORKER_PATH = path.resolve(MODULE_DIRECTORY, "..", "native-build-input-filesystem-audit.ps1");
const DEFAULT_CONFIG_PATH = path.resolve(MODULE_DIRECTORY, "..", "native-build-input.config.json");
const CAPTURE_MODULE_GRAPH = deepFreeze([
  ["preseal-capture-entry", DEFAULT_CAPTURE_PATH],
  ["system-tool-authority-module", DEFAULT_AUTHORITY_MODULE_PATH],
  ["preseal-evidence-module", path.join(MODULE_DIRECTORY, "preseal-evidence.mjs")],
  ["runner-bootstrap-module", path.join(MODULE_DIRECTORY, "runner-bootstrap.mjs")],
  ["manifest-set-module", path.resolve(MODULE_DIRECTORY, "..", "manifest-set.mjs")],
  ["preseal-config-projection-module", path.resolve(MODULE_DIRECTORY, "..", "preseal-config-projection.mjs")],
  ["pe-inspect-module", path.resolve(MODULE_DIRECTORY, "..", "probe", "pe-inspect.mjs")],
]);
const IDENTIFIER_PATTERN = /^[a-z0-9][a-z0-9._-]{0,95}$/u;
const SHA256_PATTERN = /^[0-9a-f]{64}$/u;
const MAX_PLAN_BYTES = 16 * 1024 * 1024;
const MAX_WORKER_OUTPUT_BYTES = 128 * 1024 * 1024;
const MAX_TIMEOUT_MS = 30 * 60 * 1000;
const NATIVE_EXECUTABLE_IDENTITY_POLICY = "regular-nonreparse-components-single-link-double-content-hash-stable-handle";
const PATH_POLICY_SCHEMA = "pc-sdk.cx-004.preseal-path-policy.v1";
const AUTHENTICODE_PLAN_SCHEMA = "pc-sdk.cx-004.authenticode-probe-plan.v1";
const AUTHENTICODE_RECEIPT_SCHEMA = "pc-sdk.cx-004.authenticode-probe.v1";
const EXECUTION_ENVELOPE_SCHEMA = "pc-sdk.cx-004.in-process-powershell-execution-envelope.v1";
const PRESEAL_PAYLOAD_SCHEMA = "pc-sdk.cx-004.preseal-evidence-payload.v2";
const PRESEAL_ROOT_SCHEMA = "pc-sdk.cx-004.preseal-evidence-root.v2";
const PRESEAL_INLINE_LAUNCH_SCHEMA = "pc-sdk.cx-004.preseal-inline-launch.v1";
const PRESEAL_INLINE_LAUNCHER_KIND = "pinned-node-inline-memory-loader-v1";
const PRESEAL_LOADER_READY_SCHEMA = "pc-sdk.cx-004.preseal-loader-ready.v1";
const PRESEAL_IN_MEMORY_LOADER_SHA256 = "0f8703f49ad74b0b45f836c50c049a3782afdc10b73504a9f208dcc8e8b1c37a";
const PRESEAL_LAUNCH_CONTEXT_NAME = "__PC_SDK_PRESEAL_LAUNCH_CONTEXT__";
const MAX_PRESEAL_PAYLOAD_BYTES = 256 * 1024;
const MAX_PRESEAL_ROOT_BYTES = 16 * 1024;
const PRESEAL_PAYLOAD_KEYS = deepFreeze([
  "authenticode",
  "capturedAtUtc",
  "commands",
  "configAuthority",
  "executableFacts",
  "filesystemAudits",
  "gpgRuntimeClosure",
  "gitRuntimeClosure",
  "networkPolicy",
  "outcome",
  "packageMaterialization",
  "pathPolicy",
  "repository",
  "runId",
  "runtime",
  "schemaVersion",
  "scope",
  "servicedSystemTools",
  "signatures",
]);
const POWERSHELL_IN_PROCESS_LOADER = String.raw`Set-StrictMode -Version Latest
$ErrorActionPreference='Stop'
$ProgressPreference='SilentlyContinue'
function Fail-Loader { throw [System.InvalidOperationException]::new('sealed-loader-failed') }
$raw=[Console]::In.ReadToEnd()
if ([string]::IsNullOrEmpty($raw) -or $raw.Length -gt 16777216) { Fail-Loader }
try { $envelope=$raw | ConvertFrom-Json } catch { Fail-Loader }
$actual=[string[]]@($envelope.PSObject.Properties | ForEach-Object Name)
$wanted=[string[]]@('coreBytes','coreBytesLength','coreSha256','planBytes','planBytesLength','planSha256','schemaVersion','scriptBytes','scriptBytesLength','scriptSha256')
[Array]::Sort($actual,[StringComparer]::Ordinal); [Array]::Sort($wanted,[StringComparer]::Ordinal)
if ($actual.Length -ne $wanted.Length -or ($actual -join [char]0) -cne ($wanted -join [char]0) -or $envelope.schemaVersion -cne '${EXECUTION_ENVELOPE_SCHEMA}') { Fail-Loader }
function Decode-LoaderBytes([object]$encoded,[object]$length,[object]$expectedHash) {
  if ($encoded -isnot [string] -or ($length -isnot [int] -and $length -isnot [long]) -or [long]$length -lt 1 -or [long]$length -gt 8388608 -or $expectedHash -isnot [string] -or $expectedHash -cnotmatch '^[0-9a-f]{64}$') { Fail-Loader }
  try { $bytes=[Convert]::FromBase64String([string]$encoded) } catch { Fail-Loader }
  if ($bytes.Length -ne [long]$length) { Fail-Loader }
  $sha=[Security.Cryptography.SHA256]::Create()
  try { $digest=-join ($sha.ComputeHash($bytes) | ForEach-Object { $_.ToString('x2') }) } finally { $sha.Dispose() }
  if ($digest -cne [string]$expectedHash) { Fail-Loader }
  return [byte[]]$bytes
}
$coreBytes=Decode-LoaderBytes $envelope.coreBytes $envelope.coreBytesLength $envelope.coreSha256
$planBytes=Decode-LoaderBytes $envelope.planBytes $envelope.planBytesLength $envelope.planSha256
$scriptBytes=Decode-LoaderBytes $envelope.scriptBytes $envelope.scriptBytesLength $envelope.scriptSha256
$utf8=[Text.UTF8Encoding]::new($false,$true)
try { $coreText=$utf8.GetString($coreBytes); $planText=$utf8.GetString($planBytes); $scriptText=$utf8.GetString($scriptBytes) } catch { Fail-Loader }
$module=New-Module -Name 'PcSdkFilesystemAuditCoreExact' -ScriptBlock ([ScriptBlock]::Create($coreText))
Import-Module $module -Force -ErrorAction Stop | Out-Null
$entry=[ScriptBlock]::Create($scriptText)
& $entry $planText`;
const POWERSHELL_IN_PROCESS_LOADER_SHA256 = sha256(Buffer.from(POWERSHELL_IN_PROCESS_LOADER, "utf16le"));

function authorityFail(message) {
  throw new Error(`sealed system tool authority: ${message}`);
}

function deepFreeze(value) {
  if (value === null || typeof value !== "object" || Object.isFrozen(value)) return value;
  for (const child of Object.values(value)) deepFreeze(child);
  return Object.freeze(value);
}

function immutableSnapshot(value) {
  return deepFreeze(structuredClone(value));
}

function logicalizeCanonicalStrings(value, logicalize) {
  if (typeof value === "string") return logicalize(value);
  if (Array.isArray(value)) return value.map((entry) => logicalizeCanonicalStrings(entry, logicalize));
  if (value !== null && typeof value === "object") {
    const authorityPathId = typeof value.id === "string" && typeof value.path === "string" ? value.id : undefined;
    const authorityRootId = typeof value.sourceId === "string" && typeof value.rootPath === "string" ? value.sourceId : undefined;
    return Object.fromEntries(Object.entries(value).map(([key, entry]) => {
      if (key === "exclusions" && Array.isArray(entry)) {
        return [key, entry.map((exclusion) => ({
          ...Object.fromEntries(Object.entries(exclusion).filter(([name]) => name !== "path")
            .map(([name, child]) => [name, logicalizeCanonicalStrings(child, logicalize)])),
          path: `<exclusion:${exclusion.id}>`,
        }))];
      }
      if (key === "path" && authorityPathId !== undefined) return [key, `<authority-path:${authorityPathId}>`];
      if (key === "rootPath" && authorityRootId !== undefined) return [key, `<authority-root:${authorityRootId}>`];
      return [key, logicalizeCanonicalStrings(entry, logicalize)];
    }));
  }
  return value;
}

function logicalEntryPlanSha256(entryPlan, logicalize) {
  return sha256(canonicalJsonBytes(logicalizeCanonicalStrings(entryPlan, logicalize)));
}

function ordinalCompare(left, right) {
  return left < right ? -1 : left > right ? 1 : 0;
}

function assertExactKeys(value, expected, label) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) authorityFail(`${label} must be an object`);
  const actual = Object.keys(value).sort(ordinalCompare);
  const wanted = [...expected].sort(ordinalCompare);
  if (!isDeepStrictEqual(actual, wanted)) authorityFail(`${label} has unknown or missing properties`);
}

function assertIdentifier(value, label) {
  if (typeof value !== "string" || !IDENTIFIER_PATTERN.test(value)) authorityFail(`${label} is invalid`);
  return value;
}

function isPathWithin(candidate, root) {
  const relative = path.relative(root, candidate);
  return relative === "" || (relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative));
}

function exactLocalPath(value, label) {
  if (typeof value !== "string" || value.length === 0 || value.includes("\0")) authorityFail(`${label} is invalid`);
  const absolute = path.resolve(value);
  if (process.platform !== "win32" || !/^[A-Za-z]:[\\/]/u.test(absolute) || absolute.startsWith("\\\\")) {
    authorityFail(`${label} must be on one local Windows drive`);
  }
  return absolute;
}

function samePath(left, right) {
  return path.resolve(left).toLowerCase() === path.resolve(right).toLowerCase();
}

export const SEALED_SYSTEM_TOOL_AUTHORITY = deepFreeze({
  authenticodeVerificationTool: {
    authenticode: {
      serial: "330000059B7ABC51A19E71241800000000059B",
      status: "Valid",
      subject: "CN=Microsoft Windows, O=Microsoft Corporation, L=Redmond, S=Washington, C=US",
      thumbprint: "DC91E564D5BC1E3A8E02D6A8508682ABEA8A2443",
    },
    bytes: 454656,
    executionMode: "bootstrap-source-once-then-private-copy",
    embeddedFileVersion: "10.0.26100.8875",
    hardlinkCount: 2,
    logicalPaths: [
      "windows/System32/WindowsPowerShell/v1.0/powershell.exe",
      "windows/WinSxS/amd64_microsoft-windows-powershell-exe_31bf3856ad364e35_10.0.26100.8875_none_04b33bacb253ee82/powershell.exe",
    ],
    privateCopyFileName: "powershell.exe",
    sha256: "7600ffe12da441fe89d035b13801e8e91d064bc544a27b19a5cf49f6ab8b18f5",
  },
  processTreeTerminationTool: {
    authenticode: {
      serial: "3300000519DADDAA8BDC44B292000000000519",
      status: "Valid",
      subject: "CN=Microsoft Windows, O=Microsoft Corporation, L=Redmond, S=Washington, C=US",
      thumbprint: "3B77DB29AC72AA6B5880ECB2ED5EC1EC6601D847",
    },
    bytes: 118784,
    executionMode: "private-copy-with-bootstrap-failure-only-source",
    embeddedFileVersion: "10.0.26100.1",
    hardlinkCount: 2,
    logicalPaths: [
      "windows/System32/taskkill.exe",
      "windows/WinSxS/amd64_microsoft-windows-taskkill_31bf3856ad364e35_10.0.26100.1_none_2271a765c49d2684/taskkill.exe",
    ],
    privateCopyFileName: "taskkill.exe",
    sha256: "1249717315fc8f4d2df17d5db9da0444795fdb9fb83dfb1f763c3f39282244f7",
  },
  servicedSystemToolPolicy: {
    bootstrapExecution: "os-tcb-bootstrap-then-verified-single-link-copy",
    bootstrapSourceExecutionLimit: 1,
    ownedRootExitTimeoutMs: 25000,
    passedReceiptBootstrapFailureCleanupUsed: false,
    privateCopyIdentity: "run-private-single-link-copy-v1",
    sourceIdentity: "windows-servicing-hardlink-v1",
    terminationInvocation: "taskkill-tree-force-v1",
    terminationToolTimeoutMs: 10000,
  },
});

export function assertSealedSystemToolAuthority(hostToolchain) {
  const projection = {
    authenticodeVerificationTool: hostToolchain?.authenticodeVerificationTool,
    processTreeTerminationTool: hostToolchain?.processTreeTerminationTool,
    servicedSystemToolPolicy: hostToolchain?.servicedSystemToolPolicy,
  };
  if (!isDeepStrictEqual(projection, SEALED_SYSTEM_TOOL_AUTHORITY)) {
    throw new Error("sealed system tool config authority mismatch");
  }
  return SEALED_SYSTEM_TOOL_AUTHORITY;
}

async function stableBinding(filePath, id, expected = {}, { requireSingleLink = true } = {}) {
  const absolute = exactLocalPath(filePath, `${id} binding path`);
  await assertNoReparseExistingPath(absolute, `${id} binding`);
  const fact = await verifyFile(absolute, expected, { requireSingleLink });
  return {
    id,
    identity: fact.identity,
    path: absolute,
    requireSingleLink,
    tuple: [id, fact.observed.bytes, fact.observed.sha256],
  };
}

async function replayBinding(binding) {
  const replay = await stableBinding(binding.path, binding.id, {
    bytes: binding.tuple[1],
    sha256: binding.tuple[2],
  }, { requireSingleLink: binding.requireSingleLink });
  if (!isDeepStrictEqual(replay.identity, binding.identity)) {
    authorityFail(`${binding.id} binding identity changed`);
  }
}

function assertLaunchBindingShape(binding, expectedId, expectedPath, label) {
  assertExactKeys(binding, ["id", "identity", "path", "tuple"], label);
  assertExactKeys(binding.identity, ["dev", "ino", "mtimeNs", "nlink", "size"], `${label}.identity`);
  for (const [name, value] of Object.entries(binding.identity)) {
    if (typeof value !== "string" || !/^[0-9]+$/u.test(value)) authorityFail(`${label}.identity.${name} was invalid`);
  }
  if (
    binding.id !== expectedId || !samePath(binding.path, expectedPath) ||
    !Array.isArray(binding.tuple) || binding.tuple.length !== 3 || binding.tuple[0] !== expectedId ||
    !Number.isSafeInteger(binding.tuple[1]) || binding.tuple[1] < 1 ||
    typeof binding.tuple[2] !== "string" || !SHA256_PATTERN.test(binding.tuple[2])
  ) authorityFail(`${label} did not equal its fixed source identity`);
  if (
    !Object.isFrozen(binding) || !Object.isFrozen(binding.identity) || !Object.isFrozen(binding.tuple)
  ) authorityFail(`${label} was not an immutable launch binding`);
}

async function validatePresealInlineLaunchContext() {
  const descriptor = Object.getOwnPropertyDescriptor(globalThis, PRESEAL_LAUNCH_CONTEXT_NAME);
  if (
    descriptor === undefined || descriptor.configurable !== false || descriptor.enumerable !== false ||
    descriptor.writable !== false || descriptor.get !== undefined || descriptor.set !== undefined
  ) authorityFail("preseal inline launch context descriptor was invalid");
  const context = descriptor.value;
  assertExactKeys(context, [
    "executionGraphSha256",
    "launchArgvSha256",
    "launcherBinding",
    "launcherKind",
    "loaderBinding",
    "loaderReadyChallenge",
    "loaderReadyReceiptSha256",
    "loaderSha256",
    "runtimeBinding",
    "schemaVersion",
    "snapshotLoaderCounters",
    "sourceBindings",
    "sourceRoot",
  ], "preseal inline launch context");
  if (!Object.isFrozen(context) || !Object.isFrozen(context.sourceBindings)) {
    authorityFail("preseal inline launch context was not immutable");
  }
  const sourceRoot = exactLocalPath(context.sourceRoot, "preseal inline source root");
  const expectedSourceRoot = path.resolve(MODULE_DIRECTORY, "..", "..", "..", "..");
  if (!samePath(sourceRoot, expectedSourceRoot)) authorityFail("preseal inline source root did not equal the loaded source repository");
  if (
    process.argv.length !== 1 || process.execArgv.length !== 3 ||
    process.execArgv[0] !== "--input-type=module" || process.execArgv[1] !== "-e" ||
    typeof process.execArgv[2] !== "string" || process.execArgv[2].length === 0 ||
    Object.keys(process.env).some((name) => /^NODE_/iu.test(name) && process.env[name] !== "")
  ) authorityFail("preseal inline process profile was invalid");
  if (
    context.schemaVersion !== PRESEAL_INLINE_LAUNCH_SCHEMA ||
    context.launcherKind !== PRESEAL_INLINE_LAUNCHER_KIND ||
    typeof context.executionGraphSha256 !== "string" || !SHA256_PATTERN.test(context.executionGraphSha256) ||
    typeof context.launchArgvSha256 !== "string" || !SHA256_PATTERN.test(context.launchArgvSha256) ||
    typeof context.loaderSha256 !== "string" || !SHA256_PATTERN.test(context.loaderSha256) ||
    typeof context.loaderReadyReceiptSha256 !== "string" || !SHA256_PATTERN.test(context.loaderReadyReceiptSha256) ||
    typeof context.loaderReadyChallenge !== "string" || !/^[0-9a-f]{32}$/u.test(context.loaderReadyChallenge) ||
    typeof context.snapshotLoaderCounters !== "function" || !Object.isFrozen(context.snapshotLoaderCounters)
  ) authorityFail("preseal inline launch facts were invalid");
  assertLaunchBindingShape(
    context.launcherBinding,
    "preseal-inline-launcher",
    DEFAULT_INLINE_LAUNCHER_PATH,
    "preseal inline launcher binding",
  );
  assertLaunchBindingShape(
    context.loaderBinding,
    "preseal-in-memory-loader",
    DEFAULT_IN_MEMORY_LOADER_PATH,
    "preseal in-memory loader binding",
  );
  assertLaunchBindingShape(
    context.runtimeBinding,
    "sealed-node-runtime",
    process.execPath,
    "preseal runtime binding",
  );
  if (context.loaderBinding.tuple[2] !== PRESEAL_IN_MEMORY_LOADER_SHA256 || context.loaderSha256 !== PRESEAL_IN_MEMORY_LOADER_SHA256) {
    authorityFail("preseal in-memory loader did not equal its fixed source hash");
  }
  if (!Array.isArray(context.sourceBindings) || context.sourceBindings.length !== CAPTURE_MODULE_GRAPH.length) {
    authorityFail("preseal inline source graph length was invalid");
  }
  for (const [index, [id, modulePath]] of CAPTURE_MODULE_GRAPH.entries()) {
    assertLaunchBindingShape(context.sourceBindings[index], id, modulePath, `preseal inline module binding ${id}`);
  }
  const evaluatedBytes = Buffer.from(process.execArgv[2], "utf8");
  if (
    evaluatedBytes.length !== context.launcherBinding.tuple[1] ||
    sha256(evaluatedBytes) !== context.launcherBinding.tuple[2]
  ) authorityFail("preseal evaluated launcher bytes did not equal the fixed source tuple");
  const expectedLaunchArgvSha256 = sha256(canonicalJsonBytes([
    "--input-type=module",
    "-e",
    `<inline-launcher:${context.launcherBinding.tuple[2]}>`,
  ]));
  const expectedExecutionGraphSha256 = sha256(canonicalJsonBytes({
    launcherBinding: context.launcherBinding.tuple,
    loaderBinding: context.loaderBinding.tuple,
    moduleBindings: context.sourceBindings.map((binding) => binding.tuple),
  }));
  const expectedReadyReceiptSha256 = sha256(canonicalJsonBytes({
    challenge: context.loaderReadyChallenge,
    executionGraphSha256: expectedExecutionGraphSha256,
    loaderSha256: context.loaderSha256,
    moduleCount: CAPTURE_MODULE_GRAPH.length,
    schemaVersion: PRESEAL_LOADER_READY_SCHEMA,
  }));
  if (
    context.launchArgvSha256 !== expectedLaunchArgvSha256 ||
    context.executionGraphSha256 !== expectedExecutionGraphSha256 ||
    context.loaderReadyReceiptSha256 !== expectedReadyReceiptSha256
  ) authorityFail("preseal inline launch digests did not reconstruct exactly");

  const launcherBinding = await stableBinding(DEFAULT_INLINE_LAUNCHER_PATH, "preseal-inline-launcher", {
    bytes: context.launcherBinding.tuple[1],
    sha256: context.launcherBinding.tuple[2],
  });
  const loaderBinding = await stableBinding(DEFAULT_IN_MEMORY_LOADER_PATH, "preseal-in-memory-loader", {
    bytes: context.loaderBinding.tuple[1],
    sha256: context.loaderBinding.tuple[2],
  });
  const runtimeBinding = await stableBinding(process.execPath, "sealed-node-runtime", {
    bytes: context.runtimeBinding.tuple[1],
    sha256: context.runtimeBinding.tuple[2],
  });
  const moduleBindings = [];
  for (const [index, [id, modulePath]] of CAPTURE_MODULE_GRAPH.entries()) {
    moduleBindings.push(await stableBinding(modulePath, id, {
      bytes: context.sourceBindings[index].tuple[1],
      sha256: context.sourceBindings[index].tuple[2],
    }));
  }
  for (const [actual, declared, label] of [
    [launcherBinding, context.launcherBinding, "inline launcher"],
    [loaderBinding, context.loaderBinding, "in-memory loader"],
    [runtimeBinding, context.runtimeBinding, "sealed runtime"],
    ...moduleBindings.map((binding, index) => [binding, context.sourceBindings[index], `module ${binding.id}`]),
  ]) {
    if (
      !samePath(actual.path, declared.path) || !isDeepStrictEqual(actual.identity, declared.identity) ||
      !isDeepStrictEqual(actual.tuple, declared.tuple)
    ) authorityFail(`preseal ${label} source replay did not equal its held launch binding`);
  }
  return deepFreeze({
    context,
    launcherBinding,
    loaderBinding,
    moduleBindings,
    runtimeBinding,
  });
}

async function heldBindingBytes(binding) {
  const bytes = await fs.readFile(binding.path);
  if (bytes.length !== binding.tuple[1] || sha256(bytes) !== binding.tuple[2]) {
    authorityFail(`${binding.id} held execution bytes did not equal its stable binding`);
  }
  await replayBinding(binding);
  return bytes;
}

function executionEnvelope(scriptBytes, coreBytes, planBytes) {
  const envelope = {
    coreBytes: coreBytes.toString("base64"),
    coreBytesLength: coreBytes.length,
    coreSha256: sha256(coreBytes),
    planBytes: planBytes.toString("base64"),
    planBytesLength: planBytes.length,
    planSha256: sha256(planBytes),
    schemaVersion: EXECUTION_ENVELOPE_SCHEMA,
    scriptBytes: scriptBytes.toString("base64"),
    scriptBytesLength: scriptBytes.length,
    scriptSha256: sha256(scriptBytes),
  };
  const bytes = canonicalJsonBytes(envelope);
  if (bytes.length < 1 || bytes.length > MAX_PLAN_BYTES) authorityFail("PowerShell execution envelope exceeded its byte bound");
  return bytes;
}

function encodedLoaderArgument() {
  return Buffer.from(POWERSHELL_IN_PROCESS_LOADER, "utf16le").toString("base64");
}

async function directoryIdentity(directoryPath, label) {
  const absolute = await assertNoReparseExistingPath(directoryPath, label);
  const stat = await fs.lstat(absolute, { bigint: true });
  if (!stat.isDirectory() || stat.isSymbolicLink()) authorityFail(`${label} is not one regular directory`);
  return {
    dev: stat.dev.toString(),
    ino: stat.ino.toString(),
  };
}

async function loadSameByteConfig(configPath) {
  const configBinding = await stableBinding(configPath, "config");
  const bytes = await fs.readFile(configBinding.path);
  if (bytes.length !== configBinding.tuple[1] || sha256(bytes) !== configBinding.tuple[2]) {
    authorityFail("fixed config bytes changed during retained snapshot read");
  }
  let snapshot;
  try {
    snapshot = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
  } catch {
    authorityFail("fixed config snapshot was not valid UTF-8 JSON");
  }
  const context = await loadManifestConfig(configBinding.path, {});
  if (!canonicalJsonBytes(snapshot).equals(canonicalJsonBytes(context.config))) {
    authorityFail("strict validator result did not equal the exact held config bytes");
  }
  await replayBinding(configBinding);
  assertSealedSystemToolAuthority(context.config.root?.hostToolchain);
  return { binding: configBinding, bytes, context };
}

function systemToolSourcePaths(systemRoot, tool) {
  return tool.logicalPaths.map((logicalPath) => {
    if (!logicalPath.startsWith("windows/")) authorityFail("system tool logical path escaped windows root");
    return path.join(systemRoot, ...logicalPath.slice("windows/".length).split("/"));
  });
}

async function verifySourcePair(systemRoot, id, tool) {
  const sourcePaths = systemToolSourcePaths(systemRoot, tool);
  const facts = [];
  for (const [index, sourcePath] of sourcePaths.entries()) {
    const binding = await stableBinding(sourcePath, `${id}-source-${index}`, {
      bytes: tool.bytes,
      sha256: tool.sha256,
    }, { requireSingleLink: false });
    if (binding.identity.nlink !== String(tool.hardlinkCount)) {
      authorityFail(`${id} source link count changed`);
    }
    facts.push(binding);
  }
  if (!isDeepStrictEqual(facts[0].identity, facts[1].identity)) {
    authorityFail(`${id} serviced aliases did not share one stable identity`);
  }
  return { facts, id, sourcePaths, tool };
}

async function replaySourcePair(pair) {
  for (const binding of pair.facts) await replayBinding(binding);
}

function normalizedExclusions(context) {
  const activeRepository = exactLocalPath(context.locations.repo, "active repository");
  const codexDefault = path.join(os.homedir(), ".codex");
  const claudeDefault = path.join(os.homedir(), ".claude");
  const values = [
    ["provider-codex-configured-home", process.env.CODEX_HOME ?? codexDefault],
    ["provider-codex-default-home", codexDefault],
    ["provider-claude-configured-home", process.env.CLAUDE_CONFIG_DIR ?? claudeDefault],
    ["provider-claude-default-home", claudeDefault],
    ["stable-repository", path.join(path.dirname(activeRepository), "PC-SDK")],
    ["active-repository", activeRepository],
  ];
  return values.map(([id, candidate]) => ({ id, path: exactLocalPath(candidate, `${id} exclusion`) }));
}

function validateAuditPlan(plan, providerRoots = [], pnpmStoreRoots = []) {
  assertExactKeys(plan, ["schemaVersion", "sources"], "filesystem audit plan");
  if (plan.schemaVersion !== FILESYSTEM_AUDIT_PLAN_SCHEMA || !Array.isArray(plan.sources) || plan.sources.length < 1 || plan.sources.length > 512) {
    authorityFail("filesystem audit plan source closure was invalid");
  }
  const ids = new Set();
  let selectedCount = 0;
  for (const [index, source] of plan.sources.entries()) {
    const keys = ["files", "logicalPrefix", "mode", "rootPath", "sourceId", "sourceIndex", "surfaceId"];
    if (Object.hasOwn(source, "identityPolicy")) keys.push("identityPolicy");
    assertExactKeys(source, keys, `filesystem audit source ${index}`);
    assertIdentifier(source.sourceId, `filesystem audit source ${index} id`);
    assertIdentifier(source.surfaceId, `filesystem audit source ${index} surface`);
    if (ids.has(source.sourceId)) authorityFail("filesystem audit plan repeated a source id");
    ids.add(source.sourceId);
    if (!Number.isSafeInteger(source.sourceIndex) || source.sourceIndex < 0 || source.sourceIndex > 4095) authorityFail("filesystem audit source index was invalid");
    if (!["files", "tree", "empty-tree"].includes(source.mode)) authorityFail("filesystem audit source mode was invalid");
    const sourceRoot = exactLocalPath(source.rootPath, `filesystem audit source ${source.sourceId} root`);
    if (providerRoots.some((providerRoot) => isPathWithin(sourceRoot, providerRoot) || isPathWithin(providerRoot, sourceRoot))) {
      authorityFail("filesystem audit source root overlaps a forbidden provider home");
    }
    if (typeof source.logicalPrefix !== "string" || source.logicalPrefix.includes("\\") || source.logicalPrefix.includes("\0")) authorityFail("filesystem audit logical prefix was invalid");
    if (!Array.isArray(source.files)) authorityFail("filesystem audit source files were invalid");
    if ((source.mode === "tree" || source.mode === "empty-tree") && source.files.length !== 0) authorityFail("filesystem tree source listed files");
    if (source.mode === "files" && source.files.length === 0) authorityFail("filesystem files source was empty");
    const sorted = [...source.files].sort(ordinalCompare);
    const caseFolded = new Set(source.files.map((entry) => typeof entry === "string" ? entry.toLocaleLowerCase("en-US") : entry));
    if (!isDeepStrictEqual(sorted, source.files) || new Set(source.files).size !== source.files.length || caseFolded.size !== source.files.length) {
      authorityFail("filesystem source files were not exact ordinal case-insensitive unique paths");
    }
    for (const file of source.files) {
      if (typeof file !== "string" || file.length === 0 || file.includes("\\") || file.includes(":") || file.split("/").some((part) => part === "" || part === "." || part === "..")) {
        authorityFail("filesystem source contained an invalid relative path");
      }
    }
    if (Object.hasOwn(source, "identityPolicy")) {
      const policy = source.identityPolicy;
      if (policy?.kind === "pnpm-content-addressed-store-hardlink-v1") {
        assertExactKeys(policy, ["kind"], "filesystem pnpm store identity policy");
        if (
          source.mode !== "tree" || source.surfaceId !== "pnpm-store-v10" ||
          !pnpmStoreRoots.some((root) => samePath(sourceRoot, root))
        ) authorityFail("filesystem pnpm store identity policy escaped its exact config-bound tree root");
      } else {
        assertExactKeys(policy, ["kind", "linkCount", "relativePaths"], "filesystem identity policy");
        const aliasSurfaceAllowed =
          (policy.kind === "windows-servicing-hardlink-v1" && ["authenticode-verification-tool", "process-tree-termination-tool"].includes(source.surfaceId)) ||
          (policy.kind === "git-for-windows-runtime-hardlink-v1" && source.surfaceId === "git-execution-closure");
        if (
          source.mode !== "files" || policy.linkCount !== 2 || !aliasSurfaceAllowed ||
          !isDeepStrictEqual(policy.relativePaths, source.files) || source.files.length !== 2
        ) authorityFail("filesystem identity policy was not one exact admitted alias exception");
      }
    }
    selectedCount += source.files.length;
    if (selectedCount > 200_000) authorityFail("filesystem audit plan exceeded its file cap");
  }
  return plan;
}

function parseOneLineJson(bytes, label) {
  const input = Buffer.from(bytes);
  if (input.length < 1 || (input.length >= 3 && input[0] === 0xef && input[1] === 0xbb && input[2] === 0xbf)) {
    authorityFail(`${label} was empty or BOM-prefixed`);
  }
  let text = new TextDecoder("utf-8", { fatal: true }).decode(input);
  if (text.endsWith("\r\n")) text = text.slice(0, -2);
  else if (text.endsWith("\n")) text = text.slice(0, -1);
  if (text.includes("\r") || text.includes("\n")) authorityFail(`${label} was not one JSON line`);
  let value;
  try {
    value = JSON.parse(text);
  } catch {
    authorityFail(`${label} was not valid JSON`);
  }
  if (!canonicalJsonBytes(value).equals(Buffer.from(text, "utf8"))) {
    authorityFail(`${label} was not exact canonical JSON`);
  }
  return value;
}

function parseCanonicalDocument(bytes, maximumBytes, label, maximumMembers) {
  const input = Buffer.from(bytes);
  if (input.length < 1 || input.length > maximumBytes) authorityFail(`${label} exceeded its exact byte bound`);
  let value;
  try {
    value = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(input));
  } catch {
    authorityFail(`${label} was not valid UTF-8 JSON`);
  }
  if (value === null || typeof value !== "object" || Array.isArray(value) || !canonicalJsonBytes(value).equals(input)) {
    authorityFail(`${label} was not one exact canonical JSON object`);
  }
  if (maximumMembers !== undefined && countPresealPayloadMembers(value) > maximumMembers) {
    authorityFail(`${label} exceeded its fixed recursive member bound`);
  }
  return value;
}

function validatePathPolicyPlan(plan, cacheRoot, providerRoots, admittedOutputs) {
  assertExactKeys(plan, ["exclusions", "paths", "schemaVersion"], "path policy plan");
  if (
    plan.schemaVersion !== PATH_POLICY_SCHEMA ||
    !Array.isArray(plan.paths) || plan.paths.length < 1 || plan.paths.length > 32 ||
    !Array.isArray(plan.exclusions) || plan.exclusions.length > 16
  ) authorityFail("path policy plan closure was invalid");
  const ids = new Set();
  const normalized = [];
  for (const [collectionName, entries, exclusion] of [
    ["paths", plan.paths, false],
    ["exclusions", plan.exclusions, true],
  ]) {
    for (const [index, entry] of entries.entries()) {
      assertExactKeys(entry, ["id", "mustExist", "path", "role"], `path policy ${collectionName} ${index}`);
      assertIdentifier(entry.id, `path policy ${collectionName} ${index} id`);
      if (ids.has(entry.id)) authorityFail("path policy repeated an id");
      ids.add(entry.id);
      if (typeof entry.mustExist !== "boolean") authorityFail("path policy mustExist was invalid");
      if ((exclusion && entry.role !== "exclusion") || (!exclusion && !["input", "output"].includes(entry.role))) {
        authorityFail("path policy role was invalid");
      }
      const absolute = exactLocalPath(entry.path, `path policy ${entry.id}`);
      normalized.push({ ...entry, absolute, exclusion });
    }
  }
  const exclusions = normalized.filter((entry) => entry.exclusion);
  const inputs = normalized.filter((entry) => !entry.exclusion && entry.role === "input");
  const outputs = normalized.filter((entry) => !entry.exclusion && entry.role === "output");
  for (const input of inputs) {
    if (providerRoots.some((root) => isPathWithin(input.absolute, root) || isPathWithin(root, input.absolute))) {
      authorityFail("path policy input overlapped a forbidden provider home");
    }
  }
  if (!isDeepStrictEqual(
    outputs.map((entry) => entry.id).sort(ordinalCompare),
    [...admittedOutputs.keys()].sort(ordinalCompare),
  )) authorityFail("path policy output-id closure was incomplete");
  const outputPaths = new Set();
  for (const output of outputs) {
    const admitted = admittedOutputs.get(output.id);
    if (admitted === undefined || !samePath(output.absolute, admitted)) authorityFail("path policy output did not equal its closed authority path");
    const foldedOutput = output.absolute.toLowerCase();
    if (outputPaths.has(foldedOutput)) authorityFail("path policy repeated an output path");
    outputPaths.add(foldedOutput);
    if (providerRoots.some((root) => isPathWithin(output.absolute, root) || isPathWithin(root, output.absolute))) {
      authorityFail("path policy output overlapped a forbidden provider home");
    }
    for (const excluded of exclusions) {
      if (isPathWithin(output.absolute, excluded.absolute) || isPathWithin(excluded.absolute, output.absolute)) {
        authorityFail("path policy output overlapped an exclusion");
      }
    }
    for (const input of inputs) {
      const overlap = isPathWithin(output.absolute, input.absolute) || isPathWithin(input.absolute, output.absolute);
      const admittedInputParent =
        ["cache-root", "receipt-directory"].includes(input.id) &&
        isPathWithin(output.absolute, input.absolute) &&
        !samePath(output.absolute, input.absolute);
      if (overlap && !admittedInputParent) authorityFail("path policy output overlapped a non-parent input");
    }
  }
  return plan;
}

function parsePathPolicyReceipt(bytes, plan) {
  const receipt = parseOneLineJson(bytes, "path policy receipt");
  if (receipt?.ok === false) {
    assertExactKeys(receipt, ["code", "ok", "schemaVersion"], "path policy failure receipt");
    if (receipt.schemaVersion !== PATH_POLICY_SCHEMA || typeof receipt.code !== "string" || !/^[a-z0-9-]{1,64}$/u.test(receipt.code)) {
      authorityFail("path policy failure receipt was malformed");
    }
    authorityFail(`path policy rejected the run: ${receipt.code}`);
  }
  assertExactKeys(receipt, ["facts", "ok", "schemaVersion"], "path policy receipt");
  if (receipt.ok !== true || receipt.schemaVersion !== PATH_POLICY_SCHEMA || !Array.isArray(receipt.facts) || receipt.facts.length !== plan.paths.length) {
    authorityFail("path policy receipt closure mismatch");
  }
  for (const [index, fact] of receipt.facts.entries()) {
    const expected = plan.paths[index];
    assertExactKeys(fact, ["exists", "fixedVolume", "id", "noReparseComponents", "role", "unnamedStreamOnly"], `path policy fact ${index}`);
    if (
      fact.id !== expected.id || fact.role !== expected.role || fact.exists !== expected.mustExist ||
      fact.fixedVolume !== true || fact.noReparseComponents !== true || fact.unnamedStreamOnly !== true
    ) authorityFail(`path policy fact ${index} mismatch`);
  }
  return receipt;
}

function parseAuthenticodeReceipt(bytes) {
  const receipt = parseOneLineJson(bytes, "Authenticode receipt");
  if (receipt?.ok === false) {
    assertExactKeys(receipt, ["code", "ok", "schemaVersion"], "Authenticode failure receipt");
    if (receipt.schemaVersion !== AUTHENTICODE_RECEIPT_SCHEMA || typeof receipt.code !== "string" || !/^[a-z0-9-]{1,64}$/u.test(receipt.code)) {
      authorityFail("Authenticode failure receipt was malformed");
    }
    authorityFail(`Authenticode probe rejected the run: ${receipt.code}`);
  }
  assertExactKeys(receipt, ["facts", "osBound", "schemaVersion"], "Authenticode receipt");
  if (receipt.osBound !== true || receipt.schemaVersion !== AUTHENTICODE_RECEIPT_SCHEMA || !Array.isArray(receipt.facts) || receipt.facts.length !== 4) {
    authorityFail("Authenticode receipt closure mismatch");
  }
  const expectedIds = ["node", "python", "powershell-private", "taskkill-private"];
  for (const [index, fact] of receipt.facts.entries()) {
    assertExactKeys(fact, ["certificateSubject", "embeddedFileVersion", "id", "serial", "status", "subject", "thumbprint"], `Authenticode fact ${index}`);
    if (
      fact.id !== expectedIds[index] ||
      !["certificateSubject", "embeddedFileVersion", "serial", "status", "subject", "thumbprint"].every((key) => typeof fact[key] === "string" && fact[key].length > 0)
    ) authorityFail(`Authenticode fact ${index} mismatch`);
  }
  return receipt;
}

function cloneClosedEnvironment(value, systemRoot, tempRoot) {
  if (value === null || typeof value !== "object" || Array.isArray(value) || Object.getPrototypeOf(value) !== Object.prototype) {
    authorityFail("native command environment was not a plain object");
  }
  const output = {};
  const folded = new Set();
  for (const [name, setting] of Object.entries(value)) {
    const foldedName = name.toUpperCase();
    if (!/^[A-Za-z_][A-Za-z0-9_()]*$/u.test(name) || folded.has(foldedName) || typeof setting !== "string" || setting.includes("\0")) {
      authorityFail("native command environment was malformed");
    }
    if (/^(?:ANTHROPIC|CLAUDE|CODEX|OPENAI)(?:_|$)/u.test(foldedName)) {
      authorityFail("native command environment contained provider state");
    }
    folded.add(foldedName);
    output[name] = setting;
  }
  const lookup = new Map(Object.entries(output).map(([name, setting]) => [name.toUpperCase(), setting]));
  for (const [name, expected] of [["SYSTEMROOT", systemRoot], ["WINDIR", systemRoot], ["TEMP", tempRoot], ["TMP", tempRoot]]) {
    const actual = lookup.get(name);
    if (typeof actual !== "string" || !samePath(actual, expected)) authorityFail(`native command ${name} was not authority-bound`);
  }
  return output;
}

function expectedPrivateToolTuples(tools) {
  return tools.map((tool) => [
    `run-private/system-tools/${tool.destinationFileName}`,
    tool.bytes,
    tool.sha256,
  ]).sort((left, right) => ordinalCompare(left[0], right[0]));
}

function validateReceiptTuple(tuple, label) {
  if (
    !Array.isArray(tuple) || tuple.length !== 3 ||
    typeof tuple[0] !== "string" || tuple[0].length === 0 || tuple[0].includes("\\") ||
    !Number.isSafeInteger(tuple[1]) || tuple[1] < 1 ||
    typeof tuple[2] !== "string" || !SHA256_PATTERN.test(tuple[2])
  ) authorityFail(`${label} tuple was invalid`);
}

function parseBootstrapReceipt(bytes, expected) {
  const receipt = parseOneLineJson(bytes, "bootstrap receipt");
  if (receipt?.ok === false) {
    assertExactKeys(receipt, ["code", "message", "ok", "schemaVersion"], "bootstrap failure receipt");
    if (
      receipt.schemaVersion !== SYSTEM_TOOL_BOOTSTRAP_RECEIPT_SCHEMA ||
      typeof receipt.code !== "string" || !/^[a-z0-9-]{1,64}$/u.test(receipt.code) ||
      typeof receipt.message !== "string" || receipt.message.length > 256
    ) authorityFail("bootstrap failure receipt was malformed");
    authorityFail(`bootstrap worker rejected authority: ${receipt.code}`);
  }
  assertExactKeys(receipt, [
    "bindings",
    "copyFacts",
    "helperProcessCount",
    "ok",
    "pathPolicy",
    "privateAfter",
    "runLeaf",
    "schemaVersion",
    "sourceAfter",
    "sourceBefore",
  ], "bootstrap receipt");
  if (
    receipt.ok !== true ||
    receipt.schemaVersion !== SYSTEM_TOOL_BOOTSTRAP_RECEIPT_SCHEMA ||
    receipt.runLeaf !== expected.runLeaf ||
    receipt.helperProcessCount !== 0
  ) authorityFail("bootstrap receipt status/run/helper proof was invalid");
  assertExactKeys(receipt.pathPolicy, [
    "authorityParentStable",
    "fixedLocalNtfs",
    "noForbiddenOverlap",
    "noReparseComponents",
    "outputsAbsentBefore",
    "outputsExactAfter",
    "runRootDirectChild",
  ], "bootstrap path-policy receipt");
  if (Object.values(receipt.pathPolicy).some((value) => value !== true)) {
    authorityFail("bootstrap path-policy receipt did not positively prove every invariant");
  }
  if (!isDeepStrictEqual(receipt.bindings, expected.bindings)) authorityFail("bootstrap binding tuples mismatch");
  for (const phase of ["sourceBefore", "sourceAfter"]) {
    const sources = receipt[phase];
    if (!Array.isArray(sources) || sources.length !== expected.sourceFacts.length) authorityFail(`bootstrap ${phase} closure mismatch`);
    for (const [index, source] of sources.entries()) {
      assertExactKeys(source, ["id", "identityToken", "tuples"], `bootstrap ${phase} source ${index}`);
      if (
        source.id !== expected.sourceFacts[index].id ||
        typeof source.identityToken !== "string" || source.identityToken.length < 1 || source.identityToken.length > 256 ||
        !isDeepStrictEqual(source.tuples, expected.sourceFacts[index].tuples)
      ) authorityFail(`bootstrap ${phase} source ${index} mismatch`);
      source.tuples.forEach((tuple, tupleIndex) => validateReceiptTuple(tuple, `bootstrap ${phase} source ${index}/${tupleIndex}`));
    }
  }
  if (!isDeepStrictEqual(receipt.sourceBefore, receipt.sourceAfter)) {
    authorityFail("bootstrap serviced source identity/tuple replay mismatch");
  }
  assertExactKeys(receipt.privateAfter, ["identityPolicy", "tuples"], "bootstrap private audit");
  if (
    receipt.privateAfter.identityPolicy !== SEALED_SYSTEM_TOOL_AUTHORITY.servicedSystemToolPolicy.privateCopyIdentity ||
    !isDeepStrictEqual(receipt.privateAfter.tuples, expected.privateTuples)
  ) authorityFail("bootstrap private exact-tree closure mismatch");
  receipt.privateAfter.tuples.forEach((tuple, index) => validateReceiptTuple(tuple, `bootstrap private ${index}`));
  if (!Array.isArray(receipt.copyFacts) || receipt.copyFacts.length !== expected.tools.length) authorityFail("bootstrap copy facts mismatch");
  for (const [index, fact] of receipt.copyFacts.entries()) {
    assertExactKeys(fact, ["exclusiveCreate", "flushToDisk", "id", "privateStable", "sourceStable"], `bootstrap copy fact ${index}`);
    if (
      fact.id !== expected.tools[index].id ||
      fact.exclusiveCreate !== true || fact.flushToDisk !== true || fact.privateStable !== true || fact.sourceStable !== true
    ) authorityFail(`bootstrap copy fact ${index} was not positive`);
  }
  return receipt;
}

function commandFact(plan, result, {
  entryBinding,
  entryPlanSha256,
  executionAuthority,
  inProcessLoader = false,
  logicalArgv,
  logicalize = (value) => value,
  operationId,
}) {
  if (inProcessLoader && (plan.args.at(-2) !== "-EncodedCommand" || plan.args.at(-1) !== encodedLoaderArgument())) {
    authorityFail("PowerShell command did not use the exact in-process loader argument");
  }
  if (inProcessLoader && (typeof entryPlanSha256 !== "string" || !SHA256_PATTERN.test(entryPlanSha256))) {
    authorityFail("PowerShell command did not bind one logical entry plan");
  }
  if (!inProcessLoader && entryPlanSha256 !== undefined) authorityFail("native command carried a PowerShell entry-plan binding");
  if (logicalArgv !== undefined && (
    !Array.isArray(logicalArgv) || logicalArgv.length !== plan.args.length ||
    logicalArgv.some((entry) => typeof entry !== "string")
  )) authorityFail("command logical argv closure was invalid");
  const argv = logicalArgv === undefined ? plan.args.map((entry) => logicalize(entry)) : [...logicalArgv];
  if (inProcessLoader) argv[argv.length - 1] = `<in-process-loader:${POWERSHELL_IN_PROCESS_LOADER_SHA256}>`;
  const fact = {
    argv,
    cleanupErrorCode: result.cleanupErrorCode,
    cleanupOutcome: result.cleanupOutcome,
    commandTimeoutMs: result.commandTimeoutMs,
    cwd: logicalize(plan.cwd),
    durationMs: result.durationMs,
    envProjectionNames: Object.keys(plan.env).sort(ordinalCompare),
    executableId: operationId,
    executionAuthority,
    exitCode: result.exitCode,
    overflow: result.overflow,
    ownedRootExitObserved: result.ownedRootExitObserved,
    ownedRootExitTimeoutMs: result.ownedRootExitTimeoutMs,
    shell: false,
    signal: result.signal,
    stderr: { bytes: result.stderr.length, sha256: sha256(result.stderr) },
    stdout: { bytes: result.stdout.length, sha256: sha256(result.stdout) },
    timedOut: result.timedOut,
    terminationPolicyId: result.terminationPolicyId,
    terminationReason: result.terminationReason,
    terminationRequested: result.terminationRequested,
    terminationToolCompletionObserved: result.terminationToolCompletionObserved,
    terminationToolExitCode: result.terminationToolExitCode,
    terminationToolId: result.terminationToolId,
    terminationToolSignal: result.terminationToolSignal,
    terminationToolTimeoutMs: result.terminationToolTimeoutMs,
  };
  if (plan.stdin !== undefined) fact.stdin = { bytes: Buffer.byteLength(plan.stdin), sha256: sha256(plan.stdin) };
  if (entryBinding !== undefined) fact.entryBinding = entryBinding;
  if (inProcessLoader) {
    fact.entryPlanSha256 = entryPlanSha256;
    fact.inProcessLoaderSha256 = POWERSHELL_IN_PROCESS_LOADER_SHA256;
  }
  if (result.terminationToolReceipt !== null) fact.terminationToolReceipt = result.terminationToolReceipt;
  return deepFreeze(fact);
}

function bindingExecutionAuthority(binding, kind, identityPolicy = NATIVE_EXECUTABLE_IDENTITY_POLICY) {
  return deepFreeze({
    bytes: binding.tuple[1],
    identityPolicy,
    kind,
    sha256: binding.tuple[2],
  });
}

function scriptEntryBinding(binding) {
  return deepFreeze({
    bytes: binding.tuple[1],
    id: binding.id,
    identityPolicy: NATIVE_EXECUTABLE_IDENTITY_POLICY,
    sha256: binding.tuple[2],
  });
}

function privateToolAuditPlan(privateToolRoot) {
  return {
    schemaVersion: FILESYSTEM_AUDIT_PLAN_SCHEMA,
    sources: [{
      files: [],
      logicalPrefix: "run-private/system-tools",
      mode: "tree",
      rootPath: privateToolRoot,
      sourceId: "private-system-tools",
      sourceIndex: 0,
      surfaceId: "private-system-tools",
    }],
  };
}

async function prepareFixedSystemToolAuthority(purpose) {
  if (!["filesystem-audit", "preseal-capture"].includes(purpose)) authorityFail("system tool authority purpose was invalid");
  const captureMode = purpose === "preseal-capture";
  if (process.platform !== "win32") authorityFail("64-bit Windows is required");
  const launchExecution = captureMode ? await validatePresealInlineLaunchContext() : undefined;
  const authenticodePath = DEFAULT_AUTHENTICODE_PATH;
  const bootstrapPath = DEFAULT_BOOTSTRAP_PATH;
  const configPath = DEFAULT_CONFIG_PATH;
  const corePath = DEFAULT_CORE_PATH;
  const pathPolicyPath = DEFAULT_PATH_POLICY_PATH;
  const runLeaf = randomBytes(16).toString("hex");
  const workerPath = DEFAULT_WORKER_PATH;
  if (!/^[0-9a-f]{32}$/u.test(runLeaf)) authorityFail("run leaf must be 128-bit lowercase hexadecimal");
  const configSnapshot = await loadSameByteConfig(configPath);
  const context = configSnapshot.context;
  if (captureMode && context.config.root.provenance.presealReceipt?.status !== "pending") {
    authorityFail("preseal capture requires the exact pending one-way receipt state");
  }
  const configProjectionBytes = canonicalJsonBytes(presealConfigAuthorityProjection(context.config));
  const expectedConfigAuthority = deepFreeze({
    algorithm: PRESEAL_CONFIG_AUTHORITY_PROJECTION_ALGORITHM,
    capturedConfig: { bytes: configSnapshot.bytes.length, sha256: sha256(configSnapshot.bytes) },
    projection: { bytes: configProjectionBytes.length, sha256: sha256(configProjectionBytes) },
  });
  const systemRoot = exactLocalPath(context.locations.system, "fixed Windows root");
  const ambientSystemRoot = process.env.SystemRoot ?? process.env.WINDIR;
  if (typeof ambientSystemRoot !== "string" || !samePath(ambientSystemRoot, systemRoot)) {
    authorityFail("ambient Windows root did not equal strict config authority");
  }
  const cacheRoot = exactLocalPath(context.locations.cache, "fixed cache root");
  const receiptDirectory = exactLocalPath(context.locations.preseal, "fixed preseal receipt directory");
  const receiptParent = path.dirname(receiptDirectory);
  if (!samePath(receiptParent, path.join(cacheRoot, "preseal"))) {
    authorityFail("fixed preseal receipt parent did not equal the cache authority");
  }
  const receiptParentIdentity = await directoryIdentity(receiptParent, "preseal receipt parent");
  try {
    await fs.mkdir(receiptDirectory, { recursive: false });
  } catch (error) {
    if (error?.code !== "EEXIST") throw error;
  }
  const receiptDirectoryIdentity = await directoryIdentity(receiptDirectory, "preseal receipt directory");
  const payloadName = `cx004-preseal-${runLeaf}.payload.json`;
  const rootName = `cx004-preseal-${runLeaf}.json`;
  const payloadPath = path.join(receiptDirectory, payloadName);
  const rootPath = path.join(receiptDirectory, rootName);
  const payloadTemporaryPath = path.join(receiptDirectory, `.${payloadName}.${randomBytes(12).toString("hex")}.tmp`);
  const rootTemporaryPath = path.join(receiptDirectory, `.${rootName}.${randomBytes(12).toString("hex")}.tmp`);
  for (const [candidate, label] of [
    [payloadPath, "payload final"],
    [rootPath, "root final"],
    [payloadTemporaryPath, "payload temporary"],
    [rootTemporaryPath, "root temporary"],
  ]) {
    try {
      await fs.lstat(candidate);
      authorityFail(`${label} path was not fresh`);
    } catch (error) {
      if (error?.code !== "ENOENT") throw error;
    }
  }
  const authorityParent = path.join(cacheRoot, "runs");
  const parentIdentity = await directoryIdentity(authorityParent, "authority parent");
  const bootstrapScratchRoot = path.join(systemRoot, "Temp");
  await directoryIdentity(bootstrapScratchRoot, "bootstrap scratch root");
  const runRoot = path.join(authorityParent, runLeaf);
  const privateToolRoot = path.join(runRoot, "system-tools");
  const tempRoot = path.join(runRoot, "temp");
  for (const [candidate, label] of [[runRoot, "run root"], [privateToolRoot, "private tool root"], [tempRoot, "private temp root"]]) {
    try {
      await fs.lstat(candidate);
      authorityFail(`${label} was not fresh`);
    } catch (error) {
      if (error?.code !== "ENOENT") throw error;
    }
  }

  const bindings = [
    configSnapshot.binding,
    await stableBinding(bootstrapPath, "bootstrap-wrapper"),
    await stableBinding(corePath, "audit-core"),
    await stableBinding(workerPath, "audit-worker"),
  ];
  const entryBindings = {
    authenticode: await stableBinding(authenticodePath, "authenticode-probe"),
    pathPolicy: await stableBinding(pathPolicyPath, "path-policy-probe"),
  };
  const loadedModuleBindings = captureMode ? launchExecution.moduleBindings : [];
  const captureBinding = loadedModuleBindings.find((binding) => binding.id === "preseal-capture-entry");
  if (captureMode && captureBinding === undefined) authorityFail("preseal capture entry module binding was unavailable");
  const allFixedBindings = [
    ...bindings,
    entryBindings.authenticode,
    entryBindings.pathPolicy,
    ...(captureMode ? [
      launchExecution.launcherBinding,
      launchExecution.loaderBinding,
      launchExecution.runtimeBinding,
    ] : []),
    ...loadedModuleBindings,
  ];
  const powershellPair = await verifySourcePair(systemRoot, "powershell", SEALED_SYSTEM_TOOL_AUTHORITY.authenticodeVerificationTool);
  const taskkillPair = await verifySourcePair(systemRoot, "taskkill", SEALED_SYSTEM_TOOL_AUTHORITY.processTreeTerminationTool);
  const sourcePairs = [powershellPair, taskkillPair];
  const tools = sourcePairs.map((pair) => ({
    bytes: pair.tool.bytes,
    destinationFileName: pair.tool.privateCopyFileName,
    id: pair.id,
    privateLinkCount: 1,
    sha256: pair.tool.sha256,
    sourceLinkCount: pair.tool.hardlinkCount,
    sourceRelativePaths: pair.tool.logicalPaths.map((logicalPath) => logicalPath.slice("windows/".length)),
  }));
  const pathPolicy = {
    exclusions: normalizedExclusions(context),
    inputs: [
      { id: "authority-parent", path: authorityParent },
      { id: "bootstrap-scratch-root", path: bootstrapScratchRoot },
      { id: "system-root", path: systemRoot },
      ...bindings.map((binding) => ({ id: binding.id, path: binding.path })),
      ...powershellPair.sourcePaths.map((sourcePath, index) => ({ id: `powershell-source-${index}`, path: sourcePath })),
      ...taskkillPair.sourcePaths.map((sourcePath, index) => ({ id: `taskkill-source-${index}`, path: sourcePath })),
    ],
    outputs: [
      { id: "run-root", path: runRoot },
      { id: "private-tool-root", path: privateToolRoot },
      { id: "temp-root", path: tempRoot },
    ],
  };
  const logicalizePowerShellPlanValue = createLogicalizer({
    "<payload-final>": payloadPath,
    "<payload-temporary>": payloadTemporaryPath,
    "<root-final>": rootPath,
    "<root-temporary>": rootTemporaryPath,
    "<run>": runRoot,
    "<repo>": context.locations.repo,
    "<cache>": cacheRoot,
    "<git>": context.locations.git,
    "<system>": systemRoot,
    ...Object.fromEntries(pathPolicy.exclusions.map((entry) => [`<exclusion:${entry.id}>`, entry.path])),
  });
  const plan = {
    authorityParent,
    bindings: bindings.map((binding) => ({
      bytes: binding.tuple[1],
      id: binding.id,
      path: binding.path,
      sha256: binding.tuple[2],
    })),
    bootstrapScratchRoot,
    pathPolicy,
    privateToolRoot,
    runLeaf,
    runRoot,
    schemaVersion: SYSTEM_TOOL_BOOTSTRAP_PLAN_SCHEMA,
    systemRoot,
    tempRoot,
    tools,
  };
  const planBytes = canonicalJsonBytes(plan);
  if (planBytes.length < 1 || planBytes.length > MAX_PLAN_BYTES) authorityFail("bootstrap plan exceeded its byte bound");
  const policy = SEALED_SYSTEM_TOOL_AUTHORITY.servicedSystemToolPolicy;
  const bootstrapEnvironment = {
    SYSTEMROOT: systemRoot,
    TEMP: bootstrapScratchRoot,
    TMP: bootstrapScratchRoot,
    WINDIR: systemRoot,
  };
  const bootstrapScriptBytes = await heldBindingBytes(bindings[1]);
  const bootstrapCoreBytes = await heldBindingBytes(bindings[2]);
  const bootstrapCommandPlan = {
    args: ["-NoLogo", "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-EncodedCommand", encodedLoaderArgument()],
    cwd: bootstrapScratchRoot,
    env: bootstrapEnvironment,
    executable: powershellPair.sourcePaths[0],
    shell: false,
    stdin: executionEnvelope(bootstrapScriptBytes, bootstrapCoreBytes, planBytes),
  };
  let cleanupCertain = true;
  let bootstrapResult;
  try {
    bootstrapResult = await runCommand(bootstrapCommandPlan, {
      maxOutputBytes: 16 * 1024 * 1024,
      ownedRootExitTimeoutMs: policy.ownedRootExitTimeoutMs,
      terminationAuthority: {
        cwd: bootstrapScratchRoot,
        env: bootstrapEnvironment,
        executable: taskkillPair.sourcePaths[0],
        executableId: "taskkill-source-bootstrap-failure-only",
        policyId: policy.terminationInvocation,
      },
      terminationToolTimeoutMs: policy.terminationToolTimeoutMs,
      timeoutMs: 120_000,
    });
  } catch (error) {
    cleanupCertain = false;
    throw error;
  }
  const commandFacts = [commandFact(bootstrapCommandPlan, bootstrapResult, {
    entryBinding: scriptEntryBinding(bindings[1]),
    entryPlanSha256: logicalEntryPlanSha256(plan, logicalizePowerShellPlanValue),
    executionAuthority: bindingExecutionAuthority(
      powershellPair.facts[0],
      "powershell-source-bootstrap",
      policy.sourceIdentity,
    ),
    inProcessLoader: true,
    logicalize: (value) => samePath(value, bootstrapScratchRoot) ? "<bootstrap-scratch>" : value,
    operationId: "system-tool-authority-bootstrap",
  })];
  if (
    bootstrapResult.exitCode !== 0 || bootstrapResult.signal !== null || bootstrapResult.timedOut || bootstrapResult.overflow ||
    bootstrapResult.stderr.length !== 0 || bootstrapResult.cleanupOutcome !== "not-required" ||
    bootstrapResult.terminationRequested || !bootstrapResult.ownedRootExitObserved
  ) authorityFail(`source PowerShell bootstrap did not close cleanly without cleanup (exit=${String(bootstrapResult.exitCode)} stdout=${bootstrapResult.stdout.toString("utf8").replaceAll("\r", " ").replaceAll("\n", " ").slice(0, 512)} stderr=${bootstrapResult.stderr.toString("utf8").replaceAll("\r", " ").replaceAll("\n", " ").slice(0, 512)})`);
  const expectedReceipt = {
    bindings: bindings.map((binding) => binding.tuple),
    privateTuples: expectedPrivateToolTuples(tools),
    runLeaf,
    sourceFacts: sourcePairs.map((pair) => ({
      id: pair.id,
      tuples: pair.tool.logicalPaths.map((logicalPath) => [logicalPath, pair.tool.bytes, pair.tool.sha256]),
    })),
    tools,
  };
  const bootstrapReceipt = parseBootstrapReceipt(bootstrapResult.stdout, expectedReceipt);
  for (const binding of allFixedBindings) await replayBinding(binding);
  for (const pair of sourcePairs) await replaySourcePair(pair);
  const privateBindings = await Promise.all(tools.map((tool) => stableBinding(
    path.join(privateToolRoot, tool.destinationFileName),
    `${tool.id}-private`,
    { bytes: tool.bytes, sha256: tool.sha256 },
  )));
  const privateEnvironment = deepFreeze({
    SYSTEMROOT: systemRoot,
    TEMP: tempRoot,
    TMP: tempRoot,
    WINDIR: systemRoot,
  });
  const privatePowerShellPath = privateBindings[0].path;
  const privateTaskkillPath = privateBindings[1].path;
  const runRootIdentity = await directoryIdentity(runRoot, "authority run root");
  const providerRoots = pathPolicy.exclusions
    .filter((entry) => entry.id.startsWith("provider-"))
    .map((entry) => entry.path);
  const pnpmStoreSurface = context.config.surfaces.find((surface) => surface.surfaceId === "pnpm-store-v10");
  if (pnpmStoreSurface === undefined || pnpmStoreSurface.sources.length < 1) authorityFail("pnpm store surface authority was unavailable");
  const pnpmStoreRoots = pnpmStoreSurface.sources.map((source, index) => {
    if (source.location !== "cache" || source.mode !== "tree") authorityFail(`pnpm store source ${index} was not one exact cache tree`);
    return path.join(cacheRoot, ...source.relativeRoot.split("/"));
  });
  let privateAdmitted = true;
  let finalized = false;
  let tornDown = false;
  let failed = false;
  let inProgress = null;
  let privateBeforeTuples;
  let finalizationSnapshot;
  let captureAuthenticodeSnapshot;
  let captureAuditPlanAuthorities;
  const captureAuditReceipts = new Map();
  const capturePathReceipts = new Map();
  const consumedCaptureAuditPlans = new Set();
  const consumedCapturePathPhases = new Set();
  const nativeOperationStdout = new Map();
  let payloadWriteSnapshot;
  let teardownSnapshot;
  let rootWriteSnapshot;

  function assertPrivateActive() {
    if (!privateAdmitted || finalized || tornDown || failed) authorityFail("private execution authority was not active");
  }

  async function replayPrivateExecutionTools({ replayTaskkill = true } = {}) {
    await replayBinding(privateBindings[0]);
    if (replayTaskkill) await replayBinding(privateBindings[1]);
  }

  async function executePrivateEntry(entryBinding, entryPlan, {
    maxOutputBytes,
    operationId,
    timeoutMs,
  }) {
    assertPrivateActive();
    assertIdentifier(operationId, "private PowerShell operation id");
    if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > MAX_TIMEOUT_MS) authorityFail("private PowerShell timeout was invalid");
    const planBytesForEntry = canonicalJsonBytes(entryPlan);
    if (planBytesForEntry.length < 1 || planBytesForEntry.length > MAX_PLAN_BYTES) authorityFail("private PowerShell plan exceeded its byte bound");
    let coreBytes;
    let scriptBytes;
    try {
      await replayPrivateExecutionTools();
      coreBytes = await heldBindingBytes(bindings[2]);
      scriptBytes = await heldBindingBytes(entryBinding);
    } catch (error) {
      failed = true;
      throw error;
    }
    const commandPlan = {
      args: ["-NoLogo", "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-EncodedCommand", encodedLoaderArgument()],
      cwd: runRoot,
      env: privateEnvironment,
      executable: privatePowerShellPath,
      shell: false,
      stdin: executionEnvelope(scriptBytes, coreBytes, planBytesForEntry),
    };
    let result;
    try {
      result = await runCommand(commandPlan, {
        maxOutputBytes,
        ownedRootExitTimeoutMs: policy.ownedRootExitTimeoutMs,
        terminationAuthority: {
          cwd: runRoot,
          env: privateEnvironment,
          executable: privateTaskkillPath,
          executableId: "taskkill-private",
          policyId: policy.terminationInvocation,
        },
        terminationToolTimeoutMs: policy.terminationToolTimeoutMs,
        timeoutMs,
      });
    } catch (error) {
      cleanupCertain = false;
      failed = true;
      throw error;
    }
    try {
      commandFacts.push(commandFact(commandPlan, result, {
        entryBinding: scriptEntryBinding(entryBinding),
        entryPlanSha256: logicalEntryPlanSha256(entryPlan, logicalizePowerShellPlanValue),
        executionAuthority: bindingExecutionAuthority(privateBindings[0], "powershell-private", policy.privateCopyIdentity),
        inProcessLoader: true,
        logicalize: (value) => samePath(value, runRoot) ? "<run>" : value,
        operationId,
      }));
      await replayBinding(entryBinding);
      await replayBinding(bindings[2]);
      await replayBinding(privateBindings[0]);
      if (result.terminationRequested) await replayBinding(privateBindings[1]);
      if (
        result.exitCode !== 0 || result.signal !== null || result.timedOut || result.overflow || result.stderr.length !== 0 ||
        result.cleanupOutcome !== "not-required" || result.terminationRequested || !result.ownedRootExitObserved
      ) authorityFail(`${operationId} did not close cleanly without cleanup`);
    } catch (error) {
      failed = true;
      throw error;
    }
    return result;
  }

  async function executeAuditPlan(auditPlan, options = {}) {
    assertExactKeys(options, ["evidenceId", "timeoutMs"].filter((key) => Object.hasOwn(options, key)), "filesystem audit options");
    const admittedPlan = immutableSnapshot(auditPlan);
    validateAuditPlan(admittedPlan, providerRoots, pnpmStoreRoots);
    const timeoutMs = options.timeoutMs ?? MAX_TIMEOUT_MS;
    const operationSuffix = options.evidenceId === undefined ? "plan" : assertIdentifier(options.evidenceId, "filesystem audit evidence id");
    if (captureMode && !["private-system-tools-before", "private-system-tools-after"].includes(operationSuffix)) {
      const expectedPlan = captureAuditPlanAuthorities?.[operationSuffix];
      if (expectedPlan === undefined || !isDeepStrictEqual(admittedPlan, expectedPlan)) {
        authorityFail("capture filesystem audit did not equal one exact internally derived plan");
      }
      if (consumedCaptureAuditPlans.has(operationSuffix)) authorityFail("capture filesystem audit plan was already consumed");
      consumedCaptureAuditPlans.add(operationSuffix);
    }
    const result = await executePrivateEntry(bindings[3], admittedPlan, {
      maxOutputBytes: MAX_WORKER_OUTPUT_BYTES,
      operationId: `filesystem-audit-${operationSuffix}`,
      timeoutMs,
    });
    try {
      const receipt = immutableSnapshot(parseFilesystemAuditReceipt(result.stdout, admittedPlan));
      if (captureMode) {
        if (captureAuditReceipts.has(operationSuffix)) authorityFail("capture filesystem audit receipt was repeated");
        captureAuditReceipts.set(operationSuffix, receipt);
      }
      return receipt;
    } catch (error) {
      failed = true;
      throw error;
    }
  }

  async function withExclusiveOperation(label, action, { requireActive = true } = {}) {
    if (inProgress !== null) authorityFail(`authority operation ${inProgress} was already in progress`);
    if (requireActive) assertPrivateActive();
    inProgress = label;
    try {
      return await action();
    } finally {
      inProgress = null;
    }
  }

  const beforeReceipt = await executeAuditPlan(privateToolAuditPlan(privateToolRoot), {
    evidenceId: "private-system-tools-before",
    timeoutMs: 120_000,
  });
  privateBeforeTuples = beforeReceipt.sources[0]?.files;
  if (!isDeepStrictEqual(privateBeforeTuples, expectedReceipt.privateTuples)) authorityFail("private system tool worker closure before use mismatch");

  const frozenContext = deepFreeze(context);
  const payloadLogicalPath = `<cache>/preseal/receipts/${payloadName}`;
  const rootLogicalPath = `<cache>/preseal/receipts/${rootName}`;
  const runSnapshot = deepFreeze({
    receipts: { payloadLogicalPath, rootLogicalPath },
    runId: runLeaf,
    runRoot,
    tempRoot,
  });
  const logicalizeNativeValue = createLogicalizer({
    "<run>": runRoot,
    "<repo>": context.locations.repo,
    "<cache>": cacheRoot,
    "<git>": context.locations.git,
    "<system>": systemRoot,
  });
  const admittedPathPolicyOutputs = new Map([
    ["git-exec-path", path.join(runRoot, "git-exec-path-empty")],
    ["gpg-runtime-root", path.join(runRoot, "gpg-runtime", "usr", "bin")],
    ["payload-final", payloadPath],
    ["payload-temporary", payloadTemporaryPath],
    ["private-git-root", path.join(runRoot, "git-runtime")],
    ["root-final", rootPath],
    ["root-temporary", rootTemporaryPath],
    ["run-root", runRoot],
    ["temp-root", tempRoot],
    ["workspace-root", path.join(runRoot, "workspace")],
  ]);
  const receiptOutputEntries = deepFreeze([
    { id: "payload-final", mustExist: false, path: payloadPath, role: "output" },
    { id: "payload-temporary", mustExist: false, path: payloadTemporaryPath, role: "output" },
    { id: "root-final", mustExist: false, path: rootPath, role: "output" },
    { id: "root-temporary", mustExist: false, path: rootTemporaryPath, role: "output" },
  ]);
  const exactSurfaceRoot = (surfaceId) => {
    const surfaces = context.config.surfaces.filter((surface) => surface.surfaceId === surfaceId);
    if (surfaces.length !== 1 || surfaces[0].sources.length < 1) authorityFail(`${surfaceId} surface authority was unavailable`);
    const source = surfaces[0].sources[0];
    const locationRoot = context.locations[source.location];
    if (typeof locationRoot !== "string") authorityFail(`${surfaceId} location authority was unavailable`);
    return source.relativeRoot === "" ? locationRoot : path.join(locationRoot, ...source.relativeRoot.split("/"));
  };
  const nodeInput = context.config.root.officialInputs.find((entry) => entry.id === "node-v22.13.0-win-x64");
  if (nodeInput === undefined) authorityFail("Node executable authority was unavailable");
  const llvmInput = context.config.root.officialInputs.find((entry) => entry.id === "llvm-19.1.7-windows-msvc");
  const pythonInput = context.config.root.officialInputs.find((entry) => entry.id === "python-3.13.14-embed-amd64");
  const pnpmInput = context.config.root.officialInputs.find((entry) => entry.id === "pnpm-10.33.0");
  if (llvmInput === undefined || pythonInput === undefined || pnpmInput === undefined) authorityFail("signature input authority was unavailable");
  const exactAsset = (input, role) => {
    const matches = input.assets.filter((asset) => asset.role === role);
    if (matches.length !== 1) authorityFail(`${input.id}/${role} asset authority was unavailable`);
    return cacheKeyToPath(cacheRoot, matches[0].cacheKey);
  };
  const nodeExecutablePath = path.join(exactSurfaceRoot("node-distribution"), "node.exe");
  const pythonExecutablePath = path.join(exactSurfaceRoot("python-embed"), "python.exe");
  const pnpmCjsPath = path.join(exactSurfaceRoot("pnpm-distribution"), "bin", "pnpm.cjs");
  const privateGitPath = path.join(runRoot, "git-runtime", "git.exe");
  const gpgRuntimeRoot = path.join(runRoot, "gpg-runtime", "usr", "bin");
  const signatureClosure = context.config.root.hostToolchain.signatureVerificationClosure.files;
  const signatureExecutableTuple = (fileName) => {
    const tuples = signatureClosure.filter((tuple) => path.posix.basename(tuple[0]).toLowerCase() === fileName);
    if (tuples.length !== 1) authorityFail(`${fileName} authority was unavailable`);
    return tuples[0];
  };
  const gpgTuple = signatureExecutableTuple("gpg.exe");
  const gpgvTuple = signatureExecutableTuple("gpgv.exe");
  const nativeExecutableAuthorities = deepFreeze({
    git: {
      bytes: context.config.root.hostToolchain.git.sourceExecutable[1],
      executable: privateGitPath,
      kind: "git",
      sha256: context.config.root.hostToolchain.git.sourceExecutable[2],
    },
    gpg: { bytes: gpgTuple[1], executable: path.join(gpgRuntimeRoot, "gpg.exe"), kind: "gpg", sha256: gpgTuple[2] },
    gpgv: { bytes: gpgvTuple[1], executable: path.join(gpgRuntimeRoot, "gpgv.exe"), kind: "gpgv", sha256: gpgvTuple[2] },
    node: { bytes: nodeInput.nodeExe.bytes, executable: nodeExecutablePath, kind: "node", sha256: nodeInput.nodeExe.sha256 },
  });
  const withoutCaseAliases = (environment) => {
    const clone = { ...environment };
    for (const name of [
      "all_proxy", "http_proxy", "https_proxy", "npm_config_cache", "npm_config_registry", "npm_config_userconfig", "no_proxy",
    ]) delete clone[name];
    return clone;
  };
  const nodeRoot = path.dirname(nodeExecutablePath);
  const workspaceRoot = path.join(runRoot, "workspace");
  const storeParents = new Set(pnpmStoreSurface.sources.map((source) => path.posix.dirname(source.relativeRoot)));
  if (storeParents.size !== 1) authorityFail("pnpm store parent authority was ambiguous");
  const storeV10 = path.join(cacheRoot, ...[...storeParents][0].split("/"));
  const admittedStoreParent = path.dirname(storeV10);
  const expectedNativeEnvironment = (kind) => {
    if (kind === "node") return buildClosedEnvironment({ kind: "node", runRoot, systemRoot, nodeRoot, gitRoot: context.locations.git });
    if (kind === "pnpm") return withoutCaseAliases(buildClosedEnvironment({ kind: "pnpm", runRoot, systemRoot, nodeRoot, gitRoot: context.locations.git }));
    if (kind === "git") return buildClosedEnvironment({
      kind: "git", runRoot, systemRoot, nodeRoot, gitRoot: context.locations.git,
      privateGitRoot: path.dirname(privateGitPath), gitExecPath: path.join(runRoot, "git-exec-path-empty"),
    });
    const environment = buildClosedEnvironment({ kind: "gpg", runRoot, systemRoot, nodeRoot, gitRoot: context.locations.git });
    environment.PATH = [gpgRuntimeRoot, path.join(systemRoot, "System32")].join(path.delimiter);
    environment.LANG = "C";
    environment.LC_ALL = "C";
    return environment;
  };
  const runtimeProbeCode = "process.stdout.write(JSON.stringify({arch:process.arch,execArgv:process.execArgv,modules:process.versions.modules,napi:process.versions.napi,nodeOptions:process.env.NODE_OPTIONS??null,nodePath:process.env.NODE_PATH??null,platform:process.platform,version:process.versions.node}))";
  const repositoryAuthorities = presealRepositoryChainAuthorities(
    context.config.root.provenance,
    "capture repository authority",
  );
  const publishedCommit = repositoryAuthorities.publishedBase.landing;
  const t0Commit = repositoryAuthorities.historicalT0.landing;
  const t0TrackedInputs = context.config.root.provenance.t0TrackedInputs;
  const nodeKeyHash = nodeInput.signatureVerification.historicalKeyring.sha256;
  const nodeKeyDirectory = path.join(cacheRoot, "objects", "sha256", nodeKeyHash);
  const nodeKeyEntries = await fs.readdir(nodeKeyDirectory, { withFileTypes: true });
  if (nodeKeyEntries.length !== 1 || !nodeKeyEntries[0].isFile() || nodeKeyEntries[0].isSymbolicLink()) authorityFail("Node historical keyring path authority was ambiguous");
  const nodeKeyPath = path.join(nodeKeyDirectory, nodeKeyEntries[0].name);
  const gpgvHome = path.join(runRoot, "gpgv-home");
  const llvmHome = path.join(runRoot, "llvm-gpg-home");
  const llvmKeyringPath = path.join(llvmHome, "llvm-release-keyring.gpg");
  const pythonInspectHome = path.join(runRoot, "python-key-inspection-home");
  const pythonKeyringPath = path.join(runRoot, "python-release-keyring.gpg");
  const nodeClearOutputPath = path.join(runRoot, "node-clearsigned-payload.txt");
  const nodeManifestPath = exactAsset(nodeInput, "signed-checksum-manifest");
  const nodeClearPath = exactAsset(nodeInput, "clear-signed-checksum-manifest");
  const nodeDetachedPath = exactAsset(nodeInput, "detached-checksum-signature");
  const llvmKeyPath = exactAsset(llvmInput, "official-release-public-keys");
  const llvmSignaturePath = exactAsset(llvmInput, "detached-package-signature");
  const llvmArchivePath = exactAsset(llvmInput, "official-signed-windows-msvc-package");
  const pythonKeyPath = path.join(cacheRoot, ...pythonInput.signatureVerification.releaseKey.logicalPath.slice("cache/".length).split("/"));
  const pythonSignaturePath = exactAsset(pythonInput, "detached-package-signature");
  const pythonArchivePath = exactAsset(pythonInput, "official-isolated-windows-python");
  const gpgNativePath = (input) => exactLocalPath(input, "GnuPG filesystem argument").replaceAll("\\", "/");
  const gpgRelativePath = (input) => {
    const relative = path.relative(runRoot, exactLocalPath(input, "GnuPG relative filesystem argument")).replaceAll("\\", "/");
    if (relative.length === 0 || path.posix.isAbsolute(relative) || /^[A-Za-z]:/u.test(relative)) authorityFail("GnuPG relative filesystem argument escaped its fixed drive");
    return relative.includes("/") ? relative : `./${relative}`;
  };
  const admittedGpgOperations = new Map([
    ["pinned-gpg-llvm-key-dearmor", { args: ["--no-options", "--batch", "--no-tty", "--no-autostart", "--yes", "--dearmor", "--output", gpgNativePath(llvmKeyringPath), gpgNativePath(llvmKeyPath)], kind: "gpg" }],
    ["pinned-gpg-llvm-explicit-sha1-allowance", { args: [
      "--no-options", "--homedir", gpgRelativePath(llvmHome), "--batch", "--no-tty", "--no-autostart",
      "--no-auto-key-retrieve", "--no-default-keyring", "--keyring", path.basename(llvmKeyringPath),
      "--status-fd", "1", "--trust-model", "always", "--allow-weak-digest-algos", "--verify",
      gpgNativePath(llvmSignaturePath), gpgNativePath(llvmArchivePath),
    ], kind: "gpg" }],
    ["pinned-gpg-python-key-dearmor", { args: ["--no-options", "--batch", "--no-tty", "--no-autostart", "--yes", "--dearmor", "--output", gpgNativePath(pythonKeyringPath), gpgNativePath(pythonKeyPath)], kind: "gpg" }],
    ["pinned-gpg-python-key-inspection", { args: ["--no-options", "--homedir", gpgRelativePath(pythonInspectHome), "--batch", "--no-tty", "--no-autostart", "--with-colons", "--import-options", "show-only", "--dry-run", "--import", gpgNativePath(pythonKeyPath)], kind: "gpg" }],
    ["pinned-gpgv-node-clearsigned", { args: ["--homedir", gpgRelativePath(gpgvHome), "--status-fd", "1", "--keyring", gpgRelativePath(nodeKeyPath), "--output", gpgNativePath(nodeClearOutputPath), gpgNativePath(nodeClearPath)], kind: "gpgv" }],
    ["pinned-gpgv-node-detached", { args: ["--homedir", gpgRelativePath(gpgvHome), "--status-fd", "1", "--keyring", gpgRelativePath(nodeKeyPath), gpgNativePath(nodeDetachedPath), gpgNativePath(nodeManifestPath)], kind: "gpgv" }],
    ["pinned-gpgv-python-detached", { args: ["--homedir", gpgRelativePath(gpgvHome), "--status-fd", "1", "--keyring", gpgRelativePath(pythonKeyringPath), gpgNativePath(pythonSignaturePath), gpgNativePath(pythonArchivePath)], kind: "gpgv" }],
  ]);
  const gpgLogicalArgumentBindings = new Map([
    [gpgRelativePath(gpgvHome), logicalizeNativeValue(gpgNativePath(gpgvHome))],
    [gpgRelativePath(nodeKeyPath), logicalizeNativeValue(gpgNativePath(nodeKeyPath))],
    [gpgRelativePath(llvmHome), logicalizeNativeValue(gpgNativePath(llvmHome))],
    [path.basename(llvmKeyringPath), logicalizeNativeValue(gpgNativePath(llvmKeyringPath))],
    [gpgRelativePath(pythonInspectHome), logicalizeNativeValue(gpgNativePath(pythonInspectHome))],
    [gpgRelativePath(pythonKeyringPath), logicalizeNativeValue(gpgNativePath(pythonKeyringPath))],
  ]);
  const nativeOperationEntries = [];
  const addNativeOperation = (operationId, executableKind, plan, {
    logicalArgv = plan.args.map((entry) => logicalizeNativeValue(entry)),
    maxOutputBytes = 4 * 1024 * 1024,
    timeoutMs = 120_000,
  } = {}) => {
    assertIdentifier(operationId, "native operation id");
    if (nativeOperationEntries.some(([existing]) => existing === operationId)) authorityFail("native operation table repeated an id");
    const executableAuthority = nativeExecutableAuthorities[executableKind];
    if (executableAuthority === undefined || !samePath(plan.executable, executableAuthority.executable)) {
      authorityFail(`${operationId} executable authority mismatch`);
    }
    if (
      !Array.isArray(logicalArgv) || logicalArgv.length !== plan.args.length || logicalArgv.some((entry) => typeof entry !== "string") ||
      (["gpg", "gpgv"].includes(executableKind) && logicalArgv.some((entry) => /^\.\.?\//u.test(entry)))
    ) authorityFail(`${operationId} logical argv authority was invalid`);
    nativeOperationEntries.push([operationId, deepFreeze({
      executableAuthority,
      logicalArgv: [...logicalArgv],
      maxOutputBytes,
      plan,
      timeoutMs,
    })]);
  };
  addNativeOperation("node-runtime-replay", "node", {
    args: ["-e", runtimeProbeCode],
    cwd: runRoot,
    env: expectedNativeEnvironment("node"),
    executable: nodeExecutablePath,
    shell: false,
  });
  addNativeOperation("node-pnpm-version", "node", {
    args: [pnpmCjsPath, "--version"],
    cwd: workspaceRoot,
    env: expectedNativeEnvironment("pnpm"),
    executable: nodeExecutablePath,
    shell: false,
  });
  addNativeOperation("node-pnpm-install", "node", buildPnpmCommandPlan({
    env: expectedNativeEnvironment("pnpm"),
    nodeExe: nodeExecutablePath,
    pnpmCjs: pnpmCjsPath,
    storeParent: admittedStoreParent,
    workspaceRoot,
  }), { maxOutputBytes: 16 * 1024 * 1024, timeoutMs: 15 * 60_000 });
  const addGitOperation = (operationId, args) => addNativeOperation(operationId, "git", buildGitCommandPlan({
    args,
    env: expectedNativeEnvironment("git"),
    gitExe: privateGitPath,
    repoRoot: context.locations.repo,
  }));
  addGitOperation("git-head-commit", ["rev-parse", "HEAD^{commit}"]);
  addGitOperation("git-head-tree", ["rev-parse", `${publishedCommit}^{tree}`]);
  addGitOperation("git-head-parents", ["show", "-s", "--format=%P", publishedCommit]);
  addGitOperation("git-t0-commit", ["rev-parse", `${t0Commit}^{commit}`]);
  addGitOperation("git-t0-tree", ["rev-parse", `${t0Commit}^{tree}`]);
  addGitOperation("git-t0-parents", ["show", "-s", "--format=%P", t0Commit]);
  addGitOperation("git-common-dir", ["rev-parse", "--path-format=absolute", "--git-common-dir"]);
  for (const [index, [relativePath]] of t0TrackedInputs.entries()) {
    const suffix = String(index).padStart(2, "0");
    const objectSpec = `${t0Commit}:${relativePath}`;
    addGitOperation(`git-t0-blob-id-${suffix}`, ["rev-parse", objectSpec]);
    addGitOperation(`git-t0-blob-content-${suffix}`, ["cat-file", "blob", objectSpec]);
  }
  for (const [operationId, admitted] of admittedGpgOperations) {
    addNativeOperation(operationId, admitted.kind, {
      args: admitted.args,
      cwd: runRoot,
      env: expectedNativeEnvironment("gpg"),
      executable: nativeExecutableAuthorities[admitted.kind].executable,
      shell: false,
    }, {
      logicalArgv: admitted.args.map((entry) => gpgLogicalArgumentBindings.get(entry) ?? logicalizeNativeValue(entry)),
      timeoutMs: operationId === "pinned-gpg-llvm-explicit-sha1-allowance" ? 5 * 60_000 : 120_000,
    });
  }
  const nativeOperationTable = deepFreeze(Object.fromEntries(nativeOperationEntries));
  const consumedNativeOperations = new Set();
  const captureExpectedCommandIds = deepFreeze([
    "system-tool-authority-bootstrap",
    "filesystem-audit-private-system-tools-before",
    "path-policy-probe",
    "path-policy-probe",
    "node-runtime-replay",
    "filesystem-audit-git-source-before",
    "filesystem-audit-private-git-before",
    "filesystem-audit-git-exec-path-before",
    "git-head-commit",
    "git-head-tree",
    "git-head-parents",
    "git-t0-commit",
    "git-t0-tree",
    "git-t0-parents",
    "git-common-dir",
    "path-policy-probe",
    ...t0TrackedInputs.flatMap((_, index) => {
      const suffix = String(index).padStart(2, "0");
      return [`git-t0-blob-id-${suffix}`, `git-t0-blob-content-${suffix}`];
    }),
    "filesystem-audit-pnpm-dist-preuse",
    "filesystem-audit-pnpm-store-before",
    "node-pnpm-version",
    "node-pnpm-install",
    "filesystem-audit-pnpm-store-after",
    "filesystem-audit-pnpm-dist-after",
    "filesystem-audit-official-objects-preuse",
    "filesystem-audit-gpg-source-preuse",
    "path-policy-probe",
    "filesystem-audit-gpg-copy-before",
    "pinned-gpgv-node-detached",
    "pinned-gpgv-node-clearsigned",
    "pinned-gpg-llvm-key-dearmor",
    "pinned-gpg-llvm-explicit-sha1-allowance",
    "pinned-gpg-python-key-inspection",
    "pinned-gpg-python-key-dearmor",
    "pinned-gpgv-python-detached",
    "filesystem-audit-gpg-copy-after",
    "authenticode-probe",
    "path-policy-probe",
    "filesystem-audit-git-source-after",
    "filesystem-audit-private-git-after",
    "filesystem-audit-git-exec-path-after",
    "filesystem-audit-private-system-tools-after",
  ]);
  if (captureExpectedCommandIds.length !== CX004_PRESEAL_COMMAND_COUNT) {
    authorityFail(
      `capture operation authority must contain exactly ${CX004_PRESEAL_COMMAND_COUNT} commands`,
    );
  }
  const buildCaptureSurfacePlan = (surfaceId, phase) => {
    const surfaces = context.config.surfaces.filter((surface) => surface.surfaceId === surfaceId);
    if (surfaces.length !== 1) authorityFail(`${surfaceId} capture audit authority was unavailable`);
    return {
      schemaVersion: FILESYSTEM_AUDIT_PLAN_SCHEMA,
      sources: surfaces[0].sources.map((source, sourceIndex) => {
        const locationRoot = context.locations[source.location];
        if (typeof locationRoot !== "string") authorityFail(`${surfaceId} capture audit location was unavailable`);
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
      }),
    };
  };
  const privateCapturePlan = (surfaceId, rootPath, sourceId, logicalPrefix, mode = "tree") => ({
    schemaVersion: FILESYSTEM_AUDIT_PLAN_SCHEMA,
    sources: [{ files: [], logicalPrefix, mode, rootPath, sourceId, sourceIndex: 0, surfaceId }],
  });
  captureAuditPlanAuthorities = deepFreeze({
    "git-exec-path-after": privateCapturePlan("git-exec-path-empty", path.join(runRoot, "git-exec-path-empty"), "git-exec-path-00", "run-private/git-exec-path", "empty-tree"),
    "git-exec-path-before": privateCapturePlan("git-exec-path-empty", path.join(runRoot, "git-exec-path-empty"), "git-exec-path-00", "run-private/git-exec-path", "empty-tree"),
    "git-source-after": buildCaptureSurfacePlan("git-execution-closure", "git-source-after"),
    "git-source-before": buildCaptureSurfacePlan("git-execution-closure", "git-source-before"),
    "gpg-copy-after": privateCapturePlan("git-signature-verification-closure", gpgRuntimeRoot, "gpg-copy-00", "git/usr/bin"),
    "gpg-copy-before": privateCapturePlan("git-signature-verification-closure", gpgRuntimeRoot, "gpg-copy-00", "git/usr/bin"),
    "gpg-source-preuse": buildCaptureSurfacePlan("git-signature-verification-closure", "gpg-source-preuse"),
    "official-objects-preuse": buildCaptureSurfacePlan("official-object-inputs", "official-objects-preuse"),
    "pnpm-dist-after": buildCaptureSurfacePlan("pnpm-distribution", "pnpm-dist-after"),
    "pnpm-dist-preuse": buildCaptureSurfacePlan("pnpm-distribution", "pnpm-dist-preuse"),
    "pnpm-store-after": buildCaptureSurfacePlan("pnpm-store-v10", "pnpm-store-after"),
    "pnpm-store-before": buildCaptureSurfacePlan("pnpm-store-v10", "pnpm-store-before"),
    "private-git-after": privateCapturePlan("private-git-runtime", path.join(runRoot, "git-runtime"), "private-git-00", "run-private/git"),
    "private-git-before": privateCapturePlan("private-git-runtime", path.join(runRoot, "git-runtime"), "private-git-00", "run-private/git"),
  });

  const capturePathPhases = deepFreeze(["prestage", "postcreate", "git-rewrite-inputs", "gpg-copy", "prewrite"]);
  function buildCapturePathPolicyPlan(phaseId) {
    if (!capturePathPhases.includes(phaseId)) authorityFail("capture path-policy phase was not admitted");
    const staged = phaseId !== "prestage";
    const paths = [
      { id: "cache-root", mustExist: true, path: cacheRoot, role: "input" },
      { id: "git-root", mustExist: true, path: context.locations.git, role: "input" },
      { id: "receipt-directory", mustExist: true, path: receiptDirectory, role: "input" },
      { id: "repo-root", mustExist: true, path: context.locations.repo, role: "input" },
      { id: "system-root", mustExist: true, path: systemRoot, role: "input" },
      { id: "node-executable", mustExist: true, path: nodeExecutablePath, role: "input" },
      { id: "run-root", mustExist: true, path: runRoot, role: "output" },
      { id: "temp-root", mustExist: true, path: tempRoot, role: "output" },
      { id: "workspace-root", mustExist: staged, path: workspaceRoot, role: "output" },
      { id: "gpg-runtime-root", mustExist: staged, path: gpgRuntimeRoot, role: "output" },
      { id: "private-git-root", mustExist: staged, path: path.dirname(privateGitPath), role: "output" },
      { id: "git-exec-path", mustExist: staged, path: path.join(runRoot, "git-exec-path-empty"), role: "output" },
    ];
    if (phaseId === "git-rewrite-inputs") {
      const bytes = nativeOperationStdout.get("git-common-dir");
      if (bytes === undefined) authorityFail("capture Git common-directory receipt was unavailable");
      let text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
      if (text.endsWith("\r\n")) text = text.slice(0, -2);
      else if (text.endsWith("\n")) text = text.slice(0, -1);
      if (text.length === 0 || text.includes("\r") || text.includes("\n")) authorityFail("capture Git common-directory receipt was not one path line");
      const commonDirectory = exactLocalPath(path.resolve(context.locations.repo, text), "capture Git common directory");
      if (providerRoots.some((root) => isPathWithin(commonDirectory, root) || isPathWithin(root, commonDirectory))) {
        authorityFail("capture Git common directory overlapped a provider home");
      }
      paths.push(
        { id: "git-common-directory", mustExist: true, path: commonDirectory, role: "input" },
        { id: "git-grafts-file", mustExist: false, path: path.join(commonDirectory, "info", "grafts"), role: "input" },
        { id: "git-shallow-file", mustExist: false, path: path.join(commonDirectory, "shallow"), role: "input" },
      );
    }
    return deepFreeze({
      exclusions: pathPolicy.exclusions.map((entry) => ({ ...entry, mustExist: false, role: "exclusion" })),
      paths: [...paths, ...receiptOutputEntries],
      schemaVersion: PATH_POLICY_SCHEMA,
    });
  }

  async function executePathPolicyPlan(fullPlan, timeoutMs) {
    validatePathPolicyPlan(fullPlan, cacheRoot, providerRoots, admittedPathPolicyOutputs);
    const result = await executePrivateEntry(entryBindings.pathPolicy, fullPlan, {
      maxOutputBytes: 4 * 1024 * 1024,
      operationId: "path-policy-probe",
      timeoutMs,
    });
    try {
      return immutableSnapshot(parsePathPolicyReceipt(result.stdout, fullPlan));
    } catch (error) {
      failed = true;
      throw error;
    }
  }

  function compactCaptureAudit(operationId, surfaceId) {
    const receipt = captureAuditReceipts.get(operationId);
    if (receipt === undefined) authorityFail(`capture filesystem audit ${operationId} was unavailable`);
    const summary = summarizeFilesystemAudit(receipt);
    return {
      byteLength: summary.byteLength,
      fileCount: summary.fileCount,
      hardenedIdentityPolicy: surfaceId === "pnpm-store-v10"
        ? "regular-nonreparse-positive-observed-link-count-one-unnamed-stream-double-content-hash-stable-handle"
        : "regular-nonreparse-single-link-one-unnamed-stream-double-content-hash-stable-handle",
      surfaceId,
      surfaceSha256: summary.surfaceSha256,
    };
  }

  function buildCaptureFilesystemAudits() {
    return deepFreeze({
      gitExecPathAfter: compactCaptureAudit("git-exec-path-after", "git-exec-path-empty"),
      gitExecPathBefore: compactCaptureAudit("git-exec-path-before", "git-exec-path-empty"),
      gitPrivateAfter: compactCaptureAudit("private-git-after", "private-git-runtime"),
      gitPrivateBefore: compactCaptureAudit("private-git-before", "private-git-runtime"),
      gitSourceAfter: compactCaptureAudit("git-source-after", "git-execution-closure"),
      gitSourceBefore: compactCaptureAudit("git-source-before", "git-execution-closure"),
      gpgCopiedAfter: compactCaptureAudit("gpg-copy-after", "git-signature-verification-closure"),
      gpgCopiedBefore: compactCaptureAudit("gpg-copy-before", "git-signature-verification-closure"),
      gpgSource: compactCaptureAudit("gpg-source-preuse", "git-signature-verification-closure"),
      officialObjects: compactCaptureAudit("official-objects-preuse", "official-object-inputs"),
      privateSystemToolsAfter: compactCaptureAudit("private-system-tools-after", "private-system-tools"),
      privateSystemToolsBefore: compactCaptureAudit("private-system-tools-before", "private-system-tools"),
      pnpmDistributionAfter: compactCaptureAudit("pnpm-dist-after", "pnpm-distribution"),
      pnpmDistributionBefore: compactCaptureAudit("pnpm-dist-preuse", "pnpm-distribution"),
      pnpmStoreAfter: compactCaptureAudit("pnpm-store-after", "pnpm-store-v10"),
      pnpmStoreBefore: compactCaptureAudit("pnpm-store-before", "pnpm-store-v10"),
    });
  }

  function captureOfficialTuples() {
    const receipt = captureAuditReceipts.get("official-objects-preuse");
    if (receipt === undefined) authorityFail("capture official-object audit was unavailable");
    return summarizeFilesystemAudit(receipt).tuples;
  }

  function captureAssetFacts(input, officialTuples) {
    return input.assets.map((asset) => {
      const matches = officialTuples.filter((tuple) => tuple[0] === asset.cacheKey && tuple[1] === asset.bytes && tuple[2] === asset.sha256);
      if (matches.length !== 1) authorityFail(`${input.id}/${asset.role} was not uniquely bound by the official-object audit`);
      return { bytes: asset.bytes, fileName: asset.fileName, logicalPath: asset.cacheKey, role: asset.role, sha256: asset.sha256 };
    });
  }

  function requiredAsset(input, role) {
    const matches = input.assets.filter((asset) => asset.role === role);
    if (matches.length !== 1) authorityFail(`${input.id}/${role} asset authority was unavailable`);
    return matches[0];
  }

  function requiredNativeStdout(operationId) {
    const bytes = nativeOperationStdout.get(operationId);
    if (bytes === undefined) authorityFail(`${operationId} stdout authority was unavailable`);
    return bytes;
  }

  function assertGpgStatus(status, input, digestAlgorithmId, label) {
    if (
      ![status.fingerprint, status.primaryFingerprint].includes(input.signatureVerification.signerFingerprint) ||
      status.signatureDate !== input.signatureVerification.signatureTimestamp ||
      status.digestAlgorithmId !== digestAlgorithmId
    ) authorityFail(`${label} signature status did not equal config authority`);
  }

  async function buildCaptureSignatures() {
    const officialTuples = captureOfficialTuples();
    const nodeDetachedStatus = parseGpgStatus(requiredNativeStdout("pinned-gpgv-node-detached"));
    const nodeClearStatus = parseGpgStatus(requiredNativeStdout("pinned-gpgv-node-clearsigned"));
    const llvmStatus = parseGpgStatus(requiredNativeStdout("pinned-gpg-llvm-explicit-sha1-allowance"));
    const pythonStatus = parseGpgStatus(requiredNativeStdout("pinned-gpgv-python-detached"));
    assertGpgStatus(nodeDetachedStatus, nodeInput, 8, "Node detached");
    assertGpgStatus(nodeClearStatus, nodeInput, 8, "Node clear-signed");
    assertGpgStatus(llvmStatus, llvmInput, 2, "LLVM");
    assertGpgStatus(pythonStatus, pythonInput, 8, "Python");
    if (!parseGpgFingerprints(requiredNativeStdout("pinned-gpg-python-key-inspection")).includes(pythonInput.signatureVerification.signerFingerprint)) {
      authorityFail("Python inspected release key did not equal config authority");
    }

    const nodeManifestAsset = requiredAsset(nodeInput, "signed-checksum-manifest");
    const nodeManifestPath = cacheKeyToPath(cacheRoot, nodeManifestAsset.cacheKey);
    await verifyFile(nodeManifestPath, { bytes: nodeManifestAsset.bytes, sha256: nodeManifestAsset.sha256 });
    const nodeManifestBytes = await fs.readFile(nodeManifestPath);
    const nodeClearBytes = await fs.readFile(nodeClearOutputPath);
    if (!nodeClearBytes.equals(nodeManifestBytes)) authorityFail("Node clear-signed payload did not equal its detached manifest");

    const nodeKey = nodeInput.signatureVerification.historicalKeyring;
    const nodeKeyMatches = officialTuples.filter((tuple) => tuple[1] === nodeKey.bytes && tuple[2] === nodeKey.sha256);
    if (nodeKeyMatches.length !== 1) authorityFail("Node historical keyring was not uniquely bound by the official-object audit");
    const pythonKey = pythonInput.signatureVerification.releaseKey;
    const pythonKeyMatches = officialTuples.filter((tuple) => tuple[0] === pythonKey.logicalPath && tuple[1] === pythonKey.bytes && tuple[2] === pythonKey.sha256);
    if (pythonKeyMatches.length !== 1) authorityFail("Python release key was not uniquely bound by the official-object audit");

    const pnpmTarballAsset = requiredAsset(pnpmInput, "official-registry-distribution");
    const pnpmMetadataAsset = requiredAsset(pnpmInput, "registry-version-signature-document");
    const pnpmKeysAsset = requiredAsset(pnpmInput, "registry-public-verification-keys");
    for (const asset of [pnpmTarballAsset, pnpmMetadataAsset, pnpmKeysAsset]) {
      await verifyFile(cacheKeyToPath(cacheRoot, asset.cacheKey), { bytes: asset.bytes, sha256: asset.sha256 });
    }
    const pnpmTarball = await fs.readFile(cacheKeyToPath(cacheRoot, pnpmTarballAsset.cacheKey));
    if (
      createHash("sha1").update(pnpmTarball).digest("hex") !== pnpmTarballAsset.sha1 ||
      `sha512-${createHash("sha512").update(pnpmTarball).digest("base64")}` !== pnpmTarballAsset.sha512Integrity
    ) authorityFail("pnpm tarball registry integrity authority mismatch");
    const decodeJsonFile = async (asset, label) => {
      const text = new TextDecoder("utf-8", { fatal: true }).decode(await fs.readFile(cacheKeyToPath(cacheRoot, asset.cacheKey)));
      try { return JSON.parse(text); } catch { authorityFail(`${label} was not JSON`); }
    };
    const metadata = await decodeJsonFile(pnpmMetadataAsset, "pnpm registry metadata");
    const keys = await decodeJsonFile(pnpmKeysAsset, "npm registry keys");
    const message = `${metadata.name}@${metadata.version}:${metadata.dist.integrity}`;
    const signatureMatches = metadata.dist.signatures.filter((entry) => entry.keyid === pnpmInput.signatureVerification.keyId);
    const keyMatches = keys.keys.filter((entry) => entry.keyid === pnpmInput.signatureVerification.keyId);
    if (
      metadata.name !== "pnpm" || metadata.version !== pnpmInput.distribution.version ||
      metadata.dist.integrity !== pnpmTarballAsset.sha512Integrity || metadata.dist.shasum !== pnpmTarballAsset.sha1 ||
      message !== pnpmInput.signatureVerification.message || signatureMatches.length !== 1 || keyMatches.length !== 1 ||
      keyMatches[0].keytype !== "ecdsa-sha2-nistp256" || keyMatches[0].scheme !== "ecdsa-sha2-nistp256"
    ) authorityFail("pnpm registry signature document did not equal config authority");
    const publicKey = createPublicKey({ key: Buffer.from(keyMatches[0].key, "base64"), format: "der", type: "spki" });
    if (!verifySignature("sha256", Buffer.from(message, "utf8"), publicKey, Buffer.from(signatureMatches[0].sig, "base64"))) {
      authorityFail("pnpm registry signature was invalid");
    }

    return deepFreeze({
      llvm: {
        assets: captureAssetFacts(llvmInput, officialTuples),
        digestAlgorithmId: llvmStatus.digestAlgorithmId,
        explicitWeakDigestAllowance: "--allow-weak-digest-algos",
        fingerprint: llvmInput.signatureVerification.signerFingerprint,
        result: "valid",
        signatureDate: llvmStatus.signatureDate,
      },
      node: {
        assets: captureAssetFacts(nodeInput, officialTuples),
        clearSignedAndDetachedPayloadEquality: true,
        clearSignedDigestAlgorithmId: nodeClearStatus.digestAlgorithmId,
        detachedDigestAlgorithmId: nodeDetachedStatus.digestAlgorithmId,
        fingerprint: nodeInput.signatureVerification.signerFingerprint,
        historicalKeyring: { bytes: nodeKeyMatches[0][1], logicalPath: nodeKeyMatches[0][0], sha256: nodeKeyMatches[0][2] },
        result: "valid",
        signatureDate: nodeDetachedStatus.signatureDate,
      },
      pnpmRegistry: {
        algorithm: pnpmInput.signatureVerification.algorithm,
        assets: captureAssetFacts(pnpmInput, officialTuples),
        derivedMessageSha256: sha256(Buffer.from(message, "utf8")),
        keyId: pnpmInput.signatureVerification.keyId,
        result: "valid",
      },
      python: {
        assets: captureAssetFacts(pythonInput, officialTuples),
        digestAlgorithmId: pythonStatus.digestAlgorithmId,
        fingerprint: pythonInput.signatureVerification.signerFingerprint,
        releaseKey: { bytes: pythonKeyMatches[0][1], logicalPath: pythonKeyMatches[0][0], sha256: pythonKeyMatches[0][2] },
        result: "valid",
        signatureDate: pythonStatus.signatureDate,
      },
    });
  }

  function buildCapturePathPolicyFacts() {
    const receiptFacts = (phaseId) => {
      const receipt = capturePathReceipts.get(phaseId);
      if (receipt === undefined) authorityFail(`capture path-policy ${phaseId} receipt was unavailable`);
      return receipt.facts;
    };
    return deepFreeze({
      gitRewriteInputs: receiptFacts("git-rewrite-inputs"),
      gpgCopy: receiptFacts("gpg-copy"),
      postcreate: receiptFacts("postcreate"),
      prestage: receiptFacts("prestage"),
      prewrite: receiptFacts("prewrite"),
    });
  }
  const privateBeforeSummary = deepFreeze({
    byteLength: privateBeforeTuples.reduce((total, tuple) => total + tuple[1], 0),
    fileCount: privateBeforeTuples.length,
    identityPolicy: policy.privateCopyIdentity,
    surfaceSha256: sha256(canonicalJsonBytes(privateBeforeTuples)),
    tuples: immutableSnapshot(privateBeforeTuples),
  });

  async function replayReceiptDirectoryAuthority(label) {
    const replayParent = await directoryIdentity(receiptParent, `${label} parent`);
    const replayDirectory = await directoryIdentity(receiptDirectory, `${label} directory`);
    if (!isDeepStrictEqual(replayParent, receiptParentIdentity) || !isDeepStrictEqual(replayDirectory, receiptDirectoryIdentity)) {
      authorityFail(`${label} receipt directory authority changed`);
    }
  }

  async function assertReceiptPathAbsent(candidate, label) {
    try {
      await fs.lstat(candidate);
      authorityFail(`${label} was not fresh`);
    } catch (error) {
      if (error?.code !== "ENOENT") throw error;
    }
  }

  const authority = {
    get cleanupCertain() { return cleanupCertain; },
    get configBytes() { return Buffer.from(configSnapshot.bytes); },
    configContext: frozenContext,
    get finalized() { return finalized; },
    privateSystemToolSurface: privateBeforeSummary,
    run: runSnapshot,
    async runAuditPlan(auditPlan, options = {}) {
      return await withExclusiveOperation("filesystem-audit", async () => await executeAuditPlan(auditPlan, options));
    },
    async runPathPolicyPlan(pathPolicyPlan, options = {}) {
      return await withExclusiveOperation("path-policy", async () => {
        if (captureMode) authorityFail("generic path-policy plans are unavailable to preseal capture");
        assertExactKeys(options, ["timeoutMs"].filter((key) => Object.hasOwn(options, key)), "path policy options");
        const admittedPlan = immutableSnapshot(pathPolicyPlan);
        assertExactKeys(admittedPlan, ["exclusions", "paths", "schemaVersion"], "path policy plan");
        if (!Array.isArray(admittedPlan.paths)) authorityFail("path policy paths were invalid");
        const receiptInputs = admittedPlan.paths.filter((entry) => entry?.id === "receipt-directory");
        if (
          receiptInputs.length !== 1 || receiptInputs[0].mustExist !== true || receiptInputs[0].role !== "input" ||
          !samePath(exactLocalPath(receiptInputs[0].path, "receipt directory policy input"), receiptDirectory)
        ) authorityFail("path policy did not bind the fixed receipt directory as one existing input");
        const fullPlan = deepFreeze({
          exclusions: admittedPlan.exclusions,
          paths: [...admittedPlan.paths, ...receiptOutputEntries],
          schemaVersion: admittedPlan.schemaVersion,
        });
        const timeoutMs = options.timeoutMs ?? 120_000;
        return await executePathPolicyPlan(fullPlan, timeoutMs);
      });
    },
    async runCapturePathPolicyPhase(phaseId, ...unexpected) {
      return await withExclusiveOperation("capture-path-policy", async () => {
        if (!captureMode || unexpected.length !== 0) authorityFail("capture path-policy phase accepted one fixed phase id only");
        assertIdentifier(phaseId, "capture path-policy phase id");
        if (!capturePathPhases.includes(phaseId)) authorityFail("capture path-policy phase was not admitted");
        if (consumedCapturePathPhases.has(phaseId)) authorityFail("capture path-policy phase was already consumed");
        const fullPlan = buildCapturePathPolicyPlan(phaseId);
        consumedCapturePathPhases.add(phaseId);
        const receipt = await executePathPolicyPlan(fullPlan, 120_000);
        capturePathReceipts.set(phaseId, receipt);
        return receipt;
      });
    },
    async runAuthenticodePlan(authenticodeRequest, options = {}) {
      return await withExclusiveOperation("authenticode", async () => {
        if (captureMode && captureAuthenticodeSnapshot !== undefined) authorityFail("capture Authenticode operation was already consumed");
        assertExactKeys(options, ["timeoutMs"].filter((key) => Object.hasOwn(options, key)), "Authenticode options");
        const admittedRequest = immutableSnapshot(authenticodeRequest);
        assertExactKeys(admittedRequest, ["node", "python"], "Authenticode request");
        for (const id of ["node", "python"]) assertExactKeys(admittedRequest[id], ["bytes", "path", "sha256"], `Authenticode ${id}`);
        if (captureMode && (
          !samePath(admittedRequest.node.path, nodeExecutablePath) || admittedRequest.node.bytes !== nodeInput.nodeExe.bytes || admittedRequest.node.sha256 !== nodeInput.nodeExe.sha256 ||
          !samePath(admittedRequest.python.path, pythonExecutablePath) || admittedRequest.python.bytes !== pythonInput.pythonExe.bytes || admittedRequest.python.sha256 !== pythonInput.pythonExe.sha256
        )) authorityFail("capture Authenticode request did not equal its exact config-derived targets");
        const targetBindings = [];
        for (const id of ["node", "python"]) {
          const target = admittedRequest[id];
          if (!Number.isSafeInteger(target.bytes) || target.bytes < 1 || typeof target.sha256 !== "string" || !SHA256_PATTERN.test(target.sha256)) {
            authorityFail(`Authenticode ${id} authority was invalid`);
          }
          const absolute = exactLocalPath(target.path, `Authenticode ${id} path`);
          if (providerRoots.some((root) => isPathWithin(absolute, root) || isPathWithin(root, absolute))) authorityFail(`Authenticode ${id} overlapped a provider home`);
          targetBindings.push(await stableBinding(absolute, `authenticode-${id}`, { bytes: target.bytes, sha256: target.sha256 }));
        }
        const fullPlan = {
          nodePath: targetBindings[0].path,
          powershellPath: privatePowerShellPath,
          pythonPath: targetBindings[1].path,
          schemaVersion: AUTHENTICODE_PLAN_SCHEMA,
          taskkillPath: privateTaskkillPath,
        };
        const timeoutMs = options.timeoutMs ?? 120_000;
        const result = await executePrivateEntry(entryBindings.authenticode, fullPlan, {
          maxOutputBytes: 4 * 1024 * 1024,
          operationId: "authenticode-probe",
          timeoutMs,
        });
        try {
          for (const binding of targetBindings) await replayBinding(binding);
          const receipt = immutableSnapshot(parseAuthenticodeReceipt(result.stdout));
          if (captureMode) captureAuthenticodeSnapshot = receipt;
          return receipt;
        } catch (error) {
          failed = true;
          throw error;
        }
      });
    },
    async runNativeOperation(operationId, ...unexpected) {
      return await withExclusiveOperation("native-command", async () => {
        if (unexpected.length !== 0) authorityFail("native operation accepted exactly one operation id");
        assertIdentifier(operationId, "native command operation id");
        if (!Object.hasOwn(nativeOperationTable, operationId)) authorityFail("native operation was not admitted");
        const operation = nativeOperationTable[operationId];
        if (consumedNativeOperations.has(operationId)) authorityFail("native operation was already consumed");
        consumedNativeOperations.add(operationId);
        try {
        const executable = exactLocalPath(operation.plan.executable, "native executable");
        if (["powershell.exe", "taskkill.exe"].includes(path.basename(executable).toLowerCase())) authorityFail("native command attempted a system-tool bypass");
        if (providerRoots.some((root) => isPathWithin(executable, root) || isPathWithin(root, executable))) authorityFail("native executable overlapped a provider home");
        if (!samePath(executable, operation.executableAuthority.executable)) authorityFail("native executable did not equal its internal operation authority");
        const cwd = exactLocalPath(operation.plan.cwd, "native command cwd");
        if (providerRoots.some((root) => isPathWithin(cwd, root) || isPathWithin(root, cwd))) authorityFail("native command cwd overlapped a provider home");
        await assertNoReparseExistingPath(cwd, "native command cwd");
        const env = cloneClosedEnvironment(operation.plan.env, systemRoot, tempRoot);
        if (!isDeepStrictEqual(env, operation.plan.env)) authorityFail("native operation environment clone changed its exact closure");
        const bindingId = `native-${operation.executableAuthority.sha256.slice(0, 24)}`;
        let executableBinding;
        try {
          executableBinding = await stableBinding(executable, bindingId, operation.executableAuthority);
        } catch (error) {
          failed = true;
          throw error;
        }
        const planForRun = {
          args: [...operation.plan.args],
          cwd,
          env,
          executable,
          shell: false,
        };
        try {
          await replayBinding(privateBindings[1]);
        } catch (error) {
          failed = true;
          throw error;
        }
        let result;
        try {
          result = await runCommand(planForRun, {
            maxOutputBytes: operation.maxOutputBytes,
            ownedRootExitTimeoutMs: policy.ownedRootExitTimeoutMs,
            terminationAuthority: {
              cwd: runRoot,
              env: privateEnvironment,
              executable: privateTaskkillPath,
              executableId: "taskkill-private",
              policyId: policy.terminationInvocation,
            },
            terminationToolTimeoutMs: policy.terminationToolTimeoutMs,
            timeoutMs: operation.timeoutMs,
          });
        } catch (error) {
          cleanupCertain = false;
          failed = true;
          throw error;
        }
        try {
          commandFacts.push(commandFact(planForRun, result, {
            executionAuthority: bindingExecutionAuthority(executableBinding, "native-executable"),
            logicalArgv: operation.logicalArgv,
            logicalize: logicalizeNativeValue,
            operationId,
          }));
          await replayBinding(executableBinding);
          if (result.terminationRequested) await replayBinding(privateBindings[1]);
          if (
            result.signal !== null || result.timedOut || result.overflow || !result.ownedRootExitObserved ||
            result.cleanupOutcome !== "not-required" || result.terminationRequested ||
            result.terminationToolCompletionObserved || result.terminationToolExitCode !== null ||
            result.terminationToolSignal !== null || result.exitCode !== 0
          ) authorityFail(`${operationId} did not produce an admitted closed result`);
        } catch (error) {
          failed = true;
          throw error;
        }
        nativeOperationStdout.set(operationId, Buffer.from(result.stdout));
        return result;
        } catch (error) {
          failed = true;
          throw error;
        }
      });
    },
    async finalize() {
      try {
        return await withExclusiveOperation("finalize", async () => {
        if (finalized || tornDown || !privateAdmitted) authorityFail("private authority cannot be finalized twice");
        if (
          captureMode && (
            consumedNativeOperations.size !== nativeOperationEntries.length ||
            nativeOperationEntries.some(([operationId]) => !consumedNativeOperations.has(operationId)) ||
            consumedCaptureAuditPlans.size !== Object.keys(captureAuditPlanAuthorities).length ||
            Object.keys(captureAuditPlanAuthorities).some((operationId) => !consumedCaptureAuditPlans.has(operationId)) ||
            consumedCapturePathPhases.size !== capturePathPhases.length ||
            capturePathPhases.some((phaseId) => !consumedCapturePathPhases.has(phaseId)) ||
            captureAuthenticodeSnapshot === undefined
          )
        ) authorityFail("preseal capture did not consume the exact native and filesystem-audit operation closure");
        const afterReceipt = await executeAuditPlan(privateToolAuditPlan(privateToolRoot), {
          evidenceId: "private-system-tools-after",
          timeoutMs: 120_000,
        });
        const privateAfterTuples = afterReceipt.sources[0]?.files;
        if (!isDeepStrictEqual(privateAfterTuples, privateBeforeTuples)) authorityFail("private system tool closure changed during use");
        const payloadEvidence = captureMode ? immutableSnapshot({
          filesystemAudits: buildCaptureFilesystemAudits(),
          pathPolicy: buildCapturePathPolicyFacts(),
          signatures: await buildCaptureSignatures(),
        }) : undefined;
        if (captureMode && !isDeepStrictEqual(commandFacts.map((fact) => fact.executableId), captureExpectedCommandIds)) {
          authorityFail("preseal capture command sequence did not equal its exact fixed closure");
        }
        let loadedModuleExecution;
        if (captureMode) {
          const counters = launchExecution.context.snapshotLoaderCounters();
          if (
            !Array.isArray(counters) || !Object.isFrozen(counters) || counters.length !== CAPTURE_MODULE_GRAPH.length + 1 ||
            counters.some((value, index) => !Number.isSafeInteger(value) || value !== (index < CAPTURE_MODULE_GRAPH.length ? 1 : 0))
          ) authorityFail("preseal in-memory loader did not serve the exact seven-module zero-reject closure");
          loadedModuleExecution = immutableSnapshot({
            executionGraphSha256: launchExecution.context.executionGraphSha256,
            inMemoryExecution: true,
            launchArgvSha256: launchExecution.context.launchArgvSha256,
            launcherBinding: launchExecution.launcherBinding.tuple,
            launcherKind: PRESEAL_INLINE_LAUNCHER_KIND,
            loadEventIds: CAPTURE_MODULE_GRAPH.map(([id]) => id),
            loaderBinding: launchExecution.loaderBinding.tuple,
            loaderReadyChallenge: launchExecution.context.loaderReadyChallenge,
            loaderReadyReceiptSha256: launchExecution.context.loaderReadyReceiptSha256,
            loaderSha256: launchExecution.context.loaderSha256,
            rejectedRequestCount: counters[CAPTURE_MODULE_GRAPH.length],
            sourceStableReplayedAfterUse: true,
          });
        }
        for (const binding of [...allFixedBindings, ...privateBindings]) await replayBinding(binding);
        for (const pair of sourcePairs) await replaySourcePair(pair);
        const sourcePowerShellFacts = commandFacts.filter((fact) => fact.executionAuthority.kind === "powershell-source-bootstrap");
        if (
          sourcePowerShellFacts.length !== 1 ||
          commandFacts.some((fact) =>
            fact.terminationRequested || fact.cleanupOutcome !== "not-required" || !fact.ownedRootExitObserved ||
            fact.signal !== null || fact.timedOut || fact.overflow
          )
        ) authorityFail("passing authority command closure used source replay or cleanup");
        finalized = true;
        privateAdmitted = false;
        finalizationSnapshot = immutableSnapshot({
          bootstrapFailureCleanupUsed: false,
          bootstrapReceipt,
          bootstrapSourcePowerShellExecutions: 1,
          commandCount: commandFacts.length,
          commands: commandFacts,
          entryBindings: [entryBindings.authenticode, entryBindings.pathPolicy].map((binding) => binding.tuple),
          ...(captureMode ? {
            exclusionIds: pathPolicy.exclusions.map((entry) => entry.id),
            loadedModuleBindings: loadedModuleBindings.map((binding) => binding.tuple),
            loadedModuleExecution,
            payloadEvidence,
          } : {}),
          privateCopy: {
            ...privateBeforeSummary,
            beforeAfterExactTupleEquality: true,
          },
          sourceIdentityPolicy: policy.sourceIdentity,
          sourceTaskkillExecutions: 0,
          sourceTopologies: sourcePairs.map((pair) => ({
            aliasesShareOneStableIdentity: true,
            bytes: pair.tool.bytes,
            doubleHashReplay: true,
            hardlinkCount: pair.tool.hardlinkCount,
            id: `${pair.id}-source`,
            logicalPaths: [...pair.tool.logicalPaths],
            noReparseComponents: true,
            sha256: pair.tool.sha256,
            sourceSurfaceSha256: sha256(canonicalJsonBytes(
              pair.tool.logicalPaths.map((logicalPath) => [logicalPath, pair.tool.bytes, pair.tool.sha256]),
            )),
            stableIdentityReplayedAfterUse: true,
          })),
          terminationInvocationPolicy: policy.terminationInvocation,
          terminationRequestedCount: 0,
          workerBindings: bindings.map((binding) => binding.tuple),
        });
          return finalizationSnapshot;
        });
      } catch (error) {
        failed = true;
        throw error;
      }
    },
    async writePayload(bytes, ...unexpected) {
      return await withExclusiveOperation("write-payload", async () => {
        if (unexpected.length !== 0) authorityFail("payload write accepted exactly one byte value");
        if (!captureMode || !finalized || tornDown || failed || finalizationSnapshot === undefined || payloadWriteSnapshot !== undefined) {
          authorityFail("payload write lacked one positive finalized capture authority");
        }
        try {
          const payloadBytes = Buffer.from(bytes);
          const document = parseCanonicalDocument(
            payloadBytes,
            MAX_PRESEAL_PAYLOAD_BYTES,
            "preseal payload",
            MAX_PRESEAL_PAYLOAD_MEMBERS,
          );
          assertExactKeys(document, PRESEAL_PAYLOAD_KEYS, "preseal payload");
          if (captureAuthenticodeSnapshot === undefined) authorityFail("preseal payload lacked the exact Authenticode operation");
          const expectedAuthenticodeFacts = captureAuthenticodeSnapshot.facts.map((fact) =>
            ["node", "python"].includes(fact.id)
              ? { id: fact.id, serial: fact.serial, status: fact.status, subject: fact.subject, thumbprint: fact.thumbprint }
              : {
                certificateSubject: fact.certificateSubject,
                embeddedFileVersion: fact.embeddedFileVersion,
                id: fact.id,
                serial: fact.serial,
                status: fact.status,
                thumbprint: fact.thumbprint,
              });
          const expectedAuthenticode = {
            facts: expectedAuthenticodeFacts,
            osBound: true,
            verificationToolIdentityPolicy: policy.bootstrapExecution,
            verificationToolSha256: SEALED_SYSTEM_TOOL_AUTHORITY.authenticodeVerificationTool.sha256,
          };
          assertExactKeys(document.filesystemAudits, [
            "gitExecPathAfter", "gitExecPathBefore", "gitPrivateAfter", "gitPrivateBefore", "gitSourceAfter", "gitSourceBefore",
            "gpgCopiedAfter", "gpgCopiedBefore", "gpgSource", "officialObjects", "privateSystemToolsAfter", "privateSystemToolsBefore",
            "pnpmDistributionAfter", "pnpmDistributionBefore", "pnpmStoreAfter", "pnpmStoreBefore",
          ], "preseal payload filesystem audits");
          assertExactKeys(document.pathPolicy, ["gitRewriteInputs", "gpgCopy", "postcreate", "prestage", "prewrite"], "preseal payload path policy");
          assertExactKeys(document.signatures, ["llvm", "node", "pnpmRegistry", "python"], "preseal payload signatures");
          if (
            document.schemaVersion !== PRESEAL_PAYLOAD_SCHEMA || document.runId !== runLeaf || document.outcome !== "passed" ||
            !isDeepStrictEqual(document.commands, finalizationSnapshot.commands) ||
            !isDeepStrictEqual(document.configAuthority, expectedConfigAuthority) ||
            !isDeepStrictEqual(document.authenticode, expectedAuthenticode) ||
            !isDeepStrictEqual(document.filesystemAudits, finalizationSnapshot.payloadEvidence.filesystemAudits) ||
            !isDeepStrictEqual(document.pathPolicy, finalizationSnapshot.payloadEvidence.pathPolicy) ||
            !isDeepStrictEqual(document.signatures, finalizationSnapshot.payloadEvidence.signatures) ||
            document.servicedSystemTools?.commandCount !== finalizationSnapshot.commandCount ||
            !isDeepStrictEqual(document.servicedSystemTools?.exclusionIds, finalizationSnapshot.exclusionIds) ||
            !isDeepStrictEqual(document.servicedSystemTools?.loadedModuleBindings, finalizationSnapshot.loadedModuleBindings) ||
            !isDeepStrictEqual(document.servicedSystemTools?.loadedModuleExecution, finalizationSnapshot.loadedModuleExecution) ||
            document.scope?.payloadLogicalPath !== payloadLogicalPath || document.scope?.receiptLogicalPath !== rootLogicalPath
          ) {
            authorityFail("preseal payload did not bind the finalized passing run");
          }
          await replayReceiptDirectoryAuthority("payload prewrite");
          await assertReceiptPathAbsent(payloadPath, "payload final path");
          await assertReceiptPathAbsent(payloadTemporaryPath, "payload temporary path");
          const observed = await atomicWriteVerified(payloadPath, payloadTemporaryPath, payloadBytes, MAX_PRESEAL_PAYLOAD_BYTES);
          await assertReceiptPathAbsent(payloadTemporaryPath, "payload temporary postwrite path");
          await replayReceiptDirectoryAuthority("payload postwrite");
          payloadWriteSnapshot = immutableSnapshot({
            bytes: observed.bytes,
            logicalPath: payloadLogicalPath,
            sha256: observed.sha256,
          });
          return payloadWriteSnapshot;
        } catch (error) {
          failed = true;
          throw error;
        }
      }, { requireActive: false });
    },
    async teardown() {
      return await withExclusiveOperation("teardown", async () => {
        if (
          !finalized || tornDown || failed || !cleanupCertain || finalizationSnapshot === undefined ||
          (captureMode && payloadWriteSnapshot === undefined)
        ) authorityFail("authority teardown lacked positive finalized process and payload closure");
        try {
        if (path.dirname(runRoot).toLowerCase() !== authorityParent.toLowerCase() || path.basename(runRoot) !== runLeaf) {
          authorityFail("authority teardown root escaped its admitted parent");
        }
        const replayParent = await directoryIdentity(authorityParent, "authority parent teardown replay");
        if (!isDeepStrictEqual(replayParent, parentIdentity)) authorityFail("authority parent identity changed before teardown");
        await assertNoReparseExistingPath(runRoot, "authority run teardown root");
        const replayRunRoot = await directoryIdentity(runRoot, "authority run root teardown replay");
        if (!isDeepStrictEqual(replayRunRoot, runRootIdentity)) authorityFail("authority run-root identity changed before teardown");
        try {
          await fs.rm(runRoot, { recursive: true, force: false });
        } catch (error) {
          cleanupCertain = false;
          throw error;
        }
        try {
          await fs.lstat(runRoot);
          cleanupCertain = false;
          authorityFail("authority teardown root remained present");
        } catch (error) {
          if (error?.code !== "ENOENT") {
            cleanupCertain = false;
            throw error;
          }
        }
        const finalParent = await directoryIdentity(authorityParent, "authority parent post-teardown replay");
        if (!isDeepStrictEqual(finalParent, parentIdentity)) {
          cleanupCertain = false;
          authorityFail("authority parent identity changed after teardown");
        }
        tornDown = true;
        teardownSnapshot = immutableSnapshot({
          outcome: "removed",
          parentIdentityReplayed: true,
          runId: runLeaf,
          runRootAbsent: true,
          runRootDirectChild: true,
        });
        return teardownSnapshot;
        } catch (error) {
          failed = true;
          throw error;
        }
      }, { requireActive: false });
    },
    async writeRoot(bytes, ...unexpected) {
      return await withExclusiveOperation("write-root", async () => {
        if (unexpected.length !== 0) authorityFail("root write accepted exactly one byte value");
        if (
          !captureMode || !finalized || !tornDown || failed || payloadWriteSnapshot === undefined ||
          teardownSnapshot === undefined || rootWriteSnapshot !== undefined
        ) authorityFail("root write lacked one positive payload and teardown closure");
        try {
          const rootBytes = Buffer.from(bytes);
          const document = parseCanonicalDocument(rootBytes, MAX_PRESEAL_ROOT_BYTES, "preseal root");
          assertExactKeys(document, ["outcome", "payload", "runId", "schemaVersion", "teardown"], "preseal root");
          assertExactKeys(document.payload, ["bytes", "logicalPath", "sha256"], "preseal root payload");
          if (
            document.schemaVersion !== PRESEAL_ROOT_SCHEMA || document.runId !== runLeaf || document.outcome !== "passed" ||
            !isDeepStrictEqual(document.payload, payloadWriteSnapshot) || !isDeepStrictEqual(document.teardown, teardownSnapshot)
          ) authorityFail("preseal root did not bind the exact payload/run/teardown closure");
          await replayReceiptDirectoryAuthority("root prewrite");
          const payloadBinding = await stableBinding(payloadPath, "preseal-payload", {
            bytes: payloadWriteSnapshot.bytes,
            sha256: payloadWriteSnapshot.sha256,
          });
          await assertReceiptPathAbsent(rootPath, "root final path");
          await assertReceiptPathAbsent(rootTemporaryPath, "root temporary path");
          const observed = await atomicWriteVerified(rootPath, rootTemporaryPath, rootBytes, MAX_PRESEAL_ROOT_BYTES);
          await assertReceiptPathAbsent(rootTemporaryPath, "root temporary postwrite path");
          await replayBinding(payloadBinding);
          await replayReceiptDirectoryAuthority("root postwrite");
          rootWriteSnapshot = immutableSnapshot({
            bytes: observed.bytes,
            logicalPath: rootLogicalPath,
            sha256: observed.sha256,
          });
          return rootWriteSnapshot;
        } catch (error) {
          failed = true;
          throw error;
        }
      }, { requireActive: false });
    },
  };
  return Object.freeze(authority);
}

export async function prepareFilesystemAuditAuthority(...unexpected) {
  if (unexpected.length !== 0) authorityFail("filesystem audit authority accepts no overrides");
  return await prepareFixedSystemToolAuthority("filesystem-audit");
}

export async function preparePresealCaptureAuthority(...unexpected) {
  if (unexpected.length !== 0) authorityFail("preseal capture authority accepts no overrides");
  return await prepareFixedSystemToolAuthority("preseal-capture");
}
