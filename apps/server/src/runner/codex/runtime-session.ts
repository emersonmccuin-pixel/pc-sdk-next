import { randomUUID } from 'node:crypto';
import { isAbsolute, resolve } from 'node:path';

import {
  isRuntimeSelection,
  type ContextObservation,
  type RuntimeSelection,
  type RuntimeSessionReceipt,
} from '@pc/contracts';

import type { AskDecision, AskHandler, RuntimeEvent, RuntimeSession } from '../runtime.ts';
import {
  captureCodexApprovalRequest,
  captureInterruptResponse,
  captureProviderFreeTurnBoundaryReceipt,
  captureRuntimeNotification,
  captureTurnStartResponse,
  CodexRuntimeMappingError,
  type CapturedCodexApprovalRequest,
} from './runtime-mapping.ts';
import {
  CODEX_PROTOCOL_VERSION,
  CODEX_RUNTIME_ID,
  type CodexProviderFreeConformanceAuthority,
  type CodexRuntimePeer,
} from './runtime-peer.ts';

export type CodexRuntimeSessionErrorCode =
  | 'invalid-session-config'
  | 'session-disposed'
  | 'session-unavailable'
  | 'turn-active'
  | 'turn-input-invalid'
  | 'interrupt-unavailable'
  | 'peer-disposal-unavailable';

export class CodexRuntimeSessionError extends Error {
  readonly name = 'CodexRuntimeSessionError';

  constructor(readonly code: CodexRuntimeSessionErrorCode) {
    super(`Codex runtime session unavailable: ${code}`);
  }
}

export interface CodexRuntimeSessionConfig {
  peer: CodexRuntimePeer;
  conformanceAuthority: CodexProviderFreeConformanceAuthority;
  selection: RuntimeSelection;
  continuationAttemptId: string;
  mode: 'created' | 'resumed';
  nativeThreadId: string;
  requestedNativeThreadId: string | null;
  historicalTurnIds: readonly string[];
  historicalItemIds: readonly string[];
  cwd: string;
  maxTurns: number | null;
  appSessionId: string;
  /** Permission seam for routed exec/patch approvals; null denies fail-closed. */
  ask: AskHandler | null;
}

const CONTEXT_UNAVAILABLE: ContextObservation = Object.freeze({
  confidence: 'unavailable',
  reason: 'runtime-unavailable',
});

export class CodexRuntimeSession implements RuntimeSession {
  private readonly peer: CodexRuntimePeer;
  private readonly conformanceAuthority: CodexProviderFreeConformanceAuthority;
  private readonly selection: RuntimeSelection;
  private readonly receipt: RuntimeSessionReceipt;
  private readonly nativeThreadId: string;
  private readonly cwd: string;
  private readonly continuationAttemptId: string;
  private readonly appSessionId: string;
  private readonly ask: AskHandler | null;
  private activeApprovalPump: Promise<void> | null = null;
  private receiptPending = true;
  private active = false;
  private activeReservationId: string | null = null;
  private activeTurnId: string | null = null;
  private activeCancellation: TurnCancellation | null = null;
  private activeInterruptCancellation: TurnCancellation | null = null;
  private disposed = false;
  private poisoned = false;
  private closePromise: Promise<void> | null = null;
  private notificationCleanupPending: Promise<void> | null = null;
  private readonly maxTurns: number | null;
  private completedTurns = 0;
  private readonly usedTurnIds: Set<string>;
  private readonly usedItemIds: Set<string>;

