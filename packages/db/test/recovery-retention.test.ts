import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { RunLifecycleState, ULID } from '@pc/domain';

const tmpDir = mkdtempSync(join(tmpdir(), 'pc-recovery-retention-'));
process.env.PC_DATA_DIR = tmpDir;
const db = await import('../src/index.ts');

before(() => db.runMigrations());
after(() => {
  db.closeDb();
  rmSync(tmpDir, { recursive: true, force: true });
});

function snapshot() {
  return {
    specialistId: db.newId() as ULID,
    revision: 'sha256:recovery-retention',
    name: 'builder',
    charter: 'Build.',
    contextDocs: [],
    maxTurns: 10,
  };
}

function seed(slug: string) {
  const project = db.createProject({ slug, name: slug, folderPath: join(tmpDir, slug) });
  const runId = db.newId() as ULID;
  const branch = `agent-${slug}`;
  const path = join(tmpDir, `${slug}-worktrees`, branch);
  const contract = db.createContract({
    projectId: project.id,
    agentRunId: runId,
    podName: 'builder',
    expectedOutput: { kind: 'repo' },
    worktreePath: path,
    worktreeBaseBranch: 'main',
    worktreeBaseSha: 'a'.repeat(40),
  });
  db.insertAgentRunRow({
    id: runId,
    projectId: project.id,
    dispatcherSessionId: `session-${slug}`,
    specialistSnapshot: snapshot(),
    selection: { runtimeId: 'runtime', accountId: 'account', model: 'model', effort: { kind: 'none' } },
    continuation: { mode: 'create' },
    status: 'queued',
    input: 'go',
    contractId: contract.id,
    worktreeDir: path,
    worktreeBaseBranch: 'main',
    worktreeBaseSha: 'a'.repeat(40),
    lifecycleState: 'queued',
    queuedAt: 100,
  });
  const worktree = db.upsertWorktree({
    name: branch,
    path,
    projectId: project.id,
    agentRunId: runId,
    contractId: contract.id,
    branch,
    baseBranch: 'main',
    baseSha: 'a'.repeat(40),
  });
  return { project, runId, contract, worktree, branch, path };
}

function driveLifecycle(runId: ULID, states: readonly RunLifecycleState[]): void {
  for (const lifecycleState of states) {
    assert.equal(db.updateAgentRunStatus({ id: runId, status: 'queued', lifecycleState }), true);
  }
}

test('terminal exact owner is retained beyond time until ownership transfers', () => {
  const seeded = seed(`owner-${db.newId().toLowerCase()}`);
  driveLifecycle(seeded.runId, ['provisioning']);
  assert.equal(db.markAgentRunTerminal({
    id: seeded.runId,
    status: 'failed',
    result: null,
    failureCause: 'worktree-provision-failed',
    failureReason: 'readiness failed',
    completedAt: 200,
    lifecycleState: 'provisioning-failed',
  }), true);
  assert.equal(
    db.listPreservedTerminalAgentRuns(seeded.project.id).some((run) => run.id === seeded.runId),
    true,
  );

  const childId = db.newId() as ULID;
  db.insertAgentRunRow({
    id: childId,
    projectId: seeded.project.id,
    dispatcherSessionId: 'replacement',
    specialistSnapshot: snapshot(),
    selection: { runtimeId: 'runtime', accountId: 'account', model: 'model', effort: { kind: 'none' } },
    continuation: { mode: 'create' },
    status: 'queued',
    input: 'replacement',
    contractId: seeded.contract.id,
    worktreeDir: seeded.path,
    worktreeBaseBranch: 'main',
    worktreeBaseSha: 'a'.repeat(40),
    lifecycleState: 'preparing',
    queuedAt: 300,
  });
  assert.ok(db.setContractRun(seeded.contract.id, childId));
  assert.equal(db.getWorktreeById(seeded.worktree.id)?.agentRunId, childId);
  assert.equal(
    db.listPreservedTerminalAgentRuns(seeded.project.id).some((run) => run.id === seeded.runId),
    false,
  );
});

test('positive exact worktree settlement removes cancelled-owner retention', () => {
  const seeded = seed(`settled-${db.newId().toLowerCase()}`);
  assert.equal(db.markAgentRunTerminal({
    id: seeded.runId,
    status: 'cancelled',
    result: null,
    failureCause: 'cancelled',
    failureReason: 'cancelled before runtime',
    completedAt: 200,
    lifecycleState: 'cancelled',
  }), true);
  assert.equal(db.listPreservedTerminalAgentRuns(seeded.project.id).some((r) => r.id === seeded.runId), true);
  assert.equal(db.markExactWorktreeDestroyed({
    id: seeded.worktree.id,
    projectId: seeded.project.id,
    agentRunId: seeded.runId,
    contractId: seeded.contract.id,
    path: seeded.path,
    name: seeded.branch,
    branch: seeded.branch,
    baseBranch: 'main',
    destroyedAt: 300,
  }), true);
  assert.equal(db.listPreservedTerminalAgentRuns(seeded.project.id).some((r) => r.id === seeded.runId), false);
});

test('landed teardown feeder covers active, stranded, and destroyed-row lifecycle crash windows', () => {
  const seeded = seed(`feeder-${db.newId().toLowerCase()}`);
  driveLifecycle(seeded.runId, ['provisioning', 'building', 'verifying', 'merging', 'merged', 'tearing-down']);
  assert.equal(db.markAgentRunTerminal({
    id: seeded.runId,
    status: 'failed',
    result: null,
    failureCause: 'unexpected-exit',
    failureReason: 'crashed after landing receipt',
    completedAt: 200,
  }), true);
  assert.ok(db.setContractLanding(seeded.contract.id, {
    landingStatus: 'landed',
    landedBranch: seeded.branch,
    landedSha: 'b'.repeat(40),
    landedAt: 200,
  }));
  assert.equal(db.listContractsLandedTeardownIncomplete().some((c) => c.id === seeded.contract.id), true);

  db.markWorktreeStranded(seeded.branch, 'no-live-run', 300);
  assert.equal(db.listContractsLandedTeardownIncomplete().some((c) => c.id === seeded.contract.id), true);

  assert.equal(db.markExactWorktreeDestroyed({
    id: seeded.worktree.id,
    projectId: seeded.project.id,
    agentRunId: seeded.runId,
    contractId: seeded.contract.id,
    path: seeded.path,
    name: seeded.branch,
    branch: seeded.branch,
    baseBranch: 'main',
    destroyedAt: 400,
  }), true);
  assert.equal(
    db.listContractsLandedTeardownIncomplete().some((c) => c.id === seeded.contract.id),
    true,
    'destroyed row still feeds the crash window before lifecycle completion',
  );
  assert.equal(db.updateAgentRunStatus({
    id: seeded.runId,
    status: 'failed',
    lifecycleState: 'completed',
  }), true);
  assert.equal(db.listContractsLandedTeardownIncomplete().some((c) => c.id === seeded.contract.id), false);
});
