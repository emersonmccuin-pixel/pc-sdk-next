// BC-002 current-state browser fixture.
//
// This file intentionally lives under test/ without a *.test.ts suffix: the
// server TypeScript project checks it, while the normal node:test command does
// not execute it. It composes the real HTTP/WS/static server around only
// deterministic test runtimes and a disposable database. No provider, MCP,
// poller, launcher, boot recovery, or stable user data participates.

import { existsSync, mkdirSync, rmSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { ContractService, SubscriptionQuotaService } from '@pc/app-services';
import {
  conversationFamilyForEvent,
  safeToolSummary,
  type ConversationEvent,
  type ToolStateEvent,
} from '@pc/contracts';
import {
  closeDb,
  commitConversationEvent,
  confirmRuntimeSessionReceipt,
  createOrchestratorSession,
  createProject,
  endOrchestratorSession,
  insertAgentRunRow,
  markWorktreeStranded,
  newId,
  prepareRuntimeSessionCreate,
  setGlobalSettings,
  setProjectFocus,
  touchAgentRunActivity,
  updateProjectNotes,
  upsertWorktree,
  type OrchestratorSessionRow,
} from '@pc/db';
import {
  defaultGlobalSettings,
  type AgentRunStatus,
  type Project,
  type RunLifecycleState,
  type ULID,
} from '@pc/domain';

import { seedStockAgents } from '../src/agents/seed.ts';
import { DispatchService } from '../src/dispatch/service.ts';
import { AccountRegistry } from '../src/runner/account-env.ts';
import { FakeRuntime, type ScriptedTurn } from '../src/runner/fake-runtime.ts';
import { RuntimeRegistry } from '../src/runner/runtime.ts';
import { startServer, type RunningServer } from '../src/server.ts';
import {
  advanceTestAgentRunStatus,
  freshDb,
  testAgentRunExecution,
  testDispatchRuntimeDeps,
} from './helpers.ts';
import {
  TEST_RUNTIME_ID,
  TEST_SELECTION,
  testSessionSelectionDeps,
  withRuntimeReceipt,
} from './runtime-fixtures.ts';

const fixtureDir = dirname(fileURLToPath(import.meta.url));
const webDist = join(fixtureDir, '..', '..', 'web', 'dist');

const HANG_TURN: ScriptedTurn = [
  { type: 'activity-state', phase: 'requesting-runtime' },
  {
    type: 'assistant-block',
    itemId: 'fixture-live-hang',
    scope: 'primary',
    block: {
      kind: 'text',
      text: 'The deterministic fixture is holding this turn open for queue and interrupt checks.',
    },
  },
  { hang: true },
];

const richToolRequested: ToolStateEvent = {
  kind: 'tool-state',
  callId: 'fixture-rich-read',
  name: 'Read',
  state: 'requested',
  safeSummary: safeToolSummary('Read'),
  approval: { status: 'unknown', source: null, requestId: null },
  outcome: null,
};

const richToolRunning: ToolStateEvent = {
  ...richToolRequested,
  state: 'running',
  approval: { status: 'not-required', source: 'runtime', requestId: null },
};

const RICH_TURN: ScriptedTurn = [
  { type: 'activity-state', phase: 'requesting-runtime' },
  { type: 'delta', itemId: 'fixture-rich-answer', scope: 'primary', delta: { kind: 'message-start' } },
  {
    type: 'delta',
    itemId: 'fixture-rich-answer',
    scope: 'primary',
    delta: { kind: 'text-delta', text: 'Recovered after the confirmed interrupt. ' },
  },
  {
    type: 'tool-state',
    scope: 'primary',
    event: richToolRequested,
  },
  {
    type: 'tool-state',
    scope: 'primary',
    event: richToolRunning,
  },
  {
    type: 'tool-state',
    scope: 'primary',
    event: { ...richToolRunning, state: 'succeeded' },
  },
  {
    type: 'compaction',
    trigger: 'auto',
    preTokens: 96_000,
    postTokens: 28_000,
  },
  {
    type: 'system',
    subtype: 'fixture-notice',
    level: 'notice',
    message: 'Deterministic browser-baseline evidence is active.',
  },
  {
    type: 'delta',
    itemId: 'fixture-rich-answer',
    scope: 'primary',
    delta: { kind: 'text-delta', text: 'The rich follow-up turn completed normally.' },
  },
  { type: 'delta', itemId: 'fixture-rich-answer', scope: 'primary', delta: { kind: 'message-end' } },
  {
    type: 'assistant-block',
    itemId: 'fixture-rich-answer',
    scope: 'primary',
    block: {
      kind: 'text',
      text: 'Recovered after the confirmed interrupt. The rich follow-up turn completed normally.',
    },
  },
  {
    type: 'result',
    ok: true,
    stopReason: 'complete',
    usage: {
      inputTokens: 1_200,
      outputTokens: 180,
      cacheCreationTokens: 64,
      cacheReadTokens: 320,
      model: 'opus',
    },
    durationMs: 1_250,
    error: null,
    outcome: 'ok',
    numTurns: 2,
  },
];

interface SeedReceipt {
  alpha: Project;
  beta: Project;
  alphaHistory: OrchestratorSessionRow;
  alphaActive: OrchestratorSessionRow;
  betaActive: OrchestratorSessionRow;
  runningRunId: ULID;
  mergeReadyRunId: ULID;
  landingIssueRunId: ULID;
}

let dataDir: string | null = null;
let server: RunningServer | null = null;
let dispatch: DispatchService | null = null;
let shuttingDown = false;

async function main(): Promise<void> {
  if (!existsSync(join(webDist, 'index.html'))) {
    throw new Error(
      `production web bundle is missing at ${webDist}; run "pnpm --filter @pc-sdk/web build" first`,
    );
  }

  dataDir = freshDb();
  const seeded = seedFixture(dataDir);
  const subscriptionQuota = seedSubscriptionQuota();
  const credentialRoot = join(dataDir, 'fixture-credentials');
  const personalCredentials = join(credentialRoot, 'personal');
  const workCredentials = join(credentialRoot, 'work');
  mkdirSync(personalCredentials, { recursive: true });
  mkdirSync(workCredentials, { recursive: true });
  const accounts = new AccountRegistry([
    { id: 'personal', runtimeId: TEST_RUNTIME_ID, configDir: personalCredentials },
    { id: 'work', runtimeId: TEST_RUNTIME_ID, configDir: workCredentials },
  ]);

  // Dispatch is supplied so the real agent-run, contract, transcript, and
  // stranded-worktree read routes mount. The empty runtime registry is never
  // consulted: this fixture does not invoke specialists.
  dispatch = new DispatchService({
    ...testDispatchRuntimeDeps(new RuntimeRegistry()),
  });

  const port = fixturePort();
  server = await startServer({
    ...testSessionSelectionDeps(),
    mintSession: withRuntimeReceipt(() => new FakeRuntime({
      turns: [HANG_TURN, RICH_TURN],
      stepDelayMs: 20,
      contextObservation: {
        confidence: 'exact',
        usedTokens: 42_000,
        usableTokens: 180_000,
        contextWindowTokens: 200_000,
      },
    })),
    accounts,
    orchestratorRuntimeId: TEST_RUNTIME_ID,
    subscriptionQuota,
    dispatch,
    webDist,
    port,
    instanceId: 'pc-sdk-next-bc-002',
    version: 'bc-002-fixture',
    runRecovery: false,
    drainIntervalMs: 20,
  });

  const receipt = {
    type: 'browser-baseline-fixture-ready',
    instanceId: 'pc-sdk-next-bc-002',
    url: `http://127.0.0.1:${server.port}`,
    port: server.port,
    dataDir,
    webDist,
    projects: {
      alpha: { id: seeded.alpha.id, slug: seeded.alpha.slug },
      beta: { id: seeded.beta.id, slug: seeded.beta.slug },
    },
    sessions: {
      alphaHistory: seeded.alphaHistory.id,
      alphaActive: seeded.alphaActive.id,
      betaActive: seeded.betaActive.id,
    },
    runs: {
      running: seeded.runningRunId,
      mergeReady: seeded.mergeReadyRunId,
      landingIssue: seeded.landingIssueRunId,
    },
    turnScript: ['hang-until-interrupt', 'rich-complete'],
  } as const;
  process.stdout.write(`${JSON.stringify(receipt)}\n`);

  const autoExitMs = fixtureAutoExitMs();
  if (autoExitMs !== null) {
    setTimeout(() => { void shutdown(0); }, autoExitMs);
  }
}

function seedFixture(root: string): SeedReceipt {
  const now = Date.now();
  const projectsRoot = join(root, 'fixture-projects');
  const alphaDir = join(projectsRoot, 'alpha');
  const betaDir = join(projectsRoot, 'beta');
  mkdirSync(alphaDir, { recursive: true });
  mkdirSync(betaDir, { recursive: true });

  setGlobalSettings({
    ...defaultGlobalSettings(root, join(root, 'fixture-home')),
    onboardingCompletedAt: '2026-07-12T00:00:00.000Z',
    projectsFolder: projectsRoot,
    activityPanel: { open: true, showAllProjects: false },
    showCommandSpace: false,
    commandIntroDismissed: true,
  });

  const alpha = createProject({
    name: 'Alpha',
    slug: 'alpha',
    folderPath: alphaDir,
    position: 0,
  });
  const beta = createProject({
    name: 'Beta',
    slug: 'beta',
    folderPath: betaDir,
    position: 1,
  });
  updateProjectNotes(
    alpha.id,
    'BC-002 fixture scratchpad: browser evidence stays isolated from daily-driver data.',
  );
  setProjectFocus(beta.id, true);
  seedStockAgents();

  const alphaHistory = bindSession(createOrchestratorSession({
    projectId: alpha.id,
    selection: TEST_SELECTION,
    title: 'Alpha planning history',
    now: now - 3_600_000,
  }), 'fixture-native-alpha-history');
  seedSettledConversation({
    projectId: alpha.id,
    sessionId: alphaHistory.id,
    turnId: 'fixture-alpha-history-turn',
    at: now - 3_500_000,
    userText: 'Summarize the accepted browser-baseline scope.',
    assistantText: 'The baseline records observable behavior without changing product behavior.',
    context: {
      confidence: 'derived',
      usedTokens: 31_000,
      usableTokens: 180_000,
      contextWindowTokens: 200_000,
    },
  });
  endOrchestratorSession(alphaHistory.id, 'user_ended');

  const alphaActive = bindSession(createOrchestratorSession({
    projectId: alpha.id,
    selection: TEST_SELECTION,
    title: 'Alpha browser characterization',
    now: now - 900_000,
  }), 'fixture-native-alpha-active');
  seedRichCurrentConversation(alpha.id, alphaActive.id, now - 600_000);

  const betaActive = bindSession(createOrchestratorSession({
    projectId: beta.id,
    selection: TEST_SELECTION,
    title: 'Beta isolated conversation',
    now: now - 800_000,
  }), 'fixture-native-beta-active');
  seedSettledConversation({
    projectId: beta.id,
    sessionId: betaActive.id,
    turnId: 'fixture-beta-turn',
    at: now - 500_000,
    userText: 'Keep this project conversation separate from Alpha.',
    assistantText: 'Beta has its own durable session and replay.',
    context: { confidence: 'unavailable', reason: 'unsupported' },
  });

  const runningRunId = seedAgentRun({
    projectId: alpha.id,
    dispatcherSessionId: alphaActive.id,
    podName: 'code-writer',
    status: 'running',
    lifecycleState: 'building',
    queuedAt: now - 480_000,
    input: 'Characterize the current browser shell.',
  });
  touchAgentRunActivity(runningRunId, now - 30_000);
  seedRunningAgentTranscript(alpha.id, runningRunId, now - 420_000);

  const mergeReadyRunId = seedAgentRun({
    projectId: alpha.id,
    dispatcherSessionId: alphaActive.id,
    podName: 'reviewer',
    status: 'completed',
    lifecycleState: 'merge-ready',
    queuedAt: now - 720_000,
    input: 'Review deterministic browser evidence.',
  });
  seedTerminalAgentTranscript(
    alpha.id,
    mergeReadyRunId,
    now - 680_000,
    'Browser evidence is coherent and ready for orchestrator review.',
    true,
  );

  const landingIssueRunId = seedAgentRun({
    projectId: alpha.id,
    dispatcherSessionId: alphaActive.id,
    podName: 'code-writer',
    status: 'failed',
    lifecycleState: 'failed',
    queuedAt: now - 840_000,
    input: 'Exercise preserved landing failure presentation.',
  });
  seedTerminalAgentTranscript(
    alpha.id,
    landingIssueRunId,
    now - 820_000,
    'Landing stopped safely and preserved the worktree.',
    false,
  );

  const contracts = new ContractService();
  const mergeReady = contracts.create({
    projectId: alpha.id,
    agentRunId: mergeReadyRunId,
    podName: 'reviewer',
    expectedOutput: { kind: 'repo' },
    landingPolicy: 'default-review',
  });
  contracts.setVerification({
    id: mergeReady.id,
    verificationStatus: 'passed',
    verificationNotes: 'Deterministic checks passed; parked for orchestrator review.',
  });

  const landingIssue = contracts.create({
    projectId: alpha.id,
    agentRunId: landingIssueRunId,
    podName: 'code-writer',
    expectedOutput: { kind: 'repo' },
    landingPolicy: 'default-review',
  });
  contracts.setVerification({
    id: landingIssue.id,
    verificationStatus: 'passed',
    verificationNotes: 'Verification passed before the simulated landing conflict.',
  });
  contracts.setLanding({
    id: landingIssue.id,
    landingStatus: 'conflict',
    landedBranch: 'codex/fixture-landing-conflict',
    landingError: 'Simulated conflict: work preserved for explicit resolution.',
  });

  const strandedPath = join(root, 'fixture-worktrees', 'stranded-browser-evidence');
  mkdirSync(strandedPath, { recursive: true });
  upsertWorktree({
    name: 'stranded-browser-evidence',
    path: strandedPath,
    projectId: alpha.id,
    agentRunId: landingIssueRunId,
    contractId: landingIssue.id as ULID,
    branch: 'codex/fixture-stranded',
    baseBranch: 'main',
    baseSha: 'a'.repeat(40),
  });
  markWorktreeStranded('stranded-browser-evidence', 'no-live-run', now - 300_000);

  return {
    alpha,
    beta,
    alphaHistory,
    alphaActive,
    betaActive,
    runningRunId,
    mergeReadyRunId,
    landingIssueRunId,
  };
}

function bindSession(session: OrchestratorSessionRow, nativeSessionId: string): OrchestratorSessionRow {
  const prepared = prepareRuntimeSessionCreate(session.id);
  if (!prepared?.continuationAttemptId) {
    throw new Error(`could not prepare fixture session ${session.id}`);
  }
  const confirmation = confirmRuntimeSessionReceipt({
    sessionId: session.id,
    receipt: {
      mode: 'created',
      selection: TEST_SELECTION,
      continuationAttemptId: prepared.continuationAttemptId,
      nativeSessionId,
      requestedNativeSessionId: null,
    },
  });
  if (confirmation.status !== 'confirmed') {
    throw new Error(`could not bind fixture session ${session.id}: ${confirmation.reason}`);
  }
  return confirmation.session;
}

function seedRichCurrentConversation(projectId: ULID, sessionId: ULID, at: number): void {
  const turnId = 'fixture-alpha-current-turn';
  const requested: ToolStateEvent = {
    kind: 'tool-state',
    callId: 'fixture-seeded-read',
    name: 'Read',
    state: 'requested',
    safeSummary: safeToolSummary('Read'),
    approval: { status: 'unknown', source: null, requestId: null },
    outcome: null,
  };
  const running: ToolStateEvent = {
    ...requested,
    state: 'running',
    approval: { status: 'not-required', source: 'runtime', requestId: null },
  };
  const events: Array<{ event: ConversationEvent; itemId: string }> = [
    {
      event: { kind: 'user', text: 'Capture the current browser behavior with honest runtime evidence.' },
      itemId: 'fixture-seeded-user',
    },
    { event: { kind: 'activity-state', phase: 'turn-starting' }, itemId: 'fixture-seeded-starting' },
    {
      event: {
        kind: 'assistant-text',
        text: 'I am inspecting the production shell and its durable projections.',
        midLoop: false,
      },
      itemId: 'fixture-seeded-assistant-1',
    },
    { event: requested, itemId: requested.callId },
    { event: running, itemId: running.callId },
    { event: { ...running, state: 'succeeded' }, itemId: running.callId },
    {
      event: {
        kind: 'assistant-text',
        text: 'The current shell replays typed chat, tool, activity, context, and quota evidence.',
        midLoop: true,
      },
      itemId: 'fixture-seeded-assistant-2',
    },
    {
      event: {
        kind: 'system',
        subtype: 'fixture-baseline',
        level: 'notice',
        message: 'This is isolated BC-002 fixture data, not a live provider result.',
      },
      itemId: 'fixture-seeded-system',
    },
    {
      event: { kind: 'compaction', trigger: 'auto', preTokens: 88_000, postTokens: 26_000 },
      itemId: 'fixture-seeded-compaction',
    },
    {
      event: {
        kind: 'usage',
        inputTokens: 1_024,
        outputTokens: 256,
        cacheCreationTokens: 32,
        cacheReadTokens: 128,
        model: 'opus',
      },
      itemId: 'fixture-seeded-usage',
    },
    { event: { kind: 'turn-duration', durationMs: 1_800 }, itemId: 'fixture-seeded-duration' },
    {
      event: {
        kind: 'turn-end',
        text: 'The current shell replays typed chat, tool, activity, context, and quota evidence.',
        stopReason: 'complete',
      },
      itemId: 'fixture-seeded-terminal',
    },
    {
      event: {
        kind: 'context-observation',
        confidence: 'exact',
        usedTokens: 42_000,
        usableTokens: 180_000,
        contextWindowTokens: 200_000,
      },
      itemId: 'fixture-seeded-context',
    },
    {
      event: { kind: 'session-state', state: 'idle', permissionMode: null },
      itemId: 'fixture-seeded-idle',
    },
  ];
  events.forEach(({ event, itemId }, index) => {
    seedConversationEvent({
      projectId,
      conversationId: sessionId,
      sessionId,
      turnId,
      itemId,
      event,
      occurredAt: at + index * 250,
      deliveryKind: 'chat',
    });
  });
}

function seedSettledConversation(input: {
  projectId: ULID;
  sessionId: ULID;
  turnId: string;
  at: number;
  userText: string;
  assistantText: string;
  context:
    | { confidence: 'exact' | 'derived' | 'approximate'; usedTokens: number; usableTokens: number; contextWindowTokens: number }
    | { confidence: 'unavailable'; reason: 'unsupported' };
}): void {
  const events: Array<{ event: ConversationEvent; itemId: string }> = [
    { event: { kind: 'user', text: input.userText }, itemId: `${input.turnId}-user` },
    {
      event: { kind: 'activity-state', phase: 'turn-starting' },
      itemId: `${input.turnId}-starting`,
    },
    {
      event: { kind: 'assistant-text', text: input.assistantText, midLoop: false },
      itemId: `${input.turnId}-assistant`,
    },
    {
      event: { kind: 'turn-end', text: input.assistantText, stopReason: 'complete' },
      itemId: `${input.turnId}-terminal`,
    },
    {
      event: { kind: 'context-observation', ...input.context },
      itemId: `${input.turnId}-context`,
    },
    {
      event: { kind: 'session-state', state: 'idle', permissionMode: null },
      itemId: `${input.turnId}-idle`,
    },
  ];
  events.forEach(({ event, itemId }, index) => {
    seedConversationEvent({
      projectId: input.projectId,
      conversationId: input.sessionId,
      sessionId: input.sessionId,
      turnId: input.turnId,
      itemId,
      event,
      occurredAt: input.at + index * 250,
      deliveryKind: 'chat',
    });
  });
}

function seedAgentRun(input: {
  projectId: ULID;
  dispatcherSessionId: ULID;
  podName: string;
  status: AgentRunStatus;
  lifecycleState: RunLifecycleState;
  queuedAt: number;
  input: string;
}): ULID {
  const id = newId() as ULID;
  insertAgentRunRow({
    id,
    projectId: input.projectId,
    dispatcherSessionId: input.dispatcherSessionId,
    ...testAgentRunExecution(input.podName, TEST_SELECTION),
    status: 'queued',
    input: input.input,
    lifecycleState: input.lifecycleState,
    queuedAt: input.queuedAt,
  });
  advanceTestAgentRunStatus(id, input.status);
  return id;
}

function seedRunningAgentTranscript(projectId: ULID, runId: ULID, at: number): void {
  const turnId = `fixture-agent-turn-${runId}`;
  const requested: ToolStateEvent = {
    kind: 'tool-state',
    callId: `fixture-agent-read-${runId}`,
    name: 'Read',
    state: 'requested',
    safeSummary: safeToolSummary('Read'),
    approval: { status: 'unknown', source: null, requestId: null },
    outcome: null,
  };
  const running: ToolStateEvent = {
    ...requested,
    state: 'running',
    approval: { status: 'not-required', source: 'runtime', requestId: null },
  };
  const events: Array<{ event: ConversationEvent; itemId: string }> = [
    {
      event: { kind: 'user', text: 'Characterize the current production browser shell.' },
      itemId: `${turnId}-user`,
    },
    { event: { kind: 'activity-state', phase: 'turn-starting' }, itemId: `${turnId}-activity` },
    {
      event: { kind: 'assistant-text', text: 'Inspecting the isolated fixture state.', midLoop: false },
      itemId: `${turnId}-assistant`,
    },
    { event: requested, itemId: requested.callId },
    { event: running, itemId: running.callId },
  ];
  events.forEach(({ event, itemId }, index) => {
    seedConversationEvent({
      projectId,
      conversationId: runId,
      sessionId: runId,
      turnId,
      itemId,
      event,
      occurredAt: at + index * 250,
      deliveryKind: 'agent',
    });
  });
}

function seedTerminalAgentTranscript(
  projectId: ULID,
  runId: ULID,
  at: number,
  text: string,
  ok: boolean,
): void {
  const turnId = `fixture-agent-turn-${runId}`;
  const terminal: ConversationEvent = ok
    ? { kind: 'turn-end', text, stopReason: 'complete' }
    : { kind: 'turn-failed', error: text, source: 'internal' };
  const events: Array<{ event: ConversationEvent; itemId: string }> = [
    {
      event: { kind: 'assistant-text', text, midLoop: false },
      itemId: `${turnId}-assistant`,
    },
    { event: terminal, itemId: `${turnId}-terminal` },
  ];
  events.forEach(({ event, itemId }, index) => {
    seedConversationEvent({
      projectId,
      conversationId: runId,
      sessionId: runId,
      turnId,
      itemId,
      event,
      occurredAt: at + index * 250,
      deliveryKind: 'agent',
    });
  });
}

function seedConversationEvent(input: {
  projectId: ULID;
  conversationId: string;
  sessionId: string;
  turnId: string;
  itemId: string;
  event: ConversationEvent;
  occurredAt: number;
  deliveryKind: 'chat' | 'agent';
}): void {
  commitConversationEvent({
    ...input,
    family: conversationFamilyForEvent(input.event),
  });
}

function seedSubscriptionQuota(): SubscriptionQuotaService {
  const now = Date.now();
  const observedAt = now - 120_000;
  const service = new SubscriptionQuotaService();
  service.record({
    runtimeId: TEST_RUNTIME_ID,
    accountId: 'personal',
    availability: 'available',
    coverage: 'complete',
    observedAt,
    observations: [
      {
        window: { id: 'five-hour', label: '5 hour', durationMs: 18_000_000 },
        scope: { kind: 'account' },
        source: { semantics: 'used', fraction: 0.64 },
        confidence: 'exact',
        limitState: 'allowed',
        resetsAt: now + 10_800_000,
      },
      {
        window: { id: 'seven-day', label: '7 day', durationMs: 604_800_000 },
        scope: { kind: 'model', model: 'opus' },
        source: { semantics: 'remaining', fraction: 0.18 },
        confidence: 'approximate',
        limitState: 'warning',
        resetsAt: now + 259_200_000,
      },
      {
        window: { id: 'stale-fixture', label: 'Stale fixture', durationMs: null },
        scope: { kind: 'account' },
        source: { semantics: 'used', fraction: 0.93 },
        confidence: 'exact',
        limitState: 'rejected',
        resetsAt: observedAt,
      },
    ],
  });
  service.record({
    runtimeId: TEST_RUNTIME_ID,
    accountId: 'work',
    availability: 'unavailable',
    reason: 'runtime-unavailable',
    observedAt,
  });
  return service;
}

function fixturePort(): number {
  const value = Number(process.env.PC_BROWSER_PORT ?? 5524);
  if (!Number.isSafeInteger(value) || value < 0 || value > 65_535) {
    throw new Error('PC_BROWSER_PORT must be an integer from 0 through 65535');
  }
  return value;
}

/** Verification-only clean exit. Browser runs leave this unset and stop the
 * fixture through SIGINT/SIGTERM. */
function fixtureAutoExitMs(): number | null {
  const raw = process.env.PC_BROWSER_AUTO_EXIT_MS;
  if (raw === undefined) return null;
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value < 100 || value > 60_000) {
    throw new Error('PC_BROWSER_AUTO_EXIT_MS must be an integer from 100 through 60000');
  }
  return value;
}

async function cleanup(): Promise<void> {
  const activeDispatch = dispatch;
  dispatch = null;
  await activeDispatch?.disposeAll().catch(() => {});

  const activeServer = server;
  server = null;
  await activeServer?.close().catch(() => {});

  closeDb();
  const disposable = dataDir;
  dataDir = null;
  if (disposable) {
    try {
      rmSync(disposable, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
    } catch {
      // The startup receipt retains the exact directory for manual cleanup if
      // Windows still has a short-lived handle open during signal shutdown.
    }
  }
}

async function shutdown(code: number): Promise<void> {
  if (shuttingDown) return;
  shuttingDown = true;
  await cleanup();
  process.exit(code);
}

process.once('SIGINT', () => { void shutdown(0); });
process.once('SIGTERM', () => { void shutdown(0); });

void main().catch(async (error: unknown) => {
  await cleanup();
  const message = error instanceof Error ? error.stack ?? error.message : String(error);
  process.stderr.write(`${message}\n`);
  process.exitCode = 1;
});