  constructor(config: CodexRuntimeSessionConfig) {
    if (!isPeer(config?.peer) || !isAuthority(config?.conformanceAuthority) ||
      Object.is(config.peer, config.conformanceAuthority) ||
      !isRuntimeSelection(config?.selection) ||
      config.selection.runtimeId !== CODEX_RUNTIME_ID ||
      !exactString(config?.continuationAttemptId) ||
      !nativeId(config?.nativeThreadId) || !canonicalAbsolutePath(config?.cwd) ||
      (config.mode !== 'created' && config.mode !== 'resumed') ||
      (config.mode === 'created'
        ? config.requestedNativeThreadId !== null
        : config.requestedNativeThreadId !== config.nativeThreadId) ||
      !distinctValues(config.historicalTurnIds, nativeId) ||
      !distinctValues(config.historicalItemIds, exactString) ||
      (config.mode === 'created' &&
        (config.historicalTurnIds.length !== 0 || config.historicalItemIds.length !== 0)) ||
      (config.maxTurns !== null &&
        (!Number.isSafeInteger(config.maxTurns) || config.maxTurns <= 0)) ||
      !exactString(config?.appSessionId) ||
      (config.ask !== null && typeof config.ask !== 'function')) {
      throw new CodexRuntimeSessionError('invalid-session-config');
    }
    this.peer = config.peer;
    this.conformanceAuthority = config.conformanceAuthority;
    this.selection = freezeSelection(config.selection);
    this.nativeThreadId = config.nativeThreadId;
    this.cwd = config.cwd;
    this.continuationAttemptId = config.continuationAttemptId;
    this.appSessionId = config.appSessionId;
    this.ask = config.ask;
    this.maxTurns = config.maxTurns;
    this.usedTurnIds = new Set(config.historicalTurnIds);
    this.usedItemIds = new Set(config.historicalItemIds);
    this.receipt = Object.freeze({
      mode: config.mode,
      continuationAttemptId: config.continuationAttemptId,
      selection: this.selection,
      nativeSessionId: config.nativeThreadId,
      requestedNativeSessionId: config.requestedNativeThreadId,
    });
  }

  sendTurn(text: string): AsyncIterable<RuntimeEvent> {
    if (this.disposed) throw new CodexRuntimeSessionError('session-disposed');
    if (this.poisoned) throw new CodexRuntimeSessionError('session-unavailable');
    if (this.active) throw new CodexRuntimeSessionError('turn-active');
    if (this.notificationCleanupPending !== null) {
      throw new CodexRuntimeSessionError('session-unavailable');
    }
    if (this.maxTurns !== null && this.completedTurns >= this.maxTurns) {
      return oneResultStream(failureResult(
        'budget-exhausted',
        'runtime turn budget exhausted',
        null,
      ));
    }
    if (!validTurnText(text)) throw new CodexRuntimeSessionError('turn-input-invalid');
    const reservationId = randomUUID();
    const cancellation = new TurnCancellation();
    const interruptCancellation = new TurnCancellation();
    this.active = true;
    this.activeReservationId = reservationId;
    this.activeCancellation = cancellation;
    this.activeInterruptCancellation = interruptCancellation;
    return new ReservedTurnStream(
      this.runTurn(text, reservationId, cancellation, interruptCancellation),
      () => this.releasePreStartReservation(reservationId),
      () => this.cancelStartedReservation(reservationId, cancellation),
    );
  }

  async observeContext(): Promise<ContextObservation> {
    return CONTEXT_UNAVAILABLE;
  }

  async interrupt(): Promise<void> {
    const turnId = this.activeTurnId;
    const cancellation = this.activeInterruptCancellation;
    if (this.disposed || this.poisoned || !this.active || turnId === null ||
      cancellation === null) {
      throw new CodexRuntimeSessionError('interrupt-unavailable');
    }
    let response: unknown;
    try {
      response = await waitForTurn(this.peer.interruptTurn({
        threadId: this.nativeThreadId,
        turnId,
      }), cancellation);
      captureInterruptResponse(response);
      if (this.disposed || this.poisoned || !this.active ||
        this.activeTurnId !== turnId) {
        throw new CodexRuntimeSessionError('interrupt-unavailable');
      }
    } catch {
      throw new CodexRuntimeSessionError('interrupt-unavailable');
    }
  }

