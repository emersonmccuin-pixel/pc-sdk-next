import assert from 'node:assert/strict';
import { execFile, spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join, parse } from 'node:path';
import { fileURLToPath } from 'node:url';
import test, { type TestContext } from 'node:test';
import { ContractService } from '@pc/app-services';
import {
  createProject,
  getAgentRunRow,
  getProjectById,
  insertAgentRunRow,
  listActiveWorktrees,
  newId,
} from '@pc/db';
import type { RepositoryIdentityReceipt, ULID } from '@pc/domain';
import { seedStockAgents } from '../src/agents/seed.ts';
import { reconcileStrandedWorktreesAtBoot } from '../src/boot-recovery.ts';
import { DispatchService } from '../src/dispatch/service.ts';
import {
  provisionWorktree,
  sweepOrphanedWorktreeDirs,
  teardownWorktree,
  worktreesRoot,
} from '../src/dispatch/worktrees.ts';
import { FakeRuntime } from '../src/runner/fake-runtime.ts';
import {
  acquireRepositoryLease,
  assertRepositoryLeaseGuard,
  discoverRepositoryIdentity,
  REPOSITORY_BOOTSTRAP_PENDING_FILE,
  REPOSITORY_LEASE_FILE,
  RepositoryLeaseError,
  RepositoryLeaseManager,
  releaseAllRepositoryLeasesForTesting,
  type RepositoryLeaseHandle,
} from '../src/dispatch/repository-lease.ts';
import {
  freshDb,
  advanceTestAgentRunStatus,
  commitFile,
  newGitProject,
  TEST_RUNTIME_SELECTION,
  testAgentRunExecution,
} from './helpers.ts';
import { withRuntimeReceipt } from './runtime-fixtures.ts';

const FIXTURE = fileURLToPath(
  new URL('./fixtures/repository-lease-child.ts', import.meta.url),
);
const SERVER_DIR = fileURLToPath(new URL('..', import.meta.url));

interface ChildMessage {
  kind: 'acquired' | 'rejected' | 'released' | 'failed';
  pid: number;
  dataDir?: string | null;
  projectDir?: string;
  code?: string;
  reasonCode?: string;
  message?: string;
  identity?: RepositoryIdentityReceipt | null;
  lockPath?: string | null;
  witnessKind?: string;
  receiptStatuses?: string[];
}

test('canonical root, subdirectory, linked-worktree, and filesystem aliases converge on one re-entrant manager guard', async (t) => {
  const scope = new LeaseTestScope(t);
  const repo = await scope.createRepository('identity');
  const subdir = join(repo, 'nested', 'path');
  mkdirSync(subdir, { recursive: true });
  const linked = join(scope.root, 'identity-linked');
  await gitOk(['worktree', 'add', '--detach', linked, 'HEAD'], repo);

  const paths = [repo, subdir, join(repo, 'nested', '..')];
  const alias = join(scope.root, 'identity-alias');
  if (createDirectoryAlias(repo, alias, t)) paths.push(alias);

  const identities = await Promise.all(paths.map((path) => discoverRepositoryIdentity(path)));
  for (const identity of identities) assert.deepEqual(identity, identities[0]);
  assert.deepEqual(await discoverRepositoryIdentity(linked), identities[0]);

  const manager = scope.trackManager(new RepositoryLeaseManager());
  const guards = await Promise.all(
    [...paths, linked].map((path) => manager.acquire(path, identities[0]!)),
  );
  for (const guard of guards) {
    assert.strictEqual(guard, guards[0], 'one engine reuses one live authority object');
    assert.deepEqual(await manager.assertHeld(guard, repo, identities[0]!), identities[0]);
  }
  assert.equal(
    await manager.resolveHeldRuntimeCwd(guards.at(-1)!, linked, identities[0]!),
    realpathSync.native(linked),
    'a re-entrant guard resolves the current caller worktree, not its first acquisition path',
  );
  assert.equal(
    await manager.resolveHeldRuntimeCwd(guards[1]!, subdir, identities[0]!),
    realpathSync.native(subdir),
  );
  assert.equal(existsSync(guards[0]!.lockPath), true);
  assert.match(guards[0]!.identity.leaseKey, /^sha256:[a-f0-9]{64}$/u);
});

test('raw lease release is explicit, idempotent, and permits only a later positive handoff', async (t) => {
  const scope = new LeaseTestScope(t);
  const repo = await scope.createRepository('handoff');
  const identity = await discoverRepositoryIdentity(repo);
  const first = scope.trackHandle(await acquireRepositoryLease(repo, identity));

  await assert.rejects(
    acquireRepositoryLease(repo, identity),
    (error: unknown) =>
      error instanceof RepositoryLeaseError &&
      error.code === 'repository-occupied' &&
      error.reasonCode === 'EADDRINUSE' &&
      /cooperating process/u.test(error.message),
  );

  const checkingDuringRelease = assertRepositoryLeaseGuard(first, repo, identity);
  const concurrentRelease = await Promise.all([first.release(), first.release()]);
  assert.deepEqual(concurrentRelease.map((receipt) => receipt.status), ['released', 'released']);
  await assert.rejects(
    checkingDuringRelease,
    (error: unknown) =>
      error instanceof RepositoryLeaseError &&
      error.code === 'repository-unavailable' &&
      error.reasonCode === 'INACTIVE_REPOSITORY_GUARD',
  );
  assert.equal((await first.release()).status, 'already-released');
  await assert.rejects(
    assertRepositoryLeaseGuard(first, repo, identity),
    (error: unknown) =>
      error instanceof RepositoryLeaseError &&
      error.code === 'repository-unavailable' &&
      error.reasonCode === 'INACTIVE_REPOSITORY_GUARD',
  );

  const successor = scope.trackHandle(await acquireRepositoryLease(repo, identity));
  assert.equal(successor.status, 'acquired');
  assert.deepEqual(successor.identity, identity);
  assert.equal((await successor.release()).status, 'released');
});

