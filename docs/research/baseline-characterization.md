# PC-SDK Next baseline characterization

Status: reviewed implementation evidence for BC-001, 2026-07-11.

This document describes the implementation as it exists at base
`c3c9480416542cce4d42ad3b8d469887b45c1dfa`. Target ownership remains in
`docs/architecture/boundaries.md`; differences below are migration inputs, not
new architecture.

## Executive result

The baseline has strong contract, verification, worktree, landing, ask, and
recovery mechanics, but the seams are not yet the target modular monolith.
`DispatchService` currently coordinates and owns much of orchestration, agent
runs, verification, review, landing, teardown, and recovery. Conversation state
has durable ordered events, but live delivery has no transactional outbox and
the user send queue is process memory. The Claude adapter is isolated at the
package-import boundary, while canonical runtime/session vocabulary and durable
session stamps remain Claude/provider-shaped.

No behavior or schema was changed by BC-001.

## As-built component and data map

| Target concern | As-built owner | Durable data | Characterization |
| --- | --- | --- | --- |
| Projects | project repo and HTTP services | `projects` | Project settings also select the current Claude account; selection is not a session-owned immutable stamp. |
| Conversations | `SessionService`, conversation repo, browser chat reducer | `conversation_events` | Per-session `seq` is durable and replay is ordered. Events are opaque JSON with `sdk_uuid`; insert is followed by direct broadcast, not a transactional chat outbox. |
| Runtime sessions | `SessionService`, runtime registry, Claude adapter | `orchestrator_sessions` | Rows store provider/native ID/model, but not runtime/account/effort/provenance. Reactivation can reuse a native ID with the current project account. |
| Turns | `SendQueue`, `TurnRunner`, runtime session | session status plus events | One in-process queue serializes turns. Queue state, edits, removal, idempotency, and interrupt receipts are not durable contracts. |
| Runtime registry | `apps/server/src/runner/runtime.ts` and composition in `index.ts` | none | Adapter create/resume exists; capabilities, model discovery, effort validation, and typed unsupported results do not. Composition is fixed to Claude. |
| Specialists | agent repos and HTTP services | `agents`, `agent_projects`, `agent_mcp_attachments`, `agent_audit` | Mutable definitions have prompt/tools/model/effort/limits, but no runtime/account defaults or immutable revision snapshot. Revision is a hash. |
| Agent runs | `DispatchService` plus `AgentRunMutationGateway` | `agent_runs` | Lifecycle and partial runtime/account/model stamp are durable. Effort and provider-neutral native-session identity are absent. |
| Communications | run gateway, pending asks, mailbox service, conversation envelope injection | `pending_asks`, mailbox tables | Pausing asks and answers are atomic and verified. Other orchestration envelopes can wait in an in-memory pre-attach array; mailbox delivery to the orchestrator is incomplete. |
| Contracts | `ContractService` and `DispatchService` | `agent_contracts` | Expected output, criteria, authoritative deliverable, verification, review, landing, and merge facts currently share one aggregate. |
| Verification | dispatch verifier | fields on `agent_contracts` | Passed, failed, and pending/inconclusive are explicit and auto-land fails closed. |
| Workspaces | worktree helpers and dispatch | `worktrees`, receipts on `agent_runs` | Provision/prepare/readiness and preservation behavior exist. Empty setup/readiness profiles do not persist explicit no-op phase receipts. |
| Landing | worktree helpers and dispatch | landing fields on `agent_contracts` | Guarded merge and ancestry proof are verified. Serialization is an instance-local promise map, not a cross-process lease/queue. |
| Persistence/recovery | DB repos, boot recovery, dispatch recovery | component tables and `live_outbox` | Agent/contract facts have transactional outbox paths. Chat does not. Recovery is broad and tested, but component transition ownership remains concentrated. |
| Security/audit | account environment helper, credentials repo, audit tables | `credentials`, audit tables | Claude API shadow variables are scrubbed. Runtime and repository subprocesses otherwise inherit the broad server environment; specialists use bypass permissions. |
| Usage/context | Claude usage poller/cache and web stores | snapshots only | Quota presentation uses consumed percentage, but observations are Claude-shaped and lack runtime/source/confidence/staleness semantics. No honest session-context contract exists. |

Primary evidence: `packages/db/src/schema.ts`,
`packages/db/src/schema-agent-system.ts`,
`apps/server/src/chat/session-service.ts`,
`apps/server/src/chat/send-queue.ts`,
`apps/server/src/runner/runtime.ts`,
`apps/server/src/runner/claude-adapter.ts`,
`apps/server/src/dispatch/service.ts`, and
`apps/server/src/dispatch/worktrees.ts`.

## Accepted requirements: evidence corrections

BC-001 promotes only requirements whose complete stated behavior has direct
implementation and test evidence:

- `COMM-003` is verified. Ask creation plus run pause is transactional, and
  answer plus run transition is atomic/idempotent in
  `packages/app-services/src/agent-runs/run-gateway.ts`; gateway and restart
  tests cover the invariant.
