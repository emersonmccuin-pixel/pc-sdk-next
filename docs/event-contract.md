# Event Contract — PC-SDK

v1, 2026-07-10. Every shape the server emits to the browser, and every client→server message. This is the spine: all ported code rewires to these shapes in one pass. No shims, no compatibility layers. Types land in `packages/contracts/src/events/` as the single source; this doc is the design record.

Sources: `docs/research/event-contract-research.json` (what the old UI actually consumes; what the SDK emits). Fields nobody reads were not carried.

## Principles

- **DB is the source of truth; sockets are projections.** Chat events persist before they broadcast — a broadcast can never precede its durable write.
- **Two durable replay systems, deliberately separate.** Chat replays by per-session `seq`; resources replay by a global cursor. Their recovery semantics differ; do not merge.
- **Three delivery classes.** Durable-chat, durable-resource, and latency-class (no replay — consumers heal via HTTP on reconnect). Every event type belongs to exactly one.
- **Unknown-tolerant both ways.** Client drops unknown `type`/`kind` silently. Server drops unknown SDK message variants silently (the SDK union grows).
- **Positive receipt.** Errors and timeouts are typed events, never silence. `isError`, `failureReason`, `cause` are read and rendered — the old contract carried `tool-result.isError` and dropped it; this one renders it.
- **Structured over scraped.** Dispatch lifecycle and verification verdicts are events, not `[pc:agent-event …]` text markers parsed out of prose. The marker protocol is dead.

## Transport

One WebSocket per project: `GET /ws?projectId=<ulid>`. JSON text frames. Multi-tab is first-class (N sockets per project; broadcast to all, acks only to sender).

Heartbeat: client sends `client-ping` every interval; server answers `server-pong`; any inbound frame counts as liveness. Client treats silence as death: close(4000), reconnect with 2/5/15/30s backoff, force-reconnect on visibility/online/focus.

On every socket open, in order:
1. `session-changed` (current session or null)
2. `orchestrator-state` (current snapshot)
3. `session-replay` (full checkpoint of the active session)
4. `send-queue-snapshot`
Then the client sends `subscribe { lastVersion }` and the server replays resource events `(lastVersion, head]` — or `live-reset` if the cursor predates the pruned floor. The client also bumps its ws-epoch on open so every HTTP-seeded list refetches. Cursor replay + epoch refetch are both kept, deliberately (belt and suspenders — the epoch bump is what killed the "refresh to see new agents" bug).

## Channel 1 — Chat (durable, per-session seq)

### Envelope

```ts
type ChatFrame = {
  type: 'chat'
  projectId: Ulid
  sessionId: string
  seq: number                 // per-session monotonic, allocated at persist time
  id: `${sessionId}:${seq}`   // THE dedup key; UNIQUE(session_id, seq) in DB
  clientMessageId?: string    // stamped server-side on the user-turn row before broadcast
  event: ChatEvent
}
```

Rules (all carried from the old system — they work):
- Single writer allocates `seq`; persist to `conversation_events`, then broadcast the same payload.
- Reducer replaces on duplicate `id` **without re-folding aggregates** (re-delivery must not double-count tokens) and inserts out-of-order arrivals into seq position.
- Frames with a `sessionId` ≠ active session are dropped client-side.
- Replay shape === live shape. Past-session viewing is the same events over HTTP (`GET /api/projects/:id/sessions/:sid/events`), rendered by the same pipeline.

### ChatEvent kinds (persisted + broadcast)

```ts
type ChatEvent =
  | { kind: 'user';            text: string }
  | { kind: 'assistant-text';  text: string; midLoop: boolean }      // complete block
  | { kind: 'thinking';        text: string }
  | { kind: 'turn-end';        text: string; stopReason: string | null }
  | { kind: 'turn-failed';     error: string; source: 'api' | 'abort' | 'internal' }
  | { kind: 'tool-call';       toolUseId: string; name: string; input: unknown }
  | { kind: 'tool-result';     toolUseId: string; result: unknown; isError: boolean }
  | { kind: 'tool-denied';     toolUseId: string; name: string; reason: string }
  | { kind: 'usage';           inputTokens: number; outputTokens: number
                               cacheCreationTokens: number; cacheReadTokens: number
                               model: string | null }
  | { kind: 'turn-duration';   durationMs: number | null }
  | { kind: 'session-state';   state: 'idle' | 'running' | 'requires_action'
                               permissionMode: string | null }
  | { kind: 'system';          subtype: string; level: 'info' | 'notice' | 'warning' | 'error'
                               message: string; raw?: unknown }
  | { kind: 'compaction';      trigger: 'manual' | 'auto'; preTokens: number
                               postTokens: number | null }
  | { kind: 'sidechain';       role: 'user' | 'assistant' | 'tool'; text: string }  // pre-shaped server-side; no raw transcript rows on the wire
  | { kind: 'agent-dispatch';  runId: Ulid; agentName: string }   // anchor only — the bubble hydrates status from agent-run/contract resource events by runId
  | { kind: 'retract';         uuids: string[] }                  // model-refusal fallback: evict already-delivered events by sdkUuid
```

