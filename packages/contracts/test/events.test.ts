import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  CHAT_EVENT_KINDS,
  CLIENT_MESSAGE_TYPES,
  RESOURCE_ENTITIES,
  conversationFamilyForEvent,
  isAgentEventFrame,
  isChatEvent,
  isClientMessage,
  isConversationCommandReceiptFrame,
  isConversationEventFrame,
  isChatEventKind,
  isQueuedAgentEnvelope,
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
  isSendQueueSnapshotFrame,
  safeToolSummary,
  toolStateTransitionError,
  type ChatEvent,
  type ConversationEventFrame,
  type ResourceFrame,
  type SendQueueItem,
  type ServerFrame,
  type ToolStateEvent,
} from '../src/index.ts';

const USER_QUEUE_ITEM: SendQueueItem = {
  id: 'queue-1',
  clientMessageId: 'client-1',
  origin: 'user',
  enqueuePosition: 1,
  revision: 1,
  deliveryRevision: null,
  text: 'hi',
  status: 'queued',
  interruptRequestId: null,
  failureReason: null,
  createdAt: 1,
  updatedAt: 2,
};

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
  assert.equal(isConversationEventFrame({ ...frame, nativeToolUseId: 'native-secret' }), false);
  assert.equal(isConversationEventFrame({
    ...frame,
    event: { ...frame.event, rawThinking: 'SECRET' },
  }), false);
  assert.equal(isConversationEventFrame(null), false);
});

test('every canonical ChatEvent shape rejects undeclared provider fields', () => {
  const events: ChatEvent[] = [
    { kind: 'user', text: 'hello' },
    { kind: 'assistant-text', text: 'hi', midLoop: false },
    { kind: 'turn-end', text: 'done', stopReason: 'complete' },
    { kind: 'turn-failed', error: 'failed', source: 'internal' },
    { kind: 'activity-state', phase: 'responding' },
    {
      kind: 'tool-state',
      callId: 'call-1',
      name: 'Read',
      state: 'requested',
      safeSummary: safeToolSummary('Read'),
      approval: { status: 'unknown', source: null, requestId: null },
      outcome: null,
    },
    {
      kind: 'usage',
      inputTokens: 1,
      outputTokens: 2,
      cacheCreationTokens: 0,
      cacheReadTokens: 0,
      model: null,
    },
    { kind: 'turn-duration', durationMs: 10 },
    { kind: 'session-state', state: 'running', permissionMode: null },
    { kind: 'system', subtype: 'notice', level: 'info', message: 'safe' },
    { kind: 'compaction', trigger: 'auto', preTokens: 10, postTokens: 3 },
    { kind: 'sidechain', role: 'assistant', text: 'safe' },
    { kind: 'agent-dispatch', runId: 'run-1', agentName: 'reviewer' },
    {
      kind: 'agent-envelope',
      runId: 'run-1',
      agentName: 'reviewer',
      status: 'done',
      summary: 'review complete',
      detail: 'passed',
      envelope: 'safe envelope',
    },
    { kind: 'send-state', queueRevision: 1, item: USER_QUEUE_ITEM },
    {
      kind: 'interrupt-state',
      requestId: 'interrupt-1',
      targetTurnId: 'turn-1',
      replacementQueueItemId: null,
      state: 'failed',
      terminalEventId: null,
      result: null,
      failure: { code: 'runtime-failed', message: 'safe failure' },
    },
    { kind: 'retract', streamIds: ['stream-1'] },
  ];

  assert.equal(events.length, CHAT_EVENT_KINDS.length);
  for (const event of events) {
    assert.equal(isChatEvent(event), true, `${event.kind} is valid`);
    assert.equal(isChatEvent({ ...event, rawProviderPayload: 'SECRET' }), false, `${event.kind} is closed`);
  }
  const interrupt = events.find((event) => event.kind === 'interrupt-state');
  assert.ok(interrupt?.kind === 'interrupt-state' && interrupt.failure);
  assert.equal(isChatEvent({
    ...interrupt,
    failure: { ...interrupt.failure, raw: 'SECRET' },
  }), false);
  assert.equal(isChatEvent({
    kind: 'send-state',
    queueRevision: 1,
    item: { ...USER_QUEUE_ITEM, raw: 'SECRET' },
  }), false);
});

