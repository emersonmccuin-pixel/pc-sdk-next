import assert from 'node:assert/strict';
import { resolve } from 'node:path';
import { test } from 'node:test';
import type {
  ContextObservation,
  RuntimeSelection,
} from '@pc/contracts';
import {
  CODEX_MODEL_PROVIDER,
  CODEX_PROTOCOL_VERSION,
  CODEX_RUNTIME_ID,
  CODEX_RUNTIME_NOTIFICATION_METHODS,
  CODEX_RUNTIME_REQUEST_METHODS,
  type CodexDiscoveryPeer,
  type CodexExecutionPolicyChallenge,
  type CodexProviderFreeConformanceAuthority,
  type CodexProviderFreeExecutionPolicyReceipt,
  type CodexRuntimeMode,
  type CodexRuntimePeer,
  type CodexRuntimePeerFactoryInput,
  type CodexTurnBoundaryChallenge,
} from '../src/runner/codex/runtime-peer.ts';
import {
  CodexRuntimeAdapter,
  CodexRuntimeAdapterError,
} from '../src/runner/codex/adapter.ts';
import type {
  CreateRuntimeSession,
  RuntimeEvent,
  RuntimeSession,
} from '../src/runner/runtime.ts';
import { RuntimeSelectionRejectedError } from '../src/runner/runtime.ts';
import {
  runtimeAdapterConformance,
  type RuntimeAdapterConformanceFixture,
  type RuntimeAdapterConformanceScenario,
} from './runtime-adapter-conformance.ts';

const ACCOUNT_ID = 'codex-personal';
const MISSING_ACCOUNT_ID = 'codex-missing';
const MODEL_ID = 'gpt-5.4';
const MODEL_LABEL = 'GPT-5.4';
const EFFORT = 'high';
const CWD = resolve('test-fixtures/codex-provider-free');
const CREATED_THREAD_ID = '01900100-0000-7000-8000-000000000001';
const RESUMED_THREAD_ID = '01900100-0000-7000-8000-000000000002';
const TURN_ID = '01900100-0000-7000-8000-000000000003';
const AGENT_ITEM_ID = '01900100-0000-7000-8000-000000000004';
const EXPECTED_TEXT = 'provider-free Codex response';
const EXPECTED_CONTEXT: ContextObservation = {
  confidence: 'unavailable',
  reason: 'runtime-unavailable',
};

const SELECTION: RuntimeSelection = {
  runtimeId: CODEX_RUNTIME_ID,
  accountId: ACCOUNT_ID,
  model: MODEL_ID,
  effort: { kind: 'selected', value: EFFORT },
};

interface Deferred<T = void> {
  readonly promise: Promise<T>;
  resolve(value: T): void;
}

function deferred<T = void>(): Deferred<T> {
  let resolvePromise!: (value: T) => void;
  let settled = false;
  const promise = new Promise<T>((resolve) => { resolvePromise = resolve; });
  return {
    promise,
    resolve(value) {
      if (settled) return;
      settled = true;
      resolvePromise(value);
    },
  };
}

class FakeNotificationQueue implements AsyncIterable<unknown> {
  private readonly buffered: unknown[] = [];
  private readonly waiters: Array<(value: IteratorResult<unknown>) => void> = [];
  private closed = false;
  private sealed = false;
  private iteratorReturns = 0;
  private iteratorNexts = 0;

  constructor(private readonly control?: FakeRuntimeControl) {}

  push(value: unknown): void {
    if (this.closed || this.sealed) throw new Error('fake turn notification epoch is sealed');
    const waiter = this.waiters.shift();
    if (waiter) waiter({ done: false, value });
    else this.buffered.push(value);
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    while (this.waiters.length > 0) this.waiters.shift()?.({ done: true, value: undefined });
  }

  seal(): number {
    if (this.closed || this.sealed) throw new Error('fake turn notification epoch is unavailable');
    this.sealed = true;
    return this.buffered.length;
  }

  pendingCount(): number {
    return this.buffered.length;
  }

  iteratorReturnCount(): number {
    return this.iteratorReturns;
  }

  iteratorNextCount(): number {
    return this.iteratorNexts;
  }

  [Symbol.asyncIterator](): AsyncIterator<unknown> {
    return {
      next: async () => {
        this.iteratorNexts += 1;
        if (this.buffered.length > 0) {
          return { done: false, value: this.buffered.shift() };
        }
        if (this.closed) return { done: true, value: undefined };
        return new Promise<IteratorResult<unknown>>((resolve) => this.waiters.push(resolve));
      },
      return: async () => {
        this.iteratorReturns += 1;
        if (this.control?.deferNotificationReturn) {
          await this.control.deferNotificationReturn.promise;
        }
        if (this.control?.rejectNotificationReturn) {
          throw new Error('fake notification iterator return rejected');
        }
        this.close();
        return { done: true, value: undefined };
      },
    };
  }
}

interface FakeRuntimeControl {
  readonly scenario: RuntimeAdapterConformanceScenario | 'manual';
  readonly blockedTurnReady: Deferred;
  readonly turnStartEntered: Deferred;
  readonly turnBoundaryReady: Deferred;
  readonly interruptEntered: Deferred;
  readonly peers: FakeCodexRuntimePeer[];
  readonly factoryInputs: CodexRuntimePeerFactoryInput[];
  autoTurnStarted: boolean;
  terminalTail: unknown[];
  interruptAcceptances: number;
  nativeCloses: number;
  peerDisposeCalls: number;
  threadStarts: number;
  threadResumes: number;
  turnStarts: number;
  deferTurnBoundary?: Deferred;
  deferTurnStart?: Deferred;
  deferDispose?: Deferred;
  deferInterrupt?: Deferred;
  deferNotificationReturn?: Deferred;
  rejectNotificationReturn?: boolean;
  onDispose?: () => void;
  holdQueueOpenAfterDispose?: boolean;
  reuseTurnId?: boolean;
  reuseItemId?: boolean;
  receiptMutation?: (receipt: Record<string, unknown>) => unknown;
  threadMutation?: (value: Record<string, unknown>, mode: CodexRuntimeMode) => unknown;
  turnStartMutation?: (value: Record<string, unknown>) => unknown;
}

class FakeCodexRuntimePeer implements CodexRuntimePeer {
  private currentNotificationsQueue: FakeNotificationQueue;
  readonly challenges: unknown[] = [];
  readonly boundaryChallenges: unknown[] = [];
  readonly threadParams: unknown[] = [];
  readonly turnParams: unknown[] = [];
  private activeTurnId: string | null = null;
  private activeItemId: string | null = null;
  private turnSequence = 0;
  private disposed = false;

  constructor(
    private readonly input: CodexRuntimePeerFactoryInput,
    private readonly control: FakeRuntimeControl,
  ) {
    this.currentNotificationsQueue = new FakeNotificationQueue(control);
  }

  get notificationsQueue(): FakeNotificationQueue {
    return this.currentNotificationsQueue;
  }

  async startThread(
    params: Parameters<CodexRuntimePeer['startThread']>[0],
    policyReceipt: CodexProviderFreeExecutionPolicyReceipt,
  ): Promise<unknown> {
    this.control.threadStarts += 1;
    this.threadParams.push(structuredClone(params));
    return this.threadPeerReceipt(CREATED_THREAD_ID, policyReceipt, 'create');
  }

  async resumeThread(
    params: Parameters<CodexRuntimePeer['resumeThread']>[0],
    policyReceipt: CodexProviderFreeExecutionPolicyReceipt,
  ): Promise<unknown> {
    this.control.threadResumes += 1;
    this.threadParams.push(structuredClone(params));
    return this.threadPeerReceipt(this.input.requestedThreadId ?? RESUMED_THREAD_ID, policyReceipt, 'resume');
  }

  async startTurn(params: Parameters<CodexRuntimePeer['startTurn']>[0]): Promise<unknown> {
    this.control.turnStarts += 1;
    this.turnParams.push(structuredClone(params));
    this.control.turnStartEntered.resolve();
    if (this.control.deferTurnStart) await this.control.deferTurnStart.promise;
    if (this.disposed) throw new Error('fake Codex peer disposed during turn start');
    this.turnSequence += 1;
    this.currentNotificationsQueue = new FakeNotificationQueue(this.control);
    this.activeTurnId = this.control.reuseTurnId
      ? TURN_ID
      : nativeSequenceId(3 + ((this.turnSequence - 1) * 2));
    this.activeItemId = this.control.reuseItemId
      ? AGENT_ITEM_ID
      : nativeSequenceId(4 + ((this.turnSequence - 1) * 2));
    if (this.control.autoTurnStarted) {
      this.notificationsQueue.push(turnStarted(this.threadId(), this.activeTurnId));
    }

    if (this.control.scenario === 'receipts' || this.control.scenario === 'discovery') {
      this.emitSuccessfulTurn(EXPECTED_TEXT);
    } else {
      this.control.blockedTurnReady.resolve();
    }
    const response = { turn: turn(this.activeTurnId, 'inProgress') };
    return this.control.turnStartMutation
      ? this.control.turnStartMutation(response)
      : response;
  }

