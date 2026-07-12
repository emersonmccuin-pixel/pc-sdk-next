// Contract service (slice 013) — the durable write door for agent contracts.
//
// Mirrors the AreaService: each mutation runs the repo write +
// `insertLiveEvent(tx, draft)` a `contract.changed` row in the SAME transaction.
// The live-relay drains the committed row and fans the canonical frame by scope
// ('project') — fully automatic. No broadcast / fanout here.
//
// Boundary purity: imports only @pc/contracts, @pc/db, @pc/domain.

import type {
  Contract,
  ContractChangedLivePayload,
  ContractMutationReason,
  Deliverable,
  ExpectedOutput as ContractExpectedOutput,
  ULID,
  VerificationStatus,
  VerificationTier,
} from '@pc/contracts';
import { isContract } from '@pc/contracts';
import {
  authorizeContractAbandonment as authorizeContractAbandonmentInDb,
  createContractInDb,
  getContractInDb,
  getDb,
  insertLiveEvent,
  listContractsForProjectInDb,
  listContractsForRunInDb,
  reserveContractReview as reserveContractReviewInDb,
  reserveContractLanding as reserveContractLandingInDb,
  clearContractReviewReservation as clearContractReviewReservationInDb,
  setContractDeliverable as setContractDeliverableInDb,
  setContractLanding as setContractLandingInDb,
  setContractAbandonmentError as setContractAbandonmentErrorInDb,
  settleContractAbandonment as settleContractAbandonmentInDb,
  settleContractLanding as settleContractLandingInDb,
  setContractReviewState as setContractReviewStateInDb,
  setContractRunRecoveryVerification as setContractRunRecoveryVerificationInDb,
  setContractRun as setContractRunInDb,
  setContractVerification as setContractVerificationInDb,
  type ContractRow,
  type DbExecutor,
  type InsertLiveEventDraft,
  type SetLandingInput,
  type ReserveContractLandingInput,
  type SetContractAbandonmentErrorInput,
  type SettleContractAbandonmentInput,
  type SettleContractLandingInput,
  type SetReviewStateInput,
} from '@pc/db';
import type {
  AcceptanceCriteria,
  ContractV2,
  ULID as DomainULID,
  WorktreeAbandonmentReceipt,
} from '@pc/domain';

