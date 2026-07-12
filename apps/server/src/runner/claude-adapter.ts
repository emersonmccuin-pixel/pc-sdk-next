// ClaudeRuntimeAdapter — the Claude Agent SDK runtime behind the canonical
// AgentRuntimeAdapter contract.
//
// THIS IS THE ONLY FILE IN THE REPO THAT IMPORTS THE SDK (guard test:
// test/sdk-import-guard.test.ts greps for the import specifier). Everything
// else hangs off the canonical `RuntimeSession` seam. The MCP bridge hands us
// plain tool definitions; we do the `tool()`/`createSdkMcpServer()` wrapping
// here so the one-SDK-import invariant holds.
//
// Streaming-input mode: ONE `query()` per session with an AsyncIterable prompt.
// Each `sendTurn` pushes a user message into that prompt so `interrupt()` works
// (control methods require streaming-input). `includePartialMessages: true`
// yields `stream_event` deltas → canonical sequenced stream events. `resume` re-attaches after a
// restart. `canUseTool` bridges to the app's ask registry. Native SDK messages
// are mapped to canonical `RuntimeEvent`s per the contract table; unknown
// variants are dropped here (never surfaced as an unknown RuntimeEvent).

import { randomUUID } from 'node:crypto';
import {
  createSdkMcpServer,
  query,
  tool,
  type Options,
  type PermissionResult,
  type Query,
  type SDKMessage,
  type SDKUserMessage,
} from '@anthropic-ai/claude-agent-sdk';
import {
  isCanonicalToolName,
  safeToolSummary,
  type ToolApprovalSnapshot,
  type ToolCallState,
  type ToolStateEvent,
  type ToolTerminalReason,
  type UsageSnapshot,
} from '@pc/contracts';
import type { BridgeBuild } from '../mcp/bridge.ts';
import type { AccountRegistry } from './account-env.ts';
import type {
  AgentRuntimeAdapter,
  AskDecision,
  AskHandler,
  CreateRuntimeSession,
  ResumeRuntimeSession,
  RuntimeDelta,
  RuntimeEvent,
  RuntimeSession,
  RuntimeUsage,
} from './runtime.ts';

export const CLAUDE_RUNTIME_ID = 'claude-agent-sdk';

/** Native tools auto-allowed for the orchestrator (read-only surface).
 *  Anything else routes through `canUseTool` → the browser ask. */
export const BASE_ALLOWED_TOOLS = ['Read', 'Glob', 'Grep'];

const DEFAULT_SYSTEM_PROMPT = `You are the orchestrator of a local-first project workspace (PC-SDK).
You help the user explore and reason about the project in the working directory, using your tools.
Be direct and terse. Lead with the answer. Read files instead of guessing.`;

export interface ClaudeSessionConfig {
  /** Per-query env (account-scrubbed; sets CLAUDE_CONFIG_DIR). */
  env: Record<string, string>;
  /** Account id this session runs under — stamped onto usage snapshots. */
  accountId: string;
  model?: string;
  systemPrompt?: string;
  /** Working directory for the loop. `start`'s cwd wins; then this; then
   *  `process.cwd()`. */
  cwd?: string;
  /** Auto-allowed native tools; bridged MCP tool names are unioned in. */
  allowedTools?: string[];
  /** Bridge build (app-owned tool policy; may be empty). */
  bridge?: BridgeBuild;
  maxTurns?: number;
  /** Non-interactive dispatch: never block on permissions. */
  bypassPermissions?: boolean;
}

interface StartOptions {
  appSessionId: string;
  resumeNativeSessionId?: string;
  cwd?: string;
  ask?: AskHandler;
}

/** Single-consumer push queue with async iteration. */
class AsyncQueue<T> {
  private readonly values: T[] = [];
  private readonly waiters: Array<(r: IteratorResult<T>) => void> = [];
  private ended = false;

  push(value: T): void {
    if (this.ended) return;
    const w = this.waiters.shift();
    if (w) w({ value, done: false });
    else this.values.push(value);
  }

  end(): void {
    if (this.ended) return;
    this.ended = true;
    for (const w of this.waiters.splice(0)) w({ value: undefined as never, done: true });
  }

  async *[Symbol.asyncIterator](): AsyncIterator<T> {
    for (;;) {
      if (this.values.length) {
        yield this.values.shift() as T;
        continue;
      }
      if (this.ended) return;
      const next = await new Promise<IteratorResult<T>>((resolve) => this.waiters.push(resolve));
      if (next.done) return;
      yield next.value;
    }
  }
}

/**
 * Correlation state so streamed deltas and their final assistant blocks share
 * ONE key. Envelope `uuid`s are minted per emission — every `stream_event`
 * carries a fresh one — so keying on them splits a single streamed message
 * across many delta buffers (one bubble per chunk in the UI). The inner
 * Anthropic message id (`message.id`) is stable across a message's stream
 * events and its final `assistant` message(s), so it is the frame key.
 * `uuidToKey` translates `supersedes` lists (which reference envelope uuids)
 * to the keys the frames were actually stamped with.
 */
export interface SdkKeyContext {
  streamItemId: string | null;
  nativeToItemId: Map<string, string>;
  nativeToCallId: Map<string, string>;
  toolStates: Map<string, { event: ToolStateEvent; scope: 'primary' | 'sidechain' }>;
  idFactory: () => string;
  callIdFactory: () => string;
}

