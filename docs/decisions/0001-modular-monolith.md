# ADR-0001: Modular monolith with enforced seams

Status: accepted, 2026-07-11.

## Context

PC-SDK must remain easy to launch and recover on one personal Windows machine,
while its chat, runtimes, agents, contracts, worktrees, integrations, and UI
must be independently improvable. A single undifferentiated server would make
changes risky; multiple deployable services would add operational failure modes
without product value.

## Decision

Keep one browser application, one local server process, and one SQLite database.
Divide the server into components listed in `docs/architecture/boundaries.md`.
Each component owns its state and transitions and publishes narrow typed seams.
Database transactions may span tables only through an explicit application
unit-of-work; shared database access is not permission to bypass ownership.

Provider, Git, MCP, and PM implementations are adapters behind app-owned ports.
Contract tests enforce seams and guard tests enforce cross-cutting invariants.

## Consequences

- Local operation and boot recovery stay simple.
- Components can be replaced incrementally without network-service overhead.
- Dependency rules require deliberate enforcement in imports and repositories.
- Some cross-component operations need explicit coordinators rather than direct
  table writes.

