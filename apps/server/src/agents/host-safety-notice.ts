// Host-safety notice — composed fresh at session mint (never stored on the
// orchestrator row) so it always carries the LIVE pid/port of the server
// process the orchestrator is actually running inside. The orchestrator has
// no innate awareness that its own turn runs inside this process; without
// this notice it can (and twice has) "restart the server" by killing its own
// host mid-turn.
//
// The hard guard in ../chat/tool-safety.ts enforces the same fact
// mechanically; this notice is the honest, in-band explanation so the
// orchestrator says so instead of attempting it and hitting the guard.

const LAUNCHER_TASK = 'PC-SDK-Next-Launch';
const WATCHDOG_TASK = 'PC-SDK-Next-Watchdog';

/** One terse, runtime-composed paragraph — appended to whatever prompt text
 *  the orchestrator row carries. Never cached; call fresh per mint. */
export function buildHostSafetyNotice(pid: number, port: number): string {
  return `\n\n## You run inside the PC-SDK server\n\nThis session runs inside the PC-SDK server process itself: pid ${pid}, listening on port ${port}. That process is your own host — killing, restarting, or re-binding it ends this turn mid-execution instead of "fixing the server." Never run a command that targets pid ${pid} or port ${port} (taskkill, Stop-Process, kill, or anything touching the ${LAUNCHER_TASK} / ${WATCHDOG_TASK} tasks). Server lifecycle belongs to the user's launcher/watchdog, not to you — if asked to restart or check the server, say so plainly instead of attempting it.`;
}

/** One terse notice countering the charter's fixed tool list. Account-level
 *  claude.ai connectors and attached MCP servers reach the orchestrator as
 *  DEFERRED tools: their names surface in system reminders, but their schemas
 *  load only after an explicit ToolSearch. Without this, a fresh session trusts
 *  the closed-world "Your tools" list (which even says "No web access") and
 *  never looks — so the user has to name a connector before it will use it. */
export function buildConnectorAwarenessNotice(): string {
  return `\n\n## Your connected apps are your live capability inventory\n\nBeyond the tools named above, this session has additional MCP servers and connectors attached — project/global MCP servers and account-level claude.ai connectors (mail, calendar, issue trackers, and more). System reminders in each session announce their live state: which are CONNECTED, which are still connecting, and which REQUIRE AUTHORIZATION. Read that connected set as the authoritative list of apps you can actually use right now, and decide what to reach for from it — do not wait to be told an app exists, and do not treat the fixed list above (or any "no web access" line) as the full extent of what you can do.\n\nThese connectors arrive as DEFERRED tools: their names appear in the reminders, but their schemas load only after you call ToolSearch. When a request maps to a connected app, ToolSearch for its tool and load it before acting. An app listed as requiring authorization is unavailable until the user authorizes it in claude.ai — say that plainly rather than guessing or silently substituting another tool.`;
}

/** Append the live notices to the orchestrator's stored prompt. Returns
 *  undefined when there is no prompt to attach them to, so callers preserve
 *  their existing "no instructions ⇒ adapter default" behavior untouched. */
export function composeOrchestratorInstructions(
  prompt: string | null | undefined,
  pid: number,
  port: number,
): string | undefined {
  const trimmed = prompt?.trim();
  if (!trimmed) return undefined;
  return `${trimmed}${buildHostSafetyNotice(pid, port)}${buildConnectorAwarenessNotice()}`;
}
