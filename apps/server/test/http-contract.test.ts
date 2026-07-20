// Guard: the HTTP surface speaks the @pc/contracts API the web chrome calls.
// Real Hono app on an ephemeral port; asserts the response SHAPES the client
// reducers/stores destructure (a 404 or a wrong key here is a broken app).

import { afterEach, test } from 'node:test';
import assert from 'node:assert/strict';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SubscriptionQuotaService } from '@pc/app-services';
import { isSubscriptionQuotaListResponse } from '@pc/contracts';
import {
  enqueueConversationSend,
  getActiveConversationTurn,
  getActiveOrchestratorSession,
  getConversationQueueSnapshot,
  getOrchestratorSession,
  getProjectById,
  getRawDb,
  listLiveOutboxRowsAfter,
  listProjects,
  pruneLiveOutbox,
} from '@pc/db';
import { AccountRegistry } from '../src/runner/account-env.ts';
import { FakeRuntime } from '../src/runner/fake-runtime.ts';
import { startServer, type RunningServer } from '../src/server.ts';
import { releaseAllRepositoryLeasesForTesting } from '../src/dispatch/repository-lease.ts';
import { git } from '../src/dispatch/worktrees.ts';
import { freshDb, until } from './helpers.ts';
import {
  TEST_RUNTIME_ID,
  testSessionSelectionDeps,
  withRuntimeReceipt,
} from './runtime-fixtures.ts';

// Response bodies are `unknown` under strict fetch types; tests assert on shapes.
type Json = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
const body = (r: Response): Promise<Json> => r.json() as Promise<Json>;

afterEach(async () => {
  await releaseAllRepositoryLeasesForTesting();
});

async function boot(): Promise<{
  server: RunningServer;
  base: string;
  subscriptionQuota: SubscriptionQuotaService;
}> {
  const subscriptionQuota = new SubscriptionQuotaService();
  const server = await startServer({
    mintSession: withRuntimeReceipt(() => new FakeRuntime({ turns: [] as never, stepDelayMs: 1 })),
    ...testSessionSelectionDeps(),
    port: 0,
    instanceId: 'pc-sdk-next-test',
    runRecovery: false,
    accounts: new AccountRegistry(),
    orchestratorRuntimeId: TEST_RUNTIME_ID,
    subscriptionQuota,
  });
  return { server, base: `http://localhost:${server.port}`, subscriptionQuota };
}

type ProjectCreationMode = 'init-empty' | 'init-in-place' | 'attach-to-git';

function requestProjectCreation(
  base: string,
  input: { name: string; folderPath: string; mode: ProjectCreationMode },
): Promise<Response> {
  return fetch(`${base}/api/projects`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      name: input.name,
      folder_path: input.folderPath,
      mode: input.mode,
    }),
  });
}

async function requiredGit(args: string[], cwd: string): Promise<string> {
  const result = await git(args, cwd);
  assert.equal(
    result.ok,
    true,
    `git ${args.join(' ')} failed in ${cwd}: ${result.stderr || result.stdout}`,
  );
  return result.stdout;
}

async function initializeCommittedRepository(dir: string): Promise<void> {
  mkdirSync(dir, { recursive: true });
  await requiredGit(['init', '-b', 'main'], dir);
  await requiredGit(['config', 'user.name', 'PC-SDK Test'], dir);
  await requiredGit(['config', 'user.email', 'test@pc-sdk.invalid'], dir);
  writeFileSync(join(dir, 'README.md'), 'seed\n', 'utf8');
  await requiredGit(['add', 'README.md'], dir);
  await requiredGit(['commit', '-m', 'fixture'], dir);
}

async function closeFixture(server: RunningServer, root: string): Promise<void> {
  await server.close();
  await releaseAllRepositoryLeasesForTesting();
  rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
}

test('health positively identifies the PC-SDK Next instance', async () => {
  freshDb();
  const { server, base } = await boot();
  try {
    const health = await fetch(`${base}/health`).then(body);
    assert.equal(health.ok, true);
    assert.equal(health.name, '@pc-sdk/server');
    assert.equal(health.instanceId, 'pc-sdk-next-test');
  } finally {
    await server.close();
  }
});

