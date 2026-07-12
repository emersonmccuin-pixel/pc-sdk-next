# Event contract — PC-SDK Next

As built in the active `RS-002` feature worktree, 2026-07-12. This document
records the implemented browser wire and its
persistence/publication semantics. The executable source is
`packages/contracts/src/events/`; the target behavior beyond this slice is
owned by `docs/architecture/chat-communications.md`.

## Principles

- The database is durable truth. Processes, sockets, and browser state are
  projections.
- Stable conversation content and visible streaming deltas use one canonical,
  provider-neutral, server-sequenced envelope.
- Conversation sequence allocation, event insertion, and publication-outbox
  insertion are one SQLite transaction.
- The dedicated conversation relay is the only live-publication path. It fans
  an immutable committed event before marking its outbox row relayed; a crash
  between those steps intentionally causes an exact redelivery. One throwing
  socket is removed without poisoning durable work or other tabs; reconnect
  replay heals that client from database truth.
- Live delivery, active-session replay, and past-session HTTP reads all use the
  same row-to-frame mapper and the same browser projector.
- Sequence is authoritative. Timestamps are display metadata and socket arrival
  is never an ordering mechanism.
- Provider-native message identifiers and private reasoning do not cross the
  runtime adapter boundary. Historical reasoning rows remain retained as
  `legacy-hidden` evidence and product replay never returns them.
- The conversation outbox and the resource `live_outbox` remain separate
  durable channels because their cursors and consumer semantics differ.

## Transport and startup

One WebSocket is opened per project at `GET /ws?projectId=<ulid>`. JSON text
frames are validated at the browser boundary. On open the server sends, in
order:

1. `session-changed`
2. `orchestrator-state`
3. `session-replay` when an active session exists
4. `send-queue-snapshot` when an active session exists
5. each still-pending, process-local approval `ask` after its matching
   canonical `approval-needed` state is present in replay

The client then subscribes to the independent resource cursor. Heartbeat and
reconnect behavior are unchanged: `client-ping`/`server-pong`, bounded backoff,
and reconnect on visibility, focus, or network recovery.

The production composition root keeps all conversation queue drains behind a
one-way readiness gate while the listener is observable but dispatch routes and
the MCP initialization attempt are still starting. Sends received in that
window commit durably and receive their sender receipt, but no runtime is
minted until readiness releases both existing services and recovered live-
project queues. Deleted projects and deleted/inactive sessions are never boot
feeders.

Migration `0012` conservatively marks inherited orchestrator sessions
`legacy-unavailable` instead of inventing a runtime selection. Before the
listener opens, boot recovery canonically cancels every queued or failed send
owned by those sessions. Each cancellation, queue-revision increment,
`send-state`, and conversation-outbox row commits in one Conversation-owned
transaction. A pre-listener conversation-relay drain consumes that outbox, so
cold replay contains the durable cancellation evidence without a stale live
redelivery after startup. The sweep is idempotent and never changes delivering
or accepted items.

## Channel 1 — canonical conversation events

### Envelope

```ts
interface ConversationEventFrame {
  type: 'conversation-event'
  eventId: string
  projectId: ULID
  conversationId: string
  sessionId: string
  sequence: number
  family:
    | 'user' | 'assistant' | 'activity' | 'tool'
    | 'agent' | 'control' | 'telemetry' | 'system'
  turnId?: string
  itemId: string
  streamId?: string
  deltaIndex?: number
  clientMessageId?: string
  occurredAt: number
  event: ConversationEvent
}
```

`eventId` is the immutable event identity. `(conversationId, sequence)` is
unique and is the authoritative projection order. `itemId` identifies the
logical canonical item; `turnId` groups the events produced while delivering
one queue item; `streamId` and `deltaIndex` identify a visible stream and its
deterministic order. A stream event must carry both `streamId` and a
non-negative `deltaIndex`; stable events never carry `deltaIndex`.

CF-001 binds one app session to one conversation, so current orchestrator rows
use `conversationId === sessionId`. Conversation persistence owns the cursor
independently so a later attributed handoff may intentionally group successor
sessions without changing the event contract.

