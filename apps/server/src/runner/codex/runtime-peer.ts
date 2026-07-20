import type { RuntimeSelection } from '../runtime.ts';
import type { ThreadResumeParams } from './generated/v2/ThreadResumeParams.ts';
import type { ThreadStartParams } from './generated/v2/ThreadStartParams.ts';
import type { TurnInterruptParams } from './generated/v2/TurnInterruptParams.ts';
import type { TurnStartParams } from './generated/v2/TurnStartParams.ts';

export const CODEX_RUNTIME_ID = 'openai-codex' as const;
export const CODEX_PROTOCOL_VERSION = '0.144.1' as const;
export const CODEX_MODEL_PROVIDER = 'openai' as const;

export const CODEX_RUNTIME_REQUEST_METHODS = [
  'thread/start',
  'thread/resume',
  'turn/start',
  'turn/interrupt',
] as const;

export const CODEX_RUNTIME_NOTIFICATION_METHODS = [
  'turn/started',
  'item/started',
  'item/agentMessage/delta',
  'item/completed',
  'turn/completed',
] as const;

export interface CodexDiscoveryModel {
  id: string;
  resolvedId: string | null;
  label: string;
  description: string;
  effort:
    | { status: 'supported'; values: string[] }
    | { status: 'unsupported'; code: string };
}

export type CodexDiscoveryObservation =
  | {
      status: 'available';
      protocolVersion: typeof CODEX_PROTOCOL_VERSION;
      runtimeId: typeof CODEX_RUNTIME_ID;
      accountId: string;
      models: CodexDiscoveryModel[];
    }
  | {
      status: 'unavailable';
      protocolVersion: typeof CODEX_PROTOCOL_VERSION;
      runtimeId: typeof CODEX_RUNTIME_ID;
      accountId: string;
      code: string;
    };

/** Provider-local discovery port. Implementations may return hostile values;
 * the adapter treats every result as untrusted and captures it defensively. */
export interface CodexDiscoveryPeer {
  discover(accountId: string): Promise<unknown>;
}

export type CodexRuntimeMode = 'create' | 'resume';
export type CodexTerminalStatus = 'completed' | 'interrupted' | 'failed';

export interface CodexExecutionPolicyChallenge {
  kind: 'provider-free-execution-policy-challenge';
  protocolVersion: typeof CODEX_PROTOCOL_VERSION;
  runtimeId: typeof CODEX_RUNTIME_ID;
  continuationAttemptId: string;
  selection: RuntimeSelection;
  mode: CodexRuntimeMode;
  requestedThreadId: string | null;
  cwd: string;
  requestMethods: [...typeof CODEX_RUNTIME_REQUEST_METHODS];
  notificationMethods: [...typeof CODEX_RUNTIME_NOTIFICATION_METHODS];
}

/** Independent provider-free attestation of the product execution posture: a
 * workspace-write sandbox scoped to the session cwd, exec/patch approvals routed
 * to the app ask flow, and a native direct-child process lifecycle. Only an
 * independent provider-free conformance authority may mint it. */
export interface CodexProviderFreeExecutionPolicyReceipt {
  kind: 'provider-free-conformance';
  protocolVersion: typeof CODEX_PROTOCOL_VERSION;
  runtimeId: typeof CODEX_RUNTIME_ID;
  continuationAttemptId: string;
  selection: RuntimeSelection;
  mode: CodexRuntimeMode;
  requestedThreadId: string | null;
  cwd: string;
  requestMethods: [...typeof CODEX_RUNTIME_REQUEST_METHODS];
  notificationMethods: [...typeof CODEX_RUNTIME_NOTIFICATION_METHODS];
  effectiveNativeTools: [];
  effectiveMcpServers: [];
  approvalRequests: 'routed';
  lifecycle: 'direct-child';
}

export interface CodexRuntimePeerFactoryInput {
  continuationAttemptId: string;
  selection: RuntimeSelection;
  mode: CodexRuntimeMode;
  requestedThreadId: string | null;
  cwd: string;
}

export interface CodexThreadPeerReceipt {
  policyReceipt: CodexProviderFreeExecutionPolicyReceipt;
  response: unknown;
}

export interface CodexTurnBoundaryChallenge {
  kind: 'provider-free-turn-boundary-challenge';
  protocolVersion: typeof CODEX_PROTOCOL_VERSION;
  runtimeId: typeof CODEX_RUNTIME_ID;
  continuationAttemptId: string;
  threadId: string;
  turnId: string;
  turnSequence: number;
  status: CodexTerminalStatus;
}

/** An independent provider-free authority seals and attests the exact terminal
 * boundary of a native turn epoch: the canonical turn-notification stream is
 * drained to its terminal frame with no residual pending notifications. */
export interface CodexProviderFreeTurnBoundaryReceipt {
  kind: 'provider-free-conformance-turn-boundary';
  protocolVersion: typeof CODEX_PROTOCOL_VERSION;
  runtimeId: typeof CODEX_RUNTIME_ID;
  continuationAttemptId: string;
  threadId: string;
  turnId: string;
  turnSequence: number;
  status: CodexTerminalStatus;
  notificationBoundary: 'open-native';
  pendingNotifications: 0;
}

/** Independent provider-free test authority. The execution peer cannot attest
 * its own policy or terminal boundary. Production composition has no authority
 * implementation and therefore cannot construct the CX-002 adapter path. */
export interface CodexProviderFreeConformanceAuthority {
  attestExecutionPolicy(
    peer: CodexRuntimePeer,
    challenge: CodexExecutionPolicyChallenge,
  ): Promise<unknown>;
  attestTurnBoundary(
    peer: CodexRuntimePeer,
    challenge: CodexTurnBoundaryChallenge,
  ): Promise<unknown>;
}

/** Closed provider-local execution port. It intentionally exposes no generic
 * request method and has no native/default implementation in CX-002. */
export interface CodexRuntimePeer {
  startThread(
    params: ThreadStartParams,
    policyReceipt: CodexProviderFreeExecutionPolicyReceipt,
  ): Promise<unknown>;
  resumeThread(
    params: ThreadResumeParams,
    policyReceipt: CodexProviderFreeExecutionPolicyReceipt,
  ): Promise<unknown>;
  startTurn(params: TurnStartParams): Promise<unknown>;
  interruptTurn(params: TurnInterruptParams): Promise<unknown>;
  notifications(): AsyncIterable<unknown>;
  dispose(): Promise<void>;
}

export type CodexRuntimePeerFactory = (
  input: CodexRuntimePeerFactoryInput,
) => CodexRuntimePeer | Promise<CodexRuntimePeer>;
