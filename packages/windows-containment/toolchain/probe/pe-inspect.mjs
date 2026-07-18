const IMAGE_DIRECTORY_ENTRY_EXPORT = 0;
const IMAGE_DIRECTORY_ENTRY_IMPORT = 1;
const IMAGE_DIRECTORY_ENTRY_RESOURCE = 2;
const IMAGE_DIRECTORY_ENTRY_BASERELOC = 5;
const IMAGE_DIRECTORY_ENTRY_DEBUG = 6;
const IMAGE_DIRECTORY_ENTRY_LOAD_CONFIG = 10;
const IMAGE_DIRECTORY_ENTRY_DELAY_IMPORT = 13;

const IMAGE_DEBUG_TYPE_REPRO = 16;
const IMAGE_DEBUG_TYPE_EX_DLLCHARACTERISTICS = 20;

const IMAGE_SCN_MEM_EXECUTE = 0x20000000;
const IMAGE_SCN_MEM_READ = 0x40000000;
const IMAGE_SCN_MEM_SHARED = 0x10000000;
const IMAGE_SCN_MEM_WRITE = 0x80000000;
const IMAGE_SCN_MEM_DISCARDABLE = 0x02000000;

function fail(message) {
  throw new Error(`invalid PE: ${message}`);
}

function requireRange(buffer, offset, length, label) {
  if (!Number.isSafeInteger(offset) || !Number.isSafeInteger(length) || offset < 0 || length < 0) {
    fail(`${label} uses an invalid range`);
  }
  if (offset + length > buffer.length) {
    fail(`${label} extends beyond the file`);
  }
}

function readUInt16(buffer, offset, label) {
  requireRange(buffer, offset, 2, label);
  return buffer.readUInt16LE(offset);
}

function readUInt32(buffer, offset, label) {
  requireRange(buffer, offset, 4, label);
  return buffer.readUInt32LE(offset);
}

function readUInt64(buffer, offset, label) {
  requireRange(buffer, offset, 8, label);
  return buffer.readBigUInt64LE(offset);
}

function readAscii(buffer, offset, maximumLength, label) {
  requireRange(buffer, offset, maximumLength, label);
  const terminator = buffer.indexOf(0, offset);
  const end = terminator === -1 || terminator >= offset + maximumLength
    ? offset + maximumLength
    : terminator;
  return buffer.subarray(offset, end).toString('ascii');
}

function readCString(buffer, offset, label, maximumLength = 32 * 1024) {
  requireRange(buffer, offset, 1, label);
  const searchEnd = Math.min(buffer.length, offset + maximumLength);
  const terminator = buffer.indexOf(0, offset);
  if (terminator === -1 || terminator >= searchEnd) {
    fail(`${label} is not NUL-terminated within ${maximumLength} bytes`);
  }
  return buffer.subarray(offset, terminator).toString('ascii');
}

function readResourceString(buffer, baseOffset, encodedOffset, directorySize, label) {
  const relativeOffset = encodedOffset & 0x7fffffff;
  if (relativeOffset + 2 > directorySize) {
    fail(`${label} string offset exceeds the resource directory`);
  }
  const offset = baseOffset + relativeOffset;
  const length = readUInt16(buffer, offset, `${label} string length`);
  if (length === 0 || length > 1024 || relativeOffset + 2 + length * 2 > directorySize) {
    fail(`${label} string length is outside the resource bound`);
  }
  requireRange(buffer, offset + 2, length * 2, `${label} string`);
  const value = buffer.subarray(offset + 2, offset + 2 + length * 2).toString('utf16le');
  if (value.includes('\0')) {
    fail(`${label} string contains NUL`);
  }
  return value;
}

function bigintHex(value) {
  return `0x${value.toString(16)}`;
}

