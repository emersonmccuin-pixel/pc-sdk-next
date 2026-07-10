// 5h-above-7d usage caps pinned to the bottom of the left rail. Reads the usage
// store (UsageSnapshot per account) — a sibling wires the `usage` resource event
// into it. Neutral "—" placeholders until the first snapshot arrives.

import { useEffect, useState } from 'react';

import type { UsageSnapshot } from '@/state/usage-store';

interface UsageCapsPanelProps {
  snapshot: UsageSnapshot | null;
}

type Window5h7d = { utilization: number; resetsAt: number | null } | null;

function formatResetIn(resetsAt: number | null | undefined, now: number): string {
  if (!resetsAt) return '—';
  const ms = resetsAt - now;
  if (ms <= 0) return 'resetting…';
  const mins = Math.round(ms / 60_000);
  if (mins < 60) return `${mins}m`;
  const hours = Math.floor(mins / 60);
  const rem = mins % 60;
  if (hours < 24) return rem === 0 ? `${hours}h` : `${hours}h ${rem}m`;
  const days = Math.floor(hours / 24);
  const remH = hours % 24;
  return remH === 0 ? `${days}d` : `${days}d ${remH}h`;
}

function CapBar({ label, window, now }: { label: string; window: Window5h7d; now: number }) {
  const hasData = window !== null;
  const pct = hasData ? Math.max(0, window.utilization * 100) : 0;
  const fill = Math.min(100, pct);
  const tone = pct >= 90 ? 'bg-destructive' : pct >= 75 ? 'bg-warning' : 'bg-primary';
  const resetIn = formatResetIn(window?.resetsAt, now);
  return (
    <div className="flex flex-col gap-0.5">
      <div className="flex items-center justify-between text-[10px] uppercase tracking-wider text-muted-foreground">
        <span>{label}</span>
        <span className="text-foreground/70">{hasData ? `${pct.toFixed(0)}%` : '—'}</span>
      </div>
      <div className="relative h-1.5 w-full overflow-hidden bg-muted">
        <div className={`absolute inset-y-0 left-0 ${tone}`} style={{ width: `${fill}%` }} />
      </div>
      <div className="text-[10px] text-muted-foreground/80">
        {hasData ? `resets in ${resetIn}` : '—'}
      </div>
    </div>
  );
}

export function UsageCapsPanel({ snapshot }: UsageCapsPanelProps) {
  // Tick once a minute so "resets in" stays live without spamming re-renders.
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 60_000);
    return () => clearInterval(id);
  }, []);

  const rejected = snapshot?.status === 'rejected';
  const warning = snapshot?.status === 'allowed_warning';

  return (
    <div className="border-t border-border bg-card/60 px-3 py-2">
      <div className="mb-1.5 flex items-center justify-between text-[10px] uppercase tracking-wider text-muted-foreground">
        <span>Usage</span>
        {/* premortem #3 tripwire — rejected/warning must never be quiet. */}
        {rejected && <span className="text-destructive">quota hit</span>}
        {!rejected && warning && <span className="text-warning">near cap</span>}
      </div>
      <div className="flex flex-col gap-2">
        <CapBar label="5h" window={snapshot?.fiveHour ?? null} now={now} />
        <CapBar label="7d" window={snapshot?.sevenDay ?? null} now={now} />
      </div>
    </div>
  );
}
