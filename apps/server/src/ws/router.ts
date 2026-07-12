// WS router — one connected socket's frame handling.
//
// On open: join the project room, send the connect snapshot in contract order
// (session-changed → orchestrator-state, then replay + queue snapshot when an
// active session exists).
// Then the client sends `subscribe { lastVersion }` and the relay replays
// resource events. Client frames: send | interrupt | ask-reply | subscribe |
// client-ping. Command receipts and server-pong go to the sender only; chat +
// resource broadcasts go to the whole room. Unknown frames are dropped silently.

import {
  isClientMessage,
  type ConversationCommand,
  type ConversationCommandKind,
  type ConversationCommandReceiptFrame,
  type ServerPongFrame,
} from '@pc/contracts';
import type { ULID } from '@pc/domain';
import type { SessionRegistry } from '../chat/registry.ts';
import type { ResourceRelay } from '../resources/relay.ts';
import { RuntimeSelectionRejectedError } from '../runner/runtime.ts';
import { ProjectWebSocketHub, type WebSocketLike } from './hub.ts';

export interface RouterSocket extends WebSocketLike {
  on(event: 'message', cb: (data: unknown) => void): void;
  on(event: 'close', cb: () => void): void;
  on(event: 'error', cb: (err: unknown) => void): void;
}

export interface RouterDeps {
  hub: ProjectWebSocketHub<ULID>;
  registry: SessionRegistry;
  relay: ResourceRelay;
}

function coerceText(data: unknown): string | null {
  if (typeof data === 'string') return data;
  if (data instanceof Buffer) return data.toString('utf8');
  if (data instanceof ArrayBuffer) return Buffer.from(data).toString('utf8');
  if (ArrayBuffer.isView(data)) return Buffer.from(data.buffer, data.byteOffset, data.byteLength).toString('utf8');
  return null;
}

/** Wire a freshly-opened socket to a project. Returns a detach fn (also runs on
 *  socket close). */
export function attachSocket(socket: RouterSocket, projectId: ULID, deps: RouterDeps): () => void {
  const svc = deps.registry.get(projectId);
  const unsubscribe = deps.hub.subscribe(projectId, socket);

  // Connect snapshot, in contract order.
  for (const frame of svc.connectSnapshot()) ProjectWebSocketHub.sendTo(socket, frame);

  socket.on('message', (data: unknown) => {
    const text = coerceText(data);
    if (text === null) return;
    let msg: unknown;
    try {
      msg = JSON.parse(text);
    } catch {
      return; // unparseable — drop
    }
    if (!isClientMessage(msg)) {
      const invalid = invalidConversationCommandReceipt(msg, projectId);
      if (invalid) ProjectWebSocketHub.sendTo(socket, invalid);
      return;
    }
    const m = msg;

    switch (m.type) {
      case 'send':
      case 'edit-queued-message':
      case 'remove-queued-message':
      case 'interrupt':
      case 'interrupt-and-send': {
        void handleConversationCommand(socket, projectId, svc, m);
        break;
      }
      case 'ask-reply': {
        svc.handleAskReply(m.askId, m.answer);
        break;
      }
      case 'subscribe': {
        try {
          deps.relay.catchUp(socket, m.lastVersion, projectId);
        } catch {
          // Replay failure is isolated to this attempt. The client can
          // reconnect/re-prime; an event-listener exception must not escape.
        }
        break;
      }
      case 'client-ping': {
        const pong: ServerPongFrame = {
          type: 'server-pong',
          projectId,
          nonce: m.nonce,
          sentAt: m.sentAt,
          serverTime: Date.now(),
        };
        ProjectWebSocketHub.sendTo(socket, pong);
        break;
      }
    }
  });

  const detach = (): void => unsubscribe();
  socket.on('close', detach);
  socket.on('error', detach);
  return detach;
}

/** Strict command guards protect the service boundary, but a malformed known
 * command with a usable correlation id still needs terminal sender feedback.
 * Unknown frames and uncorrelatable garbage remain silent. */
function invalidConversationCommandReceipt(
  value: unknown,
  projectId: ULID,
): ConversationCommandReceiptFrame | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const frame = value as Record<string, unknown>;
  const command = frame.type;
  if (!isConversationCommandKind(command)) return null;
  const idKey = command === 'interrupt' || command === 'interrupt-and-send'
    ? 'requestId'
    : 'commandId';
  const commandId = frame[idKey];
  if (typeof commandId !== 'string' || commandId.trim().length === 0) return null;
  return {
    type: 'conversation-command-receipt',
    projectId,
    sessionId: typeof frame.sessionId === 'string' && frame.sessionId.length > 0
      ? frame.sessionId
      : null,
    commandId,
    command,
    status: 'rejected',
    error: {
      code: 'invalid',
      message: 'conversation command failed strict validation',
    },
  };
}

function isConversationCommandKind(value: unknown): value is ConversationCommandKind {
  return value === 'send' ||
    value === 'edit-queued-message' ||
    value === 'remove-queued-message' ||
    value === 'interrupt' ||
    value === 'interrupt-and-send';
}

async function handleConversationCommand(
  socket: RouterSocket,
  projectId: ULID,
  service: ReturnType<SessionRegistry['get']>,
  command: ConversationCommand,
): Promise<void> {
  const commandId = command.type === 'interrupt' || command.type === 'interrupt-and-send'
    ? command.requestId
    : command.commandId;
  try {
    const result = await service.handleConversationCommand(command);
    const frame: ConversationCommandReceiptFrame = {
      type: 'conversation-command-receipt',
      projectId,
      sessionId: result.sessionId,
      commandId,
      command: command.type,
      status: result.status,
      ...(result.queueItemId ? { queueItemId: result.queueItemId } : {}),
      ...(result.revision !== undefined ? { revision: result.revision } : {}),
      ...(result.interruptRequestId ? { interruptRequestId: result.interruptRequestId } : {}),
      error: result.error,
    };
    ProjectWebSocketHub.sendTo(socket, frame);
  } catch (error) {
    const selectionFailure = error instanceof RuntimeSelectionRejectedError;
    const frame: ConversationCommandReceiptFrame = {
      type: 'conversation-command-receipt',
      projectId,
      sessionId: command.sessionId,
      commandId,
      command: command.type,
      status: 'rejected',
      error: {
        code: selectionFailure ? error.code : 'internal',
        message: selectionFailure
          ? 'the selected runtime session is unavailable'
          : error instanceof Error ? error.message : String(error),
      },
    };
    ProjectWebSocketHub.sendTo(socket, frame);
  }
}
