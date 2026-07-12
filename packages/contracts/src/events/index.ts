// Event contract v1 — the single source for every shape the server emits to the
// browser and every client→server message. See docs/event-contract.md.

export * from './chat.ts';
export * from './session.ts';
export * from './messages.ts';
export * from './resources.ts';
export * from './agent.ts';

import type { ConversationEventFrame } from './chat.ts';
import type {
  SessionChangedFrame,
  SessionReplayFrame,
  SessionUpdatedFrame,
} from './session.ts';
import type {
  ConversationCommandReceiptFrame,
  SendQueueSnapshotFrame,
  AskFrame,
  ServerPongFrame,
} from './messages.ts';
import type { ResourceFrame, LiveResetFrame } from './resources.ts';
import type { AgentEventFrame, OrchestratorStateFrame } from './agent.ts';

/** Every server → client frame. Consumers dispatch on `type`; unknown types are
 *  dropped silently (unknown-tolerant by design). */
export type ServerFrame =
  | ConversationEventFrame
  | SessionChangedFrame
  | SessionUpdatedFrame
  | SessionReplayFrame
  | ConversationCommandReceiptFrame
  | SendQueueSnapshotFrame
  | AskFrame
  | ServerPongFrame
  | ResourceFrame
  | LiveResetFrame
  | AgentEventFrame
  | OrchestratorStateFrame;