test('settings: GET returns the singleton; PATCH round-trips', async () => {
  freshDb();
  const { server, base } = await boot();
  try {
    const got = await fetch(`${base}/api/settings`).then(body);
    assert.equal(got.ok, true);
    assert.ok('projectsFolder' in got.settings && 'onboardingCompletedAt' in got.settings);

    const patched = await fetch(`${base}/api/settings`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ projectsFolder: 'D:\\Proj', onboardingCompletedAt: '2026-07-10T00:00:00Z' }),
    }).then(body);
    assert.equal(patched.ok, true);
    assert.equal(patched.settings.projectsFolder, 'D:\\Proj');
    assert.equal(patched.settings.onboardingCompletedAt, '2026-07-10T00:00:00Z');
  } finally {
    await server.close();
  }
});

test('projects: probe → create (contract shape) → list → detail; sessions + image', async () => {
  freshDb();
  const { server, base } = await boot();
  const dir = mkdtempSync(join(tmpdir(), 'pc-probe-'));
  try {
    // fs/probe
    const probe = await fetch(`${base}/api/fs/probe`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ path: dir }),
    }).then(body);
    assert.equal(probe.ok, true);
    assert.equal(probe.probe.exists, true);
    assert.equal(probe.probe.isDirectory, true);

    const invalidAttachDir = mkdtempSync(join(tmpdir(), 'pc-attach-invalid-'));
    const invalidAttach = await fetch(`${base}/api/projects`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        name: 'Invalid attach',
        folder_path: invalidAttachDir,
        mode: 'attach-to-git',
      }),
    });
    assert.equal(invalidAttach.status, 503);
    assert.equal(existsSync(join(invalidAttachDir, '.git')), false);

    // create — the contract request body (folder_path + mode)
    const created = await fetch(`${base}/api/projects`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'Alpha', folder_path: dir, mode: 'init-empty' }),
    }).then(body);
    assert.equal(created.ok, true);
    assert.equal(existsSync(join(dir, '.git', 'HEAD')), true);
    assert.ok(getProjectById(created.project.id)?.repositoryIdentity);
    const project = created.project;
    assert.ok(project.id && project.slug);
    assert.deepEqual(project.stages, []);
    assert.ok('cancelledVisibility' in project.settings && 'remoteControl' in project.settings);
    // WF-2 — lifecycle policy settings default and round-trip through PATCH.
    assert.equal(project.settings.reviewPolicy, 'orchestrator-review');
    assert.equal(project.settings.autoMergeEligible, false);
    const policyPatched = await fetch(`${base}/api/projects/${project.id}`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ settings: { reviewPolicy: 'full-review', autoMergeEligible: true } }),
    }).then(body);
    assert.equal(policyPatched.ok, true);
    assert.equal(policyPatched.project.settings.reviewPolicy, 'full-review');
    assert.equal(policyPatched.project.settings.autoMergeEligible, true);
    const policyDetail = await fetch(`${base}/api/projects/${project.id}`).then(body);
    assert.equal(policyDetail.settings.reviewPolicy, 'full-review');
    assert.equal(policyDetail.settings.autoMergeEligible, true);

    // list is ProjectDto[]
    const list = await fetch(`${base}/api/projects`).then(body);
    assert.ok(Array.isArray(list.projects) && list.projects.some((p: { id: string }) => p.id === project.id));

    // detail is a RAW ProjectDto (web reads getJson<ProjectDto> unwrapped)
    const detail = await fetch(`${base}/api/projects/${project.id}`).then(body);
    assert.equal(detail.id, project.id);

    // session new → transition + SessionSummary
    const newSess = await fetch(`${base}/api/projects/${project.id}/sessions/new`, { method: 'POST' }).then(body);
    assert.equal(newSess.ok, true);
    assert.equal(newSess.transition, 'new-session');
    assert.ok(newSess.session.id);
    assert.equal(newSess.session.status, 'active');
    assert.deepEqual(newSess.session.selection, {
      runtimeId: TEST_RUNTIME_ID,
      accountId: 'personal',
      model: 'opus',
      effort: { kind: 'none' },
    });
    assert.equal(newSess.session.nativeSessionIdPresent, false);
    assert.equal(newSess.session.continuationState, 'clean-pending');
    assert.deepEqual(newSess.session.resumeAvailability, {
      status: 'unavailable', code: 'session-active',
    });
    assert.equal('nativeSessionId' in newSess.session, false);

    // list sessions → SessionSummary[]
    const sessions = await fetch(`${base}/api/projects/${project.id}/sessions`).then(body);
    assert.equal(sessions.ok, true);
    assert.ok(sessions.sessions.some((s: { id: string }) => s.id === newSess.session.id));

    // events → { ok, events, highWaterSequence }
    const events = await fetch(`${base}/api/projects/${project.id}/sessions/${newSess.session.id}/events`).then(body);
    assert.equal(events.ok, true);
    assert.ok(Array.isArray(events.events));
    assert.equal(typeof events.highWaterSequence, 'number');

    // A route project cannot read another project's conversation by guessing
    // its session id.
    const otherDir = mkdtempSync(join(tmpdir(), 'pc-probe-other-'));
    const other = await fetch(`${base}/api/projects`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'Beta', folder_path: otherDir, mode: 'init-empty' }),
    }).then(body);
    const foreignEvents = await fetch(
      `${base}/api/projects/${other.project.id}/sessions/${newSess.session.id}/events`,
    );
    assert.equal(foreignEvents.status, 404);

    // pasted image → multipart 'image' field
    const form = new FormData();
    form.append('image', new Blob([new Uint8Array([1, 2, 3])], { type: 'image/png' }), 'p.png');
    const img = await fetch(`${base}/api/projects/${project.id}/pasted-images`, {
      method: 'POST',
      body: form,
    }).then(body);
    assert.equal(img.ok, true);
    assert.ok(img.path.endsWith('.png'));
  } finally {
    await server.close();
  }
});

