import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  createNotRequiredWorktreePhaseReceipt,
  createReviewCheckoutPhaseReceipt,
  reviewCheckoutPhaseMatchesRun,
  type ReviewCheckoutAuthority,
  type ReviewCheckoutGitReceipt,
  type ReviewCheckoutPhaseReceipt,
  type ReviewCheckoutProvisionReceipt,
  type ReviewCheckoutTeardownReceipt,
  type ReviewCheckoutVerdictReceipt,
  type ULID,
  type WorktreePhaseReceipt,
} from '@pc/domain';

const tmpDir = mkdtempSync(join(tmpdir(), 'pc-review-checkout-guards-'));
process.env.PC_DATA_DIR = tmpDir;
const db = await import('../src/index.ts');
const { getDb } = await import('../src/connection.ts');

before(() => db.runMigrations());
after(() => {
  db.closeDb();
  rmSync(tmpDir, { recursive: true, force: true });
});

const sealedCommit = 'a'.repeat(40);
const identity = {
  protocol: 'git-common-dir-v1' as const,
  gitCommonDir: 'E:/repo/.git',
  leaseKey: `sha256:${'b'.repeat(64)}`,
};

function persistReviewPhase(input: {
  authority: ReviewCheckoutAuthority;
  expectedUpdatedAt: number;
  receipt: ReviewCheckoutPhaseReceipt;
}) {
  return getDb().transaction((tx) => {
    const run = db.setReviewAgentRunPhaseReceiptInDb(
      input.authority.reviewerRunId,
      input.receipt,
      tx,
    );
    if (!run) return null;
    const checkout = db.setReviewCheckoutPhaseReceiptInDb(input, tx);
    if (!checkout) throw new Error('review checkout phase CAS failed after reviewer phase write');
    return checkout;
  });
}

function snapshot(name: string) {
  return {
    specialistId: db.newId() as ULID,
    revision: `sha256:${name}`,
    name,
    charter: `${name} charter`,
    contextDocs: [],
    maxTurns: 10,
  };
}

function runInput(input: {
  id: ULID;
  projectId: ULID;
  name: string;
  contractId: ULID | null;
  worktreeDir?: string | null;
  worktreeBaseBranch?: string | null;
  worktreeBaseSha?: string | null;
  gitReceipt?: ReviewCheckoutGitReceipt | null;
}) {
  return {
    id: input.id,
    projectId: input.projectId,
    dispatcherSessionId: `dispatch-${input.name}`,
    specialistSnapshot: snapshot(input.name),
    selection: {
      runtimeId: 'runtime', accountId: 'account', model: 'model',
      effort: { kind: 'none' as const },
    },
    continuation: { mode: 'create' as const },
    status: 'queued' as const,
    input: input.name,
    contractId: input.contractId,
    worktreeDir: input.worktreeDir ?? null,
    worktreeBaseBranch: input.worktreeBaseBranch ?? null,
    worktreeBaseSha: input.worktreeBaseSha ?? null,
    gitReceipt: input.gitReceipt ?? null,
    queuedAt: Date.now(),
  };
}

function completeQueuedRun(id: ULID, result: string, completedAt: number): void {
  const prepared = db.prepareAgentRunCreate(id);
  assert.ok(prepared?.continuationAttemptId);
  assert.equal(db.updateAgentRunStatus({ id, status: 'spawning', spawnedAt: completedAt - 1 }), true);
  const current = db.getAgentRunRow(id)!;
  const selection = db.runtimeSelectionForAgentRun(current);
  assert.ok(selection);
  assert.equal(db.confirmAgentRunRuntimeSessionReceipt({
    runId: id,
    receipt: {
      mode: 'created',
      selection,
      continuationAttemptId: prepared.continuationAttemptId,
      nativeSessionId: `native-${id}`,
      requestedNativeSessionId: null,
    },
  }).status, 'confirmed');
  assert.equal(db.markAgentRunTerminal({
    id,
    status: 'completed',
    result,
    failureCause: null,
    failureReason: null,
    completedAt,
  }), true);
}

