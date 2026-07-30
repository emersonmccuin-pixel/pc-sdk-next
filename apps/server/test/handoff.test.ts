import { test } from 'node:test';
import assert from 'node:assert/strict';

import { commitConversationEvent, newId } from '@pc/db';
import { conversationFamilyForEvent, type ChatEvent } from '@pc/contracts';
import type { ULID } from '@pc/domain';
import {
  compileHandoffSeedContext,
  HANDOFF_RECENT_VERBATIM_TURNS,
  HANDOFF_SEED_MAX_CHARS,
  HANDOFF_SUMMARY_TURN_MAX_CHARS,
  hasReplayableTranscript,
} from '../src/chat/handoff.ts';
import { freshDb, newProject } from './helpers.ts';

function seedTurn(
  projectId: ULID,
  sessionId: string,
  index: number,
  userText: string,
  assistantText: string,
): void {
  const userEvent: ChatEvent = { kind: 'user', text: userText };
  commitConversationEvent({
    projectId,
    conversationId: sessionId,
    sessionId,
    family: conversationFamilyForEvent(userEvent),
    event: userEvent,
    turnId: null,
    itemId: newId(),
    clientMessageId: null,
    occurredAt: index * 2,
    deliveryKind: 'chat',
  });
  const turnEndEvent: ChatEvent = { kind: 'turn-end', text: assistantText, stopReason: 'complete' };
  commitConversationEvent({
    projectId,
    conversationId: sessionId,
    sessionId,
    family: conversationFamilyForEvent(turnEndEvent),
    event: turnEndEvent,
    turnId: `fixture-turn-${index}`,
    itemId: newId(),
    clientMessageId: null,
    occurredAt: index * 2 + 1,
    deliveryKind: 'chat',
  });
}

test('hasReplayableTranscript and compileHandoffSeedContext return the empty case for a session with no turns', () => {
  freshDb();
  const project = newProject('handoff-empty');
  const sessionId = newId();
  assert.equal(hasReplayableTranscript(sessionId), false);
  assert.equal(
    compileHandoffSeedContext({
      sourceSessionId: sessionId,
      fromAccountId: 'personal',
      toAccountId: 'work',
    }),
    null,
  );
  void project;
});

test('compileHandoffSeedContext renders every turn verbatim and notes the account delta when under the recent-turn window', () => {
  freshDb();
  const project = newProject('handoff-small');
  const sessionId = newId();
  seedTurn(project.id, sessionId, 0, 'remember the launch date is March 3rd', 'noted, March 3rd it is');
  seedTurn(project.id, sessionId, 1, 'also the client is Acme Corp', 'got it, Acme Corp');

  assert.equal(hasReplayableTranscript(sessionId), true);
  const result = compileHandoffSeedContext({
    sourceSessionId: sessionId,
    fromAccountId: 'personal',
    toAccountId: 'work',
  });
  assert.ok(result);
  assert.equal(result!.truncated, false);
  assert.equal(result!.turnCount, 4); // 2 user + 2 assistant turns
  assert.match(result!.seedContext, /personal→work/);
  assert.match(result!.seedContext, /remember the launch date is March 3rd/);
  assert.match(result!.seedContext, /noted, March 3rd it is/);
  assert.match(result!.seedContext, /also the client is Acme Corp/);
  assert.match(result!.seedContext, /got it, Acme Corp/);
  // Nothing to summarize when every turn fits the verbatim window.
  assert.doesNotMatch(result!.seedContext, /summarized/);
  assert.ok(result!.seedContext.length <= HANDOFF_SEED_MAX_CHARS);
});

test('compileHandoffSeedContext summarizes turns older than the recent-verbatim window and truncates long ones', () => {
  freshDb();
  const project = newProject('handoff-summarized');
  const sessionId = newId();
  const oldTurnCount = 3;
  const longText = 'x'.repeat(HANDOFF_SUMMARY_TURN_MAX_CHARS + 50);
  for (let i = 0; i < oldTurnCount; i += 1) {
    seedTurn(project.id, sessionId, i, `old user turn ${i} ${longText}`, `old assistant turn ${i}`);
  }
  // Fill exactly the recent-verbatim window with short, distinguishable turns.
  const recentPairs = HANDOFF_RECENT_VERBATIM_TURNS / 2;
  for (let i = 0; i < recentPairs; i += 1) {
    seedTurn(project.id, sessionId, oldTurnCount + i, `recent user turn ${i}`, `recent assistant turn ${i}`);
  }

  const result = compileHandoffSeedContext({
    sourceSessionId: sessionId,
    fromAccountId: 'personal',
    toAccountId: 'work',
  });
  assert.ok(result);
  assert.equal(result!.truncated, true);
  assert.match(result!.seedContext, /summarized/);
  // The long older turn is shortened with an ellipsis, not rendered verbatim.
  assert.doesNotMatch(result!.seedContext, new RegExp(longText));
  assert.match(result!.seedContext, /…/);
  // Every recent turn still renders verbatim in full.
  for (let i = 0; i < recentPairs; i += 1) {
    assert.match(result!.seedContext, new RegExp(`recent user turn ${i}`));
    assert.match(result!.seedContext, new RegExp(`recent assistant turn ${i}`));
  }
  // Truncation is surfaced inside the seed text itself.
  assert.match(result!.seedContext, /truncated/);
});

test('compileHandoffSeedContext enforces a hard size cap even across verbatim recent turns', () => {
  freshDb();
  const project = newProject('handoff-size-cap');
  const sessionId = newId();
  const hugeText = 'y'.repeat(HANDOFF_SEED_MAX_CHARS);
  const recentPairs = HANDOFF_RECENT_VERBATIM_TURNS / 2;
  for (let i = 0; i < recentPairs; i += 1) {
    seedTurn(project.id, sessionId, i, hugeText, hugeText);
  }

  const result = compileHandoffSeedContext({
    sourceSessionId: sessionId,
    fromAccountId: 'personal',
    toAccountId: 'work',
  });
  assert.ok(result);
  assert.equal(result!.truncated, true);
  assert.ok(result!.seedContext.length <= HANDOFF_SEED_MAX_CHARS);
  assert.match(result!.seedContext, /truncated/);
});
