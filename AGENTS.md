# PC-SDK Next

Provider-neutral, hardened continuation of the known-working PC-SDK baseline.
The original daily driver is preserved at
`E:\Claude Code Projects\Personal\PC-SDK` and tag
`working-v1-2026-07-11`. All new work happens in this fork.

## Authority and startup

- `docs/master-plan.md`: product scope, migration phases, and gates.
- `docs/requirements.md`: stable behavior IDs.
- `docs/architecture/boundaries.md`: component/data ownership.
- `docs/agent-runtime-architecture.md`: runtime/provider boundary.
- `docs/architecture/chat-communications.md`: target conversation semantics.
- `docs/worktree-lifecycle.md`: repository mutation, landing, and cleanup.
- `docs/current-state.md`: evidence-backed as-built state and known gaps.
- `docs/execution/current.md`: the one active slice and next safe action.
- `docs/pickup-protocol.md`: cross-session startup/close procedure.

Read this file, current state, execution handoff, the active slice, and every
boundary it names before writing. Historical phase documents explain the
baseline but do not override the active master plan.

## Mission and product boundary

Personal daily driver: projects, orchestrator chat, user-built specialists,
hardened contracts, run evidence, and the files/artifacts needed by those views.
No installer/releases/marketing until it earns them; code stays packageable.

- Browser plus one local server process. No Electron, agent-host, supervisor,
  or general workflow engine.
- One-click hidden launcher; DB-backed boot recovery replaces babysitting.
- Preserve the existing visual shell. Rework behavior/state ownership where an
  accepted requirement demands it; do not use architecture work as a redesign.
- UI surfaces: chat/session/run views, specialist builder/roster, MCP manager,
  usage/context, settings, and attention. No board, workflow builder, terminal,
  or general file browser.
- DB is durable truth; processes, sockets, and UI are projections.

## Modular-monolith rules

One process and one SQLite database, divided into explicit components. A
component owns its state and transition rules. Other components use published
commands, queries, DTOs, events, ports, and receipts; they do not manipulate its
tables, import its implementation, or reproduce its state machine.

Durable transitions and outbox events commit together. Unknown, unavailable,
stale, unsupported, and inconclusive are explicit states. Timeouts never imply
success. Every core invariant gets a guard test.

## Runtime and account boundary

PC-SDK owns projects, chat, transcripts, contracts, dispatch, verification,
tools/MCP policy, permissions, usage normalization, switching, and handoff.
Claude Agent SDK and OpenAI Codex are peer `AgentRuntimeAdapter`
implementations. Only adapter/composition modules may import provider packages,
parse native events, or know native session shapes.

- Subscription-first auth. Claude uses Claude Code login; Codex uses ChatGPT
  login. Raw APIs are separate billed runtimes requiring an explicit decision.
- Scrub `ANTHROPIC_API_KEY` and `ANTHROPIC_AUTH_TOKEN` from Claude spawn env so
  they cannot shadow subscription credentials.
- Credential homes are runtime-aware (`CLAUDE_CONFIG_DIR`, `CODEX_HOME`). The
  working and Next apps intentionally share provider login homes and quota, but
  not app databases or session records.
- Selection is runtime/account/model/effort and immutable per app session.
  Changing it creates a new app session. Native continuation is allowed only by
  a positive adapter capability/receipt. Cross-provider continuity is an
  attributed PC-SDK handoff, never fake resume.
- Models, effort values, context, MCP, approvals, structured output, usage, and
  stream granularity are adapter capabilities. Unsupported means typed visible
  degradation, never fallback.
- Prior fleet testing saw Claude headless-subscription warnings/bans on 6/15
  accounts. Stop at any account warning and reassess; never silently switch to
  API billing.

## Conversation boundary

User, assistant, safe activity, tool, agent, control, telemetry, and system
events are separate canonical families. Server sequence is authoritative;
timestamps and socket arrival are not ordering mechanisms. User messages queued
during a turn are durable FIFO state. Interruption requires a positive receipt.

