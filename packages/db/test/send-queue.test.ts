import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  safeToolSummary,
  type RuntimeSelection,
  type ToolStateEvent,
} from '@pc/contracts';

const tmpDir = mkdtempSync(join(tmpdir(), 'pc-conversation-queue-'));
process.env.PC_DATA_DIR = tmpDir;

const db = await import('../src/index.ts');

const TEST_SELECTION: RuntimeSelection = {
  runtimeId: 'test-runtime',
  accountId: 'test-account',
  model: 'test-model',
  effort: { kind: 'none' },
};

before(() => db.runMigrations());
after(() => {
  db.closeDb();
  rmSync(tmpDir, { recursive: true, force: true });
});

function context(name: string) {
  const project = db.createProject({ name, slug: `${name}-${db.newId().toLowerCase()}`, folderPath: '' });
  const session = db.createOrchestratorSession({ projectId: project.id, selection: TEST_SELECTION });
  return {
    projectId: project.id,
    conversationId: session.id,
    sessionId: session.id,
  };
}

function enqueue(
  ctx: ReturnType<typeof context>,
  text: string,
  commandId = `command-${db.newId()}`,
  clientMessageId = `client-${db.newId()}`,
  now = 100,
) {
  return db.enqueueConversationSend({
    ...ctx,
    commandId,
    clientMessageId,
    text,
    origin: 'user',
    now,
  });
}

test('enqueue is transactionally durable and idempotent by command and client identity', () => {
  const ctx = context('enqueue');
  const first = enqueue(ctx, 'hello', 'command-1', 'client-1');
  assert.equal(first.status, 'applied');
  const snapshot = db.getConversationQueueSnapshot(ctx.sessionId);
  assert.equal(snapshot.queueRevision, 1);
  assert.deepEqual(snapshot.items.map((item) => [item.text, item.revision, item.enqueuePosition]), [
    ['hello', 1, 1],
  ]);
  assert.equal(db.listConversationEvents(ctx.sessionId).at(-1)?.eventType, 'send-state');

  const duplicate = enqueue(ctx, 'hello', 'command-1', 'client-1');
  assert.equal(duplicate.status, 'duplicate');
  assert.equal(db.getConversationQueueSnapshot(ctx.sessionId).queueRevision, 1);

  const conflictingCommand = enqueue(ctx, 'changed', 'command-1', 'client-1');
  assert.equal(conflictingCommand.status, 'rejected');
  assert.equal(conflictingCommand.error?.code, 'idempotency-conflict');

  const conflictingClient = enqueue(ctx, 'changed', 'command-2', 'client-1');
  assert.equal(conflictingClient.status, 'rejected');
  assert.equal(conflictingClient.error?.code, 'idempotency-conflict');
  assert.equal(db.getConversationQueueSnapshot(ctx.sessionId).items[0]?.text, 'hello');
});

test('enqueue rejects mismatched conversation identity and malformed origin metadata', () => {
  const ctx = context('invalid-admission');
  const mismatched = db.enqueueConversationSend({
    ...ctx,
    conversationId: 'different-conversation',
    commandId: 'invalid-identity-command',
    clientMessageId: 'invalid-identity-client',
    text: 'must not publish elsewhere',
    origin: 'user',
    now: 150,
  });
  assert.equal(mismatched.status, 'rejected');
  assert.equal(mismatched.error?.code, 'session-changed');

  const malformedAgent = db.enqueueConversationSend({
    ...ctx,
    commandId: 'invalid-agent-command',
    clientMessageId: 'invalid-agent-client',
    text: 'raw transport',
    origin: 'agent-envelope',
    agentEnvelope: {} as never,
    now: 151,
  });
  assert.equal(malformedAgent.status, 'rejected');
  assert.equal(malformedAgent.error?.code, 'invalid');
  const malformedAgentRetry = db.enqueueConversationSend({
    ...ctx,
    commandId: 'invalid-agent-command',
    clientMessageId: 'invalid-agent-client',
    text: 'raw transport',
    origin: 'agent-envelope',
    agentEnvelope: {} as never,
    now: 151,
  });
  assert.equal(malformedAgentRetry.status, 'rejected');
  assert.equal(malformedAgentRetry.error?.code, 'invalid');

  const userWithAgentMetadata = db.enqueueConversationSend({
    ...ctx,
    commandId: 'invalid-user-command',
    clientMessageId: 'invalid-user-client',
    text: 'ordinary user text',
    origin: 'user',
    agentEnvelope: {
      runId: 'run-1',
      agentName: 'Agent',
      status: 'waiting',
      summary: 'summary',
      detail: 'detail',
    },
    now: 152,
  });
  assert.equal(userWithAgentMetadata.status, 'rejected');
  assert.equal(userWithAgentMetadata.error?.code, 'invalid');
  assert.deepEqual(db.getConversationQueueSnapshot(ctx.sessionId), { queueRevision: 0, items: [] });
  assert.deepEqual(db.listConversationEvents(ctx.sessionId), []);
});

