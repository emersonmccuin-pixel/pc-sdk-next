// Agent-run HTTP surface — the routes the pc_* tool handlers and the web
// run views call. Thin: parse/guard here, semantics in DispatchService.
//
// Response shapes match the tool handlers' typed-client expectations
// (`{ ok, run }` with an AgentRunDto; `{ ok, pendingAsk }` with a
// PendingAskDto) and the web transcript client (`{ events, transcriptStatus,
// status }`).

import { Hono } from 'hono';
import {
  getAgentRunRow,
  getLiveEventHighWater,
  getPendingAsk,
  getProjectById,
  getReviewCheckoutForReviewer,
  listActiveAgentRunsForProject,
  listAgentRunsForSession,
  listConversationEvents,
  listPreservedTerminalAgentRuns,
  listProjectVisibleAgents,
  listRecentTerminalAgentRuns,
  listReviewCheckoutBlockingCandidates,
  listStrandedWorktrees,
} from '@pc/db';
import { ContractService, toAgentRunDto, toPendingAskDto } from '@pc/app-services';
import {
  parseApproveWorktreeAbandonmentRequest,
  parseAnswerPendingAskRequest,
  parseCreatePendingAskRequest,
  type ChatEvent,
} from '@pc/contracts';
import type { AgentRunRow, AgentRunStatus, ReviewCheckout, ULID } from '@pc/domain';
import type { DispatchService } from '../dispatch/service.ts';