test('immutable expected identity rejects retargeting before a second repository is touched', async (t) => {
  const scope = new LeaseTestScope(t);
  const firstRepo = await scope.createRepository('expected-first');
  const secondRepo = await scope.createRepository('expected-second');
  const expected = await discoverRepositoryIdentity(firstRepo);
  const secondIdentity = await discoverRepositoryIdentity(secondRepo);
  const secondLockPath = join(secondIdentity.gitCommonDir, REPOSITORY_LEASE_FILE);

  await assert.rejects(
    acquireRepositoryLease(secondRepo, expected),
    (error: unknown) =>
      error instanceof RepositoryLeaseError &&
      error.code === 'repository-unavailable' &&
      error.reasonCode === 'REPOSITORY_IDENTITY_MISMATCH',
  );
  assert.equal(existsSync(secondLockPath), false, 'mismatched identity creates no lease state');

  const first = scope.trackHandle(await acquireRepositoryLease(firstRepo, expected));
  await assert.rejects(
    assertRepositoryLeaseGuard(first, secondRepo, expected),
    (error: unknown) =>
      error instanceof RepositoryLeaseError &&
      error.code === 'repository-unavailable' &&
      error.reasonCode === 'REPOSITORY_IDENTITY_CHANGED',
  );
});

test('corrupt, symlinked, denied, missing, and non-repository state fail closed without repair', async (t) => {
  const scope = new LeaseTestScope(t);
  const repo = await scope.createRepository('fail-closed');
  const identity = await discoverRepositoryIdentity(repo);
  const lockPath = join(identity.gitCommonDir, REPOSITORY_LEASE_FILE);

  writeFileSync(lockPath, 'not sqlite', 'utf8');
  await assert.rejects(
    acquireRepositoryLease(repo, identity),
    (error: unknown) =>
      error instanceof RepositoryLeaseError &&
      error.code === 'repository-unavailable' &&
      error.reasonCode === 'SQLITE_NOTADB',
  );
  assert.equal(readFileSync(lockPath, 'utf8'), 'not sqlite', 'corrupt authority is not repaired');
  rmSync(lockPath, { force: true });

  await assert.rejects(
    acquireRepositoryLease(repo, identity, {
      openDatabase: () => {
        throw Object.assign(new Error('injected permission denial'), { code: 'EACCES' });
      },
    }),
    (error: unknown) =>
      error instanceof RepositoryLeaseError &&
      error.code === 'repository-unavailable' &&
      error.reasonCode === 'EACCES',
  );
  assert.equal(existsSync(lockPath), false);
  const afterDenied = scope.trackHandle(await acquireRepositoryLease(repo, identity));
  await afterDenied.release();
  rmSync(lockPath, { force: true });

  const symlinkTarget = join(scope.root, 'lease-symlink-target');
  writeFileSync(symlinkTarget, 'do not touch', 'utf8');
  await assert.rejects(
    acquireRepositoryLease(repo, identity, {
      inspectLeasePath: () => {
        throw Object.assign(new Error('injected symlink lease state'), {
          code: 'SYMLINK_REPOSITORY_LEASE_FILE',
        });
      },
    }),
    (error: unknown) =>
      error instanceof RepositoryLeaseError &&
      error.code === 'repository-unavailable' &&
      error.reasonCode === 'SYMLINK_REPOSITORY_LEASE_FILE',
  );
  assert.equal(existsSync(lockPath), false, 'rejected symlink state creates no lease file');
  if (createFileAlias(symlinkTarget, lockPath, t)) {
    await assert.rejects(
      acquireRepositoryLease(repo, identity),
      (error: unknown) =>
        error instanceof RepositoryLeaseError &&
        error.code === 'repository-unavailable' &&
        error.reasonCode === 'SYMLINK_REPOSITORY_LEASE_FILE',
    );
    assert.equal(readFileSync(symlinkTarget, 'utf8'), 'do not touch');
    rmSync(lockPath, { force: true });
  }

  const missing = join(scope.root, 'missing-repository');
  await assert.rejects(
    acquireRepositoryLease(missing),
    (error: unknown) =>
      error instanceof RepositoryLeaseError && error.code === 'repository-unavailable',
  );
  const notRepo = join(scope.root, 'not-a-repository');
  mkdirSync(notRepo);
  await assert.rejects(
    acquireRepositoryLease(notRepo),
    (error: unknown) =>
      error instanceof RepositoryLeaseError && error.code === 'repository-unavailable',
  );

  const runtimeManager = scope.trackManager(new RepositoryLeaseManager());
  const [initialized, sameEngine] = await Promise.all([
    runtimeManager.acquireForRuntimeCwd(notRepo),
    runtimeManager.acquireForRuntimeCwd(notRepo),
  ]);
  assert.strictEqual(sameEngine, initialized, 'same-engine fresh runtime admission is single-flight');
  const initializedIdentity = await discoverRepositoryIdentity(notRepo);
  assert.deepEqual(
    initialized.identity,
    initializedIdentity,
    'deferred non-Git project scaffolding initializes under its future canonical authority',
  );
  assert.equal(existsSync(join(notRepo, '.git', 'HEAD')), true);
  assert.equal(await gitOutput(['log', '-1', '--format=%s'], notRepo), 'Initial scaffold');
  assert.equal(await gitOutput(['status', '--porcelain'], notRepo), '');
  assert.equal(existsSync(join(notRepo, '.git', REPOSITORY_BOOTSTRAP_PENDING_FILE)), false);
  await assert.rejects(
    runtimeManager.acquireForRuntimeCwd(missing),
    (error: unknown) =>
      error instanceof RepositoryLeaseError && error.code === 'repository-unavailable',
    'a missing runtime cwd is authority-unavailable, not non-Git',
  );
  const brokenRepo = join(scope.root, 'broken-repository');
  mkdirSync(brokenRepo);
  writeFileSync(join(brokenRepo, '.git'), 'gitdir: missing-control-dir\n', 'utf8');
  await assert.rejects(
    runtimeManager.acquireForRuntimeCwd(brokenRepo),
    (error: unknown) =>
      error instanceof RepositoryLeaseError && error.code === 'repository-unavailable',
    'a positively identified but corrupt Git cwd fails closed',
  );
  assert.equal(
    (await runtimeManager.acquireForRuntimeCwd(repo))?.identity.leaseKey,
    identity.leaseKey,
    'a Git-backed runtime cwd acquires the canonical repository lease',
  );

  await assert.rejects(
    runtimeManager.acquireForRuntimeCwd('   '),
    (error: unknown) =>
      error instanceof RepositoryLeaseError && error.reasonCode === 'INVALID_RUNTIME_CWD',
  );
  const filesystemRoot = parse(scope.root).root;
  const rootMarkerBefore = existsSync(join(filesystemRoot, '.git'));
  await assert.rejects(
    runtimeManager.acquireForRuntimeCwd(filesystemRoot),
    (error: unknown) =>
      error instanceof RepositoryLeaseError && error.code === 'repository-unavailable',
  );
  assert.equal(existsSync(join(filesystemRoot, '.git')), rootMarkerBefore);
});

