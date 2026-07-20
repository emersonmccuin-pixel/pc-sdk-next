// Live Codex binding — the production-side wiring between the conformance-tested
// CodexRuntimeAdapter (adapter.ts / runtime-peer.ts) and a REAL spawned Codex
// app-server process. It builds concrete CodexRuntimeAdapterDeps from one
// account's CODEX_HOME plus the session cwd.
//
// This file is deliberately the ONLY Codex module that depends on BOTH the
// provider-free adapter surface (its typed deps) and the native app-server
// client. The adapter surface itself (adapter/runtime-mapping/runtime-peer/
// runtime-session) must never reach the native client — the import-boundary
// guard proves that. This module sits below the adapter and is reached only by
// the composition root, the live smoke script, and unit tests. Nothing in the
// adapter surface imports it, so the surface stays native-free.
//
// PROCESS HYGIENE
// One app-server process PER discovery call. The pinned app-server-client
// (CX-001) is an admission-only, one-shot client: spawn -> initialize ->
// {account/read, model/list} -> dispose. Reusing it per call is the simplest
// lifecycle it supports and guarantees the child is reaped: discover() disposes
// in a finally, and any spawn/initialize/transport failure degrades to a typed
// `unavailable` observation rather than a throw or a hang.
//
// SANDBOX / APPROVAL POLICY — see LIVE_SESSION_POLICY (one clearly named place).
// ADR-0003 makes Codex's own built-in sandbox the isolation boundary (plus the
// read-only main checkout and per-run worktrees). The intended live session
// policy is workspace-write scoped to the session cwd, degrading VISIBLY to
// approval-gated execution when the sandbox is unavailable. The CX-002 adapter
// contract still pins read-only + approvalPolicy 'never'; the live TURN peer is
// therefore gated (see liveRuntimePeerFactory) until that contract widens, so no
// silent workspace-write escape is possible.

import { startCodexAppServer } from './app-server-client.ts';
import type { CodexAppServerProcessFactory } from './app-server-client.ts';
import type { CodexRuntimeAdapterDeps } from './adapter.ts';
import {
  CODEX_PROTOCOL_VERSION,
  CODEX_RUNTIME_ID,
  type CodexDiscoveryModel,
  type CodexDiscoveryObservation,
  type CodexDiscoveryPeer,
  type CodexProviderFreeConformanceAuthority,
  type CodexRuntimePeerFactory,
} from './runtime-peer.ts';

/** Stable, provider-safe rejection code. Native payloads never participate. */
export type CodexLivePeerErrorCode =
  | 'live-turn-peer-unavailable'
  | 'invalid-live-peer-options';

export class CodexLivePeerError extends Error {
  readonly name = 'CodexLivePeerError';

  constructor(readonly code: CodexLivePeerErrorCode) {
    super(`Codex live peer unavailable: ${code}`);
  }
}

/**
 * The single place the live sandbox/approval decision lives (ADR-0003).
 * `intended` is the target once the turn transport and adapter contract widen;
 * `degradation` is the visible fallback; `currentAdapterContract` records why
 * the live turn peer is presently gated. Read-only discovery needs none of it.
 */
export const LIVE_SESSION_POLICY = Object.freeze({
  isolation: 'codex-builtin-sandbox',
  intended: 'workspace-write-scoped-to-session-cwd',
  degradation: 'approval-gated-every-exec-and-patch',
  currentAdapterContract: 'read-only-approval-never',
} as const);

export interface CodexLivePeerOptions {
  /** Canonical absolute CODEX_HOME for the account (validated by the client). */
  readonly codexHome: string;
  /** Canonical absolute session working directory. */
  readonly cwd: string;
  /** Per-request timeout for the admission handshake and reads. */
  readonly requestTimeoutMs?: number;
  /** Test-only native-child injection seam; production omits it (real spawn). */
  readonly spawnProcess?: CodexAppServerProcessFactory;
}

const MAX_MODEL_PAGES = 100;
const MODEL_EFFORT_UNSUPPORTED = 'codex-model-effort-unsupported';

/** Real discovery peer: spawns the pinned app-server, initializes, and reads
 *  cached ChatGPT auth + the built-in model catalog. Every result — including a
 *  missing login — is returned as a typed observation, never thrown. */
class CodexLiveDiscoveryPeer implements CodexDiscoveryPeer {
  constructor(private readonly options: CodexLivePeerOptions) {}

  async discover(accountId: string): Promise<unknown> {
    return discoverLiveCatalog(this.options, accountId);
  }
}

/** The live turn peer + real conformance authority are the next WF-1 slice: the
 *  pinned app-server-client is admission-only (it refuses thread/turn methods,
 *  treats an approval server-request as fatal, and rejects turn notifications),
 *  so driving a real turn needs a thread-capable native transport, a real
 *  provider-free authority, and a receipt contract that no longer hardcodes the
 *  'contained-fake' lifecycle. Until then the factory fails LOUDLY and typed so
 *  the adapter surfaces `session-mint-unavailable` — never a silent or faked
 *  turn. */
const liveRuntimePeerFactory: CodexRuntimePeerFactory = () => {
  throw new CodexLivePeerError('live-turn-peer-unavailable');
};

