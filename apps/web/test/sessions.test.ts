import { test } from 'node:test';
import assert from 'node:assert/strict';

import type { SessionSummary } from '@pc/contracts';
import {
  canResumeSession,
  parseSessionEventsResponse,
  sessionContinuationLabel,
  sessionResumeLabel,
  sessionSelectionLabel,
} from '../src/state/sessions.ts';

function session(over: Partial<SessionSummary>): SessionSummary {
  return {
    id: 'session-1',
    projectId: 'project-1',
    selection: {
      runtimeId: 'claude-agent-sdk',
      accountId: 'account-a',
      model: 'claude-opus',
      effort: { kind: 'selected', value: 'high' },
    },
    title: null,
    status: 'ended',
    nativeSessionIdPresent: true,
    continuationState: 'clean-started',
    resumeAvailability: { status: 'available' },
    startedAt: 1,
    ...over,
  };
}

test('typed resume availability keeps legacy and unsupported history view-only', () => {
  assert.equal(canResumeSession(session({})), true);

  const legacy = session({
    selection: null,
    nativeSessionIdPresent: false,
    continuationState: 'legacy-unavailable',
    resumeAvailability: { status: 'unavailable', code: 'selection-unavailable' },
  });
  assert.equal(canResumeSession(legacy), false);
  assert.equal(sessionSelectionLabel(legacy), 'selection unavailable');
  assert.equal(sessionContinuationLabel(legacy), 'legacy session');
  assert.equal(sessionResumeLabel(legacy), 'legacy selection unavailable · view only');

  const unsupported = session({
    resumeAvailability: { status: 'unavailable', code: 'native-resume-unsupported' },
  });
  assert.equal(canResumeSession(unsupported), false);
  assert.equal(sessionResumeLabel(unsupported), 'native resume unsupported · view only');

  const repositoryUnavailable = session({
    resumeAvailability: { status: 'unavailable', code: 'repository-identity-unavailable' },
  });
  assert.equal(canResumeSession(repositoryUnavailable), false);
  assert.equal(
    sessionResumeLabel(repositoryUnavailable),
    'repository identity unavailable · view only',
  );

  assert.equal(canResumeSession(session({
    status: 'active',
    resumeAvailability: { status: 'unavailable', code: 'session-active' },
  })), false);
});

test('selection and continuation labels state exact provenance without native identity', () => {
  assert.equal(
    sessionSelectionLabel(session({})),
    'claude-agent-sdk · account-a · claude-opus · effort high',
  );
  assert.equal(
    sessionSelectionLabel(session({
      selection: {
        runtimeId: 'claude-agent-sdk',
        accountId: 'account-a',
        model: 'claude-sonnet',
        effort: { kind: 'none' },
      },
    })),
    'claude-agent-sdk · account-a · claude-sonnet · effort none',
  );
  assert.equal(
    sessionSelectionLabel(session({
      selection: {
        runtimeId: 'claude-agent-sdk',
        accountId: 'account-a',
        model: 'claude-haiku',
        effort: { kind: 'unavailable' },
      },
    })),
    'claude-agent-sdk · account-a · claude-haiku · effort unavailable',
  );

  assert.equal(sessionContinuationLabel(session({ continuationState: 'clean-pending' })), 'clean start pending');
  assert.equal(sessionContinuationLabel(session({ continuationState: 'clean-started' })), 'clean start');
  assert.equal(sessionContinuationLabel(session({ continuationState: 'resume-pending' })), 'native resume pending');
  assert.equal(sessionContinuationLabel(session({ continuationState: 'native-resumed' })), 'native resumed');
  assert.equal(sessionContinuationLabel(session({ continuationState: 'resume-failed' })), 'native resume failed');
  assert.equal(sessionContinuationLabel(session({ continuationState: 'legacy-unavailable' })), 'legacy session');
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
