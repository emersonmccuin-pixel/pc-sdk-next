import assert from 'node:assert/strict';
import test from 'node:test';

import { parsePe } from '../pe-inspect.mjs';

function minimalPe() {
  const buffer = Buffer.alloc(0x1000);
  buffer.write('MZ', 0, 'ascii');
  buffer.writeUInt32LE(0x80, 0x3c);
  buffer.write('PE\0\0', 0x80, 'ascii');
  const coff = 0x84;
  buffer.writeUInt16LE(0x8664, coff);
  buffer.writeUInt16LE(1, coff + 2);
  buffer.writeUInt16LE(0xf0, coff + 16);
  const optional = coff + 20;
  buffer.writeUInt16LE(0x20b, optional);
  buffer.writeBigUInt64LE(0x140000000n, optional + 0x18);
  buffer.writeUInt16LE(10, optional + 0x30);
  buffer.writeUInt16LE(0, optional + 0x32);
  buffer.writeUInt16LE(3, optional + 0x44);
  buffer.writeUInt16LE(0x0160, optional + 0x46);
  buffer.writeUInt32LE(16, optional + 0x6c);
  const section = optional + 0xf0;
  buffer.write('.text\0\0\0', section, 'ascii');
  buffer.writeUInt32LE(0x100, section + 8);
  buffer.writeUInt32LE(0x1000, section + 12);
  buffer.writeUInt32LE(0xc00, section + 16);
  buffer.writeUInt32LE(0x400, section + 20);
  buffer.writeUInt32LE(0x60000020, section + 36);
  return buffer;
}

function hardenedPe() {
  const buffer = minimalPe();
  const optional = 0x98;
  const directories = optional + 0x70;
  const setDirectory = (index, rva, size) => {
    buffer.writeUInt32LE(rva, directories + index * 8);
    buffer.writeUInt32LE(size, directories + index * 8 + 4);
  };
  setDirectory(1, 0x1100, 40);
  setDirectory(5, 0x1400, 12);
  setDirectory(6, 0x1380, 56);
  setDirectory(10, 0x1200, 0x140);

  const importDescriptor = 0x500;
  buffer.writeUInt32LE(0x1180, importDescriptor + 12);
  buffer.writeUInt32LE(0x1190, importDescriptor + 16);
  buffer.write('KERNEL32.dll\0', 0x580, 'ascii');

  const loadConfig = 0x600;
  buffer.writeUInt32LE(0x140, loadConfig);
  buffer.writeUInt16LE(0x800, loadConfig + 0x4e);
  buffer.writeBigUInt64LE(0x140001000n, loadConfig + 0x58);
  buffer.writeBigUInt64LE(0x140002000n, loadConfig + 0x70);
  buffer.writeBigUInt64LE(0x140003000n, loadConfig + 0x78);
  buffer.writeBigUInt64LE(0x140004000n, loadConfig + 0x80);
  buffer.writeBigUInt64LE(3n, loadConfig + 0x88);
  buffer.writeUInt32LE(0x500, loadConfig + 0x90);
  buffer.writeBigUInt64LE(0x140005000n, loadConfig + 0x108);
  buffer.writeBigUInt64LE(2n, loadConfig + 0x110);

  const debug = 0x780;
  buffer.writeUInt32LE(16, debug + 12);
  const extended = debug + 28;
  buffer.writeUInt32LE(20, extended + 12);
  buffer.writeUInt32LE(4, extended + 16);
  buffer.writeUInt32LE(0x900, extended + 24);
  buffer.writeUInt32LE(1, 0x900);
  return buffer;
}

function ordinalOnlyExportPe() {
  const buffer = minimalPe();
  const directories = 0x98 + 0x70;
  buffer.writeUInt32LE(0x1500, directories);
  buffer.writeUInt32LE(40, directories + 4);
  const exports = 0x900;
  buffer.writeUInt32LE(1, exports + 16);
  buffer.writeUInt32LE(1, exports + 20);
  buffer.writeUInt32LE(0, exports + 24);
  buffer.writeUInt32LE(0x1530, exports + 28);
  buffer.writeUInt32LE(0x1000, 0x930);
  return buffer;
}

