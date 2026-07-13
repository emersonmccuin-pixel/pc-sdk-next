# Git worktree lifecycle

Status: **locked architecture with implemented v1 lifecycle** (updated
2026-07-12). Isolation, readiness, sealed delivery, verification/review,
guarded landing, teardown, and recovery have live evidence. SF-002 implements
cooperative same-host repository exclusion and is sealed, guarded-landed,
post-merge verified, pushed, and cleaned up.

## Decision

Every agent-produced repository change happens in a Git worktree. This includes
code, documentation, configuration, migrations, generated files, and any other
tracked mutation. No write-capable agent runs in the user's main working copy.

Worktree isolation is mandatory. Planning depth, review depth, and merge
authority are contract policies chosen per run. Parallel building is allowed;
landing into a repository is serialized and guarded.

The product lifecycle is:

```text
Plan → Build → Review → Fix ↺ Review → Merge → Teardown
```

Internally, PC-SDK must provision and prove readiness before any agent phase:

```text
Contract draft → Provision → Prepare → Readiness
               → Plan? → Build → Verify → Review? → Fix? ↺
               → Merge → Teardown
```

Question marks mean policy-controlled phases, not optional isolation. If a
planning or reviewing specialist is used, it operates against the run's
worktree. The orchestrator may inspect the main project read-only and author a
contract there; it never mutates the main working copy.

## Ownership unit

One pipeline/run owns one worktree and one feature branch for its lifetime.
Sequential Plan, Build, Review, and Fix specialists share that run identity and
workspace. Review examines a sealed build/fix checkpoint rather than a moving
working tree.

Each run durably records at least:

- project/repository id;
- worktree path and feature branch;
- target base branch and starting base SHA;
- runtime/account/model selection for each agent phase;
- contract id, declared file scope, and verification policy;
- current lifecycle state and transition timestamps;
- canonical repository identity/lease receipt and active phase owner;
- sealed deliverable commit SHA;
- verification and review receipts;
- landing policy, landing receipt, and cleanup state.

The DB is authoritative for intended lifecycle state. Git and filesystem state
are positively reconciled against it on boot.

## Engine-wide repository authority

Before any configured Git-backed cwd is used by a write-capable runtime or
repository service, PC-SDK resolves the native real path of
`git rev-parse --path-format=absolute --git-common-dir`. The first action for
that identity acquires one process-wide, engine-lifetime, re-entrant lease made
of a protocol-stable kernel IPC witness and a zero-wait SQLite write
transaction in the Git common directory.

Main checkouts, subdirectories, filesystem aliases, and linked worktrees of one
repository converge on that identity. Distinct local repositories do not block
one another. The engine retains the lease until actual process exit; it is not
released when an individual run ends. Re-entry inside one engine permits
parallel isolated builders.

Project creation preserves the selected admission claim through the mutation
door. `init-empty` accepts only a currently empty non-Git directory;
`init-in-place` accepts only a currently nonempty non-Git directory; neither
may silently attach a repository that appeared after an earlier probe.
Initialization atomically claims the anticipated `.git` identity, retains a
bootstrap-pending crash marker, and creates one clean `Initial scaffold` or
`Initial import` commit before removing that marker. An incomplete marker is
uncertain state and never grants repair/takeover authority.

`attach-to-git` requires the selected path itself to be a repository or linked-
worktree root. A normal subdirectory is refused even though canonical discovery
could find its ancestor repository. Canonical convergence determines lease
collision; it does not authorize silently changing the user's selected root.

Every fresh repository run freezes a complete `git-common-dir-v1` receipt in
durable storage. Continuations inherit the exact parent receipt. The current
project path and run worktree path are re-resolved against it before every
later authority door, so path retargeting cannot redirect delivery,
verification, review, landing, or teardown. Retained legacy receipts remain
readable but carry no mutation authority.

