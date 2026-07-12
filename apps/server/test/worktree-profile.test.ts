// Slice E1 — WorktreeProfile + Prepare/Readiness receipts (guard 2,
// docs/worktree-lifecycle.md 'Provisioning and readiness') through the REAL
// dispatch pipeline on real temp git repos:
//  - passing setup+readiness → git/preparation/readiness receipts persisted,
//    lifecycle passes preparing/ready, run lands + cleanup commands run
//    best-effort on teardown (a failing cleanup step never blocks removal)
//  - failing setup → typed worktree-provision-failed with the receipt
//    persisted, lifecycle 'provisioning-failed', worktree PRESERVED
//  - dirty initial status (smudge filter) → provisioning refuses
//  - profile baseBranch overrides the main/master probe
//  - empty phases produce explicit positive no-op receipts before runtime mint
//  - continuation records preparation reuse and re-runs/readies explicitly

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  getAgentRunRow,
  getContract,
  getRawDb,
  newId,
  updateAgentRunStatus,
  updateProjectWorktreeProfile,
} from '@pc/db';
import type { RunLifecycleState, ULID } from '@pc/domain';
import { seedStockAgents } from '../src/agents/seed.ts';
import { CLAUDE_RUNTIME_ID } from '../src/runner/claude-adapter.ts';
import { FakeRuntime } from '../src/runner/fake-runtime.ts';
import {
  RuntimeRegistry,
  type AgentRuntimeAdapter,
  type CreateRuntimeSession,
  type ResumeRuntimeSession,
  type RuntimeEvent,
  type RuntimeSession,
} from '../src/runner/runtime.ts';
import { DispatchService } from '../src/dispatch/service.ts';
import {
  releaseAllRepositoryLeasesForTesting,
  repositoryLeaseManager,
} from '../src/dispatch/repository-lease.ts';
import {
  git,
  provisionWorktree,
  runProfileCommands,
  runShellCommand,
  worktreesRoot,
} from '../src/dispatch/worktrees.ts';
import { SessionRegistry } from '../src/chat/registry.ts';
import { ProjectWebSocketHub } from '../src/ws/hub.ts';
import { commitFile, freshDb, newGitProject, testDispatchRuntimeDeps, until } from './helpers.ts';
import {
  testCapabilities,
  testModelDiscovery,
  testSessionSelectionDeps,
  testSubscriptionQuotaUnavailable,
  withRuntimeReceipt,
} from './runtime-fixtures.ts';

const OK_RESULT: RuntimeEvent = {
  type: 'result',
  ok: true,
  stopReason: 'complete',
  usage: null,
  durationMs: 1,
  error: null,
  outcome: 'ok',
  numTurns: null,
};

const NODE_OK = (tag: string) => `node -e "console.log('${tag}')"`;
const NODE_FAIL = (code: number) => `node -e "process.exit(${code})"`;
const CHILD_ENV_CANARY_NAMES = [
  'PC_AINATIVE_PM_TOKEN',
  'OPENAI_API_KEY',
  'INNOCENT_CANARY',
  'GIT_DIR',
  'NODE_OPTIONS',
  'BASH_ENV',
] as const;
const GRANDCHILD_ENV_ASSERTION = Buffer.from(
  `const names=${JSON.stringify(CHILD_ENV_CANARY_NAMES)};` +
  'if(names.some((name)=>process.env[name]!==undefined))process.exit(43);',
).toString('base64');

function nodeEnvClean(tag: string, after = ''): string {
  const names = `[${CHILD_ENV_CANARY_NAMES.map((name) => `'${name}'`).join(',')}]`;
  return `node -e "const names=${names};if(names.some((name)=>process.env[name]!==undefined))process.exit(41);require('node:child_process').execFileSync(process.execPath,['-e',Buffer.from('${GRANDCHILD_ENV_ASSERTION}','base64').toString('utf8')],{stdio:'inherit'});${after};console.log('${tag}')"`;
}

