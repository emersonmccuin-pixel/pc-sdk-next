import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  contractDeliverableText,
  isContract,
  isContractChangedLivePayload,
  isContractMutationReason,
  isContractStatus,
  isDeliverableKind,
  isExpectedOutputKind,
  isMatchingWorktreeAbandonmentTeardownDto,
  isWorktreeAbandonmentPreviewDto,
  isWorktreeAbandonmentReceiptDto,
  isWorktreeAbandonmentTeardownReceiptDto,
  parseApproveWorktreeAbandonmentRequest,
  type AcceptancePredicate,
  type Contract,
  type Deliverable,
  type ExpectedOutput,
  type WorktreeAbandonmentPreviewDto,
  type WorktreeAbandonmentReceiptDto,
  type WorktreeAbandonmentTeardownReceiptDto,
} from '../src/index.ts';

const baseContract: Contract = {
  id: 'c1',
  projectId: 'p1',
  pmRef: 'PM-42',
  agentRunId: null,
  podName: 'researcher',
  expectedOutput: { kind: 'answer', min_chars: 10 },
  acceptanceCriteria: [{ kind: 'report_contains', pattern: 'done' }],
  verificationTier: 'auto',
  verificationStatus: null,
  verificationNotes: null,
  report: null,
  deliverable: null,
  worktreePath: null,
  worktreeBaseBranch: null,
  worktreeBaseSha: null,
  landingStatus: null,
  landedBranch: null,
  landedSha: null,
  landingError: null,
  landedAt: null,
  targetShaBefore: null,
  targetShaAfter: null,
  mergeSha: null,
  landingAuthorizer: null,
  verifiedBaseSha: null,
  landingPolicy: null,
  reviewRound: null,
  reviewRunId: null,
  reviewSealedCommit: null,
  abandonmentReceipt: null,
  abandonmentTeardownReceipt: null,
  abandonmentError: null,
  status: 'issued',
  version: 1,
  createdAt: 1,
  updatedAt: 2,
};

test('Contract guard accepts a full row and rejects drift', () => {
  assert.equal(isContract(baseContract), true);
  assert.equal(isContract({ ...baseContract, status: 'nope' }), false);
  assert.equal(isContract({ ...baseContract, version: null }), false);
  // nullable pmRef + agentRunId are allowed
  assert.equal(isContract({ ...baseContract, pmRef: null, agentRunId: 'r1' }), true);
  // merge receipt + landing policy: enum'd fields reject drift, nulls pass
  assert.equal(
    isContract({
      ...baseContract,
      targetShaBefore: 'a'.repeat(40),
      targetShaAfter: 'b'.repeat(40),
      mergeSha: 'b'.repeat(40),
      landingAuthorizer: 'auto',
      verifiedBaseSha: 'c'.repeat(40),
      landingPolicy: 'auto-merge',
    }),
    true,
  );
  assert.equal(isContract({ ...baseContract, landingAuthorizer: 'builder' }), false);
  assert.equal(isContract({ ...baseContract, landingPolicy: 'yolo' }), false);
  // Full-review loop fields: 'reviewer' authorizer + round/run markers.
  assert.equal(
    isContract({ ...baseContract, landingAuthorizer: 'reviewer', reviewRound: 1, reviewRunId: 'r9' }),
    true,
  );
  assert.equal(isContract({ ...baseContract, reviewRound: 'two' }), false);
  assert.equal(isContract({ ...baseContract, reviewRunId: 42 }), false);
  assert.equal(isContract({ ...baseContract, reviewSealedCommit: 'a'.repeat(40) }), true);
  assert.equal(isContract({ ...baseContract, reviewSealedCommit: 42 }), false);
  assert.equal(isContract({ ...baseContract, landingStatus: 'unknown' }), false);
  assert.equal(isContract({ ...baseContract, landedAt: Number.MAX_SAFE_INTEGER + 1 }), false);
  assert.equal(isContract({ ...baseContract, providerReceipt: 'leak' }), false);
});

