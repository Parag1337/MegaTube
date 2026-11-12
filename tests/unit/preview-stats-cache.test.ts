/**
 * Phase 5.1 remediation: dashboard statistics cache.
 *
 * Pins the cost-control contract: TTL hits, single-flight coalescing,
 * explicit invalidation with a minimum refresh interval, and bounded
 * invalidation storms. These are pure memory tests (no DB, no disk).
 */

import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import {
  __resetPreviewStatsCacheForTests,
  getCachedStats,
  invalidatePreviewStatsCache,
  previewStatsCacheMetrics,
} from '@/lib/preview/stats-cache';

beforeEach(() => {
  __resetPreviewStatsCacheForTests();
});

test('stats cache: TTL hits avoid the loader, expiry refreshes once', async () => {
  let now = 1_700_000_000_000;
  let loads = 0;
  const options = { ttlMs: 20_000, minRefreshMs: 15_000, now: () => now };
  const load = async () => {
    loads++;
    return { value: loads };
  };

  assert.deepEqual(await getCachedStats('library:a', options, load), { value: 1 });
  assert.deepEqual(await getCachedStats('library:a', options, load), { value: 1 });
  assert.equal(loads, 1);
  assert.equal(previewStatsCacheMetrics().hits, 1);

  now += 19_999;
  await getCachedStats('library:a', options, load);
  assert.equal(loads, 1, 'still inside the TTL');

  now += 1;
  assert.deepEqual(await getCachedStats('library:a', options, load), { value: 2 });
  assert.equal(loads, 2);
  assert.equal(previewStatsCacheMetrics().misses, 2);
});

test('stats cache: concurrent refreshes are single-flight', async () => {
  let loads = 0;
  let release!: (value: string) => void;
  const gate = new Promise<string>((resolve) => {
    release = resolve;
  });
  const now = 1_700_000_000_000;
  const options = { ttlMs: 20_000, minRefreshMs: 15_000, now: () => now };
  const load = async () => {
    loads++;
    return gate;
  };

  const first = getCachedStats('library:b', options, load);
  const second = getCachedStats('library:b', options, load);
  release('done');
  assert.equal(await first, 'done');
  assert.equal(await second, 'done');
  assert.equal(loads, 1, 'only one underlying scan');
  assert.equal(previewStatsCacheMetrics().coalesced, 1);
});

test('stats cache: invalidation is throttled by the minimum refresh interval', async () => {
  let now = 1_700_000_000_000;
  let loads = 0;
  const options = { ttlMs: 20_000, minRefreshMs: 15_000, now: () => now };
  const load = async () => {
    loads++;
    return loads;
  };

  assert.equal(await getCachedStats('library:c', options, load), 1);
  invalidatePreviewStatsCache('library:c');

  // A completion storm invalidates continuously; the dashboard still serves
  // the previous snapshot until the minimum interval has elapsed.
  assert.equal(await getCachedStats('library:c', options, load), 1);
  assert.equal(loads, 1);
  now += 14_999;
  assert.equal(await getCachedStats('library:c', options, load), 1);
  assert.equal(loads, 1);

  now += 1;
  assert.equal(await getCachedStats('library:c', options, load), 2);
  assert.equal(loads, 2);
  assert.ok(previewStatsCacheMetrics().invalidations >= 1);
});

test('stats cache: global invalidation affects every cached user entry', async () => {
  let now = 1_700_000_000_000;
  const loads = new Map<string, number>();
  const options = { ttlMs: 20_000, minRefreshMs: 0, now: () => now };
  const load = (key: string) => async () => {
    const n = (loads.get(key) ?? 0) + 1;
    loads.set(key, n);
    return `${key}:${n}`;
  };

  assert.equal(await getCachedStats('library:u1', options, load('u1')), 'u1:1');
  assert.equal(await getCachedStats('library:u2', options, load('u2')), 'u2:1');
  invalidatePreviewStatsCache();
  now += 1;
  assert.equal(await getCachedStats('library:u1', options, load('u1')), 'u1:2');
  assert.equal(await getCachedStats('library:u2', options, load('u2')), 'u2:2');
});
