import { test } from 'node:test';
import assert from 'node:assert/strict';

import type { SessionSummary } from '@pc/contracts';
import { canResumeSession } from '../src/state/sessions.ts';

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
