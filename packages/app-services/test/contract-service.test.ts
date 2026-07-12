// ContractService announces a `contract.changed` resource fact (entity
// 'contract', eventType 'contract.changed') for each mutation, atomically with
// the repo write. Uses a real temp DB + a recording insertLiveEvent stub.

import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type {
  ULID as DomainULID,
  WorktreeAbandonmentReceipt,
  WorktreeAbandonmentTeardownReceipt,
} from '@pc/domain';

const tmpDir = mkdtempSync(join(tmpdir(), 'pc-contract-service-'));
process.env.PC_DATA_DIR = tmpDir;

const db = await import('@pc/db');
const { ContractService } = await import('../src/contracts/index.ts');
const { isContractChangedLivePayload } = await import('@pc/contracts');

import type { InsertLiveEventDraft, LiveOutboxEvent } from '@pc/db';

before(() => db.runMigrations());
after(() => {
  db.closeDb();
  rmSync(tmpDir, { recursive: true, force: true });
});

const stages = [{ id: 'todo', name: 'Todo', order: 0 }];

function makeService() {
  const drafts: InsertLiveEventDraft[] = [];
  const recordingInsert = (<TPayload>(
    tx: Parameters<typeof db.insertLiveEvent>[0],
    draft: InsertLiveEventDraft<TPayload>,
  ): LiveOutboxEvent<TPayload> => {
    drafts.push(draft as InsertLiveEventDraft);
    return db.insertLiveEvent(tx, draft);
  }) as typeof db.insertLiveEvent;
  const service = new ContractService({ insertLiveEvent: recordingInsert });
  return { service, drafts };
}

function seedProject(slug: string) {
  return db.createProject({ slug, name: slug, stages, folderPath: '' });
}

function seedAbandonment(service: InstanceType<typeof ContractService>, slug: string) {
  const project = seedProject(slug);
  const producerRunId = db.newId() as DomainULID;
  const worktreePath = join(tmpDir, slug);
  const branch = `agent-${slug}`;
  const contract = service.create({
    projectId: project.id,
    agentRunId: producerRunId,
    podName: 'code-writer',
    expectedOutput: { kind: 'repo', auto_land: false },
    worktreePath,
    worktreeBaseBranch: 'main',
    worktreeBaseSha: 'b'.repeat(40),
  });
  const worktree = db.upsertWorktree({
    name: branch,
    path: worktreePath,
    projectId: project.id,
    agentRunId: producerRunId,
    contractId: contract.id as DomainULID,
    branch,
    baseBranch: 'main',
    baseSha: 'b'.repeat(40),
  });
  const receipt: WorktreeAbandonmentReceipt = {
    protocol: 'worktree-abandonment-v1',
    requestId: '123e4567-e89b-42d3-a456-426614174000',
    approvedBy: 'user',
    approvalSurface: 'browser',
    approvalReason: 'explicit-browser-confirmation',
    approvedAt: 100,
    reason: 'User approved cleanup.',
    approvedContractVersion: contract.version,
    projectId: project.id,
    contractId: contract.id as DomainULID,
    producerRunId,
    worktreeId: worktree.id,
    worktreeStatus: 'active',
    repositoryIdentity: {
      protocol: 'git-common-dir-v1',
      gitCommonDir: 'E:/repo/.git',
      leaseKey: `sha256:${'a'.repeat(64)}`,
    },
    worktreePath,
    branch,
    branchTip: 'c'.repeat(40),
    baseBranch: 'main',
    validatedBaseSha: 'b'.repeat(40),
    targetTip: 'b'.repeat(40),
    integrationState: 'unmerged',
    worktreeState: {
      directory: 'present', registration: 'registered', status: 'clean',
      staged: 0, unstaged: 0, untracked: 0,
      worktreeStateDigest: `sha256:${'d'.repeat(64)}`,
      changedPaths: [], ignoredContents: 'uninspected',
    },
    previewDigest: `sha256:${'e'.repeat(64)}`,
  };
  return { project, contract, worktree, producerRunId, receipt };
}

