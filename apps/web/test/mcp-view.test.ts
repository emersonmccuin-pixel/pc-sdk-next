// Guard tests for the MCP-manager pure view logic
// (apps/web/src/features/mcp/view.ts): health presentation never hides a bad
// state, live health overlay never regresses a fresher fetch, and the
// client-side transport form validation mirrors the server's rule.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import type { ResourceEvent } from '@pc/contracts';
import type { McpHealthState } from '@pc/domain';
import type { McpServerDto } from '../src/features/mcp/types.ts';
import {
  healthLabel,
  healthReasonText,
  healthSeverityRank,
  healthTone,
  overlayMcpHealth,
  parseTransportForm,
  secretStatusLabel,
  sortServersBySeverity,
  transportSummary,
} from '../src/features/mcp/view.ts';

function server(overrides: Partial<McpServerDto> & { id: string }): McpServerDto {
  return {
    scope: 'global',
    projectId: null,
    name: overrides.id,
    description: '',
    enabled: true,
    transport: { url: 'https://example/mcp' },
    health: {
      state: 'unknown',
      reason: null,
      lastProbeAt: null,
      lastOkProbeAt: null,
      toolCount: null,
      lastError: null,
      consecutiveFailures: 0,
    },
    tools: [],
    secret: { present: false, authState: null, expiresAt: null, expired: false },
    consumers: ['orchestrator'],
    rev: 1,
    createdAt: 0,
    updatedAt: 0,
    ...overrides,
  };
}

function mcpEvent(entityId: string, version: number, status: {
  status: McpHealthState;
  reason: string | null;
  lastProbeAt: number | null;
  lastOkProbeAt: number | null;
  toolCount: number | null;
  lastError: string | null;
}): ResourceEvent {
  return {
    id: `evt-${entityId}-${version}`,
    cursor: String(version),
    scope: 'global',
    projectId: null,
    entity: 'mcp-server',
    entityId,
    eventType: 'mcp-server.changed',
    version,
    createdAt: 0,
    payload: { server: { id: entityId, name: entityId, ...status } },
  };
}

test('healthLabel/healthTone: every state gets an explicit, never-guessed label', () => {
  const states: McpHealthState[] = ['healthy', 'degraded', 'down', 'auth-expired', 'unknown'];
  for (const s of states) {
    assert.ok(healthLabel(s).length > 0);
  }
  assert.equal(healthTone('healthy'), 'ok');
  assert.equal(healthTone('degraded'), 'warn');
  assert.equal(healthTone('down'), 'error');
  assert.equal(healthTone('auth-expired'), 'error');
  assert.equal(healthTone('unknown'), 'neutral');
});

test('sortServersBySeverity: actionable states surface before healthy ones', () => {
  const healthy = server({ id: 'z-healthy', health: { state: 'healthy', reason: null, lastProbeAt: 1, lastOkProbeAt: 1, toolCount: 3, lastError: null, consecutiveFailures: 0 } });
  const down = server({ id: 'a-down', health: { state: 'down', reason: 'connection refused', lastProbeAt: 1, lastOkProbeAt: null, toolCount: null, lastError: 'ECONNREFUSED', consecutiveFailures: 5 } });
  const authExpired = server({ id: 'm-auth', health: { state: 'auth-expired', reason: 'token expired', lastProbeAt: 1, lastOkProbeAt: 1, toolCount: 2, lastError: null, consecutiveFailures: 1 } });
  const degraded = server({ id: 'q-degraded', health: { state: 'degraded', reason: 'flapping', lastProbeAt: 1, lastOkProbeAt: 1, toolCount: 2, lastError: null, consecutiveFailures: 2 } });
  const out = sortServersBySeverity([healthy, down, authExpired, degraded]);
  assert.deepEqual(out.map((s) => s.id), ['m-auth', 'a-down', 'q-degraded', 'z-healthy']);
  assert.equal(healthSeverityRank('auth-expired') < healthSeverityRank('down'), true);
});