function parseSections(buffer, sectionTableOffset, count) {
  if (count === 0 || count > 96) {
    fail(`section count ${count} is outside the probe bound`);
  }
  const sections = [];
  for (let index = 0; index < count; index += 1) {
    const offset = sectionTableOffset + index * 40;
    requireRange(buffer, offset, 40, `section ${index}`);
    const name = readAscii(buffer, offset, 8, `section ${index} name`);
    const virtualSize = readUInt32(buffer, offset + 8, `section ${name} virtual size`);
    const virtualAddress = readUInt32(buffer, offset + 12, `section ${name} RVA`);
    const rawSize = readUInt32(buffer, offset + 16, `section ${name} raw size`);
    const rawOffset = readUInt32(buffer, offset + 20, `section ${name} raw offset`);
    const characteristics = readUInt32(buffer, offset + 36, `section ${name} characteristics`);
    if (rawSize !== 0) {
      requireRange(buffer, rawOffset, rawSize, `section ${name} raw data`);
    }
    sections.push({
      characteristics,
      executable: (characteristics & IMAGE_SCN_MEM_EXECUTE) !== 0,
      name,
      rawOffset,
      rawSize,
      readable: (characteristics & IMAGE_SCN_MEM_READ) !== 0,
      virtualAddress,
      virtualSize,
      writable: (characteristics & IMAGE_SCN_MEM_WRITE) !== 0,
    });
  }
  return sections;
}

function rvaToOffset(buffer, sections, rva, label) {
  if (rva === 0) {
    fail(`${label} has a zero RVA`);
  }
  for (const section of sections) {
    const span = Math.max(section.virtualSize, section.rawSize);
    if (rva >= section.virtualAddress && rva < section.virtualAddress + span) {
      const delta = rva - section.virtualAddress;
      if (delta >= section.rawSize) {
        fail(`${label} points into the non-file-backed tail of section ${section.name}`);
      }
      const offset = section.rawOffset + delta;
      requireRange(buffer, offset, 1, label);
      return offset;
    }
  }
  fail(`${label} RVA 0x${rva.toString(16)} is outside every section`);
}

function parseImports(buffer, sections, directory) {
  if (directory.rva === 0 && directory.size === 0) {
    return [];
  }
  if (directory.rva === 0 || directory.size < 20 || directory.size > 1024 * 1024) {
    fail('import directory has an invalid RVA/size pair');
  }
  const start = rvaToOffset(buffer, sections, directory.rva, 'import directory');
  const maximumDescriptors = Math.min(4096, Math.floor(directory.size / 20));
  const names = [];
  let terminated = false;
  for (let index = 0; index < maximumDescriptors; index += 1) {
    const offset = start + index * 20;
    requireRange(buffer, offset, 20, `import descriptor ${index}`);
    const fields = [0, 4, 8, 12, 16].map((delta) => buffer.readUInt32LE(offset + delta));
    if (fields.every((value) => value === 0)) {
      terminated = true;
      break;
    }
    if (fields[3] === 0) {
      fail(`import descriptor ${index} has a zero name RVA`);
    }
    const nameOffset = rvaToOffset(buffer, sections, fields[3], `import descriptor ${index} name`);
    names.push(readCString(buffer, nameOffset, `import descriptor ${index} name`));
  }
  if (!terminated) {
    fail('import descriptor table is not terminated inside its declared bound');
  }
  return [...new Set(names)].sort((left, right) => left.localeCompare(right, 'en'));
}

