// N6 MCP manager HTTP surface — CRUD, write-only secret + presence, manual
// reprobe, explicit attachment, and degrade-never-block. The live probe is
// injected so endpoint background reprobes are deterministic.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { SubscriptionQuotaService } from '@pc/app-services';
import type { McpServerTransport } from '@pc/domain';
import { AccountRegistry } from '../src/runner/account-env.ts';
import { FakeRuntime } from '../src/runner/fake-runtime.ts';
import { startServer, type RunningServer } from '../src/server.ts';
import { McpManager } from '../src/mcp/manager.ts';
import type { DiscoverResult } from '../src/mcp/client.ts';
import { freshDb } from './helpers.ts';
import { TEST_RUNTIME_ID, testSessionSelectionDeps, withRuntimeReceipt } from './runtime-fixtures.ts';

type Json = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
const body = (r: Response): Promise<Json> => r.json() as Promise<Json>;
const json = (method: string, payload?: unknown): RequestInit => ({
  method,
  headers: { 'content-type': 'application/json' },
  ...(payload !== undefined ? { body: JSON.stringify(payload) } : {}),
});

async function boot(probeFn: (t: McpServerTransport) => Promise<DiscoverResult>): Promise<{ server: RunningServer; base: string; mcp: McpManager }> {
  const mcp = new McpManager({ probeFn });
  const server = await startServer({
    mintSession: withRuntimeReceipt(() => new FakeRuntime({ turns: [] as never, stepDelayMs: 1 })),
    ...testSessionSelectionDeps(),
    port: 0,
    runRecovery: false,
    accounts: new AccountRegistry(),
    orchestratorRuntimeId: TEST_RUNTIME_ID,
    subscriptionQuota: new SubscriptionQuotaService(),
    mcp,
  });
  return { server, base: `http://localhost:${server.port}`, mcp };
}

const okProbe: (t: McpServerTransport) => Promise<DiscoverResult> = () =>
  Promise.resolve({ ok: true, tools: [{ name: 'ping', description: '', inputSchema: { type: 'object' } }] });

test('create → list → patch → delete, with a default orchestrator attachment', async () => {
  freshDb();
  const { server, base } = await boot(okProbe);
  try {
    const created = await fetch(`${base}/api/mcp`, json('POST', {
      name: 'my-server',
      transport: { url: 'https://my.example/mcp' },
    })).then(body);
    assert.equal(created.ok, true);
    assert.equal(created.server.name, 'my-server');
    assert.equal(created.server.enabled, true);
    assert.deepEqual(created.server.consumers, ['orchestrator'], 'defaults to orchestrator-only');
    const id = created.server.id;

    const list = await fetch(`${base}/api/mcp`).then(body);
    assert.ok(list.servers.some((s: Json) => s.id === id));
    assert.ok('health' in list.servers[0], 'list carries full health detail');

    const patched = await fetch(`${base}/api/mcp/${id}`, json('PATCH', { enabled: false, description: 'off' })).then(body);
    assert.equal(patched.server.enabled, false);
    assert.equal(patched.server.description, 'off');

    const del = await fetch(`${base}/api/mcp/${id}`, json('DELETE')).then(body);
    assert.equal(del.ok, true);
    const after = await fetch(`${base}/api/mcp`).then(body);
    assert.ok(!after.servers.some((s: Json) => s.id === id), 'soft-deleted server is gone from the list');
  } finally {
    await server.close();
  }
});

test('secret is write-only — the value never comes back from any read', async () => {
  freshDb();
  const { server, base } = await boot(okProbe);
  try {
    const id = (await fetch(`${base}/api/mcp`, json('POST', { name: 's', transport: { url: 'https://s.example/mcp' } })).then(body)).server.id;
    const wrote = await fetch(`${base}/api/mcp/${id}/secret`, json('POST', { value: 'Bearer TOP-SECRET' }));
    assert.equal(wrote.status, 201);
    const wroteBody = await body(wrote);
    assert.equal(wroteBody.secret.present, true);
    assert.equal(JSON.stringify(wroteBody).includes('TOP-SECRET'), false);

    const detail = await fetch(`${base}/api/mcp/${id}`).then(body);
    assert.equal(detail.server.secret.present, true);
    assert.equal(JSON.stringify(detail).includes('TOP-SECRET'), false, 'read endpoints never leak the secret');
  } finally {
    await server.close();
  }
});

test('attachment read/write drives the consumer set', async () => {
  freshDb();
  const { server, base } = await boot(okProbe);
  try {
    const id = (await fetch(`${base}/api/mcp`, json('POST', { name: 'a', transport: { url: 'https://a.example/mcp' } })).then(body)).server.id;
    await fetch(`${base}/api/mcp/${id}/attachments`, json('POST', { consumer: 'agent:researcher' }));
    const listed = await fetch(`${base}/api/mcp/${id}/attachments`).then(body);
    assert.deepEqual(listed.consumers.sort(), ['agent:researcher', 'orchestrator']);

    const bad = await fetch(`${base}/api/mcp/${id}/attachments`, json('POST', { consumer: 'nonsense' }));
    assert.equal(bad.status, 400);

    const detached = await fetch(`${base}/api/mcp/${id}/attachments`, json('DELETE', { consumer: 'orchestrator' })).then(body);
    assert.deepEqual(detached.consumers, ['agent:researcher']);
  } finally {
    await server.close();
  }
});

test('manual probe returns the explicit health state', async () => {
  freshDb();
  const { server, base } = await boot(okProbe);
  try {
    const id = (await fetch(`${base}/api/mcp`, json('POST', { name: 'p', transport: { url: 'https://p.example/mcp' } })).then(body)).server.id;
    const probed = await fetch(`${base}/api/mcp/${id}/probe`, json('POST')).then(body);
    assert.equal(probed.ok, true);
    assert.equal(probed.health.status, 'healthy');
    assert.equal(probed.health.toolCount, 1);
  } finally {
    await server.close();
  }
});

test('endpoints reject bad input and unknown ids', async () => {
  freshDb();
  const { server, base } = await boot(okProbe);
  try {
    assert.equal((await fetch(`${base}/api/mcp`, json('POST', { name: '' }))).status, 400);
    assert.equal((await fetch(`${base}/api/mcp`, json('POST', { name: 'x', transport: {} }))).status, 400);
    assert.equal((await fetch(`${base}/api/mcp/01UNKNOWN000000000000000000`)).status, 404);
    assert.equal((await fetch(`${base}/api/mcp/01UNKNOWN000000000000000000/probe`, json('POST'))).status, 404);
  } finally {
    await server.close();
  }
});
