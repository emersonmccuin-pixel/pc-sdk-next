import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, isAbsolute, join, relative, sep } from 'node:path';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { buildChildEnvironment } from '../src/operations/child-environment.ts';
import {
  assertPinnedCodexVersionOutput,
  codexExecutableTarget,
  PINNED_CODEX_CLI_VERSION,
  PINNED_CODEX_PACKAGE,
  PINNED_CODEX_VERSION,
  resolvePinnedCodexExecutable,
} from '../src/runner/codex/executable.ts';

interface SchemaManifest {
  readonly schemaVersion: number;
  readonly package: {
    readonly name: string;
    readonly version: string;
  };
  readonly executable: {
    readonly kind: string;
    readonly cliVersion: string;
  };
  readonly generation: {
    readonly experimental: boolean;
    readonly command: {
      readonly executable: string;
      readonly arguments: readonly string[];
    };
  };
  readonly inventory: {
    readonly fileCount: number;
    readonly hashAlgorithm: string;
    readonly hash: string;
    readonly files: readonly string[];
  };
  readonly tree: {
    readonly hashAlgorithm: string;
    readonly hash: string;
  };
}

const TEST_DIR = dirname(fileURLToPath(import.meta.url));
const SERVER_ROOT = join(TEST_DIR, '..');
const REPOSITORY_ROOT = join(SERVER_ROOT, '..', '..');
const CODEX_ROOT = join(SERVER_ROOT, 'src', 'runner', 'codex');
const GENERATED_ROOT = join(CODEX_ROOT, 'generated');
const MANIFEST = parseManifest(join(CODEX_ROOT, 'schema-manifest.json'));
const GENERATION_ARGUMENTS = [
  'app-server',
  'generate-ts',
  '--out',
  '<generated-directory>',
] as const;

test('Codex dependency and spike commands are exact', () => {
  const rootPackage = parseJson(join(REPOSITORY_ROOT, 'package.json'));
  const serverPackage = parseJson(join(SERVER_ROOT, 'package.json'));

  assert.equal(nestedString(serverPackage, 'devDependencies', PINNED_CODEX_PACKAGE), PINNED_CODEX_VERSION);
  assert.equal(
    nestedString(rootPackage, 'scripts', 'spike:codex'),
    'node apps/server/node_modules/tsx/dist/cli.mjs apps/server/scripts/codex-spike.ts',
  );
  assert.equal(nestedString(serverPackage, 'scripts', 'spike:codex'), 'tsx scripts/codex-spike.ts');
});

test('Codex generated schema has a checkout-stable LF policy', () => {
  const sample = 'apps/server/src/runner/codex/generated/index.ts';
  const attributes = execFileSync('git', ['check-attr', 'text', 'eol', '--', sample], {
    cwd: REPOSITORY_ROOT,
    encoding: 'utf8',
  }).trim().split(/\r?\n/u);
  assert.deepEqual(attributes, [
    `${sample}: text: set`,
    `${sample}: eol: lf`,
  ]);
});

test('Codex native target mapping is exact and unsupported hosts fail closed', () => {
  assert.deepEqual(
    [
      codexExecutableTarget('darwin', 'arm64'),
      codexExecutableTarget('darwin', 'x64'),
      codexExecutableTarget('linux', 'arm64'),
      codexExecutableTarget('linux', 'x64'),
      codexExecutableTarget('win32', 'arm64'),
      codexExecutableTarget('win32', 'x64'),
    ].map(({ platform, architecture, targetTriple, platformPackage }) => ({
      platform,
      architecture,
      targetTriple,
      platformPackage,
    })),
    [
      {
        platform: 'darwin',
        architecture: 'arm64',
        targetTriple: 'aarch64-apple-darwin',
        platformPackage: '@openai/codex-darwin-arm64',
      },
      {
        platform: 'darwin',
        architecture: 'x64',
        targetTriple: 'x86_64-apple-darwin',
        platformPackage: '@openai/codex-darwin-x64',
      },
      {
        platform: 'linux',
        architecture: 'arm64',
        targetTriple: 'aarch64-unknown-linux-musl',
        platformPackage: '@openai/codex-linux-arm64',
      },
      {
        platform: 'linux',
        architecture: 'x64',
        targetTriple: 'x86_64-unknown-linux-musl',
        platformPackage: '@openai/codex-linux-x64',
      },
      {
        platform: 'win32',
        architecture: 'arm64',
        targetTriple: 'aarch64-pc-windows-msvc',
        platformPackage: '@openai/codex-win32-arm64',
      },
      {
        platform: 'win32',
        architecture: 'x64',
        targetTriple: 'x86_64-pc-windows-msvc',
        platformPackage: '@openai/codex-win32-x64',
      },
    ],
  );
  assert.throws(
    () => codexExecutableTarget('aix', 'ppc64'),
    (error: unknown) => error instanceof Error &&
      'code' in error && error.code === 'unsupported-platform',
  );
});

test('repository-relative containment rejects host-native parent escapes', () => {
  assert.equal(isRepositoryRelativePath(join('node_modules', '@openai', 'codex')), true);
  assert.equal(isRepositoryRelativePath('..'), false);
  assert.equal(isRepositoryRelativePath(join('..', 'outside-repository')), false);
  assert.equal(isRepositoryRelativePath(join(REPOSITORY_ROOT, '..', 'outside-repository')), false);
});

