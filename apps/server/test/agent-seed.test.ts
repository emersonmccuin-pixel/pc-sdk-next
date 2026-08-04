// Stock-agent seed guards: idempotent boot, authoritative drift-reseed for the
// specialists, insert-only survival for orchestrator edits, and reset-to-default.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { getAgentByName, updateAgent } from '@pc/db';
import { seedStockAgents, resetAgentToSeed } from '../src/agents/seed.ts';
import { ORCHESTRATOR_AGENT_CONTENT, STOCK_AGENT_CONTENT } from '../src/agents/stock-agent-content.ts';
import { freshDb } from './helpers.ts';

const audit = { actor: 'user' as const };

test('fresh boot seeds orchestrator + 6 specialists; second boot no-ops', () => {
  freshDb();
  const first = seedStockAgents();
  assert.equal(first.inserted, 1 + STOCK_AGENT_CONTENT.length);
  assert.equal(first.reseeded, 0);

  for (const content of [ORCHESTRATOR_AGENT_CONTENT, ...STOCK_AGENT_CONTENT]) {
    const row = getAgentByName({ name: content.name, scope: 'global' });
    assert.ok(row, `${content.name} seeded`);
    assert.equal(row!.origin, 'stock');
    assert.equal(row!.scope, 'global');
  }

  const second = seedStockAgents();
  assert.equal(second.inserted, 0);
  assert.equal(second.reseeded, 0);
  assert.equal(second.unchanged, 1 + STOCK_AGENT_CONTENT.length);
});

test('drifted specialist field is reseeded on the next boot (authoritative)', () => {
  freshDb();
  seedStockAgents();
  const researcher = getAgentByName({ name: 'researcher', scope: 'global' })!;
  updateAgent(researcher.id, { prompt: 'hand-hacked prompt' }, audit);

  const summary = seedStockAgents();
  assert.equal(summary.reseeded, 1);
  const healed = getAgentByName({ name: 'researcher', scope: 'global' })!;
  assert.notEqual(healed.prompt, 'hand-hacked prompt');
  assert.equal(healed.prompt, STOCK_AGENT_CONTENT.find((c) => c.name === 'researcher')!.prompt);
});

test('orchestrator edits survive boots (insert-only); reset restores the seed', () => {
  freshDb();
  seedStockAgents();
  const orch = getAgentByName({ name: 'orchestrator', scope: 'global' })!;
  updateAgent(orch.id, { prompt: 'my customized orchestrator prompt', model: 'haiku' }, audit);

  const summary = seedStockAgents();
  assert.equal(summary.reseeded, 0, 'orchestrator must never be drift-reseeded');
  const kept = getAgentByName({ name: 'orchestrator', scope: 'global' })!;
  assert.equal(kept.prompt, 'my customized orchestrator prompt');
  assert.equal(kept.model, 'haiku');

  const resetFields = resetAgentToSeed(kept);
  assert.ok(resetFields && resetFields.includes('prompt') && resetFields.includes('model'));
  const restored = getAgentByName({ name: 'orchestrator', scope: 'global' })!;
  assert.equal(restored.prompt, ORCHESTRATOR_AGENT_CONTENT.prompt);
  assert.equal(restored.model, 'sonnet');
});

test('resetAgentToSeed refuses non-seeded agents', () => {
  freshDb();
  seedStockAgents();
  const orch = getAgentByName({ name: 'orchestrator', scope: 'global' })!;
  assert.equal(resetAgentToSeed({ ...orch, name: 'not-a-seed' }), null);
  assert.equal(resetAgentToSeed({ ...orch, origin: 'user-created' }), null);
});

test('code-writer stock content carries a durable 100-turn budget', () => {
  const codeWriter = STOCK_AGENT_CONTENT.find((c) => c.name === 'code-writer')!;
  assert.equal(codeWriter.maxTurns, 100);
});

test('an existing install with a stale code-writer maxTurns converges to 100 on reboot', () => {
  freshDb();
  seedStockAgents();
  const codeWriter = getAgentByName({ name: 'code-writer', scope: 'global' })!;
  // Simulate a pre-existing row seeded before the budget was raised (or a
  // one-off runtime patch that a fresh reseed would otherwise stomp back down).
  updateAgent(codeWriter.id, { maxTurns: 30 }, audit);

  const summary = seedStockAgents();
  assert.equal(summary.reseeded, 1, 'authoritative reseed heals the stale maxTurns');
  const healed = getAgentByName({ name: 'code-writer', scope: 'global' })!;
  assert.equal(healed.maxTurns, 100);
});

// ── pc-sdk-15: model tiering ─────────────────────────────────────────────────

test('stock content moved off the expensive opus[1m] tier', () => {
  assert.equal(ORCHESTRATOR_AGENT_CONTENT.model, 'sonnet');
  const byName = (name: string) => STOCK_AGENT_CONTENT.find((c) => c.name === name)!;
  assert.equal(byName('researcher').model, 'sonnet');
  assert.equal(byName('planner').model, 'opus');
  assert.equal(byName('contract-reviewer').model, 'opus');
  for (const content of [ORCHESTRATOR_AGENT_CONTENT, ...STOCK_AGENT_CONTENT]) {
    assert.notEqual(content.model, 'opus[1m]', `${content.name} must not seed the retired opus[1m] tier`);
  }
});

test('a specialist row still holding the retired opus[1m] model heals via the existing authoritative reseed', () => {
  freshDb();
  seedStockAgents();
  for (const name of ['researcher', 'planner', 'contract-reviewer']) {
    const row = getAgentByName({ name, scope: 'global' })!;
    updateAgent(row.id, { model: 'opus[1m]' }, audit);
  }

  const summary = seedStockAgents();
  assert.equal(summary.reseeded, 3, 'each stale opus[1m] specialist reseeds');
  assert.equal(getAgentByName({ name: 'researcher', scope: 'global' })!.model, 'sonnet');
  assert.equal(getAgentByName({ name: 'planner', scope: 'global' })!.model, 'opus');
  assert.equal(getAgentByName({ name: 'contract-reviewer', scope: 'global' })!.model, 'opus');
});

test('an orchestrator row still holding the retired opus[1m] model migrates on the next boot without touching a customized prompt', () => {
  freshDb();
  seedStockAgents();
  const orch = getAgentByName({ name: 'orchestrator', scope: 'global' })!;
  // Simulate a pre-existing install seeded before this change, whose user
  // separately customized the prompt through the (orchestrator-only) UI edit
  // path — the retired-model upgrade must not touch that.
  updateAgent(orch.id, { model: 'opus[1m]', prompt: 'my customized orchestrator prompt' }, audit);

  const summary = seedStockAgents();
  assert.equal(summary.reseeded, 0, 'the orchestrator is still never drift-reseeded');
  const migrated = getAgentByName({ name: 'orchestrator', scope: 'global' })!;
  assert.equal(migrated.model, 'sonnet', 'the retired model value migrates to the current default');
  assert.equal(migrated.prompt, 'my customized orchestrator prompt', 'the unrelated customized prompt survives');
});

test('the retired-model upgrade never overrides an orchestrator model the user actually chose', () => {
  freshDb();
  seedStockAgents();
  const orch = getAgentByName({ name: 'orchestrator', scope: 'global' })!;
  updateAgent(orch.id, { model: 'haiku' }, audit);

  seedStockAgents();
  assert.equal(getAgentByName({ name: 'orchestrator', scope: 'global' })!.model, 'haiku');
});
