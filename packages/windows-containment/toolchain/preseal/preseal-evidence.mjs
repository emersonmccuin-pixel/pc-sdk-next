import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";

const PROVIDER_OR_SECRET_PATTERN = /(?:CODEX_HOME|CLAUDE_CONFIG_DIR|ANTHROPIC_(?:API_KEY|AUTH_TOKEN)|OPENAI_API_KEY|sessionId|Bearer\s+\S+|(?:^|[^A-Za-z0-9])sk-[A-Za-z0-9_-]{12,})/i;
const ABSOLUTE_WINDOWS_PATH_PATTERN = /(?:^|[^A-Za-z0-9+.-])(?:[A-Za-z]:[\\/]|\\\\(?:\?\\|\.\\|[^\\]))/;
const RESOLUTION_FIELDS = [
  "name",
  "version",
  "packageManager",
  "engines",
  "dependencies",
  "devDependencies",
  "optionalDependencies",
  "peerDependencies",
];
const AUDIT_RECEIPT_SCHEMA = "pc-sdk.cx-004.native-build-input-filesystem-audit-receipt.v1";
const SHA256_PATTERN = /^[0-9a-f]{64}$/u;

function compareOrdinal(left, right) {
  return left < right ? -1 : left > right ? 1 : 0;
}

function serializeCanonical(value, ancestors) {
  if (value === null) return "null";
  if (typeof value === "boolean") return value ? "true" : "false";
  if (typeof value === "string") return JSON.stringify(value);
  if (typeof value === "number") {
    if (!Number.isSafeInteger(value)) {
      throw new TypeError("canonical JSON permits safe integers only");
    }
    return String(value);
  }
  if (typeof value !== "object") {
    throw new TypeError(`canonical JSON cannot encode ${typeof value}`);
  }
  if (ancestors.has(value)) throw new TypeError("canonical JSON cannot encode cycles");
  ancestors.add(value);
  let rendered;
  if (Array.isArray(value)) {
    rendered = `[${value.map((entry) => serializeCanonical(entry, ancestors)).join(",")}]`;
  } else {
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) {
      throw new TypeError("canonical JSON objects must be plain objects");
    }
    const keys = Object.keys(value).sort(compareOrdinal);
    rendered = `{${keys
      .map((key) => `${JSON.stringify(key)}:${serializeCanonical(value[key], ancestors)}`)
      .join(",")}}`;
  }
  ancestors.delete(value);
  return rendered;
}

export function canonicalJsonBytes(value) {
  return Buffer.from(serializeCanonical(value, new Set()), "utf8");
}

export function parseCanonicalJsonBytes(bytes) {
  const input = Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes);
  if (input.length >= 3 && input[0] === 0xef && input[1] === 0xbb && input[2] === 0xbf) {
    throw new Error("canonical JSON must not have a UTF-8 BOM");
  }
  const text = new TextDecoder("utf-8", { fatal: true }).decode(input);
  if (text.includes("\u0000") || text.includes("\r") || text.includes("\n")) {
    throw new Error("canonical JSON must be a single frame without raw NUL/CR/LF bytes");
  }
  const parsed = JSON.parse(text);
  if (!canonicalJsonBytes(parsed).equals(input)) throw new Error("JSON bytes are not canonical");
  return parsed;
}

export function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

export function normalizeCanonicalLf(input) {
  const bytes = Buffer.isBuffer(input) ? input : Buffer.from(input);
  if (bytes.length >= 3 && bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) {
    throw new Error("UTF-8 BOM is forbidden");
  }
  const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  if (text.includes("\u0000")) throw new Error("NUL is forbidden");
  if (/\r(?!\n)/u.test(text)) throw new Error("bare CR is forbidden");
  const canonical = Buffer.from(text.replaceAll("\r\n", "\n"), "utf8");
  let lineFeeds = 0;
  for (const byte of canonical) if (byte === 0x0a) lineFeeds += 1;
  return {
    bom: false,
    bytes: canonical,
    byteLength: canonical.length,
    lineFeeds,
    sha256: sha256(canonical),
    terminalLf: canonical.length > 0 && canonical.at(-1) === 0x0a,
  };
}

