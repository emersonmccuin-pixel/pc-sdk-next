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

import type { UsageSnapshot } from '@pc/contracts';
import type { BridgeBuild } from '../mcp/bridge.ts';

/** Per-turn token telemetry (native result usage). Maps to the chat `usage`
 *  event; distinct from the durable per-account `UsageSnapshot`. */
export interface RuntimeUsage {
  inputTokens: number;
  outputTokens: number;
  cacheCreationTokens: number;
  cacheReadTokens: number;
  model: string | null;
}

/** One block of an assistant message. */
export type AssistantBlock =
  | { kind: 'text'; text: string }
  | { kind: 'thinking'; text: string }
  | { kind: 'tool_use'; toolUseId: string; name: string; input: unknown };

/** Streaming-delta payload. */
export type RuntimeDelta =
  | { kind: 'message-start' }
  | { kind: 'text-delta'; text: string }
  | { kind: 'thinking-delta'; text: string }
  | { kind: 'tool-input-delta'; toolUseId?: string; partialJson: string }
  | { kind: 'message-end' };

/** The typed events a runtime session yields for one turn. `sdkUuid` is the
 *  canonical per-message frame key (wire-frozen in docs/event-contract.md —
 *  the name survives from the Claude-first wire; adapters for other runtimes
 *  mint their own stable per-message keys into it). `parentToolUseId != null`
 *  marks a subagent (sidechain) event — the turn-runner does not forward those
 *  to the main chat. */
export type RuntimeEvent =
  // Native session opened/attached — capture `nativeSessionId` for resume.
  | { type: 'init'; sdkSessionId: string; model: string | null; permissionMode: string | null }
  // Assistant block (text / thinking / tool_use).
  | { type: 'assistant-block'; sdkUuid: string; parentToolUseId: string | null; block: AssistantBlock }
  // Tool result (NOT a chat user bubble).
  | {
      type: 'tool-result';
      sdkUuid: string;
      parentToolUseId: string | null;
      toolUseId: string;
      result: unknown;
      isError: boolean;
    }
  // Streaming delta (main thread only).
  | { type: 'delta'; sdkUuid: string; parentToolUseId: string | null; delta: RuntimeDelta }
  // Turn terminal — success (ok) or an error subtype. Always ends the turn.
  | {
      type: 'result';
      ok: boolean;
      subtype: string;
      stopReason: string | null;
      usage: RuntimeUsage | null;
      durationMs: number | null;
      /** Present when `ok === false`. */
      error: string | null;
    }
  // Session-state transitions.
  | { type: 'session-state'; state: 'idle' | 'running' | 'requires_action'; permissionMode: string | null }
  // Context compaction.
  | { type: 'compaction'; trigger: 'manual' | 'auto'; preTokens: number; postTokens: number | null }
  // Permission denied for a tool call.
  | { type: 'permission-denied'; toolUseId: string; toolName: string; reason: string }
  // Provider retry → system (level warning).
  | { type: 'api-retry'; message: string; attempt: number | null }
  // Durable per-account usage snapshot.
  | { type: 'rate-limit'; snapshot: UsageSnapshot }
  // Generic runtime notice surfaced as a system chat event.
  | {
      type: 'system';
      subtype: string;
      level: 'info' | 'notice' | 'warning' | 'error';
      message: string;
      raw?: unknown;
    }
  // Retract already-delivered events by frame key (model-refusal fallback).
  | { type: 'supersedes'; uuids: string[] };

/** The permission seam. A session calls this to block on an app answer; the
 *  app resolves it (or a watchdog denies it). */
export interface AskRequest {
  toolName: string;
  toolUseId: string;
  toolInput: unknown;
  sessionId: string | null;
}
export interface AskDecision {
  behavior: 'allow' | 'deny';
  message?: string;
  updatedInput?: Record<string, unknown>;
  rawAnswer?: string; // literal browser reply, for answer-style tools
}
export type AskHandler = (req: AskRequest) => Promise<AskDecision>;

/** Explicit execution selection — stamped on every app session / agent run.
 *  A running session never silently changes runtime, account, or native
 *  session identity. */
export interface RuntimeSelection {
  /** Adapter id, e.g. 'claude-agent-sdk'. */
  runtimeId: string;
  /** App account id (credential home resolved by the adapter). */
  accountId: string;
  /** Runtime model identifier. */
  model: string;
  effort?: string;
}

/** One live runtime session (adapter-owned native thread/session). Returned
 *  already started — there is no separate start step. */
export interface RuntimeSession {
  /** Send one user turn; yields RuntimeEvents until the turn's `result`. The
   *  iterable completes when the turn ends. */
  sendTurn(text: string): AsyncIterable<RuntimeEvent>;
  /** Abort the in-flight turn. Positive receipt: the current `sendTurn` stream
   *  ends (with a `result` `ok:false` or by throwing an abort). */
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
  /** Adapter-native session/thread id captured from `init`. */
  nativeSessionId: string;
}

/** An agent runtime (Claude Agent SDK, Codex, a test fake). One instance per
 *  runtime, registered at the composition root. */
export interface AgentRuntimeAdapter {
  readonly id: string;
  createSession(input: CreateRuntimeSession): Promise<RuntimeSession>;
  resumeSession(input: ResumeRuntimeSession): Promise<RuntimeSession>;
}

/** Adapter lookup — the ONLY place a runtimeId resolves to a concrete
 *  adapter. Core services receive sessions, never adapters. */
export class RuntimeRegistry {
  private readonly adapters = new Map<string, AgentRuntimeAdapter>();

  register(adapter: AgentRuntimeAdapter): void {
    this.adapters.set(adapter.id, adapter);
  }

  get(runtimeId: string): AgentRuntimeAdapter {
    const a = this.adapters.get(runtimeId);
    if (!a) throw new Error(`unknown runtime: ${runtimeId}`);
    return a;
  }

  has(runtimeId: string): boolean {
    return this.adapters.has(runtimeId);
  }
}

/** How the chat engine mints its per-session runtime session. The composition
 *  root supplies the closure that resolves selection + instructions + tools
 *  and calls the registered adapter (create or resume). */
export interface MintRuntimeSession {
  projectId: string;
  appSessionId: string;
  /** Set when re-attaching to an existing native session (resume). */
  resumeNativeSessionId?: string;
  cwd?: string;
  ask?: AskHandler;
}
export type RuntimeSessionFactory = (
  ctx: MintRuntimeSession,
) => RuntimeSession | Promise<RuntimeSession>;
