import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { RuntimeSelection, RuntimeSessionReceipt } from '@pc/contracts';
import type { SpecialistExecutionSnapshot, ULID } from '@pc/domain';

const tmpDir = mkdtempSync(join(tmpdir(), 'pc-specialist-stamps-'));
process.env.PC_DATA_DIR = tmpDir;

const db = await import('../src/index.ts');

before(() => db.runMigrations());
after(() => {
  db.closeDb();
  rmSync(tmpDir, { recursive: true, force: true });
});

const selection: RuntimeSelection = {
  runtimeId: 'runtime-a',
  accountId: 'account-a',
  model: 'model-a',
  effort: { kind: 'selected', value: 'high' },
};

const snapshot: SpecialistExecutionSnapshot = {
  specialistId: 'specialist-builder' as ULID,
  revision: 'sha256:builder',
  name: 'builder',
  charter: 'Build carefully.',
  contextDocs: [{ id: 'doc-a' as ULID, title: 'Facts', body: 'One.', updatedAt: 1 }],
  maxTurns: 20,
};

function createdReceipt(run: ReturnType<typeof db.getAgentRunRow>, nativeSessionId = 'native-a'):
RuntimeSessionReceipt {
  assert.ok(run?.continuationAttemptId);
  return {
    mode: 'created',
    continuationAttemptId: run.continuationAttemptId,
    selection,
    nativeSessionId,
    requestedNativeSessionId: null,
  };
}

test('fresh stamp is immutable and exact create receipt binds once', () => {
  const project = db.createProject({ name: 'Stamp', slug: 'stamp', folderPath: '' });
  const runId = db.newId() as ULID;
  const inserted = db.insertAgentRunRow({
    id: runId,
    projectId: project.id,
    dispatcherSessionId: 'dispatcher',
    specialistSnapshot: snapshot,
    selection,
    continuation: { mode: 'create' },
    status: 'queued',
    input: 'go',
    queuedAt: 1,
  });
  assert.equal(inserted.snapshotState, 'stamped');
  assert.equal(inserted.selectionState, 'stamped');
  assert.equal(inserted.nativeSessionId, null);
  assert.equal(inserted.continuationState, 'clean-pending');
  assert.deepEqual(db.specialistSnapshotForAgentRun(inserted), snapshot);
  assert.deepEqual(db.runtimeSelectionForAgentRun(inserted), selection);

  assert.throws(
    () => db.getRawDb().prepare("UPDATE agent_runs SET model = 'other' WHERE id = ?").run(runId),
    /runtime selection is immutable/,
  );
  assert.throws(
    () => db.getRawDb().prepare("UPDATE agent_runs SET pod_name = 'other' WHERE id = ?").run(runId),
    /specialist snapshot is immutable|execution row is inconsistent/,
  );

  const originalAttempt = inserted.continuationAttemptId;
  const prepared = db.prepareAgentRunCreate(runId);
  assert.ok(prepared?.continuationAttemptId);
  assert.notEqual(prepared.continuationAttemptId, originalAttempt);
  assert.equal(db.updateAgentRunStatus({ id: runId, status: 'spawning', spawnedAt: 2 }), true);

  const baseReceipt = createdReceipt(db.getAgentRunRow(runId));
  assert.deepEqual(
    db.confirmAgentRunRuntimeSessionReceipt({
      runId,
      receipt: { ...baseReceipt, raw: 'provider-secret' } as never,
    }),
    { status: 'rejected', reason: 'malformed-receipt' },
  );
  assert.deepEqual(
    db.confirmAgentRunRuntimeSessionReceipt({
      runId,
      receipt: {
        ...baseReceipt,
        mode: 'resumed',
        requestedNativeSessionId: baseReceipt.nativeSessionId,
      },
    }),
    { status: 'rejected', reason: 'receipt-mode-mismatch' },
  );

  const wrongSelection = {
    ...createdReceipt(db.getAgentRunRow(runId)),
    selection: { ...selection, model: 'other' },
  } as RuntimeSessionReceipt;
  assert.deepEqual(
    db.confirmAgentRunRuntimeSessionReceipt({ runId, receipt: wrongSelection }),
    { status: 'rejected', reason: 'selection-mismatch' },
  );
  assert.equal(db.getAgentRunRow(runId)?.nativeSessionId, null);

  const receipt = createdReceipt(db.getAgentRunRow(runId));
  const confirmed = db.confirmAgentRunRuntimeSessionReceipt({ runId, receipt });
  assert.equal(confirmed.status, 'confirmed');
  if (confirmed.status === 'confirmed') assert.equal(confirmed.duplicate, false);
  const bound = db.getAgentRunRow(runId)!;
  assert.equal(bound.nativeSessionId, 'native-a');
  assert.equal(bound.nativeIdentityState, 'bound');
  assert.equal(bound.continuationState, 'clean-started');
  const duplicate = db.confirmAgentRunRuntimeSessionReceipt({ runId, receipt });
  assert.equal(duplicate.status, 'confirmed');
  if (duplicate.status === 'confirmed') assert.equal(duplicate.duplicate, true);
  assert.deepEqual(
    db.confirmAgentRunRuntimeSessionReceipt({
      runId,
      receipt: { ...receipt, nativeSessionId: 'native-conflict' },
    }),
    { status: 'rejected', reason: 'native-session-id-conflict' },
  );

  assert.equal(db.markAgentRunTerminal({
    id: runId,
    status: 'completed',
    result: 'done',
    failureCause: null,
    failureReason: null,
    completedAt: 3,
    continuationAttemptId: 'stale-attempt',
  }), false);
  assert.equal(db.getAgentRunRow(runId)?.status, 'spawning');
  assert.equal(db.markAgentRunTerminal({
    id: runId,
    status: 'completed',
    result: 'done',
    failureCause: null,
    failureReason: null,
    completedAt: 3,
    continuationAttemptId: bound.continuationAttemptId!,
  }), true);
  assert.deepEqual(
    db.confirmAgentRunRuntimeSessionReceipt({ runId, receipt }),
    { status: 'rejected', reason: 'run-inactive' },
  );
  assert.equal(db.updateAgentRunStatus({ id: runId, status: 'running' }), false);
});

