/**
 * Browser-level playback probe for private MEGA videos (Phase 4).
 *
 * Mints a temporary website session for the account owner (deleted at the
 * end; no MEGA password anywhere), opens the real video page in Chrome and
 * verifies: metadata loads, playback starts, and seeking works. Range
 * requests to /api/media are recorded.
 */
import 'dotenv/config';
import crypto from 'node:crypto';
import { chromium } from '@playwright/test';

const BASE = process.env.E2E_BASE_URL ?? 'http://localhost:3000';

async function main() {
  const { prisma } = await import('../lib/db');

  const account = await prisma.megaAccount.findUnique({ where: { id: 1 }, select: { userId: true } });
  if (!account) throw new Error('account #1 missing');

  const video = await prisma.video.findFirst({
    where: { megaAccountId: 1 },
    orderBy: { id: 'asc' },
    select: { id: true, slug: true, title: true, creator: { select: { name: true } } },
  });
  if (!video?.slug) throw new Error('no synced video found');
  console.log('video under test:', JSON.stringify({ id: video.id, slug: video.slug, title: video.title, creator: video.creator?.name ?? null }));

  const token = crypto.randomBytes(32).toString('hex');
  await prisma.session.create({
    data: { userId: account.userId, token, expiresAt: new Date(Date.now() + 10 * 60_000) },
  });

  const mediaRequests: Array<{ url: string; range: string | null; status?: number; len?: string | null }> = [];
  const browser = await chromium.launch({ channel: 'chrome', headless: true, args: ['--mute-audio', '--autoplay-policy=no-user-gesture-required'] });
  const context = await browser.newContext({ viewport: { width: 1280, height: 800 } });
  await context.addCookies([{ name: 'session_token', value: token, url: BASE }]);
  const page = await context.newPage();

  page.on('request', (r) => {
    if (r.url().includes('/api/media/')) {
      mediaRequests.push({ url: r.url().replace(BASE, ''), range: r.headers()['range'] ?? null });
    }
  });
  page.on('response', (res) => {
    if (res.url().includes('/api/media/')) {
      const entry = [...mediaRequests].reverse().find((m) => m.status === undefined);
      if (entry) {
        entry.status = res.status();
        entry.len = res.headers()['content-length'] ?? null;
      }
    }
  });

  try {
    await page.goto(`${BASE}/video/${video.slug}`, { waitUntil: 'domcontentloaded' });

    // 1) metadata loads (duration known => moov parsed => ranges work)
    await page.waitForFunction(
      () => {
        const v = document.querySelector('video');
        return v && v.readyState >= 1 && Number.isFinite(v.duration) && v.duration > 0;
      },
      { timeout: 60_000 },
    );
    const meta = await page.evaluate(() => {
      const v = document.querySelector('video')!;
      return { duration: v.duration, videoWidth: v.videoWidth, videoHeight: v.videoHeight, readyState: v.readyState };
    });
    console.log('metadata loaded:', JSON.stringify(meta));

    // 2) playback actually starts and progresses
    await page.evaluate(() => (document.querySelector('video') as HTMLVideoElement).play());
    await page.waitForFunction(
      () => {
        const v = document.querySelector('video')!;
        return !v.paused && v.currentTime > 0.5;
      },
      { timeout: 60_000 },
    );
    const t1 = await page.evaluate(() => (document.querySelector('video') as HTMLVideoElement).currentTime);
    await page.waitForTimeout(2500);
    const t2 = await page.evaluate(() => (document.querySelector('video') as HTMLVideoElement).currentTime);
    console.log('playback progressing:', t2 > t1, `(t=${t1.toFixed(2)} -> ${t2.toFixed(2)})`);

    // 3) seeking (forces a non-aligned range request)
    await page.evaluate(() => {
      const v = document.querySelector('video') as HTMLVideoElement;
      v.currentTime = Math.min(v.duration - 5, v.currentTime + 60);
    });
    await page.waitForFunction(
      () => {
        const v = document.querySelector('video')!;
        return v.seeking === false && v.readyState >= 2 && v.currentTime > 55;
      },
      { timeout: 60_000 },
    );
    const seeked = await page.evaluate(() => {
      const v = document.querySelector('video') as HTMLVideoElement;
      return { currentTime: v.currentTime, paused: v.paused };
    });
    console.log('seek to ~60s OK:', JSON.stringify(seeked));
    await page.waitForTimeout(1500);
    const afterSeek = await page.evaluate(() => (document.querySelector('video') as HTMLVideoElement).currentTime);
    console.log('playback continues after seek:', afterSeek > 55);

    console.log('media requests observed:', JSON.stringify(mediaRequests.slice(0, 10)));
    console.log('BROWSER PLAYBACK: PASS');
  } finally {
    await browser.close();
    await prisma.session.deleteMany({ where: { token } });
    await prisma.$disconnect();
  }
}

main().then(
  () => process.exit(0),
  (err) => {
    console.error('probe failed:', err instanceof Error ? err.message : String(err));
    process.exit(1);
  },
);
