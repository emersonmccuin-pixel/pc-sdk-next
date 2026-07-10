export { getDb, getRawDb, closeDb } from './connection.ts';
export type { DB, DbExecutor, DbTransaction } from './connection.ts';
export { newId } from './id.ts';
export { runMigrations, assertSchemaIntact } from './migrate.ts';

export {
  createProject,
  createProjectInDb,
  getProjectById,
  getProjectByIdInDb,
  getProjectBySlug,
  getProjectBySlugInDb,
  listProjects,
  listProjectsInDb,
  reorderProjects,
  reorderProjectsInDb,
  setProjectFocus,
  setProjectFocusInDb,
  softDeleteProject,
  softDeleteProjectInDb,
  updateProjectMeta,
  updateProjectMetaInDb,
  updateProjectNotes,
  updateProjectNotesInDb,
} from './repos/projects.ts';
export type {
  CreateProjectInput,
  ListProjectsOptions,
  UpdateProjectMetaInput,
} from './repos/projects.ts';

export {
  getLatestLiveEventForEntity,
  getLiveEventFloor,
  getLiveEventHighWater,
  insertLiveEvent,
  listLiveEventsAfter,
  listLiveOutboxRowsAfter,
  markLiveEventsPublished,
  pruneLiveOutbox,
  LiveEventCursorError,
} from './repos/live-outbox.ts';
export type {
  InsertLiveEventDraft,
  ListLiveEventsAfterInput,
  ListLiveEventsAfterResult,
  LiveOutboxEntity,
  LiveOutboxEvent,
  LiveOutboxScope,
  PruneLiveOutboxInput,
  PruneLiveOutboxResult,
} from './repos/live-outbox.ts';

// agent_contracts repo (persistence-only; app-services announces).
export {
  createContract,
  createContractInDb,
  getContract,
  getContractInDb,
  listContractsForProject,
  listContractsForProjectInDb,
  listContractsForRun,
  listContractsForRunInDb,
  listAbandonedContractBranches,
  listContractsPendingLanding,
  setContractDeliverable,
  setContractLanding,
  setContractRun,
  setContractVerification,
} from './repos/contracts.ts';
export type {
  ContractRow,
  CreateContractInput,
  SetDeliverableInput,
  SetLandingInput,
  SetVerificationInput,
} from './repos/contracts.ts';

export {
  getActiveWorktreeByName,
  listActiveWorktrees,
  markWorktreeDestroyed,
  upsertWorktree,
} from './repos/worktrees.ts';
export type { UpsertWorktreeInput, WorktreeRow } from './repos/worktrees.ts';

export { getGlobalSettings, setGlobalSettings } from './repos/settings.ts';

export {
  addAgentToProject,
  bumpAgentRev,
  createAgent,
  createSecret,
  deleteSecret,
  getAgentById,
  getAgentByName,
  getPodForSpawn,
  getSecret,
  getSecretByEnvVarName,
  listAgentProjects,
  listAgents,
  listProjectMemberAgents,
  listProjectVisibleAgents,
  listSecrets,
  removeAgentFromProject,
  resolveAgentForDispatch,
  restoreAgent,
  setAgentShareable,
  softDeleteAgent,
  toAgentContextDoc,
  updateAgent,
} from './repos/pods.ts';
export type {
  CreateAgentInput,
  CreateSecretInput,
  GetAgentByNameInput,
  GetSecretByEnvInput,
  ListAgentsOptions,
  ListSecretsOptions,
  UpdateAgentInput,
} from './repos/pods.ts';
export { buildAuditRow, listAgentAudit } from './repos/pod-audit.ts';
export type {
  AuditInput,
  AuditRowValues,
  BuildAuditRowInput,
  ListAgentAuditOptions,
} from './repos/pod-audit.ts';

// conversation replay store (chat events in SQLite; replay = a query).
export {
  appendConversationEvent,
  appendConversationEvents,
  countConversationEvents,
  getConversationHighWaterSeq,
  getConversationReplayState,
  hasConversationEvents,
  listConversationEvents,
} from './repos/conversation-events.ts';
export type {
  AppendConversationEventInput,
  ConversationEventRow,
} from './repos/conversation-events.ts';

export {
  createPendingAsk,
  getPendingAsk,
  hasOpenPendingAskForRun,
  hasPendingAskForRun,
  listOpenPendingAsksForProject,
  listOpenPendingAsksForSession,
  listOpenPendingAsksOlderThan,
  markPendingAskAnswered,
  markPendingAskCancelled,
} from './repos/pending-asks.ts';
export type {
  AnswerPendingAskInput,
  CreatePendingAskInput,
} from './repos/pending-asks.ts';

