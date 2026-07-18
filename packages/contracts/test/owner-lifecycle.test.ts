import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  CLEANUP_UNCERTAINTY_CODES,
  CONTAINED_PROCESS_TERMINATION_MODES,
  CONTAINED_PROCESS_UNAVAILABLE_CODES,
  CONTAINED_PROCESS_UNSUPPORTED_CODES,
  CX004_PROCESS_INPUT_LIMITS,
  CONTAINED_JOB_TEMPLATES,
  OWNER_RESTART_STATES,
  PLATFORM_ADMISSION_UNAVAILABLE_CODES,
  PLATFORM_ADMISSION_UNSUPPORTED_CODES,
  PROCESS_CREATION_POISON_CAUSES,
  containedProcessCleanupReceiptMatchesStartedResult,
  containedProcessStartResultMatchesRequest,
  isContainedJobTemplate,
  isContainedProcessCleanupReceipt,
  isContainedProcessPrincipal,
  isContainedProcessStartRequest,
  isContainedProcessStartResult,
  isOwnerRestartState,
  isOwnerRestartTransitionChain,
  isOwnerRestartTransitionAllowed,
  isOwnerRestartTransitionReceipt,
  isOwnerRestartTuple,
  isPlatformAdmission,
  isProcessCreationState,
  isProcessCreationStateTransitionAllowed,
  isSuccessorAdmittedAck,
  ownerRestartTransitionFollows,
  successorAdmittedAckMatchesCommittedTransition,
} from '../src/index.ts';

const SHA_A = 'a'.repeat(64);
const SHA_B = 'b'.repeat(64);
const SHA_C = 'c'.repeat(64);

const admittedPlatform = {
  status: 'admitted',
  platform: 'win32',
  architecture: 'x64',
  scope: 'fake-lab-only',
  admissionId: 'admission-1',
  qualificationReceiptSha256: SHA_A,
  nativeBuildInputSha256: SHA_B,
} as const;

const restrictedPrincipal = {
  kind: 'restricted-principal',
  receiptId: 'principal-receipt-1',
  receiptSha256: SHA_C,
} as const;

const startRequest = {
  requestId: 'request-1',
  admissionId: admittedPlatform.admissionId,
  jobTemplate: 'cx004-leaf',
  principal: restrictedPrincipal,
  executable: {
    logicalId: 'fake-runner',
    canonicalPathCandidate: 'C:\\sealed\\fake-runner.exe',
    sha256: SHA_A,
  },
  argv: ['C:\\sealed\\fake-runner.exe', '--mode', 'conformance'],
  cwd: 'C:\\sealed\\work',
  environment: [
    { name: 'LANG', value: 'en_US.UTF-8' },
    { name: 'PC_SDK_FAKE', value: '1' },
  ],
} as const;

const startedResult = {
  status: 'started',
  requestId: startRequest.requestId,
  admissionId: startRequest.admissionId,
  containedProcessId: 'contained-process-1',
  nativeReceipt: {
    receiptId: 'native-receipt-1',
    receiptSha256: SHA_B,
    requestId: startRequest.requestId,
    admissionId: startRequest.admissionId,
    containedProcessId: 'contained-process-1',
    jobTemplate: startRequest.jobTemplate,
    executableSha256: startRequest.executable.sha256,
    ownerGeneration: 8,
    requestBinding: {
      principal: startRequest.principal,
      executable: startRequest.executable,
      argv: startRequest.argv,
      cwd: startRequest.cwd,
      environment: startRequest.environment,
    },
  },
} as const;

function withField(value: object, key: string, replacement: unknown): Record<string, unknown> {
  return { ...value, [key]: replacement };
}

test('CX-004 admission is fail-closed and exact-shape guarded', () => {
  assert.equal(isPlatformAdmission(admittedPlatform), true);
  assert.equal(isPlatformAdmission(Object.assign(Object.create(null), admittedPlatform)), true);
  assert.equal(isPlatformAdmission(Object.create(admittedPlatform)), false,
    'inherited fields never satisfy authority');
  assert.equal(isPlatformAdmission({ ...admittedPlatform, [Symbol('native')]: true }), false,
    'symbol-keyed native authority is still an extra own field');
  for (const code of [
    'platform-unsupported',
    'architecture-unsupported',
    'qualification-identity-mismatch',
    'production-admission-forbidden',
  ] as const) {
    assert.equal(isPlatformAdmission({ status: 'unsupported', code }), true, code);
  }
  for (const code of [
    'platform-observation-unavailable',
    'qualification-unavailable',
    'native-build-input-unavailable',
  ] as const) {
    assert.equal(isPlatformAdmission({ status: 'unavailable', code }), true, code);
  }

  for (const bad of [
    null,
    [],
    { ...admittedPlatform, status: 'available' },
    { ...admittedPlatform, platform: 'linux' },
    { ...admittedPlatform, architecture: 'arm64' },
    { ...admittedPlatform, scope: 'production' },
    { ...admittedPlatform, admissionId: '' },
    { ...admittedPlatform, admissionId: ' admission-1 ' },
    { ...admittedPlatform, qualificationReceiptSha256: SHA_A.toUpperCase() },
    { ...admittedPlatform, qualificationReceiptSha256: SHA_A.slice(1) },
    { ...admittedPlatform, nativeBuildInputSha256: `${SHA_B}0` },
    { ...admittedPlatform, productionAdmission: true },
    { status: 'unsupported', code: '' },
    { status: 'unsupported', code: 'unknown-code' },
    { status: 'unsupported', code: ' platform-unsupported ' },
    { status: 'unsupported', code: 'qualification-unavailable' },
    { status: 'unsupported', code: 'platform-unsupported', admissionId: 'smuggled' },
    { status: 'unavailable', code: 'platform-unsupported' },
    { status: 'unavailable', code: 'unknown-code' },
    { status: 'unavailable', code: 'qualification-unavailable', receipt: SHA_A },
  ]) {
    assert.equal(isPlatformAdmission(bad), false);
  }
});

