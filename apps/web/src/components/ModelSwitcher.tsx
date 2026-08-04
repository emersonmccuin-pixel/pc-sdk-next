// Header model switcher — sibling to RuntimeSwitcher/AccountSwitcher, one
// level further down: selects which discovered model the active session's
// runtime+account run under. Lists exactly the models GET /api/runtimes
// discovered for the CURRENT session's runtime+account (never a stale
// cross-runtime list). Like the other switchers, changing it always mints a
// new immutable-selection app session (a stamped row can never mutate in
// place) — but the server may native-continue the prior thread into it when
// the adapter positively supports continuing across this exact selection
// change (see SessionService.changeSelection). This component never branches
// on that outcome; it always shows the same provider-neutral copy and lets
// the replay/provenance UI show what actually happened.
//
// Before a session is stamped (fresh project, no messages sent yet) there is
// no session selection to read models off of. RuntimeSwitcher/AccountSwitcher
// already work in that state by acting on the project's default runtime/
// account (`useRuntimes`/`useAccounts` `selectedId` + `selectionResolved`);
// this picker mirrors that — it lists models for the project defaults and
// labels the button "default" (nothing stamped yet). Picking one calls the
// same setModel, which mints the first session. Only while either default is
// still unresolved (or there's no project) does this fall back to the
// disabled placeholder.

import { useEffect, useRef, useState } from 'react';

import { useRuntimes, type RuntimeInfo } from '@/state/runtimes';
import { useAccounts } from '@/state/accounts';
import { useConnectionStore } from '@/state/connection';
import type { RuntimeModel } from '@pc/contracts';

/** Discovered models for one runtime+account. Exported for direct testing
 *  without a DOM — this is the picker's entire "what do I list" contract. */
export function modelsForSelection(
  runtimes: RuntimeInfo[],
  runtimeId: string | null | undefined,
  accountId: string | null | undefined,
): RuntimeModel[] {
  if (!runtimeId || !accountId) return [];
  const runtime = runtimes.find((r) => r.id === runtimeId);
  const account = runtime?.accounts.find((a) => a.id === accountId);
  return account?.models ?? [];
}

export function modelLabel(models: RuntimeModel[], modelId: string): string {
  const model = models.find((m) => m.id === modelId || m.resolvedId === modelId);
  return model?.label ?? modelId;
}

/** True once there's enough to render the picker even with no stamped
 *  session: a project is selected and its default runtime+account have both
 *  resolved. Exported for direct testing without a DOM — this is the
 *  pre-session enable/disable gate. */
export function canListModelsWithoutSession(
  projectId: string | null,
  runtimeDefaultResolved: boolean,
  accountDefaultResolved: boolean,
): boolean {
  return projectId !== null && runtimeDefaultResolved && accountDefaultResolved;
}

/** The runtime+account to list models for: the stamped session's when one
 *  exists, otherwise the project's defaults. Exported for direct testing
 *  without a DOM — this is the pre-session fallback contract. */
export function effectiveRuntimeAccount(
  selection: { runtimeId: string; accountId: string } | null,
  defaultRuntimeId: string,
  defaultAccountId: string,
): { runtimeId: string; accountId: string } {
  return {
    runtimeId: selection?.runtimeId ?? defaultRuntimeId,
    accountId: selection?.accountId ?? defaultAccountId,
  };
}

