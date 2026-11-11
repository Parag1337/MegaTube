/**
 * Phase 5 regression tests: client hover-preview meta cache + bounded wait.
 *
 * The cold-generation bug was: meta blocked for the whole generation, the
 * browser fetch timed out, and the card never learned the clip was ready.
 * These tests pin the client half: known-ready responses are cached, the
 * wait loop keeps polling while `generating`, and it stops on terminal
 * states / pointer leave / timeout.
 */

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';

let client: typeof import('@/lib/preview-meta-client');
const originalFetch = globalThis.fetch;

before(async () => {
  client = await import('@/lib/preview-meta-client');
});

after(() => {
  globalThis.fetch = originalFetch;
});

function mockMetaSequence(
  bodies: Array<{ status: string; hover?: { url?: string } | null }>,
): { calls: () => number } {
  let i = 0;
  globalThis.fetch = (async () => {
    const body = bodies[Math.min(i, bodies.length - 1)];
    i++;
    return {
      ok: true,
      json: async () => body,
    } as Response;
  }) as typeof fetch;
  return { calls: () => i };
}

test('known-ready meta is returned and cached (no repeat fetch)', async () => {
  const mock = mockMetaSequence([{ status: 'ready', hover: { url: '/api/preview/101' } }]);
  assert.equal(await client.resolveCardHoverPreview(101), '/api/preview/101');
  assert.equal(await client.resolveCardHoverPreview(101), '/api/preview/101');
  assert.equal(mock.calls(), 1);
  assert.equal(client.cachedCardPreviewMeta(101)?.hoverUrl, '/api/preview/101');
});

test('wait loop polls through generating until the clip is ready', async () => {
  const mock = mockMetaSequence([
    { status: 'generating', hover: null },
    { status: 'generating', hover: null },
    { status: 'ready', hover: { url: '/api/preview/102' } },
  ]);
  const url = await client.waitForCardHoverPreview(102, () => true, {
    intervalMs: 1,
    timeoutMs: 200,
  });
  assert.equal(url, '/api/preview/102');
  assert.equal(mock.calls(), 3);
  assert.equal(client.cachedCardPreviewMeta(102)?.hoverUrl, '/api/preview/102');
});

test('wait loop stops immediately on a terminal state', async () => {
  const mock = mockMetaSequence([{ status: 'unavailable', hover: null }]);
  const url = await client.waitForCardHoverPreview(103, () => true, {
    intervalMs: 1,
    timeoutMs: 200,
  });
  assert.equal(url, null);
  assert.equal(mock.calls(), 1);
});

test('wait loop stops when the pointer leaves (inactive)', async () => {
  const mock = mockMetaSequence([{ status: 'generating', hover: null }]);
  const url = await client.waitForCardHoverPreview(104, () => false, {
    intervalMs: 1,
    timeoutMs: 200,
  });
  assert.equal(url, null);
  assert.equal(mock.calls(), 0);
});

test('wait loop is bounded by its timeout', async () => {
  const mock = mockMetaSequence([{ status: 'generating', hover: null }]);
  const start = Date.now();
  const url = await client.waitForCardHoverPreview(105, () => true, {
    intervalMs: 5,
    timeoutMs: 25,
  });
  assert.equal(url, null);
  assert.ok(mock.calls() >= 2);
  assert.ok(Date.now() - start >= 20);
});

test('network failure during the wait stops the loop (fallback path)', async () => {
  globalThis.fetch = (async () => {
    throw new Error('network down');
  }) as typeof fetch;
  const url = await client.waitForCardHoverPreview(106, () => true, {
    intervalMs: 1,
    timeoutMs: 200,
  });
  assert.equal(url, null);
});
