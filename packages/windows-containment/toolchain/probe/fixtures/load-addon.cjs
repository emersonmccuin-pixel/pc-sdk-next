'use strict';

const assert = require('node:assert/strict');
const path = require('node:path');

assert.equal(process.versions.modules, '127');
assert.equal(process.versions.napi, '9');
assert.equal(process.argv.length, 3);

const addon = require(path.resolve(process.argv[2]));
assert.equal(addon.probeValue, 116);
process.stdout.write('{"abi":"127","napi":"9","value":116}\n');
