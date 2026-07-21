// Lightweight folder picker for the create-project flow. Browses the local
// filesystem via POST /api/fs/list (server has full local fs access; the
// browser can't read absolute paths itself). Read-only — never creates,
// renames, or deletes anything. The full files browser was deleted; this is
// a narrow, purpose-built replacement scoped to "pick a folder".

import { useEffect, useState } from 'react';

import { fsApi, type DirListing } from '@/features/fs/client';

interface FolderBrowserProps {
  initialPath?: string;
  onClose: () => void;
  onSelect: (path: string) => void;
}

type ListState =
  | { status: 'loading' }
  | { status: 'ready'; listing: DirListing }
  | { status: 'error'; message: string };

export function FolderBrowser({ initialPath, onClose, onSelect }: FolderBrowserProps) {
  const [state, setState] = useState<ListState>({ status: 'loading' });

  useEffect(() => {
    load(initialPath);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  function load(path?: string) {
    setState({ status: 'loading' });
    fsApi
      .listDir(path)
      .then((listing) => setState({ status: 'ready', listing }))
      .catch((e) => setState({ status: 'error', message: (e as Error).message }));
  }

  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key === 'Escape') onClose();
    }
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  const current = state.status === 'ready' ? state.listing : null;

  return (
    <div
      className="fixed inset-0 z-50 grid place-items-center bg-black/40"
      onClick={(e) => {
        e.stopPropagation();
        onClose();
      }}
    >
      <div
        className="flex h-[420px] w-[520px] flex-col border border-border bg-card text-foreground"
        onClick={(e) => e.stopPropagation()}
      >
        <header className="flex items-center justify-between border-b border-border px-4 py-3">
          <h2 className="text-base font-semibold">Choose a folder</h2>
          <button onClick={onClose} className="text-muted-foreground hover:text-foreground" aria-label="Close">
            ×
          </button>
        </header>

        <div className="flex items-center gap-2 border-b border-border px-4 py-2">
          <button
            type="button"
            onClick={() => current?.parent && load(current.parent)}
            disabled={!current?.parent}
            className="border border-border px-2 py-1 text-xs hover:bg-muted disabled:opacity-40"
          >
            Up
          </button>
          <code className="flex-1 truncate bg-muted px-2 py-1 font-mono text-xs">
            {current?.path ?? '…'}
          </code>
        </div>

        <div className="flex-1 overflow-y-auto px-2 py-2">
          {state.status === 'loading' && (
            <div className="px-2 py-1 text-xs text-muted-foreground">Loading…</div>
          )}
          {state.status === 'error' && (
            <div className="px-2 py-1 text-xs text-destructive">{state.message}</div>
          )}
          {state.status === 'ready' && state.listing.entries.length === 0 && (
            <div className="px-2 py-1 text-xs text-muted-foreground">No subfolders.</div>
          )}
          {state.status === 'ready' &&
            state.listing.entries.map((entry) => (
              <button
                key={entry.path}
                type="button"
                onClick={() => load(entry.path)}
                className="flex w-full items-center justify-between px-2 py-1.5 text-left text-sm hover:bg-muted"
              >
                <span className="truncate">{entry.name}</span>
                {entry.isGitRepo && (
                  <span className="ml-2 shrink-0 bg-muted px-1.5 py-0.5 text-[10px] text-muted-foreground">
                    git
                  </span>
                )}
              </button>
            ))}
        </div>

        <div className="flex justify-end gap-2 border-t border-border px-4 py-3">
          <button
            type="button"
            onClick={onClose}
            className="border border-border px-3 py-1.5 text-sm hover:bg-muted"
          >
            Cancel
          </button>
          <button
            type="button"
            disabled={!current}
            onClick={() => current && onSelect(current.path)}
            className="bg-primary px-3 py-1.5 text-sm font-medium text-primary-foreground hover:bg-primary/90 disabled:opacity-50"
          >
            Use this folder
          </button>
        </div>
      </div>
    </div>
  );
}
