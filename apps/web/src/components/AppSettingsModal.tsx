// App-wide settings modal. Trimmed vs. PC-PTY-Chat: the old statusline-
// aggregate Usage tab is gone — replaced below by the durable, provider-aware
// usage dashboard (N6). The Updates tab (Electron auto-update) stays deferred
// — browser-only now. Tabs: General (folder / fonts / scale / layout) +
// Accounts (the login registry) + MCP servers (N6 reliability bar) + Usage
// (every registered runtime+account's subscription quota).

import { useState } from 'react';

import {
  FONT_SCALE_MAX,
  FONT_SCALE_MIN,
  FONT_SCALE_STEP,
  settingsApi,
  type GlobalSettings,
} from '@/features/settings/client';
import { postJson } from '@/api/http';
import { FONT_REGISTRY, applyFontCssVars, fontsForGroup } from '@/features/settings/fonts';
import type { FontGroup, FontKey } from '@/features/settings/types';
import { useAccounts } from '@/state/accounts';
import { McpManagerPanel } from '@/features/mcp/McpManagerPanel';
import { UsageDashboardPanel } from '@/features/usage/UsageDashboardPanel';

type TabId = 'general' | 'accounts' | 'mcp' | 'usage';

const TABS: { id: TabId; label: string }[] = [
  { id: 'general', label: 'General' },
  { id: 'accounts', label: 'Accounts' },
  { id: 'mcp', label: 'MCP servers' },
  { id: 'usage', label: 'Usage' },
];

const FONT_GROUPS: { group: FontGroup; label: string }[] = [
  { group: 'chat', label: 'Chat' },
  { group: 'workItems', label: 'Content' },
  { group: 'ui', label: 'UI / chrome' },
  { group: 'code', label: 'Code' },
];

interface AppSettingsModalProps {
  settings: GlobalSettings;
  onClose: () => void;
  onSaved: (next: GlobalSettings, restartRequired: boolean) => void;
}

export function AppSettingsModal({ settings, onClose, onSaved }: AppSettingsModalProps) {
  const [active, setActive] = useState<TabId>('general');
  const [draft, setDraft] = useState<GlobalSettings>(settings);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  function patchDraft(patch: Partial<GlobalSettings>) {
    setDraft((d) => {
      const next = { ...d, ...patch };
      if (patch.fonts) applyFontCssVars(patch.fonts);
      if (patch.fontScale !== undefined) {
        document.documentElement.style.setProperty('--font-scale', String(patch.fontScale));
      }
      return next;
    });
  }

  async function save() {
    if (busy) return;
    setBusy(true);
    setErr(null);
    try {
      const res = await settingsApi.patchSettings({
        projectsFolder: draft.projectsFolder,
        fontScale: draft.fontScale,
        fonts: draft.fonts,
        showCommandSpace: draft.showCommandSpace,
        activityPanel: draft.activityPanel,
      });
      onSaved(res.settings, res.restartRequired);
    } catch (e) {
      setErr((e as Error).message);
      setBusy(false);
    }
  }

  return (
    <div className="fixed inset-0 z-50 grid place-items-center bg-black/50" onClick={onClose}>
      <div
        className="flex h-[620px] w-[820px] flex-col border border-border bg-card text-foreground shadow-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        <header className="flex items-center justify-between border-b border-border px-4 py-3">
          <h2 className="text-base font-semibold uppercase tracking-wider">App settings</h2>
          <button onClick={onClose} className="text-muted-foreground hover:text-foreground" aria-label="Close">
            ×
          </button>
        </header>

        <div className="flex min-h-0 flex-1">
          <nav className="flex w-44 shrink-0 flex-col border-r border-border bg-card py-2">
            {TABS.map((t) => {
              const isActive = active === t.id;
              return (
                <button
                  key={t.id}
                  onClick={() => setActive(t.id)}
                  className={
                    'block w-full border-l-2 px-3 py-2 text-left text-xs ' +
                    (isActive
                      ? 'border-primary bg-muted text-primary font-medium'
                      : 'border-transparent text-foreground/80 hover:bg-muted')
                  }
                >
                  {t.label}
                </button>
              );
            })}
          </nav>

          <div className="flex-1 overflow-y-auto p-6 text-sm">
            {active === 'general' && (
              <div className="space-y-5">
                <Field label="Projects folder" help="Where new projects are created by default.">
                  <input
                    type="text"
                    value={draft.projectsFolder}
                    onChange={(e) => patchDraft({ projectsFolder: e.target.value })}
                    placeholder="C:\\Users\\me\\Projects"
                    className="w-full border border-border bg-background px-2 py-1 font-mono text-xs"
                  />
                </Field>

                <Field label={`Font scale — ${Math.round(draft.fontScale * 100)}%`}>
                  <input
                    type="range"
                    min={FONT_SCALE_MIN}
                    max={FONT_SCALE_MAX}
                    step={FONT_SCALE_STEP}
                    value={draft.fontScale}
                    onChange={(e) => patchDraft({ fontScale: Number(e.target.value) })}
                    className="w-full"
                  />
                </Field>

                <div className="space-y-3">
                  <div className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
                    Fonts
                  </div>
                  {FONT_GROUPS.map(({ group, label }) => (
                    <Field key={group} label={label}>
                      <select
                        value={draft.fonts[group]}
                        onChange={(e) =>
                          patchDraft({ fonts: { ...draft.fonts, [group]: e.target.value as FontKey } })
                        }
                        className="w-full border border-border bg-background px-2 py-1 text-sm"
                      >
                        {fontsForGroup(group).map((key) => (
                          <option key={key} value={key}>
                            {FONT_REGISTRY[key].label}
                          </option>
                        ))}
                      </select>
                    </Field>
                  ))}
                </div>

                <label className="flex items-center gap-2 text-xs text-foreground/90">
                  <input
                    type="checkbox"
                    checked={draft.showCommandSpace}
                    onChange={(e) => patchDraft({ showCommandSpace: e.target.checked })}
                  />
                  <span>Show the Command cross-project space in the rail</span>
                </label>
                <label className="flex items-center gap-2 text-xs text-foreground/90">
                  <input
                    type="checkbox"
                    checked={draft.activityPanel.open}
                    onChange={(e) =>
                      patchDraft({ activityPanel: { ...draft.activityPanel, open: e.target.checked } })
                    }
                  />
                  <span>Open the activity panel by default</span>
                </label>

                <EngineSection />
              </div>
            )}

            {active === 'accounts' && <AccountsTab />}
            {active === 'mcp' && <McpManagerPanel />}
            {active === 'usage' && <UsageDashboardPanel />}
          </div>
        </div>

        <footer className="flex items-center justify-end gap-2 border-t border-border px-4 py-3">
          {err && <span className="mr-auto text-xs text-destructive">{err}</span>}
          <button onClick={onClose} className="border border-border px-3 py-1.5 text-sm hover:bg-muted">
            Cancel
          </button>
          <button
            onClick={save}
            disabled={busy}
            className="bg-primary px-3 py-1.5 text-sm font-medium text-primary-foreground hover:bg-primary/90 disabled:opacity-50"
          >
            {busy ? 'Saving…' : 'Save'}
          </button>
        </footer>
      </div>
    </div>
  );
}

