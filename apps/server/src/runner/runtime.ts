// Canonical agent-runtime contract — the single seam the whole product hangs on.
//
// PC-SDK owns product semantics (sessions, turns, contracts, dispatch); agent
// runtimes (Claude Agent SDK, OpenAI Codex, …) plug in as ADAPTERS that
// translate their native behavior into these canonical shapes. Only adapter
// modules import provider runtime packages or parse native events
// (docs/agent-runtime-architecture.md — locked).
//
// The RuntimeEvent union below is what the SDK→contract mapping table
// (docs/event-contract.md) consumes — an adapter maps each native message to
// one of these; the turn-runner maps these to ChatEvents. Unknown native
// variants are dropped inside the adapter (never surfaced as an unknown
// RuntimeEvent).

import {
  isRuntimeCapabilities,
  isRuntimeModelDiscovery,
  isRuntimeSelection,
  isSubscriptionQuotaIdentity,
  type ActivityPhase,
  type ContextObservation,
  type RuntimeCapabilities,
  type RuntimeModel,
  type RuntimeModelDiscovery,
  type RuntimeSelection,
  type RuntimeSelectionErrorCode,
  type RuntimeSelectionValidation,
  type RuntimeSessionReceipt,
  type SubscriptionQuotaObservationBatch,
  type ToolStateEvent,
  type TurnStopReason,
} from '@pc/contracts';
import type { BridgeBuild } from '../mcp/bridge.ts';

export type {
  ContextObservation,
  RuntimeCapabilities,
  RuntimeModel,
  RuntimeModelDiscovery,
  RuntimeSelection,
  RuntimeSelectionErrorCode,
  RuntimeSelectionValidation,
  RuntimeSessionReceipt,
  SubscriptionQuotaObservationBatch,
} from '@pc/contracts';

/** Per-turn token telemetry (native result usage). Maps to the chat `usage`
 * event; distinct from account-scoped subscription-quota observations. */
export interface RuntimeUsage {
  inputTokens: number;
  outputTokens: number;
  cacheCreationTokens: number;
  cacheReadTokens: number;
  model: string | null;
}

/** One block of an assistant message. */
export type AssistantBlock =
  { kind: 'text'; text: string };

/** Streaming-delta payload. */
export type RuntimeDelta =
  | { kind: 'message-start' }
  | { kind: 'text-delta'; text: string }
  | { kind: 'message-end' };

interface RuntimeResultBase {
  type: 'result';
  stopReason: TurnStopReason | null;
  usage: RuntimeUsage | null;
  durationMs: number | null;
  /** Turn count when the runtime reports it, else null. */
  numTurns: number | null;
}

/** A terminal receipt is deliberately discriminated: adapters cannot claim a
 * successful turn while also classifying it as an error (or vice versa). */
export type RuntimeResultEvent =
  | (RuntimeResultBase & {
      ok: true;
      error: null;
      outcome: 'ok';
    })
  | (RuntimeResultBase & {
      ok: false;
      error: string | null;
      outcome: 'error' | 'aborted' | 'budget-exhausted';
    });

/** The typed events a runtime session yields for one turn. Adapters mint
 * provider-neutral item ids and reduce native parentage to primary/sidechain. */
