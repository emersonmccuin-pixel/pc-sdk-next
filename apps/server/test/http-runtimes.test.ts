// /api/runtimes — provider-neutral runtime + account availability listing.
// Exercised against fake adapters (no real provider/process involved) so the
// route's shape and degrade-on-error behavior stay covered without a live
// Codex/Claude dependency.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Hono } from 'hono';
import { mountRuntimes } from '../src/http/runtimes.ts';
import { AccountRegistry } from '../src/runner/account-env.ts';
import {
  RuntimeRegistry,
  type AgentRuntimeAdapter,
  type CreateRuntimeSession,
  type ResumeRuntimeSession,
  type RuntimeSession,
} from '../src/runner/runtime.ts';
import { testCapabilities, testSubscriptionQuotaUnavailable } from './runtime-fixtures.ts';

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
  constructor(
    readonly id: string,
    private readonly capsById: Map<string, 'throw'> = new Map(),
  ) {}

  async capabilities(accountId: string) {
    if (this.capsById.get(accountId) === 'throw') throw new Error('discovery unavailable');
    return testCapabilities(this.id, accountId);
  }

  async listModels() {
    return { status: 'available' as const, models: [] };
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
  return new AccountRegistry([
    { id: 'personal', runtimeId: 'claude-agent-sdk', configDir: 'C:/home/.claude' },
    { id: 'work', runtimeId: 'claude-agent-sdk', configDir: 'C:/home/.claude-work' },
    { id: 'personal', runtimeId: 'openai-codex', configDir: 'C:/home/.codex' },
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
