// BC-002 preserved-browser fixture artifact.
//
// This file is intentionally inert under docs/. To reproduce the preserved
// subject, copy it byte-for-byte to
// `apps/server/test/browser-baseline-fixture.ts` in a disposable detached
// worktree at e233aa54c58dca163e98cf6011e79a0b91bd2d6f, build apps/web/dist,
// and run it with that worktree's `tsx`. It uses only the historical server,
// DB, HTTP/WS, and FakeRuntime seams. It must never be run through index.ts,
// the launcher, smoke, a provider adapter, an MCP manager, or a usage poller.

import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import {
  dirname,
  isAbsolute,
  join,
  relative,
  resolve,
} from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  closeDb,
  createProject,
  getGlobalSettings,
  runMigrations,
  setGlobalSettings,
  updateProjectNotes,
} from '@pc/db';

import { seedStockAgents } from '../src/agents/seed.ts';
import { AccountRegistry } from '../src/runner/account-env.ts';
import {
  FakeRuntime,
  type ScriptedTurn,
} from '../src/runner/fake-runtime.ts';
import { startServer, type RunningServer } from '../src/server.ts';
import { UsageCache } from '../src/usage/cache.ts';

const PRESERVED_SHA = 'e233aa54c58dca163e98cf6011e79a0b91bd2d6f';
const PRESERVED_REPLY = 'Preserved baseline reply.';
const FIXTURE_ACCOUNT_ID = 'fixture';
const DEFAULT_PORT = 55_823;

const fixtureDir = dirname(fileURLToPath(import.meta.url));
const webDist = resolve(fixtureDir, '..', '..', 'web', 'dist');

// The browser's read-only activity surfaces need their historical routes to be
// mounted. Those GET routes read the DB directly. The only dispatch method a
// read route can call is hasLiveRun; mutation routes are outside this fixture's
// contract and deliberately have no implementation.
const READ_ONLY_DISPATCH = Object.freeze({
  hasLiveRun: (_runId: string): boolean => false,
});

let server: RunningServer | null = null;
let runRoot: string | null = null;
let exitTimer: NodeJS.Timeout | null = null;
let shutdownPromise: Promise<void> | null = null;

function preservedTurn(sequence: number): ScriptedTurn {
  const itemId = `preserved-answer-${sequence}`;
  return [
    {
      type: 'init',
      sdkSessionId: `fixture-native-session-${sequence}`,
      model: 'fixture-model',
      permissionMode: 'default',
    },
    {
      type: 'delta',
      sdkUuid: itemId,
      parentToolUseId: null,
      delta: { kind: 'message-start' },
    },
    {
      type: 'delta',
      sdkUuid: itemId,
      parentToolUseId: null,
      delta: { kind: 'text-delta', text: PRESERVED_REPLY },
    },
    {
      type: 'assistant-block',
      sdkUuid: itemId,
      parentToolUseId: null,
      block: { kind: 'text', text: PRESERVED_REPLY },
    },
    {
      type: 'result',
      ok: true,
      subtype: 'success',
      stopReason: 'end_turn',
      usage: {
        inputTokens: 12,
        outputTokens: 4,
        cacheCreationTokens: 0,
        cacheReadTokens: 0,
        model: 'fixture-model',
      },
      durationMs: 1,
      error: null,
      outcome: 'ok',
      numTurns: 1,
    },
  ];
}

function parsePort(): number {
  const raw = process.env.PC_BROWSER_BASELINE_PORT ?? process.env.PC_PORT;
  const port = raw === undefined || raw.trim() === '' ? DEFAULT_PORT : Number(raw);
  if (!Number.isInteger(port) || port < 1 || port > 65_535) {
    throw new Error(`invalid browser-baseline port: ${JSON.stringify(raw)}`);
  }
  return port;
}

function parseAutoExitMs(): number {
  const raw = process.env.PC_BROWSER_BASELINE_AUTO_EXIT_MS;
  if (raw === undefined || raw.trim() === '') return 0;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < 0 || value > 3_600_000) {
    throw new Error(`invalid PC_BROWSER_BASELINE_AUTO_EXIT_MS: ${JSON.stringify(raw)}`);
  }
  return value;
}