  async interruptTurn(params: Parameters<CodexRuntimePeer['interruptTurn']>[0]): Promise<unknown> {
    this.turnParams.push(structuredClone(params));
    this.control.interruptEntered.resolve();
    this.control.interruptAcceptances += 1;
    if (this.control.deferInterrupt) await this.control.deferInterrupt.promise;
    if (this.disposed) throw new Error('fake Codex peer disposed during interrupt');
    return {};
  }

  notifications(): AsyncIterable<unknown> {
    return this.notificationsQueue;
  }

  async dispose(): Promise<void> {
    this.control.peerDisposeCalls += 1;
    if (this.disposed) return;
    this.disposed = true;
    this.control.onDispose?.();
    this.control.nativeCloses += 1;
    if (this.control.deferDispose) await this.control.deferDispose.promise;
    if (!this.control.holdQueueOpenAfterDispose) this.notificationsQueue.close();
  }

  emitInterruptedTerminal(): void {
    if (!this.activeTurnId) throw new Error('fake Codex turn is not active');
    this.notificationsQueue.push(turnCompleted(
      this.threadId(),
      this.activeTurnId,
      'interrupted',
    ));
  }

  emit(value: unknown): void {
    this.notificationsQueue.push(value);
  }

  sealTurnBoundary(challenge: CodexTurnBoundaryChallenge): number {
    if (challenge.turnId !== this.activeTurnId) {
      throw new Error('provider-free authority refused a mismatched turn epoch');
    }
    return this.notificationsQueue.seal();
  }

  private emitSuccessfulTurn(text: string): void {
    if (this.activeTurnId === null || this.activeItemId === null) {
      throw new Error('fake Codex turn identities are unavailable');
    }
    const nativeItem = agentMessage(this.activeItemId, text);
    this.notificationsQueue.push(itemStarted(
      this.threadId(),
      this.activeTurnId,
      agentMessage(this.activeItemId, ''),
    ));
    this.notificationsQueue.push(agentDelta(
      this.threadId(), this.activeTurnId, this.activeItemId, 'provider-free ',
    ));
    this.notificationsQueue.push(agentDelta(
      this.threadId(), this.activeTurnId, this.activeItemId, 'Codex response',
    ));
    this.notificationsQueue.push(itemCompleted(this.threadId(), this.activeTurnId, nativeItem));
    this.notificationsQueue.push(turnCompleted(
      this.threadId(), this.activeTurnId, 'completed', [nativeItem],
    ));
    for (const frame of this.control.terminalTail) this.notificationsQueue.push(frame);
  }

  private threadPeerReceipt(
    threadId: string,
    policyReceipt: CodexProviderFreeExecutionPolicyReceipt,
    mode: CodexRuntimeMode,
  ): unknown {
    const response = threadResponse(threadId, this.input.cwd);
    const mutated = this.control.threadMutation
      ? this.control.threadMutation(response, mode)
      : response;
    return {
      policyReceipt: structuredClone(policyReceipt),
      response: mutated,
    };
  }

  private threadId(): string {
    return this.input.mode === 'create'
      ? CREATED_THREAD_ID
      : (this.input.requestedThreadId ?? RESUMED_THREAD_ID);
  }
}

class FakeCodexConformanceAuthority implements CodexProviderFreeConformanceAuthority {
  constructor(private readonly control: FakeRuntimeControl) {}

  async attestExecutionPolicy(
    peer: CodexRuntimePeer,
    challenge: CodexExecutionPolicyChallenge,
  ): Promise<unknown> {
    const fake = this.capturePeer(peer);
    fake.challenges.push(structuredClone(challenge));
    const receipt = providerFreeReceipt(challenge);
    return this.control.receiptMutation
      ? this.control.receiptMutation(receipt as unknown as Record<string, unknown>)
      : receipt;
  }

  async attestTurnBoundary(
    peer: CodexRuntimePeer,
    challenge: CodexTurnBoundaryChallenge,
  ): Promise<unknown> {
    const fake = this.capturePeer(peer);
    fake.boundaryChallenges.push(structuredClone(challenge));
    const pendingNotifications = fake.sealTurnBoundary(challenge);
    this.control.turnBoundaryReady.resolve();
    if (this.control.deferTurnBoundary) await this.control.deferTurnBoundary.promise;
    return {
      kind: 'provider-free-conformance-turn-boundary',
      protocolVersion: CODEX_PROTOCOL_VERSION,
      runtimeId: CODEX_RUNTIME_ID,
      continuationAttemptId: challenge.continuationAttemptId,
      threadId: challenge.threadId,
      turnId: challenge.turnId,
      turnSequence: challenge.turnSequence,
      status: challenge.status,
      notificationBoundary: 'closed-fake',
      pendingNotifications,
    };
  }

  private capturePeer(peer: CodexRuntimePeer): FakeCodexRuntimePeer {
    if (!(peer instanceof FakeCodexRuntimePeer) || !this.control.peers.includes(peer)) {
      throw new Error('provider-free authority refused an unknown execution peer');
    }
    return peer;
  }
}

function nativeSequenceId(sequence: number): string {
  return `01900100-0000-7000-8000-${String(sequence).padStart(12, '0')}`;
}

function providerFreeReceipt(
  challenge: CodexExecutionPolicyChallenge,
): CodexProviderFreeExecutionPolicyReceipt {
  return {
    kind: 'provider-free-conformance',
    protocolVersion: CODEX_PROTOCOL_VERSION,
    runtimeId: CODEX_RUNTIME_ID,
    continuationAttemptId: challenge.continuationAttemptId,
    selection: structuredClone(challenge.selection),
    mode: challenge.mode,
    requestedThreadId: challenge.requestedThreadId,
    cwd: challenge.cwd,
    requestMethods: [...CODEX_RUNTIME_REQUEST_METHODS],
    notificationMethods: [...CODEX_RUNTIME_NOTIFICATION_METHODS],
    effectiveNativeTools: [],
    effectiveMcpServers: [],
    approvalRequests: 'disabled',
    lifecycle: 'contained-fake',
  };
}

function discoveryPeer(): CodexDiscoveryPeer {
  return {
    async discover(accountId: string): Promise<unknown> {
      if (accountId === MISSING_ACCOUNT_ID) {
        return {
          status: 'unavailable',
          protocolVersion: CODEX_PROTOCOL_VERSION,
          runtimeId: CODEX_RUNTIME_ID,
          accountId,
          code: 'account-unavailable',
        };
      }
      return {
        status: 'available',
        protocolVersion: CODEX_PROTOCOL_VERSION,
        runtimeId: CODEX_RUNTIME_ID,
        accountId,
        models: [{
          id: MODEL_ID,
          resolvedId: null,
          label: MODEL_LABEL,
          description: 'Provider-free test catalog entry',
          effort: { status: 'supported', values: ['low', EFFORT] },
        }],
      };
    },
  };
}

function makeControl(
  scenario: FakeRuntimeControl['scenario'],
): FakeRuntimeControl {
  return {
    scenario,
    blockedTurnReady: deferred(),
    turnStartEntered: deferred(),
    turnBoundaryReady: deferred(),
    interruptEntered: deferred(),
    peers: [],
    factoryInputs: [],
    autoTurnStarted: true,
    terminalTail: [],
    interruptAcceptances: 0,
    nativeCloses: 0,
    peerDisposeCalls: 0,
    threadStarts: 0,
    threadResumes: 0,
    turnStarts: 0,
  };
}

function threadResponse(threadId: string, cwd: string): Record<string, unknown> {
  return {
    thread: thread(threadId, cwd),
    model: MODEL_ID,
    modelProvider: CODEX_MODEL_PROVIDER,
    serviceTier: null,
    cwd,
    instructionSources: [],
    approvalPolicy: 'never',
    approvalsReviewer: 'user',
    sandbox: { type: 'readOnly', networkAccess: false },
    reasoningEffort: EFFORT,
  };
}

function thread(id: string, cwd: string): Record<string, unknown> {
  return {
    id,
    sessionId: `session-${id}`,
    forkedFromId: null,
    parentThreadId: null,
    preview: '',
    ephemeral: false,
    modelProvider: CODEX_MODEL_PROVIDER,
    createdAt: 1,
    updatedAt: 1,
    recencyAt: null,
    status: { type: 'idle' },
    path: null,
    cwd,
    cliVersion: CODEX_PROTOCOL_VERSION,
    source: 'appServer',
    threadSource: null,
    agentNickname: null,
    agentRole: null,
    gitInfo: null,
    name: null,
    turns: [],
  };
}

