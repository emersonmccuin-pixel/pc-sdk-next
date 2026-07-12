// Durable send-queue drain coordinator.
//
// Queue state, FIFO allocation, and the active-turn lease live in SQLite. This
// class owns only the process-local single-flight loop that claims one durable
// row at a time and hands its immutable revision to SessionService.

import {
  claimNextConversationTurn,
  type ClaimedConversationTurn,
} from '@pc/db';

export interface SendQueueDeps {
  /** Current durable app session for this project. */
  sessionId: () => string | null;
  /** Run one already-claimed, immutable turn through its runtime. */
  deliver: (turn: ClaimedConversationTurn) => Promise<void>;
  /** Publish committed conversation outbox rows. */
  afterCommit: () => void;
  /** Refresh latest-wins process state after claim/settlement. */
  onState: () => void;
  /** Diagnostic sink. A failed turn is settled by deliver; loop errors are
   * retried only after a later kick so a tight failure loop cannot form. */
  onError?: (error: unknown) => void;
}

export class SendQueue {
  private readonly deps: SendQueueDeps;
  private draining = false;
  private redrain = false;
  private scheduled = false;
  private disposed = false;
  private drainTask: Promise<void> | null = null;

  constructor(deps: SendQueueDeps) {
    this.deps = deps;
  }

  /** Schedule a drain after the caller's transaction has returned. Multiple
   * kicks collapse into one loop; a kick during delivery requests one recheck. */
  kick(): void {
    if (this.disposed) return;
    if (this.draining) {
      this.redrain = true;
      return;
    }
    if (this.scheduled) return;
    this.scheduled = true;
    queueMicrotask(() => {
      this.scheduled = false;
      if (this.disposed) return;
      const task = this.drain();
      this.drainTask = task;
      void task.finally(() => {
        if (this.drainTask === task) this.drainTask = null;
      });
    });
  }

  async dispose(): Promise<void> {
    this.disposed = true;
    const task = this.drainTask;
    if (task) await task;
  }

  private async drain(): Promise<void> {
    if (this.disposed || this.draining) return;
    this.draining = true;
    try {
      do {
        this.redrain = false;
        for (;;) {
          if (this.disposed) return;
          const sessionId = this.deps.sessionId();
          if (!sessionId) return;
          const turn = claimNextConversationTurn(sessionId);
          if (!turn) break;
          // Claim committed send-state + user/agent-envelope + running as one
          // unit. Publish it before starting provider work.
          this.deps.afterCommit();
          this.deps.onState();
          await this.deps.deliver(turn);
          this.deps.afterCommit();
          this.deps.onState();
        }
      } while (this.redrain);
    } catch (error) {
      this.deps.onError?.(error);
    } finally {
      this.draining = false;
      // A commit may have arrived between the final loop check and clearing
      // `draining`; preserve that wake-up.
      if (this.redrain && !this.disposed) this.kick();
    }
  }
}
