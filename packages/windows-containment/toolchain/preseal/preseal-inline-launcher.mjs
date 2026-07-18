if (
  process.platform !== "win32" || process.arch !== "x64" || process.versions.node !== "22.13.0" ||
  process.versions.modules !== "127" || process.versions.napi !== "9" ||
  Object.keys(process.env).some((name) => /^NODE_/iu.test(name) && process.env[name] !== "") ||
  typeof process.env.LOCALAPPDATA !== "string" || process.env.LOCALAPPDATA.length === 0 ||
  process.argv.length !== 1 || process.execArgv.length !== 3 ||
  process.execArgv[0] !== "--input-type=module" || process.execArgv[1] !== "-e" ||
  typeof process.execArgv[2] !== "string" || process.execArgv[2].length === 0
) throw new Error("preseal inline launcher: sealed runtime boundary was invalid");

const expectedRuntimePath = `${process.env.LOCALAPPDATA.replaceAll("\\", "/").replace(/\/+$/u, "")}/PC-SDK-Next/toolchains/cx-004/trees/sha256/b0feb09ebf41328628e7383f7a092fb7342ce1e05c867a90cf8f1379205a8429/node-v22.13.0-win-x64/node.exe`;
if (process.execPath.replaceAll("\\", "/").toLowerCase() !== expectedRuntimePath.toLowerCase()) {
  throw new Error("preseal inline launcher: sealed runtime path was invalid");
}

const LAUNCH_SCHEMA = "pc-sdk.cx-004.preseal-inline-launch.v1";
const LOADER_READY_SCHEMA = "pc-sdk.cx-004.preseal-loader-ready.v1";
const LAUNCHER_KIND = "pinned-node-inline-memory-loader-v1";
const RUNTIME_SHA256 = "364dbc8442f8d5c04fd4226bcfcf8e60d3268627eb1d7be214a91bb7d74cdbb9";
const CONTEXT_NAME = "__PC_SDK_PRESEAL_LAUNCH_CONTEXT__";
const LAUNCHER_RELATIVE_PATH = "packages/windows-containment/toolchain/preseal/preseal-inline-launcher.mjs";
const LOADER_RELATIVE_PATH = "packages/windows-containment/toolchain/preseal/preseal-in-memory-loader.mjs";
const MODULE_GRAPH = Object.freeze([
  Object.freeze(["preseal-capture-entry", "packages/windows-containment/toolchain/preseal/capture-preseal-evidence.mjs"]),
  Object.freeze(["system-tool-authority-module", "packages/windows-containment/toolchain/preseal/system-tool-authority.mjs"]),
  Object.freeze(["preseal-evidence-module", "packages/windows-containment/toolchain/preseal/preseal-evidence.mjs"]),
  Object.freeze(["runner-bootstrap-module", "packages/windows-containment/toolchain/preseal/runner-bootstrap.mjs"]),
  Object.freeze(["manifest-set-module", "packages/windows-containment/toolchain/manifest-set.mjs"]),
  Object.freeze(["preseal-config-projection-module", "packages/windows-containment/toolchain/preseal-config-projection.mjs"]),
  Object.freeze(["pe-inspect-module", "packages/windows-containment/toolchain/probe/pe-inspect.mjs"]),
]);

function fail(message) {
  throw new Error(`preseal inline launcher: ${message}`);
}

function freezeDeep(value) {
  if (value === null || typeof value !== "object" || Object.isFrozen(value)) return value;
  if (ArrayBuffer.isView(value) || value instanceof ArrayBuffer || value instanceof SharedArrayBuffer) return value;
  for (const child of Object.values(value)) freezeDeep(child);
  return Object.freeze(value);
}

