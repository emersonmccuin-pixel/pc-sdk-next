// Orchestrator-prompt plumbing guards: the runtime session is re-minted (with
// native resume) when the orchestrator row's rev changes between turns, and
// left alone when it doesn't — this is what makes a prompt/model edit apply
// "next message".

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { listConversationEvents } from '@pc/db';
import type { ChatEvent } from '@pc/contracts';
import type { MintRuntimeSession } from '../src/runner/runtime.ts';
import { SessionService } from '../src/chat/session-service.ts';
import { FakeRuntime } from '../src/runner/fake-runtime.ts';
import { freshDb, newProject, until } from './helpers.ts';

function terminalCount(sessionId: string): number {
  return listConversationEvents(sessionId)
    .map((r) => r.payload as ChatEvent)
    .filter((e) => e.kind === 'turn-end' || e.kind === 'turn-failed').length;
}

test('rev change between turns re-mints the runtime with resume; stable rev reuses it', async () => {
  freshDb();
  const project = newProject();
  let rev = 1;
  const minted: Array<{ runtime: FakeRuntime; ctx: MintRuntimeSession }> = [];
  const svc = new SessionService({
    projectId: project.id,
    broadcast: () => {},
    orchestratorRev: () => rev,
    mintSession: (ctx) => {
      // Each turn script: init (carries the provider session id) + success.
      const runtime = new FakeRuntime({
        turns: Array.from({ length: 5 }, () => [
          { type: 'init', nativeSessionId: 'sdk-1', model: 'opus', permissionMode: 'default' },
          { type: 'result', ok: true, stopReason: 'complete', usage: null, durationMs: 1, error: null, outcome: 'ok', numTurns: null },
        ]),
      });
      minted.push({ runtime, ctx });
      return runtime;
    },
  });
  const session = svc.ensureActiveSession();

  // Turn 1 mints runtime #1.
  svc.handleSend('one', 'cm1');
  await until(() => terminalCount(session.id) === 1);
  assert.equal(minted.length, 1);

  // Turn 2, same rev — no re-mint.
  svc.handleSend('two', 'cm2');
  await until(() => terminalCount(session.id) === 2);
  assert.equal(minted.length, 1, 'stable rev must reuse the live runtime session');

  // Rev bump (prompt edit) — turn 3 re-mints, resuming the native session.
  rev = 2;
  svc.handleSend('three', 'cm3');
  await until(() => terminalCount(session.id) === 3);
  assert.equal(minted.length, 2, 'rev change must re-mint the runtime session');
  assert.equal(
    minted[1]!.ctx.resumeNativeSessionId,
    'sdk-1',
    're-mint must resume the native session so the conversation continues',
  );
  assert.equal(minted[1]!.runtime.sentTexts[0], 'three');
});

test('no orchestratorRev dep → never re-mints (test/back-compat path)', async () => {
  freshDb();
  const project = newProject();
  let mints = 0;
  const svc = new SessionService({
    projectId: project.id,
    broadcast: () => {},
    mintSession: () => {
      mints++;
      return new FakeRuntime();
    },
  });
  const session = svc.ensureActiveSession();
  svc.handleSend('one', 'cm1');
  await until(() => terminalCount(session.id) === 1);
  svc.handleSend('two', 'cm2');
  await until(() => terminalCount(session.id) === 2);
  assert.equal(mints, 1);
});
