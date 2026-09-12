/**
 * P2.3 thumbnail tests: brightness arbiter, candidate strategy, frame
 * picking, persistence, idempotent repair, failure containment, ownership.
 *
 * Image fixtures are hand-written 24-bit BMPs (no binaries committed);
 * ffmpeg decode paths run only when the binary exists, otherwise skipped.
 */

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { createTestDatabase } from './helpers/test-db';

const db = createTestDatabase('p2-thumbs-unit');
process.env.DATABASE_URL = db.url;
process.env.MEGA_SESSION_ENCRYPTION_KEY = 'ab'.repeat(32);

let prisma: typeof import('@/lib/db')['prisma'];
let repair: typeof import('@/lib/thumbs/repair');
let MEGA_ACCOUNT_STATUSES: typeof import('@/lib/megaAccounts')['MEGA_ACCOUNT_STATUSES'];

const hasFfmpeg = (() => {
  try {
    execFileSync(process.env.FFMPEG_BIN ?? 'ffmpeg', ['-version'], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
})();

/** Minimal 24-bit BMP writer (BGR, bottom-up, row-padded to 4 bytes). */
function bmp(width: number, height: number, px: (x: number, y: number) => [number, number, number]): Buffer {
  const rowLen = Math.ceil((width * 3) / 4) * 4;
  const data = Buffer.alloc(rowLen * height, 0);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const [r, g, b] = px(x, y);
      const off = (height - 1 - y) * rowLen + x * 3;
      data[off] = b;
      data[off + 1] = g;
      data[off + 2] = r;
    }
  }
  const header = Buffer.alloc(54, 0);
  header.write('BM', 0);
  header.writeUInt32LE(54 + data.length, 2);
  header.writeUInt32LE(54, 10);
  header.writeUInt32LE(40, 14);
  header.writeInt32LE(width, 18);
  header.writeInt32LE(height, 22);
  header.writeUInt16LE(1, 26);
  header.writeUInt16LE(24, 28);
  header.writeUInt32LE(data.length, 34);
  return Buffer.concat([header, data]);
}

let tmpRoot = '';
let thumbsTmp = '';

before(async () => {
  ({ prisma } = await import('@/lib/db'));
  repair = await import('@/lib/thumbs/repair');
  ({ MEGA_ACCOUNT_STATUSES } = await import('@/lib/megaAccounts'));
  tmpRoot = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'p2-thumbs-'));
  thumbsTmp = path.join(tmpRoot, 'thumbs');
  await fs.promises.mkdir(thumbsTmp, { recursive: true });
  repair.__setThumbsDirForTests(thumbsTmp);
});

after(() => {
  repair.__setThumbsDirForTests(null);
  repair.__setExtractFrameForTests(null);
  repair.__setExtractBestForTests(null);
  db.close();
  fs.rmSync(tmpRoot, { recursive: true, force: true });
});

// ------------------------------------------------------- pure logic -------

test('meanBrightness: black ~0, white ~255, gray mid', () => {
  assert.ok(repair.meanBrightness(Buffer.from([0, 0, 0, 0, 0, 0])) < 1);
  assert.ok(repair.meanBrightness(Buffer.from([255, 255, 255, 255])) > 254);
  const gray = repair.meanBrightness(Buffer.from([128, 128, 128, 128]));
  assert.ok(gray > 120 && gray < 136, `gray=${gray}`);
  assert.equal(repair.meanBrightness(Buffer.alloc(0)), -1);
});

test('isUsableBrightness honors the floor', () => {
  assert.equal(repair.isUsableBrightness(null), false);
  assert.equal(repair.isUsableBrightness(0), false);
  assert.equal(repair.isUsableBrightness(repair.THUMB_BRIGHTNESS_MIN - 0.5), false);
  assert.equal(repair.isUsableBrightness(repair.THUMB_BRIGHTNESS_MIN), true);
  assert.equal(repair.isUsableBrightness(200), true);
});

test('candidateSeeks: fractions of known duration', () => {
  assert.deepEqual(repair.candidateSeeks(1000), [50, 250, 500, 750, 998]);
  assert.deepEqual(repair.candidateSeeks(100), [5, 25, 50, 75, 98]);
});