function installAmbientChildCanaries(): () => void {
  const values: Record<(typeof CHILD_ENV_CANARY_NAMES)[number], string> = {
    PC_AINATIVE_PM_TOKEN: 'pm-secret-must-not-cross',
    OPENAI_API_KEY: 'peer-provider-secret-must-not-cross',
    INNOCENT_CANARY: 'unknown-name-must-not-cross',
    GIT_DIR: 'ambient-git-selector-must-not-cross',
    NODE_OPTIONS: '--sec-003-invalid-node-option',
    BASH_ENV: 'ambient-shell-startup-must-not-cross',
  };
  const previous = new Map<string, string | undefined>();
  for (const [name, value] of Object.entries(values)) {
    previous.set(name, process.env[name]);
    process.env[name] = value;
  }
  return () => {
    for (const [name, value] of previous) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  };
}

async function cleanupGitProject(gp: { dir: string; cleanup(): Promise<void> }): Promise<void> {
  await releaseAllRepositoryLeasesForTesting();
  await gp.cleanup();
  if (existsSync(gp.dir) || existsSync(worktreesRoot(gp.dir))) {
    // A just-settled async verification can release its final Windows Git
    // handle immediately after the durable lifecycle state becomes visible.
    await new Promise((resolve) => setTimeout(resolve, 250));
    await gp.cleanup();
  }
  assert.equal(existsSync(gp.dir), false, 'temporary Git repository was removed');
  assert.equal(existsSync(worktreesRoot(gp.dir)), false, 'temporary worktree root was removed');
}

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => (resolve = r));
  return { promise, resolve };
}

/** Test-gated adapter (same rig as dispatch-lifecycle.test.ts): sessions open
 *  only after releaseSession(), each turn ends only after releaseTurn(). */
class GatedAdapter implements AgentRuntimeAdapter {
  readonly id = CLAUDE_RUNTIME_ID;
  readonly rowsAtMint: ReturnType<typeof getAgentRunRow>[] = [];
  private sessionGate = deferred();
  private turnGate = deferred();
  releaseSession(): void {
    this.sessionGate.resolve();
  }
  releaseTurn(): void {
    this.turnGate.resolve();
  }
  /** Re-arm both gates (for a continuation session in the same test). */
  rearm(): void {
    this.sessionGate = deferred();
    this.turnGate = deferred();
  }
  async capabilities(accountId: string) { return testCapabilities(this.id, accountId); }
  async observeSubscriptionQuota(accountId: string) {
    return testSubscriptionQuotaUnavailable(this.id, accountId);
  }
  async listModels() { return testModelDiscovery(); }
  private async mint(
    input: CreateRuntimeSession,
    continuation: { mode: 'create' } | { mode: 'resume'; nativeSessionId: string },
  ): Promise<RuntimeSession> {
    this.rowsAtMint.push(getAgentRunRow(input.appSessionId as ULID));
    await this.sessionGate.promise;
    const gate = this.turnGate.promise;
    const runtime: RuntimeSession = {
      sendTurn: () => turnStream(gate),
      observeContext: async () => ({ confidence: 'unavailable', reason: 'unsupported' }),
      interrupt: async () => {},
      dispose: async () => {},
    };
    return withRuntimeReceipt(() => runtime)({
      projectId: input.projectId,
      appSessionId: input.appSessionId,
      continuationAttemptId: input.continuationAttemptId,
      selection: input.selection,
      continuation,
    });
  }
  createSession(input: CreateRuntimeSession): Promise<RuntimeSession> {
    return this.mint(input, { mode: 'create' });
  }
  resumeSession(input: ResumeRuntimeSession): Promise<RuntimeSession> {
    return this.mint(input, { mode: 'resume', nativeSessionId: input.nativeSessionId });
  }
}

async function* turnStream(gate: Promise<void>): AsyncGenerator<RuntimeEvent> {
  yield { type: 'system', subtype: 'x', level: 'info', message: 'working…' };
  await gate;
  yield OK_RESULT;
}

