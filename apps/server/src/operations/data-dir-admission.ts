import { lstatSync, mkdirSync, realpathSync } from 'node:fs';
import { join, resolve } from 'node:path';
import Database from 'better-sqlite3';
import {
  acquireKernelWitness as bindKernelWitness,
  closeKernelWitness,
  type KernelWitness,
  type KernelWitnessKind,
} from './kernel-witness.ts';

export const DATA_DIRECTORY_ADMISSION_FILE = '.pc-sdk-next-admission.sqlite';
export const DATA_DIRECTORY_OCCUPIED_EXIT_CODE = 73;
export const DATA_DIRECTORY_UNAVAILABLE_EXIT_CODE = 74;
const MAX_OCCUPIED_WAIT_MS = 60_000;
const MAX_RETRY_INTERVAL_MS = 1_000;

export type DataDirectoryAdmissionErrorCode =
  | 'data-directory-occupied'
  | 'data-directory-unavailable'
  | 'data-directory-release-unavailable';

export interface DataDirectoryReleaseReceipt {
  status: 'released' | 'already-released';
  dataDir: string;
  lockPath: string;
}

export interface DataDirectoryAdmission {
  readonly status: 'acquired';
  readonly dataDir: string;
  readonly lockPath: string;
  readonly witnessKind: KernelWitnessKind;
  readonly acquiredAt: number;
  release(): Promise<DataDirectoryReleaseReceipt>;
}

interface AdmissionDatabase {
  pragma(source: string): unknown;
  exec(source: string): unknown;
  close(): void;
}

interface DataDirectoryAdmissionOptions {
  /** Restart-only failure bound. Every retry still requires positive lock
   * acquisition; elapsed time can only end in rejection, never success. */
  waitForOccupiedMs?: number;
  retryIntervalMs?: number;
  /** Observation hook for deterministic retry tests; never an ownership seam. */
  onOccupied?: (reasonCode: string) => void;
  /** Narrow dependency seam for deterministic open/permission failure tests. */
  openDatabase?: (path: string) => AdmissionDatabase;
}

/**
 * A closed operations error. `reasonCode` is diagnostic only: it never grants
 * takeover authority and it never attributes contention to a PC-SDK process.
 */
export class DataDirectoryAdmissionError extends Error {
  readonly name = 'DataDirectoryAdmissionError';

  constructor(
    readonly code: DataDirectoryAdmissionErrorCode,
    readonly dataDir: string,
    readonly lockPath: string | null,
    readonly reasonCode: string,
    cause?: unknown,
  ) {
    super(messageFor(code, dataDir, reasonCode), { cause });
  }
}

/**
 * Acquire exclusive engine ownership before the product DB is opened.
 *
 * A non-filesystem kernel witness closes POSIX pathname-replacement holes. A
 * dedicated SQLite connection then holds a zero-wait `BEGIN IMMEDIATE` in the
 * canonical directory. Both disappear on process death, so crash recovery does
 * not depend on PID reuse, a heartbeat, age, or a timeout.
 */
export async function acquireDataDirectoryAdmission(
  dataDir: string,
  options: DataDirectoryAdmissionOptions = {},
): Promise<DataDirectoryAdmission> {
  let canonicalDataDir: string;
  try {
    validateOptions(options);
    canonicalDataDir = canonicalizeDataDirectory(dataDir);
  } catch (error) {
    const requested = safeAbsolutePath(dataDir);
    throw new DataDirectoryAdmissionError(
      'data-directory-unavailable',
      requested,
      null,
      errorCode(error),
      error,
    );
  }

  const waitForOccupiedMs = options.waitForOccupiedMs ?? 0;
  const retryIntervalMs = options.retryIntervalMs ?? 25;
  const deadline = Date.now() + waitForOccupiedMs;
  while (true) {
    try {
      return await acquireOnce(canonicalDataDir, options.openDatabase);
    } catch (error) {
      if (
        !(error instanceof DataDirectoryAdmissionError) ||
        error.code !== 'data-directory-occupied' ||
        Date.now() >= deadline
      ) {
        throw error;
      }
      options.onOccupied?.(error.reasonCode);
      await delay(Math.min(retryIntervalMs, Math.max(1, deadline - Date.now())));
    }
  }
}