export type RuntimeEvent =
  // Positive native create/attach observation. Capability support alone is
  // never treated as proof that this particular native continuation worked.
  | { type: 'session-started'; receipt: RuntimeSessionReceipt }
  // Public assistant block (text or tool use). Private reasoning is absent.
  | { type: 'assistant-block'; itemId: string; scope: 'primary' | 'sidechain'; block: AssistantBlock }
  // One provider-neutral tool observation. It contains no native id/input/output.
  | {
      type: 'tool-state';
      scope: 'primary' | 'sidechain';
      event: ToolStateEvent;
    }
  // Closed safe operational activity. Turn-starting is app-owned at claim.
  | {
      type: 'activity-state';
      phase: Exclude<ActivityPhase, 'turn-starting'>;
    }
  // Streaming delta (main thread only).
  | { type: 'delta'; itemId: string; scope: 'primary' | 'sidechain'; delta: RuntimeDelta }
  // Turn terminal. Native terminal vocabulary is classified by the adapter.
  | RuntimeResultEvent
  // Session-state transitions.
  | { type: 'session-state'; state: 'idle' | 'running' | 'requires_action'; permissionMode: string | null }
  // Context compaction. Malformed native details remain explicit unknown/null.
  | {
      type: 'compaction';
      trigger: 'manual' | 'auto' | 'unknown';
      preTokens: number | null;
      postTokens: number | null;
    }
  // Provider retry normalized to numeric facts; native error prose is absent.
  | { type: 'api-retry'; attempt: number | null; maxRetries: number | null }
  // Provider-neutral subscription-quota observation. Per-turn token usage and
  // per-session context remain separate event families.
  | { type: 'subscription-quota'; batch: SubscriptionQuotaObservationBatch }
  // Generic runtime notice surfaced as a system chat event.
  | {
      type: 'system';
      subtype: string;
      level: 'info' | 'notice' | 'warning' | 'error';
      message: string;
    }
  // Retract already-delivered events by frame key (model-refusal fallback).
  | { type: 'supersedes'; streamIds: string[] };

/** The permission seam. A session calls this to block on an app answer; the
 *  app resolves it (or a watchdog denies it). */
export interface AskRequest {
  toolName: string;
  /** Adapter-minted canonical identity; native ids never cross this seam. */
  callId: string;
  toolInput: unknown;
  appSessionId: string;
}
export interface AskDecision {
  behavior: 'allow' | 'deny';
  decidedBy: 'user' | 'timeout' | 'session';
  message?: string;
  updatedInput?: Record<string, unknown>;
  rawAnswer?: string; // literal browser reply, for answer-style tools
}
export interface AskHandle {
  requestId: string;
  decision: Promise<AskDecision>;
  /** Idempotently resolve a still-open request as session-attributed denial. */
  cancel: () => void;
}
export type AskHandler = (req: AskRequest) => AskHandle;

/** One live runtime session (adapter-owned native thread/session). Returned
 *  already started — there is no separate start step. */
export interface RuntimeSession {
  /** Send one user turn; yields RuntimeEvents until the turn's `result`. The
   *  iterable completes when the turn ends. */
  sendTurn(text: string): AsyncIterable<RuntimeEvent>;
  /** Observe current context use without inferring it from turn usage. Runtime
   *  and transport failures are returned as typed unavailable observations. */
  observeContext(): Promise<ContextObservation>;
  /** Request abortion of the in-flight turn. Promise resolution acknowledges
   *  native command acceptance only; it never proves abortion. The exact
   *  correlated `sendTurn` terminal is the positive abort receipt. */
  interrupt(): Promise<void>;
  /** Tear the session down (ends the native loop). Idempotent. */
  dispose(): Promise<void>;
}

/** Adapter-facing session inputs — the provider-neutral instruction package.
 *  Adapters compile these into their native surfaces (system prompt, tool
 *  wiring, credential env). */
export interface CreateRuntimeSession {
  appSessionId: string;
  projectId: string;
  /** Durable attempt identity; every native start receipt must echo it exactly. */
  continuationAttemptId: string;
  selection: RuntimeSelection;
  /** Charter / system prompt (provider-neutral text). */
  instructions?: string;
  cwd?: string;
  /** App-owned tool policy (bound pc_* + bridged MCP tools as plain defs). */
  tools?: BridgeBuild;
  /** Native tool names the runtime may auto-allow (e.g. Read/Glob/Grep). */
  allowedNativeTools?: string[];
  maxTurns?: number;
  /** Permission callback; omit ⇒ the adapter's non-interactive default. */
  ask?: AskHandler;
  /** Non-interactive dispatch: never block on permissions. */
  bypassPermissions?: boolean;
}

export interface ResumeRuntimeSession extends CreateRuntimeSession {
  /** Adapter-native session/thread id captured by a positive start receipt. */
  nativeSessionId: string;
}

/** An agent runtime (Claude Agent SDK, Codex, a test fake). One instance per
 *  runtime, registered at the composition root. */
