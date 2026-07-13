import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

import { ContractService } from '@pc/app-services';
import {
  closeDb,
  createProject,
  getAgentRunRow,
  getContract,
  getLiveEventHighWater,
  getWorktreeById,
  insertAgentRunRow,
  listPreservedTerminalAgentRuns,
  listStrandedWorktrees,
  markAgentRunDelivered,
  newId,
  runMigrations,
  setWorktreeContractId,
} from '@pc/db';
import type { Contract } from '@pc/contracts';
import type { RepositoryIdentityReceipt, ULID } from '@pc/domain';

import { runBootRecovery, runPreAttachRepositoryRecovery } from '../../src/boot-recovery.ts';
import { DispatchService } from '../../src/dispatch/service.ts';
import {
  discoverRepositoryIdentity,
  releaseAllRepositoryLeasesForTesting,
} from '../../src/dispatch/repository-lease.ts';
import { git, provisionWorktree } from '../../src/dispatch/worktrees.ts';
import { acquireDataDirectoryAdmission } from '../../src/operations/data-dir-admission.ts';
import { RuntimeRegistry } from '../../src/runner/runtime.ts';
import {
  advanceTestAgentRunStatus,
  commitFile,
  testAgentRunExecution,
  testDispatchRuntimeDeps,
} from '../helpers.ts';

interface SeedState {
  projectId: ULID;
  repositoryIdentity: RepositoryIdentityReceipt;
  sealedRunId: ULID;
  sealedContractId: ULID;
  sealedWorktreeId: ULID;
  sealedWorktreePath: string;
  sealedBranch: string;
  sealedCommit: string;
  unsealedRunId: ULID;
  unsealedContractId: ULID;
  unsealedWorktreeId: ULID;
  unsealedWorktreePath: string;
  unsealedBranch: string;
  unsealedBranchTip: string;
  unsealedContentPath: string;
  initialMainTip: string;
}

interface RecoverySnapshot {
  sealedRun: ReturnType<typeof getAgentRunRow>;
  unsealedRun: ReturnType<typeof getAgentRunRow>;
  sealedContract: ReturnType<typeof getContract>;
  unsealedContract: ReturnType<typeof getContract>;
  sealedWorktree: ReturnType<typeof getWorktreeById>;
  unsealedWorktree: ReturnType<typeof getWorktreeById>;
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

const [mode, dataDir, repoDir, statePath, outputPath] = process.argv.slice(2);
if ((mode !== 'seed' && mode !== 'recover') || !dataDir || !repoDir || !statePath || !outputPath) {
  throw new Error('usage: process-kill-recovery-child <seed|recover> <dataDir> <repoDir> <statePath> <outputPath>');
}

process.env.PC_DATA_DIR = dataDir;

void main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});

async function main(): Promise<void> {
  const admission = await acquireDataDirectoryAdmission(dataDir);
  runMigrations();

  if (mode === 'seed') {
    await seedCrashState(repoDir, statePath, outputPath);
    // The parent must hard-kill this process. Keeping the product DB,
    // data-directory admission, and repository lease live models the engine
    // disappearing without running any shutdown hook.
    await new Promise<never>(() => {});
  }

  try {
    const state = readJson<SeedState>(statePath);
    const dispatch = new DispatchService({
      ...testDispatchRuntimeDeps(new RuntimeRegistry()),
    });

    // Production's process/DB sweep runs inside startServer, immediately
    // before the shared pre-attach repository composition used below.
    runBootRecovery();
    await runPreAttachRepositoryRecovery(dispatch);
    await dispatch.disposeAll();

    const snapshot = await recoverySnapshot(repoDir, state);
    await releaseAllRepositoryLeasesForTesting();
    closeDb();
    await admission.release();
    writeJson(outputPath, snapshot);
  } catch (error) {
    await releaseAllRepositoryLeasesForTesting().catch(() => {});
    closeDb();
    await admission.release().catch(() => {});
    throw error;
  }
}