export function packageResolutionProjection(packageJson) {
  if (!packageJson || typeof packageJson !== "object" || Array.isArray(packageJson)) {
    throw new TypeError("package manifest must be an object");
  }
  const projection = Object.create(null);
  for (const field of RESOLUTION_FIELDS) {
    if (Object.hasOwn(packageJson, field)) projection[field] = packageJson[field];
  }
  return canonicalJsonBytes(projection);
}

function visitStrings(value, visitor, location = "$") {
  if (typeof value === "string") {
    visitor(value, location);
    return;
  }
  if (!value || typeof value !== "object") return;
  if (Array.isArray(value)) {
    value.forEach((entry, index) => visitStrings(entry, visitor, `${location}[${index}]`));
    return;
  }
  for (const key of Object.keys(value)) {
    visitor(key, `${location}.<key>`);
    visitStrings(value[key], visitor, `${location}.${key}`);
  }
}

export function assertReceiptPrivate(receipt, { forbiddenSubstrings = [], actualRoots = [] } = {}) {
  const forbidden = [...forbiddenSubstrings, ...actualRoots]
    .filter((entry) => typeof entry === "string" && entry.length > 0)
    .flatMap((entry) => [entry, entry.replaceAll("\\", "/"), entry.replaceAll("/", "\\")]);
  visitStrings(receipt, (text, location) => {
    if (PROVIDER_OR_SECRET_PATTERN.test(text)) {
      throw new Error(`provider or secret material is forbidden at ${location}`);
    }
    if (ABSOLUTE_WINDOWS_PATH_PATTERN.test(text)) {
      throw new Error(`absolute Windows path is forbidden at ${location}`);
    }
    const lowered = text.toLowerCase();
    for (const candidate of forbidden) {
      if (lowered.includes(candidate.toLowerCase())) {
        throw new Error(`forbidden host/profile substring is present at ${location}`);
      }
    }
  });
  parseCanonicalJsonBytes(canonicalJsonBytes(receipt));
}

export function toMsysPath(input) {
  const match = /^([A-Za-z]):[\\/](.*)$/u.exec(input);
  if (!match) throw new Error("MSYS conversion requires an absolute drive path");
  return `/${match[1].toLowerCase()}/${match[2].replaceAll("\\", "/")}`;
}

function normalizedSlash(input) {
  return input.replaceAll("\\", "/").replace(/\/+$/u, "");
}

export function createLogicalizer(rootBindings) {
  const bindings = Object.entries(rootBindings)
    .filter(([, root]) => typeof root === "string" && root.length > 0)
    .flatMap(([logical, root]) => {
      const windows = normalizedSlash(path.resolve(root));
      const driveMatch = /^([A-Za-z]):\/(.*)$/u.exec(windows);
      const msys = driveMatch ? `/${driveMatch[1].toLowerCase()}/${driveMatch[2]}` : null;
      return [
        { logical, root: windows },
        ...(msys ? [{ logical, root: msys }] : []),
      ];
    })
    .sort((left, right) => right.root.length - left.root.length);
  return (input) => {
    let rendered = String(input).replaceAll("\\", "/");
    for (const binding of bindings) {
      const lowered = rendered.toLowerCase();
      const rootLowered = binding.root.toLowerCase();
      let searchFrom = 0;
      while (true) {
        const index = lowered.indexOf(rootLowered, searchFrom);
        if (index < 0) break;
        const beforeOkay = index === 0 || /[=,:;\s]/u.test(rendered[index - 1]);
        const afterIndex = index + binding.root.length;
        const afterOkay = afterIndex === rendered.length || rendered[afterIndex] === "/";
        if (beforeOkay && afterOkay) {
          rendered = `${rendered.slice(0, index)}${binding.logical}${rendered.slice(afterIndex)}`;
          break;
        }
        searchFrom = index + 1;
      }
    }
    return rendered;
  };
}