test('agent-event frames admit only strict canonical transcript events', () => {
  const frame = {
    type: 'agent-event',
    projectId: 'p',
    runId: 'run-1',
    dedupId: 'event-1',
    event: { kind: 'assistant-text', text: 'safe', midLoop: false },
  };
  assert.equal(isAgentEventFrame(frame), true);
  assert.equal(isAgentEventFrame({ ...frame, nativeSessionId: 'SECRET' }), false);
  assert.equal(isAgentEventFrame({
    ...frame,
    event: { ...frame.event, rawThinking: 'SECRET' },
  }), false);
  assert.equal(isAgentEventFrame({ ...frame, dedupId: '' }), false);
});

test('every ChatEvent kind is registered', () => {
  assert.equal(CHAT_EVENT_KINDS.length, 17);
  for (const k of CHAT_EVENT_KINDS) assert.equal(isChatEventKind(k), true);
  assert.equal(isChatEventKind('jsonl-user'), false); // old wire kind is dead
  for (const retired of ['tool-call', 'tool-result', 'tool-denied']) {
    assert.equal(isChatEventKind(retired), false);
  }
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
  assert.equal(isConversationEventFrame({
    ...frame,
    event: { kind: 'stream-delta', delta: { kind: 'tool-input-delta', partialJson: '{"token":"secret"}' } },
  }), false);
  assert.equal(isConversationEventFrame({
    ...frame,
    event: {
      kind: 'stream-delta',
      delta: { kind: 'text-delta', text: 'safe', toolUseId: 'native', partialJson: 'SECRET' },
    },
  }), false);
  assert.equal(isConversationEventFrame({
    ...frame,
    event: { kind: 'stream-delta', delta: { kind: 'message-start', raw: 'SECRET' } },
  }), false);
  assert.equal(isConversationEventFrame({
    ...frame,
    event: { kind: 'stream-delta', delta: { kind: 'text-delta', text: 'safe' }, raw: 'SECRET' },
  }), false);
});

