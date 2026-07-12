import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { RuntimeSelection, RuntimeSessionReceipt } from '@pc/contracts';

const tmpDir = mkdtempSync(join(tmpdir(), 'pc-runtime-session-selection-'));
process.env.PC_DATA_DIR = tmpDir;

const db = await import('../src/index.ts');

before(() => db.runMigrations());
after(() => {
  db.closeDb();
  rmSync(tmpDir, { recursive: true, force: true });
});

function selection(
  accountId = 'account-a',
  effort: RuntimeSelection['effort'] = { kind: 'none' },
): RuntimeSelection {
  return { runtimeId: 'runtime-a', accountId, model: 'model-a', effort };
}

function project(name: string) {
  return db.createProject({
    name,
    slug: `${name.toLowerCase().replace(/\s+/g, '-')}-${db.newId().toLowerCase()}`,
    folderPath: '',
  });
}

function createdReceipt(
  session: { id: string; continuationAttemptId: string | null },
  selected: RuntimeSelection,
  nativeSessionId = `native-${session.id}`,
): RuntimeSessionReceipt {
  assert.ok(session.continuationAttemptId);
  return {
    mode: 'created',
    continuationAttemptId: session.continuationAttemptId,
    selection: selected,
    nativeSessionId,
    requestedNativeSessionId: null,
  };
}

function prepareCreate(
  session: ReturnType<typeof db.createOrchestratorSession>,
): ReturnType<typeof db.createOrchestratorSession> {
  const prepared = db.prepareRuntimeSessionCreate(session.id);
  assert.ok(prepared);
  assert.notEqual(prepared.continuationAttemptId, session.continuationAttemptId);
  return prepared;
}

test('new rows persist one complete flattened immutable selection', () => {
  const p = project('Selection stamp');
  const selected = selection('account-selected', { kind: 'selected', value: 'high' });
  const session = db.createOrchestratorSession({ projectId: p.id, selection: selected, now: 10 });
  assert.ok(session.continuationAttemptId);
  assert.deepEqual(session, {
    id: session.id,
    projectId: p.id,
    selectionState: 'stamped',
    runtimeId: 'runtime-a',
    accountId: 'account-selected',
    model: 'model-a',
    effortState: 'selected',
    effort: 'high',
    nativeSessionId: null,
    nativeIdentityState: 'unbound',
    continuationState: 'clean-pending',
    continuationAttemptId: session.continuationAttemptId,
    title: null,
    status: 'active',
    endedReason: null,
    startedAt: 10,
    endedAt: null,
    deletedAt: null,
  });
  assert.deepEqual(db.runtimeSelectionForSession(session), selected);
  assert.throws(
    () => db.getRawDb().prepare(
      "UPDATE orchestrator_sessions SET model = 'other' WHERE id = ?",
    ).run(session.id),
    /runtime selection is immutable/,
  );
  db.endOrchestratorSession(session.id, 'user_ended');

  const none = db.createOrchestratorSession({
    projectId: p.id,
    selection: selection('account-none'),
  });
  assert.equal(none.effortState, 'none');
  assert.equal(none.effort, null);
  db.endOrchestratorSession(none.id, 'user_ended');

  const unavailable = db.createOrchestratorSession({
    projectId: p.id,
    selection: selection('account-unavailable', { kind: 'unavailable' }),
  });
  assert.equal(unavailable.effortState, 'unavailable');
  assert.equal(unavailable.effort, null);
  assert.throws(
    () => db.createOrchestratorSession({
      projectId: project('Bad stamp').id,
      selection: { ...selection(), runtimeId: '   ' },
    }),
    /runtime selection must be an exact complete selection/,
  );
  for (const malformed of [
    { ...selection(), runtimeId: ' runtime-a ' },
    { ...selection(), accountId: ' account-a ' },
    { ...selection(), model: ' model-a ' },
    { ...selection(), effort: { kind: 'selected' as const, value: ' high ' } },
  ]) {
    assert.throws(
      () => db.createOrchestratorSession({
        projectId: project('Padded stamp').id,
        selection: malformed,
      }),
      /runtime selection must be an exact complete selection/,
    );
  }
});

