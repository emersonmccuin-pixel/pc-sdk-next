import { sql } from 'drizzle-orm';
import { index, integer, primaryKey, sqliteTable, text, uniqueIndex } from 'drizzle-orm/sqlite-core';
import type { ResourceEntity } from '@pc/contracts';
import type {
  AgentEffort,
  AgentModel,
  CredentialAuthState,
  CredentialKind,
  ExpectedOutput,
  GlobalSettings,
  McpDiscoveryStatus,
  McpServerTransport,
  PodAuditActor,
  PodAuditField,
  PodScope,
  ProviderId,
  SessionEndedReason,
  SessionStatus,
  ULID,
  WorktreeStatus,
} from '@pc/domain';


/**
 * SQLite schema (drizzle). Conventions:
 * - ULIDs as `text` PKs.
 * - Timestamps as `integer` epoch ms (numbers in TS).
 * - JSON blobs via `text({ mode: 'json' })`.
 * - Soft delete = nullable `deleted_at` (where the table needs it).
 */

export const projects = sqliteTable(
  'projects',
  {
    id: text('id').primaryKey().$type<ULID>(),
    slug: text('slug').notNull(),
    name: text('name').notNull(),
    settings: text('settings', { mode: 'json' })
      .notNull()
      .default(sql`'{}'`)
      .$type<Record<string, unknown>>(),
    folderPath: text('folder_path').notNull().default(''),
    gitRemote: text('git_remote'),
    /** Sort key for the LeftRail Projects list. New projects append at
     *  `max(position) + 1`; drag-reorder rewrites every row in one transaction. */
    position: integer('position').notNull().default(0),
    /** Monotonic, never-reused counter for top-level callsign numbering. */
    callsignSeq: integer('callsign_seq').notNull().default(0),
    /** Per-project scratch notes. Plain text, nullable. */
    notes: text('notes'),
    /** Command focus — epoch-ms when the planner last starred this project;
     *  NULL = not in focus. */
    focusedAt: integer('focused_at'),
    createdAt: integer('created_at').notNull(),
    updatedAt: integer('updated_at').notNull(),
    deletedAt: integer('deleted_at'),
  },
  (t) => [
    uniqueIndex('projects_slug_idx').on(t.slug).where(sql`deleted_at IS NULL`),
    index('projects_position_idx').on(t.position),
  ],
);

export const liveOutbox = sqliteTable(
  'live_outbox',
  {
    seq: integer('seq').primaryKey({ autoIncrement: true }),
    id: text('id').notNull(),
    scope: text('scope').notNull().$type<'project' | 'global'>(),
    projectId: text('project_id').$type<ULID | null>(),
    type: text('type').notNull(),
    /** Closed union — the contract's ResourceEntity names (guard rule 7). */
    entity: text('entity').notNull().$type<ResourceEntity>(),
    entityId: text('entity_id').$type<ULID | null>(),
    version: integer('version'),
    payload: text('payload', { mode: 'json' })
      .notNull()
      .$type<Record<string, unknown>>(),
    createdAt: integer('created_at').notNull(),
    publishedAt: integer('published_at'),
  },
  (t) => [
    uniqueIndex('live_outbox_id_idx').on(t.id),
    index('live_outbox_created_idx').on(t.createdAt),
    index('live_outbox_project_seq_idx').on(t.projectId, t.seq),
    index('live_outbox_scope_seq_idx').on(t.scope, t.seq),
    index('live_outbox_type_seq_idx').on(t.type, t.seq),
    index('live_outbox_entity_idx').on(t.entity, t.entityId, t.seq),
  ],
);

export const worktrees = sqliteTable(
  'worktrees',
  {
    id: text('id').primaryKey().$type<ULID>(),
    /** Branch name == worktree dir name (`wi-<id>` or `run-<short>`). */
    name: text('name').notNull(),
    path: text('path').notNull(),
    status: text('status').notNull().default('active').$type<WorktreeStatus>(),
    createdAt: integer('created_at').notNull(),
    destroyedAt: integer('destroyed_at'),
  },
  (t) => [
    uniqueIndex('worktrees_name_active_idx').on(t.name).where(sql`status = 'active'`),
    uniqueIndex('worktrees_path_active_idx').on(t.path).where(sql`status = 'active'`),
  ],
);

