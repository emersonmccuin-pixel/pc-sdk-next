// Agents HTTP — the global agent pool + per-project membership (gate-week
// agent system, definitions + management only; dispatch is Phase 3).
//
// Rules enforced here (route layer, D1-D3):
//   - Every created agent is scope='global', shareable — one pool, one path.
//   - The 6 stock specialists are locked (409 stock-locked); the orchestrator
//     row is editable EXCEPT its name (the chat path resolves by name).
//   - Stock agents are implicitly visible in every project — attach/detach on
//     them is refused (409) rather than silently no-oping.
//   - Every mutation announces a `specialist` frame so open rosters refetch.

import type { Hono } from 'hono';
import {
  addAgentToProject,
  createAgent,
  getAgentById,
  getProjectById,
  listAgentProjects,
  listAgents,
  listProjectVisibleAgents,
  removeAgentFromProject,
  softDeleteAgent,
  updateAgent,
} from '@pc/db';
import { parseCreatePodRequest, parseUpdatePodRequest } from '@pc/contracts';
import type { PodAgentRow, ULID } from '@pc/domain';
import { collectDriftedFields, getCanonicalSeed, resetAgentToSeed } from '../agents/seed.ts';
import { announceSpecialist, announceSpecialistToProject } from '../resources/specialist-writer.ts';

/** Roster row: the agent + the annotations the UI renders (Customized pill,
 *  attach toggles). driftedFields is null for user agents. */
export type AnnotatedPod = PodAgentRow & {
  driftedFields: string[] | null;
  memberProjectIds: ULID[];
};

function annotate(row: PodAgentRow): AnnotatedPod {
  const seed = row.origin === 'stock' ? getCanonicalSeed(row.name) : null;
  return {
    ...row,
    driftedFields: seed ? collectDriftedFields(row, seed) : null,
    memberProjectIds: listAgentProjects(row.id),
  };
}

function isUniqueViolation(err: unknown): boolean {
  return err instanceof Error && /UNIQUE constraint/i.test(err.message);
}

const audit = (reason: string) => ({ actor: 'user' as const, reason });