test('created receipt binds once; matching redelivery is idempotent and conflicts write nothing', () => {
  const p = project('Created receipt');
  const selected = selection();
  const session = db.createOrchestratorSession({ projectId: p.id, selection: selected });
  const abandoned = prepareCreate(session);
  const current = prepareCreate(abandoned);
  const staleReceipt = createdReceipt(abandoned, selected, 'native-stale');
  const receipt = createdReceipt(current, selected, 'native-1');

  assert.deepEqual(db.confirmRuntimeSessionReceipt({
    sessionId: session.id,
    receipt: staleReceipt,
  }), { status: 'rejected', reason: 'continuation-attempt-mismatch' });

  const confirmed = db.confirmRuntimeSessionReceipt({ sessionId: session.id, receipt });
  assert.equal(confirmed.status, 'confirmed');
  if (confirmed.status === 'confirmed') {
    assert.equal(confirmed.duplicate, false);
    assert.equal(confirmed.session.nativeSessionId, 'native-1');
    assert.equal(confirmed.session.nativeIdentityState, 'bound');
    assert.equal(confirmed.session.continuationState, 'clean-started');
    assert.equal(confirmed.session.continuationAttemptId, current.continuationAttemptId);
  }
  const duplicate = db.confirmRuntimeSessionReceipt({ sessionId: session.id, receipt });
  assert.deepEqual(
    duplicate.status === 'confirmed' && { status: duplicate.status, duplicate: duplicate.duplicate },
    { status: 'confirmed', duplicate: true },
  );
  assert.deepEqual(db.confirmRuntimeSessionReceipt({
    sessionId: session.id,
    receipt: { ...receipt, nativeSessionId: 'native-2' },
  }), { status: 'rejected', reason: 'native-session-id-conflict' });
  assert.deepEqual(db.confirmRuntimeSessionReceipt({
    sessionId: session.id,
    receipt: { ...receipt, selection: selection('wrong-account') },
  }), { status: 'rejected', reason: 'selection-mismatch' });
  assert.deepEqual(db.confirmRuntimeSessionReceipt({
    sessionId: session.id,
    receipt: {
      ...receipt,
      selection: { ...selected, runtimeId: ' runtime-a ' },
    },
  }), { status: 'rejected', reason: 'malformed-receipt' });
  assert.equal(db.getOrchestratorSession(session.id)?.nativeSessionId, 'native-1');
  db.endOrchestratorSession(session.id, 'user_ended');
  assert.deepEqual(db.confirmRuntimeSessionReceipt({ sessionId: session.id, receipt }), {
    status: 'rejected',
    reason: 'session-inactive',
  });
});

test('malformed receipts are rejected without throwing or binding identity', () => {
  const p = project('Malformed receipt');
  const selected = selection();
  const session = db.createOrchestratorSession({ projectId: p.id, selection: selected });
  const prepared = prepareCreate(session);
  const valid = createdReceipt(prepared, selected, 'native-malformed');
  const { continuationAttemptId: _omitted, ...missingAttempt } = valid;
  const malformed = [
    null,
    { ...valid, unexpected: true },
    missingAttempt,
    { ...valid, continuationAttemptId: ` ${valid.continuationAttemptId}` },
    { ...valid, nativeSessionId: '   ' },
    { ...valid, selection: { ...selected, effort: { kind: 'none', value: 'extra' } } },
  ];

  for (const receipt of malformed) {
    assert.deepEqual(db.confirmRuntimeSessionReceipt({
      sessionId: session.id,
      receipt: receipt as unknown as RuntimeSessionReceipt,
    }), { status: 'rejected', reason: 'malformed-receipt' });
    assert.deepEqual(
      db.getOrchestratorSession(session.id) && {
        nativeSessionId: db.getOrchestratorSession(session.id)!.nativeSessionId,
        nativeIdentityState: db.getOrchestratorSession(session.id)!.nativeIdentityState,
        continuationState: db.getOrchestratorSession(session.id)!.continuationState,
        continuationAttemptId: db.getOrchestratorSession(session.id)!.continuationAttemptId,
      },
      {
        nativeSessionId: null,
        nativeIdentityState: 'unbound',
        continuationState: 'clean-pending',
        continuationAttemptId: prepared.continuationAttemptId,
      },
    );
  }
});

