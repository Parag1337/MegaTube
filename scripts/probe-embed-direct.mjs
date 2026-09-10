/**
 * Phase 0 diagnostic #7: open the MEGA embed URL DIRECTLY (no wrapper site).
 * If playback works here but not inside our app, the problem is our embedding;
 * if it also stalls, it's MEGA-side behavior.
 */
import { chromium } from '@playwright/test';

const EMBED = process.env.EMBED_URL ?? 'https://mega.nz/embed/GgBUzCBT#BC1m6DT4tVDPNmQ6fUSGkmT2t2U0xbrzT-eqLrQC4kk';
const browser = await chromium.launch({ channel: 'chrome', headless: true });
const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });

const reqs = [];
page.on('request', (r) => { if (/userstorage|gfs\d+/.test(r.url())) reqs.push(`REQ ${r.url().slice(0, 80)}`); });
page.on('response', (r) => { if (/userstorage|gfs\d+/.test(r.url())) reqs.push(`RES ${r.status()} len=${r.headers()['content-length'] ?? '?'} ${r.url().slice(0, 80)}`); });

await page.goto(EMBED, { waitUntil: 'domcontentloaded' });

// Wait for video element.
let has = false;
for (let i = 0; i < 45; i++) {
  has = await page.evaluate(() => !!document.querySelector('video')).catch(() => false);
  if (has) break;
  await page.waitForTimeout(1000);
}
console.log('video element present:', has);

const dump = () => page.evaluate(() => {
  const v = document.querySelector('video');
  const btn = document.querySelector('.play-video-button');
  return {
    video: v ? { rs: v.readyState, paused: v.paused, t: +v.currentTime.toFixed(2), w: v.videoWidth, muted: v.muted } : null,
    playBtn: btn ? { cls: btn.className, visible: btn.offsetParent !== null } : null,
    bodyText: (document.body.innerText ?? '').slice(0, 200).replace(/\n+/g, ' | '),
  };
}).catch((e) => ({ err: e.message.slice(0, 80) }));

console.log('initial:', JSON.stringify(await dump()));

// Trusted click on the play button / video area.
try {
  const btn = page.locator('.play-video-button').first();
  if (await btn.count()) await btn.click({ timeout: 8000, force: true });
  else await page.locator('video').first().click({ timeout: 8000, force: true });
  console.log('clicked');
} catch (e) {
  console.log('click failed:', e.message.split('\n')[0].slice(0, 90));
}

for (let i = 0; i < 30; i++) {
  await page.waitForTimeout(2000);
  const s = await dump();
  if (i % 5 === 0) console.log(`+${(i + 1) * 2}s:`, JSON.stringify(s));
  if (s.video && !s.video.paused && s.video.rs >= 2 && s.video.t > 0) { console.log(`PLAYING at +${(i + 1) * 2}s`); break; }
}

console.log('--- storage traffic (first 8) ---');
for (const r of reqs.slice(0, 8)) console.log(r);
if (!reqs.length) console.log('(none)');
await browser.close();