export interface AgentRuntimeAdapter {
  readonly id: string;
  capabilities(accountId: string): Promise<RuntimeCapabilities>;
  listModels(accountId: string): Promise<RuntimeModelDiscovery>;
  /** Observe account-scoped subscription quota without creating an app
   * session. Provider auth, transport, and native response parsing stay inside
   * the adapter; callers may bound the attempt with an AbortSignal. */
  observeSubscriptionQuota(
    accountId: string,
    options?: { signal?: AbortSignal },
  ): Promise<SubscriptionQuotaObservationBatch>;
  createSession(input: CreateRuntimeSession): Promise<RuntimeSession>;
  resumeSession(input: ResumeRuntimeSession): Promise<RuntimeSession>;
}

export type RuntimeAdapterResolution =
  | { status: 'resolved'; adapter: AgentRuntimeAdapter }
  | { status: 'invalid'; code: 'runtime-not-registered' };

export type RuntimeContinuationRequest =
  | { mode: 'create' }
  | { mode: 'resume'; nativeSessionId: string };

/** User/default selection request before adapter facts normalize effort into
 * the explicit durable union. Null is never guessed: it becomes `none` only
 * on positive support or `unavailable` only on positive non-support. */
export interface RuntimeSelectionRequest {
  runtimeId: string;
  accountId: string;
  model: string;
  effort: string | null;
}

/** Expected selection/preflight failures carry a stable code and never cause
 * an alternate adapter, model, account, or billing path to be attempted. */
export class RuntimeSelectionRejectedError extends Error {
  readonly code: RuntimeSelectionErrorCode;

  constructor(code: RuntimeSelectionErrorCode) {
    super(`runtime selection rejected: ${code}`);
    this.name = 'RuntimeSelectionRejectedError';
    this.code = code;
  }
}

export type RuntimeRegistrationErrorCode =
  | 'invalid-runtime-id'
  | 'duplicate-runtime-id';

/** Composition-time registry failures are typed startup evidence. They never
 * replace, overwrite, or fall back from an already registered adapter. */
export class RuntimeRegistrationError extends Error {
  readonly code: RuntimeRegistrationErrorCode;

  constructor(code: RuntimeRegistrationErrorCode, runtimeId?: string) {
    super(runtimeId ? `${code}: ${runtimeId}` : code);
    this.name = 'RuntimeRegistrationError';
    this.code = code;
  }
}

function invalid(code: RuntimeSelectionErrorCode): RuntimeSelectionValidation {
  return { status: 'invalid', code };
}

function cloneRuntimeSelection(selection: RuntimeSelection): RuntimeSelection {
  return {
    runtimeId: selection.runtimeId,
    accountId: selection.accountId,
    model: selection.model,
    effort: selection.effort.kind === 'selected'
      ? { kind: 'selected', value: selection.effort.value }
      : { kind: selection.effort.kind },
  };
}

function captureRuntimeSelection(value: unknown): RuntimeSelection | null {
  try {
    return isRuntimeSelection(value) ? cloneRuntimeSelection(value) : null;
  } catch {
    return null;
  }
}

function cloneRuntimeCapabilities(capabilities: RuntimeCapabilities): RuntimeCapabilities {
  const cloneState = <T extends RuntimeCapabilities['nativeContinuation']>(state: T): T => (
    state.status === 'supported'
      ? { status: 'supported' } as T
      : { status: state.status, code: state.code } as T
  );
  return {
    runtimeId: capabilities.runtimeId,
    accountId: capabilities.accountId,
    nativeContinuation: cloneState(capabilities.nativeContinuation),
    modelDiscovery: cloneState(capabilities.modelDiscovery),
    effortControl: cloneState(capabilities.effortControl),
    context: {
      currentUse: capabilities.context.currentUse.status === 'supported'
        ? {
            status: 'supported',
            confidences: [...capabilities.context.currentUse.confidences],
          }
        : {
            status: capabilities.context.currentUse.status,
            code: capabilities.context.currentUse.code,
          },
      compaction: capabilities.context.compaction.status === 'supported'
        ? { status: 'supported' }
        : {
            status: capabilities.context.compaction.status,
            code: capabilities.context.compaction.code,
          },
    },
    subscriptionQuota: capabilities.subscriptionQuota.status === 'supported'
      ? {
          status: 'supported',
          sourceSemantics: [...capabilities.subscriptionQuota.sourceSemantics],
          confidences: [...capabilities.subscriptionQuota.confidences],
        }
      : {
          status: capabilities.subscriptionQuota.status,
          code: capabilities.subscriptionQuota.code,
        },
  };
}

