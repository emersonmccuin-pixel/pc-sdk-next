import { promises as fs } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const REPOSITORY_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SOURCE_EXTENSIONS = new Set(['.cjs', '.cts', '.js', '.jsx', '.mjs', '.mts', '.ts', '.tsx']);
const CHILD_PROCESS_IMPORT = /(?:\bfrom\s*|\brequire\s*\(\s*|\bimport\s*\(\s*|\bimport\s*)['"](?:node:)?child_process['"]/gu;
const MODULE_SPECIFIER = /(?:\bfrom\s*|\brequire\s*\(\s*|\bimport\s*\(\s*|\bimport\s*)['"]([^'"]+)['"]/gu;
const ALLOWED_DIRECT_PROCESS_IMPORTS = new Map([
  ['apps/server/src/dispatch/repository-lease.ts', 1],
  ['apps/server/src/dispatch/worktrees.ts', 1],
  ['apps/server/src/index.ts', 1],
  ['apps/server/src/runner/codex/app-server-client.ts', 1],
]);
const SEALED_COMPONENT_IMPORT_POLICY = new Map([
  ['packages/owner-lifecycle/src', [
    /^@anthropic-ai(?:\/|$)/u,
    /^@openai(?:\/|$)/u,
    /^@pc\/(?:app-services|db|domain|mcp|windows-containment)(?:\/|$)/u,
    /^@pc-sdk\/server(?:\/|$)/u,
  ]],
  ['packages/windows-containment/src', [
    /^@anthropic-ai(?:\/|$)/u,
    /^@openai(?:\/|$)/u,
    /^@pc\/(?:app-services|db|domain|mcp|owner-lifecycle)(?:\/|$)/u,
    /^@pc-sdk\/server(?:\/|$)/u,
  ]],
]);
const SEALED_COMPONENT_RELATIVE_IMPORT_POLICY = new Map([
  ['packages/owner-lifecycle/src', [
    'apps/server',
    'node_modules/@anthropic-ai',
    'node_modules/@openai',
    'packages/app-services',
    'packages/db',
    'packages/domain',
    'packages/mcp',
    'packages/windows-containment',
  ]],
  ['packages/windows-containment/src', [
    'apps/server',
    'node_modules/@anthropic-ai',
    'node_modules/@openai',
    'packages/app-services',
    'packages/db',
    'packages/domain',
    'packages/mcp',
    'packages/owner-lifecycle',
  ]],
]);

function toLogicalPath(absolutePath) {
  return path.relative(REPOSITORY_ROOT, absolutePath).split(path.sep).join('/');
}

function isPathWithin(candidate, root) {
  const relative = path.relative(root, candidate);
  return relative === '' || (
    relative !== '..'
    && !relative.startsWith(`..${path.sep}`)
    && !path.isAbsolute(relative)
  );
}

async function collectSourceFiles(directory) {
  let entries;
  try {
    entries = await fs.readdir(directory, { withFileTypes: true });
  } catch (error) {
    if (error?.code === 'ENOENT') return [];
    throw error;
  }
  entries.sort((left, right) => left.name < right.name ? -1 : left.name > right.name ? 1 : 0);
  const files = [];
  for (const entry of entries) {
    const absolutePath = path.join(directory, entry.name);
    if (entry.isSymbolicLink()) {
      throw new Error(`process boundary guard rejected symbolic source path ${toLogicalPath(absolutePath)}`);
    }
    if (entry.isDirectory()) {
      files.push(...await collectSourceFiles(absolutePath));
    } else if (entry.isFile() && SOURCE_EXTENSIONS.has(path.extname(entry.name))) {
      files.push(absolutePath);
    }
  }
  return files;
}

async function productionSourceFiles() {
  const files = [];
  for (const family of ['apps', 'packages']) {
    const familyRoot = path.join(REPOSITORY_ROOT, family);
    const packages = await fs.readdir(familyRoot, { withFileTypes: true });
    packages.sort((left, right) => left.name < right.name ? -1 : left.name > right.name ? 1 : 0);
    for (const entry of packages) {
      if (!entry.isDirectory() || entry.isSymbolicLink()) continue;
      files.push(...await collectSourceFiles(path.join(familyRoot, entry.name, 'src')));
    }
  }
  return files;
}

const files = await productionSourceFiles();
const observedDirectImports = new Map();
for (const absolutePath of files) {
  const logicalPath = toLogicalPath(absolutePath);
  const source = await fs.readFile(absolutePath, 'utf8');
  const count = [...source.matchAll(CHILD_PROCESS_IMPORT)].length;
  if (count !== 0) observedDirectImports.set(logicalPath, count);

  for (const [componentRoot, deniedPatterns] of SEALED_COMPONENT_IMPORT_POLICY) {
    if (logicalPath === componentRoot || logicalPath.startsWith(`${componentRoot}/`)) {
      for (const match of source.matchAll(MODULE_SPECIFIER)) {
        const specifier = match[1];
        const deniedRelativeRoots = SEALED_COMPONENT_RELATIVE_IMPORT_POLICY.get(componentRoot)
          .map((root) => path.join(REPOSITORY_ROOT, root));
        const resolvedRelative = specifier.startsWith('./') || specifier.startsWith('../')
          ? path.resolve(path.dirname(absolutePath), specifier)
          : undefined;
        if (
          deniedPatterns.some((pattern) => pattern.test(specifier))
          || (
            resolvedRelative !== undefined
            && deniedRelativeRoots.some((root) => isPathWithin(resolvedRelative, root))
          )
        ) {
          throw new Error(`${logicalPath} imports forbidden component ${JSON.stringify(specifier)}`);
        }
      }
    }
  }
}

if (
  observedDirectImports.size !== ALLOWED_DIRECT_PROCESS_IMPORTS.size ||
  [...ALLOWED_DIRECT_PROCESS_IMPORTS].some(
    ([logicalPath, count]) => observedDirectImports.get(logicalPath) !== count,
  )
) {
  throw new Error(
    `production child_process inventory drifted: ${JSON.stringify([...observedDirectImports])}`,
  );
}

process.stdout.write(`${JSON.stringify({
  action: 'process-boundaries-checked',
  directProductionEdges: [...observedDirectImports.keys()].sort(),
  providerNeutralComponents: [...SEALED_COMPONENT_IMPORT_POLICY.keys()].sort(),
})}\n`);
