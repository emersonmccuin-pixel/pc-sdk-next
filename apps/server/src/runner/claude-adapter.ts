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
// yields `stream_event` deltas → chat-delta frames. `resume` re-attaches after a
// restart. `canUseTool` bridges to the app's ask registry. Native SDK messages
// are mapped to canonical `RuntimeEvent`s per the contract table; unknown
// variants are dropped here (never surfaced as an unknown RuntimeEvent).

import {
  createSdkMcpServer,
  query,
  tool,
  type Options,
  type Query,
  type SDKMessage,
  type SDKUserMessage,
} from '@anthropic-ai/claude-agent-sdk';
import type { UsageSnapshot } from '@pc/contracts';
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
  resumeSdkSessionId?: string;
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
  streamMsgId: string | null;
  uuidToKey: Map<string, string>;
}

export function createSdkKeyContext(): SdkKeyContext {
  return { streamMsgId: null, uuidToKey: new Map() };
}

/** Bounded so a long-lived session can't grow the map without limit. */
function rememberKey(keys: SdkKeyContext, envelopeUuid: string, key: string): void {
  keys.uuidToKey.set(envelopeUuid, key);
  if (keys.uuidToKey.size > 500) {
    const oldest = keys.uuidToKey.keys().next().value;
    if (oldest !== undefined) keys.uuidToKey.delete(oldest);
  }
}

export class ClaudeRuntimeSession implements RuntimeSession {
  private readonly config: ClaudeSessionConfig;
  private readonly keys: SdkKeyContext = createSdkKeyContext();
  private started = false;
  private disposed = false;
  private q: Query | null = null;
  private promptQueue: AsyncQueue<SDKUserMessage> | null = null;
  private currentTurn: AsyncQueue<RuntimeEvent> | null = null;
  private pendingInit: RuntimeEvent | null = null;
  private sdkSessionId: string | null = null;

  constructor(config: ClaudeSessionConfig) {
    this.config = config;
  }

  /** Open (or resume) the SDK session loop. The adapter calls this exactly
   *  once before handing the session out. */
  async start(opts: StartOptions): Promise<void> {
    if (this.started) return;
    this.started = true;

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

    const resume = opts.resumeSdkSessionId && opts.resumeSdkSessionId.length > 0 ? opts.resumeSdkSessionId : undefined;

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
    try {
      await this.q?.interrupt();
    } catch {
      /* positive receipt: the turn stream still terminates via a result/abort */
    }
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
      this.endCurrentTurnIfOpen('sdk query loop ended');
    }
  }

  private route(msg: SDKMessage): void {
    const anyMsg = msg as { type: string; subtype?: string; session_id?: string; model?: string; permissionMode?: string };
    if (anyMsg.type === 'system' && anyMsg.subtype === 'init') {
      this.sdkSessionId = anyMsg.session_id ?? null;
      const rm: RuntimeEvent = {
        type: 'init',
        sdkSessionId: anyMsg.session_id ?? '',
        model: anyMsg.model ?? null,
        permissionMode: anyMsg.permissionMode ?? null,
      };
      if (this.currentTurn) this.currentTurn.push(rm);
      else this.pendingInit = rm;
      return;
    }

    const mapped = mapSdkMessage(msg, this.config.accountId, this.keys);
    if (mapped.length === 0) return;
    const turn = this.currentTurn;
    if (!turn) return; // out-of-turn telemetry with nowhere to go — dropped by design
    for (const rm of mapped) {
      turn.push(rm);
      if (rm.type === 'result') {
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
    const message = err instanceof Error ? err.message : String(err);
    const abort = /abort/i.test(message);
    turn.push({
      type: 'result',
      ok: false,
      subtype: abort ? 'abort' : 'error',
      stopReason: null,
      usage: null,
      durationMs: null,
      error: message,
    });
    turn.end();
  }

  private endCurrentTurnIfOpen(reason: string): void {
    const turn = this.currentTurn;
    if (!turn) return;
    this.currentTurn = null;
    turn.push({
      type: 'result',
      ok: false,
      subtype: 'error',
      stopReason: null,
      usage: null,
      durationMs: null,
      error: reason,
    });
    turn.end();
  }

  private makeCanUseTool(ask: AskHandler) {
    return async (
      toolName: string,
      input: Record<string, unknown>,
      opts: { toolUseID: string },
    ): Promise<{ behavior: 'allow'; updatedInput?: Record<string, unknown> } | { behavior: 'deny'; message: string }> => {
      const decision: AskDecision = await ask({
        toolName,
        toolUseId: opts.toolUseID,
        toolInput: input,
        sessionId: this.sdkSessionId,
      });
      if (decision.behavior === 'allow') {
        // CLI-side zod validation rejects an allow without updatedInput — always echo input back.
        return { behavior: 'allow', updatedInput: decision.updatedInput ?? input };
      }
      return { behavior: 'deny', message: decision.message ?? 'denied' };
    };
  }
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
      resumeSdkSessionId: resume,
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
      return mapUser(m);
    case 'stream_event':
      return mapStreamEvent(m, keys);
    case 'result':
      return [mapResult(m)];
    case 'rate_limit_event': {
      const snap = toUsageSnapshot(m.rate_limit_info as Record<string, unknown> | undefined, accountId);
      return snap ? [{ type: 'rate-limit', snapshot: snap }] : [];
    }
    case 'system':
      return mapSystem(m, keys);
    default:
      return []; // tool_progress, task_*, and unknowns — dropped by design
  }
}

