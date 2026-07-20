import { useEffect, useId, useMemo, useState } from 'react';
import type {
  SubscriptionQuotaObservation,
  SubscriptionQuotaSnapshot,
} from '@pc/contracts';

interface SubscriptionQuotaPanelProps {
  snapshot: SubscriptionQuotaSnapshot | null;
  runtimeId: string | null;
  accountId: string | null;
  selectionResolved?: boolean;
  /** Overrides the "Subscription quota" heading/aria-label — the usage
   *  dashboard renders one panel per registered runtime+account and passes a
   *  runtime-specific title so each region stays distinguishable. */
  title?: string;
}

function formatResetIn(resetsAt: number | null, now: number): string | null {
  if (resetsAt === null) return null;
  const ms = resetsAt - now;
  if (ms <= 0) return 'reset boundary passed';
  const mins = Math.round(ms / 60_000);
  if (mins < 60) return `resets in ${mins}m`;
  const hours = Math.floor(mins / 60);
  const rem = mins % 60;
  if (hours < 24) return `resets in ${hours}h${rem === 0 ? '' : ` ${rem}m`}`;
  const days = Math.floor(hours / 24);
  const remH = hours % 24;
  return `resets in ${days}d${remH === 0 ? '' : ` ${remH}h`}`;
}

function QuotaBar({ observation, now }: {
  observation: SubscriptionQuotaObservation;
  now: number;
}) {
  const detailId = useId();
  const stale = now >= observation.staleAt;
  const pct = observation.usedFraction * 100;
  const fill = Math.min(100, pct);
  const enforcement = !stale && observation.limitState === 'rejected'
    ? 'blocked'
    : !stale && observation.limitState === 'warning'
      ? 'warning'
      : !stale && observation.limitState === 'unknown'
        ? 'limit state unknown'
        : null;
  const tone = stale
    ? 'bg-muted-foreground/50'
    : observation.limitState === 'rejected' || pct >= 90
      ? 'bg-destructive'
      : observation.limitState === 'warning' || pct >= 75
        ? 'bg-warning'
        : 'bg-primary';
  const reset = formatResetIn(observation.resetsAt, now);
  const scope = observation.scope.kind === 'model'
    ? ` · ${observation.scope.model}`
    : '';
  const accessibleScope = observation.scope.kind === 'model'
    ? ` for ${observation.scope.model}`
    : '';
  // Bottom line: only the reset countdown, or a plain stale marker. Everything
  // else (confidence, source semantics, observed age) is intentionally dropped —
  // the panel shows what the user acts on: how full, and when it clears.
  const footer = stale ? 'stale' : reset;
  const valueDetail = `${pct.toFixed(0)} percent used${
    stale ? ', stale' : enforcement ? `, ${enforcement}` : ''
  }`;

  return (
    <div className="flex flex-col gap-0.5" data-stale={stale ? 'true' : 'false'}>
      <div className="flex items-center justify-between gap-2 text-[10px] uppercase tracking-wider text-muted-foreground">
        <span className="min-w-0 truncate" title={`${observation.window.label}${scope}`}>
          {observation.window.label}{scope}
        </span>
        <span className={stale ? 'text-muted-foreground' : 'text-foreground/80'}>
          {pct.toFixed(0)}% used{stale ? ' · stale' : enforcement ? ` · ${enforcement}` : ''}
        </span>
      </div>
      <div
        className="relative h-1.5 w-full overflow-hidden bg-muted"
        role="progressbar"
        aria-label={`${observation.window.label}${accessibleScope} subscription quota used`}
        aria-describedby={detailId}
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={Math.round(pct)}
        aria-valuetext={valueDetail}
      >
        <div className={`absolute inset-y-0 left-0 ${tone}`} style={{ width: `${fill}%` }} />
      </div>
      {footer ? (
        <div id={detailId} className="text-[10px] leading-tight text-muted-foreground">
          {footer}
        </div>
      ) : (
        <div id={detailId} className="sr-only">{valueDetail}</div>
      )}
    </div>
  );
}

