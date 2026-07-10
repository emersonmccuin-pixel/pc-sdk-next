// Boot recovery (chat). On boot, any active session whose last turn never
// terminated — a turn was in flight when the process died, and no process backs
// it now — is closed out LOUDLY: persist exactly one `turn-failed
// { source:'internal' }` then `session-state idle`. Never silently resume, never
// fake success. Idempotent: the appended terminal means a second boot sees the
// turn as closed.

import {
  appendConversationEvent,
  getActiveOrchestratorSession,
  getConversationReplayState,
  listConversationEvents,
  listProjects,
} from '@pc/db';
import type { ChatEvent } from '@pc/contracts';
import type { ULID } from '@pc/domain';

const RESTART_ERROR = 'server restarted mid-turn';

/** True iff the session has a turn that started (user / session-state≠idle) with
 *  no later terminal (turn-end / turn-failed). */
function hasOpenTurn(sessionId: string): boolean {
  let lastTerminalSeq = 0;
  let lastOpenSeq = 0;
  for (const r of listConversationEvents(sessionId)) {
    if (r.kind === 'turn-end' || r.kind === 'turn-failed') {
      lastTerminalSeq = Math.max(lastTerminalSeq, r.seq);
    } else if (r.kind === 'user') {
      lastOpenSeq = Math.max(lastOpenSeq, r.seq);
    } else if (r.kind === 'session-state') {
      const state = (r.event as { state?: string } | null)?.state;
      if (state && state !== 'idle') lastOpenSeq = Math.max(lastOpenSeq, r.seq);
    }
  }
  return lastOpenSeq > lastTerminalSeq;
}

function append(sessionId: string, projectId: ULID, event: ChatEvent): void {
  const seq = getConversationReplayState(sessionId).nextSeq;
  appendConversationEvent({
    projectId,
    sessionId,
    seq,
    kind: event.kind,
    event,
    now: Date.now(),
  });
}

export interface BootRecoveryResult {
  scanned: number;
  recovered: string[];
}

/** Scan every project's active session; close out crashed turns. Returns the
 *  recovered session ids. */
export function runBootRecovery(): BootRecoveryResult {
  const recovered: string[] = [];
  let scanned = 0;
  for (const project of listProjects()) {
    const session = getActiveOrchestratorSession(project.id);
    if (!session) continue;
    scanned++;
    if (!hasOpenTurn(session.id)) continue;
    append(session.id, project.id, {
      kind: 'turn-failed',
      error: RESTART_ERROR,
      source: 'internal',
    });
    append(session.id, project.id, { kind: 'session-state', state: 'idle', permissionMode: null });
    recovered.push(session.id);
    console.warn(
      `[pc-sdk][boot-recovery] session ${session.id} (project ${project.id}) had a turn in flight — ` +
        `persisted turn-failed{internal} + session-state idle.`,
    );
  }
  if (recovered.length > 0) {
    console.warn(`[pc-sdk][boot-recovery] recovered ${recovered.length}/${scanned} active session(s).`);
  }
  return { scanned, recovered };
}
