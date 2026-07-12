// Ask registry — the browser-answered permission seam (guard rule 4).
//
// A backend's `canUseTool` calls `ask()`, which emits an `ask` frame to the room
// and blocks on a pending promise keyed by `askId`. The browser answers with
// `ask-reply { askId, answer }` → `reply()` resolves it. A watchdog auto-resolves
// an abandoned ask as DENIED (typed, visible — never a hang). Keyed by `askId`,
// not `callId`: one canonical tool call can issue more than one request.

import { newId } from '@pc/db';
import type { AskFrame } from '@pc/contracts';
import type { ULID } from '@pc/domain';
import type { AskDecision, AskRequest } from '../runner/runtime.ts';
import { redactToolInput } from './tool-safety.ts';

/** Answers that grant permission. Anything else denies, carrying the answer as
 *  the denial reason (Phase 2 semantics; richer edit/allow-once is a looseEnd). */
const ALLOW_ANSWERS = new Set(['allow', 'approve', 'yes', 'allow-once', 'accept']);

interface Pending {
  resolve: (decision: AskDecision) => void;
  timer: ReturnType<typeof setTimeout>;
  toolName: string;
  frame: AskFrame;
  published: boolean;
}

export interface AskRegistryDeps {
  projectId: ULID;
  /** Emit the `ask` frame to the project room. */
  emit: (frame: AskFrame) => void;
  /** Watchdog window. Default 5 min. */
  timeoutMs?: number;
}

const DEFAULT_TIMEOUT_MS = 5 * 60_000;

export class AskRegistry {
  private readonly projectId: ULID;
  private readonly emit: (frame: AskFrame) => void;
  private readonly timeoutMs: number;
  private readonly pending = new Map<string, Pending>();

  constructor(deps: AskRegistryDeps) {
    this.projectId = deps.projectId;
    this.emit = deps.emit;
    this.timeoutMs = deps.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  }

  /** The AskHandler passed to an adapter. Registration is synchronous so the
   * adapter can emit approval-needed with this app request id before waiting.
   * SessionService publishes the card only after that canonical state commits. */
  ask = (req: AskRequest) => {
    const askId = newId();
    const frame: AskFrame = {
      type: 'ask',
      projectId: this.projectId,
      askId,
      sessionId: req.appSessionId,
      toolName: req.toolName,
      callId: req.callId,
      toolInput: redactToolInput(req.toolInput),
    };
    const decision = new Promise<AskDecision>((resolve) => {
      // NOT unref'd: a pending permission request is real work — the process
      // should stay alive until the browser answers or the watchdog denies.
      const timer = setTimeout(() => {
        this.pending.delete(askId);
        resolve({ behavior: 'deny', decidedBy: 'timeout', message: 'permission request timed out' });
      }, this.timeoutMs);
      this.pending.set(askId, { resolve, timer, toolName: req.toolName, frame, published: false });
    });
    return {
      requestId: askId,
      decision,
      cancel: () => this.cancel(askId),
    };
  };

  /** Publish after the matching canonical approval-needed event has committed. */
  publish(askId: string): boolean {
    const pending = this.pending.get(askId);
    if (!pending) return false;
    if (!pending.published) {
      pending.published = true;
      this.emit(pending.frame);
    }
    return true;
  }

  /** Reconnect snapshot for still-actionable, already-canonical approvals. */
  snapshot(): AskFrame[] {
    return [...this.pending.values()]
      .filter((pending) => pending.published)
      .map((pending) => pending.frame);
  }

  /** Resolve a pending ask from a browser `ask-reply`. Returns false if unknown
   *  (already answered / timed out) — the reply is a harmless no-op then. */
  reply(askId: string, answer: string): boolean {
    const p = this.pending.get(askId);
    if (!p) return false;
    this.pending.delete(askId);
    clearTimeout(p.timer);
    if (answer === '__cancelled__') {
      p.resolve({ behavior: 'deny', decidedBy: 'user', message: 'declined by user' });
      return true;
    }
    if (p.toolName === 'AskUserQuestion' || p.toolName === 'ExitPlanMode') {
      // Answer-style tools: interpretation of the reply is Claude-specific
      // (answers map / plan accept-reject), so defer to the adapter.
      p.resolve({ behavior: 'allow', decidedBy: 'user', rawAnswer: answer });
      return true;
    }
    const allow = ALLOW_ANSWERS.has(answer.trim().toLowerCase());
    p.resolve(
      allow
        ? { behavior: 'allow', decidedBy: 'user' }
        : { behavior: 'deny', decidedBy: 'user', message: answer.trim() || 'denied by user' },
    );
    return true;
  }

  /** Deny + clear every pending ask (session reset / dispose). */
  clear(reason = 'session ended'): void {
    for (const [, p] of this.pending) {
      clearTimeout(p.timer);
      p.resolve({ behavior: 'deny', decidedBy: 'session', message: reason });
    }
    this.pending.clear();
  }

  private cancel(askId: string): void {
    const pending = this.pending.get(askId);
    if (!pending) return;
    this.pending.delete(askId);
    clearTimeout(pending.timer);
    pending.resolve({
      behavior: 'deny',
      decidedBy: 'session',
      message: 'permission request cancelled',
    });
  }

  get openCount(): number {
    return this.pending.size;
  }
}