function turn(
  id: string,
  status: 'completed' | 'interrupted' | 'failed' | 'inProgress',
  items: unknown[] = [],
): Record<string, unknown> {
  return {
    id,
    items,
    itemsView: 'full',
    status,
    error: status === 'failed'
      ? {
          message: 'PRIVATE NATIVE ERROR PROSE',
          codexErrorInfo: 'other',
          additionalDetails: 'PRIVATE ADDITIONAL DETAILS',
        }
      : null,
    startedAt: 1,
    completedAt: status === 'inProgress' ? null : 2,
    durationMs: status === 'inProgress' ? null : 10,
  };
}

function agentMessage(id: string, text: string): Record<string, unknown> {
  return { type: 'agentMessage', id, text, phase: 'final_answer', memoryCitation: null };
}

function turnStarted(threadId: string, turnId: string): Record<string, unknown> {
  return { method: 'turn/started', params: { threadId, turn: turn(turnId, 'inProgress') } };
}

function itemStarted(threadId: string, turnId: string, item: unknown): Record<string, unknown> {
  return { method: 'item/started', params: { threadId, turnId, item, startedAtMs: 1 } };
}

function agentDelta(
  threadId: string,
  turnId: string,
  itemId: string,
  delta: string,
): Record<string, unknown> {
  return {
    method: 'item/agentMessage/delta',
    params: { threadId, turnId, itemId, delta },
  };
}

function itemCompleted(threadId: string, turnId: string, item: unknown): Record<string, unknown> {
  return { method: 'item/completed', params: { threadId, turnId, item, completedAtMs: 2 } };
}

function turnCompleted(
  threadId: string,
  turnId: string,
  status: 'completed' | 'interrupted' | 'failed',
  items: unknown[] = [],
): Record<string, unknown> {
  return { method: 'turn/completed', params: { threadId, turn: turn(turnId, status, items) } };
}

function cloneSelection(selection: RuntimeSelection): RuntimeSelection {
  return structuredClone(selection);
}

async function collectEvents(stream: AsyncIterable<RuntimeEvent>): Promise<RuntimeEvent[]> {
  const events: RuntimeEvent[] = [];
  for await (const event of stream) events.push(event);
  return events;
}

function sessionInput(overrides: Partial<CreateRuntimeSession> = {}): CreateRuntimeSession {
  return {
    appSessionId: 'codex-provider-free-app-session',
    projectId: 'codex-provider-free-project',
    continuationAttemptId: 'codex-provider-free-attempt',
    selection: cloneSelection(SELECTION),
    cwd: CWD,
    ...overrides,
  };
}

function adapterFor(
  control: FakeRuntimeControl,
  discovery: CodexDiscoveryPeer = discoveryPeer(),
  now: () => number = () => 42,
): CodexRuntimeAdapter {
  return new CodexRuntimeAdapter({
    discoveryPeer: discovery,
    conformanceAuthority: new FakeCodexConformanceAuthority(control),
    now,
    runtimePeerFactory: async (input) => {
      const captured = structuredClone(input);
      control.factoryInputs.push(captured);
      const peer = new FakeCodexRuntimePeer(captured, control);
      control.peers.push(peer);
      return peer;
    },
  });
}

function conformanceFixture(
  scenario: RuntimeAdapterConformanceScenario,
): RuntimeAdapterConformanceFixture {
  const control = makeControl(scenario);
  return {
    adapter: adapterFor(control),
    selection: cloneSelection(SELECTION),
    missingAccountId: MISSING_ACCOUNT_ID,
    expectedText: EXPECTED_TEXT,
    expectedContext: EXPECTED_CONTEXT,
    createdNativeSessionId: CREATED_THREAD_ID,
    resumedNativeSessionId: RESUMED_THREAD_ID,
    cwd: CWD,
    blockedTurnReady: control.blockedTurnReady.promise,
    releaseInterruptedTurn() {
      const peer = control.peers.at(-1);
      if (!peer) throw new Error('provider-free Codex peer unavailable');
      peer.emitInterruptedTerminal();
    },
    interruptAcceptanceCount: () => control.interruptAcceptances,
    nativeCloseCount: () => control.nativeCloses,
  };
}

runtimeAdapterConformance('Codex', conformanceFixture);

test('Codex discovery, capabilities, context, and quota degrade with exact attribution', async () => {
  const control = makeControl('manual');
  const adapter = adapterFor(control);
  assert.equal(adapter.id, CODEX_RUNTIME_ID);
  assert.deepEqual(await adapter.capabilities(ACCOUNT_ID), {
    runtimeId: CODEX_RUNTIME_ID,
    accountId: ACCOUNT_ID,
    nativeContinuation: { status: 'supported' },
    modelDiscovery: { status: 'supported' },
    effortControl: { status: 'supported' },
    context: {
      currentUse: { status: 'unavailable', code: 'codex-context-unavailable' },
      compaction: { status: 'unavailable', code: 'codex-compaction-unavailable' },
    },
    subscriptionQuota: { status: 'unavailable', code: 'codex-quota-unavailable' },
  });
  assert.deepEqual(await adapter.capabilities(MISSING_ACCOUNT_ID), {
    runtimeId: CODEX_RUNTIME_ID,
    accountId: MISSING_ACCOUNT_ID,
    nativeContinuation: { status: 'unavailable', code: 'account-unavailable' },
    modelDiscovery: { status: 'unavailable', code: 'account-unavailable' },
    effortControl: { status: 'unavailable', code: 'account-unavailable' },
    context: {
      currentUse: { status: 'unavailable', code: 'account-unavailable' },
      compaction: { status: 'unavailable', code: 'account-unavailable' },
    },
    subscriptionQuota: { status: 'unavailable', code: 'account-unavailable' },
  });
  assert.deepEqual(await adapter.observeSubscriptionQuota(ACCOUNT_ID), {
    runtimeId: CODEX_RUNTIME_ID,
    accountId: ACCOUNT_ID,
    availability: 'unavailable',
    reason: 'unsupported',
    observedAt: 42,
  });
  const aborted = new AbortController();
  aborted.abort();
  assert.deepEqual(await adapter.observeSubscriptionQuota(ACCOUNT_ID, {
    signal: aborted.signal,
  }), {
    runtimeId: CODEX_RUNTIME_ID,
    accountId: ACCOUNT_ID,
    availability: 'unavailable',
    reason: 'observation-timeout',
    observedAt: 42,
  });
  assert.equal(control.peers.length, 0, 'telemetry must not create a runtime peer');
});

test('Codex discovery captures returned models before hostile mutation', async () => {
  const observed = {
    status: 'available',
    protocolVersion: CODEX_PROTOCOL_VERSION,
    runtimeId: CODEX_RUNTIME_ID,
    accountId: ACCOUNT_ID,
    models: [{
      id: MODEL_ID,
      resolvedId: null,
      label: MODEL_LABEL,
      description: 'Provider-free test catalog entry',
      effort: { status: 'supported', values: ['low', EFFORT] },
    }],
  };
  const adapter = adapterFor(makeControl('manual'), {
    async discover(): Promise<unknown> { return observed; },
  });
  const discovery = await adapter.listModels(ACCOUNT_ID);
  observed.models[0]!.id = 'mutated-native-model';
  observed.models[0]!.effort.values[0] = 'mutated-native-effort';
  assert.equal(discovery.status, 'available');
  if (discovery.status === 'available') {
    assert.equal(discovery.models[0]?.id, MODEL_ID);
    assert.deepEqual(discovery.models[0]?.effort, {
      status: 'supported',
      values: ['low', EFFORT],
    });
  }

  const malformed = adapterFor(makeControl('manual'), {
    async discover(): Promise<unknown> {
      return { status: 'available', privateNativeProse: 'must not surface' };
    },
  });
  assert.deepEqual(await malformed.listModels(ACCOUNT_ID), {
    status: 'unavailable',
    code: 'codex-discovery-unavailable',
  });
});

test('Codex policy receipt mismatches refuse before either thread method', async () => {
  const mutations: Array<(value: Record<string, unknown>) => unknown> = [
    (value) => ({ ...value, kind: 'native-production' }),
    (value) => ({ ...value, continuationAttemptId: 'stale-attempt' }),
    (value) => ({ ...value, effectiveNativeTools: ['shell'] }),
    (value) => ({ ...value, effectiveMcpServers: ['private-mcp'] }),
    (value) => ({ ...value, approvalRequests: 'routed' }),
    (value) => ({ ...value, lifecycle: 'direct-child' }),
    (value) => ({ ...value, requestMethods: [...CODEX_RUNTIME_REQUEST_METHODS].reverse() }),
  ];

  for (const mutate of mutations) {
    const control = makeControl('manual');
    control.receiptMutation = mutate;
    const adapter = adapterFor(control);
    await assert.rejects(
      () => adapter.createSession(sessionInput()),
      (error: unknown) => error instanceof CodexRuntimeAdapterError &&
        error.code === 'session-mint-unavailable',
    );
    assert.equal(control.threadStarts, 0);
    assert.equal(control.threadResumes, 0);
    assert.equal(control.turnStarts, 0);
    assert.equal(control.nativeCloses, 1);
  }
});

