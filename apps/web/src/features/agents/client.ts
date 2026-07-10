// Pod (agent-definition) HTTP client — READ-ONLY for Phase 2.
//
// LOOSE END: no `/api/projects/:id/pods` route exists yet — apps/server's
// Phase 2 HTTP surface (docs/phase-2-plan.md) doesn't list pods; the DB layer
// (@pc/db repos/pods.ts, @pc/domain pod.ts) is already ported, but the full
// create/edit surface (secrets, MCP attachments, context docs, membership —
// ~1600 lines in PC-PTY-Chat's CreatePodModal/PodDetailModal/ContextTab) is
// Phase 3 "specialist builder v1" per AGENTS.md. This client + AgentsList are
// read-only roster viewing only, ready to light up once the route lands.

import { getJson } from '@/api/http';
import type { PodAgentRow } from '@pc/domain';
import type { ULID } from '@pc/contracts';

export type Pod = PodAgentRow;

export const agentsApi = {
  listPods: (projectId: ULID) =>
    getJson<{ pods: Pod[] }>(`/api/projects/${projectId}/pods`).then((r) => r.pods),
};

export function resolveModelLabel(model: string | null): string {
  if (!model) return 'default';
  return model.charAt(0).toUpperCase() + model.slice(1);
}