export function createSdkKeyContext(
  idFactory: () => string = randomUUID,
  callIdFactory: () => string = randomUUID,
): SdkKeyContext {
  return {
    streamItemId: null,
    nativeToItemId: new Map(),
    nativeToCallId: new Map(),
    toolStates: new Map(),
    idFactory,
    callIdFactory,
  };
}

/** Correlation is scoped to one active turn and reset only at a positive turn
 * boundary below. Arbitrary size eviction would let a late observation mint a
 * second canonical identity for an open item/call. */
function rememberKey(keys: SdkKeyContext, nativeId: string, itemId: string): void {
  if (!nativeId) return;
  keys.nativeToItemId.set(nativeId, itemId);
}

function rememberCallKey(keys: SdkKeyContext, nativeId: string, callId: string): void {
  if (!nativeId) return;
  keys.nativeToCallId.set(nativeId, callId);
}

function resetTurnCorrelation(keys: SdkKeyContext): void {
  keys.streamItemId = null;
  keys.nativeToItemId.clear();
  keys.nativeToCallId.clear();
  keys.toolStates.clear();
}

function canonicalItemId(keys: SdkKeyContext, nativeId: string): string {
  const existing = nativeId ? keys.nativeToItemId.get(nativeId) : undefined;
  if (existing) return existing;
  const itemId = keys.idFactory();
  rememberKey(keys, nativeId, itemId);
  return itemId;
}

function canonicalCallId(keys: SdkKeyContext, nativeId: string): string | null {
  if (!nativeId) return null;
  const existing = keys.nativeToCallId.get(nativeId);
  if (existing) return existing;
  const callId = keys.callIdFactory();
  rememberCallKey(keys, nativeId, callId);
  return callId;
}

interface ToolObservation {
  nativeId: string;
  name?: string;
  scope: 'primary' | 'sidechain';
  state: ToolCallState;
  approval?: ToolApprovalSnapshot;
  outcome?: { reason: ToolTerminalReason } | null;
}

const UNKNOWN_APPROVAL: ToolApprovalSnapshot = {
  status: 'unknown', source: null, requestId: null,
};
const RUNTIME_APPROVAL: ToolApprovalSnapshot = {
  status: 'not-required', source: 'runtime', requestId: null,
};

/** Race-safe native observation normalizer. Callback, assistant, progress,
 * result, and denial paths all enter here, so provider arrival order cannot
 * create regressions or expose a native id. */
export function observeToolState(
  keys: SdkKeyContext,
  observation: ToolObservation,
): RuntimeEvent[] {
  const callId = canonicalCallId(keys, observation.nativeId);
  if (!callId) return [];
  let current = keys.toolStates.get(callId);
  const name = current?.event.name ?? observation.name;
  if (
    !isCanonicalToolName(name) ||
    (current && observation.name && observation.name !== current.event.name)
  ) return [];
  const output: RuntimeEvent[] = [];
  const emit = (
    state: ToolCallState,
    approval: ToolApprovalSnapshot,
    outcome: { reason: ToolTerminalReason } | null = null,
  ): void => {
    const event: ToolStateEvent = {
      kind: 'tool-state',
      callId,
      name,
      state,
      safeSummary: safeToolSummary(name),
      approval,
      outcome,
    };
    current = { event, scope: current?.scope ?? observation.scope };
    keys.toolStates.set(callId, current);
    output.push({ type: 'tool-state', scope: current.scope, event });
  };

  if (!current) emit('requested', UNKNOWN_APPROVAL);
  if (!current) return output;
  const prior = current.event;
  if (prior.state === 'succeeded' || prior.state === 'failed' || prior.state === 'denied') return output;
  if (observation.state === 'requested') return output;

  if (observation.state === 'approval-needed') {
    if (prior.state !== 'requested' || !observation.approval || observation.approval.status !== 'pending') {
      return output;
    }
    emit('approval-needed', observation.approval);
    return output;
  }

  if (observation.state === 'running') {
    if (prior.state === 'running') return output;
    if (prior.state !== 'requested' && prior.state !== 'approval-needed') return output;
    let approval = observation.approval;
    if (!approval) {
      if (prior.state === 'approval-needed') return output;
      approval = RUNTIME_APPROVAL;
    }
    if (approval.status !== 'allowed' && approval.status !== 'not-required') return output;
    if (
      prior.state === 'requested'
      && approval.status === 'allowed'
      && approval.source !== 'runtime'
    ) return output;
    if (
      prior.state === 'approval-needed'
      && (
        prior.approval.status !== 'pending'
        || approval.status !== 'allowed'
        || approval.source !== 'user'
        || approval.requestId !== prior.approval.requestId
      )
    ) return output;
    emit('running', approval);
    return output;
  }

  if (observation.state === 'denied') {
    if (prior.state !== 'requested' && prior.state !== 'approval-needed') return output;
    const approval = observation.approval ?? {
      status: 'denied', source: 'runtime', requestId: null,
    };
    if (approval.status !== 'denied') return output;
    if (
      prior.state === 'requested'
      && (approval.source !== 'runtime' || approval.requestId !== null)
    ) return output;
    if (
      prior.state === 'approval-needed' &&
      prior.approval.status === 'pending' &&
      (
        approval.source === 'runtime'
        || approval.requestId !== prior.approval.requestId
      )
    ) return output;
    emit('denied', approval);
    return output;
  }

  if (observation.state === 'succeeded' || observation.state === 'failed') {
    if (prior.state === 'requested' || prior.state === 'approval-needed') {
      observeInto(output, keys, {
        ...observation,
        state: 'running',
        approval: observation.approval,
      });
      current = keys.toolStates.get(callId);
    }
    if (!current || current.event.state !== 'running') return output;
    emit(
      observation.state,
      current.event.approval,
      observation.state === 'failed'
        ? observation.outcome ?? { reason: 'tool-error' }
        : null,
    );
  }
  return output;
}