test('safe activity and tool lifecycle are closed, input-free, and transition guarded', () => {
  const requested: ToolStateEvent = {
    kind: 'tool-state',
    callId: 'call-1',
    name: 'mcp__pc__pc_read_project',
    state: 'requested',
    safeSummary: safeToolSummary('mcp__pc__pc_read_project'),
    approval: { status: 'unknown', source: null, requestId: null },
    outcome: null,
  };
  const approvalNeeded: ToolStateEvent = {
    ...requested,
    state: 'approval-needed',
    approval: { status: 'pending', source: null, requestId: 'approval-1' },
  };
  const running: ToolStateEvent = {
    ...requested,
    state: 'running',
    approval: { status: 'allowed', source: 'user', requestId: 'approval-1' },
  };
  const succeeded: ToolStateEvent = { ...running, state: 'succeeded' };
  const failed: ToolStateEvent = {
    ...running,
    state: 'failed',
    outcome: { reason: 'tool-error' },
  };
  const denied: ToolStateEvent = {
    ...requested,
    state: 'denied',
    approval: { status: 'denied', source: 'timeout', requestId: 'approval-1' },
  };
  for (const event of [requested, approvalNeeded, running, succeeded, failed, denied]) {
    assert.equal(isChatEvent(event), true);
    assert.equal(conversationFamilyForEvent(event), 'tool');
    assert.equal('input' in event, false);
    assert.equal('result' in event, false);
  }
  for (const phase of ['turn-starting', 'requesting-runtime', 'responding', 'retrying', 'compacting'] as const) {
    const event: ChatEvent = { kind: 'activity-state', phase };
    assert.equal(isChatEvent(event), true);
    assert.equal(conversationFamilyForEvent(event), 'activity');
  }
  assert.equal(isChatEvent({ kind: 'activity-state', phase: 'thinking' }), false);
  assert.equal(isChatEvent({ ...requested, safeSummary: 'Reading secrets' }), false);
  assert.equal(isChatEvent({ ...requested, input: { token: 'secret' } }), false);
  assert.equal(isChatEvent({ ...requested, result: 'secret' }), false);
  assert.equal(isChatEvent({ ...requested, toolUseId: 'native-id' }), false);
  assert.equal(isChatEvent({ ...requested, state: 'running' }), false);
  assert.equal(isChatEvent({ ...running, state: 'failed', outcome: null }), false);
  assert.equal(isChatEvent({ ...succeeded, outcome: { reason: 'tool-error' } }), false);

  assert.equal(toolStateTransitionError(null, requested), null);
  assert.equal(toolStateTransitionError(requested, approvalNeeded), null);
  assert.equal(toolStateTransitionError(approvalNeeded, running), null);
  assert.equal(toolStateTransitionError(running, succeeded), null);
  assert.equal(toolStateTransitionError(running, failed), null);
  assert.equal(toolStateTransitionError(approvalNeeded, denied), null);
  assert.equal(toolStateTransitionError(requested, succeeded), 'invalid-transition');
  assert.equal(toolStateTransitionError(succeeded, failed), 'post-terminal');
  assert.equal(toolStateTransitionError(approvalNeeded, {
    ...running,
    approval: { status: 'allowed', source: 'user', requestId: 'different' },
  }), 'approval-request-changed');
  assert.equal(toolStateTransitionError(requested, running), 'approval-provenance-invalid');
  assert.equal(toolStateTransitionError(requested, {
    ...requested,
    state: 'running',
    approval: { status: 'not-required', source: 'runtime', requestId: null },
  }), null);
  assert.equal(toolStateTransitionError(requested, denied), 'approval-provenance-invalid');
  assert.equal(toolStateTransitionError(requested, {
    ...denied,
    approval: { status: 'denied', source: 'runtime', requestId: null },
  }), null);
  assert.equal(toolStateTransitionError(requested, {
    ...failed,
    approval: { status: 'allowed', source: 'user', requestId: 'fabricated' },
    outcome: { reason: 'turn-ended' },
  }), 'approval-provenance-changed');

  const frame: ConversationEventFrame = {
    type: 'conversation-event',
    eventId: 'tool-event-1',
    projectId: 'p',
    conversationId: 's',
    sessionId: 's',
    sequence: 1,
    family: 'tool',
    turnId: 'turn-1',
    itemId: 'call-1',
    occurredAt: 1,
    event: requested,
  };
  assert.equal(isConversationEventFrame(frame), true);
  assert.equal(isConversationEventFrame({ ...frame, itemId: 'native-tool-id' }), false);
  assert.equal(isConversationEventFrame({ ...frame, turnId: undefined }), false);
  assert.equal(isConversationEventFrame({
    ...frame,
    family: 'activity',
    event: { kind: 'activity-state', phase: 'responding' },
    itemId: 'activity-1',
    turnId: undefined,
  }), false);
  assert.equal(isConversationEventFrame({
    ...frame,
    family: 'control',
    event: { kind: 'turn-end', text: '', stopReason: 'complete' },
    itemId: 'terminal-1',
    turnId: undefined,
  }), true);
  assert.equal(isChatEvent({
    kind: 'system', subtype: 'notice', level: 'info', message: 'safe', raw: { secret: true },
  }), false);
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

test('session-changed + orchestrator-state + ask guards', () => {
  assert.equal(
    isSessionChangedFrame({
      type: 'session-changed',
      projectId: 'p',
      transition: 'new-session',
      session: {
        id: 's', projectId: 'p', model: null, title: null,
        status: 'active', resumable: false, startedAt: 1,
      },
    }),
    true,
  );
  assert.equal(isSessionChangedFrame({ type: 'session-changed', projectId: 'p', transition: 'x', session: null }), false);
  assert.equal(isSessionChangedFrame({ type: 'session-changed', transition: 'new-session', session: null }), false);
  assert.equal(isSessionChangedFrame({ type: 'session-changed', projectId: '', transition: 'new-session', session: null }), false);
  assert.equal(isSessionChangedFrame({
    type: 'session-changed',
    projectId: 'p',
    transition: 'new-session',
    session: {
      id: 's', projectId: 'foreign', model: null, title: null,
      status: 'active', resumable: false, startedAt: 1,
    },
  }), false);
  assert.equal(isSessionChangedFrame({
    type: 'session-changed',
    projectId: 'p',
    transition: 'new-session',
    session: {
      id: 's', projectId: 'p', model: null, title: null,
      status: 'active', resumable: true, startedAt: 1,
    },
  }), false);

  assert.equal(
    isOrchestratorStateFrame({
      type: 'orchestrator-state',
      projectId: 'p',
      sessionId: 's',
      activeTurnId: 'turn-1',
      health: 'busy',
      queueDepth: 0,
      failureReason: null,
    }),
    true,
  );
  const idleState = {
    type: 'orchestrator-state',
    projectId: 'p',
    sessionId: null,
    activeTurnId: null,
    health: 'idle',
    queueDepth: 0,
    failureReason: null,
  };
  assert.equal(isOrchestratorStateFrame(idleState), true);
  assert.equal(isOrchestratorStateFrame({ ...idleState, projectId: '' }), false);
  assert.equal(isOrchestratorStateFrame({ ...idleState, activeTurnId: '' }), false);
  assert.equal(isOrchestratorStateFrame({ ...idleState, health: 'exploded' }), false);
  assert.equal(isOrchestratorStateFrame({ ...idleState, queueDepth: -1 }), false);
  assert.equal(isOrchestratorStateFrame({ ...idleState, queueDepth: 0.5 }), false);
  assert.equal(isOrchestratorStateFrame({ ...idleState, queueDepth: Number.NaN }), false);

  assert.equal(
    isAskFrame({ type: 'ask', projectId: 'p', askId: 'a1', sessionId: null, toolName: 'Bash', callId: 'call-1', toolInput: {} }),
    true,
  );
  assert.equal(
    isAskFrame({ type: 'ask', projectId: 'p', askId: 'a1', sessionId: null, toolName: 'Bash', callId: '', toolInput: {} }),
    false,
  );
  assert.equal(
    isAskFrame({
      type: 'ask', projectId: 'p', askId: 'a1', sessionId: null,
      toolName: 'Bash', callId: 'call-1', toolInput: {}, toolUseId: 'native-secret',
    }),
    false,
  );
});

test('client message guards close every durable send and interrupt command shape', () => {
  const messages = [
    { type: 'send', commandId: 'cmd-1', sessionId: null, text: 'first', clientMessageId: 'client-1' },
    { type: 'edit-queued-message', commandId: 'cmd-2', sessionId: 's', queueItemId: 'q', expectedRevision: 2, text: 'second' },
    { type: 'remove-queued-message', commandId: 'cmd-3', sessionId: 's', queueItemId: 'q', expectedRevision: 2 },
    { type: 'interrupt', requestId: 'request-1', sessionId: 's', targetTurnId: 'turn-1' },
    {
      type: 'interrupt-and-send', requestId: 'request-2', sessionId: 's', targetTurnId: 'turn-1',
      replacement: { kind: 'new', clientMessageId: 'client-2', text: 'replacement' },
    },
    {
      type: 'interrupt-and-send', requestId: 'request-3', sessionId: 's', targetTurnId: 'turn-1',
      replacement: { kind: 'queued', queueItemId: 'q', expectedRevision: 2 },
    },
    { type: 'ask-reply', askId: 'ask-1', answer: '' },
    { type: 'subscribe', lastVersion: '8' },
    { type: 'client-ping', nonce: 'nonce-1', sentAt: 10 },
  ];

  assert.deepEqual(CLIENT_MESSAGE_TYPES, [
    'send',
    'edit-queued-message',
    'remove-queued-message',
    'interrupt',
    'interrupt-and-send',
    'ask-reply',
    'subscribe',
    'client-ping',
  ]);
  for (const message of messages) assert.equal(isClientMessage(message), true);

  assert.equal(isClientMessage({ ...messages[0], commandId: '' }), false);
  assert.equal(isClientMessage({ ...messages[1], expectedRevision: 0 }), false);
  assert.equal(isClientMessage({ ...messages[2], queueItemId: '' }), false);
  assert.equal(isClientMessage({ ...messages[3], targetTurnId: '' }), false);
  assert.equal(isClientMessage({ ...messages[4], replacement: { kind: 'new', clientMessageId: '', text: 'x' } }), false);
  assert.equal(isClientMessage({ ...messages[4], replacement: { kind: 'queued', queueItemId: 'q', expectedRevision: -1 } }), false);
  assert.equal(isClientMessage({ ...messages[4], replacement: { kind: 'later' } }), false);
  assert.equal(isClientMessage({ type: 'interrupt', sessionId: 's', targetTurnId: 'turn-1' }), false);
  assert.equal(isClientMessage({ type: 'legacy-send', text: 'nope' }), false);
});

test('conversation command receipts require typed status/error consistency', () => {
  const applied = {
    type: 'conversation-command-receipt',
    projectId: 'p',
    sessionId: 's',
    commandId: 'cmd-1',
    command: 'send',
    status: 'applied',
    queueItemId: 'q',
    revision: 1,
    error: null,
  };
  const rejected = {
    ...applied,
    commandId: 'cmd-2',
    command: 'edit-queued-message',
    status: 'rejected',
    error: { code: 'revision-conflict', message: 'stale revision', currentRevision: 2 },
  };
  assert.equal(isConversationCommandReceiptFrame(applied), true);
  assert.equal(isConversationCommandReceiptFrame({ ...applied, status: 'duplicate' }), true);
  assert.equal(isConversationCommandReceiptFrame(rejected), true);
  assert.equal(isConversationCommandReceiptFrame({ ...applied, command: 'ask-reply' }), false);
  assert.equal(isConversationCommandReceiptFrame({ ...applied, status: 'received' }), false);
  assert.equal(isConversationCommandReceiptFrame({ ...applied, revision: 0 }), false);
  assert.equal(isConversationCommandReceiptFrame({ ...applied, queueItemId: undefined }), false);
  assert.equal(isConversationCommandReceiptFrame({ ...applied, revision: undefined }), false);
  assert.equal(isConversationCommandReceiptFrame({ ...applied, command: 'interrupt' }), false);
  assert.equal(isConversationCommandReceiptFrame({
    ...applied,
    command: 'interrupt',
    queueItemId: undefined,
    revision: undefined,
    interruptRequestId: 'interrupt-1',
  }), true);
  assert.equal(isConversationCommandReceiptFrame({
    ...applied,
    command: 'interrupt-and-send',
    interruptRequestId: 'interrupt-1',
  }), true);
  assert.equal(isConversationCommandReceiptFrame({ ...rejected, error: { ...rejected.error, code: 'unknown' } }), false);
  assert.equal(isConversationCommandReceiptFrame({ ...applied, error: { code: 'internal', message: 'bad' } }), false);
  assert.equal(isConversationCommandReceiptFrame({ ...rejected, error: null }), false);
});

test('durable send queue item and reconnect snapshot guards are closed', () => {
  assert.equal(isSendQueueItem(USER_QUEUE_ITEM), true);
  assert.equal(isSendQueueItem({ ...USER_QUEUE_ITEM, origin: 'system' }), false);
  assert.equal(isSendQueueItem({ ...USER_QUEUE_ITEM, enqueuePosition: 0 }), false);
  assert.equal(isSendQueueItem({ ...USER_QUEUE_ITEM, revision: 0 }), false);
  assert.equal(isSendQueueItem({ ...USER_QUEUE_ITEM, deliveryRevision: 0 }), false);
  assert.equal(isSendQueueItem({ ...USER_QUEUE_ITEM, status: 'delivered_to_pty' }), false);
  assert.equal(isSendQueueItem({ ...USER_QUEUE_ITEM, interruptRequestId: '' }), false);
  assert.equal(isSendQueueItem({ ...USER_QUEUE_ITEM, createdAt: Number.NaN }), false);

  const envelope = {
    runId: 'run-1',
    agentName: 'reviewer',
    pendingAskId: 'ask-1',
    status: 'waiting',
    summary: 'Review pending',
    detail: 'Waiting for verification.',
  };
  assert.equal(isQueuedAgentEnvelope(envelope), true);
  assert.equal(isQueuedAgentEnvelope({ ...envelope, status: 'running' }), false);
  assert.equal(isQueuedAgentEnvelope({ ...envelope, agentName: '' }), false);

  const snapshot = {
    type: 'send-queue-snapshot',
    projectId: 'p',
    sessionId: 's',
    queueRevision: 4,
    items: [USER_QUEUE_ITEM],
  };
  assert.equal(isSendQueueSnapshotFrame(snapshot), true);
  assert.equal(isSendQueueSnapshotFrame({ ...snapshot, projectId: '' }), false);
  assert.equal(isSendQueueSnapshotFrame({ ...snapshot, sessionId: '' }), false);
  assert.equal(isSendQueueSnapshotFrame({ ...snapshot, queueRevision: -1 }), false);
  assert.equal(isSendQueueSnapshotFrame({ ...snapshot, queueRevision: 1.5 }), false);
  assert.equal(isSendQueueSnapshotFrame({ ...snapshot, items: [{ ...USER_QUEUE_ITEM, status: 'unknown' }] }), false);
  assert.equal(isSendQueueSnapshotFrame({ ...snapshot, items: [{ ...USER_QUEUE_ITEM, status: 'accepted' }] }), false);
  assert.equal(isSendQueueSnapshotFrame({ ...snapshot, items: [USER_QUEUE_ITEM, { ...USER_QUEUE_ITEM, text: 'duplicate id' }] }), false);
  assert.equal(isSendQueueSnapshotFrame({ ...snapshot, items: [USER_QUEUE_ITEM, { ...USER_QUEUE_ITEM, id: 'q2' }] }), false);
  assert.equal(isSendQueueSnapshotFrame({ ...snapshot, items: [USER_QUEUE_ITEM, { ...USER_QUEUE_ITEM, id: 'q2', clientMessageId: 'c2' }] }), false);
});

test('canonical send and interrupt lifecycle events enforce family and positive receipts', () => {
  const sendState: ChatEvent = { kind: 'send-state', queueRevision: 1, item: USER_QUEUE_ITEM };
  assert.equal(isChatEvent(sendState), true);
  assert.equal(conversationFamilyForEvent(sendState), 'user');
  assert.equal(
    conversationFamilyForEvent({ ...sendState, item: { ...USER_QUEUE_ITEM, origin: 'agent-envelope' } }),
    'agent',
  );
  assert.equal(isChatEvent({ ...sendState, queueRevision: 0 }), false);

  const requested: ChatEvent = {
    kind: 'interrupt-state',
    requestId: 'request-1',
    targetTurnId: 'turn-1',
    replacementQueueItemId: 'queue-1',
    state: 'requested',
    terminalEventId: null,
    result: null,
    failure: null,
  };
  const confirmed: ChatEvent = {
    ...requested,
    state: 'confirmed',
    terminalEventId: 'event-1',
    result: 'aborted',
  };
  const failedBeforeTerminal: ChatEvent = {
    ...requested,
    state: 'failed',
    failure: { code: 'runtime-interrupt-failed', message: 'adapter rejected request' },
  };
  const failedAtTerminal: ChatEvent = {
    ...failedBeforeTerminal,
    terminalEventId: 'event-2',
    result: 'completed',
  };
  assert.equal(isChatEvent(requested), true);
  assert.equal(isChatEvent(confirmed), true);
  assert.equal(isChatEvent(failedBeforeTerminal), true);
  assert.equal(isChatEvent(failedAtTerminal), true);
  assert.equal(conversationFamilyForEvent(requested), 'control');
  assert.equal(isChatEvent({ ...requested, terminalEventId: 'event-1' }), false);
  assert.equal(isChatEvent({ ...confirmed, result: 'completed' }), false);
  assert.equal(isChatEvent({ ...confirmed, failure: { code: 'x', message: 'x' } }), false);
  assert.equal(isChatEvent({ ...failedBeforeTerminal, result: 'turn-failed' }), false);
  assert.equal(isChatEvent({ ...failedAtTerminal, terminalEventId: null }), false);
  assert.equal(isChatEvent({ ...failedAtTerminal, result: 'aborted' }), false);
  assert.equal(isChatEvent({ ...failedBeforeTerminal, failure: null }), false);

  const eventFrame: ConversationEventFrame = {
    type: 'conversation-event',
    eventId: 'event-3',
    projectId: 'p',
    conversationId: 's',
    sessionId: 's',
    sequence: 3,
    family: 'control',
    itemId: 'request-1',
    occurredAt: 3,
    event: requested,
  };
  assert.equal(isConversationEventFrame(eventFrame), true);
  assert.equal(isConversationEventFrame({ ...eventFrame, family: 'system' }), false);
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
  assert.equal(isSessionReplayFrame({
    type: 'session-replay', projectId: 'p', sessionId: 's', highWaterSequence: 1,
    events: [event], raw: 'SECRET',
  }), false);
  assert.equal(isSessionReplayFrame({
    type: 'session-replay', projectId: 'p', sessionId: 's', highWaterSequence: 0, events: [event],
  }), false);

  // Migration 0009 cannot safely infer turn ownership for legacy terminals.
  // They remain valid replay evidence even though the DB new-write door now
  // requires every new terminal to carry a non-empty turn id.
  const legacyTerminal: ConversationEventFrame = {
    type: 'conversation-event', eventId: 'legacy-terminal', projectId: 'p', conversationId: 's',
    sessionId: 's', sequence: 2, family: 'control', itemId: 'legacy-terminal', occurredAt: 2,
    event: { kind: 'turn-end', text: 'legacy answer', stopReason: 'complete' },
  };
  assert.equal(isSessionReplayFrame({
    type: 'session-replay', projectId: 'p', sessionId: 's', highWaterSequence: 2,
    events: [event, legacyTerminal],
  }), true);
});

// Compile-time smoke: a ServerFrame narrows on `type`.
test('ServerFrame union is inhabited', () => {
  const frames: ServerFrame[] = [
    {
      type: 'orchestrator-state',
      projectId: 'p',
      sessionId: null,
      activeTurnId: null,
      health: 'idle',
      queueDepth: 0,
      failureReason: null,
    },
  ];
  assert.equal(frames.length, 1);
});