function assertTempChild(path: string): void {
  const tempRoot = resolve(tmpdir());
  const candidate = resolve(path);
  const rel = relative(tempRoot, candidate);
  if (rel === '' || rel.startsWith('..') || isAbsolute(rel)) {
    throw new Error(`fixture path must be a child of the OS temp root: ${candidate}`);
  }
}

function allocateRunRoot(): string {
  const requested = process.env.PC_BROWSER_BASELINE_ROOT?.trim();
  if (!requested) {
    const created = mkdtempSync(join(resolve(tmpdir()), 'pc-sdk-next-bc002-e233aa-'));
    assertTempChild(created);
    return created;
  }

  const candidate = resolve(requested);
  assertTempChild(candidate);
  if (existsSync(candidate)) {
    throw new Error(`refusing to reuse or remove an existing fixture root: ${candidate}`);
  }
  mkdirSync(candidate, { recursive: true });
  return candidate;
}

function makeDirectory(path: string): string {
  mkdirSync(path, { recursive: true });
  return path;
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.stack ?? error.message : String(error);
}

async function shutdown(reason: string, requestedExitCode: number): Promise<void> {
  if (shutdownPromise) return shutdownPromise;
  shutdownPromise = (async () => {
    if (exitTimer) {
      clearTimeout(exitTimer);
      exitTimer = null;
    }

    let exitCode = requestedExitCode;
    try {
      await server?.close();
    } catch (error) {
      exitCode = 1;
      console.error(JSON.stringify({
        type: 'browser-baseline-preserved-cleanup-error',
        phase: 'server-close',
        error: errorText(error),
      }));
    } finally {
      server = null;
    }

    try {
      closeDb();
    } catch (error) {
      exitCode = 1;
      console.error(JSON.stringify({
        type: 'browser-baseline-preserved-cleanup-error',
        phase: 'db-close',
        error: errorText(error),
      }));
    }

    const ownedRoot = runRoot;
    let removed = ownedRoot === null;
    if (ownedRoot) {
      try {
        assertTempChild(ownedRoot);
        rmSync(ownedRoot, {
          recursive: true,
          force: false,
          maxRetries: 5,
          retryDelay: 50,
        });
        removed = !existsSync(ownedRoot);
        if (!removed) throw new Error(`fixture root still exists: ${ownedRoot}`);
      } catch (error) {
        exitCode = 1;
        console.error(JSON.stringify({
          type: 'browser-baseline-preserved-cleanup-error',
          phase: 'temp-root-remove',
          root: ownedRoot,
          error: errorText(error),
        }));
      }
    }

    console.log(JSON.stringify({
      type: 'browser-baseline-preserved-stopped',
      reason,
      pid: process.pid,
      runRoot: ownedRoot,
      removed,
      exitCode,
    }));
    process.exitCode = exitCode;
  })();
  return shutdownPromise;
}

