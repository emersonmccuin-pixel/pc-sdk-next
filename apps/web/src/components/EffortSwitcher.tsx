// Header effort switcher — sibling to ModelSwitcher, one level further down:
// selects the reasoning-effort override for the active session's CURRENT
// model. Only ever offers that model's own discovered `effort.values`, plus a
// "default" option that clears back to no override (`effort: null`). A model
// without effort support renders disabled with its typed reason — never
// hidden, never silently clickable (mirrors RuntimeSwitcher's unavailable
// runtimes).

import { useEffect, useRef, useState } from 'react';

import { useRuntimes, type RuntimeInfo } from '@/state/runtimes';
import { modelsForSelection } from '@/components/ModelSwitcher';

export interface EffortOptions {
  supported: boolean;
  reasonCode: string | null;
  values: string[];
}

const REASON_LABELS: Record<string, string> = {
  'model-discovery-unsupported': 'model discovery unsupported',
  'model-discovery-unavailable': 'model discovery unavailable',
};

function reasonLabel(code: string | null): string {
  if (!code) return 'effort control unsupported';
  return REASON_LABELS[code] ?? code.replace(/-/g, ' ');
}

/** The active model's effort menu: exactly its supported values, or a typed
 *  unsupported/unavailable reason. Exported for direct testing without a DOM
 *  — this is the picker's entire "show or hide effort" contract. */
export function effortOptionsForSelection(
  runtimes: RuntimeInfo[],
  runtimeId: string | null | undefined,
  accountId: string | null | undefined,
  modelId: string | null | undefined,
): EffortOptions {
  if (!runtimeId || !accountId || !modelId) return { supported: false, reasonCode: null, values: [] };
  const models = modelsForSelection(runtimes, runtimeId, accountId);
  const model = models.find((m) => m.id === modelId || m.resolvedId === modelId);
  if (!model) return { supported: false, reasonCode: null, values: [] };
  if (model.effort.status !== 'supported') {
    return { supported: false, reasonCode: model.effort.code, values: [] };
  }
  return { supported: true, reasonCode: null, values: model.effort.values };
}

export function EffortSwitcher({ projectId }: { projectId: string | null }) {
  const runtimes = useRuntimes((s) => s.runtimes);
  const activeSession = useRuntimes((s) => s.activeSession);
  const status = useRuntimes((s) => s.status);
  const error = useRuntimes((s) => s.error);
  const setEffort = useRuntimes((s) => s.setEffort);
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement | null>(null);

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
  const options = effortOptionsForSelection(
    runtimes,
    selection?.runtimeId,
    selection?.accountId,
    selection?.model,
  );
  const pending = status === 'pending';
  const currentValue = selection?.effort.kind === 'selected' ? selection.effort.value : null;

  // No stamped selection, or the current model doesn't support effort at
  // all — render disabled with its reason instead of hiding (consistent with
  // RuntimeSwitcher's unavailable-runtime treatment).
  if (!selection || !options.supported) {
    const reason = selection ? reasonLabel(options.reasonCode) : 'resolving';
    return (
      <div className="relative" role="status" aria-live="polite">
        <button
          type="button"
          disabled
          title={selection ? `Effort: ${reason}` : 'Resolving the active session'}
          className="flex items-center gap-1.5 px-2 py-1 text-[11px] uppercase tracking-[0.06em] text-muted-foreground opacity-60"
        >
          <span className="inline-block h-1.5 w-1.5 rounded-full bg-muted-foreground" aria-hidden />
          <span>Effort</span>
        </button>
      </div>
    );
  }

  const currentLabel = currentValue ?? 'default';

  async function choose(value: string | null) {
    if (!projectId || pending || value === currentValue) {
      setOpen(false);
      return;
    }
    await setEffort(projectId, value);
    setOpen(false);
  }

  const dotClass =
    status === 'error' ? 'bg-destructive' : pending ? 'bg-amber-500 animate-pulse' : 'bg-primary';

  return (
    <div ref={rootRef} className="relative">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        disabled={!projectId}
        aria-expanded={open}
        aria-haspopup="menu"
        title={status === 'error' && error ? `Effort switch failed: ${error}` : `Effort: ${currentLabel}`}
        className="flex items-center gap-1.5 px-2 py-1 text-[11px] uppercase tracking-[0.06em] text-muted-foreground hover:bg-muted hover:text-foreground disabled:cursor-not-allowed disabled:opacity-50"
      >
        <span className={`inline-block h-1.5 w-1.5 rounded-full ${dotClass}`} aria-hidden />
        <span className="text-foreground/80">{currentLabel}</span>
        <span className="text-[9px] text-[var(--fg-dim)]">▾</span>
      </button>
      {open && (
        <div
          role="menu"
          className="absolute right-0 top-full z-50 mt-1 min-w-[160px] border border-primary/40 bg-popover py-1 text-popover-foreground shadow-2xl"
        >
          <div className="border-b border-border px-3 py-1 text-[9px] uppercase tracking-[0.12em] text-muted-foreground">
            effort
          </div>
          {[null, ...options.values].map((value) => {
            const active = value === currentValue;
            return (
              <button
                key={value ?? '__default__'}
                role="menuitem"
                disabled={pending}
                onClick={() => void choose(value)}
                className={`block w-full px-3 py-1.5 text-left text-xs hover:bg-muted disabled:cursor-not-allowed disabled:opacity-50 ${
                  active ? 'text-primary' : 'text-foreground/90'
                }`}
              >
                <div className="flex items-center gap-2">
                  {active && (
                    <span className="h-1.5 w-1.5 shrink-0 rounded-full bg-emerald-500" aria-hidden />
                  )}
                  <span className="truncate">{value ?? 'default'}</span>
                </div>
              </button>
            );
          })}
          {status === 'error' && error && (
            <div className="border-t border-border px-3 py-1.5 text-[10px] text-destructive">
              Switch failed: {error}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
