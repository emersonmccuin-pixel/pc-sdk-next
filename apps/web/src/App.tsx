import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import { projectsApi, type Project } from '@/features/projects/client';
import { settingsApi, type GlobalSettings } from '@/features/settings/client';
import { applyFontCssVars } from '@/features/settings/fonts';
import { AppSettingsModal } from '@/components/AppSettingsModal';
import { CommandIntroModal } from '@/components/CommandIntroModal';
import { CreateProjectModal } from '@/components/CreateProjectModal';
import { ErrorBoundary } from '@/components/ErrorBoundary';
import { NotesPopover } from '@/components/NotesPopover';
import { OnboardingWizard } from '@/components/onboarding/OnboardingWizard';
import { AccountSwitcher } from '@/components/AccountSwitcher';
import { RuntimeSwitcher } from '@/components/RuntimeSwitcher';
import { ModelSwitcher } from '@/components/ModelSwitcher';
import { EffortSwitcher } from '@/components/EffortSwitcher';
import { Shell } from '@/components/Shell';
import { COMMAND_PROJECT_SLUG } from '@pc/contracts';
import { useSessionNav } from '@/state/sessions';
import { useSubscriptionQuotaResourceSync } from '@/state/subscription-quota-bridge';
import { useActiveProject } from '@/store/active-project';
import { useAppSettingsModal } from '@/store/app-settings-modal';

// Unread + live-session sets are sibling-owned (chat activity); until that lands
// the rail shows no unread badge / live underline. Stable empty sets so the rail
// memos don't churn.
const EMPTY_SET: ReadonlySet<string> = new Set();

