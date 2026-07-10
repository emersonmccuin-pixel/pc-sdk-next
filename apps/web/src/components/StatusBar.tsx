// Bottom status footer for the chat panel. Slimmed to the new contract: MCP
// health pill (from `mcp-server` resource events, via the mcp-status seam),
// orchestrator health (from `orchestrator-state`), and WS liveness. The PTY-era
// runtime snapshot (waitPoint, jsonl cursors, respawn counters) is gone.

import { useEffect, useRef } from 'react';

import type { WsStatus } from '@/state/connection';
import { useMcpStatus } from '@/state/mcp-status';
import { useMcpPanel } from '@/store/mcp-panel';
import type { OrchestratorHealth } from '@pc/contracts';

interface StatusBarProps {
  projectName: string | null;
  wsStatus: WsStatus;
  orchestratorHealth: OrchestratorHealth | null;
}

const WS_PILL: Record<WsStatus, { dot: string; label: string; title: string }> = {
  open: { dot: 'bg-emerald-500', label: 'live', title: 'WebSocket connected' },
  connecting: { dot: 'bg-amber-500', label: '…', title: 'WebSocket connecting' },
  closed: { dot: 'bg-red-500', label: 'offline', title: 'WebSocket disconnected — retrying' },
  idle: { dot: 'bg-zinc-500', label: '—', title: 'No project selected' },
};

const HEALTH_PILL: Record<OrchestratorHealth, { dot: string; label: string; title: string }> = {
  idle: { dot: 'bg-zinc-500', label: 'idle', title: 'Orchestrator idle' },
  starting: { dot: 'bg-amber-500', label: 'starting', title: 'Orchestrator starting' },
  busy: { dot: 'bg-sky-500', label: 'busy', title: 'Orchestrator processing a turn' },
  failed: { dot: 'bg-red-500', label: 'failed', title: 'Orchestrator turn failed' },
};

export function StatusBar({ wsStatus, orchestratorHealth }: StatusBarProps) {
  const servers = useMcpStatus((s) => s.servers);
  const showMcp = useMcpPanel((s) => s.open);
  const setShowMcp = useMcpPanel((s) => s.setOpen);
  const panelRef = useRef<HTMLDivElement | null>(null);
  const pillRef = useRef<HTMLButtonElement | null>(null);

  const healthy = servers.filter((s) => s.status === 'healthy');
  const toolCount = healthy.reduce((n, s) => n + (s.toolCount ?? 0), 0);
  const anyAlive = healthy.length > 0;
  const healthPill = orchestratorHealth ? HEALTH_PILL[orchestratorHealth] : null;

  useEffect(() => {
    if (!showMcp) return;
    function onClick(e: MouseEvent) {
      const target = e.target as Node;
      if (panelRef.current?.contains(target)) return;
      if (pillRef.current?.contains(target)) return;
      setShowMcp(false);
    }
    document.addEventListener('mousedown', onClick);
    return () => document.removeEventListener('mousedown', onClick);
  }, [showMcp, setShowMcp]);

  return (
    <div className="relative shrink-0 border-t border-border bg-card">
      <div className="flex items-center gap-3 px-3 py-1 text-[10px] uppercase tracking-[0.04em] text-muted-foreground">
        <button
          ref={pillRef}
          type="button"
          onClick={() => setShowMcp(!showMcp)}
          aria-expanded={showMcp}
          aria-label="MCP server status — click for details"
          className={`flex items-center gap-1.5 rounded px-1.5 py-0.5 hover:bg-muted ${
            showMcp ? 'bg-muted text-foreground' : ''
          }`}
        >
          <span
            className={`inline-block h-1.5 w-1.5 rounded-full ${anyAlive ? 'bg-emerald-500' : 'bg-zinc-500'}`}
            aria-hidden
          />
          <span className="text-foreground/50">mcp</span>
          <span className="tabular-nums text-foreground">
            {servers.length === 0 ? 'offline' : `${toolCount} tools`}
          </span>
        </button>

        <span className="text-[var(--fg-dim)]">│</span>

        <span
          className="flex items-center gap-1.5"
          title={healthPill?.title ?? 'Orchestrator status unavailable'}
          data-testid="orchestrator-pill"
          data-orchestrator-health={orchestratorHealth ?? 'unknown'}
        >
          <span
            className={`inline-block h-1.5 w-1.5 rounded-full ${healthPill?.dot ?? 'bg-zinc-500'}`}
            aria-hidden
          />
          <span className="text-foreground/50">orchestrator</span>
          <span className="tabular-nums text-foreground">{healthPill?.label ?? 'unknown'}</span>
        </span>

        <span className="text-[var(--fg-dim)]">│</span>

        <span
          className="flex items-center gap-1.5"
          title={WS_PILL[wsStatus].title}
          data-testid="ws-pill"
          data-ws-status={wsStatus}
        >
          <span className={`inline-block h-1.5 w-1.5 rounded-full ${WS_PILL[wsStatus].dot}`} aria-hidden />
          <span className="text-foreground/50">ws</span>
          <span className="tabular-nums text-foreground">{WS_PILL[wsStatus].label}</span>
        </span>

        <span className="ml-auto text-[var(--fg-dim)]">pc-sdk</span>
      </div>

      {showMcp && (
        <div
          ref={panelRef}
          role="dialog"
          aria-label="MCP server details"
          className="absolute bottom-full left-0 right-0 mb-1 max-h-72 overflow-y-auto border-t border-border bg-card px-3 py-2 text-xs shadow-lg"
        >
          {servers.length === 0 ? (
            <p className="py-2 text-muted-foreground">
              No MCP servers reporting yet. Health arrives as the server probes
              its registry; unknown is a valid state.
            </p>
          ) : (
            <ul className="space-y-0.5 font-mono text-[11px] text-foreground/90">
              {servers.map((s) => (
                <li key={s.id} className="flex items-center justify-between rounded px-1.5 py-0.5 hover:bg-muted">
                  <span>{s.name}</span>
                  <span className="text-muted-foreground">
                    {s.status}
                    {s.toolCount != null ? ` · ${s.toolCount} tools` : ''}
                  </span>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
    </div>
  );
}
