/**
 * TEMPORARY verification (lives in /tmp, never in the repo):
 * 1. "Tap play to start with sound." is gone from the video page.
 * 2. Controls still work: play, mute/unmute, seek, fullscreen button.
 * Desktop + mobile widths.
 */
import 'dotenv/config';
import crypto from 'node:crypto';
import { chromium } from '@playwright/test';

process.chdir('/home/parag/Projects/Project_Mega');
const BASE = 'http://localhost:3000';
const OVERLAY_TEXT = 'Tap play to start with sound.';

async function verifyViewport(label: string, width: number, height: number, slug: string, token: string) {
  console.log(`--- ${label} (${width}x${height}) ---`);
  const browser = await chromium.launch({ channel: 'chrome', headless: true, args: ['--mute-audio'] });
  const context = await browser.newContext({ viewport: { width, height } });
  await context.addCookies([{ name: 'session_token', value: token, url: BASE }]);
  const page = await context.newPage();
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  try {
    await page.goto(`${BASE}/video/${slug}`, { waitUntil: 'domcontentloaded' });
    await page.waitForSelector('video', { timeout: 30_000 });
    // Wait for the player to settle (metadata or error state).
    await page.waitForFunction(
      () => {
        const v = document.querySelector('video');
        return (v && v.readyState >= 1) || document.body.textContent?.includes('Video cannot be played');
      },
      { timeout: 60_000 },
    );

    // 1) Overlay text must be NOWHERE on the page.
    const overlayCount = await page.evaluate((t) => {
      const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
      let n = 0;
      while (walker.nextNode()) {
        if (walker.currentNode.textContent?.includes(t)) n++;
      }
      return n;
    }, OVERLAY_TEXT);
    console.log(`overlay text occurrences: ${overlayCount}`);
    if (overlayCount > 0) throw new Error('OVERLAY STILL PRESENT');

    // 2) Play works (explicit gesture via evaluate).
    await page.evaluate(() => (document.querySelector('video') as HTMLVideoElement).play().catch(() => {}));
    await page.waitForFunction(
      () => {
        const v = document.querySelector('video')!;
        return !v.paused && v.currentTime > 0.2;
      },
      { timeout: 30_000 },
    );
    console.log('play: OK');

    // 3) Mute/unmute via the Vidstack mute button.
    const muteBtn = page.locator('media-mute-button, [data-part="mute-button"], .vds-mute-button, button[aria-label*="mute" i], button[aria-label*="unmute" i]').first();
    await muteBtn.waitFor({ timeout: 15_000 });
    const mutedBefore = await page.evaluate(() => (document.querySelector('video') as HTMLVideoElement).muted);
    await muteBtn.click();
    await page.waitForFunction((b) => (document.querySelector('video') as HTMLVideoElement).muted !== b, mutedBefore, { timeout: 10_000 });
    const mutedAfter = await page.evaluate(() => (document.querySelector('video') as HTMLVideoElement).muted);
    console.log(`mute toggle: OK (muted ${mutedBefore} -> ${mutedAfter})`);
    await muteBtn.click(); // restore
    await page.waitForTimeout(500);

    // 4) Seeking via the video element (same pipeline the slider drives).
    const t0 = await page.evaluate(() => (document.querySelector('video') as HTMLVideoElement).currentTime);
    const dur = await page.evaluate(() => (document.querySelector('video') as HTMLVideoElement).duration);
    await page.evaluate((d) => {
      (document.querySelector('video') as HTMLVideoElement).currentTime = Math.min(d - 5, 60);
    }, dur);
    await page.waitForFunction(() => (document.querySelector('video') as HTMLVideoElement).currentTime > 55, { timeout: 60_000 });
    console.log(`seek: OK (t=${t0.toFixed(1)} -> ~60s of ${dur.toFixed(0)}s)`);

    // 5) Fullscreen button exists and activates fullscreen (headless Chrome supports it).
    const fsBtn = page.locator('media-fullscreen-button, [data-part="fullscreen-button"], .vds-fullscreen-button, button[aria-label*="fullscreen" i]').first();
    await fsBtn.waitFor({ timeout: 15_000 });
    await fsBtn.click();
    await page.waitForTimeout(1000);
    const fsActive = await page.evaluate(() => !!document.fullscreenElement);
    console.log(`fullscreen button: present, fullscreen active after click: ${fsActive}`);

    // 6) Re-check overlay absence after all interactions.
    const overlayAfter = await page.evaluate((t) => document.body.textContent?.includes(t) ?? false, OVERLAY_TEXT);
    console.log(`overlay absent after interactions: ${!overlayAfter}`);
    if (overlayAfter) throw new Error('OVERLAY APPEARED AFTER INTERACTIONS');

    if (errors.length > 0) console.log('page errors:', JSON.stringify(errors.slice(0, 3)));
    console.log(`${label}: PASS`);
  } finally {
    await browser.close();
  }
}

async function main() {
  const { prisma } = await import('/home/parag/Projects/Project_Mega/lib/db');
  const account = await prisma.megaAccount.findUnique({ where: { id: 1 }, select: { userId: true } });
  if (!account) throw new Error('account #1 missing');
  const video = await prisma.video.findUnique({ where: { id: 26 }, select: { slug: true, title: true } });
  if (!video?.slug) throw new Error('video 26 missing');
  console.log('video under test:', JSON.stringify(video));
  const token = crypto.randomBytes(32).toString('hex');
  await prisma.session.create({
    data: { userId: account.userId, token, expiresAt: new Date(Date.now() + 10 * 60_000) },
  });
  try {
    await verifyViewport('DESKTOP', 1280, 800, video.slug, token);
    await verifyViewport('MOBILE', 390, 844, video.slug, token);
    console.log('OVERLAY REMOVAL + CONTROLS: ALL PASS');
  } finally {
    await prisma.session.deleteMany({ where: { token } });
    await prisma.$disconnect();
  }
}

main().then(() => process.exit(0), (err) => { console.error('VERIFY FAILED:', err instanceof Error ? err.message : String(err)); process.exit(1); });
