import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  AgentRunAdapterError,
  AgentRunMutationGateway,
  toAgentRunDto,
  type AgentRunGatewayDeps,
} from '../src/agent-runs/index.ts';
import type { DbExecutor, InsertLiveEventDraft, LiveOutboxEvent } from '@pc/db';
import type { AgentRunRow } from '@pc/domain';

function makeRow(over: Partial<AgentRunRow> = {}): AgentRunRow {
  return {
    id: 'run1' as AgentRunRow['id'],
    projectId: 'p1' as AgentRunRow['projectId'],
    dispatcherSessionId: 'disp1',
    snapshotState: 'stamped',
    specialistSnapshot: {
      specialistId: 'specialist-builder' as never,
      revision: 'sha256:builder',
      name: 'builder',
      charter: 'Build.',
      contextDocs: [],
      maxTurns: 10,
    },
    nativeSessionId: 'native-1',
    nativeIdentityState: 'bound',
    continuationState: 'clean-started',
    continuationAttemptId: 'attempt-1',
    podName: 'builder',
    selectionState: 'stamped',
    runtimeId: 'runtime-a',
    accountId: 'account-a',
    model: 'model-a',
    effortState: 'none',
    effort: null,
    status: 'running',
    continues: null,
    parentInvokeDepth: 1,
    input: 'go',
    result: null,
    failureCause: null,
    failureReason: null,
    queuedAt: 100,
    spawnedAt: 110,
    readyAt: 120,
    pid: 4242,
    lastActivityAt: 130,
    deliveredAt: null,
    completedAt: null,
    rev: 3,
    contractId: null,
    worktreeDir: null,
    worktreeBaseBranch: null,
    worktreeBaseSha: null,
    ...over,
  } as AgentRunRow;
}

interface Harness {
  gateway: AgentRunMutationGateway;
  inserted: InsertLiveEventDraft[];
  calls: string[];
}

function makeGateway(opts: {
  row?: AgentRunRow | null;
  rowAfter?: AgentRunRow | null;
  flip?: boolean;
  failTx?: boolean;
} = {}): Harness {
  const inserted: InsertLiveEventDraft[] = [];
  const calls: string[] = [];
  let seq = 0;
  let current = opts.row === undefined ? makeRow() : opts.row;

  const fakeInsert = (<TPayload>(
    _db: DbExecutor,
    draft: InsertLiveEventDraft<TPayload>,
  ): LiveOutboxEvent<TPayload> => {
    inserted.push(draft as InsertLiveEventDraft);
    seq += 1;
    return {
      id: `evt-${seq}`,
      cursor: String(seq),
      scope: draft.scope,
      projectId: draft.projectId,
      entity: draft.entity,
      type: draft.type,
      entityId: draft.entityId,
      version: draft.version,
      createdAt: 1000 + seq,
      payload: draft.payload,
    } as LiveOutboxEvent<TPayload>;
  }) as AgentRunGatewayDeps['insertLiveEvent'];

  const deps: AgentRunGatewayDeps = {
    transaction: (fn) => {
      if (opts.failTx) throw new Error('forced tx failure');
      return fn({} as DbExecutor);
    },
    insertLiveEvent: fakeInsert,
    getRun: () => (opts.rowAfter !== undefined ? opts.rowAfter : current),
    updateStatus: (input) => {
      calls.push(`updateStatus:${input.status}`);
      if (current) current = { ...current, status: input.status, rev: current.rev + 1 };
      return current !== null;
    },
    markTerminal: (input) => {
      calls.push(`markTerminal:${input.status}`);
      if (current && ['completed', 'failed', 'cancelled'].includes(current.status)) return false;
      if (current) {
        current = {
          ...current,
          status: input.status,
          rev: current.rev + 1,
          completedAt: input.completedAt,
          failureCause: input.failureCause,
          failureReason: input.failureReason,
        };
      }
      return current !== null;
    },
    createPendingAsk: (input) => {
      calls.push(`createPendingAsk:${input.id}`);
      return input;
    },
    markPendingAskAnswered: () => {
      calls.push('markAnswered');
      return opts.flip ?? true;
    },
    markPendingAskCancelled: () => {
      calls.push('markCancelled');
      return true;
    },
  };

  return { gateway: new AgentRunMutationGateway(deps), inserted, calls };
}

