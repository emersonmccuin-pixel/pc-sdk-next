/**
 * The complete set of ambient variables that app-owned POSIX children may
 * inherit. Keep this list explicit: wildcard locale/config prefixes would turn
 * an allowlist back into an ambient capability channel.
 */
export const POSIX_CHILD_ENVIRONMENT_ALLOWLIST = Object.freeze([
  'COLORTERM',
  'HOME',
  'LANG',
  'LANGUAGE',
  'LC_ADDRESS',
  'LC_ALL',
  'LC_COLLATE',
  'LC_CTYPE',
  'LC_IDENTIFICATION',
  'LC_MEASUREMENT',
  'LC_MESSAGES',
  'LC_MONETARY',
  'LC_NAME',
  'LC_NUMERIC',
  'LC_PAPER',
  'LC_TELEPHONE',
  'LC_TIME',
  'LOGNAME',
  'PATH',
  'SHELL',
  'TERM',
  'TMPDIR',
  'TZ',
  'USER',
  'XDG_CACHE_HOME',
  'XDG_CONFIG_HOME',
  'XDG_DATA_HOME',
  'XDG_RUNTIME_DIR',
  'XDG_STATE_HOME',
] as const);

/**
 * The complete set of ambient variables that app-owned Windows children may
 * inherit. Canonical uppercase output makes the result independent of the
 * spelling used by a caller's environment object.
 */
export const WINDOWS_CHILD_ENVIRONMENT_ALLOWLIST = Object.freeze([
  'APPDATA',
  'COLORTERM',
  'COMMONPROGRAMFILES',
  'COMMONPROGRAMFILES(X86)',
  'COMMONPROGRAMW6432',
  'COMSPEC',
  'HOME',
  'HOMEDRIVE',
  'HOMEPATH',
  'LANG',
  'LANGUAGE',
  'LC_ADDRESS',
  'LC_ALL',
  'LC_COLLATE',
  'LC_CTYPE',
  'LC_IDENTIFICATION',
  'LC_MEASUREMENT',
  'LC_MESSAGES',
  'LC_MONETARY',
  'LC_NAME',
  'LC_NUMERIC',
  'LC_PAPER',
  'LC_TELEPHONE',
  'LC_TIME',
  'LOCALAPPDATA',
  'LOGNAME',
  'PATH',
  'PATHEXT',
  'PROCESSOR_ARCHITECTURE',
  'PROGRAMFILES',
  'PROGRAMFILES(X86)',
  'PROGRAMW6432',
  'SHELL',
  'SYSTEMDRIVE',
  'SYSTEMROOT',
  'TEMP',
  'TERM',
  'TMP',
  'TMPDIR',
  'TZ',
  'USER',
  'USERNAME',
  'USERPROFILE',
  'WINDIR',
  'XDG_CACHE_HOME',
  'XDG_CONFIG_HOME',
  'XDG_DATA_HOME',
  'XDG_RUNTIME_DIR',
  'XDG_STATE_HOME',
] as const);

const POSIX_ALLOWED_NAMES: ReadonlySet<string> = new Set(
  POSIX_CHILD_ENVIRONMENT_ALLOWLIST,
);
const WINDOWS_CANONICAL_NAMES: ReadonlyMap<string, string> = new Map(
  WINDOWS_CHILD_ENVIRONMENT_ALLOWLIST.map((name) => [name.toUpperCase(), name]),
);

/**
 * Build the ambient environment for an app-owned child process from an empty
 * object and a small OS-essential allowlist.
 *
 * Windows names are case-insensitive. One non-canonical spelling is accepted
 * and emitted canonically, but multiple spellings of the same allowed name are
 * ambiguous and all are dropped. Other platforms retain only exact uppercase
 * names. The supplied object is never modified.
 */
export function buildChildEnvironment(
  base: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
): Record<string, string> {
  return platform === 'win32'
    ? buildWindowsChildEnvironment(base)
    : buildPosixChildEnvironment(base);
}

function buildPosixChildEnvironment(base: NodeJS.ProcessEnv): Record<string, string> {
  const result: Record<string, string> = {};
  for (const [name, value] of Object.entries(base)) {
    if (POSIX_ALLOWED_NAMES.has(name) && isSafeEnvironmentValue(value)) {
      result[name] = value;
    }
  }
  return result;
}

function buildWindowsChildEnvironment(base: NodeJS.ProcessEnv): Record<string, string> {
  const candidates = new Map<string, Array<string | undefined>>();
  for (const [name, value] of Object.entries(base)) {
    // Reject Unicode case-fold lookalikes before matching ASCII Windows names.
    if (!/^[A-Za-z0-9_()]+$/.test(name)) continue;
    const canonicalName = WINDOWS_CANONICAL_NAMES.get(name.toUpperCase());
    if (!canonicalName) continue;
    const values = candidates.get(canonicalName);
    if (values) values.push(value);
    else candidates.set(canonicalName, [value]);
  }

  const result: Record<string, string> = {};
  for (const [canonicalName, values] of candidates) {
    if (values.length === 1 && isSafeEnvironmentValue(values[0])) {
      result[canonicalName] = values[0];
    }
  }
  return result;
}

function isSafeEnvironmentValue(value: unknown): value is string {
  return typeof value === 'string' &&
    !value.includes('\u0000') &&
    !/^\s*\(\)/.test(value);
}
