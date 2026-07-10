// Three-column shell: fixed 192px project rail | center (tab strip + body) |
// collapsible 192px activity panel. Layout vendored from PC-PTY-Chat (react-
// resizable-panels v4; string sizes = percent, numeric = pixels). Dead tabs
// (work/workflows/files) and the terminal surface are gone; chat + activity are
// sibling-owned mounts behind clean seams.

import { useEffect } from 'react';
import { Group, Panel, Separator, usePanelRef } from 'react-resizable-panels';

import { COMMAND_PROJECT_SLUG } from '@pc/contracts';
import type { Project } from '@/features/projects/client';
import type { SessionTransition } from '@/state/sessions';
import { useActiveCenterTab } from '@/store/active-center-tab';
import { useActiveProject } from '@/store/active-project';

import { ActivityMount } from './center/ActivityMount';
import { AgentsMount } from './center/AgentsMount';
import { AgentTranscriptModalMount } from './AgentTranscriptModal';
import { ChatMount } from './center/ChatMount';
import { ErrorBoundary } from './ErrorBoundary';
import { LeftRail } from './LeftRail';
import { ProjectSettingsPanel } from './ProjectSettingsPanel';
import { COMMAND_TABS, TABS, TabBar } from './Tabs';
import { DevControls } from './DevControls';

interface ShellProps {
  projects: Project[];
  activityPanelOpen: boolean;
  onToggleActivityPanelOpen: (next: boolean) => void;
  onCreateProject: () => void;
  onProjectUpdated: (next: Project) => void;
  onProjectDeleted: (projectId: string) => void;
  onProjectReorder: (orderedIds: string[]) => void;
  unreadProjectIds: ReadonlySet<string>;
  liveSessionProjectIds: ReadonlySet<string>;
  sessionChangedNonce: number;
  applySessionTransition: (transition: SessionTransition) => void;
  showCommandSpace: boolean;
}

export function Shell({
  projects,
  activityPanelOpen,
  onToggleActivityPanelOpen,
  onCreateProject,
  onProjectUpdated,
  onProjectDeleted,
  onProjectReorder,
  unreadProjectIds,
  liveSessionProjectIds,
  sessionChangedNonce,
  applySessionTransition,
  showCommandSpace,
}: ShellProps) {
  const activityRef = usePanelRef();
  const activeSlug = useActiveProject((s) => s.activeSlug);
  const activeProject = projects.find((p) => p.slug === activeSlug) ?? null;

  useEffect(() => {
    const panel = activityRef.current;
    if (!panel) return;
    if (activityPanelOpen) {
      if (panel.isCollapsed()) panel.resize(192);
    } else if (!panel.isCollapsed()) {
      panel.collapse();
    }
  }, [activityPanelOpen, activityRef]);

  return (
    <div className="flex h-full flex-col">
      <Group orientation="horizontal" id="pc-shell-v3" className="flex-1 min-h-0">
        <Panel id="rail" defaultSize={192} minSize={192} maxSize={192} groupResizeBehavior="preserve-pixel-size">
          <LeftRail
            projects={projects}
            activeProject={activeProject}
            sessionChangedNonce={sessionChangedNonce}
            applySessionTransition={applySessionTransition}
            onCreateProject={onCreateProject}
            onProjectDeleted={onProjectDeleted}
            onProjectReorder={onProjectReorder}
            unreadProjectIds={unreadProjectIds}
            liveSessionProjectIds={liveSessionProjectIds}
            showCommandSpace={showCommandSpace}
          />
        </Panel>
        {/* Rails are fixed-width by design — disabled separators drop the drag
            affordance + resize cursor. */}
        <Separator disabled className="w-px bg-border" />
        <Panel id="center" defaultSize="70%" minSize="30%">
          <Center
            activeProject={activeProject}
            projectCount={projects.length}
            onCreateProject={onCreateProject}
            onProjectUpdated={onProjectUpdated}
            onProjectDeleted={onProjectDeleted}
          />
        </Panel>
        <Separator disabled className="w-px bg-border" />
        <Panel
          id="activity"
          panelRef={activityRef}
          defaultSize={192}
          minSize={192}
          maxSize={192}
          collapsible
          collapsedSize={36}
          groupResizeBehavior="preserve-pixel-size"
        >
          <ErrorBoundary key={activeProject?.id ?? ''} label="activity panel">
            <ActivityMount
              project={activeProject}
              expanded={activityPanelOpen}
              onExpand={() => onToggleActivityPanelOpen(true)}
            />
          </ErrorBoundary>
        </Panel>
      </Group>
      <AgentTranscriptModalMount />
      {import.meta.env.DEV && <DevControls />}
    </div>
  );
}

function Center({
  activeProject,
  projectCount,
  onCreateProject,
  onProjectUpdated,
  onProjectDeleted,
}: {
  activeProject: Project | null;
  projectCount: number;
  onCreateProject: () => void;
  onProjectUpdated: (next: Project) => void;
  onProjectDeleted: (projectId: string) => void;
}) {
  const tab = useActiveCenterTab((s) => s.tab);
  const setTab = useActiveCenterTab((s) => s.setTab);

  if (!activeProject) {
    return <EmptyState projectCount={projectCount} onCreateProject={onCreateProject} />;
  }

  const isCommand = activeProject.slug === COMMAND_PROJECT_SLUG;
  const activeTabs = isCommand ? COMMAND_TABS : TABS;
  // A persisted tab not in this surface's nav falls back to the chat view.
  const effectiveTab = (TABS as readonly string[]).includes(tab) || tab === 'project-settings' ? tab : 'orchestrator';

  return (
    <div className="flex h-full flex-col bg-background">
      <TabBar value={effectiveTab} onChange={setTab} tabs={activeTabs} />
      <div className="flex-1 overflow-hidden">
        {effectiveTab === 'orchestrator' ? (
          <ErrorBoundary resetKey={activeProject.id} label="chat">
            <ChatMount project={activeProject} />
          </ErrorBoundary>
        ) : effectiveTab === 'agents' ? (
          <ErrorBoundary key={activeProject.id} label="agents">
            <AgentsMount project={activeProject} />
          </ErrorBoundary>
        ) : effectiveTab === 'project-settings' ? (
          <ProjectSettingsPanel
            project={activeProject}
            onProjectUpdated={onProjectUpdated}
            onProjectDeleted={onProjectDeleted}
          />
        ) : null}
      </div>
    </div>
  );
}

function EmptyState({
  projectCount,
  onCreateProject,
}: {
  projectCount: number;
  onCreateProject: () => void;
}) {
  if (projectCount === 0) {
    return (
      <div className="grid h-full place-items-center bg-background">
        <div className="flex max-w-md flex-col items-center gap-4 px-6 text-center">
          <h1 className="text-2xl font-semibold text-foreground">Create your first project</h1>
          <p className="text-sm text-muted-foreground">
            PC-SDK turns a folder on disk into a chat-driven workspace: orchestrator
            conversations and agents scoped to one project at a time.
          </p>
          <button
            onClick={onCreateProject}
            className="bg-primary px-4 py-2 text-sm font-medium text-primary-foreground hover:bg-primary/90"
          >
            Create your first project
          </button>
        </div>
      </div>
    );
  }
  return (
    <div className="grid h-full place-items-center bg-background text-muted-foreground">
      <div className="text-sm">Select a project from the rail.</div>
    </div>
  );
}
