// RunnerBackend — the single seam the whole chat engine hangs on.
//
// The turn-runner drives ONE of these per active session. `SdkBackend` (sibling)
// implements it thinly over the Claude Agent SDK's streaming-input `query()`
// loop; `FakeBackend` (this package, tests) scripts deterministic turns. Nothing
// outside a backend implementation imports `@anthropic-ai/claude-agent-sdk`.
//
// The message union below is the RunnerMessage variants the SDK→contract mapping
// table (docs/event-contract.md) consumes — a backend maps each SDK message to
// one of these; the turn-runner maps these to ChatEvents. Unknown SDK variants
// are dropped inside the backend (never surfaced as an unknown RunnerMessage).

import type { UsageSnapshot } from '@pc/contracts';

/** Per-turn token telemetry (SDK `result.usage`). Maps to the chat `usage`
 *  event; distinct from the durable per-account `UsageSnapshot`. */
export interface RunnerUsage {
  inputTokens: number;
  outputTokens: number;
  cacheCreationTokens: number;
  cacheReadTokens: number;
  model: string | null;
}

/** One block of an SDK `assistant` message. */
export type AssistantBlock =
  | { kind: 'text'; text: string }
  | { kind: 'thinking'; text: string }
  | { kind: 'tool_use'; toolUseId: string; name: string; input: unknown };

/** Streaming-delta payload (SDK `stream_event`, `includePartialMessages`). */
export type RunnerDelta =
  | { kind: 'message-start' }
  | { kind: 'text-delta'; text: string }
  | { kind: 'thinking-delta'; text: string }
  | { kind: 'tool-input-delta'; toolUseId?: string; partialJson: string }
  | { kind: 'message-end' };

/** The typed messages a backend yields for one turn. `parentToolUseId != null`
 *  marks a subagent (sidechain) message — the turn-runner does not forward those
 *  to the main orchestrator chat. */
export type RunnerMessage =
  // SDK `system/init` — capture `sdkSessionId` for `resume`.
  | { type: 'init'; sdkSessionId: string; model: string | null; permissionMode: string | null }
  // SDK `assistant` block (text / thinking / tool_use).
  | { type: 'assistant-block'; sdkUuid: string; parentToolUseId: string | null; block: AssistantBlock }
  // SDK `user` tool_result block (NOT a chat user bubble).
  | {
      type: 'tool-result';
      sdkUuid: string;
      parentToolUseId: string | null;
      toolUseId: string;
      result: unknown;
      isError: boolean;
    }
  // SDK `stream_event` → chat-delta (main thread only).
  | { type: 'delta'; sdkUuid: string; parentToolUseId: string | null; delta: RunnerDelta }
  // SDK `result` — success (ok) or an error subtype. Always ends the turn.
  | {
      type: 'result';
      ok: boolean;
      subtype: string;
      stopReason: string | null;
      usage: RunnerUsage | null;
      durationMs: number | null;
      /** Present when `ok === false`. */
      error: string | null;
    }
  // SDK `system/status` | `session_state_changed`.
  | { type: 'session-state'; state: 'idle' | 'running' | 'requires_action'; permissionMode: string | null }
  // SDK `system/compact_boundary`.
  | { type: 'compaction'; trigger: 'manual' | 'auto'; preTokens: number; postTokens: number | null }
  // SDK `system/permission_denied`.
  | { type: 'permission-denied'; toolUseId: string; toolName: string; reason: string }
  // SDK `system/api_retry` → system (level warning).
  | { type: 'api-retry'; message: string; attempt: number | null }
  // SDK `rate_limit_event` → durable per-account usage snapshot.
  | { type: 'rate-limit'; snapshot: UsageSnapshot }
  // Generic SDK `system/*` we surface as a system chat event.
  | {
      type: 'system';
      subtype: string;
      level: 'info' | 'notice' | 'warning' | 'error';
      message: string;
      raw?: unknown;
    }
  // SDK `assistant.supersedes` → retract already-delivered events by sdkUuid.
  | { type: 'supersedes'; uuids: string[] };

/** The `canUseTool` permission seam. A backend calls this to block on a browser
 *  answer; the app resolves it (or a watchdog denies it). */
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
}
export type AskHandler = (req: AskRequest) => Promise<AskDecision>;

export interface StartSessionOptions {
  /** App session id (server-owned row). For logging + correlation. */
  appSessionId: string;
  /** Resume an existing SDK session (after restart / re-attach). Omit for new. */
  resumeSdkSessionId?: string;
  cwd?: string;
  /** Permission callback; omit to auto-allow (dontAsk). */
  ask?: AskHandler;
}

/** How the app mints a backend for a session. The sibling's `SdkBackend` factory
 *  plugs in here; tests pass a `FakeBackend` factory. */
export interface BackendContext {
  projectId: string;
  appSessionId: string;
  /** Set when re-attaching to an existing SDK session (resume). */
  resumeSdkSessionId?: string;
}
export type BackendFactory = (ctx: BackendContext) => RunnerBackend;

/** The seam. One instance per active session. */
export interface RunnerBackend {
  /** Open (or resume) the SDK session loop. Called once before the first turn. */
  startSession(opts: StartSessionOptions): Promise<void>;
  /** Send one user turn; yields RunnerMessages until the turn's `result`. The
   *  iterable completes when the turn ends. */
  sendTurn(text: string): AsyncIterable<RunnerMessage>;
  /** Abort the in-flight turn. Positive receipt: the current `sendTurn` stream
   *  ends (with a `result` `ok:false` or by throwing an abort). */
  interrupt(): Promise<void>;
  /** Tear the session down (ends the query loop). Idempotent. */
  dispose(): Promise<void>;
}