The strict frame guard validates identity, sequence, family/event agreement,
payload shape, and stream-order fields before browser ingestion. Activity and
tool frames require a non-empty turn ID. The DB new-write door also requires
one on every modern turn terminal; the wire guard still accepts a null-turn
legacy terminal because migration `0009` could not safely infer ownership for
historical rows that may contain duplicate terminals.

The envelope and every event variant are exact-key shapes. Undeclared native
IDs, raw provider payloads, private-reasoning fields, and nested extras fail the
guard instead of riding along on an otherwise valid event. The same rule
applies to queue items embedded in `send-state`.

### Stable event payloads

```ts
type ChatEvent =
  | { kind: 'user'; text: string }
  | { kind: 'assistant-text'; text: string; midLoop: boolean }
  | { kind: 'turn-end'; text: string
      stopReason: 'complete' | 'max-output' | 'stop-sequence'
        | 'tool-use' | 'other' | null }
  | { kind: 'turn-failed'; error: string; source: 'api' | 'abort' | 'internal' }
  | { kind: 'activity-state'
      phase: 'turn-starting' | 'requesting-runtime' | 'responding'
        | 'retrying' | 'compacting' }
  | { kind: 'tool-state'; callId: string; name: string
      state: 'requested' | 'approval-needed' | 'running'
        | 'succeeded' | 'failed' | 'denied'
      safeSummary: string
      approval:
        | { status: 'unknown'; source: null; requestId: null }
        | { status: 'not-required'; source: 'policy' | 'runtime'; requestId: null }
        | { status: 'pending'; source: null; requestId: string }
        | { status: 'allowed'; source: 'user'; requestId: string }
        | { status: 'allowed'; source: 'runtime'; requestId: null }
        | { status: 'denied'; source: 'user' | 'timeout' | 'session'; requestId: string }
        | { status: 'denied'; source: 'runtime'; requestId: null }
      outcome: { reason: 'tool-error' | 'turn-ended' | 'runtime-lost' } | null }
  | { kind: 'usage'; inputTokens: number; outputTokens: number
      cacheCreationTokens: number; cacheReadTokens: number; model: string | null }
  | { kind: 'context-observation'
      confidence: 'exact' | 'derived' | 'approximate'
      usedTokens: number; usableTokens: number; contextWindowTokens: number }
  | { kind: 'context-observation'; confidence: 'unavailable'
      reason: 'unsupported' | 'runtime-unavailable'
        | 'invalid-observation' | 'observation-timeout' }
  | { kind: 'turn-duration'; durationMs: number | null }
  | { kind: 'session-state'; state: 'idle' | 'running' | 'requires_action'
      permissionMode: string | null }
  | { kind: 'system'; subtype: string
      level: 'info' | 'notice' | 'warning' | 'error'
      message: string }
  | { kind: 'compaction'; trigger: 'manual' | 'auto' | 'unknown'
      preTokens: number | null; postTokens: number | null }
  | { kind: 'sidechain'; role: 'user' | 'assistant' | 'tool'; text: string }
  | { kind: 'agent-dispatch'; runId: ULID; agentName: string }
  | { kind: 'agent-envelope'; runId: ULID; agentName: string
      pendingAskId?: ULID; status: 'waiting' | 'done' | 'failed'
      summary: string; detail: string; envelope: string }
  | { kind: 'send-state'; queueRevision: number; item: SendQueueItem }
  | { kind: 'interrupt-state'; requestId: string; targetTurnId: string
      replacementQueueItemId: string | null
      state: 'requested' | 'confirmed' | 'failed'
      terminalEventId: string | null
      result: 'aborted' | 'completed' | 'turn-failed' | 'recovered' | null
      failure: { code: string; message: string } | null }
  | { kind: 'retract'; streamIds: string[] }
```

Activity is a closed set of app-authored operational facts. It never contains
thinking text/tokens or arbitrary provider status prose. Tool events require a
non-empty `turnId`, use one adapter-minted `callId` as `itemId`, and carry only
a bounded canonical name, deterministic `safeSummary`, lifecycle state,
approval provenance, and closed terminal reason. Raw tool input, output,
provider error text, and native identifiers are absent.

Normal tool transitions are `requested -> running -> succeeded|failed`,
`requested -> approval-needed -> running -> succeeded|failed`, and denial from
the requested or approval-needed state. User-attributed permission requires the
matching prior app request ID. A positive result may synthesize `running`;
turn/restart closure may exceptionally fail an unexecuted request or running
call with `turn-ended`/`runtime-lost`, while a pending approval becomes
session-denied. Persistence and browser projection share the transition guard,
and terminal calls cannot reopen.

