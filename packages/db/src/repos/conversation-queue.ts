// Conversation-owned durable send queue and turn-control unit of work.
// Every state transition below commits with its canonical event/outbox rows.

import { createHash } from 'node:crypto';
import { and, asc, eq, inArray, isNull, or, sql } from 'drizzle-orm';
import {
  conversationFamilyForEvent,
  isQueuedAgentEnvelope,
  type ChatEvent,
  type ConversationCommandError,
  type ConversationCommandKind,
  type ConversationCommandStatus,
  type InterruptReplacement,
  type QueuedAgentEnvelope,
  type SendQueueItem,
  type SendQueueItemOrigin,
  type SendQueueItemStatus,
} from '@pc/contracts';
import type { Project, ProjectSettings, SessionEndedReason, ULID } from '@pc/domain';

import { getDb, type DbExecutor, type DbTransaction } from '../connection.ts';
import { newId } from '../id.ts';
import {
  conversationCommands,
  conversationQueueHeads,
  conversationQueueItems,
  conversationQueueRevisions,
  conversationTurns,
  orchestratorSessions,
  projects,
  turnInterruptRequests,
} from '../schema.ts';
import { commitConversationEventInDb } from './conversation-events.ts';
import type { OrchestratorSessionRow } from './orchestrator-sessions.ts';
import {
  getProjectByIdInDb,
  softDeleteProjectInDb,
  updateProjectMetaInDb,
} from './projects.ts';

export type ConversationQueueItemRow = typeof conversationQueueItems.$inferSelect;
export type ConversationQueueRevisionRow = typeof conversationQueueRevisions.$inferSelect;
export type ConversationTurnRow = typeof conversationTurns.$inferSelect;
export type TurnInterruptRequestRow = typeof turnInterruptRequests.$inferSelect;

export interface ConversationCommandResult {
  status: ConversationCommandStatus;
  sessionId: string | null;
  queueItemId?: string;
  revision?: number;
  interruptRequestId?: string;
  error: ConversationCommandError | null;
}

export interface EnqueueConversationSendInput {
  projectId: ULID;
  conversationId: string;
  sessionId: string;
  commandId: string;
  clientMessageId: string;
  text: string;
  origin: SendQueueItemOrigin;
  agentEnvelope?: QueuedAgentEnvelope;
  now?: number;
}

export interface EditQueuedConversationSendInput {
  projectId: ULID;
  sessionId: string;
  commandId: string;
  queueItemId: string;
  expectedRevision: number;
  text: string;
  now?: number;
}

export interface RemoveQueuedConversationSendInput {
  projectId: ULID;
  sessionId: string;
  commandId: string;
  queueItemId: string;
  expectedRevision: number;
  now?: number;
}

export interface ClaimedConversationTurn {
  projectId: ULID;
  conversationId: string;
  sessionId: string;
  queueItemId: ULID;
  turnId: string;
  clientMessageId: string;
  text: string;
  origin: SendQueueItemOrigin;
  agentEnvelope?: QueuedAgentEnvelope;
  deliveryRevision: number;
}

export interface RequestConversationInterruptInput {
  projectId: ULID;
  conversationId: string;
  sessionId: string;
  requestId: string;
  targetTurnId: string;
  replacement?: InterruptReplacement;
  now?: number;
}

export interface SettleConversationTurnInput {
  turnId: string;
  terminalEvent: Extract<ChatEvent, { kind: 'turn-end' | 'turn-failed' }>;
  terminalOutcome: 'completed' | 'turn-failed' | 'aborted' | 'recovered';
  queueStatus: 'accepted' | 'failed';
  queueFailureReason?: string | null;
  now?: number;
}

export interface ReplaceOrchestratorSessionInput {
  projectId: ULID;
  expectedSessionId: ULID | null;
  queueCancellationReason: string;
  endedReason?: SessionEndedReason;
  settingsPatch?: Partial<ProjectSettings>;
  /** Account changes invalidate native continuation for every prior session
   * until immutable runtime/account stamps land. */
  invalidatePriorSessions?: boolean;
  now?: number;
}

export interface ReplaceOrchestratorSessionResult {
  session: OrchestratorSessionRow;
  cancelledQueueItemIds: ULID[];
}

export interface ResumeOrchestratorSessionInput {
  projectId: ULID;
  expectedSessionId: ULID | null;
  targetSessionId: ULID;
  queueCancellationReason: string;
  now?: number;
}

export type SoftDeleteProjectConversationResult =
  | { status: 'deleted'; project: Project; cancelledQueueItemIds: ULID[] }
  | { status: 'not-found' }
  | { status: 'active-turn' };

interface QueueContext {
  projectId: ULID;
  conversationId: string;
  sessionId: string;
}

interface RevisionValue {
  text: string;
  agentEnvelope: QueuedAgentEnvelope | null;
}

function fingerprint(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex');
}

function commandResultFromRow(
  row: typeof conversationCommands.$inferSelect,
  expectedKind: ConversationCommandKind,
  expectedFingerprint: string,
): ConversationCommandResult {
  if (row.commandKind !== expectedKind || row.fingerprint !== expectedFingerprint) {
    return {
      status: 'rejected',
      sessionId: row.sessionId,
      error: {
        code: 'idempotency-conflict',
        message: `command id ${row.commandId} was already used for different input`,
      },
    };
  }
  return {
    status: row.status === 'rejected' ? 'rejected' : 'duplicate',
    sessionId: row.sessionId,
    ...(row.queueItemId ? { queueItemId: row.queueItemId } : {}),
    ...(row.revision !== null ? { revision: row.revision } : {}),
    ...(row.interruptRequestId ? { interruptRequestId: row.interruptRequestId } : {}),
    error: row.errorCode
      ? {
          code: row.errorCode as ConversationCommandError['code'],
          message: row.errorMessage ?? '',
          ...(row.currentRevision !== null ? { currentRevision: row.currentRevision } : {}),
        }
      : null,
  };
}

function priorCommand(
  tx: DbTransaction,
  commandId: string,
  kind: ConversationCommandKind,
  commandFingerprint: string,
): ConversationCommandResult | null {
  const row = tx
    .select()
    .from(conversationCommands)
    .where(eq(conversationCommands.commandId, commandId))
    .get();
  return row ? commandResultFromRow(row, kind, commandFingerprint) : null;
}

function storeCommand(
  tx: DbTransaction,
  input: {
    commandId: string;
    projectId: ULID;
    sessionId: string | null;
    commandKind: ConversationCommandKind;
    commandFingerprint: string;
    status: 'applied' | 'rejected';
    queueItemId?: string | null;
    revision?: number | null;
    interruptRequestId?: string | null;
    error?: ConversationCommandError | null;
    now: number;
  },
): void {
  tx.insert(conversationCommands).values({
    commandId: input.commandId,
    projectId: input.projectId,
    sessionId: input.sessionId,
    commandKind: input.commandKind,
    fingerprint: input.commandFingerprint,
    status: input.status,
    queueItemId: (input.queueItemId as ULID | undefined) ?? null,
    revision: input.revision ?? null,
    interruptRequestId: input.interruptRequestId ?? null,
    errorCode: input.error?.code ?? null,
    errorMessage: input.error?.message ?? null,
    currentRevision: input.error?.currentRevision ?? null,
    createdAt: input.now,
  }).run();
}