test('job templates and principals are a closed public vocabulary', () => {
  assert.deepEqual(CONTAINED_JOB_TEMPLATES, ['cx004-leaf', 'cx004-session']);
  for (const template of CONTAINED_JOB_TEMPLATES) {
    assert.equal(isContainedJobTemplate(template), true);
  }
  for (const value of ['', 'cx004-action', 'CX004-leaf', ' cx004-leaf ', null, 0]) {
    assert.equal(isContainedJobTemplate(value), false);
  }

  assert.equal(isContainedProcessPrincipal({ kind: 'same-token' }), true);
  assert.equal(isContainedProcessPrincipal(restrictedPrincipal), true);
  for (const bad of [
    { kind: 'same-token', receiptId: 'not-allowed' },
    { ...restrictedPrincipal, receiptId: '' },
    { ...restrictedPrincipal, receiptId: ' principal-receipt-1 ' },
    { ...restrictedPrincipal, receiptSha256: SHA_C.toUpperCase() },
    { ...restrictedPrincipal, receiptSha256: SHA_C.slice(1) },
    { ...restrictedPrincipal, tokenHandle: 42 },
    { kind: 'restricted-token', receiptId: 'principal-receipt-1', receiptSha256: SHA_C },
    { kind: 'same-token', processId: 42 },
  ]) {
    assert.equal(isContainedProcessPrincipal(bad), false);
  }
});

test('every exported CX-004 limit and closed vocabulary is runtime-sealed', () => {
  assert.equal(Object.isFrozen(CX004_PROCESS_INPUT_LIMITS), true);
  assert.throws(() => {
    (CX004_PROCESS_INPUT_LIMITS as unknown as Record<string, number>)
      .argumentCountIncludingArgv0 = 2_048;
  }, TypeError);

  for (const vocabulary of [
    PLATFORM_ADMISSION_UNSUPPORTED_CODES,
    PLATFORM_ADMISSION_UNAVAILABLE_CODES,
    CONTAINED_JOB_TEMPLATES,
    CONTAINED_PROCESS_UNSUPPORTED_CODES,
    CONTAINED_PROCESS_UNAVAILABLE_CODES,
    PROCESS_CREATION_POISON_CAUSES,
    CONTAINED_PROCESS_TERMINATION_MODES,
    CLEANUP_UNCERTAINTY_CODES,
    OWNER_RESTART_STATES,
  ]) {
    assert.equal(Object.isFrozen(vocabulary), true);
    assert.throws(() => {
      (vocabulary as unknown as string[]).push('__mutation__');
    }, TypeError);
  }

  assert.equal(isContainedJobTemplate('__mutation__'), false);
  assert.equal(isPlatformAdmission({ status: 'unsupported', code: '__mutation__' }), false);
  assert.equal(isContainedProcessStartResult({
    status: 'unavailable',
    requestId: 'request-1',
    admissionId: 'admission-1',
    code: '__mutation__',
  }), false);
  assert.equal(isOwnerRestartState('__mutation__'), false);
});

test('process input limits are sealed and start requests accept only logical bounded inputs', () => {
  assert.deepEqual(CX004_PROCESS_INPUT_LIMITS, {
    applicationPathUtf16UnitsIncludingTerminator: 32_765,
    cwdUtf16UnitsIncludingTerminator: 32_767,
    argumentCountIncludingArgv0: 1_024,
    logicalArgumentUtf16ContentUnits: 8_192,
    commandLineUtf16UnitsIncludingTerminator: 32_767,
    environmentEntries: 256,
    environmentNameUtf16ContentUnits: 256,
    environmentValueUtf16ContentUnits: 8_192,
    environmentBlockUtf16UnitsIncludingDoubleNul: 65_536,
  });
  assert.equal(isContainedProcessStartRequest(startRequest), true);
  assert.equal(isContainedProcessStartRequest({
    ...startRequest,
    jobTemplate: 'cx004-session',
    principal: { kind: 'same-token' },
    argv: [
      startRequest.executable.canonicalPathCandidate,
      'argument with spaces',
      'embedded"quote',
      'trailing\\',
    ],
    environment: [],
  }), true, 'logical argv remains structured across Windows quoting characters');
  assert.equal(isContainedProcessStartRequest({
    ...startRequest,
    argv: [startRequest.executable.canonicalPathCandidate, ''],
    environment: [{ name: 'EMPTY_VALUE', value: '' }],
  }), true, 'empty logical arguments and environment values are explicit zero-bound inputs');

  const nativeSmugglingFields = [
    'commandLine',
    'rawCommandLine',
    'creationFlags',
    'jobFlags',
    'limitFlags',
    'jobHandle',
    'processHandle',
    'threadHandle',
    'tokenHandle',
    'processId',
    'pid',
    'inheritHandles',
  ];
  for (const field of nativeSmugglingFields) {
    assert.equal(isContainedProcessStartRequest(withField(startRequest, field, 1)), false, field);
  }

  for (const bad of [
    { ...startRequest, requestId: '' },
    { ...startRequest, requestId: ' request-1 ' },
    { ...startRequest, admissionId: '' },
    { ...startRequest, jobTemplate: 'cx004-action' },
    { ...startRequest, executable: { ...startRequest.executable, logicalId: '' } },
    { ...startRequest, executable: { ...startRequest.executable, logicalId: ' fake-runner ' } },
    { ...startRequest, executable: { ...startRequest.executable, canonicalPathCandidate: '' }, argv: [''] },
    { ...startRequest, executable: { ...startRequest.executable, canonicalPathCandidate: 'C:\\bad\0app.exe' }, argv: ['C:\\bad\0app.exe'] },
    { ...startRequest, executable: { ...startRequest.executable, canonicalPathCandidate: '\uD800' }, argv: ['\uD800'] },
    { ...startRequest, executable: { ...startRequest.executable, sha256: SHA_A.toUpperCase() } },
    { ...startRequest, executable: { ...startRequest.executable, path: startRequest.executable.canonicalPathCandidate } },
    { ...startRequest, argv: [] },
    { ...startRequest, argv: ['C:\\sealed\\different.exe'] },
    { ...startRequest, argv: [startRequest.executable.canonicalPathCandidate, 7] },
    { ...startRequest, argv: [startRequest.executable.canonicalPathCandidate, 'bad\0argument'] },
    { ...startRequest, argv: [startRequest.executable.canonicalPathCandidate, '\uD800'] },
    { ...startRequest, cwd: '' },
    { ...startRequest, cwd: 'C:\\bad\0cwd' },
    { ...startRequest, cwd: '\uDC00' },
    { ...startRequest, environment: [{ name: '', value: 'x' }] },
    { ...startRequest, environment: [{ name: ' SAFE ', value: 'x' }] },
    { ...startRequest, environment: [{ name: '=C:', value: 'x' }] },
    { ...startRequest, environment: [{ name: 'BAD=NAME', value: 'x' }] },
    { ...startRequest, environment: [{ name: 'BAD\0NAME', value: 'x' }] },
    { ...startRequest, environment: [{ name: 'BAD', value: 'x\0y' }] },
    { ...startRequest, environment: [{ name: '\uD800', value: 'x' }] },
    { ...startRequest, environment: [{ name: 'SAFE', value: '\uDC00' }] },
    { ...startRequest, environment: [{ name: 'Path', value: 'one' }, { name: 'PATH', value: 'two' }] },
    { ...startRequest, environment: [{ name: 'SAFE', value: 'x', raw: 'smuggled' }] },
  ]) {
    assert.equal(isContainedProcessStartRequest(bad), false);
  }
});

