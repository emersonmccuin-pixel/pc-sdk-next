# Master Plan — PC-SDK

The build-out plan. AGENTS.md holds the locked technical decisions; this expands them into the product definition, the keep/redefine/drop ledger, and the phase plan with gates. When they conflict, this file wins for scope, AGENTS.md wins for technical constraints.

## What this app is

A **personal daily-driver** where you run projects by talking to an orchestrator, which dispatches a roster of AI specialists you build yourself. Every dispatch runs under a machine-checkable contract in an isolated worktree. Project management lives in AInativePM (external, over MCP) — this app does the *doing*, not the tracking.

Not a public product. No installer, no releases, no marketing — until it earns it. Code stays shaped so packaging could be added later without rework.

## Decisions (2026-07-10, with Emerson)

| Decision | Choice |
| --- | --- |
| Posture | Personal tool first. Public later only if it earns it. |
| Shell | Browser + one local server process. No Electron, no separate agent-host, no supervisor process. |
| Keep-alive + launch | **One-click, no terminal.** Server runs as an auto-start Windows service; UI is an installed browser app (Edge/Chrome app mode) pinned to the taskbar. The pinned icon runs a hidden launcher: engine up → open window; engine down → start it silently, then open. First version of the launcher ships in Phase 2 (daily-drive gate depends on it); full service install in Phase 5. Design rule either way: **server boot recovers from the DB** — interrupted work is re-driven or failed loudly, never lost. |
| Specialists | **Full builder survives.** Define experts in plain English; per-specialist prompt, tools, MCP attachments; roster UI. |
| UI surfaces | Chat + agent run views · MCP manager · usage/quota dashboard. **No board, no workflow builder, no files browser.** |
| MCP manager | Rebuild, don't port. The old one is unreliable — reliability is the requirement, not a feature. See below. |
| UI | **Port the Caisson shell wholesale — no redesign.** The carefully-crafted layout is the spec: left rail, right activity rail, status bar, settings, agent click-through. Changes limited to rewiring data sources and deleting dead surfaces. Do not revisit layout/interaction decisions that already work. |

Plus everything locked in AGENTS.md: Max-subscription auth (no API key), account switcher, SDK `query()` chat loop, one hardcoded pipeline, no internal work items, DB as source of truth.

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
- *Agent engine:* PTY-driven `claude.exe` terminals → SDK calls in-process / `codex exec` child processes, behind one runner interface. Dispatch → contract → verify → land flow survives intact — it was the good part.
- *Pods → Specialists:* same idea, minus the terminal. A specialist = name + plain-English charter + system prompt + tool set + MCP attachments + default account. Builder UX: describe the expert, app assembles the specialist, you edit the result.
- *Supervisor:* separate babysitter process → boot-time recovery inside the one server.
- *Cost meter → usage dashboard:* the real constraint is plan rate limits (5-hour windows / weekly caps) per account, not dollars. Show headroom per account; API-equivalent $ stays as a gauge.
- *Workflows → one pipeline:* Plan → Build → Review/Verify → Fix, hardcoded in plain code. No engine, no builder, no graph.

