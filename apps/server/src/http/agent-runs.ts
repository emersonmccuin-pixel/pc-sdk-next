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
  getPendingAsk,
  getProjectById,
  listActiveAgentRunsForProject,
  listAgentRunsForSession,
  listConversationEvents,
  listProjectVisibleAgents,
  listRecentTerminalAgentRuns,
} from '@pc/db';
import { ContractService, toAgentRunDto, toPendingAskDto } from '@pc/app-services';
import type { ChatEvent } from '@pc/contracts';
import type { AgentRunStatus, PendingAskOption, ULID } from '@pc/domain';
import type { DispatchService } from '../dispatch/service.ts';

const TERMINAL_LIST_WINDOW_MS = 24 * 60 * 60 * 1000;

export interface AgentRunsHttpDeps {
  dispatch: DispatchService;
}

export function mountAgentRuns(app: Hono, deps: AgentRunsHttpDeps): void {
  const { dispatch } = deps;
  const contracts = new ContractService();

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

  /** Activity-rail feeder: non-terminal runs + a recent terminal window. */
  app.get('/api/projects/:id/agent-runs', (c) => {
    const projectId = project(c);
    if (!projectId) return c.json({ ok: false, error: 'not found' }, 404);
    const active = listActiveAgentRunsForProject(projectId);
    const recent = listRecentTerminalAgentRuns(Date.now() - TERMINAL_LIST_WINDOW_MS).filter(
      (r) => r.projectId === projectId,
    );
    return c.json({ ok: true, runs: [...active, ...recent].map((r) => toAgentRunDto(r)) });
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
    const lastAt = last ? last.createdAt : row.queuedAt;
    return c.json({
      ok: true,
      inspection: {
        runId: row.id,
        agentName: row.podName,
        status: row.status,
        live: dispatch.hasLiveRun(row.id),
        lastActivityAt: lastAt,
        idleMs: Date.now() - lastAt,
        lastAction: last ? last.kind : null,
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
      dedupId: `${row.id}:${r.seq}`,
      event: r.event as ChatEvent,
    }));
    return c.json({
      events,
      transcriptStatus: events.length > 0 ? 'ready' : 'empty',
      status: row.status,
    });
  });

  // ── contract doors ──────────────────────────────────────────────────────────

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

  // ── ask doors ───────────────────────────────────────────────────────────────

  app.post('/api/projects/:id/agent-pending-asks', async (c) => {
    const projectId = project(c);
    if (!projectId) return c.json({ ok: false, error: 'not found' }, 404);
    const body = await c.req.json().catch(() => ({}) as Record<string, unknown>);
    const agentRunId = typeof body.agentRunId === 'string' ? (body.agentRunId as ULID) : null;
    const kind = body.kind === 'approval' ? 'approval' : body.kind === 'orchestrator' ? 'orchestrator' : null;
    const promptBody = typeof body.promptBody === 'string' ? body.promptBody : '';
    if (!agentRunId || !kind || !promptBody.trim()) {
      return c.json({ ok: false, error: 'agentRunId, kind, promptBody required' }, 400);
    }
    const options = Array.isArray(body.options)
      ? ((body.options as unknown[])
          .map((o) => (typeof o === 'string' ? { label: o, value: o } : (o as PendingAskOption)))
          .filter((o) => o && typeof o.label === 'string') as PendingAskOption[])
      : null;
    const result = dispatch.createPendingAsk({
      projectId,
      agentRunId,
      kind,
      promptBody,
      context: typeof body.context === 'string' ? body.context : null,
      options,
    });
    if (!result.ok) return c.json({ ok: false, error: result.message }, result.httpStatus as 409);
    const ask = getPendingAsk(result.pendingAskId);
    return c.json(
      {
        ok: true,
        pendingAsk: ask ? toPendingAskDto(ask) : { id: result.pendingAskId },
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
    const answer = typeof body.answer === 'string' ? body.answer : '';
    const answeredBy = body.answeredBy === 'user' ? 'user' : 'orchestrator';
    if (!answer.trim()) return c.json({ ok: false, error: 'answer required' }, 400);
    const result = dispatch.answerPendingAsk({
      projectId,
      pendingAskId: c.req.param('askId') as ULID,
      answer,
      answeredBy,
    });
    if (!result.ok) return c.json({ ok: false, error: result.message }, result.httpStatus as 409);
    const ask = getPendingAsk(c.req.param('askId') as ULID);
    return c.json({ ok: true, pendingAsk: ask ? toPendingAskDto(ask) : null });
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
