// Ask registry — guard rule 4: an ask never hangs; the watchdog denies.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { AskFrame } from '@pc/contracts';
import type { ULID } from '@pc/domain';
import { AskRegistry } from '../src/chat/ask-registry.ts';

function make(timeoutMs: number) {
  const frames: AskFrame[] = [];
  const reg = new AskRegistry({
    projectId: 'p1' as ULID,
    emit: (f) => frames.push(f),
    timeoutMs,
  });
  return { reg, frames };
}

test('reply resolves the pending ask (allow)', async () => {
  const { reg, frames } = make(10_000);
  const p = reg.ask({ toolName: 'Bash', toolUseId: 't1', toolInput: { cmd: 'ls' }, sessionId: 's1' });
  assert.equal(frames.length, 1);
  assert.ok(reg.reply(frames[0].askId, 'allow'));
  assert.deepEqual(await p, { behavior: 'allow' });
});

test('non-allow answer denies, carrying the reason', async () => {
  const { reg, frames } = make(10_000);
  const p = reg.ask({ toolName: 'Bash', toolUseId: 't1', toolInput: {}, sessionId: null });
  reg.reply(frames[0].askId, 'nope not safe');
  assert.deepEqual(await p, { behavior: 'deny', message: 'nope not safe' });
});

test('watchdog auto-denies an abandoned ask (never hangs)', async () => {
  const { reg } = make(20);
  const decision = await reg.ask({ toolName: 'Bash', toolUseId: 't1', toolInput: {}, sessionId: null });
  assert.equal(decision.behavior, 'deny');
  assert.match(decision.message ?? '', /timed out/);
});

test('reply to an unknown/expired askId is a harmless no-op', async () => {
  const { reg } = make(10_000);
  assert.equal(reg.reply('nope', 'allow'), false);
});

test('clear denies every pending ask', async () => {
  const { reg, frames } = make(10_000);
  const p = reg.ask({ toolName: 'Bash', toolUseId: 't1', toolInput: {}, sessionId: null });
  reg.clear('session ended');
  assert.equal((await p).behavior, 'deny');
  assert.equal(reg.openCount, 0);
  assert.equal(frames.length, 1);
});

test('AskUserQuestion reply allows with rawAnswer, bypassing ALLOW_ANSWERS', async () => {
  const { reg, frames } = make(10_000);
  const p = reg.ask({ toolName: 'AskUserQuestion', toolUseId: 't1', toolInput: {}, sessionId: null });
  assert.ok(reg.reply(frames[0].askId, 'some chosen label'));
  assert.deepEqual(await p, { behavior: 'allow', rawAnswer: 'some chosen label' });
});

test('ExitPlanMode reply allows with rawAnswer, bypassing ALLOW_ANSWERS', async () => {
  const { reg, frames } = make(10_000);
  const p = reg.ask({ toolName: 'ExitPlanMode', toolUseId: 't1', toolInput: {}, sessionId: null });
  assert.ok(reg.reply(frames[0].askId, 'reject'));
  assert.deepEqual(await p, { behavior: 'allow', rawAnswer: 'reject' });
});

test('__cancelled__ still denies for answer-style tools', async () => {
  const { reg, frames } = make(10_000);
  const p = reg.ask({ toolName: 'AskUserQuestion', toolUseId: 't1', toolInput: {}, sessionId: null });
  assert.ok(reg.reply(frames[0].askId, '__cancelled__'));
  assert.deepEqual(await p, { behavior: 'deny', message: 'declined by user' });
});

test('Bash reply routing is unchanged (ALLOW_ANSWERS gate)', async () => {
  const { reg, frames } = make(10_000);
  const p = reg.ask({ toolName: 'Bash', toolUseId: 't1', toolInput: {}, sessionId: null });
  assert.ok(reg.reply(frames[0].askId, 'allow'));
  assert.deepEqual(await p, { behavior: 'allow' });
});