function provision(
  authority: ReviewCheckoutAuthority,
  observedAt: number,
): ReviewCheckoutProvisionReceipt {
  return {
    protocol: 'review-checkout-provision-v1',
    ...authority,
    registrationCount: 1,
    registrationPath: authority.worktreePath,
    headSha: authority.sealedCommit,
    detachedHead: true,
    trackedChanges: 0,
    stagedChanges: 0,
    observedAt,
  };
}

function gitReceipt(
  authority: ReviewCheckoutAuthority,
  observedAt: number,
): ReviewCheckoutGitReceipt {
  return {
    protocol: 'review-checkout-git-v1',
    ...authority,
    branch: '(detached)',
    baseBranch: '(detached)',
    baseSha: authority.sealedCommit,
    cleanStatus: true,
    registrationCount: 1,
    registrationPath: authority.worktreePath,
    headSha: authority.sealedCommit,
    detachedHead: true,
    trackedChanges: 0,
    stagedChanges: 0,
    observedAt,
  };
}

function teardown(
  authority: ReviewCheckoutAuthority,
  startedAt: number,
): ReviewCheckoutTeardownReceipt {
  return {
    protocol: 'review-checkout-teardown-v1',
    ...authority,
    startedAt,
    finishedAt: startedAt + 1,
    directoryAbsent: true,
    registrationAbsent: true,
    branchDeletion: 'not-applicable-detached',
  };
}

interface Harness {
  authority: ReviewCheckoutAuthority;
  reviewerContractId: ULID;
  provisionedUpdatedAt: number;
}

function harness(label: string): Harness {
  const project = db.createProject({
    slug: `${label}-${db.newId().toLowerCase()}`,
    name: label,
    folderPath: join(tmpDir, label),
  });
  const producerRunId = db.newId() as ULID;
  const target = db.createContract({
    projectId: project.id,
    agentRunId: producerRunId,
    expectedOutput: { kind: 'repo', review: 'full' },
    landingPolicy: 'full-review',
  });
  db.insertAgentRunRow(runInput({
    id: producerRunId,
    projectId: project.id,
    name: `${label}-producer`,
    contractId: target.id,
  }));
  completeQueuedRun(producerRunId, 'produced', Date.now());
  assert.equal(db.updateAgentRunStatus({
    id: producerRunId,
    status: 'completed',
    lifecycleState: 'reviewing',
  }), true);

  assert.ok(db.setContractDeliverable(target.id, {
    deliverable: { kind: 'repo', branch: 'feature', commit: sealedCommit },
  }));
  const verified = db.setContractVerification(target.id, { verificationStatus: 'passed' });
  assert.ok(verified);

  const reviewerRunId = db.newId() as ULID;
  const reserved = db.reserveContractReview(target.id, {
    expectedVersion: verified.version,
    expectedReviewRunId: null,
    expectedAgentRunId: producerRunId,
    reviewRound: 1,
    reviewRunId: reviewerRunId,
    reviewSealedCommit: sealedCommit,
  });
  assert.ok(reserved);
  const authority: ReviewCheckoutAuthority = {
    id: db.newId() as ULID,
    projectId: project.id,
    contractId: target.id,
    contractVersion: reserved.version,
    producerRunId,
    reviewerRunId,
    repositoryIdentity: identity,
    worktreePath: join(tmpDir, 'reviews', reviewerRunId),
    ownedRootRealPath: join(tmpDir, 'reviews'),
    sealedCommit,
  };
  const created = db.createReviewCheckoutReservation({ ...authority, createdAt: 100 });
  assert.ok(created);
  const provisioned = db.setReviewCheckoutProvisionReceipt({
    authority,
    expectedUpdatedAt: created.updatedAt,
    receipt: provision(authority, 110),
  });
  assert.ok(provisioned);

  const reviewerContract = db.createContract({
    projectId: project.id,
    expectedOutput: {
      kind: 'payload', semantic: 'verdict',
      schema: {
        type: 'object',
        properties: { verdict: { type: 'string' }, findings: { type: 'array' } },
        required: ['verdict', 'findings'],
      },
    },
  });
  db.insertAgentRunRow(runInput({
    id: reviewerRunId,
    projectId: project.id,
    name: `${label}-reviewer`,
    contractId: reviewerContract.id,
    worktreeDir: authority.worktreePath,
    worktreeBaseBranch: '(detached)',
    worktreeBaseSha: authority.sealedCommit,
    gitReceipt: gitReceipt(authority, 110),
  }));
  return {
    authority,
    reviewerContractId: reviewerContract.id,
    provisionedUpdatedAt: provisioned.updatedAt,
  };
}

