# Current state

Last updated: 2026-07-12 after SF-002 guarded landing, push, and feature-
worktree cleanup.

## Preserved baseline

- Original daily driver: `E:\Claude Code Projects\Personal\PC-SDK`
- Stable repository: `github.com/emersonmccuin-pixel/pc-sdk`
- Annotated tag: `working-v1-2026-07-11`
- Baseline commit: `e233aa54c58dca163e98cf6011e79a0b91bd2d6f`
- Evidence: `pnpm ci:check` passed; `pnpm smoke` completed a live Claude
  Opus turn after the stale smoke harness was repaired.

The original checkout remains the daily driver. New architecture work happens
only in PC-SDK Next.

## Fork identity

- Checkout: `E:\Claude Code Projects\Personal\PC-SDK-Next`
- Repository: `github.com/emersonmccuin-pixel/pc-sdk-next` (private)
- `origin`: PC-SDK Next, fetch and push
- `upstream`: stable PC-SDK, fetch-only (`pushurl=DISABLED`)
- Base branch: `main`
- PF-001 landing merge: `e1667dbae069f1ea62fe4d8e54489927734f2483`
- PF-001 worktree: removed after positive landing proof
- BC-001 landing merge: `fd0756a3c39640d91bcb20cfe4a9fe22cb7d2380`
- CF-001 sealed implementation: `35b49d3a012abfb3ec1b439060b1046f95887e19`
- CF-001 landing merge: `6ea518bc6b520934aece30cbea94d201f4334b0b`
- CF-001 worktree: removed after positive sealed-commit and feature-tip
  ancestry proof; feature branch preserved
- CF-002 sealed implementation: `9ebf2c6284bebdae43f9263193999764a0c8413b`
- CF-002 closeout landing: `a5943690ddbcbbf11ce3838ffc6dcfc950b90b41`
- CF-003 sealed implementation: `0ecc8e538935e57466da4b0106311fb65e7927ec`
- CF-003 feature record: `936058fa866d51344e77bd1b1ec873f3bbb3662a`
- CF-003 landing merge: `f76579686d2fc5df66e6eac4adcff0344b656256`
- CF-003 worktree: removed after positive sealed/feature ancestry proof;
  feature branch preserved
- CF-004 sealed implementation: `b1a377e7a75007e29a51e36dcdd5f283aaa1378f`
- CF-004 feature record: `3e80d8fdcae208dabcf46bd01538418e8dc89ad4`
- CF-004 landing merge: `ab2ffb95c3fb91931af3853ffc8f7f583080cfa5`
- CF-004 worktree: removed after positive sealed/feature ancestry proof;
  feature branch preserved
- RS-001 feature branch: `codex/rs-001-session-selection-stamps` (preserved)
- RS-001 sealed implementation: `cb61f255220dd50e95b53418f28e6bdd05f5077c`
- RS-001 feature record: `9da30c2e30cb29395b28bc8e317fa291599e8d56`
- RS-001 landing merge: `039af6c56a1235260d9859af1c51a6dca20fb990`
- RS-001 worktree: removed after positive sealed/feature ancestry and exact
  tree-equality proof; deregistered dependency residue was verified and removed
- RS-002 feature branch: `codex/rs-002-context-observation`
- RS-002 base: `bdd4ce0be8aebff284c2cbbb425ab0b5e61b0a0b`
- RS-002 sealed implementation:
  `84c30f3a5fd782d3ec1b008e75d3729c3b5d96c0`
- RS-002 sealed tree: `1322938d45c6ca75557da896d68179ddf5c55325`
- RS-002 feature record: `bc3d90630519b6780a0f300b062c0fd3f9b18963`
- RS-002 landing merge: `3a274034499f9454e059ded091b79276394780af`
- RS-002 landed tree: `ca01b1badca3d93ad979b9cf8c261cbb7e671955`
- RS-002 feature worktree: removed after positive sealed/feature ancestry and
  exact tree-equality proof; the deregistered dependency residue was verified
  and removed