test('deferred init-in-place creates a clean initial import that can provision a worktree', async (t) => {
  freshDb();
  const scope = new LeaseTestScope(t);
  const projectDir = join(scope.root, 'initial-import');
  mkdirSync(projectDir);
  writeFileSync(join(projectDir, 'seed.txt'), 'seed\n', 'utf8');
  const manager = scope.trackManager(new RepositoryLeaseManager());
  const guard = await manager.acquireForRuntimeCwd(projectDir);
  assert.equal(await gitOutput(['log', '-1', '--format=%s'], projectDir), 'Initial import');
  assert.equal(await gitOutput(['ls-files'], projectDir), 'seed.txt');
  assert.equal(await gitOutput(['status', '--porcelain'], projectDir), '');
  await manager.releaseAllForTesting();

  const provisioned = await provisionWorktree(projectDir, newId(), {
    expectedIdentity: guard.identity,
  });
  assert.equal(provisioned.ok, true, provisioned.ok ? '' : provisioned.error);
  if (provisioned.ok) {
    assert.equal(
      await teardownWorktree(projectDir, provisioned.dir, [], guard.identity),
      true,
    );
  }
  await releaseAllRepositoryLeasesForTesting();
});

test('conflicting attach and init creation claims cannot both cross one cwd transition', async (t) => {
  const scope = new LeaseTestScope(t);
  const projectDir = join(scope.root, 'conflicting-creation-claims');
  mkdirSync(projectDir);
  const manager = scope.trackManager(new RepositoryLeaseManager());

  const [attach, initialize] = await Promise.allSettled([
    manager.acquireForProjectCreation(projectDir, 'attach-to-git'),
    manager.acquireForProjectCreation(projectDir, 'init-empty'),
  ]);
  assert.equal(
    [attach, initialize].filter((result) => result.status === 'fulfilled').length,
    0,
    'conflicting simultaneous claims fail closed instead of silently changing modes',
  );
  assert.equal(existsSync(join(projectDir, '.git')), false);

  const initialized = await manager.acquireForProjectCreation(projectDir, 'init-empty');
  const attached = await manager.acquireForProjectCreation(projectDir, 'attach-to-git');
  assert.strictEqual(attached, initialized, 'a later explicit attach may reuse the proven repository');
  assert.equal(await gitOutput(['log', '-1', '--format=%s'], projectDir), 'Initial scaffold');
});

test('deferred bootstrap rejects filesystem aliases before importing outside content', async (t) => {
  const scope = new LeaseTestScope(t);
  const projectDir = join(scope.root, 'unsafe-import');
  const outside = join(scope.root, 'outside-import');
  mkdirSync(projectDir);
  mkdirSync(outside);
  writeFileSync(join(outside, 'secret.txt'), 'outside secret\n', 'utf8');
  const alias = join(projectDir, 'linked');
  if (!createDirectoryAlias(outside, alias, t)) return;
  const manager = new RepositoryLeaseManager();
  await assert.rejects(
    manager.acquireForRuntimeCwd(projectDir),
    (error: unknown) =>
      error instanceof RepositoryLeaseError &&
      error.reasonCode === 'UNSAFE_REPOSITORY_BOOTSTRAP_ALIAS',
  );
  assert.equal(existsSync(join(projectDir, '.git')), false);
});

test('incomplete or partial bare repositories never become nested worktree repositories', async (t) => {
  const scope = new LeaseTestScope(t);
  for (const name of ['corrupt-bare.git', 'partial-bare.git']) {
    const bare = join(scope.root, name);
    mkdirSync(bare);
    await gitOk(['init', '--bare'], bare);
    if (name.startsWith('corrupt')) {
      writeFileSync(join(bare, 'HEAD'), 'not a valid ref\n', 'utf8');
    } else {
      rmSync(join(bare, 'HEAD'), { force: true });
      rmSync(join(bare, 'config'), { force: true });
    }
    const manager = new RepositoryLeaseManager();
    await assert.rejects(
      manager.acquireForRuntimeCwd(bare),
      (error: unknown) =>
        error instanceof RepositoryLeaseError && error.code === 'repository-unavailable',
    );
    assert.equal(existsSync(join(bare, '.git')), false, `${name} was not nested-initialized`);
  }
});

