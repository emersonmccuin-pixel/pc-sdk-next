// Pure timeline builder: canonical stable events → render items. Tool lifecycle
// observations update one safe row by callId. Control and telemetry kinds fold
// into aggregates and never render.

import type {
  ChatEvent,
  ConversationEventFrame,
  ToolApprovalSnapshot,
  ToolCallState,
  ToolTerminalReason,
} from '@pc/contracts';

export interface ToolCall {
  callId: string;
  name: string;
  safeSummary: string;
  state: ToolCallState;
  approval: ToolApprovalSnapshot;
  outcome: { reason: ToolTerminalReason } | null;
}

export interface SidechainStep {
  role: 'user' | 'assistant' | 'tool';
  text: string;
}

export type RenderItem =
  | { kind: 'user'; key: string; text: string; pending?: never }
  | { kind: 'assistant'; key: string; text: string; midLoop: boolean }
  | { kind: 'tool-group'; key: string; calls: ToolCall[] }
  | { kind: 'dispatch'; key: string; runId: string; agentName: string }
  | {
      kind: 'agent-run';
      key: string;
      runId: string;
      agentName: string;
      pendingAskId?: string;
      status: 'waiting' | 'done' | 'failed';
      summary: string;
      detail: string;
    }
  | { kind: 'sidechain-group'; key: string; steps: SidechainStep[] }
  | {
      kind: 'compaction';
      key: string;
      trigger: 'manual' | 'auto' | 'unknown';
      preTokens: number | null;
      postTokens: number | null;
    }
  | { kind: 'system'; key: string; subtype: string; level: 'info' | 'notice' | 'warning' | 'error'; message: string }
  | { kind: 'turn-failed'; key: string; error: string; source: 'api' | 'abort' | 'internal' }
  | {
      kind: 'turn-end';
      key: string;
      stopReason: Extract<ChatEvent, { kind: 'turn-end' }>['stopReason'];
    };

export function buildRenderItems(frames: readonly ConversationEventFrame[]): RenderItem[] {
  const items: RenderItem[] = [];
  const callById = new Map<string, ToolCall>();
  // Same-runId agent-envelope events coalesce into one card (latest wins),
  // in the position of the run's first envelope.
  const agentRunIndex = new Map<string, number>();
  let toolBuffer: ToolCall[] = [];
  let sidechain: SidechainStep[] = [];
  let sidechainKey: string | null = null;

  const flushTools = () => {
    if (toolBuffer.length > 0) {
      items.push({ kind: 'tool-group', key: `tg-${toolBuffer[0]!.callId}`, calls: toolBuffer });
      toolBuffer = [];
    }
  };
  const flushSidechain = () => {
    if (sidechain.length > 0) {
      items.push({ kind: 'sidechain-group', key: sidechainKey ?? `scg-${items.length}`, steps: sidechain });
      sidechain = [];
      sidechainKey = null;
    }
  };
  const flushAll = () => {
    flushTools();
    flushSidechain();
  };

  const retracted = new Set(
    frames.flatMap((frame) => frame.event.kind === 'retract' ? frame.event.streamIds : []),
  );
  for (const frame of frames) {
    if (frame.event.kind === 'stream-delta') continue;
    if (frame.streamId && retracted.has(frame.streamId)) continue;
    const ev: ChatEvent = frame.event;
    const key = frame.eventId;

    if (ev.kind === 'sidechain') {
      flushTools();
      if (sidechain.length === 0) sidechainKey = `scg-${key}`;
      sidechain.push({ role: ev.role, text: ev.text });
      continue;
    }
    // Any non-sidechain event closes an open sub-agent run.
    if (ev.kind !== 'tool-state') flushSidechain();

    switch (ev.kind) {
      case 'tool-state': {
        const existing = callById.get(ev.callId);
        if (existing) {
          existing.state = ev.state;
          existing.approval = ev.approval;
          existing.outcome = ev.outcome;
          break;
        }
        // The reducer/persistence guards enforce requested-first. This
        // defensive branch keeps direct callers fail-closed too.
        if (ev.state !== 'requested') break;
        const call: ToolCall = {
          callId: ev.callId,
          name: ev.name,
          safeSummary: ev.safeSummary,
          state: ev.state,
          approval: ev.approval,
          outcome: ev.outcome,
        };
        callById.set(ev.callId, call);
        toolBuffer.push(call);
        break;
      }
      case 'user':
        flushTools();
        items.push({ kind: 'user', key, text: ev.text });
        break;
      case 'assistant-text':
        flushTools();
        items.push({ kind: 'assistant', key, text: ev.text, midLoop: ev.midLoop });
        break;
      case 'agent-dispatch':
        flushTools();
        items.push({ kind: 'dispatch', key, runId: ev.runId, agentName: ev.agentName });
        break;
      case 'agent-envelope': {
        flushTools();
        const existingIdx = agentRunIndex.get(ev.runId);
        const item: RenderItem = {
          kind: 'agent-run',
          key: existingIdx !== undefined ? items[existingIdx]!.key : key,
          runId: ev.runId,
          agentName: ev.agentName,
          pendingAskId: ev.pendingAskId,
          status: ev.status,
          summary: ev.summary,
          detail: ev.detail,
        };
        if (existingIdx !== undefined) {
          items[existingIdx] = item;
        } else {
          agentRunIndex.set(ev.runId, items.length);
          items.push(item);
        }
        break;
      }
      case 'compaction':
        flushTools();
        items.push({ kind: 'compaction', key, trigger: ev.trigger, preTokens: ev.preTokens, postTokens: ev.postTokens });
        break;
      case 'system':
        flushTools();
        items.push({ kind: 'system', key, subtype: ev.subtype, level: ev.level, message: ev.message });
        break;
      case 'turn-failed':
        flushTools();
        items.push({ kind: 'turn-failed', key, error: ev.error, source: ev.source });
        break;
      case 'turn-end':
        flushTools();
        // Only surface a non-normal canonical stop as a marker.
        if (ev.stopReason && ev.stopReason !== 'complete') {
          items.push({ kind: 'turn-end', key, stopReason: ev.stopReason });
        }
        break;
      // Folded into aggregates — never rendered.
      case 'usage':
      case 'context-observation':
      case 'turn-duration':
      case 'session-state':
      case 'activity-state':
      case 'send-state':
      case 'interrupt-state':
      case 'retract':
        break;
    }
  }
  flushAll();
  return items;
}
