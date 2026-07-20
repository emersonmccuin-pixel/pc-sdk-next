import { parseErr, parseOk, type ApiResult, type ParseResult, type ULID } from './shared.ts';

export type { ApiResult, ParseResult, ULID } from './shared.ts';

/** Command — the reserved, global planning/steering space. It is a normal
 *  project row identified by this locked slug; the create flow uniques any
 *  user project away from it. Server seeds it at boot; the LeftRail pins it
 *  above the project list. Both server and web key off this one constant. */
export const COMMAND_PROJECT_SLUG = 'command';
export const COMMAND_PROJECT_NAME = 'Command';

export interface ProjectStageDto {
  id: string;
  name: string;
  order: number;
  isDone?: boolean;
  isCancelled?: boolean;
  isNew?: boolean;
  rev?: number;
}

export interface ProjectSettingsDto {
  cancelledVisibility: 'use-global' | 'force-visible' | 'force-hidden';
  remoteControl: 'use-global' | 'on' | 'off';
  /** Branch finished work merges into. Null = auto-detect on next use. */
  integrationBranch?: string | null;
  /** WF-2 — dispatch lifecycle Review-phase default. 'orchestrator-review'
   *  (default) parks a verified pass for the orchestrator's cheap accept;
   *  'full-review' always escalates to the independent review specialist.
   *  An issuer-authored contract spec can still require full-review even
   *  when this is 'orchestrator-review'. */
  reviewPolicy?: 'orchestrator-review' | 'full-review';
  /** WF-2 — opt-in: let a verified repo contract land automatically instead
   *  of parking merge-ready, when the contract's own spec left it open.
   *  Default false. Never applies when the effective policy is
   *  'full-review'. */
  autoMergeEligible?: boolean;
}

/** Mirrors @pc/domain INTEGRATION_BRANCH_RE (contracts can't import domain). */
const INTEGRATION_BRANCH_DTO_RE = /^[A-Za-z0-9][A-Za-z0-9._/-]*$/;

export interface ProjectDto {
  id: ULID;
  slug: string;
  name: string;
  stages: ProjectStageDto[];
  folderPath: string;
  gitRemote: string | null;
  settings: ProjectSettingsDto;
  callsignSeq: number;
  /** pc-pty-chat-333 — per-project scratch notes. Null when none saved yet. */
  notes: string | null;
  /** Command focus — epoch-ms the planner starred this project; null = not in
   *  focus. Drives the LeftRail gold star. */
  focusedAt: number | null;
}

export type CreateProjectMode = 'init-empty' | 'init-in-place' | 'attach-to-git';

export interface ListProjectsQuery {
  include_deleted?: '1';
}

export type ListProjectsResponse = { projects: ProjectDto[] };

export interface CreateProjectRequest {
  name: string;
  folder_path: string;
  mode: CreateProjectMode;
  git_remote?: string | null;
}

export type CreateProjectResponse = ApiResult<{ project: ProjectDto }>;

export interface UpdateProjectRequest {
  name?: string;
  git_remote?: string | null;
  /** Partial overlay merged into the project's settings JSON. Omitted keys
   *  stay unchanged. */
  settings?: Partial<ProjectSettingsDto>;
}

export type UpdateProjectResponse = ApiResult<{ project: ProjectDto }>;

export interface ReorderProjectsRequest {
  orderedIds: ULID[];
}

export type ReorderProjectsResponse = ApiResult<{ projects: ProjectDto[] }>;

export type DeleteProjectResponse = ApiResult<{ project: ProjectDto }>;

export const projectRoutes = {
  list: '/api/projects',
  create: '/api/projects',
  reorder: '/api/projects/reorder',
  detail: (projectId: ULID) => `/api/projects/${encodeURIComponent(projectId)}`,
  notes: (projectId: ULID) => `/api/projects/${encodeURIComponent(projectId)}/notes`,
} as const;

export function parseCreateProjectRequest(input: unknown): ParseResult<CreateProjectRequest> {
  if (!isRecord(input)) return invalidCreateRequest();
  const name = typeof input.name === 'string' ? input.name.trim() : '';
  const folderPath = typeof input.folder_path === 'string' ? input.folder_path.trim() : '';
  const mode = input.mode;
  if (!name || !folderPath || !isCreateProjectMode(mode)) return invalidCreateRequest();
  const request: CreateProjectRequest = {
    name,
    folder_path: folderPath,
    mode,
  };
  if (input.git_remote !== undefined) {
    const gitRemote = parseOptionalGitRemote(input.git_remote);
    if (!gitRemote.ok) return gitRemote;
    request.git_remote = gitRemote.value;
  }
  return parseOk(request);
}

