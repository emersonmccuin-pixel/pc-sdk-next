import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  conversationFamilyForEvent,
  safeToolSummary,
  type AskFrame,
  type ChatEvent,
  type ConversationEvent,
  type ConversationEventFrame,
  type SendQueueItem,
  type SessionChangedFrame,
  type SessionReplayFrame,
  type ToolStateEvent,
} from '../../../packages/contracts/src/events/index.ts';
import {
  addOptimistic,
  answerAsk,
  applyAsk,
  applyConversationCommandReceipt,
  applyConversationEvent,
  applyReplay,
  applySendQueueSnapshot,
  applySessionChanged,
  initialChatState,
  reduceConversationEvent,
  reduceReplay,
  type ChatState,
  type ProjectionWork,
} from '../src/features/chat/chat-reducer.ts';
import { buildRenderItems } from '../src/features/chat/chat-render.ts';
import {
  PERSISTENT_SEQUENCE_CHUNK_SIZE,
  sequenceToArray,
  type PersistentSequence,
} from '../src/features/chat/persistent-sequence.ts';
import { sha256 } from '../src/features/chat/sha256.ts';
import { indexEntries } from '../src/features/chat/persistent-index.ts';

const SID = 'session-1';

function frame(
  sequence: number,
  event: ConversationEvent,
  extra: Partial<ConversationEventFrame> = {},
): ConversationEventFrame {
  return {
    type: 'conversation-event',
    eventId: `event-${sequence}`,
    projectId: 'project-1',
    conversationId: SID,
    sessionId: SID,
    sequence,
    family: conversationFamilyForEvent(event),
    itemId: event.kind === 'tool-state' ? event.callId : `item-${sequence}`,
    occurredAt: sequence,
    event,
    ...extra,
  };
}

function usage(tokens: number): ChatEvent {
  return {
    kind: 'usage',
    inputTokens: tokens,
    outputTokens: tokens,
    cacheCreationTokens: 0,
    cacheReadTokens: 0,
    model: `model-${tokens}`,
  };
}

function seed(): ChatState {
  return initialChatState(SID);
}

function sessionChanged(
  transition: SessionChangedFrame['transition'],
  sessionId = SID,
): SessionChangedFrame {
  return {
    type: 'session-changed',
    projectId: 'project-1',
    transition,
    session: {
      id: sessionId,
      projectId: 'project-1',
      selection: {
        runtimeId: 'runtime-1',
        accountId: 'account-1',
        model: 'model-1',
        effort: { kind: 'none' },
      },
      title: null,
      status: 'active',
      nativeSessionIdPresent: false,
      continuationState: 'clean-pending',
      resumeAvailability: { status: 'unavailable', code: 'session-active' },
      startedAt: 1,
    },
  };
}

function tool(
  state: ToolStateEvent['state'],
  over: Partial<ToolStateEvent> = {},
): ToolStateEvent {
  const approval: ToolStateEvent['approval'] = state === 'requested'
    ? { status: 'unknown', source: null, requestId: null }
    : state === 'approval-needed'
      ? { status: 'pending', source: null, requestId: 'approval-1' }
      : state === 'denied'
        ? { status: 'denied', source: 'user', requestId: 'approval-1' }
        : { status: 'not-required', source: 'runtime', requestId: null };
  return {
    kind: 'tool-state',
    callId: 'call-1',
    name: 'Read',
    state,
    safeSummary: safeToolSummary('Read'),
    approval,
    outcome: state === 'failed' ? { reason: 'tool-error' } : null,
    ...over,
  };
}

function queueItem(overrides: Partial<SendQueueItem> = {}): SendQueueItem {
  return {
    id: 'queue-1',
    clientMessageId: 'client-1',
    origin: 'user',
    enqueuePosition: 1,
    revision: 1,
    deliveryRevision: null,
    text: 'queued text',
    status: 'queued',
    interruptRequestId: null,
    failureReason: null,
    createdAt: 1,
    updatedAt: 1,
    ...overrides,
  };
}

function containsText(value: unknown, marker: string, seen = new WeakSet<object>()): boolean {
  if (typeof value === 'string') return value.includes(marker);
  if (value === null || typeof value !== 'object') return false;
  if (seen.has(value)) return false;
  seen.add(value);
  if (Array.isArray(value)) return value.some((entry) => containsText(entry, marker, seen));
  return Object.values(value).some((entry) => containsText(entry, marker, seen));
}

function projectionView(state: ChatState) {
  const frames = sequenceToArray(state.frames);
  const projectedFrames = sequenceToArray(state.projectedFrames);
  return {
    frames,
    projectedFrames,
    aggregates: state.aggregates,
    contextProjection: state.contextProjection,
    toolStates: indexEntries(state.toolStates),
    currentActivity: state.currentActivity,
    terminalTurns: indexEntries(state.terminalTurns),
    asks: state.asks,
    pendingAsks: state.pendingAsks,
    answeredAsks: state.answeredAsks,
    deltas: state.deltas,
    conflicts: state.integrityConflicts,
    highWaterSequence: state.highWaterSequence,
    projectedThroughSequence: state.projectedThroughSequence,
    rendered: buildRenderItems(projectedFrames),
  };
}

function maxChunkSize<Value>(sequence: PersistentSequence<Value>): number {
  let maximum = 0;
  let chunk = sequence.tail;
  while (chunk) {
    maximum = Math.max(maximum, chunk.values.length);
    chunk = chunk.previous;
  }
  return maximum;
}

function chunkCount<Value>(sequence: PersistentSequence<Value>): number {
  let count = 0;
  let chunk = sequence.tail;
  while (chunk) {
    count += 1;
    chunk = chunk.previous;
  }
  return count;
}

function addWork(total: ProjectionWork, next: ProjectionWork): void {
  total.acceptedEventVisits += next.acceptedEventVisits;
  total.historyVisits += next.historyVisits;
  total.fallbackRebuilds += next.fallbackRebuilds;
  total.compactedDeltaPayloads += next.compactedDeltaPayloads;
}

test('projector receipt digests use the standard SHA-256 identity', () => {
  assert.equal(
    sha256('abc'),
    'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad',
  );
});

test('context projection readiness is independent from queue checkpoint readiness', () => {
  assert.equal(initialChatState().contextProjectionReady, true, 'no session is resolved truth');

  const resumed = applySessionChanged(seed(), sessionChanged('resume-session'));
  assert.equal(resumed.contextProjectionReady, false);
  const queueCheckpoint = applySendQueueSnapshot(resumed, {
    type: 'send-queue-snapshot',
    projectId: 'project-1',
    sessionId: SID,
    queueRevision: 0,
    items: [],
  });
  assert.equal(queueCheckpoint.sessionContextReady, true);
  assert.equal(
    queueCheckpoint.contextProjectionReady,
    false,
    'a queue snapshot is not evidence that context replay succeeded',
  );

  const replayed = applyReplay(queueCheckpoint, {
    type: 'session-replay',
    projectId: 'project-1',
    sessionId: SID,
    highWaterSequence: 0,
    events: [],
  });
  assert.equal(replayed.contextProjectionReady, true, 'an empty valid replay is authoritative');
  assert.equal(replayed.contextProjection.observation, null);

  const created = applySessionChanged(seed(), sessionChanged('new-session', 'session-new'));
  assert.equal(created.contextProjectionReady, true, 'a new session has no prior context to replay');
  assert.equal(created.contextProjection.observation, null);
});