test('projects: init-empty rejects a directory that became nonempty after probing', async () => {
  freshDb();
  const { server, base } = await boot();
  const root = mkdtempSync(join(tmpdir(), 'pc-project-mode-drift-empty-'));
  const dir = join(root, 'selected');
  mkdirSync(dir);
  try {
    const projectCountBefore = listProjects().length;
    const probe = await fetch(`${base}/api/fs/probe`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ path: dir }),
    }).then(body);
    assert.equal(probe.probe.hasFiles, false);
    assert.equal(probe.probe.isGitRepo, false);

    const arrivedAfterProbe = join(dir, 'arrived-after-probe.txt');
    writeFileSync(arrivedAfterProbe, 'preserve me\n', 'utf8');
    const response = await requestProjectCreation(base, {
      name: 'Stale init-empty',
      folderPath: dir,
      mode: 'init-empty',
    });

    assert.equal(response.status, 409);
    assert.equal((await body(response)).ok, false);
    assert.equal(listProjects().length, projectCountBefore);
    assert.equal(existsSync(join(dir, '.git')), false);
    assert.equal(readFileSync(arrivedAfterProbe, 'utf8'), 'preserve me\n');
  } finally {
    await closeFixture(server, root);
  }
});

test('projects: init-in-place rejects a directory that became empty after probing', async () => {
  freshDb();
  const { server, base } = await boot();
  const root = mkdtempSync(join(tmpdir(), 'pc-project-mode-drift-in-place-'));
  const dir = join(root, 'selected');
  mkdirSync(dir);
  const removedAfterProbe = join(dir, 'removed-after-probe.txt');
  writeFileSync(removedAfterProbe, 'temporary\n', 'utf8');
  try {
    const projectCountBefore = listProjects().length;
    const probe = await fetch(`${base}/api/fs/probe`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ path: dir }),
    }).then(body);
    assert.equal(probe.probe.hasFiles, true);
    assert.equal(probe.probe.isGitRepo, false);

    rmSync(removedAfterProbe);
    assert.deepEqual(readdirSync(dir), []);
    const response = await requestProjectCreation(base, {
      name: 'Stale init-in-place',
      folderPath: dir,
      mode: 'init-in-place',
    });

    assert.equal(response.status, 409);
    assert.equal((await body(response)).ok, false);
    assert.equal(listProjects().length, projectCountBefore);
    assert.equal(existsSync(join(dir, '.git')), false);
    assert.deepEqual(readdirSync(dir), []);
  } finally {
    await closeFixture(server, root);
  }
});