function rig(adapter: AgentRuntimeAdapter): DispatchService {
  const runtimes = new RuntimeRegistry();
  runtimes.register(adapter);
  const dispatch = new DispatchService({
    ...testDispatchRuntimeDeps(runtimes),
  });
  const hub = new ProjectWebSocketHub<ULID>();
  const registry = new SessionRegistry({
    hub,
    ...testSessionSelectionDeps(),
    mintSession: withRuntimeReceipt(() => new FakeRuntime()),
  });
  dispatch.attach({ registry, hub, serverPort: 1 });
  return dispatch;
}

function observer(runId: ULID) {
  const seen: RunLifecycleState[] = [];
  const note = (): RunLifecycleState | null => {
    const lc = getAgentRunRow(runId)?.lifecycleState ?? null;
    if (lc !== null && seen[seen.length - 1] !== lc) seen.push(lc);
    return lc;
  };
  return { seen, note, untilState: (s: RunLifecycleState) => until(() => note() === s, 20000, 2) };
}

test('passing setup+readiness lands receipts, reaches completed; cleanup runs best-effort on teardown', async () => {
  freshDb();
  seedStockAgents();
  const gp = await newGitProject();
  let restoreEnvironment = () => {};
  try {
    restoreEnvironment = installAmbientChildCanaries();
    const markerPath = join(worktreesRoot(gp.dir), 'cleanup-marker.txt');
    assert.ok(
      updateProjectWorktreeProfile(gp.project.id, {
        setupCommands: [nodeEnvClean('setup-ok')],
        readinessCommands: [nodeEnvClean('ready-ok')],
        // Marker proves cleanup ran; the failing step AFTER it proves a
        // cleanup failure never blocks removal (best-effort).
        cleanupCommands: [
          nodeEnvClean(
            'cleanup-ok',
            "require('node:fs').writeFileSync(require('node:path').join('..','cleanup-marker.txt'),'x')",
          ),
          NODE_FAIL(1),
        ],
      }),
    );
    const adapter = new GatedAdapter();
    const dispatch = rig(adapter);
    const result = await dispatch.dispatchFresh({
      projectId: gp.project.id,
      agentName: 'code-writer',
      input: 'do the work',
      dispatcherSessionId: 'S1',
      expectedOutput: { kind: 'repo', auto_land: true, paths_touched: ['feature.txt'] },
    });
    assert.equal(result.ok, true, JSON.stringify(result));
    const runId = (result as { run: { runId: string } }).run.runId as ULID;
    const o = observer(runId);

    // Session gate holds startRun — 'ready' is the durable post-prep park.
    await o.untilState('ready');
    assert.ok(o.seen.includes('preparing'), `preparing observed — saw: ${o.seen.join(' → ')}`);

    const row = getAgentRunRow(runId)!;
    assert.ok(row.worktreeDir, 'worktree provisioned');
    // Git receipt (doc :101-102): identity + positive clean status.
    assert.deepEqual(row.gitReceipt, {
      worktreePath: row.worktreeDir,
      branch: row.worktreeDir!.split(/[\\/]/).pop(),
      baseBranch: 'main',
      baseSha: row.worktreeBaseSha,
      cleanStatus: true,
      repositoryIdentity: row.gitReceipt?.repositoryIdentity,
    });
    assert.equal(row.gitReceipt?.repositoryIdentity.protocol, 'git-common-dir-v1');
    assert.match(row.gitReceipt?.repositoryIdentity.leaseKey ?? '', /^sha256:[0-9a-f]{64}$/);
    // Preparation + readiness receipts: per-step exit/duration/output tails.
    assert.equal(row.preparationReceipt?.ok, true);
    assert.equal(row.preparationReceipt?.outcome, 'executed');
    assert.equal(row.preparationReceipt?.steps.length, 1);
    assert.equal(row.preparationReceipt?.steps[0]?.exitCode, 0);
    assert.match(row.preparationReceipt?.steps[0]?.stdoutTail ?? '', /setup-ok/);
    assert.equal(row.readinessReceipt?.ok, true);
    assert.equal(row.readinessReceipt?.outcome, 'executed');
    assert.match(row.readinessReceipt?.steps[0]?.stdoutTail ?? '', /ready-ok/);

    adapter.releaseSession();
    await o.untilState('building');
    await commitFile(row.worktreeDir!, 'feature.txt', 'work\n');
    const submitted = await dispatch.submitDeliverable({
      projectId: gp.project.id,
      agentRunId: runId,
      deliverable: { kind: 'repo' },
      report: 'done',
    });
    assert.equal(submitted.ok, true, JSON.stringify(submitted));
    adapter.releaseTurn();
    await o.untilState('completed');

    assert.equal(getContract(getAgentRunRow(runId)!.contractId!)!.landingStatus, 'landed');
    assert.equal(existsSync(row.worktreeDir!), false, 'worktree torn down despite the failing cleanup step');
    assert.ok(existsSync(markerPath), 'cleanup command ran before removal');
    // 'provisioning' is transient here (prep starts immediately, no gate) —
    // the deterministic landmarks are the gated/durable ones.
    assert.ok(
      ['preparing', 'ready', 'building', 'verifying', 'completed'].every((s) =>
        o.seen.includes(s as RunLifecycleState),
      ),
      `landmarks — saw: ${o.seen.join(' → ')}`,
    );
  } finally {
    restoreEnvironment();
    await cleanupGitProject(gp);
  }
});