test('request caps reject cap-plus-one without normalizing UTF-16 or reconstructing native fields', () => {
  const pathAtLimit = `C:\\${'p'.repeat(
    CX004_PROCESS_INPUT_LIMITS.applicationPathUtf16UnitsIncludingTerminator - 4,
  )}`;
  assert.equal(pathAtLimit.length + 1,
    CX004_PROCESS_INPUT_LIMITS.applicationPathUtf16UnitsIncludingTerminator);
  assert.equal(isContainedProcessStartRequest({
    ...startRequest,
    executable: { ...startRequest.executable, canonicalPathCandidate: pathAtLimit },
    argv: [pathAtLimit],
  }), true);
  const pathTooLong = `${pathAtLimit}p`;
  assert.equal(isContainedProcessStartRequest({
    ...startRequest,
    executable: { ...startRequest.executable, canonicalPathCandidate: pathTooLong },
    argv: [pathTooLong],
  }), false);
  const cwdAtLimit = 'w'.repeat(
    CX004_PROCESS_INPUT_LIMITS.cwdUtf16UnitsIncludingTerminator - 1,
  );
  assert.equal(isContainedProcessStartRequest({ ...startRequest, cwd: cwdAtLimit }), true);
  assert.equal(isContainedProcessStartRequest({
    ...startRequest,
    cwd: `${cwdAtLimit}w`,
  }), false);
  const argumentsAtLimit = [
    startRequest.executable.canonicalPathCandidate,
    ...Array.from(
      { length: CX004_PROCESS_INPUT_LIMITS.argumentCountIncludingArgv0 - 1 },
      () => 'x',
    ),
  ];
  assert.equal(isContainedProcessStartRequest({ ...startRequest, argv: argumentsAtLimit }), true);
  assert.equal(isContainedProcessStartRequest({
    ...startRequest,
    argv: [...argumentsAtLimit, 'x'],
  }), false);
  const logicalArgumentAtLimit = 'x'.repeat(
    CX004_PROCESS_INPUT_LIMITS.logicalArgumentUtf16ContentUnits,
  );
  assert.equal(isContainedProcessStartRequest({
    ...startRequest,
    argv: [startRequest.executable.canonicalPathCandidate, logicalArgumentAtLimit],
  }), true);
  assert.equal(isContainedProcessStartRequest({
    ...startRequest,
    argv: [
      startRequest.executable.canonicalPathCandidate,
      `${logicalArgumentAtLimit}x`,
    ],
  }), false);

  const aggregatePrefixArguments = Array.from({ length: 4 }, () => 'x'.repeat(7_000));
  const aggregateFinalLength =
    CX004_PROCESS_INPUT_LIMITS.commandLineUtf16UnitsIncludingTerminator - 1 -
    startRequest.executable.canonicalPathCandidate.length -
    aggregatePrefixArguments.reduce((total, argument) => total + argument.length, 0) -
    aggregatePrefixArguments.length - 1 - 2;
  const commandLineAtLimit = [
    startRequest.executable.canonicalPathCandidate,
    ...aggregatePrefixArguments,
    'x'.repeat(aggregateFinalLength),
  ];
  assert.equal(commandLineAtLimit.join(' ').length + 3,
    CX004_PROCESS_INPUT_LIMITS.commandLineUtf16UnitsIncludingTerminator);
  assert.equal(isContainedProcessStartRequest({
    ...startRequest,
    argv: commandLineAtLimit,
  }), true);
  assert.equal(isContainedProcessStartRequest({
    ...startRequest,
    argv: [...commandLineAtLimit.slice(0, -1), `${commandLineAtLimit.at(-1)}x`],
  }), false, 'command-line cap is independent of the per-argument cap');

  const quotedPrefixArguments = Array.from({ length: 4 }, () => 'x'.repeat(6_200));
  const quotedFinalEncodedLength =
    CX004_PROCESS_INPUT_LIMITS.commandLineUtf16UnitsIncludingTerminator - 1 -
    (startRequest.executable.canonicalPathCandidate.length + 2) -
    quotedPrefixArguments.reduce((total, argument) => total + argument.length, 0) -
    (quotedPrefixArguments.length + 1);
  const quotedFinalAtLimit = `${'q'.repeat(quotedFinalEncodedLength - 5)} \\`;
  assert.equal(quotedFinalAtLimit.length <=
    CX004_PROCESS_INPUT_LIMITS.logicalArgumentUtf16ContentUnits, true);
  const quotedCommandLineAtLimit = [
    startRequest.executable.canonicalPathCandidate,
    ...quotedPrefixArguments,
    quotedFinalAtLimit,
  ];
  assert.equal(isContainedProcessStartRequest({
    ...startRequest,
    argv: quotedCommandLineAtLimit,
  }), true, 'quote and trailing-backslash expansion is admitted at the aggregate cap');
  assert.equal(isContainedProcessStartRequest({
    ...startRequest,
    argv: [
      ...quotedCommandLineAtLimit.slice(0, -1),
      `q${quotedCommandLineAtLimit.at(-1)}`,
    ],
  }), false, 'quote and trailing-backslash expansion rejects exact cap plus one');

  const environmentAtCountLimit = Array.from(
    { length: CX004_PROCESS_INPUT_LIMITS.environmentEntries },
    (_, index) => ({ name: `V${index.toString().padStart(3, '0')}`, value: 'x' }),
  );
  assert.equal(isContainedProcessStartRequest({
    ...startRequest,
    environment: environmentAtCountLimit,
  }), true);
  assert.equal(isContainedProcessStartRequest({
    ...startRequest,
    environment: [...environmentAtCountLimit, { name: 'OVER', value: 'x' }],
  }), false);
  const environmentNameAtLimit = 'N'.repeat(
    CX004_PROCESS_INPUT_LIMITS.environmentNameUtf16ContentUnits,
  );
  assert.equal(isContainedProcessStartRequest({
    ...startRequest,
    environment: [{ name: environmentNameAtLimit, value: 'x' }],
  }), true);
  assert.equal(isContainedProcessStartRequest({
    ...startRequest,
    environment: [{
      name: `${environmentNameAtLimit}N`,
      value: 'x',
    }],
  }), false);
  const environmentValueAtLimit = 'x'.repeat(
    CX004_PROCESS_INPUT_LIMITS.environmentValueUtf16ContentUnits,
  );
  assert.equal(isContainedProcessStartRequest({
    ...startRequest,
    environment: [{ name: 'SAFE', value: environmentValueAtLimit }],
  }), true);
  assert.equal(isContainedProcessStartRequest({
    ...startRequest,
    environment: [{
      name: 'SAFE',
      value: `${environmentValueAtLimit}x`,
    }],
  }), false);

  const environmentBlockAtLimit = Array.from({ length: 8 }, (_, index) => ({
    name: String.fromCharCode('A'.charCodeAt(0) + index),
    value: 'x'.repeat(index === 7 ? 8_167 : 8_192),
  }));
  const encodedEnvironmentUnits = 1 + environmentBlockAtLimit.reduce(
    (total, entry) => total + entry.name.length + 1 + entry.value.length + 1,
    0,
  );
  assert.equal(encodedEnvironmentUnits,
    CX004_PROCESS_INPUT_LIMITS.environmentBlockUtf16UnitsIncludingDoubleNul);
  assert.equal(isContainedProcessStartRequest({
    ...startRequest,
    environment: environmentBlockAtLimit,
  }), true);
  assert.equal(isContainedProcessStartRequest({
    ...startRequest,
    environment: [
      ...environmentBlockAtLimit.slice(0, -1),
      { ...environmentBlockAtLimit.at(-1)!, value: `${environmentBlockAtLimit.at(-1)!.value}x` },
    ],
  }), false, 'the encoded environment block has an exact independent aggregate bound');

  assert.equal(isContainedProcessStartRequest({
    ...startRequest,
    argv: [startRequest.executable.canonicalPathCandidate, '😀'],
    environment: [{ name: 'A_FIRST', value: '😀' }, { name: 'Z_LAST', value: '1' }],
  }), true, 'paired UTF-16 and canonical environment ordering remain representable');
  assert.equal(isContainedProcessStartRequest({
    ...startRequest,
    environment: [{ name: 'Z_LAST', value: '1' }, { name: 'A_FIRST', value: '2' }],
  }), false, 'environment ordering is canonical and cannot be arrival-dependent');
});