test('FIFO position survives same-time enqueue; edit revisions and remove are CAS guarded', () => {
  const ctx = context('fifo');
  const first = enqueue(ctx, 'first', 'fifo-c1', 'fifo-m1', 200);
  const second = enqueue(ctx, 'second', 'fifo-c2', 'fifo-m2', 200);
  const edited = db.editQueuedConversationSend({
    ...ctx,
    commandId: 'edit-1',
    queueItemId: second.queueItemId!,
    expectedRevision: 1,
    text: 'second edited',
    now: 201,
  });
  assert.equal(edited.revision, 2);
  const stale = db.editQueuedConversationSend({
    ...ctx,
    commandId: 'edit-stale',
    queueItemId: second.queueItemId!,
    expectedRevision: 1,
    text: 'lost update',
    now: 202,
  });
  assert.equal(stale.status, 'rejected');
  assert.equal(stale.error?.code, 'revision-conflict');
  assert.equal(stale.error?.currentRevision, 2);

  const removed = db.removeQueuedConversationSend({
    ...ctx,
    commandId: 'remove-1',
    queueItemId: first.queueItemId!,
    expectedRevision: 1,
    now: 203,
  });
  assert.equal(removed.status, 'applied');
  const snapshot = db.getConversationQueueSnapshot(ctx.sessionId);
  assert.deepEqual(snapshot.items.map((item) => [item.text, item.enqueuePosition, item.revision]), [
    ['second edited', 2, 2],
  ]);

  const claimed = db.claimNextConversationTurn(ctx.sessionId, 204)!;
  assert.equal(claimed.text, 'second edited');
  assert.equal(claimed.deliveryRevision, 2);
  assert.equal(db.editQueuedConversationSend({
    ...ctx,
    commandId: 'edit-after-claim',
    queueItemId: claimed.queueItemId,
    expectedRevision: 2,
    text: 'too late',
    now: 205,
  }).error?.code, 'not-queued');
  assert.equal(db.settleConversationTurn({
    turnId: claimed.turnId,
    terminalEvent: { kind: 'turn-end', text: 'done', stopReason: 'complete' },
    terminalOutcome: 'completed',
    queueStatus: 'accepted',
    now: 206,
  }), true);
});

test('claim atomically freezes delivery content, opens one turn, and terminal settles accepted + idle', () => {
  const ctx = context('claim');
  enqueue(ctx, 'run me', 'claim-c1', 'claim-m1', 300);
  const claimed = db.claimNextConversationTurn(ctx.sessionId, 301)!;
  assert.equal(db.getActiveConversationTurn(ctx.sessionId)?.id, claimed.turnId);
  assert.equal(db.claimNextConversationTurn(ctx.sessionId, 302), null);
  assert.equal(db.getConversationQueueSnapshot(ctx.sessionId).items[0]?.status, 'delivering');
  const eventTypes = db.listConversationEvents(ctx.sessionId).map((row) => row.eventType);
  assert.deepEqual(eventTypes.slice(-4), ['send-state', 'user', 'session-state', 'activity-state']);

  assert.equal(db.settleConversationTurn({
    turnId: claimed.turnId,
    terminalEvent: { kind: 'turn-end', text: 'done', stopReason: 'complete' },
    terminalOutcome: 'completed',
    queueStatus: 'accepted',
    now: 303,
  }), true);
  assert.equal(db.getActiveConversationTurn(ctx.sessionId), null);
  assert.deepEqual(db.getConversationQueueSnapshot(ctx.sessionId).items, []);
  assert.deepEqual(
    db.listConversationEvents(ctx.sessionId).slice(-3).map((row) => row.eventType),
    ['turn-end', 'send-state', 'session-state'],
  );
  assert.equal(db.settleConversationTurn({
    turnId: claimed.turnId,
    terminalEvent: { kind: 'turn-end', text: 'duplicate', stopReason: 'complete' },
    terminalOutcome: 'completed',
    queueStatus: 'accepted',
    now: 304,
  }), false);
});