Every persisted ChatEvent also stores `sdkUuid?: string` (the SDK message uuid) for retraction and delta-reconciliation.

Turn/busy state is owned by two kinds only: `session-state` (authoritative, from the SDK's `session_state_changed`) with `turn-end`/`turn-failed` as the per-turn boundary. No derived blends of PTY state — that machinery is gone. **Every turn terminates in exactly one of `turn-end` or `turn-failed`** — an API error that kills a turn with no assistant content must still emit `turn-failed` (the old "stop-failure" defensive semantics, now first-class).

### Streaming deltas (ephemeral, broadcast-only, never persisted)

New capability — the old UI never streamed. Deltas are their own frame type, outside the seq'd store:

```ts
type ChatDeltaFrame = {
  type: 'chat-delta'
  projectId: Ulid
  sessionId: string
  sdkUuid: string             // the in-flight assistant message
  event:
    | { kind: 'message-start' }
    | { kind: 'text-delta';     text: string }
    | { kind: 'thinking-delta'; text: string }
    | { kind: 'tool-input-delta'; toolUseId?: string; partialJson: string }
    | { kind: 'message-end' }
}
```

Client keeps one streaming buffer per `sdkUuid`, renders it live, and **discards it when the persisted `chat` frame with the same `sdkUuid` arrives** (final block wins; dedupe by sdkUuid). Deltas are lossy by design: missed deltas need no healing — the persisted block is the truth. Sourced from SDK `stream_event` with `includePartialMessages: true`; subagent deltas (`parent_tool_use_id != null`) are not forwarded to chat.

### Send path (client → server)

```ts
// client → server
{ type: 'send'; text: string; clientMessageId: string }
{ type: 'interrupt' }                                    // abort the in-flight turn
{ type: 'ask-reply'; askId: string; answer: string }
{ type: 'subscribe'; lastVersion?: string }
{ type: 'client-ping'; nonce: string; sentAt: number }

// server → sender only
{ type: 'send-ack'; projectId: Ulid; clientMessageId: string; ok: boolean
  status: 'received' | 'queued' | 'invalid' | 'error'; error?: string }

// server → broadcast
{ type: 'send-queue-snapshot'; projectId: Ulid; sessionId: string
  items: Array<{ id: Ulid; clientMessageId: string; text: string
    status: 'queued' | 'delivering' | 'delivered' | 'failed' | 'cancelled'
    failureReason: string | null; createdAt: number; updatedAt: number }> }
```

Optimistic-send reconcile, two confirmation paths in priority order (the old fuzzy text-match fallback is dropped):
1. `send-queue-snapshot` item reaching `delivered` by `clientMessageId`;
2. the canonical `user` chat frame stamped with `clientMessageId` (primary).

Snapshot replaces snapshot (no per-item deltas) — kept property. PTY-era statuses (`delivered_to_pty`, `observed_in_jsonl`, `queued_spawning`) are dead.

Attachments never ride the wire: images POST to `/api/projects/:id/pasted-images`, the returned path is spliced into `send.text`, the agent reads the file.

### Ask / permission

The SDK `canUseTool` callback blocks on a browser answer:

```ts
{ type: 'ask'; projectId: Ulid; askId: Ulid; sessionId: string | null
  toolName: string; toolUseId: string; toolInput: unknown }
```

Client answers with `ask-reply { askId, answer }`. Server resolves the pending promise; a timeout watchdog auto-resolves abandoned asks as denied (typed, visible — never a hang). Asks are keyed by `askId` (not toolUseId — one tool use can re-ask after edits).

### Session lifecycle

```ts
{ type: 'session-changed'; projectId: Ulid
  transition: 'new-session' | 'resume-session'
  session: { id: string; projectId: Ulid; model: string | null; title: string | null
             status: 'active' | 'ended'; startedAt: number } | null }

{ type: 'session-replay'; projectId: Ulid; sessionId: string
  highWaterSeq: number; events: ChatFrame[] }   // full checkpoint, same frame shape as live
```

`new-session` wipes client timeline + aggregates; replay re-seeds wholesale and recomputes aggregates from the set (never carries forward). SDK `system/init` is turn-start metadata, **not** app-session creation — app sessions are server-owned rows; the SDK `session_id` is captured per turn for `resume`.

## Channel 2 — Resources (durable, global cursor)

The live-outbox pattern, kept wholesale: gateway writes the event row in the same transaction as the mutation; a post-commit relay fans out.

```ts
type ResourceFrame = {
  type: 'resource'
  event: {
    id: Ulid
    cursor: string                    // global monotonic, numeric-string
    scope: 'project' | 'global'
    projectId: Ulid | null            // null = global (client selectors must union global into project views)
    entity: ResourceEntity
    entityId: Ulid
    eventType: `${ResourceEntity}.changed`
    version: number | null            // per-entity dedup; null = last-write-wins by cursor
    createdAt: number
    payload: unknown                  // per-entity, below
  }
}

{ type: 'live-reset'; projectId: Ulid | null; cursor: string | null }  // cursor fell below pruned floor: clear store, clear cursor, epoch-refetch everything

type ResourceEntity =
  | 'agent-run' | 'contract' | 'specialist' | 'mailbox-message'
  | 'session-title' | 'mcp-server' | 'project' | 'usage'
```

Per-entity style is fixed — **full-snapshot** (payload carries the whole DTO, consumer never refetches) or **signal-only** (payload is a change signal, consumer refetches over HTTP). Never mix per entity.

| entity | style | payload | notes |
| --- | --- | --- | --- |
| `agent-run` | full snapshot | `{ reason, run: AgentRunDto, pendingAskId? }` | reason: `queued\|spawning\|running\|paused\|resumed\|stalled\|completed\|failed\|cancelled\|reconciled`. `stalled` is non-terminal, bumps `rev`, badge-only, absent from HTTP seed. `paused` carries `pendingAskId`. Running-list HTTP seed excludes terminal rows; client drops rows on terminal frame. Dead field: `parentWorkItemId`. |
| `contract` | full snapshot | `{ reason, contract: ContractDto }` | reason: `created\|dispatched\|deliverable-set\|verification-set\|landing-set\|patched`. Rolled-up `verificationStatus/Notes` ride here; per-predicate AC detail stays HTTP (ReviewPackage). Landing receipts (`landed\|conflict\|failed\|abandoned` + branch/sha) on `landing-set`. Keyed by contract id / `agentRunId` — `workItemId` is dead; contracts carry an external PM ref string instead. |
| `specialist` | signal-only | `{ specialistId: Ulid }` | pods, renamed. Global-scope frames (stock specialists) must reach project views. |
| `mailbox-message` | signal-only | `{ messageId: Ulid }` | inbox refetches actionable-only list. Workflow-gate kinds are dead; agent asks + human-review kinds survive. |
| `session-title` | full snapshot | `{ session: SessionDto }` | latest-by-cursor wins. |
| `mcp-server` | full snapshot | `{ server: { id, name, status: 'healthy'\|'degraded'\|'down'\|'unknown', reason: string \| null, lastProbeAt: number \| null, toolCount: number \| null, lastError: string \| null } }` | new — the MCP manager's reliability bar: every state change surfaces, unknown is a state. |
| `project` | signal-only | `{ projectId: Ulid }` | replaces the legacy `project.changed` special-case envelope. |
| `usage` | full snapshot | `UsageSnapshot` (below) | quota is durable state, not a lucky broadcast. |

Dedup: `(entity, entityId)` + `version` — strictly-older loses, equal wins (supports same-version overlays like the stalled badge). No cross-entity ordering guarantee.

Dead entities, not carried: `workflow-run`, `workflow-review`, `workflow-definition`, `work-item`, `stage`, `field-schema`, `area`, `attachment`, `work-item-dossier`, `host-health`, `pod` (renamed `specialist`).

### Usage snapshot

```ts
type UsageSnapshot = {
  accountId: string                    // 'personal' | 'work' | …
  fiveHour:  { utilization: number; resetsAt: number | null } | null
  sevenDay:  { utilization: number; resetsAt: number | null } | null
  status: 'allowed' | 'allowed_warning' | 'rejected'
  model: string | null
  updatedAt: number
}
```

Sourced from SDK `rate_limit_event` (push) + per-turn `result.usage`; cached server-side per account. Rides the durable channel (the old statusline-snapshot's "idle tab shows stale caps forever" wart dies with it). `status: 'rejected'` or `allowed_warning` is the premortem-#3 tripwire — surface loudly.

## Channel 3 — Latency-class broadcasts (no replay; HTTP heals)

### Agent transcript streaming

```ts
{ type: 'agent-event'; projectId: Ulid; runId: Ulid; event: ChatEvent
  dedupId: string }   // stable: sdkUuid ?? `${kind}:tool:${toolUseId}`; server guarantees presence
```

Agent transcripts reuse `ChatEvent` — one render pipeline for orchestrator chat and agent run views. Missed frames heal on modal open via HTTP backfill: `GET /api/projects/:pid/agent-runs/:runId/events → { events, transcriptStatus: 'ready' | 'empty' | 'missing', status }`, merged by `dedupId`.

### Orchestrator state

```ts
{ type: 'orchestrator-state'; projectId: Ulid; sessionId: string | null
  health: 'idle' | 'starting' | 'busy' | 'failed'
  queueDepth: number; failureReason: string | null }
```

Latest-wins, no dedup key. The PTY-era snapshot (waitPoint, ptyState, rawJsonl cursors, respawn counters) is dead; this is the whole shape.

## SDK → contract mapping

| SDK message | Contract emission |
| --- | --- |
| `system/init` | capture `session_id` for resume; first turn of a session also emits `session-changed` |
| `assistant` (text/thinking/tool_use blocks) | `assistant-text` / `thinking` / `tool-call` per block; `.error` → `turn-failed` (or `system` level error if turn survives); `supersedes` → `retract`; skip when `parent_tool_use_id != null` (subagent) |
| `user` (tool_result blocks) | `tool-result` (carry `is_error`); not a chat user bubble — user bubbles come from our own send path |
| `stream_event` | `chat-delta` frames (main thread only) |
| `result` (success) | `usage` + `turn-duration` + `turn-end`; update `UsageSnapshot` |
| `result` (error subtypes) | same telemetry + `turn-failed` |
| `system/status`, `session_state_changed` | `session-state` |
| `system/compact_boundary` | `compaction` |
| `tool_progress` | `agent-event`/chat `tool-progress` — broadcast-only, not persisted |
| `rate_limit_event` | `usage` resource event |
| `system/permission_denied` | `tool-denied` |
| `system/api_retry` | `system` (level warning) |
| `canUseTool` callback | `ask` frame; resolved by `ask-reply` |
| task_* / background_tasks_changed | reserved for Phase 3 dispatch views; dropped in Phase 2 |
| everything else | dropped, silently, by design |

## Old → new rename ledger

| Old | New |
| --- | --- |
| `jsonl` envelope + `jsonl-*` kinds | `chat` frame + clean kinds |
| `event` (hook-event channel) | dead; `turn-failed` + structured dispatch events absorb the survivors |
| `[pc:agent-event kind=…]` text markers | `agent-dispatch` chat anchor + `agent-run`/`contract` resource events |
| `live-event` | `resource` |
| `agent-jsonl-event` | `agent-event` |
| `runtime-state` | `orchestrator-state` (slimmed) |
| `statusline-snapshot` | `usage` resource event |
| `pod.changed` | `specialist` resource event |
| `raw`, `state`, `turn-end` (WS), `exit`, `terminal-input`, `resize`, `terminal-input-ack` | dead (PTY) |
| `agent-run-changed` (legacy v1) | dead |
| `project.changed` special envelope | `project` resource event |

## Guard rules (each gets a test when built)

1. Persist-then-broadcast: no chat frame on the wire without its `conversation_events` row committed.
2. Duplicate `chat.id` delivery never double-counts aggregates.
3. Every turn ends in exactly one `turn-end` or `turn-failed` — including abort and API-error paths.
4. `ask` never hangs: watchdog resolves to typed denial.
5. Unknown SDK variant → dropped, logged, loop continues.
6. Reconnect: replay + cursor + epoch-refetch produce identical state to an uninterrupted socket.
7. `resource` frames for a dead entity name fail typecheck (closed union, no strings).
