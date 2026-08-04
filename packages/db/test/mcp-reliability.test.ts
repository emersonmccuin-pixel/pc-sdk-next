// N6 migration 0020 — mcp_servers health bookkeeping columns, the
// mcp_consumer_attachments table, health writer, and idempotent attach.

import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const tmpDir = mkdtempSync(join(tmpdir(), 'pc-mcp-reliability-'));
process.env.PC_DATA_DIR = tmpDir;

const {
  assertSchemaIntact,
  attachMcpConsumer,
  closeDb,
  createMcpServerRegistry,
  detachMcpConsumer,
  getMcpServerRegistry,
  getRawDb,
  listMcpConsumersForServer,
  listMcpServerIdsForConsumer,
  runMigrations,
  setMcpServerHealth,
} = await import('../src/index.ts');

before(() => runMigrations());
after(() => {
  closeDb();
  rmSync(tmpDir, { recursive: true, force: true });
});

test('0020 adds every health column to mcp_servers', () => {
  const raw = getRawDb();
  const cols = (raw.pragma('table_info("mcp_servers")') as { name: string }[]).map((c) => c.name);
  for (const col of [
    'enabled',
    'health_state',
    'health_reason',
    'last_probe_at',
    'last_ok_probe_at',
    'tool_count',
    'last_error',
    'consecutive_failures',
  ]) {
    assert.ok(cols.includes(col), `mcp_servers.${col} should exist`);
  }
});

test('0020 creates mcp_consumer_attachments', () => {
  const raw = getRawDb();
  const cols = (raw.pragma('table_info("mcp_consumer_attachments")') as { name: string }[]).map((c) => c.name);
  // pc-sdk-15 (0024) added the nullable `tool_filter` allowlist column.
  assert.deepEqual(cols.sort(), ['consumer', 'created_at', 'id', 'mcp_server_id', 'tool_filter']);
});

test('assertSchemaIntact passes after migration', () => {
  assert.doesNotThrow(() => assertSchemaIntact());
});

test('a new server defaults to enabled + unknown health', () => {
  const server = createMcpServerRegistry({
    scope: 'global',
    name: `def-${Date.now()}`,
    transport: { url: 'https://d.example/mcp' },
  });
  assert.equal(server.enabled, true);
  assert.equal(server.healthState, 'unknown');
  assert.equal(server.lastOkProbeAt, null);
  assert.equal(server.consecutiveFailures, 0);
});

test('setMcpServerHealth persists the explicit state, error, and streak', () => {
  const server = createMcpServerRegistry({
    scope: 'global',
    name: `health-${Date.now()}`,
    transport: { url: 'https://h.example/mcp' },
  });
  const now = Date.now();
  const ok = setMcpServerHealth(server.id, {
    state: 'healthy',
    reason: null,
    lastProbeAt: now,
    lastOkProbeAt: now,
    toolCount: 3,
    lastError: null,
    consecutiveFailures: 0,
    tools: ['a', 'b', 'c'],
  });
  assert.equal(ok!.healthState, 'healthy');
  assert.equal(ok!.toolCount, 3);
  assert.deepEqual(ok!.discoveredTools, ['a', 'b', 'c']);
  assert.ok(ok!.rev > server.rev);

  const down = setMcpServerHealth(server.id, {
    state: 'down',
    reason: 'unreachable',
    lastProbeAt: now + 1,
    toolCount: null,
    lastError: 'ECONNREFUSED',
    consecutiveFailures: 4,
    tools: null,
  });
  assert.equal(down!.healthState, 'down');
  assert.equal(down!.lastError, 'ECONNREFUSED');
  assert.equal(down!.consecutiveFailures, 4);
  assert.equal(down!.discoveredTools, null, 'a failed probe clears the tool cache');
  assert.equal(down!.lastOkProbeAt, now, 'last successful probe is carried forward, not wiped');
});

test('consumer attach is idempotent and filters both directions', () => {
  const server = createMcpServerRegistry({
    scope: 'global',
    name: `att-${Date.now()}`,
    transport: { url: 'https://att.example/mcp' },
  });
  const first = attachMcpConsumer({ mcpServerId: server.id, consumer: 'orchestrator' });
  const again = attachMcpConsumer({ mcpServerId: server.id, consumer: 'orchestrator' });
  assert.equal(first.id, again.id, 'attach is idempotent — no duplicate row');
  attachMcpConsumer({ mcpServerId: server.id, consumer: 'agent:writer' });

  assert.deepEqual(listMcpConsumersForServer(server.id).sort(), ['agent:writer', 'orchestrator']);
  assert.ok(listMcpServerIdsForConsumer('orchestrator').includes(server.id));
  assert.ok(listMcpServerIdsForConsumer('agent:writer').includes(server.id));

  assert.equal(detachMcpConsumer(server.id, 'orchestrator'), true);
  assert.equal(detachMcpConsumer(server.id, 'orchestrator'), false, 'detach twice is a no-op');
  assert.ok(!listMcpServerIdsForConsumer('orchestrator').includes(server.id));
});

test('getMcpServerRegistry round-trips the new fields', () => {
  const server = createMcpServerRegistry({
    scope: 'global',
    name: `rt-${Date.now()}`,
    enabled: false,
    transport: { url: 'https://rt.example/mcp' },
  });
  const fetched = getMcpServerRegistry(server.id)!;
  assert.equal(fetched.enabled, false);
  assert.equal(fetched.healthState, 'unknown');
});
