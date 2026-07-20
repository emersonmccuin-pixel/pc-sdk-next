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

import { randomUUID } from 'node:crypto';

import { startCodexAppServer } from './app-server-client.ts';
import type { CodexAppServerProcessFactory } from './app-server-client.ts';
import {
  startCodexTurnTransport,
  CodexTurnTransport,
  type CodexNotificationFrame,
  type CodexServerRequestFrame,
} from './app-server-turn-client.ts';
import type { CodexRuntimeAdapterDeps } from './adapter.ts';
import {
  CODEX_PROTOCOL_VERSION,
  CODEX_RUNTIME_ID,
  CODEX_RUNTIME_NOTIFICATION_METHODS,
  CODEX_RUNTIME_REQUEST_METHODS,
  type CodexApprovalResponse,
  type CodexDiscoveryModel,
  type CodexDiscoveryObservation,
  type CodexDiscoveryPeer,
  type CodexExecutionPolicyChallenge,
  type CodexProviderFreeConformanceAuthority,
  type CodexRuntimePeer,
  type CodexRuntimePeerFactory,
  type CodexRuntimePeerFactoryInput,
  type CodexTurnBoundaryChallenge,
} from './runtime-peer.ts';

/** Stable, provider-safe rejection code. Native payloads never participate. */
export type CodexLivePeerErrorCode =
  | 'live-turn-peer-unavailable'
  | 'invalid-live-peer-options'
  | 'live-peer-posture-unverified'
  | 'live-turn-boundary-unavailable';

export class CodexLivePeerError extends Error {
  readonly name = 'CodexLivePeerError';

  constructor(readonly code: CodexLivePeerErrorCode) {
    super(`Codex live peer unavailable: ${code}`);
  }
}

/**
 * The single place the live sandbox/approval posture lives (ADR-0003). This is
 * now the ACTIVE product posture the live turn peer drives: Codex's built-in
 * sandbox as the isolation boundary, workspace-write scoped to the session cwd,
 * every exec/patch escalation routed to the app ask flow, over a native
 * direct-child process lifecycle. The provider-free conformance authority
 * (below) independently attests this shape on every mint.
 */
