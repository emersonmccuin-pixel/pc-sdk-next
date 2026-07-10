// Session lifecycle frames (Channel 1). See docs/event-contract.md §Session lifecycle.
// Browser-safe, zero runtime deps.

import type { ULID } from '../shared.ts';
import type { ChatFrame } from './chat.ts';

/** The session summary the header + rail read. App sessions are server-owned
 *  rows; the SDK `session_id` is captured per turn for `resume`. */
export interface SessionSummary {
  id: string;
  projectId: ULID;
  model: string | null;
  title: string | null;
  status: 'active' | 'ended';
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
  highWaterSeq: number;
  events: ChatFrame[];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

export function isSessionSummary(value: unknown): value is SessionSummary {
  return (
    isRecord(value) &&
    typeof value.id === 'string' &&
    typeof value.projectId === 'string' &&
    (value.model === null || typeof value.model === 'string') &&
    (value.title === null || typeof value.title === 'string') &&
    (value.status === 'active' || value.status === 'ended') &&
    typeof value.startedAt === 'number'
  );
}

export function isSessionChangedFrame(value: unknown): value is SessionChangedFrame {
  return (
    isRecord(value) &&
    value.type === 'session-changed' &&
    (value.transition === 'new-session' || value.transition === 'resume-session') &&
    (value.session === null || isSessionSummary(value.session))
  );
}
