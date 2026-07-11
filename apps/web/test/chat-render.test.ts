// Guard tests for the chat-render timeline builder — the agent-envelope
// coalescing invariant in particular (docs: chat cards, not plain user bubbles).
// Self-contained (no '@/' alias, no React), runs under `tsx --test`.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import type { ChatEvent, ConversationEventFrame } from '../../../packages/contracts/src/events/index.ts';
import { buildRenderItems } from '../src/features/chat/chat-render.ts';

const SID = 'sess-1';

function frame(sequence: number, event: ChatEvent): ConversationEventFrame {
  return {
    type: 'conversation-event',
    eventId: `${SID}:${sequence}`,
    projectId: 'proj-1',
    conversationId: SID,
    sessionId: SID,
    sequence,
    family: event.kind === 'user' ? 'user' : event.kind.startsWith('agent-') ? 'agent' : 'assistant',
    itemId: `item-${sequence}`,
    occurredAt: sequence,
    event,
  };
}

function askEnvelope(runId: string): ChatEvent {
  return {
    kind: 'agent-envelope',
    runId,
    agentName: 'researcher',
    pendingAskId: 'ask-1',
    status: 'waiting',
    summary: 'Question: which approach?',
    detail: '[agent-asks] agent=researcher runId=r1 pendingAskId=ask-1\nQuestion: which approach?',
    envelope: '[agent-asks] agent=researcher runId=r1 pendingAskId=ask-1\nQuestion: which approach?',
  };
}

function terminalEnvelope(runId: string, status: 'done' | 'failed'): ChatEvent {
  return {
    kind: 'agent-envelope',
    runId,
    agentName: 'researcher',
    status,
    summary: status === 'done' ? 'Completed' : 'Failed (unexpected-exit)',
    detail: `[agent-${status === 'done' ? 'completed' : 'failed'}] agent=researcher runId=${runId}`,
    envelope: `[agent-${status === 'done' ? 'completed' : 'failed'}] agent=researcher runId=${runId}`,
  };
}

test('agent-envelope renders as a collapsed agent-run card, not a plain user bubble', () => {
  const items = buildRenderItems([frame(1, askEnvelope('r1'))]);
  assert.equal(items.length, 1);
  assert.equal(items[0]!.kind, 'agent-run');
  const item = items[0]! as Extract<(typeof items)[number], { kind: 'agent-run' }>;
  assert.equal(item.runId, 'r1');
  assert.equal(item.agentName, 'researcher');
  assert.equal(item.status, 'waiting');
  assert.equal(item.pendingAskId, 'ask-1');
});

test('same-runId agent-envelope events coalesce into one card (latest status wins)', () => {
  const items = buildRenderItems([
    frame(1, askEnvelope('r1')),
    frame(2, { kind: 'assistant-text', text: 'looking into it', midLoop: false }),
    frame(3, terminalEnvelope('r1', 'done')),
  ]);
  const agentRuns = items.filter((i) => i.kind === 'agent-run');
  assert.equal(agentRuns.length, 1, 'expected exactly one coalesced card for runId r1');
  const item = agentRuns[0]! as Extract<(typeof items)[number], { kind: 'agent-run' }>;
  assert.equal(item.status, 'done');
  assert.equal(item.summary, 'Completed');
  // The card holds its position at the FIRST envelope for the run.
  assert.equal(items[0]!.kind, 'agent-run');
  assert.equal(items[1]!.kind, 'assistant');
});

test('distinct runIds each get their own card', () => {
  const items = buildRenderItems([frame(1, askEnvelope('r1')), frame(2, terminalEnvelope('r2', 'failed'))]);
  const agentRuns = items.filter((i) => i.kind === 'agent-run');
  assert.equal(agentRuns.length, 2);
});
