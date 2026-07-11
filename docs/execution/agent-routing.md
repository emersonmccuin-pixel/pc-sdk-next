# Agent routing and parallel work

The root Codex agent is the session orchestrator. It selects agents dynamically
from the work slice, while the repository—not an agent's memory—holds durable
state.

## Selection axes

Before delegation, classify the work by:

- read-only or write-capable;
- known path or discovery required;
- boundaries touched and shared contracts affected;
- correctness, security, migration, provider, and UI risk;
- independent parallelism and likely file overlap;
- required proof: tests, browser evidence, external docs, or Git receipts.

## Default roles

| Need | Role | Default authority |
| --- | --- | --- |
| Locate code paths and current behavior | Explorer | Read-only |
| Propose a seam or state machine | Architect | Read-only; proposal only |
| Challenge assumptions and missing failure modes | Adversarial reviewer | Read-only |
| Implement one bounded contract | Implementer | One recorded worktree |
| Validate tests, receipts, and acceptance criteria | Verifier | Read-only against sealed commit |
| Reproduce and verify browser behavior | Browser verifier | Product interaction; no code edits |
| Inspect permissions, secrets, and threat paths | Security reviewer | Read-only |
| Verify provider/API behavior | Runtime/docs researcher | Read-only, primary sources |
| Map AInativePM ownership and integration | PM investigator | Read-only across both repos |

Project-scoped custom-agent files should be introduced only after a role repeats
enough to justify stable instructions. A role name does not grant authority;
the per-dispatch contract and sandbox do.

## Parallelism rules

Parallelize evidence gathering, independent reviews, tests, and disjoint changes
in separate worktrees. Serialize shared event/schema changes, architecture
decisions, migrations, integration, and landing. Two agents never edit the same
worktree concurrently unless a slice explicitly proves that arrangement safe.

The root agent retains responsibility for user intent, final architecture
synthesis, resolving conflicting findings, acceptance, and landing.

## Delegation contract

Every delegated task states:

```text
objective
input context and dependencies
read/write authority and worktree, if any
in-scope and forbidden paths
expected evidence/output shape
verification commands
time/turn bound
how to report uncertainty
```

An agent is not added merely because a slot is available. Delegation should
improve speed, evidence quality, or context hygiene enough to justify its quota.

