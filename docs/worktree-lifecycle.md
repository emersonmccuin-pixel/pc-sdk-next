# Git worktree lifecycle

Status: **locked target architecture** (2026-07-10). This document defines how
PC-SDK isolates, verifies, lands, and cleans up every repository mutation. It is
the worktree counterpart to `docs/agent-runtime-architecture.md`.

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
- lease/heartbeat and active phase owner;
- sealed deliverable commit SHA;
- verification and review receipts;
- landing policy, landing receipt, and cleanup state.

The DB is authoritative for intended lifecycle state. Git and filesystem state
are positively reconciled against it on boot.

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

Landing is serialized by a per-repository lock. Before each merge, PC-SDK
compares the run's validated base with the current target base. If earlier work
advanced the target, the pending run must be integrated/revalidated against the
new base. Conflict or invalidated checks route to Fix/orchestrator; stale
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

Recovery never reruns a non-idempotent Git mutation based only on a stale DB
status.

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