test('resume receipt requires pending state and exact requested bound identity', () => {
  const p = project('Resume receipt');
  const selected = selection();
  const session = db.createOrchestratorSession({ projectId: p.id, selection: selected });
  const createAttempt = prepareCreate(session);
  db.confirmRuntimeSessionReceipt({
    sessionId: session.id,
    receipt: createdReceipt(createAttempt, selected, 'native-resume'),
  });

  const prematureReceipt: RuntimeSessionReceipt = {
    mode: 'resumed',
    continuationAttemptId: createAttempt.continuationAttemptId!,
    selection: selected,
    nativeSessionId: 'native-resume',
    requestedNativeSessionId: 'native-resume',
  };
  assert.deepEqual(db.confirmRuntimeSessionReceipt({
    sessionId: session.id,
    receipt: prematureReceipt,
  }), {
    status: 'rejected',
    reason: 'continuation-state-conflict',
  });
  const firstResume = db.prepareRuntimeSessionResume(session.id)!;
  assert.equal(firstResume.continuationState, 'resume-pending');
  assert.notEqual(firstResume.continuationAttemptId, createAttempt.continuationAttemptId);
  assert.deepEqual(db.confirmRuntimeSessionReceipt({
    sessionId: session.id,
    receipt: createdReceipt(createAttempt, selected, 'native-resume'),
  }), {
    status: 'rejected',
    reason: 'continuation-attempt-mismatch',
  });
  const receipt: RuntimeSessionReceipt = {
    ...prematureReceipt,
    continuationAttemptId: firstResume.continuationAttemptId!,
  };
  const confirmed = db.confirmRuntimeSessionReceipt({ sessionId: session.id, receipt });
  assert.equal(confirmed.status, 'confirmed');
  assert.equal(db.getOrchestratorSession(session.id)?.continuationState, 'native-resumed');
  const duplicate = db.confirmRuntimeSessionReceipt({ sessionId: session.id, receipt });
  assert.equal(duplicate.status === 'confirmed' && duplicate.duplicate, true);

  const abandonedResume = db.prepareRuntimeSessionResume(session.id)!;
  const currentResume = db.prepareRuntimeSessionResume(session.id)!;
  assert.equal(currentResume.continuationState, 'resume-pending');
  assert.notEqual(currentResume.continuationAttemptId, abandonedResume.continuationAttemptId);
  assert.equal(db.failRuntimeSessionResume(
    session.id,
    abandonedResume.continuationAttemptId!,
  ), false);
  assert.deepEqual(db.confirmRuntimeSessionReceipt({ sessionId: session.id, receipt }), {
    status: 'rejected',
    reason: 'continuation-attempt-mismatch',
  });
  assert.deepEqual(
    db.getOrchestratorSession(session.id) && {
      continuationState: db.getOrchestratorSession(session.id)!.continuationState,
      continuationAttemptId: db.getOrchestratorSession(session.id)!.continuationAttemptId,
    },
    {
      continuationState: 'resume-pending',
      continuationAttemptId: currentResume.continuationAttemptId,
    },
  );
  assert.equal(db.failRuntimeSessionResume(
    session.id,
    currentResume.continuationAttemptId!,
  ), true);
  assert.equal(db.getOrchestratorSession(session.id)?.continuationState, 'resume-failed');
  assert.equal(
    db.getOrchestratorSession(session.id)?.continuationAttemptId,
    currentResume.continuationAttemptId,
  );
});

test('historical resume rejects an unbound target before cancelling the current queue', () => {
  const p = project('Unbound resume');
  const target = db.createOrchestratorSession({ projectId: p.id, selection: selection() });
  db.endOrchestratorSession(target.id, 'user_ended');
  const current = db.createOrchestratorSession({ projectId: p.id, selection: selection('account-b') });
  db.enqueueConversationSend({
    projectId: p.id,
    conversationId: current.id,
    sessionId: current.id,
    commandId: 'unbound-command',
    clientMessageId: 'unbound-client',
    text: 'preserve me',
    origin: 'user',
  });

  assert.equal(db.resumeOrchestratorSessionTransition({
    projectId: p.id,
    expectedSessionId: current.id,
    targetSessionId: target.id,
    queueCancellationReason: 'resume target',
  }), null);
  assert.equal(db.getActiveOrchestratorSession(p.id)?.id, current.id);
  assert.equal(db.getOrchestratorSession(target.id)?.status, 'ended');
  assert.equal(db.getConversationQueueSnapshot(current.id).items[0]?.status, 'queued');
});

