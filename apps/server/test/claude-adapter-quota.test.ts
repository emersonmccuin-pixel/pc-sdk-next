import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { SDKMessage } from '@anthropic-ai/claude-agent-sdk';

import { AccountRegistry } from '../src/runner/account-env.ts';
import {
  CLAUDE_RUNTIME_ID,
  ClaudeRuntimeAdapter,
  createSdkKeyContext,
  mapClaudeOauthQuotaResponse,
  mapClaudeRateLimitInfo,
  mapSdkMessage,
} from '../src/runner/claude-adapter.ts';

const NOW = Date.parse('2026-07-12T12:00:00.000Z');
const FIVE_HOUR_RESET = '2026-07-12T17:00:00.000000+00:00';
const SEVEN_DAY_RESET = '2026-07-19T12:00:00.000000+00:00';

function accounts(): AccountRegistry {
  return new AccountRegistry([{
    id: 'personal',
    runtimeId: CLAUDE_RUNTIME_ID,
    configDir: 'C:/claude-personal',
  }]);
}

function credentials(expiresAt = NOW + 60_000): string {
  return JSON.stringify({
    claudeAiOauth: { accessToken: 'oauth-token', expiresAt },
  });
}

test('Claude OAuth quota observation is adapter-owned, complete, and keeps enforcement separate', async () => {
  const controller = new AbortController();
  let requestedUrl = '';
  let requestedConfigDir = '';
  let requestedSignal: AbortSignal | null | undefined;
  let authorization = '';
  let beta = '';
  const adapter = new ClaudeRuntimeAdapter({
    accounts: accounts(),
    now: () => NOW,
    readCredentials: async (configDir) => {
      requestedConfigDir = configDir;
      return credentials();
    },
    quotaFetch: (async (input, init) => {
      requestedUrl = String(input);
      requestedSignal = init?.signal;
      const headers = new Headers(init?.headers);
      authorization = headers.get('Authorization') ?? '';
      beta = headers.get('anthropic-beta') ?? '';
      return new Response(JSON.stringify({
        five_hour: { utilization: 100, resets_at: FIVE_HOUR_RESET },
        seven_day: { utilization: 26, resets_at: SEVEN_DAY_RESET },
        limits: [{
          kind: 'weekly_scoped',
          group: 'weekly',
          percent: 92,
          severity: 'critical',
          is_active: false,
          resets_at: SEVEN_DAY_RESET,
          scope: { model: { id: null, display_name: 'Fable' } },
        }],
      }), { status: 200, headers: { 'content-type': 'application/json' } });
    }) as typeof fetch,
  });

  const batch = await adapter.observeSubscriptionQuota('personal', {
    signal: controller.signal,
  });

  assert.equal(requestedUrl, 'https://api.anthropic.com/api/oauth/usage');
  assert.equal(requestedConfigDir, 'C:/claude-personal');
  assert.equal(requestedSignal, controller.signal);
  assert.equal(authorization, 'Bearer oauth-token');
  assert.equal(beta, 'oauth-2025-04-20');
  assert.equal(batch.availability, 'available');
  if (batch.availability !== 'available') return;
  assert.equal(batch.runtimeId, CLAUDE_RUNTIME_ID);
  assert.equal(batch.accountId, 'personal');
  assert.equal(batch.coverage, 'complete');
  assert.equal(batch.observedAt, NOW);
  assert.deepEqual(batch.observations, [
    {
      window: { id: 'five-hour', label: '5h', durationMs: 18_000_000 },
      scope: { kind: 'account' },
      source: { semantics: 'used', fraction: 1 },
      confidence: 'exact',
      limitState: 'unknown',
      resetsAt: Date.parse(FIVE_HOUR_RESET),
    },
    {
      window: { id: 'seven-day', label: '7d', durationMs: 604_800_000 },
      scope: { kind: 'account' },
      source: { semantics: 'used', fraction: 0.26 },
      confidence: 'exact',
      limitState: 'unknown',
      resetsAt: Date.parse(SEVEN_DAY_RESET),
    },
    {
      window: { id: 'model:fable', label: 'Fable', durationMs: 604_800_000 },
      scope: { kind: 'model', model: 'Fable' },
      source: { semantics: 'used', fraction: 0.92 },
      confidence: 'exact',
      limitState: 'unknown',
      resetsAt: Date.parse(SEVEN_DAY_RESET),
    },
  ]);
});

