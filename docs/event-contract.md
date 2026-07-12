# Event contract — PC-SDK Next

As built after `CF-003`, 2026-07-11. This document records the implemented
browser wire and its persistence/publication semantics. The executable source
is `packages/contracts/src/events/`; the target behavior beyond this slice is
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
payload shape, and stream-order fields before browser ingestion.

### Stable event payloads

```ts
type ChatEvent =
  | { kind: 'user'; text: string }
  | { kind: 'assistant-text'; text: string; midLoop: boolean }
  | { kind: 'turn-end'; text: string
      stopReason: 'complete' | 'max-output' | 'stop-sequence'
        | 'tool-use' | 'other' | null }
  | { kind: 'turn-failed'; error: string; source: 'api' | 'abort' | 'internal' }
  | { kind: 'tool-call'; toolUseId: string; name: string; input: unknown }
  | { kind: 'tool-result'; toolUseId: string; result: unknown; isError: boolean }
  | { kind: 'tool-denied'; toolUseId: string; name: string; reason: string }
  | { kind: 'usage'; inputTokens: number; outputTokens: number
      cacheCreationTokens: number; cacheReadTokens: number; model: string | null }
  | { kind: 'turn-duration'; durationMs: number | null }
  | { kind: 'session-state'; state: 'idle' | 'running' | 'requires_action'
      permissionMode: string | null }
  | { kind: 'system'; subtype: string
      level: 'info' | 'notice' | 'warning' | 'error'
      message: string; raw?: unknown }
  | { kind: 'compaction'; trigger: 'manual' | 'auto'
      preTokens: number; postTokens: number | null }
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

The canonical `activity` family is reserved for the next safe-activity slice;
there is no private-reasoning payload in the public union. Tool and activity
lifecycle enrichment remains explicitly outside CF-003.

Every turn ends in exactly one `turn-end` or `turn-failed`. A runtime error,
abort, thrown stream, or stream that closes without a terminal result receives
a typed `turn-failed` event rather than silence. Exception text is never abort
evidence: thrown/query-loop errors are `internal`/`error`. The Claude adapter
maps only the installed SDK's exact `terminal_reason` values
`aborted_streaming` and `aborted_tools` to the provider-neutral aborted outcome.

### Visible streaming payloads

```ts
type ChatStreamEvent = {
  kind: 'stream-delta'
  delta:
    | { kind: 'message-start' }
    | { kind: 'text-delta'; text: string }
    | { kind: 'tool-input-delta'; toolUseId?: string; partialJson: string }
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

### Session replay

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
  toolName: string; toolUseId: string; toolInput: unknown }
```

The command receipt is sender-only transport feedback. Non-rejected receipts
must carry their command-specific durable identities; canonical `send-state`
and `interrupt-state` events plus a DB-derived reconnect snapshot remain the
projection authority. Snapshot identities, client IDs, and FIFO positions are
unique, and lower queue revisions never overwrite a newer browser projection.

FIFO position never changes on edit. Claiming the head atomically freezes its
delivery revision, creates the one active turn, and appends `send-state`, the
canonical user or typed agent-envelope event, and `session-state: running`
before provider work begins. Terminal settlement atomically appends the one
turn terminal, queue outcome, correlated interrupt outcome, and idle state.
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
project atomically. Until immutable runtime/account stamps land, an account
switch marks all prior sessions non-resumable: their transcripts remain
viewable, while native continuation under the wrong credential home is blocked
and visibly labelled.

Session lifecycle remains app-owned:

```ts
{ type: 'session-changed'; projectId: ULID
  transition: 'new-session' | 'resume-session'
  session: { id: string; projectId: ULID; model: string | null
    title: string | null; status: 'active' | 'ended'
    resumable: boolean; startedAt: number } | null }
```

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
the durable transcript and merges by that identity.

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
| initialization | adapter-owned native session ID for resume metadata |
| main assistant text/tool block | canonical item ID plus `assistant-text` or `tool-call` |
| main tool result | canonical item ID plus `tool-result` |
| main visible stream event | canonical item ID plus persisted ordered delta |
| private thinking block/delta | dropped before the canonical runtime seam |
| sidechain block/delta/result | dropped from orchestrator chat |
| result | usage/duration plus exactly one turn terminal |
| session/compaction/permission/retry/system | mapped canonical stable event |
| supersession | `retract` with canonical stream IDs |
| unknown native variant | dropped/logged by the adapter; loop continues |

Native session identity remains adapter/composition metadata and never becomes
a conversation message identifier.

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

## Deliberately unfinished boundaries

- safe operational activity and complete tool lifecycle families;
- immutable runtime/account/model/effort app-session stamps;
- provider-neutral context and usage observations;
- Codex adapter and conformance.

Those are subsequent slices; none has a compatibility wire in this contract.