export const orchestratorSessions = sqliteTable(
  'orchestrator_sessions',
  {
    id: text('id').primaryKey().$type<ULID>(),
    projectId: text('project_id')
      .notNull()
      .$type<ULID>()
      .references(() => projects.id),
    provider: text('provider').notNull().$type<ProviderId>(),
    /** Provider's own session ID. Null until first `result` event. */
    providerSessionId: text('provider_session_id'),
    model: text('model'),
    title: text('title'),
    status: text('status', { enum: ['active', 'ended'] })
      .notNull()
      .default('active')
      .$type<SessionStatus>(),
    endedReason: text('ended_reason').$type<SessionEndedReason>(),
    startedAt: integer('started_at').notNull(),
    endedAt: integer('ended_at'),
    deletedAt: integer('deleted_at'),
  },
  (t) => [
    /** One active session per project (DB-enforced). */
    uniqueIndex('orch_sessions_active_per_project_idx')
      .on(t.projectId)
      .where(sql`status = 'active' AND deleted_at IS NULL`),
  ],
);

export const settingsGlobal = sqliteTable('settings_global', {
  id: text('id').primaryKey(),
  values: text('values', { mode: 'json' })
    .notNull()
    .default(sql`'{}'`)
    .$type<GlobalSettings>(),
  updatedAt: integer('updated_at').notNull(),
});

/**
 * Agent pod tables. `agents` + secrets + project membership + audit.
 *
 * Conventions:
 * - ULIDs as `text` PKs.
 * - `tools_json` is JSON-encoded via Drizzle's `{ mode: 'json' }`.
 * - Soft delete on `agents` (`deleted_at` nullable); content tables are hard-
 *   deleted alongside an `agent_audit` row.
 */

export const agents = sqliteTable(
  'agents',
  {
    id: text('id').primaryKey().$type<ULID>(),
    /** Kebab-case agent name. */
    name: text('name').notNull(),
    scope: text('scope').notNull().$type<PodScope>(),
    /** NULL when `scope === 'global'`; required when `scope === 'project'`. */
    projectId: text('project_id').$type<ULID | null>(),
    prompt: text('prompt').notNull().default(''),
    /** Allowlist of tool names. Wildcards expanded at materialisation time.
     *  Empty = allow all. */
    tools: text('tools_json', { mode: 'json' })
      .notNull()
      .default(sql`'[]'`)
      .$type<string[]>(),
    model: text('model').$type<AgentModel | null>(),
    effort: text('effort').$type<AgentEffort | null>(),
    maxTurns: integer('max_turns'),
    description: text('description').notNull().default(''),
    /** `'stock'` (seeded by PC) vs `'user-created'` (any other row). */
    origin: text('origin')
      .notNull()
      .default('user-created')
      .$type<'stock' | 'user-created'>(),
    /** When true this agent is in the shared library and can be attached to
     *  multiple projects via `agent_projects`. */
    shareable: integer('shareable', { mode: 'boolean' }).notNull().default(false),
    /** Orchestrator-facing "when to dispatch this agent" hint. Nullable. */
    dispatchGuidance: text('dispatch_guidance'),
    /** Default expected_output for this pod. Null for stock + user pods that
     *  haven't declared one. */
    expectedOutput: text('expected_output', { mode: 'json' }).$type<ExpectedOutput | null>(),
    /** Monotonic write counter — stamped into WS deltas so stale ones drop. */
    rev: integer('rev').notNull().default(0),
    createdAt: integer('created_at').notNull(),
    updatedAt: integer('updated_at').notNull(),
    deletedAt: integer('deleted_at'),
  },
  (t) => [
    /** Unique global agent name (live rows only). */
    uniqueIndex('agents_global_name_idx')
      .on(t.name)
      .where(sql`scope = 'global' AND deleted_at IS NULL`),
    /** Unique per-project agent name (live rows only). */
    uniqueIndex('agents_project_name_idx')
      .on(t.projectId, t.name)
      .where(sql`scope = 'project' AND deleted_at IS NULL`),
    index('agents_scope_project_idx').on(t.scope, t.projectId),
  ],
);

