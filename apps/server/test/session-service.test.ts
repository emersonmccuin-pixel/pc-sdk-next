// SessionService guards — rule 1 (persist-then-broadcast), rule 2 (unique seq /
// no duplicate id from the writer), rule 3 (exactly one terminal per turn on
// success / abort / api-error paths).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { appendConversationEvent, listConversationEvents } from '@pc/db';
import type { ChatEvent, ChatFrame, ServerFrame } from '@pc/contracts';
import { SessionService } from '../src/chat/session-service.ts';
import { FakeRuntime } from '../src/runner/fake-runtime.ts';
import { freshDb, newProject, until } from './helpers.ts';

function terminals(sessionId: string): ChatEvent[] {
  return listConversationEvents(sessionId)
    .map((r) => r.event as ChatEvent)
    .filter((e) => e.kind === 'turn-end' || e.kind === 'turn-failed');
}

test('rule 1: every chat frame is committed before it broadcasts', async () => {
  freshDb();
  const project = newProject();
  const backend = new FakeRuntime({
    turns: [[
      { type: 'init', sdkSessionId: 's1', model: 'opus', permissionMode: 'default' },
      { type: 'assistant-block', sdkUuid: 'u1', parentToolUseId: null, block: { kind: 'text', text: 'hi' } },
      { type: 'result', ok: true, subtype: 'success', stopReason: 'end_turn', usage: null, durationMs: 1, error: null, outcome: 'ok', numTurns: null },
    ]],
  });
  let violations = 0;
  const svc = new SessionService({
    projectId: project.id,
    mintSession: () => backend,
    broadcast: (f: ServerFrame) => {
      if (f.type === 'chat') {
        const persisted = listConversationEvents(f.sessionId).some((r) => r.seq === f.seq);
        if (!persisted) violations++;
      }
    },
  });
  const session = svc.ensureActiveSession();
  assert.equal(svc.handleSend('hello', 'cm1'), 'received');
  await until(() => terminals(session.id).length === 1);
  assert.equal(violations, 0);

  // clientMessageId stamped on the user row.
  const userRow = listConversationEvents(session.id).find((r) => r.kind === 'user');
  assert.equal(userRow?.clientMessageId, 'cm1');
});

test('rule 2: the writer never reuses a seq (UNIQUE session_id, seq)', async () => {
  freshDb();
  const project = newProject();
  const svc = new SessionService({ projectId: project.id, mintSession: () => new FakeRuntime(), broadcast: () => {} });
  const session = svc.ensureActiveSession();
  svc.handleSend('hi', 'cm1');
  await until(() => terminals(session.id).length === 1);
  // A second write at seq 1 (already taken) must throw — no duplicate id ever
  // reaches the wire from the single writer.
  assert.throws(() =>
    appendConversationEvent({
      projectId: project.id,
      sessionId: session.id,
      seq: 1,
      kind: 'user',
      event: { kind: 'user', text: 'dup' } satisfies ChatEvent,
      now: Date.now(),
    }),
  );
});

test('rule 3: success turn ends in exactly one turn-end', async () => {
  freshDb();
  const project = newProject();
  const backend = new FakeRuntime({
    turns: [[{ type: 'result', ok: true, subtype: 'success', stopReason: 'end_turn', usage: null, durationMs: 1, error: null, outcome: 'ok', numTurns: null }]],
  });
  const svc = new SessionService({ projectId: project.id, mintSession: () => backend, broadcast: () => {} });
  const session = svc.ensureActiveSession();
  svc.handleSend('hi', 'cm1');
  await until(() => terminals(session.id).length === 1);
  const t = terminals(session.id);
  assert.equal(t.length, 1);
  assert.equal(t[0].kind, 'turn-end');
});

test('rule 3: api-error turn ends in exactly one turn-failed', async () => {
  freshDb();
  const project = newProject();
  const backend = new FakeRuntime({
    turns: [[{ type: 'result', ok: false, subtype: 'error_during_execution', stopReason: null, usage: null, durationMs: null, error: 'boom', outcome: 'error', numTurns: null }]],
  });
  const svc = new SessionService({ projectId: project.id, mintSession: () => backend, broadcast: () => {} });
  const session = svc.ensureActiveSession();
  svc.handleSend('hi', 'cm1');
  await until(() => terminals(session.id).length === 1);
  const t = terminals(session.id);
  assert.equal(t.length, 1);
  assert.equal(t[0].kind, 'turn-failed');
  assert.equal((t[0] as { source: string }).source, 'api');
});

