// Worktree-pipeline lifecycle vocabulary (docs/worktree-lifecycle.md
// 'Lifecycle states'). Layered BESIDE the 7-value dispatch AgentRunStatus —
// that union stays authoritative for what it already does; `lifecycleState`
// is the richer durable pipeline state. NULL on the row = legacy/non-repo run.
//
// Pure data + a predicate. Enforcement lives in the @pc/db gateway functions
// (updateAgentRunStatus / markAgentRunTerminal reject illegal transitions).

export const RUN_LIFECYCLE_STATES = [
  'queued',
  'provisioning',
  'preparing',
  'ready',
  'planning',
  'building',
  'verifying',
  'reviewing',
  'fixing',
  'merge-ready',
  'merging',
  'merged',
  'tearing-down',
  'completed',
  'provisioning-failed',
  'verification-failed',
  'review-rejected',
  'conflict',
  'failed',
  'cancelled',
  'stranded',
] as const;

export type RunLifecycleState = (typeof RUN_LIFECYCLE_STATES)[number];

/** States whose runs stay VISIBLE until resolved (doc 'Teardown and
 *  retention'): parked merge-ready work, conflicted/failed landings, review
 *  rejections, stranded worktrees. Run-list retention keys off this — the
 *  recent-terminal window applies only to uneventful runs. */
export const PRESERVED_LIFECYCLE_STATES = [
  'merge-ready',
  'conflict',
  'stranded',
  'review-rejected',
  'failed',
] as const satisfies readonly RunLifecycleState[];

/** Any live pipeline state may fail, be cancelled, or strand. All three
 *  preserve the branch + worktree (doc: unknown/uncertain never tears down). */
const SINK = ['failed', 'cancelled', 'stranded'] as const;

/** Legal moves. Invariants encoded here (guard-tested):
 *  - `tearing-down` is reached only from `merged` (the normal reclaim) and
 *    `stranded` (a boot teardown RETRY of a landed contract's stuck reclaim);
 *    uncertain state never tears down.
 *  - `review-rejected` → `fixing` is legal (not necessarily terminal).
 *  - `verifying`/`merge-ready`/`conflict` → `merged` covers probe convergence
 *    (positive ancestry proof of a merge a crashed drive already made).
 *  - a NULL/empty WorktreeProfile has no prepare/readiness phase —
 *    `provisioning` keeps skip edges straight to `ready`/`planning`/`building`.
 *  - Resolution doors (doc 'Teardown and retention' — preserved states stay
 *    visible UNTIL RESOLVED, so each needs an exit): preserved parks
 *    (`merge-ready`/`conflict`/`review-rejected`/`failed`/`stranded`) →
 *    `completed` marks the park resolved once the contract positively landed
 *    and its worktree was reclaimed (possibly via a later run of the same
 *    contract); `failed` → `merging` is the pc_review_contract re-accept
 *    re-drive after a mechanical landing failure. Without these, preserved
 *    terminal rows would sit in the run feed forever. */
export const ALLOWED_LIFECYCLE_TRANSITIONS: Readonly<
  Record<RunLifecycleState, readonly RunLifecycleState[]>
> = {
  queued: ['provisioning', ...SINK],
  provisioning: ['preparing', 'ready', 'planning', 'building', 'provisioning-failed', ...SINK],
  preparing: ['ready', 'provisioning-failed', ...SINK],
  ready: ['planning', 'building', ...SINK],
  planning: ['building', ...SINK],
  building: ['verifying', ...SINK],
  verifying: ['reviewing', 'merge-ready', 'merging', 'merged', 'verification-failed', 'review-rejected', 'conflict', ...SINK],
  reviewing: ['merge-ready', 'review-rejected', 'fixing', ...SINK],
  fixing: ['verifying', ...SINK],
  'merge-ready': ['merging', 'merged', 'reviewing', 'review-rejected', 'conflict', 'completed', ...SINK],
  merging: ['merged', 'conflict', 'failed', 'stranded'],
  merged: ['tearing-down', 'completed', 'stranded'],
  'tearing-down': ['completed', 'failed', 'stranded'],
  completed: [],
  'provisioning-failed': [],
  // Recovery doors: Fix mutates again; orchestrator accept re-lands.
  'verification-failed': ['fixing', 'merging', 'cancelled', 'stranded'],
  'review-rejected': ['fixing', 'merging', 'completed', 'cancelled', 'stranded'],
  conflict: ['fixing', 'merging', 'merged', 'completed', 'cancelled', 'stranded'],
  failed: ['merging', 'completed'],
  cancelled: [],
  stranded: ['tearing-down', 'completed'],
};

/** `from === null` (legacy/non-repo adoption) and `from === to` (idempotent
 *  re-stamp) are always legal; everything else reads the map. */
export function canTransition(from: RunLifecycleState | null, to: RunLifecycleState): boolean {
  if (from === null || from === to) return true;
  return ALLOWED_LIFECYCLE_TRANSITIONS[from].includes(to);
}

export function isRunLifecycleState(value: unknown): value is RunLifecycleState {
  return typeof value === 'string' && (RUN_LIFECYCLE_STATES as readonly string[]).includes(value);
}

/** Typed rejection thrown by the @pc/db gateway functions. */
export class IllegalLifecycleTransitionError extends Error {
  readonly runId: string;
  readonly from: RunLifecycleState | null;
  readonly to: RunLifecycleState;

  constructor(runId: string, from: RunLifecycleState | null, to: RunLifecycleState) {
    super(`illegal lifecycle transition '${from}' → '${to}' for run ${runId}`);
    this.name = 'IllegalLifecycleTransitionError';
    this.runId = runId;
    this.from = from;
    this.to = to;
  }
}
