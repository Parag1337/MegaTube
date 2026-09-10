/**
 * Phase 0 diagnostic #3: video page click-to-play + scroll-while-preview cleanup.
 */
import { chromium } from '@playwright/test';

const BASE = process.env.E2E_BASE_URL ?? 'http://localhost:3000';
const browser = await chromium.launch({ channel: 'chrome', headless: true });
const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });

// --- Part 1: video page player — click play, verify playback advances ---
console.log('=== Part 1: video page click-to-play ===');
await page.goto(`${BASE}/video/freya-reign-quick-pegging-before-dinner`, { waitUntil: 'domcontentloaded' });
await page.waitForSelector('.mega-player iframe[src*="mega.nz/embed"]', { timeout: 15000 });

let fp = null;
for (let i = 0; i < 40 && !fp; i++) {
  fp = page.frames().find((f) => f.url().includes('mega.nz/embed'));
  if (!fp) await page.waitForTimeout(500);
}
if (fp) {
  // Wait for player UI to build, then click the big play button.
  for (let i = 0; i < 20; i++) {
    const has = await fp.evaluate(() => !!document.querySelector('.play-video-button, .play-pause-video-button, video')).catch(() => false);
    if (has) break;
    await page.waitForTimeout(1000);
  }
  const clicked = await fp.evaluate(() => {
    const btn = document.querySelector('.play-video-button:not(.hidden)') ?? document.querySelector('.play-video-button') ?? document.querySelector('video');
    if (!btn) return 'no clickable element';
    (btn.closest('[class*=play-video-button]') ?? btn).dispatchEvent(new MouseEvent('click', { bubbles: true }));
    // Also try a raw video play() as fallback evidence path.
    const v = document.querySelector('video');
    if (v) v.play?.().catch?.(() => {});
    return 'clicked';
  }).catch((e) => `eval failed: ${e.message.slice(0, 80)}`);
  console.log('play action:', clicked);

  const s1 = await fp.evaluate(() => {
    const v = document.querySelector('video');
    return v ? { t: v.currentTime, paused: v.paused, rs: v.readyState, w: v.videoWidth, muted: v.muted } : { error: 'no video' };
  }).catch(() => ({ error: 'eval failed' }));
  console.log('after click (t0):', JSON.stringify(s1));
  await page.waitForTimeout(4000);
  const s2 = await fp.evaluate(() => {
    const v = document.querySelector('video');
    return v ? { t: v.currentTime, paused: v.paused, rs: v.readyState, w: v.videoWidth, muted: v.muted } : { error: 'no video' };
  }).catch(() => ({ error: 'eval failed' }));
  console.log('after click (t0+4s):', JSON.stringify(s2));
  const advancing = typeof s1.t === 'number' && typeof s2.t === 'number' && s2.t > s1.t;
  console.log(advancing ? 'PASS video page playback advances' : 'INCONCLUSIVE video page playback (may still be buffering)');
} else {
  console.log('FAIL no mega frame on video page');
}

// --- Part 2: scroll while a card preview is active ---
console.log('\n=== Part 2: scroll-while-preview cleanup ===');
await page.goto(BASE, { waitUntil: 'domcontentloaded' });
await page.waitForSelector('[role="link"][aria-label]');
const card = page.locator('[role="link"][aria-label]').nth(4);
await card.scrollIntoViewIfNeeded();
await card.hover();
await page.waitForTimeout(700);
let before = await page.locator('iframe[src*="mega.nz/embed"]').count();
console.log('preview iframes after hover:', before);
await page.mouse.wheel(0, 600);
await page.waitForTimeout(600);
let afterScroll = await page.locator('iframe[src*="mega.nz/embed"]').count();
console.log('preview iframes after scrolling 600px:', afterScroll);
const stillVisible = afterScroll === 1
  ? await page.locator('iframe[src*="mega.nz/embed"]').first().evaluate((el) => {
      const r = el.getBoundingClientRect();
      return r.bottom > 0 && r.top < window.innerHeight;
    })
  : false;
console.log('iframe still in viewport:', stillVisible);

await browser.close();
