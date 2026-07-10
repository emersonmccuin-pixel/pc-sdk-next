// Agent-run HTTP client — trimmed to the read-side Phase 2 needs (running
// list + transcript backfill). Dispatch/cancel/kill/inspect (PTY-era
// diagnostics) are Phase 3 (specialist builder + dispatch) surface; not
// carried here.
//
// LOOSE END: `/api/projects/:id/agent-runs` (list) is an assumed path
// mirroring the transcript-backfill path the event contract DOES specify
// (`GET /api/projects/:pid/agent-runs/:runId/events`). The server sibling
// must implement both; until then `listAgentRuns` 404s and the running-agents
// region shows its empty state (degrade, never block).

import { getJson } from '@/api/http';
import type { AgentRunDto, ChatEvent, ULID } from '@pc/contracts';

export type AgentRunTranscriptStatus = 'ready' | 'empty' | 'missing';

/** One backfilled transcript row. `dedupId` mirrors the live `agent-event`
 *  frame's key exactly (`sdkUuid ?? kind:tool:toolUseId`) so the merge in
 *  transcript.ts is a single dedup pass, not two different id schemes. */
export interface AgentRunEventEntry {
  dedupId: string;
  event: ChatEvent;
}

export interface AgentRunEventsResponse {
  events: AgentRunEventEntry[];
  transcriptStatus: AgentRunTranscriptStatus;
  status: AgentRunDto['status'];
}

export const agentRunsApi = {
  listAgentRuns: (projectId: ULID) =>
    getJson<{ runs: AgentRunDto[] }>(`/api/projects/${projectId}/agent-runs`).then(
      (r) => r.runs,
    ),

  getAgentRunEvents: (projectId: ULID, runId: string) =>
    getJson<AgentRunEventsResponse>(
      `/api/projects/${projectId}/agent-runs/${runId}/events`,
    ),
};