test('context observation, new turns, compaction, and unavailability fold by server order', () => {
  const turnOne = 'turn-context-1';
  const turnTwo = 'turn-context-2';
  let state = applyConversationEvent(seed(), frame(1, {
    kind: 'activity-state', phase: 'turn-starting',
  }, { turnId: turnOne }));
  state = applyConversationEvent(state, frame(2, {
    kind: 'turn-end', text: '', stopReason: 'complete',
  }, { turnId: turnOne }));
  state = applyConversationEvent(state, frame(3, {
    kind: 'context-observation', confidence: 'exact',
    usedTokens: 40, usableTokens: 100, contextWindowTokens: 120,
  }, { turnId: turnOne }));
  assert.equal(state.contextProjectionReady, true);
  assert.equal(state.contextProjection.freshness, 'fresh');
  assert.equal(state.contextProjection.latestStartedTurnId, turnOne);
  assert.equal(state.contextProjection.acceptedObservationTurnId, turnOne);
  assert.equal(state.contextProjection.observation?.observation.confidence, 'exact');

  state = applyConversationEvent(state, frame(4, {
    kind: 'activity-state', phase: 'turn-starting',
  }, { turnId: turnTwo }));
  assert.equal(state.contextProjection.freshness, 'stale');
  assert.equal(state.contextProjection.latestStartedTurnId, turnTwo);

  state = applyConversationEvent(state, frame(5, {
    kind: 'compaction', trigger: 'auto', preTokens: 80, postTokens: 20,
  }, { turnId: turnTwo }));
  assert.deepEqual(state.contextProjection.latestCompaction, {
    turnId: turnTwo,
    sequence: 5,
    occurredAt: 5,
    trigger: 'auto',
    preTokens: 80,
    postTokens: 20,
  });
  assert.equal(state.contextProjection.freshness, 'stale');

  state = applyConversationEvent(state, frame(6, {
    kind: 'turn-end', text: '', stopReason: 'complete',
  }, { turnId: turnTwo }));
  state = applyConversationEvent(state, frame(7, {
    kind: 'context-observation', confidence: 'unavailable', reason: 'observation-timeout',
  }, { turnId: turnTwo }));
  assert.equal(state.contextProjection.freshness, 'fresh');
  assert.equal(state.contextProjection.acceptedObservationTurnId, turnTwo);
  assert.deepEqual(state.contextProjection.observation?.observation, {
    confidence: 'unavailable', reason: 'observation-timeout',
  });
  assert.equal(state.contextProjection.latestCompaction?.sequence, 5);
});

test('a late observation for an older turn cannot replace current context truth', () => {
  const turnOne = 'turn-old';
  const turnTwo = 'turn-current';
  const events: ConversationEventFrame[] = [
    frame(1, { kind: 'activity-state', phase: 'turn-starting' }, { turnId: turnOne }),
    frame(2, { kind: 'turn-end', text: '', stopReason: 'complete' }, { turnId: turnOne }),
    frame(3, {
      kind: 'context-observation', confidence: 'derived',
      usedTokens: 20, usableTokens: 100, contextWindowTokens: 100,
    }, { turnId: turnOne }),
    frame(4, { kind: 'activity-state', phase: 'turn-starting' }, { turnId: turnTwo }),
    frame(5, {
      kind: 'context-observation', confidence: 'exact',
      usedTokens: 99, usableTokens: 100, contextWindowTokens: 100,
    }, { turnId: turnOne }),
  ];
  let state = seed();
  for (const event of events) state = applyConversationEvent(state, event);
  assert.equal(state.contextProjection.acceptedObservationTurnId, turnOne);
  assert.equal(state.contextProjection.freshness, 'stale');
  assert.deepEqual(state.contextProjection.observation?.observation, {
    confidence: 'derived', usedTokens: 20, usableTokens: 100, contextWindowTokens: 100,
  });
  assert.ok(state.integrityConflicts.includes('context:event-5:turn-order'));
  assert.equal(sequenceToArray(state.projectedFrames).some((event) => event.sequence === 5), false);
});

test('a second observation event for one turn is rejected without replacing the first', () => {
  const turnId = 'turn-one-observation';
  const events = [
    frame(1, { kind: 'activity-state', phase: 'turn-starting' }, { turnId }),
    frame(2, { kind: 'turn-end', text: '', stopReason: 'complete' }, { turnId }),
    frame(3, {
      kind: 'context-observation', confidence: 'exact',
      usedTokens: 10, usableTokens: 100, contextWindowTokens: 120,
    }, { turnId }),
    frame(4, {
      kind: 'context-observation', confidence: 'exact',
      usedTokens: 90, usableTokens: 100, contextWindowTokens: 120,
    }, { turnId }),
  ];
  let state = seed();
  for (const event of events) state = applyConversationEvent(state, event);
  assert.deepEqual(state.contextProjection.observation?.observation, {
    confidence: 'exact', usedTokens: 10, usableTokens: 100, contextWindowTokens: 120,
  });
  assert.ok(state.integrityConflicts.includes('context:event-4:duplicate-turn'));
  assert.equal(sequenceToArray(state.projectedFrames).some((event) => event.sequence === 4), false);
});

test('context cannot become current before its attributed turn settles', () => {
  const turnId = 'turn-not-settled';
  let state = applyConversationEvent(seed(), frame(1, {
    kind: 'activity-state', phase: 'turn-starting',
  }, { turnId }));
  state = applyConversationEvent(state, frame(2, {
    kind: 'context-observation', confidence: 'exact',
    usedTokens: 25, usableTokens: 100, contextWindowTokens: 120,
  }, { turnId }));
  assert.equal(state.contextProjection.observation, null);
  assert.equal(state.contextProjectionReady, false);
  assert.ok(state.integrityConflicts.includes('context:event-2:turn-not-settled'));
});

test('context projection converges for ordered, shuffled, duplicate, and replay delivery', () => {
  const turnId = 'turn-context-converges';
  const events = [
    frame(1, { kind: 'activity-state', phase: 'turn-starting' }, { turnId }),
    frame(2, { kind: 'turn-end', text: '', stopReason: 'complete' }, { turnId }),
    frame(3, {
      kind: 'context-observation', confidence: 'approximate',
      usedTokens: 30, usableTokens: 100, contextWindowTokens: 120,
    }, { turnId }),
  ];
  let ordered = seed();
  for (const event of events) ordered = applyConversationEvent(ordered, event);
  let shuffled = seed();
  for (const event of [events[2]!, events[2]!, events[0]!, events[1]!]) {
    shuffled = applyConversationEvent(shuffled, event);
  }
  const replayed = applyReplay(seed(), {
    type: 'session-replay', projectId: 'project-1', sessionId: SID,
    highWaterSequence: 3, events: [events[2]!, events[0]!, events[1]!, events[2]!],
  });
  assert.deepEqual(projectionView(shuffled), projectionView(ordered));
  assert.deepEqual(projectionView(replayed), projectionView(ordered));
});

test('turn usage alone never manufactures a context observation', () => {
  const state = applyConversationEvent(seed(), frame(1, usage(90), { family: 'telemetry' }));
  assert.equal(state.aggregates.inputTokens, 90);
  assert.equal(state.contextProjection.observation, null);
  assert.equal(state.contextProjection.freshness, 'unobserved');
});

