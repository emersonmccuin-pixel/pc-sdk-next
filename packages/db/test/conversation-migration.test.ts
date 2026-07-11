import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import Database from 'better-sqlite3';

const here = dirname(fileURLToPath(import.meta.url));

test('0009 preserves ordering/retraction, hides legacy thinking, and removes old columns', () => {
  const db = new Database(':memory:');
  db.exec(`
    CREATE TABLE orchestrator_sessions (id text PRIMARY KEY);
    INSERT INTO orchestrator_sessions (id) VALUES ('s1');
    CREATE TABLE conversation_events (
      id text PRIMARY KEY, project_id text NOT NULL, session_id text NOT NULL,
      seq integer NOT NULL, kind text, event text NOT NULL, sdk_uuid text,
      client_message_id text, created_at integer NOT NULL
    );
  `);
  const insert = db.prepare(`INSERT INTO conversation_events
    (id, project_id, session_id, seq, kind, event, sdk_uuid, client_message_id, created_at)
    VALUES (?, 'p1', 's1', ?, ?, ?, ?, NULL, ?)`);
  insert.run('s1:1', 1, 'thinking', JSON.stringify({ kind: 'thinking', text: 'private' }), 'native-1', 1);
  insert.run('s1:2', 2, 'assistant-text', JSON.stringify({ kind: 'assistant-text', text: 'answer', midLoop: false }), 'native-1', 2);
  insert.run('s1:3', 3, 'retract', JSON.stringify({ kind: 'retract', uuids: ['native-1'] }), null, 3);
  insert.run('s1:4', 4, 'turn-end', JSON.stringify({ kind: 'turn-end', text: 'answer', stopReason: 'end_turn' }), null, 4);
  insert.run('s1:5', 5, 'turn-end', JSON.stringify({ kind: 'turn-end', text: 'answer', stopReason: null }), null, 5);

  const sql = readFileSync(join(here, '..', 'drizzle', '0009_conversation_foundation.sql'), 'utf8');
  db.transaction(() => {
    for (const statement of sql.split('--> statement-breakpoint')) {
      if (statement.trim()) db.exec(statement);
    }
  })();

  const columns = db.pragma('table_info(conversation_events)') as Array<{ name: string }>;
  assert.equal(columns.some((column) => column.name === 'sdk_uuid'), false);
  assert.equal(columns.some((column) => column.name === 'item_id'), true);
  const rows = db.prepare('SELECT * FROM conversation_events ORDER BY sequence').all() as Array<Record<string, unknown>>;
  assert.deepEqual(rows.map((row) => row.sequence), [1, 2, 3, 4, 5]);
  assert.equal(rows[0]!.projection_state, 'legacy-hidden');
  assert.equal(JSON.parse(rows[0]!.payload as string).kind, 'legacy-thinking');
  const legacyStreamId = 'legacy-stream:73313a31';
  assert.equal(rows[0]!.item_id, legacyStreamId);
  assert.equal(rows[0]!.stream_id, legacyStreamId);
  assert.equal(rows[1]!.item_id, legacyStreamId);
  assert.equal(rows[1]!.stream_id, legacyStreamId);
  assert.deepEqual(JSON.parse(rows[2]!.payload as string).streamIds, [legacyStreamId]);
  assert.equal(JSON.parse(rows[3]!.payload as string).stopReason, 'complete');
  assert.equal(JSON.parse(rows[4]!.payload as string).stopReason, null);
  assert.equal(JSON.stringify(rows).includes('native-1'), false);
  const cursor = db.prepare('SELECT next_sequence FROM conversation_sequences WHERE conversation_id = ?').get('s1') as { next_sequence: number };
  assert.equal(cursor.next_sequence, 6);
  const outbox = db.prepare('SELECT delivery_kind, relayed_at FROM conversation_outbox ORDER BY outbox_sequence').all() as Array<{ delivery_kind: string; relayed_at: number | null }>;
  assert.equal(outbox.length, 5);
  assert.ok(outbox.every((row) => row.delivery_kind === 'chat' && row.relayed_at !== null));
  db.close();
});