function teardown(authority: WorktreeAbandonmentReceipt): WorktreeAbandonmentTeardownReceipt {
  return {
    protocol: 'worktree-abandonment-teardown-v1',
    authorityRequestId: authority.requestId,
    startedAt: 200,
    finishedAt: 300,
    repositoryIdentity: authority.repositoryIdentity,
    worktreePath: authority.worktreePath,
    branch: authority.branch,
    approvedBranchTip: authority.branchTip,
    observedBranchTip: authority.branchTip,
    directoryAbsent: true,
    registrationAbsent: true,
    branchPreserved: true,
  };
}

test('create emits exactly one contract.changed (created) fact', () => {
  const p = seedProject('svc-create');
  const { service, drafts } = makeService();
  const c = service.create({
    projectId: p.id,
    podName: 'researcher',
    expectedOutput: { kind: 'answer', min_chars: 10 },
    acceptanceCriteria: [{ kind: 'report_contains', pattern: 'done' }],
    verificationTier: 'auto',
  });
  assert.equal(drafts.length, 1);
  assert.equal(drafts[0]!.type, 'contract.changed');
  assert.equal(drafts[0]!.entity, 'contract');
  assert.equal(drafts[0]!.scope, 'project');
  assert.equal(drafts[0]!.entityId, c.id);
  assert.equal(drafts[0]!.version, c.version);
  assert.equal((drafts[0]!.payload as { reason: string }).reason, 'created');
  assert.equal(c.status, 'issued');
});

test('setDeliverable emits a deliverable-set fact carrying the new version', () => {
  const p = seedProject('svc-deliverable');
  const { service, drafts } = makeService();
  const c = service.create({ projectId: p.id, podName: 'writer' });
  drafts.length = 0;
  const updated = service.setDeliverable({
    id: c.id,
    deliverable: { kind: 'prose', text: '## Goals' },
    report: 'wrote it',
  });
  assert.ok(updated);
  assert.equal(drafts.length, 1);
  assert.equal((drafts[0]!.payload as { reason: string }).reason, 'deliverable-set');
  assert.equal(drafts[0]!.version, updated!.version);
  assert.deepEqual(updated!.deliverable, { kind: 'prose', text: '## Goals' });
  assert.equal(updated!.report, 'wrote it');
  assert.equal(updated!.status, 'submitted');
});

test('setVerification emits a verification-set fact + flips status', () => {
  const p = seedProject('svc-verify');
  const { service, drafts } = makeService();
  const c = service.create({ projectId: p.id, verificationTier: 'auto' });
  drafts.length = 0;
  const updated = service.setVerification({ id: c.id, verificationStatus: 'passed' });
  assert.ok(updated);
  assert.equal(drafts.length, 1);
  assert.equal((drafts[0]!.payload as { reason: string }).reason, 'verification-set');
  assert.equal(updated!.verificationStatus, 'passed');
  assert.equal(updated!.status, 'accepted');
});

test('the durable outbox row deserializes into a valid contract payload', () => {
  const p = seedProject('svc-durable');
  const { service } = makeService();
  const highWater = db.getLiveEventHighWater();
  service.create({ projectId: p.id, podName: 'x' });
  const replay = db.listLiveEventsAfter({ after: highWater ?? '0', projectId: p.id });
  const evt = replay.events.find((e) => e.type === 'contract.changed');
  assert.ok(evt);
  assert.equal(isContractChangedLivePayload(evt!.payload), true);
});

test('many contracts in one project — all announced, listByProject resolves', () => {
  const p = seedProject('svc-many');
  const { service, drafts } = makeService();
  const a = service.create({ projectId: p.id, pmRef: 'PM-1', podName: 'a' });
  const b = service.create({ projectId: p.id, pmRef: 'PM-1', podName: 'b' });
  assert.equal(drafts.length, 2);
  const list = service.listByProject(p.id).map((c) => c.id);
  assert.ok(list.includes(a.id));
  assert.ok(list.includes(b.id));
});

