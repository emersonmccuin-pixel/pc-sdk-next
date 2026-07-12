import { test } from 'node:test';
import assert from 'node:assert/strict';

import type { AgentRunDto } from '../../../packages/contracts/src/agent-runs.ts';
import {
  parseAgentRunEventsResponse,
  parseAgentRunListResponse,
} from '../src/features/agent-runs/client.ts';
import { overlayAgentRunPayloads } from '../src/features/agent-runs/use-project-agent-runs.ts';

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

  assert.deepEqual(parseAgentRunListResponse({ ok: true, runs: [modern, legacy] }), [modern, legacy]);
});

test('agent-run list rejects native identity leaks and inconsistent provenance', () => {
  assert.throws(
    () => parseAgentRunListResponse({ ok: true, runs: [{ ...run(), nativeSessionId: 'native-secret' }] }),
    /invalid agent run list response/,
  );
  assert.throws(
    () => parseAgentRunListResponse({ ok: true, runs: [run()], nativeSessionId: 'native-secret' }),
    /invalid agent run list response/,
  );
  assert.throws(
    () => parseAgentRunListResponse({
      ok: true,
      runs: [run({ nativeSessionIdPresent: false, continuationState: 'native-resumed' })],
    }),
    /invalid agent run list response/,
  );
  assert.throws(
    () => parseAgentRunListResponse({
      ok: true,
      runs: [run({ selection: null, specialistRevision: null, continuationState: 'clean-pending' })],
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