test('a durable pending marker fences crash-after-init until explicit repair', async (t) => {
  const scope = new LeaseTestScope(t);
  const projectDir = join(scope.root, 'crash-after-init');
  mkdirSync(projectDir);
  const manager = scope.trackManager(new RepositoryLeaseManager({
    initializeRepository: async (cwd) => {
      await gitOk(['init', '-b', 'main'], cwd);
      throw Object.assign(new Error('simulated bootstrap crash'), { code: 'SIMULATED_BOOTSTRAP_CRASH' });
    },
  }));
  await assert.rejects(
    manager.acquireForRuntimeCwd(projectDir),
    (error: unknown) =>
      error instanceof RepositoryLeaseError && error.reasonCode === 'SIMULATED_BOOTSTRAP_CRASH',
  );
  assert.equal(existsSync(join(projectDir, '.git', REPOSITORY_BOOTSTRAP_PENDING_FILE)), true);
  const successor = new RepositoryLeaseManager();
  await assert.rejects(
    successor.acquireForRuntimeCwd(projectDir),
    (error: unknown) =>
      error instanceof RepositoryLeaseError && error.reasonCode === 'REPOSITORY_BOOTSTRAP_INCOMPLETE',
  );
  const receipts = await manager.releaseAllForTesting();
  assert.deepEqual(receipts.map((receipt) => receipt.status), ['released']);
});

test('controlled release fences runtime admission still waiting on discovery', async (t) => {
  const scope = new LeaseTestScope(t);
  const repo = await scope.createRepository('release-discovery-race');
  let resolveDiscovery!: () => void;
  const discoveryGate = new Promise<void>((resolve) => { resolveDiscovery = resolve; });
  let delayed = true;
  const manager = scope.trackManager(new RepositoryLeaseManager({
    discoverIdentity: async (projectDir) => {
      if (delayed) {
        delayed = false;
        await discoveryGate;
      }
      return discoverRepositoryIdentity(projectDir);
    },
  }));
  const admission = manager.acquireForRuntimeCwd(repo);
  const release = manager.releaseAllForTesting();
  resolveDiscovery();
  const [admissionResult, receipts] = await Promise.all([
    admission.then(
      (guard) => ({ status: 'fulfilled' as const, guard }),
      (error: unknown) => ({ status: 'rejected' as const, error }),
    ),
    release,
  ]);
  assert.equal(admissionResult.status, 'rejected');
  if (admissionResult.status === 'rejected') {
    assert.equal(admissionResult.error instanceof RepositoryLeaseError, true);
  }
  assert.equal(receipts.some((receipt) => receipt.status === 'released'), true);
  const successor = scope.trackHandle(await acquireRepositoryLease(repo));
  await successor.release();
});

test('competing runtime admission initializes a deferred non-Git project once and admits only one engine', async (t) => {
  const scope = new LeaseTestScope(t);
  const projectDir = join(scope.root, 'deferred-runtime-project');
  mkdirSync(projectDir);

  const first = scope.spawnChild(projectDir, '', 'runtime');
  const second = scope.spawnChild(projectDir, '', 'runtime');
  const messages = await Promise.all([first.firstMessage, second.firstMessage]);
  const winners = messages
    .map((message, index) => ({ message, child: index === 0 ? first : second }))
    .filter(({ message }) => message.kind === 'acquired');
  const losers = messages.filter((message) => message.kind !== 'acquired');

  assert.equal(winners.length, 1, JSON.stringify(messages));
  assert.equal(losers.length, 1, JSON.stringify(messages));
  assert.equal(
    losers[0]?.code === 'repository-occupied' || losers[0]?.code === 'repository-unavailable',
    true,
    JSON.stringify(messages),
  );
  assert.equal(existsSync(join(projectDir, '.git', 'HEAD')), true);
  const identity = await discoverRepositoryIdentity(projectDir);
  assert.deepEqual(winners[0]?.message.identity, identity);

  await winners[0]!.child.release();
  const successor = scope.spawnChild(projectDir, '', 'runtime');
  assert.equal((await successor.firstMessage).kind, 'acquired');
  await successor.release();
});

test('runtime admission honors bare repositories and ignores ambient Git selector redirection', async (t) => {
  const scope = new LeaseTestScope(t);
  const bare = join(scope.root, 'native-bare.git');
  mkdirSync(bare);
  await gitOk(['init', '--bare'], bare);
  const manager = scope.trackManager(new RepositoryLeaseManager());
  const bareGuard = await manager.acquireForRuntimeCwd(bare);
  assert.deepEqual(bareGuard.identity, await discoverRepositoryIdentity(bare));
  assert.equal(existsSync(join(bare, '.git')), false);

  const selected = await scope.createRepository('git-dir-selected');
  const selectedHead = await gitOutput(['rev-parse', 'HEAD'], selected);
  const runtimeCwd = join(scope.root, 'git-dir-runtime-cwd');
  mkdirSync(runtimeCwd);
  const child = scope.spawnChild(
    runtimeCwd,
    '',
    'runtime',
    join(selected, '.git'),
  );
  const message = await child.firstMessage;
  assert.equal(message.kind, 'acquired');
  assert.deepEqual(message.identity, await discoverRepositoryIdentity(runtimeCwd));
  assert.equal(existsSync(join(runtimeCwd, '.git')), true);
  assert.equal(await gitOutput(['rev-parse', 'HEAD'], selected), selectedHead);
  assert.equal(await gitOutput(['status', '--porcelain'], selected), '');
  assert.equal(existsSync(join(selected, '.git', REPOSITORY_LEASE_FILE)), false);
  await child.release();

  const whitespaceCwd = join(scope.root, 'whitespace-git-dir-cwd');
  mkdirSync(whitespaceCwd);
  const whitespace = scope.spawnChild(whitespaceCwd, '', 'runtime', ' ');
  const whitespaceMessage = await whitespace.firstMessage;
  assert.equal(whitespaceMessage.kind, 'acquired');
  assert.deepEqual(
    whitespaceMessage.identity,
    await discoverRepositoryIdentity(whitespaceCwd),
  );
  assert.equal(existsSync(join(whitespaceCwd, '.git')), true);
  await whitespace.release();
});