Every turn ends in exactly one `turn-end` or `turn-failed`. A runtime error,
abort, thrown stream, or stream that closes without a terminal result receives
a typed `turn-failed` event rather than silence. Exception text is never abort
evidence: thrown/query-loop errors are `internal`/`error`. The Claude adapter
maps only the installed SDK's exact `terminal_reason` values
`aborted_streaming` and `aborted_tools` to the provider-neutral aborted outcome.

One post-terminal `context-observation` may follow a normally settled eligible
orchestrator turn. Available observations are closed safe-integer snapshots with
`0 <= usedTokens <= usableTokens <= contextWindowTokens`; unavailable events
carry no counts. Persistence requires the exact project/conversation/session/
turn to have a visible terminal and rejects a second observation before sequence
allocation. The service publishes terminal and idle state first, then holds only
that session's FIFO successor for the bounded observation and durable commit.
Timeout or runtime failure becomes typed unavailability. A DB failure retries
without rewriting the terminal or changing the captured observation receipt
time; disposal, runtime invalidation, or session replacement releases the
obsolete wait and permits no late write.

### Visible streaming payloads

```ts
type ChatStreamEvent = {
  kind: 'stream-delta'
  delta:
    | { kind: 'message-start' }
    | { kind: 'text-delta'; text: string }
    | { kind: 'message-end' }
}
```

Streaming events use the same durable envelope and outbox as stable content.
The server assigns a monotonic `deltaIndex` per canonical stream. There is no
`chat-delta` side channel and no reasoning delta.

### Persistence and relay

The canonical event path owns three tables:

- `conversation_sequences`: one next-sequence cursor per conversation;
- `conversation_events`: immutable canonical rows and projection state;
- `conversation_outbox`: one `chat` or `agent` publication entry per event.

One transaction performs cursor allocation, event insert, and outbox insert.
Any failure rolls back all three effects, including the allocated sequence. The
relay drains by monotonic outbox sequence, fans to the project room, and marks
the row only after fanout. Startup plus a periodic drain recover rows left
pending by a process crash.

Migration `0009_conversation_foundation.sql` rebuilds the legacy table, backfills
conversation cursors and already-relayed historical outbox entries, rewrites
legacy retraction references to opaque canonical legacy stream IDs, drops the
old provider-named identifier column, and retains prior `thinking` rows only as
`legacy-hidden` data.

Migration `0010_durable_send_control.sql` adds conversation-owned queue heads,
items, immutable content revisions, active-turn rows, interrupt requests, and
idempotent command receipts. A queue or interrupt transition calls the same
event/outbox insert inside its SQLite transaction, so its DB truth and
canonical notification cannot diverge. A partial unique terminal index keeps
one `turn-end` or `turn-failed` row per modern turn.

Migration `0011_safe_activity_tool_lifecycle.sql` retains legacy raw tool
call/result/denial, streamed tool-input, and pre-CF-004 provider-authored system
rows as `legacy-hidden` evidence. The earlier system producers included raw API
retry metadata, provider status/error prose, and local-command output, none of
which satisfies the new closed event. Hidden rows keep their original
sequence/high-water positions but never enter product replay or the strict
browser contract.

### Browser projection

The browser's pure projector keeps received high-water separate from the
contiguous sequence frontier that is safe to fold. Monotonic live delivery uses
immutable key-ranked receipt indexes and incremental transitions; a higher live
sequence is held until its lower gap closes instead of forcing a history rebuild.
Stable presentation history uses immutable bounded append chunks and is
materialized only at the render boundary, so stable events also avoid copying
the full prior history inside the projector.

- Exact event redelivery is a no-op. SHA-256 frame receipts retain compact
  identity evidence after presentation payload compaction.
- A conflicting event identity or sequence preserves the first accepted value
  and records a sorted, stable integrity conflict.
- Deltas are keyed by canonical stream and index. Gaps are held until a
  contiguous prefix exists; exact payload duplicates are ignored and conflicting
  content at one index is recorded.
