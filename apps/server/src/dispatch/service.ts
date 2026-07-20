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

import { createHash } from 'node:crypto';
import { readFile, rm } from 'node:fs/promises';
import { basename, join } from 'node:path';
import {
  bindProjectRepositoryIdentity,
  closeOpenConversationToolCalls,
  commitConversationEvent,
  confirmAgentRunRuntimeSessionReceipt,
  countAgentRunsForSessionAndPod,
  createReviewCheckoutReservation,
  findActiveContinuation,
  findContractByReviewRun,
  failAgentRunRuntimeResume,
  failAgentRunRuntimeResumeInDb,
  getAgentRunRow,
  getPendingAsk,
  getPodForSpawn,
  getProjectById,
  getCurrentReviewCheckoutForContract,
  getReviewCheckoutById,
  getReviewCheckoutForReviewer,
  getWorktreeForContract,
  getWorktreeForLandedContract,
  hasContinuation,
  hasOpenPendingAskForRun,
  hasPendingAskForRun,
  insertAgentRunRow,
  isAgentRunNativeResumeReady,
  listAgentRunsForContract,
  listConversationEvents,
  listOpenPendingAsksForProject,
  listReviewCheckoutBlockingCandidates,
  listReviewCheckoutsNeedingRecovery,
  listTurnBudgetExhaustedRuns,
  listContractsNeedingAbandonmentRecovery,
  markAgentRunDelivered,
  markReviewCheckoutTeardownPending,
  newId,
  prepareAgentRunCreate,
  prepareAgentRunResume,
  prepareAgentRunResumeInDb,
  runtimeSelectionForAgentRun,
  setAgentRunFailureReason,
  setReviewCheckoutCleanupError,
  setReviewCheckoutProvisionReceipt,
  setReviewCheckoutVerdictReceipt,
  settleReviewCheckoutTeardown,
  setWorktreeContractId,
  specialistSnapshotForAgentRun,
  updateAgentRunStatus,
} from '@pc/db';
import {
  AgentRunMutationGateway,
  ContractService,
  toAgentRunDto,
} from '@pc/app-services';
import {
  conversationFamilyForEvent,
  runtimeSelectionsEqual,
  type ApproveWorktreeAbandonmentRequest,
  type ChatEvent,
  type Contract,
  type Deliverable as ContractDeliverable,
  type SubscriptionQuotaObservationBatch,
} from '@pc/contracts';
import {
  PRESERVED_LIFECYCLE_STATES,
  canTransition,
  createNotRequiredWorktreePhaseReceipt,
  createReviewCheckoutPhaseReceipt,
  deriveAcceptanceCriteriaV2,
  effectiveLandingPolicy,
  getPodDefaultExpectedOutput,
  isExpectedOutputKind,
  isPositivePreparationReceiptForRun,
  isPositiveWorktreePhaseReceipt,
  isMatchingReviewCheckoutProvision,
  isMatchingReviewCheckoutTeardown,
  isMatchingReviewCheckoutVerdict,
  isReviewCheckoutGitReceipt,
  isReviewCheckoutRuntimeReady,
  isRepositoryIdentityReceipt,
  isWorktreeAbandonmentReceipt,
  parseReviewVerdictPayload,
  parseWorktreeProfile,
  reviewVerdictExpectedOutput,
  resolveContractLandingPolicy,
  reviewCheckoutPhaseMatchesRun,
  type AgentRunRow,
  type ContractLandingAuthorizer,
  type ContractLandingPolicy,
  type Deliverable,
  type ExpectedOutput,
  type PendingAskOption,
  type Project,
  type RepositoryIdentityReceipt,
  type ReviewCheckout,
  type ReviewCheckoutAuthority,
  type ReviewCheckoutGitReceipt,
  type ReviewCheckoutPhaseEvidence,
  type ReviewCheckoutProvisionReceipt,
  type ReviewCheckoutTeardownReceipt,
  type ReviewCheckoutVerdictReceipt,
  type RunLifecycleState,
  type SpecialistExecutionSnapshot,
  type PodSpawnBundle,
  type ULID,
  type WorktreeCommandStep,
  type WorktreeAbandonmentPreview,
  type WorktreeAbandonmentReceipt,
  type WorktreeGitReceipt,
  type WorktreePhaseReceipt,
  type WorktreeProfile,
} from '@pc/domain';
import type {
  CreateRuntimeSession,
  RuntimeContinuationRequest,
  RuntimeEvent,
  RuntimeSelection,
  RuntimeSelectionValidation,
  RuntimeSession,
} from '../runner/runtime.ts';
import type { SessionRegistry } from '../chat/registry.ts';
import type { ConversationRelay } from '../chat/conversation-relay.ts';
import type { ProjectWebSocketHub } from '../ws/hub.ts';
import { runTurn } from '../chat/turn-runner.ts';
import {
  AGENT_PC_TOOLS,
  DELIVERABLE_FILE_NAME,
  buildPcToolDefs,
  mergePcTools,
  shapeDeliverableFileContents,
} from './pc-bridge.ts';
import { buildAskEnvelope, buildReviewBrief, buildSpecialistInstructions, buildTerminalEnvelope } from './prompt.ts';
import { autoLandBlockers, verifyContract, type VerificationOutcome } from './verification.ts';
import {
  requireRepositoryWorktreeRoot,
  RepositoryLeaseError,
  repositoryLeaseManager,
  type RepositoryLeaseGuard,
} from './repository-lease.ts';
import {
  deriveDiffStat,
  git,
  inspectReviewCheckout,
  landBranch,
  preflightBaseBranch,
  probeAlreadyLanded,
  provisionReviewCheckout,
  provisionWorktree,
  rollbackUnpublishedWorktree,
  removeReviewCheckout,
  requireReviewCheckoutOwnedRoot,
  reviewCheckoutName,
  runProfileCommands,
  inspectWorktreeAbandonment,
  settleAbandonedWorktree,
  settleLandedWorktree,
  sweepOrphanedWorktreeDirs,
} from './worktrees.ts';

const WALL_CLOCK_DEFAULT_MS = 2 * 60 * 60 * 1000;
const DEFAULT_AGENT_MAX_TURNS = 100;

function specialistSnapshot(bundle: PodSpawnBundle): SpecialistExecutionSnapshot {
  const material = {
    specialistId: bundle.agent.id,
    name: bundle.agent.name,
    charter: bundle.agent.prompt,
    contextDocs: bundle.contextDocs.map((doc) => ({
      id: doc.id,
      title: doc.title,
      body: doc.body,
      updatedAt: doc.updatedAt,
    })),
    maxTurns: bundle.agent.maxTurns ?? DEFAULT_AGENT_MAX_TURNS,
  };
  const revision = `sha256:${createHash('sha256').update(JSON.stringify(material)).digest('hex')}`;
  return {
    specialistId: material.specialistId,
    revision,
    name: material.name,
    charter: material.charter,
    contextDocs: material.contextDocs,
    maxTurns: material.maxTurns,
  };
}
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
const RUNTIME_START_FAILURE_REASON = 'agent runtime session could not be started';
const RUNTIME_SEND_FAILURE_REASON = 'agent runtime turn could not be sent';

export type DispatchFailureCause =
  | 'unknown-agent'
  | 'contract-required'
  | 'worktree-provision-failed'
  | 'repository-occupied'
  | 'repository-unavailable'
  | 'project-missing'
  | 'invalid-spec'
  | 'runtime-selection-unavailable'
  | 'run-not-found'
  | 'not-continuable'
  | 'concurrent-continuation'
  | 'not-attached'
  | 'depth-cap'
  | 'loop-cap';

export type DispatchResult =
  | { ok: true; run: ReturnType<typeof toAgentRunDto> }
  | { ok: false; cause: DispatchFailureCause; message: string; httpStatus: number };

export type WorktreeAbandonmentPreviewResult =
  | { ok: true; preview: WorktreeAbandonmentPreview }
  | { ok: false; message: string; httpStatus: 404 | 409 | 503 };

export type WorktreeAbandonmentApprovalResult =
  | { ok: true; settlement: 'completed' | 'pending'; contract: Contract }
  | { ok: false; message: string; httpStatus: 404 | 409 | 503 };

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
  resolveNewSpecialistSelection(input: {
    projectId: ULID;
    /** A specialist may omit its model; provider-specific defaulting belongs
     *  to the composition root, not this provider-neutral dispatcher. */
    model: string | null;
    effort: string | null;
  }): Promise<RuntimeSelectionValidation>;
  preflightRuntimeSession(
    selection: RuntimeSelection,
    continuation: RuntimeContinuationRequest,
  ): Promise<RuntimeSelectionValidation>;
  mintSpecialistRuntimeSession(
    input: CreateRuntimeSession & { continuation: RuntimeContinuationRequest },
  ): Promise<RuntimeSession>;
  /** Non-critical global quota sink. Attribution is fenced before invocation. */
  onSubscriptionQuota?: (batch: SubscriptionQuotaObservationBatch) => void;
  /** Injectable command boundary keeps async repository evidence races
   * deterministic under guard tests. Production uses the canonical helper. */
  gitCommand?: typeof git;
  /** Injectable verification boundary keeps evidence-drift races
   * deterministic under guard tests. Production uses the canonical helper. */
  verifyContract?: typeof verifyContract;
  /** Injectable provisioning boundary keeps shutdown-after-provision races
   * deterministic under guard tests. Production uses the canonical helper. */
  provisionWorktree?: typeof provisionWorktree;
  /** Composition-seam fact: does a runtime bridge app tools? Mirrors the same
   * `AgentRuntimeAdapter.appToolBridge` gate the mint uses. A runtime that does
   * NOT bridge tools mints with zero pc_* tools, so its specialist cannot call
   * pc_submit_deliverable — the file-based delivery door is opened for it. The
   * dispatcher stays provider-neutral: it reads the fact, never the adapter. */
  appToolBridgeForRuntime?: (runtimeId: string) => 'supported' | 'unsupported';
}

interface AttachContext {
  registry: SessionRegistry;
  hub: ProjectWebSocketHub<ULID>;
  conversationRelay?: ConversationRelay;
  serverPort: number;
}

/** The structured shape `deliverToOrchestrator` renders through
 *  `injectAgentEnvelope` (Part A: typed per-run chat cards, not plain-text
 *  user bubbles). */
interface AgentEnvelope {
  text: string;
  runId: ULID;
  agentName: string;
  pendingAskId?: ULID;
  status: 'waiting' | 'done' | 'failed';
  summary: string;
}

interface LiveRun {
  session: RuntimeSession;
  selection: RuntimeSelection;
  /** Process-local correlation until specialist attempt stamps land in N3. */
  continuationAttemptId: string;
  receiptConfirmed: boolean;
  wallClock: ReturnType<typeof setTimeout>;
}

interface RuntimeRetirement {
  promise: Promise<void>;
  status: 'pending' | 'failed';
  error: unknown;
}

interface PostTerminalTask {
  promise: Promise<void>;
  status: 'pending' | 'completed' | 'failed';
  error: unknown;
}

interface StartRunInput {
  row: { runId: string };
  runId: ULID;
  projectId: ULID;
  snapshot: SpecialistExecutionSnapshot;
  contract: Contract;
  spec: ExpectedOutput;
  selection: RuntimeSelection;
  worktree: { dir: string; branch: string; baseBranch: string; baseSha: string } | null;
  firstMessage: string;
  resumeNativeSessionId: string | null;
  repositoryLease: RepositoryLeaseGuard | null;
  /** Independent reviewers use a payload contract, so the ordinary repo-kind
   * builder gate cannot authorize their cwd. This callback re-reads durable
   * workspace authority and fresh Git evidence at each native mint door. */
  authorizeRuntimeCwd?: () => Promise<string | null>;
}

/** Collapse canonical lifecycle evidence to one executed call per callId.
 * Requested/denied calls did not execute, and repeated running/terminal
 * observations must never inflate a contract's tool_called count. A running
 * observation is the positive execution receipt; exceptional requested ->
 * failed closure is explicitly not execution. */
export function executedToolCallsFromEvents(events: readonly ChatEvent[]): Array<{ name: string }> {
  const calls = new Map<string, { name: string; executed: boolean; corrupt: boolean }>();
  for (const event of events) {
    if (event.kind !== 'tool-state') continue;
    const prior = calls.get(event.callId);
    if (!prior) {
      calls.set(event.callId, {
        name: event.name,
        executed: event.state === 'running',
        corrupt: false,
      });
      continue;
    }
    calls.set(event.callId, {
      name: prior.name,
      executed: prior.executed || event.state === 'running',
      corrupt: prior.corrupt || prior.name !== event.name,
    });
  }
  return [...calls.values()]
    .filter((call) => call.executed && !call.corrupt)
    .map((call) => ({ name: call.name.replace(/^mcp__[^_]+__/, '') }));
}

export class DispatchService {
  private readonly deps: DispatchServiceDeps;
  private readonly gateway = new AgentRunMutationGateway();
  private readonly contracts = new ContractService();
  private readonly repositoryLeases = repositoryLeaseManager;
  private ctx: AttachContext | null = null;
  private readonly live = new Map<string, LiveRun>();
  /** Provider disposal is an asynchronous mutation boundary. A terminal DB
   * row is not quiescence evidence until this tracked promise resolves. Failed
   * retirement stays visible and blocks worktree reclamation. */
  private readonly retiringRuns = new Map<string, RuntimeRetirement>();
  /** Full preparation/runtime tasks remain mutation authority until they
   * return. This closes kill-during-preparation/mint windows where the DB row
   * is terminal before a late native session has been positively disposed. */
  private readonly runTasks = new Map<string, Promise<void>>();
  /** Terminal DB state is not repository quiescence: verification, review,
   * landing, and auto-continuation may still execute after runtime disposal.
   * Retained entries make every observer share one post-terminal owner. */
  private readonly postTerminalTasks = new Map<string, PostTerminalTask>();
  /** A stale, never-installed native session whose disposal failed is durable
   * process-local uncertainty and must continue blocking repository cleanup. */
  private readonly runtimeRetirementFailures = new Map<string, unknown>();
  /** One provider resume per paused run. Boot recovery and an incoming answer
   * may race; both must share the same candidate instead of overwriting a live
   * runtime and leaving its wall-clock armed. */
  private readonly liveRevivals = new Map<string, Promise<LiveRun | null>>();
  private shuttingDown = false;
  /** Same-engine landing serialization (worktree-lifecycle guard 6). The key
   * is the immutable canonical Git common-directory lease digest; the separate
   * engine-lifetime witness excludes other cooperating processes. */
  private readonly landingLocks = new Map<string, Promise<unknown>>();
  /** Review reservations are durable before their reviewer row exists. A
   * process-local admission in this set is still provisioning/validating, not
   * a crashed no-row marker for review recovery to replace. A real restart
   * naturally clears the set, making the durable orphan re-dispatchable. */
  private readonly reviewAdmissions = new Set<string>();
  /** Async review admission and target association survive marker clearing
   * until the separate reviewer runtime is positively quiescent. */
  private readonly reviewAdmissionTasks = new Map<string, Promise<void>>();
  private readonly reviewTargetsByRun = new Map<string, string>();
  /** Terminal, kill, and orchestrator override can observe the same reviewer.
   * They must share one cleanup owner so no caller releases its contract fence
   * while a peer still reclaims the checkout or settles/re-enters review. */
  private readonly reviewCleanupTasks = new Map<string, Promise<void>>();
  private readonly pendingReviewCleanupTasks = new Set<Promise<void>>();
  private readonly reviewCleanupFailures = new Map<string, unknown>();
  /** An orchestrator decision may supersede a reviewer, but it does not clear
   * durable ownership early. While this fence is present the terminal owner
   * may retire the runtime and checkout, but cannot apply the old verdict. */
  private readonly reviewOverrides = new Set<string>();
  /** A public review decision remains repository-mutation authority until the
   * whole verdict/landing path returns. Reference counts keep concurrent stale
   * callers fenced independently instead of letting the first completion clear
   * the contract-wide guard for a decision that is still running. */
  private readonly reviewDecisionCounts = new Map<string, number>();
  /** F3 (comms-hardening): envelopes minted pre-attach (boot recovery, e.g.
   *  recoverSealedRuns, runs BEFORE dispatch.attach) have nowhere live to
   *  land — queued here instead of dropped, then replayed in order by
   *  `attach()`. Carries the same structured shape `deliverToOrchestrator`
   *  takes, so a replayed envelope still renders through the typed
   *  `injectAgentEnvelope` path (Part A), never a plain-text fallback. */
  private readonly pendingEnvelopes: Array<{ projectId: ULID; envelope: AgentEnvelope; clientMessageId: string }> = [];

  constructor(deps: DispatchServiceDeps) {
    this.deps = deps;
  }