/** Append a recursive normalized observation without losing events already
 * accumulated by the caller. */
function observeInto(
  output: RuntimeEvent[],
  keys: SdkKeyContext,
  observation: ToolObservation,
): void {
  output.push(...observeToolState(keys, observation));
}

export interface ClaudePermissionHandlerDeps {
  keys: SdkKeyContext;
  appSessionId: string;
  ask: AskHandler;
  isActive: () => boolean;
  turnGeneration: () => number;
  emit: (events: readonly RuntimeEvent[]) => void;
}

/** Purely wired permission handler used by the live session and hostile tests.
 * Native request ids remain closure-local and only app request/call ids enter
 * RuntimeEvents. */
export function createClaudePermissionHandler(
  deps: ClaudePermissionHandlerDeps,
): NonNullable<Options['canUseTool']> {
  const responses = new Map<string, {
    toolName: string;
    nativeToolId: string;
    scope: 'primary' | 'sidechain';
    turnGeneration: number;
    response: Promise<PermissionResult>;
  }>();
  const decide = async (
    toolName: string,
    input: Record<string, unknown>,
    opts: Parameters<NonNullable<Options['canUseTool']>>[2],
    scope: 'primary' | 'sidechain',
    turnGeneration: number,
  ): Promise<PermissionResult> => {
    if (!deps.isActive() || deps.turnGeneration() !== turnGeneration) {
      return { behavior: 'deny', message: 'no active app turn' };
    }
    if (scope === 'sidechain') {
      // Sidechain transcript events are deliberately not projected into the
      // orchestrator turn. Registering an app Ask here would therefore create
      // an unpublishable waiter and block the SDK until timeout. Unsupported
      // sidechain approval fails closed immediately with terminal evidence.
      deps.emit(observeToolState(deps.keys, {
        nativeId: opts.toolUseID,
        name: toolName,
        scope,
        state: 'requested',
      }));
      deps.emit(observeToolState(deps.keys, {
        nativeId: opts.toolUseID,
        name: toolName,
        scope,
        state: 'denied',
        approval: { status: 'denied', source: 'runtime', requestId: null },
      }));
      return { behavior: 'deny', message: 'sidechain tool approval is unsupported' };
    }
    deps.emit(observeToolState(deps.keys, {
      nativeId: opts.toolUseID,
      name: toolName,
      scope,
      state: 'requested',
    }));
    const callId = canonicalCallId(deps.keys, opts.toolUseID);
    if (!callId) return { behavior: 'deny', message: 'tool call identity unavailable' };
    const handle = deps.ask({
      toolName,
      callId,
      toolInput: input,
      appSessionId: deps.appSessionId,
    });
    deps.emit(observeToolState(deps.keys, {
      nativeId: opts.toolUseID,
      name: toolName,
      scope,
      state: 'approval-needed',
      approval: { status: 'pending', source: null, requestId: handle.requestId },
    }));

    const cancel = () => handle.cancel();
    opts.signal.addEventListener('abort', cancel, { once: true });
    if (opts.signal.aborted) handle.cancel();
    let decision: AskDecision;
    try {
      decision = await handle.decision;
    } finally {
      opts.signal.removeEventListener('abort', cancel);
    }
    if (!deps.isActive() || deps.turnGeneration() !== turnGeneration) {
      return { behavior: 'deny', message: 'app turn changed before approval completed' };
    }
    if (decision.behavior === 'allow') {
      const answerDecision = decision.rawAnswer !== undefined
        ? resolveAnswerDecision(toolName, input, decision.rawAnswer)
        : null;
      if (answerDecision?.behavior === 'deny') {
        deps.emit(observeToolState(deps.keys, {
          nativeId: opts.toolUseID,
          name: toolName,
          scope,
          state: 'denied',
          approval: { status: 'denied', source: 'user', requestId: handle.requestId },
        }));
        return answerDecision;
      }
      deps.emit(observeToolState(deps.keys, {
        nativeId: opts.toolUseID,
        name: toolName,
        scope,
        state: 'running',
        approval: { status: 'allowed', source: 'user', requestId: handle.requestId },
      }));
      if (answerDecision) return answerDecision;
      return { behavior: 'allow', updatedInput: decision.updatedInput ?? input };
    }
    deps.emit(observeToolState(deps.keys, {
      nativeId: opts.toolUseID,
      name: toolName,
      scope,
      state: 'denied',
      approval: {
        status: 'denied',
        source: decision.decidedBy,
        requestId: handle.requestId,
      },
    }));
    return { behavior: 'deny', message: decision.message ?? 'denied' };
  };

  return (toolName, input, opts) => {
    const scope = opts.agentID ? 'sidechain' : 'primary';
    if (!deps.isActive()) {
      return Promise.resolve({ behavior: 'deny', message: 'no active app turn' });
    }
    const turnGeneration = deps.turnGeneration();
    const nativeRequestId = opts.requestId || `tool:${opts.toolUseID}`;
    const existing = responses.get(nativeRequestId);
    if (existing) {
      if (
        existing.toolName === toolName &&
        existing.nativeToolId === opts.toolUseID &&
        existing.scope === scope &&
        existing.turnGeneration === turnGeneration
      ) {
        return existing.response;
      }
      deps.emit(observeToolState(deps.keys, {
        nativeId: opts.toolUseID,
        name: toolName,
        scope,
        state: 'requested',
      }));
      deps.emit(observeToolState(deps.keys, {
        nativeId: opts.toolUseID,
        name: toolName,
        scope,
        state: 'denied',
        approval: { status: 'denied', source: 'runtime', requestId: null },
      }));
      return Promise.resolve({
        behavior: 'deny',
        message: 'conflicting runtime permission request identity',
      });
    }
    const response = decide(toolName, input, opts, scope, turnGeneration);
    responses.set(nativeRequestId, {
      toolName,
      nativeToolId: opts.toolUseID,
      scope,
      turnGeneration,
      response,
    });
    // Keep request receipts for this runtime-session lifetime. Evicting an
    // unresolved callback creates a second app Ask; evicting a settled one can
    // make a late native redelivery reopen a terminal authorization.
    return response;
  };
}

