import path from 'node:path';
import { pathToFileURL } from 'node:url';

import {
  canonicalJsonBytes,
  hashStableFile,
  sha256Bytes,
} from '../toolchain/manifest-set.mjs';
import {
  QUALIFICATION_MODE,
  buildQualificationArtifact,
  cleanupQualificationArtifact,
  runBoundedCommand,
} from '../build/build.mjs';

const GLOBAL_MATRIX_TIMEOUT_MS = 60_000;
const RESULT_BYTES_MAXIMUM = 4096;
const PASS_RESULT_PATTERN =
  /^\{"schemaVersion":1,"mode":"resource-ownership","artifact":"qualification","status":"passed","assertions":([1-9][0-9]{0,15}),"abaSiteId":"([a-z][a-z0-9_]*)","abaAttempts":([1-9][0-9]{0,5}),"siteIds":(\["[a-z][a-z0-9_]*"(?:,"[a-z][a-z0-9_]*")*\])\}\n$/u;
const INCONCLUSIVE_RESULT_PATTERN =
  /^\{"schemaVersion":1,"mode":"resource-ownership","status":"inconclusive","reason":"(aba-site-bound|aba-global-bound|site-unrun)","siteId":"([a-z][a-z0-9_]*)","attempts":(0|[1-9][0-9]{0,15})\}\n$/u;

function fail(code, message) {
  const error = new Error(`${code}: ${message}`);
  error.code = code;
  throw error;
}

function invariant(condition, code, message) {
  if (!condition) fail(code, message);
}

function progressToStderr(event) {
  const fields = [event.phase, event.status, event.surfaceId, event.source]
    .filter((value) => value !== undefined);
  process.stderr.write(`[cx004-t3] ${fields.join(' ')}\n`);
}

function remainingTimeout(deadline) {
  const remaining = Math.floor(deadline - performance.now());
  if (remaining <= 0) {
    fail(
      'MATRIX_GLOBAL_TIMEOUT_INCONCLUSIVE',
      `resource matrix exceeded the ${GLOBAL_MATRIX_TIMEOUT_MS}ms global bound`,
    );
  }
  return remaining;
}

function qualificationAuthority(build) {
  const embedded = build.receipt?.embeddedManifest;
  invariant(
    embedded?.status === 'verified'
      && embedded.artifactId === 'qualification'
      && Array.isArray(embedded.siteIds)
      && embedded.siteIds.length === embedded.siteCount
      && new Set(embedded.siteIds).size === embedded.siteIds.length
      && Array.isArray(embedded.abaCanaries)
      && embedded.abaCanaries.length > 0
      && new Set(embedded.abaCanaries.map((canary) => canary.siteId)).size
        === embedded.abaCanaries.length,
    'MATRIX_MANIFEST_AUTHORITY_INVALID',
    'linked PE receipt does not supply one closed qualification manifest authority',
  );
  invariant(
    embedded.abaCanaries.every((canary) => (
      embedded.siteIds.includes(canary.siteId)
      && typeof canary.kind === 'string'
      && canary.kind.length > 0
      && Number.isSafeInteger(canary.maxAttempts)
      && canary.maxAttempts > 0
      && Number.isSafeInteger(canary.maxMonotonicMilliseconds)
      && canary.maxMonotonicMilliseconds > 0
      && canary.noProofOutcome === 'inconclusive'
    )),
    'MATRIX_ABA_AUTHORITY_INVALID',
    'linked PE receipt contains an invalid bounded canary authority',
  );
  const exactNumericCanaries = embedded.abaCanaries.filter(
    (canary) => canary.kind === 'exact-numeric-same-domain',
  );
  invariant(
    exactNumericCanaries.length === 1,
    'MATRIX_ABA_AUTHORITY_INVALID',
    'linked PE receipt must identify exactly one numeric ABA pass canary',
  );
  return {
    abaCanary: exactNumericCanaries[0],
    artifactId: embedded.artifactId,
    boundedCanaries: embedded.abaCanaries.map((canary) => ({ ...canary })),
    siteIds: [...embedded.siteIds],
  };
}

