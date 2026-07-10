// Orchestrator-prompt plumbing guards: the backend is re-minted (with resume)
// when the orchestrator row's rev changes between turns, and left alone when
// it doesn't — this is what makes a prompt/model edit apply "next message".

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { listConversationEvents } from '@pc/db';
import type { ChatEvent } from '@pc/contracts';
import type { BackendContext } from '../src/runner/backend.ts';
import { SessionService } from '../src/chat/session-service.ts';
import { FakeBackend } from '../src/runner/fake-backend.ts';
import { freshDb, newProject, until } from './helpers.ts';

function terminalCount(sessionId: string): number {
  return listConversationEvents(sessionId)
    .map((r) => r.event as ChatEvent)
    .filter((e) => e.kind === 'turn-end' || e.kind === 'turn-failed').length;
}

test('rev change between turns re-mints the backend with resume; stable rev reuses it', async () => {
  freshDb();
  const project = newProject();
  let rev = 1;
  const minted: Array<{ backend: FakeBackend; ctx: BackendContext }> = [];
  const svc = new SessionService({
    projectId: project.id,
    broadcast: () => {},
    orchestratorRev: () => rev,
    backendFactory: (ctx) => {
      // Each turn script: init (carries the provider session id) + success.
      const backend = new FakeBackend({
        turns: Array.from({ length: 5 }, () => [
          { type: 'init', sdkSessionId: 'sdk-1', model: 'opus', permissionMode: 'default' },
          { type: 'result', ok: true, subtype: 'success', stopReason: 'end_turn', usage: null, durationMs: 1, error: null },
        ]),
      });
      minted.push({ backend, ctx });
      return backend;
    },
  });
  const session = svc.ensureActiveSession();

  // Turn 1 mints backend #1.
  svc.handleSend('one', 'cm1');
  await until(() => terminalCount(session.id) === 1);
  assert.equal(minted.length, 1);

  // Turn 2, same rev — no re-mint.
  svc.handleSend('two', 'cm2');
  await until(() => terminalCount(session.id) === 2);
  assert.equal(minted.length, 1, 'stable rev must reuse the live backend');

  // Rev bump (prompt edit) — turn 3 re-mints, resuming the SDK session.
  rev = 2;
  svc.handleSend('three', 'cm3');
  await until(() => terminalCount(session.id) === 3);
  assert.equal(minted.length, 2, 'rev change must re-mint the backend');
  assert.equal(
    minted[1]!.ctx.resumeSdkSessionId,
    'sdk-1',
    're-mint must resume the provider session so the conversation continues',
  );
  assert.equal(minted[1]!.backend.lastStartOptions?.resumeSdkSessionId, 'sdk-1');
  assert.equal(minted[1]!.backend.sentTexts[0], 'three');
});

test('no orchestratorRev dep → never re-mints (test/back-compat path)', async () => {
  freshDb();
  const project = newProject();
  let mints = 0;
  const svc = new SessionService({
    projectId: project.id,
    broadcast: () => {},
    backendFactory: () => {
      mints++;
      return new FakeBackend();
    },
  });
  const session = svc.ensureActiveSession();
  svc.handleSend('one', 'cm1');
  await until(() => terminalCount(session.id) === 1);
  svc.handleSend('two', 'cm2');
  await until(() => terminalCount(session.id) === 2);
  assert.equal(mints, 1);
});
