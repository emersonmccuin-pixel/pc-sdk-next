import {
  basename,
  dirname,
  isAbsolute,
  join,
  normalize,
  relative,
  sep,
} from 'node:path';
import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  realpathSync,
  rmSync,
} from 'node:fs';
import { rm } from 'node:fs/promises';
import { constants, tmpdir } from 'node:os';
import type {
  CodexAdmissionRequestMethod,
  CodexInitializeReceipt,
  CodexProcessExitReceipt,
  CodexRequestOptions,
  CodexStderrPolicy,
} from './app-server-client.ts';
import { buildCodexEnvironment, CodexEnvironmentError } from './environment.ts';
import {
  PINNED_CODEX_CLI_VERSION,
  PINNED_CODEX_PACKAGE,
  PINNED_CODEX_VERSION,
} from './executable.ts';
import type { CodexNotificationReceipt } from './protocol.ts';
import schemaManifest from './schema-manifest.json' with { type: 'json' };

export type CodexSpikeErrorCode =
  | 'account-admission-failed'
  | 'catalog-default-ambiguous'
  | 'catalog-default-invalid'
  | 'catalog-default-unavailable'
  | 'catalog-pagination-invalid'
  | 'cli-arguments-invalid'
  | 'client-start-failed'
  | 'codex-home-required'
  | 'config-admission-failed'
  | 'credential-store-unsafe'
  | 'initialize-admission-failed'
  | 'live-provider-consent-required'
  | 'process-disposal-failed'
  | 'restart-catalog-mismatch'
  | 'restart-client-reused'
  | 'temporary-cleanup-failed'
  | 'temporary-root-unsafe'
  | 'temporary-workspace-mutated'
  | 'unsafe-notification';

export class CodexSpikeError extends Error {
  readonly name = 'CodexSpikeError';

  constructor(readonly code: CodexSpikeErrorCode) {
    super(`Codex spike rejected: ${code}`);
  }
}

export interface CodexSpikeClient {
  initialize(expectedCodexHome: string): Promise<CodexInitializeReceipt>;
  request(
    method: CodexAdmissionRequestMethod,
    params: unknown,
    options?: CodexRequestOptions,
  ): Promise<unknown>;
  onNotification(listener: (notification: CodexNotificationReceipt) => void): () => void;
  dispose(): Promise<CodexProcessExitReceipt>;
}

export interface CodexSpikeClientFactoryOptions {
  readonly codexHome: string;
  readonly cwd: string;
  readonly stderrPolicy: CodexStderrPolicy;
}

export type CodexSpikeClientFactory = (
  options: CodexSpikeClientFactoryOptions,
) => CodexSpikeClient | Promise<CodexSpikeClient>;

export interface CodexSpikeRunOptions {
  readonly codexHome: string;
  readonly allowLiveProvider: boolean;
}

export interface CodexSpikeDependencies {
  readonly clientFactory: CodexSpikeClientFactory;
}

export interface ParsedCodexSpikeArguments {
  readonly codexHome: string;
  readonly allowLiveProvider: true;
}

export interface CodexAdmissionSpikeReceipt {
  readonly kind: 'codex-cached-auth-catalog-observation';
  readonly package: Readonly<{
    name: typeof PINNED_CODEX_PACKAGE;
    version: typeof PINNED_CODEX_VERSION;
    cliVersion: typeof PINNED_CODEX_CLI_VERSION;
    schemaTreeHash: string;
  }>;
  readonly protocol: Readonly<{
    transport: 'stdio-jsonl';
    experimental: false;
    remoteControl: 'disabled';
  }>;
  readonly observation: Readonly<{
    exactCredentialHome: true;
    credentialStore: 'file';
    cachedAuthKind: 'chatgpt';
    catalogRouting: 'built-in-openai';
    defaultModel: string;
    defaultReasoningEffort: string;
    distinctNativeProcessRestart: true;
    restartCatalogMatch: true;
  }>;
  readonly cleanup: Readonly<{
    firstProcessDisposed: true;
    secondProcessDisposed: true;
    temporaryRootRemoved: true;
  }>;
  readonly unavailable: Readonly<{
    credentialFreshness: 'unavailable';
    entitlement: 'unavailable';
    subscriptionUsability: 'unavailable';
    billingRoute: 'unavailable';
    modelUsability: 'unavailable';
    modelInference: 'unavailable';
    nativeCreateResume: 'unavailable';
    nativeContinuation: 'unavailable';
    terminalTurns: 'unavailable';
    interruption: 'unavailable';
    approvals: 'unavailable';
    toolsAndMcp: 'unavailable';
    context: 'unavailable';
    rateLimitNormalization: 'unavailable';
    canonicalRuntimeMapping: 'unavailable';
    dispatch: 'unavailable';
    descendantContainment: 'unavailable';
  }>;
}

