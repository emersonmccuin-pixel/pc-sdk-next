// Tool approval payloads are ephemeral but still cross into the browser. Keep
// them bounded and redact common secret-bearing keys/tokens. Durable tool
// events are stricter: they carry no technical payload at all.

const REDACTED = '[redacted]';
const TRUNCATED = '[truncated]';
const MAX_DEPTH = 5;
const MAX_KEYS = 40;
const MAX_ITEMS = 40;
const MAX_STRING = 2_000;
const MAX_TOTAL_CHARS = 12_000;
const MAX_NODES = 500;

const SECRET_KEY = /(?:authorization|cookie|credential|password|passwd|private[_-]?key|api[_-]?key|access[_-]?key|refresh[_-]?token|token|secret)/i;
const INLINE_SECRET = /\b([A-Z0-9_]*(?:TOKEN|SECRET|PASSWORD|PASSWD|API_KEY|PRIVATE_KEY)[A-Z0-9_]*\s*[:=]\s*)(?:"[^"]*"|'[^']*'|[^\s;]+)/gi;
const BEARER = /(authorization\s*[:=]\s*bearer\s+)[^\s"']+/gi;
const KNOWN_TOKEN = /\b(?:sk-[A-Za-z0-9_-]{8,}|gh[pousr]_[A-Za-z0-9_]{8,})\b/g;

interface Budget {
  remaining: number;
  nodesRemaining: number;
}

function boundedString(value: string, budget: Budget): string {
  const redacted = value
    .replace(BEARER, `$1${REDACTED}`)
    .replace(INLINE_SECRET, `$1${REDACTED}`)
    .replace(KNOWN_TOKEN, REDACTED);
  const allowed = Math.max(0, Math.min(MAX_STRING, budget.remaining));
  budget.remaining -= Math.min(redacted.length, allowed);
  return redacted.length > allowed ? `${redacted.slice(0, allowed)}${TRUNCATED}` : redacted;
}

function project(value: unknown, depth: number, budget: Budget, seen: WeakSet<object>): unknown {
  if (budget.remaining <= 0 || budget.nodesRemaining <= 0) return TRUNCATED;
  budget.nodesRemaining -= 1;
  if (value === null || typeof value === 'boolean' || typeof value === 'number') {
    const size = JSON.stringify(value).length;
    if (size > budget.remaining) return TRUNCATED;
    budget.remaining -= size;
    return value;
  }
  if (typeof value === 'string') return boundedString(value, budget);
  if (typeof value !== 'object') return `[${typeof value}]`;
  if (depth >= MAX_DEPTH) return TRUNCATED;
  if (seen.has(value)) return '[circular]';
  seen.add(value);
  if (Array.isArray(value)) {
    const output: unknown[] = [];
    for (const item of value.slice(0, MAX_ITEMS)) {
      if (budget.remaining <= 0 || budget.nodesRemaining <= 0) {
        output.push(TRUNCATED);
        break;
      }
      output.push(project(item, depth + 1, budget, seen));
    }
    return output;
  }
  const output: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(value).slice(0, MAX_KEYS)) {
    budget.remaining -= Math.min(key.length, budget.remaining);
    output[key] = SECRET_KEY.test(key) ? REDACTED : project(item, depth + 1, budget, seen);
    if (budget.remaining <= 0) break;
  }
  return output;
}

export function redactToolInput(value: unknown): unknown {
  const projected = project(
    value,
    0,
    { remaining: MAX_TOTAL_CHARS, nodesRemaining: MAX_NODES },
    new WeakSet(),
  );
  // The character budget accounts for content while projecting; this final
  // check also covers JSON punctuation and truncation markers exactly.
  return JSON.stringify(projected).length <= MAX_TOTAL_CHARS ? projected : TRUNCATED;
}