test('Codex create emits the exact challenge and closed stable thread request', async () => {
  const control = makeControl('manual');
  const adapter = adapterFor(control);
  const session = await adapter.createSession(sessionInput({
    instructions: 'provider-neutral charter',
    maxTurns: 3,
    allowedNativeTools: [],
    bypassPermissions: true,
  }));
  assert.deepEqual(control.factoryInputs, [{
    continuationAttemptId: 'codex-provider-free-attempt',
    selection: SELECTION,
    mode: 'create',
    requestedThreadId: null,
    cwd: CWD,
  }]);
  assert.deepEqual(control.peers[0]?.challenges, [{
    kind: 'provider-free-execution-policy-challenge',
    protocolVersion: CODEX_PROTOCOL_VERSION,
    runtimeId: CODEX_RUNTIME_ID,
    continuationAttemptId: 'codex-provider-free-attempt',
    selection: SELECTION,
    mode: 'create',
    requestedThreadId: null,
    cwd: CWD,
    requestMethods: [...CODEX_RUNTIME_REQUEST_METHODS],
    notificationMethods: [...CODEX_RUNTIME_NOTIFICATION_METHODS],
  }]);
  assert.deepEqual(control.peers[0]?.threadParams, [{
    model: MODEL_ID,
    modelProvider: CODEX_MODEL_PROVIDER,
    serviceTier: null,
    cwd: CWD,
    approvalPolicy: 'never',
    approvalsReviewer: 'user',
    sandbox: 'read-only',
    config: { model_reasoning_effort: EFFORT },
    baseInstructions: null,
    developerInstructions: 'provider-neutral charter',
    ephemeral: false,
    sessionStartSource: 'startup',
  }]);
  assert.equal(control.threadStarts, 1);
  assert.equal(control.threadResumes, 0);
  await session.dispose();
});

test('Codex preserves literal user text and enforces the captured turn limit locally', async () => {
  const control = makeControl('receipts');
  const session = await adapterFor(control).createSession(sessionInput({ maxTurns: 1 }));
  const literal = '  preserve leading and trailing whitespace\n';
  const events = await collectEvents(session.sendTurn(literal));
  assert.equal(events.at(-1)?.type, 'result');
  const params = control.peers[0]?.turnParams[0] as {
    input?: Array<{ type?: unknown; text?: unknown; text_elements?: unknown }>;
  } | undefined;
  assert.deepEqual(params?.input, [{ type: 'text', text: literal, text_elements: [] }]);
  assert.deepEqual(await collectEvents(session.sendTurn('second turn')), [{
    type: 'result',
    ok: false,
    stopReason: null,
    usage: null,
    durationMs: null,
    numTurns: null,
    error: 'runtime turn budget exhausted',
    outcome: 'budget-exhausted',
  }]);
  assert.equal(control.turnStarts, 1);
  await session.dispose();
});

test('Codex revalidates discovery after policy evidence and before thread creation', async () => {
  let discoveries = 0;
  const control = makeControl('manual');
  const adapter = adapterFor(control, {
    async discover(accountId: string): Promise<unknown> {
      discoveries += 1;
      if (discoveries > 2) {
        return {
          status: 'unavailable',
          protocolVersion: CODEX_PROTOCOL_VERSION,
          runtimeId: CODEX_RUNTIME_ID,
          accountId,
          code: 'runtime-rotated-after-policy',
        };
      }
      return {
        status: 'available',
        protocolVersion: CODEX_PROTOCOL_VERSION,
        runtimeId: CODEX_RUNTIME_ID,
        accountId,
        models: [{
          id: MODEL_ID,
          resolvedId: null,
          label: MODEL_LABEL,
          description: '',
          effort: { status: 'supported', values: ['low', EFFORT] },
        }],
      };
    },
  });
  await assert.rejects(
    () => adapter.createSession(sessionInput()),
    (error: unknown) => error instanceof RuntimeSelectionRejectedError &&
      error.code === 'model-discovery-unavailable',
  );
  assert.equal(discoveries, 3);
  assert.equal(control.peers[0]?.challenges.length, 1);
  assert.equal(control.threadStarts, 0);
  assert.equal(control.threadResumes, 0);
  assert.equal(control.nativeCloses, 1);
});

test('Codex rejects tool, native-tool, ask, and malformed inputs before peer creation', async () => {
  const ask = () => ({
    requestId: 'must-not-run',
    decision: Promise.resolve({ behavior: 'deny' as const, decidedBy: 'session' as const }),
    cancel() {},
  });
  const invalidInputs: CreateRuntimeSession[] = [
    sessionInput({
      tools: {
        serverKey: 'pc',
        toolDefs: [],
        allowedToolNames: ['mcp__pc__private'],
      },
    }),
    sessionInput({ allowedNativeTools: ['shell'] }),
    sessionInput({ ask }),
    sessionInput({ maxTurns: 0 }),
    sessionInput({ instructions: 'bad\u0000instruction' }),
  ];
  for (const input of invalidInputs) {
    const control = makeControl('manual');
    const adapter = adapterFor(control);
    await assert.rejects(
      () => adapter.createSession(input),
      (error: unknown) => error instanceof CodexRuntimeAdapterError &&
        error.code === 'unsupported-session-input',
    );
    assert.equal(control.peers.length, 0);
  }

  const resumeControl = makeControl('manual');
  await assert.rejects(
    () => adapterFor(resumeControl).resumeSession({
      ...sessionInput(),
      nativeSessionId: 'not-a-native-uuid',
    }),
    (error: unknown) => error instanceof RuntimeSelectionRejectedError &&
      error.code === 'native-session-missing',
  );
  assert.equal(resumeControl.peers.length, 0);
});

test('Codex thread response mismatch matrix closes the peer and resume never falls back to create', async () => {
  const mutations: Array<(value: Record<string, unknown>, mode: CodexRuntimeMode) => unknown> = [
    (value) => ({ ...value, model: 'wrong-model' }),
    (value) => ({ ...value, modelProvider: 'wrong-provider' }),
    (value) => ({ ...value, cwd: 'E:\\wrong' }),
    (value) => ({ ...value, approvalPolicy: 'on-request' }),
    (value) => ({ ...value, approvalsReviewer: 'auto_review' }),
    (value) => ({ ...value, sandbox: { type: 'readOnly', networkAccess: true } }),
    (value) => ({ ...value, reasoningEffort: 'low' }),
    (value) => ({
      ...value,
      thread: { ...(value.thread as Record<string, unknown>), ephemeral: true },
    }),
    (value) => ({
      ...value,
      thread: { ...(value.thread as Record<string, unknown>), forkedFromId: CREATED_THREAD_ID },
    }),
    (value) => ({
      ...value,
      thread: { ...(value.thread as Record<string, unknown>), parentThreadId: CREATED_THREAD_ID },
    }),
    (value) => ({
      ...value,
      thread: { ...(value.thread as Record<string, unknown>), agentNickname: 'worker' },
    }),
    (value) => ({
      ...value,
      thread: { ...(value.thread as Record<string, unknown>), status: { type: 'systemError' } },
    }),
    (value) => ({
      ...value,
      thread: {
        ...(value.thread as Record<string, unknown>),
        status: { type: 'active', activeFlags: ['waitingOnApproval'] },
      },
    }),
    (value, mode) => ({
      ...value,
      thread: {
        ...(value.thread as Record<string, unknown>),
        id: mode === 'resume' ? CREATED_THREAD_ID : 'invalid-native-id',
      },
    }),
  ];
  for (const mode of ['create', 'resume'] as const) {
    for (const mutate of mutations) {
      const control = makeControl('manual');
      control.threadMutation = mutate;
      const adapter = adapterFor(control);
      const attempt = mode === 'create'
        ? adapter.createSession(sessionInput())
        : adapter.resumeSession({ ...sessionInput(), nativeSessionId: RESUMED_THREAD_ID });
      await assert.rejects(
        () => attempt,
        (error: unknown) => error instanceof CodexRuntimeAdapterError &&
          error.code === 'session-mint-unavailable',
      );
      assert.equal(control.threadStarts, mode === 'create' ? 1 : 0);
      assert.equal(control.threadResumes, mode === 'resume' ? 1 : 0);
      assert.equal(control.nativeCloses, 1);
      assert.equal(control.turnStarts, 0);
    }
  }
});

