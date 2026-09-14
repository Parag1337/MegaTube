/**
 * Repair lifecycle regression tests: the live per-video log must reflect
 * REAL work. Skips perform no extraction; every reported success is backed
 * by a real stored thumbnail + DB update; failures never throw; repaired
 * videos are skipped on rescan.
 */

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { createTestDatabase } from './helpers/test-db';

const db = createTestDatabase('repair-progress-unit');
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
  tmpRoot = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'repair-progress-'));
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

const PASSWORD_HASH = 'pbkdf2:sha256:100000:00000000000000000000000000000000:000000000000000000000000000000000000000000000000000000000000000000';

async function makeUser(email: string) {
  return prisma.user.create({ data: { email, passwordHash: PASSWORD_HASH } });
}

async function makeVideo(userId: string, slug: string, thumbnailAvailable?: boolean) {
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
      fileKeyEncrypted: encryptSecret(Buffer.alloc(32, 7)),
      ...(thumbnailAvailable !== undefined ? { thumbnailAvailable } : {}),
    },
  });
}

const fakeDeps = {
  fetchCiphertext: async () => new Response(Buffer.alloc(64)),
  withSession: async (_id: number, _sess: string, fn: (s: never) => Promise<unknown>) =>
    fn(undefined as never),
  getUrl: async () => ({ url: 'http://thumb.test/x', size: 1000 }),
} as never;

async function brightFixture(name: string): Promise<string> {
  const p = path.join(tmpRoot, name);
  await fs.promises.writeFile(p, bmp(16, 16, () => [200, 180, 160]));
  return p;
}

type RepairEvent = {
  type: string;
  videoId: number;
  phase?: string;
  category?: string;
  status?: string;
};

function eventsFor(events: RepairEvent[], videoId: number): RepairEvent[] {
  return events.filter((e) => e.videoId === videoId);
}

test('good thumbnail: skipped with no extraction and no phase events', { skip: !hasFfmpeg }, async () => {
  const u = await makeUser('prog-good@example.com');
  const v = await makeVideo(u.id, 'prog-good-v', true);
  await fs.promises.writeFile(path.join(thumbsTmp, `${v.id}.jpg`), bmp(16, 16, () => [210, 210, 210]));
  repair.__setExtractBestForTests(async () => {
    throw new Error('extraction must not run for a good thumbnail');
  });
  try {
    const events: RepairEvent[] = [];
    const summary = await repair.repairUserThumbnails(u.id, {
      videoIds: [v.id],
      deps: fakeDeps as never,
      onEvent: (e) => events.push(e as unknown as RepairEvent),
    });
    assert.equal(summary.scanned, 1);
    assert.equal(summary.skippedGood, 1);
    assert.equal(summary.repaired, 0);
    const ev = eventsFor(events, v.id);
    assert.deepEqual(ev.map((e) => e.type), ['video-start', 'video-done']);
    assert.equal(ev[1].status, 'skipped-good');
  } finally {
    repair.__setExtractBestForTests(null);
  }
});

test('previously problematic video: phases emitted, real thumbnail stored, DB updated', { skip: !hasFfmpeg }, async () => {
  const u = await makeUser('prog-prob@example.com');
  const v = await makeVideo(u.id, 'prog-prob-v', false);
  const bright = await brightFixture('prog-prob-bright.bmp');
  let extracted = false;
  repair.__setExtractBestForTests(async () => {
    extracted = true;
    return { jpg: bright, seek: 5, brightness: 190 } as never;
  });
  try {
    const events: RepairEvent[] = [];
    const summary = await repair.repairUserThumbnails(u.id, {
      videoIds: [v.id],
      deps: fakeDeps as never,
      onEvent: (e) => events.push(e as unknown as RepairEvent),
    });
    assert.equal(extracted, true);
    assert.equal(summary.repairedProblematic, 1);
    const ev = eventsFor(events, v.id);
    assert.deepEqual(ev.map((e) => e.type), ['video-start', 'video-phase', 'video-phase', 'video-done']);
    assert.deepEqual(ev.map((e) => e.phase ?? null), [null, 'repairing', 'extracting', null]);
    assert.equal(ev[1].category, 'repaired-problematic');
    assert.equal(ev[3].status, 'repaired-problematic');
    assert.ok(typeof ev[3] === 'object');
    // Success is backed by a real stored file + DB state.
    const stored = path.join(thumbsTmp, `${v.id}.jpg`);
    assert.ok(fs.existsSync(stored), 'frame persisted to thumbs dir');
    assert.ok((await repair.thumbMeanBrightness(stored))! >= repair.THUMB_BRIGHTNESS_MIN);
    const after = await prisma.video.findUniqueOrThrow({ where: { id: v.id } });
    assert.equal(after.thumbnail, `/api/media/thumbs/${v.id}`);
    assert.equal(after.thumbnailAvailable, true);
  } finally {
    repair.__setExtractBestForTests(null);
  }
});

