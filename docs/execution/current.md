# Current execution handoff

Updated: 2026-07-11 after CF-001 approval and provisioning.

## Repository

- Main checkout: `E:\Claude Code Projects\Personal\PC-SDK-Next`
- Base branch: `main`
- BC-001 base: `c3c9480416542cce4d42ad3b8d469887b45c1dfa`
- BC-001 landing merge: `fd0756a3c39640d91bcb20cfe4a9fe22cb7d2380`
- Evidence: `docs/research/baseline-characterization.md`
- Active slice: `docs/execution/slices/CF-001.md`
- Active branch/worktree: `codex/cf-001-conversation-foundation` at
  `E:\Claude Code Projects\Personal\PC-SDK-Next-cf-001`

## Status

CF-001 is in progress. Its read-only DB, contract/server, and browser/test lanes
map the coordinated migration; root owns the serialized schema, shared
contract, producer, persistence, consumer, verification, and landing changes.

## Next safe action

Implement and verify `CF-001` exactly as bounded in its slice. Do not widen into
durable send queues, runtime selection, or the Codex adapter.

## Startup checks

```text
git status --short --branch
git worktree list --porcelain
git remote -v
git log --oneline --decorate -8
```

Read `AGENTS.md`, `docs/master-plan.md`, `docs/current-state.md`, CF-001, the
BC-001 evidence, and the named boundary documents before continuing.

## Known blockers

No implementation blocker. The user delegated routine product/engineering
direction and approved the recommended BC-001 defaults; escalate only a
material product choice. The Next shortcut code is isolated but has not been
installed; regular daily driving remains on the original PC-SDK until the
migration gate.
