// LeftRail — Projects list is the canonical view. Sessions mode is reachable
// via the header SessionSwitcher's "browse all sessions →" link; a small
// "‹ projects" back link returns to the project list. The old files-rail
// override is gone (files browser deleted).

import type { Project } from '@/features/projects/client';
import type { SessionTransition } from '@/state/sessions';
import { useRailMode } from '@/store/rail-mode';
import { ProjectRail } from './ProjectRail';
import { SessionsRail } from './SessionsRail';

interface LeftRailProps {
  projects: Project[];
  activeProject: Project | null;
  sessionChangedNonce: number;
  applySessionTransition: (transition: SessionTransition) => void;
  onCreateProject: () => void;
  onProjectDeleted: (projectId: string) => void;
  onProjectReorder: (orderedIds: string[]) => void;
  unreadProjectIds: ReadonlySet<string>;
  liveSessionProjectIds: ReadonlySet<string>;
  onSessionsChanged: () => void;
  showCommandSpace: boolean;
}

export function LeftRail({
  projects,
  activeProject,
  sessionChangedNonce,
  applySessionTransition,
  onCreateProject,
  onProjectDeleted,
  onProjectReorder,
  unreadProjectIds,
  liveSessionProjectIds,
  onSessionsChanged,
  showCommandSpace,
}: LeftRailProps) {
  const mode = useRailMode((s) => s.mode);
  const setMode = useRailMode((s) => s.setMode);

  if (mode === 'sessions') {
    return (
      <div className="flex h-full flex-col">
        <button
          onClick={() => setMode('projects')}
          className="border-b border-border bg-card px-3 py-2 text-left text-[10px] uppercase tracking-[0.08em] text-muted-foreground hover:text-accent"
          title="Back to projects"
        >
          ‹ projects
        </button>
        <div className="flex-1 overflow-hidden">
          <SessionsRail
            project={activeProject}
            sessionChangedNonce={sessionChangedNonce}
            applySessionTransition={applySessionTransition}
          />
        </div>
      </div>
    );
  }

  return (
    <ProjectRail
      projects={projects}
      onCreateProject={onCreateProject}
      onProjectDeleted={onProjectDeleted}
      onProjectReorder={onProjectReorder}
      unreadProjectIds={unreadProjectIds}
      liveSessionProjectIds={liveSessionProjectIds}
      onSessionsChanged={onSessionsChanged}
      showCommandSpace={showCommandSpace}
    />
  );
}
