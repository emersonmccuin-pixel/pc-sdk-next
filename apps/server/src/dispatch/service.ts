// DispatchService — the Phase-3 verb layer: dispatch → contract → run →
// verify → land, on the canonical runtime contract. Contains no provider
// event parsing; specialists run through the same AgentRuntimeAdapter seam as
// the orchestrator.
//
// Invariants (master plan + contract docs):
// - Contract + provisioned isolation BEFORE any agent starts, or refuse loudly
//   (typed causes: unknown-agent / contract-required / worktree-provision-failed).
// - Delivery via pc_submit_deliverable is the SOLE done-signal; a completed
//   run with no deliverable is rewritten failed 'no-deliverable'.
// - Every run row is stamped with its runtime selection (runtime/account/model)
//   and native session id (guard rule 2).
// - DB is the source of truth; live handles are projections (a kill/answer on
//   a phantom run works off the row, not the handle).

import { randomUUID } from 'node:crypto';
import {
  appendConversationEvent,
  findActiveContinuation,
  getAgentRunRow,
  getConversationReplayState,
  getPendingAsk,
  getPodForSpawn,
  getProjectById,
  hasPendingAskForRun,
  insertAgentRunRow,
  listConversationEvents,
  markAgentRunDelivered,
  newId,
  setAgentRunCcSession,
  updateAgentRunStatus,
} from '@pc/db';
import {
  AgentRunMutationGateway,
  ContractService,
  toAgentRunDto,
} from '@pc/app-services';
import type { AgentEventFrame, ChatEvent, Contract, Deliverable as ContractDeliverable } from '@pc/contracts';
import {
  deriveAcceptanceCriteriaV2,
  getPodDefaultExpectedOutput,
  isExpectedOutputKind,
  type AgentRunRow,
  type Deliverable,
  type ExpectedOutput,
  type PendingAskOption,
  type ULID,
} from '@pc/domain';
import type { AccountRegistry } from '../runner/account-env.ts';
import { CLAUDE_RUNTIME_ID } from '../runner/claude-adapter.ts';
import type { RuntimeEvent, RuntimeRegistry, RuntimeSelection, RuntimeSession } from '../runner/runtime.ts';
import type { McpManager } from '../mcp/manager.ts';
import type { SessionRegistry } from '../chat/registry.ts';
import type { ProjectWebSocketHub } from '../ws/hub.ts';
import { runTurn } from '../chat/turn-runner.ts';
import { AGENT_PC_TOOLS, buildPcToolDefs, mergePcTools } from './pc-bridge.ts';
import { buildAskEnvelope, buildSpecialistInstructions, buildTerminalEnvelope } from './prompt.ts';
import { verifyContract } from './verification.ts';
import { git, landBranch, provisionWorktree, teardownWorktree } from './worktrees.ts';

const WALL_CLOCK_DEFAULT_MS = 2 * 60 * 60 * 1000;
const DEFAULT_AGENT_MODEL = 'sonnet';
const DEFAULT_AGENT_MAX_TURNS = 100;

export type DispatchFailureCause =
  | 'unknown-agent'
  | 'contract-required'
  | 'worktree-provision-failed'
  | 'project-missing'
  | 'invalid-spec'
  | 'run-not-found'
  | 'not-continuable'
  | 'concurrent-continuation'
  | 'not-attached';

export type DispatchResult =
  | { ok: true; run: ReturnType<typeof toAgentRunDto> }
  | { ok: false; cause: DispatchFailureCause; message: string; httpStatus: number };

export interface DispatchFreshInput {
  projectId: ULID;
  agentName: string;
  input: string;
  dispatcherSessionId: string;
  pmRef?: string | null;
  expectedOutput?: unknown;
  parentInvokeDepth?: number;
}

export interface DispatchServiceDeps {
  runtimes: RuntimeRegistry;
  accounts: AccountRegistry;
  mcp: McpManager;
}

interface AttachContext {
  registry: SessionRegistry;
  hub: ProjectWebSocketHub<ULID>;
  serverPort: number;
}

interface LiveRun {
  session: RuntimeSession;
  selection: RuntimeSelection;
  wallClock: ReturnType<typeof setTimeout>;
  nextSeq: number;
}

export class DispatchService {
  private readonly deps: DispatchServiceDeps;
  private readonly gateway = new AgentRunMutationGateway();
  private readonly contracts = new ContractService();
  private ctx: AttachContext | null = null;
  private readonly live = new Map<string, LiveRun>();
  /** Per-repository landing serialization (worktree-lifecycle guard 6): one
   *  active landing mutation per project at a time. */
  private readonly landingLocks = new Map<string, Promise<unknown>>();

  constructor(deps: DispatchServiceDeps) {
    this.deps = deps;
  }

  /** Late-bind the server context (registry/hub/port exist only after listen). */
  attach(ctx: AttachContext): void {
    this.ctx = ctx;
  }

