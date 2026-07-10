// Global settings HTTP — the app-level singleton the web reads on boot (the
// boot gate blocks until this resolves) and PATCHes from onboarding + App
// Settings. Backed by the settings_global row (seeded on migrate).

import { homedir } from 'node:os';
import type { Hono } from 'hono';
import { getGlobalSettings, setGlobalSettings } from '@pc/db';
import { getDataDir } from '@pc/utils';
import { withSettingsDefaults, type GlobalSettings } from '@pc/domain';

function current(): GlobalSettings {
  return withSettingsDefaults(getGlobalSettings() ?? {}, getDataDir(), homedir());
}

// Keys whose change needs a server restart to take effect (data dir, the claude
// binary/config-dir resolution captured at boot).
const RESTART_KEYS: ReadonlySet<string> = new Set(['dataDir', 'claudeExe', 'claudeConfigDir']);

export function mountSettings(app: Hono): void {
  app.get('/api/settings', (c) => c.json({ ok: true, settings: current() }));

  app.patch('/api/settings', async (c) => {
    const patch = (await c.req.json().catch(() => ({}))) as Partial<GlobalSettings>;
    const before = current();
    // Shallow overlay + re-normalize through the domain defaults so partial
    // nested objects (activityPanel, fonts, …) stay well-formed.
    const merged = withSettingsDefaults({ ...before, ...patch }, getDataDir(), homedir());
    setGlobalSettings(merged);
    const beforeRec = before as unknown as Record<string, unknown>;
    const patchRec = patch as Record<string, unknown>;
    const restartRequired = Object.keys(patch).some(
      (k) => RESTART_KEYS.has(k) && beforeRec[k] !== patchRec[k],
    );
    return c.json({ ok: true, settings: merged, restartRequired });
  });
}