export function buildClosedEnvironment({ kind, runRoot, systemRoot, nodeRoot, gitRoot, privateGitRoot, gitExecPath }) {
  const system32 = path.join(systemRoot, "System32");
  const home = path.join(runRoot, "home");
  const temp = path.join(runRoot, "temp");
  const env = {
    APPDATA: path.join(home, "AppData", "Roaming"),
    COMSPEC: path.join(system32, "cmd.exe"),
    FORCE_COLOR: "0",
    HOME: home,
    LOCALAPPDATA: path.join(home, "AppData", "Local"),
    NO_COLOR: "1",
    PATH: [nodeRoot, path.join(gitRoot, "cmd"), path.join(gitRoot, "usr", "bin"), system32].join(path.delimiter),
    PATHEXT: ".COM;.EXE;.BAT;.CMD",
    SYSTEMROOT: systemRoot,
    TEMP: temp,
    TMP: temp,
    USERPROFILE: home,
    WINDIR: systemRoot,
    XDG_CONFIG_HOME: path.join(home, ".config"),
  };
  if (kind === "git" || kind === "gpg") {
    Object.assign(env, {
      GCM_INTERACTIVE: "Never",
      GIT_CONFIG_GLOBAL: "NUL",
      GIT_CONFIG_NOSYSTEM: "1",
      GIT_CONFIG_SYSTEM: "NUL",
      GIT_NO_REPLACE_OBJECTS: "1",
      GIT_OPTIONAL_LOCKS: "0",
      GIT_TERMINAL_PROMPT: "0",
    });
  }
  if (kind === "git") {
    if (typeof privateGitRoot !== "string" || typeof gitExecPath !== "string") {
      throw new Error("closed Git environment requires its private executable and empty exec-path roots");
    }
    Object.assign(env, {
      GIT_ATTR_NOSYSTEM: "1",
      GIT_EXEC_PATH: gitExecPath,
      GIT_TRACE2_EVENT: "1",
      LANG: "C",
      LC_ALL: "C",
      PATH: [privateGitRoot, system32].join(path.delimiter),
    });
  }
  if (kind === "pnpm") {
    const blackhole = "http://127.0.0.1:9";
    Object.assign(env, {
      ALL_PROXY: blackhole,
      CI: "true",
      HTTP_PROXY: blackhole,
      HTTPS_PROXY: blackhole,
      NPM_CONFIG_CACHE: path.join(runRoot, "npm-cache"),
      NPM_CONFIG_REGISTRY: `${blackhole}/`,
      NPM_CONFIG_USERCONFIG: path.join(runRoot, "workspace", ".npmrc"),
      NO_PROXY: "",
      PNPM_DISABLE_SELF_UPDATE_CHECK: "1",
      all_proxy: blackhole,
      http_proxy: blackhole,
      https_proxy: blackhole,
      npm_config_cache: path.join(runRoot, "npm-cache"),
      npm_config_registry: `${blackhole}/`,
      npm_config_userconfig: path.join(runRoot, "workspace", ".npmrc"),
      no_proxy: "",
    });
  }
  return env;
}

export function buildGitCommandPlan({ gitExe, repoRoot, args, env }) {
  return {
    args: ["--no-pager", "--no-replace-objects", "--no-lazy-fetch", "-C", repoRoot, ...args],
    cwd: repoRoot,
    env,
    executable: gitExe,
    shell: false,
  };
}

export function buildPnpmCommandPlan({ nodeExe, pnpmCjs, workspaceRoot, storeParent, env }) {
  return {
    args: [
      pnpmCjs,
      "install",
      "--offline",
      "--frozen-lockfile",
      "--ignore-scripts",
      "--store-dir",
      storeParent,
      "--reporter=append-only",
      "--registry=http://127.0.0.1:9/",
      "--network-concurrency=1",
      "--fetch-retries=0",
    ],
    cwd: workspaceRoot,
    env,
    executable: nodeExe,
    shell: false,
  };
}

function requirePositiveBound(value, label) {
  if (!Number.isSafeInteger(value) || value < 1 || value > 60 * 60_000) {
    throw new Error(`${label} is not a safe positive millisecond bound`);
  }
}