function noCommands(
  phase: 'preparation' | 'readiness',
  finishedAt: number,
): WorktreePhaseReceipt {
  return createNotRequiredWorktreePhaseReceipt({
    phase,
    reason: 'no-commands-configured',
    finishedAt,
  });
}

function unpersistedAuthority(label: string): ReviewCheckoutAuthority {
  const project = db.createProject({
    slug: `${label}-${db.newId().toLowerCase()}`,
    name: label,
    folderPath: join(tmpDir, label),
  });
  const producerRunId = db.newId() as ULID;
  const target = db.createContract({
    projectId: project.id,
    agentRunId: producerRunId,
    expectedOutput: { kind: 'repo', review: 'full' },
    landingPolicy: 'full-review',
  });
  assert.ok(db.setContractDeliverable(target.id, {
    deliverable: { kind: 'repo', branch: 'feature', commit: sealedCommit },
  }));
  const verified = db.setContractVerification(target.id, { verificationStatus: 'passed' });
  assert.ok(verified);
  const reviewerRunId = db.newId() as ULID;
  const reserved = db.reserveContractReview(target.id, {
    expectedVersion: verified.version,
    expectedReviewRunId: null,
    expectedAgentRunId: producerRunId,
    reviewRound: 1,
    reviewRunId: reviewerRunId,
    reviewSealedCommit: sealedCommit,
  });
  assert.ok(reserved);
  return {
    id: db.newId() as ULID,
    projectId: project.id,
    contractId: target.id,
    contractVersion: reserved.version,
    producerRunId,
    reviewerRunId,
    repositoryIdentity: identity,
    worktreePath: join(tmpDir, 'reviews', reviewerRunId),
    ownedRootRealPath: join(tmpDir, 'reviews'),
    sealedCommit,
  };
}

function rawInsertReservation(input: {
  authority: ReviewCheckoutAuthority;
  repositoryIdentity?: unknown;
  worktreePath?: string;
  ownedRootRealPath?: string;
}): void {
  const authority = input.authority;
  db.getRawDb().prepare(`
    INSERT INTO review_checkouts (
      id, project_id, contract_id, contract_version, producer_run_id,
      reviewer_run_id, repository_identity, worktree_path,
      owned_root_real_path, sealed_commit, status, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'reserved', 100, 100)
  `).run(
    authority.id,
    authority.projectId,
    authority.contractId,
    authority.contractVersion,
    authority.producerRunId,
    authority.reviewerRunId,
    JSON.stringify(input.repositoryIdentity ?? authority.repositoryIdentity),
    input.worktreePath ?? authority.worktreePath,
    input.ownedRootRealPath ?? authority.ownedRootRealPath,
    authority.sealedCommit,
  );
}

test('raw reservation authority rejects open identity and Unicode-padded paths', () => {
  const authority = unpersistedAuthority('raw-reservation-shape');
  for (const hostile of [
    {
      authority,
      repositoryIdentity: { ...authority.repositoryIdentity, providerSessionId: 'native-leak' },
    },
    {
      authority,
      repositoryIdentity: {
        ...authority.repositoryIdentity,
        gitCommonDir: `${authority.repositoryIdentity.gitCommonDir}\u2003`,
      },
    },
    { authority, worktreePath: `\u2003${authority.worktreePath}` },
    { authority, ownedRootRealPath: `${authority.ownedRootRealPath}\u00a0` },
  ]) {
    assert.throws(
      () => rawInsertReservation(hostile),
      /invalid review checkout reservation authority/,
    );
  }
  assert.equal(db.getReviewCheckoutById(authority.id), null);
  assert.ok(db.createReviewCheckoutReservation({ ...authority, createdAt: 100 }));
});