interface TemporaryWorkspace {
  readonly parent: string;
  readonly root: string;
  readonly cwd: string;
}

interface ModelSelection {
  readonly model: string;
  readonly effort: string;
}

interface ProcessObservation {
  readonly client: CodexSpikeClient;
  readonly selection: ModelSelection;
  readonly disposed: true;
}

const TEMPORARY_ROOT_PREFIX = 'pc-sdk-codex-spike-';
const MAX_CATALOG_PAGES = 100;
const FORBIDDEN_ROUTING_KEYS: ReadonlySet<string> = new Set([
  'chatgpt_base_url',
  'experimental_realtime_ws_base_url',
  'model_catalog_json',
  'model_providers',
  'openai_base_url',
  'oss_provider',
]);
const CHATGPT_PLAN_TYPES: ReadonlySet<string> = new Set([
  'business',
  'edu',
  'enterprise',
  'enterprise_cbp_usage_based',
  'free',
  'go',
  'plus',
  'pro',
  'prolite',
  'self_serve_business_usage_based',
  'team',
  'unknown',
]);
const MODEL_KEYS = [
  'id',
  'model',
  'upgrade',
  'upgradeInfo',
  'availabilityNux',
  'displayName',
  'description',
  'hidden',
  'supportedReasoningEfforts',
  'defaultReasoningEffort',
  'inputModalities',
  'supportsPersonality',
  'additionalSpeedTiers',
  'serviceTiers',
  'defaultServiceTier',
  'isDefault',
] as const;

export function parseCodexSpikeArguments(
  args: readonly string[],
): ParsedCodexSpikeArguments {
  let codexHome: string | null = null;
  let allowLiveProvider = false;

  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];
    if (argument === '--codex-home') {
      if (codexHome !== null) reject('cli-arguments-invalid');
      const value = args[index + 1];
      if (
        typeof value !== 'string' || value.length === 0 ||
        value.startsWith('--')
      ) reject('codex-home-required');
      codexHome = value;
      index += 1;
      continue;
    }
    if (argument === '--allow-live-provider') {
      if (allowLiveProvider) reject('cli-arguments-invalid');
      allowLiveProvider = true;
      continue;
    }
    reject('cli-arguments-invalid');
  }

  if (codexHome === null) reject('codex-home-required');
  if (!allowLiveProvider) reject('live-provider-consent-required');
  return Object.freeze({ codexHome, allowLiveProvider: true });
}

export function safeCodexSpikeFailureCode(error: unknown): string {
  if (error instanceof CodexSpikeError || error instanceof CodexEnvironmentError) {
    return error.code;
  }
  return 'codex-spike-unavailable';
}

