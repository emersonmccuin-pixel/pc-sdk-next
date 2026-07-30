export { getDb, getRawDb, closeDb } from './connection.ts';
export type { DB, DbExecutor, DbTransaction } from './connection.ts';
export { newId } from './id.ts';
export { runMigrations, assertSchemaIntact } from './migrate.ts';

export {
  bindProjectRepositoryIdentity,
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
  updateProjectWorktreeProfile,
  updateProjectWorktreeProfileInDb,
} from './repos/projects.ts';
export type {
  CreateProjectInput,
  ListProjectsOptions,
  UpdateProjectMetaInput,
} from './repos/projects.ts';

export {
  getLatestLiveEventForEntity,
  getLatestLiveEventsPerEntityId,
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

export {
  getSubscriptionQuotaSnapshot,
  getSubscriptionQuotaSnapshotInDb,
  insertSubscriptionQuotaSnapshotInDb,
  listSubscriptionQuotaSnapshots,
  listSubscriptionQuotaSnapshotsInDb,
  updateSubscriptionQuotaSnapshotInDb,
  SubscriptionQuotaRevisionConflictError,
} from './repos/subscription-quota.ts';
export type { SubscriptionQuotaRow } from './repos/subscription-quota.ts';

// agent_contracts repo (persistence-only; app-services announces).
export {
  createContract,
  createContractInDb,
  findContractByReviewRun,
  getContract,
  getContractInDb,
  listContractsForProject,
  listContractsForProjectInDb,
  listContractsForRun,
  listContractsForRunInDb,
  listAbandonedContractBranches,
  listContractsNeedingAbandonmentRecovery,
  listProtectedAbandonmentWorktreePaths,
  listContractsAwaitingIndependentReview,
  listContractsLandedTeardownIncomplete,
  listContractsPendingLanding,
  listContractsSealedUnverified,
  setContractDeliverable,
  setContractLanding,
  reserveContractLanding,
  settleContractLanding,
  authorizeContractAbandonment,
  applyReviewVerdictToContractInDb,
  setContractAbandonmentError,
  settleContractAbandonment,
  setContractReviewState,
  reserveContractReview,
  clearContractReviewReservation,
  setContractRunRecoveryVerification,
  setContractRun,
  setContractVerification,
} from './repos/contracts.ts';
export type {
  ApplyReviewVerdictToContractInput,
} from './repos/contracts.ts';
export type {
  ContractRow,
  AuthorizeContractAbandonmentInput,
  CreateContractInput,
  ReserveContractLandingInput,
  SetContractAbandonmentErrorInput,
  SetDeliverableInput,
  SetLandingInput,
  SettleContractAbandonmentInput,
  SettleContractLandingInput,
  ReserveContractReviewInput,
  SetRunRecoveryVerificationInput,
  SetReviewStateInput,
  SetVerificationInput,
} from './repos/contracts.ts';

export {
  createReviewCheckoutReservation,
  applyReviewCheckoutVerdictEvidenceInDb,
  getCurrentReviewCheckoutForContract,
  getReviewCheckoutById,
  getReviewCheckoutForReviewer,
  getActiveWorktreeByName,
  getWorktreeById,
  getWorktreeForContract,
  getWorktreeForLandedContract,
  hasStrandedWorktreeForAgentRun,
  listActiveWorktrees,
  listReviewCheckoutBlockingCandidates,
  listReviewCheckoutsNeedingRecovery,
  listStrandedWorktrees,
  markWorktreeDestroyed,
  markReviewCheckoutTeardownPending,
  markExactWorktreeDestroyed,
  markExactWorktreeSnapshotDestroyed,
  markExactUnpublishedWorktreeDestroyed,
  markWorktreeStranded,
  reviveStrandedWorktree,
  setReviewCheckoutCleanupError,
  setReviewCheckoutPhaseReceiptInDb,
  setReviewCheckoutVerdictReceipt,
  setReviewCheckoutProvisionReceipt,
  setWorktreeContractId,
  settleReviewCheckoutTeardown,
  upsertWorktree,
} from './repos/worktrees.ts';
export type {
  CreateReviewCheckoutReservationInput,
  ApplyReviewCheckoutVerdictEvidenceInput,
  MarkExactWorktreeDestroyedInput,
  MarkExactWorktreeSnapshotDestroyedInput,
  MarkExactUnpublishedWorktreeDestroyedInput,
  MarkReviewCheckoutTeardownPendingInput,
  ReviewCheckoutMutationInput,
  ReviewCheckoutRow,
  SetReviewCheckoutCleanupErrorInput,
  SetReviewCheckoutPhaseReceiptInput,
  SetReviewCheckoutProvisionReceiptInput,
  SettleReviewCheckoutTeardownInput,
  UpsertWorktreeInput,
  WorktreeRow,
} from './repos/worktrees.ts';

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
  closeOpenConversationToolCalls,
  closeOpenConversationToolCallsInDb,
  commitConversationEvent,
  commitConversationEventInDb,
  countConversationEvents,
  getConversationHighWaterSequence,
  hasConversationContextObservation,
  hasConversationEvents,
  listConversationEvents,
  listConversationEventsRaw,
  listUnrelayedConversationEvents,
  markConversationEventsRelayed,
} from './repos/conversation-events.ts';
export type {
  CloseOpenConversationToolCallsInput,
  CommitConversationEventInput,
  CommitConversationEventResult,
  ConversationDeliveryKind,
  ConversationEventRow,
  ConversationOutboxEntry,
} from './repos/conversation-events.ts';

