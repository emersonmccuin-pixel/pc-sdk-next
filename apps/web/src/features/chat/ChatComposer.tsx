// Orchestrator composer: draft persistence + prompt history + image paste
// (POST → path spliced into text) + send + interrupt. Send returns a bool so
// the caller can keep the text on a closed socket.

import React, { useCallback, useEffect, useRef, useState } from 'react';
import type { ConversationCommandReceiptFrame, SendQueueItem } from '@pc/contracts';

import { uploadPastedImage } from '@/features/pasted-images/client';
import { randomId } from '@/lib/ws-client';
import type {
  CurrentActivityProjection,
  InterruptProjection,
  OptimisticSend,
} from './chat-reducer';
import { deriveActivityDisplay, formatActivityElapsed } from './activity-display';

const PROMPT_HISTORY_CAP = 100;

export function canSubmitDraft(text: string, hasPendingSend: boolean): boolean {
  return !hasPendingSend && text.trim().length > 0;
}

export function canRemoveQueueItem(
  item: Pick<SendQueueItem, 'origin' | 'status' | 'interruptRequestId'>,
): boolean {
  return item.origin === 'user' && (
    (item.status === 'queued' && !item.interruptRequestId) || item.status === 'failed'
  );
}

function historyKeyFor(key: string) {
  return `pc:prompt-history:${key}`;
}
function draftKeyFor(key: string) {
  return `pc:composer-draft:${key}`;
}
function pendingKeyFor(key: string) {
  return `pc:composer-pending:${key}`;
}
interface PendingSend {
  mode: 'send' | 'interrupt-and-send';
  commandId: string;
  clientMessageId: string;
  sessionId: string | null;
  targetTurnId: string | null;
  text: string;
  submitted: boolean;
}
function readHistory(key: string): string[] {
  try {
    const raw = localStorage.getItem(historyKeyFor(key));
    const arr = raw ? (JSON.parse(raw) as unknown) : [];
    return Array.isArray(arr) ? arr.filter((x): x is string => typeof x === 'string') : [];
  } catch {
    return [];
  }
}
function writeHistory(key: string, list: string[]) {
  try {
    localStorage.setItem(historyKeyFor(key), JSON.stringify(list));
  } catch {
    /* best effort */
  }
}
function readDraft(key: string): string {
  try {
    return localStorage.getItem(draftKeyFor(key)) ?? '';
  } catch {
    return '';
  }
}
function writeDraft(key: string, value: string) {
  try {
    if (value) localStorage.setItem(draftKeyFor(key), value);
    else localStorage.removeItem(draftKeyFor(key));
  } catch {
    /* best effort */
  }
}
function readPending(key: string): PendingSend | null {
  try {
    const value = JSON.parse(localStorage.getItem(pendingKeyFor(key)) ?? 'null') as unknown;
    if (
      value !== null && typeof value === 'object' &&
      ((value as PendingSend).mode === 'send' || (value as PendingSend).mode === 'interrupt-and-send') &&
      typeof (value as PendingSend).commandId === 'string' &&
      typeof (value as PendingSend).clientMessageId === 'string' &&
      ((value as PendingSend).sessionId === null || typeof (value as PendingSend).sessionId === 'string') &&
      ((value as PendingSend).targetTurnId === null || typeof (value as PendingSend).targetTurnId === 'string') &&
      typeof (value as PendingSend).text === 'string' &&
      typeof (value as PendingSend).submitted === 'boolean'
    ) return value as PendingSend;
  } catch {
    // Malformed local state is treated as absent.
  }
  return null;
}
function writePending(key: string, value: PendingSend | null): void {
  try {
    if (value) localStorage.setItem(pendingKeyFor(key), JSON.stringify(value));
    else localStorage.removeItem(pendingKeyFor(key));
  } catch {
    /* best effort */
  }
}

