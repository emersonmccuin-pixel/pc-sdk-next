# PC-SDK Next pickup protocol

This protocol overrides generic pickup workflows that assume a `dev` branch or
permit edits in the main checkout.

## Invocation

Use:

```text
pickup PC-SDK-Next docs/execution/current.md
```

## Startup

1. Confirm the repository is `PC-SDK-Next`, not the working `PC-SDK` checkout.
2. Read `AGENTS.md`, `docs/master-plan.md`, `docs/current-state.md`, and
   `docs/execution/current.md` fully.
3. Read the active slice and every architecture/decision document it names.
4. Run `git status --short --branch`, `git worktree list --porcelain`, inspect
   the recorded base/feature SHAs, and preserve unrelated state.
5. Run the active slice's startup checks.
6. Restate the next bounded outcome and agent/parallelism plan before writing.

## Mutation rule

The main checkout remains on `main` and read-only. Every tracked mutation,
including planning documentation, occurs on a `codex/*` feature branch in a
recorded sibling worktree. Never default to `dev`. Never reuse an uncertain or
dirty worktree.

## Work

Execute only the next safe slice. Read-only agents may inspect in parallel.
Write-capable agents receive distinct scopes and worktrees. Shared contracts and
landing are serialized. New discoveries update the slice or create an explicit
decision; they do not silently expand scope.

## Close

1. Run focused checks and the slice's closing gate.
2. Review the complete diff and derive actual changed paths.
3. Commit a coherent sealed checkpoint in the feature worktree.
4. Land through a guarded merge into current `main`; prove ancestry.
5. Remove the worktree only after landing is proven. Preserve branches when
   conflict, failure, cancellation, or uncertainty exists.
6. Update the slice receipt, `docs/current-state.md`, and
   `docs/execution/current.md` in the same landed change whenever practical.
7. Finish with clean status, exact commits, checks, known limitations, and the
   next safe slice.