export function mountAgents(app: Hono): void {
  // The pool (no projectId) or a project's visible set (stock ∪ members).
  app.get('/api/agents/pods', (c) => {
    const projectId = c.req.query('projectId') as ULID | undefined;
    if (projectId && !getProjectById(projectId)) {
      return c.json({ ok: false, error: 'project not found' }, 404);
    }
    const rows = projectId ? listProjectVisibleAgents(projectId) : listAgents({ scope: 'global' });
    return c.json({ ok: true, pods: rows.map(annotate) });
  });

  app.get('/api/agents/pods/:id', (c) => {
    const row = getAgentById(c.req.param('id') as ULID);
    if (!row) return c.json({ ok: false, error: 'not found' }, 404);
    return c.json({ ok: true, pod: annotate(row) });
  });

  app.post('/api/agents/pods', async (c) => {
    const parsed = parseCreatePodRequest(await c.req.json().catch(() => ({})));
    if (!parsed.ok) return c.json({ ok: false, error: parsed.error }, 400);
    const input = parsed.value;
    if (input.attachProjectId && !getProjectById(input.attachProjectId as ULID)) {
      return c.json({ ok: false, error: 'attachProjectId: project not found' }, 404);
    }
    let row: PodAgentRow;
    try {
      row = createAgent(
        {
          name: input.name,
          scope: 'global',
          origin: 'user-created',
          shareable: true,
          description: input.description,
          prompt: input.prompt,
          model: input.model ?? null,
          effort: input.effort ?? null,
          maxTurns: input.maxTurns ?? null,
          tools: input.tools,
        },
        audit('ui-create'),
      );
    } catch (err) {
      if (isUniqueViolation(err)) return c.json({ ok: false, error: `an agent named '${input.name}' already exists` }, 400);
      throw err;
    }
    if (input.attachProjectId) {
      addAgentToProject(row.id, input.attachProjectId as ULID, audit('ui-create-attach'));
      announceSpecialistToProject(row.id, input.attachProjectId as ULID);
    }
    announceSpecialist(row.id);
    return c.json({ ok: true, pod: annotate(row) }, 201);
  });

  app.patch('/api/agents/pods/:id', async (c) => {
    const row = getAgentById(c.req.param('id') as ULID);
    if (!row) return c.json({ ok: false, error: 'not found' }, 404);
    const parsed = parseUpdatePodRequest(await c.req.json().catch(() => ({})));
    if (!parsed.ok) return c.json({ ok: false, error: parsed.error }, 400);
    if (row.origin === 'stock') {
      if (row.name !== 'orchestrator') {
        return c.json({ ok: false, error: 'stock-locked', kind: 'stock-locked' }, 409);
      }
      if (parsed.value.name !== undefined) {
        return c.json({ ok: false, error: 'the orchestrator cannot be renamed' }, 409);
      }
    }
    let updated: PodAgentRow | null;
    try {
      updated = updateAgent(row.id, parsed.value, audit('ui-update'));
    } catch (err) {
      if (isUniqueViolation(err)) return c.json({ ok: false, error: `an agent named '${parsed.value.name}' already exists` }, 400);
      throw err;
    }
    announceSpecialist(row.id);
    return c.json({ ok: true, pod: annotate(updated ?? row) });
  });

  app.delete('/api/agents/pods/:id', (c) => {
    const row = getAgentById(c.req.param('id') as ULID);
    if (!row) return c.json({ ok: false, error: 'not found' }, 404);
    if (row.origin === 'stock') {
      return c.json({ ok: false, error: 'built-in agents cannot be deleted', kind: 'stock-locked' }, 409);
    }
    softDeleteAgent(row.id, audit('ui-delete'));
    announceSpecialist(row.id);
    return c.json({ ok: true });
  });

  app.post('/api/agents/pods/:id/reset-to-default', (c) => {
    const row = getAgentById(c.req.param('id') as ULID);
    if (!row) return c.json({ ok: false, error: 'not found' }, 404);
    const resetFields = resetAgentToSeed(row);
    if (resetFields === null) {
      return c.json({ ok: false, error: 'not a built-in agent' }, 409);
    }
    announceSpecialist(row.id);
    const fresh = getAgentById(row.id);
    return c.json({ ok: true, pod: annotate(fresh ?? row), resetFields });
  });

  app.put('/api/agents/pods/:id/projects/:projectId', (c) => {
    const guard = membershipGuard(c.req.param('id'), c.req.param('projectId'));
    if ('error' in guard) return c.json({ ok: false, error: guard.error }, guard.status);
    addAgentToProject(guard.row.id, guard.projectId, audit('ui-attach'));
    announceSpecialistToProject(guard.row.id, guard.projectId);
    return c.json({ ok: true, memberProjectIds: listAgentProjects(guard.row.id) });
  });

  app.delete('/api/agents/pods/:id/projects/:projectId', (c) => {
    const guard = membershipGuard(c.req.param('id'), c.req.param('projectId'));
    if ('error' in guard) return c.json({ ok: false, error: guard.error }, guard.status);
    removeAgentFromProject(guard.row.id, guard.projectId, audit('ui-detach'));
    announceSpecialistToProject(guard.row.id, guard.projectId);
    return c.json({ ok: true, memberProjectIds: listAgentProjects(guard.row.id) });
  });
}

function membershipGuard(
  id: string,
  projectId: string,
): { row: PodAgentRow; projectId: ULID } | { error: string; status: 404 | 409 } {
  const row = getAgentById(id as ULID);
  if (!row) return { error: 'not found', status: 404 };
  if (!getProjectById(projectId as ULID)) return { error: 'project not found', status: 404 };
  if (row.origin === 'stock') {
    return { error: 'built-in agents are available in every project', status: 409 };
  }
  return { row, projectId: projectId as ULID };
}
