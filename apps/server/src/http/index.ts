// HTTP surface — health, the @pc/contracts project + settings APIs (mounted
// from their own modules), sessions (new/resume/list + replay events),
// pasted-images upload, accounts + usage. Replay events return the SAME
// ChatFrame shape the WS live channel emits (docs/event-contract.md).

import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { Hono } from 'hono';
import {
  getConversationHighWaterSeq,
  getProjectById,
  listOrchestratorSessionsForProject,
  newId,
} from '@pc/db';
import { getDataDir } from '@pc/utils';
import type { ULID } from '@pc/domain';
import type { SessionRegistry } from '../chat/registry.ts';
import { replayFrames } from '../chat/replay.ts';
import { toSessionSummary } from './dto.ts';
import { mountProjects } from './projects.ts';
import { mountSettings } from './settings.ts';
import { mountAccounts } from './accounts.ts';
import type { AccountRegistry } from '../runner/account-env.ts';
import type { UsageCache } from '../usage/cache.ts';

export interface HttpDeps {
  registry: SessionRegistry;
  version?: string;
  /** Account switcher registry (accounts + usage endpoints mount when set). */
  accounts?: AccountRegistry;
  usage?: UsageCache;
}

const bootAt = Date.now();

const EXT_BY_MIME: Record<string, string> = {
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/jpg': 'jpg',
  'image/gif': 'gif',
  'image/webp': 'webp',
  'image/svg+xml': 'svg',
};

export function createHttpApp(deps: HttpDeps): Hono {
  const app = new Hono();

  app.get('/health', (c) =>
    c.json({ ok: true, name: '@pc-sdk/server', version: deps.version ?? '0.0.0', uptimeMs: Date.now() - bootAt }),
  );

  // ── Projects + settings (the @pc/contracts APIs the web chrome speaks) ───────
  mountProjects(app);
  mountSettings(app);

  // ── Sessions ────────────────────────────────────────────────────────────────
  app.get('/api/projects/:id/sessions', (c) => {
    const projectId = c.req.param('id') as ULID;
    if (!getProjectById(projectId)) return c.json({ ok: false, error: 'not found' }, 404);
    return c.json({
      ok: true,
      sessions: listOrchestratorSessionsForProject(projectId).map(toSessionSummary),
    });
  });

  app.post('/api/projects/:id/sessions/new', (c) => {
    const projectId = c.req.param('id') as ULID;
    if (!getProjectById(projectId)) return c.json({ ok: false, error: 'not found' }, 404);
    const session = deps.registry.get(projectId).startNewSession();
    return c.json({ ok: true, transition: 'new-session', session: toSessionSummary(session) }, 201);
  });

  app.post('/api/projects/:id/sessions/:sid/resume', (c) => {
    const projectId = c.req.param('id') as ULID;
    if (!getProjectById(projectId)) return c.json({ ok: false, error: 'not found' }, 404);
    const session = deps.registry.get(projectId).resumeSession(c.req.param('sid') as ULID);
    if (!session) return c.json({ ok: false, error: 'session not found' }, 404);
    return c.json({ ok: true, transition: 'resume-session', session: toSessionSummary(session) });
  });

  app.get('/api/projects/:id/sessions/:sid/events', (c) => {
    const projectId = c.req.param('id') as ULID;
    const sessionId = c.req.param('sid');
    return c.json({
      ok: true,
      events: replayFrames(projectId, sessionId),
      highWaterSeq: getConversationHighWaterSeq(sessionId),
    });
  });

  // ── Accounts + usage ────────────────────────────────────────────────────────
  if (deps.accounts) {
    mountAccounts(app, { accounts: deps.accounts, registry: deps.registry, usage: deps.usage });
  }

  // ── Pasted images ─────────────────────────────────────────────────────────
  // Multipart upload (field 'image') → file in the data dir → absolute path
  // spliced into send.text.
  app.post('/api/projects/:id/pasted-images', async (c) => {
    const projectId = c.req.param('id') as ULID;
    if (!getProjectById(projectId)) return c.json({ ok: false, error: 'not found' }, 404);
    const form = await c.req.parseBody().catch(() => ({}) as Record<string, unknown>);
    const file = form['image'];
    if (!(file instanceof File)) return c.json({ ok: false, error: 'image field required' }, 400);
    const mime = (file.type || 'application/octet-stream').split(';')[0].trim();
    const ext = EXT_BY_MIME[mime] ?? file.name.split('.').pop()?.toLowerCase() ?? 'bin';
    const bytes = new Uint8Array(await file.arrayBuffer());
    if (bytes.byteLength === 0) return c.json({ ok: false, error: 'empty body' }, 400);
    const dir = join(getDataDir(), 'pasted-images', projectId);
    mkdirSync(dir, { recursive: true });
    const path = join(dir, `${newId()}.${ext}`);
    writeFileSync(path, bytes);
    return c.json({ ok: true, path }, 201);
  });

  return app;
}
