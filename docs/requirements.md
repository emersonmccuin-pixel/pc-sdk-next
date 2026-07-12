# PC-SDK Next requirements

Status: accepted planning baseline, 2026-07-11. Requirement IDs are stable.
Implementation status changes; meaning changes require a recorded decision.

Status values: `accepted`, `implemented`, `verified`, `deferred`, `rejected`.

## Architecture

| ID | Status | Requirement |
| --- | --- | --- |
| ARCH-001 | accepted | PC-SDK Next is a modular monolith: one local server and one database, divided into explicit components with narrow typed seams. |
| ARCH-002 | accepted | A component owns its state and state machine. Other components use its published interface/events rather than its tables or implementation. |
| ARCH-003 | accepted | Provider-native packages, events, sessions, and vocabulary remain inside concrete runtime adapters and composition. |
| ARCH-004 | accepted | Cross-component calls have contract tests; core invariants have guard tests. |
| ARCH-005 | accepted | No shims or parallel compatibility paths. Contract changes move producers, persistence, consumers, and tests together. |

## Baseline and operations

| ID | Status | Requirement |
| --- | --- | --- |
| BASE-001 | verified | The known-working PC-SDK baseline is preserved in the original private repository at tag `working-v1-2026-07-11`. |
| OPS-001 | verified | PC-SDK Next runs from a separate checkout, GitHub repository, port, data directory, logs, launcher identity, and worktree root. |
| OPS-002 | accepted | The original PC-SDK remains the dependable daily driver until an explicit migration gate is passed. |
| OPS-003 | accepted | Boot recovery reconciles durable state with runtime, Git, and filesystem evidence and fails uncertain work loudly. |
| OPS-004 | verified | The original repository is configured as fetch-only `upstream`; ordinary and explicit fork pushes target `origin`. |
| OPS-005 | accepted | A data-directory single-instance lock and cross-process repository lease prevent two engines from mutating the same app state or target repository concurrently. |
| OPS-006 | accepted | The local HTTP/WS listener binds only to loopback unless a separately approved remote-access design replaces it. |

SF-001 verification receipt (2026-07-12): the data-directory half of `OPS-005`
is guarded-landed and post-merge verified. Before migrations or listener
activity, production must hold both a non-replaceable kernel IPC witness and a
dedicated zero-wait SQLite write transaction for the canonical data directory.
Cross-process same-directory exclusion, distinct-directory coexistence,
graceful handoff, hard-kill recovery, simultaneous reclaim, path replacement,
filesystem aliases, permission/corruption failure, startup ordering, shutdown
admission gating, and launcher-visible typed failure are guarded.

SF-002 feature verification receipt (2026-07-12): the separate repository half
is complete, guarded-landed, and pushed. Both independent hostile re-reviews,
feature-tree and post-merge `pnpm ci:check`, contract/feature ancestry, and
exact feature/merge tree equality are green. The sealed feature record is
`e3cf861b3f5ffb9fe30ad3d17f328ec1e150d6bc`, landing merge is
`a91bb6c8619672f316109d08719b1afea8a918f4`, and exact tree is
`897142ece8cfa7c27195d7f93f17f4a06e4f78f5`; the code landing was pushed and
re-fetched exactly at that merge before documentation closeout.
Cooperating updated engines use a protocol-stable kernel witness plus
repository-local zero-wait SQLite admission keyed by the native real Git common
directory. Immutable project/run receipts and expected-identity checks cover
Git-backed orchestrator/specialist runtime admission, provision, continuation,
delivery, verification/review, boot recovery, landing, teardown, orphan
cleanup, and recovery while preserving distinct repositories and same-engine
parallel worktrees.

Project creation re-proves `init-empty`, `init-in-place`, or `attach-to-git` at
the mutation door. Initialization claims the future identity, retains a crash-
visible marker, and creates a clean `Initial scaffold` or `Initial import`;
attach requires the selected canonical worktree root and refuses a repository
subdirectory. Ambient `GIT_DIR`, `GIT_WORK_TREE`, and `GIT_COMMON_DIR` are
removed from Git, shell, and provider children. A migrated project without
durable repository identity refuses historical resume and active remint with
typed `repository-identity-unavailable` before preflight or session mutation.
Focused evidence is repository lease 19/19, runtime session selection 17/17,
HTTP contract 12/12, and landing + independent-review + kill-recovery 47/47;
the full server suite is 370/370 and full feature-tree `pnpm ci:check` is green.

