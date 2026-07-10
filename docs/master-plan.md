# Master Plan — PC-SDK

The build-out plan. AGENTS.md holds the locked technical decisions; this expands them into the product definition, the keep/redefine/drop ledger, and the phase plan with gates. `docs/agent-runtime-architecture.md` defines the provider/runtime boundary; `docs/worktree-lifecycle.md` defines repository mutation, landing, and cleanup. When they conflict, this file wins for scope, AGENTS.md wins for technical constraints.

## What this app is

A **personal daily-driver** where you run projects by talking to an orchestrator, which dispatches a roster of AI specialists you build yourself. Every dispatch runs under a machine-checkable contract in an isolated worktree. Project management lives in AInativePM (external, over MCP) — this app does the *doing*, not the tracking.

Not a public product. No installer, no releases, no marketing — until it earns it. Code stays shaped so packaging could be added later without rework.

## Decisions (2026-07-10, with Emerson)

| Decision | Choice |
| --- | --- |
| Posture | Personal tool first. Public later only if it earns it. |
| Shell | Browser + one local server process. No Electron, no separate agent-host, no supervisor process. |
| Keep-alive + launch | **One-click, no terminal.** Server runs as an auto-start Windows service; UI is an installed browser app (Edge/Chrome app mode) pinned to the taskbar. The pinned icon runs a hidden launcher: engine up → open window; engine down → start it silently, then open. First version of the launcher ships in Phase 2 (daily-drive gate depends on it); full service install in Phase 5. Design rule either way: **server boot recovers from the DB** — interrupted work is re-driven or failed loudly, never lost. |
| Specialists | **Full builder survives.** Define experts in plain English; per-specialist runtime/account/model/effort, prompt, tools, and MCP attachments; roster UI. |
| Agent runtimes | **PC-SDK is the app; runtimes are adapters.** Claude Agent SDK and OpenAI Codex are peer implementations behind one canonical contract. No provider-native types or branches in core product behavior. |
| Repository mutation | **Worktrees always.** Every agent-produced repo change, including small code/docs/config edits, happens in a run-owned worktree. Review depth is policy-controlled; isolation is not. |
| Delivery | **Plan → Build → Review/Verify → Fix → Merge → Teardown.** Known phases in plain code, not a workflow engine. Orchestrator review is default; independent review is escalation; auto-merge is opt-in and receipt-gated. Parallel builders, serialized per-repo landing. |
| UI surfaces | Chat + agent run views · MCP manager · usage/quota dashboard. **No board, no workflow builder, no files browser.** |
| MCP manager | Rebuild, don't port. The old one is unreliable — reliability is the requirement, not a feature. See below. |
| UI | **Port the Caisson shell wholesale — no redesign.** The carefully-crafted layout is the spec: left rail, right activity rail, status bar, settings, agent click-through. Changes limited to rewiring data sources and deleting dead surfaces. Do not revisit layout/interaction decisions that already work. |

Plus everything locked in AGENTS.md: subscription-first auth (Claude Max and ChatGPT/Codex; no API key by default), runtime-aware account switcher, one canonical agent-runtime adapter contract, mandatory worktree isolation, guarded service-controlled landing/teardown, no internal work items, DB as source of truth.

## From Caisson: keep / redefine / drop

**Keep (port mostly as-is)** — contract model + acceptance-criteria evaluator, `pc_*` tool registry + MCP serving, ~2/3 of DB schema, mailbox, live-outbox relay, worktree service, stock specialist prompts, utils.

**Keep — the whole UI shell** (port as the frame, not parts):
- *Layout:* `Shell`, `LeftRail`, right rail (`ActivityPanel` + `CommandActivityPanel`), `StatusBar`, `Tabs`, `ConversationHeader`, `SessionsRail`/`SessionSwitcher`.
- *Agent inspection:* `AgentsList` → `AgentTranscriptModal`/`RichAgentTranscript`/`TranscriptRow` — the click-into-an-agent's-work flow, intact.
- *Specialists:* `PodDetailModal` + tabs (Context/Settings/Secrets/History) and `CreatePodModal` become the specialist detail + builder.
- *Settings:* `AppSettingsModal`, `ProjectSettingsPanel`, project modals.
- *Content:* `Markdown`, `MermaidBlock`, chat bubbles, diff views, attachments + lightbox, `UsageCapsPanel` (seeds the usage dashboard).
- *Chrome:* design system, `ErrorBoundary`, onboarding, dev controls.

