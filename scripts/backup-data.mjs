// Back up the PC-SDK data directory to a timestamped folder under
// %LOCALAPPDATA%\PC-SDK-Next\backups. Safe to run while the server is live:
// *.sqlite files are copied via better-sqlite3's backup API (WAL-safe),
// everything else is a plain file copy. WAL/SHM/journal sidecars are skipped
// since a consistent backup of the main file already captures their content.
import { createRequire } from 'node:module';
import { existsSync, mkdirSync, readdirSync, statSync } from 'node:fs';
import { copyFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';

const SIDECAR_RE = /\.sqlite-(wal|shm|journal)$/;

function findWorkspaceRoot(start) {
  let dir = resolve(start);
  while (true) {
    if (existsSync(join(dir, 'pnpm-workspace.yaml'))) return dir;
    const parent = dirname(dir);
    if (parent === dir) return start;
    dir = parent;
  }
}

function expandTilde(p) {
  if (p === '~') return homedir();
  if (p.startsWith('~/') || p.startsWith('~\\')) return join(homedir(), p.slice(2));
  return p;
}

/** Mirrors @pc/utils getDataDir: explicit arg > PC_DATA_DIR > workspace-root/data. */
function resolveSourceDir(argSource) {
  if (argSource) return resolve(expandTilde(argSource));
  const env = process.env.PC_DATA_DIR;
  if (env && env !== 'undefined') return expandTilde(env);
  return join(findWorkspaceRoot(process.cwd()), 'data');
}

// Resolve better-sqlite3 (native module) from apps/server's node_modules
// rather than requiring it as a root dependency of this script.
const appsServerDir = join(findWorkspaceRoot(process.cwd()), 'apps', 'server');
const requireFromServer = createRequire(join(appsServerDir, 'noop.cjs'));
const Database = requireFromServer('better-sqlite3');

async function backupSqliteFile(sourcePath, destPath) {
  const db = new Database(sourcePath, { readonly: true, fileMustExist: true });
  try {
    await db.backup(destPath);
  } finally {
    db.close();
  }
}

async function copyDir(sourceDir, destDir) {
  mkdirSync(destDir, { recursive: true });
  for (const name of readdirSync(sourceDir)) {
    if (SIDECAR_RE.test(name)) continue;
    const sourcePath = join(sourceDir, name);
    const destPath = join(destDir, name);
    const stat = statSync(sourcePath);
    if (stat.isDirectory()) {
      await copyDir(sourcePath, destPath);
    } else if (name.endsWith('.sqlite')) {
      await backupSqliteFile(sourcePath, destPath);
    } else {
      await copyFile(sourcePath, destPath);
    }
  }
}

async function main() {
  const sourceDir = resolveSourceDir(process.argv[2]);
  if (!existsSync(sourceDir)) {
    console.error(`Data directory not found: ${sourceDir}`);
    process.exit(1);
  }
  const localAppData = process.env.LOCALAPPDATA ?? join(homedir(), 'AppData', 'Local');
  const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
  const destDir = join(localAppData, 'PC-SDK-Next', 'backups', timestamp);

  await copyDir(sourceDir, destDir);
  console.log(`Backed up ${sourceDir} -> ${destDir}`);
}

main().catch((error) => {
  console.error('Backup failed:', error);
  process.exit(1);
});