The project row binds the same durable identity used by its worktree receipts.
Boot recovery and landing provide that receipt as the expected identity when
acquiring authority, then revalidate it under the guard before classification
or mutation. A migrated project with a nonempty folder and no bound identity
refuses historical native resume and active restart remint with typed
`repository-identity-unavailable` before runtime preflight or durable session
transition.

The current native permission mode is not a read-only sandbox. Repository
admission therefore also precedes orchestrator, payload, and independent-review
runtime create/resume whenever their configured cwd is Git-backed. This does
not authorize those runtimes to mutate the main checkout; the existing
orchestrator and worktree boundaries still apply.

`SEC-003` replaces ambient inheritance at direct Git, setup/readiness/
verification/cleanup shell, and provider runtime subprocesses with one positive
OS-essential allowlist. This subsumes the earlier three-selector scrub:
`GIT_DIR`, `GIT_WORK_TREE`, `GIT_COMMON_DIR`, app/PM variables, raw provider
credentials, injection controls, and every unknown name are absent. Git
filters/hooks/helpers and shell grandchildren inherit the same reduced map.
The Claude adapter then adds only its selected `CLAUDE_CONFIG_DIR`.

The app-owned `<project>-worktrees` sibling must be a real directory. A symlink
or Windows junction fails closed before provision, review checkout, teardown,
or recursive orphan removal.

This is a cooperative protocol, not a universal Git lock. The preserved
working PC-SDK, manual Git/IDE processes, and unrelated tools do not
participate. A repository child that outlives a hard-killed server is not
contained. Until those separate boundaries are completed, simultaneous
write-capable working-PC-SDK/Next use against one external repository remains
manually prohibited.

SF-002 landed as merge `a91bb6c8619672f316109d08719b1afea8a918f4`
from sealed feature record `e3cf861b3f5ffb9fe30ad3d17f328ec1e150d6bc`.
Contract/feature ancestry and exact tree
`897142ece8cfa7c27195d7f93f17f4a06e4f78f5` were positively proved;
post-merge `pnpm ci:check` passed with 370/370 server tests. The code landing
was pushed and re-fetched exactly at that merge before documentation closeout.
The feature worktree/residue and two handoff-recorded stale temp roots were
removed only after the documented guards; the feature branch was preserved.
These receipts do not broaden the cooperative boundary.

SEC-003 feature record `33bb9009389ad5ba089a11b5317cf4dbe2d5fefe`
guarded-landed as `4521d23651a757953ff155f0cf6583995d5acf54`
with exact feature/merge tree
`171cf09da680ee09a924ac8d94ea414ed87333c2`. Post-merge `pnpm ci:check`, exact
push/re-fetch, and guarded feature-worktree cleanup passed.

DL-001 feature record `b2629c4470aa6e8676b6ded774d2de3819ac79f3`
guarded-landed as `ae02c1828987aa9c529865391ad2bd67551d49e7`
with exact feature/merge tree
`a7f255ef25d5cd0d5b08e275f00c5e071f3f0698`. Repository builders now require
context-bound positive preparation and readiness receipts before mint/revival;
pre/post-merge 392/392 gates, exact push/re-fetch, and guarded feature-worktree
cleanup passed.

DL-002 feature record `7b194a941ae6fa45056ffc2ab1a253518ed9faad`
guarded-landed as `02231eceae4a5f26c6bd83cd5b486fd6752569a4`
with exact feature/merge tree
`20994454b05e2dfa3250e58ad11192844b2c99a2`. Browser-only approved
abandonment now has immutable authority and positive branch-preserving
settlement receipts, boot re-drive, and legacy non-authority preservation;
pre/post-merge 413/413 gates, exact push/re-fetch, and guarded feature-worktree
cleanup passed.

