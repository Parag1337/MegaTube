/**
 * P2.0 product foundation regression tests.
 *
 * Covers (against an isolated DB built from the repo migrations):
 *   Watchlist: add / duplicate add / remove / membership / isolation
 *   Saved: save / duplicate save / unsave / membership / isolation
 *   History: record / re-watch update / chronological order / remove one /
 *     clear / isolation
 *   New Videos: newest ordering / pagination / ownership
 *   Creator parsing: "Creator - Title" / "Watch Creator - Title" /
 *     multiple " - " / unknown / folder-independence / manual preservation
 *   Recommendations: same creator / title-related / current-video exclusion /
 *     ownership
 *   Migration: fresh database / pre-existing data
 *   Sync: creator-less videos land in the user-scoped Unknown Creator
 *     grouping; "Watch Creator - Title" parses on import; manual preserved.
 */

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fsSync from 'node:fs';
import path from 'node:path';
import Database from 'better-sqlite3';
import { createTestDatabase } from './helpers/test-db';

const db = createTestDatabase('p2-foundation-unit');
process.env.DATABASE_URL = db.url;
process.env.VIDEOS_PER_PAGE = '5';
process.env.MEGA_SESSION_ENCRYPTION_KEY = 'ab'.repeat(32);

let prisma: typeof import('@/lib/db')['prisma'];
let personal: typeof import('@/lib/personal');
let recommendations: typeof import('@/lib/recommendations');
let creatorsLib: typeof import('@/lib/creators');
let titles: typeof import('@/lib/titles');
let MEGA_ACCOUNT_STATUSES: typeof import('@/lib/megaAccounts')['MEGA_ACCOUNT_STATUSES'];
let syncMegaAccount: typeof import('@/lib/sync/syncAccount')['syncMegaAccount'];

after(() => {
  db.close();
});

const PASSWORD_HASH =
  'pbkdf2:sha256:100000:00000000000000000000000000000000:000000000000000000000000000000000000000000000000000000000000000000';

async function makeUser(email: string) {
  return prisma.user.create({ data: { email, passwordHash: PASSWORD_HASH } });
}

async function makeAccount(userId: string, email: string, status: string) {
  return prisma.megaAccount.create({
    data: { userId, label: `Acc ${email}`, megaEmail: email, encryptedSession: 's', status },
  });
}