function unavailableLabel(snapshot: SubscriptionQuotaSnapshot): string {
  switch (snapshot.unavailableReason) {
    case 'unsupported': return 'unsupported';
    case 'not-applicable': return 'not applicable';
    case 'account-unavailable': return 'account unavailable';
    case 'observation-timeout': return 'observation timed out';
    case 'invalid-observation': return 'invalid observation';
    default: return 'temporarily unavailable';
  }
}

export function SubscriptionQuotaPanel({
  snapshot,
  runtimeId,
  accountId,
  selectionResolved = true,
  title = 'Subscription quota',
}: SubscriptionQuotaPanelProps) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | null = null;
    setNow(Date.now());
    const schedule = () => {
      const current = Date.now();
      const nextStaleAt = snapshot?.observations
        .map((item) => item.staleAt)
        .filter((staleAt) => staleAt > current)
        .sort((a, b) => a - b)[0];
      const delay = nextStaleAt === undefined
        ? 60_000
        : Math.min(60_000, Math.max(25, nextStaleAt - current + 1));
      timer = setTimeout(() => {
        setNow(Date.now());
        schedule();
      }, delay);
    };
    schedule();
    return () => {
      if (timer) clearTimeout(timer);
    };
  }, [snapshot]);

  const observations = useMemo(() =>
    [...(snapshot?.observations ?? [])].sort((a, b) =>
      (a.window.durationMs ?? Number.MAX_SAFE_INTEGER) -
        (b.window.durationMs ?? Number.MAX_SAFE_INTEGER) ||
      a.window.label.localeCompare(b.window.label)), [snapshot]);
  const freshLimitState = observations.some((item) =>
    now < item.staleAt && item.limitState === 'rejected')
    ? 'quota blocked'
    : observations.some((item) => now < item.staleAt && item.limitState === 'warning')
      ? 'quota warning'
      : null;

  // Only shown when there is no live snapshot — it explains why nothing renders.
  // With a snapshot present the heading/title already names the runtime+account,
  // so the redundant "runtime · account" line is dropped.
  const attribution = runtimeId && accountId
    ? `${runtimeId} · ${accountId}`
    : selectionResolved
      ? 'no runtime account selected'
      : 'runtime account selection unavailable';

  return (
    <section
      className="max-h-[45vh] shrink-0 overflow-y-auto border-t border-border bg-card/60 px-3 py-2"
      aria-label={title}
    >
      <div className="mb-1 flex items-center justify-between gap-2 text-[10px] uppercase tracking-wider text-muted-foreground">
        <span>{title}</span>
        {snapshot?.availability === 'unavailable' && (
          <span role="status" aria-live="polite" aria-atomic="true" className="font-semibold text-foreground">
            {unavailableLabel(snapshot)}
          </span>
        )}
        {snapshot?.availability === 'available' && freshLimitState && (
          <span role="status" aria-live="polite" aria-atomic="true" className="font-semibold text-foreground">
            {freshLimitState}
          </span>
        )}
      </div>
      {!snapshot && (
        <div className="mb-1.5 truncate text-[10px] text-muted-foreground" title={attribution}>
          {attribution}
        </div>
      )}
      {snapshot?.availability === 'unavailable' ? (
        <div className="text-[10px] leading-tight text-muted-foreground">
          No current percentage available.
        </div>
      ) : observations.length > 0 ? (
        <div className="flex flex-col gap-2">
          {observations.map((observation) => (
            <QuotaBar key={observation.window.id} observation={observation} now={now} />
          ))}
        </div>
      ) : (
        <div className="text-[10px] text-muted-foreground">
          {snapshot
            ? 'No quota windows reported.'
            : selectionResolved
              ? 'Quota not observed yet.'
              : 'Quota unavailable until account selection is resolved.'}
        </div>
      )}
    </section>
  );
}