  hasLiveRun(runId: string): boolean {
    return this.live.has(runId);
  }

  // ── dispatch (fresh) ─────────────────────────────────────────────────────────

  async dispatchFresh(input: DispatchFreshInput): Promise<DispatchResult> {
    const ctx = this.ctx;
    if (!ctx) return refuse('not-attached', 'dispatch service not ready (server still booting)', 503);
    const project = getProjectById(input.projectId);
    if (!project) return refuse('project-missing', `unknown project ${input.projectId}`, 404);

    const bundle = getPodForSpawn(input.agentName, input.projectId);
    if (!bundle) {
      return refuse('unknown-agent', `no agent named '${input.agentName}' is visible in this project (pc_list_agents)`, 422);
    }
    const pod = bundle.agent;

    // Contract-required pre-check — BEFORE any row insert. Resolution chain:
    // inline spec → pod-row default → stock default. Chain empty ⇒ refuse; a
    // contract that checks nothing is never minted (2026-06-07 finding).
    let spec: ExpectedOutput | null = null;
    if (input.expectedOutput && typeof input.expectedOutput === 'object') {
      const candidate = input.expectedOutput as { kind?: unknown };
      if (!isExpectedOutputKind(candidate.kind)) {
        return refuse('invalid-spec', `expected_output.kind must be one of answer|prose|payload|repo|external|binary|action`, 422);
      }
      spec = input.expectedOutput as ExpectedOutput;
    }
    spec = spec ?? (pod.expectedOutput as ExpectedOutput | null) ?? getPodDefaultExpectedOutput(input.agentName) ?? null;
    if (!spec) {
      return refuse(
        'contract-required',
        `agent '${input.agentName}' has no default expected_output — pass expected_output explicitly (a spec-less contract would verify nothing)`,
        422,
      );
    }
    if (spec.kind === 'repo') spec = { ...spec, isolation: 'worktree' };

    const runId = newId() as ULID;
    const ccPlaceholder = randomUUID();
    const now = Date.now();
    const account = this.deps.accounts.resolveForProject(input.projectId);
    const selection: RuntimeSelection = {
      runtimeId: CLAUDE_RUNTIME_ID,
      accountId: account.id,
      model: pod.model ?? DEFAULT_AGENT_MODEL,
    };

    // Repo isolation invariant: provision BEFORE the agent starts; a provision
    // failure is a loud terminal, never a fallback to the live checkout.
    let worktree: { dir: string; branch: string; baseBranch: string; baseSha: string } | null = null;
    if (spec.kind === 'repo') {
      const provisioned = await provisionWorktree(project.folderPath, runId);
      if (!provisioned.ok) {
        // Insert the row first so the refusal is durable + visible in the rail.
        this.gateway.commitRunChange({
          reason: 'queued',
          mutate: () =>
            insertAgentRunRow({
              id: runId,
              projectId: input.projectId,
              podName: input.agentName,
              dispatcherSessionId: input.dispatcherSessionId,
              ccSessionId: ccPlaceholder,
              status: 'queued',
              input: input.input,
              pmRef: input.pmRef ?? null,
              parentInvokeDepth: input.parentInvokeDepth ?? 0,
              runtimeId: selection.runtimeId,
              accountId: selection.accountId,
              model: selection.model,
              queuedAt: now,
            }),
        });
        this.gateway.commitTerminal({
          runId,
          status: 'failed',
          result: null,
          failureCause: 'worktree-provision-failed',
          failureReason: provisioned.error,
          completedAt: Date.now(),
        });
        return refuse('worktree-provision-failed', provisioned.error, 422);
      }
      worktree = provisioned;
    }

    // Contract first (issued), then the run row, then the link (dispatched).
    const contract = this.contracts.create({
      projectId: input.projectId,
      pmRef: input.pmRef ?? null,
      podName: input.agentName,
      expectedOutput: spec,
      acceptanceCriteria: deriveAcceptanceCriteriaV2(spec),
      verificationTier: 'auto',
      worktreePath: worktree?.dir ?? null,
      worktreeBaseBranch: worktree?.baseBranch ?? null,
      worktreeBaseSha: worktree?.baseSha ?? null,
    });

    const publication = this.gateway.commitRunChange({
      reason: 'queued',
      mutate: () =>
        insertAgentRunRow({
          id: runId,
          projectId: input.projectId,
          podName: input.agentName,
          dispatcherSessionId: input.dispatcherSessionId,
          ccSessionId: ccPlaceholder,
          status: 'queued',
          input: input.input,
          pmRef: input.pmRef ?? null,
          parentInvokeDepth: input.parentInvokeDepth ?? 0,
          contractId: contract.id as ULID,
          worktreeDir: worktree?.dir ?? null,
          worktreeBaseBranch: worktree?.baseBranch ?? null,
          worktreeBaseSha: worktree?.baseSha ?? null,
          runtimeId: selection.runtimeId,
          accountId: selection.accountId,
          model: selection.model,
          queuedAt: now,
        }),
    });
    this.contracts.setRun(contract.id, runId);

    // Fire the run; the dispatch call returns immediately (always async).
    void this.startRun({
      row: publication.run as unknown as { runId: string },
      runId,
      projectId: input.projectId,
      pod,
      contextDocs: bundle.contextDocs,
      contract,
      spec,
      selection,
      worktree,
      firstMessage: input.input,
      resumeNativeSessionId: null,
    }).catch((err) => {
      console.error(`[pc-sdk][dispatch] startRun crashed for ${runId}:`, err);
      this.settleTerminal(runId, {
        status: 'failed',
        result: null,
        failureCause: 'spawn-error',
        failureReason: err instanceof Error ? err.message : String(err),
      });
    });

    const row = getAgentRunRow(runId);
    return { ok: true, run: toAgentRunDto(row ?? (publication.run as never)) };
  }

