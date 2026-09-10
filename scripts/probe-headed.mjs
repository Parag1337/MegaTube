/**
 * Phase 0 diagnostic #8: headed Chrome run (rules out headless-only codec/
 * decoder limitations). Performs hover preview + video page playback checks
 * and saves screenshots as evidence.
 */
import { chromium } from '@playwright/test';
import fs from 'node:fs';

const BASE = process.env.E2E_BASE_URL ?? 'http://localhost:3000';
const hasDisplay = !!process.env.DISPLAY || !!process.env.WAYLAND_DISPLAY;
console.log('display available:', hasDisplay);

const browser = await chromium.launch({
  channel: 'chrome',
  headless: !hasDisplay,
  args: hasDisplay ? [] : ['--headless=new'],
});
const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });

// ---------- A) hover preview playback ----------
console.log('\n--- A) hover preview ---');
await page.goto(BASE, { waitUntil: 'domcontentloaded' });
await page.waitForSelector('[role="link"][aria-label]');
await page.locator('[role="link"][aria-label]').first().hover();
await page.waitForTimeout(700);

let mf = null;
for (let i = 0; i < 40; i++) {
  mf = page.frames().find((f) => f.url().includes('mega.nz/embed'));
  if (mf) {
    const hasV = await mf.evaluate(() => !!document.querySelector('video')).catch(() => false);
    if (hasV) break;
  }
  await page.waitForTimeout(1000);
}

if (mf) {
  const read = () => mf.evaluate(() => {
    const v = document.querySelector('video');
    return v ? { rs: v.readyState, paused: v.paused, t: +v.currentTime.toFixed(2), w: v.videoWidth, h: v.videoHeight, muted: v.muted, buf: v.buffered.length ? +v.buffered.end(0).toFixed(1) : 0 } : null;
  }).catch(() => null);

  let s1 = await read();
  for (let i = 0; i < 30 && (!s1 || s1.rs < 2); i++) { await page.waitForTimeout(1000); s1 = await read(); }
  console.log('preview state:', JSON.stringify(s1));
  const t1 = s1?.t ?? 0;
  await page.waitForTimeout(3000);
  const s2 = await read();
  console.log('preview state +3s:', JSON.stringify(s2));
  const ok = s1 && s2 && !s2.paused && s2.rs >= 2 && s2.w > 0 && s2.t > t1;
  console.log(ok ? 'PASS preview really plays' : 'FAIL preview not playing');

  const dir = '/tmp/phase0-evidence';
  fs.mkdirSync(dir, { recursive: true });
  await page.screenshot({ path: `${dir}/preview-playing.png` });
}

// ---------- B) video page click-to-play ----------
console.log('\n--- B) video page click-to-play ---');
const page2 = await browser.newPage({ viewport: { width: 1280, height: 800 } });
await page2.goto(`${BASE}/video/freya-reign-girlfriend-warms-you-up-for-your-date`, { waitUntil: 'domcontentloaded' });
await page2.waitForSelector('.mega-player iframe[src*="mega.nz/embed"]', { timeout: 15000 });

let mf2 = null;
for (let i = 0; i < 45; i++) {
  mf2 = page2.frames().find((f) => f.url().direct ? f : f.url().includes('mega.nz/embed'));
  if (mf2) {
    const hasV = await mf2.evaluate(() => !!document.querySelector('video')).catch(() => false);
    if (hasV) break;
  }
  await page2.waitForTimeout(1000);
}
if (!mf2) { console.log('FAIL no frame on video page'); await browser.close(); process.exit(1); }

// Trusted click on the play button.
try {
  await page2.frameLocator('.mega-player iframe[src*="mega.nz/embed"]').locator('.play-video-button').first().click({ timeout: 10000, force: true });
  console.log('trusted click on play button');
} catch (e) {
  console.log('play click failed:', e.message.split('\n')[0].slice(0, 80));
}

const read2 = () => mf2.evaluate(() => {
  const v = document.querySelector('video');
  return v ? { rs: v.readyState, paused: v.paused, t: +v.currentTime.toFixed(2), w: v.videoWidth, muted: v.muted } : null;
}).catch(() => null);

let s1 = await read2();
for (let i = 0; i < 40 && (!s1 || s1.rs < 2); i++) { await page2.waitForTimeout(1000); s1 = await read2(); }
console.log('video page state:', JSON.stringify(s1));
const t1 = s1?.t ?? 0;
await page2.waitForTimeout(3000);
const s2 = await read2();
console.log('video page state +3s:', JSON.stringify(s2));
const ok = s1 && s2 && !s2.paused && s2.rs >= 2 && s2.w > 0 && s2.t > t1;
console.log(ok ? 'PASS video page really plays after click' : 'FAIL video page not playing');
await page2.screenshot({ path: '/tmp/phase0-evidence/videopage-playing.png' });

await browser.close();
