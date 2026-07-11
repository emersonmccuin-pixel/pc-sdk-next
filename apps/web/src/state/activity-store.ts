// Activity data seam — running-agents summary for ActivityMount's collapsed
// gutter badge + AgentsMount's header status. Backed by the resource-store
// live overlay + HTTP seed (features/agent-runs/use-project-agent-runs.ts).
// Workflow/work-item regions from the old ActivityPanel are dead; this is
// running agents only, per the port ledger.

import { useMemo } from 'react';

import type { Project } from '@/features/projects/client';
import { useProjectAgentRuns, type AgentRunView } from '@/features/agent-runs/use-project-agent-runs';

export interface ActivitySummary {
  runningCount: number;
  runs: AgentRunView[];
  /** Terminal runs parked in a preserved lifecycle state (merge-ready,
   *  conflict, stranded, review-rejected, failed) — visible until resolved. */
  preserved: AgentRunView[];
}

export function useProjectActivity(project: Project | null): ActivitySummary {
  const { runs, preserved } = useProjectAgentRuns(project);
  return useMemo(() => ({ runningCount: runs.length, runs, preserved }), [runs, preserved]);
}
