// AskUserQuestion / ExitPlanMode rawAnswer interpretation — the Claude-specific
// half of the answer-style-tool fix (guard rule: `answers` shape stays inside
// the adapter, never leaks into the provider-neutral ask registry).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { resolveAnswerDecision } from '../src/runner/claude-adapter.ts';

test('ExitPlanMode: reject denies with a plan-rejected message', () => {
  const decision = resolveAnswerDecision('ExitPlanMode', { plan: 'do the thing' }, 'reject');
  assert.deepEqual(decision, { behavior: 'deny', message: 'plan rejected' });
});

test('ExitPlanMode: any non-reject answer allows and echoes input', () => {
  const input = { plan: 'do the thing' };
  const decision = resolveAnswerDecision('ExitPlanMode', input, 'accept');
  assert.deepEqual(decision, { behavior: 'allow', updatedInput: input });
});

test('AskUserQuestion: single-question rawAnswer is the chosen label', () => {
  const input = { questions: [{ question: 'Which approach?' }] };
  const decision = resolveAnswerDecision('AskUserQuestion', input, 'Option A');
  assert.deepEqual(decision, {
    behavior: 'allow',
    updatedInput: { questions: [{ question: 'Which approach?' }], answers: { 'Which approach?': 'Option A' } },
  });
});

test('AskUserQuestion: multi-question JSON array builds the answers map', () => {
  const input = { questions: [{ question: 'Q1' }, { question: 'Q2' }] };
  const rawAnswer = JSON.stringify([
    { question: 'Q1', answer: 'A1' },
    { question: 'Q2', answer: 'A2' },
  ]);
  const decision = resolveAnswerDecision('AskUserQuestion', input, rawAnswer);
  assert.deepEqual(decision, {
    behavior: 'allow',
    updatedInput: { ...input, answers: { Q1: 'A1', Q2: 'A2' } },
  });
});

test('AskUserQuestion: malformed JSON array falls back to single-label treatment', () => {
  const input = { questions: [{ question: 'Which approach?' }] };
  const decision = resolveAnswerDecision('AskUserQuestion', input, '[not valid json');
  assert.deepEqual(decision, {
    behavior: 'allow',
    updatedInput: { ...input, answers: { 'Which approach?': '[not valid json' } },
  });
});

test('other tools return null (fall through to plain allow echo)', () => {
  assert.equal(resolveAnswerDecision('Bash', { cmd: 'ls' }, 'allow'), null);
});