test('tool lifecycle projection accepts one guarded path and rejects regressions without replacement', () => {
  const turnId = 'turn-tools';
  let state = applyConversationEvent(seed(), frame(1, tool('requested'), { turnId }));
  const acceptedRequested = indexEntries(state.toolStates)[0]![1];
  state = applyConversationEvent(state, frame(2, tool('requested'), {
    eventId: 'duplicate-state-new-event', turnId,
  }));
  assert.deepEqual(indexEntries(state.toolStates)[0]![1], acceptedRequested);
  assert.ok(state.integrityConflicts.includes('tool:call-1:invalid-transition'));

  state = applyConversationEvent(state, frame(3, tool('running'), { turnId }));
  assert.equal(indexEntries(state.toolStates)[0]![1].state, 'running');
  state = applyConversationEvent(state, frame(4, tool('running', {
    name: 'Write', safeSummary: safeToolSummary('Write'),
  }), { turnId }));
  assert.equal(indexEntries(state.toolStates)[0]![1].name, 'Read');
  assert.ok(state.integrityConflicts.includes('tool:call-1:identity-changed'));

  state = applyConversationEvent(state, frame(5, tool('succeeded'), { turnId }));
  assert.equal(indexEntries(state.toolStates)[0]![1].state, 'succeeded');
  state = applyConversationEvent(state, frame(6, tool('running'), { turnId }));
  assert.equal(indexEntries(state.toolStates)[0]![1].state, 'succeeded');
  assert.ok(state.integrityConflicts.includes('tool:call-1:post-terminal'));
  assert.deepEqual(
    sequenceToArray(state.projectedFrames)
      .filter((event) => event.event.kind === 'tool-state')
      .map((event) => (event.event as ToolStateEvent).state),
    ['requested', 'running', 'succeeded'],
  );
});

test('terminal with an open tool records corruption but never invents browser success/failure', () => {
  const turnId = 'turn-open';
  let state = applyConversationEvent(seed(), frame(1, tool('requested'), { turnId }));
  state = applyConversationEvent(state, frame(2, {
    kind: 'turn-failed', error: 'broken producer', source: 'internal',
  }, { turnId }));
  assert.equal(indexEntries(state.toolStates)[0]![1].state, 'requested');
  assert.equal(state.currentActivity, null);
  assert.ok(state.integrityConflicts.includes(`turn:${turnId}:open-tool:call-1`));

  state = applyConversationEvent(state, frame(3, tool('requested', {
    callId: 'call-after-terminal',
  }), { turnId }));
  state = applyConversationEvent(state, frame(4, {
    kind: 'activity-state', phase: 'responding',
  }, { turnId }));
  assert.equal(indexEntries(state.toolStates).some(([callId]) => callId === 'call-after-terminal'), false);
  assert.ok(state.integrityConflicts.includes('tool:call-after-terminal:post-terminal'));
  assert.ok(state.integrityConflicts.includes('activity:event-4:post-terminal'));
});

test('activity and tool state converge across ordered, shuffled, and replay paths', () => {
  const turnId = 'turn-converge';
  const events = [
    frame(1, { kind: 'activity-state', phase: 'turn-starting' }, { turnId, occurredAt: 100 }),
    frame(2, { kind: 'activity-state', phase: 'requesting-runtime' }, { turnId, occurredAt: 90 }),
    frame(3, tool('requested'), { turnId, occurredAt: 110 }),
    frame(4, tool('running'), { turnId, occurredAt: 105 }),
    frame(5, tool('succeeded'), { turnId, occurredAt: 120 }),
    frame(6, { kind: 'activity-state', phase: 'responding' }, { turnId, occurredAt: 115 }),
  ];
  let ordered = seed();
  for (const event of events) ordered = applyConversationEvent(ordered, event);
  let shuffled = seed();
  for (const event of [events[5]!, events[2]!, events[0]!, events[4]!, events[1]!, events[3]!]) {
    shuffled = applyConversationEvent(shuffled, event);
  }
  const replay = applyReplay(seed(), {
    type: 'session-replay',
    projectId: 'project-1',
    sessionId: SID,
    highWaterSequence: 6,
    events: [events[4]!, events[1]!, events[5]!, events[0]!, events[3]!, events[2]!],
  });
  assert.deepEqual(projectionView(shuffled), projectionView(ordered));
  assert.deepEqual(projectionView(replay), projectionView(ordered));
  assert.equal(ordered.currentActivity?.source.kind, 'activity');
  assert.equal(ordered.currentActivity?.sequence, 6, 'sequence wins even when timestamps reverse');
  assert.equal(ordered.currentActivity?.startedAt, 100);
});

test('approval asks require the matching canonical pending state and remain until lifecycle advances', () => {
  const turnId = 'turn-approval';
  let state = applyConversationEvent(seed(), frame(1, tool('requested', { name: 'Bash', safeSummary: safeToolSummary('Bash') }), { turnId }));
  state = applyConversationEvent(state, frame(2, tool('approval-needed', {
    name: 'Bash', safeSummary: safeToolSummary('Bash'),
  }), { turnId }));
  const ask: AskFrame = {
    type: 'ask', projectId: 'project-1', sessionId: SID,
    askId: 'approval-1', callId: 'call-1', toolName: 'Bash', toolInput: {},
  };
  state = applyAsk(state, { ...ask, sessionId: 'other' });
  state = applyAsk(state, { ...ask, callId: 'other-call' });
  assert.equal(state.asks.length, 0);
  state = applyAsk(state, ask);
  assert.equal(state.asks.length, 1);
  state = answerAsk(state, ask.askId, 'allow');
  assert.equal(state.asks.length, 1, 'answer disables but does not remove projection authority');
  assert.equal(state.answeredAsks[ask.askId], 'allow');

  state = applyConversationEvent(state, frame(3, tool('running', {
    name: 'Bash', safeSummary: safeToolSummary('Bash'),
    approval: { status: 'allowed', source: 'user', requestId: 'approval-1' },
  }), { turnId }));
  assert.equal(state.asks.length, 0);
  assert.equal(state.answeredAsks[ask.askId], undefined);
  assert.equal(applyAsk(state, ask), state, 'stale ask cannot reopen a running call');

  const replay = applyReplay(state, {
    type: 'session-replay', projectId: 'project-1', sessionId: SID,
    highWaterSequence: 2,
    events: [
      frame(1, tool('requested', { name: 'Bash', safeSummary: safeToolSummary('Bash') }), { turnId }),
      frame(2, tool('approval-needed', { name: 'Bash', safeSummary: safeToolSummary('Bash') }), { turnId }),
    ],
  });
  assert.equal(replay.asks.length, 0);
  assert.equal(applyAsk(replay, ask).asks.length, 1, 'server re-emission restores unresolved approval');
});

