// Ask registry — the browser-answered permission seam (guard rule 4).
//
// A backend's `canUseTool` calls `ask()`, which emits an `ask` frame to the room
// and blocks on a pending promise keyed by `askId`. The browser answers with
// `ask-reply { askId, answer }` → `reply()` resolves it. A watchdog auto-resolves
// an abandoned ask as DENIED (typed, visible — never a hang). Keyed by `askId`,
// not toolUseId: one tool use can re-ask after edits.

import { newId } from '@pc/db';
import type { AskFrame } from '@pc/contracts';
import type { ULID } from '@pc/domain';
import type { AskDecision, AskRequest } from '../runner/runtime.ts';

/** Answers that grant permission. Anything else denies, carrying the answer as
 *  the denial reason (Phase 2 semantics; richer edit/allow-once is a looseEnd). */
const ALLOW_ANSWERS = new Set(['allow', 'approve', 'yes', 'allow-once', 'accept']);

interface Pending {
  resolve: (decision: AskDecision) => void;
  timer: ReturnType<typeof setTimeout>;
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

  /** The AskHandler passed to a backend. Emits the frame, blocks until answered
   *  or the watchdog denies. */
  ask = (req: AskRequest): Promise<AskDecision> => {
    const askId = newId();
    const frame: AskFrame = {
      type: 'ask',
      projectId: this.projectId,
      askId,
      sessionId: req.sessionId,
      toolName: req.toolName,
      toolUseId: req.toolUseId,
      toolInput: req.toolInput,
    };
    return new Promise<AskDecision>((resolve) => {
      // NOT unref'd: a pending permission request is real work — the process
      // should stay alive until the browser answers or the watchdog denies.
      const timer = setTimeout(() => {
        this.pending.delete(askId);
        resolve({ behavior: 'deny', message: 'permission request timed out' });
      }, this.timeoutMs);
      this.pending.set(askId, { resolve, timer });
      this.emit(frame);
    });
  };

  /** Resolve a pending ask from a browser `ask-reply`. Returns false if unknown
   *  (already answered / timed out) — the reply is a harmless no-op then. */
  reply(askId: string, answer: string): boolean {
    const p = this.pending.get(askId);
    if (!p) return false;
    this.pending.delete(askId);
    clearTimeout(p.timer);
    const allow = ALLOW_ANSWERS.has(answer.trim().toLowerCase());
    p.resolve(
      allow
        ? { behavior: 'allow' }
        : { behavior: 'deny', message: answer.trim() || 'denied by user' },
    );
    return true;
  }

  /** Deny + clear every pending ask (session reset / dispose). */
  clear(reason = 'session ended'): void {
    for (const [, p] of this.pending) {
      clearTimeout(p.timer);
      p.resolve({ behavior: 'deny', message: reason });
    }
    this.pending.clear();
  }

  get openCount(): number {
    return this.pending.size;
  }
}
