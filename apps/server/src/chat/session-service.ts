// SessionService — the orchestrator-chat engine for ONE project.
//
// Owns: the active app session row, per-session `seq` allocation, the
// persist-then-broadcast door (guard rule 1), clientMessageId stamping, the
// send-queue, the ask registry, and the turn bracket (session-state
// running/idle) the boot-recovery reads. Runtime-agnostic: it drives whatever
// `RuntimeSession` the injected factory mints (the composition root resolves
// the adapter — ClaudeRuntimeAdapter in prod, FakeRuntime in tests).

import {
  appendConversationEvent,
  createOrchestratorSession,
  endOrchestratorSession,
  getActiveOrchestratorSession,
  getConversationHighWaterSeq,
  getConversationReplayState,
  getOrchestratorSession,
  reactivateOrchestratorSession,
  setOrchestratorSessionProvider,
  setOrchestratorSessionTitle,
  type OrchestratorSessionRow,
} from '@pc/db';
import type {
  ChatDeltaEvent,
  ChatDeltaFrame,
  ChatEvent,
  ChatFrame,
  OrchestratorHealth,
  OrchestratorStateFrame,
  SendAckStatus,
  SendQueueItem,
  SendQueueSnapshotFrame,
  ServerFrame,
  SessionChangedFrame,
  SessionReplayFrame,
  SessionSummary,
  UsageSnapshot,
} from '@pc/contracts';
import type { AskFrame } from '@pc/contracts';
import type { ULID } from '@pc/domain';
import type { RuntimeSession, RuntimeSessionFactory } from '../runner/runtime.ts';
import { AskRegistry } from './ask-registry.ts';
import { replayFrames } from './replay.ts';
import { SendQueue, type AgentEnvelopeMeta } from './send-queue.ts';
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
  /** Fan a frame to the project room (all sockets). */
  broadcast: (frame: ServerFrame) => void;
  /** Mint one live runtime session (composition root resolves the adapter). */
  mintSession: RuntimeSessionFactory;
  cwd?: string;
  askTimeoutMs?: number;
  /** Durable per-account usage sink (the sibling's usage cache). */
  onRateLimit?: (snapshot: UsageSnapshot) => void;
  /** Current rev of the orchestrator agent row. When it changes between turns
   *  the session is re-minted (with native resume) so prompt/model edits apply
   *  on the next message. Null/absent = never re-mint. */
  orchestratorRev?: () => number | null;
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

export class SessionService {
  private readonly projectId: ULID;
  private readonly broadcast: (frame: ServerFrame) => void;
  private readonly mintSession: RuntimeSessionFactory;
  private readonly cwd?: string;
  private readonly onRateLimit?: (snapshot: UsageSnapshot) => void;

  private readonly orchestratorRev?: () => number | null;

  private session: OrchestratorSessionRow | null;
  private runtime: RuntimeSession | null = null;
  /** Orchestrator-row rev the live runtime session was minted under. */
  private runtimeRev: number | null = null;
  private nextSeq = 1;
  private health: OrchestratorHealth = 'idle';
  private failureReason: string | null = null;

  private readonly sendQueue: SendQueue;
  private readonly askRegistry: AskRegistry;

  constructor(deps: SessionServiceDeps) {
    this.projectId = deps.projectId;
    this.broadcast = deps.broadcast;
    this.mintSession = deps.mintSession;
    this.cwd = deps.cwd;
    this.onRateLimit = deps.onRateLimit;
    this.orchestratorRev = deps.orchestratorRev;

    this.session = getActiveOrchestratorSession(this.projectId);
    if (this.session) this.nextSeq = getConversationReplayState(this.session.id).nextSeq;

    this.askRegistry = new AskRegistry({
      projectId: this.projectId,
      emit: (frame: AskFrame) => this.broadcast(frame),
      timeoutMs: deps.askTimeoutMs,
    });
    this.sendQueue = new SendQueue({
      deliver: (item) => this.deliver(item),
      onSnapshot: (items) => this.broadcastSendQueue(items),
    });
  }

