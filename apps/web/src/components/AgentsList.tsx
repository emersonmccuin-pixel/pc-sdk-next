// Agents tab roster — READ-ONLY (see features/agents/client.ts for why: no
// pods HTTP route yet, and the full edit surface is Phase 3 specialist
// builder). Two-pane: searchable list (stock + project), detail pane.
// Refetches wholesale on any `specialist` resource frame for this project —
// the payload is signal-only by design (contract), so a refetch is correct,
// not a workaround.

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import type { Project } from '@/features/projects/client';
import { agentsApi, resolveModelLabel, type Pod } from '@/features/agents/client';
import { formatToolLabel } from '@/lib/tool-labels';
import { useResourceEvents } from '@/state/resource-store';

export function AgentsList({ project }: { project: Project }) {
  const [pods, setPods] = useState<Pod[] | null>(null);
  const [notAvailable, setNotAvailable] = useState(false);
  const [filter, setFilter] = useState('');
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [builtinCollapsed, setBuiltinCollapsed] = useState(true);

  const load = useCallback(() => {
    agentsApi
      .listPods(project.id)
      .then((r) => {
        setPods(r);
        setNotAvailable(false);
      })
      .catch(() => {
        setPods([]);
        setNotAvailable(true);
      });
  }, [project.id]);

  useEffect(() => {
    setSelectedId(null);
    setFilter('');
    load();
  }, [load]);

  // Signal-only `specialist` frames: refetch the roster whenever the frame
  // set for this project changes (new id, or a newer version/cursor).
  const specialistEvents = useResourceEvents('specialist', project.id);
  const sigRef = useRef('');
  useEffect(() => {
    const sig = specialistEvents.map((e) => `${e.entityId}:${e.version ?? e.cursor}`).join(',');
    if (sig && sig !== sigRef.current) {
      sigRef.current = sig;
      load();
    }
  }, [specialistEvents, load]);

  const { stockPods, projectPods } = useMemo(() => {
    const stock: Pod[] = [];
    const proj: Pod[] = [];
    for (const pod of pods ?? []) {
      if (pod.origin === 'stock') stock.push(pod);
      else proj.push(pod);
    }
    return { stockPods: stock, projectPods: proj };
  }, [pods]);

  useEffect(() => {
    if (selectedId && (pods ?? []).some((p) => p.id === selectedId)) return;
    const first = projectPods[0] ?? stockPods[0] ?? null;
    setSelectedId(first ? first.id : null);
  }, [pods, selectedId, projectPods, stockPods]);

  const filtered = useMemo(() => {
    const q = filter.trim().toLowerCase();
    const match = (p: Pod) =>
      !q || p.name.toLowerCase().includes(q) || p.description.toLowerCase().includes(q);
    return { stock: stockPods.filter(match), project: projectPods.filter(match) };
  }, [filter, stockPods, projectPods]);

  const selectedPod = useMemo(
    () => (selectedId ? (pods ?? []).find((p) => p.id === selectedId) ?? null : null),
    [selectedId, pods],
  );

  if (pods === null) {
    return <div className="grid h-full place-items-center text-xs text-muted-foreground">Loading…</div>;
  }

  if (notAvailable && pods.length === 0) {
    return (
      <div className="grid h-full place-items-center px-6 text-center text-sm text-muted-foreground">
        Agent roster isn't wired up on the server yet — the pods HTTP route lands with the
        Phase 3 specialist builder.
      </div>
    );
  }

  return (
    <div className="flex h-full flex-col overflow-hidden bg-background">
      <header className="flex items-center gap-3 border-b border-border px-4 py-3">
        <div className="flex flex-1 items-center gap-2 border border-border bg-card px-2 py-1.5">
          <span aria-hidden className="text-muted-foreground">⌕</span>
          <input
            type="text"
            value={filter}
            onChange={(e) => setFilter(e.target.value)}
            placeholder="Filter agents…"
            className="w-full bg-transparent text-xs text-foreground outline-none placeholder:text-muted-foreground"
          />
        </div>
      </header>

      <div className="grid min-h-0 flex-1 grid-cols-[280px_1fr] overflow-hidden">
        <aside className="overflow-y-auto border-r border-border">
          <ListSection
            title="Built-in"
            count={stockPods.length}
            filteredCount={filtered.stock.length}
            empty="No stock specialists."
            collapsed={builtinCollapsed}
            onToggle={() => setBuiltinCollapsed((c) => !c)}
          >
            {filtered.stock.map((pod) => (
              <ListRow key={pod.id} pod={pod} selected={pod.id === selectedId} onSelect={() => setSelectedId(pod.id)} />
            ))}
          </ListSection>

          <ListSection
            title="This project"
            count={projectPods.length}
            filteredCount={filtered.project.length}
            empty="No project agents yet."
          >
            {filtered.project.map((pod) => (
              <ListRow key={pod.id} pod={pod} selected={pod.id === selectedId} onSelect={() => setSelectedId(pod.id)} />
            ))}
          </ListSection>
        </aside>

        <main className="overflow-y-auto">
          {selectedPod ? (
            <DetailPane pod={selectedPod} />
          ) : (
            <div className="grid h-full place-items-center p-8 text-center text-xs text-muted-foreground">
              No agent selected.
            </div>
          )}
        </main>
      </div>
    </div>
  );
}

