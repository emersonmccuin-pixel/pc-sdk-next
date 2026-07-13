import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { ContractService } from '@pc/app-services';
import {
  getWorktreeById,
  insertAgentRunRow,
  newId,
  setWorktreeContractId,
} from '@pc/db';
import type { RepositoryIdentityReceipt, ULID } from '@pc/domain';
import { DispatchService } from '../src/dispatch/service.ts';
import { git, provisionWorktree } from '../src/dispatch/worktrees.ts';
import { RuntimeRegistry } from '../src/runner/runtime.ts';
import {
  advanceTestAgentRunStatus,
  freshDb,
  newGitProject,
  testAgentRunExecution,
  testDispatchRuntimeDeps,
  type GitProject,
} from './helpers.ts';

function rig(): DispatchService {
  const dispatch = new DispatchService(testDispatchRuntimeDeps(new RuntimeRegistry()));
  dispatch.attach({ registry: {} as never, hub: {} as never, serverPort: 5124 });
  return dispatch;
}

test('abandonment authority is absent from generic tools, MCP dispatch, and agent prompts', () => {
  const files = [
    new URL('../src/dispatch/pc-bridge.ts', import.meta.url),
    new URL('../src/dispatch/prompt.ts', import.meta.url),
    new URL('../src/agents/stock-agent-content.ts', import.meta.url),
    new URL('../../../packages/mcp/src/tools/agent-runs.ts', import.meta.url),
  ];
  for (const file of files) {
    assert.doesNotMatch(
      readFileSync(file, 'utf8'),
      /(?:pc_.*abandon|abandon.*worktree|worktree.*abandon)/i,
      String(file),
    );
  }
});

function gitReceiptFor(worktree: {
  dir: string;
  branch: string;
  baseBranch: string;
  baseSha: string;
  repositoryIdentity: RepositoryIdentityReceipt;
}) {
  return {
    worktreePath: worktree.dir,
    branch: worktree.branch,
    baseBranch: worktree.baseBranch,
    baseSha: worktree.baseSha,
    cleanStatus: true,
    repositoryIdentity: worktree.repositoryIdentity,
  };
}

async function abandonedCandidate(gp: GitProject) {
  const runId = newId() as ULID;
  const provisioned = await provisionWorktree(gp.dir, runId, { projectId: gp.project.id });
  if (!provisioned.ok) throw new Error(provisioned.error);
  const contracts = new ContractService();
  const contract = contracts.create({
    projectId: gp.project.id,
    podName: 'code-writer',
    expectedOutput: { kind: 'repo' },
    worktreePath: provisioned.dir,
    worktreeBaseBranch: provisioned.baseBranch,
    worktreeBaseSha: provisioned.baseSha,
  });
  setWorktreeContractId(provisioned.branch, contract.id as ULID);
  insertAgentRunRow({
    id: runId,
    projectId: gp.project.id,
    ...testAgentRunExecution('code-writer'),
    dispatcherSessionId: 'abandonment-service',
    status: 'queued',
    input: 'produce repository work',
    contractId: contract.id as ULID,
    worktreeDir: provisioned.dir,
    worktreeBaseBranch: provisioned.baseBranch,
    worktreeBaseSha: provisioned.baseSha,
    gitReceipt: gitReceiptFor(provisioned),
    queuedAt: Date.now(),
  });
  assert.ok(contracts.setRun(contract.id, runId));
  advanceTestAgentRunStatus(runId, 'completed');
  const continuationRunId = newId() as ULID;
  insertAgentRunRow({
    id: continuationRunId,
    projectId: gp.project.id,
    ...testAgentRunExecution('code-writer'),
    dispatcherSessionId: 'abandonment-service',
    status: 'queued',
    input: 'continue repository work',
    contractId: contract.id as ULID,
    worktreeDir: provisioned.dir,
    worktreeBaseBranch: provisioned.baseBranch,
    worktreeBaseSha: provisioned.baseSha,
    gitReceipt: gitReceiptFor(provisioned),
    queuedAt: Date.now(),
  });
  assert.ok(contracts.setRun(contract.id, continuationRunId));
  advanceTestAgentRunStatus(continuationRunId, 'completed');
  return { contractId: contract.id as ULID, runId: continuationRunId, provisioned };
}