test('an ask arriving before approval evidence waits and becomes actionable only after canonical state', () => {
  const turnId = 'turn-ask-race';
  const ask: AskFrame = {
    type: 'ask', projectId: 'project-1', sessionId: SID,
    askId: 'approval-1', callId: 'call-1', toolName: 'Bash', toolInput: {},
  };
  let state = applyConversationEvent(seed(), frame(1, {
    kind: 'activity-state', phase: 'turn-starting',
  }, { turnId }));
  state = applyAsk(state, ask);
  assert.equal(state.asks.length, 0);
  assert.equal(state.pendingAsks.length, 1);
  state = applyConversationEvent(state, frame(2, tool('requested', {
    name: 'Bash', safeSummary: safeToolSummary('Bash'),
  }), { turnId }));
  assert.equal(state.asks.length, 0);
  state = applyConversationEvent(state, frame(3, tool('approval-needed', {
    name: 'Bash', safeSummary: safeToolSummary('Bash'),
  }), { turnId }));
  assert.equal(state.pendingAsks.length, 0);
  assert.deepEqual(state.asks, [ask]);
});

test('authoritative active turn buffers an ask before any canonical evidence is relayed', () => {
  const turnId = 'turn-relay-gap';
  const ask: AskFrame = {
    type: 'ask', projectId: 'project-1', sessionId: SID,
    askId: 'approval-relay-gap', callId: 'call-relay-gap', toolName: 'Bash', toolInput: {},
  };
  let state = applyAsk(seed(), ask, turnId);
  assert.equal(state.asks.length, 0);
  assert.deepEqual(state.pendingAsks, [ask]);
  state = applyConversationEvent(state, frame(1, tool('requested', {
    callId: 'call-relay-gap', name: 'Bash', safeSummary: safeToolSummary('Bash'),
  }), { turnId }));
  state = applyConversationEvent(state, frame(2, tool('approval-needed', {
    callId: 'call-relay-gap', name: 'Bash', safeSummary: safeToolSummary('Bash'),
    approval: { status: 'pending', source: null, requestId: 'approval-relay-gap' },
  }), { turnId }));
  assert.equal(state.pendingAsks.length, 0);
  assert.deepEqual(state.asks, [ask]);
});

test('terminal state rejects a delayed approval card even if corrupt evidence left the tool open', () => {
  const turnId = 'turn-stale-ask';
  const ask: AskFrame = {
    type: 'ask', projectId: 'project-1', sessionId: SID,
    askId: 'approval-1', callId: 'call-1', toolName: 'Bash', toolInput: {},
  };
  let state = applyConversationEvent(seed(), frame(1, tool('requested', {
    name: 'Bash', safeSummary: safeToolSummary('Bash'),
  }), { turnId }));
  state = applyConversationEvent(state, frame(2, tool('approval-needed', {
    name: 'Bash', safeSummary: safeToolSummary('Bash'),
  }), { turnId }));
  state = applyConversationEvent(state, frame(3, {
    kind: 'turn-failed', error: 'corrupt producer', source: 'internal',
  }, { turnId }));
  assert.equal(state.currentActivity, null);
  assert.equal(applyAsk(state, ask), state);

  const answeredEmpty = { ...state, answeredAsks: { [ask.askId]: '' } };
  assert.equal(applyAsk(answeredEmpty, ask), answeredEmpty, 'empty answers remain acknowledged');
});

test('idle state clears a late unmatched approval buffered after terminal delivery', () => {
  const ask: AskFrame = {
    type: 'ask', projectId: 'project-1', sessionId: SID,
    askId: 'late-approval', callId: 'late-call', toolName: 'Bash', toolInput: {},
  };
  let state = applyConversationEvent(seed(), frame(1, {
    kind: 'session-state', state: 'running', permissionMode: null,
  }));
  state = applyConversationEvent(state, frame(2, {
    kind: 'turn-failed', error: 'ended', source: 'internal',
  }, { turnId: 'turn-ended' }));
  state = applyAsk(state, ask);
  assert.equal(state.asks.length, 0);
  assert.equal(state.pendingAsks.length, 1);
  state = applyConversationEvent(state, frame(3, {
    kind: 'session-state', state: 'idle', permissionMode: null,
  }));
  assert.equal(state.pendingAsks.length, 0);
});

test('idle state clears an actionable approval card and its local answer state', () => {
  const turnId = 'turn-idle-approval';
  const ask: AskFrame = {
    type: 'ask', projectId: 'project-1', sessionId: SID,
    askId: 'idle-approval', callId: 'call-1', toolName: 'Bash', toolInput: {},
  };
  let state = applyConversationEvent(seed(), frame(1, tool('requested', {
    name: 'Bash', safeSummary: safeToolSummary('Bash'),
  }), { turnId }));
  state = applyConversationEvent(state, frame(2, tool('approval-needed', {
    name: 'Bash', safeSummary: safeToolSummary('Bash'),
    approval: { status: 'pending', source: null, requestId: ask.askId },
  }), { turnId }));
  state = applyAsk(state, ask);
  state = answerAsk(state, ask.askId, '');
  assert.deepEqual(state.asks, [ask]);
  assert.equal(Object.prototype.hasOwnProperty.call(state.answeredAsks, ask.askId), true);
  state = applyConversationEvent(state, frame(3, {
    kind: 'session-state', state: 'idle', permissionMode: null,
  }));
  assert.deepEqual(state.asks, []);
  assert.deepEqual(state.pendingAsks, []);
  assert.deepEqual(state.answeredAsks, {});
});

test('shuffled live delivery produces the same complete state as server order', () => {
  const events = [
    frame(1, { kind: 'session-state', state: 'running', permissionMode: null }),
    frame(2, usage(10), { family: 'telemetry' }),
    frame(3, { kind: 'session-state', state: 'idle', permissionMode: null }),
  ];
  let ordered = seed();
  for (const event of events) ordered = applyConversationEvent(ordered, event);
  let shuffled = seed();
  for (const event of [events[2]!, events[0]!, events[1]!]) {
    shuffled = applyConversationEvent(shuffled, event);
  }
  assert.deepEqual(sequenceToArray(shuffled.frames), sequenceToArray(ordered.frames));
  assert.deepEqual(shuffled.aggregates, ordered.aggregates);
  assert.equal(shuffled.aggregates.sessionState, 'idle');
});

test('exact redelivery is idempotent; conflicting sequence preserves accepted projection', () => {
  const accepted = frame(1, usage(10), { family: 'telemetry' });
  let state = applyConversationEvent(seed(), accepted);
  state = applyConversationEvent(state, accepted);
  assert.equal(state.frames.length, 1);
  assert.equal(state.aggregates.inputTokens, 10);
  state = applyConversationEvent(
    state,
    frame(1, usage(99), { eventId: 'other-event', family: 'telemetry' }),
  );
  assert.equal(sequenceToArray(state.frames)[0]!.eventId, accepted.eventId);
  assert.equal(state.aggregates.inputTokens, 10);
  assert.deepEqual(state.integrityConflicts, ['sequence:1']);
});

test('event-id collision consumes its sequence and cannot stall ordered or shuffled projection', () => {
  const events = [
    frame(1, usage(1), { eventId: 'shared-event', family: 'telemetry' }),
    frame(2, usage(99), { eventId: 'shared-event', family: 'telemetry' }),
    frame(3, { kind: 'session-state', state: 'idle', permissionMode: null }),
  ];
  let ordered = seed();
  for (const event of events) ordered = applyConversationEvent(ordered, event);
  let shuffled = seed();
  for (const event of [events[1]!, events[2]!, events[0]!]) {
    shuffled = applyConversationEvent(shuffled, event);
  }

  assert.equal(ordered.projectedThroughSequence, 3);
  assert.equal(ordered.highWaterSequence, 3);
  assert.deepEqual(sequenceToArray(ordered.frames).map((event) => event.sequence), [1, 3]);
  assert.equal(ordered.aggregates.inputTokens, 1);
  assert.equal(ordered.aggregates.sessionState, 'idle');
  assert.deepEqual(ordered.integrityConflicts, ['event:shared-event']);
  assert.deepEqual(projectionView(shuffled), projectionView(ordered));
  assert.deepEqual(shuffled.projector, ordered.projector);

  const exactRejectedRedelivery = applyConversationEvent(ordered, events[1]!);
  assert.equal(exactRejectedRedelivery, ordered);
});