function rejected(
  tx: DbTransaction,
  input: {
    commandId: string;
    projectId: ULID;
    sessionId: string | null;
    commandKind: ConversationCommandKind;
    commandFingerprint: string;
    error: ConversationCommandError;
    queueItemId?: string | null;
    revision?: number | null;
    interruptRequestId?: string | null;
    now: number;
  },
): ConversationCommandResult {
  storeCommand(tx, { ...input, status: 'rejected' });
  return {
    status: 'rejected',
    sessionId: input.sessionId,
    ...(input.queueItemId ? { queueItemId: input.queueItemId } : {}),
    ...(input.revision !== undefined && input.revision !== null ? { revision: input.revision } : {}),
    ...(input.interruptRequestId ? { interruptRequestId: input.interruptRequestId } : {}),
    error: input.error,
  };
}

function activeSession(tx: DbTransaction, context: QueueContext): boolean {
  // CF-001 binds one app session to one conversation. Keep that identity
  // fail-closed here so a malformed command cannot allocate a second cursor
  // and publish queue events under an unrelated conversation.
  if (context.conversationId !== context.sessionId) return false;
  if (!liveProject(tx, context.projectId)) return false;
  const session = tx
    .select({
      projectId: orchestratorSessions.projectId,
      status: orchestratorSessions.status,
      deletedAt: orchestratorSessions.deletedAt,
    })
    .from(orchestratorSessions)
    .where(eq(orchestratorSessions.id, context.sessionId as ULID))
    .get();
  return session?.projectId === context.projectId && session.status === 'active' && session.deletedAt === null;
}

function liveProject(tx: DbExecutor, projectId: ULID): boolean {
  return Boolean(tx
    .select({ id: projects.id })
    .from(projects)
    .where(and(eq(projects.id, projectId), isNull(projects.deletedAt)))
    .get());
}

function allocateQueuePosition(
  tx: DbTransaction,
  context: QueueContext,
  now: number,
): { enqueuePosition: number; queueRevision: number } {
  const head = tx
    .insert(conversationQueueHeads)
    .values({
      sessionId: context.sessionId,
      projectId: context.projectId,
      conversationId: context.conversationId,
      nextPosition: 2,
      queueRevision: 1,
      updatedAt: now,
    })
    .onConflictDoUpdate({
      target: conversationQueueHeads.sessionId,
      set: {
        nextPosition: sql`${conversationQueueHeads.nextPosition} + 1`,
        queueRevision: sql`${conversationQueueHeads.queueRevision} + 1`,
        updatedAt: now,
      },
    })
    .returning({
      projectId: conversationQueueHeads.projectId,
      conversationId: conversationQueueHeads.conversationId,
      nextPosition: conversationQueueHeads.nextPosition,
      queueRevision: conversationQueueHeads.queueRevision,
    })
    .get();
  if (!head) throw new Error(`queue head allocation failed: ${context.sessionId}`);
  if (head.projectId !== context.projectId || head.conversationId !== context.conversationId) {
    throw new Error(`queue head identity mismatch: ${context.sessionId}`);
  }
  return { enqueuePosition: head.nextPosition - 1, queueRevision: head.queueRevision };
}

function bumpQueueRevision(tx: DbTransaction, context: QueueContext, now: number): number {
  const head = tx
    .insert(conversationQueueHeads)
    .values({
      sessionId: context.sessionId,
      projectId: context.projectId,
      conversationId: context.conversationId,
      nextPosition: 1,
      queueRevision: 1,
      updatedAt: now,
    })
    .onConflictDoUpdate({
      target: conversationQueueHeads.sessionId,
      set: {
        queueRevision: sql`${conversationQueueHeads.queueRevision} + 1`,
        updatedAt: now,
      },
    })
    .returning({
      projectId: conversationQueueHeads.projectId,
      conversationId: conversationQueueHeads.conversationId,
      queueRevision: conversationQueueHeads.queueRevision,
    })
    .get();
  if (!head) throw new Error(`queue revision allocation failed: ${context.sessionId}`);
  if (head.projectId !== context.projectId || head.conversationId !== context.conversationId) {
    throw new Error(`queue head identity mismatch: ${context.sessionId}`);
  }
  return head.queueRevision;
}

function parseRevision(row: ConversationQueueRevisionRow): RevisionValue {
  const agentEnvelope = row.agentEnvelope === null
    ? null
    : isQueuedAgentEnvelope(row.agentEnvelope)
      ? row.agentEnvelope
      : null;
  return { text: row.text, agentEnvelope };
}

function revisionFor(
  tx: DbExecutor,
  itemId: string,
  revision: number,
): ConversationQueueRevisionRow {
  const row = tx
    .select()
    .from(conversationQueueRevisions)
    .where(and(
      eq(conversationQueueRevisions.queueItemId, itemId as ULID),
      eq(conversationQueueRevisions.revision, revision),
    ))
    .get();
  if (!row) throw new Error(`missing queue revision ${itemId}@${revision}`);
  return row;
}

function displayText(row: ConversationQueueItemRow, revision: RevisionValue): string {
  if (row.origin === 'user') return revision.text;
  const envelope = revision.agentEnvelope;
  if (!envelope) return 'Agent update';
  return envelope.summary || `Agent update from ${envelope.agentName}`;
}

