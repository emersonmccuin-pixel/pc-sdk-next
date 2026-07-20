// MCP auth vault (N6 requirement 4 — auth in the vault). Secrets are stored
// AES-256-GCM encrypted in the `credentials` table, bound to an MCP server row.
// This module owns the crypto; the repo persists opaque base64 blobs.
//
// Write-only + presence: the HTTP surface may WRITE a secret and READ a
// presence flag, but plaintext never leaves the vault except through
// `resolveTransportSecrets`, called by the manager at connect time. Expired
// credentials surface as the distinct `auth-expired` health state — the vault
// reports expiry; it never silently connects with a dead token.

import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { join } from 'node:path';
import {
  createCredential,
  deleteCredential,
  getCredential,
  getCredentialByServer,
  getMcpServerRegistry,
  replaceTransportOnly,
  updateCredentialAuthState,
} from '@pc/db';
import { getDataDir } from '@pc/utils';
import type {
  CredentialAuthState,
  CredentialKind,
  McpServerTransport,
  PodMcpServerConfig,
  SecretRef,
  TransportValue,
  ULID,
} from '@pc/domain';

const ALGO = 'aes-256-gcm';
const IV_BYTES = 12;
let cachedKey: Buffer | null = null;

/** The symmetric vault key: `PC_VAULT_KEY` (base64, 32 bytes) if set, else a
 *  key file in the data dir, generated on first use. Never logged. */
function vaultKey(): Buffer {
  if (cachedKey) return cachedKey;
  const env = process.env.PC_VAULT_KEY?.trim();
  if (env) {
    const buf = Buffer.from(env, 'base64');
    if (buf.length !== 32) throw new Error('PC_VAULT_KEY must be 32 bytes (base64)');
    cachedKey = buf;
    return buf;
  }
  const dir = join(getDataDir(), 'secrets');
  const keyPath = join(dir, 'vault.key');
  if (existsSync(keyPath)) {
    cachedKey = Buffer.from(readFileSync(keyPath, 'utf8').trim(), 'base64');
    return cachedKey;
  }
  mkdirSync(dir, { recursive: true });
  const key = randomBytes(32);
  writeFileSync(keyPath, key.toString('base64'), { encoding: 'utf8', mode: 0o600 });
  try {
    chmodSync(keyPath, 0o600);
  } catch {
    /* best-effort on platforms without POSIX perms */
  }
  cachedKey = key;
  return key;
}

interface EncryptedBlob {
  ciphertext: string;
  iv: string;
  authTag: string;
}

function encrypt(plaintext: string): EncryptedBlob {
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv(ALGO, vaultKey(), iv);
  const ct = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  return {
    ciphertext: ct.toString('base64'),
    iv: iv.toString('base64'),
    authTag: cipher.getAuthTag().toString('base64'),
  };
}

function decrypt(blob: EncryptedBlob): string {
  const decipher = createDecipheriv(ALGO, vaultKey(), Buffer.from(blob.iv, 'base64'));
  decipher.setAuthTag(Buffer.from(blob.authTag, 'base64'));
  const pt = Buffer.concat([
    decipher.update(Buffer.from(blob.ciphertext, 'base64')),
    decipher.final(),
  ]);
  return pt.toString('utf8');
}

// ── Write ─────────────────────────────────────────────────────────────────────

export interface PutServerSecretInput {
  /** Secret plaintext (e.g. the full `Authorization` header value). */
  value: string;
  kind?: CredentialKind;
  /** Epoch-ms expiry; when past, the server reads `auth-expired`. */
  expiresAt?: number | null;
  /** HTTP header the secret binds to (default `Authorization` for url servers). */
  headerName?: string;
  /** Env var the secret binds to (stdio servers). */
  envName?: string;
}

/** Store a secret for a server and bind it into the transport as a `$secretRef`.
 *  Replaces any existing secret for the server. Returns false if the server is
 *  unknown. */
export function putServerSecret(serverId: ULID, input: PutServerSecretInput): boolean {
  const server = getMcpServerRegistry(serverId);
  if (!server) return false;
  const blob = encrypt(input.value);
  const existing = getCredentialByServer(serverId);
  if (existing) deleteCredential(existing.id);
  const cred = createCredential({
    ownerScope: server.scope === 'project' ? 'project' : 'global',
    ownerServerId: serverId,
    kind: input.kind ?? 'static',
    ciphertext: blob.ciphertext,
    iv: blob.iv,
    authTag: blob.authTag,
    authState: 'connected',
    expiresAt: input.expiresAt ?? null,
  });
  // Bind the ref into the transport so resolveTransportSecrets injects it.
  const ref: SecretRef = { $secretRef: cred.id };
  const transport: McpServerTransport = { ...server.transport };
  if (input.envName) {
    transport.env = { ...(transport.env ?? {}), [input.envName]: ref };
  } else {
    const header = input.headerName ?? 'Authorization';
    transport.headers = { ...(transport.headers ?? {}), [header]: ref };
  }
  replaceTransportOnly(serverId, transport);
  return true;
}