Always show honest orchestrator activity without exposing private
chain-of-thought. Tool calls and agent communication have typed lifecycles.
Replay after reconnect/restart must yield the same ordered projection without
duplicate effects or orphan stream bubbles.

Context and subscription quota are separate. Context reports exact,
approximate, compacted, or unavailable. Quota UI always shows consumed/used,
even when the provider reports remaining, while retaining native semantics and
confidence.

## Specialists, contracts, and delivery

A specialist is a revisioned provider-neutral charter plus runtime/account/
model/effort defaults, prompt policy, tools, MCP attachments, permissions,
limits, and expected-output defaults. Orchestrator and specialists use the same
runtime adapter contract.

No run starts without a non-empty typed contract. The typed submitted
deliverable—not final prose—is authoritative. Verification distinguishes pass,
fail, and inconclusive; missing evidence never passes.

Repository delivery is fixed plain code, not a workflow engine:

```text
Contract -> Provision -> Prepare -> Readiness -> Plan?
-> Build -> Verify -> Review? -> Fix? -> Merge -> Teardown
```

Every tracked mutation, including code, docs, configuration, migrations, and
generated files, occurs in a recorded run-owned worktree. The main checkout is
read-only and stays on `main`. Parallel builders use separate worktrees;
landing is serialized and revalidated against current base. Merge needs
positive ancestry proof. Teardown needs proven landing or explicit approved
abandonment. Conflict/failure/cancellation/stranding/uncertainty preserves work.

Until a cross-process repository lease lands, never configure the working app
and PC-SDK Next to perform write-capable runs against the same external
repository at the same time; current landing locks are process-local.

## MCP and AInativePM

The global MCP registry is PC-SDK-owned: register once, vault-backed auth,
health/tool cache, and explicit per-consumer attachment policy. Adapters compile
that same policy into native delivery. Provider-native tools are opt-in.
MCP failure degrades visibly and never blocks unrelated chat or execution.

AInativePM is broader than software work. Its code, domain, UI, and MCP surface
must be jointly inspected before deeper integration is designed. Contracts may
carry external PM references; PC-SDK does not create an internal PM/work-item
system. Both app instances currently share the same user-scope AInativePM remote
and credentials, so new automated PM writes remain out of scope until discovery
defines ownership and idempotency.

## Fork operations

- Checkout: `E:\Claude Code Projects\Personal\PC-SDK-Next`
- GitHub: `emersonmccuin-pixel/pc-sdk-next` (`origin`)
- Stable source: `emersonmccuin-pixel/pc-sdk` (`upstream`, fetch-only)
- Default server/dev ports: 5124/5175
- Data: repo-local `data`; logs: `%LOCALAPPDATA%\PC-SDK-Next\logs`
- Launcher/shortcut/health identity: `PC-SDK Next` / `pc-sdk-next`

Do not push to or mutate the stable repository from this fork. Do not point
`PC_DATA_DIR` at the working app's data. The persisted display setting named
`dataDir` is not the DB selector; launch-time `PC_DATA_DIR` is authoritative.

## Working rules

- One path only; no shims or compatibility layers.
- Make the smallest coherent slice; do not silently widen it.
- Use dynamic agents only for bounded work where parallelism, specialization,
  or context hygiene materially helps. Read-heavy lanes parallelize freely;
  shared contracts, migrations, integration, and landing serialize.
- Root agent retains user intent, architecture synthesis, acceptance, and
  landing responsibility.
- Preserve unrelated user work. Never use destructive Git commands to recover.
- Use positive receipts over inference and plain-English explanations to the
  user, leading with the result.
- Keep `pnpm ci:check` green. Run focused checks plus verification proportional
  to risk; `pnpm smoke` is the live Claude check when explicitly required.
- Close every slice by updating its receipt, `docs/current-state.md`, and
  `docs/execution/current.md`, then leave a clean, known branch/worktree state.
