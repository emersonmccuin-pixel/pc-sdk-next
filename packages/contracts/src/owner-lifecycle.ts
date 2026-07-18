export const CX004_PROCESS_INPUT_LIMITS = Object.freeze({
  applicationPathUtf16UnitsIncludingTerminator: 32_765,
  cwdUtf16UnitsIncludingTerminator: 32_767,
  argumentCountIncludingArgv0: 1_024,
  logicalArgumentUtf16ContentUnits: 8_192,
  commandLineUtf16UnitsIncludingTerminator: 32_767,
  environmentEntries: 256,
  environmentNameUtf16ContentUnits: 256,
  environmentValueUtf16ContentUnits: 8_192,
  environmentBlockUtf16UnitsIncludingDoubleNul: 65_536,
} as const);

export const PLATFORM_ADMISSION_UNSUPPORTED_CODES = Object.freeze([
  'platform-unsupported',
  'architecture-unsupported',
  'qualification-identity-mismatch',
  'production-admission-forbidden',
] as const);

export const PLATFORM_ADMISSION_UNAVAILABLE_CODES = Object.freeze([
  'platform-observation-unavailable',
  'qualification-unavailable',
  'native-build-input-unavailable',
] as const);

export type PlatformAdmissionUnsupportedCode =
  (typeof PLATFORM_ADMISSION_UNSUPPORTED_CODES)[number];
export type PlatformAdmissionUnavailableCode =
  (typeof PLATFORM_ADMISSION_UNAVAILABLE_CODES)[number];

export type PlatformAdmission =
  | {
      status: 'admitted';
      platform: 'win32';
      architecture: 'x64';
      scope: 'fake-lab-only';
      admissionId: string;
      qualificationReceiptSha256: string;
      nativeBuildInputSha256: string;
    }
  | {
      status: 'unsupported';
      code: PlatformAdmissionUnsupportedCode;
    }
  | {
      status: 'unavailable';
      code: PlatformAdmissionUnavailableCode;
    };

export const CONTAINED_JOB_TEMPLATES = Object.freeze(['cx004-leaf', 'cx004-session'] as const);
export type ContainedJobTemplate = (typeof CONTAINED_JOB_TEMPLATES)[number];

export type ContainedProcessPrincipal =
  | { kind: 'same-token' }
  | {
      kind: 'restricted-principal';
      receiptId: string;
      receiptSha256: string;
    };

export interface ContainedExecutableIdentity {
  logicalId: string;
  canonicalPathCandidate: string;
  sha256: string;
}

export interface ContainedEnvironmentEntry {
  name: string;
  value: string;
}

export interface ContainedProcessStartRequest {
  requestId: string;
  admissionId: string;
  jobTemplate: ContainedJobTemplate;
  principal: ContainedProcessPrincipal;
  executable: ContainedExecutableIdentity;
  argv: readonly string[];
  cwd: string;
  environment: readonly ContainedEnvironmentEntry[];
}

export const CONTAINED_PROCESS_UNSUPPORTED_CODES = Object.freeze([
  'job-template-unsupported',
  'principal-unsupported',
  'executable-unsupported',
] as const);

export const CONTAINED_PROCESS_UNAVAILABLE_CODES = Object.freeze([
  'process-creation-unavailable',
  'principal-unavailable',
  'native-runtime-unavailable',
] as const);

export type ContainedProcessUnsupportedCode =
  (typeof CONTAINED_PROCESS_UNSUPPORTED_CODES)[number];
export type ContainedProcessUnavailableCode =
  (typeof CONTAINED_PROCESS_UNAVAILABLE_CODES)[number];

export interface ContainedProcessNativeStartReceipt {
  receiptId: string;
  receiptSha256: string;
  requestId: string;
  admissionId: string;
  containedProcessId: string;
  jobTemplate: ContainedJobTemplate;
  executableSha256: string;
  ownerGeneration: number;
  requestBinding: ContainedProcessRequestBinding;
}

export interface ContainedProcessRequestBinding {
  principal: ContainedProcessPrincipal;
  executable: ContainedExecutableIdentity;
  argv: readonly string[];
  cwd: string;
  environment: readonly ContainedEnvironmentEntry[];
}