export async function runCodexAdmissionSpike(
  options: CodexSpikeRunOptions,
  dependencies: CodexSpikeDependencies,
): Promise<CodexAdmissionSpikeReceipt> {
  if (options.allowLiveProvider !== true) reject('live-provider-consent-required');
  if (typeof options.codexHome !== 'string' || options.codexHome.length === 0) {
    reject('codex-home-required');
  }
  if (!dependencies || typeof dependencies.clientFactory !== 'function') {
    reject('client-start-failed');
  }

  const selectedCodexHome = buildCodexEnvironment(options.codexHome).CODEX_HOME;
  if (selectedCodexHome === undefined) reject('client-start-failed');
  const workspace = createTemporaryWorkspace(selectedCodexHome);
  let matchedSelection: ModelSelection | null = null;
  let failure: unknown = null;

  try {
    const first = await observeOneProcess(
      dependencies.clientFactory,
      selectedCodexHome,
      workspace.cwd,
    );
    const second = await observeOneProcess(
      dependencies.clientFactory,
      selectedCodexHome,
      workspace.cwd,
      first.client,
    );
    if (
      first.client === second.client ||
      first.selection.model !== second.selection.model ||
      first.selection.effort !== second.selection.effort
    ) {
      if (first.client === second.client) reject('restart-client-reused');
      reject('restart-catalog-mismatch');
    }
    if (first.disposed !== true || second.disposed !== true) {
      reject('process-disposal-failed');
    }
    matchedSelection = first.selection;
  } catch (error) {
    failure = error;
  }

  let workspaceFailure: unknown = null;
  try {
    assertEmptyWorkspace(workspace.cwd);
  } catch (error) {
    workspaceFailure = error;
  }
  try {
    await removeTemporaryWorkspace(workspace, selectedCodexHome);
  } catch {
    throw new CodexSpikeError('temporary-cleanup-failed');
  }
  if (workspaceFailure !== null) throw safeSpikeError(workspaceFailure);
  if (failure !== null) throw safeSpikeError(failure);
  if (matchedSelection === null) reject('client-start-failed');

  return Object.freeze({
    kind: 'codex-cached-auth-catalog-observation',
    package: Object.freeze({
      name: PINNED_CODEX_PACKAGE,
      version: PINNED_CODEX_VERSION,
      cliVersion: PINNED_CODEX_CLI_VERSION,
      schemaTreeHash: schemaManifest.tree.hash,
    }),
    protocol: Object.freeze({
      transport: 'stdio-jsonl',
      experimental: false,
      remoteControl: 'disabled',
    }),
    observation: Object.freeze({
      exactCredentialHome: true,
      credentialStore: 'file',
      cachedAuthKind: 'chatgpt',
      catalogRouting: 'built-in-openai',
      defaultModel: matchedSelection.model,
      defaultReasoningEffort: matchedSelection.effort,
      distinctNativeProcessRestart: true,
      restartCatalogMatch: true,
    }),
    cleanup: Object.freeze({
      firstProcessDisposed: true,
      secondProcessDisposed: true,
      temporaryRootRemoved: true,
    }),
    unavailable: unavailableEvidence(),
  });
}

async function observeOneProcess(
  factory: CodexSpikeClientFactory,
  codexHome: string,
  cwd: string,
  previousClient?: CodexSpikeClient,
): Promise<ProcessObservation> {
  assertEmptyWorkspace(cwd);
  let client: CodexSpikeClient;
  try {
    client = await factory({
      codexHome,
      cwd,
      stderrPolicy: Object.freeze({ mode: 'fail-on-any' }),
    });
  } catch {
    reject('client-start-failed');
  }
  if (!isSpikeClient(client)) reject('client-start-failed');

  let failure: unknown = null;
  let workspaceFailure: unknown = null;
  let selection: ModelSelection | null = null;
  let unsafeNotification = false;
  let unsubscribe: (() => void) | null = null;
  try {
    if (previousClient !== undefined && client === previousClient) {
      reject('restart-client-reused');
    }
    unsubscribe = client.onNotification((notification) => {
      if (!isSafeNotification(notification)) unsafeNotification = true;
    });
    if (typeof unsubscribe !== 'function') reject('initialize-admission-failed');

    const initialized = await guardedOperation(
      () => client.initialize(codexHome),
      'initialize-admission-failed',
    );
    if (!isSafeInitializeReceipt(initialized)) reject('initialize-admission-failed');
    assertNoUnsafeNotification(unsafeNotification);
    assertEmptyWorkspace(cwd);

    const config = await guardedRequest(
      client,
      'config/read',
      { cwd, includeLayers: true },
      'config-admission-failed',
    );
    assertNoUnsafeNotification(unsafeNotification);
    assertBuiltInConfig(config);

    const account = await guardedRequest(
      client,
      'account/read',
      { refreshToken: false },
      'account-admission-failed',
    );
    assertNoUnsafeNotification(unsafeNotification);
    assertCachedChatgptAccount(account);

    selection = await discoverDefaultModel(client, () => {
      assertNoUnsafeNotification(unsafeNotification);
    });
    assertNoUnsafeNotification(unsafeNotification);
  } catch (error) {
    failure = error;
  }

  let disposalFailed = false;
  try {
    const exit = await client.dispose();
    if (!isProcessExitReceipt(exit)) disposalFailed = true;
  } catch {
    disposalFailed = true;
  }
  try {
    assertEmptyWorkspace(cwd);
  } catch (error) {
    workspaceFailure = error;
  }
  try {
    unsubscribe?.();
  } catch {
    disposalFailed = true;
  }
  if (disposalFailed) reject('process-disposal-failed');
  if (workspaceFailure !== null) throw safeSpikeError(workspaceFailure);
  if (failure !== null) throw safeSpikeError(failure);
  if (selection === null) reject('catalog-default-unavailable');
  return Object.freeze({ client, selection, disposed: true });
}

