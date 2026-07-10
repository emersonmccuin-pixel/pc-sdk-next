// Right activity panel mount — thin chrome wrapper; ActivityPanel owns the
// running-agents region body (workflow/work-item regions are dead, not
// carried — see docs/phase-2-plan.md).

import type { Project } from '@/features/projects/client';
import { ActivityPanel } from '@/components/ActivityPanel';

interface ActivityMountProps {
  project: Project | null;
  expanded: boolean;
  onExpand: () => void;
}

export function ActivityMount({ project, expanded, onExpand }: ActivityMountProps) {
  return <ActivityPanel project={project} expanded={expanded} onExpand={onExpand} />;
}
