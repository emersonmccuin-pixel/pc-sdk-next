// Guard: the HTTP surface speaks the @pc/contracts API the web chrome calls.
// Real Hono app on an ephemeral port; asserts the response SHAPES the client
// reducers/stores destructure (a 404 or a wrong key here is a broken app).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  enqueueConversationSend,
  getActiveOrchestratorSession,
  getConversationQueueSnapshot,
  getOrchestratorSession,
  getProjectById,
  getRawDb,
} from '@pc/db';
import { AccountRegistry } from '../src/runner/account-env.ts';
import { UsageCache } from '../src/usage/cache.ts';
import { FakeRuntime } from '../src/runner/fake-runtime.ts';
import { startServer, type RunningServer } from '../src/server.ts';
import { freshDb, until } from './helpers.ts';
import {
  TEST_RUNTIME_ID,
  testSessionSelectionDeps,
  withRuntimeReceipt,
} from './runtime-fixtures.ts';

// Response bodies are `unknown` under strict fetch types; tests assert on shapes.
type Json = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
const body = (r: Response): Promise<Json> => r.json() as Promise<Json>;

async function boot(): Promise<{ server: RunningServer; base: string; usage: UsageCache }> {
  const usage = new UsageCache();
  const server = await startServer({
    mintSession: withRuntimeReceipt(() => new FakeRuntime({ turns: [] as never, stepDelayMs: 1 })),
    ...testSessionSelectionDeps(),
    port: 0,
    instanceId: 'pc-sdk-next-test',
    runRecovery: false,
    accounts: new AccountRegistry(),
    orchestratorRuntimeId: TEST_RUNTIME_ID,
    usage,
  });
  return { server, base: `http://localhost:${server.port}`, usage };
}

test('health positively identifies the PC-SDK Next instance', async () => {
  freshDb();
  const { server, base } = await boot();
  try {
    const health = await fetch(`${base}/health`).then(body);
    assert.equal(health.ok, true);
    assert.equal(health.name, '@pc-sdk/server');
    assert.equal(health.instanceId, 'pc-sdk-next-test');
  } finally {
    await server.close();
  }
});

test('settings: GET returns the singleton; PATCH round-trips', async () => {
  freshDb();
  const { server, base } = await boot();
  try {
    const got = await fetch(`${base}/api/settings`).then(body);
    assert.equal(got.ok, true);
    assert.ok('projectsFolder' in got.settings && 'onboardingCompletedAt' in got.settings);

    const patched = await fetch(`${base}/api/settings`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ projectsFolder: 'D:\\Proj', onboardingCompletedAt: '2026-07-10T00:00:00Z' }),
    }).then(body);
    assert.equal(patched.ok, true);
    assert.equal(patched.settings.projectsFolder, 'D:\\Proj');
    assert.equal(patched.settings.onboardingCompletedAt, '2026-07-10T00:00:00Z');
  } finally {
    await server.close();
  }
});

