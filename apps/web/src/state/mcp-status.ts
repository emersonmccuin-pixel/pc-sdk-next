// MCP status seam — the StatusBar pill. In the new contract MCP health arrives
// as `mcp-server` resource events (full snapshot per server). A sibling (MCP
// client core / manager) wires those into this store; the stub reports null so
// the pill shows "offline" without a data path. Degrade, never block.

import { create } from 'zustand';

export interface McpServerStatus {
  id: string;
  name: string;
  status: 'healthy' | 'degraded' | 'down' | 'unknown';
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
