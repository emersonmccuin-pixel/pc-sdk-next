import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { RuntimeSelection, RuntimeSessionReceipt } from '@pc/contracts';
import type { SpecialistExecutionSnapshot, ULID, WorktreeGitReceipt } from '@pc/domain';

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

const gitReceipt: WorktreeGitReceipt = {
  worktreePath: 'E:/repo-worktrees/agent-receipt',
  branch: 'agent-receipt',
  baseBranch: 'main',
  baseSha: 'a'.repeat(40),
  cleanStatus: true,
  repositoryIdentity: {
    protocol: 'git-common-dir-v1',
    gitCommonDir: 'E:/repo/.git',
    leaseKey: `sha256:${'b'.repeat(64)}`,
  },
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

test('project repository identity binds once and cannot be malformed, retargeted, or cleared', () => {
  const project = db.createProject({
    name: 'Repository binding',
    slug: 'repository-binding',
    folderPath: 'E:/repo',
  });
  assert.equal(project.repositoryIdentity, null);
  assert.throws(
    () => db.getRawDb().prepare('UPDATE projects SET repository_identity = ? WHERE id = ?')
      .run(JSON.stringify({ protocol: 'git-common-dir-v1' }), project.id),
    /requires an exact receipt/,
  );

  const identity = gitReceipt.repositoryIdentity;
  assert.deepEqual(db.bindProjectRepositoryIdentity(project.id, identity)?.repositoryIdentity, identity);
  assert.deepEqual(db.bindProjectRepositoryIdentity(project.id, identity)?.repositoryIdentity, identity);
  const other = {
    ...identity,
    gitCommonDir: 'E:/other/.git',
    leaseKey: `sha256:${'c'.repeat(64)}`,
  };
  assert.throws(
    () => db.bindProjectRepositoryIdentity(project.id, other),
    /already bound to a different repository/,
  );
  assert.throws(
    () => db.getRawDb().prepare('UPDATE projects SET repository_identity = ? WHERE id = ?')
      .run(JSON.stringify(other), project.id),
    /repository identity is immutable/,
  );
  assert.throws(
    () => db.getRawDb().prepare('UPDATE projects SET repository_identity = NULL WHERE id = ?')
      .run(project.id),
    /repository identity is immutable/,
  );
});

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
    worktreeDir: gitReceipt.worktreePath,
    worktreeBaseBranch: gitReceipt.baseBranch,
    worktreeBaseSha: gitReceipt.baseSha,
    gitReceipt,
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
  assert.throws(
    () => db.getRawDb().prepare("UPDATE agent_runs SET git_receipt = NULL WHERE id = ?").run(runId),
    /repository identity receipt is immutable/,
  );
  assert.throws(
    () => db.insertAgentRunRow({
      id: db.newId() as ULID,
      projectId: project.id,
      dispatcherSessionId: 'dispatcher',
      specialistSnapshot: snapshot,
      selection,
      continuation: { mode: 'create' },
      status: 'queued',
      input: 'invalid receipt',
      worktreeDir: 'E:/repo-worktrees/agent-invalid',
      worktreeBaseBranch: 'main',
      worktreeBaseSha: gitReceipt.baseSha,
      gitReceipt: {
        ...gitReceipt,
        worktreePath: 'E:/repo-worktrees/agent-invalid',
        branch: 'agent-invalid',
        repositoryIdentity: {
          ...gitReceipt.repositoryIdentity,
          leaseKey: `sha256:${'B'.repeat(64)}`,
        },
      } as never,
      queuedAt: 1,
    }),
    /complete repository identity/,
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
  assert.deepEqual(parent.gitReceipt, gitReceipt);
  assert.throws(
    () => db.insertAgentRunRow({
      id: db.newId() as ULID,
      projectId: parent.projectId,
      dispatcherSessionId: 'dispatcher',
      specialistSnapshot: db.specialistSnapshotForAgentRun(parent)!,
      selection: db.runtimeSelectionForAgentRun(parent)!,
      continuation: { mode: 'resume', nativeSessionId: parent.nativeSessionId! },
      continues: parent.id,
      status: 'queued',
      input: 'forged continuation',
      worktreeDir: parent.worktreeDir,
      worktreeBaseBranch: parent.worktreeBaseBranch,
      worktreeBaseSha: parent.worktreeBaseSha,
      gitReceipt: {
        ...gitReceipt,
        repositoryIdentity: {
          ...gitReceipt.repositoryIdentity,
          leaseKey: `sha256:${'c'.repeat(64)}`,
        },
      },
      queuedAt: 4,
    }),
    /continuation must inherit exact repository identity receipt/,
  );
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
    worktreeDir: parent.worktreeDir,
    worktreeBaseBranch: parent.worktreeBaseBranch,
    worktreeBaseSha: parent.worktreeBaseSha,
    gitReceipt: parent.gitReceipt,
    queuedAt: 4,
  });
  assert.equal(child.continuationState, 'resume-pending');
  assert.equal(child.nativeIdentityState, 'bound');
  assert.equal(child.nativeSessionId, parent.nativeSessionId);
  assert.deepEqual(child.gitReceipt, parent.gitReceipt);

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
