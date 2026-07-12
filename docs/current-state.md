# Current state

Last updated: 2026-07-11 after CF-003 sealed verification.

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
- CF-001 landing merge: `6ea518bc6b520934aece30cbea94d201f4334b0b`
- CF-001 worktree: removed after positive sealed-commit and feature-tip
  ancestry proof; feature branch preserved
- CF-002 sealed implementation: `9ebf2c6284bebdae43f9263193999764a0c8413b`
- CF-002 closeout landing: `a5943690ddbcbbf11ce3838ffc6dcfc950b90b41`

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
- Incremental immutable browser projection with separate received/checkpoint and
  folded-sequence frontiers, indexed identity receipts, one replay normalization
  path, and digest-only evidence after completed stream payload compaction
- Adapter-local native message correlation; canonical terminal outcomes and
  stop reasons; historical private reasoning retained only as hidden migration
  evidence with no producer or render path
- Durable revisioned FIFO sends with atomic queue/event/outbox transitions,
  strict sender receipts, reconnect snapshots, restart re-drive, immutable
  claimed revisions, and visible edit/remove controls
- Durable requested/confirmed/failed interruption state: linked replacements
  release only on the exact typed abort terminal; timeout, shutdown, normal
  completion, stream failure, and restart uncertainty fail closed
- Composition-readiness gating for both recovered and freshly admitted sends;
  deleted projects and inactive/deleted sessions cannot mint or claim work
- Atomic new/resume/account-switch/project-delete conversation transitions,
  including safe cancellation and rollback. Until immutable account stamps
  land, pre-account-switch transcripts are view-only/non-resumable.

## Known architectural gaps

- Composition remains fixed to Claude and model defaults; there is no Codex
  adapter or runtime/model/effort switcher.
- Orchestrator sessions do not yet durably stamp the full runtime/account/model/
  effort selection needed for safe provider-neutral resume.
- Adapter capabilities/model discovery are specified but not implemented.
- Orchestrator session, account, usage, and some runtime-notice/permission
  vocabulary remain provider-shaped. Full immutable runtime/account/model/
  effort stamps and typed capability semantics remain N3 work.
- Usage DTOs are Claude-shaped and do not retain general source semantics,
  confidence, staleness, or runtime attribution.
- No honest per-session context-use contract exists yet.
- Private reasoning no longer crosses the canonical runtime or browser seams,
  but a typed safe operational-activity taxonomy and continuous honest waiting
  feedback still need their own N2 slice.
- AInativePM ownership and UI/domain integration have not been jointly audited;
  the old anchoring proposal is provisional.
- Process identity is positive at `/health`, but a data-directory mutex and
  cross-process repository lease do not yet exist; the listener is not yet
  explicitly loopback-bound.
- Runtime/setup subprocesses inherit a broad server environment. A least-
  privilege allowlist/scrub must prevent unrelated app secrets (including PM
  tokens) from reaching providers or repository commands.

## Active work

`CF-003` completes durable queued-send and positive interruption semantics on
the landed CF-001/CF-002 conversation foundation. Adversarial probes cover
restart/shutdown uncertainty, delayed runtime startup, boot readiness, stale
CAS and duplicate commands, socket failure, false abort classification, late
session-global native interruption, deleted projects, and atomic account/
session transitions. The compact existing composer shell exposes FIFO state,
edit/remove, interrupt-and-send, failure evidence, and safe view-only history.
The next safe conversation slice is `CHAT-007/CHAT-008`: typed honest activity
and complete tool-call lifecycle without private reasoning.