function toPublicItem(
  row: ConversationQueueItemRow,
  revision: ConversationQueueRevisionRow,
): SendQueueItem {
  const parsed = parseRevision(revision);
  return {
    id: row.id,
    clientMessageId: row.clientMessageId,
    origin: row.origin,
    enqueuePosition: row.enqueuePosition,
    revision: row.currentRevision,
    deliveryRevision: row.deliveryRevision,
    text: displayText(row, parsed),
    status: row.status,
    interruptRequestId: row.interruptRequestId,
    failureReason: row.failureReason,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

function appendEvent(
  tx: DbTransaction,
  context: QueueContext,
  event: ChatEvent,
  opts: {
    itemId: string;
    turnId?: string | null;
    clientMessageId?: string | null;
    eventId?: string;
    now: number;
  },
) {
  return commitConversationEventInDb({
    eventId: opts.eventId,
    projectId: context.projectId,
    conversationId: context.conversationId,
    sessionId: context.sessionId,
    family: conversationFamilyForEvent(event),
    event,
    turnId: opts.turnId ?? null,
    itemId: opts.itemId,
    clientMessageId: opts.clientMessageId ?? null,
    occurredAt: opts.now,
    deliveryKind: 'chat',
  }, tx);
}

function emitQueueState(
  tx: DbTransaction,
  context: QueueContext,
  row: ConversationQueueItemRow,
  revision: ConversationQueueRevisionRow,
  queueRevision: number,
  now: number,
): void {
  appendEvent(tx, context, {
    kind: 'send-state',
    queueRevision,
    item: toPublicItem(row, revision),
  }, {
    itemId: row.id,
    clientMessageId: row.clientMessageId,
    now,
  });
}

function insertQueueItem(
  tx: DbTransaction,
  input: {
    context: QueueContext;
    clientMessageId: string;
    text: string;
    origin: SendQueueItemOrigin;
    agentEnvelope?: QueuedAgentEnvelope;
    interruptRequestId?: string | null;
    now: number;
  },
): { row: ConversationQueueItemRow; revision: ConversationQueueRevisionRow; queueRevision: number } {
  const allocated = allocateQueuePosition(tx, input.context, input.now);
  const id = newId();
  const row: ConversationQueueItemRow = {
    id,
    turnId: newId(),
    projectId: input.context.projectId,
    conversationId: input.context.conversationId,
    sessionId: input.context.sessionId,
    clientMessageId: input.clientMessageId,
    origin: input.origin,
    status: 'queued',
    enqueuePosition: allocated.enqueuePosition,
    currentRevision: 1,
    deliveryRevision: null,
    interruptRequestId: input.interruptRequestId ?? null,
    failureReason: null,
    createdAt: input.now,
    updatedAt: input.now,
  };
  const revision: ConversationQueueRevisionRow = {
    queueItemId: id,
    revision: 1,
    text: input.text,
    agentEnvelope: input.agentEnvelope ?? null,
    createdAt: input.now,
  };
  tx.insert(conversationQueueItems).values(row).run();
  tx.insert(conversationQueueRevisions).values(revision).run();
  emitQueueState(tx, input.context, row, revision, allocated.queueRevision, input.now);
  return { row, revision, queueRevision: allocated.queueRevision };
}

export function enqueueConversationSend(
  input: EnqueueConversationSendInput,
): ConversationCommandResult {
  const now = input.now ?? Date.now();
  const kind: ConversationCommandKind = 'send';
  const commandFingerprint = fingerprint({
    kind,
    sessionId: input.sessionId,
    clientMessageId: input.clientMessageId,
    text: input.text,
    origin: input.origin,
    agentEnvelope: input.agentEnvelope ?? null,
  });
  return getDb().transaction((tx) => {
    const prior = priorCommand(tx, input.commandId, kind, commandFingerprint);
    if (prior) return prior;
    const context: QueueContext = input;
    if (!activeSession(tx, context)) {
      return rejected(tx, {
        commandId: input.commandId,
        projectId: input.projectId,
        sessionId: input.sessionId,
        commandKind: kind,
        commandFingerprint,
        error: { code: 'session-changed', message: 'the target session is not active' },
        now,
      });
    }
    if (!input.text.trim()) {
      return rejected(tx, {
        commandId: input.commandId,
        projectId: input.projectId,
        sessionId: input.sessionId,
        commandKind: kind,
        commandFingerprint,
        error: { code: 'invalid', message: 'message text must be non-empty' },
        now,
      });
    }
    if (input.origin === 'agent-envelope' && !isQueuedAgentEnvelope(input.agentEnvelope)) {
      return rejected(tx, {
        commandId: input.commandId,
        projectId: input.projectId,
        sessionId: input.sessionId,
        commandKind: kind,
        commandFingerprint,
        error: { code: 'invalid', message: 'valid agent-envelope metadata is required' },
        now,
      });
    }
    if (input.origin === 'user' && input.agentEnvelope !== undefined) {
      return rejected(tx, {
        commandId: input.commandId,
        projectId: input.projectId,
        sessionId: input.sessionId,
        commandKind: kind,
        commandFingerprint,
        error: { code: 'invalid', message: 'user messages cannot carry agent-envelope metadata' },
        now,
      });
    }
    const existing = tx
      .select()
      .from(conversationQueueItems)
      .where(and(
        eq(conversationQueueItems.sessionId, input.sessionId),
        eq(conversationQueueItems.clientMessageId, input.clientMessageId),
      ))
      .get();
    if (existing) {
      const first = parseRevision(revisionFor(tx, existing.id, 1));
      const identical =
        existing.origin === input.origin &&
        first.text === input.text &&
        JSON.stringify(first.agentEnvelope) === JSON.stringify(input.agentEnvelope ?? null);
      if (!identical) {
        return rejected(tx, {
          commandId: input.commandId,
          projectId: input.projectId,
          sessionId: input.sessionId,
          commandKind: kind,
          commandFingerprint,
          queueItemId: existing.id,
          revision: existing.currentRevision,
          error: {
            code: 'idempotency-conflict',
            message: 'clientMessageId was already used for different content',
            currentRevision: existing.currentRevision,
          },
          now,
        });
      }
      storeCommand(tx, {
        commandId: input.commandId,
        projectId: input.projectId,
        sessionId: input.sessionId,
        commandKind: kind,
        commandFingerprint,
        status: 'applied',
        queueItemId: existing.id,
        revision: existing.currentRevision,
        now,
      });
      return {
        status: 'duplicate',
        sessionId: input.sessionId,
        queueItemId: existing.id,
        revision: existing.currentRevision,
        error: null,
      };
    }
    const inserted = insertQueueItem(tx, {
      context,
      clientMessageId: input.clientMessageId,
      text: input.text,
      origin: input.origin,
      agentEnvelope: input.agentEnvelope,
      now,
    });
    storeCommand(tx, {
      commandId: input.commandId,
      projectId: input.projectId,
      sessionId: input.sessionId,
      commandKind: kind,
      commandFingerprint,
      status: 'applied',
      queueItemId: inserted.row.id,
      revision: 1,
      now,
    });
    return {
      status: 'applied',
      sessionId: input.sessionId,
      queueItemId: inserted.row.id,
      revision: 1,
      error: null,
    };
  });
}

function mutableItemOrReject(
  tx: DbTransaction,
  input: {
    projectId: ULID;
    sessionId: string;
    commandId: string;
    commandKind: ConversationCommandKind;
    commandFingerprint: string;
    queueItemId: string;
    expectedRevision: number;
    now: number;
    allowFailed: boolean;
  },
): { row: ConversationQueueItemRow; revision: ConversationQueueRevisionRow } | ConversationCommandResult {
  if (!liveProject(tx, input.projectId)) {
    return rejected(tx, {
      ...input,
      error: { code: 'session-changed', message: 'the target project is no longer active' },
    });
  }
  const row = tx
    .select()
    .from(conversationQueueItems)
    .where(and(
      eq(conversationQueueItems.id, input.queueItemId as ULID),
      eq(conversationQueueItems.sessionId, input.sessionId),
      eq(conversationQueueItems.projectId, input.projectId),
    ))
    .get();
  if (!row) {
    return rejected(tx, {
      ...input,
      error: { code: 'not-found', message: 'queued message was not found' },
    });
  }
  const allowed = row.status === 'queued' || (input.allowFailed && row.status === 'failed');
  if (!allowed) {
    return rejected(tx, {
      ...input,
      revision: row.currentRevision,
      error: {
        code: 'not-queued',
        message: `message is ${row.status} and cannot be changed`,
        currentRevision: row.currentRevision,
      },
    });
  }
  // A failed linked replacement is terminal queue debris, not an active
  // interrupt lock. Retain the request identity as evidence while allowing
  // the remove command to cancel it explicitly. Queued linked rows remain
  // immutable until their request settles.
  if (row.interruptRequestId && row.status !== 'failed') {
    return rejected(tx, {
      ...input,
      revision: row.currentRevision,
      error: {
        code: 'interrupt-in-progress',
        message: 'the FIFO head is locked by an interrupt request',
        currentRevision: row.currentRevision,
      },
    });
  }
  if (row.currentRevision !== input.expectedRevision) {
    return rejected(tx, {
      ...input,
      revision: row.currentRevision,
      error: {
        code: 'revision-conflict',
        message: 'queued message revision changed',
        currentRevision: row.currentRevision,
      },
    });
  }
  return { row, revision: revisionFor(tx, row.id, row.currentRevision) };
}

export function editQueuedConversationSend(
  input: EditQueuedConversationSendInput,
): ConversationCommandResult {
  const now = input.now ?? Date.now();
  const kind: ConversationCommandKind = 'edit-queued-message';
  const commandFingerprint = fingerprint({ kind, ...input, now: undefined });
  return getDb().transaction((tx) => {
    const prior = priorCommand(tx, input.commandId, kind, commandFingerprint);
    if (prior) return prior;
    if (!input.text.trim()) {
      return rejected(tx, {
        ...input,
        commandKind: kind,
        commandFingerprint,
        error: { code: 'invalid', message: 'message text must be non-empty' },
        now,
      });
    }
    const mutable = mutableItemOrReject(tx, {
      ...input,
      commandKind: kind,
      commandFingerprint,
      now,
      allowFailed: false,
    });
    if ('status' in mutable) return mutable;
    if (mutable.row.origin !== 'user') {
      return rejected(tx, {
        ...input,
        commandKind: kind,
        commandFingerprint,
        revision: mutable.row.currentRevision,
        error: { code: 'not-queued', message: 'agent-envelope queue entries are not editable' },
        now,
      });
    }
    const nextRevision = mutable.row.currentRevision + 1;
    const revision: ConversationQueueRevisionRow = {
      queueItemId: mutable.row.id,
      revision: nextRevision,
      text: input.text,
      agentEnvelope: null,
      createdAt: now,
    };
    tx.insert(conversationQueueRevisions).values(revision).run();
    const row: ConversationQueueItemRow = {
      ...mutable.row,
      currentRevision: nextRevision,
      updatedAt: now,
    };
    tx.update(conversationQueueItems)
      .set({ currentRevision: nextRevision, updatedAt: now })
      .where(and(
        eq(conversationQueueItems.id, row.id),
        eq(conversationQueueItems.status, 'queued'),
        eq(conversationQueueItems.currentRevision, input.expectedRevision),
      ))
      .run();
    const queueRevision = bumpQueueRevision(tx, row, now);
    emitQueueState(tx, row, row, revision, queueRevision, now);
    storeCommand(tx, {
      commandId: input.commandId,
      projectId: input.projectId,
      sessionId: input.sessionId,
      commandKind: kind,
      commandFingerprint,
      status: 'applied',
      queueItemId: row.id,
      revision: nextRevision,
      now,
    });
    return {
      status: 'applied',
      sessionId: input.sessionId,
      queueItemId: row.id,
      revision: nextRevision,
      error: null,
    };
  });
}

export function removeQueuedConversationSend(
  input: RemoveQueuedConversationSendInput,
): ConversationCommandResult {
  const now = input.now ?? Date.now();
  const kind: ConversationCommandKind = 'remove-queued-message';
  const commandFingerprint = fingerprint({ kind, ...input, now: undefined });
  return getDb().transaction((tx) => {
    const prior = priorCommand(tx, input.commandId, kind, commandFingerprint);
    if (prior) return prior;
    const mutable = mutableItemOrReject(tx, {
      ...input,
      commandKind: kind,
      commandFingerprint,
      now,
      allowFailed: true,
    });
    if ('status' in mutable) return mutable;
    const row: ConversationQueueItemRow = {
      ...mutable.row,
      status: 'cancelled',
      failureReason: 'removed before delivery',
      updatedAt: now,
    };
    tx.update(conversationQueueItems)
      .set({ status: row.status, failureReason: row.failureReason, updatedAt: now })
      .where(eq(conversationQueueItems.id, row.id))
      .run();
    const queueRevision = bumpQueueRevision(tx, row, now);
    emitQueueState(tx, row, row, mutable.revision, queueRevision, now);
    storeCommand(tx, {
      commandId: input.commandId,
      projectId: input.projectId,
      sessionId: input.sessionId,
      commandKind: kind,
      commandFingerprint,
      status: 'applied',
      queueItemId: row.id,
      revision: row.currentRevision,
      now,
    });
    return {
      status: 'applied',
      sessionId: input.sessionId,
      queueItemId: row.id,
      revision: row.currentRevision,
      error: null,
    };
  });
}

/** Cancel every undelivered queue row for a session as one Conversation-owned
 * unit of work. Each visible removal advances the queue revision and commits
 * with its canonical send-state/outbox row. Repeating the command after it has
 * succeeded is a no-op; delivering and accepted rows are never changed. */
export function cancelQueuedConversationSends(
  sessionId: string,
  reason: string,
  now = Date.now(),
): ULID[] {
  if (!reason.trim()) throw new Error('queue cancellation reason must be non-empty');
  return getDb().transaction((tx) =>
    cancelQueuedConversationSendsInDb(tx, sessionId, reason, now));
}

function cancelQueuedConversationSendsInDb(
  tx: DbTransaction,
  sessionId: string,
  reason: string,
  now: number,
): ULID[] {
  const rows = tx
    .select()
    .from(conversationQueueItems)
    .where(and(
      eq(conversationQueueItems.sessionId, sessionId),
      inArray(conversationQueueItems.status, ['queued', 'failed']),
    ))
    .orderBy(asc(conversationQueueItems.enqueuePosition))
    .all();
  const cancelled: ULID[] = [];
  for (const current of rows) {
    const row: ConversationQueueItemRow = {
      ...current,
      status: 'cancelled',
      failureReason: reason,
      updatedAt: now,
    };
    tx.update(conversationQueueItems)
      .set({ status: row.status, failureReason: row.failureReason, updatedAt: now })
      .where(and(
        eq(conversationQueueItems.id, row.id),
        inArray(conversationQueueItems.status, ['queued', 'failed']),
      ))
      .run();
    const context: QueueContext = row;
    const queueRevision = bumpQueueRevision(tx, context, now);
    emitQueueState(
      tx,
      context,
      row,
      revisionFor(tx, row.id, row.currentRevision),
      queueRevision,
      now,
    );
    cancelled.push(row.id);
  }
  return cancelled;
}

/** Atomically cancel the old FIFO, end the active app session, create its
 * replacement, and optionally update project settings. A failed insert or
 * settings write rolls every part back, including canonical cancellation
 * events/outbox rows. */
export function replaceOrchestratorSession(
  input: ReplaceOrchestratorSessionInput,
): ReplaceOrchestratorSessionResult {
  if (!input.queueCancellationReason.trim()) {
    throw new Error('queue cancellation reason must be non-empty');
  }
  const now = input.now ?? Date.now();
  return getDb().transaction((tx) => {
    if (!getProjectByIdInDb(tx, input.projectId)) {
      throw new Error('project is not active');
    }
    const active = tx
      .select()
      .from(orchestratorSessions)
      .where(and(
        eq(orchestratorSessions.projectId, input.projectId),
        eq(orchestratorSessions.status, 'active'),
        isNull(orchestratorSessions.deletedAt),
      ))
      .get() as OrchestratorSessionRow | undefined;
    if ((active?.id ?? null) !== input.expectedSessionId) {
      throw new Error('active session changed during transition');
    }
    if (active && tx
      .select({ id: conversationTurns.id })
      .from(conversationTurns)
      .where(and(
        eq(conversationTurns.sessionId, active.id),
        eq(conversationTurns.status, 'active'),
      ))
      .get()) {
      throw new Error('cannot switch sessions while a turn is active; interrupt it and wait for confirmation first');
    }

    const cancelledQueueItemIds = active
      ? cancelQueuedConversationSendsInDb(
          tx,
          active.id,
          input.queueCancellationReason,
          now,
        )
      : [];
    if (active) {
      tx.update(orchestratorSessions)
        .set({
          status: 'ended',
          endedReason: input.endedReason ?? 'user_ended',
          endedAt: now,
        })
        .where(eq(orchestratorSessions.id, active.id))
        .run();
    }
    if (input.invalidatePriorSessions) {
      // Without an immutable account stamp, attempting any prior native
      // session under the new credential home is unsafe. Keep transcripts,
      // but make every pre-switch row explicitly non-resumable.
      tx.update(orchestratorSessions)
        .set({ endedReason: 'account_switched' })
        .where(and(
          eq(orchestratorSessions.projectId, input.projectId),
          isNull(orchestratorSessions.deletedAt),
        ))
        .run();
    }

    const session: OrchestratorSessionRow = {
      id: newId(),
      projectId: input.projectId,
      provider: 'claude',
      providerSessionId: '',
      model: null,
      title: null,
      status: 'active',
      endedReason: null,
      startedAt: now,
      endedAt: null,
      deletedAt: null,
    };
    tx.insert(orchestratorSessions).values(session).run();
    if (input.settingsPatch && !updateProjectMetaInDb(tx, input.projectId, {
      settings: input.settingsPatch,
    })) {
      throw new Error('project settings changed during session transition');
    }
    return { session, cancelledQueueItemIds };
  });
}

/** Atomic counterpart to replaceOrchestratorSession for historical resume.
 * The old FIFO/session remain untouched if target reactivation fails. */
export function resumeOrchestratorSessionTransition(
  input: ResumeOrchestratorSessionInput,
): ReplaceOrchestratorSessionResult | null {
  if (!input.queueCancellationReason.trim()) {
    throw new Error('queue cancellation reason must be non-empty');
  }
  const now = input.now ?? Date.now();
  return getDb().transaction((tx) => {
    if (!getProjectByIdInDb(tx, input.projectId)) return null;
    const active = tx
      .select()
      .from(orchestratorSessions)
      .where(and(
        eq(orchestratorSessions.projectId, input.projectId),
        eq(orchestratorSessions.status, 'active'),
        isNull(orchestratorSessions.deletedAt),
      ))
      .get() as OrchestratorSessionRow | undefined;
    if ((active?.id ?? null) !== input.expectedSessionId) {
      throw new Error('active session changed during transition');
    }
    const target = tx
      .select()
      .from(orchestratorSessions)
      .where(and(
        eq(orchestratorSessions.id, input.targetSessionId),
        eq(orchestratorSessions.projectId, input.projectId),
        isNull(orchestratorSessions.deletedAt),
      ))
      .get() as OrchestratorSessionRow | undefined;
    if (!target || target.endedReason === 'account_switched') return null;
    if (active?.id === target.id) {
      return { session: active, cancelledQueueItemIds: [] };
    }
    if (active && tx
      .select({ id: conversationTurns.id })
      .from(conversationTurns)
      .where(and(
        eq(conversationTurns.sessionId, active.id),
        eq(conversationTurns.status, 'active'),
      ))
      .get()) {
      throw new Error('cannot switch sessions while a turn is active; interrupt it and wait for confirmation first');
    }
    const cancelledQueueItemIds = active
      ? cancelQueuedConversationSendsInDb(
          tx,
          active.id,
          input.queueCancellationReason,
          now,
        )
      : [];
    if (active) {
      tx.update(orchestratorSessions)
        .set({ status: 'ended', endedReason: 'user_ended', endedAt: now })
        .where(eq(orchestratorSessions.id, active.id))
        .run();
    }
    tx.update(orchestratorSessions)
      .set({ status: 'active', endedReason: null, endedAt: null, startedAt: now })
      .where(eq(orchestratorSessions.id, target.id))
      .run();
    return {
      session: {
        ...target,
        status: 'active',
        endedReason: null,
        endedAt: null,
        startedAt: now,
      },
      cancelledQueueItemIds,
    };
  });
}

/** Project deletion is a conversation lifecycle transition, not only a soft
 * flag. It fails closed on an active turn, otherwise cancels durable FIFO work,
 * ends the active session, and marks the project deleted in one transaction. */
export function softDeleteProjectConversationState(
  projectId: ULID,
  now = Date.now(),
): SoftDeleteProjectConversationResult {
  return getDb().transaction((tx) => {
    if (!getProjectByIdInDb(tx, projectId)) return { status: 'not-found' };
    if (tx
      .select({ id: conversationTurns.id })
      .from(conversationTurns)
      .where(and(
        eq(conversationTurns.projectId, projectId),
        eq(conversationTurns.status, 'active'),
      ))
      .get()) return { status: 'active-turn' };

    const active = tx
      .select({ id: orchestratorSessions.id })
      .from(orchestratorSessions)
      .where(and(
        eq(orchestratorSessions.projectId, projectId),
        eq(orchestratorSessions.status, 'active'),
        isNull(orchestratorSessions.deletedAt),
      ))
      .get();
    const cancelledQueueItemIds = active
      ? cancelQueuedConversationSendsInDb(tx, active.id, 'project deleted', now)
      : [];
    if (active) {
      tx.update(orchestratorSessions)
        .set({ status: 'ended', endedReason: 'user_ended', endedAt: now })
        .where(eq(orchestratorSessions.id, active.id))
        .run();
    }
    const project = softDeleteProjectInDb(tx, projectId);
    if (!project) throw new Error('project disappeared during deletion');
    return { status: 'deleted', project, cancelledQueueItemIds };
  });
}

export function getConversationQueueSnapshot(sessionId: string): {
  queueRevision: number;
  items: SendQueueItem[];
} {
  const db = getDb();
  const head = db
    .select({ queueRevision: conversationQueueHeads.queueRevision })
    .from(conversationQueueHeads)
    .where(eq(conversationQueueHeads.sessionId, sessionId))
    .get();
  const rows = db
    .select()
    .from(conversationQueueItems)
    .where(and(
      eq(conversationQueueItems.sessionId, sessionId),
      inArray(conversationQueueItems.status, ['queued', 'delivering', 'failed']),
    ))
    .orderBy(asc(conversationQueueItems.enqueuePosition))
    .all();
  return {
    queueRevision: head?.queueRevision ?? 0,
    items: rows.map((row) => toPublicItem(row, revisionFor(db, row.id, row.currentRevision))),
  };
}

export function getActiveConversationTurn(sessionId: string): ConversationTurnRow | null {
  return getDb()
    .select()
    .from(conversationTurns)
    .where(and(eq(conversationTurns.sessionId, sessionId), eq(conversationTurns.status, 'active')))
    .get() ?? null;
}

export function claimNextConversationTurn(
  sessionId: string,
  now = Date.now(),
): ClaimedConversationTurn | null {
  return getDb().transaction((tx) => {
    if (tx.select({ id: conversationTurns.id }).from(conversationTurns).where(and(
      eq(conversationTurns.sessionId, sessionId),
      eq(conversationTurns.status, 'active'),
    )).get()) return null;
    const row = tx
      .select()
      .from(conversationQueueItems)
      .where(and(
        eq(conversationQueueItems.sessionId, sessionId),
        eq(conversationQueueItems.status, 'queued'),
      ))
      .orderBy(asc(conversationQueueItems.enqueuePosition))
      .limit(1)
      .get();
    if (!row) return null;
    if (row.interruptRequestId) {
      const request = tx
        .select({ status: turnInterruptRequests.status })
        .from(turnInterruptRequests)
        .where(eq(turnInterruptRequests.id, row.interruptRequestId))
        .get();
      if (request?.status !== 'confirmed') return null;
    }
    const session = tx
      .select({
        projectId: orchestratorSessions.projectId,
        status: orchestratorSessions.status,
        deletedAt: orchestratorSessions.deletedAt,
      })
      .from(orchestratorSessions)
      .where(eq(orchestratorSessions.id, sessionId as ULID))
      .get();
    if (
      session?.status !== 'active' || session.deletedAt !== null ||
      session.projectId !== row.projectId || !liveProject(tx, row.projectId)
    ) return null;
    const revision = revisionFor(tx, row.id, row.currentRevision);
    const parsed = parseRevision(revision);
    if (row.origin === 'agent-envelope' && !parsed.agentEnvelope) {
      throw new Error(`queue item ${row.id} has invalid agent-envelope metadata`);
    }
    const delivering: ConversationQueueItemRow = {
      ...row,
      status: 'delivering',
      deliveryRevision: row.currentRevision,
      failureReason: null,
      updatedAt: now,
    };
    tx.update(conversationQueueItems)
      .set({
        status: 'delivering',
        deliveryRevision: row.currentRevision,
        failureReason: null,
        updatedAt: now,
      })
      .where(and(
        eq(conversationQueueItems.id, row.id),
        eq(conversationQueueItems.status, 'queued'),
      ))
      .run();
    tx.insert(conversationTurns).values({
      id: row.turnId,
      projectId: row.projectId,
      conversationId: row.conversationId,
      sessionId: row.sessionId,
      queueItemId: row.id,
      status: 'active',
      terminalEventId: null,
      terminalOutcome: null,
      startedAt: now,
      endedAt: null,
    }).run();
    const context: QueueContext = row;
    const queueRevision = bumpQueueRevision(tx, context, now);
    emitQueueState(tx, context, delivering, revision, queueRevision, now);
    if (row.origin === 'user') {
      appendEvent(tx, context, { kind: 'user', text: revision.text }, {
        itemId: row.id,
        turnId: row.turnId,
        clientMessageId: row.clientMessageId,
        now,
      });
    } else {
      const meta = parsed.agentEnvelope!;
      appendEvent(tx, context, {
        kind: 'agent-envelope',
        runId: meta.runId as ULID,
        agentName: meta.agentName,
        pendingAskId: meta.pendingAskId as ULID | undefined,
        status: meta.status,
        summary: meta.summary,
        detail: meta.detail,
        envelope: revision.text,
      }, {
        itemId: row.id,
        turnId: row.turnId,
        clientMessageId: row.clientMessageId,
        now,
      });
    }
    appendEvent(tx, context, {
      kind: 'session-state',
      state: 'running',
      permissionMode: null,
    }, { itemId: newId(), turnId: row.turnId, now });
    return {
      projectId: row.projectId,
      conversationId: row.conversationId,
      sessionId: row.sessionId,
      queueItemId: row.id,
      turnId: row.turnId,
      clientMessageId: row.clientMessageId,
      text: revision.text,
      origin: row.origin,
      ...(parsed.agentEnvelope ? { agentEnvelope: parsed.agentEnvelope } : {}),
      deliveryRevision: row.currentRevision,
    };
  });
}

function interruptEvent(row: TurnInterruptRequestRow): Extract<ChatEvent, { kind: 'interrupt-state' }> {
  return {
    kind: 'interrupt-state',
    requestId: row.id,
    targetTurnId: row.targetTurnId,
    replacementQueueItemId: row.replacementQueueItemId,
    state: row.status,
    terminalEventId: row.terminalEventId,
    result: row.result,
    failure: row.failureCode
      ? { code: row.failureCode, message: row.failureReason ?? '' }
      : null,
  };
}

export function requestConversationInterrupt(
  input: RequestConversationInterruptInput,
): ConversationCommandResult {
  const now = input.now ?? Date.now();
  const kind: ConversationCommandKind = input.replacement ? 'interrupt-and-send' : 'interrupt';
  const commandFingerprint = fingerprint({
    kind,
    sessionId: input.sessionId,
    targetTurnId: input.targetTurnId,
    replacement: input.replacement ?? null,
  });
  return getDb().transaction((tx) => {
    const prior = priorCommand(tx, input.requestId, kind, commandFingerprint);
    if (prior) return prior;
    const context: QueueContext = input;
    if (!liveProject(tx, input.projectId)) {
      return rejected(tx, {
        commandId: input.requestId,
        projectId: input.projectId,
        sessionId: input.sessionId,
        commandKind: kind,
        commandFingerprint,
        interruptRequestId: input.requestId,
        error: { code: 'session-changed', message: 'the target project is no longer active' },
        now,
      });
    }
    const turn = tx
      .select()
      .from(conversationTurns)
      .where(and(
        eq(conversationTurns.id, input.targetTurnId),
        eq(conversationTurns.sessionId, input.sessionId),
        eq(conversationTurns.projectId, input.projectId),
        eq(conversationTurns.status, 'active'),
      ))
      .get();
    if (!turn || turn.conversationId !== input.conversationId) {
      return rejected(tx, {
        commandId: input.requestId,
        projectId: input.projectId,
        sessionId: input.sessionId,
        commandKind: kind,
        commandFingerprint,
        interruptRequestId: input.requestId,
        error: { code: 'no-active-turn', message: 'the targeted turn is no longer active' },
        now,
      });
    }
    const existingRequest = tx
      .select({
        id: turnInterruptRequests.id,
        status: turnInterruptRequests.status,
        failureCode: turnInterruptRequests.failureCode,
      })
      .from(turnInterruptRequests)
      .where(and(
        eq(turnInterruptRequests.sessionId, input.sessionId),
        eq(turnInterruptRequests.targetTurnId, input.targetTurnId),
        or(
          eq(turnInterruptRequests.status, 'requested'),
          and(
            eq(turnInterruptRequests.status, 'failed'),
            eq(turnInterruptRequests.failureCode, 'runtime-interrupt-inconclusive'),
          ),
        ),
      ))
      .get();
    if (existingRequest) {
      return rejected(tx, {
        commandId: input.requestId,
        projectId: input.projectId,
        sessionId: input.sessionId,
        commandKind: kind,
        commandFingerprint,
        interruptRequestId: input.requestId,
        error: {
          code: 'interrupt-in-progress',
          message: existingRequest.status === 'requested'
            ? 'an interrupt is already requested for this turn'
            : 'the prior native interrupt outcome is inconclusive; retry is blocked for this turn',
        },
        now,
      });
    }

    let replacementRow: ConversationQueueItemRow | null = null;
    let replacementRevision: ConversationQueueRevisionRow | null = null;
    if (input.replacement?.kind === 'queued') {
      const head = tx
        .select()
        .from(conversationQueueItems)
        .where(and(
          eq(conversationQueueItems.sessionId, input.sessionId),
          eq(conversationQueueItems.status, 'queued'),
        ))
        .orderBy(asc(conversationQueueItems.enqueuePosition))
        .limit(1)
        .get();
      if (!head || head.id !== input.replacement.queueItemId) {
        return rejected(tx, {
          commandId: input.requestId,
          projectId: input.projectId,
          sessionId: input.sessionId,
          commandKind: kind,
          commandFingerprint,
          interruptRequestId: input.requestId,
          error: { code: 'not-head', message: 'only the FIFO head can be interrupt-and-send' },
          now,
        });
      }
      if (head.currentRevision !== input.replacement.expectedRevision) {
        return rejected(tx, {
          commandId: input.requestId,
          projectId: input.projectId,
          sessionId: input.sessionId,
          commandKind: kind,
          commandFingerprint,
          queueItemId: head.id,
          revision: head.currentRevision,
          interruptRequestId: input.requestId,
          error: {
            code: 'revision-conflict',
            message: 'FIFO head revision changed',
            currentRevision: head.currentRevision,
          },
          now,
        });
      }
      if (head.origin !== 'user' || head.interruptRequestId) {
        return rejected(tx, {
          commandId: input.requestId,
          projectId: input.projectId,
          sessionId: input.sessionId,
          commandKind: kind,
          commandFingerprint,
          queueItemId: head.id,
          revision: head.currentRevision,
          interruptRequestId: input.requestId,
          error: { code: 'not-queued', message: 'the FIFO head cannot be selected' },
          now,
        });
      }
      replacementRow = { ...head, interruptRequestId: input.requestId, updatedAt: now };
      replacementRevision = revisionFor(tx, head.id, head.currentRevision);
      tx.update(conversationQueueItems)
        .set({ interruptRequestId: input.requestId, updatedAt: now })
        .where(eq(conversationQueueItems.id, head.id))
        .run();
      const queueRevision = bumpQueueRevision(tx, context, now);
      emitQueueState(tx, context, replacementRow, replacementRevision, queueRevision, now);
    } else if (input.replacement?.kind === 'new') {
      const queued = tx
        .select({ id: conversationQueueItems.id })
        .from(conversationQueueItems)
        .where(and(
          eq(conversationQueueItems.sessionId, input.sessionId),
          eq(conversationQueueItems.status, 'queued'),
        ))
        .limit(1)
        .get();
      if (queued) {
        return rejected(tx, {
          commandId: input.requestId,
          projectId: input.projectId,
          sessionId: input.sessionId,
          commandKind: kind,
          commandFingerprint,
          interruptRequestId: input.requestId,
          error: { code: 'queue-not-empty', message: 'select the existing FIFO head instead' },
          now,
        });
      }
      if (!input.replacement.text.trim()) {
        return rejected(tx, {
          commandId: input.requestId,
          projectId: input.projectId,
          sessionId: input.sessionId,
          commandKind: kind,
          commandFingerprint,
          interruptRequestId: input.requestId,
          error: { code: 'invalid', message: 'replacement text must be non-empty' },
          now,
        });
      }
      const existingClient = tx
        .select({ id: conversationQueueItems.id, currentRevision: conversationQueueItems.currentRevision })
        .from(conversationQueueItems)
        .where(and(
          eq(conversationQueueItems.sessionId, input.sessionId),
          eq(conversationQueueItems.clientMessageId, input.replacement.clientMessageId),
        ))
        .get();
      if (existingClient) {
        return rejected(tx, {
          commandId: input.requestId,
          projectId: input.projectId,
          sessionId: input.sessionId,
          commandKind: kind,
          commandFingerprint,
          queueItemId: existingClient.id,
          revision: existingClient.currentRevision,
          interruptRequestId: input.requestId,
          error: { code: 'idempotency-conflict', message: 'replacement clientMessageId already exists' },
          now,
        });
      }
      const inserted = insertQueueItem(tx, {
        context,
        clientMessageId: input.replacement.clientMessageId,
        text: input.replacement.text,
        origin: 'user',
        interruptRequestId: input.requestId,
        now,
      });
      replacementRow = inserted.row;
      replacementRevision = inserted.revision;
    }

    const request: TurnInterruptRequestRow = {
      id: input.requestId,
      projectId: input.projectId,
      conversationId: input.conversationId,
      sessionId: input.sessionId,
      targetTurnId: input.targetTurnId,
      replacementQueueItemId: replacementRow?.id ?? null,
      status: 'requested',
      terminalEventId: null,
      result: null,
      failureCode: null,
      failureReason: null,
      requestedAt: now,
      settledAt: null,
      updatedAt: now,
    };
    tx.insert(turnInterruptRequests).values(request).run();
    appendEvent(tx, context, interruptEvent(request), {
      itemId: request.id,
      turnId: request.targetTurnId,
      now,
    });
    storeCommand(tx, {
      commandId: input.requestId,
      projectId: input.projectId,
      sessionId: input.sessionId,
      commandKind: kind,
      commandFingerprint,
      status: 'applied',
      queueItemId: replacementRow?.id ?? null,
      revision: replacementRow?.currentRevision ?? null,
      interruptRequestId: request.id,
      now,
    });
    void replacementRevision;
    return {
      status: 'applied',
      sessionId: input.sessionId,
      ...(replacementRow ? { queueItemId: replacementRow.id, revision: replacementRow.currentRevision } : {}),
      interruptRequestId: request.id,
      error: null,
    };
  });
}

export function failConversationInterrupt(
  requestId: string,
  failure: { code: string; message: string },
  now = Date.now(),
): boolean {
  return getDb().transaction((tx) => {
    const current = tx
      .select()
      .from(turnInterruptRequests)
      .where(eq(turnInterruptRequests.id, requestId))
      .get();
    if (!current || current.status !== 'requested') return false;
    const row: TurnInterruptRequestRow = {
      ...current,
      status: 'failed',
      failureCode: failure.code,
      failureReason: failure.message,
      settledAt: now,
      updatedAt: now,
    };
    tx.update(turnInterruptRequests)
      .set({
        status: row.status,
        failureCode: row.failureCode,
        failureReason: row.failureReason,
        settledAt: now,
        updatedAt: now,
      })
      .where(eq(turnInterruptRequests.id, requestId))
      .run();
    const context: QueueContext = row;
    appendEvent(tx, context, interruptEvent(row), {
      itemId: row.id,
      turnId: row.targetTurnId,
      now,
    });
    if (row.replacementQueueItemId) {
      failReplacement(tx, context, row.replacementQueueItemId, failure.message, now);
    }
    return true;
  });
}

function failReplacement(
  tx: DbTransaction,
  context: QueueContext,
  queueItemId: string,
  reason: string,
  now: number,
): void {
  const current = tx
    .select()
    .from(conversationQueueItems)
    .where(eq(conversationQueueItems.id, queueItemId as ULID))
    .get();
  if (!current || current.status !== 'queued') return;
  const row: ConversationQueueItemRow = {
    ...current,
    status: 'failed',
    failureReason: reason,
    updatedAt: now,
  };
  tx.update(conversationQueueItems)
    .set({ status: row.status, failureReason: row.failureReason, updatedAt: now })
    .where(eq(conversationQueueItems.id, row.id))
    .run();
  const queueRevision = bumpQueueRevision(tx, context, now);
  emitQueueState(tx, context, row, revisionFor(tx, row.id, row.currentRevision), queueRevision, now);
}

export function settleConversationTurn(input: SettleConversationTurnInput): boolean {
  const now = input.now ?? Date.now();
  return getDb().transaction((tx) => {
    const turn = tx
      .select()
      .from(conversationTurns)
      .where(eq(conversationTurns.id, input.turnId))
      .get();
    if (!turn || turn.status !== 'active') return false;
    const item = tx
      .select()
      .from(conversationQueueItems)
      .where(eq(conversationQueueItems.id, turn.queueItemId))
      .get();
    if (!item) throw new Error(`active turn ${turn.id} references missing queue item`);
    const context: QueueContext = turn;
    const terminalEventId = newId();
    appendEvent(tx, context, input.terminalEvent, {
      eventId: terminalEventId,
      itemId: newId(),
      turnId: turn.id,
      now,
    });
    tx.update(conversationTurns)
      .set({
        status: 'ended',
        terminalEventId,
        terminalOutcome: input.terminalOutcome,
        endedAt: now,
      })
      .where(and(eq(conversationTurns.id, turn.id), eq(conversationTurns.status, 'active')))
      .run();

    const settledItem: ConversationQueueItemRow = {
      ...item,
      status: input.queueStatus,
      failureReason: input.queueStatus === 'failed'
        ? input.queueFailureReason ?? 'delivery failed before runtime acceptance'
        : null,
      updatedAt: now,
    };
    tx.update(conversationQueueItems)
      .set({
        status: settledItem.status,
        failureReason: settledItem.failureReason,
        updatedAt: now,
      })
      .where(eq(conversationQueueItems.id, item.id))
      .run();
    const queueRevision = bumpQueueRevision(tx, context, now);
    emitQueueState(
      tx,
      context,
      settledItem,
      revisionFor(tx, item.id, item.deliveryRevision ?? item.currentRevision),
      queueRevision,
      now,
    );

    const requests = tx
      .select()
      .from(turnInterruptRequests)
      .where(and(
        eq(turnInterruptRequests.sessionId, turn.sessionId),
        eq(turnInterruptRequests.targetTurnId, turn.id),
        eq(turnInterruptRequests.status, 'requested'),
      ))
      .all();
    const confirmed =
      input.terminalOutcome === 'aborted' &&
      input.terminalEvent.kind === 'turn-failed' &&
      input.terminalEvent.source === 'abort';
    for (const request of requests) {
      const next: TurnInterruptRequestRow = {
        ...request,
        status: confirmed ? 'confirmed' : 'failed',
        terminalEventId,
        result: input.terminalOutcome,
        failureCode: confirmed ? null : 'target-ended',
        failureReason: confirmed ? null : 'target turn ended without a confirmed abort',
        settledAt: now,
        updatedAt: now,
      };
      tx.update(turnInterruptRequests)
        .set({
          status: next.status,
          terminalEventId,
          result: next.result,
          failureCode: next.failureCode,
          failureReason: next.failureReason,
          settledAt: now,
          updatedAt: now,
        })
        .where(eq(turnInterruptRequests.id, request.id))
        .run();
      appendEvent(tx, context, interruptEvent(next), {
        itemId: next.id,
        turnId: turn.id,
        now,
      });
      if (!confirmed && next.replacementQueueItemId) {
        failReplacement(tx, context, next.replacementQueueItemId, next.failureReason!, now);
      }
    }
    appendEvent(tx, context, {
      kind: 'session-state',
      state: 'idle',
      permissionMode: null,
    }, { itemId: newId(), turnId: turn.id, now });
    return true;
  });
}

export function recoverActiveConversationTurns(now = Date.now()): string[] {
  const active = getDb()
    .select({ id: conversationTurns.id })
    .from(conversationTurns)
    .where(eq(conversationTurns.status, 'active'))
    .all();
  const recovered: string[] = [];
  for (const turn of active) {
    if (settleConversationTurn({
      turnId: turn.id,
      terminalEvent: {
        kind: 'turn-failed',
        error: 'server restarted mid-turn',
        source: 'internal',
      },
      terminalOutcome: 'recovered',
      queueStatus: 'failed',
      queueFailureReason: 'server restarted while delivery outcome was uncertain',
      now,
    })) recovered.push(turn.id);
  }
  return recovered;
}

export function listProjectsWithQueuedConversationSends(): ULID[] {
  const rows = getDb()
    .select({ projectId: conversationQueueItems.projectId })
    .from(conversationQueueItems)
    .innerJoin(
      orchestratorSessions,
      and(
        eq(orchestratorSessions.id, conversationQueueItems.sessionId),
        eq(orchestratorSessions.projectId, conversationQueueItems.projectId),
      ),
    )
    .innerJoin(projects, eq(projects.id, conversationQueueItems.projectId))
    .where(and(
      eq(conversationQueueItems.status, 'queued'),
      eq(orchestratorSessions.status, 'active'),
      isNull(orchestratorSessions.deletedAt),
      isNull(projects.deletedAt),
    ))
    .all();
  const liveProjects = new Set<ULID>();
  for (const row of rows) liveProjects.add(row.projectId);
  return [...liveProjects];
}

export function getTurnInterruptRequest(requestId: string): TurnInterruptRequestRow | null {
  return getDb()
    .select()
    .from(turnInterruptRequests)
    .where(eq(turnInterruptRequests.id, requestId))
    .get() ?? null;
}
