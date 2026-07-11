# Architecture boundaries

Status: target component map. PC-SDK Next is one process and one database, not
one undifferentiated application.

## Dependency rule

A component may consume another component's published commands, queries, DTOs,
and events. It may not import the other component's implementation, manipulate
its tables, or reproduce its state machine. Provider-native vocabulary stops at
runtime adapters. Browser vocabulary stops at the browser contract mapper.

```text
Browser UI
  -> canonical HTTP/WS contracts
Application components
  -> domain commands, queries, and events
Domain policy
  -> ports
Runtime / Git / DB / MCP / PM adapters
```

## Component catalog

| Component | Owns | Does not own | Published seam |
| --- | --- | --- | --- |
| Projects | Project identity, repository association, project defaults | Git mutation, runtime sessions | Project commands/queries and project-changed events |
| Conversations | Durable messages, server sequence, replay cursor, send queue | Native runtime threads, agent contracts | Conversation commands and canonical conversation events |
| Runtime sessions | Immutable runtime/account/model/effort stamp, native session ID, resume/handoff provenance | Conversation rendering, contracts | Create/resume/end/switch session operations |
| Turns | One active exchange, interruption, stream items, exactly one terminal outcome | Long-lived conversation or quota policy | Start/interrupt/observe turn operations and turn events |
| Runtime registry | Adapter registration, capability/model discovery, adapter selection at composition | Product policy | `AgentRuntimeAdapter` and capability descriptors |
| Orchestration | Intent, delegation, contract authorship, ask resolution, review request | Git mutation and provider parsing | Orchestrator application service and tools |
| Specialists | Revisioned charters, defaults, tools, MCP attachments, permissions | Live run state | Specialist commands/queries and specialist-changed events |
| Agent runs | Dispatch/continue/pause/kill/terminal lifecycle and stamped execution selection | Contract verification, worktree mechanics | Run commands/queries and run events |
| Communications | Durable agent/orchestrator mailbox, asks, approvals, delivery/idempotency | Chat rendering | Typed message/ask commands and delivery events |
| Contracts | Expected output, acceptance criteria, scope, policy, deliverable | Running checks or Git inspection | Contract commands/queries and contract-changed events |
| Verification | Deterministic evidence collection and passed/failed/inconclusive verdict | Model confidence, merge mutation | Verification request and immutable receipt |
| Workspaces | Worktree provision, prepare, readiness, lease, reconciliation | Review decision and merge authority | Workspace lifecycle service and receipts |
| Landing | Per-repository queue, current-base validation, merge, ancestry proof, teardown | Agent execution | Landing commands and merge/teardown receipts |
| MCP registry | Servers, vault refs, health, tool cache, attachment policy | Provider-native delivery details | Registry queries/events and adapter-ready attachment package |
| PM integration | Translation between external PM references/events and PC-SDK execution | AInativePM's domain model | PM port with idempotent commands and typed degraded state |
| Usage/context | Provider observations, normalization, confidence, staleness | Runtime routing decisions unless policy explicitly consumes it | Usage/context snapshots and events |
| Resources | Attachments, artifacts, diffs, retention and access policy | General file browsing | Resource commands and references |
| Notifications | Durable attention state and one-shot delivery policy | Run or contract truth | Attention commands/events and delivery receipts |
| Persistence/recovery | Transactions, migrations, outbox, boot reconciliation coordination | Component-specific transition rules | Repositories/units of work and recovery coordinator |
| Security/audit | Policy evaluation, secret references, approval and actor provenance | Business outcomes | Authorization decisions and audit events |
| Launcher/operations | Instance identity, port/data/log paths, health startup, shutdown | Product session state | Process health and launch contract |

## Cross-boundary rules

1. A durable state transition and its outbox event commit together.
2. Browser replay and live delivery project the same canonical event.
3. Only the owning component performs a state transition; consumers request it.
4. Unknown, missing, stale, and unsupported are explicit states.
5. Timeouts produce typed failure or uncertainty, never inferred success.
6. External systems degrade independently.
7. Every write is attributable to user, orchestrator, specialist, reviewer, or deterministic service.

## Primary end-to-end flows

```text
User -> Conversation -> Turn -> Runtime adapter -> canonical events -> Conversation -> UI

Orchestrator -> Contract -> Workspace ready -> Agent run -> Deliverable
             -> Verification -> Review policy -> Landing -> Teardown

Agent -> durable ask -> Run paused -> Orchestrator/user answer
      -> stamped runtime session resumed -> Agent continues
```

