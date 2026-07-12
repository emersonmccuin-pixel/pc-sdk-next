// Compatibility adapters for the agent-run family (slice 005).
//
// Pure mappers between the @pc/domain AgentRunRow / PendingAskRow shapes and
// the shared @pc/contracts DTOs. Run selection/provenance is projected exactly;
// provider-native identity and continuation attempts remain private. Boundary
// purity: @pc/contracts + @pc/domain.

import {
  isAgentRunDto,
  isPendingAskDto,
  isRuntimeSelection,
  type AgentRunDto,
  type PendingAskDto,
  type RuntimeSelection,
} from '@pc/contracts';
import type { AgentRunRow, PendingAskRow } from '@pc/domain';

export class AgentRunAdapterError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'AgentRunAdapterError';
  }
}

function selectionForRow(row: AgentRunRow): RuntimeSelection | null {
  if (
    row.selectionState !== 'stamped' ||
    !row.runtimeId ||
    !row.accountId ||
    !row.model ||
    row.effortState === 'legacy-unknown'
  ) return null;
  const effort: RuntimeSelection['effort'] | null = row.effortState === 'selected'
    ? row.effort
      ? { kind: 'selected', value: row.effort }
      : null
    : { kind: row.effortState };
  if (!effort) return null;
  const selection = {
    runtimeId: row.runtimeId,
    accountId: row.accountId,
    model: row.model,
    effort,
  };
  return isRuntimeSelection(selection) ? selection : null;
}

/** AgentRunRow → AgentRunDto. `startedAt` mirrors the v1 record's use of the
 *  queue timestamp; `worktreeDir` is supplied by the caller (the row does not
 *  persist it). */
export function toAgentRunDto(
  row: AgentRunRow,
  opts: { worktreeDir?: string; startedAt?: number } = {},
): AgentRunDto {
  if (!row || typeof row.id !== 'string') {
    throw new AgentRunAdapterError('invalid agent run row: missing id');
  }
  const dto: AgentRunDto = {
    runId: row.id,
    agentName: row.podName,
    selection: selectionForRow(row),
    specialistRevision:
      row.snapshotState === 'stamped' ? row.specialistSnapshot?.revision ?? null : null,
    nativeSessionIdPresent:
      row.nativeIdentityState === 'bound' &&
      typeof row.nativeSessionId === 'string' &&
      row.nativeSessionId.trim().length > 0,
    continuationState: row.continuationState,
    projectId: row.projectId,
    dispatcherSessionId: row.dispatcherSessionId,
    worktreeDir: opts.worktreeDir ?? row.worktreeDir ?? '',
    startedAt: opts.startedAt ?? row.queuedAt,
    status: row.status,
    lifecycleState: row.lifecycleState ?? null,
    result: row.result ?? '',
    failureReason: row.failureReason,
    failureCause: row.failureCause,
    endedAt: row.completedAt,
    rev: row.rev,
    // Provisioning receipts ride additively (docs/worktree-lifecycle.md).
    gitReceipt: row.gitReceipt ?? null,
    preparationReceipt: row.preparationReceipt ?? null,
    readinessReceipt: row.readinessReceipt ?? null,
  };
  if (!isAgentRunDto(dto)) {
    throw new AgentRunAdapterError(`invalid agent run row: unsafe or inconsistent projection (${row.id})`);
  }
  return dto;
}

export function toPendingAskDto(row: PendingAskRow): PendingAskDto {
  if (!row || typeof row.id !== 'string') {
    throw new AgentRunAdapterError('invalid pending-ask row: missing id');
  }
  const dto: PendingAskDto = {
    id: row.id,
    agentRunId: row.agentRunId,
    projectId: row.projectId,
    pmRef: row.pmRef ?? null,
    kind: row.kind,
    promptBody: row.promptBody,
    context: row.context,
    options: row.options ? row.options.map((o) => ({ label: o.label, value: o.value })) : null,
    status: row.status,
    answeredBy: row.answeredBy,
    createdAt: row.createdAt,
    answeredAt: row.answeredAt,
    cancelledAt: row.cancelledAt,
  };
  if (!isPendingAskDto(dto)) {
    throw new AgentRunAdapterError(`invalid pending-ask row: unsafe or inconsistent projection (${row.id})`);
  }
  return dto;
}
