// Boot recovery. On boot:
//  - chat: any active session whose last turn never terminated — a turn was in
//    flight when the process died — is closed out LOUDLY: persist exactly one
//    `turn-failed { source:'internal' }` then `session-state idle`.
//  - agent runs (premortem #5): every non-terminal run is failed loudly with
//    cause 'server-restart' (in-process runtime sessions do not survive a
//    restart), its open asks are cancelled, and its contract's verification is
//    parked 'pending' (the agent never finished — re-dispatch, don't reject).
//    EXCEPTION (doc Recovery: 'sealed commit present after process loss →
//    recover to verification/review'): a run that ITSELF delivered (its
//    deliveredAt stamp — not merely a contract deliverable, which a
//    continuation inherits from its parent) is SKIPPED here —
//    DispatchService.recoverSealedRuns (index.ts, before the pending-landing
//    re-drive) settles it completed and re-fires verification from that
//    durable evidence.
//    EXCEPTION (F1, comms-hardening): a run 'paused' on an open pending ask is
//    also SKIPPED here — failing it would cancel the ask and orphan it for
//    good. DispatchService.recoverPausedAsks (index.ts, AFTER attach)
//    re-mints a live session from the row's persisted native session id so
//    answering the ask later resumes it instead of 410ing.
//  - worktrees: classified AFTER the pending-landing re-drive (locked ordering
//    — re-driven landings must finish tearing down before classification), via
//    reconcileStrandedWorktreesAtBoot below. Stranded is durable on the row;
//    nothing is silently reclaimed.
// Never silently resume, never fake success. Idempotent.

import {
  commitConversationEvent,
  getActiveConversationTurn,
  getActiveOrchestratorSession,
  listConversationEvents,
  listNonTerminalAgentRuns,
  listOpenPendingAsksForProject,
  listProjects,
  markPendingAskCancelled,
  newId,
  recoverActiveConversationTurns,
} from '@pc/db';
import { AgentRunMutationGateway, ContractService } from '@pc/app-services';
import type { ChatEvent } from '@pc/contracts';
import { canTransition, type RunLifecycleState, type ULID } from '@pc/domain';
import { reconcileStrandedWorktrees, sweepOrphanedWorktreeDirs } from './dispatch/worktrees.ts';

const RESTART_ERROR = 'server restarted mid-turn';

/** True iff the session has a turn that started (user / session-state≠idle) with
 *  no later terminal (turn-end / turn-failed). */
function hasOpenTurn(sessionId: string): boolean {
  let lastTerminalSeq = 0;
  let lastOpenSeq = 0;
  for (const r of listConversationEvents(sessionId)) {
    if (r.eventType === 'turn-end' || r.eventType === 'turn-failed') {
      lastTerminalSeq = Math.max(lastTerminalSeq, r.sequence);
    } else if (r.eventType === 'user') {
      lastOpenSeq = Math.max(lastOpenSeq, r.sequence);
    } else if (r.eventType === 'session-state') {
      const state = (r.payload as { state?: string } | null)?.state;
      if (state && state !== 'idle') lastOpenSeq = Math.max(lastOpenSeq, r.sequence);
    }
  }
  return lastOpenSeq > lastTerminalSeq;
}

function append(sessionId: string, projectId: ULID, event: ChatEvent): void {
  commitConversationEvent({
    projectId,
    conversationId: sessionId,
    sessionId,
    family: 'control',
    event,
    itemId: newId(),
    occurredAt: Date.now(),
    deliveryKind: 'chat',
  });
}

export interface BootRecoveryResult {
  scanned: number;
  recovered: string[];
  failedRuns: string[];
}

/** Scan every project's active session; close out crashed turns. Returns the
 *  recovered session ids. */
