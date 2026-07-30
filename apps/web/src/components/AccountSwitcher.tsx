// Header account switcher (NEW). Selects which Claude login (config dir) the
// active project's orchestrator + agents run under. Switching ends the current
// session and mints a new one, so this is a deliberate, visible control. It
// seeds from the server (registry + the project's current account), POSTs the
// change, and shows pending/failure state (positive receipt — never silent).
// A guarded session-changed frame also re-syncs this header from the immutable
// active-session account stamp (important when resuming historical account A).

import { useEffect, useRef, useState } from 'react';

import { useAccounts } from '@/state/accounts';
import { useConnectionStore } from '@/state/connection';
import {
  sessionContinuationLabel,
  sessionResumeLabel,
  sessionSelectionLabel,
} from '@/state/sessions';

export function AccountSwitcher({ projectId }: { projectId: string | null }) {
  const accounts = useAccounts((s) => s.accounts);
  const selectedId = useAccounts((s) => s.selectedId);
  const selectionResolved = useAccounts((s) => s.selectionResolved);
  const status = useAccounts((s) => s.status);
  const pendingId = useAccounts((s) => s.pendingId);
  const error = useAccounts((s) => s.error);
  const activeSession = useAccounts((s) => s.activeSession);
  const loadRegistry = useAccounts((s) => s.loadRegistry);
  const loadForProject = useAccounts((s) => s.loadForProject);
  const bindProject = useAccounts((s) => s.bindProject);
  const switchAccount = useAccounts((s) => s.switchAccount);
  const connectionEpoch = useConnectionStore((s) => s.epoch);
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement | null>(null);

  // Registry list once; the project's current account on every project change.
  useEffect(() => {
    void loadRegistry();
  }, [loadRegistry]);
  useEffect(() => {
    bindProject(projectId);
    if (projectId) void loadForProject(projectId);
  }, [projectId, connectionEpoch, bindProject, loadForProject]);

  const pending = status === 'pending';
  const selected = selectionResolved
    ? accounts.find((a) => a.id === selectedId) ?? (
        selectedId ? { id: selectedId, label: labelFromId(selectedId), configDir: '' } : null
      )
    : null;
  const selectionLabel = activeSession ? sessionSelectionLabel(activeSession) : null;
  const continuationLabel = activeSession ? sessionContinuationLabel(activeSession) : null;

  useEffect(() => {
    if (!open) return;
    function onClick(e: MouseEvent) {
      if (rootRef.current?.contains(e.target as Node)) return;
      setOpen(false);
    }
    function onKey(e: KeyboardEvent) {
      if (e.key === 'Escape') setOpen(false);
    }
    document.addEventListener('mousedown', onClick);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onClick);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);

  if (!selected) {
    return (
      <div className="relative" role="status" aria-live="polite">
        <button
          type="button"
          disabled={!projectId || pending}
          onClick={() => { if (projectId) void loadForProject(projectId); }}
          title={error ?? 'Resolving the project account'}
          className="flex items-center gap-1.5 px-2 py-1 text-[11px] uppercase tracking-[0.06em] text-foreground disabled:opacity-70"
        >
          <span
            className={`inline-block h-1.5 w-1.5 rounded-full ${
              status === 'error' ? 'bg-destructive' : 'animate-pulse bg-amber-500'
            }`}
            aria-hidden
          />
          <span>{status === 'error' ? 'Retry account' : 'Resolving account…'}</span>
        </button>
      </div>
    );
  }

  async function choose(id: string) {
    if (!projectId || pending || id === selectedId) {
      setOpen(false);
      return;
    }
    await switchAccount(projectId, id);
    setOpen(false);
  }

  const dotClass =
    status === 'error' ? 'bg-destructive' : pending ? 'bg-amber-500 animate-pulse' : 'bg-primary';

  return (
    <div ref={rootRef} className="relative">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        aria-haspopup="menu"
        title={
          status === 'error' && error
            ? `Account switch failed: ${error}`
            : [
                `Account: ${selected.label}`,
                selected.configDir || null,
                selectionLabel ? `Session: ${selectionLabel}` : null,
                continuationLabel ? `Continuation: ${continuationLabel}` : null,
              ].filter(Boolean).join('\n')
        }
        className="flex items-center gap-1.5 px-2 py-1 text-[11px] uppercase tracking-[0.06em] text-muted-foreground hover:bg-muted hover:text-foreground"
      >
        <span className={`inline-block h-1.5 w-1.5 rounded-full ${dotClass}`} aria-hidden />
        <span className="text-foreground/80">
          {pending && pendingId ? `${labelOf(accounts, pendingId)}…` : selected.label}
        </span>
        <span className="text-[9px] text-[var(--fg-dim)]">▾</span>
      </button>
      {open && (
        <div
          role="menu"
          className="absolute right-0 top-full z-50 mt-1 min-w-[200px] border border-primary/40 bg-popover py-1 text-popover-foreground shadow-2xl"
        >
          <div className="border-b border-border px-3 py-1 text-[9px] uppercase tracking-[0.12em] text-muted-foreground">
            account
          </div>
          {activeSession && selectionLabel && continuationLabel && (
            <div className="border-b border-border px-3 py-1.5 text-[10px] text-muted-foreground">
              <div className="mb-0.5 text-[9px] uppercase tracking-[0.1em]">active session</div>
              <div className="max-w-[320px] truncate text-foreground/85" title={selectionLabel}>
                {selectionLabel}
              </div>
              <div>{continuationLabel} · {sessionResumeLabel(activeSession)}</div>
            </div>
          )}
          {accounts.map((a) => {
            const active = a.id === selectedId;
            const busy = pending && a.id === pendingId;
            return (
              <button
                key={a.id}
                role="menuitem"
                disabled={!projectId || pending}
                onClick={() => void choose(a.id)}
                className={`block w-full px-3 py-1.5 text-left text-xs hover:bg-muted disabled:cursor-not-allowed disabled:opacity-50 ${
                  active ? 'text-primary' : 'text-foreground/90'
                }`}
              >
                <div className="flex items-center gap-2">
                  {active && (
                    <span className="h-1.5 w-1.5 shrink-0 rounded-full bg-emerald-500" aria-hidden />
                  )}
                  <span className="truncate">{a.label}</span>
                  {busy && <span className="ml-auto text-[10px] text-muted-foreground">switching…</span>}
                </div>
                <div className="mt-0.5 truncate font-mono text-[10px] text-muted-foreground">
                  {a.configDir}
                </div>
              </button>
            );
          })}
          {status === 'error' && error && (
            <div className="border-t border-border px-3 py-1.5 text-[10px] text-destructive">
              Switch failed: {error}
            </div>
          )}
          <div className="border-t border-border px-3 py-1.5 text-[10px] text-muted-foreground/70">
            {accountSwitcherFooterCopy(projectId)}
          </div>
        </div>
      )}
    </div>
  );
}

/** Continuity is a server decision made from this session's own transcript,
 *  never something the UI infers or brands by provider: a new native session
 *  starts either way, and the server seeds it from this conversation's
 *  history when there is something to seed it with (docs/agent-runtime-
 *  architecture.md "Sessions and switching"). The chat itself always shows a
 *  visible notice once the switch actually lands — this footer line only
 *  sets the expectation, never asserts which path was taken. */
export function accountSwitcherFooterCopy(projectId: string | null): string {
  return projectId
    ? 'Switching starts a new session — continuing from this conversation when possible.'
    : 'Select a project to switch account.';
}

function labelOf(accounts: { id: string; label: string }[], id: string): string {
  return accounts.find((a) => a.id === id)?.label ?? id;
}

function labelFromId(id: string): string {
  return id.length > 0 ? id[0]!.toUpperCase() + id.slice(1) : id;
}
