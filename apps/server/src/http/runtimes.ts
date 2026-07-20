// HTTP — provider-neutral runtime + account availability listing.
//
// Distinct from `accounts.ts` (which mounts the single-runtime account-
// switcher for the orchestrator's default runtime). This route lets the UI
// discover every REGISTERED runtime and, per account, whether it is currently
// usable — e.g. a project can only be pointed at 'openai-codex' once its
// account shows available here. Capability facts (native resume, model
// discovery, effort control, …) come straight from each adapter's typed
// `RuntimeCapabilities`; this route adds no provider-native detail of its own.
//
// Calling an adapter's `capabilities()` can be a real native round-trip (the
// Codex adapter spawns and disposes one app-server process per account per
// call). This is a first-use/settings-page read, not a polled hot path.

import type { Hono } from 'hono';
import type { RuntimeCapabilities } from '@pc/contracts';
import type { AccountRegistry } from '../runner/account-env.ts';
import type { RuntimeRegistry } from '../runner/runtime.ts';

export interface RuntimesHttpDeps {
  accounts: AccountRegistry;
  runtimes: RuntimeRegistry;
}

interface RuntimeAccountAvailability {
  id: string;
  capabilities: RuntimeCapabilities | null;
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
            try {
              return { id: account.id, capabilities: await adapter.capabilities(account.id) };
            } catch {
              return { id: account.id, capabilities: null };
            }
          }),
        );
        return { runtimeId, accounts };
      }),
    );

    return c.json({ ok: true, runtimes });
  });
}