- RS-003 base: `ff5b04bbb799293b31800267f061dcc6edb13742`
- RS-003 feature branch: `codex/rs-003-specialist-selection-stamps`
- RS-003 sealed implementation:
  `2f10a96ae0c56747ff25d868d15514bbef7359d3`
- RS-003 sealed tree: `01285d07cc23b2652b41d4c277628199da0e324c`
- RS-003 feature record: `b79f84b130702f7c523fe20a32c71c5236eb9fb9`
- RS-003 landing merge: `9fde98518aca92742040ed8e0e82a4825f258f5a`
- RS-003 landed tree: `86340e89f86827d2296b2fdb8428ac06d1888555`
- RS-003 feature worktree: removed after positive sealed/feature ancestry and
  exact tree-equality proof; verified dependency residue was removed
- RS-003 closeout landing: `6a0beb90a7b730dbee94181f012c0918f464af8b`
- RS-004 base: `6a0beb90a7b730dbee94181f012c0918f464af8b`
- RS-004 feature branch: `codex/rs-004-quota-observations`
- RS-004 feature worktree: removed after positive sealed/feature ancestry and
  exact tree-equality proof; verified dependency/build residue was removed
- RS-004 sealed implementation:
  `f7bcb60e9f242c72a56ffda508da6451012e172b`
- RS-004 sealed tree: `316ec12a2f94991cb89ed069886feec17e02ad03`
- RS-004 feature record:
  `37d8f7e4d9e67202c3487d1ef3fe6512f6343d66`
- RS-004 landing merge: `1bd333903660b0ada212e305846efaee1b7bdd62`
- RS-004 landed tree: `8cb674bd82c10a07eac8ab34a91adf4293b28ef6`
- PM-001 base: `a7c5423cb5a4aa8549521badcfdd320437a74def`
- PM-001 feature branch: `codex/pm-001-ainativepm-discovery`
- PM-001 feature worktree: removed after positive ancestry/tree proof
- PM-001 sealed proposal checkpoint:
  `e2fe6ee11f8ddd9641eb20262913a648b47a73e8`
- PM-001 proposal tree: `e4c32ad64a635aeafa95230ccf6d8a69eed6ceef`
- PM-001 accepted-decision commit:
  `4f0503f2a3b3201c28f21f1e5b4cd0d45f877e58`
- PM-001 accepted-decision tree:
  `913cc4905b0d0a2c133820da67e15f9dedeb19cf`
- PM-001 feature record:
  `16ed919628fd12f5f74bf5713e02fb2f3d89eb7b`
- PM-001 landing merge:
  `1adaad7926ca64a47fc3935c8afffbc799ada70e`
- PM-001 landed tree: `18cfeb9177130f697ad30358d76b5db27104bae4`
- PM-001 feature worktree: removed after positive ancestry/tree proof; feature
  branch preserved
- BC-002 base: `36ac71c59bb1d4095e30c9e2e4ed4d8ef73c9fd1`
- BC-002 sealed evidence: `871c7986a4683eec585159ad52ca9cffcdc83f8c`
- BC-002 feature tip: `5f9325b14ee40085ea2ef1f827a2703163abeb0a`
- BC-002 landing merge: `9278a6f9e9769b73601c58399554468328b314a1`
- BC-002 landed tree: `75c83dd3024d47fe73a655a41e46fae604b824ed`
- BC-002 feature worktree: removed after positive ancestry/tree proof; feature
  branch preserved
- SF-001 base: `5581af7918ac438b51785cb825f216ab3d79d738`
- SF-001 feature branch: `codex/sf-001-data-dir-admission`
- SF-001 sealed implementation:
  `c22d5278419ca6ad3d96add8a3d0109aaefca796`
- SF-001 sealed tree: `64c0a414bb159498faf64e16be4f3ecaeef5cdae`
- SF-001 feature tip: `8b6a08dcde66cb190dcbb96edf500c7276f91cb2`
- SF-001 landing merge: `a8b52c666d3fc3284b94f441ce602b908689539a`
- SF-001 landed tree: `e7d6dc7d8318f40be698b0564b8f5d65874187d7`
- SF-001 feature worktree: removed after positive ancestry/tree/post-merge-CI
  proof; dependency/build residue was path/process-guarded and removed; feature
  branch preserved