`OPS-005` remains `accepted`, not globally `verified`: the preserved working
PC-SDK and unrelated Git/IDE tools do not participate, and a repository child
that survives a hard-killed server is not contained. The manual prohibition on
simultaneous write-capable working-PC-SDK/Next use against one external
repository remains in force. The feature worktree and guarded residue are
removed, two handoff-recorded stale temp roots are removed, and the feature
branch is preserved; these landing receipts do not change the accepted global
status.

## Runtime sessions and selection

| ID | Status | Requirement |
| --- | --- | --- |
| RUN-001 | accepted | The orchestrator and every specialist select an explicit runtime, account, model, and supported effort value. |
| RUN-002 | accepted | Available models and effort levels come from adapter capabilities/discovery, not a universal hardcoded enum. |
| RUN-003 | accepted | Runtime/account/model selection and native session identity are immutably stamped on a PC-SDK session. |
| RUN-004 | accepted | A selection change creates a new PC-SDK session. Native continuation is used only when that adapter positively supports the requested change. |
| RUN-005 | accepted | Cross-runtime continuity is an attributed PC-SDK handoff, never fake native resume. |
| RUN-006 | accepted | The UI states whether a session was natively resumed, started with a handoff, or started clean. |
| RUN-007 | accepted | Unsupported runtime capabilities return typed degradation and never silently fall back to another behavior or billing path. |

RS-001 verification receipt (2026-07-12): the orchestrator path implements the
`RUN-001` through `RUN-004` and `RUN-007` subset with immutable complete
selection, Claude capability/model discovery, exact attempt-correlated native
receipts, stamped remint/resume, and typed browser availability. These rows stay
`accepted`, not globally `verified`, until specialist selection, Codex
conformance, and the remaining cross-runtime behavior satisfy their full text.

RS-003 verification receipt (2026-07-12): every fresh, continued, automatically
continued, revived, and independent-review specialist run now freezes one
complete adapter-validated selection and execution-effective specialist
revision before native execution. Exact create/resume attempt receipts, legacy
quarantine, and safe typed provenance cover the specialist half of `RUN-001`
through `RUN-004`, `RUN-006`, and `RUN-007`. The runtime rows remain `accepted`
until Codex conformance and deliberate selector/handoff behavior satisfy the
remaining global text.

## Context and usage

| ID | Status | Requirement |
| --- | --- | --- |
| CTX-001 | accepted | A per-session context-used bar appears directly above the chat composer. |
| CTX-002 | accepted | Context telemetry carries exact/derived/approximate/unavailable confidence and visibly reports compaction. |
| CTX-003 | accepted | PC-SDK never invents a context percentage when the runtime does not provide enough evidence. |
| USE-001 | accepted | Every quota bar grows as usage is consumed and is labelled as percent used, even when a provider reports percent remaining. |
| USE-002 | accepted | Native observation semantics, window, timestamp, runtime/account attribution, staleness, and confidence remain available behind normalized presentation. |
| USE-003 | accepted | Session context consumption and provider subscription quota are separate concepts and separate UI surfaces. |

RS-002 verification receipt (2026-07-12): the Claude-backed orchestrator path
implements `CTX-001` through `CTX-003` and the context subset of `RUN-007` with
strict context/capability contracts, a positive post-terminal adapter
observation, exact/derived/unavailable confidence, canonical event/outbox
persistence, deterministic stale/compaction replay, and one shared live/history
bar that renders no percentage without fresh available evidence. These rows
remain `accepted`, not globally `verified`, until context conformance covers the
remaining runtimes and specialist execution paths. At that receipt,
subscription quota remained a separate later slice; RS-004 now implements it
without changing context semantics.

RS-004 verification receipt (2026-07-12): the Claude-backed path implements
`USE-001` through `USE-003` with strict provider-neutral source observations,
app-owned used/remaining normalization, exact runtime/account attribution,
durable revisioned current state plus outbox publication, per-window freshness,
and one dynamic rail projection that never invents a percentage. Claude OAuth
used-percent (`0..100`) and passive used-fraction (`0..1`) parsing, credentials,
native status, and the narrowly verified included-plan Fable mapping remain
adapter-local; paid overage stays excluded. Context and per-turn token usage use
separate contracts, persistence, events, and UI. These rows remain `accepted`,
not globally `verified`, until Codex/runtime conformance covers the same quota
and degradation contract.

## Conversation and chat