function arraysEqual(left, right) {
  return left.length === right.length
    && left.every((entry, index) => entry === right[index]);
}

function validatePositiveResult(result, authority) {
  invariant(
    result.signal === null && (result.exitCode === 0 || result.exitCode === 3),
    'MATRIX_POSITIVE_EXIT_INVALID',
    'resource matrix execution did not return a pass or typed inconclusive exit',
  );
  invariant(
    result.stderr.length === 0,
    'MATRIX_POSITIVE_STDERR_NOT_EMPTY',
    'positive resource matrix execution wrote stderr',
  );
  invariant(
    result.stdout.length > 0 && result.stdout.length <= RESULT_BYTES_MAXIMUM,
    'MATRIX_RESULT_BOUNDS_INVALID',
    'positive resource matrix result is outside its byte bound',
  );
  const text = result.stdout.toString('utf8');
  invariant(
    Buffer.from(text, 'utf8').equals(result.stdout),
    'MATRIX_RESULT_ENCODING_INVALID',
    'positive resource matrix result is not exact UTF-8',
  );
  if (result.exitCode === 3) {
    const inconclusiveMatch = INCONCLUSIVE_RESULT_PATTERN.exec(text);
    invariant(
      inconclusiveMatch !== null,
      'MATRIX_INCONCLUSIVE_SCHEMA_INVALID',
      'resource matrix inconclusive result does not have its exact bounded schema',
    );
    const [, reason, siteId, attemptsText] = inconclusiveMatch;
    const attempts = Number(attemptsText);
    const boundedCanary = authority.boundedCanaries.find(
      (canary) => canary.siteId === siteId,
    );
    invariant(
      Number.isSafeInteger(attempts)
        && attempts >= 0
        && authority.siteIds.includes(siteId)
        && (reason !== 'site-unrun' || attempts === 0)
        && (
          !['aba-site-bound', 'aba-global-bound'].includes(reason)
          || (
            boundedCanary !== undefined
            && attempts <= boundedCanary.maxAttempts
          )
        ),
      'MATRIX_INCONCLUSIVE_VALUE_INVALID',
      'resource matrix inconclusive values exceed their sealed bounds',
    );
    const parsed = JSON.parse(text.slice(0, -1));
    invariant(
      parsed.schemaVersion === 1
        && parsed.mode === QUALIFICATION_MODE
        && parsed.status === 'inconclusive'
        && parsed.reason === reason
        && parsed.siteId === siteId
        && parsed.attempts === attempts
        && Object.keys(parsed).length === 6,
      'MATRIX_INCONCLUSIVE_VALUE_INVALID',
      'resource matrix inconclusive values differ from the exact schema',
    );
    return {
      attempts,
      byteLength: result.stdout.length,
      kind: 'inconclusive',
      reason,
      sha256: sha256Bytes(result.stdout),
      siteId,
    };
  }
  const match = PASS_RESULT_PATTERN.exec(text);
  invariant(
    match !== null,
    'MATRIX_RESULT_SCHEMA_INVALID',
    'positive resource matrix result does not have its exact bounded schema',
  );
  const [, assertionsText, abaSiteId, abaAttemptsText, siteIdsText] = match;
  const assertions = Number(assertionsText);
  const abaAttempts = Number(abaAttemptsText);
  const siteIds = JSON.parse(siteIdsText);
  invariant(
    Number.isSafeInteger(assertions)
      && assertions > 0
      && Number.isSafeInteger(abaAttempts)
      && abaAttempts > 0
      && abaAttempts <= authority.abaCanary.maxAttempts
      && abaSiteId === authority.abaCanary.siteId
      && arraysEqual(siteIds, authority.siteIds),
    'MATRIX_ASSERTION_COUNT_INVALID',
    'positive resource matrix assertion count is not a positive safe integer',
  );
  let parsed;
  try {
    parsed = JSON.parse(text.slice(0, -1));
  } catch {
    fail('MATRIX_RESULT_JSON_INVALID', 'positive resource matrix result is not JSON');
  }
  invariant(
    parsed.schemaVersion === 1
      && parsed.mode === QUALIFICATION_MODE
      && parsed.artifact === authority.artifactId
      && parsed.status === 'passed'
      && parsed.assertions === assertions
      && parsed.abaSiteId === abaSiteId
      && parsed.abaAttempts === abaAttempts
      && arraysEqual(parsed.siteIds, authority.siteIds)
      && arraysEqual(Object.keys(parsed), [
        'schemaVersion',
        'mode',
        'artifact',
        'status',
        'assertions',
        'abaSiteId',
        'abaAttempts',
        'siteIds',
      ]),
    'MATRIX_RESULT_VALUE_INVALID',
    'positive resource matrix result values differ from the selected mode',
  );
  return {
    abaAttempts,
    abaSiteId,
    assertions,
    artifact: authority.artifactId,
    bytes: result.stdout.length,
    kind: 'passed',
    sha256: sha256Bytes(result.stdout),
    siteIds,
  };
}

