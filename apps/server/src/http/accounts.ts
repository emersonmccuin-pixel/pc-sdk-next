// HTTP — accounts (list + per-project default) and usage re-prime.
//
// Accounts are the Claude Code logins the account switcher selects between.
// Setting a project's default account mints a NEW session (sessions live per
// config dir — switching accounts can't continue the old one). Usage re-prime
// returns the server's cached per-account quota snapshots for a fresh page load
// (the durable `usage` resource events heal live sockets; this heals cold HTTP).

import type { Hono } from 'hono';
import { getProjectById } from '@pc/db';
import type { ULID } from '@pc/domain';
import type { AccountRegistry } from '../runner/account-env.ts';
import type { SessionRegistry } from '../chat/registry.ts';
import type { UsageCache } from '../usage/cache.ts';

export interface AccountsHttpDeps {
  accounts: AccountRegistry;
  registry: SessionRegistry;
  usage?: UsageCache;
}

export function mountAccounts(app: Hono, deps: AccountsHttpDeps): void {
  // List the account registry + the server default.
  app.get('/api/accounts', (c) =>
    c.json({
      accounts: deps.accounts.list(),
      defaultAccountId: deps.accounts.defaultAccountId,
    }),
  );

  // The account a project's new sessions run under.
  app.get('/api/projects/:id/account', (c) => {
    const projectId = c.req.param('id') as ULID;
    if (!getProjectById(projectId)) return c.json({ error: 'not found' }, 404);
    return c.json({ accountId: deps.accounts.resolveForProject(projectId).id });
  });

  // Set a project's default account. Switching mints a new session.
  app.post('/api/projects/:id/account', async (c) => {
    const projectId = c.req.param('id') as ULID;
    if (!getProjectById(projectId)) return c.json({ error: 'not found' }, 404);
    const body = (await c.req.json().catch(() => ({}))) as Record<string, unknown>;
    const accountId = typeof body.accountId === 'string' ? body.accountId : '';
    if (!deps.accounts.has(accountId)) return c.json({ error: 'unknown account' }, 400);

    const current = deps.accounts.resolveForProject(projectId).id;
    const service = deps.registry.get(projectId);
    if (current !== accountId && !service.canSwitchSession()) {
      return c.json({ error: 'interrupt the active turn and wait for confirmation before switching accounts' }, 409);
    }
    // Switching accounts can't continue the old session (it lives in the other
    // config dir). The account setting, old-session invalidation, queue
    // cancellation, and replacement row commit atomically.
    const session = current !== accountId ? service.switchAccountSession(accountId) : null;
    return c.json({ accountId, switched: current !== accountId, session });
  });

  // Usage re-prime — cached per-account quota snapshots for a cold page load.
  if (deps.usage) {
    const usage = deps.usage;
    app.get('/api/usage', (c) => c.json({ snapshots: usage.list() }));
  }
}