async function runBoundedTaskkill(authority, ownedRootPid) {
  const maximumOutputBytes = 64 * 1024;
  const started = Date.now();
  return await new Promise((resolve) => {
    let completed = false;
    let stderrBytes = 0;
    let stdoutBytes = 0;
    const stderr = [];
    const stdout = [];
    const finish = (receipt) => {
      if (completed) return;
      completed = true;
      clearTimeout(timer);
      resolve({
        durationMs: Date.now() - started,
        stderr: { bytes: stderrBytes, sha256: sha256(Buffer.concat(stderr)) },
        stdout: { bytes: stdoutBytes, sha256: sha256(Buffer.concat(stdout)) },
        ...receipt,
      });
    };
    const child = spawn(authority.executable, ["/PID", String(ownedRootPid), "/T", "/F"], {
      cwd: authority.cwd,
      env: authority.env,
      shell: false,
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    });
    const capture = (target, currentBytes, chunk, streamName) => {
      if (currentBytes + chunk.length > maximumOutputBytes) {
        child.kill("SIGKILL");
        child.stdout.destroy();
        child.stderr.destroy();
        child.unref();
        finish({
          completionObserved: false,
          errorCode: `termination-tool-${streamName}-overflow`,
          exitCode: null,
          signal: null,
          timedOut: false,
        });
        return currentBytes;
      }
      target.push(chunk);
      return currentBytes + chunk.length;
    };
    child.stdout.on("data", (chunk) => { stdoutBytes = capture(stdout, stdoutBytes, chunk, "stdout"); });
    child.stderr.on("data", (chunk) => { stderrBytes = capture(stderr, stderrBytes, chunk, "stderr"); });
    child.once("error", (error) => finish({
      completionObserved: false,
      errorCode: typeof error.code === "string" ? `termination-tool-${error.code}` : "termination-tool-spawn-error",
      exitCode: null,
      signal: null,
      timedOut: false,
    }));
    child.once("close", (exitCode, signal) => finish({
      completionObserved: true,
      errorCode: null,
      exitCode,
      signal: signal ?? null,
      timedOut: false,
    }));
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      child.stdout.destroy();
      child.stderr.destroy();
      child.unref();
      finish({
        completionObserved: false,
        errorCode: "termination-tool-timeout",
        exitCode: null,
        signal: null,
        timedOut: true,
      });
    }, authority.terminationToolTimeoutMs);
  });
}

