import { and, eq, inArray } from 'drizzle-orm';
import type { ULID, Worktree, WorktreeStrandedReason } from '@pc/domain';
import { getDb } from '../connection.ts';
import { newId } from '../id.ts';
import { worktrees } from '../schema.ts';

/** Persisted worktree shape — the domain `Worktree` type, verbatim. */
export type WorktreeRow = Worktree;

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
