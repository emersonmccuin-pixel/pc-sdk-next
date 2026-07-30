// Row → wire DTO mappers. The web speaks the @pc/contracts DTOs; the DB repos
// return domain rows. One mapping place so no route hand-rolls a shape.

import type {
  ProjectDto,
  RuntimeSelectionErrorCode,
  SessionResumeAvailability,
  SessionSummary,
} from '@pc/contracts';
import {
  runtimeSelectionForSession,
  type OrchestratorSessionRow,
} from '@pc/db';
import type { Project } from '@pc/domain';

/** Domain project → wire ProjectDto. Stages are a dead (work-items) concept in
 *  Phase 2 — always []. Only the DTO settings keys ride the wire. */
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
      reviewPolicy: p.settings.reviewPolicy,
      autoMergeEligible: p.settings.autoMergeEligible,
    },
    callsignSeq: p.callsignSeq,
    notes: p.notes,
    focusedAt: p.focusedAt,
  };
}

export function staticSessionResumeAvailability(
  row: OrchestratorSessionRow,
  dynamicError: RuntimeSelectionErrorCode | null = null,
): SessionResumeAvailability {
  if (row.status === 'active') return { status: 'unavailable', code: 'session-active' };
  if (!runtimeSelectionForSession(row)) {
    return { status: 'unavailable', code: 'selection-unavailable' };
  }
  if (
    row.nativeIdentityState !== 'bound' ||
    typeof row.nativeSessionId !== 'string' ||
    row.nativeSessionId.trim().length === 0
  ) return { status: 'unavailable', code: 'native-session-missing' };
  if (row.continuationState === 'resume-failed') {
    return { status: 'unavailable', code: 'resume-failed' };
  }
  return dynamicError
    ? { status: 'unavailable', code: dynamicError }
    : { status: 'available' };
}

export function toSessionSummary(
  row: OrchestratorSessionRow,
  dynamicError: RuntimeSelectionErrorCode | null = null,
): SessionSummary {
  return {
    id: row.id,
    projectId: row.projectId,
    selection: runtimeSelectionForSession(row),
    title: row.title,
    status: row.status === 'ended' ? 'ended' : 'active',
    nativeSessionIdPresent: typeof row.nativeSessionId === 'string' && row.nativeSessionId.trim().length > 0,
    continuationState: row.continuationState,
    resumeAvailability: staticSessionResumeAvailability(row, dynamicError),
    startedAt: row.startedAt,
    sourceSessionId: row.sourceSessionId,
  };
}