export function runBootRecovery(): BootRecoveryResult {
  const recovered: string[] = [];
  const projects = listProjects();
  const activeSessions = projects.flatMap((project) => {
    const session = getActiveOrchestratorSession(project.id);
    if (!session) return [];
    return [{ project, session, durableTurnId: getActiveConversationTurn(session.id)?.id ?? null }];
  });
  const scanned = activeSessions.length;

  // The durable queue owns modern turn recovery: terminal + failed delivery +
  // interrupt settlement + idle commit atomically. Keep the historical event
  // scan below only for pre-CF-003 rows that have no conversation_turn record.
  const recoveredTurnIds = new Set(recoverActiveConversationTurns());
  for (const { project, session, durableTurnId } of activeSessions) {
    if (durableTurnId && recoveredTurnIds.has(durableTurnId)) {
      recovered.push(session.id);
      console.warn(
        `[pc-sdk][boot-recovery] session ${session.id} (project ${project.id}) had durable turn ${durableTurnId} in flight — ` +
          'settled failed with an uncertain-delivery receipt.',
      );
      continue;
    }
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
  return { scanned, recovered, failedRuns };
}

/** Fail every non-terminal agent run that did NOT itself deliver loudly
 *  (`server-restart`) — the live runtime session died with the process; a
 *  silent 'running' row would be a phantom. Open asks are cancelled; the
 *  contract parks at verification 'pending' (agent never finished ⇒
 *  re-dispatchable, not rejected — with a deliverable already on the contract
 *  the stranded scan treats the park as awaiting review, so nothing is
 *  misclassified). Runs whose OWN deliveredAt is stamped are left
 *  non-terminal for DispatchService.recoverSealedRuns (evidence-aware CASE 4:
 *  the process is gone but delivery is the done-signal — those runs settle
 *  completed and resume verification, never a blanket 'failed'). */
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
    // Per-run isolation: one bad row must never abort the sweep (or boot).
    try {
      // F1 (comms-hardening): a paused run's ask is durable (pending_asks
      // table) — failing the run and cancelling the ask would orphan it for
      // good. Leave it exactly as-is; DispatchService.recoverPausedAsks
      // (index.ts, AFTER attach) re-mints a live session from the row's
      // persisted native session id so `answerPendingAsk` resumes it instead
      // of 410ing on a dead in-process handle.
      if (run.status === 'paused') {
        console.warn(
          `[pc-sdk][boot-recovery] agent run ${run.id} (${run.podName}) is paused on a pending ask — left for DispatchService.recoverPausedAsks.`,
        );
        continue;
      }
      // Evidence-aware CASE 4: a sealed deliverable survives the process.
      // Keyed on THE RUN's own deliveredAt stamp, never the contract's
      // deliverable alone — a continuation carries its parent's contract
      // (deliverable included) forward, so a continuation that died
      // undelivered would otherwise hide behind the PARENT's seal and be
      // falsely settled 'completed' by sealed-run recovery. Defer the whole
      // run — settlement, verification, and even its open asks (an unresolved
      // ask must still block auto-land, guard 5) — to
      // DispatchService.recoverSealedRuns.
      if (run.deliveredAt !== null && run.contractId && contracts.get(run.contractId)?.deliverable != null) {
        console.warn(
          `[pc-sdk][boot-recovery] agent run ${run.id} (${run.podName}) was live with a SEALED deliverable — deferred to sealed-run recovery.`,
        );
        continue;
      }
      for (const askId of openAsksByRun.get(run.id) ?? []) markPendingAskCancelled(askId, now);
      // Lifecycle (worktree pipeline): no sealed evidence — the pipeline dies
      // with the process. 'failed' can be illegal from review/land states
      // stamped onto a still-live run (review-rejected/conflict/merged/
      // completed) — keep those as-is instead of throwing (mirrors killRun's
      // canTransition guard).
      let lifecycleState: RunLifecycleState | undefined;
      if (run.lifecycleState !== null && canTransition(run.lifecycleState, 'failed')) {
        lifecycleState = 'failed';
      }
      const publication = gateway.commitTerminal({
        runId: run.id,
        status: 'failed',
        result: null,
        failureCause: 'server-restart',
        failureReason: 'server restarted while the run was live',
        completedAt: now,
        ...(lifecycleState !== undefined ? { lifecycleState } : {}),
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
    } catch (err) {
      console.error(`[pc-sdk][boot-recovery] recovery failed for agent run ${run.id} — continuing with the rest:`, err);
    }
  }
  return failed;
}

/** Surface + durably record stranded isolation, then garbage-collect orphaned
 *  worktree DIRECTORIES. Called from index.ts AFTER recoverPendingLandings and
 *  BEFORE dispatch attaches (locked ordering) — re-driven landings tear their
 *  worktrees down first, and no dispatch can be mid-provision while the scan
 *  runs. After the boot sweep NO run is live, so a surviving active worktree
 *  goes durable 'stranded' — UNLESS its contract is awaiting review/landing
 *  (review-parked work is runless by design; its reclaim path is accept ⇒
 *  land ⇒ teardown, or abandonment). Reclamation stays a human/orchestrator
 *  decision; the branch is preserved for unlanded/abandoned work (deleted
 *  after a successful land).
 *
 *  The orphan sweep runs per project, right after reconcile (so a row this
 *  same pass just stranded is never mistaken for a keeper) — it deletes
 *  directories teardown's own removal couldn't (locked Windows binaries under
 *  a prior `pnpm install`'s node_modules), which the stranded scan above only
 *  ever flags, never reclaims. Never throws. */
export async function reconcileStrandedWorktreesAtBoot(): Promise<string[]> {
  let strandedNames: string[] = [];
  try {
    const { stranded, revived, resolved } = reconcileStrandedWorktrees();
    for (const w of stranded) {
      console.warn(`[pc-sdk][boot-recovery] stranded worktree ${w.name} at ${w.path} (${w.reason}) — row marked stranded.`);
    }
    for (const name of revived) {
      console.warn(`[pc-sdk][boot-recovery] stranded worktree ${name} self-healed — back to active.`);
    }
    for (const name of resolved) {
      console.warn(`[pc-sdk][boot-recovery] stranded worktree ${name} resolved — contract landed/abandoned, dir gone, row marked destroyed.`);
    }
    strandedNames = stranded.map((w) => w.name);
  } catch (err) {
    console.warn('[pc-sdk][boot-recovery] stranded-worktree scan failed:', err);
  }

  for (const project of listProjects()) {
    if (!project.folderPath) continue;
    try {
      const removed = await sweepOrphanedWorktreeDirs(project.folderPath);
      for (const name of removed) {
        console.warn(`[pc-sdk][boot-recovery] orphan sweep removed worktree dir ${name} (project ${project.id}).`);
      }
    } catch (err) {
      console.warn(`[pc-sdk][boot-recovery] orphan sweep failed for project ${project.id}:`, err);
    }
  }

  return strandedNames;
}
