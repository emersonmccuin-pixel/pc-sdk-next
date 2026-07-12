// The orchestrator chat body: live timeline + composer, or a read-only
// past-session view (same render pipeline over HTTP-fetched frames). The socket
// api is owned by the mount above; send is optimistic (a clientMessageId-stamped
// placeholder shows immediately, reconciled by the canonical user frame or a
// delivered send-queue item).

import { useEffect, useState } from 'react';

import type { Project } from '@/features/projects/client';
import type { SessionReplayFrame } from '@pc/contracts';
import { useChatStore } from '@/state/chat-store';
import { useConnectionStore } from '@/state/connection';
import { sessionsApi } from '@/state/sessions';
import { useViewingSession } from '@/store/viewing-session';
import { randomId, type SocketApi } from '@/lib/ws-client';
import { ChatTimeline, PastSessionTimeline } from './ChatTimeline';
import { ChatComposer } from './ChatComposer';

export function isTurnBusy(activeTurnId: string | null): boolean {
  return activeTurnId !== null;
}

export function ChatSurface({ project, api }: { project: Project; api: SocketApi | null }) {
  const state = useChatStore((s) => s.state);
  const addOptimistic = useChatStore((s) => s.addOptimistic);
  const answerAsk = useChatStore((s) => s.answerAsk);
  const activeTurnId = useConnectionStore((s) => s.activeTurnId);
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

  const busy = isTurnBusy(activeTurnId);

  function handleSend(
    text: string,
    retry?: { commandId: string; clientMessageId: string; sessionId: string | null },
  ): { commandId: string; clientMessageId: string; submitted: boolean } {
    const commandId = retry?.commandId ?? randomId();
    const clientMessageId = retry?.clientMessageId ?? randomId();
    const targetSessionId = retry ? retry.sessionId : state.sessionId;
    if (retry && targetSessionId !== state.sessionId) {
      return { commandId, clientMessageId, submitted: false };
    }
    if (!api) return { commandId, clientMessageId, submitted: false };
    const ok = api.sendText({ commandId, sessionId: targetSessionId, text, clientMessageId });
    if (ok) addOptimistic(commandId, clientMessageId, text);
    return { commandId, clientMessageId, submitted: ok };
  }

  function handleEdit(queueItemId: string, expectedRevision: number, text: string): string | null {
    if (!api || !state.sessionId) return null;
    const commandId = randomId();
    return api.editQueued({
      commandId,
      sessionId: state.sessionId,
      queueItemId,
      expectedRevision,
      text,
    }) ? commandId : null;
  }

  function handleRemove(queueItemId: string, expectedRevision: number): string | null {
    if (!api || !state.sessionId) return null;
    const commandId = randomId();
    return api.removeQueued({
      commandId,
      sessionId: state.sessionId,
      queueItemId,
      expectedRevision,
    }) ? commandId : null;
  }

  function handleInterrupt(input: {
    requestId: string;
    sessionId: string;
    targetTurnId: string;
  }): boolean {
    if (!api || input.sessionId !== state.sessionId) return false;
    return api.interrupt(input);
  }

  function handleInterruptAndSend(
    replacement:
      | { kind: 'new'; text: string }
      | { kind: 'queued'; queueItemId: string; expectedRevision: number },
    identity?: {
      requestId: string;
      clientMessageId?: string;
      sessionId: string;
      targetTurnId: string;
    },
  ): { requestId: string; clientMessageId?: string } | null {
    const targetSessionId = identity?.sessionId ?? state.sessionId;
    const targetTurnId = identity?.targetTurnId ?? activeTurnId;
    if (!api || !targetSessionId || !targetTurnId || targetSessionId !== state.sessionId) return null;
    const requestId = identity?.requestId ?? randomId();
    if (replacement.kind === 'new') {
      const clientMessageId = identity?.clientMessageId ?? randomId();
      const ok = api.interruptAndSend({
        requestId,
        sessionId: targetSessionId,
        targetTurnId,
        replacement: { kind: 'new', clientMessageId, text: replacement.text },
      });
      if (!ok) return null;
      addOptimistic(requestId, clientMessageId, replacement.text);
      return { requestId, clientMessageId };
    }
    return api.interruptAndSend({
      requestId,
      sessionId: targetSessionId,
      targetTurnId,
      replacement,
    }) ? { requestId } : null;
  }

  function handleAskReply(askId: string, answer: string) {
    if (api?.askReply(askId, answer)) answerAsk(askId, answer);
  }

  return (
    <>
      <ChatTimeline state={state} onAskReply={handleAskReply} />
      <ChatComposer
        key={project.id}
        projectId={project.id}
        historyKey={project.slug}
        onSend={handleSend}
        onEdit={handleEdit}
        onRemove={handleRemove}
        onInterrupt={handleInterrupt}
        onInterruptAndSend={handleInterruptAndSend}
        sessionState={state.aggregates.sessionState}
        currentActivity={state.currentActivity}
        latestModel={state.aggregates.latestModel}
        busy={busy}
        sessionId={state.sessionId}
        sessionContextReady={state.sessionContextReady}
        contextProjectionReady={state.contextProjectionReady}
        contextProjection={state.contextProjection}
        activeTurnId={activeTurnId}
        sendQueue={state.sendQueue}
        optimistic={state.optimistic}
        acceptedClientMessageIds={state.acceptedClientMessageIds}
        cancelledClientMessages={state.cancelledClientMessages}
        interrupts={state.interrupts}
        latestInterruptRequestId={state.latestInterruptRequestId}
        commandReceipts={state.commandReceipts}
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
  const [replay, setReplay] = useState<SessionReplayFrame | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setReplay(null);
    setError(null);
    sessionsApi
      .sessionEvents(projectId, sessionId)
      .then((checkpoint) => {
        if (!cancelled) setReplay(checkpoint);
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
      ) : replay === null ? (
        <div className="p-4 text-sm text-muted-foreground">Loading session…</div>
      ) : (
        <PastSessionTimeline replay={replay} />
      )}
    </>
  );
}