  // ── dispatch (continue) ─────────────────────────────────────────────────────

  async dispatchContinue(input: {
    projectId: ULID;
    runId: ULID;
    input: string;
    dispatcherSessionId: string;
  }): Promise<DispatchResult> {
    const ctx = this.ctx;
    if (!ctx) return refuse('not-attached', 'dispatch service not ready', 503);
    const parent = getAgentRunRow(input.runId);
    if (!parent || parent.projectId !== input.projectId) {
      return refuse('run-not-found', `unknown run ${input.runId}`, 404);
    }
    if (parent.status !== 'completed' && parent.status !== 'failed') {
      return refuse('not-continuable', `run is '${parent.status}' — only completed/failed runs can be continued`, 409);
    }
    if (findActiveContinuation(input.runId)) {
      return refuse('concurrent-continuation', 'an active continuation for this run already exists', 409);
    }
    const project = getProjectById(input.projectId);
    if (!project) return refuse('project-missing', `unknown project ${input.projectId}`, 404);
    const bundle = getPodForSpawn(parent.podName, input.projectId);
    if (!bundle) return refuse('unknown-agent', `agent '${parent.podName}' no longer exists`, 422);

    // Contract carries forward — a continuation never spawns contract-less.
    const contractId = parent.contractId;
    const contract = contractId ? this.contracts.get(contractId) : null;
    if (!contract || !contract.expectedOutput) {
      return refuse('contract-required', 'parent run has no resolvable contract to carry forward', 422);
    }
    const spec = contract.expectedOutput as ExpectedOutput;

    const runId = newId() as ULID;
    const now = Date.now();
    const account = this.deps.accounts.resolveForProject(input.projectId);
    const selection: RuntimeSelection = {
      runtimeId: parent.runtimeId ?? CLAUDE_RUNTIME_ID,
      accountId: parent.accountId ?? account.id,
      model: parent.model ?? bundle.agent.model ?? DEFAULT_AGENT_MODEL,
    };

    const publication = this.gateway.commitRunChange({
      reason: 'queued',
      mutate: () =>
        insertAgentRunRow({
          id: runId,
          projectId: input.projectId,
          podName: parent.podName,
          dispatcherSessionId: input.dispatcherSessionId,
          ccSessionId: parent.ccSessionId,
          status: 'queued',
          input: input.input,
          pmRef: parent.pmRef,
          continues: parent.id,
          parentInvokeDepth: parent.parentInvokeDepth,
          contractId: contract.id as ULID,
          worktreeDir: parent.worktreeDir,
          worktreeBaseBranch: parent.worktreeBaseBranch,
          worktreeBaseSha: parent.worktreeBaseSha,
          runtimeId: selection.runtimeId,
          accountId: selection.accountId,
          model: selection.model,
          queuedAt: now,
        }),
    });
    this.contracts.setRun(contract.id, runId);

    void this.startRun({
      row: publication.run as unknown as { runId: string },
      runId,
      projectId: input.projectId,
      pod: bundle.agent,
      contextDocs: bundle.contextDocs,
      contract,
      spec,
      selection,
      worktree: parent.worktreeDir
        ? { dir: parent.worktreeDir, branch: '', baseBranch: parent.worktreeBaseBranch ?? '', baseSha: parent.worktreeBaseSha ?? '' }
        : null,
      firstMessage: input.input,
      resumeNativeSessionId: parent.ccSessionId,
    }).catch((err) => {
      this.settleTerminal(runId, {
        status: 'failed',
        result: null,
        failureCause: 'spawn-error',
        failureReason: err instanceof Error ? err.message : String(err),
      });
    });

    const row = getAgentRunRow(runId);
    return { ok: true, run: toAgentRunDto(row ?? (publication.run as never)) };
  }

  // ── the run itself ──────────────────────────────────────────────────────────