test('shell executor sanitizes a caller-supplied environment for the command and descendants', async () => {
  const previousComSpec = process.env.ComSpec;
  try {
    if (process.platform === 'win32') {
      process.env.ComSpec = 'C:\\definitely-missing-sec003\\ambient-shell.exe';
    }
    const supplied: NodeJS.ProcessEnv = { ...process.env };
    for (const name of CHILD_ENV_CANARY_NAMES) supplied[name] = `custom-${name}`;
    const snapshot = { ...supplied };

    const result = await runShellCommand(nodeEnvClean('custom-env-clean'), {
      cwd: process.cwd(),
      timeoutMs: 10_000,
      env: supplied,
    });

    assert.equal(result.exitCode, 0, result.stderr || result.stdout);
    assert.equal(result.timedOut, false);
    assert.match(result.stdout, /custom-env-clean/);
    assert.deepEqual(supplied, snapshot, 'sanitizing the supplied base does not mutate it');
  } finally {
    if (previousComSpec === undefined) delete process.env.ComSpec;
    else process.env.ComSpec = previousComSpec;
  }
});

test('cancellation while profile lease admission is gated prevents the first command from starting', async () => {
  freshDb();
  const gp = await newGitProject();
  const marker = join(gp.dir, 'must-not-run.txt');
  const leaseEntered = deferred();
  const releaseLease = deferred();
  const originalAcquire = repositoryLeaseManager.acquire;
  let active = true;
  repositoryLeaseManager.acquire = async (projectDir, expectedIdentity = null) => {
    leaseEntered.resolve();
    await releaseLease.promise;
    return originalAcquire.call(repositoryLeaseManager, projectDir, expectedIdentity);
  };
  try {
    const commands = runProfileCommands(
      gp.dir,
      [`node -e "require('node:fs').writeFileSync('must-not-run.txt','bad')"`],
      undefined,
      gp.project.repositoryIdentity,
      () => active,
    );
    await leaseEntered.promise;
    active = false;
    releaseLease.resolve();

    const result = await commands;
    assert.equal(result.cancelled, true);
    assert.equal(result.ok, false);
    assert.deepEqual(result.steps, []);
    assert.equal(existsSync(marker), false, 'no shell command starts after cancellation wins admission');
  } finally {
    repositoryLeaseManager.acquire = originalAcquire;
    releaseLease.resolve();
    await cleanupGitProject(gp);
  }
});

