// Fake-backend end-to-end (plan DoD 3 + guard rule 6). Real HTTP + WS on an
// ephemeral port, a real `ws` client: connect → send → delta frames stream →
// persisted chat frames land → turn-end → reconnect and the replay matches the
// live stream exactly.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { WebSocket } from 'ws';
import { FakeBackend } from '../src/runner/fake-backend.ts';
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
  { type: 'init', sdkSessionId: 'sdk-e2e', model: 'opus', permissionMode: 'default' },
  { type: 'delta', sdkUuid: 'u1', parentToolUseId: null, delta: { kind: 'message-start' } },
  { type: 'delta', sdkUuid: 'u1', parentToolUseId: null, delta: { kind: 'text-delta', text: 'Hel' } },
  { type: 'delta', sdkUuid: 'u1', parentToolUseId: null, delta: { kind: 'text-delta', text: 'lo' } },
  { type: 'assistant-block', sdkUuid: 'u1', parentToolUseId: null, block: { kind: 'text', text: 'Hello' } },
  { type: 'assistant-block', sdkUuid: 'u1', parentToolUseId: null, block: { kind: 'tool_use', toolUseId: 't1', name: 'Read', input: { path: 'x' } } },
  { type: 'tool-result', sdkUuid: 'u2', parentToolUseId: null, toolUseId: 't1', result: 'contents', isError: false },
  { type: 'assistant-block', sdkUuid: 'u3', parentToolUseId: null, block: { kind: 'text', text: 'Done' } },
  { type: 'result', ok: true, subtype: 'success', stopReason: 'end_turn', usage: { inputTokens: 10, outputTokens: 5, cacheCreationTokens: 0, cacheReadTokens: 0, model: 'opus' }, durationMs: 12, error: null },
]] as never;

test('ws connect → send → deltas → persisted frames → turn-end → reconnect replay identical', async () => {
  freshDb();
  const project = newProject();
  const backend = new FakeBackend({ turns: SCRIPT, stepDelayMs: 1 });
  let server: RunningServer | null = null;
  try {
    server = await startServer({ backendFactory: () => backend, port: 0, runRecovery: false });
    const url = `ws://localhost:${server.port}/ws?projectId=${project.id}`;

    const c1 = connect(url);
    // Connect snapshot lands in contract order, ending with send-queue-snapshot.
    await c1.waitFor((f) => f.type === 'send-queue-snapshot');

    c1.ws.send(JSON.stringify({ type: 'send', text: 'hi', clientMessageId: 'cm1' }));

    // Positive send-ack to the sender.
    const ack = await c1.waitFor((f) => f.type === 'send-ack');
    assert.equal(ack.status, 'received');

    // Turn runs to its idle bracket (last chat frame of the turn).
    await c1.waitFor((f) => f.type === 'chat' && f.event?.kind === 'session-state' && f.event?.state === 'idle');
    await sleep(30); // let any trailing non-chat frames settle

    // Streaming deltas were seen (broadcast-only, never persisted).
    assert.ok(c1.frames.some((f) => f.type === 'chat-delta'), 'expected chat-delta frames');

    const liveChat = c1.frames.filter((f) => f.type === 'chat');
    // The turn produced its content + exactly one turn-end.
    assert.equal(liveChat.filter((f) => f.event?.kind === 'turn-end').length, 1);
    assert.ok(liveChat.some((f) => f.event?.kind === 'tool-result'));
    assert.ok(liveChat.some((f) => f.event?.kind === 'user'));

    c1.close();

    // Reconnect — the connect snapshot now carries a session-replay.
    const c2 = connect(url);
    const replay = await c2.waitFor((f) => f.type === 'session-replay');

    // Rule 6: replay events are byte-identical to the live chat frames.
    assert.deepEqual(replay.events, liveChat);
    c2.close();
  } finally {
    await server?.close();
  }
});
