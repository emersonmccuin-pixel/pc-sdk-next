// Guard: the Claude Agent SDK is imported in EXACTLY ONE server file
// (runner/claude-adapter.ts). Everything else hangs off the RuntimeSession seam.
// If this fails, a second file imported `@anthropic-ai/claude-agent-sdk` — route
// it through the seam (or re-export from claude-adapter) instead.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join, relative } from 'node:path';

const SRC = join(dirname(fileURLToPath(import.meta.url)), '..', 'src');
const REPO = join(SRC, '..', '..', '..');
// Match the module-specifier in an import/require (handles multi-line imports
// where `from '…'` sits on its own line); a bare comment mention won't match.
const SDK_IMPORT = /(?:from|require\(\s*)\s*['"]@anthropic-ai\/claude-agent-sdk['"]/;

function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) walk(full, out);
    else if (full.endsWith('.ts') || full.endsWith('.tsx')) out.push(full);
  }
  return out;
}

test('only runner/claude-adapter.ts imports the Claude Agent SDK', () => {
  const importers: string[] = [];
  for (const file of walk(SRC)) {
    if (SDK_IMPORT.test(readFileSync(file, 'utf8'))) {
      importers.push(relative(SRC, file).replace(/\\/g, '/'));
    }
  }
  assert.deepEqual(importers, ['runner/claude-adapter.ts'], `unexpected SDK importers: ${importers.join(', ')}`);
});

test('canonical contracts and browser contain no provider-native or retired raw-tool vocabulary', () => {
  const forbidden = /\b(?:sdkUuid|sdkSessionId|chat-delta|thinking-delta|ThinkingBubble|end_turn|toolUseId|toolUseID|tool_use_id|tool-input-delta|input_json_delta|partial_json)\b|(?:kind|case)\s*:?\s*['"](?:thinking|tool-call|tool-result|tool-denied)['"]/;
  const offenders: string[] = [];
  for (const root of [join(REPO, 'packages', 'contracts', 'src'), join(REPO, 'apps', 'web', 'src')]) {
    for (const file of walk(root)) {
      if (forbidden.test(readFileSync(file, 'utf8'))) offenders.push(relative(REPO, file).replace(/\\/g, '/'));
    }
  }
  assert.deepEqual(offenders, [], `provider-native chat vocabulary leaked into: ${offenders.join(', ')}`);
});
