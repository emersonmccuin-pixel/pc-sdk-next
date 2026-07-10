# PC-SDK (working name)

SDK-based rewrite of PC-PTY-Chat (`E:\Claude Code Projects\Personal\PC-PTY-Chat`). Fresh repo — not a fork. Portable packages get copied in, not inherited with history.

**Build-out plan: `docs/master-plan.md`** — product scope, keep/redefine/drop ledger, phases with gates. This file holds the locked technical decisions; the plan wins on scope.

## Mission

Same product, no fluff: projects + orchestrator chat + agents with hardened contracts + files. Delete everything that existed only to drive the Claude Code CLI through a fake terminal.

## Locked decisions (2026-07-10)

- **Personal tool first.** No installer/releases/marketing until it earns it; code stays packageable.
- **Browser + one local server process.** No Electron, no agent-host, no supervisor process. Boot recovery from DB replaces the babysitter.
- **One-click launch, no terminal.** Pinned taskbar icon → hidden launcher (starts engine if down) → browser app-mode window. Launcher v1 in Phase 2; auto-start Windows service in Phase 5.
- **Full specialist builder survives** (pods, redefined): plain-English charter → prompt + tools + MCP attachments + account, roster UI.
- **UI surfaces:** chat + run views, MCP manager (rebuilt for reliability — see plan), usage dashboard. No board, no workflow builder, no files browser.

- **Auth = Max subscription, no API key.** Everything runs on the Claude Agent SDK (`@anthropic-ai/claude-agent-sdk`), which uses the Claude Code login from the selected config dir. Scrub `ANTHROPIC_API_KEY`/`ANTHROPIC_AUTH_TOKEN` from spawn env — they'd shadow the subscription credential. Known risk: prior fleet testing saw headless-subscription bans (6/15 accounts); single personal/work accounts assumed acceptable — user's call, revisit if warnings appear.
- **Account switcher = core subsystem.** `CLAUDE_CONFIG_DIR` in the SDK's per-query `env` selects the login: `personal` → `C:\Users\emers\.claude`, `work` → `C:\Users\emers\.claude-work`. Registry of accounts; per-project default + per-dispatch override. Sessions live in the config dir, so switching accounts = new session.
- **Chat = Claude Agent SDK `query()` loop** (streaming, per-turn `resume: sessionId`, custom tools via `createSdkMcpServer`). No PTY, no JSONL tailing, no echo-ack. (Raw Messages API rejected: API-key-only.)
- **Agents = Claude Agent SDK and/or `codex exec`** behind one runner interface. Dispatch → contract → verify → land flow survives from PC-PTY-Chat.
- **No workflow engine.** One hardcoded pipeline in plain code: Plan → Build → Review/Verify → Fix.
- **No internal work items.** PM lives in AInativePM (`E:\Claude Code Projects\AInativePM`) over MCP — it's already a full MCP server (official SDK, stdio + HTTP, OAuth, hosted on Railway). Contracts carry an external PM-item ref, not a work-item FK.
- **MCP registry is a first-class global subsystem**: register once (URL/stdio + auth via vault), attach policy per consumer, health probe + tool-list cache. Orchestrator loop is the MCP *client* bridging tools into the tool runner (server-side MCP connector can't reach localhost); agents get MCP config natively.
- **DB is the source of truth** (carried over: `conversation_events` transcript store, live-outbox relay).
- **Billing:** subscription-covered (Max plan quota, not dollars). The spike's cost meter shows API-equivalent $ as a usage gauge; the real constraint is plan rate limits (5-hour windows / weekly caps). Codex agents may ride the ChatGPT plan via `codex exec`. Gate: run the spike for a day, watch quota headroom.

## Port map (from 3-agent code sweep of PC-PTY-Chat, 2026-07-10)

- **DELETE (~36k lines):** `packages/runtime` (PTY engine), `agent-host`, `workflows` engine, server host/JSONL/workflow/work-item buckets, web xterm + workflow builder + work-items UI, chat JSONL-envelope plumbing.
- **PORT (~25-30k):** contract model + ac-evaluator (`domain`), `pc_*` tool registry + MCP serving (`mcp`), ~2/3 of `db` schema, mailbox, live-outbox relay, worktree service, files endpoints, stock-pod-seed prompts, utils, **the whole web shell** — Shell/LeftRail/ActivityPanel/StatusBar/settings/agent-transcript click-through/pod modals + design system + chat bubbles/markdown/diff (see master plan for the component ledger). UI rule: port, don't redesign.
- **REWRITE smaller (~8-10k):** agent-run-factory dispatch core, pause/resume, pod-spawn (→ "assemble system prompt + tools"), conversations send path, web chat reducer, server boot wiring.
- Watch: `contracts` package is dual-purpose (API DTOs + work contracts) — trim, don't delete; 3 `runtime-*` wire modules inside it die.

## Phases (gates + detail in `docs/master-plan.md`)

0. **Spike ✅** (2026-07-10): `apps/spike` — SDK chat CLI on the Max plan, account switcher + usage meter. Subscription auth proven.
1. **Port the foundation:** copy trimmed `db`, `domain`, `contracts`, `mcp`, `app-services`, `utils` from PC-PTY-Chat (no `supervisor` — boot recovery replaces it); prune workflow/work-item/PTY modules to typecheck-green.
2. **Orchestrator chat in the browser:** server + boot recovery, SDK loop per project, conversation_events, WS streaming, chat UI, account switcher, MCP client core (AInativePM attached via config), one-click taskbar launcher v1.
3. **Specialists + dispatch:** SDK/codex-exec runner, dispatch→contract→verify→land, worktrees, run views, specialist builder v1.
4. **MCP manager + pipeline + usage dashboard:** manager UI meeting the reliability bar, hardcoded Plan→Build→Review→Fix pipeline, per-account quota headroom.
5. **Daily-driver hardening:** Windows service, boot-recovery soak, polish from real use.

## Rules

- One path only. Positive receipt over inference (timeouts → typed failure). Terse.
- **No shims, no compatibility layers.** Ported code rewires to the new event contract in one pass.
- **SDK behind one adapter.** Nothing outside it imports `@anthropic-ai/claude-agent-sdk`; version pinned; upgrades deliberate.
- **Degrade, never block** on MCP outages (incl. AInativePM).
- Every core invariant gets a guard test when built.
- Plain-English explanations to the user — lead with the result.
