// The contract transport (docs/event-contract.md §Transport). One WebSocket per
// project. Heartbeat: client-ping every interval, silence ⇒ close(4000) +
// 2/5/15/30s backoff; force-reconnect on visibility/online/focus. On open the
// ws-epoch bumps (HTTP-seeded lists refetch) and we subscribe{lastVersion} with
// a persisted cursor; `live-reset` clears the cursor + epoch-refetches. Frames
// route to the chat store (channel 1) and the resource stores (channel 2/3);
// unknown types drop silently.

import { useEffect, useRef, useState } from 'react';
import { isConversationEventFrame, isSessionReplayFrame } from '@pc/contracts';
import type {
  ClientMessage,
  OrchestratorHealth,
  ResourceFrame,
  ServerFrame,
} from '@pc/contracts';

import { useAgentEventStore } from '@/state/agent-event-store';
import { useChatStore, type ChatChannelFrame } from '@/state/chat-store';
import { useConnectionStore } from '@/state/connection';
import { useResourceStore } from '@/state/resource-store';
import { useUsageStore } from '@/state/usage-store';
import { useMcpStatus } from '@/state/mcp-status';

const PING_INTERVAL_MS = 15_000;
const SILENCE_TIMEOUT_MS = 30_000;
const BACKOFF_MS = [2_000, 5_000, 15_000, 30_000] as const;

function cursorKey(projectId: string): string {
  return `pc:resource-cursor:${projectId}`;
}
function readCursor(projectId: string): string | undefined {
  try {
    return localStorage.getItem(cursorKey(projectId)) ?? undefined;
  } catch {
    return undefined;
  }
}
function writeCursor(projectId: string, cursor: string | null): void {
  try {
    if (cursor === null) localStorage.removeItem(cursorKey(projectId));
    else localStorage.setItem(cursorKey(projectId), cursor);
  } catch {
    /* best effort */
  }
}

export interface SocketApi {
  sendText: (text: string, clientMessageId: string) => boolean;
  interrupt: () => boolean;
  askReply: (askId: string, answer: string) => boolean;
}

const CHAT_CHANNEL_TYPES = new Set<ChatChannelFrame['type']>([
  'conversation-event',
  'session-changed',
  'session-replay',
  'send-ack',
  'send-queue-snapshot',
  'ask',
]);

/** Owns one project socket for its lifetime. Not a singleton — the React hook
 *  creates/tears one down as the shown project changes. */
export class ProjectSocket {
  private ws: WebSocket | null = null;
  private pingTimer: ReturnType<typeof setInterval> | null = null;
  private silenceTimer: ReturnType<typeof setTimeout> | null = null;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private attempt = 0;
  private closedByUser = false;
  private cursor: string | undefined;
  private readonly projectId: string;

  constructor(projectId: string) {
    this.projectId = projectId;
    this.cursor = readCursor(projectId);
  }

  start(): void {
    this.closedByUser = false;
    this.connect();
    window.addEventListener('online', this.forceReconnect);
    window.addEventListener('focus', this.forceReconnect);
    document.addEventListener('visibilitychange', this.onVisibility);
  }

  stop(): void {
    this.closedByUser = true;
    window.removeEventListener('online', this.forceReconnect);
    window.removeEventListener('focus', this.forceReconnect);
    document.removeEventListener('visibilitychange', this.onVisibility);
    this.clearTimers();
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.ws?.close();
    this.ws = null;
    useConnectionStore.getState().setStatus('idle');
  }

  private onVisibility = () => {
    if (document.visibilityState === 'visible') this.forceReconnect();
  };

  private forceReconnect = () => {
    if (this.closedByUser) return;
    if (this.ws && this.ws.readyState === WebSocket.OPEN) return;
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    this.attempt = 0;
    this.connect();
  };

  private connect(): void {
    this.clearTimers();
    useConnectionStore.getState().setStatus('connecting');
    const proto = location.protocol === 'https:' ? 'wss' : 'ws';
    const url = `${proto}://${location.host}/ws?projectId=${encodeURIComponent(this.projectId)}`;
    let ws: WebSocket;
    try {
      ws = new WebSocket(url);
    } catch {
      this.scheduleReconnect();
      return;
    }
    this.ws = ws;

    ws.onopen = () => {
      this.attempt = 0;
      useConnectionStore.getState().setStatus('open');
      useConnectionStore.getState().bumpEpoch();
      this.armSilence();
      this.startPing();
      this.send({ type: 'subscribe', lastVersion: this.cursor });
    };
    ws.onmessage = (ev) => {
      this.armSilence();
      let frame: unknown;
      try {
        frame = JSON.parse(ev.data as string);
      } catch {
        return; // unparseable — drop
      }
      this.route(frame);
    };
    ws.onclose = () => {
      this.clearTimers();
      if (this.closedByUser) return;
      useConnectionStore.getState().setStatus('closed');
      this.scheduleReconnect();
    };
    ws.onerror = () => {
      // close handler drives the reconnect; nothing to do here.
    };
  }

