import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  isConversationKind,
  isConversationSessionDto,
  type ConversationSessionDto,
} from '../src/index.ts';

function makeSession(over: Partial<ConversationSessionDto> = {}): ConversationSessionDto {
  return {
    id: 's1',
    projectId: 'p1',
    selection: {
      runtimeId: 'claude-agent-sdk', accountId: 'personal', model: 'opus',
      effort: { kind: 'none' },
    },
    title: 'Chat',
    status: 'active',
    endedReason: null,
    startedAt: 100,
    endedAt: null,
    nativeSessionIdPresent: true,
    continuationState: 'clean-started',
    resumeAvailability: { status: 'unavailable', code: 'session-active' },
    ...over,
  };
}

test('isConversationKind accepts the three read-surface kinds, rejects others', () => {
  assert.equal(isConversationKind('orchestrator-session'), true);
  assert.equal(isConversationKind('agent-run'), true);
  assert.equal(isConversationKind('subagent-transcript'), true);
  assert.equal(isConversationKind('workflow'), false);
  assert.equal(isConversationKind(7), false);
});

test('isConversationSessionDto round-trips provider-neutral stamped and legacy rows', () => {
  assert.equal(isConversationSessionDto(makeSession()), true);
  assert.equal(isConversationSessionDto(makeSession({
    status: 'ended', endedReason: 'pty_exit', endedAt: 200,
    resumeAvailability: { status: 'available' },
  })), true);
  assert.equal(isConversationSessionDto(makeSession({
    status: 'ended', endedReason: 'account_switched', endedAt: 200,
    resumeAvailability: { status: 'available' },
  })), true);
  assert.equal(isConversationSessionDto(makeSession({
    selection: null, title: null, status: 'ended', endedReason: 'selection_unavailable',
    nativeSessionIdPresent: true, continuationState: 'legacy-unavailable',
    resumeAvailability: { status: 'unavailable', code: 'selection-unavailable' },
    endedAt: 200,
  })), true);
});

test('isConversationSessionDto rejects bad lifecycle, missing selection, and extra data', () => {
  assert.equal(isConversationSessionDto(makeSession({ status: 'paused' as never })), false);
  assert.equal(isConversationSessionDto(makeSession({ endedReason: 'nope' as never })), false);
  assert.equal(isConversationSessionDto({ ...makeSession(), selection: undefined }), false);
  assert.equal(isConversationSessionDto({ ...makeSession(), providerSessionId: 'native-secret' }), false);
  assert.equal(isConversationSessionDto(null), false);
});

test('the DTO is exact: deletedAt is not part of the browser contract', () => {
  const withExtra = { ...makeSession(), deletedAt: 123 } as unknown;
  assert.equal(isConversationSessionDto(withExtra), false);
});