test('projects: probe → create (contract shape) → list → detail; sessions + usage + image', async () => {
  freshDb();
  const { server, base, usage } = await boot();
  const dir = mkdtempSync(join(tmpdir(), 'pc-probe-'));
  try {
    // fs/probe
    const probe = await fetch(`${base}/api/fs/probe`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ path: dir }),
    }).then(body);
    assert.equal(probe.ok, true);
    assert.equal(probe.probe.exists, true);
    assert.equal(probe.probe.isDirectory, true);

    // create — the contract request body (folder_path + mode)
    const created = await fetch(`${base}/api/projects`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'Alpha', folder_path: dir, mode: 'init-empty' }),
    }).then(body);
    assert.equal(created.ok, true);
    const project = created.project;
    assert.ok(project.id && project.slug);
    assert.deepEqual(project.stages, []);
    assert.ok('cancelledVisibility' in project.settings && 'remoteControl' in project.settings);

    // list is ProjectDto[]
    const list = await fetch(`${base}/api/projects`).then(body);
    assert.ok(Array.isArray(list.projects) && list.projects.some((p: { id: string }) => p.id === project.id));

    // detail is a RAW ProjectDto (web reads getJson<ProjectDto> unwrapped)
    const detail = await fetch(`${base}/api/projects/${project.id}`).then(body);
    assert.equal(detail.id, project.id);

    // session new → transition + SessionSummary
    const newSess = await fetch(`${base}/api/projects/${project.id}/sessions/new`, { method: 'POST' }).then(body);
    assert.equal(newSess.ok, true);
    assert.equal(newSess.transition, 'new-session');
    assert.ok(newSess.session.id);
    assert.equal(newSess.session.status, 'active');
    assert.deepEqual(newSess.session.selection, {
      runtimeId: TEST_RUNTIME_ID,
      accountId: 'personal',
      model: 'opus',
      effort: { kind: 'none' },
    });
    assert.equal(newSess.session.nativeSessionIdPresent, false);
    assert.equal(newSess.session.continuationState, 'clean-pending');
    assert.deepEqual(newSess.session.resumeAvailability, {
      status: 'unavailable', code: 'session-active',
    });
    assert.equal('nativeSessionId' in newSess.session, false);

    // list sessions → SessionSummary[]
    const sessions = await fetch(`${base}/api/projects/${project.id}/sessions`).then(body);
    assert.equal(sessions.ok, true);
    assert.ok(sessions.sessions.some((s: { id: string }) => s.id === newSess.session.id));

    // events → { ok, events, highWaterSequence }
    const events = await fetch(`${base}/api/projects/${project.id}/sessions/${newSess.session.id}/events`).then(body);
    assert.equal(events.ok, true);
    assert.ok(Array.isArray(events.events));
    assert.equal(typeof events.highWaterSequence, 'number');

    // A route project cannot read another project's conversation by guessing
    // its session id.
    const otherDir = mkdtempSync(join(tmpdir(), 'pc-probe-other-'));
    const other = await fetch(`${base}/api/projects`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'Beta', folder_path: otherDir, mode: 'init-empty' }),
    }).then(body);
    const foreignEvents = await fetch(
      `${base}/api/projects/${other.project.id}/sessions/${newSess.session.id}/events`,
    );
    assert.equal(foreignEvents.status, 404);

    // usage re-prime → { snapshots }
    usage.record({
      accountId: 'personal',
      fiveHour: { utilization: 0.1, resetsAt: null },
      sevenDay: null,
      fable: null,
      status: 'allowed',
      model: null,
      updatedAt: Date.now(),
    });
    const usageRes = await fetch(`${base}/api/usage`).then(body);
    assert.ok(Array.isArray(usageRes.snapshots) && usageRes.snapshots[0].accountId === 'personal');

    // pasted image → multipart 'image' field
    const form = new FormData();
    form.append('image', new Blob([new Uint8Array([1, 2, 3])], { type: 'image/png' }), 'p.png');
    const img = await fetch(`${base}/api/projects/${project.id}/pasted-images`, {
      method: 'POST',
      body: form,
    }).then(body);
    assert.equal(img.ok, true);
    assert.ok(img.path.endsWith('.png'));
  } finally {
    await server.close();
  }
});

test('accounts: registry list; switching a project account ends the session + mints a new one', async () => {
  freshDb();
  const { server, base } = await boot();
  const dir = mkdtempSync(join(tmpdir(), 'pc-acct-'));
  try {
    // registry list + server default
    const reg = await fetch(`${base}/api/accounts`).then(body);
    assert.ok(Array.isArray(reg.accounts) && reg.accounts.some((a: { id: string }) => a.id === 'personal'));
    assert.equal(reg.defaultAccountId, 'personal');

    const created = await fetch(`${base}/api/projects`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'Acct', folder_path: dir, mode: 'init-empty' }),
    }).then(body);
    const pid = created.project.id;

    // per-project current default
    assert.equal((await fetch(`${base}/api/projects/${pid}/account`).then(body)).accountId, 'personal');

    // start a session under the current account
    const sess = await fetch(`${base}/api/projects/${pid}/sessions/new`, { method: 'POST' }).then(body);
    const oldSessionId = sess.session.id;
    const initialService = server.registry.get(pid);
    assert.equal((await initialService.handleSend({
      type: 'send', commandId: 'bind-personal-session', sessionId: oldSessionId,
      text: 'bind the native session', clientMessageId: 'bind-personal-client',
    })).status, 'applied');
    await until(() => getOrchestratorSession(oldSessionId)?.nativeIdentityState === 'bound');

    // switch account → ends the old session, mints a new one
    const sw = await fetch(`${base}/api/projects/${pid}/account`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ accountId: 'work' }),
    }).then(body);
    assert.equal(sw.accountId, 'work');
    assert.equal(sw.switched, true);
    assert.ok(sw.session && sw.session.id && sw.session.id !== oldSessionId);
    assert.equal(sw.session.selection.accountId, 'work');
    assert.equal(sw.session.continuationState, 'clean-pending');
    assert.equal(sw.session.nativeSessionIdPresent, false);

    // the change is persisted as the project default
    assert.equal((await fetch(`${base}/api/projects/${pid}/account`).then(body)).accountId, 'work');

    // old session ended, new session active
    const list = await fetch(`${base}/api/projects/${pid}/sessions`).then(body);
    const oldSummary = list.sessions.find((s: { id: string }) => s.id === oldSessionId);
    assert.equal(oldSummary.status, 'ended');
    assert.equal(oldSummary.selection.accountId, 'personal');
    assert.equal(oldSummary.nativeSessionIdPresent, true);
    assert.equal(oldSummary.continuationState, 'clean-started');
    assert.deepEqual(oldSummary.resumeAvailability, { status: 'available' });
    assert.equal(oldSummary.continuationState === 'legacy-unavailable', false);
    assert.equal(list.sessions.find((s: { id: string }) => s.id === sw.session.id).status, 'active');

    // same account again → no-op, no new session
    const noop = await fetch(`${base}/api/projects/${pid}/account`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ accountId: 'work' }),
    }).then(body);
    assert.equal(noop.switched, false);
    assert.equal(noop.session, null);

    // Historical account A resumes through its immutable stamp even though the
    // project default remains B. This is native continuation, never a clean fallback.
    const resumedResponse = await fetch(
      `${base}/api/projects/${pid}/sessions/${oldSessionId}/resume`,
      { method: 'POST' },
    );
    assert.equal(resumedResponse.status, 200);
    const resumed = await body(resumedResponse);
    assert.equal(resumed.transition, 'resume-session');
    assert.equal(resumed.session.id, oldSessionId);
    assert.equal(resumed.session.selection.accountId, 'personal');
    assert.equal(resumed.session.resumeAvailability.code, 'session-active');
    assert.equal((await fetch(`${base}/api/projects/${pid}/account`).then(body)).accountId, 'personal');
    assert.equal(getProjectById(pid)?.settings.defaultAccountId, 'work');

    // unknown account → 400
    const bad = await fetch(`${base}/api/projects/${pid}/account`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ accountId: 'nope' }),
    });
    assert.equal(bad.status, 400);
  } finally {
    await server.close();
  }
});

