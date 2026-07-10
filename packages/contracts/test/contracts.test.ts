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
  type Contract,
  type Deliverable,
  type ExpectedOutput,
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
});

// ── Every ExpectedOutput kind round-trips through the Contract DTO ──
const expectedOutputs: ExpectedOutput[] = [
  { kind: 'answer', must_address: ['why', 'how'], min_chars: 50 },
  { kind: 'prose', doc_type: 'prd', sections: ['Goals'], store: 'attachment' },
  { kind: 'payload', schema: { type: 'object', required: ['x'] }, semantic: 'decision' },
  { kind: 'repo', isolation: 'worktree', paths_touched: ['a.ts'], checks: [{ preset: 'build' }], require_diff: true },
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

test('contract status + mutation-reason guards', () => {
  for (const s of ['issued', 'dispatched', 'submitted', 'verifying', 'accepted', 'rejected']) {
    assert.equal(isContractStatus(s), true);
  }
  assert.equal(isContractStatus('open'), false);
  for (const r of ['created', 'dispatched', 'deliverable-set', 'verification-set', 'landing-set', 'patched']) {
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
