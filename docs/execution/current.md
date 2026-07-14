# Current execution handoff

Updated: 2026-07-13 at the CX-004 Windows Sandbox runner amendment. CX-003 is fully closed at
`cb78b23dd49f1fdb751d86cb18838a6cdd2ac1cc`; its accepted decision and separate
final receipt guarded-landed, passed their post-merge gates, were pushed/re-fetched
exactly, and both worktrees were removed under positive guards. CX-004 is the active
fake-only slice. The product owner replaced its custom licensed VM/image factory with
fresh Windows Sandbox qualification plus a bounded fake-only host smoke. Only the
governing amendment and provider-free Q0S harness/fixed probes may proceed now;
Sandbox is not enabled and native/TypeScript product code remains blocked. No native
Codex process, thread, turn, provider login, or credential access occurred.

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
- DL-004 documentation closeout branch: `codex/dl-004-closeout` (preserved)
- DL-004 documentation closeout commit:
  `01aad6c1f12f2a9237d309f65695c21ea31474dc`
- DL-004 documentation closeout merge:
  `fba54487fc3e98426ada436bf12515118967b893`
- DL-004 documentation closeout tree:
  `c92f78bc4fc664db1f67bfb93b01b8ba57232cd9`
- DL-004 documentation closeout: pushed and re-fetched exactly; worktree
  removed after positive path, ancestry, remote, and zero-process proof
- Completed slice: `docs/execution/slices/CX-001.md`
- CX-001 base: `dea2df76ff623ec96123b61ca6b9ab5f8aa8d639`
- CX-001 branch: `codex/cx-001-codex-subscription-spike`
- CX-001 worktree: removed after positive landing/push proof and guarded
  residual-directory cleanup
- CX-001 contract commits: `02135481`, `27d5ea54`, and `8c15023e`
- CX-001 sealed implementation:
  `648b7d971c34ccf36985d84c0d20155e5eacf7d3`
- CX-001 sealed tree: `2e10894429d4a99cce91b3665b45585240c52bde`
- CX-001 receipt: `docs/execution/receipts/CX-001.md`
- CX-001 feature record: `b9fce8df104570d383c392c506f67200ba001336`
- CX-001 code landing: `11365f1cf5802075d55b6506ebf5785a4e1ded5c`
- CX-001 exact feature/code-merge tree:
  `14bd4f9c93ab481dbd5c2443a76c1d1fb7a556ec`
- CX-001 feature branch: preserved
- CX-001 documentation closeout branch: `codex/cx-001-closeout` (preserved)
- CX-001 documentation closeout commit:
  `6fb5fb74a7408b6505067ac23df69a6ef806393f`
- CX-001 documentation closeout merge:
  `1168394a1f1d26ad5bf89110a34cb28dc64cfd52`
- CX-001 documentation closeout tree:
  `61c6848dd6a06e1598fdc8fd308792a8c41c9e3c`
- CX-001 documentation closeout: pushed and re-fetched exactly; worktree
  removed after positive path, clean-tip, ancestry, remote, and process proof

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

CX-001's implementation is sealed at `648b7d971c34ccf36985d84c0d20155e5eacf7d3`,
tree `2e10894429d4a99cce91b3665b45585240c52bde`. The 598-file exact
non-experimental stable schema, direct native resolver, exact-home/file-store
environment boundary, strict JSONL admission client, config/account/catalog
parsers, redacted CLI receipt, and direct-child lifecycle are implemented. The
focused suite passes 153/153; full `pnpm ci:check` passes with 597/597 server
tests and dead-import guard; production web build and all three final hostile
re-reviews pass.

The one approved no-turn gate observed cached ChatGPT auth kind, built-in
routing, and advertised default `gpt-5.6-sol` / effort `medium` twice through
distinct positively disposed app-server processes. It called no thread, turn,
login, logout, tool, MCP, approval, context, quota, or inference method. This
does not establish freshness, entitlement, subscription usability, billing,
model usability, a production adapter, or escaped-descendant containment. No
requirement is promoted.

Feature record `b9fce8df` guarded-landed as code merge `11365f1c`, with exact
feature/code-merge tree `14bd4f9c`. Post-merge `pnpm ci:check` passes with
597/597 server tests and the dead-import guard; production web build, focused
schema/static checks, exact push/re-fetch, feature-worktree deregistration, and
guarded residual-directory removal pass. The feature branch is preserved.
Documentation closeout commit `6fb5fb74` guarded-landed as `1168394a`, with
exact tree `61c6848d`; its five-path documentation-only scope, parents,
ancestry, exact push/re-fetch, and guarded worktree removal pass. The closeout
branch is preserved.