export class ClaudeRuntimeSession implements RuntimeSession {
  private readonly config: ClaudeSessionConfig;
  private readonly keys: SdkKeyContext = createSdkKeyContext();
  private started = false;
  private disposed = false;
  private queryClosed = false;
  private turnGeneration = 0;
  private q: Query | null = null;
  private promptQueue: AsyncQueue<SDKUserMessage> | null = null;
  private currentTurn: AsyncQueue<RuntimeEvent> | null = null;
  private pendingInit: RuntimeEvent | null = null;
  private sdkSessionId: string | null = null;
  private appSessionId = '';

  constructor(config: ClaudeSessionConfig) {
    this.config = config;
  }

  /** Open (or resume) the SDK session loop. The adapter calls this exactly
   *  once before handing the session out. */
  async start(opts: StartOptions): Promise<void> {
    if (this.started) return;
    this.started = true;
    this.appSessionId = opts.appSessionId;

    const promptQueue = new AsyncQueue<SDKUserMessage>();
    this.promptQueue = promptQueue;

    const bridge = this.config.bridge;
    const mcpServers =
      bridge && bridge.toolDefs.length > 0
        ? {
            [bridge.serverKey]: createSdkMcpServer({
              name: bridge.serverKey,
              version: '1.0.0',
              // Handler cast: the bridge guarantees the CallToolResult shape;
              // its arg type is the untyped proxy record, not the SDK's inferred
              // schema shape. Both are safe by construction.
              tools: bridge.toolDefs.map((d) =>
                tool(d.name, d.description, d.inputSchema, d.handler as never),
              ),
            }),
          }
        : undefined;

    const allowedTools = [
      ...new Set([...(this.config.allowedTools ?? BASE_ALLOWED_TOOLS), ...(bridge?.allowedToolNames ?? [])]),
    ];

    const resume = opts.resumeNativeSessionId && opts.resumeNativeSessionId.length > 0 ? opts.resumeNativeSessionId : undefined;

    const options: Options = {
      model: this.config.model ?? 'opus',
      systemPrompt: this.config.systemPrompt ?? DEFAULT_SYSTEM_PROMPT,
      env: this.config.env,
      cwd: opts.cwd ?? this.config.cwd ?? process.cwd(),
      includePartialMessages: true,
      permissionMode: this.config.bypassPermissions ? 'bypassPermissions' : 'default',
      maxTurns: this.config.maxTurns ?? 30,
      allowedTools,
      ...(mcpServers ? { mcpServers } : {}),
      ...(opts.ask ? { canUseTool: this.makeCanUseTool(opts.ask) } : {}),
      ...(resume ? { resume } : {}),
    };

    this.q = query({ prompt: promptQueue, options });
    void this.consume(this.q);
  }

  sendTurn(text: string): AsyncIterable<RuntimeEvent> {
    if (!this.started) throw new Error('ClaudeRuntimeSession.sendTurn before start');
    if (this.disposed) throw new Error('ClaudeRuntimeSession.sendTurn after dispose');
    if (this.queryClosed) throw new Error('Claude runtime query loop is closed');
    if (this.currentTurn) throw new Error('ClaudeRuntimeSession already has an active turn');
    this.turnGeneration += 1;
    resetTurnCorrelation(this.keys);
    const turn = new AsyncQueue<RuntimeEvent>();
    this.currentTurn = turn;
    if (this.pendingInit) {
      turn.push(this.pendingInit);
      this.pendingInit = null;
    }
    const userMsg = {
      type: 'user',
      message: { role: 'user', content: text },
      parent_tool_use_id: null,
    } as unknown as SDKUserMessage;
    this.promptQueue?.push(userMsg);
    return turn;
  }