function captureRuntimeCapabilities(value: unknown): RuntimeCapabilities | null {
  try {
    return isRuntimeCapabilities(value) ? cloneRuntimeCapabilities(value) : null;
  } catch {
    return null;
  }
}

function cloneRuntimeModelDiscovery(discovery: RuntimeModelDiscovery): RuntimeModelDiscovery {
  if (discovery.status !== 'available') {
    return { status: discovery.status, code: discovery.code };
  }
  return {
    status: 'available',
    models: discovery.models.map((model) => ({
      id: model.id,
      resolvedId: model.resolvedId,
      label: model.label,
      description: model.description,
      effort: model.effort.status === 'supported'
        ? { status: 'supported', values: [...model.effort.values] }
        : { status: model.effort.status, code: model.effort.code },
    })),
  };
}

function captureRuntimeModelDiscovery(value: unknown): RuntimeModelDiscovery | null {
  try {
    return isRuntimeModelDiscovery(value) ? cloneRuntimeModelDiscovery(value) : null;
  } catch {
    return null;
  }
}

function captureSelectionRequest(
  request: RuntimeSelectionRequest,
): RuntimeSelectionRequest | RuntimeSelectionValidation {
  try {
    if (request === null || typeof request !== 'object' || Array.isArray(request)) {
      return invalid('selection-unavailable');
    }
    const value = request as unknown as Record<string, unknown>;
    if (Object.keys(value).some((key) => !['runtimeId', 'accountId', 'model', 'effort'].includes(key))) {
      return invalid('selection-unavailable');
    }
    if (
      typeof value.runtimeId !== 'string' ||
      !value.runtimeId.trim() ||
      value.runtimeId !== value.runtimeId.trim()
    ) {
      return invalid('runtime-not-registered');
    }
    if (
      typeof value.accountId !== 'string' ||
      !value.accountId.trim() ||
      value.accountId !== value.accountId.trim()
    ) {
      return invalid('account-unavailable');
    }
    if (
      typeof value.model !== 'string' ||
      !value.model.trim() ||
      value.model !== value.model.trim()
    ) {
      return invalid('model-unsupported');
    }
    if (value.effort !== null && typeof value.effort !== 'string') {
      return invalid('effort-value-unsupported');
    }
    return {
      runtimeId: value.runtimeId,
      accountId: value.accountId,
      model: value.model,
      effort: value.effort as string | null,
    };
  } catch {
    return invalid('selection-unavailable');
  }
}

function matchingModel(
  models: RuntimeModel[],
  selectedModel: string,
): RuntimeModel | null {
  const exact = models.find((model) => model.id === selectedModel);
  if (exact) return exact;
  const resolved = models.filter((model) => model.resolvedId === selectedModel);
  return resolved.length === 1 ? resolved[0]! : null;
}

/** Validate one complete immutable selection against adapter/account facts.
 * This helper is shared by registry preflight and the adapter's immediate
 * pre-mint revalidation, closing the validation-to-execution fallback gap. */
