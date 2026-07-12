import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

import { TranscriptRow } from '../src/components/TranscriptRow.tsx';
import { PhaseReceiptDetails } from '../src/components/AgentTranscriptModal.tsx';
import {
  parseAgentRunEventsResponse,
  type AgentRunEventEntry,
} from '../src/features/agent-runs/client.ts';
import { mergeAgentTranscriptEvents } from '../src/features/agent-runs/transcript.ts';
import type { AgentEventFrame } from '@pc/contracts';

const ENTRY = {
  dedupId: 'event-1',
  event: { kind: 'assistant-text', text: 'safe', midLoop: false },
} as const;

test('agent transcript HTTP backfill accepts only strict canonical events', () => {
  const parsed = parseAgentRunEventsResponse({
    events: [ENTRY],
    transcriptStatus: 'ready',
    status: 'running',
  });
  assert.equal(parsed.events.length, 1);

  assert.throws(() => parseAgentRunEventsResponse({
    events: [{ ...ENTRY, raw: 'SECRET' }],
    transcriptStatus: 'ready',
    status: 'running',
  }), /invalid agent transcript response/);
  assert.throws(() => parseAgentRunEventsResponse({
    events: [{ ...ENTRY, event: { ...ENTRY.event, rawThinking: 'SECRET' } }],
    transcriptStatus: 'ready',
    status: 'running',
  }), /invalid agent transcript response/);
  assert.throws(() => parseAgentRunEventsResponse({
    events: [ENTRY],
    transcriptStatus: 'ready',
    status: 'running',
    nativeSession: 'SECRET',
  }), /invalid agent transcript response/);
});

test('agent transcript merge drops malformed backfill and live entries defensively', () => {
  const hostileBackfill = {
    dedupId: 'hostile-http',
    event: { kind: 'assistant-text', text: 'unsafe', midLoop: false, rawThinking: 'SECRET' },
  } as unknown as AgentRunEventEntry;
  const hostileLive = {
    type: 'agent-event',
    projectId: 'project-1',
    runId: 'run-1',
    dedupId: 'hostile-live',
    event: { kind: 'assistant-text', text: 'unsafe', midLoop: false, rawThinking: 'SECRET' },
  } as unknown as AgentEventFrame;
  const merged = mergeAgentTranscriptEvents({
    runId: 'run-1',
    backfillEvents: [ENTRY as AgentRunEventEntry, hostileBackfill],
    liveEvents: [hostileLive],
  });
  assert.deepEqual(merged.map((item) => item.key), ['event-1']);
});

test('transcript renderer never serializes malformed or internal envelope payloads', () => {
  const malformed = renderToStaticMarkup(createElement(TranscriptRow, {
    event: { kind: 'unknown', raw: 'SECRET_MALFORMED' },
  }));
  const internalEnvelope = renderToStaticMarkup(createElement(TranscriptRow, {
    event: {
      kind: 'agent-envelope',
      runId: 'run-1',
      agentName: 'reviewer',
      status: 'done',
      summary: 'safe summary',
      detail: 'safe detail',
      envelope: 'SECRET_INTERNAL_ENVELOPE',
    },
  }));
  assert.equal(malformed, '');
  assert.equal(internalEnvelope, '');
});

test('context telemetry stays in the session bar and unknown compaction renders honestly', () => {
  const context = renderToStaticMarkup(createElement(TranscriptRow, {
    event: {
      kind: 'context-observation', confidence: 'exact',
      usedTokens: 10, usableTokens: 100, contextWindowTokens: 120,
    },
  }));
  assert.equal(context, '');

  const compaction = renderToStaticMarkup(createElement(TranscriptRow, {
    event: { kind: 'compaction', trigger: 'unknown', preTokens: null, postTokens: null },
  }));
  assert.match(compaction, /compaction/);
  assert.match(compaction, /token counts unavailable/);
  assert.doesNotMatch(compaction, /auto|0 →/);

  const beforeOnly = renderToStaticMarkup(createElement(TranscriptRow, {
    event: { kind: 'compaction', trigger: 'unknown', preTokens: 80, postTokens: null },
  }));
  const afterOnly = renderToStaticMarkup(createElement(TranscriptRow, {
    event: { kind: 'compaction', trigger: 'unknown', preTokens: null, postTokens: 20 },
  }));
  assert.match(beforeOnly, /80 → … tokens/);
  assert.match(afterOnly, /… → 20 tokens/);
});

test('phase receipts distinguish executed evidence from an explicit positive no-op', () => {
  const executed = renderToStaticMarkup(createElement(PhaseReceiptDetails, {
    phase: 'readiness',
    applicable: true,
    receipt: {
      phase: 'readiness',
      outcome: 'executed',
      ok: true,
      steps: [{
        command: 'pnpm test',
        exitCode: 0,
        durationMs: 25,
        stdoutTail: 'passed',
        stderrTail: '',
        timedOut: false,
      }],
      finishedAt: 10,
    },
  }));
  assert.match(executed, /readiness/);
  assert.match(executed, /ok/);
  assert.match(executed, /1 step/);
  assert.match(executed, /pnpm test/);

  const noOp = renderToStaticMarkup(createElement(PhaseReceiptDetails, {
    phase: 'preparation',
    applicable: true,
    receipt: {
      phase: 'preparation',
      outcome: 'not-required',
      reason: 'existing-worktree-preparation',
      inheritedFromRunId: '01J00000000000000000000000',
      ok: true,
      steps: [],
      finishedAt: 11,
    },
  }));
  assert.match(noOp, /not required/);
  assert.match(noOp, /existing worktree reused from parent 01J00000/);
  assert.doesNotMatch(noOp, /0 steps/);

  const unavailable = renderToStaticMarkup(createElement(PhaseReceiptDetails, {
    phase: 'readiness', applicable: true, receipt: null,
  }));
  assert.match(unavailable, /readiness/);
  assert.match(unavailable, /unavailable/);
  assert.equal(renderToStaticMarkup(createElement(PhaseReceiptDetails, {
    phase: 'readiness', applicable: false, receipt: null,
  })), '', 'non-repo and detached-review phases remain not applicable');
});
