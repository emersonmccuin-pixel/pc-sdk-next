import assert from 'node:assert/strict';
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import {
  existsSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  rmSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test, { type TestContext } from 'node:test';

interface SeedState {
  sealedRunId: string;
  sealedContractId: string;
  sealedWorktreeId: string;
  sealedWorktreePath: string;
  sealedBranch: string;
  sealedCommit: string;
  unsealedRunId: string;
  unsealedContractId: string;
  unsealedWorktreeId: string;
  unsealedWorktreePath: string;
  unsealedBranch: string;
  unsealedBranchTip: string;
  unsealedContentPath: string;
  initialMainTip: string;
}

interface RecoverySnapshot {
  sealedRun: RunSnapshot | null;
  unsealedRun: RunSnapshot | null;
  sealedContract: ContractSnapshot | null;
  unsealedContract: ContractSnapshot | null;
  sealedWorktree: WorktreeSnapshot | null;
  unsealedWorktree: WorktreeSnapshot | null;
  preservedRunIds: string[];
  strandedWorktreeIds: string[];
  mainTip: string;
  mainCommitCount: number;
  landingSubjectCount: number;
  sealedCommitIsAncestor: boolean;
  sealedDirectoryExists: boolean;
  sealedRegistrationExists: boolean;
  sealedBranchExists: boolean;
  unsealedDirectoryExists: boolean;
  unsealedRegistrationExists: boolean;
  unsealedBranchTip: string | null;
  unsealedContent: string | null;
  outboxHighWater: string | null;
}

interface RunSnapshot {
  id: string;
  status: string;
  lifecycleState: string | null;
  failureCause: string | null;
  failureReason: string | null;
  rev: number;
}

interface ContractSnapshot {
  id: string;
  version: number;
  verificationStatus: string | null;
  landingStatus: string | null;
  mergeSha: string | null;
  landedSha: string | null;
}

interface WorktreeSnapshot {
  id: string;
  status: string;
  path: string;
  branch: string | null;
  agentRunId: string | null;
  contractId: string | null;
  strandedReason: string | null;
  strandedAt: number | null;
}

const FIXTURE = fileURLToPath(
  new URL('./fixtures/process-kill-recovery-child.ts', import.meta.url),
);

test('real process death recovers the sealed peer exactly once and preserves the unsealed peer', async (t) => {
  const root = mkdtempSync(join(tmpdir(), 'pc-sdk-process-recovery-'));
  const children = new Set<ChildHarness>();
  const dataDir = join(root, 'data');
  const repoDir = join(root, 'repo');
  const statePath = join(root, 'state.json');
  const readyPath = join(root, 'ready.json');
  const firstRecoveryPath = join(root, 'recovery-1.json');
  const secondRecoveryPath = join(root, 'recovery-2.json');
  mkdirSync(dataDir, { recursive: true });

  t.after(async () => {
    const exits = await Promise.allSettled([...children].map((child) => child.killHard()));
    const failures = exits
      .filter((result): result is PromiseRejectedResult => result.status === 'rejected')
      .map((result) => result.reason);
    try {
      removeTempRoot(root);
    } catch (error) {
      failures.push(error);
    }
    if (failures.length > 0) throw new AggregateError(failures, 'process recovery fixture cleanup failed');
  });

  const seed = track(children, new ChildHarness('seed', dataDir, repoDir, statePath, readyPath));
  await waitForFile(readyPath, 20_000, () => seed.diagnostics());
  const state = readJson<SeedState>(statePath);
  assert.equal(seed.isAlive(), true, 'the source engine must still own its DB and repository leases at the crash point');
  assert.notEqual(state.sealedWorktreePath, state.unsealedWorktreePath);
  assert.notEqual(state.sealedWorktreeId, state.unsealedWorktreeId);
  assert.notEqual(state.sealedRunId, state.unsealedRunId);
  assert.equal(existsSync(state.sealedWorktreePath), true);
  assert.equal(existsSync(state.unsealedWorktreePath), true);
  assert.equal(readFileSync(state.unsealedContentPath, 'utf8'), 'unsealed work survives the crash\n');

  await seed.killHard();
  assert.equal(seed.isAlive(), false, 'hard-killed engine must positively exit before its successor starts');

  const firstSuccessor = track(
    children,
    new ChildHarness('recover', dataDir, repoDir, statePath, firstRecoveryPath),
  );
  assert.equal(await firstSuccessor.waitForCleanExit(), 0, firstSuccessor.diagnostics());
  const first = readJson<RecoverySnapshot>(firstRecoveryPath);
  assertRecoveredOutcome(first, state);

  const secondSuccessor = track(
    children,
    new ChildHarness('recover', dataDir, repoDir, statePath, secondRecoveryPath),
  );
  assert.equal(await secondSuccessor.waitForCleanExit(), 0, secondSuccessor.diagnostics());
  const second = readJson<RecoverySnapshot>(secondRecoveryPath);
  assertRecoveredOutcome(second, state);

  assert.equal(second.mainTip, first.mainTip, 'a second boot cannot create another merge');
  assert.equal(second.mainCommitCount, first.mainCommitCount, 'Git history is unchanged on the second boot');
  assert.equal(second.landingSubjectCount, 1);
  assert.equal(second.sealedRun?.rev, first.sealedRun?.rev, 'sealed terminal settlement is not republished');
  assert.equal(second.unsealedRun?.rev, first.unsealedRun?.rev, 'restart failure is not republished');
  assert.equal(second.sealedContract?.version, first.sealedContract?.version, 'landing receipt is immutable');
  assert.equal(second.unsealedContract?.version, first.unsealedContract?.version);
  assert.equal(second.unsealedWorktree?.strandedAt, first.unsealedWorktree?.strandedAt, 'stranding is not restamped');
  assert.equal(second.outboxHighWater, first.outboxHighWater, 'second boot emits no duplicate durable resource effect');
});

function assertRecoveredOutcome(snapshot: RecoverySnapshot, state: SeedState): void {
  assert.equal(snapshot.sealedRun?.id, state.sealedRunId);
  assert.equal(snapshot.sealedRun?.status, 'completed');
  assert.equal(snapshot.sealedRun?.lifecycleState, 'completed');
  assert.equal(snapshot.sealedRun?.failureCause, null);
  assert.equal(snapshot.sealedContract?.id, state.sealedContractId);
  assert.equal(snapshot.sealedContract?.verificationStatus, 'passed');
  assert.equal(snapshot.sealedContract?.landingStatus, 'landed');
  assert.equal(snapshot.sealedContract?.landedSha, state.sealedCommit);
  assert.equal(snapshot.sealedContract?.mergeSha, snapshot.mainTip);
  assert.notEqual(snapshot.mainTip, state.initialMainTip);
  assert.equal(snapshot.landingSubjectCount, 1, 'the sealed branch is merged exactly once');
  assert.equal(snapshot.sealedCommitIsAncestor, true);
  assert.equal(snapshot.sealedWorktree?.id, state.sealedWorktreeId);
  assert.equal(snapshot.sealedWorktree?.status, 'destroyed');
  assert.equal(snapshot.sealedWorktree?.path, state.sealedWorktreePath);
  assert.equal(snapshot.sealedWorktree?.branch, state.sealedBranch);
  assert.equal(snapshot.sealedWorktree?.agentRunId, state.sealedRunId);
  assert.equal(snapshot.sealedWorktree?.contractId, state.sealedContractId);
  assert.equal(snapshot.sealedDirectoryExists, false);
  assert.equal(snapshot.sealedRegistrationExists, false);
  assert.equal(snapshot.sealedBranchExists, false);

  assert.equal(snapshot.unsealedRun?.id, state.unsealedRunId);
  assert.equal(snapshot.unsealedRun?.status, 'failed');
  assert.equal(snapshot.unsealedRun?.lifecycleState, 'failed');
  assert.equal(snapshot.unsealedRun?.failureCause, 'server-restart');
  assert.match(snapshot.unsealedRun?.failureReason ?? '', /server restarted while the run was live/u);
  assert.equal(snapshot.unsealedContract?.id, state.unsealedContractId);
  assert.equal(snapshot.unsealedContract?.verificationStatus, 'pending');
  assert.equal(snapshot.unsealedContract?.landingStatus, null);
  assert.equal(snapshot.unsealedWorktree?.id, state.unsealedWorktreeId);
  assert.equal(snapshot.unsealedWorktree?.status, 'stranded');
  assert.equal(snapshot.unsealedWorktree?.path, state.unsealedWorktreePath);
  assert.equal(snapshot.unsealedWorktree?.agentRunId, state.unsealedRunId);
  assert.equal(snapshot.unsealedWorktree?.contractId, state.unsealedContractId);
  assert.equal(snapshot.unsealedWorktree?.branch, state.unsealedBranch);
  assert.equal(snapshot.unsealedWorktree?.strandedReason, 'no-live-run');
  assert.deepEqual(snapshot.preservedRunIds, [state.unsealedRunId]);
  assert.deepEqual(snapshot.strandedWorktreeIds, [state.unsealedWorktreeId]);
  assert.equal(snapshot.unsealedDirectoryExists, true);
  assert.equal(snapshot.unsealedRegistrationExists, true);
  assert.equal(snapshot.unsealedBranchTip, state.unsealedBranchTip);
  assert.equal(snapshot.unsealedContent, 'unsealed work survives the crash\n');
}

class ChildHarness {
  readonly process: ChildProcessWithoutNullStreams;
  private readonly exit: Promise<number | null>;
  private stderr = '';
  private stdout = '';

  constructor(mode: 'seed' | 'recover', dataDir: string, repoDir: string, statePath: string, outputPath: string) {
    this.process = spawn(
      process.execPath,
      ['--import', 'tsx', FIXTURE, mode, dataDir, repoDir, statePath, outputPath],
      {
        cwd: fileURLToPath(new URL('..', import.meta.url)),
        env: { ...process.env, PC_DATA_DIR: dataDir },
        stdio: 'pipe',
      },
    );
    this.process.stdout.setEncoding('utf8');
    this.process.stderr.setEncoding('utf8');
    this.process.stdout.on('data', (chunk: string) => { this.stdout += chunk; });
    this.process.stderr.on('data', (chunk: string) => { this.stderr += chunk; });
    this.exit = new Promise((resolve) => {
      this.process.once('exit', (code) => resolve(code));
    });
  }

  isAlive(): boolean {
    return this.process.exitCode === null && this.process.signalCode === null;
  }

  diagnostics(): string {
    return `stdout:\n${this.stdout}\nstderr:\n${this.stderr}`;
  }

  async waitForCleanExit(): Promise<number | null> {
    return withTimeout(this.exit, 30_000, `child ${this.process.pid ?? 'unknown'} clean exit`, () => this.diagnostics());
  }

  async killHard(): Promise<void> {
    if (!this.isAlive()) {
      await this.exit;
      return;
    }
    const signalled = this.process.kill('SIGKILL');
    assert.equal(
      signalled || !this.isAlive(),
      true,
      `failed to signal process recovery child ${this.process.pid ?? 'unknown'}`,
    );
    await withTimeout(this.exit, 10_000, `child ${this.process.pid ?? 'unknown'} hard exit`, () => this.diagnostics());
  }
}

function track(children: Set<ChildHarness>, child: ChildHarness): ChildHarness {
  children.add(child);
  return child;
}

async function waitForFile(path: string, timeoutMs: number, diagnostics: () => string): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (existsSync(path)) return;
    await new Promise<void>((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`fixture marker ${path} did not appear within ${timeoutMs}ms\n${diagnostics()}`);
}

function withTimeout<T>(
  promise: Promise<T>,
  timeoutMs: number,
  label: string,
  diagnostics: () => string,
): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`${label} timed out after ${timeoutMs}ms\n${diagnostics()}`)), timeoutMs);
    promise.then(
      (value) => { clearTimeout(timer); resolve(value); },
      (error) => { clearTimeout(timer); reject(error); },
    );
  });
}

function readJson<T>(path: string): T {
  return JSON.parse(readFileSync(path, 'utf8')) as T;
}

function removeTempRoot(root: string): void {
  const canonicalTemp = realpathSync.native(tmpdir());
  const canonicalParent = realpathSync.native(dirname(root));
  assert.equal(canonicalParent, canonicalTemp, 'cleanup target must remain in OS temp');
  assert.match(root.split(/[\\/]/u).at(-1) ?? '', /^pc-sdk-process-recovery-/u);
  rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
}