test('start results retain typed negative truth and positive request binding', () => {
  assert.equal(isContainedProcessStartResult(startedResult), true);
  assert.equal(containedProcessStartResultMatchesRequest(startedResult, startRequest), true);

  const unavailable = {
    status: 'unavailable',
    requestId: startRequest.requestId,
    admissionId: startRequest.admissionId,
    code: 'process-creation-unavailable',
  } as const;
  const unsupported = {
    status: 'unsupported',
    requestId: startRequest.requestId,
    admissionId: startRequest.admissionId,
    code: 'job-template-unsupported',
  } as const;
  for (const code of [
    'process-creation-unavailable',
    'principal-unavailable',
    'native-runtime-unavailable',
  ] as const) {
    assert.equal(isContainedProcessStartResult({ ...unavailable, code }), true, code);
  }
  for (const code of [
    'job-template-unsupported',
    'principal-unsupported',
    'executable-unsupported',
  ] as const) {
    assert.equal(isContainedProcessStartResult({ ...unsupported, code }), true, code);
  }
  assert.equal(containedProcessStartResultMatchesRequest(unavailable, startRequest), true);
  assert.equal(containedProcessStartResultMatchesRequest(unsupported, startRequest), true);

  for (const bad of [
    { ...startedResult, nativeReceipt: { ...startedResult.nativeReceipt, requestId: '' } },
    { ...startedResult, nativeReceipt: { ...startedResult.nativeReceipt, admissionId: '' } },
    { ...startedResult, nativeReceipt: { ...startedResult.nativeReceipt, jobTemplate: 'cx004-action' } },
    { ...startedResult, nativeReceipt: { ...startedResult.nativeReceipt, executableSha256: SHA_A.toUpperCase() } },
    { ...startedResult, nativeReceipt: { ...startedResult.nativeReceipt, containedProcessId: '' } },
    { ...startedResult, nativeReceipt: { ...startedResult.nativeReceipt, receiptId: ' native-receipt-1 ' } },
    { ...startedResult, nativeReceipt: { ...startedResult.nativeReceipt, receiptSha256: SHA_B.slice(1) } },
    { ...startedResult, nativeReceipt: { ...startedResult.nativeReceipt, ownerGeneration: -1 } },
    { ...startedResult, nativeReceipt: { ...startedResult.nativeReceipt, ownerGeneration: Number.MAX_SAFE_INTEGER + 1 } },
    { ...startedResult, nativeReceipt: { ...startedResult.nativeReceipt, processId: 1234 } },
    {
      ...startedResult,
      nativeReceipt: {
        ...startedResult.nativeReceipt,
        requestBinding: { ...startedResult.nativeReceipt.requestBinding, processHandle: 1234 },
      },
    },
    {
      ...startedResult,
      nativeReceipt: {
        ...startedResult.nativeReceipt,
        requestBinding: {
          ...startedResult.nativeReceipt.requestBinding,
          argv: ['C:\\sealed\\different.exe'],
        },
      },
    },
    { ...startedResult, requestId: 'different-request' },
    { ...startedResult, admissionId: 'different-admission' },
    { ...startedResult, containedProcessId: 'different-process' },
    { ...startedResult, jobTemplate: startRequest.jobTemplate },
    { ...startedResult, processId: 1234 },
    { ...startedResult, processHandle: 1234 },
    { ...unavailable, code: '' },
    { ...unavailable, code: 'unknown-code' },
    { ...unavailable, code: 'job-template-unsupported' },
    { ...unsupported, code: 'process-creation-unavailable' },
    { ...unsupported, code: 'unknown-code' },
    { ...unsupported, nativeReceipt: startedResult.nativeReceipt },
  ]) {
    assert.equal(isContainedProcessStartResult(bad), false);
  }

  const validRequestBindingSubstitutions = [
    {
      label: 'principal',
      requestBinding: {
        ...startedResult.nativeReceipt.requestBinding,
        principal: { kind: 'same-token' as const },
      },
    },
    {
      label: 'argv',
      requestBinding: {
        ...startedResult.nativeReceipt.requestBinding,
        argv: [startRequest.executable.canonicalPathCandidate, '--different'],
      },
    },
    {
      label: 'cwd',
      requestBinding: {
        ...startedResult.nativeReceipt.requestBinding,
        cwd: 'C:\\sealed\\different-work',
      },
    },
    {
      label: 'environment',
      requestBinding: {
        ...startedResult.nativeReceipt.requestBinding,
        environment: [
          { name: 'LANG', value: 'C' },
          { name: 'PC_SDK_FAKE', value: '2' },
        ],
      },
    },
    {
      label: 'logicalId',
      requestBinding: {
        ...startedResult.nativeReceipt.requestBinding,
        executable: {
          ...startedResult.nativeReceipt.requestBinding.executable,
          logicalId: 'different-fake-runner',
        },
      },
    },
    {
      label: 'canonicalPathCandidate',
      requestBinding: {
        ...startedResult.nativeReceipt.requestBinding,
        executable: {
          ...startedResult.nativeReceipt.requestBinding.executable,
          canonicalPathCandidate: 'C:\\sealed\\different-fake-runner.exe',
        },
        argv: ['C:\\sealed\\different-fake-runner.exe', '--mode', 'conformance'],
      },
    },
  ];
  for (const { label, requestBinding } of validRequestBindingSubstitutions) {
    const mismatch = {
      ...startedResult,
      nativeReceipt: { ...startedResult.nativeReceipt, requestBinding },
    };
    assert.equal(isContainedProcessStartResult(mismatch), true, label);
    assert.equal(containedProcessStartResultMatchesRequest(mismatch, startRequest), false, label);
  }

  for (const mismatch of [
    {
      ...startedResult,
      requestId: 'request-2',
      nativeReceipt: { ...startedResult.nativeReceipt, requestId: 'request-2' },
    },
    {
      ...startedResult,
      admissionId: 'admission-2',
      nativeReceipt: { ...startedResult.nativeReceipt, admissionId: 'admission-2' },
    },
    { ...startedResult, nativeReceipt: { ...startedResult.nativeReceipt, jobTemplate: 'cx004-session' } },
    {
      ...startedResult,
      nativeReceipt: {
        ...startedResult.nativeReceipt,
        executableSha256: SHA_B,
        requestBinding: {
          ...startedResult.nativeReceipt.requestBinding,
          executable: { ...startedResult.nativeReceipt.requestBinding.executable, sha256: SHA_B },
        },
      },
    },
  ]) {
    assert.equal(isContainedProcessStartResult(mismatch), true);
    assert.equal(containedProcessStartResultMatchesRequest(mismatch, startRequest), false);
  }
  assert.equal(containedProcessStartResultMatchesRequest(
    { ...unavailable, requestId: 'request-2' },
    startRequest,
  ), false);
  assert.equal(containedProcessStartResultMatchesRequest(
    { ...unsupported, admissionId: 'admission-2' },
    startRequest,
  ), false);
});