- Raw delta frames never enter stable presentation history. Only active,
  coalesced stream buffers retain their payload; stable completion, retraction,
  or a turn terminal releases that payload while stream/index digest receipts
  continue to detect late duplicates and conflicts.
- Reconnect and past-session replay sort/deduplicate through one explicit
  normalization pass. The authoritative replay high-water checkpoint accounts
  for invisible migrated rows, so the next live sequence can continue without
  fabricating events for hidden gaps.
- All indexes are immutable plain data. Previously returned states remain
  branchable, and shuffled live delivery, reconnect replay, and past-session
  replay converge through the same projector and render input.
- Deterministic work receipts characterize accepted-event visits, history
  visits, fallback rebuilds, and compacted payloads without timing-sensitive
  performance assertions.
- Tool projection is one guarded record per `callId`; invalid, regressive,
  conflicting, or post-terminal observations remain evidence but cannot
  replace the accepted lifecycle. A browser never invents a tool terminal.
- Current activity follows server sequence. Elapsed time and the bounded
  “Still waiting” label are local display derivations from server timestamps,
  never durable claims or ordering evidence.
- Approval cards become actionable only when session/call/name/request identity
  matches a live canonical `approval-needed` state. Out-of-order cards wait
  ephemerally for that evidence; terminal/idle/replay resets clear stale cards.
- Context readiness is independent of queue/session readiness. A new/no-session
  boundary is authoritative empty truth; a resumed session waits for valid
  replay, and queue snapshots cannot authorize context. Any later frame with a
  different non-empty turn identity, plus compaction or context-projection
  evidence buffered above a sequence gap, makes prior evidence stale. The
  projector tracks this with immutable pending summaries rather than rescanning
  history. Pending/folded event-ID collisions invalidate context at receipt
  time, and folded non-observation turn evidence prevents an older observation
  from becoming current later. Superseded turn identities remain sticky, so a
  late old-turn frame cannot roll the context epoch backward. Only a settled
  latest-turn observation can become current; older, pre-terminal, or
  second-per-turn observations fail closed. Only fresh available counts render
  a browser-computed percentage.

### Session replay

Past-session HTTP responses are converted to this same guarded
`session-replay` envelope before projection. The browser binds the requested
project/session identity, validates every nested exact-shape event, and retains
the server-provided `highWaterSequence`; it never recomputes high-water from
only the visible rows because hidden legacy evidence may occupy sequence slots.

```ts
interface SessionReplayFrame {
  type: 'session-replay'
  projectId: ULID
  sessionId: string
  highWaterSequence: number
  events: ConversationEventFrame[]
}
```

Replay events use the exact live frame shape. The checkpoint guard rejects a
foreign project/session frame or malformed canonical event. Hidden legacy rows
are excluded from product replay; therefore the high-water sequence may be
higher than the last visible sequence.

Past-session HTTP uses
`GET /api/projects/:projectId/sessions/:sessionId/events` and returns the same
`highWaterSequence` plus canonical event array.

### Send, queue, ask, and session control

Conversation commands carry an explicit idempotency identity and expected app
session. Edit/remove use compare-and-swap revisions. Interrupts target one exact
active turn; the request ID is also the command ID.

```ts
{ type: 'send'; commandId: string; sessionId: string | null
  text: string; clientMessageId: string }
{ type: 'edit-queued-message'; commandId: string; sessionId: string
  queueItemId: string; expectedRevision: number; text: string }
{ type: 'remove-queued-message'; commandId: string; sessionId: string
  queueItemId: string; expectedRevision: number }
{ type: 'interrupt'; requestId: string; sessionId: string; targetTurnId: string }
{ type: 'interrupt-and-send'; requestId: string; sessionId: string
  targetTurnId: string
  replacement:
    | { kind: 'new'; clientMessageId: string; text: string }
    | { kind: 'queued'; queueItemId: string; expectedRevision: number } }
{ type: 'ask-reply'; askId: string; answer: string }
{ type: 'subscribe'; lastVersion?: string }
{ type: 'client-ping'; nonce: string; sentAt: number }

{ type: 'conversation-command-receipt'; projectId: ULID
  sessionId: string | null; commandId: string
  command: 'send' | 'edit-queued-message' | 'remove-queued-message'
    | 'interrupt' | 'interrupt-and-send'
  status: 'applied' | 'duplicate' | 'rejected'
  queueItemId?: string; revision?: number; interruptRequestId?: string
  error: { code: string; message: string; currentRevision?: number } | null }

{ type: 'send-queue-snapshot'; projectId: ULID; sessionId: string
  queueRevision: number
  items: Array<{ id: ULID; clientMessageId: string
    origin: 'user' | 'agent-envelope'; enqueuePosition: number
    revision: number; deliveryRevision: number | null; text: string
    status: 'queued' | 'delivering' | 'failed'
    interruptRequestId: string | null; failureReason: string | null
    createdAt: number; updatedAt: number }> }

{ type: 'ask'; projectId: ULID; askId: ULID; sessionId: string | null
  toolName: string; callId: string; toolInput: unknown }
```

