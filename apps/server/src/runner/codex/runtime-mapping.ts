import {
  isRuntimeSelection,
  runtimeSelectionsEqual,
  type RuntimeModelDiscovery,
  type RuntimeSelection,
} from '@pc/contracts';

import {
  CODEX_MODEL_PROVIDER,
  CODEX_PROTOCOL_VERSION,
  CODEX_RUNTIME_ID,
  CODEX_RUNTIME_NOTIFICATION_METHODS,
  CODEX_RUNTIME_REQUEST_METHODS,
  type CodexExecutionPolicyChallenge,
  type CodexProviderFreeExecutionPolicyReceipt,
  type CodexProviderFreeTurnBoundaryReceipt,
  type CodexTurnBoundaryChallenge,
} from './runtime-peer.ts';
import type { ThreadItem } from './generated/v2/ThreadItem.ts';

export type CodexRuntimeMappingErrorCode =
  | 'discovery-invalid'
  | 'execution-policy-invalid'
  | 'thread-response-invalid'
  | 'turn-response-invalid'
  | 'runtime-notification-invalid'
  | 'runtime-notification-unsafe'
  | 'turn-boundary-invalid'
  | 'interrupt-response-invalid';

/** Durable-safe adapter failure. Native payloads and provider prose never
 * participate in the message. */
export class CodexRuntimeMappingError extends Error {
  readonly name = 'CodexRuntimeMappingError';

  constructor(readonly code: CodexRuntimeMappingErrorCode) {
    super(`Codex runtime mapping unavailable: ${code}`);
  }
}

export interface CapturedCodexThreadReceipt {
  nativeThreadId: string;
  historicalTurnIds: string[];
  historicalItemIds: string[];
  policyReceipt: CodexProviderFreeExecutionPolicyReceipt;
}

interface CapturedCodexThread {
  nativeThreadId: string;
  historicalTurnIds: string[];
  historicalItemIds: string[];
}

export type CapturedCodexRuntimeNotification =
  | { kind: 'turn-started'; threadId: string; turnId: string }
  | { kind: 'agent-message-started'; threadId: string; turnId: string; itemId: string }
  | {
      kind: 'agent-message-delta';
      threadId: string;
      turnId: string;
      itemId: string;
      delta: string;
    }
  | {
      kind: 'agent-message-completed';
      threadId: string;
      turnId: string;
      itemId: string;
      text: string;
      phase: 'commentary' | 'final_answer' | null;
    }
  | {
      kind: 'turn-completed';
      threadId: string;
      turnId: string;
      status: 'completed' | 'interrupted' | 'failed';
      durationMs: number | null;
      items: Array<{
        itemId: string;
        text: string;
        phase: 'commentary' | 'final_answer' | null;
      }>;
    };

export function captureCodexDiscovery(
  value: unknown,
  expectedAccountId: string,
): RuntimeModelDiscovery {
  return guarded('discovery-invalid', () => {
    if (!isRecord(value)) fail('discovery-invalid');
    const status = value.status;
    const protocolVersion = value.protocolVersion;
    const runtimeId = value.runtimeId;
    const accountId = value.accountId;
    if (protocolVersion !== CODEX_PROTOCOL_VERSION || runtimeId !== CODEX_RUNTIME_ID ||
      accountId !== expectedAccountId) fail('discovery-invalid');

    if (status === 'unavailable') {
      exactKeys(value, ['status', 'protocolVersion', 'runtimeId', 'accountId', 'code'],
        'discovery-invalid');
      const code = value.code;
      if (!exactString(code)) fail('discovery-invalid');
      return {
        status: 'unavailable',
        code: code === 'account-unavailable'
          ? 'account-unavailable'
          : 'codex-discovery-unavailable',
      };
    }

    exactKeys(value, ['status', 'protocolVersion', 'runtimeId', 'accountId', 'models'],
      'discovery-invalid');
    const rawModels = value.models;
    if (status !== 'available' || !Array.isArray(rawModels)) {
      fail('discovery-invalid');
    }
    const modelValues = [...rawModels];
    if (modelValues.length === 0) fail('discovery-invalid');

    const ids = new Set<string>();
    const models = modelValues.map((model) => {
      if (!isRecord(model)) fail('discovery-invalid');
      exactKeys(model, ['id', 'resolvedId', 'label', 'description', 'effort'],
        'discovery-invalid');
      const id = model.id;
      const resolvedId = model.resolvedId;
      const label = model.label;
      const description = model.description;
      const effort = model.effort;
      if (!exactString(id) || ids.has(id) ||
        (resolvedId !== null && !exactString(resolvedId)) ||
        !exactString(label) || typeof description !== 'string' || !isRecord(effort)) {
        fail('discovery-invalid');
      }
      ids.add(id);

      const effortStatus = effort.status;
      if (effortStatus === 'supported') {
        exactKeys(effort, ['status', 'values'], 'discovery-invalid');
        const rawValues = effort.values;
        if (!Array.isArray(rawValues)) fail('discovery-invalid');
        const values = [...rawValues];
        if (!distinctExactStrings(values)) fail('discovery-invalid');
        return {
          id,
          resolvedId,
          label,
          description,
          effort: { status: 'supported' as const, values },
        };
      }

      exactKeys(effort, ['status', 'code'], 'discovery-invalid');
      const effortCode = effort.code;
      if (effortStatus !== 'unsupported' || !exactString(effortCode)) {
        fail('discovery-invalid');
      }
      return {
        id,
        resolvedId,
        label,
        description,
        effort: { status: 'unsupported' as const, code: 'codex-model-effort-unsupported' },
      };
    });

    return { status: 'available', models };
  });
}

