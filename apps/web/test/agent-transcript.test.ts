import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

import { TranscriptRow } from '../src/components/TranscriptRow.tsx';
import {
  AbandonmentReceiptDetails,
  PhaseReceiptDetails,
  ReviewCheckoutDetails,
  RunRecoveryDetails,
} from '../src/components/AgentTranscriptModal.tsx';
import {
  parseAgentRunEventsResponse,
  type AgentRunEventEntry,
} from '../src/features/agent-runs/client.ts';
import { mergeAgentTranscriptEvents } from '../src/features/agent-runs/transcript.ts';
import type {
  AgentEventFrame,
  AgentRunDto,
  Contract,
  ReviewCheckoutDto,
} from '@pc/contracts';

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

test('turn-failed transcript row renders providerDetail as a dimmed attributed line only when present', () => {
  const withDetail = renderToStaticMarkup(createElement(TranscriptRow, {
    event: {
      kind: 'turn-failed',
      error: 'runtime failed to start (session-mint-unavailable)',
      source: 'internal',
      providerDetail: 'account currently refuses all turns',
    },
  }));
  assert.match(withDetail, /Provider:/);
  assert.match(withDetail, /account currently refuses all turns/);

  const withoutDetail = renderToStaticMarkup(createElement(TranscriptRow, {
    event: {
      kind: 'turn-failed',
      error: 'runtime failed to start (session-mint-unavailable)',
      source: 'internal',
    },
  }));
  assert.doesNotMatch(withoutDetail, /Provider:/);
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

test('abandonment receipt presentation distinguishes pending, settled, and legacy authority', () => {
  const authority = {
    approvedAt: 10,
    branch: 'feature-safe',
    branchTip: 'a'.repeat(40),
    integrationState: 'unmerged',
    reason: 'superseded',
    worktreeState: { status: 'dirty', staged: 1, unstaged: 2, untracked: 3 },
  } as NonNullable<Contract['abandonmentReceipt']>;
  const pending = renderToStaticMarkup(createElement(AbandonmentReceiptDetails, {
    contract: {
      landingStatus: 'abandoning',
      abandonmentReceipt: authority,
      abandonmentTeardownReceipt: null,
      abandonmentError: 'locked file; retry at boot',
    } as Contract,
  }));
  assert.match(pending, /approval recorded/);
  assert.match(pending, /cleanup pending/);
  assert.match(pending, /not integrated/);
  assert.match(pending, /ignored worktree contents were uninspected/i);
  assert.match(pending, /locked file/);

  const settled = renderToStaticMarkup(createElement(AbandonmentReceiptDetails, {
    contract: {
      landingStatus: 'abandoned',
      abandonmentReceipt: authority,
      abandonmentTeardownReceipt: {
        observedBranchTip: 'a'.repeat(40),
        finishedAt: 20,
      },
      abandonmentError: null,
    } as Contract,
  }));
  assert.match(settled, /settled/);
  assert.match(settled, /branch retained/);
  assert.match(settled, /worktree/);
  assert.match(settled, /removed/);
  assert.match(settled, /did not merge the branch/i);

  const legacy = renderToStaticMarkup(createElement(AbandonmentReceiptDetails, {
    contract: {
      landingStatus: 'abandoned',
      abandonmentReceipt: null,
      abandonmentTeardownReceipt: null,
      abandonmentError: null,
    } as Contract,
  }));
  assert.match(legacy, /authority unavailable/);
  assert.match(legacy, /no explicit user approval receipt/i);
  assert.match(legacy, /automatic cleanup is not authorized/i);
});

test('recovery evidence distinguishes typed cause, sealed evidence, preservation, and unavailable reads', () => {
  const run = {
    runId: 'run-1',
    agentName: 'builder',
    projectId: 'project-1',
    dispatcherSessionId: 'session-1',
    worktreeDir: 'C:\\repo-worktrees\\run-1',
    startedAt: 1,
    status: 'failed',
    lifecycleState: 'failed',
    result: '',
    failureReason: 'server restarted while the run was live',
    failureCause: 'server-restart',
    endedAt: 2,
    rev: 3,
  } as AgentRunDto;
  const contract = {
    expectedOutput: { kind: 'repo' },
    deliverable: { kind: 'repo', branch: 'run-1', commit: 'a'.repeat(40) },
  } as Contract;
  const worktree = {
    id: 'worktree-1',
    name: 'run-1',
    path: run.worktreeDir,
    branch: 'run-1',
    baseBranch: 'main',
    agentRunId: run.runId,
    contractId: 'contract-1',
    strandedReason: 'no-live-run',
    strandedAt: 10,
  } as const;

  const positive = renderToStaticMarkup(createElement(RunRecoveryDetails, {
    run,
    contract,
    worktree,
  }));
  assert.match(positive, /server-restart/);
  assert.match(positive, /lifecycle/);
  assert.match(positive, /sealed deliverable recorded/i);
  assert.match(positive, /worktree remains preserved/i);

  const unavailable = renderToStaticMarkup(createElement(RunRecoveryDetails, {
    run,
    contract,
    worktree: null,
    worktreeReadUnavailable: true,
    onRetryWorktreeRead: () => {},
  }));
  assert.match(unavailable, /worktree recovery status unavailable/i);
  assert.match(unavailable, /preservation is not proven/i);
  assert.match(unavailable, /Retry/);
});

test('review checkout evidence distinguishes cleanup blocking, settlement, and unavailable reads', () => {
  const run = {
    runId: '01J00000000000000000000005',
    agentName: 'contract-reviewer',
    status: 'completed',
  } as AgentRunDto;
  const authority = {
    id: '01J00000000000000000000001',
    projectId: '01J00000000000000000000002',
    contractId: '01J00000000000000000000003',
    contractVersion: 4,
    producerRunId: '01J00000000000000000000004',
    reviewerRunId: run.runId,
    repositoryIdentity: {
      protocol: 'git-common-dir-v1' as const,
      gitCommonDir: 'C:\\repo\\.git',
      leaseKey: `sha256:${'b'.repeat(64)}`,
    },
    worktreePath: 'C:\\repo-worktrees\\review-00000005',
    ownedRootRealPath: 'C:\\repo-worktrees',
    sealedCommit: 'a'.repeat(40),
  };
  const reviewerContract = {
    expectedOutput: { kind: 'payload', semantic: 'verdict', schema: { type: 'object' } },
    verificationStatus: 'passed',
    deliverable: { kind: 'payload', data: { verdict: 'approve', findings: [] } },
  } as Contract;
  const pending = {
    ...authority,
    status: 'teardown-pending',
    provisionReceipt: null,
    preparationReceipt: null,
    readinessReceipt: null,
    verdictReceipt: null,
    verdictAppliedAt: null,
    teardownReceipt: null,
    cleanupError: 'registration locked',
    createdAt: 10,
    updatedAt: 11,
    destroyedAt: null,
  } as ReviewCheckoutDto;
  const blocked = renderToStaticMarkup(createElement(ReviewCheckoutDetails, {
    run,
    checkout: pending,
    readStatus: 'ready',
    readError: null,
    reviewerContract,
  }));
  assert.match(blocked, /cleanup pending/i);
  assert.match(blocked, /submitted approve · 0 findings · not yet recorded/i);
  assert.match(blocked, /blocked until positive cleanup settlement/i);
  assert.match(blocked, /registration locked/i);

  const teardownReceipt = {
    protocol: 'review-checkout-teardown-v1' as const,
    ...authority,
    startedAt: 12,
    finishedAt: 13,
    directoryAbsent: true as const,
    registrationAbsent: true as const,
    branchDeletion: 'not-applicable-detached' as const,
  };
  const verdictReceipt = {
    protocol: 'review-checkout-verdict-v1' as const,
    ...authority,
    reviewerContractId: '01J00000000000000000000006',
    terminalStatus: 'completed' as const,
    outcome: 'overridden' as const,
    findings: [],
    recordedAt: 12,
  };
  const settled = renderToStaticMarkup(createElement(ReviewCheckoutDetails, {
    run,
    checkout: {
      ...pending,
      status: 'destroyed',
      cleanupError: null,
      verdictReceipt,
      verdictAppliedAt: 14,
      teardownReceipt,
      updatedAt: 13,
      destroyedAt: 13,
    },
    readStatus: 'ready',
    readError: null,
    reviewerContract,
  }));
  assert.match(settled, /cleanup settled/i);
  assert.match(settled, /overridden · 0 findings · effect applied/i);
  assert.doesNotMatch(settled, /submitted approve/i);
  assert.match(settled, /contract effect applied/i);
  assert.match(settled, /directory absent · registration absent/i);

  const unavailable = renderToStaticMarkup(createElement(ReviewCheckoutDetails, {
    run,
    checkout: null,
    readStatus: 'error',
    readError: 'offline',
    onRetry: () => {},
    reviewerContract: null,
  }));
  assert.match(unavailable, /evidence unavailable/i);
  assert.match(unavailable, /Retry/);
});