function identitiesEqual(left, right) {
  return left !== null
    && typeof left === 'object'
    && right !== null
    && typeof right === 'object'
    && left.device === right.device
    && left.fileId === right.fileId
    && left.linkCount === right.linkCount;
}

async function verifyExecutableBinding(build, label) {
  const artifact = build.receipt?.artifact;
  invariant(
    artifact?.kind === 'console-qualification-executable'
      && Number.isSafeInteger(artifact.byteLength)
      && artifact.byteLength > 0
      && typeof artifact.sha256 === 'string'
      && /^[0-9a-f]{64}$/u.test(artifact.sha256)
      && artifact.identity !== null
      && typeof artifact.identity === 'object',
    'MATRIX_EXECUTABLE_AUTHORITY_INVALID',
    'build receipt does not bind the executable byte and file identity',
  );
  const digest = await hashStableFile(build.executablePath, label);
  invariant(
    digest.byteLength === artifact.byteLength
      && digest.sha256 === artifact.sha256
      && identitiesEqual(digest.identity, artifact.identity),
    'MATRIX_EXECUTABLE_BINDING_CHANGED',
    `${label} no longer equals the linked and inspected qualification PE`,
  );
  return digest;
}

async function runWithExecutableBinding(build, label, operation) {
  await verifyExecutableBinding(build, `${label} before execution`);
  let result;
  try {
    result = await operation();
  } catch (error) {
    try {
      await verifyExecutableBinding(build, `${label} after failed execution`);
    } catch (bindingError) {
      bindingError.cause = error;
      if (error?.preserveBuildRoot === true) {
        bindingError.preserveBuildRoot = true;
        if (typeof error.strandedBuildRoot === 'string') {
          bindingError.strandedBuildRoot = error.strandedBuildRoot;
        }
      }
      throw bindingError;
    }
    throw error;
  }
  await verifyExecutableBinding(build, `${label} after execution`);
  return result;
}

async function runPositive(build, authority, deadline, label) {
  const result = await runWithExecutableBinding(build, label, () => runBoundedCommand({
    acceptExit: (exitCode, signal) => signal === null && Number.isInteger(exitCode),
    args: ['--mode', QUALIFICATION_MODE],
    cwd: build.buildRoot,
    env: build.environment,
    label,
    maxOutputBytes: RESULT_BYTES_MAXIMUM,
    terminationTool: build.terminationTool,
    timeoutMs: remainingTimeout(deadline),
    tool: build.executablePath,
  }));
  return { result, validated: validatePositiveResult(result, authority) };
}

