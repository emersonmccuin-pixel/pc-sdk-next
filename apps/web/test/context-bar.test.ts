import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import {
  conversationFamilyForEvent,
  type ChatEvent,
  type ConversationEventFrame,
} from '@pc/contracts';

import {
  ContextBar,
  deriveContextBarPresentation,
} from '../src/features/chat/ContextBar.tsx';
import {
  emptyContextProjection,
  type SessionContextProjection,
} from '../src/features/chat/chat-reducer.ts';
import { PastSessionTimeline } from '../src/features/chat/ChatTimeline.tsx';
import { CompactionDivider } from '../src/features/chat/Bubbles.tsx';

function observed(
  confidence: 'exact' | 'derived' | 'approximate' = 'exact',
): SessionContextProjection {
  return {
    integrity: 'valid',
    latestStartedTurnId: 'turn-1',
    acceptedObservationTurnId: 'turn-1',
    freshness: 'fresh',
    latestCompaction: null,
    observation: {
      turnId: 'turn-1',
      sequence: 3,
      occurredAt: 30,
      observation: {
        confidence,
        usedTokens: 42,
        usableTokens: 100,
        contextWindowTokens: 120,
      },
    },
  };
}

function html(projection: SessionContextProjection, ready = true, sessionId: string | null = 'session-1') {
  return renderToStaticMarkup(createElement(ContextBar, {
    sessionId,
    ready,
    projection,
  }));
}

test('fresh available context is the only state with a percentage and progressbar', () => {
  const exact = html(observed('exact'));
  assert.match(exact, /data-context-state="available"/);
  assert.match(exact, /role="progressbar"/);
  assert.match(exact, /aria-valuenow="42"/);
  assert.match(exact, /width:42%/);
  assert.match(exact, /42% used · 42 \/ 100 · exact/);
  assert.match(exact, /min-w-0/);
  assert.match(exact, /truncate/);

  assert.match(html(observed('derived')), /42% used · 42 \/ 100 · derived/);
  assert.match(html(observed('approximate')), /≈42% used · 42 \/ 100 · approximate/);
});

test('loading, no-session, not-observed, stale, compacted, and unavailable never show a percentage', () => {
  const cases: Array<[string, string]> = [
    [html(emptyContextProjection(), false), 'loading'],
    [html(emptyContextProjection(), true, null), 'no-session'],
    [html(emptyContextProjection()), 'not-observed'],
    [html({ ...observed(), freshness: 'stale', latestStartedTurnId: 'turn-2' }), 'stale'],
    [html({
      ...observed(),
      freshness: 'stale',
      latestCompaction: {
        turnId: 'turn-1', sequence: 4, occurredAt: 40,
        trigger: 'auto', preTokens: 90, postTokens: 20,
      },
    }), 'compacted'],
    [html({
      ...observed(),
      observation: {
        turnId: 'turn-1', sequence: 3, occurredAt: 30,
        observation: { confidence: 'unavailable', reason: 'observation-timeout' },
      },
    }), 'unavailable'],
  ];
  for (const [markup, state] of cases) {
    assert.match(markup, new RegExp(`data-context-state="${state}"`));
    assert.doesNotMatch(markup, /role="progressbar"/);
    assert.doesNotMatch(markup, /aria-valuenow=/);
    assert.doesNotMatch(markup, /% used/);
    assert.doesNotMatch(markup, /width:[0-9]+%/);
  }
});

test('latest compaction stays visible after a fresh post-compaction observation', () => {
  const projection = observed();
  projection.latestCompaction = {
    turnId: 'turn-1', sequence: 2, occurredAt: 20,
    trigger: 'manual', preTokens: 80, postTokens: 15,
  };
  const markup = html(projection);
  assert.match(markup, /data-context-state="available"/);
  assert.match(markup, /data-testid="context-bar-compaction"/);
  assert.match(markup, /compacted manual · 80 → 15/);
});

test('nullable compaction attribution and counts remain explicit without a percentage', () => {
  const projection = observed();
  projection.freshness = 'stale';
  projection.latestCompaction = {
    turnId: null, sequence: 4, occurredAt: 40,
    trigger: 'unknown', preTokens: 80, postTokens: null,
  };
  let markup = html(projection);
  assert.match(markup, /data-context-state="compacted"/);
  assert.match(markup, /compacted · 80 → …/);
  assert.doesNotMatch(markup, /role="progressbar"/);

  projection.latestCompaction = {
    ...projection.latestCompaction,
    preTokens: null,
    postTokens: 20,
  };
  markup = html(projection);
  assert.match(markup, /compacted · … → 20/);

  projection.latestCompaction = {
    ...projection.latestCompaction,
    postTokens: null,
  };
  markup = html(projection);
  assert.match(markup, /token counts unavailable/);

  const dividerBefore = renderToStaticMarkup(createElement(CompactionDivider, {
    trigger: 'unknown', preTokens: 80, postTokens: null,
  }));
  const dividerAfter = renderToStaticMarkup(createElement(CompactionDivider, {
    trigger: 'unknown', preTokens: null, postTokens: 20,
  }));
  assert.match(dividerBefore, /80 → … tokens/);
  assert.match(dividerAfter, /… → 20 tokens/);
});

