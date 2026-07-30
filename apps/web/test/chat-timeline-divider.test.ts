// selectionDeltaLabel — the pure "what does this continuation divider say"
// function behind PriorTranscriptBlocks. No DOM renderer in this project's
// test harness (see model-effort-switcher.test.ts); exercise the pure
// selector directly.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import type { RuntimeSelection } from '@pc/contracts';
import { selectionDeltaLabel } from '../src/features/chat/ChatTimeline.tsx';

function selection(overrides: Partial<RuntimeSelection>): RuntimeSelection {
  return {
    runtimeId: 'claude-agent-sdk',
    accountId: 'personal',
    model: 'opus',
    effort: { kind: 'none' },
    ...overrides,
  };
}

test('selectionDeltaLabel shows the account delta for a same-runtime cross-account handoff', () => {
  const from = selection({ accountId: 'personal' });
  const to = selection({ accountId: 'work' });
  assert.equal(selectionDeltaLabel(from, to), 'account: personal → work');
});

test('selectionDeltaLabel shows the account delta even when model/effort also changed', () => {
  const from = selection({ accountId: 'personal', model: 'sonnet' });
  const to = selection({ accountId: 'work', model: 'opus', effort: { kind: 'selected', value: 'high' } });
  assert.equal(selectionDeltaLabel(from, to), 'account: personal → work');
});

test('selectionDeltaLabel falls back to the model/effort delta when the account is unchanged', () => {
  const from = selection({ model: 'sonnet' });
  const to = selection({ model: 'opus', effort: { kind: 'selected', value: 'high' } });
  assert.equal(selectionDeltaLabel(from, to), 'sonnet → opus (high)');
});

test('selectionDeltaLabel never branches on runtimeId and falls back to "unknown selection" for a missing side', () => {
  const to = selection({ runtimeId: 'openai-codex', accountId: 'work' });
  assert.equal(selectionDeltaLabel(null, to), 'unknown selection → opus');
  assert.equal(selectionDeltaLabel(to, undefined), 'opus → unknown selection');
});
