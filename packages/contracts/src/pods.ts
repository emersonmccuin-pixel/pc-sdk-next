// Pod (agent-definition) change contract. Pods are the Agents-tab roster:
// DB-owned facts in the `agents` table. A pod mutation
// (create/update/delete/clone/promote/reset, plus nested knowledge/secret/mcp
// edits) emits a signal-only change on the new `resource` frame under the
// `specialist` entity (`{ specialistId }`, see events/resources.ts); the roster
// refetches the list rather than applying a snapshot inline.
//
// Internal naming keeps 'pod' (the WIRE entity is 'specialist' per the event
// contract; the specialist rename is Phase 3). This module owns the mutation
// kind + the minimal change payload the server builds before mapping to the
// wire signal.

import { parseErr, parseOk, type ParseResult, type ULID } from './shared.ts';

export type PodChangedKind = 'created' | 'updated' | 'deleted';

export const POD_CHANGED_KINDS: readonly PodChangedKind[] = ['created', 'updated', 'deleted'];

export interface PodChangedLivePayload {
  change: PodChangedKind;
  podId: ULID;
  /** Best-effort name for logging/UX; the roster refetches for the truth. */
  name?: string;
}

export function isPodChangedKind(value: unknown): value is PodChangedKind {
  return typeof value === 'string' && (POD_CHANGED_KINDS as readonly string[]).includes(value);
}

export function isPodChangedLivePayload(value: unknown): value is PodChangedLivePayload {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const v = value as Record<string, unknown>;
  if (!isPodChangedKind(v.change)) return false;
  if (typeof v.podId !== 'string' || !v.podId) return false;
  if (v.name !== undefined && typeof v.name !== 'string') return false;
  return true;
}

// ── Agent-pool HTTP request parsing ───────────────────────────────────────────
// Mirrors @pc/domain AGENT_EFFORTS (contracts can't import domain).

export const POD_EFFORTS = ['low', 'medium', 'high', 'xhigh', 'max'] as const;
export type PodEffort = (typeof POD_EFFORTS)[number];

/** Kebab-case names only — agent names are dispatch keys and URL segments. */
const POD_NAME_RE = /^[a-z0-9][a-z0-9-]*$/;

export interface CreatePodRequest {
  name: string;
  description?: string;
  prompt?: string;
  model?: string | null;
  effort?: PodEffort | null;
  maxTurns?: number | null;
  tools?: string[];
  /** Convenience: attach to this project in the same request (the create modal
   *  lives inside a project). */
  attachProjectId?: ULID;
}

export interface UpdatePodRequest {
  name?: string;
  description?: string;
  prompt?: string;
  model?: string | null;
  effort?: PodEffort | null;
  maxTurns?: number | null;
  tools?: string[];
}

export function parseCreatePodRequest(input: unknown): ParseResult<CreatePodRequest> {
  if (!isPodRecord(input)) return parseErr('request body must be an object');
  const name = typeof input.name === 'string' ? input.name.trim() : '';
  if (!name) return parseErr('name required');
  if (!POD_NAME_RE.test(name)) return parseErr('name must be kebab-case (a-z, 0-9, dashes)');
  const shared = parsePodFields(input);
  if (!shared.ok) return shared;
  const request: CreatePodRequest = { name, ...shared.value };
  if (input.attachProjectId !== undefined) {
    if (typeof input.attachProjectId !== 'string' || !input.attachProjectId) {
      return parseErr('attachProjectId must be a non-empty string');
    }
    request.attachProjectId = input.attachProjectId as ULID;
  }
  return parseOk(request);
}

export function parseUpdatePodRequest(input: unknown): ParseResult<UpdatePodRequest> {
  if (!isPodRecord(input)) return parseErr('request body must be an object');
  const shared = parsePodFields(input);
  if (!shared.ok) return shared;
  const request: UpdatePodRequest = { ...shared.value };
  if (input.name !== undefined) {
    const name = typeof input.name === 'string' ? input.name.trim() : '';
    if (!name || !POD_NAME_RE.test(name)) return parseErr('name must be kebab-case (a-z, 0-9, dashes)');
    request.name = name;
  }
  if (Object.keys(request).length === 0) return parseErr('empty patch');
  return parseOk(request);
}

/** The optional fields shared by create + update. Absent keys stay absent. */
function parsePodFields(
  input: Record<string, unknown>,
): ParseResult<Omit<UpdatePodRequest, 'name'>> {
  const out: Omit<UpdatePodRequest, 'name'> = {};
  if (input.description !== undefined) {
    if (typeof input.description !== 'string') return parseErr('description must be a string');
    out.description = input.description;
  }
  if (input.prompt !== undefined) {
    if (typeof input.prompt !== 'string') return parseErr('prompt must be a string');
    out.prompt = input.prompt;
  }
  if (input.model !== undefined) {
    if (input.model === null) out.model = null;
    else if (typeof input.model === 'string') out.model = input.model.trim() || null;
    else return parseErr('model must be a string or null');
  }
  if (input.effort !== undefined) {
    if (input.effort === null) out.effort = null;
    else if ((POD_EFFORTS as readonly string[]).includes(input.effort as string)) {
      out.effort = input.effort as PodEffort;
    } else return parseErr(`effort must be one of ${POD_EFFORTS.join('/')} or null`);
  }
  if (input.maxTurns !== undefined) {
    if (input.maxTurns === null) out.maxTurns = null;
    else if (
      typeof input.maxTurns === 'number' &&
      Number.isInteger(input.maxTurns) &&
      input.maxTurns > 0
    ) {
      out.maxTurns = input.maxTurns;
    } else return parseErr('maxTurns must be a positive integer or null');
  }
  if (input.tools !== undefined) {
    if (!Array.isArray(input.tools) || !input.tools.every((t) => typeof t === 'string')) {
      return parseErr('tools must be an array of strings');
    }
    out.tools = input.tools.map((t) => (t as string).trim()).filter((t) => t.length > 0);
  }
  return parseOk(out);
}

function isPodRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}
