// agent_contracts repo. Persistence-only (no outbox writes — the app-services
// ContractService announces). DbExecutor-injectable `*InDb` variants + getDb()
// wrappers.
//
// A contract is a first-class agent assignment with a typed, verified output.
// Optionally carries an external PM item ref (`pmRef`). The deliverable lives
// here. Keyed by contract id / agent_run_id.

import { and, asc, desc, eq, inArray, isNotNull, isNull } from 'drizzle-orm';
import type {
  AcceptanceCriteria,
  ContractLandingAuthorizer,
  ContractLandingPolicy,
  ContractLandingStatus,
  ContractStatus,
  ContractV2,
  Deliverable,
  ULID,
  VerificationStatus,
  VerificationTier,
} from '@pc/domain';
import { getDb } from '../connection.ts';
import type { DbExecutor } from '../connection.ts';
import { newId } from '../id.ts';
import { agentContracts, worktrees } from '../schema.ts';

export interface ContractRow {
  id: ULID;
  projectId: ULID;
  pmRef: string | null;
  agentRunId: ULID | null;
  podName: string | null;
  expectedOutput: ContractV2.ExpectedOutput | null;
  acceptanceCriteria: AcceptanceCriteria | null;
  verificationTier: VerificationTier | null;
  verificationStatus: VerificationStatus | null;
  verificationNotes: string | null;
  report: string | null;
  deliverable: Deliverable | null;
  worktreePath: string | null;
  worktreeBaseBranch: string | null;
  worktreeBaseSha: string | null;
  /** pc-pty-chat-415 (R5) — accept ⇒ land. Null = not applicable. */
  landingStatus: ContractLandingStatus | null;
  landedBranch: string | null;
  landedSha: string | null;
  landingError: string | null;
  landedAt: number | null;
  /** worktree-lifecycle merge receipt — `landedSha` stays the branch tip; the
   *  merge commit lives here. NULL for rows predating migration 0002. */
  targetShaBefore: string | null;
  targetShaAfter: string | null;
  mergeSha: string | null;
  landingAuthorizer: ContractLandingAuthorizer | null;
  verifiedBaseSha: string | null;
  /** NULL = legacy row; read via effectiveLandingPolicy() (@pc/domain). */
  landingPolicy: ContractLandingPolicy | null;
  /** Full-review loop (migration 0006): reviewer dispatches consumed +
   *  in-flight review run (NULL = none in flight / verdict recorded). */
  reviewRound: number | null;
  reviewRunId: ULID | null;
  /** Migration 0007 — the sealed deliverable commit the in-flight reviewer
   *  was briefed on; approve settlement re-checks it so a mid-review reseal
   *  voids the verdict. Cleared together with reviewRunId. */
  reviewSealedCommit: string | null;
  status: ContractStatus;
  version: number;
  createdAt: number;
  updatedAt: number;
}

export interface CreateContractInput {
  id?: ULID;
  projectId: ULID;
  pmRef?: string | null;
  agentRunId?: ULID | null;
  podName?: string | null;
  expectedOutput?: ContractV2.ExpectedOutput | null;
  acceptanceCriteria?: AcceptanceCriteria | null;
  verificationTier?: VerificationTier | null;
  report?: string | null;
  worktreePath?: string | null;
  worktreeBaseBranch?: string | null;
  worktreeBaseSha?: string | null;
  landingPolicy?: ContractLandingPolicy | null;
  status?: ContractStatus;
}

// ── Reads ─────────────────────────────────────────────────────────────────────

export function getContract(id: ULID): ContractRow | null {
  return getContractInDb(getDb(), id);
}

export function getContractInDb(db: DbExecutor, id: ULID): ContractRow | null {
  const row = db.select().from(agentContracts).where(eq(agentContracts.id, id)).get() as
    | ContractRow
    | undefined;
  return row ?? null;
}

/** All contracts produced by one agent run. Newest first. */
export function listContractsForRun(agentRunId: ULID): ContractRow[] {
  return listContractsForRunInDb(getDb(), agentRunId);
}

export function listContractsForRunInDb(db: DbExecutor, agentRunId: ULID): ContractRow[] {
  return db
    .select()
    .from(agentContracts)
    .where(eq(agentContracts.agentRunId, agentRunId))
    .orderBy(desc(agentContracts.createdAt), desc(agentContracts.id))
    .all() as ContractRow[];
}

