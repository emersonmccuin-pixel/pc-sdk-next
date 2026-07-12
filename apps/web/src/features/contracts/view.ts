// Pure contract-view logic — no '@/' imports so the guard tests run under
// `tsx --test`. The hook (use-project-contracts.ts) and ActivityPanel consume
// these; keeping them pure keeps the sections testable without React.

import {
  isContractChangedLivePayload,
  type Contract,
  type ResourceEvent,
} from '@pc/contracts';

/** Overlay live `contract` frames onto the HTTP seed. Higher (or equal)
 *  version wins — a stale live frame never regresses a fresher seed row.
 *  Newest-first by createdAt. */
export function overlayContracts(
  seeded: readonly Contract[],
  liveEvents: readonly ResourceEvent[],
): Contract[] {
  const map = new Map(seeded.map((c) => [c.id, c]));
  for (const ev of liveEvents) {
    if (!isContractChangedLivePayload(ev.payload)) continue;
    const { contract } = ev.payload;
    const prev = map.get(contract.id);
    if (!prev || contract.version >= prev.version) map.set(contract.id, contract);
  }
  return [...map.values()].sort((a, b) => b.createdAt - a.createdAt);
}

/** Repo contracts parked merge-ready: verification passed, not yet landed —
 *  awaiting orchestrator review. `verificationNotes` carries WHY (auto-land
 *  refusal blockers, default-review park). A full-review contract with an
 *  independent review IN FLIGHT (reviewRunId set) is not awaiting the
 *  orchestrator — it leaves the section until the verdict lands or parks. */
export function mergeReadyContracts(contracts: readonly Contract[]): Contract[] {
  return contracts.filter(
    (c) =>
      c.expectedOutput?.kind === 'repo' &&
      c.verificationStatus === 'passed' &&
      (c.landingStatus === null || c.landingStatus === 'pending') &&
      c.reviewRunId === null,
  );
}

/** Conflicted / failed / stale-base landings — preserved until resolved. */
export function landingIssueContracts(contracts: readonly Contract[]): Contract[] {
  return contracts.filter(
    (c) =>
      c.landingStatus === 'conflict' ||
      c.landingStatus === 'failed' ||
      c.landingStatus === 'stale-base' ||
      c.landingStatus === 'abandoning' ||
      isLegacyAbandonment(c),
  );
}

/** A legacy `abandoned` value has no positive user-authority or teardown
 * receipt. It remains visible and non-destructive; absence never becomes an
 * approval merely because an old status string exists. */
export function isLegacyAbandonment(contract: Contract): boolean {
  return contract.landingStatus === 'abandoned' &&
    contract.abandonmentReceipt === null &&
    contract.abandonmentTeardownReceipt === null;
}

export function isSettledAbandonment(contract: Contract): boolean {
  return contract.landingStatus === 'abandoned' &&
    contract.abandonmentReceipt !== null &&
    contract.abandonmentTeardownReceipt !== null;
}

/** Cheap presentation predicate only. The server re-derives eligibility,
 * repository identity, branch tip, integration, and worktree state. */
export function canRequestAbandonment(contract: Contract): boolean {
  return contract.expectedOutput?.kind === 'repo' &&
    contract.worktreePath !== null &&
    (
      contract.landingStatus === null ||
      contract.landingStatus === 'conflict' ||
      contract.landingStatus === 'failed' ||
      contract.landingStatus === 'stale-base' ||
      isLegacyAbandonment(contract)
    );
}

export function landingIssueLabel(contract: Contract): string {
  if (contract.landingStatus === 'abandoning') return 'cleanup pending';
  if (isLegacyAbandonment(contract)) return 'authority unavailable';
  return contract.landingStatus ?? 'unknown';
}

export function landingIssueDetail(contract: Contract): string | null {
  if (contract.landingStatus === 'abandoning') {
    return contract.abandonmentError ?? 'User approval recorded; worktree cleanup is pending.';
  }
  if (isLegacyAbandonment(contract)) {
    return 'Legacy abandonment has no approval receipt; automatic cleanup is not authorized.';
  }
  return contract.landingError;
}

/** `landingPolicy` with the legacy-NULL fallback (mirror of @pc/domain
 *  effectiveLandingPolicy — spec review 'full' ⇒ full-review, wins over
 *  auto_land ⇒ auto-merge). */
export function effectivePolicy(c: Contract): NonNullable<Contract['landingPolicy']> {
  if (c.landingPolicy) return c.landingPolicy;
  if (c.expectedOutput?.kind !== 'repo') return 'default-review';
  if (c.expectedOutput.review === 'full') return 'full-review';
  return c.expectedOutput.auto_land === true ? 'auto-merge' : 'default-review';
}