test('terminal settlement closes every open tool before the turn terminal in the same transaction', () => {
  const ctx = context('settle-tools');
  enqueue(ctx, 'use tools', 'settle-tools-c1', 'settle-tools-m1', 350);
  const claimed = db.claimNextConversationTurn(ctx.sessionId, 351)!;
  const requested = (callId: string, name: string): ToolStateEvent => ({
    kind: 'tool-state',
    callId,
    name,
    state: 'requested',
    safeSummary: safeToolSummary(name),
    approval: { status: 'unknown', source: null, requestId: null },
    outcome: null,
  });
  const commitTool = (event: ToolStateEvent, occurredAt: number) => db.commitConversationEvent({
    projectId: ctx.projectId,
    conversationId: ctx.conversationId,
    sessionId: ctx.sessionId,
    family: 'tool',
    event,
    turnId: claimed.turnId,
    itemId: event.callId,
    occurredAt,
    deliveryKind: 'chat',
  });

  const runningStart = requested('call-running', 'Read');
  commitTool(runningStart, 352);
  commitTool({
    ...runningStart,
    state: 'running',
    approval: { status: 'not-required', source: 'policy', requestId: null },
  }, 353);
  const approvalStart = requested('call-approval', 'Bash');
  commitTool(approvalStart, 354);
  commitTool({
    ...approvalStart,
    state: 'approval-needed',
    approval: { status: 'pending', source: null, requestId: 'approval-settle' },
  }, 355);

  assert.equal(db.settleConversationTurn({
    turnId: claimed.turnId,
    terminalEvent: { kind: 'turn-failed', error: 'runtime ended', source: 'internal' },
    terminalOutcome: 'turn-failed',
    queueStatus: 'failed',
    now: 356,
  }), true);

  const events = db.listConversationEvents(ctx.sessionId);
  const terminalIndex = events.findIndex((row) => row.eventType === 'turn-failed');
  const finalTools = events
    .map((row, index) => ({ index, event: row.payload }))
    .filter((entry): entry is { index: number; event: ToolStateEvent } => (
      typeof entry.event === 'object'
      && entry.event !== null
      && (entry.event as { kind?: string }).kind === 'tool-state'
      && ['failed', 'denied'].includes((entry.event as ToolStateEvent).state)
    ));
  assert.equal(finalTools.length, 2);
  assert.ok(finalTools.every((entry) => entry.index < terminalIndex));
  assert.deepEqual(
    finalTools.map(({ event }) => [event.callId, event.state, event.approval.status, event.outcome?.reason ?? null]),
    [
      ['call-running', 'failed', 'not-required', 'turn-ended'],
      ['call-approval', 'denied', 'denied', null],
    ],
  );
});

test('interrupt-and-send releases only after the exact aborted terminal', () => {
  const ctx = context('interrupt-confirm');
  enqueue(ctx, 'active', 'ic-c1', 'ic-m1', 400);
  const active = db.claimNextConversationTurn(ctx.sessionId, 401)!;
  const wrongConversation = db.requestConversationInterrupt({
    ...ctx,
    conversationId: 'different-conversation',
    requestId: 'interrupt-wrong-conversation',
    targetTurnId: active.turnId,
    now: 401,
  });
  assert.equal(wrongConversation.status, 'rejected');
  assert.equal(wrongConversation.error?.code, 'no-active-turn');
  assert.equal(db.getTurnInterruptRequest('interrupt-wrong-conversation'), null);
  const request = db.requestConversationInterrupt({
    ...ctx,
    requestId: 'interrupt-confirm-1',
    targetTurnId: active.turnId,
    replacement: { kind: 'new', clientMessageId: 'ic-replacement', text: 'replacement' },
    now: 402,
  });
  assert.equal(request.status, 'applied');
  assert.equal(db.getTurnInterruptRequest('interrupt-confirm-1')?.status, 'requested');
  assert.equal(db.claimNextConversationTurn(ctx.sessionId, 403), null);

  db.settleConversationTurn({
    turnId: active.turnId,
    terminalEvent: { kind: 'turn-failed', error: 'interrupted', source: 'abort' },
    terminalOutcome: 'aborted',
    queueStatus: 'accepted',
    now: 404,
  });
  assert.equal(db.getTurnInterruptRequest('interrupt-confirm-1')?.status, 'confirmed');
  const replacement = db.claimNextConversationTurn(ctx.sessionId, 405)!;
  assert.equal(replacement.text, 'replacement');
  const ordered = db.listConversationEvents(ctx.sessionId).map((row) => row.eventType);
  const terminal = ordered.indexOf('turn-failed');
  const confirmed = ordered.findIndex((kind, index) => index > terminal && kind === 'interrupt-state');
  const replacementUser = ordered.findIndex((kind, index) => index > confirmed && kind === 'user');
  assert.ok(terminal >= 0 && confirmed > terminal && replacementUser > confirmed);
  assert.equal(db.settleConversationTurn({
    turnId: replacement.turnId,
    terminalEvent: { kind: 'turn-end', text: 'replacement done', stopReason: 'complete' },
    terminalOutcome: 'completed',
    queueStatus: 'accepted',
    now: 406,
  }), true);
});

test('normal target terminal fails a linked replacement closed', () => {
  const ctx = context('interrupt-fail');
  enqueue(ctx, 'active', 'if-c1', 'if-m1', 500);
  const active = db.claimNextConversationTurn(ctx.sessionId, 501)!;
  const head = enqueue(ctx, 'next', 'if-c2', 'if-m2', 502);
  const request = db.requestConversationInterrupt({
    ...ctx,
    requestId: 'interrupt-fail-1',
    targetTurnId: active.turnId,
    replacement: { kind: 'queued', queueItemId: head.queueItemId!, expectedRevision: 1 },
    now: 503,
  });
  assert.equal(request.status, 'applied');
  db.settleConversationTurn({
    turnId: active.turnId,
    terminalEvent: { kind: 'turn-end', text: 'finished first', stopReason: 'complete' },
    terminalOutcome: 'completed',
    queueStatus: 'accepted',
    now: 504,
  });
  assert.equal(db.getTurnInterruptRequest('interrupt-fail-1')?.status, 'failed');
  const failed = db.getConversationQueueSnapshot(ctx.sessionId).items[0]!;
  assert.equal(failed.id, head.queueItemId);
  assert.equal(failed.status, 'failed');
  assert.equal(db.claimNextConversationTurn(ctx.sessionId, 505), null);
  const removed = db.removeQueuedConversationSend({
    ...ctx,
    commandId: 'remove-failed-replacement',
    queueItemId: failed.id,
    expectedRevision: failed.revision,
    now: 506,
  });
  assert.equal(removed.status, 'applied');
  assert.deepEqual(db.getConversationQueueSnapshot(ctx.sessionId).items, []);
});

