# Phase 2 build plan — orchestrator chat in the browser

Scope per master-plan Phase 2. Wire shapes: `docs/event-contract.md` + `@pc/contracts` `src/events/` (the ONLY wire — never resurrect old names). Locked decisions: AGENTS.md.

## Decisions (2026-07-10)

- **Server:** Hono (`@hono/node-server`) + `ws`. One process. Serves `apps/web/dist` statically. Port 5123 (`PC_PORT` override). Package `@pc-sdk/server`.
- **Web:** Vite + React + TS. Package `@pc-sdk/web`. Ported Caisson shell, old file structure kept where sane.
- **SDK behind one adapter.** `apps/server/src/runner/` owns the only `@anthropic-ai/claude-agent-sdk` import. `RunnerBackend` interface; `SdkBackend` (real) + `FakeBackend` (tests, scripted turns). Tests and the kill-test run on `FakeBackend` — CI has no Claude login.
- **SDK mode:** streaming-input (one `query()` per active session, `AsyncIterable` prompt, turns via `streamInput`) so `interrupt()` works. `resume: sessionId` when re-attaching after restart. `includePartialMessages: true` → `chat-delta` frames.
- **Accounts:** registry `{ personal: C:\Users\emers\.claude, work: C:\Users\emers\.claude-work }` in settings; per-project default; selected via `CLAUDE_CONFIG_DIR` in the query env. Scrub `ANTHROPIC_API_KEY`/`ANTHROPIC_AUTH_TOKEN` from env. Switching account ⇒ new session.
- **Boot recovery v1 (chat):** on boot, any session/turn marked live in DB with no process behind it → emit `turn-failed { source: 'internal', error: 'server restarted mid-turn' }` + `session-state idle`, loudly. Never silently resume, never fake success.
- **Kill-test (standing):** test using FakeBackend + real SQLite file: start turn → hard-stop server mid-turn → boot → assert exactly one `turn-failed` persisted, no session stuck busy, replay is coherent. Lives in `apps/server/test/kill-recovery.test.ts`.
- **MCP client core:** registry rows in `mcp_servers` (AInativePM seeded from config/env on boot); probe on boot + on-demand; tools bridged into the SDK loop via `createSdkMcpServer` proxy tools. **Degrade, never block:** probe failure ⇒ status event + typed tool errors, chat unaffected.
- **Usage:** `rate_limit_event` + result usage → server cache per account → `usage` resource event (durable) + HTTP re-prime endpoint.
- **Launcher v1:** `launcher/pc-sdk.ps1` — health-check `http://localhost:5123/health`; if down, start server hidden (`Start-Process -WindowStyle Hidden`); open `msedge --app=http://localhost:5123`. Plus a script that creates the taskbar-pinnable `.lnk` (wscript/powershell hidden, custom icon ok later).

## apps/server layout

```
src/index.ts          boot: migrate → recovery → seed MCP registry → http+ws listen
src/boot-recovery.ts
src/ws/hub.ts         per-project rooms, heartbeat, connect snapshot (session-changed → orchestrator-state → session-replay → send-queue-snapshot), subscribe/lastVersion replay, live-reset
src/ws/router.ts      client frames: send | interrupt | ask-reply | subscribe | client-ping
src/http/             health, projects CRUD (minimal), sessions (new/resume/list/events), pasted-images, accounts, usage re-prime
src/chat/session-service.ts   seq allocation, persist-then-broadcast (guard rule 1), conversation_events
src/chat/send-queue.ts        busy-turn queue (statuses per contract)
src/chat/turn-runner.ts       drives RunnerBackend msgs → ChatEvents per the SDK mapping table
src/runner/           backend.ts (interface) | sdk-backend.ts | fake-backend.ts | account-env.ts
src/mcp/              registry.ts, probe.ts, bridge.ts (proxy tools into runner opts)
src/usage/            cache.ts → usage resource events
src/resources/        outbox relay (drain live_outbox → ResourceFrames)
```

## apps/web port ledger (from PC-PTY-Chat/apps/web)

- **Scaffold + chrome (first):** Vite config, design system/styles/tokens, `ErrorBoundary`, `Shell`, `LeftRail`, `StatusBar`, `Tabs`, `ConversationHeader`, `SessionsRail`/`SessionSwitcher`, `AppSettingsModal`, `ProjectSettingsPanel`, project modals, onboarding, dev controls. Account switcher + usage meter in header (new, small).
- **Chat surface:** chat bubbles, `Markdown`, `MermaidBlock`, diff views, attachments + lightbox, composer (send batching, optimistic placeholders), **new** `chat-store` (seq ordering, dedup by `sessionId:seq`, aggregate folding, delta buffers keyed by `sdkUuid`) + **new** `ws-client` (heartbeat, backoff, epoch, cursor) — both implement the contract exactly; the old reducer is reference only.
- **Activity + inspection:** `ActivityPanel` (running agents region only — workflows/work-items regions die), `AgentsList` → pod detail/create modals (roster read-only ok for Phase 2), `AgentTranscriptModal`/`RichAgentTranscript`/`TranscriptRow`, `UsageCapsPanel` (reads `usage` resource events).
- **Dead, do not port:** xterm/terminal panel, workflow builder/graph, kanban/work-items, files browser, JSONL debug surfaces.
- Old hooks that read `type:'jsonl'`/hook-events are replaced by the new store; keep component props stable where possible so JSX ports mostly intact.

## Definition of done (workflow integrate gate)

1. `pnpm ci:check` green (typecheck, all tests incl. kill-test + guard tests, dead-import gate).
2. Server boots, serves built web, `/health` ok.
3. FakeBackend integration test: WS connect → send → delta frames → persisted chat frames → turn-end → replay after reconnect matches (guard rule 6).
4. Real-SDK smoke = manual (needs login): `pnpm smoke` script sends one real turn; not in CI.
5. Launcher script opens the app window; server autostart verified manually.

Guard rules 1–7 from the contract each get a test in this phase where the mechanism lands (1, 2, 3, 4, 6 now; 5 in turn-runner unit tests; 7 is a type-level test already in contracts).
