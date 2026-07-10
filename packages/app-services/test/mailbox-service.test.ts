import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  MailboxService,
  type MailboxServiceDeps,
} from '../src/mailbox/index.ts';
import type {
  DbExecutor,
  InsertLiveEventDraft,
  LiveOutboxEvent,
  MailboxDeliveryRow,
  MailboxMessageRow,
  MailboxRecipientRow,
} from '@pc/db';

let seq = 0;
function fakeInsert<TPayload>(_db: DbExecutor, draft: InsertLiveEventDraft<TPayload>): LiveOutboxEvent<TPayload> {
  seq += 1;
  return {
    id: `evt-${seq}` as never,
    cursor: String(seq),
    scope: draft.scope,
    projectId: draft.projectId,
    entity: draft.entity,
    type: draft.type,
    entityId: draft.entityId,
    version: draft.version,
    createdAt: 1000 + seq,
    payload: draft.payload,
  } as LiveOutboxEvent<TPayload>;
}

function message(over: Partial<MailboxMessageRow> = {}): MailboxMessageRow {
  return {
    id: 'm1' as never,
    projectId: 'p1' as never,
    kind: 'system-notice',
    subject: null,
    body: 'hi',
    payload: {},
    sourceKind: 'system',
    sourceId: null,
    idempotencyKey: 'k1',
    createdAt: 1,
    updatedAt: 1,
    ...over,
  } as MailboxMessageRow;
}

function recipient(over: Partial<MailboxRecipientRow> = {}): MailboxRecipientRow {
  return {
    id: 'r1' as never,
    messageId: 'm1' as never,
    addressKind: 'project-inbox',
    addressJson: { kind: 'project-inbox', projectId: 'p1' },
    readAt: null,
    actionedAt: null,
    dismissedAt: null,
    createdAt: 1,
    ...over,
  } as MailboxRecipientRow;
}

function delivery(over: Partial<MailboxDeliveryRow> = {}): MailboxDeliveryRow {
  return {
    id: 'd1' as never,
    messageId: 'm1' as never,
    recipientId: 'r1' as never,
    channel: 'ui-inbox',
    status: 'pending',
    leaseOwner: null,
    leaseExpiresAt: null,
    attempts: 0,
    nextAttemptAt: 1,
    targetRefKind: null,
    targetRefId: null,
    lastError: null,
    createdAt: 1,
    updatedAt: 1,
    acceptedAt: null,
    failedAt: null,
    ...over,
  } as MailboxDeliveryRow;
}

function mailboxHarness(
  opts: { failTx?: boolean; msg?: MailboxMessageRow; enqueueCreated?: boolean } = {},
) {
  const inserted: InsertLiveEventDraft[] = [];
  const enqueued: Parameters<NonNullable<MailboxServiceDeps['enqueueMailboxMessage']>>[0][] = [];
  const msg = opts.msg ?? message();
  const deps: MailboxServiceDeps = {
    transaction: (fn) => {
      if (opts.failTx) throw new Error('forced tx failure');
      return fn({} as DbExecutor);
    },
    insertLiveEvent: ((db, draft) => {
      inserted.push(draft as InsertLiveEventDraft);
      return fakeInsert(db, draft);
    }) as MailboxServiceDeps['insertLiveEvent'],
    enqueueMailboxMessage: (input) => {
      enqueued.push(input);
      return {
        message: msg,
        recipients: [recipient()],
        deliveries: [delivery()],
        created: opts.enqueueCreated ?? true,
      };
    },
    getMailboxMessage: () => msg,
    listRecipientsForMessage: () => [recipient()],
    markDeliveryAccepted: () => delivery({ status: 'accepted', attempts: 1, targetRefKind: 'ui-inbox', targetRefId: 'ui1' }),
    markDeliveryRetrying: () => delivery({ status: 'retrying', attempts: 1, nextAttemptAt: 9999 }),
    markDeliveryDeadLettered: () => delivery({ status: 'dead-lettered', attempts: 3 }),
    markRecipientRead: () => recipient({ readAt: 5 }),
    markRecipientActioned: () => recipient({ actionedAt: 6 }),
    markRecipientDismissed: () => recipient({ dismissedAt: 7 }),
    writeAudit: () => undefined,
    newId: (() => {
      let n = 0;
      return () => `nid-${++n}` as never;
    })(),
  };
  return { service: new MailboxService(deps), inserted, enqueued };
}

test('enqueue emits one signal-only mailbox-message fact (project scope)', () => {
  const { service, inserted } = mailboxHarness();
  const pub = service.enqueue({
    message: { id: 'm1' as never, projectId: 'p1' as never, kind: 'system-notice', body: 'hi', sourceKind: 'system', idempotencyKey: 'k1' },
    recipients: [{ id: 'r1' as never, addressKind: 'project-inbox', addressJson: {}, channel: 'ui-inbox', deliveryId: 'd1' as never }],
    now: 1,
  });
  assert.equal(inserted.length, 1);
  assert.equal(pub.liveEvent.entity, 'mailbox-message');
  assert.equal(pub.liveEvent.type, 'mailbox-message.changed');
  assert.equal(pub.liveEvent.scope, 'project');
  assert.equal(pub.liveEvent.payload.messageId, 'm1');
});

