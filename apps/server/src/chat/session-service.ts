// SessionService — the orchestrator-chat engine for one project.
//
// Durable queue/turn state is owned by @pc/db. This service validates command
// session affinity, drives one claimed immutable revision through the runtime,
// and maps runtime events into the claimed conversation context.

import {
  clearPendingHandoffSeed,
  commitConversationEvent,
  confirmRuntimeSessionReceipt,
  continueOrchestratorSessionAcrossSelection,
  editQueuedConversationSend,
  enqueueConversationSend,
  failConversationInterrupt,
  failRuntimeSessionResume,
  getActiveConversationTurn,
  getActiveOrchestratorSession,
  getConversationHighWaterSequence,
  getConversationQueueSnapshot,
  handoffOrchestratorSession,
  hasConversationContextObservation,
  getOrchestratorSession,
  getProjectById,
  getTurnInterruptRequest,
  isOrchestratorSessionResumeReady,
  newId,
  prepareRuntimeSessionCreate,
  prepareRuntimeSessionResume,
  removeQueuedConversationSend,
  replaceOrchestratorSession,
  requestConversationInterrupt,
  resumeOrchestratorSessionTransition,
  runtimeSelectionForSession,
  settleConversationTurn,
  setOrchestratorSessionTitle,
  type ClaimedConversationTurn,
  type ConversationCommandResult,
  type OrchestratorSessionRow,
} from '@pc/db';
import {
  conversationFamilyForEvent,
  isContextObservation,
  type AskFrame,
  type ChatEvent,
  type ContextObservation,
  type ConversationCommand,
  type ConversationEvent,
  type EditQueuedMessage,
  type InterruptAndSendMessage,
  type InterruptMessage,
  type OrchestratorHealth,
  type OrchestratorStateFrame,
  type QueuedAgentEnvelope,
  type RemoveQueuedMessage,
  type RuntimeSelection,
  type RuntimeSelectionErrorCode,
  type RuntimeSelectionValidation,
  type SendMessage,
  type SendQueueSnapshotFrame,
  type ServerFrame,
  type SessionChangedFrame,
  type SessionReplayFrame,
  type SessionSummary,
  type SessionUpdatedFrame,
  type SubscriptionQuotaObservationBatch,
} from '@pc/contracts';
import type { ULID } from '@pc/domain';
import {
  RuntimeSelectionRejectedError,
  type RuntimeContinuationRequest,
  type RuntimeSession,
  type RuntimeSessionFactory,
} from '../runner/runtime.ts';
import { AskRegistry } from './ask-registry.ts';
import { compileHandoffSeedContext, hasReplayableTranscript } from './handoff.ts';
import { priorSessionTranscript, replayConversationEvents } from './replay.ts';
import { SendQueue } from './send-queue.ts';
import { runTurn, type TurnRunnerDeps } from './turn-runner.ts';

export interface InjectAgentEnvelopeInput {
  runId: string;
  agentName: string;
  pendingAskId?: string;
  status: 'waiting' | 'done' | 'failed';
  summary: string;
  detail: string;
  /** Verbatim envelope text — also the turn text sent to the runtime. */
  envelope: string;
  clientMessageId: string;
}

export interface SessionServiceDeps {
  projectId: ULID;
  broadcast: (frame: ServerFrame) => void;
  mintSession: RuntimeSessionFactory;
  resolveNewSessionSelection: (
    input: {
      projectId: ULID;
      accountId?: string;
      runtimeId?: string;
      /** Explicit model/effort overrides for a same-runtime selection change
       *  (header model/effort pickers). Omitted ⇒ the composition root's
       *  usual admin-default resolution (unchanged behavior). */
      model?: string;
      effort?: string | null;
    },
  ) => Promise<RuntimeSelectionValidation>;
  preflightRuntimeSession: (
    selection: RuntimeSelection,
    continuation: RuntimeContinuationRequest,
  ) => Promise<RuntimeSelectionValidation>;
  drainConversationOutbox?: () => void;
  onConversationRelayError?: (error: unknown) => void;
  cwd?: string;
  askTimeoutMs?: number;
  /** Upper bound for native interrupt acceptance plus its correlated terminal.
   * Timeout is a durable fail-closed/inconclusive outcome, never success. */
  interruptTimeoutMs?: number;
  /** Upper bound for post-terminal context observation. It delays only the
   * same session's FIFO successor; timeout becomes explicit unavailable truth. */
  contextObservationTimeoutMs?: number;
  /** Registry-owned boot gate. Direct service users default to ready. */
  queueDrainEnabled?: boolean;
  onSubscriptionQuota?: (batch: SubscriptionQuotaObservationBatch) => void;
  orchestratorRev?: () => number | null;
}

interface RuntimeReady {
  sessionId: string;
  turnId: string;
  promise: Promise<RuntimeAcquisition>;
}

interface RuntimeAcquisition {
  runtime: RuntimeSession;
  receiptRequired: boolean;
  receiptConfirmed: boolean;
  /** A lifecycle-foreign or older-generation receipt cannot fail this attempt. */
  receiptFailureSuppressed: boolean;
  continuationAttemptId: string | null;
  continuation: RuntimeContinuationRequest | null;
}

interface InterruptControl {
  stopped: Promise<void>;
  stop: () => void;
}

interface RuntimeObservationFence {
  epoch: number;
  signal: AbortSignal;
  invalidate: () => void;
}

const DEFAULT_INTERRUPT_TIMEOUT_MS = 15_000;
const DEFAULT_CONTEXT_OBSERVATION_TIMEOUT_MS = 2_000;

type ContextObservationOutcome =
  | { kind: 'observed'; value: unknown }
  | { kind: 'failed' }
  | { kind: 'timeout' }
  | { kind: 'invalidated' };

const CONTEXT_PERSISTENCE_RETRY_START_MS = 25;
const CONTEXT_PERSISTENCE_RETRY_MAX_MS = 500;
const CONTEXT_PERSISTENCE_FAILURE = 'context observation persistence unavailable';

function createRuntimeObservationFence(epoch: number): RuntimeObservationFence {
  const controller = new AbortController();
  return {
    epoch,
    signal: controller.signal,
    invalidate: () => controller.abort(),
  };
}

function deriveTitle(text: string): string | null {
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('<')) continue;
    const collapsed = line.replace(/\s+/g, ' ').trim();
    if (!collapsed) continue;
    return collapsed.length <= 60 ? collapsed : `${collapsed.slice(0, 57).trimEnd()}…`;
  }
  return null;
}

function sessionChanged(sessionId: string | null): ConversationCommandResult {
  return {
    status: 'rejected',
    sessionId,
    error: { code: 'session-changed', message: 'the command targets a session that is no longer active' },
  };
}

export class SessionService {
  private readonly projectId: ULID;
  private readonly broadcast: (frame: ServerFrame) => void;
  private readonly mintSession: RuntimeSessionFactory;
  private readonly resolveNewSessionSelection: SessionServiceDeps['resolveNewSessionSelection'];
  private readonly preflightRuntimeSession: SessionServiceDeps['preflightRuntimeSession'];
  private readonly drainConversationOutbox: () => void;
  private readonly onConversationRelayError: (error: unknown) => void;
  private readonly cwd?: string;
  private readonly onSubscriptionQuota?: (batch: SubscriptionQuotaObservationBatch) => void;
  private readonly orchestratorRev?: () => number | null;
  private readonly interruptTimeoutMs: number;
  private readonly contextObservationTimeoutMs: number;
  private queueDrainEnabled: boolean;

  private session: OrchestratorSessionRow | null;
  private runtime: RuntimeSession | null = null;
  private runtimeSessionId: string | null = null;
  private runtimeRev: number | null = null;
  private runtimeReady: RuntimeReady | null = null;
  private runtimeQuarantine: Promise<void> = Promise.resolve();
  private runtimeObservationFence = createRuntimeObservationFence(0);
  private sessionTransitionTail: Promise<void> = Promise.resolve();
  private health: OrchestratorHealth = 'idle';
  private failureReason: string | null = null;
  private disposed = false;
  private lifecycleGeneration = 0;
  private resolveDisposed!: () => void;
  private readonly disposedSignal = new Promise<void>((resolve) => {
    this.resolveDisposed = resolve;
  });

  private readonly sendQueue: SendQueue;
  private readonly askRegistry: AskRegistry;
  private readonly interruptControls = new Map<string, InterruptControl>();

