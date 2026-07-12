import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { safeToolSummary, type ToolStateEvent } from '@pc/contracts';

const tmpDir = mkdtempSync(join(tmpdir(), 'pc-conversation-events-'));
process.env.PC_DATA_DIR = tmpDir;

const {
  closeDb,
  closeOpenConversationToolCalls,
  commitConversationEvent,
  countConversationEvents,
  getConversationHighWaterSequence,
  getRawDb,
  hasConversationEvents,
  listConversationEvents,
  listConversationEventsRaw,
  listUnrelayedConversationEvents,
  markConversationEventsRelayed,
  runMigrations,
} = await import('../src/index.ts');

function toolEvent(
  conversationId: string,
  callId: string,
  event: ToolStateEvent,
  turnId = 'turn-1',
) {
  return commitConversationEvent({
    projectId: 'p1',
    conversationId,
    sessionId: conversationId,
    family: 'tool',
    event,
    turnId,
    itemId: callId,
    occurredAt: 1000,
    deliveryKind: 'chat',
  });
}

function requested(callId: string, name = 'Read'): ToolStateEvent {
  return {
    kind: 'tool-state',
    callId,
    name,
    state: 'requested',
    safeSummary: safeToolSummary(name),
    approval: { status: 'unknown', source: null, requestId: null },
    outcome: null,
  };
}

before(() => runMigrations());
after(() => {
  closeDb();
  rmSync(tmpDir, { recursive: true, force: true });
});

function commit(
  conversationId: string,
  text: string,
  over: Record<string, unknown> = {},
) {
  return commitConversationEvent({
    projectId: 'p1',
    conversationId,
    sessionId: conversationId,
    family: 'assistant',
    event: { kind: 'assistant-text', text, midLoop: false },
    itemId: `item-${text}`,
    occurredAt: 1000,
    deliveryKind: 'chat',
    ...over,
  } as Parameters<typeof commitConversationEvent>[0]);
}

function terminal(
  conversationId: string,
  turnId: string,
  deliveryKind: 'chat' | 'agent' = 'chat',
) {
  return commitConversationEvent({
    projectId: 'p1',
    conversationId,
    sessionId: conversationId,
    family: 'control',
    event: { kind: 'turn-end', text: 'done', stopReason: 'complete' },
    turnId,
    itemId: `terminal-${turnId}`,
    occurredAt: 2000,
    deliveryKind,
  });
}

function contextObservation(
  conversationId: string,
  turnId?: string,
  deliveryKind: 'chat' | 'agent' = 'chat',
) {
  return commitConversationEvent({
    projectId: 'p1',
    conversationId,
    sessionId: conversationId,
    family: 'telemetry',
    event: {
      kind: 'context-observation',
      confidence: 'exact',
      usedTokens: 1_000,
      usableTokens: 100_000,
      contextWindowTokens: 200_000,
    },
    ...(turnId === undefined ? {} : { turnId }),
    itemId: `context-${turnId ?? 'missing'}`,
    occurredAt: 2001,
    deliveryKind,
  });
}

test('commit allocates gapless conversation sequence and writes one outbox row atomically', () => {
  const first = commit('c1', 'one');
  const second = commit('c1', 'two');
  assert.equal(first.event.sequence, 1);
  assert.equal(second.event.sequence, 2);
  assert.ok(second.outboxSequence > first.outboxSequence);
  assert.deepEqual(listConversationEvents('c1').map((row) => row.sequence), [1, 2]);
  assert.equal(getConversationHighWaterSequence('c1'), 2);
  assert.equal(countConversationEvents('c1'), 2);
  assert.equal(hasConversationEvents('c1'), true);
  assert.equal(listUnrelayedConversationEvents().filter((entry) => entry.event.conversationId === 'c1').length, 2);
});

test('different conversations allocate independently and afterSequence is authoritative', () => {
  assert.equal(commit('c2', 'one').event.sequence, 1);
  assert.equal(commit('c2', 'two').event.sequence, 2);
  assert.equal(commit('c3', 'one').event.sequence, 1);
  assert.deepEqual(listConversationEvents('c2', { afterSequence: 1 }).map((row) => row.sequence), [2]);
});

test('outbox mark removes only relayed entries from the pending drain', () => {
  const result = commit('c4', 'one');
  assert.ok(listUnrelayedConversationEvents().some((entry) => entry.outboxSequence === result.outboxSequence));
  markConversationEventsRelayed([result.outboxSequence], 2000);
  assert.equal(listUnrelayedConversationEvents().some((entry) => entry.outboxSequence === result.outboxSequence), false);
});

