/**
 * Phase 0 diagnostic #11: video page click-to-play in HEADED Chrome with a
 * real coordinate click at the player center (like a human user).
 */
import { chromium } from '@playwright/test';

const BASE = process.env.E2E_BASE_URL ?? 'http://localhost:3000';
const hasDisplay = !!process.env.DISPLAY || !!process.env.WAYLAND_DISPLAY;
const browser = await chromium.launch({ channel: 'chrome', headless: !hasDisplay });
console.log('headed:', hasDisplay);

const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
await page.goto(`${BASE}/video/freya-reign-girlfriend-warms-you-up-for-your-date`, { waitUntil: 'domcontentloaded' });
await page.waitForSelector('.mega-player iframe[src*="mega.nz/embed"]', { timeout: 15000 });

let mf = null;
for (let i = 0; i < 45; i++) {
  mf = page.frames().find((f) => f.url().includes('mega.nz/embed'));
  if (mf && await mf.evaluate(() => !!document.querySelector('video')).catch(() => false)) break;
  await page.waitForTimeout(1000);
}
if (!mf) { console.log('no frame/video'); process.exit(1); }

console.log('frame env:', JSON.stringify(await mf.evaluate(() => ({
  hasFocus: document.hasFocus(),
  visibility: document.visibilityState,
})).catch(() => null)));

const read = () => mf.evaluate(() => {
  const v = document.querySelector('video');
  return v ? { rs: v.readyState, paused: v.paused, t: +v.currentTime.toFixed(2), w: v.videoWidth, muted: v.muted } : null;
}).catch(() => null);

const box = await page.locator('.mega-player iframe[src*="mega.nz/embed"]').boundingBox();
await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
await page.waitForTimeout(400);
await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
console.log('clicked player center');

let s1 = null;
for (let i = 0; i < 40; i++) {
  await page.waitForTimeout(1000);
  s1 = await read();
  if (s1 && s1.rs >= 2) break;
}
console.log('state:', JSON.stringify(s1));
const t1 = s1?.t ?? 0;
await page.waitForTimeout(3000);
const s2 = await read();
console.log('state +3s:', JSON.stringify(s2));
const ok = s2 && !s2.paused && s2.rs >= 2 && s2.t > t1 && s2.w > 0;
console.log(ok ? 'PASS video page plays after user click' : 'FAIL video page still stalled');
await page.screenshot({ path: '/tmp/phase0-evidence/videopage-click.png' });
await browser.close();
