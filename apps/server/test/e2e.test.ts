// Fake-backend end-to-end (plan DoD 3 + guard rule 6). Real HTTP + WS on an
// ephemeral port, a real `ws` client: connect → send → delta frames stream →
// persisted chat frames land → turn-end → reconnect and the replay matches the
// live stream exactly.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { WebSocket } from 'ws';
import { FakeRuntime } from '../src/runner/fake-runtime.ts';
import { startServer, type RunningServer } from '../src/server.ts';
import { freshDb, newProject, sleep } from './helpers.ts';

interface Frame {
  type: string;
  event?: { kind?: string; state?: string };
  events?: unknown[];
  [k: string]: unknown;
}

function connect(url: string) {
  const ws = new WebSocket(url);
  const frames: Frame[] = [];
  const waiters: Array<{ pred: (f: Frame) => boolean; resolve: (f: Frame) => void }> = [];
  ws.on('message', (data: Buffer) => {
    const f = JSON.parse(data.toString()) as Frame;
    frames.push(f);
    for (let i = waiters.length - 1; i >= 0; i--) {
      if (waiters[i].pred(f)) {
        waiters[i].resolve(f);
        waiters.splice(i, 1);
      }
    }
  });
  function waitFor(pred: (f: Frame) => boolean, timeoutMs = 4000): Promise<Frame> {
    const existing = frames.find(pred);
    if (existing) return Promise.resolve(existing);
    return new Promise((resolve, reject) => {
      const t = setTimeout(() => reject(new Error('waitFor timeout')), timeoutMs);
      waiters.push({ pred, resolve: (f) => { clearTimeout(t); resolve(f); } });
    });
  }
  return { ws, frames, waitFor, close: () => ws.close() };
}

const SCRIPT = [[
  { type: 'init', nativeSessionId: 'sdk-e2e', model: 'opus', permissionMode: 'default' },
  { type: 'delta', itemId: 'u1', scope: 'primary', delta: { kind: 'message-start' } },
  { type: 'delta', itemId: 'u1', scope: 'primary', delta: { kind: 'text-delta', text: 'Hel' } },
  { type: 'delta', itemId: 'u1', scope: 'primary', delta: { kind: 'text-delta', text: 'lo' } },
  { type: 'assistant-block', itemId: 'u1', scope: 'primary', block: { kind: 'text', text: 'Hello' } },
  { type: 'assistant-block', itemId: 'u1', scope: 'primary', block: { kind: 'tool_use', toolUseId: 't1', name: 'Read', input: { path: 'x' } } },
  { type: 'tool-result', itemId: 'u2', scope: 'primary', toolUseId: 't1', result: 'contents', isError: false },
  { type: 'assistant-block', itemId: 'u3', scope: 'primary', block: { kind: 'text', text: 'Done' } },
  { type: 'result', ok: true, stopReason: 'complete', usage: { inputTokens: 10, outputTokens: 5, cacheCreationTokens: 0, cacheReadTokens: 0, model: 'opus' }, durationMs: 12, error: null, outcome: 'ok', numTurns: null },
]] as never;

test('ws connect → send → deltas → persisted frames → turn-end → reconnect replay identical', async () => {
  freshDb();
  const project = newProject();
  const backend = new FakeRuntime({ turns: SCRIPT, stepDelayMs: 1 });
  let server: RunningServer | null = null;
  try {
    server = await startServer({ mintSession: () => backend, port: 0, runRecovery: false });
    const url = `ws://localhost:${server.port}/ws?projectId=${project.id}`;

    const c1 = connect(url);
    // No app session exists yet; the initial state is an honest null baseline.
    await c1.waitFor((f) => f.type === 'orchestrator-state');

    c1.ws.send(JSON.stringify({
      type: 'send', commandId: 'cmd1', sessionId: null, text: 'hi', clientMessageId: 'cm1',
    }));

    // Sender-only receipt acknowledges the durable command, not delivery.
    const ack = await c1.waitFor((f) => f.type === 'conversation-command-receipt');
    assert.equal(ack.status, 'applied');

    // Turn runs to its idle bracket (last chat frame of the turn).
    await c1.waitFor((f) => f.type === 'conversation-event' && f.event?.kind === 'session-state' && f.event?.state === 'idle');
    await sleep(30); // let any trailing non-chat frames settle

    // Streaming deltas use the same durable sequenced envelope.
    assert.ok(c1.frames.some((f) => f.type === 'conversation-event' && f.event?.kind === 'stream-delta'));

    const liveChat = c1.frames.filter((f) => f.type === 'conversation-event');
    // The turn produced its content + exactly one turn-end.
    assert.equal(liveChat.filter((f) => f.event?.kind === 'turn-end').length, 1);
    assert.ok(liveChat.some((f) => f.event?.kind === 'tool-result'));
    assert.ok(liveChat.some((f) => f.event?.kind === 'user'));

    c1.close();

    // Reconnect — the connect snapshot now carries a session-replay.
    const c2 = connect(url);
    const replay = await c2.waitFor((f) => f.type === 'session-replay');

    // Replay events are byte-identical to the live outbox frames, deltas included.
    assert.deepEqual(replay.events, liveChat);
    c2.close();
  } finally {
    await server?.close();
  }
});

test('malformed known conversation command receives a correlated invalid receipt', async () => {
  freshDb();
  const project = newProject('Malformed command');
  let server: RunningServer | null = null;
  try {
    server = await startServer({ mintSession: () => new FakeRuntime(), port: 0, runRecovery: false });
    const client = connect(`ws://localhost:${server.port}/ws?projectId=${project.id}`);
    await client.waitFor((frame) => frame.type === 'orchestrator-state');
    client.ws.send(JSON.stringify({
      type: 'edit-queued-message',
      commandId: 'malformed-edit-1',
      sessionId: 'session-1',
      queueItemId: 'item-1',
      expectedRevision: 0,
      text: 'invalid revision',
    }));
    const receipt = await client.waitFor(
      (frame) => frame.type === 'conversation-command-receipt' && frame.commandId === 'malformed-edit-1',
    );
    assert.equal(receipt.status, 'rejected');
    assert.deepEqual(receipt.error, {
      code: 'invalid',
      message: 'conversation command failed strict validation',
    });
    client.close();
  } finally {
    await server?.close();
  }
});
