// The contract transport (docs/event-contract.md §Transport). One WebSocket per
// project. Heartbeat: client-ping every interval, silence ⇒ close(4000) +
// 2/5/15/30s backoff; force-reconnect on visibility/online/focus. On open the
// ws-epoch bumps (HTTP-seeded lists refetch) and we subscribe{lastVersion} with
// a persisted cursor; `live-reset` clears the cursor + epoch-refetches. Frames
// route to the chat store (channel 1) and the resource stores (channel 2/3);
// unknown types drop silently.

import { useLayoutEffect, useRef, useState } from 'react';
import {
  isAskFrame,
  isAgentEventFrame,
  isConversationCommandReceiptFrame,
  isConversationEventFrame,
  isLiveResetFrame,
  isOrchestratorStateFrame,
  isResourceFrame,
  isSendQueueSnapshotFrame,
  isSessionChangedFrame,
  isSessionReplayFrame,
} from '@pc/contracts';
import type {
  ClientMessage,
  InterruptReplacement,
  ResourceFrame,
} from '@pc/contracts';

import { useAgentEventStore } from '@/state/agent-event-store';
import { useChatStore } from '@/state/chat-store';
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
  sendText: (input: {
    commandId: string;
    sessionId: string | null;
    text: string;
    clientMessageId: string;
  }) => boolean;
  editQueued: (input: {
    commandId: string;
    sessionId: string;
    queueItemId: string;
    expectedRevision: number;
    text: string;
  }) => boolean;
  removeQueued: (input: {
    commandId: string;
    sessionId: string;
    queueItemId: string;
    expectedRevision: number;
  }) => boolean;
  interrupt: (input: { requestId: string; sessionId: string; targetTurnId: string }) => boolean;
  interruptAndSend: (input: {
    requestId: string;
    sessionId: string;
    targetTurnId: string;
    replacement: InterruptReplacement;
  }) => boolean;
  askReply: (askId: string, answer: string) => boolean;
}

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
    const ws = this.ws;
    this.ws = null;
    if (ws) {
      ws.onopen = null;
      ws.onmessage = null;
      ws.onclose = null;
      ws.onerror = null;
      ws.close();
    }
    useConnectionStore.getState().setStatus('idle');
  }

  private onVisibility = () => {
    if (document.visibilityState === 'visible') this.forceReconnect();
  };

  private forceReconnect = () => {
    if (this.closedByUser) return;
    if (
      this.ws &&
      (this.ws.readyState === WebSocket.CONNECTING || this.ws.readyState === WebSocket.OPEN)
    ) return;
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    this.attempt = 0;
    this.connect();
  };

  private connect(): void {
    if (this.closedByUser) return;
    if (
      this.ws &&
      (this.ws.readyState === WebSocket.CONNECTING || this.ws.readyState === WebSocket.OPEN)
    ) return;
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
      if (this.closedByUser || this.ws !== ws) return;
      this.attempt = 0;
      useConnectionStore.getState().setStatus('open');
      useConnectionStore.getState().bumpEpoch();
      this.armSilence();
      this.startPing();
      this.send({ type: 'subscribe', lastVersion: this.cursor });
    };
    ws.onmessage = (ev) => {
      if (this.closedByUser || this.ws !== ws) return;
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
      if (this.closedByUser || this.ws !== ws) return;
      this.ws = null;
      this.clearTimers();
      useConnectionStore.getState().setStatus('closed');
      this.scheduleReconnect();
    };
    ws.onerror = () => {
      if (this.closedByUser || this.ws !== ws) return;
      // close handler drives the reconnect; nothing to do here.
    };
  }

  private route(frame: unknown): void {
    if (this.closedByUser) return;
    if (!frame || typeof (frame as { type?: unknown }).type !== 'string') return;
    const frameProjectId = (frame as { projectId?: unknown }).projectId;
    if (typeof frameProjectId === 'string' && frameProjectId !== this.projectId) return;
    const type = (frame as { type: string }).type;
    if (type === 'conversation-event' && isConversationEventFrame(frame)) {
      useChatStore.getState().ingest(frame);
      return;
    }
    if (type === 'session-replay' && isSessionReplayFrame(frame)) {
      useChatStore.getState().ingest(frame);
      return;
    }
    if (type === 'session-changed' && isSessionChangedFrame(frame)) {
      useChatStore.getState().ingest(frame);
      return;
    }
    if (type === 'conversation-command-receipt' && isConversationCommandReceiptFrame(frame)) {
      useChatStore.getState().ingest(frame);
      return;
    }
    if (type === 'send-queue-snapshot' && isSendQueueSnapshotFrame(frame)) {
      useChatStore.getState().ingest(frame);
      return;
    }
    if (type === 'ask' && isAskFrame(frame)) {
      useChatStore.getState().ingest(frame);
      return;
    }
    switch (type) {
      case 'server-pong':
        break; // liveness already registered
      case 'orchestrator-state':
        if (isOrchestratorStateFrame(frame)) {
          useConnectionStore.getState().setOrchestratorState(frame);
        }
        break;
      case 'resource':
        if (isResourceFrame(frame)) this.onResource(frame);
        break;
      case 'live-reset':
        if (!isLiveResetFrame(frame)) break;
        this.cursor = undefined;
        writeCursor(this.projectId, null);
        useResourceStore.getState().applyLiveReset(frame);
        useConnectionStore.getState().bumpEpoch();
        break;
      case 'agent-event':
        // Latency-class agent transcript stream (Channel 3) — live buffer only;
        // missed frames heal on modal open via the HTTP backfill.
        if (isAgentEventFrame(frame)) {
          useAgentEventStore.getState().applyAgentEventFrame(frame);
        }
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
    if (this.closedByUser || !this.ws || this.ws.readyState !== WebSocket.OPEN) return false;
    this.ws.send(JSON.stringify(msg));
    return true;
  }

  readonly api: SocketApi = {
    sendText: (input) => this.send({ type: 'send', ...input }),
    editQueued: (input) => this.send({ type: 'edit-queued-message', ...input }),
    removeQueued: (input) => this.send({ type: 'remove-queued-message', ...input }),
    interrupt: (input) => this.send({ type: 'interrupt', ...input }),
    interruptAndSend: (input) => this.send({ type: 'interrupt-and-send', ...input }),
    askReply: (askId, answer) => this.send({ type: 'ask-reply', askId, answer }),
  };
}

export function randomId(): string {
  return globalThis.crypto?.randomUUID?.() ?? `id-${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

/** Mounts a project socket for the component's lifetime; returns the send API.
 *  Liveness + orchestrator health flow through the connection store. */
export function useProjectSocket(projectId: string | null): SocketApi | null {
  const [boundApi, setBoundApi] = useState<{ projectId: string; api: SocketApi } | null>(null);
  const socketRef = useRef<ProjectSocket | null>(null);

  useLayoutEffect(() => {
    // Project-owned singleton projections must be blanked before the first
    // paint of a successor project. The API is also project-bound below.
    useChatStore.getState().reset();
    useConnectionStore.getState().resetProjectState();
    if (!projectId) {
      setBoundApi(null);
      return;
    }
    const socket = new ProjectSocket(projectId);
    socketRef.current = socket;
    socket.start();
    setBoundApi({ projectId, api: socket.api });
    return () => {
      socket.stop();
      socketRef.current = null;
    };
  }, [projectId]);

  return boundApi?.projectId === projectId ? boundApi.api : null;
}