test('a symlink or junction worktree root cannot redirect provision or orphan deletion', async (t) => {
  freshDb();
  const scope = new LeaseTestScope(t);
  const gp = await newGitProject('aliased-worktree-root');
  const outside = join(scope.root, 'outside-worktree-root');
  const orphan = join(outside, 'looks-orphaned');
  const sentinel = join(orphan, 'sentinel.txt');
  mkdirSync(orphan, { recursive: true });
  writeFileSync(sentinel, 'preserve me', 'utf8');
  const aliasRoot = worktreesRoot(gp.dir);

  try {
    if (!createDirectoryAlias(outside, aliasRoot, t)) {
      t.skip('filesystem directory aliases are unavailable on this host');
      return;
    }
    const provisioned = await provisionWorktree(gp.dir, newId(), {
      projectId: gp.project.id,
    });
    assert.equal(provisioned.ok, false);
    if (provisioned.ok) assert.fail('provision unexpectedly followed an aliased root');
    assert.match(provisioned.error, /worktree root is not a real owned directory/u);
    assert.deepEqual(await sweepOrphanedWorktreeDirs(gp.dir), []);
    assert.equal(readFileSync(sentinel, 'utf8'), 'preserve me');
  } finally {
    await releaseAllRepositoryLeasesForTesting();
    rmSync(aliasRoot, { recursive: true, force: true });
    await gp.cleanup();
  }
});

test('real cooperating processes with distinct data directories exclude every common-dir alias while distinct repositories coexist', async (t) => {
  const scope = new LeaseTestScope(t);
  const repo = await scope.createRepository('process-shared');
  const otherRepo = await scope.createRepository('process-distinct');
  const subdir = join(repo, 'subdir');
  mkdirSync(subdir);
  const linked = join(scope.root, 'process-linked');
  await gitOk(['worktree', 'add', '--detach', linked, 'HEAD'], repo);
  const alias = join(scope.root, 'process-alias');
  const hasAlias = createDirectoryAlias(repo, alias, t);

  const holderMarker = join(scope.root, 'holder.marker');
  const holder = scope.spawnChild(repo, holderMarker);
  const acquired = await holder.firstMessage;
  assert.equal(acquired.kind, 'acquired');
  assert.equal(existsSync(holderMarker), true);

  for (const [index, path] of [subdir, linked, ...(hasAlias ? [alias] : [])].entries()) {
    const loserMarker = join(scope.root, `loser-${index}.marker`);
    const loser = scope.spawnChild(path, loserMarker);
    const rejected = await loser.firstMessage;
    assert.equal(rejected.kind, 'rejected');
    assert.equal(rejected.code, 'repository-occupied');
    assert.equal(rejected.reasonCode, 'EADDRINUSE');
    assert.equal(existsSync(loserMarker), false, 'loser performs no admitted side effect');
    assert.notEqual(rejected.dataDir, acquired.dataDir, 'fixtures use distinct app data dirs');
    assert.notEqual(await loser.exitCode, 0);
  }

  const distinct = scope.spawnChild(otherRepo, join(scope.root, 'distinct.marker'));
  const distinctAcquired = await distinct.firstMessage;
  assert.equal(distinctAcquired.kind, 'acquired');
  assert.notEqual(distinctAcquired.identity?.leaseKey, acquired.identity?.leaseKey);
  await distinct.release();

  await holder.release();
  const successor = scope.spawnChild(repo, join(scope.root, 'handoff-successor.marker'));
  assert.equal((await successor.firstMessage).kind, 'acquired');
  await successor.release();
});

test('hard-kill releases a holder with no escaped child and simultaneous successors admit exactly one', async (t) => {
  // Deliberate SF-002 boundary: this fixture owns no repository mutation child.
  // A child that escaped the killed server, and the non-participating stable
  // PC-SDK, remain explicitly outside this cooperative lease proof.
  const scope = new LeaseTestScope(t);
  const repo = await scope.createRepository('crash');
  const holder = scope.spawnChild(repo, join(scope.root, 'crash-holder.marker'));
  assert.equal((await holder.firstMessage).kind, 'acquired');
  await holder.killHard();

  const first = scope.spawnChild(repo, join(scope.root, 'successor-first.marker'));
  const second = scope.spawnChild(repo, join(scope.root, 'successor-second.marker'));
  const messages = await Promise.all([first.firstMessage, second.firstMessage]);
  assert.deepEqual(
    messages.map((message) => message.kind).sort(),
    ['acquired', 'rejected'],
  );

  const winner = messages[0]!.kind === 'acquired' ? first : second;
  const loser = winner === first ? second : first;
  const loserMessage = messages[winner === first ? 1 : 0]!;
  assert.equal(loserMessage.code, 'repository-occupied');
  assert.notEqual(await loser.exitCode, 0);
  await winner.release();

  const final = scope.trackHandle(await acquireRepositoryLease(repo));
  assert.equal(final.status, 'acquired', 'final authority is a positive acquisition');
  await final.release();
});

test('direct first repo dispatch bootstraps, binds, and provisions a deferred project', async (t) => {
  freshDb();
  const scope = new LeaseTestScope(t);
  const projectDir = join(scope.root, 'direct-deferred-dispatch');
  mkdirSync(projectDir);
  const project = createProject({
    name: 'Direct deferred dispatch',
    slug: `direct-deferred-${newId().toLowerCase()}`,
    folderPath: projectDir,
  });
  seedStockAgents();
  const dispatch = new DispatchService({
    resolveNewSpecialistSelection: async () => ({
      status: 'valid',
      selection: TEST_RUNTIME_SELECTION,
    }),
    preflightRuntimeSession: async () => ({
      status: 'valid',
      selection: TEST_RUNTIME_SELECTION,
    }),
    mintSpecialistRuntimeSession: async (input) => withRuntimeReceipt(
      () => new FakeRuntime(),
    )(input),
  });
  dispatch.attach({
    registry: { get: () => ({ injectAgentEnvelope: async () => {} }) } as never,
    hub: {} as never,
    serverPort: 5124,
  });
  let runId: ULID | null = null;
  try {
    const result = await dispatch.dispatchFresh({
      projectId: project.id,
      agentName: 'code-writer',
      input: 'bootstrap before the first repo dispatch',
      dispatcherSessionId: 'direct-deferred-dispatch',
      expectedOutput: { kind: 'repo', paths_touched: ['first.txt'] },
    });
    assert.equal(result.ok, true, result.ok ? '' : result.message);
    if (!result.ok) return;
    const admittedRunId = result.run.runId as ULID;
    runId = admittedRunId;
    const row = getAgentRunRow(admittedRunId);
    assert.ok(row?.worktreeDir && existsSync(row.worktreeDir));
    assert.deepEqual(getProjectById(project.id)?.repositoryIdentity, row.gitReceipt?.repositoryIdentity);
    assert.equal(await gitOutput(['log', '-1', '--format=%s'], projectDir), 'Initial scaffold');
    assert.equal(await gitOutput(['status', '--porcelain'], projectDir), '');
    await dispatch.killRun(project.id, admittedRunId);
    await dispatch.disposeAll();
    const settled = getAgentRunRow(admittedRunId);
    if (settled?.worktreeDir && settled.gitReceipt?.repositoryIdentity) {
      assert.equal(
        await teardownWorktree(
          projectDir,
          settled.worktreeDir,
          [],
          settled.gitReceipt.repositoryIdentity,
        ),
        true,
      );
    }
  } finally {
    if (runId) await dispatch.killRun(project.id, runId).catch(() => {});
    await dispatch.disposeAll();
    await releaseAllRepositoryLeasesForTesting();
  }
});

