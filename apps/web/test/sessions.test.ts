import { test } from 'node:test';
import assert from 'node:assert/strict';

import type { SessionSummary } from '@pc/contracts';
import { canResumeSession, parseSessionEventsResponse } from '../src/state/sessions.ts';

function session(over: Partial<SessionSummary>): SessionSummary {
  return {
    id: 'session-1',
    projectId: 'project-1',
    model: null,
    title: null,
    status: 'ended',
    resumable: true,
    startedAt: 1,
    ...over,
  };
}

test('account-invalidated history stays viewable but has no resume action', () => {
  assert.equal(canResumeSession(session({ status: 'ended', resumable: true })), true);
  assert.equal(canResumeSession(session({ status: 'ended', resumable: false })), false);
  assert.equal(canResumeSession(session({ status: 'active', resumable: false })), false);
});

test('past-session HTTP checkpoints are strictly validated and preserve server high-water', () => {
  const event = {
    type: 'conversation-event',
    eventId: 'event-1',
    projectId: 'project-1',
    conversationId: 'session-1',
    sessionId: 'session-1',
    sequence: 1,
    family: 'assistant',
    itemId: 'item-1',
    occurredAt: 1,
    event: { kind: 'assistant-text', text: 'safe', midLoop: false },
  };
  const replay = parseSessionEventsResponse({
    ok: true,
    events: [event],
    highWaterSequence: 7,
  }, 'project-1', 'session-1');
  assert.equal(replay.highWaterSequence, 7);
  assert.deepEqual(replay.events, [event]);

  assert.throws(() => parseSessionEventsResponse({
    ok: true, events: [event], highWaterSequence: 7, raw: 'SECRET',
  }, 'project-1', 'session-1'), /invalid session events response/);
  assert.throws(() => parseSessionEventsResponse({
    ok: true,
    events: [{ ...event, event: { ...event.event, rawThinking: 'SECRET' } }],
    highWaterSequence: 7,
  }, 'project-1', 'session-1'), /invalid session events response/);
  assert.throws(() => parseSessionEventsResponse({
    ok: true, events: [{ ...event, sessionId: 'foreign' }], highWaterSequence: 7,
  }, 'project-1', 'session-1'), /invalid session events response/);
  assert.throws(() => parseSessionEventsResponse({
    ok: true, events: [event], highWaterSequence: 0,
  }, 'project-1', 'session-1'), /invalid session events response/);
});
