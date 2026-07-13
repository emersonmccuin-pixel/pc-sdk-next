// agent_contracts repo. Persistence-only (no outbox writes — the app-services
// ContractService announces). DbExecutor-injectable `*InDb` variants + getDb()
// wrappers.
//
// A contract is a first-class agent assignment with a typed, verified output.
// Optionally carries an external PM item ref (`pmRef`). The deliverable lives
// here. Keyed by contract id / agent_run_id.

import { and, asc, desc, eq, exists, inArray, isNotNull, isNull, notExists, notInArray, or, sql } from 'drizzle-orm';
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
  WorktreeAbandonmentReceipt,
  WorktreeAbandonmentTeardownReceipt,
} from '@pc/domain';
import {
  isMatchingWorktreeAbandonmentTeardown,
  isWorktreeAbandonmentReceipt,
  isWorktreeAbandonmentTeardownReceipt,
} from '@pc/domain';
import { getDb } from '../connection.ts';
import type { DbExecutor } from '../connection.ts';
import { newId } from '../id.ts';
import { agentContracts, agentRuns, worktrees } from '../schema.ts';

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
  /** DL-002: immutable browser approval + positive teardown settlement. */
  abandonmentReceipt: WorktreeAbandonmentReceipt | null;
  abandonmentTeardownReceipt: WorktreeAbandonmentTeardownReceipt | null;
  abandonmentError: string | null;
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
    abandonmentReceipt: null,
    abandonmentTeardownReceipt: null,
    abandonmentError: null,
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
  db?: DbExecutor,
): ContractRow | null {
  if (!db) {
    return getDb().transaction((tx) => setContractRun(id, agentRunId, tx));
  }
  const existing = getContractInDb(db, id);
  if (!existing) return null;
  const priorWorktree = existing.agentRunId &&
    existing.agentRunId !== agentRunId &&
    existing.worktreePath
    ? db.select({
        id: worktrees.id,
        agentRunId: worktrees.agentRunId,
      }).from(worktrees).where(and(
        eq(worktrees.projectId, existing.projectId),
        eq(worktrees.contractId, id),
        eq(worktrees.path, existing.worktreePath),
        existing.worktreeBaseBranch
          ? eq(worktrees.baseBranch, existing.worktreeBaseBranch)
          : undefined,
        inArray(worktrees.status, ['active', 'stranded']),
      )).limit(2).all()
    : null;
  if (
    priorWorktree &&
    (priorWorktree.length !== 1 || priorWorktree[0]?.agentRunId !== existing.agentRunId)
  ) return null;
  const changed = db.update(agentContracts)
    .set({
      agentRunId,
      status: 'dispatched',
      version: existing.version + 1,
      updatedAt: Date.now(),
    })
    .where(and(
      eq(agentContracts.id, id),
      eq(agentContracts.version, existing.version),
      isNull(agentContracts.abandonmentReceipt),
      or(
        isNull(agentContracts.landingStatus),
        inArray(agentContracts.landingStatus, ['conflict', 'failed', 'stale-base']),
      ),
    ))
    .run();
  if (changed.changes !== 1) return null;
  if (priorWorktree) {
    const rebound = db.update(worktrees).set({ agentRunId }).where(and(
      eq(worktrees.id, priorWorktree[0]!.id),
      eq(worktrees.projectId, existing.projectId),
      eq(worktrees.contractId, id),
      eq(worktrees.agentRunId, existing.agentRunId!),
      eq(worktrees.path, existing.worktreePath!),
      existing.worktreeBaseBranch
        ? eq(worktrees.baseBranch, existing.worktreeBaseBranch)
        : undefined,
      inArray(worktrees.status, ['active', 'stranded']),
    )).run();
    if (rebound.changes !== 1) {
      throw new Error('contract producer advanced without exact worktree ownership transfer');
    }
  }
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
  const changed = db.update(agentContracts).set(patch).where(and(
    eq(agentContracts.id, id),
    eq(agentContracts.version, existing.version),
    isNull(agentContracts.abandonmentReceipt),
    or(isNull(agentContracts.landingStatus), notInArray(agentContracts.landingStatus, ['abandoning', 'abandoned'])),
  )).run();
  return changed.changes === 1 ? getContractInDb(db, id) : null;
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
  // Abandonment has dedicated receipt-bearing CAS doors below. A generic
  // landing patch can never manufacture destructive cleanup authority.
  if (input.landingStatus === 'abandoning' || input.landingStatus === 'abandoned') return null;
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
  const changed = db.update(agentContracts).set(patch).where(and(
    eq(agentContracts.id, id),
    eq(agentContracts.version, existing.version),
    isNull(agentContracts.abandonmentReceipt),
    or(
      isNull(agentContracts.landingStatus),
      inArray(agentContracts.landingStatus, ['pending', 'conflict', 'failed', 'stale-base']),
    ),
  )).run();
  return changed.changes === 1 ? getContractInDb(db, id) : null;
}

