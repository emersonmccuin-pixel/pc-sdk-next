import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  CHAT_EVENT_KINDS,
  RESOURCE_ENTITIES,
  isChatFrame,
  isChatDeltaFrame,
  isChatEventKind,
  isResourceEntity,
  isResourceFrame,
  isLiveResetFrame,
  isUsageSnapshot,
  isMcpServerStatus,
  isSessionChangedFrame,
  isOrchestratorStateFrame,
  isAskFrame,
  isSendQueueItem,
  type ChatFrame,
  type ResourceFrame,
  type ServerFrame,
} from '../src/index.ts';

test('isChatFrame accepts a well-formed frame and rejects junk', () => {
  const frame: ChatFrame = {
    type: 'chat',
    projectId: 'p1',
    sessionId: 's1',
    seq: 4,
    id: 's1:4',
    event: { kind: 'assistant-text', text: 'hi', midLoop: false },
  };
  assert.equal(isChatFrame(frame), true);
  assert.equal(isChatFrame({ ...frame, event: { kind: 'bogus' } }), false);
  assert.equal(isChatFrame({ ...frame, type: 'chat-delta' }), false);
  assert.equal(isChatFrame(null), false);
});

test('every ChatEvent kind is registered', () => {
  assert.equal(CHAT_EVENT_KINDS.length, 17);
  for (const k of CHAT_EVENT_KINDS) assert.equal(isChatEventKind(k), true);
  assert.equal(isChatEventKind('jsonl-user'), false); // old wire kind is dead
});

test('isChatDeltaFrame validates the delta kinds', () => {
  assert.equal(
    isChatDeltaFrame({ type: 'chat-delta', projectId: 'p', sessionId: 's', sdkUuid: 'u', event: { kind: 'text-delta', text: 'x' } }),
    true,
  );
  assert.equal(
    isChatDeltaFrame({ type: 'chat-delta', projectId: 'p', sessionId: 's', sdkUuid: 'u', event: { kind: 'nope' } }),
    false,
  );
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

// Compile-time smoke: a ServerFrame narrows on `type`.
test('ServerFrame union is inhabited', () => {
  const frames: ServerFrame[] = [
    { type: 'orchestrator-state', projectId: 'p', sessionId: null, health: 'idle', queueDepth: 0, failureReason: null },
  ];
  assert.equal(frames.length, 1);
});