const liveConformanceAuthority: CodexProviderFreeConformanceAuthority = {
  async attestExecutionPolicy(): Promise<unknown> {
    throw new CodexLivePeerError('live-turn-peer-unavailable');
  },
  async attestTurnBoundary(): Promise<unknown> {
    throw new CodexLivePeerError('live-turn-peer-unavailable');
  },
};

/**
 * Build real CodexRuntimeAdapterDeps for the CodexRuntimeAdapter. `discoveryPeer`
 * talks to the real app-server; the turn peer + authority are the typed gate
 * described above.
 */
export function createCodexLiveDeps(
  options: CodexLivePeerOptions,
): CodexRuntimeAdapterDeps {
  if (!options || !exactString(options.codexHome) || !exactString(options.cwd)) {
    throw new CodexLivePeerError('invalid-live-peer-options');
  }
  const normalized: CodexLivePeerOptions = {
    codexHome: options.codexHome,
    cwd: options.cwd,
    requestTimeoutMs: options.requestTimeoutMs,
    spawnProcess: options.spawnProcess,
  };
  return {
    discoveryPeer: new CodexLiveDiscoveryPeer(normalized),
    conformanceAuthority: liveConformanceAuthority,
    runtimePeerFactory: liveRuntimePeerFactory,
  };
}

async function discoverLiveCatalog(
  options: CodexLivePeerOptions,
  accountId: string,
): Promise<CodexDiscoveryObservation> {
  let client: ReturnType<typeof startCodexAppServer>;
  try {
    client = startCodexAppServer({
      codexHome: options.codexHome,
      cwd: options.cwd,
      requestTimeoutMs: options.requestTimeoutMs,
      // Live discovery tolerates the app-server's benign operational stderr
      // (byte-bounded); the spike's strict `fail-on-any` was an admission-gate
      // choice, not a functional requirement. Overflow still fails closed.
      stderrPolicy: { mode: 'discard' },
      ...(options.spawnProcess ? { spawnProcess: options.spawnProcess } : {}),
    });
  } catch {
    return unavailable(accountId, 'codex-discovery-unavailable');
  }

  try {
    await client.initialize(options.codexHome);
    const account = await client.request('account/read', { refreshToken: false });
    if (!isCachedChatgptAccount(account)) {
      return unavailable(accountId, 'account-unavailable');
    }
    const models = await collectModels(client);
    if (models.length === 0) {
      return unavailable(accountId, 'codex-discovery-unavailable');
    }
    return {
      status: 'available',
      protocolVersion: CODEX_PROTOCOL_VERSION,
      runtimeId: CODEX_RUNTIME_ID,
      accountId,
      models,
    };
  } catch {
    return unavailable(accountId, 'codex-discovery-unavailable');
  } finally {
    try {
      await client.dispose();
    } catch {
      // Disposal failure never turns a discovery result into a throw; the child
      // is best-effort reaped and the process-per-call lifecycle is bounded.
    }
  }
}

async function collectModels(
  client: ReturnType<typeof startCodexAppServer>,
): Promise<CodexDiscoveryModel[]> {
  const models: CodexDiscoveryModel[] = [];
  const seenIds = new Set<string>();
  const seenCursors = new Set<string>();
  let cursor: string | null = null;

  for (let page = 0; page < MAX_MODEL_PAGES; page += 1) {
    const params = cursor === null
      ? { includeHidden: false }
      : { cursor, includeHidden: false };
    const response = await client.request('model/list', params);
    if (!isRecord(response) || !Array.isArray(response.data)) break;
    for (const raw of response.data) {
      const model = toDiscoveryModel(raw);
      if (model !== null && !seenIds.has(model.id)) {
        seenIds.add(model.id);
        models.push(model);
      }
    }
    const next = response.nextCursor;
    if (typeof next !== 'string' || next.length === 0 || seenCursors.has(next)) break;
    seenCursors.add(next);
    cursor = next;
  }
  return models;
}

function toDiscoveryModel(raw: unknown): CodexDiscoveryModel | null {
  if (!isRecord(raw) || raw.hidden === true) return null;
  if (!exactString(raw.model)) return null;
  const id = raw.model;
  const label = exactString(raw.displayName) ? raw.displayName : id;
  const description = typeof raw.description === 'string' ? raw.description : '';

  const values: string[] = [];
  if (Array.isArray(raw.supportedReasoningEfforts)) {
    for (const option of raw.supportedReasoningEfforts) {
      if (isRecord(option) && exactString(option.reasoningEffort)) {
        values.push(option.reasoningEffort);
      }
    }
  }
  const distinct = [...new Set(values)];
  const effort = distinct.length > 0
    ? { status: 'supported' as const, values: distinct }
    : { status: 'unsupported' as const, code: MODEL_EFFORT_UNSUPPORTED };

  return { id, resolvedId: null, label, description, effort };
}

function isCachedChatgptAccount(value: unknown): boolean {
  if (!isRecord(value) || value.requiresOpenaiAuth !== true) return false;
  const account = value.account;
  return isRecord(account) && account.type === 'chatgpt';
}

function unavailable(
  accountId: string,
  code: 'account-unavailable' | 'codex-discovery-unavailable',
): CodexDiscoveryObservation {
  return {
    status: 'unavailable',
    protocolVersion: CODEX_PROTOCOL_VERSION,
    runtimeId: CODEX_RUNTIME_ID,
    accountId,
    code,
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function exactString(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && value === value.trim() &&
    !value.includes('\u0000');
}
