// Turn-runner — maps a runtime session's RuntimeEvent stream to ChatEvents per
// the runtime→contract mapping table (docs/event-contract.md).
//
// Invariants this owns:
//  - Rule 3: every turn terminates in EXACTLY ONE `turn-end` or `turn-failed`.
//    A result maps to one; a stream that ends without a result, or throws,
//    still emits a terminal (internal/abort). Post-terminal messages are dropped.
//  - Rule 5: an unknown message variant is dropped + logged; the loop continues.
//  - Runtime events marked as sidechain are not forwarded to chat.
//  - `supersedes` → `retract` (model-refusal fallback).
//
// It does NOT persist directly. `emitChat` and `emitDelta` both enter the
// canonical atomic event/outbox door; the conversation relay publishes later.

import type { ChatDeltaEvent, ChatEvent, UsageSnapshot } from '@pc/contracts';
import type { RuntimeEvent } from '../runner/runtime.ts';

export type TurnTerminal = 'turn-end' | 'turn-failed';

/** Provider-neutral terminal classification, carried from the runtime's
 *  `result` event through to the caller (dispatch service distinguishes a
 *  genuine crash from turn-budget exhaustion). */
export type TurnOutcome = 'ok' | 'error' | 'aborted' | 'budget-exhausted';

export interface TurnResult {
  terminal: TurnTerminal;
  outcome: TurnOutcome;
  numTurns: number | null;
}

export interface TurnRunnerDeps {
  /** Persist one stable canonical event and schedule its outbox drain. */
  emitChat: (event: ChatEvent, identity?: { itemId?: string; streamId?: string }) => void;
  /** Persist one visible streaming delta with deterministic per-item order. */
  emitDelta: (itemId: string, deltaIndex: number, event: ChatDeltaEvent) => void;
  /** Adapter-native session id captured from `init` (persisted for resume). */
  onNativeSessionId?: (id: string, model: string | null) => void;
  /** Durable per-account usage snapshot (`rate_limit_event`). */
  onRateLimit?: (snapshot: UsageSnapshot) => void;
  /** Dropped/unknown message log (rule 5). */
  onDropped?: (reason: string, message: unknown) => void;
}

