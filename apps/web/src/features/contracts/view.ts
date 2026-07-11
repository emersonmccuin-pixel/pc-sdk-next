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
      c.landingStatus === 'stale-base',
  );
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
