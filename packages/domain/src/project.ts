// Project domain type + per-project settings.

import { effectiveLandingPolicy, type ContractLandingPolicy, type ExpectedOutput } from './contract.ts';
import type { ULID } from './ulid.ts';
import type { RepositoryIdentityReceipt, WorktreeProfile } from './worktree.ts';

/** Section 27 — per-project setting overlay. Stored in the `projects.settings`
 *  JSON column; defaults fill in missing keys via `withProjectSettingsDefaults`. */
export interface ProjectSettings {
  /** Section 27 — per-project override on the global `hideCancelledStage`.
   *  `'use-global'` (default) inherits the resolved global value;
   *  `'force-visible'` always shows the cancelled column;
   *  `'force-hidden'` always hides it. */
  cancelledVisibility: 'use-global' | 'force-visible' | 'force-hidden';
  /** Per-project override on the global `remoteControlEnabled` default for new
   *  orchestrator sessions. `'use-global'` (default) inherits the global flag;
   *  `'on'` always launches sessions remote-ready; `'off'` never does. */
  remoteControl: 'use-global' | 'on' | 'off';
  /** The branch finished work is merged into (worktree merge target + the
   *  "is this run branch landed?" predicate for sweep/teardown). `null` =
   *  not yet resolved; the integration-branch resolver auto-detects once and
   *  persists the result here, making it visible + editable in settings. */
  integrationBranch: string | null;
  /** Phase 2 — the account (Claude Code config dir) new orchestrator sessions
   *  for this project launch under. `null` = use the server's default account
   *  ('personal'). Switching this mints a NEW session (sessions live per config
   *  dir). Value is an account id from the server's account registry. */
  defaultAccountId: string | null;
  /** WF-1 — the agent-runtime adapter (e.g. `claude-agent-sdk`, `openai-codex`)
   *  new orchestrator/specialist sessions for this project resolve against.
   *  `null` = use the server's default runtime. A runtime id here is opaque to
   *  this package; the composition root owns what ids exist. Switching this
   *  mints a NEW session (a runtime/account/model/effort change is always a
   *  session boundary — docs/agent-runtime-architecture.md). */
  defaultRuntimeId: string | null;
  /** WF-2 — per-project default gate for the dispatch lifecycle's Review
   *  phase (docs/master-plan.md "MCP manager — reliability requirements" /
   *  Phase 4). `'orchestrator-review'` (default) parks a verified pass
   *  merge-ready for the orchestrator's cheap accept; `'full-review'` always
   *  escalates to the independent review specialist. This is a PROJECT-WIDE
   *  fallback: an issuer-authored contract spec (`ExpectedOutput.review`)
   *  still wins when it demands `'full-review'` — see
   *  `resolveContractLandingPolicy`, which never lets this setting downgrade
   *  a stricter spec-derived policy. */
  reviewPolicy: 'orchestrator-review' | 'full-review';
  /** WF-2 — per-project opt-in that lets a verified repo contract land
   *  automatically instead of parking merge-ready, when the contract's own
   *  spec didn't already decide (issuer-authored `auto_land`/`review` always
   *  wins over this project default). Default false — auto-merge stays
   *  opt-in. Never applies when the effective policy is `'full-review'`
   *  (see `resolveContractLandingPolicy`). */
  autoMergeEligible: boolean;
}

/** Git ref-name shape for the integration branch. Unlike the runtime's
 *  generated run-branch guard, this allows `/` (e.g. `release/2026`). */
export const INTEGRATION_BRANCH_RE = /^[A-Za-z0-9][A-Za-z0-9._/-]*$/;

export function defaultProjectSettings(): ProjectSettings {
  return {
    cancelledVisibility: 'use-global',
    remoteControl: 'use-global',
    integrationBranch: null,
    defaultAccountId: null,
    defaultRuntimeId: null,
    reviewPolicy: 'orchestrator-review',
    autoMergeEligible: false,
  };
}

/** Backfill missing keys on a stored project-settings JSON blob. */
export function withProjectSettingsDefaults(
  stored: Partial<ProjectSettings> | undefined | null,
): ProjectSettings {
  const defaults = defaultProjectSettings();
  if (!stored) return defaults;
  const v = stored.cancelledVisibility;
  const rc = stored.remoteControl;
  const ib = typeof stored.integrationBranch === 'string' ? stored.integrationBranch.trim() : null;
  const acct = typeof stored.defaultAccountId === 'string' ? stored.defaultAccountId.trim() : null;
  const rt = typeof stored.defaultRuntimeId === 'string' ? stored.defaultRuntimeId.trim() : null;
  const rp = stored.reviewPolicy;
  const ame = stored.autoMergeEligible;
  return {
    cancelledVisibility:
      v === 'force-visible' || v === 'force-hidden' || v === 'use-global'
        ? v
        : defaults.cancelledVisibility,
    remoteControl:
      rc === 'on' || rc === 'off' || rc === 'use-global' ? rc : defaults.remoteControl,
    integrationBranch: ib && INTEGRATION_BRANCH_RE.test(ib) ? ib : null,
    defaultAccountId: acct && acct.length > 0 ? acct : null,
    defaultRuntimeId: rt && rt.length > 0 ? rt : null,
    reviewPolicy: rp === 'orchestrator-review' || rp === 'full-review' ? rp : defaults.reviewPolicy,
    autoMergeEligible: typeof ame === 'boolean' ? ame : defaults.autoMergeEligible,
  };
}

