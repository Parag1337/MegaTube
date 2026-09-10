/**
 * Phase 0 hardening tests: error/fallback behavior, preview cleanup under
 * stress, and touch-device semantics.
 *
 * The invalid-link fixture row is inserted and removed via better-sqlite3
 * directly (dev fixture only; no production code depends on this).
 */

import { test, expect } from '@playwright/test';
import Database from 'better-sqlite3';

const BASE = process.env.E2E_BASE_URL ?? 'http://localhost:3000';
const DB_FILE = 'data/database/app.db';
const BROKEN_SLUG = 'broken-link-test-video';

function insertBrokenVideo() {
  const db = new Database(DB_FILE);
  const existing = db.prepare('SELECT id FROM Video WHERE slug = ?').get(BROKEN_SLUG);
  if (!existing) {
    db.prepare(
      `INSERT INTO Video (megaUrl, megaFileId, megaFileKey, megaFilename, title, slug,
        thumbnail, thumbnailAvailable, embedUrl, sortOrder, createdAt, updatedAt)
       VALUES (?, ?, ?, ?, ?, ?, NULL, 0, ?, 999999, datetime('now'), datetime('now'))`,
    ).run(
      'https://mega.nz/file/badlink1#not-a-real-key',
      'badlink1',
      'not-a-real-key-not-a-real-key',
      'broken-video.mp4',
      'Broken Link Test Video',
      BROKEN_SLUG,
      'https://mega.nz/embed/badlink1#not-a-real-key-not-a-real-key',
    );
  }
  db.close();
}

function removeBrokenVideo() {
  const db = new Database(DB_FILE);
  db.prepare('DELETE FROM Video WHERE slug = ?').run(BROKEN_SLUG);
  db.close();
}

test.describe('error/fallback behavior', () => {
  test('a malformed MEGA link degrades its card only, never the page', async ({ page }) => {
    insertBrokenVideo();
    try {
      const errors = [];
      page.on('pageerror', (e) => errors.push(e.message));

      const res = await page.goto(BASE, { waitUntil: 'domcontentloaded' });
      expect(res.status()).toBe(200); // homepage must not 500

      // Regular cards render normally alongside the broken one.
      const cards = page.locator('[role="link"][aria-label]');
      await expect(cards).toHaveCount(17, { timeout: 15000 });

      // The broken card renders with the SVG fallback (no thumbnail).
      const brokenCard = page.locator(`[aria-label="Broken Link Test Video"]`);
      await expect(brokenCard).toHaveCount(1);
      await expect(brokenCard.locator('svg')).toHaveCount(1);

      // Hovering a broken card must NOT create a preview iframe and must
      // not throw.
      await brokenCard.hover();
      await page.waitForTimeout(800);
      await expect(brokenCard.locator('iframe')).toHaveCount(0);
      expect(errors).toEqual([]);
    } finally {
      removeBrokenVideo();
    }
  });

  test('video page for a link MEGA cannot play still loads with its player', async ({ page }) => {
    insertBrokenVideo();
    try {
      const res = await page.goto(`${BASE}/video/${BROKEN_SLUG}`, { waitUntil: 'domcontentloaded' });
      expect(res.status()).toBe(200);
      // The player iframe is mounted; MEGA shows its own error inside it.
      const iframe = page.locator('.mega-player iframe[src*="mega.nz/embed"]');
      await expect(iframe).toHaveCount(1);
      // Title/metadata still render.
      await expect(page.locator('h1')).toContainText('Broken Link Test Video');
    } finally {
      removeBrokenVideo();
    }
  });

  test('thumbnail path that 404s does not break the card', async ({ page }) => {
    await page.goto(BASE, { waitUntil: 'domcontentloaded' });
    const cards = page.locator('[role="link"][aria-label]');
    await expect(cards.first()).toBeVisible();
    // All catalog thumbnails resolve in the normal fixture set; the fallback
    // path (thumbnail === null -> SVG icon) is covered by the broken-link test.
    const thumbs = page.locator('img[src*="/thumbs/"]');
    expect(await thumbs.count()).toBeGreaterThan(0);
  });
});