export default function App() {
  const [projects, setProjects] = useState<Project[] | null>(null);
  // Projects that currently hold a live orchestrator session (bright in the
  // rail); everything else dims. Fetched from the server on load — background
  // projects get no WS frames (ws-client filters to the open project) — and
  // refreshed on every session transition or explicit close/new action.
  const [liveSessionProjectIds, setLiveSessionProjectIds] =
    useState<ReadonlySet<string>>(EMPTY_SET);
  const [createOpen, setCreateOpen] = useState(false);
  const [settings, setSettings] = useState<GlobalSettings | null>(null);
  const settingsOpen = useAppSettingsModal((s) => s.open);
  const setSettingsOpen = useAppSettingsModal((s) => s.setOpen);
  const [restartRequired, setRestartRequired] = useState(false);
  const activeSlug = useActiveProject((s) => s.activeSlug);
  const setActiveSlug = useActiveProject((s) => s.setActiveSlug);
  const [notesOpen, setNotesOpen] = useState(false);
  const notesButtonRef = useRef<HTMLButtonElement | null>(null);

  const applyTransition = useSessionNav((s) => s.applyTransition);
  const sessionChangedNonce = useSessionNav((s) => s.nonce);

  const refreshLiveSessions = useCallback(() => {
    void projectsApi
      .liveSessions()
      .then((ids) => setLiveSessionProjectIds(new Set(ids)))
      .catch(() => {});
  }, []);
  // Seed on mount and re-sync whenever a session transition bumps the nonce
  // (new/resume/account-switch on the active project all flow through here).
  useEffect(() => {
    refreshLiveSessions();
  }, [refreshLiveSessions, sessionChangedNonce]);

  useSubscriptionQuotaResourceSync();

  const onboardingParam = useMemo(
    () => new URLSearchParams(window.location.search).get('onboarding'),
    [],
  );
  const forceOnboarding = onboardingParam === 'force';
  const [wizardDismissed, setWizardDismissed] = useState(false);
  // null = settings still loading; true = set up; false = wizard needed.
  const [bootReady, setBootReady] = useState<boolean | null>(forceOnboarding ? false : null);

  const activityPanelOpen = settings?.activityPanel.open ?? true;

  useEffect(() => {
    void projectsApi
      .listProjects()
      .then(setProjects)
      .catch(() => setProjects([]));
    void settingsApi
      .getSettings()
      .then((s) => {
        setSettings(s);
        if (!forceOnboarding) {
          const folderOk = (s.projectsFolder ?? '').trim().length > 0;
          setBootReady(Boolean(s.onboardingCompletedAt) && folderOk);
        }
      })
      .catch(() => {
        // Settings unreadable — keep the wizard showing (safe fresh-machine default).
      });
  }, [forceOnboarding]);

  useEffect(() => {
    if (!settings) return;
    document.documentElement.style.setProperty('--font-scale', String(settings.fontScale));
  }, [settings?.fontScale]);

  useEffect(() => {
    if (!settings?.fonts) return;
    applyFontCssVars(settings.fonts);
  }, [settings?.fonts]);

  // Pick the first project if the persisted selection no longer exists.
  useEffect(() => {
    if (!projects || projects.length === 0) return;
    if (activeSlug && projects.some((p) => p.slug === activeSlug)) return;
    setActiveSlug(projects[0]!.slug);
  }, [projects, activeSlug, setActiveSlug]);

  const activeProject = useMemo(
    () => projects?.find((p) => p.slug === activeSlug) ?? null,
    [projects, activeSlug],
  );

  // Command intro modal — once per entry into Command when not dismissed.
  const [commandIntroVisible, setCommandIntroVisible] = useState(false);
  const commandIntroLastSlugRef = useRef<string | null>(null);
  useEffect(() => {
    if (
      activeSlug === COMMAND_PROJECT_SLUG &&
      commandIntroLastSlugRef.current !== COMMAND_PROJECT_SLUG &&
      settings !== null &&
      !settings.commandIntroDismissed
    ) {
      commandIntroLastSlugRef.current = COMMAND_PROJECT_SLUG;
      setCommandIntroVisible(true);
    } else if (activeSlug !== COMMAND_PROJECT_SLUG) {
      commandIntroLastSlugRef.current = null;
    }
  }, [activeSlug, settings]);

  const persistActivityPanelSetting = useCallback(
    (patch: { open?: boolean }) => {
      setSettings((prev) =>
        prev
          ? { ...prev, activityPanel: { ...prev.activityPanel, open: patch.open ?? prev.activityPanel.open } }
          : prev,
      );
      void settingsApi
        .patchSettings({
          activityPanel: {
            open: patch.open ?? settings?.activityPanel.open ?? true,
            showAllProjects: settings?.activityPanel.showAllProjects ?? false,
          },
        })
        .catch(() => {});
    },
    [settings],
  );

  const handleProjectUpdated = useCallback((next: Project) => {
    setProjects((prev) => (prev ? prev.map((p) => (p.id === next.id ? next : p)) : prev));
  }, []);

  const handleProjectDeleted = useCallback(
    (projectId: string) => {
      setProjects((prev) => {
        if (!prev) return prev;
        const filtered = prev.filter((p) => p.id !== projectId);
        const wasActive = prev.find((p) => p.id === projectId)?.slug === activeSlug;
        if (wasActive) setActiveSlug(filtered[0]?.slug ?? null);
        return filtered;
      });
    },
    [activeSlug, setActiveSlug],
  );

  const handleProjectReorder = useCallback((orderedIds: string[]) => {
    setProjects((prev) => {
      if (!prev) return prev;
      const byId = new Map(prev.map((p) => [p.id, p] as const));
      const reordered: Project[] = [];
      for (const id of orderedIds) {
        const p = byId.get(id);
        if (p) reordered.push(p);
      }
      for (const p of prev) if (!orderedIds.includes(p.id)) reordered.push(p);
      return reordered;
    });
    void projectsApi.reorderProjects(orderedIds).then(setProjects).catch(() => {
      void projectsApi.listProjects().then(setProjects).catch(() => {});
    });
  }, []);

  const finishOnboarding = useCallback(() => {
    setWizardDismissed(true);
    setCreateOpen(true);
    void settingsApi
      .patchSettings({ onboardingCompletedAt: new Date().toISOString() })
      .then((r) => setSettings(r.settings))
      .catch(() => {});
  }, []);

  const handleProjectsFolderChange = useCallback((path: string) => {
    void settingsApi
      .patchSettings({ projectsFolder: path })
      .then((r) => setSettings(r.settings))
      .catch(() => {});
  }, []);

  if (projects === null || bootReady === null) {
    return (
      <div
        data-testid="app-loading"
        className="grid h-full place-items-center bg-background text-muted-foreground"
      >
        Loading…
      </div>
    );
  }

  const showWizard = !wizardDismissed && (forceOnboarding || !bootReady);
  if (showWizard) {
    return (
      <OnboardingWizard
        initialProjectsFolder={settings?.projectsFolder ?? ''}
        onProjectsFolderChange={handleProjectsFolderChange}
        onComplete={finishOnboarding}
      />
    );
  }

  return (
    <div data-testid="app-shell" className="flex h-full flex-col bg-background text-foreground">
      <header className="flex items-center border-b border-border bg-card text-xs" style={{ height: 32 }}>
        <div className="flex shrink-0 items-center" style={{ width: 192 }}>
          <button
            type="button"
            onClick={() => setSettingsOpen(true)}
            disabled={!settings}
            className="flex h-full w-full items-center gap-2 px-3 text-left hover:bg-muted/50 disabled:opacity-60"
            title="App settings"
          >
            <span className="text-sm font-bold uppercase tracking-[0.14em] text-primary">pc-sdk</span>
            <span className="text-[10px] text-[var(--fg-dim)]">▾</span>
          </button>
        </div>
        <div className="flex flex-1 items-center gap-3 pr-2">
          <div className="ml-auto flex items-center gap-1">
            <RuntimeSwitcher projectId={activeProject?.id ?? null} />
            <ModelSwitcher projectId={activeProject?.id ?? null} />
            <EffortSwitcher projectId={activeProject?.id ?? null} />
            <AccountSwitcher projectId={activeProject?.id ?? null} />
            {activeProject && (
              <button
                ref={notesButtonRef}
                type="button"
                onClick={() => setNotesOpen((v) => !v)}
                title="Project scratchpad"
                aria-label="Project scratchpad"
                aria-expanded={notesOpen}
                aria-haspopup="true"
                className={`px-2 py-1 text-[11px] uppercase tracking-[0.06em] hover:bg-primary/10 ${
                  notesOpen ? 'text-primary' : 'text-muted-foreground hover:text-foreground'
                }`}
              >
                Scratchpad
              </button>
            )}
            <button
              onClick={() => persistActivityPanelSetting({ open: !activityPanelOpen })}
              disabled={!settings}
              title={activityPanelOpen ? 'Hide activity panel' : 'Show activity panel'}
              aria-label="Toggle activity panel"
              className={`px-2 py-1 hover:bg-muted hover:text-foreground disabled:opacity-40 ${
                activityPanelOpen ? 'text-muted-foreground' : 'text-foreground'
              }`}
            >
              {activityPanelOpen ? '▸' : '◂'}
            </button>
          </div>
        </div>
      </header>

      {notesOpen && activeProject && (
        <ErrorBoundary label="notes" fallback={null}>
          <NotesPopover
            key={activeProject.id}
            projectId={activeProject.id}
            initialNotes={activeProject.notes ?? null}
            anchorEl={notesButtonRef.current}
            onClose={() => setNotesOpen(false)}
          />
        </ErrorBoundary>
      )}

      {restartRequired && (
        <div className="flex items-center justify-between gap-3 border-b border-warning/60 bg-warning/10 px-3 py-1.5 text-xs text-warning">
          <span>Settings change saved — restart the server for it to take effect.</span>
          <button onClick={() => setRestartRequired(false)} className="text-warning hover:text-foreground">
            dismiss
          </button>
        </div>
      )}

      <div className="flex-1 overflow-hidden">
        <Shell
          projects={projects}
          activityPanelOpen={activityPanelOpen}
          onToggleActivityPanelOpen={(next) => persistActivityPanelSetting({ open: next })}
          onCreateProject={() => setCreateOpen(true)}
          onProjectUpdated={handleProjectUpdated}
          onProjectDeleted={handleProjectDeleted}
          onProjectReorder={handleProjectReorder}
          unreadProjectIds={EMPTY_SET}
          liveSessionProjectIds={liveSessionProjectIds}
          onSessionsChanged={refreshLiveSessions}
          sessionChangedNonce={sessionChangedNonce}
          applySessionTransition={(t) => {
            if (activeProject) applyTransition(activeProject.id, t);
          }}
          showCommandSpace={settings?.showCommandSpace ?? true}
        />
      </div>

      {createOpen && (
        <CreateProjectModal
          {...(settings?.projectsFolder ? { projectsFolder: settings.projectsFolder } : {})}
          onClose={() => setCreateOpen(false)}
          onOpenAppSettings={() => {
            setCreateOpen(false);
            setSettingsOpen(true);
          }}
          onCreated={(p) => {
            setProjects((prev) => (prev ? [...prev, p] : [p]));
            setActiveSlug(p.slug);
            setCreateOpen(false);
          }}
        />
      )}

      {settingsOpen && settings && (
        <AppSettingsModal
          settings={settings}
          onClose={() => setSettingsOpen(false)}
          onSaved={(next, needsRestart) => {
            setSettings(next);
            if (needsRestart) setRestartRequired(true);
            setSettingsOpen(false);
          }}
        />
      )}

      {commandIntroVisible && (
        <CommandIntroModal
          onClose={(dismissed) => {
            setCommandIntroVisible(false);
            if (dismissed) {
              void settingsApi
                .patchSettings({ commandIntroDismissed: true })
                .then((r) => setSettings(r.settings))
                .catch(() => {});
            }
          }}
        />
      )}
    </div>
  );
}