test('projects: init modes reject an existing Git repository instead of attaching it', async () => {
  freshDb();
  const { server, base } = await boot();
  const root = mkdtempSync(join(tmpdir(), 'pc-project-init-existing-git-'));
  try {
    const projectCountBefore = listProjects().length;
    for (const mode of ['init-empty', 'init-in-place'] as const) {
      const dir = join(root, mode);
      await initializeCommittedRepository(dir);
      const probe = await fetch(`${base}/api/fs/probe`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ path: dir }),
      }).then(body);
      assert.equal(probe.probe.isGitRepo, true);
      const headBefore = await requiredGit(['rev-parse', 'HEAD'], dir);
      const statusBefore = await requiredGit(['status', '--porcelain'], dir);
      assert.equal(statusBefore, '');

      const response = await requestProjectCreation(base, {
        name: `Existing Git via ${mode}`,
        folderPath: dir,
        mode,
      });

      assert.equal(response.status, 409);
      assert.equal((await body(response)).ok, false);
      assert.equal(listProjects().length, projectCountBefore);
      assert.equal(await requiredGit(['rev-parse', 'HEAD'], dir), headBefore);
      assert.equal(await requiredGit(['status', '--porcelain'], dir), statusBefore);
    }
  } finally {
    await closeFixture(server, root);
  }
});

test('projects: valid init-in-place imports files, commits, and binds repository identity', async () => {
  freshDb();
  const { server, base } = await boot();
  const root = mkdtempSync(join(tmpdir(), 'pc-project-init-in-place-'));
  const dir = join(root, 'selected');
  mkdirSync(dir);
  writeFileSync(join(dir, 'seed.txt'), 'seed\n', 'utf8');
  try {
    const projectCountBefore = listProjects().length;
    const probe = await fetch(`${base}/api/fs/probe`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ path: dir }),
    }).then(body);
    assert.equal(probe.probe.hasFiles, true);
    assert.equal(probe.probe.isGitRepo, false);

    const response = await requestProjectCreation(base, {
      name: 'Initial import project',
      folderPath: dir,
      mode: 'init-in-place',
    });
    assert.equal(response.status, 201);
    const created = await body(response);
    assert.equal(created.ok, true);
    const persisted = getProjectById(created.project.id);

    assert.equal(listProjects().length, projectCountBefore + 1);
    assert.equal(persisted?.folderPath, dir);
    assert.equal(persisted?.repositoryIdentity?.protocol, 'git-common-dir-v1');
    assert.ok(persisted?.repositoryIdentity?.gitCommonDir);
    assert.match(persisted?.repositoryIdentity?.leaseKey ?? '', /^sha256:/);
    assert.equal(await requiredGit(['log', '-1', '--format=%s'], dir), 'Initial import');
    assert.equal(await requiredGit(['rev-list', '--count', 'HEAD'], dir), '1');
    assert.equal(await requiredGit(['ls-files'], dir), 'seed.txt');
    assert.equal(await requiredGit(['status', '--porcelain'], dir), '');
  } finally {
    await closeFixture(server, root);
  }
});

test('projects: attach-to-git rejects a repository subdirectory without side effects', async () => {
  freshDb();
  const { server, base } = await boot();
  const root = mkdtempSync(join(tmpdir(), 'pc-project-attach-subdir-'));
  const repo = join(root, 'repository');
  await initializeCommittedRepository(repo);
  const selected = join(repo, 'nested');
  mkdirSync(selected);
  const trackedPath = join(selected, 'tracked.txt');
  writeFileSync(trackedPath, 'tracked before attach\n', 'utf8');
  await requiredGit(['add', 'nested/tracked.txt'], repo);
  await requiredGit(['commit', '-m', 'add nested fixture'], repo);
  try {
    const projectCountBefore = listProjects().length;
    const headBefore = await requiredGit(['rev-parse', 'HEAD'], repo);
    const commitCountBefore = await requiredGit(['rev-list', '--count', 'HEAD'], repo);
    const statusBefore = await requiredGit(['status', '--porcelain'], repo);
    assert.equal(statusBefore, '');
    assert.equal(existsSync(join(selected, '.git')), false);

    const response = await requestProjectCreation(base, {
      name: 'Nested attach',
      folderPath: selected,
      mode: 'attach-to-git',
    });

    assert.equal(response.status, 409);
    assert.equal((await body(response)).ok, false);
    assert.equal(listProjects().length, projectCountBefore);
    assert.equal(listProjects().some((project) => project.folderPath === selected), false);
    assert.equal(await requiredGit(['rev-parse', 'HEAD'], repo), headBefore);
    assert.equal(await requiredGit(['rev-list', '--count', 'HEAD'], repo), commitCountBefore);
    assert.equal(await requiredGit(['status', '--porcelain'], repo), statusBefore);
    assert.equal(readFileSync(trackedPath, 'utf8'), 'tracked before attach\n');
    assert.equal(existsSync(join(selected, '.git')), false);
  } finally {
    await closeFixture(server, root);
  }
});