- SF-002 base: `94dee1a7ec56ca3e2470769c9d136ed11754e6e6`
- SF-002 feature branch: `codex/sf-002-repository-lease`
- SF-002 contract commit: `0be8912`
- SF-002 sealed feature record:
  `e3cf861b3f5ffb9fe30ad3d17f328ec1e150d6bc`
- SF-002 landing merge: `a91bb6c8619672f316109d08719b1afea8a918f4`
- SF-002 exact feature/merge tree:
  `897142ece8cfa7c27195d7f93f17f4a06e4f78f5`
- SF-002 code landing: pushed and re-fetched exactly at the landing merge
  before documentation closeout
- SF-002 feature worktree: deregistered after proof; exact residue removed
  after a zero-process guard; feature branch preserved

Isolation defaults in the planning slice:

| Resource | Working PC-SDK | PC-SDK Next |
| --- | --- | --- |
| Server | 5123 | 5124 |
| Dev web | 5173/default | 5175 |
| Data | original repo `data` | Next repo `data` |
| Logs | `%LOCALAPPDATA%\PC-SDK\logs` | `%LOCALAPPDATA%\PC-SDK-Next\logs` |
| Shortcut | PC-SDK | PC-SDK Next |
| Browser title | PC-SDK | PC-SDK Next |

## Implemented baseline capabilities

- Browser shell and streaming Claude orchestrator chat
- Canonical runtime seam with `ClaudeRuntimeAdapter`
- Runtime-stamped agent runs and specialist roster
- Typed contracts, deliverables, deterministic verification
- Durable asks/mailbox and agent terminal envelopes
- Mandatory worktree provisioning/readiness, sealed commits, guarded landing,
  teardown, recovery, and lifecycle tests
- Global MCP client/bridge foundation and durable provider-neutral subscription
  quota observations, with Claude pull/passive acquisition adapter-local
- One-click hidden launcher and boot recovery
- Pre-migration canonical data-directory admission through a kernel IPC witness
  plus a dedicated SQLite ownership transaction, with typed launcher failure,
  crash release, and replacement handoff gated on positive acquisition
- SF-002 provides cooperative engine-lifetime repository admission keyed by
  canonical Git common-directory identity, with immutable
  run receipts and guards across every Git-backed runtime, mutation, landing,
  cleanup, and recovery door; guarded-landed and pushed to `origin/main`
- Canonical pre-listener boot quarantine of queued/failed sends owned by
  `legacy-unavailable` orchestrator sessions, with queue revision plus
  `send-state`/outbox evidence committed together
- Canonical provider-neutral conversation event identity with strict guards,
  conversation-owned transactional sequence allocation, and a dedicated
  atomic publication outbox
- Persisted visible stream deltas and one row-to-frame mapping for live,
  reconnect replay, and past-session HTTP projection
- Deterministic browser projection by authoritative sequence, including exact
  redelivery idempotency, gap buffering, and fail-closed sequence/item/stream/
  delta conflicts
- Incremental immutable browser projection with separate received/checkpoint and
  folded-sequence frontiers, indexed identity receipts, one replay normalization
  path, and digest-only evidence after completed stream payload compaction
- Adapter-local native message correlation; canonical terminal outcomes and
  stop reasons; historical private reasoning retained only as hidden migration
  evidence with no producer or render path
- Durable revisioned FIFO sends with atomic queue/event/outbox transitions,
  strict sender receipts, reconnect snapshots, restart re-drive, immutable
  claimed revisions, and visible edit/remove controls
- Durable requested/confirmed/failed interruption state: linked replacements
  release only on the exact typed abort terminal; timeout, shutdown, normal
  completion, stream failure, and restart uncertainty fail closed
- Composition-readiness gating for both recovered and freshly admitted sends;
  deleted projects and inactive/deleted sessions cannot mint or claim work
- Atomic new/resume/account-switch/project-delete conversation transitions,
  including safe cancellation, rollback, and exact stamped historical resume.
- Closed app-authored activity phases and a browser-derived elapsed/“still
  waiting” presentation that stays honest without exposing provider reasoning
  or inventing durable status.