/** All contracts in one project, newest first — the project-scoped contract
 *  list. Surfaces WI-optional dispatches (contracts with workItemId === null)
 *  that the work-log timeline can't reach. */
export function listContractsForProject(projectId: ULID): ContractRow[] {
  return listContractsForProjectInDb(getDb(), projectId);
}

export function listContractsForProjectInDb(db: DbExecutor, projectId: ULID): ContractRow[] {
  return db
    .select()
    .from(agentContracts)
    .where(eq(agentContracts.projectId, projectId))
    .orderBy(desc(agentContracts.createdAt), desc(agentContracts.id))
    .all() as ContractRow[];
}

// ── Writes ──────────────────────────────────────────────────────────────────

export function createContract(input: CreateContractInput): ContractRow {
  return createContractInDb(getDb(), input);
}

export function createContractInDb(db: DbExecutor, input: CreateContractInput): ContractRow {
  const now = Date.now();
  const id = input.id ?? (newId() as ULID);
  const row: ContractRow = {
    id,
    projectId: input.projectId,
    pmRef: input.pmRef ?? null,
    agentRunId: input.agentRunId ?? null,
    podName: input.podName ?? null,
    expectedOutput: input.expectedOutput ?? null,
    acceptanceCriteria: input.acceptanceCriteria ?? null,
    verificationTier: input.verificationTier ?? null,
    verificationStatus: null,
    verificationNotes: null,
    report: input.report ?? null,
    deliverable: null,
    worktreePath: input.worktreePath ?? null,
    worktreeBaseBranch: input.worktreeBaseBranch ?? null,
    worktreeBaseSha: input.worktreeBaseSha ?? null,
    landingStatus: null,
    landedBranch: null,
    landedSha: null,
    landingError: null,
    landedAt: null,
    targetShaBefore: null,
    targetShaAfter: null,
    mergeSha: null,
    landingAuthorizer: null,
    verifiedBaseSha: null,
    landingPolicy: input.landingPolicy ?? null,
    reviewRound: null,
    reviewRunId: null,
    reviewSealedCommit: null,
    status: input.status ?? 'issued',
    version: 1,
    createdAt: now,
    updatedAt: now,
  };
  db.insert(agentContracts).values(row).run();
  return row;
}

/** Point the contract at its producing run + flip to `dispatched`. Bumps
 *  version. Returns the updated row, or null if the contract is gone. */
export function setContractRun(
  id: ULID,
  agentRunId: ULID,
  db: DbExecutor = getDb(),
): ContractRow | null {
  const existing = getContractInDb(db, id);
  if (!existing) return null;
  db.update(agentContracts)
    .set({
      agentRunId,
      status: 'dispatched',
      version: existing.version + 1,
      updatedAt: Date.now(),
    })
    .where(eq(agentContracts.id, id))
    .run();
  return getContractInDb(db, id);
}

export interface SetDeliverableInput {
  deliverable: Deliverable | null;
  report?: string | null;
  /** Optional status override (default 'submitted'). */
  status?: ContractStatus;
}

/** Write the captured deliverable (+ optional report) onto the contract. Bumps
 *  version. Returns the updated row, or null if the contract is gone. */
export function setContractDeliverable(
  id: ULID,
  input: SetDeliverableInput,
  db: DbExecutor = getDb(),
): ContractRow | null {
  const existing = getContractInDb(db, id);
  if (!existing) return null;
  const patch: Partial<ContractRow> = {
    deliverable: input.deliverable,
    status: input.status ?? 'submitted',
    version: existing.version + 1,
    updatedAt: Date.now(),
  };
  if (input.report !== undefined) patch.report = input.report;
  db.update(agentContracts).set(patch).where(eq(agentContracts.id, id)).run();
  return getContractInDb(db, id);
}

export interface SetVerificationInput {
  verificationStatus: VerificationStatus;
  verificationNotes?: string | null;
  verificationTier?: VerificationTier;
  /** The target tip this verification covered. Orchestrator accept stamps the
   *  CURRENT tip here — the stale-base recovery door guard 7 advertises. */
  verifiedBaseSha?: string | null;
  status?: ContractStatus;
}