test('delta indexes hold gaps, release contiguous content, and ignore exact duplicates', () => {
  const delta = (sequence: number, deltaIndex: number, text: string) =>
    frame(
      sequence,
      { kind: 'stream-delta', delta: { kind: 'text-delta', text } },
      { itemId: 'item-stream', streamId: 'stream-1', deltaIndex },
    );
  let state = seed();
  state = applyConversationEvent(state, delta(3, 2, 'c'));
  assert.equal(state.deltas['stream-1'], undefined);
  state = applyConversationEvent(state, delta(1, 0, 'a'));
  assert.equal(state.deltas['stream-1']?.text, 'a');
  state = applyConversationEvent(state, delta(2, 1, 'b'));
  assert.equal(state.deltas['stream-1']?.text, 'abc');
  state = applyConversationEvent(state, delta(2, 1, 'b'));
  assert.equal(state.deltas['stream-1']?.text, 'abc');
});

test('conflicting delta index records integrity failure without changing first payload', () => {
  let state = seed();
  state = applyConversationEvent(state, frame(1, {
    kind: 'stream-delta',
    delta: { kind: 'text-delta', text: 'first' },
  }, { itemId: 'i', streamId: 's', deltaIndex: 0 }));
  state = applyConversationEvent(state, frame(2, {
    kind: 'stream-delta',
    delta: { kind: 'text-delta', text: 'other' },
  }, { itemId: 'i', streamId: 's', deltaIndex: 0 }));
  assert.equal(state.deltas.s?.text, 'first');
  assert.ok(state.integrityConflicts.includes('delta:s:0'));
});

test('a stream stays bound to one item, including after completion', () => {
  let state = seed();
  state = applyConversationEvent(state, frame(1, {
    kind: 'stream-delta', delta: { kind: 'text-delta', text: 'first' },
  }, { itemId: 'item-a', streamId: 'stream-a', deltaIndex: 0 }));
  state = applyConversationEvent(state, frame(2, {
    kind: 'stream-delta', delta: { kind: 'text-delta', text: 'wrong' },
  }, { itemId: 'item-b', streamId: 'stream-a', deltaIndex: 1 }));
  assert.equal(state.deltas['stream-a']?.text, 'first');
  assert.ok(state.integrityConflicts.includes('stream:stream-a:item'));

  state = applyConversationEvent(state, frame(3, {
    kind: 'assistant-text', text: 'complete', midLoop: false,
  }, { itemId: 'item-a', streamId: 'stream-a', family: 'assistant' }));
  state = applyConversationEvent(state, frame(4, {
    kind: 'stream-delta', delta: { kind: 'text-delta', text: 'late wrong item' },
  }, { itemId: 'item-b', streamId: 'stream-a', deltaIndex: 2 }));
  assert.equal(state.deltas['stream-a'], undefined);
  assert.equal(state.integrityConflicts.filter((c) => c === 'stream:stream-a:item').length, 1);
});

test('a mismatched stable item is excluded from the render projection', () => {
  let state = seed();
  state = applyConversationEvent(state, frame(1, {
    kind: 'stream-delta', delta: { kind: 'text-delta', text: 'partial' },
  }, { itemId: 'item-a', streamId: 'stream-a', deltaIndex: 0 }));
  state = applyConversationEvent(state, frame(2, {
    kind: 'assistant-text', text: 'wrong completion', midLoop: false,
  }, { itemId: 'item-b', streamId: 'stream-a', family: 'assistant' }));
  assert.deepEqual(sequenceToArray(state.frames).map((event) => event.sequence), [2]);
  assert.deepEqual(sequenceToArray(state.projectedFrames), []);
  assert.equal(state.deltas['stream-a']?.text, 'partial');
  assert.ok(state.integrityConflicts.includes('stream:stream-a:item'));
});

test('delta conflicts remain deterministic after completion and retraction', () => {
  const events = [
    frame(1, {
      kind: 'stream-delta', delta: { kind: 'text-delta', text: 'first' },
    }, { itemId: 'item-a', streamId: 'stream-a', deltaIndex: 0 }),
    frame(2, {
      kind: 'assistant-text', text: 'complete', midLoop: false,
    }, { itemId: 'item-a', streamId: 'stream-a', family: 'assistant' }),
    frame(3, {
      kind: 'stream-delta', delta: { kind: 'text-delta', text: 'conflict' },
    }, { itemId: 'item-a', streamId: 'stream-a', deltaIndex: 0 }),
    frame(4, { kind: 'retract', streamIds: ['stream-a'] }),
  ];
  let ordered = seed();
  for (const event of events) ordered = applyConversationEvent(ordered, event);
  let shuffled = seed();
  for (const event of [events[3]!, events[2]!, events[0]!, events[1]!]) {
    shuffled = applyConversationEvent(shuffled, event);
  }
  assert.ok(ordered.integrityConflicts.includes('delta:stream-a:0'));
  assert.deepEqual(shuffled.integrityConflicts, ordered.integrityConflicts);
  assert.deepEqual(
    sequenceToArray(shuffled.projectedFrames),
    sequenceToArray(ordered.projectedFrames),
  );
  assert.deepEqual(shuffled.deltas, ordered.deltas);
});

test('stable completion supersedes its stream buffer and late deltas cannot resurrect it', () => {
  let state = seed();
  state = applyConversationEvent(state, frame(1, {
    kind: 'stream-delta',
    delta: { kind: 'text-delta', text: 'partial' },
  }, { itemId: 'i', streamId: 's', deltaIndex: 0 }));
  state = applyConversationEvent(state, frame(2, {
    kind: 'assistant-text', text: 'complete', midLoop: false,
  }, { itemId: 'i', streamId: 's', family: 'assistant' }));
  assert.equal(state.deltas.s, undefined);
  state = applyConversationEvent(state, frame(3, {
    kind: 'stream-delta', delta: { kind: 'text-delta', text: 'late' },
  }, { itemId: 'i', streamId: 's', deltaIndex: 1 }));
  assert.equal(state.deltas.s, undefined);
});

test('replay with shuffled exact duplicates equals uninterrupted live projection', () => {
  const events = [
    frame(1, { kind: 'user', text: 'hi' }, { clientMessageId: 'cm1' }),
    frame(2, usage(50), { family: 'telemetry' }),
    frame(3, { kind: 'turn-duration', durationMs: 1200 }, { family: 'telemetry' }),
  ];
  let live = seed();
  for (const event of events) live = applyConversationEvent(live, event);
  const replay: SessionReplayFrame = {
    type: 'session-replay',
    projectId: 'project-1',
    sessionId: SID,
    highWaterSequence: 3,
    events: [events[2]!, events[0]!, events[1]!, events[1]!],
  };
  const restored = applyReplay(seed(), replay);
  assert.deepEqual(sequenceToArray(restored.frames), sequenceToArray(live.frames));
  assert.deepEqual(restored.aggregates, live.aggregates);
  assert.deepEqual(restored.deltas, live.deltas);
});