- One canonical guarded tool lifecycle per adapter-minted call identity, with
  deterministic safe summary, explicit approval provenance, terminal closure
  before turn/run termination, and execution-only `tool_called` evidence.
- Replayable process-local approvals with bounded/redacted transient details;
  malformed special-tool payloads are deny-only and fail closed again at the
  runtime adapter. Unsupported sidechain approvals deny immediately rather than
  opening an unpublishable waiter.
- Strict exact-shape ingestion for conversation and agent transcript events
  across live sockets and HTTP replay/backfill. Legacy raw tool/system rows stay
  retained as hidden evidence while preserving canonical high-water sequence.
- Complete immutable runtime/account/model/effort stamps for new orchestrator
  app sessions, conservative legacy-session quarantine, bind-once native
  identity, typed continuation provenance, browser-safe resume availability,
  and non-boundary live provenance convergence without chat reset/replay.
- Account-scoped Claude capabilities/model discovery and immediate pre-mint
  validation with no runtime, account, model, effort, continuation, or billing
  fallback.
- A fresh persisted continuation-attempt identity for every orchestrator native
  create/resume mint. Positive receipts and failure callbacks use exact DB CAS,
  so output from abandoned creates, resumes, restarts, or disposed services
  cannot advance a successor attempt.
- Complete immutable execution-effective specialist snapshots and runtime/
  account/model/effort selections on fresh, continuation, auto-continuation,
  revived, and independent-review runs. Exact create/resume attempts, bind-once
  native identity, legacy quarantine, and parent-derived scope guards make the
  run row authoritative rather than the mutable roster.
- Browser/MCP-safe specialist provenance: complete selection, opaque revision,
  native-ID presence, and typed continuation state without native or attempt
  identifiers. Reconnect terminal tombstones, project-scoped resource ingress,
  and exact MCP response admission fail closed.
- Runtime-aware immutable account records and credential-environment isolation;
  Claude subscription launches scrub API/auth variables that could shadow the
  selected credential home.
- Closed provider-neutral context observation/capability contracts; strict
  Claude exact/derived mapping from the pinned context control; one bounded,
  fenced post-terminal observation per eligible turn; atomic canonical
  persistence; deterministic live/replay/history projection; honest stale,
  unavailable, and compaction states; and a shared context-used bar that never
  renders a percentage without fresh accepted evidence.
- Durable provider-neutral subscription-quota contracts and current-state truth;
  collision-safe runtime/account identity; atomic revisioned outbox publication;
  strict partial/complete/unavailable and per-window freshness semantics; generic
  bounded polling; exact pull/passive attribution; and a guarded dynamic rail
  projection that always presents used quota while retaining source semantics.

## Completed N3 specialist-selection slice

`RS-003` completed its implementation and verification gate from clean pushed
base `ff5b04bbb799293b31800267f061dcc6edb13742`. The sealed implementation is
`2f10a96ae0c56747ff25d868d15514bbef7359d3`, with tree
`01285d07cc23b2652b41d4c277628199da0e324c`. It freezes the exact specialist
snapshot and complete selection, fences native create/resume by durable attempt
receipt, quarantines unverifiable legacy rows, and removes native/attempt
identity from browser, websocket, pending-ask, and MCP seams.

Independent hostile audits found and regressed landing/continuation and review
races, mutable continuation scope, stale legacy contract recovery, reconnect
resurrection, foreign-project resource ingress, impossible provenance, and raw
malformed MCP response relay. Full `pnpm ci:check`, the 319-test server suite,
production web build, final source/path audits, and isolated no-provider browser
QA passed. The feature record `b79f84b130702f7c523fe20a32c71c5236eb9fb9`
was guarded-merged as `9fde98518aca92742040ed8e0e82a4825f258f5a`
and pushed to `origin/main`. Sealed and feature ancestry plus exact tree equality
were proven, the post-merge workspace gate passed, and the feature worktree and
verified residue were removed. RS-004 completed the quota normalization work
described below.

## Completed N3 subscription-quota slice