test('projection integrity conflict never renders an accepted percentage', () => {
  const projection = {
    ...observed(),
    integrity: 'conflicted' as const,
    latestCompaction: {
      turnId: 'turn-1', sequence: 4, occurredAt: 40,
      trigger: 'manual' as const, preTokens: 80, postTokens: 20,
    },
  };
  const markup = html(projection);
  assert.match(markup, /data-context-state="unavailable"/);
  assert.match(markup, /context replay conflict/);
  assert.doesNotMatch(markup, /role="progressbar"|% used|compacted/);
});

test('presentation does not derive context from absence or stale evidence', () => {
  assert.deepEqual(deriveContextBarPresentation({
    sessionId: 'session-1',
    ready: true,
    projection: emptyContextProjection(),
  }), {
    state: 'not-observed',
    label: 'Not yet observed',
    title: 'No runtime context observation has been recorded for this session.',
    percent: null,
    compactionLabel: null,
  });
  assert.deepEqual(deriveContextBarPresentation({
    sessionId: 'session-1',
    ready: true,
    projection: { ...observed(), freshness: 'stale' },
  }), {
    state: 'stale',
    label: 'Prior observation stale · awaiting current observation',
    title: 'Newer context-changing evidence arrived after the last accepted observation.',
    percent: null,
    compactionLabel: null,
  });
});

test('past-session history uses the same replay projector and renders the footer bar', () => {
  const events: ChatEvent[] = [
    { kind: 'activity-state', phase: 'turn-starting' },
    { kind: 'turn-end', text: '', stopReason: 'complete' },
    {
      kind: 'context-observation', confidence: 'exact',
      usedTokens: 60, usableTokens: 100, contextWindowTokens: 120,
    },
  ];
  const frames: ConversationEventFrame[] = events.map((event, index) => ({
    type: 'conversation-event',
    eventId: `history-${index + 1}`,
    projectId: 'project-1',
    conversationId: 'session-history',
    sessionId: 'session-history',
    sequence: index + 1,
    family: conversationFamilyForEvent(event),
    turnId: 'turn-history',
    itemId: `item-${index + 1}`,
    occurredAt: index + 1,
    event,
  }));
  const markup = renderToStaticMarkup(createElement(PastSessionTimeline, {
    replay: {
      type: 'session-replay', projectId: 'project-1', sessionId: 'session-history',
      highWaterSequence: 3, events: frames, priorTranscript: [],
    },
  }));
  assert.match(markup, /data-context-state="available"/);
  assert.match(markup, /aria-valuenow="60"/);
  assert.match(markup, /Read-only session history/);
});

test('a native-continuation chain renders dimmed prior blocks with a selection-delta divider', () => {
  const priorEvent: ConversationEventFrame = {
    type: 'conversation-event',
    eventId: 'prior-1',
    projectId: 'project-1',
    conversationId: 'session-prior',
    sessionId: 'session-prior',
    sequence: 1,
    family: 'assistant',
    itemId: 'prior-item-1',
    occurredAt: 1,
    event: { kind: 'assistant-text', text: 'from the sonnet session', midLoop: false },
  };
  const liveEvent: ConversationEventFrame = {
    type: 'conversation-event',
    eventId: 'live-1',
    projectId: 'project-1',
    conversationId: 'session-live',
    sessionId: 'session-live',
    sequence: 1,
    family: 'assistant',
    itemId: 'live-item-1',
    occurredAt: 1,
    event: { kind: 'assistant-text', text: 'from the opus session', midLoop: false },
  };
  const markup = renderToStaticMarkup(createElement(PastSessionTimeline, {
    replay: {
      type: 'session-replay',
      projectId: 'project-1',
      sessionId: 'session-live',
      highWaterSequence: 1,
      events: [liveEvent],
      priorTranscript: [{
        sessionId: 'session-prior',
        selection: {
          runtimeId: 'claude-agent-sdk', accountId: 'personal', model: 'sonnet',
          effort: { kind: 'none' },
        },
        events: [priorEvent],
      }],
    },
  }));
  // Both the dimmed prior block and the live block render (no continuation
  // ⇒ no divider/prior-block coverage would silently drop history).
  assert.match(markup, /from the sonnet session/);
  assert.match(markup, /from the opus session/);
  // Trailing divider into the live transcript — this test doesn't wire a
  // liveSelection prop, so it degrades to "unknown selection" honestly
  // instead of inventing the live model.
  assert.match(markup, /sonnet → unknown selection/);
});
