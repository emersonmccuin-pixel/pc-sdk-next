// Breadcrumb-mounted dropdown for switching between recent sessions of the
// active project. Click a row → resumes that session; "browse all" → flips the
// left rail into Sessions mode. Rebound to the session seam.

import { useEffect, useRef, useState } from 'react';

import {
  canResumeSession,
  sessionContinuationLabel,
  sessionResumeLabel,
  sessionSelectionLabel,
  sessionsApi,
  type SessionSummary,
  type SessionTransition,
  useSessionNav,
} from '@/state/sessions';
import { useRailMode } from '@/store/rail-mode';
import { useViewingSession } from '@/store/viewing-session';

interface SessionSwitcherProps {
  projectId: string;
  projectSlug: string;
  activeSessionId: string | null;
  anchorEl: HTMLElement | null;
  onClose: () => void;
  applySessionTransition: (transition: SessionTransition) => void;
}

export function SessionSwitcher({
  projectId,
  projectSlug,
  activeSessionId,
  anchorEl,
  onClose,
  applySessionTransition,
}: SessionSwitcherProps) {
  const [sessions, setSessions] = useState<SessionSummary[]>([]);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState<string | null>(null);
  const [resumingId, setResumingId] = useState<string | null>(null);
  const sessionUpdatedNonce = useSessionNav((s) => s.nonce);
  const setRailMode = useRailMode((s) => s.setMode);
  const setViewing = useViewingSession((s) => s.setViewing);
  const panelRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    let cancelled = false;
    sessionsApi
      .listSessions(projectId)
      .then((rows) => {
        if (!cancelled) {
          setSessions(rows);
          setLoading(false);
        }
      })
      .catch((e: Error) => {
        if (!cancelled) {
          setErr(e.message);
          setLoading(false);
        }
      });
    return () => {
      cancelled = true;
    };
  }, [projectId, sessionUpdatedNonce]);

  useEffect(() => {
    function onClick(e: MouseEvent) {
      const target = e.target as Node;
      if (panelRef.current?.contains(target)) return;
      if (anchorEl?.contains(target)) return;
      onClose();
    }
    function onKey(e: KeyboardEvent) {
      if (e.key === 'Escape') onClose();
    }
    document.addEventListener('mousedown', onClick);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onClick);
      document.removeEventListener('keydown', onKey);
    };
  }, [anchorEl, onClose]);

  const rect = anchorEl?.getBoundingClientRect();
  const style: React.CSSProperties = rect
    ? { position: 'fixed', top: rect.bottom + 4, left: rect.left, zIndex: 50 }
    : { display: 'none' };

  async function handleResume(targetId: string) {
    if (targetId === activeSessionId) {
      onClose();
      return;
    }
    if (resumingId) return;
    setResumingId(targetId);
    try {
      const transition = await sessionsApi.resumeSession(projectId, targetId);
      applySessionTransition(transition);
      setViewing(projectSlug, null);
      onClose();
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setResumingId(null);
    }
  }

  return (
    <div
      ref={panelRef}
      role="menu"
      style={style}
      className="min-w-[280px] max-w-[420px] border border-primary/40 bg-popover text-popover-foreground shadow-2xl"
    >
      <div className="border-b border-border px-3 py-1.5 text-[9px] uppercase tracking-[0.12em] text-muted-foreground">
        recent sessions
      </div>
      <div className="max-h-[360px] overflow-y-auto">
        {loading && <div className="px-3 py-2 text-xs text-muted-foreground">Loading…</div>}
        {err && <div className="px-3 py-2 text-xs text-destructive">Error: {err}</div>}
        {!loading && !err && sessions.length === 0 && (
          <div className="px-3 py-2 text-xs text-muted-foreground">No sessions yet.</div>
        )}
        {sessions.slice(0, 12).map((s) => {
          const isActive = s.id === activeSessionId;
          const title = s.title?.trim() || 'Untitled session';
          const when = formatStarted(s.startedAt);
          const isResuming = resumingId === s.id;
          const canActivate = isActive || canResumeSession(s);
          const selection = sessionSelectionLabel(s);
          const continuation = sessionContinuationLabel(s);
          const availability = isActive ? 'live' : sessionResumeLabel(s);
          return (
            <button
              key={s.id}
              type="button"
              onClick={() => {
                if (canActivate) void handleResume(s.id);
              }}
              disabled={!canActivate || (resumingId !== null && !isResuming)}
              title={[
                isActive ? 'Live session' : canResumeSession(s) ? 'Resume this session' : availability,
                selection,
                continuation,
              ].join('\n')}
              className={`block w-full border-l-2 px-3 py-1.5 text-left text-xs hover:bg-muted ${
                isActive ? 'border-primary bg-muted/40 text-primary' : 'border-transparent text-foreground/90'
              }`}
            >
              <div className="flex items-center gap-2">
                {isActive && (
                  <span className="h-1.5 w-1.5 shrink-0 rounded-full bg-emerald-500" title="live" />
                )}
                <span className="truncate">{title}</span>
              </div>
              <div className="mt-0.5 truncate text-[10px] text-muted-foreground" title={selection}>
                {selection}
              </div>
              <div className="text-[10px] text-muted-foreground">
                {when} · {continuation} · {isResuming ? 'resuming…' : availability}
              </div>
            </button>
          );
        })}
      </div>
      <button
        type="button"
        data-testid="session-switcher-browse-all"
        onClick={() => {
          setRailMode('sessions');
          onClose();
        }}
        className="block w-full border-t border-border px-3 py-1.5 text-left text-[10px] uppercase tracking-[0.08em] text-muted-foreground hover:bg-muted hover:text-accent"
      >
        browse all sessions →
      </button>
    </div>
  );
}

function formatStarted(ms: number): string {
  const d = new Date(ms);
  const today = new Date();
  const sameDay =
    d.getFullYear() === today.getFullYear() &&
    d.getMonth() === today.getMonth() &&
    d.getDate() === today.getDate();
  if (sameDay) return d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
  return (
    d.toLocaleDateString([], { month: 'short', day: 'numeric' }) +
    ' ' +
    d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })
  );
}
