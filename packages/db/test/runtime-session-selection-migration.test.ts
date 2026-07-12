import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import Database from 'better-sqlite3';

const here = dirname(fileURLToPath(import.meta.url));

test('0012 preserves legacy native evidence without inventing selection and ends active rows', () => {
  const db = new Database(':memory:');
  db.exec(`
    CREATE TABLE orchestrator_sessions (
      id text PRIMARY KEY NOT NULL,
      project_id text NOT NULL,
      provider text NOT NULL,
      provider_session_id text,
      model text,
      title text,
      status text DEFAULT 'active' NOT NULL,
      ended_reason text,
      started_at integer NOT NULL,
      ended_at integer,
      deleted_at integer
    );
    CREATE UNIQUE INDEX orch_sessions_active_per_project_idx
      ON orchestrator_sessions (project_id)
      WHERE status = 'active' AND deleted_at IS NULL;
    INSERT INTO orchestrator_sessions
      (id, project_id, provider, provider_session_id, model, status, started_at)
      VALUES ('active-legacy', 'p1', 'claude', 'native-secret-a', 'opus', 'active', 1);
    INSERT INTO orchestrator_sessions
      (id, project_id, provider, provider_session_id, model, status,
       ended_reason, started_at, ended_at)
      VALUES ('ended-legacy', 'p1', 'claude', 'native-secret-b', 'sonnet',
        'ended', 'user_ended', 2, 3);
  `);

  const sql = readFileSync(
    join(here, '..', 'drizzle', '0012_runtime_session_selection.sql'),
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
  assert.equal(columns.has('provider'), false);
  assert.equal(columns.has('provider_session_id'), false);
  assert.equal(columns.has('native_session_id'), true);
  for (const name of [
    'selection_state', 'runtime_id', 'account_id', 'effort_state', 'effort',
    'native_identity_state', 'continuation_state', 'continuation_attempt_id',
  ]) assert.equal(columns.has(name), true, `missing ${name}`);

  const rows = db.prepare(`SELECT id, status, ended_reason, selection_state,
      runtime_id, account_id, model, effort_state, effort, native_session_id,
      native_identity_state, continuation_state, continuation_attempt_id
    FROM orchestrator_sessions ORDER BY id`).all() as Array<Record<string, unknown>>;
  assert.deepEqual(rows, [
    {
      id: 'active-legacy',
      status: 'ended',
      ended_reason: 'selection_unavailable',
      selection_state: 'legacy-unavailable',
      runtime_id: null,
      account_id: null,
      model: 'opus',
      effort_state: 'legacy-unknown',
      effort: null,
      native_session_id: 'native-secret-a',
      native_identity_state: 'legacy-untrusted',
      continuation_state: 'legacy-unavailable',
      continuation_attempt_id: null,
    },
    {
      id: 'ended-legacy',
      status: 'ended',
      ended_reason: 'user_ended',
      selection_state: 'legacy-unavailable',
      runtime_id: null,
      account_id: null,
      model: 'sonnet',
      effort_state: 'legacy-unknown',
      effort: null,
      native_session_id: 'native-secret-b',
      native_identity_state: 'legacy-untrusted',
      continuation_state: 'legacy-unavailable',
      continuation_attempt_id: null,
    },
  ]);
  db.prepare("UPDATE orchestrator_sessions SET title = 'historical evidence' WHERE id = 'ended-legacy'").run();
  assert.throws(
    () => db.prepare(`UPDATE orchestrator_sessions
      SET status = 'active', ended_reason = NULL, ended_at = NULL
      WHERE id = 'ended-legacy'`).run(),
    /legacy orchestrator session cannot be reactivated/,
  );
  assert.equal(
    (db.prepare("SELECT status FROM orchestrator_sessions WHERE id = 'ended-legacy'").get() as { status: string }).status,
    'ended',
  );
  assert.throws(
    () => db.prepare(`UPDATE orchestrator_sessions
      SET continuation_attempt_id = 'invented-attempt'
      WHERE id = 'ended-legacy'`).run(),
    /invalid orchestrator continuation attempt rotation|row state is inconsistent/,
  );
  db.close();
});

test('0012 guards complete immutable stamps and bind-once native identity', () => {
  const db = new Database(':memory:');
  db.exec(`
    CREATE TABLE orchestrator_sessions (
      id text PRIMARY KEY NOT NULL,
      project_id text NOT NULL,
      provider text NOT NULL,
      provider_session_id text,
      model text,
      title text,
      status text DEFAULT 'active' NOT NULL,
      ended_reason text,
      started_at integer NOT NULL,
      ended_at integer,
      deleted_at integer
    );
    CREATE UNIQUE INDEX orch_sessions_active_per_project_idx
      ON orchestrator_sessions (project_id)
      WHERE status = 'active' AND deleted_at IS NULL;
  `);
  const sql = readFileSync(
    join(here, '..', 'drizzle', '0012_runtime_session_selection.sql'),
    'utf8',
  );
  db.transaction(() => {
    for (const statement of sql.split('--> statement-breakpoint')) {
      if (statement.trim()) db.exec(statement);
    }
  })();

  const insert = db.prepare(`INSERT INTO orchestrator_sessions (
      id, project_id, selection_state, runtime_id, account_id, model,
      effort_state, effort, native_session_id, native_identity_state,
      continuation_state, continuation_attempt_id, status, started_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'active', 1)`);
  insert.run(
    'good', 'p1', 'stamped', 'runtime', 'account', 'model',
    'selected', 'high', null, 'unbound', 'clean-pending', 'attempt-create-1',
  );
  assert.throws(
    () => insert.run(
      'legacy-new', 'p2', 'legacy-unavailable', null, null, 'opus',
      'legacy-unknown', null, 'old-native', 'legacy-untrusted', 'legacy-unavailable', null,
    ),
    /complete immutable runtime selection/,
  );
  assert.throws(
    () => insert.run(
      'bad-effort', 'p3', 'stamped', 'runtime', 'account', 'model',
      'none', 'should-be-null', null, 'unbound', 'clean-pending', 'bad-attempt',
    ),
    /complete immutable runtime selection/,
  );
  assert.throws(
    () => db.prepare(`INSERT INTO orchestrator_sessions (
      id, project_id, selection_state, runtime_id, account_id, model,
      effort_state, native_identity_state, continuation_state, status,
      continuation_attempt_id, ended_reason, started_at, ended_at
    ) VALUES (
      'ended-new', 'p4', 'stamped', 'runtime', 'account', 'model',
      'none', 'unbound', 'clean-pending', 'ended',
      'attempt-ended', 'user_ended', 1, 2
    )`).run(),
    /complete immutable runtime selection/,
  );
  assert.throws(
    () => insert.run(
      'missing-attempt', 'p5', 'stamped', 'runtime', 'account', 'model',
      'none', null, null, 'unbound', 'clean-pending', null,
    ),
    /complete immutable runtime selection/,
  );
  assert.throws(
    () => db.prepare("UPDATE orchestrator_sessions SET account_id = 'other' WHERE id = 'good'").run(),
    /runtime selection is immutable/,
  );

  db.prepare("UPDATE orchestrator_sessions SET title = 'still consistent' WHERE id = 'good'").run();
  db.prepare(`UPDATE orchestrator_sessions
    SET continuation_attempt_id = 'attempt-create-2'
    WHERE id = 'good'`).run();
  assert.throws(
    () => db.prepare(`UPDATE orchestrator_sessions
      SET native_session_id = 'split-native', native_identity_state = 'bound'
      WHERE id = 'good'`).run(),
    /row state is inconsistent/,
  );
  assert.throws(
    () => db.prepare(`UPDATE orchestrator_sessions
      SET continuation_state = 'clean-started'
      WHERE id = 'good'`).run(),
    /row state is inconsistent/,
  );
  assert.deepEqual(
    db.prepare(`SELECT native_session_id, native_identity_state, continuation_state
      FROM orchestrator_sessions WHERE id = 'good'`).get(),
    {
      native_session_id: null,
      native_identity_state: 'unbound',
      continuation_state: 'clean-pending',
    },
  );

  db.prepare(`UPDATE orchestrator_sessions
    SET native_session_id = 'native-1', native_identity_state = 'bound',
        continuation_state = 'clean-started'
    WHERE id = 'good'`).run();
  assert.throws(
    () => db.prepare(`UPDATE orchestrator_sessions
      SET continuation_attempt_id = 'attempt-illegal-bound'
      WHERE id = 'good'`).run(),
    /invalid orchestrator continuation attempt rotation/,
  );
  db.prepare(`UPDATE orchestrator_sessions
    SET native_session_id = 'native-1', native_identity_state = 'bound'
    WHERE id = 'good'`).run();
  assert.throws(
    () => db.prepare(`UPDATE orchestrator_sessions
      SET native_session_id = 'native-2', native_identity_state = 'bound'
      WHERE id = 'good'`).run(),
    /may bind only once/,
  );
  assert.throws(
    () => db.prepare(`UPDATE orchestrator_sessions
      SET native_session_id = NULL, native_identity_state = 'unbound'
      WHERE id = 'good'`).run(),
    /may bind only once|row state is inconsistent/,
  );
  assert.throws(
    () => db.prepare("UPDATE orchestrator_sessions SET continuation_state = 'resume-pending' WHERE id = 'good'").run(),
    /resume requires a fresh continuation attempt/,
  );
  db.prepare(`UPDATE orchestrator_sessions
    SET continuation_state = 'resume-pending',
        continuation_attempt_id = 'attempt-resume-1'
    WHERE id = 'good'`).run();
  db.prepare("UPDATE orchestrator_sessions SET continuation_state = 'resume-failed' WHERE id = 'good'").run();
  assert.equal(
    (db.prepare("SELECT continuation_attempt_id FROM orchestrator_sessions WHERE id = 'good'").get() as {
      continuation_attempt_id: string;
    }).continuation_attempt_id,
    'attempt-resume-1',
  );
  assert.throws(
    () => db.prepare(`UPDATE orchestrator_sessions
      SET continuation_attempt_id = 'attempt-illegal-failed'
      WHERE id = 'good'`).run(),
    /invalid orchestrator continuation attempt rotation/,
  );
  db.prepare(`UPDATE orchestrator_sessions
    SET continuation_state = 'resume-pending',
        continuation_attempt_id = 'attempt-resume-2'
    WHERE id = 'good'`).run();
  assert.throws(
    () => db.prepare("UPDATE orchestrator_sessions SET continuation_state = 'resume-pending' WHERE id = 'good'").run(),
    /resume requires a fresh continuation attempt/,
  );
  db.prepare(`UPDATE orchestrator_sessions
    SET continuation_state = 'resume-pending',
        continuation_attempt_id = 'attempt-resume-3'
    WHERE id = 'good'`).run();
  db.prepare("UPDATE orchestrator_sessions SET continuation_state = 'native-resumed' WHERE id = 'good'").run();
  db.prepare("UPDATE orchestrator_sessions SET continuation_state = 'native-resumed' WHERE id = 'good'").run();
  assert.throws(
    () => db.prepare("UPDATE orchestrator_sessions SET continuation_state = 'clean-started' WHERE id = 'good'").run(),
    /invalid orchestrator continuation transition/,
  );
  db.prepare(`UPDATE orchestrator_sessions
    SET status = 'ended', ended_reason = 'user_ended', ended_at = 2
    WHERE id = 'good'`).run();
  assert.throws(
    () => db.prepare(`UPDATE orchestrator_sessions
      SET status = 'active', ended_reason = NULL, ended_at = NULL
      WHERE id = 'good'`).run(),
    /reactivation requires a fresh resume attempt/,
  );
  db.prepare(`UPDATE orchestrator_sessions
    SET status = 'active', ended_reason = NULL, ended_at = NULL,
        continuation_state = 'resume-pending',
        continuation_attempt_id = 'attempt-resume-4'
    WHERE id = 'good'`).run();
  assert.deepEqual(
    db.prepare("SELECT title, status FROM orchestrator_sessions WHERE id = 'good'").get(),
    { title: 'still consistent', status: 'active' },
  );
  db.close();
});