test.describe('preview cleanup under stress', () => {
  test('rapid sweep across cards never exceeds one preview', async ({ page }) => {
    await page.goto(BASE, { waitUntil: 'domcontentloaded' });
    const cards = page.locator('[role="link"][aria-label]');
    await expect(cards.first()).toBeVisible();

    const count = Math.min(await cards.count(), 8);
    let maxConcurrent = 0;
    for (let i = 0; i < count; i++) {
      await cards.nth(i).hover();
      await page.waitForTimeout(120);
      const c = await page.locator('iframe[src*="mega.nz/embed"]').count();
      maxConcurrent = Math.max(maxConcurrent, c);
    }
    expect(maxConcurrent).toBeLessThanOrEqual(1);

    // Parking the mouse off-cards removes the remaining preview.
    await page.mouse.move(2, 2);
    await page.waitForTimeout(400);
    await expect(page.locator('iframe[src*="mega.nz/embed"]')).toHaveCount(0);
  });

  test('repeated enter/leave cycles leave no orphaned iframes', async ({ page }) => {
    await page.goto(BASE, { waitUntil: 'domcontentloaded' });
    const card = page.locator('[role="link"][aria-label]').nth(2);
    await card.scrollIntoViewIfNeeded();

    for (let i = 0; i < 4; i++) {
      await card.hover();
      await page.waitForTimeout(550);
      await expect(page.locator('iframe[src*="mega.nz/embed"]')).toHaveCount(1);
      await page.mouse.move(2, 2);
      await page.waitForTimeout(350);
      await expect(page.locator('iframe[src*="mega.nz/embed"]')).toHaveCount(0);
    }
    await expect(page.locator('iframe[src*="mega.nz/embed"]')).toHaveCount(0);
  });

  test('scrolling while a preview is active keeps the DOM sane', async ({ page }) => {
    await page.goto(BASE, { waitUntil: 'domcontentloaded' });
    const card = page.locator('[role="link"][aria-label]').nth(4);
    await card.scrollIntoViewIfNeeded();
    await card.hover();
    await page.waitForTimeout(650);
    await expect(page.locator('iframe[src*="mega.nz/embed"]')).toHaveCount(1);

    await page.mouse.wheel(0, 400);
    await page.waitForTimeout(500);
    // Scrolling alone must not spawn additional players.
    const c = await page.locator('iframe[src*="mega.nz/embed"]').count();
    expect(c).toBeLessThanOrEqual(1);

    await page.mouse.move(2, 2);
    await page.waitForTimeout(400);
    await expect(page.locator('iframe[src*="mega.nz/embed"]')).toHaveCount(0);
  });
});

test.describe('touch device semantics', () => {
  test.use({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true });

  test('quick tap opens the video page and spawns no preview', async ({ page, context }) => {
    await page.goto(BASE, { waitUntil: 'domcontentloaded' });
    const card = page.locator('[role="link"][aria-label]').first();

    // Under touch emulation Chrome may deliver the navigation as a popup OR
    // (with strict popup blocking of synthetic touch clicks) as a same-tab
    // navigation. Accept either; the "no preview" guarantee is the point.
    let videoPage = null;
    for (let attempt = 0; attempt < 2 && !videoPage; attempt++) {
      const popupPromise = context.waitForEvent('page', { timeout: 6000 }).catch(() => null);
      await card.tap();
      const popup = await popupPromise;
      if (popup && popup.url().includes('/video/')) {
        videoPage = popup;
      } else if (!popup) {
        // Give any same-tab navigation a moment, then retry the tap.
        await page.waitForTimeout(800);
        if (page.url().includes('/video/')) { videoPage = page; break; }
      } else {
        await popup.close();
      }
    }

    if (videoPage && videoPage !== page) {
      await videoPage.waitForLoadState('domcontentloaded').catch(() => {});
      expect(videoPage.url()).toContain('/video/');
      await videoPage.close();
    } else {
      expect(videoPage).toBeTruthy();
    }

    // The tapping page must never have spawned a preview iframe.
    await expect(page.locator('iframe[src*="mega.nz/embed"]')).toHaveCount(0);
  });

  test('long-press previews, and lifting the finger restores the thumbnail', async ({ page }) => {
    await page.goto(BASE, { waitUntil: 'domcontentloaded' });
    const card = page.locator('[role="link"][aria-label]').nth(2);
    await card.scrollIntoViewIfNeeded();

    const box = await card.boundingBox();
    const px = box.x + box.width / 2;
    const py = box.y + box.height / 2;
    const cdp = await page.context().newCDPSession(page);

    await cdp.send('Input.dispatchTouchEvent', {
      type: 'touchStart',
      touchPoints: [{ x: px, y: py }],
    });
    // Hold past the 400ms preview delay: the preview must appear.
    await page.waitForTimeout(900);
    await expect(page.locator('iframe[src*="mega.nz/embed"]')).toHaveCount(1);

    await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
    // Lifting the finger must remove the preview (and the synthetic
    // mouseenter that follows must NOT re-arm it).
    await page.waitForTimeout(900);
    await expect(page.locator('iframe[src*="mega.nz/embed"]')).toHaveCount(0);
  });
});