Ask input is transient but still globally bounded/redacted before delivery.
Question and plan presentations normalize to non-empty visible strings. A
malformed or empty special-tool payload renders deny-only, and the runtime
adapter independently refuses to authorize it even if a client forges an
allow-style reply.

The command receipt is sender-only transport feedback. Non-rejected receipts
must carry their command-specific durable identities; canonical `send-state`
and `interrupt-state` events plus a DB-derived reconnect snapshot remain the
projection authority. Snapshot identities, client IDs, and FIFO positions are
unique, and lower queue revisions never overwrite a newer browser projection.

FIFO position never changes on edit. Claiming the head atomically freezes its
delivery revision, creates the one active turn, and appends `send-state`, the
canonical user or typed agent-envelope event, `session-state: running`, and
`activity-state: turn-starting` before provider work begins. Terminal
settlement first closes every open tool in the same transaction, then appends
the one turn terminal, queue outcome, correlated interrupt outcome, and idle
state.
Restart marks an uncertain delivering row failed and never re-sends it; queued
rows survive and drain without a connected browser. A failed interrupt-linked
replacement retains its request identity and failure evidence but is explicitly
removable; it can never be claimed.

`runtime.interrupt()` resolving means only that the native command was
accepted. Only a correlated `turn-failed { source: 'abort' }` terminal confirms
the durable interrupt request. A normal/error/recovered terminal fails the
request, and a linked replacement remains unclaimable unless confirmation is
positive. Exact duplicate commands return the existing receipt without
repeating the native side effect. The committed sender receipt returns before
the native call. A 15-second watchdog turns missing acceptance/terminal evidence
into durable `runtime-interrupt-inconclusive` failure, blocks another native
attempt for that target turn, and quarantines/disposes the runtime before a
successor can start. Service shutdown fails a pending request before runtime
disposal, so teardown cannot manufacture a positive abort receipt.

Starting, resuming, or account-switching an app session atomically cancels the
old undelivered FIFO, ends the old active row, and creates/reactivates the target
row; account settings join that same transaction. Project deletion refuses an
active turn, otherwise cancels the FIFO, ends the session, and soft-deletes the
project atomically. Every new orchestrator row carries one immutable complete
runtime/account/model/effort stamp. Historical resume preflights that stamp and
its bound native identity before the atomic transition, so returning from
account B to account A routes through A without changing the mutable project
default or guessing a credential home.

Immediately before each native create or resume mint, persistence rotates a
non-empty continuation-attempt identity. The adapter echoes it in the positive
`session-started` receipt. Receipt confirmation and resume failure both compare
the exact current attempt in their DB update, making output from an abandoned
stream harmless even when its native session ID and selection otherwise match.

Session lifecycle remains app-owned:

```ts
{ type: 'session-changed'; projectId: ULID
  transition: 'new-session' | 'resume-session'
  session: { id: string; projectId: ULID
    selection: RuntimeSelection | null
    title: string | null; status: 'active' | 'ended'
    nativeSessionIdPresent: boolean
    continuationState: 'clean-pending' | 'clean-started'
      | 'resume-pending' | 'native-resumed' | 'resume-failed'
      | 'legacy-unavailable'
    resumeAvailability:
      | { status: 'available' }
      | { status: 'unavailable'; code: RuntimeSelectionErrorCode }
    startedAt: number } | null }

{ type: 'session-updated'; projectId: ULID
  session: SessionSummary }
```

`selection` is null only for conservatively quarantined migrated rows. Native
session IDs, continuation-attempt IDs, and credential homes never enter this
orchestrator frame family or the expanded orchestrator HTTP session DTO.

