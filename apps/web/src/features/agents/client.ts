// Agent-pool HTTP client — full CRUD + project attachment over the
// /api/agents/pods routes (apps/server/src/http/agents.ts).

import { deleteJson, getJson, postJson, postJsonMethod } from '@/api/http';
import type { PodAgentRow } from '@pc/domain';
import type { CreatePodRequest, UpdatePodRequest, ULID } from '@pc/contracts';

/** Roster row: the agent + server annotations. `driftedFields` is null for
 *  user agents, [] for pristine stock, field names when customized. */
export type Pod = PodAgentRow & {
  driftedFields: string[] | null;
  memberProjectIds: ULID[];
};

const base = '/api/agents/pods';

export const agentsApi = {
  /** With projectId: the project's visible set (stock ∪ members). Without:
   *  the whole global pool (Project Settings uses this). */
  listPods: (projectId?: ULID) =>
    getJson<{ pods: Pod[] }>(projectId ? `${base}?projectId=${projectId}` : base).then((r) => r.pods),
  getPod: (id: ULID) => getJson<{ pod: Pod }>(`${base}/${id}`).then((r) => r.pod),
  createPod: (input: CreatePodRequest) =>
    postJson<{ pod: Pod }>(base, input).then((r) => r.pod),
  updatePod: (id: ULID, patch: UpdatePodRequest) =>
    postJsonMethod<{ pod: Pod }>(`${base}/${id}`, patch, 'PATCH').then((r) => r.pod),
  deletePod: (id: ULID) => deleteJson<{ ok: true }>(`${base}/${id}`).then(() => undefined),
  resetToDefault: (id: ULID) =>
    postJson<{ pod: Pod; resetFields: string[] }>(`${base}/${id}/reset-to-default`, {}),
  attachToProject: (id: ULID, projectId: ULID) =>
    postJsonMethod<{ memberProjectIds: ULID[] }>(`${base}/${id}/projects/${projectId}`, {}, 'PUT').then(
      (r) => r.memberProjectIds,
    ),
  detachFromProject: (id: ULID, projectId: ULID) =>
    deleteJson<{ memberProjectIds: ULID[] }>(`${base}/${id}/projects/${projectId}`).then(
      (r) => r.memberProjectIds,
    ),
};

export function resolveModelLabel(model: string | null): string {
  if (!model) return 'default';
  return model.charAt(0).toUpperCase() + model.slice(1);
}
