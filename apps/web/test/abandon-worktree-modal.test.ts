import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

import type {
  ApproveWorktreeAbandonmentResponse,
  WorktreeAbandonmentPreviewDto,
} from '@pc/contracts';
import {
  AbandonmentPreviewDetails,
  AbandonmentSettlementNotice,
  abandonmentConfirmationMatches,
} from '../src/components/AbandonWorktreeModal.tsx';
import { parseWorktreeAbandonmentPreviewResponse } from '../src/features/contracts/client.ts';

const SHA = 'a'.repeat(40);
const DIGEST = `sha256:${'b'.repeat(64)}`;

function preview(
  overrides: Partial<WorktreeAbandonmentPreviewDto> = {},
): WorktreeAbandonmentPreviewDto {
  return {
    protocol: 'worktree-abandonment-preview-v1',
    projectId: '01J00000000000000000000001',
    contractId: '01J00000000000000000000002',
    contractVersion: 7,
    producerRunId: '01J00000000000000000000003',
    worktreeId: '01J00000000000000000000004',
    worktreeStatus: 'stranded',
    worktreePath: 'C:\\repo-worktrees\\feature-safe',
    branch: 'feature-safe',
    branchTip: SHA,
    baseBranch: 'main',
    validatedBaseSha: 'c'.repeat(40),
    targetTip: 'd'.repeat(40),
    integrationState: 'unmerged',
    repositoryIdentity: {
      protocol: 'git-common-dir-v1',
      gitCommonDir: 'C:\\repo\\.git',
      leaseKey: `sha256:${'e'.repeat(64)}`,
    },
    worktreeState: {
      directory: 'present',
      registration: 'registered',
      status: 'dirty',
      staged: 1,
      unstaged: 2,
      untracked: 3,
      worktreeStateDigest: DIGEST,
      changedPaths: ['src/a.ts', 'ignored-preview-is-bounded.txt'],
      ignoredContents: 'uninspected',
    },
    previewDigest: `sha256:${'f'.repeat(64)}`,
    ...overrides,
  };
}

test('preview response parser accepts exact canonical evidence and rejects extra fields', () => {
  const value = preview();
  assert.deepEqual(parseWorktreeAbandonmentPreviewResponse({ ok: true, preview: value }), value);
  assert.throws(
    () => parseWorktreeAbandonmentPreviewResponse({ ok: true, preview: value, actor: 'orchestrator' }),
    /invalid worktree abandonment preview response/,
  );
});

test('abandonment preview makes loss, ignored contents, branch retention, and integration explicit', () => {
  const html = renderToStaticMarkup(createElement(AbandonmentPreviewDetails, { preview: preview() }));
  assert.match(html, /does not merge the branch/i);
  assert.match(html, /feature-safe/);
  assert.match(html, /commits not integrated/i);
  assert.match(html, /1 staged/);
  assert.match(html, /2 unstaged/);
  assert.match(html, /3 untracked/);
  assert.match(html, new RegExp(DIGEST));
  assert.match(html, /permanently removed/i);
  assert.match(html, /Ignored contents are deliberately uninspected/i);
  assert.match(html, /src\/a\.ts/);
});

test('exact branch confirmation is required and missing worktree evidence cannot approve', () => {
  const present = preview();
  assert.equal(abandonmentConfirmationMatches(present, 'feature-safe'), true);
  assert.equal(abandonmentConfirmationMatches(present, 'FEATURE-SAFE'), false);
  assert.equal(abandonmentConfirmationMatches(present, ' feature-safe '), false);
  assert.equal(abandonmentConfirmationMatches(null, 'feature-safe'), false);
  assert.equal(abandonmentConfirmationMatches(preview({
    worktreeState: {
      directory: 'missing',
      registration: 'absent',
      status: 'unavailable',
      worktreeStateDigest: DIGEST,
      changedPaths: [],
      ignoredContents: 'uninspected',
    },
  }), 'feature-safe'), false);
});

test('settlement copy distinguishes completed teardown from durable pending approval', () => {
  const contract = {
    abandonmentReceipt: { branch: 'feature-safe', branchTip: SHA, integrationState: 'unmerged' },
  } as ApproveWorktreeAbandonmentResponse['contract'];
  const completed = renderToStaticMarkup(createElement(AbandonmentSettlementNotice, {
    response: { ok: true, settlement: 'completed', contract },
  }));
  const pending = renderToStaticMarkup(createElement(AbandonmentSettlementNotice, {
    response: { ok: true, settlement: 'pending', contract },
  }));
  assert.match(completed, /settled/i);
  assert.match(completed, /branch-only commits were not merged/i);
  assert.match(pending, /approval is recorded/i);
  assert.match(pending, /re-driven after restart/i);
  assert.match(pending, /branch remains preserved/i);

  const noExclusive = renderToStaticMarkup(createElement(AbandonmentSettlementNotice, {
    response: {
      ok: true,
      settlement: 'completed',
      contract: {
        abandonmentReceipt: {
          branch: 'feature-safe',
          branchTip: SHA,
          integrationState: 'no-exclusive-commits',
        },
      } as ApproveWorktreeAbandonmentResponse['contract'],
    },
  }));
  assert.match(noExclusive, /no branch-exclusive commit existed to merge/i);
});

test('modal source keeps explicit-close semantics, stable retry id, and stale-preview reset', () => {
  const source = readFileSync(new URL('../src/components/AbandonWorktreeModal.tsx', import.meta.url), 'utf8');
  assert.match(source, /useState\(\(\) => crypto\.randomUUID\(\)\)/);
  assert.match(source, /setConfirmation\(''\)/);
  assert.match(source, /loadPreview\(true\)/);
  assert.doesNotMatch(source, /onClick=\{onClose\}[^>]*aria-hidden/);
  assert.match(source, /No backdrop|explicit-close|aria-label="Close abandonment confirmation"/i);
});

test('activity exposes direct contract abandonment for stranded work without a retained run', () => {
  const source = readFileSync(new URL('../src/components/ActivityPanel.tsx', import.meta.url), 'utf8');
  assert.match(source, /w\.contractId/);
  assert.match(source, /onAbandon\(w\.contractId!\)/);
  assert.match(source, /<AbandonWorktreeModal/);
});