  private route(frame: unknown): void {
    if (!frame || typeof (frame as { type?: unknown }).type !== 'string') return;
    const type = (frame as { type: string }).type;
    if (type === 'conversation-event') {
      if (isConversationEventFrame(frame)) useChatStore.getState().ingest(frame);
      return;
    }
    if (type === 'session-replay') {
      if (isSessionReplayFrame(frame)) useChatStore.getState().ingest(frame);
      return;
    }
    if (CHAT_CHANNEL_TYPES.has(type as ChatChannelFrame['type'])) {
      useChatStore.getState().ingest(frame as ChatChannelFrame);
      return;
    }
    const serverFrame = frame as ServerFrame;
    switch (serverFrame.type) {
      case 'server-pong':
        break; // liveness already registered
      case 'orchestrator-state':
        this.setHealth(serverFrame.health);
        break;
      case 'resource':
        this.onResource(serverFrame);
        break;
      case 'live-reset':
        this.cursor = undefined;
        writeCursor(this.projectId, null);
        useResourceStore.getState().applyLiveReset(serverFrame);
        useConnectionStore.getState().bumpEpoch();
        break;
      case 'agent-event':
        // Latency-class agent transcript stream (Channel 3) — live buffer only;
        // missed frames heal on modal open via the HTTP backfill.
        useAgentEventStore.getState().applyAgentEventFrame(serverFrame);
        break;
      default:
        break;
    }
  }

  private onResource(frame: ResourceFrame): void {
    const ev = frame.event;
    this.cursor = ev.cursor;
    writeCursor(this.projectId, ev.cursor);
    // Identity-keyed store — feeds agent-run/contract consumers (activity rail).
    useResourceStore.getState().applyResourceFrame(frame);
    if (ev.entity === 'usage') {
      useUsageStore.getState().setSnapshot(ev.payload);
    } else if (ev.entity === 'mcp-server') {
      const server = ev.payload.server;
      const store = useMcpStatus.getState();
      const others = store.servers.filter((s) => s.id !== server.id);
      store.setServers([
        ...others,
        { id: server.id, name: server.name, status: server.status, toolCount: server.toolCount },
      ]);
    }
  }

  private setHealth(health: OrchestratorHealth): void {
    useConnectionStore.getState().setOrchestratorHealth(health);
  }

  private armSilence(): void {
    if (this.silenceTimer) clearTimeout(this.silenceTimer);
    this.silenceTimer = setTimeout(() => {
      // Silence == death. close(4000) triggers onclose → reconnect.
      this.ws?.close(4000, 'heartbeat-silence');
    }, SILENCE_TIMEOUT_MS);
  }

  private startPing(): void {
    if (this.pingTimer) clearInterval(this.pingTimer);
    this.pingTimer = setInterval(() => {
      this.send({ type: 'client-ping', nonce: randomId(), sentAt: Date.now() });
    }, PING_INTERVAL_MS);
  }

  private clearTimers(): void {
    if (this.pingTimer) clearInterval(this.pingTimer);
    if (this.silenceTimer) clearTimeout(this.silenceTimer);
    this.pingTimer = null;
    this.silenceTimer = null;
  }

  private scheduleReconnect(): void {
    if (this.closedByUser) return;
    const delay = BACKOFF_MS[Math.min(this.attempt, BACKOFF_MS.length - 1)]!;
    this.attempt += 1;
    this.reconnectTimer = setTimeout(() => this.connect(), delay);
  }

  private send(msg: ClientMessage): boolean {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return false;
    this.ws.send(JSON.stringify(msg));
    return true;
  }

  readonly api: SocketApi = {
    sendText: (text, clientMessageId) => this.send({ type: 'send', text, clientMessageId }),
    interrupt: () => this.send({ type: 'interrupt' }),
    askReply: (askId, answer) => this.send({ type: 'ask-reply', askId, answer }),
  };
}

export function randomId(): string {
  return globalThis.crypto?.randomUUID?.() ?? `id-${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

/** Mounts a project socket for the component's lifetime; returns the send API.
 *  Liveness + orchestrator health flow through the connection store. */
export function useProjectSocket(projectId: string | null): SocketApi | null {
  const [api, setApi] = useState<SocketApi | null>(null);
  const socketRef = useRef<ProjectSocket | null>(null);

  useEffect(() => {
    if (!projectId) {
      setApi(null);
      return;
    }
    // Fresh session context on project switch — the socket's connect-snapshot reseeds.
    useChatStore.getState().reset();
    const socket = new ProjectSocket(projectId);
    socketRef.current = socket;
    socket.start();
    setApi(socket.api);
    return () => {
      socket.stop();
      socketRef.current = null;
    };
  }, [projectId]);

  return api;
}
