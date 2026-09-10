/**
 * Phase 0 diagnostic #5: video page playback using REAL (trusted) Playwright
 * clicks inside the cross-origin MEGA frame.
 */
import { chromium } from '@playwright/test';

const BASE = process.env.E2E_BASE_URL ?? 'http://localhost:3000';
const browser = await chromium.launch({ channel: 'chrome', headless: true });
const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });

await page.goto(`${BASE}/video/freya-reign-quick-pegging-before-dinner`, { waitUntil: 'domcontentloaded' });
await page.waitForSelector('.mega-player iframe[src*="mega.nz/embed"]', { timeout: 15000 });

// Wait for the MEGA player UI to build (video element appears).
let videoReady = false;
for (let i = 0; i < 45; i++) {
  videoReady = await page.frames().some((f) => f.url().includes('mega.nz/embed')) &&
    await page.frames().find((f) => f.url().includes('mega.nz/embed'))?.evaluate(() => !!document.querySelector('video')).catch(() => false);
  if (videoReady) break;
  await page.waitForTimeout(1000);
}
console.log('video element present:', videoReady);

const frameEl = page.frameLocator('.mega-player iframe[src*="mega.nz/embed"]');

// Trusted click on the big play button (real input event chain).
let clickResult = 'no button found';
try {
  const btn = frameEl.locator('.play-video-button').first();
  await btn.waitFor({ state: 'visible', timeout: 15000 });
  await btn.click({ timeout: 10000 });
  clickResult = 'trusted click on .play-video-button';
} catch (e) {
  clickResult = `play button click failed: ${e.message.split('\n')[0].slice(0, 90)}`;
}
console.log('click:', clickResult);

// Poll for playback evidence.
const samples = [];
for (let i = 0; i < 40; i++) {
  await page.waitForTimeout(1000);
  const s = await page.frames().find((f) => f.url().includes('mega.nz/embed'))?.evaluate(() => {
    const v = document.querySelector('video');
    return v ? { t: +v.currentTime.toFixed(2), paused: v.paused, rs: v.readyState, w: v.videoWidth, buf: v.buffered.length ? +v.buffered.end(0).toFixed(1) : 0 } : null;
  }).catch(() => null);
  if (s) samples.push(s);
  const last = samples[samples.length - 1];
  if (last && !last.paused && last.rs >= 2 && samples.length > 3) {
    const prev = samples[samples.length - 4];
    if (last.t > prev.t) {
      console.log(`PLAYING at ~${i + 1}s after click:`, JSON.stringify(last), `(was t=${prev.t} 3s earlier)`);
      await page.screenshot({ path: '/tmp/probe-detail-playing.png' });
      process.exit(0);
    }
  }
}
console.log('samples (every 5s):', JSON.stringify(samples.filter((_, i) => i % 5 === 0)));
console.log('NOT PLAYING within 40s of trusted click');
await page.screenshot({ path: '/tmp/probe-detail-stuck.png' });
