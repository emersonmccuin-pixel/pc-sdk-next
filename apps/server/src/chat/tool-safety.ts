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

// ── Host self-preservation guard ────────────────────────────────────────────
//
// Real incident (2026-07-20, twice): asked to "restart the server", the
// orchestrator ran a shell command that killed its OWN host process — the
// PC-SDK server it runs inside — mid-turn. It has no innate idea it lives
// there. This is the hard guard: a shell command that clearly targets this
// server's own pid, its own listen port, or the scheduled tasks that own its
// lifecycle is denied before it runs, regardless of permission mode.
//
// Conservative by design: it only fires when a kill/stop verb co-occurs with
// this exact process's pid or port (or a lifecycle op names the launcher/
// watchdog task). An agent killing a DIFFERENT pid it spawned itself (its own
// test server, a stray process) never matches — that is legitimate and must
// stay allowed. When unsure, allow.

/** Native tool names this guard inspects. Only shell execution can reach the
 *  host process directly; nothing else needs vetting here. */
const SHELL_TOOL_NAMES: ReadonlySet<string> = new Set(['Bash']);

/** taskkill (Windows), Stop-Process (PowerShell), kill (POSIX/Git Bash). */
const KILL_VERB = /\btaskkill\b|\bstop-process\b|\bkill\b/i;

/** Scheduled-task / service lifecycle verbs (net stop, schtasks /end|/delete|/change|/disable). */
const LIFECYCLE_VERB = /\bnet\s+stop\b|\bschtasks\b/i;

/** The launcher/watchdog tasks that own PC-SDK server lifecycle — restarting
 *  or disabling them is equivalent to killing the server out from under the
 *  user's own recovery path. */
const GUARDED_TASKS = ['PC-SDK-Next-Launch', 'PC-SDK-Next-Watchdog'] as const;

export interface HostGuardContext {
  /** This process's own pid (process.pid). */
  pid: number;
  /** This server's own live listen port. 0/unknown ⇒ the port check is skipped. */
  port: number;
}

export type ToolSafetyVerdict =
  | { allowed: true }
  | { allowed: false; reason: string };

const ALLOWED: ToolSafetyVerdict = { allowed: true };

/** Whole-token match: the exact number/word bounded by non-word/non-dot/
 *  non-hyphen characters, so e.g. pid 124 never matches inside port 5124. */
function mentionsToken(command: string, token: number): boolean {
  const escaped = String(token);
  return new RegExp(`(?<![\\w.-])${escaped}(?![\\w.-])`).test(command);
}

function guardedTaskName(command: string): string | undefined {
  return GUARDED_TASKS.find((name) => command.toLowerCase().includes(name.toLowerCase()));
}

/** Evaluate one native shell tool call against the host self-preservation
 *  guard. Non-shell tools, and shell commands that don't clearly target this
 *  process/port/lifecycle task, are always allowed. */
export function evaluateShellCommandSafety(
  toolName: string,
  toolInput: unknown,
  host: HostGuardContext,
): ToolSafetyVerdict {
  if (!SHELL_TOOL_NAMES.has(toolName)) return ALLOWED;
  const command = toolInput && typeof toolInput === 'object'
    ? (toolInput as Record<string, unknown>).command
    : undefined;
  if (typeof command !== 'string' || !command.trim()) return ALLOWED;

  if (KILL_VERB.test(command) && mentionsToken(command, host.pid)) {
    return {
      allowed: false,
      reason: `Refused: this command targets pid ${host.pid} — the PC-SDK server process this session runs inside. Killing it would end this turn mid-execution, not restart anything. Server lifecycle belongs to the user's launcher/watchdog, not this session.`,
    };
  }
  if (host.port > 0 && KILL_VERB.test(command) && mentionsToken(command, host.port)) {
    return {
      allowed: false,
      reason: `Refused: this command targets port ${host.port} — the port the PC-SDK server (this session's own host) listens on. Server lifecycle belongs to the user's launcher/watchdog, not this session.`,
    };
  }
  const task = guardedTaskName(command);
  if (task && LIFECYCLE_VERB.test(command)) {
    return {
      allowed: false,
      reason: `Refused: this command manipulates the '${task}' task, which owns PC-SDK server lifecycle. Server lifecycle belongs to the user's launcher/watchdog, not this session.`,
    };
  }
  return ALLOWED;
}
