import { createHash } from 'node:crypto';
import {
  closeSync,
  fstatSync,
  lstatSync,
  openSync,
  readFileSync,
  realpathSync,
} from 'node:fs';
import { isAbsolute, join, normalize } from 'node:path';

import {
  PROJECT_INSTRUCTION_MAX_BYTES,
  PROJECT_INSTRUCTION_SOURCE,
  isProjectInstructionSnapshot,
  type ProjectInstructionSnapshot,
} from '@pc/domain';

export type ProjectInstructionErrorCode =
  | 'project-instruction-cwd-invalid'
  | 'project-instruction-cwd-not-canonical'
  | 'project-instruction-source-unavailable'
  | 'project-instruction-source-not-file'
  | 'project-instruction-source-not-canonical'
  | 'project-instruction-source-too-large'
  | 'project-instruction-source-not-utf8'
  | 'project-instruction-source-changed';

export class ProjectInstructionError extends Error {
  readonly name = 'ProjectInstructionError';

  constructor(readonly code: ProjectInstructionErrorCode) {
    super(`Project instructions unavailable: ${code}`);
  }
}

export function loadProjectInstructionSnapshot(cwd: string): ProjectInstructionSnapshot {
  const root = requireCanonicalRoot(cwd);
  const sourcePath = join(root, PROJECT_INSTRUCTION_SOURCE);
  let source;
  try {
    source = lstatSync(sourcePath);
  } catch (error) {
    if (isMissing(error)) return snapshot('missing', '');
    throw new ProjectInstructionError('project-instruction-source-unavailable');
  }
  if (!source.isFile() || source.isSymbolicLink()) {
    throw new ProjectInstructionError('project-instruction-source-not-file');
  }
  let canonicalSource: string;
  try {
    canonicalSource = realpathSync.native(sourcePath);
  } catch {
    throw new ProjectInstructionError('project-instruction-source-unavailable');
  }
  if (canonicalSource !== sourcePath) {
    throw new ProjectInstructionError('project-instruction-source-not-canonical');
  }
  if (source.size > PROJECT_INSTRUCTION_MAX_BYTES) {
    throw new ProjectInstructionError('project-instruction-source-too-large');
  }

  let descriptor: number | null = null;
  try {
    descriptor = openSync(sourcePath, 'r');
    const before = fstatSync(descriptor);
    if (!before.isFile() || before.size > PROJECT_INSTRUCTION_MAX_BYTES) {
      throw new ProjectInstructionError(
        before.isFile()
          ? 'project-instruction-source-too-large'
          : 'project-instruction-source-not-file',
      );
    }
    if (
      // Node reports lstat().dev as zero for ordinary Windows paths while
      // fstat().dev carries the volume id; compare it only when both sides
      // provide a meaningful value. The file id (ino) remains stable there.
      (source.dev !== 0 && before.dev !== 0 && source.dev !== before.dev) ||
      source.ino !== before.ino ||
      source.size !== before.size ||
      source.mtimeMs !== before.mtimeMs
    ) {
      throw new ProjectInstructionError('project-instruction-source-changed');
    }
    const bytes = readFileSync(descriptor);
    const after = fstatSync(descriptor);
    if (
      before.dev !== after.dev ||
      before.ino !== after.ino ||
      before.size !== after.size ||
      before.mtimeMs !== after.mtimeMs ||
      bytes.byteLength !== after.size
    ) {
      throw new ProjectInstructionError('project-instruction-source-changed');
    }
    let content: string;
    try {
      content = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
    } catch {
      throw new ProjectInstructionError('project-instruction-source-not-utf8');
    }
    if (content.includes('\u0000')) {
      throw new ProjectInstructionError('project-instruction-source-not-utf8');
    }
    return content.length === 0 ? snapshot('missing', '') : snapshot('loaded', content);
  } catch (error) {
    if (error instanceof ProjectInstructionError) throw error;
    throw new ProjectInstructionError('project-instruction-source-unavailable');
  } finally {
    if (descriptor !== null) closeSync(descriptor);
  }
}

export function composeProjectInstructions(
  baseInstructions: string | null | undefined,
  projectInstructions: ProjectInstructionSnapshot,
): string | undefined {
  if (!isProjectInstructionSnapshot(projectInstructions)) {
    throw new ProjectInstructionError('project-instruction-source-unavailable');
  }
  const base = baseInstructions?.trim();
  if (projectInstructions.state === 'missing') return base || undefined;
  const projectBlock = [
    `## Project instructions (${PROJECT_INSTRUCTION_SOURCE})`,
    '',
    projectInstructions.content,
  ].join('\n');
  return base
    ? `${projectBlock}\n\n## PC-SDK runtime charter\n\n${base}`
    : projectBlock;
}

function requireCanonicalRoot(cwd: string): string {
  if (
    typeof cwd !== 'string' ||
    cwd.length === 0 ||
    cwd.trim() !== cwd ||
    cwd.includes('\u0000') ||
    !isAbsolute(cwd) ||
    normalize(cwd) !== cwd
  ) throw new ProjectInstructionError('project-instruction-cwd-invalid');
  let canonical: string;
  try {
    canonical = realpathSync.native(cwd);
  } catch {
    throw new ProjectInstructionError('project-instruction-cwd-invalid');
  }
  if (canonical !== cwd) {
    throw new ProjectInstructionError('project-instruction-cwd-not-canonical');
  }
  return canonical;
}

function snapshot(
  state: ProjectInstructionSnapshot['state'],
  content: string,
): ProjectInstructionSnapshot {
  const revision = `sha256:${createHash('sha256').update(content, 'utf8').digest('hex')}`;
  return state === 'loaded'
    ? { state, source: PROJECT_INSTRUCTION_SOURCE, content, revision }
    : { state, source: PROJECT_INSTRUCTION_SOURCE, content: '', revision };
}

function isMissing(error: unknown): boolean {
  return error instanceof Error && 'code' in error && error.code === 'ENOENT';
}
