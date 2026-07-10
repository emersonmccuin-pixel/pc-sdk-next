import type {
  CreateProjectMode,
  CreateProjectRequest,
  ProjectDto,
  ProjectSignalPayload,
  ReorderProjectsRequest,
  UpdateProjectRequest,
  ULID as ContractULID,
} from '@pc/contracts';
import type { Project, ProjectSettings, ULID as DomainULID } from '@pc/domain';
import {
  createProjectInDb,
  getDb,
  getProjectById as defaultGetProjectById,
  insertLiveEvent,
  listProjects as defaultListProjects,
  listProjectsInDb,
  reorderProjectsInDb,
  setProjectFocusInDb,
  softDeleteProjectInDb,
  updateProjectMetaInDb,
  type CreateProjectInput,
  type DbExecutor,
  type InsertLiveEventDraft,
  type LiveOutboxEvent,
} from '@pc/db';

/** Read-only port (test seam). Project mutations are NOT injectable: they always
 *  run in a DB transaction that persists the `project` signal to the outbox
 *  (persist-then-broadcast — a signal that isn't durable can't replay). */
export interface ProjectRepositoryPort {
  listProjects(options?: { includeDeleted?: boolean }): Project[];
  getProjectById(projectId: ContractULID): Project | null;
}

export interface ProjectCreateFlowInput {
  name: string;
  folderPath: string;
  mode: CreateProjectMode;
  gitRemote?: string | null;
}

/** The new `project` resource is signal-only (`{ projectId }`); the client
 *  refetches the project list off it (replaces the legacy `project.changed`
 *  refetch envelope). */
export interface ProjectChangedPublication {
  liveEvent: LiveOutboxEvent<ProjectSignalPayload>;
}

export interface ProjectCreateFlowResult extends ProjectChangedPublication {
  project: Project;
}

export type ProjectCreateFlowPort = (input: ProjectCreateFlowInput) => Promise<ProjectCreateFlowResult>;

export type ProjectServiceResult<T extends object> =
  | ({ ok: true } & T)
  | { ok: false; error: string; code: 'NOT_FOUND' | 'INTERNAL' };

export type ProjectMutationResult<T extends object> = ProjectServiceResult<
  T & ProjectChangedPublication
>;

const defaultRepo: ProjectRepositoryPort = {
  listProjects: defaultListProjects,
  getProjectById: (projectId) => defaultGetProjectById(projectId as DomainULID),
};

export class ProjectService {
  constructor(private readonly repo: ProjectRepositoryPort = defaultRepo) {}

  listProjects(options: { includeDeleted?: boolean } = {}): { projects: ProjectDto[] } {
    return {
      projects: this.repo.listProjects(options).map(toProjectDto),
    };
  }

  getProject(projectId: ContractULID): ProjectServiceResult<{ project: ProjectDto }> {
    const project = this.repo.getProjectById(projectId);
    if (!project) return notFound(projectId);
    return { ok: true, project: toProjectDto(project) };
  }

  async createProject(
    request: CreateProjectRequest,
    createProject: ProjectCreateFlowPort,
  ): Promise<ProjectMutationResult<{ project: ProjectDto }>> {
    const created = await createProject({
      name: request.name,
      folderPath: request.folder_path,
      mode: request.mode,
      gitRemote: request.git_remote ?? null,
    });
    const project = toProjectDto(created.project);
    return { ok: true, project, liveEvent: created.liveEvent };
  }

  updateProjectMeta(
    projectId: ContractULID,
    request: UpdateProjectRequest,
  ): ProjectMutationResult<{ project: ProjectDto }> {
    return updateProjectMetaWithLiveEvent(projectId, request);
  }

  reorderProjects(
    request: ReorderProjectsRequest,
  ): ProjectMutationResult<{ projects: ProjectDto[] }> {
    return reorderProjectsWithLiveEvent(request);
  }

  softDeleteProject(projectId: ContractULID): ProjectMutationResult<{ project: ProjectDto }> {
    return softDeleteProjectWithLiveEvent(projectId);
  }
}

export function persistCreatedProjectWithLiveEvent(
  input: CreateProjectInput,
): ProjectCreateFlowResult {
  return getDb().transaction((tx) => {
    const project = createProjectInDb(tx, input);
    return { project, ...projectChanged(project.id as ContractULID, tx) };
  });
}