export async function runCommand(
  plan,
  {
    maxOutputBytes = 4 * 1024 * 1024,
    ownedRootExitTimeoutMs = 15_000,
    terminationAuthority,
    terminationToolTimeoutMs = 15_000,
    timeoutMs = 120_000,
  } = {},
) {
  if (plan.shell !== false) throw new Error("all pre-seal commands require shell:false");
  if (!terminationAuthority || terminationAuthority.policyId !== "taskkill-tree-force-v1") {
    throw new Error("pre-seal command requires the exact taskkill tree-termination authority");
  }
  requirePositiveBound(timeoutMs, "command timeout");
  requirePositiveBound(terminationToolTimeoutMs, "termination tool timeout");
  requirePositiveBound(ownedRootExitTimeoutMs, "owned root exit timeout");
  if (!Number.isSafeInteger(maxOutputBytes) || maxOutputBytes < 1 || maxOutputBytes > 128 * 1024 * 1024) {
    throw new Error("pre-seal command output bound is invalid");
  }
  const stdin = plan.stdin === undefined ? null : Buffer.from(plan.stdin);
  if (stdin !== null && stdin.length > 16 * 1024 * 1024) throw new Error("pre-seal command stdin exceeded its bound");
  const started = Date.now();
  return await new Promise((resolve, reject) => {
    const child = spawn(plan.executable, plan.args, {
      cwd: plan.cwd,
      env: plan.env,
      shell: false,
      stdio: [stdin === null ? "ignore" : "pipe", "pipe", "pipe"],
      windowsHide: true,
    });
    const stdout = [];
    const stderr = [];
    let stdoutBytes = 0;
    let stderrBytes = 0;
    let overflow = false;
    let timedOut = false;
    let closeFact;
    let closeFactResolve;
    let finished = false;
    let terminationPromise;
    const closeFactPromise = new Promise((closeResolve) => { closeFactResolve = closeResolve; });
    const finishResolve = (value) => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      resolve(value);
    };
    const finishReject = (error) => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      reject(error);
    };
    const baseResult = () => ({
      commandTimeoutMs: timeoutMs,
      durationMs: Date.now() - started,
      exitCode: closeFact?.exitCode ?? null,
      overflow,
      ownedRootExitObserved: closeFact !== undefined,
      ownedRootExitTimeoutMs,
      signal: closeFact?.signal ?? null,
      stderr: Buffer.concat(stderr),
      stdout: Buffer.concat(stdout),
      terminationPolicyId: terminationAuthority.policyId,
      terminationToolId: terminationAuthority.executableId,
      terminationToolTimeoutMs,
      timedOut,
    });
    const abandonUncertainRoot = () => {
      child.kill("SIGKILL");
      child.stdout.destroy();
      child.stderr.destroy();
      child.unref();
    };
    const requestTermination = (reason) => {
      if (terminationPromise !== undefined) return terminationPromise;
      clearTimeout(timer);
      terminationPromise = (async () => {
        if (!Number.isSafeInteger(child.pid) || child.pid < 1) {
          finishReject(new Error("owned command root PID was unavailable for bounded cleanup"));
          return;
        }
        const tool = await runBoundedTaskkill({
          ...terminationAuthority,
          terminationToolTimeoutMs,
        }, child.pid);
        if (!tool.completionObserved || tool.timedOut || tool.exitCode !== 0 || tool.signal !== null) {
          abandonUncertainRoot();
          const code = tool.errorCode ?? "termination-tool-nonzero-or-signaled";
          finishReject(new Error(`pre-seal cleanup was inconclusive: ${code}`));
          return;
        }
        let ownedClose = closeFact;
        if (ownedClose === undefined) {
          ownedClose = await Promise.race([
            closeFactPromise,
            new Promise((settle) => setTimeout(() => settle(null), ownedRootExitTimeoutMs)),
          ]);
        }
        if (ownedClose === null || ownedClose === undefined) {
          abandonUncertainRoot();
          finishReject(new Error("pre-seal cleanup was inconclusive: owned-root-close-timeout"));
          return;
        }
        finishResolve({
          ...baseResult(),
          cleanupErrorCode: null,
          cleanupOutcome: "proven",
          ownedRootExitObserved: true,
          terminationReason: reason,
          terminationRequested: true,
          terminationToolCompletionObserved: true,
          terminationToolExitCode: tool.exitCode,
          terminationToolReceipt: {
            argvPolicy: "/PID <owned-root-pid> /T /F",
            durationMs: tool.durationMs,
            stderr: tool.stderr,
            stdout: tool.stdout,
          },
          terminationToolSignal: tool.signal,
        });
      })();
      return terminationPromise;
    };
    const capture = (target, counter, chunk, reason) => {
      const next = counter.value + chunk.length;
      if (next > maxOutputBytes) {
        overflow = true;
        void requestTermination(reason);
        return;
      }
      counter.value = next;
      target.push(chunk);
    };
    const stdoutCounter = { get value() { return stdoutBytes; }, set value(v) { stdoutBytes = v; } };
    const stderrCounter = { get value() { return stderrBytes; }, set value(v) { stderrBytes = v; } };
    child.stdout.on("data", (chunk) => capture(stdout, stdoutCounter, chunk, "stdout-overflow"));
    child.stderr.on("data", (chunk) => capture(stderr, stderrCounter, chunk, "stderr-overflow"));
    const timer = setTimeout(() => {
      timedOut = true;
      void requestTermination("timeout");
    }, timeoutMs);
    child.once("error", (error) => {
      if (terminationPromise === undefined) finishReject(error);
    });
    child.once("close", (exitCode, signal) => {
      closeFact = { exitCode, signal: signal ?? null };
      closeFactResolve(closeFact);
      if (terminationPromise === undefined) {
        finishResolve({
          ...baseResult(),
          cleanupErrorCode: null,
          cleanupOutcome: "not-required",
          terminationReason: null,
          terminationRequested: false,
          terminationToolCompletionObserved: false,
          terminationToolExitCode: null,
          terminationToolReceipt: null,
          terminationToolSignal: null,
        });
      }
    });
    if (stdin !== null) {
      child.stdin.on("error", () => {
        // The authoritative close/error result handles a failed bounded write.
      });
      child.stdin.end(stdin);
    }
  });
}

