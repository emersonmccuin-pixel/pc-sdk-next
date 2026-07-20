// HTTP surface — health, the @pc/contracts project + settings APIs (mounted
// from their own modules), sessions (new/resume/list + replay events),
// pasted-images upload, accounts + subscription quota. Replay events return the SAME
// canonical conversation-event shape the WS live channel emits.

import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { Hono } from 'hono';
import {
  getConversationHighWaterSequence,
  getOrchestratorSession,
  getProjectById,
  listOrchestratorSessionsForProject,
  newId,
} from '@pc/db';
import { getDataDir } from '@pc/utils';
import type { ULID } from '@pc/domain';
import type { SessionRegistry } from '../chat/registry.ts';
import { replayConversationEvents } from '../chat/replay.ts';
import { toSessionSummary } from './dto.ts';
import { mountAgents } from './agents.ts';
import { mountAgentRuns } from './agent-runs.ts';
import { mountProjects } from './projects.ts';
import { mountSettings } from './settings.ts';
import { mountAccounts } from './accounts.ts';
import { mountRuntimes } from './runtimes.ts';
import type { AccountRegistry } from '../runner/account-env.ts';
import type { DispatchService } from '../dispatch/service.ts';
import type { SubscriptionQuotaService } from '@pc/app-services';
import {
  RuntimeSelectionRejectedError,
  type RuntimeRegistry,
  type RuntimeSelectionValidation,
} from '../runner/runtime.ts';

export interface HttpDeps {
  registry: SessionRegistry;
  version?: string;
  instanceId?: string;
  /** Account switcher registry (accounts + quota endpoints mount when set). */
  accounts?: AccountRegistry;
  orchestratorRuntimeId?: string;
  /** Registered runtime adapters (/api/runtimes mounts when accounts is also set). */
  runtimes?: RuntimeRegistry;
  subscriptionQuota?: SubscriptionQuotaService;
  /** Phase-3 dispatch — agent-run routes mount when set (tests may omit). */
  dispatch?: DispatchService;
  /** In-app engine restart (Settings → Restart engine). The composition root
   *  owns the mechanics (close + self-respawn); absent ⇒ route returns 501. */
  onRestartRequest?: () => void;
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
    c.json({
      ok: true,
      name: '@pc-sdk/server',
      instanceId: deps.instanceId ?? 'pc-sdk-next',
      version: deps.version ?? '0.0.0',
      uptimeMs: Date.now() - bootAt,
    }),
  );

  // ── Engine restart (Settings button) ────────────────────────────────────────
  // Respond first, then hand off to the composition root, which closes the
  // listener, respawns the same process, and exits. The web client polls
  // /health and reloads when the new process is up.
  app.post('/api/admin/restart', (c) => {
    if (!deps.onRestartRequest) return c.json({ ok: false, error: 'restart not available' }, 501);
    setTimeout(() => deps.onRestartRequest?.(), 150);
    return c.json({ ok: true, restarting: true });
  });

  // ── Projects + settings (the @pc/contracts APIs the web chrome speaks) ───────
  mountProjects(app, { registry: deps.registry });
  mountSettings(app);
  mountAgents(app);
  if (deps.dispatch) mountAgentRuns(app, { dispatch: deps.dispatch });

  // ── Sessions ────────────────────────────────────────────────────────────────
  app.get('/api/projects/:id/sessions', async (c) => {
    const projectId = c.req.param('id') as ULID;
    if (!getProjectById(projectId)) return c.json({ ok: false, error: 'not found' }, 404);
    const service = deps.registry.get(projectId);
    const preflightCache = new Map<string, Promise<RuntimeSelectionValidation>>();
    const sessions = await Promise.all(
      listOrchestratorSessionsForProject(projectId).map(async (session) =>
        toSessionSummary(
          session,
          await service.resumeAvailabilityCode(session, preflightCache),
        ),
      ),
    );
    return c.json({
      ok: true,
      sessions,
    });
  });

  app.post('/api/projects/:id/sessions/new', async (c) => {
    const projectId = c.req.param('id') as ULID;
    if (!getProjectById(projectId)) return c.json({ ok: false, error: 'not found' }, 404);
    const service = deps.registry.get(projectId);
    if (!service.canSwitchSession()) {
      return c.json({ ok: false, error: 'interrupt the active turn and wait for confirmation before switching sessions' }, 409);
    }
    try {
      const session = await service.startNewSession();
      return c.json({ ok: true, transition: 'new-session', session: toSessionSummary(session) }, 201);
    } catch (error) {
      if (error instanceof RuntimeSelectionRejectedError) {
        return c.json({ ok: false, error: { code: error.code } }, 422);
      }
      throw error;
    }
  });

  app.post('/api/projects/:id/sessions/:sid/resume', async (c) => {
    const projectId = c.req.param('id') as ULID;
    if (!getProjectById(projectId)) return c.json({ ok: false, error: 'not found' }, 404);
    const service = deps.registry.get(projectId);
    if (!service.canSwitchSession()) {
      return c.json({ ok: false, error: 'interrupt the active turn and wait for confirmation before switching sessions' }, 409);
    }
    try {
      const session = await service.resumeSession(c.req.param('sid') as ULID);
      if (!session) return c.json({ ok: false, error: 'session not found' }, 404);
      return c.json({ ok: true, transition: 'resume-session', session: toSessionSummary(session) });
    } catch (error) {
      if (error instanceof RuntimeSelectionRejectedError) {
        return c.json({ ok: false, error: { code: error.code } }, 409);
      }
      throw error;
    }
  });

  app.get('/api/projects/:id/sessions/:sid/events', (c) => {
    const projectId = c.req.param('id') as ULID;
    const sessionId = c.req.param('sid') as ULID;
    const session = getOrchestratorSession(sessionId);
    if (!session || session.projectId !== projectId) {
      return c.json({ ok: false, error: 'session not found' }, 404);
    }
    return c.json({
      ok: true,
      events: replayConversationEvents(sessionId),
      highWaterSequence: getConversationHighWaterSequence(sessionId),
    });
  });

  // ── Accounts + subscription quota ──────────────────────────────────────────
  if (deps.accounts) {
    if (!deps.orchestratorRuntimeId) {
      throw new Error('orchestratorRuntimeId is required when account routes are mounted');
    }
    mountAccounts(app, {
      accounts: deps.accounts,
      registry: deps.registry,
      runtimeId: deps.orchestratorRuntimeId,
      subscriptionQuota: deps.subscriptionQuota,
    });
    if (deps.runtimes) {
      mountRuntimes(app, {
        accounts: deps.accounts,
        runtimes: deps.runtimes,
        registry: deps.registry,
        defaultRuntimeId: deps.orchestratorRuntimeId,
      });
    }
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