test('raw provision and teardown receipts reject open shapes and unsafe timestamps', () => {
  const authority = unpersistedAuthority('raw-provision-teardown-shape');
  const created = db.createReviewCheckoutReservation({ ...authority, createdAt: 100 });
  assert.ok(created);
  const raw = db.getRawDb();
  const canonicalProvision = provision(authority, 110);
  const unsafeInteger = Number.MAX_SAFE_INTEGER + 1;
  for (const hostile of [
    { ...canonicalProvision, providerReceipt: 'native-leak' },
    {
      ...canonicalProvision,
      repositoryIdentity: {
        ...canonicalProvision.repositoryIdentity,
        providerSessionId: 'native-leak',
      },
    },
    { ...canonicalProvision, observedAt: unsafeInteger },
  ]) {
    assert.throws(
      () => raw.prepare(`
        UPDATE review_checkouts
        SET status = 'provisioned', provision_receipt = ?
        WHERE id = ?
      `).run(JSON.stringify(hostile), authority.id),
      /invalid review checkout provision receipt/,
    );
  }
  assert.equal(db.getReviewCheckoutById(authority.id)?.status, 'reserved');
  assert.equal(db.getReviewCheckoutById(authority.id)?.provisionReceipt, null);

  const provisioned = db.setReviewCheckoutProvisionReceipt({
    authority,
    expectedUpdatedAt: created.updatedAt,
    receipt: canonicalProvision,
  });
  assert.ok(provisioned);
  const pending = db.markReviewCheckoutTeardownPending({
    authority,
    expectedUpdatedAt: provisioned.updatedAt,
    fromStatus: 'provisioned',
    at: 120,
    error: null,
  });
  assert.ok(pending);
  const canonicalTeardown = teardown(authority, 130);
  for (const hostile of [
    { ...canonicalTeardown, providerReceipt: 'native-leak' },
    {
      ...canonicalTeardown,
      repositoryIdentity: {
        ...canonicalTeardown.repositoryIdentity,
        providerSessionId: 'native-leak',
      },
    },
    { ...canonicalTeardown, startedAt: unsafeInteger, finishedAt: unsafeInteger },
    { ...canonicalTeardown, finishedAt: unsafeInteger },
  ]) {
    assert.throws(
      () => raw.prepare(`
        UPDATE review_checkouts
        SET status = 'destroyed', teardown_receipt = ?, destroyed_at = 140
        WHERE id = ?
      `).run(JSON.stringify(hostile), authority.id),
      /invalid review checkout teardown receipt/,
    );
  }
  assert.equal(db.getReviewCheckoutById(authority.id)?.status, 'teardown-pending');
  assert.equal(db.getReviewCheckoutById(authority.id)?.teardownReceipt, null);
  const destroyed = db.settleReviewCheckoutTeardown({
    authority,
    expectedUpdatedAt: pending.updatedAt,
    receipt: canonicalTeardown,
    destroyedAt: 140,
  });
  assert.ok(destroyed);
  assert.deepEqual(destroyed.provisionReceipt, canonicalProvision);
  assert.deepEqual(destroyed.teardownReceipt, canonicalTeardown);
});

