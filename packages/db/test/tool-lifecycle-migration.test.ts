import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import Database from 'better-sqlite3';
import { isSessionReplayFrame } from '@pc/contracts';

const here = dirname(fileURLToPath(import.meta.url));

test('0011 retains legacy raw tools and provider notices but removes them from visible replay', () => {
  const db = new Database(':memory:');
  db.exec(`
    CREATE TABLE conversation_events (
      event_id text PRIMARY KEY,
      conversation_id text NOT NULL,
      sequence integer NOT NULL,
      event_type text NOT NULL,
      payload text NOT NULL,
      projection_state text NOT NULL
    );
  `);
  const insert = db.prepare(`INSERT INTO conversation_events
    (event_id, conversation_id, sequence, event_type, payload, projection_state)
    VALUES (?, 's1', ?, ?, ?, 'visible')`);
  insert.run('e1', 1, 'tool-call', JSON.stringify({
    kind: 'tool-call', toolUseId: 'native-1', name: 'Bash', input: { token: 'secret' },
  }));
  insert.run('e2', 2, 'tool-result', JSON.stringify({
    kind: 'tool-result', toolUseId: 'native-1', result: 'secret output', isError: false,
  }));
  insert.run('e3', 3, 'tool-denied', JSON.stringify({
    kind: 'tool-denied', toolUseId: 'native-2', name: 'Write', reason: 'private reason',
  }));
  insert.run('e4', 4, 'stream-delta', JSON.stringify({
    kind: 'stream-delta', delta: { kind: 'tool-input-delta', partialJson: '{"token":"secret"}' },
  }));
  insert.run('e5', 5, 'system', JSON.stringify({
    kind: 'system', subtype: 'api_retry', level: 'warning',
    message: 'SECRET provider retry detail', raw: { attempt: 2 },
  }));
  insert.run('e6', 6, 'system', JSON.stringify({
    kind: 'system', subtype: 'local_command_output', level: 'info',
    message: 'SECRET local command output',
  }));
  insert.run('e7', 7, 'assistant-text', JSON.stringify({
    kind: 'assistant-text', text: 'safe', midLoop: false,
  }));

  const sql = readFileSync(
    join(here, '..', 'drizzle', '0011_safe_activity_tool_lifecycle.sql'),
    'utf8',
  );
  db.exec(sql);

  const rows = db.prepare(`SELECT event_type, projection_state
    FROM conversation_events ORDER BY sequence`).all() as Array<{
      event_type: string;
      projection_state: string;
    }>;
  assert.deepEqual(rows, [
    { event_type: 'tool-call', projection_state: 'legacy-hidden' },
    { event_type: 'tool-result', projection_state: 'legacy-hidden' },
    { event_type: 'tool-denied', projection_state: 'legacy-hidden' },
    { event_type: 'stream-delta', projection_state: 'legacy-hidden' },
    { event_type: 'system', projection_state: 'legacy-hidden' },
    { event_type: 'system', projection_state: 'legacy-hidden' },
    { event_type: 'assistant-text', projection_state: 'visible' },
  ]);
  assert.equal(
    (db.prepare('SELECT MAX(sequence) AS high_water FROM conversation_events').get() as { high_water: number }).high_water,
    7,
  );
  assert.equal(
    (db.prepare("SELECT COUNT(*) AS n FROM conversation_events WHERE projection_state = 'visible'").get() as { n: number }).n,
    1,
  );
  assert.match(
    (db.prepare("SELECT payload FROM conversation_events WHERE event_id = 'e1'").get() as { payload: string }).payload,
    /secret/,
    'legacy evidence remains retained, only hidden',
  );
  const visible = db.prepare(`SELECT event_id, sequence, event_type, payload
    FROM conversation_events WHERE projection_state = 'visible' ORDER BY sequence`).all() as Array<{
      event_id: string;
      sequence: number;
      event_type: string;
      payload: string;
    }>;
  const replay = {
    type: 'session-replay', projectId: 'p1', sessionId: 's1', highWaterSequence: 7,
    events: visible.map((row) => ({
      type: 'conversation-event', eventId: row.event_id, projectId: 'p1',
      conversationId: 's1', sessionId: 's1', sequence: row.sequence,
      family: 'assistant', itemId: row.event_id, occurredAt: row.sequence,
      event: JSON.parse(row.payload),
    })),
  };
  assert.equal(isSessionReplayFrame(replay), true);
  assert.equal(JSON.stringify(replay).includes('SECRET'), false);
  db.close();
});