export interface SetLandingInput {
  landingStatus: ContractLandingStatus;
  landedBranch?: string | null;
  /** The agent BRANCH TIP — never the merge commit (that's `mergeSha`). */
  landedSha?: string | null;
  landingError?: string | null;
  landedAt?: number | null;
  targetShaBefore?: string | null;
  targetShaAfter?: string | null;
  mergeSha?: string | null;
  landingAuthorizer?: ContractLandingAuthorizer | null;
  verifiedBaseSha?: string | null;
}

/** pc-pty-chat-415 (R5) — record the landing state/receipts onto the contract.
 *  Bumps version. Returns the updated row, or null if the contract is gone. */
export function setContractLanding(
  id: ULID,
  input: SetLandingInput,
  db: DbExecutor = getDb(),
): ContractRow | null {
  const existing = getContractInDb(db, id);
  if (!existing) return null;
  const patch: Partial<ContractRow> = {
    landingStatus: input.landingStatus,
    version: existing.version + 1,
    updatedAt: Date.now(),
  };
  if (input.landedBranch !== undefined) patch.landedBranch = input.landedBranch;
  if (input.landedSha !== undefined) patch.landedSha = input.landedSha;
  if (input.landingError !== undefined) patch.landingError = input.landingError;
  if (input.landedAt !== undefined) patch.landedAt = input.landedAt;
  if (input.targetShaBefore !== undefined) patch.targetShaBefore = input.targetShaBefore;
  if (input.targetShaAfter !== undefined) patch.targetShaAfter = input.targetShaAfter;
  if (input.mergeSha !== undefined) patch.mergeSha = input.mergeSha;
  if (input.landingAuthorizer !== undefined) patch.landingAuthorizer = input.landingAuthorizer;
  if (input.verifiedBaseSha !== undefined) patch.verifiedBaseSha = input.verifiedBaseSha;
  db.update(agentContracts).set(patch).where(eq(agentContracts.id, id)).run();
  return getContractInDb(db, id);
}

/** pc-pty-chat-415 (R14) — branches whose work was explicitly abandoned for a
 *  project. The stranded report excludes them: their preservation record is
 *  on the contract; the branch ref intentionally remains. */
export function listAbandonedContractBranches(projectId: ULID, db: DbExecutor = getDb()): string[] {
  const rows = db
    .select({ landedBranch: agentContracts.landedBranch })
    .from(agentContracts)
    .where(and(eq(agentContracts.projectId, projectId), eq(agentContracts.landingStatus, 'abandoned')))
    .all() as { landedBranch: string | null }[];
  return rows.map((r) => r.landedBranch).filter((b): b is string => !!b);
}

/** pc-pty-chat-415 (R5) — landings interrupted mid-flight (status 'pending'),
 *  re-driven at boot. The landing mechanics are idempotent, so a crash between
 *  merge and push (or push and receipt) converges on re-drive. */
export function listContractsPendingLanding(db: DbExecutor = getDb()): ContractRow[] {
  return db
    .select()
    .from(agentContracts)
    .where(eq(agentContracts.landingStatus, 'pending'))
    .orderBy(asc(agentContracts.updatedAt))
    .all() as ContractRow[];
}

/** docs/worktree-lifecycle.md Recovery — 'merge positively complete but
 *  teardown incomplete → resume teardown': landed contracts whose bound
 *  worktree row is still ACTIVE. The landing receipt is durable BEFORE
 *  teardown (guard 9), so a crash in between leaves exactly this shape. Boot
 *  resumes their teardown BEFORE the stranded scan. */
export function listContractsLandedTeardownIncomplete(db: DbExecutor = getDb()): ContractRow[] {
  const activeBoundContracts = db
    .select({ contractId: worktrees.contractId })
    .from(worktrees)
    .where(and(eq(worktrees.status, 'active'), isNotNull(worktrees.contractId)));
  return db
    .select()
    .from(agentContracts)
    .where(and(eq(agentContracts.landingStatus, 'landed'), inArray(agentContracts.id, activeBoundContracts)))
    .orderBy(asc(agentContracts.updatedAt))
    .all() as ContractRow[];
}

/** Recovery — sealed deliverable but NO verification outcome ever recorded: a
 *  crash between a run's terminal commit and the verification write leaves
 *  exactly this shape (the run is terminal, so the non-terminal boot scans
 *  never see it). Boot re-fires verification for these; without it the
 *  stranded scan would durably strand a worktree one write away from
 *  converging. */
