import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

import { canRemoveQueueItem, canSubmitDraft } from '../src/features/chat/ChatComposer.tsx';
import { isTurnBusy } from '../src/features/chat/ChatSurface.tsx';
import { AskCard, normalizeAskPresentation } from '../src/features/chat/AskCard.tsx';
import {
  deriveActivityDisplay,
  formatActivityElapsed,
} from '../src/features/chat/activity-display.ts';
import type { CurrentActivityProjection } from '../src/features/chat/chat-reducer.ts';

test('composer submit guard rejects blank and rapid duplicate submissions', () => {
  assert.equal(canSubmitDraft('', false), false);
  assert.equal(canSubmitDraft('   ', false), false);
  assert.equal(canSubmitDraft('queue this', false), true);
  assert.equal(canSubmitDraft('queue this', true), false);
});

test('failed linked user replacements remain explicitly removable', () => {
  assert.equal(canRemoveQueueItem({
    origin: 'user', status: 'failed', interruptRequestId: 'interrupt-1',
  }), true);
  assert.equal(canRemoveQueueItem({
    origin: 'user', status: 'queued', interruptRequestId: 'interrupt-1',
  }), false);
  assert.equal(canRemoveQueueItem({
    origin: 'agent-envelope', status: 'failed', interruptRequestId: null,
  }), false);
});

test('busy state follows authoritative active-turn identity through approval waits', () => {
  assert.equal(isTurnBusy('turn-requires-action'), true);
  assert.equal(isTurnBusy(null), false);
});

test('an empty-string answer still disables an approval card', () => {
  const html = renderToStaticMarkup(createElement(AskCard, {
    toolName: 'Bash', callId: 'call-1', toolInput: {}, answered: '', onReply: () => {},
  }));
  assert.equal((html.match(/disabled=""/g) ?? []).length, 2);
});

test('hostile special-tool ask payloads degrade to a render-safe deny-only card', () => {
  const hostile = [
    { toolName: 'AskUserQuestion', toolInput: { questions: 'boom' } },
    { toolName: 'AskUserQuestion', toolInput: { questions: [null] } },
    { toolName: 'AskUserQuestion', toolInput: { questions: [{ question: '   ' }] } },
    { toolName: 'ExitPlanMode', toolInput: { plan: { secret: 'never render me' } } },
    { toolName: 'ExitPlanMode', toolInput: { plan: '   ' } },
  ];
  for (const input of hostile) {
    assert.deepEqual(normalizeAskPresentation(input.toolName, input.toolInput), {
      kind: 'approval', degraded: true,
    });
    const html = renderToStaticMarkup(createElement(AskCard, {
      ...input, callId: 'hostile-call', onReply: () => {},
    }));
    assert.match(html, /Structured request details were unavailable/);
    assert.doesNotMatch(html, />Allow</);
    assert.match(html, />Deny unsafe request</);
    assert.equal(html.includes('never render me'), false);
  }
});

test('valid question payload is normalized to render-safe primitive fields', () => {
  const presentation = normalizeAskPresentation('AskUserQuestion', {
    questions: [{
      question: 'Choose', header: 'Decision', multiSelect: false,
      options: [{ label: 'A', description: 'First' }], ignored: { native: true },
    }],
  });
  assert.deepEqual(presentation, {
    kind: 'questions',
    questions: [{
      question: 'Choose', header: 'Decision', multiSelect: false,
      options: [{ label: 'A', description: 'First' }],
    }],
  });
});

test('activity display derives elapsed and still-waiting without inventing a durable event', () => {
  const activity: CurrentActivityProjection = {
    turnId: 'turn-1',
    startedAt: 1_000,
    updatedAt: 3_000,
    sequence: 4,
    source: { kind: 'activity', phase: 'requesting-runtime' },
  };
  assert.deepEqual(deriveActivityDisplay(activity, 10_999, 8_000), {
    text: 'Waiting for the runtime',
    elapsedMs: 9_999,
    stillWaiting: false,
  });
  assert.deepEqual(deriveActivityDisplay(activity, 11_000, 8_000), {
    text: 'Still waiting · Waiting for the runtime',
    elapsedMs: 10_000,
    stillWaiting: true,
  });
  assert.deepEqual(deriveActivityDisplay(activity, 500, 8_000), {
    text: 'Waiting for the runtime',
    elapsedMs: 0,
    stillWaiting: false,
  });
  assert.equal(deriveActivityDisplay(null, Date.now()), null);
  assert.equal(formatActivityElapsed(59_999), '59s');
  assert.equal(formatActivityElapsed(61_000), '1m 01s');
});

test('tool activity uses only canonical safe summary and closed state', () => {
  const activity: CurrentActivityProjection = {
    turnId: 'turn-1',
    startedAt: 0,
    updatedAt: 0,
    sequence: 2,
    source: {
      kind: 'tool', callId: 'call-1', state: 'approval-needed', safeSummary: 'Use Bash',
    },
  };
  const display = deriveActivityDisplay(activity, 1_000, 8_000);
  assert.equal(display?.text, 'Waiting for approval · Use Bash');
  assert.equal(JSON.stringify(display).includes('secret-command'), false);
});