| ID | Status | Requirement |
| --- | --- | --- |
| CHAT-001 | accepted | User messages, assistant output, safe reasoning status, tool activity, agent activity, asks, queue state, and system notices are distinct canonical event families. |
| CHAT-002 | verified | Server-assigned sequence is authoritative. The browser never orders durable conversation state by timestamp or arrival order. |
| CHAT-003 | verified | Stream items have stable turn/item/stream identities and deterministic delta ordering; one logical response cannot split into orphan bubbles. |
| CHAT-004 | verified | Event persistence and live publication use an outbox/replay discipline so reconnect neither loses nor duplicates committed events. |
| CHAT-005 | verified | Messages sent during an active turn enter a durable, visible FIFO queue with edit/remove rules before delivery. |
| CHAT-006 | verified | “Interrupt and send” requires a positive interruption receipt before the replacement message is delivered. |
| CHAT-007 | verified | The user always receives honest activity feedback while the orchestrator is working or waiting. Operational status must not expose private chain-of-thought. |
| CHAT-008 | verified | Tool calls have requested/approval-needed/running/succeeded/failed states with a stable call ID and safe summary. |
| CHAT-009 | accepted | Agent progress is summarized in chat while full contracts, transcripts, evidence, and landing state live in run views. |

## Orchestration, agents, and contracts

| ID | Status | Requirement |
| --- | --- | --- |
| ORCH-001 | accepted | The orchestrator interprets intent, authors contracts, selects specialists, resolves asks, reviews evidence, and requests deterministic landing. |
| ORCH-002 | accepted | The orchestrator cannot mutate the main checkout, improvise merges, bypass receipts, or treat model prose as proof. |
| AGENT-001 | accepted | A specialist definition is provider-neutral and revisioned: charter, runtime/account/model/effort defaults, tools, MCP, permissions, limits, and output defaults. |
| AGENT-002 | verified | A run snapshots the specialist revision and runtime selection used to execute it. |
| COMM-001 | accepted | Orchestrator-to-agent invoke, continue, answer, cancel, fix, and context messages are durable, ordered, correlated, and idempotent. |
| COMM-002 | accepted | Agent-to-orchestrator asks, approvals, progress, failures, warnings, and deliverables use typed doors rather than unstructured chat scraping. |
| COMM-003 | verified | An ask that pauses work is durably recorded before the run pauses; answering is an atomic idempotent transition. |
| CONT-001 | implemented | No agent starts without a typed expected output and derived acceptance contract that cannot silently verify empty. |
| CONT-002 | implemented | The submitted typed deliverable—not the final chat message—is the authoritative result. |
| CONT-003 | verified | Deterministic verification distinguishes passed, failed, and inconclusive; missing evidence never means pass. |

RS-003 verification receipt (2026-07-12): `AGENT-002` is enforced at the
domain, migration, repository, dispatch, restart, browser, websocket, and MCP
boundaries. DB guards freeze the complete snapshot/selection and parent-derived
continuation scope; exact receipt CAS is the only native identity advancement
door. Hostile mutable-default, race, malformed-response, and legacy-recovery
tests passed.

## Repository delivery

| ID | Status | Requirement |
| --- | --- | --- |
| WT-001 | implemented | Every repository mutation occurs in a recorded run-owned worktree, regardless of task size. |
| WT-002 | accepted | Git, preparation, and readiness receipts exist before a write-capable agent starts. |
| WT-003 | verified | Builders submit a clean sealed commit; PC-SDK independently derives changed paths and Git provenance. |
| WT-004 | accepted | Parallel builds use isolated worktrees; landing is serialized per repository and revalidated against the current base. |
| WT-005 | accepted | Merge success requires positive ancestry proof. Teardown requires proven landing or explicit approved abandonment. |
| WT-006 | accepted | Conflict, failure, cancellation, stranding, and uncertainty preserve the branch and worktree. |

SF-002 feature verification strengthens the cooperative portion of `WT-004`:
one engine-lifetime lease covers the canonical Git common directory while the
existing process-local FIFO serializes landing and stale-base revalidation.
Same-engine worktrees remain parallel and an occupied repository is preserved
without blocking unrelated repositories. Boot and landing require the exact
durable identity, and project creation cannot silently reinterpret init as
attach. `WT-004` stays `accepted` because the broader N4 process-failure gate
and nonparticipant/escaped-child boundaries remain incomplete; SF-002 seal and
landing are complete.

## Integrations, security, and product boundaries

