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
import type { ChatFrame, SessionSummary, ULID } from '@pc/contracts';

export type { SessionSummary } from '@pc/contracts';

export interface SessionTransition {
  transition: 'new-session' | 'resume-session';
  session: SessionSummary;
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

  /** Past-session viewing: the same ChatFrame shape as live, rendered read-only
   *  through the same pipeline. */
  sessionEvents: (projectId: ULID, sessionId: string) =>
    getJson<{ ok: true; events: ChatFrame[]; highWaterSeq: number }>(
      `/api/projects/${encodeURIComponent(projectId)}/sessions/${encodeURIComponent(sessionId)}/events`,
    ).then((r) => r.events),
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
