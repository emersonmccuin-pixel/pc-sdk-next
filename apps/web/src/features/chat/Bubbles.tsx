// Bubble renderers for every render item. Tool calls pair into collapsible
// groups; Edit/Write/NotebookEdit promote to diff cards; tool-result.isError
// renders as a visible failed state (the old UI dropped it — ours must not);
// thinking, compaction dividers, denied tools, dispatch anchors, sidechains,
// system + turn-failed bubbles all render structurally.

import { useState } from 'react';

import { formatToolLabel } from '@/lib/tool-labels';
import { Markdown } from './Markdown';
import { DiffView } from './DiffView';
import type { RenderItem, ToolCall } from './chat-render';

function stringify(value: unknown): string {
  if (value == null) return '';
  if (typeof value === 'string') return value;
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}

function truncate(text: string, max = 2000): string {
  return text.length > max ? `${text.slice(0, max)}\n… (${text.length - max} more chars)` : text;
}

// ── Content bubbles ─────────────────────────────────────────────────────────

export function UserBubble({ text, pending }: { text: string; pending?: 'sending' | 'queued' | 'failed' }) {
  return (
    <div className="flex justify-end">
      <div
        className={
          'max-w-[85%] whitespace-pre-wrap break-words border border-primary/40 bg-primary/10 px-3 py-2 text-sm text-foreground ' +
          (pending === 'failed' ? 'opacity-70 ring-1 ring-destructive/50' : pending ? 'opacity-60' : '')
        }
      >
        {text}
        {pending && (
          <span className="ml-2 text-[10px] uppercase tracking-wider text-muted-foreground">{pending}</span>
        )}
      </div>
    </div>
  );
}

export function AssistantBubble({ text, live }: { text: string; live?: boolean }) {
  return (
    <div className="border border-border bg-card px-3 py-2 text-sm">
      <Markdown text={text} />
      {live && <span className="ml-0.5 inline-block h-3.5 w-1.5 animate-pulse bg-primary align-text-bottom" />}
    </div>
  );
}

export function ThinkingBubble({ text, live }: { text: string; live?: boolean }) {
  const [open, setOpen] = useState(false);
  const preview = text.split('\n')[0]?.slice(0, 80) ?? '';
  return (
    <div className="border-l-2 border-border/60 bg-muted/10 px-3 py-1.5 text-xs text-muted-foreground">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="flex w-full items-center gap-1.5 text-left italic hover:text-foreground"
      >
        <span className="text-[10px] uppercase tracking-wider not-italic">{open ? '▾' : '▸'} thinking</span>
        {!open && <span className="truncate opacity-70">{preview}</span>}
        {live && <span className="ml-1 inline-block h-2.5 w-1 animate-pulse bg-muted-foreground align-middle" />}
      </button>
      {open && <div className="mt-1 whitespace-pre-wrap break-words italic">{text}</div>}
    </div>
  );
}

// ── Tools ───────────────────────────────────────────────────────────────────

function editDiff(call: ToolCall): { oldText: string; newText: string; path?: string } {
  const input = (call.input ?? {}) as Record<string, unknown>;
  const path = (input.file_path ?? input.notebook_path) as string | undefined;
  if (call.name === 'Write') return { oldText: '', newText: String(input.content ?? ''), path };
  if (call.name === 'MultiEdit' && Array.isArray(input.edits)) {
    const edits = input.edits as Array<{ old_string?: string; new_string?: string }>;
    return {
      oldText: edits.map((e) => e.old_string ?? '').join('\n'),
      newText: edits.map((e) => e.new_string ?? '').join('\n'),
      path,
    };
  }
  return {
    oldText: String(input.old_string ?? ''),
    newText: String(input.new_string ?? input.new_source ?? ''),
    path,
  };
}

export function EditCard({ call }: { call: ToolCall }) {
  const { oldText, newText, path } = editDiff(call);
  return (
    <div className="space-y-1">
      <div className="flex items-center gap-2 text-[10px] uppercase tracking-wider text-muted-foreground">
        <span className="text-accent">{formatToolLabel(call.name)}</span>
        {!call.ended && <span className="text-warning">running…</span>}
        {call.isError && <span className="text-destructive">failed</span>}
      </div>
      <DiffView oldText={oldText} newText={newText} path={path} />
      {call.isError && <ToolResultBody result={call.result} isError />}
    </div>
  );
}