async function main(): Promise<void> {
  if (!existsSync(join(webDist, 'index.html'))) {
    throw new Error(`production web bundle missing: ${webDist}`);
  }

  const port = parsePort();
  const autoExitMs = parseAutoExitMs();
  runRoot = allocateRunRoot();

  const dataDir = makeDirectory(join(runRoot, 'data'));
  const projectsRoot = makeDirectory(join(runRoot, 'projects'));
  const commandDir = makeDirectory(join(projectsRoot, 'Command'));
  const alphaDir = makeDirectory(join(projectsRoot, 'Alpha'));
  const betaDir = makeDirectory(join(projectsRoot, 'Beta'));
  const credentialsRoot = makeDirectory(join(runRoot, 'fixture-credentials'));
  const claudeConfigDir = makeDirectory(join(credentialsRoot, 'claude'));
  const codexHome = makeDirectory(join(credentialsRoot, 'codex'));
  const localAppData = makeDirectory(join(runRoot, 'localappdata'));

  // Launch-time DB and credential selectors are forced under the owned temp
  // root. Scrub credentials even though no provider adapter is imported.
  process.env.PC_DATA_DIR = dataDir;
  process.env.PC_PORT = String(port);
  process.env.LOCALAPPDATA = localAppData;
  process.env.CLAUDE_CONFIG_DIR = claudeConfigDir;
  process.env.CODEX_HOME = codexHome;
  delete process.env.ANTHROPIC_API_KEY;
  delete process.env.ANTHROPIC_AUTH_TOKEN;

  // Fail closed if a future accidental dependency tries an outbound fetch.
  // Browser fetches occur in the browser process and are unaffected.
  globalThis.fetch = (async (input: string | URL | Request) => {
    throw new Error(`outbound Node fetch disabled by preserved fixture: ${String(input)}`);
  }) as typeof fetch;

  runMigrations();
  const seeded = seedStockAgents();

  const settings = getGlobalSettings();
  if (!settings) throw new Error('global settings were not seeded by migrations');
  setGlobalSettings({
    ...settings,
    onboardingCompletedAt: '2026-07-12T00:00:00.000Z',
    projectsFolder: projectsRoot,
    activityPanel: { open: true, showAllProjects: false },
    showCommandSpace: true,
    commandIntroDismissed: true,
  });

  const command = createProject({
    name: 'Command',
    slug: 'command',
    folderPath: commandDir,
    position: -1,
    settings: { defaultAccountId: FIXTURE_ACCOUNT_ID },
  });
  const alpha = createProject({
    name: 'Alpha',
    slug: 'alpha',
    folderPath: alphaDir,
    settings: { defaultAccountId: FIXTURE_ACCOUNT_ID },
  });
  const beta = createProject({
    name: 'Beta',
    slug: 'beta',
    folderPath: betaDir,
    settings: { defaultAccountId: FIXTURE_ACCOUNT_ID },
  });
  updateProjectNotes(alpha.id, 'Isolated preserved-baseline scratchpad.');

  const accountConfigDir = makeDirectory(join(claudeConfigDir, FIXTURE_ACCOUNT_ID));
  const accounts = new AccountRegistry(
    [{ id: FIXTURE_ACCOUNT_ID, configDir: accountConfigDir }],
    FIXTURE_ACCOUNT_ID,
  );
  const usage = new UsageCache();
  usage.hydrateFromDb();

  let mintedRuntimeCount = 0;
  server = await startServer({
    mintSession: () => new FakeRuntime({
      turns: [preservedTurn(++mintedRuntimeCount)],
      stepDelayMs: 5,
    }),
    port,
    webDist,
    runRecovery: false,
    accounts,
    usage,
    dispatch: READ_ONLY_DISPATCH as never,
    version: `bc002-preserved-${PRESERVED_SHA.slice(0, 8)}`,
  });

  console.log(JSON.stringify({
    type: 'browser-baseline-preserved-ready',
    preservedSha: PRESERVED_SHA,
    pid: process.pid,
    url: `http://127.0.0.1:${server.port}`,
    port: server.port,
    runRoot,
    dataDir,
    projectsRoot,
    credentialHomes: {
      claudeConfigDir,
      codexHome,
      accountConfigDir,
    },
    webDist,
    projects: {
      command: { id: command.id, slug: command.slug },
      alpha: { id: alpha.id, slug: alpha.slug },
      beta: { id: beta.id, slug: beta.slug },
    },
    seededAgents: seeded,
    fakeReply: PRESERVED_REPLY,
    provider: 'fake-only',
    nodeFetch: 'disabled',
    recovery: false,
    autoExitMs,
  }));

  if (autoExitMs > 0) {
    exitTimer = setTimeout(() => {
      void shutdown('auto-exit', 0);
    }, autoExitMs);
  }
}

process.once('SIGINT', () => {
  void shutdown('SIGINT', 0);
});
process.once('SIGTERM', () => {
  void shutdown('SIGTERM', 0);
});
process.once('uncaughtException', (error) => {
  console.error(JSON.stringify({
    type: 'browser-baseline-preserved-error',
    phase: 'uncaught-exception',
    error: errorText(error),
  }));
  void shutdown('uncaught-exception', 1);
});
process.once('unhandledRejection', (error) => {
  console.error(JSON.stringify({
    type: 'browser-baseline-preserved-error',
    phase: 'unhandled-rejection',
    error: errorText(error),
  }));
  void shutdown('unhandled-rejection', 1);
});

void main().catch(async (error) => {
  console.error(JSON.stringify({
    type: 'browser-baseline-preserved-error',
    phase: 'startup',
    error: errorText(error),
  }));
  await shutdown('startup-error', 1);
});
