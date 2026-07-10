// Merge HTTP backfill + the live agent-event buffer into one ordered,
// deduped transcript. Backfill first (it's the historical prefix), then live
// frames for this run — both keyed by the SAME dedupId scheme, so a frame
// that arrived live before the backfill request resolved doesn't double up.

import type { AgentEventFrame, ChatEvent } from '@pc/contracts';
import type { AgentRunEventEntry, AgentRunTranscriptStatus } from './client';

export interface AgentTranscriptItem {
  key: string;
  event: ChatEvent;
}

export type AgentTranscriptLoadStatus = 'loading' | 'ready' | 'error';

export function mergeAgentTranscriptEvents(input: {
  runId: string;
  backfillEvents: AgentRunEventEntry[];
  liveEvents: AgentEventFrame[];
}): AgentTranscriptItem[] {
  const out: AgentTranscriptItem[] = [];
  const seen = new Set<string>();

  function push(dedupId: string, event: ChatEvent): void {
    if (seen.has(dedupId)) return;
    seen.add(dedupId);
    out.push({ key: dedupId, event });
  }

  for (const entry of input.backfillEvents) push(entry.dedupId, entry.event);
  for (const frame of input.liveEvents) {
    if (frame.runId !== input.runId) continue;
    push(frame.dedupId, frame.event);
  }
  return out;
}

/** Empty-state copy — mirrors the live run's lifecycle so "no rows yet"
 *  never reads as ambiguous (frozen vs. still loading). No PTY diagnostics
 *  language ("Claude is loading…" etc.) since there's no PTY to wait on. */
export function agentTranscriptEmptyMessage(input: {
  loadStatus: AgentTranscriptLoadStatus;
  transcriptStatus: AgentRunTranscriptStatus | null;
  runStatus?: string;
}): string {
  if (input.runStatus === 'queued' || input.runStatus === 'spawning') {
    return 'Starting… the transcript will appear here.';
  }
  if (input.loadStatus === 'loading') return 'Loading transcript…';
  if (input.loadStatus === 'error') return 'Live transcript starts here.';
  if (input.transcriptStatus === 'missing') {
    return 'No stored transcript. Live transcript starts here.';
  }
  if (input.transcriptStatus === 'empty') {
    return 'Transcript is empty so far. Live transcript starts here.';
  }
  if (input.runStatus === 'running') return 'Working… output will appear here shortly.';
  return 'No transcript events yet.';
}