test('setup-only profile records executed preparation plus an explicit readiness no-op before mint', async () => {
  freshDb();
  seedStockAgents();
  const gp = await newGitProject();
  try {
    assert.ok(updateProjectWorktreeProfile(gp.project.id, {
      setupCommands: [NODE_OK('setup-only')],
      readinessCommands: [],
      cleanupCommands: [],
    }));
    const adapter = new GatedAdapter();
    const dispatch = rig(adapter);
    const result = await dispatch.dispatchFresh({
      projectId: gp.project.id,
      agentName: 'code-writer',
      input: 'prepare only',
      dispatcherSessionId: 'S1',
      expectedOutput: { kind: 'repo' },
    });
    assert.equal(result.ok, true, JSON.stringify(result));
    const runId = (result as { run: { runId: string } }).run.runId as ULID;
    await until(() => adapter.rowsAtMint.length === 1, 20000);
    const row = getAgentRunRow(runId)!;
    assert.equal(row.preparationReceipt?.outcome, 'executed');
    assert.match(row.preparationReceipt?.steps[0]?.stdoutTail ?? '', /setup-only/);
    assert.deepEqual(row.readinessReceipt, {
      phase: 'readiness',
      outcome: 'not-required',
      reason: 'no-commands-configured',
      ok: true,
      steps: [],
      finishedAt: row.readinessReceipt?.finishedAt,
    });
    assert.deepEqual(adapter.rowsAtMint[0]?.preparationReceipt, row.preparationReceipt);
    assert.deepEqual(adapter.rowsAtMint[0]?.readinessReceipt, row.readinessReceipt);

    adapter.releaseSession();
    adapter.releaseTurn();
    await until(() => getAgentRunRow(runId)?.status === 'failed', 20000);
  } finally {
    await cleanupGitProject(gp);
  }
});

test('failing setup → worktree-provision-failed with receipt, provisioning-failed lifecycle, worktree PRESERVED', async () => {
  freshDb();
  seedStockAgents();
  const gp = await newGitProject();
  try {
    assert.ok(
      updateProjectWorktreeProfile(gp.project.id, {
        setupCommands: [NODE_OK('first-ok'), NODE_FAIL(3), NODE_OK('never-runs')],
        readinessCommands: [NODE_OK('never-runs')],
        cleanupCommands: [],
      }),
    );
    const adapter = new GatedAdapter();
    const dispatch = rig(adapter);
    const result = await dispatch.dispatchFresh({
      projectId: gp.project.id,
      agentName: 'code-writer',
      input: 'doomed',
      dispatcherSessionId: 'S1',
      expectedOutput: { kind: 'repo' },
    });
    assert.equal(result.ok, true, 'dispatch admits; preparation fails async');
    const runId = (result as { run: { runId: string } }).run.runId as ULID;

    await until(() => getAgentRunRow(runId)?.status === 'failed', 20000);
    const row = getAgentRunRow(runId)!;
    assert.equal(row.failureCause, 'worktree-provision-failed');
    assert.match(row.failureReason ?? '', /preparation command failed \(exit 3\)/);
    assert.equal(row.lifecycleState, 'provisioning-failed');
    // Receipt persisted: the passing step + the failing step, nothing after.
    assert.equal(row.preparationReceipt?.ok, false);
    assert.equal(row.preparationReceipt?.outcome, 'executed');
    assert.equal(row.preparationReceipt?.steps.length, 2);
    assert.equal(row.preparationReceipt?.steps[0]?.exitCode, 0);
    assert.equal(row.preparationReceipt?.steps[1]?.exitCode, 3);
    assert.equal(row.readinessReceipt, null, 'readiness never ran');
    // Retention: prep failure preserves the worktree for debugging.
    assert.ok(row.worktreeDir && existsSync(row.worktreeDir), 'worktree preserved');
    assert.equal(getContract(row.contractId!)!.verificationStatus, 'failed');
  } finally {
    await cleanupGitProject(gp);
  }
});

