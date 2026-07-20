// MCP manager screen (N6 reliability bar, master-plan "MCP manager —
// reliability requirements"). Lives inside AppSettingsModal as its own tab —
// the registry is global-scope, same home as Accounts. Visible-never-hidden:
// every server always renders its explicit health state + reason, even fully
// unreachable ones; nothing here silently disappears on error.

import { useEffect, useMemo, useState } from 'react';

import { mcpApi } from './client';
import type { McpServerDto } from './types';
import { useResourceEvents } from '@/state/resource-store';
import {
  healthLabel,
  healthReasonText,
  healthTone,
  overlayMcpHealth,
  parseTransportForm,
  secretStatusLabel,
  sortServersBySeverity,
  transportSummary,
  type HealthTone,
} from './view';
import type { McpConsumerKey } from '@pc/domain';

const TONE_CLASS: Record<HealthTone, string> = {
  ok: 'text-success',
  warn: 'text-warning',
  error: 'text-destructive',
  neutral: 'text-muted-foreground',
};

function formatEpoch(ms: number | null): string {
  if (ms === null) return 'never';
  return new Date(ms).toLocaleString([], { dateStyle: 'medium', timeStyle: 'short' });
}

export function McpManagerPanel() {
  const [servers, setServers] = useState<McpServerDto[] | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const [probingId, setProbingId] = useState<string | null>(null);

  const load = () => {
    mcpApi
      .list()
      .then((rows) => {
        setServers(rows);
        setLoadError(null);
      })
      .catch((e) => {
        setServers([]);
        setLoadError((e as Error).message);
      });
  };

  useEffect(() => {
    load();
  }, []);

  // Live health signals (self-healing reconnect, flap→degraded) surface
  // without waiting for a manual refresh (requirement 2/3).
  const mcpEvents = useResourceEvents('mcp-server', null);
  const displayed = useMemo(
    () => sortServersBySeverity(overlayMcpHealth(servers ?? [], mcpEvents)),
    [servers, mcpEvents],
  );

  async function reprobe(id: string) {
    setProbingId(id);
    try {
      await mcpApi.probe(id);
      load();
    } catch (e) {
      setLoadError((e as Error).message);
    } finally {
      setProbingId(null);
    }
  }

  async function remove(server: McpServerDto) {
    if (!window.confirm(`Remove MCP server "${server.name}"? Attached consumers lose access immediately.`)) return;
    try {
      await mcpApi.remove(server.id);
      if (expandedId === server.id) setExpandedId(null);
      load();
    } catch (e) {
      setLoadError((e as Error).message);
    }
  }

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <p className="text-xs text-muted-foreground">
          Registered once, shared across projects. Health is always shown — an unreachable server
          stays listed with its state and reason, never hidden.
        </p>
        <button
          onClick={() => setCreating((v) => !v)}
          className="shrink-0 border border-border px-2.5 py-1 text-xs font-medium hover:bg-muted"
        >
          {creating ? 'Cancel' : 'Add server…'}
        </button>
      </div>

      {loadError && <p className="text-xs text-destructive">{loadError}</p>}

      {creating && (
        <ServerForm
          onCancel={() => setCreating(false)}
          onSaved={() => {
            setCreating(false);
            load();
          }}
        />
      )}

      {servers === null ? (
        <div className="text-xs text-muted-foreground">Loading…</div>
      ) : displayed.length === 0 ? (
        <div className="border border-dashed border-border px-3 py-3 text-xs text-muted-foreground">
          No MCP servers registered yet.
        </div>
      ) : (
        <div className="divide-y divide-border border border-border">
          {displayed.map((server) => (
            <ServerRow
              key={server.id}
              server={server}
              expanded={expandedId === server.id}
              onToggleExpand={() => setExpandedId((cur) => (cur === server.id ? null : server.id))}
              onReprobe={() => reprobe(server.id)}
              probing={probingId === server.id}
              onRemove={() => remove(server)}
              onChanged={load}
            />
          ))}
        </div>
      )}
    </div>
  );
}

