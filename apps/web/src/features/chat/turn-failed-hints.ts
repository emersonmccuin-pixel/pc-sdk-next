// Human hints for a `turn-failed` error carrying a parenthesized app-authored
// code (server: apps/server/src/chat/session-service.ts infrastructureFailureMessage).
// The code is app vocabulary — aligned with RUNTIME_SELECTION_ERROR_CODES
// (@pc/contracts), CodexRuntimeAdapterErrorCode, AccountUnavailableError, and
// RepositoryLeaseError — never raw provider text. Unknown/absent codes get no
// hint; this module never invents new codes on its own.

const CODE_PATTERN = /\(([a-z0-9-]+)\)\s*$/;

const HINTS: Record<string, string> = {
  'account-unavailable': "Check the runtime's login (and its subscription quota) on this machine.",
  'account-auth-or-runtime-unavailable': "Check the runtime's login (and its subscription quota) on this machine.",
  'session-mint-unavailable':
    'The provider refused to start or run the session — often quota exhaustion or an expired login. Try again later or re-login.',
  'thread-start-failed':
    'The provider refused to start or run the session — often quota exhaustion or an expired login. Try again later or re-login.',
  'runtime-turn-failed':
    'The provider refused to start or run the session — often quota exhaustion or an expired login. Try again later or re-login.',
  'model-unsupported': "The selected model isn't available on this runtime — pick another in settings.",
  'repository-unavailable': "The project folder's repository is locked or missing.",
};

/** Extracts the trailing `(code)` from a turn-failed error message, if present. */
export function extractTurnFailedCode(error: string): string | null {
  const match = CODE_PATTERN.exec(error);
  return match ? match[1] : null;
}

/** A short, actionable hint for a turn-failed error's code — or null when the
 *  code carries no hint (unknown code, or no code present at all). */
export function turnFailedHint(error: string): string | null {
  const code = extractTurnFailedCode(error);
  return code ? (HINTS[code] ?? null) : null;
}
