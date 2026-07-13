import { realpathSync, statSync } from 'node:fs';
import { posix, win32 } from 'node:path';
import { buildChildEnvironment } from '../../operations/child-environment.ts';

export type CodexEnvironmentErrorCode =
  | 'codex-home-invalid'
  | 'codex-home-not-absolute'
  | 'codex-home-not-canonical'
  | 'codex-home-unavailable'
  | 'codex-home-not-directory';

/**
 * A stable, provider-safe rejection. Requested paths and native filesystem
 * errors are intentionally absent so callers can surface the code without
 * disclosing credential-home or host details.
 */
export class CodexEnvironmentError extends Error {
  readonly name = 'CodexEnvironmentError';

  constructor(readonly code: CodexEnvironmentErrorCode) {
    super(`Codex environment rejected: ${code}`);
  }
}

/** Narrow filesystem seam for deterministic platform and alias tests. */
export interface CodexEnvironmentFileSystem {
  realpath(path: string): string;
  isDirectory(path: string): boolean;
}

export interface CodexEnvironmentOptions {
  readonly baseEnvironment?: NodeJS.ProcessEnv;
  readonly platform?: NodeJS.Platform;
  readonly fileSystem?: CodexEnvironmentFileSystem;
}

const NODE_FILE_SYSTEM: CodexEnvironmentFileSystem = Object.freeze({
  realpath(path: string): string {
    return realpathSync.native(path);
  },
  isDirectory(path: string): boolean {
    return statSync(path).isDirectory();
  },
});

/**
 * Build the complete environment for a Codex child.
 *
 * The selected home is always explicit and must already be its filesystem
 * canonical spelling. No ambient Codex home, raw credential, or endpoint can
 * participate in selection because the shared positive allowlist is applied
 * before the one provider selector is added.
 */
export function buildCodexEnvironment(
  codexHome: string,
  options: CodexEnvironmentOptions = {},
): Record<string, string> {
  const platform = options.platform ?? process.platform;
  const canonicalHome = requireCanonicalDirectory(
    codexHome,
    platform,
    options.fileSystem ?? NODE_FILE_SYSTEM,
  );
  const environment = buildChildEnvironment(
    options.baseEnvironment ?? process.env,
    platform,
  );
  environment.CODEX_HOME = canonicalHome;
  return environment;
}

function requireCanonicalDirectory(
  requestedHome: string,
  platform: NodeJS.Platform,
  fileSystem: CodexEnvironmentFileSystem,
): string {
  if (
    typeof requestedHome !== 'string' ||
    requestedHome.length === 0 ||
    requestedHome.trim() !== requestedHome ||
    requestedHome.includes('\u0000')
  ) {
    reject('codex-home-invalid');
  }

  const path = platform === 'win32' ? win32 : posix;
  if (!isExplicitAbsolutePath(requestedHome, platform)) {
    reject('codex-home-not-absolute');
  }
  if (path.normalize(requestedHome) !== requestedHome) {
    reject('codex-home-not-canonical');
  }

  let canonicalHome: string;
  try {
    canonicalHome = fileSystem.realpath(requestedHome);
  } catch {
    reject('codex-home-unavailable');
  }

  if (
    typeof canonicalHome !== 'string' ||
    canonicalHome.length === 0 ||
    canonicalHome.includes('\u0000') ||
    !isExplicitAbsolutePath(canonicalHome, platform) ||
    path.normalize(canonicalHome) !== canonicalHome
  ) {
    reject('codex-home-unavailable');
  }
  // Exact comparison is deliberate on Windows too. realpath supplies the
  // filesystem spelling, so a case variant or junction/symlink is an alias,
  // not the exact credential home selected by PC-SDK.
  if (canonicalHome !== requestedHome) {
    reject('codex-home-not-canonical');
  }

  let isDirectory: boolean;
  try {
    isDirectory = fileSystem.isDirectory(canonicalHome);
  } catch {
    reject('codex-home-unavailable');
  }
  if (!isDirectory) {
    reject('codex-home-not-directory');
  }

  return canonicalHome;
}

function isExplicitAbsolutePath(value: string, platform: NodeJS.Platform): boolean {
  if (platform !== 'win32') return posix.isAbsolute(value);
  if (!win32.isAbsolute(value)) return false;

  // Root-relative Windows paths depend on an ambient current drive. Admit
  // only an explicit drive-qualified path or a complete UNC share.
  const root = win32.parse(value).root;
  return /^[A-Za-z]:[\\/]$/.test(root) ||
    /^(?:\\\\|\/\/)[^\\/]+[\\/][^\\/]+[\\/]$/.test(root);
}

function reject(code: CodexEnvironmentErrorCode): never {
  throw new CodexEnvironmentError(code);
}