test('failing readiness records positive preparation plus failed readiness and never mints', async () => {
  freshDb();
  seedStockAgents();
  const gp = await newGitProject();
  try {
    assert.ok(updateProjectWorktreeProfile(gp.project.id, {
      setupCommands: [],
      readinessCommands: [NODE_OK('ready-first'), NODE_FAIL(7)],
      cleanupCommands: [],
    }));
    const adapter = new GatedAdapter();
    const dispatch = rig(adapter);
    const result = await dispatch.dispatchFresh({
      projectId: gp.project.id,
      agentName: 'code-writer',
      input: 'readiness fails',
      dispatcherSessionId: 'S1',
      expectedOutput: { kind: 'repo' },
    });
    assert.equal(result.ok, true, JSON.stringify(result));
    const runId = (result as { run: { runId: string } }).run.runId as ULID;
    await until(() => getAgentRunRow(runId)?.status === 'failed', 20000);
    const row = getAgentRunRow(runId)!;
    assert.equal(row.failureCause, 'worktree-provision-failed');
    assert.equal(row.preparationReceipt?.outcome, 'not-required');
    assert.equal(row.preparationReceipt?.reason, 'no-commands-configured');
    assert.equal(row.readinessReceipt?.outcome, 'executed');
    assert.equal(row.readinessReceipt?.ok, false);
    assert.equal(row.readinessReceipt?.steps.length, 2);
    assert.equal(row.readinessReceipt?.steps[1]?.exitCode, 7);
    assert.equal(adapter.rowsAtMint.length, 0, 'failed readiness never reaches runtime mint');
    assert.ok(row.worktreeDir && existsSync(row.worktreeDir), 'worktree preserved');
  } finally {
    await cleanupGitProject(gp);
  }
});

test('cancellation during preparation cannot append a receipt or start readiness/runtime', async () => {
  freshDb();
  seedStockAgents();
  const gp = await newGitProject();
  try {
    assert.ok(updateProjectWorktreeProfile(gp.project.id, {
      setupCommands: [`node -e "setTimeout(() => process.exit(0), 750)"`],
      readinessCommands: [NODE_OK('must-not-run')],
      cleanupCommands: [],
    }));
    const adapter = new GatedAdapter();
    const dispatch = rig(adapter);
    const result = await dispatch.dispatchFresh({
      projectId: gp.project.id,
      agentName: 'code-writer',
      input: 'cancel in preparation',
      dispatcherSessionId: 'S1',
      expectedOutput: { kind: 'repo' },
    });
    assert.equal(result.ok, true, JSON.stringify(result));
    const runId = (result as { run: { runId: string } }).run.runId as ULID;
    await until(() => getAgentRunRow(runId)?.lifecycleState === 'preparing', 20000);
    const killed = await dispatch.killRun(gp.project.id, runId);
    assert.equal(killed.ok, true);
    await new Promise((resolve) => setTimeout(resolve, 1000));
    const row = getAgentRunRow(runId)!;
    assert.equal(row.status, 'cancelled');
    assert.equal(row.preparationReceipt, null, 'terminal CAS refuses the late command receipt');
    assert.equal(row.readinessReceipt, null, 'readiness never started');
    assert.equal(adapter.rowsAtMint.length, 0, 'runtime never minted');
    assert.ok(row.worktreeDir && existsSync(row.worktreeDir), 'cancelled worktree preserved');
  } finally {
    await cleanupGitProject(gp);
  }
});

test('dirty initial status refuses provisioning (clean-initial-status receipt check)', async () => {
  freshDb();
  seedStockAgents();
  const gp = await newGitProject();
  try {
    // Smudge filter dirties every fresh checkout: worktree add materializes
    // 'dirty', the index holds 'clean' — deterministic non-empty status.
    assert.equal((await git(['config', 'filter.tamper.smudge', 'echo dirty'], gp.dir)).ok, true);
    writeFileSync(join(gp.dir, '.gitattributes'), 'tampered.txt filter=tamper\n');
    writeFileSync(join(gp.dir, 'tampered.txt'), 'clean\n');
    assert.equal((await git(['add', '.'], gp.dir)).ok, true);
    assert.equal((await git(['commit', '-m', 'add tampered file'], gp.dir)).ok, true);

    const dispatch = rig(new GatedAdapter());
    const result = await dispatch.dispatchFresh({
      projectId: gp.project.id,
      agentName: 'code-writer',
      input: 'refused',
      dispatcherSessionId: 'S1',
      expectedOutput: { kind: 'repo' },
    });
    assert.equal(result.ok, false);
    if (!result.ok) {
      assert.equal(result.cause, 'worktree-provision-failed');
      assert.match(result.message, /not clean immediately after checkout/);
    }
  } finally {
    await cleanupGitProject(gp);
  }
});

