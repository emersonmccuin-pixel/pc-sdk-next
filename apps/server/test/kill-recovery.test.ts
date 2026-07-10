// Kill-recovery (standing test, plan DoD). FakeBackend + a real SQLite file:
// start a turn → hang it mid-flight → "hard-stop" (drop the DB connection) →
// boot → assert exactly one turn-failed persisted, the session is not stuck
// busy, and replay is coherent. A second boot is a no-op (idempotent).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { closeDb, listConversationEvents } from '@pc/db';
import type { ChatEvent } from '@pc/contracts';
import { SessionService } from '../src/chat/session-service.ts';
import { FakeBackend } from '../src/runner/fake-backend.ts';
import { runBootRecovery } from '../src/boot-recovery.ts';
import { freshDb, newProject, until } from './helpers.ts';

function kinds(sessionId: string): string[] {
  return listConversationEvents(sessionId).map((r) => r.kind ?? '');
}
function terminals(sessionId: string): ChatEvent[] {
  return listConversationEvents(sessionId)
    .map((r) => r.event as ChatEvent)
    .filter((e) => e.kind === 'turn-end' || e.kind === 'turn-failed');
}

test('server dies mid-turn → boot recovery persists exactly one turn-failed', async () => {
  freshDb();
  const project = newProject();

  // A turn that emits some content then hangs forever (models the process dying
  // with the turn in flight). We deliberately never resolve it.
  const backend = new FakeBackend({
    turns: [[
      { type: 'init', sdkSessionId: 'sdk-1', model: 'opus', permissionMode: 'default' },
      { type: 'assistant-block', sdkUuid: 'u1', parentToolUseId: null, block: { kind: 'text', text: 'working on it' } },
      { hang: true },
    ]],
  });
  const svc = new SessionService({ projectId: project.id, backendFactory: () => backend, broadcast: () => {} });
  const session = svc.ensureActiveSession();
  svc.handleSend('do the thing', 'cm1');

  // Wait until the turn is genuinely in flight (running persisted, no terminal).
  await until(() =>
    listConversationEvents(session.id).some(
      (r) => r.kind === 'session-state' && (r.event as { state: string }).state === 'running',
    ),
  );
  assert.equal(terminals(session.id).length, 0, 'no terminal yet — turn is in flight');

  // Hard stop: drop the DB connection (the process is gone). The hung backend
  // promise is abandoned on purpose.
  closeDb();

  // Boot.
  const result = runBootRecovery();
  assert.deepEqual(result.recovered, [session.id]);

  const t = terminals(session.id);
  assert.equal(t.length, 1, 'exactly one turn-failed');
  assert.equal(t[0].kind, 'turn-failed');
  assert.equal((t[0] as { source: string }).source, 'internal');

  // Not stuck busy: the last session-state is idle.
  const lastState = listConversationEvents(session.id)
    .filter((r) => r.kind === 'session-state')
    .at(-1);
  assert.equal((lastState?.event as { state: string }).state, 'idle');

  // Replay is coherent: the crashed turn is closed out, in order.
  assert.deepEqual(kinds(session.id).slice(-2), ['turn-failed', 'session-state']);

  // Idempotent: a second boot changes nothing.
  const again = runBootRecovery();
  assert.deepEqual(again.recovered, []);
  assert.equal(terminals(session.id).length, 1);
});

test('a cleanly-idle session is not touched by boot recovery', async () => {
  freshDb();
  const project = newProject();
  const backend = new FakeBackend({
    turns: [[{ type: 'result', ok: true, subtype: 'success', stopReason: 'end_turn', usage: null, durationMs: 1, error: null }]],
  });
  const svc = new SessionService({ projectId: project.id, backendFactory: () => backend, broadcast: () => {} });
  const session = svc.ensureActiveSession();
  svc.handleSend('hi', 'cm1');
  await until(() => terminals(session.id).length === 1);

  const before = listConversationEvents(session.id).length;
  const result = runBootRecovery();
  assert.deepEqual(result.recovered, []);
  assert.equal(listConversationEvents(session.id).length, before);
});
