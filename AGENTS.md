# PC-SDK (working name)

SDK-based rewrite of PC-PTY-Chat (`E:\Claude Code Projects\Personal\PC-PTY-Chat`). Fresh repo — not a fork. Portable packages get copied in, not inherited with history.

## Mission

Same product, no fluff: projects + orchestrator chat + agents with hardened contracts + files. Delete everything that existed only to drive the Claude Code CLI through a fake terminal.

## Locked decisions (2026-07-10)

- **Chat = Anthropic SDK** (Messages API tool runner, streaming, prompt caching, Opus). No PTY, no JSONL tailing, no echo-ack.
- **Agents = Claude Agent SDK and/or `codex exec`** behind one runner interface. Dispatch → contract → verify → land flow survives from PC-PTY-Chat.
- **No workflow engine.** One hardcoded pipeline in plain code: Plan → Build → Review/Verify → Fix.
- **No internal work items.** PM lives in AInativePM (`E:\Claude Code Projects\AInativePM`) over MCP — it's already a full MCP server (official SDK, stdio + HTTP, OAuth, hosted on Railway). Contracts carry an external PM-item ref, not a work-item FK.
- **MCP registry is a first-class global subsystem**: register once (URL/stdio + auth via vault), attach policy per consumer, health probe + tool-list cache. Orchestrator loop is the MCP *client* bridging tools into the tool runner (server-side MCP connector can't reach localhost); agents get MCP config natively.
- **DB is the source of truth** (carried over: `conversation_events` transcript store, live-outbox relay).
- **Billing:** API key, pay per token. Codex agents may ride the ChatGPT plan via `codex exec`. Gate: run the spike for a day, look at the number.

## Port map (from 3-agent code sweep of PC-PTY-Chat, 2026-07-10)

- **DELETE (~36k lines):** `packages/runtime` (PTY engine), `agent-host`, `workflows` engine, server host/JSONL/workflow/work-item buckets, web xterm + workflow builder + work-items UI, chat JSONL-envelope plumbing.
- **PORT (~25-30k):** contract model + ac-evaluator (`domain`), `pc_*` tool registry + MCP serving (`mcp`), ~2/3 of `db` schema, mailbox, live-outbox relay, worktree service, files endpoints, stock-pod-seed prompts, supervisor, utils, web design system + chat bubbles/markdown/diff.
- **REWRITE smaller (~8-10k):** agent-run-factory dispatch core, pause/resume, pod-spawn (→ "assemble system prompt + tools"), conversations send path, web chat reducer, server boot wiring.
- Watch: `contracts` package is dual-purpose (API DTOs + work contracts) — trim, don't delete; 3 `runtime-*` wire modules inside it die.

## Phases

0. **Spike (now):** `apps/spike` — tool-runner chat CLI with cost meter. Prove the feel + price. `pnpm spike` with `ANTHROPIC_API_KEY`.
1. **Port packages:** copy trimmed `db`, `domain`, `contracts`, `mcp`, `app-services`, `supervisor`, `utils` from PC-PTY-Chat; prune workflow/work-item/PTY modules to typecheck-green.
2. **Orchestrator server + web chat:** Hono/Express server, SDK loop per project, conversation_events persistence, WS streaming, minimal chat UI (port bubbles + design system).
3. **Agents + contracts:** Agent SDK / codex-exec runner, dispatch→contract→verify→land, worktree isolation, run views.
4. **MCP global + pipeline + files:** MCP registry hardening (AInativePM attach), Plan→Build→Review→Fix pipeline, files UI, polish.

## Rules

- One path only. Positive receipt over inference (timeouts → typed failure). Terse.
- Plain-English explanations to the user — lead with the result.
