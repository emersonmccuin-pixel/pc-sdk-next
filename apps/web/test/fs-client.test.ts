import { test } from 'node:test';
import assert from 'node:assert/strict';

import { fsApi } from '../src/features/fs/client.ts';

test('fsApi.listDir posts to /api/fs/list and unwraps the listing', async () => {
  const originalFetch = globalThis.fetch;
  try {
    let capturedUrl: string | undefined;
    let capturedBody: unknown;
    globalThis.fetch = (async (url: string, init?: RequestInit) => {
      capturedUrl = url;
      capturedBody = init?.body ? JSON.parse(init.body as string) : undefined;
      return new Response(
        JSON.stringify({
          ok: true,
          listing: {
            path: 'C:\\Users\\me',
            parent: 'C:\\Users',
            entries: [
              { name: 'projects', path: 'C:\\Users\\me\\projects', isGitRepo: false },
              { name: 'repo', path: 'C:\\Users\\me\\repo', isGitRepo: true },
            ],
          },
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      );
    }) as typeof fetch;

    const listing = await fsApi.listDir('C:\\Users\\me');
    assert.equal(capturedUrl, '/api/fs/list');
    assert.deepEqual(capturedBody, { path: 'C:\\Users\\me' });
    assert.equal(listing.path, 'C:\\Users\\me');
    assert.equal(listing.parent, 'C:\\Users');
    assert.equal(listing.entries.length, 2);
    assert.equal(listing.entries[1]?.isGitRepo, true);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('fsApi.listDir defaults to an empty path when none is given', async () => {
  const originalFetch = globalThis.fetch;
  try {
    let capturedBody: unknown;
    globalThis.fetch = (async (_url: string, init?: RequestInit) => {
      capturedBody = init?.body ? JSON.parse(init.body as string) : undefined;
      return new Response(
        JSON.stringify({ ok: true, listing: { path: '/home/me', parent: '/home', entries: [] } }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      );
    }) as typeof fetch;

    const listing = await fsApi.listDir();
    assert.deepEqual(capturedBody, { path: '' });
    assert.deepEqual(listing.entries, []);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('fsApi.listDir throws on a not-found path', async () => {
  const originalFetch = globalThis.fetch;
  try {
    globalThis.fetch = (async () =>
      new Response(JSON.stringify({ ok: false, error: 'not found' }), {
        status: 404,
        headers: { 'content-type': 'application/json' },
      })) as typeof fetch;

    await assert.rejects(() => fsApi.listDir('/does/not/exist'), /not found/);
  } finally {
    globalThis.fetch = originalFetch;
  }
});
