// /api/runtimes — provider-neutral runtime + account availability listing.
// Exercised against fake adapters (no real provider/process involved) so the
// route's shape and degrade-on-error behavior stay covered without a live
// Codex/Claude dependency.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { resolve } from 'node:path';
import { Hono } from 'hono';
import type { ULID } from '@pc/domain';
import { mountRuntimes } from '../src/http/runtimes.ts';
import { AccountRegistry } from '../src/runner/account-env.ts';
import { SessionRegistry } from '../src/chat/registry.ts';
import { ProjectWebSocketHub } from '../src/ws/hub.ts';
import {
  resolveSelectionWithModelFallback,
  RuntimeRegistry,
  type AgentRuntimeAdapter,
  type CreateRuntimeSession,
  type ResumeRuntimeSession,
  type RuntimeModelDiscovery,
  type RuntimeSession,
} from '../src/runner/runtime.ts';
import { freshDb, newProject } from './helpers.ts';
import { testCapabilities, testModelDiscovery, testSubscriptionQuotaUnavailable } from './runtime-fixtures.ts';

const session: RuntimeSession = {
  sendTurn: async function* () {},
  observeContext: async () => ({ confidence: 'unavailable', reason: 'unsupported' }),
  async interrupt() {},
  async dispose() {},
};

/** `capsById.get(accountId) === 'throw'` simulates a native/discovery failure
 *  (e.g. the Codex adapter's app-server spawn failing) without touching a
 *  real process. */
class FakeAdapter implements AgentRuntimeAdapter {
  readonly appToolBridge = 'supported' as const;

  constructor(
    readonly id: string,
    private readonly capsById: Map<string, 'throw'> = new Map(),
    private readonly models: RuntimeModelDiscovery = { status: 'available', models: [] },
  ) {}

  async capabilities(accountId: string) {
    if (this.capsById.get(accountId) === 'throw') throw new Error('discovery unavailable');
    return testCapabilities(this.id, accountId);
  }

  async listModels() {
    return this.models;
  }

  async observeSubscriptionQuota(accountId: string) {
    return testSubscriptionQuotaUnavailable(this.id, accountId);
  }

  async createSession(_input: CreateRuntimeSession): Promise<RuntimeSession> {
    return session;
  }

  async resumeSession(_input: ResumeRuntimeSession): Promise<RuntimeSession> {
    return session;
  }
}

function fixtureAccounts(): AccountRegistry {
  const home = resolve('test-fixtures/runtime-accounts');
  return new AccountRegistry([
    { id: 'personal', runtimeId: 'claude-agent-sdk', configDir: resolve(home, '.claude') },
    { id: 'work', runtimeId: 'claude-agent-sdk', configDir: resolve(home, '.claude-work') },
    { id: 'personal', runtimeId: 'openai-codex', configDir: resolve(home, '.codex') },
  ]);
}

test('GET /api/runtimes lists every registered runtime and each account\'s capabilities', async () => {
  const accounts = fixtureAccounts();
  const runtimes = new RuntimeRegistry();
  runtimes.register(new FakeAdapter('claude-agent-sdk'));
  runtimes.register(new FakeAdapter('openai-codex'));

  const app = new Hono();
  mountRuntimes(app, { accounts, runtimes });

  const res = await app.request('/api/runtimes');
  assert.equal(res.status, 200);
  const json = await res.json() as {
    ok: boolean;
    runtimes: { runtimeId: string; accounts: { id: string; capabilities: unknown }[] }[];
  };
  assert.equal(json.ok, true);
  const byId = Object.fromEntries(json.runtimes.map((r) => [r.runtimeId, r]));

  assert.deepEqual(
    byId['claude-agent-sdk'].accounts.map((a) => a.id).sort(),
    ['personal', 'work'],
  );
  assert.deepEqual(byId['openai-codex'].accounts.map((a) => a.id), ['personal']);
  const codexCapabilities = byId['openai-codex'].accounts[0].capabilities as { runtimeId: string; accountId: string };
  assert.equal(codexCapabilities.runtimeId, 'openai-codex');
  assert.equal(codexCapabilities.accountId, 'personal');
});

test('a native/discovery failure degrades to null capabilities, never a thrown response', async () => {
  const accounts = fixtureAccounts();
  const runtimes = new RuntimeRegistry();
  runtimes.register(new FakeAdapter('claude-agent-sdk'));
  runtimes.register(new FakeAdapter('openai-codex', new Map([['personal', 'throw']])));

  const app = new Hono();
  mountRuntimes(app, { accounts, runtimes });

  const res = await app.request('/api/runtimes');
  assert.equal(res.status, 200);
  const json = await res.json() as {
    runtimes: { runtimeId: string; accounts: { id: string; capabilities: unknown }[] }[];
  };
  const codex = json.runtimes.find((r) => r.runtimeId === 'openai-codex')!;
  assert.deepEqual(codex.accounts, [
    { id: 'personal', capabilities: null, models: { status: 'available', models: [] } },
  ]);
});