async function makeVideo(
  accountId: number | null,
  slug: string,
  title: string,
  opts?: { filename?: string; creatorId?: number | null; assignment?: string; createdAt?: Date },
) {
  return prisma.video.create({
    data: {
      megaAccountId: accountId,
      megaFilename: opts?.filename ?? `${title}.mp4`,
      title,
      slug,
      creatorId: opts?.creatorId ?? null,
      creatorAssignment: opts?.assignment ?? (opts?.creatorId ? 'auto' : 'none'),
      fileSize: BigInt(1000),
      mimeType: 'video/mp4',
    },
  });
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

let userA!: { id: string };
let userB!: { id: string };
let accA!: { id: number };
let accB!: { id: number };
let accADisc!: { id: number };

before(async () => {
  ({ prisma } = await import('@/lib/db'));
  personal = await import('@/lib/personal');
  recommendations = await import('@/lib/recommendations');
  creatorsLib = await import('@/lib/creators');
  titles = await import('@/lib/titles');
  ({ MEGA_ACCOUNT_STATUSES } = await import('@/lib/megaAccounts'));
  ({ syncMegaAccount } = await import('@/lib/sync/syncAccount'));

  userA = await makeUser('p2-a@example.com');
  userB = await makeUser('p2-b@example.com');
  accA = await makeAccount(userA.id, 'p2-a@mega.test', MEGA_ACCOUNT_STATUSES.SYNCED);
  accB = await makeAccount(userB.id, 'p2-b@mega.test', MEGA_ACCOUNT_STATUSES.SYNCED);
  accADisc = await makeAccount(userA.id, 'p2-a-old@mega.test', MEGA_ACCOUNT_STATUSES.DISCONNECTED);

  // Library seeds for A.
  await makeVideo(accA.id, 'p2-a1', 'Alpha Clip');
  await makeVideo(accA.id, 'p2-a2', 'Beta Clip');
  await makeVideo(accA.id, 'p2-a3', 'Gamma Clip');
  // B's private video (must stay invisible to A).
  await makeVideo(accB.id, 'p2-b1', 'Bee Secret Clip');
  // A's disconnected-account video (hidden everywhere).
  await makeVideo(accADisc.id, 'p2-disc1', 'Disconnected Clip');
});

async function videoIdBySlug(slug: string): Promise<number> {
  const v = await prisma.video.findUniqueOrThrow({ where: { slug }, select: { id: true } });
  return v.id;
}

// ---------------------------------------------------------------------------
// Watchlist
// ---------------------------------------------------------------------------

test('watchlist: add then list contains the video', async () => {
  const id = await videoIdBySlug('p2-a1');
  const added = await personal.addToWatchlist(userA.id, id);
  assert.ok(added);
  assert.equal(added.created, true);
  const list = await personal.listWatchlist(userA.id, 1);
  assert.ok(list.items.some((v) => v.slug === 'p2-a1'));
  assert.equal(await personal.isOnWatchlist(userA.id, id), true);
});

test('watchlist: duplicate add keeps a single row', async () => {
  const id = await videoIdBySlug('p2-a2');
  const first = await personal.addToWatchlist(userA.id, id);
  const second = await personal.addToWatchlist(userA.id, id);
  assert.equal(first?.created, true);
  assert.equal(second?.created, false);
  const count = await prisma.watchlistItem.count({ where: { userId: userA.id, videoId: id } });
  assert.equal(count, 1);
});

test('watchlist: remove deletes, second remove is false', async () => {
  const id = await videoIdBySlug('p2-a2');
  assert.equal(await personal.removeFromWatchlist(userA.id, id), true);
  assert.equal(await personal.isOnWatchlist(userA.id, id), false);
  assert.equal(await personal.removeFromWatchlist(userA.id, id), false);
});

test('watchlist: membership is false for never-added video', async () => {
  const id = await videoIdBySlug('p2-a3');
  assert.equal(await personal.isOnWatchlist(userA.id, id), false);
});

test('watchlist: isolation - cannot add/read/remove another user video', async () => {
  const bVideo = await videoIdBySlug('p2-b1');
  // A cannot add B's private video.
  assert.equal(await personal.addToWatchlist(userA.id, bVideo), null);
  assert.equal(await personal.isOnWatchlist(userA.id, bVideo), false);
  assert.equal(await personal.removeFromWatchlist(userA.id, bVideo), false);
  // B adds their own video; A still sees nothing of it.
  assert.ok(await personal.addToWatchlist(userB.id, bVideo));
  const listA = await personal.listWatchlist(userA.id, 1);
  assert.ok(!listA.items.some((v) => v.slug === 'p2-b1'));
  const listB = await personal.listWatchlist(userB.id, 1);
  assert.ok(listB.items.some((v) => v.slug === 'p2-b1'));
});

test('watchlist: adding a missing video returns null', async () => {
  assert.equal(await personal.addToWatchlist(userA.id, 987654321), null);
});

// ---------------------------------------------------------------------------
// Saved Videos
// ---------------------------------------------------------------------------

test('saved: save then list + membership', async () => {
  const id = await videoIdBySlug('p2-a1');
  const saved = await personal.saveVideo(userA.id, id);
  assert.ok(saved);
  assert.equal(saved.created, true);
  assert.equal(await personal.isVideoSaved(userA.id, id), true);
  const list = await personal.listSavedVideos(userA.id, 1);
  assert.ok(list.items.some((v) => v.slug === 'p2-a1'));
});

test('saved: duplicate save keeps a single row', async () => {
  const id = await videoIdBySlug('p2-a3');
  await personal.saveVideo(userA.id, id);
  const second = await personal.saveVideo(userA.id, id);
  assert.equal(second?.created, false);
  assert.equal(await prisma.savedVideo.count({ where: { userId: userA.id, videoId: id } }), 1);
});

test('saved: unsave deletes, second unsave is false', async () => {
  const id = await videoIdBySlug('p2-a3');
  assert.equal(await personal.unsaveVideo(userA.id, id), true);
  assert.equal(await personal.isVideoSaved(userA.id, id), false);
  assert.equal(await personal.unsaveVideo(userA.id, id), false);
});

test('saved: isolation across users', async () => {
  const bVideo = await videoIdBySlug('p2-b1');
  assert.equal(await personal.saveVideo(userA.id, bVideo), null);
  assert.equal(await personal.isVideoSaved(userA.id, bVideo), false);
  assert.equal(await personal.unsaveVideo(userA.id, bVideo), false);
  await personal.saveVideo(userB.id, bVideo);
  const listA = await personal.listSavedVideos(userA.id, 1);
  assert.ok(!listA.items.some((v) => v.slug === 'p2-b1'));
});

// ---------------------------------------------------------------------------
// History
// ---------------------------------------------------------------------------

test('history: record creates an entry', async () => {
  const id = await videoIdBySlug('p2-a1');
  const rec = await personal.recordWatch(userA.id, id);
  assert.ok(rec);
  const list = await personal.listHistory(userA.id, 1);
  assert.ok(list.items.some((v) => v.slug === 'p2-a1'));
});

test('history: re-watch updates lastWatchedAt without duplicating', async () => {
  const u = await makeUser('p2-hist@example.com');
  const acc = await makeAccount(u.id, 'p2-hist@mega.test', MEGA_ACCOUNT_STATUSES.SYNCED);
  const v = await makeVideo(acc.id, 'p2-h1', 'Hist Clip');
  const first = await personal.recordWatch(u.id, v.id);
  await sleep(20);
  const second = await personal.recordWatch(u.id, v.id);
  assert.ok(first && second);
  assert.ok(second.lastWatchedAt >= first.lastWatchedAt);
  assert.equal(await prisma.watchHistory.count({ where: { userId: u.id } }), 1);
});

test('history: chronological order, re-watch moves to front', async () => {
  const u = await makeUser('p2-hist2@example.com');
  const acc = await makeAccount(u.id, 'p2-hist2@mega.test', MEGA_ACCOUNT_STATUSES.SYNCED);
  const v1 = await makeVideo(acc.id, 'p2-h2a', 'Hist Two Alpha');
  const v2 = await makeVideo(acc.id, 'p2-h2b', 'Hist Two Beta');
  await personal.recordWatch(u.id, v1.id);
  await sleep(20);
  await personal.recordWatch(u.id, v2.id);
  let list = await personal.listHistory(u.id, 1);
  assert.deepEqual(list.items.map((v) => v.slug), ['p2-h2b', 'p2-h2a']);
  await sleep(20);
  await personal.recordWatch(u.id, v1.id);
  list = await personal.listHistory(u.id, 1);
  assert.deepEqual(list.items.map((v) => v.slug), ['p2-h2a', 'p2-h2b']);
});

test('history: remove one entry', async () => {
  const u = await makeUser('p2-hist3@example.com');
  const acc = await makeAccount(u.id, 'p2-hist3@mega.test', MEGA_ACCOUNT_STATUSES.SYNCED);
  const v1 = await makeVideo(acc.id, 'p2-h3a', 'Hist Three Alpha');
  const v2 = await makeVideo(acc.id, 'p2-h3b', 'Hist Three Beta');
  await personal.recordWatch(u.id, v1.id);
  await personal.recordWatch(u.id, v2.id);
  assert.equal(await personal.removeHistoryItem(u.id, v1.id), true);
  assert.equal(await personal.removeHistoryItem(u.id, v1.id), false);
  const list = await personal.listHistory(u.id, 1);
  assert.deepEqual(list.items.map((v) => v.slug), ['p2-h3b']);
});

test('history: clear removes everything and reports the count', async () => {
  const u = await makeUser('p2-hist4@example.com');
  const acc = await makeAccount(u.id, 'p2-hist4@mega.test', MEGA_ACCOUNT_STATUSES.SYNCED);
  const v1 = await makeVideo(acc.id, 'p2-h4a', 'Hist Four Alpha');
  const v2 = await makeVideo(acc.id, 'p2-h4b', 'Hist Four Beta');
  await personal.recordWatch(u.id, v1.id);
  await personal.recordWatch(u.id, v2.id);
  assert.equal(await personal.clearHistory(u.id), 2);
  const list = await personal.listHistory(u.id, 1);
  assert.equal(list.total, 0);
  assert.deepEqual(list.items, []);
  assert.equal(await personal.clearHistory(u.id), 0);
});

test('history: isolation - cannot record or read another user history', async () => {
  const bVideo = await videoIdBySlug('p2-b1');
  assert.equal(await personal.recordWatch(userA.id, bVideo), null);
  await personal.recordWatch(userB.id, bVideo);
  const listA = await personal.listHistory(userA.id, 1);
  assert.ok(!listA.items.some((v) => v.slug === 'p2-b1'));
  // A cannot delete B's history entry.
  assert.equal(await personal.removeHistoryItem(userA.id, bVideo), false);
  assert.equal(await prisma.watchHistory.count({ where: { userId: userB.id, videoId: bVideo } }), 1);
});

// ---------------------------------------------------------------------------
// New Videos
// ---------------------------------------------------------------------------

test('new videos: newest first by entered-library time', async () => {
  const u = await makeUser('p2-new@example.com');
  const acc = await makeAccount(u.id, 'p2-new@mega.test', MEGA_ACCOUNT_STATUSES.SYNCED);
  const base = Date.now();
  await makeVideo(acc.id, 'p2-n-old', 'New Old Clip', { createdAt: new Date(base - 3000) });
  await makeVideo(acc.id, 'p2-n-mid', 'New Mid Clip', { createdAt: new Date(base - 2000) });
  await makeVideo(acc.id, 'p2-n-new', 'New Fresh Clip', { createdAt: new Date(base - 1000) });
  const r = await personal.listNewVideosForUser(u.id, 1);
  assert.deepEqual(r.items.map((v) => v.slug), ['p2-n-new', 'p2-n-mid', 'p2-n-old']);
});

test('new videos: paginated and user-scoped', async () => {
  const u = await makeUser('p2-newpage@example.com');
  const acc = await makeAccount(u.id, 'p2-newpage@mega.test', MEGA_ACCOUNT_STATUSES.SYNCED);
  const base = Date.now();
  for (let i = 0; i < 7; i++) {
    await makeVideo(acc.id, `p2-np-${i}`, `New Page Clip ${i}`, { createdAt: new Date(base - i * 1000) });
  }
  // VIDEOS_PER_PAGE=5 for this suite.
  const p1 = await personal.listNewVideosForUser(u.id, 1);
  const p2 = await personal.listNewVideosForUser(u.id, 2);
  assert.equal(p1.total, 7);
  assert.equal(p1.items.length, 5);
  assert.equal(p2.items.length, 2);
  assert.equal(p1.totalPages, 2);
  // No overlap between pages.
  const overlap = p1.items.filter((v) => p2.items.some((w) => w.id === v.id));
  assert.equal(overlap.length, 0);
  // Other users' videos never appear.
  assert.ok(!p1.items.some((v) => v.slug === 'p2-b1'));
  assert.ok(!p2.items.some((v) => v.slug === 'p2-b1'));
  // Disconnected-account videos never appear.
  const disc = await personal.listNewVideosForUser(userA.id, 1);
  assert.ok(!disc.items.some((v) => v.slug === 'p2-disc1'));
});

// ---------------------------------------------------------------------------
// Creator / title parsing
// ---------------------------------------------------------------------------

test('parsing: "Creator - Title" assigns creator and title', () => {
  const { creator, title } = titles.parseVideoMetadata('Kristie Bish - Extra Credit.mp4');
  assert.equal(creator, 'Kristie Bish');
  assert.equal(title, 'Extra Credit');
});

test('parsing: "Watch Creator - Title" strips the Watch prefix', () => {
  const { creator, title } = titles.parseVideoMetadata('Watch Kristie Bish - Extra Credit.mp4');
  assert.equal(creator, 'Kristie Bish');
  assert.equal(title, 'Extra Credit');
});

test('parsing: additional " - " stays in the title', () => {
  const { creator, title } = titles.parseVideoMetadata('Creator - Video - Extended Version.mp4');
  assert.equal(creator, 'Creator');
  assert.equal(title, 'Video - Extended Version');
});

test('parsing: no delimiter means unknown creator, full title kept', () => {
  const { creator, title } = titles.parseVideoMetadata('Just Some Clip.mp4');
  assert.equal(creator, null);
  assert.equal(title, 'Just Some Clip');
});

test('parsing: folder names never determine the creator', () => {
  const a = titles.parseVideoMetadata('/Some Folder/Kristie Bish - Extra Credit.mp4');
  const b = titles.parseVideoMetadata('Kristie Bish - Extra Credit.mp4');
  assert.deepEqual(a, b);
  const c = titles.parseVideoMetadata('/Random/Nested/Folder/Watch Kristie Bish - Extra Credit.mp4');
  assert.equal(c.creator, 'Kristie Bish');
  assert.equal(c.title, 'Extra Credit');
});

test('parsing: "Watchful" names and Watch-titled clips are not mangled', () => {
  const a = titles.parseVideoMetadata('Watchful Eyes - Night Show.mp4');
  assert.equal(a.creator, 'Watchful Eyes');
  assert.equal(a.title, 'Night Show');
  const b = titles.parseVideoMetadata('Watch Me Dance.mp4');
  assert.equal(b.creator, null);
  assert.equal(b.title, 'Watch Me Dance');
});

// ---------------------------------------------------------------------------
// Unknown Creator grouping + safe reconciliation
// ---------------------------------------------------------------------------

test('unknown creator: one grouping per user, reused across videos', async () => {
  const u = await makeUser('p2-unknown@example.com');
  const first = await creatorsLib.ensureUnknownCreatorForUser(u.id);
  const second = await creatorsLib.ensureUnknownCreatorForUser(u.id);
  assert.equal(first, second);
  assert.equal(await prisma.creator.count({ where: { userId: u.id, name: 'Unknown Creator' } }), 1);
});

test('reconcile: assigns creators, groups unknowns, never touches manual', async () => {
  const u = await makeUser('p2-recon@example.com');
  const acc = await makeAccount(u.id, 'p2-recon@mega.test', MEGA_ACCOUNT_STATUSES.SYNCED);
  await makeVideo(acc.id, 'p2-r-a', 'Video A', { filename: 'Watch Nova Star - Video A.mp4' });
  await makeVideo(acc.id, 'p2-r-b', 'Video B', { filename: 'Nova Star - Video B.mp4' });
  await makeVideo(acc.id, 'p2-r-c', 'Mystery Clip', { filename: 'Mystery Clip.mp4' });
  const other = await prisma.creator.create({
    data: { userId: u.id, name: 'Hand Picked', slug: 'hand-picked' },
  });
  await makeVideo(acc.id, 'p2-r-man', 'Manual Clip', {
    filename: 'Nova Star - Manual Clip.mp4',
    creatorId: other.id,
    assignment: 'manual',
  });

  const dry = await creatorsLib.reconcileCreatorsForUser(u.id, { dryRun: true });
  assert.equal(dry.scanned, 4);
  assert.equal(dry.manualSkipped, 1);
  assert.equal(dry.updated, 3);
  // Dry run writes nothing.
  const before = await prisma.video.findUniqueOrThrow({ where: { slug: 'p2-r-a' } });
  assert.equal(before.creatorId, null);

  const done = await creatorsLib.reconcileCreatorsForUser(u.id);
  assert.equal(done.updated, 3);
  assert.equal(done.manualSkipped, 1);

  const va = await prisma.video.findUniqueOrThrow({ where: { slug: 'p2-r-a' }, include: { creator: true } });
  const vb = await prisma.video.findUniqueOrThrow({ where: { slug: 'p2-r-b' }, include: { creator: true } });
  const vc = await prisma.video.findUniqueOrThrow({ where: { slug: 'p2-r-c' }, include: { creator: true } });
  const vm = await prisma.video.findUniqueOrThrow({ where: { slug: 'p2-r-man' }, include: { creator: true } });
  assert.equal(va.creator?.name, 'Nova Star');
  assert.equal(vb.creator?.name, 'Nova Star');
  assert.equal(va.creatorId, vb.creatorId);
  assert.equal(va.creatorAssignment, 'auto');
  assert.equal(vc.creator?.name, 'Unknown Creator');
  assert.equal(vm.creator?.name, 'Hand Picked');
  assert.equal(vm.creatorAssignment, 'manual');
});

// ---------------------------------------------------------------------------
// Recommendation primitives
// ---------------------------------------------------------------------------

test('recommendations: same creator, current video excluded', async () => {
  const u = await makeUser('p2-rec@example.com');
  const acc = await makeAccount(u.id, 'p2-rec@mega.test', MEGA_ACCOUNT_STATUSES.SYNCED);
  const star = await prisma.creator.create({ data: { userId: u.id, name: 'Rec Star', slug: 'rec-star' } });
  const v1 = await makeVideo(acc.id, 'p2-rec-1', 'Rec One', { creatorId: star.id, assignment: 'auto' });
  await makeVideo(acc.id, 'p2-rec-2', 'Rec Two', { creatorId: star.id, assignment: 'auto' });
  await makeVideo(acc.id, 'p2-rec-3', 'Unrelated Solo', { filename: 'Unrelated Solo.mp4' });
  const same = await recommendations.getSameCreatorVideos(u.id, v1.id, 10);
  assert.ok(same.some((v) => v.slug === 'p2-rec-2'));
  assert.ok(!same.some((v) => v.id === v1.id));
  assert.ok(!same.some((v) => v.slug === 'p2-rec-3'));
});

test('recommendations: title-related finds title matches, excludes current', async () => {
  const u = await makeUser('p2-rect@example.com');
  const acc = await makeAccount(u.id, 'p2-rect@mega.test', MEGA_ACCOUNT_STATUSES.SYNCED);
  const v1 = await makeVideo(acc.id, 'p2-rect-1', 'Galaxy Tour Documentary');
  await makeVideo(acc.id, 'p2-rect-2', 'Galaxy Tour Documentary Directors Cut');
  await makeVideo(acc.id, 'p2-rect-3', 'Cooking With Fire');
  const related = await recommendations.getTitleRelatedVideos(u.id, 'Galaxy Tour Documentary', {
    excludeVideoIds: [v1.id],
    limit: 10,
  });
  assert.ok(related.some((v) => v.slug === 'p2-rect-2'));
  assert.ok(!related.some((v) => v.id === v1.id));
  assert.ok(!related.some((v) => v.slug === 'p2-rect-3'));
});

test('recommendations: related puts same creator first and is user-scoped', async () => {
  const u = await makeUser('p2-rel@example.com');
  const acc = await makeAccount(u.id, 'p2-rel@mega.test', MEGA_ACCOUNT_STATUSES.SYNCED);
  const star = await prisma.creator.create({ data: { userId: u.id, name: 'Rel Star', slug: 'rel-star' } });
  const v1 = await makeVideo(acc.id, 'p2-rel-1', 'Rel Zebra Alpha', { creatorId: star.id, assignment: 'auto' });
  await makeVideo(acc.id, 'p2-rel-2', 'Rel Zebra Beta', { creatorId: star.id, assignment: 'auto' });
  await makeVideo(acc.id, 'p2-rel-3', 'Rel Zebra Gamma Solo');
  const related = await recommendations.getRelatedVideos(u.id, v1.id, 5);
  assert.ok(related.length > 0);
  assert.equal(related[0].slug, 'p2-rel-2', 'same-creator video comes first');
  assert.ok(!related.some((v) => v.id === v1.id));
  // Another user asking about this video gets nothing (not their library).
  assert.deepEqual(await recommendations.getRelatedVideos(userB.id, v1.id, 5), []);
  assert.deepEqual(await recommendations.getSameCreatorVideos(userB.id, v1.id, 5), []);
});

test('recommendations: history-related uses watched creators, empty stays empty', async () => {
  const u = await makeUser('p2-hrel@example.com');
  const acc = await makeAccount(u.id, 'p2-hrel@mega.test', MEGA_ACCOUNT_STATUSES.SYNCED);
  const star = await prisma.creator.create({ data: { userId: u.id, name: 'Hrel Star', slug: 'hrel-star' } });
  const watched = await makeVideo(acc.id, 'p2-hrel-1', 'Hrel Watched', { creatorId: star.id, assignment: 'auto' });
  await makeVideo(acc.id, 'p2-hrel-2', 'Hrel Unwatched Sibling', { creatorId: star.id, assignment: 'auto' });
  await makeVideo(acc.id, 'p2-hrel-3', 'Hrel Other Topic');
  assert.deepEqual(await recommendations.getHistoryRelatedVideos(u.id, 5), []);
  await personal.recordWatch(u.id, watched.id);
  const related = await recommendations.getHistoryRelatedVideos(u.id, 5);
  assert.ok(related.some((v) => v.slug === 'p2-hrel-2'));
  assert.ok(!related.some((v) => v.id === watched.id));
});

// ---------------------------------------------------------------------------
// Sync: Unknown Creator grouping + Watch-prefix parsing on import
// ---------------------------------------------------------------------------

test('sync: creator-less videos group under Unknown Creator, Watch parsed, manual kept', async () => {
  const u = await makeUser('p2-sync@example.com');
  const acc = await makeAccount(u.id, 'p2-sync@mega.test', MEGA_ACCOUNT_STATUSES.CONNECTED);
  const nodes = [
    { h: 'p2s1', p: 'folder1', t: 0, ts: 1_700_000_000, s: 1234, name: 'Just A Clip.mp4', fa: null, fileKey: null },
    { h: 'p2s2', p: 'folder1', t: 0, ts: 1_700_000_000, s: 1234, name: 'Watch Nova Star - Debut Clip.mp4', fa: null, fileKey: null },
  ];
  const fakeStorage = { key: Buffer.alloc(16, 3), user: 'Uowner', api: { request: async () => null } };
  const deps = {
    withMegaSession: async (_id: number, _sess: string, fn: (s: unknown) => Promise<unknown>) => fn(fakeStorage),
    fetchAccountFileNodes: async () => nodes,
  };
  const result = await syncMegaAccount(acc.id, deps as never);
  assert.ok(result);
  assert.equal(result.added, 2);

  const v1 = await prisma.video.findFirstOrThrow({ where: { megaNodeId: 'p2s1' }, include: { creator: true } });
  const v2 = await prisma.video.findFirstOrThrow({ where: { megaNodeId: 'p2s2' }, include: { creator: true } });
  assert.equal(v1.creator?.name, 'Unknown Creator');
  assert.equal(v1.creatorAssignment, 'auto');
  assert.equal(v2.creator?.name, 'Nova Star');
  assert.equal(v2.title, 'Debut Clip');
  assert.equal(v2.creatorAssignment, 'auto');
  assert.equal(await prisma.creator.count({ where: { userId: u.id, name: 'Unknown Creator' } }), 1);
});

// ---------------------------------------------------------------------------
// Migration safety: fresh database + pre-existing data
// ---------------------------------------------------------------------------

test('migration: fresh database contains the P2 tables with unique guards', async () => {
  const file = path.join(path.resolve(process.cwd(), 'data/test'), 'p2-foundation-unit.db');
  const check = new Database(file, { readonly: true });
  try {
    for (const table of ['WatchlistItem', 'SavedVideo', 'WatchHistory']) {
      const t = check.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name=?").get(table) as unknown;
      assert.ok(t, `${table} table must exist`);
    }
    for (const idx of ['WatchlistItem_userId_videoId_key', 'SavedVideo_userId_videoId_key', 'WatchHistory_userId_videoId_key']) {
      const i = check.prepare("SELECT name FROM sqlite_master WHERE type='index' AND name=?").get(idx) as unknown;
      assert.ok(i, `${idx} unique index must exist`);
    }
  } finally {
    check.close();
  }
});

test('migration: applies over pre-P2 data without losing rows', async () => {
  const dir = path.resolve(process.cwd(), 'prisma/migrations');
  const all = fsSync.readdirSync(dir).filter((d: string) => /^\d{14}_/.test(d)).sort();
  const target = '20260912020000_p2_product_foundation';
  assert.ok(all.includes(target));
  const file = path.join(path.resolve(process.cwd(), 'data/test'), 'p2-migrate-existing.db');
  try {
    fsSync.rmSync(file, { force: true });
  } catch { /* not present */ }
  const raw = new Database(file);
  try {
    for (const m of all) {
      if (m === target) break;
      raw.exec(fsSync.readFileSync(path.join(dir, m, 'migration.sql'), 'utf8'));
    }
    raw.prepare(`INSERT INTO "User" ("id","email","passwordHash","createdAt","updatedAt") VALUES (?,?,?,?,?)`).run(
      'legacy-user', 'legacy@example.com', 'hash', '2026-01-01 00:00:00', '2026-01-01 00:00:00',
    );
    raw.prepare(
      `INSERT INTO "MegaAccount" ("userId","label","megaEmail","encryptedSession","status","createdAt","updatedAt") VALUES (?,?,?,?,?,?,?)`,
    ).run('legacy-user', 'Acc', 'legacy@mega.test', 's', 'CONNECTED', '2026-01-01 00:00:00', '2026-01-01 00:00:00');
    const legacyAcc = (raw.prepare('SELECT last_insert_rowid() AS id').get() as { id: number }).id;
    raw.prepare(
      `INSERT INTO "Video" ("megaFilename","title","slug","megaAccountId","fileSize","createdAt","updatedAt") VALUES (?,?,?,?,?,?,?)`,
    ).run('Watch Legacy Star - Old Clip.mp4', 'Old Clip', 'legacy-clip', legacyAcc, 1000, '2026-01-02 00:00:00', '2026-01-02 00:00:00');
    raw.exec(fsSync.readFileSync(path.join(dir, target, 'migration.sql'), 'utf8'));
    const video = raw.prepare('SELECT id, title, slug FROM "Video" WHERE slug=?').get('legacy-clip') as { id: number; title: string } | undefined;
    assert.ok(video, 'pre-existing video row must survive the migration');
    assert.equal(video.title, 'Old Clip');
    // New tables accept rows for the legacy user/video (FK integrity).
    raw.prepare(`INSERT INTO "WatchHistory" ("userId","videoId","lastWatchedAt","createdAt") VALUES (?,?,?,?)`).run(
      'legacy-user', video.id, '2026-01-03 00:00:00', '2026-01-03 00:00:00',
    );
    const hist = raw.prepare('SELECT COUNT(*) AS n FROM "WatchHistory"').get() as { n: number };
    assert.equal(hist.n, 1);
  } finally {
    raw.close();
  }
  try {
    fsSync.rmSync(file, { force: true });
  } catch { /* cleanup */ }
});