test('foreign session events are ignored and canonical user event reconciles optimistic send', () => {
  let state = seed();
  state = {
    ...state,
    optimistic: [{ clientMessageId: 'cm1', text: 'hello', status: 'sending', failureReason: null }],
  };
  state = applyConversationEvent(state, frame(1, { kind: 'user', text: 'hello' }, { clientMessageId: 'cm1' }));
  assert.equal(state.optimistic.length, 0);
  const foreign = frame(2, { kind: 'user', text: 'no' }, {
    eventId: 'foreign', conversationId: 'other', sessionId: 'other',
  });
  assert.equal(applyConversationEvent(state, foreign), state);
});

test('ordered large-stream projection stays incremental and compacts every completed raw payload', () => {
  const marker = 'RAW-PAYLOAD-';
  const streamCount = 64;
  const deltasPerStream = 64;
  const total: ProjectionWork = {
    path: 'ordered',
    acceptedEventVisits: 0,
    historyVisits: 0,
    fallbackRebuilds: 0,
    compactedDeltaPayloads: 0,
  };
  let sequence = 0;
  let state = seed();

  for (let stream = 0; stream < streamCount; stream += 1) {
    const streamId = `scale-stream-${stream}`;
    const itemId = `scale-item-${stream}`;
    for (let index = 0; index < deltasPerStream; index += 1) {
      sequence += 1;
      const beforeProjection = state.projectedFrames;
      const reduced = reduceConversationEvent(state, frame(sequence, {
        kind: 'stream-delta',
        delta: { kind: 'text-delta', text: `${marker}${stream}-${index};` },
      }, { itemId, streamId, deltaIndex: index, family: 'assistant' }));
      assert.equal(reduced.work.path, 'ordered');
      assert.equal(reduced.state.projectedFrames, beforeProjection);
      addWork(total, reduced.work);
      state = reduced.state;
    }
    sequence += 1;
    const reduced = reduceConversationEvent(state, frame(sequence, {
      kind: 'assistant-text', text: `complete stream ${stream}`, midLoop: false,
    }, { itemId, streamId, family: 'assistant' }));
    assert.equal(reduced.work.compactedDeltaPayloads, deltasPerStream);
    addWork(total, reduced.work);
    state = reduced.state;
  }

  assert.equal(sequence, streamCount * (deltasPerStream + 1));
  assert.equal(total.acceptedEventVisits, sequence);
  assert.equal(total.historyVisits, 0);
  assert.equal(total.fallbackRebuilds, 0);
  assert.equal(total.compactedDeltaPayloads, streamCount * deltasPerStream);
  assert.equal(state.frames.length, streamCount);
  assert.equal(state.projectedFrames.length, streamCount);
  assert.equal(Object.keys(state.deltas).length, 0);
  assert.equal(state.projector.pendingFrames, null);
  assert.equal(state.projector.sequenceReceipts?.size, sequence);
  assert.equal(containsText(state, marker), false);
});

test('stable-heavy projection appends through bounded persistent chunks without history copies', () => {
  const eventCount = 4_096;
  const total: ProjectionWork = {
    path: 'ordered',
    acceptedEventVisits: 0,
    historyVisits: 0,
    fallbackRebuilds: 0,
    compactedDeltaPayloads: 0,
  };
  let state = seed();
  let partial: ChatState | null = null;
  for (let sequence = 1; sequence <= eventCount; sequence += 1) {
    const reduced = reduceConversationEvent(
      state,
      frame(sequence, usage(1), { family: 'telemetry' }),
    );
    addWork(total, reduced.work);
    state = reduced.state;
    if (sequence === PERSISTENT_SEQUENCE_CHUNK_SIZE - 1) partial = state;
  }

  assert.equal(total.acceptedEventVisits, eventCount);
  assert.equal(total.historyVisits, 0);
  assert.equal(total.fallbackRebuilds, 0);
  assert.equal(state.aggregates.inputTokens, eventCount);
  assert.equal(state.frames.length, eventCount);
  assert.equal(state.projectedFrames.length, eventCount);
  assert.equal(maxChunkSize(state.frames), PERSISTENT_SEQUENCE_CHUNK_SIZE);
  assert.equal(maxChunkSize(state.projectedFrames), PERSISTENT_SEQUENCE_CHUNK_SIZE);
  assert.equal(chunkCount(state.frames), eventCount / PERSISTENT_SEQUENCE_CHUNK_SIZE);
  assert.equal(chunkCount(state.projectedFrames), eventCount / PERSISTENT_SEQUENCE_CHUNK_SIZE);
  const materialized = sequenceToArray(state.frames);
  assert.equal(materialized[0]!.sequence, 1);
  assert.equal(materialized.at(-1)!.sequence, eventCount);
  assert.deepEqual(
    materialized.map((event) => event.sequence),
    Array.from({ length: eventCount }, (_, index) => index + 1),
  );
  assert.deepEqual(sequenceToArray(state.projectedFrames), materialized);

  assert.ok(partial);
  const branch = applyConversationEvent(
    partial,
    frame(PERSISTENT_SEQUENCE_CHUNK_SIZE, usage(9), { family: 'telemetry' }),
  );
  assert.equal(partial.frames.length, PERSISTENT_SEQUENCE_CHUNK_SIZE - 1);
  assert.equal(sequenceToArray(partial.frames).at(-1)!.sequence, PERSISTENT_SEQUENCE_CHUNK_SIZE - 1);
  assert.equal(branch.frames.length, PERSISTENT_SEQUENCE_CHUNK_SIZE);
  assert.equal(branch.aggregates.inputTokens, PERSISTENT_SEQUENCE_CHUNK_SIZE - 1 + 9);
});

test('post-compaction receipts preserve exact duplicates and fail closed on changed payload or item', () => {
  const raw = frame(1, {
    kind: 'stream-delta', delta: { kind: 'text-delta', text: 'RAW-COMPACT-ME' },
  }, { itemId: 'item-a', streamId: 'stream-a', deltaIndex: 0, family: 'assistant' });
  const complete = frame(2, {
    kind: 'assistant-text', text: 'stable replacement', midLoop: false,
  }, { itemId: 'item-a', streamId: 'stream-a', family: 'assistant' });
  let state = applyConversationEvent(seed(), raw);
  state = applyConversationEvent(state, complete);
  assert.equal(containsText(state, 'RAW-COMPACT-ME'), false);

  const exact = reduceConversationEvent(state, raw);
  assert.equal(exact.work.path, 'duplicate');
  assert.equal(exact.state, state);

  state = applyConversationEvent(state, frame(3, {
    kind: 'stream-delta', delta: { kind: 'text-delta', text: 'changed payload' },
  }, { itemId: 'item-a', streamId: 'stream-a', deltaIndex: 0, family: 'assistant' }));
  assert.ok(state.integrityConflicts.includes('delta:stream-a:0'));
  assert.equal(state.deltas['stream-a'], undefined);

  state = applyConversationEvent(state, frame(4, {
    kind: 'stream-delta', delta: { kind: 'text-delta', text: 'wrong item' },
  }, { itemId: 'item-b', streamId: 'stream-a', deltaIndex: 1, family: 'assistant' }));
  assert.ok(state.integrityConflicts.includes('stream:stream-a:item'));
  assert.equal(state.deltas['stream-a'], undefined);
});

