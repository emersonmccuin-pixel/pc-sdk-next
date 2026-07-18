import { createHash } from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { isDeepStrictEqual } from 'node:util';

import {
  assertManifestSetMatchesDisk,
  decodeCanonicalJsonBytes,
  generateManifestSetFromConfig,
  hashStableFile,
  ROOT_FILE_NAME,
  SHARD_FILE_PREFIX,
  validateLogicalPath,
} from './manifest-set.mjs';
import {
  FILESYSTEM_AUDIT_PLAN_SCHEMA,
  prepareFilesystemAuditAuthority,
} from './preseal/system-tool-authority.mjs';

export const AUDIT_PLAN_SCHEMA =
  FILESYSTEM_AUDIT_PLAN_SCHEMA;
export const AUDIT_RECEIPT_SCHEMA =
  'pc-sdk.cx-004.native-build-input-filesystem-audit-receipt.v1';

const SCRIPT_DIRECTORY = path.dirname(fileURLToPath(import.meta.url));
const DEFAULT_CONFIG = path.join(SCRIPT_DIRECTORY, 'native-build-input.config.json');

function fail(message) {
  throw new Error(`CX-004 native-build-input filesystem audit: ${message}`);
}

function ordinalCompare(left, right) {
  return left < right ? -1 : left > right ? 1 : 0;
}

function isPathWithin(candidate, root) {
  const relative = path.relative(root, candidate);
  return relative === '' || (
    relative !== '..' &&
    !relative.startsWith(`..${path.sep}`) &&
    !path.isAbsolute(relative)
  );
}

function credentialHomeCandidates() {
  const candidates = [
    process.env.CODEX_HOME,
    process.env.CLAUDE_CONFIG_DIR,
    path.join(os.homedir(), '.codex'),
    path.join(os.homedir(), '.claude'),
  ];
  return candidates
    .filter((entry) => typeof entry === 'string' && entry.length !== 0)
    .map((entry) => path.resolve(entry));
}

function assertAdmissibleAuditRoot(rootPath, label) {
  if (typeof rootPath !== 'string' || rootPath.length === 0 || rootPath.includes('\0')) {
    fail(`${label} must be one nonempty local filesystem path`);
  }
  const absolute = path.resolve(rootPath);
  if (
    process.platform !== 'win32' ||
    !/^[A-Za-z]:[\\/]/u.test(absolute) ||
    absolute.startsWith('\\\\') ||
    absolute.startsWith('\\\\?\\') ||
    absolute.startsWith('\\\\.\\')
  ) {
    fail(`${label} must be on one local Windows drive`);
  }
  const loweredSegments = absolute
    .replaceAll('\\', '/')
    .toLocaleLowerCase('en-US')
    .split('/');
  if (loweredSegments.includes('.codex') || loweredSegments.includes('.claude')) {
    fail(`${label} overlaps a forbidden provider home`);
  }
  for (const providerRoot of credentialHomeCandidates()) {
    if (isPathWithin(absolute, providerRoot) || isPathWithin(providerRoot, absolute)) {
      fail(`${label} overlaps a forbidden provider home`);
    }
  }
  return absolute;
}

function resolveSourceRoot(source, context, label) {
  let rootPath;
  if (Object.hasOwn(source, 'root')) {
    rootPath = path.resolve(context.configDirectory, source.root);
  } else {
    if (!Object.hasOwn(context.locations, source.location)) {
      fail(`${label} references an undeclared location`);
    }
    rootPath = source.relativeRoot === undefined || source.relativeRoot === ''
      ? context.locations[source.location]
      : path.join(
        context.locations[source.location],
        ...source.relativeRoot.split('/'),
      );
  }
  return assertAdmissibleAuditRoot(rootPath, `${label} root`);
}

function buildInputAuditSources(context) {
  const sources = [];
  let ordinal = 0;
  for (const surface of context.config.surfaces) {
    for (const [sourceIndex, source] of surface.sources.entries()) {
      const sourceId = `source-${String(ordinal).padStart(3, '0')}`;
      sources.push({
        files: source.mode === 'files' ? [...source.files].sort(ordinalCompare) : [],
        ...(Object.hasOwn(source, 'identityPolicy') ? {
          identityPolicy: source.identityPolicy.kind === 'pnpm-content-addressed-store-hardlink-v1'
            ? { kind: source.identityPolicy.kind }
            : {
              kind: source.identityPolicy.kind,
              linkCount: source.identityPolicy.linkCount,
              relativePaths: [...source.identityPolicy.relativePaths].sort(ordinalCompare),
            },
        } : {}),
        logicalPrefix: source.logicalPrefix,
        mode: source.mode,
        rootPath: resolveSourceRoot(
          source,
          context,
          `surface ${surface.surfaceId} source ${sourceIndex}`,
        ),
        sourceId,
        sourceIndex,
        surfaceId: surface.surfaceId,
      });
      ordinal += 1;
    }
  }
  return sources;
}

