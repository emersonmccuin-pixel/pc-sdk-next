// Header runtime switcher — mirrors AccountSwitcher.tsx exactly, one level
// up: selects which agent-runtime adapter (Claude / Codex) the active
// project's orchestrator + agents run under. Switching ends the current
// session and mints a new one, so this is a deliberate, visible control. An
// unavailable runtime (e.g. no Codex ChatGPT login) renders disabled with its
// reason — never hidden, never silently clickable.

import { useEffect, useRef, useState } from 'react';

import { useRuntimes } from '@/state/runtimes';
import { useConnectionStore } from '@/state/connection';
import {
  sessionContinuationLabel,
  sessionResumeLabel,
  sessionSelectionLabel,
} from '@/state/sessions';

const REASON_LABELS: Record<string, string> = {
  'account-unavailable': 'no login for this account',
  'codex-discovery-unavailable': 'Codex sign-in unavailable',
  'model-discovery-unsupported': 'model discovery unsupported',
  'model-discovery-unavailable': 'model discovery unavailable',
  'runtime-unavailable': 'unavailable',
};

function reasonLabel(code: string | null): string {
  if (!code) return 'unavailable';
  return REASON_LABELS[code] ?? code.replace(/-/g, ' ');
}

export function RuntimeSwitcher({ projectId }: { projectId: string | null }) {
  const runtimes = useRuntimes((s) => s.runtimes);
  const selectedId = useRuntimes((s) => s.selectedId);
  const selectionResolved = useRuntimes((s) => s.selectionResolved);
  const status = useRuntimes((s) => s.status);
  const pendingId = useRuntimes((s) => s.pendingId);
  const error = useRuntimes((s) => s.error);
  const activeSession = useRuntimes((s) => s.activeSession);
  const loadRegistry = useRuntimes((s) => s.loadRegistry);
  const loadForProject = useRuntimes((s) => s.loadForProject);
  const bindProject = useRuntimes((s) => s.bindProject);
  const switchRuntime = useRuntimes((s) => s.switchRuntime);
  const connectionEpoch = useConnectionStore((s) => s.epoch);
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    void loadRegistry();
  }, [loadRegistry]);
  useEffect(() => {
    bindProject(projectId);
    if (projectId) void loadForProject(projectId);
  }, [projectId, connectionEpoch, bindProject, loadForProject]);

  const pending = status === 'pending';
  const selected = selectionResolved
    ? runtimes.find((r) => r.id === selectedId) ?? (
        selectedId ? { id: selectedId, label: labelFromId(selectedId), accounts: [] } : null
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
          title={error ?? 'Resolving the project runtime'}
          className="flex items-center gap-1.5 px-2 py-1 text-[11px] uppercase tracking-[0.06em] text-foreground disabled:opacity-70"
        >
          <span
            className={`inline-block h-1.5 w-1.5 rounded-full ${
              status === 'error' ? 'bg-destructive' : 'animate-pulse bg-amber-500'
            }`}
            aria-hidden
          />
          <span>{status === 'error' ? 'Retry runtime' : 'Resolving runtime…'}</span>
        </button>
      </div>
    );
  }

  function runtimeAvailable(id: string): boolean {
    const runtime = runtimes.find((r) => r.id === id);
    return runtime ? runtime.accounts.some((a) => a.available) : false;
  }

  async function choose(id: string) {
    if (!projectId || pending || id === selectedId || !runtimeAvailable(id)) {
      setOpen(false);
      return;
    }
    await switchRuntime(projectId, id);
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
            ? `Runtime switch failed: ${error}`
            : [
                `Runtime: ${selected.label}`,
                selectionLabel ? `Session: ${selectionLabel}` : null,
                continuationLabel ? `Continuation: ${continuationLabel}` : null,
              ].filter(Boolean).join('\n')
        }
        className="flex items-center gap-1.5 px-2 py-1 text-[11px] uppercase tracking-[0.06em] text-muted-foreground hover:bg-muted hover:text-foreground"
      >
        <span className={`inline-block h-1.5 w-1.5 rounded-full ${dotClass}`} aria-hidden />
        <span className="text-foreground/80">
          {pending && pendingId ? `${labelOf(runtimes, pendingId)}…` : selected.label}
        </span>
        <span className="text-[9px] text-[var(--fg-dim)]">▾</span>
      </button>
      {open && (
        <div
          role="menu"
          className="absolute right-0 top-full z-50 mt-1 min-w-[220px] border border-primary/40 bg-popover py-1 text-popover-foreground shadow-2xl"
        >
          <div className="border-b border-border px-3 py-1 text-[9px] uppercase tracking-[0.12em] text-muted-foreground">
            runtime
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
          {runtimes.map((r) => {
            const active = r.id === selectedId;
            const busy = pending && r.id === pendingId;
            const available = r.accounts.length === 0 || r.accounts.some((a) => a.available);
            const reason = !available
              ? r.accounts.map((a) => reasonLabel(a.reasonCode)).find(Boolean) ?? 'unavailable'
              : null;
            return (
              <button
                key={r.id}
                role="menuitem"
                disabled={!projectId || pending || !available}
                onClick={() => void choose(r.id)}
                title={reason ? `${r.label}: ${reason}` : undefined}
                className={`block w-full px-3 py-1.5 text-left text-xs hover:bg-muted disabled:cursor-not-allowed disabled:opacity-50 ${
                  active ? 'text-primary' : 'text-foreground/90'
                }`}
              >
                <div className="flex items-center gap-2">
                  {active && (
                    <span className="h-1.5 w-1.5 shrink-0 rounded-full bg-emerald-500" aria-hidden />
                  )}
                  <span className="truncate">{r.label}</span>
                  {busy && <span className="ml-auto text-[10px] text-muted-foreground">switching…</span>}
                  {!available && <span className="ml-auto text-[10px] text-destructive">unavailable</span>}
                </div>
                {reason && (
                  <div className="mt-0.5 truncate text-[10px] text-muted-foreground">{reason}</div>
                )}
              </button>
            );
          })}
          {status === 'error' && error && (
            <div className="border-t border-border px-3 py-1.5 text-[10px] text-destructive">
              Switch failed: {error}
            </div>
          )}
          <div className="border-t border-border px-3 py-1.5 text-[10px] text-muted-foreground/70">
            {projectId ? 'Switching starts a new session.' : 'Select a project to switch runtime.'}
          </div>
        </div>
      )}
    </div>
  );
}

function labelOf(runtimes: { id: string; label: string }[], id: string): string {
  return runtimes.find((r) => r.id === id)?.label ?? id;
}

function labelFromId(id: string): string {
  if (id === 'claude-agent-sdk') return 'Claude';
  if (id === 'openai-codex') return 'Codex';
  return id;
}