test('candidateSeeks: unknown/short duration falls back to a small ladder', () => {
  assert.deepEqual(repair.candidateSeeks(null), [2, 10, 30, 60, 180]);
  assert.deepEqual(repair.candidateSeeks(0), [2, 10, 30, 60, 180]);
  assert.deepEqual(repair.candidateSeeks(3), [2, 10, 30, 60, 180]);
  const tiny = repair.candidateSeeks(10);
  assert.ok(tiny.length <= 5 && tiny.every((t) => t >= 1));
});

test('pickFrame: brightest usable wins; else brightest; else -1', () => {
  assert.equal(repair.pickFrame([{ seek: 1, brightness: 50 }, { seek: 2, brightness: 200 }, { seek: 3, brightness: 150 }]), 1);
  assert.equal(repair.pickFrame([{ seek: 1, brightness: 3 }, { seek: 2, brightness: 200 }, { seek: 3, brightness: 150 }]), 1);
  assert.equal(repair.pickFrame([{ seek: 1, brightness: 2 }, { seek: 2, brightness: 9 }, { seek: 3, brightness: 5 }]), 1);
  assert.equal(repair.pickFrame([{ seek: 1, brightness: null }, { seek: 2, brightness: null }]), -1);
  assert.equal(repair.pickFrame([]), -1);
});

// ------------------------------------------------- ffmpeg decode paths ----

test('thumbMeanBrightness: black vs white BMP fixtures', { skip: !hasFfmpeg }, async () => {
  const black = path.join(tmpRoot, 'black.bmp');
  const white = path.join(tmpRoot, 'white.bmp');
  await fs.promises.writeFile(black, bmp(8, 8, () => [0, 0, 0]));
  await fs.promises.writeFile(white, bmp(8, 8, () => [255, 255, 255]));
  const bMean = await repair.thumbMeanBrightness(black);
  const wMean = await repair.thumbMeanBrightness(white);
  assert.ok(bMean !== null && bMean < 1, `black=${bMean}`);
  assert.ok(wMean !== null && wMean > 250, `white=${wMean}`);
  assert.equal(await repair.existingThumbPath(999999), null);
});

test('thumbMeanBrightness: missing/empty/corrupt files read as null', { skip: !hasFfmpeg }, async () => {
  assert.equal(await repair.thumbMeanBrightness(path.join(tmpRoot, 'nope.png')), null);
  const empty = path.join(tmpRoot, 'empty.png');
  await fs.promises.writeFile(empty, Buffer.alloc(0));
  assert.equal(await repair.thumbMeanBrightness(empty), null);
  const corrupt = path.join(tmpRoot, 'corrupt.jpg');
  await fs.promises.writeFile(corrupt, Buffer.from([1, 2, 3, 4, 5, 6, 7, 8]));
  assert.equal(await repair.thumbMeanBrightness(corrupt), null);
});

// ------------------------------------------------- repair orchestration ---

const PASSWORD_HASH = 'pbkdf2:sha256:100000:00000000000000000000000000000000:000000000000000000000000000000000000000000000000000000000000000000';

async function makeUser(email: string) {
  return prisma.user.create({ data: { email, passwordHash: PASSWORD_HASH } });
}

async function makeVideo(userId: string, slug: string, withKey: boolean) {
  const { encryptSecret } = await import('@/lib/mega/envelope');
  const acc = await prisma.megaAccount.create({
    data: { userId, label: 'Acc', megaEmail: `${slug}@mega.test`, encryptedSession: 's', status: MEGA_ACCOUNT_STATUSES.SYNCED },
  });
  return prisma.video.create({
    data: {
      megaAccountId: acc.id,
      megaNodeId: `node-${slug}`,
      megaFilename: `${slug}.mp4`,
      title: slug,
      slug,
      creatorAssignment: 'none',
      fileSize: BigInt(1000),
      mimeType: 'video/mp4',
      duration: 100,
      fileKeyEncrypted: withKey ? encryptSecret(Buffer.alloc(32, 7)) : null,
    },
  });
}