const abandonmentProjectId = '01J00000000000000000000000';
const abandonmentContractId = '01J00000000000000000000001';
const abandonmentProducerId = '01J00000000000000000000002';
const abandonmentWorktreeId = '01J00000000000000000000003';
const abandonmentRequestId = '123e4567-e89b-42d3-a456-426614174000';
const abandonmentIdentity = {
  protocol: 'git-common-dir-v1' as const,
  gitCommonDir: 'C:/repo/.git',
  leaseKey: `sha256:${'1'.repeat(64)}`,
};
const abandonmentState = {
  directory: 'present' as const,
  registration: 'registered' as const,
  status: 'dirty' as const,
  staged: 1,
  unstaged: 0,
  untracked: 1,
  worktreeStateDigest: `sha256:${'2'.repeat(64)}`,
  changedPaths: ['a.ts', 'new.txt'],
  ignoredContents: 'uninspected' as const,
};
const abandonmentPreview: WorktreeAbandonmentPreviewDto = {
  protocol: 'worktree-abandonment-preview-v1',
  projectId: abandonmentProjectId,
  contractId: abandonmentContractId,
  contractVersion: 7,
  producerRunId: abandonmentProducerId,
  worktreeId: abandonmentWorktreeId,
  worktreeStatus: 'active',
  worktreePath: 'C:/repo-worktrees/agent-one',
  branch: 'agent-one',
  branchTip: 'a'.repeat(40),
  baseBranch: 'main',
  validatedBaseSha: 'b'.repeat(40),
  targetTip: 'c'.repeat(40),
  integrationState: 'unmerged',
  repositoryIdentity: abandonmentIdentity,
  worktreeState: abandonmentState,
  previewDigest: `sha256:${'3'.repeat(64)}`,
};
const abandonmentReceipt: WorktreeAbandonmentReceiptDto = {
  protocol: 'worktree-abandonment-v1',
  requestId: abandonmentRequestId,
  approvedBy: 'user',
  approvalSurface: 'browser',
  approvalReason: 'explicit-browser-confirmation',
  approvedAt: 10,
  reason: null,
  approvedContractVersion: 7,
  projectId: abandonmentProjectId,
  contractId: abandonmentContractId,
  producerRunId: abandonmentProducerId,
  worktreeId: abandonmentWorktreeId,
  worktreeStatus: 'active',
  repositoryIdentity: abandonmentIdentity,
  worktreePath: abandonmentPreview.worktreePath,
  branch: abandonmentPreview.branch,
  branchTip: abandonmentPreview.branchTip,
  baseBranch: abandonmentPreview.baseBranch,
  validatedBaseSha: abandonmentPreview.validatedBaseSha,
  targetTip: abandonmentPreview.targetTip,
  integrationState: abandonmentPreview.integrationState,
  worktreeState: abandonmentState,
  previewDigest: abandonmentPreview.previewDigest,
};
const abandonmentTeardown: WorktreeAbandonmentTeardownReceiptDto = {
  protocol: 'worktree-abandonment-teardown-v1',
  authorityRequestId: abandonmentRequestId,
  startedAt: 11,
  finishedAt: 12,
  repositoryIdentity: abandonmentIdentity,
  worktreePath: abandonmentPreview.worktreePath,
  branch: abandonmentPreview.branch,
  approvedBranchTip: abandonmentPreview.branchTip,
  observedBranchTip: abandonmentPreview.branchTip,
  directoryAbsent: true,
  registrationAbsent: true,
  branchPreserved: true,
};

test('abandonment DTO and request guards are strict and reject caller-authored authority', () => {
  assert.equal(isWorktreeAbandonmentPreviewDto(abandonmentPreview), true);
  assert.equal(isWorktreeAbandonmentReceiptDto(abandonmentReceipt), true);
  assert.equal(isWorktreeAbandonmentTeardownReceiptDto(abandonmentTeardown), true);
  assert.equal(isMatchingWorktreeAbandonmentTeardownDto(abandonmentReceipt, abandonmentTeardown), true);
  assert.equal(isWorktreeAbandonmentPreviewDto({ ...abandonmentPreview, extra: true }), false);
  assert.equal(isWorktreeAbandonmentReceiptDto({ ...abandonmentReceipt, approvedAt: 1.5 }), false);
  assert.equal(isMatchingWorktreeAbandonmentTeardownDto(abandonmentReceipt, {
    ...abandonmentTeardown,
    observedBranchTip: 'd'.repeat(40),
  }), false);

  const parsed = parseApproveWorktreeAbandonmentRequest({
    requestId: abandonmentRequestId,
    expectedContractVersion: 7,
    previewDigest: abandonmentPreview.previewDigest,
    confirmation: abandonmentPreview.branch,
    reason: '  done  ',
  });
  assert.deepEqual(parsed, {
    ok: true,
    value: {
      requestId: abandonmentRequestId,
      expectedContractVersion: 7,
      previewDigest: abandonmentPreview.previewDigest,
      confirmation: abandonmentPreview.branch,
      reason: 'done',
    },
  });
  assert.equal(parseApproveWorktreeAbandonmentRequest({
    requestId: abandonmentRequestId,
    expectedContractVersion: 7,
    previewDigest: abandonmentPreview.previewDigest,
    confirmation: abandonmentPreview.branch,
    approvedBy: 'user',
  }).ok, false);
  assert.equal(parseApproveWorktreeAbandonmentRequest({
    requestId: 'bad',
    expectedContractVersion: 7,
    previewDigest: abandonmentPreview.previewDigest,
    confirmation: abandonmentPreview.branch,
  }).ok, false);
});

