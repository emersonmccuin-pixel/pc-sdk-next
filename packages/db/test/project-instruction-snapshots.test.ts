import { createHash } from 'node:crypto';
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ProjectInstructionSnapshot } from '@pc/domain';

const tmpDir = mkdtempSync(join(tmpdir(), 'pc-project-instruction-db-'));
process.env.PC_DATA_DIR = tmpDir;

const db = await import('../src/index.ts');

before(() => db.runMigrations());
after(() => {
  db.closeDb();
  rmSync(tmpDir, { recursive: true, force: true });
});

function snapshot(content: string): ProjectInstructionSnapshot {
  return {
    state: 'loaded',
    source: 'AGENTS.md',
    content,
    revision: `sha256:${createHash('sha256').update(content, 'utf8').digest('hex')}`,
  };
}

function selection() {
  return {
    runtimeId: 'runtime-a',
    accountId: 'account-a',
    model: 'model-a',
    effort: { kind: 'none' as const },
  };
}

test('orchestrator sessions bind one immutable project instruction snapshot', () => {
  const project = db.createProject({
    name: 'Instruction session',
    slug: `instruction-session-${db.newId().toLowerCase()}`,
    folderPath: '',
  });
  const session = db.createOrchestratorSession({ projectId: project.id, selection: selection() });
  const first = snapshot('first session rules');
  const changed = snapshot('changed session rules');

  assert.deepEqual(db.bindOrGetOrchestratorProjectInstructionSnapshot(session.id, first), first);
  assert.deepEqual(db.bindOrGetOrchestratorProjectInstructionSnapshot(session.id, changed), first);
  assert.deepEqual(db.getOrchestratorSession(session.id)?.projectInstructionSnapshot, first);
  assert.throws(
    () => db.getRawDb().prepare(
      'UPDATE orchestrator_sessions SET project_instruction_snapshot = ? WHERE id = ?',
    ).run(JSON.stringify(changed), session.id),
    /project instruction snapshot is immutable/,
  );

  db.endOrchestratorSession(session.id, 'user_ended');
  const nextSession = db.createOrchestratorSession({ projectId: project.id, selection: selection() });
  assert.deepEqual(
    db.bindOrGetOrchestratorProjectInstructionSnapshot(nextSession.id, changed),
    changed,
  );
});

test('agent runs bind one immutable project instruction snapshot', () => {
  const project = db.createProject({
    name: 'Instruction run',
    slug: `instruction-run-${db.newId().toLowerCase()}`,
    folderPath: '',
  });
  const specialistId = db.newId();
  const run = db.insertAgentRunRow({
    id: db.newId(),
    projectId: project.id,
    dispatcherSessionId: db.newId(),
    specialistSnapshot: {
      specialistId,
      revision: `sha256:${'1'.repeat(64)}`,
      name: 'instruction-reader',
      charter: 'Use the project instructions.',
      contextDocs: [],
      maxTurns: 10,
    },
    selection: selection(),
    continuation: { mode: 'create' },
    status: 'queued',
    input: 'test',
    queuedAt: 1,
  });
  const first = snapshot('first run rules');
  const changed = snapshot('changed run rules');

  assert.deepEqual(db.bindOrGetAgentRunProjectInstructionSnapshot(run.id, first), first);
  assert.deepEqual(db.bindOrGetAgentRunProjectInstructionSnapshot(run.id, changed), first);
  assert.deepEqual(db.getAgentRunRow(run.id)?.projectInstructionSnapshot, first);
  assert.throws(
    () => db.getRawDb().prepare(
      'UPDATE agent_runs SET project_instruction_snapshot = ? WHERE id = ?',
    ).run(JSON.stringify(changed), run.id),
    /project instruction snapshot is immutable/,
  );

  const prepared = db.prepareAgentRunCreate(run.id);
  assert.ok(prepared?.continuationAttemptId);
  assert.equal(db.updateAgentRunStatus({ id: run.id, status: 'spawning', spawnedAt: 2 }), true);
  assert.equal(db.confirmAgentRunRuntimeSessionReceipt({
    runId: run.id,
    receipt: {
      mode: 'created',
      selection: selection(),
      continuationAttemptId: prepared.continuationAttemptId,
      nativeSessionId: 'native-parent-session',
      requestedNativeSessionId: null,
    },
  }).status, 'confirmed');
  assert.equal(db.markAgentRunTerminal({
    id: run.id,
    status: 'completed',
    result: 'done',
    failureCause: null,
    failureReason: null,
    completedAt: 3,
    continuationAttemptId: prepared.continuationAttemptId,
  }), true);

  const continuation = db.insertAgentRunRow({
    id: db.newId(),
    projectId: project.id,
    dispatcherSessionId: db.newId(),
    specialistSnapshot: run.specialistSnapshot,
    selection: selection(),
    continuation: { mode: 'resume', nativeSessionId: 'native-parent-session' },
    continues: run.id,
    status: 'queued',
    input: 'continue',
    queuedAt: 2,
  });
  assert.deepEqual(
    db.bindOrGetAgentRunProjectInstructionSnapshot(continuation.id, changed),
    first,
  );
});