## Active action

CX-004 is authorized and its exact fake-only contract is
`docs/execution/slices/CX-004.md`. First land the governing amendment, then announce and
enable built-in `Containers-DisposableClientVM`, restarting only if Windows requires
it. Host-only discovery must then find the modern Store-delivered `wsb` CLI; legacy/no-
CLI is unsupported and any additional official Store/update action is announced
separately. Implement/review/guarded-land the provider-free Sandbox harness, canonical
template, fixed bootstrap, deterministic lifecycle probe, tests, and receipt schemas as
clean commit/tree `S0`. Run no Sandbox session before re-fetching `S0`. Q0S run evidence
`R0` and post-landing closeout `R1` must land before native/TypeScript product
implementation. Q0S is runner readiness, not the final product matrix. The complete
implemented fake matrix later runs in fresh Q0S-revalidated sessions. No ISO, product
key, Microsoft account, custom VM, switch, disk, or provider access is needed. Rolling
hosted labels remain non-admitted.

The stable-0.144.1 policy audit and Windows containment/toolchain design are complete.
The product owner explicitly accepted
ADR-0002's two
repository-owned native artifacts—the transient cold-start/controlled-restart PE and
C++ Node-API full-spawn addon—plus explicit admission of pinned
`better_sqlite3.node`. A live future N7 launcher must retain non-authoritative same-PE
`entry-scrub` through exact success or terminate/wait, but its process handle does not
cover N7 death/hard kill before scrub's watcher arms. That create→arm race remains a
separate production blocker requiring a crash-safe kernel anchor and topology receipt;
CX-004 neither qualifies nor freezes it. On a provably unjobbed internal fixture, scrub
arms its independent watcher, then its main path creates/configures/queries/publishes
the process-sole permanent outer job with watcher ack before atomic same-PE cold create.
The exact two-phase event orders ready, least job-target return, cold protect/query/
publication, and ack without signal collapse. Every watcher-visible handle is retired/
quiesced; protected transient sources are cleared and queried clear before source close
and exact scrub-success. From positive watcher arm, hard
deadlines terminate the exact transient/job. Cold requires parent success plus exact
sole outer-job/unjobbed-parent proof before SF-001. Direct, replayed, inherited-handle, dead,
hung, malformed, wrong-job, or uncertain paths fail. Pre-existing same-user malware
racing scrub's brief child-handle window remains explicitly outside the descendant-
origin threat.

Cold bootstrap creates and immediately protects/queries/publishes the no-client SF-001
witness, then launches exact
protected `node.exe` against deterministic precompiled JavaScript through implicit
inheritance of the already-held outer job. Shell/package-manager/`tsx`/esbuild/source-loader/preload paths are non-
admitted. Cold bootstrap exits before SQLite opens. In controlled restart, only the
new owner may acquire the dedicated admission-SQLite lease while bootstrap lives; it
binds the exact committed nonce/generation/digest, acknowledges, then bootstrap exits
before product DB open. One component-owned row-plus-outbox state machine supplies
documented durable-write/flush behavior, conservative restart reconciliation, and the
exact completion CAS. Independent physical-power-loss injection is the accepted
unclaimed daily-driver residual. The full-lifetime native-load gate
allows the exact sealed Node/system closure and, among optional non-host/non-system/
application-native mappings, only owner addon then exact SQLite through one verified binding factory;
extension loading and optional `ws` native accelerators are excluded.

All process-spawn edges reachable from the admitted bootstrap/Node owner—including the
current source/dev-only Codex edge—are eliminated or routed through a no-fallback full-
spawn family covering same-token `CreateProcessW`; a future production Codex binary is
separately supplied and qualified. The family also covers
restricted-token `CreateProcessAsUserW`. It seals ordered job vectors, handle lists, restrictive
process/thread descriptors, mitigation/child/security-capabilities attributes,
protected noninteractive station/desktop policy, pre-resume proof, bounded I/O, and
external hard-kill receipts. A generated typed-wrapper/static-guard/PE-digest manifest
covers every raw OS/native resource site in the exact artifacts—including owner,
borrower, and no-release/pseudo classes—with exact
live/released/quarantined state and type-specific fault/ABA proof. The process-creation
coordinator remains held from pre-leaf/baseline state through exact resume, positive
derived resume-thread-handle close, and atomic success or failure publication. Ordinary addon launches
own one new leaf, borrow rather than close session/outer parents, prove every retained-
job baseline, and set zero nested-job UI restrictions. Provider session alone retains
the exact lifecycle-plus-assign-only handle pair and closes assign after action quiescence,
lifecycle last. A hostile resumed root may self-create an unnamed inner job; that
unobservable total-chain change is an accepted contained denial-of-service residual,
not an escape or exact topology claim. The Git delivery boundary remains restricted Git
candidate creation followed by an owner memory-safe verifier, owner verified-byte
promotion, and files-backend ref CAS.
The external one-click UI launcher/browser remains N7 operations work. Routine entry-
scrub invocation/lifecycle wait/terminate/close is constrained, but that process handle
is not the required crash-safe anchor; the browser is never placed in the owner job.

