// WS router — one connected socket's frame handling.
//
// On open: join the project room, send the connect snapshot in contract order
// (session-changed → orchestrator-state → session-replay → send-queue-snapshot).
// Then the client sends `subscribe { lastVersion }` and the relay replays
// resource events. Client frames: send | interrupt | ask-reply | subscribe |
// client-ping. Acks (send-ack, server-pong) go to the sender only; chat +
// resource broadcasts go to the whole room. Unknown frames are dropped silently.

import {
  isClientMessageType,
  type SendAckFrame,
  type SendAckStatus,
  type ServerPongFrame,
} from '@pc/contracts';
import type { ULID } from '@pc/domain';
import type { SessionRegistry } from '../chat/registry.ts';
import type { ResourceRelay } from '../resources/relay.ts';
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

  const ack = (clientMessageId: string, status: SendAckStatus, error?: string): void => {
    const frame: SendAckFrame = {
      type: 'send-ack',
      projectId,
      clientMessageId,
      ok: status === 'received' || status === 'queued',
      status,
      ...(error ? { error } : {}),
    };
    ProjectWebSocketHub.sendTo(socket, frame);
  };

  socket.on('message', (data: unknown) => {
    const text = coerceText(data);
    if (text === null) return;
    let msg: unknown;
    try {
      msg = JSON.parse(text);
    } catch {
      return; // unparseable — drop
    }
    if (typeof msg !== 'object' || msg === null) return;
    const m = msg as Record<string, unknown>;
    if (!isClientMessageType(m.type)) return; // unknown type — drop silently

    switch (m.type) {
      case 'send': {
        const clientMessageId = typeof m.clientMessageId === 'string' ? m.clientMessageId : '';
        const textField = typeof m.text === 'string' ? m.text : '';
        if (!clientMessageId) return; // malformed — can't reconcile without the id
        try {
          const status = svc.handleSend(textField, clientMessageId);
          ack(clientMessageId, status);
        } catch (err) {
          ack(clientMessageId, 'error', err instanceof Error ? err.message : String(err));
        }
        break;
      }
      case 'interrupt':
        void svc.handleInterrupt();
        break;
      case 'ask-reply': {
        const askId = typeof m.askId === 'string' ? m.askId : '';
        const answer = typeof m.answer === 'string' ? m.answer : '';
        if (askId) svc.handleAskReply(askId, answer);
        break;
      }
      case 'subscribe': {
        const lastVersion = typeof m.lastVersion === 'string' ? m.lastVersion : undefined;
        deps.relay.catchUp(socket, lastVersion, projectId);
        break;
      }
      case 'client-ping': {
        const pong: ServerPongFrame = {
          type: 'server-pong',
          projectId,
          nonce: typeof m.nonce === 'string' ? m.nonce : '',
          sentAt: typeof m.sentAt === 'number' ? m.sentAt : 0,
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