export function captureProviderFreePolicyReceipt(
  value: unknown,
  challenge: CodexExecutionPolicyChallenge,
): CodexProviderFreeExecutionPolicyReceipt {
  return guarded('execution-policy-invalid', () => {
    if (!isRecord(value)) fail('execution-policy-invalid');
    exactKeys(value, [
      'kind',
      'protocolVersion',
      'runtimeId',
      'continuationAttemptId',
      'selection',
      'mode',
      'requestedThreadId',
      'cwd',
      'requestMethods',
      'notificationMethods',
      'effectiveNativeTools',
      'effectiveMcpServers',
      'approvalRequests',
      'lifecycle',
    ], 'execution-policy-invalid');
    if (
      value.kind !== 'provider-free-conformance' ||
      value.protocolVersion !== CODEX_PROTOCOL_VERSION ||
      value.runtimeId !== CODEX_RUNTIME_ID ||
      value.continuationAttemptId !== challenge.continuationAttemptId ||
      value.mode !== challenge.mode ||
      value.requestedThreadId !== challenge.requestedThreadId ||
      value.cwd !== challenge.cwd ||
      !isRuntimeSelection(value.selection) ||
      !runtimeSelectionsEqual(value.selection, challenge.selection) ||
      !sameStrings(value.requestMethods, CODEX_RUNTIME_REQUEST_METHODS) ||
      !sameStrings(value.notificationMethods, CODEX_RUNTIME_NOTIFICATION_METHODS) ||
      !Array.isArray(value.effectiveNativeTools) || value.effectiveNativeTools.length !== 0 ||
      !Array.isArray(value.effectiveMcpServers) || value.effectiveMcpServers.length !== 0 ||
      value.approvalRequests !== 'disabled' ||
      value.lifecycle !== 'contained-fake'
    ) fail('execution-policy-invalid');

    return {
      kind: 'provider-free-conformance',
      protocolVersion: CODEX_PROTOCOL_VERSION,
      runtimeId: CODEX_RUNTIME_ID,
      continuationAttemptId: challenge.continuationAttemptId,
      selection: cloneSelection(challenge.selection),
      mode: challenge.mode,
      requestedThreadId: challenge.requestedThreadId,
      cwd: challenge.cwd,
      requestMethods: [...CODEX_RUNTIME_REQUEST_METHODS],
      notificationMethods: [...CODEX_RUNTIME_NOTIFICATION_METHODS],
      effectiveNativeTools: [],
      effectiveMcpServers: [],
      approvalRequests: 'disabled',
      lifecycle: 'contained-fake',
    };
  });
}

export function captureThreadPeerReceipt(
  value: unknown,
  challenge: CodexExecutionPolicyChallenge,
): CapturedCodexThreadReceipt {
  return guarded('thread-response-invalid', () => {
    if (!isRecord(value)) fail('thread-response-invalid');
    exactKeys(value, ['policyReceipt', 'response'], 'thread-response-invalid');
    const policyReceipt = captureProviderFreePolicyReceipt(value.policyReceipt, challenge);
    const response = value.response;
    if (!isRecord(response)) fail('thread-response-invalid');
    exactKeys(response, [
      'thread',
      'model',
      'modelProvider',
      'serviceTier',
      'cwd',
      'instructionSources',
      'approvalPolicy',
      'approvalsReviewer',
      'sandbox',
      'reasoningEffort',
    ], 'thread-response-invalid');
    const rawThread = response.thread;
    const model = response.model;
    const modelProvider = response.modelProvider;
    const serviceTier = response.serviceTier;
    const cwd = response.cwd;
    const instructionSources = response.instructionSources;
    const approvalPolicy = response.approvalPolicy;
    const approvalsReviewer = response.approvalsReviewer;
    const sandbox = response.sandbox;
    const reasoningEffort = response.reasoningEffort;
    if (
      model !== challenge.selection.model || modelProvider !== CODEX_MODEL_PROVIDER ||
      serviceTier !== null || cwd !== challenge.cwd ||
      !Array.isArray(instructionSources) || instructionSources.length !== 0 ||
      approvalPolicy !== 'never' || approvalsReviewer !== 'user' ||
      !isReadOnlySandbox(sandbox) || reasoningEffort !== selectedEffort(challenge.selection)
    ) fail('thread-response-invalid');

    const thread = captureThread(rawThread, challenge.cwd, challenge.mode);
    if (challenge.mode === 'resume' && thread.nativeThreadId !== challenge.requestedThreadId) {
      fail('thread-response-invalid');
    }
    return { ...thread, policyReceipt };
  });
}

export function captureTurnStartResponse(value: unknown): string {
  return guarded('turn-response-invalid', () => {
    if (!isRecord(value)) fail('turn-response-invalid');
    exactKeys(value, ['turn'], 'turn-response-invalid');
    const turn = captureTurn(value.turn, ['inProgress'], 'turn-response-invalid');
    if (turn.itemsView !== 'full' || turn.items.length !== 0 || turn.error !== null ||
      turn.completedAt !== null ||
      turn.durationMs !== null) fail('turn-response-invalid');
    return turn.id;
  });
}

