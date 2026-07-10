// Header account switcher (NEW). Selects which Claude login (config dir) the
// orchestrator + agents run under. Switching account starts a new session, so
// this is a deliberate, visible control. Registry + env selection are
// server-owned; this reads the accounts store (stub registry until the server
// /api/accounts round-trip lands).

import { useEffect, useRef, useState } from 'react';

import { useAccounts } from '@/state/accounts';

export function AccountSwitcher() {
  const accounts = useAccounts((s) => s.accounts);
  const selectedId = useAccounts((s) => s.selectedId);
  const select = useAccounts((s) => s.select);
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement | null>(null);

  const selected = accounts.find((a) => a.id === selectedId) ?? accounts[0] ?? null;

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

  if (!selected) return null;

  return (
    <div ref={rootRef} className="relative">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        aria-haspopup="menu"
        title={`Account: ${selected.label}\n${selected.configDir}`}
        className="flex items-center gap-1.5 px-2 py-1 text-[11px] uppercase tracking-[0.06em] text-muted-foreground hover:bg-muted hover:text-foreground"
      >
        <span className="inline-block h-1.5 w-1.5 rounded-full bg-primary" aria-hidden />
        <span className="text-foreground/80">{selected.label}</span>
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
          {accounts.map((a) => {
            const active = a.id === selectedId;
            return (
              <button
                key={a.id}
                role="menuitem"
                onClick={() => {
                  select(a.id);
                  setOpen(false);
                }}
                className={`block w-full px-3 py-1.5 text-left text-xs hover:bg-muted ${
                  active ? 'text-primary' : 'text-foreground/90'
                }`}
              >
                <div className="flex items-center gap-2">
                  {active && (
                    <span className="h-1.5 w-1.5 shrink-0 rounded-full bg-emerald-500" aria-hidden />
                  )}
                  <span className="truncate">{a.label}</span>
                </div>
                <div className="mt-0.5 truncate font-mono text-[10px] text-muted-foreground">
                  {a.configDir}
                </div>
              </button>
            );
          })}
          <div className="border-t border-border px-3 py-1.5 text-[10px] text-muted-foreground/70">
            Switching starts a new session.
          </div>
        </div>
      )}
    </div>
  );
}
