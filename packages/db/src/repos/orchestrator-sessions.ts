// Runtime-session persistence for orchestrator app sessions.
//
// A newly created row owns one complete immutable runtime selection. Its
// adapter-native identity starts unbound and can be bound exactly once by a
// positive RuntimeSessionReceipt. Migrated provider-shaped rows remain
// explicit legacy evidence and can never be resumed or silently defaulted.

import { and, desc, eq, isNull } from 'drizzle-orm';
import {
  isRuntimeSelection,
  isRuntimeSessionReceipt,
  runtimeSelectionsEqual,
  type RuntimeSelection,
  type RuntimeSessionReceipt,
} from '@pc/contracts';
import type { SessionEndedReason, SessionStatus, ULID } from '@pc/domain';
import { getDb } from '../connection.ts';
import { newId } from '../id.ts';
import { orchestratorSessions } from '../schema.ts';

export type OrchestratorSessionSelectionState = 'stamped' | 'legacy-unavailable';
export type OrchestratorSessionEffortState =
  | 'selected'
  | 'none'
  | 'unavailable'
  | 'legacy-unknown';
export type OrchestratorSessionNativeIdentityState =
  | 'unbound'
  | 'bound'
  | 'legacy-untrusted';
export type OrchestratorSessionContinuationState =
  | 'clean-pending'
  | 'clean-started'
  | 'resume-pending'
  | 'native-resumed'
  | 'resume-failed'
  | 'legacy-unavailable';

export interface OrchestratorSessionRow {
  id: ULID;
  projectId: ULID;
  selectionState: OrchestratorSessionSelectionState;
  runtimeId: string | null;
  accountId: string | null;
  model: string | null;
  effortState: OrchestratorSessionEffortState;
  effort: string | null;
  nativeSessionId: string | null;
  nativeIdentityState: OrchestratorSessionNativeIdentityState;
  continuationState: OrchestratorSessionContinuationState;
  continuationAttemptId: string | null;
  title: string | null;
  status: SessionStatus;
  endedReason: SessionEndedReason | null;
  startedAt: number;
  endedAt: number | null;
  deletedAt: number | null;
}

interface FlattenedSelection {
  selectionState: 'stamped';
  runtimeId: string;
  accountId: string;
  model: string;
  effortState: 'selected' | 'none' | 'unavailable';
  effort: string | null;
}

function nonEmpty(value: string, field: string): string {
  if (!value.trim() || value !== value.trim()) {
    throw new Error(`${field} must be an exact non-empty value`);
  }
  return value;
}

function flattenSelection(selection: RuntimeSelection): FlattenedSelection {
  if (!isRuntimeSelection(selection)) {
    throw new Error('runtime selection must be an exact complete selection');
  }
  const base = {
    selectionState: 'stamped' as const,
    runtimeId: nonEmpty(selection.runtimeId, 'runtimeId'),
    accountId: nonEmpty(selection.accountId, 'accountId'),
    model: nonEmpty(selection.model, 'model'),
  };
  switch (selection.effort.kind) {
    case 'selected':
      return {
        ...base,
        effortState: 'selected',
        effort: nonEmpty(selection.effort.value, 'effort.value'),
      };
    case 'none':
      return { ...base, effortState: 'none', effort: null };
    case 'unavailable':
      return { ...base, effortState: 'unavailable', effort: null };
  }
}

export function runtimeSelectionForSession(
  row: OrchestratorSessionRow,
): RuntimeSelection | null {
  if (
    row.selectionState !== 'stamped' ||
    !row.runtimeId || !row.accountId || !row.model ||
    row.effortState === 'legacy-unknown'
  ) return null;
  const effort = row.effortState === 'selected'
    ? row.effort
      ? { kind: 'selected' as const, value: row.effort }
      : null
    : { kind: row.effortState } as const;
  if (!effort) return null;
  return {
    runtimeId: row.runtimeId,
    accountId: row.accountId,
    model: row.model,
    effort,
  };
}

function sameSelection(row: OrchestratorSessionRow, selection: RuntimeSelection): boolean {
  const persisted = runtimeSelectionForSession(row);
  return persisted !== null && runtimeSelectionsEqual(persisted, selection);
}

function toDomain(row: OrchestratorSessionRow): OrchestratorSessionRow {
  return { ...row };
}

export interface CreateOrchestratorSessionInput {
  projectId: ULID;
  selection: RuntimeSelection;
  title?: string | null;
  now?: number;
}