test('black and missing thumbnails: repair runs and succeeds only with a real file', { skip: !hasFfmpeg }, async () => {
  const u = await makeUser('prog-bm@example.com');
  const black = await makeVideo(u.id, 'prog-bm-black', true);
  await fs.promises.writeFile(path.join(thumbsTmp, `${black.id}.jpg`), bmp(16, 16, () => [0, 0, 0]));
  const missing = await makeVideo(u.id, 'prog-bm-missing', true);
  const bright = await brightFixture('prog-bm-bright.bmp');
  repair.__setExtractBestForTests(async () => ({ jpg: bright, seek: 5, brightness: 190 }) as never);
  try {
    const events: RepairEvent[] = [];
    const summary = await repair.repairUserThumbnails(u.id, {
      videoIds: [black.id, missing.id],
      deps: fakeDeps as never,
      onEvent: (e) => events.push(e as unknown as RepairEvent),
    });
    assert.equal(summary.repairedBlack, 1);
    assert.equal(summary.repairedMissing, 1);
    for (const vid of [black.id, missing.id]) {
      const ev = eventsFor(events, vid);
      assert.ok(ev.some((e) => e.phase === 'repairing'), `repairing emitted for ${vid}`);
      assert.ok(ev.some((e) => e.phase === 'extracting'), `extracting emitted for ${vid}`);
      const done = ev.find((e) => e.type === 'video-done');
      assert.ok(done && done.status?.startsWith('repaired'), `done repaired for ${vid}`);
      const stored = path.join(thumbsTmp, `${vid}.jpg`);
      assert.ok((await repair.thumbMeanBrightness(stored))! >= repair.THUMB_BRIGHTNESS_MIN);
    }
  } finally {
    repair.__setExtractBestForTests(null);
  }
});

test('failed extraction: failure reported, thumbnail untouched, no throw', { skip: !hasFfmpeg }, async () => {
  const u = await makeUser('prog-fail@example.com');
  const v = await makeVideo(u.id, 'prog-fail-v', false);
  repair.__setExtractBestForTests(async () => null as never);
  try {
    const events: RepairEvent[] = [];
    const summary = await repair.repairUserThumbnails(u.id, {
      videoIds: [v.id],
      deps: fakeDeps as never,
      onEvent: (e) => events.push(e as unknown as RepairEvent),
    });
    assert.equal(summary.failed, 1);
    assert.equal(summary.repaired, 0);
    const done = eventsFor(events, v.id).find((e) => e.type === 'video-done');
    assert.equal(done?.status, 'failed');
    // Real repair work was attempted (phases emitted) but nothing stored.
    assert.ok(eventsFor(events, v.id).some((e) => e.phase === 'extracting'));
    assert.ok(!fs.existsSync(path.join(thumbsTmp, `${v.id}.jpg`)));
    const after = await prisma.video.findUniqueOrThrow({ where: { id: v.id } });
    assert.equal(after.thumbnail, null);
  } finally {
    repair.__setExtractBestForTests(null);
  }
});

test('repaired video is skipped on the next run (idempotent)', { skip: !hasFfmpeg }, async () => {
  const u = await makeUser('prog-idem@example.com');
  const v = await makeVideo(u.id, 'prog-idem-v', false);
  const bright = await brightFixture('prog-idem-bright.bmp');
  repair.__setExtractBestForTests(async () => ({ jpg: bright, seek: 5, brightness: 190 }) as never);
  try {
    const first = await repair.repairUserThumbnails(u.id, { videoIds: [v.id], deps: fakeDeps as never });
    assert.equal(first.repairedProblematic, 1);
    repair.__setExtractBestForTests(async () => {
      throw new Error('must not extract for an already-repaired thumbnail');
    });
    const events: RepairEvent[] = [];
    const second = await repair.repairUserThumbnails(u.id, {
      videoIds: [v.id],
      deps: fakeDeps as never,
      onEvent: (e) => events.push(e as unknown as RepairEvent),
    });
    assert.equal(second.skippedGood, 1);
    assert.equal(second.repaired, 0);
    assert.ok(!eventsFor(events, v.id).some((e) => e.phase === 'repairing'));
  } finally {
    repair.__setExtractBestForTests(null);
  }
});

test('full-library scan reaches videos beyond the old batch cap, problematic first', { skip: !hasFfmpeg }, async () => {
  const u = await makeUser('prog-full@example.com');
  const goodIds: number[] = [];
  for (let i = 0; i < 25; i++) {
    const gv = await makeVideo(u.id, `prog-full-good-${i}`, true);
    await fs.promises.writeFile(path.join(thumbsTmp, `${gv.id}.jpg`), bmp(8, 8, () => [210, 210, 210]));
    goodIds.push(gv.id);
  }
  const prob = await makeVideo(u.id, 'prog-full-prob', false);
  const bright = await brightFixture('prog-full-bright.bmp');
  repair.__setExtractBestForTests(async () => ({ jpg: bright, seek: 5, brightness: 190 }) as never);
  try {
    const events: RepairEvent[] = [];
    const summary = await repair.repairUserThumbnails(u.id, {
      deps: fakeDeps as never,
      onEvent: (e) => events.push(e as unknown as RepairEvent),
    });
    // All 26 videos examined in one run (no 20-cap truncation).
    assert.equal(summary.scanned, 26);
    assert.equal(summary.skippedGood, 25);
    assert.equal(summary.repairedProblematic, 1);
    void goodIds;
    // Problematic video processed before the good ones.
    const firstStart = events.find((e) => e.type === 'video-start');
    assert.equal(firstStart?.videoId, prob.id);
  } finally {
    repair.__setExtractBestForTests(null);
  }
});

test('per-video timing is recorded on results', { skip: !hasFfmpeg }, async () => {
  const u = await makeUser('prog-time@example.com');
  const v = await makeVideo(u.id, 'prog-time-v', true);
  await fs.promises.writeFile(path.join(thumbsTmp, `${v.id}.jpg`), bmp(8, 8, () => [210, 210, 210]));
  const r = await repair.repairVideoThumbnail(u.id, v.id, { deps: fakeDeps as never });
  assert.equal(r.status, 'skipped-good');
  assert.equal(r.title, 'prog-time-v');
  assert.ok(typeof r.elapsedMs === 'number' && r.elapsedMs >= 0);
});
