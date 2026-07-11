import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  commitConversationEvent,
  getRawDb,
  listUnrelayedConversationEvents,
  markConversationEventsRelayed,
} from '@pc/db';
import type { ConversationEventFrame } from '@pc/contracts';
import type { ULID } from '@pc/domain';
import { ConversationRelay } from '../src/chat/conversation-relay.ts';
import { ProjectWebSocketHub, type WebSocketLike } from '../src/ws/hub.ts';
import { freshDb, newProject } from './helpers.ts';

function committed(projectId: ULID) {
  return commitConversationEvent({
    projectId,
    conversationId: 'conversation-1',
    sessionId: 'conversation-1',
    family: 'user',
    event: { kind: 'user', text: 'hello' },
    itemId: 'item-1',
    occurredAt: 1,
    deliveryKind: 'chat',
  });
}

test('relay fans the committed row shape then marks its outbox entry', () => {
  freshDb();
  const project = newProject();
  const commit = committed(project.id);
  const sent: ConversationEventFrame[] = [];
  const hub = new ProjectWebSocketHub<ULID>();
  const socket: WebSocketLike = {
    OPEN: 1,
    readyState: 1,
    send: (data) => sent.push(JSON.parse(data) as ConversationEventFrame),
  };
  hub.subscribe(project.id, socket);
  new ConversationRelay({ hub }).drain();
  assert.equal(sent.length, 1);
  assert.equal(sent[0]!.eventId, commit.event.eventId);
  assert.equal(sent[0]!.sequence, commit.event.sequence);
  assert.equal(listUnrelayedConversationEvents().length, 0);
});

test('fan failure leaves the row pending for retry', () => {
  freshDb();
  const project = newProject();
  committed(project.id);
  const hub = new ProjectWebSocketHub<ULID>();
  hub.subscribe(project.id, {
    OPEN: 1,
    readyState: 1,
    send: () => { throw new Error('socket failed'); },
  });
  assert.throws(() => new ConversationRelay({ hub }).drain(), /socket failed/);
  assert.equal(listUnrelayedConversationEvents().length, 1);
});

test('post-fan mark failure redelivers the exact immutable event', () => {
  freshDb();
  const project = newProject();
  committed(project.id);
  const sent: string[] = [];
  const hub = new ProjectWebSocketHub<ULID>();
  hub.subscribe(project.id, { OPEN: 1, readyState: 1, send: (data) => sent.push(data) });
  let failMark = true;
  const relay = new ConversationRelay({
    hub,
    markRelayed: (ids, now) => {
      if (failMark) {
        failMark = false;
        throw new Error('crash before mark');
      }
      markConversationEventsRelayed(ids, now);
    },
  });
  assert.throws(() => relay.drain(), /crash before mark/);
  relay.drain();
  assert.equal(sent.length, 2);
  assert.equal(sent[0], sent[1]);
});

test('a pending hidden evidence row is marked without fanout', () => {
  freshDb();
  const project = newProject();
  const commit = committed(project.id);
  const raw = getRawDb();
  raw.prepare('UPDATE conversation_events SET projection_state = ? WHERE event_id = ?')
    .run('legacy-hidden', commit.event.eventId);
  const sent: string[] = [];
  const hub = new ProjectWebSocketHub<ULID>();
  hub.subscribe(project.id, { OPEN: 1, readyState: 1, send: (data) => sent.push(data) });
  new ConversationRelay({ hub }).drain();
  assert.deepEqual(sent, []);
  assert.equal(listUnrelayedConversationEvents().length, 0);
});
