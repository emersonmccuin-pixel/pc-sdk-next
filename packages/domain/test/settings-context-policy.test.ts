// Tests for the contextPolicy field in domain/settings.ts (pc-sdk-15):
// defaultGlobalSettings, withSettingsDefaults backfill, and clamping.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  CONTEXT_POLICY_THRESHOLD_TOKENS_DEFAULT,
  CONTEXT_POLICY_THRESHOLD_TOKENS_MAX,
  CONTEXT_POLICY_THRESHOLD_TOKENS_MIN,
  clampContextPolicyThresholdTokens,
  defaultGlobalSettings,
  withSettingsDefaults,
} from '../src/settings.ts';

const DATA_DIR = '/data';
const HOME_DIR = '/home/user';

test('defaultGlobalSettings: contextPolicy.thresholdTokens defaults to 100_000', () => {
  const defaults = defaultGlobalSettings(DATA_DIR, HOME_DIR);
  assert.equal(defaults.contextPolicy.thresholdTokens, CONTEXT_POLICY_THRESHOLD_TOKENS_DEFAULT);
  assert.equal(CONTEXT_POLICY_THRESHOLD_TOKENS_DEFAULT, 100_000);
});

test('withSettingsDefaults: backfills contextPolicy when absent', () => {
  const result = withSettingsDefaults({}, DATA_DIR, HOME_DIR);
  assert.equal(result.contextPolicy.thresholdTokens, CONTEXT_POLICY_THRESHOLD_TOKENS_DEFAULT);
});

test('withSettingsDefaults: preserves a valid stored threshold', () => {
  const result = withSettingsDefaults(
    { contextPolicy: { thresholdTokens: 250_000 } },
    DATA_DIR,
    HOME_DIR,
  );
  assert.equal(result.contextPolicy.thresholdTokens, 250_000);
});

test('clampContextPolicyThresholdTokens: clamps below minimum', () => {
  assert.equal(clampContextPolicyThresholdTokens(1), CONTEXT_POLICY_THRESHOLD_TOKENS_MIN);
});

test('clampContextPolicyThresholdTokens: clamps above maximum', () => {
  assert.equal(clampContextPolicyThresholdTokens(10_000_000), CONTEXT_POLICY_THRESHOLD_TOKENS_MAX);
});

test('clampContextPolicyThresholdTokens: falls back to default on non-finite input', () => {
  assert.equal(clampContextPolicyThresholdTokens(Number.NaN), CONTEXT_POLICY_THRESHOLD_TOKENS_DEFAULT);
  assert.equal(clampContextPolicyThresholdTokens(undefined), CONTEXT_POLICY_THRESHOLD_TOKENS_DEFAULT);
  assert.equal(clampContextPolicyThresholdTokens('100000'), CONTEXT_POLICY_THRESHOLD_TOKENS_DEFAULT);
});

test('clampContextPolicyThresholdTokens: floors a fractional value in range', () => {
  assert.equal(clampContextPolicyThresholdTokens(150_000.7), 150_000);
});