test('historical resume rejects a target with an unsettled durable turn before mutating current state', () => {
  const p = project('Busy target resume');
  const selected = selection('target-account');
  const target = db.createOrchestratorSession({ projectId: p.id, selection: selected });
  const targetCreate = prepareCreate(target);
  db.confirmRuntimeSessionReceipt({
    sessionId: target.id,
    receipt: createdReceipt(targetCreate, selected, 'native-busy-target'),
  });
  db.enqueueConversationSend({
    projectId: p.id,
    conversationId: target.id,
    sessionId: target.id,
    commandId: 'busy-target-command',
    clientMessageId: 'busy-target-client',
    text: 'uncertain target work',
    origin: 'user',
  });
  const activeTurn = db.claimNextConversationTurn(target.id, 300);
  assert.ok(activeTurn);
  db.endOrchestratorSession(target.id, 'user_ended');

  const current = db.createOrchestratorSession({
    projectId: p.id,
    selection: selection('current-account'),
  });
  db.enqueueConversationSend({
    projectId: p.id,
    conversationId: current.id,
    sessionId: current.id,
    commandId: 'busy-current-command',
    clientMessageId: 'busy-current-client',
    text: 'preserve current work',
    origin: 'user',
  });

  assert.equal(db.resumeOrchestratorSessionTransition({
    projectId: p.id,
    expectedSessionId: current.id,
    targetSessionId: target.id,
    queueCancellationReason: 'resume busy target',
  }), null);
  assert.equal(db.getActiveOrchestratorSession(p.id)?.id, current.id);
  assert.equal(db.getConversationQueueSnapshot(current.id).items[0]?.status, 'queued');
  assert.equal(db.getOrchestratorSession(target.id)?.status, 'ended');
  assert.equal(db.getActiveConversationTurn(target.id)?.id, activeTurn.turnId);
});

test('historical resume atomically activates a bound target as resume-pending', () => {
  const p = project('Bound resume');
  const selectedA = selection('account-a');
  const target = db.createOrchestratorSession({
    projectId: p.id,
    selection: selectedA,
    now: 100,
  });
  const targetCreate = prepareCreate(target);
  db.confirmRuntimeSessionReceipt({
    sessionId: target.id,
    receipt: createdReceipt(targetCreate, selectedA, 'native-a'),
  });
  db.endOrchestratorSession(target.id, 'user_ended');
  const current = db.createOrchestratorSession({
    projectId: p.id,
    selection: selection('account-b'),
  });
  db.enqueueConversationSend({
    projectId: p.id,
    conversationId: current.id,
    sessionId: current.id,
    commandId: 'bound-command',
    clientMessageId: 'bound-client',
    text: 'cancel me',
    origin: 'user',
  });

  const resumed = db.resumeOrchestratorSessionTransition({
    projectId: p.id,
    expectedSessionId: current.id,
    targetSessionId: target.id,
    queueCancellationReason: 'resume target',
    now: 500,
  });
  assert.equal(resumed?.session.id, target.id);
  assert.equal(resumed?.session.continuationState, 'resume-pending');
  assert.notEqual(
    resumed?.session.continuationAttemptId,
    targetCreate.continuationAttemptId,
  );
  assert.equal(resumed?.session.startedAt, 100, 'historical resume preserves original start time');
  assert.deepEqual(db.runtimeSelectionForSession(resumed!.session), selectedA);
  assert.equal(db.getOrchestratorSession(current.id)?.status, 'ended');
  assert.deepEqual(db.getConversationQueueSnapshot(current.id).items, []);

  const firstHistoricalReceipt: RuntimeSessionReceipt = {
    mode: 'resumed',
    continuationAttemptId: resumed!.session.continuationAttemptId!,
    selection: selectedA,
    nativeSessionId: 'native-a',
    requestedNativeSessionId: 'native-a',
  };
  assert.equal(db.confirmRuntimeSessionReceipt({
    sessionId: target.id,
    receipt: firstHistoricalReceipt,
  }).status, 'confirmed');
  db.endOrchestratorSession(target.id, 'user_ended');
  const secondCurrent = db.createOrchestratorSession({
    projectId: p.id,
    selection: selection('account-c'),
  });
  const resumedAgain = db.resumeOrchestratorSessionTransition({
    projectId: p.id,
    expectedSessionId: secondCurrent.id,
    targetSessionId: target.id,
    queueCancellationReason: 'resume target again',
    now: 600,
  })!;
  assert.notEqual(
    resumedAgain.session.continuationAttemptId,
    resumed!.session.continuationAttemptId,
  );
  assert.deepEqual(db.confirmRuntimeSessionReceipt({
    sessionId: target.id,
    receipt: firstHistoricalReceipt,
  }), { status: 'rejected', reason: 'continuation-attempt-mismatch' });
  assert.equal(db.failRuntimeSessionResume(
    target.id,
    resumed!.session.continuationAttemptId!,
  ), false);
  assert.deepEqual(
    db.getOrchestratorSession(target.id) && {
      continuationState: db.getOrchestratorSession(target.id)!.continuationState,
      continuationAttemptId: db.getOrchestratorSession(target.id)!.continuationAttemptId,
      startedAt: db.getOrchestratorSession(target.id)!.startedAt,
    },
    {
      continuationState: 'resume-pending',
      continuationAttemptId: resumedAgain.session.continuationAttemptId,
      startedAt: 100,
    },
  );
});

