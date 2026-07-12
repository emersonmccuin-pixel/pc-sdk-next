import { test } from 'node:test';
import assert from 'node:assert/strict';
import { rmSync } from 'node:fs';
import {
  closeDb,
  createContract,
  getAgentRunRow,
  getContract,
  insertAgentRunRow,
  newId,
  setContractRun,
  setContractVerification,
} from '@pc/db';
import type { ULID } from '@pc/domain';
import { runBootRecovery } from '../src/boot-recovery.ts';
import {
  advanceTestAgentRunStatus,
  freshDb,
  newProject,
  testAgentRunExecution,
} from './helpers.ts';

test('boot recovery cannot park a contract rebound to a newer producer', () => {
  const dir = freshDb();
  try {
    const project = newProject('boot producer CAS');
    const contract = createContract({
      projectId: project.id,
      podName: 'builder',
      expectedOutput: { kind: 'prose', doc_type: 'note' },
      acceptanceCriteria: [],
      verificationTier: 'auto',
    });
    const staleRunId = newId() as ULID;
    const currentRunId = newId() as ULID;
    for (const runId of [staleRunId, currentRunId]) {
      insertAgentRunRow({
        id: runId,
        projectId: project.id,
        dispatcherSessionId: 'dispatcher',
        ...testAgentRunExecution('builder'),
        status: 'queued',
        input: 'build',
        contractId: contract.id,
        queuedAt: Date.now(),
      });
    }
    advanceTestAgentRunStatus(staleRunId, 'running');
    advanceTestAgentRunStatus(currentRunId, 'completed');
    setContractRun(contract.id, currentRunId);
    const currentEvidence = setContractVerification(contract.id, {
      verificationStatus: 'passed',
      verificationNotes: 'newer producer verified',
    });
    assert.ok(currentEvidence);

    const recovered = runBootRecovery();

    assert.ok(recovered.failedRuns.includes(staleRunId));
    assert.equal(getAgentRunRow(staleRunId)?.status, 'failed');
    assert.equal(getAgentRunRow(currentRunId)?.status, 'completed');
    assert.deepEqual(
      getContract(contract.id),
      currentEvidence,
      'stale run recovery must not change the newer producer receipt or version',
    );
  } finally {
    closeDb();
    rmSync(dir, { recursive: true, force: true });
  }
});
