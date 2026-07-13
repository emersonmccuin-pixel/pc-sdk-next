// Guard provider-native package and vocabulary ownership. Claude SDK imports
// remain in its adapter; the CLI-only Codex package may be resolved only by the
// adapter-local boundary. CX-002 adds provider-free Codex mapping behind an
// injected peer, while the direct native executable remains admission-only.
// Core/browser code hangs off provider-neutral contracts and production remains
// Claude-only until native policy, conformance, and containment gates complete.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, extname, isAbsolute, join, relative, resolve, sep } from 'node:path';

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
const CODEX_RUNTIME_SURFACE = [
  join(CODEX_SOURCE_ROOT, 'adapter.ts'),
  join(CODEX_SOURCE_ROOT, 'runtime-mapping.ts'),
  join(CODEX_SOURCE_ROOT, 'runtime-peer.ts'),
  join(CODEX_SOURCE_ROOT, 'runtime-session.ts'),
];
const CODEX_NATIVE_ROOTS = new Set([
  join(CODEX_SOURCE_ROOT, 'app-server-client.ts'),
  join(CODEX_SOURCE_ROOT, 'environment.ts'),
  join(CODEX_SOURCE_ROOT, 'executable.ts'),
  join(CODEX_SOURCE_ROOT, 'protocol.ts'),
  join(CODEX_SOURCE_ROOT, 'spike.ts'),
  CODEX_SPIKE_SCRIPT,
]);
const CODEX_RUNTIME_PROCESS_MODULE_ROOTS = new Set([
  'child_process',
  'cluster',
  'cross-spawn',
  'execa',
  'node-pty',
  'shelljs',
  'worker_threads',
]);
const CODEX_RUNTIME_TRANSPORT_MODULE_ROOTS = new Set([
  '@grpc/grpc-js',
  'axios',
  'cross-fetch',
  'dgram',
  'dns',
  'engine.io',
  'engine.io-client',
  'got',
  'http',
  'http2',
  'https',
  'isomorphic-ws',
  'ky',
  'net',
  'node-fetch',
  'socket.io',
  'socket.io-client',
  'superagent',
  'tls',
  'undici',
  'websocket',
  'ws',
]);
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

