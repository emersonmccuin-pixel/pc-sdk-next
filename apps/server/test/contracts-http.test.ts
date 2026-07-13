// Slice G1 guards: the contract read routes (contractRoutes list/detail) speak
// full DTOs — merge receipt, landingPolicy, verificationNotes — and run-list
// retention is state-based (docs/worktree-lifecycle.md 'Teardown and
// retention'): preserved lifecycle states outlive the 24h terminal window.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ContractService, SubscriptionQuotaService } from '@pc/app-services';
import {
  createReviewCheckoutReservation,
  insertAgentRunRow,
  markAgentRunTerminal,
  newId,
} from '@pc/db';
import type { ReviewCheckoutAuthority, ULID } from '@pc/domain';
import { AccountRegistry } from '../src/runner/account-env.ts';
import { RuntimeRegistry } from '../src/runner/runtime.ts';
import { FakeRuntime } from '../src/runner/fake-runtime.ts';
import { DispatchService } from '../src/dispatch/service.ts';
import { startServer, type RunningServer } from '../src/server.ts';
import {
  advanceTestAgentRunStatus,
  freshDb,
  newProject,
  testAgentRunExecution,
  testDispatchRuntimeDeps,
} from './helpers.ts';
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
    // The agent-run/contract routes mount only when dispatch is supplied.
    dispatch: new DispatchService({
      ...testDispatchRuntimeDeps(dispatchRuntimes),
    }),
  });
  return { server, base: `http://localhost:${server.port}` };
}

test('contract reads: project list + detail carry the receipt fields; detail 404s unknown', async () => {
  freshDb();
  const project = newProject();
  const { server, base } = await boot();
  try {
    const svc = new ContractService();
    const parked = svc.create({
      projectId: project.id,
      podName: 'builder',
      expectedOutput: { kind: 'repo' },
      landingPolicy: 'default-review',
    });
    svc.setVerification({
      id: parked.id,
      verificationStatus: 'passed',
      verificationNotes: 'parked merge-ready: default-review policy',
    });
    const landed = svc.create({
      projectId: project.id,
      podName: 'builder',
      expectedOutput: { kind: 'repo', auto_land: true },
    });
    svc.setLanding({
      id: landed.id,
      landingStatus: 'landed',
      landedBranch: 'main',
      landedSha: 'a'.repeat(40),
      targetShaBefore: 'b'.repeat(40),
      targetShaAfter: 'c'.repeat(40),
      mergeSha: 'd'.repeat(40),
      landingAuthorizer: 'orchestrator',
      landedAt: 1234,
    });

    // list — newest-first, full DTOs
    const list = await fetch(`${base}/api/projects/${project.id}/contracts`).then(body);
    assert.equal(list.ok, true);
    assert.equal(list.contracts.length, 2);
    assert.equal(list.contracts[0].id, landed.id);
    const gotParked = list.contracts.find((c: Json) => c.id === parked.id);
    assert.equal(gotParked.verificationStatus, 'passed');
    assert.equal(gotParked.verificationNotes, 'parked merge-ready: default-review policy');
    assert.equal(gotParked.landingPolicy, 'default-review');
    assert.equal(gotParked.landingStatus, null);
    const gotLanded = list.contracts.find((c: Json) => c.id === landed.id);
    assert.equal(gotLanded.landingStatus, 'landed');
    assert.equal(gotLanded.targetShaBefore, 'b'.repeat(40));
    assert.equal(gotLanded.targetShaAfter, 'c'.repeat(40));
    assert.equal(gotLanded.mergeSha, 'd'.repeat(40));
    assert.equal(gotLanded.landingAuthorizer, 'orchestrator');
    assert.equal(gotLanded.landedAt, 1234);

    // unknown project → 404
    assert.equal((await fetch(`${base}/api/projects/${newId()}/contracts`)).status, 404);

    // detail
    const detail = await fetch(`${base}/api/contracts/${parked.id}`).then(body);
    assert.equal(detail.ok, true);
    assert.equal(detail.contract.id, parked.id);
    assert.equal(detail.contract.landingPolicy, 'default-review');

    // unknown contract → 404
    assert.equal((await fetch(`${base}/api/contracts/${newId()}`)).status, 404);
  } finally {
    await server.close();
  }
});

test('run list retention: preserved lifecycle states outlive the 24h window; uneventful runs age out', async () => {
  freshDb();
  const project = newProject();
  const { server, base } = await boot();
  try {
    const now = Date.now();
    const old = now - 25 * 60 * 60 * 1000;
    const mk = (status: 'queued' | 'running', lifecycleState?: 'merge-ready' | 'stranded') => {
      const id = newId() as ULID;
      insertAgentRunRow({
        id,
        projectId: project.id,
        ...testAgentRunExecution('builder'),
        dispatcherSessionId: 'disp-1',
        status: 'queued',
        input: 'x',
        lifecycleState: lifecycleState ?? null,
        queuedAt: old,
      });
      advanceTestAgentRunStatus(id, status);
      return id;
    };
    const finish = (id: ULID, completedAt: number) =>
      markAgentRunTerminal({
        id,
        status: 'completed',
        result: 'ok',
        failureCause: null,
        failureReason: null,
        completedAt,
      });

    const active = mk('running');
    const agedOut = mk('running');
    finish(agedOut, old); // uneventful, outside the window
    const recentTerminal = mk('running');
    finish(recentTerminal, now - 1000); // uneventful, inside the window
    const parkedMergeReady = mk('running', 'merge-ready');
    finish(parkedMergeReady, old); // preserved — stays despite age
    const strandedRun = mk('running', 'stranded');
    finish(strandedRun, old); // preserved — stays despite age

    const res = await fetch(`${base}/api/projects/${project.id}/agent-runs`).then(body);
    assert.equal(res.ok, true);
    const ids = res.runs.map((r: Json) => r.runId);
    assert.ok(ids.includes(active));
    assert.ok(ids.includes(recentTerminal));
    assert.ok(ids.includes(parkedMergeReady), 'merge-ready run must outlive the window');
    assert.ok(ids.includes(strandedRun), 'stranded run must outlive the window');
    assert.ok(!ids.includes(agedOut), 'uneventful old terminal run must age out');
    assert.equal(new Set(ids).size, ids.length, 'no duplicate rows');
    // the web keys the preserved split off lifecycleState — it must ride the DTO
    const preservedDto = res.runs.find((r: Json) => r.runId === parkedMergeReady);
    assert.equal(preservedDto.lifecycleState, 'merge-ready');
  } finally {
    await server.close();
  }
});

