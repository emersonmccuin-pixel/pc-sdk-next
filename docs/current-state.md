# Current state

Last updated: 2026-07-11 after CF-001 sealed verification.

## Preserved baseline

- Original daily driver: `E:\Claude Code Projects\Personal\PC-SDK`
- Stable repository: `github.com/emersonmccuin-pixel/pc-sdk`
- Annotated tag: `working-v1-2026-07-11`
- Baseline commit: `e233aa54c58dca163e98cf6011e79a0b91bd2d6f`
- Evidence: `pnpm ci:check` passed; `pnpm smoke` completed a live Claude
  Opus turn after the stale smoke harness was repaired.

The original checkout remains the daily driver. New architecture work happens
only in PC-SDK Next.

## Fork identity

- Checkout: `E:\Claude Code Projects\Personal\PC-SDK-Next`
- Repository: `github.com/emersonmccuin-pixel/pc-sdk-next` (private)
- `origin`: PC-SDK Next, fetch and push
- `upstream`: stable PC-SDK, fetch-only (`pushurl=DISABLED`)
- Base branch: `main`
- PF-001 landing merge: `e1667dbae069f1ea62fe4d8e54489927734f2483`
- PF-001 worktree: removed after positive landing proof
- BC-001 landing merge: `fd0756a3c39640d91bcb20cfe4a9fe22cb7d2380`
- CF-001 sealed implementation: `35b49d3a012abfb3ec1b439060b1046f95887e19`
  on `codex/cf-001-conversation-foundation`; guarded landing is pending

Isolation defaults in the planning slice:

| Resource | Working PC-SDK | PC-SDK Next |
| --- | --- | --- |
| Server | 5123 | 5124 |
| Dev web | 5173/default | 5175 |
| Data | original repo `data` | Next repo `data` |
| Logs | `%LOCALAPPDATA%\PC-SDK\logs` | `%LOCALAPPDATA%\PC-SDK-Next\logs` |
| Shortcut | PC-SDK | PC-SDK Next |
| Browser title | PC-SDK | PC-SDK Next |

## Implemented baseline capabilities

- Browser shell and streaming Claude orchestrator chat
- Canonical runtime seam with `ClaudeRuntimeAdapter`
- Runtime-stamped agent runs and specialist roster
- Typed contracts, deliverables, deterministic verification
- Durable asks/mailbox and agent terminal envelopes
- Mandatory worktree provisioning/readiness, sealed commits, guarded landing,
  teardown, recovery, and lifecycle tests
- Global MCP client/bridge foundation and Claude usage observations
- One-click hidden launcher and boot recovery
- Canonical provider-neutral conversation event identity with strict guards,
  conversation-owned transactional sequence allocation, and a dedicated
  atomic publication outbox
- Persisted visible stream deltas and one row-to-frame mapping for live,
  reconnect replay, and past-session HTTP projection
- Deterministic browser projection by authoritative sequence, including exact
  redelivery idempotency, gap buffering, and fail-closed sequence/item/stream/
  delta conflicts
- Adapter-local native message correlation; canonical terminal outcomes and
  stop reasons; historical private reasoning retained only as hidden migration
  evidence with no producer or render path

## Known architectural gaps

- Composition remains fixed to Claude and model defaults; there is no Codex
  adapter or runtime/model/effort switcher.
- Orchestrator sessions do not yet durably stamp the full runtime/account/model/
  effort selection needed for safe provider-neutral resume.
- Adapter capabilities/model discovery are specified but not implemented.
- Orchestrator session, account, usage, and some runtime-notice/permission
  vocabulary remain provider-shaped. Full immutable runtime/account/model/
  effort stamps and typed capability semantics remain N3 work.
- User send queue ordering works in-process but the queue is not durable across
  restart.
- Usage DTOs are Claude-shaped and do not retain general source semantics,
  confidence, staleness, or runtime attribution.
- No honest per-session context-use contract exists yet.
- Private reasoning no longer crosses the canonical runtime or browser seams,
  but a typed safe operational-activity taxonomy and continuous honest waiting
  feedback still need their own N2 slice.
- The correct pure browser projector currently scans/copies/re-derives the full
  accepted event history for each event. Long delta-heavy sessions therefore
  need a measured ordered fast path and completed-stream compaction before the
  Next daily-driver migration gate.
- AInativePM ownership and UI/domain integration have not been jointly audited;
  the old anchoring proposal is provisional.
- Process identity is positive at `/health`, but a data-directory mutex and
  cross-process repository lease do not yet exist; the listener is not yet
  explicitly loopback-bound.
- Runtime/setup subprocesses inherit a broad server environment. A least-
  privilege allowlist/scrub must prevent unrelated app secrets (including PM
  tokens) from reaching providers or repository commands.

## Active work

`CF-001` is sealed and its full `pnpm ci:check` gate passed. The slice replaces
the Claude-first split chat/delta path with the canonical transactional
conversation foundation described in `docs/event-contract.md`. Its guarded
merge, positive ancestry proof, and worktree teardown are the only remaining
closeout actions. After landing, the next safe slice is a bounded projector
scale/compaction pass before durable queue and interrupt state.
