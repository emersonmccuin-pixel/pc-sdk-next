import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  RuntimeRegistrationError,
  RuntimeRegistry,
  type AgentRuntimeAdapter,
  type CreateRuntimeSession,
  type ResumeRuntimeSession,
  type RuntimeCapabilities,
  type RuntimeModelDiscovery,
  type RuntimeSession,
} from '../src/runner/runtime.ts';

const session: RuntimeSession = {
  sendTurn: async function* () {},
  observeContext: async () => ({ confidence: 'unavailable', reason: 'unsupported' }),
  async interrupt() {},
  async dispose() {},
};

class FakeAdapter implements AgentRuntimeAdapter {
  readonly id = 'fake-runtime';
  capabilitiesValue: RuntimeCapabilities = {
    runtimeId: this.id,
    accountId: 'account-a',
    nativeContinuation: { status: 'supported' },
    modelDiscovery: { status: 'supported' },
    effortControl: { status: 'supported' },
    context: {
      currentUse: { status: 'supported', confidences: ['exact', 'derived'] },
      compaction: { status: 'supported' },
    },
  };
  discoveryValue: RuntimeModelDiscovery = {
    status: 'available',
    models: [{
      id: 'alias-model',
      resolvedId: 'model-2026',
      label: 'Model',
      description: '',
      effort: { status: 'supported', values: ['low', 'high'] },
    }],
  };

  async capabilities(accountId: string): Promise<RuntimeCapabilities> {
    return { ...this.capabilitiesValue, accountId };
  }

  async listModels(): Promise<RuntimeModelDiscovery> {
    return this.discoveryValue;
  }

  async createSession(_input: CreateRuntimeSession): Promise<RuntimeSession> {
    return session;
  }

  async resumeSession(_input: ResumeRuntimeSession): Promise<RuntimeSession> {
    return session;
  }
}

interface Gate {
  promise: Promise<void>;
  resolve: () => void;
}

function gate(): Gate {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => { resolve = done; });
  return { promise, resolve };
}

test('runtime registry rejects duplicate ids and resolves absence without fallback', () => {
  const registry = new RuntimeRegistry();
  const adapter = new FakeAdapter();
  registry.register(adapter);
  assert.deepEqual(registry.resolve('missing'), {
    status: 'invalid', code: 'runtime-not-registered',
  });
  assert.equal(registry.resolve(adapter.id).status, 'resolved');
  assert.throws(
    () => registry.register(new FakeAdapter()),
    (error: unknown) =>
      error instanceof RuntimeRegistrationError && error.code === 'duplicate-runtime-id',
  );

  const invalid = new FakeAdapter();
  Object.defineProperty(invalid, 'id', { value: ' fake-runtime ' });
  assert.throws(
    () => new RuntimeRegistry().register(invalid),
    (error: unknown) =>
      error instanceof RuntimeRegistrationError && error.code === 'invalid-runtime-id',
  );
});

test('selection request normalizes null effort only from positive model facts', async () => {
  const registry = new RuntimeRegistry();
  const adapter = new FakeAdapter();
  registry.register(adapter);

  assert.deepEqual(await registry.resolveSelection({
    runtimeId: adapter.id,
    accountId: 'account-a',
    model: 'model-2026',
    effort: null,
  }), {
    status: 'valid',
    selection: {
      runtimeId: adapter.id,
      accountId: 'account-a',
      model: 'model-2026',
      effort: { kind: 'none' },
    },
  });

  adapter.discoveryValue = {
    status: 'available',
    models: [{
      id: 'plain', resolvedId: null, label: 'Plain', description: '',
      effort: { status: 'unsupported', code: 'no-effort' },
    }],
  };
  assert.deepEqual(await registry.resolveSelection({
    runtimeId: adapter.id,
    accountId: 'account-a',
    model: 'plain',
    effort: null,
  }), {
    status: 'valid',
    selection: {
      runtimeId: adapter.id,
      accountId: 'account-a',
      model: 'plain',
      effort: { kind: 'unavailable' },
    },
  });

  adapter.discoveryValue = {
    status: 'available',
    models: [{
      id: 'unknown-effort', resolvedId: null, label: 'Unknown', description: '',
      effort: { status: 'unavailable', code: 'metadata-unavailable' },
    }],
  };
  assert.deepEqual(await registry.resolveSelection({
    runtimeId: adapter.id,
    accountId: 'account-a',
    model: 'unknown-effort',
    effort: null,
  }), { status: 'invalid', code: 'effort-unavailable' });
  assert.deepEqual(await registry.validate({
    runtimeId: adapter.id,
    accountId: 'account-a',
    model: 'unknown-effort',
    effort: { kind: 'unavailable' },
  }), { status: 'invalid', code: 'effort-unavailable' });
});

