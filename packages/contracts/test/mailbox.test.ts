import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  isMailboxDeliveryDto,
  isMailboxMessageDto,
  isMailboxRecipientDto,
  parseEnqueueMailboxMessageRequest,
  parseListMailboxQuery,
  parseMailboxAddress,
  type MailboxAddress,
} from '../src/index.ts';

test('parseMailboxAddress accepts every kind and rejects missing ids', () => {
  assert.equal(parseMailboxAddress({ kind: 'user-inbox', userId: 'local-user', projectId: null }).ok, true);
  assert.equal(parseMailboxAddress({ kind: 'user-inbox', userId: 'local-user', projectId: 'p1' }).ok, true);
  assert.equal(parseMailboxAddress({ kind: 'user-inbox', userId: 'someone', projectId: null }).ok, false);
  assert.equal(parseMailboxAddress({ kind: 'project-inbox', projectId: 'p1' }).ok, true);
  assert.equal(parseMailboxAddress({ kind: 'project-inbox' }).ok, false);
  assert.equal(parseMailboxAddress({ kind: 'active-orchestrator', projectId: 'p1' }).ok, true);
  assert.equal(
    parseMailboxAddress({ kind: 'orchestrator-session', projectId: 'p1', sessionId: 's1' }).ok,
    true,
  );
  assert.equal(parseMailboxAddress({ kind: 'orchestrator-session', projectId: 'p1' }).ok, false);
  assert.equal(parseMailboxAddress({ kind: 'agent-run', projectId: 'p1', agentRunId: 'r1' }).ok, true);
  assert.equal(parseMailboxAddress({ kind: 'agent-run', projectId: 'p1' }).ok, false);
  assert.equal(
    parseMailboxAddress({ kind: 'workflow-review', projectId: 'p1', workflowRunId: 'w1', nodeId: 'n1' }).ok,
    true,
  );
  assert.equal(parseMailboxAddress({ kind: 'workflow-review', projectId: 'p1', workflowRunId: 'w1' }).ok, false);
  assert.equal(parseMailboxAddress({ kind: 'nope' }).ok, false);
});

test('parseEnqueueMailboxMessageRequest validates kind/body/idempotency/recipients', () => {
  const ok = parseEnqueueMailboxMessageRequest({
    kind: 'system-notice',
    body: 'hello',
    idempotencyKey: 'k1',
    recipients: [{ address: { kind: 'project-inbox', projectId: 'p1' }, channel: 'ui-inbox' }],
  });
  assert.equal(ok.ok, true);

  assert.equal(
    parseEnqueueMailboxMessageRequest({
      kind: 'system-notice',
      body: 'x',
      idempotencyKey: '',
      recipients: [{ address: { kind: 'project-inbox', projectId: 'p1' }, channel: 'ui-inbox' }],
    }).ok,
    false,
  );
  assert.equal(
    parseEnqueueMailboxMessageRequest({
      kind: 'system-notice',
      body: 'x',
      idempotencyKey: 'k',
      recipients: [],
    }).ok,
    false,
  );
  assert.equal(
    parseEnqueueMailboxMessageRequest({
      kind: 'system-notice',
      body: 'x',
      idempotencyKey: 'k',
      recipients: [{ address: { kind: 'project-inbox' }, channel: 'ui-inbox' }],
    }).ok,
    false,
  );
  assert.equal(
    parseEnqueueMailboxMessageRequest({
      kind: 'system-notice',
      body: 'x',
      idempotencyKey: 'k',
      recipients: [{ address: { kind: 'project-inbox', projectId: 'p1' }, channel: 'bogus' }],
    }).ok,
    false,
  );
});

test('dropped message kinds are rejected by the enqueue parser', () => {
  for (const kind of ['workflow-run-failed', 'workflow-first-run-review', 'runtime-hook-ask', 'verification-review']) {
    assert.equal(
      parseEnqueueMailboxMessageRequest({
        kind,
        body: 'x',
        idempotencyKey: 'k',
        recipients: [{ address: { kind: 'project-inbox', projectId: 'p1' }, channel: 'ui-inbox' }],
      }).ok,
      false,
      `kind ${kind} must be rejected`,
    );
  }
});

test('parseListMailboxQuery reads unread/actionable flags', () => {
  assert.deepEqual(parseListMailboxQuery({ unreadOnly: '1' }), {
    ok: true,
    value: { unreadOnly: true },
  });
  assert.deepEqual(parseListMailboxQuery({}), { ok: true, value: {} });
  assert.deepEqual(parseListMailboxQuery({ actionableOnly: true }), {
    ok: true,
    value: { actionableOnly: true },
  });
});

test('DTO guards', () => {
  const address: MailboxAddress = { kind: 'project-inbox', projectId: 'p1' };
  assert.equal(
    isMailboxMessageDto({
      id: 'm1',
      projectId: 'p1',
      kind: 'system-notice',
      subject: null,
      body: 'hi',
      payload: {},
      source: { kind: 'system', id: null },
      idempotencyKey: 'k',
      createdAt: 1,
      updatedAt: 1,
    }),
    true,
  );
  assert.equal(isMailboxMessageDto({ id: 'm1', kind: 'bogus' }), false);
  assert.equal(
    isMailboxRecipientDto({
      id: 'r1',
      messageId: 'm1',
      address,
      readAt: null,
      actionedAt: null,
      dismissedAt: null,
    }),
    true,
  );
  assert.equal(
    isMailboxDeliveryDto({
      id: 'd1',
      messageId: 'm1',
      recipientId: 'r1',
      channel: 'ui-inbox',
      status: 'pending',
      attempts: 0,
      nextAttemptAt: null,
      targetRef: { kind: null, id: null },
      lastError: null,
      createdAt: 1,
      updatedAt: 1,
    }),
    true,
  );
});