function inputDigestResourcePe() {
  const buffer = minimalPe();
  const directories = 0x98 + 0x70;
  buffer.writeUInt32LE(0x1600, directories + 2 * 8);
  buffer.writeUInt32LE(0x100, directories + 2 * 8 + 4);
  const base = 0xa00;
  buffer.writeUInt16LE(0, base + 12);
  buffer.writeUInt16LE(1, base + 14);
  buffer.writeUInt32LE(10, base + 16);
  buffer.writeUInt32LE(0x80000020, base + 20);
  buffer.writeUInt16LE(1, base + 0x20 + 12);
  buffer.writeUInt16LE(0, base + 0x20 + 14);
  buffer.writeUInt32LE(0x80000080, base + 0x20 + 16);
  buffer.writeUInt32LE(0x80000040, base + 0x20 + 20);
  buffer.writeUInt16LE(0, base + 0x40 + 12);
  buffer.writeUInt16LE(1, base + 0x40 + 14);
  buffer.writeUInt32LE(1033, base + 0x40 + 16);
  buffer.writeUInt32LE(0x60, base + 0x40 + 20);
  buffer.writeUInt32LE(0x1700, base + 0x60);
  buffer.writeUInt32LE(32, base + 0x64);
  const name = 'PCSDK_CX004_NATIVE_BUILD_INPUT_SHA256';
  buffer.writeUInt16LE(name.length, base + 0x80);
  buffer.write(name, base + 0x82, 'utf16le');
  for (let index = 0; index < 32; index += 1) {
    buffer[0xb00 + index] = index;
  }
  return buffer;
}

test('parses a bounded AMD64 PE32+ header without directories', () => {
  const parsed = parsePe(minimalPe());
  assert.equal(parsed.machine, 0x8664);
  assert.equal(parsed.imageBase, '0x140000000');
  assert.deepEqual(parsed.subsystemVersion, { major: 10, minor: 0 });
  assert.deepEqual(parsed.imports, []);
  assert.deepEqual(parsed.exports, []);
  assert.equal(parsed.sections.length, 1);
  assert.deepEqual(
    {
      executable: parsed.sections[0].executable,
      name: parsed.sections[0].name,
      readable: parsed.sections[0].readable,
      writable: parsed.sections[0].writable,
    },
    { executable: true, name: '.text', readable: true, writable: false },
  );
});

test('rejects a malformed PE signature before following directories', () => {
  const buffer = minimalPe();
  buffer.write('NOPE', 0x80, 'ascii');
  assert.throws(() => parsePe(buffer), /PE signature is missing/);
});

test('decodes direct imports, hardening load config, and CET debug evidence', () => {
  const parsed = parsePe(hardenedPe());
  assert.deepEqual(parsed.imports, ['KERNEL32.dll']);
  assert.equal(parsed.delayImportDirectory.rva, 0);
  assert.equal(parsed.exDllCharacteristics, 1);
  assert.equal(parsed.debug.some((entry) => entry.reproducible), true);
  assert.deepEqual(parsed.loadConfig, {
    dependentLoadFlags: 0x800,
    guardCfCheckPointer: '0x140002000',
    guardCfDispatchPointer: '0x140003000',
    guardCfFunctionCount: '0x3',
    guardCfFunctionTable: '0x140004000',
    guardEhContinuationCount: '0x2',
    guardEhContinuationTable: '0x140005000',
    guardFlags: 0x500,
    securityCookie: '0x140001000',
    structureSize: 0x140,
  });
});

test('reports ordinal-only exports even when the named export table is empty', () => {
  const parsed = parsePe(ordinalOnlyExportPe());
  assert.deepEqual(parsed.exports, []);
  assert.deepEqual(parsed.exportDirectory, {
    numberOfFunctions: 1,
    numberOfNames: 0,
    ordinalOnlyOrdinals: [1],
  });
});

test('extracts a named raw RCDATA input-digest resource', () => {
  const parsed = parsePe(inputDigestResourcePe());
  const resource = parsed.resources[0];
  assert.equal(parsed.resources.length, 1);
  assert.equal(resource.type, 10);
  assert.equal(resource.name, 'PCSDK_CX004_NATIVE_BUILD_INPUT_SHA256');
  assert.equal(resource.language, 1033);
  assert.deepEqual(resource.data, Buffer.from(Array.from({ length: 32 }, (_, index) => index)));
});
