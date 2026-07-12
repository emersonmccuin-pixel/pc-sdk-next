// Migration 0003 — agent_runs.lifecycle_state + the gateway transition guard.
// The gateway functions (updateAgentRunStatus / markAgentRunTerminal) are the
// ONE door: illegal lifecycle moves throw typed and write NOTHING (the status
// part of the update is rejected too); legal moves stamp atomically.

import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { IllegalLifecycleTransitionError, type ULID } from '@pc/domain';

const tmpDir = mkdtempSync(join(tmpdir(), 'pc-lifecycle-'));
process.env.PC_DATA_DIR = tmpDir;

const {
  assertSchemaIntact,
  closeDb,
  createProject,
  getAgentRunRow,
  getRawDb,
  confirmAgentRunRuntimeSessionReceipt,
  insertAgentRunRow,
  markAgentRunTerminal,
  newId,
  prepareAgentRunCreate,
  runMigrations,
  updateAgentRunStatus,
} = await import('../src/index.ts');

const selection = {
  runtimeId: 'runtime',
  accountId: 'account',
  model: 'model',
  effort: { kind: 'none' as const },
};

before(() => runMigrations());
after(() => {
  closeDb();
  rmSync(tmpDir, { recursive: true, force: true });
});

function newRun(lifecycleState: Parameters<typeof insertAgentRunRow>[0]['lifecycleState'] = null): ULID {
  const project = createProject({ name: 'T', slug: `t-${newId().toLowerCase()}`, folderPath: '' });
  const id = newId() as ULID;
  insertAgentRunRow({
    id,
    projectId: project.id,
    dispatcherSessionId: 'S1',
    specialistSnapshot: {
      specialistId: 'specialist-code-writer' as ULID,
      revision: 'sha256:test-code-writer',
      name: 'code-writer',
      charter: 'Write code.',
      contextDocs: [],
      maxTurns: 10,
    },
    selection,
    continuation: { mode: 'create' },
    status: 'queued',
    input: 'go',
    lifecycleState,
    queuedAt: Date.now(),
  });
  return id;
}

function bindRun(id: ULID): void {
  const prepared = prepareAgentRunCreate(id);
  assert.ok(prepared?.continuationAttemptId);
  assert.equal(updateAgentRunStatus({ id, status: 'spawning' }), true);
  assert.equal(confirmAgentRunRuntimeSessionReceipt({
    runId: id,
    receipt: {
      mode: 'created',
      selection,
      continuationAttemptId: prepared.continuationAttemptId,
      nativeSessionId: `native-${id}`,
      requestedNativeSessionId: null,
    },
  }).status, 'confirmed');
}

test('0003 creates agent_runs.lifecycle_state; schema intact', () => {
  const cols = (getRawDb().pragma('table_info("agent_runs")') as { name: string }[]).map((c) => c.name);
  assert.ok(cols.includes('lifecycle_state'));
  assert.doesNotThrow(() => assertSchemaIntact());
});

test('insert defaults lifecycleState to NULL (legacy/non-repo); explicit value persists', () => {
  assert.equal(getAgentRunRow(newRun())!.lifecycleState, null);
  assert.equal(getAgentRunRow(newRun('provisioning'))!.lifecycleState, 'provisioning');
});

test('legal transition stamps state + status together', () => {
  const id = newRun('provisioning');
  bindRun(id);
  updateAgentRunStatus({ id, status: 'running', readyAt: 1, lifecycleState: 'building' });
  const row = getAgentRunRow(id)!;
  assert.equal(row.lifecycleState, 'building');
  assert.equal(row.status, 'running');
  assert.equal(row.readyAt, 1);
});

test('illegal transition throws typed and writes NOTHING (status rejected too)', () => {
  const id = newRun('building');
  bindRun(id);
  const before = getAgentRunRow(id)!;
  assert.throws(
    () => updateAgentRunStatus({ id, status: 'running', lifecycleState: 'merged' }),
    (err: unknown) => {
      assert.ok(err instanceof IllegalLifecycleTransitionError);
      assert.equal(err.from, 'building');
      assert.equal(err.to, 'merged');
      return true;
    },
  );
  const after = getAgentRunRow(id)!;
  assert.equal(after.lifecycleState, 'building');
  assert.equal(after.status, before.status, 'the whole update was rejected');
  assert.equal(after.rev, before.rev, 'no rev bump on rejection');
});

test('NULL adopts any state; same-state re-stamp is an idempotent no-throw', () => {
  const id = newRun(null);
  bindRun(id);
  updateAgentRunStatus({ id, status: 'running', lifecycleState: 'verifying' });
  assert.equal(getAgentRunRow(id)!.lifecycleState, 'verifying');
  updateAgentRunStatus({ id, status: 'running', lifecycleState: 'verifying' });
  assert.equal(getAgentRunRow(id)!.lifecycleState, 'verifying');
});

test('omitting lifecycleState leaves it untouched', () => {
  const id = newRun('verifying');
  bindRun(id);
  updateAgentRunStatus({ id, status: 'paused' });
  assert.equal(getAgentRunRow(id)!.lifecycleState, 'verifying');
  markAgentRunTerminal({ id, status: 'completed', result: 'ok', failureCause: null, failureReason: null, completedAt: 2 });
  const row = getAgentRunRow(id)!;
  assert.equal(row.status, 'completed');
  assert.equal(row.lifecycleState, 'verifying', 'repo lifecycle outlives the dispatch terminal');
});

test('markAgentRunTerminal guards too: legal stamps, illegal throws', () => {
  const legal = newRun('building');
  markAgentRunTerminal({ id: legal, status: 'failed', result: null, failureCause: 'unexpected-exit', failureReason: 'x', completedAt: 3, lifecycleState: 'failed' });
  assert.equal(getAgentRunRow(legal)!.lifecycleState, 'failed');

  const illegal = newRun('completed');
  assert.throws(
    () => markAgentRunTerminal({ id: illegal, status: 'failed', result: null, failureCause: 'unexpected-exit', failureReason: 'x', completedAt: 4, lifecycleState: 'failed' }),
    IllegalLifecycleTransitionError,
  );
  assert.equal(getAgentRunRow(illegal)!.status, 'queued', 'terminal flip rejected with the stamp');
});