const TERMINAL_LIST_WINDOW_MS = 24 * 60 * 60 * 1000;
const JSON_PARAMETER = /^[!#$%&'*+.^_`|~0-9a-z-]+\s*=\s*(?:"[^"\r\n]*"|[!#$%&'*+.^_`|~0-9a-z-]+)$/i;

function isJsonContentType(value: string | undefined): boolean {
  if (!value) return false;
  const [mediaType, ...parameters] = value.split(';');
  return mediaType?.trim().toLowerCase() === 'application/json' &&
    parameters.every((parameter) => JSON_PARAMETER.test(parameter.trim()));
}

export interface AgentRunsHttpDeps {
  dispatch: DispatchService;
}

export function mountAgentRuns(app: Hono, deps: AgentRunsHttpDeps): void {
  const { dispatch } = deps;
  const contracts = new ContractService();
  const blockingReviewCheckouts = (projectId: ULID): ReviewCheckout[] =>
    listReviewCheckoutBlockingCandidates().filter((checkout) => {
      if (checkout.projectId !== projectId) return false;
      if (checkout.status !== 'destroyed') return true;
      return contracts.get(checkout.contractId)?.reviewRunId === checkout.reviewerRunId;
    });

  const project = (c: { req: { param: (k: string) => string } }): ULID | null => {
    const id = c.req.param('id') as ULID;
    return getProjectById(id) ? id : null;
  };

  // ── dispatch doors ──────────────────────────────────────────────────────────

  app.post('/api/projects/:id/agents/:name/invoke', async (c) => {
    const projectId = project(c);
    if (!projectId) return c.json({ ok: false, error: 'not found' }, 404);
    const body = await c.req.json().catch(() => ({}) as Record<string, unknown>);
    const input = typeof body.input === 'string' ? body.input : '';
    const dispatcherSessionId = typeof body.dispatcherSessionId === 'string' ? body.dispatcherSessionId : '';
    if (!input.trim() || !dispatcherSessionId) {
      return c.json({ ok: false, error: 'input and dispatcherSessionId required' }, 400);
    }
    const result = await dispatch.dispatchFresh({
      projectId,
      agentName: c.req.param('name'),
      input,
      dispatcherSessionId,
      pmRef: typeof body.pmRef === 'string' ? body.pmRef : null,
      expectedOutput: body.expectedOutput,
      parentInvokeDepth: typeof body.parentInvokeDepth === 'number' ? body.parentInvokeDepth : 0,
    });
    if (!result.ok) return c.json({ ok: false, cause: result.cause, error: result.message }, result.httpStatus as 422);
    return c.json({ ok: true, mode: 'async', run: result.run }, 201);
  });

  app.post('/api/projects/:id/agent-runs/:runId/continue', async (c) => {
    const projectId = project(c);
    if (!projectId) return c.json({ ok: false, error: 'not found' }, 404);
    const body = await c.req.json().catch(() => ({}) as Record<string, unknown>);
    const input = typeof body.input === 'string' ? body.input : '';
    const dispatcherSessionId = typeof body.dispatcherSessionId === 'string' ? body.dispatcherSessionId : '';
    if (!input.trim() || !dispatcherSessionId) {
      return c.json({ ok: false, error: 'input and dispatcherSessionId required' }, 400);
    }
    const result = await dispatch.dispatchContinue({
      projectId,
      runId: c.req.param('runId') as ULID,
      input,
      dispatcherSessionId,
    });
    if (!result.ok) return c.json({ ok: false, cause: result.cause, error: result.message }, result.httpStatus as 409);
    return c.json({ ok: true, mode: 'async', run: result.run }, 201);
  });

  // ── run reads ───────────────────────────────────────────────────────────────

  /** Activity-rail feeder: non-terminal runs + state-based retention
   *  (docs/worktree-lifecycle.md 'Teardown and retention') — runs parked in a
   *  preserved lifecycle state (merge-ready, conflict, stranded,
   *  review-rejected, failed) stay listed until resolved; the 24h window
   *  applies only to uneventful terminal runs. */
  app.get('/api/projects/:id/agent-runs', (c) => {
    const projectId = project(c);
    if (!projectId) return c.json({ ok: false, error: 'not found' }, 404);
    const active = listActiveAgentRunsForProject(projectId);
    const preserved = listPreservedTerminalAgentRuns(projectId);
    const recent = listRecentTerminalAgentRuns(Date.now() - TERMINAL_LIST_WINDOW_MS).filter(
      (r) => r.projectId === projectId,
    );
    // Review-workspace cleanup is separate durable truth. Its exact reviewer
    // must remain inspectable even after the ordinary recent-terminal window
    // while that workspace still needs recovery.
    const reviewRecoveryRuns = blockingReviewCheckouts(projectId)
      .map((checkout) => getAgentRunRow(checkout.reviewerRunId))
      .filter((row): row is AgentRunRow => row !== null && row.projectId === projectId);
    const seen = new Set<string>();
    const rows = [...active, ...preserved, ...recent, ...reviewRecoveryRuns].filter((r) =>
      seen.has(r.id) ? false : (seen.add(r.id), true),
    );
    // Synchronous DB reads make this a consistent outbox boundary: any live
    // resource at-or-before this cursor was reflected in the retention query.
    // The browser uses it to reject an omitted stale terminal resource without
    // comparing clocks.
    const asOfCursor = getLiveEventHighWater();
    return c.json({ ok: true, runs: rows.map((r) => toAgentRunDto(r)), asOfCursor });
  });

  /** Workspace-owned detached-review evidence. Unresolved authority is never
   * age-bounded. Settled evidence follows the same recent-terminal window as
   * its reviewer transcript; the append-only row remains durable after it
   * leaves this browser projection. */
  app.get('/api/projects/:id/review-checkouts', (c) => {
    const projectId = project(c);
    if (!projectId) return c.json({ ok: false, error: 'not found' }, 404);
    const unresolved = blockingReviewCheckouts(projectId);
    const recent = listRecentTerminalAgentRuns(Date.now() - TERMINAL_LIST_WINDOW_MS)
      .filter((row) => row.projectId === projectId)
      .map((row) => getReviewCheckoutForReviewer(row.id))
      .filter((checkout): checkout is ReviewCheckout =>
        checkout !== null && checkout.projectId === projectId,
      );
    const seen = new Set<string>();
    const reviewCheckouts = [...unresolved, ...recent].filter((checkout) =>
      seen.has(checkout.id) ? false : (seen.add(checkout.id), true),
    );
    return c.json({ ok: true, reviewCheckouts });
  });

  /** pc_list_my_runs — scoped to the dispatcher session. */
  app.get('/api/projects/:id/agent-runs/by-dispatcher', (c) => {
    const projectId = project(c);
    if (!projectId) return c.json({ ok: false, error: 'not found' }, 404);
    const dispatcherSessionId = c.req.query('dispatcherSessionId') ?? '';
    if (!dispatcherSessionId) return c.json({ ok: false, error: 'dispatcherSessionId required' }, 400);
    const limitRaw = Number(c.req.query('limit') ?? 20);
    const rows = listAgentRunsForSession(projectId, dispatcherSessionId, {
      podName: c.req.query('agentName') || undefined,
      status: (c.req.query('status') as AgentRunStatus | undefined) || undefined,
      limit: Number.isFinite(limitRaw) ? Math.min(Math.max(1, Math.floor(limitRaw)), 100) : 20,
    });
    return c.json({
      ok: true,
      runs: rows.map((r) => ({
        runId: r.id,
        agentName: r.podName,
        status: r.status,
        dispatchedAt: r.queuedAt,
        completedAt: r.completedAt,
        summary: r.result ? r.result.slice(0, 200) : (r.failureReason ?? null),
        continues: r.continues,
      })),
    });
  });

  /** pc_inspect_agent_run — live-vs-wedged peek. */
  app.get('/api/projects/:id/agent-runs/:runId/inspect', (c) => {
    const projectId = project(c);
    if (!projectId) return c.json({ ok: false, error: 'not found' }, 404);
    const row = getAgentRunRow(c.req.param('runId') as ULID);
    if (!row || row.projectId !== projectId) return c.json({ ok: false, error: 'run not found' }, 404);
    const events = listConversationEvents(row.id);
    const last = events.length > 0 ? events[events.length - 1] : null;
    const lastAt = last ? last.occurredAt : row.queuedAt;
    return c.json({
      ok: true,
      inspection: {
        runId: row.id,
        agentName: row.podName,
        status: row.status,
        live: dispatch.hasLiveRun(row.id),
        lastActivityAt: lastAt,
        idleMs: Date.now() - lastAt,
        lastAction: last ? last.eventType : null,
        contractId: row.contractId,
        worktreeDir: row.worktreeDir,
        failureCause: row.failureCause,
        failureReason: row.failureReason,
      },
    });
  });

  app.post('/api/projects/:id/agent-runs/:runId/kill', async (c) => {
    const projectId = project(c);
    if (!projectId) return c.json({ ok: false, error: 'not found' }, 404);
    const result = await dispatch.killRun(projectId, c.req.param('runId') as ULID);
    if (!result.ok) return c.json({ ok: false, error: result.message }, result.httpStatus as 404);
    const row = getAgentRunRow(c.req.param('runId') as ULID);
    return c.json({ ok: true, status: row?.status ?? 'cancelled', alreadyTerminal: result.alreadyTerminal });
  });

  /** Transcript backfill for the run modal (docs/event-contract.md shape). */
  app.get('/api/projects/:id/agent-runs/:runId/events', (c) => {
    const projectId = project(c);
    if (!projectId) return c.json({ ok: false, error: 'not found' }, 404);
    const row = getAgentRunRow(c.req.param('runId') as ULID);
    if (!row || row.projectId !== projectId) return c.json({ ok: false, error: 'run not found' }, 404);
    const events = listConversationEvents(row.id).map((r) => ({
      dedupId: r.eventId,
      event: r.payload as ChatEvent,
    }));
    return c.json({
      events,
      transcriptStatus: events.length > 0 ? 'ready' : 'empty',
      status: row.status,
    });
  });

  /** Stranded isolation read (docs/worktree-lifecycle.md 'Recovery') — the
   *  boot scan's durable output. Read-only; recovery/UI are later slices. */
  app.get('/api/projects/:id/worktrees/stranded', (c) => {
    const projectId = project(c);
    if (!projectId) return c.json({ ok: false, error: 'not found' }, 404);
    return c.json({
      ok: true,
      worktrees: listStrandedWorktrees(projectId).map((w) => ({
        id: w.id,
        name: w.name,
        path: w.path,
        branch: w.branch,
        baseBranch: w.baseBranch,
        agentRunId: w.agentRunId,
        contractId: w.contractId,
        strandedReason: w.strandedReason,
        strandedAt: w.strandedAt,
      })),
    });
  });

  // ── contract doors ──────────────────────────────────────────────────────────

  /** Contract list (contractRoutes.forProject) — the web read. Full DTOs:
   *  merge receipt, landingPolicy, verificationNotes ride along. Newest
   *  first. Shape: ListContractsResponse. */
  app.get('/api/projects/:id/contracts', (c) => {
    const projectId = project(c);
    if (!projectId) return c.json({ ok: false, error: 'not found' }, 404);
    return c.json({ ok: true, contracts: contracts.listByProject(projectId) });
  });

  /** Contract detail (contractRoutes.detail). Shape: ContractDetailResponse. */
  app.get('/api/contracts/:contractId', (c) => {
    const contract = contracts.get(c.req.param('contractId') as ULID);
    if (!contract) return c.json({ ok: false, error: 'contract not found' }, 404);
    return c.json({ ok: true, contract });
  });

  /** pc_get_contract — the worker reads its OWN contract. */
  app.get('/api/projects/:id/agent-runs/:runId/contract', (c) => {
    const projectId = project(c);
    if (!projectId) return c.json({ ok: false, error: 'not found' }, 404);
    const row = getAgentRunRow(c.req.param('runId') as ULID);
    if (!row || row.projectId !== projectId) return c.json({ ok: false, error: 'run not found' }, 404);
    if (!row.contractId) return c.json({ ok: false, error: 'run has no contract' }, 404);
    const contract = contracts.get(row.contractId);
    if (!contract) return c.json({ ok: false, error: 'contract missing' }, 404);
    return c.json({
      ok: true,
      contract: {
        id: contract.id,
        status: contract.status,
        pmRef: contract.pmRef,
        expectedOutput: contract.expectedOutput,
        acceptanceCriteria: contract.acceptanceCriteria,
        verificationTier: contract.verificationTier,
        verificationStatus: contract.verificationStatus,
        deliverable: contract.deliverable,
        report: contract.report,
      },
    });
  });

  /** pc_submit_deliverable — the sole done-signal. */
  app.post('/api/projects/:id/agent-runs/:runId/deliverable', async (c) => {
    const projectId = project(c);
    if (!projectId) return c.json({ ok: false, error: 'not found' }, 404);
    const body = await c.req.json().catch(() => ({}) as Record<string, unknown>);
    const deliverable =
      body.deliverable && typeof body.deliverable === 'object' && !Array.isArray(body.deliverable)
        ? (body.deliverable as Record<string, unknown>)
        : null;
    if (!deliverable) return c.json({ ok: false, error: 'deliverable object required' }, 400);
    const result = await dispatch.submitDeliverable({
      projectId,
      agentRunId: c.req.param('runId') as ULID,
      deliverable,
      report: typeof body.report === 'string' ? body.report : null,
    });
    if (!result.ok) return c.json({ ok: false, error: result.message }, result.httpStatus as 409);
    return c.json({
      ok: true,
      contract: { id: result.contract.id, status: result.contract.status },
      message: 'deliverable captured — it will be verified against your acceptance criteria when your run ends',
    });
  });

  /** pc_get_deliverable — orchestrator read door. */
  app.get('/api/projects/:id/contracts/:contractId/deliverable', (c) => {
    const projectId = project(c);
    if (!projectId) return c.json({ ok: false, error: 'not found' }, 404);
    const contract = contracts.get(c.req.param('contractId') as ULID);
    if (!contract || contract.projectId !== projectId) return c.json({ ok: false, error: 'contract not found' }, 404);
    return c.json({
      ok: true,
      deliverable: contract.deliverable,
      report: contract.report,
      status: contract.status,
      verificationStatus: contract.verificationStatus,
      verificationNotes: contract.verificationNotes,
      landingStatus: contract.landingStatus,
      expectedOutput: contract.expectedOutput,
    });
  });

  /** pc_review_contract — tier-2 sign-off (accept ⇒ land for repo). */
  app.post('/api/projects/:id/contracts/:contractId/review', async (c) => {
    const projectId = project(c);
    if (!projectId) return c.json({ ok: false, error: 'not found' }, 404);
    const body = await c.req.json().catch(() => ({}) as Record<string, unknown>);
    const verdict = body.verdict === 'accept' || body.verdict === 'reject' ? body.verdict : null;
    if (!verdict) return c.json({ ok: false, error: "verdict must be 'accept' or 'reject'" }, 400);
    const result = await dispatch.reviewContract({
      projectId,
      contractId: c.req.param('contractId') as ULID,
      verdict,
      notes: typeof body.notes === 'string' ? body.notes : null,
    });
    if (!result.ok) return c.json({ ok: false, error: result.message }, result.httpStatus as 409);
    return c.json({
      ok: true,
      contract: {
        id: result.contract.id,
        status: result.contract.status,
        verificationStatus: result.contract.verificationStatus,
        landingStatus: result.contract.landingStatus,
        landingError: result.contract.landingError,
      },
    });
  });

  // Browser-only destructive authority surface. Fetch metadata is CSRF
  // hardening within the trusted-local-process boundary; no pc_*/MCP tool
  // exposes these verbs.
  app.get('/api/projects/:id/contracts/:contractId/abandonment-preview', async (c) => {
    c.header('Cache-Control', 'no-store');
    const projectId = project(c);
    if (!projectId) return c.json({ ok: false, error: 'not found' }, 404);
    if (c.req.header('Sec-Fetch-Site') !== 'same-origin') {
      return c.json({ ok: false, error: 'same-origin browser action required' }, 403);
    }
    const result = await dispatch.previewContractAbandonment({
      projectId,
      contractId: c.req.param('contractId') as ULID,
    });
    if (!result.ok) {
      return c.json({ ok: false, error: result.message }, result.httpStatus as 409);
    }
    return c.json({ ok: true, preview: result.preview });
  });

  app.post('/api/projects/:id/contracts/:contractId/abandonment', async (c) => {
    c.header('Cache-Control', 'no-store');
    const projectId = project(c);
    if (!projectId) return c.json({ ok: false, error: 'not found' }, 404);
    if (c.req.header('Sec-Fetch-Site') !== 'same-origin') {
      return c.json({ ok: false, error: 'same-origin browser action required' }, 403);
    }
    if (!isJsonContentType(c.req.header('Content-Type'))) {
      return c.json({ ok: false, error: 'application/json required' }, 400);
    }
    const parsed = parseApproveWorktreeAbandonmentRequest(
      await c.req.json().catch(() => null),
    );
    if (!parsed.ok) return c.json({ ok: false, error: parsed.error }, 400);
    const result = await dispatch.approveContractAbandonment({
      projectId,
      contractId: c.req.param('contractId') as ULID,
      request: parsed.value,
    });
    if (!result.ok) {
      return c.json({ ok: false, error: result.message }, result.httpStatus as 409);
    }
    return c.json(
      {
        ok: true,
        settlement: result.settlement,
        contract: result.contract,
      },
      result.settlement === 'completed' ? 200 : 202,
    );
  });

  // ── ask doors ───────────────────────────────────────────────────────────────

  app.post('/api/projects/:id/agent-pending-asks', async (c) => {
    const projectId = project(c);
    if (!projectId) return c.json({ ok: false, error: 'not found' }, 404);
    const body = await c.req.json().catch(() => ({}) as Record<string, unknown>);
    const parsed = parseCreatePendingAskRequest(body);
    if (!parsed.ok) return c.json({ ok: false, error: parsed.error }, 400);
    const result = dispatch.createPendingAsk({
      projectId,
      agentRunId: parsed.value.agentRunId as ULID,
      kind: parsed.value.kind,
      promptBody: parsed.value.promptBody,
      context: parsed.value.context ?? null,
      options: parsed.value.options ?? null,
    });
    if (!result.ok) return c.json({ ok: false, error: result.message }, result.httpStatus as 409);
    const ask = getPendingAsk(result.pendingAskId);
    if (!ask) return c.json({ ok: false, error: 'pending ask persistence failed' }, 500);
    return c.json(
      {
        ok: true,
        pendingAsk: toPendingAskDto(ask),
        status: 'waiting',
        message: 'run paused — end your turn now; the answer arrives as your next message',
      },
      201,
    );
  });

  app.post('/api/projects/:id/agent-pending-asks/:askId/answer', async (c) => {
    const projectId = project(c);
    if (!projectId) return c.json({ ok: false, error: 'not found' }, 404);
    const body = await c.req.json().catch(() => ({}) as Record<string, unknown>);
    const parsed = parseAnswerPendingAskRequest(body);
    if (!parsed.ok) return c.json({ ok: false, error: parsed.error }, 400);
    const result = await dispatch.answerPendingAsk({
      projectId,
      pendingAskId: c.req.param('askId') as ULID,
      answer: parsed.value.answer,
      answeredBy: parsed.value.answeredBy,
    });
    if (!result.ok) return c.json({ ok: false, error: result.message }, result.httpStatus as 409);
    const ask = getPendingAsk(c.req.param('askId') as ULID);
    if (!ask) return c.json({ ok: false, error: 'pending ask persistence failed' }, 500);
    return c.json({ ok: true, pendingAsk: toPendingAskDto(ask) });
  });

  // ── roster read (pc_list_agents) ────────────────────────────────────────────

  app.get('/api/projects/:id/agents', (c) => {
    const projectId = project(c);
    if (!projectId) return c.json({ ok: false, error: 'not found' }, 404);
    const agents = listProjectVisibleAgents(projectId)
      .filter((a) => a.name !== 'orchestrator')
      .map((a) => ({
        name: a.name,
        description: a.description,
        dispatchGuidance: a.dispatchGuidance,
        model: a.model,
        origin: a.origin,
        expectedOutput: a.expectedOutput,
      }));
    return c.json({ ok: true, agents });
  });
}
