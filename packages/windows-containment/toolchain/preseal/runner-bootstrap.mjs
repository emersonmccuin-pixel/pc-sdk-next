import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";

export const SEALED_RUNNER = Object.freeze({
  architecture: "x64",
  cacheRelativePath: "PC-SDK-Next/toolchains/cx-004/trees/sha256/b0feb09ebf41328628e7383f7a092fb7342ce1e05c867a90cf8f1379205a8429/node-v22.13.0-win-x64/node.exe",
  modules: "127",
  napi: "9",
  platform: "win32",
  sha256: "364dbc8442f8d5c04fd4226bcfcf8e60d3268627eb1d7be214a91bb7d74cdbb9",
  version: "22.13.0",
});

function fail(label) {
  throw new Error(`sealed runner bootstrap rejected ${label}`);
}

function isEmptyEnvironmentValue(value) {
  return value === undefined || value === "";
}

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

function assertInlineLaunchOptions(options) {
  const actual = Object.keys(options).sort();
  if (JSON.stringify(actual) !== JSON.stringify(["launchArgvSha256", "launcherSha256"])) {
    fail("inline launch options");
  }
  if (
    typeof options.launchArgvSha256 !== "string" || !/^[0-9a-f]{64}$/u.test(options.launchArgvSha256) ||
    typeof options.launcherSha256 !== "string" || !/^[0-9a-f]{64}$/u.test(options.launcherSha256)
  ) fail("inline launch digests");
}

export function assertBootstrapRuntimeShape(runtime, options = {}) {
  if (runtime.platform !== SEALED_RUNNER.platform) fail("platform");
  if (runtime.architecture !== SEALED_RUNNER.architecture) fail("architecture");
  if (runtime.version !== SEALED_RUNNER.version) fail("version");
  if (runtime.modules !== SEALED_RUNNER.modules) fail("ABI");
  if (runtime.napi !== SEALED_RUNNER.napi) fail("N-API");
  const inlineLaunch = Object.keys(options).length !== 0;
  if (inlineLaunch) {
    assertInlineLaunchOptions(options);
    if (
      !Array.isArray(runtime.argv) || runtime.argv.length !== 1 ||
      !Array.isArray(runtime.execArgv) || runtime.execArgv.length !== 3 ||
      runtime.execArgv[0] !== "--input-type=module" || runtime.execArgv[1] !== "-e" ||
      typeof runtime.execArgv[2] !== "string" || runtime.execArgv[2].length === 0 ||
      sha256(Buffer.from(runtime.execArgv[2], "utf8")) !== options.launcherSha256 ||
      sha256(Buffer.from(JSON.stringify([
        "--input-type=module",
        "-e",
        `<inline-launcher:${options.launcherSha256}>`,
      ]), "utf8")) !== options.launchArgvSha256
    ) fail("inline execArgv");
  } else if (!Array.isArray(runtime.execArgv) || runtime.execArgv.length !== 0) {
    fail("nonempty execArgv");
  }
  if (!isEmptyEnvironmentValue(runtime.nodeOptions)) fail("NODE_OPTIONS");
  if (!isEmptyEnvironmentValue(runtime.nodePath)) fail("NODE_PATH");
  if (typeof runtime.localAppData !== "string" || runtime.localAppData.length === 0) fail("LOCALAPPDATA");
  const expectedPath = path.resolve(runtime.localAppData, ...SEALED_RUNNER.cacheRelativePath.split("/"));
  if (path.resolve(runtime.execPath).toLowerCase() !== expectedPath.toLowerCase()) fail("executable path");
  return expectedPath;
}

export async function assertNoReparseExistingPath(input, label) {
  const absolute = path.resolve(input);
  if (!/^[A-Za-z]:[\\/]/u.test(absolute) || absolute.startsWith("\\\\") || absolute.startsWith("\\\\?\\") || absolute.startsWith("\\\\.\\")) {
    fail(`${label} local-drive path`);
  }
  const root = path.parse(absolute).root;
  let cursor = root;
  const relative = path.relative(root, absolute);
  const components = relative === "" ? [] : relative.split(path.sep);
  for (const component of components) {
    cursor = path.join(cursor, component);
    const stat = await fs.lstat(cursor);
    if (stat.isSymbolicLink()) fail(`${label} reparse component`);
  }
  return absolute;
}

async function hashStableBootstrapExecutable(executablePath) {
  const linkStat = await fs.lstat(executablePath);
  if (!linkStat.isFile() || linkStat.isSymbolicLink() || linkStat.nlink !== 1) fail("executable identity");
  const handle = await fs.open(executablePath, "r");
  try {
    const before = await handle.stat({ bigint: true });
    const digest = createHash("sha256");
    let byteLength = 0;
    for await (const chunk of handle.createReadStream({ autoClose: false })) {
      digest.update(chunk);
      byteLength += chunk.length;
    }
    const after = await handle.stat({ bigint: true });
    if (
      before.dev !== after.dev ||
      before.ino !== after.ino ||
      before.size !== after.size ||
      before.mtimeNs !== after.mtimeNs ||
      before.nlink !== 1n ||
      after.nlink !== 1n ||
      byteLength !== Number(before.size)
    ) {
      fail("executable stability");
    }
    const observedSha256 = digest.digest("hex");
    if (observedSha256 !== SEALED_RUNNER.sha256) fail("executable SHA-256");
    return { bytes: byteLength, sha256: observedSha256 };
  } finally {
    await handle.close();
  }
}

export async function validateSealedRunnerBeforeInputRead(options = {}) {
  const inlineLaunch = Object.keys(options).length !== 0;
  const expectedPath = assertBootstrapRuntimeShape({
    architecture: process.arch,
    argv: process.argv,
    execArgv: process.execArgv,
    execPath: process.execPath,
    localAppData: process.env.LOCALAPPDATA,
    modules: process.versions.modules,
    napi: process.versions.napi,
    nodeOptions: process.env.NODE_OPTIONS,
    nodePath: process.env.NODE_PATH,
    platform: process.platform,
    version: process.versions.node,
  }, options);
  await assertNoReparseExistingPath(expectedPath, "executable");
  const identity = await hashStableBootstrapExecutable(expectedPath);
  const receipt = {
    abi: Number.parseInt(SEALED_RUNNER.modules, 10),
    architecture: SEALED_RUNNER.architecture,
    bytes: identity.bytes,
    nApi: Number.parseInt(SEALED_RUNNER.napi, 10),
    nodeOptionsEmpty: true,
    nodePathEmpty: true,
    platform: SEALED_RUNNER.platform,
    sha256: identity.sha256,
    version: SEALED_RUNNER.version,
  };
  if (inlineLaunch) {
    receipt.execArgvPolicy = "pinned-inline-launcher-v1";
    receipt.launchArgvSha256 = options.launchArgvSha256;
  } else {
    receipt.execArgvEmpty = true;
  }
  return receipt;
}
