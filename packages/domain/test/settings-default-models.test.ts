// Tests for the per-runtime defaultModels field in domain/settings.ts:
// defaultGlobalSettings, withSettingsDefaults backfill, and normalization.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  defaultGlobalSettings,
  normalizeDefaultModels,
  withSettingsDefaults,
} from '../src/settings.ts';

const DATA_DIR = '/data';
const HOME_DIR = '/home/user';

test('defaultGlobalSettings: defaultModels defaults to empty map', () => {
  assert.deepEqual(defaultGlobalSettings(DATA_DIR, HOME_DIR).defaultModels, {});
});

test('withSettingsDefaults: backfills defaultModels when absent', () => {
  assert.deepEqual(withSettingsDefaults({}, DATA_DIR, HOME_DIR).defaultModels, {});
});

test('withSettingsDefaults: preserves valid stored entries', () => {
  const result = withSettingsDefaults(
    { defaultModels: { 'claude-agent-sdk': 'opus', 'openai-codex': 'gpt-5.2-codex' } },
    DATA_DIR,
    HOME_DIR,
  );
  assert.deepEqual(result.defaultModels, {
    'claude-agent-sdk': 'opus',
    'openai-codex': 'gpt-5.2-codex',
  });
});

test('normalizeDefaultModels: drops empty/whitespace ids and non-string models', () => {
  assert.deepEqual(
    normalizeDefaultModels({
      'claude-agent-sdk': '  opus  ',
      '  ': 'sonnet',
      'openai-codex': '',
      'other-runtime': 42,
    }),
    { 'claude-agent-sdk': 'opus' },
  );
});

test('normalizeDefaultModels: malformed containers drop to empty map', () => {
  assert.deepEqual(normalizeDefaultModels(null), {});
  assert.deepEqual(normalizeDefaultModels(undefined), {});
  assert.deepEqual(normalizeDefaultModels('opus'), {});
  assert.deepEqual(normalizeDefaultModels(['opus']), {});
});
