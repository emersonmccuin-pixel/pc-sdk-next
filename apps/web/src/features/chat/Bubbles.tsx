// Bubble renderers for canonical timeline items. Each tool call stays one safe,
// app-authored lifecycle row keyed by callId; raw input, output, and provider
// denial text have no browser render path. Private reasoning likewise has no
// canonical render path.

import { useState } from 'react';

import { formatToolLabel } from '@/lib/tool-labels';
import { Markdown } from './Markdown';
import type { RenderItem, ToolCall } from './chat-render';

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

// ── Tools ───────────────────────────────────────────────────────────────────

const TOOL_STATE_TONE: Record<ToolCall['state'], string> = {
  requested: 'text-muted-foreground',
  'approval-needed': 'text-warning',
  running: 'text-accent',
  succeeded: 'text-success',
  failed: 'text-destructive',
  denied: 'text-warning',
};

function ToolCallRow({ call }: { call: ToolCall }) {
  const provenance = call.approval.source
    ? ` · ${call.approval.source}`
    : '';
  return (
    <div className="flex items-center gap-2 text-xs" data-tool-call-id={call.callId}>
      <span className="text-accent" title={formatToolLabel(call.name)}>{call.safeSummary}</span>
      <span className={`text-[10px] uppercase tracking-wider ${TOOL_STATE_TONE[call.state]}`}>
        {call.state.replace('-', ' ')}{provenance}
      </span>
      {call.outcome && (
        <span className="text-[10px] text-muted-foreground">{call.outcome.reason.replace('-', ' ')}</span>
      )}
    </div>
  );
}

export function ToolGroup({ calls }: { calls: ToolCall[] }) {
  const anyError = calls.some((call) => call.state === 'failed' || call.state === 'denied');
  return (
    <div
      className={
        'space-y-1 border-l-2 pl-3 ' + (anyError ? 'border-destructive/50' : 'border-border/60')
      }
    >
      {calls.map((c) => (
        <ToolCallRow key={c.callId} call={c} />
      ))}
    </div>
  );
}

// ── Structural bubbles ──────────────────────────────────────────────────────

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

export function CompactionDivider({
  trigger,
  preTokens,
  postTokens,
}: {
  trigger: 'manual' | 'auto' | 'unknown';
  preTokens: number | null;
  postTokens: number | null;
}) {
  const triggerLabel = trigger === 'unknown' ? '' : ` (${trigger})`;
  const tokenLabel = preTokens === null && postTokens === null
    ? 'token counts unavailable'
    : `${preTokens === null ? '…' : preTokens.toLocaleString()} → ${
      postTokens === null ? '…' : postTokens.toLocaleString()
    } tokens`;
  return (
    <div className="flex items-center gap-2 py-1 text-[10px] uppercase tracking-wider text-muted-foreground">
      <span className="h-px flex-1 bg-border" />
      <span>
        compacted{triggerLabel} · {tokenLabel}
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
    case 'tool-group':
      return <ToolGroup calls={item.calls} />;
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