// pod-revision helper for drift detection.
export {
  computePodRevision,
  podRevisionsDiffer,
} from './repos/pod-revision.ts';
export type { ComputePodRevisionInput } from './repos/pod-revision.ts';

// agent runs repo.
export {
  bumpAgentRunRev,
  findActiveContinuation,
  getAgentRunRow,
  insertAgentRunRow,
  listActiveAgentRunsForProject,
  listAgentRunsForSession,
  listNonTerminalAgentRuns,
  listRecentTerminalAgentRuns,
  markAgentRunDelivered,
  markAgentRunTerminal,
  setAgentRunContractId,
  touchAgentRunActivity,
  updateAgentRunPid,
  updateAgentRunStatus,
} from './repos/agent-runs.ts';
export type {
  InsertAgentRunRowInput,
  ListAgentRunsForSessionOptions,
  MarkAgentRunTerminalInput,
  UpdateAgentRunStatusInput,
} from './repos/agent-runs.ts';

export {
  createOrchestratorSession,
  endOrchestratorSession,
  getActiveOrchestratorSession,
  getOrchestratorSession,
  listOrchestratorSessionsForProject,
  reactivateOrchestratorSession,
  setOrchestratorSessionProvider,
  setOrchestratorSessionTitle,
} from './repos/orchestrator-sessions.ts';
export type {
  CreateOrchestratorSessionInput,
  OrchestratorSessionRow,
} from './repos/orchestrator-sessions.ts';

// ContextDoc repo.
export {
  createContextDoc,
  createContextDocInDb,
  getContextDoc,
  getContextDocInDb,
  getAgentContextDocByTitle,
  listContextDocsForScope,
  listContextDocsForScopeInDb,
  softDeleteContextDoc,
  softDeleteContextDocInDb,
  updateContextDoc,
  updateContextDocInDb,
} from './repos/context-docs.ts';
export type {
  ContextDocRow,
  ContextDocScope,
  CreateContextDocInput,
  ListContextDocsOptions,
  UpdateContextDocInput,
} from './repos/context-docs.ts';

// context-doc read receipts (staleness/usage tracking).
export {
  getContextDocReadStats,
  listContextDocReadsForRun,
  recordContextDocReads,
} from './repos/context-doc-reads.ts';
export type {
  ContextDocReadStats,
  ContextDocReadVia,
  ContextDocSessionKind,
  RecordContextDocReadsInput,
} from './repos/context-doc-reads.ts';

// Credentials vault repo.
export {
  createCredential,
  deleteCredential,
  getCredential,
  getCredentialByServer,
  getCredentialByServerAndKind,
  listCredentialsByScope,
  updateCredentialAuthState,
} from './repos/credentials.ts';
export type { CreateCredentialInput } from './repos/credentials.ts';

// MCP Server Registry repo.
export {
  createMcpServerRegistry,
  getMcpServerRegistry,
  listMcpServersRegistry,
  patchMcpServerRegistry,
  replaceTransportOnly,
  setMcpServerDiscovery,
  softDeleteMcpServerRegistry,
} from './repos/mcp-servers.ts';
export type {
  CreateMcpServerRegistryInput,
  ListMcpServersRegistryOptions,
  PatchMcpServerRegistryInput,
  SetMcpServerDiscoveryInput,
} from './repos/mcp-servers.ts';

// Agent MCP Attachments repo.
export {
  deleteMcpAttachmentByPair,
  getMcpAttachment,
  getMcpAttachmentByPair,
  listMcpAttachmentsForAgent,
  upsertMcpAttachment,
} from './repos/mcp-attachments.ts';
export type { UpsertMcpAttachmentInput } from './repos/mcp-attachments.ts';

// Mailbox repos.
export {
  acquireDeliveryLease,
  enqueueMailboxMessage,
  getMailboxDelivery,
  getMailboxMessage,
  getMailboxMessageByIdempotencyKey,
  getMailboxRecipient,
  listAuditForMessage,
  listDeadLettersForMessage,
  listDeliveriesForMessage,
  listDeliveriesForProject,
  listDueDeliveries,
  listMailboxMessagesBySource,
  listRecipientsForInbox,
  listRecipientsForMessage,
  listUserInboxRecipientsAllProjects,
  markDeliveryAccepted,
  markDeliveryDeadLettered,
  markDeliveryDeferred,
  markDeliveryRetrying,
  markRecipientActioned,
  markRecipientDismissed,
  markRecipientRead,
  writeAudit,
} from './repos/mailbox.ts';
export type {
  EnqueueMailboxMessageInput,
  EnqueueMailboxMessageResult,
  EnqueueMailboxRecipientRow,
  MailboxAuditRow,
  MailboxDeadLetterRow,
  MailboxDeliveryRow,
  MailboxMessageRow,
  MailboxRecipientRow,
  WriteAuditInput,
} from './repos/mailbox.ts';
