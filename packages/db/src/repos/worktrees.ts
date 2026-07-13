import { and, asc, eq, inArray, isNull } from 'drizzle-orm';
import {
  isMatchingReviewCheckoutProvision,
  isMatchingReviewCheckoutTeardown,
  isPositiveWorktreePhaseReceipt,
  isReviewCheckoutAuthority,
  isReviewCheckoutProvisionReceipt,
  isReviewCheckoutTeardownReceipt,
  isWorktreePhaseReceipt,
  type ReviewCheckout,
  type ReviewCheckoutAuthority,
  type ReviewCheckoutProvisionReceipt,
  type ReviewCheckoutTeardownReceipt,
  type ULID,
  type Worktree,
  type WorktreePhaseReceipt,
  type WorktreeStrandedReason,
} from '@pc/domain';
import { getDb, type DbExecutor } from '../connection.ts';
import { newId } from '../id.ts';
import { reviewCheckouts, worktrees } from '../schema.ts';

/** Persisted worktree shape — the domain `Worktree` type, verbatim. */
export type WorktreeRow = Worktree;
export type ReviewCheckoutRow = ReviewCheckout;

export interface CreateReviewCheckoutReservationInput extends ReviewCheckoutAuthority {
  createdAt: number;
}

export interface ReviewCheckoutMutationInput {
  authority: ReviewCheckoutAuthority;
  expectedUpdatedAt: number;
}

export interface SetReviewCheckoutProvisionReceiptInput
  extends ReviewCheckoutMutationInput {
  receipt: ReviewCheckoutProvisionReceipt;
}

export interface SetReviewCheckoutPhaseReceiptInput
  extends ReviewCheckoutMutationInput {
  receipt: WorktreePhaseReceipt;
}

export interface MarkReviewCheckoutTeardownPendingInput
  extends ReviewCheckoutMutationInput {
  fromStatus: 'reserved' | 'provisioned';
  at: number;
  error: string | null;
}

export interface SetReviewCheckoutCleanupErrorInput
  extends ReviewCheckoutMutationInput {
  error: string;
  at: number;
}

export interface SettleReviewCheckoutTeardownInput
  extends ReviewCheckoutMutationInput {
  receipt: ReviewCheckoutTeardownReceipt;
  destroyedAt: number;
}

function exactReviewCheckoutAuthority(authority: ReviewCheckoutAuthority) {
  return and(
    eq(reviewCheckouts.id, authority.id),
    eq(reviewCheckouts.projectId, authority.projectId),
    eq(reviewCheckouts.contractId, authority.contractId),
    eq(reviewCheckouts.contractVersion, authority.contractVersion),
    eq(reviewCheckouts.producerRunId, authority.producerRunId),
    eq(reviewCheckouts.reviewerRunId, authority.reviewerRunId),
    eq(reviewCheckouts.repositoryIdentity, authority.repositoryIdentity),
    eq(reviewCheckouts.worktreePath, authority.worktreePath),
    eq(reviewCheckouts.ownedRootRealPath, authority.ownedRootRealPath),
    eq(reviewCheckouts.sealedCommit, authority.sealedCommit),
  );
}

function mutationTime(expectedUpdatedAt: number, proposed: number): number {
  return Math.max(expectedUpdatedAt + 1, proposed);
}

function isConstraintError(error: unknown): boolean {
  return typeof error === 'object' && error !== null &&
    'code' in error && typeof error.code === 'string' &&
    error.code.startsWith('SQLITE_CONSTRAINT');
}

/** Reserve exact workspace authority before the first Git mutation. The
 * migration's admission trigger atomically proves the matching contract review
 * reservation, target version, producer, and sealed commit. */
export function createReviewCheckoutReservation(
  input: CreateReviewCheckoutReservationInput,
  db: DbExecutor = getDb(),
): ReviewCheckoutRow | null {
  if (!isReviewCheckoutAuthority(input) ||
      !Number.isSafeInteger(input.createdAt) || input.createdAt < 0) return null;
  try {
    db.insert(reviewCheckouts).values({
      ...input,
      status: 'reserved',
      provisionReceipt: null,
      preparationReceipt: null,
      readinessReceipt: null,
      teardownReceipt: null,
      cleanupError: null,
      updatedAt: input.createdAt,
      destroyedAt: null,
    }).run();
  } catch (error) {
    if (isConstraintError(error)) return null;
    throw error;
  }
  return getReviewCheckoutById(input.id, db);
}