  constructor(deps: SessionServiceDeps) {
    this.projectId = deps.projectId;
    this.broadcast = deps.broadcast;
    this.mintSession = deps.mintSession;
    this.resolveNewSessionSelection = deps.resolveNewSessionSelection;
    this.preflightRuntimeSession = deps.preflightRuntimeSession;
    this.drainConversationOutbox = deps.drainConversationOutbox ?? (() => {});
    this.onConversationRelayError = deps.onConversationRelayError ?? ((error) => {
      console.warn('[pc-sdk][conversation-relay] post-commit drain failed:', error);
    });
    this.cwd = deps.cwd;
    this.onSubscriptionQuota = deps.onSubscriptionQuota;
    this.orchestratorRev = deps.orchestratorRev;
    this.interruptTimeoutMs = deps.interruptTimeoutMs ?? DEFAULT_INTERRUPT_TIMEOUT_MS;
    this.contextObservationTimeoutMs = deps.contextObservationTimeoutMs
      ?? DEFAULT_CONTEXT_OBSERVATION_TIMEOUT_MS;
    this.queueDrainEnabled = deps.queueDrainEnabled ?? true;
    this.session = getActiveOrchestratorSession(this.projectId);
    this.askRegistry = new AskRegistry({
      projectId: this.projectId,
      emit: (frame: AskFrame) => this.broadcast(frame),
      timeoutMs: deps.askTimeoutMs,
    });
    this.sendQueue = new SendQueue({
      sessionId: () => this.session?.id ?? null,
      deliver: (turn) => this.deliver(turn),
      afterCommit: () => this.publishCommittedEvents(),
      onState: () => this.broadcast(this.orchestratorStateFrame()),
      onError: (error) => {
        console.error(`[pc-sdk][send-queue] drain failed for project ${this.projectId}:`, error);
        this.health = 'failed';
        this.failureReason = 'conversation queue failed';
        this.broadcast(this.orchestratorStateFrame());
      },
    });
  }

  // ── connect + automatic recovery drain ────────────────────────────────────

  connectSnapshot(): ServerFrame[] {
    const frames: ServerFrame[] = [this.sessionChangedFrame(this.session ? 'resume-session' : 'new-session')];
    frames.push(this.orchestratorStateFrame());
    if (this.session) {
      frames.push(this.sessionReplayFrame());
      frames.push(this.sendQueueSnapshotFrame());
      frames.push(...this.askRegistry.snapshot());
    }
    return frames;
  }

  /** Called by the registry at boot and after every queue-affecting command. */
  kick(): void {
    if (this.disposed) return;
    if (this.queueDrainEnabled) this.sendQueue.kick();
  }

  /** One-way composition readiness gate. Durable admission remains available
   * before this call, but no provider work may start. */
  enableQueueDrain(): void {
    if (this.disposed || this.queueDrainEnabled) return;
    this.queueDrainEnabled = true;
    this.sendQueue.kick();
  }

  // ── durable conversation commands ─────────────────────────────────────────

  async handleConversationCommand(command: ConversationCommand): Promise<ConversationCommandResult> {
    if (this.disposed) return sessionChanged(null);
    switch (command.type) {
      case 'send':
        return this.handleSend(command);
      case 'edit-queued-message':
        return this.handleEditQueuedMessage(command);
      case 'remove-queued-message':
        return this.handleRemoveQueuedMessage(command);
      case 'interrupt':
      case 'interrupt-and-send':
        return this.handleInterrupt(command);
    }
  }

  async handleSend(command: SendMessage): Promise<ConversationCommandResult> {
    if (this.disposed) return sessionChanged(null);
    const session = this.session;
    if (command.sessionId === null) {
      if (session) return sessionChanged(session.id);
      // Creating the initial session and admitting its send are one serialized
      // operation. Otherwise two first sends can each replace the session,
      // cancel the earlier FIFO item, and resolve mutable defaults twice.
      return this.withSessionTransition(async () => {
        if (this.disposed) return sessionChanged(null);
        const initialSession = this.session ?? await this.replaceSession('new session started');
        if (!this.session || this.session.id !== initialSession.id) {
          return sessionChanged(this.session?.id ?? null);
        }
        return this.enqueueUserSend(initialSession, command);
      });
    }
    if (!session || session.id !== command.sessionId) {
      return sessionChanged(session?.id ?? null);
    }
    if (!this.session || this.session.id !== session.id) return sessionChanged(this.session?.id ?? null);
    return this.enqueueUserSend(session, command);
  }

  private enqueueUserSend(
    session: OrchestratorSessionRow,
    command: SendMessage,
  ): ConversationCommandResult {
    if (this.disposed || !this.session || this.session.id !== session.id) {
      return sessionChanged(this.disposed ? null : this.session?.id ?? null);
    }
    const result = enqueueConversationSend({
      projectId: this.projectId,
      conversationId: session.id,
      sessionId: session.id,
      commandId: command.commandId,
      clientMessageId: command.clientMessageId,
      text: command.text,
      origin: 'user',
    });
    this.afterQueueCommand(result, true);
    return result;
  }

  private handleEditQueuedMessage(command: EditQueuedMessage): ConversationCommandResult {
    if (!this.session || command.sessionId !== this.session.id) {
      return sessionChanged(this.session?.id ?? null);
    }
    const result = editQueuedConversationSend({
      projectId: this.projectId,
      sessionId: command.sessionId,
      commandId: command.commandId,
      queueItemId: command.queueItemId,
      expectedRevision: command.expectedRevision,
      text: command.text,
    });
    this.afterQueueCommand(result, false);
    return result;
  }

  private handleRemoveQueuedMessage(command: RemoveQueuedMessage): ConversationCommandResult {
    if (!this.session || command.sessionId !== this.session.id) {
      return sessionChanged(this.session?.id ?? null);
    }
    const result = removeQueuedConversationSend({
      projectId: this.projectId,
      sessionId: command.sessionId,
      commandId: command.commandId,
      queueItemId: command.queueItemId,
      expectedRevision: command.expectedRevision,
    });
    this.afterQueueCommand(result, false);
    return result;
  }

  async injectAgentEnvelope(input: InjectAgentEnvelopeInput): Promise<ConversationCommandResult> {
    if (this.disposed) return sessionChanged(null);
    const session = await this.ensureActiveSession();
    if (this.disposed || !this.session || this.session.id !== session.id) {
      if (this.disposed) return sessionChanged(null);
      return sessionChanged(this.session?.id ?? null);
    }
    const agentEnvelope: QueuedAgentEnvelope = {
      runId: input.runId,
      agentName: input.agentName,
      ...(input.pendingAskId ? { pendingAskId: input.pendingAskId } : {}),
      status: input.status,
      summary: input.summary,
      detail: input.detail,
    };
    const result = enqueueConversationSend({
      projectId: this.projectId,
      conversationId: session.id,
      sessionId: session.id,
      commandId: `agent-envelope:${input.clientMessageId}`,
      clientMessageId: input.clientMessageId,
      text: input.envelope,
      origin: 'agent-envelope',
      agentEnvelope,
    });
    this.afterQueueCommand(result, true);
    return result;
  }

  private handleInterrupt(
    command: InterruptMessage | InterruptAndSendMessage,
  ): ConversationCommandResult {
    const session = this.session;
    if (!session || command.sessionId !== session.id) return sessionChanged(session?.id ?? null);
    const result = requestConversationInterrupt({
      projectId: this.projectId,
      conversationId: session.id,
      sessionId: session.id,
      requestId: command.requestId,
      targetTurnId: command.targetTurnId,
      ...(command.type === 'interrupt-and-send' ? { replacement: command.replacement } : {}),
    });
    // Duplicate transport commands replay their durable receipt only; they
    // must never repeat the provider-side side effect.
    if (result.status === 'applied' && result.interruptRequestId) {
      // Start the fail-closed lifecycle immediately after commit, before any
      // projection callback. A broken socket must not strand `requested`.
      const request = getTurnInterruptRequest(result.interruptRequestId);
      const active = getActiveConversationTurn(session.id);
      if (request?.status === 'requested' && active?.id === command.targetTurnId) {
        this.startInterruptAttempt(command.requestId, session, command.targetTurnId);
      }
    }
    this.afterQueueCommand(result, false);
    return result;
  }

  private startInterruptAttempt(
    requestId: string,
    session: OrchestratorSessionRow,
    targetTurnId: string,
  ): void {
    let stopped = false;
    let resolveStopped!: () => void;
    const stoppedSignal = new Promise<void>((resolve) => {
      resolveStopped = resolve;
    });
    const timer = setTimeout(() => {
      const failed = this.failInterruptRequest(requestId, {
        code: 'runtime-interrupt-inconclusive',
        message: `native interruption did not produce a correlated terminal within ${this.interruptTimeoutMs}ms; outcome is inconclusive and retry is blocked for this turn`,
      });
      if (failed) this.quarantineRuntime(session.id, targetTurnId);
    }, this.interruptTimeoutMs);
    if (typeof timer.unref === 'function') timer.unref();
    const control: InterruptControl = {
      stopped: stoppedSignal,
      stop: () => {
        if (stopped) return;
        stopped = true;
        clearTimeout(timer);
        resolveStopped();
      },
    };
    this.interruptControls.set(requestId, control);
    void this.driveInterruptAttempt(requestId, session, targetTurnId, control)
      .catch(() => {
        this.failInterruptRequest(requestId, {
          code: 'runtime-interrupt-failed',
          message: 'the runtime did not accept the interruption request',
        });
      });
  }

