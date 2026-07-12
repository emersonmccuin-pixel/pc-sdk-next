import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import Database from 'better-sqlite3';

const here = dirname(fileURLToPath(import.meta.url));

function apply0016(db: Database.Database): void {
  const sql = readFileSync(
    join(here, '..', 'drizzle', '0016_phase_receipt_outcomes.sql'),
    'utf8',
  );
  db.transaction(() => {
    for (const statement of sql.split('--> statement-breakpoint')) {
      if (statement.trim()) db.exec(statement);
    }
  })();
}

function step(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    command: 'pnpm test',
    exitCode: 0,
    durationMs: 4,
    stdoutTail: 'ok',
    stderrTail: '',
    timedOut: false,
    ...over,
  };
}

function legacyReceipt(
  phase: 'preparation' | 'readiness',
  over: Record<string, unknown> = {},
): Record<string, unknown> {
  return { phase, ok: true, steps: [step()], finishedAt: 100, ...over };
}

test('0016 promotes only exact nonempty command-bearing legacy receipts', () => {
  const db = new Database(':memory:');
  db.exec(`CREATE TABLE agent_runs (
    id text PRIMARY KEY NOT NULL,
    continues text,
    preparation_receipt text,
    readiness_receipt text
  );
  CREATE TABLE live_outbox (
    seq integer PRIMARY KEY AUTOINCREMENT,
    entity text NOT NULL,
    payload text NOT NULL
  )`);
  const insert = db.prepare(
    'INSERT INTO agent_runs (id, preparation_receipt, readiness_receipt) VALUES (?, ?, ?)',
  );
  const insertContinuation = db.prepare(
    'INSERT INTO agent_runs (id, continues, preparation_receipt, readiness_receipt) VALUES (?, ?, ?, ?)',
  );

  const validPreparation = legacyReceipt('preparation');
  const validFailedReadiness = legacyReceipt('readiness', {
    ok: false,
    steps: [step({ exitCode: 1, stderrTail: 'failed' })],
  });
  insert.run('valid', JSON.stringify(validPreparation), JSON.stringify(validFailedReadiness));
  insert.run('null', null, null);
  insert.run(
    'empty',
    JSON.stringify(legacyReceipt('preparation', { steps: [] })),
    JSON.stringify(legacyReceipt('readiness', { steps: [] })),
  );
  insert.run('malformed-json', '{', '[nope');
  insert.run(
    'malformed-shape',
    JSON.stringify(legacyReceipt('preparation', { providerReceipt: 'leak' })),
    JSON.stringify(legacyReceipt('readiness', { steps: [step({ durationMs: -1 })] })),
  );
  insert.run(
    'inconsistent',
    JSON.stringify(legacyReceipt('preparation', { ok: false })),
    JSON.stringify(legacyReceipt('readiness', { steps: [step({ timedOut: true })] })),
  );
  insert.run(
    'phase-mismatch',
    JSON.stringify(legacyReceipt('readiness')),
    JSON.stringify(legacyReceipt('preparation')),
  );
  insert.run(
    'malformed-outcome',
    JSON.stringify({ ...legacyReceipt('preparation'), outcome: 'bogus' }),
    JSON.stringify({
      phase: 'readiness', outcome: 'not-required',
      reason: 'existing-worktree-preparation', inheritedFromRunId: '01J00000000000000000000000',
      ok: true, steps: [], finishedAt: 100,
    }),
  );
  insert.run(
    'edge-whitespace',
    JSON.stringify(legacyReceipt('preparation', { steps: [step({ command: '\tpnpm test' })] })),
    JSON.stringify(legacyReceipt('readiness', { steps: [step({ command: `pnpm test\u00a0` })] })),
  );
  insert.run(
    'lowercase-parent',
    JSON.stringify({
      phase: 'preparation', outcome: 'not-required', reason: 'existing-worktree-preparation',
      inheritedFromRunId: '01j00000000000000000000000',
      ok: true, steps: [], finishedAt: 100,
    }),
    null,
  );
  const canonicalPreparation = {
    phase: 'preparation', outcome: 'not-required', reason: 'existing-worktree-preparation',
    inheritedFromRunId: '01J00000000000000000000000',
    ok: true, steps: [], finishedAt: 100,
  };
  const canonicalReadiness = {
    phase: 'readiness', outcome: 'not-required', reason: 'no-commands-configured',
    ok: true, steps: [], finishedAt: 101,
  };
  insertContinuation.run(
    'canonical', canonicalPreparation.inheritedFromRunId,
    JSON.stringify(canonicalPreparation), JSON.stringify(canonicalReadiness),
  );
  insertContinuation.run(
    'wrong-parent', '01J11111111111111111111111',
    JSON.stringify(canonicalPreparation), null,
  );
  insertContinuation.run(
    'continuation-fresh-prep', canonicalPreparation.inheritedFromRunId,
    JSON.stringify({
      phase: 'preparation', outcome: 'not-required', reason: 'no-commands-configured',
      ok: true, steps: [], finishedAt: 100,
    }),
    null,
  );
  insert.run('fresh-inherited-prep', JSON.stringify(canonicalPreparation), null);
  insertContinuation.run(
    'continuation-executed-prep', canonicalPreparation.inheritedFromRunId,
    JSON.stringify({ ...legacyReceipt('preparation'), outcome: 'executed' }),
    null,
  );
  db.exec(`
    INSERT INTO live_outbox (entity, payload) VALUES
      ('agent-run', '{"legacy":"phase-receipt-shape"}'),
      ('usage', '{"retained":true}');
  `);

  assert.doesNotThrow(() => apply0016(db));

  const valid = db.prepare(
    "SELECT preparation_receipt preparation, readiness_receipt readiness FROM agent_runs WHERE id = 'valid'",
  ).get() as { preparation: string; readiness: string };
  assert.deepEqual(JSON.parse(valid.preparation), { ...validPreparation, outcome: 'executed' });
  assert.deepEqual(JSON.parse(valid.readiness), { ...validFailedReadiness, outcome: 'executed' });

  for (const id of [
    'empty', 'malformed-json', 'malformed-shape', 'inconsistent',
    'phase-mismatch', 'malformed-outcome', 'edge-whitespace', 'lowercase-parent',
    'wrong-parent', 'continuation-fresh-prep', 'fresh-inherited-prep',
    'continuation-executed-prep',
  ]) {
    const unavailable = db.prepare(
      'SELECT preparation_receipt preparation, readiness_receipt readiness FROM agent_runs WHERE id = ?',
    ).get(id);
    assert.deepEqual(
      unavailable,
      { preparation: null, readiness: null },
      `${id} stays unavailable rather than becoming a malformed projection`,
    );
  }
  assert.deepEqual(db.prepare(
    "SELECT preparation_receipt preparation, readiness_receipt readiness FROM agent_runs WHERE id = 'null'",
  ).get(), { preparation: null, readiness: null });
  const canonical = db.prepare(
    "SELECT preparation_receipt preparation, readiness_receipt readiness FROM agent_runs WHERE id = 'canonical'",
  ).get() as { preparation: string; readiness: string };
  assert.deepEqual(JSON.parse(canonical.preparation), canonicalPreparation);
  assert.deepEqual(JSON.parse(canonical.readiness), canonicalReadiness);
  assert.deepEqual(
    db.prepare('SELECT entity, payload FROM live_outbox ORDER BY seq').all(),
    [{ entity: 'usage', payload: '{"retained":true}' }],
    'legacy agent-run replay frames are invalidated while unrelated resources remain',
  );

  const afterFirst = valid;
  apply0016(db);
  assert.deepEqual(db.prepare(
    "SELECT preparation_receipt preparation, readiness_receipt readiness FROM agent_runs WHERE id = 'valid'",
  ).get(), afterFirst, 'migration is deterministic on replay');
  db.close();
});