async function guardedRequest(
  client: CodexSpikeClient,
  method: CodexAdmissionRequestMethod,
  params: unknown,
  fallback: CodexSpikeErrorCode,
): Promise<unknown> {
  return guardedOperation(() => client.request(method, params), fallback);
}

async function guardedOperation<T>(
  operation: () => Promise<T>,
  fallback: CodexSpikeErrorCode,
): Promise<T> {
  try {
    return await operation();
  } catch (error) {
    if (error instanceof CodexSpikeError) throw error;
    throw new CodexSpikeError(fallback);
  }
}

function assertCachedChatgptAccount(value: unknown): void {
  if (!isRecord(value) || !hasExactKeys(value, ['account', 'requiresOpenaiAuth']) ||
    value.requiresOpenaiAuth !== true) {
    reject('account-admission-failed');
  }
  const account = value.account;
  if (!isRecord(account) || !hasExactKeys(account, ['type', 'email', 'planType']) ||
    account.type !== 'chatgpt' ||
    (account.email !== null && typeof account.email !== 'string') ||
    typeof account.planType !== 'string' || !CHATGPT_PLAN_TYPES.has(account.planType)) {
    reject('account-admission-failed');
  }
}

function assertBuiltInConfig(value: unknown): void {
  if (!isRecord(value) || !hasExactKeys(value, ['config', 'origins', 'layers']) ||
    !isRecord(value.config) || !isConfigOrigins(value.origins) ||
    !Array.isArray(value.layers)) {
    reject('config-admission-failed');
  }
  const effective = value.config;
  const origins = value.origins as Record<string, unknown>;
  if (!Object.prototype.hasOwnProperty.call(effective, 'cli_auth_credentials_store') ||
    effective.cli_auth_credentials_store !== 'file') reject('credential-store-unsafe');
  const credentialOrigin = origins.cli_auth_credentials_store;
  const originName = isRecord(credentialOrigin) ? credentialOrigin.name : null;
  const originVersion = isRecord(credentialOrigin) ? credentialOrigin.version : null;
  if (
    !isRecord(credentialOrigin) ||
    !hasExactKeys(credentialOrigin, ['name', 'version']) ||
    !isRecord(originName) ||
    !isConfigLayerSource(originName) ||
    originName.type !== 'sessionFlags' ||
    typeof originVersion !== 'string'
  ) reject('credential-store-unsafe');
  if (!Object.prototype.hasOwnProperty.call(effective, 'model_provider') ||
    (effective.model_provider !== null && effective.model_provider !== 'openai')) {
    reject('config-admission-failed');
  }

  if (hasUnsafeRouting(effective)) reject('config-admission-failed');
  let forcedFileStoreLayer = false;
  for (const layer of value.layers) {
    if (!isConfigLayer(layer)) reject('config-admission-failed');
    if (hasUnsafeRouting(layer.config)) reject('config-admission-failed');
    if (
      isRecord(layer.name) && layer.name.type === 'sessionFlags' &&
      layer.version === originVersion &&
      (!Object.prototype.hasOwnProperty.call(layer, 'disabledReason') ||
        layer.disabledReason === null) &&
      isRecord(layer.config) &&
      Object.prototype.hasOwnProperty.call(layer.config, 'cli_auth_credentials_store') &&
      layer.config.cli_auth_credentials_store === 'file'
    ) forcedFileStoreLayer = true;
  }
  if (!forcedFileStoreLayer) reject('credential-store-unsafe');
}

function isConfigOrigins(value: unknown): boolean {
  if (!isRecord(value)) return false;
  return Object.values(value).every((metadata) =>
    isRecord(metadata) && hasExactKeys(metadata, ['name', 'version']) &&
    isConfigLayerSource(metadata.name) && typeof metadata.version === 'string'
  );
}

function isConfigLayer(value: unknown): value is Record<string, unknown> & { config: unknown } {
  if (!isRecord(value) || !hasOnlyKeys(value, ['name', 'version', 'config', 'disabledReason']) ||
    !Object.prototype.hasOwnProperty.call(value, 'name') ||
    !Object.prototype.hasOwnProperty.call(value, 'version') ||
    !Object.prototype.hasOwnProperty.call(value, 'config') ||
    !isConfigLayerSource(value.name) || typeof value.version !== 'string' ||
    !isJsonValue(value.config)) return false;
  return !Object.prototype.hasOwnProperty.call(value, 'disabledReason') ||
    value.disabledReason === null || typeof value.disabledReason === 'string';
}

