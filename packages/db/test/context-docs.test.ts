// context_docs migration + repo. Project- and agent-scoped docs only (the
// area / work-item scopes + FTS search + context-chain walk died with the
// board/work-item model — see docs/event-contract.md).

import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const tmpDir = mkdtempSync(join(tmpdir(), 'pc-ctx-docs-'));
process.env.PC_DATA_DIR = tmpDir;

const {
  assertSchemaIntact,
  closeDb,
  createAgent,
  createContextDoc,
  createProject,
  getAgentContextDocByTitle,
  getContextDoc,
  getRawDb,
  listAgentAudit,
  listContextDocsForScope,
  runMigrations,
  softDeleteContextDoc,
  updateContextDoc,
} = await import('../src/index.ts');

before(() => runMigrations());
after(() => {
  closeDb();
  rmSync(tmpDir, { recursive: true, force: true });
});

function seedProject(slug: string) {
  return createProject({ slug, name: slug, folderPath: '' });
}

// ── Migration / schema ────────────────────────────────────────────────────────

test('context_docs carries project_id + agent_id scopes (no area/work-item)', () => {
  const raw = getRawDb();
  const cols = (raw.pragma('table_info("context_docs")') as { name: string }[]).map((c) => c.name);
  for (const col of [
    'id', 'project_id', 'agent_id',
    'title', 'body', 'author', 'created_at', 'updated_at', 'deleted_at',
  ]) {
    assert.ok(cols.includes(col), `context_docs.${col} should exist`);
  }
  assert.ok(!cols.includes('area_id'), 'context_docs.area_id is dead');
  assert.ok(!cols.includes('work_item_id'), 'context_docs.work_item_id is dead');
});

test('assertSchemaIntact passes after migrate', () => {
  assert.doesNotThrow(() => assertSchemaIntact());
});

// ── CRUD ──────────────────────────────────────────────────────────────────────

test('createContextDoc enforces exactly-one-scope in app code', () => {
  assert.throws(
    () => createContextDoc({ scope: {} as never, title: 'X' }),
    /scope must have exactly one non-null pointer/,
  );
});

test('createContextDoc and getContextDoc round-trip', () => {
  const p = seedProject('p-crud-ctx');
  const doc = createContextDoc({
    scope: { projectId: p.id },
    title: 'My doc',
    body: 'Hello world',
    author: 'orchestrator',
  });
  assert.equal(doc.projectId, p.id);
  assert.equal(doc.agentId, null);
  assert.equal(doc.title, 'My doc');
  assert.equal(doc.body, 'Hello world');
  assert.equal(doc.author, 'orchestrator');
  assert.equal(doc.deletedAt, null);

  const fetched = getContextDoc(doc.id);
  assert.ok(fetched);
  assert.equal(fetched!.id, doc.id);
});

test('updateContextDoc bumps updatedAt and returns new row', () => {
  const p = seedProject('p-update-ctx');
  const doc = createContextDoc({ scope: { projectId: p.id }, title: 'Before', body: 'old' });
  const updated = updateContextDoc(doc.id, { title: 'After', body: 'new' });
  assert.ok(updated);
  assert.equal(updated!.title, 'After');
  assert.equal(updated!.body, 'new');
  assert.ok(updated!.updatedAt >= doc.updatedAt);
});

test('softDeleteContextDoc excludes doc from getContextDoc', () => {
  const p = seedProject('p-del-ctx');
  const doc = createContextDoc({ scope: { projectId: p.id }, title: 'Gone', body: '' });
  softDeleteContextDoc(doc.id);
  assert.equal(getContextDoc(doc.id), null);
});

// ── listContextDocsForScope ────────────────────────────────────────────────────

test('listContextDocsForScope returns only docs for that scope', () => {
  const p = seedProject('p-list-scope');
  const agent = createAgent({ name: 'pod-list-scope', scope: 'global' }, { actor: 'user' });
  const docP = createContextDoc({ scope: { projectId: p.id }, title: 'Proj doc', body: '' });
  const docA = createContextDoc({ scope: { agentId: agent.id }, title: 'Agent doc', body: '' });

  const projDocs = listContextDocsForScope({ scope: { projectId: p.id } });
  assert.ok(projDocs.some((d) => d.id === docP.id));
  assert.ok(!projDocs.some((d) => d.id === docA.id));

  const agentDocs = listContextDocsForScope({ scope: { agentId: agent.id } });
  assert.ok(agentDocs.some((d) => d.id === docA.id));
  assert.ok(!agentDocs.some((d) => d.id === docP.id));
});

// ── Agent scope (merged agent_knowledge) ──────────────────────────────────────

test('agent-scoped CRUD round-trips and lists by agent', () => {
  const agent = createAgent({ name: 'pod-ctx-crud', scope: 'global' }, { actor: 'user' });
  const doc = createContextDoc({
    scope: { agentId: agent.id },
    title: 'Voice rules',
    body: 'Always terse.',
  });
  assert.equal(doc.agentId, agent.id);
  assert.equal(doc.projectId, null);

  const listed = listContextDocsForScope({ scope: { agentId: agent.id } });
  assert.ok(listed.some((d) => d.id === doc.id));

  const fetched = getContextDoc(doc.id);
  assert.equal(fetched!.agentId, agent.id);
});

test('agent-scoped mutations emit context-doc audit rows', () => {
  const agent = createAgent({ name: 'pod-ctx-audit', scope: 'global' }, { actor: 'user' });
  const doc = createContextDoc(
    { scope: { agentId: agent.id }, title: 'Audited', body: 'v1' },
    { actor: 'orchestrator', reason: 'seed' },
  );
  updateContextDoc(doc.id, { body: 'v2' }, { actor: 'user', reason: 'edit' });
  softDeleteContextDoc(doc.id, { actor: 'user', reason: 'prune' });

  const audit = listAgentAudit({ agentId: agent.id, field: 'context-doc' });
  const forDoc = audit.filter((a) => a.fieldRef === doc.id);
  assert.equal(forDoc.length, 3, 'create + update + delete should each audit');
  // Newest-first: delete carries prior only; create carries new only.
  assert.equal(forDoc[0]!.newValue, null);
  assert.match(forDoc[1]!.newValue ?? '', /v2/);
  assert.match(forDoc[2]!.newValue ?? '', /v1/);
  assert.equal(forDoc[2]!.priorValue, null);
});

test('non-agent scopes emit no agent audit', () => {
  const p = seedProject('p-no-audit');
  const agent = createAgent({ name: 'pod-ctx-noaudit', scope: 'global' }, { actor: 'user' });
  const before = listAgentAudit({ agentId: agent.id, field: 'context-doc' }).length;
  createContextDoc({ scope: { projectId: p.id }, title: 'Project doc', body: '' });
  const after = listAgentAudit({ agentId: agent.id, field: 'context-doc' }).length;
  assert.equal(after, before);
});

test('getAgentContextDocByTitle finds live docs only', () => {
  const agent = createAgent({ name: 'pod-ctx-title', scope: 'global' }, { actor: 'user' });
  const doc = createContextDoc({ scope: { agentId: agent.id }, title: 'Seeded doc', body: 'x' });
  assert.equal(getAgentContextDocByTitle({ agentId: agent.id, title: 'Seeded doc' })?.id, doc.id);
  assert.equal(getAgentContextDocByTitle({ agentId: agent.id, title: 'Missing' }), null);

  softDeleteContextDoc(doc.id);
  assert.equal(getAgentContextDocByTitle({ agentId: agent.id, title: 'Seeded doc' }), null);
});
