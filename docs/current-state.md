# Current state

Last updated: 2026-07-12 at BC-002 browser-baseline closeout.

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

## N1 browser characterization evidence complete

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
PM-001 ownership seam, this satisfies the bounded N1 evidence gate; guarded
landing and the post-merge receipt close N1.

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
- Process identity is positive at `/health`, but a data-directory mutex and
  cross-process repository lease do not yet exist; the listener is not yet
  explicitly loopback-bound.
- Runtime/setup subprocesses inherit a broad server environment. A least-
  privilege allowlist/scrub must prevent unrelated app secrets (including PM
  tokens) from reaching providers or repository commands.
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