test('a project-less message emits scope:global + projectId:null', () => {
  const { service, inserted } = mailboxHarness({ msg: message({ projectId: null }) });
  const pub = service.enqueue({
    message: { id: 'm1' as never, projectId: null, kind: 'system-notice', body: 'hi', sourceKind: 'system', idempotencyKey: 'k1' },
    recipients: [{ id: 'r1' as never, addressKind: 'user-inbox', addressJson: {}, channel: 'ui-inbox', deliveryId: 'd1' as never }],
    now: 1,
  });
  assert.equal(pub.liveEvent.scope, 'global');
  assert.equal(pub.liveEvent.projectId, null);
  assert.equal(inserted.length, 1);
});

test('a rollback emits nothing (no orphan outbox row)', () => {
  const { service, inserted } = mailboxHarness({ failTx: true });
  assert.throws(() =>
    service.enqueue({
      message: { id: 'm1' as never, projectId: 'p1' as never, kind: 'system-notice', body: 'hi', sourceKind: 'system', idempotencyKey: 'k1' },
      recipients: [{ id: 'r1' as never, addressKind: 'project-inbox', addressJson: {}, channel: 'ui-inbox', deliveryId: 'd1' as never }],
      now: 1,
    }),
  );
  assert.equal(inserted.length, 0);
});

test('accept/retry/dead-letter each emit a signal keyed by the delivery message', () => {
  const accept = mailboxHarness();
  const a = accept.service.acceptDelivery({ deliveryId: 'd1' as never, targetRefKind: 'ui-inbox', targetRefId: 'ui1', now: 1 });
  assert.ok(a);
  assert.equal(a!.liveEvent.entity, 'mailbox-message');
  assert.equal(a!.liveEvent.payload.messageId, 'm1');

  const retry = mailboxHarness();
  const r = retry.service.retryDelivery({ deliveryId: 'd1' as never, lastError: 'boom', nextAttemptAt: 9999, now: 1 });
  assert.ok(r);
  assert.equal(r!.liveEvent.payload.messageId, 'm1');

  const dl = mailboxHarness();
  const d = dl.service.deadLetterDelivery({ deliveryId: 'd1' as never, messageId: 'm1' as never, recipientId: 'r1' as never, reason: 'max', lastError: 'x', now: 1 });
  assert.ok(d);
  assert.equal(d!.liveEvent.payload.messageId, 'm1');
});

test('recipient read/action/dismiss re-emits the message signal', () => {
  const h = mailboxHarness();
  const read = h.service.markRead('r1' as never, 5);
  assert.ok(read);
  assert.equal(read!.liveEvent.entity, 'mailbox-message');
  assert.equal(read!.liveEvent.entityId, 'm1');
  assert.equal(read!.liveEvent.payload.messageId, 'm1');
});

// ── M4b (FD-8) — a dead letter is never silent ───────────────────────────────

test('M4b — dead-lettering a delivery mints ONE active-orchestrator system-notice in the same tx', () => {
  const h = mailboxHarness();
  const d = h.service.deadLetterDelivery({
    deliveryId: 'd1' as never,
    messageId: 'm1' as never,
    recipientId: 'r1' as never,
    reason: 'non-retryable',
    lastError: 'orchestrator session does not exist: x',
    now: 9,
  });
  assert.ok(d);
  assert.equal(h.enqueued.length, 1);
  const notice = h.enqueued[0]!;
  assert.equal(notice.message.kind, 'system-notice');
  assert.equal(notice.message.sourceKind, 'mailbox-dead-letter');
  assert.equal(notice.message.sourceId, 'd1');
  assert.equal(notice.message.idempotencyKey, 'dead-letter:d1');
  assert.match(notice.message.subject ?? '', /could not be delivered/);
  assert.match(notice.message.body, /non-retryable: orchestrator session does not exist/);
  assert.equal(notice.recipients.length, 1);
  assert.equal(notice.recipients[0]!.addressKind, 'active-orchestrator');
  assert.equal(notice.recipients[0]!.channel, 'orchestrator-turn');
  // Two signals: the delivery-state signal + the notice's message signal.
  assert.equal(h.inserted.length, 2);
  assert.equal(h.inserted[0]!.type, 'mailbox-message.changed');
  assert.equal(h.inserted[1]!.type, 'mailbox-message.changed');
});

test('M4b — recursion guard: a notice that itself dead-letters is NOT re-noticed', () => {
  const h = mailboxHarness({ msg: message({ sourceKind: 'mailbox-dead-letter' }) });
  const d = h.service.deadLetterDelivery({
    deliveryId: 'd1' as never,
    messageId: 'm1' as never,
    recipientId: 'r1' as never,
    reason: 'max-retries',
    lastError: null,
    now: 9,
  });
  assert.ok(d);
  assert.equal(h.enqueued.length, 0);
  assert.equal(h.inserted.length, 1); // delivery signal only
});

test('M4b — a replayed dead-letter (idempotent enqueue hit) emits no duplicate message signal', () => {
  const h = mailboxHarness({ enqueueCreated: false });
  const d = h.service.deadLetterDelivery({
    deliveryId: 'd1' as never,
    messageId: 'm1' as never,
    recipientId: 'r1' as never,
    reason: 'max-retries',
    lastError: 'boom',
    now: 9,
  });
  assert.ok(d);
  assert.equal(h.enqueued.length, 1);
  assert.equal(h.inserted.length, 1); // delivery signal only — created:false emits nothing
});