function mapAssistant(m: Record<string, unknown>, keys: SdkKeyContext): RuntimeEvent[] {
  const out: RuntimeEvent[] = [];
  const envelopeUuid = String(m.uuid ?? '');
  const parent = (m.parent_tool_use_id as string | null) ?? null;
  const message = m.message as { id?: unknown; content?: unknown; error?: unknown } | undefined;
  // Frame key = inner message id (matches this message's stream deltas);
  // envelope uuid only as a fallback for id-less messages.
  const uuid = String(message?.id ?? '') || envelopeUuid;
  if (envelopeUuid) rememberKey(keys, envelopeUuid, uuid);
  const blocks = Array.isArray(message?.content) ? (message!.content as Array<Record<string, unknown>>) : [];
  for (const block of blocks) {
    switch (block.type) {
      case 'text':
        out.push({ type: 'assistant-block', sdkUuid: uuid, parentToolUseId: parent, block: { kind: 'text', text: String(block.text ?? '') } });
        break;
      case 'thinking':
        out.push({ type: 'assistant-block', sdkUuid: uuid, parentToolUseId: parent, block: { kind: 'thinking', text: String(block.thinking ?? '') } });
        break;
      case 'tool_use':
        out.push({
          type: 'assistant-block',
          sdkUuid: uuid,
          parentToolUseId: parent,
          block: { kind: 'tool_use', toolUseId: String(block.id ?? ''), name: String(block.name ?? ''), input: block.input ?? {} },
        });
        break;
      default:
        break;
    }
  }
  const supersedes = m.supersedes as string[] | undefined;
  if (Array.isArray(supersedes) && supersedes.length > 0) {
    out.push({ type: 'supersedes', uuids: translateUuids(supersedes, keys) });
  }
  const err = (m as { error?: { message?: string } }).error;
  if (err && typeof err.message === 'string') {
    out.push({ type: 'system', subtype: 'assistant_error', level: 'error', message: err.message });
  }
  return out;
}

