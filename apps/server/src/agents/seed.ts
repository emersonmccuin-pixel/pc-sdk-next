// Stock agent seeding — boot-time insert + drift rules.
//
// Two modes (gate-week D3):
//   - 'authoritative' (the 6 specialists): insert if missing; on later boots any
//     seed-owned field that drifted from the canonical constant is reseeded.
//     Stock specialists are read-only in the UI, so drift only appears when the
//     constants ship new text — the reseed is the update channel.
//   - 'insert-only' (the orchestrator): insert if missing, never patch — user
//     edits to the chat's system prompt survive every boot. Reset-to-default
//     is the explicit restore path.

import {
  createAgent,
  getAgentByName,
  updateAgent,
  type CreateAgentInput,
  type UpdateAgentInput,
} from '@pc/db';
import type { PodAgentRow } from '@pc/domain';
import { ALL_SEED_CONTENT, ORCHESTRATOR_AGENT_CONTENT, STOCK_AGENT_CONTENT } from './stock-agent-content.ts';

const SEED_AUDIT = { actor: 'orchestrator' as const, reason: 'stock-agent-seed' };

/** The fields the seed owns. Everything else (attached docs, secrets, MCP
 *  attachments, membership) is user data and never touched by seeding. */
export const SEED_OWNED_FIELDS = [
  'prompt',
  'tools',
  'model',
  'effort',
  'maxTurns',
  'description',
  'dispatchGuidance',
] as const;
export type SeedOwnedField = (typeof SEED_OWNED_FIELDS)[number];

export type SeedAgentAction = 'inserted' | 'reseeded' | 'unchanged';
export type SeedMode = 'authoritative' | 'insert-only';

/** Canonical seed content for a stock row, or null for non-seeded names. */
export function getCanonicalSeed(name: string): CreateAgentInput | null {
  return ALL_SEED_CONTENT.find((c) => c.name === name) ?? null;
}

/** Seed-owned fields whose live value differs from the canonical constant. */
export function collectDriftedFields(live: PodAgentRow, content: CreateAgentInput): SeedOwnedField[] {
  const drifted: SeedOwnedField[] = [];
  for (const field of SEED_OWNED_FIELDS) {
    const liveValue = normalize(live[field], field);
    const seedValue = normalize(content[field], field);
    if (JSON.stringify(liveValue) !== JSON.stringify(seedValue)) drifted.push(field);
  }
  return drifted;
}

/** Null-vs-default normalization so absent seed fields compare equal to the
 *  DB defaults createAgent fills in. */
function normalize(value: unknown, field: SeedOwnedField): unknown {
  if (field === 'prompt' || field === 'description') return value ?? '';
  if (field === 'tools') return value ?? [];
  return value ?? null;
}

export function seedAgent(content: CreateAgentInput, mode: SeedMode): SeedAgentAction {
  const live = getAgentByName({ name: content.name, scope: 'global' });
  if (!live) {
    createAgent(content, SEED_AUDIT);
    return 'inserted';
  }
  if (mode === 'insert-only') return 'unchanged';
  const drifted = collectDriftedFields(live, content);
  if (drifted.length === 0) return 'unchanged';
  updateAgent(live.id, buildSeedPatch(content, drifted), SEED_AUDIT);
  return 'reseeded';
}

/** Restore a stock row's seed-owned fields to the canonical constant. Returns
 *  the fields that changed, or null when the name isn't a seeded agent. */
export function resetAgentToSeed(live: PodAgentRow): SeedOwnedField[] | null {
  const content = getCanonicalSeed(live.name);
  if (!content || live.origin !== 'stock') return null;
  const drifted = collectDriftedFields(live, content);
  if (drifted.length === 0) return [];
  updateAgent(live.id, buildSeedPatch(content, drifted), { actor: 'user', reason: 'reset-to-default' });
  return drifted;
}

function buildSeedPatch(content: CreateAgentInput, fields: SeedOwnedField[]): UpdateAgentInput {
  const patch: UpdateAgentInput = {};
  for (const field of fields) {
    // Same null-vs-default normalization as drift detection.
    (patch as Record<string, unknown>)[field] = normalize(content[field], field);
  }
  return patch;
}

export interface SeedSummary {
  inserted: number;
  reseeded: number;
  unchanged: number;
}

/** Boot entry: 6 specialists authoritative, orchestrator insert-only. */
export function seedStockAgents(): SeedSummary {
  const summary: SeedSummary = { inserted: 0, reseeded: 0, unchanged: 0 };
  const bump = (action: SeedAgentAction): void => {
    summary[action === 'inserted' ? 'inserted' : action === 'reseeded' ? 'reseeded' : 'unchanged']++;
  };
  bump(seedAgent(ORCHESTRATOR_AGENT_CONTENT, 'insert-only'));
  for (const content of STOCK_AGENT_CONTENT) bump(seedAgent(content, 'authoritative'));
  return summary;
}
