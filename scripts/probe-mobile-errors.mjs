/**
 * Phase 0 diagnostic #13 (v2): touch behavior with event instrumentation +
 * invalid-link fallback via better-sqlite3 directly.
 */
import { chromium } from '@playwright/test';
import Database from 'better-sqlite3';

const BASE = process.env.E2E_BASE_URL ?? 'http://localhost:3000';
const dbFile = './data/database/app.db';
const browser = await chromium.launch({ channel: 'chrome', headless: true });

// ---------- Part 1: touch device behavior ----------
console.log('=== Part 1: touch device behavior ===');
const ctx = await browser.newContext({
  viewport: { width: 390, height: 844 },
  hasTouch: true,
  isMobile: true,
});
const page = await ctx.newPage();
await page.goto(BASE, { waitUntil: 'domcontentloaded' });
await page.waitForSelector('[role="link"][aria-label]');

// Quick tap: opens the video page in a new tab.
const card = page.locator('[role="link"][aria-label]').first();
const popupPromise = ctx.waitForEvent('page', { timeout: 8000 }).catch(() => null);
await card.tap();
const popup = await popupPromise;
console.log('quick tap opens video page:', popup ? `YES (${popup.url().slice(0, 60)})` : 'NO');
if (popup) await popup.close();

// Long-press with event instrumentation on the pressed card.
const pressCard = page.locator('[role="link"][aria-label]').nth(2);
await pressCard.scrollIntoViewIfNeeded();
await pressCard.evaluate((el) => {
  window.__evts = [];
  for (const ev of ['pointerdown', 'pointerup', 'pointercancel', 'touchstart', 'touchend', 'touchcancel', 'touchmove', 'contextmenu', 'click']) {
    el.addEventListener(ev, (e) => window.__evts.push(`${ev}(${e.pointerType ?? 'touch'})`));
  }
});
const c2 = await pressCard.boundingBox();
const px = c2.x + c2.width / 2;
const py = c2.y + c2.height / 2;
const cdp = await ctx.newCDPSession(page);
await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x: px, y: py }] });
await page.waitForTimeout(900); // hold past the 400ms preview delay
const during = await page.locator('iframe[src*="mega.nz/embed"]').count();
await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
await page.waitForTimeout(800);
const afterUp = await page.locator('iframe[src*="mega.nz/embed"]').count();
const evts = await pressCard.evaluate(() => window.__evts ?? []);
console.log(`long-press: iframes during hold=${during}, after release=${afterUp}`);
console.log('card events:', evts.join(', ') || '(none captured)');
console.log(afterUp === 0 ? 'PASS preview removed after finger lift' : 'FAIL preview iframe survived finger lift');
await ctx.close();

// ---------- Part 2: invalid link fallback ----------
console.log('\n=== Part 2: invalid link fallback ===');
const db = new Database(dbFile);
const exists = db.prepare('SELECT id FROM Video WHERE slug = ?').get('broken-link-test-video');
if (!exists) {
  db.prepare(`INSERT INTO Video (megaUrl, megaFileId, megaFileKey, megaFilename, title, slug, thumbnail, thumbnailAvailable, embedUrl, sortOrder, createdAt, updatedAt)
              VALUES (?, ?, ?, ?, ?, ?, NULL, 0, ?, 999999, datetime('now'), datetime('now'))`)
    .run('https://mega.nz/file/badlink1#not-a-real-key', 'badlink1', 'not-a-real-key-not-a-real-key', 'broken-video.mp4', 'Broken Link Test Video', 'broken-link-test-video', 'https://mega.nz/embed/badlink1#not-a-real-key-not-a-real-key');
  console.log('inserted broken-link fixture row');
} else {
  console.log('broken-link fixture row already exists');
}
db.close();

const ctx2 = await browser.newContext({ viewport: { width: 1280, height: 800 } });
const p2 = await ctx2.newPage();
const errors = [];
p2.on('pageerror', (e) => errors.push(e.message.slice(0, 120)));
await p2.goto(BASE, { waitUntil: 'domcontentloaded' });
await p2.waitForSelector('[role="link"][aria-label]');
const brokenCard = p2.locator('[aria-label="Broken Link Test Video"]');
const visible = await brokenCard.count();
console.log('broken card rendered on homepage:', visible > 0 ? 'YES' : 'NO');
if (visible) {
  const svgFallback = await brokenCard.locator('svg').count();
  console.log('fallback icon shown (no thumbnail):', svgFallback > 0 ? 'YES' : 'NO');
  await brokenCard.hover();
  await p2.waitForTimeout(700);
  const iframe = await brokenCard.locator('iframe').count();
  console.log('preview iframe created for broken link:', iframe === 1 ? 'YES' : 'NO');
  await p2.waitForTimeout(2500);
  console.log('page errors during broken preview:', errors.length === 0 ? 'NONE' : errors.slice(0, 3).join(' | '));
}
const res = await p2.goto(`${BASE}/video/broken-link-test-video`, { waitUntil: 'domcontentloaded' });
console.log('broken video page HTTP status:', res.status());
await p2.waitForTimeout(1500);
const player = await p2.locator('.mega-player iframe').count();
console.log('video page player iframe present:', player > 0 ? 'YES' : 'NO');
console.log('page errors on broken video page:', errors.length === 0 ? 'NONE' : errors.slice(0, 3).join(' | '));

// Thumbnail 404 fallback: card with thumbnail path that doesn't exist.
const p3 = await ctx2.newPage();
p3.on('pageerror', (e) => errors.push(`thumb404: ${e.message.slice(0, 120)}`));
await p3.goto(`${BASE}/video/broken-link-test-video`, { waitUntil: 'domcontentloaded' });
// (thumbnail is null for this card -> covered by svg fallback above)

// Clean up the fixture row.
const db2 = new Database(dbFile);
db2.prepare('DELETE FROM Video WHERE slug = ?').run('broken-link-test-video');
db2.close();
console.log('fixture row cleaned up');
await browser.close();