test('raw checkout-bound phase rejects open identity, unsafe step numbers, and Unicode padding', () => {
  const h = harness('raw-phase-hardening');
  const raw = db.getRawDb();
  const executed: WorktreePhaseReceipt = {
    phase: 'preparation',
    outcome: 'executed',
    ok: true,
    steps: [{
      command: 'pnpm test',
      exitCode: 0,
      durationMs: 10,
      stdoutTail: '',
      stderrTail: '',
      timedOut: false,
    }],
    finishedAt: 130,
  };
  const canonical = createReviewCheckoutPhaseReceipt(h.authority, executed);
  const unsafeInteger = Number.MAX_SAFE_INTEGER + 1;
  const hostileReceipts = [
    {
      ...canonical,
      repositoryIdentity: {
        ...canonical.repositoryIdentity,
        providerSessionId: 'native-leak',
      },
    },
    {
      ...canonical,
      evidence: {
        ...executed,
        steps: [{ ...executed.steps[0]!, exitCode: unsafeInteger }],
      },
    },
    {
      ...canonical,
      evidence: {
        ...executed,
        steps: [{ ...executed.steps[0]!, durationMs: unsafeInteger }],
      },
    },
    {
      ...canonical,
      evidence: {
        ...executed,
        steps: [{ ...executed.steps[0]!, command: '\u2003pnpm test\u2003' }],
      },
    },
  ];
  for (const hostile of hostileReceipts) {
    assert.equal(raw.prepare(
      'UPDATE agent_runs SET preparation_receipt = ? WHERE id = ?',
    ).run(JSON.stringify(hostile.evidence), h.authority.reviewerRunId).changes, 1);
    assert.throws(
      () => raw.prepare(
        'UPDATE review_checkouts SET preparation_receipt = ? WHERE id = ?',
      ).run(JSON.stringify(hostile), h.authority.id),
      /invalid checkout-bound review preparation receipt/,
    );
  }
  assert.equal(db.getReviewCheckoutById(h.authority.id)?.preparationReceipt, null);
  assert.equal(raw.prepare(
    'UPDATE agent_runs SET preparation_receipt = ? WHERE id = ?',
  ).run(JSON.stringify(executed), h.authority.reviewerRunId).changes, 1);
  assert.equal(raw.prepare(
    'UPDATE review_checkouts SET preparation_receipt = ? WHERE id = ?',
  ).run(JSON.stringify(canonical), h.authority.id).changes, 1);
  assert.deepEqual(db.getReviewCheckoutById(h.authority.id)?.preparationReceipt, canonical);
});

test('raw unavailable verdict rejects open identity and unsafe recordedAt', () => {
  const h = harness('raw-unavailable-verdict-hardening');
  completeQueuedRun(h.authority.reviewerRunId, 'review unavailable', 140);
  const canonical: ReviewCheckoutVerdictReceipt = {
    protocol: 'review-checkout-verdict-v1',
    ...h.authority,
    reviewerContractId: h.reviewerContractId,
    terminalStatus: 'completed',
    outcome: 'unavailable',
    findings: [],
    recordedAt: 150,
  };
  const raw = db.getRawDb();
  for (const hostile of [
    {
      ...canonical,
      repositoryIdentity: {
        ...canonical.repositoryIdentity,
        providerSessionId: 'native-leak',
      },
    },
    { ...canonical, recordedAt: Number.MAX_SAFE_INTEGER + 1 },
  ]) {
    assert.throws(
      () => raw.prepare(
        'UPDATE review_checkouts SET verdict_receipt = ? WHERE id = ?',
      ).run(JSON.stringify(hostile), h.authority.id),
      /invalid review checkout verdict receipt/,
    );
  }
  assert.equal(db.getReviewCheckoutById(h.authority.id)?.verdictReceipt, null);
  raw.exec('BEGIN');
  try {
    assert.equal(raw.prepare(
      'UPDATE agent_contracts SET version = version + 1 WHERE id = ?',
    ).run(h.authority.contractId).changes, 1);
    assert.throws(
      () => raw.prepare(
        'UPDATE review_checkouts SET verdict_receipt = ? WHERE id = ?',
      ).run(JSON.stringify(canonical), h.authority.id),
      /invalid review checkout verdict receipt/,
      'a stable verdict cannot be appended after the target frame drifts',
    );
    assert.equal(db.getReviewCheckoutById(h.authority.id)?.verdictReceipt, null);
  } finally {
    raw.exec('ROLLBACK');
  }
  raw.exec('BEGIN');
  try {
    db.insertAgentRunRow(runInput({
      id: db.newId() as ULID,
      projectId: h.authority.projectId,
      name: 'competing-target-run',
      contractId: h.authority.contractId,
    }));
    assert.throws(
      () => raw.prepare(
        'UPDATE review_checkouts SET verdict_receipt = ? WHERE id = ?',
      ).run(JSON.stringify(canonical), h.authority.id),
      /invalid review checkout verdict receipt/,
      'a stable verdict cannot be appended while another target run is live',
    );
    assert.equal(db.getReviewCheckoutById(h.authority.id)?.verdictReceipt, null);
  } finally {
    raw.exec('ROLLBACK');
  }
  assert.equal(raw.prepare(
    'UPDATE review_checkouts SET verdict_receipt = ? WHERE id = ?',
  ).run(JSON.stringify(canonical), h.authority.id).changes, 1);
  assert.deepEqual(db.getReviewCheckoutById(h.authority.id)?.verdictReceipt, canonical);
});

