# Current execution handoff

Updated: 2026-07-13 after DL-004 guarded code landing, post-merge verification,
exact push/re-fetch, and guarded feature-worktree cleanup. Documentation
closeout landing is the only remaining DL-004 operation.

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
- Completed slice: `docs/execution/slices/RS-004.md`
- RS-004 base: `6a0beb90a7b730dbee94181f012c0918f464af8b`
- RS-004 feature branch: `codex/rs-004-quota-observations`
- RS-004 feature worktree: removed after positive landing/tree proof; all
  deregistered dependency/build residue was verified and removed
- RS-004 sealed implementation:
  `f7bcb60e9f242c72a56ffda508da6451012e172b`
- RS-004 sealed tree: `316ec12a2f94991cb89ed069886feec17e02ad03`
- RS-004 feature record:
  `37d8f7e4d9e67202c3487d1ef3fe6512f6343d66`
- RS-004 landing merge: `1bd333903660b0ada212e305846efaee1b7bdd62`
- RS-004 landed tree: `8cb674bd82c10a07eac8ab34a91adf4293b28ef6`
- Completed slice: `docs/execution/slices/PM-001.md`
- PM-001 base: `a7c5423cb5a4aa8549521badcfdd320437a74def`
- PM-001 feature branch: `codex/pm-001-ainativepm-discovery`
- PM-001 feature worktree: removed after positive ancestry/tree proof
- PM-001 sealed proposal checkpoint:
  `e2fe6ee11f8ddd9641eb20262913a648b47a73e8`
- PM-001 proposal tree: `e4c32ad64a635aeafa95230ccf6d8a69eed6ceef`
- PM-001 accepted-decision commit:
  `4f0503f2a3b3201c28f21f1e5b4cd0d45f877e58`
- PM-001 accepted-decision tree:
  `913cc4905b0d0a2c133820da67e15f9dedeb19cf`
- PM-001 feature record:
  `16ed919628fd12f5f74bf5713e02fb2f3d89eb7b`
- PM-001 landing merge:
  `1adaad7926ca64a47fc3935c8afffbc799ada70e`
- PM-001 landed tree: `18cfeb9177130f697ad30358d76b5db27104bae4`
- PM-001 feature worktree: removed; feature branch preserved
- PM-001 closeout branch: `codex/pm-001-closeout`
- PM-001 closeout worktree: removed after guarded landing
- AInativePM source: initial snapshot `5033d5e`; final committed boundary
  `c146162` after audited concurrent UI-only landings
- Completed slice: `docs/execution/slices/SF-001.md`
- SF-001 base: `5581af7918ac438b51785cb825f216ab3d79d738`
- SF-001 branch: `codex/sf-001-data-dir-admission`
- SF-001 feature worktree: removed; feature branch preserved
- SF-001 sealed implementation:
  `c22d5278419ca6ad3d96add8a3d0109aaefca796`
- SF-001 sealed tree: `64c0a414bb159498faf64e16be4f3ecaeef5cdae`
- SF-001 feature record: `8b6a08dcde66cb190dcbb96edf500c7276f91cb2`
- SF-001 landing merge: `a8b52c666d3fc3284b94f441ce602b908689539a`
- SF-001 landed tree: `e7d6dc7d8318f40be698b0564b8f5d65874187d7`
- Completed slice: `docs/execution/slices/SF-002.md`
- SF-002 base: `94dee1a7ec56ca3e2470769c9d136ed11754e6e6`
- SF-002 branch: `codex/sf-002-repository-lease`
- SF-002 contract commit: `0be8912`
- SF-002 feature worktree: removed after positive landing/tree proof; exact
  residue removed after a zero-process guard
- SF-002 receipt: `docs/execution/receipts/SF-002.md`
- SF-002 sealed feature record:
  `e3cf861b3f5ffb9fe30ad3d17f328ec1e150d6bc`
- SF-002 landing merge: `a91bb6c8619672f316109d08719b1afea8a918f4`
- SF-002 exact feature/merge tree:
  `897142ece8cfa7c27195d7f93f17f4a06e4f78f5`