test('a real occupied dispatch fails before provision, profile commands, or runtime mint', async (t) => {
  freshDb();
  const scope = new LeaseTestScope(t);
  const gp = await newGitProject('occupied-dispatch');
  seedStockAgents();
  const marker = join(scope.root, 'dispatch-holder.marker');
  const holder = scope.spawnChild(gp.dir, marker);
  assert.equal((await holder.firstMessage).kind, 'acquired');

  let runtimeMints = 0;
  const dispatch = new DispatchService({
    resolveNewSpecialistSelection: async () => ({
      status: 'valid',
      selection: TEST_RUNTIME_SELECTION,
    }),
    preflightRuntimeSession: async () => ({
      status: 'valid',
      selection: TEST_RUNTIME_SELECTION,
    }),
    mintSpecialistRuntimeSession: async (input) => {
      runtimeMints++;
      return withRuntimeReceipt(() => new FakeRuntime())(input);
    },
  });
  dispatch.attach({
    registry: { get: () => ({ injectAgentEnvelope: async () => {} }) } as never,
    hub: {} as never,
    serverPort: 5124,
  });

  try {
    const before = await gitOutput(['branch', '--format=%(refname:short)'], gp.dir);
    const result = await dispatch.dispatchFresh({
      projectId: gp.project.id,
      agentName: 'code-writer',
      input: 'must not start',
      dispatcherSessionId: 'repository-occupied-test',
      expectedOutput: { kind: 'repo', paths_touched: ['blocked.txt'] },
    });
    assert.equal(result.ok, false);
    if (result.ok) assert.fail('occupied repository dispatch unexpectedly succeeded');
    assert.equal(result.cause, 'repository-occupied');
    assert.equal(result.httpStatus, 409);
    assert.equal(runtimeMints, 0);
    assert.equal(existsSync(`${gp.dir}-worktrees`), false);
    assert.equal(await gitOutput(['branch', '--format=%(refname:short)'], gp.dir), before);
    assert.equal(readFileSync(marker, 'utf8').length > 0, true);
  } finally {
    await holder.release();
    await dispatch.disposeAll();
    await gp.cleanup();
  }
});

test('occupied late continuation, landing, and teardown doors preserve the sealed worktree', async (t) => {
  freshDb();
  const scope = new LeaseTestScope(t);
  const gp = await newGitProject('occupied-late-doors');
  seedStockAgents();
  const producerRunId = newId();
  const worktree = await provisionWorktree(gp.dir, producerRunId, {
    projectId: gp.project.id,
  });
  if (!worktree.ok) assert.fail(worktree.error);
  const sealedCommit = await commitFile(worktree.dir, 'sealed.txt', 'sealed\n');
  const contracts = new ContractService();
  const contract = contracts.create({
    projectId: gp.project.id,
    podName: 'code-writer',
    expectedOutput: { kind: 'repo' },
    acceptanceCriteria: [],
    verificationTier: 'auto',
    worktreePath: worktree.dir,
    worktreeBaseBranch: worktree.baseBranch,
    worktreeBaseSha: worktree.baseSha,
  });
  insertAgentRunRow({
    id: producerRunId,
    projectId: gp.project.id,
    dispatcherSessionId: 'late-door-test',
    ...testAgentRunExecution('code-writer'),
    status: 'queued',
    input: 'sealed parent',
    contractId: contract.id as ULID,
    worktreeDir: worktree.dir,
    worktreeBaseBranch: worktree.baseBranch,
    worktreeBaseSha: worktree.baseSha,
    gitReceipt: {
      worktreePath: worktree.dir,
      branch: worktree.branch,
      baseBranch: worktree.baseBranch,
      baseSha: worktree.baseSha,
      cleanStatus: true,
      repositoryIdentity: worktree.repositoryIdentity,
    },
    lifecycleState: 'merge-ready',
    queuedAt: Date.now(),
  });
  contracts.setRun(contract.id, producerRunId);
  advanceTestAgentRunStatus(producerRunId, 'completed');
  contracts.setDeliverable({
    id: contract.id,
    deliverable: {
      kind: 'repo',
      branch: worktree.branch,
      commit: sealedCommit,
      baseBranch: worktree.baseBranch,
      baseCommit: worktree.baseSha,
    },
    report: 'sealed',
  });
  const accepted = contracts.setVerification({
    id: contract.id,
    verificationStatus: 'passed',
    verifiedBaseSha: worktree.baseSha,
  });
  assert.ok(accepted);
  await releaseAllRepositoryLeasesForTesting();

  const holder = scope.spawnChild(gp.dir, join(scope.root, 'late-door-holder.marker'));
  assert.equal((await holder.firstMessage).kind, 'acquired');
  let runtimeMints = 0;
  const dispatch = new DispatchService({
    resolveNewSpecialistSelection: async () => ({
      status: 'valid',
      selection: TEST_RUNTIME_SELECTION,
    }),
    preflightRuntimeSession: async () => ({
      status: 'valid',
      selection: TEST_RUNTIME_SELECTION,
    }),
    mintSpecialistRuntimeSession: async (input) => {
      runtimeMints++;
      return withRuntimeReceipt(() => new FakeRuntime())(input);
    },
  });
  dispatch.attach({
    registry: { get: () => ({ injectAgentEnvelope: async () => {} }) } as never,
    hub: {} as never,
    serverPort: 5124,
  });

  try {
    const beforeHead = await gitOutput(['rev-parse', 'HEAD'], gp.dir);
    const continuation = await dispatch.dispatchContinue({
      projectId: gp.project.id,
      runId: producerRunId,
      input: 'must stay blocked',
      dispatcherSessionId: 'late-door-test',
    });
    assert.equal(continuation.ok, false);
    if (continuation.ok) assert.fail('occupied continuation unexpectedly succeeded');
    assert.equal(continuation.cause, 'repository-occupied');
    assert.equal(runtimeMints, 0);

    await assert.rejects(
      dispatch.landAcceptedContract(accepted, 'orchestrator'),
      (error: unknown) =>
        error instanceof RepositoryLeaseError && error.code === 'repository-occupied',
    );
    assert.equal(
      await teardownWorktree(
        gp.dir,
        worktree.dir,
        [],
        worktree.repositoryIdentity,
      ),
      false,
    );
    assert.equal(await gitOutput(['rev-parse', 'HEAD'], gp.dir), beforeHead);
    assert.equal(existsSync(worktree.dir), true);
    assert.equal(contracts.get(contract.id)?.landingStatus, null);
  } finally {
    await holder.release();
    await releaseAllRepositoryLeasesForTesting();
    await dispatch.disposeAll();
    await gp.cleanup();
  }
});

