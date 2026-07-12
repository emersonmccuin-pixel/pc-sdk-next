# Current execution handoff

Updated: 2026-07-11 after CF-003 guarded landing and teardown.

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
- Completed slice: `docs/execution/slices/CF-002.md`
- CF-002 feature branch: `codex/cf-002-projector-scale` (preserved)
- CF-002 feature worktree: removed after positive landing proof
- CF-002 base: `57be70f63e6e449afff27e5039aa5f0b81f042e9`
- CF-002 sealed implementation:
  `9ebf2c6284bebdae43f9263193999764a0c8413b`
- CF-002 feature record: `8a4be486c14fab994335469edcb4838ebac55a36`
- CF-002 landing merge: `77688fd1f1e5afe35d496e439a2743f59302fa31`
- CF-002 closeout landing: `a5943690ddbcbbf11ce3838ffc6dcfc950b90b41`
- Completed slice: `docs/execution/slices/CF-003.md`
- CF-003 feature branch: `codex/cf-003-durable-send-control` (preserved)
- CF-003 feature worktree: removed after positive landing proof; residual
  dependency files at the deregistered path were verified and removed
- CF-003 base: `a5943690ddbcbbf11ce3838ffc6dcfc950b90b41`
- CF-003 sealed implementation:
  `0ecc8e538935e57466da4b0106311fb65e7927ec`
- CF-003 feature record: `936058fa866d51344e77bd1b1ec873f3bbb3662a`
- CF-003 landing merge: `f76579686d2fc5df66e6eac4adcff0344b656256`

## Status

CF-003 is complete: durable revisioned FIFO sends, restart recovery, positive
interrupt receipts, and fail-closed interrupt-and-send gating are verified and
guarded-landed. The sealed implementation and feature record are both proven
ancestors of the landing merge, and the feature worktree is torn down. There is
no user-direction blocker.

## Next safe action

Define and provision `CF-004` for the next accepted N2 behavior:
`CHAT-007/CHAT-008` honest safe activity and complete tool-call lifecycle. Keep
private reasoning excluded and keep immutable runtime selection/Codex in N3.

## Startup checks

```text
git status --short --branch
git worktree list --porcelain
git remote -v
git log --oneline --decorate -8
```

Read `AGENTS.md`, `docs/master-plan.md`, `docs/current-state.md`, CF-003, and
the named conversation/runtime boundary documents before continuing.

## Known blockers

No blocker. The Next shortcut code is isolated but has not been installed;
regular daily driving remains on the original PC-SDK until the migration gate.