export function updateProjectMetaWithLiveEvent(
  projectId: ContractULID,
  request: UpdateProjectRequest,
): ProjectMutationResult<{ project: ProjectDto }> {
  return getDb().transaction((tx) => {
    const updated = updateProjectMetaInDb(tx, projectId as DomainULID, {
      ...(request.name !== undefined ? { name: request.name } : {}),
      ...(request.git_remote !== undefined ? { gitRemote: request.git_remote } : {}),
      ...(request.settings !== undefined ? { settings: request.settings } : {}),
    });
    if (!updated) return notFound(projectId);
    const project = toProjectDto(updated);
    return { ok: true, project, ...projectChanged(project.id as ContractULID, tx) };
  });
}

export function reorderProjectsWithLiveEvent(
  request: ReorderProjectsRequest,
): ProjectMutationResult<{ projects: ProjectDto[] }> {
  return getDb().transaction((tx) => {
    reorderProjectsInDb(tx, request.orderedIds as DomainULID[]);
    const projects = listProjectsInDb(tx).map(toProjectDto);
    return { ok: true, projects, ...projectChanged(null, tx) };
  });
}

/** Command focus — star/unstar a project + emit the `project` signal in the same
 *  txn (the relay fans it; the LeftRail star updates live). */
export function setProjectFocusWithLiveEvent(
  projectId: ContractULID,
  focused: boolean,
): ProjectMutationResult<{ project: ProjectDto }> {
  return getDb().transaction((tx) => {
    const updated = setProjectFocusInDb(tx, projectId as DomainULID, focused);
    if (!updated) return notFound(projectId);
    const project = toProjectDto(updated);
    return { ok: true, project, ...projectChanged(project.id as ContractULID, tx) };
  });
}

export function softDeleteProjectWithLiveEvent(
  projectId: ContractULID,
): ProjectMutationResult<{ project: ProjectDto }> {
  return getDb().transaction((tx) => {
    const deleted = softDeleteProjectInDb(tx, projectId as DomainULID);
    if (!deleted) return notFound(projectId);
    const project = toProjectDto(deleted);
    return { ok: true, project, ...projectChanged(project.id as ContractULID, tx) };
  });
}

export function toProjectDto(project: Project): ProjectDto {
  return {
    id: project.id,
    slug: project.slug,
    name: project.name,
    // Board is dead (no stages in the domain Project). The contracts ProjectDto
    // still carries a vestigial `stages` field — always empty until trimmed.
    stages: [],
    folderPath: project.folderPath,
    gitRemote: project.gitRemote,
    settings: toProjectSettingsDto(project.settings),
    callsignSeq: project.callsignSeq ?? 0,
    notes: project.notes ?? null,
    focusedAt: project.focusedAt ?? null,
  };
}

function toProjectSettingsDto(settings: ProjectSettings): ProjectDto['settings'] {
  const cancelledVisibility = settings.cancelledVisibility;
  const remoteControl = settings.remoteControl;
  return {
    cancelledVisibility:
      cancelledVisibility === 'force-visible' ||
      cancelledVisibility === 'force-hidden' ||
      cancelledVisibility === 'use-global'
        ? cancelledVisibility
        : 'use-global',
    remoteControl:
      remoteControl === 'on' || remoteControl === 'off' || remoteControl === 'use-global'
        ? remoteControl
        : 'use-global',
  };
}

/** Persist + return the signal-only `project` fact. `projectId === null` (a
 *  reorder that touches many rows) gets a stable synthetic entityId so the
 *  client's identity-keyed store keeps the frame and the global `project`
 *  signature advances (drives a list refetch). */
function projectChanged(projectId: ContractULID | null, db: DbExecutor): ProjectChangedPublication {
  return { liveEvent: insertLiveEvent(db, buildProjectSignalDraft(projectId)) };
}

export function buildProjectSignalDraft(
  projectId: ContractULID | null,
): InsertLiveEventDraft<ProjectSignalPayload> {
  const entityId = (projectId ?? 'reorder') as DomainULID;
  return {
    scope: 'global',
    projectId: null,
    type: 'project.changed',
    entity: 'project',
    entityId,
    version: null,
    payload: { projectId: entityId },
  };
}

function notFound(projectId: ContractULID): ProjectServiceResult<never> {
  return { ok: false, error: `unknown project: ${projectId}`, code: 'NOT_FOUND' };
}
