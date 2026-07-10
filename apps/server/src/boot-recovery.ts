// Boot recovery. On boot:
//  - chat: any active session whose last turn never terminated — a turn was in
//    flight when the process died — is closed out LOUDLY: persist exactly one
//    `turn-failed { source:'internal' }` then `session-state idle`.
//  - agent runs (premortem #5): every non-terminal run is failed loudly with
//    cause 'server-restart' (in-process runtime sessions do not survive a
//    restart), its open asks are cancelled, and its contract's verification is
//    parked 'pending' (the agent never finished — re-dispatch, don't reject).
//  - worktrees: active rows with no live run are logged as stranded, never
//    silently reclaimed. Pending landings are re-driven post-attach by the
//    dispatch service (the git mechanics live there).
// Never silently resume, never fake success. Idempotent.

import {
  appendConversationEvent,
  getActiveOrchestratorSession,
  getConversationReplayState,
  listConversationEvents,
  listNonTerminalAgentRuns,
  listOpenPendingAsksForProject,
  listProjects,
  markPendingAskCancelled,
} from '@pc/db';
import { AgentRunMutationGateway, ContractService } from '@pc/app-services';
import type { ChatEvent } from '@pc/contracts';
import type { ULID } from '@pc/domain';
import { scanStrandedWorktrees } from './dispatch/worktrees.ts';

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
  failedRuns: string[];
  strandedWorktrees: string[];
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

  const failedRuns = recoverAgentRuns();
  const strandedWorktrees = reportStrandedWorktrees();
  return { scanned, recovered, failedRuns, strandedWorktrees };
}

/** Fail every non-terminal agent run loudly (`server-restart`) — the live
 *  runtime session died with the process; a silent 'running' row would be a
 *  phantom. Open asks are cancelled; the contract parks at verification
 *  'pending' (agent never finished ⇒ re-dispatchable, not rejected). */
function recoverAgentRuns(): string[] {
  const gateway = new AgentRunMutationGateway();
  const contracts = new ContractService();
  const failed: string[] = [];
  const now = Date.now();
  const openAsksByRun = new Map<string, ULID[]>();
  for (const project of listProjects()) {
    for (const ask of listOpenPendingAsksForProject(project.id)) {
      const list = openAsksByRun.get(ask.agentRunId) ?? [];
      list.push(ask.id);
      openAsksByRun.set(ask.agentRunId, list);
    }
  }
  for (const run of listNonTerminalAgentRuns()) {
    for (const askId of openAsksByRun.get(run.id) ?? []) markPendingAskCancelled(askId, now);
    const publication = gateway.commitTerminal({
      runId: run.id,
      status: 'failed',
      result: null,
      failureCause: 'server-restart',
      failureReason: 'server restarted while the run was live',
      completedAt: now,
    });
    if (!publication) continue;
    failed.push(run.id);
    if (run.contractId) {
      contracts.setVerification({
        id: run.contractId,
        verificationStatus: 'pending',
        verificationNotes: 'run lost to a server restart before finishing — re-dispatch or continue',
      });
    }
    console.warn(`[pc-sdk][boot-recovery] agent run ${run.id} (${run.podName}) was live — failed loudly (server-restart).`);
  }
  return failed;
}

/** Surface stranded isolation (active worktree rows with no live run). After
 *  the boot sweep above, NO run is live — so any active worktree belonging to
 *  an unlanded contract is reported. Reclamation stays a human/orchestrator
 *  decision; the branch always survives. */
function reportStrandedWorktrees(): string[] {
  try {
    const stranded = scanStrandedWorktrees(new Set());
    for (const w of stranded) {
      console.warn(`[pc-sdk][boot-recovery] stranded worktree ${w.name} at ${w.path} (${w.reason}).`);
    }
    return stranded.map((w) => w.name);
  } catch (err) {
    console.warn('[pc-sdk][boot-recovery] stranded-worktree scan failed:', err);
    return [];
  }
}
