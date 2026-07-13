import { test } from 'node:test';
import assert from 'node:assert/strict';

import type { AgentRunDto } from '../../../packages/contracts/src/agent-runs.ts';
import {
  parseAgentRunEventsResponse,
  parseAgentRunListResponse,
} from '../src/features/agent-runs/client.ts';
import {
  isRecoveryTerminalRun,
  overlayAgentRunPayloads,
} from '../src/features/agent-runs/use-project-agent-runs.ts';

function run(overrides: Partial<AgentRunDto> = {}): AgentRunDto {
  return {
    runId: 'run-1',
    agentName: 'researcher',
    selection: {
      runtimeId: 'claude-agent-sdk',
      accountId: 'personal',
      model: 'claude-opus',
      effort: { kind: 'selected', value: 'high' },
    },
    specialistRevision: 'sha256:abc',
    nativeSessionIdPresent: true,
    continuationState: 'clean-started',
    projectId: 'project-1',
    dispatcherSessionId: 'session-1',
    worktreeDir: '',
    startedAt: 1,
    status: 'running',
    lifecycleState: null,
    result: '',
    failureReason: null,
    failureCause: null,
    endedAt: null,
    rev: 2,
    ...overrides,
  };
}

test('agent-run list accepts exact stamped and quarantined legacy projections', () => {
  const modern = run();
  const legacy = run({
    selection: null,
    specialistRevision: null,
    nativeSessionIdPresent: false,
    continuationState: 'legacy-unavailable',
  });

  assert.deepEqual(
    parseAgentRunListResponse({ ok: true, runs: [modern, legacy], asOfCursor: '42' }),
    { runs: [modern, legacy], asOfCursor: '42' },
  );
});

test('agent-run list rejects native identity leaks and inconsistent provenance', () => {
  assert.throws(
    () => parseAgentRunListResponse({ ok: true, runs: [{ ...run(), nativeSessionId: 'native-secret' }], asOfCursor: '1' }),
    /invalid agent run list response/,
  );
  assert.throws(
    () => parseAgentRunListResponse({ ok: true, runs: [run()], asOfCursor: '1', nativeSessionId: 'native-secret' }),
    /invalid agent run list response/,
  );
  assert.throws(
    () => parseAgentRunListResponse({
      ok: true,
      runs: [run({ nativeSessionIdPresent: false, continuationState: 'native-resumed' })],
      asOfCursor: '1',
    }),
    /invalid agent run list response/,
  );
  assert.throws(
    () => parseAgentRunListResponse({
      ok: true,
      runs: [run({ selection: null, specialistRevision: null, continuationState: 'clean-pending' })],
      asOfCursor: '1',
    }),
    /invalid agent run list response/,
  );
  assert.throws(
    () => parseAgentRunListResponse({ runs: [run()] }),
    /invalid agent run list response/,
  );
});

test('agent transcript response rejects native identity extras at every owned seam', () => {
  const event = {
    kind: 'assistant-text',
    text: 'safe',
    midLoop: false,
  };
  const response = {
    events: [{ dedupId: 'event-1', event }],
    transcriptStatus: 'ready',
    status: 'running',
  };

  assert.deepEqual(parseAgentRunEventsResponse(response), response);
  assert.throws(
    () => parseAgentRunEventsResponse({ ...response, nativeSessionId: 'native-secret' }),
    /invalid agent transcript response/,
  );
  assert.throws(
    () => parseAgentRunEventsResponse({
      ...response,
      events: [{ ...response.events[0], nativeSessionId: 'native-secret' }],
    }),
    /invalid agent transcript response/,
  );
});

test('new HTTP seed cannot regress behind a retained pre-reconnect live frame', () => {
  const durable = run({ rev: 5, status: 'running' });
  const stale = run({ rev: 3, status: 'cancelled', endedAt: 3 });
  const projected = overlayAgentRunPayloads(
    [durable],
    [{ reason: 'cancelled', run: stale }],
  );
  assert.equal(projected.runs.length, 1);
  assert.equal(projected.runs[0]?.rev, 5);

  const stalled = overlayAgentRunPayloads(
    [durable],
    [{ reason: 'stalled', run: durable }],
  );
  assert.equal(stalled.runs[0]?.stalled, true, 'equal-revision badge overlays remain legal');
});

test('terminal HTTP seed remains a tombstone against retained stale active resources', () => {
  const terminal = run({
    rev: 5,
    status: 'completed',
    endedAt: 5,
    lifecycleState: null,
  });
  const staleActive = run({ rev: 3, status: 'running', endedAt: null });
  const projected = overlayAgentRunPayloads(
    [terminal],
    [{ reason: 'running', run: staleActive }],
  );

  assert.deepEqual(projected, { runs: [], preserved: [] });
});

test('newer terminal live payload remains a tombstone against later stale active payloads', () => {
  const terminal = run({
    rev: 5,
    status: 'completed',
    endedAt: 5,
    lifecycleState: null,
  });
  const staleActive = run({ rev: 3, status: 'running', endedAt: null });
  const projected = overlayAgentRunPayloads(
    [],
    [
      { reason: 'completed', run: terminal },
      { reason: 'running', run: staleActive },
    ],
  );

  assert.deepEqual(projected, { runs: [], preserved: [] });
});