function parseExports(buffer, sections, directory) {
  if (directory.rva === 0 && directory.size === 0) {
    return {
      names: [],
      numberOfFunctions: 0,
      numberOfNames: 0,
      ordinalOnlyOrdinals: [],
    };
  }
  if (directory.rva === 0 || directory.size < 40 || directory.size > 16 * 1024 * 1024) {
    fail('export directory has an invalid RVA/size pair');
  }
  const offset = rvaToOffset(buffer, sections, directory.rva, 'export directory');
  requireRange(buffer, offset, 40, 'export directory');
  const ordinalBase = readUInt32(buffer, offset + 16, 'export ordinal base');
  const numberOfFunctions = readUInt32(buffer, offset + 20, 'export function count');
  const numberOfNames = readUInt32(buffer, offset + 24, 'export name count');
  const functionsRva = readUInt32(buffer, offset + 28, 'export address table');
  const namesRva = readUInt32(buffer, offset + 32, 'export name pointer table');
  const nameOrdinalsRva = readUInt32(buffer, offset + 36, 'export name ordinal table');
  if (numberOfFunctions > 16 * 1024 || numberOfNames > 16 * 1024 || numberOfNames > numberOfFunctions) {
    fail(`export function/name counts ${numberOfFunctions}/${numberOfNames} exceed the probe bound`);
  }
  if (numberOfFunctions === 0) {
    if (numberOfNames !== 0 || functionsRva !== 0 || namesRva !== 0 || nameOrdinalsRva !== 0) {
      fail('empty export table has nonempty function/name pointers');
    }
    return {
      names: [],
      numberOfFunctions,
      numberOfNames,
      ordinalOnlyOrdinals: [],
    };
  }
  const functionsOffset = rvaToOffset(buffer, sections, functionsRva, 'export address table');
  requireRange(buffer, functionsOffset, numberOfFunctions * 4, 'export address table');
  const functionRvas = Array.from(
    { length: numberOfFunctions },
    (_, index) => readUInt32(buffer, functionsOffset + index * 4, `export function RVA ${index}`),
  );
  if (numberOfNames === 0) {
    return {
      names: [],
      numberOfFunctions,
      numberOfNames,
      ordinalOnlyOrdinals: functionRvas
        .map((functionRva, index) => functionRva === 0 ? undefined : ordinalBase + index)
        .filter((value) => value !== undefined),
    };
  }
  const namesOffset = rvaToOffset(buffer, sections, namesRva, 'export name pointer table');
  const ordinalsOffset = rvaToOffset(buffer, sections, nameOrdinalsRva, 'export name ordinal table');
  requireRange(buffer, namesOffset, numberOfNames * 4, 'export name pointer table');
  requireRange(buffer, ordinalsOffset, numberOfNames * 2, 'export name ordinal table');
  const names = [];
  const namedFunctionIndexes = new Set();
  for (let index = 0; index < numberOfNames; index += 1) {
    const nameRva = readUInt32(buffer, namesOffset + index * 4, `export name RVA ${index}`);
    const nameOffset = rvaToOffset(buffer, sections, nameRva, `export name ${index}`);
    names.push(readCString(buffer, nameOffset, `export name ${index}`));
    const functionIndex = readUInt16(buffer, ordinalsOffset + index * 2, `export name ordinal ${index}`);
    if (functionIndex >= numberOfFunctions || functionRvas[functionIndex] === 0) {
      fail(`export name ordinal ${index} does not select a populated function`);
    }
    if (namedFunctionIndexes.has(functionIndex)) {
      fail(`export function index ${functionIndex} has duplicate names`);
    }
    namedFunctionIndexes.add(functionIndex);
  }
  return {
    names: names.sort((left, right) => left.localeCompare(right, 'en')),
    numberOfFunctions,
    numberOfNames,
    ordinalOnlyOrdinals: functionRvas
      .map((functionRva, index) => functionRva !== 0 && !namedFunctionIndexes.has(index) ? ordinalBase + index : undefined)
      .filter((value) => value !== undefined),
  };
}

