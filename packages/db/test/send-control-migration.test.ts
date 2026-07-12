import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import Database from 'better-sqlite3';

const here = dirname(fileURLToPath(import.meta.url));

test('0010 installs durable queue, turn, interrupt, command, and terminal guards', () => {
  const db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  db.exec(`
    CREATE TABLE orchestrator_sessions (id text PRIMARY KEY);
    INSERT INTO orchestrator_sessions (id) VALUES ('s1'), ('s2');
    CREATE TABLE conversation_events (
      id text PRIMARY KEY,
      turn_id text,
      event_type text NOT NULL
    );
  `);

  const sql = readFileSync(join(here, '..', 'drizzle', '0010_durable_send_control.sql'), 'utf8');
  db.transaction(() => {
    for (const statement of sql.split('--> statement-breakpoint')) {
      if (statement.trim()) db.exec(statement);
    }
  })();

  const tables = new Set(
    (db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all() as Array<{ name: string }>)
      .map((row) => row.name),
  );
  for (const table of [
    'conversation_queue_heads',
    'conversation_queue_items',
    'conversation_queue_revisions',
    'conversation_turns',
    'turn_interrupt_requests',
    'conversation_commands',
  ]) assert.ok(tables.has(table), `missing ${table}`);

  db.prepare(`INSERT INTO conversation_queue_heads
    (session_id, project_id, conversation_id, next_position, queue_revision, updated_at)
    VALUES ('s1', 'p1', 's1', 3, 2, 1)`).run();
  assert.throws(
    () => db.prepare(`INSERT INTO conversation_queue_heads
      (session_id, project_id, conversation_id, next_position, queue_revision, updated_at)
      VALUES ('s2', 'p1', 's2', 0, 0, 1)`).run(),
    /CHECK constraint failed/,
  );

  const insertItem = db.prepare(`INSERT INTO conversation_queue_items
    (id, turn_id, project_id, conversation_id, session_id, client_message_id, origin,
     status, enqueue_position, current_revision, created_at, updated_at)
    VALUES (?, ?, 'p1', ?, ?, ?, 'user', ?, ?, 1, 1, 1)`);
  insertItem.run('q1', 't1', 's1', 's1', 'm1', 'delivering', 1);
  insertItem.run('q2', 't2', 's1', 's1', 'm2', 'queued', 2);
  assert.throws(
    () => insertItem.run('q3', 't3', 's1', 's1', 'm3', 'delivering', 3),
    /UNIQUE constraint failed: conversation_queue_items\.session_id/,
  );
  assert.throws(
    () => insertItem.run('q4', 't4', 's2', 's2', 'm4', 'unknown', 1),
    /CHECK constraint failed/,
  );

  db.prepare(`INSERT INTO conversation_queue_revisions
    (queue_item_id, revision, text, created_at) VALUES ('q1', 1, 'first', 1)`).run();
  assert.throws(
    () => db.prepare(`INSERT INTO conversation_queue_revisions
      (queue_item_id, revision, text, created_at) VALUES ('q1', 0, 'bad', 1)`).run(),
    /CHECK constraint failed/,
  );

  const insertTurn = db.prepare(`INSERT INTO conversation_turns
    (id, project_id, conversation_id, session_id, queue_item_id, status, started_at)
    VALUES (?, 'p1', 's1', 's1', ?, 'active', 1)`);
  insertTurn.run('t1', 'q1');
  assert.throws(
    () => insertTurn.run('t2', 'q2'),
    /UNIQUE constraint failed: conversation_turns\.session_id/,
  );

  db.prepare("INSERT INTO conversation_events (id, turn_id, event_type) VALUES ('e1', 't1', 'turn-end')").run();
  db.prepare("INSERT INTO conversation_events (id, turn_id, event_type) VALUES ('e2', 't1', 'assistant-text')").run();
  db.prepare("INSERT INTO conversation_events (id, turn_id, event_type) VALUES ('e3', 't1', 'assistant-text')").run();
  assert.throws(
    () => db.prepare("INSERT INTO conversation_events (id, turn_id, event_type) VALUES ('e4', 't1', 'turn-failed')").run(),
    /UNIQUE constraint failed: conversation_events\.turn_id/,
  );

  assert.throws(
    () => db.prepare(`INSERT INTO conversation_commands
      (command_id, project_id, command_kind, fingerprint, status, created_at)
      VALUES ('c1', 'p1', 'unknown', 'hash', 'applied', 1)`).run(),
    /CHECK constraint failed/,
  );
  assert.throws(
    () => db.prepare(`INSERT INTO turn_interrupt_requests
      (id, project_id, conversation_id, session_id, target_turn_id, status,
       requested_at, updated_at)
      VALUES ('i1', 'p1', 's1', 's1', 't1', 'confirmed-ish', 1, 1)`).run(),
    /CHECK constraint failed/,
  );

  const terminalIndex = db.prepare(`SELECT sql FROM sqlite_master
    WHERE type = 'index' AND name = 'conversation_events_turn_terminal_idx'`).get() as { sql: string };
  assert.match(terminalIndex.sql, /WHERE `turn_id` IS NOT NULL AND `event_type` IN \('turn-end', 'turn-failed'\)/);
  db.close();
});
