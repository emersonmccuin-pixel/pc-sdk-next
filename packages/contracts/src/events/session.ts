// Session lifecycle frames (Channel 1). See docs/event-contract.md §Session lifecycle.
// Browser-safe, zero runtime deps.

import type { RuntimeSelection, RuntimeSelectionErrorCode } from '../runtime.ts';
import { isRuntimeSelection, isRuntimeSelectionErrorCode } from '../runtime.ts';
import type { ULID } from '../shared.ts';
import { isConversationEventFrame, type ConversationEventFrame } from './chat.ts';

/** The session summary the header + rail read. App sessions are server-owned;
 * native identity and attempt correlation stay behind this browser seam. */
export interface SessionSummary {
  id: string;
  projectId: ULID;
  /** Null only for conservatively migrated legacy rows. */
  selection: RuntimeSelection | null;
  title: string | null;
  status: 'active' | 'ended';
  /** Presence only. Adapter-native identity never crosses the browser seam. */
  nativeSessionIdPresent: boolean;
  continuationState: SessionContinuationState;
  resumeAvailability: SessionResumeAvailability;
  startedAt: number;
}

export const SESSION_CONTINUATION_STATES = [
  'clean-pending',
  'clean-started',
  'resume-pending',
  'native-resumed',
  'resume-failed',
  'legacy-unavailable',
] as const;
export type SessionContinuationState = (typeof SESSION_CONTINUATION_STATES)[number];

export type SessionResumeAvailability =
  | { status: 'available' }
  | { status: 'unavailable'; code: RuntimeSelectionErrorCode };

export interface SessionChangedFrame {
  type: 'session-changed';
  projectId: ULID;
  transition: 'new-session' | 'resume-session';
  session: SessionSummary | null;
}

/** Non-boundary metadata convergence. Unlike `session-changed`, consumers
 * must not reset or replay the chat timeline when this frame arrives. */
export interface SessionUpdatedFrame {
  type: 'session-updated';
  projectId: ULID;
  session: SessionSummary;
}

/** Full checkpoint of the active session — same frame shape as live. `new-session`
 *  wipes the client timeline + aggregates; replay re-seeds wholesale and
 *  recomputes aggregates from the set. */
export interface SessionReplayFrame {
  type: 'session-replay';
  projectId: ULID;
  sessionId: string;
  highWaterSequence: number;
  events: ConversationEventFrame[];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function hasOnlyKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  const allowed = new Set(keys);
  return Object.keys(value).every((key) => allowed.has(key));
}

export function isSessionSummary(value: unknown): value is SessionSummary {
  if (
    !isRecord(value) ||
    !hasOnlyKeys(value, [
      'id',
      'projectId',
      'selection',
      'title',
      'status',
      'nativeSessionIdPresent',
      'continuationState',
      'resumeAvailability',
      'startedAt',
    ]) ||
    typeof value.id !== 'string' || value.id.length === 0 ||
    typeof value.projectId !== 'string' || value.projectId.length === 0 ||
    !(value.selection === null || isRuntimeSelection(value.selection)) ||
    !(value.title === null || typeof value.title === 'string') ||
    !(value.status === 'active' || value.status === 'ended') ||
    typeof value.nativeSessionIdPresent !== 'boolean' ||
    !isSessionContinuationState(value.continuationState) ||
    !isSessionResumeAvailability(value.resumeAvailability) ||
    typeof value.startedAt !== 'number' || !Number.isFinite(value.startedAt)
  ) return false;
  if (value.selection === null) {
    return value.status === 'ended' &&
      value.continuationState === 'legacy-unavailable' &&
      value.resumeAvailability.status === 'unavailable' &&
      value.resumeAvailability.code === 'selection-unavailable';
  }
  if (value.continuationState === 'legacy-unavailable') return false;
  if (value.status === 'active') {
    return value.resumeAvailability.status === 'unavailable' &&
      value.resumeAvailability.code === 'session-active';
  }
  if (value.resumeAvailability.status === 'available') {
    return value.nativeSessionIdPresent && value.continuationState !== 'resume-failed';
  }
  return true;
}

export function isSessionContinuationState(value: unknown): value is SessionContinuationState {
  return typeof value === 'string' &&
    (SESSION_CONTINUATION_STATES as readonly string[]).includes(value);
}

export function isSessionResumeAvailability(value: unknown): value is SessionResumeAvailability {
  if (!isRecord(value)) return false;
  if (value.status === 'available') return hasOnlyKeys(value, ['status']);
  return value.status === 'unavailable' &&
    hasOnlyKeys(value, ['status', 'code']) &&
    isRuntimeSelectionErrorCode(value.code);
}

export function isSessionChangedFrame(value: unknown): value is SessionChangedFrame {
  return (
    isRecord(value) &&
    hasOnlyKeys(value, ['type', 'projectId', 'transition', 'session']) &&
    value.type === 'session-changed' &&
    typeof value.projectId === 'string' && value.projectId.length > 0 &&
    (value.transition === 'new-session' || value.transition === 'resume-session') &&
    (
      value.session === null ||
      (isSessionSummary(value.session) && value.session.projectId === value.projectId)
    )
  );
}

export function isSessionUpdatedFrame(value: unknown): value is SessionUpdatedFrame {
  return (
    isRecord(value) &&
    hasOnlyKeys(value, ['type', 'projectId', 'session']) &&
    value.type === 'session-updated' &&
    typeof value.projectId === 'string' && value.projectId.length > 0 &&
    isSessionSummary(value.session) &&
    value.session.projectId === value.projectId
  );
}

export function isSessionReplayFrame(value: unknown): value is SessionReplayFrame {
  if (
    !isRecord(value) ||
    !hasOnlyKeys(value, ['type', 'projectId', 'sessionId', 'highWaterSequence', 'events']) ||
    value.type !== 'session-replay' ||
    typeof value.projectId !== 'string' || value.projectId.length === 0 ||
    typeof value.sessionId !== 'string' || value.sessionId.length === 0 ||
    !Number.isSafeInteger(value.highWaterSequence) ||
    (value.highWaterSequence as number) < 0 ||
    !Array.isArray(value.events)
  ) return false;
  return value.events.every((event) => {
    if (!isConversationEventFrame(event)) return false;
    return (
      event.projectId === value.projectId &&
      event.sessionId === value.sessionId &&
      event.sequence <= (value.highWaterSequence as number)
    );
  });
}