  private async startRun(input: {
    row: { runId: string };
    runId: ULID;
    projectId: ULID;
    pod: { name: string; prompt: string; model: string | null; maxTurns: number | null; tools: string[] };
    contextDocs: ReadonlyArray<{ title: string; body: string }>;
    contract: Contract;
    spec: ExpectedOutput;
    selection: RuntimeSelection;
    worktree: { dir: string; branch: string; baseBranch: string; baseSha: string } | null;
    firstMessage: string;
    resumeNativeSessionId: string | null;
  }): Promise<void> {
    const ctx = this.ctx!;
    const project = getProjectById(input.projectId);
    const cwd = input.worktree?.dir ?? project?.folderPath ?? process.cwd();

    this.announce(input.runId, 'spawning', { spawnedAt: Date.now() });

    let instructions = buildSpecialistInstructions({
      charter: input.pod.prompt,
      podName: input.pod.name,
      expectedOutput: input.spec,
      acceptanceCriteria: (input.contract.acceptanceCriteria ?? []) as never,
      worktreeDir: input.worktree?.dir ?? null,
    });
    if (input.contextDocs.length > 0) {
      instructions += `\n\n## Context documents\n${input.contextDocs
        .map((d) => `### ${d.title}\n${d.body}`)
        .join('\n\n')}`;
    }

    const run = getAgentRunRow(input.runId);
    const tools = mergePcTools(
      undefined, // v1: no remote-MCP attachment for specialists (deferred; slots in here)
      buildPcToolDefs(AGENT_PC_TOOLS, {
        projectId: input.projectId,
        dispatcherSessionId: run?.dispatcherSessionId ?? '',
        agentRunId: input.runId,
        agentSessionId: run?.ccSessionId ?? '',
        invokeDepth: (run?.parentInvokeDepth ?? 0) + 1,
        serverPort: ctx.serverPort,
      }),
    );

    const adapter = this.deps.runtimes.get(input.selection.runtimeId);
    const sessionInput = {
      appSessionId: input.runId,
      projectId: input.projectId,
      selection: input.selection,
      instructions,
      cwd,
      tools,
      maxTurns: input.pod.maxTurns ?? DEFAULT_AGENT_MAX_TURNS,
      bypassPermissions: true, // headless specialist — never blocks on a browser ask
    };
    const session = input.resumeNativeSessionId
      ? await adapter.resumeSession({ ...sessionInput, nativeSessionId: input.resumeNativeSessionId })
      : await adapter.createSession(sessionInput);

    const liveRun: LiveRun = {
      session,
      selection: input.selection,
      nextSeq: getConversationReplayState(input.runId).nextSeq,
      wallClock: setTimeout(() => {
        void this.killRun(input.projectId, input.runId, {
          failureCause: 'wall-clock-timeout',
          failureReason: `run exceeded the ${Math.round(WALL_CLOCK_DEFAULT_MS / 60000)}min wall clock`,
        });
      }, WALL_CLOCK_DEFAULT_MS),
    };
    liveRun.wallClock.unref?.();
    this.live.set(input.runId, liveRun);

    await this.consumeTurn(input.runId, input.projectId, session.sendTurn(input.firstMessage), { firstTurn: true });
  }

  /** Drive one turn to its terminal and settle/park by the run row's status. */
  private async consumeTurn(
    runId: ULID,
    projectId: ULID,
    turn: AsyncIterable<RuntimeEvent>,
    opts: { firstTurn: boolean },
  ): Promise<void> {
    const liveRun = this.live.get(runId);
    if (!liveRun) return;
    let lastText = '';
    let markedRunning = !opts.firstTurn;

    const terminal = await runTurn(turn, {
      emitChat: (event) => {
        if (event.kind === 'assistant-text') lastText = event.text;
        this.persistAgentEvent(projectId, runId, liveRun, event);
      },
      emitDelta: () => {
        /* agent transcripts are persisted-event only; the modal heals over HTTP */
      },
      onSdkSessionId: (nativeId) => {
        setAgentRunCcSession(runId, nativeId);
        if (!markedRunning) {
          markedRunning = true;
          this.announce(runId, 'running', { readyAt: Date.now() });
        }
      },
      onDropped: () => {},
    });

    // The row is the truth: an ask route may have flipped this run to paused
    // mid-turn — park the live session and wait for the answer.
    const row = getAgentRunRow(runId);
    if (!row) return;
    if (row.status === 'paused') return;
    if (row.status === 'completed' || row.status === 'failed' || row.status === 'cancelled') return; // killed already

    if (terminal === 'turn-end') {
      this.settleTerminal(runId, { status: 'completed', result: lastText || null, failureCause: null, failureReason: null });
    } else {
      this.settleTerminal(runId, {
        status: 'failed',
        result: lastText || null,
        failureCause: 'unexpected-exit',
        failureReason: 'agent turn failed (see transcript)',
      });
    }
  }

  private persistAgentEvent(projectId: ULID, runId: ULID, liveRun: LiveRun, event: ChatEvent): void {
    const seq = liveRun.nextSeq++;
    const dedupId = `${runId}:${seq}`;
    try {
      appendConversationEvent({
        projectId,
        sessionId: runId,
        seq,
        kind: event.kind,
        event,
        sdkUuid: null,
        clientMessageId: null,
        now: Date.now(),
      });
    } catch (err) {
      console.warn(`[pc-sdk][dispatch] transcript persist failed for ${runId}:`, err);
    }
    const frame: AgentEventFrame = { type: 'agent-event', projectId, runId, event, dedupId };
    this.ctx?.hub.broadcast(projectId, frame);
  }

  private announce(
    runId: ULID,
    status: 'spawning' | 'running',
    stamps: { spawnedAt?: number; readyAt?: number },
  ): void {
    updateAgentRunStatus({ id: runId, status, ...stamps });
    this.gateway.announceRunChange({ runId, reason: status });
  }

  // ── pause / answer / kill ───────────────────────────────────────────────────

  /** pc_ask_orchestrator / pc_request_approval door (HTTP route). Creates the
   *  durable ask, flips the run paused, envelopes the orchestrator. */
  createPendingAsk(input: {
    projectId: ULID;
    agentRunId: ULID;
    kind: 'orchestrator' | 'approval';
    promptBody: string;
    context?: string | null;
    options?: PendingAskOption[] | null;
  }): { ok: true; pendingAskId: ULID } | { ok: false; message: string; httpStatus: number } {
    const row = getAgentRunRow(input.agentRunId);
    if (!row || row.projectId !== input.projectId) return { ok: false, message: 'unknown run', httpStatus: 404 };
    if (row.status !== 'running' && row.status !== 'spawning') {
      return { ok: false, message: `run is '${row.status}' — only a live run can ask`, httpStatus: 409 };
    }
    const askId = newId() as ULID;
    this.gateway.pauseRun({
      pendingAsk: {
        id: askId,
        agentRunId: input.agentRunId,
        ccSessionId: row.ccSessionId,
        projectId: input.projectId,
        pmRef: row.pmRef,
        kind: input.kind,
        promptBody: input.promptBody,
        context: input.context ?? null,
        options: input.options ?? null,
        now: Date.now(),
      },
    });
    this.deliverToOrchestrator(
      input.projectId,
      buildAskEnvelope({
        runId: input.agentRunId,
        podName: row.podName,
        pendingAskId: askId,
        kind: input.kind,
        promptBody: input.promptBody,
        context: input.context,
        options: input.options,
      }),
      `agent-ask:${askId}`,
    );
    return { ok: true, pendingAskId: askId };
  }

  /** pc_answer_pending / user answer door. Atomic flip + resume the parked
   *  session with the answer as its next message. */
  answerPendingAsk(input: {
    projectId: ULID;
    pendingAskId: ULID;
    answer: string;
    answeredBy: 'orchestrator' | 'user';
  }): { ok: true } | { ok: false; message: string; httpStatus: number } {
    const ask = getPendingAsk(input.pendingAskId);
    if (!ask || ask.projectId !== input.projectId) return { ok: false, message: 'unknown pending ask', httpStatus: 404 };
    if (ask.status !== 'open') return { ok: false, message: `ask already ${ask.status}`, httpStatus: 409 };
    const liveRun = this.live.get(ask.agentRunId);
    if (!liveRun) {
      return { ok: false, message: 'run is no longer live (server restarted) — re-dispatch or continue it', httpStatus: 410 };
    }
    const flipped = this.gateway.answerAndResume({
      pendingAskId: input.pendingAskId,
      agentRunId: ask.agentRunId,
      answer: input.answer,
      answeredBy: input.answeredBy,
      now: Date.now(),
      podRevisionAtResume: null,
    });
    if (!flipped) return { ok: false, message: 'ask already answered (replay)', httpStatus: 409 };

    const run = getAgentRunRow(ask.agentRunId);
    if (run) {
      updateAgentRunStatus({ id: ask.agentRunId, status: 'running' });
      this.gateway.announceRunChange({ runId: ask.agentRunId, reason: 'running' });
    }
    void this.consumeTurn(
      ask.agentRunId,
      ask.projectId,
      liveRun.session.sendTurn(`[answer from ${input.answeredBy}] ${input.answer}`),
      { firstTurn: false },
    ).catch((err) => {
      this.settleTerminal(ask.agentRunId, {
        status: 'failed',
        result: null,
        failureCause: 'send-failed',
        failureReason: err instanceof Error ? err.message : String(err),
      });
    });
    return { ok: true };
  }

  /** Force-end a run. Phantom-safe: finalizes the row even with no live
   *  handle. Idempotent on terminal rows. */
  async killRun(
    projectId: ULID,
    runId: ULID,
    opts: { failureCause?: 'cancelled' | 'wall-clock-timeout'; failureReason?: string } = {},
  ): Promise<{ ok: true; alreadyTerminal: boolean } | { ok: false; message: string; httpStatus: number }> {
    const row = getAgentRunRow(runId);
    if (!row || row.projectId !== projectId) return { ok: false, message: 'unknown run', httpStatus: 404 };
    const publication = this.gateway.cancelRun({
      runId,
      now: Date.now(),
      failureCause: opts.failureCause ?? 'cancelled',
      failureReason: opts.failureReason ?? 'killed via pc_kill_agent_run',
    });
    const liveRun = this.live.get(runId);
    if (liveRun) {
      clearTimeout(liveRun.wallClock);
      this.live.delete(runId);
      void liveRun.session.dispose().catch(() => {});
    }
    return { ok: true, alreadyTerminal: publication === null };
  }

  // ── deliverable + review ────────────────────────────────────────────────────

  /** pc_submit_deliverable door. Repo submissions are SEALED — a dirty
   *  worktree is refused (retryable) so verification reads committed state. */
  async submitDeliverable(input: {
    projectId: ULID;
    agentRunId: ULID;
    deliverable: Record<string, unknown>;
    report?: string | null;
  }): Promise<{ ok: true; contract: Contract } | { ok: false; message: string; httpStatus: number }> {
    const row = getAgentRunRow(input.agentRunId);
    if (!row || row.projectId !== input.projectId) return { ok: false, message: 'unknown run', httpStatus: 404 };
    if (!row.contractId) return { ok: false, message: 'run has no contract', httpStatus: 409 };
    const contract = this.contracts.get(row.contractId);
    if (!contract) return { ok: false, message: 'contract missing', httpStatus: 409 };

    const expectedKind = (contract.expectedOutput as ExpectedOutput | null)?.kind;
    const submittedKind = String(input.deliverable.kind ?? '');
    if (expectedKind && submittedKind !== expectedKind) {
      return {
        ok: false,
        message: `deliverable kind '${submittedKind}' does not match the contract's expected kind '${expectedKind}'`,
        httpStatus: 422,
      };
    }

    let deliverable = input.deliverable as unknown as Deliverable;
    if (expectedKind === 'repo' && row.worktreeDir) {
      const status = await git(['status', '--porcelain'], row.worktreeDir);
      if (status.ok && status.stdout.length > 0) {
        return {
          ok: false,
          message: 'worktree has uncommitted changes — commit everything, then resubmit (verification reads committed state)',
          httpStatus: 409,
        };
      }
      // Fill branch/commit receipts the agent may have omitted.
      const head = await git(['rev-parse', 'HEAD'], row.worktreeDir);
      const repoDeliverable = deliverable as Extract<Deliverable, { kind: 'repo' }>;
      deliverable = {
        ...repoDeliverable,
        branch: repoDeliverable.branch || row.worktreeDir.split(/[\\/]/).pop() || undefined,
        commit: repoDeliverable.commit || (head.ok ? head.stdout : undefined),
        baseBranch: repoDeliverable.baseBranch || row.worktreeBaseBranch || undefined,
        baseCommit: repoDeliverable.baseCommit || row.worktreeBaseSha || undefined,
      };
    }

    const updated = this.contracts.setDeliverable({
      id: contract.id,
      deliverable: deliverable as unknown as ContractDeliverable,
      report: input.report ?? null,
    });
    if (!updated) return { ok: false, message: 'contract vanished mid-submit', httpStatus: 500 };
    markAgentRunDelivered(input.agentRunId, Date.now());
    return { ok: true, contract: updated };
  }

  /** pc_review_contract door — tier-2 sign-off. Accept ⇒ passed (+ land for
   *  repo); reject ⇒ failed with the reviewer's notes. */
  async reviewContract(input: {
    projectId: ULID;
    contractId: ULID;
    verdict: 'accept' | 'reject';
    notes?: string | null;
  }): Promise<{ ok: true; contract: Contract } | { ok: false; message: string; httpStatus: number }> {
    const contract = this.contracts.get(input.contractId);
    if (!contract || contract.projectId !== input.projectId) return { ok: false, message: 'unknown contract', httpStatus: 404 };
    if (contract.landingStatus === 'landed') {
      return { ok: false, message: 'contract already landed', httpStatus: 409 };
    }
    const notes = input.notes ?? null;
    if (input.verdict === 'reject') {
      const updated = this.contracts.setVerification({
        id: contract.id,
        verificationStatus: 'failed',
        verificationNotes: notes ?? 'rejected by orchestrator review',
      });
      return updated ? { ok: true, contract: updated } : { ok: false, message: 'contract vanished', httpStatus: 500 };
    }
    let updated = this.contracts.setVerification({
      id: contract.id,
      verificationStatus: 'passed',
      verificationNotes: notes ?? 'accepted by orchestrator review',
    });
    if (!updated) return { ok: false, message: 'contract vanished', httpStatus: 500 };
    if ((updated.expectedOutput as ExpectedOutput | null)?.kind === 'repo') {
      updated = (await this.landAcceptedContract(updated)) ?? updated;
    }
    return { ok: true, contract: updated };
  }

  // ── terminal settlement ─────────────────────────────────────────────────────

  private settleTerminal(
    runId: ULID,
    input: {
      status: 'completed' | 'failed' | 'cancelled';
      result: string | null;
      failureCause: AgentRunRow['failureCause'];
      failureReason: string | null;
    },
  ): void {
    const liveRun = this.live.get(runId);
    if (liveRun) {
      clearTimeout(liveRun.wallClock);
      this.live.delete(runId);
      void liveRun.session.dispose().catch(() => {});
    }
    const row = getAgentRunRow(runId);
    if (!row) return;

    // The completion gate: delivery is the sole done-signal.
    let status = input.status;
    let failureCause = input.failureCause;
    let failureReason = input.failureReason;
    const contract = row.contractId ? this.contracts.get(row.contractId) : null;
    if (status === 'completed' && contract && !contract.deliverable && row.deliveredAt === null) {
      status = 'failed';
      failureCause = 'no-deliverable';
      failureReason = 'run ended without pc_submit_deliverable — delivery is the done-signal';
    }

    const publication = this.gateway.commitTerminal({
      runId,
      status,
      result: input.result,
      failureCause: status === 'completed' ? null : failureCause,
      failureReason: status === 'completed' ? null : failureReason,
      completedAt: Date.now(),
    });
    if (!publication) return; // already terminal (idempotent)

    void this.verifyAndLand(runId, status).catch((err) => {
      console.error(`[pc-sdk][dispatch] verify/land crashed for ${runId}:`, err);
    });
  }

  private async verifyAndLand(runId: ULID, terminalStatus: 'completed' | 'failed' | 'cancelled'): Promise<void> {
    const row = getAgentRunRow(runId);
    if (!row) return;
    let contract = row.contractId ? this.contracts.get(row.contractId) : null;
    const project = getProjectById(row.projectId);

    if (contract && terminalStatus === 'completed') {
      const outcome = await verifyContract({
        expectedOutput: contract.expectedOutput as ExpectedOutput,
        acceptanceCriteria: contract.acceptanceCriteria as never,
        verificationTier: contract.verificationTier,
        deliverable: contract.deliverable as Deliverable | null,
        report: contract.report,
        toolCalls: this.evidenceToolCalls(runId),
        pendingAskCreated: hasPendingAskForRun(runId),
        scope: {
          worktreeDir: row.worktreeDir,
          projectDir: project?.folderPath ?? '',
          baseSha: row.worktreeBaseSha,
          deliverableCommit: (contract.deliverable as { commit?: string } | null)?.commit ?? null,
        },
      });
      contract = this.contracts.setVerification({
        id: contract.id,
        verificationStatus: outcome.verificationStatus,
        verificationNotes: outcome.notes,
        ...(outcome.escalatedToReview ? { verificationTier: 'orchestrator-review' as const } : {}),
      });
    } else if (contract && terminalStatus === 'failed') {
      contract = this.contracts.setVerification({
        id: contract.id,
        verificationStatus: 'failed',
        verificationNotes: `run failed (${row.failureCause ?? 'unknown'}) before verification`,
      });
    }

    // Landing policy (docs/worktree-lifecycle.md): auto-merge is OPT-IN. A
    // passed repo contract lands automatically only when the ISSUER set
    // auto_land; otherwise it parks merge-ready for the orchestrator to review
    // the diff and authorize via pc_review_contract accept.
    const spec = contract?.expectedOutput as ExpectedOutput | null;
    if (contract && contract.verificationStatus === 'passed' && spec?.kind === 'repo') {
      if (spec.auto_land === true) {
        contract = (await this.landAcceptedContract(contract)) ?? contract;
      }
      // else: merge-ready — landingStatus stays null; the envelope says so.
    }

    const freshRow = getAgentRunRow(runId) ?? row;
    const kind = freshRow.status === 'completed' ? 'agent-completed' : 'agent-failed';
    this.deliverToOrchestrator(
      row.projectId,
      buildTerminalEnvelope({
        kind,
        runId,
        podName: row.podName,
        result: freshRow.result,
        failureCause: freshRow.failureCause,
        failureReason: freshRow.failureReason,
        contractId: contract?.id ?? null,
        verificationStatus: contract?.verificationStatus ?? null,
        verificationNotes: contract?.verificationNotes ?? null,
        landingStatus: contract?.landingStatus ?? null,
        deliverableSummary: summarizeDeliverable(contract?.deliverable as Deliverable | null),
      }),
      `agent-terminal:${runId}`,
    );
  }

  /** The one landing path (accept/auto ⇒ land). Serialized per repository,
   *  record-then-teardown; the branch is always preserved. Also the boot
   *  re-drive door for `landing_status='pending'`. */
  async landAcceptedContract(contract: Contract): Promise<Contract | null> {
    const prior = this.landingLocks.get(contract.projectId) ?? Promise.resolve();
    const turn = prior.then(() => this.landAcceptedContractLocked(contract), () => this.landAcceptedContractLocked(contract));
    this.landingLocks.set(contract.projectId, turn.catch(() => {}));
    return turn;
  }

  private async landAcceptedContractLocked(contract: Contract): Promise<Contract | null> {
    const project = getProjectById(contract.projectId as ULID);
    if (!project?.folderPath || !contract.worktreePath || !contract.worktreeBaseBranch) {
      return this.contracts.setLanding({
        id: contract.id,
        landingStatus: 'failed',
        landingError: 'missing landing inputs (project folder / worktree path / base branch)',
      });
    }
    const branch =
      (contract.deliverable as { branch?: string } | null)?.branch ??
      contract.worktreePath.split(/[\\/]/).pop() ??
      '';
    this.contracts.setLanding({ id: contract.id, landingStatus: 'pending' });
    const landed = await landBranch({
      projectDir: project.folderPath,
      branch,
      baseBranch: contract.worktreeBaseBranch,
      podName: contract.podName ?? 'agent',
    });
    if (landed.outcome === 'landed') {
      // Durable receipt BEFORE teardown.
      const updated = this.contracts.setLanding({
        id: contract.id,
        landingStatus: 'landed',
        landedBranch: branch,
        landedSha: landed.branchSha,
        landedAt: Date.now(),
        landingError: null,
      });
      await teardownWorktree(project.folderPath, contract.worktreePath);
      return updated;
    }
    return this.contracts.setLanding({
      id: contract.id,
      landingStatus: landed.outcome, // 'conflict' | 'failed' — durable gate; re-land via pc_review_contract accept
      landingError: landed.error,
    });
  }

  // ── helpers ─────────────────────────────────────────────────────────────────

  /** Tool-call evidence for `tool_called` predicates — read from the durable
   *  transcript (one path; live-handle state is a projection). Bridge-qualified
   *  names (`mcp__pc__pc_x`) are stripped to bare names. */
  private evidenceToolCalls(runId: ULID): Array<{ name: string }> {
    try {
      return listConversationEvents(runId)
        .map((r) => r.event as ChatEvent)
        .filter((e): e is Extract<ChatEvent, { kind: 'tool-call' }> => e.kind === 'tool-call')
        .map((e) => ({ name: e.name.replace(/^mcp__[^_]+__/, '') }));
    } catch {
      return [];
    }
  }

  private deliverToOrchestrator(projectId: ULID, text: string, clientMessageId: string): void {
    try {
      this.ctx?.registry.get(projectId).handleSend(text, clientMessageId);
    } catch (err) {
      console.error(`[pc-sdk][dispatch] envelope delivery failed for ${projectId}:`, err);
    }
  }

  /** Boot re-drive: landings interrupted mid-flight (status 'pending') are
   *  idempotent — a crash between merge and receipt converges on re-drive. */
  async recoverPendingLandings(): Promise<void> {
    const { listContractsPendingLanding } = await import('@pc/db');
    for (const row of listContractsPendingLanding()) {
      const contract = this.contracts.get(row.id);
      if (!contract) continue;
      console.warn(`[pc-sdk][dispatch] re-driving pending landing for contract ${contract.id}`);
      await this.landAcceptedContract(contract).catch((err) =>
        console.error(`[pc-sdk][dispatch] landing re-drive failed for ${contract.id}:`, err),
      );
    }
  }

  async disposeAll(): Promise<void> {
    for (const [runId, liveRun] of this.live) {
      clearTimeout(liveRun.wallClock);
      void liveRun.session.dispose().catch(() => {});
      this.live.delete(runId);
    }
  }
}

function refuse(cause: DispatchFailureCause, message: string, httpStatus: number): DispatchResult {
  return { ok: false, cause, message, httpStatus };
}

function summarizeDeliverable(d: Deliverable | null): string | null {
  if (!d) return null;
  switch (d.kind) {
    case 'answer':
      return d.text.length > 400 ? `${d.text.slice(0, 400)}…` : d.text;
    case 'prose':
      return d.text ? (d.text.length > 400 ? `${d.text.slice(0, 400)}…` : d.text) : `prose (${d.ref ?? d.attachmentId ?? 'stored'})`;
    case 'payload':
      return `payload ${JSON.stringify(d.data).slice(0, 400)}`;
    case 'repo':
      return `repo branch=${d.branch ?? '?'} commit=${d.commit?.slice(0, 8) ?? '?'}`;
    case 'external':
      return `external ${d.system} handle=${d.handle}`;
    case 'binary':
      return `binary ${d.mime} (${d.bytes} bytes)`;
    case 'action':
      return `action ${d.tool} ×${d.count}`;
  }
}
