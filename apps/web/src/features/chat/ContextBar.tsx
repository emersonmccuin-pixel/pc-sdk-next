import type { ContextUnavailableReason } from '@pc/contracts';

import type { SessionContextProjection } from './chat-reducer';

export type ContextBarState =
  | 'loading'
  | 'no-session'
  | 'not-observed'
  | 'stale'
  | 'compacted'
  | 'unavailable'
  | 'available';

export interface ContextBarPresentation {
  state: ContextBarState;
  label: string;
  title: string;
  percent: number | null;
  compactionLabel: string | null;
}

function formatTokens(tokens: number): string {
  return tokens.toLocaleString('en-US');
}

function unavailableLabel(reason: ContextUnavailableReason): string {
  switch (reason) {
    case 'unsupported': return 'unsupported by this runtime';
    case 'runtime-unavailable': return 'runtime observation unavailable';
    case 'invalid-observation': return 'runtime observation was invalid';
    case 'observation-timeout': return 'observation timed out';
  }
}

function compactionLabel(
  compaction: SessionContextProjection['latestCompaction'],
): string | null {
  if (!compaction) return null;
  const trigger = compaction.trigger === 'unknown' ? '' : ` ${compaction.trigger}`;
  if (compaction.preTokens === null && compaction.postTokens === null) {
    return `compacted${trigger} · token counts unavailable`;
  }
  const tokens = `${compaction.preTokens === null ? '…' : formatTokens(compaction.preTokens)} → ${
    compaction.postTokens === null ? '…' : formatTokens(compaction.postTokens)
  }`;
  return `compacted${trigger} · ${tokens} tokens`;
}

export function deriveContextBarPresentation(input: {
  sessionId: string | null;
  ready: boolean;
  projection: SessionContextProjection;
}): ContextBarPresentation {
  const { sessionId, ready, projection } = input;
  const latestCompactionLabel = compactionLabel(projection.latestCompaction);
  if (sessionId === null) {
    return {
      state: 'no-session',
      label: 'Unavailable · no active session',
      title: 'Context use becomes available after a session starts.',
      percent: null,
      compactionLabel: null,
    };
  }
  if (!ready) {
    return {
      state: 'loading',
      label: 'Loading session context…',
      title: 'Waiting for the authoritative session replay.',
      percent: null,
      compactionLabel: latestCompactionLabel,
    };
  }

  if (projection.integrity === 'conflicted') {
    return {
      state: 'unavailable',
      label: 'Unavailable · context replay conflict',
      title: 'Conflicting canonical evidence prevents a current context percentage.',
      percent: null,
      compactionLabel: null,
    };
  }

  const observation = projection.observation;
  const compactionIsCurrent = projection.latestCompaction !== null
    && (observation === null || projection.latestCompaction.sequence > observation.sequence);
  if (compactionIsCurrent) {
    return {
      state: 'compacted',
      label: 'Compacted · awaiting a current observation',
      title: 'Compaction invalidated the prior context percentage.',
      percent: null,
      compactionLabel: latestCompactionLabel,
    };
  }
  if (projection.freshness === 'stale') {
    return {
      state: 'stale',
      label: 'Prior observation stale · awaiting current observation',
      title: 'Newer context-changing evidence arrived after the last accepted observation.',
      percent: null,
      compactionLabel: latestCompactionLabel,
    };
  }
  if (!observation) {
    return {
      state: 'not-observed',
      label: 'Not yet observed',
      title: 'No runtime context observation has been recorded for this session.',
      percent: null,
      compactionLabel: latestCompactionLabel,
    };
  }
  if (observation.observation.confidence === 'unavailable') {
    const reason = unavailableLabel(observation.observation.reason);
    return {
      state: 'unavailable',
      label: `Unavailable · ${reason}`,
      title: `The current turn has no usable context percentage: ${reason}.`,
      percent: null,
      compactionLabel: latestCompactionLabel,
    };
  }

  const value = observation.observation;
  const percent = Math.round((value.usedTokens / value.usableTokens) * 100);
  const approximation = value.confidence === 'approximate' ? '≈' : '';
  const confidence = value.confidence === 'exact' ? 'exact' : value.confidence;
  return {
    state: 'available',
    label: `${approximation}${percent}% used · ${formatTokens(value.usedTokens)} / ${formatTokens(value.usableTokens)} · ${confidence}`,
    title: `Context window ${formatTokens(value.contextWindowTokens)} tokens; ${confidence} observation.`,
    percent,
    compactionLabel: latestCompactionLabel,
  };
}

export function ContextBar({
  sessionId,
  ready,
  projection,
  readOnly = false,
}: {
  sessionId: string | null;
  ready: boolean;
  projection: SessionContextProjection;
  readOnly?: boolean;
}) {
  const presentation = deriveContextBarPresentation({ sessionId, ready, projection });
  return (
    <div
      className="flex min-w-0 items-center gap-2 border border-border bg-background/60 px-2 py-1 text-[10px] text-muted-foreground"
      data-testid="context-bar"
      data-context-state={presentation.state}
      title={`${presentation.title}${readOnly ? ' Read-only session history.' : ''}`}
    >
      <span className="shrink-0 uppercase tracking-[0.06em] text-[var(--fg-dim)]">context</span>
      {presentation.percent === null ? (
        <div className="h-1.5 min-w-10 flex-1 overflow-hidden bg-muted" aria-hidden="true" />
      ) : (
        <div
          className="h-1.5 min-w-10 flex-1 overflow-hidden bg-muted"
          role="progressbar"
          aria-label="Session context used"
          aria-valuemin={0}
          aria-valuemax={100}
          aria-valuenow={presentation.percent}
        >
          <div
            className="h-full bg-primary"
            data-testid="context-bar-fill"
            style={{ width: `${presentation.percent}%` }}
          />
        </div>
      )}
      <span className="min-w-0 max-w-[55%] truncate" data-testid="context-bar-label">
        {presentation.label}
      </span>
      {presentation.compactionLabel && (
        <span
          className="min-w-0 max-w-40 shrink truncate border-l border-border pl-2 text-[var(--fg-dim)]"
          data-testid="context-bar-compaction"
        >
          {presentation.compactionLabel}
        </span>
      )}
    </div>
  );
}