`session-changed` remains the app-session boundary: consumers replace the
active-session identity and reset/replay chat as required. `session-updated`
converges only non-boundary metadata for that same active session after an exact
positive native receipt or current-attempt resume failure. The browser updates
account/header provenance and invalidates session-list reads, but it does not
reset, clear, or replay the chat timeline. Both frames use the same strict
`SessionSummary`; native identity is represented only by
`nativeSessionIdPresent`.

## Channel 2 — resource events

The resource channel remains a separate global-cursor outbox. Its executable
contract is `packages/contracts/src/events/resource.ts`.

```ts
type ResourceFrame = {
  type: 'resource'
  event: {
    id: ULID
    cursor: string
    scope: 'project' | 'global'
    projectId: ULID | null
    entity:
      | 'agent-run' | 'contract' | 'specialist' | 'mailbox-message'
      | 'session-title' | 'mcp-server' | 'project' | 'usage'
    entityId: ULID
    eventType: `${ResourceEntity}.changed`
    version: number | null
    createdAt: number
    payload: unknown
  }
}
```

Consumers replay `(lastVersion, head]`; a cursor below the pruning floor gets a
typed `live-reset`. Full-snapshot versus signal-only payload policy remains
fixed per entity.

## Channel 3 — HTTP-healed live projections

Agent transcript events are durably stored through the same conversation
event/outbox transaction, but their compact live frame remains HTTP-healed:

```ts
{ type: 'agent-event'; projectId: ULID; runId: ULID
  event: ChatEvent; dedupId: string }
```

`dedupId` is the canonical conversation event ID. Opening the run view fetches
the durable transcript and merges by that identity. Both the live frame and
each HTTP backfill entry cross exact-key guards backed by `isChatEvent`; the
store/merge layer checks again defensively. Invalid events are omitted, and the
transcript renderer has no raw-JSON fallback for unhandled canonical kinds.

Orchestrator health remains latest-wins process state:

```ts
{ type: 'orchestrator-state'; projectId: ULID; sessionId: string | null
  activeTurnId: string | null
  health: 'idle' | 'starting' | 'busy' | 'failed'
  queueDepth: number; failureReason: string | null }
```

## Runtime adapter mapping

Only `ClaudeRuntimeAdapter` imports or parses the Claude Agent SDK. It keeps a
native-to-canonical ID map and emits canonical runtime events:

| Native observation | Canonical result |
| --- | --- |
| exact initialization | `session-started` with immutable selection, current attempt identity, created/resumed mode, and adapter-owned native session ID |
| main assistant text/tool block | canonical item ID plus `assistant-text` or safe `tool-state: requested` |
| tool progress/result | adapter-correlated `running` then `succeeded`/`failed`, with no input/output |
| permission callback/native denial | canonical approval request/provenance and `running` or `denied` |
| main visible stream event | canonical item ID plus persisted ordered delta |
| private thinking, tool-input delta, tool summary, local-command output | dropped before the canonical runtime seam |
| sidechain block/delta/result | dropped from orchestrator chat |
| result | usage/duration plus exactly one turn terminal |
| requesting/retry/compaction | closed app-authored activity; numeric retry facts only |
| `getContextUsage()` after a settled turn | exact/derived bounded context counts or typed unavailability; native category/path/tool/percentage details dropped |
| arbitrary provider status/error prose | dropped or replaced with fixed app-authored notice |
| supersession | `retract` with canonical stream IDs |
| unknown native variant | dropped/logged by the adapter; loop continues |

On the orchestrator path, native session and attempt identities remain
adapter/persistence metadata and never become conversation message identifiers
or orchestrator session browser data. This is not yet a specialist-wide claim:
the existing browser-facing `AgentRunDto.sessionId` mirrors `ccSessionId`, and
`PendingAskDto.ccSessionId` retains provider-native session-shaped vocabulary.
Those DTOs and specialist dispatch's direct `CLAUDE_RUNTIME_ID` selection are
later N3 boundary work.

## Guard rules

1. No live conversation event exists without a committed event and outbox row.
2. Sequence allocation and event/outbox insertion either all commit or all roll
   back.
3. Exact redelivery never changes the browser projection.
4. Conflicting sequence, event, or delta identity fails closed and is visible
   as an integrity conflict.
