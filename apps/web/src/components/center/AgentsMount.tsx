// Agents tab (center) — roster viewing (AgentsList, read-only — see
// features/agents/client.ts). Running-run inspection lives in the Activity
// rail (visible from any tab) and opens the same AgentTranscriptModal.

import type { Project } from '@/features/projects/client';
import { AgentsList } from '@/components/AgentsList';
import { ConversationHeader } from '@/components/ConversationHeader';
import { useProjectActivity } from '@/state/activity-store';

export function AgentsMount({ project }: { project: Project }) {
  const activity = useProjectActivity(project);
  return (
    <div className="flex h-full flex-col bg-background">
      <ConversationHeader
        title={<span className="font-medium">Agents</span>}
        subtitle={project.name}
        status={activity.runningCount > 0 ? `${activity.runningCount} running` : undefined}
      />
      <div className="flex-1 overflow-hidden">
        <AgentsList project={project} />
      </div>
    </div>
  );
}