  async dispose(): Promise<void> {
    this.disposed = true;
    this.activeCancellation?.cancel();
    this.activeInterruptCancellation?.cancel();
    return this.initiateClose();
  }

  private async *runTurn(
    text: string,
    reservationId: string,
    cancellation: TurnCancellation,
    interruptCancellation: TurnCancellation,
  ): AsyncGenerator<RuntimeEvent, void> {
    let terminal = false;
    let runningEmitted = false;
    let nativeItemId: string | null = null;
    let canonicalItemId: string | null = null;
    let accumulatedText = '';
    let itemCompleted = false;
    let completedPhase: 'commentary' | 'final_answer' | null = null;
    let streamOpen = false;
    let notificationIterator: AsyncIterator<unknown> | null = null;
    let notificationsClosed = false;
    const closeNotifications = (): Promise<void> => {
      if (notificationsClosed || notificationIterator === null) return Promise.resolve();
      notificationsClosed = true;
      try {
        const closing = notificationIterator.return?.();
        return closing === undefined ? Promise.resolve() : Promise.resolve(closing).then(() => {});
      } catch (error) {
        return Promise.reject(error);
      }
    };
    const abandonNotifications = (): void => {
      void closeNotifications().catch(() => {
        // Failure/cancellation already poisons and disposes the peer; exact-peer
        // disposal owns uncertain iterator cleanup without delaying its terminal.
      });
    };
    try {
      this.assertTurnReservation(reservationId);
      const response = await waitForTurn(this.peer.startTurn({
        threadId: this.nativeThreadId,
        input: [{ type: 'text', text, text_elements: [] }],
        cwd: this.cwd,
        approvalPolicy: 'on-request',
        approvalsReviewer: 'user',
        sandboxPolicy: workspaceWriteSandbox(this.cwd),
        model: this.selection.model,
        effort: selectedEffort(this.selection),
      }), cancellation);
      this.assertTurnReservation(reservationId);
      const turnId = captureTurnStartResponse(response);
      this.assertTurnReservation(reservationId);
      if (this.usedTurnIds.has(turnId)) {
        throw new CodexRuntimeMappingError('runtime-notification-invalid');
      }
      this.usedTurnIds.add(turnId);
      this.activeTurnId = turnId;
      // Route exec/patch approvals raised during this turn alongside the
      // notification loop. The pump self-terminates when the shared turn
      // cancellation fires (terminal, failure, dispose).
      this.activeApprovalPump = this.pumpApprovals(reservationId, cancellation);

      if (this.receiptPending) {
        this.receiptPending = false;
        yield { type: 'session-started', receipt: this.receipt };
      }

      let turnStarted = false;
      this.assertTurnReservation(reservationId, turnId);
      notificationIterator = this.peer.notifications()[Symbol.asyncIterator]();
      for (;;) {
        this.assertTurnReservation(reservationId, turnId);
        const next = await waitForTurn(notificationIterator.next(), cancellation);
        if (next.done) throw new CodexRuntimeMappingError('runtime-notification-invalid');
        const raw = next.value;
        this.assertTurnReservation(reservationId, turnId);
        const event = captureRuntimeNotification(raw);
        this.assertTurnReservation(reservationId, turnId);
        if (event.threadId !== this.nativeThreadId || event.turnId !== turnId) {
          throw new CodexRuntimeMappingError('runtime-notification-invalid');
        }

        switch (event.kind) {
          case 'turn-started':
            if (turnStarted || nativeItemId !== null) {
              throw new CodexRuntimeMappingError('runtime-notification-invalid');
            }
            turnStarted = true;
            runningEmitted = true;
            yield { type: 'session-state', state: 'running', permissionMode: null };
            break;

          case 'agent-message-started':
            if (!turnStarted || nativeItemId !== null || itemCompleted) {
              throw new CodexRuntimeMappingError('runtime-notification-invalid');
            }
            if (this.usedItemIds.has(event.itemId)) {
              throw new CodexRuntimeMappingError('runtime-notification-invalid');
            }
            this.usedItemIds.add(event.itemId);
            nativeItemId = event.itemId;
            canonicalItemId = randomUUID();
            streamOpen = true;
            yield {
              type: 'delta',
              itemId: canonicalItemId,
              scope: 'primary',
              delta: { kind: 'message-start' },
            };
            break;

          case 'agent-message-delta':
            if (!turnStarted || itemCompleted || event.itemId !== nativeItemId ||
              canonicalItemId === null) {
              throw new CodexRuntimeMappingError('runtime-notification-invalid');
            }
            accumulatedText += event.delta;
            yield {
              type: 'delta',
              itemId: canonicalItemId,
              scope: 'primary',
              delta: { kind: 'text-delta', text: event.delta },
            };
            break;

          case 'agent-message-completed': {
            if (!turnStarted || itemCompleted || event.itemId !== nativeItemId ||
              canonicalItemId === null ||
              (accumulatedText.length > 0 && event.text !== accumulatedText)) {
              throw new CodexRuntimeMappingError('runtime-notification-invalid');
            }
            itemCompleted = true;
            accumulatedText = event.text;
            completedPhase = event.phase;
            streamOpen = false;
            yield {
              type: 'delta',
              itemId: canonicalItemId,
              scope: 'primary',
              delta: { kind: 'message-end' },
            };
            this.assertTurnReservation(reservationId, turnId);
            yield {
              type: 'assistant-block',
              itemId: canonicalItemId,
              scope: 'primary',
              block: { kind: 'text', text: accumulatedText },
            };
            break;
          }

          case 'turn-completed': {
            if (!turnStarted || (event.status === 'completed' && !itemCompleted)) {
              throw new CodexRuntimeMappingError('runtime-notification-invalid');
            }
            if (!terminalItemsMatch(
              event.items,
              itemCompleted && nativeItemId !== null
                ? [{ itemId: nativeItemId, text: accumulatedText, phase: completedPhase }]
                : [],
            )) {
              throw new CodexRuntimeMappingError('runtime-notification-invalid');
            }
            const turnSequence = this.completedTurns + 1;
            const boundaryChallenge = Object.freeze({
              kind: 'provider-free-turn-boundary-challenge' as const,
              protocolVersion: CODEX_PROTOCOL_VERSION,
              runtimeId: CODEX_RUNTIME_ID,
              continuationAttemptId: this.continuationAttemptId,
              threadId: this.nativeThreadId,
              turnId,
              turnSequence,
              status: event.status,
            });
            // Once the exact terminal frame is observed, no new interrupt may
            // target that native turn while independent boundary proof settles.
            this.activeTurnId = null;
            interruptCancellation.cancel();
            captureProviderFreeTurnBoundaryReceipt(
              await waitForTurn(
                this.conformanceAuthority.attestTurnBoundary(this.peer, boundaryChallenge),
                cancellation,
              ),
              boundaryChallenge,
            );
            this.assertTurnReservation(reservationId);
            cancellation.cancel();
            this.trackNotificationCleanup(closeNotifications());
            if (streamOpen && canonicalItemId !== null) {
              streamOpen = false;
              yield {
                type: 'delta',
                itemId: canonicalItemId,
                scope: 'primary',
                delta: { kind: 'message-end' },
              };
            }
            runningEmitted = false;
            yield { type: 'session-state', state: 'idle', permissionMode: null };
            let result: Extract<RuntimeEvent, { type: 'result' }>;
            if (event.status === 'completed') {
              result = successResult(event.durationMs);
            } else if (event.status === 'interrupted') {
              result = failureResult('aborted', 'runtime turn interrupted', event.durationMs);
            } else {
              result = failureResult('error', 'runtime turn failed', event.durationMs);
            }
            this.completedTurns += 1;
            terminal = true;
            this.releaseTerminalReservation(reservationId);
            yield result;
            return;
          }
        }
      }

      throw new CodexRuntimeMappingError('runtime-notification-invalid');
    } catch {
      if (!terminal) {
        this.poisoned = true;
        this.closeAfterProtocolFailure();
        this.activeTurnId = null;
        if (streamOpen && canonicalItemId !== null) {
          streamOpen = false;
          yield {
            type: 'delta',
            itemId: canonicalItemId,
            scope: 'primary',
            delta: { kind: 'message-end' },
          };
        }
        if (runningEmitted) {
          runningEmitted = false;
          yield { type: 'session-state', state: 'idle', permissionMode: null };
        }
        terminal = true;
        abandonNotifications();
        this.releaseTerminalReservation(reservationId);
        yield failureResult('error', 'runtime unavailable', null);
      }
    } finally {
      abandonNotifications();
      if (!terminal && !this.disposed) {
        this.poisoned = true;
        this.closeAfterProtocolFailure();
      }
      this.releaseTerminalReservation(reservationId);
    }
  }

