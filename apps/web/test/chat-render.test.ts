// Guard tests for the chat-render timeline builder — the agent-envelope
// coalescing invariant in particular (docs: chat cards, not plain user bubbles).
// Self-contained (no '@/' alias, no React), runs under `tsx --test`.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  conversationFamilyForEvent,
  safeToolSummary,
  type ChatEvent,
  type ConversationEventFrame,
} from '../../../packages/contracts/src/events/index.ts';
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
    family: conversationFamilyForEvent(event),
    itemId: event.kind === 'tool-state' ? event.callId : `item-${sequence}`,
    ...(event.kind === 'tool-state' || event.kind === 'activity-state' ? { turnId: 'turn-1' } : {}),
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

test('tool-state transitions coalesce into one safe call row with no technical payload', () => {
  const base = {
    kind: 'tool-state' as const,
    callId: 'call-1',
    name: 'Bash',
    safeSummary: safeToolSummary('Bash'),
  };
  const items = buildRenderItems([
    frame(1, {
      ...base,
      state: 'requested',
      approval: { status: 'unknown', source: null, requestId: null },
      outcome: null,
    }),
    frame(2, {
      ...base,
      state: 'running',
      approval: { status: 'not-required', source: 'runtime', requestId: null },
      outcome: null,
    }),
    frame(3, {
      ...base,
      state: 'failed',
      approval: { status: 'not-required', source: 'runtime', requestId: null },
      outcome: { reason: 'tool-error' },
    }),
  ]);
  assert.equal(items.length, 1);
  assert.equal(items[0]!.kind, 'tool-group');
  const call = (items[0] as Extract<(typeof items)[number], { kind: 'tool-group' }>).calls[0]!;
  assert.equal(call.callId, 'call-1');
  assert.equal(call.state, 'failed');
  assert.equal(call.safeSummary, 'Use Bash');
  assert.equal('input' in call, false);
  assert.equal('result' in call, false);
  assert.equal(JSON.stringify(items).includes('secret-command'), false);
});

test('orphan non-requested tool state is ignored rather than synthesized in presentation', () => {
  const items = buildRenderItems([frame(1, {
    kind: 'tool-state', callId: 'call-1', name: 'Read', state: 'running',
    safeSummary: safeToolSummary('Read'),
    approval: { status: 'not-required', source: 'runtime', requestId: null },
    outcome: null,
  })]);
  assert.deepEqual(items, []);
});

test('context observations stay out of the transcript render list', () => {
  const items = buildRenderItems([
    frame(1, {
      kind: 'context-observation',
      confidence: 'exact',
      usedTokens: 25,
      usableTokens: 100,
      contextWindowTokens: 120,
    }),
  ]);
  assert.deepEqual(items, []);
});

test('turn-failed carries providerDetail through as null when absent, verbatim when present', () => {
  const absent = buildRenderItems([
    frame(1, { kind: 'turn-failed', error: 'runtime failed to start (session-mint-unavailable)', source: 'internal' }),
  ]);
  assert.deepEqual(absent, [{
    kind: 'turn-failed',
    key: `${SID}:1`,
    error: 'runtime failed to start (session-mint-unavailable)',
    source: 'internal',
    providerDetail: null,
  }]);

  const present = buildRenderItems([
    frame(1, {
      kind: 'turn-failed',
      error: 'runtime failed to start (session-mint-unavailable)',
      source: 'internal',
      providerDetail: 'account currently refuses all turns',
    }),
  ]);
  assert.deepEqual(present, [{
    kind: 'turn-failed',
    key: `${SID}:1`,
    error: 'runtime failed to start (session-mint-unavailable)',
    source: 'internal',
    providerDetail: 'account currently refuses all turns',
  }]);
});

test('compaction remains visible without inventing trigger or token counts', () => {
  const items = buildRenderItems([
    frame(1, {
      kind: 'compaction',
      trigger: 'unknown',
      preTokens: null,
      postTokens: null,
    }),
  ]);
  assert.deepEqual(items, [{
    kind: 'compaction',
    key: `${SID}:1`,
    trigger: 'unknown',
    preTokens: null,
    postTokens: null,
  }]);
});
