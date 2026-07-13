import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  isContextObservation,
  isRuntimeCapabilities,
  isRuntimeModelDiscovery,
  isRuntimeSelection,
  isRuntimeSessionReceipt,
  type ContextObservation,
  type RuntimeCapabilities,
  type RuntimeModelDiscovery,
  type RuntimeSelection,
  type SubscriptionQuotaObservationBatch,
} from '@pc/contracts';
import type {
  AgentRuntimeAdapter,
  CreateRuntimeSession,
  ResumeRuntimeSession,
  RuntimeEvent,
  RuntimeSession,
} from '../src/runner/runtime.ts';

export type RuntimeAdapterConformanceScenario =
  | 'discovery'
  | 'receipts'
  | 'interrupt'
  | 'dispose';

/**
 * The small control surface is test-only native coordination, not an adapter
 * extension. It makes interrupt/disposal ordering deterministic while every
 * assertion still goes through public AgentRuntimeAdapter/RuntimeSession APIs.
 */
export interface RuntimeAdapterConformanceFixture {
  readonly adapter: AgentRuntimeAdapter;
  readonly selection: RuntimeSelection;
  readonly missingAccountId: string;
  readonly expectedText: string;
  readonly expectedContext: ContextObservation;
  readonly createdNativeSessionId: string;
  readonly resumedNativeSessionId: string;
  /** Deterministic absolute working directory supplied through the public input. */
  readonly cwd: string;
  readonly blockedTurnReady: Promise<void>;
  releaseInterruptedTurn(): void;
  interruptAcceptanceCount(): number;
  nativeCloseCount(): number;
}

export type RuntimeAdapterConformanceFactory = (
  scenario: RuntimeAdapterConformanceScenario,
) => RuntimeAdapterConformanceFixture | Promise<RuntimeAdapterConformanceFixture>;

