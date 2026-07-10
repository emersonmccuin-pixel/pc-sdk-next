// Row → wire DTO mappers. The web speaks the @pc/contracts DTOs; the DB repos
// return domain rows. One mapping place so no route hand-rolls a shape.

import type { ProjectDto, SessionSummary } from '@pc/contracts';
import type { OrchestratorSessionRow } from '@pc/db';
import type { Project } from '@pc/domain';

/** Domain project → wire ProjectDto. Stages are a dead (work-items) concept in
 *  Phase 2 — always []. Only the three DTO settings keys ride the wire. */
export function toProjectDto(p: Project): ProjectDto {
  return {
    id: p.id,
    slug: p.slug,
    name: p.name,
    stages: [],
    folderPath: p.folderPath,
    gitRemote: p.gitRemote,
    settings: {
      cancelledVisibility: p.settings.cancelledVisibility,
      remoteControl: p.settings.remoteControl,
      integrationBranch: p.settings.integrationBranch,
    },
    callsignSeq: p.callsignSeq,
    notes: p.notes,
    focusedAt: p.focusedAt,
  };
}

export function toSessionSummary(row: OrchestratorSessionRow): SessionSummary {
  return {
    id: row.id,
    projectId: row.projectId,
    model: row.model,
    title: row.title,
    status: row.status === 'ended' ? 'ended' : 'active',
    startedAt: row.startedAt,
  };
}