test('bounded recent failures and cancellations remain visible recovery truth', () => {
  const failed = run({
    runId: 'failed-run',
    status: 'failed',
    endedAt: 5,
    lifecycleState: 'provisioning-failed',
    failureCause: 'worktree-provision-failed',
    failureReason: 'preparation command failed',
  });
  const cancelled = run({
    runId: 'cancelled-run',
    status: 'cancelled',
    endedAt: 6,
    lifecycleState: 'cancelled',
    failureCause: 'cancelled',
    failureReason: 'cancelled by user',
  });
  const projected = overlayAgentRunPayloads([failed, cancelled], []);

  assert.deepEqual(projected.runs, []);
  assert.deepEqual(projected.preserved.map((item) => item.runId), ['failed-run', 'cancelled-run']);
});

test('bounded successful reviewer stays available for settled checkout inspection only', () => {
  const reviewer = run({
    agentName: 'contract-reviewer',
    status: 'completed',
    endedAt: 5,
  });
  const ordinary = run({
    runId: 'ordinary-success',
    status: 'completed',
    endedAt: 5,
  });
  const projected = overlayAgentRunPayloads([reviewer, ordinary], []);
  assert.deepEqual(projected.runs, []);
  assert.deepEqual(projected.preserved.map((item) => item.runId), [reviewer.runId]);
  assert.equal(isRecoveryTerminalRun(reviewer), false, 'settled review evidence is not a recovery failure');
});

test('a failed terminal stays visible while tombstoning stale running resource frames', () => {
  const terminal = run({
    rev: 5,
    status: 'failed',
    endedAt: 5,
    lifecycleState: 'failed',
    failureCause: 'server-restart',
    failureReason: 'server restarted while the run was live',
  });
  const staleActive = run({ rev: 3, status: 'running', endedAt: null });
  const projected = overlayAgentRunPayloads(
    [terminal],
    [{ reason: 'running', run: staleActive }],
  );

  assert.deepEqual(projected.runs, []);
  assert.equal(projected.preserved[0]?.status, 'failed');
  assert.equal(projected.preserved[0]?.failureCause, 'server-restart');
});

test('equal-revision activity cannot resurrect a terminal HTTP seed', () => {
  const terminal = run({
    rev: 5,
    status: 'failed',
    endedAt: 5,
    lifecycleState: 'failed',
    failureCause: 'server-restart',
  });
  const contradictoryActive = run({ rev: 5, status: 'running', endedAt: null });
  const projected = overlayAgentRunPayloads(
    [terminal],
    [{ reason: 'running', run: contradictoryActive }],
  );
  assert.deepEqual(projected.runs, []);
  assert.equal(projected.preserved[0]?.status, 'failed');
});

test('merge-ready retention supports transcript lookup but is not recovery failure truth', () => {
  const mergeReady = run({
    status: 'completed',
    endedAt: 5,
    lifecycleState: 'merge-ready',
  });
  assert.equal(isRecoveryTerminalRun(mergeReady), false);
  assert.equal(isRecoveryTerminalRun(mergeReady, 'landed'), true, 'landed cleanup crash state remains recovery truth');
  assert.equal(overlayAgentRunPayloads([mergeReady], []).preserved.length, 1);
});

test('authoritative HTTP omission prevents an old terminal live frame from resurrecting', () => {
  const resolved = run({
    status: 'failed',
    endedAt: 10,
    lifecycleState: 'failed',
    failureCause: 'server-restart',
  });
  assert.deepEqual(
    overlayAgentRunPayloads([], [{ reason: 'failed', run: resolved, resourceCursor: '20' }], '20'),
    { runs: [], preserved: [] },
  );

  const completedDuringRead = run({ ...resolved, runId: 'new-terminal', endedAt: 21 });
  assert.equal(
    overlayAgentRunPayloads(
      [],
      [{ reason: 'failed', run: completedDuringRead, resourceCursor: '21' }],
      '20',
    ).preserved[0]?.runId,
    'new-terminal',
  );
});

test('authoritative HTTP omission also tombstones an old active live frame', () => {
  const staleRunning = run({ status: 'running', endedAt: null, rev: 1 });
  assert.deepEqual(
    overlayAgentRunPayloads(
      [],
      [{ reason: 'running', run: staleRunning, resourceCursor: '19' }],
      '20',
    ),
    { runs: [], preserved: [] },
  );
});

test('agent-run list requires the server outbox high-water', () => {
  assert.throws(
    () => parseAgentRunListResponse({ ok: true, runs: [run()] }),
    /invalid agent run list response/,
  );
  assert.throws(
    () => parseAgentRunListResponse({ ok: true, runs: [run()], asOfCursor: 'not-a-cursor' }),
    /invalid agent run list response/,
  );
  assert.deepEqual(
    parseAgentRunListResponse({ ok: true, runs: [], asOfCursor: null }),
    { runs: [], asOfCursor: null },
  );
});

test('terminal landed-cleanup lifecycle windows remain visible', () => {
  for (const lifecycleState of ['merging', 'merged', 'tearing-down'] as const) {
    const cleanup = run({ status: 'completed', endedAt: 5, lifecycleState });
    assert.equal(overlayAgentRunPayloads([cleanup], []).preserved.length, 1, lifecycleState);
    assert.equal(isRecoveryTerminalRun(cleanup), true, lifecycleState);
  }
});
