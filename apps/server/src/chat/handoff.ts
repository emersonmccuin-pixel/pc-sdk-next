// App-owned cross-account context-handoff compiler (Phase 2). A same-runtime
// account switch never native-resumes: each account is an isolated
// credential home, so the prior session's native thread stays inside its own
// originating home. Instead a fresh native session under the new account is
// seeded with a bounded, provider-neutral rendering of the prior session's
// durable transcript. Provider-neutral text only — no native shapes here;
// the adapter (see runtime.ts CreateRuntimeSession.seedContext) decides how
// to compile this string into its own native leading-context mechanism.

import { replayConversationEvents } from './replay.ts';

/** Hard cap on the compiled seed string, regardless of transcript size. */
export const HANDOFF_SEED_MAX_CHARS = 12_000;
/** Most-recent N conversational turns kept verbatim; anything older is
 * rendered as a one-line, length-capped summary instead. */
export const HANDOFF_RECENT_VERBATIM_TURNS = 6;
/** Per-turn cap applied only to the summarized (older) turns. */
export const HANDOFF_SUMMARY_TURN_MAX_CHARS = 240;

const HANDOFF_TRUNCATION_NOTE =
  '\n\n[Note: this seed was truncated to fit a size cap; some earlier detail may be missing.]';

interface HandoffTurn {
  role: 'user' | 'assistant';
  text: string;
}

function extractTurns(events: ReturnType<typeof replayConversationEvents>): HandoffTurn[] {
  const turns: HandoffTurn[] = [];
  for (const frame of events) {
    const event = frame.event;
    if (event.kind === 'user' && event.text.trim()) {
      turns.push({ role: 'user', text: event.text.trim() });
    } else if (event.kind === 'turn-end' && event.text.trim()) {
      turns.push({ role: 'assistant', text: event.text.trim() });
    }
  }
  return turns;
}

export interface CompileHandoffSeedContextInput {
  /** The prior app session whose durable transcript is compiled. */
  sourceSessionId: string;
  /** Account the conversation is continuing FROM (prior session's account). */
  fromAccountId: string;
  /** Account the conversation is continuing under (new session's account). */
  toAccountId: string;
}

export interface HandoffSeedContext {
  /** Bounded, provider-neutral seed text — see CreateRuntimeSession.seedContext. */
  seedContext: string;
  /** True if any turn or the overall seed was shortened to fit its cap. */
  truncated: boolean;
  /** Total durable turns found on the source session (pre-truncation). */
  turnCount: number;
}

/** Compile `sourceSessionId`'s durable transcript into a bounded seed string
 * for a fresh native session under `toAccountId`. Recent turns render
 * verbatim; older turns are truncated to a one-line summary; the whole
 * result is capped at `HANDOFF_SEED_MAX_CHARS`. Truncation is surfaced inside
 * the seed text itself, not only in app-side UI. Returns null when the
 * source session has no replayable user/assistant turns — callers must treat
 * that as ineligible for handoff and fall back to a clean mint plus a
 * visible notice rather than seed a fresh session with nothing. */
export function compileHandoffSeedContext(
  input: CompileHandoffSeedContextInput,
): HandoffSeedContext | null {
  const turns = extractTurns(replayConversationEvents(input.sourceSessionId));
  if (turns.length === 0) return null;

  const recentCount = Math.min(HANDOFF_RECENT_VERBATIM_TURNS, turns.length);
  const olderTurns = turns.slice(0, turns.length - recentCount);
  const recentTurns = turns.slice(turns.length - recentCount);

  const lines: string[] = [
    `[Continued conversation — account switched ${input.fromAccountId}→${input.toAccountId}. ` +
    'The account change started a fresh native session; this is a compiled ' +
    'summary of the prior conversation, not the original transcript.]',
  ];

  let truncated = false;
  if (olderTurns.length > 0) {
    lines.push('', `Earlier in this conversation (${olderTurns.length} turn(s), summarized):`);
    for (const turn of olderTurns) {
      const text = turn.text.length > HANDOFF_SUMMARY_TURN_MAX_CHARS
        ? `${turn.text.slice(0, HANDOFF_SUMMARY_TURN_MAX_CHARS).trimEnd()}…`
        : turn.text;
      if (text !== turn.text) truncated = true;
      lines.push(`- ${turn.role}: ${text}`);
    }
  }

  if (recentTurns.length > 0) {
    lines.push('', 'Most recent turns (verbatim):');
    for (const turn of recentTurns) lines.push('', `${turn.role}:`, turn.text);
  }

  lines.push('', '[End of prior-conversation seed. Continue naturally from here.]');

  let seedContext = lines.join('\n');
  if (seedContext.length > HANDOFF_SEED_MAX_CHARS) {
    truncated = true;
    seedContext = seedContext.slice(0, HANDOFF_SEED_MAX_CHARS).trimEnd();
  }
  if (truncated) {
    const budget = HANDOFF_SEED_MAX_CHARS - HANDOFF_TRUNCATION_NOTE.length;
    if (seedContext.length > budget) seedContext = seedContext.slice(0, Math.max(0, budget)).trimEnd();
    seedContext = `${seedContext}${HANDOFF_TRUNCATION_NOTE}`;
  }

  return { seedContext, truncated, turnCount: turns.length };
}

/** Cheap eligibility check for the switch-time GATE decision: does the prior
 * session have any replayable durable event at all? Distinct from (and
 * cheaper than) `compileHandoffSeedContext`, which callers only need once
 * they are actually minting the handed-off session's runtime. */
export function hasReplayableTranscript(sessionId: string): boolean {
  return replayConversationEvents(sessionId).length > 0;
}