export function captureRuntimeNotification(value: unknown): CapturedCodexRuntimeNotification {
  return guarded('runtime-notification-invalid', () => {
    if (!isRecord(value)) fail('runtime-notification-invalid');
    exactKeys(value, ['method', 'params'], 'runtime-notification-invalid');
    const method = value.method;
    const rawParams = value.params;
    if (typeof method !== 'string' || !isRecord(rawParams)) {
      fail('runtime-notification-invalid');
    }
    const params = rawParams;

    switch (method) {
      case 'turn/started': {
        exactKeys(params, ['threadId', 'turn'], 'runtime-notification-invalid');
        const threadId = params.threadId;
        const rawTurn = params.turn;
        if (!exactString(threadId)) fail('runtime-notification-invalid');
        const turn = captureTurn(rawTurn, ['inProgress'], 'runtime-notification-invalid');
        if (turn.itemsView !== 'full' || turn.items.length !== 0 || turn.error !== null ||
          turn.completedAt !== null ||
          turn.durationMs !== null) fail('runtime-notification-invalid');
        return { kind: 'turn-started', threadId, turnId: turn.id };
      }
      case 'item/started': {
        const captured = captureItemParams(params, 'startedAtMs');
        const item = captureAgentMessage(captured.item, false);
        return {
          kind: 'agent-message-started',
          threadId: captured.threadId,
          turnId: captured.turnId,
          itemId: item.id,
        };
      }
      case 'item/agentMessage/delta': {
        exactKeys(params, ['threadId', 'turnId', 'itemId', 'delta'],
          'runtime-notification-invalid');
        const threadId = params.threadId;
        const turnId = params.turnId;
        const itemId = params.itemId;
        const delta = params.delta;
        if (!exactString(threadId) || !exactString(turnId) || !exactString(itemId) ||
          typeof delta !== 'string' || delta.length === 0) fail('runtime-notification-invalid');
        return {
          kind: 'agent-message-delta',
          threadId,
          turnId,
          itemId,
          delta,
        };
      }
      case 'item/completed': {
        const captured = captureItemParams(params, 'completedAtMs');
        const item = captureAgentMessage(captured.item, true);
        return {
          kind: 'agent-message-completed',
          threadId: captured.threadId,
          turnId: captured.turnId,
          itemId: item.id,
          text: item.text,
          phase: item.phase,
        };
      }
      case 'turn/completed': {
        exactKeys(params, ['threadId', 'turn'], 'runtime-notification-invalid');
        const threadId = params.threadId;
        const rawTurn = params.turn;
        if (!exactString(threadId)) fail('runtime-notification-invalid');
        const turn = captureTurn(
          rawTurn,
          ['completed', 'interrupted', 'failed'],
          'runtime-notification-invalid',
        );
        if (turn.status === 'inProgress') fail('runtime-notification-invalid');
        if (turn.itemsView !== 'full') fail('runtime-notification-invalid');
        const items = turn.items.map((item) => captureAgentMessage(item, true));
        if (turn.status === 'failed') {
          if (!isTurnError(turn.error)) fail('runtime-notification-invalid');
        } else if (turn.error !== null) {
          fail('runtime-notification-invalid');
        }
        return {
          kind: 'turn-completed',
          threadId,
          turnId: turn.id,
          status: turn.status,
          durationMs: turn.durationMs,
          items: items.map((item) => ({
            itemId: item.id,
            text: item.text,
            phase: item.phase,
          })),
        };
      }
      default:
        fail('runtime-notification-unsafe');
    }
  });
}

export function captureInterruptResponse(value: unknown): void {
  guarded('interrupt-response-invalid', () => {
    if (!isRecord(value)) fail('interrupt-response-invalid');
    exactKeys(value, [], 'interrupt-response-invalid');
  });
}

export function captureProviderFreeTurnBoundaryReceipt(
  value: unknown,
  challenge: CodexTurnBoundaryChallenge,
): CodexProviderFreeTurnBoundaryReceipt {
  return guarded('turn-boundary-invalid', () => {
    if (!isRecord(value)) fail('turn-boundary-invalid');
    exactKeys(value, [
      'kind',
      'protocolVersion',
      'runtimeId',
      'continuationAttemptId',
      'threadId',
      'turnId',
      'turnSequence',
      'status',
      'notificationBoundary',
      'pendingNotifications',
    ], 'turn-boundary-invalid');
    if (
      value.kind !== 'provider-free-conformance-turn-boundary' ||
      value.protocolVersion !== CODEX_PROTOCOL_VERSION ||
      value.runtimeId !== CODEX_RUNTIME_ID ||
      value.continuationAttemptId !== challenge.continuationAttemptId ||
      value.threadId !== challenge.threadId ||
      value.turnId !== challenge.turnId ||
      value.turnSequence !== challenge.turnSequence ||
      value.status !== challenge.status ||
      value.notificationBoundary !== 'closed-fake' ||
      value.pendingNotifications !== 0
    ) fail('turn-boundary-invalid');
    return {
      kind: 'provider-free-conformance-turn-boundary',
      protocolVersion: CODEX_PROTOCOL_VERSION,
      runtimeId: CODEX_RUNTIME_ID,
      continuationAttemptId: challenge.continuationAttemptId,
      threadId: challenge.threadId,
      turnId: challenge.turnId,
      turnSequence: challenge.turnSequence,
      status: challenge.status,
      notificationBoundary: 'closed-fake',
      pendingNotifications: 0,
    };
  });
}