  /** Late-bind the server context (registry/hub/port exist only after listen).
   *  Flushes any envelope queued while ctx was still null (F3) — never a
   *  silent drop. */
  attach(ctx: AttachContext): void {
    this.ctx = ctx;
    const queued = this.pendingEnvelopes.splice(0);
    for (const item of queued) {
      this.deliverToOrchestrator(item.projectId, item.envelope, item.clientMessageId);
    }
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

    const snapshot = specialistSnapshot(bundle);
    const resolvedSelection = await this.deps.resolveNewSpecialistSelection({
      projectId: input.projectId,
      model: pod.model,
      effort: pod.effort,
    });
    if (resolvedSelection.status === 'invalid') {
      return refuse(
        'runtime-selection-unavailable',
        `specialist runtime selection unavailable (${resolvedSelection.code})`,
        422,
      );
    }
    if (this.ctx !== ctx || this.shuttingDown) {
      return refuse('not-attached', 'dispatch service changed while validating runtime selection', 503);
    }
    const selection = resolvedSelection.selection;
    const runId = newId() as ULID;
    const now = Date.now();

    // Repository authority and repo isolation are both admitted BEFORE a
    // runtime starts. Even payload/prose runtimes are natively write-capable
    // today, so a positively Git-backed cwd shares the same cooperative
    // exclusion door without gaining a worktree. Existing non-Git project
    // modes remain valid and do not fabricate repository authority.
    // Insert-the-row-first on failure so the refusal is durable + visible.
    const refuseProvision = (
      error: string,
      cause: Extract<DispatchFailureCause, 'worktree-provision-failed' | 'repository-occupied' | 'repository-unavailable'> = 'worktree-provision-failed',
    ): DispatchResult => {
      this.gateway.commitRunChange({
        reason: 'queued',
        mutate: () =>
          insertAgentRunRow({
            id: runId,
            projectId: input.projectId,
            dispatcherSessionId: input.dispatcherSessionId,
            specialistSnapshot: snapshot,
            selection,
            continuation: { mode: 'create' },
            status: 'queued',
            input: input.input,
            pmRef: input.pmRef ?? null,
            parentInvokeDepth: input.parentInvokeDepth ?? 0,
            lifecycleState: spec.kind === 'repo' ? 'provisioning' : null,
            queuedAt: now,
          }),
      });
      this.gateway.commitTerminal({
        runId,
        status: 'failed',
        result: null,
        failureCause: cause,
        failureReason: error,
        completedAt: Date.now(),
        ...(spec.kind === 'repo' ? { lifecycleState: 'provisioning-failed' as const } : {}),
      });
      return refuse(cause, error, cause === 'repository-occupied' ? 409 : cause === 'repository-unavailable' ? 503 : 422);
    };
    let worktree: {
      dir: string;
      branch: string;
      baseBranch: string;
      baseSha: string;
      repositoryIdentity: RepositoryIdentityReceipt;
    } | null = null;
    let gitReceipt: WorktreeGitReceipt | null = null;
    let profile: WorktreeProfile | null = null;
    let repositoryLease: RepositoryLeaseGuard | null = null;
    if (spec.kind === 'repo') {
      // Profile is fail-closed: an unreadable profile never half-provisions.
      const parsed = parseWorktreeProfile(project.worktreeProfile);
      if (!parsed.ok) {
        return refuseProvision(`invalid worktree profile: ${parsed.errors.join('; ')}`);
      }
      profile = parsed.profile;
    }
    if (spec.kind === 'repo' && !project.folderPath) {
      return refuseProvision(
        'PC-SDK could not prove repository authority because the project folder is missing.',
        'repository-unavailable',
      );
    }
    if (spec.kind === 'repo') {
      // True pre-flight, run on EVERY repo dispatch, BEFORE the repository
      // lease and BEFORE any insertAgentRunRow: is there a base branch, and
      // is the main working copy actually checked out on it? These read-only
      // preconditions are exempted from the "insert-the-row-first on
      // failure" rule below (refuseProvision) because they create zero
      // partial state — nothing was provisioned, nothing needs recovering —
      // and the fix is entirely on the user (switch the main copy back to
      // the base branch). Minting a durable failed run for this would only
      // leave a permanent, non-actionable "recover required" card. Real
      // provisioning failures that occur after this point (lease contention,
      // `git worktree add` failure, dirty checkout, etc.) may leave partial
      // state worth recording, so they still go through refuseProvision.
      const preflight = await preflightBaseBranch(project.folderPath, profile?.baseBranch ?? null);
      if (!preflight.ok) {
        return refuse('worktree-provision-failed', preflight.error, 422);
      }
    }
    if (project.folderPath) {
      try {
        repositoryLease = await this.repositoryLeases.acquireForRuntimeCwd(
          project.folderPath,
          project.repositoryIdentity,
        );
        requireProjectRepositoryIdentityBinding(
          input.projectId,
          project.folderPath,
          repositoryLease,
        );
      } catch (error) {
        const failure = repositoryLeaseFailure(error);
        return refuseProvision(failure.message, failure.cause);
      }
    }
    if (this.ctx !== ctx || this.shuttingDown) {
      return refuse('not-attached', 'dispatch service changed while acquiring fresh repository authority', 503);
    }
    if (spec.kind === 'repo') {
      const provisioned = await (this.deps.provisionWorktree ?? provisionWorktree)(project.folderPath, runId, {
        baseBranch: profile?.baseBranch ?? null,
        projectId: input.projectId,
        expectedIdentity: repositoryLease!.identity,
      });
      if (!provisioned.ok) return refuseProvision(provisioned.error);
      if (this.ctx !== ctx || this.shuttingDown) {
        const reclaimed = await rollbackUnpublishedWorktree(project.folderPath, provisioned);
        return refuse(
          'not-attached',
          reclaimed
            ? 'dispatch service changed after fresh worktree provisioning; the unpublished checkout was reclaimed'
            : 'dispatch service changed after fresh worktree provisioning; checkout cleanup did not positively settle',
          503,
        );
      }
      worktree = provisioned;
      gitReceipt = {
        worktreePath: provisioned.dir,
        branch: provisioned.branch,
        baseBranch: provisioned.baseBranch,
        baseSha: provisioned.baseSha,
        cleanStatus: provisioned.cleanStatus,
        repositoryIdentity: provisioned.repositoryIdentity,
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
      // Landing policy is stamped at creation from the issuer's spec, filled
      // in by the project's reviewPolicy/autoMergeEligible defaults where the
      // spec left it open (never downgraded — resolveContractLandingPolicy).
      // Readers of legacy NULL rows fall back through effectiveLandingPolicy().
      landingPolicy: spec.kind === 'repo' ? this.resolveLandingPolicy(project, spec) : null,
    });
    // Complete the worktree row's binding — the contract postdates the upsert.
    if (worktree) setWorktreeContractId(worktree.branch, contract.id as ULID);

    const publication = this.gateway.commitRunChange({
      reason: 'queued',
      mutate: () =>
        insertAgentRunRow({
          id: runId,
          projectId: input.projectId,
          dispatcherSessionId: input.dispatcherSessionId,
          specialistSnapshot: snapshot,
          selection,
          continuation: { mode: 'create' },
          status: 'queued',
          input: input.input,
          pmRef: input.pmRef ?? null,
          parentInvokeDepth: input.parentInvokeDepth ?? 0,
          contractId: contract.id as ULID,
          worktreeDir: worktree?.dir ?? null,
          worktreeBaseBranch: worktree?.baseBranch ?? null,
          worktreeBaseSha: worktree?.baseSha ?? null,
          gitReceipt,
          // Lifecycle (docs/worktree-lifecycle.md): the worktree pipeline only
          // applies to repo runs; everything else stays NULL forever. The row
          // is born post-provision, so 'provisioning' is its first state.
          lifecycleState: spec.kind === 'repo' ? 'provisioning' : null,
          queuedAt: now,
        }),
    });
    const linkedContract = this.contracts.setRun(contract.id, runId);
    if (!linkedContract) {
      this.gateway.commitTerminal({
        runId,
        status: 'failed',
        result: null,
        failureCause: 'worktree-provision-failed',
        failureReason: 'fresh producer/contract ownership binding was not positively committed',
        completedAt: Date.now(),
        ...(spec.kind === 'repo' ? { lifecycleState: 'failed' as const } : {}),
      });
      return refuse(
        'worktree-provision-failed',
        'fresh producer/contract ownership binding could not be committed',
        409,
      );
    }

    // Fire the run; the dispatch call returns immediately (always async).
    // Prepare/readiness (profile commands) run BEFORE any agent phase.
    const startTask = this.prepareAndStart({
      row: publication.run as unknown as { runId: string },
      runId,
      projectId: input.projectId,
      snapshot,
      contract: linkedContract,
      spec,
      selection,
      worktree,
      firstMessage: input.input,
      resumeNativeSessionId: null,
      repositoryLease,
      profile,
      freshProvision: true,
    });
    this.trackRunTask(runId, startTask);
    void startTask.catch(() => {
      console.error(`[pc-sdk][dispatch] startRun crashed for ${runId}: ${RUNTIME_START_FAILURE_REASON}`);
      this.settleTerminal(runId, {
        status: 'failed',
        result: null,
        failureCause: 'spawn-error',
        failureReason: RUNTIME_START_FAILURE_REASON,
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
    const parentReviewCheckout = getReviewCheckoutForReviewer(parent.id);
    if (parentReviewCheckout) {
      return refuse(
        'not-continuable',
        `independent reviewer run ${parent.id} has immutable checkout authority and cannot be continued; review re-entry requires positive teardown and a fresh reviewer`,
        409,
      );
    }
    const parentMutationIssue = this.runMutationQuiescenceIssue(
      parent.id,
      input.autoContinueCount > 0,
    );
    if (parentMutationIssue) return refuse('not-continuable', parentMutationIssue, 409);
    if (findActiveContinuation(input.runId)) {
      return refuse('concurrent-continuation', 'an active continuation for this run already exists', 409);
    }
    const parentRetirement = this.retiringRuns.get(parent.id);
    if (parentRetirement) {
      return refuse(
        'not-continuable',
        parentRetirement.status === 'pending'
          ? 'the parent runtime is still disposing — retry after positive quiescence'
          : 'the parent runtime failed to dispose — worktree mutation remains blocked',
        409,
      );
    }
    const project = getProjectById(input.projectId);
    if (!project) return refuse('project-missing', `unknown project ${input.projectId}`, 404);
    const snapshot = specialistSnapshotForAgentRun(parent);
    const selection = runtimeSelectionForAgentRun(parent);
    if (!snapshot || !selection || !isAgentRunNativeResumeReady(parent) || !parent.nativeSessionId) {
      return refuse(
        'runtime-selection-unavailable',
        'parent run has no complete trusted specialist selection/native identity to continue',
        409,
      );
    }
    const continuation = { mode: 'resume' as const, nativeSessionId: parent.nativeSessionId };
    const preflight = await this.deps.preflightRuntimeSession(selection, continuation);
    if (preflight.status === 'invalid') {
      return refuse(
        'runtime-selection-unavailable',
        `specialist native continuation unavailable (${preflight.code})`,
        409,
      );
    }
    if (this.ctx !== ctx || this.shuttingDown) {
      return refuse('not-attached', 'dispatch service changed while validating continuation', 503);
    }
    // Preflight awaited provider/account discovery. Another request may have
    // reserved this parent while we were suspended; recheck for the useful
    // typed refusal. The DB insert trigger is the cross-process authority.
    if (findActiveContinuation(input.runId)) {
      return refuse('concurrent-continuation', 'an active continuation for this run already exists', 409);
    }

    // Contract carries forward — a continuation never spawns contract-less.
    const contractId = parent.contractId;
    const contract = contractId ? this.contracts.get(contractId) : null;
    if (!contract || !contract.expectedOutput) {
      return refuse('contract-required', 'parent run has no resolvable contract to carry forward', 422);
    }
    // Landing owns the worktree from its durable `pending` reservation through
    // merge + teardown. A continuation admitted in that interval could mutate
    // or lose its cwd underneath the runtime. A positive landed/abandoned
    // receipt is final; failed/conflict/stale-base parks remain fixable.
    if (
      contract.landingStatus === 'pending' ||
      contract.landingStatus === 'abandoning' ||
      contract.landingStatus === 'landed' ||
      contract.landingStatus === 'abandoned'
    ) {
      return refuse(
        'not-continuable',
        `contract landing is '${contract.landingStatus}' — continuation cannot mutate this worktree`,
        409,
      );
    }
    // Review ownership outlives the runtime. Fix/continuation cannot mutate
    // the producer checkout until the exact detached review checkout has a
    // positive teardown settlement; a terminal reviewer with cleanup pending
    // is still repository authority, not a stale marker.
    const currentReviewCheckout = getCurrentReviewCheckoutForContract(contract.id as ULID);
    if (currentReviewCheckout) {
      return refuse(
        'concurrent-continuation',
        `independent review checkout ${currentReviewCheckout.id} is '${currentReviewCheckout.status}' — cleanup must positively settle before continuing`,
        409,
      );
    }
    if (contract.reviewRunId) {
      const reviewRun = getAgentRunRow(contract.reviewRunId as ULID);
      if (!reviewRun || !['completed', 'failed', 'cancelled'].includes(reviewRun.status)) {
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
    let repositoryLease: RepositoryLeaseGuard | null = null;
    if (spec.kind === 'repo') {
      const parsed = parseWorktreeProfile(project.worktreeProfile);
      if (!parsed.ok) {
        return refuse('worktree-provision-failed', `invalid worktree profile: ${parsed.errors.join('; ')}`, 422);
      }
      profile = parsed.profile;
    }
    if (parent.worktreeDir) {
      const repositoryIdentity = parent.gitReceipt?.repositoryIdentity ?? null;
      if (!repositoryIdentity) {
        return refuse(
          'repository-unavailable',
          'the existing run has no immutable repository identity receipt',
          503,
        );
      }
      try {
        repositoryLease = await this.repositoryLeases.acquire(
          parent.worktreeDir,
          repositoryIdentity,
        );
        requireProjectRepositoryIdentityBinding(
          input.projectId,
          parent.worktreeDir,
          repositoryLease,
        );
      } catch (error) {
        const failure = repositoryLeaseFailure(error);
        return refuse(failure.cause, failure.message, failure.httpStatus);
      }
    } else if (project.folderPath) {
      if (!project.repositoryIdentity) {
        return refuse(
          'repository-unavailable',
          'the project has no immutable repository identity for native continuation',
          503,
        );
      }
      try {
        repositoryLease = await this.repositoryLeases.acquireForRuntimeCwd(
          project.folderPath,
          project.repositoryIdentity,
        );
      } catch (error) {
        const failure = repositoryLeaseFailure(error);
        return refuse(failure.cause, failure.message, failure.httpStatus);
      }
    }
    if (this.ctx !== ctx || this.shuttingDown) {
      return refuse('not-attached', 'dispatch service changed while acquiring continuation repository authority', 503);
    }
    const currentContract = this.contracts.get(contract.id);
    const quiescenceIssue = this.contractRuntimeQuiescenceIssue(
      contract.id,
      false,
      input.autoContinueCount > 0 ? parent.id : null,
    );
    if (!currentContract || currentContract.version !== contract.version) {
      return refuse('not-continuable', 'contract changed while continuation authority was awaiting', 409);
    }
    const awaitedReviewCheckout = getCurrentReviewCheckoutForContract(contract.id as ULID);
    if (awaitedReviewCheckout) {
      return refuse(
        'not-continuable',
        `independent review checkout ${awaitedReviewCheckout.id} is '${awaitedReviewCheckout.status}' — cleanup must positively settle before continuing`,
        409,
      );
    }
    if (
      currentContract.landingStatus === 'pending' ||
      currentContract.landingStatus === 'abandoning' ||
      currentContract.landingStatus === 'landed' ||
      currentContract.landingStatus === 'abandoned'
    ) {
      return refuse(
        'not-continuable',
        `contract landing is '${currentContract.landingStatus}' — continuation cannot mutate this worktree`,
        409,
      );
    }
    if (quiescenceIssue) {
      return refuse('not-continuable', quiescenceIssue, 409);
    }
    const runId = newId() as ULID;
    const now = Date.now();

    let publication: ReturnType<AgentRunMutationGateway['commitRunChange']>;
    try {
      publication = this.gateway.commitRunChange({
        reason: 'queued',
        mutate: () =>
          insertAgentRunRow({
            id: runId,
            projectId: input.projectId,
            dispatcherSessionId: input.dispatcherSessionId,
            specialistSnapshot: snapshot,
            selection,
            continuation,
            status: 'queued',
            input: input.input,
            pmRef: parent.pmRef,
            continues: parent.id,
            parentInvokeDepth: parent.parentInvokeDepth,
            contractId: contract.id as ULID,
            worktreeDir: parent.worktreeDir,
            worktreeBaseBranch: parent.worktreeBaseBranch,
            worktreeBaseSha: parent.worktreeBaseSha,
            gitReceipt: parent.gitReceipt,
            // Every repo continuation records an explicit preparation no-op
            // and a fresh readiness outcome before runtime mint, even when no
            // commands are configured. It is therefore always born preparing.
            lifecycleState: spec.kind === 'repo' ? 'preparing' : null,
            autoContinueCount: input.autoContinueCount,
            queuedAt: now,
          }),
      });
    } catch (error) {
      if (error instanceof Error && error.message.includes('active continuation')) {
        return refuse('concurrent-continuation', 'an active continuation for this run already exists', 409);
      }
      throw error;
    }
    const linkedContract = this.contracts.setRun(contract.id, runId);
    if (!linkedContract) {
      this.gateway.commitTerminal({
        runId,
        status: 'failed',
        result: null,
        failureCause: 'worktree-provision-failed',
        failureReason: 'continuation producer/worktree ownership transfer was not positively committed',
        completedAt: Date.now(),
        ...(spec.kind === 'repo' ? { lifecycleState: 'failed' as const } : {}),
      });
      return refuse(
        'not-continuable',
        'continuation producer/worktree ownership transfer could not be committed',
        409,
      );
    }

    const startTask = this.prepareAndStart({
      row: publication.run as unknown as { runId: string },
      runId,
      projectId: input.projectId,
      snapshot,
      contract: linkedContract,
      spec,
      selection,
      worktree: parent.worktreeDir
        ? { dir: parent.worktreeDir, branch: '', baseBranch: parent.worktreeBaseBranch ?? '', baseSha: parent.worktreeBaseSha ?? '' }
        : null,
      firstMessage: input.input,
      resumeNativeSessionId: parent.nativeSessionId,
      repositoryLease,
      profile,
      freshProvision: false,
    });
    this.trackRunTask(runId, startTask);
    void startTask.catch(() => {
      console.error(`[pc-sdk][dispatch] continuation start crashed for ${runId}: ${RUNTIME_START_FAILURE_REASON}`);
      this.settleTerminal(runId, {
        status: 'failed',
        result: null,
        failureCause: 'spawn-error',
        failureReason: RUNTIME_START_FAILURE_REASON,
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
    const authorityPath = dir ?? getProjectById(input.projectId)?.folderPath ?? null;
    if (input.repositoryLease && authorityPath) {
      try {
        await this.repositoryLeases.assertHeld(
          input.repositoryLease,
          authorityPath,
          input.repositoryLease.identity,
        );
      } catch (error) {
        this.failRepositoryAuthority(input.runId, error);
        return;
      }
    } else if (input.worktree) {
      this.failRepositoryAuthority(
        input.runId,
        new Error('worktree-backed run has no live repository guard'),
      );
      return;
    }
    if (input.spec.kind === 'repo') {
      if (!dir) {
        this.failPhaseEvidence(input.runId, 'repository builder has no recorded worktree');
        return;
      }
      const setup = input.freshProvision ? input.profile?.setupCommands ?? [] : [];
      const readiness = input.profile?.readinessCommands ?? [];
      this.stampLifecycle(input.runId, 'preparing');
      if (this.runIsTerminal(input.runId)) return;
      if (setup.length > 0) {
        const prep = await runProfileCommands(
          dir,
          setup,
          undefined,
          input.repositoryLease?.identity ?? null,
          () => !this.shuttingDown && !this.runIsTerminal(input.runId),
        );
        if (prep.cancelled || this.runIsTerminal(input.runId)) return;
        const recorded = this.persistPhaseReceipt(input.runId, {
          phase: 'preparation',
          outcome: 'executed',
          ok: prep.ok,
          steps: prep.steps,
          finishedAt: Date.now(),
        });
        if (!recorded) return;
        if (!prep.ok) {
          this.failPreparation(input.runId, 'preparation', prep.steps);
          return;
        }
        // A kill during prep has no live handle — it only flips the row
        // terminal. Re-check between phases so a cancelled run never burns
        // readiness commands (up to 20 × 10min, outside the wall clock).
        if (this.runIsTerminal(input.runId)) return;
      } else {
        const row = getAgentRunRow(input.runId);
        if (!input.freshProvision && !row?.continues) {
          this.failPhaseEvidence(input.runId, 'continuation preparation has no parent run receipt');
          return;
        }
        const receipt = input.freshProvision
          ? createNotRequiredWorktreePhaseReceipt({
              phase: 'preparation',
              reason: 'no-commands-configured',
              finishedAt: Date.now(),
            })
          : createNotRequiredWorktreePhaseReceipt({
              phase: 'preparation',
              reason: 'existing-worktree-preparation',
              inheritedFromRunId: row!.continues!,
              finishedAt: Date.now(),
            });
        if (!this.persistPhaseReceipt(input.runId, receipt)) return;
        if (this.runIsTerminal(input.runId)) return;
      }
      if (readiness.length > 0) {
        const ready = await runProfileCommands(
          dir,
          readiness,
          undefined,
          input.repositoryLease?.identity ?? null,
          () => !this.shuttingDown && !this.runIsTerminal(input.runId),
        );
        if (ready.cancelled || this.runIsTerminal(input.runId)) return;
        const recorded = this.persistPhaseReceipt(input.runId, {
          phase: 'readiness',
          outcome: 'executed',
          ok: ready.ok,
          steps: ready.steps,
          finishedAt: Date.now(),
        });
        if (!recorded) return;
        if (!ready.ok) {
          this.failPreparation(input.runId, 'readiness', ready.steps);
          return;
        }
        if (this.runIsTerminal(input.runId)) return;
      } else {
        const receipt = createNotRequiredWorktreePhaseReceipt({
          phase: 'readiness',
          reason: 'no-commands-configured',
          finishedAt: Date.now(),
        });
        if (!this.persistPhaseReceipt(input.runId, receipt)) return;
        if (this.runIsTerminal(input.runId)) return;
      }
      this.stampLifecycle(input.runId, 'ready');
      const ready = getAgentRunRow(input.runId);
      if (!ready || this.runIsTerminal(input.runId)) return;
      if (ready.lifecycleState !== 'ready') {
        this.failPhaseEvidence(input.runId, 'repository builder could not enter the ready lifecycle state');
        return;
      }
    }
    await this.startRun(input);
  }

  /** Independent reviewers are payload producers running in a write-capable
   * repository checkout. They therefore execute the project profile even
   * though their expected-output kind is not `repo`, and persist the same
   * phase receipt on both the run and the workspace authority before mint. */
  private async prepareReviewAndStart(
    input: StartRunInput,
    checkoutId: ULID,
    profile: WorktreeProfile | null,
  ): Promise<void> {
    const phases: Array<{ phase: 'preparation' | 'readiness'; commands: readonly string[] }> = [
      { phase: 'preparation', commands: profile?.setupCommands ?? [] },
      { phase: 'readiness', commands: profile?.readinessCommands ?? [] },
    ];
    for (const { phase, commands } of phases) {
      const beforeIssue = await this.reviewWorkspaceAuthorityIssue(checkoutId, false);
      if (beforeIssue) {
        console.warn(`[pc-sdk][dispatch] review ${input.runId} ${phase} refused: ${beforeIssue}`);
        this.settleTerminal(input.runId, {
          status: 'failed',
          result: null,
          failureCause: 'worktree-provision-failed',
          failureReason: `${phase} refused: ${beforeIssue}`,
        });
        return;
      }
      let receipt: ReviewCheckoutPhaseEvidence;
      if (commands.length === 0) {
        const noCommands = createNotRequiredWorktreePhaseReceipt({
          phase,
          reason: 'no-commands-configured',
          finishedAt: Date.now(),
        });
        if (noCommands.reason !== 'no-commands-configured') {
          throw new Error('review phase unexpectedly inherited preparation evidence');
        }
        receipt = noCommands;
      } else {
        const checkout = getReviewCheckoutById(checkoutId);
        if (!checkout) return;
        const result = await runProfileCommands(
          checkout.worktreePath,
          commands,
          undefined,
          checkout.repositoryIdentity,
          () => !this.shuttingDown && !this.runIsTerminal(input.runId),
        );
        if (result.cancelled || this.runIsTerminal(input.runId)) return;
        receipt = {
          phase,
          outcome: 'executed',
          ok: result.ok,
          steps: result.steps,
          finishedAt: Date.now(),
        };
      }
      const afterCommandIssue = await this.reviewWorkspaceAuthorityIssue(checkoutId, false);
      if (afterCommandIssue) {
        console.warn(`[pc-sdk][dispatch] review ${input.runId} ${phase} drifted: ${afterCommandIssue}`);
        this.settleTerminal(input.runId, {
          status: 'failed',
          result: null,
          failureCause: 'worktree-provision-failed',
          failureReason: `${phase} evidence drifted: ${afterCommandIssue}`,
        });
        return;
      }
      const checkout = getReviewCheckoutById(checkoutId);
      if (!checkout) return;
      const boundReceipt = createReviewCheckoutPhaseReceipt(
        this.reviewCheckoutAuthority(checkout),
        receipt,
      );
      const phasePublication = this.gateway.commitReviewCheckoutPhaseReceipt({
        authority: this.reviewCheckoutAuthority(checkout),
        expectedUpdatedAt: checkout.updatedAt,
        receipt: boundReceipt,
      });
      if (!phasePublication) {
        this.settleTerminal(input.runId, {
          status: 'failed',
          result: null,
          failureCause: 'worktree-provision-failed',
          failureReason: `${phase} receipt could not be persisted immutably on the exact review workspace and run`,
        });
        return;
      }
      if (receipt.outcome === 'executed' && !receipt.ok) {
        const failed = receipt.steps[receipt.steps.length - 1];
        this.settleTerminal(input.runId, {
          status: 'failed',
          result: null,
          failureCause: 'worktree-provision-failed',
          failureReason:
            `${phase} command failed (exit ${failed?.exitCode ?? '?'}` +
            `${failed?.timedOut ? ', timed out' : ''}): ${failed?.command ?? '(unknown)'}`,
        });
        return;
      }
    }
    const readyIssue = await this.reviewWorkspaceAuthorityIssue(checkoutId, true);
    if (readyIssue) {
      console.warn(`[pc-sdk][dispatch] review ${input.runId} mint refused: ${readyIssue}`);
      this.settleTerminal(input.runId, {
        status: 'failed',
        result: null,
        failureCause: 'worktree-provision-failed',
        failureReason: `review runtime mint refused: ${readyIssue}`,
      });
      return;
    }
    await this.startRun({
      ...input,
      authorizeRuntimeCwd: () => this.reviewWorkspaceAuthorityIssue(checkoutId, true),
    });
  }

  /** Landing-policy decision point (docs/master-plan.md "MCP manager —
   *  reliability requirements" / Phase 4): resolves a fresh repo contract's
   *  landing policy from the issuer's spec plus the project's
   *  reviewPolicy/autoMergeEligible defaults. A guard override (the project
   *  setting losing to a stricter spec-derived invariant) is never silent —
   *  it is logged here, once, at the exact decision point. */
  private resolveLandingPolicy(project: Project, spec: ExpectedOutput): ContractLandingPolicy | null {
    if (spec.kind !== 'repo') return null;
    const resolved = resolveContractLandingPolicy(project.settings, spec);
    if (resolved.guardOverride) {
      console.warn(
        `[pc-sdk][dispatch] project ${project.id} lifecycle policy guard: ${resolved.guardOverride}`,
      );
    }
    return resolved.policy;
  }

  /** True when the row is gone or already terminal (killed/settled during the
   *  wall-clock-uncovered prepare/readiness phase). */
  private runIsTerminal(runId: ULID): boolean {
    const row = getAgentRunRow(runId);
    return !row || row.status === 'completed' || row.status === 'failed' || row.status === 'cancelled';
  }

  private trackRunTask(runId: ULID, task: Promise<void>): void {
    this.runTasks.set(runId, task);
    void task.finally(() => {
      if (this.runTasks.get(runId) === task) this.runTasks.delete(runId);
    }).catch(() => {});
  }

  private trackPostTerminalTask(runId: ULID, work: () => Promise<void>): Promise<void> {
    const existing = this.postTerminalTasks.get(runId);
    if (existing) return existing.promise;
    const promise = Promise.resolve().then(work);
    const tracked: PostTerminalTask = { promise, status: 'pending', error: null };
    this.postTerminalTasks.set(runId, tracked);
    void promise.then(
      () => {
        tracked.status = 'completed';
      },
      (error) => {
        tracked.status = 'failed';
        tracked.error = error;
      },
    );
    return promise;
  }

  private async disposeUninstalledRuntime(runId: ULID, session: RuntimeSession): Promise<void> {
    try {
      await session.dispose();
    } catch (error) {
      this.runtimeRetirementFailures.set(runId, error);
      console.error(`[pc-sdk][dispatch] stale runtime disposal failed for ${runId}:`, error);
    }
  }

  /** Track runtime retirement as positive quiescence evidence. Callers may
   * remove the live projection immediately, but repository teardown remains
   * fenced until this promise resolves. */
  private retireRuntime(runId: ULID, session: RuntimeSession): Promise<void> {
    const existing = this.retiringRuns.get(runId);
    if (existing) return existing.promise;
    const retirement: RuntimeRetirement = {
      status: 'pending',
      error: null,
      promise: Promise.resolve().then(() => session.dispose()),
    };
    this.retiringRuns.set(runId, retirement);
    void retirement.promise.then(
      () => {
        if (this.retiringRuns.get(runId) === retirement) {
          this.retiringRuns.delete(runId);
        }
      },
      (error) => {
        retirement.status = 'failed';
        retirement.error = error;
        console.error(`[pc-sdk][dispatch] runtime retirement failed for ${runId}:`, error);
      },
    );
    return retirement.promise;
  }

  private runRuntimeQuiescenceIssue(runId: string): string | null {
    if (this.reviewAdmissionTasks.has(runId)) return `run ${runId} review admission is still pending`;
    if (this.runTasks.has(runId)) return `run ${runId} preparation or runtime task is still pending`;
    if (this.liveRevivals.has(runId)) return `run ${runId} runtime revival is still pending`;
    if (this.live.has(runId)) return `run ${runId} still has a live runtime session`;
    const retirement = this.retiringRuns.get(runId);
    if (retirement?.status === 'pending') return `run ${runId} runtime disposal is still pending`;
    if (retirement?.status === 'failed') return `run ${runId} runtime disposal failed`;
    if (this.runtimeRetirementFailures.has(runId)) return `run ${runId} stale runtime disposal failed`;
    return null;
  }

  private runMutationQuiescenceIssue(runId: string, excludePostTerminal = false): string | null {
    const runtimeIssue = this.runRuntimeQuiescenceIssue(runId);
    if (runtimeIssue) return runtimeIssue;
    const task = this.postTerminalTasks.get(runId);
    if (!excludePostTerminal && task?.status === 'pending') {
      return `run ${runId} post-terminal settlement is still pending`;
    }
    if (!excludePostTerminal && task?.status === 'failed') {
      return `run ${runId} post-terminal settlement failed`;
    }
    return null;
  }

  private async awaitRunRuntimeQuiescence(runId: ULID): Promise<string | null> {
    const pending = [
      this.reviewAdmissionTasks.get(runId),
      this.runTasks.get(runId),
      this.liveRevivals.get(runId),
      this.retiringRuns.get(runId)?.promise,
    ].filter((promise) => promise !== undefined);
    await Promise.allSettled(pending);
    return this.runRuntimeQuiescenceIssue(runId);
  }

  /** Null means every same-process runtime bound to the contract, including a
   * separately contracted reviewer, has retired. */
  private contractRuntimeQuiescenceIssue(
    contractId: string,
    excludeCurrentReviewDecision = false,
    excludePostTerminalRunId: string | null = null,
    excludeReviewRunId: string | null = null,
  ): string | null {
    const reviewDecisionCount = this.reviewDecisionCounts.get(contractId) ?? 0;
    if (reviewDecisionCount > (excludeCurrentReviewDecision ? 1 : 0)) {
      return `contract ${contractId} review decision is still pending`;
    }
    for (const [reviewRunId, targetId] of this.reviewTargetsByRun) {
      if (reviewRunId === excludeReviewRunId) continue;
      if (targetId === contractId) {
        return this.runMutationQuiescenceIssue(reviewRunId) ??
          `review run ${reviewRunId} cleanup has not positively settled`;
      }
    }
    for (const run of listAgentRunsForContract(contractId as ULID)) {
      const issue = this.runMutationQuiescenceIssue(run.id, run.id === excludePostTerminalRunId);
      if (issue) return issue;
    }
    return null;
  }

  /** Preparation/readiness failure → the existing typed provision-failure
   *  terminal. The receipt is already persisted; the worktree is preserved
   *  (retention rules — never torn down on a prep failure). */
  private failPreparation(runId: ULID, phase: 'preparation' | 'readiness', steps: WorktreeCommandStep[]): void {
    const failed = steps[steps.length - 1];
    const repositoryCause = failed?.stderrTail.startsWith('repository-occupied:')
      ? 'repository-occupied'
      : failed?.stderrTail.startsWith('repository-unavailable:')
        ? 'repository-unavailable'
        : null;
    const reason =
      `${phase} command failed (exit ${failed?.exitCode ?? '?'}${failed?.timedOut ? ', timed out' : ''}): ` +
      `${failed?.command ?? '(none)'} — receipt persisted; worktree preserved for debugging`;
    this.gateway.commitTerminal({
      runId,
      status: 'failed',
      result: null,
      failureCause: repositoryCause ?? 'worktree-provision-failed',
      failureReason: reason,
      completedAt: Date.now(),
      lifecycleState: 'provisioning-failed',
    });
    void this.trackPostTerminalTask(runId, () => this.verifyAndLand(runId, 'failed')).catch((err) => {
      console.error(`[pc-sdk][dispatch] post-prep-failure settle crashed for ${runId}:`, err);
    });
  }

  /** Repository authority disappeared or drifted after a run row was minted.
   * Preserve the worktree and settle loudly; no runtime or command may start. */
  private failRepositoryAuthority(runId: ULID, error: unknown): void {
    const failure = repositoryLeaseFailure(error);
    this.gateway.commitTerminal({
      runId,
      status: 'failed',
      result: null,
      failureCause: failure.cause,
      failureReason: failure.message,
      completedAt: Date.now(),
      lifecycleState: 'failed',
    });
    void this.trackPostTerminalTask(runId, () => this.verifyAndLand(runId, 'failed')).catch((settleError) => {
      console.error(`[pc-sdk][dispatch] repository-authority settlement failed for ${runId}:`, settleError);
    });
  }

  /** Missing or malformed builder workspace evidence is a typed provisioning
   * failure. It can never be repaired by inference at the runtime door. */
  private failPhaseEvidence(runId: ULID, reason: string): void {
    this.gateway.commitTerminal({
      runId,
      status: 'failed',
      result: null,
      failureCause: 'worktree-provision-failed',
      failureReason: `${reason} — positive Git/preparation/readiness receipts are required before runtime start`,
      completedAt: Date.now(),
      lifecycleState: 'failed',
    });
    void this.trackPostTerminalTask(runId, () => this.verifyAndLand(runId, 'failed')).catch((error) => {
      console.error(`[pc-sdk][dispatch] phase-evidence settlement failed for ${runId}:`, error);
    });
  }

  /** First-write phase CAS with a loud nonterminal failure path. A cancelled
   * run legitimately loses the race and stays terminal; any other refusal is
   * missing evidence and must not leave a queued run wedged forever. */
  private persistPhaseReceipt(runId: ULID, receipt: WorktreePhaseReceipt): boolean {
    if (this.gateway.commitPhaseReceipt({ runId, receipt })) return true;
    if (!this.runIsTerminal(runId)) {
      this.failPhaseEvidence(runId, `${receipt.phase} receipt could not be persisted immutably`);
    }
    return false;
  }

  /** Exact pre-mint/revival guard for repository builders. Review checkouts
   * are deliberately excluded until they own an exact checkout receipt. */
  private hasPositiveBuilderWorkspaceEvidence(
    run: AgentRunRow,
    worktreeDir: string | null,
  ): boolean {
    if (!worktreeDir || run.worktreeDir !== worktreeDir) return false;
    const gitReceipt = run.gitReceipt;
    if (
      !gitReceipt ||
      gitReceipt.worktreePath !== worktreeDir ||
      gitReceipt.branch !== basename(worktreeDir) ||
      gitReceipt.baseBranch !== run.worktreeBaseBranch ||
      gitReceipt.baseSha !== run.worktreeBaseSha ||
      gitReceipt.cleanStatus !== true ||
      !isRepositoryIdentityReceipt(gitReceipt.repositoryIdentity)
    ) return false;
    return isPositivePreparationReceiptForRun(run.preparationReceipt, run.continues) &&
      isPositiveWorktreePhaseReceipt(run.readinessReceipt, 'readiness');
  }

  private async startRun(input: StartRunInput): Promise<void> {
    // Preflight: a run killed during prepare/readiness (no live handle yet) is
    // terminal on the row only. Starting anyway would spawn a bypassPermissions
    // agent for a cancelled run — and the 'spawning' announce below would
    // overwrite the terminal status, resurrecting it. Refuse instead.
    const initialRow = getAgentRunRow(input.runId);
    if (!initialRow || initialRow.status === 'completed' || initialRow.status === 'failed' || initialRow.status === 'cancelled') {
      console.warn(
        `[pc-sdk][dispatch] run ${input.runId} is '${initialRow?.status ?? 'missing'}' before agent start — not launching`,
      );
      return;
    }
    const persistedSelection = runtimeSelectionForAgentRun(initialRow);
    const persistedSnapshot = specialistSnapshotForAgentRun(initialRow);
    if (
      !persistedSelection ||
      !persistedSnapshot ||
      !runtimeSelectionsEqual(persistedSelection, input.selection) ||
      persistedSnapshot.revision !== input.snapshot.revision
    ) {
      this.settleTerminal(input.runId, {
        status: 'failed',
        result: null,
        failureCause: 'spawn-error',
        failureReason: 'agent run execution stamp is unavailable or inconsistent',
      });
      return;
    }
    if (
      input.spec.kind === 'repo' &&
      !this.hasPositiveBuilderWorkspaceEvidence(initialRow, input.worktree?.dir ?? null)
    ) {
      this.failPhaseEvidence(input.runId, 'repository builder workspace evidence is missing or inconsistent');
      return;
    }
    const ctx = this.ctx;
    if (!ctx || this.shuttingDown) return;
    const project = getProjectById(input.projectId);
    let cwd = input.worktree?.dir ?? project?.folderPath ?? process.cwd();
    const authorityPath = input.worktree?.dir ?? project?.folderPath ?? null;
    if (input.repositoryLease && authorityPath) {
      try {
        cwd = await this.repositoryLeases.resolveHeldRuntimeCwd(
          input.repositoryLease,
          authorityPath,
          input.repositoryLease.identity,
        );
      } catch (error) {
        this.failRepositoryAuthority(input.runId, error);
        return;
      }
    } else if (input.worktree) {
      this.failRepositoryAuthority(
        input.runId,
        new Error('worktree-backed run has no live repository guard'),
      );
      return;
    }

    if (input.authorizeRuntimeCwd) {
      const refusal = await input.authorizeRuntimeCwd();
      if (refusal) {
        console.warn(`[pc-sdk][dispatch] review ${input.runId} preflight cwd refused: ${refusal}`);
        this.settleTerminal(input.runId, {
          status: 'failed',
          result: null,
          failureCause: 'worktree-provision-failed',
          failureReason: `review workspace authorization refused before runtime preflight: ${refusal}`,
        });
        return;
      }
    }

    const continuation: RuntimeContinuationRequest = input.resumeNativeSessionId
      ? { mode: 'resume', nativeSessionId: input.resumeNativeSessionId }
      : { mode: 'create' };
    const validation = await this.deps.preflightRuntimeSession(input.selection, continuation);
    if (validation.status === 'invalid') {
      this.settleTerminal(input.runId, {
        status: 'failed',
        result: null,
        failureCause: 'spawn-error',
        failureReason: `agent runtime selection rejected (${validation.code})`,
      });
      return;
    }
    if (this.ctx !== ctx || this.shuttingDown || this.runIsTerminal(input.runId)) return;
    if (input.authorizeRuntimeCwd) {
      const refusal = await input.authorizeRuntimeCwd();
      if (refusal) {
        console.warn(`[pc-sdk][dispatch] review ${input.runId} mint cwd refused: ${refusal}`);
        this.settleTerminal(input.runId, {
          status: 'failed',
          result: null,
          failureCause: 'worktree-provision-failed',
          failureReason: `review workspace authorization refused at runtime mint: ${refusal}`,
        });
        return;
      }
      if (this.ctx !== ctx || this.shuttingDown || this.runIsTerminal(input.runId)) return;
    }

    const prepared = continuation.mode === 'resume'
      ? prepareAgentRunResume(input.runId)
      : prepareAgentRunCreate(input.runId);
    if (!prepared?.continuationAttemptId) {
      if (!this.runIsTerminal(input.runId)) {
        this.settleTerminal(input.runId, {
          status: 'failed',
          result: null,
          failureCause: 'spawn-error',
          failureReason: 'agent runtime continuation attempt could not be prepared',
        });
      }
      return;
    }
    const continuationAttemptId = prepared.continuationAttemptId;
    const preparedContinuation: RuntimeContinuationRequest = continuation.mode === 'resume'
      ? { mode: 'resume', nativeSessionId: prepared.nativeSessionId! }
      : { mode: 'create' };

    if (!this.announce(input.runId, 'spawning', { spawnedAt: Date.now() })) return;

    let instructions = buildSpecialistInstructions({
      charter: input.snapshot.charter,
      podName: input.snapshot.name,
      expectedOutput: input.spec,
      acceptanceCriteria: (input.contract.acceptanceCriteria ?? []) as never,
      worktreeDir: input.worktree?.dir ?? null,
      fileDeliveryDoor: this.fileDeliveryDoorOpen(input.selection.runtimeId, input.worktree?.dir ?? null),
    });
    if (input.snapshot.contextDocs.length > 0) {
      instructions += `\n\n## Context documents\n${input.snapshot.contextDocs
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
        invokeDepth: (run?.parentInvokeDepth ?? 0) + 1,
        serverPort: ctx.serverPort,
      }),
    );

    const sessionInput = {
      appSessionId: input.runId,
      projectId: input.projectId,
      continuationAttemptId,
      selection: input.selection,
      instructions,
      cwd,
      tools,
      maxTurns: input.snapshot.maxTurns,
      bypassPermissions: true, // headless specialist — never blocks on a browser ask
      continuation: preparedContinuation,
    };
    let session: RuntimeSession;
    try {
      session = await this.deps.mintSpecialistRuntimeSession(sessionInput);
    } catch {
      if (preparedContinuation.mode === 'resume') {
        failAgentRunRuntimeResume(input.runId, continuationAttemptId);
      }
      this.settleTerminal(input.runId, {
        status: 'failed',
        result: null,
        failureCause: 'spawn-error',
        failureReason: RUNTIME_START_FAILURE_REASON,
      }, continuationAttemptId);
      return;
    }

    if (input.authorizeRuntimeCwd) {
      const refusal = await input.authorizeRuntimeCwd();
      if (refusal) {
        console.warn(`[pc-sdk][dispatch] review ${input.runId} post-mint cwd refused: ${refusal}`);
        await this.disposeUninstalledRuntime(input.runId, session);
        this.settleTerminal(input.runId, {
          status: 'failed',
          result: null,
          failureCause: 'worktree-provision-failed',
          failureReason: `review workspace authorization refused after runtime mint: ${refusal}`,
        }, continuationAttemptId);
        return;
      }
    }

    // Session creation is asynchronous. A kill can land while the provider is
    // minting the native session; the row must be re-read before installing a
    // live projection, starting the wall clock, or sending a turn that could
    // mutate the run-owned worktree.
    const afterMint = getAgentRunRow(input.runId);
    const afterMintSelection = afterMint ? runtimeSelectionForAgentRun(afterMint) : null;
    if (
      !afterMint ||
      this.ctx !== ctx ||
      this.shuttingDown ||
      afterMint.status === 'completed' ||
      afterMint.status === 'failed' ||
      afterMint.status === 'cancelled' ||
      afterMint.continuationAttemptId !== continuationAttemptId ||
      !afterMintSelection ||
      !runtimeSelectionsEqual(afterMintSelection, input.selection) ||
      (preparedContinuation.mode === 'create'
        ? afterMint.continuationState !== 'clean-pending'
        : afterMint.continuationState !== 'resume-pending')
    ) {
      await this.disposeUninstalledRuntime(input.runId, session);
      return;
    }

    const liveRun: LiveRun = {
      session,
      selection: input.selection,
      continuationAttemptId,
      receiptConfirmed: false,
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
    let turn: AsyncIterable<RuntimeEvent>;
    try {
      turn = session.sendTurn(input.firstMessage);
    } catch {
      console.error(`[pc-sdk][dispatch] runtime send failed for ${input.runId}: ${RUNTIME_SEND_FAILURE_REASON}`);
      if (!this.persistAppAuthoredTurnFailure(input.projectId, input.runId, RUNTIME_SEND_FAILURE_REASON)) return;
      if (preparedContinuation.mode === 'resume') {
        failAgentRunRuntimeResume(input.runId, continuationAttemptId);
      }
      this.settleTerminal(input.runId, {
        status: 'failed',
        result: null,
        failureCause: 'send-failed',
        failureReason: RUNTIME_SEND_FAILURE_REASON,
      }, continuationAttemptId);
      return;
    }
    await this.consumeTurn(input.runId, input.projectId, turn, { firstTurn: true });
  }

  /** Fail closed when a paused reviewer no longer owns runtime-ready checkout
   * authority. The ask-aware kill door terminalizes it before exact cleanup. */
  private async retireInvalidReviewRevival(
    run: AgentRunRow,
    checkout: ReviewCheckout,
    issue: string,
  ): Promise<void> {
    console.warn(
      `[pc-sdk][dispatch] paused reviewer ${run.id} revival refused: ${issue}; terminalizing for exact cleanup`,
    );
    const killed = await this.killRun(run.projectId, run.id as ULID, {
      failureCause: 'cancelled',
      failureReason: `paused independent reviewer lost checkout authority: ${issue}`,
    });
    if (!killed.ok) return;
    // killRun registered the exact cleanup task. Do not await it from inside
    // the revival promise: cleanup quiescence intentionally waits for that
    // promise to leave liveRevivals, so awaiting here would self-deadlock.
  }

  /** Re-mint a paused run from its exact frozen snapshot/selection. The ask
   * remains open until this native resume is positively receipted on the next
   * sendTurn; a failed or stale mint never falls back to current defaults. */
  private async reviveLiveSession(run: AgentRunRow): Promise<LiveRun | null> {
    const ctx = this.ctx;
    if (!ctx || this.shuttingDown || run.status !== 'paused') return null;
    const snapshot = specialistSnapshotForAgentRun(run);
    const selection = runtimeSelectionForAgentRun(run);
    if (!snapshot || !selection || !isAgentRunNativeResumeReady(run) || !run.nativeSessionId) {
      return null;
    }
    try {
      const project = getProjectById(run.projectId);
      if (!project) return null;
      const contract = run.contractId ? this.contracts.get(run.contractId) : null;
      const spec = (contract?.expectedOutput ?? null) as ExpectedOutput | null;
      if (!contract || !spec) return null;
      const reviewCheckout = getReviewCheckoutForReviewer(run.id as ULID);
      if (reviewCheckout) {
        const issue = await this.reviewWorkspaceAuthorityIssue(reviewCheckout.id, true);
        if (issue) {
          await this.retireInvalidReviewRevival(run, reviewCheckout, issue);
          return null;
        }
      }
      if (
        spec.kind === 'repo' &&
        !this.hasPositiveBuilderWorkspaceEvidence(run, run.worktreeDir)
      ) {
        console.warn(
          `[pc-sdk][dispatch] live-session revival refused for ${run.id}: positive builder workspace evidence unavailable`,
        );
        return null;
      }
      let repositoryLease: RepositoryLeaseGuard | null = null;
      let authorityPath: string | null = null;
      if (run.worktreeDir) {
        const identity = run.gitReceipt?.repositoryIdentity ?? null;
        if (!identity) {
          console.warn(`[pc-sdk][dispatch] live-session revival refused for ${run.id}: repository identity unavailable`);
          return null;
        }
        authorityPath = run.worktreeDir;
        repositoryLease = await this.repositoryLeases.acquire(run.worktreeDir, identity);
        requireProjectRepositoryIdentityBinding(
          run.projectId,
          run.worktreeDir,
          repositoryLease,
        );
      } else if (project.folderPath) {
        if (!project.repositoryIdentity) {
          console.warn(`[pc-sdk][dispatch] live-session revival refused for ${run.id}: project repository identity unavailable`);
          return null;
        }
        authorityPath = project.folderPath;
        repositoryLease = await this.repositoryLeases.acquireForRuntimeCwd(
          project.folderPath,
          project.repositoryIdentity,
        );
      }

      const continuation = { mode: 'resume' as const, nativeSessionId: run.nativeSessionId };
      const validation = await this.deps.preflightRuntimeSession(selection, continuation);
      if (validation.status === 'invalid' || this.ctx !== ctx || this.shuttingDown) return null;
      if (reviewCheckout) {
        const issue = await this.reviewWorkspaceAuthorityIssue(reviewCheckout.id, true);
        if (issue) {
          await this.retireInvalidReviewRevival(run, reviewCheckout, issue);
          return null;
        }
      }
      const beforePrepare = getAgentRunRow(run.id);
      if (!beforePrepare || beforePrepare.status !== 'paused') return null;
      try {
        this.gateway.commitRunChange({
          reason: 'reconciled',
          mutate: (tx) => prepareAgentRunResumeInDb(run.id, tx),
        });
      } catch {
        return null;
      }
      const prepared = getAgentRunRow(run.id);
      if (!prepared?.continuationAttemptId || !prepared.nativeSessionId) return null;
      const continuationAttemptId = prepared.continuationAttemptId;

      const cwd = repositoryLease && authorityPath
        ? await this.repositoryLeases.resolveHeldRuntimeCwd(
            repositoryLease,
            authorityPath,
            repositoryLease.identity,
          )
        : run.worktreeDir ?? project.folderPath ?? process.cwd();
      if (reviewCheckout) {
        const issue = await this.reviewWorkspaceAuthorityIssue(reviewCheckout.id, true);
        if (issue) {
          await this.retireInvalidReviewRevival(run, reviewCheckout, issue);
          return null;
        }
      }
      let instructions = buildSpecialistInstructions({
        charter: snapshot.charter,
        podName: snapshot.name,
        expectedOutput: spec,
        acceptanceCriteria: (contract.acceptanceCriteria ?? []) as never,
        worktreeDir: run.worktreeDir ?? null,
      });
      if (snapshot.contextDocs.length > 0) {
        instructions += `\n\n## Context documents\n${snapshot.contextDocs
          .map((d) => `### ${d.title}\n${d.body}`)
          .join('\n\n')}`;
      }
      const tools = mergePcTools(
        undefined,
        buildPcToolDefs(AGENT_PC_TOOLS, {
          projectId: run.projectId,
          dispatcherSessionId: run.dispatcherSessionId,
          agentRunId: run.id,
          invokeDepth: (run.parentInvokeDepth ?? 0) + 1,
          serverPort: ctx.serverPort,
        }),
      );
      let session: RuntimeSession;
      try {
        session = await this.deps.mintSpecialistRuntimeSession({
          appSessionId: run.id,
          projectId: run.projectId,
          continuationAttemptId,
          selection,
          instructions,
          cwd,
          tools,
          maxTurns: snapshot.maxTurns,
          bypassPermissions: true,
          continuation: { mode: 'resume', nativeSessionId: prepared.nativeSessionId },
        });
      } catch {
        try {
          this.gateway.commitRunChange({
            reason: 'reconciled',
            mutate: (tx) => failAgentRunRuntimeResumeInDb(run.id, continuationAttemptId, tx),
          });
        } catch {
          // A kill/answer/racing recovery may already have advanced the row.
        }
        return null;
      }
      if (reviewCheckout) {
        const issue = await this.reviewWorkspaceAuthorityIssue(reviewCheckout.id, true);
        if (issue) {
          await this.disposeUninstalledRuntime(run.id as ULID, session);
          await this.retireInvalidReviewRevival(run, reviewCheckout, issue);
          return null;
        }
      }
      // The stale `run` snapshot predates an async provider resume. Only a
      // still-paused row may receive this projection; kill/answer/recovery can
      // have made the native session obsolete while it was being minted.
      const current = getAgentRunRow(run.id);
      if (
        !current ||
        this.ctx !== ctx ||
        this.shuttingDown ||
        current.status !== 'paused' ||
        current.continuationAttemptId !== continuationAttemptId ||
        current.continuationState !== 'resume-pending'
      ) {
        await this.disposeUninstalledRuntime(run.id as ULID, session);
        return null;
      }
      const liveRun: LiveRun = {
        session,
        selection,
        continuationAttemptId,
        receiptConfirmed: false,
        // A revived run gets a fresh wall clock from the moment of revival —
        // the original timer died with the old process along with everything
        // else in `this.live`.
        wallClock: setTimeout(() => {
          void this.killRun(run.projectId, run.id as ULID, {
            failureCause: 'wall-clock-timeout',
            failureReason: `run exceeded the ${Math.round(WALL_CLOCK_DEFAULT_MS / 60000)}min wall clock`,
          });
        }, WALL_CLOCK_DEFAULT_MS),
      };
      liveRun.wallClock.unref?.();
      return liveRun;
    } catch {
      console.error(`[pc-sdk][dispatch] live-session revival failed for run ${run.id}: ${RUNTIME_START_FAILURE_REASON}`);
      return null;
    }
  }

  private async ensureRevivedLiveSession(run: AgentRunRow): Promise<LiveRun | null> {
    if (this.shuttingDown) return null;
    const installed = this.live.get(run.id);
    if (installed) return installed;
    const pending = this.liveRevivals.get(run.id);
    if (pending) return pending;

    const revival = (async (): Promise<LiveRun | null> => {
      const candidate = await this.reviveLiveSession(run);
      if (this.shuttingDown) {
        if (candidate) {
          clearTimeout(candidate.wallClock);
          await this.disposeUninstalledRuntime(run.id as ULID, candidate.session);
        }
        return null;
      }
      const winner = this.live.get(run.id);
      if (winner) {
        if (candidate && candidate !== winner) {
          clearTimeout(candidate.wallClock);
          await this.disposeUninstalledRuntime(run.id as ULID, candidate.session);
        }
        return winner;
      }
      if (!candidate) return null;
      const current = getAgentRunRow(run.id);
      if (
        !current ||
        current.status !== 'paused' ||
        current.continuationAttemptId !== candidate.continuationAttemptId ||
        current.continuationState !== 'resume-pending'
      ) {
        clearTimeout(candidate.wallClock);
        await this.disposeUninstalledRuntime(run.id as ULID, candidate.session);
        return null;
      }
      this.live.set(run.id, candidate);
      return candidate;
    })();
    this.liveRevivals.set(run.id, revival);
    try {
      return await revival;
    } finally {
      if (this.liveRevivals.get(run.id) === revival) this.liveRevivals.delete(run.id);
    }
  }

  private liveAttemptIsCurrent(runId: ULID, liveRun: LiveRun): boolean {
    if (this.shuttingDown || this.live.get(runId) !== liveRun) return false;
    const row = getAgentRunRow(runId);
    const selection = row ? runtimeSelectionForAgentRun(row) : null;
    return !!row &&
      row.status !== 'completed' &&
      row.status !== 'failed' &&
      row.status !== 'cancelled' &&
      row.continuationAttemptId === liveRun.continuationAttemptId &&
      selection !== null &&
      runtimeSelectionsEqual(selection, liveRun.selection);
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
    let markedRunning = liveRun.receiptConfirmed && !opts.firstTurn;
    const transcriptTurnId = newId();

    let terminalResult: Awaited<ReturnType<typeof runTurn>>;
    try {
      terminalResult = await runTurn(turn, {
        emitChat: (event, identity) => {
          if (!this.liveAttemptIsCurrent(runId, liveRun)) {
            throw new Error('agent runtime emitted outside its active durable attempt');
          }
          if (!liveRun.receiptConfirmed) {
            throw new Error('agent runtime emitted before its session receipt was confirmed');
          }
          if (event.kind === 'assistant-text') lastText = event.text;
          this.persistAgentEvent(projectId, runId, transcriptTurnId, event, identity?.itemId);
        },
        emitDelta: () => {
          /* agent transcripts are persisted-event only; the modal heals over HTTP */
        },
        onRuntimeSessionReceipt: (receipt) => {
          if (!this.liveAttemptIsCurrent(runId, liveRun)) {
            throw new Error('agent runtime session receipt arrived outside its active attempt');
          }
          const confirmation = confirmAgentRunRuntimeSessionReceipt({ runId, receipt });
          if (confirmation.status === 'rejected') {
            if (
              confirmation.reason !== 'continuation-attempt-mismatch' &&
              getAgentRunRow(runId)?.continuationState === 'resume-pending'
            ) {
              failAgentRunRuntimeResume(runId, liveRun.continuationAttemptId);
            }
            throw new Error(`agent runtime session receipt rejected: ${confirmation.reason}`);
          }
          liveRun.receiptConfirmed = true;
          if (!markedRunning) {
            if (!this.announce(runId, 'running', { readyAt: Date.now() })) {
              throw new Error('agent run became terminal before receipt publication');
            }
            markedRunning = true;
          }
        },
        onSubscriptionQuota: (batch) => {
          if (
            !this.liveAttemptIsCurrent(runId, liveRun) ||
            !liveRun.receiptConfirmed ||
            batch.runtimeId !== liveRun.selection.runtimeId ||
            batch.accountId !== liveRun.selection.accountId
          ) {
            return;
          }
          try {
            this.deps.onSubscriptionQuota?.(batch);
          } catch {
            // Quota projection is telemetry and cannot fail specialist work.
          }
        },
        onDropped: () => {},
      });
    } catch {
      if (this.liveAttemptIsCurrent(runId, liveRun)) {
        if (!liveRun.receiptConfirmed) {
          try {
            // Provider output is never admitted before its positive receipt,
            // but the app still owes this attempted turn one canonical
            // terminal. Persist app-authored evidence outside that gate.
            this.persistAgentEvent(projectId, runId, transcriptTurnId, {
              kind: 'turn-failed',
              error: 'runtime session evidence was missing or invalid',
              source: 'internal',
            }, `${transcriptTurnId}:terminal`);
          } catch (error) {
            console.error(`[pc-sdk][dispatch] could not persist runtime-evidence terminal for ${runId}:`, error);
            return;
          }
        }
        if (getAgentRunRow(runId)?.continuationState === 'resume-pending') {
          failAgentRunRuntimeResume(runId, liveRun.continuationAttemptId);
        }
        this.settleTerminal(runId, {
          status: 'failed',
          result: lastText || null,
          failureCause: 'unexpected-exit',
          failureReason: 'agent runtime evidence was missing or invalid',
        }, liveRun.continuationAttemptId);
      }
      return;
    }

    // The row is the truth: an ask route may have flipped this run to paused
    // mid-turn — park the live session and wait for the answer.
    const row = getAgentRunRow(runId);
    if (!row || !this.liveAttemptIsCurrent(runId, liveRun)) return;
    if (row.status === 'paused') return;
    if (row.status === 'completed' || row.status === 'failed' || row.status === 'cancelled') return; // killed already

    if (terminalResult.terminal === 'turn-end') {
      // Tool-bridge-less delivery door: a clean turn end with no tool
      // deliverable may still have dropped a valid deliverable FILE at the
      // worktree root. Attempt it BEFORE settling — submitDeliverable refuses
      // once the run is terminal. A present-but-unusable file is a typed
      // failure; a missing file falls through to the normal no-deliverable gate.
      const door = await this.deliverFromFileDoor(runId);
      if (!this.liveAttemptIsCurrent(runId, liveRun)) return;
      if (typeof door === 'object') {
        this.settleTerminal(runId, {
          status: 'failed',
          result: lastText || null,
          failureCause: 'invalid-deliverable',
          failureReason: door.invalid,
        }, liveRun.continuationAttemptId);
      } else {
        this.settleTerminal(runId, { status: 'completed', result: lastText || null, failureCause: null, failureReason: null }, liveRun.continuationAttemptId);
      }
    } else if (terminalResult.outcome === 'budget-exhausted') {
      // A canonical budget-exhausted terminal, not a crash — distinct
      // failureCause so the run reads as resumable.
      this.settleTerminal(runId, {
        status: 'failed',
        result: lastText || null,
        failureCause: 'turn-budget-exhausted',
        failureReason:
          terminalResult.numTurns !== null
            ? `hit turn budget (${terminalResult.numTurns} turns) — resumable`
            : 'hit turn budget — resumable',
      }, liveRun.continuationAttemptId);
    } else {
      this.settleTerminal(runId, {
        status: 'failed',
        result: lastText || null,
        failureCause: 'unexpected-exit',
        failureReason: 'agent turn failed (see transcript)',
      }, liveRun.continuationAttemptId);
    }
  }

  private persistAgentEvent(
    projectId: ULID,
    runId: ULID,
    transcriptTurnId: string,
    event: ChatEvent,
    itemId?: string,
  ): void {
    const before = getAgentRunRow(runId);
    if (
      !before
      || before.status === 'completed'
      || before.status === 'failed'
      || before.status === 'cancelled'
    ) return;
    try {
      commitConversationEvent({
        projectId,
        conversationId: runId,
        sessionId: runId,
        family: conversationFamilyForEvent(event),
        event,
        turnId: transcriptTurnId,
        itemId: itemId ?? newId(),
        clientMessageId: null,
        occurredAt: Date.now(),
        deliveryKind: 'agent',
      });
    } catch (error) {
      const current = getAgentRunRow(runId);
      if (current && (current.status === 'completed' || current.status === 'failed' || current.status === 'cancelled')) {
        // A kill/terminal path closes transcript tools before stamping the run.
        // Late output from its disposed runtime is therefore safely ignored.
        return;
      }
      throw error;
    }
    try {
      this.ctx?.conversationRelay?.drain();
    } catch (err) {
      console.warn(`[pc-sdk][dispatch] transcript relay pending for ${runId}:`, err);
    }
  }

  /** A synchronous `sendTurn` exception never enters `runTurn`, so persist its
   * closed app-authored terminal before the agent-run row becomes terminal. */
  private persistAppAuthoredTurnFailure(projectId: ULID, runId: ULID, error: string): boolean {
    const transcriptTurnId = newId();
    try {
      this.persistAgentEvent(projectId, runId, transcriptTurnId, {
        kind: 'turn-failed',
        error,
        source: 'internal',
      }, `${transcriptTurnId}:terminal`);
      return true;
    } catch (persistError) {
      console.error(
        `[pc-sdk][dispatch] refusing terminal run state without a canonical turn failure for ${runId}:`,
        persistError,
      );
      return false;
    }
  }

  private announce(
    runId: ULID,
    status: 'spawning' | 'running',
    stamps: { spawnedAt?: number; readyAt?: number },
  ): boolean {
    if (!updateAgentRunStatus({ id: runId, status, ...stamps })) return false;
    this.gateway.announceRunChange({ runId, reason: status });
    return true;
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
      {
        text: buildAskEnvelope({
          runId: input.agentRunId,
          podName: row.podName,
          pendingAskId: askId,
          kind: input.kind,
          promptBody: input.promptBody,
          context: input.context,
          options: input.options,
        }),
        runId: input.agentRunId,
        agentName: row.podName,
        pendingAskId: askId,
        status: 'waiting',
        summary:
          input.kind === 'approval'
            ? `Approval requested: ${input.promptBody}`
            : `Question: ${input.promptBody}`,
      },
      `agent-ask:${askId}`,
    );
    return { ok: true, pendingAskId: askId };
  }

  /** pc_answer_pending / user answer door. Atomic flip + resume the parked
   *  session with the answer as its next message. */
  async answerPendingAsk(input: {
    projectId: ULID;
    pendingAskId: ULID;
    answer: string;
    answeredBy: 'orchestrator' | 'user';
  }): Promise<{ ok: true } | { ok: false; message: string; httpStatus: number }> {
    const ask = getPendingAsk(input.pendingAskId);
    if (!ask || ask.projectId !== input.projectId) return { ok: false, message: 'unknown pending ask', httpStatus: 404 };
    if (ask.status !== 'open') return { ok: false, message: `ask already ${ask.status}`, httpStatus: 409 };
    let liveRun = this.live.get(ask.agentRunId);
    if (!liveRun) {
      // F1 (comms-hardening): the in-process live handle does not survive a
      // restart. `recoverPausedAsks` re-attaches one for every paused run at
      // boot, but this lazy fallback covers any row it missed (revival
      // failure, ordering race) — try once more before giving up, so
      // answering a paused ask never 410s while its native session is still
      // resumable.
      const row = getAgentRunRow(ask.agentRunId);
      if (row && row.status === 'paused') {
        liveRun = (await this.ensureRevivedLiveSession(row)) ?? undefined;
      }
    }
    if (!liveRun) {
      return { ok: false, message: 'run is no longer live (server restarted) — re-dispatch or continue it', httpStatus: 410 };
    }
    const resumedRow = getAgentRunRow(ask.agentRunId);
    const resumedProject = resumedRow ? getProjectById(resumedRow.projectId) : null;
    if (resumedRow?.worktreeDir) {
      const identity = resumedRow?.gitReceipt?.repositoryIdentity ?? null;
      if (!identity) {
        return { ok: false, message: 'run has no immutable repository identity receipt', httpStatus: 503 };
      }
      try {
        await this.repositoryLeases.acquire(resumedRow.worktreeDir, identity);
      } catch (error) {
        const failure = repositoryLeaseFailure(error);
        return { ok: false, message: failure.message, httpStatus: failure.httpStatus };
      }
    } else if (resumedProject?.folderPath) {
      if (!resumedProject.repositoryIdentity) {
        return { ok: false, message: 'project has no immutable repository identity receipt', httpStatus: 503 };
      }
      try {
        await this.repositoryLeases.acquireForRuntimeCwd(
          resumedProject.folderPath,
          resumedProject.repositoryIdentity,
        );
      } catch (error) {
        const failure = repositoryLeaseFailure(error);
        return { ok: false, message: failure.message, httpStatus: failure.httpStatus };
      }
    }
    const flipped = this.gateway.answerAndResume({
      pendingAskId: input.pendingAskId,
      agentRunId: ask.agentRunId,
      answer: input.answer,
      answeredBy: input.answeredBy,
      now: Date.now(),
    });
    if (!flipped) return { ok: false, message: 'ask already answered (replay)', httpStatus: 409 };

    if (liveRun.receiptConfirmed) {
      if (!this.announce(ask.agentRunId, 'running', { readyAt: Date.now() })) {
        return { ok: false, message: 'run became terminal before answer delivery', httpStatus: 409 };
      }
    }
    let turn: AsyncIterable<RuntimeEvent>;
    try {
      turn = liveRun.session.sendTurn(`[answer from ${input.answeredBy}] ${input.answer}`);
    } catch {
      console.error(`[pc-sdk][dispatch] runtime resume-send failed for ${ask.agentRunId}: ${RUNTIME_SEND_FAILURE_REASON}`);
      if (!this.persistAppAuthoredTurnFailure(ask.projectId, ask.agentRunId as ULID, RUNTIME_SEND_FAILURE_REASON)) {
        return { ok: false, message: 'could not persist the failed resumed turn', httpStatus: 500 };
      }
      if (!liveRun.receiptConfirmed) {
        failAgentRunRuntimeResume(ask.agentRunId, liveRun.continuationAttemptId);
      }
      this.settleTerminal(ask.agentRunId, {
        status: 'failed',
        result: null,
        failureCause: 'send-failed',
        failureReason: RUNTIME_SEND_FAILURE_REASON,
      }, liveRun.continuationAttemptId);
      return { ok: true };
    }
    const resumedTask = this.consumeTurn(
      ask.agentRunId,
      ask.projectId,
      turn,
      { firstTurn: false },
    );
    this.trackRunTask(ask.agentRunId as ULID, resumedTask);
    void resumedTask.catch(() => {
      console.error(`[pc-sdk][dispatch] resumed turn crashed for ${ask.agentRunId}: ${RUNTIME_SEND_FAILURE_REASON}`);
      this.settleTerminal(ask.agentRunId, {
        status: 'failed',
        result: null,
        failureCause: 'send-failed',
        failureReason: RUNTIME_SEND_FAILURE_REASON,
      }, liveRun.continuationAttemptId);
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
    const now = Date.now();
    try {
      // Close transcript activity before the durable run terminal. A process
      // death after cancellation can then never strand a visible open call on
      // a terminal run that boot recovery intentionally skips.
      closeOpenConversationToolCalls({
        conversationId: runId,
        reason: 'turn-ended',
        deliveryKind: 'agent',
        occurredAt: now,
      });
    } catch (error) {
      console.error(`[pc-sdk][dispatch] refusing to cancel run ${runId} with open transcript state:`, error);
      return { ok: false, message: 'could not close the agent transcript before cancellation', httpStatus: 500 };
    }
    const openAsk = listOpenPendingAsksForProject(projectId).find((ask) => ask.agentRunId === runId) ?? null;
    const publication = this.gateway.cancelRun({
      runId,
      now,
      failureCause: opts.failureCause ?? 'cancelled',
      failureReason: opts.failureReason ?? 'killed via pc_kill_agent_run',
      cancelOpenAsk: openAsk?.id ?? null,
      // canTransition pre-check keeps the phantom-safe kill un-throwable.
      ...(row.lifecycleState !== null && canTransition(row.lifecycleState, 'cancelled')
        ? { lifecycleState: 'cancelled' as const }
        : {}),
    });
    const liveRun = this.live.get(runId);
    if (liveRun) {
      clearTimeout(liveRun.wallClock);
      this.live.delete(runId);
      this.retireRuntime(runId, liveRun.session);
    }
    // A killed REVIEW run must not wedge its target: route the (verdict-less)
    // terminal into the review gate — re-dispatch or the exhausted park.
    if (publication !== null) {
      const reviewTargetId = findContractByReviewRun(runId)?.id ?? this.reviewTargetsByRun.get(runId);
      const reviewCheckout = getReviewCheckoutForReviewer(runId);
      const isReviewCheckout = reviewCheckout !== null &&
        row.worktreeDir === reviewCheckout.worktreePath;
      if (reviewTargetId || isReviewCheckout) {
        void this.ensureReviewCleanup(runId, row, reviewTargetId as ULID | null).catch((err) => {
          console.error(`[pc-sdk][dispatch] review-kill retirement/settlement failed for ${runId}:`, err);
        });
      }
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
      const repositoryIdentity = row.gitReceipt?.repositoryIdentity ?? null;
      if (!repositoryIdentity) {
        return {
          ok: false,
          message: 'run has no immutable repository identity receipt',
          httpStatus: 503,
        };
      }
      try {
        await this.repositoryLeases.acquire(
          row.worktreeDir,
          repositoryIdentity,
        );
      } catch (error) {
        const failure = repositoryLeaseFailure(error);
        return { ok: false, message: failure.message, httpStatus: failure.httpStatus };
      }
      const runGit = this.deps.gitCommand ?? git;
      const status = await runGit(['status', '--porcelain'], row.worktreeDir);
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
      const head = await runGit(['rev-parse', 'HEAD'], row.worktreeDir);
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

    // All repository evidence above is asynchronous. A kill that wins while
    // Git is reading the worktree seals the run, so re-read at the mutation
    // door and reject instead of attaching a late deliverable/deliveredAt.
    const currentRun = getAgentRunRow(input.agentRunId);
    if (
      !currentRun
      || currentRun.status === 'completed'
      || currentRun.status === 'failed'
      || currentRun.status === 'cancelled'
    ) {
      return {
        ok: false,
        message: `run is '${currentRun?.status ?? 'missing'}' — its deliverable is sealed; dispatch a continuation to submit new work`,
        httpStatus: 409,
      };
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

  /** The file-based delivery door only opens for a tool-bridge-less runtime
   *  (adapter `appToolBridge === 'unsupported'`, e.g. Codex) that runs in a
   *  worktree — the sole case where the specialist has no pc_submit_deliverable
   *  tool but does have a root to write the signal file at. A tool-bridged
   *  runtime (Claude) keeps the canonical tool as its ONLY done-signal. */
  private fileDeliveryDoorOpen(runtimeId: string, worktreeDir: string | null): boolean {
    if (!worktreeDir) return false;
    return this.deps.appToolBridgeForRuntime?.(runtimeId) === 'unsupported';
  }

  /** Read + validate the deliverable FILE at the worktree root, for a
   *  bridge-less run that ended its turn without a tool deliverable. The file
   *  is removed BEFORE the seal (it must never land, and the clean-tree check
   *  in submitDeliverable must not see it as an uncommitted change), then run
   *  through the SAME `submitDeliverable` validation as the tool path.
   *  - `delivered`: a valid file sealed the deliverable (or the tool already
   *    delivered) — downstream verify/review/merge is identical to the tool.
   *  - `absent`: door shut, or no file — the loud `no-deliverable` failure
   *    stands unchanged.
   *  - `{ invalid }`: a present-but-unusable file (bad JSON, shape/kind
   *    rejected, or unremovable) — a typed failure carrying the reason. */
  private async deliverFromFileDoor(
    runId: ULID,
  ): Promise<'delivered' | 'absent' | { invalid: string }> {
    const row = getAgentRunRow(runId);
    if (!row) return 'absent';
    if (row.deliveredAt !== null) return 'delivered'; // tool deliverable already sealed
    const selection = runtimeSelectionForAgentRun(row);
    if (!selection || !this.fileDeliveryDoorOpen(selection.runtimeId, row.worktreeDir)) {
      return 'absent';
    }
    const filePath = join(row.worktreeDir!, DELIVERABLE_FILE_NAME);
    let raw: string;
    try {
      raw = await readFile(filePath, 'utf8');
    } catch {
      return 'absent'; // no file → existing no-deliverable path applies
    }
    // Remove before the seal — the landed tree must never carry the signal
    // file, and submitDeliverable's clean-tree gate must not read it as dirty.
    try {
      await rm(filePath, { force: true });
    } catch (error) {
      return {
        invalid: `deliverable file could not be removed before the sealed commit: ${(error as Error).message}`,
      };
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch (error) {
      return { invalid: `deliverable file is not valid JSON: ${(error as Error).message}` };
    }
    const shaped = shapeDeliverableFileContents(parsed);
    if (!shaped.ok) return { invalid: shaped.reason };
    const submitted = await this.submitDeliverable({
      projectId: row.projectId,
      agentRunId: runId,
      deliverable: shaped.deliverable,
      report: shaped.report,
    });
    if (!submitted.ok) return { invalid: submitted.message };
    return 'delivered';
  }

  /** pc_review_contract door — tier-2 sign-off. Accept ⇒ passed (+ land for
   *  repo); reject ⇒ failed with the reviewer's notes. */
  async reviewContract(input: {
    projectId: ULID;
    contractId: ULID;
    verdict: 'accept' | 'reject';
    notes?: string | null;
  }): Promise<{ ok: true; contract: Contract } | { ok: false; message: string; httpStatus: number }> {
    const count = this.reviewDecisionCounts.get(input.contractId) ?? 0;
    this.reviewDecisionCounts.set(input.contractId, count + 1);
    try {
      return await this.reviewContractInner(input);
    } finally {
      const remaining = (this.reviewDecisionCounts.get(input.contractId) ?? 1) - 1;
      if (remaining > 0) this.reviewDecisionCounts.set(input.contractId, remaining);
      else this.reviewDecisionCounts.delete(input.contractId);
    }
  }

  private async reviewContractInner(input: {
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
    const producingRun = contract.agentRunId
      ? getAgentRunRow(contract.agentRunId as ULID)
      : null;
    if (contract.agentRunId) {
      if (producingRun && !['completed', 'failed', 'cancelled'].includes(producingRun.status)) {
        return {
          ok: false,
          message: `producing run ${contract.agentRunId} is still '${producingRun.status}' — review after the run settles`,
          httpStatus: 409,
        };
      }
    }
    // Refuse before clearing/killing any reviewer when the target producer is
    // still verifying/landing (or failed to settle). Only the exact reviewer
    // this decision intends to supersede is excluded from this preflight; the
    // post-cleanup check below restores the full fence.
    const preOverrideIssue = this.contractRuntimeQuiescenceIssue(
      contract.id,
      true,
      null,
      contract.reviewRunId,
    );
    if (preOverrideIssue) {
      return {
        ok: false,
        message: preOverrideIssue,
        httpStatus: 409,
      };
    }
    let reviewRepositoryIdentity: RepositoryIdentityReceipt | null = null;
    if ((contract.expectedOutput as ExpectedOutput | null)?.kind === 'repo') {
      const identity = producingRun?.gitReceipt?.repositoryIdentity ?? null;
      const path = producingRun?.worktreeDir ?? null;
      const project = getProjectById(contract.projectId as ULID);
      if (!identity || !path || !project?.folderPath) {
        return {
          ok: false,
          message: 'producing run has no immutable repository identity receipt or project folder',
          httpStatus: 503,
        };
      }
      try {
        await this.repositoryLeases.acquire(path, identity);
        await this.repositoryLeases.acquire(project.folderPath, identity);
      } catch (error) {
        const failure = repositoryLeaseFailure(error);
        return { ok: false, message: failure.message, httpStatus: failure.httpStatus };
      }
      reviewRepositoryIdentity = identity;
    }
    // Orchestrator override supersedes an in-flight independent review, but
    // keeps the exact marker as durable cleanup authority until the reviewer
    // is terminal and its detached checkout has positively settled.
    if (contract.reviewRunId) {
      const supersededReviewId = contract.reviewRunId as ULID;
      this.reviewOverrides.add(supersededReviewId);
      try {
        const admissionTask = this.reviewAdmissionTasks.get(supersededReviewId);
        if (admissionTask) await admissionTask;
        const afterAdmission = this.contracts.get(contract.id);
        if (!afterAdmission || afterAdmission.reviewRunId !== supersededReviewId) {
          return {
            ok: false,
            message: 'independent reviewer changed while override authority was awaiting — review the current reservation instead',
            httpStatus: 409,
          };
        }
        const reviewRun = getAgentRunRow(supersededReviewId);
        if (reviewRun && !['completed', 'failed', 'cancelled'].includes(reviewRun.status)) {
          await this.killRun(contract.projectId as ULID, supersededReviewId, {
            failureCause: 'cancelled',
            failureReason: 'independent review superseded by orchestrator pc_review_contract',
          });
        }
        const settledReviewRun = getAgentRunRow(supersededReviewId) ?? reviewRun;
        const checkout = getReviewCheckoutForReviewer(supersededReviewId);
        try {
          if (settledReviewRun) {
          await this.ensureReviewCleanup(supersededReviewId, settledReviewRun, contract.id as ULID);
          } else if (checkout) {
            await this.settleReviewCheckoutCleanup(checkout);
          } else {
            throw new Error('durable review checkout authority is unavailable');
          }
        } catch (error) {
          return {
            ok: false,
            message: `independent reviewer could not be positively retired: ${error instanceof Error ? error.message : 'cleanup failed'}`,
            httpStatus: 409,
          };
        }
        const clearedReservation = this.contracts.clearReviewReservation({
          id: contract.id,
          reviewRunId: supersededReviewId,
        });
        const atomicallyCleared = this.contracts.get(contract.id);
        const settledCheckout = getReviewCheckoutForReviewer(supersededReviewId);
        if (!clearedReservation && !(
          atomicallyCleared?.reviewRunId === null &&
          settledCheckout?.verdictAppliedAt !== null &&
          settledCheckout?.verdictReceipt?.outcome === 'overridden'
        )) {
          return {
            ok: false,
            message: 'independent reviewer changed before cleanup settlement could clear its reservation',
            httpStatus: 409,
          };
        }
      } finally {
        this.reviewOverrides.delete(supersededReviewId);
      }
    }
    const settlementIssue = this.contractRuntimeQuiescenceIssue(contract.id, true);
    if (settlementIssue) {
      return {
        ok: false,
        message: settlementIssue,
        httpStatus: 409,
      };
    }
    // Clearing/killing a reviewer can await. Bind this decision to the same
    // settled producer the caller reviewed; a continuation that moved the
    // contract during that window wins and makes this verdict stale.
    let decision = this.contracts.get(contract.id);
    const decisionProducer = decision?.agentRunId
      ? getAgentRunRow(decision.agentRunId as ULID)
      : null;
    if (
      !decision ||
      decision.agentRunId !== contract.agentRunId ||
      decision.reviewRunId !== null ||
      decision.landingStatus === 'pending' ||
      decision.landingStatus === 'abandoning' ||
      decision.landingStatus === 'landed' ||
      decision.landingStatus === 'abandoned' ||
      !decisionProducer ||
      !['completed', 'failed', 'cancelled'].includes(decisionProducer.status)
    ) {
      return {
        ok: false,
        message: 'contract producer changed while applying the review verdict — review the current producer instead',
        httpStatus: 409,
      };
    }
    const notes = input.notes ?? null;
    if (input.verdict === 'reject') {
      const updated = this.contracts.setVerification({
        id: decision.id,
        verificationStatus: 'failed',
        verificationNotes: notes ?? 'rejected by orchestrator review',
      });
      // review-rejected is NOT necessarily terminal — fixing stays legal.
      if (decision.agentRunId) this.stampLifecycle(decision.agentRunId as ULID, 'review-rejected');
      return updated ? { ok: true, contract: updated } : { ok: false, message: 'contract vanished', httpStatus: 500 };
    }
    // Accept IS the revalidation (guard 7's recovery door): the orchestrator
    // reviewed against the repo as it stands NOW, so the verified base moves
    // to the current target tip — a stale-base park re-lands on re-accept.
    let verifiedBaseSha: string | undefined;
    if ((decision.expectedOutput as ExpectedOutput | null)?.kind === 'repo') {
      const project = getProjectById(decision.projectId as ULID);
      if (!project?.folderPath || !decision.worktreeBaseBranch || !reviewRepositoryIdentity) {
        return {
          ok: false,
          message: 'repository accept-time revalidation inputs are unavailable',
          httpStatus: 503,
        };
      }
      try {
        // Reviewer cancellation above awaited runtime disposal and checkout
        // reclaim. Revalidate the mutable project path again immediately
        // before reading the base evidence that will be persisted as passed.
        await this.repositoryLeases.acquire(
          project.folderPath,
          reviewRepositoryIdentity,
        );
      } catch (error) {
        const failure = repositoryLeaseFailure(error);
        return { ok: false, message: failure.message, httpStatus: failure.httpStatus };
      }
      const tip = await git(
        ['rev-parse', `refs/heads/${decision.worktreeBaseBranch}`],
        project.folderPath,
      );
      if (!tip.ok) {
        return {
          ok: false,
          message: `cannot resolve repository base for accept-time revalidation: ${tip.stderr || 'no output'}`,
          httpStatus: 503,
        };
      }
      verifiedBaseSha = tip.stdout;
    }
    const afterBaseRead = this.contracts.get(decision.id);
    if (
      !afterBaseRead ||
      afterBaseRead.version !== decision.version ||
      afterBaseRead.agentRunId !== decision.agentRunId ||
      JSON.stringify(afterBaseRead.deliverable) !== JSON.stringify(decision.deliverable)
    ) {
      return {
        ok: false,
        message: 'contract evidence changed while applying the review verdict — review the current evidence instead',
        httpStatus: 409,
      };
    }
    decision = afterBaseRead;
    let updated = this.contracts.setVerification({
      id: decision.id,
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
      try {
        updated = (await this.landAcceptedContract(updated, 'orchestrator')) ?? updated;
      } catch (error) {
        const failure = repositoryLeaseFailure(error);
        return { ok: false, message: failure.message, httpStatus: failure.httpStatus };
      }
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
    continuationAttemptId?: string,
  ): void {
    const row = getAgentRunRow(runId);
    if (!row) return;
    if (
      continuationAttemptId !== undefined &&
      row.continuationAttemptId !== continuationAttemptId
    ) return;
    try {
      closeOpenConversationToolCalls({
        conversationId: runId,
        reason: 'turn-ended',
        deliveryKind: 'agent',
      });
    } catch (error) {
      // The run row must remain nonterminal if its visible transcript cannot
      // first reach a closed lifecycle. Boot recovery can safely retry it.
      console.error(`[pc-sdk][dispatch] refusing terminal run state with an open transcript for ${runId}:`, error);
      return;
    }
    // The completion gate: delivery is the sole done-signal.
    let status = input.status;
    let failureCause = input.failureCause;
    let failureReason = input.failureReason;
    const contract = row.contractId ? this.contracts.get(row.contractId) : null;
    if (status === 'completed' && row.deliveredAt === null) {
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
    const reviewCheckout = getReviewCheckoutForReviewer(runId);
    const autoContinueEligible = status === 'failed' &&
      failureCause === 'turn-budget-exhausted' &&
      reviewCheckout === null;
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
      ...(continuationAttemptId !== undefined ? { continuationAttemptId } : {}),
      ...(lifecycleState !== undefined ? { lifecycleState } : {}),
    });
    if (!publication) return; // already terminal or stale runtime attempt

    const liveRun = this.live.get(runId);
    let retirement: Promise<void> = Promise.resolve();
    if (liveRun && (
      continuationAttemptId === undefined ||
      liveRun.continuationAttemptId === continuationAttemptId
    )) {
      clearTimeout(liveRun.wallClock);
      this.live.delete(runId);
      retirement = this.retireRuntime(runId, liveRun.session);
    }

    if (autoContinue) {
      // Suppressed envelope: this terminal is an intermediate stop on the
      // way to auto-continuation, never a chat turn for the orchestrator.
      // verifyAndLand (contract verification + envelope + review-verdict
      // routing) runs only on the FINAL outcome — skipping it here also
      // avoids reclaiming a review checkout the continuation is about to
      // resume in.
      void this.trackPostTerminalTask(runId, async () => {
        await retirement;
        await this.fireAutoContinue(runId, row);
      })
        .catch((err) => {
          console.error(`[pc-sdk][dispatch] auto-continue retirement/start failed for ${runId}:`, err);
        });
      return;
    }

    void this.trackPostTerminalTask(runId, async () => {
      await retirement;
      await this.verifyAndLand(runId, status);
    })
      .catch((err) => {
        console.error(`[pc-sdk][dispatch] runtime retirement or verify/land failed for ${runId}:`, err);
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
      await this.verifyAndLand(runId, 'failed');
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
        const reviewCheckout = getReviewCheckoutForReviewer(row.id as ULID);
        if (reviewCheckout) {
          await this.trackPostTerminalTask(
            row.id as ULID,
            () => this.ensureReviewCleanup(
              row.id as ULID,
              row,
              reviewCheckout.contractId,
            ),
          );
          continue;
        }
        if (row.autoContinueCount >= MAX_AUTO_CONTINUES) continue; // ceiling already reached
        if (hasContinuation(row.id)) continue; // already fired
        console.warn(
          `[auto-continue] resuming after restart — run ${row.id}, attempt ${row.autoContinueCount + 1}/${MAX_AUTO_CONTINUES}`,
        );
        await this.trackPostTerminalTask(
          row.id as ULID,
          () => this.fireAutoContinue(row.id as ULID, row),
        );
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

    if (
      contract &&
      terminalStatus === 'completed' &&
      (contract.expectedOutput as ExpectedOutput | null)?.kind === 'repo'
    ) {
      const identity = row.gitReceipt?.repositoryIdentity ?? null;
      if (!row.worktreeDir || !identity) {
        console.warn(
          `[pc-sdk][dispatch] verification deferred for ${runId}: immutable repository identity unavailable`,
        );
        return;
      }
      try {
        await this.repositoryLeases.acquire(row.worktreeDir, identity);
      } catch (error) {
        console.warn(
          `[pc-sdk][dispatch] verification deferred for ${runId}: ${repositoryLeaseFailure(error).message}`,
        );
        return;
      }
    }

    // Fresh outcome from THIS settlement — the auto-land gate refuses to read
    // a stale row status (guard 5: missing evidence never means pass).
    let outcome: VerificationOutcome | null = null;
    let verificationDrifted = false;
    if (contract && terminalStatus === 'completed' && contract.agentRunId === runId) {
      const verifiedVersion = contract.version;
      const verifiedProducer = contract.agentRunId;
      const verifiedDeliverable = JSON.stringify(contract.deliverable);
      outcome = await (this.deps.verifyContract ?? verifyContract)({
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
      } else if (
        !latest ||
        latest.version !== verifiedVersion ||
        latest.agentRunId !== verifiedProducer ||
        JSON.stringify(latest.deliverable) !== verifiedDeliverable
      ) {
        // A continuation/reseal/review changed the evidence while predicates
        // awaited git or tools. Never apply A's result to B, and never enter a
        // landing gate from this stale verification.
        verificationDrifted = true;
        outcome = null;
        contract = latest;
        console.warn(`[pc-sdk][dispatch] verification evidence drifted for contract ${row.contractId}; stale outcome discarded`);
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
    } else if (contract && terminalStatus === 'completed') {
      verificationDrifted = true;
      console.warn(`[pc-sdk][dispatch] contract ${contract.id} moved to producer ${contract.agentRunId ?? '(none)'} before run ${runId} verification; skipped`);
    } else if (contract && terminalStatus === 'failed' && contract.agentRunId === runId) {
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
    } else if (contract && terminalStatus === 'failed') {
      verificationDrifted = true;
    }

    // Landing policy (docs/worktree-lifecycle.md): auto-merge is OPT-IN. A
    // passed repo contract lands automatically only under the 'auto-merge'
    // policy (stamped at creation; legacy NULL rows read through the spec's
    // auto_land); otherwise it parks merge-ready for the orchestrator to
    // review the diff and authorize via pc_review_contract accept.
    const spec = contract?.expectedOutput as ExpectedOutput | null;
    if (
      !verificationDrifted &&
      contract &&
      contract.landingStatus !== 'landed' &&
      contract.landingStatus !== 'abandoning' &&
      contract.landingStatus !== 'abandoned' &&
      contract.verificationStatus === 'passed' &&
      spec?.kind === 'repo'
    ) {
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
    const deliverableSummary = summarizeDeliverable(contract?.deliverable as Deliverable | null);
    this.deliverToOrchestrator(
      row.projectId,
      {
        text: buildTerminalEnvelope({
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
          deliverableSummary,
          pmRef: freshRow.pmRef,
        }),
        runId,
        agentName: row.podName,
        status: kind === 'agent-completed' ? 'done' : 'failed',
        summary:
          kind === 'agent-completed'
            ? (deliverableSummary ?? freshRow.result ?? 'Completed')
            : `Failed${freshRow.failureCause ? ` (${freshRow.failureCause})` : ''}${freshRow.failureReason ? `: ${freshRow.failureReason}` : ''}`,
      },
      `agent-terminal:${runId}`,
    );

    // Independent-review settlement: when THIS run was a review dispatch (the
    // durable reviewRunId marker on the target contract), its terminal carries
    // the verdict for the contract under review.
    const reviewTargetId = findContractByReviewRun(runId)?.id ?? this.reviewTargetsByRun.get(runId);
    const reviewCheckout = getReviewCheckoutForReviewer(runId);
    const isReviewCheckout = reviewCheckout !== null &&
      freshRow.worktreeDir === reviewCheckout.worktreePath;
    if (reviewTargetId || isReviewCheckout) {
      await this.ensureReviewCleanup(runId, freshRow, reviewTargetId as ULID | null);
    }
  }

  // ── full independent review (docs/worktree-lifecycle.md :175-187) ───────────

  private reviewCheckoutAuthority(checkout: ReviewCheckout): ReviewCheckoutAuthority {
    return {
      id: checkout.id,
      projectId: checkout.projectId,
      contractId: checkout.contractId,
      contractVersion: checkout.contractVersion,
      producerRunId: checkout.producerRunId,
      reviewerRunId: checkout.reviewerRunId,
      repositoryIdentity: checkout.repositoryIdentity,
      worktreePath: checkout.worktreePath,
      ownedRootRealPath: checkout.ownedRootRealPath,
      sealedCommit: checkout.sealedCommit,
    };
  }

  private reviewCheckoutMechanicsAuthority(checkout: ReviewCheckout, projectDir: string) {
    return {
      ...this.reviewCheckoutAuthority(checkout),
      projectDir,
    };
  }

  private reviewGitReceipt(
    authority: ReviewCheckoutAuthority,
    provision: ReviewCheckoutProvisionReceipt,
  ): ReviewCheckoutGitReceipt {
    return {
      ...authority,
      protocol: 'review-checkout-git-v1',
      branch: '(detached)',
      baseBranch: '(detached)',
      baseSha: authority.sealedCommit,
      cleanStatus: true,
      registrationCount: 1,
      registrationPath: authority.worktreePath,
      headSha: authority.sealedCommit,
      detachedHead: true,
      trackedChanges: 0,
      stagedChanges: 0,
      observedAt: provision.observedAt,
    };
  }

  /** Fresh durable + Git authorization. Null is positive; any string is a
   * typed refusal suitable for a terminal receipt. The second DB/contract read
   * closes every await inside inspection. */
  private async reviewWorkspaceAuthorityIssue(
    checkoutId: ULID,
    requireRuntimeReady: boolean,
  ): Promise<string | null> {
    const checkout = getReviewCheckoutById(checkoutId);
    if (!checkout) return `review checkout ${checkoutId} is unavailable`;
    if (checkout.status !== 'provisioned' ||
        !isMatchingReviewCheckoutProvision(checkout, checkout.provisionReceipt) ||
        checkout.teardownReceipt !== null || checkout.destroyedAt !== null ||
        checkout.cleanupError !== null) {
      return `review checkout ${checkoutId} has no positive provision authority`;
    }
    if (requireRuntimeReady && !isReviewCheckoutRuntimeReady(checkout)) {
      return `review checkout ${checkoutId} has incomplete preparation/readiness evidence`;
    }
    const target = this.contracts.get(checkout.contractId);
    const reviewer = getAgentRunRow(checkout.reviewerRunId);
    const gitReceipt = reviewer?.gitReceipt;
    if (!target || target.version !== checkout.contractVersion ||
        target.reviewRunId !== checkout.reviewerRunId ||
        target.agentRunId !== checkout.producerRunId ||
        target.reviewSealedCommit !== checkout.sealedCommit ||
        (target.deliverable as { commit?: string } | null)?.commit !== checkout.sealedCommit ||
        target.landingStatus !== null) {
      return `review checkout ${checkoutId} target reservation or seal drifted`;
    }
    if (!reviewer || reviewer.projectId !== checkout.projectId ||
        reviewer.worktreeDir !== checkout.worktreePath ||
        !isReviewCheckoutGitReceipt(gitReceipt) ||
        gitReceipt.id !== checkout.id ||
        gitReceipt.contractVersion !== checkout.contractVersion ||
        gitReceipt.reviewerRunId !== checkout.reviewerRunId ||
        gitReceipt.worktreePath !== checkout.worktreePath ||
        gitReceipt.sealedCommit !== checkout.sealedCommit) {
      return `review checkout ${checkoutId} reviewer Git receipt is missing or stale`;
    }
    if (requireRuntimeReady &&
        (!reviewCheckoutPhaseMatchesRun(
          checkout,
          checkout.preparationReceipt,
          reviewer.preparationReceipt,
          'preparation',
        ) ||
        !reviewCheckoutPhaseMatchesRun(
          checkout,
          checkout.readinessReceipt,
          reviewer.readinessReceipt,
          'readiness',
        ))) {
      return `review checkout ${checkoutId} run/workspace phase evidence is mismatched`;
    }
    const project = getProjectById(checkout.projectId);
    if (!project?.folderPath) return `review checkout ${checkoutId} project folder is unavailable`;
    const inspected = await inspectReviewCheckout(
      this.reviewCheckoutMechanicsAuthority(checkout, project.folderPath),
    );
    if (!inspected.ok) return `${inspected.code}: ${inspected.error}`;
    if (!isMatchingReviewCheckoutProvision(checkout, inspected.receipt)) {
      return `review checkout ${checkoutId} fresh Git evidence does not match durable authority`;
    }
    const current = getReviewCheckoutById(checkoutId);
    const currentTarget = this.contracts.get(checkout.contractId);
    const currentReviewer = getAgentRunRow(checkout.reviewerRunId);
    if (!current || current.updatedAt !== checkout.updatedAt ||
        current.status !== 'provisioned' ||
        (requireRuntimeReady ? !isReviewCheckoutRuntimeReady(current) :
          !isMatchingReviewCheckoutProvision(current, current.provisionReceipt)) ||
        !currentTarget || currentTarget.version !== checkout.contractVersion ||
        currentTarget.reviewRunId !== checkout.reviewerRunId ||
        currentTarget.agentRunId !== checkout.producerRunId ||
        currentTarget.reviewSealedCommit !== checkout.sealedCommit ||
        (currentTarget.deliverable as { commit?: string } | null)?.commit !== checkout.sealedCommit ||
        currentTarget.landingStatus !== null ||
        (requireRuntimeReady &&
          (!currentReviewer ||
            !reviewCheckoutPhaseMatchesRun(
              current,
              current.preparationReceipt,
              currentReviewer.preparationReceipt,
              'preparation',
            ) ||
            !reviewCheckoutPhaseMatchesRun(
              current,
              current.readinessReceipt,
              currentReviewer.readinessReceipt,
              'readiness',
            )))) {
      return `review checkout ${checkoutId} authority changed while Git evidence was inspected`;
    }
    return null;
  }

  private boundedReviewCleanupError(error: string): string {
    const normalized = error.trim() || 'review checkout cleanup failed without detail';
    return normalized.length > 2000 ? `${normalized.slice(0, 1999)}…` : normalized;
  }

  /** The sole retryable teardown door. A successful remove exit is not used
   * as evidence: mechanics must positively prove exact directory and Git
   * registration absence before the full-authority durable CAS can settle. */
  private async settleReviewCheckoutCleanup(observed: ReviewCheckout): Promise<ReviewCheckout> {
    let current = getReviewCheckoutById(observed.id) ?? observed;
    const authority = this.reviewCheckoutAuthority(observed);
    if (current.status === 'destroyed') {
      if (isMatchingReviewCheckoutTeardown(authority, current.teardownReceipt)) return current;
      throw new Error(`review checkout ${observed.id} has malformed destroyed evidence`);
    }
    if (current.status === 'reserved' || current.status === 'provisioned') {
      const pending = markReviewCheckoutTeardownPending({
        authority,
        expectedUpdatedAt: current.updatedAt,
        fromStatus: current.status,
        at: Date.now(),
        error: null,
      });
      current = pending ?? getReviewCheckoutById(observed.id) ?? current;
    }
    if (current.status === 'destroyed' &&
        isMatchingReviewCheckoutTeardown(authority, current.teardownReceipt)) return current;
    if (current.status !== 'teardown-pending') {
      throw new Error(`review checkout ${observed.id} could not enter teardown-pending`);
    }
    const project = getProjectById(observed.projectId);
    if (!project?.folderPath) {
      const detail = this.boundedReviewCleanupError('project folder unavailable during review checkout teardown');
      setReviewCheckoutCleanupError({ authority, expectedUpdatedAt: current.updatedAt, error: detail, at: Date.now() });
      throw new Error(detail);
    }
    const removed = await removeReviewCheckout(
      this.reviewCheckoutMechanicsAuthority(observed, project.folderPath),
    );
    if (!removed.ok) {
      const detail = this.boundedReviewCleanupError(`${removed.code}: ${removed.error}`);
      const latest = getReviewCheckoutById(observed.id);
      if (latest?.status === 'teardown-pending') {
        setReviewCheckoutCleanupError({ authority, expectedUpdatedAt: latest.updatedAt, error: detail, at: Date.now() });
      }
      throw new Error(detail);
    }
    const teardownReceipt = removed.receipt;
    const beforeSettle = getReviewCheckoutById(observed.id);
    if (!beforeSettle) throw new Error(`review checkout ${observed.id} vanished before teardown settlement`);
    const settled = beforeSettle.status === 'teardown-pending'
      ? settleReviewCheckoutTeardown({
          authority,
          expectedUpdatedAt: beforeSettle.updatedAt,
          receipt: teardownReceipt,
          destroyedAt: teardownReceipt.finishedAt,
        })
      : null;
    const final = settled ?? getReviewCheckoutById(observed.id);
    if (!final || final.status !== 'destroyed' ||
        !isMatchingReviewCheckoutTeardown(authority, final.teardownReceipt)) {
      throw new Error(`review checkout ${observed.id} external cleanup succeeded but durable settlement is unresolved`);
    }
    return final;
  }

  private buildReviewVerdictReceipt(
    checkout: ReviewCheckout,
    row: AgentRunRow,
    target: Contract,
    reviewerContract: Contract | null,
    workspaceAuthorityIssue: string | null,
  ): ReviewCheckoutVerdictReceipt {
    const terminalStatus = row.status as 'completed' | 'failed' | 'cancelled';
    const producingRow = target.agentRunId
      ? getAgentRunRow(target.agentRunId as ULID)
      : null;
    const stableFrame = target.version === checkout.contractVersion &&
      target.agentRunId === checkout.producerRunId &&
      target.reviewRunId === checkout.reviewerRunId &&
      target.reviewSealedCommit === checkout.sealedCommit &&
      target.verificationStatus === 'passed' &&
      target.landingStatus === null &&
      (target.deliverable as { commit?: string } | null)?.commit === checkout.sealedCommit &&
      producingRow !== null &&
      ['completed', 'failed', 'cancelled'].includes(producingRow.status) &&
      producingRow.lifecycleState === 'reviewing';
    const trustedReviewAuthority = workspaceAuthorityIssue === null &&
      isReviewCheckoutRuntimeReady(checkout) &&
      row.id === checkout.reviewerRunId &&
      isReviewCheckoutGitReceipt(row.gitReceipt) &&
      row.gitReceipt.id === checkout.id &&
      row.gitReceipt.contractId === checkout.contractId &&
      row.gitReceipt.contractVersion === checkout.contractVersion &&
      row.gitReceipt.producerRunId === checkout.producerRunId &&
      row.gitReceipt.reviewerRunId === checkout.reviewerRunId &&
      row.gitReceipt.worktreePath === checkout.worktreePath &&
      row.gitReceipt.sealedCommit === checkout.sealedCommit &&
      reviewCheckoutPhaseMatchesRun(
        checkout,
        checkout.preparationReceipt,
        row.preparationReceipt,
        'preparation',
      ) &&
      reviewCheckoutPhaseMatchesRun(
        checkout,
        checkout.readinessReceipt,
        row.readinessReceipt,
        'readiness',
      );
    const verdict = terminalStatus === 'completed' &&
      reviewerContract?.verificationStatus === 'passed'
      ? parseReviewVerdictPayload(
          (reviewerContract.deliverable as { data?: unknown } | null)?.data,
        )
      : null;
    const outcome = this.reviewOverrides.has(row.id)
      ? 'overridden'
      : !stableFrame
        ? 'void'
        : !trustedReviewAuthority
          ? 'unavailable'
          : verdict?.verdict ?? 'unavailable';
    return {
      ...this.reviewCheckoutAuthority(checkout),
      protocol: 'review-checkout-verdict-v1',
      reviewerContractId: row.contractId,
      terminalStatus,
      outcome,
      findings: outcome === 'approve' || outcome === 'reject'
        ? verdict?.findings ?? []
        : [],
      recordedAt: Date.now(),
    };
  }

  private recordReviewVerdict(
    observed: ReviewCheckout,
    row: AgentRunRow,
    target: Contract,
    reviewerContract: Contract | null,
    workspaceAuthorityIssue: string | null,
  ): ReviewCheckout {
    const current = getReviewCheckoutById(observed.id) ?? observed;
    if (current.verdictReceipt) {
      if (isMatchingReviewCheckoutVerdict(current, current.verdictReceipt)) return current;
      throw new Error(`review checkout ${current.id} has malformed verdict evidence`);
    }
    const receipt = this.buildReviewVerdictReceipt(
      current,
      row,
      target,
      reviewerContract,
      workspaceAuthorityIssue,
    );
    const recorded = setReviewCheckoutVerdictReceipt({
      authority: this.reviewCheckoutAuthority(current),
      expectedUpdatedAt: current.updatedAt,
      receipt,
    });
    if (!recorded || !isMatchingReviewCheckoutVerdict(recorded, recorded.verdictReceipt)) {
      throw new Error(`review checkout ${current.id} verdict could not be recorded before teardown`);
    }
    return recorded;
  }

  private async applyReviewVerdictEffect(observed: ReviewCheckout): Promise<void> {
    const checkout = getReviewCheckoutById(observed.id) ?? observed;
    const receipt = checkout.verdictReceipt;
    if (!receipt || !isMatchingReviewCheckoutVerdict(checkout, receipt)) {
      throw new Error(`review checkout ${checkout.id} has no exact typed verdict receipt`);
    }
    if (checkout.verdictAppliedAt !== null) return;
    if (checkout.status !== 'destroyed' ||
        !isMatchingReviewCheckoutTeardown(checkout, checkout.teardownReceipt)) {
      throw new Error(`review checkout ${checkout.id} verdict is fenced by incomplete teardown`);
    }
    const appliedAt = Math.max(Date.now(), (checkout.destroyedAt ?? 0) + 1);
    const target = this.contracts.applyReviewCheckoutVerdict({
      receipt,
      expectedCheckoutUpdatedAt: checkout.updatedAt,
      appliedAt,
    });
    const settled = getReviewCheckoutById(checkout.id);
    if (!target || !settled || settled.verdictAppliedAt !== appliedAt) {
      throw new Error(`review checkout ${checkout.id} verdict effect could not settle atomically`);
    }
    if (receipt.outcome === 'approve') {
      await this.landAcceptedContract(target, 'reviewer');
      return;
    }
    if (receipt.outcome === 'reject') {
      return;
    }
    if (receipt.outcome === 'unavailable' || receipt.outcome === 'void') {
      console.warn(
        `[pc-sdk][dispatch] review run ${receipt.reviewerRunId} settled '${receipt.outcome}' ` +
        `for contract ${receipt.contractId} — re-entering the review gate when eligible.`,
      );
      if (!this.shuttingDown) await this.ensureIndependentReview(receipt.contractId);
    }
  }

  /** One idempotent cleanup owner per reviewer. Typed verdict evidence is
   * recorded before teardown; its target effect commits only after exact
   * positive absence, so every crash point is a durable recovery feeder. */
  private ensureReviewCleanup(
    runId: ULID,
    observedRow: AgentRunRow | null,
    observedTargetId: ULID | null,
  ): Promise<void> {
    const existing = this.reviewCleanupTasks.get(runId);
    if (existing) return existing;
    const task = (async () => {
      const quiescenceIssue = await this.awaitRunRuntimeQuiescence(runId);
      if (quiescenceIssue) throw new Error(quiescenceIssue);
      const row = getAgentRunRow(runId) ?? observedRow;
      if (!row) throw new Error(`review run ${runId} is unavailable`);
      if (!['completed', 'failed', 'cancelled'].includes(row.status)) {
        throw new Error(`review run ${runId} is still '${row.status}'`);
      }
      const reviewTarget = findContractByReviewRun(runId);
      const reviewTargetId = reviewTarget?.id ?? this.reviewTargetsByRun.get(runId) ?? observedTargetId;
      let checkout = getReviewCheckoutForReviewer(runId);
      if (!checkout) throw new Error(`review run ${runId} has no durable checkout authority`);
      if (reviewTarget) {
        const reviewerContract = row.contractId ? this.contracts.get(row.contractId) : null;
        const workspaceAuthorityIssue = checkout.verdictReceipt
          ? null
          : await this.reviewWorkspaceAuthorityIssue(checkout.id, true);
        if (workspaceAuthorityIssue) {
          console.warn(
            `[pc-sdk][dispatch] review ${runId} terminal verdict authority refused: ${workspaceAuthorityIssue}`,
          );
        }
        checkout = this.recordReviewVerdict(
          checkout,
          row,
          reviewTarget,
          reviewerContract,
          workspaceAuthorityIssue,
        );
      }
      checkout = await this.settleReviewCheckoutCleanup(checkout);
      if (checkout.verdictReceipt) await this.applyReviewVerdictEffect(checkout);
      if (reviewTargetId && this.reviewTargetsByRun.get(runId) === reviewTargetId) {
        this.reviewTargetsByRun.delete(runId);
      }
    })();
    this.reviewCleanupTasks.set(runId, task);
    this.pendingReviewCleanupTasks.add(task);
    void task.finally(() => {
      this.pendingReviewCleanupTasks.delete(task);
      if (this.reviewCleanupTasks.get(runId) === task) this.reviewCleanupTasks.delete(runId);
    }).catch(() => {});
    void task.then(
      () => {
        this.reviewCleanupFailures.delete(runId);
        const postTerminal = this.postTerminalTasks.get(runId);
        if (postTerminal?.status === 'failed') {
          postTerminal.status = 'completed';
          postTerminal.error = null;
        }
      },
      (error) => this.reviewCleanupFailures.set(runId, error),
    );
    return task;
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
    if (this.shuttingDown) return contract;
    if (
      contract.landingStatus === 'landed' ||
      contract.landingStatus === 'abandoning' ||
      contract.landingStatus === 'abandoned'
    ) return contract;
    if (contract.verificationStatus !== 'passed') return contract;
    // A reviewer may be admitted only against a settled producer. In
    // particular, boot review recovery can race a continuation that moved the
    // contract to a live child before this contract is visited. That child
    // owns the next verification decision; reviewing the inherited old seal
    // would burn a round and could later overwrite its failure.
    const producingRun = contract.agentRunId
      ? getAgentRunRow(contract.agentRunId as ULID)
      : null;
    if (!producingRun || !['completed', 'failed', 'cancelled'].includes(producingRun.status)) {
      return contract;
    }
    if (contract.reviewRunId) {
      const exactCheckout = getReviewCheckoutForReviewer(contract.reviewRunId as ULID);
      if (exactCheckout?.status === 'destroyed') {
        if (exactCheckout.verdictReceipt && exactCheckout.verdictAppliedAt === null) {
          await this.applyReviewVerdictEffect(exactCheckout);
          return this.contracts.get(contract.id);
        }
        if (exactCheckout.verdictAppliedAt === null) {
          console.warn(
            `[pc-sdk][dispatch] contract ${contract.id} retains destroyed review checkout ` +
            `${exactCheckout.id} without recoverable verdict evidence — successor fenced`,
          );
          return contract;
        }
        return this.contracts.get(contract.id);
      }
    }
    const currentCheckout = getCurrentReviewCheckoutForContract(contract.id as ULID);
    if (currentCheckout) {
      if (contract.reviewRunId !== currentCheckout.reviewerRunId) {
        console.warn(
          `[pc-sdk][dispatch] contract ${contract.id} has review checkout ${currentCheckout.id} ` +
          `owned by ${currentCheckout.reviewerRunId}, not marker ${contract.reviewRunId ?? '(none)'} — preserved`,
        );
        return contract;
      }
      if (this.reviewAdmissions.has(currentCheckout.reviewerRunId)) return contract;
      const reviewRun = getAgentRunRow(currentCheckout.reviewerRunId);
      if (!reviewRun || !['completed', 'failed', 'cancelled'].includes(reviewRun.status)) return contract;
      await this.ensureReviewCleanup(
        currentCheckout.reviewerRunId,
        reviewRun,
        contract.id as ULID,
      );
      return this.contracts.get(contract.id);
    }
    // Live in-flight review — nothing to do. A TERMINAL run behind the marker
    // is a crash without a verdict: fall through and re-dispatch.
    if (contract.reviewRunId) {
      const reviewRun = getAgentRunRow(contract.reviewRunId as ULID);
      if (
        this.reviewAdmissions.has(contract.reviewRunId) ||
        (reviewRun && !['completed', 'failed', 'cancelled'].includes(reviewRun.status))
      ) return contract;
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
    // Retryable admission failures deliberately park the settled producer at
    // merge-ready after releasing their exact reservation. Before reserving a
    // successor reviewer, re-enter `reviewing` through an exact, atomic
    // lifecycle/outbox edge. Without this step the successor can run against
    // valid checkout authority but its verdict is necessarily void (and the
    // verdict application CAS cannot move merge-ready as if it were reviewing).
    if (producingRun.lifecycleState !== 'reviewing') {
      if (producingRun.lifecycleState !== 'merge-ready') {
        console.warn(
          `[pc-sdk][dispatch] contract ${contract.id} cannot admit a reviewer while producer ` +
          `${producingRun.id} lifecycle is '${producingRun.lifecycleState ?? 'unset'}'`,
        );
        return contract;
      }
      const reentered = this.gateway.commitLifecycleTransition({
        runId: producingRun.id,
        expectedFrom: 'merge-ready',
        to: 'reviewing',
      });
      if (!reentered || reentered.run.lifecycleState !== 'reviewing') {
        console.warn(
          `[pc-sdk][dispatch] contract ${contract.id} lost the exact producer lifecycle race while re-entering review`,
        );
        return this.contracts.get(contract.id);
      }
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
    const recordPark = (current: Contract, why: string): Contract | null => {
      const note = `independent review not dispatchable — ${why}; parked for orchestrator review (pc_review_contract)`;
      const updated = this.contracts.setVerification({
        id: current.id,
        verificationStatus: 'passed',
        verificationNotes: current.verificationNotes ? `${current.verificationNotes}\n${note}` : note,
      });
      this.stampLifecycleWhenLegal((current.agentRunId ?? null) as ULID | null, 'merge-ready');
      return updated;
    };
    const parkUnreserved = (why: string): Contract | null => {
      // No await has occurred on this path. Refuse a stale caller snapshot
      // instead of clearing a marker/state that a newer admission now owns.
      const current = this.contracts.get(target.id);
      if (
        !current ||
        current.version !== target.version ||
        current.reviewRunId !== target.reviewRunId ||
        current.agentRunId !== target.agentRunId ||
        current.landingStatus !== null ||
        current.verificationStatus !== 'passed'
      ) return current;
      const cleared = this.contracts.setReviewState({ id: current.id, reviewRunId: null, reviewSealedCommit: null });
      return cleared ? recordPark(cleared, why) : this.contracts.get(target.id);
    };
    if (!target.worktreePath || !sealedCommit) return parkUnreserved('missing worktree or sealed commit');
    const bundle = getPodForSpawn(REVIEWER_POD_NAME, projectId);
    if (!bundle) return parkUnreserved(`no '${REVIEWER_POD_NAME}' agent available`);
    const project = getProjectById(projectId);
    if (!project?.folderPath) return parkUnreserved('project folder missing');
    const producing = target.agentRunId ? getAgentRunRow(target.agentRunId as ULID) : null;
    const repositoryIdentity = producing?.gitReceipt?.repositoryIdentity ?? null;
    if (!producing?.worktreeDir || !repositoryIdentity) {
      return parkUnreserved('producing run has no immutable repository identity receipt');
    }
    const parsedProfile = parseWorktreeProfile(project.worktreeProfile);
    if (!parsedProfile.ok) {
      return parkUnreserved(`invalid worktree profile: ${parsedProfile.errors.join('; ')}`);
    }
    let repositoryLease: RepositoryLeaseGuard;
    try {
      repositoryLease = await this.repositoryLeases.acquire(
        producing.worktreeDir,
        repositoryIdentity,
      );
    } catch (error) {
      return parkUnreserved(repositoryLeaseFailure(error).message);
    }
    const snapshot = specialistSnapshot(bundle);
    const runId = newId() as ULID;
    const ownedRoot = await requireReviewCheckoutOwnedRoot(project.folderPath, repositoryIdentity);
    if (!ownedRoot.ok) return parkUnreserved(`${ownedRoot.code}: ${ownedRoot.error}`);
    const beforeReserve = this.contracts.get(target.id);
    if (
      !beforeReserve || beforeReserve.version !== target.version ||
      beforeReserve.reviewRunId !== target.reviewRunId ||
      beforeReserve.agentRunId !== target.agentRunId ||
      beforeReserve.verificationStatus !== 'passed' ||
      beforeReserve.landingStatus !== null ||
      (beforeReserve.deliverable as { commit?: string } | null)?.commit !== sealedCommit
    ) return beforeReserve;
    const reserved = this.contracts.reserveReview({
      id: beforeReserve.id,
      expectedVersion: beforeReserve.version,
      expectedReviewRunId: beforeReserve.reviewRunId,
      expectedAgentRunId: beforeReserve.agentRunId,
      reviewRound: round,
      reviewRunId: runId,
      reviewSealedCommit: sealedCommit,
    });
    if (!reserved) return this.contracts.get(target.id);
    const authority: ReviewCheckoutAuthority = {
      id: newId() as ULID,
      projectId,
      contractId: reserved.id as ULID,
      contractVersion: reserved.version,
      producerRunId: producing.id,
      reviewerRunId: runId,
      repositoryIdentity,
      ownedRootRealPath: ownedRoot.ownedRootRealPath,
      worktreePath: join(ownedRoot.ownedRootRealPath, reviewCheckoutName(runId)),
      sealedCommit,
    };
    const workspaceReservation = createReviewCheckoutReservation({
      ...authority,
      createdAt: Date.now(),
    });
    if (!workspaceReservation) {
      const released = this.contracts.clearReviewReservation({ id: reserved.id, reviewRunId: runId });
      return released
        ? recordPark(released, 'durable review checkout authority could not be reserved')
        : this.contracts.get(target.id);
    }
    this.reviewAdmissions.add(runId);
    let settleAdmission!: () => void;
    const admissionTask = new Promise<void>((resolve) => { settleAdmission = resolve; });
    this.reviewAdmissionTasks.set(runId, admissionTask);
    this.reviewTargetsByRun.set(runId, target.id);
    const releaseAdmissionFence = (): void => {
      this.reviewAdmissions.delete(runId);
      if (this.reviewAdmissionTasks.get(runId) === admissionTask) {
        this.reviewAdmissionTasks.delete(runId);
        settleAdmission();
      }
    };
    const parkOwnedReservation = async (why: string): Promise<Contract | null> => {
      try {
        await this.settleReviewCheckoutCleanup(workspaceReservation);
      } catch (error) {
        console.warn(
          `[pc-sdk][dispatch] review admission ${runId} preserved for retryable cleanup:`,
          error instanceof Error ? error.message : error,
        );
        return this.contracts.get(target.id);
      }
      // Release only this admission after exact cleanup settlement. If an
      // override/newer reservation moved the marker, it wins untouched.
      const released = this.contracts.clearReviewReservation({ id: target.id, reviewRunId: runId });
      return released ? recordPark(released, why) : this.contracts.get(target.id);
    };
    try {
      const resolvedSelection = await this.deps.resolveNewSpecialistSelection({
        projectId,
        model: bundle.agent.model,
        effort: bundle.agent.effort,
      });
      if (resolvedSelection.status === 'invalid') {
        return await parkOwnedReservation(`runtime selection unavailable (${resolvedSelection.code})`);
      }
      if (this.ctx !== ctx || this.shuttingDown) {
        return await parkOwnedReservation('dispatch service changed while validating reviewer selection');
      }
      const selection = resolvedSelection.selection;
    // Durable workspace authority now precedes the first checkout mutation.
    const checkout = await provisionReviewCheckout({ ...authority, projectDir: project.folderPath });
    if (!checkout.ok) {
      return await parkOwnedReservation(`review checkout provisioning failed (${checkout.code}): ${checkout.error}`);
    }
    const provisionedWorkspace = setReviewCheckoutProvisionReceipt({
      authority,
      expectedUpdatedAt: workspaceReservation.updatedAt,
      receipt: checkout.receipt,
    });
    if (!provisionedWorkspace) {
      return await parkOwnedReservation('positive review checkout provision receipt could not be persisted');
    }
    const admitted = this.contracts.get(target.id);
    if (
      this.shuttingDown ||
      !admitted ||
      admitted.version !== authority.contractVersion ||
      admitted.reviewRunId !== runId ||
      admitted.reviewSealedCommit !== sealedCommit ||
      admitted.agentRunId !== target.agentRunId ||
      (admitted.deliverable as { commit?: string } | null)?.commit !== sealedCommit
    ) {
      return await parkOwnedReservation('target reservation changed while review checkout provisioning awaited');
    }
    const now = Date.now();
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
      worktreeDir: authority.worktreePath,
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
          dispatcherSessionId: producing?.dispatcherSessionId ?? 'full-review',
          specialistSnapshot: snapshot,
          selection,
          continuation: { mode: 'create' },
          status: 'queued',
          input: brief,
          pmRef: target.pmRef ?? null,
          parentInvokeDepth: (producing?.parentInvokeDepth ?? 0) + 1,
          contractId: reviewContract.id as ULID,
          // The reviewer runs in its own detached checkout of the sealed
          // commit — never the builder's live worktree. Payload-kind
          // contract ⇒ no lifecycle vocabulary.
          worktreeDir: authority.worktreePath,
          worktreeBaseBranch: '(detached)',
          worktreeBaseSha: sealedCommit,
          gitReceipt: this.reviewGitReceipt(authority, checkout.receipt),
          queuedAt: now,
        }),
    });
    const linkedReviewContract = this.contracts.setRun(reviewContract.id, runId);
    if (!linkedReviewContract) {
      this.gateway.commitTerminal({
        runId,
        status: 'failed',
        result: null,
        failureCause: 'worktree-provision-failed',
        failureReason: 'review producer/contract ownership binding was not positively committed',
        completedAt: Date.now(),
      });
      // The shared cleanup owner waits for admission quiescence. This failure
      // is still inside the admission try/finally, so release its exact fence
      // first; otherwise cleanup awaits this promise while this path awaits
      // cleanup and neither can reach the outer finally.
      releaseAdmissionFence();
      try {
        await this.ensureReviewCleanup(runId, getAgentRunRow(runId), target.id as ULID);
      } catch (error) {
        console.warn(`[pc-sdk][dispatch] failed review binding cleanup is pending for ${runId}:`, error);
      }
      return this.contracts.get(target.id);
    }
    const startTask = this.prepareReviewAndStart({
      row: publication.run as unknown as { runId: string },
      runId,
      projectId,
      snapshot,
      contract: linkedReviewContract,
      spec,
      selection,
      worktree: {
        dir: authority.worktreePath,
        branch: '(detached)',
        baseBranch: '(detached)',
        baseSha: sealedCommit,
      },
      firstMessage: brief,
      resumeNativeSessionId: null,
      repositoryLease,
    }, authority.id, parsedProfile.profile);
    this.trackRunTask(runId, startTask);
    void startTask.catch(() => {
      console.error(`[pc-sdk][dispatch] review runtime start crashed for ${runId}: ${RUNTIME_START_FAILURE_REASON}`);
      this.settleTerminal(runId, {
        status: 'failed',
        result: null,
        failureCause: 'spawn-error',
        failureReason: RUNTIME_START_FAILURE_REASON,
      });
    });
    return this.contracts.get(target.id);
    } finally {
      releaseAdmissionFence();
      if (!getAgentRunRow(runId) && this.reviewTargetsByRun.get(runId) === target.id) {
        this.reviewTargetsByRun.delete(runId);
      }
    }
  }

  /** Pre-attach recovery door. Every old-process review workspace is adopted
   * only from complete exact inspection and then retired through the same
   * positive teardown owner before pending review re-entry may mint a
   * successor. Missing-before-add and removed-before-settlement are ordinary
   * idempotent teardown cases; drift remains cleanup-pending and blocks. */
  async recoverReviewWorkspaces(): Promise<void> {
    const executable = listReviewCheckoutsNeedingRecovery();
    const seen = new Set(executable.map((checkout) => checkout.id));
    const destroyedAdmissions = listReviewCheckoutBlockingCandidates().filter((checkout) => {
      if (seen.has(checkout.id) || checkout.status !== 'destroyed' || checkout.verdictReceipt !== null ||
          getAgentRunRow(checkout.reviewerRunId) !== null) return false;
      const target = this.contracts.get(checkout.contractId);
      return target?.reviewRunId === checkout.reviewerRunId;
    });
    for (const observed of [...executable, ...destroyedAdmissions]) {
      try {
        let checkout = getReviewCheckoutById(observed.id) ?? observed;
        const project = getProjectById(checkout.projectId);
        if (checkout.status === 'reserved' && project?.folderPath) {
          const inspected = await inspectReviewCheckout(
            this.reviewCheckoutMechanicsAuthority(checkout, project.folderPath),
          );
          if (inspected.ok) {
            checkout = setReviewCheckoutProvisionReceipt({
              authority: this.reviewCheckoutAuthority(checkout),
              expectedUpdatedAt: checkout.updatedAt,
              receipt: inspected.receipt,
            }) ?? getReviewCheckoutById(checkout.id) ?? checkout;
          }
        }
        const run = getAgentRunRow(checkout.reviewerRunId);
        if (run && !['completed', 'failed', 'cancelled'].includes(run.status)) {
          console.warn(
            `[pc-sdk][boot-recovery] review checkout ${checkout.id} retained because reviewer ` +
            `${run.id} is still '${run.status}' after the process recovery sweep`,
          );
          continue;
        }
        if (run) {
          await this.ensureReviewCleanup(
            checkout.reviewerRunId,
            run,
            checkout.contractId,
          );
        } else {
          await this.settleReviewCheckoutCleanup(checkout);
          const target = this.contracts.get(checkout.contractId);
          if (target?.reviewRunId === checkout.reviewerRunId) {
            this.contracts.clearReviewReservation({
              id: target.id,
              reviewRunId: checkout.reviewerRunId,
            });
          }
        }
      } catch (error) {
        console.warn(
          `[pc-sdk][boot-recovery] review checkout ${observed.id} recovery remains pending:`,
          error instanceof Error ? error.message : error,
        );
      }
    }

    // Crash window after the contract reservation but before workspace insert.
    // No Git mutation was authorized yet, so an absent run + absent workspace
    // can release only that exact marker. Any run without workspace authority
    // is malformed/unavailable and remains fenced.
    const { listContractsAwaitingIndependentReview } = await import('@pc/db');
    for (const target of listContractsAwaitingIndependentReview()) {
      const reviewerRunId = target.reviewRunId as ULID | null;
      if (!reviewerRunId || this.reviewAdmissions.has(reviewerRunId)) continue;
      if (getReviewCheckoutForReviewer(reviewerRunId) || getAgentRunRow(reviewerRunId)) continue;
      this.contracts.clearReviewReservation({ id: target.id as ULID, reviewRunId: reviewerRunId });
    }
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

  /** Boot entry (index.ts, AFTER attach — reviving a live session needs the
   *  live server context for its tool wiring). F1 (comms-hardening): pause/
   *  resume is in-process — the live SDK session lives only in `this.live`,
   *  which does not survive a restart. The boot sweep (boot-recovery.ts) now
   *  SKIPS failing 'paused' runs and leaves their open ask exactly as it was;
   *  this door re-attaches a live session per the row's trusted persisted
   *  native identity so `answerPendingAsk` resumes it instead of
   *  410ing on a handle that died with the old process. Best-effort per row:
   *  a row whose pod/contract/project can no longer be resolved stays paused
   *  with its ask open (degrade, never block) — `answerPendingAsk`'s own
   *  lazy-revival fallback gets a second try, and a manual
   *  `pc_continue_agent` remains the last resort. */
  async recoverPausedAsks(): Promise<void> {
    const { listNonTerminalAgentRuns } = await import('@pc/db');
    for (const run of listNonTerminalAgentRuns()) {
      if (run.status !== 'paused' || this.live.has(run.id)) continue;
      try {
        const liveRun = await this.ensureRevivedLiveSession(run);
        if (!liveRun) {
          const current = getAgentRunRow(run.id);
          if (!current || current.status !== 'paused') continue;
          console.warn(
            `[pc-sdk][boot-recovery] paused run ${run.id} (${run.podName}) could not be revived — ask left open for a manual continue.`,
          );
          continue;
        }
        console.warn(`[pc-sdk][boot-recovery] paused run ${run.id} (${run.podName}) revived — pending ask resumable.`);
      } catch (err) {
        console.error(`[pc-sdk][boot-recovery] paused-ask revival failed for run ${run.id} — continuing with the rest:`, err);
      }
    }
  }

  // ── browser-approved worktree abandonment (DL-002) ────────────────────────

  async previewContractAbandonment(input: {
    projectId: ULID;
    contractId: ULID;
  }): Promise<WorktreeAbandonmentPreviewResult> {
    if (!this.ctx || this.shuttingDown) {
      return { ok: false, message: 'dispatch service not ready', httpStatus: 503 };
    }
    const initial = this.contracts.get(input.contractId);
    if (!initial || initial.projectId !== input.projectId) {
      return { ok: false, message: 'contract not found', httpStatus: 404 };
    }
    const authority = this.abandonmentQueueAuthority(initial);
    if (!authority) {
      return { ok: false, message: 'repository authority is unavailable', httpStatus: 503 };
    }
    try {
      return await this.enqueueRepositoryMutation(
        authority.projectDir,
        authority.repositoryIdentity,
        () => this.inspectContractAbandonmentLocked(
          input.projectId,
          input.contractId,
          authority.repositoryIdentity,
        ),
      );
    } catch (error) {
      const failure = repositoryLeaseFailure(error);
      return { ok: false, message: failure.message, httpStatus: failure.httpStatus };
    }
  }

  async approveContractAbandonment(input: {
    projectId: ULID;
    contractId: ULID;
    request: ApproveWorktreeAbandonmentRequest;
  }): Promise<WorktreeAbandonmentApprovalResult> {
    if (!this.ctx || this.shuttingDown) {
      return { ok: false, message: 'dispatch service not ready', httpStatus: 503 };
    }
    const initial = this.contracts.get(input.contractId);
    if (!initial || initial.projectId !== input.projectId) {
      return { ok: false, message: 'contract not found', httpStatus: 404 };
    }
    const authority = this.abandonmentQueueAuthority(initial);
    if (!authority) {
      return { ok: false, message: 'repository authority is unavailable', httpStatus: 503 };
    }
    try {
      return await this.enqueueRepositoryMutation(
        authority.projectDir,
        authority.repositoryIdentity,
        async () => {
          let current = this.contracts.get(input.contractId);
          if (!current || current.projectId !== input.projectId) {
            return { ok: false, message: 'contract not found', httpStatus: 404 } as const;
          }

          if (current.abandonmentReceipt) {
            if (current.abandonmentReceipt.requestId !== input.request.requestId) {
              return {
                ok: false,
                message: 'a different abandonment approval already owns this contract',
                httpStatus: 409,
              } as const;
            }
            if (
              current.abandonmentReceipt.approvedContractVersion !== input.request.expectedContractVersion ||
              current.abandonmentReceipt.previewDigest !== input.request.previewDigest ||
              current.abandonmentReceipt.branch !== input.request.confirmation ||
              current.abandonmentReceipt.reason !== (input.request.reason ?? null)
            ) {
              return {
                ok: false,
                message: 'request does not match the durable abandonment approval',
                httpStatus: 409,
              } as const;
            }
            return this.driveApprovedAbandonmentLocked(current);
          }

          const inspected = await this.inspectContractAbandonmentLocked(
            input.projectId,
            input.contractId,
            authority.repositoryIdentity,
          );
          if (!inspected.ok) return inspected;
          const preview = inspected.preview;
          if (
            preview.contractVersion !== input.request.expectedContractVersion ||
            preview.previewDigest !== input.request.previewDigest
          ) {
            return {
              ok: false,
              message: 'abandonment preview is stale — reload current worktree evidence',
              httpStatus: 409,
            } as const;
          }
          if (preview.branch !== input.request.confirmation) {
            return {
              ok: false,
              message: 'confirmation must exactly match the current branch name',
              httpStatus: 409,
            } as const;
          }
          if (preview.worktreeState.directory !== 'present') {
            return {
              ok: false,
              message: 'fresh abandonment approval requires a present registered worktree',
              httpStatus: 409,
            } as const;
          }

          const receipt: WorktreeAbandonmentReceipt = {
            protocol: 'worktree-abandonment-v1',
            requestId: input.request.requestId,
            approvedBy: 'user',
            approvalSurface: 'browser',
            approvalReason: 'explicit-browser-confirmation',
            approvedAt: Date.now(),
            reason: input.request.reason ?? null,
            approvedContractVersion: preview.contractVersion,
            projectId: preview.projectId,
            contractId: preview.contractId,
            producerRunId: preview.producerRunId,
            worktreeId: preview.worktreeId,
            worktreeStatus: preview.worktreeStatus,
            repositoryIdentity: preview.repositoryIdentity,
            worktreePath: preview.worktreePath,
            branch: preview.branch,
            branchTip: preview.branchTip,
            baseBranch: preview.baseBranch,
            validatedBaseSha: preview.validatedBaseSha,
            targetTip: preview.targetTip,
            integrationState: preview.integrationState,
            worktreeState: preview.worktreeState,
            previewDigest: preview.previewDigest,
          };
          if (!isWorktreeAbandonmentReceipt(receipt)) {
            return { ok: false, message: 'server-derived abandonment receipt is invalid', httpStatus: 409 } as const;
          }
          const reserved = this.contracts.authorizeAbandonment({
            id: current.id,
            receipt,
          });
          if (!reserved) {
            current = this.contracts.get(current.id);
            if (
              current?.abandonmentReceipt?.requestId === receipt.requestId &&
              current.landingStatus === 'abandoning'
            ) return this.driveApprovedAbandonmentLocked(current);
            return {
              ok: false,
              message: 'contract changed before abandonment approval could reserve it',
              httpStatus: 409,
            } as const;
          }
          return this.driveApprovedAbandonmentLocked(reserved);
        },
      );
    } catch (error) {
      const latest = this.contracts.get(input.contractId);
      if (latest?.abandonmentReceipt?.requestId === input.request.requestId) {
        return { ok: true, settlement: 'pending', contract: latest };
      }
      const failure = repositoryLeaseFailure(error);
      return { ok: false, message: failure.message, httpStatus: failure.httpStatus };
    }
  }

  private abandonmentQueueAuthority(contract: Contract): {
    projectDir: string;
    repositoryIdentity: RepositoryIdentityReceipt;
  } | null {
    const project = getProjectById(contract.projectId as ULID);
    const producer = contract.agentRunId
      ? getAgentRunRow(contract.agentRunId as ULID)
      : null;
    const repositoryIdentity = contract.abandonmentReceipt?.repositoryIdentity ??
      producer?.gitReceipt?.repositoryIdentity ??
      null;
    if (!project?.folderPath || !repositoryIdentity) return null;
    return { projectDir: project.folderPath, repositoryIdentity };
  }

  private async inspectContractAbandonmentLocked(
    projectId: ULID,
    contractId: ULID,
    queuedIdentity: RepositoryIdentityReceipt,
  ): Promise<WorktreeAbandonmentPreviewResult> {
    const contract = this.contracts.get(contractId);
    if (!contract || contract.projectId !== projectId) {
      return { ok: false, message: 'contract not found', httpStatus: 404 };
    }
    if (contract.expectedOutput?.kind !== 'repo' || !contract.agentRunId) {
      return { ok: false, message: 'only repository contracts can be abandoned', httpStatus: 409 };
    }
    const legacyAbandoned = contract.landingStatus === 'abandoned' &&
      contract.abandonmentReceipt === null &&
      contract.abandonmentTeardownReceipt === null;
    if (
      contract.landingStatus !== null &&
      contract.landingStatus !== 'conflict' &&
      contract.landingStatus !== 'failed' &&
      contract.landingStatus !== 'stale-base' &&
      !legacyAbandoned
    ) {
      return {
        ok: false,
        message: `contract landing is '${contract.landingStatus}' and cannot enter fresh abandonment`,
        httpStatus: 409,
      };
    }
    if (contract.reviewRunId !== null) {
      return { ok: false, message: 'independent review is still reserved', httpStatus: 409 };
    }
    const producer = getAgentRunRow(contract.agentRunId as ULID);
    if (!producer || !['completed', 'failed', 'cancelled'].includes(producer.status)) {
      return { ok: false, message: 'contract producer is still active or unavailable', httpStatus: 409 };
    }
    const activeRun = listAgentRunsForContract(contractId).find(
      (run) => !['completed', 'failed', 'cancelled'].includes(run.status),
    );
    if (activeRun) {
      return { ok: false, message: `run ${activeRun.id} is still active for this contract`, httpStatus: 409 };
    }
    const quiescenceIssue = this.contractRuntimeQuiescenceIssue(contractId);
    if (quiescenceIssue) return { ok: false, message: quiescenceIssue, httpStatus: 409 };
    const repositoryIdentity = producer.gitReceipt?.repositoryIdentity ?? null;
    if (
      !repositoryIdentity ||
      repositoryIdentity.protocol !== queuedIdentity.protocol ||
      repositoryIdentity.gitCommonDir !== queuedIdentity.gitCommonDir ||
      repositoryIdentity.leaseKey !== queuedIdentity.leaseKey
    ) {
      return { ok: false, message: 'repository identity changed while abandonment awaited', httpStatus: 409 };
    }
    const project = getProjectById(projectId);
    const worktree = getWorktreeForContract(contractId);
    const validatedBaseSha = contract.verifiedBaseSha ?? contract.worktreeBaseSha;
    if (
      !project?.folderPath ||
      !worktree ||
      !contract.worktreeBaseBranch ||
      !contract.worktreeBaseSha ||
      !validatedBaseSha
    ) {
      return { ok: false, message: 'exact project/worktree/base evidence is unavailable', httpStatus: 409 };
    }
    const inspected = await inspectWorktreeAbandonment({
      projectDir: project.folderPath,
      projectId,
      contractId,
      contractVersion: contract.version,
      producerRunId: contract.agentRunId as ULID,
      worktree,
      expectedBaseBranch: contract.worktreeBaseBranch,
      provisionedBaseSha: contract.worktreeBaseSha,
      validatedBaseSha,
      repositoryIdentity,
    });
    if (!inspected.ok) {
      return {
        ok: false,
        message: inspected.error,
        httpStatus: inspected.code === 'repository-unavailable' ? 503 : 409,
      };
    }
    return { ok: true, preview: inspected.preview };
  }

  private async driveApprovedAbandonmentLocked(
    input: Contract,
  ): Promise<WorktreeAbandonmentApprovalResult> {
    let contract = this.contracts.get(input.id) ?? input;
    const authority = contract.abandonmentReceipt;
    if (
      contract.landingStatus === 'abandoned' &&
      authority &&
      contract.abandonmentTeardownReceipt
    ) return { ok: true, settlement: 'completed', contract };
    if (
      contract.landingStatus !== 'abandoning' ||
      !authority ||
      !isWorktreeAbandonmentReceipt(authority)
    ) {
      return { ok: false, message: 'durable abandonment authority is unavailable', httpStatus: 409 };
    }
    const quiescenceIssue = this.contractRuntimeQuiescenceIssue(contract.id);
    if (quiescenceIssue) {
      contract = this.recordAbandonmentError(contract, authority.requestId, quiescenceIssue);
      return { ok: true, settlement: 'pending', contract };
    }
    const project = getProjectById(contract.projectId as ULID);
    if (!project?.folderPath) {
      contract = this.recordAbandonmentError(contract, authority.requestId, 'project folder unavailable');
      return { ok: true, settlement: 'pending', contract };
    }
    const tornDown = await settleAbandonedWorktree({
      projectDir: project.folderPath,
      authority,
    });
    if (!tornDown.ok) {
      contract = this.recordAbandonmentError(contract, authority.requestId, tornDown.error);
      return { ok: true, settlement: 'pending', contract };
    }

    contract = this.contracts.get(contract.id) ?? contract;
    const settled = this.contracts.settleAbandonment({
      id: contract.id,
      expectedVersion: contract.version,
      receipt: tornDown.receipt,
    });
    if (!settled) {
      const latest = this.contracts.get(contract.id);
      if (
        latest?.landingStatus === 'abandoned' &&
        latest.abandonmentReceipt?.requestId === authority.requestId &&
        latest.abandonmentTeardownReceipt
      ) return { ok: true, settlement: 'completed', contract: latest };
      contract = latest ?? contract;
      contract = this.recordAbandonmentError(
        contract,
        authority.requestId,
        'abandonment settlement CAS became stale',
      );
      return { ok: true, settlement: 'pending', contract };
    }
    return { ok: true, settlement: 'completed', contract: settled };
  }

  private recordAbandonmentError(
    contract: Contract,
    authorityRequestId: string,
    error: string,
  ): Contract {
    const bounded = error.length > 2000 ? `${error.slice(0, 1999)}…` : error;
    if (contract.abandonmentError === bounded) return contract;
    return this.contracts.setAbandonmentError({
      id: contract.id,
      expectedVersion: contract.version,
      authorityRequestId,
      error: bounded,
    }) ?? this.contracts.get(contract.id) ?? contract;
  }

  /** Boot re-drive of durable authority. Runs before stranded/orphan
   * reconciliation and does not depend on an active worktree row. */
  async recoverApprovedAbandonments(): Promise<void> {
    for (const row of listContractsNeedingAbandonmentRecovery()) {
      const contract = this.contracts.get(row.id);
      if (!contract?.abandonmentReceipt) continue;
      const authority = this.abandonmentQueueAuthority(contract);
      if (!authority) {
        this.recordAbandonmentError(
          contract,
          contract.abandonmentReceipt.requestId,
          'repository authority unavailable during abandonment recovery',
        );
        continue;
      }
      try {
        await this.enqueueRepositoryMutation(
          authority.projectDir,
          authority.repositoryIdentity,
          () => this.driveApprovedAbandonmentLocked(contract),
        );
      } catch (error) {
        const latest = this.contracts.get(contract.id) ?? contract;
        this.recordAbandonmentError(
          latest,
          contract.abandonmentReceipt.requestId,
          error instanceof Error ? error.message : 'abandonment recovery failed',
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
    const latest = this.contracts.get(contract.id);
    if (!latest) return null;
    if (
      latest.landingStatus === 'landed' ||
      latest.landingStatus === 'abandoning' ||
      latest.landingStatus === 'abandoned'
    ) {
      return latest;
    }
    const reviewCheckout = getCurrentReviewCheckoutForContract(latest.id as ULID);
    if (reviewCheckout) {
      throw new Error(
        `contract ${latest.id} review checkout ${reviewCheckout.id} is '${reviewCheckout.status}' — positive review cleanup is required before landing`,
      );
    }
    const project = getProjectById(contract.projectId as ULID);
    const producer = contract.agentRunId
      ? getAgentRunRow(contract.agentRunId as ULID)
      : null;
    const repositoryIdentity = producer?.gitReceipt?.repositoryIdentity ?? null;
    const authorityPath = project?.folderPath ?? producer?.worktreeDir ?? null;
    if (!repositoryIdentity || !authorityPath) {
      throw new RepositoryLeaseError(
        'repository-unavailable',
        authorityPath ?? '<missing-repository>',
        repositoryIdentity,
        null,
        'MISSING_REPOSITORY_IDENTITY_RECEIPT',
      );
    }
    return this.enqueueRepositoryMutation(
      authorityPath,
      repositoryIdentity,
      () => this.landAcceptedContractLocked(contract, authorizer, repositoryIdentity),
    );
  }

  /** One same-engine FIFO for every repository landing/abandonment mutation.
   * The engine-lifetime lease supplies the canonical physical-repository key;
   * each queued callback re-resolves mutable state under that authority. */
  private async enqueueRepositoryMutation<T>(
    authorityPath: string,
    repositoryIdentity: RepositoryIdentityReceipt,
    mutation: () => Promise<T>,
  ): Promise<T> {
    const repositoryLease = await this.repositoryLeases.acquire(
      authorityPath,
      repositoryIdentity,
    );
    const key = repositoryLease.identity.leaseKey;
    const prior = this.landingLocks.get(key) ?? Promise.resolve();
    const turn = prior.then(mutation, mutation);
    this.landingLocks.set(key, turn.catch(() => {}));
    return turn;
  }

  private async landAcceptedContractLocked(
    authorized: Contract,
    authorizer: ContractLandingAuthorizer,
    repositoryIdentity: RepositoryIdentityReceipt,
  ): Promise<Contract | null> {
    const authorityProject = getProjectById(authorized.projectId as ULID);
    if (!authorityProject?.folderPath) {
      throw new RepositoryLeaseError(
        'repository-unavailable',
        '<missing-repository>',
        repositoryIdentity,
        null,
        'MISSING_PROJECT_FOLDER',
      );
    }
    // The local FIFO may have waited behind another landing. Re-resolve the
    // mutable project path under the engine-lifetime guard before any status
    // reservation or Git evidence is read.
    const projectLease = await this.repositoryLeases.acquire(
      authorityProject.folderPath,
      repositoryIdentity,
    );
    const authorizedProjectDir = await requireRepositoryWorktreeRoot(
      await this.repositoryLeases.resolveHeldRuntimeCwd(
        projectLease,
        authorityProject.folderPath,
        repositoryIdentity,
      ),
    );
    // Re-read under the lock: the pre-lock snapshot may be stale (auto-land
    // racing review-accept, boot re-drive racing accept). A landed receipt is
    // final — a second drive must never overwrite its authorizer/landedAt.
    const current = this.contracts.get(authorized.id);
    if (!current) return null;
    if (current.landingStatus === 'landed') return current;
    if (current.landingStatus === 'abandoning') return current;
    if (current.landingStatus === 'abandoned') return current;
    const reviewCheckout = getCurrentReviewCheckoutForContract(current.id as ULID);
    if (reviewCheckout) {
      throw new Error(
        `contract ${current.id} review checkout ${reviewCheckout.id} is '${reviewCheckout.status}' — positive review cleanup is required before landing`,
      );
    }

    // The caller's accepted contract is the authorization receipt. Re-check
    // its exact version/producer/seal under the repository lock: a continuation
    // can finish preflight while verification/review is awaiting and move the
    // contract to a different producer before this callback runs.
    const authorizedSeal = (authorized.deliverable as { commit?: string } | null)?.commit ?? null;
    const currentSeal = (current.deliverable as { commit?: string } | null)?.commit ?? null;
    const producer = current.agentRunId ? getAgentRunRow(current.agentRunId as ULID) : null;
    const producerTerminal =
      producer !== null && ['completed', 'failed', 'cancelled'].includes(producer.status);
    if (
      current.version !== authorized.version ||
      current.agentRunId !== authorized.agentRunId ||
      current.verificationStatus !== 'passed' ||
      currentSeal !== authorizedSeal ||
      !producerTerminal
    ) {
      console.warn(
        `[pc-sdk][dispatch] landing authorization for contract ${authorized.id} became stale ` +
          `(authorized v${authorized.version}/${authorized.agentRunId ?? 'no-producer'}, ` +
          `current v${current.version}/${current.agentRunId ?? 'no-producer'}/${producer?.status ?? 'missing'}) — refused`,
      );
      return current;
    }

    // Reserve ownership before the first Git await. Continuation admission
    // rejects `pending`, so no new runtime can mutate or lose this worktree
    // while merge/teardown is in flight. A boot re-drive already owns pending.
    let contract = current;
    if (contract.landingStatus !== 'pending') {
      const reserved = this.contracts.reserveLanding({
        id: contract.id,
        expectedVersion: contract.version,
        expectedAgentRunId: contract.agentRunId as ULID,
        landingAuthorizer: authorizer,
      });
      if (!reserved) return this.contracts.get(contract.id);
      contract = reserved;
    }
    // Lifecycle stamps ride the producing run (null for legacy contracts).
    const lifecycleRunId = (contract.agentRunId ?? null) as ULID | null;
    const stamp = (to: RunLifecycleState) => {
      if (lifecycleRunId) this.stampLifecycle(lifecycleRunId, to);
    };
    const project = getProjectById(contract.projectId as ULID);
    if (!project?.folderPath || !contract.worktreePath || !contract.worktreeBaseBranch) {
      stamp('failed');
      return this.contracts.settleLanding({
        id: contract.id,
        expectedVersion: contract.version,
        expectedAgentRunId: contract.agentRunId as ULID,
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
      return this.contracts.settleLanding({
        id: contract.id,
        expectedVersion: contract.version,
        expectedAgentRunId: contract.agentRunId as ULID,
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
      const tip = await git(['rev-parse', '--verify', '--quiet', `refs/heads/${branch}`], authorizedProjectDir);
      if (tip.ok && tip.stdout !== sealedCommit) {
        stamp('failed');
        return this.contracts.settleLanding({
          id: contract.id,
          expectedVersion: contract.version,
          expectedAgentRunId: contract.agentRunId as ULID,
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
    const probe = await probeAlreadyLanded(authorizedProjectDir, branch, contract.worktreeBaseBranch, validatedBase);
    if (probe.landed) {
      const updated = this.contracts.settleLanding({
        id: contract.id,
        expectedVersion: contract.version,
        expectedAgentRunId: contract.agentRunId as ULID,
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
      if (!updated) {
        console.warn(
          `[pc-sdk][dispatch] landing convergence receipt for contract ${contract.id} lost its exact CAS — preserving worktree and branch`,
        );
        return this.contracts.get(contract.id);
      }
      // Probe convergence: positive ancestry proof, no new mutation — the
      // lifecycle jumps straight to merged, then teardown completes it.
      stamp('merged');
      stamp('tearing-down');
      // Failed reclaim = stranded isolation, never a false 'completed' receipt.
      const toreDown = await this.settleLandedCleanup(
        updated,
        project,
        repositoryIdentity,
      );
      // `completed` is the terminal-pipeline barrier: no branch delete or
      // orphan-prune work remains in flight once observers see it.
      stamp(toreDown ? 'completed' : 'stranded');
      // Landed + reclaimed ⇒ resolve earlier preserved parks of this contract.
      if (toreDown) this.resolvePreservedRuns(contract.id as ULID);
      return updated;
    }
    // Guard 7 — stale verification never silently lands: the target must still
    // sit at the base the verification covered. No auto-rebase; the recovery
    // door is pc_review_contract accept, which revalidates against the
    // current tip (stamps verifiedBaseSha) and re-lands.
    const targetHead = await git(['rev-parse', `refs/heads/${contract.worktreeBaseBranch}`], authorizedProjectDir);
    if (!targetHead.ok) {
      stamp('failed');
      return this.contracts.settleLanding({
        id: contract.id,
        expectedVersion: contract.version,
        expectedAgentRunId: contract.agentRunId as ULID,
        landingStatus: 'failed',
        landingError: `cannot resolve target branch tip '${contract.worktreeBaseBranch}': ${targetHead.stderr}`,
      });
    }
    if (!validatedBase || targetHead.stdout !== validatedBase) {
      // Stale base is the lifecycle's 'conflict' gate: preserved worktree,
      // recovery via re-accept (revalidate) — never a silent land.
      stamp('conflict');
      return this.contracts.settleLanding({
        id: contract.id,
        expectedVersion: contract.version,
        expectedAgentRunId: contract.agentRunId as ULID,
        landingStatus: 'stale-base',
        landingError: validatedBase
          ? `target '${contract.worktreeBaseBranch}' advanced to ${targetHead.stdout.slice(0, 12)} past the verified base ${validatedBase.slice(0, 12)} — review the diff and re-land via pc_review_contract accept, which revalidates against the current tip (no auto-rebase)`
          : `no verified base recorded for '${contract.worktreeBaseBranch}' — re-land via pc_review_contract accept, which revalidates against the current tip`,
      });
    }
    stamp('merging');
    const landed = await landBranch({
      projectDir: authorizedProjectDir,
      branch,
      baseBranch: contract.worktreeBaseBranch,
      podName: contract.podName ?? 'agent',
      expectedHeadSha: targetHead.stdout,
      repositoryIdentity,
    });
    if (landed.outcome === 'landed') {
      // Durable full merge receipt BEFORE teardown. landedSha stays the
      // BRANCH TIP; the merge commit rides the new receipt columns.
      const updated = this.contracts.settleLanding({
        id: contract.id,
        expectedVersion: contract.version,
        expectedAgentRunId: contract.agentRunId as ULID,
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
      if (!updated) {
        console.warn(
          `[pc-sdk][dispatch] landing receipt for contract ${contract.id} lost its exact CAS — preserving worktree and branch`,
        );
        return this.contracts.get(contract.id);
      }
      stamp('merged');
      stamp('tearing-down');
      // Failed reclaim = stranded isolation, never a false 'completed' receipt.
      const toreDown = await this.settleLandedCleanup(
        updated,
        project,
        repositoryIdentity,
      );
      stamp(toreDown ? 'completed' : 'stranded');
      // Landed + reclaimed ⇒ resolve earlier preserved parks of this contract.
      if (toreDown) this.resolvePreservedRuns(contract.id as ULID);
      return updated;
    }
    // conflict + stale-base both land on the lifecycle 'conflict' gate;
    // a mechanical failure is 'failed'. Branch + worktree preserved either way.
    stamp(landed.outcome === 'failed' ? 'failed' : 'conflict');
    return this.contracts.settleLanding({
      id: contract.id,
      expectedVersion: contract.version,
      expectedAgentRunId: contract.agentRunId as ULID,
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

  /** One positive cleanup path for fresh landings and every boot re-drive.
   * Contract merge evidence never substitutes for the exact worktree,
   * registration, branch-ref, or row proofs owned by the workspace service. */
  private async settleLandedCleanup(
    contract: Contract,
    project: Project,
    repositoryIdentity: RepositoryIdentityReceipt,
  ): Promise<boolean> {
    const configuredIdentity = project.repositoryIdentity;
    const worktree = getWorktreeForLandedContract(contract.id as ULID);
    const producerRunId = (contract.agentRunId ?? null) as ULID | null;
    const branch = contract.landedBranch;
    const branchTip = contract.landedSha;
    if (
      !worktree ||
      !producerRunId ||
      !branch ||
      !branchTip ||
      !project.folderPath ||
      !configuredIdentity ||
      configuredIdentity.protocol !== repositoryIdentity.protocol ||
      configuredIdentity.gitCommonDir !== repositoryIdentity.gitCommonDir ||
      configuredIdentity.leaseKey !== repositoryIdentity.leaseKey ||
      contract.worktreePath !== worktree.path ||
      contract.worktreeBaseBranch !== worktree.baseBranch ||
      contract.worktreeBaseSha !== worktree.baseSha
    ) {
      console.warn(
        `[pc-sdk][worktree] landed cleanup for contract ${contract.id} deferred: exact durable binding is unavailable`,
      );
      return false;
    }
    const settled = await settleLandedWorktree({
      projectDir: project.folderPath,
      projectId: contract.projectId as ULID,
      contractId: contract.id as ULID,
      producerRunId,
      worktree,
      branch,
      branchTip,
      cleanupCommands: this.cleanupCommandsFor(project),
      repositoryIdentity,
    });
    if (!settled.ok) {
      console.warn(
        `[pc-sdk][worktree] landed cleanup for contract ${contract.id} remains retryable (${settled.code}): ${settled.error}`,
      );
      return false;
    }
    await this.sweepOrphansFor(project, repositoryIdentity);
    return true;
  }

  /** Best-effort orphan GC after a land completes teardown — a locked
   *  directory from THIS teardown, or an earlier one, gets a second chance
   *  right away instead of waiting for the next boot sweep. The merge receipt
   *  is already durable; this bounded settle completes before lifecycle
   *  `completed` becomes observable. */
  private async sweepOrphansFor(
    project: Project | null,
    repositoryIdentity: RepositoryIdentityReceipt,
  ): Promise<void> {
    if (!project?.folderPath) return;
    try {
      await sweepOrphanedWorktreeDirs(project.folderPath, repositoryIdentity);
    } catch (err) {
      console.error(`[pc-sdk][worktree] orphan sweep failed for project ${project.id}:`, err);
    }
  }

  /** Executed-tool evidence for `tool_called` predicates — read from the durable
   *  transcript (one path; live-handle state is a projection). Bridge-qualified
   *  names (`mcp__pc__pc_x`) are stripped to bare names. */
  private evidenceToolCalls(runId: ULID): Array<{ name: string }> {
    try {
      return executedToolCallsFromEvents(
        listConversationEvents(runId).map((row) => row.payload as ChatEvent),
      );
    } catch {
      return [];
    }
  }

  private deliverToOrchestrator(projectId: ULID, envelope: AgentEnvelope, clientMessageId: string): void {
    if (!this.ctx) {
      // F3 (comms-hardening): pre-attach (boot recovery runs before
      // dispatch.attach) — queue for replay instead of silently dropping the
      // envelope. Replay still goes through injectAgentEnvelope below (Part
      // A's typed per-run chat card), never a plain-text fallback.
      this.pendingEnvelopes.push({ projectId, envelope, clientMessageId });
      return;
    }
    try {
      void this.ctx.registry.get(projectId).injectAgentEnvelope({
        runId: envelope.runId,
        agentName: envelope.agentName,
        pendingAskId: envelope.pendingAskId,
        status: envelope.status,
        summary: envelope.summary,
        detail: envelope.text,
        envelope: envelope.text,
        clientMessageId,
      }).catch((err) => {
        console.error(`[pc-sdk][dispatch] envelope delivery failed for ${projectId}:`, err);
      });
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
   *  Pre-attach, the terminal envelope has nowhere live to land (ctx null) —
   *  F3 (comms-hardening): `deliverToOrchestrator` queues it instead of
   *  dropping it, and `attach()` replays the queue once the context is live,
   *  so the orchestrator still sees it (in addition to the durable
   *  contract/receipt state). */
  async recoverSealedRuns(): Promise<void> {
    const {
      closeOpenConversationToolCalls,
      listNonTerminalAgentRuns,
      listOpenPendingAsksForProject,
      markPendingAskCancelled,
    } = await import('@pc/db');
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
        closeOpenConversationToolCalls({
          conversationId: run.id,
          reason: 'runtime-lost',
          deliveryKind: 'agent',
        });
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
        await this.trackPostTerminalTask(
          run.id,
          () => this.verifyAndLand(run.id, 'completed'),
        );
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
        if (
          contract.landingStatus === 'landed' ||
          contract.landingStatus === 'abandoning' ||
          contract.landingStatus === 'abandoned'
        ) continue;
        const runId = contract.agentRunId;
        if (!runId) continue;
        const run = getAgentRunRow(runId);
        if (!run || run.deliveredAt === null) continue;
        if (run.status !== 'completed' && run.status !== 'failed') continue;
        console.warn(
          `[pc-sdk][boot-recovery] contract ${contract.id} holds a sealed deliverable with no verification outcome (crash between settlement and verification) — re-firing verification for run ${runId}.`,
        );
        await this.trackPostTerminalTask(
          runId,
          () => this.verifyAndLand(runId, run.status as 'completed' | 'failed'),
        );
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
    for (const row of listContractsLandedTeardownIncomplete()) {
      // Per-contract isolation: one bad row never aborts boot.
      try {
        const contract = this.contracts.get(row.id);
        if (!contract || contract.landingStatus !== 'landed') continue;
        const project = getProjectById(contract.projectId as ULID);
        if (!project?.folderPath || !contract.worktreePath) continue;
        const producing = contract.agentRunId
          ? getAgentRunRow(contract.agentRunId as ULID)
          : null;
        const repositoryIdentity = producing?.gitReceipt?.repositoryIdentity ?? null;
        if (!repositoryIdentity) {
          console.warn(
            `[pc-sdk][boot-recovery] teardown for contract ${contract.id} deferred: repository identity unavailable.`,
          );
          continue;
        }
        await this.repositoryLeases.acquire(project.folderPath, repositoryIdentity);
        console.warn(
          `[pc-sdk][boot-recovery] contract ${contract.id} landed but its worktree survived — resuming teardown of ${contract.worktreePath}.`,
        );
        const runId = (contract.agentRunId ?? null) as ULID | null;
        // Crash mid-'merging': the durable receipt proves the merge happened.
        this.stampLifecycleWhenLegal(runId, 'merged');
        this.stampLifecycleWhenLegal(runId, 'tearing-down');
        const ok = await this.settleLandedCleanup(
          contract,
          project,
          repositoryIdentity,
        );
        this.stampLifecycleWhenLegal(runId, ok ? 'completed' : 'stranded');
        // A reclaim that finally succeeded resolves earlier preserved parks
        // (a previously 'stranded' run exits the feed here).
        if (ok) this.resolvePreservedRuns(contract.id as ULID);
      } catch (err) {
        console.error(`[pc-sdk][boot-recovery] teardown resume failed for contract ${row.id} — continuing with the rest:`, err);
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

  async disposeAll(): Promise<void> {
    this.shuttingDown = true;
    for (const [runId, liveRun] of [...this.live]) {
      if (getReviewCheckoutForReviewer(runId as ULID)) {
        const reviewer = getAgentRunRow(runId as ULID);
        if (reviewer) {
          await this.killRun(reviewer.projectId, runId as ULID, {
            failureCause: 'cancelled',
            failureReason: 'server shutdown retired independent reviewer',
          });
        } else {
          clearTimeout(liveRun.wallClock);
          this.live.delete(runId);
          this.retireRuntime(runId as ULID, liveRun.session);
        }
        continue;
      }
      clearTimeout(liveRun.wallClock);
      this.live.delete(runId);
      this.retireRuntime(runId as ULID, liveRun.session);
    }
    // Profile/preflight/mint reviewers may own a queued/spawning row without
    // a live runtime handle. Terminalize those rows now so the task drain can
    // pass them through the same verdict-recording and teardown owner.
    for (const checkout of listReviewCheckoutsNeedingRecovery()) {
      const run = getAgentRunRow(checkout.reviewerRunId);
      if (run && !['completed', 'failed', 'cancelled'].includes(run.status)) {
        await this.killRun(run.projectId, checkout.reviewerRunId, {
          failureCause: 'cancelled',
          failureReason: 'server shutdown retired pre-live independent reviewer',
        });
      }
    }
    // Drain to a fixed point: a tracked producer can synchronously register a
    // later generation (terminal verification -> reviewer cleanup, or a run
    // task -> terminal settlement) as it resolves. Shutdown rechecks prevent
    // new external continuation admission; this loop closes the internal task
    // graph rather than assuming two generations are enough.
    for (;;) {
      const pendingWork = [
        ...this.reviewAdmissionTasks.values(),
        ...this.pendingReviewCleanupTasks.values(),
        ...[...this.postTerminalTasks.values()]
          .filter((task) => task.status === 'pending')
          .map((task) => task.promise),
        ...this.runTasks.values(),
        ...this.liveRevivals.values(),
        ...[...this.retiringRuns.values()]
          .filter((retirement) => retirement.status === 'pending')
          .map((retirement) => retirement.promise),
      ];
      if (pendingWork.length === 0) break;
      await Promise.allSettled(pendingWork);
    }
    await this.recoverReviewWorkspaces();
    const failures = [
      ...[...this.retiringRuns.values()]
        .filter((retirement) => retirement.status === 'failed')
        .map((retirement) => retirement.error),
      ...[...this.postTerminalTasks.entries()]
        .filter(([runId, task]) =>
          task.status === 'failed' && !this.reviewSettlementIsDurablyComplete(runId as ULID),
        )
        .map(([, task]) => task.error),
      ...[...this.reviewCleanupFailures.entries()]
        .filter(([runId]) => !this.reviewSettlementIsDurablyComplete(runId as ULID))
        .map(([, error]) => error),
      ...this.runtimeRetirementFailures.values(),
    ];
    if (failures.length > 0) {
      throw new AggregateError(failures, 'one or more specialist runtimes failed to dispose');
    }
  }

  private reviewSettlementIsDurablyComplete(runId: ULID): boolean {
    const checkout = getReviewCheckoutForReviewer(runId);
    if (!checkout || checkout.status !== 'destroyed' ||
        !isMatchingReviewCheckoutTeardown(checkout, checkout.teardownReceipt)) return false;
    if (checkout.verdictReceipt) return checkout.verdictAppliedAt !== null;
    return findContractByReviewRun(runId) === null;
  }
}

function requireProjectRepositoryIdentityBinding(
  projectId: ULID,
  projectDir: string,
  guard: RepositoryLeaseGuard,
): void {
  if (bindProjectRepositoryIdentity(projectId, guard.identity)) return;
  throw new RepositoryLeaseError(
    'repository-unavailable',
    projectDir,
    guard.identity,
    guard.lockPath,
    'PROJECT_UNAVAILABLE_DURING_REPOSITORY_BIND',
  );
}

function repositoryLeaseFailure(error: unknown): {
  cause: Extract<DispatchFailureCause, 'repository-occupied' | 'repository-unavailable'>;
  message: string;
  httpStatus: 409 | 503;
} {
  if (error instanceof RepositoryLeaseError && error.code === 'repository-occupied') {
    return { cause: 'repository-occupied', message: error.message, httpStatus: 409 };
  }
  return {
    cause: 'repository-unavailable',
    message: error instanceof Error ? error.message : 'repository authority is unavailable',
    httpStatus: 503,
  };
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
