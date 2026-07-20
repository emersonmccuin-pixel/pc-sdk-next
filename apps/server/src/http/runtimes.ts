// HTTP — provider-neutral runtime + account availability listing, plus the
// project-scoped runtime switcher.
//
// Distinct from `accounts.ts` (which mounts the single-runtime account-
// switcher for the orchestrator's default runtime). This route lets the UI
// discover every REGISTERED runtime and, per account, whether it is currently
// usable — e.g. a project can only be pointed at 'openai-codex' once its
// account shows available here. Capability facts (native resume, model
// discovery, effort control, …) come straight from each adapter's typed
// `RuntimeCapabilities`; this route adds no provider-native detail of its own.
//
// Calling an adapter's `capabilities()`/`listModels()` can be a real native
// round-trip (the Codex adapter spawns and disposes one app-server process
// per account per call). This is a first-use/settings-page read, not a
// polled hot path.
//
// Runtime switching mirrors the account switcher exactly (docs/agent-runtime-
// architecture.md "Sessions and switching"): it is project-scoped and
// explicit, and it always mints a NEW session — a runtime change re-resolves
// the account fresh for the new runtime rather than carrying the old
// runtime's account id across. Prior sessions remain viewable and resume only
// through their own stamped adapter.

import type { Hono } from 'hono';
import { getProjectById } from '@pc/db';
import { withProjectSettingsDefaults, type ULID } from '@pc/domain';
import type { RuntimeCapabilities, RuntimeModelDiscovery } from '@pc/contracts';
import type { AccountRegistry } from '../runner/account-env.ts';
import type { SessionRegistry } from '../chat/registry.ts';
import { RuntimeSelectionRejectedError, type RuntimeRegistry } from '../runner/runtime.ts';
import { toSessionSummary } from './dto.ts';

export interface RuntimesHttpDeps {
  accounts: AccountRegistry;
  runtimes: RuntimeRegistry;
  /** Required to mount the project runtime-switcher routes below the
   *  availability listing. Tests exercising only GET /api/runtimes may omit
   *  both this and `defaultRuntimeId`. */
  registry?: SessionRegistry;
  /** The server's fallback runtime (Claude) when a project has never stamped
   *  a `defaultRuntimeId` setting and has no active session yet. */
  defaultRuntimeId?: string;
}

interface RuntimeAccountAvailability {
  id: string;
  capabilities: RuntimeCapabilities | null;
  models: RuntimeModelDiscovery | null;
}

interface RuntimeAvailability {
  runtimeId: string;
  accounts: RuntimeAccountAvailability[];
}

export function mountRuntimes(app: Hono, deps: RuntimesHttpDeps): void {
  app.get('/api/runtimes', async (c) => {
    const runtimeIds = [...new Set(deps.accounts.list().map((account) => account.runtimeId))]
      .filter((runtimeId) => deps.runtimes.has(runtimeId));

    const runtimes: RuntimeAvailability[] = await Promise.all(
      runtimeIds.map(async (runtimeId): Promise<RuntimeAvailability> => {
        const adapter = deps.runtimes.get(runtimeId);
        const accountsForRuntime = deps.accounts.list()
          .filter((account) => account.runtimeId === runtimeId);
        const accounts = await Promise.all(
          accountsForRuntime.map(async (account): Promise<RuntimeAccountAvailability> => {
            const [capabilities, models] = await Promise.all([
              adapter.capabilities(account.id).catch(() => null),
              adapter.listModels(account.id).catch(() => null),
            ]);
            return { id: account.id, capabilities, models };
          }),
        );
        return { runtimeId, accounts };
      }),
    );

    return c.json({ ok: true, runtimes });
  });

  if (!deps.registry || !deps.defaultRuntimeId) return;
  const registry = deps.registry;
  const defaultRuntimeId = deps.defaultRuntimeId;

  const currentRuntimeId = (projectId: ULID, active: string | undefined): string =>
    active ??
    withProjectSettingsDefaults(getProjectById(projectId)?.settings).defaultRuntimeId ??
    defaultRuntimeId;

  // The runtime a project's new sessions run under.
  app.get('/api/projects/:id/runtime', (c) => {
    const projectId = c.req.param('id') as ULID;
    if (!getProjectById(projectId)) return c.json({ error: 'not found' }, 404);
    const active = registry.get(projectId).activeRuntimeSelection();
    return c.json({ runtimeId: currentRuntimeId(projectId, active?.runtimeId) });
  });

  // Set a project's default runtime. Switching mints a new session.
  app.post('/api/projects/:id/runtime', async (c) => {
    const projectId = c.req.param('id') as ULID;
    if (!getProjectById(projectId)) return c.json({ error: 'not found' }, 404);
    const body = (await c.req.json().catch(() => ({}))) as Record<string, unknown>;
    const runtimeId = typeof body.runtimeId === 'string' ? body.runtimeId : '';
    if (!deps.runtimes.has(runtimeId)) {
      return c.json({ error: { code: 'runtime-not-registered' } }, 400);
    }

    const service = registry.get(projectId);
    const active = service.activeRuntimeSelection();
    const current = currentRuntimeId(projectId, active?.runtimeId);
    if (current !== runtimeId && !service.canSwitchSession()) {
      return c.json({ error: 'interrupt the active turn and wait for confirmation before switching runtimes' }, 409);
    }
    // Switching runtimes can't continue the old session (a Claude session is
    // never resumed as a Codex thread or vice versa). The runtime setting,
    // old-session invalidation, queue cancellation, and replacement row commit
    // atomically.
    try {
      const session = current !== runtimeId
        ? await service.switchRuntimeSession(runtimeId)
        : null;
      return c.json({
        runtimeId,
        switched: current !== runtimeId,
        session: session ? toSessionSummary(session) : null,
      });
    } catch (error) {
      if (error instanceof RuntimeSelectionRejectedError) {
        return c.json({ error: { code: error.code } }, 422);
      }
      throw error;
    }
  });
}