`RS-004` completed implementation and verification from clean pushed base
`6a0beb90a7b730dbee94181f012c0918f464af8b`. The sealed implementation is
`f7bcb60e9f242c72a56ffda508da6451012e172b`, with tree
`316ec12a2f94991cb89ed069886feec17e02ad03`. It replaces the inherited
Claude-shaped usage cache/wire with durable atomic DB/outbox quota truth, strict
provider-neutral source observations, app-owned used/remaining normalization,
runtime/account attribution, per-window freshness, generic bounded polling, and
an honest dynamic browser projection. Claude credentials, pull/passive native
scales, status, reset parsing, and the narrowly verified included-plan Fable
mapping remain inside the adapter; paid overage and billing/credit fields stay
excluded. Context and per-turn token usage remain separate families.

Three independent hostile audits covered persistence/service races,
runtime/provider mapping, and HTTP/web/browser ingress. Full `pnpm ci:check`
(including 331/331 server tests), production Vite build, final path/provider
audits, and isolated browser QA at 1440x900 and 760x720 passed. Browser QA
rendered 24 dynamic windows with accessible progress semantics, independent
bounded scrolling, no horizontal overflow, and no console warnings/errors; its
temporary listener/data were removed. Feature record
`37d8f7e4d9e67202c3487d1ef3fe6512f6343d66` was guarded-merged as
`1bd333903660b0ada212e305846efaee1b7bdd62` and pushed to `origin/main`.
Sealed/feature ancestry and exact tree equality were proven, post-merge
`pnpm ci:check` passed, and the feature worktree plus verified dependency/build
residue were removed. The feature branch is preserved.

## Accepted N1 AInativePM ownership decision

`PM-001` has completed its parallel domain/persistence, UI/REST, MCP, and
PC-SDK-touchpoint evidence lanes from clean pushed PC-SDK Next base
`a7c5423cb5a4aa8549521badcfdd320437a74def`. The AInativePM audit began at
`5033d5e`; concurrent UI-only landings advanced clean pushed `main` to
`c146162`, and the 24-file `web/**` delta was re-audited before sealing.
`docs/research/ainativepm-discovery.md` now contains the
ownership table, interaction sequences, typed port, failure/idempotency matrix,
deep-link direction, rejected duplications, and dependency-ordered proposal.

The evidence rejects the inherited project-only anchor. It proposes separate
optional generic PM context and exact external item references. AInativePM owns
all long-lived management truth; PC-SDK owns all technical execution truth.
Strict reads and deep links may be automatic. Current PM integration writes are
blocked because the bridge lacks a positive app policy gate and the PM surface
lacks general caller idempotency, a durable queryable
mutation receipt, expected revision, remote-authority/principal fingerprints, and replayable
events. The product owner accepted that ownership direction and its future
immutable verification/landing evidence policy on 2026-07-12. No current
integration, folder-registration, auth/config, or remote PM mutation is
authorized by the decision.

The accepted feature record `16ed919` was guarded-landed as merge `1adaad7` and
pushed to `origin/main`. Exact feature/merge tree equality and ancestry passed;
post-merge `pnpm ci:check` passed, and the clean feature worktree was removed.

No explicit live mutation tool was called. A source audit after one
`get_started` call found that the tool invokes first-run domain seeding. Five
root domains were observed only after that hook ran, so no private DB read or
pre-call snapshot can distinguish a no-op, one-time marker stamp, or default-
domain creation. That bounded uncertainty is retained in the receipt; PM-001
does not claim the remote stayed unchanged and will not make another live call.

## Completed N1 browser characterization

`BC-002` compared preserved `e233aa54` and current base `36ac71c` production
bundles through isolated disposable fixtures. Four desktop/narrow captures and
their SHA-256 receipts are tracked. Seven core shell source blobs are identical;
measured header/tab/rail/composer geometry matched at `1440x900` and `760x720`,
and neither subject had document-level horizontal overflow at those viewports or
the targeted `480x720` stress width.

