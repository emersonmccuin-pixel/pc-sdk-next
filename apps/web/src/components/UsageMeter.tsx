// Header usage meter (NEW). Compact 5h / 7d plan-quota gauge for the selected
// account. Reads the usage store (seam); a sibling wires the `usage` resource
// event into it. Neutral "—" until the first snapshot — never a fake number.
// `rejected` / `allowed_warning` surface loudly (premortem tripwire).

import { useAccounts } from '@/state/accounts';
import { useUsageSnapshot } from '@/state/usage-store';

function pctTone(util: number): string {
  if (util >= 0.9) return 'bg-destructive';
  if (util >= 0.75) return 'bg-warning';
  return 'bg-primary';
}

function Gauge({ label, util }: { label: string; util: number | null }) {
  const has = util !== null;
  const pct = has ? Math.max(0, Math.min(1, util)) * 100 : 0;
  return (
    <div className="flex items-center gap-1" title={`${label}: ${has ? `${Math.round((util ?? 0) * 100)}%` : 'no data'}`}>
      <span className="text-[9px] uppercase tracking-wider text-foreground/50">{label}</span>
      <span className="relative block h-1.5 w-10 overflow-hidden bg-muted" aria-hidden>
        <span className={`absolute inset-y-0 left-0 ${has ? pctTone(util ?? 0) : ''}`} style={{ width: `${pct}%` }} />
      </span>
    </div>
  );
}

export function UsageMeter() {
  const selectedId = useAccounts((s) => s.selectedId);
  const snapshot = useUsageSnapshot(selectedId);

  const warn = snapshot?.status === 'allowed_warning';
  const rejected = snapshot?.status === 'rejected';

  return (
    <div
      className={`flex items-center gap-2 px-2 py-1 ${
        rejected ? 'text-destructive' : warn ? 'text-warning' : 'text-muted-foreground'
      }`}
      data-testid="usage-meter"
      data-usage-status={snapshot?.status ?? 'unknown'}
    >
      <Gauge label="5h" util={snapshot?.fiveHour?.utilization ?? null} />
      <Gauge label="7d" util={snapshot?.sevenDay?.utilization ?? null} />
      {rejected && <span className="text-[10px] uppercase tracking-wider">quota hit</span>}
      {warn && <span className="text-[10px] uppercase tracking-wider">near cap</span>}
    </div>
  );
}
