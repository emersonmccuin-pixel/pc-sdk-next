// FakeRuntime — deterministic, scripted RuntimeSession for tests.
//
// A queue of scripted turns. Each turn is a list of RuntimeEvents the session
// yields in order. A step may be `{ hang: true }` — the turn stalls there until
// `interrupt()` (or `dispose()`) fires, modelling a mid-turn server kill for the
// kill-recovery test. `interrupt()` on a hung turn ends the stream with a
// canonical aborted `result` unless the script already supplies a
// terminal, keeping the turn-runner's "exactly one terminal" contract honest.

import type { ContextObservation, RuntimeEvent, RuntimeSession } from './runtime.ts';

/** A hang marker: the turn stalls here until interrupt/dispose. */
export interface HangStep {
  hang: true;
}
export type ScriptStep = RuntimeEvent | HangStep;
export type ScriptedTurn = ScriptStep[];

function isHang(step: ScriptStep): step is HangStep {
  return (step as HangStep).hang === true;
}

export interface FakeRuntimeOptions {
  /** One entry per expected turn, consumed FIFO. A turn sent past the end of
   *  the script yields a lone success `result`. */
  turns?: ScriptedTurn[];
  /** Delay (ms) between yielded steps. 0 = synchronous microtask cadence. */
  stepDelayMs?: number;
  /** Current-context observation or a scripted observer. Defaults to explicit
   *  unsupported rather than inventing context from scripted turn usage. */
  contextObservation?: ContextObservation | (() => ContextObservation | Promise<ContextObservation>);
}

/** A resolved abort signal the current hung turn awaits. */
interface Interruptible {
  promise: Promise<void>;
  resolve: () => void;
}

function deferred(): Interruptible {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

export class FakeRuntime implements RuntimeSession {
  private readonly turns: ScriptedTurn[];
  private readonly stepDelayMs: number;
  private readonly contextObservation: NonNullable<FakeRuntimeOptions['contextObservation']>;
  private turnIndex = 0;
  private disposed = false;
  private interruptCurrent: Interruptible | null = null;
  private aborted = false;

  /** Observability for tests. */
  sentTexts: string[] = [];

  constructor(opts: FakeRuntimeOptions = {}) {
    this.turns = opts.turns ?? [];
    this.stepDelayMs = opts.stepDelayMs ?? 0;
    this.contextObservation = opts.contextObservation ?? {
      confidence: 'unavailable',
      reason: 'unsupported',
    };
  }

  async observeContext(): Promise<ContextObservation> {
    const observation = typeof this.contextObservation === 'function'
      ? await this.contextObservation()
      : this.contextObservation;
    return observation.confidence === 'unavailable'
      ? { confidence: 'unavailable', reason: observation.reason }
      : {
          confidence: observation.confidence,
          usedTokens: observation.usedTokens,
          usableTokens: observation.usableTokens,
          contextWindowTokens: observation.contextWindowTokens,
        };
  }

  sendTurn(text: string): AsyncIterable<RuntimeEvent> {
    if (this.disposed) throw new Error('FakeRuntime.sendTurn after dispose');
    this.sentTexts.push(text);
    // Reset abort state synchronously at turn start — NOT inside the generator,
    // where the first pull could clobber an interrupt that already arrived.
    this.aborted = false;
    const script: ScriptedTurn = this.turns[this.turnIndex] ?? [
      { type: 'result', ok: true, stopReason: 'complete', usage: null, durationMs: 0, error: null, outcome: 'ok', numTurns: null },
    ];
    this.turnIndex += 1;
    return this.run(script);
  }

  private async *run(script: ScriptedTurn): AsyncGenerator<RuntimeEvent> {
    let sawTerminal = false;
    for (const step of script) {
      if (this.stepDelayMs > 0) await delay(this.stepDelayMs);
      if (isHang(step)) {
        // Honor an interrupt that arrived before we reached the hang (race):
        // only park on the gate if not already aborted.
        if (!this.aborted) {
          const gate = deferred();
          this.interruptCurrent = gate;
          await gate.promise; // released by interrupt()/dispose()
          this.interruptCurrent = null;
        }
        // A hung turn released by interrupt ends with a typed abort result
        // unless the script itself continues to a terminal.
        if (this.aborted) {
          sawTerminal = true;
          yield {
            type: 'result',
            ok: false,
            stopReason: null,
            usage: null,
            durationMs: null,
            error: 'interrupted',
            outcome: 'aborted',
            numTurns: null,
          };
          return;
        }
        continue;
      }
      if (step.type === 'result') sawTerminal = true;
      yield step;
    }
    // Positive receipt: a script that forgot a terminal still terminates so the
    // turn-runner's "exactly one terminal" guard can assert on real output.
    if (!sawTerminal) {
      yield {
        type: 'result',
        ok: true,
        stopReason: 'complete',
        usage: null,
        durationMs: 0,
        error: null,
        outcome: 'ok',
        numTurns: null,
      };
    }
  }

  async interrupt(): Promise<void> {
    this.aborted = true;
    this.interruptCurrent?.resolve();
  }

  async dispose(): Promise<void> {
    this.disposed = true;
    this.aborted = true;
    this.interruptCurrent?.resolve();
  }
}

function delay(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}