const noNonTerminalContractRun = (contractId: ULID, db: DbExecutor) => notExists(
  db.select({ id: agentRuns.id }).from(agentRuns).where(and(
    eq(agentRuns.contractId, contractId),
    inArray(agentRuns.status, ['queued', 'spawning', 'running', 'paused']),
  )),
);

export interface ReserveContractLandingInput {
  expectedVersion: number;
  expectedAgentRunId: ULID;
  landingAuthorizer: ContractLandingAuthorizer;
}

/** Exact landing reservation. Landing and abandonment race on the same
 * contract version; only one can reserve it. */
export function reserveContractLanding(
  id: ULID,
  input: ReserveContractLandingInput,
  db: DbExecutor = getDb(),
): ContractRow | null {
  const changed = db.update(agentContracts).set({
    landingStatus: 'pending',
    landingAuthorizer: input.landingAuthorizer,
    landingError: null,
    version: input.expectedVersion + 1,
    updatedAt: Date.now(),
  }).where(and(
    eq(agentContracts.id, id),
    eq(agentContracts.version, input.expectedVersion),
    eq(agentContracts.agentRunId, input.expectedAgentRunId),
    eq(agentContracts.verificationStatus, 'passed'),
    isNull(agentContracts.reviewRunId),
    isNull(agentContracts.abandonmentReceipt),
    isNull(agentContracts.abandonmentTeardownReceipt),
    or(
      isNull(agentContracts.landingStatus),
      inArray(agentContracts.landingStatus, ['conflict', 'failed', 'stale-base']),
    ),
    noNonTerminalContractRun(id, db),
  )).run();
  return changed.changes === 1 ? getContractInDb(db, id) : null;
}

export interface SettleContractLandingInput extends SetLandingInput {
  expectedVersion: number;
  expectedAgentRunId: ULID;
  landingStatus: 'landed' | 'conflict' | 'failed' | 'stale-base';
}

/** Settle only the exact pending landing reservation. */
export function settleContractLanding(
  id: ULID,
  input: SettleContractLandingInput,
  db: DbExecutor = getDb(),
): ContractRow | null {
  const patch: Partial<ContractRow> = {
    landingStatus: input.landingStatus,
    version: input.expectedVersion + 1,
    updatedAt: Date.now(),
  };
  if (input.landedBranch !== undefined) patch.landedBranch = input.landedBranch;
  if (input.landedSha !== undefined) patch.landedSha = input.landedSha;
  if (input.landingError !== undefined) patch.landingError = input.landingError;
  if (input.landedAt !== undefined) patch.landedAt = input.landedAt;
  if (input.targetShaBefore !== undefined) patch.targetShaBefore = input.targetShaBefore;
  if (input.targetShaAfter !== undefined) patch.targetShaAfter = input.targetShaAfter;
  if (input.mergeSha !== undefined) patch.mergeSha = input.mergeSha;
  // The reservation owns authorizer identity. Settlement may assert that same
  // identity, but can never replace it after Git work has begun.
  if (input.verifiedBaseSha !== undefined) patch.verifiedBaseSha = input.verifiedBaseSha;
  const changed = db.update(agentContracts).set(patch).where(and(
    eq(agentContracts.id, id),
    eq(agentContracts.version, input.expectedVersion),
    eq(agentContracts.agentRunId, input.expectedAgentRunId),
    eq(agentContracts.landingStatus, 'pending'),
    input.landingAuthorizer === undefined
      ? sql`1 = 1`
      : eq(agentContracts.landingAuthorizer, input.landingAuthorizer),
    isNull(agentContracts.abandonmentReceipt),
    isNull(agentContracts.abandonmentTeardownReceipt),
    noNonTerminalContractRun(id, db),
  )).run();
  return changed.changes === 1 ? getContractInDb(db, id) : null;
}