test('an inconclusive native interrupt durably blocks a duplicate attempt for the active turn', () => {
  const ctx = context('interrupt-inconclusive');
  enqueue(ctx, 'active', 'ii-c1', 'ii-m1', 520);
  const active = db.claimNextConversationTurn(ctx.sessionId, 521)!;
  assert.equal(db.requestConversationInterrupt({
    ...ctx,
    requestId: 'interrupt-inconclusive-1',
    targetTurnId: active.turnId,
    now: 522,
  }).status, 'applied');
  assert.equal(db.failConversationInterrupt('interrupt-inconclusive-1', {
    code: 'runtime-interrupt-inconclusive',
    message: 'native outcome unknown',
  }, 523), true);

  const retry = db.requestConversationInterrupt({
    ...ctx,
    requestId: 'interrupt-inconclusive-2',
    targetTurnId: active.turnId,
    now: 524,
  });
  assert.equal(retry.status, 'rejected');
  assert.equal(retry.error?.code, 'interrupt-in-progress');
  assert.match(retry.error?.message ?? '', /inconclusive/);
  assert.equal(db.settleConversationTurn({
    turnId: active.turnId,
    terminalEvent: { kind: 'turn-end', text: 'eventually finished', stopReason: 'complete' },
    terminalOutcome: 'completed',
    queueStatus: 'accepted',
    now: 525,
  }), true);
});

test('agent-envelope metadata survives durable claim but snapshot exposes only summary', () => {
  const ctx = context('agent');
  const result = db.enqueueConversationSend({
    ...ctx,
    commandId: 'agent-command',
    clientMessageId: 'agent-client',
    text: '__RAW_AGENT_ENVELOPE__',
    origin: 'agent-envelope',
    agentEnvelope: {
      runId: 'run-1',
      agentName: 'Researcher',
      status: 'waiting',
      summary: 'Agent has a question',
      detail: 'Details',
    },
    now: 600,
  });
  assert.equal(result.status, 'applied');
  assert.equal(db.getConversationQueueSnapshot(ctx.sessionId).items[0]?.text, 'Agent has a question');
  assert.equal(JSON.stringify(db.getConversationQueueSnapshot(ctx.sessionId)).includes('__RAW_AGENT_ENVELOPE__'), false);
  const claimed = db.claimNextConversationTurn(ctx.sessionId, 601)!;
  assert.equal(claimed.text, '__RAW_AGENT_ENVELOPE__');
  assert.equal(claimed.agentEnvelope?.agentName, 'Researcher');
  assert.equal(db.settleConversationTurn({
    turnId: claimed.turnId,
    terminalEvent: { kind: 'turn-end', text: 'agent done', stopReason: 'complete' },
    terminalOutcome: 'completed',
    queueStatus: 'accepted',
    now: 602,
  }), true);
});

test('boot recovery fails the uncertain delivering item once and preserves queued FIFO', () => {
  const ctx = context('recover');
  const first = enqueue(ctx, 'uncertain', 'r-c1', 'r-m1', 700);
  enqueue(ctx, 'survivor one', 'r-c2', 'r-m2', 701);
  enqueue(ctx, 'survivor two', 'r-c3', 'r-m3', 702);
  const active = db.claimNextConversationTurn(ctx.sessionId, 703)!;
  assert.equal(active.queueItemId, first.queueItemId);
  assert.deepEqual(db.recoverActiveConversationTurns(704), [active.turnId]);
  assert.deepEqual(db.recoverActiveConversationTurns(705), []);
  const snapshot = db.getConversationQueueSnapshot(ctx.sessionId);
  assert.deepEqual(snapshot.items.map((item) => [item.text, item.status]), [
    ['uncertain', 'failed'],
    ['survivor one', 'queued'],
    ['survivor two', 'queued'],
  ]);
  assert.equal(db.claimNextConversationTurn(ctx.sessionId, 706)?.text, 'survivor one');
  assert.ok(db.listProjectsWithQueuedConversationSends().includes(ctx.projectId));
  db.softDeleteProject(ctx.projectId);
  assert.equal(db.listProjectsWithQueuedConversationSends().includes(ctx.projectId), false);
});