function buildManifestAuditSource(generated) {
  const names = [...generated.manifestSet.files.keys()].sort(ordinalCompare);
  return {
    files: names,
    logicalPrefix: 'manifest-set',
    mode: 'files',
    rootPath: assertAdmissibleAuditRoot(
      generated.outputDirectory,
      'manifest output directory',
    ),
    sourceId: 'manifest-set',
    sourceIndex: 0,
    surfaceId: 'manifest-set',
  };
}

function buildInputAuditPlan(context) {
  return {
    schemaVersion: AUDIT_PLAN_SCHEMA,
    sources: buildInputAuditSources(context),
  };
}

function buildConfigAuditPlan(configPath) {
  const absoluteConfigPath = path.resolve(configPath);
  const configDirectory = assertAdmissibleAuditRoot(
    path.dirname(absoluteConfigPath),
    'declarative config directory',
  );
  const configFileName = path.basename(absoluteConfigPath);
  validateLogicalPath(configFileName, 'declarative config filename');
  return {
    schemaVersion: AUDIT_PLAN_SCHEMA,
    sources: [{
      files: [configFileName],
      logicalPrefix: 'audit-config',
      mode: 'files',
      rootPath: configDirectory,
      sourceId: 'audit-config',
      sourceIndex: 0,
      surfaceId: 'audit-config',
    }],
  };
}

function buildManifestAuditPlan(generated) {
  return {
    schemaVersion: AUDIT_PLAN_SCHEMA,
    sources: [buildManifestAuditSource(generated)],
  };
}

export async function runFilesystemAuditPlan(plan, options = {}) {
  const authority = await prepareFilesystemAuditAuthority();
  const receipt = await authority.runAuditPlan(plan, options);
  await authority.finalize();
  await authority.teardown();
  return receipt;
}

function expectedInputTuples(manifestSet) {
  const bySurface = new Map();
  const shardEntries = [...manifestSet.files.entries()]
    .filter(([name]) => name.startsWith(SHARD_FILE_PREFIX) && name.endsWith('.json'))
    .sort(([left], [right]) => ordinalCompare(left, right));
  for (const [name, bytes] of shardEntries) {
    const shard = decodeCanonicalJsonBytes(bytes, name, manifestSet.limits);
    const tuples = bySurface.get(shard.surfaceId) ?? [];
    tuples.push(...shard.files);
    bySurface.set(shard.surfaceId, tuples);
  }
  for (const tuples of bySurface.values()) {
    tuples.sort((left, right) => ordinalCompare(left[0], right[0]));
  }
  return bySurface;
}

function auditedInputTuples(receipt) {
  const bySurface = new Map();
  for (const source of receipt.sources) {
    if (source.sourceId === 'manifest-set') {
      continue;
    }
    const tuples = bySurface.get(source.surfaceId) ?? [];
    tuples.push(...source.files);
    bySurface.set(source.surfaceId, tuples);
  }
  for (const [surfaceId, tuples] of bySurface) {
    tuples.sort((left, right) => ordinalCompare(left[0], right[0]));
    for (let index = 1; index < tuples.length; index += 1) {
      if (tuples[index - 1][0] === tuples[index][0]) {
        fail(`the hardened audit found duplicate logical paths in surface ${surfaceId}`);
      }
    }
  }
  return bySurface;
}

function compareInputTuples(manifestSet, receipt) {
  const expected = expectedInputTuples(manifestSet);
  const actual = auditedInputTuples(receipt);
  if (
    expected.size !== actual.size ||
    [...expected].some(([surfaceId, tuples]) => !isDeepStrictEqual(actual.get(surfaceId), tuples))
  ) {
    fail('the hardened filesystem tuples do not equal the generated root-and-shard closure');
  }
  return [...actual.values()].reduce((total, tuples) => total + tuples.length, 0);
}

function compareManifestTuples(manifestSet, receipt) {
  const source = receipt.sources.find((entry) => entry.sourceId === 'manifest-set');
  if (source === undefined) {
    fail('the hardened audit omitted the generated manifest files');
  }
  const expected = [...manifestSet.files.entries()]
    .map(([name, bytes]) => [
      `manifest-set/${name}`,
      bytes.length,
      createHash('sha256').update(bytes).digest('hex'),
    ])
    .sort((left, right) => ordinalCompare(left[0], right[0]));
  if (!isDeepStrictEqual(source.files, expected)) {
    fail('the hardened manifest-file facts do not equal the generated manifest bytes');
  }
  return expected.length;
}

function preflightContext(context) {
  buildInputAuditSources(context);
  assertAdmissibleAuditRoot(context.outputDirectory, 'manifest output directory');
}

async function assertConfigStillMatchesAudit(configPath, receipt) {
  const expected = receipt.sources[0]?.files[0];
  if (!Array.isArray(expected) || expected.length !== 3) {
    fail('the hardened config-file audit receipt was incomplete');
  }
  const actual = await hashStableFile(configPath, 'native-build-input config');
  if (actual.byteLength !== expected[1] || actual.sha256 !== expected[2]) {
    fail('the declarative config changed after its hardened filesystem audit');
  }
}