/** Drive one turn to completion. Returns the single terminal outcome emitted. */
export async function runTurn(
  messages: AsyncIterable<RuntimeEvent>,
  deps: TurnRunnerDeps,
): Promise<TurnResult> {
  let terminated = false;
  let sawToolCall = false;
  let lastAssistantText = '';
  const nextDeltaIndex = new Map<string, number>();
  // Overwritten the moment a real terminal is emitted; the post-terminal-throw
  // branch below relies on this holding the actual result, not a placeholder.
  let terminalResult: TurnResult = { terminal: 'turn-failed', outcome: 'error', numTurns: null };
  const drop = (reason: string, msg: unknown): void => deps.onDropped?.(reason, msg);

  const emitUsage = (usage: NonNullable<RuntimeEvent & { type: 'result' }>['usage']): void => {
    if (!usage) return;
    deps.emitChat({
      kind: 'usage',
      inputTokens: usage.inputTokens,
      outputTokens: usage.outputTokens,
      cacheCreationTokens: usage.cacheCreationTokens,
      cacheReadTokens: usage.cacheReadTokens,
      model: usage.model,
    });
  };

  try {
    for await (const msg of messages) {
      if (terminated) {
        drop('post-terminal message', msg);
        continue;
      }
      switch (msg.type) {
        case 'init':
          deps.onNativeSessionId?.(msg.nativeSessionId, msg.model);
          break;

        case 'assistant-block': {
          if (msg.scope === 'sidechain') {
            drop('subagent assistant-block', msg);
            break;
          }
          const b = msg.block;
          if (b.kind === 'text') {
            lastAssistantText = b.text;
            deps.emitChat(
              { kind: 'assistant-text', text: b.text, midLoop: sawToolCall },
              { itemId: msg.itemId, streamId: msg.itemId },
            );
          } else {
            sawToolCall = true;
            deps.emitChat(
              { kind: 'tool-call', toolUseId: b.toolUseId, name: b.name, input: b.input },
              { itemId: msg.itemId, streamId: msg.itemId },
            );
          }
          break;
        }

        case 'tool-result':
          if (msg.scope === 'sidechain') {
            drop('subagent tool-result', msg);
            break;
          }
          deps.emitChat(
            { kind: 'tool-result', toolUseId: msg.toolUseId, result: msg.result, isError: msg.isError },
            { itemId: msg.itemId, streamId: msg.itemId },
          );
          break;

        case 'delta':
          if (msg.scope === 'sidechain') {
            drop('subagent delta', msg);
            break;
          }
          const deltaIndex = nextDeltaIndex.get(msg.itemId) ?? 0;
          nextDeltaIndex.set(msg.itemId, deltaIndex + 1);
          deps.emitDelta(msg.itemId, deltaIndex, msg.delta);
          break;

        case 'result': {
          emitUsage(msg.usage);
          deps.emitChat({ kind: 'turn-duration', durationMs: msg.durationMs });
          if (msg.ok) {
            deps.emitChat({ kind: 'turn-end', text: lastAssistantText, stopReason: msg.stopReason });
          } else {
            deps.emitChat({
              kind: 'turn-failed',
              error: msg.error ?? (
                msg.outcome === 'budget-exhausted'
                  ? 'runtime turn budget exhausted'
                  : msg.outcome === 'aborted'
                    ? 'runtime turn aborted'
                    : 'runtime turn failed'
              ),
              source: msg.outcome === 'aborted' ? 'abort' : 'api',
            });
          }
          terminated = true;
          terminalResult = { terminal: msg.ok ? 'turn-end' : 'turn-failed', outcome: msg.outcome, numTurns: msg.numTurns };
          return terminalResult;
        }

        case 'session-state':
          deps.emitChat({ kind: 'session-state', state: msg.state, permissionMode: msg.permissionMode });
          break;

        case 'compaction':
          deps.emitChat({
            kind: 'compaction',
            trigger: msg.trigger,
            preTokens: msg.preTokens,
            postTokens: msg.postTokens,
          });
          break;

        case 'permission-denied':
          deps.emitChat({ kind: 'tool-denied', toolUseId: msg.toolUseId, name: msg.toolName, reason: msg.reason });
          break;

        case 'api-retry':
          deps.emitChat({
            kind: 'system',
            subtype: 'api_retry',
            level: 'warning',
            message: msg.message,
            raw: msg.attempt !== null ? { attempt: msg.attempt } : undefined,
          });
          break;

        case 'rate-limit':
          deps.onRateLimit?.(msg.snapshot);
          break;

        case 'system':
          deps.emitChat({ kind: 'system', subtype: msg.subtype, level: msg.level, message: msg.message, raw: msg.raw });
          break;

        case 'supersedes':
          deps.emitChat({ kind: 'retract', streamIds: msg.streamIds });
          break;

        default:
          drop('unknown runner message', msg);
      }
    }
  } catch (err) {
    if (!terminated) {
      const message = err instanceof Error ? err.message : String(err);
      const abort = /abort/i.test(message);
      deps.emitChat({
        kind: 'turn-failed',
        error: message,
        source: abort ? 'abort' : 'internal',
      });
      // A genuine stream break is a real failure, never turn-budget exhaustion
      // (that classification only ever comes from a native `result` message).
      return { terminal: 'turn-failed', outcome: abort ? 'aborted' : 'error', numTurns: null };
    }
    // Post-terminal throw (backend teardown noise) — the turn already ended;
    // return the terminal it actually ended with.
    drop('post-terminal error', err);
    return terminalResult;
  }

  // Stream ended with no `result` — positive receipt, never silence (rule 3).
  if (!terminated) {
    deps.emitChat({ kind: 'turn-failed', error: 'stream ended without result', source: 'internal' });
    return { terminal: 'turn-failed', outcome: 'error', numTurns: null };
  }
  return terminalResult;
}
