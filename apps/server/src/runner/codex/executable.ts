import { existsSync, readFileSync, realpathSync, statSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

export const PINNED_CODEX_PACKAGE = '@openai/codex' as const;
export const PINNED_CODEX_VERSION = '0.144.1' as const;
export const PINNED_CODEX_CLI_VERSION = `codex-cli ${PINNED_CODEX_VERSION}` as const;

type SupportedCodexPlatform = 'darwin' | 'linux' | 'win32';
type SupportedCodexArchitecture = 'arm64' | 'x64';

export interface CodexExecutableTarget {
  readonly platform: SupportedCodexPlatform;
  readonly architecture: SupportedCodexArchitecture;
  readonly targetTriple:
    | 'aarch64-apple-darwin'
    | 'aarch64-pc-windows-msvc'
    | 'aarch64-unknown-linux-musl'
    | 'x86_64-apple-darwin'
    | 'x86_64-pc-windows-msvc'
    | 'x86_64-unknown-linux-musl';
  readonly platformPackage:
    | '@openai/codex-darwin-arm64'
    | '@openai/codex-darwin-x64'
    | '@openai/codex-linux-arm64'
    | '@openai/codex-linux-x64'
    | '@openai/codex-win32-arm64'
    | '@openai/codex-win32-x64';
  readonly platformPackageVersion: string;
}

export interface ResolvedCodexExecutable extends CodexExecutableTarget {
  /** Exact native executable. This is never the npm JavaScript wrapper or PATH. */
  readonly command: string;
  /** Native execution needs no launcher prefix. */
  readonly argsPrefix: readonly [];
  readonly package: typeof PINNED_CODEX_PACKAGE;
  readonly version: typeof PINNED_CODEX_VERSION;
  readonly expectedVersionOutput: typeof PINNED_CODEX_CLI_VERSION;
}

export type CodexExecutableResolutionErrorCode =
  | 'missing-native-executable'
  | 'missing-platform-package'
  | 'package-outside-repository'
  | 'package-version-mismatch'
  | 'unsupported-platform';

export class CodexExecutableResolutionError extends Error {
  constructor(
    readonly code: CodexExecutableResolutionErrorCode,
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = 'CodexExecutableResolutionError';
  }
}

interface PackageManifest {
  readonly name?: unknown;
  readonly version?: unknown;
  readonly os?: unknown;
  readonly cpu?: unknown;
}

const TARGETS = Object.freeze({
  'darwin:arm64': Object.freeze({
    platform: 'darwin',
    architecture: 'arm64',
    targetTriple: 'aarch64-apple-darwin',
    platformPackage: '@openai/codex-darwin-arm64',
    platformPackageVersion: `${PINNED_CODEX_VERSION}-darwin-arm64`,
  }),
  'darwin:x64': Object.freeze({
    platform: 'darwin',
    architecture: 'x64',
    targetTriple: 'x86_64-apple-darwin',
    platformPackage: '@openai/codex-darwin-x64',
    platformPackageVersion: `${PINNED_CODEX_VERSION}-darwin-x64`,
  }),
  'linux:arm64': Object.freeze({
    platform: 'linux',
    architecture: 'arm64',
    targetTriple: 'aarch64-unknown-linux-musl',
    platformPackage: '@openai/codex-linux-arm64',
    platformPackageVersion: `${PINNED_CODEX_VERSION}-linux-arm64`,
  }),
  'linux:x64': Object.freeze({
    platform: 'linux',
    architecture: 'x64',
    targetTriple: 'x86_64-unknown-linux-musl',
    platformPackage: '@openai/codex-linux-x64',
    platformPackageVersion: `${PINNED_CODEX_VERSION}-linux-x64`,
  }),
  'win32:arm64': Object.freeze({
    platform: 'win32',
    architecture: 'arm64',
    targetTriple: 'aarch64-pc-windows-msvc',
    platformPackage: '@openai/codex-win32-arm64',
    platformPackageVersion: `${PINNED_CODEX_VERSION}-win32-arm64`,
  }),
  'win32:x64': Object.freeze({
    platform: 'win32',
    architecture: 'x64',
    targetTriple: 'x86_64-pc-windows-msvc',
    platformPackage: '@openai/codex-win32-x64',
    platformPackageVersion: `${PINNED_CODEX_VERSION}-win32-x64`,
  }),
} satisfies Record<string, CodexExecutableTarget>);

const MODULE_REQUIRE = createRequire(import.meta.url);
const REPOSITORY_ROOT = realpathSync(resolve(dirname(fileURLToPath(import.meta.url)), '../../../../..'));
const EMPTY_ARGS_PREFIX: readonly [] = Object.freeze([]);

export function codexExecutableTarget(
  platform: NodeJS.Platform = process.platform,
  architecture: string = process.arch,
): CodexExecutableTarget {
  const target = TARGETS[`${platform}:${architecture}` as keyof typeof TARGETS];
  if (!target) {
    throw new CodexExecutableResolutionError(
      'unsupported-platform',
      `unsupported Codex platform: ${platform} (${architecture})`,
    );
  }
  return target;
}

/**
 * Resolve the exact platform-native executable nested under the repository's
 * pinned optional dependency. There is intentionally no wrapper/PATH fallback.
 */
export function resolvePinnedCodexExecutable(): ResolvedCodexExecutable {
  const target = codexExecutableTarget();
  const rootManifestPath = resolveRootManifest();
  assertRepositoryOwned(rootManifestPath);
  assertManifest(
    readManifest(rootManifestPath),
    PINNED_CODEX_PACKAGE,
    PINNED_CODEX_VERSION,
    'root package',
  );

  const packageRequire = createRequire(rootManifestPath);
  let platformManifestPath: string;
  try {
    platformManifestPath = packageRequire.resolve(`${target.platformPackage}/package.json`);
  } catch (cause) {
    throw new CodexExecutableResolutionError(
      'missing-platform-package',
      `missing pinned Codex platform package: ${target.platformPackage}`,
      { cause },
    );
  }
  assertRepositoryOwned(platformManifestPath);
  const platformManifest = readManifest(platformManifestPath);
  assertManifest(
    platformManifest,
    PINNED_CODEX_PACKAGE,
    target.platformPackageVersion,
    'platform package',
  );
  if (
    !Array.isArray(platformManifest.os) ||
    platformManifest.os.length !== 1 ||
    platformManifest.os[0] !== target.platform ||
    !Array.isArray(platformManifest.cpu) ||
    platformManifest.cpu.length !== 1 ||
    platformManifest.cpu[0] !== target.architecture
  ) {
    throw new CodexExecutableResolutionError(
      'package-version-mismatch',
      `Codex platform package metadata does not match ${target.platform}:${target.architecture}`,
    );
  }

  const command = join(
    dirname(platformManifestPath),
    'vendor',
    target.targetTriple,
    'bin',
    target.platform === 'win32' ? 'codex.exe' : 'codex',
  );
  if (!existsSync(command) || !statSync(command).isFile()) {
    throw new CodexExecutableResolutionError(
      'missing-native-executable',
      `missing native Codex executable for ${target.targetTriple}`,
    );
  }
  assertRepositoryOwned(command);

  return Object.freeze({
    ...target,
    command: realpathSync(command),
    argsPrefix: EMPTY_ARGS_PREFIX,
    package: PINNED_CODEX_PACKAGE,
    version: PINNED_CODEX_VERSION,
    expectedVersionOutput: PINNED_CODEX_CLI_VERSION,
  });
}

export function assertPinnedCodexVersionOutput(output: string): void {
  if (output.trim() !== PINNED_CODEX_CLI_VERSION) {
    throw new CodexExecutableResolutionError(
      'package-version-mismatch',
      `Codex executable version mismatch: expected ${PINNED_CODEX_CLI_VERSION}`,
    );
  }
}

function resolveRootManifest(): string {
  let manifestPath: string;
  try {
    manifestPath = MODULE_REQUIRE.resolve(`${PINNED_CODEX_PACKAGE}/package.json`);
  } catch (cause) {
    throw new CodexExecutableResolutionError(
      'package-version-mismatch',
      `missing pinned Codex root package: ${PINNED_CODEX_PACKAGE}@${PINNED_CODEX_VERSION}`,
      { cause },
    );
  }
  return manifestPath;
}

function readManifest(path: string): PackageManifest {
  try {
    return JSON.parse(readFileSync(path, 'utf8')) as PackageManifest;
  } catch (cause) {
    throw new CodexExecutableResolutionError(
      'package-version-mismatch',
      'invalid pinned Codex package manifest',
      { cause },
    );
  }
}

function assertManifest(
  manifest: PackageManifest,
  expectedName: string,
  expectedVersion: string,
  label: string,
): void {
  if (manifest.name !== expectedName || manifest.version !== expectedVersion) {
    throw new CodexExecutableResolutionError(
      'package-version-mismatch',
      `${label} mismatch: expected ${expectedName}@${expectedVersion}`,
    );
  }
}

function assertRepositoryOwned(path: string): void {
  const canonicalPath = realpathSync(path);
  const relativePath = relative(REPOSITORY_ROOT, canonicalPath);
  if (
    relativePath === '..' ||
    relativePath.startsWith(`..${sep}`) ||
    isAbsolute(relativePath)
  ) {
    throw new CodexExecutableResolutionError(
      'package-outside-repository',
      'resolved Codex package is outside the repository dependency tree',
    );
  }
}
