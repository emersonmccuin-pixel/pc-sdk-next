// The orchestrator chat body: live timeline + composer, or a read-only
// past-session view (same render pipeline over HTTP-fetched frames). The socket
// api is owned by the mount above; send is optimistic (a clientMessageId-stamped
// placeholder shows immediately, reconciled by the canonical user frame or a
// delivered send-queue item).

import { useEffect, useState } from 'react';

import type { Project } from '@/features/projects/client';
import type { ChatFrame } from '@pc/contracts';
import { useChatStore } from '@/state/chat-store';
import { sessionsApi } from '@/state/sessions';
import { useViewingSession } from '@/store/viewing-session';
import { randomId, type SocketApi } from '@/lib/ws-client';
import { ChatTimeline, PastSessionTimeline } from './ChatTimeline';
import { ChatComposer } from './ChatComposer';

export function ChatSurface({ project, api }: { project: Project; api: SocketApi | null }) {
  const state = useChatStore((s) => s.state);
  const addOptimistic = useChatStore((s) => s.addOptimistic);
  const answerAsk = useChatStore((s) => s.answerAsk);
  const viewingSessionId = useViewingSession((s) => s.bySlug[project.slug] ?? null);
  const setViewing = useViewingSession((s) => s.setViewing);

  if (viewingSessionId) {
    return (
      <PastSessionView
        projectId={project.id}
        sessionId={viewingSessionId}
        onExit={() => setViewing(project.slug, null)}
      />
    );
  }

  const busy = state.aggregates.sessionState === 'running';

  function handleSend(text: string): boolean {
    if (!api) return false;
    const clientMessageId = randomId();
    const ok = api.sendText(text, clientMessageId);
    if (ok) addOptimistic(clientMessageId, text);
    return ok;
  }

  function handleAskReply(askId: string, answer: string) {
    api?.askReply(askId, answer);
    answerAsk(askId, answer);
  }

  return (
    <>
      <ChatTimeline state={state} onAskReply={handleAskReply} />
      <ChatComposer
        projectId={project.id}
        historyKey={project.slug}
        onSend={handleSend}
        onInterrupt={() => api?.interrupt() ?? false}
        sessionState={state.aggregates.sessionState}
        busy={busy}
      />
    </>
  );
}

function PastSessionView({
  projectId,
  sessionId,
  onExit,
}: {
  projectId: string;
  sessionId: string;
  onExit: () => void;
}) {
  const [frames, setFrames] = useState<ChatFrame[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setFrames(null);
    setError(null);
    sessionsApi
      .sessionEvents(projectId, sessionId)
      .then((rows) => {
        if (!cancelled) setFrames(rows);
      })
      .catch((e: Error) => {
        if (!cancelled) setError(e.message);
      });
    return () => {
      cancelled = true;
    };
  }, [projectId, sessionId]);

  return (
    <>
      <div className="flex items-center justify-between border-b border-warning/40 bg-warning/10 px-4 py-1.5 text-xs">
        <span className="text-warning">Viewing a past session (read-only)</span>
        <button
          type="button"
          onClick={onExit}
          className="border border-border px-2 py-0.5 text-[10px] uppercase tracking-wider hover:bg-muted"
        >
          Back to live
        </button>
      </div>
      {error ? (
        <div className="p-4 text-sm text-destructive">Failed to load session: {error}</div>
      ) : frames === null ? (
        <div className="p-4 text-sm text-muted-foreground">Loading session…</div>
      ) : (
        <PastSessionTimeline frames={frames} />
      )}
    </>
  );
}
