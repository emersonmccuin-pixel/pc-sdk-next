// Projects HTTP — the @pc/contracts project API the web chrome speaks
// (projectRoutes). Wraps the @pc/db project repos + the create-flow folder
// probe. The old minimal `{name,slug,folderPath}` CRUD is gone (one path).

import { existsSync, readdirSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import type { Hono } from 'hono';
import {
  createProject,
  getProjectById,
  getProjectBySlug,
  listProjects,
  reorderProjects,
  setProjectFocus,
  softDeleteProjectConversationState,
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
import type { SessionRegistry } from '../chat/registry.ts';
import {
  requireRepositoryWorktreeRoot,
  RepositoryLeaseError,
  repositoryLeaseManager,
  type RepositoryLeaseGuard,
} from '../dispatch/repository-lease.ts';
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

export function mountProjects(app: Hono, deps: { registry: SessionRegistry }): void {
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
    let repositoryLease: RepositoryLeaseGuard;
    let folderPath: string;
    try {
      repositoryLease = await repositoryLeaseManager.acquireForProjectCreation(
        parsed.value.folder_path,
        parsed.value.mode,
      );
      folderPath = await requireRepositoryWorktreeRoot(parsed.value.folder_path);
      await repositoryLeaseManager.assertHeld(
        repositoryLease,
        folderPath,
        repositoryLease.identity,
      );
    } catch (error) {
      return c.json(
        {
          ok: false,
          error: error instanceof Error
            ? error.message
            : 'repository authority is unavailable',
        },
        repositoryCreationStatus(error),
      );
    }
    // Creation-mode Git effects complete under the live guard first; the row
    // then inserts with that exact immutable identity. An attach request can
    // never silently become init-in-place after the original probe.
    const project = createProject({
      name: parsed.value.name,
      slug: uniqueSlug(parsed.value.name),
      folderPath,
      repositoryIdentity: repositoryLease.identity,
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

  app.delete('/api/projects/:id', async (c) => {
    const projectId = c.req.param('id') as ULID;
    const result = softDeleteProjectConversationState(projectId);
    if (result.status === 'not-found') return c.json({ ok: false, error: 'not found' }, 404);
    if (result.status === 'active-turn') {
      return c.json({
        ok: false,
        error: 'interrupt the active turn and wait for confirmation before deleting the project',
      }, 409);
    }
    await deps.registry.disposeProject(projectId);
    return c.json({ ok: true, project: toProjectDto(result.project) });
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

  // Create-project folder browser — list immediate subdirectories of a path
  // (defaulting to the home dir) so the modal can offer a native-ish picker.
  // Read-only; never throws.
  app.post('/api/fs/list', async (c) => {
    const body = (await c.req.json().catch(() => ({}))) as Record<string, unknown>;
    const rawPath = typeof body.path === 'string' ? body.path.trim() : '';
    const path = resolve(rawPath || homedir());

    if (!existsSync(path)) return c.json({ ok: false, error: 'not found' }, 404);
    let isDirectory = false;
    try {
      isDirectory = statSync(path).isDirectory();
    } catch {
      isDirectory = false;
    }
    if (!isDirectory) return c.json({ ok: false, error: 'not a directory' }, 400);

    const parentPath = dirname(path);
    const parent = parentPath === path ? null : parentPath;

    let entries: { name: string; path: string; isGitRepo: boolean }[] = [];
    try {
      const dirents = readdirSync(path, { withFileTypes: true });
      entries = dirents
        .filter((d) => d.isDirectory())
        .map((d) => ({
          name: d.name,
          path: join(path, d.name),
          isGitRepo: existsSync(join(path, d.name, '.git')),
        }))
        .sort((a, b) => {
          const aHidden = a.name.startsWith('.');
          const bHidden = b.name.startsWith('.');
          if (aHidden !== bHidden) return aHidden ? 1 : -1;
          return a.name.localeCompare(b.name, undefined, { sensitivity: 'base' });
        })
        .slice(0, 1000);
    } catch {
      /* unreadable dir → empty, still navigable up */
    }

    return c.json({ ok: true, listing: { path, parent, entries } });
  });
}

function repositoryCreationStatus(error: unknown): 409 | 503 {
  if (error instanceof RepositoryLeaseError) {
    if (error.code === 'repository-occupied') return 409;
    if (error.reasonCode.startsWith('PROJECT_CREATION_')) return 409;
  }
  const code = typeof error === 'object' && error !== null && 'code' in error
    ? (error as { code?: unknown }).code
    : null;
  return code === 'PROJECT_PATH_NOT_REPOSITORY_ROOT' ? 409 : 503;
}
