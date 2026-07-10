// Projects HTTP — the @pc/contracts project API the web chrome speaks
// (projectRoutes). Wraps the @pc/db project repos + the create-flow folder
// probe. The old minimal `{name,slug,folderPath}` CRUD is gone (one path).

import { existsSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import type { Hono } from 'hono';
import {
  createProject,
  getProjectById,
  getProjectBySlug,
  listProjects,
  reorderProjects,
  setProjectFocus,
  softDeleteProject,
  updateProjectMeta,
  updateProjectNotes,
} from '@pc/db';
import {
  COMMAND_PROJECT_SLUG,
  parseCreateProjectRequest,
  parseReorderProjectsRequest,
  parseUpdateProjectRequest,
} from '@pc/contracts';
import type { ULID } from '@pc/domain';
import { toProjectDto } from './dto.ts';

function slugify(name: string): string {
  return (
    name
      .toLowerCase()
      .trim()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '') || `project-${Date.now()}`
  );
}

/** A slug free of the Command reservation and any live project. */
function uniqueSlug(name: string): string {
  const base = slugify(name) === COMMAND_PROJECT_SLUG ? `${slugify(name)}-project` : slugify(name);
  let slug = base;
  let n = 2;
  while (getProjectBySlug(slug)) slug = `${base}-${n++}`;
  return slug;
}

export function mountProjects(app: Hono): void {
  app.get('/api/projects', (c) => {
    const includeDeleted = c.req.query('include_deleted') === '1';
    return c.json({ projects: listProjects({ includeDeleted }).map(toProjectDto) });
  });

  // Register /reorder BEFORE /:id so it isn't captured by the :id param.
  app.patch('/api/projects/reorder', async (c) => {
    const body = await c.req.json().catch(() => ({}));
    const parsed = parseReorderProjectsRequest(body);
    if (!parsed.ok) return c.json({ ok: false, error: parsed.error }, 400);
    reorderProjects(parsed.value.orderedIds as ULID[]);
    return c.json({ ok: true, projects: listProjects().map(toProjectDto) });
  });

  app.post('/api/projects', async (c) => {
    const body = await c.req.json().catch(() => ({}));
    const parsed = parseCreateProjectRequest(body);
    if (!parsed.ok) return c.json({ ok: false, error: parsed.error }, 400);
    // Phase 2 creates the project row over an existing (probed) folder. Git
    // scaffolding per `mode` is deferred — the folder is adopted as-is.
    const project = createProject({
      name: parsed.value.name,
      slug: uniqueSlug(parsed.value.name),
      folderPath: parsed.value.folder_path,
      gitRemote: parsed.value.git_remote ?? null,
    });
    return c.json({ ok: true, project: toProjectDto(project) }, 201);
  });

  app.get('/api/projects/:id', (c) => {
    const project = getProjectById(c.req.param('id') as ULID);
    if (!project) return c.json({ ok: false, error: 'not found' }, 404);
    return c.json(toProjectDto(project));
  });

  app.patch('/api/projects/:id', async (c) => {
    const id = c.req.param('id') as ULID;
    if (!getProjectById(id)) return c.json({ ok: false, error: 'not found' }, 404);
    const body = await c.req.json().catch(() => ({}));
    const parsed = parseUpdateProjectRequest(body);
    if (!parsed.ok) return c.json({ ok: false, error: parsed.error }, 400);
    const updated = updateProjectMeta(id, parsed.value);
    if (!updated) return c.json({ ok: false, error: 'not found' }, 404);
    return c.json({ ok: true, project: toProjectDto(updated) });
  });

  app.delete('/api/projects/:id', (c) => {
    const deleted = softDeleteProject(c.req.param('id') as ULID);
    if (!deleted) return c.json({ ok: false, error: 'not found' }, 404);
    return c.json({ ok: true, project: toProjectDto(deleted) });
  });

  app.patch('/api/projects/:id/notes', async (c) => {
    const id = c.req.param('id') as ULID;
    const body = (await c.req.json().catch(() => ({}))) as Record<string, unknown>;
    const text = typeof body.text === 'string' ? body.text : '';
    const updated = updateProjectNotes(id, text);
    if (!updated) return c.json({ ok: false, error: 'not found' }, 404);
    return c.json({ ok: true, notes: updated.notes });
  });

  // Command focus — star/unstar. The web posts { kind:'project', id, focused }.
  app.post('/api/focus', async (c) => {
    const body = (await c.req.json().catch(() => ({}))) as Record<string, unknown>;
    if (body.kind !== 'project' || typeof body.id !== 'string') {
      return c.json({ ok: false, error: 'kind:project + id required' }, 400);
    }
    const updated = setProjectFocus(body.id as ULID, body.focused === true);
    if (!updated) return c.json({ ok: false, error: 'not found' }, 404);
    return c.json({ ok: true, project: toProjectDto(updated) });
  });

  // Create-project folder probe — classify a target dir (empty / has-files /
  // git-repo) so the modal can derive the create mode. Read-only.
  app.post('/api/fs/probe', async (c) => {
    const body = (await c.req.json().catch(() => ({}))) as Record<string, unknown>;
    const path = typeof body.path === 'string' ? body.path.trim() : '';
    if (!path) return c.json({ ok: false, error: 'path required' }, 400);

    const exists = existsSync(path);
    let isDirectory = false;
    let hasFiles = false;
    let fileCount = 0;
    let isGitRepo = false;
    if (exists) {
      try {
        isDirectory = statSync(path).isDirectory();
      } catch {
        isDirectory = false;
      }
      if (isDirectory) {
        try {
          const entries = readdirSync(path);
          fileCount = entries.length;
          hasFiles = entries.length > 0;
          isGitRepo = existsSync(join(path, '.git'));
        } catch {
          /* unreadable dir → treat as empty, non-git */
        }
      }
    }
    return c.json({ ok: true, probe: { path, exists, isDirectory, hasFiles, fileCount, isGitRepo } });
  });
}
