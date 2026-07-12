import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import Database from 'better-sqlite3';

const here = dirname(fileURLToPath(import.meta.url));

function apply0013(db: Database.Database): void {
  const sql = readFileSync(
    join(here, '..', 'drizzle', '0013_specialist_execution_stamps.sql'),
    'utf8',
  );
  db.transaction(() => {
    for (const statement of sql.split('--> statement-breakpoint')) {
      if (statement.trim()) db.exec(statement);
    }
  })();
}

function legacySchema(db: Database.Database): void {
  db.exec(`
    CREATE TABLE agent_runs (
      id text PRIMARY KEY NOT NULL,
      project_id text NOT NULL,
      dispatcher_session_id text NOT NULL,
      cc_session_id text NOT NULL,
      pod_name text NOT NULL,
      pod_revision_at_dispatch text,
      pod_revision_at_resume text,
      status text NOT NULL,
      lifecycle_state text,
      continues text,
      parent_invoke_depth integer DEFAULT 0 NOT NULL,
      pm_ref text,
      contract_id text,
      input text,
      result text,
      failure_cause text,
      failure_reason text,
      queued_at integer NOT NULL,
      spawned_at integer,
      ready_at integer,
      pid integer,
      last_activity_at integer,
      delivered_at integer,
      completed_at integer,
      rev integer DEFAULT 0 NOT NULL,
      worktree_dir text,
      worktree_base_branch text,
      worktree_base_sha text,
      git_receipt text,
      preparation_receipt text,
      readiness_receipt text,
      runtime_id text,
      account_id text,
      model text,
      auto_continue_count integer DEFAULT 0 NOT NULL
    );
    CREATE INDEX agent_runs_cc_session_idx ON agent_runs (cc_session_id);
    CREATE TABLE pending_asks (
      id text PRIMARY KEY NOT NULL,
      agent_run_id text NOT NULL,
      cc_session_id text NOT NULL,
      project_id text NOT NULL,
      pm_ref text,
      kind text NOT NULL,
      prompt_body text NOT NULL,
      context text,
      options text,
      status text DEFAULT 'open' NOT NULL,
      answer_body text,
      answered_by text,
      created_at integer NOT NULL,
      answered_at integer,
      cancelled_at integer
    );
    CREATE INDEX pending_asks_cc_session_idx ON pending_asks (cc_session_id);
    CREATE TABLE live_outbox (
      seq integer PRIMARY KEY AUTOINCREMENT,
      entity text NOT NULL,
      payload text NOT NULL
    );
  `);
}

test('0013 quarantines legacy rows, removes native DTO columns, and prunes old run frames', () => {
  const db = new Database(':memory:');
  legacySchema(db);
  db.exec(`
    INSERT INTO agent_runs (
      id, project_id, dispatcher_session_id, cc_session_id, pod_name,
      pod_revision_at_dispatch, status, queued_at, runtime_id, account_id, model
    ) VALUES (
      'legacy-paused', 'p1', 'dispatcher', 'placeholder-or-native', 'builder',
      'old-revision', 'paused', 1, 'claude-agent-sdk', 'default', 'sonnet'
    );
    INSERT INTO pending_asks (
      id, agent_run_id, cc_session_id, project_id, kind, prompt_body, created_at
    ) VALUES ('ask-1', 'legacy-paused', 'placeholder-or-native', 'p1', 'orchestrator', 'Question?', 2);
    INSERT INTO live_outbox (entity, payload) VALUES ('agent-run', '{}'), ('usage', '{}');
  `);

  apply0013(db);

  const runColumns = new Set(
    (db.pragma('table_info(agent_runs)') as Array<{ name: string }>).map((row) => row.name),
  );
  for (const removed of ['cc_session_id', 'pod_revision_at_dispatch', 'pod_revision_at_resume']) {
    assert.equal(runColumns.has(removed), false, `${removed} removed`);
  }
  for (const added of [
    'snapshot_state',
    'specialist_snapshot',
    'native_session_id',
    'native_identity_state',
    'continuation_state',
    'continuation_attempt_id',
    'selection_state',
    'effort_state',
    'effort',
  ]) assert.equal(runColumns.has(added), true, `${added} added`);

  assert.deepEqual(
    db.prepare(`SELECT status, snapshot_state, specialist_snapshot,
        selection_state, runtime_id, account_id, model, effort_state, effort,
        native_session_id, native_identity_state, continuation_state,
        continuation_attempt_id
      FROM agent_runs WHERE id = 'legacy-paused'`).get(),
    {
      status: 'paused',
      snapshot_state: 'legacy-unavailable',
      specialist_snapshot: null,
      selection_state: 'legacy-unavailable',
      runtime_id: null,
      account_id: null,
      model: null,
      effort_state: 'legacy-unknown',
      effort: null,
      native_session_id: 'placeholder-or-native',
      native_identity_state: 'legacy-untrusted',
      continuation_state: 'legacy-unavailable',
      continuation_attempt_id: null,
    },
  );
  const askColumns = new Set(
    (db.pragma('table_info(pending_asks)') as Array<{ name: string }>).map((row) => row.name),
  );
  assert.equal(askColumns.has('cc_session_id'), false);
  assert.equal((db.prepare('SELECT count(*) n FROM pending_asks').get() as { n: number }).n, 1);
  assert.deepEqual(db.prepare('SELECT entity FROM live_outbox ORDER BY seq').all(), [{ entity: 'usage' }]);

  db.prepare("UPDATE agent_runs SET status = 'failed' WHERE id = 'legacy-paused'").run();
  assert.throws(
    () => db.prepare("UPDATE agent_runs SET status = 'running' WHERE id = 'legacy-paused'").run(),
    /terminal agent run status is immutable/,
  );
  db.close();
});

