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
import { basename, resolve as resolvePath } from 'node:path';
import {
  appendConversationEvent,
  countAgentRunsForSessionAndPod,
  findActiveContinuation,
  findContractByReviewRun,
  getAgentRunRow,
  getConversationReplayState,
  getPendingAsk,
  getPodForSpawn,
  getProjectById,
  hasContinuation,
  hasOpenPendingAskForRun,
  hasPendingAskForRun,
  insertAgentRunRow,
  listAgentRunsForContract,
  listConversationEvents,
  listTurnBudgetExhaustedRuns,
  markAgentRunDelivered,
  newId,
  setAgentRunCcSession,
  setAgentRunFailureReason,
  setAgentRunPhaseReceipt,
  setWorktreeContractId,
  updateAgentRunStatus,
} from '@pc/db';
import {
  AgentRunMutationGateway,
  ContractService,
  toAgentRunDto,
} from '@pc/app-services';
import type { AgentEventFrame, ChatEvent, Contract, Deliverable as ContractDeliverable } from '@pc/contracts';
import {
  PRESERVED_LIFECYCLE_STATES,
  canTransition,
  deriveAcceptanceCriteriaV2,
  effectiveLandingPolicy,
  getPodDefaultExpectedOutput,
  isExpectedOutputKind,
  parseReviewVerdictPayload,
  parseWorktreeProfile,
  reviewVerdictExpectedOutput,
  type AgentRunRow,
  type ContractLandingAuthorizer,
  type Deliverable,
  type ExpectedOutput,
  type PendingAskOption,
  type Project,
  type RunLifecycleState,
  type ULID,
  type WorktreeCommandStep,
  type WorktreeGitReceipt,
  type WorktreeProfile,
} from '@pc/domain';
import type { AccountRegistry } from '../runner/account-env.ts';
import { CLAUDE_RUNTIME_ID } from '../runner/claude-adapter.ts';
import type { RuntimeEvent, RuntimeRegistry, RuntimeSelection, RuntimeSession } from '../runner/runtime.ts';
import type { McpManager } from '../mcp/manager.ts';
import type { SessionRegistry } from '../chat/registry.ts';
import type { ProjectWebSocketHub } from '../ws/hub.ts';
import { runTurn } from '../chat/turn-runner.ts';
import { AGENT_PC_TOOLS, buildPcToolDefs, mergePcTools } from './pc-bridge.ts';
import { buildAskEnvelope, buildReviewBrief, buildSpecialistInstructions, buildTerminalEnvelope } from './prompt.ts';
import { autoLandBlockers, verifyContract, type VerificationOutcome } from './verification.ts';
import {
  deleteMergedBranch,
  deriveDiffStat,
  git,
  landBranch,
  probeAlreadyLanded,
  provisionReviewCheckout,
  provisionWorktree,
  removeReviewCheckout,
  reviewCheckoutName,
  runProfileCommands,
  sweepOrphanedWorktreeDirs,
  teardownWorktree,
} from './worktrees.ts';

const WALL_CLOCK_DEFAULT_MS = 2 * 60 * 60 * 1000;
const DEFAULT_AGENT_MODEL = 'sonnet';
const DEFAULT_AGENT_MAX_TURNS = 100;
/** Full-review policy (docs/worktree-lifecycle.md 'Full independent review'). */
const REVIEWER_POD_NAME = 'contract-reviewer';
/** Bounded Review/Fix loop (doc: "A bounded retry/escalation policy prevents
 *  endless Review/Fix loops"). Counts reviewer DISPATCHES — a crashed reviewer
 *  burns a round too, so even a permanently-failing reviewer converges on the
 *  orchestrator park instead of looping. */
const MAX_REVIEW_ROUNDS = 2;
/** Bounded auto-continue on turn-budget exhaustion (max-turns fix part 2):
 *  a run that settles 'failed'/'turn-budget-exhausted' is a real terminal
 *  result, not a crash — its worktree/session/contract are intact, so the
 *  service resumes it automatically through the same mechanism
 *  `pc_continue_agent` uses. Bounded per chain (`autoContinueCount`) so a
 *  genuinely stuck/looping task still stops and surfaces to the
 *  orchestrator instead of auto-continuing forever. */
const MAX_AUTO_CONTINUES = 5;
/** Dispatch depth cap (F5 — typed cause 'depth-cap', packages/domain
 *  agent-comms.ts): bounds a NESTING chain of pc_invoke_agent calls
 *  (dispatcher → agent → sub-agent → ...). `parentInvokeDepth` on the
 *  inbound request is the CALLER's own depth; the run being dispatched now
 *  would sit one level deeper. Exceeding the cap refuses the dispatch
 *  outright — no row is minted. */
const MAX_INVOKE_DEPTH = 6;
/** Dispatch loop cap (F5 — typed cause 'loop-cap'): bounds how many times
 *  ONE dispatcher session may dispatch the SAME agent, total. Catches a
 *  looping dispatch pattern (repeatedly re-invoking the same pod) that
 *  never deepens the chain, so it would otherwise sail past the depth cap
 *  unbounded. */
const MAX_DISPATCH_LOOP = 20;
const AUTO_CONTINUE_MESSAGE =
  'You hit your turn budget on the previous attempt and were cut off mid-work — this is not a fresh ' +
  'dispatch. Your worktree, session, and contract are intact exactly as you left them. Pick up where ' +
  'you left off (check git status / your prior progress first) and continue toward completing the ' +
  'contract; do not restart from scratch.';

export type DispatchFailureCause =
  | 'unknown-agent'
  | 'contract-required'
  | 'worktree-provision-failed'
  | 'project-missing'
  | 'invalid-spec'
  | 'run-not-found'
  | 'not-continuable'
  | 'concurrent-continuation'
  | 'not-attached'
  | 'depth-cap'
  | 'loop-cap';

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

interface StartRunInput {
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
}

export class DispatchService {
  private readonly deps: DispatchServiceDeps;
  private readonly gateway = new AgentRunMutationGateway();
  private readonly contracts = new ContractService();
  private ctx: AttachContext | null = null;
  private readonly live = new Map<string, LiveRun>();
  /** Per-repository landing serialization (worktree-lifecycle guard 6): one
   *  active landing mutation per repository at a time. Keyed by canonical
   *  resolved folderPath — two project rows over one folder share the lock. */
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