test('contract guard enforces legacy, pending, and settled abandonment cross-fields', () => {
  const bound = {
    ...baseContract,
    id: abandonmentContractId,
    projectId: abandonmentProjectId,
    agentRunId: abandonmentProducerId,
    expectedOutput: { kind: 'repo' } as const,
    worktreePath: abandonmentPreview.worktreePath,
    worktreeBaseBranch: abandonmentPreview.baseBranch,
    worktreeBaseSha: abandonmentPreview.validatedBaseSha,
    version: 8,
  };
  assert.equal(isContract({
    ...bound,
    landingStatus: 'abandoning',
    abandonmentReceipt,
  }), true);
  assert.equal(isContract({
    ...bound,
    landingStatus: 'abandoning',
    abandonmentReceipt: null,
  }), false);
  assert.equal(isContract({
    ...bound,
    landingStatus: 'abandoned',
    version: 9,
    abandonmentReceipt,
    abandonmentTeardownReceipt: abandonmentTeardown,
  }), true);
  assert.equal(isContract({
    ...bound,
    landingStatus: 'abandoned',
    abandonmentReceipt,
  }), false, 'partial final evidence is invalid');
  assert.equal(isContract({
    ...bound,
    landingStatus: 'abandoned',
    abandonmentReceipt: null,
    abandonmentTeardownReceipt: null,
  }), true, 'legacy abandoned stays readable but carries no authority');
  assert.equal(isContract({
    ...bound,
    landingStatus: 'failed',
    abandonmentReceipt,
  }), false);
});

// ── Every ExpectedOutput kind round-trips through the Contract DTO ──
const expectedOutputs: ExpectedOutput[] = [
  { kind: 'answer', must_address: ['why', 'how'], min_chars: 50 },
  { kind: 'prose', doc_type: 'prd', sections: ['Goals'], store: 'attachment' },
  { kind: 'payload', schema: { type: 'object', required: ['x'] }, semantic: 'decision' },
  {
    kind: 'repo',
    isolation: 'worktree',
    paths_touched: ['a.ts'],
    checks: [
      { preset: 'build', timeout_ms: 60_000 },
      { command: 'pnpm test', cwd: 'worktree', timeout_ms: 120_000 },
    ],
    require_diff: true,
    auto_land: true,
  },
  { kind: 'repo', paths_touched: ['b.ts'], review: 'full' },
  {
    kind: 'external',
    system: 'email',
    action: 'send',
    confirm: 'always',
    idempotency_key: 'k1',
    verify_handle: true,
  },
  { kind: 'binary', artifact_type: 'diagram', mime: 'image/png', min_size_bytes: 100 },
  { kind: 'action', tool: 'pc_ask_orchestrator', min_count: 1, before_end_turn: true },
];

test('every ExpectedOutput kind round-trips on the Contract DTO', () => {
  for (const eo of expectedOutputs) {
    assert.equal(isExpectedOutputKind(eo.kind), true);
    const c = { ...baseContract, expectedOutput: eo };
    assert.equal(isContract(c), true);
  }
});

// ── Every Deliverable kind round-trips through the Contract DTO ──
const deliverables: Deliverable[] = [
  { kind: 'answer', text: 'hi' },
  { kind: 'prose', text: 'doc', attachmentId: 'a1', ref: 'r' },
  { kind: 'payload', data: { x: 1 } },
  { kind: 'repo', branch: 'feat/x', commit: 'abc', baseBranch: 'main', baseCommit: 'base', diffStat: { files: 1, insertions: 2, deletions: 0 }, prUrl: 'http://pr' },
  { kind: 'external', system: 'email', handle: 'msg-1', idempotencyKey: 'k1', url: 'http://m' },
  { kind: 'binary', attachmentId: 'a2', mime: 'image/png', bytes: 1024 },
  { kind: 'action', tool: 'pc_ask_orchestrator', count: 1 },
];