DL-003 implements the bounded N4 recovery gate. Sealed implementation
`eef661d7e97e6a9ce66568afff88a081129896aa` makes landed teardown retryable
until exact worktree-directory, Git-registration, merged-branch, durable-row,
and producer-lifecycle settlement are positive. Exact unresolved owners stay
visible in the existing Activity rail; server outbox cursors make reconnect
omission authoritative without clock inference. The composed two-worktree OS
hard-kill gate proves sealed recovery, one landing, positive cleanup,
preservation of unsealed work, and idempotent second boot. `OPS-006` remains in
N7. Feature record `f15d6d0f76687e37ce1a81fe823812360ec70655`
guarded-landed as `23872f15b1a9da749cc9efb5d7336b17470ed33e`
with exact feature/merge tree
`4c66313c084543ca7684cbe11a93c52468f77289`; post-merge 419/419, exact push/
re-fetch, and guarded feature-worktree cleanup passed.

## Lifecycle states

The durable state machine uses explicit states rather than inferred process
health:

```text
queued
provisioning
preparing
ready
planning
building
verifying
reviewing
fixing
merge-ready
merging
merged
tearing-down
completed

provisioning-failed
verification-failed
review-rejected
conflict
failed
cancelled
stranded
```

`review-rejected` may transition to `fixing`; it is not necessarily terminal.
`conflict`, `failed`, `cancelled`, and `stranded` preserve the branch and
worktree until a user or explicit recovery action resolves them. Unknown or
uncertain state never transitions to teardown.

## Provisioning and readiness

`git worktree add` supplies tracked files, but a useful workspace may still lack
dependencies, generated assets, ignored configuration, environment variables,
secrets, tools, databases, or services needed to build and review correctly.
Provisioning therefore has three receipts:

1. **Git receipt:** worktree path, feature branch, base branch/SHA, clean initial
   status, and repository identity match the run.
2. **Preparation receipt:** explicit setup steps completed with captured exit
   status and bounded output.
3. **Readiness receipt:** declared build/review prerequisites were positively
   checked before an agent starts.

Each project may define an app-owned profile resembling:

```ts
interface WorktreeProfile {
  baseBranch: string;
  setupCommands: string[];
  readinessCommands: string[];
  allowedLocalInputs: LocalInputPolicy[];
  cleanupCommands: string[];
}
```

Rules:

- the main working copy always sits on the project's base branch (default
  `main`) — never a feature branch. Feature branches exist only inside run
  worktrees. Every run branches from the base branch tip; provisioning refuses
  when the main copy is checked out elsewhere, and landing already guards it.
  This is how parallel work stays findable and never silently lands into a
  side branch;
- setup is deterministic and project-configured; an agent does not improvise
  hidden provisioning outside the recorded profile;
- package/download caches may be shared, but mutable dependency/build state is
  worktree-local unless an explicit safe policy says otherwise;
- ignored/untracked files are never copied implicitly;
- local inputs and secrets are allowlisted, injected through explicit policy,
  excluded from transcripts, and checked against accidental commits;
- preparation/readiness failure becomes typed `provisioning-failed`; no agent
  starts in a partially prepared workspace;
- unavailable review prerequisites are recorded. They disable auto-merge but
  may still permit orchestrator/manual review when the contract allows it.

## Delivery policies

Isolation never changes. The contract selects the cheapest review/landing path
that is safe for the work.

### Default: orchestrator review

```text
Provision → Build → Verify → Orchestrator review → Merge → Teardown
```

No separate review agent is required. The builder submits a sealed commit,
changed paths, contract report, checks run, and known limitations. PC-SDK runs
deterministic verification. The orchestrator reviews the contract, diff, and
receipts, then authorizes the deterministic landing service.

### Auto-merge eligible

```text
Provision → Build → Verify → Auto-merge → Teardown
```

Auto-merge is opt-in contract policy. The builder cannot declare itself safe to
merge. PC-SDK may auto-land only when every required predicate has a positive
receipt:

- a sealed deliverable commit exists and the worktree is clean;
- required acceptance criteria are machine-verifiable and passed;
- changed paths stay within declared scope and no forbidden/sensitive path
  changed;
- required tests/checks passed with no inconclusive result;
- no unresolved ask, warning, permission issue, or review requirement remains;
- the deliverable is validated against the current target base;
- the main working copy and target branch satisfy landing guards;
- the merge completes without conflict and Git positively proves ancestry.

