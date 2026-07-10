// conversation_events repo: append/replay-state/list/high-water on a fresh
// migrated DB. Shape per docs/event-contract.md (Channel 1 — Chat).

import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const tmpDir = mkdtempSync(join(tmpdir(), 'pc-conversation-events-'));
process.env.PC_DATA_DIR = tmpDir;

const {
  appendConversationEvent,
  appendConversationEvents,
  closeDb,
  countConversationEvents,
  getConversationHighWaterSeq,
  getConversationReplayState,
  hasConversationEvents,
  listConversationEvents,
  runMigrations,
} = await import('../src/index.ts');

before(() => runMigrations());
after(() => {
  closeDb();
  rmSync(tmpDir, { recursive: true, force: true });
});

const PROJECT = 'p1';

function input(seq: number, over: Record<string, unknown> = {}) {
  return {
    projectId: PROJECT,
    sessionId: 's1',
    seq,
    kind: 'assistant-text',
    event: { kind: 'assistant-text', text: `t${seq}`, midLoop: false },
    now: 1000 + seq,
    ...over,
  } as Parameters<typeof appendConversationEvent>[0];
}

test('append + list round-trips the envelope fields, ordered by seq', () => {
  appendConversationEvent(input(2, { sdkUuid: 'u2', clientMessageId: 'c2' }));
  appendConversationEvent(input(1, { sdkUuid: 'u1' }));
  const rows = listConversationEvents('s1');
  assert.deepEqual(rows.map((r) => r.seq), [1, 2]);
  assert.equal(rows[0]!.id, 's1:1');
  assert.equal(rows[0]!.projectId, PROJECT);
  assert.deepEqual(rows[0]!.event, { kind: 'assistant-text', text: 't1', midLoop: false });
  assert.equal(rows[0]!.sdkUuid, 'u1');
  assert.equal(rows[0]!.clientMessageId, null);
  assert.equal(rows[1]!.clientMessageId, 'c2');
});

test('replay state resumes nextSeq', () => {
  assert.equal(getConversationReplayState('s1').nextSeq, 3);
  // Unknown session = a fresh log.
  assert.deepEqual(getConversationReplayState('nope'), { nextSeq: 1 });
});

test('double-write on the same (session, seq) throws (UNIQUE)', () => {
  assert.throws(() => appendConversationEvent(input(1)), /UNIQUE/);
});

test('afterSeq returns only later rows; limit caps oldest-first; high water is stable', () => {
  appendConversationEvent(input(3));
  appendConversationEvent(input(4));
  const after2 = listConversationEvents('s1', { afterSeq: 2 });
  assert.deepEqual(after2.map((r) => r.seq), [3, 4]);
  const capped = listConversationEvents('s1', { limit: 2 });
  assert.deepEqual(capped.map((r) => r.seq), [1, 2]);
  assert.equal(getConversationHighWaterSeq('s1'), 4);
});

test('bulk import writes all rows in one txn; count + has reflect it', () => {
  const n = appendConversationEvents([
    input(1, { sessionId: 's2' }),
    input(2, { sessionId: 's2' }),
  ]);
  assert.equal(n, 2);
  assert.equal(countConversationEvents('s2'), 2);
  assert.equal(hasConversationEvents('s2'), true);
  assert.equal(hasConversationEvents('s3'), false);
});

test('a bulk import with a duplicate seq rolls back whole (txn)', () => {
  assert.throws(() =>
    appendConversationEvents([
      input(5, { sessionId: 's2' }),
      input(2, { sessionId: 's2' }), // dup → throws
    ]),
  );
  assert.equal(countConversationEvents('s2'), 2); // unchanged — txn rolled back
});
