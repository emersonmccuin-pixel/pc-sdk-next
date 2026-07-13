import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const SRC = join(dirname(fileURLToPath(import.meta.url)), '..', 'src');
const REPO = join(SRC, '..', '..', '..');
const SOURCE_EXTENSIONS = new Set(['.ts', '.tsx', '.mts', '.cts', '.js', '.mjs', '.cjs']);
const PRODUCTION_ROOTS = [
  SRC,
  ...readdirSync(join(REPO, 'packages'))
    .map((name) => join(REPO, 'packages', name, 'src'))
    .filter(existsSync),
];
const CHILD_PROCESS_MODULE = /(?:\bfrom\s*|\brequire\s*\(\s*|\bimport\s*\(\s*|\bimport\s*)['"](?:node:)?child_process['"]/;
const PROCESS_ENV = String.raw`process(?:\.env|\[\s*['"]env['"]\s*\])(?![.\[])`;
const BROAD_ENVIRONMENT_PATTERNS = [
  new RegExp(String.raw`\.\.\.\s*${PROCESS_ENV}`),
  new RegExp(String.raw`\benv\s*:\s*${PROCESS_ENV}`),
  new RegExp(String.raw`Object\.(?:assign|entries|keys|values)\s*\([\s\S]{0,200}?${PROCESS_ENV}`),
  new RegExp(String.raw`\b(?:const|let|var)\s+[A-Za-z_$][\w$]*\s*=\s*${PROCESS_ENV}`),
];

function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) walk(full, out);
    else if (SOURCE_EXTENSIONS.has(full.slice(full.lastIndexOf('.')))) out.push(full);
  }
  return out;
}

function source(relativePath: string): string {
  return readFileSync(join(SRC, ...relativePath.split('/')), 'utf8');
}

function count(text: string, pattern: RegExp): number {
  return [...text.matchAll(pattern)].length;
}

function productionFiles(): string[] {
  return PRODUCTION_ROOTS.flatMap((root) => walk(root)).sort();
}

test('source guard recognizes alternate child imports and broad environment handoffs', () => {
  for (const sample of [
    "import { spawnSync } from 'child_process'",
    "const cp = require('node:child_process')",
    "const cp = await import('child_process')",
    "import 'node:child_process'",
  ]) assert.match(sample, CHILD_PROCESS_MODULE);

  for (const sample of [
    "spawn('x', { env: process.env })",
    "const inherited = process['env']",
    'const inherited = Object.assign({}, process.env)',
    'const inherited = { cwd, ...process.env }',
  ]) {
    assert.equal(
      BROAD_ENVIRONMENT_PATTERNS.some((pattern) => pattern.test(sample)),
      true,
      sample,
    );
  }
});

test('every direct production child-process importer is classified and policy-built', () => {
  const importers = productionFiles()
    .filter((file) => CHILD_PROCESS_MODULE.test(readFileSync(file, 'utf8')))
    .map((file) => relative(REPO, file).replace(/\\/g, '/'))
    .sort();
  assert.deepEqual(importers, [
    'apps/server/src/dispatch/repository-lease.ts',
    'apps/server/src/dispatch/worktrees.ts',
    'apps/server/src/index.ts',
  ]);

  const repositoryLease = source('dispatch/repository-lease.ts');
  assert.match(repositoryLease, /import\s*\{\s*execFile\s*\}\s*from\s*['"]node:child_process['"]/);
  assert.equal(count(repositoryLease, /(?:node:)?child_process/g), 1);
  assert.equal(count(repositoryLease, /\bexecFile\(/g), 3);
  assert.equal(count(repositoryLease, /env:\s*buildChildEnvironment\(\)/g), 3);

  const worktrees = source('dispatch/worktrees.ts');
  assert.match(worktrees, /import\s*\{\s*execFile\s*,\s*spawn\s*\}\s*from\s*['"]node:child_process['"]/);
  assert.equal(count(worktrees, /(?:node:)?child_process/g), 1);
  assert.equal(count(worktrees, /\bexecFile\(/g), 2, 'Git and fixed taskkill helper');
  assert.equal(count(worktrees, /\bspawn\(/g), 3, 'two binary-safe Git readers and one shared profile/verification shell');
  assert.equal(count(worktrees, /env:\s*buildChildEnvironment\(\)/g), 4);
  assert.equal(count(worktrees, /spawn\('git',\s*\[\.\.\.args\],\s*\{/g), 2);
  assert.equal(count(worktrees, /const env = sanitizedShellEnv\(opts\.env\)/g), 1);
  assert.match(worktrees, /spawn\(command,\s*\{[\s\S]{0,300}?shell,[\s\S]{0,300}?env,/);
  assert.doesNotMatch(worktrees, /shell:\s*true/);
  assert.match(worktrees, /return buildChildEnvironment\(base\)/);

  const index = source('index.ts');
  assert.match(index, /import\s*\{\s*spawn\s*,\s*type StdioOptions\s*\}\s*from\s*['"]node:child_process['"]/);
  assert.equal(count(index, /(?:node:)?child_process/g), 1);
  assert.equal(count(index, /\bspawn\(/g), 1, 'the sole direct exception is same-engine restart');
  assert.equal(count(index, /\.\.\.\s*process\.env\b/g), 1);
  assert.match(index, /RESTART_ADMISSION_WAIT_ENV/);
});

test('broad process.env cloning or direct handoff is confined to the trusted same-engine restart', () => {
  const offenders: string[] = [];
  for (const file of productionFiles()) {
    const text = readFileSync(file, 'utf8');
    if (BROAD_ENVIRONMENT_PATTERNS.some((pattern) => pattern.test(text))) {
      offenders.push(relative(REPO, file).replace(/\\/g, '/'));
    }
  }
  assert.deepEqual(offenders, ['apps/server/src/index.ts']);
});

test('provider and MCP subprocess seams retain their explicit environment boundaries', () => {
  const account = source('runner/account-env.ts');
  const adapter = source('runner/claude-adapter.ts');
  assert.match(account, /buildChildEnvironment\(base\)/);
  assert.match(account, /env\.CLAUDE_CONFIG_DIR = configDir/);
  assert.doesNotMatch(account, /withoutAmbientGitRepositorySelectors|Object\.entries\(base\)/);
  assert.match(adapter, /env:\s*buildClaudeQueryEnvironment\(this\.config\.env\)/);
  assert.ok(
    count(adapter, /this\.accounts\.buildEnv\(this\.id,/g) >= 2,
    'discovery and session mint both start from the account-owned safe environment',
  );

  for (const relativePath of [
    'apps/server/src/mcp/client.ts',
    'packages/mcp/src/transport.ts',
  ]) {
    const mcp = readFileSync(join(REPO, ...relativePath.split('/')), 'utf8');
    assert.match(mcp, /getDefaultEnvironment/);
    assert.doesNotMatch(mcp, /process\.env/);
  }
});
