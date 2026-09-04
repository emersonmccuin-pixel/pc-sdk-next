// Projects HTTP — the @pc/contracts project API the web chrome speaks
// (projectRoutes). Wraps the @pc/db project repos + the create-flow folder
// probe. The old minimal `{name,slug,folderPath}` CRUD is gone (one path).

import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import type { Hono } from 'hono';
import {
  createProject,
  getActiveOrchestratorSession,
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
import { buildChildEnvironment } from '../operations/child-environment.ts';
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

  // Projects that currently hold a live orchestrator session (an active,
  // non-ended session row). Drives the rail's bright-vs-dim state on load;
  // "Close Session" ends a row, dropping the project out of this set.
  // Registered BEFORE /:id so it isn't captured by the :id param.
  app.get('/api/projects/live-sessions', (c) => {
    const projectIds = listProjects()
      .filter((p) => getActiveOrchestratorSession(p.id) !== null)
      .map((p) => p.id);
    return c.json({ ok: true, projectIds });
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

  // Open the project's folder in the OS file explorer. The path comes only
  // from the stored project row (never client input); the local server process
  // runs on the user's machine, so this hands off to the native shell.
  app.post('/api/projects/:id/reveal', (c) => {
    const project = getProjectById(c.req.param('id') as ULID);
    if (!project) return c.json({ ok: false, error: 'not found' }, 404);
    const folder = project.folderPath;
    if (!folder || !existsSync(folder)) {
      return c.json({ ok: false, error: `folder not found: ${folder ?? '(none)'}` }, 409);
    }
    try {
      revealInOsExplorer(folder);
    } catch (e) {
      return c.json({ ok: false, error: (e as Error).message }, 500);
    }
    return c.json({ ok: true });
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

  // Create-project folder browser — make a new subfolder inside the current
  // directory so the user can create a project folder without leaving the app.
  app.post('/api/fs/mkdir', async (c) => {
    const body = (await c.req.json().catch(() => ({}))) as Record<string, unknown>;
    const parentRaw = typeof body.path === 'string' ? body.path.trim() : '';
    const name = typeof body.name === 'string' ? body.name.trim() : '';
    if (!parentRaw) return c.json({ ok: false, error: 'path required' }, 400);
    if (!name) return c.json({ ok: false, error: 'name required' }, 400);
    // Reject path traversal and characters Windows forbids in folder names.
    if (name === '.' || name === '..' || /[<>:"/\\|?*]/.test(name) || name.endsWith('.')) {
      return c.json({ ok: false, error: 'invalid folder name' }, 400);
    }
    const parent = resolve(parentRaw);
    let parentIsDir = false;
    try {
      parentIsDir = statSync(parent).isDirectory();
    } catch {
      parentIsDir = false;
    }
    if (!parentIsDir) return c.json({ ok: false, error: 'parent folder not found' }, 404);
    const target = join(parent, name);
    if (existsSync(target)) return c.json({ ok: false, error: 'a folder with that name already exists' }, 409);
    try {
      mkdirSync(target);
    } catch (e) {
      return c.json({ ok: false, error: (e as Error).message }, 500);
    }
    return c.json({ ok: true, path: target });
  });
}

/** Hand a folder off to the native file explorer. Detached + unref so it never
 *  ties to the server lifecycle; spawn failures are swallowed (the HTTP request
 *  already returned) to avoid an unhandled ChildProcess error crashing the host.
 *  Windows takes a dedicated path — see revealWindowsFolder. */
function revealInOsExplorer(folder: string): void {
  if (process.platform === 'win32') {
    revealWindowsFolder(folder);
    return;
  }
  const [command, args]: [string, string[]] =
    process.platform === 'darwin' ? ['open', [folder]] : ['xdg-open', [folder]];
  // Sanitized OS-essential env only (no credentials leak to the shell handoff).
  const child = spawn(command, args, {
    detached: true,
    stdio: 'ignore',
    env: buildChildEnvironment(),
  });
  child.on('error', () => {
    /* best-effort: the request already returned; nothing to surface here */
  });
  child.unref();
}

/** Open (or reuse) a folder window and pull it to the FOREGROUND on Windows.
 *  A plain `explorer.exe <folder>` spawned by the background server process
 *  opens the window *behind* the active app — Windows forbids a non-foreground
 *  process from taking focus — so the user sees nothing (the original "reveal
 *  does nothing" bug: the folder opened, just never surfaced). This drives
 *  Windows PowerShell (always present under System32, no admin needed) to find
 *  an existing window for the path or open one via the Shell COM object, then
 *  lift the foreground lock with a synthetic ALT tap and raise it
 *  (restore + BringWindowToTop + SetForegroundWindow). The path is passed as a
 *  base64 UTF-16LE -EncodedCommand so no shell quoting can break or inject it. */
function revealWindowsFolder(folder: string): void {
  const psPath = `'${folder.replace(/'/g, "''")}'`;
  const script = [
    'Add-Type @"',
    'using System; using System.Runtime.InteropServices;',
    'public static class Fg {',
    '  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr h);',
    '  [DllImport("user32.dll")] public static extern bool ShowWindowAsync(IntPtr h, int c);',
    '  [DllImport("user32.dll")] public static extern bool BringWindowToTop(IntPtr h);',
    '  [DllImport("user32.dll")] public static extern void keybd_event(byte b, byte s, uint f, IntPtr e);',
    '}',
    '"@',
    `$Path = ${psPath}`,
    '$shell = New-Object -ComObject Shell.Application',
    'function Get-Hwnd($p) { foreach ($w in $shell.Windows()) { try { if ($w.Document.Folder.Self.Path -ieq $p) { return [IntPtr]$w.HWND } } catch {} } return [IntPtr]::Zero }',
    '$h = Get-Hwnd $Path',
    'if ($h -eq [IntPtr]::Zero) { $shell.Open($Path); Start-Sleep -Milliseconds 800; $h = Get-Hwnd $Path }',
    'if ($h -ne [IntPtr]::Zero) {',
    '  [Fg]::keybd_event(0x12,0,0,[IntPtr]::Zero)',
    '  [Fg]::keybd_event(0x12,0,2,[IntPtr]::Zero)',
    '  [void][Fg]::ShowWindowAsync($h, 9)',
    '  [void][Fg]::BringWindowToTop($h)',
    '  [void][Fg]::SetForegroundWindow($h)',
    '}',
  ].join('\n');
  const encoded = Buffer.from(script, 'utf16le').toString('base64');
  const child = spawn(
    'powershell.exe',
    ['-NoProfile', '-NonInteractive', '-WindowStyle', 'Hidden', '-EncodedCommand', encoded],
    // Sanitized OS-essential env only (no credentials leak to the shell handoff).
    { detached: true, stdio: 'ignore', windowsHide: true, env: buildChildEnvironment() },
  );
  child.on('error', () => {
    /* best-effort: the request already returned; nothing to surface here */
  });
  child.unref();
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
