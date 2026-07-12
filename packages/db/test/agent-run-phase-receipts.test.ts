import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ULID, WorktreePhaseReceipt } from '@pc/domain';

const tmpDir = mkdtempSync(join(tmpdir(), 'pc-phase-receipts-'));
process.env.PC_DATA_DIR = tmpDir;

const {
  closeDb,
  confirmAgentRunRuntimeSessionReceipt,
  createProject,
  getAgentRunRow,
  insertAgentRunRow,
  markAgentRunTerminal,
  newId,
  prepareAgentRunCreate,
  runMigrations,
  runtimeSelectionForAgentRun,
  setAgentRunPhaseReceipt,
  specialistSnapshotForAgentRun,
  updateAgentRunStatus,
} = await import('../src/index.ts');

before(() => runMigrations());
after(() => {
  closeDb();
  rmSync(tmpDir, { recursive: true, force: true });
});

function newRun(): ULID {
  const project = createProject({ name: 'T', slug: `t-${newId().toLowerCase()}`, folderPath: '' });
  const id = newId() as ULID;
  insertAgentRunRow({
    id,
    projectId: project.id,
    dispatcherSessionId: 'S1',
    specialistSnapshot: {
      specialistId: '01J00000000000000000000000' as ULID,
      revision: 'sha256:test-builder',
      name: 'builder',
      charter: 'Build.',
      contextDocs: [],
      maxTurns: 10,
    },
    selection: {
      runtimeId: 'runtime', accountId: 'account', model: 'model', effort: { kind: 'none' },
    },
    continuation: { mode: 'create' },
    status: 'queued',
    input: 'go',
    lifecycleState: 'preparing',
    queuedAt: Date.now(),
  });
  return id;
}

function newContinuation(): { parentId: ULID; childId: ULID } {
  const parentId = newRun();
  const prepared = prepareAgentRunCreate(parentId);
  assert.ok(prepared?.continuationAttemptId);
  assert.equal(updateAgentRunStatus({ id: parentId, status: 'spawning' }), true);
  const parentBeforeBind = getAgentRunRow(parentId)!;
  const selection = runtimeSelectionForAgentRun(parentBeforeBind)!;
  assert.equal(confirmAgentRunRuntimeSessionReceipt({
    runId: parentId,
    receipt: {
      mode: 'created',
      selection,
      continuationAttemptId: prepared.continuationAttemptId,
      nativeSessionId: `native-${parentId}`,
      requestedNativeSessionId: null,
    },
  }).status, 'confirmed');
  assert.equal(markAgentRunTerminal({
    id: parentId,
    status: 'failed',
    result: null,
    failureCause: 'unexpected-exit',
    failureReason: 'parent stopped',
    completedAt: Date.now(),
    lifecycleState: 'failed',
  }), true);

  const parent = getAgentRunRow(parentId)!;
  const childId = newId() as ULID;
  insertAgentRunRow({
    id: childId,
    projectId: parent.projectId,
    dispatcherSessionId: parent.dispatcherSessionId,
    specialistSnapshot: specialistSnapshotForAgentRun(parent)!,
    selection: runtimeSelectionForAgentRun(parent)!,
    continuation: { mode: 'resume', nativeSessionId: parent.nativeSessionId! },
    continues: parentId,
    status: 'queued',
    input: 'continue',
    lifecycleState: 'preparing',
    queuedAt: Date.now(),
  });
  return { parentId, childId };
}

