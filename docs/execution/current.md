# Current execution handoff

Updated: 2026-07-11 after CF-002 provisioning.

## Repository

- Main checkout: `E:\Claude Code Projects\Personal\PC-SDK-Next`
- Base branch: `main`
- BC-001 base: `c3c9480416542cce4d42ad3b8d469887b45c1dfa`
- BC-001 landing merge: `fd0756a3c39640d91bcb20cfe4a9fe22cb7d2380`
- Evidence: `docs/research/baseline-characterization.md`
- CF-001 slice: `docs/execution/slices/CF-001.md`
- CF-001 landing merge: `6ea518bc6b520934aece30cbea94d201f4334b0b`
- CF-001 feature worktree: removed after positive landing proof
- Sealed implementation commit:
  `35b49d3a012abfb3ec1b439060b1046f95887e19`
- Active slice: `docs/execution/slices/CF-002.md`
- Active branch/worktree: `codex/cf-002-projector-scale` at
  `E:\Claude Code Projects\Personal\PC-SDK-Next-cf-002`
- CF-002 base: `57be70f63e6e449afff27e5039aa5f0b81f042e9`

## Status

CF-001 is landed, pushed, and torn down. CF-002 is provisioned to remove the
correct projector's identified long-session O(n²) behavior without changing
the canonical wire or persistence contract. Two read-only design/test lanes are
active; root is the sole writer.

## Next safe action

Implement and verify CF-002 exactly as bounded: indexed ordered projection,
completed-stream compaction, deterministic scale/immutability evidence, and no
wire/server/database changes. Then seal, land, prove, teardown, and push.

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

No blocker. The Next shortcut code is isolated but has not been installed;
regular daily driving remains on the original PC-SDK until the migration gate.
