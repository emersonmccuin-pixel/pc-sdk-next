// Bounded, secret-scrubbed provider diagnostic text. Native adapter/runtime
// prose may cross the app boundary ONLY through this helper's output: capped
// length, token-shaped substrings redacted. Never used for control flow —
// callers key behavior off typed codes, this is display-only detail.

export const PROVIDER_DETAIL_MAX_LENGTH = 500;

const REDACTED = '[redacted]';

// Applied in order: specific credential shapes first (so a matched secret is
// already replaced before the generic long-run pattern would otherwise catch
// an overlapping substring), then the generic 40+ char base64/hex run.
const TOKEN_PATTERNS: readonly RegExp[] = [
  /sk-[A-Za-z0-9]{8,}/g,
  /Bearer\s+[A-Za-z0-9._~+/=-]+/gi,
  /[A-Za-z0-9+/_-]{40,}/g,
];

/** Scrub one native provider message for safe display: redact token-like
 *  substrings and cap length. Returns null for empty/non-string input so
 *  callers can omit the field entirely rather than carry an empty detail. */
export function scrubProviderDetail(text: string | null | undefined): string | null {
  if (typeof text !== 'string') return null;
  const trimmed = text.trim();
  if (!trimmed) return null;
  let scrubbed = trimmed;
  for (const pattern of TOKEN_PATTERNS) {
    scrubbed = scrubbed.replace(pattern, REDACTED);
  }
  return scrubbed.length > PROVIDER_DETAIL_MAX_LENGTH
    ? scrubbed.slice(0, PROVIDER_DETAIL_MAX_LENGTH)
    : scrubbed;
}
