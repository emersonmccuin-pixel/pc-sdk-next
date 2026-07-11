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

## Context and usage

| ID | Status | Requirement |
| --- | --- | --- |
| CTX-001 | accepted | A per-session context-used bar appears directly above the chat composer. |
| CTX-002 | accepted | Context telemetry carries exact/derived/approximate/unavailable confidence and visibly reports compaction. |
| CTX-003 | accepted | PC-SDK never invents a context percentage when the runtime does not provide enough evidence. |
| USE-001 | accepted | Every quota bar grows as usage is consumed and is labelled as percent used, even when a provider reports percent remaining. |
| USE-002 | accepted | Native observation semantics, window, timestamp, runtime/account attribution, staleness, and confidence remain available behind normalized presentation. |
| USE-003 | accepted | Session context consumption and provider subscription quota are separate concepts and separate UI surfaces. |

## Conversation and chat

| ID | Status | Requirement |
| --- | --- | --- |
| CHAT-001 | accepted | User messages, assistant output, safe reasoning status, tool activity, agent activity, asks, queue state, and system notices are distinct canonical event families. |
| CHAT-002 | accepted | Server-assigned sequence is authoritative. The browser never orders durable conversation state by timestamp or arrival order. |
| CHAT-003 | accepted | Stream items have stable turn/item/stream identities and deterministic delta ordering; one logical response cannot split into orphan bubbles. |
| CHAT-004 | accepted | Event persistence and live publication use an outbox/replay discipline so reconnect neither loses nor duplicates committed events. |
| CHAT-005 | accepted | Messages sent during an active turn enter a durable, visible FIFO queue with edit/remove rules before delivery. |
| CHAT-006 | accepted | “Interrupt and send” requires a positive interruption receipt before the replacement message is delivered. |
| CHAT-007 | accepted | The user always receives honest activity feedback while the orchestrator is working or waiting. Operational status must not expose private chain-of-thought. |
| CHAT-008 | accepted | Tool calls have requested/approval-needed/running/succeeded/failed states with a stable call ID and safe summary. |
| CHAT-009 | accepted | Agent progress is summarized in chat while full contracts, transcripts, evidence, and landing state live in run views. |

## Orchestration, agents, and contracts

| ID | Status | Requirement |
| --- | --- | --- |
| ORCH-001 | accepted | The orchestrator interprets intent, authors contracts, selects specialists, resolves asks, reviews evidence, and requests deterministic landing. |
| ORCH-002 | accepted | The orchestrator cannot mutate the main checkout, improvise merges, bypass receipts, or treat model prose as proof. |
| AGENT-001 | accepted | A specialist definition is provider-neutral and revisioned: charter, runtime/account/model/effort defaults, tools, MCP, permissions, limits, and output defaults. |
| AGENT-002 | accepted | A run snapshots the specialist revision and runtime selection used to execute it. |
| COMM-001 | accepted | Orchestrator-to-agent invoke, continue, answer, cancel, fix, and context messages are durable, ordered, correlated, and idempotent. |
| COMM-002 | accepted | Agent-to-orchestrator asks, approvals, progress, failures, warnings, and deliverables use typed doors rather than unstructured chat scraping. |
| COMM-003 | accepted | An ask that pauses work is durably recorded before the run pauses; answering is an atomic idempotent transition. |
| CONT-001 | implemented | No agent starts without a typed expected output and derived acceptance contract that cannot silently verify empty. |
| CONT-002 | implemented | The submitted typed deliverable—not the final chat message—is the authoritative result. |
| CONT-003 | accepted | Deterministic verification distinguishes passed, failed, and inconclusive; missing evidence never means pass. |

## Repository delivery

| ID | Status | Requirement |
| --- | --- | --- |
| WT-001 | implemented | Every repository mutation occurs in a recorded run-owned worktree, regardless of task size. |
| WT-002 | accepted | Git, preparation, and readiness receipts exist before a write-capable agent starts. |
| WT-003 | accepted | Builders submit a clean sealed commit; PC-SDK independently derives changed paths and Git provenance. |
| WT-004 | accepted | Parallel builds use isolated worktrees; landing is serialized per repository and revalidated against the current base. |
| WT-005 | accepted | Merge success requires positive ancestry proof. Teardown requires proven landing or explicit approved abandonment. |
| WT-006 | accepted | Conflict, failure, cancellation, stranding, and uncertainty preserve the branch and worktree. |

## Integrations, security, and product boundaries

| ID | Status | Requirement |
| --- | --- | --- |
| MCP-001 | accepted | MCP registration, health, secrets, tool cache, and consumer attachment policy are globally app-owned and provider-neutral. |
| MCP-002 | accepted | MCP failure is visible but never blocks unrelated chat or execution. |
| PM-001 | accepted | AInativePM integration follows a read-only joint code/domain/UI investigation before its ownership seam is designed. |
| PM-002 | accepted | AInativePM owns long-lived intent and management concepts; PC-SDK owns technical execution evidence. Exact mappings remain open pending investigation. |
| PM-003 | accepted | PM unavailability degrades visibly and never blocks PC-SDK execution. |
| SEC-001 | accepted | Credentials live in runtime-specific homes or the vault and are excluded from project settings, transcripts, logs, and commits. |
| SEC-002 | accepted | Tool, filesystem, network, external-side-effect, and landing authority are explicit least-privilege policies with attributable approvals. |
| SEC-003 | accepted | Runtime and setup subprocess environments are allowlisted or scrubbed so unrelated app secrets such as PM tokens are not inherited. |
| UI-001 | accepted | Preserve the existing visual shell unless a documented behavioral requirement requires a change; boundary rewiring is not a redesign license. |
