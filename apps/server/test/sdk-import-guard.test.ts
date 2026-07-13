// Guard provider-native package and vocabulary ownership. Claude SDK imports
// remain in its adapter; the CLI-only Codex package may be resolved only by the
// adapter-local, direct attached native-executable boundary. Core/browser code
// hangs off provider-neutral contracts and production remains Claude-only until
// Codex conformance and descendant containment are complete.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, extname, isAbsolute, join, relative, sep } from 'node:path';

const SRC = join(dirname(fileURLToPath(import.meta.url)), '..', 'src');
const REPO = join(SRC, '..', '..', '..');
const SOURCE_EXTENSIONS = new Set([
  '.ts',
  '.tsx',
  '.mts',
  '.cts',
  '.js',
  '.jsx',
  '.mjs',
  '.cjs',
]);
const PRODUCTION_ROOTS = [
  ...sourceRoots(join(REPO, 'apps')),
  ...sourceRoots(join(REPO, 'packages')),
];
const CODEX_SPIKE_SCRIPT = join(REPO, 'apps', 'server', 'scripts', 'codex-spike.ts');
const PRODUCTION_FILES = [
  ...PRODUCTION_ROOTS.flatMap((root) => walk(root)),
  CODEX_SPIKE_SCRIPT,
].sort();
const CODEX_SOURCE_ROOT = join(SRC, 'runner', 'codex');
const CODEX_PRODUCTION_FILES = [...walk(CODEX_SOURCE_ROOT), CODEX_SPIKE_SCRIPT].sort();
const CODEX_SCHEMA_METHOD_FILES = [
  join(CODEX_SOURCE_ROOT, 'generated', 'ClientRequest.ts'),
  join(CODEX_SOURCE_ROOT, 'generated', 'ClientNotification.ts'),
  join(CODEX_SOURCE_ROOT, 'generated', 'ServerRequest.ts'),
  join(CODEX_SOURCE_ROOT, 'generated', 'ServerNotification.ts'),
];
// Match the module-specifier in an import/require (handles multi-line imports
// where `from '…'` sits on its own line); a bare comment mention won't match.
const SDK_IMPORT = /(?:from|require\(\s*)\s*['"]@anthropic-ai\/claude-agent-sdk['"]/;
const CODEX_PACKAGE_REFERENCE = /['"`]@openai\/codex(?:-[A-Za-z0-9._-]+)?(?:\/[^'"`]*)?['"`]/;
const CODEX_METHOD_LITERAL = /"method":\s*"([^"]+)"/g;
const SHARED_PROTOCOL_METHODS = new Set(['initialize', 'initialized', 'warning', 'error']);

function sourceRoots(parent: string): string[] {
  return readdirSync(parent)
    .map((name) => join(parent, name, 'src'))
    .filter(existsSync);
}

function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) walk(full, out);
    else if (SOURCE_EXTENSIONS.has(extname(full))) out.push(full);
  }
  return out;
}

function repoPath(path: string): string {
  return relative(REPO, path).replace(/\\/g, '/');
}

function isWithin(root: string, path: string): boolean {
  const child = relative(root, path);
  return child === '' || (
    child !== '..' &&
    !child.startsWith(`..${sep}`) &&
    !isAbsolute(child)
  );
}

function codexNativeMethods(): string[] {
  const methods = new Set<string>();
  for (const file of CODEX_SCHEMA_METHOD_FILES) {
    const source = readFileSync(file, 'utf8');
    for (const match of source.matchAll(CODEX_METHOD_LITERAL)) {
      const method = match[1];
      if (method && !SHARED_PROTOCOL_METHODS.has(method)) methods.add(method);
    }
  }
  return [...methods].sort();
}

test('only runner/claude-adapter.ts imports the Claude Agent SDK', () => {
  const importers: string[] = [];
  for (const file of walk(SRC)) {
    if (SDK_IMPORT.test(readFileSync(file, 'utf8'))) {
      importers.push(relative(SRC, file).replace(/\\/g, '/'));
    }
  }
  assert.deepEqual(
    importers,
    ['runner/claude-adapter.ts'],
    `unexpected SDK importers: ${importers.join(', ')}`,
  );
});

test('only runner/codex/executable.ts resolves the repository-pinned Codex package', () => {
  for (const reference of [
    "'@openai/codex'",
    "'@openai/codex/package.json'",
    "'@openai/codex-win32-x64'",
    "'@openai/codex-linux-arm64/vendor/codex'",
    '`@openai/codex/bin/codex.js`',
  ]) assert.match(reference, CODEX_PACKAGE_REFERENCE);

  const owners: string[] = [];
  for (const file of PRODUCTION_FILES) {
    if (CODEX_PACKAGE_REFERENCE.test(readFileSync(file, 'utf8'))) {
      owners.push(repoPath(file));
    }
  }
  assert.deepEqual(
    owners,
    ['apps/server/src/runner/codex/executable.ts'],
    `unexpected Codex package owners: ${owners.join(', ')}`,
  );

  const composition = readFileSync(join(SRC, 'index.ts'), 'utf8');
  assert.doesNotMatch(
    composition,
    /\bCodexRuntimeAdapter\b|['"][^'"]*runner\/codex[^'"]*['"]|['"]openai-codex['"]/,
    'CX-001 must not register or compose a partial Codex adapter',
  );

  const executable = readFileSync(join(CODEX_SOURCE_ROOT, 'executable.ts'), 'utf8');
  assert.match(executable, /command:\s*realpathSync\(command\)/);
  assert.match(executable, /argsPrefix:\s*EMPTY_ARGS_PREFIX/);
  assert.doesNotMatch(
    executable,
    /bin[\\/]codex\.js|process\.env(?:\.PATH|\[['"]PATH['"]\])/i,
  );
});

test('Codex spike is confined to a direct attached native-child lifecycle', () => {
  const client = readFileSync(join(CODEX_SOURCE_ROOT, 'app-server-client.ts'), 'utf8');
  assert.match(client, /shell:\s*false/);
  assert.match(client, /detached:\s*false/);
  assert.match(client, /this\.child\.kill\(signal\)/);

  const codexSource = CODEX_PRODUCTION_FILES
    .map((file) => readFileSync(file, 'utf8'))
    .join('\n');
  assert.doesNotMatch(
    codexSource,
    /process[-_ ]?tree|treeAbsence|taskkill|process\.kill\s*\(\s*-/i,
    'CX-001 may control only its exact directly spawned native child',
  );
});

test('Codex native method vocabulary stays inside runner/codex', () => {
  const methods = codexNativeMethods();
  for (const expected of [
    'account/read',
    'config/read',
    'model/list',
    'remoteControl/status/changed',
    'thread/start',
    'turn/start',
  ]) assert.ok(methods.includes(expected), `generated schema is missing ${expected}`);

  const offenders: string[] = [];
  for (const file of PRODUCTION_FILES) {
    if (isWithin(CODEX_SOURCE_ROOT, file)) continue;
    const source = readFileSync(file, 'utf8');
    const matches = methods.filter((method) => source.includes(method));
    if (matches.length > 0) offenders.push(`${repoPath(file)} (${matches.join(', ')})`);
  }
  assert.deepEqual(
    offenders,
    [],
    `Codex-native method vocabulary leaked into production: ${offenders.join('; ')}`,
  );
});

test('specialist dispatch contains no concrete provider or model selection', () => {
  const dispatch = readFileSync(join(SRC, 'dispatch', 'service.ts'), 'utf8');
  assert.doesNotMatch(
    dispatch,
    /\b(?:CLAUDE_RUNTIME_ID|ClaudeRuntimeAdapter)\b|(?:from|require\(\s*)\s*['"][^'"]*claude-adapter[^'"]*['"]|['"](?:sonnet|opus|haiku)['"]/,
  );
});

test('canonical contracts and browser contain no provider-native or retired raw-tool vocabulary', () => {
  const forbidden = /\b(?:sdkUuid|sdkSessionId|chat-delta|thinking-delta|ThinkingBubble|end_turn|toolUseId|toolUseID|tool_use_id|tool-input-delta|input_json_delta|partial_json)\b|(?:kind|case)\s*:?\s*['"](?:thinking|tool-call|tool-result|tool-denied)['"]|\b(?:thread\/(?:start|resume)|turn\/(?:start|interrupt)|account\/read|model\/list|remoteControl\/status\/changed)\b/;
  const offenders: string[] = [];
  for (const root of [join(REPO, 'packages', 'contracts', 'src'), join(REPO, 'apps', 'web', 'src')]) {
    for (const file of walk(root)) {
      if (forbidden.test(readFileSync(file, 'utf8'))) offenders.push(relative(REPO, file).replace(/\\/g, '/'));
    }
  }
  assert.deepEqual(offenders, [], `provider-native chat vocabulary leaked into: ${offenders.join(', ')}`);
});

test('public specialist and app-tool seams contain no native or attempt identity fields', () => {
  const forbidden = /\bccSessionId\b|\bagentSessionId\b|\bnativeSessionId(?!Present)\b|\bcontinuationAttemptId\b/;
  const roots = [
    join(REPO, 'apps', 'web', 'src'),
    join(REPO, 'packages', 'contracts', 'src', 'agent-runs.ts'),
    join(REPO, 'packages', 'contracts', 'src', 'pending-asks.ts'),
    join(REPO, 'packages', 'mcp', 'src', 'tools', 'context.ts'),
    join(REPO, 'packages', 'mcp', 'src', 'http-endpoint.ts'),
    join(REPO, 'apps', 'server', 'src', 'dispatch', 'pc-bridge.ts'),
  ];
  const offenders: string[] = [];
  for (const root of roots) {
    const files = statSync(root).isDirectory() ? walk(root) : [root];
    for (const file of files) {
      if (forbidden.test(readFileSync(file, 'utf8'))) {
        offenders.push(relative(REPO, file).replace(/\\/g, '/'));
      }
    }
  }
  assert.deepEqual(offenders, [], `native specialist identity leaked into: ${offenders.join(', ')}`);
});
