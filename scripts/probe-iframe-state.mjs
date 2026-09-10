/**
 * Phase 0 diagnostic: dump MEGA embed iframe state over time.
 * Does the iframe ever show a player? A <video>? What is the UI doing?
 */
import { chromium } from '@playwright/test';

const BASE = process.env.E2E_BASE_URL ?? 'http://localhost:3000';
const browser = await chromium.launch({ channel: 'chrome', headless: true });
const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });

const megaRequests = [];
page.on('request', (req) => {
  if (/mega\.nz|userstorage|gfs\d+/.test(req.url())) megaRequests.push(`${req.method()} ${req.url().slice(0, 110)}`);
});

await page.goto(BASE);
await page.locator('[role="link"][aria-label]').first().hover();
await page.waitForTimeout(600);

let megaFrame = null;
for (let i = 0; i < 30 && !megaFrame; i++) {
  megaFrame = page.frames().find((f) => f.url().includes('mega.nz/embed'));
  if (!megaFrame) await page.waitForTimeout(500);
}
if (!megaFrame) {
  console.log('NO MEGA FRAME EVER');
  await browser.close();
  process.exit(1);
}
console.log('frame url:', megaFrame.url().slice(0, 90));

for (const wait of [2000, 3000, 4000, 5000, 6000, 8000]) {
  await page.waitForTimeout(wait === 2000 ? 2000 : wait - (wait === 3000 ? 2000 : wait === 4000 ? 3000 : wait === 5000 ? 4000 : wait === 6000 ? 5000 : 6000));
  const state = await megaFrame.evaluate(() => {
    const v = document.querySelector('video');
    const bodyText = (document.body?.innerText ?? '').slice(0, 220).replace(/\n+/g, ' | ');
    return {
      hasVideo: !!v,
      videoState: v ? { readyState: v.readyState, paused: v.paused, muted: v.muted, t: v.currentTime, w: v.videoWidth, h: v.videoHeight } : null,
      totalElements: document.querySelectorAll('*').length,
      buttons: [...document.querySelectorAll('button, .play-video, [class*=play]')].slice(0, 6).map((b) => `${b.tagName}.${String(b.className).slice(0, 40)}:${(b.textContent ?? '').trim().slice(0, 20)}`),
      bodyText,
    };
  }).catch((e) => ({ evalError: e.message.slice(0, 120) }));
  console.log(`\n=== t≈${wait}s ===`);
  console.log(JSON.stringify(state, null, 1).slice(0, 1400));
}

console.log('\n--- MEGA requests seen (last 12) ---');
for (const r of megaRequests.slice(-12)) console.log(r);

await page.screenshot({ path: '/tmp/probe-iframe-state.png' });
await browser.close();