export function getReviewCheckoutById(
  id: ULID,
  db: DbExecutor = getDb(),
): ReviewCheckoutRow | null {
  return db.select().from(reviewCheckouts)
    .where(eq(reviewCheckouts.id, id)).get() as ReviewCheckoutRow | undefined ?? null;
}

export function getReviewCheckoutForReviewer(
  reviewerRunId: ULID,
  db: DbExecutor = getDb(),
): ReviewCheckoutRow | null {
  return db.select().from(reviewCheckouts)
    .where(eq(reviewCheckouts.reviewerRunId, reviewerRunId)).get() as ReviewCheckoutRow | undefined ?? null;
}

export function getCurrentReviewCheckoutForContract(
  contractId: ULID,
  db: DbExecutor = getDb(),
): ReviewCheckoutRow | null {
  const rows = db.select().from(reviewCheckouts).where(and(
    eq(reviewCheckouts.contractId, contractId),
    inArray(reviewCheckouts.status, ['reserved', 'provisioned', 'teardown-pending']),
  )).limit(2).all() as ReviewCheckoutRow[];
  return rows.length === 1 ? rows[0]! : null;
}

export function listReviewCheckoutsNeedingRecovery(
  db: DbExecutor = getDb(),
): ReviewCheckoutRow[] {
  return db.select().from(reviewCheckouts).where(inArray(
    reviewCheckouts.status,
    ['reserved', 'provisioned', 'teardown-pending'],
  )).orderBy(asc(reviewCheckouts.updatedAt), asc(reviewCheckouts.id)).all() as ReviewCheckoutRow[];
}

export function setReviewCheckoutProvisionReceipt(
  input: SetReviewCheckoutProvisionReceiptInput,
  db: DbExecutor = getDb(),
): ReviewCheckoutRow | null {
  if (!isReviewCheckoutAuthority(input.authority) ||
      !isReviewCheckoutProvisionReceipt(input.receipt) ||
      !isMatchingReviewCheckoutProvision(input.authority, input.receipt)) return null;
  const changed = db.update(reviewCheckouts).set({
    status: 'provisioned',
    provisionReceipt: input.receipt,
    updatedAt: mutationTime(input.expectedUpdatedAt, input.receipt.observedAt),
  }).where(and(
    exactReviewCheckoutAuthority(input.authority),
    eq(reviewCheckouts.status, 'reserved'),
    eq(reviewCheckouts.updatedAt, input.expectedUpdatedAt),
    isNull(reviewCheckouts.provisionReceipt),
    isNull(reviewCheckouts.teardownReceipt),
  )).run();
  return changed.changes === 1 ? getReviewCheckoutById(input.authority.id, db) : null;
}

export function setReviewCheckoutPhaseReceipt(
  input: SetReviewCheckoutPhaseReceiptInput,
  db: DbExecutor = getDb(),
): ReviewCheckoutRow | null {
  if (!isReviewCheckoutAuthority(input.authority) ||
      !isWorktreePhaseReceipt(input.receipt)) return null;
  const current = getReviewCheckoutById(input.authority.id, db);
  if (!current || current.status !== 'provisioned' ||
      current.updatedAt !== input.expectedUpdatedAt) return null;
  if (input.receipt.phase === 'preparation') {
    if (current.preparationReceipt !== null || current.readinessReceipt !== null) return null;
  } else if (current.readinessReceipt !== null ||
      !isPositiveWorktreePhaseReceipt(current.preparationReceipt, 'preparation')) {
    return null;
  }
  const receiptColumn = input.receipt.phase === 'preparation'
    ? reviewCheckouts.preparationReceipt
    : reviewCheckouts.readinessReceipt;
  const patch = input.receipt.phase === 'preparation'
    ? { preparationReceipt: input.receipt }
    : { readinessReceipt: input.receipt };
  const changed = db.update(reviewCheckouts).set({
    ...patch,
    updatedAt: mutationTime(input.expectedUpdatedAt, input.receipt.finishedAt),
  }).where(and(
    exactReviewCheckoutAuthority(input.authority),
    eq(reviewCheckouts.status, 'provisioned'),
    eq(reviewCheckouts.updatedAt, input.expectedUpdatedAt),
    isNull(receiptColumn),
  )).run();
  return changed.changes === 1 ? getReviewCheckoutById(input.authority.id, db) : null;
}