test('session cancellation is ordered, idempotent, and leaves a delivering item untouched', () => {
  const ctx = context('cancel-queued');
  const first = enqueue(ctx, 'delivering', 'cancel-c1', 'cancel-m1', 750);
  const second = enqueue(ctx, 'queued', 'cancel-c2', 'cancel-m2', 751);
  const active = db.claimNextConversationTurn(ctx.sessionId, 752)!;
  assert.equal(active.queueItemId, first.queueItemId);
  const before = db.getConversationQueueSnapshot(ctx.sessionId);

  assert.throws(
    () => db.cancelQueuedConversationSends(ctx.sessionId, '   ', 753),
    /reason must be non-empty/,
  );
  assert.deepEqual(db.cancelQueuedConversationSends(ctx.sessionId, 'session ended', 754), [second.queueItemId]);
  const after = db.getConversationQueueSnapshot(ctx.sessionId);
  assert.equal(after.queueRevision, before.queueRevision + 1);
  assert.deepEqual(after.items.map((item) => [item.id, item.status]), [
    [first.queueItemId, 'delivering'],
  ]);

  const rawRows = db.getRawDb().prepare(`SELECT id, status, failure_reason
    FROM conversation_queue_items WHERE session_id = ? ORDER BY enqueue_position`).all(ctx.sessionId) as Array<{
      id: string;
      status: string;
      failure_reason: string | null;
    }>;
  assert.deepEqual(rawRows, [
    { id: first.queueItemId, status: 'delivering', failure_reason: null },
    { id: second.queueItemId, status: 'cancelled', failure_reason: 'session ended' },
  ]);
  const highWater = db.listConversationEvents(ctx.sessionId).length;
  assert.deepEqual(db.cancelQueuedConversationSends(ctx.sessionId, 'session ended again', 755), []);
  assert.equal(db.getConversationQueueSnapshot(ctx.sessionId).queueRevision, after.queueRevision);
  assert.equal(db.listConversationEvents(ctx.sessionId).length, highWater);
  assert.equal(db.settleConversationTurn({
    turnId: active.turnId,
    terminalEvent: { kind: 'turn-end', text: 'done', stopReason: 'complete' },
    terminalOutcome: 'completed',
    queueStatus: 'accepted',
    now: 756,
  }), true);
});

test('legacy-session boot quarantine cancels queued work with canonical event and outbox evidence', () => {
  const project = db.createProject({
    name: 'Legacy queue quarantine',
    slug: `legacy-queue-${db.newId().toLowerCase()}`,
    folderPath: '',
  });
  const sessionId = db.newId();
  const raw = db.getRawDb();
  const insertGuard = raw.prepare(`SELECT sql FROM sqlite_master
    WHERE type = 'trigger' AND name = 'orch_sessions_complete_stamp_insert_guard'`).get() as {
      sql: string;
    };
  raw.exec('DROP TRIGGER orch_sessions_complete_stamp_insert_guard');
  try {
    raw.prepare(`INSERT INTO orchestrator_sessions (
      id, project_id, selection_state, runtime_id, account_id, model,
      effort_state, effort, native_session_id, native_identity_state,
      continuation_state, continuation_attempt_id, title, status, ended_reason,
      started_at, ended_at, deleted_at
    ) VALUES (?, ?, 'legacy-unavailable', NULL, NULL, 'legacy-model',
      'legacy-unknown', NULL, 'legacy-native', 'legacy-untrusted',
      'legacy-unavailable', NULL, NULL, 'active', NULL, 1, NULL, NULL)`).run(
      sessionId,
      project.id,
    );
  } finally {
    raw.exec(insertGuard.sql);
  }

  const ctx = { projectId: project.id, conversationId: sessionId, sessionId };
  const queued = enqueue(ctx, 'must not run under guessed defaults', 'legacy-command', 'legacy-client', 780);
  raw.prepare(`UPDATE orchestrator_sessions
    SET status = 'ended', ended_reason = 'selection_unavailable', ended_at = 781
    WHERE id = ?`).run(sessionId);
  const eventsBefore = db.listConversationEvents(sessionId).length;

  assert.deepEqual(db.cancelLegacyUnavailableSessionQueues(782), [queued.queueItemId]);
  assert.deepEqual(db.getConversationQueueSnapshot(sessionId).items, []);
  const terminalQueueRow = raw.prepare(`SELECT status, failure_reason
    FROM conversation_queue_items WHERE id = ?`).get(queued.queueItemId) as {
      status: string;
      failure_reason: string;
    };
  assert.deepEqual(terminalQueueRow, {
    status: 'cancelled',
    failure_reason: 'runtime selection unavailable after migration',
  });
  const cancellation = db.listConversationEvents(sessionId).at(-1)!;
  assert.equal(db.listConversationEvents(sessionId).length, eventsBefore + 1);
  assert.equal(cancellation.eventType, 'send-state');
  assert.equal(
    (cancellation.payload as { item?: { status?: unknown } }).item?.status,
    'cancelled',
  );
  assert.equal(db.listUnrelayedConversationEvents().some((entry) =>
    entry.event.eventId === cancellation.eventId
  ), true);
  assert.deepEqual(db.cancelLegacyUnavailableSessionQueues(783), []);
});