  async interrupt(): Promise<void> {
    if (!this.q) throw new Error('Claude runtime is not ready to interrupt');
    // Command completion is not abort confirmation, but adapter rejection is
    // still meaningful negative evidence and must reach the durable interrupt
    // lifecycle instead of being swallowed.
    await this.q.interrupt();
  }

  async dispose(): Promise<void> {
    if (this.disposed) return;
    this.disposed = true;
    this.promptQueue?.end();
    try {
      await this.q?.interrupt();
    } catch {
      /* best-effort */
    }
    this.endCurrentTurnIfOpen('session disposed');
  }

  // ── SDK consumption ──────────────────────────────────────────────────────────

  private async consume(q: Query): Promise<void> {
    try {
      for await (const msg of q) {
        this.route(msg as SDKMessage);
      }
    } catch (err) {
      this.failCurrentTurn(err);
    } finally {
      this.queryClosed = true;
      this.endCurrentTurnIfOpen('sdk query loop ended');
    }
  }

  private route(msg: SDKMessage): void {
    const anyMsg = msg as { type: string; subtype?: string; session_id?: string; model?: string; permissionMode?: string };
    if (anyMsg.type === 'system' && anyMsg.subtype === 'init') {
      this.sdkSessionId = anyMsg.session_id ?? null;
      const rm: RuntimeEvent = {
        type: 'init',
        nativeSessionId: anyMsg.session_id ?? '',
        model: anyMsg.model ?? null,
        permissionMode: anyMsg.permissionMode ?? null,
      };
      if (this.currentTurn) this.currentTurn.push(rm);
      else this.pendingInit = rm;
      return;
    }

    const turn = this.currentTurn;
    if (!turn) return; // out-of-turn telemetry must not mutate successor-turn correlation
    const mapped = mapSdkMessage(msg, this.config.accountId, this.keys);
    if (mapped.length === 0) return;
    for (const rm of mapped) {
      turn.push(rm);
      if (rm.type === 'result') {
        resetTurnCorrelation(this.keys);
        this.currentTurn = null;
        turn.end();
        return;
      }
    }
  }

  private failCurrentTurn(err: unknown): void {
    const turn = this.currentTurn;
    if (!turn) return;
    this.currentTurn = null;
    resetTurnCorrelation(this.keys);
    void err;
    turn.push({
      type: 'result',
      ok: false,
      stopReason: null,
      usage: null,
      durationMs: null,
      error: 'runtime query failed',
      // A genuine stream break is a real failure, never mistaken for turn-budget
      // exhaustion (which only ever comes from a native `result` message).
      // Query-loop exception text is not typed native abort evidence.
      outcome: 'error',
      numTurns: null,
    });
    turn.end();
  }

  private endCurrentTurnIfOpen(reason: string): void {
    const turn = this.currentTurn;
    if (!turn) return;
    this.currentTurn = null;
    resetTurnCorrelation(this.keys);
    turn.push({
      type: 'result',
      ok: false,
      stopReason: null,
      usage: null,
      durationMs: null,
      error: reason,
      outcome: 'error',
      numTurns: null,
    });
    turn.end();
  }

  private makeCanUseTool(ask: AskHandler): NonNullable<Options['canUseTool']> {
    return createClaudePermissionHandler({
      keys: this.keys,
      appSessionId: this.appSessionId,
      ask,
      isActive: () => this.currentTurn !== null,
      turnGeneration: () => this.turnGeneration,
      emit: (events) => {
        const turn = this.currentTurn;
        if (!turn) return;
        for (const event of events) turn.push(event);
      },
    });
  }
}

/** Interpret a browser's `rawAnswer` for an answer-style tool (AskUserQuestion,
 *  ExitPlanMode). Returns null for any other tool, or for an allow with no
 *  rawAnswer — those fall through to the plain echo-input allow. Exported for
 *  unit testing; production callers go through `makeCanUseTool`. */
export function resolveAnswerDecision(
  toolName: string,
  input: Record<string, unknown>,
  rawAnswer: string,
): { behavior: 'allow'; updatedInput: Record<string, unknown> } | { behavior: 'deny'; message: string } | null {
  if (toolName === 'ExitPlanMode') {
    if (rawAnswer === 'reject') {
      return { behavior: 'deny', message: 'plan rejected' };
    }
    if (typeof input.plan !== 'string' || input.plan.trim().length === 0) {
      return { behavior: 'deny', message: 'plan details unavailable' };
    }
    if (rawAnswer !== 'approve') {
      return { behavior: 'deny', message: 'invalid plan response' };
    }
    return { behavior: 'allow', updatedInput: input };
  }
  if (toolName === 'AskUserQuestion') {
    if (
      !Array.isArray(input.questions) ||
      input.questions.length === 0 ||
      !input.questions.every((candidate) => (
        candidate !== null &&
        typeof candidate === 'object' &&
        !Array.isArray(candidate) &&
        typeof (candidate as { question?: unknown }).question === 'string' &&
        ((candidate as { question: string }).question.trim().length > 0)
      ))
    ) {
      return { behavior: 'deny', message: 'question details unavailable' };
    }
    const qs = input.questions as Array<{ question: string }>;
    const answers: Record<string, string> = {};
    let parsed = false;
    if (rawAnswer.trim().startsWith('[')) {
      // Multi-question JSON array from AskCard: [{question,answer},...]
      try {
        for (const { question, answer } of JSON.parse(rawAnswer)) {
          answers[question] = answer;
        }
        parsed = true;
      } catch {
        // Malformed reply — fall back to treating it as a single label.
      }
    }
    if (!parsed && qs[0]) {
      answers[qs[0].question] = rawAnswer;
    }
    return { behavior: 'allow', updatedInput: { ...input, answers } };
  }
  return null;
}