export function commandReceipt(plan, result, { executableId, logicalize }) {
  return {
    argv: plan.args.map((entry) => logicalize(entry)),
    cleanupErrorCode: result.cleanupErrorCode,
    cleanupOutcome: result.cleanupOutcome,
    commandTimeoutMs: result.commandTimeoutMs,
    cwd: logicalize(plan.cwd),
    durationMs: result.durationMs,
    envProjectionNames: Object.keys(plan.env).sort(compareOrdinal),
    executableId,
    exitCode: result.exitCode,
    overflow: result.overflow,
    ownedRootExitObserved: result.ownedRootExitObserved,
    ownedRootExitTimeoutMs: result.ownedRootExitTimeoutMs,
    shell: false,
    signal: result.signal,
    ...(plan.stdin === undefined ? {} : { stdin: { bytes: Buffer.byteLength(plan.stdin), sha256: sha256(plan.stdin) } }),
    stderr: { bytes: result.stderr.length, sha256: sha256(result.stderr) },
    stdout: { bytes: result.stdout.length, sha256: sha256(result.stdout) },
    timedOut: result.timedOut,
    terminationPolicyId: result.terminationPolicyId,
    terminationReason: result.terminationReason,
    terminationRequested: result.terminationRequested,
    terminationToolCompletionObserved: result.terminationToolCompletionObserved,
    terminationToolExitCode: result.terminationToolExitCode,
    terminationToolId: result.terminationToolId,
    ...(result.terminationToolReceipt === null ? {} : { terminationToolReceipt: result.terminationToolReceipt }),
    terminationToolSignal: result.terminationToolSignal,
    terminationToolTimeoutMs: result.terminationToolTimeoutMs,
  };
}

export function parseGpgStatus(bytes) {
  const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  const statusLines = text
    .split(/\r?\n/u)
    .filter((line) => line.startsWith("[GNUPG:] "))
    .map((line) => line.slice(9).split(" "));
  const valid = statusLines.filter(([kind]) => kind === "VALIDSIG");
  if (valid.length !== 1) throw new Error(`expected exactly one VALIDSIG, observed ${valid.length}`);
  const fields = valid[0];
  if (fields.length < 10) throw new Error("malformed VALIDSIG status");
  return {
    fingerprint: fields[1],
    primaryFingerprint: fields[10] || fields[1],
    signatureDate: fields[2],
    signatureEpoch: Number.parseInt(fields[3], 10),
    publicKeyAlgorithmId: Number.parseInt(fields[7], 10),
    digestAlgorithmId: Number.parseInt(fields[8], 10),
  };
}

export function parseGpgFingerprints(bytes) {
  const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  return text
    .split(/\r?\n/u)
    .filter((line) => line.startsWith("fpr:"))
    .map((line) => line.split(":")[9])
    .filter(Boolean);
}

export function parsePnpmProgress(bytes) {
  const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  const matches = [...text.matchAll(/Progress:\s+resolved\s+(\d+),\s+reused\s+(\d+),\s+downloaded\s+(\d+),\s+added\s+(\d+)/gu)];
  if (matches.length === 0) throw new Error("pnpm progress summary was not present");
  const last = matches.at(-1);
  return {
    added: Number.parseInt(last[4], 10),
    downloaded: Number.parseInt(last[3], 10),
    resolved: Number.parseInt(last[1], 10),
    reused: Number.parseInt(last[2], 10),
  };
}

function assertPortableLogicalPath(value, label) {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.includes("\\") ||
    value.includes("\u0000") ||
    path.posix.isAbsolute(value) ||
    value.split("/").some((part) => part === "" || part === "." || part === ".." || part.includes(":"))
  ) {
    throw new Error(`${label} is not a portable logical path`);
  }
}

