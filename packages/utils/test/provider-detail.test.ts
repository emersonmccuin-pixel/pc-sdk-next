import { test } from 'node:test';
import assert from 'node:assert/strict';

import { PROVIDER_DETAIL_MAX_LENGTH, scrubProviderDetail } from '../src/provider-detail.ts';

test('safe short text passes through unchanged', () => {
  assert.equal(scrubProviderDetail('rate limited: quota exceeded'), 'rate limited: quota exceeded');
  assert.equal(scrubProviderDetail('  trims surrounding whitespace  '), 'trims surrounding whitespace');
});

test('empty, whitespace-only, or non-string input yields null', () => {
  assert.equal(scrubProviderDetail(''), null);
  assert.equal(scrubProviderDetail('   '), null);
  assert.equal(scrubProviderDetail(null), null);
  assert.equal(scrubProviderDetail(undefined), null);
});

test('redacts an sk- style API key', () => {
  assert.equal(
    scrubProviderDetail('auth failed for sk-abcdefgh12345678'),
    'auth failed for [redacted]',
  );
});

test('redacts a Bearer token', () => {
  assert.equal(
    scrubProviderDetail('rejected: Bearer abcDEF123.456-token_value'),
    'rejected: [redacted]',
  );
});

test('redacts a bare 40+ char base64/hex run', () => {
  const hex = 'a'.repeat(40);
  assert.equal(scrubProviderDetail(`session token ${hex} expired`), 'session token [redacted] expired');
  const base64ish = 'A'.repeat(20) + 'b'.repeat(20) + '/' + '+'.repeat(10);
  assert.equal(scrubProviderDetail(base64ish), '[redacted]');
});

test('caps output at 500 characters after scrubbing', () => {
  // Spaced words (not one long token-shaped run) so the cap, not the token
  // redaction pattern, is what's under test.
  const long = 'word '.repeat(150).trim();
  const result = scrubProviderDetail(long);
  assert.equal(result?.length, PROVIDER_DETAIL_MAX_LENGTH);
  assert.equal(result, long.slice(0, PROVIDER_DETAIL_MAX_LENGTH));
});

test('caps a message that contains a secret after redaction is applied', () => {
  const long = `error: ${'sk-' + 'a'.repeat(700)} occurred`;
  const result = scrubProviderDetail(long);
  assert.ok(result !== null);
  assert.ok(result!.includes('[redacted]'));
  assert.ok(result!.length <= PROVIDER_DETAIL_MAX_LENGTH);
});
