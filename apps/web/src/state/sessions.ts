// Session lifecycle seam — list / new / resume for the chrome (SessionsRail,
// SessionSwitcher, ProjectRail "new session", the header session switcher).
//
// App sessions are server-owned rows; SessionSummary is the wire type from
// @pc/contracts (never redeclared). The HTTP routes below are REST CRUD the
// server sibling backs — NOT the WS wire.
//
// `applySessionTransition` is the chrome-side seam: it records the active
// session id and bumps a nonce so session-scoped lists refetch. The chat-store
// sibling ALSO reacts to a transition (wipe timeline + reseed from replay); it
// subscribes to this store rather than us inventing a second path.

import { create } from 'zustand';
import { getJson, postJson } from '@/api/http';
import {
  isSessionReplayFrame,
  type SessionReplayFrame,
  type SessionSummary,
  type ULID,
} from '@pc/contracts';

export type { SessionSummary } from '@pc/contracts';

export function canResumeSession(session: SessionSummary): boolean {
  return session.status === 'ended' && session.resumable;
}

export interface SessionTransition {
  transition: 'new-session' | 'resume-session';
  session: SessionSummary;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/** Convert the HTTP checkpoint into the same strict envelope used by live replay. */
export function parseSessionEventsResponse(
  value: unknown,
  projectId: string,
  sessionId: string,
): SessionReplayFrame {
  if (
    !isRecord(value) ||
    Object.keys(value).some((key) => !['ok', 'events', 'highWaterSequence'].includes(key)) ||
    value.ok !== true
  ) {
    throw new Error('invalid session events response');
  }
  const replay: unknown = {
    type: 'session-replay',
    projectId,
    sessionId,
    highWaterSequence: value.highWaterSequence,
    events: value.events,
  };
  if (!isSessionReplayFrame(replay)) throw new Error('invalid session events response');
  return replay;
}

export const sessionsApi = {
  listSessions: (projectId: ULID) =>
    getJson<{ ok: true; sessions: SessionSummary[] }>(
      `/api/projects/${encodeURIComponent(projectId)}/sessions`,
    ).then((r) => r.sessions),

  newSession: (projectId: ULID) =>
    postJson<{ ok: true } & SessionTransition>(
      `/api/projects/${encodeURIComponent(projectId)}/sessions/new`,
      {},
    ),

  resumeSession: (projectId: ULID, targetSessionId: string) =>
    postJson<{ ok: true } & SessionTransition>(
      `/api/projects/${encodeURIComponent(projectId)}/sessions/${encodeURIComponent(targetSessionId)}/resume`,
      {},
    ),

  /** Past-session viewing: the same canonical event shape as live, rendered read-only
   *  through the same pipeline. */
  sessionEvents: (projectId: ULID, sessionId: string) =>
    getJson<unknown>(
      `/api/projects/${encodeURIComponent(projectId)}/sessions/${encodeURIComponent(sessionId)}/events`,
    ).then((response) => parseSessionEventsResponse(response, projectId, sessionId)),
};

interface SessionNavState {
  /** Active session id per project id (null = none / launcher). */
  activeByProject: Record<string, string | null>;
  /** Ticks on every transition so session-scoped lists refetch without
   *  scanning the chat timeline. */
  nonce: number;
  applyTransition: (projectId: string, t: SessionTransition) => void;
  setActive: (projectId: string, sessionId: string | null) => void;
}

export const useSessionNav = create<SessionNavState>((set) => ({
  activeByProject: {},
  nonce: 0,
  applyTransition: (projectId, t) =>
    set((s) => ({
      activeByProject: { ...s.activeByProject, [projectId]: t.session.id },
      nonce: s.nonce + 1,
    })),
  setActive: (projectId, sessionId) =>
    set((s) => ({
      activeByProject: { ...s.activeByProject, [projectId]: sessionId },
    })),
}));