export function parseFilesystemAuditReceipt(bytes, plan) {
  const input = Buffer.from(bytes);
  if (input.length === 0 || input.length > 128 * 1024 * 1024) throw new Error("filesystem audit receipt exceeded its bound");
  let text = new TextDecoder("utf-8", { fatal: true }).decode(input);
  if (text.endsWith("\r\n")) text = text.slice(0, -2);
  else if (text.endsWith("\n")) text = text.slice(0, -1);
  if (text.includes("\r") || text.includes("\n")) throw new Error("filesystem audit receipt was not one JSON line");
  const receipt = JSON.parse(text);
  if (receipt?.ok === false) {
    if (receipt.schemaVersion !== AUDIT_RECEIPT_SCHEMA || typeof receipt.code !== "string") {
      throw new Error("filesystem audit returned a malformed failure");
    }
    throw new Error(`filesystem audit rejected input: ${receipt.code}`);
  }
  const keys = Object.keys(receipt ?? {}).sort(compareOrdinal);
  if (keys.join("\u0000") !== ["fileCount", "ok", "schemaVersion", "sources"].join("\u0000")) {
    throw new Error("filesystem audit receipt shape mismatch");
  }
  if (receipt.ok !== true || receipt.schemaVersion !== AUDIT_RECEIPT_SCHEMA || !Array.isArray(receipt.sources)) {
    throw new Error("filesystem audit receipt status mismatch");
  }
  if (!Array.isArray(plan.sources) || receipt.sources.length !== plan.sources.length) {
    throw new Error("filesystem audit source count mismatch");
  }
  let fileCount = 0;
  for (let sourceIndex = 0; sourceIndex < receipt.sources.length; sourceIndex += 1) {
    const source = receipt.sources[sourceIndex];
    const expected = plan.sources[sourceIndex];
    if (
      source.sourceId !== expected.sourceId ||
      source.sourceIndex !== expected.sourceIndex ||
      source.surfaceId !== expected.surfaceId ||
      !Array.isArray(source.files) ||
      (source.files.length === 0 && expected.mode !== "empty-tree")
    ) {
      throw new Error("filesystem audit source binding mismatch");
    }
    const sourceKeys = Object.keys(source).sort(compareOrdinal);
    if (sourceKeys.join("\u0000") !== ["files", "sourceId", "sourceIndex", "surfaceId"].join("\u0000")) {
      throw new Error("filesystem audit source shape mismatch");
    }
    let previous;
    for (const tuple of source.files) {
      if (
        !Array.isArray(tuple) ||
        tuple.length !== 3 ||
        !Number.isSafeInteger(tuple[1]) ||
        tuple[1] < 0 ||
        typeof tuple[2] !== "string" ||
        !SHA256_PATTERN.test(tuple[2])
      ) {
        throw new Error("filesystem audit tuple shape mismatch");
      }
      assertPortableLogicalPath(tuple[0], "filesystem audit tuple");
      if (previous !== undefined && compareOrdinal(previous, tuple[0]) >= 0) {
        throw new Error("filesystem audit tuples were not strictly ordinal");
      }
      previous = tuple[0];
    }
    fileCount += source.files.length;
  }
  if (!Number.isSafeInteger(receipt.fileCount) || receipt.fileCount !== fileCount || fileCount > 200_000) {
    throw new Error("filesystem audit file count mismatch");
  }
  return receipt;
}

export function summarizeFilesystemAudit(receipt) {
  const tuples = receipt.sources.flatMap((source) => source.files).sort((left, right) => compareOrdinal(left[0], right[0]));
  for (let index = 1; index < tuples.length; index += 1) {
    if (tuples[index - 1][0] === tuples[index][0]) throw new Error("filesystem audit repeated a logical path");
  }
  return {
    byteLength: tuples.reduce((total, tuple) => total + tuple[1], 0),
    fileCount: tuples.length,
    surfaceSha256: sha256(canonicalJsonBytes(tuples)),
    tuples,
  };
}

export async function verifyFile(filePath, expected, { requireSingleLink = true } = {}) {
  const linkStat = await fs.lstat(filePath);
  if (!linkStat.isFile() || linkStat.isSymbolicLink() || linkStat.nlink < 1 || (requireSingleLink && linkStat.nlink !== 1)) {
    throw new Error(requireSingleLink
      ? "sealed input must be a regular, non-reparse, single-link file"
      : "sealed system input must be a regular, non-reparse file");
  }
  const handle = await fs.open(filePath, "r");
  let identity;
  let observed;
  try {
    const before = await handle.stat({ bigint: true });
    if (!before.isFile() || before.size > BigInt(Number.MAX_SAFE_INTEGER)) {
      throw new Error("sealed input is not a safely measurable regular file");
    }
    const hashPass = async () => {
      const digest = createHash("sha256");
      let streamedBytes = 0;
      for await (const chunk of handle.createReadStream({ autoClose: false, start: 0 })) {
        digest.update(chunk);
        streamedBytes += chunk.length;
      }
      return { bytes: streamedBytes, sha256: digest.digest("hex") };
    };
    const firstPass = await hashPass();
    const between = await handle.stat({ bigint: true });
    const secondPass = await hashPass();
    const after = await handle.stat({ bigint: true });
    if (
      before.dev !== after.dev ||
      before.ino !== after.ino ||
      before.size !== after.size ||
      before.mtimeNs !== after.mtimeNs ||
      before.nlink !== after.nlink ||
      before.dev !== between.dev ||
      before.ino !== between.ino ||
      before.size !== between.size ||
      before.mtimeNs !== between.mtimeNs ||
      before.nlink !== between.nlink ||
      before.nlink !== BigInt(linkStat.nlink) ||
      (requireSingleLink && before.nlink !== 1n)
    ) {
      throw new Error("sealed input changed while it was being hashed");
    }
    if (
      firstPass.bytes !== Number(before.size) ||
      secondPass.bytes !== Number(before.size) ||
      firstPass.bytes !== secondPass.bytes ||
      firstPass.sha256 !== secondPass.sha256
    ) {
      throw new Error("sealed input double-hash replay mismatch");
    }
    identity = {
      dev: before.dev.toString(),
      ino: before.ino.toString(),
      mtimeNs: before.mtimeNs.toString(),
      nlink: before.nlink.toString(),
      size: before.size.toString(),
    };
    observed = firstPass;
  } finally {
    await handle.close();
  }
  if (expected.bytes !== undefined && observed.bytes !== expected.bytes) {
    throw new Error(`file byte length mismatch for ${expected.logicalPath ?? "sealed input"}`);
  }
  if (expected.sha256 !== undefined && observed.sha256 !== expected.sha256) {
    throw new Error(`file SHA-256 mismatch for ${expected.logicalPath ?? "sealed input"}`);
  }
  return { identity, observed };
}