export function runtimeAdapterConformance(
  name: string,
  factory: RuntimeAdapterConformanceFactory,
): void {
  test(`${name} adapter conformance: discovery is typed and malformed selection is fenced`, async () => {
    const fixture = await factory('discovery');
    const { adapter, selection } = fixture;
    assert.equal(adapter.id, selection.runtimeId);

    const capabilities = await adapter.capabilities(selection.accountId);
    assert.equal(isRuntimeCapabilities(capabilities), true);
    assert.equal(capabilities.runtimeId, selection.runtimeId);
    assert.equal(capabilities.accountId, selection.accountId);
    assert.equal(capabilities.modelDiscovery.status, 'supported');

    const discovery = await adapter.listModels(selection.accountId);
    assert.equal(isRuntimeModelDiscovery(discovery), true);
    assert.equal(discovery.status, 'available');
    if (discovery.status !== 'available') assert.fail('selected account discovery unavailable');
    const selectedModel = discovery.models.find((model) => model.id === selection.model);
    assert.ok(selectedModel, 'the selected model must be positively discovered');
    if (selection.effort.kind === 'selected') {
      assert.equal(selectedModel.effort.status, 'supported');
      if (selectedModel.effort.status === 'supported') {
        assert.equal(selectedModel.effort.values.includes(selection.effort.value), true);
      }
    }

    const unavailableCapabilities = await adapter.capabilities(fixture.missingAccountId);
    assert.equal(isRuntimeCapabilities(unavailableCapabilities), true);
    assert.equal(unavailableCapabilities.runtimeId, adapter.id);
    assert.equal(unavailableCapabilities.accountId, fixture.missingAccountId);
    assert.equal(unavailableCapabilities.nativeContinuation.status === 'supported', false);
    assert.equal(unavailableCapabilities.modelDiscovery.status === 'supported', false);
    assert.equal(unavailableCapabilities.effortControl.status === 'supported', false);
    assert.equal(unavailableCapabilities.context.currentUse.status === 'supported', false);

    const unavailableDiscovery = await adapter.listModels(fixture.missingAccountId);
    assert.equal(isRuntimeModelDiscovery(unavailableDiscovery), true);
    assert.notEqual(unavailableDiscovery.status, 'available');

    const malformedSelection = cloneSelection(selection);
    malformedSelection.model = ` ${malformedSelection.model} `;
    await assert.rejects(() => adapter.createSession({
      appSessionId: `${name}-malformed`,
      projectId: 'conformance-project',
      continuationAttemptId: 'conformance-malformed-attempt',
      selection: malformedSelection,
      cwd: fixture.cwd,
    }));
  });

  test(`${name} adapter conformance: create/resume receipts, text terminal, and context are exact`, async () => {
    const fixture = await factory('receipts');
    const expectedSelection = cloneSelection(fixture.selection);

    const createSelection = cloneSelection(fixture.selection);
    const createInput: CreateRuntimeSession = {
      appSessionId: `${name}-created`,
      projectId: 'conformance-project',
      continuationAttemptId: 'conformance-create-attempt',
      selection: createSelection,
      cwd: fixture.cwd,
    };
    const pendingCreate = fixture.adapter.createSession(createInput);
    mutateSubmittedSelection(createSelection);
    createInput.continuationAttemptId = 'mutated-create-attempt';
    const created = await pendingCreate;
    const createdEvents = await collectEvents(created.sendTurn('one conformance turn'));
    assertCompletedTurn(createdEvents, fixture.expectedText, {
      mode: 'created',
      continuationAttemptId: 'conformance-create-attempt',
      selection: expectedSelection,
      nativeSessionId: fixture.createdNativeSessionId,
      requestedNativeSessionId: null,
    });

    const context = await created.observeContext();
    assert.equal(isContextObservation(context), true);
    assert.deepEqual(context, fixture.expectedContext);
    await created.dispose();

    const resumeSelection = cloneSelection(fixture.selection);
    const resumeInput: ResumeRuntimeSession = {
      appSessionId: `${name}-resumed`,
      projectId: 'conformance-project',
      continuationAttemptId: 'conformance-resume-attempt',
      selection: resumeSelection,
      nativeSessionId: fixture.resumedNativeSessionId,
      cwd: fixture.cwd,
    };
    const pendingResume = fixture.adapter.resumeSession(resumeInput);
    mutateSubmittedSelection(resumeSelection);
    resumeInput.continuationAttemptId = 'mutated-resume-attempt';
    resumeInput.nativeSessionId = 'mutated-native-session';
    const resumed = await pendingResume;
    const resumedEvents = await collectEvents(resumed.sendTurn('one resumed conformance turn'));
    assertCompletedTurn(resumedEvents, fixture.expectedText, {
      mode: 'resumed',
      continuationAttemptId: 'conformance-resume-attempt',
      selection: expectedSelection,
      nativeSessionId: fixture.resumedNativeSessionId,
      requestedNativeSessionId: fixture.resumedNativeSessionId,
    });
    await resumed.dispose();
  });

  test(`${name} adapter conformance: interrupt acceptance is not terminal proof`, async () => {
    const fixture = await factory('interrupt');
    const session = await fixture.adapter.createSession({
      appSessionId: `${name}-interrupt`,
      projectId: 'conformance-project',
      continuationAttemptId: 'conformance-interrupt-attempt',
      selection: cloneSelection(fixture.selection),
      cwd: fixture.cwd,
    });
    const iterator = session.sendTurn('interrupt this turn')[Symbol.asyncIterator]();
    const started = await iterator.next();
    assert.equal(started.done, false);
    assert.equal(started.value?.type, 'session-started');

    const pendingTerminal = scanToResultTerminal(iterator);
    await fixture.blockedTurnReady;
    await session.interrupt();
    assert.equal(fixture.interruptAcceptanceCount(), 1);

    let terminalSettled = false;
    void pendingTerminal.then(
      () => { terminalSettled = true; },
      () => { terminalSettled = true; },
    );
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.equal(
      terminalSettled,
      false,
      'interrupt command acceptance cannot manufacture the correlated terminal',
    );

    fixture.releaseInterruptedTurn();
    const terminal = await pendingTerminal;
    assert.equal(terminal.ok, false);
    assert.equal(terminal.outcome, 'aborted');
    assert.equal((await iterator.next()).done, true);
    await session.dispose();
  });

  test(`${name} adapter conformance: disposal is idempotent and fences mutation`, async () => {
    const fixture = await factory('dispose');
    const session = await fixture.adapter.createSession({
      appSessionId: `${name}-dispose`,
      projectId: 'conformance-project',
      continuationAttemptId: 'conformance-dispose-attempt',
      selection: cloneSelection(fixture.selection),
      cwd: fixture.cwd,
    });
    const iterator = session.sendTurn('dispose this turn')[Symbol.asyncIterator]();
    assert.equal((await iterator.next()).value?.type, 'session-started');
    const pendingTerminal = scanToResultTerminal(iterator);
    await fixture.blockedTurnReady;

    await Promise.all([session.dispose(), session.dispose(), session.dispose()]);
    assert.equal(fixture.nativeCloseCount(), 1);
    const terminal = await pendingTerminal;
    assert.equal(terminal.ok, false);
    assert.equal((await iterator.next()).done, true);

    assert.throws(() => session.sendTurn('late mutation'));
    const context = await session.observeContext();
    assert.equal(isContextObservation(context), true);
    assert.deepEqual(context, { confidence: 'unavailable', reason: 'runtime-unavailable' });
    await session.dispose();
    assert.equal(fixture.nativeCloseCount(), 1);
  });
}