export type ContainedProcessStartResult =
  | {
      status: 'started';
      requestId: string;
      admissionId: string;
      containedProcessId: string;
      nativeReceipt: ContainedProcessNativeStartReceipt;
    }
  | {
      status: 'unsupported';
      requestId: string;
      admissionId: string;
      code: ContainedProcessUnsupportedCode;
    }
  | {
      status: 'unavailable';
      requestId: string;
      admissionId: string;
      code: ContainedProcessUnavailableCode;
    };

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function hasExactOwnKeys(
  value: unknown,
  expectedKeys: readonly string[],
): value is Record<string, unknown> {
  if (!isPlainRecord(value)) return false;
  const actualKeys = Reflect.ownKeys(value);
  return actualKeys.length === expectedKeys.length &&
    expectedKeys.every((key) => Object.prototype.hasOwnProperty.call(value, key));
}

function isOneOf<T extends string>(value: unknown, values: readonly T[]): value is T {
  return typeof value === 'string' && values.some((candidate) => candidate === value);
}

function hasValidUtf16(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const unit = value.charCodeAt(index);
    if (unit === 0) return false;
    if (unit >= 0xd800 && unit <= 0xdbff) {
      if (index + 1 >= value.length) return false;
      const next = value.charCodeAt(index + 1);
      if (next < 0xdc00 || next > 0xdfff) return false;
      index += 1;
    } else if (unit >= 0xdc00 && unit <= 0xdfff) {
      return false;
    }
  }
  return true;
}

function isOpaqueId(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && value.trim() === value &&
    hasValidUtf16(value);
}

function isSha256(value: unknown): value is string {
  return typeof value === 'string' && /^[0-9a-f]{64}$/.test(value);
}

function isNonNegativeSafeInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}

function isBoundedText(value: unknown, contentLimit: number, allowEmpty: boolean): value is string {
  return typeof value === 'string' && (allowEmpty || value.length > 0) &&
    value.length <= contentLimit && hasValidUtf16(value);
}