test('outbox failure rolls back event and cursor; next success reuses the sequence', () => {
  const raw = getRawDb();
  raw.exec(`
    CREATE TEMP TRIGGER fail_conversation_outbox
    BEFORE INSERT ON conversation_outbox
    BEGIN SELECT RAISE(ABORT, 'forced outbox failure'); END;
  `);
  assert.throws(() => commit('rollback', 'failed'), /forced outbox failure/);
  raw.exec('DROP TRIGGER fail_conversation_outbox');
  assert.equal(countConversationEvents('rollback'), 0);
  assert.equal(commit('rollback', 'success').event.sequence, 1);
});

test('project mismatch and invalid delta identity fail closed without consuming sequence', () => {
  assert.equal(commit('owned', 'one').event.sequence, 1);
  assert.throws(() => commit('owned', 'wrong-project', { projectId: 'p2' }), /project mismatch/);
  assert.throws(
    () => commit('delta', 'bad', { deltaIndex: 0, streamId: null }),
    /stable conversation events cannot carry deltaIndex/,
  );
  assert.throws(
    () => commit('delta', 'bad-stream', {
      event: { kind: 'stream-delta', delta: { kind: 'text-delta', text: 'x' } },
      family: 'assistant',
      streamId: 'stream',
      deltaIndex: null,
    }),
    /stream-delta requires/,
  );
  assert.throws(() => commit('delta', 'wrong-family', { family: 'user' }), /family mismatch/);
  assert.throws(() => commit('delta', 'empty-event', { eventId: '' }), /eventId/);
  assert.throws(() => commit('delta', 'empty-turn', { turnId: '' }), /turnId/);
  assert.throws(() => commit('delta', 'bad-time', { occurredAt: Number.NaN }), /occurredAt/);
  assert.equal(commit('delta', 'good').event.sequence, 1);

  const noTurnTool = requested('call-no-turn');
  assert.throws(() => commitConversationEvent({
    projectId: 'p1',
    conversationId: 'no-turn-tool',
    sessionId: 'no-turn-tool',
    family: 'tool',
    event: noTurnTool,
    itemId: noTurnTool.callId,
    occurredAt: 1000,
    deliveryKind: 'chat',
  }), /requires a non-empty turnId/);
  assert.throws(() => commitConversationEvent({
    projectId: 'p1',
    conversationId: 'no-turn-activity',
    sessionId: 'no-turn-activity',
    family: 'activity',
    event: { kind: 'activity-state', phase: 'responding' },
    itemId: 'activity-no-turn',
    occurredAt: 1000,
    deliveryKind: 'chat',
  }), /requires a non-empty turnId/);
  assert.throws(() => commitConversationEvent({
    projectId: 'p1',
    conversationId: 'no-turn-terminal',
    sessionId: 'no-turn-terminal',
    family: 'control',
    event: { kind: 'turn-failed', error: 'ended', source: 'internal' },
    itemId: 'terminal-no-turn',
    occurredAt: 1000,
    deliveryKind: 'chat',
  }), /requires a non-empty turnId/);
  assert.equal(getConversationHighWaterSequence('no-turn-tool'), 0);
  assert.equal(getConversationHighWaterSequence('no-turn-activity'), 0);
  assert.equal(getConversationHighWaterSequence('no-turn-terminal'), 0);
});

test('context observation requires a non-empty turn identity without consuming sequence', () => {
  assert.throws(
    () => contextObservation('context-missing-turn'),
    /context-observation requires a non-empty turnId/,
  );
  assert.throws(
    () => contextObservation('context-empty-turn', ''),
    /turnId must be non-empty when provided/,
  );
  assert.equal(getConversationHighWaterSequence('context-missing-turn'), 0);
  assert.equal(getConversationHighWaterSequence('context-empty-turn'), 0);
  assert.equal(
    listUnrelayedConversationEvents()
      .filter((entry) => (
        entry.event.conversationId === 'context-missing-turn'
        || entry.event.conversationId === 'context-empty-turn'
      )).length,
    0,
  );
});

test('context observation rejects nonexistent and open turns without consuming sequence', () => {
  assert.throws(
    () => contextObservation('context-nonexistent-turn', 'turn-missing'),
    /context observation requires a settled terminal: turn-missing/,
  );
  assert.equal(getConversationHighWaterSequence('context-nonexistent-turn'), 0);

  commitConversationEvent({
    projectId: 'p1',
    conversationId: 'context-open-turn',
    sessionId: 'context-open-turn',
    family: 'activity',
    event: { kind: 'activity-state', phase: 'responding' },
    turnId: 'turn-open',
    itemId: 'activity-open',
    occurredAt: 1000,
    deliveryKind: 'chat',
  });
  assert.throws(
    () => contextObservation('context-open-turn', 'turn-open'),
    /context observation requires a settled terminal: turn-open/,
  );
  assert.deepEqual(
    listConversationEvents('context-open-turn').map((row) => row.eventType),
    ['activity-state'],
  );
  assert.equal(getConversationHighWaterSequence('context-open-turn'), 1);
});

