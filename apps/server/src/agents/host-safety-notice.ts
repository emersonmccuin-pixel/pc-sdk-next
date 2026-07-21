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

/** Append the live notice to the orchestrator's stored prompt. Returns
 *  undefined when there is no prompt to attach it to, so callers preserve
 *  their existing "no instructions ⇒ adapter default" behavior untouched. */
export function composeOrchestratorInstructions(
  prompt: string | null | undefined,
  pid: number,
  port: number,
): string | undefined {
  const trimmed = prompt?.trim();
  if (!trimmed) return undefined;
  return `${trimmed}${buildHostSafetyNotice(pid, port)}`;
}