- SF-002 feature branch: preserved
- SF-002 code landing: pushed and re-fetched exactly at the landing merge
  before documentation closeout
- SEC-003 base: `781e8f5cd8d3666c668b6e3b2c773d4e32ec3141`
- SEC-003 branch: `codex/sec-003-child-environment`
- SEC-003 contract commit: `e33c5c2f3b26dcf6746e8c01a1bde6ce531a1fef`
- SEC-003 sealed implementation:
  `0b9354714c6e04826a24772c9a29b03c8663b235`
- SEC-003 sealed implementation tree:
  `a3d671fcadefdf1eed559d8e0b3c9109bd2cfb04`
- SEC-003 feature record:
  `33bb9009389ad5ba089a11b5317cf4dbe2d5fefe`
- SEC-003 landing merge:
  `4521d23651a757953ff155f0cf6583995d5acf54`
- SEC-003 exact feature/merge tree:
  `171cf09da680ee09a924ac8d94ea414ed87333c2`
- SEC-003 feature branch: preserved
- SEC-003 feature worktree: removed after positive landing/push proof; exact
  dependency/build residue removed after parent/name/process guards
- SEC-003 receipt: `docs/execution/receipts/SEC-003.md`
- BC-002 base: `36ac71c59bb1d4095e30c9e2e4ed4d8ef73c9fd1`
- BC-002 branch: `codex/bc-002-browser-baseline`
- BC-002 sealed evidence: `871c7986a4683eec585159ad52ca9cffcdc83f8c`
- BC-002 feature tip: `5f9325b14ee40085ea2ef1f827a2703163abeb0a`
- BC-002 landing merge: `9278a6f9e9769b73601c58399554468328b314a1`
- BC-002 landed tree: `75c83dd3024d47fe73a655a41e46fae604b824ed`
- BC-002 worktree: removed; feature branch preserved
- Completed slice: `docs/execution/slices/DL-002.md`
- DL-002 base: `964a93aa8d7cc7b70968d8c256fbc16dbb31e84f`
- DL-002 branch: `codex/dl-002-approved-abandonment`
- DL-002 contract commit: `03cf153dbc48e7b569a385ccebd62a38adbd5253`
- DL-002 sealed implementation:
  `367f208b976d554ed58703a172e18045b045fe30`
- DL-002 sealed implementation tree:
  `1d5367a4a2c2a93033e0b1c2c8a5f505de416616`
- DL-002 feature record:
  `7b194a941ae6fa45056ffc2ab1a253518ed9faad`
- DL-002 landing merge:
  `02231eceae4a5f26c6bd83cd5b486fd6752569a4`
- DL-002 exact feature/merge tree:
  `20994454b05e2dfa3250e58ad11192844b2c99a2`
- DL-002 feature worktree: removed after positive landing/push proof; exact
  dependency/build residue removed after parent/name/process guards
- DL-002 feature branch: preserved
- DL-002 receipt: `docs/execution/receipts/DL-002.md`
- Completed slice: `docs/execution/slices/DL-004.md`
- DL-004 base: `d82df6d89eebb8bbdb8d094a891298abdc855221`
- DL-004 branch: `codex/dl-004-review-workspace`
- DL-004 worktree: removed after positive landing/push proof and guarded
  dependency/build residue cleanup
- DL-004 contract commit: `07cec4d8aa69e8c0177e6204c04690acf034447f`
- DL-004 sealed implementation:
  `41370a51f83275719239feff85ea5f493892b0cd`
- DL-004 sealed tree: `6c53ad49167a3879938dc9c5bf753ca0618a5c21`
- DL-004 receipt: `docs/execution/receipts/DL-004.md`
- DL-004 feature record: `1e59c052b989d208ae22a0a6db60823b04286733`
- DL-004 code landing: `2ea345a4807a49b05a55024cd4053fe81ac25ecd`
- DL-004 exact feature/code-merge tree:
  `1d53ce1fdbea686e370d12594f6af7ceee0216a2`