test('Codex resume seeds historical turn and item identity fences', async () => {
  const control = makeControl('receipts');
  control.threadMutation = (value, mode) => {
    assert.equal(mode, 'resume');
    const nativeThread = value.thread as Record<string, unknown>;
    nativeThread.turns = [turn(
      TURN_ID,
      'completed',
      [agentMessage(AGENT_ITEM_ID, 'PRIVATE historical provider prose')],
    )];
    return value;
  };
  const session = await adapterFor(control).resumeSession({
    ...sessionInput(),
    nativeSessionId: RESUMED_THREAD_ID,
  });
  const events = await collectEvents(session.sendTurn('must not reuse history identity'));
  assert.equal(events.some((event) => event.type === 'result' && event.ok), false);
  assert.deepEqual(events.at(-1), {
    type: 'result',
    ok: false,
    stopReason: null,
    usage: null,
    durationMs: null,
    numTurns: null,
    error: 'runtime unavailable',
    outcome: 'error',
  });
  assert.doesNotMatch(JSON.stringify(events), /PRIVATE historical provider prose/iu);
  assert.equal(control.nativeCloses, 1);
});

test('Codex captures mutable create inputs before discovery awaits', async () => {
  const gate = deferred<unknown>();
  const control = makeControl('manual');
  const adapter = adapterFor(control, {
    async discover(): Promise<unknown> { return gate.promise; },
  });
  const selection = cloneSelection(SELECTION);
  const input = sessionInput({
    selection,
    instructions: 'original charter',
    maxTurns: 2,
  });
  const pending = adapter.createSession(input);
  selection.accountId = 'mutated-account';
  selection.model = 'mutated-model';
  if (selection.effort.kind === 'selected') selection.effort.value = 'mutated-effort';
  input.continuationAttemptId = 'mutated-attempt';
  input.cwd = 'E:\\mutated';
  input.instructions = 'mutated charter';
  input.maxTurns = 99;
  gate.resolve({
    status: 'available',
    protocolVersion: CODEX_PROTOCOL_VERSION,
    runtimeId: CODEX_RUNTIME_ID,
    accountId: ACCOUNT_ID,
    models: [{
      id: MODEL_ID,
      resolvedId: null,
      label: MODEL_LABEL,
      description: '',
      effort: { status: 'supported', values: ['low', EFFORT] },
    }],
  });
  const session = await pending;
  assert.deepEqual(control.factoryInputs[0], {
    continuationAttemptId: 'codex-provider-free-attempt',
    selection: SELECTION,
    mode: 'create',
    requestedThreadId: null,
    cwd: CWD,
  });
  assert.equal(
    (control.peers[0]?.threadParams[0] as { developerInstructions?: unknown })
      ?.developerInstructions,
    'original charter',
  );
  await session.dispose();
});

test('Codex reentrant native capture cannot publish events after disposal', async () => {
  {
    const control = makeControl('manual');
    let session!: RuntimeSession;
    control.turnStartMutation = (value) => {
      const accessor: Record<string, unknown> = {};
      Object.defineProperty(accessor, 'turn', {
        enumerable: true,
        get() {
          void session.dispose();
          return value.turn;
        },
      });
      return accessor;
    };
    session = await adapterFor(control).createSession(sessionInput());
    const events = await collectEvents(session.sendTurn('turn response re-entry'));
    assert.equal(events.some((event) => event.type === 'session-started'), false);
    assert.equal(events.some((event) => event.type === 'result' && event.ok), false);
    assert.equal(control.peers[0]?.boundaryChallenges.length, 0);
    assert.equal(control.nativeCloses, 1);
  }

  {
    const control = makeControl('manual');
    control.autoTurnStarted = false;
    const session = await adapterFor(control).createSession(sessionInput());
    const iterator = session.sendTurn('notification re-entry')[Symbol.asyncIterator]();
    assert.equal((await iterator.next()).value?.type, 'session-started');
    const accessor: Record<string, unknown> = {};
    Object.defineProperties(accessor, {
      method: {
        enumerable: true,
        get() {
          void session.dispose();
          return 'turn/started';
        },
      },
      params: {
        enumerable: true,
        value: { threadId: CREATED_THREAD_ID, turn: turn(TURN_ID, 'inProgress') },
      },
    });
    control.peers[0]?.emit(accessor);
    const remaining: RuntimeEvent[] = [];
    for (;;) {
      const next = await iterator.next();
      if (next.done) break;
      remaining.push(next.value);
    }
    assert.equal(remaining.some((event) => event.type === 'session-state'), false);
    assert.equal(remaining.some((event) => event.type === 'delta'), false);
    assert.equal(remaining.some((event) => event.type === 'assistant-block'), false);
    assert.equal(remaining.some((event) => event.type === 'result' && event.ok), false);
    assert.equal(control.peers[0]?.boundaryChallenges.length, 0);
    assert.equal(control.nativeCloses, 1);
  }
});

test('Codex text lifecycle is ordered, correlated, redacted, and exactly terminal', async () => {
  const control = makeControl('receipts');
  const adapter = adapterFor(control);
  const session = await adapter.createSession(sessionInput());
  const events = await collectEvents(session.sendTurn('provider-free input'));
  assert.deepEqual(events.map((event) => event.type), [
    'session-started',
    'session-state',
    'delta',
    'delta',
    'delta',
    'delta',
    'assistant-block',
    'session-state',
    'result',
  ]);
  const firstDelta = events[2];
  assert.equal(firstDelta?.type, 'delta');
  if (firstDelta?.type !== 'delta') assert.fail('canonical message start missing');
  const canonicalItemId = firstDelta.itemId;
  assert.match(
    canonicalItemId,
    /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu,
  );
  assert.notEqual(canonicalItemId, AGENT_ITEM_ID);
  assert.deepEqual(events.slice(2, 6), [
    {
      type: 'delta',
      itemId: canonicalItemId,
      scope: 'primary',
      delta: { kind: 'message-start' },
    },
    {
      type: 'delta',
      itemId: canonicalItemId,
      scope: 'primary',
      delta: { kind: 'text-delta', text: 'provider-free ' },
    },
    {
      type: 'delta',
      itemId: canonicalItemId,
      scope: 'primary',
      delta: { kind: 'text-delta', text: 'Codex response' },
    },
    {
      type: 'delta',
      itemId: canonicalItemId,
      scope: 'primary',
      delta: { kind: 'message-end' },
    },
  ]);
  assert.deepEqual(events[6], {
    type: 'assistant-block',
    itemId: canonicalItemId,
    scope: 'primary',
    block: { kind: 'text', text: EXPECTED_TEXT },
  });
  const terminals = events.filter((event) => event.type === 'result');
  assert.equal(terminals.length, 1);
  assert.deepEqual(terminals[0], {
    type: 'result',
    ok: true,
    stopReason: 'complete',
    usage: null,
    durationMs: 10,
    numTurns: null,
    error: null,
    outcome: 'ok',
  });
  const publicFrames = JSON.stringify(events.slice(1));
  assert.doesNotMatch(publicFrames, new RegExp(TURN_ID, 'u'));
  assert.doesNotMatch(publicFrames, new RegExp(AGENT_ITEM_ID, 'u'));
  assert.doesNotMatch(publicFrames, /PRIVATE NATIVE|ADDITIONAL DETAILS|reasoning/iu);
  assert.deepEqual(control.peers[0]?.boundaryChallenges, [{
    kind: 'provider-free-turn-boundary-challenge',
    protocolVersion: CODEX_PROTOCOL_VERSION,
    runtimeId: CODEX_RUNTIME_ID,
    continuationAttemptId: 'codex-provider-free-attempt',
    threadId: CREATED_THREAD_ID,
    turnId: TURN_ID,
    turnSequence: 1,
    status: 'completed',
  }]);
  assert.deepEqual(await session.observeContext(), EXPECTED_CONTEXT);
  await session.dispose();
});

test('Codex sequential turns require fresh native turn and item identities', async () => {
  const control = makeControl('receipts');
  const session = await adapterFor(control).createSession(sessionInput({ maxTurns: 3 }));
  const first = await collectEvents(session.sendTurn('first'));
  const second = await collectEvents(session.sendTurn('second'));
  assert.equal(first.at(-1)?.type, 'result');
  assert.equal(second.at(-1)?.type, 'result');
  assert.equal(control.turnStarts, 2);
  assert.deepEqual(
    control.peers[0]?.boundaryChallenges.map((challenge) => ({
      turnId: (challenge as CodexTurnBoundaryChallenge).turnId,
      turnSequence: (challenge as CodexTurnBoundaryChallenge).turnSequence,
    })),
    [
      { turnId: TURN_ID, turnSequence: 1 },
      { turnId: nativeSequenceId(5), turnSequence: 2 },
    ],
  );
  const itemIds = [...first, ...second]
    .filter((event): event is Extract<RuntimeEvent, { type: 'assistant-block' }> => (
      event.type === 'assistant-block'
    ))
    .map((event) => event.itemId);
  assert.equal(new Set(itemIds).size, 2);
  await session.dispose();
});