test('subscription quota HTTP returns exact durable truth after outbox pruning; old usage route is dead', async () => {
  freshDb();
  const { server, base, subscriptionQuota } = await boot();
  try {
    const recorded = subscriptionQuota.record({
      runtimeId: TEST_RUNTIME_ID,
      accountId: 'personal',
      availability: 'available',
      coverage: 'complete',
      observedAt: 1_000,
      observations: [{
        window: { id: 'five-hour', label: '5h', durationMs: 18_000_000 },
        scope: { kind: 'account' },
        source: { semantics: 'used', fraction: 0.4 },
        confidence: 'exact',
        limitState: 'allowed',
        resetsAt: null,
      }],
    });
    assert.ok(listLiveOutboxRowsAfter('0', 100).some((row) =>
      row.entity === 'subscription-quota' && row.entityId === recorded.snapshot.id));
    pruneLiveOutbox({ maxRows: 0 });
    assert.equal(listLiveOutboxRowsAfter('0', 100).length, 0);

    const response = await fetch(`${base}/api/subscription-quota`);
    assert.equal(response.status, 200);
    const value: unknown = await response.json();
    assert.equal(isSubscriptionQuotaListResponse(value), true);
    assert.deepEqual(value, { ok: true, snapshots: [recorded.snapshot] });
    assert.deepEqual(Object.keys(value as Record<string, unknown>).sort(), ['ok', 'snapshots']);

    assert.equal((await fetch(`${base}/api/usage`)).status, 404);
  } finally {
    await server.close();
  }
});

test('accounts: registry list; switching a project account ends the session + mints a new one', async () => {
  freshDb();
  const { server, base } = await boot();
  const dir = mkdtempSync(join(tmpdir(), 'pc-acct-'));
  try {
    // registry list + server default
    const reg = await fetch(`${base}/api/accounts`).then(body);
    assert.ok(Array.isArray(reg.accounts) && reg.accounts.some((a: { id: string }) => a.id === 'personal'));
    assert.equal(reg.defaultAccountId, 'personal');

    const created = await fetch(`${base}/api/projects`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'Acct', folder_path: dir, mode: 'init-empty' }),
    }).then(body);
    const pid = created.project.id;

    // per-project current default
    assert.equal((await fetch(`${base}/api/projects/${pid}/account`).then(body)).accountId, 'personal');

    // start a session under the current account
    const sess = await fetch(`${base}/api/projects/${pid}/sessions/new`, { method: 'POST' }).then(body);
    const oldSessionId = sess.session.id;
    const initialService = server.registry.get(pid);
    assert.equal((await initialService.handleSend({
      type: 'send', commandId: 'bind-personal-session', sessionId: oldSessionId,
      text: 'bind the native session', clientMessageId: 'bind-personal-client',
    })).status, 'applied');
    await until(() => getOrchestratorSession(oldSessionId)?.nativeIdentityState === 'bound');
    await until(() => getActiveConversationTurn(oldSessionId) === null);

    // switch account → ends the old session, mints a new one
    const sw = await fetch(`${base}/api/projects/${pid}/account`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ accountId: 'work' }),
    }).then(body);
    assert.equal(sw.accountId, 'work');
    assert.equal(sw.switched, true);
    assert.ok(sw.session && sw.session.id && sw.session.id !== oldSessionId);
    assert.equal(sw.session.selection.accountId, 'work');
    assert.equal(sw.session.continuationState, 'clean-pending');
    assert.equal(sw.session.nativeSessionIdPresent, false);

    // the change is persisted as the project default
    assert.equal((await fetch(`${base}/api/projects/${pid}/account`).then(body)).accountId, 'work');

    // old session ended, new session active
    const list = await fetch(`${base}/api/projects/${pid}/sessions`).then(body);
    const oldSummary = list.sessions.find((s: { id: string }) => s.id === oldSessionId);
    assert.equal(oldSummary.status, 'ended');
    assert.equal(oldSummary.selection.accountId, 'personal');
    assert.equal(oldSummary.nativeSessionIdPresent, true);
    assert.equal(oldSummary.continuationState, 'clean-started');
    assert.deepEqual(oldSummary.resumeAvailability, { status: 'available' });
    assert.equal(oldSummary.continuationState === 'legacy-unavailable', false);
    assert.equal(list.sessions.find((s: { id: string }) => s.id === sw.session.id).status, 'active');

    // same account again → no-op, no new session
    const noop = await fetch(`${base}/api/projects/${pid}/account`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ accountId: 'work' }),
    }).then(body);
    assert.equal(noop.switched, false);
    assert.equal(noop.session, null);

    // Historical account A resumes through its immutable stamp even though the
    // project default remains B. This is native continuation, never a clean fallback.
    const resumedResponse = await fetch(
      `${base}/api/projects/${pid}/sessions/${oldSessionId}/resume`,
      { method: 'POST' },
    );
    assert.equal(resumedResponse.status, 200);
    const resumed = await body(resumedResponse);
    assert.equal(resumed.transition, 'resume-session');
    assert.equal(resumed.session.id, oldSessionId);
    assert.equal(resumed.session.selection.accountId, 'personal');
    assert.equal(resumed.session.resumeAvailability.code, 'session-active');
    assert.equal((await fetch(`${base}/api/projects/${pid}/account`).then(body)).accountId, 'personal');
    assert.equal(getProjectById(pid)?.settings.defaultAccountId, 'work');

    // unknown account → 400
    const bad = await fetch(`${base}/api/projects/${pid}/account`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ accountId: 'nope' }),
    });
    assert.equal(bad.status, 400);
  } finally {
    await server.close();
  }
});

