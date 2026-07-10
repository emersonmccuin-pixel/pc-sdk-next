// Guard: the Claude Agent SDK is imported in EXACTLY ONE server file
// (runner/sdk-backend.ts). Everything else hangs off the RunnerBackend seam.
// If this fails, a second file imported `@anthropic-ai/claude-agent-sdk` — route
// it through the seam (or re-export from sdk-backend) instead.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join, relative } from 'node:path';

const SRC = join(dirname(fileURLToPath(import.meta.url)), '..', 'src');
// Match the module-specifier in an import/require (handles multi-line imports
// where `from '…'` sits on its own line); a bare comment mention won't match.
const SDK_IMPORT = /(?:from|require\(\s*)\s*['"]@anthropic-ai\/claude-agent-sdk['"]/;

function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) walk(full, out);
    else if (full.endsWith('.ts')) out.push(full);
  }
  return out;
}

test('only runner/sdk-backend.ts imports the Claude Agent SDK', () => {
  const importers: string[] = [];
  for (const file of walk(SRC)) {
    if (SDK_IMPORT.test(readFileSync(file, 'utf8'))) {
      importers.push(relative(SRC, file).replace(/\\/g, '/'));
    }
  }
  assert.deepEqual(importers, ['runner/sdk-backend.ts'], `unexpected SDK importers: ${importers.join(', ')}`);
});