export function newStampedOrchestratorSession(
  input: CreateOrchestratorSessionInput,
): OrchestratorSessionRow {
  const stamp = flattenSelection(input.selection);
  return {
    id: newId(),
    projectId: input.projectId,
    ...stamp,
    nativeSessionId: null,
    nativeIdentityState: 'unbound',
    continuationState: 'clean-pending',
    continuationAttemptId: newId(),
    title: input.title ?? null,
    status: 'active',
    endedReason: null,
    startedAt: input.now ?? Date.now(),
    endedAt: null,
    deletedAt: null,
  };
}

export function createOrchestratorSession(
  input: CreateOrchestratorSessionInput,
): OrchestratorSessionRow {
  const session = newStampedOrchestratorSession(input);
  getDb().insert(orchestratorSessions).values(session).run();
  return session;
}

export function getOrchestratorSession(id: ULID): OrchestratorSessionRow | null {
  const row = getDb()
    .select()
    .from(orchestratorSessions)
    .where(and(eq(orchestratorSessions.id, id), isNull(orchestratorSessions.deletedAt)))
    .get() as OrchestratorSessionRow | undefined;
  return row ? toDomain(row) : null;
}

export function getActiveOrchestratorSession(projectId: ULID): OrchestratorSessionRow | null {
  const row = getDb()
    .select()
    .from(orchestratorSessions)
    .where(and(
      eq(orchestratorSessions.projectId, projectId),
      eq(orchestratorSessions.status, 'active'),
      isNull(orchestratorSessions.deletedAt),
    ))
    .get() as OrchestratorSessionRow | undefined;
  return row ? toDomain(row) : null;
}

export function listOrchestratorSessionsForProject(
  projectId: ULID,
): OrchestratorSessionRow[] {
  const rows = getDb()
    .select()
    .from(orchestratorSessions)
    .where(and(
      eq(orchestratorSessions.projectId, projectId),
      isNull(orchestratorSessions.deletedAt),
    ))
    .orderBy(desc(orchestratorSessions.startedAt))
    .all() as OrchestratorSessionRow[];
  return rows.map(toDomain);
}

export function endOrchestratorSession(
  id: ULID,
  reason: SessionEndedReason,
): OrchestratorSessionRow | null {
  const now = Date.now();
  getDb()
    .update(orchestratorSessions)
    .set({ status: 'ended', endedReason: reason, endedAt: now })
    .where(eq(orchestratorSessions.id, id))
    .run();
  return getOrchestratorSession(id);
}

export type RuntimeSessionReceiptRejection =
  | 'not-found'
  | 'session-inactive'
  | 'legacy-unavailable'
  | 'malformed-receipt'
  | 'selection-mismatch'
  | 'continuation-attempt-mismatch'
  | 'empty-native-session-id'
  | 'receipt-mode-mismatch'
  | 'native-session-id-conflict'
  | 'continuation-state-conflict';

export type ConfirmRuntimeSessionReceiptResult =
  | { status: 'confirmed'; duplicate: boolean; session: OrchestratorSessionRow }
  | { status: 'rejected'; reason: RuntimeSessionReceiptRejection };

export interface ConfirmRuntimeSessionReceiptInput {
  sessionId: ULID;
  receipt: RuntimeSessionReceipt;
}

/** Bind or confirm an adapter-native identity from one exact positive receipt.
 * Matching redelivery is idempotent. Empty, conflicting, wrong-mode, late, or
 * differently selected receipts write nothing. */
