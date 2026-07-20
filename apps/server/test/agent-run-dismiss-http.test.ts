// FIX B — recovery-view dismissal (docs/worktree-lifecycle.md 'Recovery'):
// POST /api/projects/:id/agent-runs/:runId/dismiss clears a terminal run that
// has nothing to auto-recover. Eligible = 'failed' with lifecycleState
// 'provisioning-failed'/null, or 'cancelled' — and only when no stranded
// worktree is bound and no sealed deliverable is recorded. Everything else
// refuses 409 with a typed reason.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ContractService, SubscriptionQuotaService } from '@pc/app-services';
import {
  insertAgentRunRow,
  markAgentRunTerminal,
  markWorktreeStranded,
  newId,
  upsertWorktree,
} from '@pc/db';
import type { RunLifecycleState, ULID } from '@pc/domain';
import { AccountRegistry } from '../src/runner/account-env.ts';
import { RuntimeRegistry } from '../src/runner/runtime.ts';
import { FakeRuntime } from '../src/runner/fake-runtime.ts';
import { DispatchService } from '../src/dispatch/service.ts';
import { startServer, type RunningServer } from '../src/server.ts';
import { freshDb, newProject, testAgentRunExecution, testDispatchRuntimeDeps } from './helpers.ts';
import {
  TEST_RUNTIME_ID,
  testSessionSelectionDeps,
  withRuntimeReceipt,
} from './runtime-fixtures.ts';

type Json = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
const body = (r: Response): Promise<Json> => r.json() as Promise<Json>;

async function boot(): Promise<{ server: RunningServer; base: string }> {
  const dispatchRuntimes = new RuntimeRegistry();
  const server = await startServer({
    mintSession: withRuntimeReceipt(() => new FakeRuntime({ turns: [] as never, stepDelayMs: 1 })),
    ...testSessionSelectionDeps(),
    port: 0,
    runRecovery: false,
    accounts: new AccountRegistry(),
    orchestratorRuntimeId: TEST_RUNTIME_ID,
    subscriptionQuota: new SubscriptionQuotaService(),
    // The agent-run routes (including /dismiss) mount only when dispatch is supplied.
    dispatch: new DispatchService({
      ...testDispatchRuntimeDeps(dispatchRuntimes),
    }),
  });
  return { server, base: `http://localhost:${server.port}` };
}

function insertQueuedRun(
  projectId: ULID,
  overrides: { lifecycleState?: RunLifecycleState | null; contractId?: ULID | null } = {},
): ULID {
  const id = newId() as ULID;
  const exec = testAgentRunExecution('code-writer');
  insertAgentRunRow({
    id,
    projectId,
    dispatcherSessionId: 'S1',
    specialistSnapshot: exec.specialistSnapshot,
    selection: exec.selection,
    continuation: exec.continuation,
    status: 'queued',
    input: 'fix it',
    lifecycleState: overrides.lifecycleState ?? null,
    contractId: overrides.contractId ?? null,
    queuedAt: Date.now(),
  });
  return id;
}

function insertTerminalRun(
  projectId: ULID,
  opts: {
    status: 'failed' | 'cancelled';
    lifecycleState?: RunLifecycleState | null;
    contractId?: ULID | null;
  },
): ULID {
  const id = insertQueuedRun(projectId, opts);
  const changed = markAgentRunTerminal({
    id,
    status: opts.status,
    result: null,
    failureCause: opts.status === 'failed' ? 'worktree-provision-failed' : 'cancelled',
    failureReason: `test ${opts.status}`,
    completedAt: Date.now(),
  });
  if (!changed) throw new Error(`fixture run ${id} could not become ${opts.status}`);
  return id;
}