export const agentSecrets = sqliteTable(
  'agent_secrets',
  {
    id: text('id').primaryKey().$type<ULID>(),
    agentId: text('agent_id')
      .notNull()
      .$type<ULID>()
      .references(() => agents.id),
    scope: text('scope').notNull().$type<PodScope>(),
    projectId: text('project_id').$type<ULID | null>(),
    envVarName: text('env_var_name').notNull(),
    /** v1: plaintext. */
    valuePlaintext: text('value_plaintext').notNull(),
    createdAt: integer('created_at').notNull(),
  },
  (t) => [
    index('agent_secrets_agent_idx').on(t.agentId),
    index('agent_secrets_scope_project_idx').on(t.scope, t.projectId),
    /** Per-agent secret (shared across all projects the agent is attached to). */
    uniqueIndex('agent_secrets_env_idx').on(t.agentId, t.envVarName),
  ],
);

/**
 * Agent ↔ Project membership join table. One row per (agent, project) pair.
 * Stock agents (origin='stock') are implicitly all-projects and have NO rows
 * here; all other agents need at least one row to be visible in a project.
 */
export const agentProjects = sqliteTable(
  'agent_projects',
  {
    agentId: text('agent_id')
      .notNull()
      .$type<ULID>()
      .references(() => agents.id),
    projectId: text('project_id')
      .notNull()
      .$type<ULID>()
      .references(() => projects.id),
    createdAt: integer('created_at').notNull(),
  },
  (t) => [
    primaryKey({ columns: [t.agentId, t.projectId] }),
    index('agent_projects_project_idx').on(t.projectId),
  ],
);

export const agentAudit = sqliteTable(
  'agent_audit',
  {
    id: text('id').primaryKey().$type<ULID>(),
    agentId: text('agent_id')
      .notNull()
      .$type<ULID>()
      .references(() => agents.id),
    /** Groups multi-field edits into one History card. NULL for solo edits. */
    changeSetId: text('change_set_id').$type<ULID | null>(),
    actor: text('actor').notNull().$type<PodAuditActor>(),
    field: text('field').notNull().$type<PodAuditField>(),
    /** Disambiguator for list-shaped fields. NULL for scalar fields. */
    fieldRef: text('field_ref'),
    /** Always NULL for `secret` rows — secrets log event-only. */
    priorValue: text('prior_value'),
    newValue: text('new_value'),
    reason: text('reason'),
    createdAt: integer('created_at').notNull(),
  },
  (t) => [
    index('agent_audit_agent_idx').on(t.agentId),
    index('agent_audit_change_set_idx').on(t.changeSetId),
  ],
);

// Agent system tables (agent_runs, agent_contracts, pending_asks). Defined in
// schema-agent-system.ts (kept separate so the concern stays grep-able).
// Re-exported here so drizzle-kit's single-file config picks them up.
export { agentRuns, agentContracts, pendingAsks } from './schema-agent-system.ts';

/**
 * MCP Server Registry. One row per registered server, scoped to `'global'` or
 * `'project'` (mirrors `agents`). `discovered_tools` / `discoveryStatus` are
 * populated by the discovery probe. Soft-delete via `deleted_at`.
 */
