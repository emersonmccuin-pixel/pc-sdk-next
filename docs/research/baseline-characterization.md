# PC-SDK Next baseline characterization

Status: BC-001 evidence rebaselined through BC-002, 2026-07-12.

The component map below records the implementation at BC-001 base
`c3c9480416542cce4d42ad3b8d469887b45c1dfa`. The disposition sections then
reconcile that snapshot through CF-001 to CF-004, RS-001 to RS-004, PM-001, and
the BC-002 browser evidence from clean pushed base `36ac71c59bb1d4095e30c9e2e4ed4d8ef73c9fd1`.
Target ownership remains in `docs/architecture/boundaries.md`; this evidence
does not create new architecture or promote global requirement statuses by
observation alone.

## Executive result

BC-001 found strong contract, verification, worktree, landing, ask, and recovery
mechanics but incomplete conversation/runtime seams. CF-001 through CF-004 have
since landed the canonical transactional conversation/outbox projection,
durable queue/control receipts, and safe activity/tool/agent families. RS-001
through RS-004 have landed immutable orchestrator and specialist selection,
honest context, and provider-neutral subscription quota on the Claude path.

BC-002 proves in real production bundles that these accepted behavior changes
remain inside the preserved shell: seven core shell blobs are identical,
desktop/narrow geometry matches, exercised reload and two-tab projections
converge, and no unclassified N1 regression remains. The remaining critical
work is dependency-ordered N4 delivery/process hardening, followed by N5 Codex
parity and later N6/N7 integration and daily-driver gates.

## BC-001 historical component and data map

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

## BC-001 accepted-requirement evidence corrections

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

Those corrections were point-in-time BC-001 promotions. Later slices supply
additional implementation and verification receipts without making this
research document the status authority:

- CF-001/CF-002 close the canonical sequence/outbox/live-replay and ordered
  browser-projection gaps identified under `ARCH-003` and `CHAT-002`.
- CF-003 closes the process-memory queue/control gap under `CHAT-005` and adds
  durable FIFO revisions plus positive interrupt receipts.
- CF-004 closes the unrestricted-thinking/tool-payload presentation gap with
  safe typed activity, tool, ask, approval, and agent projections.
- RS-001 closes immutable orchestrator selection and fail-closed native
  continuation on the Claude path; RS-003 does the same for specialist revision
  and run selection. RS-002/RS-004 add honest context and quota contracts.
- Explicit no-op readiness, approved abandonment, remaining repository-phase
  recovery, cross-process repository exclusion, and child-environment
  isolation remain N4 gaps under `WT-002`, `WT-004` through `WT-006`,
  `OPS-005`, and `SEC-003`.
- Codex adapter conformance and peer-runtime parity remain N5. No Claude-path
  evidence silently proves the Codex half.

## Characterization and guard-test backlog reconciliation