export interface AuthorizeContractAbandonmentInput {
  receipt: WorktreeAbandonmentReceipt;
}

/** First-write immutable browser authority. The worktree binding, producer,
 * version, review state, and absence of live runs are one SQL admission. */
export function authorizeContractAbandonment(
  id: ULID,
  input: AuthorizeContractAbandonmentInput,
  db: DbExecutor = getDb(),
): ContractRow | null {
  const receipt = input.receipt;
  if (!isWorktreeAbandonmentReceipt(receipt) || receipt.contractId !== id) return null;
  const boundWorktree = db.select({ id: worktrees.id }).from(worktrees).where(and(
    eq(worktrees.id, receipt.worktreeId),
    eq(worktrees.projectId, receipt.projectId),
    eq(worktrees.agentRunId, receipt.producerRunId),
    eq(worktrees.contractId, receipt.contractId),
    eq(worktrees.path, receipt.worktreePath),
    eq(worktrees.name, receipt.branch),
    eq(worktrees.branch, receipt.branch),
    eq(worktrees.baseBranch, receipt.baseBranch),
    eq(worktrees.status, receipt.worktreeStatus),
  ));
  const changed = db.update(agentContracts).set({
    landingStatus: 'abandoning',
    abandonmentReceipt: receipt,
    abandonmentTeardownReceipt: null,
    abandonmentError: null,
    // Landing and abandonment evidence are disjoint contracts.
    landedBranch: null,
    landedSha: null,
    landedAt: null,
    landingError: null,
    targetShaBefore: null,
    targetShaAfter: null,
    mergeSha: null,
    landingAuthorizer: null,
    version: receipt.approvedContractVersion + 1,
    updatedAt: Date.now(),
  }).where(and(
    eq(agentContracts.id, id),
    eq(agentContracts.projectId, receipt.projectId),
    eq(agentContracts.agentRunId, receipt.producerRunId),
    eq(agentContracts.version, receipt.approvedContractVersion),
    eq(agentContracts.worktreePath, receipt.worktreePath),
    eq(agentContracts.worktreeBaseBranch, receipt.baseBranch),
    isNull(agentContracts.reviewRunId),
    isNull(agentContracts.abandonmentReceipt),
    isNull(agentContracts.abandonmentTeardownReceipt),
    isNull(agentContracts.mergeSha),
    isNull(agentContracts.landedAt),
    or(
      isNull(agentContracts.landingStatus),
      inArray(agentContracts.landingStatus, ['conflict', 'failed', 'stale-base', 'abandoned']),
    ),
    exists(boundWorktree),
    noNonTerminalContractRun(id, db),
  )).run();
  return changed.changes === 1 ? getContractInDb(db, id) : null;
}

export interface SetContractAbandonmentErrorInput {
  expectedVersion: number;
  authorityRequestId: string;
  error: string;
}