    // F5 — depth/loop caps, enforced BEFORE any row insert (refused dispatch
    // mints nothing, mirroring the other pre-checks in this method). A
    // dispatch that would sit deeper than MAX_INVOKE_DEPTH is a recursive
    // chain running away; a dispatcher session re-dispatching the same agent
    // past MAX_DISPATCH_LOOP is a looping pattern that never deepens the
    // chain, so depth alone would never catch it.
    const invokeDepth = (input.parentInvokeDepth ?? 0) + 1;
    if (invokeDepth > MAX_INVOKE_DEPTH) {
      return refuse(
        'depth-cap',
        `dispatch would nest to depth ${invokeDepth}, exceeding the max invoke depth (${MAX_INVOKE_DEPTH}) — the agent chain is recursing too deep`,
        422,
      );
    }
    const priorDispatchCount = countAgentRunsForSessionAndPod(input.projectId, input.dispatcherSessionId, input.agentName);
    if (priorDispatchCount >= MAX_DISPATCH_LOOP) {
      return refuse(
        'loop-cap',
        `dispatcher session has already dispatched '${input.agentName}' ${priorDispatchCount} times, at/past the max dispatch loop (${MAX_DISPATCH_LOOP}) — this looks like a looping dispatch`,
        422,
      );
    }

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
    // Insert-the-row-first on failure so the refusal is durable + visible.
    const refuseProvision = (error: string): DispatchResult => {
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
            lifecycleState: 'provisioning',
            queuedAt: now,
          }),
      });
      this.gateway.commitTerminal({
        runId,
        status: 'failed',
        result: null,
        failureCause: 'worktree-provision-failed',
        failureReason: error,
        completedAt: Date.now(),
        lifecycleState: 'provisioning-failed',
      });
      return refuse('worktree-provision-failed', error, 422);
    };
    let worktree: { dir: string; branch: string; baseBranch: string; baseSha: string } | null = null;
    let gitReceipt: WorktreeGitReceipt | null = null;
    let profile: WorktreeProfile | null = null;
    if (spec.kind === 'repo') {
      // Profile is fail-closed: an unreadable profile never half-provisions.
      const parsed = parseWorktreeProfile(project.worktreeProfile);
      if (!parsed.ok) {
        return refuseProvision(`invalid worktree profile: ${parsed.errors.join('; ')}`);
      }
      profile = parsed.profile;
      const provisioned = await provisionWorktree(project.folderPath, runId, {
        baseBranch: profile?.baseBranch ?? null,
        projectId: input.projectId,
      });
      if (!provisioned.ok) return refuseProvision(provisioned.error);
      worktree = provisioned;
      gitReceipt = {
        worktreePath: provisioned.dir,
        branch: provisioned.branch,
        baseBranch: provisioned.baseBranch,
        baseSha: provisioned.baseSha,
        cleanStatus: provisioned.cleanStatus,
      };
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
      // Landing policy is stamped at creation from the issuer's spec; readers
      // of legacy NULL rows fall back through effectiveLandingPolicy().
      landingPolicy: spec.kind === 'repo' ? effectiveLandingPolicy(null, spec) : null,
    });
    // Complete the worktree row's binding — the contract postdates the upsert.
    if (worktree) setWorktreeContractId(worktree.branch, contract.id as ULID);

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
          gitReceipt,
          runtimeId: selection.runtimeId,
          accountId: selection.accountId,
          model: selection.model,
          // Lifecycle (docs/worktree-lifecycle.md): the worktree pipeline only
          // applies to repo runs; everything else stays NULL forever. The row
          // is born post-provision, so 'provisioning' is its first state.
          lifecycleState: spec.kind === 'repo' ? 'provisioning' : null,
          queuedAt: now,
        }),
    });
    this.contracts.setRun(contract.id, runId);

    // Fire the run; the dispatch call returns immediately (always async).
    // Prepare/readiness (profile commands) run BEFORE any agent phase.
    void this.prepareAndStart({
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
      profile,
      freshProvision: true,
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

  /** pc_continue_agent door — manual continuation. Always starts (or
   *  restarts) its own auto-continue budget at 0: a human/orchestrator
   *  directed continuation is a fresh decision, not part of an automatic
   *  chain, even if the parent run itself had been auto-continued. */
  async dispatchContinue(input: {
    projectId: ULID;
    runId: ULID;
    input: string;
    dispatcherSessionId: string;
  }): Promise<DispatchResult> {
    return this.dispatchContinueInternal({ ...input, autoContinueCount: 0 });
  }

  /** Shared continuation mechanism — same session-resume + same worktree +
   *  same contract, whether triggered manually (pc_continue_agent,
   *  `autoContinueCount: 0`) or automatically off a turn-budget-exhausted
   *  terminal (`fireAutoContinue`, `autoContinueCount: parent + 1`). */
  private async dispatchContinueInternal(input: {
    projectId: ULID;
    runId: ULID;
    input: string;
    dispatcherSessionId: string;
    autoContinueCount: number;
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
    // A LIVE independent review reads this contract's worktree and sealed
    // commit: a continuation would mutate the tree under review and could
    // reseal mid-review (the approve path would then cover a never-reviewed
    // commit). Only a live marked reviewer blocks — a dead reviewer's stale
    // marker must not close the review-rejected Fix door.
    if (contract.reviewRunId) {
      const reviewRun = getAgentRunRow(contract.reviewRunId as ULID);
      if (reviewRun && !['completed', 'failed', 'cancelled'].includes(reviewRun.status)) {
        return refuse(
          'concurrent-continuation',
          `an independent review (run ${contract.reviewRunId}) is in flight for this contract — wait for the verdict (or kill the review run) before continuing`,
          409,
        );
      }
    }
    const spec = contract.expectedOutput as ExpectedOutput;

    // Readiness runs on EVERY dispatch (docs/worktree-lifecycle.md) — a
    // continuation re-checks prerequisites in the existing workspace. Fail
    // closed on an unreadable profile, before any row exists.
    let profile: WorktreeProfile | null = null;
    if (spec.kind === 'repo') {
      const parsed = parseWorktreeProfile(project.worktreeProfile);
      if (!parsed.ok) {
        return refuse('worktree-provision-failed', `invalid worktree profile: ${parsed.errors.join('; ')}`, 422);
      }
      profile = parsed.profile;
    }
    const recheckReadiness =
      spec.kind === 'repo' && parent.worktreeDir !== null && (profile?.readinessCommands.length ?? 0) > 0;

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
          // Repo continuation: the workspace already exists — born 'ready'
          // ('preparing' when the profile re-checks readiness first); the
          // turn start stamps 'building'.
          lifecycleState: spec.kind === 'repo' ? (recheckReadiness ? 'preparing' : 'ready') : null,
          autoContinueCount: input.autoContinueCount,
          queuedAt: now,
        }),
    });
    this.contracts.setRun(contract.id, runId);

    void this.prepareAndStart({
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
      profile,
      freshProvision: false,
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

  /** Prepare + Readiness phases (docs/worktree-lifecycle.md 'Provisioning and
   *  readiness') BEFORE any agent phase: run the profile's setup commands
   *  (fresh provisions only), then its readiness checks, sequentially IN the
   *  worktree. Receipts persist durably either way; any nonzero exit is the
   *  typed worktree-provision-failed terminal with the worktree PRESERVED for
   *  debugging — no agent starts in a partially prepared workspace. */
  private async prepareAndStart(
    input: StartRunInput & { profile: WorktreeProfile | null; freshProvision: boolean },
  ): Promise<void> {
    const dir = input.worktree?.dir ?? null;
    const setup = input.freshProvision ? input.profile?.setupCommands ?? [] : [];
    const readiness = input.profile?.readinessCommands ?? [];
    if (dir && (setup.length > 0 || readiness.length > 0)) {
      this.stampLifecycle(input.runId, 'preparing');
      if (setup.length > 0) {
        const prep = await runProfileCommands(dir, setup);
        setAgentRunPhaseReceipt(input.runId, { phase: 'preparation', ok: prep.ok, steps: prep.steps, finishedAt: Date.now() });
        if (!prep.ok) {
          this.failPreparation(input.runId, 'preparation', prep.steps);
          return;
        }
        // A kill during prep has no live handle — it only flips the row
        // terminal. Re-check between phases so a cancelled run never burns
        // readiness commands (up to 20 × 10min, outside the wall clock).
        if (this.runIsTerminal(input.runId)) return;
      }
      if (readiness.length > 0) {
        const ready = await runProfileCommands(dir, readiness);
        setAgentRunPhaseReceipt(input.runId, { phase: 'readiness', ok: ready.ok, steps: ready.steps, finishedAt: Date.now() });
        if (!ready.ok) {
          this.failPreparation(input.runId, 'readiness', ready.steps);
          return;
        }
        if (this.runIsTerminal(input.runId)) return;
      }
      this.stampLifecycle(input.runId, 'ready');
    }
    await this.startRun(input);
  }

  /** True when the row is gone or already terminal (killed/settled during the
   *  wall-clock-uncovered prepare/readiness phase). */
  private runIsTerminal(runId: ULID): boolean {
    const row = getAgentRunRow(runId);
    return !row || row.status === 'completed' || row.status === 'failed' || row.status === 'cancelled';
  }

  /** Preparation/readiness failure → the existing typed provision-failure
   *  terminal. The receipt is already persisted; the worktree is preserved
   *  (retention rules — never torn down on a prep failure). */
  private failPreparation(runId: ULID, phase: 'preparation' | 'readiness', steps: WorktreeCommandStep[]): void {
    const failed = steps[steps.length - 1];
    const reason =
      `${phase} command failed (exit ${failed?.exitCode ?? '?'}${failed?.timedOut ? ', timed out' : ''}): ` +
      `${failed?.command ?? '(none)'} — receipt persisted; worktree preserved for debugging`;
    this.gateway.commitTerminal({
      runId,
      status: 'failed',
      result: null,
      failureCause: 'worktree-provision-failed',
      failureReason: reason,
      completedAt: Date.now(),
      lifecycleState: 'provisioning-failed',
    });
    void this.verifyAndLand(runId, 'failed').catch((err) => {
      console.error(`[pc-sdk][dispatch] post-prep-failure settle crashed for ${runId}:`, err);
    });
  }

  private async startRun(input: StartRunInput): Promise<void> {
    // Preflight: a run killed during prepare/readiness (no live handle yet) is
    // terminal on the row only. Starting anyway would spawn a bypassPermissions
    // agent for a cancelled run — and the 'spawning' announce below would
    // overwrite the terminal status, resurrecting it. Refuse instead.
    const preflight = getAgentRunRow(input.runId);
    if (!preflight || preflight.status === 'completed' || preflight.status === 'failed' || preflight.status === 'cancelled') {
      console.warn(
        `[pc-sdk][dispatch] run ${input.runId} is '${preflight?.status ?? 'missing'}' before agent start — not launching`,
      );
      return;
    }
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

    // Agent phase starts NOW — the worktree pipeline moves to 'building'.
    this.stampLifecycle(input.runId, 'building');
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

    const terminalResult = await runTurn(turn, {
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

    if (terminalResult.terminal === 'turn-end') {
      this.settleTerminal(runId, { status: 'completed', result: lastText || null, failureCause: null, failureReason: null });
    } else if (terminalResult.outcome === 'budget-exhausted') {
      // A real terminal result (SDK error_max_turns/error_max_budget_usd), not
      // a crash — distinct failureCause so the run reads as resumable.
      this.settleTerminal(runId, {
        status: 'failed',
        result: lastText || null,
        failureCause: 'turn-budget-exhausted',
        failureReason:
          terminalResult.numTurns !== null
            ? `hit turn budget (${terminalResult.numTurns} turns) — resumable`
            : 'hit turn budget — resumable',
      });
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

  /** Durable worktree-pipeline stamp (docs/worktree-lifecycle.md). No-op on
   *  NULL-lifecycle rows (non-repo/legacy). The gateway rejects illegal moves;
   *  a rejection here is a logic bug surfaced loudly — never a pipeline
   *  breaker (the dispatch/landing flow continues on the status column). */
  private stampLifecycle(runId: ULID, to: RunLifecycleState): void {
    const row = getAgentRunRow(runId);
    if (!row || row.lifecycleState === null) return;
    try {
      updateAgentRunStatus({ id: runId, status: row.status, lifecycleState: to });
    } catch (err) {
      console.error(`[pc-sdk][dispatch] lifecycle stamp '${row.lifecycleState}'→'${to}' refused for ${runId}:`, err);
      return;
    }
    // Publish the fresh snapshot: post-terminal pipeline moves (merge-ready
    // park, conflict, merged→completed, stranded) never re-fire commitTerminal,
    // so without this frame the live feed only learns of them on a full
    // reload (the Merge-ready card's openRun would no-op meanwhile).
    this.gateway.announceRunChange({ runId, reason: 'reconciled' });
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
      // canTransition pre-check keeps the phantom-safe kill un-throwable.
      ...(row.lifecycleState !== null && canTransition(row.lifecycleState, 'cancelled')
        ? { lifecycleState: 'cancelled' as const }
        : {}),
    });
    const liveRun = this.live.get(runId);
    if (liveRun) {
      clearTimeout(liveRun.wallClock);
      this.live.delete(runId);
      void liveRun.session.dispose().catch(() => {});
    }
    // A killed REVIEW run must not wedge its target: route the (verdict-less)
    // terminal into the review gate — re-dispatch or the exhausted park.
    if (publication !== null) {
      const reviewTarget = findContractByReviewRun(runId);
      if (reviewTarget) {
        const reviewerContract = row.contractId ? this.contracts.get(row.contractId) : null;
        void this.settleReviewVerdict(reviewTarget.id, runId, reviewerContract, 'cancelled').catch((err) => {
          console.error(`[pc-sdk][dispatch] review-kill settlement failed for contract ${reviewTarget.id}:`, err);
        });
      }
      // A killed reviewer's disposable checkout is reclaimed here — the kill
      // path never reaches verifyAndLand's reclaim.
      this.reclaimReviewCheckout(row);
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

    // The seal is immutable past THIS run's settlement: verification/review
    // already routed off the sealed commit at the terminal, and nothing
    // re-verifies a post-terminal reseal — a leftover builder process must
    // not swap the verified commit. New work goes through a continuation
    // (fresh run id), so the Fix door stays open.
    if (row.status === 'completed' || row.status === 'failed' || row.status === 'cancelled') {
      return {
        ok: false,
        message: `run is '${row.status}' — its deliverable is sealed; dispatch a continuation to submit new work`,
        httpStatus: 409,
      };
    }
    // Guard-4 companion: an in-flight independent review consumes the CURRENT
    // sealed commit. Resealing under a live review would let an approve land
    // a commit nobody reviewed — refused (retryable after the verdict).
    if (contract.reviewRunId) {
      return {
        ok: false,
        message: 'an independent review is in flight for this contract — the sealed deliverable cannot change until the verdict settles',
        httpStatus: 409,
      };
    }

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
      if (!status.ok) {
        return {
          ok: false,
          message: `worktree state unreadable — git status failed (${status.stderr || 'no output'}); restore the worktree, then resubmit`,
          httpStatus: 409,
        };
      }
      if (status.stdout.length > 0) {
        return {
          ok: false,
          message: 'worktree has uncommitted changes — commit everything, then resubmit (verification reads committed state)',
          httpStatus: 409,
        };
      }
      // Seal the commit from the worktree HEAD — never the builder's value.
      // Verification anchors on this commit and landing merges the branch tip,
      // so a builder-supplied SHA below the tip would let unverified tip
      // commits land. A mismatching supplied commit is refused (retryable,
      // like the dirty-tree seal); an unreadable HEAD refuses too.
      const head = await git(['rev-parse', 'HEAD'], row.worktreeDir);
      if (!head.ok) {
        return {
          ok: false,
          message: `worktree state unreadable — git rev-parse HEAD failed (${head.stderr || 'no output'}); restore the worktree, then resubmit`,
          httpStatus: 409,
        };
      }
      const repoDeliverable = deliverable as Extract<Deliverable, { kind: 'repo' }>;
      if (repoDeliverable.commit && repoDeliverable.commit !== head.stdout) {
        return {
          ok: false,
          message: `submitted commit '${repoDeliverable.commit}' does not match the worktree HEAD ${head.stdout} — the branch tip is what gets verified and landed; omit commit or resubmit with HEAD`,
          httpStatus: 409,
        };
      }
      deliverable = {
        ...repoDeliverable,
        branch: repoDeliverable.branch || row.worktreeDir.split(/[\\/]/).pop() || undefined,
        commit: head.stdout,
        baseBranch: repoDeliverable.baseBranch || row.worktreeBaseBranch || undefined,
        baseCommit: row.worktreeBaseSha || repoDeliverable.baseCommit || undefined,
      };
      // Guard 3 companion: diff stats are DERIVED from git over TRUSTED
      // endpoints (provision base .. sealed HEAD), never trusted from the
      // builder. Prose fields stay; the numbers are overwritten when git
      // can produce them.
      const filled = deliverable as Extract<Deliverable, { kind: 'repo' }>;
      if (filled.baseCommit) {
        const derived = await deriveDiffStat(row.worktreeDir, filled.baseCommit, head.stdout);
        // Underivable stats are dropped, not passed through from the builder.
        deliverable = { ...filled, diffStat: derived ?? undefined };
      } else if (filled.diffStat) {
        deliverable = { ...filled, diffStat: undefined };
      }
    }

    const updated = this.contracts.setDeliverable({
      id: contract.id,
      deliverable: deliverable as unknown as ContractDeliverable,
      report: input.report ?? null,
    });
    if (!updated) return { ok: false, message: 'contract vanished mid-submit', httpStatus: 500 };
    markAgentRunDelivered(input.agentRunId, Date.now());
    // Sealed repo deliverable ⇒ the pipeline moves to deterministic verification.
    if (expectedKind === 'repo') this.stampLifecycle(input.agentRunId, 'verifying');
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
    // The producing run must be terminal first: reviewing a LIVE run stamps
    // lifecycle states its own settlement/boot recovery cannot legally leave,
    // and accept would merge + tear down the worktree under a running agent.
    if (contract.agentRunId) {
      const producing = getAgentRunRow(contract.agentRunId as ULID);
      if (producing && !['completed', 'failed', 'cancelled'].includes(producing.status)) {
        return {
          ok: false,
          message: `producing run ${contract.agentRunId} is still '${producing.status}' — review after the run settles`,
          httpStatus: 409,
        };
      }
    }
    // Orchestrator override supersedes an in-flight independent review: clear
    // the marker FIRST (the reviewer's eventual terminal then finds no marker,
    // so its stale verdict is void and nothing re-dispatches), THEN kill the
    // live reviewer — otherwise it burns the wall clock for nothing and, on
    // accept, still occupies its checkout during teardown.
    if (contract.reviewRunId) {
      const supersededReviewId = contract.reviewRunId as ULID;
      this.contracts.setReviewState({ id: contract.id, reviewRunId: null, reviewSealedCommit: null });
      const reviewRun = getAgentRunRow(supersededReviewId);
      if (reviewRun && !['completed', 'failed', 'cancelled'].includes(reviewRun.status)) {
        await this.killRun(contract.projectId as ULID, supersededReviewId, {
          failureCause: 'cancelled',
          failureReason: 'independent review superseded by orchestrator pc_review_contract',
        });
      }
    }
    const notes = input.notes ?? null;
    if (input.verdict === 'reject') {
      const updated = this.contracts.setVerification({
        id: contract.id,
        verificationStatus: 'failed',
        verificationNotes: notes ?? 'rejected by orchestrator review',
      });
      // review-rejected is NOT necessarily terminal — fixing stays legal.
      if (contract.agentRunId) this.stampLifecycle(contract.agentRunId as ULID, 'review-rejected');
      return updated ? { ok: true, contract: updated } : { ok: false, message: 'contract vanished', httpStatus: 500 };
    }
    // Accept IS the revalidation (guard 7's recovery door): the orchestrator
    // reviewed against the repo as it stands NOW, so the verified base moves
    // to the current target tip — a stale-base park re-lands on re-accept.
    let verifiedBaseSha: string | undefined;
    if ((contract.expectedOutput as ExpectedOutput | null)?.kind === 'repo') {
      const project = getProjectById(contract.projectId as ULID);
      if (project?.folderPath && contract.worktreeBaseBranch) {
        const tip = await git(['rev-parse', `refs/heads/${contract.worktreeBaseBranch}`], project.folderPath);
        if (tip.ok) verifiedBaseSha = tip.stdout;
      }
    }
    let updated = this.contracts.setVerification({
      id: contract.id,
      verificationStatus: 'passed',
      verificationNotes: notes ?? 'accepted by orchestrator review',
      ...(verifiedBaseSha !== undefined ? { verifiedBaseSha } : {}),
    });
    if (!updated) return { ok: false, message: 'contract vanished', httpStatus: 500 };
    if ((updated.expectedOutput as ExpectedOutput | null)?.kind === 'repo') {
      // An accept that supersedes an in-flight review leaves the producing
      // run at 'reviewing' — hop to merge-ready (when legal, mirroring the
      // approve path) so the landing chain's 'merging' stamp has a legal
      // source. Other park states (review-rejected/conflict/failed) already
      // have their own edge into 'merging'.
      this.stampLifecycleWhenLegal((updated.agentRunId ?? null) as ULID | null, 'merge-ready');
      updated = (await this.landAcceptedContract(updated, 'orchestrator')) ?? updated;
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

    // Bounded auto-continue gate (max-turns fix part 2) — decided BEFORE the
    // terminal write so the ceiling message rides the SAME commit, never a
    // follow-up patch. Only 'turn-budget-exhausted' is eligible (never
    // 'aborted'/'unexpected-exit'/'cancelled'/etc.) — those settle as they
    // do today. `row.autoContinueCount` is this run's OWN position in the
    // chain (stamped at insert time, immutable since), so it's read once
    // here rather than after the mutation.
    const autoContinueEligible = status === 'failed' && failureCause === 'turn-budget-exhausted';
    const autoContinue = autoContinueEligible && row.autoContinueCount < MAX_AUTO_CONTINUES;
    if (autoContinueEligible && !autoContinue) {
      failureReason = `hit turn budget ${MAX_AUTO_CONTINUES}× — needs attention`;
    }

    // Lifecycle: dispatch-terminal failed/cancelled end the pipeline too; a
    // repo COMPLETION does not — its lifecycle continues (verify → land →
    // teardown) past the status terminal, so 'completed' stamps nothing here.
    // canTransition pre-check (like killRun): review/land states stamped onto
    // a still-live run (review-rejected/conflict/merged/completed) refuse
    // 'failed' — omit the stamp rather than throw and strand the row.
    const lifecycleTarget = status === 'failed' ? ('failed' as const) : ('cancelled' as const);
    const lifecycleState: RunLifecycleState | undefined =
      row.lifecycleState === null || status === 'completed' || !canTransition(row.lifecycleState, lifecycleTarget)
        ? undefined
        : lifecycleTarget;
    const publication = this.gateway.commitTerminal({
      runId,
      status,
      result: input.result,
      failureCause: status === 'completed' ? null : failureCause,
      failureReason: status === 'completed' ? null : failureReason,
      completedAt: Date.now(),
      ...(lifecycleState !== undefined ? { lifecycleState } : {}),
    });
    if (!publication) return; // already terminal (idempotent)

    if (autoContinue) {
      // Suppressed envelope: this terminal is an intermediate stop on the
      // way to auto-continuation, never a chat turn for the orchestrator.
      // verifyAndLand (contract verification + envelope + review-verdict
      // routing) runs only on the FINAL outcome — skipping it here also
      // avoids reclaiming a review checkout the continuation is about to
      // resume in.
      void this.fireAutoContinue(runId, row).catch((err) => {
        console.error(`[pc-sdk][dispatch] auto-continue crashed for ${runId}:`, err);
      });
      return;
    }

    void this.verifyAndLand(runId, status).catch((err) => {
      console.error(`[pc-sdk][dispatch] verify/land crashed for ${runId}:`, err);
    });
  }

  /** Fire one automatic continuation off a 'turn-budget-exhausted' terminal —
   *  the SAME session-resume + same worktree + same contract mechanism
   *  `pc_continue_agent` uses, just triggered by the service instead of a
   *  human/orchestrator. `parentRow` is the pre-terminal snapshot (its
   *  `autoContinueCount` is this attempt's zero-based position in the
   *  chain). Idempotent alongside `recoverPendingAutoContinues`: both check
   *  `hasContinuation` first, so a restart between the terminal commit and
   *  this call never double-fires. */
  private async fireAutoContinue(runId: ULID, parentRow: AgentRunRow): Promise<void> {
    if (hasContinuation(runId)) return; // already fired (boot re-entry raced this call)
    const attempt = parentRow.autoContinueCount + 1;
    console.warn(`[auto-continue] run ${runId} budget-exhausted, attempt ${attempt}/${MAX_AUTO_CONTINUES}`);
    const result = await this.dispatchContinueInternal({
      projectId: parentRow.projectId,
      runId,
      input: AUTO_CONTINUE_MESSAGE,
      dispatcherSessionId: parentRow.dispatcherSessionId,
      autoContinueCount: attempt,
    });
    if (!result.ok) {
      // The chain can't continue (contract/agent/worktree gone, or a
      // concurrent continuation raced this one) — the existing terminal row
      // is the final outcome; patch its reason and deliver the envelope off
      // it instead of silently wedging.
      console.error(
        `[auto-continue] run ${runId} attempt ${attempt}/${MAX_AUTO_CONTINUES} could not be dispatched (${result.cause}: ${result.message}) — settling as failed`,
      );
      setAgentRunFailureReason(
        runId,
        `hit turn budget, but the auto-continuation could not be dispatched (${result.message}) — needs attention`,
      );
      void this.verifyAndLand(runId, 'failed').catch((err) => {
        console.error(`[pc-sdk][dispatch] verify/land crashed for ${runId}:`, err);
      });
    }
  }

  /** Boot re-entry for bounded auto-continue (docs: max-turns fix part 2,
   *  mirrors recoverPendingReviews). Ordering (index.ts): AFTER attach — an
   *  auto-continuation needs the live server context to dispatch. A run that
   *  settled 'failed'/'turn-budget-exhausted' but never got its
   *  continuation fired (the crash window between the terminal commit and
   *  `fireAutoContinue`'s own insert) resumes here; `hasContinuation` keeps
   *  it idempotent against a continuation that DID make it through before
   *  the crash (including one that itself later failed for an unrelated,
   *  non-eligible cause — the chain stops there, same as the live path). */
  async recoverPendingAutoContinues(): Promise<void> {
    for (const row of listTurnBudgetExhaustedRuns()) {
      try {
        if (row.autoContinueCount >= MAX_AUTO_CONTINUES) continue; // ceiling already reached
        if (hasContinuation(row.id)) continue; // already fired
        console.warn(
          `[auto-continue] resuming after restart — run ${row.id}, attempt ${row.autoContinueCount + 1}/${MAX_AUTO_CONTINUES}`,
        );
        await this.fireAutoContinue(row.id as ULID, row);
      } catch (err) {
        console.error(`[pc-sdk][dispatch] auto-continue re-entry failed for run ${row.id} — continuing with the rest:`, err);
      }
    }
  }

  private async verifyAndLand(runId: ULID, terminalStatus: 'completed' | 'failed' | 'cancelled'): Promise<void> {
    const row = getAgentRunRow(runId);
    if (!row) return;
    let contract = row.contractId ? this.contracts.get(row.contractId) : null;
    const project = getProjectById(row.projectId);

    // Fresh outcome from THIS settlement — the auto-land gate refuses to read
    // a stale row status (guard 5: missing evidence never means pass).
    let outcome: VerificationOutcome | null = null;
    if (contract && terminalStatus === 'completed') {
      outcome = await verifyContract({
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
      // Re-read after the git/predicate awaits: reviewContract has no attach
      // gate, so an orchestrator accept can verify AND land this contract
      // while verifyContract runs (boot recovery racing an HTTP accept, or a
      // normal-path interleave). A landed receipt is final — never overwrite
      // its 'passed'/notes with this now-stale outcome.
      const latest = this.contracts.get(contract.id);
      if (latest?.landingStatus === 'landed') {
        contract = latest;
      } else {
        contract = this.contracts.setVerification({
          id: contract.id,
          verificationStatus: outcome.verificationStatus,
          verificationNotes: outcome.notes,
          ...(outcome.escalatedToReview ? { verificationTier: 'orchestrator-review' as const } : {}),
        });
        // Typed failure state; pending/inconclusive stays 'verifying' (recovery
        // resumes at verification/review as evidence permits).
        if (outcome.verificationStatus === 'failed') this.stampLifecycle(runId, 'verification-failed');
      }
    } else if (contract && terminalStatus === 'failed') {
      // Same landed-receipt finality as above.
      const latest = this.contracts.get(contract.id);
      contract =
        latest?.landingStatus === 'landed'
          ? latest
          : this.contracts.setVerification({
              id: contract.id,
              verificationStatus: 'failed',
              verificationNotes: `run failed (${row.failureCause ?? 'unknown'}) before verification`,
            });
    }

    // Landing policy (docs/worktree-lifecycle.md): auto-merge is OPT-IN. A
    // passed repo contract lands automatically only under the 'auto-merge'
    // policy (stamped at creation; legacy NULL rows read through the spec's
    // auto_land); otherwise it parks merge-ready for the orchestrator to
    // review the diff and authorize via pc_review_contract accept.
    const spec = contract?.expectedOutput as ExpectedOutput | null;
    if (contract && contract.landingStatus !== 'landed' && contract.verificationStatus === 'passed' && spec?.kind === 'repo') {
      const policy = effectiveLandingPolicy(contract.landingPolicy, spec);
      if (policy === 'auto-merge') {
        // Guard 5: auto-merge is policy + POSITIVE evidence, never model
        // confidence. Any missing piece (no fresh outcome, inconclusive
        // results, undeclared scope evidence, an open ask) parks merge-ready
        // with the WHY on verificationNotes — the terminal envelope carries it
        // to the orchestrator, whose accept stays the recovery door.
        const blockers = autoLandBlockers({
          landingPolicy: policy,
          spec,
          outcome,
          // OPEN asks only — an answered ask is resolved, not a blocker.
          hasPendingAsk: hasOpenPendingAskForRun(runId),
        });
        if (blockers.length === 0) {
          contract = (await this.landAcceptedContract(contract, 'auto')) ?? contract;
        } else {
          const refusal = `auto-land refused — parked merge-ready for orchestrator review: ${blockers.join('; ')}`;
          contract =
            this.contracts.setVerification({
              id: contract.id,
              verificationStatus: contract.verificationStatus,
              verificationNotes: contract.verificationNotes ? `${contract.verificationNotes}\n${refusal}` : refusal,
            }) ?? contract;
          this.stampLifecycle(runId, 'merge-ready');
        }
      } else if (policy === 'full-review') {
        // Full independent review (docs/worktree-lifecycle.md): a verified
        // pass NEVER parks merge-ready — a review specialist consumes the
        // SEALED commit (guard 4). Approve lands through the same guarded
        // path; reject opens the bounded Fix ↺ Review loop.
        this.stampLifecycle(runId, 'reviewing');
        contract = (await this.ensureIndependentReview(contract.id as ULID)) ?? contract;
      } else {
        // default-review park — landingStatus stays null; the envelope says so.
        this.stampLifecycle(runId, 'merge-ready');
      }
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
        reviewInFlight: contract?.reviewRunId != null,
        deliverableSummary: summarizeDeliverable(contract?.deliverable as Deliverable | null),
      }),
      `agent-terminal:${runId}`,
    );

    // Independent-review settlement: when THIS run was a review dispatch (the
    // durable reviewRunId marker on the target contract), its terminal carries
    // the verdict for the contract under review.
    const reviewTarget = findContractByReviewRun(runId);
    if (reviewTarget) {
      await this.settleReviewVerdict(reviewTarget.id, runId, contract, terminalStatus);
    }
    // A review run's disposable checkout is reclaimed at its terminal — also
    // when the marker was already superseded (no reviewTarget).
    this.reclaimReviewCheckout(freshRow);
  }

  // ── full independent review (docs/worktree-lifecycle.md :175-187) ───────────

  /** Route a review run's terminal into the target contract: approve → land
   *  via the normal guarded path (authorizer 'reviewer'); reject → verification
   *  'failed' with the structured findings + lifecycle 'review-rejected' (the
   *  Fix door — a continuation reseals, re-verifies, re-reviews, guard 4);
   *  no usable verdict (crash/kill/garbage payload) → clear the marker and
   *  re-enter the review gate (bounded), never wedged. */
  private async settleReviewVerdict(
    targetId: ULID,
    reviewRunId: ULID,
    reviewerContract: Contract | null,
    terminalStatus: 'completed' | 'failed' | 'cancelled',
  ): Promise<void> {
    const target = this.contracts.get(targetId);
    if (!target) return;
    // A landed receipt is final; abandoned work never re-enters review.
    if (target.landingStatus === 'landed' || target.landingStatus === 'abandoned') return;
    // Stale verdict: the marker moved on (orchestrator override via
    // pc_review_contract, or a newer round) — this run's verdict is void.
    if (target.reviewRunId !== reviewRunId) return;
    const producingRunId = (target.agentRunId ?? null) as ULID | null;
    // The verdict counts only off a COMPLETED reviewer whose own contract
    // verified (schema_valid over the payload) — never off prose or a crash.
    const verdict =
      terminalStatus === 'completed' && reviewerContract?.verificationStatus === 'passed'
        ? parseReviewVerdictPayload((reviewerContract.deliverable as { data?: unknown } | null)?.data)
        : null;

    if (verdict?.verdict === 'approve') {
      // Bind the approval to the EXACT seal the reviewer was briefed on and
      // to a SETTLED producing run: a mid-review reseal (fix continuation,
      // leftover builder process) means this approval covers a commit nobody
      // reviewed, and a live continuation means landing would merge + tear
      // down a worktree under a running agent (the same hazard reviewContract
      // refuses). Either way the verdict is unusable — re-enter the gate.
      const sealedNow = (target.deliverable as { commit?: string } | null)?.commit ?? null;
      const briefedSeal = target.reviewSealedCommit ?? null;
      const producingRow = producingRunId ? getAgentRunRow(producingRunId) : null;
      const producingLive =
        producingRow !== null && !['completed', 'failed', 'cancelled'].includes(producingRow.status);
      if ((briefedSeal !== null && sealedNow !== briefedSeal) || producingLive) {
        console.warn(
          `[pc-sdk][dispatch] review run ${reviewRunId} approved seal ${briefedSeal ?? '(unrecorded)'} but contract ` +
            `${targetId} now seals ${sealedNow ?? '(none)'}${producingLive ? ' with a live producing run' : ''} — `,
          'verdict void; re-entering the review gate.',
        );
        this.contracts.setReviewState({ id: target.id, reviewRunId: null, reviewSealedCommit: null });
        await this.ensureIndependentReview(targetId);
        return;
      }
      // Verification stays 'passed'; the approval receipt is appended.
      const note =
        `independent review approved (run ${reviewRunId}, round ${target.reviewRound ?? '?'})` +
        (verdict.findings.length > 0 ? `\nfindings: ${JSON.stringify(verdict.findings)}` : '');
      this.contracts.setVerification({
        id: target.id,
        verificationStatus: 'passed',
        verificationNotes: target.verificationNotes ? `${target.verificationNotes}\n${note}` : note,
      });
      this.contracts.setReviewState({ id: target.id, reviewRunId: null, reviewSealedCommit: null });
      // reviewing → merge-ready; landAcceptedContract stamps merging onward.
      this.stampLifecycleWhenLegal(producingRunId, 'merge-ready');
      const fresh = this.contracts.get(target.id);
      if (fresh) await this.landAcceptedContract(fresh, 'reviewer');
      return;
    }

    if (verdict?.verdict === 'reject') {
      // Structured findings tied to contract + sealed commit ride
      // verificationNotes as JSON; 'review-rejected' is the durable Fix door.
      this.contracts.setVerification({
        id: target.id,
        verificationStatus: 'failed',
        verificationNotes: JSON.stringify(
          {
            independentReview: {
              reviewRunId,
              round: target.reviewRound,
              sealedCommit: (target.deliverable as { commit?: string } | null)?.commit ?? null,
              verdict: 'reject',
              findings: verdict.findings,
            },
          },
          null,
          2,
        ),
      });
      this.contracts.setReviewState({ id: target.id, reviewRunId: null, reviewSealedCommit: null });
      this.stampLifecycleWhenLegal(producingRunId, 'review-rejected');
      return;
    }

    // No usable verdict — the review died. Clear the marker and re-enter the
    // gate: another round while the budget lasts, the exhausted park after.
    console.warn(
      `[pc-sdk][dispatch] review run ${reviewRunId} ended '${terminalStatus}' with no usable verdict for contract ${targetId} — re-entering the review gate.`,
    );
    this.contracts.setReviewState({ id: target.id, reviewRunId: null, reviewSealedCommit: null });
    await this.ensureIndependentReview(targetId);
  }

  /** The idempotent full-review re-entry door. Called on a verified pass, on a
   *  dead reviewer, and from boot (recoverPendingReviews). Live review in
   *  flight → no-op. Round budget left → dispatch the next reviewer against
   *  the sealed commit. Exhausted → park loudly for the orchestrator/user
   *  (verification 'failed', doc :186-187) — pc_review_contract stays the
   *  human override either way. */
  private async ensureIndependentReview(contractId: ULID): Promise<Contract | null> {
    const contract = this.contracts.get(contractId);
    if (!contract) return null;
    if (contract.landingStatus === 'landed' || contract.landingStatus === 'abandoned') return contract;
    if (contract.verificationStatus !== 'passed') return contract;
    // Live in-flight review — nothing to do. A TERMINAL run behind the marker
    // is a crash without a verdict: fall through and re-dispatch.
    if (contract.reviewRunId) {
      const reviewRun = getAgentRunRow(contract.reviewRunId as ULID);
      if (reviewRun && !['completed', 'failed', 'cancelled'].includes(reviewRun.status)) return contract;
    }
    const round = contract.reviewRound ?? 0;
    if (round >= MAX_REVIEW_ROUNDS) {
      const note = `review rounds exhausted (${round}/${MAX_REVIEW_ROUNDS}) — parked for orchestrator/user review (pc_review_contract)`;
      this.contracts.setReviewState({ id: contract.id, reviewRunId: null, reviewSealedCommit: null });
      const updated = this.contracts.setVerification({
        id: contract.id,
        verificationStatus: 'failed',
        verificationNotes: contract.verificationNotes ? `${contract.verificationNotes}\n${note}` : note,
      });
      this.stampLifecycleWhenLegal((contract.agentRunId ?? null) as ULID | null, 'review-rejected');
      return updated ?? this.contracts.get(contract.id);
    }
    return this.dispatchReviewRun(contract, round + 1);
  }

  /** Dispatch one review specialist run against the target's SEALED commit.
   *  The reviewer gets a DISPOSABLE DETACHED CHECKOUT of the sealed commit as
   *  cwd (never the builder's live worktree — prompt-only read-only is not
   *  enforcement); its own contract is payload-kind (verdict schema), no
   *  lifecycle vocabulary. The durable round + reviewRunId + briefed-seal
   *  marker land BEFORE the agent starts, so every crash window is
   *  re-dispatchable and the approve path can re-check the seal. */
  private async dispatchReviewRun(target: Contract, round: number): Promise<Contract | null> {
    const ctx = this.ctx;
    if (!ctx) {
      // Boot window (pre-attach): the durable shape — 'full-review' + passed +
      // no live marker — is exactly what recoverPendingReviews re-enters.
      console.warn(
        `[pc-sdk][dispatch] full-review contract ${target.id} needs a reviewer but the server is not attached — deferred to recoverPendingReviews`,
      );
      return this.contracts.get(target.id);
    }
    const projectId = target.projectId as ULID;
    const sealedCommit = (target.deliverable as { commit?: string } | null)?.commit ?? null;
    // Fail-closed park: an undispatchable review routes to the SAME recovery
    // door as every refused auto-land — orchestrator review of the diff.
    const parkForOrchestrator = (why: string): Contract | null => {
      // Clear any stale in-flight marker first: a park with reviewRunId still
      // pointing at a dead reviewer would be hidden from the merge-ready
      // surface (the web filters reviewRunId === null) — the park's own
      // recovery door would be obscured.
      this.contracts.setReviewState({ id: target.id, reviewRunId: null, reviewSealedCommit: null });
      const note = `independent review not dispatchable — ${why}; parked for orchestrator review (pc_review_contract)`;
      const updated = this.contracts.setVerification({
        id: target.id,
        verificationStatus: 'passed',
        verificationNotes: target.verificationNotes ? `${target.verificationNotes}\n${note}` : note,
      });
      this.stampLifecycleWhenLegal((target.agentRunId ?? null) as ULID | null, 'merge-ready');
      return updated;
    };
    if (!target.worktreePath || !sealedCommit) return parkForOrchestrator('missing worktree or sealed commit');
    const bundle = getPodForSpawn(REVIEWER_POD_NAME, projectId);
    if (!bundle) return parkForOrchestrator(`no '${REVIEWER_POD_NAME}' agent available`);
    const project = getProjectById(projectId);
    if (!project?.folderPath) return parkForOrchestrator('project folder missing');
    const producing = target.agentRunId ? getAgentRunRow(target.agentRunId as ULID) : null;

    const runId = newId() as ULID;
    // Reviewer isolation: a disposable DETACHED checkout of the sealed commit,
    // never the builder's live worktree. Read-only is otherwise enforced by
    // prompt alone (the reviewer runs bypassPermissions) — a stray reviewer
    // commit would move the agent branch tip (hard-failing the landing
    // tip==seal guard) and untracked check artifacts would dirty the tree the
    // Fix door resubmits from. Reclaimed at the reviewer's terminal.
    const checkout = await provisionReviewCheckout(project.folderPath, runId, sealedCommit);
    if (!checkout.ok) return parkForOrchestrator(`review checkout provisioning failed: ${checkout.error}`);
    const now = Date.now();
    const account = this.deps.accounts.resolveForProject(projectId);
    const selection: RuntimeSelection = {
      runtimeId: CLAUDE_RUNTIME_ID,
      accountId: account.id,
      model: bundle.agent.model ?? DEFAULT_AGENT_MODEL,
    };
    const spec = reviewVerdictExpectedOutput();
    const reviewContract = this.contracts.create({
      projectId,
      pmRef: target.pmRef ?? null,
      podName: REVIEWER_POD_NAME,
      expectedOutput: spec,
      acceptanceCriteria: deriveAcceptanceCriteriaV2(spec),
      verificationTier: 'auto',
    });
    const brief = buildReviewBrief({
      contractId: target.id,
      podName: target.podName,
      worktreeDir: checkout.dir,
      branch: (target.deliverable as { branch?: string } | null)?.branch ?? null,
      sealedCommit,
      baseBranch: target.worktreeBaseBranch,
      baseSha: target.verifiedBaseSha ?? target.worktreeBaseSha,
      expectedOutput: target.expectedOutput as ExpectedOutput,
      report: target.report,
      reviewRound: round,
    });
    const publication = this.gateway.commitRunChange({
      reason: 'queued',
      mutate: () =>
        insertAgentRunRow({
          id: runId,
          projectId,
          podName: REVIEWER_POD_NAME,
          dispatcherSessionId: producing?.dispatcherSessionId ?? 'full-review',
          ccSessionId: randomUUID(),
          status: 'queued',
          input: brief,
          pmRef: target.pmRef ?? null,
          parentInvokeDepth: (producing?.parentInvokeDepth ?? 0) + 1,
          contractId: reviewContract.id as ULID,
          // The reviewer runs in its own detached checkout of the sealed
          // commit — never the builder's live worktree. Payload-kind
          // contract ⇒ no lifecycle vocabulary.
          worktreeDir: checkout.dir,
          runtimeId: selection.runtimeId,
          accountId: selection.accountId,
          model: selection.model,
          queuedAt: now,
        }),
    });
    this.contracts.setRun(reviewContract.id, runId);
    // Durable round + in-flight marker BEFORE the agent starts: a crash after
    // this write finds the marker (dead run ⇒ re-enter, round consumed); a
    // crash before it re-enters cleanly on the same round. The briefed seal
    // rides the marker — approve settlement re-checks it (a mid-review reseal
    // voids the verdict).
    const marked = this.contracts.setReviewState({
      id: target.id,
      reviewRound: round,
      reviewRunId: runId,
      reviewSealedCommit: sealedCommit,
    });
    const note = `independent review round ${round} dispatched (run ${runId})`;
    const priorNotes = marked?.verificationNotes ?? target.verificationNotes;
    this.contracts.setVerification({
      id: target.id,
      verificationStatus: 'passed',
      verificationNotes: priorNotes ? `${priorNotes}\n${note}` : note,
    });

    void this.prepareAndStart({
      row: publication.run as unknown as { runId: string },
      runId,
      projectId,
      pod: bundle.agent,
      contextDocs: bundle.contextDocs,
      contract: reviewContract,
      spec,
      selection,
      worktree: {
        dir: checkout.dir,
        branch: '',
        baseBranch: target.worktreeBaseBranch ?? '',
        baseSha: target.worktreeBaseSha ?? '',
      },
      firstMessage: brief,
      resumeNativeSessionId: null,
      profile: null,
      freshProvision: false,
    }).catch((err) => {
      this.settleTerminal(runId, {
        status: 'failed',
        result: null,
        failureCause: 'spawn-error',
        failureReason: err instanceof Error ? err.message : String(err),
      });
    });
    return this.contracts.get(target.id);
  }

  /** Boot entry (index.ts, AFTER attach — a review dispatch needs the live
   *  server context). Crash safety for the review phase: a full-review
   *  contract whose reviewer died (the boot sweep failed it loudly — no seal,
   *  no verdict) re-enters the review gate re-dispatchable, never wedged. The
   *  durable shape is landingPolicy 'full-review' + verification 'passed' +
   *  landing NULL; ensureIndependentReview resolves each: dead/absent marker ⇒
   *  next round (or the exhausted park), fresh boot dispatch otherwise. */
  async recoverPendingReviews(): Promise<void> {
    const { listContractsAwaitingIndependentReview } = await import('@pc/db');
    for (const row of listContractsAwaitingIndependentReview()) {
      try {
        console.warn(
          `[pc-sdk][boot-recovery] full-review contract ${row.id} awaits independent review — re-entering the review gate.`,
        );
        await this.ensureIndependentReview(row.id as ULID);
      } catch (err) {
        console.error(
          `[pc-sdk][boot-recovery] review re-entry failed for contract ${row.id} — continuing with the rest:`,
          err,
        );
      }
    }
  }

  /** The one landing path (accept/auto ⇒ land). Serialized per repository,
   *  record-then-teardown; the branch is always preserved. Also the boot
   *  re-drive door for `landing_status='pending'`. */
  async landAcceptedContract(
    contract: Contract,
    authorizer: ContractLandingAuthorizer = 'orchestrator',
  ): Promise<Contract | null> {
    const project = getProjectById(contract.projectId as ULID);
    const key = project?.folderPath ? landingLockKey(project.folderPath) : `project:${contract.projectId}`;
    const prior = this.landingLocks.get(key) ?? Promise.resolve();
    const turn = prior.then(
      () => this.landAcceptedContractLocked(contract, authorizer),
      () => this.landAcceptedContractLocked(contract, authorizer),
    );
    this.landingLocks.set(key, turn.catch(() => {}));
    return turn;
  }

  private async landAcceptedContractLocked(
    contract: Contract,
    authorizer: ContractLandingAuthorizer,
  ): Promise<Contract | null> {
    // Re-read under the lock: the pre-lock snapshot may be stale (auto-land
    // racing review-accept, boot re-drive racing accept). A landed receipt is
    // final — a second drive must never overwrite its authorizer/landedAt.
    const current = this.contracts.get(contract.id);
    if (!current) return null;
    if (current.landingStatus === 'landed') return current;
    contract = current;
    // Lifecycle stamps ride the producing run (null for legacy contracts).
    const lifecycleRunId = (contract.agentRunId ?? null) as ULID | null;
    const stamp = (to: RunLifecycleState) => {
      if (lifecycleRunId) this.stampLifecycle(lifecycleRunId, to);
    };
    const project = getProjectById(contract.projectId as ULID);
    if (!project?.folderPath || !contract.worktreePath || !contract.worktreeBaseBranch) {
      stamp('failed');
      return this.contracts.setLanding({
        id: contract.id,
        landingStatus: 'failed',
        landingError: 'missing landing inputs (project folder / worktree path / base branch)',
      });
    }
    // Only the SYSTEM-provisioned worktree branch lands. The agent-supplied
    // deliverable.branch is untrusted — 'main' or an already-merged ref would
    // falsely converge the probe below — so a mismatch refuses instead.
    const branch = contract.worktreePath.split(/[\\/]/).pop() ?? '';
    const deliveredBranch = (contract.deliverable as { branch?: string } | null)?.branch;
    if (deliveredBranch && deliveredBranch !== branch) {
      stamp('failed');
      return this.contracts.setLanding({
        id: contract.id,
        landingStatus: 'failed',
        landingError: `deliverable branch '${deliveredBranch}' does not match the provisioned worktree branch '${branch}' — only the recorded agent branch can land`,
      });
    }
    // Landing merges the branch TIP, but verification covered the SEALED
    // deliverable commit. A tip that moved off the sealed commit after submit
    // (extra commits, a reset onto the base tip) would land — or falsely
    // converge the probe below on — unverified work, so a mismatch refuses.
    const sealedCommit = (contract.deliverable as { commit?: string } | null)?.commit;
    if (sealedCommit) {
      const tip = await git(['rev-parse', '--verify', '--quiet', `refs/heads/${branch}`], project.folderPath);
      if (tip.ok && tip.stdout !== sealedCommit) {
        stamp('failed');
        return this.contracts.setLanding({
          id: contract.id,
          landingStatus: 'failed',
          landingError: `agent branch '${branch}' tip ${tip.stdout.slice(0, 12)} is not the sealed deliverable commit ${sealedCommit.slice(0, 12)} — the branch moved after submission; only the verified commit can land`,
        });
      }
    }
    // The base this landing is validated against: the accept-time revalidated
    // tip when one exists, else the provision-time base.
    const validatedBase = contract.verifiedBaseSha ?? contract.worktreeBaseSha;
    // Recovery — idempotency probe BEFORE any mutation: ancestry proof means a
    // prior drive already merged (crash before the receipt). Converge to the
    // landed receipt; never re-run `git merge`.
    const probe = await probeAlreadyLanded(project.folderPath, branch, contract.worktreeBaseBranch, validatedBase);
    if (probe.landed) {
      const updated = this.contracts.setLanding({
        id: contract.id,
        landingStatus: 'landed',
        landedBranch: branch,
        landedSha: probe.branchSha,
        targetShaBefore: probe.targetShaBefore,
        targetShaAfter: probe.mergeSha,
        mergeSha: probe.mergeSha,
        landingAuthorizer: authorizer,
        verifiedBaseSha: validatedBase,
        landedAt: contract.landedAt ?? Date.now(),
        landingError: null,
      });
      // Probe convergence: positive ancestry proof, no new mutation — the
      // lifecycle jumps straight to merged, then teardown completes it.
      stamp('merged');
      stamp('tearing-down');
      // Failed reclaim = stranded isolation, never a false 'completed' receipt.
      const toreDown = await teardownWorktree(project.folderPath, contract.worktreePath, this.cleanupCommandsFor(project));
      stamp(toreDown ? 'completed' : 'stranded');
      // Landed + reclaimed ⇒ resolve earlier preserved parks of this contract.
      if (toreDown) this.resolvePreservedRuns(contract.id as ULID);
      // Confirmed land ⇒ the branch is merged history now; delete it (branch
      // survives for unlanded/abandoned work only — best-effort, never blocks).
      await deleteMergedBranch(project.folderPath, branch);
      this.sweepOrphansFor(project);
      return updated;
    }
    // Guard 7 — stale verification never silently lands: the target must still
    // sit at the base the verification covered. No auto-rebase; the recovery
    // door is pc_review_contract accept, which revalidates against the
    // current tip (stamps verifiedBaseSha) and re-lands.
    const targetHead = await git(['rev-parse', `refs/heads/${contract.worktreeBaseBranch}`], project.folderPath);
    if (!targetHead.ok) {
      stamp('failed');
      return this.contracts.setLanding({
        id: contract.id,
        landingStatus: 'failed',
        landingError: `cannot resolve target branch tip '${contract.worktreeBaseBranch}': ${targetHead.stderr}`,
      });
    }
    if (!validatedBase || targetHead.stdout !== validatedBase) {
      // Stale base is the lifecycle's 'conflict' gate: preserved worktree,
      // recovery via re-accept (revalidate) — never a silent land.
      stamp('conflict');
      return this.contracts.setLanding({
        id: contract.id,
        landingStatus: 'stale-base',
        landingError: validatedBase
          ? `target '${contract.worktreeBaseBranch}' advanced to ${targetHead.stdout.slice(0, 12)} past the verified base ${validatedBase.slice(0, 12)} — review the diff and re-land via pc_review_contract accept, which revalidates against the current tip (no auto-rebase)`
          : `no verified base recorded for '${contract.worktreeBaseBranch}' — re-land via pc_review_contract accept, which revalidates against the current tip`,
      });
    }
    // Authorizer is stamped at 'pending' so a boot re-drive keeps who asked.
    this.contracts.setLanding({ id: contract.id, landingStatus: 'pending', landingAuthorizer: authorizer });
    stamp('merging');
    const landed = await landBranch({
      projectDir: project.folderPath,
      branch,
      baseBranch: contract.worktreeBaseBranch,
      podName: contract.podName ?? 'agent',
      expectedHeadSha: targetHead.stdout,
    });
    if (landed.outcome === 'landed') {
      // Durable full merge receipt BEFORE teardown. landedSha stays the
      // BRANCH TIP; the merge commit rides the new receipt columns.
      const updated = this.contracts.setLanding({
        id: contract.id,
        landingStatus: 'landed',
        landedBranch: branch,
        landedSha: landed.branchSha,
        targetShaBefore: landed.targetShaBefore,
        targetShaAfter: landed.mergeSha,
        mergeSha: landed.mergeSha,
        landingAuthorizer: authorizer,
        verifiedBaseSha: validatedBase,
        landedAt: Date.now(),
        landingError: null,
      });
      stamp('merged');
      stamp('tearing-down');
      // Failed reclaim = stranded isolation, never a false 'completed' receipt.
      const toreDown = await teardownWorktree(project.folderPath, contract.worktreePath, this.cleanupCommandsFor(project));
      stamp(toreDown ? 'completed' : 'stranded');
      // Landed + reclaimed ⇒ resolve earlier preserved parks of this contract.
      if (toreDown) this.resolvePreservedRuns(contract.id as ULID);
      // Confirmed land ⇒ the branch is merged history now; delete it (branch
      // survives for unlanded/abandoned work only — best-effort, never blocks).
      await deleteMergedBranch(project.folderPath, branch);
      this.sweepOrphansFor(project);
      return updated;
    }
    // conflict + stale-base both land on the lifecycle 'conflict' gate;
    // a mechanical failure is 'failed'. Branch + worktree preserved either way.
    stamp(landed.outcome === 'failed' ? 'failed' : 'conflict');
    return this.contracts.setLanding({
      id: contract.id,
      landingStatus: landed.outcome, // 'conflict' | 'failed' | 'stale-base' — durable gate; re-land via pc_review_contract accept
      landingError: landed.error,
    });
  }

  // ── helpers ─────────────────────────────────────────────────────────────────

  /** Cleanup commands for teardown — best-effort read; an unreadable profile
   *  yields none (teardown must never block on profile garbage). */
  private cleanupCommandsFor(project: Project | null): string[] {
    const parsed = parseWorktreeProfile(project?.worktreeProfile ?? null);
    return parsed.ok ? parsed.profile?.cleanupCommands ?? [] : [];
  }

  /** Best-effort orphan GC after a land completes teardown — a locked
   *  directory from THIS teardown, or an earlier one, gets a second chance
   *  right away instead of waiting for the next boot sweep. Never blocks the
   *  landing receipt on its result. */
  private sweepOrphansFor(project: Project | null): void {
    if (!project?.folderPath) return;
    sweepOrphanedWorktreeDirs(project.folderPath).catch((err) =>
      console.error(`[pc-sdk][worktree] orphan sweep failed for project ${project.id}:`, err),
    );
  }

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

  /** Boot entry — doc Recovery CASE 4 ('sealed commit present after process
   *  loss → recover to verification/review as evidence permits'). The boot
   *  sweep (boot-recovery.ts) SKIPS non-terminal runs that THEMSELVES
   *  delivered (run.deliveredAt — the contract's deliverable alone can be a
   *  continuation's inherited parent seal) and leaves them to this door. The
   *  agent TURN cannot resume — in-process runtime sessions die with the
   *  server — but delivery is the done-signal, so nothing the lost turn could
   *  add matters past the seal: the run settles 'completed' and
   *  verification/landing re-fires from the durable evidence (a fresh
   *  verifyContract outcome over the sealed commit + transcript, never a
   *  stale row status). Runs that did not deliver keep the sweep's loud
   *  'failed server-restart'. A second pass re-fires verification for runs
   *  already terminal whose verification write the crash swallowed.
   *
   *  Ordering (index.ts): AFTER the boot sweep, BEFORE recoverPendingLandings
   *  → recoverIncompleteTeardowns → stranded scan → attach. Why here:
   *  - an auto-land fired from this door serializes on the same per-repo
   *    landing lock as the pending re-drives (guard 6 holds across both);
   *  - the stranded scan must see this door's FINAL verification/teardown
   *    state, or a resumed run's worktree would be misclassified;
   *  - attach comes last, so no fresh dispatch races any recovery step.
   *  Open asks are cancelled only AFTER verification: an unresolved ask must
   *  still block auto-land (guard 5) exactly as it would have uninterrupted;
   *  only then is the now-unanswerable ask (its run is settled) closed out.
   *  Pre-attach, the terminal envelope is dropped (ctx null) — the durable
   *  contract/receipt state is the record the orchestrator reads. */
  async recoverSealedRuns(): Promise<void> {
    const { listNonTerminalAgentRuns, listOpenPendingAsksForProject, markPendingAskCancelled } = await import('@pc/db');
    for (const run of listNonTerminalAgentRuns()) {
      // Per-run isolation: one bad row never aborts boot (Wave-D precedent).
      try {
        const contract = run.contractId ? this.contracts.get(run.contractId) : null;
        // Keyed on THIS run's deliveredAt stamp (markAgentRunDelivered — once
        // per run, at submit), never the contract's deliverable alone: the
        // contract carries forward to continuations, so its deliverable can be
        // the PARENT run's seal. A continuation that died undelivered must
        // fail loudly in the boot sweep — settling it 'completed' here would
        // fake success and re-fire verification over stale evidence.
        if (!contract?.deliverable || run.deliveredAt === null) continue;
        // Sealed evidence resumes the pipeline at verification; merge-ready
        // (already past verification) keeps its park.
        let lifecycleState: RunLifecycleState | undefined;
        if (
          run.lifecycleState !== null &&
          run.lifecycleState !== 'merge-ready' &&
          canTransition(run.lifecycleState, 'verifying')
        ) {
          lifecycleState = 'verifying';
        }
        const publication = this.gateway.commitTerminal({
          runId: run.id,
          status: 'completed',
          result: null,
          failureCause: null,
          failureReason: null,
          completedAt: Date.now(),
          ...(lifecycleState !== undefined ? { lifecycleState } : {}),
        });
        if (!publication) continue;
        console.warn(
          `[pc-sdk][boot-recovery] agent run ${run.id} (${run.podName}) died with a sealed deliverable — settled completed; re-firing verification from durable evidence.`,
        );
        await this.verifyAndLand(run.id, 'completed');
        const now = Date.now();
        for (const ask of listOpenPendingAsksForProject(run.projectId)) {
          if (ask.agentRunId === run.id) markPendingAskCancelled(ask.id, now);
        }
      } catch (err) {
        console.error(`[pc-sdk][boot-recovery] sealed-run recovery failed for ${run.id} — continuing with the rest:`, err);
      }
    }
    // Companion crash window: a run made TERMINAL (settleTerminal's — or this
    // door's own — commitTerminal) whose verification write never landed.
    // Invisible to the non-terminal scan above, and without this pass the
    // stranded scan would durably strand its worktree (null verification is
    // not review-parked) — while a crash one moment EARLIER converges fully.
    // Shape: contract holds a sealed deliverable, verificationStatus is null,
    // producing run terminal with its own deliveredAt stamp. Re-fire
    // verification from the durable evidence (same guards, same landing lock).
    const { listContractsSealedUnverified } = await import('@pc/db');
    for (const contract of listContractsSealedUnverified()) {
      try {
        if (contract.landingStatus === 'landed' || contract.landingStatus === 'abandoned') continue;
        const runId = contract.agentRunId;
        if (!runId) continue;
        const run = getAgentRunRow(runId);
        if (!run || run.deliveredAt === null) continue;
        if (run.status !== 'completed' && run.status !== 'failed') continue;
        console.warn(
          `[pc-sdk][boot-recovery] contract ${contract.id} holds a sealed deliverable with no verification outcome (crash between settlement and verification) — re-firing verification for run ${runId}.`,
        );
        await this.verifyAndLand(runId, run.status);
        const now = Date.now();
        for (const ask of listOpenPendingAsksForProject(run.projectId)) {
          if (ask.agentRunId === runId) markPendingAskCancelled(ask.id, now);
        }
      } catch (err) {
        console.error(
          `[pc-sdk][boot-recovery] sealed-unverified recovery failed for contract ${contract.id} — continuing with the rest:`,
          err,
        );
      }
    }
  }

  /** Boot re-drive — doc Recovery CASE 5 ("'merging' without a stored receipt
   *  → inspect Git ancestry before deciding") + CASE 7 ('pending landing →
   *  return to the landing queue after revalidation'): landings interrupted
   *  mid-flight (status 'pending') re-drive through landAcceptedContract,
   *  which probes ancestry FIRST (already merged ⇒ converge to the landed
   *  receipt, never a second `git merge`) and otherwise re-runs the FULL
   *  guard stack — base advancement parks 'stale-base' like a fresh landing. */
  async recoverPendingLandings(): Promise<void> {
    const { listContractsPendingLanding } = await import('@pc/db');
    for (const row of listContractsPendingLanding()) {
      const contract = this.contracts.get(row.id);
      if (!contract) continue;
      console.warn(`[pc-sdk][dispatch] re-driving pending landing for contract ${contract.id}`);
      // Re-drive under the authorizer stamped at 'pending' (crash-safe).
      await this.landAcceptedContract(contract, contract.landingAuthorizer ?? 'orchestrator').catch((err) =>
        console.error(`[pc-sdk][dispatch] landing re-drive failed for ${contract.id}:`, err),
      );
    }
  }

  /** Boot entry — doc Recovery CASE 6 ('merge positively complete but
   *  teardown incomplete → resume teardown'). The landing receipt is durable
   *  BEFORE teardown (guard 9), so a crash in between leaves a landed
   *  contract whose worktree row is still active. Resume the reclaim only:
   *  cleanup commands + worktree remove + the guarded merged → tearing-down →
   *  completed stamps ('stranded' on a failed reclaim — never a false
   *  'completed'). No git merge ever re-runs here — the receipt already
   *  proves it (recovery never reruns a non-idempotent mutation off a stale
   *  status). Ordering (index.ts): right after recoverPendingLandings (whose
   *  re-drives tear down inline) and BEFORE the stranded scan — a landed
   *  worktree awaiting reclaim must never classify stranded; one whose
   *  reclaim genuinely fails here strands correctly, receipt intact. */
  async recoverIncompleteTeardowns(): Promise<void> {
    const { listContractsLandedTeardownIncomplete } = await import('@pc/db');
    for (const contract of listContractsLandedTeardownIncomplete()) {
      // Per-contract isolation: one bad row never aborts boot.
      try {
        const project = getProjectById(contract.projectId);
        if (!project?.folderPath || !contract.worktreePath) continue;
        console.warn(
          `[pc-sdk][boot-recovery] contract ${contract.id} landed but its worktree survived — resuming teardown of ${contract.worktreePath}.`,
        );
        const runId = contract.agentRunId;
        // Crash mid-'merging': the durable receipt proves the merge happened.
        this.stampLifecycleWhenLegal(runId, 'merged');
        this.stampLifecycleWhenLegal(runId, 'tearing-down');
        const ok = await teardownWorktree(project.folderPath, contract.worktreePath, this.cleanupCommandsFor(project));
        this.stampLifecycleWhenLegal(runId, ok ? 'completed' : 'stranded');
        // A reclaim that finally succeeded resolves earlier preserved parks
        // (a previously 'stranded' run exits the feed here).
        if (ok) this.resolvePreservedRuns(contract.id as ULID);
        // Confirmed land (this contract only re-enters here already landed)
        // ⇒ delete the now-merged branch — best-effort, never blocks.
        const branch = contract.landedBranch ?? contract.worktreePath.split(/[\\/]/).pop() ?? '';
        if (branch) await deleteMergedBranch(project.folderPath, branch);
        this.sweepOrphansFor(project);
      } catch (err) {
        console.error(`[pc-sdk][boot-recovery] teardown resume failed for contract ${contract.id} — continuing with the rest:`, err);
      }
    }
  }

  /** stampLifecycle + a canTransition pre-check — recovery paths stamp
   *  checkpoint CHAINS where some hops are legitimately already past
   *  (idempotent re-stamp is legal; an already-later state skips the hop
   *  instead of logging a refused transition every boot). */
  private stampLifecycleWhenLegal(runId: ULID | null, to: RunLifecycleState): void {
    if (!runId) return;
    const row = getAgentRunRow(runId);
    if (!row || row.lifecycleState === null || !canTransition(row.lifecycleState, to)) return;
    this.stampLifecycle(runId, to);
  }

  /** Resolution door (docs 'Teardown and retention' — preserved states stay
   *  visible UNTIL RESOLVED): once the contract's work positively landed AND
   *  its worktree was reclaimed, every terminal run of the contract still
   *  parked in a preserved lifecycle state (an earlier rejected/failed/parked
   *  attempt, or a mechanically failed landing whose re-drive succeeded)
   *  resolves to 'completed' — otherwise the preserved run feed grows without
   *  bound (failed/stranded had no exit at all). */
  private resolvePreservedRuns(contractId: ULID): void {
    for (const run of listAgentRunsForContract(contractId)) {
      if (run.lifecycleState === null) continue;
      if (!(PRESERVED_LIFECYCLE_STATES as readonly string[]).includes(run.lifecycleState)) continue;
      this.stampLifecycleWhenLegal(run.id, 'completed');
    }
  }

  /** Reclaim a review run's disposable detached checkout — identified by the
   *  deterministic `review-<id8>` dir name, so a builder worktree can never
   *  match. Best-effort: an orphan (crash window, Windows file lock) is inert
   *  (detached HEAD, no branch, no landing state). */
  private reclaimReviewCheckout(row: AgentRunRow): void {
    const dir = row.worktreeDir;
    if (!dir || basename(dir) !== reviewCheckoutName(row.id)) return;
    const project = getProjectById(row.projectId);
    if (!project?.folderPath) return;
    void removeReviewCheckout(project.folderPath, dir).catch(() => {});
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

/** Landing-lock key: canonical resolved repo path, case-folded on win32. */
function landingLockKey(folderPath: string): string {
  const resolved = resolvePath(folderPath);
  return process.platform === 'win32' ? resolved.toLowerCase() : resolved;
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