export const mcpServers = sqliteTable(
  'mcp_servers',
  {
    id: text('id').primaryKey().$type<ULID>(),
    scope: text('scope').notNull().$type<PodScope>(),
    /** Null when `scope === 'global'`; required when `scope === 'project'`. */
    projectId: text('project_id')
      .$type<ULID | null>()
      .references(() => projects.id),
    name: text('name').notNull(),
    description: text('description').notNull().default(''),
    /** Stored transport — may contain SecretRef objects in headers/env.
     *  Resolve via resolveTransportSecrets before using. */
    transport: text('transport', { mode: 'json' }).notNull().$type<McpServerTransport>(),
    /** Tool list populated by the discovery probe. Null until discovered. */
    discoveredTools: text('discovered_tools', { mode: 'json' }).$type<string[] | null>(),
    discoveryStatus: text('discovery_status')
      .notNull()
      .default('stale')
      .$type<McpDiscoveryStatus>(),
    /** Monotonic write counter — incremented on every mutating write. */
    rev: integer('rev').notNull().default(0),
    createdAt: integer('created_at').notNull(),
    updatedAt: integer('updated_at').notNull(),
    deletedAt: integer('deleted_at'),
  },
  (t) => [
    index('mcp_servers_scope_project_idx').on(t.scope, t.projectId),
    /** Unique global server name (live rows only). */
    uniqueIndex('mcp_servers_global_name_idx')
      .on(t.name)
      .where(sql`scope = 'global' AND deleted_at IS NULL`),
    /** Unique per-project server name (live rows only). */
    uniqueIndex('mcp_servers_project_name_idx')
      .on(t.projectId, t.name)
      .where(sql`scope = 'project' AND deleted_at IS NULL`),
  ],
);

/**
 * Agent → registry MCP server attachment link. One row per (agent,
 * registered-server) pair. `enabled_tools` is either the literal `'*'` (all
 * tools) or a JSON-encoded `string[]` (specific subset).
 */
export const agentMcpAttachments = sqliteTable(
  'agent_mcp_attachments',
  {
    id: text('id').primaryKey().$type<ULID>(),
    agentId: text('agent_id')
      .notNull()
      .$type<ULID>()
      .references(() => agents.id),
    mcpServerId: text('mcp_server_id')
      .notNull()
      .$type<ULID>()
      .references(() => mcpServers.id),
    /** `'*'` = all tools; JSON-encoded `string[]` = specific subset. */
    enabledTools: text('enabled_tools').notNull().default('*'),
    createdAt: integer('created_at').notNull(),
    updatedAt: integer('updated_at').notNull(),
  },
  (t) => [
    index('agent_mcp_attachments_agent_idx').on(t.agentId),
    uniqueIndex('agent_mcp_attachments_unique_idx').on(t.agentId, t.mcpServerId),
  ],
);

/**
 * The orchestrator chat's replay store — one row per persisted chat event.
 * Replay = a query by per-session `seq`. Shape follows docs/event-contract.md
 * (Channel 1 — Chat): `id` is the `${sessionId}:${seq}` dedup key; `sdk_uuid`
 * powers retraction + delta reconciliation; `client_message_id` reconciles the
 * optimistic user-send path. UNIQUE(session_id, seq) is the persist-time guard.
 */
export const conversationEvents = sqliteTable(
  'conversation_events',
  {
    /** `${sessionId}:${seq}` — the dedup key the UI keys on. */
    id: text('id').primaryKey(),
    projectId: text('project_id').notNull().$type<ULID>(),
    sessionId: text('session_id').notNull(),
    seq: integer('seq').notNull(),
    kind: text('kind'),
    event: text('event', { mode: 'json' }).notNull().$type<unknown>(),
    /** SDK message uuid — for retraction + delta reconciliation. Nullable. */
    sdkUuid: text('sdk_uuid'),
    /** Stamped on the user-turn row before broadcast. Nullable. */
    clientMessageId: text('client_message_id'),
    createdAt: integer('created_at').notNull(),
  },
  (t) => [uniqueIndex('conversation_events_session_seq_idx').on(t.sessionId, t.seq)],
);