test('account switch rolls back setting, queue, and old session when replacement creation fails', async () => {
  freshDb();
  const { server, base } = await boot();
  const dir = mkdtempSync(join(tmpdir(), 'pc-acct-rollback-'));
  try {
    const created = await fetch(`${base}/api/projects`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'Acct rollback', folder_path: dir, mode: 'init-empty' }),
    }).then(body);
    const projectId = created.project.id;
    const started = await fetch(
      `${base}/api/projects/${projectId}/sessions/new`,
      { method: 'POST' },
    ).then(body);
    const sessionId = started.session.id;
    assert.equal(enqueueConversationSend({
      projectId,
      conversationId: sessionId,
      sessionId,
      commandId: 'account-rollback-send',
      clientMessageId: 'account-rollback-client',
      text: 'preserve me',
      origin: 'user',
    }).status, 'applied');

    const raw = getRawDb();
    raw.exec(`
      CREATE TEMP TRIGGER fail_account_replacement
      BEFORE INSERT ON orchestrator_sessions
      BEGIN SELECT RAISE(ABORT, 'forced account replacement failure'); END;
    `);
    const failed = await fetch(`${base}/api/projects/${projectId}/account`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ accountId: 'work' }),
    });
    raw.exec('DROP TRIGGER fail_account_replacement');
    assert.equal(failed.status, 500);

    assert.equal(getProjectById(projectId)?.settings.defaultAccountId, null);
    assert.equal(getActiveOrchestratorSession(projectId)?.id, sessionId);
    assert.equal(getConversationQueueSnapshot(sessionId).items[0]?.status, 'queued');
  } finally {
    await server.close();
  }
});

test('project delete cancels idle FIFO state and fences an already-held service', async () => {
  freshDb();
  const { server, base } = await boot();
  const dir = mkdtempSync(join(tmpdir(), 'pc-delete-fence-'));
  try {
    const created = await fetch(`${base}/api/projects`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'Delete fence', folder_path: dir, mode: 'init-empty' }),
    }).then(body);
    const projectId = created.project.id;
    const started = await fetch(
      `${base}/api/projects/${projectId}/sessions/new`,
      { method: 'POST' },
    ).then(body);
    const sessionId = started.session.id;
    const heldService = server.registry.get(projectId);
    assert.equal(enqueueConversationSend({
      projectId,
      conversationId: sessionId,
      sessionId,
      commandId: 'delete-fence-send',
      clientMessageId: 'delete-fence-client',
      text: 'cancel me',
      origin: 'user',
    }).status, 'applied');

    const deleted = await fetch(`${base}/api/projects/${projectId}`, { method: 'DELETE' });
    assert.equal(deleted.status, 200);
    assert.equal(getProjectById(projectId), null);
    assert.equal(getActiveOrchestratorSession(projectId), null);
    assert.deepEqual(getConversationQueueSnapshot(sessionId).items, []);

    const afterDelete = await heldService.handleSend({
      type: 'send', commandId: 'delete-fence-after', sessionId,
      text: 'must not execute', clientMessageId: 'delete-fence-after-client',
    });
    assert.equal(afterDelete.status, 'rejected');
    assert.equal(afterDelete.error?.code, 'session-changed');
  } finally {
    await server.close();
  }
});
