// Pure timeline builder: ChatFrame[] → render items. Pairs tool-call/tool-result
// by toolUseId, groups consecutive tool calls (collapsible), promotes
// Edit/Write/NotebookEdit to standalone diff cards, coalesces sub-agent
// (sidechain) steps. Control/telemetry kinds (usage, turn-duration,
// session-state, retract) fold into aggregates and never render.

import type { ChatEvent, ChatFrame } from '@pc/contracts';

const HIGHLIGHT_TOOLS = new Set(['Edit', 'Write', 'NotebookEdit', 'MultiEdit']);

export interface ToolCall {
  toolUseId: string;
  name: string;
  input: unknown;
  result: unknown;
  isError: boolean;
  ended: boolean;
}

export interface SidechainStep {
  role: 'user' | 'assistant' | 'tool';
  text: string;
}

export type RenderItem =
  | { kind: 'user'; key: string; text: string; pending?: never }
  | { kind: 'assistant'; key: string; text: string; midLoop: boolean }
  | { kind: 'thinking'; key: string; text: string }
  | { kind: 'tool-group'; key: string; calls: ToolCall[] }
  | { kind: 'edit'; key: string; call: ToolCall }
  | { kind: 'denied'; key: string; name: string; reason: string }
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
  | { kind: 'compaction'; key: string; trigger: 'manual' | 'auto'; preTokens: number; postTokens: number | null }
  | { kind: 'system'; key: string; subtype: string; level: 'info' | 'notice' | 'warning' | 'error'; message: string }
  | { kind: 'turn-failed'; key: string; error: string; source: 'api' | 'abort' | 'internal' }
  | { kind: 'turn-end'; key: string; stopReason: string | null };

export function buildRenderItems(frames: readonly ChatFrame[]): RenderItem[] {
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
      items.push({ kind: 'tool-group', key: `tg-${toolBuffer[0]!.toolUseId}`, calls: toolBuffer });
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

  for (const frame of frames) {
    const ev: ChatEvent = frame.event;
    const key = frame.id;

    if (ev.kind === 'sidechain') {
      flushTools();
      if (sidechain.length === 0) sidechainKey = `scg-${key}`;
      sidechain.push({ role: ev.role, text: ev.text });
      continue;
    }
    // Any non-sidechain event closes an open sub-agent run.
    if (ev.kind !== 'tool-call' && ev.kind !== 'tool-result') flushSidechain();

    switch (ev.kind) {
      case 'tool-call': {
        const call: ToolCall = {
          toolUseId: ev.toolUseId,
          name: ev.name,
          input: ev.input,
          result: undefined,
          isError: false,
          ended: false,
        };
        callById.set(ev.toolUseId, call);
        if (HIGHLIGHT_TOOLS.has(ev.name)) {
          flushTools();
          items.push({ kind: 'edit', key: `edit-${key}`, call });
        } else {
          toolBuffer.push(call);
        }
        break;
      }
      case 'tool-result': {
        const call = callById.get(ev.toolUseId);
        if (call) {
          call.result = ev.result;
          call.isError = ev.isError;
          call.ended = true;
        } else {
          // Orphan result (no prior call frame) — surface it standalone.
          toolBuffer.push({
            toolUseId: ev.toolUseId,
            name: ev.toolUseId,
            input: null,
            result: ev.result,
            isError: ev.isError,
            ended: true,
          });
        }
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
      case 'thinking':
        flushTools();
        items.push({ kind: 'thinking', key, text: ev.text });
        break;
      case 'tool-denied':
        flushTools();
        items.push({ kind: 'denied', key, name: ev.name, reason: ev.reason });
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
        // Only surface a non-normal stop as a marker; end_turn is silent.
        if (ev.stopReason && ev.stopReason !== 'end_turn') {
          items.push({ kind: 'turn-end', key, stopReason: ev.stopReason });
        }
        break;
      // Folded into aggregates — never rendered.
      case 'usage':
      case 'turn-duration':
      case 'session-state':
      case 'retract':
        break;
    }
  }
  flushAll();
  return items;
}