/** A durable mailbox message. `idempotency_key` dedupes replayed sources. */
export const mailboxMessages = sqliteTable(
  'mailbox_messages',
  {
    id: text('id').primaryKey().$type<ULID>(),
    /** Soft project reference (no FK); null for the global user-inbox. */
    projectId: text('project_id').$type<ULID | null>(),
    kind: text('kind').notNull(),
    subject: text('subject'),
    body: text('body').notNull(),
    payload: text('payload', { mode: 'json' }).notNull().default(sql`'{}'`).$type<Record<string, unknown>>(),
    sourceKind: text('source_kind').notNull(),
    sourceId: text('source_id'),
    idempotencyKey: text('idempotency_key').notNull(),
    createdAt: integer('created_at').notNull(),
    updatedAt: integer('updated_at').notNull(),
  },
  (t) => [
    uniqueIndex('mailbox_messages_idempotency_idx').on(t.idempotencyKey),
    index('mailbox_messages_project_idx').on(t.projectId, t.createdAt),
  ],
);

/** Per-recipient address + UI read/action/dismiss state (NOT delivery state). */
export const mailboxRecipients = sqliteTable(
  'mailbox_recipients',
  {
    id: text('id').primaryKey().$type<ULID>(),
    messageId: text('message_id').notNull().$type<ULID>(),
    addressKind: text('address_kind').notNull(),
    addressJson: text('address_json', { mode: 'json' }).notNull().$type<Record<string, unknown>>(),
    readAt: integer('read_at'),
    actionedAt: integer('actioned_at'),
    dismissedAt: integer('dismissed_at'),
    createdAt: integer('created_at').notNull(),
  },
  (t) => [
    index('mailbox_recipients_message_idx').on(t.addressKind, t.messageId),
    index('mailbox_recipients_unread_idx').on(t.addressKind, t.readAt),
  ],
);

/** Delivery lease/ack/retry/dead-letter state per (message, recipient, channel). */
export const mailboxDeliveries = sqliteTable(
  'mailbox_deliveries',
  {
    id: text('id').primaryKey().$type<ULID>(),
    messageId: text('message_id').notNull().$type<ULID>(),
    recipientId: text('recipient_id').notNull().$type<ULID>(),
    channel: text('channel').notNull(),
    status: text('status').notNull().default('pending'),
    leaseOwner: text('lease_owner'),
    leaseExpiresAt: integer('lease_expires_at'),
    attempts: integer('attempts').notNull().default(0),
    nextAttemptAt: integer('next_attempt_at'),
    targetRefKind: text('target_ref_kind'),
    targetRefId: text('target_ref_id'),
    lastError: text('last_error'),
    createdAt: integer('created_at').notNull(),
    updatedAt: integer('updated_at').notNull(),
    acceptedAt: integer('accepted_at'),
    failedAt: integer('failed_at'),
  },
  (t) => [
    index('mailbox_deliveries_status_idx').on(t.status, t.nextAttemptAt),
    index('mailbox_deliveries_recipient_idx').on(t.recipientId, t.status),
    index('mailbox_deliveries_target_idx').on(t.targetRefKind, t.targetRefId),
  ],
);

/** Terminal dead-letter audit for exhausted/non-retryable deliveries. */
export const mailboxDeadLetters = sqliteTable(
  'mailbox_dead_letters',
  {
    id: text('id').primaryKey().$type<ULID>(),
    messageId: text('message_id').notNull().$type<ULID>(),
    recipientId: text('recipient_id').$type<ULID | null>(),
    deliveryId: text('delivery_id').$type<ULID | null>(),
    reason: text('reason').notNull(),
    lastError: text('last_error'),
    createdAt: integer('created_at').notNull(),
  },
  (t) => [index('mailbox_dead_letters_message_idx').on(t.messageId)],
);

/** Append-only mailbox action audit. */
export const mailboxAudit = sqliteTable(
  'mailbox_audit',
  {
    id: text('id').primaryKey().$type<ULID>(),
    messageId: text('message_id').$type<ULID | null>(),
    recipientId: text('recipient_id').$type<ULID | null>(),
    deliveryId: text('delivery_id').$type<ULID | null>(),
    action: text('action').notNull(),
    actorKind: text('actor_kind').notNull(),
    actorId: text('actor_id'),
    details: text('details', { mode: 'json' }).$type<Record<string, unknown> | null>(),
    createdAt: integer('created_at').notNull(),
  },
  (t) => [
    index('mailbox_audit_message_idx').on(t.messageId, t.createdAt),
    index('mailbox_audit_delivery_idx').on(t.deliveryId, t.createdAt),
  ],
);