  // ── connect snapshot (contract order) ──────────────────────────────────────

  connectSnapshot(): ServerFrame[] {
    const frames: ServerFrame[] = [this.sessionChangedFrame(this.session ? 'resume-session' : 'new-session')];
    frames.push(this.orchestratorStateFrame());
    if (this.session) frames.push(this.sessionReplayFrame());
    frames.push(this.sendQueueSnapshotFrame());
    return frames;
  }

  // ── client frames ──────────────────────────────────────────────────────────

  handleSend(text: string, clientMessageId: string): SendAckStatus {
    if (typeof text !== 'string' || text.trim().length === 0) return 'invalid';
    this.ensureActiveSession();
    const { ranImmediately } = this.sendQueue.enqueue(text, clientMessageId);
    return ranImmediately ? 'received' : 'queued';
  }

  /** Agent → orchestrator door (dispatch service): enqueues the envelope text
   *  as a turn exactly like `handleSend`, but persists it as a typed
   *  `agent-envelope` chat event (collapsed per-run card) instead of a bare
   *  `user` bubble. */
  injectAgentEnvelope(input: InjectAgentEnvelopeInput): SendAckStatus {
    this.ensureActiveSession();
    const { ranImmediately } = this.sendQueue.enqueue(input.envelope, input.clientMessageId, {
      runId: input.runId,
      agentName: input.agentName,
      pendingAskId: input.pendingAskId,
      status: input.status,
      summary: input.summary,
      detail: input.detail,
    });
    return ranImmediately ? 'received' : 'queued';
  }

  async handleInterrupt(): Promise<void> {
    if (this.runtime && (this.health === 'busy' || this.health === 'starting')) {
      try {
        await this.runtime.interrupt();
      } catch {
        /* positive receipt: the turn stream will still terminate */
      }
    }
  }

  handleAskReply(askId: string, answer: string): boolean {
    return this.askRegistry.reply(askId, answer);
  }

  // ── session lifecycle ────────────────────────────────────────────────────────

  ensureActiveSession(): OrchestratorSessionRow {
    if (this.session) return this.session;
    return this.startNewSession();
  }

  /** Mint a fresh session. Ends the current one, wipes runner + queue, and
   *  broadcasts `new-session` (client wipes its timeline). */
  startNewSession(): OrchestratorSessionRow {
    if (this.session) endOrchestratorSession(this.session.id, 'user_ended');
    this.teardownRunner('new-session');
    // providerSessionId captured from the runner's `init`; empty until then.
    this.session = createOrchestratorSession({ projectId: this.projectId, providerSessionId: '' });
    this.nextSeq = 1;
    this.broadcast(this.sessionChangedFrame('new-session'));
    this.broadcast(this.orchestratorStateFrame());
    return this.session;
  }

  /** Reactivate a past session and re-seed. */
  resumeSession(sessionId: ULID): OrchestratorSessionRow | null {
    const target = getOrchestratorSession(sessionId);
    if (!target || target.projectId !== this.projectId) return null;
    if (this.session && this.session.id !== sessionId) {
      endOrchestratorSession(this.session.id, 'user_ended');
    }
    this.teardownRunner('resume-session');
    this.session = reactivateOrchestratorSession(sessionId);
    if (!this.session) return null;
    this.nextSeq = getConversationReplayState(this.session.id).nextSeq;
    this.broadcast(this.sessionChangedFrame('resume-session'));
    this.broadcast(this.orchestratorStateFrame());
    this.broadcast(this.sessionReplayFrame());
    return this.session;
  }

  private teardownRunner(reason: string): void {
    this.sendQueue.cancelAll(reason);
    this.askRegistry.clear(reason);
    const b = this.runtime;
    this.runtime = null;
    this.setHealth('idle');
    if (b) void b.dispose().catch(() => {});
  }