test('setRun links a run + announces dispatched; listByRun resolves', () => {
  const p = seedProject('svc-run');
  const { service, drafts } = makeService();
  const c = service.create({ projectId: p.id, podName: 'x' });
  drafts.length = 0;
  const runId = db.newId();
  const linked = service.setRun(c.id, runId);
  assert.ok(linked);
  assert.equal(linked!.agentRunId, runId);
  assert.equal(linked!.status, 'dispatched');
  assert.equal((drafts[0]!.payload as { reason: string }).reason, 'dispatched');
  assert.deepEqual(service.listByRun(runId).map((x) => x.id), [c.id]);
});

test('a mutation on a missing contract emits NOTHING (returns null)', () => {
  const p = seedProject('svc-missing');
  const { service, drafts } = makeService();
  void p;
  const out = service.setDeliverable({ id: 'no-such', deliverable: null });
  assert.equal(out, null);
  assert.equal(drafts.length, 0);
});

test('abandonment authority, retry error, and settlement publish exact durable facts', () => {
  const { service, drafts } = makeService();
  const { project, contract, worktree, producerRunId, receipt } =
    seedAbandonment(service, 'svc-abandon');
  drafts.length = 0;

  const authorized = service.authorizeAbandonment({ id: contract.id, receipt });
  assert.ok(authorized);
  assert.equal(authorized.landingStatus, 'abandoning');
  assert.deepEqual(authorized.abandonmentReceipt, receipt);
  assert.equal(drafts.length, 1);
  assert.equal((drafts[0]!.payload as { reason: string }).reason, 'abandonment-authorized');
  assert.equal(drafts[0]!.version, authorized.version);

  const errored = service.setAbandonmentError({
    id: contract.id,
    expectedVersion: authorized.version,
    authorityRequestId: receipt.requestId,
    error: 'git worktree remove failed',
  });
  assert.ok(errored);
  assert.equal(errored.abandonmentError, 'git worktree remove failed');
  assert.equal((drafts[1]!.payload as { reason: string }).reason, 'abandonment-error');

  const settlement = teardown(receipt);
  assert.equal(db.markExactWorktreeDestroyed({
    id: worktree.id,
    projectId: project.id,
    agentRunId: producerRunId,
    contractId: contract.id as DomainULID,
    path: worktree.path,
    name: worktree.name,
    branch: worktree.branch!,
    baseBranch: worktree.baseBranch!,
    destroyedAt: settlement.finishedAt,
  }), true);
  const settled = service.settleAbandonment({
    id: contract.id,
    expectedVersion: errored.version,
    receipt: settlement,
  });
  assert.ok(settled);
  assert.equal(settled.landingStatus, 'abandoned');
  assert.deepEqual(settled.abandonmentTeardownReceipt, settlement);
  assert.equal(settled.abandonmentError, null);
  assert.equal((drafts[2]!.payload as { reason: string }).reason, 'abandonment-settled');
  assert.equal(drafts[2]!.version, settled.version);
});

test('abandonment authority rolls back when its outbox fact cannot commit', () => {
  const { service } = makeService();
  const { contract, receipt } = seedAbandonment(service, 'svc-abandon-rollback');
  const failing = new ContractService({
    insertLiveEvent: (() => {
      throw new Error('outbox unavailable');
    }) as typeof db.insertLiveEvent,
  });

  assert.throws(
    () => failing.authorizeAbandonment({ id: contract.id, receipt }),
    /outbox unavailable/,
  );
  const persisted = db.getContract(contract.id as DomainULID);
  assert.equal(persisted?.landingStatus, null);
  assert.equal(persisted?.abandonmentReceipt, null);
  assert.equal(persisted?.version, contract.version);
});