function ToolResultBody({ result, isError }: { result: unknown; isError: boolean }) {
  const text = truncate(stringify(result));
  if (!text) return null;
  return (
    <pre
      className={
        'mt-1 max-h-64 overflow-auto whitespace-pre-wrap break-words border px-2 py-1 font-mono text-[11px] ' +
        (isError ? 'border-destructive/50 bg-destructive/10 text-foreground' : 'border-border bg-background text-muted-foreground')
      }
    >
      {isError && <span className="mr-1 font-semibold uppercase text-destructive">error</span>}
      {text}
    </pre>
  );
}

function ToolCallRow({ call }: { call: ToolCall }) {
  const [open, setOpen] = useState(false);
  const inputText = truncate(stringify(call.input), 800);
  return (
    <div className="text-xs">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="flex w-full items-center gap-1.5 text-left hover:text-foreground"
      >
        <span className="text-[10px]">{open ? '▾' : '▸'}</span>
        <span className="text-accent">{formatToolLabel(call.name)}</span>
        {!call.ended && <span className="text-[10px] uppercase tracking-wider text-warning">running…</span>}
        {call.isError && <span className="text-[10px] uppercase tracking-wider text-destructive">failed</span>}
        {call.ended && !call.isError && <span className="text-[10px] text-success">✓</span>}
      </button>
      {open && (
        <div className="mt-1 space-y-1 pl-4">
          {inputText && (
            <pre className="max-h-48 overflow-auto whitespace-pre-wrap break-words border border-border bg-background px-2 py-1 font-mono text-[11px] text-muted-foreground">
              {inputText}
            </pre>
          )}
          <ToolResultBody result={call.result} isError={call.isError} />
        </div>
      )}
    </div>
  );
}

export function ToolGroup({ calls }: { calls: ToolCall[] }) {
  const anyError = calls.some((c) => c.isError);
  return (
    <div
      className={
        'space-y-1 border-l-2 pl-3 ' + (anyError ? 'border-destructive/50' : 'border-border/60')
      }
    >
      {calls.map((c) => (
        <ToolCallRow key={c.toolUseId} call={c} />
      ))}
    </div>
  );
}

// ── Structural bubbles ──────────────────────────────────────────────────────

export function DeniedBubble({ name, reason }: { name: string; reason: string }) {
  return (
    <div className="border border-warning/50 bg-warning/10 px-3 py-1.5 text-xs">
      <span className="font-semibold uppercase tracking-wider text-warning">tool denied</span>{' '}
      <span className="text-foreground">{formatToolLabel(name)}</span>
      <div className="mt-0.5 text-muted-foreground">{reason}</div>
    </div>
  );
}

export function DispatchBubble({ agentName, runId }: { agentName: string; runId: string }) {
  return (
    <div className="border border-accent/40 bg-accent/5 px-3 py-1.5 text-xs">
      <span className="text-[10px] uppercase tracking-wider text-accent">dispatched</span>{' '}
      <span className="text-foreground">{agentName}</span>
      <span className="ml-1 font-mono text-[10px] text-muted-foreground">{runId.slice(0, 8)}</span>
    </div>
  );
}

const AGENT_RUN_STATUS_TONE: Record<'waiting' | 'done' | 'failed', string> = {
  waiting: 'border-warning/50 bg-warning/10 text-warning',
  done: 'border-success/50 bg-success/10 text-success',
  failed: 'border-destructive/50 bg-destructive/10 text-destructive',
};

export function AgentRunCard({
  agentName,
  status,
  summary,
  detail,
  pendingAskId,
}: {
  agentName: string;
  status: 'waiting' | 'done' | 'failed';
  summary: string;
  detail: string;
  pendingAskId?: string;
}) {
  const [open, setOpen] = useState(false);
  return (
    <div className="border border-accent/40 bg-accent/5 px-3 py-1.5 text-xs">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="flex w-full items-center gap-2 text-left hover:text-foreground"
      >
        <span className="text-[10px]">{open ? '▾' : '▸'}</span>
        <span className="font-semibold text-foreground">{agentName}</span>
        <span className={`border px-1.5 py-0.5 text-[10px] uppercase tracking-wider ${AGENT_RUN_STATUS_TONE[status]}`}>
          {status}
        </span>
        {!open && <span className="truncate text-muted-foreground">{summary}</span>}
      </button>
      {open && (
        <div className="mt-1 space-y-1 pl-4">
          <div className="whitespace-pre-wrap break-words text-muted-foreground">{detail}</div>
          {pendingAskId && (
            <div className="font-mono text-[10px] text-muted-foreground">pendingAskId: {pendingAskId}</div>
          )}
        </div>
      )}
    </div>
  );
}