function isConfigLayerSource(value: unknown): boolean {
  if (!isRecord(value) || typeof value.type !== 'string') return false;
  switch (value.type) {
    case 'mdm':
      return hasExactKeys(value, ['type', 'domain', 'key']) &&
        typeof value.domain === 'string' && typeof value.key === 'string';
    case 'system':
    case 'legacyManagedConfigTomlFromFile':
      return hasExactKeys(value, ['type', 'file']) && isAbsoluteString(value.file);
    case 'enterpriseManaged':
      return hasExactKeys(value, ['type', 'id', 'name']) &&
        typeof value.id === 'string' && typeof value.name === 'string';
    case 'user':
      return hasExactKeys(value, ['type', 'file', 'profile']) && isAbsoluteString(value.file) &&
        (value.profile === null || typeof value.profile === 'string');
    case 'project':
      return hasExactKeys(value, ['type', 'dotCodexFolder']) &&
        isAbsoluteString(value.dotCodexFolder);
    case 'sessionFlags':
    case 'legacyManagedConfigTomlFromMdm':
      return hasExactKeys(value, ['type']);
    default:
      return false;
  }
}

function hasUnsafeRouting(root: unknown): boolean {
  const seen = new WeakSet<object>();
  const stack: unknown[] = [root];
  while (stack.length > 0) {
    const current = stack.pop()!;
    if (current === null || typeof current !== 'object') continue;
    if (seen.has(current)) return true;
    seen.add(current);
    if (Array.isArray(current)) {
      for (const item of current) stack.push(item);
      continue;
    }
    for (const [rawKey, child] of Object.entries(current)) {
      const key = rawKey.toLowerCase();
      if (FORBIDDEN_ROUTING_KEYS.has(key)) {
        if (key === 'model_providers') {
          if (!isRecord(child) || Object.keys(child).length !== 0) return true;
        } else if (child !== null) {
          return true;
        }
      }
      if (key === 'model_provider' && child !== null && child !== 'openai') return true;
      stack.push(child);
    }
  }
  return false;
}

async function discoverDefaultModel(
  client: CodexSpikeClient,
  assertSafe: () => void,
): Promise<ModelSelection> {
  const defaults: ModelSelection[] = [];
  const modelIds = new Set<string>();
  const cursors = new Set<string>();
  let cursor: string | null = null;

  for (let pageIndex = 0; pageIndex < MAX_CATALOG_PAGES; pageIndex += 1) {
    const params = cursor === null
      ? { includeHidden: false }
      : { cursor, includeHidden: false };
    const page = await guardedRequest(
      client,
      'model/list',
      params,
      'catalog-default-unavailable',
    );
    assertSafe();
    if (!isRecord(page) || !hasExactKeys(page, ['data', 'nextCursor']) ||
      !Array.isArray(page.data)) {
      reject('catalog-default-invalid');
    }
    if (page.nextCursor !== null && !isCanonicalString(page.nextCursor)) {
      reject('catalog-pagination-invalid');
    }

    for (const item of page.data) {
      if (!isModel(item) || !isCanonicalString(item.id) ||
        !isCanonicalString(item.model) || !isCanonicalString(item.displayName) ||
        !isCanonicalString(item.defaultReasoningEffort) ||
        !Array.isArray(item.supportedReasoningEfforts)) {
        reject('catalog-default-invalid');
      }
      if (item.hidden || modelIds.has(item.id)) reject('catalog-default-invalid');
      modelIds.add(item.id);
      const supportedEfforts = new Set<string>();
      for (const entry of item.supportedReasoningEfforts) {
        if (!isRecord(entry) || !hasExactKeys(entry, ['reasoningEffort', 'description']) ||
          !isCanonicalString(entry.reasoningEffort) || typeof entry.description !== 'string' ||
          supportedEfforts.has(entry.reasoningEffort)) {
          reject('catalog-default-invalid');
        }
        supportedEfforts.add(entry.reasoningEffort);
      }
      if (!supportedEfforts.has(item.defaultReasoningEffort)) {
        reject('catalog-default-invalid');
      }
      if (!item.isDefault) continue;
      defaults.push(Object.freeze({
        model: item.model,
        effort: item.defaultReasoningEffort,
      }));
    }

    if (page.nextCursor === null) break;
    if (cursors.has(page.nextCursor)) reject('catalog-pagination-invalid');
    cursors.add(page.nextCursor);
    cursor = page.nextCursor;
    if (pageIndex === MAX_CATALOG_PAGES - 1) reject('catalog-pagination-invalid');
  }

  if (defaults.length === 0) reject('catalog-default-unavailable');
  if (defaults.length !== 1) reject('catalog-default-ambiguous');
  return defaults[0]!;
}

