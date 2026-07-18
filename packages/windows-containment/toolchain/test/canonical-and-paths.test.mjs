import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  assertPrivacySafe,
  canonicalJsonBytes,
  decodeCanonicalJsonBytes,
  MAX_MANIFEST_BYTES,
  validateLogicalPath,
} from '../manifest-set.mjs';

test('canonical JSON is recursively ordinal-key-sorted, compact, and newline-free', () => {
  const bytes = canonicalJsonBytes({ z: 3, a: { z: 2, a: 1 }, list: [{ b: 2, a: 1 }] });
  assert.equal(bytes.toString('utf8'), '{"a":{"a":1,"z":2},"list":[{"a":1,"b":2}],"z":3}');
  assert.equal(bytes.includes(0x00), false);
  assert.equal(bytes.includes(0x0a), false);
  assert.equal(bytes.includes(0x0d), false);
  assert.deepEqual(decodeCanonicalJsonBytes(bytes), {
    a: { a: 1, z: 2 },
    list: [{ a: 1, b: 2 }],
    z: 3,
  });
});

test('canonical JSON preserves prototype-named members and ordinal numeric-looking keys', () => {
  const value = JSON.parse('{"2":"two","10":"ten","__proto__":"data"}');
  const bytes = canonicalJsonBytes(value);
  assert.equal(bytes.toString('utf8'), '{"10":"ten","2":"two","__proto__":"data"}');
  const decoded = decodeCanonicalJsonBytes(bytes);
  assert.equal(Object.hasOwn(decoded, '__proto__'), true);
  assert.equal(decoded.__proto__, 'data');
});

test('canonical JSON rejects unstable or lossy JavaScript values', () => {
  assert.throws(() => canonicalJsonBytes({ value: Number.NaN }), /safe integers/u);
  assert.throws(() => canonicalJsonBytes({ value: 1.5 }), /safe integers/u);
  assert.throws(() => canonicalJsonBytes({ value: -0 }), /safe integers/u);
  assert.throws(() => canonicalJsonBytes({ value: undefined }), /unsupported undefined/u);
  assert.throws(() => canonicalJsonBytes({ value: '\ud800' }), /unpaired high surrogate/u);
  const cyclic = {};
  cyclic.self = cyclic;
  assert.throws(() => canonicalJsonBytes(cyclic), /cycle/u);
});

test('canonical decoder rejects BOM, line endings, noncanonical key order, and bounds', () => {
  assert.throws(
    () => decodeCanonicalJsonBytes(Buffer.from('\ufeff{}', 'utf8')),
    /UTF-8 BOM/u,
  );
  assert.throws(
    () => decodeCanonicalJsonBytes(Buffer.from('{}\n', 'utf8')),
    /one line/u,
  );
  assert.throws(
    () => decodeCanonicalJsonBytes(Buffer.from('{"z":1,"a":2}', 'utf8')),
    /not exact compact/u,
  );
  assert.throws(
    () => decodeCanonicalJsonBytes(canonicalJsonBytes({ payload: 'x'.repeat(200) }), 'tiny', {
      maxManifestBytes: 32,
    }),
    /byte length/u,
  );
  assert.throws(
    () => decodeCanonicalJsonBytes(canonicalJsonBytes({ a: [1, 2, 3] }), 'few-members', {
      maxManifestMembers: 4,
    }),
    /recursive member count/u,
  );
  assert.ok(MAX_MANIFEST_BYTES > 32);
});

test('logical paths are portable relative forward-slash paths', () => {
  assert.equal(validateLogicalPath('sdk/include/um/windows.h'), 'sdk/include/um/windows.h');
  assert.equal(validateLogicalPath('unicode/工具.hpp'), 'unicode/工具.hpp');
  for (const invalid of [
    '',
    '/absolute',
    'C:/absolute',
    'back\\slash',
    'dot/./entry',
    'dot/../entry',
    'double//separator',
    'ads/file:stream',
    'trailing-dot.',
    'trailing-space ',
    'AUX.txt',
    'control/\u0001',
  ]) {
    assert.throws(() => validateLogicalPath(invalid), /path|segment|character|basename|empty/u, invalid);
  }
});

test('privacy scan rejects host-absolute and explicitly forbidden identity strings', () => {
  assert.doesNotThrow(() => assertPrivacySafe({ path: 'logical/sdk/include' }, []));
  assert.throws(
    () => assertPrivacySafe({ path: 'C:\\Users\\Alice\\toolchain' }, []),
    /host-absolute Windows path/u,
  );
  assert.throws(
    () => assertPrivacySafe({ account: 'build-for-Alice' }, ['Alice']),
    /forbidden host\/profile substring/u,
  );
  for (const path of [
    'prefix(C:\\Windows\\system32)',
    'prefix[C:\\Windows\\system32]',
    'prefix,C:\\Windows\\system32',
  ]) {
    assert.throws(
      () => assertPrivacySafe({ path }, []),
      /host-absolute Windows path/u,
      path,
    );
  }
  assert.doesNotThrow(() => assertPrivacySafe({ url: 'https://nodejs.org/dist/' }, []));
});