test('Codex schema manifest describes the exact stable pinned generation', () => {
  assert.deepEqual(
    {
      schemaVersion: MANIFEST.schemaVersion,
      package: MANIFEST.package,
      executable: MANIFEST.executable,
      generation: MANIFEST.generation,
    },
    {
      schemaVersion: 1,
      package: { name: PINNED_CODEX_PACKAGE, version: PINNED_CODEX_VERSION },
      executable: {
        kind: 'native-platform-optional-dependency',
        cliVersion: PINNED_CODEX_CLI_VERSION,
      },
      generation: {
        experimental: false,
        command: {
          executable: '<repo-pinned-native-codex>',
          arguments: GENERATION_ARGUMENTS,
        },
      },
    },
  );

  const checkedInFiles = inventory(GENERATED_ROOT);
  assert.equal(MANIFEST.inventory.hashAlgorithm, 'sha256:utf8-json-array-v1');
  assert.equal(MANIFEST.inventory.fileCount, checkedInFiles.length);
  assert.deepEqual(MANIFEST.inventory.files, checkedInFiles);
  assert.equal(MANIFEST.inventory.hash, inventoryHash(checkedInFiles));
  assert.equal(MANIFEST.tree.hashAlgorithm, 'sha256:length-prefixed-path-and-content-v1');
  assert.equal(MANIFEST.tree.hash, treeHash(GENERATED_ROOT, checkedInFiles));
});

test('Codex schema regenerates exactly from the repository-pinned native executable', {
  timeout: 120_000,
}, () => {
  const temporaryRoot = mkdtempSync(join(tmpdir(), 'pc-sdk-codex-schema-test-'));
  const codexHome = join(temporaryRoot, 'codex-home');
  const generatedRoot = join(temporaryRoot, 'generated');
  mkdirSync(codexHome);
  mkdirSync(generatedRoot);

  try {
    const executable = resolvePinnedCodexExecutable();
    const relativeCommand = relative(REPOSITORY_ROOT, executable.command);
    assert.equal(isAbsolute(executable.command), true);
    assert.equal(isRepositoryRelativePath(relativeCommand), true);
    assert.deepEqual(executable.argsPrefix, []);
    assert.equal(executable.version, PINNED_CODEX_VERSION);
    assert.match(executable.command.replace(/\\/gu, '/'), /\/vendor\/[^/]+\/bin\/codex(?:\.exe)?$/u);
    assert.doesNotMatch(executable.command.replace(/\\/gu, '/'), /\/bin\/codex\.js$/u);

    const env = {
      ...buildChildEnvironment(),
      CODEX_HOME: codexHome,
    };
    const versionOutput = execFileSync(
      executable.command,
      [...executable.argsPrefix, '--version'],
      { encoding: 'utf8', env, timeout: 15_000 },
    );
    assertPinnedCodexVersionOutput(versionOutput);

    execFileSync(
      executable.command,
      [...executable.argsPrefix, ...GENERATION_ARGUMENTS.slice(0, -1), generatedRoot],
      { encoding: 'utf8', env, maxBuffer: 16 * 1024 * 1024, timeout: 60_000 },
    );

    const regeneratedFiles = inventory(generatedRoot);
    assert.deepEqual(regeneratedFiles, MANIFEST.inventory.files);
    assert.equal(inventoryHash(regeneratedFiles), MANIFEST.inventory.hash);
    assert.equal(treeHash(generatedRoot, regeneratedFiles), MANIFEST.tree.hash);
    for (const path of regeneratedFiles) {
      assert.deepEqual(
        readFileSync(join(generatedRoot, ...path.split('/'))),
        readFileSync(join(GENERATED_ROOT, ...path.split('/'))),
        `generated schema mismatch: ${path}`,
      );
    }
  } finally {
    rmSync(temporaryRoot, { recursive: true, force: true, maxRetries: 3 });
  }
});

function parseManifest(path: string): SchemaManifest {
  return JSON.parse(readFileSync(path, 'utf8')) as SchemaManifest;
}

function parseJson(path: string): Record<string, unknown> {
  return JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown>;
}

function nestedString(value: Record<string, unknown>, section: string, key: string): unknown {
  const nested = value[section];
  return nested && typeof nested === 'object'
    ? (nested as Record<string, unknown>)[key]
    : undefined;
}

function inventory(root: string): string[] {
  return walk(root)
    .map((path) => relative(root, path).replace(/\\/gu, '/'))
    .sort();
}

function walk(root: string, files: string[] = []): string[] {
  for (const name of readdirSync(root)) {
    const path = join(root, name);
    if (statSync(path).isDirectory()) walk(path, files);
    else files.push(path);
  }
  return files;
}

function inventoryHash(files: readonly string[]): string {
  return `sha256:${createHash('sha256').update(JSON.stringify(files), 'utf8').digest('hex')}`;
}

function treeHash(root: string, files: readonly string[]): string {
  const hash = createHash('sha256');
  for (const path of files) {
    const pathBytes = Buffer.from(path, 'utf8');
    const content = readFileSync(join(root, ...path.split('/')));
    hash.update(uint64(pathBytes.length));
    hash.update(pathBytes);
    hash.update(uint64(content.length));
    hash.update(content);
  }
  return `sha256:${hash.digest('hex')}`;
}

function uint64(value: number): Buffer {
  const output = Buffer.alloc(8);
  output.writeBigUInt64BE(BigInt(value));
  return output;
}

function isRepositoryRelativePath(path: string): boolean {
  return path !== '..' && !path.startsWith(`..${sep}`) && !isAbsolute(path);
}