test('phase receipt persistence is queued/preparing first-write CAS', () => {
  const id = newRun();
  const preparation: WorktreePhaseReceipt = {
    phase: 'preparation', outcome: 'not-required', reason: 'no-commands-configured',
    ok: true, steps: [], finishedAt: 100,
  };
  const before = getAgentRunRow(id)!;
  assert.equal(setAgentRunPhaseReceipt(id, preparation), true);
  const written = getAgentRunRow(id)!;
  assert.deepEqual(written.preparationReceipt, preparation);
  assert.equal(written.rev, before.rev + 1);

  const replacement: WorktreePhaseReceipt = {
    phase: 'preparation', outcome: 'executed', ok: true,
    steps: [{
      command: 'pnpm install', exitCode: 0, durationMs: 2,
      stdoutTail: '', stderrTail: '', timedOut: false,
    }],
    finishedAt: 101,
  };
  assert.equal(setAgentRunPhaseReceipt(id, replacement), false);
  assert.deepEqual(getAgentRunRow(id)!.preparationReceipt, preparation);
  assert.equal(getAgentRunRow(id)!.rev, written.rev, 'failed CAS does not bump rev');

  assert.equal(setAgentRunPhaseReceipt(id, {
    phase: 'readiness', outcome: 'executed', ok: false,
    steps: [{
      command: 'pnpm test', exitCode: 1, durationMs: 3,
      stdoutTail: '', stderrTail: 'failed', timedOut: false,
    }],
    finishedAt: 102,
  }), true, 'negative executed evidence is still durably first-written');

  markAgentRunTerminal({
    id, status: 'failed', result: null, failureCause: 'unexpected-exit',
    failureReason: 'failed', completedAt: 103, lifecycleState: 'failed',
  });
  const terminalWithoutReceipt = newRun();
  markAgentRunTerminal({
    id: terminalWithoutReceipt, status: 'failed', result: null,
    failureCause: 'unexpected-exit', failureReason: 'cancelled before readiness',
    completedAt: 103, lifecycleState: 'failed',
  });
  assert.equal(setAgentRunPhaseReceipt(terminalWithoutReceipt, {
    phase: 'readiness', outcome: 'not-required', reason: 'no-commands-configured',
    ok: true, steps: [], finishedAt: 104,
  }), false, 'terminal rows reject phase evidence');
  assert.equal(getAgentRunRow(terminalWithoutReceipt)!.readinessReceipt, null);
});

test('phase receipt persistence rejects malformed runtime input without writing', () => {
  const id = newRun();
  assert.equal(setAgentRunPhaseReceipt(id, {
    phase: 'preparation', outcome: 'executed', ok: true, steps: [], finishedAt: 100,
  } as never), false);
  assert.equal(setAgentRunPhaseReceipt(id, {
    phase: 'preparation', outcome: 'not-required', reason: 'existing-worktree-preparation',
    inheritedFromRunId: 'not-a-ulid', ok: true, steps: [], finishedAt: 100,
  } as never), false);
  assert.equal(getAgentRunRow(id)!.preparationReceipt, null);
});

test('phase receipt persistence binds preparation authority to exact run context and order', () => {
  const fresh = newRun();
  assert.equal(setAgentRunPhaseReceipt(fresh, {
    phase: 'preparation', outcome: 'not-required', reason: 'existing-worktree-preparation',
    inheritedFromRunId: newId() as ULID, ok: true, steps: [], finishedAt: 100,
  }), false, 'fresh runs cannot claim inherited preparation');
  assert.equal(setAgentRunPhaseReceipt(fresh, {
    phase: 'readiness', outcome: 'not-required', reason: 'no-commands-configured',
    ok: true, steps: [], finishedAt: 101,
  }), false, 'readiness cannot be recorded before positive preparation');

  const { parentId, childId } = newContinuation();
  assert.equal(setAgentRunPhaseReceipt(childId, {
    phase: 'preparation', outcome: 'not-required', reason: 'no-commands-configured',
    ok: true, steps: [], finishedAt: 102,
  }), false, 'continuations cannot claim fresh-run preparation');
  assert.equal(setAgentRunPhaseReceipt(childId, {
    phase: 'preparation', outcome: 'not-required', reason: 'existing-worktree-preparation',
    inheritedFromRunId: newId() as ULID, ok: true, steps: [], finishedAt: 103,
  }), false, 'continuations must name their exact parent');
  assert.equal(setAgentRunPhaseReceipt(childId, {
    phase: 'preparation', outcome: 'not-required', reason: 'existing-worktree-preparation',
    inheritedFromRunId: parentId, ok: true, steps: [], finishedAt: 104,
  }), true);
  assert.equal(setAgentRunPhaseReceipt(childId, {
    phase: 'readiness', outcome: 'not-required', reason: 'no-commands-configured',
    ok: true, steps: [], finishedAt: 105,
  }), true, 'readiness follows exact positive continuation preparation');
});

test('phase receipt persistence refuses once the pre-runtime phase has advanced', () => {
  const ready = newRun();
  assert.equal(updateAgentRunStatus({ id: ready, status: 'queued', lifecycleState: 'ready' }), true);
  assert.equal(setAgentRunPhaseReceipt(ready, {
    phase: 'preparation', outcome: 'not-required', reason: 'no-commands-configured',
    ok: true, steps: [], finishedAt: 100,
  }), false, 'queued is insufficient once lifecycle left preparing');

  const spawning = newRun();
  assert.equal(updateAgentRunStatus({ id: spawning, status: 'spawning', spawnedAt: 100 }), true);
  assert.equal(setAgentRunPhaseReceipt(spawning, {
    phase: 'preparation', outcome: 'not-required', reason: 'no-commands-configured',
    ok: true, steps: [], finishedAt: 101,
  }), false, 'preparing is insufficient once provider start began');
});