const fakeDeps = {
  fetchCiphertext: async () => new Response(Buffer.alloc(64)),
  withSession: async (_id: number, _sess: string, fn: (s: never) => Promise<unknown>) =>
    fn(undefined as never),
  getUrl: async () => ({ url: 'http://thumb.test/x', size: 1000 }),
} as never;

test('repair: extraction failure returns failed, touches nothing', async () => {
  const u = await makeUser('thumb-fail@example.com');
  const v = await makeVideo(u.id, 'thumb-fail-v', true);
  repair.__setExtractFrameForTests(async () => false);
  try {
    const r = await repair.repairVideoThumbnail(u.id, v.id, { deps: fakeDeps as never });
    assert.equal(r.status, 'failed');
    const after = await prisma.video.findUniqueOrThrow({ where: { id: v.id } });
    assert.equal(after.thumbnail, null);
  } finally {
    repair.__setExtractBestForTests(null);
  }
});

test('repair: other-user video is not-found (ownership)', async () => {
  const a = await makeUser('thumb-own-a@example.com');
  const b = await makeUser('thumb-own-b@example.com');
  const v = await makeVideo(a.id, 'thumb-own-v', true);
  const r = await repair.repairVideoThumbnail(b.id, v.id, { deps: fakeDeps as never });
  assert.equal(r.status, 'not-found');
});

test('repair: video without playback key is not-found', async () => {
  const u = await makeUser('thumb-nokey@example.com');
  const v = await makeVideo(u.id, 'thumb-nokey-v', false);
  const r = await repair.repairVideoThumbnail(u.id, v.id, { deps: fakeDeps as never });
  assert.equal(r.status, 'not-found');
});

test('repair: stores frame, updates DB, second run skips good', { skip: !hasFfmpeg }, async () => {
  const u = await makeUser('thumb-ok@example.com');
  const v = await makeVideo(u.id, 'thumb-ok-v', true);
  const brightBmp = path.join(tmpRoot, 'bright.bmp');
  await fs.promises.writeFile(brightBmp, bmp(16, 16, () => [200, 180, 160]));
  const brightMean = await repair.thumbMeanBrightness(brightBmp);
  assert.ok(brightMean !== null && brightMean >= repair.THUMB_BRIGHTNESS_MIN);
  // Bypass the MEGA download layer (covered by failure-path tests and
  // real-video validation); the fake still produces a real decodable file
  // so persistence + brightness checks run for real.
  repair.__setExtractBestForTests(async (_src: unknown, _dir: string) => ({
    jpg: brightBmp,
    seek: 10,
    brightness: brightMean as number,
  }) as never);
  try {
    const r = await repair.repairVideoThumbnail(u.id, v.id, { deps: fakeDeps as never });
    assert.equal(r.status, 'repaired');
    assert.ok((r.brightness ?? 0) >= repair.THUMB_BRIGHTNESS_MIN, `brightness=${r.brightness}`);
    const stored = path.join(thumbsTmp, `${v.id}.jpg`);
    assert.ok(fs.existsSync(stored), 'frame persisted to thumbs dir');
    assert.ok((await repair.thumbMeanBrightness(stored))! >= repair.THUMB_BRIGHTNESS_MIN);
    const after = await prisma.video.findUniqueOrThrow({ where: { id: v.id } });
    assert.equal(after.thumbnail, `/api/media/thumbs/${v.id}`);

    // Idempotent: a good stored thumbnail is skipped, never rewritten.
    repair.__setExtractBestForTests(async () => {
      throw new Error('must not be called for a good thumbnail');
    });
    const r2 = await repair.repairVideoThumbnail(u.id, v.id, { deps: fakeDeps as never });
    assert.equal(r2.status, 'skipped-good');
  } finally {
    repair.__setExtractBestForTests(null);
  }
});