test('Codex result delivery releases the turn without requiring an extra iterator next', async () => {
  const control = makeControl('receipts');
  const session = await adapterFor(control).createSession(sessionInput({ maxTurns: 3 }));
  const firstIterator = session.sendTurn('first terminal')[Symbol.asyncIterator]();
  for (;;) {
    const next = await firstIterator.next();
    assert.equal(next.done, false);
    if (!next.done && next.value.type === 'result') {
      assert.equal(next.value.ok, true);
      break;
    }
  }
  await assert.rejects(() => session.interrupt(), /interrupt-unavailable/u);
  const second = await collectEvents(session.sendTurn('immediate successor'));
  assert.equal(second.some((event) => event.type === 'result' && event.ok), true);
  assert.equal(control.interruptAcceptances, 0);
  await firstIterator.return?.();
  await session.dispose();
});

test('Codex fences peer reuse while notification iterator cleanup is unsettled', async () => {
  const control = makeControl('receipts');
  control.deferNotificationReturn = deferred();
  const session = await adapterFor(control).createSession(sessionInput({ maxTurns: 3 }));
  const events = await collectEvents(session.sendTurn('deferred iterator close'));
  assert.equal(events.some((event) => event.type === 'result' && event.ok), true);
  assert.throws(() => session.sendTurn('cleanup still pending'), /session-unavailable/u);
  assert.equal(control.turnStarts, 1);

  control.deferNotificationReturn.resolve();
  await new Promise<void>((resolvePromise) => setImmediate(resolvePromise));
  const successor = await collectEvents(session.sendTurn('cleanup settled'));
  assert.equal(successor.some((event) => event.type === 'result' && event.ok), true);
  await session.dispose();
});

test('Codex failed notification iterator cleanup poisons and disposes peer reuse', async () => {
  const control = makeControl('receipts');
  control.rejectNotificationReturn = true;
  const session = await adapterFor(control).createSession(sessionInput({ maxTurns: 3 }));
  const events = await collectEvents(session.sendTurn('rejected iterator close'));
  assert.equal(events.some((event) => event.type === 'result' && event.ok), true);
  await Promise.resolve();
  assert.throws(() => session.sendTurn('must not reuse uncertain subscription'));
  assert.equal(control.turnStarts, 1);
  assert.equal(control.nativeCloses, 1);
});

test('Codex rejects reused native turn identities and stale prior-turn frames', async () => {
  const reused = makeControl('receipts');
  reused.reuseTurnId = true;
  const reusedSession = await adapterFor(reused).createSession(sessionInput({ maxTurns: 3 }));
  assert.equal((await collectEvents(reusedSession.sendTurn('first'))).at(-1)?.type, 'result');
  const reusedEvents = await collectEvents(reusedSession.sendTurn('reused turn id'));
  assert.equal(reusedEvents.at(-1)?.type, 'result');
  assert.equal(
    reusedEvents.some((event) => event.type === 'result' && event.ok),
    false,
  );
  assert.equal(reused.nativeCloses, 1);

  const reusedItem = makeControl('receipts');
  reusedItem.reuseItemId = true;
  const reusedItemSession = await adapterFor(reusedItem).createSession(sessionInput({ maxTurns: 3 }));
  await collectEvents(reusedItemSession.sendTurn('first item'));
  const reusedItemEvents = await collectEvents(reusedItemSession.sendTurn('reused item id'));
  assert.equal(reusedItemEvents.some((event) => event.type === 'result' && event.ok), false);
  assert.equal(reusedItem.nativeCloses, 1);

  const stale = makeControl('manual');
  const staleSession = await adapterFor(stale).createSession(sessionInput({ maxTurns: 3 }));
  const firstIterator = staleSession.sendTurn('first manual')[Symbol.asyncIterator]();
  assert.equal((await firstIterator.next()).value?.type, 'session-started');
  const peer = stale.peers[0];
  assert.ok(peer);
  const firstItem = agentMessage(AGENT_ITEM_ID, 'first public');
  peer.emit(itemStarted(CREATED_THREAD_ID, TURN_ID, agentMessage(AGENT_ITEM_ID, '')));
  peer.emit(itemCompleted(CREATED_THREAD_ID, TURN_ID, firstItem));
  peer.emit(turnCompleted(CREATED_THREAD_ID, TURN_ID, 'completed', [firstItem]));
  for (;;) {
    const next = await firstIterator.next();
    if (next.done) break;
  }

  const secondIterator = staleSession.sendTurn('second manual')[Symbol.asyncIterator]();
  assert.equal((await secondIterator.next()).value?.type, 'session-state');
  peer.emit(agentDelta(CREATED_THREAD_ID, TURN_ID, AGENT_ITEM_ID, 'PRIVATE stale frame'));
  const secondEvents: RuntimeEvent[] = [];
  for (;;) {
    const next = await secondIterator.next();
    if (next.done) break;
    secondEvents.push(next.value);
  }
  assert.equal(secondEvents.at(-1)?.type, 'result');
  assert.equal(secondEvents.some((event) => event.type === 'result' && event.ok), false);
  assert.doesNotMatch(JSON.stringify(secondEvents), /PRIVATE stale frame/iu);
  assert.equal(stale.nativeCloses, 1);
});

test('Codex duplicate or conflicting terminal cannot pass the closed turn boundary', async () => {
  const control = makeControl('receipts');
  control.terminalTail = [turnCompleted(CREATED_THREAD_ID, TURN_ID, 'failed')];
  const session = await adapterFor(control).createSession(sessionInput());
  const events = await collectEvents(session.sendTurn('duplicate terminal test'));
  const terminals = events.filter((event) => event.type === 'result');
  assert.deepEqual(terminals, [{
    type: 'result',
    ok: false,
    stopReason: null,
    usage: null,
    durationMs: null,
    numTurns: null,
    error: 'runtime unavailable',
    outcome: 'error',
  }]);
  assert.equal(events.at(-1), terminals[0]);
  assert.equal(events.some((event) => event.type === 'result' && event.ok), false);
  assert.equal(control.peers[0]?.notificationsQueue.pendingCount(), 1);
  assert.equal(control.nativeCloses, 1);
  assert.doesNotMatch(JSON.stringify(events), /PRIVATE NATIVE|ADDITIONAL DETAILS/iu);
  assert.throws(() => session.sendTurn('post-conflict turn'));
});

test('Codex authority atomically seals the turn epoch before a success receipt', async () => {
  const control = makeControl('receipts');
  control.deferTurnBoundary = deferred();
  const session = await adapterFor(control).createSession(sessionInput());
  const pending = collectEvents(session.sendTurn('atomic boundary'));
  await control.turnBoundaryReady.promise;
  await assert.rejects(() => session.interrupt(), /interrupt-unavailable/u);
  assert.equal(control.interruptAcceptances, 0);
  assert.throws(
    () => control.peers[0]?.emit(turnCompleted(CREATED_THREAD_ID, TURN_ID, 'failed')),
    /epoch is sealed/u,
  );
  control.deferTurnBoundary.resolve();
  const events = await pending;
  assert.equal(events.filter((event) => event.type === 'result').length, 1);
  assert.equal(events.some((event) => event.type === 'result' && event.ok), true);
  assert.equal(control.peers[0]?.notificationsQueue.iteratorReturnCount(), 1);
  await session.dispose();
});

test('Codex terminal observation promptly fences an already pending interrupt', async () => {
  const control = makeControl('receipts');
  control.deferTurnBoundary = deferred();
  control.deferInterrupt = deferred();
  const session = await adapterFor(control).createSession(sessionInput());
  const iterator = session.sendTurn('pending interrupt fence')[Symbol.asyncIterator]();
  assert.equal((await iterator.next()).value?.type, 'session-started');
  assert.deepEqual((await iterator.next()).value, {
    type: 'session-state',
    state: 'running',
    permissionMode: null,
  });

  const interrupting = session.interrupt();
  await control.interruptEntered.promise;
  const remaining = (async () => {
    const events: RuntimeEvent[] = [];
    for (;;) {
      const next = await iterator.next();
      if (next.done) return events;
      events.push(next.value);
    }
  })();
  await control.turnBoundaryReady.promise;
  await assert.rejects(() => interrupting, /interrupt-unavailable/u);
  assert.equal(control.interruptAcceptances, 1);
  control.deferTurnBoundary.resolve();
  const events = await remaining;
  assert.equal(events.some((event) => event.type === 'result' && event.ok), true);
  control.deferInterrupt.resolve();
  await session.dispose();
});

test('Codex disposal racing a deferred turn boundary can never mint success', async () => {
  const control = makeControl('receipts');
  control.deferTurnBoundary = deferred();
  const session = await adapterFor(control).createSession(sessionInput());
  const pending = collectEvents(session.sendTurn('settlement race'));
  await control.turnBoundaryReady.promise;
  await session.dispose();
  const events = await pending;
  control.deferTurnBoundary.resolve();
  assert.equal(events.some((event) => event.type === 'result' && event.ok), false);
  assert.deepEqual(
    events.filter((event) => event.type === 'session-state').map((event) => event.state),
    ['running', 'idle'],
  );
  assert.deepEqual(events.at(-1), {
    type: 'result',
    ok: false,
    stopReason: null,
    usage: null,
    durationMs: null,
    numTurns: null,
    error: 'runtime unavailable',
    outcome: 'error',
  });
  assert.equal(control.nativeCloses, 1);
});