test('completion and terminal compaction are stream-scoped then exhaustive', () => {
  let state = seed();
  state = applyConversationEvent(state, frame(1, {
    kind: 'stream-delta', delta: { kind: 'text-delta', text: 'alpha raw' },
  }, { itemId: 'item-a', streamId: 'stream-a', deltaIndex: 0, family: 'assistant' }));
  state = applyConversationEvent(state, frame(2, {
    kind: 'stream-delta', delta: { kind: 'text-delta', text: 'beta raw' },
  }, { itemId: 'item-b', streamId: 'stream-b', deltaIndex: 0, family: 'assistant' }));
  const completed = reduceConversationEvent(state, frame(3, {
    kind: 'assistant-text', text: 'alpha stable', midLoop: false,
  }, { itemId: 'item-a', streamId: 'stream-a', family: 'assistant' }));
  assert.equal(completed.work.compactedDeltaPayloads, 1);
  assert.equal(completed.state.deltas['stream-a'], undefined);
  assert.equal(completed.state.deltas['stream-b']?.text, 'beta raw');

  const terminal = reduceConversationEvent(completed.state, frame(4, {
    kind: 'turn-end', text: '', stopReason: 'complete',
  }, { itemId: 'turn-terminal', family: 'control', turnId: 'turn-streams' }));
  assert.equal(terminal.work.compactedDeltaPayloads, 1);
  assert.deepEqual(terminal.state.deltas, {});
  const late = applyConversationEvent(terminal.state, frame(5, {
    kind: 'stream-delta', delta: { kind: 'text-delta', text: 'late beta' },
  }, { itemId: 'item-b', streamId: 'stream-b', deltaIndex: 1, family: 'assistant' }));
  assert.equal(late.deltas['stream-b'], undefined);
});

test('completion-first shuffled live delivery and shuffled replay converge with ordered projection', () => {
  const events = [
    frame(1, {
      kind: 'stream-delta', delta: { kind: 'text-delta', text: 'part one ' },
    }, { itemId: 'item-a', streamId: 'stream-a', deltaIndex: 0, family: 'assistant' }),
    frame(2, {
      kind: 'stream-delta', delta: { kind: 'text-delta', text: 'part two' },
    }, { itemId: 'item-a', streamId: 'stream-a', deltaIndex: 1, family: 'assistant' }),
    frame(3, {
      kind: 'assistant-text', text: 'stable answer', midLoop: false,
    }, { itemId: 'item-a', streamId: 'stream-a', family: 'assistant' }),
    frame(4, { kind: 'retract', streamIds: ['stream-a'] }, { family: 'control' }),
    frame(5, { kind: 'session-state', state: 'idle', permissionMode: null }),
  ];
  let ordered = seed();
  for (const event of events) ordered = applyConversationEvent(ordered, event);

  let shuffled = seed();
  for (const event of [events[2]!, events[4]!, events[3]!, events[1]!, events[0]!]) {
    shuffled = applyConversationEvent(shuffled, event);
  }

  const replay = reduceReplay(seed(), {
    type: 'session-replay',
    projectId: 'project-1',
    sessionId: SID,
    highWaterSequence: 5,
    events: [events[3]!, events[1]!, events[4]!, events[0]!, events[2]!],
  });
  assert.equal(replay.work.fallbackRebuilds, 1);
  assert.equal(replay.work.historyVisits, events.length);
  assert.deepEqual(projectionView(shuffled), projectionView(ordered));
  assert.deepEqual(projectionView(replay.state), projectionView(ordered));
  assert.deepEqual(replay.state.projector, ordered.projector);
});

test('replay checkpoint skips hidden gaps once and admits the next live sequence directly', () => {
  const visible = [
    frame(2, { kind: 'user', text: 'visible after hidden row' }),
    frame(5, usage(5), { family: 'telemetry' }),
  ];
  const replay = reduceReplay(seed(), {
    type: 'session-replay',
    projectId: 'project-1',
    sessionId: SID,
    highWaterSequence: 7,
    events: [visible[1]!, visible[0]!],
  });
  assert.equal(replay.state.highWaterSequence, 7);
  assert.equal(replay.state.projectedThroughSequence, 7);
  assert.equal(replay.state.projector.pendingFrames, null);

  const live = reduceConversationEvent(replay.state, frame(8, {
    kind: 'session-state', state: 'idle', permissionMode: null,
  }));
  assert.equal(live.work.path, 'ordered');
  assert.equal(live.state.projectedThroughSequence, 8);
  assert.equal(live.state.projector.pendingFrames, null);
});

test('persistent projector indexes keep prior states immutable and branch deterministically', () => {
  const first = frame(1, {
    kind: 'stream-delta', delta: { kind: 'text-delta', text: 'first' },
  }, { itemId: 'item-a', streamId: 'stream-a', deltaIndex: 0, family: 'assistant' });
  const base = applyConversationEvent(seed(), first);
  const untouched = structuredClone(base);
  const clonedBranch = structuredClone(base);
  const second = frame(2, {
    kind: 'stream-delta', delta: { kind: 'text-delta', text: ' second' },
  }, { itemId: 'item-a', streamId: 'stream-a', deltaIndex: 1, family: 'assistant' });
  const completion = frame(2, {
    kind: 'assistant-text', text: 'stable', midLoop: false,
  }, { itemId: 'item-a', streamId: 'stream-a', family: 'assistant' });

  const streamed = applyConversationEvent(base, second);
  const streamedFromClone = applyConversationEvent(clonedBranch, second);
  const completed = applyConversationEvent(base, completion);
  assert.deepEqual(base, untouched);
  assert.deepEqual(streamed, streamedFromClone);
  assert.equal(streamed.deltas['stream-a']?.text, 'first second');
  assert.equal(completed.deltas['stream-a'], undefined);
  assert.deepEqual(base, untouched);
});

test('durable send-state drives the FIFO tray and reconciles optimistic content', () => {
  let state = addOptimistic(seed(), 'command-1', 'client-1', 'queued text');
  state = applyConversationEvent(state, frame(1, {
    kind: 'send-state',
    queueRevision: 1,
    item: queueItem(),
  }, { family: 'user' }));
  assert.equal(state.queueRevision, 1);
  assert.equal(state.sendQueue[0]?.status, 'queued');
  assert.equal(state.optimistic[0]?.status, 'queued');

  state = applyConversationEvent(state, frame(2, {
    kind: 'send-state',
    queueRevision: 2,
    item: queueItem({ status: 'delivering', deliveryRevision: 1, updatedAt: 2 }),
  }, { family: 'user' }));
  assert.equal(state.sendQueue[0]?.status, 'delivering');
  assert.equal(state.optimistic[0]?.status, 'delivering');

  state = applyConversationEvent(state, frame(3, {
    kind: 'send-state',
    queueRevision: 3,
    item: queueItem({ status: 'accepted', deliveryRevision: 1, updatedAt: 3 }),
  }, { family: 'user' }));
  assert.deepEqual(state.sendQueue, []);
  assert.deepEqual(state.optimistic, []);
  assert.equal(buildRenderItems(sequenceToArray(state.projectedFrames)).length, 0);
});

