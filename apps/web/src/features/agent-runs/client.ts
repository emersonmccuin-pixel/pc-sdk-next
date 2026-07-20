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

import { getJson, postJson } from '@/api/http';
import {
  isAgentRunDto,
  isAgentRunStatus,
  isChatEvent,
  type AgentRunDto,
  type ChatEvent,
  type ULID,
} from '@pc/contracts';

export type AgentRunTranscriptStatus = 'ready' | 'empty' | 'missing';

/** One backfilled transcript row. `dedupId` mirrors the live `agent-event`
 *  frame's canonical event id exactly so the merge in
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

export interface AgentRunListResponse {
  runs: AgentRunDto[];
  /** Global server outbox high-water captured with the durable list read. */
  asOfCursor: string | null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

export function isAgentRunEventEntry(value: unknown): value is AgentRunEventEntry {
  return (
    isRecord(value) &&
    Object.keys(value).every((key) => key === 'dedupId' || key === 'event') &&
    typeof value.dedupId === 'string' &&
    value.dedupId.length > 0 &&
    isChatEvent(value.event)
  );
}

export function parseAgentRunEventsResponse(value: unknown): AgentRunEventsResponse {
  if (
    !isRecord(value) ||
    Object.keys(value).some((key) => !['events', 'transcriptStatus', 'status'].includes(key)) ||
    !Array.isArray(value.events) ||
    !value.events.every(isAgentRunEventEntry) ||
    (value.transcriptStatus !== 'ready' &&
      value.transcriptStatus !== 'empty' &&
      value.transcriptStatus !== 'missing') ||
    !isAgentRunStatus(value.status)
  ) {
    throw new Error('invalid agent transcript response');
  }
  return {
    events: value.events,
    transcriptStatus: value.transcriptStatus,
    status: value.status,
  };
}

export function parseAgentRunListResponse(value: unknown): AgentRunListResponse {
  if (
    !isRecord(value) ||
    Object.keys(value).some((key) => key !== 'ok' && key !== 'runs' && key !== 'asOfCursor') ||
    value.ok !== true ||
    !Array.isArray(value.runs) ||
    !value.runs.every(isAgentRunDto) ||
    !(
      value.asOfCursor === null ||
      (typeof value.asOfCursor === 'string' && /^(?:0|[1-9][0-9]*)$/u.test(value.asOfCursor))
    )
  ) {
    throw new Error('invalid agent run list response');
  }
  return { runs: value.runs, asOfCursor: value.asOfCursor };
}

export const agentRunsApi = {
  listAgentRuns: (projectId: ULID) =>
    getJson<unknown>(`/api/projects/${projectId}/agent-runs`).then(parseAgentRunListResponse),

  getAgentRunEvents: (projectId: ULID, runId: string) =>
    getJson<unknown>(
      `/api/projects/${projectId}/agent-runs/${runId}/events`,
    ).then(parseAgentRunEventsResponse),

  /** FIX B — clear a terminal recovery run that has nothing to auto-recover.
   *  Server refuses 409 (surfaced as a thrown Error by postJson) when the run
   *  is not eligible, has a bound stranded worktree, or a sealed deliverable. */
  dismissRun: (projectId: ULID, runId: string) =>
    postJson<{ ok: true; run: AgentRunDto }>(
      `/api/projects/${projectId}/agent-runs/${runId}/dismiss`,
      {},
    ).then((r) => r.run),
};
