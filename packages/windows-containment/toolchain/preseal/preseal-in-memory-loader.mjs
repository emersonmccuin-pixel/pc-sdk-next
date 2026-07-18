import { createHash } from "node:crypto";

const READY_SCHEMA = "pc-sdk.cx-004.preseal-loader-ready.v1";
const IDENTIFIER_PATTERN = /^[a-z0-9][a-z0-9._-]{0,95}$/u;
const SHA256_PATTERN = /^[0-9a-f]{64}$/u;
const MODULE_IDS = Object.freeze([
  "preseal-capture-entry",
  "system-tool-authority-module",
  "preseal-evidence-module",
  "runner-bootstrap-module",
  "manifest-set-module",
  "preseal-config-projection-module",
  "pe-inspect-module",
]);
const BUILTINS = new Set([
  "node:child_process",
  "node:crypto",
  "node:fs",
  "node:fs/promises",
  "node:os",
  "node:path",
  "node:url",
  "node:util",
]);

let moduleByUrl;
let counters;

function reject(message) {
  if (counters !== undefined) Atomics.add(counters, MODULE_IDS.length, 1);
  throw new Error(`preseal in-memory loader: ${message}`);
}

function exactKeys(value, expected) {
  return value !== null && typeof value === "object" && !Array.isArray(value) &&
    JSON.stringify(Object.keys(value).sort()) === JSON.stringify([...expected].sort());
}

function digest(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

export function initialize(data) {
  if (moduleByUrl !== undefined || !exactKeys(data, [
    "challenge",
    "counters",
    "executionGraphSha256",
    "loaderSha256",
    "modules",
    "port",
  ])) {
    throw new Error("preseal in-memory loader: initialization shape mismatch");
  }
  if (
    typeof data.challenge !== "string" || !/^[0-9a-f]{32}$/u.test(data.challenge) ||
    typeof data.executionGraphSha256 !== "string" || !SHA256_PATTERN.test(data.executionGraphSha256) ||
    typeof data.loaderSha256 !== "string" || !SHA256_PATTERN.test(data.loaderSha256) ||
    !Array.isArray(data.modules) || data.modules.length !== MODULE_IDS.length ||
    Object.prototype.toString.call(data.counters) !== "[object SharedArrayBuffer]" ||
    data.counters.byteLength !== Int32Array.BYTES_PER_ELEMENT * (MODULE_IDS.length + 1) ||
    data.port === null || typeof data.port !== "object" || typeof data.port.postMessage !== "function"
  ) throw new Error("preseal in-memory loader: initialization authority mismatch");
  counters = new Int32Array(data.counters);
  if (Array.from(counters, (_, index) => Atomics.load(counters, index)).some((value) => value !== 0)) {
    throw new Error("preseal in-memory loader: counter authority was not fresh");
  }
  const entries = [];
  for (const [index, entry] of data.modules.entries()) {
    if (!exactKeys(entry, ["byteLength", "bytes", "id", "sha256", "url"])) {
      throw new Error("preseal in-memory loader: module entry shape mismatch");
    }
    let parsed;
    try { parsed = new URL(entry.url); } catch { throw new Error("preseal in-memory loader: module URL mismatch"); }
    if (
      entry.id !== MODULE_IDS[index] || !IDENTIFIER_PATTERN.test(entry.id) ||
      parsed.protocol !== "file:" || parsed.search !== "" || parsed.hash !== "" || parsed.href !== entry.url ||
      !(entry.bytes instanceof Uint8Array) || !Number.isSafeInteger(entry.byteLength) || entry.byteLength < 1 ||
      entry.bytes.byteLength !== entry.byteLength || !SHA256_PATTERN.test(entry.sha256) || digest(entry.bytes) !== entry.sha256
    ) throw new Error("preseal in-memory loader: module entry authority mismatch");
    entries.push([entry.url, { bytes: entry.bytes, id: entry.id }]);
  }
  moduleByUrl = new Map(entries);
  if (moduleByUrl.size !== MODULE_IDS.length) throw new Error("preseal in-memory loader: module URL closure repeated");
  data.port.unref();
  data.port.postMessage({
    challenge: data.challenge,
    executionGraphSha256: data.executionGraphSha256,
    loaderSha256: data.loaderSha256,
    moduleCount: MODULE_IDS.length,
    schemaVersion: READY_SCHEMA,
  });
  data.port.close();
}

export async function resolve(specifier, context, nextResolve) {
  if (BUILTINS.has(specifier)) return await nextResolve(specifier, context);
  if (specifier.startsWith("node:")) return reject("builtin escaped the exact closure");
  let candidate;
  try {
    if (specifier.startsWith("file:")) candidate = new URL(specifier).href;
    else if ((specifier.startsWith("./") || specifier.startsWith("../")) && moduleByUrl.has(context.parentURL)) {
      candidate = new URL(specifier, context.parentURL).href;
    } else return reject("specifier escaped the exact graph");
  } catch {
    return reject("specifier URL was invalid");
  }
  if (!moduleByUrl.has(candidate)) return reject("resolved URL escaped the exact graph");
  return { format: "module", shortCircuit: true, url: candidate };
}

export async function load(url, context, nextLoad) {
  if (BUILTINS.has(url)) return await nextLoad(url, context);
  if (url.startsWith("node:")) return reject("builtin load escaped the exact closure");
  const entry = moduleByUrl.get(url);
  if (entry === undefined) return reject("load URL escaped the exact graph");
  const index = MODULE_IDS.indexOf(entry.id);
  if (index < 0) return reject("load id escaped the exact graph");
  Atomics.add(counters, index, 1);
  return { format: "module", shortCircuit: true, source: Buffer.from(entry.bytes) };
}