  /** Drain the peer's per-turn approval requests, routing each to the app ask
   * (or denying fail-closed when no handler) and forwarding the verdict. A
   * malformed request or peer failure poisons the turn; cancellation ends the
   * pump cleanly. */
  private async pumpApprovals(
    reservationId: string,
    cancellation: TurnCancellation,
  ): Promise<void> {
    const iterator = this.peer.approvals()[Symbol.asyncIterator]();
    try {
      for (;;) {
        const next = await waitForTurn(iterator.next(), cancellation);
        if (next.done) return;
        this.assertTurnReservation(reservationId);
        const request = captureCodexApprovalRequest(next.value);
        const behavior = await this.decideApproval(request, cancellation);
        await waitForTurn(this.peer.respondToApproval({
          kind: request.kind,
          callId: request.callId,
          behavior,
        }), cancellation);
      }
    } catch (error) {
      // Cancellation (session-unavailable) is orderly teardown, not a failure.
      if (!(error instanceof CodexRuntimeSessionError)) {
        this.poisoned = true;
        cancellation.cancel();
      }
    } finally {
      try {
        await iterator.return?.();
      } catch {
        // Peer disposal owns uncertain approval-iterator cleanup.
      }
    }
  }

  private async decideApproval(
    request: CapturedCodexApprovalRequest,
    cancellation: TurnCancellation,
  ): Promise<'allow' | 'deny'> {
    if (this.ask === null) return 'deny';
    const handle = this.ask({
      toolName: request.kind === 'exec' ? 'ExecCommand' : 'ApplyPatch',
      callId: randomUUID(),
      toolInput: request.kind === 'exec'
        ? { command: request.command, cwd: request.cwd }
        : { paths: request.paths },
      appSessionId: this.appSessionId,
    });
    let decision: AskDecision;
    try {
      decision = await waitForTurn(handle.decision, cancellation);
    } catch (error) {
      handle.cancel();
      throw error;
    }
    return decision.behavior === 'allow' ? 'allow' : 'deny';
  }