test('Claude OAuth quota fails closed on malformed percentages, credentials, and aborts', async () => {
  assert.equal(mapClaudeOauthQuotaResponse({}, 'personal', NOW), null);
  assert.equal(mapClaudeOauthQuotaResponse({ future_shape: {} }, 'personal', NOW), null);
  assert.equal(mapClaudeOauthQuotaResponse({ limits: [] }, 'personal', NOW), null);
  assert.equal(mapClaudeOauthQuotaResponse({
    limits: [{
      kind: 'overage',
      group: 'credits',
      percent: 80,
      resets_at: SEVEN_DAY_RESET,
      scope: { model: { id: 'billing-model', display_name: 'Billing model' } },
    }],
  }, 'personal', NOW), null, 'billing-only shapes are not subscription quota evidence');
  const additiveBilling = mapClaudeOauthQuotaResponse({
    five_hour: null,
    limits: [null, 'future-shape', {
      kind: 'overage', group: 'credits', percent: 80,
      resets_at: SEVEN_DAY_RESET,
      scope: { model: { id: 'billing-model', display_name: 'Billing model' } },
    }],
  }, 'personal', NOW);
  assert.ok(additiveBilling && additiveBilling.availability === 'available');
  assert.deepEqual(additiveBilling.observations, []);
  const unrelatedWeekly = mapClaudeOauthQuotaResponse({
    five_hour: null,
    limits: [{
      kind: 'weekly_scoped', group: 'weekly', percent: 70,
      resets_at: SEVEN_DAY_RESET,
      scope: { model: { id: 'unbundled-model', display_name: 'Other model' } },
    }],
  }, 'personal', NOW);
  assert.ok(unrelatedWeekly?.availability === 'available');
  assert.deepEqual(unrelatedWeekly.observations, [], 'unverified model limits are not plan quota');
  const misleadingId = mapClaudeOauthQuotaResponse({
    five_hour: null,
    limits: [{
      kind: 'weekly_scoped', group: 'weekly', percent: 70,
      resets_at: SEVEN_DAY_RESET,
      scope: { model: { id: 'fable', display_name: 'Other model' } },
    }],
  }, 'personal', NOW);
  assert.ok(misleadingId?.availability === 'available');
  assert.deepEqual(misleadingId.observations, [], 'native id cannot bypass the plan allowlist label');
  assert.equal(mapClaudeOauthQuotaResponse({ five_hour: null }, 'per😀sonal', NOW), null);
  assert.equal(mapClaudeOauthQuotaResponse({ five_hour: null }, '\tpersonal', NOW), null);
  assert.equal(mapClaudeOauthQuotaResponse({
    five_hour: { utilization: 10, resets_at: '2026-02-31T00:00:00Z' },
  }, 'personal', NOW), null);
  assert.equal(mapClaudeOauthQuotaResponse({ five_hour: {} }, 'personal', NOW), null);
  assert.equal(mapClaudeOauthQuotaResponse({
    five_hour: null,
    limits: [{
      kind: 'weekly_scoped', group: 'weekly', resets_at: SEVEN_DAY_RESET,
      scope: { model: { id: 'fable', display_name: 'Fable' } },
    }],
  }, 'personal', NOW), null);
  let fetches = 0;
  const malformed = new ClaudeRuntimeAdapter({
    accounts: accounts(),
    now: () => NOW,
    readCredentials: async () => credentials(),
    quotaFetch: (async () => {
      fetches += 1;
      return new Response(JSON.stringify({
        five_hour: { utilization: -1, resets_at: FIVE_HOUR_RESET },
      }), { status: 200 });
    }) as typeof fetch,
  });
  assert.deepEqual(await malformed.observeSubscriptionQuota('personal'), {
    runtimeId: CLAUDE_RUNTIME_ID,
    accountId: 'personal',
    availability: 'unavailable',
    reason: 'invalid-observation',
    observedAt: NOW,
  });
  assert.equal(fetches, 1);
  await assert.rejects(
    () => malformed.observeSubscriptionQuota(' bad '),
    /subscription quota account identity is invalid/,
  );
  await assert.rejects(
    () => malformed.observeSubscriptionQuota('bad-😀'),
    /subscription quota account identity is invalid/,
  );

  let expiredFetches = 0;
  const expired = new ClaudeRuntimeAdapter({
    accounts: accounts(),
    now: () => NOW,
    readCredentials: async () => credentials(NOW),
    quotaFetch: (async () => {
      expiredFetches += 1;
      throw new Error('fetch must not run with expired credentials');
    }) as typeof fetch,
  });
  assert.equal((await expired.observeSubscriptionQuota('personal')).availability, 'unavailable');
  assert.equal(expiredFetches, 0);

  const aborted = new ClaudeRuntimeAdapter({
    accounts: accounts(),
    now: () => NOW,
    readCredentials: async () => credentials(),
    quotaFetch: (async () => {
      const error = new Error('provider detail must stay private');
      error.name = 'AbortError';
      throw error;
    }) as typeof fetch,
  });
  assert.deepEqual(await aborted.observeSubscriptionQuota('personal'), {
    runtimeId: CLAUDE_RUNTIME_ID,
    accountId: 'personal',
    availability: 'unavailable',
    reason: 'observation-timeout',
    observedAt: NOW,
  });
});