/** The Claude Agent SDK adapter. Owns credential-directory selection (via the
 *  account registry) and the native session lifecycle; receives everything
 *  else (instructions, tools, cwd, model) as the provider-neutral package. */
export class ClaudeRuntimeAdapter implements AgentRuntimeAdapter {
  readonly id = CLAUDE_RUNTIME_ID;
  private readonly accounts: AccountRegistry;

  constructor(deps: { accounts: AccountRegistry }) {
    this.accounts = deps.accounts;
  }

  async createSession(input: CreateRuntimeSession): Promise<RuntimeSession> {
    return this.mint(input, undefined);
  }

  async resumeSession(input: ResumeRuntimeSession): Promise<RuntimeSession> {
    return this.mint(input, input.nativeSessionId);
  }

  private async mint(input: CreateRuntimeSession, resume: string | undefined): Promise<RuntimeSession> {
    const session = new ClaudeRuntimeSession({
      env: this.accounts.buildEnv(input.selection.accountId),
      accountId: input.selection.accountId,
      model: input.selection.model,
      systemPrompt: input.instructions,
      cwd: input.cwd,
      bridge: input.tools,
      ...(input.allowedNativeTools ? { allowedTools: input.allowedNativeTools } : {}),
      maxTurns: input.maxTurns,
      bypassPermissions: input.bypassPermissions,
    });
    await session.start({
      appSessionId: input.appSessionId,
      resumeNativeSessionId: resume,
      cwd: input.cwd,
      ask: input.ask,
    });
    return session;
  }
}

// ── native SDK message → RuntimeEvent[] (contract mapping table) ───────────────

/** Exported for the mapping guard test — production callers go through
 *  ClaudeRuntimeSession. */
export function mapSdkMessage(msg: SDKMessage, accountId: string, keys: SdkKeyContext): RuntimeEvent[] {
  const m = msg as Record<string, unknown> & { type: string };
  switch (m.type) {
    case 'assistant':
      return mapAssistant(m, keys);
    case 'user':
      return mapUser(m, keys);
    case 'stream_event':
      return mapStreamEvent(m, keys);
    case 'result':
      return [...mapResultPermissionDenials(m, keys), mapResult(m)];
    case 'tool_progress':
      return observeToolState(keys, {
        nativeId: String(m.tool_use_id ?? ''),
        name: String(m.tool_name ?? ''),
        scope: m.parent_tool_use_id == null ? 'primary' : 'sidechain',
        state: 'running',
      });
    case 'rate_limit_event': {
      const snap = toUsageSnapshot(m.rate_limit_info as Record<string, unknown> | undefined, accountId);
      return snap ? [{ type: 'rate-limit', snapshot: snap }] : [];
    }
    case 'system':
      return mapSystem(m, keys);
    default:
      return []; // tool-use summaries, task_*, and unknowns — dropped by design
  }
}

function mapAssistant(m: Record<string, unknown>, keys: SdkKeyContext): RuntimeEvent[] {
  const out: RuntimeEvent[] = [];
  const envelopeUuid = String(m.uuid ?? '');
  const parent = (m.parent_tool_use_id as string | null) ?? null;
  const message = m.message as { id?: unknown; content?: unknown; error?: unknown } | undefined;
  const nativeMessageId = String(message?.id ?? '') || envelopeUuid;
  const itemId = canonicalItemId(keys, nativeMessageId);
  rememberKey(keys, envelopeUuid, itemId);
  const blocks = Array.isArray(message?.content) ? (message!.content as Array<Record<string, unknown>>) : [];
  for (const block of blocks) {
    switch (block.type) {
      case 'text':
        out.push({ type: 'assistant-block', itemId, scope: parent === null ? 'primary' : 'sidechain', block: { kind: 'text', text: String(block.text ?? '') } });
        break;
      case 'thinking':
        // Retain no private reasoning in the canonical runtime seam.
        break;
      case 'tool_use':
        out.push(...observeToolState(keys, {
          nativeId: String(block.id ?? ''),
          name: String(block.name ?? ''),
          scope: parent === null ? 'primary' : 'sidechain',
          state: 'requested',
        }));
        break;
      default:
        break;
    }
  }
  const supersedes = m.supersedes as string[] | undefined;
  if (Array.isArray(supersedes) && supersedes.length > 0) {
    out.push({ type: 'supersedes', streamIds: translateUuids(supersedes, keys) });
  }
  const err = (m as { error?: { message?: string } }).error;
  if (err && typeof err.message === 'string') {
    out.push({
      type: 'system',
      subtype: 'runtime-assistant-error',
      level: 'error',
      message: 'The runtime reported an assistant response error.',
    });
  }
  return out;
}