function mapUser(m: Record<string, unknown>): RuntimeEvent[] {
  if (m.isReplay === true) return []; // resume echo — not live tool activity
  const uuid = String(m.uuid ?? '');
  const parent = (m.parent_tool_use_id as string | null) ?? null;
  const message = m.message as { content?: unknown } | undefined;
  const blocks = Array.isArray(message?.content) ? (message!.content as Array<Record<string, unknown>>) : [];
  const out: RuntimeEvent[] = [];
  for (const block of blocks) {
    if (block.type !== 'tool_result') continue;
    out.push({
      type: 'tool-result',
      sdkUuid: uuid,
      parentToolUseId: parent,
      toolUseId: String(block.tool_use_id ?? ''),
      result: block.content ?? null,
      isError: block.is_error === true,
    });
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
  if (event.type === 'message_start') keys.streamMsgId = String(event.message?.id ?? '') || uuid;
  // All of one message's deltas share the inner message id opened at
  // message_start — envelope uuids are per-emission and would split the buffer.
  const key = keys.streamMsgId ?? uuid;
  let delta: RuntimeDelta | null = null;
  if (event.type === 'message_start') delta = { kind: 'message-start' };
  else if (event.type === 'message_stop') {
    delta = { kind: 'message-end' };
    keys.streamMsgId = null;
  } else if (event.type === 'content_block_delta' && event.delta) {
    const d = event.delta;
    if (d.type === 'text_delta') delta = { kind: 'text-delta', text: String(d.text ?? '') };
    else if (d.type === 'thinking_delta') delta = { kind: 'thinking-delta', text: String(d.thinking ?? '') };
    else if (d.type === 'input_json_delta') delta = { kind: 'tool-input-delta', partialJson: String(d.partial_json ?? '') };
  }
  return delta ? [{ type: 'delta', sdkUuid: key, parentToolUseId: parent, delta }] : [];
}

/** `supersedes`/`retracted_message_uuids` reference envelope uuids; frames were
 *  stamped with inner message ids — translate so retraction actually evicts. */
function translateUuids(uuids: unknown[], keys: SdkKeyContext): string[] {
  return uuids.map((u) => keys.uuidToKey.get(String(u)) ?? String(u));
}

function mapResult(m: Record<string, unknown>): RuntimeEvent {
  const subtype = String(m.subtype ?? 'success');
  const ok = subtype === 'success';
  const usage = toRuntimeUsage(m.usage as Record<string, unknown> | undefined, m.modelUsage as Record<string, unknown> | undefined);
  const durationMs = typeof m.duration_ms === 'number' ? m.duration_ms : null;
  const stopReason = typeof m.stop_reason === 'string' ? m.stop_reason : null;
  let error: string | null = null;
  if (!ok) {
    const errors = m.errors;
    error = Array.isArray(errors) && errors.length > 0 ? errors.map(String).join('; ') : subtype;
  }
  return { type: 'result', ok, subtype, stopReason, usage, durationMs, error };
}

function mapSystem(m: Record<string, unknown>, keys: SdkKeyContext): RuntimeEvent[] {
  switch (m.subtype) {
    case 'session_state_changed':
      return [{ type: 'session-state', state: (m.state as 'idle' | 'running' | 'requires_action') ?? 'idle', permissionMode: null }];
    case 'compact_boundary': {
      const meta = (m.compact_metadata as Record<string, unknown>) ?? {};
      return [
        {
          type: 'compaction',
          trigger: meta.trigger === 'manual' ? 'manual' : 'auto',
          preTokens: typeof meta.pre_tokens === 'number' ? meta.pre_tokens : 0,
          postTokens: typeof meta.post_tokens === 'number' ? meta.post_tokens : null,
        },
      ];
    }
    case 'permission_denied':
      return [
        {
          type: 'permission-denied',
          toolUseId: String(m.tool_use_id ?? ''),
          toolName: String(m.tool_name ?? ''),
          reason: String(m.decision_reason ?? m.message ?? 'denied'),
        },
      ];
    case 'api_retry': {
      const attempt = typeof m.attempt === 'number' ? m.attempt : null;
      const max = typeof m.max_retries === 'number' ? m.max_retries : null;
      const errText = (m.error as { message?: string } | undefined)?.message ?? '';
      return [{ type: 'api-retry', message: `API retry ${attempt ?? '?'}/${max ?? '?'}${errText ? `: ${errText}` : ''}`, attempt }];
    }
    case 'informational':
      return [{ type: 'system', subtype: 'informational', level: mapInfoLevel(m.level), message: String(m.content ?? '') }];
    case 'notification':
      return [{ type: 'system', subtype: 'notification', level: 'notice', message: String(m.text ?? '') }];
    case 'local_command_output':
      return [{ type: 'system', subtype: 'local_command_output', level: 'info', message: String(m.content ?? '') }];
    case 'model_refusal_fallback':
    case 'model_refusal_no_fallback': {
      const uuids = m.retracted_message_uuids;
      const out: RuntimeEvent[] = [{ type: 'system', subtype: String(m.subtype), level: 'warning', message: String(m.content ?? 'model refused the request') }];
      if (Array.isArray(uuids) && uuids.length > 0) out.push({ type: 'supersedes', uuids: translateUuids(uuids, keys) });
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
