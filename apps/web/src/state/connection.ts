// Connection store — WS liveness + orchestrator health + ws-epoch. Written by
// the ws-client (lib/ws-client.ts), read by the StatusBar and any HTTP-seeded
// list that must refetch when the socket re-opens (epoch bump).

import { create } from 'zustand';
import type { OrchestratorHealth } from '@pc/contracts';

export type WsStatus = 'idle' | 'connecting' | 'open' | 'closed';

export interface ProjectConnection {
  status: WsStatus;
  /** From the latest `orchestrator-state` frame; null before the first. */
  orchestratorHealth: OrchestratorHealth | null;
}

interface ConnectionStore extends ProjectConnection {
  /** Bumps on every socket open so HTTP-seeded lists refetch (kills the
   *  "refresh to see new data" bug). */
  epoch: number;
  setStatus: (status: WsStatus) => void;
  setOrchestratorHealth: (health: OrchestratorHealth | null) => void;
  bumpEpoch: () => void;
}

export const useConnectionStore = create<ConnectionStore>((set) => ({
  status: 'idle',
  orchestratorHealth: null,
  epoch: 0,
  setStatus: (status) => set({ status }),
  setOrchestratorHealth: (orchestratorHealth) => set({ orchestratorHealth }),
  bumpEpoch: () => set((s) => ({ epoch: s.epoch + 1 })),
}));

/** The StatusBar reads liveness + orchestrator health here. A single active
 *  socket backs the shown project. */
export function useProjectConnection(): ProjectConnection {
  const status = useConnectionStore((s) => s.status);
  const orchestratorHealth = useConnectionStore((s) => s.orchestratorHealth);
  return { status, orchestratorHealth };
}
