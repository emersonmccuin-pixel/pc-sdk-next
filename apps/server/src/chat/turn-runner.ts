// Turn-runner — maps a backend's RunnerMessage stream to ChatEvents per the
// SDK→contract mapping table (docs/event-contract.md).
//
// Invariants this owns:
//  - Rule 3: every turn terminates in EXACTLY ONE `turn-end` or `turn-failed`.
//    A result maps to one; a stream that ends without a result, or throws,
//    still emits a terminal (internal/abort). Post-terminal messages are dropped.
//  - Rule 5: an unknown message variant is dropped + logged; the loop continues.
//  - Subagent messages (`parentToolUseId != null`) are not forwarded to chat.
//  - `supersedes` → `retract` (model-refusal fallback).
//
// It does NOT persist — `emitChat` is the persist-then-broadcast door (rule 1
// lives there). Deltas ride `emitDelta` (broadcast-only, never persisted).

import type { ChatDeltaEvent, ChatEvent, UsageSnapshot } from '@pc/contracts';
import type { RunnerMessage } from '../runner/backend.ts';

export type TurnTerminal = 'turn-end' | 'turn-failed';

export interface TurnRunnerDeps {
  /** Persist + broadcast one chat event. */
  emitChat: (event: ChatEvent, opts?: { sdkUuid?: string }) => void;
  /** Broadcast-only streaming delta. */
  emitDelta: (sdkUuid: string, event: ChatDeltaEvent) => void;
  /** SDK session id captured from `init` (persisted for `resume`). */
  onSdkSessionId?: (id: string, model: string | null) => void;
  /** Durable per-account usage snapshot (`rate_limit_event`). */
  onRateLimit?: (snapshot: UsageSnapshot) => void;
  /** Dropped/unknown message log (rule 5). */
  onDropped?: (reason: string, message: unknown) => void;
}

function isAbortSubtype(subtype: string): boolean {
  return /abort|interrupt|cancel/i.test(subtype);
}

/** Drive one turn to completion. Returns the single terminal kind emitted. */
export async function runTurn(
  messages: AsyncIterable<RunnerMessage>,
  deps: TurnRunnerDeps,
): Promise<TurnTerminal> {
  let terminated = false;
  let sawToolCall = false;
  let lastAssistantText = '';
  const drop = (reason: string, msg: unknown): void => deps.onDropped?.(reason, msg);

  const emitUsage = (usage: NonNullable<RunnerMessage & { type: 'result' }>['usage']): void => {
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
          deps.onSdkSessionId?.(msg.sdkSessionId, msg.model);
          break;

        case 'assistant-block': {
          if (msg.parentToolUseId !== null) {
            drop('subagent assistant-block', msg);
            break;
          }
          const b = msg.block;
          if (b.kind === 'text') {
            lastAssistantText = b.text;
            deps.emitChat({ kind: 'assistant-text', text: b.text, midLoop: sawToolCall }, { sdkUuid: msg.sdkUuid });
          } else if (b.kind === 'thinking') {
            deps.emitChat({ kind: 'thinking', text: b.text }, { sdkUuid: msg.sdkUuid });
          } else {
            sawToolCall = true;
            deps.emitChat(
              { kind: 'tool-call', toolUseId: b.toolUseId, name: b.name, input: b.input },
              { sdkUuid: msg.sdkUuid },
            );
          }
          break;
        }

        case 'tool-result':
          if (msg.parentToolUseId !== null) {
            drop('subagent tool-result', msg);
            break;
          }
          deps.emitChat(
            { kind: 'tool-result', toolUseId: msg.toolUseId, result: msg.result, isError: msg.isError },
            { sdkUuid: msg.sdkUuid },
          );
          break;

        case 'delta':
          if (msg.parentToolUseId !== null) {
            drop('subagent delta', msg);
            break;
          }
          deps.emitDelta(msg.sdkUuid, msg.delta);
          break;

        case 'result': {
          emitUsage(msg.usage);
          deps.emitChat({ kind: 'turn-duration', durationMs: msg.durationMs });
          if (msg.ok) {
            deps.emitChat({ kind: 'turn-end', text: lastAssistantText, stopReason: msg.stopReason });
          } else {
            deps.emitChat({
              kind: 'turn-failed',
              error: msg.error ?? msg.subtype,
              source: isAbortSubtype(msg.subtype) ? 'abort' : 'api',
            });
          }
          terminated = true;
          return msg.ok ? 'turn-end' : 'turn-failed';
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
          deps.emitChat({ kind: 'retract', uuids: msg.uuids });
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
      return 'turn-failed';
    }
    // Post-terminal throw (backend teardown noise) — the turn already ended.
    drop('post-terminal error', err);
    return 'turn-end';
  }

  // Stream ended with no `result` — positive receipt, never silence (rule 3).
  if (!terminated) {
    deps.emitChat({ kind: 'turn-failed', error: 'stream ended without result', source: 'internal' });
    return 'turn-failed';
  }
  return 'turn-end';
}