  private async driveInterruptAttempt(
    requestId: string,
    session: OrchestratorSessionRow,
    targetTurnId: string,
    control: InterruptControl,
  ): Promise<void> {
    let runtime = this.runtimeSessionId === session.id ? this.runtime : null;
    const ready = this.runtimeReady;
    if (!runtime && ready?.sessionId === session.id && ready.turnId === targetTurnId) {
      const outcome = await Promise.race([
        ready.promise.then(
          (value) => ({ kind: 'ready' as const, value }),
          (error: unknown) => ({ kind: 'error' as const, error }),
        ),
        control.stopped.then(() => ({ kind: 'stopped' as const })),
      ]);
      if (outcome.kind === 'stopped') return;
      if (outcome.kind === 'error') throw outcome.error;
      runtime = outcome.value.runtime;
    }

    // The target can terminate while runtime startup is awaited. Its atomic
    // settlement also resolves the durable interrupt lifecycle.
    const request = getTurnInterruptRequest(requestId);
    if (!request || request.status !== 'requested') {
      this.stopInterruptControl(requestId);
      return;
    }
    const active = getActiveConversationTurn(session.id);
    if (!active || active.id !== targetTurnId) {
      throw new Error('target turn ended before native interruption could be attempted');
    }
    if (!runtime || this.runtimeSessionId !== session.id || this.disposed) {
      throw new Error('target runtime is unavailable');
    }

    const acceptance = await Promise.race([
      runtime.interrupt().then(
        () => ({ kind: 'accepted' as const }),
        (error: unknown) => ({ kind: 'error' as const, error }),
      ),
      control.stopped.then(() => ({ kind: 'stopped' as const })),
    ]);
    if (acceptance.kind === 'stopped') return;
    if (acceptance.kind === 'error') throw acceptance.error;
    // Native acceptance is not confirmation. Keep the watchdog armed until
    // the exact turn terminal settles the request or the bound expires.
  }

  private failInterruptRequest(
    requestId: string,
    failure: { code: string; message: string },
  ): boolean {
    this.stopInterruptControl(requestId);
    if (!failConversationInterrupt(requestId, failure)) return false;
    this.publishCommittedEvents();
    this.broadcast(this.orchestratorStateFrame());
    return true;
  }

  /** A timed-out session-global native interrupt may complete late and hit a
   * successor turn. Detach and dispose that runtime, then gate re-minting on
   * disposal so the uncertain side effect cannot cross the turn boundary. */
  private quarantineRuntime(sessionId: string, targetTurnId: string): void {
    if (this.runtimeSessionId !== sessionId) return;
    this.invalidateRuntimeObservationFence();
    const runtime = this.runtime;
    this.runtime = null;
    this.runtimeSessionId = null;
    this.runtimeRev = null;
    if (this.runtimeReady?.turnId === targetTurnId) this.runtimeReady = null;
    if (!runtime) return;
    const prior = this.runtimeQuarantine;
    this.runtimeQuarantine = Promise.all([
      prior,
      runtime.dispose().catch(() => {}),
    ]).then(() => {});
  }

  private stopInterruptControl(requestId: string): void {
    const control = this.interruptControls.get(requestId);
    if (!control) return;
    this.interruptControls.delete(requestId);
    control.stop();
  }

  private stopSettledInterruptControls(turnId: string): void {
    for (const requestId of [...this.interruptControls.keys()]) {
      const request = getTurnInterruptRequest(requestId);
      if (request?.targetTurnId === turnId && request.status !== 'requested') {
        // A non-abort terminal can win while the session-global native
        // interrupt promise is still pending. Quarantine before the queue can
        // mint/send a successor so a late side effect cannot cross turns.
        if (request.status === 'failed') {
          this.quarantineRuntime(request.sessionId, turnId);
        }
        this.stopInterruptControl(requestId);
      }
    }
  }

  handleAskReply(askId: string, answer: string): boolean {
    return this.askRegistry.reply(askId, answer);
  }

  private afterQueueCommand(result: ConversationCommandResult, shouldKick: boolean): void {
    if (result.status !== 'rejected') {
      this.publishCommittedEvents();
      if (shouldKick && this.queueDrainEnabled) this.sendQueue.kick();
    }
    this.broadcast(this.orchestratorStateFrame());
  }

  // ── session lifecycle ──────────────────────────────────────────────────────

  async ensureActiveSession(): Promise<OrchestratorSessionRow> {
    if (this.disposed) throw new Error('session service is disposed');
    if (this.session) return this.session;
    return this.withSessionTransition(async () => {
      if (this.disposed) throw new Error('session service is disposed');
      if (this.session) return this.session;
      return this.replaceSession('new session started');
    });
  }

  canSwitchSession(): boolean {
    return !this.session || getActiveConversationTurn(this.session.id) === null;
  }

  async startNewSession(): Promise<OrchestratorSessionRow> {
    return this.withSessionTransition(() => this.replaceSession('new session started'));
  }

  /** Account default + a newly stamped session boundary are one DB transition.
   * Prior stamped sessions retain their original account and remain eligible
   * for separately preflighted historical resume. A same-runtime account
   * change is never a native resume — each account is an isolated credential
   * home (docs/agent-runtime-architecture.md "Sessions and switching") — so
   * when the prior session has a replayable transcript this instead performs
   * an app-owned context handoff into a fresh native session under the new
   * account. A prior session with nothing to hand off (no replayable
   * transcript) falls back to today's clean mint plus a visible notice. */
  async switchAccountSession(accountId: string): Promise<OrchestratorSessionRow> {
    return this.withSessionTransition(() => this.switchAccountSessionUnserialized(accountId));
  }

  private async switchAccountSessionUnserialized(accountId: string): Promise<OrchestratorSessionRow> {
    const prior = this.session;
    const selection = await this.resolveReplacementSelection({ accountId });
    if (prior) {
      const handed = await this.handoffAcrossAccount(prior, selection, { defaultAccountId: accountId });
      if (handed) return handed;
    }
    const session = await this.commitSessionReplacement('account switched', { accountId }, selection);
    if (prior) this.emitContinuationUnavailableNotice(session);
    return session;
  }

  /** App-owned context handoff for a same-runtime account change (docs/agent-
   * runtime-architecture.md "Sessions and switching"). Each account is an
   * isolated credential home, so the prior native session id can never carry
   * over: this always mints a fresh native session under the new account,
   * durably marked to compile and inject the prior session's transcript as
   * `seedContext` on its first delivered turn (see ensureRuntime below).
   * Returns null (no side effect) when the prior session has no replayable
   * transcript to hand off — callers fall back to a clean mint + notice. */
  private async handoffAcrossAccount(
    prior: OrchestratorSessionRow,
    selection: RuntimeSelection,
    settingsPatch: Record<string, unknown>,
  ): Promise<OrchestratorSessionRow | null> {
    if (!hasReplayableTranscript(prior.id)) return null;
    if (!this.canSwitchSession()) throw new RuntimeSelectionRejectedError('session-active');
    const handoff = handoffOrchestratorSession({
      projectId: this.projectId,
      expectedSessionId: prior.id,
      selection,
      queueCancellationReason: 'account switched',
      settingsPatch,
    });
    if (!handoff) return null;
    this.publishCommittedEvents();
    this.teardownRunner('new-session');
    this.session = handoff.session;
    this.broadcast(this.sessionChangedFrame('new-session'));
    this.emitAccountHandoffNotice(handoff.session, selection.accountId);
    this.broadcast(this.orchestratorStateFrame());
    return this.session;
  }

  /** A provider-neutral, visible chat notice on every successful cross-
   * account handoff — the reduced-fidelity counterpart of a native resume's
   * silent continuity. Never provider-branched copy. */
  private emitAccountHandoffNotice(session: OrchestratorSessionRow, toAccountId: string): void {
    const event: ChatEvent = {
      kind: 'system',
      subtype: 'account-handoff',
      level: 'notice',
      message: `Switched to ${toAccountId} — continuing this conversation in a fresh session `
        + 'seeded with its history (reduced fidelity).',
    };
    commitConversationEvent({
      projectId: session.projectId,
      conversationId: session.id,
      sessionId: session.id,
      family: conversationFamilyForEvent(event),
      event,
      turnId: null,
      itemId: newId(),
      clientMessageId: null,
      occurredAt: Date.now(),
      deliveryKind: 'chat',
    });
    this.publishCommittedEvents();
  }

