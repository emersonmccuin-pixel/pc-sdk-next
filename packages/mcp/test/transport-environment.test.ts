import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { getDefaultEnvironment } from '@modelcontextprotocol/sdk/client/stdio.js';
import { buildTransport } from '../src/transport.ts';

test('stdio MCP uses SDK-safe defaults plus explicit attachment env, never ambient server secrets', () => {
  const name = 'PC_SDK_SEC003_AMBIENT_MCP_CANARY';
  const previous = process.env[name];
  process.env[name] = 'ambient-must-not-cross';
  try {
    const defaults = getDefaultEnvironment();
    assert.equal(defaults[name], undefined, 'the pinned MCP SDK default is a positive allowlist');

    const built = buildTransport({
      command: process.execPath,
      args: [],
      env: { PC_SDK_EXPLICIT_MCP_ATTACHMENT: 'intentional-consumer-value' },
    });
    assert.equal(built.ok, true);
    if (!built.ok) assert.fail(built.error);

    const params = (built.transport as StdioClientTransport & {
      _serverParams: { env?: Record<string, string> };
    })._serverParams;
    assert.ok(params.env);
    assert.equal(params.env[name], undefined);
    assert.equal(
      params.env.PC_SDK_EXPLICIT_MCP_ATTACHMENT,
      'intentional-consumer-value',
      'stored per-consumer attachment env remains intentional input',
    );
    if (defaults.PATH !== undefined) assert.equal(params.env.PATH, defaults.PATH);
  } finally {
    if (previous === undefined) delete process.env[name];
    else process.env[name] = previous;
  }
});