test('phase persistence rejects wrong authority and closed-shape/raw SQL substitutions', () => {
  const wrongHarness = harness('wrong-authority');
  const wrongAuthority = {
    ...wrongHarness.authority,
    reviewerRunId: db.newId() as ULID,
  };
  assert.equal(persistReviewPhase({
    authority: wrongAuthority,
    expectedUpdatedAt: wrongHarness.provisionedUpdatedAt,
    receipt: createReviewCheckoutPhaseReceipt(wrongAuthority, noCommands('preparation', 120)),
  }), null);
  assert.equal(db.getAgentRunRow(wrongHarness.authority.reviewerRunId)?.preparationReceipt, null);
  assert.equal(db.getReviewCheckoutById(wrongHarness.authority.id)?.preparationReceipt, null);

  const exactReceipt = createReviewCheckoutPhaseReceipt(
    wrongHarness.authority,
    noCommands('preparation', 121),
  );
  assert.equal(persistReviewPhase({
    authority: wrongHarness.authority,
    expectedUpdatedAt: wrongHarness.provisionedUpdatedAt,
    receipt: { ...exactReceipt, providerReceipt: 'native-leak' } as never,
  }), null);

  const rawHarness = harness('raw-phase');
  const raw = db.getRawDb();
  const preparation = noCommands('preparation', 130);
  assert.equal(raw.prepare(
    'UPDATE agent_runs SET preparation_receipt = ? WHERE id = ?',
  ).run(JSON.stringify(preparation), rawHarness.authority.reviewerRunId).changes, 1);

  const canonical = createReviewCheckoutPhaseReceipt(rawHarness.authority, preparation);
  for (const hostile of [
    preparation,
    { ...canonical, contractVersion: canonical.contractVersion + 1 },
    { ...canonical, evidence: { ...preparation, phase: 'readiness' } },
    { ...canonical, providerReceipt: 'native-leak' },
  ]) {
    assert.throws(
      () => raw.prepare(
        'UPDATE review_checkouts SET preparation_receipt = ? WHERE id = ?',
      ).run(JSON.stringify(hostile), rawHarness.authority.id),
      /invalid checkout-bound review preparation receipt/,
    );
  }
  assert.equal(db.getReviewCheckoutById(rawHarness.authority.id)?.preparationReceipt, null);
});