  private assertTurnReservation(reservationId: string, turnId?: string): void {
    if (this.disposed || this.poisoned || !this.active ||
      this.activeReservationId !== reservationId ||
      (turnId !== undefined && this.activeTurnId !== turnId)) {
      throw new CodexRuntimeSessionError('session-unavailable');
    }
  }

  private releasePreStartReservation(reservationId: string): void {
    if (this.activeReservationId !== reservationId) return;
    this.active = false;
    this.activeReservationId = null;
    this.activeTurnId = null;
    this.activeCancellation?.cancel();
    this.activeCancellation = null;
    this.activeInterruptCancellation?.cancel();
    this.activeInterruptCancellation = null;
  }

  private cancelStartedReservation(
    reservationId: string,
    cancellation: TurnCancellation,
  ): void {
    if (this.activeReservationId !== reservationId) return;
    this.poisoned = true;
    this.disposed = true;
    cancellation.cancel();
    this.activeInterruptCancellation?.cancel();
    void this.initiateClose().catch(() => {
      // The stored close promise retains the typed disposal uncertainty for a
      // later explicit dispose call; iterator cancellation must remain prompt.
    });
  }

  private releaseTerminalReservation(reservationId: string): void {
    if (this.activeReservationId !== reservationId) return;
    this.activeCancellation?.cancel();
    this.activeInterruptCancellation?.cancel();
    this.active = false;
    this.activeReservationId = null;
    this.activeTurnId = null;
    this.activeCancellation = null;
    this.activeInterruptCancellation = null;
  }

