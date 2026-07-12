// Channel 3 — Agent transcript streaming (latency-class, no replay). See
// docs/event-contract.md. `agent-event` frames never persist to a durable
// store client-side; a missed one heals on modal open via HTTP backfill
// (features/agent-runs/transcript.ts merges by dedupId). This is just the
// live buffer: newest N per runId, so a transcript modal opened mid-run
// still shows the frames that arrived before it mounted.
//
// SEAM: the ws-client sibling calls `applyAgentEventFrame` for every incoming
// `{ type: 'agent-event' }` frame. Nothing wires it yet.

import { create } from 'zustand';
import { isAgentEventFrame, type AgentEventFrame } from '@pc/contracts';

const MAX_PER_RUN = 500;

interface AgentEventStoreState {
  byRunId: Map<string, AgentEventFrame[]>;
  applyAgentEventFrame: (frame: unknown) => void;
  clearAll: () => void;
}

export const useAgentEventStore = create<AgentEventStoreState>((set, get) => ({
  byRunId: new Map(),
  applyAgentEventFrame: (frame) => {
    if (!isAgentEventFrame(frame)) return;
    const byRunId = get().byRunId;
    const existing = byRunId.get(frame.runId) ?? [];
    // dedupId collision (re-delivery) — drop, don't double-append.
    if (existing.some((f) => f.dedupId === frame.dedupId)) return;
    const next = existing.length >= MAX_PER_RUN ? existing.slice(1) : existing.slice();
    next.push(frame);
    const nextMap = new Map(byRunId);
    nextMap.set(frame.runId, next);
    set({ byRunId: nextMap });
  },
  clearAll: () => set({ byRunId: new Map() }),
}));

const EMPTY: AgentEventFrame[] = [];

export function useLiveAgentEvents(runId: string | null): AgentEventFrame[] {
  return useAgentEventStore((s) => (runId ? (s.byRunId.get(runId) ?? EMPTY) : EMPTY));
}