function isModel(value: unknown): value is Record<string, unknown> {
  return isRecord(value) && hasExactKeys(value, MODEL_KEYS) &&
    isNullableString(value.upgrade) && isModelUpgradeInfo(value.upgradeInfo) &&
    isModelAvailabilityNux(value.availabilityNux) &&
    typeof value.description === 'string' && typeof value.hidden === 'boolean' &&
    Array.isArray(value.supportedReasoningEfforts) &&
    Array.isArray(value.inputModalities) &&
    value.inputModalities.every((entry) => entry === 'text' || entry === 'image') &&
    typeof value.supportsPersonality === 'boolean' &&
    isStringArray(value.additionalSpeedTiers) && Array.isArray(value.serviceTiers) &&
    value.serviceTiers.every(isModelServiceTier) &&
    isNullableString(value.defaultServiceTier) && typeof value.isDefault === 'boolean';
}

function isModelUpgradeInfo(value: unknown): boolean {
  return value === null || (isRecord(value) &&
    hasExactKeys(value, ['model', 'upgradeCopy', 'modelLink', 'migrationMarkdown']) &&
    typeof value.model === 'string' && isNullableString(value.upgradeCopy) &&
    isNullableString(value.modelLink) && isNullableString(value.migrationMarkdown));
}

function isModelAvailabilityNux(value: unknown): boolean {
  return value === null || (isRecord(value) && hasExactKeys(value, ['message']) &&
    typeof value.message === 'string');
}

function isModelServiceTier(value: unknown): boolean {
  return isRecord(value) && hasExactKeys(value, ['id', 'name', 'description']) &&
    typeof value.id === 'string' && typeof value.name === 'string' &&
    typeof value.description === 'string';
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((entry) => typeof entry === 'string');
}

function isNullableString(value: unknown): value is string | null {
  return value === null || typeof value === 'string';
}

function isAbsoluteString(value: unknown): value is string {
  return isCanonicalString(value) && isAbsolute(value) && normalize(value) === value;
}

function isJsonValue(value: unknown, seen = new WeakSet<object>()): boolean {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return true;
  if (typeof value === 'number') return Number.isFinite(value);
  if (typeof value !== 'object' || seen.has(value)) return false;
  seen.add(value);
  if (Array.isArray(value)) return value.every((entry) => isJsonValue(entry, seen));
  return Object.values(value).every((entry) => isJsonValue(entry, seen));
}

function createTemporaryWorkspace(codexHome: string): TemporaryWorkspace {
  let parent: string;
  try {
    parent = realpathSync.native(tmpdir());
  } catch {
    reject('temporary-root-unsafe');
  }
  if (!isAbsolute(parent) || isWithin(codexHome, parent)) {
    reject('temporary-root-unsafe');
  }

  let createdRoot: string | null = null;
  try {
    createdRoot = mkdtempSync(join(parent, TEMPORARY_ROOT_PREFIX));
    const root = realpathSync.native(createdRoot);
    if (
      dirname(root) !== parent ||
      !basename(root).startsWith(TEMPORARY_ROOT_PREFIX) ||
      isWithin(codexHome, root) ||
      isWithin(root, codexHome)
    ) reject('temporary-root-unsafe');

    const cwd = join(root, 'empty-cwd');
    mkdirSync(cwd);
    return Object.freeze({ parent, root, cwd });
  } catch {
    if (
      createdRoot !== null && dirname(createdRoot) === parent &&
      basename(createdRoot).startsWith(TEMPORARY_ROOT_PREFIX)
    ) {
      try {
        rmSync(createdRoot, { recursive: true, force: true });
      } catch {
        // The stable failure below never claims cleanup success.
      }
    }
    reject('temporary-root-unsafe');
  }
}