export function parseUpdateProjectRequest(input: unknown): ParseResult<UpdateProjectRequest> {
  if (!isRecord(input)) return parseErr('request body must be an object');
  const request: UpdateProjectRequest = {};
  if (typeof input.name === 'string') {
    const name = input.name.trim();
    if (!name) return parseErr('name cannot be empty');
    request.name = name;
  }
  if (input.git_remote !== undefined) {
    const gitRemote = parseOptionalGitRemote(input.git_remote);
    if (!gitRemote.ok) return gitRemote;
    request.git_remote = gitRemote.value;
  }
  if (input.settings !== undefined) {
    if (!isRecord(input.settings)) return parseErr('settings must be an object');
    const settings: Partial<ProjectSettingsDto> = {};
    const cv = input.settings.cancelledVisibility;
    if (cv !== undefined) {
      if (cv !== 'use-global' && cv !== 'force-visible' && cv !== 'force-hidden') {
        return parseErr('invalid cancelledVisibility');
      }
      settings.cancelledVisibility = cv;
    }
    const rc = input.settings.remoteControl;
    if (rc !== undefined) {
      if (rc !== 'use-global' && rc !== 'on' && rc !== 'off') {
        return parseErr('invalid remoteControl');
      }
      settings.remoteControl = rc;
    }
    const ib = input.settings.integrationBranch;
    if (ib !== undefined) {
      if (ib === null || (typeof ib === 'string' && ib.trim() === '')) {
        settings.integrationBranch = null; // blank = re-detect on next use
      } else if (typeof ib === 'string' && INTEGRATION_BRANCH_DTO_RE.test(ib.trim())) {
        settings.integrationBranch = ib.trim();
      } else {
        return parseErr('invalid integrationBranch');
      }
    }
    const rp = input.settings.reviewPolicy;
    if (rp !== undefined) {
      if (rp !== 'orchestrator-review' && rp !== 'full-review') {
        return parseErr('invalid reviewPolicy');
      }
      settings.reviewPolicy = rp;
    }
    const ame = input.settings.autoMergeEligible;
    if (ame !== undefined) {
      if (typeof ame !== 'boolean') {
        return parseErr('invalid autoMergeEligible');
      }
      settings.autoMergeEligible = ame;
    }
    request.settings = settings;
  }
  return parseOk(request);
}

export function parseReorderProjectsRequest(input: unknown): ParseResult<ReorderProjectsRequest> {
  if (!isRecord(input) || !Array.isArray(input.orderedIds) || !input.orderedIds.every(isString)) {
    return parseErr('orderedIds must be an array of strings');
  }
  return parseOk({ orderedIds: [...input.orderedIds] });
}

export function parseListProjectsQuery(input: unknown): ListProjectsQuery {
  if (!isRecord(input)) return {};
  return input.include_deleted === '1' ? { include_deleted: '1' } : {};
}

export function isCreateProjectMode(value: unknown): value is CreateProjectMode {
  return value === 'init-empty' || value === 'init-in-place' || value === 'attach-to-git';
}

export function isProjectStageDto(value: unknown): value is ProjectStageDto {
  if (!isRecord(value)) return false;
  return (
    typeof value.id === 'string' &&
    typeof value.name === 'string' &&
    typeof value.order === 'number' &&
    isOptionalBoolean(value.isDone) &&
    isOptionalBoolean(value.isCancelled) &&
    isOptionalBoolean(value.isNew) &&
    (value.rev === undefined || typeof value.rev === 'number')
  );
}

export function isProjectSettingsDto(value: unknown): value is ProjectSettingsDto {
  if (!isRecord(value)) return false;
  const cancelledOk =
    value.cancelledVisibility === 'use-global' ||
    value.cancelledVisibility === 'force-visible' ||
    value.cancelledVisibility === 'force-hidden';
  const remoteOk =
    value.remoteControl === 'use-global' ||
    value.remoteControl === 'on' ||
    value.remoteControl === 'off';
  const ibOk =
    value.integrationBranch === undefined ||
    value.integrationBranch === null ||
    typeof value.integrationBranch === 'string';
  const reviewPolicyOk =
    value.reviewPolicy === undefined ||
    value.reviewPolicy === 'orchestrator-review' ||
    value.reviewPolicy === 'full-review';
  const autoMergeEligibleOk =
    value.autoMergeEligible === undefined || typeof value.autoMergeEligible === 'boolean';
  return cancelledOk && remoteOk && ibOk && reviewPolicyOk && autoMergeEligibleOk;
}

export function isProjectDto(value: unknown): value is ProjectDto {
  if (!isRecord(value)) return false;
  return (
    typeof value.id === 'string' &&
    typeof value.slug === 'string' &&
    typeof value.name === 'string' &&
    Array.isArray(value.stages) &&
    value.stages.every(isProjectStageDto) &&
    typeof value.folderPath === 'string' &&
    (value.gitRemote === null || typeof value.gitRemote === 'string') &&
    isProjectSettingsDto(value.settings) &&
    typeof value.callsignSeq === 'number' &&
    (value.notes === null || value.notes === undefined || typeof value.notes === 'string') &&
    (value.focusedAt === null || value.focusedAt === undefined || typeof value.focusedAt === 'number')
  );
}

function invalidCreateRequest(): ParseResult<never> {
  return parseErr('name, folder_path, and mode required');
}

function parseOptionalGitRemote(value: unknown): ParseResult<string | null> {
  if (value === null || value === undefined) return parseOk(null);
  return parseOk(String(value).trim() || null);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function isString(value: unknown): value is string {
  return typeof value === 'string';
}

function isOptionalBoolean(value: unknown): boolean {
  return value === undefined || typeof value === 'boolean';
}
