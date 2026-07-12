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
  const handle = reg.ask({ toolName: 'Bash', callId: 'call-1', toolInput: { cmd: 'ls' }, appSessionId: 's1' });
  assert.equal(frames.length, 0, 'card waits for canonical approval-needed commit');
  assert.equal(reg.publish(handle.requestId), true);
  assert.equal(frames.length, 1);
  assert.ok(reg.reply(frames[0].askId, 'allow'));
  assert.deepEqual(await handle.decision, { behavior: 'allow', decidedBy: 'user' });
});

test('non-allow answer denies, carrying the reason', async () => {
  const { reg, frames } = make(10_000);
  const handle = reg.ask({ toolName: 'Bash', callId: 'call-1', toolInput: {}, appSessionId: 's1' });
  reg.publish(handle.requestId);
  reg.reply(frames[0].askId, 'nope not safe');
  assert.deepEqual(await handle.decision, { behavior: 'deny', decidedBy: 'user', message: 'nope not safe' });
});

test('watchdog auto-denies an abandoned ask (never hangs)', async () => {
  const { reg } = make(20);
  const handle = reg.ask({ toolName: 'Bash', callId: 'call-1', toolInput: {}, appSessionId: 's1' });
  const decision = await handle.decision;
  assert.equal(decision.behavior, 'deny');
  assert.equal(decision.decidedBy, 'timeout');
  assert.match(decision.message ?? '', /timed out/);
});

test('reply to an unknown/expired askId is a harmless no-op', async () => {
  const { reg } = make(10_000);
  assert.equal(reg.reply('nope', 'allow'), false);
});

test('clear denies every pending ask', async () => {
  const { reg, frames } = make(10_000);
  const handle = reg.ask({ toolName: 'Bash', callId: 'call-1', toolInput: {}, appSessionId: 's1' });
  reg.publish(handle.requestId);
  reg.clear('session ended');
  assert.deepEqual(await handle.decision, { behavior: 'deny', decidedBy: 'session', message: 'session ended' });
  assert.equal(reg.openCount, 0);
  assert.equal(frames.length, 1);
});

test('AskUserQuestion reply allows with rawAnswer, bypassing ALLOW_ANSWERS', async () => {
  const { reg, frames } = make(10_000);
  const handle = reg.ask({ toolName: 'AskUserQuestion', callId: 'call-1', toolInput: {}, appSessionId: 's1' });
  reg.publish(handle.requestId);
  assert.ok(reg.reply(frames[0].askId, 'some chosen label'));
  assert.deepEqual(await handle.decision, { behavior: 'allow', decidedBy: 'user', rawAnswer: 'some chosen label' });
});

test('ExitPlanMode reply allows with rawAnswer, bypassing ALLOW_ANSWERS', async () => {
  const { reg, frames } = make(10_000);
  const handle = reg.ask({ toolName: 'ExitPlanMode', callId: 'call-1', toolInput: {}, appSessionId: 's1' });
  reg.publish(handle.requestId);
  assert.ok(reg.reply(frames[0].askId, 'reject'));
  assert.deepEqual(await handle.decision, { behavior: 'allow', decidedBy: 'user', rawAnswer: 'reject' });
});

test('__cancelled__ still denies for answer-style tools', async () => {
  const { reg, frames } = make(10_000);
  const handle = reg.ask({ toolName: 'AskUserQuestion', callId: 'call-1', toolInput: {}, appSessionId: 's1' });
  reg.publish(handle.requestId);
  assert.ok(reg.reply(frames[0].askId, '__cancelled__'));
  assert.deepEqual(await handle.decision, { behavior: 'deny', decidedBy: 'user', message: 'declined by user' });
});

test('Bash reply routing is unchanged (ALLOW_ANSWERS gate)', async () => {
  const { reg, frames } = make(10_000);
  const handle = reg.ask({ toolName: 'Bash', callId: 'call-1', toolInput: {}, appSessionId: 's1' });
  reg.publish(handle.requestId);
  assert.ok(reg.reply(frames[0].askId, 'allow'));
  assert.deepEqual(await handle.decision, { behavior: 'allow', decidedBy: 'user' });
});

test('published pending asks replay on reconnect and canonical ids replace native ids', () => {
  const { reg, frames } = make(10_000);
  const handle = reg.ask({ toolName: 'Bash', callId: 'call-safe', toolInput: {}, appSessionId: 's1' });
  assert.deepEqual(reg.snapshot(), []);
  reg.publish(handle.requestId);
  assert.deepEqual(reg.snapshot(), frames);
  assert.equal(frames[0]!.callId, 'call-safe');
  assert.equal('toolUseId' in frames[0]!, false);
  handle.cancel();
});

test('approval payload is bounded and redacts common secret forms before emission', async () => {
  const { reg, frames } = make(10_000);
  const handle = reg.ask({
    toolName: 'Bash',
    callId: 'call-redacted',
    toolInput: {
      token: 'top-secret',
      command: `API_KEY=plain-secret curl -H "Authorization: Bearer bearer-secret" ${'x'.repeat(4_000)}`,
      nested: { password: 'another-secret', safe: 'visible' },
    },
    appSessionId: 's1',
  });
  reg.publish(handle.requestId);
  const serialized = JSON.stringify(frames[0]!.toolInput);
  for (const secret of ['top-secret', 'plain-secret', 'bearer-secret', 'another-secret']) {
    assert.equal(serialized.includes(secret), false);
  }
  assert.match(serialized, /\[redacted\]/);
  assert.ok(serialized.length < 13_000);
  handle.cancel();
  assert.equal((await handle.decision).decidedBy, 'session');
});

test('approval payload has a global node bound for wide nested scalar arrays', async () => {
  const { reg, frames } = make(10_000);
  const numericTree = Array.from({ length: 40 }, () =>
    Array.from({ length: 40 }, () =>
      Array.from({ length: 40 }, () => 123_456_789)));
  const handle = reg.ask({
    toolName: 'Bash', callId: 'call-wide', toolInput: numericTree, appSessionId: 's1',
  });
  reg.publish(handle.requestId);
  assert.ok(JSON.stringify(frames[0]!.toolInput).length <= 12_000);
  handle.cancel();
  assert.equal((await handle.decision).decidedBy, 'session');
});
