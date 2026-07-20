// Agents tab roster — the global-pool edit surface. Two-pane: searchable list
// (Built-in + This project), detail pane with three variants:
//   - user-created: editable (prompt/scalars/tools) + delete
//   - stock specialist: read-only, "Customized" pill + reset-to-default
//   - orchestrator: editable prompt/model/effort/maxTurns (name + tools locked);
//     edits apply on the chat's next message.
// Refetches wholesale on any `specialist` resource frame for this project —
// the payload is signal-only by design (contract), so a refetch is correct.

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import type { Project } from '@/features/projects/client';
import { agentsApi, resolveModelLabel, type Pod } from '@/features/agents/client';
import { CreateAgentModal } from '@/components/agents/CreateAgentModal';
import { formatToolLabel } from '@/lib/tool-labels';
import { useResourceEvents } from '@/state/resource-store';
import { useRuntimes } from '@/state/runtimes';
import type { ULID } from '@pc/contracts';

const EFFORTS = ['', 'low', 'medium', 'high', 'xhigh', 'max'] as const;

export function AgentsList({ project }: { project: Project }) {
  const [pods, setPods] = useState<Pod[] | null>(null);
  const [filter, setFilter] = useState('');
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [builtinCollapsed, setBuiltinCollapsed] = useState(true);
  const [createOpen, setCreateOpen] = useState(false);

  const load = useCallback(() => {
    agentsApi
      .listPods(project.id as ULID)
      .then(setPods)
      .catch(() => setPods([]));
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

  /** Replace one pod in place (mutation responses beat the frame refetch). */
  const applyPod = useCallback((next: Pod) => {
    setPods((prev) => (prev ? prev.map((p) => (p.id === next.id ? next : p)) : prev));
  }, []);

  if (pods === null) {
    return <div className="grid h-full place-items-center text-xs text-muted-foreground">Loading…</div>;
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
        <button
          onClick={() => setCreateOpen(true)}
          className="shrink-0 bg-primary px-3 py-1.5 text-xs font-medium text-primary-foreground hover:bg-primary/90"
        >
          + New agent
        </button>
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
            <DetailPane
              key={`${selectedPod.id}:${selectedPod.updatedAt}`}
              pod={selectedPod}
              projectId={project.id as ULID}
              onMutated={applyPod}
              onDeleted={() => {
                setSelectedId(null);
                load();
              }}
            />
          ) : (
            <div className="grid h-full place-items-center p-8 text-center text-xs text-muted-foreground">
              No agent selected.
            </div>
          )}
        </main>
      </div>

      {createOpen && (
        <CreateAgentModal
          projectId={project.id as ULID}
          onCancel={() => setCreateOpen(false)}
          onCreated={(pod) => {
            setCreateOpen(false);
            setPods((prev) => (prev ? [...prev, pod] : [pod]));
            setSelectedId(pod.id);
          }}
        />
      )}
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

function DetailPane({
  pod,
  projectId,
  onMutated,
  onDeleted,
}: {
  pod: Pod;
  projectId: ULID;
  onMutated: (next: Pod) => void;
  onDeleted: () => void;
}) {
  const isStock = pod.origin === 'stock';
  const isOrchestrator = isStock && pod.name === 'orchestrator';
  if (isStock && !isOrchestrator) return <StockDetail pod={pod} onMutated={onMutated} />;
  return (
    <EditableDetail
      pod={pod}
      projectId={projectId}
      lockName={isOrchestrator}
      lockTools={isOrchestrator}
      hint={
        isOrchestrator
          ? "This is the chat orchestrator's system prompt — changes apply on your next message."
          : undefined
      }
      showReset={isOrchestrator && (pod.driftedFields?.length ?? 0) > 0}
      onMutated={onMutated}
      onDeleted={onDeleted}
    />
  );
}

function Badges({ pod }: { pod: Pod }) {
  const isStock = pod.origin === 'stock';
  return (
    <>
      <span
        className={
          'px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-wider ' +
          (isStock
            ? 'border border-success/40 bg-success/10 text-success'
            : 'border border-primary/40 bg-primary/10 text-primary')
        }
      >
        {isStock ? 'built-in' : 'custom'}
      </span>
      {(pod.driftedFields?.length ?? 0) > 0 && (
        <span className="border border-warning/40 bg-warning/10 px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-wider text-warning">
          customized
        </span>
      )}
    </>
  );
}

function StatGrid({ pod }: { pod: Pod }) {
  return (
    <div className="mb-6 grid grid-cols-2 gap-px border border-border/40 bg-border/40 sm:grid-cols-3 lg:grid-cols-5">
      <Stat label="Model" value={resolveModelLabel(pod.model)} />
      <Stat label="Effort" value={pod.effort ?? '—'} />
      <Stat label="Max turns" value={pod.maxTurns != null ? String(pod.maxTurns) : '∞'} />
      <Stat label="Tools" value={pod.tools.length === 0 ? 'all' : String(pod.tools.length)} />
      <Stat label="Edited" value={formatRelativeTime(pod.updatedAt)} />
    </div>
  );
}

function ToolChips({ tools }: { tools: string[] }) {
  if (tools.length === 0) {
    return <div className="text-[11px] text-muted-foreground">No allowlist — all tools permitted.</div>;
  }
  return (
    <div className="flex flex-wrap gap-1">
      {tools.map((t) => (
        <span key={t} title={t} className="border border-border/60 bg-card px-2 py-0.5 text-[11px] text-foreground">
          {formatToolLabel(t)}
        </span>
      ))}
    </div>
  );
}

/** Stock specialist — read-only, reset-to-default when customized. */
function StockDetail({ pod, onMutated }: { pod: Pod; onMutated: (next: Pod) => void }) {
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const drifted = (pod.driftedFields?.length ?? 0) > 0;

  async function reset() {
    if (busy) return;
    setBusy(true);
    setErr(null);
    try {
      const r = await agentsApi.resetToDefault(pod.id as ULID);
      onMutated(r.pod);
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="flex h-full flex-col px-6 py-5">
      <header className="mb-4 flex items-center gap-2">
        <h2 className="truncate text-lg font-semibold text-foreground">{pod.name}</h2>
        <Badges pod={pod} />
        {drifted && (
          <button
            onClick={reset}
            disabled={busy}
            className="ml-auto border border-border px-2 py-1 text-[11px] hover:bg-muted disabled:opacity-50"
          >
            {busy ? 'Resetting…' : 'Reset to default'}
          </button>
        )}
      </header>
      <p className="mb-2 text-[11px] text-muted-foreground">Built-in — managed by PC-SDK, available in every project.</p>
      {err && <p className="mb-2 text-xs text-destructive">{err}</p>}
      {pod.description && <p className="mb-5 max-w-3xl text-sm text-muted-foreground">{pod.description}</p>}
      <StatGrid pod={pod} />
      <DetailSection title="Tools">
        <ToolChips tools={pod.tools} />
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

/** Editable detail — user agents (everything) and the orchestrator (name +
 *  tools locked). Dirty-tracked Save/Discard like ProjectInfoForm. */
function EditableDetail({
  pod,
  projectId,
  lockName,
  lockTools,
  hint,
  showReset,
  onMutated,
  onDeleted,
}: {
  pod: Pod;
  projectId: ULID;
  lockName: boolean;
  lockTools: boolean;
  hint?: string;
  showReset: boolean;
  onMutated: (next: Pod) => void;
  onDeleted: () => void;
}) {
  // Runtime is project-scoped, not per-agent (docs/agent-runtime-architecture.md
  // — dispatch resolves this agent's model against whatever runtime the
  // PROJECT currently runs on, switched via the header runtime control). This
  // just feeds the model field with that runtime's discovered models.
  const runtimes = useRuntimes((s) => s.runtimes);
  const projectRuntimeId = useRuntimes((s) => s.selectedId);
  const loadRuntimeRegistry = useRuntimes((s) => s.loadRegistry);
  const loadRuntimeForProject = useRuntimes((s) => s.loadForProject);
  useEffect(() => {
    void loadRuntimeRegistry();
    void loadRuntimeForProject(projectId);
  }, [projectId, loadRuntimeRegistry, loadRuntimeForProject]);
  const projectRuntime = runtimes.find((r) => r.id === projectRuntimeId) ?? null;
  const discoveredModels = projectRuntime?.accounts.find((a) => a.available)?.models ?? [];

  const [name, setName] = useState(pod.name);
  const [description, setDescription] = useState(pod.description);
  const [prompt, setPrompt] = useState(pod.prompt);
  const [model, setModel] = useState(pod.model ?? '');
  const [effort, setEffort] = useState(pod.effort ?? '');
  const [maxTurns, setMaxTurns] = useState(pod.maxTurns != null ? String(pod.maxTurns) : '');
  const [tools, setTools] = useState(pod.tools.join(', '));
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [confirmDelete, setConfirmDelete] = useState(false);

  const trimmedName = name.trim();
  const parsedTools = tools.split(',').map((t) => t.trim()).filter(Boolean);
  const turnsValid = maxTurns.trim() === '' || (Number.isInteger(Number(maxTurns)) && Number(maxTurns) > 0);
  const nameValid = lockName || /^[a-z0-9][a-z0-9-]*$/.test(trimmedName);

  const dirty =
    (!lockName && trimmedName !== pod.name) ||
    description !== pod.description ||
    prompt !== pod.prompt ||
    (model.trim() || null) !== (pod.model ?? null) ||
    (effort || null) !== (pod.effort ?? null) ||
    (maxTurns.trim() ? Number(maxTurns) : null) !== (pod.maxTurns ?? null) ||
    (!lockTools && JSON.stringify(parsedTools) !== JSON.stringify(pod.tools));

  async function save() {
    if (busy || !dirty || !nameValid || !turnsValid) return;
    setBusy(true);
    setErr(null);
    try {
      const patch: Record<string, unknown> = {};
      if (!lockName && trimmedName !== pod.name) patch.name = trimmedName;
      if (description !== pod.description) patch.description = description;
      if (prompt !== pod.prompt) patch.prompt = prompt;
      if ((model.trim() || null) !== (pod.model ?? null)) patch.model = model.trim() || null;
      if ((effort || null) !== (pod.effort ?? null)) patch.effort = effort || null;
      if ((maxTurns.trim() ? Number(maxTurns) : null) !== (pod.maxTurns ?? null)) {
        patch.maxTurns = maxTurns.trim() ? Number(maxTurns) : null;
      }
      if (!lockTools && JSON.stringify(parsedTools) !== JSON.stringify(pod.tools)) patch.tools = parsedTools;
      const next = await agentsApi.updatePod(pod.id as ULID, patch);
      onMutated(next);
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  async function reset() {
    if (busy) return;
    setBusy(true);
    setErr(null);
    try {
      const r = await agentsApi.resetToDefault(pod.id as ULID);
      onMutated(r.pod);
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  async function doDelete() {
    if (busy) return;
    setBusy(true);
    setErr(null);
    try {
      await agentsApi.deletePod(pod.id as ULID);
      onDeleted();
    } catch (e) {
      setErr((e as Error).message);
      setBusy(false);
    }
  }

  return (
    <div className="flex h-full flex-col px-6 py-5">
      <header className="mb-4 flex items-center gap-2">
        <h2 className="truncate text-lg font-semibold text-foreground">{pod.name}</h2>
        <Badges pod={pod} />
        {showReset && (
          <button
            onClick={reset}
            disabled={busy}
            className="ml-auto border border-border px-2 py-1 text-[11px] hover:bg-muted disabled:opacity-50"
          >
            {busy ? 'Working…' : 'Reset to default'}
          </button>
        )}
      </header>
      {hint && <p className="mb-3 text-[11px] text-warning">{hint}</p>}
      <StatGrid pod={pod} />

      <div className="max-w-3xl space-y-3">
        {!lockName && (
          <Field label="Name" help="Lowercase kebab-case. Renames apply everywhere the agent is attached.">
            <input
              type="text"
              value={name}
              onChange={(e) => setName(e.target.value)}
              className="w-full border border-border bg-background px-2 py-1 font-mono text-xs"
            />
            {trimmedName && !nameValid && (
              <div className="mt-1 text-xs text-destructive">kebab-case only (a-z, 0-9, dashes)</div>
            )}
          </Field>
        )}
        <Field label="Description">
          <input
            type="text"
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            className="w-full border border-border bg-background px-2 py-1 text-sm"
          />
        </Field>
        <Field label="Prompt">
          <textarea
            value={prompt}
            onChange={(e) => setPrompt(e.target.value)}
            rows={16}
            className="w-full resize-y border border-border bg-background px-2 py-1 font-mono text-xs"
          />
        </Field>
        <div className="grid grid-cols-3 gap-3">
          <Field
            label="Model"
            help={
              projectRuntime
                ? `Runs on this project's runtime: ${projectRuntime.label}${
                    discoveredModels.length > 0 ? ' — pick a discovered model or type one' : ''
                  }`
                : 'haiku / sonnet / opus or a full id'
            }
          >
            <input
              type="text"
              list="edit-agent-model-options"
              value={model}
              onChange={(e) => setModel(e.target.value)}
              placeholder="default"
              className="w-full border border-border bg-background px-2 py-1 text-sm"
            />
            {discoveredModels.length > 0 && (
              <datalist id="edit-agent-model-options">
                {discoveredModels.map((m) => (
                  <option key={m.id} value={m.id}>
                    {m.label}
                  </option>
                ))}
              </datalist>
            )}
          </Field>
          <Field label="Effort">
            <select
              value={effort}
              onChange={(e) => setEffort(e.target.value)}
              className="w-full border border-border bg-background px-2 py-1 text-sm"
            >
              {EFFORTS.map((v) => (
                <option key={v} value={v}>
                  {v || 'default'}
                </option>
              ))}
            </select>
          </Field>
          <Field label="Max turns">
            <input
              type="text"
              value={maxTurns}
              onChange={(e) => setMaxTurns(e.target.value)}
              placeholder="∞"
              className="w-full border border-border bg-background px-2 py-1 text-sm"
            />
            {!turnsValid && <div className="mt-1 text-xs text-destructive">positive integer or blank</div>}
          </Field>
        </div>
        {lockTools ? (
          <Field label="Tools" help="Locked — the chat runner owns the orchestrator's tool surface until dispatch lands.">
            <ToolChips tools={pod.tools} />
          </Field>
        ) : (
          <Field label="Tools" help="Comma-separated allowlist. Empty = allow all.">
            <input
              type="text"
              value={tools}
              onChange={(e) => setTools(e.target.value)}
              className="w-full border border-border bg-background px-2 py-1 font-mono text-xs"
            />
          </Field>
        )}

        <div className="flex items-center gap-2 pt-1">
          <button
            onClick={save}
            disabled={busy || !dirty || !nameValid || !turnsValid}
            className="bg-primary px-3 py-1.5 text-xs font-medium text-primary-foreground hover:bg-primary/90 disabled:opacity-50"
          >
            {busy ? 'Saving…' : 'Save'}
          </button>
          {!lockName && (
            <>
              {confirmDelete ? (
                <span className="flex items-center gap-2">
                  <span className="text-xs text-destructive">Delete this agent everywhere?</span>
                  <button
                    onClick={doDelete}
                    disabled={busy}
                    className="border border-destructive/60 px-2 py-1 text-xs text-destructive hover:bg-destructive/10 disabled:opacity-50"
                  >
                    Delete
                  </button>
                  <button
                    onClick={() => setConfirmDelete(false)}
                    disabled={busy}
                    className="border border-border px-2 py-1 text-xs hover:bg-muted disabled:opacity-50"
                  >
                    Keep
                  </button>
                </span>
              ) : (
                <button
                  onClick={() => setConfirmDelete(true)}
                  disabled={busy}
                  className="ml-auto border border-destructive/60 px-3 py-1.5 text-xs text-destructive hover:bg-destructive/10 disabled:opacity-50"
                >
                  Delete…
                </button>
              )}
            </>
          )}
          {err && <span className="text-xs text-destructive">{err}</span>}
        </div>
      </div>
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

function Field({ label, help, children }: { label: string; help?: string; children: React.ReactNode }) {
  return (
    <div className="space-y-1">
      <div className="text-xs text-muted-foreground">{label}</div>
      {children}
      {help && <div className="text-[11px] text-muted-foreground/80">{help}</div>}
    </div>
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
