// Mount-state for the agent-run transcript modal — one instance lives at
// Shell level (mirrors the old WorkflowDrawer pattern) so any tab (Activity,
// Agents) can open it without being structurally inside the panel that
// triggered it.

import { create } from 'zustand';
import type { AgentRunDto } from '@pc/contracts';

interface AgentTranscriptState {
  runId: string | null;
  /** Full run snapshot from the opener, used until the resource store has its
   *  own live copy (e.g. opened straight off an HTTP-seeded row). */
  preloadedRun: AgentRunDto | null;
  open: (runId: string, run?: AgentRunDto) => void;
  close: () => void;
}

export const useAgentTranscript = create<AgentTranscriptState>((set) => ({
  runId: null,
  preloadedRun: null,
  open: (runId, run) => set({ runId, preloadedRun: run ?? null }),
  close: () => set({ runId: null, preloadedRun: null }),
}));
