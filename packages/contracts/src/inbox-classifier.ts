// Inbox ownership classifier (pc-pty-chat-276.1 → pc-pty-chat-267 → pc-pty-chat-316).
// Provides `owner` (who acts on this item) and `actionable` (requires a decision).
//
// VISIBILITY IS NOT DERIVED HERE. The address is the single visibility door:
// `user-inbox` recipients are already filtered server-side on every inbox route.
// The client renders exactly what the server returns — no second derivation.
//
// Pure function; zero side-effects; zero I/O.

import type { MailboxMessageKind } from './mailbox.ts';

/** Reviewer flavor for a human-review gate. Inlined here — the workflow engine
 *  (which used to own this type) is deleted. */
export type WorkflowReviewFlavor = 'human' | 'orchestrator';

// ---- Classification result --------------------------------------------------

export interface InboxClassification {
  /** Who is responsible for acting on this item. */
  owner: 'human' | 'orchestrator';
  /** Whether the item requires an explicit decision (approve / reject / answer). */
  actionable: boolean;
}

// ---- Classifier -------------------------------------------------------------

/**
 * Classify a mailbox item by kind and (for workflow-review) reviewer flavor.
 * Returns `owner` (routing hint) and `actionable` (decision required).
 *
 * Visibility is NOT determined here — the server already filters by address
 * (user-inbox vs. orchestrator-addressed). Callers must NOT use this to gate
 * what shows in the human inbox.
 *
 * Rules:
 * - orchestrator-reviewer workflow-review gate -> orchestrator-owned, not actionable
 * - human-reviewer workflow-review gate -> human-owned, actionable
 * - agent-ask-escalated -> human-owned, actionable
 * - raw agent-question -> orchestrator-owned, not actionable
 * - orchestrator-addressed kinds (agent-approval, agent-stalled, ...) -> orchestrator-owned
 * - info-only kinds (system-notice, external-webhook) -> not actionable
 */
export function classifyInboxItem(
  kind: MailboxMessageKind,
  flavor?: WorkflowReviewFlavor | null,
): InboxClassification {
  switch (kind) {
    case 'workflow-review':
      if (flavor === 'orchestrator') {
        return { owner: 'orchestrator', actionable: false };
      }
      // flavor === 'human' or unspecified -> default to human ownership
      return { owner: 'human', actionable: true };

    case 'agent-ask-escalated':
      return { owner: 'human', actionable: true };

    // ---- Orchestrator-only kinds --------------------------------------------

    case 'agent-question':
      // Raw agent->orchestrator ask; never human-inbox material.
      return { owner: 'orchestrator', actionable: false };

    case 'agent-approval':
      return { owner: 'orchestrator', actionable: false };

    case 'agent-terminal':
      return { owner: 'orchestrator', actionable: false };

    case 'agent-stalled':
      return { owner: 'orchestrator', actionable: false };

    case 'external-webhook':
      return { owner: 'orchestrator', actionable: false };

    case 'system-notice':
      // Info-only; never requires a decision.
      return { owner: 'orchestrator', actionable: false };
  }
}
