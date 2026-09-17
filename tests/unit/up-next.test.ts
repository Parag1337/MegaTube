/**
 * Unit tests for the video-page "Up next" selector (lib/upNext.ts).
 *
 * Pure function over already-fetched pools - no database, no MEGA.
 * Covers: 2+2 composition, current-video exclusion, no duplicates,
 * quota shortfall fills (creator/title/fallback), max-4 cap, and
 * order preservation (pools arrive pre-ranked: creator newest-first,
 * title by FTS/trigram relevance).
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { selectUpNext } from '@/lib/upNext';

interface V {
  id: number;
  slug: string;
}

function v(id: number): V {
  return { id, slug: `v-${id}` };
}

test('prefers exactly 2 same-creator + 2 title matches', () => {
  const out = selectUpNext(1, {
    creator: [v(11), v(12), v(13)],
    title: [v(21), v(22), v(23)],
    random: [v(31), v(32)],
  });
  assert.deepEqual(
    out.map((x) => x.id),
    [11, 12, 21, 22],
  );
});

test('never recommends the current video, even when it leads a pool', () => {
  const out = selectUpNext(11, {
    creator: [v(11), v(12), v(13)],
    title: [v(11), v(21)],
    random: [v(11), v(31)],
  });
  assert.ok(!out.some((x) => x.id === 11));
  assert.deepEqual(
    out.map((x) => x.id),
    [12, 13, 21, 31],
  );
});

test('never shows the same video twice across pools', () => {
  const out = selectUpNext(1, {
    creator: [v(11), v(12)],
    title: [v(11), v(21), v(22)],
    random: [v(21), v(31)],
  });
  const ids = out.map((x) => x.id);
  assert.equal(new Set(ids).size, ids.length);
  assert.deepEqual(ids, [11, 12, 21, 22]);
});

test('creator shortfall is filled with title matches', () => {
  const out = selectUpNext(1, {
    creator: [v(11)],
    title: [v(21), v(22), v(23), v(24)],
    random: [v(31)],
  });
  assert.deepEqual(
    out.map((x) => x.id),
    [11, 21, 22, 23],
  );
});

test('no creator at all -> all title matches', () => {
  const out = selectUpNext(1, {
    creator: [],
    title: [v(21), v(22), v(23)],
    random: [v(31)],
  });
  assert.deepEqual(
    out.map((x) => x.id),
    [21, 22, 23, 31],
  );
});

test('title shortfall is filled with extra same-creator candidates first', () => {
  const out = selectUpNext(1, {
    creator: [v(11), v(12), v(13), v(14)],
    title: [v(21)],
    random: [v(31)],
  });
  assert.deepEqual(
    out.map((x) => x.id),
    [11, 12, 21, 13],
  );
});

test('empty creator+title pools fall back to random discovery', () => {
  const out = selectUpNext(1, {
    creator: [],
    title: [],
    random: [v(31), v(32), v(33), v(34), v(35)],
  });
  assert.deepEqual(
    out.map((x) => x.id),
    [31, 32, 33, 34],
  );
});

test('maximum 4 results, shrinks gracefully when candidates are scarce', () => {
  const full = selectUpNext(1, {
    creator: [v(11), v(12), v(13)],
    title: [v(21), v(22), v(23)],
    random: [v(31), v(32)],
  });
  assert.ok(full.length <= 4);
  const scarce = selectUpNext(1, { creator: [v(11)], title: [], random: [] });
  assert.deepEqual(
    scarce.map((x) => x.id),
    [11],
  );
  const empty = selectUpNext(1, { creator: [], title: [], random: [] });
  assert.deepEqual(empty, []);
});

test('pool order is preserved (pre-ranked relevance)', () => {
  const out = selectUpNext(1, {
    creator: [v(13), v(11), v(12)],
    title: [v(23), v(21), v(22)],
    random: [],
  });
  assert.deepEqual(
    out.map((x) => x.id),
    [13, 11, 23, 21],
  );
});