test('an account seeded for an unregistered runtime is omitted, not a crash', async () => {
  const accounts = fixtureAccounts();
  const runtimes = new RuntimeRegistry();
  runtimes.register(new FakeAdapter('claude-agent-sdk'));
  // 'openai-codex' has a seeded account above but no registered adapter here —
  // mirrors a boot where the Codex account exists but the adapter failed to
  // construct (never happens today, but must not 500 the settings page).

  const app = new Hono();
  mountRuntimes(app, { accounts, runtimes });

  const res = await app.request('/api/runtimes');
  assert.equal(res.status, 200);
  const json = await res.json() as { runtimes: { runtimeId: string }[] };
  assert.deepEqual(json.runtimes.map((r) => r.runtimeId), ['claude-agent-sdk']);
});

// ── POST /api/projects/:id/runtime — header model/effort selection ──────────
//
// A FakeAdapter with real model discovery (testModelDiscovery: 'opus',
// 'opus[1m]', 'sonnet', each with supported effort ['low','medium','high'])
// so the route's model/effort validation runs through the same
// resolveSelectionWithModelFallback seam production uses, not a stub.

function fakeSelectionApp(): { app: Hono; projectId: string } {
  const accounts = fixtureAccounts();
  const runtimes = new RuntimeRegistry();
  runtimes.register(new FakeAdapter('claude-agent-sdk', new Map(), testModelDiscovery()));
  runtimes.register(new FakeAdapter('openai-codex', new Map(), testModelDiscovery()));

  const resolveNewSessionSelection = async (
    input: { projectId: string; accountId?: string; runtimeId?: string; model?: string; effort?: string | null },
  ) => {
    const runtimeId = input.runtimeId ?? 'claude-agent-sdk';
    const account = input.accountId
      ? accounts.get(runtimeId, input.accountId)
      : accounts.resolveForProject(input.projectId as ULID, runtimeId);
    if (!account) return { status: 'invalid' as const, code: 'account-unavailable' as const };
    return resolveSelectionWithModelFallback(runtimes, {
      runtimeId,
      accountId: account.id,
      model: input.model ?? 'opus',
      effort: input.effort !== undefined ? input.effort : null,
    }, input.model === undefined);
  };

  const registry = new SessionRegistry({
    hub: new ProjectWebSocketHub(),
    mintSession: async () => { throw new Error('a selection-only change must never mint a runtime session'); },
    resolveNewSessionSelection,
    preflightRuntimeSession: async (selection) => ({ status: 'valid', selection }),
  });

  const app = new Hono();
  mountRuntimes(app, { accounts, runtimes, registry, defaultRuntimeId: 'claude-agent-sdk' });

  const project = newProject('selection-http');
  return { app, projectId: project.id };
}

test('POST /api/projects/:id/runtime with a valid model + effort applies it and returns the session selection', async () => {
  freshDb();
  const { app, projectId } = fakeSelectionApp();

  const res = await app.request(`/api/projects/${projectId}/runtime`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ runtimeId: 'claude-agent-sdk', model: 'sonnet', effort: 'high' }),
  });
  assert.equal(res.status, 200);
  const json = await res.json() as {
    switched: boolean;
    session: { selection: { runtimeId: string; accountId: string; model: string; effort: unknown } } | null;
  };
  assert.equal(json.switched, true);
  assert.deepEqual(json.session?.selection, {
    runtimeId: 'claude-agent-sdk',
    accountId: 'personal',
    model: 'sonnet',
    effort: { kind: 'selected', value: 'high' },
  });
});

test('POST /api/projects/:id/runtime rejects an unsupported model with a typed 422', async () => {
  freshDb();
  const { app, projectId } = fakeSelectionApp();

  const res = await app.request(`/api/projects/${projectId}/runtime`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ runtimeId: 'claude-agent-sdk', model: 'not-a-real-model' }),
  });
  assert.equal(res.status, 422);
  assert.deepEqual(await res.json(), { error: { code: 'model-unsupported' } });
});

test('POST /api/projects/:id/runtime rejects an unsupported effort value with a typed 422', async () => {
  freshDb();
  const { app, projectId } = fakeSelectionApp();

  const res = await app.request(`/api/projects/${projectId}/runtime`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ runtimeId: 'claude-agent-sdk', model: 'opus', effort: 'ultra-high' }),
  });
  assert.equal(res.status, 422);
  assert.deepEqual(await res.json(), { error: { code: 'effort-value-unsupported' } });
});

test('POST /api/projects/:id/runtime with a runtimeId-only body stays backward compatible', async () => {
  freshDb();
  const { app, projectId } = fakeSelectionApp();

  const res = await app.request(`/api/projects/${projectId}/runtime`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ runtimeId: 'openai-codex' }),
  });
  assert.equal(res.status, 200);
  const json = await res.json() as {
    runtimeId: string;
    switched: boolean;
    session: { selection: { runtimeId: string; model: string; effort: unknown } } | null;
  };
  assert.equal(json.runtimeId, 'openai-codex');
  assert.equal(json.switched, true);
  assert.equal(json.session?.selection.runtimeId, 'openai-codex');
  assert.equal(json.session?.selection.model, 'opus');
  assert.deepEqual(json.session?.selection.effort, { kind: 'none' });
});
