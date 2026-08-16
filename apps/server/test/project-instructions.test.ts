import { createHash } from 'node:crypto';
import { afterEach, test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  ProjectInstructionError,
  composeProjectInstructions,
  loadProjectInstructionSnapshot,
} from '../src/agents/project-instructions.ts';
import { PROJECT_INSTRUCTION_MAX_BYTES } from '@pc/domain';

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function root(): string {
  const path = realpathSync.native(mkdtempSync(join(tmpdir(), 'pc-project-instructions-')));
  roots.push(path);
  return path;
}

test('loads and hashes the one root AGENTS.md as UTF-8', () => {
  const cwd = root();
  const content = '# Shared rules\n\n- Run the focused tests.\n';
  writeFileSync(join(cwd, 'AGENTS.md'), content, 'utf8');

  const snapshot = loadProjectInstructionSnapshot(cwd);
  assert.deepEqual(snapshot, {
    state: 'loaded',
    source: 'AGENTS.md',
    content,
    revision: `sha256:${createHash('sha256').update(content, 'utf8').digest('hex')}`,
  });
});

test('a missing AGENTS.md produces an explicit empty snapshot', () => {
  const snapshot = loadProjectInstructionSnapshot(root());
  assert.equal(snapshot.state, 'missing');
  assert.equal(snapshot.content, '');
  assert.equal(
    snapshot.revision,
    `sha256:${createHash('sha256').update('', 'utf8').digest('hex')}`,
  );
});

test('project instructions precede the runtime charter and are included once', () => {
  const cwd = root();
  writeFileSync(join(cwd, 'AGENTS.md'), 'ONE CANONICAL RULE', 'utf8');
  const composed = composeProjectInstructions(
    'Provider-neutral specialist charter',
    loadProjectInstructionSnapshot(cwd),
  );
  assert.ok(composed);
  assert.ok(composed.indexOf('ONE CANONICAL RULE') < composed.indexOf('Provider-neutral specialist charter'));
  assert.equal(composed.match(/ONE CANONICAL RULE/g)?.length, 1);
  assert.match(composed, /## PC-SDK runtime charter/);
});

test('oversized and malformed instruction sources fail closed', () => {
  const oversized = root();
  writeFileSync(
    join(oversized, 'AGENTS.md'),
    Buffer.alloc(PROJECT_INSTRUCTION_MAX_BYTES + 1, 0x61),
  );
  assert.throws(
    () => loadProjectInstructionSnapshot(oversized),
    (error: unknown) => error instanceof ProjectInstructionError &&
      error.code === 'project-instruction-source-too-large',
  );

  const malformed = root();
  writeFileSync(join(malformed, 'AGENTS.md'), Buffer.from([0xc3, 0x28]));
  assert.throws(
    () => loadProjectInstructionSnapshot(malformed),
    (error: unknown) => error instanceof ProjectInstructionError &&
      error.code === 'project-instruction-source-not-utf8',
  );
});