export function CompactionDivider({ trigger, preTokens, postTokens }: { trigger: string; preTokens: number; postTokens: number | null }) {
  return (
    <div className="flex items-center gap-2 py-1 text-[10px] uppercase tracking-wider text-muted-foreground">
      <span className="h-px flex-1 bg-border" />
      <span>
        compacted ({trigger}) {preTokens.toLocaleString()}
        {postTokens != null ? ` → ${postTokens.toLocaleString()}` : ''} tokens
      </span>
      <span className="h-px flex-1 bg-border" />
    </div>
  );
}

export function SystemBubble({ level, message }: { level: 'info' | 'notice' | 'warning' | 'error'; message: string }) {
  const tone =
    level === 'error'
      ? 'border-destructive/50 bg-destructive/10 text-foreground'
      : level === 'warning'
        ? 'border-warning/50 bg-warning/10 text-foreground'
        : 'border-border bg-muted/10 text-muted-foreground';
  return (
    <div className={`border px-3 py-1.5 text-xs ${tone}`}>
      <span className="mr-1 text-[10px] uppercase tracking-wider opacity-70">{level}</span>
      {message}
    </div>
  );
}

export function TurnFailedBubble({ error, source }: { error: string; source: string }) {
  return (
    <div className="border border-destructive/60 bg-destructive/10 px-3 py-2 text-sm">
      <span className="text-[10px] uppercase tracking-wider text-destructive">turn failed · {source}</span>
      <div className="mt-0.5 whitespace-pre-wrap break-words text-foreground">{error}</div>
    </div>
  );
}

export function TurnEndMarker({ stopReason }: { stopReason: string | null }) {
  return (
    <div className="py-0.5 text-[10px] uppercase tracking-wider text-muted-foreground/70">stopped: {stopReason}</div>
  );
}

export function SidechainGroup({ steps }: { steps: { role: string; text: string }[] }) {
  const [open, setOpen] = useState(false);
  return (
    <div className="border-l-2 border-accent/40 bg-accent/5 pl-3 text-xs">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="flex w-full items-center gap-1.5 py-1 text-left hover:text-foreground"
      >
        <span className="text-[10px]">{open ? '▾' : '▸'}</span>
        <span className="text-[10px] uppercase tracking-wider text-accent">sub-agent · {steps.length} steps</span>
      </button>
      {open && (
        <div className="space-y-1 pb-1">
          {steps.map((s, i) => (
            <div key={i} className="whitespace-pre-wrap break-words">
              <span className="mr-1 text-[10px] uppercase text-muted-foreground">{s.role}</span>
              {s.text}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

export function RenderItemView({ item }: { item: RenderItem }) {
  switch (item.kind) {
    case 'user':
      return <UserBubble text={item.text} />;
    case 'assistant':
      return <AssistantBubble text={item.text} />;
    case 'thinking':
      return <ThinkingBubble text={item.text} />;
    case 'tool-group':
      return <ToolGroup calls={item.calls} />;
    case 'edit':
      return <EditCard call={item.call} />;
    case 'denied':
      return <DeniedBubble name={item.name} reason={item.reason} />;
    case 'dispatch':
      return <DispatchBubble agentName={item.agentName} runId={item.runId} />;
    case 'agent-run':
      return (
        <AgentRunCard
          agentName={item.agentName}
          status={item.status}
          summary={item.summary}
          detail={item.detail}
          pendingAskId={item.pendingAskId}
        />
      );
    case 'sidechain-group':
      return <SidechainGroup steps={item.steps} />;
    case 'compaction':
      return <CompactionDivider trigger={item.trigger} preTokens={item.preTokens} postTokens={item.postTokens} />;
    case 'system':
      return <SystemBubble level={item.level} message={item.message} />;
    case 'turn-failed':
      return <TurnFailedBubble error={item.error} source={item.source} />;
    case 'turn-end':
      return <TurnEndMarker stopReason={item.stopReason} />;
  }
}