function parseResources(buffer, sections, directory) {
  if (directory.rva === 0 && directory.size === 0) {
    return [];
  }
  if (directory.rva === 0 || directory.size < 16 || directory.size > 64 * 1024 * 1024) {
    fail('resource directory has an invalid RVA/size pair');
  }
  const baseOffset = rvaToOffset(buffer, sections, directory.rva, 'resource directory');
  requireRange(buffer, baseOffset, directory.size, 'resource directory');
  const resources = [];
  const visitedDirectories = new Set();
  let totalPayloadBytes = 0;

  const identifier = (encoded, label) => (encoded & 0x80000000) !== 0
    ? readResourceString(buffer, baseOffset, encoded, directory.size, label)
    : encoded;
  const walk = (relativeOffset, depth, ancestors) => {
    if (depth > 2 || relativeOffset + 16 > directory.size || visitedDirectories.has(`${depth}:${relativeOffset}`)) {
      fail('resource directory hierarchy is cyclic or outside its closed depth/bound');
    }
    visitedDirectories.add(`${depth}:${relativeOffset}`);
    const directoryOffset = baseOffset + relativeOffset;
    const namedCount = readUInt16(buffer, directoryOffset + 12, 'resource named-entry count');
    const idCount = readUInt16(buffer, directoryOffset + 14, 'resource ID-entry count');
    const count = namedCount + idCount;
    if (count === 0 || count > 4096 || relativeOffset + 16 + count * 8 > directory.size) {
      fail('resource directory entry count exceeds its closed bound');
    }
    for (let index = 0; index < count; index += 1) {
      const entryOffset = directoryOffset + 16 + index * 8;
      const encodedName = readUInt32(buffer, entryOffset, `resource entry ${depth}:${index} name`);
      const encodedTarget = readUInt32(buffer, entryOffset + 4, `resource entry ${depth}:${index} target`);
      const entryIdentifier = identifier(encodedName, `resource entry ${depth}:${index}`);
      if (depth < 2) {
        if ((encodedTarget & 0x80000000) === 0) {
          fail('resource type/name entry does not point to a subdirectory');
        }
        walk(encodedTarget & 0x7fffffff, depth + 1, [...ancestors, entryIdentifier]);
        continue;
      }
      if ((encodedTarget & 0x80000000) !== 0 || encodedTarget + 16 > directory.size) {
        fail('resource language entry does not point to bounded data');
      }
      const dataEntryOffset = baseOffset + encodedTarget;
      const dataRva = readUInt32(buffer, dataEntryOffset, 'resource data RVA');
      const size = readUInt32(buffer, dataEntryOffset + 4, 'resource data size');
      const codePage = readUInt32(buffer, dataEntryOffset + 8, 'resource data code page');
      const reserved = readUInt32(buffer, dataEntryOffset + 12, 'resource data reserved field');
      if (reserved !== 0 || size > 16 * 1024 * 1024) {
        fail('resource data entry has invalid reserved/size fields');
      }
      const dataOffset = rvaToOffset(buffer, sections, dataRva, 'resource payload');
      requireRange(buffer, dataOffset, size, 'resource payload');
      totalPayloadBytes += size;
      if (totalPayloadBytes > 64 * 1024 * 1024 || resources.length >= 4096) {
        fail('resource payload closure exceeds the probe bound');
      }
      resources.push({
        codePage,
        data: buffer.subarray(dataOffset, dataOffset + size),
        language: entryIdentifier,
        name: ancestors[1],
        type: ancestors[0],
      });
    }
  };
  walk(0, 0, []);
  return resources;
}

function parseDebugDirectory(buffer, sections, directory) {
  if (directory.rva === 0 && directory.size === 0) {
    return [];
  }
  if (directory.rva === 0 || directory.size === 0 || directory.size % 28 !== 0) {
    fail('debug directory has an invalid RVA/size pair');
  }
  const count = directory.size / 28;
  if (count > 256) {
    fail(`debug directory count ${count} exceeds the probe bound`);
  }
  const start = rvaToOffset(buffer, sections, directory.rva, 'debug directory');
  requireRange(buffer, start, directory.size, 'debug directory');
  const entries = [];
  for (let index = 0; index < count; index += 1) {
    const offset = start + index * 28;
    const type = readUInt32(buffer, offset + 12, `debug entry ${index} type`);
    const size = readUInt32(buffer, offset + 16, `debug entry ${index} size`);
    const rawOffset = readUInt32(buffer, offset + 24, `debug entry ${index} raw offset`);
    let exDllCharacteristics;
    if (type === IMAGE_DEBUG_TYPE_EX_DLLCHARACTERISTICS) {
      if (size < 4) {
        fail('extended DLL characteristics debug record is shorter than four bytes');
      }
      exDllCharacteristics = readUInt32(buffer, rawOffset, 'extended DLL characteristics');
    } else if (size !== 0) {
      requireRange(buffer, rawOffset, size, `debug entry ${index} data`);
    }
    entries.push({
      exDllCharacteristics,
      reproducible: type === IMAGE_DEBUG_TYPE_REPRO,
      size,
      type,
    });
  }
  return entries;
}