test('continuation inherits exact evidence and only current resumed receipt advances it', () => {
  const parent = db.listRecentTerminalAgentRuns(0).find((run) => run.podName === 'builder');
  assert.ok(parent?.nativeSessionId);
  const childId = db.newId() as ULID;
  const child = db.insertAgentRunRow({
    id: childId,
    projectId: parent.projectId,
    dispatcherSessionId: 'dispatcher',
    specialistSnapshot: db.specialistSnapshotForAgentRun(parent)!,
    selection: db.runtimeSelectionForAgentRun(parent)!,
    continuation: { mode: 'resume', nativeSessionId: parent.nativeSessionId },
    continues: parent.id,
    status: 'queued',
    input: 'continue',
    queuedAt: 4,
  });
  assert.equal(child.continuationState, 'resume-pending');
  assert.equal(child.nativeIdentityState, 'bound');
  assert.equal(child.nativeSessionId, parent.nativeSessionId);

  const insertedAttempt = child.continuationAttemptId!;
  const prepared = db.prepareAgentRunResume(childId);
  assert.ok(prepared?.continuationAttemptId);
  assert.notEqual(prepared.continuationAttemptId, insertedAttempt);
  assert.equal(db.updateAgentRunStatus({ id: childId, status: 'spawning' }), true);

  const staleReceipt: RuntimeSessionReceipt = {
    mode: 'resumed',
    continuationAttemptId: insertedAttempt,
    selection,
    nativeSessionId: parent.nativeSessionId,
    requestedNativeSessionId: parent.nativeSessionId,
  };
  assert.deepEqual(
    db.confirmAgentRunRuntimeSessionReceipt({ runId: childId, receipt: staleReceipt }),
    { status: 'rejected', reason: 'continuation-attempt-mismatch' },
  );
  assert.equal(db.failAgentRunRuntimeResume(childId, insertedAttempt), false);

  const receipt: RuntimeSessionReceipt = {
    ...staleReceipt,
    continuationAttemptId: prepared!.continuationAttemptId!,
  };
  assert.deepEqual(
    db.confirmAgentRunRuntimeSessionReceipt({
      runId: childId,
      receipt: {
        ...receipt,
        mode: 'created',
        requestedNativeSessionId: null,
      },
    }),
    { status: 'rejected', reason: 'receipt-mode-mismatch' },
  );
  const confirmation = db.confirmAgentRunRuntimeSessionReceipt({ runId: childId, receipt });
  assert.equal(confirmation.status, 'confirmed');
  assert.equal(db.getAgentRunRow(childId)?.continuationState, 'native-resumed');
  assert.equal(db.failAgentRunRuntimeResume(childId, receipt.continuationAttemptId), false);
});

test('pending-ask persistence reconstructs option objects and strips extra keys', () => {
  const project = db.createProject({
    name: 'Pending ask option boundary',
    slug: `pending-ask-option-${db.newId().toLowerCase()}`,
    folderPath: '',
  });
  const runId = db.newId() as ULID;
  db.insertAgentRunRow({
    id: runId,
    projectId: project.id,
    dispatcherSessionId: 'dispatcher',
    specialistSnapshot: snapshot,
    selection,
    continuation: { mode: 'create' },
    status: 'queued',
    input: 'ask first',
    queuedAt: 10,
  });

  const askId = db.newId() as ULID;
  const expectedOptions = [{ label: 'Approve', value: 'yes' }];
  const created = db.createPendingAsk({
    id: askId,
    agentRunId: runId,
    projectId: project.id,
    kind: 'approval',
    promptBody: 'Proceed?',
    options: [{
      ...expectedOptions[0],
      nativeSessionId: 'must-not-persist',
      providerReceipt: { raw: 'must-not-persist' },
    }] as never,
    now: 11,
  });

  assert.deepEqual(created.options, expectedOptions);
  assert.deepEqual(db.getPendingAsk(askId)?.options, expectedOptions);
  const raw = db.getRawDb()
    .prepare('SELECT options FROM pending_asks WHERE id = ?')
    .get(askId) as { options: string };
  assert.deepEqual(JSON.parse(raw.options), expectedOptions);
  assert.deepEqual(Object.keys(JSON.parse(raw.options)[0]), ['label', 'value']);
});