test('repairUserThumbnails: summarizes mixed states, user-scoped', { skip: !hasFfmpeg }, async () => {
  const u = await makeUser('thumb-batch@example.com');
  const other = await makeUser('thumb-batch-other@example.com');
  const good = await makeVideo(u.id, 'thumb-batch-good', true);
  await fs.promises.writeFile(path.join(thumbsTmp, `${good.id}.jpg`), bmp(16, 16, () => [210, 210, 210]));
  await makeVideo(u.id, 'thumb-batch-bad', true);
  const batchBmp = path.join(tmpRoot, 'batch-bright.bmp');
  await fs.promises.writeFile(batchBmp, bmp(16, 16, () => [190, 190, 190]));
  repair.__setExtractBestForTests(async () => ({
    jpg: batchBmp,
    seek: 5,
    brightness: 190,
  }) as never);
  try {
    const summary = await repair.repairUserThumbnails(u.id, { deps: fakeDeps as never });
    assert.equal(summary.scanned, 2);
    assert.equal(summary.skippedGood, 1);
    assert.equal(summary.repaired, 1);
    assert.equal(summary.failed, 0);
    // Other user's videos never appear even when explicitly listed.
    const otherVideo = await makeVideo(other.id, 'thumb-batch-ov', true);
    const summary2 = await repair.repairUserThumbnails(u.id, { videoIds: [otherVideo.id], deps: fakeDeps as never });
    assert.equal(summary2.scanned, 0);
  } finally {
    repair.__setExtractBestForTests(null);
  }
});

// ------------------------------------------------- mutex + post-sync ------

test('repair mutex: only one owner at a time, only the owner releases', () => {
  assert.equal(repair.tryBeginRepair('mutex-a'), true);
  assert.equal(repair.tryBeginRepair('mutex-b'), false);
  repair.endRepair('mutex-b'); // wrong owner: slot stays held
  assert.equal(repair.tryBeginRepair('mutex-c'), false);
  repair.endRepair('mutex-a');
  assert.equal(repair.tryBeginRepair('mutex-c'), true);
  repair.endRepair('mutex-c');
  assert.equal(repair.tryBeginRepair('mutex-d'), true);
  repair.endRepair('mutex-d');
});

test('schedulePostSyncRepair: empty/invalid ids schedule nothing', async () => {
  repair.__clearPostSyncForTests();
  repair.schedulePostSyncRepair('nobody', []);
  repair.schedulePostSyncRepair('nobody', [-1, 0, Number.NaN]);
  repair.schedulePostSyncRepair('', [123]);
  await new Promise((r) => setTimeout(r, 60));
  // Nothing was queued, so the slot is still free.
  assert.equal(repair.tryBeginRepair('mutex-probe'), true);
  repair.endRepair('mutex-probe');
  repair.__clearPostSyncForTests();
});

test('schedulePostSyncRepair: background run repairs only queued ids', { skip: !hasFfmpeg }, async () => {
  repair.__clearPostSyncForTests();
  const u = await makeUser('thumb-postsync@example.com');
  const queued = await makeVideo(u.id, 'thumb-ps-queued', true);
  const unqueued = await makeVideo(u.id, 'thumb-ps-unqueued', true);
  const brightBmp = path.join(tmpRoot, 'ps-bright.bmp');
  await fs.promises.writeFile(brightBmp, bmp(16, 16, () => [200, 200, 200]));
  repair.__setExtractBestForTests(async () => ({
    jpg: brightBmp,
    seek: 5,
    brightness: 200,
  }) as never);
  try {
    repair.schedulePostSyncRepair(u.id, [queued.id], { delayMs: 10 });
    let done = false;
    const start = Date.now();
    while (Date.now() - start < 10_000) {
      const row = await prisma.video.findUniqueOrThrow({ where: { id: queued.id } });
      if (row.thumbnail) {
        done = true;
        break;
      }
      await new Promise((r) => setTimeout(r, 50));
    }
    assert.ok(done, 'background repair stored a thumbnail for the queued video');
    const stored = path.join(thumbsTmp, `${queued.id}.jpg`);
    assert.ok(fs.existsSync(stored), 'frame persisted to thumbs dir');
    const other = await prisma.video.findUniqueOrThrow({ where: { id: unqueued.id } });
    assert.equal(other.thumbnail, null, 'unqueued video untouched');
  } finally {
    repair.__setExtractBestForTests(null);
    repair.__clearPostSyncForTests();
  }
});

// ------------------------------------------------- display rule -----------