test('validation and resume preflight retain typed negative states', async () => {
  const registry = new RuntimeRegistry();
  const adapter = new FakeAdapter();
  registry.register(adapter);
  const selection = {
    runtimeId: adapter.id,
    accountId: 'account-a',
    model: 'alias-model',
    effort: { kind: 'selected' as const, value: 'high' },
  };

  assert.deepEqual(await registry.validate(selection), { status: 'valid', selection });
  assert.deepEqual(
    await registry.preflight(selection, { mode: 'resume', nativeSessionId: '' }),
    { status: 'invalid', code: 'native-session-missing' },
  );

  for (const context of [
    {
      currentUse: { status: 'unsupported' as const, code: 'no-context-observer' },
      compaction: { status: 'unsupported' as const, code: 'no-compaction-events' },
    },
    {
      currentUse: { status: 'unavailable' as const, code: 'context-temporarily-unavailable' },
      compaction: { status: 'unavailable' as const, code: 'compaction-temporarily-unavailable' },
    },
  ]) {
    adapter.capabilitiesValue = { ...adapter.capabilitiesValue, context };
    assert.deepEqual(
      await registry.preflight(selection, { mode: 'resume', nativeSessionId: 'native-a' }),
      { status: 'valid', selection },
    );
  }

  adapter.capabilitiesValue = {
    ...adapter.capabilitiesValue,
    nativeContinuation: { status: 'unsupported', code: 'no-native-resume' },
  };
  assert.deepEqual(
    await registry.preflight(selection, { mode: 'resume', nativeSessionId: 'native-a' }),
    { status: 'invalid', code: 'native-resume-unsupported' },
  );

  adapter.capabilitiesValue = {
    ...adapter.capabilitiesValue,
    nativeContinuation: { status: 'unavailable', code: 'account-unavailable' },
    modelDiscovery: { status: 'unavailable', code: 'account-unavailable' },
    effortControl: { status: 'unavailable', code: 'account-unavailable' },
  };
  assert.deepEqual(await registry.validate(selection), {
    status: 'invalid', code: 'account-unavailable',
  });
});

test('registry fails closed on malformed boundary values and adapter facts', async () => {
  const registry = new RuntimeRegistry();
  const adapter = new FakeAdapter();
  registry.register(adapter);
  const validSelection = {
    runtimeId: adapter.id,
    accountId: 'account-a',
    model: 'alias-model',
    effort: { kind: 'none' as const },
  };

  assert.deepEqual(await registry.validate(null as never), {
    status: 'invalid', code: 'selection-unavailable',
  });
  assert.deepEqual(await registry.resolveSelection({
    runtimeId: adapter.id,
    accountId: 'account-a',
    model: 'alias-model',
    effort: null,
    fallbackModel: 'plain',
  } as never), { status: 'invalid', code: 'selection-unavailable' });
  assert.deepEqual(await registry.resolveSelection({
    runtimeId: adapter.id,
    accountId: 'account-a',
    model: 'alias-model',
    effort: ' high ',
  }), { status: 'invalid', code: 'effort-value-unsupported' });
  assert.deepEqual(await registry.preflight(
    validSelection,
    { mode: 'resume', nativeSessionId: ' native-a ' },
  ), { status: 'invalid', code: 'native-session-missing' });

  adapter.capabilitiesValue = {
    ...adapter.capabilitiesValue,
    extraNativeFact: true,
  } as unknown as RuntimeCapabilities;
  assert.deepEqual(await registry.validate(validSelection), {
    status: 'invalid', code: 'capabilities-unavailable',
  });

  adapter.capabilitiesValue = {
    runtimeId: adapter.id,
    accountId: 'account-a',
    nativeContinuation: { status: 'supported' },
    modelDiscovery: { status: 'supported' },
    effortControl: { status: 'supported' },
    context: {
      currentUse: { status: 'supported', confidences: ['exact', 'derived'] },
      compaction: { status: 'supported' },
    },
  };
  adapter.discoveryValue = {
    status: 'available',
    models: [],
  } as unknown as RuntimeModelDiscovery;
  assert.deepEqual(await registry.validate(validSelection), {
    status: 'invalid', code: 'model-discovery-unavailable',
  });
});