interface ExpectedReceipt {
  readonly mode: 'created' | 'resumed';
  readonly continuationAttemptId: string;
  readonly selection: RuntimeSelection;
  readonly nativeSessionId: string;
  readonly requestedNativeSessionId: string | null;
}

function assertCompletedTurn(
  events: RuntimeEvent[],
  expectedText: string,
  expectedReceipt: ExpectedReceipt,
): void {
  assert.equal(events[0]?.type, 'session-started');
  if (events[0]?.type !== 'session-started') assert.fail('native session receipt missing');
  assert.equal(isRuntimeSessionReceipt(events[0].receipt), true);
  assert.deepEqual(events[0].receipt, expectedReceipt);

  const text = events.filter((event): event is Extract<
    RuntimeEvent,
    { type: 'assistant-block' }
  > => event.type === 'assistant-block');
  assert.equal(text.length, 1);
  assert.equal(text[0]?.scope, 'primary');
  assert.deepEqual(text[0]?.block, { kind: 'text', text: expectedText });

  const terminals = events.filter((event): event is Extract<
    RuntimeEvent,
    { type: 'result' }
  > => event.type === 'result');
  assert.equal(terminals.length, 1);
  assert.equal(terminals[0]?.ok, true);
  assert.equal(terminals[0]?.outcome, 'ok');
  assert.equal(events.at(-1), terminals[0], 'the one terminal must end the turn stream');
  assertClosedMessageStreams(events);
}

async function collectEvents(stream: AsyncIterable<RuntimeEvent>): Promise<RuntimeEvent[]> {
  const events: RuntimeEvent[] = [];
  for await (const event of stream) events.push(event);
  return events;
}

async function scanToResultTerminal(
  iterator: AsyncIterator<RuntimeEvent>,
): Promise<Extract<RuntimeEvent, { type: 'result' }>> {
  const observed: RuntimeEvent[] = [];
  for (;;) {
    const next = await iterator.next();
    assert.equal(next.done, false, 'turn stream ended without a correlated result terminal');
    if (next.done) assert.fail('turn stream ended without a correlated result terminal');
    observed.push(next.value);
    if (next.value.type === 'result') {
      assertClosedMessageStreams(observed);
      return next.value;
    }
  }
}

function assertClosedMessageStreams(events: readonly RuntimeEvent[]): void {
  const open = new Set<string>();
  for (const event of events) {
    if (event.type !== 'delta') continue;
    if (event.delta.kind === 'message-start') {
      assert.equal(open.has(event.itemId), false, 'message stream started twice');
      open.add(event.itemId);
    } else if (event.delta.kind === 'message-end') {
      assert.equal(open.delete(event.itemId), true, 'message stream ended without a start');
    } else {
      assert.equal(open.has(event.itemId), true, 'text delta arrived outside a message stream');
    }
  }
  assert.deepEqual([...open], [], 'a message stream remained open at the result terminal');
}

function cloneSelection(selection: RuntimeSelection): RuntimeSelection {
  return {
    runtimeId: selection.runtimeId,
    accountId: selection.accountId,
    model: selection.model,
    effort: selection.effort.kind === 'selected'
      ? { kind: 'selected', value: selection.effort.value }
      : { kind: selection.effort.kind },
  };
}

function mutateSubmittedSelection(selection: RuntimeSelection): void {
  selection.accountId = 'mutated-account';
  selection.model = 'mutated-model';
  if (selection.effort.kind === 'selected') selection.effort.value = 'mutated-effort';
}

interface Deferred {
  readonly promise: Promise<void>;
  resolve(): void;
}

function deferred(): Deferred {
  let resolvePromise!: () => void;
  let settled = false;
  const promise = new Promise<void>((resolve) => { resolvePromise = resolve; });
  return {
    promise,
    resolve() {
      if (settled) return;
      settled = true;
      resolvePromise();
    },
  };
}