async function seedCrashState(repoDir: string, statePath: string, readyPath: string): Promise<void> {
  mkdirSync(repoDir, { recursive: true });
  await gitOk(['init', '-b', 'main'], repoDir);
  await gitOk(['config', 'user.name', 'PC-SDK Process Recovery Test'], repoDir);
  await gitOk(['config', 'user.email', 'process-recovery@pc-sdk.invalid'], repoDir);
  writeFileSync(join(repoDir, 'README.md'), 'seed\n', 'utf8');
  await gitOk(['add', 'README.md'], repoDir);
  await gitOk(['commit', '-m', 'initial'], repoDir);

  const repositoryIdentity = await discoverRepositoryIdentity(repoDir);
  const project = createProject({
    name: 'Process recovery fixture',
    slug: `process-recovery-${newId().toLowerCase()}`,
    folderPath: repoDir,
    repositoryIdentity,
  });
  const contracts = new ContractService();

  const sealedRunId = newId() as ULID;
  const sealed = await provisionWorktree(repoDir, sealedRunId, { projectId: project.id });
  if (!sealed.ok) throw new Error(`sealed worktree provision failed: ${sealed.error}`);
  const sealedCommit = await commitFile(sealed.dir, 'sealed.txt', 'sealed peer\n', 'sealed peer deliverable');
  let sealedContract = createRepoContract(contracts, {
    projectId: project.id,
    worktreePath: sealed.dir,
    baseBranch: sealed.baseBranch,
    baseSha: sealed.baseSha,
    path: 'sealed.txt',
    autoLand: true,
  });
  setWorktreeContractId(sealed.branch, sealedContract.id as ULID);
  insertLiveRun({
    runId: sealedRunId,
    projectId: project.id,
    contractId: sealedContract.id as ULID,
    worktreeDir: sealed.dir,
    branch: sealed.branch,
    baseBranch: sealed.baseBranch,
    baseSha: sealed.baseSha,
    repositoryIdentity: sealed.repositoryIdentity,
    lifecycleState: 'verifying',
  });
  sealedContract = contracts.setRun(sealedContract.id, sealedRunId) ?? sealedContract;
  const sealedWithDeliverable = contracts.setDeliverable({
    id: sealedContract.id,
    deliverable: { kind: 'repo', branch: sealed.branch, commit: sealedCommit },
    report: 'sealed peer finished before the engine died',
  });
  if (!sealedWithDeliverable) throw new Error('sealed deliverable could not be persisted');
  markAgentRunDelivered(sealedRunId, Date.now());

  const unsealedRunId = newId() as ULID;
  const unsealed = await provisionWorktree(repoDir, unsealedRunId, { projectId: project.id });
  if (!unsealed.ok) throw new Error(`unsealed worktree provision failed: ${unsealed.error}`);
  const unsealedContentPath = join(unsealed.dir, 'unfinished.txt');
  writeFileSync(unsealedContentPath, 'unsealed work survives the crash\n', 'utf8');
  let unsealedContract = createRepoContract(contracts, {
    projectId: project.id,
    worktreePath: unsealed.dir,
    baseBranch: unsealed.baseBranch,
    baseSha: unsealed.baseSha,
    path: 'unfinished.txt',
    autoLand: false,
  });
  setWorktreeContractId(unsealed.branch, unsealedContract.id as ULID);
  insertLiveRun({
    runId: unsealedRunId,
    projectId: project.id,
    contractId: unsealedContract.id as ULID,
    worktreeDir: unsealed.dir,
    branch: unsealed.branch,
    baseBranch: unsealed.baseBranch,
    baseSha: unsealed.baseSha,
    repositoryIdentity: unsealed.repositoryIdentity,
    lifecycleState: 'building',
  });
  unsealedContract = contracts.setRun(unsealedContract.id, unsealedRunId) ?? unsealedContract;

  const initialMainTip = (await gitOk(['rev-parse', 'main'], repoDir)).stdout;
  const unsealedBranchTip = (await gitOk(['rev-parse', unsealed.branch], repoDir)).stdout;
  const state: SeedState = {
    projectId: project.id,
    repositoryIdentity,
    sealedRunId,
    sealedContractId: sealedContract.id as ULID,
    sealedWorktreeId: sealed.worktreeId,
    sealedWorktreePath: sealed.dir,
    sealedBranch: sealed.branch,
    sealedCommit,
    unsealedRunId,
    unsealedContractId: unsealedContract.id as ULID,
    unsealedWorktreeId: unsealed.worktreeId,
    unsealedWorktreePath: unsealed.dir,
    unsealedBranch: unsealed.branch,
    unsealedBranchTip,
    unsealedContentPath,
    initialMainTip,
  };
  writeJson(statePath, state);
  writeJson(readyPath, {
    kind: 'ready',
    pid: process.pid,
    sealedRunId,
    unsealedRunId,
    sealedWorktreePath: sealed.dir,
    unsealedWorktreePath: unsealed.dir,
  });
}

function createRepoContract(
  contracts: ContractService,
  input: {
    projectId: ULID;
    worktreePath: string;
    baseBranch: string;
    baseSha: string;
    path: string;
    autoLand: boolean;
  },
): Contract {
  return contracts.create({
    projectId: input.projectId,
    podName: 'code-writer',
    expectedOutput: {
      kind: 'repo',
      paths_touched: [input.path],
      ...(input.autoLand ? { auto_land: true } : {}),
    },
    acceptanceCriteria: [
      { kind: 'git_diff_nonempty', cwd: 'worktree' },
      { kind: 'changed_paths_within', allowed: [input.path] },
    ],
    verificationTier: 'auto',
    worktreePath: input.worktreePath,
    worktreeBaseBranch: input.baseBranch,
    worktreeBaseSha: input.baseSha,
    landingPolicy: input.autoLand ? 'auto-merge' : null,
  });
}