export function setContractAbandonmentError(
  id: ULID,
  input: SetContractAbandonmentErrorInput,
  db: DbExecutor = getDb(),
): ContractRow | null {
  if (!input.error.trim() || input.error !== input.error.trim()) return null;
  const changed = db.update(agentContracts).set({
    abandonmentError: input.error,
    version: input.expectedVersion + 1,
    updatedAt: Date.now(),
  }).where(and(
    eq(agentContracts.id, id),
    eq(agentContracts.version, input.expectedVersion),
    eq(agentContracts.landingStatus, 'abandoning'),
    sql`json_extract(${agentContracts.abandonmentReceipt}, '$.requestId') = ${input.authorityRequestId}`,
    isNull(agentContracts.abandonmentTeardownReceipt),
  )).run();
  return changed.changes === 1 ? getContractInDb(db, id) : null;
}

export interface SettleContractAbandonmentInput {
  expectedVersion: number;
  receipt: WorktreeAbandonmentTeardownReceipt;
}

export function settleContractAbandonment(
  id: ULID,
  input: SettleContractAbandonmentInput,
  db: DbExecutor = getDb(),
): ContractRow | null {
  if (!isWorktreeAbandonmentTeardownReceipt(input.receipt)) return null;
  const current = getContractInDb(db, id);
  const authority = current?.abandonmentReceipt;
  if (
    !current ||
    current.version !== input.expectedVersion ||
    !isWorktreeAbandonmentReceipt(authority) ||
    !isMatchingWorktreeAbandonmentTeardown(authority, input.receipt)
  ) return null;
  const destroyedWorktree = db.select({ id: worktrees.id }).from(worktrees).where(and(
    eq(worktrees.id, authority.worktreeId),
    eq(worktrees.projectId, authority.projectId),
    eq(worktrees.agentRunId, authority.producerRunId),
    eq(worktrees.contractId, authority.contractId),
    eq(worktrees.path, authority.worktreePath),
    eq(worktrees.name, authority.branch),
    eq(worktrees.branch, authority.branch),
    eq(worktrees.baseBranch, authority.baseBranch),
    eq(worktrees.status, 'destroyed'),
    eq(worktrees.destroyedAt, input.receipt.finishedAt),
  ));
  const changed = db.update(agentContracts).set({
    landingStatus: 'abandoned',
    abandonmentTeardownReceipt: input.receipt,
    abandonmentError: null,
    version: input.expectedVersion + 1,
    updatedAt: Date.now(),
  }).where(and(
    eq(agentContracts.id, id),
    eq(agentContracts.version, input.expectedVersion),
    eq(agentContracts.landingStatus, 'abandoning'),
    sql`json_extract(${agentContracts.abandonmentReceipt}, '$.requestId') = ${input.receipt.authorityRequestId}`,
    isNull(agentContracts.abandonmentTeardownReceipt),
    isNull(agentContracts.reviewRunId),
    exists(destroyedWorktree),
    noNonTerminalContractRun(id, db),
  )).run();
  return changed.changes === 1 ? getContractInDb(db, id) : null;
}

/** Legacy compatibility name. Returns only branches that must remain
 * protected: authorized teardown in progress or legacy `abandoned` rows with
 * no positive settlement. A settled abandonment has no worktree directory to
 * hide and is deliberately absent. */
export function listAbandonedContractBranches(projectId: ULID, db: DbExecutor = getDb()): string[] {
  const rows = db
    .select({
      landedBranch: agentContracts.landedBranch,
      worktreePath: agentContracts.worktreePath,
      abandonmentReceipt: agentContracts.abandonmentReceipt,
    })
    .from(agentContracts)
    .where(and(
      eq(agentContracts.projectId, projectId),
      or(
        eq(agentContracts.landingStatus, 'abandoning'),
        and(
          eq(agentContracts.landingStatus, 'abandoned'),
          isNull(agentContracts.abandonmentTeardownReceipt),
        ),
      ),
    ))
    .all();
  return rows.map((row) => {
    if (isWorktreeAbandonmentReceipt(row.abandonmentReceipt)) {
      return row.abandonmentReceipt.branch;
    }
    return row.landedBranch ?? row.worktreePath?.split(/[\\/]/).pop() ?? null;
  }).filter((branch): branch is string => !!branch);
}

