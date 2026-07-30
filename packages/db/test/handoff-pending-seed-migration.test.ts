import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import Database from 'better-sqlite3';

const here = dirname(fileURLToPath(import.meta.url));

test('0023 adds a not-null pending_handoff_seed defaulting false without disturbing existing rows', () => {
  const db = new Database(':memory:');
  db.exec(`
    CREATE TABLE orchestrator_sessions (
      id text PRIMARY KEY NOT NULL,
      project_id text NOT NULL,
      selection_state text DEFAULT 'legacy-unavailable' NOT NULL,
      runtime_id text,
      account_id text,
      model text,
      effort_state text DEFAULT 'legacy-unknown' NOT NULL,
      effort text,
      native_session_id text,
      native_identity_state text DEFAULT 'legacy-untrusted' NOT NULL,
      continuation_state text DEFAULT 'legacy-unavailable' NOT NULL,
      continuation_attempt_id text,
      title text,
      status text DEFAULT 'active' NOT NULL,
      ended_reason text,
      started_at integer NOT NULL,
      ended_at integer,
      deleted_at integer,
      source_session_id text
    );
    INSERT INTO orchestrator_sessions
      (id, project_id, selection_state, runtime_id, account_id, model,
       effort_state, effort, native_session_id, native_identity_state,
       continuation_state, continuation_attempt_id, status, started_at)
      VALUES ('existing', 'p1', 'stamped', 'claude-agent-sdk', 'personal', 'opus',
        'none', null, 'native-1', 'bound', 'clean-started', 'attempt-1', 'active', 1);
  `);

  const sql = readFileSync(
    join(here, '..', 'drizzle', '0023_handoff_pending_seed.sql'),
    'utf8',
  );
  db.transaction(() => {
    for (const statement of sql.split('--> statement-breakpoint')) {
      if (statement.trim()) db.exec(statement);
    }
  })();

  const columns = new Set(
    (db.pragma('table_info(orchestrator_sessions)') as Array<{ name: string }>)
      .map((column) => column.name),
  );
  assert.equal(columns.has('pending_handoff_seed'), true);
  assert.equal(
    (db.prepare("SELECT pending_handoff_seed FROM orchestrator_sessions WHERE id = 'existing'")
      .get() as { pending_handoff_seed: unknown }).pending_handoff_seed,
    0,
  );

  db.prepare(`INSERT INTO orchestrator_sessions
    (id, project_id, selection_state, runtime_id, account_id, model,
     effort_state, native_session_id, native_identity_state, continuation_state,
     continuation_attempt_id, status, started_at, source_session_id, pending_handoff_seed)
    VALUES ('handoff', 'p1', 'stamped', 'claude-agent-sdk', 'work', 'opus',
      'none', null, 'unbound', 'clean-pending', 'attempt-2', 'active', 2, 'existing', 1)
  `).run();
  assert.equal(
    (db.prepare("SELECT pending_handoff_seed FROM orchestrator_sessions WHERE id = 'handoff'")
      .get() as { pending_handoff_seed: unknown }).pending_handoff_seed,
    1,
  );
  db.close();
});