test('Codex wrong correlation fails closed once and fences late native frames', async () => {
  const control = makeControl('manual');
  const adapter = adapterFor(control);
  const session = await adapter.createSession(sessionInput());
  const iterator = session.sendTurn('correlation test')[Symbol.asyncIterator]();
  assert.equal((await iterator.next()).value?.type, 'session-started');
  const peer = control.peers[0];
  assert.ok(peer);
  peer.emit(agentDelta('01900100-0000-7000-8000-000000000099', TURN_ID, AGENT_ITEM_ID, 'PRIVATE'));
  peer.emit(turnCompleted(CREATED_THREAD_ID, TURN_ID, 'completed'));
  const remaining: RuntimeEvent[] = [];
  for (;;) {
    const next = await iterator.next();
    if (next.done) break;
    remaining.push(next.value);
  }
  const terminals = remaining.filter((event) => event.type === 'result');
  assert.deepEqual(terminals, [{
    type: 'result',
    ok: false,
    stopReason: null,
    usage: null,
    durationMs: null,
    numTurns: null,
    error: 'runtime unavailable',
    outcome: 'error',
  }]);
  assert.doesNotMatch(JSON.stringify(remaining), /000000000099|PRIVATE/iu);
  assert.equal(control.nativeCloses, 1);
  assert.throws(() => session.sendTurn('late turn'));
  assert.deepEqual(await session.observeContext(), EXPECTED_CONTEXT);
  await session.dispose();
  assert.equal(control.nativeCloses, 1);
});

test('Codex lifecycle ordering and identity violations each close through one safe terminal', async () => {
  const wrongThread = '01900100-0000-7000-8000-000000000099';
  const wrongTurn = '01900100-0000-7000-8000-000000000098';
  const wrongItem = '01900100-0000-7000-8000-000000000097';
  const cases: Array<{
    label: string;
    autoTurnStarted?: boolean;
    frames: () => unknown[];
  }> = [
    {
      label: 'item before turn start',
      autoTurnStarted: false,
      frames: () => [itemStarted(
        CREATED_THREAD_ID,
        TURN_ID,
        agentMessage(AGENT_ITEM_ID, ''),
      )],
    },
    {
      label: 'terminal before turn start',
      autoTurnStarted: false,
      frames: () => [turnCompleted(CREATED_THREAD_ID, TURN_ID, 'interrupted')],
    },
    {
      label: 'duplicate turn start',
      frames: () => [turnStarted(CREATED_THREAD_ID, TURN_ID)],
    },
    {
      label: 'delta before item start',
      frames: () => [agentDelta(
        CREATED_THREAD_ID,
        TURN_ID,
        AGENT_ITEM_ID,
        'PRIVATE native delta',
      )],
    },
    {
      label: 'duplicate item start',
      frames: () => [
        itemStarted(CREATED_THREAD_ID, TURN_ID, agentMessage(AGENT_ITEM_ID, '')),
        itemStarted(CREATED_THREAD_ID, TURN_ID, agentMessage(AGENT_ITEM_ID, '')),
      ],
    },
    {
      label: 'wrong thread',
      frames: () => [agentDelta(wrongThread, TURN_ID, AGENT_ITEM_ID, 'PRIVATE')],
    },
    {
      label: 'wrong turn',
      frames: () => [agentDelta(CREATED_THREAD_ID, wrongTurn, AGENT_ITEM_ID, 'PRIVATE')],
    },
    {
      label: 'wrong item',
      frames: () => [
        itemStarted(CREATED_THREAD_ID, TURN_ID, agentMessage(AGENT_ITEM_ID, '')),
        agentDelta(CREATED_THREAD_ID, TURN_ID, wrongItem, 'PRIVATE'),
      ],
    },
    {
      label: 'completed text differs from deltas',
      frames: () => [
        itemStarted(CREATED_THREAD_ID, TURN_ID, agentMessage(AGENT_ITEM_ID, '')),
        agentDelta(CREATED_THREAD_ID, TURN_ID, AGENT_ITEM_ID, 'public fragment'),
        itemCompleted(
          CREATED_THREAD_ID,
          TURN_ID,
          agentMessage(AGENT_ITEM_ID, 'PRIVATE conflicting completion'),
        ),
      ],
    },
    {
      label: 'success terminal lacks completed item',
      frames: () => [turnCompleted(CREATED_THREAD_ID, TURN_ID, 'completed')],
    },
    {
      label: 'terminal snapshot omits streamed completion',
      frames: () => [
        itemStarted(CREATED_THREAD_ID, TURN_ID, agentMessage(AGENT_ITEM_ID, '')),
        itemCompleted(CREATED_THREAD_ID, TURN_ID, agentMessage(AGENT_ITEM_ID, 'safe')),
        turnCompleted(CREATED_THREAD_ID, TURN_ID, 'completed', []),
      ],
    },
    {
      label: 'terminal snapshot has wrong item identity',
      frames: () => [
        itemStarted(CREATED_THREAD_ID, TURN_ID, agentMessage(AGENT_ITEM_ID, '')),
        itemCompleted(CREATED_THREAD_ID, TURN_ID, agentMessage(AGENT_ITEM_ID, 'safe')),
        turnCompleted(CREATED_THREAD_ID, TURN_ID, 'completed', [agentMessage(wrongItem, 'safe')]),
      ],
    },
    {
      label: 'terminal snapshot has wrong text',
      frames: () => [
        itemStarted(CREATED_THREAD_ID, TURN_ID, agentMessage(AGENT_ITEM_ID, '')),
        itemCompleted(CREATED_THREAD_ID, TURN_ID, agentMessage(AGENT_ITEM_ID, 'safe')),
        turnCompleted(CREATED_THREAD_ID, TURN_ID, 'completed', [
          agentMessage(AGENT_ITEM_ID, 'PRIVATE conflicting terminal'),
        ]),
      ],
    },
    {
      label: 'terminal snapshot has extra item',
      frames: () => [
        itemStarted(CREATED_THREAD_ID, TURN_ID, agentMessage(AGENT_ITEM_ID, '')),
        itemCompleted(CREATED_THREAD_ID, TURN_ID, agentMessage(AGENT_ITEM_ID, 'safe')),
        turnCompleted(CREATED_THREAD_ID, TURN_ID, 'completed', [
          agentMessage(AGENT_ITEM_ID, 'safe'),
          agentMessage(wrongItem, 'PRIVATE extra terminal item'),
        ]),
      ],
    },
    {
      label: 'warning method',
      frames: () => [{ method: 'warning', params: { message: 'PRIVATE provider warning' } }],
    },
  ];

  for (const entry of cases) {
    const control = makeControl('manual');
    control.autoTurnStarted = entry.autoTurnStarted ?? true;
    const session = await adapterFor(control).createSession(sessionInput());
    const iterator = session.sendTurn(entry.label)[Symbol.asyncIterator]();
    assert.equal((await iterator.next()).value?.type, 'session-started', entry.label);
    const peer = control.peers[0];
    assert.ok(peer);
    for (const frame of entry.frames()) peer.emit(frame);

    const remaining: RuntimeEvent[] = [];
    for (;;) {
      const next = await iterator.next();
      if (next.done) break;
      remaining.push(next.value);
    }
    const terminals = remaining.filter((event) => event.type === 'result');
    assert.deepEqual(terminals, [{
      type: 'result',
      ok: false,
      stopReason: null,
      usage: null,
      durationMs: null,
      numTurns: null,
      error: 'runtime unavailable',
      outcome: 'error',
    }], entry.label);
    assert.equal(remaining.at(-1), terminals[0], entry.label);
    assert.doesNotMatch(
      JSON.stringify(remaining),
      /PRIVATE|000000000099|000000000098|000000000097/iu,
      entry.label,
    );
    assert.equal(control.nativeCloses, 1, entry.label);
    assert.throws(() => session.sendTurn('late mutation'), /unavailable/iu, entry.label);
  }
});

test('Codex failed terminal drops native error prose and emits one fixed result', async () => {
  const control = makeControl('manual');
  const session = await adapterFor(control).createSession(sessionInput());
  const iterator = session.sendTurn('failed terminal')[Symbol.asyncIterator]();
  assert.equal((await iterator.next()).value?.type, 'session-started');
  control.peers[0]?.emit(turnCompleted(CREATED_THREAD_ID, TURN_ID, 'failed'));
  const remaining: RuntimeEvent[] = [];
  for (;;) {
    const next = await iterator.next();
    if (next.done) break;
    remaining.push(next.value);
  }
  assert.deepEqual(remaining.at(-1), {
    type: 'result',
    ok: false,
    stopReason: null,
    usage: null,
    durationMs: 10,
    numTurns: null,
    error: 'runtime turn failed',
    outcome: 'error',
  });
  assert.equal(remaining.filter((event) => event.type === 'result').length, 1);
  assert.doesNotMatch(JSON.stringify(remaining), /PRIVATE NATIVE|ADDITIONAL DETAILS/iu);
  await session.dispose();
});

