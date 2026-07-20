# ADR-0003: Codex sandbox, not custom native containment

Status: accepted, 2026-07-20.

## Context

CX-004 built custom native Windows process containment (Job Objects, a
transient bootstrap PE, a C++ Node-API full-spawn addon, typed native-resource
ownership) toward ADR-0002's safety boundary. After 6 days it had landed 3 of
11 planned steps with no product integration and no path to Codex actually
running. The product owner descoped it.

## Decision

Supersede ADR-0002. Codex native execution relies on Codex's own built-in
sandbox, per-agent isolated git worktrees, a read-only main working copy, and
guarded serialized merges (`docs/worktree-lifecycle.md`). No custom native
containment package is built or maintained.

## Consequences

- Weaker isolation than ADR-0002 promised. Accepted for a personal machine.
- CX-004 artifacts (`packages/windows-containment`) are removed; recoverable
  from git history if reconsidered.
- N5 is unblocked.