/** Paths protected from stranded/orphan deletion while browser authority is
 * in progress, plus legacy `abandoned` rows that carry no cleanup authority. */
export function listProtectedAbandonmentWorktreePaths(
  projectId: ULID,
  db: DbExecutor = getDb(),
): string[] {
  const rows = db.select({ worktreePath: agentContracts.worktreePath })
    .from(agentContracts)
    .where(and(
      eq(agentContracts.projectId, projectId),
      isNotNull(agentContracts.worktreePath),
      or(
        eq(agentContracts.landingStatus, 'abandoning'),
        and(
          eq(agentContracts.landingStatus, 'abandoned'),
          isNull(agentContracts.abandonmentTeardownReceipt),
        ),
      ),
    )).all();
  return rows.map((row) => row.worktreePath).filter((path): path is string => !!path);
}

/** Exact recovery feeder. Malformed/legacy rows never become cleanup
 * authority; only a canonical first-write receipt re-drives. */
export function listContractsNeedingAbandonmentRecovery(
  db: DbExecutor = getDb(),
): ContractRow[] {
  return db.select().from(agentContracts).where(and(
    eq(agentContracts.landingStatus, 'abandoning'),
    isNotNull(agentContracts.abandonmentReceipt),
    isNull(agentContracts.abandonmentTeardownReceipt),
  )).orderBy(asc(agentContracts.updatedAt)).all()
    .filter((row) => isWorktreeAbandonmentReceipt(row.abandonmentReceipt)) as ContractRow[];
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
 * teardown incomplete → resume teardown'. Active and stranded exact bindings
 * are both retry feeders. A destroyed exact binding also feeds recovery only
 * while its current producer is still in a pre-completion cleanup lifecycle;
 * that is the crash window after row settlement but before `completed`. */
export function listContractsLandedTeardownIncomplete(db: DbExecutor = getDb()): ContractRow[] {
  const unresolvedBoundContracts = db
    .select({ contractId: worktrees.contractId })
    .from(worktrees)
    .where(and(
      inArray(worktrees.status, ['active', 'stranded']),
      isNotNull(worktrees.contractId),
    ));
  const lifecycleCrashWindowContracts = db
    .select({ contractId: agentRuns.contractId })
    .from(agentRuns)
    .where(and(
      isNotNull(agentRuns.contractId),
      inArray(agentRuns.lifecycleState, [
        'merging',
        'merged',
        'tearing-down',
        'merge-ready',
        'conflict',
        'review-rejected',
        'failed',
        'stranded',
      ]),
    ));
  return db
    .select()
    .from(agentContracts)
    .where(and(
      eq(agentContracts.landingStatus, 'landed'),
      or(
        inArray(agentContracts.id, unresolvedBoundContracts),
        inArray(agentContracts.id, lifecycleCrashWindowContracts),
      ),
    ))
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
  const changed = db.update(agentContracts).set(patch).where(and(
    eq(agentContracts.id, id),
    eq(agentContracts.version, existing.version),
    isNull(agentContracts.abandonmentReceipt),
    or(isNull(agentContracts.landingStatus), notInArray(agentContracts.landingStatus, ['abandoning', 'abandoned'])),
  )).run();
  return changed.changes === 1 ? getContractInDb(db, id) : null;
}

export interface SetRunRecoveryVerificationInput {
  expectedVersion: number;
  projectId: ULID;
  producerRunId: ULID;
  verificationNotes: string;
  /** The only unbound shape admitted is the issued contract created just
   * before its run row when the process died between those two durable writes. */
  allowIssuedUnbound: boolean;
}

export interface ReserveContractReviewInput {
  expectedVersion: number;
  expectedReviewRunId: ULID | null;
  expectedAgentRunId: ULID | null;
  reviewRound: number;
  reviewRunId: ULID;
  reviewSealedCommit: string;
}

/** CAS reservation spanning async reviewer selection/checkout. Exactly one
 * admission may own a contract version + current marker. */
export function reserveContractReview(
  id: ULID,
  input: ReserveContractReviewInput,
  db: DbExecutor = getDb(),
): ContractRow | null {
  const reviewMarker = input.expectedReviewRunId === null
    ? isNull(agentContracts.reviewRunId)
    : eq(agentContracts.reviewRunId, input.expectedReviewRunId);
  const producer = input.expectedAgentRunId === null
    ? isNull(agentContracts.agentRunId)
    : eq(agentContracts.agentRunId, input.expectedAgentRunId);
  const changed = db.update(agentContracts).set({
    reviewRound: input.reviewRound,
    reviewRunId: input.reviewRunId,
    reviewSealedCommit: input.reviewSealedCommit,
    version: input.expectedVersion + 1,
    updatedAt: Date.now(),
  }).where(and(
    eq(agentContracts.id, id),
    eq(agentContracts.version, input.expectedVersion),
    reviewMarker,
    producer,
    eq(agentContracts.verificationStatus, 'passed'),
    isNull(agentContracts.landingStatus),
    isNull(agentContracts.abandonmentReceipt),
  )).run();
  return changed.changes === 1 ? getContractInDb(db, id) : null;
}

/** Release only the reservation owned by `reviewRunId`; never clear a newer
 * reviewer or an orchestrator override. */
export function clearContractReviewReservation(
  id: ULID,
  reviewRunId: ULID,
  db: DbExecutor = getDb(),
): ContractRow | null {
  const changed = db.update(agentContracts).set({
    reviewRunId: null,
    reviewSealedCommit: null,
    version: sql`${agentContracts.version} + 1`,
    updatedAt: Date.now(),
  }).where(and(
    eq(agentContracts.id, id),
    eq(agentContracts.reviewRunId, reviewRunId),
    isNull(agentContracts.abandonmentReceipt),
  )).run();
  return changed.changes === 1 ? getContractInDb(db, id) : null;
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
  const changed = db.update(agentContracts).set(patch).where(and(
    eq(agentContracts.id, id),
    eq(agentContracts.version, existing.version),
    isNull(agentContracts.abandonmentReceipt),
    or(isNull(agentContracts.landingStatus), notInArray(agentContracts.landingStatus, ['abandoning', 'abandoned'])),
  )).run();
  return changed.changes === 1 ? getContractInDb(db, id) : null;
}

/** Park verification after boot terminalizes a live run. The producer link,
 * project, version, and non-landed state are one CAS predicate so a stale
 * legacy row cannot overwrite a contract that has moved to a newer producer.
 * An issued+unbound contract is the narrowly allowed crash window between
 * run insertion and setContractRun; no other null binding is accepted. */
export function setContractRunRecoveryVerification(
  id: ULID,
  input: SetRunRecoveryVerificationInput,
  db: DbExecutor = getDb(),
): ContractRow | null {
  const producer = input.allowIssuedUnbound
    ? or(
        eq(agentContracts.agentRunId, input.producerRunId),
        and(isNull(agentContracts.agentRunId), eq(agentContracts.status, 'issued')),
      )
    : eq(agentContracts.agentRunId, input.producerRunId);
  const changed = db.update(agentContracts).set({
    verificationStatus: 'pending',
    verificationNotes: input.verificationNotes,
    status: 'verifying',
    version: input.expectedVersion + 1,
    updatedAt: Date.now(),
  }).where(and(
    eq(agentContracts.id, id),
    eq(agentContracts.projectId, input.projectId),
    eq(agentContracts.version, input.expectedVersion),
    producer,
    isNull(agentContracts.landingStatus),
    isNull(agentContracts.abandonmentReceipt),
  )).run();
  return changed.changes === 1 ? getContractInDb(db, id) : null;
}