export async function snapshotTreeMetadata(root) {
  const records = [];
  async function walk(directory, prefix) {
    const entries = await fs.readdir(directory, { withFileTypes: true });
    entries.sort((left, right) => compareOrdinal(left.name, right.name));
    for (const entry of entries) {
      const absolute = path.join(directory, entry.name);
      const relative = prefix ? `${prefix}/${entry.name}` : entry.name;
      if (entry.isDirectory()) {
        await walk(absolute, relative);
      } else if (entry.isFile()) {
        const stat = await fs.stat(absolute);
        records.push([relative, stat.size]);
      } else {
        throw new Error("sealed store contains a non-file, non-directory entry");
      }
    }
  }
  await walk(root, "");
  const digest = createHash("sha256");
  let totalBytes = 0;
  for (const [relative, bytes] of records) {
    digest.update(relative, "utf8");
    digest.update("\u0000");
    digest.update(String(bytes), "ascii");
    digest.update("\n");
    totalBytes += bytes;
  }
  return { files: records.length, pathSizeSha256: digest.digest("hex"), totalBytes };
}

export async function countImmediateDirectories(root) {
  const entries = await fs.readdir(root, { withFileTypes: true });
  return entries.filter((entry) => entry.isDirectory()).length;
}

export async function atomicWriteVerified(finalPath, temporaryPath, bytes, maximumBytes) {
  const payload = Buffer.from(bytes);
  if (!Number.isSafeInteger(maximumBytes) || maximumBytes < 1 || payload.length === 0 || payload.length > maximumBytes) {
    throw new Error("atomic payload exceeded its fixed byte bound");
  }
  if (path.dirname(path.resolve(finalPath)).toLowerCase() !== path.dirname(path.resolve(temporaryPath)).toLowerCase()) {
    throw new Error("atomic temporary and final paths must share one directory");
  }
  let handle;
  try {
    handle = await fs.open(temporaryPath, "wx");
    await handle.writeFile(payload);
    await handle.sync();
    await handle.close();
    handle = undefined;
    await verifyFile(temporaryPath, { bytes: payload.length, sha256: sha256(payload) });
    await fs.link(temporaryPath, finalPath);
    await fs.unlink(temporaryPath);
    const postwrite = await verifyFile(finalPath, { bytes: payload.length, sha256: sha256(payload) });
    return postwrite.observed;
  } catch (error) {
    if (handle !== undefined) await handle.close().catch(() => {});
    await fs.rm(temporaryPath, { force: true }).catch(() => {});
    throw error;
  }
}

export function cacheKeyToPath(cacheRoot, cacheKey) {
  if (!cacheKey.startsWith("cache/")) throw new Error("cache key must begin with cache/");
  return path.join(cacheRoot, ...cacheKey.slice(6).split("/"));
}

export function surfaceRoot(cacheRoot, config, surfaceId) {
  const surface = config.surfaces.find((entry) => entry.surfaceId === surfaceId);
  if (!surface || surface.sources.length !== 1 || surface.sources[0].location !== "cache") {
    throw new Error(`surface ${surfaceId} does not have one cache source`);
  }
  return path.join(cacheRoot, ...surface.sources[0].relativeRoot.split("/"));
}
