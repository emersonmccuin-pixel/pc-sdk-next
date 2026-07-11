import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const tmpDir = mkdtempSync(join(tmpdir(), 'pc-conversation-events-'));
process.env.PC_DATA_DIR = tmpDir;

const {
  closeDb,
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
