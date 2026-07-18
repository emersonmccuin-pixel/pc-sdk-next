import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { test } from 'node:test';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';

const execFileAsync = promisify(execFile);
const LOADER_PATH = fileURLToPath(
  new URL('../preseal/preseal-in-memory-loader.mjs', import.meta.url),
);

async function runLoaderProbe() {
const { createHash } = await import('node:crypto');
const { readFile } = await import('node:fs/promises');
const { register } = await import('node:module');
const { MessageChannel } = await import('node:worker_threads');

const ids = [
  'preseal-capture-entry',
  'system-tool-authority-module',
  'preseal-evidence-module',
  'runner-bootstrap-module',
  'manifest-set-module',
  'preseal-config-projection-module',
  'pe-inspect-module',
];
const urls = ids.map((id, index) =>
  `file:///pc-sdk-preseal-loader-probe/${String(index).padStart(2, '0')}-${id}.mjs`);
const sources = urls.map((unused, index) => Buffer.from(
  index === 0
    ? `${urls.slice(1).map((url, childIndex) =>
      `import { value as v${childIndex} } from ${JSON.stringify(url)};`).join('\n')}
export const value = ${urls.slice(1).map((unusedChild, childIndex) => `v${childIndex}`).join('+')};`
    : `export const value = ${index};`,
  'utf8',
));
const digest = (bytes) => createHash('sha256').update(bytes).digest('hex');
const modules = ids.map((id, index) => ({
  byteLength: sources[index].length,
  bytes: sources[index],
  id,
  sha256: digest(sources[index]),
  url: urls[index],
}));
const loaderBytes = await readFile(process.argv[1]);
const loaderSha256 = digest(loaderBytes);
const challenge = '0123456789abcdef0123456789abcdef';
const executionGraphSha256 = '1'.repeat(64);
const counterBuffer = new SharedArrayBuffer(Int32Array.BYTES_PER_ELEMENT * (ids.length + 1));
const counters = new Int32Array(counterBuffer);
const { port1, port2 } = new MessageChannel();
const readyPromise = new Promise((resolve, reject) => {
  const timer = setTimeout(() => reject(new Error('loader readiness timed out')), 5_000);
  port1.once('message', (message) => {
    clearTimeout(timer);
    resolve(message);
  });
  port1.once('messageerror', () => {
    clearTimeout(timer);
    reject(new Error('loader readiness message failed'));
  });
  port1.start();
});
register(`data:text/javascript;base64,${loaderBytes.toString('base64')}`, {
  data: {
    challenge,
    counters: counterBuffer,
    executionGraphSha256,
    loaderSha256,
    modules,
    port: port2,
  },
  transferList: [port2],
});
const ready = await readyPromise;
port1.close();
if (
  JSON.stringify(Object.keys(ready).sort()) !== JSON.stringify([
    'challenge',
    'executionGraphSha256',
    'loaderSha256',
    'moduleCount',
    'schemaVersion',
  ]) ||
  ready.challenge !== challenge ||
  ready.executionGraphSha256 !== executionGraphSha256 ||
  ready.loaderSha256 !== loaderSha256 ||
  ready.moduleCount !== ids.length ||
  ready.schemaVersion !== 'pc-sdk.cx-004.preseal-loader-ready.v1'
) throw new Error('loader readiness receipt mismatch');
const entry = await import(urls[0]);
const observed = Array.from(counters, (unused, index) => Atomics.load(counters, index));
const expected = [1, 1, 1, 1, 1, 1, 1, 0];
if (entry.value !== 21 || JSON.stringify(observed) !== JSON.stringify(expected)) {
  throw new Error(`loader closure mismatch: value=${entry.value}; counters=${JSON.stringify(observed)}`);
}
process.stdout.write(JSON.stringify({ counters: observed, value: entry.value }));
}

const PROBE_SOURCE = `(${runLoaderProbe.toString()})()`;

test('in-memory loader serves the exact seven-module static graph once with zero rejects', async () => {
  const env = { ...process.env };
  delete env.NODE_OPTIONS;
  delete env.NODE_PATH;
  const { stderr, stdout } = await execFileAsync(process.execPath, [
    '--input-type=module',
    '-e',
    PROBE_SOURCE,
    LOADER_PATH,
  ], {
    encoding: 'utf8',
    env,
    maxBuffer: 1024 * 1024,
    timeout: 10_000,
    windowsHide: true,
  });
  assert.equal(stderr, '');
  assert.deepEqual(JSON.parse(stdout), {
    counters: [1, 1, 1, 1, 1, 1, 1, 0],
    value: 21,
  });
});
