import { writeFileSync } from 'node:fs';
import {
  RepositoryLeaseError,
  RepositoryLeaseManager,
} from '../../src/dispatch/repository-lease.ts';

const projectDir = process.argv[2] ?? '';
const markerPath = process.argv[3]?.trim() || null;
const admission = process.argv[4] === 'runtime' ? 'runtime' : 'repository';
const manager = new RepositoryLeaseManager();

try {
  const guard = admission === 'runtime'
    ? await manager.acquireForRuntimeCwd(projectDir)
    : await manager.acquire(projectDir);
  if (markerPath) writeFileSync(markerPath, String(process.pid), 'utf8');
  writeMessage({
    kind: 'acquired',
    pid: process.pid,
    dataDir: process.env.PC_DATA_DIR ?? null,
    projectDir,
    identity: guard.identity,
    lockPath: guard.lockPath,
    witnessKind: guard.witnessKind,
  });

  let releaseStarted = false;
  const release = async (): Promise<void> => {
    if (releaseStarted) return;
    releaseStarted = true;
    try {
      const receipts = await manager.releaseAllForTesting();
      writeMessage({
        kind: 'released',
        pid: process.pid,
        receiptStatuses: receipts.map((receipt) => receipt.status),
      });
      process.exitCode = 0;
    } catch (error) {
      writeMessage({
        kind: 'failed',
        pid: process.pid,
        code: error instanceof RepositoryLeaseError ? error.code : 'UNKNOWN',
      });
      process.exitCode = 1;
    } finally {
      process.stdin.destroy();
    }
  };

  process.stdin.setEncoding('utf8');
  process.stdin.on('data', (chunk: string | Buffer) => {
    const text = typeof chunk === 'string' ? chunk : chunk.toString('utf8');
    if (text.split(/\r?\n/u).some((line) => line.trim() === 'release')) {
      void release();
    }
  });
  process.once('SIGINT', () => void release());
  process.once('SIGTERM', () => void release());
  process.stdin.resume();
} catch (error) {
  if (error instanceof RepositoryLeaseError) {
    writeMessage({
      kind: 'rejected',
      pid: process.pid,
      dataDir: process.env.PC_DATA_DIR ?? null,
      projectDir,
      code: error.code,
      reasonCode: error.reasonCode,
      identity: error.identity,
      lockPath: error.lockPath,
      message: error.message,
    });
    process.exitCode = error.code === 'repository-occupied' ? 75 : 76;
  } else {
    writeMessage({ kind: 'failed', pid: process.pid, code: 'UNKNOWN' });
    process.exitCode = 1;
  }
}

function writeMessage(value: object): void {
  process.stdout.write(`${JSON.stringify(value)}\n`);
}