function captureThread(
  value: unknown,
  expectedCwd: string,
  mode: 'create' | 'resume',
): CapturedCodexThread {
  if (!isRecord(value)) fail('thread-response-invalid');
  exactKeys(value, [
    'id', 'sessionId', 'forkedFromId', 'parentThreadId', 'preview', 'ephemeral',
    'modelProvider', 'createdAt', 'updatedAt', 'recencyAt', 'status', 'path', 'cwd',
    'cliVersion', 'source', 'threadSource', 'agentNickname', 'agentRole', 'gitInfo',
    'name', 'turns',
  ], 'thread-response-invalid');
  const id = value.id;
  const sessionId = value.sessionId;
  const forkedFromId = value.forkedFromId;
  const parentThreadId = value.parentThreadId;
  const preview = value.preview;
  const ephemeral = value.ephemeral;
  const modelProvider = value.modelProvider;
  const createdAt = value.createdAt;
  const updatedAt = value.updatedAt;
  const recencyAt = value.recencyAt;
  const status = value.status;
  const path = value.path;
  const cwd = value.cwd;
  const cliVersion = value.cliVersion;
  const source = value.source;
  const threadSource = value.threadSource;
  const agentNickname = value.agentNickname;
  const agentRole = value.agentRole;
  const rawGitInfo = value.gitInfo;
  const name = value.name;
  const rawTurns = value.turns;
  if (
    !nativeId(id) || !exactString(sessionId) ||
    forkedFromId !== null || parentThreadId !== null ||
    typeof preview !== 'string' || ephemeral !== false ||
    modelProvider !== CODEX_MODEL_PROVIDER || !safeTimestamp(createdAt) ||
    !safeTimestamp(updatedAt) || (recencyAt !== null && !safeTimestamp(recencyAt)) ||
    !idleThreadStatus(status) || !nullableString(path) || cwd !== expectedCwd ||
    cliVersion !== CODEX_PROTOCOL_VERSION || source !== 'appServer' ||
    !nullableString(threadSource) || agentNickname !== null ||
    agentRole !== null || !gitInfo(rawGitInfo) || !nullableString(name) ||
    !Array.isArray(rawTurns)
  ) fail('thread-response-invalid');
  const turns = [...rawTurns];
  if (mode === 'create' && turns.length !== 0) fail('thread-response-invalid');
  const history = mode === 'resume'
    ? captureHistoricalTurns(turns)
    : { historicalTurnIds: [], historicalItemIds: [] };
  return {
    nativeThreadId: id,
    historicalTurnIds: history.historicalTurnIds,
    historicalItemIds: history.historicalItemIds,
  };
}

function captureTurn(
  value: unknown,
  statuses: readonly string[],
  code: CodexRuntimeMappingErrorCode,
): {
  id: string;
  items: unknown[];
  status: 'completed' | 'interrupted' | 'failed' | 'inProgress';
  itemsView: 'notLoaded' | 'summary' | 'full';
  error: unknown;
  completedAt: number | null;
  durationMs: number | null;
} {
  if (!isRecord(value)) fail(code);
  exactKeys(value, [
    'id', 'items', 'itemsView', 'status', 'error', 'startedAt', 'completedAt', 'durationMs',
  ], code);
  const id = value.id;
  const rawItems = value.items;
  const itemsView = value.itemsView;
  const status = value.status;
  const error = value.error;
  const startedAt = value.startedAt;
  const completedAt = value.completedAt;
  const durationMs = value.durationMs;
  if (!nativeId(id) || !Array.isArray(rawItems) ||
    !['notLoaded', 'summary', 'full'].includes(itemsView as string) ||
    typeof status !== 'string' || !statuses.includes(status) ||
    (startedAt !== null && !safeTimestamp(startedAt)) ||
    (completedAt !== null && !safeTimestamp(completedAt)) ||
    (durationMs !== null && !nonNegativeFinite(durationMs))) fail(code);
  const items = [...rawItems];
  return {
    id,
    items,
    status: status as 'completed' | 'interrupted' | 'failed' | 'inProgress',
    itemsView: itemsView as 'notLoaded' | 'summary' | 'full',
    error,
    completedAt: completedAt as number | null,
    durationMs: durationMs as number | null,
  };
}

function captureItemParams(
  value: Record<string, unknown>,
  timestampKey: string,
): { item: unknown; threadId: string; turnId: string } {
  exactKeys(value, ['item', 'threadId', 'turnId', timestampKey],
    'runtime-notification-invalid');
  const item = value.item;
  const threadId = value.threadId;
  const turnId = value.turnId;
  const timestamp = value[timestampKey];
  if (!exactString(threadId) || !exactString(turnId) || !safeTimestamp(timestamp)) {
    fail('runtime-notification-invalid');
  }
  return { item, threadId, turnId };
}

function captureAgentMessage(
  value: unknown,
  completed: boolean,
): { id: string; text: string; phase: 'commentary' | 'final_answer' | null } {
  if (!isRecord(value)) fail('runtime-notification-invalid');
  const type = value.type;
  if (type !== 'agentMessage') fail('runtime-notification-unsafe');
  exactKeys(value, ['type', 'id', 'text', 'phase', 'memoryCitation'],
    'runtime-notification-invalid');
  const id = value.id;
  const text = value.text;
  const phase = value.phase;
  const memoryCitation = value.memoryCitation;
  if (!exactString(id) || typeof text !== 'string' || memoryCitation !== null ||
    (phase !== null && !['commentary', 'final_answer'].includes(phase as string)) ||
    (!completed && text.length !== 0)) fail('runtime-notification-invalid');
  return {
    id,
    text,
    phase: phase as 'commentary' | 'final_answer' | null,
  };
}

function isTurnError(value: unknown): boolean {
  if (!isRecord(value)) return false;
  try {
    exactKeys(value, ['message', 'codexErrorInfo', 'additionalDetails'],
      'runtime-notification-invalid');
  } catch {
    return false;
  }
  return typeof value.message === 'string' &&
    (value.codexErrorInfo === null || isCodexErrorInfo(value.codexErrorInfo)) &&
    (value.additionalDetails === null || typeof value.additionalDetails === 'string');
}