export function ChatComposer({
  projectId,
  historyKey,
  onSend,
  onEdit,
  onRemove,
  onInterrupt,
  onInterruptAndSend,
  sessionState,
  currentActivity,
  latestModel,
  busy,
  sessionId,
  sessionContextReady,
  activeTurnId,
  sendQueue,
  optimistic,
  acceptedClientMessageIds,
  cancelledClientMessages,
  interrupts,
  latestInterruptRequestId,
  commandReceipts,
}: {
  projectId: string;
  historyKey: string;
  onSend: (
    text: string,
    retry?: { commandId: string; clientMessageId: string; sessionId: string | null },
  ) => { commandId: string; clientMessageId: string; submitted: boolean };
  onEdit: (queueItemId: string, expectedRevision: number, text: string) => string | null;
  onRemove: (queueItemId: string, expectedRevision: number) => string | null;
  onInterrupt: (input: { requestId: string; sessionId: string; targetTurnId: string }) => boolean;
  onInterruptAndSend: (replacement:
    | { kind: 'new'; text: string }
    | { kind: 'queued'; queueItemId: string; expectedRevision: number },
    identity?: {
      requestId: string;
      clientMessageId?: string;
      sessionId: string;
      targetTurnId: string;
    },
  ) => { requestId: string; clientMessageId?: string } | null;
  sessionState: string | null;
  currentActivity: CurrentActivityProjection | null;
  latestModel: string | null;
  busy: boolean;
  sessionId: string | null;
  sessionContextReady: boolean;
  activeTurnId: string | null;
  sendQueue: SendQueueItem[];
  optimistic: OptimisticSend[];
  acceptedClientMessageIds: Record<string, true>;
  cancelledClientMessages: Record<string, string | null>;
  interrupts: Record<string, InterruptProjection>;
  latestInterruptRequestId: string | null;
  commandReceipts: Record<string, ConversationCommandReceiptFrame>;
}) {
  const [text, setText] = useState(() => readDraft(historyKey));
  const [pendingSend, setPendingSend] = useState<PendingSend | null>(() => readPending(historyKey));
  const [pendingInterruptId, setPendingInterruptId] = useState<string | null>(null);
  const [socketError, setSocketError] = useState<string | null>(null);
  const [editing, setEditing] = useState<{
    itemId: string;
    expectedRevision: number;
    text: string;
  } | null>(null);
  const [rowCommand, setRowCommand] = useState<{ itemId: string; commandId: string } | null>(null);
  const [activityClock, setActivityClock] = useState(() => Date.now());
  const [pasteUpload, setPasteUpload] = useState<{ uploading: number; errors: string[] } | null>(null);
  const textareaRef = useRef<HTMLTextAreaElement | null>(null);
  const historyRef = useRef<string[]>(readHistory(historyKey));
  const [historyIdx, setHistoryIdx] = useState<number | null>(null);
  const draftKeyRef = useRef(historyKey);
  const pendingKeyRef = useRef(historyKey);
  const createdPendingIdsRef = useRef(new Set<string>());

  const composerMinPx = 56;
  const composerMaxPx = 200;

  const resizeTextarea = useCallback(() => {
    const el = textareaRef.current;
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = `${Math.max(composerMinPx, Math.min(el.scrollHeight, composerMaxPx))}px`;
  }, []);
  useEffect(() => {
    resizeTextarea();
  }, [text, resizeTextarea]);

  useEffect(() => {
    historyRef.current = readHistory(historyKey);
    setHistoryIdx(null);
    setText(readDraft(historyKey));
    setPendingSend(readPending(historyKey));
    createdPendingIdsRef.current.clear();
    setPendingInterruptId(null);
    setSocketError(null);
    setEditing(null);
    setRowCommand(null);
  }, [historyKey]);

  useEffect(() => {
    if (draftKeyRef.current !== historyKey) {
      draftKeyRef.current = historyKey;
      return;
    }
    writeDraft(historyKey, text);
  }, [text, historyKey]);

  useEffect(() => {
    if (pendingKeyRef.current !== historyKey) {
      pendingKeyRef.current = historyKey;
      return;
    }
    writePending(historyKey, pendingSend);
  }, [historyKey, pendingSend]);

  function setPendingDurably(next: PendingSend | null): void {
    if (next === null && pendingSend) createdPendingIdsRef.current.delete(pendingSend.commandId);
    writePending(historyKey, next);
    setPendingSend(next);
  }

  useEffect(() => {
    setPendingInterruptId(null);
    setEditing(null);
    setRowCommand(null);
  }, [sessionId]);

  useEffect(() => {
    if (!busy) return;
    setActivityClock(Date.now());
    const timer = window.setInterval(() => setActivityClock(Date.now()), 1_000);
    return () => window.clearInterval(timer);
  }, [busy, currentActivity?.sequence]);

  function rememberCommittedPrompt(committed: string): void {
    const hist = historyRef.current;
    if (hist[hist.length - 1] !== committed) {
      hist.push(committed);
      if (hist.length > PROMPT_HISTORY_CAP) hist.splice(0, hist.length - PROMPT_HISTORY_CAP);
      writeHistory(historyKey, hist);
    }
    setHistoryIdx(null);
  }

  const pendingProjection = pendingSend
    ? optimistic.find((send) => send.clientMessageId === pendingSend.clientMessageId)
    : undefined;
  const pendingQueueItem = pendingSend
    ? sendQueue.find((item) => item.clientMessageId === pendingSend.clientMessageId)
    : undefined;
  const pendingWasCancelled = pendingSend
    ? Object.prototype.hasOwnProperty.call(cancelledClientMessages, pendingSend.clientMessageId)
    : false;
  const pendingStatus = pendingSend && acceptedClientMessageIds[pendingSend.clientMessageId]
    ? 'accepted'
    : pendingWasCancelled
      ? 'cancelled'
      : pendingProjection?.status ?? pendingQueueItem?.status;
  useEffect(() => {
    if (!pendingSend || !pendingStatus || pendingStatus === 'sending') return;
    if (pendingStatus !== 'failed' && pendingStatus !== 'cancelled') {
      rememberCommittedPrompt(pendingSend.text);
      setText((current) => current === pendingSend.text ? '' : current);
    } else if (pendingStatus === 'cancelled') {
      setSocketError(
        cancelledClientMessages[pendingSend.clientMessageId] ??
          'Queued message was cancelled before delivery — the draft was kept',
      );
    }
    setPendingDurably(null);
  // The transition is keyed by durable client identity; historyKey is stable for this composer.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pendingStatus, pendingSend?.clientMessageId]);

  useEffect(() => {
    if (!pendingSend || pendingStatus) return;
    if (
      pendingSend.sessionId === null &&
      sessionId !== null &&
      createdPendingIdsRef.current.has(pendingSend.commandId)
    ) {
      setPendingDurably({ ...pendingSend, sessionId });
      return;
    }
    if (!sessionContextReady) return;
    if (pendingSend.sessionId !== sessionId) {
      setPendingDurably(null);
      setSocketError('Session changed before delivery was confirmed — the draft was kept');
    }
  // Session context is authoritative only after replay/snapshot; terminal evidence wins first.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sessionId, sessionContextReady, pendingStatus, pendingSend?.commandId]);

  const rowReceipt = rowCommand ? commandReceipts[rowCommand.commandId] : undefined;
  useEffect(() => {
    if (!rowCommand || !rowReceipt) return;
    if (rowReceipt.status === 'applied' || rowReceipt.status === 'duplicate') {
      setEditing(null);
      setRowCommand(null);
    }
  }, [rowCommand, rowReceipt]);

  function submit() {
    if (!canSubmitDraft(text, pendingSend !== null)) return;
    const trimmed = text.trim();
    const pending: PendingSend = {
      mode: 'send',
      commandId: randomId(),
      clientMessageId: randomId(),
      sessionId,
      targetTurnId: null,
      text: trimmed,
      submitted: false,
    };
    createdPendingIdsRef.current.add(pending.commandId);
    // Persist retry identity before the socket write can commit anything.
    setPendingDurably(pending);
    const result = onSend(trimmed, pending);
    setPendingDurably({ ...pending, submitted: result.submitted });
    if (!result.submitted) {
      setSocketError('Not connected — draft was kept');
      return;
    }
    setSocketError(null);
  }

  function retryPendingSend(): void {
    if (!pendingSend) return;
    if (pendingSend.sessionId !== null && pendingSend.sessionId !== sessionId) {
      setSocketError('This request belongs to another session and was not retried');
      return;
    }
    if (pendingSend.mode === 'interrupt-and-send') {
      if (!pendingSend.sessionId || !pendingSend.targetTurnId) {
        setSocketError('The original interrupt target is unavailable');
        return;
      }
      const result = onInterruptAndSend(
        { kind: 'new', text: pendingSend.text },
        {
          requestId: pendingSend.commandId,
          clientMessageId: pendingSend.clientMessageId,
          sessionId: pendingSend.sessionId,
          targetTurnId: pendingSend.targetTurnId,
        },
      );
      setPendingDurably({ ...pendingSend, submitted: result !== null });
      setSocketError(result ? null : 'Still not connected — draft was kept');
      return;
    }
    const result = onSend(pendingSend.text, pendingSend);
    setPendingDurably({ ...pendingSend, submitted: result.submitted });
    setSocketError(result.submitted ? null : 'Still not connected — draft was kept');
  }

  function clickInterrupt() {
    if (!sessionId || !activeTurnId) return;
    const requestId = randomId();
    setPendingInterruptId(requestId);
    const submitted = onInterrupt({ requestId, sessionId, targetTurnId: activeTurnId });
    if (!submitted) {
      setPendingInterruptId(null);
      setSocketError('Interrupt was not submitted — connection or turn changed');
      return;
    }
    setSocketError(null);
    setPendingInterruptId(requestId);
  }

  function interruptAndSendDraft(): void {
    if (!canSubmitDraft(text, pendingSend !== null)) return;
    const trimmed = text.trim();
    if (!sessionId || !activeTurnId) return;
    const pending: PendingSend = {
      mode: 'interrupt-and-send',
      commandId: randomId(),
      clientMessageId: randomId(),
      sessionId,
      targetTurnId: activeTurnId,
      text: trimmed,
      submitted: false,
    };
    createdPendingIdsRef.current.add(pending.commandId);
    setPendingDurably(pending);
    setPendingInterruptId(pending.commandId);
    const result = onInterruptAndSend(
      { kind: 'new', text: trimmed },
      {
        requestId: pending.commandId,
        clientMessageId: pending.clientMessageId,
        sessionId,
        targetTurnId: activeTurnId,
      },
    );
    if (!result?.clientMessageId) {
      setPendingDurably({ ...pending, submitted: false });
      setSocketError('Interrupt-and-send was not submitted');
      return;
    }
    setSocketError(null);
    setPendingInterruptId(result.requestId);
    setPendingDurably({ ...pending, submitted: true });
  }

  function interruptAndSendHead(item: SendQueueItem): void {
    if (!sessionId || !activeTurnId) return;
    const requestId = randomId();
    setPendingInterruptId(requestId);
    const result = onInterruptAndSend({
      kind: 'queued',
      queueItemId: item.id,
      expectedRevision: item.revision,
    }, { requestId, sessionId, targetTurnId: activeTurnId });
    if (!result) {
      setPendingInterruptId(null);
      setSocketError('Interrupt-and-send was not submitted');
      return;
    }
    setSocketError(null);
    setPendingInterruptId(result.requestId);
  }

  function navHistory(direction: -1 | 1) {
    const hist = historyRef.current;
    if (hist.length === 0) return;
    if (direction === -1) {
      const next = historyIdx === null ? hist.length - 1 : Math.max(0, historyIdx - 1);
      setHistoryIdx(next);
      setText(hist[next] ?? '');
    } else {
      if (historyIdx === null) return;
      const next = historyIdx + 1;
      if (next >= hist.length) {
        setHistoryIdx(null);
        setText('');
      } else {
        setHistoryIdx(next);
        setText(hist[next] ?? '');
      }
    }
  }

  function appendPath(path: string): void {
    setText((prev) => {
      const sep = prev.length > 0 && !/\s$/.test(prev) ? ' ' : '';
      return prev + sep + path + ' ';
    });
  }

  async function handlePaste(e: React.ClipboardEvent<HTMLTextAreaElement>): Promise<void> {
    const imageItems: DataTransferItem[] = [];
    for (let i = 0; i < e.clipboardData.items.length; i++) {
      const item = e.clipboardData.items[i];
      if (item && item.type.startsWith('image/')) imageItems.push(item);
    }
    if (imageItems.length === 0) return;
    e.preventDefault();
    const blobs = imageItems.map((it) => it.getAsFile()).filter((b): b is File => b !== null);
    if (blobs.length === 0) return;

    const errors: string[] = [];
    let remaining = blobs.length;
    setPasteUpload({ uploading: remaining, errors: [] });
    for (const blob of blobs) {
      const result = await uploadPastedImage(projectId, blob);
      remaining -= 1;
      if (result.ok) appendPath(result.path);
      else errors.push(result.error);
      setPasteUpload(remaining > 0 ? { uploading: remaining, errors: [...errors] } : null);
      if (remaining === 0 && errors.length > 0) {
        setPasteUpload({ uploading: 0, errors: [...errors] });
        setTimeout(() => setPasteUpload(null), 4000);
      }
    }
  }

  const historyLen = historyRef.current.length;
  const stateTone =
    sessionState === 'requires_action'
      ? 'bg-warning'
      : sessionState === 'running'
        ? 'bg-primary'
        : sessionState === 'idle'
          ? 'bg-foreground/40'
          : 'bg-foreground/20';
  const queuedClientIds = new Set(sendQueue.map((item) => item.clientMessageId));
  const precommit = optimistic.filter((send) =>
    !queuedClientIds.has(send.clientMessageId) && send.status !== 'accepted' && send.status !== 'cancelled');
  const uncertainPending = pendingSend && !pendingStatus &&
    !precommit.some((send) => send.clientMessageId === pendingSend.clientMessageId)
    ? pendingSend
    : null;
  const queueHead = sendQueue.find((item) => item.status === 'queued') ?? null;
  const latestCanonicalInterrupt = latestInterruptRequestId
    ? interrupts[latestInterruptRequestId]
    : undefined;
  const displayedInterruptId = pendingInterruptId ?? latestCanonicalInterrupt?.requestId ?? null;
  const interruptProjection = displayedInterruptId
    ? interrupts[displayedInterruptId] ?? latestCanonicalInterrupt
    : undefined;
  const interruptReceipt = displayedInterruptId ? commandReceipts[displayedInterruptId] : undefined;
  const interruptPending = displayedInterruptId !== null &&
    !interruptProjection && interruptReceipt?.status !== 'rejected';
  const interruptLabel = interruptProjection?.state === 'requested'
    ? 'Interrupt requested'
    : interruptProjection?.state === 'confirmed'
      ? 'Interrupt confirmed'
      : interruptProjection?.state === 'failed'
        ? `Interrupt failed: ${interruptProjection.failure?.message ?? 'unknown failure'}`
        : interruptReceipt?.status === 'rejected'
          ? `Interrupt rejected: ${interruptReceipt.error?.message ?? 'request rejected'}`
          : interruptPending
            ? 'Saving interrupt request…'
            : null;
  const activityDisplay = busy
    ? deriveActivityDisplay(currentActivity, activityClock)
    : null;
  const queuedCount = sendQueue.filter((item) => item.status === 'queued').length;

  return (
    <div className="flex flex-col gap-1.5 border-t border-border bg-card px-4 py-2.5">
      {busy && (
        <div
          className="flex items-center gap-2 border border-primary/25 bg-primary/5 px-2 py-1 text-[10px] text-muted-foreground"
          data-testid="current-activity"
        >
          <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-primary" />
          <span className="min-w-0 flex-1 truncate text-foreground">
            {activityDisplay?.text ?? 'Starting the turn'}
          </span>
          {latestModel && <span className="truncate text-[var(--fg-dim)]">{latestModel}</span>}
          <span className="font-mono">{formatActivityElapsed(activityDisplay?.elapsedMs ?? 0)}</span>
          <span>{queuedCount} queued</span>
        </div>
      )}
      {(uncertainPending || precommit.length > 0 || sendQueue.length > 0) && (
        <div className="flex max-h-40 flex-col gap-1 overflow-y-auto border border-border bg-background/60 p-1.5" data-testid="send-queue-tray">
          <div className="px-1 text-[9px] uppercase tracking-wider text-muted-foreground">Send queue · FIFO</div>
          {uncertainPending && (
            <div className="flex items-center gap-2 border-l-2 border-warning px-2 py-1 text-xs">
              <span className="min-w-0 flex-1 truncate">{uncertainPending.text}</span>
              <span className="text-warning">{uncertainPending.submitted ? 'Awaiting receipt…' : 'Not submitted'}</span>
              <button type="button" onClick={retryPendingSend} className="text-warning underline">Retry same request</button>
            </div>
          )}
          {precommit.map((send) => (
            <div key={`saving-${send.clientMessageId}`} className="flex items-center gap-2 border-l-2 border-muted px-2 py-1 text-xs">
              <span className="min-w-0 flex-1 truncate">{send.text}</span>
              <span className={send.status === 'failed' ? 'text-destructive' : 'text-muted-foreground'}>
                {send.status === 'failed' ? send.failureReason ?? 'Rejected' : send.status === 'queued' ? 'Saved' : 'Saving…'}
              </span>
            </div>
          ))}
          {sendQueue.map((item, index) => {
            const editable = item.status === 'queued' && item.origin === 'user' && !item.interruptRequestId;
            const removable = canRemoveQueueItem(item);
            const isEditing = editable && editing?.itemId === item.id;
            const commandError = rowCommand?.itemId === item.id && rowReceipt?.status === 'rejected'
              ? rowReceipt.error?.message ?? 'Command rejected'
              : null;
            return (
              <div key={item.id} className="border-l-2 border-primary/40 px-2 py-1 text-xs">
                <div className="flex items-center gap-2">
                  <span className="w-4 text-[10px] text-muted-foreground">{index + 1}</span>
                  {isEditing ? (
                    <input
                      value={editing.text}
                      onChange={(event) => setEditing({
                        ...editing,
                        text: event.target.value,
                      })}
                      className="min-w-0 flex-1 border border-border bg-background px-1 py-0.5 focus:border-primary focus:outline-none"
                    />
                  ) : (
                    <span className="min-w-0 flex-1 truncate">{item.text}</span>
                  )}
                  <span className={item.status === 'failed' ? 'text-destructive' : 'text-muted-foreground'}>
                    {item.status === 'delivering' ? 'Delivering' : item.status === 'failed' ? 'Failed' : item.interruptRequestId ? 'After interrupt' : 'Queued'}
                  </span>
                  {editable && !isEditing && (
                    <button
                      type="button"
                      className="text-muted-foreground hover:text-foreground"
                      onClick={() => setEditing({
                        itemId: item.id,
                        expectedRevision: item.revision,
                        text: item.text,
                      })}
                    >Edit</button>
                  )}
                  {removable && !isEditing && (
                    <button
                      type="button"
                      className="text-muted-foreground hover:text-destructive"
                      onClick={() => {
                        const commandId = onRemove(item.id, item.revision);
                        if (commandId) setRowCommand({ itemId: item.id, commandId });
                        else setSocketError('Remove was not submitted');
                      }}
                    >Remove</button>
                  )}
                  {editable && isEditing && (
                    <>
                      <button
                        type="button"
                        disabled={!editing.text.trim()}
                        className="text-primary disabled:opacity-50"
                        onClick={() => {
                          const commandId = onEdit(
                            item.id,
                            editing.expectedRevision,
                            editing.text.trim(),
                          );
                          if (commandId) setRowCommand({ itemId: item.id, commandId });
                          else setSocketError('Edit was not submitted');
                        }}
                      >Save</button>
                      <button type="button" className="text-muted-foreground" onClick={() => setEditing(null)}>Cancel</button>
                    </>
                  )}
                  {item.id === queueHead?.id && busy && activeTurnId && !item.interruptRequestId && (
                    <button
                      type="button"
                      className="border border-warning/50 px-1.5 py-0.5 text-[9px] uppercase text-warning"
                      onClick={() => interruptAndSendHead(item)}
                    >Interrupt &amp; send next</button>
                  )}
                </div>
                {(item.failureReason || commandError || (isEditing && editing.expectedRevision !== item.revision)) && (
                  <div className="pl-6 pt-0.5 text-[10px] text-destructive">
                    {commandError ?? item.failureReason ?? 'This message changed elsewhere; Save will request a revision check.'}
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}
      <div className="flex items-center gap-3 text-[10px] uppercase tracking-[0.04em] text-muted-foreground">
        <span className="inline-flex items-center gap-1.5 text-[var(--fg-dim)]" title="↑/↓ walks prompt history">
          <kbd className="border border-border px-1 text-[9px]">↑</kbd>
          <kbd className="border border-border px-1 text-[9px]">↓</kbd>
          <span>history · {historyLen}</span>
        </span>
        {sessionState && (
          <span className="inline-flex items-center gap-1.5" title="session_state">
            <span className={`h-1.5 w-1.5 rounded-full ${stateTone}`} />
            <span>{sessionState.replace('_', ' ')}</span>
          </span>
        )}
        <span className="ml-auto text-[var(--fg-dim)]">enter to send · shift+enter newline</span>
      </div>
      <textarea
        ref={textareaRef}
        data-testid="chat-composer-input"
        value={text}
        onChange={(e) => {
          setText(e.target.value);
          if (historyIdx !== null) setHistoryIdx(null);
        }}
        onPaste={(e) => { void handlePaste(e); }}
        onKeyDown={(e) => {
          if (e.key === 'Enter' && !e.shiftKey) {
            e.preventDefault();
            submit();
            return;
          }
          if (e.key === 'ArrowUp' && !e.shiftKey && !e.altKey && !e.metaKey && !e.ctrlKey) {
            if (text === '' || historyIdx !== null) {
              e.preventDefault();
              navHistory(-1);
            }
            return;
          }
          if (e.key === 'ArrowDown' && !e.shiftKey && !e.altKey && !e.metaKey && !e.ctrlKey) {
            if (historyIdx !== null) {
              e.preventDefault();
              navHistory(1);
            }
          }
        }}
        placeholder="Message the orchestrator…"
        className="resize-none overflow-y-auto border border-border bg-background px-2 py-1 text-sm focus:border-primary focus:outline-none"
        style={{ minHeight: composerMinPx, maxHeight: composerMaxPx }}
      />
      {pasteUpload && (
        <div className="flex items-center gap-2 bg-muted px-2 py-1 text-[10px]">
          {pasteUpload.uploading > 0 && (
            <span className="text-muted-foreground">
              saving image{pasteUpload.uploading > 1 ? `s (${pasteUpload.uploading})` : ''}…
            </span>
          )}
          {pasteUpload.errors.map((err, i) => (
            <span key={i} className="text-destructive">image upload failed: {err}</span>
          ))}
        </div>
      )}
      {(socketError || interruptLabel) && (
        <div className={
          'px-2 py-1 text-[10px] ' +
          (socketError || interruptProjection?.state === 'failed' || interruptReceipt?.status === 'rejected'
            ? 'bg-destructive/10 text-destructive'
            : interruptProjection?.state === 'confirmed'
              ? 'bg-success/10 text-success'
              : 'bg-muted text-muted-foreground')
        }>
          {socketError ?? interruptLabel}
        </div>
      )}
      <div className="flex items-center gap-2">
        {pendingSend && !pendingStatus && !uncertainPending && (
          <button type="button" onClick={retryPendingSend} className="border border-warning/50 px-2 py-1 text-[10px] uppercase text-warning">
            Retry save
          </button>
        )}
        <button
          type="button"
          onClick={submit}
          disabled={!canSubmitDraft(text, pendingSend !== null)}
          data-testid="chat-composer-send"
          className="bg-primary px-4 py-1.5 text-xs font-semibold uppercase tracking-wider text-primary-foreground hover:bg-primary/90 disabled:opacity-50"
        >
          {busy ? 'Queue' : 'Send'}
        </button>
        {busy && activeTurnId && !queueHead && (
          <button
            type="button"
            onClick={interruptAndSendDraft}
            disabled={!text.trim() || pendingSend !== null || interruptPending || interruptProjection?.state === 'requested'}
            className="border border-warning/50 px-3 py-1 text-[10px] uppercase tracking-wider text-warning disabled:opacity-50"
          >Interrupt &amp; send</button>
        )}
        <button
          type="button"
          onClick={clickInterrupt}
          disabled={!busy || !activeTurnId || interruptPending || interruptProjection?.state === 'requested'}
          title="Stop the in-flight turn"
          className="border border-border px-3 py-1 text-[10px] uppercase tracking-wider text-muted-foreground hover:border-destructive hover:text-destructive disabled:opacity-50"
        >
          Interrupt esc
        </button>
      </div>
    </div>
  );
}
