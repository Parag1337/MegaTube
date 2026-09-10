/**
 * Phase 0 diagnostic #9: isolate click-to-play vs autoplay+muted embeds.
 * Fresh page each time, different file, detailed storage traffic.
 */
import { chromium } from '@playwright/test';

const AUTO_EMBED = 'https://mega.nz/embed/20oTQTBS#Es81h54-mAexuTyLFjq63tXmm6Nn99dmjkSGEgaxdFk!1a1m';
const CLICK_EMBED = 'https://mega.nz/embed/20oTQTBS#Es81h54-mAexuTyLFjq63tXmm6Nn99dmjkSGEgaxdFk';

const browser = await chromium.launch({ channel: 'chrome', headless: true });

async function runCase(name, url, { click }) {
  const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
  const traffic = [];
  page.on('request', (r) => { if (/userstorage|gfs\d+/.test(r.url())) traffic.push(`REQ ${new URL(r.url()).host} ${new URL(r.url()).pathname.slice(0, 12)}`); });
  page.on('response', (r) => {
    if (/userstorage|gfs\d+/.test(r.url())) {
      const h = r.headers();
      traffic.push(`RES ${r.status()} len=${h['content-length'] ?? '?'} ${new URL(r.url()).pathname.slice(0, 12)}`);
    }
  });

  await page.goto(url, { waitUntil: 'domcontentloaded' });
  let has = false;
  for (let i = 0; i < 40 && !has; i++) {
    has = await page.evaluate(() => !!document.querySelector('video')).catch(() => false);
    if (!has) await page.waitForTimeout(1000);
  }
  if (!has) { console.log(`${name}: NO VIDEO ELEMENT`); await page.close(); return; }

  if (click) {
    try {
      await page.locator('.play-video-button').first().click({ timeout: 8000, force: true });
    } catch { await page.locator('video').first().click({ timeout: 5000, force: true }).catch(() => {}); }
  }

  const read = () => page.evaluate(() => {
    const v = document.querySelector('video');
    return v ? { rs: v.readyState, paused: v.paused, t: +v.currentTime.toFixed(2), w: v.videoWidth } : null;
  }).catch(() => null);

  let s = await read();
  for (let i = 0; i < 25 && (!s || s.rs < 2); i++) { await page.waitForTimeout(1000); s = await read(); }
  const t1 = s?.t ?? 0;
  await page.waitForTimeout(3000);
  const s2 = await read();
  const playing = s2 && !s2.paused && s2.rs >= 2 && s2.t > t1;
  console.log(`${name}: ${JSON.stringify(s2)} traffic=${traffic.length} -> ${playing ? 'PLAYS' : 'STALLED'}`);
  if (!playing) for (const t of traffic.slice(0, 6)) console.log('   ', t);
  await page.close();
}

await runCase('A) direct embed !1a1m (autoplay+muted)', AUTO_EMBED, { click: false });
await runCase('B) direct embed no-flags + click', CLICK_EMBED, { click: true });
await browser.close();