const CODEX_ERROR_INFO_STRINGS = new Set([
  'contextWindowExceeded',
  'sessionBudgetExceeded',
  'usageLimitExceeded',
  'serverOverloaded',
  'cyberPolicy',
  'internalServerError',
  'unauthorized',
  'badRequest',
  'threadRollbackFailed',
  'sandboxError',
  'other',
]);

function isCodexErrorInfo(value: unknown): boolean {
  if (typeof value === 'string') return CODEX_ERROR_INFO_STRINGS.has(value);
  if (!isRecord(value) || Object.keys(value).length !== 1) return false;
  for (const key of [
    'httpConnectionFailed',
    'responseStreamConnectionFailed',
    'responseStreamDisconnected',
    'responseTooManyFailedAttempts',
  ]) {
    if (!owns(value, key)) continue;
    const detail = value[key];
    return isRecord(detail) && Object.keys(detail).length === 1 &&
      owns(detail, 'httpStatusCode') &&
      (detail.httpStatusCode === null ||
        (Number.isSafeInteger(detail.httpStatusCode) && (detail.httpStatusCode as number) >= 100));
  }
  if (!owns(value, 'activeTurnNotSteerable')) return false;
  const detail = value.activeTurnNotSteerable;
  return isRecord(detail) && Object.keys(detail).length === 1 && owns(detail, 'turnKind') &&
    (detail.turnKind === 'review' || detail.turnKind === 'compact');
}

interface HistoricalItemShape {
  required: readonly string[];
  optional?: readonly string[];
}

const HISTORICAL_ITEM_SHAPES = Object.freeze({
  userMessage: { required: ['type', 'id', 'clientId', 'content'] },
  hookPrompt: { required: ['type', 'id', 'fragments'] },
  agentMessage: { required: ['type', 'id', 'text', 'phase', 'memoryCitation'] },
  plan: { required: ['type', 'id', 'text'] },
  reasoning: { required: ['type', 'id', 'summary', 'content'] },
  commandExecution: {
    required: [
      'type', 'id', 'command', 'cwd', 'processId', 'source', 'status',
      'commandActions', 'aggregatedOutput', 'exitCode', 'durationMs',
    ],
  },
  fileChange: { required: ['type', 'id', 'changes', 'status'] },
  mcpToolCall: {
    required: [
      'type', 'id', 'server', 'tool', 'status', 'arguments', 'appContext',
      'pluginId', 'result', 'error', 'durationMs',
    ],
    optional: ['mcpAppResourceUri'],
  },
  dynamicToolCall: {
    required: [
      'type', 'id', 'namespace', 'tool', 'arguments', 'status', 'contentItems',
      'success', 'durationMs',
    ],
  },
  collabAgentToolCall: {
    required: [
      'type', 'id', 'tool', 'status', 'senderThreadId', 'receiverThreadIds',
      'prompt', 'model', 'reasoningEffort', 'agentsStates',
    ],
  },
  subAgentActivity: {
    required: ['type', 'id', 'kind', 'agentThreadId', 'agentPath'],
  },
  webSearch: { required: ['type', 'id', 'query', 'action'] },
  imageView: { required: ['type', 'id', 'path'] },
  sleep: { required: ['type', 'id', 'durationMs'] },
  imageGeneration: {
    required: ['type', 'id', 'status', 'revisedPrompt', 'result'],
    optional: ['savedPath'],
  },
  enteredReviewMode: { required: ['type', 'id', 'review'] },
  exitedReviewMode: { required: ['type', 'id', 'review'] },
  contextCompaction: { required: ['type', 'id'] },
} satisfies Record<ThreadItem['type'], HistoricalItemShape>);

function captureHistoricalTurns(value: unknown[]): {
  historicalTurnIds: string[];
  historicalItemIds: string[];
} {
  const turnIds = new Set<string>();
  const itemIds = new Set<string>();
  for (const entry of value) {
    const turn = captureTurn(
      entry,
      ['completed', 'interrupted', 'failed'],
      'thread-response-invalid',
    );
    if (turnIds.has(turn.id) || turn.itemsView !== 'full') fail('thread-response-invalid');
    turnIds.add(turn.id);
    if (turn.status === 'failed') {
      if (!isTurnError(turn.error)) fail('thread-response-invalid');
    } else if (turn.error !== null) {
      fail('thread-response-invalid');
    }
    for (const item of turn.items) {
      const itemId = captureHistoricalItem(item);
      if (itemIds.has(itemId)) fail('thread-response-invalid');
      itemIds.add(itemId);
    }
  }
  return {
    historicalTurnIds: [...turnIds],
    historicalItemIds: [...itemIds],
  };
}

