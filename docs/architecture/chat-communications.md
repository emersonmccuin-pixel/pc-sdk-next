# Chat and communication architecture

Status: target contract for the conversation-foundation phase. The current v1
wire remains documented in `docs/event-contract.md` until this contract is
implemented in one producer/persistence/consumer migration.

## Principle

Chat is an ordered projection of several communication families, not a generic
array of message-shaped objects. Each family has explicit lifecycle semantics.
The server owns order and durable truth; the browser owns presentation.

## Canonical families

| Family | Examples | Durable? | Main presentation |
| --- | --- | --- | --- |
| User input | queued, edited, cancelled, delivering, accepted, failed | Yes | Composer queue and user bubble |
| Assistant output | item-start, text delta, item-end | Yes at stable checkpoints; replay-equivalent | Growing assistant bubble |
| Activity | turn starting, reading context, waiting for tool, reviewing result | Yes when meaningful | Status line above composer |
| Tool | requested, approval-needed, running, succeeded, failed | Yes | Collapsed activity with details |
| Agent | dispatched, started, progress, ask, delivered, verified, landed, failed | Yes | Concise chat card; full run view |
| Control | interrupt requested/confirmed/failed, session switch, compaction | Yes | Inline status/control feedback |
| Telemetry | context observation, quota observation, duration | Snapshot/event as appropriate | Context bar and usage panel |
| System | degraded integration, recovery, warning, fatal error | Yes when user-relevant | Typed notice |

Activity text is a safe operational summary. Private chain-of-thought is not a
product event and is neither persisted nor displayed. Provider reasoning
summaries may be shown only when the runtime explicitly exposes a safe summary
capability and the adapter maps it to that canonical type.

## Identity and ordering

Every durable conversation event carries:

```ts
interface ConversationEventIdentity {
  conversationId: string;
  sessionId: string;
  sequence: number;
  turnId?: string;
  itemId: string;
  streamId?: string;
  deltaIndex?: number;
  occurredAt: number;
}
```

`sequence` is assigned transactionally by the server and is authoritative.
Timestamps are display metadata. Stream deltas reconcile by stable `itemId` and
ordered `deltaIndex`; provider-native IDs do not cross the adapter boundary.

The durable event and its outbox record commit together. Live publication uses
the outbox. A reconnect replays after the last durable cursor and produces the
same projection as uninterrupted delivery. Client-generated idempotency keys
prevent duplicate sends; server sequences prevent ambiguous order.

## User send queue

```text
queued -> delivering -> accepted
   |           |          |
 edited     failed     rendered
   |
cancelled
```

- A send while a turn is active is durably queued before acknowledgement.
- FIFO is authoritative unless the user edits/removes an undelivered entry.
- Editing creates a revision; delivery snapshots the accepted revision.
- Once `delivering`, content is immutable.
- “Interrupt and send” records an interrupt request, waits for a positive
  terminal receipt for the active turn, then delivers the selected queue item.
- Restart/reconnect reconstructs the queue from durable state.

## Turns and visible activity

Exactly one turn is active per session unless a future adapter capability and
product decision explicitly widen that rule. Every turn ends in exactly one
canonical terminal outcome. While nonterminal, the composer area shows the
runtime/model, honest current activity, elapsed time, interrupt control, and
queued-message count. Silence becomes “still waiting” after a threshold; it
does not become invented progress.

## Tool lifecycle

Each call has a stable canonical call ID and moves through allowed transitions:

```text
requested -> approval-needed -> running -> succeeded
        \---------------------> running -> failed
                         \--------------> denied
```

The event contains a safe summary, timestamps, approval provenance, and an
optional expandable technical payload subject to redaction policy.

## Agent communication

Agent/orchestrator communication uses the durable mailbox and typed asks. Chat
receives projections, not direct side-channel text. A pausing ask follows:

```text
ask committed -> run paused -> addressed recipient notified
-> answer atomically recorded -> stamped runtime session resumed
```

Agent progress is best-effort information. A typed deliverable, deterministic
verification receipt, and landing receipt remain authoritative.

## Migration constraints

1. Replace `sdkUuid`/`sdkSessionId` canonical names in one coordinated pass.
2. Persist the send queue before claiming crash-safe ordering.
3. Never infer context fullness by summing incomplete turn usage.
4. Preserve the existing visual shell while replacing reducers and state
   ownership where the contract requires it.
5. Keep the old event document labelled as-built until conformance tests prove
   the new wire end to end.