export function confirmRuntimeSessionReceipt(
  input: ConfirmRuntimeSessionReceiptInput,
): ConfirmRuntimeSessionReceiptResult {
  return getDb().transaction((tx) => {
    const row = tx.select().from(orchestratorSessions)
      .where(and(
        eq(orchestratorSessions.id, input.sessionId),
        isNull(orchestratorSessions.deletedAt),
      ))
      .get() as OrchestratorSessionRow | undefined;
    if (!row) return { status: 'rejected', reason: 'not-found' };
    if (row.status !== 'active') {
      return { status: 'rejected', reason: 'session-inactive' };
    }
    if (row.selectionState !== 'stamped') {
      return { status: 'rejected', reason: 'legacy-unavailable' };
    }
    if (!isRuntimeSessionReceipt(input.receipt)) {
      return { status: 'rejected', reason: 'malformed-receipt' };
    }
    if (!sameSelection(row, input.receipt.selection)) {
      return { status: 'rejected', reason: 'selection-mismatch' };
    }
    if (row.continuationAttemptId !== input.receipt.continuationAttemptId) {
      return { status: 'rejected', reason: 'continuation-attempt-mismatch' };
    }
    const nativeSessionId = input.receipt.nativeSessionId;

    if (input.receipt.mode === 'created') {
      if (input.receipt.requestedNativeSessionId !== null) {
        return { status: 'rejected', reason: 'receipt-mode-mismatch' };
      }
      if (
        row.nativeIdentityState === 'bound' &&
        row.nativeSessionId === nativeSessionId &&
        row.continuationState === 'clean-started'
      ) {
        return { status: 'confirmed', duplicate: true, session: row };
      }
      if (row.nativeIdentityState === 'bound' && row.nativeSessionId !== nativeSessionId) {
        return { status: 'rejected', reason: 'native-session-id-conflict' };
      }
      if (
        row.nativeIdentityState !== 'unbound' ||
        row.nativeSessionId !== null ||
        row.continuationState !== 'clean-pending'
      ) {
        return { status: 'rejected', reason: 'continuation-state-conflict' };
      }
      const bound = tx.update(orchestratorSessions).set({
        nativeSessionId,
        nativeIdentityState: 'bound',
        continuationState: 'clean-started',
      }).where(and(
        eq(orchestratorSessions.id, row.id),
        eq(orchestratorSessions.status, 'active'),
        eq(orchestratorSessions.selectionState, 'stamped'),
        eq(orchestratorSessions.continuationAttemptId, input.receipt.continuationAttemptId),
        eq(orchestratorSessions.nativeIdentityState, 'unbound'),
        eq(orchestratorSessions.continuationState, 'clean-pending'),
        isNull(orchestratorSessions.nativeSessionId),
        isNull(orchestratorSessions.deletedAt),
      )).run();
      if (bound.changes !== 1) {
        return { status: 'rejected', reason: 'continuation-state-conflict' };
      }
    } else {
      const requested = input.receipt.requestedNativeSessionId ?? '';
      if (!requested || requested !== nativeSessionId) {
        return { status: 'rejected', reason: 'receipt-mode-mismatch' };
      }
      if (row.nativeIdentityState !== 'bound' || row.nativeSessionId !== nativeSessionId) {
        return { status: 'rejected', reason: 'native-session-id-conflict' };
      }
      if (row.continuationState === 'native-resumed') {
        return { status: 'confirmed', duplicate: true, session: row };
      }
      if (row.continuationState !== 'resume-pending') {
        return { status: 'rejected', reason: 'continuation-state-conflict' };
      }
      const resumed = tx.update(orchestratorSessions)
        .set({ continuationState: 'native-resumed' })
        .where(and(
          eq(orchestratorSessions.id, row.id),
          eq(orchestratorSessions.status, 'active'),
          eq(orchestratorSessions.selectionState, 'stamped'),
          eq(orchestratorSessions.continuationAttemptId, input.receipt.continuationAttemptId),
          eq(orchestratorSessions.nativeIdentityState, 'bound'),
          eq(orchestratorSessions.nativeSessionId, nativeSessionId),
          eq(orchestratorSessions.continuationState, 'resume-pending'),
          isNull(orchestratorSessions.deletedAt),
        ))
        .run();
      if (resumed.changes !== 1) {
        return { status: 'rejected', reason: 'continuation-state-conflict' };
      }
    }

    const confirmed = tx.select().from(orchestratorSessions)
      .where(eq(orchestratorSessions.id, row.id))
      .get() as OrchestratorSessionRow | undefined;
    return confirmed
      ? { status: 'confirmed', duplicate: false, session: toDomain(confirmed) }
      : { status: 'rejected', reason: 'not-found' };
  });
}

export function isOrchestratorSessionResumeReady(row: OrchestratorSessionRow): boolean {
  return (
    row.selectionState === 'stamped' &&
    runtimeSelectionForSession(row) !== null &&
    row.nativeIdentityState === 'bound' &&
    typeof row.nativeSessionId === 'string' &&
    row.nativeSessionId.trim().length > 0 &&
    (
      row.continuationState === 'clean-started' ||
      row.continuationState === 'resume-pending' ||
      row.continuationState === 'native-resumed' ||
      row.continuationState === 'resume-failed'
    ) &&
    typeof row.continuationAttemptId === 'string' &&
    row.continuationAttemptId.trim().length > 0
  );
}

function freshAttemptId(previous: string): ULID {
  let attemptId = newId();
  while (attemptId === previous) attemptId = newId();
  return attemptId;
}

/** Fence an unbound clean create immediately before a provider mint. Calling
 * this again after a crash rotates the generation and makes the older create
 * receipt harmless. */