function captureHistoricalItem(value: unknown): string {
  if (!isRecord(value)) fail('thread-response-invalid');
  const type = value.type;
  if (typeof type !== 'string' || !isHistoricalItemType(type)) {
    fail('thread-response-invalid');
  }
  const shape: HistoricalItemShape = HISTORICAL_ITEM_SHAPES[type];
  exactKeysWithOptional(
    value,
    shape.required,
    shape.optional ?? [],
    'thread-response-invalid',
  );
  const id = value.id;
  if (!exactString(id) || !isDataOnlyValue(value)) fail('thread-response-invalid');

  switch (type) {
    case 'userMessage':
      if (!nullableString(value.clientId) || !historicalUserInputs(value.content)) {
        fail('thread-response-invalid');
      }
      break;
    case 'hookPrompt':
      if (!historicalHookFragments(value.fragments)) fail('thread-response-invalid');
      break;
    case 'agentMessage':
      if (typeof value.text !== 'string' ||
        (value.phase !== null && value.phase !== 'commentary' && value.phase !== 'final_answer') ||
        (value.memoryCitation !== null && !historicalMemoryCitation(value.memoryCitation))) {
        fail('thread-response-invalid');
      }
      break;
    case 'plan':
      if (typeof value.text !== 'string') fail('thread-response-invalid');
      break;
    case 'reasoning':
      if (!stringArray(value.summary) || !stringArray(value.content)) {
        fail('thread-response-invalid');
      }
      break;
    case 'commandExecution':
      if (typeof value.command !== 'string' || typeof value.cwd !== 'string' ||
        !nullableString(value.processId) ||
        !['agent', 'userShell', 'unifiedExecStartup', 'unifiedExecInteraction'].includes(
          value.source as string,
        ) ||
        !['inProgress', 'completed', 'failed', 'declined'].includes(value.status as string) ||
        !historicalCommandActions(value.commandActions) || !nullableString(value.aggregatedOutput) ||
        !nullableSafeInteger(value.exitCode) || !nullableNonNegativeFinite(value.durationMs)) {
        fail('thread-response-invalid');
      }
      break;
    case 'fileChange':
      if (!historicalFileChanges(value.changes) ||
        !['inProgress', 'completed', 'failed', 'declined'].includes(value.status as string)) {
        fail('thread-response-invalid');
      }
      break;
    case 'mcpToolCall':
      if (!exactString(value.server) || !exactString(value.tool) ||
        !['inProgress', 'completed', 'failed'].includes(value.status as string) ||
        (value.appContext !== null && !historicalMcpAppContext(value.appContext)) ||
        !nullableString(value.pluginId) ||
        (value.result !== null && !historicalMcpResult(value.result)) ||
        (value.error !== null && !historicalMcpError(value.error)) ||
        !nullableNonNegativeFinite(value.durationMs) ||
        (owns(value, 'mcpAppResourceUri') && typeof value.mcpAppResourceUri !== 'string')) {
        fail('thread-response-invalid');
      }
      break;
    case 'dynamicToolCall':
      if (!nullableString(value.namespace) || !exactString(value.tool) ||
        !['inProgress', 'completed', 'failed'].includes(value.status as string) ||
        (value.contentItems !== null && !historicalDynamicContent(value.contentItems)) ||
        (value.success !== null && typeof value.success !== 'boolean') ||
        !nullableNonNegativeFinite(value.durationMs)) {
        fail('thread-response-invalid');
      }
      break;
    case 'collabAgentToolCall':
      if (!['spawnAgent', 'sendInput', 'resumeAgent', 'wait', 'closeAgent'].includes(
        value.tool as string,
      ) || !['inProgress', 'completed', 'failed'].includes(value.status as string) ||
        !exactString(value.senderThreadId) || !exactStringArray(value.receiverThreadIds) ||
        !nullableString(value.prompt) || !nullableString(value.model) ||
        (value.reasoningEffort !== null && typeof value.reasoningEffort !== 'string') ||
        !historicalAgentStates(value.agentsStates)) {
        fail('thread-response-invalid');
      }
      break;
    case 'subAgentActivity':
      if (!['started', 'interacted', 'interrupted'].includes(value.kind as string) ||
        !exactString(value.agentThreadId) || typeof value.agentPath !== 'string') {
        fail('thread-response-invalid');
      }
      break;
    case 'webSearch':
      if (typeof value.query !== 'string' ||
        (value.action !== null && !historicalWebSearchAction(value.action))) {
        fail('thread-response-invalid');
      }
      break;
    case 'imageView':
      if (typeof value.path !== 'string') fail('thread-response-invalid');
      break;
    case 'sleep':
      if (!nonNegativeFinite(value.durationMs)) fail('thread-response-invalid');
      break;
    case 'imageGeneration':
      if (!exactString(value.status) || !nullableString(value.revisedPrompt) ||
        typeof value.result !== 'string' ||
        (owns(value, 'savedPath') && typeof value.savedPath !== 'string')) {
        fail('thread-response-invalid');
      }
      break;
    case 'enteredReviewMode':
    case 'exitedReviewMode':
      if (typeof value.review !== 'string') fail('thread-response-invalid');
      break;
    case 'contextCompaction':
      break;
    default:
      fail('thread-response-invalid');
  }
  return id;
}

function isHistoricalItemType(value: string): value is ThreadItem['type'] {
  return owns(HISTORICAL_ITEM_SHAPES, value);
}

function historicalUserInputs(value: unknown): boolean {
  if (!Array.isArray(value)) return false;
  return value.every((entry) => {
    if (!isRecord(entry) || typeof entry.type !== 'string') return false;
    switch (entry.type) {
      case 'text':
        return hasExactKeys(entry, ['type', 'text', 'text_elements']) &&
          typeof entry.text === 'string' && Array.isArray(entry.text_elements) &&
          entry.text_elements.every(historicalTextElement);
      case 'image':
        return hasExactKeys(entry, ['type', 'url'], ['detail']) &&
          typeof entry.url === 'string' && historicalImageDetail(entry);
      case 'localImage':
        return hasExactKeys(entry, ['type', 'path'], ['detail']) &&
          typeof entry.path === 'string' && historicalImageDetail(entry);
      case 'skill':
      case 'mention':
        return hasExactKeys(entry, ['type', 'name', 'path']) &&
          typeof entry.name === 'string' && typeof entry.path === 'string';
      default:
        return false;
    }
  });
}