function ListSection({
  title,
  count,
  filteredCount,
  empty,
  collapsed,
  onToggle,
  children,
}: {
  title: string;
  count: number;
  filteredCount: number;
  empty: string;
  collapsed?: boolean;
  onToggle?: () => void;
  children: React.ReactNode;
}) {
  const togglable = onToggle !== undefined;
  const open = togglable ? !collapsed : true;
  return (
    <section>
      <header
        role={togglable ? 'button' : undefined}
        tabIndex={togglable ? 0 : undefined}
        onClick={onToggle}
        className={
          'flex items-center gap-2 px-3 pb-1 pt-3 text-[10px] font-medium uppercase tracking-wider text-muted-foreground' +
          (togglable ? ' cursor-pointer select-none hover:text-foreground' : '')
        }
      >
        {togglable && <span aria-hidden className="inline-block w-2 text-[8px]">{open ? '▼' : '▶'}</span>}
        <span>{title}</span>
        <span className="border border-border px-1 text-[9px] font-normal">{count}</span>
      </header>
      {open && (
        <>
          {count === 0 ? (
            <div className="mx-3 mb-2 border border-dashed border-border px-2 py-3 text-center text-[10px] text-muted-foreground">
              {empty}
            </div>
          ) : filteredCount === 0 ? (
            <div className="mx-3 mb-2 px-2 py-2 text-center text-[10px] text-muted-foreground">no matches</div>
          ) : (
            <div className="flex flex-col">{children}</div>
          )}
        </>
      )}
    </section>
  );
}

function ListRow({ pod, selected, onSelect }: { pod: Pod; selected: boolean; onSelect: () => void }) {
  return (
    <div
      role="button"
      tabIndex={0}
      onClick={onSelect}
      onKeyDown={(e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          onSelect();
        }
      }}
      className={
        'flex cursor-pointer flex-col gap-0.5 border-l-2 px-3 py-2 transition-colors ' +
        (selected ? 'border-primary bg-muted' : 'border-transparent hover:bg-muted')
      }
    >
      <div className="flex items-center justify-between gap-2">
        <span className="truncate text-xs font-medium text-foreground">{pod.name}</span>
        <span className="shrink-0 text-[9px] uppercase tracking-wider text-muted-foreground">
          {resolveModelLabel(pod.model)}
        </span>
      </div>
      {pod.description && (
        <div className="line-clamp-2 text-[11px] leading-tight text-muted-foreground">{pod.description}</div>
      )}
    </div>
  );
}

function DetailPane({ pod }: { pod: Pod }) {
  const isStock = pod.origin === 'stock';
  return (
    <div className="flex h-full flex-col px-6 py-5">
      <header className="mb-4 flex items-center gap-2">
        <h2 className="truncate text-lg font-semibold text-foreground">{pod.name}</h2>
        <span
          className={
            'px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-wider ' +
            (isStock ? 'border border-success/40 bg-success/10 text-success' : 'border border-primary/40 bg-primary/10 text-primary')
          }
        >
          {isStock ? 'stock' : 'project'}
        </span>
        <span className="bg-muted px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-wider text-muted-foreground">
          read-only
        </span>
      </header>

      {pod.description && <p className="mb-5 max-w-3xl text-sm text-muted-foreground">{pod.description}</p>}

      <div className="mb-6 grid grid-cols-2 gap-px border border-border/40 bg-border/40 sm:grid-cols-3 lg:grid-cols-5">
        <Stat label="Model" value={resolveModelLabel(pod.model)} />
        <Stat label="Effort" value={pod.effort ?? '—'} />
        <Stat label="Max turns" value={pod.maxTurns != null ? String(pod.maxTurns) : '∞'} />
        <Stat label="Tools" value={String(pod.tools.length)} />
        <Stat label="Edited" value={formatRelativeTime(pod.updatedAt)} />
      </div>

      <DetailSection title="Tools">
        {pod.tools.length === 0 ? (
          <div className="text-[11px] text-muted-foreground">No tools allowed.</div>
        ) : (
          <div className="flex flex-wrap gap-1">
            {pod.tools.map((t) => (
              <span key={t} title={t} className="border border-border/60 bg-card px-2 py-0.5 text-[11px] text-foreground">
                {formatToolLabel(t)}
              </span>
            ))}
          </div>
        )}
      </DetailSection>

      <DetailSection title="Prompt">
        {pod.prompt ? (
          <pre className="whitespace-pre-wrap text-xs text-foreground">{pod.prompt}</pre>
        ) : (
          <div className="text-[11px] italic text-muted-foreground">(no prompt)</div>
        )}
      </DetailSection>
    </div>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div className="bg-card px-3 py-2">
      <div className="text-[9px] font-medium uppercase tracking-wider text-muted-foreground">{label}</div>
      <div className="mt-0.5 text-sm font-medium text-foreground">{value}</div>
    </div>
  );
}

function DetailSection({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="mb-5">
      <div className="mb-2 border-b border-border/40 pb-1 text-[10px] font-medium uppercase tracking-wider text-muted-foreground">
        {title}
      </div>
      {children}
    </section>
  );
}

function formatRelativeTime(epochMs: number): string {
  const diffSec = Math.max(0, Math.round((Date.now() - epochMs) / 1000));
  if (diffSec < 60) return `${diffSec}s ago`;
  const diffMin = Math.round(diffSec / 60);
  if (diffMin < 60) return `${diffMin}min ago`;
  const diffHr = Math.round(diffMin / 60);
  if (diffHr < 24) return `${diffHr}h ago`;
  const diffDay = Math.round(diffHr / 24);
  return `${diffDay}d ago`;
}
