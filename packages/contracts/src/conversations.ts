// Conversation contract family (slice 006). Browser-safe, zero runtime deps.
//
// Owns `ConversationKind` (the read-surface discriminator across orchestrator
// sessions, agent runs, and subagent transcripts) and the expanded session read
// DTO. Runtime selection uses the same canonical contract as live session
// frames; provider labels/native ids never form a parallel browser wire.

import { type ULID } from './shared.ts';
import {
  isSessionContinuationState,
  isSessionResumeAvailability,
  isSessionSummary,
  type SessionContinuationState,
  type SessionResumeAvailability,
} from './events/session.ts';
import { isRuntimeSelection, type RuntimeSelection } from './runtime.ts';

export const CONVERSATION_KINDS = [
  'orchestrator-session',
  'agent-run',
  'subagent-transcript',
] as const;
export type ConversationKind = (typeof CONVERSATION_KINDS)[number];

export const CONVERSATION_SESSION_STATUSES = ['active', 'ended'] as const;
export type ConversationSessionStatus = (typeof CONVERSATION_SESSION_STATUSES)[number];

export const CONVERSATION_SESSION_ENDED_REASONS = [
  'user_ended',
  'provider_error',
  'provider_session_lost',
  'account_switched',
  'runtime_switched',
  'selection_unavailable',
  'pty_exit',
  'archived',
] as const;
export type ConversationSessionEndedReason =
  (typeof CONVERSATION_SESSION_ENDED_REASONS)[number];

/** Expanded browser-safe session row. Native identity is represented only by
 *  presence; credentials and adapter-native ids remain server-side. */
export interface ConversationSessionDto {
  id: ULID;
  projectId: ULID;
  selection: RuntimeSelection | null;
  title: string | null;
  status: ConversationSessionStatus;
  endedReason: ConversationSessionEndedReason | null;
  startedAt: number;
  endedAt: number | null;
  nativeSessionIdPresent: boolean;
  continuationState: SessionContinuationState;
  resumeAvailability: SessionResumeAvailability;
}

// ── Guards ───────────────────────────────────────────────────────────────────

export function isConversationKind(value: unknown): value is ConversationKind {
  return typeof value === 'string' && (CONVERSATION_KINDS as readonly string[]).includes(value);
}

export function isConversationSessionStatus(
  value: unknown,
): value is ConversationSessionStatus {
  return (
    typeof value === 'string' &&
    (CONVERSATION_SESSION_STATUSES as readonly string[]).includes(value)
  );
}

export function isConversationSessionEndedReason(
  value: unknown,
): value is ConversationSessionEndedReason {
  return (
    typeof value === 'string' &&
    (CONVERSATION_SESSION_ENDED_REASONS as readonly string[]).includes(value)
  );
}

export function isConversationSessionDto(value: unknown): value is ConversationSessionDto {
  if (!isRecord(value)) return false;
  return (
    hasOnlyKeys(value, [
      'id', 'projectId', 'selection', 'title', 'status', 'endedReason',
      'startedAt', 'endedAt', 'nativeSessionIdPresent', 'continuationState',
      'resumeAvailability',
    ]) &&
    typeof value.id === 'string' &&
    typeof value.projectId === 'string' &&
    (value.selection === null || isRuntimeSelection(value.selection)) &&
    (value.title === null || typeof value.title === 'string') &&
    isConversationSessionStatus(value.status) &&
    (value.endedReason === null || isConversationSessionEndedReason(value.endedReason)) &&
    typeof value.startedAt === 'number' &&
    (value.endedAt === null || typeof value.endedAt === 'number') &&
    typeof value.nativeSessionIdPresent === 'boolean' &&
    isSessionContinuationState(value.continuationState) &&
    isSessionResumeAvailability(value.resumeAvailability) &&
    isSessionSummary({
      id: value.id,
      projectId: value.projectId,
      selection: value.selection,
      title: value.title,
      status: value.status,
      nativeSessionIdPresent: value.nativeSessionIdPresent,
      continuationState: value.continuationState,
      resumeAvailability: value.resumeAvailability,
      startedAt: value.startedAt,
    })
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function hasOnlyKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  const allowed = new Set(keys);
  return Object.keys(value).every((key) => allowed.has(key));
}
