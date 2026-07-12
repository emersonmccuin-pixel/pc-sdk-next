import { execFile } from 'node:child_process';
import {
  lstatSync,
  mkdirSync,
  readdirSync,
  realpathSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import {
  REPOSITORY_IDENTITY_PROTOCOL,
  type RepositoryIdentityReceipt,
} from '@pc/domain';
import Database from 'better-sqlite3';
import {
  acquireKernelWitness,
  closeKernelWitness,
  kernelWitnessDigest,
  type KernelWitness,
  type KernelWitnessKind,
} from '../operations/kernel-witness.ts';
import { withoutAmbientGitRepositorySelectors } from '../operations/git-environment.ts';

export const REPOSITORY_LEASE_FILE = '.pc-sdk-repository-lease.sqlite';
export const REPOSITORY_BOOTSTRAP_PENDING_FILE = '.pc-sdk-repository-bootstrap-pending';
const REPOSITORY_WITNESS_PREFIX = 'pc-sdk-repository';
const GIT_IDENTITY_TIMEOUT_MS = 30_000;

export type RepositoryLeaseErrorCode =
  | 'repository-occupied'
  | 'repository-unavailable'
  | 'repository-release-unavailable';

export type RepositoryCreationMode =
  | 'init-empty'
  | 'init-in-place'
  | 'attach-to-git';

type ProjectCreationClaim =
  | 'existing-repository'
  | 'empty-non-repository'
  | 'nonempty-non-repository';

export interface RepositoryLeaseReleaseReceipt {
  readonly status: 'released' | 'already-released';
  readonly identity: RepositoryIdentityReceipt;
  readonly lockPath: string;
}

/** Opaque live authority passed through app-owned repository mutation doors. */
export interface RepositoryLeaseGuard {
  readonly status: 'acquired';
  readonly identity: RepositoryIdentityReceipt;
  readonly projectDir: string;
  readonly lockPath: string;
  readonly witnessKind: KernelWitnessKind;
  readonly acquiredAt: number;
}

export interface RepositoryLeaseHandle extends RepositoryLeaseGuard {
  release(): Promise<RepositoryLeaseReleaseReceipt>;
}

interface AdmissionDatabase {
  pragma(source: string): unknown;
  exec(source: string): unknown;
  close(): void;
}

interface RepositoryLeaseOptions {
  openDatabase?: (path: string) => AdmissionDatabase;
  discoverIdentity?: (projectDir: string) => Promise<RepositoryIdentityReceipt>;
  bindWitness?: (prefix: string, identity: string) => Promise<KernelWitness>;
  inspectLeasePath?: (path: string) => void;
}

export interface RepositoryLeaseManagerOptions {
  discoverIdentity?: (projectDir: string) => Promise<RepositoryIdentityReceipt>;
  initializeRepository?: (cwd: string, hadProjectEntries: boolean) => Promise<void>;
}

interface GuardState {
  active: boolean;
}

interface RuntimeAdmission {
  /** Null means a native runtime may adopt either an existing repository or
   * bootstrap the cwd. A value is the authoritative project-create claim. */
  readonly creationClaim: ProjectCreationClaim | null;
  readonly promise: Promise<RepositoryLeaseHandle>;
}

const guardStates = new WeakMap<object, GuardState>();

export class RepositoryLeaseError extends Error {
  readonly name = 'RepositoryLeaseError';

  constructor(
    readonly code: RepositoryLeaseErrorCode,
    readonly projectDir: string,
    readonly identity: RepositoryIdentityReceipt | null,
    readonly lockPath: string | null,
    readonly reasonCode: string,
    cause?: unknown,
  ) {
    super(messageFor(code, projectDir, reasonCode), { cause });
  }
}

/**
 * Resolve the one physical local Git repository shared by a main checkout and
 * all of its linked worktrees. Failure is authority-unavailable, never a
 * reason to fall back to the caller's lexical path.
 */
export async function discoverRepositoryIdentity(
  projectDir: string,
): Promise<RepositoryIdentityReceipt> {
  if (typeof projectDir !== 'string' || projectDir.trim().length === 0) {
    throw Object.assign(new Error('repository path must not be empty'), {
      code: 'INVALID_REPOSITORY_PATH',
    });
  }
  const requested = realpathSync.native(resolve(projectDir));
  const common = await gitCommonDirectory(requested);
  const gitCommonDir = realpathSync.native(common);
  if (!lstatSync(gitCommonDir).isDirectory()) {
    throw Object.assign(new Error('Git common directory is not a directory'), {
      code: 'INVALID_GIT_COMMON_DIRECTORY',
    });
  }
  rejectPendingRepositoryBootstrap(gitCommonDir);
  return {
    protocol: REPOSITORY_IDENTITY_PROTOCOL,
    gitCommonDir,
    leaseKey: `sha256:${kernelWitnessDigest(gitCommonDir)}`,
  };
}

/** Resolve and require the selected project folder itself to be a Git
 * worktree root. Repository subdirectories share lease authority, but cannot
 * own sibling worktree storage without dirtying the enclosing checkout. */
export async function requireRepositoryWorktreeRoot(projectDir: string): Promise<string> {
  const requested = realRuntimeDirectory(projectDir);
  const topLevel = realRuntimeDirectory(await gitWorktreeTopLevel(requested));
  if (requested !== topLevel) {
    throw Object.assign(
      new Error(`project folder must be the repository worktree root: ${topLevel}`),
      { code: 'PROJECT_PATH_NOT_REPOSITORY_ROOT' },
    );
  }
  return topLevel;
}

/** Acquire one raw lifetime handle. Managers use this after local de-duplication. */
export async function acquireRepositoryLease(
  projectDir: string,
  expectedIdentity: RepositoryIdentityReceipt | null = null,
  options: RepositoryLeaseOptions = {},
): Promise<RepositoryLeaseHandle> {
  const requested = safeAbsolutePath(projectDir);
  const discover = options.discoverIdentity ?? discoverRepositoryIdentity;
  let identity: RepositoryIdentityReceipt;
  try {
    identity = await discover(projectDir);
    assertExpectedIdentity(identity, expectedIdentity);
  } catch (error) {
    throw asLeaseError(
      'repository-unavailable',
      requested,
      null,
      null,
      error,
    );
  }

  const lockPath = join(identity.gitCommonDir, REPOSITORY_LEASE_FILE);
  let witness: KernelWitness;
  try {
    witness = await (options.bindWitness ?? acquireKernelWitness)(
      REPOSITORY_WITNESS_PREFIX,
      identity.gitCommonDir,
    );
  } catch (error) {
    const reasonCode = errorCode(error);
    throw new RepositoryLeaseError(
      reasonCode === 'EADDRINUSE' ? 'repository-occupied' : 'repository-unavailable',
      requested,
      identity,
      lockPath,
      reasonCode,
      error,
    );
  }

  let database: AdmissionDatabase | null = null;
  try {
    (options.inspectLeasePath ?? rejectSymbolicLink)(lockPath);
    database = (options.openDatabase ?? defaultOpenDatabase)(lockPath);
    database.pragma('busy_timeout = 0');
    database.exec('BEGIN IMMEDIATE');

    // Re-resolve after both live witnesses are held. A project alias that was
    // retargeted during acquisition cannot authorize mutation in another repo.
    const confirmed = await discover(projectDir);
    assertIdentityEqual(confirmed, identity, 'REPOSITORY_IDENTITY_CHANGED');
    assertExpectedIdentity(confirmed, expectedIdentity);
  } catch (error) {
    try {
      database?.close();
    } catch {
      // No handle escapes a failed acquisition.
    }
    try {
      await closeKernelWitness(witness.server);
    } catch (closeError) {
      throw new RepositoryLeaseError(
        'repository-unavailable',
        requested,
        identity,
        lockPath,
        'WITNESS_RELEASE_FAILED',
        new AggregateError(
          [error, closeError],
          'failed repository acquisition left witness cleanup uncertain',
        ),
      );
    }
    const reasonCode = errorCode(error);
    throw new RepositoryLeaseError(
      isSqliteContentionCode(reasonCode)
        ? 'repository-occupied'
        : 'repository-unavailable',
      requested,
      identity,
      lockPath,
      reasonCode,
      error,
    );
  }

  const state: GuardState = { active: true };
  let held = true;
  let databaseClosed = false;
  let witnessClosed = false;
  let releaseInFlight: Promise<RepositoryLeaseReleaseReceipt> | null = null;
  const handle: RepositoryLeaseHandle = {
    status: 'acquired',
    identity,
    projectDir: requested,
    lockPath,
    witnessKind: witness.kind,
    acquiredAt: Date.now(),
    async release(): Promise<RepositoryLeaseReleaseReceipt> {
      if (!held) return { status: 'already-released', identity, lockPath };
      if (releaseInFlight) return releaseInFlight;

      // Invalidate synchronously before either witness closes. Once release
      // begins, this object can never authorize another mutation even when a
      // close later reports uncertainty.
      state.active = false;
      const attempt = (async (): Promise<RepositoryLeaseReleaseReceipt> => {
        try {
          // File authority closes first; a witness-close failure remains
          // fail-closed because the non-replaceable witness may still be live.
          if (!databaseClosed) {
            database!.close();
            databaseClosed = true;
          }
          if (!witnessClosed) {
            await closeKernelWitness(witness.server);
            witnessClosed = true;
          }
          held = false;
          return { status: 'released', identity, lockPath };
        } catch (error) {
          throw new RepositoryLeaseError(
            'repository-release-unavailable',
            requested,
            identity,
            lockPath,
            errorCode(error),
            error,
          );
        }
      })();
      releaseInFlight = attempt;
      try {
        return await attempt;
      } finally {
        releaseInFlight = null;
      }
    },
  };
  guardStates.set(handle, state);
  return handle;
}

/** Revalidate both an opaque live guard and the repository currently at path. */
export async function assertRepositoryLeaseGuard(
  guard: RepositoryLeaseGuard,
  projectDir: string,
  expectedIdentity: RepositoryIdentityReceipt | null = null,
): Promise<RepositoryIdentityReceipt> {
  const state = guardStates.get(guard as object);
  if (!state?.active) {
    throw new RepositoryLeaseError(
      'repository-unavailable',
      safeAbsolutePath(projectDir),
      guard?.identity ?? null,
      guard?.lockPath ?? null,
      'INACTIVE_REPOSITORY_GUARD',
    );
  }
  let current: RepositoryIdentityReceipt;
  try {
    current = await discoverRepositoryIdentity(projectDir);
    assertIdentityEqual(current, guard.identity, 'REPOSITORY_IDENTITY_CHANGED');
    assertExpectedIdentity(current, expectedIdentity);
  } catch (error) {
    if (error instanceof RepositoryLeaseError) throw error;
    throw asLeaseError(
      'repository-unavailable',
      safeAbsolutePath(projectDir),
      guard.identity,
      guard.lockPath,
      error,
    );
  }
  if (!state.active) {
    throw new RepositoryLeaseError(
      'repository-unavailable',
      safeAbsolutePath(projectDir),
      guard.identity,
      guard.lockPath,
      'INACTIVE_REPOSITORY_GUARD',
    );
  }
  return current;
}

/**
 * One engine-wide, re-entrant lease cache. Handles are deliberately retained
 * until process exit. `releaseAllForTesting` is not a production lifecycle
 * door; it exists so deterministic fixtures can prove controlled handoff and
 * remove temporary repositories without open SQLite handles.
 */
export class RepositoryLeaseManager {
  private readonly pending = new Map<string, Promise<RepositoryLeaseHandle>>();
  private readonly held = new Map<string, RepositoryLeaseHandle>();
  private readonly runtimeAdmissions = new Map<string, RuntimeAdmission>();
  private releasing = false;
  private releaseGeneration = 0;
  private releaseForTestingInFlight: Promise<RepositoryLeaseReleaseReceipt[]> | null = null;
  private poisoned: RepositoryLeaseError | null = null;

  constructor(private readonly options: RepositoryLeaseManagerOptions = {}) {}

  async acquire(
    projectDir: string,
    expectedIdentity: RepositoryIdentityReceipt | null = null,
  ): Promise<RepositoryLeaseGuard> {
    const releaseGeneration = this.releaseGeneration;
    if (this.poisoned) throw this.poisoned;
    if (this.releasing || this.releaseGeneration !== releaseGeneration) {
      throw new RepositoryLeaseError(
        'repository-unavailable',
        safeAbsolutePath(projectDir),
        expectedIdentity,
        null,
        'REPOSITORY_LEASE_MANAGER_RELEASING',
      );
    }

    let identity: RepositoryIdentityReceipt;
    try {
      identity = await this.discoverIdentity(projectDir);
      assertExpectedIdentity(identity, expectedIdentity);
    } catch (error) {
      throw asLeaseError(
        'repository-unavailable',
        safeAbsolutePath(projectDir),
        expectedIdentity,
        null,
        error,
      );
    }

    if (this.releasing || this.releaseGeneration !== releaseGeneration) {
      throw new RepositoryLeaseError(
        'repository-unavailable',
        safeAbsolutePath(projectDir),
        expectedIdentity,
        null,
        'REPOSITORY_LEASE_MANAGER_RELEASING',
      );
    }

    return this.acquireDiscovered(projectDir, identity, expectedIdentity);
  }

  /** Runtime cwd admission also closes the pre-repository transition. Project
   * creation deliberately defers `init-empty` / `init-in-place` scaffolding;
   * before the first native runtime can write, claim the future canonical
   * `<cwd>/.git` identity, initialize Git under that live authority, and then
   * verify that native Git resolves the exact anticipated common directory.
   * Existing repositories, including bare repositories, always use native
   * cwd-derived discovery directly. Ambient Git repository selectors are
   * scrubbed from every app-owned Git child. */
  async acquireForRuntimeCwd(
    projectDir: string,
    expectedIdentity: RepositoryIdentityReceipt | null = null,
  ): Promise<RepositoryLeaseGuard> {
    return this.acquireRuntimeCwd(projectDir, expectedIdentity, null);
  }

  /** Project creation must re-prove the modal's claimed folder state at the
   * mutation door. A stale `init-empty` can never import files, and an init
   * request can never silently attach a repository that appeared meanwhile. */
  async acquireForProjectCreation(
    projectDir: string,
    mode: RepositoryCreationMode,
  ): Promise<RepositoryLeaseGuard> {
    const creationClaim: ProjectCreationClaim = mode === 'attach-to-git'
      ? 'existing-repository'
      : mode === 'init-in-place'
        ? 'nonempty-non-repository'
        : 'empty-non-repository';
    return this.acquireRuntimeCwd(projectDir, null, creationClaim);
  }

  private async acquireRuntimeCwd(
    projectDir: string,
    expectedIdentity: RepositoryIdentityReceipt | null,
    creationClaim: ProjectCreationClaim | null,
  ): Promise<RepositoryLeaseGuard> {
    if (this.poisoned) throw this.poisoned;
    if (this.releasing) {
      throw new RepositoryLeaseError(
        'repository-unavailable',
        safeAbsolutePath(projectDir),
        expectedIdentity,
        null,
        'REPOSITORY_LEASE_MANAGER_RELEASING',
      );
    }

    if (typeof projectDir !== 'string' || projectDir.trim().length === 0) {
      throw new RepositoryLeaseError(
        'repository-unavailable',
        '<invalid-repository-path>',
        null,
        null,
        'INVALID_RUNTIME_CWD',
      );
    }

    let requested: string;
    try {
      requested = realRuntimeDirectory(projectDir);
    } catch (error) {
      throw asLeaseError(
        'repository-unavailable',
        safeAbsolutePath(projectDir),
        null,
        null,
        error,
      );
    }

    const existingAdmission = this.runtimeAdmissions.get(requested);
    if (existingAdmission) {
      if (
        creationClaim !== null &&
        existingAdmission.creationClaim !== creationClaim
      ) {
        throw asLeaseError(
          'repository-unavailable',
          requested,
          null,
          null,
          Object.assign(new Error('project creation state is already being admitted under a different claim'), {
            code: 'PROJECT_CREATION_MODE_CONFLICT',
          }),
        );
      }
      const guard = await existingAdmission.promise;
      await assertRepositoryLeaseGuard(guard, requested, expectedIdentity);
      return guard;
    }

    // Install the single-flight before the first asynchronous Git discovery.
    // Two same-engine calls on a fresh folder must not race each other to the
    // atomic `.git` transition and turn re-entrancy into typed unavailability.
    const admission: RuntimeAdmission = {
      creationClaim,
      promise: this.admitRuntimeCwd(requested, expectedIdentity, creationClaim),
    };
    this.runtimeAdmissions.set(requested, admission);
    try {
      const guard = await admission.promise;
      await assertRepositoryLeaseGuard(guard, requested, expectedIdentity);
      return guard;
    } finally {
      if (this.runtimeAdmissions.get(requested) === admission) {
        this.runtimeAdmissions.delete(requested);
      }
    }
  }

  private async admitRuntimeCwd(
    requested: string,
    expectedIdentity: RepositoryIdentityReceipt | null,
    creationClaim: ProjectCreationClaim | null,
  ): Promise<RepositoryLeaseHandle> {
    if (creationClaim === 'existing-repository') {
      try {
        if (!hasGitControlEntry(requested) && !hasBareGitControlEntry(requested)) {
          throw Object.assign(new Error('attach-to-git requires an existing repository'), {
            code: 'ATTACH_REPOSITORY_REQUIRED',
          });
        }
      } catch (error) {
        throw asLeaseError('repository-unavailable', requested, null, null, error);
      }
    }
    let discoveryError: unknown;
    try {
      const identity = await this.discoverIdentity(requested);
      assertExpectedIdentity(identity, expectedIdentity);
      if (creationClaim !== null && creationClaim !== 'existing-repository') {
        throw Object.assign(new Error('project initialization requires a non-repository folder'), {
          code: 'PROJECT_CREATION_REPOSITORY_APPEARED',
        });
      }
      return this.acquireDiscovered(requested, identity, expectedIdentity);
    } catch (error) {
      discoveryError = error;
    }

    try {
      if (
        creationClaim === 'existing-repository' ||
        expectedIdentity !== null ||
        errorCode(discoveryError) !== 'GIT_REV_PARSE_EXIT_128' ||
        hasGitControlEntry(requested) ||
        hasBareGitControlEntry(requested)
      ) {
        throw discoveryError;
      }
      if (dirname(requested) === requested) {
        throw Object.assign(new Error('refusing to initialize Git at a filesystem root'), {
          code: 'UNSAFE_RUNTIME_GIT_INIT_ROOT',
        });
      }
    } catch (error) {
      throw asLeaseError(
        'repository-unavailable',
        requested,
        null,
        null,
        error,
      );
    }

    const requiredProjectEntries = creationClaim === 'nonempty-non-repository'
      ? true
      : creationClaim === 'empty-non-repository'
        ? false
        : null;
    return this.initializeRuntimeRepository(requested, requiredProjectEntries);
  }

  private async acquireDiscovered(
    projectDir: string,
    identity: RepositoryIdentityReceipt,
    expectedIdentity: RepositoryIdentityReceipt | null,
  ): Promise<RepositoryLeaseHandle> {
    const existing = this.pending.get(identity.leaseKey);
    if (existing) {
      const handle = await existing;
      await assertRepositoryLeaseGuard(handle, projectDir, expectedIdentity);
      return handle;
    }

    const acquisition = acquireRepositoryLease(projectDir, identity)
      .then((handle) => {
        this.held.set(identity.leaseKey, handle);
        return handle;
      })
      .catch((error) => {
        if (this.pending.get(identity.leaseKey) === acquisition) {
          this.pending.delete(identity.leaseKey);
        }
        throw error;
      });
    this.pending.set(identity.leaseKey, acquisition);
    return acquisition;
  }

  private async initializeRuntimeRepository(
    requested: string,
    requiredProjectEntries: boolean | null = null,
  ): Promise<RepositoryLeaseHandle> {
    const anticipatedGitDir = join(requested, '.git');
    let hadProjectEntries: boolean;
    try {
      hadProjectEntries = inspectBootstrapTree(requested);
      if (
        requiredProjectEntries !== null &&
        hadProjectEntries !== requiredProjectEntries
      ) {
        throw Object.assign(
          new Error(requiredProjectEntries
            ? 'init-in-place requires a non-empty folder'
            : 'init-empty requires an empty folder'),
          { code: 'PROJECT_CREATION_FOLDER_STATE_CHANGED' },
        );
      }
      // Atomic directory creation is the pre-Git admission marker. A peer that
      // wins this race is never treated as a stale state that may be repaired.
      mkdirSync(anticipatedGitDir);
      writeFileSync(
        join(anticipatedGitDir, REPOSITORY_BOOTSTRAP_PENDING_FILE),
        `${REPOSITORY_IDENTITY_PROTOCOL}\n`,
        { encoding: 'utf8', flag: 'wx' },
      );
    } catch (error) {
      throw asLeaseError(
        'repository-unavailable',
        requested,
        null,
        null,
        error,
      );
    }

    const gitCommonDir = realpathSync.native(anticipatedGitDir);
    const identity: RepositoryIdentityReceipt = {
      protocol: REPOSITORY_IDENTITY_PROTOCOL,
      gitCommonDir,
      leaseKey: `sha256:${kernelWitnessDigest(gitCommonDir)}`,
    };
    let handle: RepositoryLeaseHandle | null = null;
    let acquisition!: Promise<RepositoryLeaseHandle>;
    acquisition = (async (): Promise<RepositoryLeaseHandle> => {
      try {
        handle = await acquireRepositoryLease(requested, identity, {
          discoverIdentity: async () => identity,
        });
        this.held.set(identity.leaseKey, handle);
        await (this.options.initializeRepository ?? initializeGitRepository)(
          requested,
          hadProjectEntries,
        );
        const confirmed = await this.discoverIdentity(requested);
        assertIdentityEqual(confirmed, identity, 'INITIALIZED_REPOSITORY_IDENTITY_MISMATCH');
        return handle;
      } catch (error) {
        // Once a witness was acquired it remains live until engine exit even
        // when initialization/verification fails. Ambiguous partial Git state
        // can never be taken over as a stale pre-repository marker.
        if (!handle && this.pending.get(identity.leaseKey) === acquisition) {
          this.pending.delete(identity.leaseKey);
        }
        throw asLeaseError(
          'repository-unavailable',
          requested,
          identity,
          join(gitCommonDir, REPOSITORY_LEASE_FILE),
          error,
        );
      }
    })();
    this.pending.set(identity.leaseKey, acquisition);
    return acquisition;
  }

  async assertHeld(
    guard: RepositoryLeaseGuard,
    projectDir: string,
    expectedIdentity: RepositoryIdentityReceipt | null = null,
  ): Promise<RepositoryIdentityReceipt> {
    return assertRepositoryLeaseGuard(guard, projectDir, expectedIdentity);
  }

  private discoverIdentity(projectDir: string): Promise<RepositoryIdentityReceipt> {
    return (this.options.discoverIdentity ?? discoverRepositoryIdentity)(projectDir);
  }

  /** Resolve the exact physical cwd that was just proven to belong to a live
   * guard. The shared re-entrant handle's `projectDir` records its first
   * acquisition and is not a substitute for a later caller's worktree or
   * subdirectory. Passing this canonical path to native runtime creation also
   * prevents a mutable filesystem alias from retargeting after admission. */
  async resolveHeldRuntimeCwd(
    guard: RepositoryLeaseGuard,
    projectDir: string,
    expectedIdentity: RepositoryIdentityReceipt | null = null,
  ): Promise<string> {
    let requested: string;
    try {
      requested = realRuntimeDirectory(projectDir);
    } catch (error) {
      throw asLeaseError(
        'repository-unavailable',
        safeAbsolutePath(projectDir),
        guard.identity,
        guard.lockPath,
        error,
      );
    }
    await assertRepositoryLeaseGuard(guard, requested, expectedIdentity);
    return requested;
  }

  releaseAllForTesting(): Promise<RepositoryLeaseReleaseReceipt[]> {
    if (this.releaseForTestingInFlight) return this.releaseForTestingInFlight;
    const attempt = this.releaseAllForTestingOnce();
    const shared = attempt.finally(() => {
      if (this.releaseForTestingInFlight === shared) {
        this.releaseForTestingInFlight = null;
      }
    });
    this.releaseForTestingInFlight = shared;
    return shared;
  }

  private async releaseAllForTestingOnce(): Promise<RepositoryLeaseReleaseReceipt[]> {
    if (this.releasing) {
      throw new RepositoryLeaseError(
        'repository-unavailable',
        '<repository-lease-manager>',
        null,
        null,
        'REPOSITORY_LEASE_MANAGER_RELEASING',
      );
    }
    this.releasing = true;
    this.releaseGeneration++;
    try {
      // Start every already-known handle release before the first await. The
      // runtime-admission map is installed before discovery, so waiting for its
      // snapshot also fences the pre-discovery window that used to escape a
      // controlled teardown and acquire after it returned.
      const admissionSnapshot = [...this.runtimeAdmissions.values()].map((entry) => entry.promise);
      const pendingSnapshot = [...this.pending.values()];
      const scheduled = new Set<RepositoryLeaseHandle>();
      const releases: Promise<RepositoryLeaseReleaseReceipt>[] = [];
      const scheduleRelease = (handle: RepositoryLeaseHandle): void => {
        if (scheduled.has(handle)) return;
        scheduled.add(handle);
        releases.push(handle.release());
      };
      for (const handle of this.held.values()) scheduleRelease(handle);
      this.runtimeAdmissions.clear();
      this.pending.clear();
      this.held.clear();

      const firstWave = await Promise.allSettled([
        ...new Set(admissionSnapshot),
        ...new Set(pendingSnapshot),
      ]);
      for (const result of firstWave) {
        if (result.status === 'fulfilled') scheduleRelease(result.value);
      }

      // Admissions can publish their identity-keyed pending/held handle after
      // the initial snapshots. No external caller can enter while `releasing`
      // remains true; settle and close this bounded late wave as well.
      const latePending = [...this.pending.values()];
      this.pending.clear();
      const lateWave = await Promise.allSettled([...new Set(latePending)]);
      for (const result of lateWave) {
        if (result.status === 'fulfilled') scheduleRelease(result.value);
      }
      for (const handle of this.held.values()) scheduleRelease(handle);
      this.held.clear();

      const settled = await Promise.allSettled(releases);
      const receipts = settled
        .filter((result): result is PromiseFulfilledResult<RepositoryLeaseReleaseReceipt> => result.status === 'fulfilled')
        .map((result) => result.value);
      const releaseFailures = settled
        .filter((result): result is PromiseRejectedResult => result.status === 'rejected')
        .map((result) => result.reason);
      if (releaseFailures.length > 0) {
        const error = new RepositoryLeaseError(
          'repository-release-unavailable',
          '<repository-lease-manager>',
          null,
          null,
          'REPOSITORY_RELEASE_FAILED',
          new AggregateError(
            releaseFailures,
            'one or more repository leases failed to release',
          ),
        );
        this.poisoned = error;
        throw error;
      }
      return receipts;
    } finally {
      this.releasing = false;
    }
  }
}

/** Production/default process-wide manager. */
export const repositoryLeaseManager = new RepositoryLeaseManager();

export function releaseAllRepositoryLeasesForTesting(): Promise<RepositoryLeaseReleaseReceipt[]> {
  return repositoryLeaseManager.releaseAllForTesting();
}

function defaultOpenDatabase(path: string): AdmissionDatabase {
  return new Database(path, { timeout: 0 });
}

function gitCommonDirectory(cwd: string): Promise<string> {
  return new Promise((resolveCommand, rejectCommand) => {
    execFile(
      'git',
      ['rev-parse', '--path-format=absolute', '--git-common-dir'],
      {
        cwd,
        env: withoutAmbientGitRepositorySelectors(),
        timeout: GIT_IDENTITY_TIMEOUT_MS,
        maxBuffer: 1024 * 1024,
        windowsHide: true,
      },
      (error, stdout, stderr) => {
        if (error) {
          rejectCommand(
            Object.assign(
              new Error(`cannot resolve Git common directory: ${String(stderr || stdout || '').trim()}`),
              { code: gitCommandFailureCode(error, 'GIT_REV_PARSE') },
            ),
          );
          return;
        }
        const value = String(stdout ?? '').trim();
        if (!value) {
          rejectCommand(
            Object.assign(new Error('Git returned an empty common directory'), {
              code: 'EMPTY_GIT_COMMON_DIRECTORY',
            }),
          );
          return;
        }
        resolveCommand(value);
      },
    );
  });
}

function gitWorktreeTopLevel(cwd: string): Promise<string> {
  return new Promise((resolveCommand, rejectCommand) => {
    execFile(
      'git',
      ['rev-parse', '--path-format=absolute', '--show-toplevel'],
      {
        cwd,
        env: withoutAmbientGitRepositorySelectors(),
        timeout: GIT_IDENTITY_TIMEOUT_MS,
        maxBuffer: 1024 * 1024,
        windowsHide: true,
      },
      (error, stdout, stderr) => {
        if (error) {
          rejectCommand(
            Object.assign(
              new Error(`cannot resolve Git worktree root: ${String(stderr || stdout || '').trim()}`),
              { code: gitCommandFailureCode(error, 'GIT_WORKTREE_ROOT') },
            ),
          );
          return;
        }
        const value = String(stdout ?? '').trim();
        if (!value) {
          rejectCommand(
            Object.assign(new Error('Git returned an empty worktree root'), {
              code: 'EMPTY_GIT_WORKTREE_ROOT',
            }),
          );
          return;
        }
        resolveCommand(value);
      },
    );
  });
}

async function initializeGitRepository(cwd: string, hadProjectEntries: boolean): Promise<void> {
  await runRequiredGit(cwd, ['init', '-b', 'main']);
  if (inspectBootstrapTree(cwd) !== hadProjectEntries) {
    throw Object.assign(new Error('repository contents changed during bootstrap admission'), {
      code: 'REPOSITORY_BOOTSTRAP_CONTENT_DRIFT',
    });
  }
  await runRequiredGit(cwd, ['add', '-A']);
  await runRequiredGit(cwd, [
    '-c',
    'user.name=PC-SDK',
    '-c',
    'user.email=pc-sdk@localhost',
    '-c',
    'commit.gpgSign=false',
    'commit',
    '--allow-empty',
    '--no-verify',
    '-m',
    hadProjectEntries ? 'Initial import' : 'Initial scaffold',
  ]);
  const status = await runRequiredGit(cwd, ['status', '--porcelain']);
  if (status.trim().length > 0) {
    throw Object.assign(new Error('initialized repository is not clean'), {
      code: 'INITIALIZED_REPOSITORY_DIRTY',
    });
  }
  unlinkSync(join(cwd, '.git', REPOSITORY_BOOTSTRAP_PENDING_FILE));
}

/** Inspect without following links/reparse aliases before `git add -A` can
 * import content. A project selected for init-in-place must never commit bytes
 * reached outside its physical root through a junction or symbolic link. */
function inspectBootstrapTree(root: string): boolean {
  const physicalRoot = realRuntimeDirectory(root);
  let hasEntries = false;
  const walk = (dir: string): void => {
    for (const name of readdirSync(dir)) {
      if (dir === physicalRoot && name === '.git') continue;
      if (name === '.git') {
        throw Object.assign(new Error(`repository bootstrap contains a nested Git control entry: ${join(dir, name)}`), {
          code: 'UNSAFE_REPOSITORY_BOOTSTRAP_NESTED_GIT',
        });
      }
      hasEntries = true;
      const path = join(dir, name);
      const stat = lstatSync(path);
      if (stat.isSymbolicLink()) {
        throw Object.assign(new Error(`repository bootstrap path is an alias: ${path}`), {
          code: 'UNSAFE_REPOSITORY_BOOTSTRAP_ALIAS',
        });
      }
      if (!stat.isDirectory()) continue;
      const physical = realpathSync.native(path);
      const fromRoot = relative(physicalRoot, physical);
      if (fromRoot === '..' || fromRoot.startsWith(`..${sep}`) || isAbsolute(fromRoot)) {
        throw Object.assign(new Error(`repository bootstrap directory escapes its root: ${path}`), {
          code: 'UNSAFE_REPOSITORY_BOOTSTRAP_ALIAS',
        });
      }
      walk(path);
    }
  };
  walk(physicalRoot);
  return hasEntries;
}

function rejectPendingRepositoryBootstrap(gitCommonDir: string): void {
  const marker = join(gitCommonDir, REPOSITORY_BOOTSTRAP_PENDING_FILE);
  try {
    lstatSync(marker);
    throw Object.assign(new Error('repository bootstrap is incomplete'), {
      code: 'REPOSITORY_BOOTSTRAP_INCOMPLETE',
    });
  } catch (error) {
    if (errorCode(error) === 'ENOENT') return;
    throw error;
  }
}

function runRequiredGit(cwd: string, args: string[]): Promise<string> {
  return new Promise((resolveCommand, rejectCommand) => {
    execFile(
      'git',
      args,
      {
        cwd,
        env: withoutAmbientGitRepositorySelectors(),
        timeout: GIT_IDENTITY_TIMEOUT_MS,
        maxBuffer: 1024 * 1024,
        windowsHide: true,
      },
      (error, stdout, stderr) => {
        if (error) {
          rejectCommand(
            Object.assign(
              new Error(`Git repository bootstrap failed: ${String(stderr || stdout || '').trim()}`),
              { code: gitCommandFailureCode(error, 'GIT_BOOTSTRAP') },
            ),
          );
          return;
        }
        resolveCommand(String(stdout ?? ''));
      },
    );
  });
}

function rejectSymbolicLink(path: string): void {
  try {
    if (lstatSync(path).isSymbolicLink()) {
      throw Object.assign(new Error('repository lease file must not be a symbolic link'), {
        code: 'SYMLINK_REPOSITORY_LEASE_FILE',
      });
    }
  } catch (error) {
    if (errorCode(error) === 'ENOENT') return;
    throw error;
  }
}

/** Positively classify an existing runtime cwd by walking its real ancestors.
 * Presence of any `.git` entry delegates all validity decisions to Git and the
 * canonical lease acquisition; only complete absence returns non-repository. */
function hasGitControlEntry(projectDir: string): boolean {
  const requested = realRuntimeDirectory(projectDir);
  let cursor = requested;
  while (true) {
    try {
      lstatSync(join(cursor, '.git'));
      return true;
    } catch (error) {
      if (errorCode(error) !== 'ENOENT') throw error;
    }
    const parent = dirname(cursor);
    if (parent === cursor) return false;
    cursor = parent;
  }
}

/** Fail closed on a bare repository (including one whose HEAD is corrupt) or
 * a partial bare control directory. Native `rev-parse` uses exit 128 both for
 * ordinary non-repositories and several corrupt-repository states, so absence
 * of a `.git` entry alone is not positive non-repository evidence. */
function hasBareGitControlEntry(projectDir: string): boolean {
  let cursor = realRuntimeDirectory(projectDir);
  while (true) {
    const head = pathKind(join(cursor, 'HEAD'));
    const objects = pathKind(join(cursor, 'objects'));
    const refs = pathKind(join(cursor, 'refs'));
    const config = pathKind(join(cursor, 'config'));
    const bareMarkers = [head, objects, refs, config]
      .filter((kind) => kind !== 'missing').length;
    if (bareMarkers >= 2) {
      return true;
    }
    const parent = dirname(cursor);
    if (parent === cursor) return false;
    cursor = parent;
  }
}

function pathKind(path: string): 'missing' | 'present' {
  try {
    lstatSync(path);
    return 'present';
  } catch (error) {
    if (errorCode(error) === 'ENOENT') return 'missing';
    throw error;
  }
}

function realRuntimeDirectory(projectDir: string): string {
  const requested = realpathSync.native(resolve(projectDir));
  if (!lstatSync(requested).isDirectory()) {
    throw Object.assign(new Error('runtime cwd is not a directory'), {
      code: 'INVALID_RUNTIME_CWD',
    });
  }
  return requested;
}

function gitCommandFailureCode(error: unknown, prefix: string): string {
  if (typeof error !== 'object' || error === null) return `${prefix}_UNKNOWN`;
  const detail = error as { code?: unknown; killed?: unknown; signal?: unknown };
  if (detail.killed === true || typeof detail.signal === 'string') {
    return `${prefix}_TERMINATED`;
  }
  if (typeof detail.code === 'number' && Number.isInteger(detail.code)) {
    return `${prefix}_EXIT_${detail.code}`;
  }
  if (typeof detail.code === 'string' && detail.code.length > 0) return detail.code;
  return `${prefix}_UNKNOWN`;
}

function assertExpectedIdentity(
  current: RepositoryIdentityReceipt,
  expected: RepositoryIdentityReceipt | null,
): void {
  if (!expected) return;
  assertIdentityEqual(current, expected, 'REPOSITORY_IDENTITY_MISMATCH');
}

function assertIdentityEqual(
  left: RepositoryIdentityReceipt,
  right: RepositoryIdentityReceipt,
  code: string,
): void {
  if (
    left.protocol !== right.protocol ||
    left.gitCommonDir !== right.gitCommonDir ||
    left.leaseKey !== right.leaseKey
  ) {
    throw Object.assign(new Error('repository identity does not match its immutable receipt'), {
      code,
    });
  }
}

function asLeaseError(
  code: RepositoryLeaseErrorCode,
  projectDir: string,
  identity: RepositoryIdentityReceipt | null,
  lockPath: string | null,
  error: unknown,
): RepositoryLeaseError {
  if (error instanceof RepositoryLeaseError) return error;
  return new RepositoryLeaseError(
    code,
    projectDir,
    identity,
    lockPath,
    errorCode(error),
    error,
  );
}

function safeAbsolutePath(path: string): string {
  try {
    return resolve(typeof path === 'string' ? path : '');
  } catch {
    return '<invalid-repository-path>';
  }
}

function errorCode(error: unknown): string {
  if (typeof error !== 'object' || error === null || !('code' in error)) return 'UNKNOWN';
  const value = (error as { code?: unknown }).code;
  return typeof value === 'string' && value.length > 0 ? value : 'UNKNOWN';
}

function isSqliteContentionCode(code: string): boolean {
  return code.startsWith('SQLITE_BUSY') || code.startsWith('SQLITE_LOCKED');
}

function messageFor(
  code: RepositoryLeaseErrorCode,
  projectDir: string,
  reasonCode: string,
): string {
  if (code === 'repository-occupied') {
    return `Another cooperating process currently owns repository "${projectDir}".`;
  }
  if (code === 'repository-release-unavailable') {
    return `PC-SDK could not positively release repository "${projectDir}" (${reasonCode}).`;
  }
  return `PC-SDK could not prove repository authority for "${projectDir}" (${reasonCode}).`;
}
