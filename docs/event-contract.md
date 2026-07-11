# Event contract — PC-SDK Next

As built after `CF-001`, 2026-07-11. This document records the implemented
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
  between those steps intentionally causes an exact redelivery.
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
3. `session-replay`
4. `send-queue-snapshot`

The client then subscribes to the independent resource cursor. Heartbeat and
reconnect behavior are unchanged: `client-ping`/`server-pong`, bounded backoff,
and reconnect on visibility, focus, or network recovery.

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
  | { kind: 'retract'; streamIds: string[] }
```

The canonical `activity` family is reserved for the next safe-activity slice;
there is no private-reasoning payload in the public union. Tool and activity
lifecycle enrichment remains explicitly outside CF-001.

Every turn ends in exactly one `turn-end` or `turn-failed`. A runtime error,
abort, thrown stream, or stream that closes without a terminal result receives
a typed `turn-failed` event rather than silence.

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

The conversation component owns three tables:

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

### Browser projection

The browser stores accepted canonical frames sorted by `sequence` and derives
timeline aggregates and stream buffers from that ordered set.

- Exact event redelivery is a no-op.
- A conflicting event identity or sequence preserves the first accepted value
  and records an integrity conflict.
- Deltas are keyed by canonical stream and index. Gaps are held until a
  contiguous prefix exists; exact duplicates are ignored and conflicting
  content at one index is recorded.
- Stable completion clears its live stream. A late delta cannot resurrect it.
- Shuffled live delivery, reconnect replay, and past-session replay converge
  through the same pure projector.

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

Client commands and control frames remain:

```ts
{ type: 'send'; text: string; clientMessageId: string }
{ type: 'interrupt' }
{ type: 'ask-reply'; askId: string; answer: string }
{ type: 'subscribe'; lastVersion?: string }
{ type: 'client-ping'; nonce: string; sentAt: number }

{ type: 'send-ack'; projectId: ULID; clientMessageId: string; ok: boolean
  status: 'received' | 'queued' | 'invalid' | 'error'; error?: string }

{ type: 'send-queue-snapshot'; projectId: ULID; sessionId: string
  items: Array<{ id: ULID; clientMessageId: string; text: string
    status: 'queued' | 'delivering' | 'delivered' | 'failed' | 'cancelled'
    failureReason: string | null; createdAt: number; updatedAt: number }> }

{ type: 'ask'; projectId: ULID; askId: ULID; sessionId: string | null
  toolName: string; toolUseId: string; toolInput: unknown }
```

The `clientMessageId` on the canonical user event is the primary optimistic-send
reconciliation key. Queue snapshots are still process-memory projections in
this as-built version; durable queue revisions and positive interrupt receipts
belong to the next conversation slice and are not claimed here.

Session lifecycle remains app-owned:

```ts
{ type: 'session-changed'; projectId: ULID
  transition: 'new-session' | 'resume-session'
  session: { id: string; projectId: ULID; model: string | null
    title: string | null; status: 'active' | 'ended'; startedAt: number } | null }
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

## Deliberately unfinished boundaries

- durable send queue, edit/remove revisions, and restart recovery;
- positive interrupt receipts and interrupt-and-send sequencing;
- safe operational activity and complete tool lifecycle families;
- immutable runtime/account/model/effort app-session stamps;
- provider-neutral context and usage observations;
- Codex adapter and conformance.

Those are subsequent slices; none has a compatibility wire in this contract.