The accepted fake-lab platform is the exact Windows 11 Pro 25H2 AMD64 host
`10.0.26200.8655` plus a fresh discovered Windows Sandbox guest build/identity, sealed
Sandbox configuration/harness/input/artifact evidence, and typed unsupported on any
bound delta until affected requalification. `windows-latest` remains independently
observed and non-admitted. CX-004 supplies neither immutable-image nor physical-power-
loss evidence; production stays unavailable pending a separate protected-install/OS-policy/
packaging/N7-launcher-lifecycle decision. ADR-0002 also requires waiting for a later stable Codex release
with a complete independently verifiable effective-policy receipt, quiescent two-step
barrier, and immutable epoch. Fork, experimental, alternate-wire, raw-API, and weaker
detection cannot bypass the gates. The first live policy requires an all-origin empty
external-action inventory, approvals disabled, unknown actions denied, and exact
sandbox/filesystem/network evidence.

Exact-snapshot hostile/source/link/path/scope/diff verification is positive, including
three independent no-P0/P1/P2 reviews. Accepted decision
`6061ad5b817af13077cf4f9358b3f351c83699dd` guarded-landed as
`e8a1c6d0aa13520b1ab0037af02006cb9a283b91`; exact parent vector, ancestry,
decision/merge tree, six-document scope, post-merge `pnpm ci:check`, push/re-fetch,
preserved feature-branch tip, and guarded feature-worktree removal are positive. The
separate final receipt sealed as
`23841e3c5ddb2fdb961a6aad2f0a1f1364a1146f` and guarded-landed as
`cb78b23dd49f1fdb751d86cb18838a6cdd2ac1cc`, with exact ordered parents
`[e8a1c6d0aa13520b1ab0037af02006cb9a283b91,
23841e3c5ddb2fdb961a6aad2f0a1f1364a1146f]` and exact receipt/merge tree
`ec9af29551d91e41571d13add210f6025e011ec8`. Its pre/post full gates each passed
660/660 server tests plus the dead-import guard. Exact push/re-fetch and guarded
worktree/residual teardown passed; both CX-003 branches are preserved.
The acceptance authorizes CX-004; native or TypeScript containment implementation
begins only after the exact Q0S readiness receipt lands. CX-004
must not start Codex. Stable 0.144.1 remains unable to mint the complete effective-
policy receipt. Before a later stable CX-005 provider process, shared-login-home
access, or invocation, a separately approved fresh production bootstrap/install/
postmortem receipt, explicit provider-root TCB-versus-opaque-broker choice, and a
positive receipt for every root-applicable active-contract invariant/canary are
mandatory, without deferral to CX-008. That includes attester provenance; raw/effective
token, removed-privilege, and self-access facts; non-DACL self-relaxation; child/UI/job/
IPC access; executable/load/process/restart closure; shared-home/capability export; the
1:1 root/PC-SDK-session-job receipt in which the PC-SDK owner is the sole process holding
the exact lifecycle-plus-assign-only session handle pair; retained membership/limits;
recovery; preventive resources; and the exact composed job-template matrix. CX-005 then reruns
the CX-001/CX-002 binary/schema/no-turn gates; CX-006 proves subscription/session/
dispatch/context/usage under the empty policy; CX-007 compiles inert provider-free
non-process policy only. CX-008 revalidates every root guarantee and adds the
independently attested lower/sibling/cross-tier boundary with exact raw token/
child/UI/self-DACL, executable/parser/Git,
capability-export, durable-recovery, resource-budget, IPC/lifecycle, nested-job,
and CX-007-template proofs. Its initial lower template is leaf-only with empty raw
network capability; process-spawning parity needs a separate mediated-child or
stronger-isolation decision and every process independently receipted. Differential
or ambient-inaccessibility evidence plus the full composed CX-004 matrix must pass.
CX-009 then requires matching fresh provider/OS receipts and a challenge-bound PC-
SDK composite CAS verifying every current/equality fact, zero unresolved leases,
and no oversubscription before disposable parity. CX-010 repeats that complete
fresh join before the real fix.