The current deterministic journey directly covered Alpha/Beta isolation,
current/history/resumed session provenance, safe typed chat/tool/activity/
context/quota/run projection, durable queued-send edit/remove, positive
interrupt confirmation before replacement delivery, reload equivalence, and
two-tab convergence. No browser console warning/error, private reasoning, raw
native session ID, or raw continuation-attempt ID was observed in the bounded
matrix. Durable invariant claims remain owned by the named CF-001 through
CF-004 and RS-001 through RS-004 guards; BC-002 does not promote their global
requirement statuses by manual observation.

Both fixtures were fake-only and used temporary databases, repositories,
credential homes, logs, and ports. Exact fixture PIDs were stopped, listeners
were proven closed, temp-root-validated data was removed, the detached baseline
had no tracked diff and was removed, and the stable checkout retained its
pre-run HEAD/status. The full matrix and cleanup boundary are in
`docs/research/browser-baseline.md` and
`docs/execution/receipts/BC-002.md`. Together with BC-001 and the accepted
PM-001 ownership seam, the guarded landing and post-merge receipt close the
bounded N1 planning/discovery gate.

## Completed N4 data-directory admission slice

`SF-001` implements the data-directory half of `OPS-005` from clean pushed base
`5581af7918ac438b51785cb825f216ab3d79d738`. The sealed implementation is
`c22d5278419ca6ad3d96add8a3d0109aaefca796`, with tree
`64c0a414bb159498faf64e16be4f3ecaeef5cdae`.

Production now canonicalizes `PC_DATA_DIR` and, before `runMigrations`, holds a
SHA-256-addressed Windows named pipe or Linux abstract socket plus a dedicated
zero-wait SQLite `BEGIN IMMEDIATE`. The IPC witness closes the POSIX unlink/
recreate hole of a path-only file lock. A normal contender exits with typed
occupied/unavailable evidence before `pc.sqlite`, recovery, provider
construction, or listener startup. Restart keeps the witness until actual
parent-process exit; its bounded waiter can only proceed on a later positive
acquisition and never on elapsed time.

Shutdown gates HTTP/upgrades and `SessionRegistry.get()` before disposal
snapshots, attempts all tracked specialist/orchestrator disposals, propagates
known native-close uncertainty, and closes the product DB. The focused matrix
covers aliases/junctions, path replacement, deterministic `EACCES`, corruption,
graceful and hard-kill handoff, simultaneous reclaim, real production-entry
rejection, registry shutdown races, and launcher ordering. Full
`pnpm ci:check` passed with 342/342 server tests and the dead-import guard.
Independent lock, lifecycle, and test reviews report no remaining P0/P1/P2 code
blocker. The detailed receipt is `docs/execution/receipts/SF-001.md`.

This slice excludes only a second PC-SDK engine from one app data directory. It
does not claim positive provider/setup/repository subprocess-tree exit; the
repository lease remained SF-002 at that checkpoint, while child-environment
scrub and remaining process hardening retain their separate owning slices.

Feature tip `8b6a08d` guarded-landed as merge `a8b52c6` with exact tree
`e7d6dc7`; sealed and feature ancestry, post-merge `pnpm ci:check` (342/342
server tests), and push to exact `origin/main` passed. The feature worktree was
deregistered after that proof. Git left only clean-worktree dependency/build
residue; its exact parent/name/process guard passed before recursive removal.

## Completed N4 repository-admission feature

`SF-002` implements the cooperative repository half of `OPS-005` from clean
pushed base `94dee1a7ec56ca3e2470769c9d136ed11754e6e6`. For every configured
Git-backed cwd, the engine resolves the native real Git common directory and
holds a protocol-stable kernel witness plus a zero-wait repository-local SQLite
transaction for the engine lifetime. The same engine remains re-entrant so
isolated builders can run concurrently; the existing canonical-keyed local
FIFO continues to serialize landing.

Fresh repository runs freeze a complete `git-common-dir-v1` receipt. DB guards
enforce its shape, immutability, and exact continuation inheritance. Runtime,
delivery, verification/review, landing, teardown, orphan cleanup, and recovery
revalidate that receipt. Git-backed orchestrator and payload/review runtimes
also acquire authority because the pinned permission mode is not a read-only
sandbox. Legacy receipts remain readable but cannot authorize mutation, and a
symlink/junction app-owned worktree root cannot redirect recursive cleanup.