export async function auditNativeBuildInputsWithinAuthority(authority, options = {}) {
  const configPath = DEFAULT_CONFIG;
  const generationOptions = {};
  const configWorkerReceipt = await authority.runAuditPlan(
    buildConfigAuditPlan(configPath),
    { timeoutMs: options.timeoutMs },
  );
  const preflight = authority.configContext;
  await assertConfigStillMatchesAudit(configPath, configWorkerReceipt);
  preflightContext(preflight);
  const inputPlan = buildInputAuditPlan(preflight);
  const inputWorkerReceipt = await authority.runAuditPlan(
    inputPlan,
    { timeoutMs: options.timeoutMs },
  );
  const generated = await generateManifestSetFromConfig(configPath, generationOptions);
  await assertConfigStillMatchesAudit(configPath, configWorkerReceipt);
  if (generated.config.manifestSetId !== preflight.config.manifestSetId) {
    fail('the declarative config changed between preflight and enumeration');
  }
  preflightContext(generated);
  const inputFileCount = compareInputTuples(
    generated.manifestSet,
    inputWorkerReceipt,
  );
  const manifestPlan = buildManifestAuditPlan(generated);
  const manifestWorkerReceipt = await authority.runAuditPlan(
    manifestPlan,
    { timeoutMs: options.timeoutMs },
  );
  const manifestFileCount = compareManifestTuples(
    generated.manifestSet,
    manifestWorkerReceipt,
  );
  const diskReceipt = await assertManifestSetMatchesDisk(
    generated.manifestSet,
    generated.outputDirectory,
    { forbiddenSubstrings: generated.forbiddenSubstrings },
  );
  return {
    action: 'filesystem-audited',
    inputFileCount,
    manifestFileCount,
    manifestSetId: generated.config.manifestSetId,
    replayBinding: {
      config: configWorkerReceipt,
      inputs: inputWorkerReceipt,
    },
    rootFileName: ROOT_FILE_NAME,
    rootSha256: diskReceipt.rootSha256,
    sourceCount: inputPlan.sources.length,
    surfaceCount: generated.config.surfaces.length,
  };
}

export async function replayNativeBuildInputsWithinAuthority(
  authority,
  replayBinding,
  options = {},
) {
  if (
    replayBinding === null
    || typeof replayBinding !== 'object'
    || Array.isArray(replayBinding)
    || !isDeepStrictEqual(Object.keys(replayBinding).sort(ordinalCompare), ['config', 'inputs'])
  ) {
    fail('the native-build-input replay binding was malformed');
  }
  const configPath = DEFAULT_CONFIG;
  const configPlan = buildConfigAuditPlan(configPath);
  const configReplay = await authority.runAuditPlan(
    configPlan,
    { timeoutMs: options.timeoutMs },
  );
  if (!isDeepStrictEqual(configReplay, replayBinding.config)) {
    fail('the declarative config changed after the initial hardened audit');
  }
  const preflight = authority.configContext;
  await assertConfigStillMatchesAudit(configPath, configReplay);
  preflightContext(preflight);
  const inputPlan = buildInputAuditPlan(preflight);
  const inputReplay = await authority.runAuditPlan(
    inputPlan,
    { timeoutMs: options.timeoutMs },
  );
  if (!isDeepStrictEqual(inputReplay, replayBinding.inputs)) {
    fail('the native-build-input surface changed between admission and completed use');
  }
  await assertConfigStillMatchesAudit(configPath, configReplay);
  return {
    action: 'filesystem-audit-replayed',
    configFileCount: configReplay.fileCount,
    inputFileCount: inputReplay.fileCount,
    sourceCount: inputPlan.sources.length,
  };
}

export async function auditNativeBuildInputs(options = {}) {
  const authority = await prepareFilesystemAuditAuthority();
  const innerReceipt = await auditNativeBuildInputsWithinAuthority(authority, options);
  const { replayBinding: _replayBinding, ...receipt } = innerReceipt;
  const executionAuthority = await authority.finalize();
  const completedReceipt = { ...receipt, executionAuthority };
  await authority.teardown();
  return completedReceipt;
}

export function parseAuditArguments(argv) {
  const options = {};
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === '--help') {
      options.help = true;
    } else {
      throw new Error(`unsupported argument ${JSON.stringify(argument)}`);
    }
  }
  return options;
}

export async function main(argv = process.argv.slice(2)) {
  const options = parseAuditArguments(argv);
  if (options.help) {
    process.stdout.write(
      'Usage: node toolchain/audit-native-build-input.mjs\n',
    );
    return;
  }
  const receipt = await auditNativeBuildInputs(options);
  process.stdout.write(`${JSON.stringify(receipt)}\n`);
}

const invokedPath = process.argv[1] === undefined ? '' : path.resolve(process.argv[1]);
if (invokedPath === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 1;
  });
}
