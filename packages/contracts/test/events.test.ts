import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  CHAT_EVENT_KINDS,
  RESOURCE_ENTITIES,
  isConversationEventFrame,
  isChatEventKind,
  isResourceEntity,
  isResourceFrame,
  isLiveResetFrame,
  isUsageSnapshot,
  isMcpServerStatus,
  isSessionChangedFrame,
  isSessionReplayFrame,
  isOrchestratorStateFrame,
  isAskFrame,
  isSendQueueItem,
  type ConversationEventFrame,
  type ResourceFrame,
  type ServerFrame,
} from '../src/index.ts';

test('isConversationEventFrame enforces canonical identity', () => {
  const frame: ConversationEventFrame = {
    type: 'conversation-event',
    eventId: 'e1',
    projectId: 'p1',
    conversationId: 'c1',
    sessionId: 's1',
    sequence: 4,
    family: 'assistant',
    itemId: 'i1',
    occurredAt: 10,
    event: { kind: 'assistant-text', text: 'hi', midLoop: false },
  };
  assert.equal(isConversationEventFrame(frame), true);
  assert.equal(isConversationEventFrame({ ...frame, event: { kind: 'bogus' } }), false);
  assert.equal(isConversationEventFrame({ ...frame, event: { kind: 'assistant-text', text: 'missing flag' } }), false);
  assert.equal(isConversationEventFrame({ ...frame, family: 'user' }), false);
  assert.equal(isConversationEventFrame({ ...frame, sequence: 0 }), false);
  assert.equal(isConversationEventFrame({ ...frame, itemId: '' }), false);
  assert.equal(isConversationEventFrame(null), false);
});

test('every ChatEvent kind is registered', () => {
  assert.equal(CHAT_EVENT_KINDS.length, 16);
  for (const k of CHAT_EVENT_KINDS) assert.equal(isChatEventKind(k), true);
  assert.equal(isChatEventKind('jsonl-user'), false); // old wire kind is dead
});

test('stream deltas use the same sequenced envelope and require stream order', () => {
  const frame = {
    type: 'conversation-event',
    eventId: 'e2',
    projectId: 'p',
    conversationId: 'c',
    sessionId: 's',
    sequence: 2,
    family: 'assistant',
    itemId: 'i',
    streamId: 'stream',
    deltaIndex: 0,
    occurredAt: 2,
    event: { kind: 'stream-delta', delta: { kind: 'text-delta', text: 'x' } },
  };
  assert.equal(isConversationEventFrame(frame), true);
  assert.equal(isConversationEventFrame({ ...frame, streamId: undefined }), false);
  assert.equal(isConversationEventFrame({ ...frame, deltaIndex: -1 }), false);
  assert.equal(isConversationEventFrame({ ...frame, event: { kind: 'stream-delta', delta: { kind: 'text-delta' } } }), false);
  assert.equal(isConversationEventFrame({ ...frame, event: { kind: 'stream-delta', delta: { kind: 'nope' } } }), false);
});

test('ResourceEntity is a closed set (guard rule 7)', () => {
  assert.deepEqual([...RESOURCE_ENTITIES].sort(), [
    'agent-run',
    'contract',
    'mailbox-message',
    'mcp-server',
    'project',
    'session-title',
    'specialist',
    'usage',
  ]);
  for (const e of RESOURCE_ENTITIES) assert.equal(isResourceEntity(e), true);
  // dead entities from the old wire must not classify
  for (const dead of ['work-item', 'workflow-run', 'pod', 'stage', 'host-health']) {
    assert.equal(isResourceEntity(dead), false);
  }
});

test('isResourceFrame checks entity + eventType agreement', () => {
  const frame: ResourceFrame = {
    type: 'resource',
    event: {
      id: 'e1',
      cursor: '12',
      scope: 'project',
      projectId: 'p1',
      entity: 'specialist',
      entityId: 'sp1',
      eventType: 'specialist.changed',
      version: null,
      createdAt: 1,
      payload: { specialistId: 'sp1' },
    },
  };
  assert.equal(isResourceFrame(frame), true);
  // entity/eventType mismatch
  assert.equal(
    isResourceFrame({ ...frame, event: { ...frame.event, eventType: 'project.changed' } }),
    false,
  );
  // dead entity name
  assert.equal(
    isResourceFrame({ ...frame, event: { ...frame.event, entity: 'work-item', eventType: 'work-item.changed' } }),
    false,
  );
});