async function runNegative(build, deadline) {
  const label = 'reject unsealed qualification mode';
  const result = await runWithExecutableBinding(build, label, () => runBoundedCommand({
    acceptExit: (exitCode, signal) => signal === null && Number.isInteger(exitCode) && exitCode !== 0,
    args: ['--mode', 'unsealed-mode'],
    cwd: build.buildRoot,
    env: build.environment,
    label,
    maxOutputBytes: RESULT_BYTES_MAXIMUM,
    terminationTool: build.terminationTool,
    timeoutMs: remainingTimeout(deadline),
    tool: build.executablePath,
  }));
  invariant(
    result.exitCode === 2
      && result.signal === null
      && result.stdout.length === 0
      && result.stderr.length === 0,
    'MATRIX_NEGATIVE_RESULT_INVALID',
    'unknown-mode rejection must be silent stdout/stderr with exact exit 2',
  );
  return { exitCode: result.exitCode, stderrEmpty: true, stdoutEmpty: true };
}

export async function runFakeMatrix({ onProgress = progressToStderr } = {}) {
  let build;
  let preserveBuildRoot = false;
  let authority;
  try {
    build = await buildQualificationArtifact({ onProgress });
    authority = qualificationAuthority(build);
    const deadline = performance.now() + GLOBAL_MATRIX_TIMEOUT_MS;
    onProgress({ phase: 'matrix', status: 'started' });
    const first = await runPositive(
      build,
      authority,
      deadline,
      'resource ownership matrix pass 1',
    );
    if (first.validated.kind === 'inconclusive') {
      onProgress({ phase: 'matrix', status: 'inconclusive' });
      return {
        build: build.receipt,
        conclusion: 'fake lab qualification only; production unavailable',
        matrix: {
          artifact: authority.artifactId,
          declaredSiteIds: authority.siteIds,
          globalTimeoutMs: GLOBAL_MATRIX_TIMEOUT_MS,
          mode: QUALIFICATION_MODE,
          result: first.validated,
        },
        productionAdmission: false,
        schemaVersion: 'pc-sdk.cx-004.fake-resource-matrix.v1',
        status: 'inconclusive',
      };
    }
    const second = await runPositive(
      build,
      authority,
      deadline,
      'resource ownership matrix pass 2',
    );
    if (second.validated.kind === 'inconclusive') {
      onProgress({ phase: 'matrix', status: 'inconclusive' });
      return {
        build: build.receipt,
        conclusion: 'fake lab qualification only; production unavailable',
        matrix: {
          artifact: authority.artifactId,
          declaredSiteIds: authority.siteIds,
          globalTimeoutMs: GLOBAL_MATRIX_TIMEOUT_MS,
          mode: QUALIFICATION_MODE,
          priorPass: {
            abaAttempts: first.validated.abaAttempts,
            abaSiteId: first.validated.abaSiteId,
            assertions: first.validated.assertions,
            sha256: first.validated.sha256,
            siteIds: first.validated.siteIds,
          },
          result: second.validated,
        },
        productionAdmission: false,
        schemaVersion: 'pc-sdk.cx-004.fake-resource-matrix.v1',
        status: 'inconclusive',
      };
    }
    invariant(
      first.validated.assertions === second.validated.assertions
        && first.validated.artifact === second.validated.artifact
        && first.validated.abaSiteId === second.validated.abaSiteId
        && arraysEqual(first.validated.siteIds, second.validated.siteIds),
      'MATRIX_DETERMINISTIC_FIELDS_CHANGED',
      'repeated resource matrix executions changed a deterministic field',
    );
    const negative = await runNegative(build, deadline);
    onProgress({ phase: 'matrix', status: 'passed' });
    return {
      build: build.receipt,
      conclusion: 'fake lab qualification only; production unavailable',
      matrix: {
        abaSiteId: first.validated.abaSiteId,
        assertions: first.validated.assertions,
        deterministicRepeat: {
          deterministicFieldsEqual: true,
          runs: [
            {
              abaAttempts: first.validated.abaAttempts,
              byteLength: first.validated.bytes,
              sha256: first.validated.sha256,
              siteIds: first.validated.siteIds,
            },
            {
              abaAttempts: second.validated.abaAttempts,
              byteLength: second.validated.bytes,
              sha256: second.validated.sha256,
              siteIds: second.validated.siteIds,
            },
          ],
          status: 'passed',
        },
        globalTimeoutMs: GLOBAL_MATRIX_TIMEOUT_MS,
        mode: QUALIFICATION_MODE,
        siteIds: first.validated.siteIds,
        unknownMode: {
          exitCode: negative.exitCode,
          status: 'rejected',
          stderrEmpty: negative.stderrEmpty,
          stdoutEmpty: negative.stdoutEmpty,
        },
      },
      productionAdmission: false,
      schemaVersion: 'pc-sdk.cx-004.fake-resource-matrix.v1',
      status: 'passed',
    };
  } catch (error) {
    if (
      build !== undefined
      && authority !== undefined
      && ['COMMAND_TIMEOUT_INCONCLUSIVE', 'MATRIX_GLOBAL_TIMEOUT_INCONCLUSIVE']
        .includes(error?.code)
    ) {
      onProgress({ phase: 'matrix', status: 'inconclusive' });
      return {
        build: build.receipt,
        conclusion: 'fake lab qualification only; production unavailable',
        matrix: {
          artifact: authority.artifactId,
          declaredSiteIds: authority.siteIds,
          globalTimeoutMs: GLOBAL_MATRIX_TIMEOUT_MS,
          mode: QUALIFICATION_MODE,
          result: {
            reason: 'matrix-global-bound',
            status: 'inconclusive',
            unconfirmedSiteIds: authority.siteIds,
          },
        },
        productionAdmission: false,
        schemaVersion: 'pc-sdk.cx-004.fake-resource-matrix.v1',
        status: 'inconclusive',
      };
    }
    if (error?.preserveBuildRoot === true && build !== undefined) {
      preserveBuildRoot = true;
      error.strandedBuildRoot = build.buildRoot;
    }
    throw error;
  } finally {
    if (build !== undefined && !preserveBuildRoot) {
      await cleanupQualificationArtifact(build);
    }
  }
}