function ServerRow({
  server,
  expanded,
  onToggleExpand,
  onReprobe,
  probing,
  onRemove,
  onChanged,
}: {
  server: McpServerDto;
  expanded: boolean;
  onToggleExpand: () => void;
  onReprobe: () => void;
  probing: boolean;
  onRemove: () => void;
  onChanged: () => void;
}) {
  const reason = healthReasonText(server);
  const tone = TONE_CLASS[healthTone(server.health.state)];

  return (
    <div className="px-3 py-2.5">
      <div className="flex items-center gap-3">
        <button onClick={onToggleExpand} className="min-w-0 flex-1 text-left">
          <div className="flex items-center gap-2">
            <span className="truncate text-sm font-medium text-foreground">{server.name}</span>
            {!server.enabled && (
              <span className="shrink-0 text-[9px] uppercase tracking-wider text-muted-foreground">disabled</span>
            )}
            <span className={`shrink-0 text-[10px] font-semibold uppercase tracking-wider ${tone}`}>
              {healthLabel(server.health.state)}
            </span>
          </div>
          <div className="truncate text-[11px] text-muted-foreground">
            {transportSummary(server.transport)} · {server.health.toolCount ?? 0} tool
            {server.health.toolCount === 1 ? '' : 's'} · last probe {formatEpoch(server.health.lastProbeAt)}
          </div>
          {reason && <div className={`truncate text-[11px] ${tone}`}>{reason}</div>}
        </button>
        <button
          onClick={onReprobe}
          disabled={probing}
          className="shrink-0 border border-border px-2 py-1 text-[11px] hover:bg-muted disabled:opacity-50"
        >
          {probing ? 'Probing…' : 'Reprobe'}
        </button>
        <button
          onClick={onRemove}
          className="shrink-0 border border-destructive/50 px-2 py-1 text-[11px] text-destructive hover:bg-destructive/10"
        >
          Remove
        </button>
      </div>

      {expanded && (
        <div className="mt-3 space-y-4 border-t border-border pt-3">
          <ServerForm server={server} onCancel={onToggleExpand} onSaved={onChanged} />
          <SecretSection server={server} onChanged={onChanged} />
          <AttachmentsSection server={server} onChanged={onChanged} />
          {server.tools.length > 0 && (
            <div>
              <div className="mb-1 text-[10px] font-medium uppercase tracking-wider text-muted-foreground">
                Discovered tools
              </div>
              <div className="flex flex-wrap gap-1">
                {server.tools.map((t) => (
                  <code key={t} className="bg-muted px-1.5 py-0.5 text-[10px]">
                    {t}
                  </code>
                ))}
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

/** Add/edit form. Editing an existing server pre-fills from its (redacted)
 *  transport; leaving url/command untouched on an edit keeps the transport as
 *  stored (only sent when the field was actually edited by the user). */
function ServerForm({
  server,
  onCancel,
  onSaved,
}: {
  server?: McpServerDto;
  onCancel: () => void;
  onSaved: () => void;
}) {
  const [name, setName] = useState(server?.name ?? '');
  const [description, setDescription] = useState(server?.description ?? '');
  const [enabled, setEnabled] = useState(server?.enabled ?? true);
  const [url, setUrl] = useState(server?.transport.url ?? '');
  const [command, setCommand] = useState(server?.transport.command ?? '');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  async function save() {
    if (busy) return;
    const trimmedName = name.trim();
    if (!trimmedName) {
      setErr('name is required');
      return;
    }
    const parsed = parseTransportForm({ url, command });
    if (!parsed.ok) {
      setErr(parsed.error);
      return;
    }
    setBusy(true);
    setErr(null);
    try {
      if (server) {
        await mcpApi.update(server.id, {
          name: trimmedName,
          description,
          enabled,
          transport: parsed.transport,
        });
      } else {
        await mcpApi.create({ name: trimmedName, description, enabled, transport: parsed.transport });
      }
      onSaved();
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="space-y-2 border border-border bg-muted/30 p-3">
      <Field label="Name">
        <input
          value={name}
          onChange={(e) => setName(e.target.value)}
          className="w-full border border-border bg-background px-2 py-1 text-sm"
        />
      </Field>
      <Field label="Description">
        <input
          value={description}
          onChange={(e) => setDescription(e.target.value)}
          className="w-full border border-border bg-background px-2 py-1 text-sm"
        />
      </Field>
      <Field label="HTTP URL" help="Set exactly one of URL or command.">
        <input
          value={url}
          onChange={(e) => {
            setUrl(e.target.value);
            if (e.target.value) setCommand('');
          }}
          placeholder="https://host/mcp"
          className="w-full border border-border bg-background px-2 py-1 font-mono text-xs"
        />
      </Field>
      <Field label="stdio command">
        <input
          value={command}
          onChange={(e) => {
            setCommand(e.target.value);
            if (e.target.value) setUrl('');
          }}
          placeholder="node server.js"
          className="w-full border border-border bg-background px-2 py-1 font-mono text-xs"
        />
      </Field>
      <label className="flex items-center gap-2 text-xs text-foreground/90">
        <input type="checkbox" checked={enabled} onChange={(e) => setEnabled(e.target.checked)} />
        <span>Enabled — the manager probes and bridges this server</span>
      </label>
      <div className="flex items-center gap-2 pt-1">
        <button
          onClick={save}
          disabled={busy}
          className="bg-primary px-3 py-1.5 text-xs font-medium text-primary-foreground hover:bg-primary/90 disabled:opacity-50"
        >
          {busy ? 'Saving…' : server ? 'Save' : 'Create'}
        </button>
        <button onClick={onCancel} className="border border-border px-3 py-1.5 text-xs hover:bg-muted">
          Cancel
        </button>
        {err && <span className="text-xs text-destructive">{err}</span>}
      </div>
    </div>
  );
}

/** Write-only secret entry — a value can be set; it is never read back, only
 *  the presence/expiry/auth-state (requirement 4). */
function SecretSection({ server, onChanged }: { server: McpServerDto; onChanged: () => void }) {
  const [value, setValue] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [ok, setOk] = useState(false);

  async function submit() {
    if (busy || !value.trim()) return;
    setBusy(true);
    setErr(null);
    setOk(false);
    try {
      await mcpApi.putSecret(server.id, { value: value.trim() });
      setValue('');
      setOk(true);
      onChanged();
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div>
      <div className="mb-1 text-[10px] font-medium uppercase tracking-wider text-muted-foreground">
        Auth secret — {secretStatusLabel(server)}
      </div>
      <div className="flex items-center gap-2">
        <input
          type="password"
          value={value}
          onChange={(e) => setValue(e.target.value)}
          placeholder="Bearer token / API key"
          className="min-w-0 flex-1 border border-border bg-background px-2 py-1 font-mono text-xs"
        />
        <button
          onClick={submit}
          disabled={busy || !value.trim()}
          className="shrink-0 border border-border px-2.5 py-1 text-xs hover:bg-muted disabled:opacity-50"
        >
          {busy ? 'Saving…' : 'Set secret'}
        </button>
      </div>
      {err && <p className="mt-1 text-[11px] text-destructive">{err}</p>}
      {ok && <p className="mt-1 text-[11px] text-success">Secret stored.</p>}
    </div>
  );
}

/** Explicit per-consumer attachment (requirement 6) — orchestrator plus any
 *  named specialist (`agent:<name>`). A server with no attachment is visible
 *  to no consumer; this is the only place that changes. */
function AttachmentsSection({ server, onChanged }: { server: McpServerDto; onChanged: () => void }) {
  const [newAgent, setNewAgent] = useState('');
  const [busy, setBusy] = useState<McpConsumerKey | 'new' | null>(null);
  const [err, setErr] = useState<string | null>(null);

  const hasOrchestrator = server.consumers.includes('orchestrator');
  const agentConsumers = server.consumers.filter((c): c is `agent:${string}` => c.startsWith('agent:'));

  async function toggleOrchestrator() {
    setBusy('orchestrator');
    setErr(null);
    try {
      if (hasOrchestrator) await mcpApi.detach(server.id, 'orchestrator');
      else await mcpApi.attach(server.id, 'orchestrator');
      onChanged();
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusy(null);
    }
  }

  async function detachAgent(consumer: McpConsumerKey) {
    setBusy(consumer);
    setErr(null);
    try {
      await mcpApi.detach(server.id, consumer);
      onChanged();
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusy(null);
    }
  }

  async function addAgent() {
    const name = newAgent.trim();
    if (!name) return;
    const consumer: McpConsumerKey = `agent:${name}`;
    setBusy('new');
    setErr(null);
    try {
      await mcpApi.attach(server.id, consumer);
      setNewAgent('');
      onChanged();
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusy(null);
    }
  }

  return (
    <div>
      <div className="mb-1 text-[10px] font-medium uppercase tracking-wider text-muted-foreground">
        Attached consumers
      </div>
      <div className="flex flex-wrap items-center gap-1.5">
        <button
          onClick={toggleOrchestrator}
          disabled={busy === 'orchestrator'}
          className={
            'px-2 py-0.5 text-[11px] disabled:opacity-50 ' +
            (hasOrchestrator
              ? 'border border-primary bg-muted text-primary'
              : 'border border-border text-muted-foreground hover:bg-muted')
          }
        >
          orchestrator{hasOrchestrator ? ' ✓' : ''}
        </button>
        {agentConsumers.map((c) => (
          <button
            key={c}
            onClick={() => detachAgent(c)}
            disabled={busy === c}
            className="border border-primary bg-muted px-2 py-0.5 text-[11px] text-primary disabled:opacity-50"
            title="Click to detach"
          >
            {c} ✓
          </button>
        ))}
        <input
          value={newAgent}
          onChange={(e) => setNewAgent(e.target.value)}
          placeholder="agent name"
          className="w-24 border border-border bg-background px-1.5 py-0.5 text-[11px]"
        />
        <button
          onClick={addAgent}
          disabled={busy === 'new' || !newAgent.trim()}
          className="border border-border px-2 py-0.5 text-[11px] hover:bg-muted disabled:opacity-50"
        >
          Attach agent
        </button>
      </div>
      {err && <p className="mt-1 text-[11px] text-destructive">{err}</p>}
    </div>
  );
}

function Field({ label, help, children }: { label: string; help?: string; children: React.ReactNode }) {
  return (
    <div className="space-y-1">
      <div className="text-xs text-muted-foreground">{label}</div>
      {children}
      {help && <div className="text-xs text-muted-foreground">{help}</div>}
    </div>
  );
}
