import { writeFileSync } from 'node:fs';
import {
  acquireDataDirectoryAdmission,
  DATA_DIRECTORY_OCCUPIED_EXIT_CODE,
  DATA_DIRECTORY_UNAVAILABLE_EXIT_CODE,
  DataDirectoryAdmissionError,
} from '../../src/operations/data-dir-admission.ts';

const dataDir = process.argv[2] ?? '';
const markerPath = process.argv[3]?.trim() || null;
const waitForOccupiedMs = Number(process.argv[4] ?? 0);

try {
  const admission = await acquireDataDirectoryAdmission(dataDir, { waitForOccupiedMs });
  if (markerPath) writeFileSync(markerPath, String(process.pid), 'utf8');
  writeMessage({
    kind: 'acquired',
    pid: process.pid,
    dataDir: admission.dataDir,
    lockPath: admission.lockPath,
  });

  let released = false;
  const release = async (): Promise<void> => {
    if (released) return;
    released = true;
    try {
      const receipt = await admission.release();
      writeMessage({ kind: receipt.status, pid: process.pid });
      process.exitCode = 0;
      process.stdin.destroy();
    } catch {
      writeMessage({ kind: 'failed', pid: process.pid, code: 'RELEASE_FAILED' });
      process.exitCode = 1;
      process.stdin.destroy();
    }
  };

  process.stdin.setEncoding('utf8');
  process.stdin.on('data', (chunk: string | Buffer) => {
    const text = typeof chunk === 'string' ? chunk : chunk.toString('utf8');
    if (text.split(/\r?\n/u).some((line) => line.trim() === 'release')) void release();
  });
  process.once('SIGINT', () => void release());
  process.once('SIGTERM', () => void release());
  process.stdin.resume();
} catch (error) {
  if (error instanceof DataDirectoryAdmissionError) {
    writeMessage({
      kind: 'rejected',
      pid: process.pid,
      code: error.code,
      dataDir: error.dataDir,
      reasonCode: error.reasonCode,
    });
    process.exitCode = error.code === 'data-directory-occupied'
      ? DATA_DIRECTORY_OCCUPIED_EXIT_CODE
      : DATA_DIRECTORY_UNAVAILABLE_EXIT_CODE;
  } else {
    writeMessage({ kind: 'failed', pid: process.pid, code: 'UNKNOWN' });
    process.exitCode = 1;
  }
}

function writeMessage(value: object): void {
  process.stdout.write(`${JSON.stringify(value)}\n`);
}