export function prepareRuntimeSessionCreate(id: ULID): OrchestratorSessionRow | null {
  return getDb().transaction((tx) => {
    const row = tx.select().from(orchestratorSessions)
      .where(and(
        eq(orchestratorSessions.id, id),
        eq(orchestratorSessions.status, 'active'),
        isNull(orchestratorSessions.deletedAt),
      ))
      .get() as OrchestratorSessionRow | undefined;
    if (
      !row ||
      row.selectionState !== 'stamped' ||
      runtimeSelectionForSession(row) === null ||
      row.nativeIdentityState !== 'unbound' ||
      row.nativeSessionId !== null ||
      row.continuationState !== 'clean-pending' ||
      typeof row.continuationAttemptId !== 'string' ||
      row.continuationAttemptId.trim().length === 0
    ) return null;
    const continuationAttemptId = freshAttemptId(row.continuationAttemptId);
    const prepared = tx.update(orchestratorSessions)
      .set({ continuationAttemptId })
      .where(and(
        eq(orchestratorSessions.id, row.id),
        eq(orchestratorSessions.status, 'active'),
        eq(orchestratorSessions.selectionState, 'stamped'),
        eq(orchestratorSessions.nativeIdentityState, 'unbound'),
        eq(orchestratorSessions.continuationState, 'clean-pending'),
        eq(orchestratorSessions.continuationAttemptId, row.continuationAttemptId),
        isNull(orchestratorSessions.nativeSessionId),
        isNull(orchestratorSessions.deletedAt),
      ))
      .run();
    if (prepared.changes !== 1) return null;
    return { ...row, continuationAttemptId };
  });
}

/** Mark an already-active stamped session before any adapter resume attempt
 * (including an inherited pending attempt). Historical activation performs
 * an earlier fence in its larger Conversation-owned transition; this rotates
 * once more immediately before the actual provider mint. */
export function prepareRuntimeSessionResume(id: ULID): OrchestratorSessionRow | null {
  return getDb().transaction((tx) => {
    const row = tx.select().from(orchestratorSessions)
      .where(and(
        eq(orchestratorSessions.id, id),
        eq(orchestratorSessions.status, 'active'),
        isNull(orchestratorSessions.deletedAt),
      ))
      .get() as OrchestratorSessionRow | undefined;
    if (!row || !isOrchestratorSessionResumeReady(row)) return null;
    const continuationAttemptId = freshAttemptId(row.continuationAttemptId!);
    const prepared = tx.update(orchestratorSessions)
      .set({ continuationState: 'resume-pending', continuationAttemptId })
      .where(and(
        eq(orchestratorSessions.id, row.id),
        eq(orchestratorSessions.status, 'active'),
        eq(orchestratorSessions.selectionState, 'stamped'),
        eq(orchestratorSessions.nativeIdentityState, 'bound'),
        eq(orchestratorSessions.nativeSessionId, row.nativeSessionId!),
        eq(orchestratorSessions.continuationState, row.continuationState),
        eq(orchestratorSessions.continuationAttemptId, row.continuationAttemptId!),
        isNull(orchestratorSessions.deletedAt),
      ))
      .run();
    if (prepared.changes !== 1) return null;
    return {
      ...row,
      continuationState: 'resume-pending',
      continuationAttemptId,
    };
  });
}

export function failRuntimeSessionResume(id: ULID, continuationAttemptId: string): boolean {
  if (typeof continuationAttemptId !== 'string' || !continuationAttemptId.trim()) return false;
  return getDb().transaction((tx) => {
    const current = tx.select({
      continuationState: orchestratorSessions.continuationState,
      continuationAttemptId: orchestratorSessions.continuationAttemptId,
      status: orchestratorSessions.status,
    })
      .from(orchestratorSessions)
      .where(eq(orchestratorSessions.id, id))
      .get();
    if (
      current?.status !== 'active' ||
      current.continuationState !== 'resume-pending' ||
      current.continuationAttemptId !== continuationAttemptId
    ) return false;
    const failed = tx.update(orchestratorSessions)
      .set({ continuationState: 'resume-failed' })
      .where(and(
        eq(orchestratorSessions.id, id),
        eq(orchestratorSessions.status, 'active'),
        eq(orchestratorSessions.continuationState, 'resume-pending'),
        eq(orchestratorSessions.continuationAttemptId, continuationAttemptId),
        isNull(orchestratorSessions.deletedAt),
      ))
      .run();
    return failed.changes === 1;
  });
}

/** Set or update the title. Caller decides when. */
export function setOrchestratorSessionTitle(id: ULID, title: string): void {
  getDb().update(orchestratorSessions).set({ title }).where(eq(orchestratorSessions.id, id)).run();
}
