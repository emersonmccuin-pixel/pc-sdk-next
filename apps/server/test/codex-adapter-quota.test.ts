import assert from 'node:assert/strict';
import { test } from 'node:test';

import { CodexRuntimeAdapter } from '../src/runner/codex/adapter.ts';
import {
  CODEX_PROTOCOL_VERSION,
  CODEX_RUNTIME_ID,
  type CodexDiscoveryPeer,
  type CodexProviderFreeConformanceAuthority,
  type CodexRuntimePeer,
} from '../src/runner/codex/runtime-peer.ts';

const ACCOUNT_ID = 'codex-personal';
const NOW = 1_000;

function unusedConformanceAuthority(): CodexProviderFreeConformanceAuthority {
  return {
    async attestExecutionPolicy(): Promise<unknown> {
      throw new Error('conformance authority must not be invoked for quota observation');
    },
    async attestTurnBoundary(): Promise<unknown> {
      throw new Error('conformance authority must not be invoked for quota observation');
    },
  };
}

function unusedRuntimePeer(): Promise<CodexRuntimePeer> {
  return Promise.reject(new Error('runtime peer must not be minted for quota observation'));
}

function adapterFor(discoveryPeer: CodexDiscoveryPeer): CodexRuntimeAdapter {
  return new CodexRuntimeAdapter({
    discoveryPeer,
    conformanceAuthority: unusedConformanceAuthority(),
    runtimePeerFactory: unusedRuntimePeer,
    now: () => NOW,
  });
}

function window(usedPercent: number, windowDurationMins: number | null, resetsAt: number | null) {
  return { usedPercent, windowDurationMins, resetsAt };
}

function snapshot(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    limitId: 'codex',
    limitName: 'Codex',
    primary: null,
    secondary: null,
    credits: null,
    individualLimit: null,
    planType: null,
    rateLimitReachedType: null,
    ...over,
  };
}

function response(rateLimits: Record<string, unknown>): Record<string, unknown> {
  return {
    rateLimits,
    rateLimitsByLimitId: null,
    rateLimitResetCredits: null,
  };
}

function unavailableMarker(accountId: string, code: string): Record<string, unknown> {
  return {
    status: 'unavailable',
    protocolVersion: CODEX_PROTOCOL_VERSION,
    runtimeId: CODEX_RUNTIME_ID,
    accountId,
    code,
  };
}

test('primary and secondary rate-limit windows map into two exact observations', async () => {
  const resetsAtSeconds = 1_700_000_000;
  const adapter = adapterFor({
    async discover(): Promise<unknown> { throw new Error('unused'); },
    async readRateLimits(accountId: string): Promise<unknown> {
      assert.equal(accountId, ACCOUNT_ID);
      return response(snapshot({
        primary: window(50, 300, resetsAtSeconds),
        secondary: window(10, 10_080, resetsAtSeconds + 604_800),
        rateLimitReachedType: null,
      }));
    },
  });

  const batch = await adapter.observeSubscriptionQuota(ACCOUNT_ID);
  assert.equal(batch.availability, 'available');
  if (batch.availability !== 'available') return;
  assert.equal(batch.runtimeId, CODEX_RUNTIME_ID);
  assert.equal(batch.accountId, ACCOUNT_ID);
  assert.equal(batch.coverage, 'complete');
  assert.equal(batch.observedAt, NOW);
  assert.deepEqual(batch.observations, [
    {
      window: { id: 'primary', label: '5 hours', durationMs: 18_000_000 },
      scope: { kind: 'account' },
      source: { semantics: 'used', fraction: 0.5 },
      confidence: 'exact',
      limitState: 'allowed',
      resetsAt: resetsAtSeconds * 1_000,
    },
    {
      window: { id: 'secondary', label: '7 days', durationMs: 604_800_000 },
      scope: { kind: 'account' },
      source: { semantics: 'used', fraction: 0.1 },
      confidence: 'exact',
      limitState: 'allowed',
      resetsAt: (resetsAtSeconds + 604_800) * 1_000,
    },
  ]);
});

test('a reached limit is rejected regardless of used fraction, and a single window maps alone', async () => {
  const adapter = adapterFor({
    async discover(): Promise<unknown> { throw new Error('unused'); },
    async readRateLimits(): Promise<unknown> {
      return response(snapshot({
        primary: window(5, 300, null),
        secondary: null,
        rateLimitReachedType: 'rate_limit_reached',
      }));
    },
  });

  const batch = await adapter.observeSubscriptionQuota(ACCOUNT_ID);
  assert.equal(batch.availability, 'available');
  if (batch.availability !== 'available') return;
  assert.deepEqual(batch.observations, [{
    window: { id: 'primary', label: '5 hours', durationMs: 18_000_000 },
    scope: { kind: 'account' },
    source: { semantics: 'used', fraction: 0.05 },
    confidence: 'exact',
    limitState: 'rejected',
    resetsAt: null,
  }]);
});

test('a non-ChatGPT account degrades to account-unavailable', async () => {
  const adapter = adapterFor({
    async discover(): Promise<unknown> { throw new Error('unused'); },
    async readRateLimits(accountId: string): Promise<unknown> {
      return unavailableMarker(accountId, 'account-unavailable');
    },
  });

  assert.deepEqual(await adapter.observeSubscriptionQuota(ACCOUNT_ID), {
    runtimeId: CODEX_RUNTIME_ID,
    accountId: ACCOUNT_ID,
    availability: 'unavailable',
    reason: 'account-unavailable',
    observedAt: NOW,
  });
});

