// Per-project WebSocket fanout. Multiple sockets per project are first-class
// (multi-tab, reload races, split views) — reconnecting one must not detach the
// others. Broadcasts go to the whole room; acks go to a single socket (router).

export interface WebSocketLike {
  readonly OPEN: number;
  readyState: number;
  send(data: string): void;
}

export class ProjectWebSocketHub<ProjectId extends string = string> {
  private rooms = new Map<ProjectId, Set<WebSocketLike>>();

  subscribe(projectId: ProjectId, socket: WebSocketLike): () => void {
    let set = this.rooms.get(projectId);
    if (!set) {
      set = new Set();
      this.rooms.set(projectId, set);
    }
    set.add(socket);
    let detached = false;
    return () => {
      if (detached) return;
      detached = true;
      const current = this.rooms.get(projectId);
      if (!current) return;
      current.delete(socket);
      if (current.size === 0 && this.rooms.get(projectId) === current) this.rooms.delete(projectId);
    };
  }

  broadcast(projectId: ProjectId, msg: unknown): number {
    const set = this.rooms.get(projectId);
    if (!set) return 0;
    const data = JSON.stringify(msg);
    let sent = 0;
    for (const socket of set) {
      if (socket.readyState !== socket.OPEN) {
        set.delete(socket);
        continue;
      }
      try {
        socket.send(data);
        sent++;
      } catch {
        set.delete(socket);
      }
    }
    if (set.size === 0) this.rooms.delete(projectId);
    return sent;
  }

  /** Fan a global frame to every socket in every room (global-scope resources). */
  broadcastAll(msg: unknown): number {
    const data = JSON.stringify(msg);
    let sent = 0;
    for (const projectId of [...this.rooms.keys()]) {
      const set = this.rooms.get(projectId);
      if (!set) continue;
      for (const socket of set) {
        if (socket.readyState !== socket.OPEN) {
          set.delete(socket);
          continue;
        }
        try {
          socket.send(data);
          sent++;
        } catch {
          set.delete(socket);
        }
      }
      if (set.size === 0) this.rooms.delete(projectId);
    }
    return sent;
  }

  /** Send to one socket (acks). No-op if the socket is not open. */
  static sendTo(socket: WebSocketLike, msg: unknown): void {
    if (socket.readyState !== socket.OPEN) return;
    try {
      socket.send(JSON.stringify(msg));
    } catch {
      /* best-effort; keepalive reaps a dead socket */
    }
  }

  count(projectId: ProjectId): number {
    return this.rooms.get(projectId)?.size ?? 0;
  }
}
