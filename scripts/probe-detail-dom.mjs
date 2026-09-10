/**
 * Phase 0 diagnostic #6: dump the MEGA frame DOM on the video page before and
 * after a trusted click — what does the player UI say? Any error overlays?
 */
import { chromium } from '@playwright/test';

const BASE = process.env.E2E_BASE_URL ?? 'http://localhost:3000';
const browser = await chromium.launch({ channel: 'chrome', headless: true });
const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });

const reqs = [];
page.on('request', (r) => { if (/userstorage|gfs\d+/.test(r.url())) reqs.push(`REQ ${r.url().slice(0, 90)}`); });
page.on('response', (r) => { if (/userstorage|gfs\d+/.test(r.url())) reqs.push(`RES ${r.status()} ${r.url().slice(0, 90)}`); });
page.on('requestfailed', (r) => { if (/userstorage|gfs\d+/.test(r.url())) reqs.push(`FAIL ${r.failure()?.errorText} ${r.url().slice(0, 90)}`); });

await page.goto(`${BASE}/video/freya-reign-girlfriend-warms-you-up-for-your-date`, { waitUntil: 'domcontentloaded' });
await page.waitForSelector('.mega-player iframe[src*="mega.nz/embed"]', { timeout: 15000 });

let mf = null;
for (let i = 0; i < 45; i++) {
  mf = page.frames().find((f) => f.url().includes('mega.nz/embed'));
  if (mf) {
    const has = await mf.evaluate(() => !!document.querySelector('video')).catch(() => false);
    if (has) break;
  }
  await page.waitForTimeout(1000);
}
if (!mf) { console.log('no frame'); process.exit(1); }

const dump = () => mf.evaluate(() => {
  const v = document.querySelector('video');
  const btn = document.querySelector('.play-video-button');
  return {
    video: v ? { rs: v.readyState, paused: v.paused, t: v.currentTime, w: v.videoWidth } : null,
    playBtn: btn ? { cls: btn.className, visible: btn.offsetParent !== null, rect: btn.getBoundingClientRect().toJSON() } : null,
    overlays: [...document.querySelectorAll('[class*=overlay], [class*=loading], [class*=spinner]')].filter((e) => e.offsetParent !== null).map((e) => `${e.tagName}.${String(e.className).slice(0, 50)}`).slice(0, 6),
    bodyText: (document.body.innerText ?? '').slice(0, 300).replace(/\n+/g, ' | '),
    errorMessage: document.querySelector('.error, .failed, [class*=error]')?.textContent?.slice(0, 120) ?? null,
  };
}).catch(() => ({ err: 'evaluate failed' }));

console.log('BEFORE CLICK:', JSON.stringify(await dump(), null, 1));

const fl = page.frameLocator('.mega-player iframe[src*="mega.nz/embed"]');
try {
  await fl.locator('.play-video-button').first().click({ timeout: 10000 });
  console.log('clicked play button');
} catch {
  // Fall back to clicking the video surface itself.
  try {
    await fl.locator('video, .media-viewer-container').first().click({ timeout: 8000 });
    console.log('clicked video surface');
  } catch (e2) {
    console.log('all clicks failed:', e2.message.split('\n')[0].slice(0, 90));
  }
}

for (let i = 0; i < 30; i++) {
  await page.waitForTimeout(2000);
  const s = await dump();
  if (i === 0 || i === 4 || i === 14) console.log(`\nAFTER CLICK +${(i + 1) * 2}s:`, JSON.stringify(s, null, 1));
  if (s.video && !s.video.paused && s.video.rs >= 2 && s.video.t > 0) { console.log(`\nPLAYING at +${(i + 1) * 2}s`); break; }
}

console.log('\n--- storage traffic ---');
for (const r of reqs.slice(0, 15)) console.log(r);
if (!reqs.length) console.log('(none — MEGA never requested media bytes)');
await browser.close();