  /** Runtime default + a newly stamped session boundary are one DB transition.
   * A runtime change re-resolves the account fresh for the new runtime (an old
   * runtime's account id is not reused across runtimes — docs/agent-runtime-
   * architecture.md "Sessions and switching"). Prior stamped sessions retain
   * their original runtime/account and remain eligible for separately
   * preflighted historical resume through their own adapter. */
  async switchRuntimeSession(runtimeId: string): Promise<OrchestratorSessionRow> {
    return this.withSessionTransition(() => this.replaceSession('runtime switched', { runtimeId }));
  }

  /** Header model/effort (and optionally account/runtime) change + a newly
   * stamped session boundary, one DB transition. A stamped session's
   * selection is immutable once minted (orchestrator-sessions.ts), so even a
   * same-runtime, same-account model/effort-only change cannot be applied to
   * the live row in place — it always mints a new row. When the change is
   * PURELY model/effort (no account/runtime change) and the prior row is a
   * resume-ready bound native session, this native-continues that thread into
   * the new row instead of starting clean, gated on a positive adapter
   * `continuationAcrossSelectionChange` capability/preflight (docs/agent-
   * runtime-architecture.md "Sessions and switching"). Any other case —
   * capability missing, prior unbound, or preflight failure — falls back to
   * today's clean mint plus a visible provider-neutral system notice. Account
   * or runtime changes are untouched: they always mint clean, exactly like
   * switchRuntimeSession/switchAccountSession above.
   */
  async changeSelection(input: {
    runtimeId?: string;
    accountId?: string;
    model?: string;
    effort?: string | null;
  }): Promise<OrchestratorSessionRow> {
    return this.withSessionTransition(() => this.changeSelectionUnserialized(input));
  }

  private async changeSelectionUnserialized(input: {
    runtimeId?: string;
    accountId?: string;
    model?: string;
    effort?: string | null;
  }): Promise<OrchestratorSessionRow> {
    const prior = this.session;
    const selection = await this.resolveReplacementSelection(input);
    const isPureSelectionChange = input.runtimeId === undefined && input.accountId === undefined;
    const isAccountOnlyChange = input.runtimeId === undefined && input.accountId !== undefined;

    if (isPureSelectionChange && prior) {
      const continued = await this.tryContinueAcrossSelection(prior, selection);
      if (continued) return continued;
      const session = await this.commitSessionReplacement('selection changed', input, selection);
      this.emitContinuationUnavailableNotice(session);
      return session;
    }
    if (isAccountOnlyChange && prior) {
      const handed = await this.handoffAcrossAccount(
        prior,
        selection,
        { defaultAccountId: input.accountId! },
      );
      if (handed) return handed;
      const session = await this.commitSessionReplacement('selection changed', input, selection);
      this.emitContinuationUnavailableNotice(session);
      return session;
    }
    return this.commitSessionReplacement('selection changed', input, selection);
  }

  /** Native-continue `prior`'s bound thread into a fresh row stamped with
   * `selection`, iff the prior row is resume-ready and the adapter positively
   * confirms `continuationAcrossSelectionChange` for this exact resume.
   * Returns null (no side effect) for any ineligibility or preflight
   * rejection — callers fall back to a clean mint. */
  private async tryContinueAcrossSelection(
    prior: OrchestratorSessionRow,
    selection: RuntimeSelection,
  ): Promise<OrchestratorSessionRow | null> {
    // Re-fetch fresh: a receipt binding the prior row's native identity may
    // have committed to the DB without (yet, or ever, in a defensive sense)
    // refreshing this cached `this.session` copy — resumeSessionUnserialized
    // re-fetches for the same reason.
    const freshPrior = getOrchestratorSession(prior.id);
    const priorSelection = freshPrior && runtimeSelectionForSession(freshPrior);
    if (
      !freshPrior ||
      !priorSelection ||
      priorSelection.runtimeId !== selection.runtimeId ||
      priorSelection.accountId !== selection.accountId ||
      !isOrchestratorSessionResumeReady(freshPrior)
    ) return null;
    const generation = this.lifecycleGeneration;
    const preflight = await this.preflightRuntimeSession(selection, {
      mode: 'resume',
      nativeSessionId: freshPrior.nativeSessionId!,
      acrossSelectionChange: true,
    });
    if (this.disposed || generation !== this.lifecycleGeneration) {
      throw new Error('session service was disposed during selection resolution');
    }
    if (preflight.status === 'invalid') return null;
    if (!this.canSwitchSession()) throw new RuntimeSelectionRejectedError('session-active');
    const continued = continueOrchestratorSessionAcrossSelection({
      projectId: this.projectId,
      expectedSessionId: freshPrior.id,
      selection,
      queueCancellationReason: 'selection changed',
    });
    if (!continued) return null;
    this.publishCommittedEvents();
    this.teardownRunner('new-session');
    this.session = continued.session;
    this.broadcast(this.sessionChangedFrame('new-session'));
    this.broadcast(this.orchestratorStateFrame());
    return this.session;
  }

  /** A provider-neutral, visible chat notice — never provider-branched copy —
   * for a selection change that could not native-continue the prior thread. */
  private emitContinuationUnavailableNotice(session: OrchestratorSessionRow): void {
    const event: ChatEvent = {
      kind: 'system',
      subtype: 'selection-change-continuation-unavailable',
      level: 'notice',
      message: "Couldn't continue the conversation — started a fresh session.",
    };
    commitConversationEvent({
      projectId: session.projectId,
      conversationId: session.id,
      sessionId: session.id,
      family: conversationFamilyForEvent(event),
      event,
      turnId: null,
      itemId: newId(),
      clientMessageId: null,
      occurredAt: Date.now(),
      deliveryKind: 'chat',
    });
    this.publishCommittedEvents();
  }

  private async resolveReplacementSelection(options: {
    accountId?: string;
    runtimeId?: string;
    model?: string;
    effort?: string | null;
  }): Promise<RuntimeSelection> {
    const { accountId, runtimeId, model, effort } = options;
    if (this.disposed) throw new Error('session service is disposed');
    const generation = this.lifecycleGeneration;
    const resolved = await this.resolveNewSessionSelection({
      projectId: this.projectId,
      ...(accountId ? { accountId } : {}),
      ...(runtimeId ? { runtimeId } : {}),
      ...(model !== undefined ? { model } : {}),
      ...(effort !== undefined ? { effort } : {}),
    });
    if (this.disposed || generation !== this.lifecycleGeneration) {
      throw new Error('session service was disposed during selection resolution');
    }
    if (resolved.status === 'invalid') throw new RuntimeSelectionRejectedError(resolved.code);
    if (accountId !== undefined && resolved.selection.accountId !== accountId) {
      throw new RuntimeSelectionRejectedError('account-runtime-mismatch');
    }
    if (runtimeId !== undefined && resolved.selection.runtimeId !== runtimeId) {
      throw new RuntimeSelectionRejectedError('runtime-not-registered');
    }
    if (model !== undefined && resolved.selection.model !== model) {
      throw new RuntimeSelectionRejectedError('model-unsupported');
    }
    if (effort !== undefined && !effortMatchesRequest(effort, resolved.selection.effort)) {
      throw new RuntimeSelectionRejectedError('effort-value-unsupported');
    }
    return resolved.selection;
  }

  private async commitSessionReplacement(
    reason: string,
    options: {
      accountId?: string;
      runtimeId?: string;
      model?: string;
      effort?: string | null;
    },
    selection: RuntimeSelection,
  ): Promise<OrchestratorSessionRow> {
    const { accountId, runtimeId, model, effort } = options;
    if (!this.canSwitchSession()) throw new RuntimeSelectionRejectedError('session-active');
    const replacement = replaceOrchestratorSession({
      projectId: this.projectId,
      expectedSessionId: this.session?.id ?? null,
      selection,
      queueCancellationReason: reason,
      ...(accountId !== undefined
        ? {
            endedReason: 'account_switched' as const,
            settingsPatch: { defaultAccountId: accountId },
          }
        : runtimeId !== undefined
        ? {
            endedReason: 'runtime_switched' as const,
            settingsPatch: { defaultRuntimeId: runtimeId },
          }
        : (model !== undefined || effort !== undefined)
        ? { endedReason: 'selection_changed' as const }
        : {}),
    });
    this.publishCommittedEvents();
    this.teardownRunner('new-session');
    this.session = replacement.session;
    this.broadcast(this.sessionChangedFrame('new-session'));
    this.broadcast(this.orchestratorStateFrame());
    return this.session;
  }

  private async replaceSession(
    reason: string,
    options: {
      accountId?: string;
      runtimeId?: string;
      model?: string;
      effort?: string | null;
    } = {},
  ): Promise<OrchestratorSessionRow> {
    const selection = await this.resolveReplacementSelection(options);
    return this.commitSessionReplacement(reason, options, selection);
  }

