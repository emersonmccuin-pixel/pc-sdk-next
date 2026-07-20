// Runtime switcher store (`state/runtimes.ts`) — mirrors the account-switcher
// coverage in ws-client.test.ts one level up: stamped runtime selection
// synchronizes from guarded `session-changed`/`session-updated` frames, a
// local display choice can never rewrite an active stamp, and a mismatched
// project/session frame mutates nothing.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { ProjectSocket } from '../src/lib/ws-client.ts';
import { useRuntimes } from '../src/state/runtimes.ts';
import { useChatStore } from '../src/state/chat-store.ts';
import { useSessionNav } from '../src/state/sessions.ts';

const PROJECT_ID = 'project-1';

function route(socket: ProjectSocket, frame: unknown): void {
  (socket as unknown as { route: (candidate: unknown) => void }).route(frame);
}

function sessionChanged(
  sessionId: string,
  runtimeId: string,
  transition: 'new-session' | 'resume-session',
  continuationState: 'clean-started' | 'native-resumed',
  projectId = PROJECT_ID,
) {
  return {
    type: 'session-changed',
    projectId,
    transition,
    session: {
      id: sessionId,
      projectId,
      selection: {
        runtimeId,
        accountId: 'personal',
        model: 'claude-opus',
        effort: { kind: 'none' },
      },
      title: null,
      status: 'active',
      nativeSessionIdPresent: true,
      continuationState,
      resumeAvailability: { status: 'unavailable', code: 'session-active' },
      startedAt: 1,
    },
  };
}

function sessionUpdated(
  sessionId: string,
  runtimeId: string,
  continuationState: 'clean-started' | 'native-resumed' | 'resume-failed',
) {
  const changed = sessionChanged(
    sessionId,
    runtimeId,
    'resume-session',
    continuationState === 'resume-failed' ? 'native-resumed' : continuationState,
  );
  return {
    type: 'session-updated',
    projectId: PROJECT_ID,
    session: {
      ...changed.session,
      continuationState,
    },
  };
}

test('valid session changes stamp the runtime switcher claude -> codex -> resume claude', () => {
  useChatStore.getState().reset();
  useSessionNav.getState().setActive(PROJECT_ID, null);
  useRuntimes.getState().bindProject(null);
  useRuntimes.getState().bindProject(PROJECT_ID);
  const socket = new ProjectSocket(PROJECT_ID);

  route(socket, sessionChanged('session-a-1', 'claude-agent-sdk', 'new-session', 'clean-started'));
  assert.equal(useRuntimes.getState().selectedId, 'claude-agent-sdk');
  assert.equal(useRuntimes.getState().activeSession?.continuationState, 'clean-started');

  route(socket, sessionChanged('session-b', 'openai-codex', 'new-session', 'clean-started'));
  assert.equal(useRuntimes.getState().selectedId, 'openai-codex');

  route(socket, sessionChanged('session-a-1', 'claude-agent-sdk', 'resume-session', 'native-resumed'));
  assert.equal(useRuntimes.getState().selectedId, 'claude-agent-sdk');
  assert.equal(useRuntimes.getState().activeSession?.continuationState, 'native-resumed');
});

test('malformed or foreign session changes mutate none of the runtime switcher state', () => {
  useChatStore.getState().reset();
  useSessionNav.getState().setActive(PROJECT_ID, null);
  useRuntimes.getState().bindProject(null);
  useRuntimes.getState().bindProject(PROJECT_ID);
  const socket = new ProjectSocket(PROJECT_ID);
  route(socket, sessionChanged('session-a-1', 'claude-agent-sdk', 'new-session', 'clean-started'));

  const before = useRuntimes.getState().selectedId;
  const sessionBefore = useRuntimes.getState().activeSession;

  // Foreign project — ignored.
  route(socket, sessionChanged('session-x', 'openai-codex', 'new-session', 'clean-started', 'other-project'));
  // Malformed selection — ignored.
  route(socket, { type: 'session-changed', projectId: PROJECT_ID, transition: 'new-session', session: { id: 'bad' } });

  assert.equal(useRuntimes.getState().selectedId, before);
  assert.strictEqual(useRuntimes.getState().activeSession, sessionBefore);
});

test('session metadata updates provenance without disturbing an unrelated session stamp', () => {
  useChatStore.getState().reset();
  useSessionNav.getState().setActive(PROJECT_ID, null);
  useRuntimes.getState().bindProject(null);
  useRuntimes.getState().bindProject(PROJECT_ID);
  const socket = new ProjectSocket(PROJECT_ID);
  route(socket, sessionChanged('session-a-1', 'claude-agent-sdk', 'new-session', 'clean-started'));

  route(socket, sessionUpdated('session-a-1', 'claude-agent-sdk', 'native-resumed'));
  assert.equal(useRuntimes.getState().activeSession?.continuationState, 'native-resumed');

  const before = useRuntimes.getState().activeSession;
  // An update naming a DIFFERENT session id than the currently bound stamp
  // must not overwrite the active projection.
  route(socket, sessionUpdated('session-other', 'openai-codex', 'native-resumed'));
  assert.strictEqual(useRuntimes.getState().activeSession, before);
});