interface GenericControl {
  readonly scenario: RuntimeAdapterConformanceScenario;
  readonly blocked: Deferred;
  readonly interruptedTerminal: Deferred;
  readonly disposedTerminal: Deferred;
  interruptAcceptances: number;
  nativeCloses: number;
}

const GENERIC_RUNTIME_ID = 'generic-conformance-runtime';
const GENERIC_ACCOUNT_ID = 'generic-account';
const GENERIC_MODEL_ID = 'generic-model';
const GENERIC_CREATED_NATIVE_ID = 'generic-created-native';
const GENERIC_RESUMED_NATIVE_ID = 'generic-resumed-native';
const GENERIC_TEXT = 'generic conformance response';
const GENERIC_CONTEXT: ContextObservation = {
  confidence: 'exact',
  usedTokens: 12,
  usableTokens: 100,
  contextWindowTokens: 100,
};

class GenericConformanceAdapter implements AgentRuntimeAdapter {
  readonly id = GENERIC_RUNTIME_ID;

  constructor(private readonly control: GenericControl) {}

  async capabilities(accountId: string): Promise<RuntimeCapabilities> {
    if (accountId !== GENERIC_ACCOUNT_ID) return unavailableCapabilities(accountId);
    return {
      runtimeId: this.id,
      accountId,
      nativeContinuation: { status: 'supported' },
      modelDiscovery: { status: 'supported' },
      effortControl: { status: 'supported' },
      context: {
        currentUse: { status: 'supported', confidences: ['exact'] },
        compaction: { status: 'supported' },
      },
      subscriptionQuota: { status: 'unsupported', code: 'generic-quota-unsupported' },
    };
  }

  async listModels(accountId: string): Promise<RuntimeModelDiscovery> {
    if (accountId !== GENERIC_ACCOUNT_ID) {
      return { status: 'unavailable', code: 'account-unavailable' };
    }
    return {
      status: 'available',
      models: [{
        id: GENERIC_MODEL_ID,
        resolvedId: null,
        label: 'Generic model',
        description: '',
        effort: { status: 'supported', values: ['low', 'high'] },
      }],
    };
  }

  async observeSubscriptionQuota(
    accountId: string,
  ): Promise<SubscriptionQuotaObservationBatch> {
    return {
      runtimeId: this.id,
      accountId,
      availability: 'unavailable',
      reason: 'unsupported',
      observedAt: 0,
    };
  }

  async createSession(input: CreateRuntimeSession): Promise<RuntimeSession> {
    const captured = this.capture(input);
    await Promise.resolve();
    return new GenericConformanceSession(
      this.control,
      captured,
      'created',
      GENERIC_CREATED_NATIVE_ID,
      null,
    );
  }

  async resumeSession(input: ResumeRuntimeSession): Promise<RuntimeSession> {
    const requestedNativeSessionId = exactString(input?.nativeSessionId)
      ? input.nativeSessionId
      : null;
    if (requestedNativeSessionId === null) throw new Error('native session identity unavailable');
    const captured = this.capture(input);
    await Promise.resolve();
    return new GenericConformanceSession(
      this.control,
      captured,
      'resumed',
      requestedNativeSessionId,
      requestedNativeSessionId,
    );
  }

  private capture(input: CreateRuntimeSession): {
    continuationAttemptId: string;
    selection: RuntimeSelection;
  } {
    if (
      !isRuntimeSelection(input?.selection) ||
      input.selection.runtimeId !== this.id ||
      input.selection.accountId !== GENERIC_ACCOUNT_ID ||
      input.selection.model !== GENERIC_MODEL_ID ||
      input.selection.effort.kind !== 'selected' ||
      !['low', 'high'].includes(input.selection.effort.value) ||
      !exactString(input?.continuationAttemptId)
    ) {
      throw new Error('runtime selection unavailable');
    }
    return {
      continuationAttemptId: input.continuationAttemptId,
      selection: cloneSelection(input.selection),
    };
  }
}

class GenericConformanceSession implements RuntimeSession {
  private disposed = false;
  private active = false;
  private completed = false;

  constructor(
    private readonly control: GenericControl,
    private readonly captured: {
      continuationAttemptId: string;
      selection: RuntimeSelection;
    },
    private readonly mode: 'created' | 'resumed',
    private readonly nativeSessionId: string,
    private readonly requestedNativeSessionId: string | null,
  ) {}

