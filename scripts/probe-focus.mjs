/**
 * Phase 0 diagnostic #10: why doesn't click-to-play start?
 * Checks frame focus/visibility, MEGA console errors, and tries several
 * interaction strategies inside the cross-origin frame.
 */
import { chromium } from '@playwright/test';

const BASE = process.env.E2E_BASE_URL ?? 'http://localhost:3000';
const browser = await chromium.launch({ channel: 'chrome', headless: true });
const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });

const megaConsole = [];
page.on('console', (m) => {
  const loc = m.location()?.url ?? '';
  if (/mega/i.test(loc) || !loc.startsWith('http://localhost')) {
    megaConsole.push(`[${m.type()}] ${m.text().slice(0, 150)}`);
  }
});
page.on('pageerror', (e) => megaConsole.push(`[pageerror] ${e.message.slice(0, 150)}`));

await page.goto(`${BASE}/video/freya-reign-girlfriend-warms-you-up-for-your-date`, { waitUntil: 'domcontentloaded' });
await page.waitForSelector('.mega-player iframe[src*="mega.nz/embed"]', { timeout: 15000 });

let mf = null;
for (let i = 0; i < 45; i++) {
  mf = page.frames().find((f) => f.url().includes('mega.nz/embed'));
  if (mf && await mf.evaluate(() => !!document.querySelector('video')).catch(() => false)) break;
  await page.waitForTimeout(1000);
}
if (!mf) { console.log('no frame/video'); process.exit(1); }

const env = await mf.evaluate(() => ({
  hasFocus: document.hasFocus(),
  visibility: document.visibilityState,
  activeElement: document.activeElement?.tagName,
  bodyClasses: document.body.className.slice(0, 80),
})).catch((e) => ({ err: e.message }));
console.log('frame env:', JSON.stringify(env));

const read = () => mf.evaluate(() => {
  const v = document.querySelector('video');
  return v ? { rs: v.readyState, paused: v.paused, t: +v.currentTime.toFixed(2), w: v.videoWidth } : null;
}).catch(() => null);
console.log('before:', JSON.stringify(await read()));

// Strategy 1: coordinate click at the center of the iframe element.
const iframeEl = page.locator('.mega-player iframe[src*="mega.nz/embed"]');
const box = await iframeEl.boundingBox();
if (box) {
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.waitForTimeout(300);
  await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
  console.log('strategy 1: coordinate click at player center');
}
await page.waitForTimeout(3000);
console.log('after coord click:', JSON.stringify(await read()));

// Strategy 2: click, then keyboard space on focused player.
await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
await page.keyboard.press('Space');
console.log('strategy 2: click + space');
await page.waitForTimeout(3000);
console.log('after space:', JSON.stringify(await read()));

// Strategy 3: double click.
await page.mouse.dblclick(box.x + box.width / 2, box.y + box.height / 2);
console.log('strategy 3: double click');
await page.waitForTimeout(4000);
console.log('after dblclick:', JSON.stringify(await read()));

// Strategy 4: bottom control-bar play/pause button if present.
const btnInfo = await mf.evaluate(() => {
  const cands = [...document.querySelectorAll('[class*=playpause], [class*=play], .v2controls button, [role=button]')]
    .filter((e) => e.getBoundingClientRect().width > 0)
    .map((e) => ({ sel: `${e.tagName}.${String(e.className).slice(0, 40)}`, r: e.getBoundingClientRect().toJSON() }));
  return cands.slice(0, 8);
}).catch(() => []);
console.log('clickable candidates:', JSON.stringify(btnInfo));
for (const c of btnInfo) {
  await page.mouse.click(c.r.x + c.r.width / 2, c.r.y + c.r.height / 2);
  await page.waitForTimeout(2000);
  const s = await read();
  console.log(`clicked ${c.sel} -> ${JSON.stringify(s)}`);
  if (s && !s.paused && s.rs >= 2) break;
}

console.log('\n--- MEGA frame console (first 20) ---');
for (const m of megaConsole.slice(0, 20)) console.log(m);
await browser.close();