function historicalTextElement(value: unknown): boolean {
  if (!isRecord(value) || !hasExactKeys(value, ['byteRange', 'placeholder']) ||
    !isRecord(value.byteRange) ||
    !hasExactKeys(value.byteRange, ['start', 'end']) ||
    !safeTimestamp(value.byteRange.start) || !safeTimestamp(value.byteRange.end) ||
    value.byteRange.end < value.byteRange.start || !nullableString(value.placeholder)) {
    return false;
  }
  return true;
}

function historicalImageDetail(value: Record<string, unknown>): boolean {
  return !owns(value, 'detail') ||
    value.detail === 'auto' || value.detail === 'low' ||
    value.detail === 'high' || value.detail === 'original';
}

function historicalHookFragments(value: unknown): boolean {
  return Array.isArray(value) && value.every((fragment) => (
    isRecord(fragment) && hasExactKeys(fragment, ['text', 'hookRunId']) &&
    typeof fragment.text === 'string' && exactString(fragment.hookRunId)
  ));
}

function historicalMemoryCitation(value: unknown): boolean {
  if (!isRecord(value) || !hasExactKeys(value, ['entries', 'threadIds']) ||
    !Array.isArray(value.entries) || !exactStringArray(value.threadIds)) return false;
  return value.entries.every((entry) => (
    isRecord(entry) && hasExactKeys(entry, ['path', 'lineStart', 'lineEnd', 'note']) &&
    typeof entry.path === 'string' && safeTimestamp(entry.lineStart) &&
    safeTimestamp(entry.lineEnd) && entry.lineEnd >= entry.lineStart &&
    typeof entry.note === 'string'
  ));
}

function historicalCommandActions(value: unknown): boolean {
  if (!Array.isArray(value)) return false;
  return value.every((action) => {
    if (!isRecord(action) || typeof action.type !== 'string') return false;
    switch (action.type) {
      case 'read':
        return hasExactKeys(action, ['type', 'command', 'name', 'path']) &&
          typeof action.command === 'string' && typeof action.name === 'string' &&
          typeof action.path === 'string';
      case 'listFiles':
        return hasExactKeys(action, ['type', 'command', 'path']) &&
          typeof action.command === 'string' && nullableString(action.path);
      case 'search':
        return hasExactKeys(action, ['type', 'command', 'query', 'path']) &&
          typeof action.command === 'string' && nullableString(action.query) &&
          nullableString(action.path);
      case 'unknown':
        return hasExactKeys(action, ['type', 'command']) &&
          typeof action.command === 'string';
      default:
        return false;
    }
  });
}

function historicalFileChanges(value: unknown): boolean {
  if (!Array.isArray(value)) return false;
  return value.every((change) => {
    if (!isRecord(change) || !hasExactKeys(change, ['path', 'kind', 'diff']) ||
      typeof change.path !== 'string' || typeof change.diff !== 'string' ||
      !isRecord(change.kind) || typeof change.kind.type !== 'string') return false;
    if (change.kind.type === 'add' || change.kind.type === 'delete') {
      return hasExactKeys(change.kind, ['type']);
    }
    return change.kind.type === 'update' &&
      hasExactKeys(change.kind, ['type', 'move_path']) && nullableString(change.kind.move_path);
  });
}

function historicalMcpAppContext(value: unknown): boolean {
  return isRecord(value) && hasExactKeys(value, [
    'connectorId', 'linkId', 'resourceUri', 'appName', 'templateId', 'actionName',
  ]) && exactString(value.connectorId) && nullableString(value.linkId) &&
    nullableString(value.resourceUri) && nullableString(value.appName) &&
    nullableString(value.templateId) && nullableString(value.actionName);
}

function historicalMcpResult(value: unknown): boolean {
  return isRecord(value) && hasExactKeys(value, ['content', 'structuredContent', '_meta']) &&
    Array.isArray(value.content) &&
    (value.structuredContent === null || isDataOnlyValue(value.structuredContent)) &&
    (value._meta === null || isDataOnlyValue(value._meta));
}

function historicalMcpError(value: unknown): boolean {
  return isRecord(value) && hasExactKeys(value, ['message']) &&
    typeof value.message === 'string';
}

function historicalDynamicContent(value: unknown): boolean {
  if (!Array.isArray(value)) return false;
  return value.every((item) => {
    if (!isRecord(item)) return false;
    if (item.type === 'inputText') {
      return hasExactKeys(item, ['type', 'text']) && typeof item.text === 'string';
    }
    return item.type === 'inputImage' && hasExactKeys(item, ['type', 'imageUrl']) &&
      typeof item.imageUrl === 'string';
  });
}

const HISTORICAL_AGENT_STATUSES = new Set([
  'pendingInit', 'running', 'interrupted', 'completed', 'errored', 'shutdown', 'notFound',
]);

function historicalAgentStates(value: unknown): boolean {
  if (!isRecord(value)) return false;
  return Object.values(value).every((state) => (
    isRecord(state) && hasExactKeys(state, ['status', 'message']) &&
    typeof state.status === 'string' && HISTORICAL_AGENT_STATUSES.has(state.status) &&
    nullableString(state.message)
  ));
}

function historicalWebSearchAction(value: unknown): boolean {
  if (!isRecord(value) || typeof value.type !== 'string') return false;
  switch (value.type) {
    case 'search':
      return hasExactKeys(value, ['type', 'query', 'queries']) &&
        nullableString(value.query) &&
        (value.queries === null || stringArray(value.queries));
    case 'openPage':
      return hasExactKeys(value, ['type', 'url']) && nullableString(value.url);
    case 'findInPage':
      return hasExactKeys(value, ['type', 'url', 'pattern']) &&
        nullableString(value.url) && nullableString(value.pattern);
    case 'other':
      return hasExactKeys(value, ['type']);
    default:
      return false;
  }
}

