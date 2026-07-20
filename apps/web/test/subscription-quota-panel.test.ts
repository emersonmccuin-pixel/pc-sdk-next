import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import type {
  SubscriptionQuotaObservation,
  SubscriptionQuotaSnapshot,
} from '@pc/contracts';

import { SubscriptionQuotaPanel } from '../src/components/SubscriptionQuotaPanel.tsx';

function observation(
  over: Partial<SubscriptionQuotaObservation> = {},
): SubscriptionQuotaObservation {
  return {
    window: { id: 'weekly', label: '7 days', durationMs: 604_800_000 },
    scope: { kind: 'account' },
    source: { semantics: 'remaining', fraction: 0.25 },
    usedFraction: 0.75,
    confidence: 'derived',
    limitState: 'warning',
    resetsAt: null,
    observedAt: Date.now(),
    staleAt: Number.MAX_SAFE_INTEGER,
    ...over,
  };
}

function snapshot(
  over: Partial<SubscriptionQuotaSnapshot> = {},
): SubscriptionQuotaSnapshot {
  return {
    id: '01KXAV20000000000000000001',
    runtimeId: 'runtime-a',
    accountId: 'personal',
    revision: 1,
    availability: 'available',
    unavailableReason: null,
    observedAt: Date.now(),
    observations: [observation()],
    ...over,
  };
}

function html(value: SubscriptionQuotaSnapshot | null): string {
  return renderToStaticMarkup(createElement(SubscriptionQuotaPanel, {
    snapshot: value,
    runtimeId: value?.runtimeId ?? 'runtime-a',
    accountId: value?.accountId ?? 'personal',
  }));
}

test('quota bar shows only window, percent used, and enforcement badge', () => {
  const markup = html(snapshot());
  assert.match(markup, /aria-label="Subscription quota"/);
  assert.match(markup, /75% used/);
  assert.match(markup, /aria-valuenow="75"/);
  assert.match(markup, /width:75%/);
  assert.match(markup, /quota warning/);
  assert.match(markup, /75% used · warning/);
  assert.match(markup, /aria-valuetext="75 percent used, warning"/);
  assert.match(markup, /role="status" aria-live="polite"/);
  assert.match(markup, /max-h-\[45vh\].*overflow-y-auto/);
  // Simplified panel drops confidence, source semantics, and the redundant
  // runtime · account line when a live snapshot is present.
  assert.doesNotMatch(markup, /derived|source reported|remaining/);
  assert.doesNotMatch(markup, /runtime-a · personal/);
});

test('fresh native rejection stays visible even when the used fraction is low', () => {
  const rejected = observation({
    source: { semantics: 'used', fraction: 0.1 },
    usedFraction: 0.1,
    confidence: 'exact',
    limitState: 'rejected',
  });
  const markup = html(snapshot({ observations: [rejected] }));
  assert.match(markup, /quota blocked/);
  assert.match(markup, /10% used · blocked/);
  assert.match(markup, /aria-valuetext="10 percent used, blocked"/);
  assert.doesNotMatch(markup, /source reported/);
});

test('unknown enforcement remains explicit and is never presented as allowed', () => {
  const unknown = observation({
    source: { semantics: 'used', fraction: 0.1 },
    usedFraction: 0.1,
    confidence: 'exact',
    limitState: 'unknown',
  });
  const markup = html(snapshot({ observations: [unknown] }));
  assert.match(markup, /10% used · limit state unknown/);
  assert.match(markup, /aria-valuetext="10 percent used, limit state unknown"/);
  assert.doesNotMatch(markup, /quota warning|quota blocked/);
});

test('stale quota is visibly stale in text, state, and accessibility detail', () => {
  const stale = observation({
    source: { semantics: 'used', fraction: 0.4 },
    usedFraction: 0.4,
    confidence: 'exact',
    observedAt: 0,
    staleAt: 0,
  });
  const markup = html(snapshot({ observedAt: 1, observations: [stale] }));
  assert.match(markup, /data-stale="true"/);
  assert.match(markup, /40% used · stale/);
  assert.match(markup, /aria-valuetext="40 percent used, stale"/);
});

test('unavailable quota never presents retained last-good windows as current', () => {
  const unavailable = snapshot({
    availability: 'unavailable',
    unavailableReason: 'runtime-unavailable',
  });
  const markup = html(unavailable);
  assert.match(markup, /temporarily unavailable/);
  assert.match(markup, /No current percentage available/);
  assert.doesNotMatch(markup, /role="progressbar"|75% used|source reported 25% remaining/);
});

test('absence and empty available snapshots remain explicit without invented windows', () => {
  const absent = html(null);
  assert.match(absent, /runtime-a · personal/);
  assert.match(absent, /Quota not observed yet/);
  assert.doesNotMatch(absent, /role="progressbar"|% used/);

  const empty = html(snapshot({ observations: [] }));
  assert.match(empty, /No quota windows reported/);
  assert.doesNotMatch(empty, /5h|7d|Fable|role="progressbar"|% used/);
});

test('unresolved project attribution is explicit and never borrows a predecessor account', () => {
  const markup = renderToStaticMarkup(createElement(SubscriptionQuotaPanel, {
    snapshot: null,
    runtimeId: null,
    accountId: null,
    selectionResolved: false,
  }));
  assert.match(markup, /runtime account selection unavailable/);
  assert.match(markup, /Quota unavailable until account selection is resolved/);
  assert.doesNotMatch(markup, /personal|work|role="progressbar"/);
});

test('a title override renders per-runtime attribution for the usage dashboard, default unchanged elsewhere', () => {
  const markup = renderToStaticMarkup(createElement(SubscriptionQuotaPanel, {
    snapshot: snapshot({
      runtimeId: 'openai-codex',
      accountId: 'chatgpt',
      availability: 'unavailable',
      unavailableReason: 'unsupported',
    }),
    runtimeId: 'openai-codex',
    accountId: 'chatgpt',
    title: 'Codex · chatgpt',
  }));
  assert.match(markup, /aria-label="Codex · chatgpt"/);
  assert.match(markup, /<span>Codex · chatgpt<\/span>/);
  assert.doesNotMatch(markup, />Subscription quota</);

  const defaulted = html(snapshot());
  assert.match(defaulted, /aria-label="Subscription quota"/);
  assert.match(defaulted, /<span>Subscription quota<\/span>/);
});

test('model scope and dynamic provider-neutral labels render without fixed window names', () => {
  const modelScoped = observation({
    window: { id: 'burst', label: 'Burst window', durationMs: null },
    scope: { kind: 'model', model: 'model-a' },
  });
  const markup = html(snapshot({ observations: [modelScoped] }));
  assert.match(markup, /Burst window · model-a/);
  assert.match(markup, /aria-label="Burst window for model-a subscription quota used"/);
  assert.match(markup, /aria-describedby=/);
  assert.doesNotMatch(markup, /Fable/);
});
