// Tools are stored VERBATIM (gate-week D4): the old app force-merged the
// pc-rig contract-loop kit into every agent's tools; that surface doesn't
// exist in PC-SDK — Phase 3 re-wires required tools at the dispatch door.
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const tmpDir = mkdtempSync(join(tmpdir(), 'pc-pods-tools-'));
process.env.PC_DATA_DIR = tmpDir;

const db = await import('../src/index.ts');

before(() => db.runMigrations());
after(() => {
  db.closeDb();
  rmSync(tmpDir, { recursive: true, force: true });
});

const audit = { actor: 'user' as const };

test('createAgent stores the tools list verbatim — no forced pc-rig merge', () => {
  const created = db.createAgent(
    { name: 'verbatim-tools', scope: 'global', tools: ['Read', 'Grep'] },
    audit,
  );
  assert.deepEqual(created.tools, ['Read', 'Grep']);
  assert.ok(
    !created.tools.some((t) => t.startsWith('mcp__pc-rig__')),
    'pc-rig tools injected on create',
  );
});

test('updateAgent stores the tools patch verbatim (removals stick)', () => {
  const created = db.createAgent(
    { name: 'verbatim-tools-update', scope: 'global', tools: ['Read', 'Grep', 'Bash'] },
    audit,
  );
  const updated = db.updateAgent(created.id, { tools: ['Read'] }, audit);
  assert.deepEqual(updated!.tools, ['Read']);
});
