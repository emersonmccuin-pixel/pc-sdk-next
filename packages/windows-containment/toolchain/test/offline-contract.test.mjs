import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';

import { parseGenerateArguments } from '../generate-native-build-input.mjs';
import { parseVerifyArguments } from '../verify-native-build-input.mjs';

const TOOLCHAIN_DIRECTORY = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const REPOSITORY_DIRECTORY = path.resolve(TOOLCHAIN_DIRECTORY, '..', '..', '..');

test('generator and verifier have no network or process-launch imports', async () => {
  for (const name of [
    'manifest-set.mjs',
    'generate-native-build-input.mjs',
    'verify-native-build-input.mjs',
  ]) {
    const source = await readFile(path.join(TOOLCHAIN_DIRECTORY, name), 'utf8');
    assert.doesNotMatch(
      source,
      /(?:\bfrom\s+|\bimport\s*(?:\(\s*)?|\brequire\s*\(\s*)['"](?:node:)?(?:child_process|cluster|dgram|dns|http|https|net|tls|worker_threads)(?:\/[^'"]*)?['"]/u,
      name,
    );
    assert.doesNotMatch(
      source,
      /(?<![\w.])(?:exec|execFile|execFileSync|fork|spawn|spawnSync|fetch)\s*\(/u,
      name,
    );
    assert.doesNotMatch(source, /(?:getBuiltinModule|globalThis\s*\.\s*fetch|WebSocket)/u, name);
  }
});

test('CLI parsers reject ambiguity and all filesystem authority overrides', () => {
  const generated = parseGenerateArguments(['--check']);
  assert.equal(generated.check, true);
  assert.throws(
    () => parseGenerateArguments(['--config', 'config.json']),
    /unsupported argument/u,
  );
  assert.throws(
    () => parseGenerateArguments(['--location', 'cache=C:/one']),
    /unsupported argument/u,
  );
  assert.throws(
    () => parseGenerateArguments(['--output-dir', 'C:/elsewhere']),
    /unsupported argument/u,
  );
  assert.throws(
    () => parseVerifyArguments(['--root', 'root.json', '--config', 'config.json']),
    /unsupported argument/u,
  );
  assert.throws(
    () => parseVerifyArguments(['--config', 'config.json']),
    /unsupported argument/u,
  );
  assert.throws(() => parseVerifyArguments(['--unknown']), /unsupported argument/u);
});

test('repository process-boundary guard scans every production JS/TS extension and relative bypass', async () => {
  const source = await readFile(
    path.join(REPOSITORY_DIRECTORY, 'scripts', 'check-process-boundaries.mjs'),
    'utf8',
  );
  for (const extension of ['.cjs', '.cts', '.js', '.jsx', '.mjs', '.mts', '.ts', '.tsx']) {
    assert.match(source, new RegExp(`['"]${extension.replace('.', '\\.')}['"]`, 'u'));
  }
  assert.match(source, /SEALED_COMPONENT_RELATIVE_IMPORT_POLICY/u);
  assert.ok(source.includes("specifier.startsWith('./') || specifier.startsWith('../')"));
  assert.match(source, /deniedRelativeRoots\.some\(\(root\) => isPathWithin\(resolvedRelative, root\)\)/u);
});