test('profile baseBranch overrides the main/master probe', async () => {
  freshDb();
  seedStockAgents();
  const gp = await newGitProject();
  try {
    assert.equal((await git(['checkout', '-b', 'dev'], gp.dir)).ok, true);
    const devTip = await commitFile(gp.dir, 'dev.txt', 'dev\n');

    // Probe path refuses (main copy off 'main'); the override provisions.
    const probed = await provisionWorktree(gp.dir, newId());
    assert.equal(probed.ok, false);
    const missing = await provisionWorktree(gp.dir, newId(), { baseBranch: 'nope' });
    assert.equal(missing.ok, false);
    if (!missing.ok) assert.match(missing.error, /configured base branch 'nope' does not exist/);

    assert.ok(updateProjectWorktreeProfile(gp.project.id, { baseBranch: 'dev', setupCommands: [], readinessCommands: [], cleanupCommands: [] }));
    const adapter = new GatedAdapter();
    const dispatch = rig(adapter);
    const result = await dispatch.dispatchFresh({
      projectId: gp.project.id,
      agentName: 'code-writer',
      input: 'work on dev',
      dispatcherSessionId: 'S1',
      expectedOutput: { kind: 'repo' },
    });
    assert.equal(result.ok, true, JSON.stringify(result));
    const runId = (result as { run: { runId: string } }).run.runId as ULID;
    await until(() => adapter.rowsAtMint.length === 1, 20000);
    const row = getAgentRunRow(runId)!;
    assert.equal(row.worktreeBaseBranch, 'dev');
    assert.equal(row.worktreeBaseSha, devTip);
    assert.equal(row.gitReceipt?.baseBranch, 'dev');
    assert.deepEqual(row.preparationReceipt, {
      phase: 'preparation',
      outcome: 'not-required',
      reason: 'no-commands-configured',
      ok: true,
      steps: [],
      finishedAt: row.preparationReceipt?.finishedAt,
    });
    assert.deepEqual(row.readinessReceipt, {
      phase: 'readiness',
      outcome: 'not-required',
      reason: 'no-commands-configured',
      ok: true,
      steps: [],
      finishedAt: row.readinessReceipt?.finishedAt,
    });
    assert.equal(adapter.rowsAtMint.length, 1, 'runtime mint attempted once');
    assert.deepEqual(
      adapter.rowsAtMint[0]?.preparationReceipt,
      row.preparationReceipt,
      'preparation receipt existed before runtime mint',
    );
    assert.deepEqual(
      adapter.rowsAtMint[0]?.readinessReceipt,
      row.readinessReceipt,
      'readiness receipt existed before runtime mint',
    );
    // Settle the run so nothing lingers (no deliverable ⇒ typed failure).
    adapter.releaseSession();
    adapter.releaseTurn();
    await until(() => getAgentRunRow(runId)?.status === 'failed', 20000);
    assert.equal(getAgentRunRow(runId)?.failureCause, 'no-deliverable');
    await until(() => getContract(getAgentRunRow(runId)!.contractId!)?.verificationStatus === 'failed', 20000);
  } finally {
    await cleanupGitProject(gp);
  }
});