/** Engine restart — the no-terminal way to pick up new server code. POSTs the
 *  restart, polls /health until the fresh process is up, then reloads the app. */
function EngineSection() {
  const [state, setState] = useState<'idle' | 'restarting' | 'failed'>('idle');

  async function restart() {
    if (state === 'restarting') return;
    if (!window.confirm('Restart the PC-SDK engine? In-flight chat turns and agent runs will be stopped (boot recovery closes them out loudly).')) {
      return;
    }
    setState('restarting');
    try {
      await postJson('/api/admin/restart', {});
    } catch {
      // The connection may drop as the server exits — that IS the restart.
    }
    // Old process exits, new one binds the same port. Poll until healthy.
    const deadline = Date.now() + 60_000;
    // Give the old listener a beat to actually close before polling.
    await new Promise((r) => setTimeout(r, 1_500));
    while (Date.now() < deadline) {
      try {
        const res = await fetch('/health', { cache: 'no-store' });
        if (res.ok) {
          location.reload();
          return;
        }
      } catch {
        /* still down — keep polling */
      }
      await new Promise((r) => setTimeout(r, 1_000));
    }
    setState('failed');
  }

  return (
    <div className="space-y-2 border-t border-border pt-4">
      <div className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">Engine</div>
      <p className="text-xs text-muted-foreground">
        Restarts the local server on the current code — use after an update. The window reloads
        automatically when it&apos;s back (a few seconds).
      </p>
      <button
        onClick={restart}
        disabled={state === 'restarting'}
        className="border border-border px-3 py-1.5 text-sm hover:bg-muted disabled:opacity-50"
      >
        {state === 'restarting' ? 'Restarting… (window reloads when it’s back)' : 'Restart engine'}
      </button>
      {state === 'failed' && (
        <p className="text-xs text-destructive">
          The engine didn&apos;t come back within 60s — relaunch it from the PC-SDK taskbar icon.
        </p>
      )}
    </div>
  );
}

function AccountsTab() {
  const accounts = useAccounts((s) => s.accounts);
  const selectedId = useAccounts((s) => s.selectedId);
  const select = useAccounts((s) => s.select);

  return (
    <div className="space-y-3">
      <p className="text-xs text-muted-foreground">
        Each account is a Claude login (config dir). The orchestrator + agents run under the selected
        account; switching starts a new session. The registry + config dirs are server-owned — this is
        the current selection.
      </p>
      {accounts.map((a) => {
        const isActive = a.id === selectedId;
        return (
          <button
            key={a.id}
            onClick={() => select(a.id)}
            className={
              'flex w-full items-center justify-between border px-3 py-2 text-left ' +
              (isActive ? 'border-primary bg-muted' : 'border-border hover:bg-muted')
            }
          >
            <div className="min-w-0">
              <div className={`text-sm ${isActive ? 'text-primary' : 'text-foreground'}`}>{a.label}</div>
              <div className="truncate font-mono text-[11px] text-muted-foreground">{a.configDir}</div>
            </div>
            {isActive && <span className="shrink-0 text-[10px] uppercase tracking-wider text-primary">active</span>}
          </button>
        );
      })}
    </div>
  );
}

function Field({ label, help, children }: { label: string; help?: string; children: React.ReactNode }) {
  return (
    <div className="space-y-1">
      <div className="text-xs text-muted-foreground">{label}</div>
      {children}
      {help && <div className="text-xs text-muted-foreground">{help}</div>}
    </div>
  );
}