test('review checkout read exposes exact unresolved workspace authority and scopes it to the project', async () => {
  freshDb();
  const project = newProject();
  const producerRunId = newId() as ULID;
  insertAgentRunRow({
    id: producerRunId,
    projectId: project.id,
    ...testAgentRunExecution('builder'),
    dispatcherSessionId: 'disp-review-read',
    status: 'queued',
    input: 'build',
    queuedAt: Date.now(),
  });
  const contracts = new ContractService();
  const target = contracts.create({
    projectId: project.id,
    agentRunId: producerRunId,
    podName: 'builder',
    expectedOutput: { kind: 'repo', review: 'full' },
    landingPolicy: 'full-review',
  });
  const verified = contracts.setVerification({
    id: target.id,
    verificationStatus: 'passed',
  });
  assert.ok(verified);
  const reviewerRunId = newId() as ULID;
  const reservedTarget = contracts.reserveReview({
    id: verified.id,
    expectedVersion: verified.version,
    expectedReviewRunId: null,
    expectedAgentRunId: producerRunId,
    reviewRound: 1,
    reviewRunId: reviewerRunId,
    reviewSealedCommit: 'a'.repeat(40),
  });
  assert.ok(reservedTarget);
  const authority: ReviewCheckoutAuthority = {
    id: newId() as ULID,
    projectId: project.id,
    contractId: target.id as ULID,
    contractVersion: reservedTarget.version,
    producerRunId,
    reviewerRunId,
    repositoryIdentity: {
      protocol: 'git-common-dir-v1' as const,
      gitCommonDir: 'C:\\repo\\.git',
      leaseKey: `sha256:${'b'.repeat(64)}`,
    },
    worktreePath: `C:\\repo-worktrees\\review-${reviewerRunId.slice(-8)}`,
    ownedRootRealPath: 'C:\\repo-worktrees',
    sealedCommit: 'a'.repeat(40),
  };
  assert.ok(createReviewCheckoutReservation({ ...authority, createdAt: 10 }));

  const { server, base } = await boot();
  try {
    const response = await fetch(`${base}/api/projects/${project.id}/review-checkouts`).then(body);
    assert.equal(response.ok, true);
    assert.equal(response.reviewCheckouts.length, 1);
    assert.deepEqual(response.reviewCheckouts[0], {
      ...authority,
      status: 'reserved',
      provisionReceipt: null,
      preparationReceipt: null,
      readinessReceipt: null,
      teardownReceipt: null,
      cleanupError: null,
      createdAt: 10,
      updatedAt: 10,
      destroyedAt: null,
    });
    assert.equal(
      (await fetch(`${base}/api/projects/${newId()}/review-checkouts`)).status,
      404,
    );
  } finally {
    await server.close();
  }
});

test('abandonment HTTP authority is same-origin, no-store, JSON-only, and strictly parsed', async () => {
  freshDb();
  const project = newProject();
  const contractId = newId();
  const { server, base } = await boot();
  const url = `${base}/api/projects/${project.id}/contracts/${contractId}/abandonment`;
  try {
    const missingFetchMetadata = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: '{}',
    });
    assert.equal(missingFetchMetadata.status, 403);
    assert.equal(missingFetchMetadata.headers.get('cache-control'), 'no-store');

    const crossSitePreview = await fetch(`${url}-preview`, {
      headers: { 'Sec-Fetch-Site': 'cross-site' },
    });
    assert.equal(crossSitePreview.status, 403);
    assert.equal(crossSitePreview.headers.get('cache-control'), 'no-store');

    const wrongMediaType = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'text/plain',
        'Sec-Fetch-Site': 'same-origin',
      },
      body: '{}',
    });
    assert.equal(wrongMediaType.status, 400);

    const deceptiveMediaType = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/jsonx',
        'Sec-Fetch-Site': 'same-origin',
      },
      body: '{}',
    });
    assert.equal(deceptiveMediaType.status, 400);

    const parameterizedJson = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json; charset=utf-8',
        'Sec-Fetch-Site': 'same-origin',
      },
      body: JSON.stringify({
        requestId: '4cbfe782-bd4d-4a08-8261-d158251240fa',
        expectedContractVersion: 1,
        previewDigest: `sha256:${'a'.repeat(64)}`,
        confirmation: 'agent/test',
      }),
    });
    assert.notEqual(parameterizedJson.status, 400, 'valid JSON parameters pass media parsing');

    const malformed = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Sec-Fetch-Site': 'same-origin',
      },
      body: JSON.stringify({ requestId: 'not-a-uuid' }),
    });
    assert.equal(malformed.status, 400);
  } finally {
    await server.close();
  }
});