  async dispose(): Promise<void> {
    this.askRegistry.clear('server shutdown');
    if (this.runtime) await this.runtime.dispose().catch(() => {});
    this.runtime = null;
  }

  // ── delivery (the turn) ──────────────────────────────────────────────────────

  private async ensureRuntime(session: OrchestratorSessionRow): Promise<RuntimeSession> {
    const rev = this.orchestratorRev?.() ?? null;
    if (this.runtime) {
      if (rev === null || rev === this.runtimeRev) return this.runtime;
      // The orchestrator row changed since this session was minted — dispose
      // and re-mint so the new instructions/model apply. Native resume (below)
      // re-attaches the conversation; SendQueue serializes deliver(), so the
      // swap only ever happens between turns.
      const old = this.runtime;
      this.runtime = null;
      void old.dispose().catch(() => {});
    }
    this.setHealth('starting');
    const resume = session.providerSessionId && session.providerSessionId.length > 0
      ? session.providerSessionId
      : undefined;
    const runtime = await this.mintSession({
      projectId: this.projectId,
      appSessionId: session.id,
      resumeNativeSessionId: resume,
      cwd: this.cwd,
      ask: this.askRegistry.ask,
    });
    this.runtime = runtime;
    this.runtimeRev = rev;
    return runtime;
  }

  private async deliver(item: { clientMessageId: string; text: string; agentEnvelope?: AgentEnvelopeMeta }): Promise<void> {
    const session = this.ensureActiveSession();
    // Title from the first user message — an agent envelope never seeds it.
    if (!session.title && !item.agentEnvelope) {
      const title = deriveTitle(item.text);
      if (title) {
        setOrchestratorSessionTitle(session.id, title);
        session.title = title;
      }
    }
    // Canonical optimistic reconcile — persisted before broadcast. A plain
    // send is a `user` bubble; an agent envelope persists as its typed,
    // collapsed per-run card instead (same turn text either way, below).
    if (item.agentEnvelope) {
      const meta = item.agentEnvelope;
      this.persistAndBroadcast(
        {
          kind: 'agent-envelope',
          runId: meta.runId as ULID,
          agentName: meta.agentName,
          pendingAskId: meta.pendingAskId as ULID | undefined,
          status: meta.status,
          summary: meta.summary,
          detail: meta.detail,
          envelope: item.text,
        },
        { clientMessageId: item.clientMessageId },
      );
    } else {
      this.persistAndBroadcast({ kind: 'user', text: item.text }, { clientMessageId: item.clientMessageId });
    }
    this.persistAndBroadcast({ kind: 'session-state', state: 'running', permissionMode: null });
    this.broadcast(this.orchestratorStateFrame());
    try {
      const runtime = await this.ensureRuntime(session);
      // In flight now — health is authoritative for interrupt().
      this.setHealth('busy');
      this.broadcast(this.orchestratorStateFrame());
      await runTurn(runtime.sendTurn(item.text), this.turnDeps(session));
    } catch (err) {
      // Reaches here only if the runtime refused to mint / stream — runTurn
      // itself always terminates internally. Guarantee the turn's terminal.
      const message = err instanceof Error ? err.message : String(err);
      this.persistAndBroadcast({ kind: 'turn-failed', error: message, source: 'internal' });
    } finally {
      this.persistAndBroadcast({ kind: 'session-state', state: 'idle', permissionMode: null });
      this.setHealth('idle');
      this.broadcast(this.orchestratorStateFrame());
    }
  }

  private turnDeps(session: OrchestratorSessionRow): TurnRunnerDeps {
    return {
      emitChat: (event, opts) => this.persistAndBroadcast(event, { sdkUuid: opts?.sdkUuid }),
      emitDelta: (sdkUuid, event) => this.broadcastDelta(session.id, sdkUuid, event),
      onSdkSessionId: (id, model) => {
        if (session.providerSessionId === id) return;
        setOrchestratorSessionProvider(session.id, { providerSessionId: id, model });
        session.providerSessionId = id;
        session.model = model;
      },
      onRateLimit: (snapshot) => this.onRateLimit?.(snapshot),
      onDropped: (reason, message) => {
        console.warn(`[pc-sdk][turn] dropped: ${reason}`, summarize(message));
      },
    };
  }

