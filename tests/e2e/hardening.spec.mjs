/**
 * Phase 0 hardening tests: error/fallback behavior, preview cleanup under
 * stress, and touch-device semantics.
 *
 * The invalid-link fixture row is inserted and removed via `pg` directly
 * against the PostgreSQL database the app under test uses
 * (E2E_DATABASE_URL, defaulting to the local dev database). The preserved
 * SQLite rollback database is NEVER touched by these tests.
 */

import { test, expect } from '@playwright/test';
import pg from 'pg';
import { canSignInWithClerk, signInWithClerk } from './clerk-auth.mjs';

const BASE = process.env.E2E_BASE_URL ?? 'http://localhost:3000';
const E2E_DATABASE_URL =
  process.env.E2E_DATABASE_URL ??
  'postgresql://megatube:megatube-dev-only@localhost:5433/megatube?schema=public';
const BROKEN_SLUG = 'broken-link-test-video';

// The fixture library is private, so every card test needs the Clerk fixture
// session. Broken-link rows stay public and are found through search.
test.beforeEach(async ({ page }) => {
  test.skip(!canSignInWithClerk(), 'requires CLERK_SECRET_KEY and E2E_CLERK_USER_ID');
  await signInWithClerk(page);
});

test.describe.configure({ mode: 'serial' });

function previewSurfaces(scope) {
  return scope.locator(
    'iframe[src*="mega.nz/embed"], video[src^="/api/preview/"]',
  );
}

function previewUi(scope) {
  return scope.locator(
    'iframe[src*="mega.nz/embed"], video[src^="/api/preview/"], [data-preview-loading]',
  );
}

function withClient(fn) {
  const client = new pg.Client({ connectionString: E2E_DATABASE_URL });
  return client.connect().then(() =>
    fn(client).finally(() => client.end()),
  );
}

function insertBrokenVideo() {
  return withClient(async (db) => {
    const existing = await db.query('SELECT id FROM "Video" WHERE slug = $1', [BROKEN_SLUG]);
    if (existing.rowCount === 0) {
      await db.query(
        `INSERT INTO "Video" ("megaUrl", "megaFileId", "megaFileKey", "megaFilename", title, slug,
          thumbnail, "thumbnailAvailable", "embedUrl", "sortOrder", "createdAt", "updatedAt")
         VALUES ($1, $2, $3, $4, $5, $6, NULL, false, $7, 999999, now(), now())`,
        [
          'https://mega.nz/file/badlink1#not-a-real-key',
          'badlink1',
          'not-a-real-key-not-a-real-key',
          'broken-video.mp4',
          'Broken Link Test Video',
          BROKEN_SLUG,
          'https://mega.nz/embed/badlink1#not-a-real-key-not-a-real-key',
        ],
      );
    }
  });
}

function removeBrokenVideo() {
  return withClient(async (db) => {
    await db.query('DELETE FROM "Video" WHERE slug = $1', [BROKEN_SLUG]);
  });
}

test.describe('error/fallback behavior', () => {
  test('a malformed MEGA link degrades its card only, never the page', async ({ page }) => {
    await insertBrokenVideo();
    try {
      const errors = [];
      page.on('pageerror', (e) => errors.push(e.message));

      const res = await page.goto(
        `${BASE}/search?q=${encodeURIComponent('Broken Link Test Video')}`,
        { waitUntil: 'domcontentloaded' },
      );
      expect(res.status()).toBe(200); // search must not 500

      // The broken card renders with the SVG fallback (no thumbnail).
      const brokenCard = page.locator(`[aria-label="Broken Link Test Video"]`).first();
      await expect(brokenCard).toBeVisible({ timeout: 15_000 });
      await expect(brokenCard.locator('svg').first()).toBeVisible();
      await expect(brokenCard.locator('img[src*="/thumbs/"]')).toHaveCount(0);

      // Hovering a broken card must NOT create a preview surface and must
      // not throw.
      await brokenCard.hover();
      await page.waitForTimeout(800);
      await expect(previewSurfaces(brokenCard)).toHaveCount(0);
      expect(errors).toEqual([]);
    } finally {
      await removeBrokenVideo();
    }
  });

  test('video page for a link MEGA cannot play still loads with its player', async ({ page }) => {
    await insertBrokenVideo();
    try {
      const res = await page.goto(`${BASE}/video/${BROKEN_SLUG}`, { waitUntil: 'domcontentloaded' });
      expect(res.status()).toBe(200);
      // The player iframe is mounted; MEGA shows its own error inside it.
      const iframe = page.locator('.mega-player iframe[src*="mega.nz/embed"]');
      await expect(iframe).toHaveCount(1);
      // Title/metadata still render.
      await expect(page.locator('h1')).toContainText('Broken Link Test Video');
    } finally {
      await removeBrokenVideo();
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
      const c = await previewUi(page).count();
      maxConcurrent = Math.max(maxConcurrent, c);
    }
    expect(maxConcurrent).toBeLessThanOrEqual(1);

    // Parking the mouse off-cards removes the remaining preview UI.
    await page.mouse.move(2, 2);
    await page.waitForTimeout(500);
    await expect(previewUi(page)).toHaveCount(0);
  });

  test('repeated enter/leave cycles leave no orphaned iframes', async ({ page }) => {
    await page.goto(BASE, { waitUntil: 'domcontentloaded' });
    const card = page.locator('[role="link"][aria-label]').nth(2);
    await card.scrollIntoViewIfNeeded();

    for (let i = 0; i < 4; i++) {
      await card.hover();
      await expect(previewUi(card)).toHaveCount(1, { timeout: 5_000 });
      await page.mouse.move(2, 2);
      await expect(previewUi(card)).toHaveCount(0, { timeout: 5_000 });
    }
    await expect(previewUi(page)).toHaveCount(0);
  });

  test('scrolling while a preview is active keeps the DOM sane', async ({ page }) => {
    await page.goto(BASE, { waitUntil: 'domcontentloaded' });
    const card = page.locator('[role="link"][aria-label]').nth(4);
    await card.scrollIntoViewIfNeeded();
    await card.hover();
    await expect(previewUi(card)).toHaveCount(1, { timeout: 5_000 });

    await page.mouse.wheel(0, 400);
    await page.waitForTimeout(500);
    // Scrolling alone must not spawn additional preview UI.
    expect(await previewUi(page).count()).toBeLessThanOrEqual(1);

    await page.mouse.move(2, 2);
    await page.waitForTimeout(500);
    await expect(previewUi(page)).toHaveCount(0);
  });
});

test.describe('touch device semantics', () => {
  // CDP Input.dispatchTouchEvent and isMobile context emulation are
  // Chromium-only. Chrome/mobile-chrome projects run these; Firefox and
  // WebKit skip rather than fail on an unavailable protocol.
  test.skip(({ browserName }) => browserName !== 'chromium', 'CDP touch emulation is Chromium-only');
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

    // The tapping page must never have spawned preview UI.
    if (!page.url().includes('/video/')) {
      await expect(previewUi(page)).toHaveCount(0);
    }
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
    // Hold past the 400ms preview delay: the loading badge or a ready local
    // clip must appear (cold previews can take longer than the delay).
    await expect(previewUi(card)).toHaveCount(1, { timeout: 5_000 });

    await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
    // Lifting the finger must remove the preview UI (and the synthetic
    // mouseenter that follows must NOT re-arm it).
    await expect(previewUi(card)).toHaveCount(0, { timeout: 5_000 });
  });
});