  private initiateClose(): Promise<void> {
    if (this.closePromise === null) {
      // Publish the memoized promise before invoking peer code so synchronous
      // re-entry through dispose cannot start a second close.
      this.closePromise = Promise.resolve()
        .then(() => this.peer.dispose())
        .catch(() => {
          throw new CodexRuntimeSessionError('peer-disposal-unavailable');
        });
    }
    return this.closePromise;
  }

  private trackNotificationCleanup(cleanup: Promise<void>): void {
    let tracked!: Promise<void>;
    tracked = cleanup.then(
      () => {
        if (this.notificationCleanupPending === tracked) {
          this.notificationCleanupPending = null;
        }
      },
      () => {
        if (this.notificationCleanupPending !== tracked) return;
        this.notificationCleanupPending = null;
        this.poisoned = true;
        this.disposed = true;
        this.activeCancellation?.cancel();
        this.activeInterruptCancellation?.cancel();
        void this.initiateClose().catch(() => {
          // The session remains unavailable; explicit dispose retains the typed
          // peer-disposal uncertainty through the stored close promise.
        });
      },
    );
    this.notificationCleanupPending = tracked;
  }

  private closeAfterProtocolFailure(): void {
    this.disposed = true;
    this.activeCancellation?.cancel();
    this.activeInterruptCancellation?.cancel();
    void this.initiateClose().catch(() => {
      // Protocol failure remains the safe canonical result. Disposal
      // uncertainty is retained by closePromise for an explicit dispose call.
    });
  }
}

function successResult(durationMs: number | null): Extract<RuntimeEvent, { type: 'result' }> {
  return {
    type: 'result',
    ok: true,
    stopReason: 'complete',
    usage: null,
    durationMs,
    numTurns: null,
    error: null,
    outcome: 'ok',
  };
}

function failureResult(
  outcome: 'error' | 'aborted' | 'budget-exhausted',
  error: string,
  durationMs: number | null,
): Extract<RuntimeEvent, { type: 'result' }> {
  return {
    type: 'result',
    ok: false,
    stopReason: null,
    usage: null,
    durationMs,
    numTurns: null,
    error,
    outcome,
  };
}

async function* oneResultStream(
  result: Extract<RuntimeEvent, { type: 'result' }>,
): AsyncGenerator<RuntimeEvent, void> {
  yield result;
}

class TurnCancellation {
  readonly promise: Promise<void>;
  private resolve!: () => void;
  private cancelled = false;

  constructor() {
    this.promise = new Promise<void>((resolvePromise) => {
      this.resolve = resolvePromise;
    });
  }

  cancel(): void {
    if (this.cancelled) return;
    this.cancelled = true;
    this.resolve();
  }
}

async function waitForTurn<T>(
  operation: Promise<T>,
  cancellation: TurnCancellation,
): Promise<T> {
  return Promise.race([
    operation,
    cancellation.promise.then((): never => {
      throw new CodexRuntimeSessionError('session-unavailable');
    }),
  ]);
}

class ReservedTurnStream implements AsyncIterable<RuntimeEvent>, AsyncIterator<RuntimeEvent> {
  private started = false;
  private closed = false;