test('context observation accepts one post-terminal event and rejects a duplicate', () => {
  terminal('context-settled-turn', 'turn-settled');
  const observation = contextObservation('context-settled-turn', 'turn-settled');
  assert.equal(observation.event.sequence, 2);
  assert.deepEqual(
    listConversationEvents('context-settled-turn').map((row) => row.eventType),
    ['turn-end', 'context-observation'],
  );
  assert.throws(
    () => contextObservation('context-settled-turn', 'turn-settled'),
    /context observation already exists for turn: turn-settled/,
  );
  assert.equal(getConversationHighWaterSequence('context-settled-turn'), 2);
  assert.equal(
    listUnrelayedConversationEvents()
      .filter((entry) => entry.event.conversationId === 'context-settled-turn').length,
    2,
  );
});

test('context observation and outbox rollback atomically and preserve the next sequence', () => {
  terminal('context-atomic', 'turn-context-atomic');
  const raw = getRawDb();
  raw.exec(`
    CREATE TEMP TRIGGER fail_context_observation_outbox
    BEFORE INSERT ON conversation_outbox
    WHEN NEW.delivery_kind = 'agent'
    BEGIN SELECT RAISE(ABORT, 'forced context outbox failure'); END;
  `);
  assert.throws(
    () => contextObservation('context-atomic', 'turn-context-atomic', 'agent'),
    /forced context outbox failure/,
  );
  raw.exec('DROP TRIGGER fail_context_observation_outbox');
  assert.deepEqual(
    listConversationEvents('context-atomic').map((row) => row.eventType),
    ['turn-end'],
  );
  assert.equal(getConversationHighWaterSequence('context-atomic'), 1);
  assert.equal(
    listUnrelayedConversationEvents()
      .filter((entry) => entry.event.conversationId === 'context-atomic').length,
    1,
  );

  const observation = contextObservation('context-atomic', 'turn-context-atomic', 'agent');
  assert.equal(observation.event.sequence, 2);
  assert.deepEqual(
    listConversationEvents('context-atomic').map((row) => row.eventType),
    ['turn-end', 'context-observation'],
  );
  assert.equal(
    listUnrelayedConversationEvents()
      .filter((entry) => entry.event.conversationId === 'context-atomic').length,
    2,
  );
});

test('legacy-hidden evidence is retained raw but never appears in product replay', () => {
  const hidden = commit('legacy', 'private');
  const raw = getRawDb();
  raw.prepare('UPDATE conversation_events SET projection_state = ? WHERE event_id = ?')
    .run('legacy-hidden', hidden.event.eventId);
  markConversationEventsRelayed([hidden.outboxSequence], 2000);
  assert.equal(listConversationEvents('legacy').length, 0);
  assert.equal(listConversationEventsRaw('legacy').length, 1);
  assert.equal(listConversationEventsRaw('legacy')[0]!.projectionState, 'legacy-hidden');
});

test('tool lifecycle is guarded transactionally and terminal state is immutable', () => {
  const first = requested('call-direct');
  const running: ToolStateEvent = {
    ...first,
    state: 'running',
    approval: { status: 'not-required', source: 'policy', requestId: null },
  };
  const succeeded: ToolStateEvent = { ...running, state: 'succeeded' };
  assert.equal(toolEvent('tool-direct', first.callId, first).event.sequence, 1);
  assert.equal(toolEvent('tool-direct', first.callId, running).event.sequence, 2);
  assert.equal(toolEvent('tool-direct', first.callId, succeeded).event.sequence, 3);
  assert.throws(
    () => toolEvent('tool-direct', first.callId, { ...running, state: 'failed', outcome: { reason: 'tool-error' } }),
    /post-terminal/,
  );
  assert.throws(
    () => toolEvent('tool-direct', first.callId, { ...first, name: 'Write', safeSummary: safeToolSummary('Write') }),
    /identity-changed/,
  );
  assert.equal(getConversationHighWaterSequence('tool-direct'), 3, 'rejected transitions consume no sequence');

  const approval = requested('call-approval', 'Bash');
  const pending: ToolStateEvent = {
    ...approval,
    state: 'approval-needed',
    approval: { status: 'pending', source: null, requestId: 'approval-1' },
  };
  const allowed: ToolStateEvent = {
    ...approval,
    state: 'running',
    approval: { status: 'allowed', source: 'user', requestId: 'approval-1' },
  };
  toolEvent('tool-approval', approval.callId, approval);
  toolEvent('tool-approval', approval.callId, pending);
  assert.throws(
    () => toolEvent('tool-approval', approval.callId, {
      ...allowed,
      approval: { status: 'allowed', source: 'user', requestId: 'approval-other' },
    }),
    /approval-request-changed/,
  );
  toolEvent('tool-approval', approval.callId, allowed);
});