  // ── persist-then-broadcast (guard rule 1) ────────────────────────────────────

  /** Allocate seq, persist to conversation_events, THEN broadcast the same
   *  payload. The DB write commits before the frame reaches the wire. */
  private persistAndBroadcast(
    event: ChatEvent,
    opts: { sdkUuid?: string; clientMessageId?: string } = {},
  ): ChatFrame {
    const session = this.session;
    if (!session) throw new Error('persistAndBroadcast without an active session');
    const seq = this.nextSeq++;
    appendConversationEvent({
      projectId: this.projectId,
      sessionId: session.id,
      seq,
      kind: event.kind,
      event,
      sdkUuid: opts.sdkUuid ?? null,
      clientMessageId: opts.clientMessageId ?? null,
      now: Date.now(),
    });
    const frame: ChatFrame = {
      type: 'chat',
      projectId: this.projectId,
      sessionId: session.id,
      seq,
      id: `${session.id}:${seq}`,
      event,
      ...(opts.sdkUuid ? { sdkUuid: opts.sdkUuid } : {}),
      ...(opts.clientMessageId ? { clientMessageId: opts.clientMessageId } : {}),
    };
    this.broadcast(frame);
    return frame;
  }

  private broadcastDelta(sessionId: string, sdkUuid: string, event: ChatDeltaEvent): void {
    const frame: ChatDeltaFrame = {
      type: 'chat-delta',
      projectId: this.projectId,
      sessionId,
      sdkUuid,
      event,
    };
    this.broadcast(frame);
  }

  // ── frame builders ───────────────────────────────────────────────────────────

  private sessionSummary(): SessionSummary | null {
    const s = this.session;
    if (!s) return null;
    return {
      id: s.id,
      projectId: s.projectId,
      model: s.model,
      title: s.title,
      status: s.status === 'ended' ? 'ended' : 'active',
      startedAt: s.startedAt,
    };
  }

  private sessionChangedFrame(transition: 'new-session' | 'resume-session'): SessionChangedFrame {
    return { type: 'session-changed', projectId: this.projectId, transition, session: this.sessionSummary() };
  }

  private sessionReplayFrame(): SessionReplayFrame {
    const s = this.session!;
    return {
      type: 'session-replay',
      projectId: this.projectId,
      sessionId: s.id,
      highWaterSeq: getConversationHighWaterSeq(s.id),
      events: replayFrames(this.projectId, s.id),
    };
  }

  private orchestratorStateFrame(): OrchestratorStateFrame {
    return {
      type: 'orchestrator-state',
      projectId: this.projectId,
      sessionId: this.session?.id ?? null,
      health: this.health,
      queueDepth: this.sendQueue.queueDepth,
      failureReason: this.failureReason,
    };
  }

  private sendQueueSnapshotFrame(): SendQueueSnapshotFrame {
    return {
      type: 'send-queue-snapshot',
      projectId: this.projectId,
      sessionId: this.session?.id ?? '',
      items: this.sendQueue.snapshot(),
    };
  }

  private broadcastSendQueue(items: SendQueueItem[]): void {
    this.broadcast({
      type: 'send-queue-snapshot',
      projectId: this.projectId,
      sessionId: this.session?.id ?? '',
      items,
    });
    this.broadcast(this.orchestratorStateFrame());
  }

  private setHealth(health: OrchestratorHealth): void {
    this.health = health;
    if (health !== 'failed') this.failureReason = null;
  }
}

function summarize(message: unknown): string {
  try {
    const s = typeof message === 'string' ? message : JSON.stringify(message);
    return s.length > 200 ? `${s.slice(0, 200)}…` : s;
  } catch {
    return '[unserializable]';
  }
}
