import { isAbsolute, resolve } from 'node:path';

import {
  isRuntimeSelection,
  type RuntimeCapabilities,
  type RuntimeModelDiscovery,
  type RuntimeSelection,
  type SubscriptionQuotaObservationBatch,
} from '@pc/contracts';

import {
  preflightRuntimeSelection,
  RuntimeSelectionRejectedError,
  type AgentRuntimeAdapter,
  type CreateRuntimeSession,
  type ResumeRuntimeSession,
  type RuntimeSession,
} from '../runtime.ts';
import {
  captureCodexDiscovery,
  captureProviderFreePolicyReceipt,
  captureThreadPeerReceipt,
} from './runtime-mapping.ts';
import {
  CODEX_MODEL_PROVIDER,
  CODEX_PROTOCOL_VERSION,
  CODEX_RUNTIME_ID,
  CODEX_RUNTIME_NOTIFICATION_METHODS,
  CODEX_RUNTIME_REQUEST_METHODS,
  type CodexDiscoveryPeer,
  type CodexExecutionPolicyChallenge,
  type CodexProviderFreeConformanceAuthority,
  type CodexRuntimeMode,
  type CodexRuntimePeer,
  type CodexRuntimePeerFactory,
} from './runtime-peer.ts';
import { CodexRuntimeSession } from './runtime-session.ts';

export { CODEX_RUNTIME_ID } from './runtime-peer.ts';

export type CodexRuntimeAdapterErrorCode =
  | 'invalid-adapter-dependencies'
  | 'invalid-session-input'
  | 'unsupported-session-input'
  | 'runtime-peer-unavailable'
  | 'session-mint-unavailable'
  | 'peer-cleanup-unavailable';

export class CodexRuntimeAdapterError extends Error {
  readonly name = 'CodexRuntimeAdapterError';

  constructor(readonly code: CodexRuntimeAdapterErrorCode) {
    super(`Codex runtime adapter unavailable: ${code}`);
  }
}

export interface CodexRuntimeAdapterDeps {
  discoveryPeer: CodexDiscoveryPeer;
  conformanceAuthority: CodexProviderFreeConformanceAuthority;
  runtimePeerFactory: CodexRuntimePeerFactory;
  now?: () => number;
}

interface CapturedSessionInput {
  appSessionId: string;
  projectId: string;
  continuationAttemptId: string;
  selection: RuntimeSelection;
  cwd: string;
  instructions: string | null;
  maxTurns: number | null;
  mode: CodexRuntimeMode;
  requestedThreadId: string | null;
}

export class CodexRuntimeAdapter implements AgentRuntimeAdapter {
  readonly id = CODEX_RUNTIME_ID;
  private readonly discoveryPeer: CodexDiscoveryPeer;
  private readonly conformanceAuthority: CodexProviderFreeConformanceAuthority;
  private readonly runtimePeerFactory: CodexRuntimePeerFactory;
  private readonly now: () => number;

  constructor(deps: CodexRuntimeAdapterDeps) {
    if (!deps || typeof deps.discoveryPeer?.discover !== 'function' ||
      typeof deps.conformanceAuthority?.attestExecutionPolicy !== 'function' ||
      typeof deps.conformanceAuthority?.attestTurnBoundary !== 'function' ||
      typeof deps.runtimePeerFactory !== 'function' ||
      (deps.now !== undefined && typeof deps.now !== 'function')) {
      throw new CodexRuntimeAdapterError('invalid-adapter-dependencies');
    }
    this.discoveryPeer = deps.discoveryPeer;
    this.conformanceAuthority = deps.conformanceAuthority;
    this.runtimePeerFactory = deps.runtimePeerFactory;
    this.now = deps.now ?? Date.now;
  }

