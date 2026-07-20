// N6 MCP auth vault — write-only + presence semantics (plaintext never leaves
// the vault via presence), connect-time secret resolution, and expired-secret
// short-circuit to the auth-expired path.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createMcpServerRegistry, getCredentialByServer, getMcpServerRegistry } from '@pc/db';
import {
  markServerAuthExpired,
  putServerSecret,
  resolveTransportSecrets,
  serverSecretPresence,
} from '../src/mcp/secrets-vault.ts';
import { freshDb } from './helpers.ts';

const SECRET = 'Bearer super-secret-token-value';

function serverWithSecret() {
  const server = createMcpServerRegistry({
    scope: 'global',
    name: `vault-${Math.random().toString(36).slice(2)}`,
    transport: { type: 'http', url: 'https://vault.example/mcp' },
  });
  putServerSecret(server.id, { value: SECRET });
  return server.id;
}

test('presence reports the secret exists but never returns its value', () => {
  freshDb();
  const id = serverWithSecret();
  const presence = serverSecretPresence(id);
  assert.equal(presence.present, true);
  assert.equal(presence.expired, false);
  // The presence object carries no plaintext at all.
  assert.equal(JSON.stringify(presence).includes('super-secret'), false);
});

test('a written secret is stored encrypted, not as plaintext', () => {
  freshDb();
  const id = serverWithSecret();
  const cred = getCredentialByServer(id);
  assert.ok(cred);
  assert.notEqual(cred!.ciphertext, SECRET);
  assert.equal(Buffer.from(cred!.ciphertext, 'base64').toString('utf8').includes('super-secret'), false);
  // The stored transport references the vault, it does not inline the secret.
  const transport = getMcpServerRegistry(id)!.transport;
  assert.deepEqual(transport.headers!.Authorization, { $secretRef: cred!.id });
});

test('resolveTransportSecrets swaps the $secretRef for the live plaintext at connect time', () => {
  freshDb();
  const id = serverWithSecret();
  const transport = getMcpServerRegistry(id)!.transport;
  const resolved = resolveTransportSecrets(transport);
  assert.equal(resolved.ok, true);
  if (resolved.ok) {
    assert.equal(resolved.config.headers!.Authorization, SECRET);
  }
});

test('an expired stored secret short-circuits to auth-expired, never dials with a dead token', () => {
  freshDb();
  const id = serverWithSecret();
  markServerAuthExpired(id, 'token revoked');
  const presence = serverSecretPresence(id);
  assert.equal(presence.expired, true);
  const resolved = resolveTransportSecrets(getMcpServerRegistry(id)!.transport);
  assert.equal(resolved.ok, false);
  if (!resolved.ok) assert.equal(resolved.reason, 'auth-expired');
});

test('a plain (non-secret) transport resolves unchanged', () => {
  freshDb();
  const resolved = resolveTransportSecrets({ type: 'http', url: 'https://plain.example/mcp' });
  assert.equal(resolved.ok, true);
  if (resolved.ok) assert.equal(resolved.config.url, 'https://plain.example/mcp');
});

test('a dangling $secretRef is a typed missing-secret failure, not a silent drop', () => {
  freshDb();
  const resolved = resolveTransportSecrets({
    type: 'http',
    url: 'https://x.example/mcp',
    headers: { Authorization: { $secretRef: '01MISSINGCRED0000000000000A' } },
  });
  assert.equal(resolved.ok, false);
  if (!resolved.ok) assert.equal(resolved.reason, 'missing-secret');
});