  async resumeSession(sessionId: ULID): Promise<OrchestratorSessionRow | null> {
    return this.withSessionTransition(() => this.resumeSessionUnserialized(sessionId));
  }

  private async resumeSessionUnserialized(sessionId: ULID): Promise<OrchestratorSessionRow | null> {
    if (this.disposed) throw new Error('session service is disposed');
    const generation = this.lifecycleGeneration;
    const target = getOrchestratorSession(sessionId);
    if (!target || target.projectId !== this.projectId) return null;
    if (this.session?.id === sessionId) {
      this.broadcast(this.sessionChangedFrame('resume-session'));
      this.broadcast(this.orchestratorStateFrame());
      this.broadcast(this.sessionReplayFrame());
      this.broadcast(this.sendQueueSnapshotFrame());
      for (const ask of this.askRegistry.snapshot()) this.broadcast(ask);
      return this.session;
    }
    const selection = runtimeSelectionForSession(target);
    const staticError = this.staticResumeError(target, selection);
    if (staticError) throw new RuntimeSelectionRejectedError(staticError);
    const continuation = { mode: 'resume' as const, nativeSessionId: target.nativeSessionId! };
    const preflight = await this.preflightRuntimeSession(selection!, continuation);
    if (this.disposed || generation !== this.lifecycleGeneration) {
      throw new Error('session service was disposed during resume preflight');
    }
    if (preflight.status === 'invalid') throw new RuntimeSelectionRejectedError(preflight.code);
    if (!this.canSwitchSession()) throw new RuntimeSelectionRejectedError('session-active');
    const resumed = resumeOrchestratorSessionTransition({
      projectId: this.projectId,
      expectedSessionId: this.session?.id ?? null,
      targetSessionId: sessionId,
      queueCancellationReason: 'another session was resumed',
    });
    if (!resumed) return null;
    this.publishCommittedEvents();
    this.teardownRunner('resume-session');
    this.session = resumed.session;
    this.broadcast(this.sessionChangedFrame('resume-session'));
    this.broadcast(this.orchestratorStateFrame());
    this.broadcast(this.sessionReplayFrame());
    if (this.queueDrainEnabled) this.sendQueue.kick();
    return this.session;
  }

  private async withSessionTransition<T>(operation: () => Promise<T>): Promise<T> {
    const prior = this.sessionTransitionTail;
    let release!: () => void;
    this.sessionTransitionTail = new Promise<void>((resolve) => {
      release = resolve;
    });
    await prior;
    try {
      return await operation();
    } finally {
      release();
    }
  }

  activeRuntimeSelection(): RuntimeSelection | null {
    return this.session ? runtimeSelectionForSession(this.session) : null;
  }

  async resumeAvailabilityCode(
    session: OrchestratorSessionRow,
    preflightCache?: Map<string, Promise<RuntimeSelectionValidation>>,
  ): Promise<RuntimeSelectionErrorCode | null> {
    const selection = runtimeSelectionForSession(session);
    const staticError = this.staticResumeError(session, selection);
    if (staticError) return staticError;
    const key = runtimeSelectionCacheKey(selection!);
    let pending = preflightCache?.get(key);
    if (!pending) {
      pending = this.preflightRuntimeSession(selection!, {
        mode: 'resume',
        nativeSessionId: session.nativeSessionId!,
      });
      preflightCache?.set(key, pending);
    }
    const validation = await pending;
    return validation.status === 'invalid' ? validation.code : null;
  }

  private staticResumeError(
    session: OrchestratorSessionRow,
    selection: RuntimeSelection | null,
  ): RuntimeSelectionErrorCode | null {
    if (session.status === 'active') return 'session-active';
    const repositoryIdentityError = this.repositoryIdentityResumeError();
    if (repositoryIdentityError) return repositoryIdentityError;
    if (!selection) return 'selection-unavailable';
    if (
      session.nativeIdentityState !== 'bound' ||
      typeof session.nativeSessionId !== 'string' ||
      session.nativeSessionId.trim().length === 0
    ) return 'native-session-missing';
    if (session.continuationState === 'resume-failed') return 'resume-failed';
    return null;
  }

  private repositoryIdentityResumeError(): RuntimeSelectionErrorCode | null {
    const project = getProjectById(this.projectId);
    return project?.folderPath && !project.repositoryIdentity
      ? 'repository-identity-unavailable'
      : null;
  }

  private teardownRunner(reason: string): void {
    this.askRegistry.clear(reason);
    this.invalidateRuntimeObservationFence();
    const runtime = this.runtime;
    this.runtime = null;
    this.runtimeSessionId = null;
    this.runtimeReady = null;
    this.setHealth('idle');
    if (runtime) {
      const prior = this.runtimeQuarantine;
      this.runtimeQuarantine = Promise.all([
        prior,
        runtime.dispose().catch(() => {}),
      ]).then(() => {});
    }
  }

  async dispose(): Promise<void> {
    if (this.disposed) return;
    this.disposed = true;
    this.lifecycleGeneration += 1;
    this.resolveDisposed();
    this.invalidateRuntimeObservationFence();
    // Fail pending requests before disposing the runtime. Runtime teardown can
    // itself yield an abort terminal; it must never manufacture a positive
    // receipt for a user interrupt whose native outcome remained uncertain.
    for (const requestId of [...this.interruptControls.keys()]) {
      this.failInterruptRequest(requestId, {
        code: 'runtime-interrupt-inconclusive',
        message: 'session service shut down before a correlated interrupt terminal; outcome is inconclusive',
      });
    }
    const drainDone = this.sendQueue.dispose();
    this.askRegistry.clear('server shutdown');
    const runtime = this.runtime;
    this.runtime = null;
    this.runtimeSessionId = null;
    this.runtimeReady = null;
    if (runtime) await runtime.dispose();
    await this.runtimeQuarantine;
    await drainDone;
  }

  // ── claimed turn delivery ──────────────────────────────────────────────────