- `CONT-003` is verified. `apps/server/src/dispatch/verification.ts`
  distinguishes pass, fail, and pending/inconclusive, and auto-land fails
  closed; dispatch verification tests cover missing and inconclusive evidence.
- `WT-003` is verified. Sealing rejects dirty/unreadable/mismatched Git state,
  and landing independently derives and rechecks branch-tip provenance;
  `apps/server/test/landing-guards.test.ts` covers the guards.

All runtime and chat requirements remain `accepted`. Notable partial work must
not be mistaken for end-to-end implementation:

- `ARCH-003`: only the Claude SDK import boundary is guarded; `sdkUuid`,
  `sdkSessionId`, provider IDs, Claude session IDs, and native event details
  still cross canonical, persistence, or browser seams.
- `CHAT-002`: durable events and the browser use server sequence, but sequence
  allocation is process-local and lacks a transactional outbox path.
- `CHAT-005`: visible FIFO behavior exists only in process memory.
- `RUN-003` and `AGENT-002`: agent runs have a partial nullable stamp;
  orchestrator sessions and specialist revisions do not meet the immutable full
  selection/snapshot contract.
- `WT-002`, `WT-005`, and `WT-006`: substantial guarded behavior is live, but
  explicit no-op readiness receipts and approved abandonment remain gaps.
- `WT-004` and `OPS-005`: isolated builds exist, but landing exclusion is
  process-local and there is no cross-process repository lease.
- `SEC-003`: not met. Environment construction copies `process.env` and scrubs
  only two Anthropic variables.

## Characterization and guard-test backlog

Highest-value tests before or with the owning migration:

1. Restart with an active turn and queued sends; duplicate `clientMessageId`;
   multi-tab ordering; session switch during delivery.
2. Live/replay equivalence across the insert-to-broadcast crash window and
   reconnect during deltas; duplicate/conflicting sequence and reordered delta
   handling.
3. Positive interrupt success/failure/timeout receipts, with replacement send
   blocked until confirmation.
4. A safe-activity guard proving provider thinking/private reasoning never
   enters canonical persistence or presentation.
5. Immutable orchestrator runtime selection and resume routing after account,
   model, or effort changes; legacy rows must not silently acquire defaults.
6. Adapter conformance for capabilities, discovery, typed unsupported states,
   terminal outcomes, concurrent-send rejection, resume provenance, interrupt,
   and disposal.
7. Immutable specialist revision reconstruction after edit/delete/restart,
   including effort and the complete runtime selection.
8. Environment canaries proving PM, GitHub, cloud, vault, and unrelated secrets
   do not reach runtime, setup, readiness, verification, or Git subprocesses.
9. Two independent server processes contending to land into one repository.
10. Crash/restart during pre-attach agent-envelope delivery, each recovery
    phase, and preparation/readiness subprocess execution.
11. Explicit positive no-op readiness receipts and authorized-abandonment
    teardown guards.

## Dependency-ordered N2-N5 slices

These are planning candidates, not approved behavior-changing slices.

1. **N2 canonical conversation identity and persistence:** define event
   families and adapter-neutral turn/item/stream identities; add transactional
   DB sequence and chat outbox; migrate producer, store, replay, browser, and
   tests in one pass.
2. **N2 durable send/control state:** persist idempotent FIFO entries and
   revisions bound to immutable session/turn IDs; add edit/remove and positive
   interrupt receipts; rebuild queue UI projection.
3. **N2 safe activity and tool/agent projections:** replace unrestricted
   thinking with operational activity; add typed tool lifecycle and durable
   agent-card projections.
4. **N3 runtime capability and immutable session selection:** add capability,
   model/effort discovery, receipts, full orchestrator stamps, resume routing,
   selection-change session boundaries, and visible provenance.
5. **N3 context/usage/account normalization:** key observations by runtime and
   account and retain source semantics, confidence, window, staleness, and
   explicit unavailable/compacted context.
6. **N4 specialist/communication/security hardening:** immutable specialist
   revisions and run selections, mailbox-backed orchestration traffic,
   least-privilege child environments/permissions, cross-process repository
   lease, and remaining recovery/abandonment receipts.
7. **N5 Codex spike and adapter:** only after the canonical contract and Claude
   conformance pass; validate the pinned app-server schema and subscription
   path, then run the same conformance and real-delivery gates.

## Decisions required before the first behavior change

1. Historical `thinking` rows: retain but hide as legacy data, or redact them.
   The recommended default is retain-but-never-project, with no new writes.
2. Legacy sessions/runs missing immutable selection: mark native resume
   unavailable and start clean/attributed handoff, or approve explicit
   assumptions. The fail-closed recommendation is non-resumable legacy state.
3. Empty preparation/readiness profiles: require explicit positive no-op
   receipts. This is recommended so absence never means success.
4. Specialist permissions: decide whether headless `bypassPermissions` can be
   retained behind an explicit app policy or must move to runtime approvals.

## Verification baseline

After worktree-local dependency preparation, `pnpm ci:check` passed: all
workspace typechecks, all tests (including 179 server tests), and the
dead-import guard.