const availableCreationState = {
  status: 'available',
  ownerGeneration: 8,
} as const;

const poisonedCreationState = {
  status: 'poisoned',
  cause: 'cleanup-uncertain',
  ownerGeneration: 8,
  restartAllowed: false,
  nonRestartShutdownRequired: true,
} as const;

test('process creation poison is irreversible, explicit, and generation-bound', () => {
  assert.equal(isProcessCreationState(availableCreationState), true);
  assert.equal(isProcessCreationState({ status: 'available', ownerGeneration: 0 }), true);
  assert.equal(isProcessCreationState({
    status: 'available', ownerGeneration: Number.MAX_SAFE_INTEGER,
  }), true);
  const poisonCauses = [
    'resource-release-uncertain',
    'handle-state-uncertain',
    'resume-state-uncertain',
    'coordinator-publication-uncertain',
    'cleanup-uncertain',
  ] as const;
  for (const cause of poisonCauses) {
    assert.equal(isProcessCreationState({ ...poisonedCreationState, cause }), true, cause);
  }
  for (const bad of [
    { status: 'available', ownerGeneration: -1 },
    { status: 'available', ownerGeneration: 1.5 },
    { status: 'available', ownerGeneration: Number.MAX_SAFE_INTEGER + 1 },
    { ...availableCreationState, restartAllowed: true },
    { ...poisonedCreationState, cause: 'timeout' },
    { ...poisonedCreationState, ownerGeneration: -1 },
    { ...poisonedCreationState, ownerGeneration: Number.MAX_SAFE_INTEGER + 1 },
    { ...poisonedCreationState, restartAllowed: true },
    { ...poisonedCreationState, nonRestartShutdownRequired: false },
    { ...poisonedCreationState, recoverable: true },
  ]) {
    assert.equal(isProcessCreationState(bad), false);
  }
});

test('process creation state permits only the one-way same-generation poison edge', () => {
  assert.equal(isProcessCreationStateTransitionAllowed(
    availableCreationState,
    poisonedCreationState,
  ), true);
  for (const [previous, next, label] of [
    [availableCreationState, availableCreationState, 'available no-op'],
    [availableCreationState, { ...poisonedCreationState, ownerGeneration: 9 }, 'generation drift'],
    [poisonedCreationState, availableCreationState, 'recovery'],
    [poisonedCreationState, poisonedCreationState, 'poison no-op'],
    [poisonedCreationState, { ...poisonedCreationState, ownerGeneration: 9 }, 'poison drift'],
  ] as const) {
    assert.equal(isProcessCreationStateTransitionAllowed(previous, next), false, label);
  }
  assert.equal(isProcessCreationStateTransitionAllowed(null, poisonedCreationState), false);
  assert.equal(isProcessCreationStateTransitionAllowed(availableCreationState, null), false);
});

const cleanupReceipt = {
  receiptId: 'cleanup-receipt-1',
  containedProcessId: startedResult.nativeReceipt.containedProcessId,
  terminationMode: 'natural',
  cleanupProof: 'tree-exited',
  rootSignaled: true,
  expectedExitCode: 0,
  observedExitCode: 0,
  stdinSettled: true,
  stdoutEof: true,
  stderrEof: true,
  pendingIoCount: 0,
  pendingWorkerCount: 0,
  parentBaselinesRestored: true,
} as const;

const uncertainCleanupReceipt = {
  receiptId: 'cleanup-receipt-2',
  containedProcessId: startedResult.nativeReceipt.containedProcessId,
  terminationMode: 'job',
  cleanupProof: 'uncertain',
  uncertaintyCode: 'root-signal-unavailable',
  processCreationState: poisonedCreationState,
} as const;