/** Section 27 — resolve the visibility of a project's cancelled-stage from
 *  the per-project override + the global flag. Returns true when the
 *  cancelled column should be hidden from the default kanban / table view.
 *  Cards in the cancelled stage are still reachable via direct links. */
export function resolveCancelledHidden(
  projectSettings: Partial<ProjectSettings> | undefined,
  globalHide: boolean,
): boolean {
  const resolved = withProjectSettingsDefaults(projectSettings).cancelledVisibility;
  if (resolved === 'force-visible') return false;
  if (resolved === 'force-hidden') return true;
  return globalHide;
}

/** Resolve whether a project's NEW orchestrator sessions should launch
 *  remote-ready, from the per-project override + the global default.
 *  `'on'`/`'off'` win; `'use-global'` falls back to the global flag. */
export function resolveRemoteControlEnabled(
  projectSettings: Partial<ProjectSettings> | undefined,
  globalEnabled: boolean,
): boolean {
  const resolved = withProjectSettingsDefaults(projectSettings).remoteControl;
  if (resolved === 'on') return true;
  if (resolved === 'off') return false;
  return globalEnabled;
}

/** Result of resolving a repo contract's landing policy against the
 *  per-project lifecycle-policy settings (WF-2). `guardOverride` is set
 *  (non-null) exactly when a project setting was IGNORED because a
 *  stricter, contract/spec-derived invariant already applies — the caller
 *  logs it; the guard silently winning would hide the override. */
export interface ResolvedContractLandingPolicy {
  policy: ContractLandingPolicy;
  guardOverride: string | null;
}

/** docs/master-plan.md "MCP manager — reliability requirements" / Phase 4 —
 *  per-project `reviewPolicy`/`autoMergeEligible` fill in ONLY where the
 *  contract's own spec left the decision open (NULL landingPolicy). An
 *  issuer-authored spec (`ExpectedOutput.review === 'full'` or
 *  `auto_land === true`) is never downgraded or silently relaxed by a
 *  project default; `full-review`, once reached from either source, always
 *  wins over `autoMergeEligible`. */
export function resolveContractLandingPolicy(
  projectSettings: Partial<ProjectSettings> | undefined,
  spec: ExpectedOutput | null | undefined,
): ResolvedContractLandingPolicy {
  // Landing policy only means anything for repo-kind contracts — a
  // non-repo spec has no worktree/branch for the project's review/auto-merge
  // defaults to act on, so it always parks 'default-review' untouched.
  if (spec?.kind !== 'repo') return { policy: 'default-review', guardOverride: null };
  const settings = withProjectSettingsDefaults(projectSettings);
  const specPolicy = effectiveLandingPolicy(null, spec);
  if (specPolicy === 'full-review') {
    return {
      policy: 'full-review',
      guardOverride: settings.autoMergeEligible
        ? 'autoMergeEligible ignored — the contract spec requires full-review (guard wins, never downgraded)'
        : null,
    };
  }
  if (settings.reviewPolicy === 'full-review') {
    return { policy: 'full-review', guardOverride: null };
  }
  if (settings.autoMergeEligible) {
    return { policy: 'auto-merge', guardOverride: null };
  }
  return { policy: specPolicy, guardOverride: null };
}

export interface Project {
  id: ULID;
  /** URL-safe routing key. Derived from name + uniqued at create; locked thereafter
   *  (rename → slug migration is a deferred followup). Drives worktree paths, channel
   *  routes, and per-project filesystem layout. */
  slug: string;
  name: string;
  /** Absolute path to the user's project folder. Git-backed. */
  folderPath: string;
  /** Immutable canonical repository identity bound by the first guarded fresh
   * runtime. Null is retained only for pre-SF-002 projects that have not yet
   * started a new session; native resume never infers a missing receipt. */
  repositoryIdentity: RepositoryIdentityReceipt | null;
  /** Optional origin URL; null = local-only repo. Editable in project settings. */
  gitRemote: string | null;
  /** Section 27 — typed per-project overlay. Persisted in the
   *  `projects.settings` JSON column; defaults fill in missing keys. */
  settings: ProjectSettings;
  /** Section 35 — monotonic, never-reused counter for top-level callsign
   *  numbering. Highest assigned root number. Surfaced for forensic /
   *  debug use; UI doesn't read it directly. */
  callsignSeq: number;
  /** pc-pty-chat-333 — per-project scratch notes. Null when none saved yet. */
  notes: string | null;
  /** Command focus — epoch-ms the planner starred this project; null = not in
   *  focus. Drives the gold star in the LeftRail. */
  focusedAt: number | null;
  /** Worktree provisioning profile (docs/worktree-lifecycle.md). Stored raw in
   *  `projects.worktree_profile`; readers validate via parseWorktreeProfile.
   *  Null = no profile — exactly the profile-less provisioning behavior. */
  worktreeProfile: WorktreeProfile | null;
}
