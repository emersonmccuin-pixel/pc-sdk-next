// Agent-pool route contract: create is always global, stock rows are locked
// (orchestrator carve-out), attach/detach drives project visibility, and every
// mutation writes a `specialist` outbox row for the live roster refetch.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { getLiveEventHighWater, listLiveOutboxRowsAfter } from '@pc/db';
import { AccountRegistry } from '../src/runner/account-env.ts';
import { UsageCache } from '../src/usage/cache.ts';
import { FakeBackend } from '../src/runner/fake-backend.ts';
import { startServer, type RunningServer } from '../src/server.ts';
import { seedStockAgents } from '../src/agents/seed.ts';
import { freshDb, newProject } from './helpers.ts';

type Json = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
const body = (r: Response): Promise<Json> => r.json() as Promise<Json>;

async function boot(): Promise<{ server: RunningServer; base: string }> {
  const server = await startServer({
    backendFactory: () => new FakeBackend({ turns: [] as never, stepDelayMs: 1 }),
    port: 0,
    runRecovery: false,
    accounts: new AccountRegistry(),
    usage: new UsageCache(),
  });
  return { server, base: `http://localhost:${server.port}` };
}

const json = (method: string, payload?: unknown): RequestInit => ({
  method,
  headers: { 'content-type': 'application/json' },
  ...(payload !== undefined ? { body: JSON.stringify(payload) } : {}),
});

function specialistRowsSince(cursor: string | null): Json[] {
  return listLiveOutboxRowsAfter(cursor ?? '0', 100).filter((e) => e.entity === 'specialist') as Json[];
}

test('agent pool: create → attach → visible in project; scope invariant; outbox frames', async () => {
  freshDb();
  seedStockAgents();
  const { server, base } = await boot();
  const project = newProject('agents-a');
  const other = newProject('agents-b');
  try {
    const before = getLiveEventHighWater();
    const created = await fetch(
      `${base}/api/agents/pods`,
      json('POST', { name: 'my-helper', prompt: 'help', model: 'sonnet', tools: ['Read'], attachProjectId: project.id }),
    ).then(body);
    assert.equal(created.ok, true);
    assert.equal(created.pod.scope, 'global', 'create must always produce a global pool agent');
    assert.equal(created.pod.origin, 'user-created');
    assert.deepEqual(created.pod.memberProjectIds, [project.id]);
    assert.equal(created.pod.driftedFields, null, 'user agents carry no drift annotation');

    // Outbox: a global content frame + a project membership frame.
    const rows = specialistRowsSince(before);
    assert.ok(rows.some((r) => r.scope === 'global' && r.entityId === created.pod.id));
    assert.ok(rows.some((r) => r.scope === 'project' && r.projectId === project.id));

    // Visible in the attached project (stock ∪ members), absent from the other.
    const inProject = await fetch(`${base}/api/agents/pods?projectId=${project.id}`).then(body);
    assert.ok(inProject.pods.some((p: Json) => p.name === 'my-helper'));
    assert.ok(inProject.pods.some((p: Json) => p.origin === 'stock'), 'stock agents implicit in every project');
    const inOther = await fetch(`${base}/api/agents/pods?projectId=${other.id}`).then(body);
    assert.ok(!inOther.pods.some((p: Json) => p.name === 'my-helper'));

    // Attach to the other project, then detach — visibility follows.
    const attach = await fetch(`${base}/api/agents/pods/${created.pod.id}/projects/${other.id}`, json('PUT')).then(body);
    assert.deepEqual(new Set(attach.memberProjectIds), new Set([project.id, other.id]));
    const detach = await fetch(`${base}/api/agents/pods/${created.pod.id}/projects/${other.id}`, json('DELETE')).then(body);
    assert.deepEqual(detach.memberProjectIds, [project.id]);

    // Duplicate name (incl. stock names) → 400.
    const dupe = await fetch(`${base}/api/agents/pods`, json('POST', { name: 'researcher' }));
    assert.equal(dupe.status, 400);
  } finally {
    await server.close();
  }
});

test('stock lock: specialists 409, orchestrator editable except name; delete + reset rules', async () => {
  freshDb();
  seedStockAgents();
  const { server, base } = await boot();
  try {
    const pool = await fetch(`${base}/api/agents/pods`).then(body);
    const researcher = pool.pods.find((p: Json) => p.name === 'researcher');
    const orchestrator = pool.pods.find((p: Json) => p.name === 'orchestrator');
    assert.ok(researcher && orchestrator);

    // Specialist: PATCH + DELETE + attach all refused.
    const patchStock = await fetch(`${base}/api/agents/pods/${researcher.id}`, json('PATCH', { prompt: 'x' }));
    assert.equal(patchStock.status, 409);
    assert.equal((await body(patchStock)).kind, 'stock-locked');
    assert.equal((await fetch(`${base}/api/agents/pods/${researcher.id}`, json('DELETE'))).status, 409);
    const proj = newProject('stock-attach');
    assert.equal(
      (await fetch(`${base}/api/agents/pods/${researcher.id}/projects/${proj.id}`, json('PUT'))).status,
      409,
      'stock agents are implicitly attached — explicit attach refused',
    );

    // Orchestrator: prompt/model editable, name locked, reset restores.
    const edit = await fetch(
      `${base}/api/agents/pods/${orchestrator.id}`,
      json('PATCH', { prompt: 'custom orchestrator', model: 'sonnet' }),
    ).then(body);
    assert.equal(edit.ok, true);
    assert.equal(edit.pod.prompt, 'custom orchestrator');
    assert.deepEqual(new Set(edit.pod.driftedFields), new Set(['prompt', 'model']));
    const rename = await fetch(`${base}/api/agents/pods/${orchestrator.id}`, json('PATCH', { name: 'boss' }));
    assert.equal(rename.status, 409);
    const reset = await fetch(`${base}/api/agents/pods/${orchestrator.id}/reset-to-default`, json('POST')).then(body);
    assert.equal(reset.ok, true);
    assert.deepEqual(new Set(reset.resetFields), new Set(['prompt', 'model']));
    assert.deepEqual(reset.pod.driftedFields, []);

    // Reset on a user agent → 409.
    const user = await fetch(`${base}/api/agents/pods`, json('POST', { name: 'resettable' })).then(body);
    assert.equal(
      (await fetch(`${base}/api/agents/pods/${user.pod.id}/reset-to-default`, json('POST'))).status,
      409,
    );
  } finally {
    await server.close();
  }
});

test('validation: bad names, bad effort, empty patch, unknown ids', async () => {
  freshDb();
  const { server, base } = await boot();
  try {
    assert.equal((await fetch(`${base}/api/agents/pods`, json('POST', { name: 'Bad Name' }))).status, 400);
    assert.equal((await fetch(`${base}/api/agents/pods`, json('POST', { name: 'ok', effort: 'huge' }))).status, 400);
    const created = await fetch(`${base}/api/agents/pods`, json('POST', { name: 'v-agent' })).then(body);
    assert.equal((await fetch(`${base}/api/agents/pods/${created.pod.id}`, json('PATCH', {}))).status, 400);
    assert.equal((await fetch(`${base}/api/agents/pods/01JUNKJUNKJUNKJUNKJUNKJUNK`)).status, 404);
  } finally {
    await server.close();
  }
});