export function markReviewCheckoutTeardownPending(
  input: MarkReviewCheckoutTeardownPendingInput,
  db: DbExecutor = getDb(),
): ReviewCheckoutRow | null {
  if (!isReviewCheckoutAuthority(input.authority) ||
      (input.error !== null && (input.error.trim().length === 0 || input.error !== input.error.trim()))) {
    return null;
  }
  const changed = db.update(reviewCheckouts).set({
    status: 'teardown-pending',
    cleanupError: input.error,
    updatedAt: mutationTime(input.expectedUpdatedAt, input.at),
  }).where(and(
    exactReviewCheckoutAuthority(input.authority),
    eq(reviewCheckouts.status, input.fromStatus),
    eq(reviewCheckouts.updatedAt, input.expectedUpdatedAt),
    isNull(reviewCheckouts.teardownReceipt),
  )).run();
  return changed.changes === 1 ? getReviewCheckoutById(input.authority.id, db) : null;
}

export function setReviewCheckoutCleanupError(
  input: SetReviewCheckoutCleanupErrorInput,
  db: DbExecutor = getDb(),
): ReviewCheckoutRow | null {
  if (!isReviewCheckoutAuthority(input.authority) ||
      input.error.trim().length === 0 || input.error !== input.error.trim()) return null;
  const changed = db.update(reviewCheckouts).set({
    cleanupError: input.error,
    updatedAt: mutationTime(input.expectedUpdatedAt, input.at),
  }).where(and(
    exactReviewCheckoutAuthority(input.authority),
    eq(reviewCheckouts.status, 'teardown-pending'),
    eq(reviewCheckouts.updatedAt, input.expectedUpdatedAt),
    isNull(reviewCheckouts.teardownReceipt),
  )).run();
  return changed.changes === 1 ? getReviewCheckoutById(input.authority.id, db) : null;
}

export function settleReviewCheckoutTeardown(
  input: SettleReviewCheckoutTeardownInput,
  db: DbExecutor = getDb(),
): ReviewCheckoutRow | null {
  if (!isReviewCheckoutAuthority(input.authority) ||
      !isReviewCheckoutTeardownReceipt(input.receipt) ||
      !isMatchingReviewCheckoutTeardown(input.authority, input.receipt) ||
      !Number.isSafeInteger(input.destroyedAt) ||
      input.destroyedAt < input.receipt.finishedAt) return null;
  const updatedAt = mutationTime(input.expectedUpdatedAt, input.destroyedAt);
  const changed = db.update(reviewCheckouts).set({
    status: 'destroyed',
    teardownReceipt: input.receipt,
    cleanupError: null,
    updatedAt,
    destroyedAt: updatedAt,
  }).where(and(
    exactReviewCheckoutAuthority(input.authority),
    eq(reviewCheckouts.status, 'teardown-pending'),
    eq(reviewCheckouts.updatedAt, input.expectedUpdatedAt),
    isNull(reviewCheckouts.teardownReceipt),
    isNull(reviewCheckouts.destroyedAt),
  )).run();
  return changed.changes === 1 ? getReviewCheckoutById(input.authority.id, db) : null;
}

export function listActiveWorktrees(): WorktreeRow[] {
  return getDb()
    .select()
    .from(worktrees)
    .where(eq(worktrees.status, 'active'))
    .all();
}

export function getActiveWorktreeByName(name: string): WorktreeRow | null {
  const row = getDb()
    .select()
    .from(worktrees)
    .where(and(eq(worktrees.name, name), eq(worktrees.status, 'active')))
    .get();
  return row ?? null;
}

export function getWorktreeById(
  id: ULID,
  db: DbExecutor = getDb(),
): WorktreeRow | null {
  return db.select().from(worktrees).where(eq(worktrees.id, id)).get() ?? null;
}

/** Exact contract-owned candidate. Ambiguity is unavailable: duplicate
 * active/stranded bindings prove no destructive authority. */
export function getWorktreeForContract(
  contractId: ULID,
  db: DbExecutor = getDb(),
): WorktreeRow | null {
  const rows = db.select().from(worktrees).where(and(
    eq(worktrees.contractId, contractId),
    inArray(worktrees.status, ['active', 'stranded']),
  )).limit(2).all();
  return rows.length === 1 ? rows[0]! : null;
}

/** Exact landed-cleanup binding. Unlike the ordinary mutation candidate this
 * also admits an already-destroyed row so recovery can finish the crash window
 * between exact row settlement and the producer lifecycle `completed` stamp.
 * More than one historical binding is ambiguous and grants no authority. */
export function getWorktreeForLandedContract(
  contractId: ULID,
  db: DbExecutor = getDb(),
): WorktreeRow | null {
  const rows = db.select().from(worktrees).where(and(
    eq(worktrees.contractId, contractId),
    inArray(worktrees.status, ['active', 'stranded', 'destroyed']),
  )).limit(2).all();
  return rows.length === 1 ? rows[0]! : null;
}