Creation admission preserves the user's authoritative mode. `init-empty` and
`init-in-place` must still match the current non-Git folder state; initialization
claims the future `.git` identity, retains a crash marker, and creates one clean
`Initial scaffold` or `Initial import` commit. `attach-to-git` requires the
selected canonical worktree root and refuses a repository subdirectory rather
than rewriting it. Successful project rows and worktree receipts durably bind
the same identity. Boot recovery and landing acquire against that expected
identity before classification or mutation.

Direct Git, setup/readiness/verification shell, and provider runtime child
environments all remove ambient `GIT_DIR`, `GIT_WORK_TREE`, and
`GIT_COMMON_DIR`. Historical resume and active restart remint for a migrated
project with no durable repository identity return typed
`repository-identity-unavailable` before preflight or durable session change.

Repository-lease tests pass 19/19, runtime session selection 17/17, HTTP
contract 12/12, and the landing + independent-review + kill-recovery matrix
47/47 (27 + 12 + 8). The full server suite passes 370/370. Awaited fixture
cleanup, migration diagnostics, actual-path/mutation-door audits,
`git diff --check`, and full feature-tree `pnpm ci:check` pass. Both independent
hostile re-reviews are clean after fixes with no remaining P0/P1/P2 blocker.
The evidence is `docs/execution/receipts/SF-002.md`.

Sealed feature record `e3cf861b3f5ffb9fe30ad3d17f328ec1e150d6bc`
guarded-landed as `a91bb6c8619672f316109d08719b1afea8a918f4`.
Contract and feature ancestry are positive and the feature/merge trees equal
`897142ece8cfa7c27195d7f93f17f4a06e4f78f5`. Post-merge `pnpm ci:check`
passed with 370/370 server tests. The code landing was pushed and re-fetched
exactly at the merge before documentation closeout. The feature worktree was
deregistered, its exact residue removed after a zero-
process guard, two handoff-recorded stale temp roots removed, and the feature
branch preserved.

This is not universal repository exclusion. The preserved working PC-SDK,
manual Git/IDE processes, and unrelated tools do not participate, and a child
that survives a hard-killed server is not contained. The manual
working-PC-SDK/Next concurrent-write prohibition remains. `OPS-005` stays
accepted despite the completed cooperative landing.

## Completed N4 child-environment hardening feature

`SEC-003` replaces broad inherited environments with one provider-neutral
positive OS-essential allowlist. The policy starts empty, treats Windows names
case-insensitively while dropping ambiguous or Unicode-lookalike names, keeps
POSIX matching exact, rejects undefined/NUL/exported-function values, and never
mutates its input. App/PM variables, raw provider/API credentials, Git
selectors, shell/loader injection controls, and unknown names do not cross.

Direct Git, setup/readiness/verification/cleanup shells, and the fixed Windows
tree-kill helper all use that boundary. Real Git filter/hook and shell/
grandchild canaries prove the current host's PM/OpenAI/app values are absent.
The shell executable itself is pinned to `/bin/sh` or a positively resolved
SystemRoot/Windir-consistent `cmd.exe`; ambient `ComSpec` cannot choose it and
uncertain shell evidence fails closed.

Claude discovery/create/resume starts from the same allowlist and adds only the
selected `CLAUDE_CONFIG_DIR`. `ClaudeRuntimeSession` sanitizes again at the
final query seam and refuses missing, malformed, inherited, or lowercase-
lookalike homes instead of falling back to another account. A provider-free
fake spawn through pinned SDK 0.3.206 proves the native process receives only
the safe input plus SDK-authored entrypoint/version markers. MCP stdio retains
its separate safe SDK defaults plus explicit registered-consumer env; the
same-engine restart remains the sole broad trusted exception.

The pure/runtime/SDK/profile/verification/Git/MCP/static matrices pass, as does
full feature-tree `pnpm ci:check` with 387/387 server tests. Three independent
hostile re-reviews are clean after closing ambient Windows shell selection,
missing credential-home fallback, and static inventory gaps. No live provider,
PM/MCP-network, stable-data, original-app, or external-repository action was
required. Full evidence is in `docs/execution/receipts/SEC-003.md`.

