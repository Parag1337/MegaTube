import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import {
  findDuplicateGroups,
  findGroupsWipedOut,
  normalizeTitle,
  partitionDeletionTargets,
  titleSimilarity,
  TITLE_SIM_HIGH,
  TITLE_SIM_MIN,
  type DuplicateCandidate,
} from '@/lib/duplicates';

function video(overrides: Partial<DuplicateCandidate> = {}): DuplicateCandidate {
  return {
    videoId: 1,
    nodeId: 'node-1',
    name: '/Videos/Video.mp4',
    parentNodeId: 'parent-1',
    size: 1_500_000_000,
    duration: 1112,
    title: 'Video',
    creatorName: 'Creator',
    thumbnail: null,
    mimeType: 'video/mp4',
    megaModifiedAt: null,
    accountId: 1,
    accountLabel: 'Account 1',
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Normalization unit tests
// ---------------------------------------------------------------------------

test('normalizeTitle strips creator prefixes to the same key', () => {
  assert.equal(normalizeTitle('Creator - Amazing Video.mp4'), 'amazing video');
  assert.equal(normalizeTitle('Watch Creator - Amazing Video.mp4'), 'amazing video');
  assert.equal(normalizeTitle('Amazing Video.mp4'), 'amazing video');
});

test('normalizeTitle strips duplicate suffixes', () => {
  const base = normalizeTitle('Amazing Video.mp4');
  for (const name of [
    'Amazing Video (1).mp4',
    'Amazing Video (2).mp4',
    'Amazing Video Copy.mp4',
    'Amazing Video copy 1.mp4',
    'Amazing Video - Copy.mp4',
    'Amazing Video duplicate.mp4',
    'Amazing Video (1) Copy.mp4',
  ]) {
    assert.equal(normalizeTitle(name), base, name);
  }
});

test('normalizeTitle does not destroy meaningful titles', () => {
  // "The Copy" is a real title, not a duplicate marker (short stem kept).
  assert.equal(normalizeTitle('The Copy.mp4'), 'the copy');
  // A title-only filename starting with "Watch" keeps its full title.
  assert.equal(normalizeTitle('Watch Me Dance.mp4'), 'watch me dance');
});

test('normalizeTitle folds case, whitespace and punctuation', () => {
  assert.equal(normalizeTitle('VIDEO  TITLE.mp4'), 'video title');
  assert.equal(normalizeTitle('My Video: Part 2.mp4'), 'my video part 2');
  assert.equal(normalizeTitle('Creator_-_Video_Title.mp4'), 'video title');
});

test('titleSimilarity is a 0-100 score with sane anchors', () => {
  assert.equal(titleSimilarity('amazing video', 'amazing video'), 100);
  assert.equal(titleSimilarity('', 'amazing video'), 0);
  assert.ok(titleSimilarity('holiday in rome', 'cooking with anna') < TITLE_SIM_MIN);
  assert.ok(titleSimilarity('amazing videos', 'amazing video') >= TITLE_SIM_HIGH);
});

// ---------------------------------------------------------------------------
// Candidate grouping: filename variants (required cases 1-4, 18-19)
// ---------------------------------------------------------------------------

test('Creator - Video.mp4 vs Video.mp4 groups', () => {
  const r = findDuplicateGroups([
    video({ videoId: 1, nodeId: 'a', name: '/Videos/Creator - Amazing Video.mp4' }),
    video({ videoId: 2, nodeId: 'b', name: '/Backup/Amazing Video.mp4' }),
  ]);
  assert.equal(r.groups.length, 1);
  assert.equal(r.groups[0].confidence, 'high');
  assert.equal(r.groups[0].minTitleSim, 100);
});

test('Watch Creator - Video.mp4 vs Creator - Video.mp4 groups', () => {
  const r = findDuplicateGroups([
    video({ videoId: 1, nodeId: 'a', name: 'Watch Creator - Amazing Video.mp4' }),
    video({ videoId: 2, nodeId: 'b', name: 'Creator - Amazing Video.mp4' }),
  ]);
  assert.equal(r.groups.length, 1);
  assert.equal(r.groups[0].confidence, 'high');
});

test('Video.mp4 vs Video (1).mp4 groups', () => {
  const r = findDuplicateGroups([
    video({ videoId: 1, nodeId: 'a', name: '/Videos/Amazing Video.mp4' }),
    video({ videoId: 2, nodeId: 'b', name: '/Old/Amazing Video (1).mp4' }),
  ]);
  assert.equal(r.groups.length, 1);
});

test('Video.mp4 vs Video Copy.mp4 groups', () => {
  const r = findDuplicateGroups([
    video({ videoId: 1, nodeId: 'a', name: '/Videos/Amazing Video.mp4' }),
    video({ videoId: 2, nodeId: 'b', name: '/Old/Amazing Video Copy.mp4' }),
  ]);
  assert.equal(r.groups.length, 1);
});

test('underscore creator convention matches the spaced one', () => {
  const r = findDuplicateGroups([
    video({ videoId: 1, nodeId: 'a', name: 'Creator_-_Video_Title.mp4' }),
    video({ videoId: 2, nodeId: 'b', name: 'Creator - Video Title.mp4' }),
  ]);
  assert.equal(r.groups.length, 1);
});

// ---------------------------------------------------------------------------
// Similarity bands + size/duration rules (required cases 5-12)
// ---------------------------------------------------------------------------

test('95%+ title similarity with the same size is high confidence', () => {
  const r = findDuplicateGroups([
    video({ videoId: 1, nodeId: 'a', name: 'Amazing Videos.mp4' }),
    video({ videoId: 2, nodeId: 'b', name: 'Amazing Video.mp4' }),
  ]);
  assert.equal(r.groups.length, 1);
  assert.equal(r.groups[0].confidence, 'high');
  assert.ok(r.groups[0].minTitleSim >= TITLE_SIM_HIGH);
});

test('90-94% title similarity with the same size is a possible match', () => {
  const r = findDuplicateGroups([
    video({ videoId: 1, nodeId: 'a', name: 'Best Moments Collection.mp4' }),
    video({ videoId: 2, nodeId: 'b', name: 'Best Moments Selections.mp4' }),
  ]);
  assert.equal(r.groups.length, 1);
  assert.equal(r.groups[0].confidence, 'possible');
  assert.ok(r.groups[0].minTitleSim >= TITLE_SIM_MIN);
  assert.ok(r.groups[0].minTitleSim < TITLE_SIM_HIGH);
});

test('below-90% similarity never groups, even with equal size', () => {
  const r = findDuplicateGroups([
    video({ videoId: 1, nodeId: 'a', name: 'Holiday in Rome.mp4' }),
    video({ videoId: 2, nodeId: 'b', name: 'Cooking with Anna.mp4' }),
  ]);
  assert.equal(r.groups.length, 0);
});

test('same title but different size never groups', () => {
  const r = findDuplicateGroups([
    video({ videoId: 1, nodeId: 'a', name: '/Videos/Amazing Video.mp4', size: 1000, duration: 60 }),
    video({ videoId: 2, nodeId: 'b', name: '/Backup/Amazing Video.mp4', size: 2000, duration: 60 }),
  ]);
  assert.equal(r.groups.length, 0);
});

test('same size but unrelated titles never groups', () => {
  const r = findDuplicateGroups([
    video({ videoId: 1, nodeId: 'a', name: 'Holiday in Rome.mp4', size: 1000, duration: 60 }),
    video({ videoId: 2, nodeId: 'b', name: 'Cooking with Anna.mp4', size: 1000, duration: 60 }),
  ]);
  assert.equal(r.groups.length, 0);
});

test('materially different durations veto the candidate', () => {
  const r = findDuplicateGroups([
    video({ videoId: 1, nodeId: 'a', name: 'Amazing Video.mp4', size: 1000, duration: 60 }),
    video({ videoId: 2, nodeId: 'b', name: 'Amazing Video (1).mp4', size: 1000, duration: 600 }),
  ]);
  assert.equal(r.groups.length, 0);
});

test('unknown duration does not veto an otherwise strong candidate', () => {
  const r = findDuplicateGroups([
    video({ videoId: 1, nodeId: 'a', name: 'Amazing Video.mp4', size: 1000, duration: null }),
    video({ videoId: 2, nodeId: 'b', name: 'Amazing Video (1).mp4', size: 1000, duration: 600 }),
  ]);
  assert.equal(r.groups.length, 1);
  assert.equal(r.groups[0].confidence, 'high');
  assert.equal(r.groups[0].durationStatus, 'partial-unknown');
});

test('different containers group with possible confidence and a format flag', () => {
  const r = findDuplicateGroups([
    video({ videoId: 1, nodeId: 'a', name: 'Amazing Video.mp4', size: 1000, duration: 60 }),
    video({ videoId: 2, nodeId: 'b', name: 'Amazing Video.mkv', size: 1000, duration: 60 }),
  ]);
  assert.equal(r.groups.length, 1);
  assert.equal(r.groups[0].confidence, 'possible');
  assert.deepEqual(r.groups[0].extensions, ['mkv', 'mp4']);
});

// ---------------------------------------------------------------------------
// Multi-copy / multi-group behavior (required cases 13-14)
// ---------------------------------------------------------------------------

test('three filename variants form one high-confidence group', () => {
  const r = findDuplicateGroups([
    video({ videoId: 1, nodeId: 'a', name: '/Videos/Creator - Amazing Video.mp4' }),
    video({ videoId: 2, nodeId: 'b', name: '/Backup/Amazing Video (1).mp4' }),
    video({ videoId: 3, nodeId: 'c', name: '/Old/Amazing Video Copy.mp4' }),
  ]);
  assert.equal(r.groups.length, 1);
  assert.equal(r.groups[0].totalCopies, 3);
  assert.equal(r.groups[0].confidence, 'high');
  assert.equal(r.summary.potentialSavingsBytes, 3_000_000_000);
});

test('multiple independent groups are all reported', () => {
  const r = findDuplicateGroups([
    video({ videoId: 1, nodeId: 'a', name: 'Alpha Clip.mp4', size: 100, duration: 10 }),
    video({ videoId: 2, nodeId: 'b', name: 'Alpha Clip (1).mp4', size: 100, duration: 10 }),
    video({ videoId: 3, nodeId: 'c', name: 'Beta Clip.mp4', size: 200, duration: 20 }),
    video({ videoId: 4, nodeId: 'd', name: 'Beta Clip Copy.mp4', size: 200, duration: 20 }),
    video({ videoId: 5, nodeId: 'e', name: 'Lonely Clip.mp4', size: 300, duration: 30 }),
  ]);
  assert.equal(r.groups.length, 2);
  assert.equal(r.summary.duplicateFiles, 4);
  assert.equal(r.summary.scannedVideos, 5);
});

// ---------------------------------------------------------------------------
// False-positive guards (required case 15)
// ---------------------------------------------------------------------------

test('very short titles never group, even when identical with equal size', () => {
  const r = findDuplicateGroups([
    video({ videoId: 1, nodeId: 'a', name: 'Up.mp4', size: 1000, duration: 60 }),
    video({ videoId: 2, nodeId: 'b', name: 'Up.mp4', size: 1000, duration: 60 }),
  ]);
  assert.equal(r.groups.length, 0);
});

test('short titles need an identical normalized form', () => {
  // "Cat" vs "Cats" scores ~94 but is too short to trust -> no group.
  const different = findDuplicateGroups([
    video({ videoId: 1, nodeId: 'a', name: 'Cat.mp4', size: 1000, duration: 60 }),
    video({ videoId: 2, nodeId: 'b', name: 'Cats.mp4', size: 1000, duration: 60 }),
  ]);
  assert.equal(different.groups.length, 0);
  // Identical short forms still group ("Clip" vs "Clip (1)").
  const identical = findDuplicateGroups([
    video({ videoId: 1, nodeId: 'a', name: 'Clip.mp4', size: 1000, duration: 60 }),
    video({ videoId: 2, nodeId: 'b', name: 'Clip (1).mp4', size: 1000, duration: 60 }),
  ]);
  assert.equal(identical.groups.length, 1);
});

// ---------------------------------------------------------------------------
// Preserved behavior from the exact-match era
// ---------------------------------------------------------------------------

test('two copies group together with full summary', () => {
  const r = findDuplicateGroups([
    video({ videoId: 1, nodeId: 'a' }),
    video({ videoId: 2, nodeId: 'b', name: '/Backup/Video.mp4', parentNodeId: 'parent-2' }),
  ]);
  assert.equal(r.groups.length, 1);
  assert.equal(r.groups[0].totalCopies, 2);
  assert.equal(r.summary.duplicateGroups, 1);
  assert.equal(r.summary.duplicateFiles, 2);
  assert.equal(r.summary.potentialSavingsBytes, 1_500_000_000);
  assert.equal(r.groups[0].durationStatus, 'same');
  assert.equal(r.groups[0].sameSizeBytes, 1_500_000_000);
});

test('same filename but different size never groups', () => {
  const r = findDuplicateGroups([
    video({ videoId: 1, nodeId: 'a', name: '/Videos/Video.mp4', size: 1000, duration: 60 }),
    video({ videoId: 2, nodeId: 'b', name: '/Backup/Video.mp4', size: 2000, duration: 60 }),
  ]);
  assert.equal(r.groups.length, 0);
});

test('unknown or zero size never groups at all', () => {
  const r = findDuplicateGroups([
    video({ videoId: 1, nodeId: 'a', size: null, duration: 60 }),
    video({ videoId: 2, nodeId: 'b', size: null, duration: 60 }),
    video({ videoId: 3, nodeId: 'c', size: 0, duration: 60 }),
    video({ videoId: 4, nodeId: 'd', size: 0, duration: 60 }),
  ]);
  assert.equal(r.groups.length, 0);
});

test('no duplicates returns an empty result', () => {
  const r = findDuplicateGroups([
    video({ videoId: 1, nodeId: 'a', name: 'Alpha Clip.mp4', size: 100, duration: 10 }),
    video({ videoId: 2, nodeId: 'b', name: 'Beta Clip.mp4', size: 200, duration: 20 }),
  ]);
  assert.equal(r.groups.length, 0);
  assert.equal(r.summary.duplicateGroups, 0);
  assert.equal(r.summary.duplicateFiles, 0);
  assert.equal(r.summary.potentialSavingsBytes, 0);
});

test('extension match is case-insensitive', () => {
  const r = findDuplicateGroups([
    video({ videoId: 1, nodeId: 'a', name: 'Video.MP4', size: 100, duration: 10 }),
    video({ videoId: 2, nodeId: 'b', name: 'video.mp4', size: 100, duration: 10 }),
  ]);
  assert.equal(r.groups.length, 1);
});

test('findGroupsWipedOut flags only fully selected groups', () => {
  const r = findDuplicateGroups([
    video({ videoId: 1, nodeId: 'a', name: 'Alpha Clip.mp4', size: 100, duration: 10 }),
    video({ videoId: 2, nodeId: 'b', name: 'Alpha Clip (1).mp4', size: 100, duration: 10 }),
    video({ videoId: 3, nodeId: 'c', name: 'Alpha Clip Copy.mp4', size: 100, duration: 10 }),
  ]);
  assert.equal(r.groups.length, 1);
  assert.deepEqual(findGroupsWipedOut(r.groups, new Set(['a', 'b', 'c'])), [r.groups[0].groupKey]);
  assert.deepEqual(findGroupsWipedOut(r.groups, new Set(['a', 'b'])), []);
  assert.deepEqual(findGroupsWipedOut(r.groups, new Set(['x'])), []);
});

// ---------------------------------------------------------------------------
// Cross-account scanning (combined library)
// ---------------------------------------------------------------------------

test('duplicates across Account 1 and Account 2 form one group', () => {
  const r = findDuplicateGroups([
    video({ videoId: 1, nodeId: 'a', name: '/Videos/Creator - Amazing Video.mp4', accountId: 1, accountLabel: 'Account 1' }),
    video({ videoId: 2, nodeId: 'b', name: '/Backup/Amazing Video.mp4', accountId: 2, accountLabel: 'Account 2' }),
  ]);
  assert.equal(r.groups.length, 1);
  assert.equal(r.groups[0].confidence, 'high');
  const labels = r.groups[0].copies.map((c) => c.accountLabel).sort();
  assert.deepEqual(labels, ['Account 1', 'Account 2']);
});

test('three copies across multiple accounts form one group', () => {
  const r = findDuplicateGroups([
    video({ videoId: 1, nodeId: 'a', name: 'Creator - Amazing Video.mp4', accountId: 1, accountLabel: 'Account 1' }),
    video({ videoId: 2, nodeId: 'b', name: 'Amazing Video (1).mp4', accountId: 2, accountLabel: 'Account 2' }),
    video({ videoId: 3, nodeId: 'c', name: 'Amazing Video Copy.mp4', accountId: 2, accountLabel: 'Account 2' }),
  ]);
  assert.equal(r.groups.length, 1);
  assert.equal(r.groups[0].totalCopies, 3);
});

test('independent groups across accounts stay separate', () => {
  const r = findDuplicateGroups([
    video({ videoId: 1, nodeId: 'a', name: 'Alpha Clip.mp4', size: 100, duration: 10, accountId: 1, accountLabel: 'Account 1' }),
    video({ videoId: 2, nodeId: 'b', name: 'Alpha Clip (1).mp4', size: 100, duration: 10, accountId: 2, accountLabel: 'Account 2' }),
    video({ videoId: 3, nodeId: 'c', name: 'Beta Clip.mp4', size: 200, duration: 20, accountId: 1, accountLabel: 'Account 1' }),
    video({ videoId: 4, nodeId: 'd', name: 'Beta Clip Copy.mp4', size: 200, duration: 20, accountId: 2, accountLabel: 'Account 2' }),
  ]);
  assert.equal(r.groups.length, 2);
  for (const g of r.groups) {
    assert.equal(g.totalCopies, 2);
  }
});

test('same title on two accounts with different sizes never groups', () => {
  const r = findDuplicateGroups([
    video({ videoId: 1, nodeId: 'a', name: 'Amazing Video.mp4', size: 1000, accountId: 1, accountLabel: 'Account 1' }),
    video({ videoId: 2, nodeId: 'b', name: 'Amazing Video.mp4', size: 2000, accountId: 2, accountLabel: 'Account 2' }),
  ]);
  assert.equal(r.groups.length, 0);
});

test('keep-one-copy guard works across accounts', () => {
  const r = findDuplicateGroups([
    video({ videoId: 1, nodeId: 'a', name: 'Amazing Video.mp4', accountId: 1, accountLabel: 'Account 1' }),
    video({ videoId: 2, nodeId: 'b', name: 'Amazing Video (1).mp4', accountId: 2, accountLabel: 'Account 2' }),
    video({ videoId: 3, nodeId: 'c', name: 'Amazing Video Copy.mp4', size: 1_500_000_000, duration: 1112, accountId: 2, accountLabel: 'Account 2' }),
  ]);
  assert.equal(r.groups.length, 1);
  // Deleting B + C (one account) is allowed; deleting A + B + C is refused.
  assert.deepEqual(findGroupsWipedOut(r.groups, new Set(['b', 'c'])), []);
  assert.deepEqual(findGroupsWipedOut(r.groups, new Set(['a', 'b', 'c'])), [r.groups[0].groupKey]);
});

// ---------------------------------------------------------------------------
// Deletion authorization helper (pure half of the server-side guard)
// ---------------------------------------------------------------------------

test('partitionDeletionTargets groups verified nodes by account', () => {
  const p = partitionDeletionTargets(
    [
      { nodeId: 'a', videoId: 1, megaAccountId: 1 },
      { nodeId: 'b', videoId: 2, megaAccountId: 2 },
      { nodeId: 'c', videoId: 3, megaAccountId: 2 },
    ],
    ['a', 'b', 'c'],
  );
  assert.deepEqual(p.unknownNodeIds, []);
  assert.equal(p.byAccount.size, 2);
  assert.deepEqual(p.byAccount.get(1)?.map((t) => t.nodeId), ['a']);
  assert.deepEqual(p.byAccount.get(2)?.map((t) => t.nodeId), ['b', 'c']);
});

test('partitionDeletionTargets rejects ids with no user-owned row', () => {
  // Rows are pre-filtered to the caller's accounts, so a foreign user's
  // node simply never appears here and is rejected as unknown.
  const p = partitionDeletionTargets(
    [{ nodeId: 'a', videoId: 1, megaAccountId: 1 }],
    ['a', 'foreign-node', 'missing-node'],
  );
  assert.deepEqual(p.unknownNodeIds, ['foreign-node', 'missing-node']);
  assert.deepEqual(p.byAccount.get(1)?.map((t) => t.nodeId), ['a']);
});

// ---------------------------------------------------------------------------
// Thumbnail presentation (references only - never generated while scanning)
// ---------------------------------------------------------------------------

test('group copies preserve the stored thumbnail reference per copy', () => {
  const r = findDuplicateGroups([
    video({ videoId: 1, nodeId: 'a', name: 'Amazing Video.mp4', thumbnail: '/api/media/thumbs/1' }),
    video({ videoId: 2, nodeId: 'b', name: 'Amazing Video (1).mp4', thumbnail: null }),
  ]);
  assert.equal(r.groups.length, 1);
  const thumbs = new Map(r.groups[0].copies.map((c) => [c.nodeId, c.thumbnail]));
  assert.equal(thumbs.get('a'), '/api/media/thumbs/1');
  assert.equal(thumbs.get('b'), null);
});

test('duplicate scanning never downloads videos or generates thumbnails', () => {
  const lib = readFileSync(resolve(process.cwd(), 'lib/duplicates.ts'), 'utf8');
  assert.ok(!lib.includes('fetch('), 'detection must not fetch anything');
  assert.ok(!lib.includes('thumbs/repair'), 'detection must not repair thumbnails');
  assert.ok(!lib.includes('getPrivateNodeImage'), 'detection must not fetch MEGA images');
  const route = readFileSync(resolve(process.cwd(), 'app/api/mega/duplicates/route.ts'), 'utf8');
  // Ownership is enforced inside the database queries, never via client input.
  assert.ok(route.includes('megaAccount: {'), 'rows must be scoped through the owning account');
  assert.ok(route.includes('userId: user.id'), 'scope must be the authenticated user');
  // No session material is ever logged or returned: every mention of the
  // encrypted session must live outside response construction.
  assert.ok(!route.includes('console.log'), 'no logging of node/selection details');
  for (const line of route.split('\n')) {
    if (line.includes('encryptedSession')) {
      assert.ok(!line.includes('NextResponse'), 'session material never leaves the server');
    }
  }
});