- DL-004 feature branch: preserved
- DL-004 documentation closeout: `codex/dl-004-closeout` from the exact pushed
  code landing; guarded closeout landing/push/cleanup pending

## Status

RS-001 through RS-004 are complete, guarded-landed, pushed, and torn down.
RS-004 landed as `1bd333903660b0ada212e305846efaee1b7bdd62`.
Exact specialist snapshots, selection/attempt/native identity, continuation/
revival/reviewer behavior, legacy quarantine, safe browser/MCP projection,
landing/reviewer races, and recovery CAS are covered. Full pre- and post-merge
`pnpm ci:check`, production web build, isolated browser QA, hostile review, and
the 50-path/provider-boundary audit passed.

RS-004 replaces the inherited Claude-shaped cache/wire with durable
provider-neutral current-state quota truth, atomic outbox publication, strict
source observations and used normalization, runtime/account attribution,
per-window freshness, bounded polling, adapter-local Claude acquisition, and a
strict browser projection. Three hostile audits, full `pnpm ci:check` (including
331/331 server tests), production Vite build, final path/provider audits, and
isolated desktop/narrow browser QA passed. Post-merge `pnpm ci:check`, sealed and
feature ancestry, exact feature/merge tree equality, push, and teardown also
passed. No live provider call was required.

PM-001 has completed its parallel domain/persistence, UI/REST, MCP, and
PC-SDK-touchpoint source lanes from AInativePM `5033d5e`, then revalidated the
UI/route lane through clean pushed `c146162` after concurrent UI-only landings. The
evidence-backed proposal rejects the inherited project-only anchor, separates
optional generic PM context from an exact external item ref, assigns one owner
to management versus technical truth, blocks present integration writes, and
defines the authority/identity/idempotency/receipt prerequisites for future
immutable evidence links. A hostile review found and drove corrections to
permission authority, provider neutrality, remote/principal identity, stale/
degraded states, remote ambiguity, migration, local command intent, and REST/
discussion claims.

AInativePM's final audited commit boundary is `c146162`; PM-001 made no source
edit. One live `get_started` call was made before source review exposed its
first-run seeding hook. No pre-call
snapshot/private DB read can distinguish no-op, marker stamp, or default-domain
creation, so remote-unchanged is explicitly inconclusive and no further live PM
call is permitted in this slice.

Final hostile re-review passed with no P0/P1 blocker. `git diff --check`, the
eight-path scope audit, 23-reference documentation audit, and zero-non-web PM
delta audit passed. `pnpm ci:check` could not start in this intentionally
unprepared documentation worktree because `node_modules`/`@types/node` is
absent; no install/residue was introduced, and the clean base retains its
post-RS-004 full gate.

PM-001 is complete on pushed `main` at `1adaad7`. Exact feature/merge tree
equality, ancestry, full post-merge `pnpm ci:check`, push, and feature-worktree
teardown passed.

BC-002's bounded browser gate passes on the captured evidence. Pinned preserved
`e233aa54` and current-base `36ac71c` production bundles retained identical core
shell blobs and matching inspected geometry. The current deterministic journey
covered project/session isolation, queued-send edit/remove, confirmed
interruption, safe canonical projections, current/history/resumed provenance,
context/quota honesty, reload equivalence, and two-tab convergence without an
observed console warning/error or raw provider-native identity. Four canonical
captures and exact hashes are tracked.

Both fake-only fixture processes are stopped, their ports are closed, all
temp-root-validated data/log roots are removed, the detached preserved worktree
had no tracked diff and is removed, and the stable app checkout retained its
pre-run HEAD/status. Full feature-tree `pnpm ci:check` (`331/331` server tests),
the exact 14-path scope audit, the 139-reference local-path audit, and
`git diff --check` pass. The first hostile review's matrix/reproducibility gaps
were corrected; two final independent re-reviews report no P0/P1/P2 blocker.
The evidence commit `871c7986` and feature tip `5f9325b` landed as merge
`9278a6f`. Feature/merge tree `75c83dd` is identical and ancestry is positive.
Full post-merge `pnpm ci:check` (`331/331` server tests), push to exact
`origin/main`, and feature-worktree teardown passed. Git left unregistered
dependency residue during worktree removal; its exact parent/name/process guard
passed before recursive removal. N1 is complete.