test('continuation re-runs readiness — receipt lands on the NEW row (readiness on every dispatch)', async () => {
  freshDb();
  seedStockAgents();
  const gp = await newGitProject();
  try {
    assert.ok(
      updateProjectWorktreeProfile(gp.project.id, {
        setupCommands: [],
        readinessCommands: [NODE_OK('re-ready')],
        cleanupCommands: [],
      }),
    );
    const adapter = new GatedAdapter();
    const dispatch = rig(adapter);
    const result = await dispatch.dispatchFresh({
      projectId: gp.project.id,
      agentName: 'code-writer',
      input: 'park it',
      dispatcherSessionId: 'S1',
      expectedOutput: { kind: 'repo' }, // default review ⇒ worktree survives the park
    });
    assert.equal(result.ok, true, JSON.stringify(result));
    const runId = (result as { run: { runId: string } }).run.runId as ULID;
    const o = observer(runId);
    adapter.releaseSession();
    await o.untilState('building');
    const row = getAgentRunRow(runId)!;
    await commitFile(row.worktreeDir!, 'feature.txt', 'work\n');
    assert.equal(
      (await dispatch.submitDeliverable({ projectId: gp.project.id, agentRunId: runId, deliverable: { kind: 'repo' }, report: 'done' })).ok,
      true,
    );
    adapter.releaseTurn();
    await o.untilState('merge-ready');
    assert.ok(existsSync(row.worktreeDir!), 'worktree survives the merge-ready park');

    adapter.rearm();
    const cont = await dispatch.dispatchContinue({
      projectId: gp.project.id,
      runId,
      input: 'keep going',
      dispatcherSessionId: 'S1',
    });
    assert.equal(cont.ok, true, JSON.stringify(cont));
    const contId = (cont as { run: { runId: string } }).run.runId as ULID;
    // Readiness re-ran in the existing workspace before the agent phase.
    await until(() => getAgentRunRow(contId)?.readinessReceipt !== null, 20000);
    const contRow = getAgentRunRow(contId)!;
    assert.equal(contRow.readinessReceipt?.ok, true);
    assert.equal(contRow.readinessReceipt?.outcome, 'executed');
    assert.match(contRow.readinessReceipt?.steps[0]?.stdoutTail ?? '', /re-ready/);
    assert.deepEqual(contRow.preparationReceipt, {
      phase: 'preparation',
      outcome: 'not-required',
      reason: 'existing-worktree-preparation',
      inheritedFromRunId: runId,
      ok: true,
      steps: [],
      finishedAt: contRow.preparationReceipt?.finishedAt,
    });
    // Settle the continuation (no deliverable ⇒ typed failure) — no leaks.
    adapter.releaseSession();
    adapter.releaseTurn();
    await until(() => getAgentRunRow(contId)?.status === 'failed', 20000);
    assert.equal(getAgentRunRow(contId)?.failureCause, 'no-deliverable');
    await until(() => getContract(getAgentRunRow(contId)!.contractId!)?.verificationStatus === 'failed', 20000);
  } finally {
    await cleanupGitProject(gp);
  }
});

test('paused repository builder with missing phase evidence is not revived after restart', async () => {
  freshDb();
  seedStockAgents();
  const gp = await newGitProject();
  try {
    const originalAdapter = new GatedAdapter();
    const originalDispatch = rig(originalAdapter);
    const result = await originalDispatch.dispatchFresh({
      projectId: gp.project.id,
      agentName: 'code-writer',
      input: 'pause then restart',
      dispatcherSessionId: 'S1',
      expectedOutput: { kind: 'repo' },
    });
    assert.equal(result.ok, true, JSON.stringify(result));
    const runId = (result as { run: { runId: string } }).run.runId as ULID;
    originalAdapter.releaseSession();
    await until(() => getAgentRunRow(runId)?.status === 'running', 20000);
    assert.equal(updateAgentRunStatus({ id: runId, status: 'paused' }), true);

    getRawDb().prepare(
      'UPDATE agent_runs SET readiness_receipt = NULL WHERE id = ?',
    ).run(runId);
    assert.equal(getAgentRunRow(runId)?.readinessReceipt, null, 'fixture models unavailable restart evidence');

    const restartedAdapter = new GatedAdapter();
    restartedAdapter.releaseSession();
    const restartedDispatch = rig(restartedAdapter);
    await restartedDispatch.recoverPausedAsks();
    assert.equal(restartedAdapter.rowsAtMint.length, 0, 'restart refuses before provider resume mint');
    assert.equal(getAgentRunRow(runId)?.status, 'paused', 'work remains paused/preserved');

    await originalDispatch.killRun(gp.project.id, runId);
    assert.equal(getAgentRunRow(runId)?.status, 'cancelled');
  } finally {
    await cleanupGitProject(gp);
  }
});