export async function validateRuntimeSelection(
  adapter: AgentRuntimeAdapter,
  selection: RuntimeSelection,
): Promise<RuntimeSelectionValidation> {
  const captured = captureRuntimeSelection(selection);
  if (!captured) return invalid('selection-unavailable');
  if (adapter.id !== captured.runtimeId) return invalid('account-runtime-mismatch');

  let capabilitiesResult: unknown;
  try {
    capabilitiesResult = await adapter.capabilities(captured.accountId);
  } catch {
    return invalid('capabilities-unavailable');
  }
  const capabilities = captureRuntimeCapabilities(capabilitiesResult);
  if (!capabilities) return invalid('capabilities-unavailable');
  if (
    capabilities.runtimeId !== captured.runtimeId ||
    capabilities.accountId !== captured.accountId
  ) return invalid('account-runtime-mismatch');
  if (capabilities.modelDiscovery.status === 'unsupported') {
    return invalid('model-discovery-unsupported');
  }
  if (capabilities.modelDiscovery.status === 'unavailable') {
    if (capabilities.modelDiscovery.code === 'account-unavailable') {
      return invalid('account-unavailable');
    }
    return invalid('model-discovery-unavailable');
  }

  let discoveryResult: unknown;
  try {
    discoveryResult = await adapter.listModels(captured.accountId);
  } catch {
    return invalid('model-discovery-unavailable');
  }
  const discovery = captureRuntimeModelDiscovery(discoveryResult);
  if (!discovery) return invalid('model-discovery-unavailable');
  if (discovery.status === 'unsupported') return invalid('model-discovery-unsupported');
  if (discovery.status === 'unavailable') {
    return invalid(discovery.code === 'account-unavailable'
      ? 'account-unavailable'
      : 'model-discovery-unavailable');
  }

  const model = matchingModel(discovery.models, captured.model);
  if (!model) return invalid('model-unsupported');

  if (captured.effort.kind === 'selected') {
    if (capabilities.effortControl.status === 'unsupported' || model.effort.status === 'unsupported') {
      return invalid('effort-unsupported');
    }
    if (capabilities.effortControl.status === 'unavailable' || model.effort.status === 'unavailable') {
      return invalid('effort-unavailable');
    }
    if (!model.effort.values.includes(captured.effort.value)) {
      return invalid('effort-value-unsupported');
    }
  } else if (captured.effort.kind === 'none') {
    // `none` means effort is positively supported but no override was chosen.
    if (capabilities.effortControl.status === 'unsupported' || model.effort.status === 'unsupported') {
      return invalid('effort-unsupported');
    }
    if (capabilities.effortControl.status === 'unavailable' || model.effort.status === 'unavailable') {
      return invalid('effort-unavailable');
    }
  } else {
    // `unavailable` is valid only from positive non-support. It cannot turn
    // inconclusive metadata or an omitted supported choice into durable truth.
    if (
      capabilities.effortControl.status !== 'unsupported' &&
      model.effort.status !== 'unsupported'
    ) return invalid('effort-unavailable');
  }

  return { status: 'valid', selection: captured };
}

export async function preflightRuntimeSelection(
  adapter: AgentRuntimeAdapter,
  selection: RuntimeSelection,
  continuation: RuntimeContinuationRequest,
): Promise<RuntimeSelectionValidation> {
  let capturedContinuation: RuntimeContinuationRequest;
  if (continuation?.mode === 'create') {
    capturedContinuation = { mode: 'create' };
  } else if (continuation?.mode === 'resume') {
    if (
      typeof continuation.nativeSessionId !== 'string' ||
      !continuation.nativeSessionId.trim() ||
      continuation.nativeSessionId !== continuation.nativeSessionId.trim()
    ) {
      return invalid('native-session-missing');
    }
    capturedContinuation = {
      mode: 'resume',
      nativeSessionId: continuation.nativeSessionId,
    };
  } else {
    return invalid('selection-unavailable');
  }
  const validation = await validateRuntimeSelection(adapter, selection);
  if (validation.status === 'invalid' || capturedContinuation.mode === 'create') return validation;

  let capabilitiesResult: unknown;
  try {
    capabilitiesResult = await adapter.capabilities(validation.selection.accountId);
  } catch {
    return invalid('capabilities-unavailable');
  }
  const capabilities = captureRuntimeCapabilities(capabilitiesResult);
  if (!capabilities) return invalid('capabilities-unavailable');
  if (
    capabilities.runtimeId !== validation.selection.runtimeId ||
    capabilities.accountId !== validation.selection.accountId
  ) return invalid('account-runtime-mismatch');
  if (capabilities.nativeContinuation.status === 'unavailable') {
    return invalid(capabilities.nativeContinuation.code === 'account-unavailable'
      ? 'account-unavailable'
      : 'capabilities-unavailable');
  }
  if (capabilities.nativeContinuation.status !== 'supported') {
    return invalid('native-resume-unsupported');
  }
  return validation;
}