test('queue snapshots never regress and equal-revision conflicts fail closed', () => {
  const current = queueItem({ revision: 2, text: 'edited', updatedAt: 5 });
  let state = applySendQueueSnapshot(seed(), {
    type: 'send-queue-snapshot',
    projectId: 'project-1',
    sessionId: SID,
    queueRevision: 5,
    items: [current],
  });
  state = applySendQueueSnapshot(state, {
    type: 'send-queue-snapshot',
    projectId: 'project-1',
    sessionId: SID,
    queueRevision: 4,
    items: [queueItem({ text: 'stale' })],
  });
  assert.equal(state.sendQueue[0]?.text, 'edited');
  assert.deepEqual(state.integrityConflicts, []);

  const exact = applySendQueueSnapshot(state, {
    type: 'send-queue-snapshot',
    projectId: 'project-1',
    sessionId: SID,
    queueRevision: 5,
    items: [current],
  });
  assert.equal(exact, state);
  const conflict = applySendQueueSnapshot(state, {
    type: 'send-queue-snapshot',
    projectId: 'project-1',
    sessionId: SID,
    queueRevision: 5,
    items: [queueItem({ text: 'conflicting same revision' })],
  });
  assert.equal(conflict.sendQueue[0]?.text, 'edited');
  assert.deepEqual(conflict.integrityConflicts, ['queue-snapshot:5']);
});

test('unsorted queue snapshot redelivery normalizes before equality comparison', () => {
  const first = queueItem({ id: 'queue-1', clientMessageId: 'client-1', enqueuePosition: 1 });
  const second = queueItem({ id: 'queue-2', clientMessageId: 'client-2', enqueuePosition: 2, text: 'second' });
  const snapshot = {
    type: 'send-queue-snapshot' as const,
    projectId: 'project-1',
    sessionId: SID,
    queueRevision: 2,
    items: [second, first],
  };
  const state = applySendQueueSnapshot(seed(), snapshot);
  assert.deepEqual(state.sendQueue.map((item) => item.id), ['queue-1', 'queue-2']);
  const duplicate = applySendQueueSnapshot(state, snapshot);
  assert.equal(duplicate, state);
  assert.deepEqual(duplicate.integrityConflicts, []);
});

test('overtaken terminal queue events still reconcile persisted client identity', () => {
  let state = addOptimistic(seed(), 'command-1', 'client-1', 'keep this draft');
  state = applySendQueueSnapshot(state, {
    type: 'send-queue-snapshot',
    projectId: 'project-1',
    sessionId: SID,
    queueRevision: 2,
    items: [],
  });
  state = applyConversationEvent(state, frame(1, {
    kind: 'send-state',
    queueRevision: 1,
    item: queueItem({
      status: 'cancelled',
      failureReason: 'session switched',
      updatedAt: 2,
    }),
  }, { family: 'user' }));
  assert.equal(state.queueRevision, 2);
  assert.deepEqual(state.sendQueue, []);
  assert.deepEqual(state.optimistic, []);
  assert.equal(state.cancelledClientMessages['client-1'], 'session switched');
});

test('sender-only command receipts report durable acceptance or typed rejection', () => {
  let state = addOptimistic(seed(), 'command-1', 'client-1', 'hello');
  state = applyConversationCommandReceipt(state, {
    type: 'conversation-command-receipt',
    projectId: 'project-1',
    sessionId: SID,
    commandId: 'command-1',
    command: 'send',
    status: 'applied',
    queueItemId: 'queue-1',
    revision: 1,
    error: null,
  });
  assert.equal(state.optimistic[0]?.status, 'queued');
  assert.equal(state.commandReceipts['command-1']?.status, 'applied');

  state = addOptimistic(state, 'command-2', 'client-2', 'bad');
  state = applyConversationCommandReceipt(state, {
    type: 'conversation-command-receipt',
    projectId: 'project-1',
    sessionId: SID,
    commandId: 'command-2',
    command: 'send',
    status: 'rejected',
    error: { code: 'session-changed', message: 'session changed' },
  });
  assert.equal(state.optimistic.find((send) => send.commandId === 'command-2')?.status, 'failed');
  assert.equal(state.optimistic.find((send) => send.commandId === 'command-2')?.failureReason, 'session changed');

  state = applyConversationCommandReceipt(state, {
    type: 'conversation-command-receipt',
    projectId: 'project-1',
    sessionId: 'old-session',
    commandId: 'stale-command',
    command: 'send',
    status: 'rejected',
    error: { code: 'session-changed', message: 'old session ended' },
  });
  assert.equal(state.commandReceipts['stale-command']?.error?.code, 'session-changed');
});

test('interrupt projection stays requested until a positive terminal receipt', () => {
  let state = applyConversationEvent(seed(), frame(1, {
    kind: 'interrupt-state',
    requestId: 'interrupt-1',
    targetTurnId: 'turn-1',
    replacementQueueItemId: 'queue-2',
    state: 'requested',
    terminalEventId: null,
    result: null,
    failure: null,
  }, { family: 'control', turnId: 'turn-1' }));
  assert.equal(state.interrupts['interrupt-1']?.state, 'requested');

  state = applyConversationEvent(state, frame(2, {
    kind: 'interrupt-state',
    requestId: 'interrupt-1',
    targetTurnId: 'turn-1',
    replacementQueueItemId: 'queue-2',
    state: 'confirmed',
    terminalEventId: 'terminal-1',
    result: 'aborted',
    failure: null,
  }, { family: 'control', turnId: 'turn-1' }));
  assert.equal(state.interrupts['interrupt-1']?.state, 'confirmed');
  assert.equal(state.interrupts['interrupt-1']?.result, 'aborted');
});

test('latest interrupt identity follows canonical request order, not object key enumeration', () => {
  let state = applyConversationEvent(seed(), frame(1, {
    kind: 'interrupt-state',
    requestId: '2',
    targetTurnId: 'turn-1',
    replacementQueueItemId: null,
    state: 'requested',
    terminalEventId: null,
    result: null,
    failure: null,
  }, { family: 'control' }));
  state = applyConversationEvent(state, frame(2, {
    kind: 'interrupt-state',
    requestId: '1',
    targetTurnId: 'turn-2',
    replacementQueueItemId: null,
    state: 'requested',
    terminalEventId: null,
    result: null,
    failure: null,
  }, { family: 'control' }));
  assert.equal(Object.keys(state.interrupts)[0], '1', 'integer-like object keys reorder');
  assert.equal(state.latestInterruptRequestId, '1', 'canonical fold order remains authoritative');
});

test('replay rebuilds durable queue projection instead of preserving stale snapshot state', () => {
  const stale = applySendQueueSnapshot(seed(), {
    type: 'send-queue-snapshot',
    projectId: 'project-1',
    sessionId: SID,
    queueRevision: 9,
    items: [queueItem({ text: 'stale local snapshot' })],
  });
  const replayed = applyReplay(stale, {
    type: 'session-replay',
    projectId: 'project-1',
    sessionId: SID,
    highWaterSequence: 1,
    events: [frame(1, {
      kind: 'send-state',
      queueRevision: 1,
      item: queueItem({ id: 'queue-new', clientMessageId: 'client-new', text: 'replayed' }),
    }, { family: 'user' })],
  });
  assert.equal(replayed.queueRevision, 1);
  assert.equal(replayed.sendQueue[0]?.text, 'replayed');
});