test('cleanup mode is orthogonal to proof and positive cleanup needs every settled fact', () => {
  for (const terminationMode of ['natural', 'graceful', 'job'] as const) {
    assert.equal(isContainedProcessCleanupReceipt({ ...cleanupReceipt, terminationMode }), true);
  }
  assert.equal(isContainedProcessCleanupReceipt({
    ...cleanupReceipt,
    expectedExitCode: 0xffff_ffff,
    observedExitCode: 0xffff_ffff,
  }), true, 'the exact Win32 DWORD maximum is admitted');
  for (const bad of [
    { ...cleanupReceipt, receiptId: '' },
    { ...cleanupReceipt, receiptId: ' cleanup-receipt-1 ' },
    { ...cleanupReceipt, containedProcessId: '' },
    { ...cleanupReceipt, containedProcessId: ' contained-process-1 ' },
    { ...cleanupReceipt, terminationMode: 'kill' },
    { ...cleanupReceipt, rootSignaled: false },
    { ...cleanupReceipt, expectedExitCode: -1, observedExitCode: -1 },
    { ...cleanupReceipt, expectedExitCode: 1.5, observedExitCode: 1.5 },
    { ...cleanupReceipt, expectedExitCode: 0x1_0000_0000, observedExitCode: 0x1_0000_0000 },
    { ...cleanupReceipt, observedExitCode: 1 },
    { ...cleanupReceipt, stdinSettled: false },
    { ...cleanupReceipt, stdoutEof: false },
    { ...cleanupReceipt, stderrEof: false },
    { ...cleanupReceipt, pendingIoCount: 1 },
    { ...cleanupReceipt, pendingWorkerCount: 1 },
    { ...cleanupReceipt, parentBaselinesRestored: false },
    { ...cleanupReceipt, processCreationState: availableCreationState },
  ]) {
    assert.equal(isContainedProcessCleanupReceipt(bad), false);
  }
});

test('uncertain cleanup cannot smuggle positive facts and always carries matching poison', () => {
  const uncertainCodes = [
    'root-signal-unavailable',
    'exit-code-unavailable',
    'stream-settlement-uncertain',
    'native-io-pending',
    'worker-settlement-uncertain',
    'parent-baseline-uncertain',
    'termination-unavailable',
  ] as const;
  for (const terminationMode of ['natural', 'graceful', 'job'] as const) {
    for (const uncertaintyCode of uncertainCodes) {
      assert.equal(isContainedProcessCleanupReceipt({
        ...uncertainCleanupReceipt, terminationMode, uncertaintyCode,
      }), true, `${terminationMode}:${uncertaintyCode}`);
    }
  }
  for (const positiveField of [
    'rootSignaled',
    'expectedExitCode',
    'observedExitCode',
    'stdinSettled',
    'stdoutEof',
    'stderrEof',
    'pendingIoCount',
    'pendingWorkerCount',
    'parentBaselinesRestored',
  ]) {
    assert.equal(isContainedProcessCleanupReceipt(
      withField(uncertainCleanupReceipt, positiveField, true),
    ), false, positiveField);
  }
  for (const bad of [
    { ...uncertainCleanupReceipt, uncertaintyCode: 'timeout' },
    { ...uncertainCleanupReceipt, processCreationState: availableCreationState },
    {
      ...uncertainCleanupReceipt,
      processCreationState: { ...poisonedCreationState, restartAllowed: true },
    },
  ]) {
    assert.equal(isContainedProcessCleanupReceipt(bad), false);
  }
});

test('cleanup receipts bind to the exact started process and uncertain owner generation', () => {
  assert.equal(containedProcessCleanupReceiptMatchesStartedResult(
    cleanupReceipt,
    startedResult,
  ), true);
  assert.equal(containedProcessCleanupReceiptMatchesStartedResult(
    uncertainCleanupReceipt,
    startedResult,
  ), true);
  assert.equal(containedProcessCleanupReceiptMatchesStartedResult(
    { ...cleanupReceipt, containedProcessId: 'contained-process-other' },
    startedResult,
  ), false);
  assert.equal(containedProcessCleanupReceiptMatchesStartedResult(
    { ...uncertainCleanupReceipt, containedProcessId: 'contained-process-other' },
    startedResult,
  ), false);
  assert.equal(containedProcessCleanupReceiptMatchesStartedResult(
    {
      ...uncertainCleanupReceipt,
      processCreationState: { ...poisonedCreationState, ownerGeneration: 9 },
    },
    startedResult,
  ), false);
  assert.equal(containedProcessCleanupReceiptMatchesStartedResult(
    cleanupReceipt,
    { status: 'unavailable', requestId: 'request-1', admissionId: 'admission-1',
      code: 'process-creation-unavailable' },
  ), false);
});

const restartTuple = {
  nonce: 'restart-nonce-1',
  oldGeneration: 7,
  newGeneration: 8,
  digestSha256: SHA_A,
} as const;

test('restart tuple and every durable state branch are exact and bounded', () => {
  assert.equal(isOwnerRestartTuple(restartTuple), true);
  assert.equal(isOwnerRestartTuple({
    ...restartTuple, oldGeneration: 0, newGeneration: 1,
  }), true);
  assert.equal(isOwnerRestartTuple({
    ...restartTuple,
    oldGeneration: Number.MAX_SAFE_INTEGER - 1,
    newGeneration: Number.MAX_SAFE_INTEGER,
  }), true, 'the safe generation ceiling is representable');
  for (const bad of [
    { ...restartTuple, nonce: '' },
    { ...restartTuple, nonce: ' restart-nonce-1 ' },
    { ...restartTuple, oldGeneration: -1 },
    { ...restartTuple, oldGeneration: 1.5 },
    {
      ...restartTuple,
      oldGeneration: Number.MAX_SAFE_INTEGER,
      newGeneration: Number.MAX_SAFE_INTEGER + 1,
    },
    { ...restartTuple, newGeneration: restartTuple.oldGeneration },
    { ...restartTuple, newGeneration: restartTuple.newGeneration + 1 },
    { ...restartTuple, digestSha256: SHA_A.toUpperCase() },
    { ...restartTuple, digestSha256: SHA_A.slice(1) },
    { ...restartTuple, pid: 1234 },
  ]) {
    assert.equal(isOwnerRestartTuple(bad), false);
  }

  for (const state of [
    'prepared', 'committed', 'aborted', 'completed', 'interrupted', 'attention',
  ]) {
    assert.equal(isOwnerRestartState(state), true);
  }
  for (const bad of [null, '', 'absent', 'reconciled', 'prepared ', { state: 'prepared' }]) {
    assert.equal(isOwnerRestartState(bad), false);
  }
});

test('restart transition matrix permits only forward fail-closed edges', () => {
  const fromStates = [
    null, 'prepared', 'committed', 'aborted', 'completed', 'interrupted', 'attention',
  ] as const;
  const toStates = [
    'prepared', 'committed', 'aborted', 'completed', 'interrupted', 'attention',
  ] as const;
  const allowed = new Set([
    'null->prepared',
    'prepared->committed',
    'prepared->aborted',
    'prepared->interrupted',
    'prepared->attention',
    'committed->completed',
    'committed->interrupted',
    'committed->attention',
    'interrupted->attention',
  ]);
  for (const from of fromStates) {
    for (const to of toStates) {
      assert.equal(
        isOwnerRestartTransitionAllowed(from, to),
        allowed.has(`${String(from)}->${to}`),
        `${String(from)}->${to}`,
      );
    }
  }
  assert.equal(isOwnerRestartTransitionAllowed(undefined, 'prepared'), false);
  assert.equal(isOwnerRestartTransitionAllowed('prepared', 'unknown'), false);
});