export {
  cancelQueuedConversationSends,
  cancelLegacyUnavailableSessionQueues,
  claimNextConversationTurn,
  continueOrchestratorSessionAcrossSelection,
  editQueuedConversationSend,
  enqueueConversationSend,
  failConversationInterrupt,
  getActiveConversationTurn,
  getConversationQueueSnapshot,
  getTurnInterruptRequest,
  handoffOrchestratorSession,
  listProjectsWithQueuedConversationSends,
  recoverActiveConversationTurns,
  replaceOrchestratorSession,
  resumeOrchestratorSessionTransition,
  removeQueuedConversationSend,
  requestConversationInterrupt,
  settleConversationTurn,
  softDeleteProjectConversationState,
} from './repos/conversation-queue.ts';
export type {
  ClaimedConversationTurn,
  ContinueOrchestratorSessionAcrossSelectionInput,
  ConversationCommandResult,
  ConversationQueueItemRow,
  ConversationQueueRevisionRow,
  ConversationTurnRow,
  EditQueuedConversationSendInput,
  EnqueueConversationSendInput,
  HandoffOrchestratorSessionInput,
  RemoveQueuedConversationSendInput,
  ReplaceOrchestratorSessionInput,
  ReplaceOrchestratorSessionResult,
  ResumeOrchestratorSessionInput,
  RequestConversationInterruptInput,
  SettleConversationTurnInput,
  SoftDeleteProjectConversationResult,
  TurnInterruptRequestRow,
} from './repos/conversation-queue.ts';

export {
  createPendingAsk,
  getPendingAsk,
  hasOpenPendingAskForRun,
  hasPendingAskForRun,
  listOpenPendingAsksForProject,
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
  countAgentRunsForSessionAndPod,
  dismissAgentRun,
  findActiveContinuation,
  getAgentRunRow,
  hasContinuation,
  insertAgentRunRow,
  listActiveAgentRunsForProject,
  listAgentRunsForContract,
  listAgentRunsForSession,
  listNonTerminalAgentRuns,
  listPreservedTerminalAgentRuns,
  listRecentTerminalAgentRuns,
  listTurnBudgetExhaustedRuns,
  markAgentRunDelivered,
  markAgentRunTerminal,
  confirmAgentRunRuntimeSessionReceipt,
  failAgentRunRuntimeResume,
  failAgentRunRuntimeResumeInDb,
  isAgentRunNativeResumeReady,
  prepareAgentRunCreate,
  prepareAgentRunResume,
  prepareAgentRunResumeInDb,
  runtimeSelectionForAgentRun,
  specialistSnapshotForAgentRun,
  setAgentRunFailureReason,
  setAgentRunPhaseReceipt,
  setAgentRunPhaseReceiptInDb,
  setReviewAgentRunPhaseReceiptInDb,
  touchAgentRunActivity,
  transitionAgentRunLifecycleInDb,
  validateReviewVerdictAgentRunFrameInDb,
  updateAgentRunPid,
  updateAgentRunStatus,
} from './repos/agent-runs.ts';
export type {
  TransitionAgentRunLifecycleInput,
  InsertAgentRunRowInput,
  ListAgentRunsForSessionOptions,
  MarkAgentRunTerminalInput,
  UpdateAgentRunStatusInput,
} from './repos/agent-runs.ts';

export {
  clearPendingHandoffSeed,
  confirmRuntimeSessionReceipt,
  createOrchestratorSession,
  endOrchestratorSession,
  failRuntimeSessionResume,
  getActiveOrchestratorSession,
  getOrchestratorSession,
  isOrchestratorSessionResumeReady,
  listOrchestratorSessionsForProject,
  prepareRuntimeSessionCreate,
  prepareRuntimeSessionResume,
  runtimeSelectionForSession,
  setOrchestratorSessionTitle,
} from './repos/orchestrator-sessions.ts';
export type {
  ConfirmRuntimeSessionReceiptInput,
  ConfirmRuntimeSessionReceiptResult,
  CreateOrchestratorSessionInput,
  OrchestratorSessionContinuationState,
  OrchestratorSessionEffortState,
  OrchestratorSessionNativeIdentityState,
  OrchestratorSessionRow,
  OrchestratorSessionSelectionState,
  RuntimeSessionReceiptRejection,
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
  setMcpServerHealth,
  softDeleteMcpServerRegistry,
} from './repos/mcp-servers.ts';
export type {
  CreateMcpServerRegistryInput,
  ListMcpServersRegistryOptions,
  PatchMcpServerRegistryInput,
  SetMcpServerDiscoveryInput,
  SetMcpServerHealthInput,
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

// MCP consumer attachments repo (N6 — explicit per-server attachment).
export {
  attachMcpConsumer,
  detachMcpConsumer,
  listMcpConsumersForServer,
  listMcpServerIdsForConsumer,
} from './repos/mcp-consumer-attachments.ts';
export type { AttachMcpConsumerInput } from './repos/mcp-consumer-attachments.ts';

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
