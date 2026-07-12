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

import type {
  ActivityPhase,
  ToolStateEvent,
  TurnStopReason,
  UsageSnapshot,
} from '@pc/contracts';
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
  // Native session opened/attached — capture `nativeSessionId` for resume.
  | { type: 'init'; nativeSessionId: string; model: string | null; permissionMode: string | null }
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
  // Context compaction.
  | { type: 'compaction'; trigger: 'manual' | 'auto'; preTokens: number; postTokens: number | null }
  // Provider retry normalized to numeric facts; native error prose is absent.
  | { type: 'api-retry'; attempt: number | null; maxRetries: number | null }
  // Durable per-account usage snapshot.
  | { type: 'rate-limit'; snapshot: UsageSnapshot }
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