/** Adapter lookup — the ONLY place a runtimeId resolves to a concrete
 *  adapter. Core services receive sessions, never adapters. */
export class RuntimeRegistry {
  private readonly adapters = new Map<string, AgentRuntimeAdapter>();

  register(adapter: AgentRuntimeAdapter): void {
    let runtimeId: unknown;
    try {
      runtimeId = adapter.id;
    } catch {
      throw new RuntimeRegistrationError('invalid-runtime-id');
    }
    if (
      !isSubscriptionQuotaIdentity(runtimeId)
    ) {
      throw new RuntimeRegistrationError('invalid-runtime-id');
    }
    if (this.adapters.has(runtimeId)) {
      throw new RuntimeRegistrationError('duplicate-runtime-id', runtimeId);
    }
    this.adapters.set(runtimeId, adapter);
  }

  resolve(runtimeId: string): RuntimeAdapterResolution {
    const adapter = this.adapters.get(runtimeId);
    return adapter
      ? { status: 'resolved', adapter }
      : { status: 'invalid', code: 'runtime-not-registered' };
  }

  get(runtimeId: string): AgentRuntimeAdapter {
    const resolution = this.resolve(runtimeId);
    if (resolution.status === 'invalid') {
      throw new RuntimeSelectionRejectedError(resolution.code);
    }
    return resolution.adapter;
  }

  has(runtimeId: string): boolean {
    return this.adapters.has(runtimeId);
  }

  /** Registered runtime ids, insertion order. Read-only enumeration for
   *  provider-neutral surfaces (e.g. an availability listing) that must not
   *  hardcode which runtimes exist. */
  ids(): string[] {
    return [...this.adapters.keys()];
  }

  async validate(selection: RuntimeSelection): Promise<RuntimeSelectionValidation> {
    const captured = captureRuntimeSelection(selection);
    if (!captured) return invalid('selection-unavailable');
    const resolution = this.resolve(captured.runtimeId);
    if (resolution.status === 'invalid') return resolution;
    return validateRuntimeSelection(resolution.adapter, captured);
  }

  async resolveSelection(
    request: RuntimeSelectionRequest,
  ): Promise<RuntimeSelectionValidation> {
    const captured = captureSelectionRequest(request);
    if ('status' in captured) return captured;
    const resolution = this.resolve(captured.runtimeId);
    if (resolution.status === 'invalid') return resolution;
    const adapter = resolution.adapter;

    let capabilitiesResult: unknown;
    try {
      capabilitiesResult = await adapter.capabilities(captured.accountId);
    } catch {
      return invalid('capabilities-unavailable');
    }
    const capabilities = captureRuntimeCapabilities(capabilitiesResult);
    if (!capabilities) return invalid('capabilities-unavailable');
    if (
      capabilities.runtimeId !== captured.runtimeId ||
      capabilities.accountId !== captured.accountId
    ) return invalid('account-runtime-mismatch');
    if (capabilities.modelDiscovery.status === 'unsupported') {
      return invalid('model-discovery-unsupported');
    }
    if (capabilities.modelDiscovery.status === 'unavailable') {
      return invalid(capabilities.modelDiscovery.code === 'account-unavailable'
        ? 'account-unavailable'
        : 'model-discovery-unavailable');
    }

    let discoveryResult: unknown;
    try {
      discoveryResult = await adapter.listModels(captured.accountId);
    } catch {
      return invalid('model-discovery-unavailable');
    }
    const discovery = captureRuntimeModelDiscovery(discoveryResult);
    if (!discovery) return invalid('model-discovery-unavailable');
    if (discovery.status === 'unsupported') return invalid('model-discovery-unsupported');
    if (discovery.status === 'unavailable') {
      return invalid(discovery.code === 'account-unavailable'
        ? 'account-unavailable'
        : 'model-discovery-unavailable');
    }
    const model = matchingModel(discovery.models, captured.model);
    if (!model) return invalid('model-unsupported');

    let effort: RuntimeSelection['effort'];
    if (captured.effort !== null) {
      const selectedEffort = captured.effort;
      if (!selectedEffort || selectedEffort !== selectedEffort.trim()) {
        return invalid('effort-value-unsupported');
      }
      if (
        capabilities.effortControl.status === 'unsupported' ||
        model.effort.status === 'unsupported'
      ) return invalid('effort-unsupported');
      if (
        capabilities.effortControl.status === 'unavailable' ||
        model.effort.status === 'unavailable'
      ) return invalid('effort-unavailable');
      if (!model.effort.values.includes(selectedEffort)) {
        return invalid('effort-value-unsupported');
      }
      effort = { kind: 'selected', value: selectedEffort };
    } else if (
      capabilities.effortControl.status === 'unsupported' ||
      model.effort.status === 'unsupported'
    ) {
      effort = { kind: 'unavailable' };
    } else if (
      capabilities.effortControl.status === 'unavailable' ||
      model.effort.status === 'unavailable'
    ) {
      // Inconclusive facts cannot be promoted into an immutable stamp.
      return invalid('effort-unavailable');
    } else {
      effort = { kind: 'none' };
    }

    const selection: RuntimeSelection = {
      runtimeId: captured.runtimeId,
      accountId: captured.accountId,
      model: captured.model,
      effort,
    };
    return { status: 'valid', selection };
  }