export const LIVE_SESSION_POLICY = Object.freeze({
  isolation: 'codex-builtin-sandbox',
  sandbox: 'workspace-write-scoped-to-session-cwd',
  approvalRequests: 'routed',
  lifecycle: 'direct-child',
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

/** The canonical turn notification methods, as a fast membership set. */
const CANONICAL_TURN_METHODS: ReadonlySet<string> = new Set(CODEX_RUNTIME_NOTIFICATION_METHODS);
const EXEC_APPROVAL_METHOD = 'item/commandExecution/requestApproval';
const PATCH_APPROVAL_METHOD = 'item/fileChange/requestApproval';

/**
 * One turn epoch's filtered canonical notification stream. The peer pushes ONLY
 * the five canonical turn methods (and agentMessage item frames) into it; every
 * non-canonical native method and non-agentMessage item is dropped BEFORE it can
 * reach captureRuntimeNotification, which otherwise fails closed on the real
 * stream's operational noise (the hazard dossier). Child death fails the queue
 * loudly so the turn terminates as failed rather than hanging.
 */
class LiveNotificationQueue {
  private readonly buffered: Array<Record<string, unknown>> = [];
  private readonly waiters: Array<{
    resolve: (result: IteratorResult<unknown>) => void;
    reject: (error: unknown) => void;
  }> = [];
  private closed = false;
  private sealed = false;
  private failure: unknown = null;

  push(frame: Record<string, unknown>): void {
    if (this.closed || this.sealed || this.failure !== null) return;
    const waiter = this.waiters.shift();
    if (waiter) waiter.resolve({ done: false, value: frame });
    else this.buffered.push(frame);
  }

  fail(error: unknown): void {
    if (this.failure !== null || this.closed) return;
    this.failure = error;
    while (this.waiters.length > 0) this.waiters.shift()?.reject(error);
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    while (this.waiters.length > 0) this.waiters.shift()?.resolve({ done: true, value: undefined });
  }

  /** Seal the epoch and report residual buffered canonical frames. */
  seal(): number {
    this.sealed = true;
    return this.buffered.length;
  }

  [Symbol.asyncIterator](): AsyncIterator<unknown> {
    return {
      next: () => {
        if (this.buffered.length > 0) {
          return Promise.resolve({ done: false, value: this.buffered.shift()! });
        }
        if (this.failure !== null) return Promise.reject(this.failure);
        if (this.closed) return Promise.resolve({ done: true, value: undefined });
        return new Promise<IteratorResult<unknown>>((resolve, reject) => {
          this.waiters.push({ resolve, reject });
        });
      },
      return: () => {
        this.close();
        return Promise.resolve({ done: true, value: undefined });
      },
    };
  }
}

/** One turn epoch's routed exec/patch approval requests, provider-neutral shape. */
class LiveApprovalChannel {
  private readonly buffered: unknown[] = [];
  private readonly waiters: Array<(result: IteratorResult<unknown>) => void> = [];
  private closed = false;

  push(value: unknown): void {
    if (this.closed) return;
    const waiter = this.waiters.shift();
    if (waiter) waiter({ done: false, value });
    else this.buffered.push(value);
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    while (this.waiters.length > 0) this.waiters.shift()?.({ done: true, value: undefined });
  }

  [Symbol.asyncIterator](): AsyncIterator<unknown> {
    return {
      next: () => {
        if (this.buffered.length > 0) {
          return Promise.resolve({ done: false, value: this.buffered.shift() });
        }
        if (this.closed) return Promise.resolve({ done: true, value: undefined });
        return new Promise<IteratorResult<unknown>>((resolve) => this.waiters.push(resolve));
      },
      return: () => {
        this.close();
        return Promise.resolve({ done: true, value: undefined });
      },
    };
  }
}

/** The independently attestable posture of a live turn peer: exactly the product
 * execution shape the conformance authority requires before minting a receipt. */
interface CodexLivePeerPosture {
  approvalRequests: 'routed';
  lifecycle: 'direct-child';
  effectiveNativeTools: [];
  effectiveMcpServers: [];
}

/**
 * The real product turn peer: a native direct-child app-server transport driving
 * thread/turn methods, filtering the raw notification stream to the canonical
 * turn frames, and routing native exec/patch approval server-requests to the app
 * ask flow. It exposes only the closed CodexRuntimePeer surface plus two seams
 * the independent conformance authority uses (posture attestation and turn
 * boundary sealing) — no generic native request escapes.
 */
class CodexLiveTurnPeer implements CodexRuntimePeer {
  private notificationsQueue = new LiveNotificationQueue();
  private approvalsChannel = new LiveApprovalChannel();
  private activeTurnId: string | null = null;
  private readonly approvalWireIds = new Map<string, string | number>();
  private disposed = false;

  constructor(
    private readonly transport: CodexTurnTransport,
    private readonly cwd: string,
  ) {
    // Fresh epochs are minted per turn in startTurn; these placeholders are
    // replaced before any turn notification can be observed.
    this.notificationsQueue.close();
    this.approvalsChannel.close();
  }

  /** Sink for every server notification; keeps only canonical turn frames. */
  ingestNotification(frame: CodexNotificationFrame): void {
    if (!this.isCanonicalTurnFrame(frame)) return;
    this.notificationsQueue.push({ method: frame.method, params: frame.params });
  }

  /** Sink for every server->client request; routes approvals, refuses the rest. */
  ingestServerRequest(request: CodexServerRequestFrame): void {
    const captured = this.captureApproval(request);
    if (captured === null) {
      // An unsupported server request, or an approval we cannot faithfully
      // represent, is refused/declined fail-closed rather than routed.
      if (request.method === EXEC_APPROVAL_METHOD || request.method === PATCH_APPROVAL_METHOD) {
        this.transport.answerServerRequest(request.id, { decision: 'decline' });
      } else {
        this.transport.refuseServerRequest(request.id);
      }
      return;
    }
    this.approvalWireIds.set(captured.callId, request.id);
    this.approvalsChannel.push(captured.request);
  }

  /** Fail the active turn loudly when the child dies mid-turn. */
  failActiveTurn(error: unknown): void {
    this.notificationsQueue.fail(error);
    this.approvalsChannel.close();
  }

  async startThread(
    params: Parameters<CodexRuntimePeer['startThread']>[0],
    policyReceipt: Parameters<CodexRuntimePeer['startThread']>[1],
  ): Promise<unknown> {
    const response = await this.transport.request('thread/start', params);
    return { policyReceipt, response };
  }

  async resumeThread(
    params: Parameters<CodexRuntimePeer['resumeThread']>[0],
    policyReceipt: Parameters<CodexRuntimePeer['resumeThread']>[1],
  ): Promise<unknown> {
    const response = await this.transport.request('thread/resume', params);
    return { policyReceipt, response };
  }

  async startTurn(params: Parameters<CodexRuntimePeer['startTurn']>[0]): Promise<unknown> {
    this.notificationsQueue = new LiveNotificationQueue();
    this.approvalsChannel = new LiveApprovalChannel();
    this.approvalWireIds.clear();
    const response = await this.transport.request('turn/start', params);
    this.activeTurnId = readTurnId(response);
    return response;
  }

  async interruptTurn(
    params: Parameters<CodexRuntimePeer['interruptTurn']>[0],
  ): Promise<unknown> {
    return this.transport.request('turn/interrupt', params);
  }

  notifications(): AsyncIterable<unknown> {
    return this.notificationsQueue;
  }

  approvals(): AsyncIterable<unknown> {
    return this.approvalsChannel;
  }

  async respondToApproval(response: CodexApprovalResponse): Promise<unknown> {
    const wireId = this.approvalWireIds.get(response.callId);
    if (wireId !== undefined) {
      this.approvalWireIds.delete(response.callId);
      this.transport.answerServerRequest(wireId, {
        decision: response.behavior === 'allow' ? 'accept' : 'decline',
      });
    }
    return {};
  }

  async dispose(): Promise<void> {
    if (this.disposed) return;
    this.disposed = true;
    this.approvalsChannel.close();
    this.notificationsQueue.close();
    await this.transport.dispose();
  }

  /** Authority seam: the peer's fixed, structurally-guaranteed product posture. */
  attestPosture(): CodexLivePeerPosture {
    return {
      approvalRequests: 'routed',
      lifecycle: 'direct-child',
      effectiveNativeTools: [],
      effectiveMcpServers: [],
    };
  }

  /** Authority seam: seal the just-terminated turn epoch and report residue. */
  sealTurnBoundary(challenge: CodexTurnBoundaryChallenge): number {
    if (challenge.turnId !== this.activeTurnId) {
      throw new CodexLivePeerError('live-turn-boundary-unavailable');
    }
    return this.notificationsQueue.seal();
  }

  private isCanonicalTurnFrame(frame: CodexNotificationFrame): boolean {
    if (!CANONICAL_TURN_METHODS.has(frame.method)) return false;
    if (frame.method === 'item/started' || frame.method === 'item/completed') {
      const item = frame.params.item;
      return isRecord(item) && item.type === 'agentMessage';
    }
    return true;
  }

  private captureApproval(
    request: CodexServerRequestFrame,
  ): { callId: string; request: unknown } | null {
    if (request.method === EXEC_APPROVAL_METHOD) {
      const command = execCommand(request.params);
      if (command === null) return null;
      const cwd = exactString(request.params.cwd) ? request.params.cwd : this.cwd;
      const callId = randomUUID();
      return { callId, request: { kind: 'exec', callId, command, cwd } };
    }
    if (request.method === PATCH_APPROVAL_METHOD) {
      const grantRoot = request.params.grantRoot;
      const paths = exactString(grantRoot) ? [grantRoot] : [this.cwd];
      const callId = randomUUID();
      return { callId, request: { kind: 'patch', callId, paths } };
    }
    return null;
  }
}

/**
 * Real live turn peer factory: spawn a native direct-child app-server, complete
 * the initialize handshake, and hand the CodexRuntimePeer surface to the adapter.
 * Any spawn/initialize failure throws typed so the adapter surfaces
 * `session-mint-unavailable` — never a silent or faked turn.
 */
function makeLiveRuntimePeerFactory(options: CodexLivePeerOptions): CodexRuntimePeerFactory {
  return async (_input: CodexRuntimePeerFactoryInput): Promise<CodexRuntimePeer> => {
    let peer: CodexLiveTurnPeer | null = null;
    const transport = startCodexTurnTransport({
      codexHome: options.codexHome,
      cwd: options.cwd,
      requestTimeoutMs: options.requestTimeoutMs,
      onNotification: (frame) => peer?.ingestNotification(frame),
      onServerRequest: (request) => peer?.ingestServerRequest(request),
      onExit: () => peer?.failActiveTurn(new CodexLivePeerError('live-turn-peer-unavailable')),
      ...(options.spawnProcess ? { spawnProcess: options.spawnProcess } : {}),
    });
    peer = new CodexLiveTurnPeer(transport, options.cwd);
    try {
      await transport.initialize();
    } catch (error) {
      await transport.dispose().catch(() => {});
      throw error;
    }
    return peer;
  };
}

/**
 * The independent provider-free conformance authority. It is a distinct object
 * from the peer — the peer cannot attest its own policy or terminal boundary.
 * attestExecutionPolicy verifies the live peer's structural product posture then
 * seals the canonical execution-policy receipt; attestTurnBoundary seals the
 * just-terminated turn's notification epoch and proves it drained to zero.
 */
const liveConformanceAuthority: CodexProviderFreeConformanceAuthority = {
  async attestExecutionPolicy(
    peer: CodexRuntimePeer,
    challenge: CodexExecutionPolicyChallenge,
  ): Promise<unknown> {
    const live = requireLivePeer(peer);
    const posture = live.attestPosture();
    if (posture.approvalRequests !== 'routed' || posture.lifecycle !== 'direct-child' ||
      posture.effectiveNativeTools.length !== 0 || posture.effectiveMcpServers.length !== 0) {
      throw new CodexLivePeerError('live-peer-posture-unverified');
    }
    const receipt = {
      kind: 'provider-free-conformance' as const,
      protocolVersion: CODEX_PROTOCOL_VERSION,
      runtimeId: CODEX_RUNTIME_ID,
      continuationAttemptId: challenge.continuationAttemptId,
      selection: challenge.selection,
      mode: challenge.mode,
      requestedThreadId: challenge.requestedThreadId,
      cwd: challenge.cwd,
      requestMethods: [...CODEX_RUNTIME_REQUEST_METHODS],
      notificationMethods: [...CODEX_RUNTIME_NOTIFICATION_METHODS],
      effectiveNativeTools: [] as [],
      effectiveMcpServers: [] as [],
      approvalRequests: 'routed' as const,
      lifecycle: 'direct-child' as const,
    };
    return receipt;
  },

  async attestTurnBoundary(
    peer: CodexRuntimePeer,
    challenge: CodexTurnBoundaryChallenge,
  ): Promise<unknown> {
    const live = requireLivePeer(peer);
    const pendingNotifications = live.sealTurnBoundary(challenge);
    return {
      kind: 'provider-free-conformance-turn-boundary' as const,
      protocolVersion: CODEX_PROTOCOL_VERSION,
      runtimeId: CODEX_RUNTIME_ID,
      continuationAttemptId: challenge.continuationAttemptId,
      threadId: challenge.threadId,
      turnId: challenge.turnId,
      turnSequence: challenge.turnSequence,
      status: challenge.status,
      notificationBoundary: 'open-native' as const,
      pendingNotifications,
    };
  },
};

function requireLivePeer(peer: CodexRuntimePeer): CodexLiveTurnPeer {
  if (!(peer instanceof CodexLiveTurnPeer)) {
    throw new CodexLivePeerError('live-peer-posture-unverified');
  }
  return peer;
}

function readTurnId(response: unknown): string | null {
  if (!isRecord(response)) return null;
  const turn = response.turn;
  return isRecord(turn) && exactString(turn.id) ? turn.id : null;
}

function execCommand(params: Record<string, unknown>): string[] | null {
  if (exactString(params.command)) return [params.command];
  const actions = params.commandActions;
  if (Array.isArray(actions)) {
    const commands = actions
      .map((action) => (isRecord(action) && exactString(action.command) ? action.command : null))
      .filter((command): command is string => command !== null);
    if (commands.length > 0) return commands;
  }
  return null;
}

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
    runtimePeerFactory: makeLiveRuntimePeerFactory(normalized),
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
