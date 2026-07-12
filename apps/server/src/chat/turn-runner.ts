// Turn-runner — maps a runtime session's RuntimeEvent stream to ChatEvents per
// the runtime→contract mapping table (docs/event-contract.md).
//
// Invariants this owns:
//  - Rule 3: every turn terminates in EXACTLY ONE `turn-end` or `turn-failed`.
//    A result maps to one; a stream that ends without a result, or throws,
//    still emits an internal terminal. Post-terminal messages are dropped.
//  - Rule 5: an unknown message variant is dropped + logged; the loop continues.
//  - Runtime events marked as sidechain are not forwarded to chat.
//  - `supersedes` → `retract` (model-refusal fallback).
//
// It does NOT persist directly. `emitChat` and `emitDelta` both enter the
// canonical atomic event/outbox door; the conversation relay publishes later.

import {
  isChatEvent,
  toolStateTransitionError,
  type ActivityPhase,
  type ChatDeltaEvent,
  type ChatEvent,
  type RuntimeSessionReceipt,
  type SubscriptionQuotaObservationBatch,
  type ToolStateEvent,
} from '@pc/contracts';
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
  /** Positive exact native create/resume observation. */
  onRuntimeSessionReceipt?: (receipt: RuntimeSessionReceipt) => void;
  /** Subscription-quota telemetry; never enters the conversation transcript. */
  onSubscriptionQuota?: (batch: SubscriptionQuotaObservationBatch) => void;
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
  let currentActivity: ActivityPhase | null = null;
  const tools = new Map<string, ToolStateEvent>();
  const nextDeltaIndex = new Map<string, number>();
  // Overwritten the moment a real terminal is emitted; the post-terminal-throw
  // branch below relies on this holding the actual result, not a placeholder.
  let terminalResult: TurnResult = { terminal: 'turn-failed', outcome: 'error', numTurns: null };
  const drop = (reason: string, msg: unknown): void => deps.onDropped?.(reason, msg);

  const emitActivity = (phase: Exclude<ActivityPhase, 'turn-starting'>): void => {
    if (currentActivity === phase) return;
    currentActivity = phase;
    deps.emitChat({ kind: 'activity-state', phase });
  };

  const emitTool = (observed: ToolStateEvent): void => {
    if (!isChatEvent(observed) || observed.kind !== 'tool-state') {
      drop('invalid tool-state observation', observed);
      return;
    }
    let previous = tools.get(observed.callId) ?? null;
    if (!previous && observed.state !== 'requested') {
      const requested: ToolStateEvent = {
        ...observed,
        state: 'requested',
        approval: { status: 'unknown', source: null, requestId: null },
        outcome: null,
      };
      deps.emitChat(requested, { itemId: requested.callId });
      tools.set(requested.callId, requested);
      previous = requested;
      sawToolCall = true;
    }
    if (
      previous &&
      (observed.state === 'succeeded' || observed.state === 'failed') &&
      (observed.state !== 'failed' || observed.outcome?.reason === 'tool-error') &&
      (previous.state === 'requested' || previous.state === 'approval-needed')
    ) {
      if (
        previous.state === 'approval-needed'
        && (
          previous.approval.status !== 'pending'
          || observed.approval.status !== 'allowed'
          || observed.approval.source !== 'user'
          || observed.approval.requestId !== previous.approval.requestId
        )
      ) {
        drop('terminal tool observation lacks positive approval provenance', observed);
        return;
      }
      const approval = observed.approval.status === 'allowed' || observed.approval.status === 'not-required'
        ? observed.approval
        : { status: 'not-required' as const, source: 'runtime' as const, requestId: null };
      const running: ToolStateEvent = { ...observed, state: 'running', approval, outcome: null };
      const runningError = toolStateTransitionError(previous, running);
      if (runningError) {
        drop(`invalid synthesized tool transition: ${runningError}`, observed);
        return;
      }
      deps.emitChat(running, { itemId: running.callId });
      tools.set(running.callId, running);
      previous = running;
    }
    const transitionError = toolStateTransitionError(previous, observed);
    if (transitionError) {
      // Exact duplicate observations are expected from some runtimes; all
      // regressions/conflicts are dropped without changing accepted state.
      drop(`invalid tool transition: ${transitionError}`, observed);
      return;
    }
    deps.emitChat(observed, { itemId: observed.callId });
    tools.set(observed.callId, observed);
    if (observed.state === 'requested') sawToolCall = true;
  };

  const closeOpenTools = (): void => {
    for (const previous of tools.values()) {
      if (previous.state === 'succeeded' || previous.state === 'failed' || previous.state === 'denied') continue;
      if (previous.state === 'approval-needed') {
        if (previous.approval.status !== 'pending') {
          drop('invalid pending approval during tool closure', previous);
          continue;
        }
        emitTool({
          ...previous,
          state: 'denied',
          approval: {
            status: 'denied',
            source: 'session',
            requestId: previous.approval.requestId,
          },
          outcome: null,
        });
      } else {
        emitTool({ ...previous, state: 'failed', outcome: { reason: 'turn-ended' } });
      }
    }
  };

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
        case 'session-started':
          deps.onRuntimeSessionReceipt?.(msg.receipt);
          break;

        case 'assistant-block': {
          if (msg.scope === 'sidechain') {
            drop('subagent assistant-block', msg);
            break;
          }
          const b = msg.block;
          emitActivity('responding');
          lastAssistantText = b.text;
          deps.emitChat(
            { kind: 'assistant-text', text: b.text, midLoop: sawToolCall },
            { itemId: msg.itemId, streamId: msg.itemId },
          );
          break;
        }

        case 'tool-state':
          if (msg.scope === 'sidechain') {
            drop('subagent tool-state', msg);
            break;
          }
          emitTool(msg.event);
          break;

        case 'activity-state':
          emitActivity(msg.phase);
          break;

        case 'delta':
          if (msg.scope === 'sidechain') {
            drop('subagent delta', msg);
            break;
          }
          const deltaIndex = nextDeltaIndex.get(msg.itemId) ?? 0;
          nextDeltaIndex.set(msg.itemId, deltaIndex + 1);
          if (msg.delta.kind === 'text-delta') emitActivity('responding');
          deps.emitDelta(msg.itemId, deltaIndex, msg.delta);
          break;

        case 'result': {
          closeOpenTools();
          emitUsage(msg.usage);
          deps.emitChat({ kind: 'turn-duration', durationMs: msg.durationMs });
          // Keep a runtime check in addition to the discriminated TypeScript
          // contract: adapters are an I/O boundary and malformed JS can still
          // reach this function at runtime.
          const observed = msg as unknown as { ok: unknown; outcome: unknown; error: unknown };
          const coherent = (observed.ok === true && observed.outcome === 'ok' && observed.error === null)
            || (
              observed.ok === false
              && (observed.outcome === 'error' || observed.outcome === 'aborted' || observed.outcome === 'budget-exhausted')
              && (observed.error === null || typeof observed.error === 'string')
            );
          if (!coherent) {
            drop('incoherent runtime result', msg);
            deps.emitChat({
              kind: 'turn-failed',
              error: 'runtime returned an invalid terminal receipt',
              source: 'internal',
            });
            terminated = true;
            terminalResult = { terminal: 'turn-failed', outcome: 'error', numTurns: null };
            return terminalResult;
          }
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
          emitActivity('compacting');
          deps.emitChat({
            kind: 'compaction',
            trigger: msg.trigger,
            preTokens: msg.preTokens,
            postTokens: msg.postTokens,
          });
          break;

        case 'api-retry':
          emitActivity('retrying');
          deps.emitChat({
            kind: 'system',
            subtype: 'runtime-retry',
            level: 'warning',
            message: msg.attempt === null
              ? 'Retrying the runtime request.'
              : msg.maxRetries === null
                ? `Retrying the runtime request (attempt ${msg.attempt}).`
                : `Retrying the runtime request (attempt ${msg.attempt} of ${msg.maxRetries}).`,
          });
          break;

        case 'subscription-quota':
          deps.onSubscriptionQuota?.(msg.batch);
          break;

        case 'system':
          deps.emitChat({ kind: 'system', subtype: msg.subtype, level: msg.level, message: msg.message });
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
      closeOpenTools();
      drop('runtime stream error', err);
      deps.emitChat({
        kind: 'turn-failed',
        error: 'runtime stream failed',
        // Exception text is not typed interruption evidence. Only a runtime
        // `result { outcome: 'aborted' }` may produce an abort terminal.
        source: 'internal',
      });
      // A genuine stream break is a real failure, never turn-budget exhaustion
      // (that classification only ever comes from a native `result` message).
      return { terminal: 'turn-failed', outcome: 'error', numTurns: null };
    }
    // Post-terminal throw (backend teardown noise) — the turn already ended;
    // return the terminal it actually ended with.
    drop('post-terminal error', err);
    return terminalResult;
  }

  // Stream ended with no `result` — positive receipt, never silence (rule 3).
  if (!terminated) {
    closeOpenTools();
    deps.emitChat({ kind: 'turn-failed', error: 'stream ended without result', source: 'internal' });
    return { terminal: 'turn-failed', outcome: 'error', numTurns: null };
  }
  return terminalResult;
}
