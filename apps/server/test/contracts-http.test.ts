// Slice G1 guards: the contract read routes (contractRoutes list/detail) speak
// full DTOs — merge receipt, landingPolicy, verificationNotes — and run-list
// retention is state-based (docs/worktree-lifecycle.md 'Teardown and
// retention'): preserved lifecycle states outlive the 24h terminal window.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ContractService } from '@pc/app-services';
import { insertAgentRunRow, markAgentRunTerminal, newId } from '@pc/db';
import type { ULID } from '@pc/domain';
import { AccountRegistry } from '../src/runner/account-env.ts';
import { RuntimeRegistry } from '../src/runner/runtime.ts';
import { UsageCache } from '../src/usage/cache.ts';
import { FakeRuntime } from '../src/runner/fake-runtime.ts';
import { DispatchService } from '../src/dispatch/service.ts';
import type { McpManager } from '../src/mcp/manager.ts';
import { startServer, type RunningServer } from '../src/server.ts';
import { freshDb, newProject } from './helpers.ts';

type Json = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
const body = (r: Response): Promise<Json> => r.json() as Promise<Json>;

async function boot(): Promise<{ server: RunningServer; base: string }> {
  const server = await startServer({
    mintSession: () => new FakeRuntime({ turns: [] as never, stepDelayMs: 1 }),
    port: 0,
    runRecovery: false,
    accounts: new AccountRegistry(),
    usage: new UsageCache(),
    // The agent-run/contract routes mount only when dispatch is supplied.
    dispatch: new DispatchService({
      runtimes: new RuntimeRegistry(),
      accounts: new AccountRegistry(),
      mcp: {} as McpManager,
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
        podName: 'builder',
        dispatcherSessionId: 'disp-1',
        ccSessionId: `cc-${id}`,
        status,
        input: 'x',
        lifecycleState: lifecycleState ?? null,
        queuedAt: old,
      });
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
    const agedOut = mk('queued');
    finish(agedOut, old); // uneventful, outside the window
    const recentTerminal = mk('queued');
    finish(recentTerminal, now - 1000); // uneventful, inside the window
    const parkedMergeReady = mk('queued', 'merge-ready');
    finish(parkedMergeReady, old); // preserved — stays despite age
    const strandedRun = mk('queued', 'stranded');
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
