// Header model/effort pickers — the store round-trip (`state/runtimes.ts`
// setModel/setEffort) and the pickers' pure "what do I list" selectors
// (ModelSwitcher/EffortSwitcher). Mirrors runtimes-store.test.ts's direct
// store-driving style; no DOM renderer in this project's test harness.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import type { SessionSummary } from '@pc/contracts';
import { useRuntimes, type RuntimeInfo } from '../src/state/runtimes.ts';
import { modelLabel, modelsForSelection } from '../src/components/ModelSwitcher.tsx';
import { effortOptionsForSelection } from '../src/components/EffortSwitcher.tsx';

const PROJECT_ID = 'project-model-effort';

const RUNTIMES: RuntimeInfo[] = [
  {
    id: 'claude-agent-sdk',
    label: 'Claude',
    accounts: [
      {
        id: 'personal',
        capabilities: null,
        available: true,
        reasonCode: null,
        models: [
          {
            id: 'opus',
            resolvedId: null,
            label: 'Opus',
            description: '',
            effort: { status: 'supported', values: ['low', 'medium', 'high'] },
          },
          {
            id: 'fable',
            resolvedId: null,
            label: 'Fable',
            description: '',
            effort: { status: 'unsupported', code: 'effort-not-modeled' },
          },
        ],
      },
    ],
  },
];

// ── ModelSwitcher / EffortSwitcher pure selectors ────────────────────────────

test('modelsForSelection lists the discovered account models, empty for an unknown runtime/account', () => {
  assert.deepEqual(
    modelsForSelection(RUNTIMES, 'claude-agent-sdk', 'personal').map((m) => m.id),
    ['opus', 'fable'],
  );
  assert.deepEqual(modelsForSelection(RUNTIMES, 'claude-agent-sdk', 'work'), []);
  assert.deepEqual(modelsForSelection(RUNTIMES, 'openai-codex', 'personal'), []);
  assert.deepEqual(modelsForSelection(RUNTIMES, null, 'personal'), []);
});

test('modelLabel resolves a known model to its label and falls back to the raw id', () => {
  const models = modelsForSelection(RUNTIMES, 'claude-agent-sdk', 'personal');
  assert.equal(modelLabel(models, 'opus'), 'Opus');
  assert.equal(modelLabel(models, 'unknown-model'), 'unknown-model');
});

test('effortOptionsForSelection offers exactly the supported model\'s values, and omits effort for an unsupported model', () => {
  const supported = effortOptionsForSelection(RUNTIMES, 'claude-agent-sdk', 'personal', 'opus');
  assert.deepEqual(supported, { supported: true, reasonCode: null, values: ['low', 'medium', 'high'] });

  const unsupported = effortOptionsForSelection(RUNTIMES, 'claude-agent-sdk', 'personal', 'fable');
  assert.deepEqual(unsupported, { supported: false, reasonCode: 'effort-not-modeled', values: [] });

  const unknownModel = effortOptionsForSelection(RUNTIMES, 'claude-agent-sdk', 'personal', 'ghost');
  assert.deepEqual(unknownModel, { supported: false, reasonCode: null, values: [] });

  const noSelection = effortOptionsForSelection(RUNTIMES, null, 'personal', 'opus');
  assert.deepEqual(noSelection, { supported: false, reasonCode: null, values: [] });
});

// ── store round-trip ──────────────────────────────────────────────────────

function sessionSummary(overrides: {
  id: string;
  model: string;
  effort?: { kind: 'none' } | { kind: 'selected'; value: string };
}): SessionSummary {
  return {
    id: overrides.id,
    projectId: PROJECT_ID,
    selection: {
      runtimeId: 'claude-agent-sdk',
      accountId: 'personal',
      model: overrides.model,
      effort: overrides.effort ?? { kind: 'none' },
    },
    title: null,
    status: 'active',
    nativeSessionIdPresent: true,
    continuationState: 'clean-started',
    resumeAvailability: { status: 'unavailable', code: 'session-active' },
    startedAt: 1,
    sourceSessionId: null,
  };
}

function seedActiveSession(model: string, effort?: { kind: 'none' } | { kind: 'selected'; value: string }): void {
  useRuntimes.getState().bindProject(null);
  useRuntimes.getState().bindProject(PROJECT_ID);
  useRuntimes.getState().applySessionChanged({
    type: 'session-changed',
    projectId: PROJECT_ID,
    transition: 'new-session',
    session: sessionSummary({ id: 'session-1', model, effort }),
  });
}