SF-001 is complete, guarded-landed, pushed, and torn down. Production admission
now binds a
non-replaceable Windows named pipe/Linux abstract socket and a dedicated
zero-wait SQLite transaction before migrations. Ordinary same-directory
contenders exit typed before product-state activity; distinct directories
coexist; process death releases ownership; restart waits for positive
post-parent-exit acquisition. HTTP/upgrade and registry admission close before
shutdown snapshots, and known runtime-disposal uncertainty propagates.

The 11-case focused matrix, launcher parser, full `pnpm ci:check` (342/342
server tests), 14-path scope audit, process/temp-root cleanup, and final hostile
reviews pass. No live provider/integration call or stable-data/external-repo
mutation was made. At the SF-001 checkpoint, `OPS-005` remained accepted
because its repository half was still open; the SF-002 feature status below
supersedes that historical gap without promoting the global requirement.

Feature record `8b6a08d` landed as `a8b52c6` with exact feature/merge tree
`e7d6dc7`. Sealed/feature ancestry, post-merge `pnpm ci:check`, exact
`origin/main` push, feature-worktree deregistration, and guarded residual
dependency/build cleanup all passed.

SF-002's cooperative engine-lifetime repository lease is complete,
guarded-landed, and pushed. Canonical Git common-directory identity keys a
protocol-stable kernel witness plus repository-local zero-wait SQLite
admission. Project creation authoritatively rechecks `init-empty`,
`init-in-place`, and `attach-to-git`: initialization claims a crash-visible
future `.git` identity and produces a clean `Initial scaffold` or
`Initial import`, while attach requires the selected canonical worktree root
and refuses a repository subdirectory. Project rows and worktree receipts
durably bind the resulting identity.

Immutable identity and expected-identity revalidation guard every Git-backed
runtime, fresh/continued dispatch, delivery, verification/review, boot
recovery, landing, teardown, and recursive-cleanup door. Ambient `GIT_DIR`,
`GIT_WORK_TREE`, and `GIT_COMMON_DIR` are scrubbed from direct Git, shell, and
provider child seams. Migrated sessions with a folder but no durable project
identity expose typed historical-resume and active-remint refusal before
preflight or state transition. Same-engine isolated builders remain parallel;
the existing local FIFO serializes landing.

Repository lease tests pass 19/19, runtime session selection 17/17, HTTP
contract 12/12, and the landing + independent-review + kill-recovery matrix
47/47 (27 + 12 + 8). The full server suite passes 370/370. Awaited fixture
cleanup, migration diagnostics, actual-path/mutation-door audits,
`git diff --check`, and full feature-tree `pnpm ci:check` pass. Both independent
hostile re-reviews are clean after fixes with no remaining P0/P1/P2 blocker.

Sealed feature record `e3cf861b3f5ffb9fe30ad3d17f328ec1e150d6bc`
landed as `a91bb6c8619672f316109d08719b1afea8a918f4`. Contract and feature ancestry
are positive; feature and merge trees equal
`897142ece8cfa7c27195d7f93f17f4a06e4f78f5`. Post-merge `pnpm ci:check`
remained green with 370/370 server tests. The code landing was pushed and
re-fetched exactly at the landing merge before documentation closeout. The
feature worktree was deregistered, its exact residue
removed after a zero-process guard, two handoff-recorded stale temp roots were
removed, and the feature branch was preserved.

The protection is deliberately cooperative. The working PC-SDK does not
participate, an escaped child is not contained, and the manual stable-vs-Next
concurrent-write prohibition remains. `OPS-005` stays accepted.