function moduleSpecifiers(source: string): string[] {
  const specifiers = new Set<string>();
  for (const pattern of [
    /\b(?:from|import\s*\(|require\s*\()\s*['"]([^'"]+)['"]/g,
    /\bimport\s*['"]([^'"]+)['"]/g,
  ]) {
    for (const match of source.matchAll(pattern)) {
      if (match[1]) specifiers.add(match[1]);
    }
  }
  return [...specifiers];
}

type ForbiddenExternalModuleKind = 'process' | 'alternate-transport';

interface ForbiddenExternalDependency {
  classification: ForbiddenExternalModuleKind;
  path: string[];
  specifier: string;
}

function externalModuleRoot(specifier: string): string {
  const normalized = specifier.startsWith('node:') ? specifier.slice('node:'.length) : specifier;
  const segments = normalized.split('/');
  return normalized.startsWith('@')
    ? segments.slice(0, 2).join('/')
    : segments[0]!;
}

function classifyForbiddenRuntimeExternalModule(
  specifier: string,
): ForbiddenExternalModuleKind | null {
  const root = externalModuleRoot(specifier);
  if (CODEX_RUNTIME_PROCESS_MODULE_ROOTS.has(root)) return 'process';
  if (CODEX_RUNTIME_TRANSPORT_MODULE_ROOTS.has(root)) return 'alternate-transport';
  return null;
}

function resolveLocalModule(importer: string, specifier: string): string | null {
  if (!specifier.startsWith('.')) return null;
  const base = resolve(dirname(importer), specifier);
  const candidates = extname(base)
    ? [base]
    : [
        ...[...SOURCE_EXTENSIONS].map((extension) => `${base}${extension}`),
        ...[...SOURCE_EXTENSIONS].map((extension) => join(base, `index${extension}`)),
      ];
  return candidates.find((candidate) => existsSync(candidate) && !statSync(candidate).isDirectory()) ?? null;
}

function productionDependencyGraph(): Map<string, string[]> {
  const graph = new Map<string, string[]>();
  const pending = [...PRODUCTION_FILES];
  const seen = new Set<string>();
  while (pending.length > 0) {
    const file = pending.pop()!;
    if (seen.has(file)) continue;
    seen.add(file);
    const dependencies = moduleSpecifiers(readFileSync(file, 'utf8'))
      .map((specifier) => resolveLocalModule(file, specifier))
      .filter((dependency): dependency is string => dependency !== null);
    graph.set(file, dependencies);
    for (const dependency of dependencies) {
      if (!seen.has(dependency)) pending.push(dependency);
    }
  }
  return graph;
}

function dependencyPath(
  graph: ReadonlyMap<string, readonly string[]>,
  start: string,
  targets: ReadonlySet<string>,
): string[] | null {
  const pending = (graph.get(start) ?? []).map((dependency) => [start, dependency]);
  const seen = new Set<string>([start]);
  while (pending.length > 0) {
    const path = pending.shift()!;
    const next = path.at(-1)!;
    if (targets.has(next)) return path;
    if (seen.has(next)) continue;
    seen.add(next);
    for (const dependency of graph.get(next) ?? []) {
      pending.push([...path, dependency]);
    }
  }
  return null;
}

function localDependencyPaths(
  graph: ReadonlyMap<string, readonly string[]>,
  starts: readonly string[],
): Map<string, string[]> {
  const paths = new Map<string, string[]>();
  const pending = starts.map((start) => [start]);
  while (pending.length > 0) {
    const path = pending.shift()!;
    const next = path.at(-1)!;
    if (paths.has(next)) continue;
    paths.set(next, path);
    for (const dependency of graph.get(next) ?? []) {
      pending.push([...path, dependency]);
    }
  }
  return paths;
}

function forbiddenExternalDependencies(
  graph: ReadonlyMap<string, readonly string[]>,
  starts: readonly string[],
  externalSpecifiers: ReadonlyMap<string, readonly string[]>,
): ForbiddenExternalDependency[] {
  const escapes: ForbiddenExternalDependency[] = [];
  for (const [file, path] of localDependencyPaths(graph, starts)) {
    for (const specifier of externalSpecifiers.get(file) ?? []) {
      const classification = classifyForbiddenRuntimeExternalModule(specifier);
      if (classification !== null) escapes.push({ classification, path, specifier });
    }
  }
  return escapes.sort((left, right) => (
    [...left.path, left.specifier].join('\0')
      .localeCompare([...right.path, right.specifier].join('\0'))
  ));
}

function reachesAny(
  graph: ReadonlyMap<string, readonly string[]>,
  start: string,
  targets: ReadonlySet<string>,
): boolean {
  const pending = [...(graph.get(start) ?? [])];
  const seen = new Set<string>();
  while (pending.length > 0) {
    const next = pending.pop()!;
    if (targets.has(next)) return true;
    if (seen.has(next)) continue;
    seen.add(next);
    pending.push(...(graph.get(next) ?? []));
  }
  return false;
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
    'CX-002 provider-free mapping must remain unregistered and uncomposed',
  );

  const executable = readFileSync(join(CODEX_SOURCE_ROOT, 'executable.ts'), 'utf8');
  assert.match(executable, /command:\s*realpathSync\(command\)/);
  assert.match(executable, /argsPrefix:\s*EMPTY_ARGS_PREFIX/);
  assert.doesNotMatch(
    executable,
    /bin[\\/]codex\.js|process\.env(?:\.PATH|\[['"]PATH['"]\])/i,
  );
});

test('Codex runtime mapping has no native/default peer or production importer', () => {
  const adapterPath = join(CODEX_SOURCE_ROOT, 'adapter.ts');
  const peerPath = join(CODEX_SOURCE_ROOT, 'runtime-peer.ts');
  const adapter = readFileSync(adapterPath, 'utf8');
  const peer = readFileSync(peerPath, 'utf8');

  assert.match(adapter, /class\s+CodexRuntimeAdapter\s+implements\s+AgentRuntimeAdapter/);
  assert.match(adapter, /runtimePeerFactory:\s*CodexRuntimePeerFactory/);
  assert.match(adapter, /conformanceAuthority:\s*CodexProviderFreeConformanceAuthority/);
  const runtimeSurface = CODEX_RUNTIME_SURFACE
    .map((file) => readFileSync(file, 'utf8'))
    .join('\n');
  assert.doesNotMatch(
    runtimeSurface,
    /CodexAppServerClient|createCodexAppServerClient|runCodexAdmissionSpike|resolvePinnedCodexExecutable|app-server-client|node:child_process|child_process|\bspawn\s*\(/,
    'the provider-free adapter cannot construct a native/default execution peer',
  );
  assert.doesNotMatch(peer, /\brequest\s*\(/, 'the closed runtime peer cannot expose a generic request escape');

  const graph = productionDependencyGraph();
  const nativeEscapes = CODEX_RUNTIME_SURFACE.flatMap((surface) => {
    const path = dependencyPath(graph, surface, CODEX_NATIVE_ROOTS);
    return path === null ? [] : [path.map(repoPath).join(' -> ')];
  });
  assert.deepEqual(
    nativeEscapes,
    [],
    `provider-free runtime reached Codex native ownership: ${nativeEscapes.join('; ')}`,
  );
  const externalSpecifiers = new Map(
    [...graph.keys()].map((file) => [
      file,
      moduleSpecifiers(readFileSync(file, 'utf8'))
        .filter((specifier) => !specifier.startsWith('.')),
    ]),
  );
  const externalEscapes = forbiddenExternalDependencies(
    graph,
    CODEX_RUNTIME_SURFACE,
    externalSpecifiers,
  );
  assert.deepEqual(
    externalEscapes,
    [],
    `provider-free runtime reached process/transport modules: ${externalEscapes
      .map((escape) => (
        `${escape.classification}: ${escape.path.map(repoPath).join(' -> ')} -> ${escape.specifier}`
      ))
      .join('; ')}`,
  );
  const targets = new Set(CODEX_RUNTIME_SURFACE);
  const importers = PRODUCTION_FILES
    .filter((file) => !isWithin(CODEX_SOURCE_ROOT, file))
    .filter((file) => reachesAny(graph, file, targets))
    .map(repoPath);
  assert.deepEqual(importers, [], `Codex adapter escaped its provider-local boundary: ${importers.join(', ')}`);
});

test('Codex runtime import guard resolves relative and transitive barrel escapes', () => {
  const adapterPath = join(CODEX_SOURCE_ROOT, 'adapter.ts');
  assert.equal(
    resolveLocalModule(join(SRC, 'runner', 'probe.ts'), './codex/adapter.ts'),
    adapterPath,
  );
  assert.equal(
    resolveLocalModule(join(SRC, 'chat', 'probe.ts'), '../runner/codex/adapter'),
    adapterPath,
  );
  const outside = join(SRC, 'probe.ts');
  const barrel = join(CODEX_SOURCE_ROOT, 'index.ts');
  const graph = new Map<string, string[]>([
    [outside, [barrel]],
    [barrel, [adapterPath]],
  ]);
  assert.equal(reachesAny(graph, outside, new Set([adapterPath])), true);
});

test('Codex runtime guard rejects transitive native-owner escapes', () => {
  const surface = join(CODEX_SOURCE_ROOT, 'adapter.ts');
  const helper = join(CODEX_SOURCE_ROOT, 'provider-free-helper.ts');
  for (const nativeRoot of CODEX_NATIVE_ROOTS) {
    const graph = new Map<string, string[]>([
      [surface, [helper]],
      [helper, [nativeRoot]],
      [nativeRoot, []],
    ]);
    assert.deepEqual(
      dependencyPath(graph, surface, CODEX_NATIVE_ROOTS),
      [surface, helper, nativeRoot],
      repoPath(nativeRoot),
    );
  }
});

test('Codex runtime guard classifies transitive external process and transport escapes', () => {
  const surface = join(CODEX_SOURCE_ROOT, 'adapter.ts');
  const helper = join(CODEX_SOURCE_ROOT, 'provider-free-helper.ts');
  const graph = new Map<string, string[]>([
    [surface, [helper]],
    [helper, []],
  ]);
  const externalSpecifiers = new Map<string, string[]>([
    [surface, ['node:path', '@pc/contracts']],
    [helper, ['node:child_process', 'ws/lib/websocket']],
  ]);

  assert.deepEqual(
    forbiddenExternalDependencies(graph, [surface], externalSpecifiers),
    [
      {
        classification: 'process',
        path: [surface, helper],
        specifier: 'node:child_process',
      },
      {
        classification: 'alternate-transport',
        path: [surface, helper],
        specifier: 'ws/lib/websocket',
      },
    ],
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
