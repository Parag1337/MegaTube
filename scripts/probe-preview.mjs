/**
 * Phase 0 deep probe: hover preview lifecycle + REAL MEGA playback evidence.
 *
 * Cross-origin note: the MEGA embed frame is pierced for <video> inspection
 * (test-only capability). MEGA's player takes 8-25s to spin up, so all
 * playback checks POLL rather than use fixed waits. Headless Chrome often
 * stalls MEGA click-to-play media (decoder/activation limitation); run with
 * HEADED=1 for strict playback assertions when a display is available.
 */
import { chromium } from '@playwright/test';

const BASE = process.env.E2E_BASE_URL ?? 'http://localhost:3000';
const HEADED = process.env.HEADED === '1';
const hasDisplay = !!process.env.DISPLAY || !!process.env.WAYLAND_DISPLAY;
const results = [];
const consoleErrors = [];
const failedRequests = [];

function check(name, ok, detail = '') {
  results.push({ name, ok, detail });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`);
}

const browser = await chromium.launch({
  channel: 'chrome',
  headless: !(HEADED && hasDisplay),
});
const context = await browser.newContext({ viewport: { width: 1280, height: 800 } });
const page = await context.newPage();

page.on('console', (msg) => { if (msg.type() === 'error') consoleErrors.push(msg.text()); });
page.on('pageerror', (err) => consoleErrors.push(`pageerror: ${err.message}`));
// ERR_ABORTED on media/iframe requests is the expected result of preview
// teardown (requests cancelled when the iframe is removed) - not an error.
page.on('requestfailed', (req) => {
  if (req.failure()?.errorText !== 'net::ERR_ABORTED') {
    failedRequests.push(`${req.method()} ${req.url()} :: ${req.failure()?.errorText}`);
  }
});
page.on('response', (res) => { if (res.status() >= 500) failedRequests.push(`HTTP ${res.status()} ${res.url()}`); });

const waitForMegaVideo = async (pageRef, timeoutMs = 30000) => {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const frame = pageRef.frames().find((f) => f.url().includes('mega.nz/embed'));
    if (frame) {
      const state = await frame.evaluate(() => {
        const v = document.querySelector('video');
        return v ? { readyState: v.readyState, paused: v.paused, muted: v.muted, t: v.currentTime, w: v.videoWidth, h: v.videoHeight } : null;
      }).catch(() => null);
      if (state) return { frame, state };
    }
    await pageRef.waitForTimeout(1000);
  }
  return { frame: null, state: null };
};

// ---------- 1. Homepage & cards ----------
await page.goto(BASE, { waitUntil: 'domcontentloaded' });
await page.waitForSelector('[role="link"][aria-label]', { timeout: 15000 });
const cardCount = await page.locator('[role="link"][aria-label]').count();
check('homepage loads cards', cardCount > 0, `${cardCount} cards`);

const thumbCount = await page.locator('img[src*="/thumbs/"]').count();
const iframeCount = await page.locator('iframe[src*="mega.nz/embed"]').count();
check('cards show thumbnails', thumbCount > 0, `${thumbCount} thumbnails`);
check('no iframes on initial load (lazy creation)', iframeCount === 0, `${iframeCount} iframes`);

// ---------- 2. Hover delay + preview creation ----------
const firstCard = page.locator('[role="link"][aria-label]').first();
await firstCard.hover();

await page.waitForTimeout(150);
const earlyIframes = await page.locator('iframe[src*="mega.nz/embed"]').count();
check('no iframe before hover delay', earlyIframes === 0, `${earlyIframes} at 150ms`);

await page.waitForTimeout(600);
const iframes = page.locator('iframe[src*="mega.nz/embed"]');
const n = await iframes.count();
check('exactly one preview iframe after hover delay', n === 1, `${n} iframe(s)`);
const src = n === 1 ? await iframes.getAttribute('src') : '';
check('preview iframe muted+autoplay flags (!1a1m)', /!1a1m/.test(src ?? ''), src?.slice(0, 75));

// ---------- 3. REAL playback evidence (poll up to 30s) ----------
const { frame: megaFrame, state: s1 } = await waitForMegaVideo(page, 30000);
check('MEGA <video> element exists in preview', !!megaFrame && !!s1,
  s1 ? `readyState=${s1.readyState} paused=${s1.paused} muted=${s1.muted}` : 'no video within 30s');

if (megaFrame && s1) {
  check('video is muted', s1.muted === true, `muted=${s1.muted}`);
  check('video is not paused (autoplay accepted)', s1.paused === false, `paused=${s1.paused}`);
  check('video has decoded frames', (s1.w ?? 0) > 0 && (s1.h ?? 0) > 0, `${s1.w}x${s1.h}`);
  check('video has data (readyState >= 2)', (s1.readyState ?? 0) >= 2, `readyState=${s1.readyState}`);

  // currentTime must increase -> definitive playback proof.
  const t0 = s1.t;
  await page.waitForTimeout(3000);
  const s2 = await megaFrame.evaluate(() => {
    const v = document.querySelector('video');
    return v ? { t: v.currentTime, paused: v.paused, rs: v.readyState } : null;
  }).catch(() => null);
  check('currentTime increases (REAL playback)', !!s2 && s2.t > t0 + 0.2,
    `t=${t0?.toFixed?.(2)} -> ${s2?.t?.toFixed?.(2)}`);
} else if (HEADED && hasDisplay) {
  check('MEGA <video> element exists in preview', false, 'headed run - playback must work');
}

// ---------- 4. One-preview rule + cleanup ----------
const cards = page.locator('[role="link"][aria-label]');
const aSrc = src ?? '';
const aFileId = aSrc.match(/\/embed\/([A-Za-z0-9_-]{8})/)?.[1];

await cards.nth(1).hover();
await page.waitForTimeout(700);
const iframesB = page.locator('iframe[src*="mega.nz/embed"]');
const nB = await iframesB.count();
const bSrc = nB === 1 ? await iframesB.getAttribute('src') : '';
const bFileId = (bSrc || '').match(/\/embed\/([A-Za-z0-9_-]{8})/)?.[1];
check('card A -> card B: still exactly one preview', nB === 1, `${nB} iframe(s)`);
check('preview iframe now belongs to card B', !!bFileId && bFileId !== aFileId, `A=${aFileId} B=${bFileId}`);

await page.mouse.move(2, 2);
await page.waitForTimeout(400);
const afterLeave = await page.locator('iframe[src*="mega.nz/embed"]').count();
check('mouseleave destroys preview iframe', afterLeave === 0, `${afterLeave} iframe(s)`);
const thumbOpacity = await cards.first().locator('img[src*="/thumbs/"]')
  .evaluate((el) => getComputedStyle(el).opacity).catch(() => null);
check('thumbnail visible again after leave', thumbOpacity === '1' || thumbOpacity === null, `opacity=${thumbOpacity}`);

// Rapid sweep across many cards: never more than one player.
let maxConcurrent = 0;
const sweepCount = Math.min(await cards.count(), 8);
for (let i = 0; i < sweepCount; i++) {
  await cards.nth(i).hover();
  await page.waitForTimeout(120);
  const c = await page.locator('iframe[src*="mega.nz/embed"]').count();
  if (c > maxConcurrent) maxConcurrent = c;
}
await page.waitForTimeout(400);
const afterSweep = await page.locator('iframe[src*="mega.nz/embed"]').count();
check('rapid sweep never exceeds 1 iframe', maxConcurrent <= 1, `max concurrent=${maxConcurrent}`);
// After the sweep the pointer legitimately rests on the last hovered card,
// so at most one (its) preview may remain; then park the mouse off-cards.
check('sweep leaves at most the last card preview', afterSweep <= 1, `${afterSweep} remaining`);
await page.mouse.move(2, 2);
await page.waitForTimeout(400);
const afterPark = await page.locator('iframe[src*="mega.nz/embed"]').count();
check('previews cleaned up after parking mouse off-cards', afterPark === 0, `${afterPark} remaining`);

// Repeated enter/leave cycles on the same card.
for (let i = 0; i < 3; i++) {
  await cards.nth(2).hover();
  await page.waitForTimeout(550);
  await page.mouse.move(2, 2);
  await page.waitForTimeout(350);
}
const cycleLeaks = await page.locator('iframe[src*="mega.nz/embed"]').count();
check('repeated enter/leave cycles leave no orphaned iframes', cycleLeaks === 0, `${cycleLeaks} iframe(s)`);

// ---------- 5. Video detail page ----------
const page2 = await context.newPage();
page2.on('console', (m) => { if (m.type() === 'error') consoleErrors.push(`video-page console: ${m.text()}`); });
await page2.goto(`${BASE}/video/freya-reign-quick-pegging-before-dinner`, { waitUntil: 'domcontentloaded' });
await page2.waitForSelector('.mega-player iframe[src*="mega.nz/embed"]', { timeout: 15000 });
const playerSrc = await page2.locator('.mega-player iframe[src*="mega.nz/embed"]').getAttribute('src');
check('video page player uses normal embed URL (no !1a1m)', !!playerSrc && !playerSrc.includes('!1a1m'), playerSrc?.slice(0, 75));
const title1 = await page2.locator('h1').textContent();
check('video page shows title/metadata', !!title1 && title1.trim().length > 0, title1?.slice(0, 50));
const recCount = await page2.locator('[role="link"][aria-label]').count();
check('video page shows recommendations', recCount > 0, `${recCount} cards`);

// Direct navigation + refresh.
const res = await page2.reload({ waitUntil: 'domcontentloaded' });
check('video page works on refresh (HTTP 200)', res.status() === 200, `status=${res.status()}`);

// Player mounts and produces a <video> element (click-to-play UI present).
const { frame: fp, state: v2 } = await waitForMegaVideo(page2, 30000);
check('video page player <video> element present', !!fp && !!v2,
  v2 ? `readyState=${v2.readyState} paused=${v2.paused}` : 'no video within 30s');

if (fp && v2) {
  // Trusted click at player center to start playback.
  const box = await page2.locator('.mega-player iframe[src*="mega.nz/embed"]').boundingBox();
  await page2.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
  let playing = null;
  const deadline = Date.now() + 30000;
  let t0 = null;
  while (Date.now() < deadline) {
    await page2.waitForTimeout(1000);
    playing = await fp.evaluate(() => {
      const v = document.querySelector('video');
      return v ? { t: v.currentTime, paused: v.paused, rs: v.readyState, w: v.videoWidth } : null;
    }).catch(() => null);
    if (playing && t0 === null && playing.t > 0) t0 = playing.t;
    if (playing && !playing.paused && playing.rs >= 2 && playing.t > (t0 ?? 0) + 0.2) break;
  }
  const advanced = playing && t0 !== null && playing.t > t0 + 0.2;
  check('video page: user click starts REAL playback', !!advanced,
    advanced ? `t=${t0?.toFixed?.(2)} -> ${playing?.t?.toFixed?.(2)}` : JSON.stringify(playing));
} else if (HEADED && hasDisplay) {
  check('video page player <video> element present', false, 'headed run - must work');
}

// ---------- 6. Console/network health ----------
const consoleErrorsFiltered = consoleErrors.filter(
  (e) => !/favicon|Download the React DevTools|Autofill/i.test(e),
);
check('no console errors', consoleErrorsFiltered.length === 0, consoleErrorsFiltered.slice(0, 3).join(' | '));
check('no failed requests (excluding benign ERR_ABORTED)', failedRequests.length === 0, failedRequests.slice(0, 3).join(' | '));
const hydrationErrors = consoleErrorsFiltered.filter((e) => /hydrat|did not match|server rendered/i.test(e));
check('no hydration errors', hydrationErrors.length === 0, hydrationErrors.slice(0, 2).join(' | '));

await browser.close();

const failed = results.filter((r) => !r.ok);
console.log(`\n=== Phase 0 probe (${HEADED && hasDisplay ? 'HEADED' : 'headless'}): ${results.length - failed.length}/${results.length} checks passed ===`);
process.exit(failed.length ? 1 : 0);