/**
 * ContextDocs — docs attachable to a project or an agent. Exactly one of
 * (project_id, agent_id) must be non-null; enforced by the repo writer.
 *
 * `author` is free-form: 'user' | 'orchestrator' | '<agent-run-id>'.
 */
export const contextDocs = sqliteTable(
  'context_docs',
  {
    id: text('id').primaryKey().$type<ULID>(),
    /** Scope pointer — exactly one non-null. */
    projectId: text('project_id').$type<ULID | null>(),
    agentId: text('agent_id').$type<ULID | null>(),
    title: text('title').notNull(),
    body: text('body').notNull().default(''),
    /** 'user' | 'orchestrator' | agent-run-id. */
    author: text('author').notNull().default('user'),
    createdAt: integer('created_at').notNull(),
    updatedAt: integer('updated_at').notNull(),
    /** Soft-delete. Soft-deleted docs excluded from all reads. */
    deletedAt: integer('deleted_at'),
  },
  (t) => [
    index('context_docs_project_idx').on(t.projectId),
    index('context_docs_agent_idx').on(t.agentId),
  ],
);

/**
 * Credentials vault. One row per token set, encrypted at rest with
 * AES-256-GCM. Ciphertext, IV, and auth tag are base64 text. `owner_server_id`
 * soft-links to `mcp_servers.id` (no DB FK — credential may precede the server
 * row during initial OAuth flow).
 */
export const credentials = sqliteTable(
  'credentials',
  {
    id: text('id').primaryKey().$type<ULID>(),
    /** `'global'` = shared across all projects; `'project'` = project-local. */
    ownerScope: text('owner_scope').notNull().$type<'global' | 'project'>(),
    /** Soft FK to `mcp_servers.id` — no cascade, no DB constraint. */
    ownerServerId: text('owner_server_id').$type<ULID | null>(),
    kind: text('kind').notNull().$type<CredentialKind>(),
    ciphertext: text('ciphertext').notNull(),
    iv: text('iv').notNull(),
    authTag: text('auth_tag').notNull(),
    authState: text('auth_state').notNull().default('none').$type<CredentialAuthState>(),
    lastError: text('last_error'),
    expiresAt: integer('expires_at'),
    /** Monotonic write counter — incremented on every mutating write. */
    rev: integer('rev').notNull().default(0),
    createdAt: integer('created_at').notNull(),
    updatedAt: integer('updated_at').notNull(),
  },
  (t) => [
    index('credentials_owner_server_idx').on(t.ownerServerId),
    index('credentials_owner_scope_idx').on(t.ownerScope),
  ],
);

/**
 * Read receipts for context docs (staleness/usage tracking). One row per
 * consumption: 'injection' = the doc's BODY was inlined into an agent's spawn
 * prompt; 'tool' = fetched at runtime via pc_get_context_doc. No FKs by design.
 */
export const contextDocReads = sqliteTable(
  'context_doc_reads',
  {
    id: text('id').primaryKey().$type<ULID>(),
    docId: text('doc_id').notNull().$type<ULID>(),
    /** Null for orchestrator-session reads (no agent run). */
    agentRunId: text('agent_run_id').$type<ULID | null>(),
    sessionKind: text('session_kind').notNull().$type<'agent-run' | 'orchestrator'>(),
    readVia: text('read_via').notNull().$type<'injection' | 'tool'>(),
    readAt: integer('read_at').notNull(),
  },
  (t) => [
    index('context_doc_reads_doc_idx').on(t.docId, t.readAt),
    index('context_doc_reads_run_idx').on(t.agentRunId),
  ],
);