Do not compose or register Codex, broaden the CX-001 admission allowlist, expose
selectors or handoff UI, start a native thread/turn, or run the real-fix gate.
Native execution remains blocked until all-origin external-action/sandbox/
approval enforcement and escaped-descendant containment have positive
production receipts. No experimental protocol, raw API billing, or weaker
fallback is authorized.

- CX-003 base: `7259645dfaa9bb4c071843819119dda319d4cea8`
- CX-003 feature branch: `codex/cx-003-native-execution-decision` (preserved)
- CX-003 feature worktree: removed after guarded landing and guarded residual cleanup
- CX-003 contract: `docs/execution/slices/CX-003.md`
- CX-003 evidence: `docs/research/codex-native-execution-safety.md`
- CX-003 accepted ADR:
  `docs/decisions/0002-codex-native-execution-safety.md`
- CX-003 decision receipt: `docs/execution/receipts/CX-003.md`
- CX-003 proposal checkpoint:
  `4fbbdf0f77b447e78f4218816e90d553ed93145a`
- CX-003 proposal tree: `781cd1ff8beae1ef046687661d336049496b0acc`
- CX-003 accepted decision:
  `6061ad5b817af13077cf4f9358b3f351c83699dd`
- CX-003 decision landing:
  `e8a1c6d0aa13520b1ab0037af02006cb9a283b91`
- CX-003 exact decision/merge tree:
  `5b926bbf73ecfc1819386c16a287125d74669c69`
- CX-003 final-receipt branch: `codex/cx-003-final-receipt`
- CX-003 final-receipt commit:
  `23841e3c5ddb2fdb961a6aad2f0a1f1364a1146f`
- CX-003 final-receipt/final-merge tree:
  `ec9af29551d91e41571d13add210f6025e011ec8`
- CX-003 final closeout merge:
  `cb78b23dd49f1fdb751d86cb18838a6cdd2ac1cc`
- CX-003 final-receipt worktree: removed after the guarded landing, post-merge
  660/660 gate, exact push/re-fetch, and guarded residual cleanup
- CX-003 status: complete; both branches preserved
- CX-004 base: `cb78b23dd49f1fdb751d86cb18838a6cdd2ac1cc`
- CX-004 branch: `codex/cx-004-windows-containment`
- CX-004 worktree:
  `E:\Claude Code Projects\Personal\PC-SDK-Next-cx-004`
- CX-004 contract: `docs/execution/slices/CX-004.md`
- CX-004 status: governing Windows Sandbox amendment in progress; product code blocked
  at Q0S; feature enablement and host-only modern-CLI discovery precede the provider-
  free harness/fixed-probe `S0` implementation slice

- CX-002 base: `da1376c334c78c9e485df7fe2d3a6d3b6af05c17`
- CX-002 branch: `codex/cx-002-codex-runtime-adapter`
- CX-002 worktree: removed after guarded landing/push proof and guarded residual
  cleanup
- CX-002 contract: `docs/execution/slices/CX-002.md`
- CX-002 contract commit: `23b2b90ca75b47daa7fca1ccf9f859e2b7c271ef`
- CX-002 sealed implementation:
  `bf1f3a5ec8a12c17defa954c1bd5ccf3c59f4e87`
- CX-002 sealed tree: `9de0007e4420849af4cf4b7f999856167f29c46f`
- CX-002 receipt: `docs/execution/receipts/CX-002.md`
- CX-002 feature record: `98ce745db5e440a2f5c45fe2e620c00fda427dbf`
- CX-002 code landing: `611c304eaa8932900b4f9d339edbb2058d99fa0f`
- CX-002 exact feature/code-merge tree:
  `ce1c31e8ba38095a6e7571f2fe2705939436e645`
- CX-002 closeout branch: `codex/cx-002-closeout`
- CX-002 closeout commit: `30fe8bb5604d68eb924f73bf2b40d0f4d4a71e3c`
- CX-002 closeout landing: `a48db361026fc999bd4226797f329a85c0e795d7`
- CX-002 closeout tree: `2bb0d86efee8316711985edb88a1022b6ad52cad`
- CX-002 closeout worktree: removed after guarded landing/push proof