test('project deletion atomically cancels FIFO state and refuses an active turn', () => {
  const busy = context('delete-busy');
  enqueue(busy, 'active', 'delete-busy-command', 'delete-busy-client', 730);
  const active = db.claimNextConversationTurn(busy.sessionId, 731)!;
  assert.deepEqual(db.softDeleteProjectConversationState(busy.projectId, 732), { status: 'active-turn' });
  assert.ok(db.getProjectById(busy.projectId));
  assert.equal(db.settleConversationTurn({
    turnId: active.turnId,
    terminalEvent: { kind: 'turn-end', text: 'done', stopReason: 'complete' },
    terminalOutcome: 'completed',
    queueStatus: 'accepted',
    now: 733,
  }), true);

  const idle = context('delete-idle');
  const queued = enqueue(idle, 'cancel on delete', 'delete-idle-command', 'delete-idle-client', 734);
  const deleted = db.softDeleteProjectConversationState(idle.projectId, 735);
  assert.equal(deleted.status, 'deleted');
  assert.equal(db.getProjectById(idle.projectId), null);
  assert.equal(db.getActiveOrchestratorSession(idle.projectId), null);
  assert.deepEqual(db.getConversationQueueSnapshot(idle.sessionId).items, []);
  const raw = db.getRawDb().prepare(
    'SELECT status, failure_reason FROM conversation_queue_items WHERE id = ?',
  ).get(queued.queueItemId) as { status: string; failure_reason: string };
  assert.deepEqual(raw, { status: 'cancelled', failure_reason: 'project deleted' });
  assert.equal(enqueue(idle, 'must reject', 'delete-after-command', 'delete-after-client', 736).status, 'rejected');
});

test('closeOrchestratorSession ends the active session, drains its queue, and leaves none', () => {
  const ctx = context('close-session');
  const queued = enqueue(ctx, 'drain me', 'close-c1', 'close-m1', 800);

  // Optimistic concurrency: a stale expectation is refused, session untouched.
  assert.throws(() => db.closeOrchestratorSession({
    projectId: ctx.projectId,
    expectedSessionId: db.newId(),
    queueCancellationReason: 'session closed',
    now: 801,
  }), /active session changed/);
  assert.equal(db.getActiveOrchestratorSession(ctx.projectId)?.id, ctx.sessionId);

  const result = db.closeOrchestratorSession({
    projectId: ctx.projectId,
    expectedSessionId: ctx.sessionId,
    queueCancellationReason: 'session closed',
    now: 802,
  });
  assert.equal(result.endedSessionId, ctx.sessionId);
  assert.deepEqual(result.cancelledQueueItemIds, [queued.queueItemId]);
  assert.equal(db.getActiveOrchestratorSession(ctx.projectId), null);
  assert.equal(db.getOrchestratorSession(ctx.sessionId)?.status, 'ended');
  assert.equal(db.getOrchestratorSession(ctx.sessionId)?.endedReason, 'user_ended');

  // Idempotent: closing a project that is already session-less is a no-op.
  assert.deepEqual(db.closeOrchestratorSession({
    projectId: ctx.projectId,
    expectedSessionId: null,
    queueCancellationReason: 'already none',
    now: 803,
  }), { endedSessionId: null, cancelledQueueItemIds: [] });
});

test('closeOrchestratorSession refuses to close while a turn is active', () => {
  const busy = context('close-busy');
  enqueue(busy, 'active', 'close-c2', 'close-m2', 810);
  db.claimNextConversationTurn(busy.sessionId, 811)!;
  assert.throws(() => db.closeOrchestratorSession({
    projectId: busy.projectId,
    expectedSessionId: busy.sessionId,
    queueCancellationReason: 'session closed',
    now: 812,
  }), /turn is active/);
  assert.equal(db.getActiveOrchestratorSession(busy.projectId)?.id, busy.sessionId);
});

test('historical resume rolls back old FIFO/session if target activation fails', () => {
  const project = db.createProject({
    name: 'Resume rollback', slug: `resume-rollback-${db.newId().toLowerCase()}`, folderPath: '',
  });
  const target = db.createOrchestratorSession({ projectId: project.id, selection: TEST_SELECTION });
  const targetAttempt = db.prepareRuntimeSessionCreate(target.id)!;
  assert.equal(db.confirmRuntimeSessionReceipt({
    sessionId: target.id,
    receipt: {
      mode: 'created',
      continuationAttemptId: targetAttempt.continuationAttemptId!,
      selection: TEST_SELECTION,
      nativeSessionId: 'native-target',
      requestedNativeSessionId: null,
    },
  }).status, 'confirmed');
  db.endOrchestratorSession(target.id, 'user_ended');
  const current = db.createOrchestratorSession({ projectId: project.id, selection: TEST_SELECTION });
  const ctx = { projectId: project.id, conversationId: current.id, sessionId: current.id };
  const queued = enqueue(ctx, 'preserve current queue', 'resume-r-command', 'resume-r-client', 740);
  const raw = db.getRawDb();
  raw.exec(`
    CREATE TEMP TRIGGER fail_target_reactivation
    BEFORE UPDATE OF status ON orchestrator_sessions
    WHEN NEW.id = '${target.id}' AND NEW.status = 'active'
    BEGIN SELECT RAISE(ABORT, 'forced target activation failure'); END;
  `);
  assert.throws(() => db.resumeOrchestratorSessionTransition({
    projectId: project.id,
    expectedSessionId: current.id,
    targetSessionId: target.id,
    queueCancellationReason: 'resume target',
    now: 741,
  }), /forced target activation failure/);
  raw.exec('DROP TRIGGER fail_target_reactivation');
  assert.equal(db.getActiveOrchestratorSession(project.id)?.id, current.id);
  assert.equal(db.getOrchestratorSession(target.id)?.status, 'ended');
  assert.equal(
    db.getConversationQueueSnapshot(current.id).items.find((item) => item.id === queued.queueItemId)?.status,
    'queued',
  );
});