function idleThreadStatus(value: unknown): boolean {
  return isRecord(value) && Object.keys(value).length === 1 && value.type === 'idle';
}

function gitInfo(value: unknown): boolean {
  if (value === null) return true;
  if (!isRecord(value)) return false;
  try {
    exactKeys(value, ['sha', 'branch', 'originUrl'], 'thread-response-invalid');
  } catch {
    return false;
  }
  return nullableString(value.sha) && nullableString(value.branch) &&
    nullableString(value.originUrl);
}

function isReadOnlySandbox(value: unknown): boolean {
  return isRecord(value) && Object.keys(value).length === 2 &&
    value.type === 'readOnly' && value.networkAccess === false;
}

function selectedEffort(selection: RuntimeSelection): string | null {
  return selection.effort.kind === 'selected' ? selection.effort.value : null;
}

function cloneSelection(selection: RuntimeSelection): RuntimeSelection {
  return {
    runtimeId: selection.runtimeId,
    accountId: selection.accountId,
    model: selection.model,
    effort: selection.effort.kind === 'selected'
      ? { kind: 'selected', value: selection.effort.value }
      : { kind: selection.effort.kind },
  };
}

function guarded<T>(code: CodexRuntimeMappingErrorCode, operation: () => T): T {
  try {
    return operation();
  } catch (error) {
    if (error instanceof CodexRuntimeMappingError) throw error;
    fail(code);
  }
}

function fail(code: CodexRuntimeMappingErrorCode): never {
  throw new CodexRuntimeMappingError(code);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function exactKeys(
  value: Record<string, unknown>,
  expected: readonly string[],
  code: CodexRuntimeMappingErrorCode,
): void {
  const keys = Reflect.ownKeys(value);
  if (keys.length !== expected.length || keys.some((key) => typeof key !== 'string') ||
    Object.keys(value).length !== keys.length || expected.some((key) => !owns(value, key))) {
    fail(code);
  }
}

function hasExactKeys(
  value: Record<string, unknown>,
  required: readonly string[],
  optional: readonly string[] = [],
): boolean {
  const keys = Reflect.ownKeys(value);
  const allowed = new Set([...required, ...optional]);
  return !keys.some((key) => typeof key !== 'string' || !allowed.has(key)) &&
    Object.keys(value).length === keys.length &&
    required.every((key) => owns(value, key));
}

function exactKeysWithOptional(
  value: Record<string, unknown>,
  required: readonly string[],
  optional: readonly string[],
  code: CodexRuntimeMappingErrorCode,
): void {
  const keys = Reflect.ownKeys(value);
  const allowed = new Set([...required, ...optional]);
  if (keys.some((key) => typeof key !== 'string' || !allowed.has(key)) ||
    Object.keys(value).length !== keys.length ||
    required.some((key) => !owns(value, key))) fail(code);
}

function owns(value: object, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(value, key);
}

function exactString(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && value === value.trim() &&
    !value.includes('\u0000');
}

function stringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((entry) => typeof entry === 'string');
}

function exactStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every(exactString);
}

function nullableSafeInteger(value: unknown): boolean {
  return value === null || Number.isSafeInteger(value);
}

function nullableNonNegativeFinite(value: unknown): boolean {
  return value === null || nonNegativeFinite(value);
}

function isDataOnlyValue(
  value: unknown,
  seen: Set<object> = new Set(),
  depth = 0,
): boolean {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return true;
  if (typeof value === 'number') return Number.isFinite(value);
  if (typeof value !== 'object' || depth > 32 || seen.has(value)) return false;
  seen.add(value);
  try {
    if (Array.isArray(value)) {
      const keys = Reflect.ownKeys(value);
      if (Object.getPrototypeOf(value) !== Array.prototype ||
        Object.keys(value).length !== value.length || keys.length !== value.length + 1 ||
        keys.some((key) => typeof key !== 'string' ||
          (key !== 'length' && !/^(?:0|[1-9][0-9]*)$/u.test(key)))) return false;
      const descriptors = Object.getOwnPropertyDescriptors(value);
      for (let index = 0; index < value.length; index += 1) {
        const descriptor = descriptors[String(index)];
        if (descriptor === undefined || !('value' in descriptor) ||
          !isDataOnlyValue(descriptor.value, seen, depth + 1)) {
          return false;
        }
      }
      return true;
    }
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) return false;
    const keys = Reflect.ownKeys(value);
    if (keys.some((key) => typeof key !== 'string') || Object.keys(value).length !== keys.length) {
      return false;
    }
    const descriptors = Object.getOwnPropertyDescriptors(value);
    for (const key of keys as string[]) {
      const descriptor = descriptors[key];
      if (descriptor === undefined || !('value' in descriptor) ||
        !isDataOnlyValue(descriptor.value, seen, depth + 1)) return false;
    }
    return true;
  } finally {
    seen.delete(value);
  }
}

function nullableExactString(value: unknown): boolean {
  return value === null || exactString(value);
}

function nullableString(value: unknown): boolean {
  return value === null || typeof value === 'string';
}

function distinctExactStrings(value: unknown): value is string[] {
  return Array.isArray(value) && value.length > 0 && value.every(exactString) &&
    new Set(value).size === value.length;
}

function sameStrings(value: unknown, expected: readonly string[]): boolean {
  return Array.isArray(value) && value.length === expected.length &&
    expected.every((item, index) => value[index] === item);
}

function nativeId(value: unknown): value is string {
  return exactString(value) &&
    /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
}

function safeTimestamp(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) >= 0;
}

function nonNegativeFinite(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0;
}
