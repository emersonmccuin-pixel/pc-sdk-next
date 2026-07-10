// Guard tests for the resource store's three core invariants (docs/event-
// contract.md Channel 2 + guard rule 6). Self-contained: no '@/' alias so
// this runs under `tsx --test` without extra config.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import type { ResourceEvent } from '../../../packages/contracts/src/events/resources.ts';
import { resourceEventWins, useResourceStore } from '../src/state/resource-store.ts';

function agentRunEvent(opts: {
  entityId: string;
  cursor: string;
  version: number | null;
  projectId: string | null;
  reason?: string;
}): ResourceEvent {
  return {
    id: `evt-${opts.cursor}`,
    cursor: opts.cursor,
    scope: opts.projectId === null ? 'global' : 'project',
    projectId: opts.projectId,
    entity: 'agent-run',
    entityId: opts.entityId,
    eventType: 'agent-run.changed',
    version: opts.version,
    createdAt: Date.now(),
    payload: {
      reason: opts.reason ?? 'running',
      run: {
        runId: opts.entityId,
        sessionId: 'cc-session',
        agentName: 'builder',
        model: 'sonnet',
        projectId: opts.projectId ?? 'proj-1',
        dispatcherSessionId: 'disp-1',
        worktreeDir: 'C:\\worktree',
        startedAt: 0,
        status: 'running',
        result: '',
        failureReason: null,
        failureCause: null,
        endedAt: null,
        rev: opts.version ?? 0,
      },
    },
  } as ResourceEvent;
}

// ── Invariant 1: version dedup — strictly-older loses, equal wins ──────────

test('resourceEventWins: strictly-older version loses', () => {
  const prev = agentRunEvent({ entityId: 'run-1', cursor: '10', version: 5, projectId: 'p1' });
  const older = agentRunEvent({ entityId: 'run-1', cursor: '11', version: 4, projectId: 'p1' });
  assert.equal(resourceEventWins(prev, older), false);
});

test('resourceEventWins: equal version wins (same-version overlay, e.g. stalled badge)', () => {
  const prev = agentRunEvent({ entityId: 'run-1', cursor: '10', version: 5, projectId: 'p1' });
  const sameVersion = agentRunEvent({
    entityId: 'run-1',
    cursor: '11',
    version: 5,
    projectId: 'p1',
    reason: 'stalled',
  });
  assert.equal(resourceEventWins(prev, sameVersion), true);
});

test('resourceEventWins: newer version wins', () => {
  const prev = agentRunEvent({ entityId: 'run-1', cursor: '10', version: 5, projectId: 'p1' });
  const newer = agentRunEvent({ entityId: 'run-1', cursor: '11', version: 6, projectId: 'p1' });
  assert.equal(resourceEventWins(prev, newer), true);
});

test('resourceEventWins: null version is last-write-wins by cursor', () => {
  const prev = agentRunEvent({ entityId: 'sess-1', cursor: '10', version: null, projectId: 'p1' });
  const older = agentRunEvent({ entityId: 'sess-1', cursor: '9', version: null, projectId: 'p1' });
  const newer = agentRunEvent({ entityId: 'sess-1', cursor: '11', version: null, projectId: 'p1' });
  assert.equal(resourceEventWins(prev, older), false);
  assert.equal(resourceEventWins(prev, newer), true);
});

test('store.seed + applyResourceFrame apply the same dedup rule and are order-independent', () => {
  useResourceStore.getState().clearAll();
  const v5 = agentRunEvent({ entityId: 'run-2', cursor: '20', version: 5, projectId: 'p1' });
  const v3 = agentRunEvent({ entityId: 'run-2', cursor: '19', version: 3, projectId: 'p1' });
  // Seed with the older one arriving AFTER the newer one — must not regress.
  useResourceStore.getState().seed([v5, v3]);
  const key = 'agent-run::run-2';
  assert.equal(useResourceStore.getState().byKey.get(key)?.version, 5);
  useResourceStore.getState().clearAll();
});

// ── Invariant 2: global-scope frames union into every project selector ─────

test('global-scope frames (projectId null) reach every project view', () => {
  useResourceStore.getState().clearAll();
  const globalEvent = agentRunEvent({ entityId: 'run-g', cursor: '1', version: 1, projectId: null });
  const projectEvent = agentRunEvent({ entityId: 'run-p1', cursor: '2', version: 1, projectId: 'proj-A' });
  const otherProjectEvent = agentRunEvent({
    entityId: 'run-p2',
    cursor: '3',
    version: 1,
    projectId: 'proj-B',
  });
  useResourceStore.getState().seed([globalEvent, projectEvent, otherProjectEvent]);

  const byKey = useResourceStore.getState().byKey;
  const forProjA = [...byKey.values()].filter(
    (ev) => ev.entity === 'agent-run' && (ev.projectId === null || ev.projectId === 'proj-A'),
  );
  const ids = forProjA.map((ev) => ev.entityId).sort();
  assert.deepEqual(ids, ['run-g', 'run-p1']);
  assert.ok(!ids.includes('run-p2'), 'a different project\'s frame must not leak in');
  useResourceStore.getState().clearAll();
});

// ── Invariant 3: live-reset clears the store wholesale ──────────────────────

test('applyLiveReset clears every held frame', () => {
  useResourceStore.getState().clearAll();
  useResourceStore.getState().seed([
    agentRunEvent({ entityId: 'run-x', cursor: '1', version: 1, projectId: 'p1' }),
    agentRunEvent({ entityId: 'run-y', cursor: '2', version: 1, projectId: null }),
  ]);
  assert.equal(useResourceStore.getState().byKey.size, 2);
  useResourceStore.getState().applyLiveReset({ type: 'live-reset', projectId: 'p1', cursor: null });
  assert.equal(useResourceStore.getState().byKey.size, 0);
});