  constructor(
    private readonly generator: AsyncGenerator<RuntimeEvent, void>,
    private readonly releaseBeforeStart: () => void,
    private readonly cancelStarted: () => void,
  ) {}

  [Symbol.asyncIterator](): AsyncIterator<RuntimeEvent> {
    return this;
  }

  async next(): Promise<IteratorResult<RuntimeEvent>> {
    if (this.closed) return { done: true, value: undefined };
    this.started = true;
    const result = await this.generator.next();
    if (result.done) this.closed = true;
    return result;
  }

  async return(): Promise<IteratorResult<RuntimeEvent>> {
    if (this.closed) return { done: true, value: undefined };
    this.closed = true;
    if (!this.started) {
      this.releaseBeforeStart();
      return { done: true, value: undefined };
    }
    this.cancelStarted();
    return this.generator.return();
  }

  async throw(error?: unknown): Promise<IteratorResult<RuntimeEvent>> {
    if (this.closed) throw error;
    this.closed = true;
    if (!this.started) {
      this.releaseBeforeStart();
      throw error;
    }
    this.cancelStarted();
    try {
      await this.generator.return();
    } catch {
      // Cancellation owns cleanup; preserve the caller's injected error.
    }
    throw error;
  }
}

function terminalItemsMatch(
  actual: readonly { itemId: string; text: string; phase: 'commentary' | 'final_answer' | null }[],
  expected: readonly { itemId: string; text: string; phase: 'commentary' | 'final_answer' | null }[],
): boolean {
  return actual.length === expected.length && actual.every((item, index) => {
    const match = expected[index];
    return match !== undefined && item.itemId === match.itemId &&
      item.text === match.text && item.phase === match.phase;
  });
}

function workspaceWriteSandbox(cwd: string): {
  type: 'workspaceWrite';
  writableRoots: string[];
  networkAccess: boolean;
  excludeTmpdirEnvVar: boolean;
  excludeSlashTmp: boolean;
} {
  return {
    type: 'workspaceWrite',
    writableRoots: [cwd],
    networkAccess: false,
    excludeTmpdirEnvVar: true,
    excludeSlashTmp: true,
  };
}

function selectedEffort(selection: RuntimeSelection): string | null {
  return selection.effort.kind === 'selected' ? selection.effort.value : null;
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

function isPeer(value: unknown): value is CodexRuntimePeer {
  if (value === null || typeof value !== 'object') return false;
  try {
    const peer = value as Partial<CodexRuntimePeer>;
    return typeof peer.startThread === 'function' &&
      typeof peer.resumeThread === 'function' &&
      typeof peer.startTurn === 'function' &&
      typeof peer.interruptTurn === 'function' &&
      typeof peer.notifications === 'function' &&
      typeof peer.approvals === 'function' &&
      typeof peer.respondToApproval === 'function' &&
      typeof peer.dispose === 'function';
  } catch {
    return false;
  }
}

function isAuthority(value: unknown): value is CodexProviderFreeConformanceAuthority {
  if (value === null || typeof value !== 'object') return false;
  try {
    const authority = value as Partial<CodexProviderFreeConformanceAuthority>;
    return typeof authority.attestExecutionPolicy === 'function' &&
      typeof authority.attestTurnBoundary === 'function';
  } catch {
    return false;
  }
}

function exactString(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && value === value.trim() &&
    !value.includes('\u0000');
}

function validTurnText(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && !value.includes('\u0000');
}

function canonicalAbsolutePath(value: unknown): value is string {
  return exactString(value) && isAbsolute(value) && resolve(value) === value;
}

function nativeId(value: unknown): value is string {
  return exactString(value) &&
    /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
}

function distinctValues(
  value: unknown,
  predicate: (entry: unknown) => entry is string,
): value is readonly string[] {
  return Array.isArray(value) && value.every(predicate) &&
    new Set(value).size === value.length;
}