test('occupied boot recovery preserves that repository while continuing for a distinct repository', async (t) => {
  freshDb();
  const scope = new LeaseTestScope(t);
  const gp = await newGitProject('occupied-recovery');
  const distinct = await newGitProject('distinct-recovery');
  const worktree = await provisionWorktree(gp.dir, newId(), {
    projectId: gp.project.id,
  });
  if (!worktree.ok) assert.fail(worktree.error);
  const distinctWorktree = await provisionWorktree(distinct.dir, newId(), {
    projectId: distinct.project.id,
  });
  if (!distinctWorktree.ok) assert.fail(distinctWorktree.error);
  await releaseAllRepositoryLeasesForTesting();

  const holder = scope.spawnChild(gp.dir, join(scope.root, 'recovery-holder.marker'));
  assert.equal((await holder.firstMessage).kind, 'acquired');
  try {
    const stranded = await reconcileStrandedWorktreesAtBoot();
    assert.equal(stranded.includes(worktree.branch), false);
    assert.equal(
      stranded.includes(distinctWorktree.branch),
      true,
      'recovery continues and classifies the unrelated repository',
    );
    assert.equal(
      listActiveWorktrees().some((row) => row.name === worktree.branch),
      true,
      'occupied repository row remains active and preserved',
    );
    assert.equal(existsSync(worktree.dir), true);
    assert.equal(existsSync(distinctWorktree.dir), true);
  } finally {
    await holder.release();
    await releaseAllRepositoryLeasesForTesting();
    await gp.cleanup();
    await distinct.cleanup();
  }
});

class LeaseTestScope {
  readonly root = mkdtempSync(join(tmpdir(), 'pc-sdk-repository-lease-'));
  private readonly children = new Set<ChildHarness>();
  private readonly managers = new Set<RepositoryLeaseManager>();
  private readonly handles = new Set<RepositoryLeaseHandle>();
  private childSequence = 0;

  constructor(private readonly t: TestContext) {
    t.after(async () => this.cleanup());
  }

  async createRepository(name: string): Promise<string> {
    const dir = join(this.root, name);
    mkdirSync(dir, { recursive: true });
    await gitOk(['init', '-b', 'main'], dir);
    await gitOk(['config', 'user.name', 'PC-SDK Lease Test'], dir);
    await gitOk(['config', 'user.email', 'lease-test@pc-sdk.invalid'], dir);
    writeFileSync(join(dir, 'README.md'), `${name}\n`, 'utf8');
    await gitOk(['add', 'README.md'], dir);
    await gitOk(['commit', '-m', 'initial'], dir);
    return dir;
  }

  trackManager(manager: RepositoryLeaseManager): RepositoryLeaseManager {
    this.managers.add(manager);
    return manager;
  }

  trackHandle(handle: RepositoryLeaseHandle): RepositoryLeaseHandle {
    this.handles.add(handle);
    return handle;
  }

  spawnChild(
    projectDir: string,
    markerPath = '',
    admission: 'repository' | 'runtime' = 'repository',
    gitDir: string | null = null,
  ): ChildHarness {
    const dataDir = join(this.root, `child-data-${this.childSequence++}`);
    const child = new ChildHarness(projectDir, markerPath, dataDir, admission, gitDir);
    this.children.add(child);
    void child.exitCode.then(() => this.children.delete(child));
    return child;
  }

  private async cleanup(): Promise<void> {
    const settled = await Promise.allSettled([
      ...[...this.children].map((child) => child.killHard()),
      ...[...this.managers].map((manager) => manager.releaseAllForTesting()),
      ...[...this.handles].map((handle) => handle.release()),
    ]);
    try {
      const failures = settled
        .filter((result): result is PromiseRejectedResult => result.status === 'rejected')
        .map((result) => result.reason);
      if (failures.length > 0) {
        throw new AggregateError(failures, 'repository lease fixture cleanup failed');
      }
    } finally {
      removeTempRoot(this.root);
    }
  }
}