  sendTurn(text: string): AsyncIterable<RuntimeEvent> {
    if (this.disposed) throw new Error('generic runtime disposed');
    if (this.active) throw new Error('generic runtime turn already active');
    if (!exactString(text)) throw new Error('generic runtime text unavailable');
    this.active = true;
    return this.turn();
  }

  async observeContext(): Promise<ContextObservation> {
    return this.disposed || this.active || !this.completed
      ? { confidence: 'unavailable', reason: 'runtime-unavailable' }
      : { ...GENERIC_CONTEXT };
  }

  async interrupt(): Promise<void> {
    if (this.disposed || !this.active) throw new Error('generic runtime not interruptible');
    this.control.interruptAcceptances += 1;
  }

  async dispose(): Promise<void> {
    if (this.disposed) return;
    this.disposed = true;
    this.control.nativeCloses += 1;
    this.control.disposedTerminal.resolve();
  }

  private async *turn(): AsyncGenerator<RuntimeEvent, void> {
    try {
      yield {
        type: 'session-started',
        receipt: {
          mode: this.mode,
          continuationAttemptId: this.captured.continuationAttemptId,
          selection: cloneSelection(this.captured.selection),
          nativeSessionId: this.nativeSessionId,
          requestedNativeSessionId: this.requestedNativeSessionId,
        },
      };

      if (this.control.scenario === 'interrupt') {
        this.control.blocked.resolve();
        await this.control.interruptedTerminal.promise;
        yield failedResult('aborted', 'runtime turn aborted');
        return;
      }
      if (this.control.scenario === 'dispose') {
        this.control.blocked.resolve();
        await this.control.disposedTerminal.promise;
        yield failedResult('error', 'session disposed');
        return;
      }

      yield {
        type: 'assistant-block',
        itemId: 'generic-item-1',
        scope: 'primary',
        block: { kind: 'text', text: GENERIC_TEXT },
      };
      yield {
        type: 'result',
        ok: true,
        stopReason: 'complete',
        usage: null,
        durationMs: null,
        error: null,
        outcome: 'ok',
        numTurns: 1,
      };
      this.completed = true;
    } finally {
      this.active = false;
    }
  }
}

function failedResult(
  outcome: 'error' | 'aborted',
  error: string,
): Extract<RuntimeEvent, { type: 'result' }> {
  return {
    type: 'result',
    ok: false,
    stopReason: null,
    usage: null,
    durationMs: null,
    error,
    outcome,
    numTurns: null,
  };
}

function unavailableCapabilities(accountId: string): RuntimeCapabilities {
  const unavailable = { status: 'unavailable' as const, code: 'account-unavailable' };
  return {
    runtimeId: GENERIC_RUNTIME_ID,
    accountId,
    nativeContinuation: unavailable,
    modelDiscovery: unavailable,
    effortControl: unavailable,
    context: { currentUse: unavailable, compaction: unavailable },
    subscriptionQuota: unavailable,
  };
}

function exactString(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && value === value.trim();
}

export const genericRuntimeAdapterConformanceFixture: RuntimeAdapterConformanceFactory = (
  scenario,
) => {
  const blocked = deferred();
  const interruptedTerminal = deferred();
  const disposedTerminal = deferred();
  const control: GenericControl = {
    scenario,
    blocked,
    interruptedTerminal,
    disposedTerminal,
    interruptAcceptances: 0,
    nativeCloses: 0,
  };
  return {
    adapter: new GenericConformanceAdapter(control),
    selection: {
      runtimeId: GENERIC_RUNTIME_ID,
      accountId: GENERIC_ACCOUNT_ID,
      model: GENERIC_MODEL_ID,
      effort: { kind: 'selected', value: 'high' },
    },
    missingAccountId: 'generic-missing-account',
    expectedText: GENERIC_TEXT,
    expectedContext: { ...GENERIC_CONTEXT },
    createdNativeSessionId: GENERIC_CREATED_NATIVE_ID,
    resumedNativeSessionId: GENERIC_RESUMED_NATIVE_ID,
    cwd: process.cwd(),
    blockedTurnReady: blocked.promise,
    releaseInterruptedTurn: () => interruptedTerminal.resolve(),
    interruptAcceptanceCount: () => control.interruptAcceptances,
    nativeCloseCount: () => control.nativeCloses,
  };
};