  async capabilities(accountId: string): Promise<RuntimeCapabilities> {
    const discovery = await this.discover(accountId);
    if (discovery.status !== 'available') {
      return unavailableCapabilities(accountId, discovery.code);
    }
    const effortSupported = discovery.models.some((model) => model.effort.status === 'supported');
    return {
      runtimeId: this.id,
      accountId,
      // This is capability truth for the explicitly injected provider-free
      // conformance peer only. The adapter has no default/native constructor
      // and remains statically unreachable from production composition.
      nativeContinuation: { status: 'supported' },
      modelDiscovery: { status: 'supported' },
      effortControl: effortSupported
        ? { status: 'supported' }
        : { status: 'unsupported', code: 'codex-effort-unsupported' },
      context: {
        currentUse: { status: 'unavailable', code: 'codex-context-unavailable' },
        compaction: { status: 'unavailable', code: 'codex-compaction-unavailable' },
      },
      subscriptionQuota: { status: 'unavailable', code: 'codex-quota-unavailable' },
    };
  }

  async listModels(accountId: string): Promise<RuntimeModelDiscovery> {
    return this.discover(accountId);
  }

  async observeSubscriptionQuota(
    accountId: string,
    options?: { signal?: AbortSignal },
  ): Promise<SubscriptionQuotaObservationBatch> {
    if (options?.signal?.aborted) {
      return quotaUnavailable(accountId, 'observation-timeout', this.safeNow());
    }
    const discovery = await this.discover(accountId);
    if (options?.signal?.aborted) {
      return quotaUnavailable(accountId, 'observation-timeout', this.safeNow());
    }
    return quotaUnavailable(
      accountId,
      discovery.status === 'unavailable' && discovery.code === 'account-unavailable'
        ? 'account-unavailable'
        : 'unsupported',
      this.safeNow(),
    );
  }

  async createSession(input: CreateRuntimeSession): Promise<RuntimeSession> {
    return this.mint(captureSessionInput(input, 'create', null));
  }

  async resumeSession(input: ResumeRuntimeSession): Promise<RuntimeSession> {
    let nativeSessionId: unknown;
    try {
      nativeSessionId = input?.nativeSessionId;
    } catch {
      nativeSessionId = null;
    }
    const requestedThreadId = nativeId(nativeSessionId) ? nativeSessionId : null;
    if (requestedThreadId === null) {
      throw new RuntimeSelectionRejectedError('native-session-missing');
    }
    return this.mint(captureSessionInput(input, 'resume', requestedThreadId));
  }

  private async discover(accountId: string): Promise<RuntimeModelDiscovery> {
    if (!exactString(accountId)) {
      return { status: 'unavailable', code: 'account-unavailable' };
    }
    try {
      const value = await this.discoveryPeer.discover(accountId);
      return captureCodexDiscovery(value, accountId);
    } catch {
      return { status: 'unavailable', code: 'codex-discovery-unavailable' };
    }
  }

  private async mint(input: CapturedSessionInput): Promise<RuntimeSession> {
    const continuation = input.mode === 'create'
      ? { mode: 'create' as const }
      : { mode: 'resume' as const, nativeSessionId: input.requestedThreadId! };
    const validation = await preflightRuntimeSelection(this, input.selection, continuation);
    if (validation.status !== 'valid') throw new RuntimeSelectionRejectedError(validation.code);

    let peer: CodexRuntimePeer | null = null;
    try {
      const peerValue = await this.runtimePeerFactory(Object.freeze({
        continuationAttemptId: input.continuationAttemptId,
        selection: input.selection,
        mode: input.mode,
        requestedThreadId: input.requestedThreadId,
        cwd: input.cwd,
      }));
      if (!isRuntimePeer(peerValue)) throw new CodexRuntimeAdapterError('runtime-peer-unavailable');
      peer = peerValue;
      if (Object.is(peerValue, this.conformanceAuthority)) {
        throw new CodexRuntimeAdapterError('runtime-peer-unavailable');
      }

      const challenge = executionPolicyChallenge(input);
      const policyReceipt = captureProviderFreePolicyReceipt(
        await this.conformanceAuthority.attestExecutionPolicy(peer, challenge),
        challenge,
      );
      const finalValidation = await preflightRuntimeSelection(
        this,
        input.selection,
        continuation,
      );
      if (finalValidation.status !== 'valid') {
        throw new RuntimeSelectionRejectedError(finalValidation.code);
      }
      const threadValue = input.mode === 'create'
        ? await peer.startThread(threadStartParams(input), policyReceipt)
        : await peer.resumeThread(threadResumeParams(input), policyReceipt);
      const thread = captureThreadPeerReceipt(threadValue, challenge);

      return new CodexRuntimeSession({
        peer,
        conformanceAuthority: this.conformanceAuthority,
        selection: input.selection,
        continuationAttemptId: input.continuationAttemptId,
        mode: input.mode === 'create' ? 'created' : 'resumed',
        nativeThreadId: thread.nativeThreadId,
        requestedNativeThreadId: input.requestedThreadId,
        historicalTurnIds: thread.historicalTurnIds,
        historicalItemIds: thread.historicalItemIds,
        cwd: input.cwd,
        maxTurns: input.maxTurns,
      });
    } catch (error) {
      if (peer !== null) {
        try {
          await peer.dispose();
        } catch {
          throw new CodexRuntimeAdapterError('peer-cleanup-unavailable');
        }
      }
      if (error instanceof CodexRuntimeAdapterError ||
        error instanceof RuntimeSelectionRejectedError) throw error;
      throw new CodexRuntimeAdapterError('session-mint-unavailable');
    }
  }