Missing evidence routes to orchestrator review or `merge-ready`; it never means
pass. Auto-merge eligibility is policy plus evidence, not model confidence.

### Full independent review

```text
Provision → Plan → Build → Verify → Independent review
          → Fix ↺ Review → Merge → Teardown
```

Use for high-risk, cross-cutting, security-sensitive, poorly specified, or
weakly machine-verifiable work. Review produces structured findings tied to the
contract and sealed commit. Only the Fix phase may mutate after rejection. A
bounded retry/escalation policy prevents endless Review/Fix loops.

The hardcoded lifecycle is not a general workflow engine. Policy selects or
skips known phases; users do not construct arbitrary graphs.

## Contract and deliverable boundary

No builder starts without a contract and provisioned worktree. At completion,
the builder must submit a durable deliverable containing:

- run/contract id;
- sealed commit SHA and parent/base provenance;
- changed-path summary and diff statistics;
- contract report and acceptance evidence;
- commands/checks run with results;
- unresolved risks or limitations.

PC-SDK independently derives the actual changed paths and Git receipts; it does
not trust the builder's prose. A completed turn without a valid deliverable is a
failed run.

## Orchestrator boundary

The orchestrator may:

- inspect the main project read-only;
- author/approve contracts and choose delivery policy;
- inspect worktree diffs, review findings, and verification receipts;
- request Fix or authorize landing through a PC-SDK tool;
- resolve asks and conflicts with the user.

The orchestrator may not:

- directly edit the main working copy;
- perform an ad hoc model-generated `git merge`;
- bypass a missing contract, worktree, sealed commit, or required receipt;
- tear down uncertain/conflicted work.

Merge and teardown are deterministic `WorktreeLifecycleService` operations.
The orchestrator requests them; the service enforces policy and returns typed
receipts.

## Parallelism and landing queue

Multiple runs may provision and build concurrently in the same repository:

```text
Worktree A ─ Build ─ Merge-ready ┐
Worktree B ─ Build ─ Merge-ready ├─ per-repo landing queue ─ target branch
Worktree C ─ Build ─ Merge-ready ┘
```

Each run is isolated by branch/path/lease. Declared file-scope overlap is
detected early. Disjoint work may proceed freely; overlapping work is visibly
warned and may be serialized by policy, but is not globally prohibited.

Landing is serialized by a process-local FIFO keyed by the canonical repository
lease identity. The engine-wide lease excludes a second cooperating process;
the FIFO orders same-engine landing turns. Before each merge, PC-SDK compares
the run's validated base with the current target base. If earlier work advanced
the target, the pending run must be integrated/revalidated against the new
base. Conflict or invalidated checks route to Fix/orchestrator; stale
verification never silently lands.

The initial landing implementation may use the guarded, clean main working copy
as already planned. Reliability requires the landing queue, expected branch and
HEAD checks, clean-tree guard, serialized merge, and positive ancestry receipt.
If main-copy landing proves disruptive, a later dedicated integration-worktree
design may replace it behind the same service receipts.

## Merge receipt

A successful landing records:

- run, contract, feature branch, sealed commit, target branch;
- target SHA before and after merge;
- merge commit or fast-forward receipt as policy specifies;
- verification version and base SHA it covered;
- positive `merge-base --is-ancestor` result;
- timestamp and authorizer (`auto`, `orchestrator`, `user`, or `reviewer` —
  the full-review policy's independent approval).

Timeout, ambiguous process exit, changed base/HEAD, dirty main copy, or missing
ancestry proof is not success. It becomes a typed blocked/conflict/failed state
and preserves the worktree.

## Teardown and retention

Automatic teardown requires a confirmed merge receipt. It may then run explicit
cleanup steps, remove the worktree, prune metadata, and delete the feature
branch only when policy permits and ancestry is proven.

Unmerged branches/worktrees are retained for conflict, failure, cancellation,
stranding, uncertain merge, manual review, or requested debugging. Abandonment
is an explicit user-approved action with its own receipt; it is never inferred
from age or process death.

## Recovery

On boot, reconcile every nonterminal run against DB, Git, and filesystem state:

- intended worktree missing → typed failed/stranded state;
- worktree present without a live run/lease → stranded and surfaced;
- native agent gone mid-phase → phase fails loudly; preserve worktree;
- sealed commit present after process loss → recover to verification/review as
  evidence permits;
- `merging` without a stored receipt → inspect Git ancestry before deciding;
- merge positively complete but teardown incomplete → resume teardown;
- pending landing → return to the per-repo landing queue after revalidation.

Recovery acquires the same canonical repository lease before Git/filesystem
classification or cleanup. An occupied or unavailable repository is preserved
and deferred without preventing recovery of distinct repositories. Missing or
legacy repository identity never authorizes mutation.

Recovery never reruns a non-idempotent Git mutation based only on a stale DB
status.

DL-004 owns the remaining detached-review workspace authority gap. A reviewer
is write-capable from PC-SDK's perspective even when its charter says read-
only. Its detached checkout therefore requires workspace-owned authority
persisted before Git mutation, exact checkout-specific Git plus preparation/
readiness receipts before mint, verdict binding to the exact seal/workspace,
and positive retryable teardown before landing, Fix, override, or successor
review dispatch. Prompt intent is not a sandbox or cleanup receipt.

For a landed contract, the merge receipt proves history but not cleanup.
Recovery may destroy the exact active/stranded row only after the project
identity matches the producer receipt, the directory is absent, a successful
worktree-list read proves the exact path unregistered, expected-tip ref
deletion succeeds or the ref was already absent, and a successful exact ref
query proves absence. A destroyed exact row may re-enter solely to finish the
later lifecycle-stamp crash window after re-proving external absence. Missing,
locked, drifted, ambiguous, or unreadable evidence remains retryable and
visible.

## Guard tests

1. No write-capable agent starts outside its recorded worktree.
2. Contract + Git/preparation/readiness receipts exist before agent start.
3. Actual changed paths are derived and checked against contract scope.
4. Review consumes a sealed commit; Fix creates a new checkpoint.
5. Auto-merge refuses missing, failed, warning, or inconclusive evidence.
6. One repository admits only one active landing mutation at a time.
7. Base advancement forces integration/revalidation before landing.
8. Merge success requires positive ancestry proof.
9. Teardown refuses unmerged, conflicted, failed, or uncertain runs.
10. Kill recovery preserves work and produces the same durable outcome as an
    uninterrupted lifecycle.
11. Common-directory aliases and linked worktrees collide across cooperating
    processes while distinct repositories remain independent.
12. Every Git-backed runtime and late mutation/recovery door proves the frozen
    repository receipt; occupied or drifted authority performs no side effect.
13. Symlink/junction worktree roots cannot redirect recursive cleanup, and
    lifecycle `completed` is emitted only after branch deletion and orphan
    sweep settlement.
14. Project creation mode/state drift and attach root mismatch refuse before a
    project row, import, commit, or dirty-tree side effect; successful in-place
    import records the canonical identity and a clean initial commit.
15. Repository test fixtures await lease release before removing repository or
    sibling-worktree paths; cleanup is a barrier, not fire-and-forget evidence.

## Anti-patterns

- letting a "small" agent edit the main working copy;
- requiring a token-expensive review agent for every change;
- letting the builder choose its own auto-merge eligibility;
- treating agent prose or command exit inference as a merge receipt;
- running parallel builders on one mutable checkout;
- merging parallel results concurrently into the target branch;
- deleting a worktree because its process disappeared or a timeout elapsed;
- copying ignored files or secrets into worktrees without explicit policy;
- calling a stale-base verification result good enough after another merge.

> v1 shipped 2026-07-11 — live-app worktree-lifecycle smoke test.
