// SessionService — the orchestrator-chat engine for one project.
//
// Durable queue/turn state is owned by @pc/db. This service validates command
// session affinity, drives one claimed immutable revision through the runtime,
// and maps runtime events into the claimed conversation context.

import {
  commitConversationEvent,
  editQueuedConversationSend,
  enqueueConversationSend,
  failConversationInterrupt,
  getActiveConversationTurn,
  getActiveOrchestratorSession,
  getConversationHighWaterSequence,
  getConversationQueueSnapshot,
  getOrchestratorSession,
  getTurnInterruptRequest,
  newId,
  removeQueuedConversationSend,
  replaceOrchestratorSession,
  requestConversationInterrupt,
  resumeOrchestratorSessionTransition,
  settleConversationTurn,
  setOrchestratorSessionProvider,
  setOrchestratorSessionTitle,
  type ClaimedConversationTurn,
  type ConversationCommandResult,
  type OrchestratorSessionRow,
} from '@pc/db';
import {
  conversationFamilyForEvent,
  type AskFrame,
  type ChatEvent,
  type ConversationCommand,
  type ConversationEvent,
  type EditQueuedMessage,
  type InterruptAndSendMessage,
  type InterruptMessage,
  type OrchestratorHealth,
  type OrchestratorStateFrame,
  type QueuedAgentEnvelope,
  type RemoveQueuedMessage,
  type SendMessage,
  type SendQueueSnapshotFrame,
  type ServerFrame,
  type SessionChangedFrame,
  type SessionReplayFrame,
  type SessionSummary,
  type UsageSnapshot,
} from '@pc/contracts';
import type { ULID } from '@pc/domain';
import type { RuntimeSession, RuntimeSessionFactory } from '../runner/runtime.ts';
import { AskRegistry } from './ask-registry.ts';
import { replayConversationEvents } from './replay.ts';
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
  drainConversationOutbox?: () => void;
  onConversationRelayError?: (error: unknown) => void;
  cwd?: string;
  askTimeoutMs?: number;
  /** Upper bound for native interrupt acceptance plus its correlated terminal.
   * Timeout is a durable fail-closed/inconclusive outcome, never success. */
  interruptTimeoutMs?: number;
  /** Registry-owned boot gate. Direct service users default to ready. */
  queueDrainEnabled?: boolean;
  onRateLimit?: (snapshot: UsageSnapshot) => void;
  orchestratorRev?: () => number | null;
}

interface RuntimeReady {
  sessionId: string;
  turnId: string;
  promise: Promise<RuntimeSession>;
}

interface InterruptControl {
  stopped: Promise<void>;
  stop: () => void;
}

