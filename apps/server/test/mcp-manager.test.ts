// N6 MCP manager — explicit state machine (flap → degraded, down escalation,
// auth-expired), tool-cache invalidation + vanished-tool typed error, and
// consumer-filtered bridging. Deterministic: the live probe is injected.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  attachMcpConsumer,
  createMcpServerRegistry,
  getMcpServerRegistry,
} from '@pc/db';
import type { McpServerTransport, ULID } from '@pc/domain';
import type { DiscoverResult, RemoteTool } from '../src/mcp/client.ts';
import { McpManager } from '../src/mcp/manager.ts';
import { freshDb } from './helpers.ts';

const tool = (name: string): RemoteTool => ({ name, description: '', inputSchema: { type: 'object' } });

/** A scriptable probe keyed by transport url: each call shifts the next queued
 *  outcome (the last one sticks once the queue is drained). */
function scriptedProbe() {
  const queues = new Map<string, DiscoverResult[]>();
  const probeFn = (t: McpServerTransport): Promise<DiscoverResult> => {
    const key = t.url ?? t.command ?? '';
    const q = queues.get(key) ?? [];
    const next = q.length > 1 ? q.shift()! : q[0];
    return Promise.resolve(next ?? { ok: false, error: 'no script' });
  };
  const push = (url: string, ...outcomes: DiscoverResult[]) => queues.set(url, outcomes);
  return { probeFn, push };
}

function makeServer(name: string, url: string): ULID {
  return createMcpServerRegistry({ scope: 'global', name, transport: { type: 'http', url } }).id;
}

test('healthy → degraded on a transient failure after a prior success', async () => {
  freshDb();
  const { probeFn, push } = scriptedProbe();
  const url = 'https://a.example/mcp';
  const id = makeServer('srv-a', url);
  const mcp = new McpManager({ probeFn });
  mcp.syncFromRegistry();

  push(url, { ok: true, tools: [tool('x')] });
  assert.equal((await mcp.probe(id)).status, 'healthy');

  push(url, { ok: false, error: 'connection reset' });
  const s = await mcp.probe(id);
  assert.equal(s.status, 'degraded', 'a first failure after success is degraded, not down');
  assert.equal(s.lastError, 'connection reset');
  assert.equal(getMcpServerRegistry(id)!.healthState, 'degraded', 'state is persisted');
});

test('flapping is pinned degraded — a recovery after a failure does not read healthy', async () => {
  freshDb();
  const { probeFn, push } = scriptedProbe();
  const url = 'https://flap.example/mcp';
  const id = makeServer('flap', url);
  const mcp = new McpManager({ probeFn });
  mcp.syncFromRegistry();

  push(url, { ok: true, tools: [tool('x')] });
  await mcp.probe(id); // healthy
  push(url, { ok: false, error: 'drop' });
  await mcp.probe(id); // degraded
  push(url, { ok: true, tools: [tool('x')] });
  const recovered = await mcp.probe(id);
  assert.equal(recovered.status, 'degraded', 'recovery inside the flap window stays degraded');
  assert.match(recovered.reason ?? '', /flapping/);
});

test('sustained failure escalates degraded → down', async () => {
  freshDb();
  const { probeFn, push } = scriptedProbe();
  const url = 'https://down.example/mcp';
  const id = makeServer('down', url);
  const mcp = new McpManager({ probeFn });
  mcp.syncFromRegistry();

  push(url, { ok: true, tools: [tool('x')] });
  await mcp.probe(id); // healthy
  push(url, { ok: false, error: 'e' });
  assert.equal((await mcp.probe(id)).status, 'degraded'); // 1
  assert.equal((await mcp.probe(id)).status, 'degraded'); // 2
  assert.equal((await mcp.probe(id)).status, 'down', 'third consecutive failure is down'); // 3
});

test('never-connected server goes straight to down', async () => {
  freshDb();
  const { probeFn, push } = scriptedProbe();
  const url = 'https://cold.example/mcp';
  const id = makeServer('cold', url);
  const mcp = new McpManager({ probeFn });
  mcp.syncFromRegistry();
  push(url, { ok: false, error: 'refused' });
  assert.equal((await mcp.probe(id)).status, 'down');
});

test('an auth-shaped failure is the distinct auth-expired state', async () => {
  freshDb();
  const { probeFn, push } = scriptedProbe();
  const url = 'https://auth.example/mcp';
  const id = makeServer('auth', url);
  const mcp = new McpManager({ probeFn });
  mcp.syncFromRegistry();
  push(url, { ok: false, error: 'HTTP 401 Unauthorized' });
  const s = await mcp.probe(id);
  assert.equal(s.status, 'auth-expired');
  assert.equal(getMcpServerRegistry(id)!.healthState, 'auth-expired');
});