| BC-001 item | Disposition through BC-002 | Named current evidence |
| --- | --- | --- |
| Restart with an active turn/queued sends; duplicate client message; multi-tab ordering; session switch during delivery | **Closed on current path.** CF-003 owns durable restart/idempotency/control; BC-002 directly covers edit/remove, project/session isolation, reload, and two-tab convergence. | `packages/db/test/send-queue.test.ts`; `apps/server/test/conversation-control.test.ts`; `apps/server/test/kill-recovery.test.ts`; `apps/web/test/ws-client.test.ts` |
| Live/replay equivalence; insert/broadcast crash; reconnect deltas; conflicting/reordered sequence | **Closed.** CF-001/CF-002 own transactional persistence/projection; BC-002 adds a direct reload/two-tab case. | `packages/db/test/conversation-events.test.ts`; `packages/db/test/live-outbox.test.ts`; `apps/server/test/conversation-relay.test.ts`; `apps/web/test/chat-store.test.ts` |
| Positive interrupt success/failure/timeout receipts | **Closed.** BC-002 directly observes confirmed interruption; negative variants remain guard-backed. | `packages/db/test/send-queue.test.ts`; `apps/server/test/conversation-control.test.ts`; `apps/server/test/session-service.test.ts` |
| Safe activity and no private reasoning | **Closed.** CF-004 owns safe canonical projections; BC-002 observes only safe summaries. | `apps/server/test/sdk-import-guard.test.ts`; `apps/server/test/sdk-tool-mapping.test.ts`; `apps/web/test/chat-render.test.ts` |
| Immutable orchestrator selection/resume | **Split/closed for the Claude orchestrator path.** RS-001 includes fail-closed legacy state; Codex/handoff remains N5. | `packages/db/test/runtime-session-selection.test.ts`; `apps/server/test/runtime-session-selection.test.ts`; `apps/web/test/sessions.test.ts` |
| Adapter conformance | **Partial.** Claude capability/selection/context/quota guards exist; peer Codex remains N5. | `packages/contracts/test/runtime.test.ts`; `apps/server/test/runtime-registry.test.ts`; `apps/server/test/claude-adapter-runtime.test.ts`; `apps/server/test/claude-adapter-quota.test.ts` |
| Immutable specialist revision/run selection | **Closed.** RS-003 owns immutable specialist/run stamps; BC-002 observes transcript provenance. | `packages/db/test/specialist-execution-stamps.test.ts`; `apps/server/test/dispatch-guards.test.ts`; `apps/web/test/agent-transcript.test.ts` |
| Least-privilege environment canaries | **Open N4 `SEC-003`.** | `apps/server/src/runner/account-env.ts`; `apps/server/test/account-env.test.ts` covers only the current narrow scrub. |
| Two server processes contending for one repository | **Open N4 `OPS-005`/`WT-004`;** locks remain process-local. | `apps/server/src/dispatch/service.ts`; `apps/server/test/landing-guards.test.ts` lacks the cross-process proof. |
| Crash/restart across pre-attach and repository phases | **Partial.** Conversation/control and several repository phases are guarded; residual readiness/recovery UI remains N4. | `apps/server/test/kill-recovery.test.ts`; `apps/server/test/worktree-profile.test.ts`; `apps/server/test/landing-guards.test.ts` |
| Explicit no-op readiness and authorized abandonment | **Open N4 `WT-002`/`WT-005`/`WT-006`.** | `apps/server/src/dispatch/worktrees.ts`; `apps/server/test/worktree-profile.test.ts` does not cover the missing positive receipts. |

## Dependency-ordered migration disposition

1. **N2 conversation foundation: complete.** CF-001 through CF-004 landed the
   canonical identity/outbox/replay, durable control, and safe projection work.
2. **N3 Claude-path runtime/session/context/quota contracts: complete.** RS-001
   through RS-004 landed immutable selection, specialist snapshots, context,
   and provider-neutral quota semantics.
3. **N4 delivery and process hardening: next.** Complete data-directory
   ownership, cross-process repository exclusion, least-privilege child
   environments, readiness/recovery receipts, and approved abandonment.
4. **N5 Codex spike and adapter: ordered after N4's shared safety invariants.**
   Validate the pinned app-server schema/subscription path, then run the same
   conformance and real-delivery gates.
5. **N6/N7 integration and promotion:** implement only the accepted PM/MCP seam,
   then complete loopback/process, operational, accessibility, and daily-driver
   promotion gates.

## Decision dispositions

1. Historical private thinking is retained only as legacy data and never
   projected; no new private-reasoning writes are accepted. CF-004 implements
   the safe replacement.
2. Legacy sessions/runs without immutable selection fail closed for native
   continuation. RS-001/RS-003 implement that decision.
3. Empty preparation/readiness profiles still require an explicit positive
   no-op receipt; N4 owns the implementation.
4. Specialist permissions remain an explicit N4/N6 policy checkpoint. Existing
   bypass behavior is not treated as satisfying `SEC-002`.

## Verification baseline

After worktree-local dependency preparation, `pnpm ci:check` passed: all
workspace typechecks, all tests (including 179 server tests), and the
dead-import guard.

BC-002 adds pinned preserved/current production builds, real-browser desktop/
narrow/stress measurements, four hashed captures, exact core-shell blob parity,
direct queue/interrupt/reload/two-tab evidence, and positive disposable-process/
data/worktree cleanup. Its final `pnpm ci:check`, hostile review, and guarded
landing are recorded in `docs/execution/receipts/BC-002.md` rather than inferred
from this research summary.