SEC-003's feature implementation is complete and independently re-reviewed.
Provider runtimes, app-owned Git, setup/readiness/verification/cleanup shells,
and their descendants now receive one positive OS-essential allowlist instead
of the server environment. Claude adds only its selected exact credential home
and the pinned SDK fake-spawn proves the final native map without a provider
call. Shell selection is pinned independently of ambient `ComSpec`; Git hooks/
filters and real shell grandchildren cannot observe the host PM/OpenAI/app
canaries. Explicit MCP consumer env and same-engine restart retain their
documented separate semantics. Full feature-tree `pnpm ci:check` passes with
387/387 server tests; three hostile re-reviews report no P0/P1/P2. Feature
record `33bb9009` guarded-landed as `4521d236`; exact feature/merge tree
`171cf09d`, post-merge 387/387 gate, exact push/re-fetch, and feature-worktree
teardown all passed.

## Active action

DL-004 is complete in code. Sealed implementation `41370a51`, feature record
`1e59c052`, guarded code landing `2ea345a4`, and exact feature/code-merge tree
`1d53ce1f` are positive. Pre- and post-merge `pnpm ci:check` are green with
452/452 server tests and the dead-import guard; production web builds, exact
push/re-fetch, feature-worktree deregistration, and guarded residue removal
pass. The branch is preserved. `WT-002` is verified.

No implementation slice is active. The current bounded operation is only to
commit and guarded-land this documentation closeout from
`codex/dl-004-closeout`, push/re-fetch it exactly, and remove its worktree after
positive ancestry/path/process proof.

After closeout, the next product action is to define the first N5 Codex
subscription-path spike as a new slice contract. Do not start broad parity,
selector UI, permission-mode redesign, nonparticipant/escaped-child
containment, a workflow/recovery center, `OPS-006`, PM/MCP, or N7 without that
contract and any genuinely required product direction.

- DL-004 base: `d82df6d89eebb8bbdb8d094a891298abdc855221`
- DL-004 branch: `codex/dl-004-review-workspace`
- DL-004 worktree: removed after guarded landing/push/residue proof
- DL-004 contract: `docs/execution/slices/DL-004.md`
- DL-004 sealed implementation:
  `41370a51f83275719239feff85ea5f493892b0cd`
- DL-004 sealed tree: `6c53ad49167a3879938dc9c5bf753ca0618a5c21`
- DL-004 receipt: `docs/execution/receipts/DL-004.md`
- DL-004 feature record: `1e59c052b989d208ae22a0a6db60823b04286733`
- DL-004 code landing: `2ea345a4807a49b05a55024cd4053fe81ac25ecd`
- DL-004 exact feature/code-merge tree:
  `1d53ce1fdbea686e370d12594f6af7ceee0216a2`
- DL-004 closeout branch: `codex/dl-004-closeout`
- DL-004 closeout worktree:
  `E:\Claude Code Projects\Personal\PC-SDK-Next-dl-004-closeout`

- DL-003 base: `bbce281c4022a9389ff42a9c992b37d0630f7303`
- DL-003 branch: `codex/dl-003-recovery-gate`
- DL-003 worktree: removed after guarded landing/push proof
- DL-003 contract: `docs/execution/slices/DL-003.md`

## Startup checks

```text
git status --short --branch
git worktree list --porcelain
git remote -v
git log --oneline --decorate -8
```

All completed feature worktrees are removed. Only the main checkout and the
recorded DL-004 documentation-closeout worktree are registered.
Keep the PC-SDK Next main checkout read-only.

## Known blockers

No SEC-003 blocker remains. No PM-001 blocker remains. Its `get_started`
remote-state uncertainty is retained in the completion receipt rather than
repaired through private-data inspection.
No DL-002 blocker remains.
No DL-004 implementation or product-direction blocker remains. Only this
documentation closeout's guarded landing/push/cleanup is pending.
The Next shortcut code is isolated but has not been installed; regular daily
driving remains on the original PC-SDK until the migration gate. SF-002 has no
product-direction, verification, or landing blocker.
