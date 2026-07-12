import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

import { TranscriptRow } from '../src/components/TranscriptRow.tsx';
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