test('tool cache invalidates on reconnect; a vanished tool is not live', async () => {
  freshDb();
  const { probeFn, push } = scriptedProbe();
  const url = 'https://tools.example/mcp';
  const id = makeServer('tools', url);
  const mcp = new McpManager({ probeFn });
  mcp.syncFromRegistry();

  push(url, { ok: true, tools: [tool('alpha'), tool('beta')] });
  await mcp.probe(id);
  assert.equal(mcp.isToolLive(id, 'alpha'), true);
  assert.equal(mcp.isToolLive(id, 'beta'), true);

  // Reconnect: beta vanished.
  push(url, { ok: true, tools: [tool('alpha')] });
  await mcp.probe(id);
  assert.equal(mcp.isToolLive(id, 'alpha'), true);
  assert.equal(mcp.isToolLive(id, 'beta'), false, 'vanished tool is no longer live');
});

test('a vanished tool held by an in-flight bridge returns a typed error, not a hang', async () => {
  freshDb();
  const { probeFn, push } = scriptedProbe();
  const url = 'https://vanish.example/mcp';
  const id = makeServer('vanish', url);
  attachMcpConsumer({ mcpServerId: id, consumer: 'orchestrator' });
  const mcp = new McpManager({ probeFn });
  mcp.syncFromRegistry();

  push(url, { ok: true, tools: [tool('gone')] });
  await mcp.probe(id);
  const bridge = mcp.buildBridge(); // captures the 'gone' handler
  const def = bridge.toolDefs.find((d) => d.name.endsWith('__gone'));
  assert.ok(def, 'tool is bridged while healthy');

  // Reconnect: 'gone' disappears.
  push(url, { ok: true, tools: [] });
  await mcp.probe(id);

  const result = await def!.handler({});
  assert.equal(result.isError, true);
  assert.match(result.content[0].text, /no longer available/);
});

test('the bridge only exposes servers attached to the consumer (default orchestrator-only)', async () => {
  freshDb();
  const { probeFn, push } = scriptedProbe();
  const urlO = 'https://orch.example/mcp';
  const urlF = 'https://foo.example/mcp';
  const orchId = makeServer('orch-srv', urlO);
  const fooId = makeServer('foo-srv', urlF);
  attachMcpConsumer({ mcpServerId: orchId, consumer: 'orchestrator' });
  attachMcpConsumer({ mcpServerId: fooId, consumer: 'agent:foo' });

  const mcp = new McpManager({ probeFn });
  mcp.syncFromRegistry();
  push(urlO, { ok: true, tools: [tool('orch_tool')] });
  push(urlF, { ok: true, tools: [tool('foo_tool')] });
  await mcp.probe(orchId);
  await mcp.probe(fooId);

  const orchBridge = mcp.buildBridge();
  assert.ok(orchBridge.toolDefs.some((d) => d.name.endsWith('__orch_tool')));
  assert.ok(!orchBridge.toolDefs.some((d) => d.name.endsWith('__foo_tool')), 'orchestrator cannot see the foo-only server');

  const fooBridge = mcp.buildBridge({ kind: 'agent', name: 'foo' });
  assert.ok(fooBridge.toolDefs.some((d) => d.name.endsWith('__foo_tool')));
  assert.ok(!fooBridge.toolDefs.some((d) => d.name.endsWith('__orch_tool')));
});

test('a down server never blocks the bridge — it is simply absent', async () => {
  freshDb();
  const { probeFn, push } = scriptedProbe();
  const urlUp = 'https://up.example/mcp';
  const urlDown = 'https://dead.example/mcp';
  const upId = makeServer('up', urlUp);
  const downId = makeServer('dead', urlDown);
  attachMcpConsumer({ mcpServerId: upId, consumer: 'orchestrator' });
  attachMcpConsumer({ mcpServerId: downId, consumer: 'orchestrator' });

  const mcp = new McpManager({ probeFn });
  mcp.syncFromRegistry();
  push(urlUp, { ok: true, tools: [tool('live')] });
  push(urlDown, { ok: false, error: 'refused' });
  await mcp.probe(upId);
  await mcp.probe(downId);

  const bridge = mcp.buildBridge();
  assert.ok(bridge.toolDefs.some((d) => d.name.endsWith('__live')));
  assert.equal(bridge.toolDefs.length, 1, 'only the healthy server is bridged');
});