test('Codex closes partial message streams and running state before every failure terminal', async () => {
  const cases = [
    { status: 'failed' as const, outcome: 'error', error: 'runtime turn failed' },
    { status: 'interrupted' as const, outcome: 'aborted', error: 'runtime turn interrupted' },
    { status: 'protocol' as const, outcome: 'error', error: 'runtime unavailable' },
  ];
  for (const entry of cases) {
    const control = makeControl('manual');
    const session = await adapterFor(control).createSession(sessionInput());
    const iterator = session.sendTurn(`partial ${entry.status}`)[Symbol.asyncIterator]();
    assert.equal((await iterator.next()).value?.type, 'session-started');
    const peer = control.peers[0];
    assert.ok(peer);
    peer.emit(itemStarted(CREATED_THREAD_ID, TURN_ID, agentMessage(AGENT_ITEM_ID, '')));
    peer.emit(agentDelta(CREATED_THREAD_ID, TURN_ID, AGENT_ITEM_ID, 'public partial'));
    peer.emit(entry.status === 'protocol'
      ? { method: 'warning', params: { message: 'PRIVATE warning' } }
      : turnCompleted(CREATED_THREAD_ID, TURN_ID, entry.status));
    const remaining: RuntimeEvent[] = [];
    for (;;) {
      const next = await iterator.next();
      if (next.done) break;
      remaining.push(next.value);
    }
    const deltaKinds = remaining
      .filter((event): event is Extract<RuntimeEvent, { type: 'delta' }> => event.type === 'delta')
      .map((event) => event.delta.kind);
    assert.deepEqual(deltaKinds, ['message-start', 'text-delta', 'message-end'], entry.status);
    assert.equal(remaining.some((event) => event.type === 'assistant-block'), false, entry.status);
    assert.deepEqual(
      remaining.filter((event) => event.type === 'session-state').map((event) => event.state),
      ['running', 'idle'],
      entry.status,
    );
    const terminal = remaining.at(-1);
    assert.equal(terminal?.type, 'result');
    if (terminal?.type === 'result') {
      assert.equal(terminal.ok, false);
      assert.equal(terminal.outcome, entry.outcome);
      assert.equal(terminal.error, entry.error);
    }
    assert.doesNotMatch(JSON.stringify(remaining), /PRIVATE warning/iu);
  }
});

test('Codex disposal fences provider frames emitted after close', async () => {
  const control = makeControl('dispose');
  control.holdQueueOpenAfterDispose = true;
  const session = await adapterFor(control).createSession(sessionInput());
  const iterator = session.sendTurn('dispose race')[Symbol.asyncIterator]();
  assert.equal((await iterator.next()).value?.type, 'session-started');
  const pending = (async () => {
    const events: RuntimeEvent[] = [];
    for (;;) {
      const next = await iterator.next();
      if (next.done) return events;
      events.push(next.value);
    }
  })();
  await control.blockedTurnReady.promise;
  const disposing = Promise.all([session.dispose(), session.dispose()]);
  control.peers[0]?.emit(itemStarted(
    CREATED_THREAD_ID,
    TURN_ID,
    agentMessage(AGENT_ITEM_ID, ''),
  ));
  await disposing;
  const remaining = await pending;
  assert.deepEqual(remaining.at(-1), {
    type: 'result',
    ok: false,
    stopReason: null,
    usage: null,
    durationMs: null,
    numTurns: null,
    error: 'runtime unavailable',
    outcome: 'error',
  });
  assert.equal(remaining.filter((event) => event.type === 'result').length, 1);
  assert.equal(remaining.some((event) => event.type === 'delta'), false);
  assert.equal(remaining.some((event) => event.type === 'assistant-block'), false);
  const states = remaining
    .filter((event) => event.type === 'session-state')
    .map((event) => event.state);
  assert.ok(
    JSON.stringify(states) === JSON.stringify([]) ||
      JSON.stringify(states) === JSON.stringify(['running', 'idle']),
  );
  assert.equal(control.nativeCloses, 1);
});

test('Codex performs no new notification read after settled disposal', async () => {
  const control = makeControl('manual');
  const session = await adapterFor(control).createSession(sessionInput());
  const iterator = session.sendTurn('read fence')[Symbol.asyncIterator]();
  assert.equal((await iterator.next()).value?.type, 'session-started');
  assert.equal((await iterator.next()).value?.type, 'session-state');
  const queue = control.peers[0]?.notificationsQueue;
  assert.ok(queue);
  await session.dispose();
  const readsAfterDispose = queue.iteratorNextCount();
  const remaining: RuntimeEvent[] = [];
  for (;;) {
    const next = await iterator.next();
    if (next.done) break;
    remaining.push(next.value);
  }
  assert.equal(queue.iteratorNextCount(), readsAfterDispose);
  assert.deepEqual(
    remaining.filter((event) => event.type === 'session-state').map((event) => event.state),
    ['idle'],
  );
  assert.equal(remaining.some((event) => event.type === 'result' && event.ok), false);
  assert.equal(queue.iteratorReturnCount(), 1);
});

test('Codex pre-start abandonment releases its reservation and disposal fences peer mutation', async () => {
  const control = makeControl('manual');
  const session = await adapterFor(control).createSession(sessionInput());
  const abandoned = session.sendTurn('never started')[Symbol.asyncIterator]();
  assert.deepEqual(await abandoned.return?.(), { done: true, value: undefined });
  assert.equal(control.turnStarts, 0);

  const disposedBeforeStart = session.sendTurn('disposed before start');
  await session.dispose();
  const events = await collectEvents(disposedBeforeStart);
  assert.deepEqual(events, [{
    type: 'result',
    ok: false,
    stopReason: null,
    usage: null,
    durationMs: null,
    numTurns: null,
    error: 'runtime unavailable',
    outcome: 'error',
  }]);
  assert.equal(control.turnStarts, 0);
  assert.equal(control.nativeCloses, 1);
});

test('Codex memoizes peer disposal before synchronous re-entry', async () => {
  const control = makeControl('manual');
  let session!: RuntimeSession;
  let reentrant: Promise<void> | null = null;
  control.onDispose = () => {
    reentrant = session.dispose();
  };
  session = await adapterFor(control).createSession(sessionInput());
  await session.dispose();
  if (reentrant !== null) await reentrant;
  assert.equal(control.peerDisposeCalls, 1);
  assert.equal(control.nativeCloses, 1);
});

test('Codex started iterator abandonment cancels a hung turn start without an external wake', async () => {
  const control = makeControl('manual');
  control.deferTurnStart = deferred();
  control.deferDispose = deferred();
  const session = await adapterFor(control).createSession(sessionInput());
  const iterator = session.sendTurn('hung start')[Symbol.asyncIterator]();
  const pendingNext = iterator.next();
  await control.turnStartEntered.promise;
  const pendingReturn = iterator.return?.();
  const first = await pendingNext;
  assert.equal(first.done, false);
  assert.deepEqual(first.value, {
    type: 'result',
    ok: false,
    stopReason: null,
    usage: null,
    durationMs: null,
    numTurns: null,
    error: 'runtime unavailable',
    outcome: 'error',
  });
  assert.deepEqual(await pendingReturn, { done: true, value: undefined });
  assert.equal(control.nativeCloses, 1);
  control.deferDispose.resolve();
  control.deferTurnStart.resolve();
  await Promise.resolve();
});

test('Codex iterator throw finalizes paused running and open-message turns', async () => {
  for (const openMessage of [false, true]) {
    const control = makeControl('manual');
    const session = await adapterFor(control).createSession(sessionInput());
    const iterator = session.sendTurn(`throw ${openMessage}`)[Symbol.asyncIterator]();
    assert.equal((await iterator.next()).value?.type, 'session-started');
    assert.equal((await iterator.next()).value?.type, 'session-state');
    if (openMessage) {
      control.peers[0]?.emit(itemStarted(
        CREATED_THREAD_ID,
        TURN_ID,
        agentMessage(AGENT_ITEM_ID, ''),
      ));
      const messageStart = await iterator.next();
      assert.equal(messageStart.value?.type, 'delta');
    }
    const injected = new Error(`injected iterator failure ${openMessage}`);
    await assert.rejects(
      async () => { await iterator.throw?.(injected); },
      (error: unknown) => error === injected,
    );
    assert.equal(control.nativeCloses, 1);
    assert.deepEqual(await iterator.next(), { done: true, value: undefined });
    assert.throws(() => session.sendTurn('must remain unavailable'), /session-disposed/u);
  }
});