test('review phase writes roll back both copies on failure and persist exact equality', () => {
  const h = harness('atomic-phase');
  const preparation = noCommands('preparation', 200);
  const preparationReceipt = createReviewCheckoutPhaseReceipt(h.authority, preparation);
  const beforeRun = db.getAgentRunRow(h.authority.reviewerRunId)!;
  const raw = db.getRawDb();
  raw.exec(`
    CREATE TRIGGER dl004_test_reject_workspace_phase
    BEFORE UPDATE OF preparation_receipt ON review_checkouts
    BEGIN
      SELECT RAISE(ABORT, 'forced workspace phase rejection');
    END;
  `);
  try {
    assert.throws(() => persistReviewPhase({
      authority: h.authority,
      expectedUpdatedAt: h.provisionedUpdatedAt,
      receipt: preparationReceipt,
    }), /forced workspace phase rejection/);
  } finally {
    raw.exec('DROP TRIGGER dl004_test_reject_workspace_phase');
  }
  const rolledBackRun = db.getAgentRunRow(h.authority.reviewerRunId)!;
  const rolledBackCheckout = db.getReviewCheckoutById(h.authority.id)!;
  assert.equal(rolledBackRun.preparationReceipt, null);
  assert.equal(rolledBackRun.rev, beforeRun.rev, 'the run rev rolls back with its receipt');
  assert.equal(rolledBackCheckout.preparationReceipt, null);
  assert.equal(rolledBackCheckout.updatedAt, h.provisionedUpdatedAt);

  const prepared = persistReviewPhase({
    authority: h.authority,
    expectedUpdatedAt: h.provisionedUpdatedAt,
    receipt: preparationReceipt,
  });
  assert.ok(prepared);
  const preparedRun = db.getAgentRunRow(h.authority.reviewerRunId)!;
  assert.equal(reviewCheckoutPhaseMatchesRun(
    prepared,
    prepared.preparationReceipt,
    preparedRun.preparationReceipt,
    'preparation',
  ), true);
  assert.deepEqual(preparedRun.preparationReceipt, preparation);

  assert.throws(
    () => raw.prepare(
      'UPDATE agent_runs SET preparation_receipt = NULL WHERE id = ?',
    ).run(h.authority.reviewerRunId),
    /reviewer preparation evidence is immutable once checkout-bound/,
  );

  const readiness = noCommands('readiness', 210);
  const ready = persistReviewPhase({
    authority: h.authority,
    expectedUpdatedAt: prepared.updatedAt,
    receipt: createReviewCheckoutPhaseReceipt(h.authority, readiness),
  });
  assert.ok(ready);
  const readyRun = db.getAgentRunRow(h.authority.reviewerRunId)!;
  assert.equal(reviewCheckoutPhaseMatchesRun(
    ready,
    ready.readinessReceipt,
    readyRun.readinessReceipt,
    'readiness',
  ), true);
  assert.deepEqual(readyRun.readinessReceipt, readiness);
});