test('session cancellation rolls back the whole failed + queued batch when outbox publication fails', () => {
  const ctx = context('cancel-rollback');
  const accepted = enqueue(ctx, 'active', 'cancel-r-c1', 'cancel-r-m1', 760);
  const active = db.claimNextConversationTurn(ctx.sessionId, 761)!;
  const failed = enqueue(ctx, 'will fail closed', 'cancel-r-c2', 'cancel-r-m2', 762);
  assert.equal(db.requestConversationInterrupt({
    ...ctx,
    requestId: 'cancel-r-interrupt',
    targetTurnId: active.turnId,
    replacement: { kind: 'queued', queueItemId: failed.queueItemId!, expectedRevision: 1 },
    now: 763,
  }).status, 'applied');
  assert.equal(db.settleConversationTurn({
    turnId: active.turnId,
    terminalEvent: { kind: 'turn-end', text: 'finished normally', stopReason: 'complete' },
    terminalOutcome: 'completed',
    queueStatus: 'accepted',
    now: 764,
  }), true);
  const queued = enqueue(ctx, 'still queued', 'cancel-r-c3', 'cancel-r-m3', 765);
  const before = db.getConversationQueueSnapshot(ctx.sessionId);
  assert.deepEqual(before.items.map((item) => [item.id, item.status]), [
    [failed.queueItemId, 'failed'],
    [queued.queueItemId, 'queued'],
  ]);

  const raw = db.getRawDb();
  raw.exec(`
    CREATE TEMP TRIGGER fail_cancel_queue_outbox
    BEFORE INSERT ON conversation_outbox
    BEGIN SELECT RAISE(ABORT, 'forced cancellation outbox failure'); END;
  `);
  assert.throws(
    () => db.cancelQueuedConversationSends(ctx.sessionId, 'session switched', 766),
    /forced cancellation outbox failure/,
  );
  raw.exec('DROP TRIGGER fail_cancel_queue_outbox');
  assert.deepEqual(db.getConversationQueueSnapshot(ctx.sessionId), before);

  assert.deepEqual(
    db.cancelQueuedConversationSends(ctx.sessionId, 'session switched', 767),
    [failed.queueItemId, queued.queueItemId],
  );
  const after = db.getConversationQueueSnapshot(ctx.sessionId);
  assert.equal(after.queueRevision, before.queueRevision + 2);
  assert.deepEqual(after.items, []);
  const rows = raw.prepare(`SELECT id, status, failure_reason
    FROM conversation_queue_items WHERE session_id = ? ORDER BY enqueue_position`).all(ctx.sessionId) as Array<{
      id: string;
      status: string;
      failure_reason: string | null;
    }>;
  assert.deepEqual(rows, [
    { id: accepted.queueItemId, status: 'accepted', failure_reason: null },
    { id: failed.queueItemId, status: 'cancelled', failure_reason: 'session switched' },
    { id: queued.queueItemId, status: 'cancelled', failure_reason: 'session switched' },
  ]);
  const cancellationEvents = db.listConversationEvents(ctx.sessionId).slice(-2);
  assert.deepEqual(cancellationEvents.map((event) => event.eventType), ['send-state', 'send-state']);
  assert.deepEqual(
    cancellationEvents.map((event) => (event.payload as { queueRevision: number }).queueRevision),
    [before.queueRevision + 1, before.queueRevision + 2],
  );
});

test('forced conversation outbox failure rolls back queue row, revision, and queue cursor', () => {
  const ctx = context('rollback');
  const raw = db.getRawDb();
  raw.exec(`
    CREATE TEMP TRIGGER fail_queue_event_outbox
    BEFORE INSERT ON conversation_outbox
    BEGIN SELECT RAISE(ABORT, 'forced queue outbox failure'); END;
  `);
  assert.throws(() => enqueue(ctx, 'no partial state', 'rollback-command', 'rollback-client', 800), /forced queue outbox failure/);
  raw.exec('DROP TRIGGER fail_queue_event_outbox');
  assert.deepEqual(db.getConversationQueueSnapshot(ctx.sessionId), { queueRevision: 0, items: [] });
  const retry = enqueue(ctx, 'no partial state', 'rollback-command', 'rollback-client', 801);
  assert.equal(retry.status, 'applied');
  assert.equal(db.getConversationQueueSnapshot(ctx.sessionId).items[0]?.enqueuePosition, 1);
});