function parseArguments(argv) {
  if (argv.length !== 0) {
    fail('FAKE_MATRIX_USAGE', 'usage: node qualification/run-fake-matrix.mjs');
  }
}

export async function runFakeMatrixCli(argv = process.argv.slice(2)) {
  parseArguments(argv);
  const receipt = await runFakeMatrix();
  process.stdout.write(canonicalJsonBytes(receipt));
  process.stdout.write('\n');
  if (receipt.status === 'inconclusive') process.exitCode = 3;
}

const invokedPath = process.argv[1] === undefined
  ? undefined
  : pathToFileURL(path.resolve(process.argv[1])).href;
if (invokedPath === import.meta.url) {
  runFakeMatrixCli().catch((error) => {
    const reason = typeof error?.code === 'string' ? error.code : 'FAKE_MATRIX_FAILED';
    const status = reason.includes('TIMEOUT') ? 'inconclusive' : 'failed';
    process.stderr.write(canonicalJsonBytes({
      conclusion: 'fake lab qualification only; production unavailable',
      productionAdmission: false,
      reason,
      schemaVersion: 'pc-sdk.cx-004.fake-resource-matrix-failure.v1',
      strandedBuildRoot: error?.preserveBuildRoot === true
        && typeof error?.strandedBuildRoot === 'string'
        ? error.strandedBuildRoot
        : null,
      status,
      temporaryBuildRootDisposition: error?.preserveBuildRoot === true
        ? 'preserved-due-to-cleanup-or-termination-uncertainty'
        : 'absent-or-positively-removed',
    }));
    process.stderr.write('\n');
    process.exitCode = 1;
  });
}