function parseLoadConfig(buffer, sections, directory) {
  if (directory.rva === 0 && directory.size === 0) {
    return undefined;
  }
  if (directory.rva === 0 || directory.size < 0x94) {
    fail('load-config directory is missing the required AMD64 fields');
  }
  const offset = rvaToOffset(buffer, sections, directory.rva, 'load-config directory');
  const structureSize = readUInt32(buffer, offset, 'load-config structure size');
  const available = Math.min(directory.size, structureSize);
  if (available < 0x94) {
    fail(`load-config structure size ${structureSize} omits required fields`);
  }
  requireRange(buffer, offset, available, 'load-config structure');
  const u16 = (delta, label) => readUInt16(buffer, offset + delta, label);
  const u32 = (delta, label) => readUInt32(buffer, offset + delta, label);
  const u64 = (delta, label) => readUInt64(buffer, offset + delta, label);
  const optionalU64 = (delta, label) => available >= delta + 8 ? u64(delta, label) : 0n;
  return {
    dependentLoadFlags: u16(0x4e, 'dependent load flags'),
    guardCfCheckPointer: bigintHex(u64(0x70, 'Guard CF check pointer')),
    guardCfDispatchPointer: bigintHex(u64(0x78, 'Guard CF dispatch pointer')),
    guardCfFunctionCount: bigintHex(u64(0x88, 'Guard CF function count')),
    guardCfFunctionTable: bigintHex(u64(0x80, 'Guard CF function table')),
    guardEhContinuationCount: bigintHex(optionalU64(0x110, 'Guard EH continuation count')),
    guardEhContinuationTable: bigintHex(optionalU64(0x108, 'Guard EH continuation table')),
    guardFlags: u32(0x90, 'Guard flags'),
    securityCookie: bigintHex(u64(0x58, 'security cookie')),
    structureSize,
  };
}