export function ModelSwitcher({ projectId }: { projectId: string | null }) {
  const runtimes = useRuntimes((s) => s.runtimes);
  const activeSession = useRuntimes((s) => s.activeSession);
  const status = useRuntimes((s) => s.status);
  const error = useRuntimes((s) => s.error);
  const setModel = useRuntimes((s) => s.setModel);
  const loadRegistry = useRuntimes((s) => s.loadRegistry);
  const defaultRuntimeId = useRuntimes((s) => s.selectedId);
  const runtimeDefaultResolved = useRuntimes((s) => s.selectionResolved);
  const defaultAccountId = useAccounts((s) => s.selectedId);
  const accountDefaultResolved = useAccounts((s) => s.selectionResolved);
  const connectionEpoch = useConnectionStore((s) => s.epoch);
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    void loadRegistry();
  }, [loadRegistry, connectionEpoch]);

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

  const selection = activeSession?.selection ?? null;
  const pending = status === 'pending';

  // No stamped selection yet, and the project's default runtime/account
  // aren't resolved either (or there's no project) — nothing to list yet.
  if (!selection && !canListModelsWithoutSession(projectId, runtimeDefaultResolved, accountDefaultResolved)) {
    return (
      <div className="relative" role="status" aria-live="polite">
        <button
          type="button"
          disabled
          title="Resolving the active session's model"
          className="flex items-center gap-1.5 px-2 py-1 text-[11px] uppercase tracking-[0.06em] text-foreground opacity-70"
        >
          <span className="inline-block h-1.5 w-1.5 rounded-full animate-pulse bg-amber-500" aria-hidden />
          <span>Model…</span>
        </button>
      </div>
    );
  }

  // With no stamped selection, list the project's default runtime+account
  // models instead — picking one mints the first session under it.
  const { runtimeId, accountId } = effectiveRuntimeAccount(selection, defaultRuntimeId, defaultAccountId);
  const models = modelsForSelection(runtimes, runtimeId, accountId);
  const currentLabel = selection ? modelLabel(models, selection.model) : 'default';
  const unavailable = models.length === 0;

  async function choose(modelId: string) {
    if (!projectId || pending || (selection && modelId === selection.model)) {
      setOpen(false);
      return;
    }
    await setModel(projectId, modelId);
    setOpen(false);
  }

  const dotClass =
    status === 'error' ? 'bg-destructive' : pending ? 'bg-amber-500 animate-pulse' : 'bg-primary';

  return (
    <div ref={rootRef} className="relative">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        disabled={!projectId || unavailable}
        aria-expanded={open}
        aria-haspopup="menu"
        title={
          status === 'error' && error
            ? `Model switch failed: ${error}`
            : unavailable
              ? `Model: ${currentLabel} (no models discovered)`
              : `Model: ${currentLabel}`
        }
        className="flex items-center gap-1.5 px-2 py-1 text-[11px] uppercase tracking-[0.06em] text-muted-foreground hover:bg-muted hover:text-foreground disabled:cursor-not-allowed disabled:opacity-50"
      >
        <span className={`inline-block h-1.5 w-1.5 rounded-full ${dotClass}`} aria-hidden />
        <span className="text-foreground/80">{currentLabel}</span>
        <span className="text-[9px] text-[var(--fg-dim)]">▾</span>
      </button>
      {open && (
        <div
          role="menu"
          className="absolute right-0 top-full z-50 mt-1 min-w-[200px] border border-primary/40 bg-popover py-1 text-popover-foreground shadow-2xl"
        >
          <div className="border-b border-border px-3 py-1 text-[9px] uppercase tracking-[0.12em] text-muted-foreground">
            model
          </div>
          {unavailable && (
            <div className="px-3 py-1.5 text-[10px] text-muted-foreground">no models discovered</div>
          )}
          {models.map((m) => {
            const active = selection ? m.id === selection.model : false;
            return (
              <button
                key={m.id}
                role="menuitem"
                disabled={pending}
                onClick={() => void choose(m.id)}
                title={m.description || undefined}
                className={`block w-full px-3 py-1.5 text-left text-xs hover:bg-muted disabled:cursor-not-allowed disabled:opacity-50 ${
                  active ? 'text-primary' : 'text-foreground/90'
                }`}
              >
                <div className="flex items-center gap-2">
                  {active && (
                    <span className="h-1.5 w-1.5 shrink-0 rounded-full bg-emerald-500" aria-hidden />
                  )}
                  <span className="truncate">{m.label}</span>
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
            {!projectId
              ? 'Select a project to switch model.'
              : !selection
                ? 'Picking a model starts this project\'s first session with it.'
                : 'Switching continues this conversation when possible, or starts a fresh one.'}
          </div>
        </div>
      )}
    </div>
  );
}