test('SDK rate-limit events map used fraction and epoch seconds into one exact partial batch', () => {
  const resetSeconds = Math.floor(Date.parse(SEVEN_DAY_RESET) / 1_000);
  const events = mapSdkMessage({
    type: 'rate_limit_event',
    uuid: 'quota-event',
    session_id: 'native-session',
    rate_limit_info: {
      status: 'allowed_warning',
      rateLimitType: 'seven_day_opus',
      utilization: 0.5,
      resetsAt: resetSeconds,
    },
  } as unknown as SDKMessage, 'personal', createSdkKeyContext(), () => NOW);

  assert.deepEqual(events, [{
    type: 'subscription-quota',
    batch: {
      runtimeId: CLAUDE_RUNTIME_ID,
      accountId: 'personal',
      availability: 'available',
      coverage: 'partial',
      observedAt: NOW,
      observations: [{
        window: { id: 'seven-day-opus', label: 'Opus 7d', durationMs: 604_800_000 },
        scope: { kind: 'model', model: 'opus' },
        source: { semantics: 'used', fraction: 0.5 },
        confidence: 'exact',
        limitState: 'warning',
        resetsAt: resetSeconds * 1_000,
      }],
    },
  }]);
});

test('malformed SDK quota events are dropped without fabricated zero or timestamp-unit guessing', () => {
  const map = (rate_limit_info: Record<string, unknown>) => mapSdkMessage({
    type: 'rate_limit_event', uuid: 'quota-event', session_id: 'native-session', rate_limit_info,
  } as unknown as SDKMessage, 'personal', createSdkKeyContext(), () => NOW);

  assert.deepEqual(map({ status: 'allowed', rateLimitType: 'five_hour' }), []);
  assert.deepEqual(map({
    status: 'allowed', rateLimitType: 'five_hour', utilization: 101,
  }), []);
  assert.deepEqual(map({
    status: 'allowed', rateLimitType: 'five_hour', utilization: 1.01,
    resetsAt: Math.floor(Date.parse(FIVE_HOUR_RESET) / 1_000),
  }), [], 'passive utilization is a strict 0..1 fraction, never a percent');
  assert.deepEqual(map({
    status: 'allowed', rateLimitType: 'five_hour', utilization: 1,
    resetsAt: Date.parse(FIVE_HOUR_RESET),
  }), [], 'epoch milliseconds must not be guessed as epoch seconds');
  assert.deepEqual(map({
    status: 'allowed', rateLimitType: 'future_window', utilization: 1,
  }), []);
  assert.deepEqual(map({
    status: 'allowed', rateLimitType: 'overage', utilization: 1,
    resetsAt: Math.floor(Date.parse(SEVEN_DAY_RESET) / 1_000),
  }), [], 'overage billing state is not admitted as subscription quota');
});

test('passive quota buckets align with the next complete pull taxonomy', () => {
  const resetSeconds = Math.floor(Date.parse(SEVEN_DAY_RESET) / 1_000);
  const passive = mapClaudeRateLimitInfo({
    status: 'allowed',
    rateLimitType: 'seven_day_opus',
    utilization: 0.5,
    resetsAt: resetSeconds,
  }, 'personal', NOW);
  const pull = mapClaudeOauthQuotaResponse({
    seven_day_opus: { utilization: 50, resets_at: SEVEN_DAY_RESET },
  }, 'personal', NOW + 1);
  assert.ok(passive?.availability === 'available');
  assert.ok(pull?.availability === 'available');
  assert.deepEqual(
    passive.observations.map((item) => item.window.id),
    pull.observations.map((item) => item.window.id),
  );

  const included = mapClaudeRateLimitInfo({
    status: 'allowed_warning',
    rateLimitType: 'seven_day_overage_included',
    utilization: 0.5,
    resetsAt: resetSeconds,
  }, 'personal', NOW);
  const includedPull = mapClaudeOauthQuotaResponse({
    limits: [{
      kind: 'weekly_scoped',
      group: 'weekly',
      percent: 50,
      severity: 'warning',
      is_active: true,
      resets_at: SEVEN_DAY_RESET,
      scope: { model: { id: 'claude-fable-5', display_name: 'Fable' } },
    }],
  }, 'personal', NOW + 1);
  assert.ok(included?.availability === 'available');
  assert.ok(includedPull?.availability === 'available');
  assert.deepEqual(included.observations[0]?.window, includedPull.observations[0]?.window);
  assert.deepEqual(included.observations[0]?.scope, includedPull.observations[0]?.scope);
});
