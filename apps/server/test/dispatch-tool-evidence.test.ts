import { test } from 'node:test';
import assert from 'node:assert/strict';
import { safeToolSummary, type ChatEvent, type ToolStateEvent } from '@pc/contracts';
import { executedToolCallsFromEvents } from '../src/dispatch/service.ts';

function tool(callId: string, name: string, state: ToolStateEvent['state']): ToolStateEvent {
  return {
    kind: 'tool-state',
    callId,
    name,
    state,
    safeSummary: safeToolSummary(name),
    approval: state === 'requested'
      ? { status: 'unknown', source: null, requestId: null }
      : { status: 'not-required', source: 'policy', requestId: null },
    outcome: state === 'failed' ? { reason: 'tool-error' } : null,
  };
}

test('executed tool evidence counts each canonical call once and excludes non-execution', () => {
  const events: ChatEvent[] = [
    tool('call-1', 'mcp__pc__pc_submit_deliverable', 'requested'),
    tool('call-1', 'mcp__pc__pc_submit_deliverable', 'running'),
    tool('call-1', 'mcp__pc__pc_submit_deliverable', 'succeeded'),
    tool('call-2', 'mcp__pc__pc_submit_deliverable', 'requested'),
    tool('call-2', 'mcp__pc__pc_submit_deliverable', 'running'),
    tool('call-denied', 'Bash', 'requested'),
    {
      ...tool('call-denied', 'Bash', 'requested'),
      state: 'denied',
      approval: { status: 'denied', source: 'user', requestId: 'approval-1' },
    },
    {
      ...tool('call-closed', 'Write', 'requested'),
      state: 'failed',
      outcome: { reason: 'turn-ended' },
    },
  ];

  assert.deepEqual(executedToolCallsFromEvents(events), [
    { name: 'pc_submit_deliverable' },
    { name: 'pc_submit_deliverable' },
  ]);
});

test('corrupted identity evidence is excluded instead of credited', () => {
  assert.deepEqual(executedToolCallsFromEvents([
    tool('call-corrupt', 'Read', 'running'),
    tool('call-corrupt', 'Write', 'succeeded'),
  ]), []);
});