  private async ensureRuntime(session: OrchestratorSessionRow): Promise<RuntimeAcquisition> {
    if (this.disposed) throw new Error('session service is disposed');
    const generation = this.lifecycleGeneration;
    await this.runtimeQuarantine;
    if (this.disposed || generation !== this.lifecycleGeneration) {
      throw new Error('session service was disposed during runtime quarantine');
    }
    const rev = this.orchestratorRev?.() ?? null;
    if (this.runtime && this.runtimeSessionId === session.id) {
      if (rev === null || rev === this.runtimeRev) {
        return {
          runtime: this.runtime,
          receiptRequired: false,
          receiptConfirmed: true,
          receiptFailureSuppressed: false,
          continuationAttemptId: null,
          continuation: null,
        };
      }
      const old = this.runtime;
      this.invalidateRuntimeObservationFence();
      this.runtime = null;
      this.runtimeSessionId = null;
      await old.dispose().catch(() => {});
    } else if (this.runtime) {
      const old = this.runtime;
      this.invalidateRuntimeObservationFence();
      this.runtime = null;
      this.runtimeSessionId = null;
      await old.dispose().catch(() => {});
    }
    if (this.disposed || generation !== this.lifecycleGeneration) {
      throw new Error('session service was disposed during runtime replacement');
    }
    if (
      session.nativeIdentityState === 'bound' &&
      typeof session.nativeSessionId === 'string' &&
      session.nativeSessionId.trim().length > 0
    ) {
      const repositoryIdentityError = this.repositoryIdentityResumeError();
      if (repositoryIdentityError) {
        // A migrated session without a durable repository binding has no
        // authority to attempt native resume. Refuse before preflight or the
        // `resume-pending` transition so unavailability is not misreported as
        // a provider resume failure.
        throw new RuntimeSelectionRejectedError(repositoryIdentityError);
      }
    }
    this.setHealth('starting');
    this.broadcast(this.orchestratorStateFrame());
    const selection = runtimeSelectionForSession(session);
    if (!selection) throw new RuntimeSelectionRejectedError('selection-unavailable');
    let continuation: RuntimeContinuationRequest;
    let continuationAttemptId: string;
    if (
      session.nativeIdentityState === 'bound' &&
      typeof session.nativeSessionId === 'string' &&
      session.nativeSessionId.trim().length > 0
    ) {
      continuation = { mode: 'resume', nativeSessionId: session.nativeSessionId };
      const validation = await this.preflightRuntimeSession(selection, continuation);
      if (this.disposed || generation !== this.lifecycleGeneration) {
        throw new Error('session service was disposed during runtime resume preflight');
      }
      if (validation.status === 'invalid') {
        if (session.continuationState === 'resume-pending') {
          this.markRuntimeResumeFailed(session, session.continuationAttemptId);
        }
        throw new RuntimeSelectionRejectedError(validation.code);
      }
      const prepared = prepareRuntimeSessionResume(session.id);
      if (!prepared || !prepared.continuationAttemptId) {
        throw new RuntimeSelectionRejectedError('resume-failed');
      }
      Object.assign(session, prepared);
      if (this.session?.id === session.id) this.session = prepared;
      continuationAttemptId = prepared.continuationAttemptId;
    } else if (
      session.nativeIdentityState === 'unbound' &&
      session.nativeSessionId === null &&
      session.continuationState === 'clean-pending'
    ) {
      continuation = { mode: 'create' };
      const prepared = prepareRuntimeSessionCreate(session.id);
      if (!prepared || !prepared.continuationAttemptId) {
        throw new RuntimeSelectionRejectedError('selection-unavailable');
      }
      Object.assign(session, prepared);
      if (this.session?.id === session.id) this.session = prepared;
      continuationAttemptId = prepared.continuationAttemptId;
    } else {
      throw new RuntimeSelectionRejectedError('native-session-missing');
    }
    // Phase 2 app-owned cross-account handoff: an unconsumed marker on a
    // freshly created (never resumed) native session means the first
    // delivered turn must compile and inject the source session's transcript
    // as seedContext. The marker itself is cleared only once the adapter
    // positively confirms the create receipt (onRuntimeSessionReceipt below)
    // — a mint that never binds must retry the exact same seed.
    let seedContext: string | undefined;
    if (
      continuation.mode === 'create' &&
      session.pendingHandoffSeed &&
      typeof session.sourceSessionId === 'string' &&
      session.sourceSessionId.trim().length > 0
    ) {
      const sourceSession = getOrchestratorSession(session.sourceSessionId);
      const compiled = compileHandoffSeedContext({
        sourceSessionId: session.sourceSessionId,
        fromAccountId: sourceSession?.accountId ?? 'unknown',
        toAccountId: selection.accountId,
      });
      if (compiled) seedContext = compiled.seedContext;
    }
    let runtime: RuntimeSession;
    try {
      runtime = await this.mintSession({
        projectId: this.projectId,
        appSessionId: session.id,
        continuationAttemptId,
        selection,
        continuation,
        ...(seedContext ? { seedContext } : {}),
        cwd: this.cwd,
        ask: this.askRegistry.ask,
      });
    } catch (error) {
      if (continuation.mode === 'resume') {
        this.markRuntimeResumeFailed(session, continuationAttemptId);
      }
      throw error;
    }
    if (this.disposed || generation !== this.lifecycleGeneration) {
      await runtime.dispose().catch(() => {});
      if (continuation.mode === 'resume') {
        this.markRuntimeResumeFailed(session, continuationAttemptId);
      }
      throw new Error('session service was disposed during runtime startup');
    }
    this.runtime = runtime;
    this.runtimeSessionId = session.id;
    this.runtimeRev = rev;
    return {
      runtime,
      receiptRequired: true,
      receiptConfirmed: false,
      receiptFailureSuppressed: false,
      continuationAttemptId,
      continuation,
    };
  }

  private async deliver(turn: ClaimedConversationTurn): Promise<void> {
    const session = getOrchestratorSession(turn.sessionId as ULID);
    if (!session || session.projectId !== turn.projectId) {
      this.settleInfrastructureFailure(turn, 'claimed turn session is unavailable');
      return;
    }
    if (!session.title && turn.origin === 'user') {
      const title = deriveTitle(turn.text);
      if (title) {
        setOrchestratorSessionTitle(session.id, title);
        session.title = title;
        if (this.session?.id === session.id) this.session.title = title;
      }
    }

    let runtimeAccepted = false;
    let runtimeAcquired = false;
    let terminalSettled = false;
    let idlePublished = false;
    let acquisition: RuntimeAcquisition | null = null;
    const ready = this.ensureRuntime(session);
    this.runtimeReady = { sessionId: session.id, turnId: turn.turnId, promise: ready };
    try {
      const outcome = await Promise.race([
        ready.then((value) => ({ value })),
        this.disposedSignal.then(() => null),
      ]);
      if (!outcome) {
        // ensureRuntime fences and disposes a late runtime. Consume a later
        // rejection after the queue drain has been released by shutdown.
        void ready.catch(() => {});
        return;
      }
      acquisition = outcome.value;
      const runtime = acquisition.runtime;
      runtimeAcquired = true;
      if (this.disposed) return;
      this.setHealth('busy');
      this.broadcast(this.orchestratorStateFrame());
      const stream = runtime.sendTurn(turn.text);
      runtimeAccepted = true;
      this.persistAndPublish(turn, {
        kind: 'activity-state',
        phase: 'requesting-runtime',
      }, { itemId: newId() });
      await runTurn(stream, this.turnDeps(turn, session, acquisition, () => {
        terminalSettled = true;
      }));
      if (!terminalSettled) {
        this.settleInfrastructureFailure(turn, 'runtime ended without a durable terminal', runtimeAccepted);
      } else {
        // Product state settles first. Context is best-effort telemetry and
        // must never keep the orchestrator looking busy after its terminal is
        // already durable, though the FIFO successor remains held until the
        // bounded observation resolves.
        this.setHealth('idle');
        this.broadcast(this.orchestratorStateFrame());
        idlePublished = true;
        await this.observeContextAfterTurn(turn, session, acquisition);
      }
    } catch (error) {
      if (
        acquisition?.continuation?.mode === 'resume' &&
        acquisition.receiptRequired &&
        !acquisition.receiptConfirmed
      ) {
        this.markRuntimeResumeFailed(session, acquisition.continuationAttemptId);
      }
      if (!terminalSettled) {
        // A typed app-authored `.code` (e.g. from CodexRuntimeAdapterError) is
        // app vocabulary, not provider text, so it rides along in parentheses
        // to give the user something actionable. The thrown error's own
        // `.providerDetail` — already bounded + secret-scrubbed at its capture
        // seam — rides separately as diagnostic-only detail, never woven into
        // this app-authored message.
        this.settleInfrastructureFailure(
          turn,
          infrastructureFailureMessage(
            runtimeAccepted ? 'runtime delivery failed' : 'runtime failed to start',
            error,
          ),
          runtimeAccepted,
          runtimeAcquired,
          providerDetailFromError(error),
        );
      }
    } finally {
      if (this.runtimeReady?.turnId === turn.turnId) this.runtimeReady = null;
      if (!this.disposed && !idlePublished) {
        this.setHealth('idle');
        this.broadcast(this.orchestratorStateFrame());
      }
    }
  }

  private async observeContextAfterTurn(
    turn: ClaimedConversationTurn,
    session: OrchestratorSessionRow,
    acquisition: RuntimeAcquisition,
  ): Promise<void> {
    const runtime = acquisition.runtime;
    const generation = this.lifecycleGeneration;
    const fence = this.runtimeObservationFence;
    if (
      this.disposed
      || !acquisition.receiptConfirmed
      || this.session?.id !== session.id
      || this.runtime !== runtime
      || this.runtimeSessionId !== session.id
    ) return;

    // Normalize synchronous throws and attach both handlers immediately so a
    // timed-out native promise can never become an unhandled late rejection.
    const pending: Promise<ContextObservationOutcome> = Promise.resolve()
      .then(() => runtime.observeContext())
      .then<ContextObservationOutcome, ContextObservationOutcome>(
        (value) => ({ kind: 'observed', value }),
        () => ({ kind: 'failed' }),
      );
    const outcome = await this.waitForContextObservationOutcome(pending, fence);

    // A session replacement, runtime re-mint/quarantine, or disposal makes a
    // late observation foreign to this turn. It writes nothing—not even an
    // unavailable event attributed to the wrong lifecycle.
    if (
      outcome.kind === 'invalidated'
      || this.disposed
      || generation !== this.lifecycleGeneration
      || this.runtimeObservationFence !== fence
      || this.session?.id !== session.id
      || this.runtime !== runtime
      || this.runtimeSessionId !== session.id
    ) return;

    const observedAt = Date.now();

    const captured = outcome.kind === 'observed'
      ? this.captureContextObservation(outcome.value)
      : null;
    let observation: ContextObservation;
    if (outcome.kind === 'timeout') {
      observation = { confidence: 'unavailable', reason: 'observation-timeout' };
    } else if (outcome.kind === 'failed') {
      observation = { confidence: 'unavailable', reason: 'runtime-unavailable' };
    } else if (captured) {
      observation = captured;
    } else {
      observation = { confidence: 'unavailable', reason: 'invalid-observation' };
    }

    await this.persistContextObservation(
      turn,
      session,
      runtime,
      fence,
      observation,
      observedAt,
    );
  }