test('closing open tools is idempotent and emits terminal evidence through the outbox', () => {
  const waiting = requested('call-waiting', 'Write');
  const pending: ToolStateEvent = {
    ...waiting,
    state: 'approval-needed',
    approval: { status: 'pending', source: null, requestId: 'approval-waiting' },
  };
  const runningStart = requested('call-running', 'Read');
  const running: ToolStateEvent = {
    ...runningStart,
    state: 'running',
    approval: { status: 'not-required', source: 'runtime', requestId: null },
  };
  toolEvent('tool-close', waiting.callId, waiting, 'turn-close');
  toolEvent('tool-close', waiting.callId, pending, 'turn-close');
  toolEvent('tool-close', runningStart.callId, runningStart, 'turn-close');
  toolEvent('tool-close', runningStart.callId, running, 'turn-close');

  assert.equal(closeOpenConversationToolCalls({
    conversationId: 'tool-close',
    turnId: 'turn-close',
    reason: 'runtime-lost',
    deliveryKind: 'chat',
    occurredAt: 2000,
  }), 2);
  assert.equal(closeOpenConversationToolCalls({
    conversationId: 'tool-close',
    turnId: 'turn-close',
    reason: 'runtime-lost',
    deliveryKind: 'chat',
    occurredAt: 2001,
  }), 0);
  const terminal = listConversationEvents('tool-close')
    .map((row) => row.payload)
    .filter((event): event is ToolStateEvent => (
      typeof event === 'object' && event !== null && (event as { kind?: string }).kind === 'tool-state'
    ))
    .slice(-2);
  assert.deepEqual(terminal.map((event) => event.state), ['denied', 'failed']);
  assert.deepEqual(terminal[0]!.approval, {
    status: 'denied', source: 'session', requestId: 'approval-waiting',
  });
  assert.deepEqual(terminal[1]!.outcome, { reason: 'runtime-lost' });
  assert.equal(
    listUnrelayedConversationEvents().filter((entry) => entry.event.conversationId === 'tool-close').length,
    6,
  );
});

test('a terminal event closes open tools atomically before its own sequence', () => {
  const start = requested('call-terminal-atomic');
  const running: ToolStateEvent = {
    ...start,
    state: 'running',
    approval: { status: 'not-required', source: 'runtime', requestId: null },
  };
  toolEvent('terminal-atomic', start.callId, start, 'turn-terminal-atomic');
  toolEvent('terminal-atomic', start.callId, running, 'turn-terminal-atomic');

  const terminal = () => commitConversationEvent({
    projectId: 'p1',
    conversationId: 'terminal-atomic',
    sessionId: 'terminal-atomic',
    family: 'control',
    event: { kind: 'turn-failed', error: 'runtime ended', source: 'internal' },
    turnId: 'turn-terminal-atomic',
    itemId: 'terminal-item',
    occurredAt: 3000,
    deliveryKind: 'agent',
  });

  const raw = getRawDb();
  raw.exec(`
    CREATE TEMP TRIGGER fail_atomic_terminal_outbox
    BEFORE INSERT ON conversation_outbox
    WHEN NEW.delivery_kind = 'agent'
    BEGIN SELECT RAISE(ABORT, 'forced atomic terminal failure'); END;
  `);
  assert.throws(terminal, /forced atomic terminal failure/);
  raw.exec('DROP TRIGGER fail_atomic_terminal_outbox');
  assert.deepEqual(
    listConversationEvents('terminal-atomic').map((row) => row.eventType),
    ['tool-state', 'tool-state'],
  );

  terminal();
  const events = listConversationEvents('terminal-atomic');
  assert.deepEqual(events.map((row) => row.eventType), [
    'tool-state', 'tool-state', 'tool-state', 'turn-failed',
  ]);
  assert.deepEqual(events[2]!.payload, {
    ...running,
    state: 'failed',
    outcome: { reason: 'turn-ended' },
  });
  const lateTool = requested('call-after-terminal');
  assert.throws(
    () => toolEvent('terminal-atomic', lateTool.callId, lateTool, 'turn-terminal-atomic'),
    /turn already terminal/,
  );
  assert.throws(() => commitConversationEvent({
    projectId: 'p1',
    conversationId: 'terminal-atomic',
    sessionId: 'terminal-atomic',
    family: 'activity',
    event: { kind: 'activity-state', phase: 'responding' },
    turnId: 'turn-terminal-atomic',
    itemId: 'late-activity',
    occurredAt: 3001,
    deliveryKind: 'agent',
  }), /turn already terminal/);
  assert.equal(getConversationHighWaterSequence('terminal-atomic'), 4);
});