test('service approval follows continuation ownership, settles exactly once, and preserves the branch', async () => {
  freshDb();
  const gp = await newGitProject('abandon-service');
  try {
    const candidate = await abandonedCandidate(gp);
    const dispatch = rig();
    const pendingRunTask = new Promise<void>(() => {});
    const runTasks = (
      dispatch as unknown as { runTasks: Map<string, Promise<void>> }
    ).runTasks;
    runTasks.set(candidate.runId, pendingRunTask);
    const whileMinting = await dispatch.previewContractAbandonment({
      projectId: gp.project.id,
      contractId: candidate.contractId,
    });
    assert.equal(whileMinting.ok, false);
    if (!whileMinting.ok) {
      assert.equal(whileMinting.httpStatus, 409);
      assert.match(whileMinting.message, /preparation or runtime task is still pending/);
    }
    runTasks.delete(candidate.runId);

    const retirementGate = new Promise<void>(() => {});
    const retiringRuns = (
      dispatch as unknown as {
        retiringRuns: Map<string, { promise: Promise<void>; status: 'pending' | 'failed'; error: unknown }>;
      }
    ).retiringRuns;
    retiringRuns.set(candidate.runId, { promise: retirementGate, status: 'pending', error: null });
    const whileDisposing = await dispatch.previewContractAbandonment({
      projectId: gp.project.id,
      contractId: candidate.contractId,
    });
    assert.equal(whileDisposing.ok, false);
    if (!whileDisposing.ok) {
      assert.equal(whileDisposing.httpStatus, 409);
      assert.match(whileDisposing.message, /disposal is still pending/);
    }
    retiringRuns.delete(candidate.runId);

    const previewResult = await dispatch.previewContractAbandonment({
      projectId: gp.project.id,
      contractId: candidate.contractId,
    });
    assert.equal(previewResult.ok, true, previewResult.ok ? '' : previewResult.message);
    if (!previewResult.ok) return;
    const request = {
      requestId: '4cbfe782-bd4d-4a08-8261-d158251240fa',
      expectedContractVersion: previewResult.preview.contractVersion,
      previewDigest: previewResult.preview.previewDigest,
      confirmation: previewResult.preview.branch,
      reason: 'superseded implementation',
    };

    const approved = await dispatch.approveContractAbandonment({
      projectId: gp.project.id,
      contractId: candidate.contractId,
      request,
    });
    assert.equal(approved.ok, true, approved.ok ? '' : approved.message);
    if (!approved.ok) return;
    assert.equal(approved.settlement, 'completed');
    assert.equal(approved.contract.landingStatus, 'abandoned');
    assert.equal(approved.contract.abandonmentReceipt?.requestId, request.requestId);
    assert.equal(approved.contract.abandonmentTeardownReceipt?.authorityRequestId, request.requestId);
    assert.equal(existsSync(candidate.provisioned.dir), false);
    assert.equal(getWorktreeById(previewResult.preview.worktreeId as ULID)?.status, 'destroyed');
    const branch = await git(
      ['rev-parse', '--verify', '--quiet', `refs/heads/${candidate.provisioned.branch}`],
      gp.dir,
    );
    assert.equal(branch.ok, true);
    assert.equal(branch.stdout, candidate.provisioned.baseSha);

    const settledVersion = approved.contract.version;
    const replay = await dispatch.approveContractAbandonment({
      projectId: gp.project.id,
      contractId: candidate.contractId,
      request,
    });
    assert.equal(replay.ok, true);
    if (replay.ok) {
      assert.equal(replay.settlement, 'completed');
      assert.equal(replay.contract.version, settledVersion, 'same request is mutation-free after settlement');
    }

    const changedReason = await dispatch.approveContractAbandonment({
      projectId: gp.project.id,
      contractId: candidate.contractId,
      request: { ...request, reason: 'different audit reason' },
    });
    assert.equal(changedReason.ok, false);
    if (!changedReason.ok) assert.equal(changedReason.httpStatus, 409);

    const conflicting = await dispatch.approveContractAbandonment({
      projectId: gp.project.id,
      contractId: candidate.contractId,
      request: { ...request, requestId: '0acb62d4-cbd3-4389-a3fe-14d1ec91d669' },
    });
    assert.equal(conflicting.ok, false);
    if (!conflicting.ok) assert.equal(conflicting.httpStatus, 409);
  } finally {
    await gp.cleanup();
  }
});