export function listContractsSealedUnverified(db: DbExecutor = getDb()): ContractRow[] {
  return db
    .select()
    .from(agentContracts)
    .where(and(isNotNull(agentContracts.deliverable), isNull(agentContracts.verificationStatus)))
    .orderBy(asc(agentContracts.updatedAt))
    .all() as ContractRow[];
}

export interface SetReviewStateInput {
  /** Reviewer dispatches consumed. Omit to leave unchanged. */
  reviewRound?: number;
  /** In-flight review run; null clears the marker (verdict recorded / dead
   *  reviewer). Omit to leave unchanged. */
  reviewRunId?: ULID | null;
  /** Sealed commit the in-flight reviewer was briefed on; null clears (set
   *  and cleared together with reviewRunId). Omit to leave unchanged. */
  reviewSealedCommit?: string | null;
}

/** Full-review loop markers (round counter + in-flight review run). Bumps
 *  version. Returns the updated row, or null if the contract is gone. */
export function setContractReviewState(
  id: ULID,
  input: SetReviewStateInput,
  db: DbExecutor = getDb(),
): ContractRow | null {
  const existing = getContractInDb(db, id);
  if (!existing) return null;
  const patch: Partial<ContractRow> = {
    version: existing.version + 1,
    updatedAt: Date.now(),
  };
  if (input.reviewRound !== undefined) patch.reviewRound = input.reviewRound;
  if (input.reviewRunId !== undefined) patch.reviewRunId = input.reviewRunId;
  if (input.reviewSealedCommit !== undefined) patch.reviewSealedCommit = input.reviewSealedCommit;
  db.update(agentContracts).set(patch).where(eq(agentContracts.id, id)).run();
  return getContractInDb(db, id);
}

/** The full-review target a review run was dispatched against (reviewRunId
 *  marker) — how verdict settlement finds the contract under review. */
export function findContractByReviewRun(reviewRunId: ULID, db: DbExecutor = getDb()): ContractRow | null {
  const row = db
    .select()
    .from(agentContracts)
    .where(eq(agentContracts.reviewRunId, reviewRunId))
    .get() as ContractRow | undefined;
  return row ?? null;
}

/** Full-review contracts whose verified pass has NOT landed and is not mid-
 *  landing: review in flight, crashed, or never dispatched (ctx-less boot
 *  verification). Boot re-drives these through ensureIndependentReview AFTER
 *  attach — a crashed reviewer must leave the contract re-dispatchable, never
 *  wedged. Failed/conflict/stale-base landings are orchestrator doors, not
 *  review; 'pending' belongs to the landing re-drive. */
export function listContractsAwaitingIndependentReview(db: DbExecutor = getDb()): ContractRow[] {
  return db
    .select()
    .from(agentContracts)
    .where(
      and(
        eq(agentContracts.landingPolicy, 'full-review'),
        eq(agentContracts.verificationStatus, 'passed'),
        isNull(agentContracts.landingStatus),
      ),
    )
    .orderBy(asc(agentContracts.updatedAt))
    .all() as ContractRow[];
}

/** Record the verification outcome onto the contract. Bumps version. Returns
 *  the updated row, or null if the contract is gone. */
export function setContractVerification(
  id: ULID,
  input: SetVerificationInput,
  db: DbExecutor = getDb(),
): ContractRow | null {
  const existing = getContractInDb(db, id);
  if (!existing) return null;
  const patch: Partial<ContractRow> = {
    verificationStatus: input.verificationStatus,
    version: existing.version + 1,
    updatedAt: Date.now(),
  };
  if (input.verificationNotes !== undefined) patch.verificationNotes = input.verificationNotes;
  if (input.verificationTier !== undefined) patch.verificationTier = input.verificationTier;
  if (input.verifiedBaseSha !== undefined) patch.verifiedBaseSha = input.verifiedBaseSha;
  patch.status =
    input.status ??
    (input.verificationStatus === 'passed'
      ? 'accepted'
      : input.verificationStatus === 'failed'
        ? 'rejected'
        : 'verifying');
  db.update(agentContracts).set(patch).where(eq(agentContracts.id, id)).run();
  return getContractInDb(db, id);
}