test('dismiss: eligible terminal runs are cleared and drop dismissedAt onto the DTO', async () => {
  freshDb();
  const project = newProject('dismiss-eligible');
  const { server, base } = await boot();
  try {
    // Eligible: failed, lifecycleState null (spawn/runtime-start error before any worktree).
    const eligibleNull = insertTerminalRun(project.id, { status: 'failed', lifecycleState: null });
    const dismiss1 = await fetch(
      `${base}/api/projects/${project.id}/agent-runs/${eligibleNull}/dismiss`,
      { method: 'POST' },
    ).then(body);
    assert.equal(dismiss1.ok, true);
    assert.equal(typeof dismiss1.run.dismissedAt, 'number');

    // Eligible: failed, lifecycleState 'provisioning-failed', no worktree bound.
    const eligibleProvFailed = insertTerminalRun(project.id, {
      status: 'failed',
      lifecycleState: 'provisioning-failed',
    });
    const dismiss2 = await fetch(
      `${base}/api/projects/${project.id}/agent-runs/${eligibleProvFailed}/dismiss`,
      { method: 'POST' },
    ).then(body);
    assert.equal(dismiss2.ok, true);

    // Eligible: cancelled.
    const eligibleCancelled = insertTerminalRun(project.id, { status: 'cancelled', lifecycleState: null });
    const dismiss3 = await fetch(
      `${base}/api/projects/${project.id}/agent-runs/${eligibleCancelled}/dismiss`,
      { method: 'POST' },
    ).then(body);
    assert.equal(dismiss3.ok, true);

    // dismissedAt rides the ordinary run-list read (the recovery projection's source).
    const list = await fetch(`${base}/api/projects/${project.id}/agent-runs`).then(body);
    for (const id of [eligibleNull, eligibleProvFailed, eligibleCancelled]) {
      const listed = list.runs.find((r: Json) => r.runId === id);
      assert.ok(listed, `dismissed run ${id} still exists in the list`);
      assert.equal(typeof listed.dismissedAt, 'number');
    }

    // Idempotent: dismissing again does not refuse and keeps it dismissed.
    const redismiss = await fetch(
      `${base}/api/projects/${project.id}/agent-runs/${eligibleNull}/dismiss`,
      { method: 'POST' },
    ).then(body);
    assert.equal(redismiss.ok, true);
  } finally {
    await server.close();
  }
});

test('dismiss: not-terminal, not-eligible, sealed-deliverable, and stranded-worktree runs refuse 409 with a typed reason', async () => {
  freshDb();
  const project = newProject('dismiss-ineligible');
  const { server, base } = await boot();
  try {
    // Not terminal.
    const running = insertQueuedRun(project.id);
    const notTerminalRes = await fetch(
      `${base}/api/projects/${project.id}/agent-runs/${running}/dismiss`,
      { method: 'POST' },
    );
    assert.equal(notTerminalRes.status, 409);
    const notTerminalBody = await body(notTerminalRes);
    assert.equal(notTerminalBody.ok, false);
    assert.equal(notTerminalBody.reason, 'not-terminal');

    // Terminal but not in an eligible bucket — real recovery evidence
    // (verification-failed) is retained by the normal recovery flow instead.
    const notEligible = insertTerminalRun(project.id, {
      status: 'failed',
      lifecycleState: 'verification-failed',
    });
    const notEligibleRes = await fetch(
      `${base}/api/projects/${project.id}/agent-runs/${notEligible}/dismiss`,
      { method: 'POST' },
    );
    assert.equal(notEligibleRes.status, 409);
    assert.equal((await body(notEligibleRes)).reason, 'not-eligible');

    // Sealed deliverable — refuse even though status/lifecycleState are eligible.
    const contracts = new ContractService();
    const sealedContract = contracts.create({
      projectId: project.id,
      podName: 'code-writer',
      expectedOutput: { kind: 'answer' },
    });
    contracts.setDeliverable({
      id: sealedContract.id,
      deliverable: { kind: 'answer', text: 'done' },
    });
    const sealedRun = insertTerminalRun(project.id, {
      status: 'failed',
      lifecycleState: null,
      contractId: sealedContract.id as ULID,
    });
    const sealedRes = await fetch(
      `${base}/api/projects/${project.id}/agent-runs/${sealedRun}/dismiss`,
      { method: 'POST' },
    );
    assert.equal(sealedRes.status, 409);
    assert.equal((await body(sealedRes)).reason, 'sealed-deliverable');

    // Stranded worktree bound — refuse even with no sealed deliverable.
    const strandedRun = insertTerminalRun(project.id, {
      status: 'failed',
      lifecycleState: 'provisioning-failed',
    });
    const strandedName = `agent-${strandedRun.slice(-8).toLowerCase()}`;
    upsertWorktree({
      name: strandedName,
      path: `/tmp/${strandedName}`,
      projectId: project.id,
      agentRunId: strandedRun,
      branch: strandedName,
      baseBranch: 'main',
      baseSha: 'a'.repeat(40),
    });
    markWorktreeStranded(strandedName, 'dir-missing');
    const strandedRes = await fetch(
      `${base}/api/projects/${project.id}/agent-runs/${strandedRun}/dismiss`,
      { method: 'POST' },
    );
    assert.equal(strandedRes.status, 409);
    assert.equal((await body(strandedRes)).reason, 'stranded-worktree-bound');

    // Unknown run → 404, not a typed refusal shape.
    const unknownRes = await fetch(
      `${base}/api/projects/${project.id}/agent-runs/${newId()}/dismiss`,
      { method: 'POST' },
    );
    assert.equal(unknownRes.status, 404);
  } finally {
    await server.close();
  }
});
