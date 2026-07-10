// MCP bridge guards: healthy servers' tools become correctly-named proxy tool
// defs; a tool call against an unreachable server DEGRADES (typed isError
// result) instead of throwing — chat is never blocked.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { z } from 'zod';
import { buildBridge, jsonSchemaToZodShape, type BridgeServer } from '../src/mcp/bridge.ts';

const pmServer: BridgeServer = {
  id: '01ABCDEF',
  name: 'AInativePM',
  config: { url: 'http://localhost:9/mcp' },
  tools: [
    { name: 'wi_create', description: 'Create a work item', inputSchema: { type: 'object', properties: { title: { type: 'string' } }, required: ['title'] } },
    { name: 'wi_list', description: 'List work items', inputSchema: { type: 'object' } },
  ],
};

test('buildBridge namespaces tools and lists fully-qualified allowed names', () => {
  const build = buildBridge([pmServer]);
  assert.equal(build.serverKey, 'pc');
  assert.deepEqual(
    build.toolDefs.map((d) => d.name),
    ['ainativepm__wi_create', 'ainativepm__wi_list'],
  );
  assert.deepEqual(build.allowedToolNames, ['mcp__pc__ainativepm__wi_create', 'mcp__pc__ainativepm__wi_list']);
});

test('buildBridge with no servers yields nothing', () => {
  const build = buildBridge([]);
  assert.equal(build.toolDefs.length, 0);
  assert.equal(build.allowedToolNames.length, 0);
});

test('jsonSchemaToZodShape honors required vs optional', () => {
  const shape = jsonSchemaToZodShape({
    type: 'object',
    properties: { title: { type: 'string' }, count: { type: 'integer' } },
    required: ['title'],
  });
  const schema = z.object(shape);
  assert.equal(schema.safeParse({ title: 'x' }).success, true); // count optional
  assert.equal(schema.safeParse({ count: 3 }).success, false); // title required
  assert.equal(schema.safeParse({ title: 'x', count: 'no' }).success, false); // typed
});

test('degrade-never-block: a call to an unreachable server returns a typed isError, never throws', async () => {
  const bad: BridgeServer = {
    id: 'DEADBEEF',
    name: 'down-server',
    config: { command: 'pc-nonexistent-binary-xyz-123' },
    tools: [{ name: 'do_thing', description: '', inputSchema: { type: 'object' } }],
  };
  const build = buildBridge([bad]);
  const def = build.toolDefs[0];
  const result = await def.handler({});
  assert.equal(result.isError, true);
  assert.match(result.content[0].text, /MCP tool error/);
});