  private safeNow(): number {
    try {
      const value = this.now();
      return Number.isSafeInteger(value) && value >= 0 ? value : 0;
    } catch {
      return 0;
    }
  }
}

function captureSessionInput(
  input: CreateRuntimeSession,
  mode: CodexRuntimeMode,
  requestedThreadId: string | null,
): CapturedSessionInput {
  let appSessionId: unknown;
  let projectId: unknown;
  let continuationAttemptId: unknown;
  let selectionValue: unknown;
  let cwd: unknown;
  let instructions: unknown;
  let maxTurns: unknown;
  let tools: CreateRuntimeSession['tools'];
  let allowedNativeTools: unknown;
  let ask: unknown;
  let bypassPermissions: unknown;
  try {
    appSessionId = input?.appSessionId;
    projectId = input?.projectId;
    continuationAttemptId = input?.continuationAttemptId;
    selectionValue = input?.selection;
    cwd = input?.cwd;
    instructions = input?.instructions;
    maxTurns = input?.maxTurns;
    tools = input?.tools;
    allowedNativeTools = input?.allowedNativeTools;
    ask = input?.ask;
    bypassPermissions = input?.bypassPermissions;
  } catch {
    throw new CodexRuntimeAdapterError('invalid-session-input');
  }
  const selection = captureSelection(selectionValue);
  if (selection === null || !exactString(appSessionId) || !exactString(projectId) ||
    !exactString(continuationAttemptId) || !canonicalAbsolutePath(cwd)) {
    throw new CodexRuntimeAdapterError('invalid-session-input');
  }
  if (hasAppTools(tools) ||
    (allowedNativeTools !== undefined &&
      (!Array.isArray(allowedNativeTools) || allowedNativeTools.length !== 0)) ||
    ask !== undefined ||
    (bypassPermissions !== undefined && typeof bypassPermissions !== 'boolean') ||
    (maxTurns !== undefined &&
      (!Number.isSafeInteger(maxTurns) || (maxTurns as number) <= 0)) ||
    (instructions !== undefined &&
      (typeof instructions !== 'string' || instructions.includes('\u0000')))) {
    throw new CodexRuntimeAdapterError('unsupported-session-input');
  }
  return Object.freeze({
    appSessionId,
    projectId,
    continuationAttemptId,
    selection,
    cwd,
    instructions: (instructions as string | undefined) ?? null,
    maxTurns: (maxTurns as number | undefined) ?? null,
    mode,
    requestedThreadId,
  });
}

function captureSelection(value: unknown): RuntimeSelection | null {
  try {
    const captured = structuredClone(value);
    return isRuntimeSelection(captured) ? freezeSelection(captured) : null;
  } catch {
    return null;
  }
}

function executionPolicyChallenge(
  input: CapturedSessionInput,
): CodexExecutionPolicyChallenge {
  return Object.freeze({
    kind: 'provider-free-execution-policy-challenge' as const,
    protocolVersion: CODEX_PROTOCOL_VERSION,
    runtimeId: CODEX_RUNTIME_ID,
    continuationAttemptId: input.continuationAttemptId,
    selection: input.selection,
    mode: input.mode,
    requestedThreadId: input.requestedThreadId,
    cwd: input.cwd,
    requestMethods: [...CODEX_RUNTIME_REQUEST_METHODS] as [...typeof CODEX_RUNTIME_REQUEST_METHODS],
    notificationMethods: [
      ...CODEX_RUNTIME_NOTIFICATION_METHODS,
    ] as [...typeof CODEX_RUNTIME_NOTIFICATION_METHODS],
  });
}

