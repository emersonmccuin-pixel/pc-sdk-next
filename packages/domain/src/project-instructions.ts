export const PROJECT_INSTRUCTION_SOURCE = 'AGENTS.md' as const;
export const PROJECT_INSTRUCTION_MAX_BYTES = 32 * 1024;

export type ProjectInstructionSnapshot =
  | {
      state: 'missing';
      source: typeof PROJECT_INSTRUCTION_SOURCE;
      content: '';
      revision: string;
    }
  | {
      state: 'loaded';
      source: typeof PROJECT_INSTRUCTION_SOURCE;
      content: string;
      revision: string;
    };

function isSha256Revision(value: unknown): value is string {
  return typeof value === 'string' && /^sha256:[0-9a-f]{64}$/.test(value);
}

export function isProjectInstructionSnapshot(
  value: unknown,
): value is ProjectInstructionSnapshot {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  if (
    Object.keys(record).length !== 4 ||
    !Object.hasOwn(record, 'state') ||
    !Object.hasOwn(record, 'source') ||
    !Object.hasOwn(record, 'content') ||
    !Object.hasOwn(record, 'revision') ||
    record.source !== PROJECT_INSTRUCTION_SOURCE ||
    typeof record.content !== 'string' ||
    new TextEncoder().encode(record.content).byteLength > PROJECT_INSTRUCTION_MAX_BYTES ||
    !isSha256Revision(record.revision)
  ) return false;
  if (record.state === 'missing') return record.content === '';
  return record.state === 'loaded' && record.content.length > 0;
}