export function parsePe(buffer) {
  if (!Buffer.isBuffer(buffer)) {
    throw new TypeError('parsePe requires a Buffer');
  }
  requireRange(buffer, 0, 64, 'DOS header');
  if (buffer.toString('ascii', 0, 2) !== 'MZ') {
    fail('DOS signature is not MZ');
  }
  const peOffset = readUInt32(buffer, 0x3c, 'PE header offset');
  requireRange(buffer, peOffset, 24, 'PE signature and COFF header');
  if (buffer.toString('ascii', peOffset, peOffset + 4) !== 'PE\0\0') {
    fail('PE signature is missing');
  }
  const coffOffset = peOffset + 4;
  const machine = readUInt16(buffer, coffOffset, 'COFF machine');
  const numberOfSections = readUInt16(buffer, coffOffset + 2, 'COFF section count');
  const optionalHeaderSize = readUInt16(buffer, coffOffset + 16, 'optional-header size');
  const optionalOffset = coffOffset + 20;
  requireRange(buffer, optionalOffset, optionalHeaderSize, 'optional header');
  if (optionalHeaderSize < 0xf0 || readUInt16(buffer, optionalOffset, 'optional-header magic') !== 0x20b) {
    fail('image is not a complete PE32+ optional header');
  }
  const directoryCount = readUInt32(buffer, optionalOffset + 0x6c, 'data-directory count');
  if (directoryCount < 16 || directoryCount > 128) {
    fail(`data-directory count ${directoryCount} is outside the probe bound`);
  }
  const directoryOffset = optionalOffset + 0x70;
  requireRange(buffer, directoryOffset, directoryCount * 8, 'data directories');
  const directory = (index) => ({
    rva: readUInt32(buffer, directoryOffset + index * 8, `data directory ${index} RVA`),
    size: readUInt32(buffer, directoryOffset + index * 8 + 4, `data directory ${index} size`),
  });
  const sections = parseSections(buffer, optionalOffset + optionalHeaderSize, numberOfSections);
  const debug = parseDebugDirectory(buffer, sections, directory(IMAGE_DIRECTORY_ENTRY_DEBUG));
  const exports = parseExports(buffer, sections, directory(IMAGE_DIRECTORY_ENTRY_EXPORT));
  const exDllCharacteristics = debug
    .filter((entry) => entry.type === IMAGE_DEBUG_TYPE_EX_DLLCHARACTERISTICS)
    .reduce((value, entry) => value | (entry.exDllCharacteristics ?? 0), 0);
  return {
    baseRelocationDirectory: directory(IMAGE_DIRECTORY_ENTRY_BASERELOC),
    checksum: readUInt32(buffer, optionalOffset + 0x40, 'image checksum'),
    debug,
    delayImportDirectory: directory(IMAGE_DIRECTORY_ENTRY_DELAY_IMPORT),
    dllCharacteristics: readUInt16(buffer, optionalOffset + 0x46, 'DLL characteristics'),
    exDllCharacteristics,
    exportDirectory: {
      numberOfFunctions: exports.numberOfFunctions,
      numberOfNames: exports.numberOfNames,
      ordinalOnlyOrdinals: exports.ordinalOnlyOrdinals,
    },
    exports: exports.names,
    imageBase: bigintHex(readUInt64(buffer, optionalOffset + 0x18, 'image base')),
    imports: parseImports(buffer, sections, directory(IMAGE_DIRECTORY_ENTRY_IMPORT)),
    loadConfig: parseLoadConfig(buffer, sections, directory(IMAGE_DIRECTORY_ENTRY_LOAD_CONFIG)),
    machine,
    resources: parseResources(buffer, sections, directory(IMAGE_DIRECTORY_ENTRY_RESOURCE)),
    sections,
    subsystem: readUInt16(buffer, optionalOffset + 0x44, 'subsystem'),
    subsystemVersion: {
      major: readUInt16(buffer, optionalOffset + 0x30, 'subsystem major version'),
      minor: readUInt16(buffer, optionalOffset + 0x32, 'subsystem minor version'),
    },
  };
}

export const peConstants = Object.freeze({
  IMAGE_DEBUG_TYPE_EX_DLLCHARACTERISTICS,
  IMAGE_DEBUG_TYPE_REPRO,
  IMAGE_DLLCHARACTERISTICS_DYNAMIC_BASE: 0x0040,
  IMAGE_DLLCHARACTERISTICS_GUARD_CF: 0x4000,
  IMAGE_DLLCHARACTERISTICS_HIGH_ENTROPY_VA: 0x0020,
  IMAGE_DLLCHARACTERISTICS_NX_COMPAT: 0x0100,
  IMAGE_DLLCHARACTERISTICS_EX_CET_COMPAT: 0x01,
  IMAGE_FILE_MACHINE_AMD64: 0x8664,
  IMAGE_GUARD_CF_FUNCTION_TABLE_PRESENT: 0x00000400,
  IMAGE_GUARD_CF_INSTRUMENTED: 0x00000100,
  IMAGE_SCN_MEM_DISCARDABLE,
  IMAGE_SCN_MEM_SHARED,
  IMAGE_SUBSYSTEM_WINDOWS_GUI: 2,
});
