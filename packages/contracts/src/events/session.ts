// Session lifecycle frames (Channel 1). See docs/event-contract.md §Session lifecycle.
// Browser-safe, zero runtime deps.

import type { ULID } from '../shared.ts';
import { isConversationEventFrame, type ConversationEventFrame } from './chat.ts';

/** The session summary the header + rail read. App sessions are server-owned
 *  rows; the SDK `session_id` is captured per turn for `resume`. */
export interface SessionSummary {
  id: string;
  projectId: ULID;
  model: string | null;
  title: string | null;
  status: 'active' | 'ended';
  /** Native continuation is positively safe under the current account. */
  resumable: boolean;
  startedAt: number;
}

export interface SessionChangedFrame {
  type: 'session-changed';
  projectId: ULID;
  transition: 'new-session' | 'resume-session';
  session: SessionSummary | null;
}

/** Full checkpoint of the active session — same frame shape as live. `new-session`
 *  wipes the client timeline + aggregates; replay re-seeds wholesale and
 *  recomputes aggregates from the set. */
export interface SessionReplayFrame {
  type: 'session-replay';
  projectId: ULID;
  sessionId: string;
  highWaterSequence: number;
  events: ConversationEventFrame[];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function hasOnlyKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  const allowed = new Set(keys);
  return Object.keys(value).every((key) => allowed.has(key));
}

export function isSessionSummary(value: unknown): value is SessionSummary {
  return (
    isRecord(value) &&
    typeof value.id === 'string' && value.id.length > 0 &&
    typeof value.projectId === 'string' && value.projectId.length > 0 &&
    (value.model === null || typeof value.model === 'string') &&
    (value.title === null || typeof value.title === 'string') &&
    (value.status === 'active' || value.status === 'ended') &&
    typeof value.resumable === 'boolean' &&
    (value.status === 'ended' || value.resumable === false) &&
    typeof value.startedAt === 'number' && Number.isFinite(value.startedAt)
  );
}

export function isSessionChangedFrame(value: unknown): value is SessionChangedFrame {
  return (
    isRecord(value) &&
    value.type === 'session-changed' &&
    typeof value.projectId === 'string' && value.projectId.length > 0 &&
    (value.transition === 'new-session' || value.transition === 'resume-session') &&
    (
      value.session === null ||
      (isSessionSummary(value.session) && value.session.projectId === value.projectId)
    )
  );
}

export function isSessionReplayFrame(value: unknown): value is SessionReplayFrame {
  if (
    !isRecord(value) ||
    !hasOnlyKeys(value, ['type', 'projectId', 'sessionId', 'highWaterSequence', 'events']) ||
    value.type !== 'session-replay' ||
    typeof value.projectId !== 'string' || value.projectId.length === 0 ||
    typeof value.sessionId !== 'string' || value.sessionId.length === 0 ||
    !Number.isSafeInteger(value.highWaterSequence) ||
    (value.highWaterSequence as number) < 0 ||
    !Array.isArray(value.events)
  ) return false;
  return value.events.every((event) => {
    if (!isConversationEventFrame(event)) return false;
    return (
      event.projectId === value.projectId &&
      event.sessionId === value.sessionId &&
      event.sequence <= (value.highWaterSequence as number)
    );
  });
}