test('isLiveResetFrame', () => {
  assert.equal(isLiveResetFrame({ type: 'live-reset', projectId: null, cursor: null }), true);
  assert.equal(isLiveResetFrame({ type: 'live-reset', projectId: 'p', cursor: '9' }), true);
  assert.equal(isLiveResetFrame({ type: 'resource' }), false);
});

test('isUsageSnapshot + isMcpServerStatus', () => {
  assert.equal(
    isUsageSnapshot({
      accountId: 'personal',
      fiveHour: { utilization: 0.4, resetsAt: 123 },
      sevenDay: null,
      fable: { utilization: 0.92, resetsAt: 456 },
      status: 'allowed_warning',
      model: 'opus',
      updatedAt: 1,
    }),
    true,
  );
  assert.equal(isUsageSnapshot({ accountId: 'x', fiveHour: {}, sevenDay: null, fable: null, status: 'allowed', model: null, updatedAt: 1 }), false);
  assert.equal(
    isMcpServerStatus({
      id: 'm1',
      name: 'ainativepm',
      status: 'unknown',
      reason: null,
      lastProbeAt: null,
      toolCount: null,
      lastError: null,
    }),
    true,
  );
  assert.equal(isMcpServerStatus({ id: 'm1', name: 'x', status: 'flaky' }), false);
});

test('session-changed + orchestrator-state + ask + send-queue-item guards', () => {
  assert.equal(
    isSessionChangedFrame({
      type: 'session-changed',
      projectId: 'p',
      transition: 'new-session',
      session: { id: 's', projectId: 'p', model: null, title: null, status: 'active', startedAt: 1 },
    }),
    true,
  );
  assert.equal(isSessionChangedFrame({ type: 'session-changed', projectId: 'p', transition: 'x', session: null }), false);

  assert.equal(
    isOrchestratorStateFrame({ type: 'orchestrator-state', projectId: 'p', sessionId: null, health: 'busy', queueDepth: 0, failureReason: null }),
    true,
  );
  assert.equal(isOrchestratorStateFrame({ type: 'orchestrator-state', projectId: 'p', sessionId: null, health: 'exploded', queueDepth: 0, failureReason: null }), false);

  assert.equal(
    isAskFrame({ type: 'ask', projectId: 'p', askId: 'a1', sessionId: null, toolName: 'Bash', toolUseId: 'tu1', toolInput: {} }),
    true,
  );

  assert.equal(
    isSendQueueItem({ id: 'i1', clientMessageId: 'c1', text: 'hi', status: 'queued', failureReason: null, createdAt: 1, updatedAt: 2 }),
    true,
  );
  assert.equal(isSendQueueItem({ id: 'i1', clientMessageId: 'c1', text: 'hi', status: 'delivered_to_pty', failureReason: null, createdAt: 1, updatedAt: 2 }), false);
});

test('session replay validates every canonical event identity', () => {
  const event: ConversationEventFrame = {
    type: 'conversation-event', eventId: 'e', projectId: 'p', conversationId: 's',
    sessionId: 's', sequence: 1, family: 'user', itemId: 'i', occurredAt: 1,
    event: { kind: 'user', text: 'hi' },
  };
  assert.equal(isSessionReplayFrame({
    type: 'session-replay', projectId: 'p', sessionId: 's', highWaterSequence: 1, events: [event],
  }), true);
  assert.equal(isSessionReplayFrame({
    type: 'session-replay', projectId: 'p', sessionId: 'other', highWaterSequence: 1, events: [event],
  }), false);
});

// Compile-time smoke: a ServerFrame narrows on `type`.
test('ServerFrame union is inhabited', () => {
  const frames: ServerFrame[] = [
    { type: 'orchestrator-state', projectId: 'p', sessionId: null, health: 'idle', queueDepth: 0, failureReason: null },
  ];
  assert.equal(frames.length, 1);
});