// ── Presence (never returns plaintext) ─────────────────────────────────────────

export interface SecretPresence {
  present: boolean;
  authState: CredentialAuthState | null;
  expiresAt: number | null;
  expired: boolean;
}

export function serverSecretPresence(serverId: ULID): SecretPresence {
  const cred = getCredentialByServer(serverId);
  if (!cred) return { present: false, authState: null, expiresAt: null, expired: false };
  const expired =
    cred.authState === 'expired' ||
    (cred.expiresAt !== null && cred.expiresAt <= Date.now());
  return {
    present: true,
    authState: cred.authState,
    expiresAt: cred.expiresAt,
    expired,
  };
}

/** Mark a server's stored credential expired (called by the manager when a
 *  connect is rejected with an auth error, or expiry lapses). No-op if absent. */
export function markServerAuthExpired(serverId: ULID, reason: string): void {
  const cred = getCredentialByServer(serverId);
  if (!cred) return;
  updateCredentialAuthState(cred.id, 'expired', reason);
}

/** Mark a server's stored credential connected (called after a healthy probe);
 *  clears a prior `expired`. No-op if absent or already connected. */
export function markServerAuthConnected(serverId: ULID): void {
  const cred = getCredentialByServer(serverId);
  if (!cred || cred.authState === 'connected') return;
  updateCredentialAuthState(cred.id, 'connected', null);
}

// ── Resolve (connect-time) ─────────────────────────────────────────────────────

export type ResolveResult =
  | { ok: true; config: PodMcpServerConfig }
  | { ok: false; reason: 'auth-expired' | 'missing-secret' | 'unusable'; error: string };

/** Resolve a stored transport to a plain client config, swapping every
 *  `$secretRef` for its live plaintext from the vault. An expired bound
 *  credential short-circuits to `auth-expired` — the manager never dials with a
 *  dead token. A missing/undecryptable ref is a typed failure, never a silent
 *  drop. */
export function resolveTransportSecrets(transport: McpServerTransport): ResolveResult {
  // Expiry gate: if the bound credential is past its expiry, do not connect.
  const env = resolveValueMap(transport.env);
  if (!env.ok) return env;
  const headers = resolveValueMap(transport.headers);
  if (!headers.ok) return headers;

  const config: PodMcpServerConfig = {};
  if (transport.command) config.command = transport.command;
  if (transport.args) config.args = transport.args;
  if (env.map) config.env = env.map;
  if (transport.cwd) config.cwd = transport.cwd;
  if (transport.type) config.type = transport.type;
  if (transport.url) config.url = transport.url;
  if (headers.map) config.headers = headers.map;
  if (!config.command && !config.url) {
    return { ok: false, reason: 'unusable', error: 'transport has neither command nor url' };
  }
  return { ok: true, config };
}

function resolveValueMap(
  map: Record<string, TransportValue> | undefined,
): { ok: true; map: Record<string, string> | undefined } | Extract<ResolveResult, { ok: false }> {
  if (!map) return { ok: true, map: undefined };
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(map)) {
    if (typeof v === 'string') {
      out[k] = v;
      continue;
    }
    const resolved = resolveRef(v);
    if (!resolved.ok) return resolved;
    out[k] = resolved.value;
  }
  return { ok: true, map: out };
}

function resolveRef(
  ref: SecretRef,
): { ok: true; value: string } | Extract<ResolveResult, { ok: false }> {
  const cred = getCredentialByIdSafe(ref.$secretRef as ULID);
  if (!cred) {
    return { ok: false, reason: 'missing-secret', error: `vault secret ${ref.$secretRef} not found` };
  }
  if (cred.authState === 'expired' || (cred.expiresAt !== null && cred.expiresAt <= Date.now())) {
    return { ok: false, reason: 'auth-expired', error: cred.lastError ?? 'stored credential expired' };
  }
  try {
    return {
      ok: true,
      value: decrypt({ ciphertext: cred.ciphertext, iv: cred.iv, authTag: cred.authTag }),
    };
  } catch (err) {
    return {
      ok: false,
      reason: 'unusable',
      error: `vault decrypt failed: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
}

function getCredentialByIdSafe(id: ULID) {
  try {
    return getCredential(id);
  } catch {
    return null;
  }
}
