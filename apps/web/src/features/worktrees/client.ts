// Stranded-worktree read — the Wave-E GET endpoint. Worktrees have no
// resource-entity flow (deliberate: stranding is a boot-scan durable, not a
// hot mutation stream), so polling the endpoint IS the cheap path.

import { getJson } from '@/api/http';
import type { ULID } from '@pc/contracts';

export interface StrandedWorktreeDto {
  id: ULID;
  name: string;
  path: string;
  branch: string | null;
  baseBranch: string | null;
  agentRunId: ULID | null;
  contractId: ULID | null;
  strandedReason: string | null;
  strandedAt: number | null;
}

export const worktreesApi = {
  listStranded: (projectId: ULID) =>
    getJson<{ worktrees: StrandedWorktreeDto[] }>(
      `/api/projects/${projectId}/worktrees/stranded`,
    ).then((r) => r.worktrees),
};