test('commitRunChange emits exactly one agent-run.changed with rev as version', () => {
  const { gateway, inserted } = makeGateway();
  const pub = gateway.commitRunChange({
    reason: 'running',
    mutate: () => makeRow({ rev: 7 }),
  });
  assert.equal(inserted.length, 1);
  assert.equal(pub.liveEvent.type, 'agent-run.changed');
  assert.equal(pub.liveEvent.entity, 'agent-run');
  assert.equal(pub.liveEvent.version, 7);
  assert.equal(pub.run.rev, 7);
  assert.equal(pub.liveEvent.payload.reason, 'running');
});

test('announceRunChange re-reads the post-write row for the correct (non-stale) rev', () => {
  const { gateway } = makeGateway({ rowAfter: makeRow({ rev: 9, status: 'spawning' }) });
  const pub = gateway.announceRunChange({ runId: 'run1', reason: 'spawning' });
  assert.ok(pub);
  assert.equal(pub!.liveEvent.version, 9);
  assert.equal(pub!.run.rev, 9);
  assert.equal(pub!.run.status, 'spawning');
});

test('announceRunChange returns null (emits nothing) for an unknown run', () => {
  const { gateway, inserted } = makeGateway({ rowAfter: null });
  const pub = gateway.announceRunChange({ runId: 'gone', reason: 'running' });
  assert.equal(pub, null);
  assert.equal(inserted.length, 0);
});

test('a tx failure rolls back: the outbox insert never lands (no orphan row)', () => {
  const { gateway, inserted } = makeGateway({ failTx: true });
  assert.throws(() =>
    gateway.commitRunChange({ reason: 'running', mutate: () => makeRow() }),
  );
  assert.equal(inserted.length, 0);
});

test('pauseRun writes the ask + paused row + one paused fact with pendingAskId', () => {
  const { gateway, inserted, calls } = makeGateway({ row: makeRow({ status: 'running' }) });
  const pub = gateway.pauseRun({
    pendingAsk: {
      id: 'ask1' as never,
      agentRunId: 'run1' as never,
      projectId: 'p1' as never,
      kind: 'orchestrator',
      promptBody: 'q?',
      now: 200,
    },
  });
  assert.equal(inserted.length, 1);
  assert.equal(pub.liveEvent.payload.reason, 'paused');
  assert.equal(pub.liveEvent.payload.pendingAskId, 'ask1');
  assert.ok(calls.includes('createPendingAsk:ask1'));
  assert.ok(calls.includes('updateStatus:paused'));
});

test('answerAndResume: a no-op flip (replayed answer) emits nothing', () => {
  const { gateway, inserted, calls } = makeGateway({ flip: false });
  const pub = gateway.answerAndResume({
    pendingAskId: 'ask1' as never,
    agentRunId: 'run1' as never,
    answer: 'yes',
    answeredBy: 'orchestrator',
    now: 300,
  });
  assert.equal(pub, null);
  assert.equal(inserted.length, 0);
  assert.ok(calls.includes('markAnswered'));
  assert.ok(!calls.includes('updateStatus:spawning'));
});

test('answerAndResume: a successful flip persists spawning + emits one resumed fact', () => {
  const { gateway, inserted, calls } = makeGateway({
    row: makeRow({ status: 'paused' }),
    rowAfter: makeRow({ status: 'spawning', rev: 4 }),
    flip: true,
  });
  const pub = gateway.answerAndResume({
    pendingAskId: 'ask1' as never,
    agentRunId: 'run1' as never,
    answer: 'yes',
    answeredBy: 'orchestrator',
    now: 300,
  });
  assert.ok(pub);
  assert.equal(inserted.length, 1);
  assert.equal(pub!.liveEvent.payload.reason, 'resumed');
  assert.equal(pub!.liveEvent.version, 4);
  assert.ok(calls.includes('updateStatus:spawning'));
});

