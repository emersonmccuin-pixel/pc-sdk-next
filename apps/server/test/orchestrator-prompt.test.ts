// Orchestrator-prompt plumbing guards: the runtime session is re-minted (with
// native resume) when the orchestrator row's rev changes between turns, and
// left alone when it doesn't. The immutable session selection remains the
// source of runtime/account/model/effort truth across that re-mint.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { listConversationEvents } from '@pc/db';
import type { ChatEvent } from '@pc/contracts';
import type { MintRuntimeSession } from '../src/runner/runtime.ts';
import { SessionService } from '../src/chat/session-service.ts';
import { FakeRuntime } from '../src/runner/fake-runtime.ts';
import { freshDb, newProject, until } from './helpers.ts';
import { testSessionSelectionDeps, withRuntimeReceipt } from './runtime-fixtures.ts';

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
    mintSession: withRuntimeReceipt((ctx) => {
      const runtime = new FakeRuntime({
        turns: Array.from({ length: 5 }, () => [
          { type: 'result', ok: true, stopReason: 'complete', usage: null, durationMs: 1, error: null, outcome: 'ok', numTurns: null },
        ]),
      });
      minted.push({ runtime, ctx });
      return runtime;
    }),
    ...testSessionSelectionDeps(),
  });
  const session = await svc.ensureActiveSession();

  // Turn 1 mints runtime #1.
  await svc.handleSend({ type: 'send', commandId: 'cmd1', sessionId: session.id, text: 'one', clientMessageId: 'cm1' });
  await until(() => terminalCount(session.id) === 1);
  assert.equal(minted.length, 1);

  // Turn 2, same rev — no re-mint.
  await svc.handleSend({ type: 'send', commandId: 'cmd2', sessionId: session.id, text: 'two', clientMessageId: 'cm2' });
  await until(() => terminalCount(session.id) === 2);
  assert.equal(minted.length, 1, 'stable rev must reuse the live runtime session');

  // Rev bump (prompt edit) — turn 3 re-mints, resuming the native session.
  rev = 2;
  await svc.handleSend({ type: 'send', commandId: 'cmd3', sessionId: session.id, text: 'three', clientMessageId: 'cm3' });
  await until(() => terminalCount(session.id) === 3);
  assert.equal(minted.length, 2, 'rev change must re-mint the runtime session');
  assert.equal(
    minted[1]!.ctx.continuation.mode === 'resume'
      ? minted[1]!.ctx.continuation.nativeSessionId
      : null,
    `native-${session.id}`,
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
    mintSession: withRuntimeReceipt(() => {
      mints++;
      return new FakeRuntime();
    }),
    ...testSessionSelectionDeps(),
  });
  const session = await svc.ensureActiveSession();
  await svc.handleSend({ type: 'send', commandId: 'cmd1', sessionId: session.id, text: 'one', clientMessageId: 'cm1' });
  await until(() => terminalCount(session.id) === 1);
  await svc.handleSend({ type: 'send', commandId: 'cmd2', sessionId: session.id, text: 'two', clientMessageId: 'cm2' });
  await until(() => terminalCount(session.id) === 2);
  assert.equal(mints, 1);
});