test('healthReasonText: verbatim last error wins for a non-healthy state; falls back to the state reason', () => {
  const withError = server({ id: 's1', health: { state: 'down', reason: 'sustained failure', lastProbeAt: 1, lastOkProbeAt: null, toolCount: null, lastError: 'fetch failed: ECONNREFUSED', consecutiveFailures: 4 } });
  assert.equal(healthReasonText(withError), 'fetch failed: ECONNREFUSED');

  const reasonOnly = server({ id: 's2', health: { state: 'auth-expired', reason: 'stored credential expired', lastProbeAt: null, lastOkProbeAt: null, toolCount: null, lastError: null, consecutiveFailures: 0 } });
  assert.equal(healthReasonText(reasonOnly), 'stored credential expired');

  const healthy = server({ id: 's3', health: { state: 'healthy', reason: null, lastProbeAt: 1, lastOkProbeAt: 1, toolCount: 4, lastError: null, consecutiveFailures: 0 } });
  assert.equal(healthReasonText(healthy), null);
});

test('overlayMcpHealth: a fresh live event updates health without touching transport/consumers', () => {
  const seed = server({ id: 'a', rev: 3, transport: { command: 'node' }, consumers: ['orchestrator', 'agent:researcher'] });
  const ev = mcpEvent('a', 4, { status: 'down', reason: 'sustained failure', lastProbeAt: 100, lastOkProbeAt: 50, toolCount: null, lastError: 'timeout' });
  const [out] = overlayMcpHealth([seed], [ev]);
  assert.equal(out.health.state, 'down');
  assert.equal(out.health.lastError, 'timeout');
  assert.equal(out.rev, 4);
  assert.deepEqual(out.transport, { command: 'node' });
  assert.deepEqual(out.consumers, ['orchestrator', 'agent:researcher']);
});

test('overlayMcpHealth: a stale live event never regresses a fresher fetch', () => {
  const seed = server({ id: 'a', rev: 10, health: { state: 'healthy', reason: null, lastProbeAt: 200, lastOkProbeAt: 200, toolCount: 5, lastError: null, consecutiveFailures: 0 } });
  const stale = mcpEvent('a', 3, { status: 'down', reason: 'old failure', lastProbeAt: 10, lastOkProbeAt: null, toolCount: null, lastError: 'old error' });
  const [out] = overlayMcpHealth([seed], [stale]);
  assert.equal(out.health.state, 'healthy');
  assert.equal(out.rev, 10);
});

test('overlayMcpHealth: an event for an unknown server id is ignored', () => {
  const seed = server({ id: 'a' });
  const ev = mcpEvent('other', 5, { status: 'down', reason: 'r', lastProbeAt: 1, lastOkProbeAt: null, toolCount: null, lastError: 'e' });
  const [out] = overlayMcpHealth([seed], [ev]);
  assert.equal(out.health.state, 'unknown');
});

test('parseTransportForm: exactly one of url/command; rejects both and neither', () => {
  assert.deepEqual(parseTransportForm({ url: 'https://x/mcp', command: '' }), {
    ok: true,
    transport: { url: 'https://x/mcp' },
  });
  assert.deepEqual(parseTransportForm({ url: '', command: 'node server.js' }), {
    ok: true,
    transport: { command: 'node server.js' },
  });
  assert.equal(parseTransportForm({ url: '', command: '' }).ok, false);
  assert.equal(parseTransportForm({ url: 'https://x', command: 'y' }).ok, false);
});

test('transportSummary + secretStatusLabel: human-readable, never leak a secret value', () => {
  assert.equal(transportSummary({ url: 'https://x/mcp' }), 'HTTP → https://x/mcp');
  assert.equal(transportSummary({ command: 'node server.js' }), 'stdio → node server.js');
  assert.equal(transportSummary({}), 'unconfigured');

  assert.equal(secretStatusLabel(server({ id: 's', secret: { present: false, authState: null, expiresAt: null, expired: false } })), 'No secret set');
  assert.equal(secretStatusLabel(server({ id: 's', secret: { present: true, authState: 'connected', expiresAt: null, expired: false } })), 'Set');
  assert.equal(secretStatusLabel(server({ id: 's', secret: { present: true, authState: 'expired', expiresAt: 1, expired: true } })), 'Expired');
  assert.equal(secretStatusLabel(server({ id: 's', secret: { present: true, authState: 'needs-auth', expiresAt: null, expired: false } })), 'Needs auth');
});