| ID | Status | Requirement |
| --- | --- | --- |
| MCP-001 | accepted | MCP registration, health, secrets, tool cache, and consumer attachment policy are globally app-owned and provider-neutral. |
| MCP-002 | accepted | MCP failure is visible but never blocks unrelated chat or execution. |
| PM-001 | accepted | AInativePM integration follows a read-only joint code/domain/UI investigation before its ownership seam is designed. |
| PM-002 | accepted | AInativePM owns long-lived PM identity, hierarchy, lifecycle, assignment, membership, decisions/context, and content; PC-SDK owns sessions, contracts, execution, verification, worktrees, landing, and technical evidence. Cross-system state is referenced or deep-linked, never mirrored. |
| PM-003 | accepted | PM unavailability degrades visibly and never blocks PC-SDK execution. |
| SEC-001 | accepted | Credentials live in runtime-specific homes or the vault and are excluded from project settings, transcripts, logs, and commits. |
| SEC-002 | accepted | Tool, filesystem, network, external-side-effect, and landing authority are explicit least-privilege policies with attributable approvals. |
| SEC-003 | verified | Runtime and setup subprocess environments are allowlisted or scrubbed so unrelated app secrets such as PM tokens are not inherited. |
| UI-001 | accepted | Preserve the existing visual shell unless a documented behavioral requirement requires a change; boundary rewiring is not a redesign license. |

SEC-003 supersedes SF-002's narrow three-selector scrub with one positive
OS-essential allowlist at direct Git, setup/readiness/verification/cleanup
shell, and provider-runtime children. Unknown names, app/PM variables, raw
provider credentials, Git selectors, and injection controls are absent; the
Claude adapter adds only its exact selected credential home and rejects a
missing/malformed home. Git hooks/filters, shell grandchildren, the pinned
Claude SDK final spawn, explicit MCP stdio attachment semantics, and the sole
trusted same-engine restart exception have deterministic guards. Full
feature-tree `pnpm ci:check` passes with 387/387 server tests and independent
hostile re-review has no remaining P0/P1/P2 finding. Detailed evidence is in
`docs/execution/receipts/SEC-003.md`.

PM-001 discovery receipt (2026-07-12): the joint source/domain/persistence/
UI/REST/MCP/PC-SDK inspection began at AInativePM `5033d5e` and was delta-
revalidated through clean pushed `c146162` after concurrent UI-only landings;
the PC-SDK Next base is `a7c5423`. It disproves the project-only anchor and
proposes separate generic PM context plus exact external item references,
AInativePM-owned management truth, PC-SDK-owned technical truth, read-only
automatic behavior, and receipt-gated future commands. The current PM surface
has no general caller idempotency key, durable queryable mutation receipt,
expected revision, remote-authority/principal fingerprints, or replayable event cursor, so no
automatic PM write is approved. The current permission-bypassed generic MCP
bridge is attribution, not the positive app policy/approval required by
`SEC-002`, so PM-001 authorizes no direct integration write either. The full
evidence is in `docs/research/ainativepm-discovery.md`. The product decision
included whether, after those prerequisites exist, separately
keyed positive verification and positive landing receipts may each
automatically append an immutable deduplicated evidence link while every PM
management-state transition stays suggested or explicit.

PM-001 product receipt (2026-07-12): the product owner accepted the reference-
first seam, its dependency order, and the future separately keyed immutable
verification/landing evidence-link policy. This acceptance does not authorize a
current PM write or mark `PM-002`/`PM-003` implemented. `PM-001` remains
`accepted` rather than `verified` only because the live `get_started` remote-
unchanged receipt below is inconclusive.

One live `get_started` orientation call was made before source review exposed
its first-run seeding hook. The five root domains were observed only after the
hook ran; without a pre-call snapshot or private-data inspection, no-op versus
marker stamp versus default-domain creation is inconclusive. It does not affect
the ownership result, but the remote-unchanged acceptance item is not claimed.

BC-002 browser receipt (2026-07-12): isolated production-bundle browser
characterization at preserved `e233aa54` and current base `36ac71c` found no
unclassified Next regression in the inspected `1440x900`, `760x720`, and
targeted `480x720` states. Seven core shell blobs and measured geometry match;
the deterministic current fixture directly exercised project/session
isolation, queued-send edit/remove, confirmed interruption, safe canonical
projection, context/quota provenance, reload equivalence, and two-tab
convergence. Four hashed captures and the evidence-kind matrix are in
`docs/research/browser-baseline.md`. This is point-in-time rendered-projection
evidence, not end-to-end verification of every referenced durable invariant, so
all requirement-table statuses remain unchanged. In particular, `UI-001`
remains `accepted`; shell-source parity and inspected geometry do not establish
a permanent global visual-verification gate.
