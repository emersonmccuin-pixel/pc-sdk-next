// Contract HTTP client. Ordinary contract review mutations stay pc_* tool
// doors; approved abandonment is deliberately the one browser-only destructive
// action and is bound to a fresh server preview.

import { getJson, postJson } from '@/api/http';
import {
  contractRoutes,
  isContract,
  isWorktreeAbandonmentPreviewDto,
  type ApproveWorktreeAbandonmentRequest,
  type ApproveWorktreeAbandonmentResponse,
  type Contract,
  type ULID,
  type WorktreeAbandonmentPreviewDto,
} from '@pc/contracts';

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

export function parseWorktreeAbandonmentPreviewResponse(
  value: unknown,
): WorktreeAbandonmentPreviewDto {
  if (
    !isRecord(value) ||
    Object.keys(value).length !== 2 ||
    value.ok !== true ||
    !isWorktreeAbandonmentPreviewDto(value.preview)
  ) {
    throw new Error('invalid worktree abandonment preview response');
  }
  return value.preview;
}

export function parseApproveWorktreeAbandonmentResponse(
  value: unknown,
): ApproveWorktreeAbandonmentResponse {
  if (
    !isRecord(value) ||
    Object.keys(value).length !== 3 ||
    value.ok !== true ||
    (value.settlement !== 'completed' && value.settlement !== 'pending') ||
    !isContract(value.contract)
  ) {
    throw new Error('invalid worktree abandonment response');
  }
  return {
    ok: true,
    settlement: value.settlement,
    contract: value.contract,
  };
}

export const contractsApi = {
  listContracts: (projectId: ULID) =>
    getJson<{ contracts: Contract[] }>(contractRoutes.forProject(projectId)).then(
      (r) => r.contracts,
    ),

  getContract: (contractId: ULID) =>
    getJson<{ contract: Contract }>(contractRoutes.detail(contractId)).then((r) => r.contract),

  getAbandonmentPreview: (projectId: ULID, contractId: ULID) =>
    getJson<unknown>(contractRoutes.abandonmentPreview(projectId, contractId))
      .then(parseWorktreeAbandonmentPreviewResponse),

  approveAbandonment: (
    projectId: ULID,
    contractId: ULID,
    request: ApproveWorktreeAbandonmentRequest,
  ) =>
    postJson<unknown>(contractRoutes.abandonment(projectId, contractId), request)
      .then(parseApproveWorktreeAbandonmentResponse),
};