export interface UpsertWorktreeInput {
  name: string;
  path: string;
  /** Run-binding provenance (docs/worktree-lifecycle.md 'Ownership unit').
   *  Optional — legacy callers/rows stay NULL. contractId is usually stamped
   *  later via setWorktreeContractId (the contract is minted post-provision). */
  projectId?: ULID | null;
  agentRunId?: ULID | null;
  contractId?: ULID | null;
  branch?: string | null;
  baseBranch?: string | null;
  baseSha?: string | null;
}

/** Insert a new active worktree row, or no-op if one already exists with the
 *  same name + path. Used by the worktree service after `git worktree add` succeeds. */
export function upsertWorktree(input: UpsertWorktreeInput): WorktreeRow {
  const existing = getActiveWorktreeByName(input.name);
  if (existing && existing.path === input.path) return existing;
  // Different path or missing → mark any active row by name as destroyed first.
  if (existing) markWorktreeDestroyed(input.name);
  const now = Date.now();
  const row: WorktreeRow = {
    id: newId(),
    name: input.name,
    path: input.path,
    status: 'active',
    projectId: input.projectId ?? null,
    agentRunId: input.agentRunId ?? null,
    contractId: input.contractId ?? null,
    branch: input.branch ?? null,
    baseBranch: input.baseBranch ?? null,
    baseSha: input.baseSha ?? null,
    strandedReason: null,
    strandedAt: null,
    createdAt: now,
    destroyedAt: null,
  };
  getDb().insert(worktrees).values(row).run();
  return row;
}

/** Stamp the contract onto the active row (contract creation follows
 *  provisioning, so the upsert can't carry it). No-op if the row is gone. */
export function setWorktreeContractId(name: string, contractId: ULID): void {
  getDb()
    .update(worktrees)
    .set({ contractId })
    .where(and(eq(worktrees.name, name), eq(worktrees.status, 'active')))
    .run();
}

/** Destroy covers 'stranded' rows too: teardown of a previously stranded
 *  worktree (boot-stranded → re-accept → land) removes the directory — leaving
 *  the row 'stranded' would be a permanent false receipt no self-heal can fix
 *  (revive requires a live run that never exists post-landing). */
export function markWorktreeDestroyed(name: string): void {
  getDb()
    .update(worktrees)
    .set({ status: 'destroyed', destroyedAt: Date.now() })
    .where(and(eq(worktrees.name, name), inArray(worktrees.status, ['active', 'stranded'])))
    .run();
}

export interface MarkExactWorktreeDestroyedInput {
  id: ULID;
  projectId: ULID;
  agentRunId: ULID;
  contractId: ULID;
  path: string;
  name: string;
  branch: string;
  baseBranch: string;
  destroyedAt: number;
}

export interface MarkExactWorktreeSnapshotDestroyedInput {
  worktree: WorktreeRow;
  destroyedAt: number;
}

/** Generic teardown has no contract receipt, so it settles only the exact row
 * snapshot observed before filesystem mutation. Nullable legacy bindings are
 * compared as NULL, never widened into basename authority. */
export function markExactWorktreeSnapshotDestroyed(
  input: MarkExactWorktreeSnapshotDestroyedInput,
  db: DbExecutor = getDb(),
): boolean {
  const row = input.worktree;
  if (row.status !== 'active' && row.status !== 'stranded') return false;
  return db.update(worktrees).set({
    status: 'destroyed',
    destroyedAt: input.destroyedAt,
    strandedReason: null,
    strandedAt: null,
  }).where(and(
    eq(worktrees.id, row.id),
    eq(worktrees.path, row.path),
    eq(worktrees.name, row.name),
    eq(worktrees.createdAt, row.createdAt),
    row.projectId === null ? isNull(worktrees.projectId) : eq(worktrees.projectId, row.projectId),
    row.agentRunId === null ? isNull(worktrees.agentRunId) : eq(worktrees.agentRunId, row.agentRunId),
    row.contractId === null ? isNull(worktrees.contractId) : eq(worktrees.contractId, row.contractId),
    row.branch === null ? isNull(worktrees.branch) : eq(worktrees.branch, row.branch),
    row.baseBranch === null ? isNull(worktrees.baseBranch) : eq(worktrees.baseBranch, row.baseBranch),
    row.baseSha === null ? isNull(worktrees.baseSha) : eq(worktrees.baseSha, row.baseSha),
    eq(worktrees.status, row.status),
  )).run().changes === 1;
}