class ChildHarness {
  readonly process: ChildProcessWithoutNullStreams;
  readonly firstMessage: Promise<ChildMessage>;
  readonly exitCode: Promise<number | null>;
  private stderr = '';

  constructor(
    projectDir: string,
    markerPath: string,
    dataDir: string,
    admission: 'repository' | 'runtime',
    gitDir: string | null,
  ) {
    this.process = spawn(
      process.execPath,
      ['--import', 'tsx', FIXTURE, projectDir, markerPath, admission],
      {
        cwd: SERVER_DIR,
        env: {
          ...process.env,
          PC_DATA_DIR: dataDir,
          ...(gitDir
            ? {
                GIT_DIR: gitDir,
                GIT_WORK_TREE: gitDir.trim() ? dirname(gitDir) : gitDir,
                GIT_COMMON_DIR: gitDir,
              }
            : {}),
        },
        stdio: 'pipe',
      },
    );
    this.process.stderr.setEncoding('utf8');
    this.process.stderr.on('data', (chunk: string) => { this.stderr += chunk; });
    this.firstMessage = firstJsonLine(this.process, () => this.stderr);
    this.exitCode = new Promise((resolveExit) => {
      this.process.once('exit', (code) => resolveExit(code));
    });
  }

  async release(): Promise<void> {
    if (this.process.exitCode !== null || this.process.signalCode !== null) return;
    this.process.stdin.write('release\n');
    const code = await withTestTimeout(this.exitCode, 10_000, 'child graceful release');
    assert.equal(code, 0, this.stderr);
  }

  async killHard(): Promise<void> {
    if (this.process.exitCode !== null || this.process.signalCode !== null) return;
    const signalled = this.process.kill('SIGKILL');
    assert.equal(
      signalled || this.process.exitCode !== null || this.process.signalCode !== null,
      true,
      `failed to signal child ${this.process.pid ?? 'unknown'}`,
    );
    await withTestTimeout(this.exitCode, 10_000, 'child hard exit');
  }
}

function firstJsonLine(
  child: ChildProcessWithoutNullStreams,
  stderr: () => string,
): Promise<ChildMessage> {
  return withTestTimeout(new Promise((resolveMessage, rejectMessage) => {
    let buffered = '';
    const onData = (chunk: Buffer): void => {
      buffered += chunk.toString('utf8');
      const newline = buffered.indexOf('\n');
      if (newline < 0) return;
      cleanup();
      try {
        resolveMessage(JSON.parse(buffered.slice(0, newline)) as ChildMessage);
      } catch (error) {
        rejectMessage(error);
      }
    };
    const onExit = (code: number | null): void => {
      cleanup();
      rejectMessage(new Error(`child exited ${String(code)} before receipt: ${stderr()}`));
    };
    const onError = (error: Error): void => {
      cleanup();
      rejectMessage(error);
    };
    const cleanup = (): void => {
      child.stdout.off('data', onData);
      child.off('exit', onExit);
      child.off('error', onError);
    };
    child.stdout.on('data', onData);
    child.once('exit', onExit);
    child.once('error', onError);
  }), 10_000, 'child repository lease receipt');
}

function createDirectoryAlias(target: string, alias: string, t: TestContext): boolean {
  try {
    symlinkSync(target, alias, process.platform === 'win32' ? 'junction' : 'dir');
    return true;
  } catch (error) {
    const code = nodeErrorCode(error);
    if (code !== 'EPERM' && code !== 'EACCES' && code !== 'ENOSYS') throw error;
    t.diagnostic(`filesystem directory alias unavailable: ${code}`);
    return false;
  }
}

function createFileAlias(target: string, alias: string, t: TestContext): boolean {
  try {
    symlinkSync(target, alias, 'file');
    return true;
  } catch (error) {
    const code = nodeErrorCode(error);
    if (code !== 'EPERM' && code !== 'EACCES' && code !== 'ENOSYS') throw error;
    t.diagnostic(`filesystem file alias unavailable: ${code}`);
    return false;
  }
}

function nodeErrorCode(error: unknown): string {
  if (typeof error !== 'object' || error === null || !('code' in error)) return 'UNKNOWN';
  return String((error as { code?: unknown }).code ?? 'UNKNOWN');
}

function gitOk(args: string[], cwd: string): Promise<void> {
  return new Promise((resolveCommand, rejectCommand) => {
    execFile(
      'git',
      args,
      { cwd, timeout: 30_000, windowsHide: true, maxBuffer: 1024 * 1024 },
      (error, stdout, stderr) => {
        if (error) {
          rejectCommand(
            new Error(`git ${args.join(' ')} failed in ${cwd}: ${String(stderr || stdout || error.message).trim()}`),
          );
        } else {
          resolveCommand();
        }
      },
    );
  });
}

function gitOutput(args: string[], cwd: string): Promise<string> {
  return new Promise((resolveCommand, rejectCommand) => {
    execFile(
      'git',
      args,
      { cwd, timeout: 30_000, windowsHide: true, maxBuffer: 1024 * 1024 },
      (error, stdout, stderr) => {
        if (error) {
          rejectCommand(
            new Error(`git ${args.join(' ')} failed in ${cwd}: ${String(stderr || error.message).trim()}`),
          );
        } else {
          resolveCommand(String(stdout ?? '').trim());
        }
      },
    );
  });
}

function removeTempRoot(root: string): void {
  const canonicalTemp = realpathSync.native(tmpdir());
  const canonicalParent = realpathSync.native(dirname(root));
  assert.equal(canonicalParent, canonicalTemp, 'cleanup target must remain in OS temp');
  assert.match(basename(root), /^pc-sdk-repository-lease-/u);
  rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
}

function withTestTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  return new Promise((resolveValue, rejectValue) => {
    const timer = setTimeout(() => rejectValue(new Error(`${label} timed out after ${ms}ms`)), ms);
    promise.then(
      (value) => { clearTimeout(timer); resolveValue(value); },
      (error) => { clearTimeout(timer); rejectValue(error); },
    );
  });
}