function mapUser(m: Record<string, unknown>, keys: SdkKeyContext): RuntimeEvent[] {
  if (m.isReplay === true) return []; // resume echo — not live tool activity
  const parent = (m.parent_tool_use_id as string | null) ?? null;
  const message = m.message as { content?: unknown } | undefined;
  const blocks = Array.isArray(message?.content) ? (message!.content as Array<Record<string, unknown>>) : [];
  const out: RuntimeEvent[] = [];
  for (const block of blocks) {
    if (block.type !== 'tool_result') continue;
    out.push(...observeToolState(keys, {
      nativeId: String(block.tool_use_id ?? ''),
      scope: parent === null ? 'primary' : 'sidechain',
      state: block.is_error === true ? 'failed' : 'succeeded',
      outcome: block.is_error === true ? { reason: 'tool-error' } : null,
    }));
  }
  return out;
}

function mapStreamEvent(m: Record<string, unknown>, keys: SdkKeyContext): RuntimeEvent[] {
  const uuid = String(m.uuid ?? '');
  const parent = (m.parent_tool_use_id as string | null) ?? null;
  const event = m.event as
    | { type?: string; delta?: Record<string, unknown>; message?: { id?: unknown } }
    | undefined;
  if (!event) return [];
  if (event.type === 'message_start') {
    const nativeMessageId = String(event.message?.id ?? '') || uuid;
    keys.streamItemId = canonicalItemId(keys, nativeMessageId);
    rememberKey(keys, uuid, keys.streamItemId);
  }
  const itemId = keys.streamItemId ?? canonicalItemId(keys, uuid);
  let delta: RuntimeDelta | null = null;
  if (event.type === 'message_start') delta = { kind: 'message-start' };
  else if (event.type === 'message_stop') {
    delta = { kind: 'message-end' };
    keys.streamItemId = null;
  } else if (event.type === 'content_block_delta' && event.delta) {
    const d = event.delta;
    if (d.type === 'text_delta') delta = { kind: 'text-delta', text: String(d.text ?? '') };
    else if (d.type === 'thinking_delta') delta = null;
    else if (d.type === 'input_json_delta') delta = null;
  }
  return delta ? [{ type: 'delta', itemId, scope: parent === null ? 'primary' : 'sidechain', delta }] : [];
}

/** `supersedes`/`retracted_message_uuids` reference envelope uuids; frames were
 *  stamped with inner message ids — translate so retraction actually evicts. */
function translateUuids(uuids: unknown[], keys: SdkKeyContext): string[] {
  return uuids.map((u) => canonicalItemId(keys, String(u)));
}

/** Provider-neutral terminal classification for a native `result` message —
 *  the ONLY place an SDK subtype (e.g. 'error_max_turns') is interpreted; it
 *  must never leak past this function. */
function classifyResultOutcome(
  subtype: string,
  terminalReason: unknown,
): 'ok' | 'error' | 'aborted' | 'budget-exhausted' {
  // Installed SDK result subtypes do not contain an abort variant. These two
  // documented terminal_reason values are the positive native evidence.
  if (terminalReason === 'aborted_streaming' || terminalReason === 'aborted_tools') return 'aborted';
  if (subtype === 'success') return 'ok';
  if (subtype === 'error_max_turns' || subtype === 'error_max_budget_usd') return 'budget-exhausted';
  return 'error';
}

function classifyStopReason(
  nativeReason: unknown,
): Extract<RuntimeEvent, { type: 'result' }>['stopReason'] {
  switch (nativeReason) {
    case 'end_turn':
      return 'complete';
    case 'max_tokens':
      return 'max-output';
    case 'stop_sequence':
      return 'stop-sequence';
    case 'tool_use':
      return 'tool-use';
    case null:
    case undefined:
      return null;
    default:
      return 'other';
  }
}

function mapResult(m: Record<string, unknown>): RuntimeEvent {
  // Success needs the provider's exact positive discriminator. Missing,
  // malformed, or newly introduced subtypes fail closed as an error.
  const subtype = typeof m.subtype === 'string' ? m.subtype : '';
  const outcome = classifyResultOutcome(subtype, m.terminal_reason);
  const usage = toRuntimeUsage(m.usage as Record<string, unknown> | undefined, m.modelUsage as Record<string, unknown> | undefined);
  const durationMs = typeof m.duration_ms === 'number' ? m.duration_ms : null;
  const stopReason = classifyStopReason(m.stop_reason);
  const numTurns = typeof m.num_turns === 'number' ? m.num_turns : null;
  if (outcome === 'ok') {
    return {
      type: 'result', ok: true, stopReason, usage, durationMs,
      error: null, outcome, numTurns,
    };
  }
  const error = outcome === 'budget-exhausted'
    ? 'runtime turn budget exhausted'
    : outcome === 'aborted'
      ? 'runtime turn aborted'
      : 'runtime execution failed';
  return {
    type: 'result', ok: false, stopReason, usage, durationMs,
    error, outcome, numTurns,
  };
}

function mapResultPermissionDenials(
  m: Record<string, unknown>,
  keys: SdkKeyContext,
): RuntimeEvent[] {
  const denials = Array.isArray(m.permission_denials)
    ? m.permission_denials as Array<Record<string, unknown>>
    : [];
  return denials.flatMap((denial) => observeToolState(keys, {
    nativeId: String(denial.tool_use_id ?? ''),
    name: String(denial.tool_name ?? ''),
    scope: 'primary',
    state: 'denied',
    approval: { status: 'denied', source: 'runtime', requestId: null },
  }));
}