test('outbox failure rolls back edit, claim, interrupt-link, and terminal transitions', () => {
  const raw = db.getRawDb();
  const failOutbox = () => raw.exec(`
    CREATE TEMP TRIGGER fail_send_control_outbox
    BEFORE INSERT ON conversation_outbox
    BEGIN SELECT RAISE(ABORT, 'forced send control outbox failure'); END;
  `);
  const restoreOutbox = () => raw.exec('DROP TRIGGER fail_send_control_outbox');

  const editCtx = context('rollback-edit');
  const editable = enqueue(editCtx, 'before edit', 'rollback-edit-send', 'rollback-edit-client', 900);
  failOutbox();
  assert.throws(() => db.editQueuedConversationSend({
    ...editCtx,
    commandId: 'rollback-edit-command',
    queueItemId: editable.queueItemId!,
    expectedRevision: 1,
    text: 'after edit',
    now: 901,
  }), /forced send control outbox failure/);
  restoreOutbox();
  assert.deepEqual(
    db.getConversationQueueSnapshot(editCtx.sessionId).items.map((item) => [item.text, item.revision]),
    [['before edit', 1]],
  );
  assert.equal(db.editQueuedConversationSend({
    ...editCtx,
    commandId: 'rollback-edit-command',
    queueItemId: editable.queueItemId!,
    expectedRevision: 1,
    text: 'after edit',
    now: 902,
  }).status, 'applied');

  const turnCtx = context('rollback-turn');
  enqueue(turnCtx, 'active', 'rollback-turn-send', 'rollback-turn-client', 910);
  failOutbox();
  assert.throws(
    () => db.claimNextConversationTurn(turnCtx.sessionId, 911),
    /forced send control outbox failure/,
  );
  restoreOutbox();
  assert.equal(db.getConversationQueueSnapshot(turnCtx.sessionId).items[0]?.status, 'queued');
  assert.equal(db.getActiveConversationTurn(turnCtx.sessionId), null);

  const active = db.claimNextConversationTurn(turnCtx.sessionId, 912)!;
  const next = enqueue(turnCtx, 'replacement', 'rollback-next-send', 'rollback-next-client', 913);
  failOutbox();
  assert.throws(() => db.requestConversationInterrupt({
    ...turnCtx,
    requestId: 'rollback-interrupt',
    targetTurnId: active.turnId,
    replacement: { kind: 'queued', queueItemId: next.queueItemId!, expectedRevision: 1 },
    now: 914,
  }), /forced send control outbox failure/);
  restoreOutbox();
  assert.equal(db.getTurnInterruptRequest('rollback-interrupt'), null);
  assert.equal(
    db.getConversationQueueSnapshot(turnCtx.sessionId).items.find((item) => item.id === next.queueItemId)?.interruptRequestId,
    null,
  );

  assert.equal(db.requestConversationInterrupt({
    ...turnCtx,
    requestId: 'rollback-interrupt',
    targetTurnId: active.turnId,
    replacement: { kind: 'queued', queueItemId: next.queueItemId!, expectedRevision: 1 },
    now: 915,
  }).status, 'applied');
  failOutbox();
  assert.throws(() => db.settleConversationTurn({
    turnId: active.turnId,
    terminalEvent: { kind: 'turn-failed', error: 'interrupted', source: 'abort' },
    terminalOutcome: 'aborted',
    queueStatus: 'accepted',
    now: 916,
  }), /forced send control outbox failure/);
  restoreOutbox();
  assert.equal(db.getActiveConversationTurn(turnCtx.sessionId)?.id, active.turnId);
  assert.equal(db.getTurnInterruptRequest('rollback-interrupt')?.status, 'requested');
  assert.equal(db.getConversationQueueSnapshot(turnCtx.sessionId).items[0]?.status, 'delivering');

  assert.equal(db.settleConversationTurn({
    turnId: active.turnId,
    terminalEvent: { kind: 'turn-failed', error: 'interrupted', source: 'abort' },
    terminalOutcome: 'aborted',
    queueStatus: 'accepted',
    now: 917,
  }), true);
  assert.equal(db.getTurnInterruptRequest('rollback-interrupt')?.status, 'confirmed');
  const replacement = db.claimNextConversationTurn(turnCtx.sessionId, 918)!;
  assert.equal(replacement.queueItemId, next.queueItemId);
  assert.equal(db.settleConversationTurn({
    turnId: replacement.turnId,
    terminalEvent: { kind: 'turn-end', text: 'done', stopReason: 'complete' },
    terminalOutcome: 'completed',
    queueStatus: 'accepted',
    now: 919,
  }), true);
});