**Drop (delete, don't carry)** — PTY runtime, agent-host, workflow engine + builder UI (`WorkflowGraphV2`, `WorkflowsList`, `CreateWorkflowModal`), work items + board (`KanbanBoard`, work-items components — AInativePM owns PM), xterm UI + `TerminalModePanel`, JSONL tailing/echo-ack plumbing, Electron shell + packaging, files browser UI (file *endpoints* stay only where run views need diffs/deliverables).

## Architecture (one page)

- **One server process** (Hono/Express, Node): API + WebSocket streaming + orchestrator SDK loop + agent runner + MCP client + SQLite. Serves the built web UI.
- **Browser UI** (React, ported design system): chat, run views, roster, MCP manager, usage dashboard.
- **Agents** = SDK queries or `codex exec` children, owned by the server, always in worktrees for repo work. Server dies → they die → boot recovery re-drives from the DB.
- **DB (SQLite) is the source of truth.** `conversation_events` transcript store; everything live is a projection.
- **Accounts:** registry of Claude logins (`personal` → `~\.claude`, `work` → `~\.claude-work`) selected via `CLAUDE_CONFIG_DIR` per dispatch; per-project default, per-dispatch override.
- **MCP registry** is global: register a server once (URL/stdio + auth via vault), attach per consumer (orchestrator, specialist), health-probed, tool list cached.

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

**Phase 0 — Spike ✅** (done 2026-07-10). Subscription auth + account switcher + usage meter proven in a CLI chat.

**Phase 1 — Port the foundation.** First deliverable: the **event contract doc** (server-emitted shapes for chat / agent status / run progress) — the spine everything rewires to. Then copy trimmed `db`, `domain`, `contracts`, `mcp`, `app-services`, `utils` from PC-PTY-Chat; delete workflow/work-item/PTY modules; trim `contracts` (dual-purpose — 3 `runtime-*` wire modules die). Stand up the CI floor (typecheck + tests + dead-import grep as a CI check). Timebox: a package that fights >2 days gets rewritten smaller. In parallel: the one-day spike soak (quota headroom + account warnings under real load).
*Gate:* CI green on `pnpm -r typecheck`; grep for PTY/workflow/work-item imports comes back empty; event contract written.

**Phase 2 — Orchestrator chat in the browser.** Server boot + DB + boot recovery skeleton; SDK loop per project with `resume`; `conversation_events` persistence; WS streaming; **the ported Caisson shell** (left rail, right activity rail, status bar, settings, chat bubbles/markdown) rewired to the new event stream — dead tabs removed, layout untouched; account switcher; usage meter in the header. MCP *client core* wired in so the orchestrator can call AInativePM (config-driven registration is fine at this phase — manager UI comes later). **One-click launch v1:** pinned taskbar icon → hidden launcher (start engine if down) → app-mode window. No terminal in daily use from here on. **Kill-test** ships with the boot-recovery skeleton: kill the server mid-run → restart → everything re-driven or failed loudly — a standing test from here on.
*Gate:* daily-drive a real project's chat for a week — launched only from the taskbar icon — including PM actions through AInativePM. The week doubles as the quota-consumption experiment.

**Phase 3 — Specialists and dispatch.** One runner interface (SDK + `codex exec`) — SDK touched only through the adapter, backend swappable; every dispatch declares its model tier (cheap work on cheap models by default); dispatch → contract → verify → land, worktree-isolated, ported acceptance evaluator; stranded-worktree surfacing ported; run views = the ported agent click-through (activity rail → transcript modal → rich transcript/diff/verdicts); specialist roster v1 — ported pod detail/create modals become the builder (describe → assemble → edit), per-specialist prompt/tools/MCP/account.
*Gate:* a specialist lands a real fix on this repo end-to-end — contract created, worktree provisioned, verified, landed — driven from chat.

**Phase 4 — MCP manager + pipeline + usage dashboard.** MCP manager UI meeting the six reliability requirements; the hardcoded Plan → Build → Review/Verify → Fix pipeline over the phase-3 dispatch machinery; usage dashboard (per-account window/weekly headroom).
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
3. **Anthropic pulls the rug on subscription automation** (fleet testing saw 6/15 bans; ToS/SDK auth could shift). *Rules:* nothing outside one adapter module touches the SDK — runner backend stays swappable (API key / `codex exec`). Run the deferred spike soak: one full day of real load watching quota + warnings. Stop and reassess at the first account warning.
4. **Quota walls make the daily driver unusable mid-day.** *Rules:* every dispatch declares its model tier — cheap work on cheap models by default. The Phase 2 gate week doubles as the consumption experiment; usage dashboard makes headroom visible before it bites.
5. **Boot recovery turns out to be a slogan** — crash mid-dispatch strands worktrees/contracts silently. *Rules:* a kill-test (kill server mid-run → restart → assert re-driven or failed loudly) is a standing Phase 2 test, not a Phase 5 soak item. Stranded-worktree surfacing is ported, not dropped.
6. **AInativePM outage takes PM down with it** (external, Railway-hosted, personal project). *Rule:* **degrade, never block** — chat and dispatch work fully with PM unreachable, shown as a visible state.
7. **Quality erosion with no backstop** in a fresh repo built largely by agents. *Rules:* CI floor lands in Phase 1 (typecheck + tests + the no-PTY/workflow/work-item-imports grep as a CI check). Every core invariant gets a guard test when built (old app's dispatch-invariant pattern).
8. **SDK churn** — `@anthropic-ai/claude-agent-sdk` is young. *Rule:* pin the version; upgrades are deliberate, behind the adapter from #3, with a spike test.
9. **Windows service auth jank** — a service not running as the user can't see the Claude logins. *Rule:* service must run as the user; launcher-started hidden process is the sanctioned fallback if that proves flaky.
