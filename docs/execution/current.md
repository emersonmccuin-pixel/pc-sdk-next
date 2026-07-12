# Current execution handoff

Updated: 2026-07-12 after RS-004 sealed verification.

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
- CF-003 closeout landing:
  `8ad3437d5acef31f6f4aa99a3b50f282f124446c`
- Completed slice: `docs/execution/slices/CF-004.md`
- CF-004 feature branch: `codex/cf-004-safe-activity-tools` (preserved)
- CF-004 feature worktree: removed after positive landing proof; ignored
  dependency residue at the deregistered path was verified and removed
- CF-004 base: `8ad3437d5acef31f6f4aa99a3b50f282f124446c`
- CF-004 sealed implementation:
  `b1a377e7a75007e29a51e36dcdd5f283aaa1378f`
- CF-004 feature record: `3e80d8fdcae208dabcf46bd01538418e8dc89ad4`
- CF-004 landing merge: `ab2ffb95c3fb91931af3853ffc8f7f583080cfa5`
- RS-001 base: `c52713770a7196c5b7cd805e0d2d8dc8700f223f`
- Completed slice: `docs/execution/slices/RS-001.md`
- RS-001 feature branch: `codex/rs-001-session-selection-stamps`
- RS-001 sealed implementation:
  `cb61f255220dd50e95b53418f28e6bdd05f5077c`
- RS-001 feature record: `9da30c2e30cb29395b28bc8e317fa291599e8d56`
- RS-001 landing merge: `039af6c56a1235260d9859af1c51a6dca20fb990`
- RS-001 feature worktree: removed after positive landing/tree proof; exact
  deregistered dependency residue was verified and removed
- RS-001 closeout landing:
  `bdd4ce0be8aebff284c2cbbb425ab0b5e61b0a0b`
- RS-002 base: `bdd4ce0be8aebff284c2cbbb425ab0b5e61b0a0b`
- Completed slice: `docs/execution/slices/RS-002.md`
- RS-002 feature branch: `codex/rs-002-context-observation`
- RS-002 feature worktree: removed after positive landing/tree proof; exact
  deregistered dependency residue was verified and removed
- RS-002 sealed implementation:
  `84c30f3a5fd782d3ec1b008e75d3729c3b5d96c0`
- RS-002 sealed tree: `1322938d45c6ca75557da896d68179ddf5c55325`
- RS-002 feature record: `bc3d90630519b6780a0f300b062c0fd3f9b18963`
- RS-002 landing merge: `3a274034499f9454e059ded091b79276394780af`
- RS-002 landed tree: `ca01b1badca3d93ad979b9cf8c261cbb7e671955`
- Completed slice: `docs/execution/slices/RS-003.md`
- RS-003 base: `ff5b04bbb799293b31800267f061dcc6edb13742`
- RS-003 feature branch: `codex/rs-003-specialist-selection-stamps`
- RS-003 sealed implementation:
  `2f10a96ae0c56747ff25d868d15514bbef7359d3`
- RS-003 sealed tree: `01285d07cc23b2652b41d4c277628199da0e324c`
- RS-003 feature record: `b79f84b130702f7c523fe20a32c71c5236eb9fb9`
- RS-003 landing merge: `9fde98518aca92742040ed8e0e82a4825f258f5a`
- RS-003 landed tree: `86340e89f86827d2296b2fdb8428ac06d1888555`
- RS-003 feature worktree: removed after positive landing/tree proof; verified
  dependency residue was removed
- RS-003 closeout landing:
  `6a0beb90a7b730dbee94181f012c0918f464af8b`
- Active slice: `docs/execution/slices/RS-004.md`
- RS-004 base: `6a0beb90a7b730dbee94181f012c0918f464af8b`
- RS-004 feature branch: `codex/rs-004-quota-observations`
- RS-004 feature worktree:
  `E:\Claude Code Projects\Personal\PC-SDK-Next-rs-004`
- RS-004 sealed implementation:
  `f7bcb60e9f242c72a56ffda508da6451012e172b`
- RS-004 sealed tree: `316ec12a2f94991cb89ed069886feec17e02ad03`

## Status

RS-001 through RS-003 are complete, guarded-landed, pushed, and torn down.
RS-003 closeout landed as `6a0beb90a7b730dbee94181f012c0918f464af8b`.
Exact specialist snapshots, selection/attempt/native identity, continuation/
revival/reviewer behavior, legacy quarantine, safe browser/MCP projection,
landing/reviewer races, and recovery CAS are covered. Full pre- and post-merge
`pnpm ci:check`, production web build, isolated browser QA, hostile review, and
the 50-path/provider-boundary audit passed.

RS-004 is complete and sealed from that clean pushed base, awaiting guarded
landing. It replaces the inherited Claude-shaped cache/wire with durable
provider-neutral current-state quota truth, atomic outbox publication, strict
source observations and used normalization, runtime/account attribution,
per-window freshness, bounded polling, adapter-local Claude acquisition, and a
strict browser projection. Three hostile audits, full `pnpm ci:check` (including
331/331 server tests), production Vite build, final path/provider audits, and
isolated desktop/narrow browser QA passed. No live provider call was required.

## Next safe action

Guarded-merge the sealed RS-004 feature record into clean pushed `main`, rerun
`pnpm ci:check`, prove sealed/feature ancestry and exact tree equality, push,
and remove the feature worktree only after the positive receipts. After RS-004
closeout, define the deferred read-only N1
AInativePM domain/code/UI/MCP discovery and ownership/idempotency proposal; do
not perform automated PM writes or silently jump to Codex/N5.

## Startup checks

```text
git status --short --branch
git worktree list --porcelain
git remote -v
git log --oneline --decorate -8
```

At the guarded-merge checkpoint, require the isolated RS-004 worktree to be
clean at a feature-record tip containing the sealed implementation. Keep the
main checkout read-only until that proof. Verify its branch/status/origin state
before landing, then install only if dependencies are absent and run the
post-merge workspace gate before push or teardown.

## Known blockers

No blocker. The Next shortcut code is isolated but has not been installed;
regular daily driving remains on the original PC-SDK until the migration gate.
