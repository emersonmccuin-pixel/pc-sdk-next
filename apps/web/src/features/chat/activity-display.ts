import type { CurrentActivityProjection } from './chat-reducer';

export const STILL_WAITING_THRESHOLD_MS = 8_000;

export interface ActivityDisplay {
  text: string;
  elapsedMs: number;
  stillWaiting: boolean;
}

function positiveDuration(now: number, then: number): number {
  return Math.max(0, now - then);
}

function sourceText(activity: CurrentActivityProjection): string {
  const source = activity.source;
  if (source.kind === 'tool') {
    switch (source.state) {
      case 'requested':
        return `Preparing · ${source.safeSummary}`;
      case 'approval-needed':
        return `Waiting for approval · ${source.safeSummary}`;
      case 'running':
        return `Running · ${source.safeSummary}`;
      case 'succeeded':
        return `Reviewing result · ${source.safeSummary}`;
      case 'failed':
        return `Tool failed · ${source.safeSummary}`;
      case 'denied':
        return `Tool denied · ${source.safeSummary}`;
    }
  }
  switch (source.phase) {
    case 'turn-starting':
      return 'Starting the turn';
    case 'requesting-runtime':
      return 'Waiting for the runtime';
    case 'responding':
      return 'Writing a response';
    case 'retrying':
      return 'Retrying the runtime request';
    case 'compacting':
      return 'Compacting conversation context';
  }
}

export function deriveActivityDisplay(
  activity: CurrentActivityProjection | null,
  now: number,
  thresholdMs = STILL_WAITING_THRESHOLD_MS,
): ActivityDisplay | null {
  if (!activity) return null;
  const base = sourceText(activity);
  const stillWaiting = positiveDuration(now, activity.updatedAt) >= Math.max(0, thresholdMs);
  return {
    text: stillWaiting ? `Still waiting · ${base}` : base,
    elapsedMs: positiveDuration(now, activity.startedAt),
    stillWaiting,
  };
}

export function formatActivityElapsed(elapsedMs: number): string {
  const totalSeconds = Math.max(0, Math.floor(elapsedMs / 1_000));
  if (totalSeconds < 60) return `${totalSeconds}s`;
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${minutes}m ${seconds.toString().padStart(2, '0')}s`;
}