test('verdict effect is recoverable only after teardown and settles atomically once', () => {
  const h = harness('verdict-recovery');
  const prepared = persistReviewPhase({
    authority: h.authority,
    expectedUpdatedAt: h.provisionedUpdatedAt,
    receipt: createReviewCheckoutPhaseReceipt(h.authority, noCommands('preparation', 300)),
  });
  assert.ok(prepared);
  const ready = persistReviewPhase({
    authority: h.authority,
    expectedUpdatedAt: prepared.updatedAt,
    receipt: createReviewCheckoutPhaseReceipt(h.authority, noCommands('readiness', 310)),
  });
  assert.ok(ready);

  assert.ok(db.setContractDeliverable(h.reviewerContractId, {
    deliverable: { kind: 'payload', data: { verdict: 'approve', findings: [] } },
  }));
  assert.ok(db.setContractVerification(h.reviewerContractId, {
    verificationStatus: 'passed',
  }));
  completeQueuedRun(h.authority.reviewerRunId, 'approved', 320);

  const verdict: ReviewCheckoutVerdictReceipt = {
    protocol: 'review-checkout-verdict-v1',
    ...h.authority,
    reviewerContractId: h.reviewerContractId,
    terminalStatus: 'completed',
    outcome: 'approve',
    findings: [],
    recordedAt: 330,
  };
  const recorded = db.setReviewCheckoutVerdictReceipt({
    authority: h.authority,
    expectedUpdatedAt: ready.updatedAt,
    receipt: verdict,
  });
  assert.ok(recorded);

  const applyInTransaction = (expectedCheckoutUpdatedAt: number, appliedAt: number) =>
    getDb().transaction((tx) => {
      const target = db.applyReviewVerdictToContractInDb({ receipt: verdict, appliedAt }, tx);
      if (!target) return null;
      const producer = db.transitionAgentRunLifecycleInDb({
        id: verdict.producerRunId,
        expectedFrom: 'reviewing',
        to: 'merge-ready',
      }, tx);
      if (!producer) throw new Error('review verdict producer lifecycle CAS failed after contract transition');
      const evidence = db.applyReviewCheckoutVerdictEvidenceInDb({
        receipt: verdict,
        expectedUpdatedAt: expectedCheckoutUpdatedAt,
        appliedAt,
      }, tx);
      if (!evidence) throw new Error('review checkout verdict evidence CAS failed after contract transition');
      return target;
    });

  assert.throws(
    () => applyInTransaction(recorded.updatedAt, 340),
    /review checkout verdict evidence CAS failed/,
    'teardown is mandatory and the transaction rolls back',
  );
  assert.equal(db.getContract(h.authority.contractId)?.reviewRunId, h.authority.reviewerRunId);
  assert.equal(db.getReviewCheckoutById(h.authority.id)?.verdictAppliedAt, null);

  const pending = db.markReviewCheckoutTeardownPending({
    authority: h.authority,
    expectedUpdatedAt: recorded.updatedAt,
    fromStatus: 'provisioned',
    at: 350,
    error: null,
  });
  assert.ok(pending);
  const destroyed = db.settleReviewCheckoutTeardown({
    authority: h.authority,
    expectedUpdatedAt: pending.updatedAt,
    receipt: teardown(h.authority, 360),
    destroyedAt: 370,
  });
  assert.ok(destroyed);
  assert.equal(
    db.listReviewCheckoutsNeedingRecovery().some((row) => row.id === h.authority.id),
    true,
    'destroyed-but-unapplied verdict remains a recovery feeder',
  );
  assert.throws(
    () => applyInTransaction(destroyed.updatedAt - 1, 380),
    /review checkout verdict evidence CAS failed/,
    'stale checkout CAS refuses and rolls back',
  );

  assert.throws(
    () => db.getRawDb().prepare(
      'UPDATE review_checkouts SET verdict_applied_at = ? WHERE id = ?',
    ).run(380, h.authority.id),
    /review verdict effect requires positive teardown and atomic marker settlement/,
  );

  const targetBefore = db.getContract(h.authority.contractId)!;
  const raw = db.getRawDb();
  raw.exec(`
    CREATE TRIGGER dl004_test_reject_verdict_apply
    BEFORE UPDATE OF verdict_applied_at ON review_checkouts
    BEGIN
      SELECT RAISE(ABORT, 'forced verdict evidence rejection');
    END;
  `);
  try {
    assert.throws(
      () => applyInTransaction(destroyed.updatedAt, 380),
      /forced verdict evidence rejection/,
    );
  } finally {
    raw.exec('DROP TRIGGER dl004_test_reject_verdict_apply');
  }
  assert.deepEqual(
    db.getContract(h.authority.contractId),
    targetBefore,
    'contract marker and landing reservation roll back with evidence CAS',
  );
  assert.equal(db.getReviewCheckoutById(h.authority.id)?.verdictAppliedAt, null);

  const applied = applyInTransaction(destroyed.updatedAt, 380);
  assert.ok(applied);
  assert.equal(applied.reviewRunId, null);
  assert.equal(applied.reviewSealedCommit, null);
  assert.equal(applied.landingStatus, 'pending');
  assert.equal(applied.landingAuthorizer, 'reviewer');
  assert.equal(db.getReviewCheckoutById(h.authority.id)?.verdictAppliedAt, 380);
  assert.equal(
    db.listReviewCheckoutsNeedingRecovery().some((row) => row.id === h.authority.id),
    false,
  );
  assert.equal(applyInTransaction(destroyed.updatedAt, 381), null, 'verdict application is first-write');
});