test('cancelRun finalizes a phantom paused run to cancelled + cancels the open ask', () => {
  const { gateway, inserted, calls } = makeGateway({ row: makeRow({ status: 'paused', rev: 4 }) });
  const pub = gateway.cancelRun({ runId: 'run1', now: 400, cancelOpenAsk: 'ask1' as never });
  assert.ok(pub);
  assert.equal(inserted.length, 1);
  assert.equal(pub!.liveEvent.payload.reason, 'cancelled');
  assert.equal(pub!.run.status, 'cancelled');
  assert.equal(pub!.liveEvent.version, 5);
  assert.ok(calls.includes('markTerminal:cancelled'));
  assert.ok(calls.includes('markCancelled'));
});

test('cancelRun on an already-terminal run is a no-op (emits nothing)', () => {
  const { gateway, inserted } = makeGateway({ row: makeRow({ status: 'completed' }) });
  const pub = gateway.cancelRun({ runId: 'run1', now: 400 });
  assert.equal(pub, null);
  assert.equal(inserted.length, 0);
});

test('commitTerminal on an already-terminal run is idempotent (emits nothing)', () => {
  const { gateway, inserted } = makeGateway({ row: makeRow({ status: 'failed' }) });
  const pub = gateway.commitTerminal({
    runId: 'run1',
    status: 'failed',
    result: null,
    failureCause: 'unexpected-exit',
    failureReason: 'died',
    completedAt: 500,
  });
  assert.equal(pub, null);
  assert.equal(inserted.length, 0);
});

test('toAgentRunDto exposes safe immutable selection and presence-only native provenance', () => {
  const dto = toAgentRunDto(makeRow({ rev: 2 }));
  assert.equal(dto.selection?.model, 'model-a');
  assert.equal(dto.startedAt, 100);
  assert.equal(dto.specialistRevision, 'sha256:builder');
  assert.equal(dto.nativeSessionIdPresent, true);
  assert.equal('sessionId' in dto, false);
  assert.equal(dto.rev, 2);
});

test('toAgentRunDto projects exact executed and not-required phase outcomes', () => {
  const preparationReceipt: NonNullable<AgentRunRow['preparationReceipt']> = {
    phase: 'preparation',
    outcome: 'not-required',
    reason: 'no-commands-configured',
    ok: true,
    steps: [],
    finishedAt: 200,
  };
  const readinessReceipt: NonNullable<AgentRunRow['readinessReceipt']> = {
    phase: 'readiness',
    outcome: 'executed',
    ok: true,
    steps: [{
      command: 'pnpm test', exitCode: 0, durationMs: 10,
      stdoutTail: '', stderrTail: '', timedOut: false,
    }],
    finishedAt: 220,
  };
  const dto = toAgentRunDto(makeRow({ preparationReceipt, readinessReceipt }));
  assert.deepEqual(dto.preparationReceipt, preparationReceipt);
  assert.deepEqual(dto.readinessReceipt, readinessReceipt);
});

test('toAgentRunDto fails closed on corrupt nested execution receipts', () => {
  const corruptRows = [
    makeRow({
      gitReceipt: {
        worktreePath: '/tmp/wt',
        branch: 'agent/run1',
        baseBranch: 'main',
        baseSha: 'abc123',
        cleanStatus: true,
        nativeSessionId: 'nested-leak',
      } as never,
    }),
    makeRow({
      preparationReceipt: {
        phase: 'preparation',
        outcome: 'not-required',
        reason: 'no-commands-configured',
        ok: true,
        steps: [],
        finishedAt: 200,
        providerReceipt: { sessionId: 'nested-leak' },
      } as never,
    }),
    makeRow({
      readinessReceipt: {
        phase: 'readiness',
        outcome: 'executed',
        ok: true,
        steps: [{
          command: 'pnpm test',
          exitCode: 0,
          durationMs: 10,
          stdoutTail: '',
          stderrTail: '',
          timedOut: false,
          nativeSessionId: 'nested-leak',
        }],
        finishedAt: 220,
      } as never,
    }),
  ];

  for (const row of corruptRows) {
    assert.throws(
      () => toAgentRunDto(row),
      (error: unknown) => error instanceof AgentRunAdapterError &&
        /unsafe or inconsistent projection/.test(error.message),
    );
  }
});