test('display: approximately-16:9 shows whole, anything else covers', async () => {
  const display = await import('@/lib/thumbs/display');
  // Exact + generated 16:9 frames show whole.
  assert.equal(display.isApproximatelySixteenByNine(640, 360), true);
  assert.equal(display.isApproximatelySixteenByNine(1920, 1080), true);
  assert.equal(display.isApproximatelySixteenByNine(320, 180), true);
  // Near-16:9 (e.g. 1.8:1 MEGA thumbs) still shows whole.
  assert.equal(display.isApproximatelySixteenByNine(200, 111), true);
  // Square / portrait / very wide fill the card instead.
  assert.equal(display.isApproximatelySixteenByNine(200, 200), false);
  assert.equal(display.isApproximatelySixteenByNine(640, 1141), false);
  assert.equal(display.isApproximatelySixteenByNine(360, 640), false);
  assert.equal(display.isApproximatelySixteenByNine(400, 200), false);
  // Invalid sizes never claim to be 16:9.
  assert.equal(display.isApproximatelySixteenByNine(0, 0), false);
  assert.equal(display.isApproximatelySixteenByNine(-1, 100), false);
  assert.equal(display.isApproximatelySixteenByNine(Number.NaN, 100), false);
});

test('verdictThumbMean: usable / black / unknown share one rule', () => {
  assert.equal(repair.verdictThumbMean(200), 'usable');
  assert.equal(repair.verdictThumbMean(repair.THUMB_BRIGHTNESS_MIN), 'usable');
  assert.equal(repair.verdictThumbMean(repair.THUMB_BRIGHTNESS_MIN - 0.5), 'black');
  assert.equal(repair.verdictThumbMean(0), 'black');
  assert.equal(repair.verdictThumbMean(null), 'unknown');
});

test('repair: black file on disk takes the same path as a missing thumbnail', { skip: !hasFfmpeg }, async () => {
  const u = await makeUser('thumb-blackfile@example.com');
  const v = await makeVideo(u.id, 'thumb-blackfile-v', true);
  // Genuinely black stored thumbnail (not merely missing).
  await fs.promises.writeFile(path.join(thumbsTmp, `${v.id}.jpg`), bmp(16, 16, () => [0, 0, 0]));
  const brightBmp = path.join(tmpRoot, 'blackfile-bright.bmp');
  await fs.promises.writeFile(brightBmp, bmp(16, 16, () => [200, 200, 200]));
  repair.__setExtractBestForTests(async () => ({ jpg: brightBmp, seek: 5, brightness: 200 }) as never);
  try {
    const r = await repair.repairVideoThumbnail(u.id, v.id, { deps: fakeDeps as never });
    assert.equal(r.status, 'repaired');
    assert.ok((await repair.thumbMeanBrightness(path.join(thumbsTmp, `${v.id}.jpg`)))! >= repair.THUMB_BRIGHTNESS_MIN);
    const after = await prisma.video.findUniqueOrThrow({ where: { id: v.id } });
    assert.equal(after.thumbnail, `/api/media/thumbs/${v.id}`);
  } finally {
    repair.__setExtractBestForTests(null);
  }
});

test('repair: second scan skips already-repaired thumbnails (idempotent)', { skip: !hasFfmpeg }, async () => {
  const u = await makeUser('thumb-rescan@example.com');
  const v = await makeVideo(u.id, 'thumb-rescan-v', true);
  const brightBmp = path.join(tmpRoot, 'rescan-bright.bmp');
  await fs.promises.writeFile(brightBmp, bmp(16, 16, () => [200, 200, 200]));
  repair.__setExtractBestForTests(async () => ({ jpg: brightBmp, seek: 5, brightness: 200 }) as never);
  try {
    const first = await repair.repairUserThumbnails(u.id, { videoIds: [v.id], deps: fakeDeps as never });
    assert.equal(first.repaired, 1);
    repair.__setExtractBestForTests(async () => {
      throw new Error('must not extract for an already-good thumbnail');
    });
    const second = await repair.repairUserThumbnails(u.id, { videoIds: [v.id], deps: fakeDeps as never });
    assert.equal(second.scanned, 1);
    assert.equal(second.skippedGood, 1);
    assert.equal(second.repaired, 0);
    assert.equal(second.failed, 0);
  } finally {
    repair.__setExtractBestForTests(null);
  }
});