test('an out-of-range usedPercent clamps into 0..1 rather than failing closed', async () => {
  const adapter = adapterFor({
    async discover(): Promise<unknown> { throw new Error('unused'); },
    async readRateLimits(): Promise<unknown> {
      return response(snapshot({ primary: window(140, 300, null) }));
    },
  });

  const batch = await adapter.observeSubscriptionQuota(ACCOUNT_ID);
  assert.equal(batch.availability, 'available');
  if (batch.availability !== 'available') return;
  assert.equal(batch.observations[0]?.source.fraction, 1);
  assert.equal(batch.observations[0]?.limitState, 'rejected');
});

test('an aborted signal reports observation-timeout without waiting on the read to resolve', async () => {
  const controller = new AbortController();
  controller.abort();
  let called = false;
  const adapter = adapterFor({
    async discover(): Promise<unknown> { throw new Error('unused'); },
    async readRateLimits(): Promise<unknown> {
      called = true;
      return response(snapshot({ primary: window(1, 300, null) }));
    },
  });

  assert.deepEqual(
    await adapter.observeSubscriptionQuota(ACCOUNT_ID, { signal: controller.signal }),
    {
      runtimeId: CODEX_RUNTIME_ID,
      accountId: ACCOUNT_ID,
      availability: 'unavailable',
      reason: 'observation-timeout',
      observedAt: NOW,
    },
  );
  assert.equal(called, false, 'an already-aborted signal must short-circuit before the read');
});

test('hostile and malformed payloads fail closed as invalid-observation', async () => {
  const cases: unknown[] = [
    null,
    {},
    { rateLimits: null },
    { rateLimits: {} },
    { rateLimits: snapshot({ primary: 'not-a-window' }) },
    { rateLimits: snapshot({ primary: window(50, -5, null) }) },
    { rateLimits: snapshot({ primary: window(50, 300, -1) }) },
    { rateLimits: snapshot({ rateLimitReachedType: 'not-a-real-reason' }) },
    { rateLimits: snapshot({ primary: null, secondary: null }) },
    'a bare string',
    42,
  ];

  for (const payload of cases) {
    const adapter = adapterFor({
      async discover(): Promise<unknown> { throw new Error('unused'); },
      async readRateLimits(): Promise<unknown> { return payload; },
    });
    assert.deepEqual(
      await adapter.observeSubscriptionQuota(ACCOUNT_ID),
      {
        runtimeId: CODEX_RUNTIME_ID,
        accountId: ACCOUNT_ID,
        availability: 'unavailable',
        reason: 'invalid-observation',
        observedAt: NOW,
      },
      `payload ${JSON.stringify(payload)} must fail closed`,
    );
  }
});

test('a fake that only implements discover reports unsupported, never invoked', async () => {
  let discoverCalls = 0;
  const adapter = adapterFor({
    async discover(): Promise<unknown> {
      discoverCalls += 1;
      return {
        status: 'available',
        protocolVersion: CODEX_PROTOCOL_VERSION,
        runtimeId: CODEX_RUNTIME_ID,
        accountId: ACCOUNT_ID,
        models: [{
          id: 'gpt-5.4',
          resolvedId: null,
          label: 'GPT-5.4',
          description: '',
          effort: { status: 'unsupported', code: 'codex-model-effort-unsupported' },
        }],
      };
    },
  });

  assert.deepEqual(await adapter.observeSubscriptionQuota(ACCOUNT_ID), {
    runtimeId: CODEX_RUNTIME_ID,
    accountId: ACCOUNT_ID,
    availability: 'unavailable',
    reason: 'unsupported',
    observedAt: NOW,
  });
  assert.equal(discoverCalls, 0, 'quota observation must not fall back to model discovery');

  assert.deepEqual(await adapter.capabilities(ACCOUNT_ID), {
    runtimeId: CODEX_RUNTIME_ID,
    accountId: ACCOUNT_ID,
    nativeContinuation: { status: 'supported' },
    continuationAcrossSelectionChange: {
      status: 'unsupported', code: 'codex-selection-change-continuation-unsupported',
    },
    modelDiscovery: { status: 'supported' },
    effortControl: { status: 'unsupported', code: 'codex-effort-unsupported' },
    context: {
      currentUse: { status: 'unavailable', code: 'codex-context-unavailable' },
      compaction: { status: 'unavailable', code: 'codex-compaction-unavailable' },
    },
    subscriptionQuota: { status: 'unavailable', code: 'codex-quota-unavailable' },
  });
  assert.equal(discoverCalls, 1);
});

test('capabilities reports subscription quota as supported once the peer implements readRateLimits', async () => {
  const adapter = adapterFor({
    async discover(): Promise<unknown> {
      return {
        status: 'available',
        protocolVersion: CODEX_PROTOCOL_VERSION,
        runtimeId: CODEX_RUNTIME_ID,
        accountId: ACCOUNT_ID,
        models: [{
          id: 'gpt-5.4',
          resolvedId: null,
          label: 'GPT-5.4',
          description: '',
          effort: { status: 'unsupported', code: 'codex-model-effort-unsupported' },
        }],
      };
    },
    async readRateLimits(): Promise<unknown> {
      return response(snapshot({ primary: window(1, 300, null) }));
    },
  });

  const capabilities = await adapter.capabilities(ACCOUNT_ID);
  assert.deepEqual(capabilities.subscriptionQuota, {
    status: 'supported',
    sourceSemantics: ['used'],
    confidences: ['exact'],
  });
});