test('0013 guards complete immutable stamps and parent-derived continuations', () => {
  const db = new Database(':memory:');
  legacySchema(db);
  apply0013(db);

  const snapshot = JSON.stringify({
    specialistId: 'specialist-builder',
    revision: 'sha256:builder',
    name: 'builder',
    charter: 'Build.',
    contextDocs: [{ id: 'doc-1', title: 'Facts', body: 'Body', updatedAt: 1 }],
    maxTurns: 10,
  });
  const insert = db.prepare(`INSERT INTO agent_runs (
      id, project_id, dispatcher_session_id, pod_name, snapshot_state,
      specialist_snapshot, selection_state, runtime_id, account_id, model,
      effort_state, effort, native_session_id, native_identity_state,
      continuation_state, continuation_attempt_id, status, continues,
      queued_at, parent_invoke_depth, rev, auto_continue_count
    ) VALUES (?, 'p1', 'dispatcher', 'builder', 'stamped', ?, 'stamped',
      ?, 'account', 'model', 'selected', 'high', ?, ?, ?, ?,
      'queued', ?, 1, 0, 0, 0)`);

  assert.throws(
    () => insert.run('empty-snapshot', '{}', 'runtime', null, 'unbound', 'clean-pending', 'attempt-empty', null),
    /complete immutable execution stamp/,
  );
  assert.throws(
    () => insert.run(
      'missing-doc-field',
      JSON.stringify({
        specialistId: 'specialist-builder', revision: 'sha256:bad-doc', name: 'builder',
        charter: 'Build.', contextDocs: [{ id: 'doc-1', title: 'Facts', body: 'Body' }],
        maxTurns: 10,
      }),
      'runtime',
      null,
      'unbound',
      'clean-pending',
      'attempt-bad-doc',
      null,
    ),
    /complete immutable execution stamp/,
  );
  assert.throws(
    () => insert.run(
      'snapshot-extra',
      JSON.stringify({ ...JSON.parse(snapshot), nativeSessionId: 'must-not-persist' }),
      'runtime',
      null,
      'unbound',
      'clean-pending',
      'attempt-extra',
      null,
    ),
    /complete immutable execution stamp/,
  );
  assert.throws(
    () => insert.run(
      'duplicate-docs',
      JSON.stringify({
        ...JSON.parse(snapshot),
        contextDocs: [
          { id: 'doc-1', title: 'One', body: '', updatedAt: 1 },
          { id: 'doc-1', title: 'Two', body: '', updatedAt: 2 },
        ],
      }),
      'runtime',
      null,
      'unbound',
      'clean-pending',
      'attempt-duplicate-docs',
      null,
    ),
    /complete immutable execution stamp/,
  );
  assert.throws(
    () => insert.run(
      'unsafe-integer',
      JSON.stringify({ ...JSON.parse(snapshot), maxTurns: 9007199254740992 }),
      'runtime',
      null,
      'unbound',
      'clean-pending',
      'attempt-unsafe',
      null,
    ),
    /complete immutable execution stamp/,
  );
  assert.throws(
    () => insert.run(
      'whitespace-runtime', snapshot, ' runtime ', null, 'unbound', 'clean-pending',
      'attempt-whitespace-runtime', null,
    ),
    /complete immutable execution stamp/,
  );

  insert.run('parent', snapshot, 'runtime', null, 'unbound', 'clean-pending', 'attempt-parent', null);
  assert.throws(
    () => db.prepare("UPDATE agent_runs SET status = 'running' WHERE id = 'parent'").run(),
    /cannot run before an exact native session receipt/,
  );
  assert.throws(
    () => db.prepare(`INSERT INTO agent_runs (
      id, project_id, dispatcher_session_id, pod_name, snapshot_state,
      selection_state, runtime_id, account_id, model, effort_state,
      native_identity_state, continuation_state, continuation_attempt_id,
      status, queued_at, parent_invoke_depth, rev, auto_continue_count
    ) VALUES ('bad', 'p1', 'd', 'builder', 'stamped', 'stamped',
      'runtime', 'account', 'model', 'none', 'unbound', 'clean-pending',
      'attempt', 'queued', 1, 0, 0, 0)`).run(),
    /complete immutable execution stamp/,
  );
  assert.throws(
    () => db.prepare("UPDATE agent_runs SET account_id = 'other' WHERE id = 'parent'").run(),
    /runtime selection is immutable/,
  );
  assert.throws(
    () => db.prepare("UPDATE agent_runs SET pod_name = 'other' WHERE id = 'parent'").run(),
    /specialist snapshot is immutable|execution row is inconsistent/,
  );

  db.prepare("UPDATE agent_runs SET status = 'spawning' WHERE id = 'parent'").run();
  db.prepare(`UPDATE agent_runs
    SET native_session_id = 'native-1', native_identity_state = 'bound',
        continuation_state = 'clean-started'
    WHERE id = 'parent'`).run();
  assert.throws(
    () => insert.run(
      'child-of-active-parent',
      snapshot,
      'runtime',
      'native-1',
      'bound',
      'resume-pending',
      'attempt-child-active-parent',
      'parent',
    ),
    /inherit exact parent execution evidence/,
    'a continuation is derived only from a terminal completed/failed parent',
  );
  db.prepare("UPDATE agent_runs SET status = 'failed' WHERE id = 'parent'").run();
  assert.throws(
    () => insert.run(
      'bad-child',
      snapshot,
      'runtime',
      'native-conflict',
      'bound',
      'resume-pending',
      'attempt-bad-child',
      'parent',
    ),
    /inherit exact parent execution evidence/,
  );
  insert.run(
    'child',
    snapshot,
    'runtime',
    'native-1',
    'bound',
    'resume-pending',
    'attempt-child',
    'parent',
  );
  assert.throws(
    () => insert.run(
      'second-active-child',
      snapshot,
      'runtime',
      'native-1',
      'bound',
      'resume-pending',
      'attempt-second-child',
      'parent',
    ),
    /already has an active continuation/,
  );
  db.prepare("UPDATE agent_runs SET status = 'failed' WHERE id = 'child'").run();
  assert.throws(
    () => db.prepare("UPDATE agent_runs SET status = 'running' WHERE id = 'child'").run(),
    /terminal agent run status is immutable/,
  );
  assert.throws(
    () => db.prepare("UPDATE agent_runs SET native_session_id = 'other' WHERE id = 'parent'").run(),
    /may bind only once/,
  );

  // The selection/native tuple alone is insufficient provenance. A child must
  // also remain in the parent's exact project, contract, worktree, PM scope,
  // and invoke depth; otherwise raw SQL could splice trusted native evidence
  // onto unrelated repository work.
  db.prepare(`INSERT INTO agent_runs (
      id, project_id, dispatcher_session_id, pod_name, snapshot_state,
      specialist_snapshot, selection_state, runtime_id, account_id, model,
      effort_state, effort, native_session_id, native_identity_state,
      continuation_state, continuation_attempt_id, status, continues,
      contract_id, worktree_dir, worktree_base_branch, worktree_base_sha,
      pm_ref, parent_invoke_depth, queued_at, rev, auto_continue_count
    ) VALUES (
      'derived-parent', 'p1', 'dispatcher', 'builder', 'stamped',
      ?, 'stamped', 'runtime', 'account', 'model',
      'selected', 'high', NULL, 'unbound',
      'clean-pending', 'attempt-derived-parent', 'queued', NULL,
      'contract-1', '/repo/worktrees/derived', 'main',
      'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
      'PM-1', 2, 1, 0, 0
    )`).run(snapshot);
  db.prepare("UPDATE agent_runs SET status = 'spawning' WHERE id = 'derived-parent'").run();
  db.prepare(`UPDATE agent_runs
    SET native_session_id = 'native-derived', native_identity_state = 'bound',
        continuation_state = 'clean-started'
    WHERE id = 'derived-parent'`).run();
  db.prepare("UPDATE agent_runs SET status = 'completed' WHERE id = 'derived-parent'").run();

  const insertDerivedChild = db.prepare(`INSERT INTO agent_runs (
      id, project_id, dispatcher_session_id, pod_name, snapshot_state,
      specialist_snapshot, selection_state, runtime_id, account_id, model,
      effort_state, effort, native_session_id, native_identity_state,
      continuation_state, continuation_attempt_id, status, continues,
      contract_id, worktree_dir, worktree_base_branch, worktree_base_sha,
      pm_ref, parent_invoke_depth, queued_at, rev, auto_continue_count
    ) VALUES (
      @id, @projectId, 'dispatcher-child', 'builder', 'stamped',
      @snapshot, 'stamped', 'runtime', 'account', 'model',
      'selected', 'high', 'native-derived', 'bound',
      'resume-pending', @attemptId, 'queued', 'derived-parent',
      @contractId, @worktreeDir, @baseBranch, @baseSha,
      @pmRef, @depth, 2, 0, 0
    )`);
  const exactDerived = {
    projectId: 'p1',
    snapshot,
    contractId: 'contract-1',
    worktreeDir: '/repo/worktrees/derived',
    baseBranch: 'main',
    baseSha: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
    pmRef: 'PM-1',
    depth: 2,
  };
  for (const [name, patch] of [
    ['project', { projectId: 'other-project' }],
    ['contract', { contractId: 'contract-2' }],
    ['worktree-dir', { worktreeDir: '/repo/worktrees/other' }],
    ['base-branch', { baseBranch: 'dev' }],
    ['base-sha', { baseSha: 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb' }],
    ['pm-ref', { pmRef: 'PM-2' }],
    ['invoke-depth', { depth: 3 }],
  ] as const) {
    assert.throws(
      () => insertDerivedChild.run({
        id: `derived-child-wrong-${name}`,
        attemptId: `attempt-derived-wrong-${name}`,
        ...exactDerived,
        ...patch,
      }),
      /inherit exact parent execution evidence/,
      `${name} mismatch must reject derived continuation evidence`,
    );
  }
  insertDerivedChild.run({
    id: 'derived-child-exact',
    attemptId: 'attempt-derived-exact',
    ...exactDerived,
  });

  // Admission is not the end of the invariant: neither the trusted parent nor
  // its bound continuation may later drift any scope field that justified the
  // inherited native identity.
  const scopeMutations: ReadonlyArray<readonly [string, string | number | null]> = [
    ['project_id', 'other-project'],
    ['contract_id', 'contract-2'],
    ['worktree_dir', '/repo/worktrees/other'],
    ['worktree_base_branch', 'dev'],
    ['worktree_base_sha', 'b'.repeat(40)],
    ['pm_ref', 'PM-2'],
    ['parent_invoke_depth', 3],
  ];
  for (const rowId of ['derived-parent', 'derived-child-exact']) {
    for (const [column, value] of scopeMutations) {
      assert.throws(
        () => db.prepare(`UPDATE agent_runs SET ${column} = ? WHERE id = ?`).run(value, rowId),
        /agent run execution scope is immutable/,
        `${rowId}.${column} must remain frozen after admission`,
      );
    }
  }
  db.close();
});
