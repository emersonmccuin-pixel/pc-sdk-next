// MCP status seam — the StatusBar pill. MCP health arrives as `mcp-server`
// resource events (full snapshot per server); ws-client wires those in here.
// Degrade, never block: an unreachable/auth-expired server still reports its
// explicit state, never a guess.

import { create } from 'zustand';

export interface McpServerStatus {
  id: string;
  name: string;
  status: 'healthy' | 'degraded' | 'down' | 'auth-expired' | 'unknown';
  toolCount: number | null;
}

interface McpStatusState {
  servers: McpServerStatus[];
  setServers: (servers: McpServerStatus[]) => void;
}

export const useMcpStatus = create<McpStatusState>((set) => ({
  servers: [],
  setServers: (servers) => set({ servers }),
}));