- CX-001 base: `dea2df76ff623ec96123b61ca6b9ab5f8aa8d639`
- CX-001 branch: `codex/cx-001-codex-subscription-spike`
- CX-001 worktree: removed after guarded landing/push/residue proof
- CX-001 contract: `docs/execution/slices/CX-001.md`
- CX-001 sealed implementation:
  `648b7d971c34ccf36985d84c0d20155e5eacf7d3`
- CX-001 sealed tree: `2e10894429d4a99cce91b3665b45585240c52bde`
- CX-001 feature record: `b9fce8df104570d383c392c506f67200ba001336`
- CX-001 code landing: `11365f1cf5802075d55b6506ebf5785a4e1ded5c`
- CX-001 exact feature/code-merge tree:
  `14bd4f9c93ab481dbd5c2443a76c1d1fb7a556ec`
- CX-001 closeout branch: `codex/cx-001-closeout`
- CX-001 closeout commit: `6fb5fb74a7408b6505067ac23df69a6ef806393f`
- CX-001 closeout landing: `1168394a1f1d26ad5bf89110a34cb28dc64cfd52`
- CX-001 closeout tree: `61c6848dd6a06e1598fdc8fd308792a8c41c9e3c`
- CX-001 closeout worktree: removed after guarded landing/push proof
- CX-001 final-receipt branch: `codex/cx-001-final-receipt` (preserved)
- CX-001 final-receipt worktree: removed after guarded landing/push proof

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
- DL-004 closeout commit: `01aad6c1f12f2a9237d309f65695c21ea31474dc`
- DL-004 closeout landing: `fba54487fc3e98426ada436bf12515118967b893`
- DL-004 closeout tree: `c92f78bc4fc664db1f67bfb93b01b8ba57232cd9`
- DL-004 closeout worktree: removed after guarded landing/push proof

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

All completed CX-001 and CX-002 feature/closeout worktrees and residuals are
removed. Both CX-003 worktrees and guarded residuals are removed; both branches are
preserved. Main and the isolated CX-004 worktree are the only registered worktrees.
Main, `origin/main`, and the remote main ref were equal to
`cb78b23dd49f1fdb751d86cb18838a6cdd2ac1cc` at CX-004 startup. The feature worktree
was clean at that exact base before this blocked contract checkpoint.

## Known blockers

No SEC-003 blocker remains. No PM-001 blocker remains. Its `get_started`
remote-state uncertainty is retained in the completion receipt rather than
repaired through private-data inspection.
No DL-002 blocker remains.
No DL-004 implementation, closeout, cleanup, or product-direction blocker
remains. No CX-001 implementation, verification, hostile-review, live-gate,
landing, closeout, final-receipt, or cleanup blocker remains. CX-002 has no
implementation, verification, review, code-landing, push, feature-teardown, or
documentation-closeout blocker. CX-003's evidence, decision, feature landing, push,
re-fetch, final-receipt closeout, post-merge gate, and both teardowns have no blocker.
CX-004's anticipated environment prerequisite is not yet present: enable Windows
Sandbox through one announced UAC action, restarting only if Windows requires it, then
run host-only modern-CLI discovery. Legacy/no-CLI state is unsupported; any additional
official Store/update action is announced separately. The provider-free harness/fixed
probes then land as `S0`. Q0S positively records exact host/discovered guest build/
identity, Sandbox feature/application/CLI/template/rendered config, sealed mappings/
probes, exact-ID stop, and non-persistence before product code. No ISO, separate license,
account sign-in, custom VM/switch/disk, or Hyper-V group grant remains. A positive Q0S
and closeout `R1` are fake runner readiness only; the final complete fake matrix still
must pass, and provider/production execution requires its independent later current-
host receipts. Stable app-server 0.144.1 separately has a
confirmed effective-policy receipt blocker, so it cannot start a native thread
or turn. Waiting for/upgrading to a qualifying stable release is recommended;
experimental, forked, alternate-wire, API-billed, or weaker routes cannot
bypass the same gates. Future governing-doc-authorized wire evaluation remains
separate. Acceptance authorizes CX-004 provider-neutral containment; implementation
begins only after the runner gate and never authorizes a Codex process.
Process-capable parity and the real-fix gate stay
blocked through the separate CX-006-through-CX-010 receipts.
The Next shortcut code is isolated but has not been installed; regular daily
driving remains on the original PC-SDK until the migration gate. SF-002 has no
product-direction, verification, or landing blocker.