async function removeTemporaryWorkspace(
  workspace: TemporaryWorkspace,
  codexHome: string,
): Promise<void> {
  if (
    dirname(workspace.root) !== workspace.parent ||
    !basename(workspace.root).startsWith(TEMPORARY_ROOT_PREFIX) ||
    isWithin(codexHome, workspace.root) ||
    isWithin(workspace.root, codexHome) ||
    lstatSync(workspace.root).isSymbolicLink() ||
    realpathSync.native(workspace.root) !== workspace.root
  ) throw new Error('unsafe temporary root');
  await rm(workspace.root, {
    recursive: true,
    force: false,
    maxRetries: 3,
    retryDelay: 50,
  });
  if (existsSync(workspace.root)) throw new Error('temporary root remains');
}

function assertEmptyWorkspace(cwd: string): void {
  try {
    if (readdirSync(cwd).length !== 0) reject('temporary-workspace-mutated');
  } catch (error) {
    if (error instanceof CodexSpikeError) throw error;
    reject('temporary-workspace-mutated');
  }
}

function isWithin(parent: string, child: string): boolean {
  const path = relative(parent, child);
  return path === '' || (!isAbsolute(path) && path !== '..' && !path.startsWith(`..${sep}`));
}

function isSpikeClient(value: unknown): value is CodexSpikeClient {
  if (!isRecord(value)) return false;
  return typeof value.initialize === 'function' && typeof value.request === 'function' &&
    typeof value.onNotification === 'function' && typeof value.dispose === 'function';
}

function isSafeInitializeReceipt(value: unknown): boolean {
  if (!isRecord(value) || value.status !== 'initialized' || value.exactCodexHome !== true ||
    !isRecord(value.remoteControl)) return false;
  return value.remoteControl.status === 'disabled' &&
    value.remoteControl.environmentId === null;
}

function isProcessExitReceipt(value: unknown): boolean {
  if (!isRecord(value) || !hasExactKeys(value, ['status', 'code', 'signal']) ||
    value.status !== 'exited') return false;
  const hasCode = Number.isSafeInteger(value.code) && (value.code as number) >= 0;
  const hasSignal = typeof value.signal === 'string' &&
    Object.prototype.hasOwnProperty.call(constants.signals, value.signal);
  return hasCode !== hasSignal && (hasCode ? value.signal === null : value.code === null);
}

function isSafeNotification(value: unknown): boolean {
  if (!isRecord(value) || typeof value.method !== 'string') return false;
  return value.method === 'remoteControl/status/changed' && value.status === 'disabled' &&
    value.environmentId === null;
}

function assertNoUnsafeNotification(unsafe: boolean): void {
  if (unsafe) reject('unsafe-notification');
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function hasExactKeys(value: Record<string, unknown>, expected: readonly string[]): boolean {
  const keys = Reflect.ownKeys(value);
  return keys.length === expected.length && expected.every((key) =>
    Object.prototype.hasOwnProperty.call(value, key)
  );
}

function hasOnlyKeys(value: Record<string, unknown>, allowed: readonly string[]): boolean {
  return Object.keys(value).every((key) => allowed.includes(key));
}

function isCanonicalString(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && value.trim() === value &&
    !value.includes('\u0000');
}

function unavailableEvidence(): CodexAdmissionSpikeReceipt['unavailable'] {
  return Object.freeze({
    credentialFreshness: 'unavailable',
    entitlement: 'unavailable',
    subscriptionUsability: 'unavailable',
    billingRoute: 'unavailable',
    modelUsability: 'unavailable',
    modelInference: 'unavailable',
    nativeCreateResume: 'unavailable',
    nativeContinuation: 'unavailable',
    terminalTurns: 'unavailable',
    interruption: 'unavailable',
    approvals: 'unavailable',
    toolsAndMcp: 'unavailable',
    context: 'unavailable',
    rateLimitNormalization: 'unavailable',
    canonicalRuntimeMapping: 'unavailable',
    dispatch: 'unavailable',
    descendantContainment: 'unavailable',
  });
}

function safeSpikeError(error: unknown): CodexSpikeError | CodexEnvironmentError {
  if (error instanceof CodexSpikeError || error instanceof CodexEnvironmentError) return error;
  return new CodexSpikeError('client-start-failed');
}

function reject(code: CodexSpikeErrorCode): never {
  throw new CodexSpikeError(code);
}