const DEFAULT_INTERRUPT_TIMEOUT_MS = 15_000;

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
  private readonly drainConversationOutbox: () => void;
  private readonly onConversationRelayError: (error: unknown) => void;
  private readonly cwd?: string;
  private readonly onRateLimit?: (snapshot: UsageSnapshot) => void;
  private readonly orchestratorRev?: () => number | null;
  private readonly interruptTimeoutMs: number;
  private queueDrainEnabled: boolean;

  private session: OrchestratorSessionRow | null;
  private runtime: RuntimeSession | null = null;
  private runtimeSessionId: string | null = null;
  private runtimeRev: number | null = null;
  private runtimeReady: RuntimeReady | null = null;
  private runtimeQuarantine: Promise<void> = Promise.resolve();
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
    this.drainConversationOutbox = deps.drainConversationOutbox ?? (() => {});
    this.onConversationRelayError = deps.onConversationRelayError ?? ((error) => {
      console.warn('[pc-sdk][conversation-relay] post-commit drain failed:', error);
    });
    this.cwd = deps.cwd;
    this.onRateLimit = deps.onRateLimit;
    this.orchestratorRev = deps.orchestratorRev;
    this.interruptTimeoutMs = deps.interruptTimeoutMs ?? DEFAULT_INTERRUPT_TIMEOUT_MS;
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
        this.failureReason = error instanceof Error ? error.message : String(error);
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
    }
    return frames;
  }

  /** Called by the registry at boot and after every queue-affecting command. */
  kick(): void {
    if (this.queueDrainEnabled) this.sendQueue.kick();
  }

  /** One-way composition readiness gate. Durable admission remains available
   * before this call, but no provider work may start. */
  enableQueueDrain(): void {
    if (this.queueDrainEnabled) return;
    this.queueDrainEnabled = true;
    this.sendQueue.kick();
  }

  // ── durable conversation commands ─────────────────────────────────────────

  async handleConversationCommand(command: ConversationCommand): Promise<ConversationCommandResult> {
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

  handleSend(command: SendMessage): ConversationCommandResult {
    let session = this.session;
    if (command.sessionId === null) {
      if (session) return sessionChanged(session.id);
      session = this.startNewSession();
    } else if (!session || session.id !== command.sessionId) {
      return sessionChanged(session?.id ?? null);
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

  injectAgentEnvelope(input: InjectAgentEnvelopeInput): ConversationCommandResult {
    const session = this.ensureActiveSession();
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
      .catch((error) => {
        this.failInterruptRequest(requestId, {
          code: 'runtime-interrupt-failed',
          message: error instanceof Error ? error.message : String(error),
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
      runtime = outcome.value;
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

  ensureActiveSession(): OrchestratorSessionRow {
    if (this.session) return this.session;
    return this.startNewSession();
  }

  canSwitchSession(): boolean {
    return !this.session || getActiveConversationTurn(this.session.id) === null;
  }

  startNewSession(): OrchestratorSessionRow {
    return this.replaceSession('new session started');
  }

  /** Account default + session boundary are one DB transition. Every prior
   * session is retained for replay but marked non-resumable because its native
   * account stamp does not exist yet. */
  switchAccountSession(accountId: string): OrchestratorSessionRow {
    return this.replaceSession('account switched', accountId);
  }

  private replaceSession(reason: string, accountId?: string): OrchestratorSessionRow {
    const replacement = replaceOrchestratorSession({
      projectId: this.projectId,
      expectedSessionId: this.session?.id ?? null,
      queueCancellationReason: reason,
      ...(accountId
        ? {
            endedReason: 'account_switched' as const,
            settingsPatch: { defaultAccountId: accountId },
            invalidatePriorSessions: true,
          }
        : {}),
    });
    this.publishCommittedEvents();
    this.teardownRunner('new-session');
    this.session = replacement.session;
    this.broadcast(this.sessionChangedFrame('new-session'));
    this.broadcast(this.orchestratorStateFrame());
    return this.session;
  }

  resumeSession(sessionId: ULID): OrchestratorSessionRow | null {
    const target = getOrchestratorSession(sessionId);
    if (
      !target || target.projectId !== this.projectId ||
      target.endedReason === 'account_switched'
    ) return null;
    if (this.session?.id === sessionId) {
      this.broadcast(this.sessionChangedFrame('resume-session'));
      this.broadcast(this.orchestratorStateFrame());
      this.broadcast(this.sessionReplayFrame());
      this.broadcast(this.sendQueueSnapshotFrame());
      return this.session;
    }
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

  private teardownRunner(reason: string): void {
    this.askRegistry.clear(reason);
    const runtime = this.runtime;
    this.runtime = null;
    this.runtimeSessionId = null;
    this.runtimeReady = null;
    this.setHealth('idle');
    if (runtime) void runtime.dispose().catch(() => {});
  }

  async dispose(): Promise<void> {
    if (this.disposed) return;
    this.disposed = true;
    this.lifecycleGeneration += 1;
    this.resolveDisposed();
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
    if (runtime) await runtime.dispose().catch(() => {});
    await this.runtimeQuarantine;
    await drainDone;
  }

  // ── claimed turn delivery ──────────────────────────────────────────────────

  private async ensureRuntime(session: OrchestratorSessionRow): Promise<RuntimeSession> {
    if (this.disposed) throw new Error('session service is disposed');
    const generation = this.lifecycleGeneration;
    await this.runtimeQuarantine;
    if (this.disposed || generation !== this.lifecycleGeneration) {
      throw new Error('session service was disposed during runtime quarantine');
    }
    const rev = this.orchestratorRev?.() ?? null;
    if (this.runtime && this.runtimeSessionId === session.id) {
      if (rev === null || rev === this.runtimeRev) return this.runtime;
      const old = this.runtime;
      this.runtime = null;
      this.runtimeSessionId = null;
      void old.dispose().catch(() => {});
    } else if (this.runtime) {
      const old = this.runtime;
      this.runtime = null;
      this.runtimeSessionId = null;
      void old.dispose().catch(() => {});
    }
    this.setHealth('starting');
    this.broadcast(this.orchestratorStateFrame());
    const resume = session.providerSessionId || undefined;
    const runtime = await this.mintSession({
      projectId: this.projectId,
      appSessionId: session.id,
      resumeNativeSessionId: resume,
      cwd: this.cwd,
      ask: this.askRegistry.ask,
    });
    if (this.disposed || generation !== this.lifecycleGeneration) {
      await runtime.dispose().catch(() => {});
      throw new Error('session service was disposed during runtime startup');
    }
    this.runtime = runtime;
    this.runtimeSessionId = session.id;
    this.runtimeRev = rev;
    return runtime;
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
    let terminalSettled = false;
    const ready = this.ensureRuntime(session);
    this.runtimeReady = { sessionId: session.id, turnId: turn.turnId, promise: ready };
    try {
      const outcome = await Promise.race([
        ready.then((runtime) => ({ runtime })),
        this.disposedSignal.then(() => null),
      ]);
      if (!outcome) {
        // ensureRuntime fences and disposes a late runtime. Consume a later
        // rejection after the queue drain has been released by shutdown.
        void ready.catch(() => {});
        return;
      }
      const runtime = outcome.runtime;
      if (this.disposed) return;
      this.setHealth('busy');
      this.broadcast(this.orchestratorStateFrame());
      const stream = runtime.sendTurn(turn.text);
      runtimeAccepted = true;
      await runTurn(stream, this.turnDeps(turn, session, () => {
        terminalSettled = true;
      }));
      if (!terminalSettled) {
        this.settleInfrastructureFailure(turn, 'runtime ended without a durable terminal', runtimeAccepted);
      }
    } catch (error) {
      if (!terminalSettled) {
        this.settleInfrastructureFailure(
          turn,
          error instanceof Error ? error.message : String(error),
          runtimeAccepted,
        );
      }
    } finally {
      if (this.runtimeReady?.turnId === turn.turnId) this.runtimeReady = null;
      if (!this.disposed) {
        this.setHealth('idle');
        this.broadcast(this.orchestratorStateFrame());
      }
    }
  }

  private settleInfrastructureFailure(
    turn: ClaimedConversationTurn,
    message: string,
    runtimeAccepted = false,
  ): void {
    settleConversationTurn({
      turnId: turn.turnId,
      terminalEvent: { kind: 'turn-failed', error: message, source: 'internal' },
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
    onTerminal: () => void,
  ): TurnRunnerDeps {
    return {
      emitChat: (event, identity) => {
        if (event.kind === 'turn-end' || event.kind === 'turn-failed') {
          const outcome = event.kind === 'turn-end'
            ? 'completed'
            : event.source === 'abort'
              ? 'aborted'
              : 'turn-failed';
          if (settleConversationTurn({
            turnId: turn.turnId,
            terminalEvent: event,
            terminalOutcome: outcome,
            queueStatus: 'accepted',
          })) {
            onTerminal();
            this.stopSettledInterruptControls(turn.turnId);
            this.publishCommittedEvents();
          }
          return;
        }
        this.persistAndPublish(turn, event, {
          itemId: identity?.itemId ?? newId(),
          streamId: identity?.streamId,
        });
      },
      emitDelta: (itemId, deltaIndex, delta) =>
        this.persistAndPublish(turn, { kind: 'stream-delta', delta }, {
          itemId,
          streamId: itemId,
          deltaIndex,
        }),
      onNativeSessionId: (id, model) => {
        if (session.providerSessionId === id) return;
        setOrchestratorSessionProvider(session.id, { providerSessionId: id, model });
        session.providerSessionId = id;
        session.model = model;
        if (this.session?.id === session.id) {
          this.session.providerSessionId = id;
          this.session.model = model;
        }
      },
      onRateLimit: (snapshot) => this.onRateLimit?.(snapshot),
      onDropped: (reason, message) => {
        console.warn(`[pc-sdk][turn] dropped: ${reason}`, summarize(message));
      },
    };
  }

  // ── event/outbox publication ───────────────────────────────────────────────

  private persistAndPublish(
    turn: ClaimedConversationTurn,
    event: ConversationEvent,
    opts: { itemId: string; streamId?: string; deltaIndex?: number },
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
      occurredAt: Date.now(),
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
    return {
      id: session.id,
      projectId: session.projectId,
      model: session.model,
      title: session.title,
      status: session.status === 'ended' ? 'ended' : 'active',
      resumable: session.status === 'ended' && session.endedReason !== 'account_switched',
      startedAt: session.startedAt,
    };
  }

  private sessionChangedFrame(transition: 'new-session' | 'resume-session'): SessionChangedFrame {
    return { type: 'session-changed', projectId: this.projectId, transition, session: this.sessionSummary() };
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

function summarize(message: unknown): string {
  try {
    const value = typeof message === 'string' ? message : JSON.stringify(message);
    return value.length > 200 ? `${value.slice(0, 200)}…` : value;
  } catch {
    return '[unserializable]';
  }
}