export function toContractDto(row: ContractRow): Contract {
  const contract: Contract = {
    id: row.id,
    projectId: row.projectId,
    pmRef: row.pmRef ?? null,
    agentRunId: row.agentRunId,
    podName: row.podName,
    // The repo persists the v2 union; the DTO mirror is structurally identical.
    expectedOutput: (row.expectedOutput as ContractExpectedOutput | null) ?? null,
    acceptanceCriteria: (row.acceptanceCriteria as Contract['acceptanceCriteria']) ?? null,
    verificationTier: row.verificationTier,
    verificationStatus: row.verificationStatus,
    verificationNotes: row.verificationNotes,
    report: row.report,
    deliverable: row.deliverable,
    worktreePath: row.worktreePath,
    worktreeBaseBranch: row.worktreeBaseBranch,
    worktreeBaseSha: row.worktreeBaseSha,
    landingStatus: row.landingStatus,
    landedBranch: row.landedBranch,
    landedSha: row.landedSha,
    landingError: row.landingError,
    landedAt: row.landedAt,
    targetShaBefore: row.targetShaBefore,
    targetShaAfter: row.targetShaAfter,
    mergeSha: row.mergeSha,
    landingAuthorizer: row.landingAuthorizer,
    verifiedBaseSha: row.verifiedBaseSha,
    landingPolicy: row.landingPolicy,
    reviewRound: row.reviewRound,
    reviewRunId: row.reviewRunId,
    reviewSealedCommit: row.reviewSealedCommit,
    abandonmentReceipt: row.abandonmentReceipt,
    abandonmentTeardownReceipt: row.abandonmentTeardownReceipt,
    abandonmentError: row.abandonmentError,
    status: row.status,
    version: row.version,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
  if (!isContract(contract)) {
    throw new Error(`invalid contract row: unsafe or inconsistent projection (${row.id})`);
  }
  return contract;
}

/** Build the canonical `contract.changed` outbox draft. Project-scoped; carries
 *  the full contract DTO + its version. */
export function buildContractChangedDraft(input: {
  reason: ContractMutationReason;
  contract: Contract;
}): InsertLiveEventDraft<ContractChangedLivePayload> {
  return {
    scope: 'project',
    projectId: input.contract.projectId as DomainULID,
    type: 'contract.changed',
    entity: 'contract',
    entityId: input.contract.id as DomainULID,
    version: input.contract.version,
    payload: { reason: input.reason, contract: input.contract },
  };
}

export interface ContractServiceDeps {
  transaction?: <T>(fn: (tx: DbExecutor) => T) => T;
  insertLiveEvent?: typeof insertLiveEvent;
}

export interface CreateContractServiceInput {
  projectId: ULID;
  /** External PM-item ref (AInativePM over MCP), or null. Replaces the dead
   *  internal work-item FK. */
  pmRef?: string | null;
  agentRunId?: ULID | null;
  podName?: string | null;
  expectedOutput?: ContractV2.ExpectedOutput | null;
  acceptanceCriteria?: AcceptanceCriteria | null;
  verificationTier?: VerificationTier | null;
  worktreePath?: string | null;
  worktreeBaseBranch?: string | null;
  worktreeBaseSha?: string | null;
  /** Stamped at creation from the repo spec's auto_land. Null = legacy. */
  landingPolicy?: Contract['landingPolicy'];
}

export class ContractService {
  private readonly tx: <T>(fn: (tx: DbExecutor) => T) => T;
  private readonly insert: typeof insertLiveEvent;

  constructor(deps: ContractServiceDeps = {}) {
    this.tx = deps.transaction ?? ((fn) => getDb().transaction(fn));
    this.insert = deps.insertLiveEvent ?? insertLiveEvent;
  }

  /** Read-only point fetch. No event. */
  get(id: ULID): Contract | null {
    const row = getContractInDb(getDb(), id as DomainULID);
    return row ? toContractDto(row) : null;
  }

  /** Read-only — contracts produced by one run (newest-first). No event. */
  listByRun(agentRunId: ULID): Contract[] {
    return listContractsForRunInDb(getDb(), agentRunId as DomainULID).map(toContractDto);
  }

  /** Read-only — every contract in a project (newest-first). No event. */
  listByProject(projectId: ULID): Contract[] {
    return listContractsForProjectInDb(getDb(), projectId as DomainULID).map(toContractDto);
  }

  create(input: CreateContractServiceInput): Contract {
    return this.tx((tx) => {
      const row = createContractInDb(tx, {
        projectId: input.projectId as DomainULID,
        pmRef: input.pmRef ?? null,
        agentRunId: (input.agentRunId ?? null) as DomainULID | null,
        ...(input.podName !== undefined ? { podName: input.podName } : {}),
        ...(input.expectedOutput !== undefined ? { expectedOutput: input.expectedOutput } : {}),
        ...(input.acceptanceCriteria !== undefined
          ? { acceptanceCriteria: input.acceptanceCriteria }
          : {}),
        ...(input.verificationTier !== undefined
          ? { verificationTier: input.verificationTier }
          : {}),
        ...(input.worktreePath !== undefined ? { worktreePath: input.worktreePath } : {}),
        ...(input.worktreeBaseBranch !== undefined
          ? { worktreeBaseBranch: input.worktreeBaseBranch }
          : {}),
        ...(input.worktreeBaseSha !== undefined ? { worktreeBaseSha: input.worktreeBaseSha } : {}),
        ...(input.landingPolicy !== undefined ? { landingPolicy: input.landingPolicy } : {}),
      });
      const contract = toContractDto(row);
      this.insert(tx, buildContractChangedDraft({ reason: 'created', contract }));
      return contract;
    });
  }

  /** Point the contract at its producing run + flip to `dispatched`. Returns
   *  null when the contract is gone. */
  setRun(id: ULID, agentRunId: ULID): Contract | null {
    return this.tx((tx) => {
      const row = setContractRunInDb(id as DomainULID, agentRunId as DomainULID, tx);
      if (!row) return null;
      const contract = toContractDto(row);
      this.insert(tx, buildContractChangedDraft({ reason: 'dispatched', contract }));
      return contract;
    });
  }

  /** Write the captured deliverable (+ optional report) onto the contract. */
  setDeliverable(input: {
    id: ULID;
    deliverable: Deliverable | null;
    report?: string | null;
  }): Contract | null {
    return this.tx((tx) => {
      const row = setContractDeliverableInDb(
        input.id as DomainULID,
        {
          deliverable: input.deliverable,
          ...(input.report !== undefined ? { report: input.report } : {}),
        },
        tx,
      );
      if (!row) return null;
      const contract = toContractDto(row);
      this.insert(tx, buildContractChangedDraft({ reason: 'deliverable-set', contract }));
      return contract;
    });
  }

  /** pc-pty-chat-415 (R5) — record the landing state/receipts onto the
   *  contract (accept ⇒ land). */
  setLanding(input: { id: ULID } & SetLandingInput): Contract | null {
    return this.tx((tx) => {
      const { id, ...fields } = input;
      const row = setContractLandingInDb(id as DomainULID, fields, tx);
      if (!row) return null;
      const contract = toContractDto(row);
      this.insert(tx, buildContractChangedDraft({ reason: 'landing-set', contract }));
      return contract;
    });
  }

  /** Exact pre-mutation landing reservation. */
  reserveLanding(input: { id: ULID } & ReserveContractLandingInput): Contract | null {
    return this.tx((tx) => {
      const { id, ...fields } = input;
      const row = reserveContractLandingInDb(id as DomainULID, {
        ...fields,
        expectedAgentRunId: fields.expectedAgentRunId as DomainULID,
      }, tx);
      if (!row) return null;
      const contract = toContractDto(row);
      this.insert(tx, buildContractChangedDraft({ reason: 'landing-set', contract }));
      return contract;
    });
  }

  /** Exact pending-reservation settlement. */
  settleLanding(input: { id: ULID } & SettleContractLandingInput): Contract | null {
    return this.tx((tx) => {
      const { id, ...fields } = input;
      const row = settleContractLandingInDb(id as DomainULID, {
        ...fields,
        expectedAgentRunId: fields.expectedAgentRunId as DomainULID,
      }, tx);
      if (!row) return null;
      const contract = toContractDto(row);
      this.insert(tx, buildContractChangedDraft({ reason: 'landing-set', contract }));
      return contract;
    });
  }

  /** Commit immutable browser-user authority and its outbox fact before any
   * filesystem teardown is allowed to begin. */
  authorizeAbandonment(input: { id: ULID; receipt: WorktreeAbandonmentReceipt }): Contract | null {
    return this.tx((tx) => {
      const row = authorizeContractAbandonmentInDb(
        input.id as DomainULID,
        { receipt: input.receipt },
        tx,
      );
      if (!row) return null;
      const contract = toContractDto(row);
      this.insert(tx, buildContractChangedDraft({ reason: 'abandonment-authorized', contract }));
      return contract;
    });
  }

  setAbandonmentError(input: { id: ULID } & SetContractAbandonmentErrorInput): Contract | null {
    return this.tx((tx) => {
      const { id, ...fields } = input;
      const row = setContractAbandonmentErrorInDb(id as DomainULID, fields, tx);
      if (!row) return null;
      const contract = toContractDto(row);
      this.insert(tx, buildContractChangedDraft({ reason: 'abandonment-error', contract }));
      return contract;
    });
  }

  settleAbandonment(input: { id: ULID } & SettleContractAbandonmentInput): Contract | null {
    return this.tx((tx) => {
      const { id, ...fields } = input;
      const row = settleContractAbandonmentInDb(id as DomainULID, fields, tx);
      if (!row) return null;
      const contract = toContractDto(row);
      this.insert(tx, buildContractChangedDraft({ reason: 'abandonment-settled', contract }));
      return contract;
    });
  }

  /** Full-review loop markers — round counter + in-flight review run
   *  (docs/worktree-lifecycle.md 'Full independent review'). */
  setReviewState(input: { id: ULID } & SetReviewStateInput): Contract | null {
    return this.tx((tx) => {
      const { id, ...fields } = input;
      const row = setContractReviewStateInDb(id as DomainULID, fields, tx);
      if (!row) return null;
      const contract = toContractDto(row);
      this.insert(tx, buildContractChangedDraft({ reason: 'patched', contract }));
      return contract;
    });
  }

  reserveReview(input: {
    id: ULID;
    expectedVersion: number;
    expectedReviewRunId: ULID | null;
    expectedAgentRunId: ULID | null;
    reviewRound: number;
    reviewRunId: ULID;
    reviewSealedCommit: string;
  }): Contract | null {
    return this.tx((tx) => {
      const row = reserveContractReviewInDb(
        input.id as DomainULID,
        {
          expectedVersion: input.expectedVersion,
          expectedReviewRunId: input.expectedReviewRunId as DomainULID | null,
          expectedAgentRunId: input.expectedAgentRunId as DomainULID | null,
          reviewRound: input.reviewRound,
          reviewRunId: input.reviewRunId as DomainULID,
          reviewSealedCommit: input.reviewSealedCommit,
        },
        tx,
      );
      if (!row) return null;
      const contract = toContractDto(row);
      this.insert(tx, buildContractChangedDraft({ reason: 'patched', contract }));
      return contract;
    });
  }

  clearReviewReservation(input: { id: ULID; reviewRunId: ULID }): Contract | null {
    return this.tx((tx) => {
      const row = clearContractReviewReservationInDb(
        input.id as DomainULID,
        input.reviewRunId as DomainULID,
        tx,
      );
      if (!row) return null;
      const contract = toContractDto(row);
      this.insert(tx, buildContractChangedDraft({ reason: 'patched', contract }));
      return contract;
    });
  }

  /** Record the verification outcome onto the contract. */
  setVerification(input: {
    id: ULID;
    verificationStatus: VerificationStatus;
    verificationNotes?: string | null;
    verificationTier?: VerificationTier;
    /** Target tip this verification covered — orchestrator accept revalidates
     *  against the CURRENT tip (stale-base recovery, worktree-lifecycle g7). */
    verifiedBaseSha?: string | null;
  }): Contract | null {
    return this.tx((tx) => {
      const row = setContractVerificationInDb(
        input.id as DomainULID,
        {
          verificationStatus: input.verificationStatus,
          ...(input.verificationNotes !== undefined
            ? { verificationNotes: input.verificationNotes }
            : {}),
          ...(input.verificationTier !== undefined
            ? { verificationTier: input.verificationTier }
            : {}),
          ...(input.verifiedBaseSha !== undefined
            ? { verifiedBaseSha: input.verifiedBaseSha }
            : {}),
        },
        tx,
      );
      if (!row) return null;
      const contract = toContractDto(row);
      this.insert(tx, buildContractChangedDraft({ reason: 'verification-set', contract }));
      return contract;
    });
  }

  /** Boot-only verification park, fenced to the exact producer/project and
   * contract version. The issued+unbound exception covers only the durable
   * create-contract -> insert-run -> bind-contract crash window. */
  setRunRecoveryVerification(input: {
    id: ULID;
    expectedVersion: number;
    projectId: ULID;
    producerRunId: ULID;
    verificationNotes: string;
    allowIssuedUnbound: boolean;
  }): Contract | null {
    return this.tx((tx) => {
      const row = setContractRunRecoveryVerificationInDb(
        input.id as DomainULID,
        {
          expectedVersion: input.expectedVersion,
          projectId: input.projectId as DomainULID,
          producerRunId: input.producerRunId as DomainULID,
          verificationNotes: input.verificationNotes,
          allowIssuedUnbound: input.allowIssuedUnbound,
        },
        tx,
      );
      if (!row) return null;
      const contract = toContractDto(row);
      this.insert(tx, buildContractChangedDraft({ reason: 'verification-set', contract }));
      return contract;
    });
  }
}