**Redefine (same job, new shape)**
- *Agent engine:* PTY-driven `claude.exe` terminals → provider-neutral PC-SDK runtime sessions driven by concrete adapters. First adapters: Claude Agent SDK and OpenAI Codex app-server/SDK. `codex exec` is a spike/non-interactive fallback, not the architecture. Dispatch → contract → verify → land survives intact as app-owned behavior.
- *Pods → Specialists:* same idea, minus the terminal. A specialist = name + plain-English charter + runtime/account/model/effort defaults + instruction policy + tool set + MCP attachments. Builder UX: describe the expert, app assembles the specialist, you edit the result.
- *Supervisor:* separate babysitter process → boot-time recovery inside the one server.
- *Cost meter → usage dashboard:* the real constraint is provider-specific subscription limits per runtime/account, not dollars. Show positively observed headroom; telemetry without a provider equivalent is visibly unavailable. API-equivalent $ may remain a gauge where meaningful.
- *Workflows → one delivery lifecycle:* Provision/Readiness → optional Plan → Build → deterministic Verify → orchestrator review by default, optional independent Review/Fix, or policy-gated auto-merge → Merge → Teardown. Hardcoded in plain code. No engine, builder, or graph. Worktree isolation is mandatory even when expensive phases are skipped.

**Drop (delete, don't carry)** — PTY runtime, agent-host, workflow engine + builder UI (`WorkflowGraphV2`, `WorkflowsList`, `CreateWorkflowModal`), work items + board (`KanbanBoard`, work-items components — AInativePM owns PM), xterm UI + `TerminalModePanel`, JSONL tailing/echo-ack plumbing, Electron shell + packaging, files browser UI (file *endpoints* stay only where run views need diffs/deliverables).

## Architecture (one page)

- **One server process** (Hono/Express, Node): API + WebSocket streaming + runtime registry/adapters + agent runner + MCP client + SQLite. Serves the built web UI. Provider runtime children are server-owned execution details, not separate PC-SDK hosts or supervisors.
- **Browser UI** (React, ported design system): chat, run views, roster, MCP manager, usage dashboard.
- **Agent runtime adapters** = Claude Agent SDK, OpenAI Codex, and future implementations behind one canonical session/event/capability contract. The orchestrator and specialists use the same abstraction. Full boundary: `docs/agent-runtime-architecture.md`.
- **Agents** are PC-SDK definitions and runs, not provider processes. Repo work is always worktree-isolated. Server/runtime dies → DB recovery re-drives or fails loudly.
- **Worktree lifecycle** is app-owned: one run owns one feature branch/worktree from provisioning through teardown. Project-configured preparation/readiness receipts precede agents; builders can run concurrently; a per-repo landing queue serializes guarded merges; stale-base work is revalidated; uncertain/conflicted work is preserved. Full contract: `docs/worktree-lifecycle.md`.
- **Orchestrator** reads the main project but does not mutate it. It authors/approves contracts, reviews worktree diffs and receipts, requests Fix, and authorizes landing. Deterministic PC-SDK services—not model-generated Git commands—perform merge and teardown.
- **DB (SQLite) is the source of truth.** `conversation_events` transcript store; everything live is a projection.
- **Sessions:** every app session snapshots runtime, account, model, and native runtime session id. Resume uses that exact adapter/account. Runtime/account/model switching creates a new app session; cross-runtime continuity is an explicit app-owned handoff.
- **Accounts:** runtime-aware registry. Claude login homes are selected with `CLAUDE_CONFIG_DIR`; Codex/ChatGPT login homes with `CODEX_HOME`; per-project default and per-dispatch override. Credentials never enter project settings or transcripts.
- **MCP registry** is global and app-owned: register a server once (URL/stdio + auth via vault), attach per consumer (orchestrator, specialist), health-probed, tool list cached. Adapters translate the same attachment policy into native MCP/tool delivery.

## MCP manager — reliability requirements

The old one failed quietly. The rebuild's bar:

1. **No silent failure.** Every probe, connect, and tool call ends in an explicit state — healthy, degraded (with reason), or down (with reason). Unknown is a state, never a guess.
2. **Health is visible.** Manager UI shows per-server: status, last successful probe, tool count, last error verbatim.
3. **Self-healing connects.** Reconnect with backoff; a flapping server is marked degraded, not toggling healthy/down.
4. **Auth in the vault.** Tokens/keys stored once, never in config files; expired auth is a distinct, actionable state.
5. **Stale tools can't be called.** Tool-list cache invalidates on reconnect; a tool that vanished returns a typed error, not a hang.
6. **Attachment is explicit.** A consumer (orchestrator, specialist) only sees servers attached to it, with per-attachment policy.
7. **Degrade, never block.** Chat and dispatch work fully with any MCP server unreachable — including AInativePM. The outage is a visible state, not a stoppage.

AInativePM is the first registered server and the standing test case.

## Phases and gates

**Phase 0 — Claude spike ✅** (done 2026-07-10). Claude Max subscription auth + Claude account switcher + usage meter proven in a CLI chat. This proved the first runtime path, not a Claude-only product architecture.

**Phase 1 — Port the foundation. ✅ Gate met 2026-07-10** — CI green (typecheck + tests + dead-import grep), event contract written first (docs/event-contract.md). First deliverable: the **event contract doc** (server-emitted shapes for chat / agent status / run progress) — the spine everything rewires to. Then copy trimmed `db`, `domain`, `contracts`, `mcp`, `app-services`, `utils` from PC-PTY-Chat; delete workflow/work-item/PTY modules; trim `contracts` (dual-purpose — 3 `runtime-*` wire modules die). Stand up the CI floor (typecheck + tests + dead-import grep as a CI check). Timebox: a package that fights >2 days gets rewritten smaller. In parallel: the one-day spike soak (quota headroom + account warnings under real load).
*Gate:* CI green on `pnpm -r typecheck`; grep for PTY/workflow/work-item imports comes back empty; event contract written.

**Phase 2 — Orchestrator chat in the browser. ✅ Built 2026-07-10; gate week open** — smoke passed (real Claude SDK turn), launcher verified end-to-end, AInativePM attached + healthy, kill-test standing in CI. Remaining: the week of daily driving itself. PM anchoring scoped in docs/pm-anchoring.md (v1 queued). Server boot + DB + boot recovery skeleton; Claude SDK loop per project with native resume; `conversation_events` persistence; WS streaming; **the ported Caisson shell** (left rail, right activity rail, status bar, settings, chat bubbles/markdown) rewired to the new event stream — dead tabs removed, layout untouched; Claude account switcher; usage panel. MCP *client core* wired in so the orchestrator can call AInativePM (config-driven registration is fine at this phase — manager UI comes later). **One-click launch v1:** pinned taskbar icon → hidden launcher (start engine if down) → app-mode window. No terminal in daily use from here on. **Kill-test** ships with the boot-recovery skeleton: kill the server mid-run → restart → everything re-driven or failed loudly — a standing test from here on. Phase 2's `RunnerBackend` is the precursor to, not the final vocabulary of, the runtime adapter contract.
*Gate:* daily-drive a real project's chat for a week — launched only from the taskbar icon — including PM actions through AInativePM. The week doubles as the quota-consumption experiment.

**Phase 3 — Runtime adapters, specialists, and worktree lifecycle.** First perform a behavior-preserving extraction: define canonical runtime events/capabilities, move all Claude-native types and mappings into `ClaudeRuntimeAdapter`, and keep the existing orchestrator green through conformance + smoke + resume/interrupt/ask/kill-recovery tests. Build the durable worktree lifecycle before write-capable dispatch: contract → provision/prepare/readiness → agent phase(s) → sealed commit → deterministic verification → orchestrator review by default or policy-gated auto-merge → serialized guarded merge → receipt-gated teardown. Build dispatch and run views against those app-owned runtime/lifecycle contracts. Then prove the runtime boundary with a ChatGPT-subscription Codex spike and `CodexRuntimeAdapter` (app-server/SDK), runtime-aware accounts/model discovery, and the same conformance suite. Each specialist selects runtime/account/model/effort plus prompt/tools/MCP. After both adapters pass, expose project-scoped orchestrator runtime switching with explicit new-session semantics.
*Gate:* (1) the existing Claude orchestrator passes unchanged through the extracted adapter; (2) no write-capable agent can start outside a recorded, ready worktree; (3) parallel specialists can build safely while per-repo landing remains serialized; (4) a specialist lands a real fix end-to-end through each runtime with sealed deliverable, verification, merge, and teardown receipts; (5) stale base/conflict/kill tests preserve or recover work correctly; (6) the orchestrator can switch runtime by creating a correctly stamped new session and resume each prior session through its original adapter/account.

**Phase 4 — MCP manager + lifecycle policy + usage dashboard.** MCP manager UI meeting the reliability requirements; policy/UX over the Phase 3 hardcoded Plan → Build → Review/Verify → Fix → Merge → Teardown lifecycle (cheap orchestrator-review default, full-review escalation, auto-merge eligibility); usage dashboard with provider-aware per-runtime/account headroom.
*Gate:* kill/revive an MCP server mid-session and watch every state change surface correctly; run the pipeline on a real work item from AInativePM.

**Phase 5 — Daily-driver hardening (as needed).** Auto-start Windows service (launcher then never needs to cold-start the engine); boot-recovery soak; polish list driven by actual daily use. No fixed scope — intake is whatever using it surfaces.

## Rules that carry over

- One path only — a fix deletes the old path.
- Positive receipt over inference — timeouts become typed failures, never fake success.
- Contract + provisioned isolation before any agent starts, or refuse loudly.
- DB is the source of truth; processes are projections.

## Premortem — how this fails, and the rules that prevent it

Ranked by kill-probability. Each mitigation is binding.

1. **The rewrite stalls; Caisson quietly wins.** Phase 1 is all foundation, no usable product. *Rules:* Phase 1 is timeboxed — a package that fights >2 days gets rewritten smaller, not wrestled. Phase 2 scope is minimum-lovable chat; the moment browser chat works, daily driving switches to the new app, rough edges and all.
2. **The port drags old architecture in through the side door.** Ported code is wired to plumbing we're deleting; shims accumulate into dual paths. *Rules:* the **new event contract** (server-emitted shapes for chat / agent status / run progress) is written **before any UI porting** — everything rewires to it in one pass. **No shims, no compatibility layers, ever.**
3. **A subscription runtime changes terms, auth, or automation behavior** (prior Claude fleet testing saw 6/15 bans; Codex entitlements can also evolve). *Rules:* provider packages, credentials, native sessions, and events stay inside adapters; no API-key fallback is silently activated. Soak each runtime under real personal load, watch warnings, and stop at the first account warning.
4. **Quota walls make the daily driver unusable mid-day.** *Rules:* every dispatch declares runtime/account/model/effort so work can be intentionally placed. The gate week and per-runtime spikes are consumption experiments; the dashboard reports provider-specific headroom without inventing parity.
5. **Boot recovery turns out to be a slogan** — crash mid-dispatch strands worktrees/contracts silently. *Rules:* a kill-test (kill server mid-run → restart → assert re-driven or failed loudly) is a standing Phase 2 test, not a Phase 5 soak item. Stranded-worktree surfacing is ported, not dropped.
6. **AInativePM outage takes PM down with it** (external, Railway-hosted, personal project). *Rule:* **degrade, never block** — chat and dispatch work fully with PM unreachable, shown as a visible state.
7. **Quality erosion with no backstop** in a fresh repo built largely by agents. *Rules:* CI floor lands in Phase 1 (typecheck + tests + the no-PTY/workflow/work-item-imports grep as a CI check). Every core invariant gets a guard test when built (old app's dispatch-invariant pattern).
8. **Runtime churn** — both Claude Agent SDK and Codex app-server/SDK evolve. *Rules:* pin versions/protocol schemas; upgrades are deliberate and adapter-local; adapter conformance plus a real subscription spike must pass before upgrade.
9. **Windows service auth jank** — a service not running as the user cannot see Claude or Codex login homes/credential stores. *Rule:* service must run as the user; launcher-started hidden process is the sanctioned fallback if that proves flaky.
10. **The second runtime gets jammed into Claude-shaped core code.** *Rules:* Phase 3 extracts the canonical boundary before Codex lands; provider-native vocabulary remains adapter-local; runtime/account/model are immutable session stamps; no compatibility wire or provider conditionals outside composition.
11. **"Small" agent edits leak into the main checkout.** *Rules:* task size changes review policy, never isolation. Write-capable runtime sessions require a recorded ready worktree; the orchestrator has read-only project tools; merge/teardown are app service calls.
12. **Parallel work corrupts landing or silently validates against a stale base.** *Rules:* one branch/worktree per run, declared-scope overlap visibility, per-repo landing mutex/queue, current-base reconciliation, revalidation after base advancement, and positive ancestry receipt before teardown.
13. **Auto-merge becomes model self-approval.** *Rules:* only contract policy plus PC-SDK-derived evidence can grant eligibility; builder prose is not evidence; missing/warning/inconclusive predicates fail closed to orchestrator review; conflicts and uncertainty preserve the worktree.