test('replacement commits an exact new stamp and does not invalidate older stamped sessions', () => {
  const p = project('Selection replacement');
  const selectedA = selection('account-a');
  const prior = db.createOrchestratorSession({ projectId: p.id, selection: selectedA });
  const priorCreate = prepareCreate(prior);
  db.confirmRuntimeSessionReceipt({
    sessionId: prior.id,
    receipt: createdReceipt(priorCreate, selectedA, 'native-a'),
  });
  const selectedB = selection('account-b', { kind: 'selected', value: 'high' });
  const replacement = db.replaceOrchestratorSession({
    projectId: p.id,
    expectedSessionId: prior.id,
    selection: selectedB,
    queueCancellationReason: 'selection changed',
    endedReason: 'account_switched',
    settingsPatch: { defaultAccountId: 'account-b' },
    now: 700,
  });
  assert.deepEqual(db.runtimeSelectionForSession(replacement.session), selectedB);
  assert.equal(replacement.session.continuationState, 'clean-pending');
  const old = db.getOrchestratorSession(prior.id)!;
  assert.equal(old.status, 'ended');
  assert.equal(old.nativeSessionId, 'native-a');
  assert.equal(db.isOrchestratorSessionResumeReady(old), true);
  assert.equal(db.getProjectById(p.id)?.settings.defaultAccountId, 'account-b');
});

test('invalid replacement selection rolls back queue, session, and project settings atomically', () => {
  const p = project('Replacement rollback');
  const current = db.createOrchestratorSession({
    projectId: p.id,
    selection: selection('original-account'),
  });
  db.enqueueConversationSend({
    projectId: p.id,
    conversationId: current.id,
    sessionId: current.id,
    commandId: 'rollback-command',
    clientMessageId: 'rollback-client',
    text: 'must survive rollback',
    origin: 'user',
  });
  const originalSettings = db.getProjectById(p.id)!.settings;

  assert.throws(() => db.replaceOrchestratorSession({
    projectId: p.id,
    expectedSessionId: current.id,
    selection: { ...selection('replacement-account'), runtimeId: '' } as RuntimeSelection,
    queueCancellationReason: 'invalid replacement',
    endedReason: 'account_switched',
    settingsPatch: { defaultAccountId: 'replacement-account' },
    now: 900,
  }), /runtime selection must be an exact complete selection/);

  assert.equal(db.getActiveOrchestratorSession(p.id)?.id, current.id);
  assert.equal(db.getOrchestratorSession(current.id)?.status, 'active');
  assert.equal(db.getConversationQueueSnapshot(current.id).items[0]?.status, 'queued');
  assert.deepEqual(db.getProjectById(p.id)?.settings, originalSettings);
  assert.equal(db.listOrchestratorSessionsForProject(p.id).length, 1);
});