  private captureContextObservation(value: unknown): ContextObservation | null {
    try {
      if (!isContextObservation(value)) return null;
      const snapshot: ContextObservation = value.confidence === 'unavailable'
        ? { confidence: 'unavailable', reason: value.reason }
        : {
            confidence: value.confidence,
            usedTokens: value.usedTokens,
            usableTokens: value.usableTokens,
            contextWindowTokens: value.contextWindowTokens,
          };
      return isContextObservation(snapshot) ? snapshot : null;
    } catch {
      return null;
    }
  }

  private waitForContextObservationOutcome(
    pending: Promise<ContextObservationOutcome>,
    fence: RuntimeObservationFence,
  ): Promise<ContextObservationOutcome> {
    return new Promise((resolve) => {
      let settled = false;
      let timer: ReturnType<typeof setTimeout> | null = null;
      const onInvalidated = () => finish({ kind: 'invalidated' });
      const finish = (outcome: ContextObservationOutcome) => {
        if (settled) return;
        settled = true;
        if (timer) clearTimeout(timer);
        fence.signal.removeEventListener('abort', onInvalidated);
        resolve(outcome);
      };
      fence.signal.addEventListener('abort', onInvalidated, { once: true });
      if (fence.signal.aborted) {
        finish({ kind: 'invalidated' });
        return;
      }
      timer = setTimeout(
        () => finish({ kind: 'timeout' }),
        this.contextObservationTimeoutMs,
      );
      if (typeof timer.unref === 'function') timer.unref();
      void pending.then(finish);
    });
  }

  private async persistContextObservation(
    turn: ClaimedConversationTurn,
    session: OrchestratorSessionRow,
    runtime: RuntimeSession,
    fence: RuntimeObservationFence,
    observation: ContextObservation,
    observedAt: number,
  ): Promise<void> {
    let retryMs = CONTEXT_PERSISTENCE_RETRY_START_MS;
    let persistenceFailureReported = false;
    for (;;) {
      if (!this.contextObservationFenceIsActive(session, runtime, fence)) return;
      try {
        this.persistAndPublish(turn, {
          kind: 'context-observation',
          ...observation,
        }, { itemId: newId(), occurredAt: observedAt });
        this.clearContextPersistenceFailure(persistenceFailureReported);
        return;
      } catch {
        // A duplicate means another exact writer already satisfied the durable
        // invariant. All other failures hold this session's queue and retry;
        // advancing would permanently lose the required post-terminal event.
        if (this.contextObservationAlreadyPersisted(turn)) {
          this.clearContextPersistenceFailure(persistenceFailureReported);
          return;
        }
        if (!persistenceFailureReported) {
          persistenceFailureReported = true;
          console.warn(`[pc-sdk][context] persistence unavailable for turn ${turn.turnId}; retrying`);
          if (this.contextObservationFenceIsActive(session, runtime, fence)) {
            this.health = 'failed';
            this.failureReason = CONTEXT_PERSISTENCE_FAILURE;
            this.broadcast(this.orchestratorStateFrame());
          }
        }
      }

      const retry = await this.waitForContextPersistenceRetry(fence, retryMs);
      if (!retry) return;
      retryMs = Math.min(retryMs * 2, CONTEXT_PERSISTENCE_RETRY_MAX_MS);
    }
  }

  private contextObservationFenceIsActive(
    session: OrchestratorSessionRow,
    runtime: RuntimeSession,
    fence: RuntimeObservationFence,
  ): boolean {
    return !this.disposed
      && this.runtimeObservationFence === fence
      && this.session?.id === session.id
      && this.runtime === runtime
      && this.runtimeSessionId === session.id;
  }

  private contextObservationAlreadyPersisted(turn: ClaimedConversationTurn): boolean {
    try {
      return hasConversationContextObservation({
        projectId: turn.projectId,
        conversationId: turn.conversationId,
        sessionId: turn.sessionId,
        turnId: turn.turnId,
      });
    } catch {
      return false;
    }
  }

  private async waitForContextPersistenceRetry(
    fence: RuntimeObservationFence,
    delayMs: number,
  ): Promise<boolean> {
    return new Promise((resolve) => {
      let settled = false;
      let timer: ReturnType<typeof setTimeout> | null = null;
      const onInvalidated = () => finish(false);
      const finish = (retry: boolean) => {
        if (settled) return;
        settled = true;
        if (timer) clearTimeout(timer);
        fence.signal.removeEventListener('abort', onInvalidated);
        resolve(retry);
      };
      fence.signal.addEventListener('abort', onInvalidated, { once: true });
      if (fence.signal.aborted) {
        finish(false);
        return;
      }
      timer = setTimeout(() => finish(true), delayMs);
    });
  }

  private clearContextPersistenceFailure(reported: boolean): void {
    if (
      reported
      && !this.disposed
      && this.health === 'failed'
      && this.failureReason === CONTEXT_PERSISTENCE_FAILURE
    ) {
      this.setHealth('idle');
      this.broadcast(this.orchestratorStateFrame());
    }
  }

  private invalidateRuntimeObservationFence(): void {
    const previous = this.runtimeObservationFence;
    previous.invalidate();
    this.runtimeObservationFence = createRuntimeObservationFence(previous.epoch + 1);
  }

  private markRuntimeResumeFailed(
    session: OrchestratorSessionRow,
    continuationAttemptId: string | null,
  ): void {
    if (!continuationAttemptId) return;
    if (!failRuntimeSessionResume(session.id, continuationAttemptId)) return;
    if (session.continuationAttemptId !== continuationAttemptId) return;
    session.continuationState = 'resume-failed';
    let currentUpdated = false;
    if (
      this.session?.id === session.id &&
      this.session.continuationAttemptId === continuationAttemptId
    ) {
      this.session.continuationState = 'resume-failed';
      currentUpdated = true;
    }
    if (currentUpdated) this.broadcastSessionUpdated();
  }

  private settleInfrastructureFailure(
    turn: ClaimedConversationTurn,
    message: string,
    runtimeAccepted = false,
    quarantineRuntime = runtimeAccepted,
    providerDetail?: string,
  ): void {
    this.askRegistry.clear('turn failed');
    if (quarantineRuntime) this.quarantineRuntime(turn.sessionId, turn.turnId);
    settleConversationTurn({
      turnId: turn.turnId,
      terminalEvent: {
        kind: 'turn-failed',
        error: message,
        source: 'internal',
        ...(providerDetail ? { providerDetail } : {}),
      },
      terminalOutcome: 'turn-failed',
      queueStatus: runtimeAccepted ? 'accepted' : 'failed',
      queueFailureReason: runtimeAccepted ? null : message,
    });
    this.stopSettledInterruptControls(turn.turnId);
    this.publishCommittedEvents();
  }