test('account switch rolls back setting, queue, and old session when replacement creation fails', async () => {
  freshDb();
  const { server, base } = await boot();
  const dir = mkdtempSync(join(tmpdir(), 'pc-acct-rollback-'));
  try {
    const created = await fetch(`${base}/api/projects`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'Acct rollback', folder_path: dir, mode: 'init-empty' }),
    }).then(body);
    const projectId = created.project.id;
    const started = await fetch(
      `${base}/api/projects/${projectId}/sessions/new`,
      { method: 'POST' },
    ).then(body);
    const sessionId = started.session.id;
    assert.equal(enqueueConversationSend({
      projectId,
      conversationId: sessionId,
      sessionId,
      commandId: 'account-rollback-send',
      clientMessageId: 'account-rollback-client',
      text: 'preserve me',
      origin: 'user',
    }).status, 'applied');

    const raw = getRawDb();
    raw.exec(`
      CREATE TEMP TRIGGER fail_account_replacement
      BEFORE INSERT ON orchestrator_sessions
      BEGIN SELECT RAISE(ABORT, 'forced account replacement failure'); END;
    `);
    const failed = await fetch(`${base}/api/projects/${projectId}/account`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ accountId: 'work' }),
    });
    raw.exec('DROP TRIGGER fail_account_replacement');
    assert.equal(failed.status, 500);

    assert.equal(getProjectById(projectId)?.settings.defaultAccountId, null);
    assert.equal(getActiveOrchestratorSession(projectId)?.id, sessionId);
    assert.equal(getConversationQueueSnapshot(sessionId).items[0]?.status, 'queued');
  } finally {
    await server.close();
  }
});

test('project delete cancels idle FIFO state and fences an already-held service', async () => {
  freshDb();
  const { server, base } = await boot();
  const dir = mkdtempSync(join(tmpdir(), 'pc-delete-fence-'));
  try {
    const created = await fetch(`${base}/api/projects`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'Delete fence', folder_path: dir, mode: 'init-empty' }),
    }).then(body);
    const projectId = created.project.id;
    const started = await fetch(
      `${base}/api/projects/${projectId}/sessions/new`,
      { method: 'POST' },
    ).then(body);
    const sessionId = started.session.id;
    const heldService = server.registry.get(projectId);
    assert.equal(enqueueConversationSend({
      projectId,
      conversationId: sessionId,
      sessionId,
      commandId: 'delete-fence-send',
      clientMessageId: 'delete-fence-client',
      text: 'cancel me',
      origin: 'user',
    }).status, 'applied');

    const deleted = await fetch(`${base}/api/projects/${projectId}`, { method: 'DELETE' });
    assert.equal(deleted.status, 200);
    assert.equal(getProjectById(projectId), null);
    assert.equal(getActiveOrchestratorSession(projectId), null);
    assert.deepEqual(getConversationQueueSnapshot(sessionId).items, []);

    const afterDelete = await heldService.handleSend({
      type: 'send', commandId: 'delete-fence-after', sessionId,
      text: 'must not execute', clientMessageId: 'delete-fence-after-client',
    });
    assert.equal(afterDelete.status, 'rejected');
    assert.equal(afterDelete.error?.code, 'session-changed');
  } finally {
    await server.close();
  }
});