test('rule 3: interrupt mid-turn ends in exactly one turn-failed (abort)', async () => {
  freshDb();
  const project = newProject();
  const backend = new FakeRuntime({
    turns: [[
      { type: 'assistant-block', sdkUuid: 'u1', parentToolUseId: null, block: { kind: 'text', text: 'working' } },
      { hang: true },
    ]],
  });
  const svc = new SessionService({ projectId: project.id, mintSession: () => backend, broadcast: () => {} });
  const session = svc.ensureActiveSession();
  svc.handleSend('do it', 'cm1');
  // Wait until the turn is genuinely in flight — the backend has streamed
  // content — before interrupting (server-authored `running` lands before the
  // backend turn even starts).
  await until(() => listConversationEvents(session.id).some((r) => r.kind === 'assistant-text'));
  await svc.handleInterrupt();
  await until(() => terminals(session.id).length === 1);
  const t = terminals(session.id);
  assert.equal(t.length, 1);
  assert.equal(t[0].kind, 'turn-failed');
  assert.equal((t[0] as { source: string }).source, 'abort');
  // Session left idle, not stuck busy.
  const last = listConversationEvents(session.id).filter((r) => r.kind === 'session-state').at(-1);
  assert.equal((last?.event as { state: string }).state, 'idle');
});

test('queued sends drain FIFO and reconcile via the user frame', async () => {
  freshDb();
  const project = newProject();
  const backend = new FakeRuntime({
    turns: [
      [{ type: 'result', ok: true, subtype: 'success', stopReason: 'end_turn', usage: null, durationMs: 1, error: null, outcome: 'ok', numTurns: null }],
      [{ type: 'result', ok: true, subtype: 'success', stopReason: 'end_turn', usage: null, durationMs: 1, error: null, outcome: 'ok', numTurns: null }],
    ],
    stepDelayMs: 5,
  });
  const acks: string[] = [];
  const svc = new SessionService({
    projectId: project.id,
    mintSession: () => backend,
    broadcast: (f) => {
      if (f.type === 'chat' && (f as ChatFrame).event.kind === 'user') acks.push((f as ChatFrame).clientMessageId ?? '');
    },
  });
  const session = svc.ensureActiveSession();
  assert.equal(svc.handleSend('first', 'cm1'), 'received');
  assert.equal(svc.handleSend('second', 'cm2'), 'queued');
  await until(() => terminals(session.id).length === 2, 4000);
  assert.deepEqual(acks, ['cm1', 'cm2']);
  assert.deepEqual(backend.sentTexts, ['first', 'second']);
});

test('injectAgentEnvelope persists a typed agent-envelope event (not a bare user bubble) and still starts the turn', async () => {
  freshDb();
  const project = newProject();
  const backend = new FakeRuntime({
    turns: [[{ type: 'result', ok: true, subtype: 'success', stopReason: 'end_turn', usage: null, durationMs: 1, error: null, outcome: 'ok', numTurns: null }]],
  });
  const svc = new SessionService({ projectId: project.id, mintSession: () => backend, broadcast: () => {} });
  const session = svc.ensureActiveSession();
  assert.equal(
    svc.injectAgentEnvelope({
      runId: 'run-1',
      agentName: 'researcher',
      pendingAskId: 'ask-1',
      status: 'waiting',
      summary: 'Question: which approach?',
      detail: '[agent-asks] agent=researcher runId=run-1 pendingAskId=ask-1\nQuestion: which approach?',
      envelope: '[agent-asks] agent=researcher runId=run-1 pendingAskId=ask-1\nQuestion: which approach?',
      clientMessageId: 'agent-ask:ask-1',
    }),
    'received',
  );
  await until(() => terminals(session.id).length === 1);

  const rows = listConversationEvents(session.id);
  assert.equal(rows.some((r) => r.kind === 'user'), false, 'agent envelope must not persist as a plain user bubble');
  const envelopeRow = rows.find((r) => r.kind === 'agent-envelope');
  assert.ok(envelopeRow, 'expected a persisted agent-envelope event');
  const event = envelopeRow!.event as ChatEvent;
  assert.equal(event.kind, 'agent-envelope');
  assert.deepEqual(event, {
    kind: 'agent-envelope',
    runId: 'run-1',
    agentName: 'researcher',
    pendingAskId: 'ask-1',
    status: 'waiting',
    summary: 'Question: which approach?',
    detail: '[agent-asks] agent=researcher runId=run-1 pendingAskId=ask-1\nQuestion: which approach?',
    envelope: '[agent-asks] agent=researcher runId=run-1 pendingAskId=ask-1\nQuestion: which approach?',
  });
  assert.equal(envelopeRow!.clientMessageId, 'agent-ask:ask-1');

  // Turn still fires exactly as a plain send would — the envelope text is
  // what reaches the runtime.
  assert.deepEqual(backend.sentTexts, [
    '[agent-asks] agent=researcher runId=run-1 pendingAskId=ask-1\nQuestion: which approach?',
  ]);
});
