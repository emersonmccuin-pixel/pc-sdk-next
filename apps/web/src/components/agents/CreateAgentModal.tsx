// Create-agent modal — the manual form (port of PC-PTY-Chat's CreatePodModal
// ManualForm; the conversational agent-designer flow returns with Phase 3
// dispatch). Creates a GLOBAL pool agent and attaches it to the current
// project in one call. Explicit close-only (no backdrop/Escape dismissal).

import { useState } from 'react';

import { agentsApi, type Pod } from '@/features/agents/client';
import type { ULID } from '@pc/contracts';

const EFFORTS = ['', 'low', 'medium', 'high', 'xhigh', 'max'] as const;

interface CreateAgentModalProps {
  projectId: ULID;
  onCancel: () => void;
  onCreated: (pod: Pod) => void;
}

export function CreateAgentModal({ projectId, onCancel, onCreated }: CreateAgentModalProps) {
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [prompt, setPrompt] = useState('');
  const [model, setModel] = useState('');
  const [effort, setEffort] = useState<(typeof EFFORTS)[number]>('');
  const [maxTurns, setMaxTurns] = useState('');
  const [tools, setTools] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const trimmedName = name.trim();
  const nameValid = /^[a-z0-9][a-z0-9-]*$/.test(trimmedName);
  const turnsValid = maxTurns.trim() === '' || (Number.isInteger(Number(maxTurns)) && Number(maxTurns) > 0);
  const canSubmit = nameValid && turnsValid && !busy;

  async function submit() {
    if (!canSubmit) return;
    setBusy(true);
    setErr(null);
    try {
      const pod = await agentsApi.createPod({
        name: trimmedName,
        description: description.trim() || undefined,
        prompt: prompt || undefined,
        model: model.trim() || undefined,
        effort: effort || undefined,
        maxTurns: maxTurns.trim() ? Number(maxTurns) : undefined,
        tools: tools.trim() ? tools.split(',').map((t) => t.trim()).filter(Boolean) : undefined,
        attachProjectId: projectId,
      });
      onCreated(pod);
    } catch (e) {
      setErr((e as Error).message);
      setBusy(false);
    }
  }

  return (
    <div className="fixed inset-0 z-50 grid place-items-center bg-black/50">
      <div className="flex max-h-[85vh] w-[560px] flex-col border border-border bg-card text-foreground shadow-xl">
        <header className="flex items-center justify-between border-b border-border px-4 py-3">
          <h2 className="text-base font-semibold text-foreground">New agent</h2>
          <button
            onClick={onCancel}
            disabled={busy}
            className="text-muted-foreground hover:text-foreground disabled:opacity-50"
            aria-label="Close"
          >
            ×
          </button>
        </header>

        <div className="flex flex-col gap-3 overflow-y-auto px-4 py-4">
          <Field label="Name" help="Lowercase kebab-case (a-z, 0-9, dashes). Global — one pool across all projects.">
            <input
              type="text"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="cold-emailer"
              autoFocus
              className="w-full border border-border bg-background px-2 py-1 font-mono text-xs"
            />
            {trimmedName && !nameValid && (
              <div className="mt-1 text-xs text-destructive">kebab-case only (a-z, 0-9, dashes)</div>
            )}
          </Field>
          <Field label="Description" help="One line: what this agent is for.">
            <input
              type="text"
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              className="w-full border border-border bg-background px-2 py-1 text-sm"
            />
          </Field>
          <Field label="Prompt" help="The agent's instructions (its system prompt).">
            <textarea
              value={prompt}
              onChange={(e) => setPrompt(e.target.value)}
              rows={8}
              className="w-full resize-y border border-border bg-background px-2 py-1 font-mono text-xs"
            />
          </Field>
          <div className="grid grid-cols-3 gap-3">
            <Field label="Model" help="haiku / sonnet / opus or a full id">
              <input
                type="text"
                value={model}
                onChange={(e) => setModel(e.target.value)}
                placeholder="default"
                className="w-full border border-border bg-background px-2 py-1 text-sm"
              />
            </Field>
            <Field label="Effort">
              <select
                value={effort}
                onChange={(e) => setEffort(e.target.value as (typeof EFFORTS)[number])}
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
            </Field>
          </div>
          <Field label="Tools" help="Comma-separated allowlist (e.g. Read, Glob, Grep, Bash). Empty = allow all.">
            <input
              type="text"
              value={tools}
              onChange={(e) => setTools(e.target.value)}
              placeholder="Read, Glob, Grep"
              className="w-full border border-border bg-background px-2 py-1 font-mono text-xs"
            />
          </Field>
          {err && <p className="text-xs text-destructive">{err}</p>}
        </div>

        <div className="flex items-center justify-end gap-2 border-t border-border px-4 py-3">
          <button
            onClick={onCancel}
            disabled={busy}
            className="border border-border px-3 py-1.5 text-sm hover:bg-muted disabled:opacity-50"
          >
            Cancel
          </button>
          <button
            onClick={submit}
            disabled={!canSubmit}
            className="bg-primary px-3 py-1.5 text-sm font-medium text-primary-foreground hover:bg-primary/90 disabled:opacity-50"
          >
            {busy ? 'Creating…' : 'Create agent'}
          </button>
        </div>
      </div>
    </div>
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