function quotedWindowsArgumentLength(argument: string, forceQuotes: boolean): number {
  const needsQuotes = forceQuotes || argument.length === 0 || /[\s"]/.test(argument);
  if (!needsQuotes) return argument.length;

  let encodedLength = 2;
  let backslashes = 0;
  for (let index = 0; index < argument.length; index += 1) {
    const character = argument[index];
    if (character === '\\') {
      backslashes += 1;
      continue;
    }
    if (character === '"') {
      encodedLength += (backslashes * 2) + 2;
    } else {
      encodedLength += backslashes + 1;
    }
    backslashes = 0;
  }
  return encodedLength + (backslashes * 2);
}

function hasBoundedWindowsCommandLine(argv: readonly string[]): boolean {
  let encodedLength = 1;
  for (let index = 0; index < argv.length; index += 1) {
    if (index > 0) encodedLength += 1;
    encodedLength += quotedWindowsArgumentLength(argv[index]!, index === 0);
    if (encodedLength > CX004_PROCESS_INPUT_LIMITS.commandLineUtf16UnitsIncludingTerminator) {
      return false;
    }
  }
  return true;
}

function foldAscii(value: string): string {
  let folded = '';
  for (let index = 0; index < value.length; index += 1) {
    const unit = value.charCodeAt(index);
    folded += unit >= 65 && unit <= 90 ? String.fromCharCode(unit + 32) : value[index];
  }
  return folded;
}

function compareEnvironmentNames(left: string, right: string): number {
  const foldedLeft = foldAscii(left);
  const foldedRight = foldAscii(right);
  if (foldedLeft < foldedRight) return -1;
  if (foldedLeft > foldedRight) return 1;
  return 0;
}

function isContainedEnvironment(value: unknown): value is readonly ContainedEnvironmentEntry[] {
  if (!Array.isArray(value) || value.length > CX004_PROCESS_INPUT_LIMITS.environmentEntries) {
    return false;
  }

  let blockLength = value.length === 0 ? 2 : 1;
  let previousName: string | null = null;
  for (const entry of value) {
    if (!hasExactOwnKeys(entry, ['name', 'value']) ||
      typeof entry.name !== 'string' ||
      !/^[A-Za-z_][A-Za-z0-9_()]*$/.test(entry.name) ||
      entry.name.length > CX004_PROCESS_INPUT_LIMITS.environmentNameUtf16ContentUnits ||
      !isBoundedText(
        entry.value,
        CX004_PROCESS_INPUT_LIMITS.environmentValueUtf16ContentUnits,
        true,
      )) {
      return false;
    }
    if (previousName !== null && compareEnvironmentNames(previousName, entry.name) >= 0) {
      return false;
    }
    previousName = entry.name;
    blockLength += entry.name.length + 1 + entry.value.length + 1;
    if (blockLength > CX004_PROCESS_INPUT_LIMITS.environmentBlockUtf16UnitsIncludingDoubleNul) {
      return false;
    }
  }
  return true;
}

export function isPlatformAdmission(value: unknown): value is PlatformAdmission {
  if (!isPlainRecord(value)) return false;
  if (value.status === 'admitted') {
    return hasExactOwnKeys(value, [
      'status',
      'platform',
      'architecture',
      'scope',
      'admissionId',
      'qualificationReceiptSha256',
      'nativeBuildInputSha256',
    ]) && value.platform === 'win32' && value.architecture === 'x64' &&
      value.scope === 'fake-lab-only' && isOpaqueId(value.admissionId) &&
      isSha256(value.qualificationReceiptSha256) && isSha256(value.nativeBuildInputSha256);
  }
  if (value.status === 'unsupported') {
    return hasExactOwnKeys(value, ['status', 'code']) &&
      isOneOf(value.code, PLATFORM_ADMISSION_UNSUPPORTED_CODES);
  }
  if (value.status === 'unavailable') {
    return hasExactOwnKeys(value, ['status', 'code']) &&
      isOneOf(value.code, PLATFORM_ADMISSION_UNAVAILABLE_CODES);
  }
  return false;
}

export function isContainedJobTemplate(value: unknown): value is ContainedJobTemplate {
  return isOneOf(value, CONTAINED_JOB_TEMPLATES);
}

export function isContainedProcessPrincipal(value: unknown): value is ContainedProcessPrincipal {
  if (!isPlainRecord(value)) return false;
  if (value.kind === 'same-token') return hasExactOwnKeys(value, ['kind']);
  return value.kind === 'restricted-principal' &&
    hasExactOwnKeys(value, ['kind', 'receiptId', 'receiptSha256']) &&
    isOpaqueId(value.receiptId) && isSha256(value.receiptSha256);
}

export function isContainedProcessStartRequest(
  value: unknown,
): value is ContainedProcessStartRequest {
  if (!hasExactOwnKeys(value, [
    'requestId',
    'admissionId',
    'jobTemplate',
    'principal',
    'executable',
    'argv',
    'cwd',
    'environment',
  ]) || !isOpaqueId(value.requestId) || !isOpaqueId(value.admissionId) ||
    !isContainedJobTemplate(value.jobTemplate) || !isContainedProcessPrincipal(value.principal) ||
    !hasExactOwnKeys(value.executable, ['logicalId', 'canonicalPathCandidate', 'sha256']) ||
    !isOpaqueId(value.executable.logicalId) || !isSha256(value.executable.sha256) ||
    !isBoundedText(
      value.executable.canonicalPathCandidate,
      CX004_PROCESS_INPUT_LIMITS.applicationPathUtf16UnitsIncludingTerminator - 1,
      false,
    ) || !isBoundedText(
      value.cwd,
      CX004_PROCESS_INPUT_LIMITS.cwdUtf16UnitsIncludingTerminator - 1,
      false,
    ) || !Array.isArray(value.argv) || value.argv.length === 0 ||
    value.argv.length > CX004_PROCESS_INPUT_LIMITS.argumentCountIncludingArgv0 ||
    value.argv[0] !== value.executable.canonicalPathCandidate) {
    return false;
  }

  for (let index = 0; index < value.argv.length; index += 1) {
    const limit = index === 0
      ? CX004_PROCESS_INPUT_LIMITS.applicationPathUtf16UnitsIncludingTerminator - 1
      : CX004_PROCESS_INPUT_LIMITS.logicalArgumentUtf16ContentUnits;
    if (!isBoundedText(value.argv[index], limit, index !== 0)) return false;
  }

  return hasBoundedWindowsCommandLine(value.argv) && isContainedEnvironment(value.environment);
}

function isContainedProcessNativeStartReceipt(
  value: unknown,
): value is ContainedProcessNativeStartReceipt {
  if (!hasExactOwnKeys(value, [
    'receiptId',
    'receiptSha256',
    'requestId',
    'admissionId',
    'containedProcessId',
    'jobTemplate',
    'executableSha256',
    'ownerGeneration',
    'requestBinding',
  ]) || !isOpaqueId(value.receiptId) || !isSha256(value.receiptSha256) ||
    !isOpaqueId(value.requestId) || !isOpaqueId(value.admissionId) ||
    !isOpaqueId(value.containedProcessId) || !isContainedJobTemplate(value.jobTemplate) ||
    !isSha256(value.executableSha256) || !isNonNegativeSafeInteger(value.ownerGeneration) ||
    !hasExactOwnKeys(value.requestBinding, [
      'principal',
      'executable',
      'argv',
      'cwd',
      'environment',
    ])) {
    return false;
  }

  const boundRequest: unknown = {
    requestId: value.requestId,
    admissionId: value.admissionId,
    jobTemplate: value.jobTemplate,
    principal: value.requestBinding.principal,
    executable: value.requestBinding.executable,
    argv: value.requestBinding.argv,
    cwd: value.requestBinding.cwd,
    environment: value.requestBinding.environment,
  };
  return isContainedProcessStartRequest(boundRequest) &&
    value.executableSha256 === boundRequest.executable.sha256;
}

function stringArraysEqual(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

function principalsEqual(
  left: ContainedProcessPrincipal,
  right: ContainedProcessPrincipal,
): boolean {
  if (left.kind !== right.kind) return false;
  return left.kind === 'same-token' ||
    (right.kind === 'restricted-principal' && left.receiptId === right.receiptId &&
      left.receiptSha256 === right.receiptSha256);
}

function environmentsEqual(
  left: readonly ContainedEnvironmentEntry[],
  right: readonly ContainedEnvironmentEntry[],
): boolean {
  return left.length === right.length && left.every((entry, index) =>
    entry.name === right[index]?.name && entry.value === right[index]?.value);
}

function requestBindingMatches(
  binding: ContainedProcessRequestBinding,
  request: ContainedProcessStartRequest,
): boolean {
  return principalsEqual(binding.principal, request.principal) &&
    binding.executable.logicalId === request.executable.logicalId &&
    binding.executable.canonicalPathCandidate === request.executable.canonicalPathCandidate &&
    binding.executable.sha256 === request.executable.sha256 &&
    stringArraysEqual(binding.argv, request.argv) && binding.cwd === request.cwd &&
    environmentsEqual(binding.environment, request.environment);
}

export function isContainedProcessStartResult(
  value: unknown,
): value is ContainedProcessStartResult {
  if (!isPlainRecord(value)) return false;
  if (value.status === 'started') {
    return hasExactOwnKeys(value, [
      'status',
      'requestId',
      'admissionId',
      'containedProcessId',
      'nativeReceipt',
    ]) && isOpaqueId(value.requestId) && isOpaqueId(value.admissionId) &&
      isOpaqueId(value.containedProcessId) &&
      isContainedProcessNativeStartReceipt(value.nativeReceipt) &&
      value.nativeReceipt.requestId === value.requestId &&
      value.nativeReceipt.admissionId === value.admissionId &&
      value.nativeReceipt.containedProcessId === value.containedProcessId;
  }
  if (value.status === 'unsupported') {
    return hasExactOwnKeys(value, ['status', 'requestId', 'admissionId', 'code']) &&
      isOpaqueId(value.requestId) && isOpaqueId(value.admissionId) &&
      isOneOf(value.code, CONTAINED_PROCESS_UNSUPPORTED_CODES);
  }
  if (value.status === 'unavailable') {
    return hasExactOwnKeys(value, ['status', 'requestId', 'admissionId', 'code']) &&
      isOpaqueId(value.requestId) && isOpaqueId(value.admissionId) &&
      isOneOf(value.code, CONTAINED_PROCESS_UNAVAILABLE_CODES);
  }
  return false;
}

export function containedProcessStartResultMatchesRequest(
  result: unknown,
  request: unknown,
): boolean {
  if (!isContainedProcessStartResult(result) || !isContainedProcessStartRequest(request) ||
    result.requestId !== request.requestId || result.admissionId !== request.admissionId) {
    return false;
  }
  return result.status !== 'started' ||
    (result.nativeReceipt.jobTemplate === request.jobTemplate &&
      result.nativeReceipt.executableSha256 === request.executable.sha256 &&
      requestBindingMatches(result.nativeReceipt.requestBinding, request));
}

export const PROCESS_CREATION_POISON_CAUSES = Object.freeze([
  'resource-release-uncertain',
  'handle-state-uncertain',
  'resume-state-uncertain',
  'coordinator-publication-uncertain',
  'cleanup-uncertain',
] as const);

export type ProcessCreationPoisonCause = (typeof PROCESS_CREATION_POISON_CAUSES)[number];

export type AvailableProcessCreationState = {
  status: 'available';
  ownerGeneration: number;
};

export type PoisonedProcessCreationState = {
  status: 'poisoned';
  cause: ProcessCreationPoisonCause;
  ownerGeneration: number;
  restartAllowed: false;
  nonRestartShutdownRequired: true;
};

export type ProcessCreationState = AvailableProcessCreationState | PoisonedProcessCreationState;

export const CONTAINED_PROCESS_TERMINATION_MODES = Object.freeze(
  ['natural', 'graceful', 'job'] as const,
);
export type ContainedProcessTerminationMode =
  (typeof CONTAINED_PROCESS_TERMINATION_MODES)[number];

export const CLEANUP_UNCERTAINTY_CODES = Object.freeze([
  'root-signal-unavailable',
  'exit-code-unavailable',
  'stream-settlement-uncertain',
  'native-io-pending',
  'worker-settlement-uncertain',
  'parent-baseline-uncertain',
  'termination-unavailable',
] as const);

export type CleanupUncertaintyCode = (typeof CLEANUP_UNCERTAINTY_CODES)[number];

export type ContainedProcessCleanupReceipt =
  | {
      receiptId: string;
      containedProcessId: string;
      terminationMode: ContainedProcessTerminationMode;
      cleanupProof: 'tree-exited';
      rootSignaled: true;
      expectedExitCode: number;
      observedExitCode: number;
      stdinSettled: true;
      stdoutEof: true;
      stderrEof: true;
      pendingIoCount: 0;
      pendingWorkerCount: 0;
      parentBaselinesRestored: true;
    }
  | {
      receiptId: string;
      containedProcessId: string;
      terminationMode: ContainedProcessTerminationMode;
      cleanupProof: 'uncertain';
      uncertaintyCode: CleanupUncertaintyCode;
      processCreationState: PoisonedProcessCreationState;
    };

export interface OwnerRestartTuple {
  nonce: string;
  oldGeneration: number;
  newGeneration: number;
  digestSha256: string;
}

export const OWNER_RESTART_STATES = Object.freeze([
  'prepared',
  'committed',
  'aborted',
  'completed',
  'interrupted',
  'attention',
] as const);

export type OwnerRestartState = (typeof OWNER_RESTART_STATES)[number];

export interface OwnerRestartTransitionReceipt {
  receiptId: string;
  tuple: OwnerRestartTuple;
  fromState: OwnerRestartState | null;
  toState: OwnerRestartState;
  sequence: number;
  rowDigestSha256: string;
  outboxEventId: string;
  outboxEventDigestSha256: string;
}

export interface SuccessorAdmittedAck {
  ackId: string;
  containedProcessId: string;
  admissionReceiptId: string;
  committedTransitionReceiptId: string;
  tuple: OwnerRestartTuple;
  ownerGeneration: number;
}

function isPoisonedProcessCreationState(value: unknown): value is PoisonedProcessCreationState {
  return hasExactOwnKeys(value, [
    'status',
    'cause',
    'ownerGeneration',
    'restartAllowed',
    'nonRestartShutdownRequired',
  ]) && value.status === 'poisoned' && isOneOf(value.cause, PROCESS_CREATION_POISON_CAUSES) &&
    isNonNegativeSafeInteger(value.ownerGeneration) && value.restartAllowed === false &&
    value.nonRestartShutdownRequired === true;
}

export function isProcessCreationState(value: unknown): value is ProcessCreationState {
  if (!isPlainRecord(value)) return false;
  if (value.status === 'available') {
    return hasExactOwnKeys(value, ['status', 'ownerGeneration']) &&
      isNonNegativeSafeInteger(value.ownerGeneration);
  }
  return isPoisonedProcessCreationState(value);
}

export function isProcessCreationStateTransitionAllowed(
  previous: unknown,
  next: unknown,
): boolean {
  return isProcessCreationState(previous) && previous.status === 'available' &&
    isProcessCreationState(next) && next.status === 'poisoned' &&
    next.ownerGeneration === previous.ownerGeneration;
}

function isWindowsExitCode(value: unknown): value is number {
  return isNonNegativeSafeInteger(value) && value <= 0xffff_ffff;
}

export function isContainedProcessCleanupReceipt(
  value: unknown,
): value is ContainedProcessCleanupReceipt {
  if (!isPlainRecord(value) || !isOpaqueId(value.receiptId) ||
    !isOpaqueId(value.containedProcessId) ||
    !isOneOf(value.terminationMode, CONTAINED_PROCESS_TERMINATION_MODES)) {
    return false;
  }
  if (value.cleanupProof === 'tree-exited') {
    return hasExactOwnKeys(value, [
      'receiptId',
      'containedProcessId',
      'terminationMode',
      'cleanupProof',
      'rootSignaled',
      'expectedExitCode',
      'observedExitCode',
      'stdinSettled',
      'stdoutEof',
      'stderrEof',
      'pendingIoCount',
      'pendingWorkerCount',
      'parentBaselinesRestored',
    ]) && value.rootSignaled === true && isWindowsExitCode(value.expectedExitCode) &&
      isWindowsExitCode(value.observedExitCode) &&
      value.observedExitCode === value.expectedExitCode && value.stdinSettled === true &&
      value.stdoutEof === true && value.stderrEof === true && value.pendingIoCount === 0 &&
      value.pendingWorkerCount === 0 && value.parentBaselinesRestored === true;
  }
  if (value.cleanupProof === 'uncertain') {
    return hasExactOwnKeys(value, [
      'receiptId',
      'containedProcessId',
      'terminationMode',
      'cleanupProof',
      'uncertaintyCode',
      'processCreationState',
    ]) && isOneOf(value.uncertaintyCode, CLEANUP_UNCERTAINTY_CODES) &&
      isPoisonedProcessCreationState(value.processCreationState);
  }
  return false;
}

export function containedProcessCleanupReceiptMatchesStartedResult(
  cleanupReceipt: unknown,
  startedResult: unknown,
): boolean {
  return isContainedProcessCleanupReceipt(cleanupReceipt) &&
    isContainedProcessStartResult(startedResult) && startedResult.status === 'started' &&
    cleanupReceipt.containedProcessId === startedResult.containedProcessId &&
    (cleanupReceipt.cleanupProof === 'tree-exited' ||
      cleanupReceipt.processCreationState.ownerGeneration ===
        startedResult.nativeReceipt.ownerGeneration);
}

export function isOwnerRestartTuple(value: unknown): value is OwnerRestartTuple {
  return hasExactOwnKeys(value, [
    'nonce',
    'oldGeneration',
    'newGeneration',
    'digestSha256',
  ]) && isOpaqueId(value.nonce) && isNonNegativeSafeInteger(value.oldGeneration) &&
    value.oldGeneration < Number.MAX_SAFE_INTEGER &&
    isNonNegativeSafeInteger(value.newGeneration) &&
    value.newGeneration === value.oldGeneration + 1 && isSha256(value.digestSha256);
}

export function isOwnerRestartState(value: unknown): value is OwnerRestartState {
  return isOneOf(value, OWNER_RESTART_STATES);
}

export function isOwnerRestartTransitionAllowed(
  fromState: unknown,
  toState: unknown,
): boolean {
  if (!isOwnerRestartState(toState)) return false;
  if (fromState === null) return toState === 'prepared';
  if (!isOwnerRestartState(fromState)) return false;
  if (fromState === 'prepared') {
    return toState === 'committed' || toState === 'aborted' ||
      toState === 'interrupted' || toState === 'attention';
  }
  if (fromState === 'committed') {
    return toState === 'completed' || toState === 'interrupted' || toState === 'attention';
  }
  return fromState === 'interrupted' && toState === 'attention';
}

function ownerRestartTuplesEqual(left: OwnerRestartTuple, right: OwnerRestartTuple): boolean {
  return left.nonce === right.nonce && left.oldGeneration === right.oldGeneration &&
    left.newGeneration === right.newGeneration && left.digestSha256 === right.digestSha256;
}

export function isOwnerRestartTransitionReceipt(
  value: unknown,
): value is OwnerRestartTransitionReceipt {
  if (!hasExactOwnKeys(value, [
    'receiptId',
    'tuple',
    'fromState',
    'toState',
    'sequence',
    'rowDigestSha256',
    'outboxEventId',
    'outboxEventDigestSha256',
  ]) || !isOpaqueId(value.receiptId) || !isOwnerRestartTuple(value.tuple) ||
    !(value.fromState === null || isOwnerRestartState(value.fromState)) ||
    !isOwnerRestartState(value.toState) ||
    !isOwnerRestartTransitionAllowed(value.fromState, value.toState) ||
    !Number.isSafeInteger(value.sequence) || (value.sequence as number) <= 0 ||
    !isSha256(value.rowDigestSha256) || !isOpaqueId(value.outboxEventId) ||
    !isSha256(value.outboxEventDigestSha256)) {
    return false;
  }
  if (value.fromState === null) return value.sequence === 1;
  if (value.fromState === 'prepared') return value.sequence === 2;
  if (value.fromState === 'committed') return value.sequence === 3;
  return value.sequence === 3 || value.sequence === 4;
}

export function ownerRestartTransitionFollows(
  previous: unknown,
  next: unknown,
): boolean {
  if (!isOwnerRestartTransitionReceipt(previous) ||
    !isOwnerRestartTransitionReceipt(next) || previous.sequence >= Number.MAX_SAFE_INTEGER) {
    return false;
  }
  return next.fromState === previous.toState && next.sequence === previous.sequence + 1 &&
    ownerRestartTuplesEqual(next.tuple, previous.tuple) &&
    next.receiptId !== previous.receiptId && next.outboxEventId !== previous.outboxEventId &&
    next.rowDigestSha256 !== previous.rowDigestSha256 &&
    next.outboxEventDigestSha256 !== previous.outboxEventDigestSha256;
}

export function isOwnerRestartTransitionChain(
  value: unknown,
): value is readonly OwnerRestartTransitionReceipt[] {
  if (!Array.isArray(value) || value.length === 0) return false;

  const receiptIds = new Set<string>();
  const rowDigests = new Set<string>();
  const outboxEventIds = new Set<string>();
  const outboxEventDigests = new Set<string>();
  let previous: OwnerRestartTransitionReceipt | null = null;

  for (const candidate of value) {
    if (!isOwnerRestartTransitionReceipt(candidate) ||
      (previous === null
        ? candidate.fromState !== null || candidate.sequence !== 1
        : !ownerRestartTransitionFollows(previous, candidate)) ||
      receiptIds.has(candidate.receiptId) || rowDigests.has(candidate.rowDigestSha256) ||
      outboxEventIds.has(candidate.outboxEventId) ||
      outboxEventDigests.has(candidate.outboxEventDigestSha256)) {
      return false;
    }
    receiptIds.add(candidate.receiptId);
    rowDigests.add(candidate.rowDigestSha256);
    outboxEventIds.add(candidate.outboxEventId);
    outboxEventDigests.add(candidate.outboxEventDigestSha256);
    previous = candidate;
  }
  return true;
}

export function isSuccessorAdmittedAck(value: unknown): value is SuccessorAdmittedAck {
  return hasExactOwnKeys(value, [
    'ackId',
    'containedProcessId',
    'admissionReceiptId',
    'committedTransitionReceiptId',
    'tuple',
    'ownerGeneration',
  ]) && isOpaqueId(value.ackId) && isOpaqueId(value.containedProcessId) &&
    isOpaqueId(value.admissionReceiptId) && isOpaqueId(value.committedTransitionReceiptId) &&
    isOwnerRestartTuple(value.tuple) && isNonNegativeSafeInteger(value.ownerGeneration) &&
    value.ownerGeneration === value.tuple.newGeneration;
}

export function successorAdmittedAckMatchesCommittedTransition(
  acknowledgment: unknown,
  transitionChain: unknown,
  startedResult: unknown,
): boolean {
  if (!isSuccessorAdmittedAck(acknowledgment) ||
    !isOwnerRestartTransitionChain(transitionChain) ||
    !isContainedProcessStartResult(startedResult) || startedResult.status !== 'started') {
    return false;
  }
  const committedTransition = transitionChain.at(-1)!;
  return committedTransition.toState === 'committed' &&
    acknowledgment.committedTransitionReceiptId === committedTransition.receiptId &&
    ownerRestartTuplesEqual(acknowledgment.tuple, committedTransition.tuple) &&
    acknowledgment.containedProcessId === startedResult.containedProcessId &&
    acknowledgment.admissionReceiptId === startedResult.nativeReceipt.receiptId &&
    acknowledgment.ownerGeneration === startedResult.nativeReceipt.ownerGeneration;
}
