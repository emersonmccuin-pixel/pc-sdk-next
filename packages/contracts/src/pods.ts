// Pod (agent-definition) change contract. Pods are the Agents-tab roster:
// DB-owned facts in the `agents` table. A pod mutation
// (create/update/delete/clone/promote/reset, plus nested knowledge/secret/mcp
// edits) emits a signal-only change on the new `resource` frame under the
// `specialist` entity (`{ specialistId }`, see events/resources.ts); the roster
// refetches the list rather than applying a snapshot inline.
//
// Internal naming keeps 'pod' (the WIRE entity is 'specialist' per the event
// contract; the specialist rename is Phase 3). This module owns the mutation
// kind + the minimal change payload the server builds before mapping to the
// wire signal.

import { type ULID } from './shared.ts';

export type PodChangedKind = 'created' | 'updated' | 'deleted';

export const POD_CHANGED_KINDS: readonly PodChangedKind[] = ['created', 'updated', 'deleted'];

export interface PodChangedLivePayload {
  change: PodChangedKind;
  podId: ULID;
  /** Best-effort name for logging/UX; the roster refetches for the truth. */
  name?: string;
}

export function isPodChangedKind(value: unknown): value is PodChangedKind {
  return typeof value === 'string' && (POD_CHANGED_KINDS as readonly string[]).includes(value);
}

export function isPodChangedLivePayload(value: unknown): value is PodChangedLivePayload {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const v = value as Record<string, unknown>;
  if (!isPodChangedKind(v.change)) return false;
  if (typeof v.podId !== 'string' || !v.podId) return false;
  if (v.name !== undefined && typeof v.name !== 'string') return false;
  return true;
}