function canonicalJson(value) {
  if (value === null) return "null";
  if (typeof value === "boolean") return value ? "true" : "false";
  if (typeof value === "string") return JSON.stringify(value);
  if (typeof value === "number") {
    if (!Number.isSafeInteger(value)) fail("canonical JSON received a non-integer number");
    return String(value);
  }
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (typeof value === "object" && Object.getPrototypeOf(value) === Object.prototype) {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(",")}}`;
  }
  fail("canonical JSON received an unsupported value");
}

function exactKeys(value, expected) {
  return value !== null && typeof value === "object" && !Array.isArray(value) &&
    JSON.stringify(Object.keys(value).sort()) === JSON.stringify([...expected].sort());
}

const { createHash, randomBytes } = await import("node:crypto");
const { promises: fs } = await import("node:fs");
const { register } = await import("node:module");
const path = (await import("node:path")).default;
const { pathToFileURL } = await import("node:url");
const { MessageChannel } = await import("node:worker_threads");

const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");
const sameIdentity = (left, right) => (
  left.dev === right.dev && left.ino === right.ino && left.mtimeNs === right.mtimeNs &&
  left.nlink === right.nlink && left.size === right.size
);
const samePathIdentity = (handleIdentity, pathIdentity) => (
  pathIdentity.dev === "0" && handleIdentity.ino === pathIdentity.ino &&
  handleIdentity.mtimeNs === pathIdentity.mtimeNs &&
  handleIdentity.nlink === pathIdentity.nlink && handleIdentity.size === pathIdentity.size
);
const identity = (stat) => ({
  dev: stat.dev.toString(),
  ino: stat.ino.toString(),
  mtimeNs: stat.mtimeNs.toString(),
  nlink: stat.nlink.toString(),
  size: stat.size.toString(),
});

function exactLocalPath(value, label) {
  if (typeof value !== "string" || value.length === 0 || value.includes("\0")) fail(`${label} was invalid`);
  const absolute = path.resolve(value);
  if (process.platform !== "win32" || !/^[A-Za-z]:[\\/]/u.test(absolute) || absolute.startsWith("\\\\")) {
    fail(`${label} was not one local Windows path`);
  }
  return absolute;
}

async function assertNoReparseExistingPath(candidate, label) {
  const absolute = exactLocalPath(candidate, label);
  const parsed = path.parse(absolute);
  let current = parsed.root;
  const parts = absolute.slice(parsed.root.length).split(path.sep).filter(Boolean);
  for (const part of parts) {
    current = path.join(current, part);
    const stat = await fs.lstat(current, { bigint: true });
    if (stat.isSymbolicLink()) fail(`${label} crossed a reparse point`);
  }
  return absolute;
}

async function readHeldTwice(handle, expectedSize, label) {
  if (!Number.isSafeInteger(expectedSize) || expectedSize < 1 || expectedSize > 4 * 1024 * 1024) {
    fail(`${label} size was invalid`);
  }
  const readPass = async () => {
    const output = Buffer.alloc(expectedSize);
    let offset = 0;
    while (offset < output.length) {
      const { bytesRead } = await handle.read(output, offset, output.length - offset, offset);
      if (bytesRead < 1) fail(`${label} ended before its stable size`);
      offset += bytesRead;
    }
    const extra = Buffer.alloc(1);
    if ((await handle.read(extra, 0, 1, expectedSize)).bytesRead !== 0) fail(`${label} exceeded its stable size`);
    return output;
  };
  const first = await readPass();
  const second = await readPass();
  if (!first.equals(second) || sha256(first) !== sha256(second)) fail(`${label} double-read mismatch`);
  return first;
}

async function bindSource(filePath, id, expectedBytes) {
  const absolute = await assertNoReparseExistingPath(filePath, `${id} source`);
  const handle = await fs.open(absolute, "r");
  try {
    const before = await handle.stat({ bigint: true });
    const beforeIdentity = identity(before);
    if (!before.isFile() || before.isSymbolicLink() || before.nlink !== 1n || before.size < 1n || before.size > 4n * 1024n * 1024n) {
      fail(`${id} source identity was invalid`);
    }
    const bytes = await readHeldTwice(handle, Number(before.size), `${id} source`);
    if (expectedBytes !== undefined && !bytes.equals(expectedBytes)) {
      fail(`${id} source did not equal the exact evaluated launcher bytes`);
    }
    const after = await handle.stat({ bigint: true });
    if (!sameIdentity(beforeIdentity, identity(after))) fail(`${id} source identity changed during binding`);
    await assertNoReparseExistingPath(absolute, `${id} source postread`);
    const pathStat = await fs.lstat(absolute, { bigint: true });
    if (!samePathIdentity(beforeIdentity, identity(pathStat))) fail(`${id} source path changed during binding`);
    return freezeDeep({
      bytes,
      binding: { id, identity: beforeIdentity, path: absolute, tuple: [id, bytes.length, sha256(bytes)] },
    });
  } finally {
    await handle.close();
  }
}

async function bindRuntime(filePath) {
  const absolute = await assertNoReparseExistingPath(filePath, "sealed Node runtime");
  const handle = await fs.open(absolute, "r");
  try {
    const before = await handle.stat({ bigint: true });
    const beforeIdentity = identity(before);
    if (!before.isFile() || before.isSymbolicLink() || before.nlink !== 1n || before.size < 1n || before.size > 128n * 1024n * 1024n) {
      fail("sealed Node runtime identity was invalid");
    }
    const hashPass = async () => {
      const digest = createHash("sha256");
      let bytes = 0;
      for await (const chunk of handle.createReadStream({ autoClose: false, start: 0 })) {
        digest.update(chunk);
        bytes += chunk.length;
      }
      return { bytes, sha256: digest.digest("hex") };
    };
    const first = await hashPass();
    const second = await hashPass();
    if (
      first.bytes !== Number(before.size) || second.bytes !== first.bytes || first.sha256 !== RUNTIME_SHA256 ||
      second.sha256 !== first.sha256
    ) fail("sealed Node runtime double-hash mismatch");
    const after = await handle.stat({ bigint: true });
    await assertNoReparseExistingPath(absolute, "sealed Node runtime postread");
    const pathStat = await fs.lstat(absolute, { bigint: true });
    if (!sameIdentity(beforeIdentity, identity(after)) || !samePathIdentity(beforeIdentity, identity(pathStat))) {
      fail("sealed Node runtime identity changed during binding");
    }
    return freezeDeep({
      id: "sealed-node-runtime",
      identity: beforeIdentity,
      path: absolute,
      tuple: ["sealed-node-runtime", first.bytes, first.sha256],
    });
  } finally {
    await handle.close();
  }
}

function awaitReadyMessage(port, timeoutMs) {
  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = (operation, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      port.removeAllListeners();
      operation(value);
    };
    const timer = setTimeout(() => finish(reject, new Error("preseal inline launcher: loader ready timeout")), timeoutMs);
    port.once("message", (message) => finish(resolve, message));
    port.once("messageerror", () => finish(reject, new Error("preseal inline launcher: loader ready message error")));
    port.once("close", () => {
      if (!settled) finish(reject, new Error("preseal inline launcher: loader ready port closed early"));
    });
    port.start();
  });
}

if (Object.hasOwn(globalThis, CONTEXT_NAME)) fail("launch context was already present");
const evaluatedBytes = Buffer.from(process.execArgv[2], "utf8");
if (evaluatedBytes.length < 1 || evaluatedBytes.length > 256 * 1024) {
  fail("evaluated launcher bytes exceeded their fixed bound");
}
const sourceRoot = await assertNoReparseExistingPath(process.cwd(), "source repository root");
const runtimeBinding = await bindRuntime(process.execPath);
const launcherSource = await bindSource(
  path.join(sourceRoot, ...LAUNCHER_RELATIVE_PATH.split("/")),
  "preseal-inline-launcher",
  evaluatedBytes,
);
const loaderSource = await bindSource(
  path.join(sourceRoot, ...LOADER_RELATIVE_PATH.split("/")),
  "preseal-in-memory-loader",
);
const heldModules = [];
for (const [id, relativePath] of MODULE_GRAPH) {
  heldModules.push(await bindSource(path.join(sourceRoot, ...relativePath.split("/")), id));
}
const sourceBindings = freezeDeep(heldModules.map((entry) => entry.binding));
const launchArgvSha256 = sha256(Buffer.from(canonicalJson([
  "--input-type=module",
  "-e",
  `<inline-launcher:${launcherSource.binding.tuple[2]}>`,
]), "utf8"));
const executionGraphSha256 = sha256(Buffer.from(canonicalJson({
  launcherBinding: launcherSource.binding.tuple,
  loaderBinding: loaderSource.binding.tuple,
  moduleBindings: sourceBindings.map((binding) => binding.tuple),
}), "utf8"));
const loaderReadyChallenge = randomBytes(16).toString("hex");
if (!/^[0-9a-f]{32}$/u.test(loaderReadyChallenge)) fail("loader ready challenge was invalid");
const countersBuffer = new SharedArrayBuffer(Int32Array.BYTES_PER_ELEMENT * (MODULE_GRAPH.length + 1));
const counters = new Int32Array(countersBuffer);
const { port1, port2 } = new MessageChannel();
const readyPromise = awaitReadyMessage(port1, 5_000);
const loaderSha256 = loaderSource.binding.tuple[2];
const modules = heldModules.map((entry) => ({
  byteLength: entry.bytes.length,
  bytes: entry.bytes,
  id: entry.binding.id,
  sha256: entry.binding.tuple[2],
  url: pathToFileURL(entry.binding.path).href,
}));
register(`data:text/javascript;base64,${loaderSource.bytes.toString("base64")}`, {
  data: {
    challenge: loaderReadyChallenge,
    counters: countersBuffer,
    executionGraphSha256,
    loaderSha256,
    modules,
    port: port2,
  },
  transferList: [port2],
});
const readyReceipt = await readyPromise;
port1.close();
if (
  !exactKeys(readyReceipt, ["challenge", "executionGraphSha256", "loaderSha256", "moduleCount", "schemaVersion"]) ||
  readyReceipt.challenge !== loaderReadyChallenge || readyReceipt.executionGraphSha256 !== executionGraphSha256 ||
  readyReceipt.loaderSha256 !== loaderSha256 || readyReceipt.moduleCount !== MODULE_GRAPH.length ||
  readyReceipt.schemaVersion !== LOADER_READY_SCHEMA
) fail("loader ready receipt did not equal the exact in-memory execution graph");
const loaderReadyReceiptSha256 = sha256(Buffer.from(canonicalJson(readyReceipt), "utf8"));
const snapshotLoaderCounters = Object.freeze(() => (
  Object.freeze(Array.from(counters, (_, index) => Atomics.load(counters, index)))
));
const context = freezeDeep({
  executionGraphSha256,
  launchArgvSha256,
  launcherBinding: launcherSource.binding,
  launcherKind: LAUNCHER_KIND,
  loaderBinding: loaderSource.binding,
  loaderReadyChallenge,
  loaderReadyReceiptSha256,
  loaderSha256,
  runtimeBinding,
  schemaVersion: LAUNCH_SCHEMA,
  snapshotLoaderCounters,
  sourceBindings,
  sourceRoot,
});
Object.defineProperty(globalThis, CONTEXT_NAME, {
  configurable: false,
  enumerable: false,
  value: context,
  writable: false,
});
const captureBinding = sourceBindings.find((binding) => binding.id === "preseal-capture-entry");
if (captureBinding === undefined) fail("capture entry binding was unavailable");
await import(pathToFileURL(captureBinding.path).href);
