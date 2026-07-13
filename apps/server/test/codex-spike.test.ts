import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import {
  existsSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import type {
  CodexAdmissionRequestMethod,
  CodexProcessExitReceipt,
} from '../src/runner/codex/app-server-client.ts';
import type { CodexNotificationReceipt } from '../src/runner/codex/protocol.ts';
import {
  CodexSpikeError,
  parseCodexSpikeArguments,
  runCodexAdmissionSpike,
  safeCodexSpikeFailureCode,
  type CodexSpikeClient,
  type CodexSpikeClientFactory,
  type CodexSpikeClientFactoryOptions,
  type CodexSpikeErrorCode,
} from '../src/runner/codex/spike.ts';

const TEST_DIR = dirname(fileURLToPath(import.meta.url));
const SERVER_ROOT = join(TEST_DIR, '..');
const REPOSITORY_ROOT = join(SERVER_ROOT, '..', '..');
const CODEX_SPIKE_SCRIPT = join(SERVER_ROOT, 'scripts', 'codex-spike.ts');
const TSX_CLI = fileURLToPath(import.meta.resolve('tsx/cli'));

interface Scenario {
  readonly config?: unknown;
  readonly account?: unknown;
  readonly pages?: readonly unknown[];
  readonly notification?: unknown;
  readonly failMethod?: CodexAdmissionRequestMethod;
  readonly failMessage?: string;
  readonly disposeError?: string;
  readonly disposeGate?: Promise<void>;
  readonly disposeReceipt?: unknown;
  readonly mutateOnDispose?: boolean;
  readonly mutateOnUnsubscribe?: boolean;
  readonly removeTemporaryRootOnDispose?: boolean;
  readonly invalidInitialize?: boolean;
}

interface RequestRecord {
  readonly client: number;
  readonly method: CodexAdmissionRequestMethod;
  readonly params: unknown;
}

class FakeClient implements CodexSpikeClient {
  private readonly listeners = new Set<(notification: CodexNotificationReceipt) => void>();
  private pageIndex = 0;

  constructor(
    private readonly number: number,
    private readonly home: string,
    private readonly cwd: string,
    private readonly scenario: Scenario,
    private readonly events: string[],
    private readonly requests: RequestRecord[],
  ) {}

  onNotification(listener: (notification: CodexNotificationReceipt) => void): () => void {
    this.events.push(`subscribe:${this.number}`);
    this.listeners.add(listener);
    return () => {
      this.events.push(`unsubscribe:${this.number}`);
      this.listeners.delete(listener);
      if (this.scenario.mutateOnUnsubscribe) {
        writeFileSync(join(this.cwd, 'unexpected-after-verification.txt'), 'must be removed', 'utf8');
      }
    };
  }

  async initialize(expectedCodexHome: string) {
    this.events.push(`initialize:${this.number}`);
    assert.equal(expectedCodexHome, this.home);
    if (this.scenario.notification !== undefined) {
      for (const listener of this.listeners) {
        (listener as (notification: unknown) => void)(this.scenario.notification);
      }
    }
    if (this.scenario.invalidInitialize) {
      return { status: 'initialized', exactCodexHome: true, remoteControl: { status: 'connected' } } as never;
    }
    return {
      status: 'initialized' as const,
      exactCodexHome: true as const,
      remoteControl: { status: 'disabled' as const, environmentId: null },
    };
  }

  async request(method: CodexAdmissionRequestMethod, params: unknown): Promise<unknown> {
    this.events.push(`request:${this.number}:${method}`);
    this.requests.push({ client: this.number, method, params });
    if (this.scenario.failMethod === method) {
      throw new Error(this.scenario.failMessage ?? 'native-sensitive-error');
    }
    if (method === 'config/read') return this.scenario.config ?? safeConfig();
    if (method === 'account/read') return this.scenario.account ?? chatgptAccount();
    const page = this.scenario.pages?.[this.pageIndex++];
    return page ?? catalogPage([catalogModel()]);
  }

  async dispose(): Promise<CodexProcessExitReceipt> {
    this.events.push(`dispose-start:${this.number}`);
    await this.scenario.disposeGate;
    if (this.scenario.disposeError !== undefined) {
      throw new Error(this.scenario.disposeError);
    }
    if (this.scenario.mutateOnDispose) {
      writeFileSync(join(this.cwd, 'unexpected.txt'), 'must be removed', 'utf8');
    }
    if (this.scenario.removeTemporaryRootOnDispose) {
      rmSync(dirname(this.cwd), { recursive: true, force: true });
    }
    this.events.push(`dispose:${this.number}`);
    if (Object.prototype.hasOwnProperty.call(this.scenario, 'disposeReceipt')) {
      return this.scenario.disposeReceipt as CodexProcessExitReceipt;
    }
    return { status: 'exited', code: 0, signal: null };
  }
}

function fakeFactory(scenarios: readonly Scenario[]) {
  const events: string[] = [];
  const requests: RequestRecord[] = [];
  const options: CodexSpikeClientFactoryOptions[] = [];
  const clients: FakeClient[] = [];
  const factory: CodexSpikeClientFactory = (spawnOptions) => {
    const number = clients.length + 1;
    const scenario = scenarios[number - 1];
    if (!scenario) throw new Error('unexpected native process');
    events.push(`start:${number}`);
    options.push(spawnOptions);
    const client = new FakeClient(
      number,
      spawnOptions.codexHome,
      spawnOptions.cwd,
      scenario,
      events,
      requests,
    );
    clients.push(client);
    return client;
  };
  return { factory, events, requests, options, clients };
}

test('CLI parsing requires the explicit home and live-provider consent', () => {
  assert.deepEqual(parseCodexSpikeArguments([
    '--allow-live-provider',
    '--codex-home',
    'C:\\Users\\Operator\\.codex',
  ]), {
    codexHome: 'C:\\Users\\Operator\\.codex',
    allowLiveProvider: true,
  });
  assertRejectedSync(() => parseCodexSpikeArguments([]), 'codex-home-required');
  assertRejectedSync(
    () => parseCodexSpikeArguments(['--codex-home', '/home/operator/.codex']),
    'live-provider-consent-required',
  );
  assertRejectedSync(
    () => parseCodexSpikeArguments(['--allow-live-provider']),
    'codex-home-required',
  );
  assertRejectedSync(
    () => parseCodexSpikeArguments([
      '--codex-home', '/a', '--codex-home', '/b', '--allow-live-provider',
    ]),
    'cli-arguments-invalid',
  );
  assertRejectedSync(
    () => parseCodexSpikeArguments(['--codex-home=/a', '--allow-live-provider']),
    'cli-arguments-invalid',
  );
  assert.equal(safeCodexSpikeFailureCode(new Error('private native text')), 'codex-spike-unavailable');
});

test('thin CLI forwards arguments and fails before any Codex client can start', () => {
  const missingHome = join(
    realpathSync.native(tmpdir()),
    `pc-sdk-codex-home-intentionally-missing-${process.pid}-${Date.now()}`,
  );
  rmSync(missingHome, { recursive: true, force: true });

  const noArguments = spawnSync(process.execPath, [TSX_CLI, CODEX_SPIKE_SCRIPT], {
    cwd: SERVER_ROOT,
    encoding: 'utf8',
    env: process.env,
  });
  assert.equal(noArguments.status, 1);
  assert.equal(readCliFailureCode(noArguments.stderr), 'codex-home-required');

  const missingSelectedHome = spawnSync(process.execPath, [
    TSX_CLI,
    CODEX_SPIKE_SCRIPT,
    '--codex-home',
    missingHome,
    '--allow-live-provider',
  ], {
    cwd: SERVER_ROOT,
    encoding: 'utf8',
    env: process.env,
  });
  assert.equal(missingSelectedHome.status, 1);
  assert.equal(readCliFailureCode(missingSelectedHome.stderr), 'codex-home-unavailable');
  assert.equal(existsSync(missingHome), false);
});

test('root Windows command preserves a canonical path without echoing it', {
  skip: process.platform !== 'win32',
}, () => {
  const missingHome = join(
    realpathSync.native(tmpdir()),
    `pc-sdk-codex-root-command-missing-${process.pid}-${Date.now()}`,
  );
  rmSync(missingHome, { recursive: true, force: true });
  const command = '& pnpm --silent --config.shell-emulator=true spike:codex ' +
    '--codex-home $env:CX001_MISSING_HOME --allow-live-provider; exit $LASTEXITCODE';
  const result = spawnSync('powershell.exe', [
    '-NoLogo',
    '-NoProfile',
    '-NonInteractive',
    '-Command',
    command,
  ], {
    cwd: REPOSITORY_ROOT,
    encoding: 'utf8',
    env: { ...process.env, CX001_MISSING_HOME: missingHome },
  });
  const output = `${result.stdout}${result.stderr}`;
  assert.equal(result.status, 1);
  assert.equal(readCliFailureCode(output), 'codex-home-unavailable');
  assert.equal(output.includes(missingHome), false);
  assert.equal(existsSync(missingHome), false);
});

test('admission repeats config, cached ChatGPT auth, and paginated catalog in two disposed clients', async () => {
  const home = temporaryHome();
  const firstPage = catalogPage([catalogModel({
    id: 'nondefault-native-id-secret',
    model: 'gpt-other',
    isDefault: false,
  })], 'opaque-cursor-secret');
  const secondPage = catalogPage([catalogModel({
    id: 'default-native-id-secret',
    model: 'gpt-codex-test',
    effort: 'high',
  })]);
  const fake = fakeFactory([
    { pages: [firstPage, secondPage] },
    { pages: [firstPage, secondPage] },
  ]);

  try {
    const receipt = await runCodexAdmissionSpike({
      codexHome: home,
      allowLiveProvider: true,
    }, { clientFactory: fake.factory });

    assert.deepEqual(fake.events, [
      'start:1', 'subscribe:1', 'initialize:1',
      'request:1:config/read', 'request:1:account/read',
      'request:1:model/list', 'request:1:model/list',
      'dispose-start:1', 'dispose:1', 'unsubscribe:1',
      'start:2', 'subscribe:2', 'initialize:2',
      'request:2:config/read', 'request:2:account/read',
      'request:2:model/list', 'request:2:model/list',
      'dispose-start:2', 'dispose:2', 'unsubscribe:2',
    ]);
    assert.notEqual(fake.clients[0], fake.clients[1]);
    for (const spawn of fake.options) {
      assert.equal(spawn.codexHome, home);
      assert.deepEqual(spawn.stderrPolicy, { mode: 'fail-on-any' });
      assert.equal(existsSync(dirname(spawn.cwd)), false, 'temporary root removed');
    }
    for (const request of fake.requests.filter((entry) => entry.method === 'config/read')) {
      assert.deepEqual(request.params, {
        cwd: fake.options[request.client - 1]!.cwd,
        includeLayers: true,
      });
    }
    for (const request of fake.requests.filter((entry) => entry.method === 'account/read')) {
      assert.deepEqual(request.params, { refreshToken: false });
    }
    const modelRequests = fake.requests.filter((entry) => entry.method === 'model/list');
    assert.deepEqual(modelRequests.map((entry) => entry.params), [
      { includeHidden: false },
      { cursor: 'opaque-cursor-secret', includeHidden: false },
      { includeHidden: false },
      { cursor: 'opaque-cursor-secret', includeHidden: false },
    ]);

    assert.equal(receipt.observation.credentialStore, 'file');
    assert.equal(receipt.observation.cachedAuthKind, 'chatgpt');
    assert.equal(receipt.observation.defaultModel, 'gpt-codex-test');
    assert.equal(receipt.observation.defaultReasoningEffort, 'high');
    assert.equal(receipt.observation.restartCatalogMatch, true);
    assert.deepEqual(new Set(Object.values(receipt.unavailable)), new Set(['unavailable']));
    assert.deepEqual(receipt.cleanup, {
      firstProcessDisposed: true,
      secondProcessDisposed: true,
      temporaryRootRemoved: true,
    });
    const durable = JSON.stringify(receipt);
    for (const forbidden of [
      home,
      'operator-secret@example.invalid',
      'opaque-cursor-secret',
      'default-native-id-secret',
      'sensitive model description',
      'native-installation-secret',
    ]) assert.equal(durable.includes(forbidden), false, forbidden);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test('restart waits for the first positive disposal receipt and success waits for final cleanup', async () => {
  const home = temporaryHome();
  let releaseFirstDisposal!: () => void;
  const firstDisposalGate = new Promise<void>((resolve) => {
    releaseFirstDisposal = resolve;
  });
  const fake = fakeFactory([
    { disposeGate: firstDisposalGate },
    {},
  ]);
  const run = runCodexAdmissionSpike({ codexHome: home, allowLiveProvider: true }, {
    clientFactory: fake.factory,
  });

  try {
    await waitForEvent(fake.events, 'dispose-start:1');
    assert.equal(fake.clients.length, 1, 'second native client must not start while disposal is pending');
    assert.equal(fake.events.includes('dispose:1'), false, 'no positive first disposal yet');
    assert.equal(fake.events.includes('start:2'), false);

    releaseFirstDisposal();
    const receipt = await run;
    assert.ok(fake.events.indexOf('dispose:1') < fake.events.indexOf('start:2'));
    assert.ok(fake.events.indexOf('dispose:2') < fake.events.indexOf('unsubscribe:2'));
    assert.equal(existsSync(dirname(fake.options[0]!.cwd)), false);
    assert.deepEqual(receipt.cleanup, {
      firstProcessDisposed: true,
      secondProcessDisposed: true,
      temporaryRootRemoved: true,
    });
  } finally {
    releaseFirstDisposal();
    await run.catch(() => {});
    rmSync(home, { recursive: true, force: true });
  }
});

test('disposal fulfillment requires an exact positive native exit receipt before restart', async (t) => {
  const invalidReceipts: ReadonlyArray<Readonly<{ name: string; receipt: unknown }>> = [
    { name: 'undefined fulfillment', receipt: undefined },
    { name: 'non-finite exit code', receipt: { status: 'exited', code: Number.NaN, signal: null } },
    { name: 'unsafe integer exit code', receipt: { status: 'exited', code: 2 ** 53, signal: null } },
    { name: 'negative exit code', receipt: { status: 'exited', code: -1, signal: null } },
    { name: 'unknown signal', receipt: { status: 'exited', code: null, signal: 'SIGSECRET' } },
    { name: 'missing lifecycle outcome', receipt: { status: 'exited', code: null, signal: null } },
    { name: 'conflicting lifecycle outcome', receipt: { status: 'exited', code: 0, signal: 'SIGTERM' } },
    {
      name: 'unexpected receipt field',
      receipt: { status: 'exited', code: 0, signal: null, nativeSecret: 'must-not-leak' },
    },
  ];

  for (const entry of invalidReceipts) {
    await t.test(entry.name, async () => {
      const home = temporaryHome();
      const fake = fakeFactory([{ disposeReceipt: entry.receipt }, {}]);
      try {
        await assertRejected(
          runCodexAdmissionSpike({ codexHome: home, allowLiveProvider: true }, {
            clientFactory: fake.factory,
          }),
          'process-disposal-failed',
          'must-not-leak',
        );
        assert.equal(fake.clients.length, 1, 'invalid disposal must gate restart');
        assert.equal(fake.events.includes('start:2'), false);
        assert.equal(existsSync(dirname(fake.options[0]!.cwd)), false);
      } finally {
        rmSync(home, { recursive: true, force: true });
      }
    });
  }
});

test('disposal and workspace cleanup uncertainty override earlier provider failures', async (t) => {
  const cases: ReadonlyArray<Readonly<{
    name: string;
    scenarios: readonly Scenario[];
    code: CodexSpikeErrorCode;
    sensitive: string;
  }>> = [
    {
      name: 'rejected disposal receipt',
      scenarios: [{
        failMethod: 'config/read',
        failMessage: 'provider-error-must-not-win',
        disposeError: 'native-disposal-error-must-not-leak',
      }],
      code: 'process-disposal-failed',
      sensitive: 'native-disposal-error-must-not-leak',
    },
    {
      name: 'workspace mutation after provider failure',
      scenarios: [{
        failMethod: 'config/read',
        failMessage: 'provider-error-must-not-win',
        mutateOnDispose: true,
      }],
      code: 'temporary-workspace-mutated',
      sensitive: 'provider-error-must-not-win',
    },
    {
      name: 'workspace mutation after the second observation verification',
      scenarios: [{}, { mutateOnUnsubscribe: true }],
      code: 'temporary-workspace-mutated',
      sensitive: 'unexpected-after-verification.txt',
    },
    {
      name: 'unverifiable temporary-root removal',
      scenarios: [{
        failMethod: 'config/read',
        failMessage: 'provider-error-must-not-win',
        removeTemporaryRootOnDispose: true,
      }],
      code: 'temporary-cleanup-failed',
      sensitive: 'provider-error-must-not-win',
    },
  ];

  for (const entry of cases) {
    await t.test(entry.name, async () => {
      const home = temporaryHome();
      const fake = fakeFactory(entry.scenarios);
      try {
        await assertRejected(
          runCodexAdmissionSpike({ codexHome: home, allowLiveProvider: true }, {
            clientFactory: fake.factory,
          }),
          entry.code,
          entry.sensitive,
        );
        assert.equal(fake.events.includes('dispose-start:1'), true);
        if (fake.options.length > 0) {
          assert.equal(existsSync(dirname(fake.options[0]!.cwd)), false);
        }
      } finally {
        rmSync(home, { recursive: true, force: true });
      }
    });
  }
});

test('config admission precedes account work and rejects credential/routing overrides recursively', async (t) => {
  const cases: Array<{
    name: string;
    config: unknown;
    code: CodexSpikeErrorCode;
  }> = [
    {
      name: 'keyring credential store',
      config: safeConfig({ cli_auth_credentials_store: 'keyring' }),
      code: 'credential-store-unsafe',
    },
    {
      name: 'missing credential store',
      config: safeConfig({ cli_auth_credentials_store: undefined }),
      code: 'credential-store-unsafe',
    },
    {
      name: 'missing credential-store origin',
      config: { ...safeConfig(), origins: {} },
      code: 'credential-store-unsafe',
    },
    {
      name: 'missing forced credential-store layer',
      config: { ...safeConfig(), layers: [] },
      code: 'credential-store-unsafe',
    },
    {
      name: 'mismatched credential-store layer version',
      config: {
        ...safeConfig(),
        layers: [{
          name: { type: 'sessionFlags' },
          version: 'different-native-version',
          config: { cli_auth_credentials_store: 'file' },
        }],
      },
      code: 'credential-store-unsafe',
    },
    {
      name: 'disabled credential-store layer',
      config: {
        ...safeConfig(),
        layers: [{
          name: { type: 'sessionFlags' },
          version: 'native-origin-version-secret',
          config: { cli_auth_credentials_store: 'file' },
          disabledReason: 'disabled by test',
        }],
      },
      code: 'credential-store-unsafe',
    },
    {
      name: 'alternate model provider',
      config: safeConfig({ model_provider: 'azure' }),
      code: 'config-admission-failed',
    },
    {
      name: 'missing model provider',
      config: withoutEffectiveConfigKey('model_provider'),
      code: 'config-admission-failed',
    },
    {
      name: 'custom catalog',
      config: safeConfig({ model_catalog_json: 'sensitive-catalog-path' }),
      code: 'config-admission-failed',
    },
    {
      name: 'nested OpenAI base URL in included layer',
      config: safeConfig({}, [{ profile: { openai_base_url: 'https://sensitive.invalid' } }]),
      code: 'config-admission-failed',
    },
    {
      name: 'nested custom model provider',
      config: safeConfig({
        profile: {
          model_providers: { custom: { base_url: 'https://sensitive.invalid' } },
        },
      }),
      code: 'config-admission-failed',
    },
    {
      name: 'unexpected config response field',
      config: { ...safeConfig(), unexpected: 'sensitive-response-field' },
      code: 'config-admission-failed',
    },
    {
      name: 'malformed origin metadata',
      config: {
        ...safeConfig(),
        origins: {
          setting: {
            name: { type: 'sessionFlags' },
            version: 'native-version',
            unexpected: 'sensitive-origin-field',
          },
        },
      },
      code: 'config-admission-failed',
    },
    {
      name: 'malformed layer source',
      config: {
        ...safeConfig(),
        layers: [{
          name: { type: 'sessionFlags', unexpected: 'sensitive-layer-source-field' },
          version: 'native-version',
          config: {},
          disabledReason: null,
        }],
      },
      code: 'config-admission-failed',
    },
  ];

  for (const entry of cases) {
    await t.test(entry.name, async () => {
      const home = temporaryHome();
      const fake = fakeFactory([{ config: entry.config }]);
      try {
        await assertRejected(
          runCodexAdmissionSpike({ codexHome: home, allowLiveProvider: true }, {
            clientFactory: fake.factory,
          }),
          entry.code,
          'sensitive',
        );
        assert.deepEqual(fake.requests.map((request) => request.method), ['config/read']);
        assert.equal(fake.events.includes('dispose:1'), true);
        assert.equal(existsSync(dirname(fake.options[0]!.cwd)), false);
      } finally {
        rmSync(home, { recursive: true, force: true });
      }
    });
  }
});

test('non-ChatGPT or malformed account state stops before catalog discovery', async () => {
  const home = temporaryHome();
  const fake = fakeFactory([{
    account: {
      account: { type: 'apiKey' },
      requiresOpenaiAuth: false,
    },
  }]);
  try {
    await assertRejected(
      runCodexAdmissionSpike({ codexHome: home, allowLiveProvider: true }, {
        clientFactory: fake.factory,
      }),
      'account-admission-failed',
    );
    assert.deepEqual(fake.requests.map((request) => request.method), [
      'config/read',
      'account/read',
    ]);
    assert.equal(fake.events.includes('dispose:1'), true);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test('cached ChatGPT admission requires positive OpenAI-auth evidence', async () => {
  const home = temporaryHome();
  const fake = fakeFactory([{
    account: {
      ...chatgptAccount(),
      requiresOpenaiAuth: false,
    },
  }]);
  try {
    await assertRejected(
      runCodexAdmissionSpike({ codexHome: home, allowLiveProvider: true }, {
        clientFactory: fake.factory,
      }),
      'account-admission-failed',
    );
    assert.deepEqual(fake.requests.map((request) => request.method), [
      'config/read',
      'account/read',
    ]);
    assert.equal(fake.events.includes('dispose:1'), true);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test('catalog ambiguity and malformed effort evidence fail closed', async (t) => {
  const cases: Array<{ name: string; page: unknown; code: CodexSpikeErrorCode }> = [
    {
      name: 'two defaults',
      page: catalogPage([
        catalogModel({ id: 'one', model: 'one' }),
        catalogModel({ id: 'two', model: 'two' }),
      ]),
      code: 'catalog-default-ambiguous',
    },
    {
      name: 'no default',
      page: catalogPage([catalogModel({ isDefault: false })]),
      code: 'catalog-default-unavailable',
    },
    {
      name: 'unsupported default effort',
      page: catalogPage([catalogModel({ effort: 'high', supported: ['low'] })]),
      code: 'catalog-default-invalid',
    },
    {
      name: 'duplicate effort',
      page: catalogPage([catalogModel({ supported: ['medium', 'medium'] })]),
      code: 'catalog-default-invalid',
    },
    {
      name: 'missing generated model field',
      page: catalogPage([withoutModelKey('upgrade')]),
      code: 'catalog-default-invalid',
    },
    {
      name: 'unexpected generated model field',
      page: catalogPage([{ ...catalogModel(), unexpected: 'native-model-secret' }]),
      code: 'catalog-default-invalid',
    },
    {
      name: 'malformed nested upgrade info',
      page: catalogPage([{
        ...catalogModel(),
        upgradeInfo: {
          model: 'next-model',
          upgradeCopy: null,
          modelLink: null,
          migrationMarkdown: null,
          unexpected: 'native-upgrade-secret',
        },
      }]),
      code: 'catalog-default-invalid',
    },
    {
      name: 'unsupported input modality',
      page: catalogPage([{ ...catalogModel(), inputModalities: ['audio'] }]),
      code: 'catalog-default-invalid',
    },
    {
      name: 'malformed service tier',
      page: catalogPage([{
        ...catalogModel(),
        serviceTiers: [{
          id: 'fast',
          name: 'Fast',
          description: 'native service tier',
          unexpected: 'native-tier-secret',
        }],
      }]),
      code: 'catalog-default-invalid',
    },
  ];
  for (const entry of cases) {
    await t.test(entry.name, async () => {
      const home = temporaryHome();
      const fake = fakeFactory([{ pages: [entry.page] }]);
      try {
        await assertRejected(
          runCodexAdmissionSpike({ codexHome: home, allowLiveProvider: true }, {
            clientFactory: fake.factory,
          }),
          entry.code,
        );
        assert.equal(fake.clients.length, 1, 'no restart after invalid catalog');
        assert.equal(fake.events.includes('dispose:1'), true);
      } finally {
        rmSync(home, { recursive: true, force: true });
      }
    });
  }
});

test('restart requires the exact same default model and effort from a distinct client', async () => {
  const home = temporaryHome();
  const fake = fakeFactory([
    { pages: [catalogPage([catalogModel({ model: 'gpt-first', effort: 'medium' })])] },
    { pages: [catalogPage([catalogModel({ model: 'gpt-second', effort: 'medium' })])] },
  ]);
  try {
    await assertRejected(
      runCodexAdmissionSpike({ codexHome: home, allowLiveProvider: true }, {
        clientFactory: fake.factory,
      }),
      'restart-catalog-mismatch',
    );
    assert.equal(fake.events.includes('dispose:1'), true);
    assert.equal(fake.events.includes('dispose:2'), true);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test('unsafe notifications, native error prose, and workspace mutation never leak', async (t) => {
  const cases: Array<{ name: string; scenario: Scenario; code: CodexSpikeErrorCode; secret: string }> = [
    {
      name: 'warning notification',
      scenario: { notification: { method: 'warning', params: { message: 'warning-secret' } } },
      code: 'unsafe-notification',
      secret: 'warning-secret',
    },
    {
      name: 'account notification',
      scenario: {
        notification: {
          method: 'account/updated',
          params: { account: { type: 'chatgpt', email: 'account-secret@example.test' } },
        },
      },
      code: 'unsafe-notification',
      secret: 'account-secret@example.test',
    },
    {
      name: 'native config failure',
      scenario: { failMethod: 'config/read', failMessage: 'provider-native-secret' },
      code: 'config-admission-failed',
      secret: 'provider-native-secret',
    },
    {
      name: 'temporary cwd mutation',
      scenario: { mutateOnDispose: true },
      code: 'temporary-workspace-mutated',
      secret: 'unexpected.txt',
    },
  ];
  for (const entry of cases) {
    await t.test(entry.name, async () => {
      const home = temporaryHome();
      const fake = fakeFactory([entry.scenario]);
      try {
        await assertRejected(
          runCodexAdmissionSpike({ codexHome: home, allowLiveProvider: true }, {
            clientFactory: fake.factory,
          }),
          entry.code,
          entry.secret,
        );
        assert.equal(fake.events.includes('dispose:1'), true);
        assert.equal(existsSync(dirname(fake.options[0]!.cwd)), false);
      } finally {
        rmSync(home, { recursive: true, force: true });
      }
    });
  }
});

test('programmatic entry refuses invalid admission before creating a client', async () => {
  let starts = 0;
  const clientFactory = () => {
    starts += 1;
    throw new Error('must not start');
  };
  await assertRejected(
    runCodexAdmissionSpike({ codexHome: '/not-inspected', allowLiveProvider: false }, {
      clientFactory,
    }),
    'live-provider-consent-required',
  );

  const missingHome = join(
    tmpdir(),
    `pc-sdk-codex-home-programmatically-missing-${process.pid}-${Date.now()}`,
  );
  rmSync(missingHome, { recursive: true, force: true });
  await assert.rejects(
    runCodexAdmissionSpike({ codexHome: missingHome, allowLiveProvider: true }, {
      clientFactory,
    }),
    (error: unknown) => safeCodexSpikeFailureCode(error) === 'codex-home-unavailable',
  );
  assert.equal(starts, 0);
});

function safeConfig(
  overrides: Record<string, unknown> = {},
  layerConfigs: readonly Record<string, unknown>[] = [{}],
): Record<string, unknown> {
  return {
    config: {
      cli_auth_credentials_store: 'file',
      model_provider: null,
      chatgpt_base_url: null,
      model_catalog_json: null,
      model_providers: {},
      openai_base_url: null,
      oss_provider: null,
      ...overrides,
    },
    origins: {
      cli_auth_credentials_store: {
        name: { type: 'sessionFlags' },
        version: 'native-origin-version-secret',
      },
    },
    layers: [
      {
        name: { type: 'sessionFlags' },
        version: 'native-origin-version-secret',
        config: { cli_auth_credentials_store: 'file' },
      },
      ...layerConfigs.map((config) => ({
        name: { type: 'sessionFlags' },
        version: 'native-version-secret',
        config,
      })),
    ],
  };
}

function withoutEffectiveConfigKey(key: string): Record<string, unknown> {
  const response = safeConfig();
  assert.ok(isRecord(response.config));
  delete response.config[key];
  return response;
}

function chatgptAccount(): Record<string, unknown> {
  return {
    account: {
      type: 'chatgpt',
      email: 'operator-secret@example.invalid',
      planType: 'plus',
    },
    requiresOpenaiAuth: true,
  };
}

function catalogModel(options: {
  id?: string;
  model?: string;
  effort?: string;
  supported?: readonly string[];
  isDefault?: boolean;
} = {}): Record<string, unknown> {
  const effort = options.effort ?? 'medium';
  return {
    id: options.id ?? 'native-id-secret',
    model: options.model ?? 'gpt-codex-test',
    upgrade: null,
    upgradeInfo: null,
    availabilityNux: null,
    displayName: 'Safe display',
    description: 'sensitive model description',
    hidden: false,
    supportedReasoningEfforts: (options.supported ?? [effort]).map((reasoningEffort) => ({
      reasoningEffort,
      description: 'native effort description',
    })),
    defaultReasoningEffort: effort,
    inputModalities: ['text', 'image'],
    supportsPersonality: true,
    additionalSpeedTiers: [],
    serviceTiers: [],
    defaultServiceTier: null,
    isDefault: options.isDefault ?? true,
  };
}

function withoutModelKey(key: string): Record<string, unknown> {
  const model = catalogModel();
  delete model[key];
  return model;
}

function catalogPage(data: readonly unknown[], nextCursor: string | null = null): unknown {
  return { data, nextCursor };
}

function temporaryHome(): string {
  return realpathSync.native(mkdtempSync(join(tmpdir(), 'pc-sdk-codex-home-test-')));
}

function readCliFailureCode(stderr: string): string {
  const receipts = stderr.split(/\r?\n/u).flatMap((line) => {
    if (!line.startsWith('{')) return [];
    try {
      const value = JSON.parse(line) as unknown;
      if (!isRecord(value) || value.ok !== false || !isRecord(value.error) ||
        typeof value.error.code !== 'string') return [];
      return [value.error.code];
    } catch {
      return [];
    }
  });
  assert.deepEqual(receipts.length, 1, `expected one sanitized CLI receipt, received: ${stderr}`);
  return receipts[0]!;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

async function waitForEvent(events: readonly string[], expected: string): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (events.includes(expected)) return;
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
  assert.fail(`timed out waiting for ${expected}`);
}

async function assertRejected(
  promise: Promise<unknown>,
  code: CodexSpikeErrorCode,
  sensitive?: string,
): Promise<void> {
  await assert.rejects(promise, (error: unknown) => {
    assert.ok(error instanceof CodexSpikeError);
    assert.equal(error.code, code);
    assert.equal(error.message, `Codex spike rejected: ${code}`);
    if (sensitive) assert.equal(error.message.includes(sensitive), false);
    return true;
  });
}

function assertRejectedSync(action: () => unknown, code: CodexSpikeErrorCode): void {
  assert.throws(action, (error: unknown) => {
    assert.ok(error instanceof CodexSpikeError);
    assert.equal(error.code, code);
    return true;
  });
}