  async preflight(
    selection: RuntimeSelection,
    continuation: RuntimeContinuationRequest,
  ): Promise<RuntimeSelectionValidation> {
    const captured = captureRuntimeSelection(selection);
    if (!captured) return invalid('selection-unavailable');
    const resolution = this.resolve(captured.runtimeId);
    if (resolution.status === 'invalid') return resolution;
    return preflightRuntimeSelection(resolution.adapter, captured, continuation);
  }
}

/** Retry a rejected `resolveSelection` exactly once with the target
 * runtime's own first live-discovered model, when the caller opts in via
 * `allowModelFallback`. Composition roots set that flag only when a stored
 * model default was written for a different runtime than the one now being
 * resolved (e.g. an explicit runtime switch) — a model shorthand from one
 * runtime is never meaningful on another. The fallback model always comes
 * from the adapter's own live discovery for the resolved account; one is
 * never invented here. Discovery that is unavailable, errors, or returns no
 * models leaves the original typed `model-unsupported` rejection untouched. */
export async function resolveSelectionWithModelFallback(
  registry: RuntimeRegistry,
  request: RuntimeSelectionRequest,
  allowModelFallback: boolean,
): Promise<RuntimeSelectionValidation> {
  const resolved = await registry.resolveSelection(request);
  if (!allowModelFallback || resolved.status !== 'invalid' || resolved.code !== 'model-unsupported') {
    return resolved;
  }
  const resolution = registry.resolve(request.runtimeId);
  if (resolution.status === 'invalid') return resolved;
  let discovery: RuntimeModelDiscovery;
  try {
    discovery = await resolution.adapter.listModels(request.accountId);
  } catch {
    return resolved;
  }
  const fallbackModel = discovery.status === 'available' ? discovery.models[0]?.id : undefined;
  if (!fallbackModel) return resolved;
  return registry.resolveSelection({ ...request, model: fallbackModel });
}

/** How the chat engine mints its per-session runtime session. The composition
 *  root supplies the closure that resolves selection + instructions + tools
 *  and calls the registered adapter (create or resume). */
export interface MintRuntimeSession {
  projectId: string;
  appSessionId: string;
  /** Durable attempt identity allocated before the runtime is minted. */
  continuationAttemptId: string;
  /** Durable app-session stamp; composition must never re-resolve defaults. */
  selection: RuntimeSelection;
  continuation: RuntimeContinuationRequest;
  cwd?: string;
  ask?: AskHandler;
}
export type RuntimeSessionFactory = (
  ctx: MintRuntimeSession,
) => RuntimeSession | Promise<RuntimeSession>;