5. Live, reconnect, and past-session replay use one frame mapper and projector.
6. Every turn has exactly one canonical terminal outcome.
7. Historical or new private reasoning never enters product replay.
8. Provider-native message identifiers, the retired split-delta wire, native
   terminal reasons, and private-reasoning render paths are rejected from
   canonical contract/browser source by guard tests.
9. Unknown resource entities fail the closed-union contract.
10. Queue admission, edit/remove, claim, terminal settlement, cancellation, and
    interrupt transitions commit with their canonical event/outbox rows.
11. A delivery revision is immutable after claim; a stale edit/remove CAS
    writes nothing.
12. Native interrupt command completion is not confirmation. Only the exact
    target turn's abort terminal releases an interrupt-linked replacement.
13. Reconnect snapshots and canonical queue events converge by monotonic queue
    revision; duplicate item/client/FIFO identities fail the inbound guard.
14. Boot admission may persist work before composition readiness, but it cannot
    mint a runtime or begin provider work before the one-way readiness receipt.
15. Timeout, shutdown, socket failure, exception text, and an unrelated terminal
    never confirm interruption or permit a second uncertain native attempt.
16. Session/account/project lifecycle transitions either commit their queue and
    session effects together or preserve the complete prior state.
17. Activity/tool events require a turn identity. Tool item/call/name/summary/
    turn identity and approval provenance are immutable and transactionally
    guarded before sequence allocation.
18. Every open tool closes before its conversation or agent-run terminal.
    Restart, kill, paused-run revival, persistence failure, and runtime loss
    cannot stamp a terminal state ahead of that closure.
19. `tool_called` verification counts one positive `running` receipt per
    canonical call, never request, denial, exceptional closure, or repeated
    lifecycle observations.
20. Pending approval waiters register synchronously, publish only after the
    canonical pending state commits, replay after reconnect/same-session reset,
    and carry user/timeout/session/runtime denial provenance. Their ephemeral
    input projection has global character/node/depth/item bounds and redacts
    common secret keys and token forms before it crosses to the browser.
21. Native item/call correlation is retained for the whole active turn and is
    cleared only at a turn boundary. Map pressure never evicts an open call or
    lets a late observation mint a second canonical identity. Native permission
    request receipts remain idempotent for the runtime-session lifetime and are
    bound to the exact active turn generation and primary/sidechain scope; a
    cached or pending decision can never authorize a successor turn.
22. A provider sidechain cannot open an approval whose canonical lifecycle is
    intentionally omitted from the orchestrator transcript; such requests are
    denied immediately as unsupported. Paused-run boot recovery and an incoming
    answer share one provider-resume attempt, and kill/shutdown disposes any
    late candidate before it can install or leave a wall clock armed.
23. Every native orchestrator create/resume mint has one fresh persisted
    continuation-attempt identity. Success and failure advance only that exact
    attempt. Stale or attempt-mismatched evidence writes nothing. Missing,
    malformed, wrong-mode, wrong-selection, or conflicting evidence cannot bind
    or confirm native identity and never falls back to a clean start; invalid
    evidence for the current resume attempt may record `resume-failed`.
24. A context observation requires a settled exact turn and is unique per turn.
    The settled result cannot be rewritten by observation or persistence failure;
    the same-session successor cannot start before observation persistence, while
    disposal/session/runtime replacement fences and releases obsolete work.
25. Context current-use and compaction capability truth is independent of
    selection validity. Unsupported/unavailable context never selects another
    runtime, model, account, behavior, or billing path.
26. Compaction token edges are nullable non-negative safe integers. A compact
    boundary clears any pre-boundary exact numerator even when it arrives after
    the turn terminal; malformed assistant ownership cannot preserve earlier
    exact evidence.

## Deliberately unfinished boundaries

- specialist-wide immutable runtime/account/model/effort and attempt stamps;
- removal of native session-shaped fields from existing agent-run/pending-ask
  browser DTOs and of direct `CLAUDE_RUNTIME_ID` selection from specialist
  dispatch;
- attributed cross-runtime handoff compilation;
- provider-neutral subscription-quota observations and source semantics;
- Codex adapter and conformance.

Those are subsequent slices; none has a compatibility wire in this contract.