test('setModel posts the current runtime/account with the new model and adopts the returned session', async () => {
  seedActiveSession('opus');
  assert.equal(useRuntimes.getState().activeSession?.selection?.model, 'opus');

  const originalFetch = globalThis.fetch;
  let capturedPath: string | undefined;
  let capturedInit: RequestInit | undefined;
  try {
    globalThis.fetch = (async (path: string, init?: RequestInit) => {
      capturedPath = path;
      capturedInit = init;
      return new Response(JSON.stringify({
        runtimeId: 'claude-agent-sdk',
        switched: true,
        session: sessionSummary({ id: 'session-2', model: 'sonnet' }),
      }), { status: 200, headers: { 'content-type': 'application/json' } });
    }) as typeof fetch;

    await useRuntimes.getState().setModel(PROJECT_ID, 'sonnet');

    assert.equal(capturedPath, `/api/projects/${PROJECT_ID}/runtime`);
    assert.deepEqual(JSON.parse(capturedInit!.body as string), {
      runtimeId: 'claude-agent-sdk',
      accountId: 'personal',
      model: 'sonnet',
    });
    assert.equal(useRuntimes.getState().activeSession?.id, 'session-2');
    assert.equal(useRuntimes.getState().activeSession?.selection?.model, 'sonnet');
    assert.equal(useRuntimes.getState().status, 'idle');
    assert.equal(useRuntimes.getState().error, null);
  } finally {
    globalThis.fetch = originalFetch;
    useRuntimes.getState().bindProject(null);
  }
});

test('setEffort posts the current runtime/account/model with the new effort and adopts the returned session', async () => {
  seedActiveSession('opus');

  const originalFetch = globalThis.fetch;
  let capturedInit: RequestInit | undefined;
  try {
    globalThis.fetch = (async (_path: string, init?: RequestInit) => {
      capturedInit = init;
      return new Response(JSON.stringify({
        runtimeId: 'claude-agent-sdk',
        switched: true,
        session: sessionSummary({ id: 'session-2', model: 'opus', effort: { kind: 'selected', value: 'high' } }),
      }), { status: 200, headers: { 'content-type': 'application/json' } });
    }) as typeof fetch;

    await useRuntimes.getState().setEffort(PROJECT_ID, 'high');

    assert.deepEqual(JSON.parse(capturedInit!.body as string), {
      runtimeId: 'claude-agent-sdk',
      accountId: 'personal',
      model: 'opus',
      effort: 'high',
    });
    assert.equal(useRuntimes.getState().activeSession?.id, 'session-2');
    assert.deepEqual(useRuntimes.getState().activeSession?.selection?.effort, { kind: 'selected', value: 'high' });
    assert.equal(useRuntimes.getState().status, 'idle');
  } finally {
    globalThis.fetch = originalFetch;
    useRuntimes.getState().bindProject(null);
  }
});

test('setEffort is a no-op without an active stamped selection — nothing to keep the model fixed under', async () => {
  useRuntimes.getState().bindProject(null);
  useRuntimes.getState().bindProject(PROJECT_ID);
  assert.equal(useRuntimes.getState().activeSession, null);

  const originalFetch = globalThis.fetch;
  let called = false;
  try {
    globalThis.fetch = (async () => {
      called = true;
      return new Response('{}', { status: 200 });
    }) as typeof fetch;

    await useRuntimes.getState().setEffort(PROJECT_ID, 'high');
    assert.equal(called, false);
  } finally {
    globalThis.fetch = originalFetch;
    useRuntimes.getState().bindProject(null);
  }
});

test('a failed setModel round-trip surfaces a typed error and keeps the prior selection', async () => {
  seedActiveSession('opus');

  const originalFetch = globalThis.fetch;
  try {
    globalThis.fetch = (async () => new Response(
      JSON.stringify({ ok: false, error: 'model-unsupported' }),
      { status: 422, headers: { 'content-type': 'application/json' } },
    )) as typeof fetch;

    await useRuntimes.getState().setModel(PROJECT_ID, 'not-a-real-model');

    assert.equal(useRuntimes.getState().status, 'error');
    assert.match(useRuntimes.getState().error ?? '', /model-unsupported/);
    assert.equal(useRuntimes.getState().activeSession?.selection?.model, 'opus');
  } finally {
    globalThis.fetch = originalFetch;
    useRuntimes.getState().bindProject(null);
  }
});