async function acquireOnce(
  canonicalDataDir: string,
  openDatabase: ((path: string) => AdmissionDatabase) | undefined,
): Promise<DataDirectoryAdmission> {
  const lockPath = join(canonicalDataDir, DATA_DIRECTORY_ADMISSION_FILE);
  let witness: KernelWitness;
  try {
    witness = await acquireKernelWitness(canonicalDataDir);
  } catch (error) {
    const reasonCode = errorCode(error);
    throw new DataDirectoryAdmissionError(
      isWitnessContentionCode(reasonCode)
        ? 'data-directory-occupied'
        : 'data-directory-unavailable',
      canonicalDataDir,
      lockPath,
      reasonCode,
      error,
    );
  }

  let database: AdmissionDatabase | null = null;
  try {
    rejectSymbolicLink(lockPath);
    database = (openDatabase ?? defaultOpenDatabase)(lockPath);
    database.pragma('busy_timeout = 0');
    database.exec('BEGIN IMMEDIATE');
  } catch (error) {
    try {
      database?.close();
    } catch {
      // The acquisition failed and no DB handle escapes.
    }
    try {
      await closeKernelWitness(witness.server);
    } catch (closeError) {
      throw new DataDirectoryAdmissionError(
        'data-directory-unavailable',
        canonicalDataDir,
        lockPath,
        'WITNESS_RELEASE_FAILED',
        new AggregateError([error, closeError], 'failed acquisition left witness cleanup uncertain'),
      );
    }
    const reasonCode = errorCode(error);
    throw new DataDirectoryAdmissionError(
      isSqliteContentionCode(reasonCode)
        ? 'data-directory-occupied'
        : 'data-directory-unavailable',
      canonicalDataDir,
      lockPath,
      reasonCode,
      error,
    );
  }

  const acquiredAt = Date.now();
  let held = true;
  return {
    status: 'acquired',
    dataDir: canonicalDataDir,
    lockPath,
    witnessKind: witness.kind,
    acquiredAt,
    async release(): Promise<DataDirectoryReleaseReceipt> {
      if (!held) {
        return { status: 'already-released', dataDir: canonicalDataDir, lockPath };
      }
      try {
        // Close file ownership before the non-replaceable witness. A witness
        // close failure therefore remains fail-closed rather than admitting a
        // successor while this handle reports uncertainty.
        database!.close();
        await closeKernelWitness(witness.server);
        held = false;
        return { status: 'released', dataDir: canonicalDataDir, lockPath };
      } catch (error) {
        throw new DataDirectoryAdmissionError(
          'data-directory-release-unavailable',
          canonicalDataDir,
          lockPath,
          errorCode(error),
          error,
        );
      }
    },
  };
}

async function acquireKernelWitness(canonicalDataDir: string): Promise<KernelWitness> {
  // Native realpath supplies the filesystem's canonical spelling for ordinary
  // Windows aliases while preserving distinct names inside a case-sensitive
  // directory. App-level lowercasing would incorrectly conflate the latter.
  try {
    return await bindKernelWitness('pc-sdk-next-data', canonicalDataDir);
  } catch (error) {
    // Preserve SF-001's public typed diagnostic at this seam even though the
    // shared primitive uses provider-neutral witness vocabulary internally.
    if (errorCode(error) === 'UNSUPPORTED_WITNESS_PLATFORM') {
      throw Object.assign(
        new Error(`data-directory admission is not implemented for ${process.platform}`, {
          cause: error,
        }),
        { code: 'UNSUPPORTED_ADMISSION_PLATFORM' },
      );
    }
    throw error;
  }
}

function defaultOpenDatabase(path: string): AdmissionDatabase {
  return new Database(path, { timeout: 0 });
}

function validateOptions(options: DataDirectoryAdmissionOptions): void {
  const wait = options.waitForOccupiedMs ?? 0;
  const retry = options.retryIntervalMs ?? 25;
  if (
    !Number.isSafeInteger(wait) ||
    wait < 0 ||
    wait > MAX_OCCUPIED_WAIT_MS ||
    !Number.isSafeInteger(retry) ||
    retry <= 0 ||
    retry > MAX_RETRY_INTERVAL_MS
  ) {
    throw Object.assign(new Error('invalid data-directory admission timing options'), {
      code: 'INVALID_ADMISSION_OPTIONS',
    });
  }
}

function canonicalizeDataDirectory(input: string): string {
  if (typeof input !== 'string' || input.trim().length === 0) {
    throw Object.assign(new Error('data directory must not be empty'), {
      code: 'INVALID_DATA_DIRECTORY',
    });
  }
  const absolute = resolve(input);
  mkdirSync(absolute, { recursive: true });
  return realpathSync.native(absolute);
}

function rejectSymbolicLink(path: string): void {
  try {
    if (lstatSync(path).isSymbolicLink()) {
      throw Object.assign(new Error('admission file must not be a symbolic link'), {
        code: 'SYMLINK_ADMISSION_FILE',
      });
    }
  } catch (error) {
    if (errorCode(error) === 'ENOENT') return;
    throw error;
  }
}

function safeAbsolutePath(input: string): string {
  try {
    return resolve(typeof input === 'string' ? input : '');
  } catch {
    return '<invalid-data-directory>';
  }
}

function errorCode(error: unknown): string {
  if (typeof error !== 'object' || error === null || !('code' in error)) return 'UNKNOWN';
  const value = (error as { code?: unknown }).code;
  return typeof value === 'string' && value.length > 0 ? value : 'UNKNOWN';
}

function isWitnessContentionCode(code: string): boolean {
  return code === 'EADDRINUSE';
}

function isSqliteContentionCode(code: string): boolean {
  return code.startsWith('SQLITE_BUSY') || code.startsWith('SQLITE_LOCKED');
}

function delay(ms: number): Promise<void> {
  return new Promise((resolveDelay) => setTimeout(resolveDelay, ms));
}

function messageFor(
  code: DataDirectoryAdmissionErrorCode,
  dataDir: string,
  reasonCode: string,
): string {
  if (code === 'data-directory-occupied') {
    return `Another process currently prevents exclusive ownership of data directory "${dataDir}".`;
  }
  if (code === 'data-directory-release-unavailable') {
    return `PC-SDK could not positively release data directory "${dataDir}" (${reasonCode}).`;
  }
  return `PC-SDK could not prove exclusive ownership of data directory "${dataDir}" (${reasonCode}).`;
}
