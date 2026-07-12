// Passive subscription-quota integration guards. Runtime telemetry is admitted
// only after a positive session receipt, updates the durable quota component,
// and never becomes conversation content or controls turn success.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { SubscriptionQuotaService } from '@pc/app-services';
import type { SubscriptionQuotaObservationBatch } from '@pc/contracts';
import { listConversationEvents, listLiveOutboxRowsAfter } from '@pc/db';
import { SessionService } from '../src/chat/session-service.ts';
import { FakeRuntime } from '../src/runner/fake-runtime.ts';
import { freshDb, newProject, until } from './helpers.ts';
import {
  TEST_RUNTIME_ID,
  testSessionSelectionDeps,
  withRuntimeReceipt,
} from './runtime-fixtures.ts';

function availableBatch(
  runtimeId = TEST_RUNTIME_ID,
  accountId = 'personal',
): SubscriptionQuotaObservationBatch {
  return {
    runtimeId,
    accountId,
    availability: 'available',
    coverage: 'complete',
    observedAt: 7_000,
    observations: [{
      window: { id: 'five-hour', label: '5h', durationMs: 18_000_000 },
      scope: { kind: 'account' },
      source: { semantics: 'remaining', fraction: 0.3 },
      confidence: 'exact',
      limitState: 'warning',
      resetsAt: 10_000,
    }],
  };
}

function isTerminal(eventType: string): boolean {
  return eventType === 'turn-end' || eventType === 'turn-failed';
}

test('an attributed orchestrator observation passively updates durable quota truth', async () => {
  freshDb();
  const project = newProject('passive quota');
  const quota = new SubscriptionQuotaService();
  const batch = availableBatch();
  const runtime = new FakeRuntime({
    turns: [[
      { type: 'subscription-quota', batch },
      {
        type: 'result',
        ok: true,
        stopReason: 'complete',
        usage: null,
        durationMs: 1,
        error: null,
        outcome: 'ok',
        numTurns: null,
      },
    ]],
  });
  const sessionService = new SessionService({
    projectId: project.id,
    broadcast: () => {},
    mintSession: withRuntimeReceipt(() => runtime),
    ...testSessionSelectionDeps(),
    onSubscriptionQuota: (observation) => {
      quota.record(observation);
    },
  });
  const session = await sessionService.ensureActiveSession();

  const result = await sessionService.handleSend({
    type: 'send',
    commandId: 'quota-command',
    sessionId: session.id,
    text: 'hello',
    clientMessageId: 'quota-client-message',
  });
  assert.equal(result.status, 'applied');
  await until(() => quota.get(TEST_RUNTIME_ID, 'personal') !== null);
  await until(() => listConversationEvents(session.id).some((row) => isTerminal(row.eventType)));

  const snapshot = quota.get(TEST_RUNTIME_ID, 'personal');
  assert.ok(snapshot);
  assert.equal(snapshot.revision, 1);
  assert.equal(snapshot.availability, 'available');
  assert.equal(snapshot.observations[0]?.source.semantics, 'remaining');
  assert.equal(snapshot.observations[0]?.usedFraction, 0.7);
  assert.equal(snapshot.observations[0]?.confidence, 'derived');
  const quotaEvents = listLiveOutboxRowsAfter('0', 100)
    .filter((row) => row.entity === 'subscription-quota');
  assert.equal(quotaEvents.length, 1);
  assert.equal(quotaEvents[0]?.entityId, snapshot.id);

  const conversationRows = listConversationEvents(session.id);
  assert.equal(
    conversationRows.some((row) =>
      (row.payload as unknown as { kind?: string }).kind === 'subscription-quota'),
    false,
    'quota telemetry must not enter the conversation transcript',
  );
  assert.equal(
    conversationRows.find((row) => isTerminal(row.eventType))?.eventType,
    'turn-end',
  );
  await sessionService.dispose();
});

test('mismatched orchestrator quota attribution is dropped without failing the turn', async () => {
  freshDb();
  const project = newProject('mismatched quota');
  const quota = new SubscriptionQuotaService();
  const runtime = new FakeRuntime({
    turns: [[
      { type: 'subscription-quota', batch: availableBatch('peer-runtime', 'personal') },
      {
        type: 'result',
        ok: true,
        stopReason: 'complete',
        usage: null,
        durationMs: 1,
        error: null,
        outcome: 'ok',
        numTurns: null,
      },
    ]],
  });
  const sessionService = new SessionService({
    projectId: project.id,
    broadcast: () => {},
    mintSession: withRuntimeReceipt(() => runtime),
    ...testSessionSelectionDeps(),
    onSubscriptionQuota: (observation) => {
      quota.record(observation);
    },
  });
  const session = await sessionService.ensureActiveSession();

  await sessionService.handleSend({
    type: 'send',
    commandId: 'mismatch-command',
    sessionId: session.id,
    text: 'continue',
    clientMessageId: 'mismatch-client-message',
  });
  await until(() => listConversationEvents(session.id).some((row) => isTerminal(row.eventType)));

  assert.deepEqual(quota.list(), []);
  assert.equal(
    listConversationEvents(session.id).find((row) => isTerminal(row.eventType))?.eventType,
    'turn-end',
  );
  await sessionService.dispose();
});

test('future passive evidence is isolated and a later normal event in the turn recovers', async () => {
  freshDb();
  const project = newProject('future passive quota');
  const receiptTime = 8_000;
  const quota = new SubscriptionQuotaService({ now: () => receiptTime });
  const runtime = new FakeRuntime({
    turns: [[
      {
        type: 'subscription-quota',
        batch: { ...availableBatch(), observedAt: Number.MAX_SAFE_INTEGER },
      },
      {
        type: 'subscription-quota',
        batch: { ...availableBatch(), observedAt: receiptTime },
      },
      {
        type: 'result', ok: true, stopReason: 'complete', usage: null,
        durationMs: 1, error: null, outcome: 'ok', numTurns: null,
      },
    ]],
  });
  const sessionService = new SessionService({
    projectId: project.id,
    broadcast: () => {},
    mintSession: withRuntimeReceipt(() => runtime),
    ...testSessionSelectionDeps(),
    onSubscriptionQuota: (observation) => { quota.record(observation); },
  });
  const session = await sessionService.ensureActiveSession();
  await sessionService.handleSend({
    type: 'send', commandId: 'future-passive-command', sessionId: session.id,
    text: 'continue', clientMessageId: 'future-passive-client',
  });
  await until(() => listConversationEvents(session.id).some((row) => isTerminal(row.eventType)));

  const recovered = quota.get(TEST_RUNTIME_ID, 'personal');
  assert.ok(recovered);
  assert.equal(recovered.revision, 1);
  assert.equal(recovered.observedAt, receiptTime);
  assert.equal(
    listConversationEvents(session.id).find((row) => isTerminal(row.eventType))?.eventType,
    'turn-end',
  );
  await sessionService.dispose();
});