function mapSystem(m: Record<string, unknown>, keys: SdkKeyContext): RuntimeEvent[] {
  switch (m.subtype) {
    case 'session_state_changed':
      return [{ type: 'session-state', state: (m.state as 'idle' | 'running' | 'requires_action') ?? 'idle', permissionMode: null }];
    case 'compact_boundary': {
      const meta = (m.compact_metadata as Record<string, unknown>) ?? {};
      return [
        { type: 'activity-state', phase: 'compacting' },
        {
          type: 'compaction',
          trigger: meta.trigger === 'manual' ? 'manual' : 'auto',
          preTokens: typeof meta.pre_tokens === 'number' ? meta.pre_tokens : 0,
          postTokens: typeof meta.post_tokens === 'number' ? meta.post_tokens : null,
        },
      ];
    }
    case 'permission_denied':
      return observeToolState(keys, {
        nativeId: String(m.tool_use_id ?? ''),
        name: String(m.tool_name ?? ''),
        scope: m.agent_id ? 'sidechain' : 'primary',
        state: 'denied',
        approval: { status: 'denied', source: 'runtime', requestId: null },
      });
    case 'api_retry': {
      const attempt = typeof m.attempt === 'number' ? m.attempt : null;
      const max = typeof m.max_retries === 'number' ? m.max_retries : null;
      return [
        { type: 'activity-state', phase: 'retrying' },
        { type: 'api-retry', attempt, maxRetries: max },
      ];
    }
    case 'status':
      if (m.status === 'requesting') return [{ type: 'activity-state', phase: 'requesting-runtime' }];
      if (m.status === 'compacting') return [{ type: 'activity-state', phase: 'compacting' }];
      return [];
    case 'informational':
      return [{
        type: 'system', subtype: 'runtime-information', level: mapInfoLevel(m.level),
        message: 'The runtime reported an informational notice.',
      }];
    case 'notification':
      return [{
        type: 'system', subtype: 'runtime-notification', level: 'notice',
        message: 'The runtime reported a notification.',
      }];
    case 'local_command_output':
      return [];
    case 'model_refusal_fallback':
    case 'model_refusal_no_fallback': {
      const uuids = m.retracted_message_uuids;
      const out: RuntimeEvent[] = [{
        type: 'system', subtype: 'runtime-model-refusal', level: 'warning',
        message: 'The runtime refused an assistant response.',
      }];
      if (Array.isArray(uuids) && uuids.length > 0) out.push({ type: 'supersedes', streamIds: translateUuids(uuids, keys) });
      return out;
    }
    default:
      return []; // status, init (handled), and unknown system subtypes — dropped
  }
}

function mapInfoLevel(level: unknown): 'info' | 'notice' | 'warning' | 'error' {
  if (level === 'warning') return 'warning';
  if (level === 'notice' || level === 'suggestion') return 'notice';
  return 'info';
}

function toRuntimeUsage(
  usage: Record<string, unknown> | undefined,
  modelUsage: Record<string, unknown> | undefined,
): RuntimeUsage | null {
  if (!usage) return null;
  const model = modelUsage ? (Object.keys(modelUsage)[0] ?? null) : null;
  return {
    inputTokens: numberOr(usage.input_tokens, 0),
    outputTokens: numberOr(usage.output_tokens, 0),
    cacheCreationTokens: numberOr(usage.cache_creation_input_tokens, 0),
    cacheReadTokens: numberOr(usage.cache_read_input_tokens, 0),
    model,
  };
}

/** Build a partial UsageSnapshot from one `rate_limit_event`. Only the window the
 *  event carries is set; the usage cache merges windows per account over time. */
function toUsageSnapshot(info: Record<string, unknown> | undefined, accountId: string): UsageSnapshot | null {
  if (!info) return null;
  const status = info.status === 'allowed_warning' || info.status === 'rejected' ? info.status : 'allowed';
  // Contract scale is 0–1. The SDK's rate_limit_info scale is unpinned; a value
  // past 1.5 can only be a 0–100 percentage (150% quota is unreachable), so
  // normalize rather than clamp the meter to full.
  const raw = numberOr(info.utilization, 0);
  const utilization = raw > 1.5 ? raw / 100 : raw;
  // SDK sends epoch SECONDS (observed live 2026-07-10); contract is epoch ms.
  const rawReset = typeof info.resetsAt === 'number' ? info.resetsAt : null;
  const resetsAt = rawReset !== null && rawReset < 1e12 ? rawReset * 1000 : rawReset;
  const windowType = String(info.rateLimitType ?? '');
  const win = { utilization, resetsAt };
  const isFiveHour = windowType === 'five_hour';
  return {
    accountId,
    fiveHour: isFiveHour ? win : null,
    sevenDay: windowType.startsWith('seven_day') ? win : null,
    fable: null,
    status,
    model: null,
    updatedAt: Date.now(),
  };
}

function numberOr(v: unknown, fallback: number): number {
  return typeof v === 'number' && Number.isFinite(v) ? v : fallback;
}
