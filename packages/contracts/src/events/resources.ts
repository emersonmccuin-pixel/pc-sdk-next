// Channel 2 — Resources (durable, global cursor). See docs/event-contract.md.
//
// The live-outbox pattern: gateway writes the event row in the same transaction
// as the mutation; a post-commit relay fans out. Per-entity style is fixed —
// full-snapshot (payload carries the whole DTO) or signal-only (payload is a
// change signal; the consumer refetches over HTTP). Never mixed per entity.
//
// Closed unions everywhere (guard rule 7): a dead entity name fails typecheck.
// Browser-safe, zero runtime deps.

import { isResourceCursor, isUlid, type ULID } from '../shared.ts';
import {
  isAgentRunChangedLivePayload,
  type AgentRunChangedLivePayload,
} from '../agent-runs.ts';
import type { ContractChangedLivePayload } from '../contracts.ts';
import {
  isSubscriptionQuotaSnapshot,
  type SubscriptionQuotaSnapshot,
} from '../quota.ts';
import type { SessionSummary } from './session.ts';

export const RESOURCE_ENTITIES = [
  'agent-run',
  'contract',
  'specialist',
  'mailbox-message',
  'session-title',
  'mcp-server',
  'project',
  'subscription-quota',
] as const;
export type ResourceEntity = (typeof RESOURCE_ENTITIES)[number];

export type ResourceScope = 'project' | 'global';

// ── Per-entity payloads ───────────────────────────────────────────────────────

/** The MCP manager's reliability bar: every state change surfaces; unknown is a
 *  state. */
export interface McpServerStatus {
  id: string;
  name: string;
  status: 'healthy' | 'degraded' | 'down' | 'unknown';
  reason: string | null;
  lastProbeAt: number | null;
  toolCount: number | null;
  lastError: string | null;
}

/** Signal-only — pods, renamed. Global-scope frames (stock specialists) must
 *  reach project views. */
export interface SpecialistChangedPayload {
  specialistId: ULID;
}

/** Signal-only — inbox refetches the actionable-only list. */
export interface MailboxMessageSignalPayload {
  messageId: ULID;
}

/** Signal-only — replaces the legacy `project.changed` special-case envelope. */
export interface ProjectSignalPayload {
  projectId: ULID;
}

/** Full snapshot — latest-by-cursor wins. */
export interface SessionTitlePayload {
  session: SessionSummary;
}

/** Full snapshot. */
export interface McpServerChangedPayload {
  server: McpServerStatus;
}

// ── Resource event (closed, per-entity discriminated union) ───────────────────

interface ResourceEventBase<E extends ResourceEntity, P> {
  id: ULID;
  /** Global monotonic, numeric-string. */
  cursor: string;
  scope: ResourceScope;
  /** null = global (client selectors must union global into project views). */
  projectId: ULID | null;
  entity: E;
  entityId: ULID;
  eventType: `${E}.changed`;
  /** Per-entity dedup; null = last-write-wins by cursor. */
  version: number | null;
  createdAt: number;
  payload: P;
}

export type ResourceEvent =
  | ResourceEventBase<'agent-run', AgentRunChangedLivePayload>
  | ResourceEventBase<'contract', ContractChangedLivePayload>
  | ResourceEventBase<'specialist', SpecialistChangedPayload>
  | ResourceEventBase<'mailbox-message', MailboxMessageSignalPayload>
  | ResourceEventBase<'session-title', SessionTitlePayload>
  | ResourceEventBase<'mcp-server', McpServerChangedPayload>
  | ResourceEventBase<'project', ProjectSignalPayload>
  | ResourceEventBase<'subscription-quota', SubscriptionQuotaSnapshot>;

export interface ResourceFrame {
  type: 'resource';
  event: ResourceEvent;
}

/** Cursor fell below the pruned floor: clear store, clear cursor, epoch-refetch
 *  everything. */
export interface LiveResetFrame {
  type: 'live-reset';
  projectId: ULID | null;
  cursor: string | null;
}

// ── Guards ─────────────────────────────────────────────────────────────────────

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function nonNegativeSafeInteger(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) >= 0;
}

export function isResourceEntity(value: unknown): value is ResourceEntity {
  return typeof value === 'string' && (RESOURCE_ENTITIES as readonly string[]).includes(value);
}

export function isResourceFrame(value: unknown): value is ResourceFrame {
  if (
    !isRecord(value) ||
    !hasOnlyKeys(value, ['type', 'event']) ||
    value.type !== 'resource' ||
    !isRecord(value.event)
  ) return false;
  const e = value.event;
  if (
    !hasOnlyKeys(e, [
      'id',
      'cursor',
      'scope',
      'projectId',
      'entity',
      'entityId',
      'eventType',
      'version',
      'createdAt',
      'payload',
    ]) ||
    !(
    isUlid(e.id) &&
    isResourceCursor(e.cursor) &&
    (e.scope === 'project' || e.scope === 'global') &&
    (e.projectId === null || typeof e.projectId === 'string') &&
    isResourceEntity(e.entity) &&
    typeof e.entityId === 'string' &&
    e.eventType === `${e.entity}.changed` &&
    (e.version === null || nonNegativeSafeInteger(e.version)) &&
    nonNegativeSafeInteger(e.createdAt) &&
    'payload' in e
    )
  ) return false;

  // Full snapshots cross directly into browser stores. Validate their owned
  // payload and envelope binding before advancing a cursor.
  if (e.entity === 'agent-run') {
    if (!isAgentRunChangedLivePayload(e.payload)) return false;
    return e.scope === 'project' &&
      e.projectId !== null &&
      e.entityId === e.payload.run.runId &&
      e.projectId === e.payload.run.projectId &&
      e.version === e.payload.run.rev;
  }
  if (e.entity === 'subscription-quota') {
    return isSubscriptionQuotaSnapshot(e.payload) &&
      e.scope === 'global' &&
      e.projectId === null &&
      e.entityId === e.payload.id &&
      e.version === e.payload.revision;
  }
  return true;
}

export function isLiveResetFrame(value: unknown): value is LiveResetFrame {
  return (
    isRecord(value) &&
    hasOnlyKeys(value, ['type', 'projectId', 'cursor']) &&
    value.type === 'live-reset' &&
    (value.projectId === null || typeof value.projectId === 'string') &&
    (value.cursor === null || isResourceCursor(value.cursor))
  );
}

function hasOnlyKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  const allowed = new Set(keys);
  return Object.keys(value).every((key) => allowed.has(key));
}

export function isMcpServerStatus(value: unknown): value is McpServerStatus {
  if (!isRecord(value)) return false;
  return (
    typeof value.id === 'string' &&
    typeof value.name === 'string' &&
    (value.status === 'healthy' ||
      value.status === 'degraded' ||
      value.status === 'down' ||
      value.status === 'unknown') &&
    (value.reason === null || typeof value.reason === 'string') &&
    (value.lastProbeAt === null || typeof value.lastProbeAt === 'number') &&
    (value.toolCount === null || typeof value.toolCount === 'number') &&
    (value.lastError === null || typeof value.lastError === 'string')
  );
}