Sealed implementation `0b9354714c6e04826a24772c9a29b03c8663b235`
and documentation-only feature record
`33bb9009389ad5ba089a11b5317cf4dbe2d5fefe` guarded-landed as
`4521d23651a757953ff155f0cf6583995d5acf54`; feature and merge share exact tree
`171cf09da680ee09a924ac8d94ea414ed87333c2`. Post-merge `pnpm ci:check`
remained green with 387/387 server tests. Exact push/re-fetch and guarded
feature-worktree/residue cleanup passed; the feature branch is preserved.

## Known architectural gaps

- Production composition remains fixed to Claude and existing orchestrator
  defaults; there is no Codex adapter or deliberate runtime/model/effort
  selector yet.
- Full specialist-builder defaults, attributed cross-runtime handoff, and
  deliberate runtime/account/model/effort selector UI remain unimplemented.
- Some older runtime-notice vocabulary remains not yet fully provider-neutral.
- The accepted AInativePM seam remains unimplemented. Typed PM refs,
  stable PC-SDK run links, authority/principal-pinned query health, vault-backed consumer
  attachment, and receipt-safe commands remain unimplemented; automatic PM
  writes are blocked.
- Process identity is positive at `/health`; SF-001 enforces canonical
  data-directory single-engine admission; and SF-002's cooperative repository
  lease is guarded-landed and pushed. Nonparticipating stable/manual
  tools and escaped repository children remain outside that proof. The listener
  is not yet explicitly loopback-bound.
- Worktree profiles do not yet have an explicit local-input/environment/secret
  injection policy. Arbitrary ambient variables are now deliberately absent;
  private setup dependencies that require credentials must wait for an
  attributable allowlisted injection design rather than regaining inheritance.
- At the inherited `480px` stress width the composer narrows to about `101px`,
  and Escape does not dismiss App Settings in either preserved or current
  subject. Close remains usable and no document overflow occurs. These are N7
  usability/accessibility backlog, not a Next regression or N1 blocker.

## Completed N3 runtime-selection slice

`RS-001` completed the bounded orchestrator half of `RUN-001` through `RUN-004`
and `RUN-007`: immutable selection, account-scoped Claude discovery, exact
create/resume receipts, durable attempt fencing, atomic account/session
transitions, and honest typed presentation. Hostile coverage includes mutable
defaults, account A -> B -> resume A, concurrent first sends, async preflight
races, restart/remint, missing/mismatched/late receipts, disposed service
output, abandoned attempt success/failure, legacy migration, and raw-SQL state
guards. Isolated no-provider browser QA confirmed cold-reload provenance,
view-only unavailable continuation, no native/attempt identity leakage through
orchestrator session surfaces, clean console, and bounded layout.

At RS-001 close, attributed handoff, Codex, and provider-neutral quota semantics
remained later slices. RS-004 now completes the Claude-path quota portion; this
historical receipt still does not claim the global runtime requirements complete.

## Completed N3 context slice

`RS-002` completed its full implementation and verification gate from clean
pushed base `bdd4ce0be8aebff284c2cbbb425ab0b5e61b0a0b`. The sealed feature tip is
`84c30f3a5fd782d3ec1b008e75d3729c3b5d96c0`, with tree
`1322938d45c6ca75557da896d68179ddf5c55325`. It establishes honest
Claude-backed orchestrator context observation through the canonical
conversation/outbox path and never uses cumulative turn usage as context.
Contracts, persistence, adapter/service races, browser projection, hostile
review, production build, isolated browser QA, and full `pnpm ci:check` passed.
The guarded landing merge `3a274034499f9454e059ded091b79276394780af` is
pushed on `origin/main`; sealed and feature ancestry plus exact feature-tree
equality were positively proven, and the feature worktree/residue were removed.
At RS-002 close, quota normalization, Codex, and specialist widening remained
separate slices. RS-004 now completes quota normalization on the Claude path;
Codex/runtime conformance and specialist context widening remain separate.