  private turnDeps(
    turn: ClaimedConversationTurn,
    session: OrchestratorSessionRow,
    acquisition: RuntimeAcquisition,
    onTerminal: () => void,
  ): TurnRunnerDeps {
    return {
      emitChat: (event, identity) => {
        if (event.kind === 'turn-end' || event.kind === 'turn-failed') {
          const terminalEvent = acquisition.receiptRequired && !acquisition.receiptConfirmed
            ? {
                kind: 'turn-failed' as const,
                error: 'runtime session start was not positively confirmed',
                source: 'internal' as const,
              }
            : event;
          if (terminalEvent !== event) {
            if (
              acquisition.continuation?.mode === 'resume' &&
              !acquisition.receiptFailureSuppressed
            ) {
              this.markRuntimeResumeFailed(session, acquisition.continuationAttemptId);
            }
            this.quarantineRuntime(session.id, turn.turnId);
          }
          const outcome = terminalEvent.kind === 'turn-end'
            ? 'completed'
            : terminalEvent.source === 'abort'
              ? 'aborted'
              : 'turn-failed';
          if (settleConversationTurn({
            turnId: turn.turnId,
            terminalEvent,
            terminalOutcome: outcome,
            queueStatus: 'accepted',
          })) {
            onTerminal();
            this.askRegistry.clear('turn ended');
            this.stopSettledInterruptControls(turn.turnId);
            this.publishCommittedEvents();
          }
          return;
        }
        this.persistAndPublish(turn, event, {
          itemId: identity?.itemId ?? newId(),
          streamId: identity?.streamId,
        });
        if (
          event.kind === 'tool-state' &&
          event.state === 'approval-needed' &&
          event.approval.status === 'pending'
        ) this.askRegistry.publish(event.approval.requestId);
      },
      emitDelta: (itemId, deltaIndex, delta) =>
        this.persistAndPublish(turn, { kind: 'stream-delta', delta }, {
          itemId,
          streamId: itemId,
          deltaIndex,
        }),
      onRuntimeSessionReceipt: (receipt) => {
        // Runtime disposal is not proof that a provider stream stopped. A
        // receipt emitted after the lifecycle fence is stale and must not bind
        // or advance durable native identity.
        if (
          this.disposed ||
          this.runtime !== acquisition.runtime ||
          this.runtimeSessionId !== session.id ||
          receipt.continuationAttemptId !== acquisition.continuationAttemptId
        ) {
          acquisition.receiptFailureSuppressed = true;
          throw new Error('runtime session receipt arrived outside its active attempt');
        }
        const confirmation = confirmRuntimeSessionReceipt({ sessionId: session.id, receipt });
        if (confirmation.status === 'rejected') {
          if (confirmation.reason === 'continuation-attempt-mismatch') {
            acquisition.receiptFailureSuppressed = true;
          }
          if (
            acquisition.continuation?.mode === 'resume' &&
            !acquisition.receiptFailureSuppressed
          ) {
            this.markRuntimeResumeFailed(session, acquisition.continuationAttemptId);
          }
          this.quarantineRuntime(session.id, turn.turnId);
          throw new Error(`runtime session receipt rejected: ${confirmation.reason}`);
        }
        acquisition.receiptConfirmed = true;
        let confirmedSession = confirmation.session;
        // The handoff-seed marker is consumed only once the create receipt
        // it seeded is positively confirmed — a mint that never binds must
        // retry with the exact same seed, never a silently unseeded one.
        if (receipt.mode === 'created' && confirmedSession.pendingHandoffSeed) {
          confirmedSession = clearPendingHandoffSeed(confirmedSession.id) ?? confirmedSession;
        }
        Object.assign(session, confirmedSession);
        if (this.session?.id === session.id) this.session = confirmedSession;
        if (!confirmation.duplicate) this.broadcastSessionUpdated();
      },
      onSubscriptionQuota: (batch) => {
        // Quota telemetry is non-critical, but it must still be attributed to
        // this exact positively attached runtime attempt before admission.
        const selection = runtimeSelectionForSession(session);
        if (
          this.disposed ||
          this.runtime !== acquisition.runtime ||
          this.runtimeSessionId !== session.id ||
          !acquisition.receiptConfirmed ||
          !selection ||
          batch.runtimeId !== selection.runtimeId ||
          batch.accountId !== selection.accountId
        ) {
          console.warn('[pc-sdk][subscription-quota] dropped unattributed orchestrator observation');
          return;
        }
        try {
          this.onSubscriptionQuota?.(batch);
        } catch {
          // Quota projection failure cannot turn a provider exchange into a
          // failed conversation turn. The DB/service layer logs its own gate.
          console.warn('[pc-sdk][subscription-quota] orchestrator observation was not recorded');
        }
      },
      onDropped: (reason, message) => {
        console.warn(`[pc-sdk][turn] dropped: ${reason}`, summarize(message));
      },
    };
  }

  // ── event/outbox publication ───────────────────────────────────────────────

  private persistAndPublish(
    turn: ClaimedConversationTurn,
    event: ConversationEvent,
    opts: { itemId: string; streamId?: string; deltaIndex?: number; occurredAt?: number },
  ): void {
    commitConversationEvent({
      projectId: turn.projectId,
      conversationId: turn.conversationId,
      sessionId: turn.sessionId,
      family: conversationFamilyForEvent(event),
      event,
      turnId: turn.turnId,
      itemId: opts.itemId,
      streamId: opts.streamId ?? null,
      deltaIndex: opts.deltaIndex ?? null,
      clientMessageId: null,
      occurredAt: opts.occurredAt ?? Date.now(),
      deliveryKind: 'chat',
    });
    this.publishCommittedEvents();
  }

  private publishCommittedEvents(): void {
    try {
      this.drainConversationOutbox();
    } catch (error) {
      this.onConversationRelayError(error);
    }
  }

  // ── frame builders ─────────────────────────────────────────────────────────

  private sessionSummary(): SessionSummary | null {
    const session = this.session;
    if (!session) return null;
    const selection = runtimeSelectionForSession(session);
    if (!selection) return null;
    return {
      id: session.id,
      projectId: session.projectId,
      selection,
      title: session.title,
      status: session.status === 'ended' ? 'ended' : 'active',
      nativeSessionIdPresent:
        typeof session.nativeSessionId === 'string' && session.nativeSessionId.trim().length > 0,
      continuationState: session.continuationState,
      resumeAvailability: { status: 'unavailable', code: 'session-active' },
      startedAt: session.startedAt,
      sourceSessionId: session.sourceSessionId,
    };
  }

  private sessionChangedFrame(transition: 'new-session' | 'resume-session'): SessionChangedFrame {
    return { type: 'session-changed', projectId: this.projectId, transition, session: this.sessionSummary() };
  }

  private broadcastSessionUpdated(): void {
    const session = this.sessionSummary();
    if (!session) return;
    const frame: SessionUpdatedFrame = {
      type: 'session-updated',
      projectId: this.projectId,
      session,
    };
    this.broadcast(frame);
  }

  private sessionReplayFrame(): SessionReplayFrame {
    const session = this.session!;
    const events = replayConversationEvents(session.id);
    return {
      type: 'session-replay',
      projectId: this.projectId,
      sessionId: session.id,
      highWaterSequence: Math.max(getConversationHighWaterSequence(session.id), events.at(-1)?.sequence ?? 0),
      events,
      priorTranscript: priorSessionTranscript(session),
    };
  }

  private orchestratorStateFrame(): OrchestratorStateFrame {
    const sessionId = this.session?.id ?? null;
    const active = sessionId ? getActiveConversationTurn(sessionId) : null;
    const queue = sessionId ? getConversationQueueSnapshot(sessionId) : { queueRevision: 0, items: [] };
    return {
      type: 'orchestrator-state',
      projectId: this.projectId,
      sessionId,
      activeTurnId: active?.id ?? null,
      health: active && this.health === 'idle' ? 'starting' : this.health,
      queueDepth: queue.items.filter((item) => item.status === 'queued').length,
      failureReason: this.failureReason,
    };
  }

  private sendQueueSnapshotFrame(): SendQueueSnapshotFrame {
    const session = this.session!;
    const snapshot = getConversationQueueSnapshot(session.id);
    return {
      type: 'send-queue-snapshot',
      projectId: this.projectId,
      sessionId: session.id,
      queueRevision: snapshot.queueRevision,
      items: snapshot.items,
    };
  }

  private setHealth(health: OrchestratorHealth): void {
    this.health = health;
    if (health !== 'failed') this.failureReason = null;
  }
}

/** Defense-in-depth: the resolver is trusted to honor an explicit effort
 * request, but (mirroring the accountId/runtimeId mismatch guards above) a
 * resolved selection that silently dropped it must still fail closed rather
 * than mint a session under a selection the caller never asked for. */
function effortMatchesRequest(requested: string | null, effort: RuntimeSelection['effort']): boolean {
  return requested === null
    ? effort.kind !== 'selected'
    : effort.kind === 'selected' && effort.value === requested;
}

function runtimeSelectionCacheKey(selection: RuntimeSelection): string {
  return JSON.stringify([
    selection.runtimeId,
    selection.accountId,
    selection.model,
    selection.effort.kind,
    selection.effort.kind === 'selected' ? selection.effort.value : null,
  ]);
}

const TYPED_ERROR_CODE_PATTERN = /^[a-z0-9-]+$/;

/** Typed app-authored errors (CodexRuntimeAdapterError, RuntimeSelectionRejectedError,
 *  AccountUnavailableError, RepositoryLeaseError, ...) expose a stable `.code`
 *  vocabulary word. That code is app vocabulary, not provider free text, so it
 *  is safe to surface; the strict pattern keeps a raw provider message from
 *  ever being mistaken for one. */
export function typedErrorCode(error: unknown): string | null {
  if (typeof error !== 'object' || error === null) return null;
  const code = (error as { code?: unknown }).code;
  return typeof code === 'string' && TYPED_ERROR_CODE_PATTERN.test(code) ? code : null;
}

export function infrastructureFailureMessage(baseMessage: string, error: unknown): string {
  const code = typedErrorCode(error);
  return code ? `${baseMessage} (${code})` : baseMessage;
}

/** A thrown error's own `.providerDetail` — already bounded + secret-scrubbed
 *  at the adapter capture seam that raised it (see @pc/utils scrubProviderDetail)
 *  — if it carries one. Never reads `.message` here: that would re-admit raw,
 *  unscrubbed native prose one layer removed from its scrub site. */
export function providerDetailFromError(error: unknown): string | undefined {
  if (typeof error !== 'object' || error === null) return undefined;
  const detail = (error as { providerDetail?: unknown }).providerDetail;
  return typeof detail === 'string' && detail.length > 0 ? detail : undefined;
}

function summarize(message: unknown): string {
  try {
    const value = typeof message === 'string' ? message : JSON.stringify(message);
    return value.length > 200 ? `${value.slice(0, 200)}…` : value;
  } catch {
    return '[unserializable]';
  }
}