test('validation snapshots mutable selections and capability facts before awaits', async () => {
  const registry = new RuntimeRegistry();
  const adapter = new FakeAdapter();
  registry.register(adapter);
  const capabilitiesStarted = gate();
  const releaseCapabilities = gate();
  const originalCapabilities = adapter.capabilities.bind(adapter);
  adapter.capabilities = async (accountId: string) => {
    capabilitiesStarted.resolve();
    await releaseCapabilities.promise;
    return originalCapabilities(accountId);
  };
  const mutableSelection = {
    runtimeId: adapter.id,
    accountId: 'account-a',
    model: 'alias-model',
    effort: { kind: 'selected' as const, value: 'high' },
  };
  const pendingValidation = registry.validate(mutableSelection);
  await capabilitiesStarted.promise;
  mutableSelection.accountId = 'mutated-account';
  mutableSelection.model = 'mutated-model';
  mutableSelection.effort.value = 'low';
  releaseCapabilities.resolve();
  assert.deepEqual(await pendingValidation, {
    status: 'valid',
    selection: {
      runtimeId: adapter.id,
      accountId: 'account-a',
      model: 'alias-model',
      effort: { kind: 'selected', value: 'high' },
    },
  });

  const sharedCapabilities: RuntimeCapabilities = {
    runtimeId: adapter.id,
    accountId: 'account-a',
    nativeContinuation: { status: 'supported' },
    modelDiscovery: { status: 'supported' },
    effortControl: { status: 'supported' },
    context: {
      currentUse: { status: 'supported', confidences: ['exact', 'derived'] },
      compaction: { status: 'supported' },
    },
  };
  const discoveryStarted = gate();
  const releaseDiscovery = gate();
  adapter.capabilities = async () => sharedCapabilities;
  adapter.listModels = async () => {
    discoveryStarted.resolve();
    await releaseDiscovery.promise;
    return {
      status: 'available',
      models: [{
        id: 'alias-model', resolvedId: 'model-2026', label: 'Model', description: '',
        effort: { status: 'supported', values: ['low', 'high'] },
      }],
    };
  };
  const pendingResolution = registry.resolveSelection({
    runtimeId: adapter.id,
    accountId: 'account-a',
    model: 'alias-model',
    effort: null,
  });
  await discoveryStarted.promise;
  sharedCapabilities.effortControl = { status: 'unsupported', code: 'mutated-late' };
  releaseDiscovery.resolve();
  assert.deepEqual(await pendingResolution, {
    status: 'valid',
    selection: {
      runtimeId: adapter.id,
      accountId: 'account-a',
      model: 'alias-model',
      effort: { kind: 'none' },
    },
  });
});

test('resolved aliases must be unique while an exact model id takes precedence', async () => {
  const registry = new RuntimeRegistry();
  const adapter = new FakeAdapter();
  adapter.discoveryValue = {
    status: 'available',
    models: [
      {
        id: 'first', resolvedId: 'shared-native', label: 'First', description: '',
        effort: { status: 'supported', values: ['low'] },
      },
      {
        id: 'second', resolvedId: 'shared-native', label: 'Second', description: '',
        effort: { status: 'supported', values: ['low'] },
      },
    ],
  };
  registry.register(adapter);
  assert.deepEqual(await registry.resolveSelection({
    runtimeId: adapter.id,
    accountId: 'account-a',
    model: 'shared-native',
    effort: null,
  }), { status: 'invalid', code: 'model-unsupported' });

  adapter.discoveryValue.models.push({
    id: 'shared-native', resolvedId: null, label: 'Exact', description: '',
    effort: { status: 'supported', values: ['low'] },
  });
  assert.equal((await registry.resolveSelection({
    runtimeId: adapter.id,
    accountId: 'account-a',
    model: 'shared-native',
    effort: null,
  })).status, 'valid');
});
