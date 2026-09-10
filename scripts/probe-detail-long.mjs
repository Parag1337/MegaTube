/**
 * Phase 0 diagnostic #4: video page playback with generous buffering window.
 */
import { chromium } from '@playwright/test';

const BASE = process.env.E2E_BASE_URL ?? 'http://localhost:3000';
const browser = await chromium.launch({ channel: 'chrome', headless: true });
const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });

await page.goto(`${BASE}/video/freya-reign-quick-pegging-before-dinner`, { waitUntil: 'domcontentloaded' });
await page.waitForSelector('.mega-player iframe[src*="mega.nz/embed"]', { timeout: 15000 });

let fp = null;
for (let i = 0; i < 40 && !fp; i++) {
  fp = page.frames().find((f) => f.url().includes('mega.nz/embed'));
  if (!fp) await page.waitForTimeout(500);
}
if (!fp) { console.log('FAIL no frame'); process.exit(1); }

// Wait until the player UI/video exists (up to 30s).
for (let i = 0; i < 30; i++) {
  const ok = await fp.evaluate(() => !!document.querySelector('video')).catch(() => false);
  if (ok) break;
  await page.waitForTimeout(1000);
}

// Click play.
const clicked = await fp.evaluate(() => {
  const btn = document.querySelector('.play-video-button');
  if (btn) { btn.dispatchEvent(new MouseEvent('click', { bubbles: true })); return 'play-button'; }
  const v = document.querySelector('video');
  if (v) { v.play?.().catch?.(() => {}); return 'video.play()'; }
  return 'nothing to click';
}).catch((e) => `eval failed: ${e.message.slice(0, 80)}`);
console.log('play action:', clicked);

// Poll up to 45s for real playback (currentTime advancing + readyState>=2).
const samples = [];
for (let i = 0; i < 45; i++) {
  await page.waitForTimeout(1000);
  const s = await fp.evaluate(() => {
    const v = document.querySelector('video');
    return v ? { t: +v.currentTime.toFixed(2), paused: v.paused, rs: v.readyState, w: v.videoWidth, buf: v.buffered.length ? +v.buffered.end(0).toFixed(1) : 0 } : null;
  }).catch(() => null);
  if (s) samples.push(s);
  const last = samples[samples.length - 1];
  if (last && !last.paused && last.rs >= 2 && samples.length > 2) {
    const prev = samples[samples.length - 3];
    if (last.t > prev.t) {
      console.log(`PLAYING at ${i + 1}s:`, JSON.stringify(last), `(was t=${prev.t} 2s earlier)`);
      process.exit(0);
    }
  }
}
console.log('samples:', JSON.stringify(samples.filter((_, i) => i % 5 === 0 || i > 40)));
console.log('NOT PLAYING within 45s');