/** Receipt-backed abandonment settlement may destroy only the exact row the
 * authority named. Name/path inference and a differently rebound row fail. */
export function markExactWorktreeDestroyed(
  input: MarkExactWorktreeDestroyedInput,
  db: DbExecutor = getDb(),
): boolean {
  return db.update(worktrees).set({
    status: 'destroyed',
    destroyedAt: input.destroyedAt,
    strandedReason: null,
    strandedAt: null,
  }).where(and(
    eq(worktrees.id, input.id),
    eq(worktrees.projectId, input.projectId),
    eq(worktrees.agentRunId, input.agentRunId),
    eq(worktrees.contractId, input.contractId),
    eq(worktrees.path, input.path),
    eq(worktrees.name, input.name),
    eq(worktrees.branch, input.branch),
    eq(worktrees.baseBranch, input.baseBranch),
    inArray(worktrees.status, ['active', 'stranded']),
  )).run().changes === 1;
}

export interface MarkExactUnpublishedWorktreeDestroyedInput {
  id: ULID;
  projectId: ULID;
  agentRunId: ULID;
  path: string;
  name: string;
  branch: string;
  baseBranch: string;
  baseSha: string;
  destroyedAt: number;
}

/** Fresh-provision rollback may settle only its exact still-unpublished active
 * row. A historical stranded row with the same name, a contract binding, or
 * any ownership/base drift remains untouched and makes this CAS fail. */
export function markExactUnpublishedWorktreeDestroyed(
  input: MarkExactUnpublishedWorktreeDestroyedInput,
  db: DbExecutor = getDb(),
): boolean {
  return db.update(worktrees).set({
    status: 'destroyed',
    destroyedAt: input.destroyedAt,
    strandedReason: null,
    strandedAt: null,
  }).where(and(
    eq(worktrees.id, input.id),
    eq(worktrees.projectId, input.projectId),
    eq(worktrees.agentRunId, input.agentRunId),
    isNull(worktrees.contractId),
    eq(worktrees.path, input.path),
    eq(worktrees.name, input.name),
    eq(worktrees.branch, input.branch),
    eq(worktrees.baseBranch, input.baseBranch),
    eq(worktrees.baseSha, input.baseSha),
    eq(worktrees.status, 'active'),
  )).run().changes === 1;
}

// ── Durable stranded state (docs/worktree-lifecycle.md 'Recovery') ───────────

/** Flip an active row to durable 'stranded'. The dir/branch stay untouched —
 *  reclamation remains a human/orchestrator decision. */
export function markWorktreeStranded(name: string, reason: WorktreeStrandedReason, at = Date.now()): void {
  getDb()
    .update(worktrees)
    .set({ status: 'stranded', strandedReason: reason, strandedAt: at })
    .where(and(eq(worktrees.name, name), eq(worktrees.status, 'active')))
    .run();
}

/** Self-heal: a re-scan that no longer finds the row stranded flips it back to
 *  active, clearing the stranded stamp. Refuses (returns false) when another
 *  active row already holds the name or path — the partial unique indexes on
 *  active name/path must never be violated by a revive. */
export function reviveStrandedWorktree(id: ULID): boolean {
  const db = getDb();
  const row = db.select().from(worktrees).where(eq(worktrees.id, id)).get();
  if (!row || row.status !== 'stranded') return false;
  const nameTaken = db
    .select({ id: worktrees.id })
    .from(worktrees)
    .where(and(eq(worktrees.name, row.name), eq(worktrees.status, 'active')))
    .get();
  const pathTaken = db
    .select({ id: worktrees.id })
    .from(worktrees)
    .where(and(eq(worktrees.path, row.path), eq(worktrees.status, 'active')))
    .get();
  if (nameTaken || pathTaken) return false;
  db.update(worktrees)
    .set({ status: 'active', strandedReason: null, strandedAt: null })
    .where(and(eq(worktrees.id, id), eq(worktrees.status, 'stranded')))
    .run();
  return true;
}

/** Stranded rows — the boot scan's durable output; the HTTP surface reads it.
 *  Legacy rows (NULL projectId) only appear in the unfiltered list. */
export function listStrandedWorktrees(projectId?: ULID): WorktreeRow[] {
  const where = projectId
    ? and(eq(worktrees.status, 'stranded'), eq(worktrees.projectId, projectId))
    : eq(worktrees.status, 'stranded');
  return getDb().select().from(worktrees).where(where).all();
}