const preparedTransitionReceipt = {
  receiptId: 'transition-receipt-1',
  tuple: restartTuple,
  fromState: null,
  toState: 'prepared',
  sequence: 1,
  rowDigestSha256: SHA_A,
  outboxEventId: 'restart-event-1',
  outboxEventDigestSha256: SHA_B,
} as const;

const committedTransitionReceipt = {
  receiptId: 'transition-receipt-2',
  tuple: restartTuple,
  fromState: 'prepared',
  toState: 'committed',
  sequence: 2,
  rowDigestSha256: SHA_B,
  outboxEventId: 'restart-event-2',
  outboxEventDigestSha256: SHA_C,
} as const;

const completedTransitionReceipt = {
  receiptId: 'transition-receipt-3',
  tuple: restartTuple,
  fromState: 'committed',
  toState: 'completed',
  sequence: 3,
  rowDigestSha256: SHA_C,
  outboxEventId: 'restart-event-3',
  outboxEventDigestSha256: SHA_A,
} as const;

test('every legal restart edge has an exact row-and-outbox transition receipt', () => {
  const legalEdgeReceipts = [
    preparedTransitionReceipt,
    committedTransitionReceipt,
    {
      ...committedTransitionReceipt,
      receiptId: 'transition-receipt-prepared-aborted',
      toState: 'aborted',
      outboxEventId: 'restart-event-prepared-aborted',
    },
    {
      ...committedTransitionReceipt,
      receiptId: 'transition-receipt-prepared-interrupted',
      toState: 'interrupted',
      outboxEventId: 'restart-event-prepared-interrupted',
    },
    {
      ...committedTransitionReceipt,
      receiptId: 'transition-receipt-prepared-attention',
      toState: 'attention',
      outboxEventId: 'restart-event-prepared-attention',
    },
    completedTransitionReceipt,
    {
      ...completedTransitionReceipt,
      receiptId: 'transition-receipt-committed-interrupted',
      toState: 'interrupted',
      outboxEventId: 'restart-event-committed-interrupted',
    },
    {
      ...completedTransitionReceipt,
      receiptId: 'transition-receipt-committed-attention',
      toState: 'attention',
      outboxEventId: 'restart-event-committed-attention',
    },
    {
      ...completedTransitionReceipt,
      receiptId: 'transition-receipt-interrupted-attention',
      fromState: 'interrupted',
      toState: 'attention',
      outboxEventId: 'restart-event-interrupted-attention',
    },
  ];
  for (const receipt of legalEdgeReceipts) {
    assert.equal(isOwnerRestartTransitionReceipt(receipt), true);
  }

  const preparedSuccessors = legalEdgeReceipts.filter(
    (receipt) => receipt.fromState === 'prepared',
  );
  for (const successor of preparedSuccessors) {
    assert.equal(ownerRestartTransitionFollows(
      preparedTransitionReceipt,
      successor,
    ), true, `prepared->${successor.toState}`);
  }
  const committedSuccessors = legalEdgeReceipts.filter(
    (receipt) => receipt.fromState === 'committed',
  );
  for (const successor of committedSuccessors) {
    assert.equal(ownerRestartTransitionFollows(
      committedTransitionReceipt,
      successor,
    ), true, `committed->${successor.toState}`);
  }
  const interruptedReceipt = legalEdgeReceipts.find(
    (receipt) => receipt.fromState === 'prepared' && receipt.toState === 'interrupted',
  )!;
  const attentionAfterInterrupted = legalEdgeReceipts.find(
    (receipt) => receipt.fromState === 'interrupted',
  )!;
  assert.equal(ownerRestartTransitionFollows(
    interruptedReceipt,
    attentionAfterInterrupted,
  ), true);

  for (const bad of [
    { ...preparedTransitionReceipt, receiptId: '' },
    { ...preparedTransitionReceipt, rowDigestSha256: SHA_A.toUpperCase() },
    { ...preparedTransitionReceipt, outboxEventId: '' },
    { ...preparedTransitionReceipt, outboxEventDigestSha256: SHA_B.slice(1) },
    { ...preparedTransitionReceipt, sequence: 0 },
    { ...preparedTransitionReceipt, sequence: 1.5 },
    { ...preparedTransitionReceipt, sequence: Number.MAX_SAFE_INTEGER + 1 },
    { ...preparedTransitionReceipt, sequence: 2 },
    { ...committedTransitionReceipt, sequence: 1 },
    { ...committedTransitionReceipt, sequence: 99 },
    { ...committedTransitionReceipt, fromState: null },
    { ...committedTransitionReceipt, fromState: 'completed' },
    { ...committedTransitionReceipt, toState: 'prepared' },
    { ...committedTransitionReceipt, rowDigestSha256: undefined },
    { ...committedTransitionReceipt, outboxEventId: undefined },
    { ...committedTransitionReceipt, nativePid: 1234 },
  ]) {
    assert.equal(isOwnerRestartTransitionReceipt(bad), false);
  }
});

test('restart receipt chaining rejects sequence, state, identity, and tuple substitution', () => {
  assert.equal(ownerRestartTransitionFollows(
    preparedTransitionReceipt,
    committedTransitionReceipt,
  ), true);
  assert.equal(ownerRestartTransitionFollows(
    preparedTransitionReceipt,
    { ...committedTransitionReceipt, sequence: 3 },
  ), false);
  assert.equal(ownerRestartTransitionFollows(
    preparedTransitionReceipt,
    { ...committedTransitionReceipt, fromState: 'interrupted' },
  ), false);
  assert.equal(ownerRestartTransitionFollows(
    preparedTransitionReceipt,
    { ...committedTransitionReceipt, receiptId: preparedTransitionReceipt.receiptId },
  ), false);
  assert.equal(ownerRestartTransitionFollows(
    preparedTransitionReceipt,
    { ...committedTransitionReceipt, outboxEventId: preparedTransitionReceipt.outboxEventId },
  ), false);
  assert.equal(ownerRestartTransitionFollows(
    preparedTransitionReceipt,
    { ...committedTransitionReceipt, rowDigestSha256: preparedTransitionReceipt.rowDigestSha256 },
  ), false, 'adjacent rows cannot reuse a stale digest');
  assert.equal(ownerRestartTransitionFollows(
    preparedTransitionReceipt,
    {
      ...committedTransitionReceipt,
      outboxEventDigestSha256: preparedTransitionReceipt.outboxEventDigestSha256,
    },
  ), false, 'adjacent outbox events cannot reuse a stale digest');
  for (const substitutedTuple of [
    { ...restartTuple, nonce: 'restart-nonce-stale' },
    { ...restartTuple, digestSha256: SHA_C },
    { ...restartTuple, oldGeneration: 8, newGeneration: 9 },
  ]) {
    assert.equal(isOwnerRestartTuple(substitutedTuple), true);
    assert.equal(ownerRestartTransitionFollows(
      preparedTransitionReceipt,
      { ...committedTransitionReceipt, tuple: substitutedTuple },
    ), false);
  }
  assert.equal(ownerRestartTransitionFollows(
    committedTransitionReceipt,
    preparedTransitionReceipt,
  ), false, 'receipt order cannot be reversed');
  assert.equal(ownerRestartTransitionFollows(
    { ...committedTransitionReceipt, sequence: Number.MAX_SAFE_INTEGER },
    { ...completedTransitionReceipt, sequence: Number.MAX_SAFE_INTEGER },
  ), false, 'sequence overflow cannot follow');
});