function threadStartParams(input: CapturedSessionInput) {
  return {
    model: input.selection.model,
    modelProvider: CODEX_MODEL_PROVIDER,
    serviceTier: null,
    cwd: input.cwd,
    approvalPolicy: 'on-request' as const,
    approvalsReviewer: 'user' as const,
    sandbox: 'workspace-write' as const,
    config: effortConfig(input.selection),
    baseInstructions: null,
    developerInstructions: input.instructions,
    ephemeral: false,
    sessionStartSource: 'startup' as const,
  };
}

function threadResumeParams(input: CapturedSessionInput) {
  return {
    threadId: input.requestedThreadId!,
    model: input.selection.model,
    modelProvider: CODEX_MODEL_PROVIDER,
    serviceTier: null,
    cwd: input.cwd,
    approvalPolicy: 'on-request' as const,
    approvalsReviewer: 'user' as const,
    sandbox: 'workspace-write' as const,
    config: effortConfig(input.selection),
    baseInstructions: null,
    developerInstructions: input.instructions,
  };
}

function effortConfig(selection: RuntimeSelection): Record<string, string> | null {
  return selection.effort.kind === 'selected'
    ? { model_reasoning_effort: selection.effort.value }
    : null;
}

function unavailableCapabilities(accountId: string, discoveryCode: string): RuntimeCapabilities {
  const code = discoveryCode === 'account-unavailable'
    ? 'account-unavailable'
    : 'codex-discovery-unavailable';
  const unavailable = () => ({ status: 'unavailable' as const, code });
  return {
    runtimeId: CODEX_RUNTIME_ID,
    accountId,
    nativeContinuation: unavailable(),
    modelDiscovery: unavailable(),
    effortControl: unavailable(),
    context: { currentUse: unavailable(), compaction: unavailable() },
    subscriptionQuota: unavailable(),
  };
}

function quotaUnavailable(
  accountId: string,
  reason: 'unsupported' | 'account-unavailable' | 'observation-timeout',
  observedAt: number,
): SubscriptionQuotaObservationBatch {
  return {
    runtimeId: CODEX_RUNTIME_ID,
    accountId,
    availability: 'unavailable',
    reason,
    observedAt,
  };
}

function freezeSelection(selection: RuntimeSelection): RuntimeSelection {
  const effort = selection.effort.kind === 'selected'
    ? Object.freeze({ kind: 'selected' as const, value: selection.effort.value })
    : Object.freeze({ kind: selection.effort.kind });
  return Object.freeze({
    runtimeId: selection.runtimeId,
    accountId: selection.accountId,
    model: selection.model,
    effort,
  });
}

function isRuntimePeer(value: unknown): value is CodexRuntimePeer {
  if (value === null || typeof value !== 'object') return false;
  try {
    const peer = value as Partial<CodexRuntimePeer>;
    return typeof peer.startThread === 'function' && typeof peer.resumeThread === 'function' &&
      typeof peer.startTurn === 'function' && typeof peer.interruptTurn === 'function' &&
      typeof peer.notifications === 'function' &&
      typeof peer.dispose === 'function';
  } catch {
    return false;
  }
}

function hasAppTools(tools: CreateRuntimeSession['tools']): boolean {
  if (tools === undefined) return false;
  try {
    return !Array.isArray(tools.toolDefs) || tools.toolDefs.length !== 0 ||
      !Array.isArray(tools.allowedToolNames) || tools.allowedToolNames.length !== 0;
  } catch {
    return true;
  }
}

function canonicalAbsolutePath(value: unknown): value is string {
  return exactString(value) && isAbsolute(value) && resolve(value) === value;
}

function exactString(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && value === value.trim() &&
    !value.includes('\u0000');
}

function nativeId(value: unknown): value is string {
  return exactString(value) &&
    /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
}