function insertLiveRun(input: {
  runId: ULID;
  projectId: ULID;
  contractId: ULID;
  worktreeDir: string;
  branch: string;
  baseBranch: string;
  baseSha: string;
    repositoryIdentity: RepositoryIdentityReceipt;
  lifecycleState: 'building' | 'verifying';
}): void {
  insertAgentRunRow({
    id: input.runId,
    projectId: input.projectId,
    ...testAgentRunExecution('code-writer'),
    dispatcherSessionId: 'process-recovery-dispatcher',
    status: 'queued',
    input: 'perform isolated repository work',
    contractId: input.contractId,
    worktreeDir: input.worktreeDir,
    worktreeBaseBranch: input.baseBranch,
    worktreeBaseSha: input.baseSha,
    gitReceipt: {
      worktreePath: input.worktreeDir,
      branch: input.branch,
      baseBranch: input.baseBranch,
      baseSha: input.baseSha,
      cleanStatus: true,
      repositoryIdentity: input.repositoryIdentity,
    },
    lifecycleState: input.lifecycleState,
    queuedAt: Date.now(),
  });
  advanceTestAgentRunStatus(input.runId, 'running');
}

async function recoverySnapshot(repoDir: string, state: SeedState): Promise<RecoverySnapshot> {
  const worktreeList = await gitOk(['worktree', 'list', '--porcelain'], repoDir);
  const registeredPaths = worktreeList.stdout
    .split(/\r?\n/u)
    .filter((line) => line.startsWith('worktree '))
    .map((line) => line.slice('worktree '.length).replace(/\\/gu, '/').toLowerCase());
  const normalizedSealedPath = state.sealedWorktreePath.replace(/\\/gu, '/').toLowerCase();
  const normalizedUnsealedPath = state.unsealedWorktreePath.replace(/\\/gu, '/').toLowerCase();
  const mainTip = (await gitOk(['rev-parse', 'main'], repoDir)).stdout;
  const mainCommitCount = Number((await gitOk(['rev-list', '--count', 'main'], repoDir)).stdout);
  const subjects = (await gitOk(['log', '--format=%s', 'main'], repoDir)).stdout.split(/\r?\n/u);
  const sealedBranch = await git(['rev-parse', '-q', '--verify', `refs/heads/${state.sealedBranch}`], repoDir);
  const unsealedBranch = await git(['rev-parse', '-q', '--verify', `refs/heads/${state.unsealedBranch}`], repoDir);
  const ancestry = await git(['merge-base', '--is-ancestor', state.sealedCommit, 'main'], repoDir);
  return {
    sealedRun: getAgentRunRow(state.sealedRunId),
    unsealedRun: getAgentRunRow(state.unsealedRunId),
    sealedContract: getContract(state.sealedContractId),
    unsealedContract: getContract(state.unsealedContractId),
    sealedWorktree: getWorktreeById(state.sealedWorktreeId),
    unsealedWorktree: getWorktreeById(state.unsealedWorktreeId),
    preservedRunIds: listPreservedTerminalAgentRuns(state.projectId).map((row) => row.id).sort(),
    strandedWorktreeIds: listStrandedWorktrees(state.projectId).map((row) => row.id).sort(),
    mainTip,
    mainCommitCount,
    landingSubjectCount: subjects.filter((subject) => subject === `land(code-writer): ${state.sealedBranch}`).length,
    sealedCommitIsAncestor: ancestry.ok,
    sealedDirectoryExists: existsSync(state.sealedWorktreePath),
    sealedRegistrationExists: registeredPaths.includes(normalizedSealedPath),
    sealedBranchExists: sealedBranch.ok,
    unsealedDirectoryExists: existsSync(state.unsealedWorktreePath),
    unsealedRegistrationExists: registeredPaths.includes(normalizedUnsealedPath),
    unsealedBranchTip: unsealedBranch.ok ? unsealedBranch.stdout : null,
    unsealedContent: existsSync(state.unsealedContentPath)
      ? readFileSync(state.unsealedContentPath, 'utf8')
      : null,
    outboxHighWater: getLiveEventHighWater(),
  };
}

async function gitOk(args: string[], cwd: string): Promise<{ stdout: string; stderr: string }> {
  const result = await git(args, cwd);
  if (!result.ok) throw new Error(`git ${args.join(' ')} failed in ${cwd}: ${result.stderr || result.stdout}`);
  return { stdout: result.stdout, stderr: result.stderr };
}

function readJson<T>(path: string): T {
  return JSON.parse(readFileSync(path, 'utf8')) as T;
}

function writeJson(path: string, value: unknown): void {
  mkdirSync(dirname(path), { recursive: true });
  const pendingPath = `${path}.${process.pid}.pending`;
  writeFileSync(pendingPath, `${JSON.stringify(value)}\n`, 'utf8');
  renameSync(pendingPath, path);
}