test('restart transition chains reject non-adjacent durable identity reuse', () => {
  const normalChain = [
    preparedTransitionReceipt,
    committedTransitionReceipt,
    completedTransitionReceipt,
  ];
  assert.equal(isOwnerRestartTransitionChain(normalChain), true);
  assert.equal(isOwnerRestartTransitionChain([]), false);
  assert.equal(isOwnerRestartTransitionChain([committedTransitionReceipt]), false);
  for (const [field, reusedValue] of [
    ['receiptId', preparedTransitionReceipt.receiptId],
    ['rowDigestSha256', preparedTransitionReceipt.rowDigestSha256],
    ['outboxEventId', preparedTransitionReceipt.outboxEventId],
    ['outboxEventDigestSha256', preparedTransitionReceipt.outboxEventDigestSha256],
  ] as const) {
    assert.equal(isOwnerRestartTransitionChain([
      preparedTransitionReceipt,
      committedTransitionReceipt,
      { ...completedTransitionReceipt, [field]: reusedValue },
    ]), false, field);
  }
  assert.equal(isOwnerRestartTransitionChain([
    preparedTransitionReceipt,
    { ...committedTransitionReceipt, sequence: 99 },
  ]), false, 'locally impossible sequence cannot enter a chain');
});

const successorAck = {
  ackId: 'successor-ack-1',
  containedProcessId: startedResult.containedProcessId,
  admissionReceiptId: startedResult.nativeReceipt.receiptId,
  committedTransitionReceiptId: committedTransitionReceipt.receiptId,
  tuple: restartTuple,
  ownerGeneration: restartTuple.newGeneration,
} as const;

test('successor admission ack binds the exact committed transition and rejects stale/replay tuples', () => {
  const committedChain = [preparedTransitionReceipt, committedTransitionReceipt];
  assert.equal(isSuccessorAdmittedAck(successorAck), true);
  assert.equal(successorAdmittedAckMatchesCommittedTransition(
    successorAck,
    committedChain,
    startedResult,
  ), true);
  for (const bad of [
    { ...successorAck, ackId: '' },
    { ...successorAck, ackId: ' successor-ack-1 ' },
    { ...successorAck, containedProcessId: '' },
    { ...successorAck, admissionReceiptId: '' },
    { ...successorAck, committedTransitionReceiptId: '' },
    { ...successorAck, ownerGeneration: restartTuple.oldGeneration },
    { ...successorAck, ownerGeneration: Number.MAX_SAFE_INTEGER + 1 },
    { ...successorAck, pid: 1234 },
  ]) {
    assert.equal(isSuccessorAdmittedAck(bad), false);
  }

  for (const mismatch of [
    { ...successorAck, committedTransitionReceiptId: 'transition-receipt-stale' },
    { ...successorAck, tuple: { ...restartTuple, nonce: 'restart-nonce-stale' } },
    { ...successorAck, tuple: { ...restartTuple, digestSha256: SHA_C } },
    {
      ...successorAck,
      tuple: { ...restartTuple, oldGeneration: 8, newGeneration: 9 },
      ownerGeneration: 9,
    },
  ]) {
    assert.equal(isSuccessorAdmittedAck(mismatch), true);
    assert.equal(successorAdmittedAckMatchesCommittedTransition(
      mismatch,
      committedChain,
      startedResult,
    ), false);
  }
  for (const forgedAuthority of [
    { ...successorAck, containedProcessId: 'contained-process-stale' },
    { ...successorAck, admissionReceiptId: 'native-receipt-stale' },
  ]) {
    assert.equal(isSuccessorAdmittedAck(forgedAuthority), true);
    assert.equal(successorAdmittedAckMatchesCommittedTransition(
      forgedAuthority,
      committedChain,
      startedResult,
    ), false);
  }
  assert.equal(successorAdmittedAckMatchesCommittedTransition(
    successorAck,
    [preparedTransitionReceipt],
    startedResult,
  ), false, 'a prepared receipt cannot admit a successor');
  assert.equal(successorAdmittedAckMatchesCommittedTransition(
    successorAck,
    [preparedTransitionReceipt, committedTransitionReceipt, completedTransitionReceipt],
    startedResult,
  ), false, 'a later completed receipt is not the committed admission authority');
  assert.equal(successorAdmittedAckMatchesCommittedTransition(
    successorAck,
    [preparedTransitionReceipt, {
      ...committedTransitionReceipt,
      rowDigestSha256: 'not-a-sha',
    }],
    startedResult,
  ), false, 'a malformed otherwise-matching committed row cannot authorize admission');
  assert.equal(successorAdmittedAckMatchesCommittedTransition(
    successorAck,
    [preparedTransitionReceipt, { ...committedTransitionReceipt, sequence: 99 }],
    startedResult,
  ), false, 'a semantically invalid otherwise-matching transition cannot authorize admission');
  for (const staleStartedResult of [
    {
      ...startedResult,
      containedProcessId: 'contained-process-stale',
      nativeReceipt: {
        ...startedResult.nativeReceipt,
        containedProcessId: 'contained-process-stale',
      },
    },
    {
      ...startedResult,
      nativeReceipt: { ...startedResult.nativeReceipt, receiptId: 'native-receipt-stale' },
    },
    {
      ...startedResult,
      nativeReceipt: { ...startedResult.nativeReceipt, ownerGeneration: 9 },
    },
  ]) {
    assert.equal(isContainedProcessStartResult(staleStartedResult), true);
    assert.equal(successorAdmittedAckMatchesCommittedTransition(
      successorAck,
      committedChain,
      staleStartedResult,
    ), false);
  }
});
