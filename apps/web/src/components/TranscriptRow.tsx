// One row per ChatEvent (docs/event-contract.md Channel 1) — the transcript
// reuses the same event union orchestrator chat persists, per contract
// ("Agent transcripts reuse ChatEvent — one render pipeline for orchestrator
// chat and agent run views"). Standalone for now: the orchestrator chat
// surface (bubbles/markdown/diff) is a sibling's build; once it lands this
// should fold into whatever shared renderer it exposes instead of keeping two
// pipelines. Until then this is the one place agent transcripts render from.

import type { ChatEvent } from '@pc/contracts';

export type RowTone = 'user' | 'assistant' | 'tool' | 'system' | 'error' | 'muted';

export function Row({
  label,
  tone,
  children,
}: {
  label: string;
  tone: RowTone;
  children: React.ReactNode;
}) {
  const toneClasses: Record<RowTone, string> = {
    user: 'border-l-primary/60',
    assistant: 'border-l-foreground/30',
    tool: 'border-l-muted-foreground/40',
    system: 'border-l-warning/60',
    error: 'border-l-destructive/70',
    muted: 'border-l-border',
  };
  return (
    <li className={`border-l-2 ${toneClasses[tone]} pl-2`}>
      <div className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
        {label}
      </div>
      <div className="mt-0.5 text-xs">{children}</div>
    </li>
  );
}

export function safeJson(value: unknown): string {
  if (value == null) return '';
  if (typeof value === 'string') return value;
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}

export function truncate(s: string, max: number): string {
  if (s.length <= max) return s;
  return s.slice(0, max) + `\n… (${s.length - max} more chars)`;
}

export function TranscriptRow({ event }: { event: ChatEvent }) {
  switch (event.kind) {
    case 'user':
      return (
        <Row label="user" tone="user">
          <div className="whitespace-pre-wrap text-foreground">{event.text}</div>
        </Row>
      );
    case 'assistant-text':
      return (
        <Row label={event.midLoop ? 'assistant · mid-loop' : 'assistant'} tone="assistant">
          <div className="whitespace-pre-wrap text-foreground">{event.text}</div>
        </Row>
      );
    case 'thinking':
      return (
        <Row label="thinking" tone="muted">
          <div className="whitespace-pre-wrap italic text-muted-foreground">{event.text}</div>
        </Row>
      );
    case 'turn-end':
      return (
        <Row label="turn end" tone="assistant">
          {event.text && <div className="whitespace-pre-wrap text-foreground">{event.text}</div>}
          {event.stopReason && event.stopReason !== 'end_turn' && (
            <div className="mt-1 font-mono text-[10px] text-muted-foreground">
              stop: {event.stopReason}
            </div>
          )}
        </Row>
      );
    case 'turn-failed':
      return (
        <Row label={`turn failed · ${event.source}`} tone="error">
          <div className="whitespace-pre-wrap text-destructive">{event.error}</div>
        </Row>
      );
    case 'tool-call':
      return (
        <Row label={`tool: ${event.name}`} tone="tool">
          <pre className="whitespace-pre-wrap font-mono text-[11px] text-muted-foreground">
            {truncate(safeJson(event.input), 800)}
          </pre>
        </Row>
      );
    case 'tool-result':
      return (
        <Row label={event.isError ? 'tool result · error' : 'tool result'} tone={event.isError ? 'error' : 'tool'}>
          <pre className="whitespace-pre-wrap font-mono text-[11px] text-muted-foreground">
            {truncate(safeJson(event.result), 800)}
          </pre>
        </Row>
      );
    case 'tool-denied':
      return (
        <Row label={`tool denied: ${event.name}`} tone="error">
          <div className="text-destructive">{event.reason}</div>
        </Row>
      );
    case 'usage':
      return (
        <Row label="usage" tone="muted">
          <div className="font-mono text-[10px] text-muted-foreground">
            in {event.inputTokens} · out {event.outputTokens} · cache-r {event.cacheReadTokens} ·
            cache-w {event.cacheCreationTokens}
            {event.model ? ` · ${event.model}` : ''}
          </div>
        </Row>
      );
    case 'turn-duration':
      return (
        <Row label="turn duration" tone="muted">
          <div className="font-mono text-[10px] text-muted-foreground">
            {event.durationMs != null ? `${(event.durationMs / 1000).toFixed(1)}s` : '—'}
          </div>
        </Row>
      );
    case 'session-state':
      return (
        <Row label="session state" tone="muted">
          <div className="font-mono text-[10px] text-muted-foreground">
            {event.state}
            {event.permissionMode ? ` · ${event.permissionMode}` : ''}
          </div>
        </Row>
      );
    case 'system':
      return (
        <Row label={`system · ${event.subtype}`} tone={event.level === 'error' ? 'error' : 'system'}>
          <div className="whitespace-pre-wrap text-foreground">{event.message}</div>
        </Row>
      );
    case 'compaction':
      return (
        <Row label={`compaction · ${event.trigger}`} tone="muted">
          <div className="font-mono text-[10px] text-muted-foreground">
            {event.preTokens} → {event.postTokens ?? '…'} tokens
          </div>
        </Row>
      );
    case 'sidechain':
      return (
        <Row label={`sidechain · ${event.role}`} tone="muted">
          <div className="whitespace-pre-wrap text-muted-foreground">{event.text}</div>
        </Row>
      );
    case 'agent-dispatch':
      return (
        <Row label="agent dispatch" tone="muted">
          <div className="text-muted-foreground">dispatched {event.agentName}</div>
        </Row>
      );
    case 'retract':
      return (
        <Row label="retracted" tone="muted">
          <div className="font-mono text-[10px] text-muted-foreground">
            {event.uuids.length} event(s) withdrawn
          </div>
        </Row>
      );
    default:
      return (
        <Row label="event" tone="muted">
          <pre className="whitespace-pre-wrap font-mono text-[10px] text-muted-foreground">
            {truncate(safeJson(event), 400)}
          </pre>
        </Row>
      );
  }
}
