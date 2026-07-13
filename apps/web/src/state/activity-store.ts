// Activity data seam — running + recovery-retained agent runs for ActivityMount
// and the Agents header. Backed by the resource-store live overlay plus the
// authoritative HTTP seed (features/agent-runs/use-project-agent-runs.ts).

import { useMemo } from 'react';

import type { Project } from '@/features/projects/client';
import {
  useProjectAgentRuns,
  type AgentRunReadStatus,
  type AgentRunView,
} from '@/features/agent-runs/use-project-agent-runs';

export interface ActivitySummary {
  runningCount: number;
  runs: AgentRunView[];
  /** Server-retained and bounded-recent terminal outcomes. Presentation
   *  deduplicates these against stronger contract/worktree evidence. */
  preserved: AgentRunView[];
  runReadStatus: AgentRunReadStatus;
  runReadError: string | null;
  retryRunRead: () => void;
}

export function useProjectActivity(project: Project | null): ActivitySummary {
  const { runs, preserved, readStatus, readError, retry } = useProjectAgentRuns(project);
  return useMemo(() => ({
    runningCount: runs.length,
    runs,
    preserved,
    runReadStatus: readStatus,
    runReadError: readError,
    retryRunRead: retry,
  }), [runs, preserved, readStatus, readError, retry]);
}
