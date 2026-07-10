// Guard: the HTTP surface speaks the @pc/contracts API the web chrome calls.
// Real Hono app on an ephemeral port; asserts the response SHAPES the client
// reducers/stores destructure (a 404 or a wrong key here is a broken app).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AccountRegistry } from '../src/runner/account-env.ts';
import { UsageCache } from '../src/usage/cache.ts';
import { FakeBackend } from '../src/runner/fake-backend.ts';
import { startServer, type RunningServer } from '../src/server.ts';
import { freshDb } from './helpers.ts';

// Response bodies are `unknown` under strict fetch types; tests assert on shapes.
type Json = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
const body = (r: Response): Promise<Json> => r.json() as Promise<Json>;

async function boot(): Promise<{ server: RunningServer; base: string; usage: UsageCache }> {
  const usage = new UsageCache();
  const server = await startServer({
    backendFactory: () => new FakeBackend({ turns: [] as never, stepDelayMs: 1 }),
    port: 0,
    runRecovery: false,
    accounts: new AccountRegistry(),
    usage,
  });
  return { server, base: `http://localhost:${server.port}`, usage };
}

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
    assert.ok(newSess.session.status === 'active' || newSess.session.status === 'ended');

    // list sessions → SessionSummary[]
    const sessions = await fetch(`${base}/api/projects/${project.id}/sessions`).then(body);
    assert.equal(sessions.ok, true);
    assert.ok(sessions.sessions.some((s: { id: string }) => s.id === newSess.session.id));

    // events → { ok, events, highWaterSeq }
    const events = await fetch(`${base}/api/projects/${project.id}/sessions/${newSess.session.id}/events`).then(body);
    assert.equal(events.ok, true);
    assert.ok(Array.isArray(events.events));
    assert.equal(typeof events.highWaterSeq, 'number');

    // usage re-prime → { snapshots }
    usage.record({
      accountId: 'personal',
      fiveHour: { utilization: 0.1, resetsAt: null },
      sevenDay: null,
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
