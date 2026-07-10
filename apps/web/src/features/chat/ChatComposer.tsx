// Orchestrator composer: draft persistence + prompt history + image paste
// (POST → path spliced into text) + send + interrupt. Send returns a bool so
// the caller can keep the text on a closed socket.

import React, { useCallback, useEffect, useRef, useState } from 'react';

import { uploadPastedImage } from '@/features/pasted-images/client';

const PROMPT_HISTORY_CAP = 100;

function historyKeyFor(key: string) {
  return `pc:prompt-history:${key}`;
}
function draftKeyFor(key: string) {
  return `pc:composer-draft:${key}`;
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

export function ChatComposer({
  projectId,
  historyKey,
  onSend,
  onInterrupt,
  sessionState,
  busy,
}: {
  projectId: string;
  historyKey: string;
  onSend: (text: string) => boolean;
  onInterrupt: () => boolean;
  sessionState: string | null;
  busy: boolean;
}) {
  const [text, setText] = useState(() => readDraft(historyKey));
  const [interruptFeedback, setInterruptFeedback] = useState<'sent' | 'failed' | null>(null);
  const [pasteUpload, setPasteUpload] = useState<{ uploading: number; errors: string[] } | null>(null);
  const textareaRef = useRef<HTMLTextAreaElement | null>(null);
  const interruptTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const historyRef = useRef<string[]>(readHistory(historyKey));
  const [historyIdx, setHistoryIdx] = useState<number | null>(null);
  const draftKeyRef = useRef(historyKey);

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
  }, [historyKey]);

  useEffect(() => {
    if (draftKeyRef.current !== historyKey) {
      draftKeyRef.current = historyKey;
      return;
    }
    writeDraft(historyKey, text);
  }, [text, historyKey]);

  useEffect(() => () => { if (interruptTimerRef.current) clearTimeout(interruptTimerRef.current); }, []);

  function submit() {
    const trimmed = text.trim();
    if (!trimmed) return;
    if (!onSend(trimmed)) return;
    const hist = historyRef.current;
    if (hist[hist.length - 1] !== trimmed) {
      hist.push(trimmed);
      if (hist.length > PROMPT_HISTORY_CAP) hist.splice(0, hist.length - PROMPT_HISTORY_CAP);
      writeHistory(historyKey, hist);
    }
    setHistoryIdx(null);
    setText('');
  }

  function clickInterrupt() {
    if (interruptTimerRef.current) clearTimeout(interruptTimerRef.current);
    const ok = onInterrupt();
    setInterruptFeedback(ok ? 'sent' : 'failed');
    interruptTimerRef.current = setTimeout(() => setInterruptFeedback(null), 1500);
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

  return (
    <div className="flex flex-col gap-1.5 border-t border-border bg-card px-4 py-2.5">
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
      <div className="flex items-center gap-2">
        <button
          type="button"
          onClick={submit}
          disabled={!text.trim()}
          data-testid="chat-composer-send"
          className="bg-primary px-4 py-1.5 text-xs font-semibold uppercase tracking-wider text-primary-foreground hover:bg-primary/90 disabled:opacity-50"
        >
          Send
        </button>
        <button
          type="button"
          onClick={clickInterrupt}
          disabled={!busy || interruptFeedback === 'sent'}
          title="Stop the in-flight turn"
          className={
            'border px-3 py-1 text-[10px] uppercase tracking-wider disabled:opacity-50 ' +
            (interruptFeedback === 'sent'
              ? 'border-success bg-success/10 text-success'
              : interruptFeedback === 'failed'
                ? 'border-warning bg-warning/10 text-warning'
                : 'border-border text-muted-foreground hover:border-destructive hover:text-destructive')
          }
        >
          {interruptFeedback === 'sent' ? '✓ Sent' : interruptFeedback === 'failed' ? 'Failed — not connected' : 'Interrupt esc'}
        </button>
      </div>
    </div>
  );
}