test('every Deliverable kind round-trips on the Contract DTO', () => {
  for (const d of deliverables) {
    assert.equal(isDeliverableKind(d.kind), true);
    const c = { ...baseContract, deliverable: d, status: 'submitted' as const };
    assert.equal(isContract(c), true);
  }
});

// ── Acceptance-predicate union stays in lockstep with @pc/domain ──
// Typed literals compile-check the mirror; the guard accepts them on the DTO.
const acceptancePredicates: AcceptancePredicate[] = [
  { kind: 'files_exist', paths: ['a.ts'], min_size_bytes: 1 },
  { kind: 'fields_populated', keys: ['x'] },
  { kind: 'field_matches', key: 'x', pattern: '^y$' },
  { kind: 'bash_exit_zero', command: 'pnpm test', cwd: 'worktree', timeout_ms: 120_000 },
  { kind: 'attachments_present', names: ['out.png'] },
  { kind: 'body_contains', pattern: 'done', regex: false },
  { kind: 'schema_valid', schema: { type: 'object' } },
  { kind: 'git_diff_nonempty', cwd: 'worktree' },
  { kind: 'external_handle_present' },
  { kind: 'tool_called', name: 'pc_x', min_count: 1 },
  { kind: 'pending_ask_created' },
  { kind: 'report_contains', pattern: 'ok', regex: true },
  { kind: 'min_length', min: 10 },
  { kind: 'changed_paths_within', allowed: ['src/**'], forbidden: ['.git/**'] },
];

test('every acceptance-predicate kind rides the Contract DTO', () => {
  const c = { ...baseContract, acceptanceCriteria: acceptancePredicates };
  assert.equal(isContract(c), true);
});

test('child_work_items_done is not a predicate kind (removed with work items)', () => {
  // @ts-expect-error — stale v1 predicate; reintroducing it makes this line error.
  const stale: AcceptancePredicate = { kind: 'child_work_items_done', all: true };
  void stale;
});

test('contract status + mutation-reason guards', () => {
  for (const s of ['issued', 'dispatched', 'submitted', 'verifying', 'accepted', 'rejected']) {
    assert.equal(isContractStatus(s), true);
  }
  assert.equal(isContractStatus('open'), false);
  for (const r of [
    'created',
    'dispatched',
    'deliverable-set',
    'verification-set',
    'landing-set',
    'abandonment-authorized',
    'abandonment-settled',
    'abandonment-error',
    'patched',
  ]) {
    assert.equal(isContractMutationReason(r), true);
  }
  assert.equal(isContractMutationReason('deleted'), false);
});

test('contractDeliverableText projects a deliverable to its readable text', () => {
  // answer/prose carry inline text.
  assert.equal(contractDeliverableText({ kind: 'answer', text: 'hello' }), 'hello');
  assert.equal(contractDeliverableText({ kind: 'prose', text: 'a doc' }), 'a doc');
  // structured kinds have no prose body → fall back to the report.
  assert.equal(
    contractDeliverableText({ kind: 'payload', data: { x: 1 } }, 'see report'),
    'see report',
  );
  assert.equal(
    contractDeliverableText({ kind: 'action', tool: 'pc_x', count: 1 }, 'did it'),
    'did it',
  );
  // structured kind with no report → empty.
  assert.equal(contractDeliverableText({ kind: 'payload', data: {} }), '');
  // no deliverable → report, else empty.
  assert.equal(contractDeliverableText(null, 'fallback'), 'fallback');
  assert.equal(contractDeliverableText(null), '');
  assert.equal(contractDeliverableText(undefined), '');
});

test('contract resource payload guard validates reason + contract', () => {
  assert.equal(
    isContractChangedLivePayload({ reason: 'created', contract: baseContract }),
    true,
  );
  assert.equal(
    isContractChangedLivePayload({ reason: 'landing-set', contract: baseContract }),
    true,
  );
  // bad reason
  assert.equal(
    isContractChangedLivePayload({ reason: 'deleted', contract: baseContract }),
    false,
  );
  // missing contract
  assert.equal(isContractChangedLivePayload({ reason: 'created' }), false);
});
